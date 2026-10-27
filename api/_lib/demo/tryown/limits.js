/**
 * Abuse and cost controls for the public "Try your own documents" demo. ALL server-side, all in the shared counter store the
 * Support Assistant's public widget already uses (support_public_windows through the SECURITY DEFINER function
 * support_public_bump, M3-config/61): it holds only one-way hashes and integers, so no new table and no migration.
 *
 *   per IP        3 uploads / hour, 10 / day         (key: dtry:ip:<hash>:uh / :ud   - IPv4 address or IPv6 /64, hashed with the UTC day)
 *   per session   3 uploads / hour, 10 / day         (key: dtry:ss:<hash>:uh / :ud   - the browser's random session id, hashed)
 *   everyone      300 uploads / day                  (key: dtry:g:ud)
 *   questions     5 per session, 20 per IP per day   (keys: dtry:ss:<hash>:q, dtry:ip:<hash>:qd)
 *   spend         $3 per UTC day, all visitors       (keys: dtry:usd:r reserved + dtry:usd:f handed back, micro-USD; see reserve())
 *
 * EVERYTHING FAILS CLOSED: if the shared store cannot be reached (migration 61 not installed, an outage) every check answers
 * "not allowed" with reason 'unavailable', so a broken counter can never become an unmetered bill. There is no in-memory fallback
 * on purpose: several serverless instances would each count separately and the caps would silently stop meaning anything.
 *
 * The visitor never sees money: callers get {ok:false, reason} and map it to a friendly sentence (config.js TEXT).
 * Everything is injectable so scripts/verify-demo-tryown.ts runs with no database.
 */
import crypto from 'node:crypto';
import { DEFAULTS, LIMITS, resolveConfig } from './config.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const hourStart = (now) => Math.floor(now / HOUR) * HOUR;
export const dayStart = (now) => Math.floor(now / DAY) * DAY;
const microOf = (usd) => Math.max(0, Math.min(2_000_000_000, Math.round((Number(usd) || 0) * 1_000_000)));
const secsTo = (now, start, len) => Math.max(1, Math.ceil((start + len - now) / 1000));

/** The caller's IP, for counting only; never stored raw. (Same header order as the support widget.) */
export function clientIp(req) {
  const h = req?.headers ?? {};
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const raw = pick(h['x-vercel-forwarded-for']) || pick(h['x-real-ip']) || String(pick(h['x-forwarded-for']) ?? '').split(',')[0] || req?.socket?.remoteAddress || '';
  return String(raw).trim().slice(0, 64) || 'unknown';
}

/**
 * The key an address is counted under. IPv4: the address. IPv6: the /64 (the first four groups), because one home connection owns a whole
 * /64 and could otherwise rotate through 2^64 addresses; an IPv4-mapped IPv6 address counts as its IPv4. Pure.
 */
export function ipBucket(raw) {
  let a = String(raw ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!a) return 'unknown';
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  let tail = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a); // ::1.2.3.4 style tail: two groups
  if (v4) { const o = v4[1].split('.').map(Number); a = a.slice(0, a.length - v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [head, rest] = a.split('::');
  const h = head ? head.split(':') : [];
  tail = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a.slice(0, 64); // not an address we can parse: count it whole
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '::/64';
}

const SESSION_RE = /^[a-f0-9]{32}$/;
export const validSessionId = (sid) => typeof sid === 'string' && SESSION_RE.test(sid);

/** sha256 of (value + UTC day + salt): cannot be linked across days. */
export function hashFor(kind, value, now, env = process.env) {
  const day = new Date(now).toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`dtry|${kind}|${value}|${day}|${env?.SUPPORT_HASH_SALT ?? 'dw-demo'}`).digest('hex').slice(0, 24);
}

/** The real shared store: one atomic upsert per call. Returns null when it cannot be read (callers fail closed). */
async function dbShared(key, ws, units) {
  try {
    const { getAuxPool } = await import('../../apiKeyAuth.js');
    const { rows } = await getAuxPool().query('SELECT support_public_bump($1, $2::timestamptz, $3) AS units', [key, new Date(ws).toISOString(), Math.max(0, Math.trunc(units))]);
    const v = Number(rows[0]?.units);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null; // the reason is deliberately not logged: it can carry connection strings
  }
}

/**
 * @param {{now?: () => number, env?: object, shared?: (key:string, windowStart:number, units:number) => Promise<number|null>}} [deps]
 */
