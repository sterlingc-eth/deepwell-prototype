/**
 * Stripe billing: plan catalog, the Stripe client, Checkout/Portal session
 * builders, and webhook signature verification + event->patch mapping.
 *
 * DEPENDENCY CHOICE: the official `stripe` npm package (^17), not raw fetch.
 * Checkout Session creation and Customer Portal creation are multi-field,
 * evolving request shapes where the SDK's typings and defaults save real
 * bugs; only signature verification is hand-rolled (see verifyStripeSignature
 * below) so scripts/verify-billing.mjs can test it as a pure function with a
 * fixture, no network, no real webhook secret, and no dependency on the SDK's
 * internal clock/tolerance handling.
 *
 * Prices are looked up by `lookup_key` (never by id) so nothing here has to
 * know a Stripe price id — scripts/stripe-setup.mjs creates them with the
 * lookup_keys this file expects; see PLAN_CATALOG / lookupKeyFor.
 */
import Stripe from 'stripe';
import crypto from 'node:crypto';
import { PLAN_LIMITS } from './plan.js';

/** Monthly USD price per plan. Annual = 11x monthly (one month free). */
export const PLAN_CATALOG = Object.freeze({
  solo:  Object.freeze({ id: 'solo',  name: 'DeepWell Solo',  monthly: 99,  trialEligible: true }),
  shop:  Object.freeze({ id: 'shop',  name: 'DeepWell Shop',  monthly: 199, trialEligible: false }),
  crew:  Object.freeze({ id: 'crew',  name: 'DeepWell Crew',  monthly: 399, trialEligible: false }),
  fleet: Object.freeze({ id: 'fleet', name: 'DeepWell Fleet', monthly: 899, trialEligible: false }),
});

export const PLAN_IDS = Object.freeze(Object.keys(PLAN_CATALOG));

/** One month free: annual = 11 * monthly. Exported so stripe-setup.mjs and
 * verify-billing.mjs use the identical formula instead of each hardcoding it. */
export function annualPrice(monthly) {
  return monthly * 11;
}

/** solo_monthly / solo_annual / ... — the lookup_key scheme stripe-setup.mjs creates. */
export function lookupKeyFor(plan, interval) {
  const suffix = interval === 'year' ? 'annual' : 'monthly';
  return `${plan}_${suffix}`;
}

/**
 * REQUEST 2b (2026-09-21, owner brief): "Maybe they can add the automated
 * portion that auto-sends if they pay extra." The Stripe price lookup_key
 * for that add-on, added to a tenant's subscription as its own line item
 * alongside their base plan.
 *
 * CANONICAL KEY: `outreach_auto` — the name the owner checklist
 * (handoffs/START_HERE_NEXT_CHAT.md) tells the owner to create in the Stripe
 * dashboard. scripts/stripe-setup.mjs does NOT create this price (nothing
 * creates it but the owner). The pre-2026-09-28 code expected
 * `outreach_auto_addon_monthly`, which never matched the checklist; that name
 * is still accepted as an alias so a price created under either name
 * grants the entitlement. No product/price is created here: until the owner
 * creates one, patchForEvent() below simply never sees it on a
 * subscription's items and `limits.outreachAuto` stays unset (see plan.js's
 * hasOutreachAutoEntitlement).
 */
export const OUTREACH_AUTO_ADDON_LOOKUP_KEY = 'outreach_auto';
/** Every lookup_key that means "the auto-send add-on" (canonical first). */
export const OUTREACH_AUTO_ADDON_LOOKUP_KEYS = Object.freeze([OUTREACH_AUTO_ADDON_LOOKUP_KEY, 'outreach_auto_addon_monthly']);
export function isOutreachAutoAddOnKey(key) {
  return OUTREACH_AUTO_ADDON_LOOKUP_KEYS.includes(String(key ?? ''));
}

export const RECORDS_RESCUE = Object.freeze({
  lookupKey: 'records_rescue_page',
  productName: 'Records Rescue scanning',
  unitPriceCents: 12,   // $0.12/page
  minUnits: 4167,       // ceil($500 / $0.12) — the $500 minimum, enforced here since Stripe's price has no built-in floor
});

/** Clamp a requested page quantity up to the $500 minimum. */
export function resolveRecordsRescueQuantity(requested) {
  const n = Math.trunc(Number(requested) || 0);
  return Math.max(RECORDS_RESCUE.minUnits, n);
}

