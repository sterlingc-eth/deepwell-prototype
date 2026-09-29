/**
 * ROUND 26 — plan tiers. Offline (PGlite + fake Clerk), no network, no Anthropic, no real Stripe.
 *
 *   1. Login caps 2 / 5 / 10 / null (Fleet 11+); page allowances unchanged.
 *   2. Seat math: the ONE owner is excluded, extra admins count, pending invitations count.
 *   3. Clerk maxAllowedMemberships sync: cap + 1 (Fleet 0), graceful on rejection / outage, wired into the
 *      Stripe webhook (plan change + trial start) and never able to fail billing.
 *   4. Server-side invite guard (blocks at cap and when over cap; never removes anyone).
 *   5. Donovan: no per-plan allowance, hidden safety ceiling works, env-overridable, polite message.
 *   6. API access: key create + key use blocked below Fleet, allowed on Fleet.
 *   7. Pricing/copy: no "Unlimited" logins, the four login values, Donovan unlimited, API Fleet-only.
 *
 *   node scripts/verify-plan-tiers-r26.mjs
 */
delete process.env.STRIPE_SECRET_KEY;
delete process.env.CLERK_SECRET_KEY;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_r26_fixture';
process.env.NEON_CONNECTION_STRING = 'postgres://fixture_user:fixture_pw@db.fixture.invalid:5432/fixture?sslmode=require';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PLAN = await import('../api/_lib/plan.js');
const SEATS = await import('../api/_lib/seats.js');
const { PLAN_LIMITS } = PLAN;

/* ============================================================ 1. caps */
eq('login caps: Solo 2, Shop 5, Crew 10, Fleet null (11+)', ['solo', 'shop', 'crew', 'fleet'].map((t) => PLAN.loginCapForPlan(t)), [2, 5, 10, null]);
eq('loginCapForPlan: unknown / missing plan -> undefined (never enforced or synced)', [PLAN.loginCapForPlan(null), PLAN.loginCapForPlan('gold'), PLAN.loginCapForPlan(undefined)], [undefined, undefined, undefined]);
eq('document-scan page allowances are unchanged (750 / 2,000 / 5,000 / 10,000)', ['solo', 'shop', 'crew', 'fleet'].map((t) => PLAN_LIMITS[t].pagesPerMonth), [750, 2000, 5000, 10000]);
check('the old technicians / asksPerMonth keys are gone from every plan', ['solo', 'shop', 'crew', 'fleet'].every((t) => !('technicians' in PLAN_LIMITS[t]) && !('asksPerMonth' in PLAN_LIMITS[t])));
eq('clientLimits ignores a stale stored snapshot (old technicians/asksPerMonth) and carries the add-on flag', PLAN.clientLimits({ plan: 'shop', limits: { technicians: 4, asksPerMonth: 9000, outreachAuto: true } }), { logins: 5, documentsStored: 100000, pagesPerMonth: 2000, outreachAuto: true });
eq('clerkLimitForCap: cap + 1 for the owner, Fleet -> 0 (unlimited)', [2, 5, 10, null].map((c) => SEATS.clerkLimitForCap(c)), [3, 6, 11, 0]);

