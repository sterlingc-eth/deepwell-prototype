/**
 * Subscription gating: what state a tenant's billing is in, and what that
 * state permits on upload-url, ask, v1-ingest, read-document, extract, and
 * review's model-calling actions. Every function down to requireActiveBilling
 * is pure — no database, no Stripe — so scripts/verify-billing.mjs can test
 * every branch with fixture tenant rows. assertActiveBilling (bottom of the
 * file) is the one deliberate exception: it fetches the tenant row itself, so
 * the three routes with no bespoke gate wrapper of their own (read-document,
 * extract, review) don't each need to reimplement that query. The exact
 * rules this file implements are written out in handoffs/BILLING_RULES.md;
 * keep the two in sync.
 */
import { getTenantContext } from './recordsStore.js';
import { resetsOnLabel } from './usage.js';
import { TTLCache, memoAsync, logStage, registerTenantCache } from './perf.js';

/** Per-plan caps, written to tenants.limits by billing_apply() on every
 * subscription create/update webhook. Exported so api/_lib/billing.js's
 * webhook handler and scripts/verify-billing.mjs share one source of truth.
 * `null` = uncapped (Fleet has no seat/document ceiling; its own page cap is
 * a real number because it's what deep-storage overage would be sold against
 * later, per the brief).
 *
 * asksPerMonth (owner decision, 2026-09-21): replaces the old flat daily ask
 * cap (rateLimit.js's PLAN_DAILY_ASKS) with a monthly allowance shown as a %
 * meter that resets the 1st UTC — "techs don't work every day," so a hard
 * daily number punished a shop that asks 200 questions on a busy Monday and
 * zero over the weekend even though its monthly total was fine. The old
 * daily cap still exists underneath as a runaway guard (30% of this number —
 * see rateLimit.js's scaleDailyLimitForPlan), not a separate budget. */
