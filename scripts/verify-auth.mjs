/**
 * Unit tests for multi-user auth: claim-reading (both Clerk token shapes, no
 * org, malformed input), hasShop, requireRole, and requireAuth's wiring of
 * all of it together with a mocked verifyToken.
 *
 * No database, no network — requireAuth's `verify` dependency is injected
 * (see api/_lib/auth.js's requireAuth signature) rather than mocking
 * @clerk/backend's module internals, and the one org-present case that would
 * otherwise touch Postgres (upsertMember) is exercised with
 * NEON_CONNECTION_STRING deliberately unset, asserting that failure is
 * swallowed rather than avoiding it.
 *
 *   node scripts/verify-auth.mjs
 */
import { AuthError, deriveAuth, hasShop, requireAuth, requireRole } from '../api/_lib/auth.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ============================================================ deriveAuth */
/* ------------------------- v2 ("compact") session token claims */
// https://clerk.com/docs/guides/sessions/session-tokens — org data under a
// single `o` claim: { id, slg, rol, per, fpm }, `rol` with NO "org:" prefix.

{
  const auth = deriveAuth({ sub: 'user_1', o: { id: 'org_1', slg: 'acme', rol: 'admin' } });
  eq('v2: userId', auth.userId, 'user_1');
  eq('v2: orgId', auth.orgId, 'org_1');
  eq('v2: admin role, no prefix', auth.orgRole, 'admin');
  eq('v2: tenantId is the org', auth.tenantId, 'org_1');
}
{
  const auth = deriveAuth({ sub: 'user_1', o: { id: 'org_1', rol: 'member' } });
  eq('v2: member role', auth.orgRole, 'member');
}
{
  // A shop-defined custom role — not literally 'admin' — collapses to the
  // least-privileged bucket rather than being guessed at.
  const auth = deriveAuth({ sub: 'user_1', o: { id: 'org_1', rol: 'billing_manager' } });
  eq('v2: unrecognized custom role -> member (least privilege)', auth.orgRole, 'member');
}

/* ------------------------- v1 (legacy) session token claims */
// Deprecated 2025-04-14 but still honored: org_id/org_role/org_slug as
// top-level claims, org_role WITH the "org:" prefix.

{
  const auth = deriveAuth({ sub: 'user_2', org_id: 'org_2', org_role: 'org:admin' });
  eq('v1: orgId', auth.orgId, 'org_2');
  eq('v1: "org:" prefix stripped, admin', auth.orgRole, 'admin');
}
{
  const auth = deriveAuth({ sub: 'user_2', org_id: 'org_2', org_role: 'org:member' });
  eq('v1: "org:" prefix stripped, member', auth.orgRole, 'member');
}
{
  // A shop-defined custom role on the legacy (v1, "org:"-prefixed) token
  // shape collapses to the least-privileged bucket, same as the v2 case
  // above — this is the fallback the v2 test already covers, extended to
  // the other claim shape so both token generations are exercised.
  const auth = deriveAuth({ sub: 'user_2b', org_id: 'org_2b', org_role: 'org:billing_manager' });
  eq('v1: unrecognized custom role (with "org:" prefix) -> member (least privilege)', auth.orgRole, 'member');
}
{
  // Both shapes present (should never happen for real, but the function must
  // not crash, and it prefers the explicit legacy field when it's there).
  const auth = deriveAuth({ sub: 'user_2', org_id: 'org_legacy', org_role: 'org:admin', o: { id: 'org_v2', rol: 'member' } });
  eq('both shapes present: legacy org_id wins', auth.orgId, 'org_legacy');
  eq('both shapes present: legacy org_role wins', auth.orgRole, 'admin');
}

/* ------------------------- no organization -> the solo fallback */

{
  const auth = deriveAuth({ sub: 'user_3' });
  eq('no org: orgId is null', auth.orgId, null);
  eq('no org: orgRole is null', auth.orgRole, null);
  eq('no org: tenantId falls back to user_<id>', auth.tenantId, 'user_user_3');
  check('no org: hasShop is false', !hasShop(auth));
}

/* ------------------------- malformed / defensive input */

eq('null claims -> null (no crash)', deriveAuth(null), null);
eq('undefined claims -> null', deriveAuth(undefined), null);
eq('missing sub -> null', deriveAuth({ o: { id: 'org_1', rol: 'admin' } }), null);
eq('empty-string sub -> null', deriveAuth({ sub: '' }), null);
eq('non-string sub -> null', deriveAuth({ sub: 12345 }), null);

{
  // A blank org id must not masquerade as a real (falsy-but-truthy) tenant key.
  const auth = deriveAuth({ sub: 'user_4', org_id: '   ' });
  eq('whitespace-only org_id treated as absent', auth.orgId, null);
  eq('whitespace-only org_id: tenant falls back to solo', auth.tenantId, 'user_user_4');
}
{
  // `o` present but not an object — must not throw on `o?.id`.
  const auth = deriveAuth({ sub: 'user_5', o: 'not-an-object' });
  check('malformed `o` claim does not throw', auth !== null);
  eq('malformed `o` claim: no org', auth.orgId, null);
}
{
  const auth = deriveAuth({ sub: 'user_6', o: { id: 'org_6' /* no rol at all */ } });
  eq('org present, role claim missing -> orgRole null (not "member" by default)', auth.orgRole, null);
  check('org present, role missing: still has a shop', hasShop(auth));
}

