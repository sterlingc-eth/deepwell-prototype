/**
 * Unit checks for API-key authentication and rate limiting. No database, no
 * network — every check here is either a pure function, or exercises
 * `limit()`'s documented FAIL-OPEN behavior when Postgres is unreachable
 * (both the burst window and the daily cap are Postgres-backed — see
 * rateLimit.js's module comment — so with no database neither can enforce
 * anything, on purpose, rather than either silently disabling itself forever
 * or wrongly blocking every request). NEON_CONNECTION_STRING is deliberately
 * deleted before anything is imported so a code path that DID try to reach
 * Postgres would fail loudly here instead of quietly reaching a real
 * database.
 *
 * The burst window's actual arithmetic (the fixed-window math, the env
 * override layer) is pure and tested directly against rateLimit.js's own
 * exported functions below — no reimplementation, no black-box duplicate.
 *
 * What this guards: this is the boundary that decides who gets to call the
 * API at all, and how hard they're allowed to hit it. A key that a Clerk JWT
 * could satisfy, or a scope check that doesn't actually block, turns into an
 * integration surface with no auth on it; a window that miscounts turns into
 * the uncapped Anthropic bill this whole change exists to prevent.
 *
 *   node scripts/verify-apikeys.mjs
 */
delete process.env.NEON_CONNECTION_STRING;

import {
  KEY_PREFIX,
  SCOPES,
  isApiKey,
  hashKey,
  generateKey,
  assertScope,
} from '../api/_lib/apiKeyAuth.js';
import { AuthError } from '../api/_lib/auth.js';
import {
  limit,
  DEFAULT_LIMITS,
  WINDOW_MS,
  minuteWindowStart,
  secondsUntilNextWindow,
  exceedsPerMinute,
  parseLimitEnv,
  envLimits,
} from '../api/_lib/rateLimit.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- key format / prefix */

const { rawKey, keyPrefix, keyHash } = generateKey();

check('generated key carries the dw_live_ prefix', rawKey.startsWith(KEY_PREFIX));
check('generated key is prefix + 64 hex chars', /^dw_live_[0-9a-f]{64}$/.test(rawKey), rawKey);
eq('displayed prefix is the first 8 chars after dw_live_', keyPrefix, rawKey.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8));
check('two generated keys are never equal', generateKey().rawKey !== generateKey().rawKey);

check('isApiKey recognizes a real key', isApiKey(rawKey));
check('isApiKey rejects null', !isApiKey(null));
check('isApiKey rejects undefined', !isApiKey(undefined));
check('isApiKey rejects a number', !isApiKey(12345));
check('isApiKey rejects an empty string', !isApiKey(''));
check('isApiKey rejects a bare "Bearer" scheme with no key', !isApiKey('Bearer'));
check('isApiKey rejects a key-shaped string missing the prefix', !isApiKey('a'.repeat(64)));

/* --------------------------- a Clerk JWT is never mistaken for an API key --
 * A Clerk-issued (or any) JWT is three base64url segments joined by '.', and
 * its header segment always decodes to '{"...' — which base64-encodes to a
 * string starting "eyJ". requireAuthOrKey()'s only branch point is
 * isApiKey(): if this is ever true for something that looks like a JWT, that
 * token would be hashed and looked up as a key instead of verified against
 * Clerk, which is a full authentication bypass path, not a cosmetic bug. */

const FAKE_CLERK_JWT =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1c2VyXzJhYmMiLCJvcmdfaWQiOiJvcmdfMSJ9.c2lnbmF0dXJl';
check('a Clerk-shaped JWT is never recognized as an API key', !isApiKey(FAKE_CLERK_JWT));
check('a JWT header segment ("eyJ...") alone is never recognized as an API key', !isApiKey(FAKE_CLERK_JWT.split('.')[0]));
// The converse, stated explicitly: nothing this module generates can ever
// start the way a JWT does, because KEY_PREFIX itself does not start "eyJ".
check('KEY_PREFIX itself could never be mistaken for the start of a JWT', !FAKE_CLERK_JWT.startsWith(KEY_PREFIX) && !KEY_PREFIX.startsWith('eyJ'));