export const PLAN_LIMITS = Object.freeze({
  solo:  Object.freeze({ technicians: 1,    documentsStored: 25_000,  pagesPerMonth: 750,    asksPerMonth: 3_000 }),
  shop:  Object.freeze({ technicians: 4,    documentsStored: 100_000, pagesPerMonth: 2_000,  asksPerMonth: 9_000 }),
  crew:  Object.freeze({ technicians: 10,   documentsStored: 500_000, pagesPerMonth: 5_000,  asksPerMonth: 22_500 }),
  fleet: Object.freeze({ technicians: null, documentsStored: null,    pagesPerMonth: 10_000, asksPerMonth: 60_000 }),
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
 * trial or subscription is required. HARD GATE (owner decision, 2026-09-21):
 * no free preview any more — a tenant with no subscription is blocked at
 * upload #1 and question #1, same as a canceled one. The client mirrors this
 * by showing ONLY Billing for a 'none'/'canceled' tenant (src/App.tsx), but
 * this constant is what actually enforces it — kept at 0 rather than removed
 * so freePreviewExhausted/gateUpload/gateAsk below don't need their own
 * separate "no preview at all" branch. */
export const FREE_PREVIEW_DOCUMENTS = 0;

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
 * The shared HARD GATE (owner decision, 2026-09-21): does this tenant have
 * ANY active billing relationship at all, ignoring usage entirely? 'none' or
 * 'canceled' blocks; every other state (trialing/active/past_due — including
 * past_due PAST grace, which upload's own gate below still reports with its
 * own stricter "Subscription required" message where that distinction
 * matters) is allowed here. This is the one decision gateUpload, gateAsk,
 * and every model-costing route below all need identically, so it lives in
 * exactly one place rather than four copies of the same message string.
 * @param {object} tenantRow
 * @param {Date} [now]
 * @returns {{allowed: true}|{allowed: false, status: 402, error: string, url: string}}
 */
export function requireActiveBilling(tenantRow, now = new Date()) {
  const state = planStateFor(tenantRow, now);
  if (state === 'none' || state === 'canceled') {
    return { allowed: false, status: 402, error: 'Choose a plan to get started', url: '/app/?screen=billing' };
  }
  return { allowed: true };
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
      return requireActiveBilling(tenantRow, now);
    }
    return { allowed: true };
  }
  if (state === 'canceled') {
    return requireActiveBilling(tenantRow, now);
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
 * Layered on top of that (owner decision, 2026-09-21): a plan-sized MONTHLY
 * question allowance, independent of subscription health — trialing, active,
 * and past_due (grace or not) all get gated by it identically, since it is a
 * usage cap, not a billing-health one.
 * @param {object} tenantRow
 * @param {{documentsStored: number, asksThisMonth?: number}} usage
 * @param {Date} [now]
 */
export function gateAsk(tenantRow, usage, now = new Date()) {
  const state = planStateFor(tenantRow, now);

  if ((state === 'none' && freePreviewExhausted(usage)) || state === 'canceled') {
    return requireActiveBilling(tenantRow, now);
  }

  const cap = PLAN_LIMITS[tenantRow?.plan]?.asksPerMonth ?? null;
  if (cap != null && (Number(usage?.asksThisMonth) || 0) >= cap) {
    // Owner correction (2026-09-21): never say "questions" — a customer may
    // just be requesting information, not "asking" in a way that should feel
    // metered. "Donovan usage" reads as a feature name using up its
    // allowance, not the customer being counted.
    return {
      allowed: false,
      status: 402,
      error: `This month's Donovan usage is used up — resets ${resetsOnLabel(now)}`,
      url: '/app/?screen=billing',
    };
  }
  return { allowed: true };
}

/**
 * API_PERF_2026-09-22: billing-gate row cache, DELIBERATELY separate from
 * recordsStore.js's 5-minute getTenantContext cache (getCachedBillingRow
 * reads THROUGH that cache below, but re-keys its own, shorter-lived entry
 * on top of it). requireActiveBilling's whole job is noticing a subscription
 * has gone 'none'/'canceled', so this cache cannot use a 5-minute blind spot
 * — that would mean a tenant who cancels keeps full access for up to five
 * more minutes. 2 minutes for every other state (trialing/active/past_due);
 * 30 seconds once the cached state IS 'none' or 'canceled' — long enough to
 * spare the database under load, short enough that reactivating a plan (or a
 * fixed payment method putting it back to 'active') takes effect within half
 * a minute rather than five.
 *
 * Shared by assertActiveBilling (below) and upload-url.js's checkUploadGate —
 * see each call site — so two gates checking the same tenant in the same
 * request never run this lookup twice.
 */
export const BILLING_ROW_TTL_MS = 2 * 60_000;
export const BILLING_ROW_BLOCKED_TTL_MS = 30_000;
const billingRowCache = new TTLCache(BILLING_ROW_TTL_MS, 1000);
registerTenantCache(billingRowCache);

async function fetchBillingRow(ctx) {
  const t = await getTenantContext(ctx.tenantKey, ctx.tenantName ?? ctx.tenantKey);
  return { plan: t.plan, billing_status: t.billingStatus, trial_ends_at: t.trialEndsAt, current_period_end: t.currentPeriodEnd };
}

/**
 * Pure: which TTL a just-fetched billing row should be cached under. Split
 * out from getCachedBillingRow so scripts/verify-perf.mjs can assert the
 * 'none'/'canceled' -> short-TTL rule directly, with no database and no
 * cache object involved.
 * @param {{billing_status?: string|null, trial_ends_at?: *}} row
 * @param {Date} [now]
 */
export function billingCacheTtlFor(row, now = new Date()) {
  const state = planStateFor(row, now);
  return state === 'none' || state === 'canceled' ? BILLING_ROW_BLOCKED_TTL_MS : BILLING_ROW_TTL_MS;
}

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @returns {Promise<{plan?: string|null, billing_status?: string|null, trial_ends_at?: *, current_period_end?: *}>}
 */
export async function getCachedBillingRow(ctx) {
  const tenantKey = ctx?.tenantKey;
  if (!tenantKey) return {};
  const start = Date.now();
  const hit = billingRowCache.get(tenantKey) !== undefined;
  const row = await memoAsync(billingRowCache, tenantKey, () => fetchBillingRow(ctx), BILLING_ROW_TTL_MS);
  if (!hit) {
    // A freshly-fetched BLOCKED state is re-capped to the short TTL right
    // away, rather than left to expire on the normal 2-minute schedule — see
    // this cache's own doc comment for why 'none'/'canceled' can't wait that
    // long.
    const ttl = billingCacheTtlFor(row);
    if (ttl === BILLING_ROW_BLOCKED_TTL_MS) billingRowCache.set(tenantKey, row, ttl);
  }
  logStage({ t: 'billing_gate_row', ms: Date.now() - start, cacheHit: hit });
  return row;
}

/** Test-only: clear the billing row cache between fixtures. */
export function _resetBillingRowCache() {
  billingRowCache.map.clear();
}

/** Test-only: seed a row directly, bypassing getTenantContext/the database —
 *  scripts/verify-perf.mjs uses this to exercise the cache-bust path without
 *  a live Postgres connection. */
export function _seedBillingRowForTest(tenantKey, row, ttlMs = BILLING_ROW_TTL_MS) {
  billingRowCache.set(tenantKey, row, ttlMs);
}

/** Test-only: read a tenant's raw cache entry (undefined if absent/expired),
 *  with no fetch-on-miss — the read side of _seedBillingRowForTest. */
export function _peekBillingRowForTest(tenantKey) {
  return billingRowCache.get(tenantKey);
}

/**
 * DB-touching sibling of requireActiveBilling(), for routes that have no
 * bespoke gate wrapper of their own: read-document.js, extract.js, and
 * review.js's model-calling actions (reclassify). upload-url.js and ask.js
 * keep their own checkUploadGate/checkAskGate wrappers instead of this one
 * because gateUpload/gateAsk need `usage` for page-cap math this function
 * doesn't do — but both of those call requireActiveBilling() above for the
 * exact same 'none'/'canceled' decision, so the rule itself still lives
 * once.
 *
 * FAILS CLOSED — the opposite of every other gate in this file, and of
 * api/_lib/rateLimit.js's assertModelBudget. Those fail open because a
 * broken lookup degrading to "allow" only ever costs a few cents of
 * additional Anthropic spend on an ALREADY-PAYING tenant. This function
 * guards the routes that would otherwise let a tenant with NO active
 * subscription keep spending real Anthropic-billed model calls indefinitely
 * if the billing lookup itself were ever the thing that broke — so a lookup
 * failure here returns a 503 instead of quietly running the model.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {Date} [now]
 * @returns {Promise<
 *   {allowed: true} |
 *   {allowed: false, status: 402, error: string, url: string} |
 *   {allowed: false, status: 503, error: string}
 * >}
 */
export async function assertActiveBilling(ctx, now = new Date()) {
  try {
    // API_PERF_2026-09-22: used to open its OWN withTenant transaction just to
    // run this one SELECT — a full BEGIN/resolve_tenant/SET LOCAL/COMMIT round
    // trip for a single read. getCachedBillingRow shares its cache (and TTL
    // rule — see the cache's own doc comment) with upload-url.js's
    // checkUploadGate, so two routes gating the same request no longer each
    // pay for this lookup, and a warm cache hit costs nothing at all.
    const row = await getCachedBillingRow(ctx);
    return requireActiveBilling(row, now);
  } catch (err) {
    console.error('billing gate failed CLOSED (assertActiveBilling):', err?.message);
    return { allowed: false, status: 503, error: 'Billing check unavailable, try again' };
  }
}