/* ------------------------- email is optional, never load-bearing */

{
  const withEmail = deriveAuth({ sub: 'user_7', email: 'tech@example.com' });
  eq('email claim is read when present', withEmail.email, 'tech@example.com');
  const withoutEmail = deriveAuth({ sub: 'user_8' });
  check('email is undefined, not a crash or empty string, when absent', withoutEmail.email === undefined);
}

/* ================================================================ hasShop */

check('hasShop true for an org tenant', hasShop({ orgId: 'org_1' }));
check('hasShop false for null orgId', !hasShop({ orgId: null }));
check('hasShop false for undefined auth', !hasShop(undefined));
check('hasShop false for null auth', !hasShop(null));

/* ============================================================ requireRole */

check('admin satisfies an admin requirement', (() => {
  try { requireRole({ orgRole: 'admin' }, 'admin'); return true; } catch { return false; }
})());
check('admin satisfies a member requirement (outranks it)', (() => {
  try { requireRole({ orgRole: 'admin' }, 'member'); return true; } catch { return false; }
})());
check('member does NOT satisfy an admin requirement', (() => {
  try { requireRole({ orgRole: 'member' }, 'admin'); return false; } catch (e) { return e instanceof AuthError; }
})());
{
  let thrown = null;
  try { requireRole({ orgRole: 'member' }, 'admin'); } catch (e) { thrown = e; }
  check('the rejection is a 403, not a generic 401', thrown?.status === 403);
}
check('no shop at all does not satisfy a member requirement', (() => {
  try { requireRole({ orgRole: null }, 'member'); return false; } catch (e) { return e instanceof AuthError; }
})());
check('a null auth does not satisfy any role requirement', (() => {
  try { requireRole(null, 'member'); return false; } catch (e) { return e instanceof AuthError; }
})());
check('an unknown role name is a programming error, not a 403', (() => {
  try { requireRole({ orgRole: 'admin' }, 'owner'); return false; }
  catch (e) { return !(e instanceof AuthError); }
})());

/* ============================================================ requireAuth */
// `verify` is injected (see requireAuth's second parameter) so these run with
// no network call and no real Clerk secret key.

const savedSecret = process.env.CLERK_SECRET_KEY;
const savedNeon = process.env.NEON_CONNECTION_STRING;

async function throws(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

{
  const err = await throws(() => requireAuth({ headers: {} }));
  check('no Authorization header -> AuthError', err instanceof AuthError);
  eq('no Authorization header -> 401', err?.status, 401);
}
{
  const err = await throws(() => requireAuth({ headers: { authorization: 'Basic xyz' } }));
  check('a non-Bearer scheme is treated as no token', err instanceof AuthError);
}

{
  delete process.env.CLERK_SECRET_KEY;
  const err = await throws(() =>
    requireAuth({ headers: { authorization: 'Bearer t' } }, { verify: async () => ({ sub: 'user_1' }) })
  );
  check('missing CLERK_SECRET_KEY -> AuthError', err instanceof AuthError);
  eq('missing CLERK_SECRET_KEY -> 500, not 401 (a config problem, not a bad session)', err?.status, 500);
}

process.env.CLERK_SECRET_KEY = 'test_secret_key';

{
  const err = await throws(() =>
    requireAuth(
      { headers: { authorization: 'Bearer bad' } },
      { verify: async () => { throw new Error('signature mismatch'); } }
    )
  );
  check('verify() rejecting -> AuthError', err instanceof AuthError);
  eq('a bad token -> 401', err?.status, 401);
}

{
  const err = await throws(() =>
    requireAuth(
      { headers: { authorization: 'Bearer t' } },
      { verify: async () => ({}) } // no `sub` at all
    )
  );
  check('claims with no subject -> AuthError, not a crash', err instanceof AuthError);
}

{
  // No org on the token: requireAuth must resolve WITHOUT ever touching
  // upsertMember/Postgres (hasShop is false), so this must succeed even with
  // no NEON_CONNECTION_STRING configured at all.
  delete process.env.NEON_CONNECTION_STRING;
  const auth = await requireAuth(
    { headers: { authorization: 'Bearer t' } },
    { verify: async () => ({ sub: 'user_solo' }) }
  );
  eq('solo user: tenantId', auth.tenantId, 'user_user_solo');
  check('solo user: hasShop is false', !hasShop(auth));
}

{
  // WITH an org: requireAuth calls upsertMember, which needs Postgres.
  // NEON_CONNECTION_STRING is deliberately still unset here — the point of
  // this test is that a membership-write failure must never fail the
  // request itself.
  let resolved;
  let thrown = null;
  try {
    resolved = await requireAuth(
      { headers: { authorization: 'Bearer t' } },
      { verify: async () => ({ sub: 'user_shop', o: { id: 'org_9', rol: 'admin' } }) }
    );
  } catch (e) {
    thrown = e;
  }
  check('org present + upsertMember failing (no DB configured) still resolves', thrown === null, String(thrown));
  eq('org present: tenantId is the org', resolved?.tenantId, 'org_9');
  eq('org present: orgRole carried through', resolved?.orgRole, 'admin');
}

if (savedSecret === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = savedSecret;
if (savedNeon === undefined) delete process.env.NEON_CONNECTION_STRING; else process.env.NEON_CONNECTION_STRING = savedNeon;

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
