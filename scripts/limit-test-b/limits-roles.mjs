/**
 * TESTER B (2): every admin-only action refuses a MEMBER session on the SERVER with no DB side effect.
 * Handlers are executed in-process against PGlite; Clerk is the mock in clerk-stub.mjs.
 *   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/limits-roles.mjs
 */
import path from 'node:path';
import { boot, memberTok, adminTok, legacyTok, tok, mkReq, mkRes, quiet, snapshot, diffSnap } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, rnd, root, resetCaches } = h;
process.env.DEEPWELL_OPERATOR_USER_IDS = 'user_staff';
const imp = (p) => import(path.join(root, p));
const BILLING = (await imp('api/billing.js')).default;
const ACCOUNT = (await imp('api/account.js')).default;
const REVIEW = (await imp('api/review.js')).default;
const V1 = (await imp('api/v1.js')).default;
const RECORDS = await imp('api/records.ts');
const UP = await imp('api/upload-url.js');
const AUTHM = await imp('api/_lib/auth.js');

const ORG = 'org_roles_A';
await newTenant(ORG, 'fleet', 'active');
const adminAuth = { tenantId: ORG, orgId: ORG, userId: 'user_admin', orgRole: 'admin' };
const MT = memberTok(ORG), AT = adminTok(ORG);

// seed: 2 documents, 2 customers, 1 api key
const docIds = [];
for (let i = 0; i < 2; i++) docIds.push((await UP.createUploadUrl(adminAuth, { filename: `seed${i}.pdf`, sha256: rnd(), sizeBytes: 1000 })).documentId);
const custIds = [];
for (let i = 0; i < 2; i++) custIds.push((await RS.withTenant({ tenantKey: ORG, tenantName: ORG }, (db) => db.createEntity({ entity_type: 'customer', data: { customer_name: `Cust ${i}` } }))).id);
const keyRes = mkRes();
await quiet(() => ACCOUNT(mkReq({ token: AT, query: { action: 'keys' }, body: { action: 'create', name: 'seedkey', scopes: ['read'] } }), keyRes));
const keyId = keyRes.body?.id;
check('R00', 'seed: admin created an API key on a Fleet tenant (positive control)', keyRes.statusCode === 201 && !!keyId, JSON.stringify(keyRes.body));
const dummy = '00000000-0000-4000-8000-000000000001';

const run = async (handler, token, { method = 'POST', query = {}, body } = {}) => { const res = mkRes(); await quiet(() => handler(mkReq({ method, token, query, body }), res)); return res; };
// prime the member's users row so the member-call snapshot is stable
await run(BILLING, MT, { method: 'GET', query: { action: 'status' } });
await run(BILLING, AT, { method: 'GET', query: { action: 'status' } });

