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

/**
 * bucket -> defaults. Overridable per tenant via tenants.limits (see below).
 *
 * `ingest`'s perDay was 300 back when every call to limit(req, res, auth,
 * "ingest") cost exactly 1 unit, whatever it actually did. It no longer does
 * (see `cost` on `limit()` below) — a batch presign of 50 files now costs 50,
 * not 1 — so the same counter that used to mean "ingest HTTP calls today" now
 * means "ingest units (roughly: files/pages) today". 2000/day is this
 * build's Shop-plan-sized default for that meaning, not a tweak of the old
 * one; a tenant that needs a different number gets it via tenants.limits.
 * ingest.perDay, the same override mechanism every bucket already had.
 */
export const DEFAULT_LIMITS = Object.freeze({
  ask:    { perMinute: 30,  perDay: 500 },
  ingest: { perMinute: 60,  perDay: 2000 },
  read:   { perMinute: 120, perDay: 5000 },
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
async function resolveLimits(tenantUuid, bucket, overrides) {
  const base = envLimits(bucket);
  if (!tenantUuid) return base;
  try {
    const { rows } = await getAuxPool().query("SELECT get_tenant_limits($1) AS limits", [tenantUuid]);
    const tenantOverride = rows[0]?.limits?.[bucket] ?? {};
    const callerOverride = overrides ?? {};
    return {
      perMinute: Number.isFinite(callerOverride.perMinute)
        ? callerOverride.perMinute
        : Number.isFinite(tenantOverride.perMinute) ? tenantOverride.perMinute : base.perMinute,
      perDay: Number.isFinite(callerOverride.perDay)
        ? callerOverride.perDay
        : Number.isFinite(tenantOverride.perDay) ? tenantOverride.perDay : base.perDay,
    };
  } catch (err) {
    // A limits lookup failing must never be the reason a legitimate request
    // is refused, and must never be the reason a limit silently stops
    // applying either — fall back to the safe, conservative default rather
    // than an unlimited one.
    console.error("rateLimit: could not read tenant limits, using defaults:", err?.message);
    return base;
  }
}

/**
 * Resolve a tenantKey (Clerk org id, or `user_${id}` — see auth.js /
 * apiKeyAuth.js) to the tenant uuid, via the same resolve_tenant() every
 * withTenant() call already uses. Safe to call repeatedly: idempotent, and
 * every authenticated route already triggers it once per request through
 * withTenant() — this adds one more indexed lookup, not a new kind of write.
 */
async function resolveTenantUuid(tenantKey) {
  if (!tenantKey) return null;
  try {
    const { rows } = await getAuxPool().query("SELECT resolve_tenant($1, $2) AS id", [tenantKey, tenantKey]);
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error("rateLimit: could not resolve tenant:", err?.message);
    return null;
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
function logOnce(table, err) {
  const key = `${table}:${err?.message ?? ""}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? 0) + LOG_EVERY_MS > now) return;
  lastLogged.set(key, now);
  console.error(`rateLimit: could not update ${table} (failing open; repeated once per 10 min):`, err?.message);
}

export async function limit(req, res, auth, bucket, overrides, cost) {
  const tenantKey = auth?.tenantId;
  const now = Date.now();
  const units = Number.isFinite(cost) && cost > 0 ? Math.trunc(cost) : 1;

  const tenantUuid = await resolveTenantUuid(tenantKey);
  const limits = await resolveLimits(tenantUuid, bucket, overrides);

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

  // ---- 2. daily hard cap: Postgres, exact, shared across every instance --
  if (tenantUuid) {
    const today = new Date().toISOString().slice(0, 10);
    let requestsToday = null;
    try {
      const { rows } = await getAuxPool().query(
        "SELECT * FROM increment_usage_counters($1, $2::date, $3, 0, 0, 0)",
        [tenantUuid, today, units]
      );
      requestsToday = rows[0]?.requests ?? null;
    } catch (err) {
      logOnce("usage_counters", err);
    }

    if (requestsToday != null && requestsToday > limits.perDay) {
      send429(res, secondsUntilUtcMidnight(now), {
        details: `Daily limit of ${limits.perDay} ${bucket} units reached for this tenant.`,
        scope: "per-day",
      });
      return false;
    }
  }

  return true;
}

/**
 * A tenant's daily ceiling on actual model spend, e.g.
 * `{"maxModelCallsPerDay": 500}` under tenants.limits. Independent of the
 * `ingest` bucket's perDay above: that bucket is a per-ROUTE, per-HTTP-call
 * cap enforced before a document is even uploaded; this is a whole-tenant cap
 * on `usage_counters.model_calls` — the number Anthropic actually billed for
 * today, whichever route produced it (ask, ingest, or extract all share this
 * counter — see usage.js's recordModelCall). Sized for a Shop plan by
 * default, same order of magnitude as DEFAULT_LIMITS.ingest.perDay for the
 * same reason (roughly one model call per page), but checked as its own
 * number since a document with several flagged pages (see readDocument.js's
 * escalation) can cost more than one model call per page.
 */
const DEFAULT_MAX_MODEL_CALLS_PER_DAY = 2000;

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
       SELECT get_tenant_limits(t.id) AS limits,
              COALESCE(
                (SELECT u.model_calls FROM get_usage_counters(t.id, 1) u WHERE u.day = $3::date),
                0
              ) AS model_calls
         FROM t`,
      [tenantKey, ctx.tenantName ?? tenantKey, today]
    );
    const row = rows[0];
    const override = row?.limits?.maxModelCallsPerDay;
    const limitPerDay = Number.isFinite(override) && override > 0 ? Math.trunc(override) : DEFAULT_MAX_MODEL_CALLS_PER_DAY;
    const used = Number(row?.model_calls ?? 0);
    return { exceeded: used >= limitPerDay, used, limit: limitPerDay };
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
    throw new ModelBudgetExceededError();
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
