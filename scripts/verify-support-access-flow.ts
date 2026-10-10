/**
 * Team T8: the easy support-access flow, end to end on PGlite (no network, no real email).
 *  - pure helpers (reason, notice text: company + reason, no document content)
 *  - admin-only grant from the Help chat, idempotent, 24 hours, staff email (stubbed) + operator bell (real table)
 *  - the grant opens review.js's gate (decideAccess/requireSupportAccess) and is logged; ending it closes the gate
 *  - members see status, only admins can end; migration-58-missing fails safe with a plain message
 *  - the route + UI are wired (static checks)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

delete process.env.RESEND_API_KEY;
delete process.env.DEEPWELL_FOUNDER_TENANT_ID;

const H: any = await import('../api/_lib/support/accessHelp.js');
const SA: any = await import('../api/_lib/privacy/supportAccess.js');

/* ---- 1. pure helpers */
{
  check('reason: fixed sentence, plus only the optional note the person typed', H.reasonFromChat('my invoices are missing') === 'Asked for help in the Help chat: my invoices are missing' && H.reasonFromChat(undefined) === 'Asked for help in the Help chat');
  check('reason: capped, and card/SSN-shaped runs and passwords are removed', (() => {
    const r = H.reasonFromChat('card 4111 1111 1111 1111 ssn 123-45-6789 password is hunter2 ' + 'x'.repeat(900));
    return !r.includes('4111') && !r.includes('123-45-6789') && !r.includes('hunter2') && r.length <= 240;
  })());
  check('reason: empty chat still gives a usable reason', H.reasonFromChat('') === 'Asked for help in the Help chat');
  check('company name: stripped of angle brackets and control characters, capped at 80', H.cleanCompanyName('<b>Acme\u0000 HVAC</b>' + 'y'.repeat(200)).length <= 80 && !/[<>\u0000]/.test(H.cleanCompanyName('<b>Acme\u0000</b>')));
  const n = H.buildStaffGrantNotice({ companyName: 'Acme HVAC', accountRef: 'org_acme', reason: 'Asked for help in the Help chat: invoices', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  check('staff email: names the company, the reason and the expiry', n.text.includes('Acme HVAC') && n.text.includes('invoices') && /Access ends:/.test(n.text));
  check('staff email: subject is one line', !/[\r\n]/.test(n.subject));
  check('staff email: html escapes markup from the company name', !H.buildStaffGrantNotice({ companyName: '<img src=x>', accountRef: 'o', reason: 'r', expiresAt: new Date().toISOString() }).html.includes('<img'));
  check('admin rule: solo tenant is its own admin, org admin yes, org member no', H.canManageAccess({ tenantId: 't' }) && H.canManageAccess({ orgId: 'o', orgRole: 'admin' }) && !H.canManageAccess({ orgId: 'o', orgRole: 'member' }));
}

/* ---- 2. PGlite lifecycle */
const offline: any = await import('./offline-exam.mjs');
await offline.installPgHarness();
const lite = await offline.createPGlite();
await offline.setActiveDatabase(lite);
const { getTenantContext } = await import('../api/_lib/recordsStore.js');

const adminA = { tenantId: 'org_t8_a', orgId: 'org_t8_a', orgRole: 'admin', userId: 'user_admin_a' };
const memberA = { tenantId: 'org_t8_a', orgId: 'org_t8_a', orgRole: 'member', userId: 'user_member_a' };
const FOUNDER = 'org_t8_founder';
await getTenantContext('org_t8_a', 'org_t8_a');
await getTenantContext(FOUNDER, FOUNDER);
await getTenantContext('org_t8_a2', 'org_t8_a2');
const ctxA = { tenantKey: 'org_t8_a', tenantName: 'org_t8_a' };
const sent: any[] = [];
const send = async (m: any) => { sent.push(m); return { sent: true, channel: 'email' }; };

{
  const s0 = await H.accessStatus(memberA);
  check('status: a member sees no active access and is not an admin', s0.active === null && s0.isAdmin === false);

  const denied = await H.grantFromChat(memberA, { note: 'help' }, { send });
  check('grant: a non-admin member is refused with a plain message, no email sent', denied.status === 403 && denied.body.code === 'not-admin' && sent.length === 0);

  process.env.DEEPWELL_FOUNDER_TENANT_ID = FOUNDER;
  const g1 = await H.grantFromChat(adminA, { note: 'invoices missing', companyName: 'Acme HVAC' }, { send, lookupShopName: async () => 'Acme HVAC' });
  check('grant: an admin gets a 24 hour grant', g1.status === 200 && g1.body.ok === true && g1.body.already === false);
  const hoursOut = (Date.parse(g1.body.grant.expiresAt) - Date.now()) / 3600000;
  check('grant: expires in about 24 hours', hoursOut > 23.9 && hoursOut < 24.1, String(hoursOut));
  const active = await SA.getActiveGrant(ctxA);
  check('grant: the fixed sentence plus the typed note is stored as the reason', /^Asked for help in the Help chat: invoices missing$/.test(active?.reason ?? ''));
  check('staff email: exactly one, to the support address, with company + reason', sent.length === 1 && sent[0].to.length === 1 && /support@deepwelltechnology\.com/.test(sent[0].to[0]) && sent[0].text.includes('Acme HVAC') && sent[0].text.includes('invoices'));
  check('staff email: carries no document content or customer email address', !/@(?!deepwelltechnology)/.test(sent[0].text.replace(/support@deepwelltechnology\.com/g, '')));
  const bell = await (async () => {
    const ctxF = { tenantKey: FOUNDER, tenantName: FOUNDER };
    const { withTenant } = await import('../api/_lib/recordsStore.js');
    return withTenant(ctxF, async (st: any) => (await st.raw(`SELECT kind, title, body FROM notifications WHERE kind = 'support-access'`)).rows);
  })();
  check('operator bell: one entry in the founder tenant naming the company and reason', bell.length === 1 && /Acme HVAC/.test(bell[0].title) && /invoices/.test(bell[0].body));

  const gChat = await H.grantFromChat({ ...adminA, tenantId: 'org_t8_a2', orgId: 'org_t8_a2' }, { message: 'my card is 4111 and my boss is a jerk', companyName: 'Spoof <b>Bank</b>' }, { send: async (m: any) => sent.push(m), lookupShopName: async () => '' });
  const spoof = sent[sent.length - 1];
  check('chat text is never sent: default reason only', gChat.status === 200 && !/boss|jerk|4111/.test(spoof.text) && /Reason: Asked for help in the Help chat$/m.test(spoof.text));
  check('staff email: subject uses the account reference, browser name only labelled unverified', /org_t8_a2/.test(spoof.subject) && !/Spoof/.test(spoof.subject) && /\(unverified\): Spoof/.test(spoof.text));
  sent.pop();
  await SA.revokeSupportAccess({ tenantKey: 'org_t8_a2', tenantName: 'org_t8_a2' }, gChat.body.grant.id, 'user_admin_a');
  const g2 = await H.grantFromChat(adminA, { note: 'again' }, { send });
  check('grant: pressing again while active is idempotent (same grant, no second email)', g2.body.already === true && g2.body.grant.id === g1.body.grant.id && sent.length === 1);

  const sm = await H.accessStatus(memberA);
  check('status: a member sees the expiry (banner) but is not an admin', sm.active?.id === g1.body.grant.id && sm.isAdmin === false);

  // the grant opens the gate used by api/review.js, and is logged
  delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
  const dec = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_1', action: 'learningReplay', recordCount: 2 });
  check('gate: staff access is allowed while the grant is active and is logged', dec.allowed && dec.mode === 'granted' && (await SA.listAccessLog(ctxA)).length === 1);

  const endMember = await H.endGrant(memberA, g1.body.grant.id);
  check('end: a member cannot end it', endMember.status === 403);
  const end = await H.endGrant(adminA, g1.body.grant.id);
  check('end: an admin can end it now', end.status === 200 && (await H.accessStatus(adminA)).active === null);
  const dec2 = await SA.requireSupportAccess(ctxA, { staffUserId: 'staff_1', action: 'learningReplay' });
  check('gate: after End now, staff are refused again', dec2.allowed === false);
  check('end: ending twice is a plain not-found', (await H.endGrant(adminA, g1.body.grant.id)).status === 404);
}

/* ---- 3. failure modes */
{
  const sent2: any[] = [];
  const gFail = await H.grantFromChat(adminA, { note: 'x' }, { send: async (m: any) => sent2.push(m), grantSupportAccess: async () => null });
  check('migration 58 missing: plain message, 503, no staff email', gFail.status === 503 && !/migration|58|sql/i.test(gFail.body.error) && sent2.length === 0);
  const gMail = await H.grantFromChat(adminA, { note: 'x' }, { send: async () => { throw new Error('boom'); }, writeBell: async () => false });
  check('email and bell failing never undo the grant', gMail.status === 200 && gMail.body.ok === true);
  check('bell is skipped (not an error) when no operator tenant is configured', await (async () => { delete process.env.DEEPWELL_FOUNDER_TENANT_ID; return (await H.notifyStaffOfGrant(adminA, { reason: 'r', expiresAt: new Date().toISOString(), companyName: 'A' }, { send })).belled === false; })());
}

/* ---- 4. wiring */
{
  const route = read('api/_lib/support/route.js');
  check('route: access-status / access-grant / access-end are handled behind sign-in', /access-status/.test(route) && /access-grant/.test(route) && /access-end/.test(route) && /if \(!auth\) return bad\(res, 400/.test(route.slice(route.indexOf('access-status'))));
  check('review.js: the Settings Grant button also notifies staff', /notifyStaffOfGrant\(auth/.test(read('api/review.js')));
  const ui = read('src/components/support/SupportAssistant.tsx');
  check('help chat: offer sits beside "Send this to a person" and in the Talk to a person form', (ui.match(/<SupportAccessOffer/g) ?? []).length === 2);
  check('banner is mounted with the help widget on every app screen', /<SupportAccessBanner/.test(read('src/components/support/SupportWidget.tsx')));
  const acc = read('src/components/support/SupportAccess.tsx');
  check('UI: exact button and banner wording', acc.includes('Let DeepWell support look for 24 hours') && acc.includes('Support can see your account until') && acc.includes('End now'));
  check('UI: optional note box, empty by default, shown before granting', acc.includes('Add a note for support (optional)') && /useState\(''\)/.test(acc) && !/message: lastUserText/.test(acc));
  check('UI: non-admins are shown how to ask their admin, not a button', /ask your company admin/.test(acc));
}

console.log(`\nverify-support-access-flow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