/** Solo, monthly or annual, only for a tenant that has never trialed. */
export function isTrialEligible(plan, tenantRow) {
  return plan === 'solo' && PLAN_CATALOG.solo.trialEligible && tenantRow?.trial_used !== true;
}

let _stripe;
/** Lazy singleton. STRIPE_SECRET_KEY is read from env only, at call time —
 * never logged, never returned to a caller. */
export function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('Billing is not configured for this environment.');
    err.name = 'ConfigError';
    throw err;
  }
  _stripe = new Stripe(key, { apiVersion: '2024-06-20', maxNetworkRetries: 2 });
  return _stripe;
}

async function priceIdFor(stripe, lookupKey) {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = data[0];
  if (!price) throw new Error(`No active Stripe price for lookup_key "${lookupKey}" — run scripts/stripe-setup.mjs`);
  return price.id;
}

/**
 * @param {{tenantRow: object, plan: string, interval: 'month'|'year', quantity?: number, tenantId: string, customerId: string, successUrl: string, cancelUrl: string}} args
 */
export async function createCheckoutSession(stripe, args) {
  const { tenantRow, plan, interval, quantity, tenantId, customerId, successUrl, cancelUrl } = args;

  if (plan === 'records_rescue') {
    const priceId = await priceIdFor(stripe, RECORDS_RESCUE.lookupKey);
    return stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: tenantId,
      line_items: [{ price: priceId, quantity: resolveRecordsRescueQuantity(quantity) }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      metadata: { tenantId, plan },
    });
  }

  if (!PLAN_CATALOG[plan]) throw new Error(`Unknown plan "${plan}"`);
  const lookupKey = lookupKeyFor(plan, interval === 'year' ? 'year' : 'month');
  const priceId = await priceIdFor(stripe, lookupKey);

  /** @type {import('stripe').Stripe.Checkout.SessionCreateParams} */
  const params = {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: tenantId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
    metadata: { tenantId, plan },
  };
  if (isTrialEligible(plan, tenantRow)) {
    params.subscription_data = {
      trial_period_days: 30,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    };
    params.payment_method_collection = 'always'; // card required at checkout even during trial
  }
  return stripe.checkout.sessions.create(params);
}

export async function createPortalSession(stripe, { customerId, returnUrl }) {
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

/**
 * Pure decision: which Stripe customer id to use, given what's already on
 * the tenant row and what a Stripe metadata search found. Never calls
 * Stripe or Postgres — exported so scripts/verify-billing.mjs can assert the
 * precedence with no network. The tenant row always wins: it reflects
 * whatever the transaction holding the advisory lock (api/billing.js's
 * checkout handler) has already committed, which is more current than a
 * search hit could be.
 * @param {{tenantRow?: {stripe_customer_id?: string|null}, foundByMetadata?: string|null}} args
 * @returns {string|null} an id to reuse, or null when a new customer is needed
 */
export function chooseExistingCustomerId({ tenantRow, foundByMetadata }) {
  return tenantRow?.stripe_customer_id || foundByMetadata || null;
}

/**
 * Find-or-create a Stripe customer for a tenant.
 *
 * The real safety against two concurrent checkouts creating two customers is
 * the `pg_advisory_xact_lock` api/billing.js's checkout handler takes before
 * calling this — the second concurrent request blocks until the first
 * commits its `stripe_customer_id` write, and reads the freshly-committed
 * value instead of racing to create its own. This function's own metadata
 * search is belt-and-braces on top of that: if the lock is ever missed by a
 * future caller, or two different tenant rows somehow point at the same
 * Stripe account gap, searching Stripe itself before creating still catches
 * it. Search failures never block checkout — they just fall through to
 * `chooseExistingCustomerId` finding nothing and creating a new customer,
 * same as if the search had legitimately found none.
 */
export async function findOrCreateCustomer(stripe, { tenantRow, tenantId, name, email }) {
  if (tenantRow?.stripe_customer_id) return tenantRow.stripe_customer_id;

  let foundByMetadata = null;
  try {
    const { data } = await stripe.customers.search({ query: `metadata['tenantId']:'${tenantId}'`, limit: 1 });
    foundByMetadata = data[0]?.id ?? null;
  } catch (err) {
    console.error('billing: customer metadata search failed (continuing to create):', err?.message);
  }

  const existing = chooseExistingCustomerId({ tenantRow, foundByMetadata });
  if (existing) return existing;

  const params = { name: name ?? tenantId, metadata: { tenantId } };
  // The admin's email lands on Stripe receipts/invoices and lets Stripe's own dunning emails reach a human.
  if (typeof email === 'string' && email.includes('@')) params.email = email;
  const customer = await stripe.customers.create(params);
  return customer.id;
}

// ---------------------------------------------------------------------------
// Webhook signature verification — hand-rolled per Stripe's documented
// scheme (https://stripe.com/docs/webhooks#verify-manually) so it is a pure,
// dependency-free function: HMAC-SHA256(secret, `${timestamp}.${payload}`),
// compared against the `v1` value(s) in the Stripe-Signature header, with a
// tolerance window against replay. Testable with a fixture and no real
// webhook secret — see scripts/verify-billing.mjs.
// ---------------------------------------------------------------------------

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * @param {string} rawBody         the exact bytes Stripe sent, as a string (never JSON.parsed first)
 * @param {string} sigHeader       the `Stripe-Signature` request header
 * @param {string} secret          STRIPE_WEBHOOK_SECRET
 * @param {{toleranceSeconds?: number, now?: number}} [opts]
 * @returns {boolean}
 */
export function verifyStripeSignature(rawBody, sigHeader, secret, opts = {}) {
  if (!rawBody || !sigHeader || !secret) return false;
  const toleranceSeconds = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.now ?? Date.now();

  const parts = String(sigHeader).split(',').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    if (k === 't') acc.t = v;
    else if (k === 'v1') (acc.v1 ??= []).push(v);
    return acc;
  }, { v1: [] });

  if (!parts.t || parts.v1.length === 0) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  return parts.v1.some((candidate) => {
    if (!candidate || candidate.length !== expected.length) return false;
    const candBuf = Buffer.from(candidate, 'hex');
    return candBuf.length === expectedBuf.length && crypto.timingSafeEqual(candBuf, expectedBuf);
  });
}

