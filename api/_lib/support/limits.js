/**
 * Round 28 — Support Assistant, request-rate limits and $ spend caps.
 *
 * TWO INDEPENDENT LAYERS, both separate from Donovan:
 *
 *  1. REQUEST RATE (every message, FAQ or model, is counted; over the line = HTTP 429):
 *       public  per-IP-hash   8/min, 60/day      -> support_public_windows (M3-config/61), in-memory if missing
 *       app     per-user      8/min, 200/day     -> rate_limit_windows, buckets support_m_<u>/support_d_<u> (no new SQL)
 *     The shared `ask` bucket is never touched (rateLimit.js's limit() also feeds a tenant-wide usage_counters
 *     `requests` count, so it is deliberately NOT used here).
 *
 *  2. MODEL SPEND (only the optional Haiku path costs money; over the line = keep answering from the FAQ):
 *       tenant/day     $0.50   rate_limit_windows bucket support_usd_micro       (planner/spend.js ROUTE_BUCKETS.support)
 *       tenant/month   $8      rate_limit_windows bucket support_month_usd_micro (same idiom as usage.js ask_month)
 *       platform/day   $25     support_public_windows key plat:d                  (all authenticated tenants)
 *       public pool/day $5     support_public_windows key pub:d                   (website visitors, no tenant)
 *     Spend checks FAIL CLOSED: if a counter cannot be read the model is skipped (the FAQ still answers), so an
 *     unmigrated database or an outage can never turn into an unmetered bill. Migration 61 is therefore a
 *     prerequisite for turning the model ON, not for the $0 FAQ path.
 *
 * Everything is injectable (createLimiter(deps)) so scripts/verify-support-assistant.mjs runs with no database.
 */
import crypto from 'node:crypto';
import { RATE, SPEND } from './policy.js';

const MIN = 60_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const microOf = (usd) => Math.max(0, Math.min(2_000_000_000, Math.round((Number(usd) || 0) * 1_000_000)));

export const minuteStart = (now) => Math.floor(now / MIN) * MIN;
export const dayStart = (now) => Math.floor(now / DAY) * DAY;
export const hourStart = (now) => Math.floor(now / HOUR) * HOUR;
export const monthStart = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const secondsToNextMinute = (now) => Math.max(1, Math.ceil((minuteStart(now) + MIN - now) / 1000));
const secondsToNextHour = (now) => Math.max(1, Math.ceil((hourStart(now) + HOUR - now) / 1000));
const secondsToNextDay = (now) => Math.max(1, Math.ceil((dayStart(now) + DAY - now) / 1000));

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const posInt = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

/** Effective numbers, env first. Pure. */
export function resolveConfig(env = process.env) {
  return {
    publicPerMinute: posInt(env?.SUPPORT_PUBLIC_PER_MINUTE) ?? RATE.publicPerMinute,
    publicPerDay: posInt(env?.SUPPORT_PUBLIC_PER_DAY) ?? RATE.publicPerDay,
    appPerMinute: posInt(env?.RATE_LIMIT_SUPPORT_PER_MINUTE) ?? RATE.appPerMinute,
    appPerDay: posInt(env?.RATE_LIMIT_SUPPORT_PER_DAY) ?? RATE.appPerDay,
    handoffPublicPerDay: posInt(env?.SUPPORT_HANDOFF_PUBLIC_PER_DAY) ?? RATE.handoffPublicPerDay,
    handoffAppPerDay: posInt(env?.SUPPORT_HANDOFF_APP_PER_DAY) ?? RATE.handoffAppPerDay,
    clientErrorPerDay: posInt(env?.SUPPORT_CLIENT_ERROR_PER_DAY) ?? RATE.clientErrorPerDay,
    inquiryPerIpPerHour: posInt(env?.SUPPORT_INQUIRY_PER_IP_HOUR) ?? RATE.inquiryPerIpPerHour,
    inquiryGlobalPerDay: posInt(env?.SUPPORT_INQUIRY_GLOBAL_PER_DAY) ?? RATE.inquiryGlobalPerDay,
    inquiryPerAddressPerDay: posInt(env?.SUPPORT_INQUIRY_PER_ADDRESS_PER_DAY) ?? RATE.inquiryPerAddressPerDay,
    tenantDailyUsd: num(env?.SUPPORT_DAILY_USD) ?? SPEND.tenantDailyUsd,
    tenantMonthlyUsd: num(env?.SUPPORT_MONTHLY_USD) ?? SPEND.tenantMonthlyUsd,
    platformDailyUsd: num(env?.SUPPORT_PLATFORM_DAILY_USD) ?? SPEND.platformDailyUsd,
    publicDailyUsd: num(env?.SUPPORT_PUBLIC_DAILY_USD) ?? SPEND.publicDailyUsd,
  };
}