/* name, handler, request */
const A = (q) => ({ query: { action: q } });
const cases = [
  ['billing checkout', BILLING, { query: { action: 'checkout' }, body: { plan: 'shop' } }],
  ['billing portal', BILLING, A('portal')],
  ['billing invite', BILLING, { query: { action: 'invite' }, body: { email: 'new@example.invalid', role: 'member' } }],
  ['billing invite as admin role (member promoting a new invite / self-escalation)', BILLING, { query: { action: 'invite' }, body: { email: 'new2@example.invalid', role: 'admin' } }],
  ['billing seats', BILLING, { method: 'GET', query: { action: 'seats' } }],
  ['api key create', ACCOUNT, { query: { action: 'keys' }, body: { action: 'create', name: 'evil', scopes: ['read'] } }],
  ['api key revoke', ACCOUNT, { query: { action: 'keys' }, body: { action: 'revoke', id: keyId } }],
  ['api key list', ACCOUNT, { query: { action: 'keys' }, body: { action: 'list' } }],
  ['data export (tenant-export)', ACCOUNT, { query: { action: 'export' }, body: {} }],
  ['delete company (tenant-delete)', ACCOUNT, { query: { action: 'delete' }, body: { confirm: ORG } }],
  ['csv export documents (/api/v1?resource=export)', V1, { method: 'GET', query: { resource: 'export', kind: 'documents' } }],
  ['csv export customers', V1, { method: 'GET', query: { resource: 'export', kind: 'customers' } }],
  ['delete document / empty documents (review deleteDocuments)', REVIEW, { body: { action: 'deleteDocuments', documentIds: docIds } }],
  ['merge customers (review mergeCustomers)', REVIEW, { body: { action: 'mergeCustomers', keepId: custIds[0], dropId: custIds[1] } }],
  ['merge entities (review mergeEntities)', REVIEW, { body: { action: 'mergeEntities', keepId: custIds[0], dropId: custIds[1] } }],
  ['recheckMissing (bulk write)', REVIEW, { body: { action: 'recheckMissing' } }],
  ['integrityFix destructive (mergeDuplicates)', REVIEW, { body: { action: 'integrityFix', apply: ['mergeDuplicates'] } }],
  ['integrityFix destructive (retireShopCustomers)', REVIEW, { body: { action: 'integrityFix', apply: ['retireShopCustomers'] } }],
  ['missReport', REVIEW, { body: { action: 'missReport' } }],
  ['exportMisses', REVIEW, { body: { action: 'exportMisses' } }],
  ['semanticBackfill', REVIEW, { body: { action: 'semanticBackfill' } }],
  ['dossierBackfill', REVIEW, { body: { action: 'dossierBackfill' } }],
  ['support-access GRANT', REVIEW, { body: { action: 'supportAccessGrant', hours: 24, reason: 'x' } }],
  ['support-access REVOKE', REVIEW, { body: { action: 'supportAccessRevoke', grantId: dummy } }],
  ['support-access STATUS', REVIEW, { body: { action: 'supportAccessStatus' } }],
  ['support-access LOG', REVIEW, { body: { action: 'supportAccessLog' } }],
  ['entity-merge list', ACCOUNT, { query: { action: 'entity-merge' }, body: { op: 'list' } }],
  ['entity-merge accept', ACCOUNT, { query: { action: 'entity-merge' }, body: { op: 'accept', entityIds: custIds, keepId: custIds[0] } }],
  ['naming backfill', ACCOUNT, { query: { action: 'naming' }, body: { op: 'backfill' } }],
  ['graph refresh', ACCOUNT, { query: { action: 'graph' }, body: { op: 'refresh' } }],
  ['unit-address backfill', ACCOUNT, { query: { action: 'unit-address' }, body: { op: 'backfill' } }],
  ['financials summary', ACCOUNT, { query: { action: 'financials' }, body: { op: 'summary' } }],
  ['financials backfill (billed model calls)', ACCOUNT, { query: { action: 'financials' }, body: { op: 'backfill' } }],
  ['followups saveSettings', ACCOUNT, { query: { action: 'followups' }, body: { op: 'saveSettings', settings: { enabled: true } } }],
  ['followups run (sends technician emails)', ACCOUNT, { query: { action: 'followups' }, body: { op: 'run', apply: true } }],
  ['outreach saveSettings', ACCOUNT, { query: { action: 'outreach' }, body: { op: 'saveSettings', settings: { mode: 'review' } } }],
  ['outreach approve', ACCOUNT, { query: { action: 'outreach' }, body: { op: 'approve', all: true } }],
  ['outreach SEND (sendApproved)', ACCOUNT, { query: { action: 'outreach' }, body: { op: 'sendApproved' } }],
  ['notifications company setting (emailDigest)', ACCOUNT, { query: { action: 'notifications' }, body: { settings: { emailDigest: false } } }],
  ['operator-only: learningDecide', REVIEW, { body: { action: 'learningDecide' } }],
  ['operator-only: examList', REVIEW, { body: { action: 'examList' } }],
  ['operator-only: missDigest', REVIEW, { body: { action: 'missDigest' } }],
];
// records.ts admin writes (through the real processRecords with a member auth)
const recordsAdmin = [...RECORDS.RECORDS_ADMIN_ACTIONS];