// ---------------------------------------------------------------------------
// Event -> tenant patch mapping. Pure: takes a parsed Stripe event object,
// returns { customerId, patch } (patch shaped for billing_apply()'s jsonb
// merge) or null for an event this app doesn't act on. No Stripe client, no
// database — see scripts/verify-billing.mjs for the event fixtures this is
// tested against.
// ---------------------------------------------------------------------------

function planFromSubscriptionItem(sub) {
  // Every item, not just the first: the auto-send add-on can be listed before
  // the base plan. Prefer price.metadata.plan; fall back to the lookup_key
  // scheme (solo_monthly / shop_annual / ...) so a price created without
  // metadata still resolves a plan instead of silently applying none.
  for (const item of sub?.items?.data ?? []) {
    const fromMeta = item?.price?.metadata?.plan;
    if (fromMeta && PLAN_CATALOG[fromMeta]) return fromMeta;
  }
  for (const item of sub?.items?.data ?? []) {
    const key = String(item?.price?.lookup_key ?? '');
    const prefix = key.split('_')[0];
    if (!isOutreachAutoAddOnKey(key) && PLAN_CATALOG[prefix]) return prefix;
  }
  const first = sub?.items?.data?.[0]?.price?.metadata?.plan;
  return first ?? null;
}

function isoOrNull(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/** Map a Stripe subscription `status` to our four-state model. */
export function billingStatusFromStripeStatus(status) {
  switch (status) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due':
    case 'unpaid': return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'paused': return 'canceled';
    case 'incomplete': return 'none';
    default: return 'none';
  }
}

/**
 * @param {object} event  a parsed Stripe event (event.type / event.data.object)
 * @returns {{customerId: string, patch: object}|null}
 */