/* --------------------------------------------------------------- hashing */

check('hashKey returns a 64-char hex sha256 digest', /^[0-9a-f]{64}$/.test(hashKey(rawKey)));
eq('hashKey is deterministic', hashKey(rawKey), hashKey(rawKey));
check('hashKey differs for different inputs', hashKey(rawKey) !== hashKey(generateKey().rawKey));
eq('generateKey\'s own keyHash matches hashKey(rawKey)', keyHash, hashKey(rawKey));
check('the raw key is never itself a valid sha256 digest (never confusable with its own hash)', !/^[0-9a-f]{64}$/.test(rawKey));

/* -------------------------------------------------------------- scope checks */

check('SCOPES is a fixed, non-empty list', Array.isArray(SCOPES) && SCOPES.length > 0);
eq('SCOPES are exactly read/ingest/ask', [...SCOPES].sort(), ['ask', 'ingest', 'read']);

check('a Clerk session (viaKey false) is never scope-checked', (() => {
  try { assertScope({ viaKey: false, scopes: [] }, 'ask'); return true; } catch { return false; }
})());
check('a missing auth object does not throw (defensive no-op)', (() => {
  try { assertScope(undefined, 'ask'); return true; } catch { return false; }
})());
check('a key with the required scope passes', (() => {
  try { assertScope({ viaKey: true, scopes: ['read', 'ingest'] }, 'read'); return true; } catch { return false; }
})());

function assertThrows(fn) {
  try { fn(); return null; } catch (e) { return e; }
}
{
  const err = assertThrows(() => assertScope({ viaKey: true, scopes: ['read'] }, 'ingest'));
  check('a key WITHOUT the required scope is rejected', err instanceof AuthError, String(err));
  check('a scope rejection is a 403, not the default 401 (caller is authenticated, just not permitted)', err?.status === 403, `got ${err?.status}`);
}
{
  const err = assertThrows(() => assertScope({ viaKey: true, scopes: [] }, 'read'));
  check('a key with no scopes at all is rejected', err instanceof AuthError);
}

/* ------------------------------------------------------- fixed-window math
 * The burst window is now Postgres-backed (rate_limit_windows,
 * increment_rate_limit_window — see M3-config/12-rate-limit-window.sql), so
 * it can't be exercised end-to-end without a database. Its arithmetic is
 * pure and exported, so it's tested directly instead. */

check('WINDOW_MS is one minute', WINDOW_MS === 60_000);

eq('minuteWindowStart truncates down to the minute', minuteWindowStart(90_000), 60_000);
eq('minuteWindowStart is idempotent on an exact boundary', minuteWindowStart(120_000), 120_000);
eq('minuteWindowStart of 0 is 0', minuteWindowStart(0), 0);

eq('secondsUntilNextWindow at the start of a window is ~60', secondsUntilNextWindow(60_000, 60_000), 60);
eq('secondsUntilNextWindow one second before the boundary is 1', secondsUntilNextWindow(119_000, 60_000), 1);
eq('secondsUntilNextWindow never returns less than 1 (past the boundary)', secondsUntilNextWindow(121_000, 60_000), 1);

check('exceedsPerMinute is false at exactly the limit', exceedsPerMinute(5, 5) === false);
check('exceedsPerMinute is true one past the limit', exceedsPerMinute(6, 5) === true);
check('exceedsPerMinute is false comfortably under the limit', exceedsPerMinute(1, 5) === false);

/* --------------------------------------------------------- env overrides
 * "keep limits configurable via env" — parseLimitEnv/envLimits are the whole
 * mechanism; resolveLimits (DB-backed, not tested here) layers on top. */

