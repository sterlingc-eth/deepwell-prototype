/**
 * Rate limiting and daily spend caps.
 *
 * There is no rate limit anywhere in this API today. Any signed-in user can
 * loop /api/ask or upload uniquely-hashed files forever and run up the
 * Anthropic bill; nothing per-tenant bounds it. This adds two layers:
 *
 *   1. A per-minute BURST limit, in memory, per Vercel instance. Soft: a
 *      serverless deployment can run several instances at once, each with its
 *      own counters, so the real ceiling under concurrent instances is
 *      instanceCount x perMinute, not exactly perMinute. That is a real,
 *      documented limitation, not a bug — an in-memory counter cannot see
 *      another instance's requests, and a distributed one is a bigger change
 *      than this ships. It exists to blunt a tight retry loop within a single
 *      warm instance cheaply, with no database round trip.
 *
 *   2. A per-day HARD cap, in Postgres (usage_counters), shared across every
 *      instance. This is the real ceiling: whatever the burst limit lets
 *      through, the daily count is exact and global, and this is what
 *      actually bounds the Anthropic bill for a tenant that loops all day
 *      across many cold starts.
 *
 * Both are keyed by (tenantId, bucket) — 'ask', 'ingest', 'read' — so a
 * tenant hammering /api/extract does not also throttle their own
 * /api/warranty-attention calls.
 */
import { getAuxPool } from "./apiKeyAuth.js";

/** bucket -> defaults. Overridable per tenant via tenants.limits (see below). */
export const DEFAULT_LIMITS = Object.freeze({
  ask:    { perMinute: 30,  perDay: 500 },
  ingest: { perMinute: 20,  perDay: 300 },
  read:   { perMinute: 120, perDay: 5000 },
});

/**
 * In-memory sliding window: bucket key -> array of request timestamps (ms)
 * within the last 60s. Module-level, so it lives as long as this Vercel
 * instance stays warm and is naturally per-instance — see the file header.
 */
const windows = new Map();
const WINDOW_MS = 60_000;

// Bounds how much memory a single warm instance can accumulate across every
// tenant/bucket pair it has ever seen. Each entry is a handful of numbers, so
// this is a low-thousands-of-bytes ceiling even at the cap; it exists so a
// pathological number of distinct tenants cannot grow this Map unboundedly
// over a long-lived instance.
const MAX_TRACKED_KEYS = 5000;

function pruneAndCount(key, now) {
  let arr = windows.get(key);
  if (!arr) {
    if (windows.size >= MAX_TRACKED_KEYS) {
      // Drop the oldest-inserted key (Map preserves insertion order) rather
      // than grow forever. Losing one tenant's burst history occasionally
      // under extreme key cardinality is a soft limit degrading further, not
      // a correctness problem — the daily cap in Postgres still holds.
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    arr = [];
    windows.set(key, arr);
  }
  const cutoff = now - WINDOW_MS;
  let start = 0;
  while (start < arr.length && arr[start] <= cutoff) start++;
  if (start > 0) arr.splice(0, start);
  return arr;
}

/**
 * Merge DEFAULT_LIMITS[bucket] with any per-tenant override found at
 * tenants.limits->bucket (see M3-config/10-api-keys.sql's `limits` column).
 * Only perMinute/perDay keys are honored; anything else in an override is
 * ignored rather than trusted blindly.
 */
async function resolveLimits(tenantUuid, bucket, overrides) {
  const base = DEFAULT_LIMITS[bucket] ?? DEFAULT_LIMITS.read;
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
 * @returns {Promise<boolean>} true if the request may proceed. false means a
 *          429 has ALREADY been written to `res` — the caller must return
 *          immediately without writing anything else.
 */
export async function limit(req, res, auth, bucket, overrides) {
  const tenantKey = auth?.tenantId;
  const now = Date.now();

  // ---- 1. burst: in-memory sliding window, no database round trip -------
  const windowKey = `${tenantKey}:${bucket}`;
  const tentativeLimits = { ...DEFAULT_LIMITS[bucket], ...(overrides ?? {}) };
  const arr = pruneAndCount(windowKey, now);
  if (arr.length >= tentativeLimits.perMinute) {
    const retryAfter = (arr[0] + WINDOW_MS - now) / 1000;
    send429(res, retryAfter, {
      details: `More than ${tentativeLimits.perMinute} ${bucket} requests in the last minute. This limit is approximate under concurrent traffic — see api/_lib/rateLimit.js.`,
      scope: "per-minute",
    });
    return false;
  }

  // ---- 2. daily hard cap: Postgres, exact, shared across every instance --
  const tenantUuid = await resolveTenantUuid(tenantKey);
  const limits = await resolveLimits(tenantUuid, bucket, overrides);

  if (tenantUuid) {
    const today = new Date().toISOString().slice(0, 10);
    let requestsToday = null;
    try {
      const { rows } = await getAuxPool().query(
        "SELECT * FROM increment_usage_counters($1, $2::date, 1, 0, 0, 0)",
        [tenantUuid, today]
      );
      requestsToday = rows[0]?.requests ?? null;
    } catch (err) {
      // Same principle as resolveLimits: a broken counter must not either
      // silently disable the cap or wrongly block every request. Log and let
      // the (still-enforced) burst limit above be the only gate this time.
      console.error("rateLimit: could not update usage_counters:", err?.message);
    }

    if (requestsToday != null && requestsToday > limits.perDay) {
      // Seconds until UTC midnight — the daily counter's own reset point.
      const nowDate = new Date();
      const midnight = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1);
      const retryAfter = (midnight - now) / 1000;
      send429(res, retryAfter, {
        details: `Daily limit of ${limits.perDay} ${bucket} requests reached for this tenant.`,
        scope: "per-day",
      });
      return false;
    }
  }

  // Only now record the burst attempt as having happened — a request that
  // gets 429'd by the daily cap above should not also spend a slot in the
  // per-minute window it never got charged for a second time on retry.
  arr.push(now);
  return true;
}