export function patchForEvent(event) {
  const obj = event?.data?.object;
  if (!obj) return null;

  switch (event.type) {
    case 'checkout.session.completed': {
      const customerId = obj.customer;
      if (!customerId) return null;
      const patch = { stripe_customer_id: customerId };
      if (obj.subscription) patch.stripe_subscription_id = obj.subscription;
      return { customerId, patch };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = obj.customer;
      if (!customerId) return null;
      const plan = planFromSubscriptionItem(obj);
      const billing_status = billingStatusFromStripeStatus(obj.status);
      // REQUEST 2b: the auto-send add-on rides as its own line item on the
      // same subscription. Detected by lookup_key so this needs no Stripe
      // product id, same idiom as priceIdFor()'s plan lookups.
      const hasOutreachAutoAddOn = (obj.items?.data ?? []).some(
        (item) => isOutreachAutoAddOnKey(item?.price?.lookup_key)
      );
      const patch = {
        stripe_customer_id: customerId,
        stripe_subscription_id: obj.id,
        billing_status,
        // Newer Stripe API versions moved current_period_end onto the item.
        current_period_end: isoOrNull(obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end),
        trial_ends_at: isoOrNull(obj.trial_end),
        cancel_at_period_end: !!obj.cancel_at_period_end,
      };
      if (plan) {
        patch.plan = plan;
        // `limits` is replaced wholesale by billing_apply() (see its own
        // comment), so the add-on flag is folded in here rather than
        // written separately — a subscription event that resolves a plan
        // is the only place this app currently learns the add-on's state.
        // No add-on item present -> patch.limits is BYTE-IDENTICAL to
        // PLAN_LIMITS[plan] (scripts/verify-billing.mjs asserts this) —
        // both "never had it" and "just removed it" correctly end up with
        // no `outreachAuto` key at all once this replaces tenants.limits.
        // OPEN (out of scope for this pass, see the handoff): a Stripe
        // event for the add-on item alone, with no plan-carrying item
        // present, is not handled — rare in practice since Stripe reports
        // the whole subscription's items on every update.
        patch.limits = hasOutreachAutoAddOn
          ? { ...(PLAN_LIMITS[plan] ?? {}), outreachAuto: true }
          : (PLAN_LIMITS[plan] ?? null);
      }
      // Once a subscription has ever reached 'trialing', that trial is spent —
      // even if the customer later cancels, they don't get a second free trial.
      if (obj.status === 'trialing' || obj.trial_end) patch.trial_used = true;
      return { customerId, patch };
    }

    case 'customer.subscription.deleted': {
      const customerId = obj.customer;
      if (!customerId) return null;
      return {
        customerId,
        patch: { stripe_customer_id: customerId, billing_status: 'canceled', cancel_at_period_end: true },
      };
    }

    case 'invoice.paid': {
      const customerId = obj.customer;
      if (!customerId || !obj.subscription) return null;
      // Recovers a past_due tenant; the following subscription.updated event
      // (Stripe sends both) carries the authoritative period/plan detail.
      return { customerId, patch: { stripe_customer_id: customerId, billing_status: 'active' } };
    }

    case 'invoice.payment_failed': {
      const customerId = obj.customer;
      if (!customerId || !obj.subscription) return null;
      return { customerId, patch: { stripe_customer_id: customerId, billing_status: 'past_due' } };
    }

    default:
      return null;
  }
}

/** Stripe webhook events this app registers for and handles. Also printed by
 * scripts/stripe-setup.mjs so the dashboard/CLI registration matches exactly. */
export const WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/**
 * Record the event in the idempotency ledger AND apply its patch in ONE
 * transaction. Why one transaction: recording first and applying second (two
 * autocommit statements) meant that if the apply failed after the ledger row
 * was written, Stripe's retry was answered "duplicate" and the subscription
 * change was lost forever. Now a failed apply rolls the ledger row back too,
 * so the retry applies it.
 *
 * Ledger failure is non-fatal: if billing_record_event() itself errors (the
 * "boolean > integer" bug in the pre-59 function, a missing migration, a
 * transient blip) we log it and apply anyway — billing_apply() is a
 * present-key-wins merge patch, so a replayed event only re-writes the same
 * values. A paying customer's subscription state must never fail to apply
 * because a dedupe ledger is unavailable.
 * @returns {Promise<"applied"|"duplicate">}
 */
export async function recordAndApplyEvent(pool, event, tenantId, patch) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let fresh = true;
    await client.query("SAVEPOINT billing_ledger");
    try {
      const { rows } = await client.query("SELECT billing_record_event($1, $2, $3, $4::jsonb) AS fresh", [
        event.id,
        event.type,
        tenantId,
        JSON.stringify({ type: event.type }), // never the full payload — see billing_events comment; no PII, no card data
      ]);
      fresh = rows[0]?.fresh !== false;
      await client.query("RELEASE SAVEPOINT billing_ledger");
    } catch (ledgerErr) {
      await client.query("ROLLBACK TO SAVEPOINT billing_ledger");
      console.error("billing webhook: idempotency ledger unavailable, applying without it:", ledgerErr?.message);
      fresh = true;
    }
    if (!fresh) {
      await client.query("ROLLBACK");
      return "duplicate";
    }
    await client.query("SELECT billing_apply($1, $2::jsonb)", [tenantId, JSON.stringify(patch)]);
    await client.query("COMMIT");
    return "applied";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Customer identity for Stripe (receipts, invoices, dunning emails)
