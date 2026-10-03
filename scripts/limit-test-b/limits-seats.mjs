/**
 * TESTER B (4): logins per plan. Pending invites counted, owner NOT counted, N-1 / N / N+1, concurrency, Clerk backstop.
 * Clerk is a hand-written fake (no network). Server guard under test: api/_lib/seats.js guardedInvite (+ billing.js handleInvite).
 *   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/limits-seats.mjs
 */
import path from 'node:path';
import { boot, memberTok, adminTok, mkReq, mkRes, quiet } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { root, newTenant } = h;
const imp = (p) => import(path.join(root, p));
const SEATS = await imp('api/_lib/seats.js');
const PLAN = await imp('api/_lib/plan.js');
const BILLING = (await imp('api/billing.js')).default;

let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** members: array of [userId, role]; owner is createdBy. */
function fakeClerk({ createdBy = 'user_owner', members = [], pending = 0, max = undefined, delayMs = 3 } = {}) {
  const st = { members: members.map(([u, r], i) => ({ publicUserData: { userId: u }, role: r ?? 'org:member', createdAt: 1000 + i })), invites: Array.from({ length: pending }, (_, i) => ({ id: `inv_p${i}`, status: 'pending', emailAddress: `p${i}@x.invalid` })), max, updates: [], created: 0 };
  return {
    st,
    organizations: {
      getOrganization: async () => ({ id: 'org_x', createdBy, maxAllowedMemberships: st.max }),
      getOrganizationMembershipList: async ({ offset }) => ({ data: offset ? [] : st.members }),
      getOrganizationInvitationList: async ({ offset }) => ({ data: offset ? [] : st.invites }),
      createOrganizationInvitation: async (a) => { await sleep(delayMs); st.created++; st.invites.push({ id: `inv_n${++seq}`, status: 'pending', emailAddress: a.emailAddress }); return { id: `inv_n${seq}` }; },
      updateOrganization: async (_id, patch) => { st.updates.push(patch); st.max = patch.maxAllowedMemberships; return {}; },
    },
  };
}
const people = (n, prefix = 'u') => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 'org:member']);
const withOwner = (n, prefix) => [['user_owner', 'org:admin'], ...people(n, prefix)];
const inv = (clerk, plan, email = `new${++seq}@example.invalid`) => SEATS.guardedInvite({ orgId: 'org_x', plan, email, clerk, inviterUserId: 'user_owner' });