/* ============================================================ 2. seat math */
const M = (userId, role = 'org:member', createdAt = 1) => ({ role, createdAt, publicUserData: { userId } });
const INV = (status = 'pending') => ({ status });
{
  const org = { createdBy: 'user_owner' };
  const members = [M('user_owner', 'org:admin', 1), M('user_a', 'org:member', 2), M('user_b', 'org:member', 3)];
  const u = SEATS.computeSeatUsage({ cap: 5, ownerUserId: SEATS.resolveOwnerUserId(org, members), memberships: members, invitations: [] });
  eq('owner (org.createdBy) is excluded: owner + 2 members = 2 of 5 used', [u.members, u.used, u.atCap], [2, 2, false]);
  eq('label reads "2 of 5 logins used (owner not counted)"', u.label, '2 of 5 logins used (owner not counted)');

  const withAdmin = [...members, M('user_admin2', 'org:admin', 4)];
  eq('an EXTRA admin counts (only the one owner is free)', SEATS.computeSeatUsage({ cap: 5, ownerUserId: 'user_owner', memberships: withAdmin, invitations: [] }).used, 3);

  const pend = SEATS.computeSeatUsage({ cap: 5, ownerUserId: 'user_owner', memberships: members, invitations: [INV(), INV(), INV('revoked'), INV('accepted')] });
  eq('pending invitations count (revoked / accepted do not)', [pend.pending, pend.used], [2, 4]);
  eq('3 members + 2 pending = 4 of 5 -> not at cap, 1 remaining', [pend.atCap, pend.remaining], [false, 1]);

  const atCap = SEATS.computeSeatUsage({ cap: 2, ownerUserId: 'user_owner', memberships: members, invitations: [] });
  eq('exactly at the cap -> atCap, not overCap', [atCap.atCap, atCap.overCap], [true, false]);
  const over = SEATS.computeSeatUsage({ cap: 2, ownerUserId: 'user_owner', memberships: withAdmin, invitations: [INV()] });
  eq('a downgraded org (4 used on a cap of 2) -> atCap + overCap, remaining 0, never negative', [over.used, over.atCap, over.overCap, over.remaining], [4, true, true, 0]);
  const fleet = SEATS.computeSeatUsage({ cap: null, ownerUserId: 'user_owner', memberships: withAdmin, invitations: [INV()] });
  eq('Fleet: no cap -> never at cap', [fleet.atCap, fleet.overCap, fleet.remaining, fleet.label], [false, false, null, '4 logins used (owner not counted)']);

  eq('owner fallback: no createdBy -> the earliest-joined ADMIN is the owner', SEATS.resolveOwnerUserId({}, [M('u_late', 'org:admin', 9), M('u_member', 'org:member', 1), M('u_early', 'org:admin', 2)]), 'u_early');
  eq('owner fallback: no createdBy and no admin -> null (nobody is excluded)', SEATS.resolveOwnerUserId({}, [M('u1')]), null);
  eq('owner fallback: createdBy is NOT a member any more (left / staff-created org) -> earliest admin is the owner, so exactly one login is still free',
    SEATS.resolveOwnerUserId({ createdBy: 'user_gone' }, [M('u_late', 'org:admin', 9), M('u_early', 'org:admin', 2), M('u_m', 'org:member', 1)]), 'u_early');
  eq('owner: createdBy still wins while they ARE a member (even if another admin joined earlier)', SEATS.resolveOwnerUserId({ createdBy: 'u_late' }, [M('u_early', 'org:admin', 2), M('u_late', 'org:admin', 9)]), 'u_late');
  eq('owner: createdBy gone and no admin -> returns createdBy (matches nobody, so nobody is excluded)', SEATS.resolveOwnerUserId({ createdBy: 'user_gone' }, [M('u1')]), 'user_gone');
  {
    const ms = [M('u_early', 'org:admin', 2), M('u_a', 'org:member', 3)];
    const o = SEATS.resolveOwnerUserId({ createdBy: 'user_gone' }, ms);
    eq('creator left: exactly ONE member is excluded from the count (never zero, never two)', SEATS.computeSeatUsage({ cap: 5, ownerUserId: o, memberships: ms, invitations: [] }).used, 1);
  }
  eq('no owner known -> everyone counts', SEATS.computeSeatUsage({ cap: 5, ownerUserId: null, memberships: members, invitations: [] }).used, 3);
}

/* ============================================================ fake Clerk */
function fakeClerk({ org = { createdBy: 'user_owner', maxAllowedMemberships: 3 }, members = [], invitations = [], updateError = null, createError = null } = {}) {
  const calls = { update: [], invite: [], getOrg: 0 };
  return {
    calls,
    organizations: {
      async getOrganization() { calls.getOrg++; return { ...org }; },
      async updateOrganization(id, params) {
        calls.update.push({ id, params });
        if (updateError) throw updateError;
        org = { ...org, ...params };
        return org;
      },
      async getOrganizationMembershipList() { return { data: members, totalCount: members.length }; },
      async getOrganizationInvitationList() { return { data: invitations, totalCount: invitations.length }; },
      async createOrganizationInvitation(params) {
        calls.invite.push(params);
        if (createError) throw createError;
        return { id: 'orginv_1' };
      },
    },
  };
}
const clerkErr = (status, code, message) => Object.assign(new Error(message), { status, errors: [{ code, message }] });
const quiet = async (fn) => {
  const logs = [];
  const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try { return { value: await fn(), logs }; } finally { console.error = orig; }
};