setFamily('member-refused');
const baseline = await snapshot(lite);
for (const [name, handler, req] of cases) {
  const before = await snapshot(lite);
  const res = await run(handler, MT, req);
  const after = await snapshot(lite);
  const changed = diffSnap(before, after);
  check(`M:${name}`, `MEMBER -> 403 and no DB change`, res.statusCode === 403 && changed.length === 0, `status ${res.statusCode} ${JSON.stringify(res.body)?.slice(0, 120)} changed=${changed.join(',')}`);
}
// records.ts admin actions
for (const action of recordsAdmin) {
  const before = await snapshot(lite);
  const res = mkRes();
  await quiet(() => RECORDS.processRecords({ method: 'POST', headers: {}, body: { action, id: dummy } }, res, { tenantId: ORG, orgId: ORG, userId: 'user_member', orgRole: 'member' }));
  const changed = diffSnap(before, await snapshot(lite));
  check(`M:records.${action}`, 'MEMBER -> 403 and no DB change', res.statusCode === 403 && changed.length === 0, `status ${res.statusCode} changed=${changed.join(',')}`);
}
check('M:records.access-table', 'recordsActionAccess: unknown action is not silently allowed; read ok, admin write forbidden for member', RECORDS.recordsActionAccess('nope', { orgId: ORG, orgRole: 'member' }) === 'unknown' && RECORDS.recordsActionAccess('updateDocument', { orgId: ORG, orgRole: 'member' }) === 'forbidden' && RECORDS.recordsActionAccess('listDocuments', { orgId: ORG, orgRole: 'member' }) === 'ok');
const unchangedAll = diffSnap(baseline, await snapshot(lite));
check('M:ALL', 'after every refused member call the whole DB is byte-identical to the baseline', unchangedAll.length === 0, unchangedAll.join(','));

/* admin positive controls: the same requests are NOT refused for an admin (so the 403s above are the role gate, not a malformed request) */
setFamily('admin-control');
const refusedForAdmin = [];
for (const [name, handler, req] of cases) {
  if (/operator-only/.test(name)) continue;
  const r = req.body?.confirm ? { ...req, body: { confirm: 'wrong' } } : req; // never really wipe the tenant
  const res = await run(handler, AT, r);
  if (res.statusCode === 403 || res.statusCode === 401) refusedForAdmin.push(`${name}:${res.statusCode}`);
}
check('A:ALL', 'ADMIN is not refused (no 401/403) on the same requests', refusedForAdmin.length === 0, refusedForAdmin.join('; '));
const opAdmin = await run(REVIEW, AT, { body: { action: 'examList' } });
check('A:operator', 'a tenant ADMIN (not platform operator) is still 403 on operator-only actions', opAdmin.statusCode === 403, `${opAdmin.statusCode}`);

/* member allowed actions: member can do ordinary work (so the gate is not just "deny everything") */
setFamily('member-allowed');
{
  const st = await run(BILLING, MT, { method: 'GET', query: { action: 'status' } });
  check('MA:status', 'member can read billing status', st.statusCode === 200, `${st.statusCode}`);
  const up = await quiet(() => UP.createUploadUrl({ ...adminAuth, userId: 'user_member', orgRole: 'member' }, { filename: 'mem.pdf', sha256: rnd(), sizeBytes: 500 }));
  check('MA:upload', 'member can upload (createUploadUrl)', !!up.documentId);
}

/* ---- member-allowed BY DESIGN (KB: members "ask, upload, browse, fix and verify records"); listed so a reviewer sees the full picture */
setFamily('member-by-design');
{
  const byDesign = [
    ['review correctField', REVIEW, { body: { action: 'correctField', documentId: dummy, field: 'model', value: 'x' } }],
    ['review verifyDocument', REVIEW, { body: { action: 'verifyDocument', documentId: dummy } }],
    ['review createCustomer', REVIEW, { body: { action: 'createCustomer', name: 'Member Made LLC' } }],
    ['review keepCustomersSeparate', REVIEW, { body: { action: 'keepCustomersSeparate', aId: custIds[0], bId: custIds[1] } }],
    ['review dismissAlert', REVIEW, { body: { action: 'dismissAlert', key: 'x' } }],
    ['outreach generate drafts', ACCOUNT, { query: { action: 'outreach' }, body: { op: 'generate' } }],
    ['outreach skip drafts', ACCOUNT, { query: { action: 'outreach' }, body: { op: 'skip', ids: [dummy] } }],
    ['outreach optOut a customer (permanent, company-wide)', ACCOUNT, { query: { action: 'outreach' }, body: { op: 'optOut', customerId: custIds[0] } }],
    ['financials correct', ACCOUNT, { query: { action: 'financials' }, body: { op: 'correct', documentId: dummy, field: 'total', value: 1 } }],
    ['financials verify', ACCOUNT, { query: { action: 'financials' }, body: { op: 'verify', documentId: dummy } }],
    ['own digest mute', ACCOUNT, { query: { action: 'notifications' }, body: { settings: { digestMuted: true } } }],
    ['merge-tenant (own solo uploads into company)', ACCOUNT, { query: { action: 'merge' }, body: {} }],
  ];
  for (const [name, handler, req] of byDesign) {
    const r = await run(handler, MT, req);
    check(`BD:${name}`, `member is NOT refused (${name}) - by design; status ${r.statusCode}`, r.statusCode !== 403 && r.statusCode !== 401, `${r.statusCode} ${JSON.stringify(r.body)?.slice(0, 100)}`);
  }
}