/** The caller's IP for rate limiting only. Never stored raw. */
export function clientIp(req) {
  const h = req?.headers ?? {};
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const raw = pick(h['x-vercel-forwarded-for']) || pick(h['x-real-ip']) || String(pick(h['x-forwarded-for']) ?? '').split(',')[0] || req?.socket?.remoteAddress || '';
  return String(raw).trim().slice(0, 64) || 'unknown';
}

/** sha256(ip + UTC-day salt). The day salt means a hash cannot be linked across days. */
export function hashIp(ip, now = Date.now(), env = process.env) {
  const day = new Date(now).toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${ip}|${day}|${env?.SUPPORT_HASH_SALT ?? 'dw-support'}`).digest('hex').slice(0, 24);
}

export function hashUser(userId) {
  return crypto.createHash('sha256').update(`u|${String(userId ?? '')}`).digest('hex').slice(0, 20);
}

/* ------------------------------------------------------------------ default (real) dependencies */

const memory = new Map(); // key -> {ws, units}; per-instance fallback for the public window store
function memBump(key, ws, units) {
  const cur = memory.get(key);
  const next = cur && cur.ws === ws ? { ws, units: cur.units + units } : { ws, units };
  memory.set(key, next);
  if (memory.size > 5000) for (const [k, v] of memory) { if (v.ws < ws - DAY) memory.delete(k); }
  return next.units;
}
export function _resetMemoryForTest() { memory.clear(); }

let warned = false;
function warnOnce(msg) { if (!warned) { warned = true; console.error(`support limits: ${msg} (using in-memory fallback; model spend is denied without the shared store)`); } }

async function defaultShared(key, ws, units) {
  try {
    const { getAuxPool } = await import('../apiKeyAuth.js');
    const { rows } = await getAuxPool().query('SELECT support_public_bump($1, $2::timestamptz, $3) AS units', [key, new Date(ws).toISOString(), Math.max(0, Math.trunc(units))]);
    const v = Number(rows[0]?.units);
    if (Number.isFinite(v)) return { units: v, source: 'db' };
    throw new Error('no units returned');
  } catch (err) {
    warnOnce(`support_public_windows unavailable: ${err?.message}`);
    return { units: memBump(key, ws, units), source: 'memory' };
  }
}

async function tenantUuidFor(auth) {
  const { getTenantContext } = await import('../recordsStore.js');
  const ctx = await getTenantContext(auth.tenantId, auth.orgId ?? auth.tenantId);
  return typeof ctx?.id === 'string' && ctx.id.trim() ? ctx.id : null;
}

function tenantCtx(auth) { return { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }; }

const defaultTenant = {
  /** rate_limit_windows via the existing SECURITY DEFINER upsert (aux pool, no tenant transaction). null = unavailable. */
  async bumpWindow(auth, bucket, ws, units) {
    try {
      const id = await tenantUuidFor(auth);
      if (!id) return null;
      const { getAuxPool } = await import('../apiKeyAuth.js');
      const { rows } = await getAuxPool().query('SELECT increment_rate_limit_window($1, $2, $3::timestamptz, $4) AS units', [id, bucket, new Date(ws).toISOString(), units]);
      const v = Number(rows[0]?.units);
      return Number.isFinite(v) ? v : null;
    } catch (err) {
      warnOnce(`rate_limit_windows unavailable: ${err?.message}`);
      return null;
    }
  },
  /** USD spent today / this month by this tenant on the support model; null = unreadable (fail closed). */
  async spentToday(auth, bucket, now) {
    const [{ withTenant }, { sonnetSpentTodayUsd }] = await Promise.all([import('../recordsStore.js'), import('../agent/escalation.js')]);
    return sonnetSpentTodayUsd(withTenant, tenantCtx(auth), now, bucket);
  },
  async spentMonth(auth, now) {
    try {
      const { withTenant } = await import('../recordsStore.js');
      const { rows } = await withTenant(tenantCtx(auth), (db) => db.raw(
        `SELECT units FROM rate_limit_windows
          WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = $1 AND window_start = $2::timestamptz`,
        ['support_month_usd_micro', new Date(monthStart(now)).toISOString()]));
      return (Number(rows[0]?.units) || 0) / 1_000_000;
    } catch { return null; }
  },
  async addSpend(auth, usd, now) {
    const micro = microOf(usd);
    if (!micro) return false;
    try {
      const [{ withTenant }, { recordSonnetSpend }] = await Promise.all([import('../recordsStore.js'), import('../agent/escalation.js')]);
      const okDay = await recordSonnetSpend(withTenant, tenantCtx(auth), usd, now, 'support_usd_micro');
      await withTenant(tenantCtx(auth), (db) => db.raw(
        `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2::timestamptz, $3)
         ON CONFLICT (tenant_id, bucket, window_start)
         DO UPDATE SET units = LEAST(2000000000, rate_limit_windows.units + EXCLUDED.units)`,
        ['support_month_usd_micro', new Date(monthStart(now)).toISOString(), micro]));
      return okDay;
    } catch { return false; }
  },
};

/* ------------------------------------------------------------------ limiter */

/**
 * @param {{now?: () => number, env?: object, shared?: (key:string, ws:number, units:number) => Promise<{units:number, source:'db'|'memory'}>, tenant?: typeof defaultTenant}} [deps]
 */
export function createLimiter(deps = {}) {
  const nowFn = deps.now ?? (() => Date.now());
  const env = deps.env ?? process.env;
  const shared = deps.shared ?? defaultShared;
  const tenant = deps.tenant ?? defaultTenant;

  const cfg = () => resolveConfig(env);

  async function bumpBoth(mKey, dKey, perMinute, perDay, now, bump) {
    const m = await bump(mKey, minuteStart(now), 1);
    if (m != null && m > perMinute) return { ok: false, scope: 'minute', retryAfterSec: secondsToNextMinute(now) };
    const d = await bump(dKey, dayStart(now), 1);
    if (d != null && d > perDay) return { ok: false, scope: 'day', retryAfterSec: secondsToNextDay(now) };
    return { ok: true };
  }

  return {
    config: cfg,

    /** Count one message against the caller's request limits. */
    async checkRate({ surface, req, auth }) {
      const now = nowFn();
      const c = cfg();
      if (surface === 'public' || !auth) {
        const h = hashIp(clientIp(req), now, env);
        return bumpBoth(`ip:${h}:m`, `ip:${h}:d`, c.publicPerMinute, c.publicPerDay, now, async (k, ws, u) => (await shared(k, ws, u)).units);
      }
      const uh = hashUser(auth.userId);
      return bumpBoth(`support_m_${uh}`, `support_d_${uh}`, c.appPerMinute, c.appPerDay, now, (b, ws, u) => tenant.bumpWindow(auth, b, ws, u));
    },

    /** Count one hand-off. Public: per IP per day. App: per user per day. */
    async checkHandoff({ surface, req, auth }) {
      const now = nowFn();
      const c = cfg();
      if (surface === 'public' || !auth) {
        const h = hashIp(clientIp(req), now, env);
        const n = (await shared(`iph:${h}:d`, dayStart(now), 1)).units;
        return n > c.handoffPublicPerDay ? { ok: false, scope: 'day', retryAfterSec: secondsToNextDay(now) } : { ok: true };
      }
      const n = await tenant.bumpWindow(auth, `support_h_${hashUser(auth.userId)}`, dayStart(now), 1);
      return n != null && n > c.handoffAppPerDay ? { ok: false, scope: 'day', retryAfterSec: secondsToNextDay(now) } : { ok: true };
    },

    /**
     * Count one website inquiry (public, no account). Three independent caps, all in the shared window store:
     * per IP hash per hour, all visitors per day, and per visitor address per day (that last one bounds the receipt email).
     */
    async checkInquiry({ req, email }) {
      const now = nowFn();
      const c = cfg();
      const h = hashIp(clientIp(req), now, env);
      const ip = (await shared(`inq:ip:${h}:h`, hourStart(now), 1)).units;
      if (ip > c.inquiryPerIpPerHour) return { ok: false, scope: 'ip-hour', retryAfterSec: secondsToNextHour(now) };
      const eh = crypto.createHash('sha256').update(`inq|${String(email ?? '').toLowerCase()}`).digest('hex').slice(0, 24);
      const em = (await shared(`inq:em:${eh}:d`, dayStart(now), 1)).units;
      if (em > c.inquiryPerAddressPerDay) return { ok: false, scope: 'address-day', retryAfterSec: secondsToNextDay(now) };
      const g = (await shared('inq:g:d', dayStart(now), 1)).units;
      if (g > c.inquiryGlobalPerDay) return { ok: false, scope: 'global-day', retryAfterSec: secondsToNextDay(now) };
      return { ok: true };
    },

    /** Count one browser error report (signed-in only) against the user's daily cap so a crash loop cannot flood the logs. */
    async checkClientError({ auth }) {
      const now = nowFn();
      const c = cfg();
      const n = await tenant.bumpWindow(auth, `support_e_${hashUser(auth.userId)}`, dayStart(now), 1);
      return n != null && n > c.clientErrorPerDay ? { ok: false, scope: 'day', retryAfterSec: secondsToNextDay(now) } : { ok: true };
    },

    /**
     * May this request start a model call? Reads (never increments) every cap. Fails closed.
     * @returns {Promise<{allowed: boolean, reason?: string}>}
     */
    async modelGate({ surface, auth }) {
      const now = nowFn();
      const c = cfg();
      try {
        if (surface === 'public' || !auth) {
          if (c.publicDailyUsd <= 0) return { allowed: false, reason: 'public-cap-zero' };
          const pub = await shared('pub:d', dayStart(now), 0);
          if (pub.source !== 'db') return { allowed: false, reason: 'spend-unreadable' };
          if (pub.units >= microOf(c.publicDailyUsd)) return { allowed: false, reason: 'public-daily-cap' };
          const plat = await shared('plat:d', dayStart(now), 0);
          if (plat.source !== 'db') return { allowed: false, reason: 'spend-unreadable' };
          if (plat.units >= microOf(c.platformDailyUsd)) return { allowed: false, reason: 'platform-daily-cap' };
          return { allowed: true };
        }
        if (c.tenantDailyUsd <= 0 || c.tenantMonthlyUsd <= 0) return { allowed: false, reason: 'tenant-cap-zero' };
        const plat = await shared('plat:d', dayStart(now), 0);
        if (plat.source !== 'db') return { allowed: false, reason: 'spend-unreadable' };
        if (plat.units >= microOf(c.platformDailyUsd)) return { allowed: false, reason: 'platform-daily-cap' };
        const day = await tenant.spentToday(auth, 'support_usd_micro', now);
        if (day == null) return { allowed: false, reason: 'spend-unreadable' };
        if (day >= c.tenantDailyUsd) return { allowed: false, reason: 'tenant-daily-cap' };
        const month = await tenant.spentMonth(auth, now);
        if (month == null) return { allowed: false, reason: 'spend-unreadable' };
        if (month >= c.tenantMonthlyUsd) return { allowed: false, reason: 'tenant-monthly-cap' };
        return { allowed: true };
      } catch {
        return { allowed: false, reason: 'spend-unreadable' };
      }
    },

    /** Book a finished model call's cost everywhere it counts. Best-effort; never throws. */
    async recordSpend({ surface, auth, usd }) {
      const now = nowFn();
      const micro = microOf(usd);
      if (!micro) return false;
      try {
        if (surface === 'public' || !auth) {
          await shared('pub:d', dayStart(now), micro);
          await shared('plat:d', dayStart(now), micro); // the platform-wide cap counts website spend too
        } else {
          await tenant.addSpend(auth, usd, now);
          await shared('plat:d', dayStart(now), micro);
        }
        return true;
      } catch { return false; }
    },
  };
}