export function createLimiter(deps = {}) {
  const nowFn = deps.now ?? (() => Date.now());
  const env = deps.env ?? process.env;
  const shared = deps.shared ?? dbShared;
  const cfg = () => resolveConfig(env);

  async function count(key, ws, units = 1) {
    const v = await shared(key, ws, units);
    return Number.isFinite(v) ? v : null;
  }

  return {
    config: cfg,

    /**
     * Count one upload batch (<= 3 files) against every cap. Increments in a fixed order and stops at the first cap that is over,
     * so a visitor who is already over a cap stops paying into the others.
     * @returns {Promise<{ok:true}|{ok:false, reason:'unavailable'|'slow-down'|'daily-global', retryAfterSec:number}>}
     */
    async checkUpload({ req, sid }) {
      const now = nowFn();
      const c = cfg();
      const ip = hashFor('ip', ipBucket(clientIp(req)), now, env);
      const ss = hashFor('ss', sid, now, env);
      const hs = hourStart(now), ds = dayStart(now);
      const steps = [
        [`dtry:ip:${ip}:uh`, hs, c.uploadsPerHour, secsTo(now, hs, HOUR)],
        [`dtry:ss:${ss}:uh`, hs, c.uploadsPerHour, secsTo(now, hs, HOUR)],
        [`dtry:ip:${ip}:ud`, ds, c.uploadsPerDay, secsTo(now, ds, DAY)],
        [`dtry:ss:${ss}:ud`, ds, c.uploadsPerDay, secsTo(now, ds, DAY)],
      ];
      for (const [key, ws, max, retry] of steps) {
        const n = await count(key, ws);
        if (n == null) return { ok: false, reason: 'unavailable', retryAfterSec: 60 };
        if (n > max) return { ok: false, reason: 'slow-down', retryAfterSec: retry };
      }
      const g = await count('dtry:g:ud', ds);
      if (g == null) return { ok: false, reason: 'unavailable', retryAfterSec: 60 };
      if (g > c.globalUploadsPerDay) return { ok: false, reason: 'daily-global', retryAfterSec: secsTo(now, ds, DAY) };
      return { ok: true };
    },

    /** Count one question: 5 per browser session, and a per-IP daily cap. */
    async checkQuestion({ req, sid }) {
      const now = nowFn();
      const c = cfg();
      const ip = hashFor('ip', ipBucket(clientIp(req)), now, env);
      const ss = hashFor('ss', sid, now, env);
      const ds = dayStart(now);
      const q = await count(`dtry:ss:${ss}:q`, ds);
      if (q == null) return { ok: false, reason: 'unavailable', retryAfterSec: 60 };
      if (q > LIMITS.maxQuestions) return { ok: false, reason: 'questions-used', retryAfterSec: secsTo(now, ds, DAY), left: 0 };
      const qi = await count(`dtry:ip:${ip}:qd`, ds);
      if (qi == null) return { ok: false, reason: 'unavailable', retryAfterSec: 60 };
      if (qi > c.questionsPerIpPerDay) return { ok: false, reason: 'slow-down', retryAfterSec: secsTo(now, ds, DAY) };
      return { ok: true, left: Math.max(0, LIMITS.maxQuestions - q) };
    },

    /** Today's net reserved spend in USD (reserved minus refunded). null = unreadable. */
    async spentUsd() {
      const ds = dayStart(nowFn());
      const r = await count('dtry:usd:r', ds, 0);
      const f = await count('dtry:usd:f', ds, 0);
      return r == null || f == null ? null : Math.max(0, r - f) / 1_000_000;
    },

    /** Presign-time courtesy check (reserves nothing): is there room for one more read at all? The real, atomic gate is reserve(). */
    async peekSpend(worstCaseUsd) {
      const cap = cfg().dailyUsd;
      if (!(cap > 0)) return { ok: false, reason: 'daily-cap' };
      const spent = await this.spentUsd();
      if (spent == null) return { ok: false, reason: 'unavailable' };
      return spent + (Number(worstCaseUsd) || 0) > cap ? { ok: false, reason: 'daily-cap' } : { ok: true, spent };
    },

    /**
     * RESERVE budget before any model call. The counter store can only add, so the day's spend is two ever-growing counters:
     * R = everything ever reserved, F = everything handed back. A reservation adds its worst case to R in one atomic upsert and gets
     * back its OWN running total, so concurrent requests are strictly ordered by the database: if (R - F) is now over the cap it hands
     * its amount straight back (F += worst) and is refused. F is read after R, and F only grows, so a stale F can only make a request
     * look more expensive than it is: it errs toward refusing, never toward overspending. Settling returns the unused part.
     * FAILS CLOSED on an unreadable counter, a zero / negative cap, or a worst case that does not fit.
     * @returns {Promise<{ok:true, micro:number}|{ok:false, reason:'unavailable'|'daily-cap'}>}
     */
    async reserve(worstCaseUsd) {
      const cap = cfg().dailyUsd;
      if (!(cap > 0)) return { ok: false, reason: 'daily-cap' };
      const micro = Math.max(1, microOf(worstCaseUsd));
      const ds = dayStart(nowFn());
      // ORDER MATTERS: read F (refunds) BEFORE adding to R. F only grows, and a refund is always made AFTER its own request's R bump, so a
      // refund seen here belongs to a request whose reservation is already inside the R total this request is about to receive. Reading F after
      // the R bump would also see refunds made by LATER requests (whose reservations are not in this request's R), under-counting the net
      // and granting more than the cap. Reading it first can only over-count the net, which errs toward refusing.
      const f = await count('dtry:usd:f', ds, 0);
      if (f == null) return { ok: false, reason: 'unavailable' }; // nothing reserved yet
      const r = await count('dtry:usd:r', ds, micro);
      if (r == null) return { ok: false, reason: 'unavailable' };
      if ((r - f) / 1_000_000 > cap) { await count('dtry:usd:f', ds, micro); return { ok: false, reason: 'daily-cap' }; }
      return { ok: true, micro, ds };
    },

    /**
     * Settle a reservation to what was actually spent: hand back the unused part (F += reserved - actual); if the actual cost somehow
     * exceeded the reservation, add the excess to R. `actualUsd` null / undefined = unknown (a timeout, a crash): keep the full reservation.
     */
    async settle(res, actualUsd) {
      if (!res?.ok || actualUsd == null) return false;
      const actual = microOf(actualUsd);
      try {
        if (actual < res.micro) return (await count('dtry:usd:f', res.ds, res.micro - actual)) != null;
        if (actual > res.micro) return (await count('dtry:usd:r', res.ds, actual - res.micro)) != null;
        return true;
      } catch { return false; }
    },

    /** A signed upload ticket may be read once: the first caller to count its nonce wins. */
    async claimTicket(nonce) {
      const n = await count(`dtry:t:${String(nonce).slice(0, 40)}`, dayStart(nowFn()));
      return n === 1;
    },
  };
}

export { DEFAULTS };