/* ---- role claims: v1/v2 shapes, custom role -> member, no org -> solo, forged / expired / garbage token */
setFamily('claims');
{
  const t1 = await run(BILLING, legacyTok(ORG, 'org:member', 'user_m1'), { query: { action: 'portal' } });
  check('C:v1member', 'legacy v1 token org_role=org:member -> 403 on portal', t1.statusCode === 403, `${t1.statusCode}`);
  const t2 = await run(BILLING, tok({ sub: 'user_m2', o: { id: ORG, rol: 'billing_manager' } }), { query: { action: 'portal' } });
  check('C:custom', 'custom role (not literally admin) -> treated as member -> 403', t2.statusCode === 403, `${t2.statusCode}`);
  const t3 = await run(BILLING, tok({ sub: 'user_m3', o: { id: ORG } }), { query: { action: 'portal' } });
  check('C:norole', 'org present but NO role claim -> 403 (least privilege)', t3.statusCode === 403, `${t3.statusCode}`);
  const t4 = await run(BILLING, tok({ sub: 'user_m4', o: { id: ORG, rol: 'ADMIN ' } }), { query: { action: 'portal' } });
  check('C:case', 'role "ADMIN " (case/space) normalises to admin (Clerk emits lowercase; documents behaviour)', t4.statusCode !== 403, `${t4.statusCode}`);
  const tf = await run(BILLING, tok({ sub: 'user_x', o: { id: ORG, rol: 'admin' }, __forged: true }), { query: { action: 'portal' } });
  check('C:forged', 'forged/invalid-signature token claiming admin -> 401', tf.statusCode === 401, `${tf.statusCode}`);
  // member promoting self: body/headers never feed the role
  const before = await lite.query(`SELECT role FROM users WHERE clerk_user_id='user_member'`);
  await run(BILLING, MT, { query: { action: 'status', role: 'admin', orgRole: 'admin' }, method: 'POST', body: { role: 'admin', orgRole: 'admin' } });
  const rq = mkReq({ token: MT, query: { action: 'portal' }, body: { orgRole: 'admin' }, headers: { 'x-org-role': 'admin' } }); const rs = mkRes();
  await quiet(() => BILLING(rq, rs));
  const after = await lite.query(`SELECT role FROM users WHERE clerk_user_id='user_member'`);
  check('C:self-promote', 'member cannot promote self via body/query/header: portal still 403 and users.role stays "user"', rs.statusCode === 403 && after.rows[0]?.role === 'user' && before.rows[0]?.role === 'user', `${rs.statusCode} ${JSON.stringify(after.rows)}`);
  const noEndpoint = (await import('node:fs')).readFileSync(path.join(root, 'api/_lib/members.js'), 'utf8');
  check('C:no-role-endpoint', 'no server endpoint changes a role: users.role is only written from the verified token (members.js upsert)', /toUsersRole\(auth\.orgRole\)/.test(noEndpoint));
}

