import { requireAuth, denyAuth, hasShop, requireRole } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { deleteTenantData, recordTenantDeletion } from "../opsStore.js";
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
 * Order of operations, and why: (1) delete every Postgres row for the tenant,
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
    const { storageKeys, counts } = await deleteTenantData(ctx);

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

    return handleCors(res, req).status(200).json({
      deleted: true,
      documents: documentsDeleted,
      objectsRemoved: storageKeys.length - failedObjects.length,
      objectsFailed: failedObjects.length,
    });
  } catch (error) {
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
