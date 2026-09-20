import { requireAuth, denyAuth, hasShop, requireRole } from "./_lib/auth.js";
import { handleCors, handleError } from "./_lib/claude.js";
import { withTenant, getPool } from "./_lib/recordsStore.js";
import {
  getStripe,
  createCheckoutSession,
  createPortalSession,
  findOrCreateCustomer,
  verifyStripeSignature,
  patchForEvent,
  PLAN_CATALOG,
} from "./_lib/billing.js";
import { PLAN_LIMITS, planStateFor } from "./_lib/plan.js";

/**
 * POST /api/billing?action=checkout|portal|webhook, GET/POST ?action=status
 *
 * bodyParser is OFF: every action needs the exact raw bytes at some point
 * (the webhook for signature verification; the others just for a plain JSON
 * body we parse ourselves) — one code path for reading the body, rather than
 * a webhook special case bolted onto Vercel's default parser.
 */
export const config = { api: { bodyParser: false }, maxDuration: 30 };

const SUCCESS_URL = "https://deepwelltechnology.com/app/?billing=success";
const CANCEL_URL = "https://deepwelltechnology.com/app/?billing=cancel";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function getTenantBillingRow(store) {
  const { rows } = await store.raw(
    `SELECT id, stripe_customer_id, stripe_subscription_id, plan, billing_status,
            trial_ends_at, current_period_end, cancel_at_period_end, trial_used, limits
       FROM tenants WHERE id = $1`,
    [store.tenantId]
  );
  return rows[0] ?? null;
}

async function handleCheckout(req, res, auth) {
  const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
  const plan = typeof body.plan === "string" ? body.plan : null;
  const interval = body.interval === "year" ? "year" : "month";
  const quantity = body.quantity;

  if (plan !== "records_rescue" && !PLAN_CATALOG[plan]) {
    return res.status(400).json({ error: "Unknown plan" });
  }
  if (hasShop(auth)) requireRole(auth, "admin");

  const stripe = getStripe();
  const result = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (store) => {
    // Serialize concurrent checkouts for this tenant: two simultaneous
    // requests with no stripe_customer_id yet must not each create a Stripe
    // customer — the second would orphan the first's (the paying) session.
    // pg_advisory_xact_lock is held for this transaction only (released on
    // commit/rollback); the second request's lock acquisition blocks until
    // the first commits its stripe_customer_id write, so its read below sees
    // that write instead of racing to create a second customer.
    await store.raw("SELECT pg_advisory_xact_lock(hashtext($1))", [`billing:${store.tenantId}`]);
    const tenantRow = await getTenantBillingRow(store);
    const customerId = await findOrCreateCustomer(stripe, {
      tenantRow,
      tenantId: store.tenantId,
      name: auth.orgId ?? auth.tenantId,
    });
    if (!tenantRow?.stripe_customer_id) {
      await store.raw(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, store.tenantId]);
    }
    const session = await createCheckoutSession(stripe, {
      tenantRow,
      plan,
      interval,
      quantity,
      tenantId: store.tenantId,
      customerId,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    });
    return session.url;
  });

  return handleCors(res, req).status(200).json({ url: result });
}

async function handlePortal(req, res, auth) {
  if (hasShop(auth)) requireRole(auth, "admin");
  const stripe = getStripe();
  const result = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (store) => {
    const tenantRow = await getTenantBillingRow(store);
    if (!tenantRow?.stripe_customer_id) {
      const err = new Error("No billing account yet — start a plan first.");
      err.status = 400;
      throw err;
    }
    const session = await createPortalSession(stripe, { customerId: tenantRow.stripe_customer_id, returnUrl: SUCCESS_URL });
    return session.url;
  });
  return handleCors(res, req).status(200).json({ url: result });
}

async function handleStatus(req, res, auth) {
  const result = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (store) => {
    const tenantRow = await getTenantBillingRow(store);
    const documentsStored = await store.countDocuments();
    const monthStartIso = new Date(Date.now() - MONTH_MS).toISOString();
    const pagesThisMonth = await store.countPagesSince(monthStartIso);
    return {
      plan: tenantRow?.plan ?? null,
      status: planStateFor(tenantRow ?? {}),
      trialEndsAt: tenantRow?.trial_ends_at ?? null,
      currentPeriodEnd: tenantRow?.current_period_end ?? null,
      cancelAtPeriodEnd: !!tenantRow?.cancel_at_period_end,
      limits: tenantRow?.limits ?? PLAN_LIMITS[tenantRow?.plan] ?? {},
      usage: { documentsStored, pagesThisMonth },
    };
  });
  return handleCors(res, req).status(200).json(result);
}

/** No Clerk auth: identified by Stripe customer id via the SECURITY DEFINER
 * lookup functions only — never by app.tenant_id (there isn't one). */
async function handleWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("billing webhook: STRIPE_WEBHOOK_SECRET is not set");
    return res.status(503).json({ error: "Webhook not configured" });
  }
  if (!verifyStripeSignature(rawBody.toString("utf8"), sig, secret)) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // 200 fast, log the rest: Stripe retries on anything but 2xx, and an event
  // type this app doesn't act on (or a duplicate) is not a failure.
  const mapped = patchForEvent(event);
  if (!mapped) {
    return res.status(200).json({ received: true, handled: false });
  }

  const pool = getPool();
  try {
    const { rows } = await pool.query("SELECT billing_tenant_by_customer($1) AS id", [mapped.customerId]);
    const tenantId = rows[0]?.id ?? null;
    if (!tenantId) {
      console.error("billing webhook: no tenant for customer", mapped.customerId);
      return res.status(200).json({ received: true, handled: false, reason: "unknown customer" });
    }
    const { rows: recRows } = await pool.query("SELECT billing_record_event($1, $2, $3, $4) AS fresh", [
      event.id,
      event.type,
      tenantId,
      JSON.stringify({ type: event.type }), // never the full payload — see billing_events comment; no PII, no card data
    ]);
    if (!recRows[0]?.fresh) {
      return res.status(200).json({ received: true, handled: false, reason: "duplicate" });
    }
    await pool.query("SELECT billing_apply($1, $2::jsonb)", [tenantId, JSON.stringify(mapped.patch)]);
    return res.status(200).json({ received: true, handled: true });
  } catch (err) {
    console.error("billing webhook: apply failed:", err?.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  const action = String(req.query?.action ?? "");

  if (action === "webhook") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    return handleWebhook(req, res);
  }

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  try {
    if (action === "checkout" && req.method === "POST") return await handleCheckout(req, res, auth);
    if (action === "portal" && req.method === "POST") return await handlePortal(req, res, auth);
    if (action === "status" && (req.method === "GET" || req.method === "POST")) return await handleStatus(req, res, auth);
    return res.status(404).json({ error: "Unknown billing action" });
  } catch (error) {
    if (error?.status) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