/* ---- role downgrade mid-session */
setFamily('downgrade');
{
  AUTHM._resetMemberUpsertCache?.();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const U = 'user_demoted';
  const oldAdmin = tok({ sub: U, exp, o: { id: ORG, rol: 'admin' } });
  const KL = { query: { action: 'keys' }, body: { action: 'list' } };
  const a1 = await run(ACCOUNT, oldAdmin, KL);
  check('D1', 'before demotion: admin token passes the role gate on api-key list', a1.statusCode !== 403 && a1.statusCode !== 401, `${a1.statusCode}`);
  const newMember = tok({ sub: U, exp, o: { id: ORG, rol: 'member' } });
  const a2 = await run(ACCOUNT, newMember, KL);
  check('D2', 'after demotion, the NEXT token (role=member) is refused 403 on the very next request', a2.statusCode === 403, `${a2.statusCode}`);
  const a3 = await run(ACCOUNT, oldAdmin, KL);
  check('D3', 'KNOWN WINDOW: the OLD admin token still works until it expires (role is read from the JWT, no live Clerk lookup) - documents the stale-role window = token lifetime', a3.statusCode === 403, `old admin token after demotion -> ${a3.statusCode} (api-key list still served; not refused: role is not re-checked server-side until the token expires)`);
  const expired = tok({ sub: U, exp: Math.floor(Date.now() / 1000) - 5, o: { id: ORG, rol: 'admin' } });
  const a4 = await run(ACCOUNT, expired, KL);
  check('D4', 'expired admin token -> 401', a4.statusCode === 401, `${a4.statusCode}`);
  const u = await lite.query(`SELECT role FROM users WHERE clerk_user_id=$1`, [U]);
  check('D5', 'users.role row follows the latest token (admin -> user) once the new token is seen', u.rows[0]?.role === 'user', JSON.stringify(u.rows));
}

