import { requireAuth, denyAuth, hasShop, requireRole } from "./_lib/auth.js";
import { handleCors, handleError } from "./_lib/claude.js";
import { withTenant, getPool, bustTenantCache } from "./_lib/recordsStore.js";
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
import { getUsage, estimateCostUsd, getAsksThisMonth, resetsOnIso } from "./_lib/usage.js";

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
    // Monthly question allowance (owner decision, 2026-09-21) — see
    // usage.js's getAsksThisMonth doc comment for why this reads
    // rate_limit_windows rather than usage_counters.
    const asksThisMonth = await getAsksThisMonth(store);

    // Owner ask (2026-09-20): "make sure we're not wasting money asking
    // questions" — a per-tenant monthly AI-cost estimate on the Billing
    // screen, so a tenant asking a lot of questions or bulk-importing a lot
    // of pages can actually see it, not just Anthropic's own console.
    // getUsage() reads its own aux-pool connection (see usage.js) — best
    // effort, never fatal to the rest of this response.
    let aiCostEstimateUsd = 0;
    try {
      const days = await getUsage({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, 30);
      const totals = days.reduce(
        (acc, d) => ({
          inputTokens: acc.inputTokens + (d.modelInputTokens ?? 0),
          outputTokens: acc.outputTokens + (d.modelOutputTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 }
      );
      aiCostEstimateUsd = estimateCostUsd(totals);
    } catch (err) {
      console.error("billing status: AI cost estimate failed (non-fatal):", err?.message);
    }

    return {
      plan: tenantRow?.plan ?? null,
      status: planStateFor(tenantRow ?? {}),
      trialEndsAt: tenantRow?.trial_ends_at ?? null,
      currentPeriodEnd: tenantRow?.current_period_end ?? null,
      cancelAtPeriodEnd: !!tenantRow?.cancel_at_period_end,
      // asksPerMonth is always freshly computed from the live PLAN_LIMITS
      // table, never from the tenantRow.limits snapshot — a tenant whose
      // limits JSONB predates this build (no webhook has re-applied
      // billing_apply() since) would otherwise report a stale/missing cap
      // even though gateAsk (plan.js) already enforces the current one.
      limits: {
        ...(tenantRow?.limits ?? PLAN_LIMITS[tenantRow?.plan] ?? {}),
        asksPerMonth: PLAN_LIMITS[tenantRow?.plan]?.asksPerMonth ?? null,
      },
      // aiCostEstimateUsd: last-30-days estimate, NOT a bill — see
      // usage.js's estimateCostUsd doc comment for what it blends and why.
      // resetsOn: ISO date of next month's 1st UTC — the ask meter's reset
      // point (see usage.js's resetsOnIso).
      usage: { documentsStored, pagesThisMonth, asksThisMonth, aiCostEstimateUsd, resetsOn: resetsOnIso() },
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
    // Reviewer NO-GO (2026-09-22): billing_apply() just changed this tenant's
    // plan/billing_status, but api/_lib/plan.js's and recordsStore.js's
    // in-process caches (see handoffs/API_PERF_2026-09-22.md) don't know that
    // yet. Bust them on THIS instance immediately — same-instance only; the
    // caches' own short TTLs (30s for a gated 'none'/'canceled' row, 2 min
    // otherwise) are what bound staleness on every OTHER instance, since a
    // webhook has no way to reach them from here.
    bustTenantCache(tenantId);
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