// ---------------------------------------------------------------------------

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.())]);

/**
 * The shop name and admin email to put on the Stripe customer, instead of the Clerk org id ("org_2abc…") that
 * used to be the customer's name with no email at all. Looked up from Clerk's Backend API (best effort, 4 s
 * each, never fatal): a lookup that fails falls back to the previous behavior — the org id as the name, no
 * email — so checkout can never be blocked by Clerk being slow.
 *
 * Checkout is admin-gated, so the requesting user IS a shop admin: their primary email is the admin email.
 * @param {{userId?: string, orgId?: string|null, tenantId: string, email?: string}} auth
 * @param {{clerk?: any}} [opts]  inject a Clerk client (tests); default builds one from CLERK_SECRET_KEY
 * @returns {Promise<{name: string, email: string|undefined}>}
 */
export async function resolveBillingIdentity(auth, opts = {}) {
  let name = auth?.orgId ?? auth?.tenantId;
  let email = typeof auth?.email === 'string' && auth.email.includes('@') ? auth.email : undefined;
  let clerk = opts.clerk;
  if (!clerk) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) return { name, email };
    try {
      const { createClerkClient } = await import('@clerk/backend');
      clerk = createClerkClient({ secretKey });
    } catch (err) {
      console.error('billing identity: Clerk client unavailable:', err?.message);
      return { name, email };
    }
  }
  if (auth?.orgId) {
    try {
      const org = await withTimeout(clerk.organizations.getOrganization({ organizationId: auth.orgId }), 4000);
      if (typeof org?.name === 'string' && org.name.trim()) name = org.name.trim();
    } catch (err) {
      console.error('billing identity: org name lookup failed (using org id):', err?.message);
    }
  }
  if ((!email || !auth?.orgId) && auth?.userId) {
    try {
      const user = await withTimeout(clerk.users.getUser(auth.userId), 4000);
      const addrs = user?.emailAddresses ?? [];
      const primary = addrs.find((a) => a?.id === user?.primaryEmailAddressId) ?? addrs[0];
      if (!email && typeof primary?.emailAddress === 'string') email = primary.emailAddress;
      if (!auth?.orgId) {
        const full = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
        if (full) name = full;
      }
    } catch (err) {
      console.error('billing identity: user lookup failed:', err?.message);
    }
  }
  return { name, email };
}

// ---------------------------------------------------------------------------
// Tenant deletion: stop the billing
// ---------------------------------------------------------------------------

const DEAD_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);
const isMissing = (err) => err?.code === 'resource_missing' || err?.statusCode === 404;

/**
 * Cancel every live Stripe subscription of a tenant IMMEDIATELY (no proration credit, no final invoice) so a
 * customer who deletes their data is not billed again. Looks at the tenant's recorded subscription AND lists the
 * Stripe customer's subscriptions, so a subscription the database never learned about (missed webhook) is
 * still caught. "Already gone" is success. Never throws: returns what happened; the caller decides whether a
 * failure should stop the deletion.
 * @returns {Promise<{canceled: string[], alreadyGone: string[], failed: {id: string|null, message: string}[], skipped: string|null}>}
 */
