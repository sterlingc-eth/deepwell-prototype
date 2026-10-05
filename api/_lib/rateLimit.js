/**
 * Rate limiting and daily spend caps.
 *
 * There is no rate limit anywhere in this API today. Any signed-in user can
 * loop /api/ask or upload uniquely-hashed files forever and run up the
 * Anthropic bill; nothing per-tenant bounds it. This adds two layers, BOTH in
 * Postgres, shared across every Vercel instance:
 *
 *   1. A per-minute BURST limit (rate_limit_windows, M3-config/12-rate-limit-
 *      window.sql). Used to be an in-memory sliding window, per Vercel
 *      instance — soft, and it never actually engaged under the burst it was
 *      meant to catch: a serverless deployment runs several instances at
 *      once, each with its own counters, so the real ceiling was
 *      instanceCount x perMinute, not perMinute. A fixed one-minute window in
 *      Postgres (one atomic upsert per call, same shape as #2 below) is
 *      exact instead: coarser at the minute boundary than a true sliding
 *      window, but a real, shared ceiling rather than one that only holds
 *      inside a single warm instance.
 *
 *   2. A per-day HARD cap, in Postgres (usage_counters). This is the real
 *      ceiling: whatever the burst limit lets through, the daily count is
 *      exact and global, and this is what actually bounds the Anthropic bill
 *      for a tenant that loops all day across many cold starts.
 *
 * Both are keyed by (tenantId, bucket) — 'ask', 'ingest', 'read' — so a
 * tenant hammering /api/extract does not also throttle their own
 * /api/warranty-attention calls. Both cost exactly one query per request
 * (increment_rate_limit_window / increment_usage_counters), same as before.
 *
 * Limits are configurable via RATE_LIMIT_<BUCKET>_PER_MINUTE /
 * RATE_LIMIT_<BUCKET>_PER_DAY env vars (see envLimits()), layered under the
 * existing per-tenant override (tenants.limits) and the caller-supplied
 * `overrides` argument — same precedence as before, just with a third,
 * lowest-priority layer added underneath.
 */
import { getAuxPool } from "./apiKeyAuth.js";
import { PLAN_LIMITS, DONOVAN_SAFETY, DONOVAN_SAFETY_MESSAGE, staffImportFor, noteDatabaseClock } from "./plan.js";
import { getTenantContext } from "./recordsStore.js";
import { logStage } from "./perf.js";

/**
 * bucket -> defaults. Overridable per tenant via tenants.limits (see below).
 *
 * `ingest`'s perDay was 300 back when every call to limit(req, res, auth,
 * "ingest") cost exactly 1 unit, whatever it actually did. It no longer does
 * (see `cost` on `limit()` below) — a batch presign of 50 files now costs 50,
 * not 1 — so the same counter that used to mean "ingest HTTP calls today" now
 * means "ingest units (roughly: files/pages) today". 2000/day is this
 * build's Team-plan-sized default for that meaning, not a tweak of the old
 * one; a tenant that needs a different number gets it via tenants.limits.
 * ingest.perDay, the same override mechanism every bucket already had.
 */
export const DEFAULT_LIMITS = Object.freeze({
  // Round 26: Donovan is unlimited on every plan, so this is NOT a plan allowance — it is the hidden,
  // plan-independent runaway/abuse ceiling (plan.js DONOVAN_SAFETY). Env: RATE_LIMIT_ASK_PER_DAY.
  ask:     { perMinute: 20,  perDay: DONOVAN_SAFETY.perDay },
  ingest:  { perMinute: 60,  perDay: 2000 },
  read:    { perMinute: 120, perDay: 5000 },
  // R22 (S1, security audit): api/billing.js's checkout/portal actions each make a real call to
  // Stripe (CreateCustomer/CreateCheckoutSession/CreatePortalSession) on nothing but a valid Clerk
  // session — no per-tenant cap existed before this, so an authenticated caller (any solo tenant, or
  // any shop admin) could loop it and either burn the account's shared Stripe API rate limit for
  // every tenant or spam abandoned Checkout/Portal Sessions. Sized generously for a human clicking
  // "Upgrade"/"Manage billing" a few times while comparing plans, nowhere near what a real workflow
  // needs in a day.
  billing: { perMinute: 6,   perDay: 60 },
  // Round 28: the Support Assistant's OWN bucket (api/_lib/support/limits.js), per signed-in user. It never
  // touches `ask`, so chatting with support cannot spend Donovan's allowance. Env: RATE_LIMIT_SUPPORT_PER_MINUTE/DAY.
  support: { perMinute: 8,   perDay: 200 },
});

