/**
 * Subscription gating: what state a tenant's billing is in, and what that
 * state permits on upload-url and ask. Pure functions only — no database, no
 * Stripe — so scripts/verify-billing.mjs can test every branch with fixture
 * tenant rows. The exact rules this file implements are written out in
 * handoffs/BILLING_RULES.md; keep the two in sync.
 */

/** Per-plan caps, written to tenants.limits by billing_apply() on every
 * subscription create/update webhook. Exported so api/_lib/billing.js's
 * webhook handler and scripts/verify-billing.mjs share one source of truth.
 * `null` = uncapped (Fleet has no seat/document ceiling; its own page cap is
 * a real number because it's what deep-storage overage would be sold against
 * later, per the brief). */
export const PLAN_LIMITS = Object.freeze({
  solo:  Object.freeze({ technicians: 1,    documentsStored: 25_000,  pagesPerMonth: 750 }),
  shop:  Object.freeze({ technicians: 4,    documentsStored: 100_000, pagesPerMonth: 2_000 }),
  crew:  Object.freeze({ technicians: 10,   documentsStored: 500_000, pagesPerMonth: 5_000 }),
  fleet: Object.freeze({ technicians: null, documentsStored: null,    pagesPerMonth: 10_000 }),
});

/**
 * Add-on entitlements a tenant may hold independently of their plan tier
 * (PLAN_LIMITS, above, caps USAGE per plan; this is a separate yes/no a
 * tenant buys on top). Stored under tenants.limits — the same jsonb column
 * billing_apply() already writes PLAN_LIMITS into on every subscription
 * webhook (M3-config/14-billing.sql) — so no new column/migration is
 * needed: a tenant granted an add-on gets `limits.<key> = true` merged in
 * from its own Stripe subscription item, independent of which base plan
 * they're on. See api/_lib/billing.js's OUTREACH_AUTO_ADDON_LOOKUP_KEY for
 * where that Stripe item is recognized.
 *
 * REQUEST 2b (2026-09-21, owner brief): "Maybe they can add the automated
 * portion that auto-sends if they pay extra." `outreachAuto` gates
 * api/_lib/routes/outreach.js's mode='auto' (unattended nightly sending);
 * mode='review' (Donovan drafts, a human copies/sends) needs no entitlement
 * at all.
 */
export function hasOutreachAutoEntitlement(tenantRow) {
  return tenantRow?.limits?.outreachAuto === true;
}

/** Documents a never-subscribed tenant may ingest and ask about before a
 * trial or subscription is required. */
export const FREE_PREVIEW_DOCUMENTS = 3;

/** Days of full access after a subscription goes `past_due` before it drops
 * to read-only (ask allowed, uploads blocked). */
export const PAST_DUE_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {{billing_status?: string|null, trial_ends_at?: string|Date|null}} tenantRow
 * @param {Date} [now]
 * @returns {'trialing'|'active'|'past_due'|'canceled'|'none'}
 */
export function planStateFor(tenantRow, now = new Date()) {
  const status = tenantRow?.billing_status ?? null;
  if (status === 'trialing') {
    const trialEnd = toDate(tenantRow?.trial_ends_at);
    // A trial Stripe itself hasn't rolled forward yet but whose end date has
    // passed is treated as expired here rather than waiting on the webhook —
    // gating must never depend on webhook delivery timing.
    if (trialEnd && now.getTime() > trialEnd.getTime()) return 'none';
    return 'trialing';
  }
  if (status === 'active') return 'active';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled') return 'canceled';
  return 'none';
}

/** True once a `past_due` tenant is past the grace window (read-only territory). */
export function isPastGrace(tenantRow, now = new Date()) {
  if (planStateFor(tenantRow, now) !== 'past_due') return false;
  // current_period_end is the date the failed invoice was due; grace counts
  // from there, not from whenever the webhook happened to arrive.
  const ref = toDate(tenantRow?.current_period_end) ?? toDate(tenantRow?.trial_ends_at) ?? now;
  return now.getTime() - ref.getTime() > PAST_DUE_GRACE_DAYS * DAY_MS;
}

/**
 * @param {{documentsStored: number}} usage
 * @returns {boolean} true once a never-subscribed tenant has used its free preview
 */
export function freePreviewExhausted(usage) {
  return (Number(usage?.documentsStored) || 0) >= FREE_PREVIEW_DOCUMENTS;
}

/**
 * Gate for POST /api/upload-url (new ingestion).
 * @param {object} tenantRow
 * @param {{documentsStored: number, pagesThisMonth: number}} usage
 * @param {Date} [now]
 * @returns {{allowed: true}|{allowed: false, status: 402, error: string, url: string}}
 */
export function gateUpload(tenantRow, usage, now = new Date()) {
  const state = planStateFor(tenantRow, now);
  const billingUrl = '/app/?screen=billing';

  if (state === 'none') {
    if (freePreviewExhausted(usage)) {
      return { allowed: false, status: 402, error: 'Free preview used up — start your 30-day trial to keep uploading.', url: billingUrl };
    }
    return { allowed: true };
  }
  if (state === 'canceled') {
    return { allowed: false, status: 402, error: 'Subscription required', url: billingUrl };
  }
  if (state === 'past_due' && isPastGrace(tenantRow, now)) {
    return { allowed: false, status: 402, error: 'Subscription required', url: billingUrl };
  }
  // trialing, active, or past_due-within-grace: check the monthly page cap.
  const plan = tenantRow?.plan;
  const cap = PLAN_LIMITS[plan]?.pagesPerMonth ?? null;
  if (cap != null && (Number(usage?.pagesThisMonth) || 0) >= cap) {
    return { allowed: false, status: 402, error: `Monthly page limit reached (${cap}) — upgrade your plan for more.`, url: billingUrl };
  }
  return { allowed: true };
}

/**
 * Gate for POST /api/ask. Ask is read-only in nature, so it stays available
 * through past-due grace AND past-grace — only a never-subscribed tenant that
 * has exhausted its free preview, or a canceled subscription, blocks it.
 * @param {object} tenantRow
 * @param {{documentsStored: number}} usage
 * @param {Date} [now]
 */
export function gateAsk(tenantRow, usage, now = new Date()) {
  const state = planStateFor(tenantRow, now);
  const billingUrl = '/app/?screen=billing';

  if (state === 'none' && freePreviewExhausted(usage)) {
    return { allowed: false, status: 402, error: 'Start your 30-day trial to keep asking questions.', url: billingUrl };
  }
  if (state === 'canceled') {
    return { allowed: false, status: 402, error: 'Subscription required', url: billingUrl };
  }
  return { allowed: true };
}