/* ---- SUPPORT ACCESS */
setFamily('support-access');
{
  const SORG = 'org_roles_support', OTHER = 'org_roles_other';
  await newTenant(SORG, 'shop', 'active'); await newTenant(OTHER, 'shop', 'active');
  const STAFF = tok({ sub: 'user_staff', o: { id: SORG, rol: 'member' } });
  const STAFF_OTHER = tok({ sub: 'user_staff', o: { id: OTHER, rol: 'member' } });
  const ADM = adminTok(SORG, 'user_cadmin'); const ORD = memberTok(SORG, 'user_tech');
  const log = async () => (await lite.query(`SELECT l.* FROM staff_access_log l JOIN tenants t ON t.id=l.tenant_id WHERE t.clerk_org_id=$1 ORDER BY l.created_at`, [SORG])).rows;
  const grants = async () => (await lite.query(`SELECT g.* FROM support_access_grants g JOIN tenants t ON t.id=g.tenant_id WHERE t.clerk_org_id=$1`, [SORG])).rows;
  const op = (t, extra = {}) => run(REVIEW, t, { body: { action: 'examList', ...extra } });

  check('S1', 'default: no grant row exists for a new company (access is OFF by default)', (await grants()).length === 0);
  const d0 = await op(STAFF);
  check('S2', 'staff (operator, member of the customer org) WITHOUT a grant -> 403', d0.statusCode === 403, `${d0.statusCode} ${JSON.stringify(d0.body)}`);
  check('S2b', 'a denied attempt writes no access-log row (nothing was accessed)', (await log()).length === 0);
  const d1 = await op(ORD);
  check('S3', 'ordinary staff (non-operator member) -> 403 on operator-only action', d1.statusCode === 403);
  const d1b = await op(ADM);
  check('S3b', 'the customer admin (non-operator) -> 403 on the operator action (admin grants access, cannot use it)', d1b.statusCode === 403);
  const g0 = await run(REVIEW, ORD, { body: { action: 'supportAccessGrant', hours: 24 } });
  check('S4', 'ordinary member cannot GRANT support access -> 403, no grant row', g0.statusCode === 403 && (await grants()).length === 0, `${g0.statusCode}`);
  // admin grants
  const g1 = await run(REVIEW, ADM, { body: { action: 'supportAccessGrant', hours: 2, reason: 'help with import' } });
  const gid = g1.body?.grant?.id;
  check('S5', 'admin grant -> 200 with id and expiresAt', g1.statusCode === 200 && !!gid, `${g1.statusCode} ${JSON.stringify(g1.body)}`);
  const exp1 = (await grants())[0]?.expires_at;
  const hrs = (new Date(exp1).getTime() - Date.now()) / 3600000;
  check('S6', 'grant for 2 hours expires in ~2h (within 1 minute)', Math.abs(hrs - 2) < 1 / 60, `${hrs}h`);
  const a1 = await op(STAFF);
  check('S7', 'with an active grant, staff access is allowed (not 403)', a1.statusCode !== 403, `${a1.statusCode} ${JSON.stringify(a1.body)?.slice(0, 100)}`);
  let L = await log();
  check('S8', 'that access was LOGGED with the grant id, staff id, action, not emergency', L.length === 1 && L[0].staff_user_id === 'user_staff' && L[0].grant_id === gid && L[0].is_emergency === false && L[0].action === 'examList', JSON.stringify(L));
  // cross-tenant: grant in SORG gives nothing in OTHER
  const x = await op(STAFF_OTHER);
  check('S9', 'grant on company A gives NO access to company B (same staff user) -> 403', x.statusCode === 403, `${x.statusCode}`);
  // tenant id in body cannot redirect
  const x2 = await op(STAFF_OTHER, { tenantId: SORG, tenant_id: SORG });
  check('S9b', 'body tenantId is ignored: staff in company B naming company A in the body is still refused', x2.statusCode === 403, `${x2.statusCode}`);
  // expiry enforced at READ time (no sweeper): move expires_at into the past
  await lite.query(`UPDATE support_access_grants SET expires_at = NOW() - interval '1 second' WHERE id=$1`, [gid]);
  const e1 = await op(STAFF);
  check('S10', 'EXPIRY enforced at read time: one second after expires_at -> 403 (no job needed)', e1.statusCode === 403, `${e1.statusCode}`);
  await lite.query(`UPDATE support_access_grants SET expires_at = NOW() + interval '1 second' WHERE id=$1`, [gid]);
  const e2 = await op(STAFF);
  check('S10b', 'one second BEFORE expiry -> still allowed (boundary)', e2.statusCode !== 403, `${e2.statusCode}`);
  await new Promise((r) => setTimeout(r, 1300));
  const e3 = await op(STAFF);
  check('S10c', 'after the 1s elapses in real time -> 403', e3.statusCode === 403, `${e3.statusCode}`);
  // clamping
  const gm = await run(REVIEW, ADM, { body: { action: 'supportAccessGrant', hours: 99999 } });
  const gmx = (new Date((await grants()).find((g) => g.id === gm.body?.grant?.id)?.expires_at).getTime() - Date.now()) / 3600000;
  check('S11', 'grant duration is capped at 168h (7 days) however much is asked', gmx <= 168.01 && gmx > 167.9, `${gmx}`);
  const gd = await run(REVIEW, ADM, { body: { action: 'supportAccessGrant', hours: 'abc' } });
  const gdx = (new Date((await grants()).find((g) => g.id === gd.body?.grant?.id)?.expires_at).getTime() - Date.now()) / 3600000;
  check('S11b', 'garbage hours falls back to 24h default (not unlimited)', gdx > 23.9 && gdx <= 24.01, `${gdx}`);
  // revoke takes effect at once. two grants active (gm, gd) -> revoke both
  const r1 = await run(REVIEW, ADM, { body: { action: 'supportAccessRevoke', grantId: gm.body.grant.id } });
  const still = await op(STAFF);
  check('S12', 'revoking ONE of two active grants leaves the other active (documents behaviour: staff still allowed)', r1.statusCode === 200 && still.statusCode !== 403, `${r1.statusCode}/${still.statusCode}`);
  const r2 = await run(REVIEW, ADM, { body: { action: 'supportAccessRevoke', grantId: gd.body.grant.id } });
  const rev = await op(STAFF);
  check('S13', 'after the LAST active grant is revoked, the very next staff call -> 403 immediately', r2.statusCode === 200 && rev.statusCode === 403, `${r2.statusCode}/${rev.statusCode}`);
  const r3 = await run(REVIEW, ADM, { body: { action: 'supportAccessRevoke', grantId: gd.body.grant.id } });
  check('S13b', 'revoking again -> 404 (already revoked)', r3.statusCode === 404, `${r3.statusCode}`);
  const rOther = await run(REVIEW, adminTok(OTHER, 'user_oadmin'), { body: { action: 'supportAccessRevoke', grantId: gid } });
  check('S13c', "another company's admin cannot revoke this company's grant id -> 404", rOther.statusCode === 404, `${rOther.statusCode}`);
  // emergency
  const n0 = (await log()).length;
  const em = await op(STAFF, { emergencyReason: 'prod outage ticket 123' });
  L = await log();
  const last = L[L.length - 1];
  check('S14', 'emergency (break-glass) with a reason and NO grant -> allowed AND logged is_emergency=true with the reason', em.statusCode !== 403 && L.length === n0 + 1 && last.is_emergency === true && last.emergency_reason === 'prod outage ticket 123' && last.grant_id === null, `${em.statusCode} ${JSON.stringify(last)}`);
  const em2 = await op(STAFF, { emergencyReason: '   ' });
  check('S15', 'blank/whitespace emergency reason -> 403', em2.statusCode === 403, `${em2.statusCode}`);
  const em3 = await op(ORD, { emergencyReason: 'please' });
  check('S16', 'a non-operator cannot use emergencyReason (operator gate first) -> 403', em3.statusCode === 403, `${em3.statusCode}`);
  const em4 = await op(STAFF, { emergencyReason: 'x'.repeat(900) });
  L = await log();
  check('S17', 'emergency reason is stored truncated to 500 chars', L[L.length - 1].emergency_reason.length === 500);
  // the tenant sees the log (admin read), member cannot
  const lg = await run(REVIEW, ADM, { body: { action: 'supportAccessLog' } });
  check('S18', "the company admin's Access log lists the emergency and the granted access (>=3 rows)", lg.statusCode === 200 && lg.body.items.length >= 3 && lg.body.items.some((i) => i.is_emergency), JSON.stringify(lg.body)?.slice(0, 200));
  // another active grant + emergency: grant wins, logged as granted not emergency
  const g3 = await run(REVIEW, ADM, { body: { action: 'supportAccessGrant', hours: 1 } });
  const n1 = (await log()).length;
  await op(STAFF, { emergencyReason: 'also an emergency' });
  L = await log();
  check('S19', 'with an active grant, an emergencyReason does not turn the access into an "emergency" row (grant mode logged)', L.length === n1 + 1 && L[L.length - 1].is_emergency === false && L[L.length - 1].grant_id === g3.body?.grant?.id, JSON.stringify(L[L.length - 1]));
  await run(REVIEW, ADM, { body: { action: 'supportAccessRevoke', grantId: g3.body.grant.id } });
  // logging failure must not silently allow an UNLOGGED access (claim: every access logged)
  await lite.exec(`ALTER TABLE staff_access_log RENAME TO staff_access_log_x`);
  const nl = await op(STAFF, { emergencyReason: 'log table broken' });
  await lite.exec(`ALTER TABLE staff_access_log_x RENAME TO staff_access_log`);
  check('S20', 'if the access-log write FAILS, the access is refused (every access is logged)', nl.statusCode === 503 || nl.statusCode === 403, `access was ALLOWED (status ${nl.statusCode}) with no log row: logging is best-effort (supportAccess.js appendAccessLog swallows the error; requireSupportAccess still returns allowed)`);
}

