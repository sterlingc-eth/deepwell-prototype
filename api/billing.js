import { requireAuth, denyAuth, hasShop, requireRole } from "./_lib/auth.js";
import { handleCors, handleError, sendPrivateCacheableJson } from "./_lib/claude.js";
import { withTenant, getPool, bustTenantCache } from "./_lib/recordsStore.js";
import {
  getStripe,
  createCheckoutSession,
  createPortalSession,
  findOrCreateCustomer,
  verifyStripeSignature,
  patchForEvent,
  recordAndApplyEvent,
  PLAN_CATALOG,
  resolveBillingIdentity,
  needsBillingReconcile,
  reconcileTenantBilling,
} from "./_lib/billing.js";
import { clientLimits, planStateFor, loginCapForPlan, loadRescueCredit, extraPagesFor } from "./_lib/plan.js";
import { getSeatState, syncOrgMemberLimit, syncTenantAfterBilling, guardedInvite } from "./_lib/seats.js";
import { getUsage, estimateCostUsd, getAsksThisMonth, resetsOnIso } from "./_lib/usage.js";
import { limit as rateLimit } from "./_lib/rateLimit.js";

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

/** R30 L6: a malformed body is the caller's mistake (400), not a 500. */
async function readJsonBody(req) {
  try {
    const parsed = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

/**
 * R30 M2: a tenant that already has a live subscription must not start a SECOND one (double billing; and with the
 * old webhook, cancelling the old one cancelled the tenant). Pure. Records Rescue is a one-off payment and is
 * always allowed.
 * @param {string} plan
 * @param {object|null} tenantRow
 */
export function checkoutBlockedByLiveSubscription(plan, tenantRow) {
  if (plan === "records_rescue") return false;
  const state = planStateFor(tenantRow ?? {});
  return state === "active" || state === "trialing" || state === "past_due";
}

async function handleCheckout(req, res, auth) {
  const body = await readJsonBody(req);
  if (body === null) return res.status(400).json({ error: "Invalid request body" });
  const plan = typeof body.plan === "string" ? body.plan : null;
  const interval = body.interval === "year" ? "year" : "month";
  const quantity = body.quantity;

  if (plan !== "records_rescue" && !PLAN_CATALOG[plan]) {
    return res.status(400).json({ error: "Unknown plan" });
  }
  if (hasShop(auth)) requireRole(auth, "admin");
  if (!(await rateLimit(req, res, auth, "billing"))) return; // 429 already written

  const stripe = getStripe();
  // Shop name + admin email for the Stripe customer (receipts/invoices read "Acme HVAC", not "org_2abc…").
  // Best effort and bounded — a Clerk hiccup falls back to the org id and never blocks checkout.
  const identity = await resolveBillingIdentity(auth);
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
    if (checkoutBlockedByLiveSubscription(plan, tenantRow) && tenantRow?.stripe_customer_id) {
      // Send them to the billing portal (change plan / update card there) instead of creating another subscription.
      try {
        const portal = await createPortalSession(stripe, { customerId: tenantRow.stripe_customer_id, returnUrl: SUCCESS_URL });
        return { portalUrl: portal.url };
      } catch (err) {
        console.error("billing checkout: portal redirect failed:", err?.message);
        const e = new Error("You already have an active subscription. Use Manage billing to change your plan.");
        e.status = 409;
        throw e;
      }
    }
    const customerId = await findOrCreateCustomer(stripe, {
      tenantRow,
      tenantId: store.tenantId,
      name: identity.name,
      email: identity.email,
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

  if (result && typeof result === "object" && result.portalUrl) {
    return handleCors(res, req).status(200).json({
      url: result.portalUrl,
      portal: true,
      notice: "You already have an active subscription, so we opened Manage billing where you can change your plan.",
    });
  }
  return handleCors(res, req).status(200).json({ url: result });
}

async function handlePortal(req, res, auth) {
  if (hasShop(auth)) requireRole(auth, "admin");
  if (!(await rateLimit(req, res, auth, "billing"))) return; // 429 already written
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

async function computeStatus(auth) {
  let billingRow = null;
  const result = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (store) => {
    const tenantRow = await getTenantBillingRow(store);
    billingRow = tenantRow;
    const documentsStored = await store.countDocuments();
    const monthStartIso = new Date(Date.now() - MONTH_MS).toISOString();
    const pagesThisMonth = await store.countPagesSince(monthStartIso);
    // Monthly ask count — feeds only the hidden Donovan safety ceiling (plan.js DONOVAN_SAFETY); there is no
    // per-plan allowance any more. See usage.js's getAsksThisMonth for why this reads rate_limit_windows.
    const asksThisMonth = await getAsksThisMonth(store);
    // R36: pages bought through Records Rescue that are still unread (granted by the Stripe webhook, see plan.js
    // loadRescueCredit), and the owner-set monthly extra, so the Billing screen can show the real allowance.
    const rescue = tenantRow?.plan ? await loadRescueCredit(store, tenantRow) : { granted: 0, used: 0, remaining: 0 };

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
      // Round 26: limits always come from the live plan table (logins, documents, pages) — never from the
      // tenants.limits snapshot, which may predate a plan-table change. Donovan has no per-plan allowance.
      limits: clientLimits(tenantRow),
      // aiCostEstimateUsd: last-30-days estimate, NOT a bill — see
      // usage.js's estimateCostUsd doc comment for what it blends and why.
      // resetsOn: ISO date of next month's 1st UTC (page-allowance reset).
      usage: { documentsStored, pagesThisMonth, asksThisMonth, aiCostEstimateUsd, resetsOn: resetsOnIso(), rescuePagesRemaining: rescue.remaining, rescuePagesPurchased: rescue.granted, extraPagesPerMonth: extraPagesFor(tenantRow) },
    };
  });
  return { result, row: billingRow };
}

/**
 * GET/POST ?action=status — also the pull-based safety net for a missed Stripe webhook. This is the call the
 * app's post-checkout polling loop (?billing=success) makes: if the tenant has a Stripe customer but the database
 * still says "none" (or has no subscription recorded), ask Stripe directly and apply what it says through the
 * same mapping + billing_apply() the webhook uses, then recompute. A customer who paid can therefore never be
 * stuck behind a lost webhook. Throttled per tenant; a Stripe error is logged and the plain status returned.
 */
async function handleStatus(req, res, auth) {
  const first = await computeStatus(auth);
  const row = first.row;
  let result = first.result;
  if (needsBillingReconcile(row) && process.env.STRIPE_SECRET_KEY) {
    let outcome;
    try {
      outcome = await reconcileTenantBilling(getPool(), getStripe(), { tenantId: row.id, row });
    } catch (err) {
      console.error("billing status: reconcile skipped:", err?.message);
    }
    if (outcome?.applied) {
      bustTenantCache(row.id);
      // A reconcile that applied a plan is a plan change: keep Clerk's member limit in step (non-fatal, never throws).
      await syncTenantAfterBilling(getPool(), row.id);
      ({ result } = await computeStatus(auth));
      result.reconciled = true;
    }
  }
  handleCors(res, req);
  // Startup performance (handoffs/STARTUP_PERF_R13.md): private, short-lived
  // cache + ETag — this is polled on every load plus the post-checkout
  // confirmation loop above, and doesn't change on most of those polls.
  return sendPrivateCacheableJson(res, req, result, 15);
}


/**
 * GET/POST ?action=seats — admin-only. Live login usage for the Team screen ("3 of 5 logins used (owner not
 * counted)") computed on the server from Clerk (owner excluded via org.createdBy, extra admins and pending
 * invites counted — see api/_lib/seats.js), plus the LAZY Clerk sync: every call (throttled per org) makes sure
 * the org's maxAllowedMemberships is cap + 1, so an org whose plan changed before this build shipped still
 * converges. Never fails the screen because of Clerk: on a Clerk error it answers 200 with `seats: null`.
 */
async function handleSeats(req, res, auth) {
  if (!hasShop(auth)) return handleCors(res, req).status(200).json({ plan: null, cap: null, seats: null });
  requireRole(auth, "admin");
  const plan = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (store) => (await getTenantBillingRow(store))?.plan ?? null);
  const cap = loginCapForPlan(plan);
  let seats = null;
  let clerkSync = null;
  try {
    const { org, ...view } = await getSeatState({ orgId: auth.orgId, plan });
    seats = view;
    clerkSync = await syncOrgMemberLimit({ orgId: auth.orgId, plan, org });
  } catch (err) {
    console.error("billing seats: could not read seats from Clerk (non-fatal):", err?.message);
  }
  return handleCors(res, req).status(200).json({ plan, cap: cap ?? null, seats, clerkSync: clerkSync ? { action: clerkSync.action, ok: clerkSync.ok } : null });
}

/** POST ?action=invite body {email, role?} — admin-only; the server-side seat guard (seats.js guardedInvite). */
async function handleInvite(req, res, auth) {
  if (!hasShop(auth)) return res.status(400).json({ error: "Create your shop first to invite people." });
  requireRole(auth, "admin");
  if (!(await rateLimit(req, res, auth, "billing"))) return; // 429 already written
  let body;
  try {
    body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const row = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (store) => getTenantBillingRow(store));
  const state = planStateFor(row ?? {});
  if (state === "none" || state === "canceled") {
    return res.status(402).json({ error: "Choose a plan to get started", url: "/app/?screen=billing" });
  }
  const result = await guardedInvite({
    orgId: auth.orgId,
    plan: row?.plan ?? null,
    email: body.email,
    role: body.role === "admin" ? "admin" : "member",
    inviterUserId: auth.userId,
  });
  handleCors(res, req);
  if (!result.ok) return res.status(result.status).json({ error: result.error, seats: result.seats ?? null, url: result.url });
  return res.status(200).json({ ok: true, invitation: result.invitation, seats: result.seats });
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
    const outcome = await recordAndApplyEvent(pool, event, tenantId, mapped.patch);
    if (outcome === "duplicate") {
      return res.status(200).json({ received: true, handled: false, reason: "duplicate" });
    }
    // R30 M1: recorded in the ledger but deliberately not applied (older than what we have, another subscription, ...).
    if (outcome === "ignored") {
      return res.status(200).json({ received: true, handled: false, reason: "ignored" });
    }
    // Reviewer NO-GO (2026-09-22): billing_apply() just changed this tenant's
    // plan/billing_status, but api/_lib/plan.js's and recordsStore.js's
    // in-process caches (see handoffs/API_PERF_2026-09-22.md) don't know that
    // yet. Bust them on THIS instance immediately — same-instance only; the
    // caches' own short TTLs (30s for a gated 'none'/'canceled' row, 2 min
    // otherwise) are what bound staleness on every OTHER instance, since a
    // webhook has no way to reach them from here.
    bustTenantCache(tenantId);
    // Round 26: a subscription create/update (plan change, trial start) re-syncs the Clerk org's
    // maxAllowedMemberships to cap + 1. Best effort — syncTenantAfterBilling never throws, and a Clerk
    // rejection must never turn a successfully applied billing event into a webhook failure.
    if (mapped.patch.plan) await syncTenantAfterBilling(pool, tenantId, { plan: mapped.patch.plan });
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
    if (action === "seats" && (req.method === "GET" || req.method === "POST")) return await handleSeats(req, res, auth);
    if (action === "invite" && req.method === "POST") return await handleInvite(req, res, auth);
    return res.status(404).json({ error: "Unknown billing action" });
  } catch (error) {
    if (error?.status) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