eq('parseLimitEnv accepts a positive integer string', parseLimitEnv('42'), 42);
eq('parseLimitEnv rejects undefined (falls back to default)', parseLimitEnv(undefined), undefined);
eq('parseLimitEnv rejects an empty string', parseLimitEnv(''), undefined);
eq('parseLimitEnv rejects zero (not a usable limit)', parseLimitEnv('0'), undefined);
eq('parseLimitEnv rejects a negative number', parseLimitEnv('-5'), undefined);
eq('parseLimitEnv rejects non-numeric garbage', parseLimitEnv('abc'), undefined);

{
  const withoutOverride = envLimits('ask', {});
  eq('envLimits falls back to DEFAULT_LIMITS when no env var is set', withoutOverride, DEFAULT_LIMITS.ask);

  const withOverride = envLimits('ask', { RATE_LIMIT_ASK_PER_MINUTE: '5', RATE_LIMIT_ASK_PER_DAY: '50' });
  eq('envLimits honors RATE_LIMIT_<BUCKET>_PER_MINUTE / _PER_DAY', withOverride, { perMinute: 5, perDay: 50 });

  const partialOverride = envLimits('read', { RATE_LIMIT_READ_PER_MINUTE: '9' });
  eq('envLimits overrides only the var that is set, keeping the other default', partialOverride, { perMinute: 9, perDay: DEFAULT_LIMITS.read.perDay });

  const unknownBucket = envLimits('bogus', {});
  eq('envLimits falls back to the read defaults for an unrecognized bucket', unknownBucket, DEFAULT_LIMITS.read);
}

/* ------------------------------------------------------------- fail-open
 * With no NEON_CONNECTION_STRING (deleted at the top of this file),
 * resolveTenantUuid can't resolve a tenant, so limit() must fail OPEN —
 * allow the request and write nothing to res — for both the burst and the
 * daily check, rather than either silently disabling the cap forever or
 * wrongly blocking every request when the database is briefly unreachable. */

{
  class FakeRes {
    constructor() { this.headers = {}; this.statusCode = null; this.body = null; }
    setHeader(k, v) { this.headers[k] = v; return this; }
    status(code) { this.statusCode = code; return this; }
    json(body) { this.body = body; return this; }
  }
  const res = new FakeRes();
  const auth = { tenantId: 'user_verify_apikeys_failopen' };
  const ok = await limit({ headers: {} }, res, auth, 'read', { perMinute: 1, perDay: 1 });
  check('limit() fails open (allows the request) when the database is unreachable', ok === true, JSON.stringify(res.body));
  check('a fail-open call writes no response (caller proceeds normally)', res.statusCode === null && res.body === null);
}

check('DEFAULT_LIMITS defines all three buckets this codebase rate-limits', ['ask', 'ingest', 'read'].every((b) => DEFAULT_LIMITS[b]?.perMinute > 0 && DEFAULT_LIMITS[b]?.perDay > 0));
eq('ask defaults match spec (20/min, 900/day — 30% of Solo monthly; plans scale via scaleDailyLimitForPlan)', DEFAULT_LIMITS.ask, { perMinute: 20, perDay: 900 });
// Bumped by the scale-readiness build (handoffs/HANDOFF-D.md): `ingest`'s
// perDay/perMinute now count UNITS (see `limit()`'s `cost` parameter), not
// one raw HTTP call each, and are sized for a Shop plan's daily volume plus
// headroom for a 50-file batch presign in one request — not the old
// per-call-only numbers.
eq('ingest defaults match spec (60/min, 2000/day)', DEFAULT_LIMITS.ingest, { perMinute: 60, perDay: 2000 });
eq('read defaults match spec (120/min, 5000/day)', DEFAULT_LIMITS.read, { perMinute: 120, perDay: 5000 });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll API key / rate limit checks passed.');
process.exit(failures ? 1 : 0);