export async function cancelTenantSubscriptions(stripe, { customerId, subscriptionId }) {
  const result = { canceled: [], alreadyGone: [], failed: [], skipped: null };
  if (!customerId && !subscriptionId) { result.skipped = 'no-subscription'; return result; }

  const ids = new Set();
  if (subscriptionId) ids.add(subscriptionId);
  if (customerId) {
    try {
      const { data } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      for (const sub of data ?? []) if (!DEAD_SUBSCRIPTION_STATUSES.has(sub.status)) ids.add(sub.id);
    } catch (err) {
      // A customer that no longer exists has nothing to bill. Anything else means we cannot be sure we found
      // every subscription: report it as a failure rather than pretending the customer is clean.
      if (!isMissing(err)) result.failed.push({ id: null, message: `could not list subscriptions: ${err?.message ?? 'unknown error'}` });
    }
  }
  if (!ids.size && !result.failed.length) { result.skipped = 'no-live-subscription'; return result; }

  for (const id of ids) {
    try {
      await stripe.subscriptions.cancel(id, {
        invoice_now: false,
        prorate: false,
        cancellation_details: { comment: 'Customer deleted their DeepWell data' },
      });
      result.canceled.push(id);
    } catch (err) {
      if (isMissing(err)) result.alreadyGone.push(id);
      // Stripe answers 400 "already canceled" when a subscription is dead but still retrievable.
      else if (/already (been )?cancel/i.test(String(err?.message))) result.alreadyGone.push(id);
      else result.failed.push({ id, message: err?.message ?? 'unknown error' });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pull-based reconcile: a missed webhook must not lock out a paying customer
// ---------------------------------------------------------------------------

const LIVE_FIRST = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'canceled', 'incomplete_expired'];

/** Pick the subscription that best describes a customer's current state: live ones first, newest first. */
export function pickSubscription(subs) {
  const list = [...(subs ?? [])].filter((s) => s && s.id);
  list.sort((a, b) => {
    const ra = LIVE_FIRST.indexOf(a.status);
    const rb = LIVE_FIRST.indexOf(b.status);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || (b.created ?? 0) - (a.created ?? 0);
  });
  return list[0] ?? null;
}

/**
 * Should the status endpoint ask Stripe what this tenant's subscription looks like? Yes when the tenant has a
 * Stripe customer (created when checkout starts) but the database still says nothing useful: state 'none',
 * or no subscription id recorded. That is exactly "paid, but the webhook never arrived".
 */
export function needsBillingReconcile(row) {
  if (!row?.stripe_customer_id) return false;
  const status = row.billing_status ?? 'none';
  return status === 'none' || status === 'incomplete' || (!row.stripe_subscription_id && status !== 'canceled');
}

const _reconcileAt = new Map();
export const RECONCILE_MIN_INTERVAL_MS = 15_000;
/** Test hook: forget throttle state. */
export function _resetReconcileThrottle() { _reconcileAt.clear(); }

/**
 * Fetch the tenant's subscription from Stripe and apply it through the SAME event->patch mapping and
 * billing_apply() the webhook uses (a synthetic customer.subscription.updated), so the two paths cannot
 * disagree. Idempotent (present-key-wins merge), throttled per tenant, writes only when something changed, never
 * throws (a Stripe outage must not break the status endpoint). Returns { applied, reason?, status?, plan? }.
 * @param {{query: Function}} pool  pg pool (billing_apply is SECURITY DEFINER)
 * @param {object} stripe            Stripe client (or a fake with subscriptions.retrieve/list)
 */
export async function reconcileTenantBilling(pool, stripe, { tenantId, row, now = Date.now() }) {
  const last = _reconcileAt.get(tenantId) ?? 0;
  if (now - last < RECONCILE_MIN_INTERVAL_MS) return { applied: false, reason: 'throttled' };
  _reconcileAt.set(tenantId, now);
  try {
    let sub = null;
    if (row?.stripe_subscription_id) {
      try {
        sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
    if (!sub && row?.stripe_customer_id) {
      const { data } = await stripe.subscriptions.list({ customer: row.stripe_customer_id, status: 'all', limit: 10 });
      sub = pickSubscription(data);
    }
    if (!sub) return { applied: false, reason: 'no-subscription' };
    // An abandoned checkout (never paid) is not news: leave the tenant at 'none' rather than flipping it to 'canceled'.
    if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') return { applied: false, reason: 'incomplete' };

    const mapped = patchForEvent({ type: 'customer.subscription.updated', data: { object: sub } });
    if (!mapped) return { applied: false, reason: 'unmapped' };
    const p = mapped.patch;
    const same =
      row?.stripe_subscription_id === p.stripe_subscription_id &&
      row?.billing_status === p.billing_status &&
      (p.plan == null || row?.plan === p.plan) &&
      !!row?.cancel_at_period_end === !!p.cancel_at_period_end &&
      (row?.current_period_end ? new Date(row.current_period_end).toISOString() : null) === (p.current_period_end ?? null);
    if (same) return { applied: false, reason: 'already-current' };

    await pool.query('SELECT billing_apply($1, $2::jsonb)', [tenantId, JSON.stringify(p)]);
    return { applied: true, status: p.billing_status, plan: p.plan ?? row?.plan ?? null };
  } catch (err) {
    console.error('billing reconcile failed (non-fatal):', err?.message);
    return { applied: false, reason: 'error' };
  }
}
