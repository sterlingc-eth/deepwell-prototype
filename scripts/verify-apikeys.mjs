/**
 * Unit checks for API-key authentication and rate limiting. No database, no
 * network — every check here is either a pure function or exercises the
 * in-memory burst limiter, which by design never talks to Postgres until
 * AFTER it has already decided the request survives (see rateLimit.js's
 * `limit()`: the daily-cap query only ever runs once the burst check passes).
 * NEON_CONNECTION_STRING is deliberately deleted before anything is imported
 * so a code path that DID try to reach Postgres would fail loudly here
 * instead of quietly reaching a real database.
 *
 * What this guards: this is the boundary that decides who gets to call the
 * API at all, and how hard they're allowed to hit it. A key that a Clerk JWT
 * could satisfy, or a scope check that doesn't actually block, turns into an
 * integration surface with no auth on it; a sliding window that miscounts
 * turns into the uncapped Anthropic bill this whole change exists to prevent.
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
import { limit, DEFAULT_LIMITS } from '../api/_lib/rateLimit.js';

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

/* ------------------------------------------------------- sliding-window math
 * limit()'s daily (Postgres) check only ever runs once the in-memory burst
 * check passes (see rateLimit.js) — with NEON_CONNECTION_STRING unset, the
 * daily-cap lookup below fails closed to "skip the daily check" rather than
 * throwing, exactly as it does in production when the database is briefly
 * unreachable (see resolveTenantUuid's catch). That lets the burst limiter
 * itself be exercised end-to-end with no database at all. */

class FakeRes {
  constructor() { this.headers = {}; this.statusCode = null; this.body = null; }
  setHeader(k, v) { this.headers[k] = v; return this; }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; return this; }
}

async function burstTest(tenantSuffix, perMinute) {
  const auth = { tenantId: `user_verify_apikeys_${tenantSuffix}` };
  const req = { headers: {} };
  const results = [];
  for (let i = 0; i < perMinute + 2; i++) {
    const res = new FakeRes();
    const ok = await limit(req, res, auth, 'read', { perMinute, perDay: 1_000_000 });
    results.push({ ok, res });
  }
  return results;
}

{
  const perMinute = 3;
  const results = await burstTest('burst', perMinute);
  const allowed = results.slice(0, perMinute).every((r) => r.ok === true);
  check(`first ${perMinute} requests in a fresh window are allowed`, allowed, JSON.stringify(results.map((r) => r.ok)));

  const blocked = results[perMinute];
  check('the request past the per-minute limit is blocked', blocked.ok === false);
  eq('a blocked request gets a 429', blocked.res.statusCode, 429);
  check('a blocked request carries a Retry-After header', Number(blocked.res.headers['Retry-After']) > 0, JSON.stringify(blocked.res.headers));
  check('Retry-After is within the 60s window, not some arbitrary number', Number(blocked.res.headers['Retry-After']) <= 60);
  eq('the 429 body names the per-minute scope', blocked.res.body?.scope, 'per-minute');
  check('the 429 body has a top-level error string', typeof blocked.res.body?.error === 'string' && blocked.res.body.error.length > 0);

  const alsoBlocked = results[perMinute + 1];
  check('every subsequent request in the same window stays blocked', alsoBlocked.ok === false);
}

{
  // A different tenant+bucket key must not share the first tenant's window —
  // this is the whole point of keying by (tenantId, bucket) in rateLimit.js.
  const res = new FakeRes();
  const ok = await limit({ headers: {} }, res, { tenantId: 'user_verify_apikeys_isolated' }, 'read', { perMinute: 1, perDay: 1_000_000 });
  check('a fresh tenant/bucket key starts with its own empty window', ok === true, JSON.stringify(res.body));
}

{
  // The bucket, not just the tenant, has to isolate windows: the same tenant
  // hammering 'ask' must not be throttled on 'ingest'.
  const auth = { tenantId: 'user_verify_apikeys_bucket_isolation' };
  const first = await limit({ headers: {} }, new FakeRes(), auth, 'ask', { perMinute: 1, perDay: 1_000_000 });
  const second = await limit({ headers: {} }, new FakeRes(), auth, 'ask', { perMinute: 1, perDay: 1_000_000 });
  const thirdOtherBucket = await limit({ headers: {} }, new FakeRes(), auth, 'ingest', { perMinute: 1, perDay: 1_000_000 });
  check('same tenant, same bucket: second request in the window is blocked', first === true && second === false);
  check('same tenant, DIFFERENT bucket: not blocked by the other bucket\'s window', thirdOtherBucket === true);
}

check('DEFAULT_LIMITS defines all three buckets this codebase rate-limits', ['ask', 'ingest', 'read'].every((b) => DEFAULT_LIMITS[b]?.perMinute > 0 && DEFAULT_LIMITS[b]?.perDay > 0));
eq('ask defaults match spec (30/min, 500/day)', DEFAULT_LIMITS.ask, { perMinute: 30, perDay: 500 });
eq('ingest defaults match spec (20/min, 300/day)', DEFAULT_LIMITS.ingest, { perMinute: 20, perDay: 300 });
eq('read defaults match spec (120/min, 5000/day)', DEFAULT_LIMITS.read, { perMinute: 120, perDay: 5000 });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll API key / rate limit checks passed.');
process.exit(failures ? 1 : 0);