/* ============================================================ 3. Clerk sync */
{
  SEATS._resetSyncThrottle();
  for (const [plan, want] of [['solo', 3], ['shop', 6], ['crew', 11], ['fleet', 0]]) {
    const clerk = fakeClerk({ org: { createdBy: 'o', maxAllowedMemberships: 999 } });
    const r = await SEATS.syncOrgMemberLimit({ orgId: `org_${plan}`, plan, clerk, force: true });
    eq(`sync ${plan}: maxAllowedMemberships set to ${want} (${want === 0 ? 'unlimited' : 'cap + 1'})`, [r.action, clerk.calls.update[0]?.params], ['updated', { maxAllowedMemberships: want }]);
  }
  const same = fakeClerk({ org: { createdBy: 'o', maxAllowedMemberships: 6 } });
  eq('sync is a no-op when Clerk already has the right value (no write)', [(await SEATS.syncOrgMemberLimit({ orgId: 'org_x', plan: 'shop', clerk: same, force: true })).action, same.calls.update.length], ['unchanged', 0]);

  const c2 = fakeClerk({ org: { createdBy: 'o', maxAllowedMemberships: 1 } });
  await SEATS.syncOrgMemberLimit({ orgId: 'org_thr', plan: 'crew', clerk: c2 });
  const thr = await SEATS.syncOrgMemberLimit({ orgId: 'org_thr', plan: 'crew', clerk: c2 });
  eq('lazy sync is throttled per org (second call within the window does nothing)', [thr.action, c2.calls.update.length], ['throttled', 1]);
  eq('...but force:true (webhook path) always syncs', (await SEATS.syncOrgMemberLimit({ orgId: 'org_thr', plan: 'crew', clerk: fakeClerk({ org: { maxAllowedMemberships: 1 } }), force: true })).action, 'updated');

  eq('a personal (non-org) tenant is skipped', (await SEATS.syncOrgMemberLimit({ orgId: 'user_123', plan: 'solo', clerk: fakeClerk() })).action, 'skipped');
  eq('no plan on file -> skipped (nothing to enforce)', (await SEATS.syncOrgMemberLimit({ orgId: 'org_np', plan: null, clerk: fakeClerk() })).action, 'skipped');

  // Clerk refuses the value (e.g. above the instance's own plan limit): logged, not thrown.
  const rejecting = fakeClerk({ updateError: clerkErr(422, 'organization_membership_limit_exceeded', 'Maximum memberships exceeds your plan limit') });
  const rej = await quiet(() => SEATS.syncOrgMemberLimit({ orgId: 'org_rej', plan: 'crew', clerk: rejecting, force: true }));
  eq('Clerk 422 rejection -> {ok:false, action:"rejected"} and NO throw', [rej.value.ok, rej.value.action, rej.value.clerkStatus], [false, 'rejected', 422]);
  check('...and the rejection is logged with the "raise the Clerk member limit" hint', rej.logs.some((l) => /Clerk rejected the value/.test(l) && /org_rej/.test(l)), rej.logs.join(' | '));
  const down = await quiet(() => SEATS.syncOrgMemberLimit({ orgId: 'org_dn', plan: 'crew', clerk: fakeClerk({ updateError: Object.assign(new Error('socket hang up'), { status: 503 }) }), force: true }));
  eq('Clerk outage (503) -> {ok:false, action:"error"}, no throw', [down.value.ok, down.value.action], [false, 'error']);
  const none = await SEATS.syncOrgMemberLimit({ orgId: 'org_nokey', plan: 'shop', force: true });
  eq('no CLERK_SECRET_KEY configured -> {ok:false, "clerk-unavailable"}, no throw', [none.ok, none.reason], [false, 'clerk-unavailable']);

  // A Clerk 4xx will keep failing: the lazy (non-forced) path must not re-send it on every Team-screen open.
  SEATS._resetSyncThrottle();
  const doomed = fakeClerk({ org: { createdBy: 'o', maxAllowedMemberships: 1 }, updateError: clerkErr(422, 'organization_membership_limit_exceeded', 'exceeds plan limit') });
  await quiet(async () => {
    await SEATS.syncOrgMemberLimit({ orgId: 'org_doom', plan: 'crew', clerk: doomed });
    const again = await SEATS.syncOrgMemberLimit({ orgId: 'org_doom', plan: 'crew', clerk: doomed });
    eq('a rejected lazy sync is throttled too (1 Clerk write, then "throttled") — no spam', [doomed.calls.update.length, again.action], [1, 'throttled']);
    await SEATS.syncOrgMemberLimit({ orgId: 'org_doom', plan: 'crew', clerk: doomed, force: true });
    eq('...while force:true (webhook / reconcile) still retries', doomed.calls.update.length, 2);
  });
  {
    const hung = await SEATS.withTimeout(new Promise(() => {}), 20, 'Clerk').then(() => 'resolved', (e) => e.message);
    eq('withTimeout rejects a hung Clerk call instead of stalling the webhook', hung, 'Clerk timed out after 20ms');
    eq('withTimeout passes a fast result straight through', await SEATS.withTimeout(Promise.resolve(7), 1000), 7);
  }

  // Which tiers fit under Clerk's OWN per-org member limit (owner: 5 or 20).
  const fits = (limit) => Object.fromEntries(['solo', 'shop', 'crew', 'fleet'].map((t) => {
    const need = SEATS.clerkLimitForCap(PLAN.loginCapForPlan(t));
    return [t, need === 0 ? false : need <= limit];
  }));
  eq('with a Clerk limit of 5: only Solo (2+owner=3) fits — Shop (6), Crew (11) and Fleet do not', fits(5), { solo: true, shop: false, crew: false, fleet: false });
  eq('with a Clerk limit of 20: Solo, Shop and Crew fit — only Fleet (no DeepWell cap) exceeds it', fits(20), { solo: true, shop: true, crew: true, fleet: false });
  console.log(`INFO  Clerk member-limit requirements (per org, owner included): Solo 3, Shop 6, Crew 11, Fleet unlimited (set the Clerk limit to at least the largest Fleet team you sell).`);
}

