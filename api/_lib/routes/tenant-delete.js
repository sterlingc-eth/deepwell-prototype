import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { deleteTenantData, recordTenantDeletion } from "../opsStore.js";
import { withTenant, getPool, bustTenantCache } from "../recordsStore.js";
import { getStripe, cancelTenantSubscriptions } from "../billing.js";
import { deleteObject } from "../r2.js";
import { captureException } from "../telemetry.js";

/**
 * POST /api/tenant-delete
 * body: { confirm: "<your tenant id>" }
 *
 * The deletion half of the promise the marketing page already makes and this
 * codebase never built. This is the one irreversible endpoint in the API —
 * no client-side confirmation dialog can be trusted here, since the whole
 * point is that the SERVER refuses to run unless the caller can name their
 * own tenant back to it. `confirm` must equal `auth.tenantId` EXACTLY
 * (auth.tenantId comes from the verified Clerk token, never the request body
 * — see auth.js — so there's no way to pass someone else's tenant id here and
 * have it accepted).
 *
 * ADMIN-GATED: inside a shop only the admin role may delete (requireRole below), same as tenant-export.js.
 * (Comment was stale — the guard has been in place since the keys.js pattern landed.)
 *
 * BILLING: a customer who deletes their data must not be billed again, so step 0 cancels the tenant's Stripe
 * subscription(s) IMMEDIATELY (api/_lib/billing.js cancelTenantSubscriptions — the recorded subscription plus
 * any live one Stripe lists for the customer; "already canceled" counts as done; no Stripe customer/subscription
 * or no Stripe configured -> skipped). If Stripe genuinely fails, NOTHING is deleted and the caller gets a 502
 * to retry: deleting the data while the card keeps being charged is the one outcome to rule out. After the
 * wipe, one `tenant.deleted` audit_log row records what happened (counts and Stripe subscription ids — no
 * content), since the tenant's earlier audit rows are gone with everything else.
 *
 * Order of operations, and why: (0) cancel billing; (1) delete every Postgres row for the tenant,
 * in FK-safe order, inside one transaction — see opsStore.deleteTenantData
 * and its DELETE_ORDER; (2) only once that has COMMITTED, delete the R2
 * objects those documents pointed at; (3) write the one row that survives —
 * tenant_deletions — recording what happened. Postgres and R2 are two
 * different systems with no shared transaction, so the safe order is
 * "commit the source of truth first, then clean up the copy" — a crash
 * between steps 1 and 2 leaves orphaned R2 objects (cheap, and cleanable
 * later) rather than a half-deleted tenant with SOME rows gone and the
 * objects they pointed at still referenced from nowhere.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "16kb" } },
  maxDuration: 60,
};

/** Pure, exported for scripts/verify-ops.mjs. */
export function isValidConfirm(confirm, tenantId) {
  return typeof confirm === "string" && typeof tenantId === "string" && confirm.length > 0 && confirm === tenantId;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
    // A shop's data is the owner's to export, wipe or hand out keys for —
    // not any technician's. Solo tenants have no roles and are their own admin.
    if (hasShop(auth)) requireRole(auth, "admin");
  } catch (err) {
    return denyAuth(res, err);
  }

  const { confirm } = req.body ?? {};
  if (!isValidConfirm(confirm, auth.tenantId)) {
    return handleCors(res, req).status(400).json({
      error: 'Confirmation does not match. Pass { "confirm": "<your tenant id>" } to proceed.',
    });
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    // 0) Stop the billing first (see the header). Read the ids before the wipe; the tenants row survives it.
    const billing = { subscriptionsCanceled: 0, skipped: null };
    const tenantRow = await withTenant(ctx, async (store) => {
      const { rows } = await store.raw(
        `SELECT id, stripe_customer_id, stripe_subscription_id FROM tenants WHERE id = $1`,
        [store.tenantId]
      );
      return rows[0] ?? null;
    });
    let canceledIds = [];
    if (tenantRow?.stripe_customer_id || tenantRow?.stripe_subscription_id) {
      let stripe = null;
      try {
        stripe = getStripe();
      } catch (err) {
        if (err?.name !== "ConfigError") throw err;
        billing.skipped = "stripe-not-configured";
      }
      if (stripe) {
        const outcome = await cancelTenantSubscriptions(stripe, {
          customerId: tenantRow.stripe_customer_id,
          subscriptionId: tenantRow.stripe_subscription_id,
        });
        if (outcome.failed.length) {
          await captureException(new Error(`tenant-delete: Stripe cancel failed: ${outcome.failed.map((f) => f.message).join("; ")}`), {
            route: "/api/tenant-delete",
            tenantId: auth.tenantId,
          });
          return handleCors(res, req).status(502).json({
            error:
              "We could not cancel your subscription with our payment provider, so nothing was deleted and you have not been charged anything new. Please try again in a minute.",
            code: "billing_cancel_failed",
          });
        }
        canceledIds = outcome.canceled;
        billing.subscriptionsCanceled = outcome.canceled.length;
        billing.skipped = outcome.skipped;
        if (outcome.canceled.length) {
          // The subscription.deleted webhook will say the same; apply it now so the gate is consistent immediately.
          await getPool()
            .query("SELECT billing_apply($1, $2::jsonb)", [tenantRow.id, JSON.stringify({ billing_status: "canceled", cancel_at_period_end: true })])
            .catch((err) => console.error("tenant-delete: could not mark billing canceled:", err?.message));
          bustTenantCache(tenantRow.id);
        }
      }
    } else {
      billing.skipped = "no-subscription";
    }

    const { storageKeys, counts, tenantId } = await deleteTenantData(ctx);
    bustTenantCache(tenantId);

    const failedObjects = [];
    for (const key of storageKeys) {
      try {
        await deleteObject(key);
      } catch (err) {
        failedObjects.push(key);
        await captureException(err, { route: "/api/tenant-delete", tenantId: auth.tenantId });
      }
    }

    const documentsDeleted = counts.documents ?? 0;

    // audit_log for this tenant was just deleted (it's in DELETE_ORDER), so
    // the confirmation of the deletion cannot live there — see
    // M3-config/09-ops.sql for why tenant_deletions exists. Best-effort: the
    // deletion itself already happened and must be reported as having
    // happened even if this receipt fails to write.
    await recordTenantDeletion(ctx, {
      documents: documentsDeleted,
      objects: storageKeys.length,
      failedObjects,
    }).catch((err) => console.error("Failed to write tenant_deletions row:", err?.message));

    // The one audit row that exists after the wipe (the tenant's earlier ones were just deleted). Counts and
    // Stripe subscription ids only. Best-effort, same as the receipt above.
    await withTenant(ctx, (db) =>
      db.logAction({
        action: "tenant.deleted",
        resource_type: "tenant",
        clerk_user_id: auth.userId,
        changes: {
          documents: documentsDeleted,
          objects: storageKeys.length,
          objectsFailed: failedObjects.length,
          stripeSubscriptionsCanceled: canceledIds,
          stripeSkipped: billing.skipped,
        },
      })
    ).catch((err) => console.error("Failed to write tenant.deleted audit row:", err?.message));

    return handleCors(res, req).status(200).json({
      deleted: true,
      documents: documentsDeleted,
      objectsRemoved: storageKeys.length - failedObjects.length,
      objectsFailed: failedObjects.length,
      billing,
    });
  } catch (error) {
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