/* ---- things with NO customer-reachable write path: prove by search ---- */
setFamily('no-route');
{
  const fs = await import('node:fs');
  const grep = (re, dirs = ['api']) => { const hits = []; const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(js|ts)$/.test(e.name) && re.test(fs.readFileSync(path.join(root, p), 'utf8'))) hits.push(p); } }; dirs.forEach(walk); return hits; };
  const settingsWriters = grep(/UPDATE tenants[\s\S]{0,80}(plan|billing_status|limits|clerk_org_id)\s*=/i);
  check('N1', 'plan/billing_status/limits are written only by billing.js/billing_apply (webhook, signature-verified) and nowhere in a customer route', settingsWriters.every((p) => /^api\/_lib\/billing\.js$/.test(p)), settingsWriters.join(','));
  const industryW = grep(/jsonb_build_object\('(industry|packs)'|jsonb_set\([^)]*'\{?(industry|packs)/);
  check('N2', 'industry / packs are not writable by any API route (no writer in api/)', industryW.length === 0, industryW.join(','));
  const staffW = grep(/staffImport['"]?\s*[:=]\s*\{|SET limits[^;]*staffImport/);
  check('N3', 'staff import allowance is not writable by any API route (set only by M3-config/import SQL run by DeepWell)', staffW.filter((p) => !/staffImport\.js$/.test(p)).length === 0, staffW.join(','));
}
finish();