const CAPS = { solo: 2, shop: 5, crew: 10 };
const NAME = { solo: 'Solo', shop: 'Team', crew: 'Crew' };
setFamily('seats');
check('SC0', 'plan table: logins solo 2, team 5, crew 10, fleet null (matches site "up to 2/5/10/11+")', PLAN.loginCapForPlan('solo') === 2 && PLAN.loginCapForPlan('shop') === 5 && PLAN.loginCapForPlan('crew') === 10 && PLAN.loginCapForPlan('fleet') === null && PLAN.loginCapForPlan('bogus') === undefined && PLAN.loginCapForPlan(null) === undefined);
for (const [plan, C] of Object.entries(CAPS)) {
  // owner + (C-1) others, no pending: used C-1 -> N-1 allowed
  let c = fakeClerk({ members: withOwner(C - 1) });
  let r = await inv(c, plan);
  check(`SC:${plan}:N-1`, `${plan}: owner + ${C - 1} members (used ${C - 1}/${C}) -> invite allowed, seats become ${C} of ${C}`, r.ok === true && r.seats.used === C && r.seats.atCap === true && c.st.created === 1, JSON.stringify(r));
  // N used (owner NOT counted): owner + C members
  c = fakeClerk({ members: withOwner(C) });
  r = await inv(c, plan);
  const msg = `Your ${NAME[plan]} plan includes up to ${C} logins (the owner account isn't counted). Upgrade your plan to invite more people.`;
  check(`SC:${plan}:N`, `${plan}: owner + ${C} members (used ${C}/${C}, owner not counted) -> 402 with the exact stated message, no Clerk invite created`, r.ok === false && r.status === 402 && r.error === msg && c.st.created === 0, JSON.stringify(r));
  // N+1 already (over cap, grandfathered): refused with the over-cap wording
  c = fakeClerk({ members: withOwner(C + 1) });
  r = await inv(c, plan);
  check(`SC:${plan}:N+1`, `${plan}: already ${C + 1} logins (over cap) -> refused, members keep access (nobody removed), wording names the surplus`, r.ok === false && r.status === 402 && /Everyone already on the team keeps their access/.test(r.error) && /remove 1 login or upgrade/.test(r.error) && c.st.members.length === C + 2, JSON.stringify(r));
  // pending invite boundary: C-1 members + 1 pending = C -> refused
  c = fakeClerk({ members: withOwner(C - 1), pending: 1 });
  r = await inv(c, plan);
  check(`SC:${plan}:pending-at-cap`, `${plan}: ${C - 1} members + 1 PENDING invite = ${C} used -> refused (pending counted)`, r.ok === false && r.status === 402 && r.seats.pending === 1 && r.seats.used === C, JSON.stringify(r));
  c = fakeClerk({ members: withOwner(C - 2), pending: 1 });
  r = await inv(c, plan);
  check(`SC:${plan}:pending-below`, `${plan}: ${C - 2} members + 1 pending = ${C - 1} used -> allowed (the invite fills the last login)`, r.ok === true && r.seats.used === C, JSON.stringify(r));
  // accepted / revoked invites do not count; only 'pending'
  c = fakeClerk({ members: withOwner(C - 1) });
  c.st.invites.push({ id: 'inv_old', status: 'revoked' }, { id: 'inv_acc', status: 'accepted' });
  r = await inv(c, plan);
  check(`SC:${plan}:revoked-not-counted`, `${plan}: revoked/accepted invites are not counted as pending`, r.ok === true, JSON.stringify(r));
}
{
  const c = fakeClerk({ members: withOwner(50) });
  const r = await inv(c, 'fleet');
  check('SC:fleet', 'fleet: 50 members, no DeepWell cap -> allowed', r.ok === true);
}
{
  // owner not counted: a removed creator -> earliest-joined admin is the (single) free owner
  const c = fakeClerk({ createdBy: 'user_gone', members: [['a1', 'org:admin'], ['a2', 'org:admin'], ['m1', 'org:member']] });
  const s = await SEATS.getSeatState({ orgId: 'org_x', plan: 'solo', clerk: c });
  check('SC:owner-fallback', 'creator no longer a member -> earliest admin is the owner (exactly ONE person free); a second admin DOES count', s.ownerUserId === 'a1' && s.members === 2 && s.used === 2 && s.atCap === true, JSON.stringify({ o: s.ownerUserId, m: s.members, u: s.used }));
  const c2 = fakeClerk({ createdBy: 'user_owner', members: [['user_owner', 'org:member'], ['a2', 'org:admin']] });
  const s2 = await SEATS.getSeatState({ orgId: 'org_x', plan: 'shop', clerk: c2 });
  check('SC:owner-member-role', "the creator is the owner whatever their current role (even if demoted to member); an extra admin counts", s2.ownerUserId === 'user_owner' && s2.used === 1, JSON.stringify({ o: s2.ownerUserId, u: s2.used }));
}
setFamily('seats-validation');
{
  let c = fakeClerk({ members: withOwner(0) });
  for (const bad of ['', 'not-an-email', 'a@b', ' ', null, undefined, 'a b@c.com']) {
    const r = await SEATS.guardedInvite({ orgId: 'org_x', plan: 'shop', email: bad, clerk: c });
    check(`SV:${JSON.stringify(bad)}`, 'invalid email -> 400, no invite', r.ok === false && r.status === 400 && c.st.created === 0, JSON.stringify(r));
  }
  const r = await SEATS.guardedInvite({ orgId: 'org_x', plan: null, email: 'a@b.co', clerk: c });
  check('SV:noplan', 'no plan -> 402 "Choose a plan to get started"', r.status === 402 && r.error === 'Choose a plan to get started');
}
setFamily('seats-concurrency');
for (const [plan, C, used, tries] of [['shop', 5, 3, 8], ['solo', 2, 0, 5], ['crew', 10, 9, 6]]) {
  const c = fakeClerk({ members: withOwner(used), delayMs: 8 });
  const res = await Promise.all(Array.from({ length: tries }, () => inv(c, plan)));
  const ok = res.filter((r) => r.ok).length;
  check(`SX:${plan}`, `${tries} SIMULTANEOUS invites with ${C - used} login(s) left on ${plan} -> exactly ${C - used} succeed, Clerk sees exactly ${C - used} creates`, ok === C - used && c.st.created === C - used && c.st.invites.length === C - used, `ok=${ok} created=${c.st.created}`);
}
{
  // two admins, two "instances": separate in-process queues cannot be simulated here; the Postgres advisory lock path is exercised
  const c = fakeClerk({ members: withOwner(4), delayMs: 8 });
  const res = await Promise.all([inv(c, 'shop'), inv(c, 'shop'), inv(c, 'shop')]);
  check('SX:lock', 'advisory-lock path (PGlite): 3 concurrent on 1 free login -> 1 ok', res.filter((r) => r.ok).length === 1 && c.st.created === 1);
}
setFamily('seats-clerk-backstop');
for (const [plan, want] of [['solo', 3], ['shop', 6], ['crew', 11], ['fleet', 0]]) {
  SEATS._resetSyncThrottle();
  const c = fakeClerk({ max: 1 });
  const r = await SEATS.syncOrgMemberLimit({ orgId: 'org_x', plan, clerk: c, force: true });
  check(`SB:${plan}`, `Clerk maxAllowedMemberships set to cap+1 (owner seat): ${plan} -> ${want} (Fleet 0 = unlimited)`, r.ok && c.st.max === want, JSON.stringify(r));
}
{
  const r = await SEATS.syncOrgMemberLimit({ orgId: 'org_x', plan: undefined, clerk: fakeClerk(), force: true });
  check('SB:noplan', 'no plan -> sync skipped (never writes a limit for an unknown plan)', r.action === 'skipped');
  const bad = { organizations: { getOrganization: async () => ({ maxAllowedMemberships: 1 }), updateOrganization: async () => { const e = new Error('nope'); e.status = 422; throw e; } } };
  SEATS._resetSyncThrottle();
  const r2 = await quiet(() => SEATS.syncOrgMemberLimit({ orgId: 'org_x', plan: 'shop', clerk: bad, force: true }));
  check('SB:reject', 'Clerk refusing the value is logged and swallowed (never throws into billing)', r2.ok === false && r2.action === 'rejected');
}
setFamily('seats-handler');
{
  // end to end through the real /api/billing?action=invite handler, mocked Clerk, real DB for the plan
  const ORG = 'org_seat_h';
  await newTenant(ORG, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const c = fakeClerk({ members: withOwner(4) });
  SEATS._setClerkForTest(c);
  const call = async (token, email, role) => { const res = mkRes(); await quiet(() => BILLING(mkReq({ token, query: { action: 'invite' }, body: { email, role } }), res)); return res; };
  const r1 = await call(adminTok(ORG), 'tech5@example.invalid', 'member');
  check('SH1', 'admin invites the 5th login on Team -> 200, seats "5 of 5 logins used (owner not counted)"', r1.statusCode === 200 && r1.body?.seats?.label === '5 of 5 logins used (owner not counted)', `${r1.statusCode} ${JSON.stringify(r1.body)}`);
  const r2 = await call(adminTok(ORG), 'tech6@example.invalid', 'member');
  check('SH2', 'the 6th -> 402 with the plan message and a link to billing; nothing created in Clerk', r2.statusCode === 402 && /includes up to 5 logins/.test(r2.body?.error) && r2.body?.url === '/app/?screen=billing' && c.st.created === 1, `${r2.statusCode} ${JSON.stringify(r2.body)}`);
  const r3 = await call(memberTok(ORG), 'tech7@example.invalid', 'admin');
  check('SH3', 'a member trying to invite (even as admin) -> 403, nothing created', r3.statusCode === 403 && c.st.created === 1, `${r3.statusCode}`);
  const g = mkRes();
  await quiet(() => BILLING(mkReq({ method: 'GET', token: adminTok(ORG), query: { action: 'seats' } }), g));
  check('SH4', 'seats endpoint reports used/cap/pending for admin', g.statusCode === 200 && g.body?.cap === 5 && g.body?.seats?.used === 5, `${g.statusCode} ${JSON.stringify(g.body)?.slice(0, 200)}`);
  SEATS._setClerkForTest(null);
}
finish();