/* ============================================================ 4. invite guard */
{
  const owner = M('user_owner', 'org:admin', 1);
  const shopMembers = [owner, M('u1', 'org:member', 2), M('u2', 'org:member', 3), M('u3', 'org:member', 4), M('u4', 'org:member', 5)];
  // Shop cap 5: owner + 4 members = 4 used -> one seat left.
  let clerk = fakeClerk({ members: shopMembers });
  let r = await SEATS.guardedInvite({ orgId: 'org_g', plan: 'shop', email: 'new@shop.com', clerk, inviterUserId: 'user_owner' });
  eq('under the cap: invite is created through Clerk', [r.ok, clerk.calls.invite.length, clerk.calls.invite[0]?.emailAddress, clerk.calls.invite[0]?.role], [true, 1, 'new@shop.com', 'org:member']);
  eq('...and the returned seat view already includes it (5 of 5, at cap)', [r.seats.used, r.seats.atCap, r.seats.label], [5, true, '5 of 5 logins used (owner not counted)']);

  clerk = fakeClerk({ members: shopMembers, invitations: [INV()] });
  r = await SEATS.guardedInvite({ orgId: 'org_g', plan: 'shop', email: 'x@shop.com', clerk });
  eq('a PENDING invitation uses the last seat: 4 members + 1 pending = 5 -> next invite blocked (402, Clerk never called)', [r.ok, r.status, clerk.calls.invite.length], [false, 402, 0]);
  check('...with a clear upgrade message', /up to 5 logins/.test(r.error) && /Upgrade/.test(r.error) && /owner account isn't counted/.test(r.error), r.error);

  const solo = fakeClerk({ members: [owner, M('u1'), M('u2', 'org:admin', 3)] });
  r = await SEATS.guardedInvite({ orgId: 'org_s', plan: 'solo', email: 'y@shop.com', clerk: solo });
  eq('Solo: owner + member + EXTRA ADMIN = 2 used of 2 -> blocked (the extra admin counts)', [r.ok, r.status], [false, 402]);

  const overCap = fakeClerk({ members: [owner, M('a'), M('b'), M('c'), M('d')] });
  r = await SEATS.guardedInvite({ orgId: 'org_o', plan: 'solo', email: 'z@shop.com', clerk: overCap });
  eq('grandfathered over-cap org (4 used on Solo): new invites blocked, nobody removed, no member/org writes', [r.ok, r.status, overCap.calls.update.length, r.seats.overCap], [false, 402, 0, true]);

  const fleetClerk = fakeClerk({ members: Array.from({ length: 30 }, (_, i) => M(`f${i}`)) });
  r = await SEATS.guardedInvite({ orgId: 'org_f', plan: 'fleet', email: 'fleet@shop.com', clerk: fleetClerk });
  eq('Fleet: no DeepWell cap — 30 logins used, invite still allowed', [r.ok, fleetClerk.calls.invite.length], [true, 1]);

  r = await SEATS.guardedInvite({ orgId: 'org_n', plan: null, email: 'a@b.co', clerk: fakeClerk() });
  eq('no plan -> 402 "Choose a plan"', [r.ok, r.status], [false, 402]);
  r = await SEATS.guardedInvite({ orgId: 'org_n', plan: 'shop', email: 'not-an-email', clerk: fakeClerk() });
  eq('bad email -> 400', [r.ok, r.status], [false, 400]);
  const adm = fakeClerk({ members: [owner] });
  await SEATS.guardedInvite({ orgId: 'org_a', plan: 'shop', email: 'boss@shop.com', role: 'admin', clerk: adm });
  eq('admin role is passed through as org:admin', adm.calls.invite[0]?.role, 'org:admin');
  const quota = fakeClerk({ members: [owner], createError: clerkErr(403, 'organization_membership_quota_exceeded', 'Membership quota exceeded') });
  r = await SEATS.guardedInvite({ orgId: 'org_q', plan: 'crew', email: 'q@shop.com', clerk: quota });
  eq('Clerk quota rejection on create -> 402 with the upgrade message (not a 500)', [r.ok, r.status], [false, 402]);
}

/* ============================================================ 5. Donovan: no allowance, hidden safety ceiling */
{
  const RL = await import('../api/_lib/rateLimit.js');
  const perMonth = PLAN.donovanSafetyPerMonth({});
  const gate = (plan, asks, env = {}) => PLAN.gateAsk({ plan, billing_status: 'active' }, { documentsStored: 10, asksThisMonth: asks }, new Date(), env);
  check('a heavy month (15,000 asks) is allowed on EVERY plan — Donovan is unlimited', ['solo', 'shop', 'crew', 'fleet'].every((p) => gate(p, 15000).allowed));
  const hit = gate('solo', perMonth);
  eq('the safety ceiling still stops a runaway (429, scope safety)', [hit.allowed, hit.status, hit.scope], [false, 429, 'safety']);
  check('...with a polite support message and never an upgrade prompt', /unusually high usage/i.test(hit.error) && /support@deepwelltechnology\.com/.test(hit.error) && !/upgrade|plan|allowance|limit/i.test(hit.error), hit.error);
  check('...identical for every plan', ['shop', 'crew', 'fleet'].every((p) => gate(p, perMonth).allowed === false));
  check('monthly ceiling is env-overridable (DONOVAN_SAFETY_ASKS_PER_MONTH)', gate('crew', 60, { DONOVAN_SAFETY_ASKS_PER_MONTH: '50' }).allowed === false && gate('crew', 40, { DONOVAN_SAFETY_ASKS_PER_MONTH: '50' }).allowed);

  eq('daily ask ceiling default is flat and generous (3000/day, same on every plan)', ['solo', 'shop', 'crew', 'fleet'].map((p) => RL.limitsFromTenantContext({ plan: p, pagesPerMonth: PLAN_LIMITS[p].pagesPerMonth }, 'ask').perDay), [3000, 3000, 3000, 3000]);
  eq('daily ask ceiling is env-overridable (RATE_LIMIT_ASK_PER_DAY)', RL.envLimits('ask', { RATE_LIMIT_ASK_PER_DAY: '1234' }).perDay, 1234);
  eq('a tenant-specific override still wins over the flat default', RL.limitsFromTenantContext({ plan: 'solo', ask: { perDay: 77 } }, 'ask').perDay, 77);
  check('rateLimit.js no longer derives an ask allowance from PLAN_LIMITS', !/asksPerMonth|PLAN_DAILY_ASKS/.test(read('api/_lib/rateLimit.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  check('no plan-table ask allowance or "upgrade" wording reaches the client billing code', !/asksPerMonth|asks_exhausted|asks_warn/.test(read('src/services/billingClient.ts')));
}

/* ============================================================ 7 (static, before the DB section): pricing copy */
{
  const html = read('index.html');
  const plans = html.slice(html.indexOf('<section id="plans">'), html.indexOf('</section>', html.indexOf('<section id="plans">')));
  const rows = (label) => [...plans.matchAll(new RegExp(`<li><span>${label}</span><b>([^<]*)</b></li>`, 'g'))].map((m) => m[1]);
  eq('pricing: Logins rows read up to 2 / up to 5 / up to 10 / 11+', rows('Logins'), ['up to 2', 'up to 5', 'up to 10', '11+']);
  check('pricing: nothing says "Unlimited" for logins', !/Logins<\/span><b>Unlimited/.test(plans) && !/unlimited logins/i.test(plans));
  eq('pricing: Donovan row is "Unlimited" on all four tiers', rows('Donovan'), ['Unlimited', 'Unlimited', 'Unlimited', 'Unlimited']);
  eq('pricing: API access — Fleet "Yes", the other three "—"', rows('API access'), ['—', '—', '—', 'Yes']);
  check('pricing: the "owner account doesn\'t count toward logins" note is present', /The owner account doesn't count toward logins\./.test(plans));
  check('pricing: the old technician-count rows and usage-allowance wording are gone', !/<span>Technicians<\/span>/.test(plans) && !/usage allowance|Donovan usage/i.test(plans));
  eq('pricing: prices unchanged ($99 / $199 / $399 / $899+)', [...plans.matchAll(/<h3>\$(\d+)<span class="per">(\+?)\/mo/g)].map((m) => m[1] + m[2]), ['99', '199', '399', '899+']);
  eq('pricing: page allowances unchanged', rows('New pages / month'), ['750', '2,000', '5,000', '10,000']);

  const stale = /unlimited logins|donovan usage allowance|usage allowance|asks per month|Donovan usage \/ month|per technician|1 technician|2[–-]4 technicians|5[–-]10 technicians/i;
  const scanned = ['index.html', 'public/terms.html', 'public/get/index.html', 'public/industries/hvac.html', 'public/industries/electrical.html', 'public/industries/plumbing.html', 'public/industries/property-management.html', 'docs/SECURITY.md', 'README.md',
    'src/screens/BillingScreen.tsx', 'src/screens/TeamScreen.tsx', 'src/services/billingClient.ts', 'src/services/teamClient.ts', 'src/screens/AskScreen.tsx'];
  check('no stale plan claim anywhere in public/, index.html, terms, docs or the billing/team screens', scanned.every((f) => !stale.test(read(f))), scanned.filter((f) => stale.test(read(f))).join(', '));
  const team = read('src/screens/TeamScreen.tsx');
  check('Team screen: the "Clerk itself does not enforce it" note is gone; invites go through the guarded form', !/does not enforce/i.test(team) && /billingClient\.invite/.test(team) && /membersPageInviteButton/.test(team));
  const pkg = JSON.parse(read('package.json'));
  check('wired into npm scripts and verify:all', pkg.scripts['verify:plan-tiers-r26']?.includes('verify-plan-tiers-r26.mjs') && pkg.scripts['verify:all'].includes('verify:plan-tiers-r26'));
}

/* ============================================================ database-backed: PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log(`${passes} checks passed${failures ? `, ${failures} FAILED` : ''} (database-backed checks skipped).`);
  process.exit(failures ? 1 : 0);
}

const cfgDir = path.join(ROOT, 'M3-config');
const allMigrations = fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort();
const lite = new PGlite({ extensions: contrib });
for (const f of allMigrations) {
  try { await lite.exec(read(`M3-config/${f}`)); } catch { /* same harness quirk tolerance as verify-prod-hardening */ }
}
try { await lite.exec(read('M3-config/01b-app-role.sql')); } catch { /* pre-existing harness quirk */ }

const pgMod = (await import('pg')).default;
{
  let tail = Promise.resolve();
  const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
  pgMod.Pool.prototype.connect = async function connect() {
    const release = await lock();
    await lite.exec('SET ROLE deepwell_rls');
    return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
  };
  pgMod.Pool.prototype.query = async function query(sql, params) {
    const release = await lock();
    try { return await lite.query(sql, params); } finally { release(); }
  };
}

const RS = await import('../api/_lib/recordsStore.js');
const BILL = await import('../api/billing.js');
const KEYS = await import('../api/_lib/routes/keys.js');
const AK = await import('../api/_lib/apiKeyAuth.js');
const RL = await import('../api/_lib/rateLimit.js');

/* ---------- 3b. Stripe webhook -> Clerk sync (plan change + trial start), never able to fail billing */
{
  const CUS = 'cus_r26_1';
  const tenantKey = 'org_r26_billing';
  const tenantId = (await RS.getTenantContext(tenantKey, 'R26 Shop')).id;
  await lite.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [CUS, tenantId]);
  let seq = 0;
  const post = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_r26_${++seq}`, type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`, 'utf8').digest('hex');
    const req = Readable.from([Buffer.from(payload, 'utf8')]);
    req.method = 'POST'; req.query = { action: 'webhook' }; req.headers = { 'stripe-signature': `t=${t},v1=${sig}` };
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end() {} };
    const logs = [];
    const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
    try { await BILL.default(req, res); } finally { console.error = orig; }
    return { res, logs };
  };
  const item = (plan) => ({ price: { lookup_key: `${plan}_monthly`, metadata: { plan } } });
  const sub = (over) => ({ id: 'sub_r26', customer: CUS, status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, trial_end: null, cancel_at_period_end: false, items: { data: [item('solo')] }, ...over });

  let clerk = fakeClerk({ org: { createdBy: 'o', maxAllowedMemberships: 1 } });
  SEATS._setClerkForTest(clerk);
  let r = await post('customer.subscription.created', sub({ status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 30 * 86400 }));
  eq('trial start (Solo): webhook 200 and the Clerk org limit is set to 3 (2 logins + owner)', [r.res.statusCode, clerk.calls.update.at(-1)], [200, { id: tenantKey, params: { maxAllowedMemberships: 3 } }]);
  r = await post('customer.subscription.updated', sub({ items: { data: [item('crew')] } }));
  eq('plan change to Crew: Clerk org limit becomes 11', [r.res.statusCode, clerk.calls.update.at(-1)?.params], [200, { maxAllowedMemberships: 11 }]);
  r = await post('customer.subscription.updated', sub({ items: { data: [item('fleet')] } }));
  eq('plan change to Fleet: Clerk org limit becomes 0 (no DeepWell cap)', [r.res.statusCode, clerk.calls.update.at(-1)?.params], [200, { maxAllowedMemberships: 0 }]);
  r = await post('invoice.paid', { customer: CUS, subscription: 'sub_r26' });
  eq('a non-plan event (invoice.paid) makes no Clerk call', clerk.calls.update.length, 3);

  // Clerk rejects the value: billing still applies, webhook still 200, error logged.
  clerk = fakeClerk({ org: { createdBy: 'o', maxAllowedMemberships: 1 }, updateError: clerkErr(422, 'organization_membership_limit_exceeded', 'exceeds your Clerk plan limit') });
  SEATS._setClerkForTest(clerk);
  r = await post('customer.subscription.updated', sub({ items: { data: [item('shop')] } }));
  const row = (await lite.query(`SELECT plan, billing_status FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  eq('Clerk REJECTS the limit: webhook still 200 handled, plan still applied (billing never breaks)', [r.res.statusCode, r.res.body?.handled, row.plan, row.billing_status], [200, true, 'shop', 'active']);
  check('...and the rejection is logged for the owner to see', r.logs.some((l) => /Clerk rejected the value/.test(l)), r.logs.join(' | '));
  // Clerk unreachable entirely.
  SEATS._setClerkForTest({ organizations: { async getOrganization() { throw new Error('ECONNRESET'); }, async updateOrganization() { throw new Error('ECONNRESET'); } } });
  r = await post('customer.subscription.updated', sub({ items: { data: [item('crew')] } }));
  eq('Clerk DOWN: webhook still 200 handled', [r.res.statusCode, r.res.body?.handled], [200, true]);
  SEATS._setClerkForTest(null);
}

/* ---------- 5b. limit(): the daily safety ceiling answers politely, never "upgrade" */
{
  const key = 'org_r26_donovan';
  const tid = (await RS.getTenantContext(key, 'Donovan Shop')).id;
  await lite.query(`UPDATE tenants SET plan = 'fleet', limits = '{"ask": {"perDay": 3, "perMinute": 100}}'::jsonb WHERE id = $1`, [tid]);
  RS.bustTenantCache(tid);
  const mk = () => ({ headers: {}, res: { statusCode: 0, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } } });
  let last;
  const oks = [];
  for (let i = 0; i < 4; i++) {
    const { res } = mk();
    oks.push(await RL.limit({ headers: {} }, res, { tenantId: key }, 'ask'));
    last = res;
  }
  eq('the 4th ask over a (tiny test) daily ceiling is refused; the first three go through', oks, [true, true, true, false]);
  eq('...as a 429 with scope "safety"', [last.statusCode, last.body?.scope], [429, 'safety']);
  check('...and the body is the polite support message — no "upgrade", no plan talk', /unusually high usage/i.test(last.body?.error) && /support@deepwelltechnology\.com/.test(last.body?.error) && !/upgrade|plan/i.test(JSON.stringify(last.body)), JSON.stringify(last.body));
}

/* ---------- 6. API access: Fleet only (key create + key use) */
{
  const key = 'org_r26_api';
  const ctx = { tenantKey: key, tenantName: 'API Shop' };
  const tid = (await RS.getTenantContext(key, 'API Shop')).id;
  const setPlan = async (plan) => {
    await lite.query(`UPDATE tenants SET plan = $2, billing_status = 'active' WHERE id = $1`, [tid, plan]);
    RS.bustTenantCache(tid);
    const PL = await import('../api/_lib/plan.js');
    PL._resetBillingRowCache();
  };
  const auth = { userId: 'user_admin', orgId: key, orgRole: 'admin', tenantId: key };

  for (const plan of ['solo', 'shop', 'crew']) {
    await setPlan(plan);
    const out = await KEYS.createApiKey(ctx, auth, { name: 'ci', scopes: ['read'] });
    eq(`${plan}: key CREATE is refused with 403 "API access is included on the Fleet plan"`, [out.status, out.body.error, out.body.key], [403, 'API access is included on the Fleet plan', undefined]);
  }
  const count = (await lite.query(`SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1`, [tid])).rows[0].n;
  eq('no key row was written by any refused create', count, 0);

  await setPlan('fleet');
  const made = await KEYS.createApiKey(ctx, auth, { name: 'dispatch', scopes: ['read', 'ask'] });
  check('fleet: key create succeeds (201, key shown once)', made.status === 201 && /^dw_live_[0-9a-f]{64}$/.test(made.body.key), JSON.stringify(made.body).slice(0, 120));
  const auth2 = await AK.verifyApiKey(made.body.key);
  check('fleet: key USE authenticates as that tenant', auth2.viaKey === true && auth2.tenantId === key);

  // The key was minted on Fleet; now the shop drops to Shop: the existing key must stop working.
  await setPlan('shop');
  let err;
  try { await AK.verifyApiKey(made.body.key); } catch (e) { err = e; }
  eq('downgraded to Shop: the EXISTING key is refused with 403 and the Fleet message', [err?.status, err?.message], [403, 'API access is included on the Fleet plan']);
  await setPlan('solo');
  err = undefined;
  try { await AK.verifyApiKey(made.body.key); } catch (e) { err = e; }
  eq('on Solo: same 403', [err?.status, err?.message], [403, 'API access is included on the Fleet plan']);
  await setPlan('fleet');
  check('back on Fleet: the same key works again (nothing was revoked)', (await AK.verifyApiKey(made.body.key)).tenantId === key);
  await lite.query(`UPDATE tenants SET plan = NULL, billing_status = 'none' WHERE id = $1`, [tid]);
  RS.bustTenantCache(tid);
  (await import('../api/_lib/plan.js'))._resetBillingRowCache();
  err = undefined;
  try { await AK.verifyApiKey(made.body.key); } catch (e) { err = e; }
  eq('no plan at all: key refused with the same 403', [err?.status, err?.message], [403, 'API access is included on the Fleet plan']);
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED, ${passes} passed.`);
  process.exit(1);
}
console.log(`All ${passes} plan-tier (Round 26) checks passed.`);
process.exit(0);