/** Fixed window size for the burst limiter. Exported so callers/tests can
 *  reason about it without a magic number. */
export const WINDOW_MS = 60_000;

/** Pure: floor `now` (ms epoch) to the start of its fixed WINDOW_MS window.
 *  Exported for bucket-math tests (scripts/verify-apikeys.mjs) with no clock
 *  and no database. */
export function minuteWindowStart(now = Date.now()) {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

/** Pure: whole seconds (>=1) until the window AFTER `windowStartMs` begins,
 *  measured from `now` — what a blocked request's Retry-After header should
 *  say. Rounds up: a caller retrying at the exact boundary must still land
 *  in the next window, not one tick early. */
export function secondsUntilNextWindow(now, windowStartMs) {
  return Math.max(1, Math.ceil((windowStartMs + WINDOW_MS - now) / 1000));
}

/** Pure: does the running total AFTER this call's units were added exceed
 *  `perMinute`? `unitsAfterIncrement` is exactly what
 *  increment_rate_limit_window()'s atomic upsert returns — the total, not
 *  this call's own units alone — so this is a plain comparison, not a
 *  re-derivation of a sum from parts this function never sees. */
export function exceedsPerMinute(unitsAfterIncrement, perMinute) {
  return Number(unitsAfterIncrement) > Number(perMinute);
}

/** Pure (R30 H2): the rate_limit_windows bucket name for a bucket's DAILY counter. Distinct from the per-minute
 *  bucket (`ingest`) and from every other special bucket (`ask_month`, `support_*`). */
export function dailyBucketKey(bucket) {
  return `day:${String(bucket)}`;
}

/** Pure (R30 H2): the UTC midnight that starts `now`'s day, as an ISO string (the daily window_start). */
export function utcDayStartIso(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Parse one RATE_LIMIT_<BUCKET>_PER_(MINUTE|DAY) env var: a positive finite
 *  number, or undefined for anything else (unset, blank, zero, negative,
 *  non-numeric) — so a bad env value falls back to the hardcoded default
 *  rather than disabling the cap (0 units/day would refuse every request) or
 *  accepting garbage (NaN comparisons are always false, i.e. "no limit"). */
export function parseLimitEnv(raw) {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * DEFAULT_LIMITS[bucket], with RATE_LIMIT_<BUCKET>_PER_MINUTE /
 * RATE_LIMIT_<BUCKET>_PER_DAY env vars layered on top. This is the BASE that
 * resolveLimits() below further layers a per-tenant override, then a
 * caller-supplied override, onto — env is the lowest-priority, deployment-
 * wide layer, not a replacement for either of those.
 *
 * Pure aside from reading `env` (defaulted to `process.env`, overridable so
 * this is testable with a plain object — see scripts/verify-apikeys.mjs).
 */
export function envLimits(bucket, env = process.env) {
  const base = DEFAULT_LIMITS[bucket] ?? DEFAULT_LIMITS.read;
  const key = String(bucket ?? "").toUpperCase();
  return {
    perMinute: parseLimitEnv(env[`RATE_LIMIT_${key}_PER_MINUTE`]) ?? base.perMinute,
    perDay: parseLimitEnv(env[`RATE_LIMIT_${key}_PER_DAY`]) ?? base.perDay,
  };
}

/**
 * Merge envLimits(bucket) with any per-tenant override found at
 * tenants.limits->bucket (see M3-config/10-api-keys.sql's `limits` column),
 * then any caller-supplied override. Only perMinute/perDay keys are honored;
 * anything else in an override is ignored rather than trusted blindly.
 */
/**
 * Per-plan scaling of the INGEST daily default only. (Round 26: the ask
 * bucket is no longer plan-scaled — Donovan is unlimited on every plan; its
 * daily value is the flat hidden safety ceiling DEFAULT_LIMITS.ask.perDay,
 * plan.js DONOVAN_SAFETY.) Keyed on the PLAN_LIMITS shape billing_apply()
 * stores under tenants.limits (pagesPerMonth 750/2000/5000/10000 identifies
 * the tier without a new column). An explicit `limits.<bucket>.perDay`
 * override on the tenant still wins over all of this.
 */
const PLAN_BY_PAGES = Object.freeze(
  Object.fromEntries(Object.entries(PLAN_LIMITS).map(([tier, l]) => [l.pagesPerMonth, tier]))
);
const PLAN_INGEST_MULTIPLIER = Object.freeze({ solo: 1, shop: 2.5, crew: 6, fleet: 12 });

/** R35: per-MINUTE plan multipliers. ingest follows the daily multipliers (a Crew shop bulk-importing with several
 *  people on phones must not starve behind a Solo-sized 60/min bucket that every user in the tenant shares); ask
 *  scales more gently (a person asks ~1/min - the bucket is a burst guard, not an allowance). */
const PLAN_ASK_MINUTE_MULTIPLIER = Object.freeze({ solo: 1, shop: 2, crew: 4, fleet: 6 });

/** Pure: which plan tier a tenants.limits row describes, or null. */
export function planTierFromLimits(tenantLimits) {
  if (tenantLimits?.plan && Object.prototype.hasOwnProperty.call(PLAN_LIMITS, tenantLimits.plan)) return tenantLimits.plan;
  const pages = Number(tenantLimits?.pagesPerMonth);
  return PLAN_BY_PAGES[pages] ?? null;
}

/**
 * Pure: the daily ceiling for a bucket given the tenant's plan. Unknown /
 * missing plan -> the conservative Solo-sized default.
 * @param {string} bucket 'ask' | 'ingest' | 'read'
 * @param {number} baseDaily DEFAULT_LIMITS[bucket].perDay
 * @param {{pagesPerMonth?: number|null, plan?: string}|null|undefined} tenantLimits
 */
export function scaleDailyLimitForPlan(bucket, baseDaily, tenantLimits) {
  if (bucket === 'ask') return baseDaily;
  const tier = planTierFromLimits(tenantLimits);
  if (!tier || !Number.isFinite(baseDaily)) return baseDaily;
  return Math.round(baseDaily * (PLAN_INGEST_MULTIPLIER[tier] ?? 1));
}

/** Pure (R35): the per-minute burst ceiling for a bucket given the tenant's plan. Only ingest and ask scale. */
export function scaleMinuteLimitForPlan(bucket, basePerMinute, tenantLimits) {
  if (!Number.isFinite(basePerMinute)) return basePerMinute;
  const tier = planTierFromLimits(tenantLimits);
  if (!tier) return basePerMinute;
  if (bucket === 'ingest') return Math.round(basePerMinute * (PLAN_INGEST_MULTIPLIER[tier] ?? 1));
  if (bucket === 'ask') return Math.round(basePerMinute * (PLAN_ASK_MINUTE_MULTIPLIER[tier] ?? 1));
  return basePerMinute;
}

/**
 * Pure: given a tenant's already-fetched `limits` jsonb (get_tenant_limits()'s
 * shape — see M3-config/24), work out perMinute/perDay for `bucket`. Split out
 * from the old resolveLimits() (API_PERF_2026-09-22) so the DB round trip that
 * used to happen HERE now happens once, cached, in recordsStore.js's
 * getTenantContext() instead — this function itself makes no DB call and
 * never fails, so it needs no try/catch of its own.
 */
export function limitsFromTenantContext(tenantLimits, bucket, overrides) {
  const base = envLimits(bucket);
  const tenantOverride = tenantLimits?.[bucket] ?? {};
  const callerOverride = overrides ?? {};
  // Plan-sized INGEST daily ceilings (ask is flat — see scaleDailyLimitForPlan). An explicit
  // `limits.<bucket>.perDay` override on the tenant still wins.
  const scaled = scaleDailyLimitForPlan(bucket, base.perDay, tenantLimits);
  // R35: an explicit RATE_LIMIT_<BUCKET>_PER_MINUTE env value is the operator's deployment-wide choice and is NOT
  // multiplied by plan; only the built-in default scales.
  const envPinned = parseLimitEnv(process.env[`RATE_LIMIT_${String(bucket).toUpperCase()}_PER_MINUTE`]) !== undefined;
  const scaledMinute = envPinned ? base.perMinute : scaleMinuteLimitForPlan(bucket, base.perMinute, tenantLimits);
  // R43: an ACTIVE staff import (tenants.limits.staffImport) may name bigger ingest ceilings; an explicit
  // limits.ingest override still wins, and once the import expires or is ended the plan's own numbers apply again.
  const imp = bucket === "ingest" ? staffImportFor({ limits: tenantLimits }) : null;
  const importMinute = imp?.active ? imp.ingestPerMinute : null;
  const importDay = imp?.active ? imp.ingestPerDay : null;
  return {
    perMinute: Number.isFinite(callerOverride.perMinute)
      ? callerOverride.perMinute
      : Number.isFinite(tenantOverride.perMinute) ? tenantOverride.perMinute : (importMinute ?? scaledMinute),
    perDay: Number.isFinite(callerOverride.perDay)
      ? callerOverride.perDay
      : Number.isFinite(tenantOverride.perDay) ? tenantOverride.perDay : (importDay ?? scaled),
  };
}

/**
 * Resolve a tenantKey (Clerk org id, or `user_${id}` — see auth.js /
 * apiKeyAuth.js) to {tenantUuid, limits} in ONE call — API_PERF_2026-09-22:
 * this used to be two separate round trips (resolve_tenant, then
 * get_tenant_limits), each its own try/catch. Both now come from
 * recordsStore.js's getTenantContext(), which is itself cached 5 minutes per
 * warm instance (see its own doc comment) and shared with withTenant() and
 * plan.js, so the common case — a tenant this instance has already seen in
 * the last 5 minutes — costs zero DB round trips here.
 *
 * FAILS OPEN, same contract the two functions this replaces both had: a
 * lookup failure must never be the reason a legitimate request is refused,
 * and must never be the reason a limit silently stops applying either.
 */
async function resolveTenantAndLimits(tenantKey, bucket, overrides) {
  const base = envLimits(bucket);
  if (typeof tenantKey !== "string" || !tenantKey.trim()) return { tenantUuid: null, limits: base };
  try {
    const ctx = await getTenantContext(tenantKey, tenantKey);
    // A blank id must never reach increment_*() as a uuid parameter.
    if (typeof ctx?.id !== "string" || !ctx.id.trim()) return { tenantUuid: null, limits: base };
    return { tenantUuid: ctx.id, limits: limitsFromTenantContext(ctx.limits, bucket, overrides) };
  } catch (err) {
    console.error("rateLimit: could not resolve tenant/limits, using defaults:", err?.message);
    return { tenantUuid: null, limits: base };
  }
}

function send429(res, retryAfterSeconds, body) {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.status(429).json({ error: "Too many requests", ...body });
}

/** Pure: whole seconds from `now` until the next UTC-midnight reset — the
 *  daily counters' own reset point, and (via getDailyModelBudgetStatus below)
 *  the same "resumes tomorrow" boundary the model-spend budget uses. Exported
 *  so both the request-rate daily cap and the model-spend budget compute the
 *  same number the same way, and so it's testable with no clock. */
export function secondsUntilUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

/**
 * Enforce the rate limit for one request. Call this AFTER auth has resolved
 * (`auth` is whatever requireAuthOrKey() returned) and BEFORE doing any real
 * work.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{tenantId: string}} auth        auth.tenantId is a tenantKey (see apiKeyAuth.js), not a uuid
 * @param {'ask'|'ingest'|'read'} bucket
 * @param {{perMinute?: number, perDay?: number}} [overrides]  caller-supplied override, takes precedence over the tenant's own
 * @param {number} [cost]  how many units this one call is worth against both
 *   the burst window and the daily cap. Default 1, matching every existing
 *   call site's behavior unchanged. A batch endpoint that does the work of N
 *   ordinary calls in one HTTP request (upload-url.js's batch presign,
 *   currently the one caller of this) should pass N here — otherwise a batch
 *   of 50 files spends exactly the same 1 unit a single-file call would,
 *   which undercounts the real daily ingest volume by up to 50x. Must be a
 *   positive integer; anything else (0, negative, NaN, undefined) is treated
 *   as 1.
 * @returns {Promise<boolean>} true if the request may proceed. false means a
 *          429 has ALREADY been written to `res` — the caller must return
 *          immediately without writing anything else.
 */
// A missing migration or a dead counter would otherwise log on every request
// until fixed. One line per (table, message) per instance per 10 minutes.
const LOG_EVERY_MS = 10 * 60 * 1000;
const lastLogged = new Map();
// Exported (2026-09-20) so api/_lib/askCache.js can use the same "log once
// per 10 min per (table, message)" throttle for its own missing-table case
// (ask_answer_cache, before the owner pastes M3-config/17-*.sql) instead of
// keeping a second copy of this Map.
export function logOnce(table, err) {
  const key = `${table}:${err?.message ?? ""}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? 0) + LOG_EVERY_MS > now) return;
  lastLogged.set(key, now);
  console.error(`rateLimit: could not update ${table} (failing open; repeated once per 10 min):`, err?.message);
}

/** R35: give back units a request was DENIED for. Before this, a denied call still stayed in the window total, so a
 *  client retrying a 429 kept the whole shop's bucket pinned (and a 50-file batch denied once poisoned the minute for
 *  every other user in the tenant). Needs M3-config/62-rate-limit-refund.sql; on the old function the negative units
 *  clamp to 0 so this is a harmless no-op, never an error. Best-effort: never throws. */
async function refund(tenantUuid, bucketKey, windowStartIso, units) {
  try {
    await getAuxPool().query("SELECT increment_rate_limit_window($1, $2, $3::timestamptz, $4)", [tenantUuid, bucketKey, windowStartIso, -units]);
  } catch (err) {
    logOnce("rate_limit_windows", err);
  }
}

/** Pure (R35): one signed-in user's share of the tenant's ask burst bucket, so one runaway tab cannot eat everyone's. */
export function perUserAskPerMinute(tenantPerMinute) {
  return Math.max(6, Math.ceil(Number(tenantPerMinute) / 2));
}

/**
 * FIX 3 (DC3b): what limit() charged a request, keyed by the request object, so the code that later refuses it with a PLAN
 * 402 (document / monthly page / import cap, billing state) can hand the unit back. A 402 is not abuse of the endpoint, it is a
 * customer at a cap. Never used for 400/413 validation errors or 429s.
 */
const chargeReceipts = new WeakMap();

/** How many plan-refused units per tenant, bucket and minute are handed back. Beyond this they stay spent (see below). */
export const PLAN_REFUND_UNITS_PER_MINUTE = 20;

/**
 * Hand back the rate-limit units (per-minute window AND daily counter) of a request the plan gate refused with 402.
 *
 * Abuse bound: the hand-back is capped at PLAN_REFUND_UNITS_PER_MINUTE units per tenant/bucket/minute, counted in a shared
 * Postgres counter (bucket `refused:<bucket>`, same atomic function and per-minute window as the burst limiter, so it is exact
 * across instances). Past the cap a refused request keeps its unit, so a flood of 402-refused requests is still stopped by
 * the per-minute window (at most perMinute + the cap requests per minute reach the gate) and by the daily cap. If the counter
 * cannot be read, nothing is handed back (fails to the stricter side). The receipt is single-use.
 *
 * @returns {Promise<boolean>} true when the units were handed back
 */
export async function refundPlanRefusal(req) {
  const r = req && typeof req === "object" ? chargeReceipts.get(req) : null;
  if (!r) return false;
  chargeReceipts.delete(req);
  try {
    const { rows } = await getAuxPool().query(
      "SELECT increment_rate_limit_window($1, $2, $3::timestamptz, $4) AS units",
      [r.tenantUuid, `refused:${r.bucket}`, r.minuteIso, r.units]
    );
    const used = Number(rows[0]?.units);
    if (!Number.isFinite(used) || used > PLAN_REFUND_UNITS_PER_MINUTE) return false;
  } catch (err) {
    logOnce("rate_limit_windows", err);
    return false;
  }
  await Promise.all([
    refund(r.tenantUuid, r.bucket, r.minuteIso, r.units),
    refund(r.tenantUuid, dailyBucketKey(r.bucket), r.dayIso, r.units),
  ]);
  return true;
}

export async function limit(req, res, auth, bucket, overrides, cost) {
  const tenantKey = auth?.tenantId;
  // Auth resolved but produced no tenant identity: there is nothing to meter
  // and nothing safe to do — answer 401 (never fail open, never hit SQL with "").
  if (typeof tenantKey !== "string" || !tenantKey.trim()) {
    res.status(401).json({ error: "Sign in required" });
    return false;
  }
  const now = Date.now();
  const units = Number.isFinite(cost) && cost > 0 ? Math.trunc(cost) : 1;
  const stageStart = now;

  const { tenantUuid, limits } = await resolveTenantAndLimits(tenantKey, bucket, overrides);
  logStage({ t: "ratelimit_resolve", bucket, ms: Date.now() - stageStart });

  // A tenant that could not be resolved (a transient DB error — resolve_tenant
  // itself upserts a row on first sight, so this is not the ordinary case)
  // fails open on BOTH checks below, same principle as resolveLimits: a
  // lookup failure must never be the reason a legitimate request is refused.

  // ---- 1. burst: Postgres, exact, shared across every instance ----------
  if (tenantUuid) {
    const windowStartMs = minuteWindowStart(now);
    try {
      const { rows } = await getAuxPool().query(
        "SELECT increment_rate_limit_window($1, $2, $3::timestamptz, $4) AS units",
        [tenantUuid, bucket, new Date(windowStartMs).toISOString(), units]
      );
      const unitsThisWindow = rows[0]?.units;
      if (unitsThisWindow != null && exceedsPerMinute(unitsThisWindow, limits.perMinute)) {
        await refund(tenantUuid, bucket, new Date(windowStartMs).toISOString(), units);
        send429(res, secondsUntilNextWindow(now, windowStartMs), {
          details: `More than ${limits.perMinute} ${bucket} units in the last minute.`,
          scope: "per-minute",
        });
        return false;
      }
    } catch (err) {
      // Same principle as resolveLimits: a broken counter must not either
      // silently disable the cap or wrongly block every request. Log and let
      // the (still-enforced) daily cap below be the only gate this time.
      logOnce("rate_limit_windows", err);
    }
  }

  // ---- 1b. R35: per-user fairness for Donovan (ask) -----------------------------------------------------------
  // The ask bucket is shared by every signed-in user of the tenant. Without this, one looping client could spend
  // the whole shop's per-minute budget. Keyed by user id (never by API key - keys have no user). Fails open.
  if (tenantUuid && bucket === "ask" && !auth?.viaKey && typeof auth?.userId === "string" && auth.userId) {
    const windowStartMs = minuteWindowStart(now);
    const userBucket = `ask_u:${auth.userId.slice(0, 48)}`;
    try {
      const { rows } = await getAuxPool().query(
        "SELECT increment_rate_limit_window($1, $2, $3::timestamptz, $4) AS units",
        [tenantUuid, userBucket, new Date(windowStartMs).toISOString(), units]
      );
      const perUser = perUserAskPerMinute(limits.perMinute);
      if (rows[0]?.units != null && exceedsPerMinute(rows[0].units, perUser)) {
        await refund(tenantUuid, userBucket, new Date(windowStartMs).toISOString(), units);
        await refund(tenantUuid, bucket, new Date(windowStartMs).toISOString(), units);
        send429(res, secondsUntilNextWindow(now, windowStartMs), {
          details: `More than ${perUser} questions from one person in the last minute. Give it a moment.`,
          scope: "per-user",
        });
        return false;
      }
    } catch (err) {
      logOnce("rate_limit_windows", err);
    }
  }

  // ---- 2. daily hard cap: Postgres, exact, shared across every instance --
  // R30 H2: the daily count is PER BUCKET. It used to read usage_counters.requests, which has no bucket dimension
  // (every ask, read, poll and upload adds to it), and compare that shared total to THIS bucket's perDay - so
  // ~60 unrelated requests in a UTC day locked checkout/portal/invite out (billing perDay 60), and ingest's 2000
  // was spent by asks. Now: rate_limit_windows (same table + atomic upsert function as the burst limiter, no schema
  // change) keyed by bucket `day:<bucket>` with window_start = the UTC midnight. increment_rate_limit_window()
  // deletes that bucket's OLDER windows, so old days clean themselves up, and the new keys start at zero on
  // deploy - yesterday's shared counter can never block anyone. usage_counters.requests is still incremented, for
  // usage reporting only (getUsage), and is never compared to a limit.
  if (tenantUuid) {
    const today = new Date(now).toISOString().slice(0, 10);
    let requestsToday = null;
    // FIX 3 (RU1): the per-bucket daily counter is read FIRST and usage_counters.requests (report-only) is bumped only for
    // a request that is let through, so a request refused by the daily cap no longer shows up in the usage report. (They
    // used to run side by side; usage_counters cannot be decremented, so a refusal could not take its unit back.)
    try {
      const { rows } = await getAuxPool().query(
        "SELECT increment_rate_limit_window($1, $2, $3::timestamptz, $4) AS units",
        [tenantUuid, dailyBucketKey(bucket), utcDayStartIso(now), units]
      );
      requestsToday = rows[0]?.units ?? null;
    } catch (err) {
      logOnce("rate_limit_windows", err);
    }

    if (requestsToday != null && Number(requestsToday) > limits.perDay) {
      // R35: the denied units come back out of the rate-limit counters so the 429 itself does not eat tomorrow-bound budget
      // or the minute window of the other people in the shop.
      await Promise.all([
        refund(tenantUuid, dailyBucketKey(bucket), utcDayStartIso(now), units),
        refund(tenantUuid, bucket, new Date(minuteWindowStart(now)).toISOString(), units),
      ]);
      // Donovan's daily ceiling is the hidden safety net, never a plan limit: polite, no "upgrade".
      send429(
        res,
        secondsUntilUtcMidnight(now),
        bucket === "ask"
          ? { error: DONOVAN_SAFETY_MESSAGE, scope: "safety" }
          : { details: `Daily limit of ${limits.perDay} ${bucket} units reached for this tenant.`, scope: "per-day" }
      );
      return false;
    }
    try {
      await getAuxPool().query("SELECT * FROM increment_usage_counters($1, $2::date, $3, 0, 0, 0)", [tenantUuid, today, units]);
    } catch (err) {
      logOnce("usage_counters", err);
    }
    // Remember what this request was charged, so a later plan-gate refusal (402) can hand the unit back (refundPlanRefusal).
    if (req && typeof req === "object") {
      chargeReceipts.set(req, { tenantUuid, bucket, units, minuteIso: new Date(minuteWindowStart(now)).toISOString(), dayIso: utcDayStartIso(now) });
    }
  }

  logStage({ t: "ratelimit", bucket, ms: Date.now() - stageStart });
  return true;
}

/**
 * A tenant's daily ceiling on actual model spend, e.g.
 * `{"maxModelCallsPerDay": 500}` under tenants.limits. Independent of the
 * `ingest` bucket's perDay above: that bucket is a per-ROUTE, per-HTTP-call
 * cap enforced before a document is even uploaded; this is a whole-tenant cap
 * on `usage_counters.model_calls` — the number Anthropic actually billed for
 * today, whichever route produced it (ask, ingest, or extract all share this
 * counter — see usage.js's recordModelCall). Sized for a Team plan by
 * default, same order of magnitude as DEFAULT_LIMITS.ingest.perDay for the
 * same reason (roughly one model call per page), but checked as its own
 * number since a document with several flagged pages (see readDocument.js's
 * escalation) can cost more than one model call per page.
 */
export const DEFAULT_MAX_MODEL_CALLS_PER_DAY = 2000;

/**
 * Read a tenant's daily model-call spend and its cap in ONE round trip.
 *
 * Combines three SECURITY DEFINER lookups (resolve_tenant, get_tenant_limits,
 * get_usage_counters — the same three primitives `limit()` above already
 * uses separately) into a single query via a CTE, rather than three: this is
 * meant to be called once per document, right before the queue would spend
 * another Anthropic-billed call transcribing it (see queue.js), and should
 * cost as little as `limit()`'s own daily check does.
 *
 * FAILS OPEN: a lookup failure here must never be the reason ingestion stops
 * working (same principle as `resolveLimits`/`limit()` above) — log and
 * report "not exceeded" so a broken budget check degrades to "no extra cap
 * today," not "nothing ingests today."
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @returns {Promise<{exceeded: boolean, used: number, limit: number}>}
 */
export async function getDailyModelBudgetStatus(ctx) {
  const tenantKey = ctx?.tenantKey;
  if (!tenantKey) return { exceeded: false, used: 0, limit: DEFAULT_MAX_MODEL_CALLS_PER_DAY };

  // Same JS-computed UTC date `limit()`'s daily check writes usage rows
  // against, rather than the database's own CURRENT_DATE — so a read here
  // always lines up with what a write elsewhere just wrote, regardless of
  // the Postgres session's own timezone setting.
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { rows } = await getAuxPool().query(
      `WITH t AS (SELECT resolve_tenant($1, $2) AS id)
       SELECT t.id AS tenant_id, now() AS db_now, get_tenant_limits(t.id) AS limits,
              COALESCE(
                (SELECT u.model_calls FROM get_usage_counters(t.id, 1) u WHERE u.day = $3::date),
                0
              ) AS model_calls
         FROM t`,
      [tenantKey, ctx.tenantName ?? tenantKey, today]
    );
    const row = rows[0];
    noteDatabaseClock(row?.db_now);
    const override = row?.limits?.maxModelCallsPerDay;
    // R35: the default scales with the plan (Fleet imports 12x what Solo does); an explicit owner override still wins.
    // R43: an ACTIVE staff import may name a bigger daily model-call ceiling (an explicit override above still wins).
    const imp = staffImportFor({ limits: row?.limits });
    const importCalls = imp?.active ? imp.maxModelCallsPerDay : null;
    const limitPerDay = Number.isFinite(override) && override > 0
      ? Math.trunc(override)
      : importCalls ?? scaleDailyLimitForPlan("ingest", DEFAULT_MAX_MODEL_CALLS_PER_DAY, row?.limits);
    const used = Number(row?.model_calls ?? 0);
    if (used >= limitPerDay) return { exceeded: true, used, limit: limitPerDay };
    // R43: a staff import also has a WHOLE-IMPORT ceiling on model calls (retries that read no page never move the page
    // budget, so the page budget alone is not a spend cap). Only looked up while an import is active. Unlike the daily
    // check this one FAILS CLOSED: the import is the one place a broken check must not mean "no cap".
    if (imp?.active) {
      try {
        const win = await getAuxPool().query(
          `SELECT COALESCE(SUM(u.model_calls), 0)::bigint AS n FROM get_usage_counters($1::uuid, 62) u WHERE u.day >= $2::date`,
          [row.tenant_id, imp.from.toISOString().slice(0, 10)]
        );
        const windowCalls = Number(win.rows[0]?.n ?? 0);
        if (windowCalls >= imp.maxModelCalls) {
          return { exceeded: true, used: windowCalls, limit: imp.maxModelCalls, scope: "import-total", message: IMPORT_MODEL_CALLS_MESSAGE };
        }
      } catch (err) {
        console.error("rateLimit: could not read the staff import's model-call total, refusing (fails closed):", err?.message);
        return { exceeded: true, used: 0, limit: imp.maxModelCalls, scope: "import-total", message: IMPORT_MODEL_CALLS_MESSAGE };
      }
    }
    return { exceeded: false, used, limit: limitPerDay };
  } catch (err) {
    console.error("rateLimit: could not read daily model budget, allowing ingestion:", err?.message);
    return { exceeded: false, used: 0, limit: DEFAULT_MAX_MODEL_CALLS_PER_DAY };
  }
}

/**
 * The message every model-spend-gated endpoint shows once a tenant's daily
 * budget is exhausted. One string, in one place, so a customer sees the same
 * wording whether they hit it uploading, asking, or extracting.
 */
export const DAILY_MODEL_BUDGET_MESSAGE = "Daily AI budget reached — resumes tomorrow";
/** R43: the whole-import ceiling on model calls (staffImport.js maxModelCalls) was reached. */
export const IMPORT_MODEL_CALLS_MESSAGE = "The AI-reading allowance set for this data import is used up. DeepWell staff can raise it.";

/**
 * Thrown by assertModelBudget() below. `.status` is 429 (same family as the
 * request-rate limiter's 429, and the same status a caller should treat as
 * "retryable, just not yet") and `.retryAfterSeconds` is how long until the
 * daily counter resets, for a caller that wants to set a Retry-After header.
 * A distinct name (not IngestError, not a bare Error) so queue.js's fatal()
 * can recognize this exact condition and stop retrying THIS run immediately
 * — retrying within the same run cannot succeed; the budget resets at UTC
 * midnight, not on the next attempt a few seconds later.
 */
export class ModelBudgetExceededError extends Error {
  constructor(message = DAILY_MODEL_BUDGET_MESSAGE, retryAfterSeconds = secondsUntilUtcMidnight()) {
    super(message);
    this.name = "ModelBudgetExceededError";
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Call this immediately before ANY Anthropic call that bills a tenant's daily
 * model-spend cap — B1 of the 2026-09-19 adversarial audit found this budget
 * enforced at exactly one of four billed call sites (the Inngest read step)
 * and silently absent everywhere else (extractDocumentFields, /api/extract's
 * image path, /api/ask, and the inline ingestion path when the queue is
 * off). One shared assertion here, called from every one of those sites,
 * means there is exactly one place the rule can be gotten wrong instead of
 * four.
 *
 * Throws ModelBudgetExceededError when the tenant's daily cap is already
 * spent; otherwise returns the same status getDailyModelBudgetStatus does, in
 * case a caller wants it (nobody currently does, but returning it rather than
 * void costs nothing and avoids a second round trip for a caller that later
 * wants to log `used`/`limit`).
 *
 * FAILS OPEN, same as getDailyModelBudgetStatus itself: a lookup failure
 * there comes back `exceeded: false`, so a broken budget check degrades to
 * "no extra cap today," never to "nothing works today."
 */
export async function assertModelBudget(ctx) {
  const status = await getDailyModelBudgetStatus(ctx);
  if (status.exceeded) {
    throw new ModelBudgetExceededError(status.message ?? DAILY_MODEL_BUDGET_MESSAGE);
  }
  return status;
}

/**
 * Map a ModelBudgetExceededError onto a clean HTTP response: 429, a
 * Retry-After header, and the same message on every route that calls this —
 * the "one shared helper... that each endpoint maps to a clean JSON 429 with
 * Retry-After" B1 asks for. Callers still check `error?.name ===
 * "ModelBudgetExceededError"` themselves (this file exports no generic error
 * middleware), but they all format the response through here so the shape
 * can't drift between routes.
 */
export function sendModelBudgetExceeded(res, err) {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(err?.retryAfterSeconds ?? secondsUntilUtcMidnight()))));
  res.status(err?.status ?? 429).json({ error: err?.message ?? DAILY_MODEL_BUDGET_MESSAGE });
}
