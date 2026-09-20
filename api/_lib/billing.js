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
export async function findOrCreateCustomer(stripe, { tenantRow, tenantId, name }) {
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

  const customer = await stripe.customers.create({ name: name ?? tenantId, metadata: { tenantId } });
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
  const item = sub?.items?.data?.[0];
  return item?.price?.metadata?.plan ?? null;
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
      const patch = {
        stripe_customer_id: customerId,
        stripe_subscription_id: obj.id,
        billing_status,
        current_period_end: isoOrNull(obj.current_period_end),
        trial_ends_at: isoOrNull(obj.trial_end),
        cancel_at_period_end: !!obj.cancel_at_period_end,
      };
      if (plan) {
        patch.plan = plan;
        patch.limits = PLAN_LIMITS[plan] ?? null;
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
