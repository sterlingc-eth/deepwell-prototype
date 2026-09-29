import { getPool } from "./recordsStore.js";

/**
 * GET /api/account?action=health — the uptime-monitor endpoint (UptimeRobot, Better Stack, ...).
 *
 * NO AUTH, so it is built to reveal nothing: the body is exactly { ok, db, time } — no tenant data, no counts,
 * no versions, no environment names, no error text. `db` is the result of `SELECT 1` against the app's
 * Postgres pool with a short timeout; `ok` is `db`. Status is 200 when healthy and 503 when the database check
 * fails or times out, so a plain "HTTP status" monitor alerts without parsing the body. HEAD works the same.
 *
 * Load: unauthenticated, so the DB ping is cached per warm instance for 5 s (a flood of requests cannot become
 * a flood of queries) and the response is `Cache-Control: no-store` so no CDN serves a stale "ok".
 *
 * Lives here, not in api/_lib/routes/, on purpose: it is the one deliberately unauthenticated account action and
 * it is dispatched directly by api/account.js (a pure dispatcher) before any auth-bearing route is reached.
 */
export const HEALTH_DB_TIMEOUT_MS = 3000;
export const HEALTH_CACHE_MS = 5000;

let cached = null; // { at: number, db: boolean }
export function _resetHealthCache() { cached = null; }

/** Ping the database; resolves false (never throws) on error or after `timeoutMs`. */
export async function pingDatabase({ timeoutMs = HEALTH_DB_TIMEOUT_MS, pool } = {}) {
  let timer;
  try {
    const p = (pool ?? getPool()).query("SELECT 1 AS ok");
    // A late rejection after the timeout must not become an unhandled rejection.
    p.catch(() => {});
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
    const { rows } = await Promise.race([p, timeout]);
    return rows?.[0]?.ok === 1;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let inflight = null;

export default async function healthHandler(req, res, opts = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ ok: false });
  }
  const now = Date.now();
  let db;
  if (cached && now - cached.at < HEALTH_CACHE_MS) {
    db = cached.db;
  } else {
    // R25 review: share ONE in-flight ping across concurrent requests, so an unauthenticated burst
    // can never fan out into many SELECT 1s against the small per-instance pool.
    if (!inflight) {
      inflight = pingDatabase(opts)
        .then((ok) => { cached = { at: Date.now(), db: ok }; return ok; })
        .finally(() => { inflight = null; });
    }
    db = await inflight;
  }
  const body = { ok: db, db, time: new Date(now).toISOString() };
  return res.status(db ? 200 : 503).json(body);
}
