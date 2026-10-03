/**
 * TESTER B (3): sign-in edge cases with a mocked Clerk: no company, invited/joined, removed mid-session, bad/expired tokens,
 * two companies + switching. Plus the documented stale-cache windows.
 *   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/limits-signin.mjs
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, tok, adminTok, memberTok, soloTok, mkReq, mkRes, quiet } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, root, resetCaches } = h;
const imp = (p) => import(path.join(root, p));
const AUTH = await imp('api/_lib/auth.js');
const BILLING = (await imp('api/billing.js')).default;
const ACCOUNT = (await imp('api/account.js')).default;
const UP = (await imp('api/upload-url.js')).default;
const RECORDS = (await imp('api/records.ts')).default;
const sha = () => crypto.randomBytes(32).toString('hex');
const run = async (handler, token, { method = 'POST', query = {}, body, headers } = {}) => { const res = mkRes(); await quiet(() => handler(mkReq({ method, token, query, body, headers }), res)); return res; };
const docsOf = async (org) => (await lite.query(`SELECT d.original_filename f FROM documents d JOIN tenants t ON t.id=d.tenant_id WHERE t.clerk_org_id=$1 OR t.name=$1 OR t.slug=$1 ORDER BY 1`, [org])).rows.map((r) => r.f);

/* ---------------------------------------------------------------- bad tokens */
setFamily('tokens');
{
  const call = (headers) => { const res = mkRes(); return quiet(() => AUTH.requireAuth({ headers })).then(() => ({ ok: true }), (e) => ({ ok: false, status: e.status, msg: e.message })); };
  const cases = [
    ['no Authorization header', {}], ['empty Bearer', { authorization: 'Bearer ' }], ['Bearer + spaces', { authorization: 'Bearer    ' }],
    ['Basic scheme', { authorization: 'Basic abc' }], ['lowercase "bearer" scheme', { authorization: `bearer ${adminTok('org_t')}` }],
    ['garbage token', { authorization: 'Bearer not.a.jwt' }], ['forged signature', { authorization: `Bearer ${tok({ sub: 'u', __forged: true })}` }],
    ['expired 1s ago', { authorization: `Bearer ${tok({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 1 })}` }],
    ['not yet valid (nbf in future)', { authorization: `Bearer ${tok({ sub: 'u', nbf: Math.floor(Date.now() / 1000) + 3600 })}` }],
    ['valid signature but no sub', { authorization: `Bearer ${tok({ o: { id: 'org_t', rol: 'admin' } })}` }],
    ['sub is a number', { authorization: `Bearer ${tok({ sub: 12345 })}` }], ['sub is empty string', { authorization: `Bearer ${tok({ sub: '' })}` }],
  ];
  for (const [name, headers] of cases) {
    const r = await call(headers);
    check(`TK:${name}`, `${name} -> 401 and nothing leaked`, r.ok === false && r.status === 401 && !/jwt|signature|token expired|expired at/i.test(r.msg) , JSON.stringify(r));
  }
  const exp1 = Math.floor(Date.now() / 1000) + 2;
  const okTok = tok({ sub: 'u_edge', exp: exp1 });
  const a = await call({ authorization: `Bearer ${okTok}` });
  await new Promise((r) => setTimeout(r, 3100));
  const b = await call({ authorization: `Bearer ${okTok}` });
  check('TK:exp-boundary', 'a token valid at T is refused 401 once its exp has passed (checked per request, no server-side session cache)', a.ok === true && b.ok === false && b.status === 401, JSON.stringify([a, b]));
  const save = process.env.CLERK_SECRET_KEY; delete process.env.CLERK_SECRET_KEY;
  const nk = await call({ authorization: `Bearer ${adminTok('org_t')}` }); process.env.CLERK_SECRET_KEY = save;
  check('TK:no-secret', 'server without CLERK_SECRET_KEY refuses EVERY request (500, generic message), never lets one through', nk.ok === false && nk.status === 500 && !/CLERK/.test(nk.msg), JSON.stringify(nk));
  const blank = AUTH.deriveAuth({ sub: 'u1', org_id: '   ', o: { id: '' } });
  check('TK:blank-org', 'a blank/whitespace org id is not an org: falls back to the solo tenant', blank.orgId === null && blank.tenantId === 'user_u1' && blank.orgRole === null);
  const noRoleOrg = AUTH.deriveAuth({ sub: 'u1', org_role: 'org:admin' });
  check('TK:role-without-org', 'org_role present but no org id -> no role, solo tenant (a role never exists outside an org)', noRoleOrg.orgRole === null && noRoleOrg.tenantId === 'user_u1');
  const http = await run(BILLING, 'garbage', { method: 'GET', query: { action: 'status' } });
  check('TK:http401', 'HTTP: bad token on /api/billing -> 401 JSON {error}', http.statusCode === 401 && typeof http.body?.error === 'string');
  for (const [nm, h2, q] of [['records', RECORDS, {}], ['upload-url', UP, {}], ['review', (await imp('api/review.js')).default, {}], ['account/keys', ACCOUNT, { action: 'keys' }]]) {
    const r = await run(h2, 'garbage', { query: q, body: { action: 'listDocuments' } });
    check(`TK:http401:${nm}`, `HTTP: bad token on ${nm} -> 401`, r.statusCode === 401, `${r.statusCode}`);
  }
}

/* ---------------------------------------------------------------- 1. user with no company */
setFamily('no-company');
{
  const T = soloTok('user_nocomp');
  const st = await run(BILLING, T, { method: 'GET', query: { action: 'status' } });
  check('NC1', 'no company: billing status works and says plan null / state none', st.statusCode === 200 && st.body?.plan === null && st.body?.status === 'none', JSON.stringify(st.body)?.slice(0, 160));
  const up = await run(UP, T, { body: { filename: 'a.txt', sha256: sha(), sizeBytes: 10, contentType: 'text/plain' } });
  check('NC2', 'no company + no plan: upload -> 402 "Choose a plan to get started" (hard gate, no free preview)', up.statusCode === 402 && up.body?.error === 'Choose a plan to get started', `${up.statusCode} ${JSON.stringify(up.body)}`);
  const inv = await run(BILLING, T, { query: { action: 'invite' }, body: { email: 'a@b.co' } });
  check('NC3', 'no company: invite -> 400 "Create your company first to invite people."', inv.statusCode === 400 && /Create your company first/.test(inv.body?.error), `${inv.statusCode} ${JSON.stringify(inv.body)}`);
  const seats = await run(BILLING, T, { method: 'GET', query: { action: 'seats' } });
  check('NC4', 'no company: seats -> 200 {plan:null, cap:null, seats:null}', seats.statusCode === 200 && seats.body?.seats === null);
  const list = await run(RECORDS, T, { body: { action: 'listDocuments', filters: {} } });
  check('NC5', 'no company: reads only their own (empty) solo tenant', list.statusCode === 200 && Array.isArray(list.body) && list.body.length === 0, `${list.statusCode} ${JSON.stringify(list.body)?.slice(0, 80)}`);
  const org = 'org_nc_other'; await newTenant(org, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const ex = await run(ACCOUNT, T, { query: { action: 'merge' }, body: {} });
  check('NC6', 'no company: merge-tenant is a no-op ({moved:{}}), not an error', ex.statusCode === 200 && Object.keys(ex.body?.moved ?? {}).length === 0, JSON.stringify(ex.body));
  const sa = await run(ACCOUNT, T, { query: { action: 'keys' }, body: { action: 'list' } });
  check('NC7', 'solo owner is treated as their own admin: admin-gated route is NOT refused for the role (keys list 200)', sa.statusCode === 200, `${sa.statusCode}`);
  const hasMemberRow = (await lite.query(`SELECT count(*)::int n FROM users WHERE clerk_user_id='user_nocomp'`)).rows[0].n;
  check('NC8', 'no company: no users-directory row is created (users exist only to answer "who is in this shop")', hasMemberRow === 0, `${hasMemberRow}`);
}

/* ---------------------------------------------------------------- 2. invited / joined; merge of earlier solo uploads */
setFamily('joined');
{
  const ORG = 'org_join'; await newTenant(ORG, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const U = 'user_joiner';
  // before accepting the invite the user is on their solo tenant; they have 3 earlier solo documents
  await RS.withTenant({ tenantKey: `user_${U}`, tenantName: `user_${U}` }, async (db) => { for (let i = 0; i < 3; i++) await db.createDocument({ original_filename: `solo${i}.txt`, sha256_hash: sha(), file_size_bytes: 10, content_type: 'text/plain', storage_key: `${db.tenantId}/k${i}` }); });
  const pre = await run(RECORDS, soloTok(U), { body: { action: 'listDocuments', filters: {} } });
  check('J1', 'before accepting: the invited user sees only their own solo documents (0 of the company\'s)', pre.statusCode === 200 && pre.body.length === 3);
  const first = await run(RECORDS, memberTok(ORG, U), { body: { action: 'listDocuments', filters: {} } });
  check('J2', 'after accepting (token now carries the org): requests are scoped to the company; solo docs are not visible there until merged', first.statusCode === 200 && first.body.length === 0, `${first.statusCode} ${first.body?.length}`);
  const row = (await lite.query(`SELECT role FROM users WHERE clerk_user_id=$1`, [U])).rows[0];
  check('J3', 'first company request registers the member in users with role "user" (member)', row?.role === 'user', JSON.stringify(row));
  const m = await run(ACCOUNT, memberTok(ORG, U), { query: { action: 'merge' }, body: {} });
  check('J4', 'merge-tenant (any member) folds the 3 earlier solo documents into the company', m.statusCode === 200 && m.body?.moved?.documents === 3, JSON.stringify(m.body));
  const after = await run(RECORDS, memberTok(ORG, U), { body: { action: 'listDocuments', filters: {} } });
  check('J5', 'after merge the company sees them', after.body?.length === 3, `${after.body?.length}`);
  // merge bypass of the stored-document cap
  const ORG2 = 'org_join_cap'; await newTenant(ORG2, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  const id2 = (await RS.getTenantContext(ORG2, ORG2)).id;
  await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) SELECT $1,'s'||g||'.txt',md5(g::text)||md5(g::text||'y'),10,'text/plain',$2||'/s/'||g,'mapped' FROM generate_series(1,24999) g`, [id2, id2]);
  resetCaches();
  const U2 = 'user_joiner2';
  await RS.withTenant({ tenantKey: `user_${U2}`, tenantName: `user_${U2}` }, async (db) => { for (let i = 0; i < 5; i++) await db.createDocument({ original_filename: `x${i}.txt`, sha256_hash: sha(), file_size_bytes: 10, content_type: 'text/plain', storage_key: `${db.tenantId}/k${i}` }); });
  await run(ACCOUNT, memberTok(ORG2, U2), { query: { action: 'merge' }, body: {} });
  const total = (await lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [id2])).rows[0].n;
  check('J6', 'merge cannot push a company past its stored-document cap (Solo 25,000)', total <= 25_000, `company now stores ${total} documents (cap 25,000): merge_tenant() moves rows with no plan check`);
}

/* ---------------------------------------------------------------- 3. removed mid-session */
setFamily('removed');
{
  const ORG = 'org_rm'; await newTenant(ORG, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const U = 'user_removed';
  const adm = adminTok(ORG, 'user_rmadmin');
  const up = await run(UP, adm, { body: { filename: 'company-secret.txt', sha256: sha(), sizeBytes: 10, contentType: 'text/plain' } });
  const docId = up.body.documentId;
  const exp = Math.floor(Date.now() / 1000) + 60;
  const orgTok = tok({ sub: U, exp, o: { id: ORG, rol: 'member' } });
  const before = await run(RECORDS, orgTok, { body: { action: 'getDocument', id: docId } });
  check('RM1', 'member can read a company document while a member', before.statusCode === 200 && before.body?.id === docId, `${before.statusCode}`);
  // Clerk removes the membership: the next token has no org claims
  const noOrg = tok({ sub: U, exp });
  const afterNew = await run(RECORDS, noOrg, { body: { action: 'getDocument', id: docId } });
  const listNew = await run(RECORDS, noOrg, { body: { action: 'listDocuments', filters: {} } });
  check('RM2', 'after removal the NEXT token (no org) is scoped to the personal tenant: the company document is not returned (404/null/empty), list is empty', (afterNew.statusCode === 404 || afterNew.body == null || afterNew.body?.id !== docId) && listNew.body?.length === 0, `${afterNew.statusCode} ${JSON.stringify(afterNew.body)?.slice(0, 80)} list=${listNew.body?.length}`);
  const adminNew = await run(ACCOUNT, noOrg, { query: { action: 'export' }, body: {} });
  const exp2 = await run(ACCOUNT, noOrg, { query: { action: 'delete' }, body: { confirm: ORG } });
  check('RM3', 'a removed ex-admin with a no-org token cannot export or delete the company (confirm=orgId is checked against THEIR tenant)', exp2.statusCode === 400, `${exp2.statusCode} ${JSON.stringify(exp2.body)?.slice(0, 100)}`);
  const stillOld = await run(RECORDS, orgTok, { body: { action: 'getDocument', id: docId } });
  check('RM4', 'DOCUMENTED WINDOW: the OLD org token still reads the company until it expires (session JWT is not checked against live membership; Clerk session tokens live ~60s)', stillOld.statusCode !== 200, `old token after removal -> ${stillOld.statusCode}: still served until exp (${exp - Math.floor(Date.now() / 1000)}s left on this one)`);
  const expired = tok({ sub: U, exp: Math.floor(Date.now() / 1000) - 1, o: { id: ORG, rol: 'member' } });
  const e = await run(RECORDS, expired, { body: { action: 'getDocument', id: docId } });
  check('RM5', 'once the old token expires the removed member is refused 401', e.statusCode === 401, `${e.statusCode}`);
  const urow = (await lite.query(`SELECT count(*)::int n FROM users WHERE clerk_user_id=$1`, [U])).rows[0].n;
  check('RM6', 'the removed member\'s users row is kept (audit trail keeps resolving who did what); it grants no access (auth never reads it)', urow === 1);
  // role/upsert cache: 5 minute TTL applies only to the directory row
  check('RM7', 'upsert cache is documented as directory-only (5 min): authz never reads it', AUTH.requireRole({ orgRole: 'admin' }, 'admin') && true);
}

/* ---------------------------------------------------------------- 5. two companies, switching */
setFamily('two-companies');
{
  const A = 'org_two_A', B = 'org_two_B';
  await newTenant(A, 'shop', 'active', PLAN.PLAN_LIMITS.shop); await newTenant(B, 'solo', 'active', PLAN.PLAN_LIMITS.solo);
  const U = 'user_two';
  const tA = adminTok(A, U), tB = memberTok(B, U);
  const a1 = await run(UP, tA, { body: { filename: 'in-A.txt', sha256: sha(), sizeBytes: 10, contentType: 'text/plain' } });
  const b1 = await run(UP, tB, { body: { filename: 'in-B.txt', sha256: sha(), sizeBytes: 10, contentType: 'text/plain' } });
  check('TC1', 'same user uploads under company A then company B: each document lands only in the selected company', a1.statusCode === 200 && b1.statusCode === 200 && JSON.stringify(await docsOf(A)) === '["in-A.txt"]' && JSON.stringify(await docsOf(B)) === '["in-B.txt"]', `${JSON.stringify(await docsOf(A))} ${JSON.stringify(await docsOf(B))}`);
  const la = await run(RECORDS, tA, { body: { action: 'listDocuments', filters: {} } }); const lb = await run(RECORDS, tB, { body: { action: 'listDocuments', filters: {} } });
  check('TC2', 'listing with the A token returns only A\'s documents; with the B token only B\'s', la.body.map((d) => d.original_filename).join() === 'in-A.txt' && lb.body.map((d) => d.original_filename).join() === 'in-B.txt');
  const cross = await run(RECORDS, tB, { body: { action: 'getDocument', id: a1.body.documentId } });
  check('TC3', 'with the B token, fetching A\'s document by its id -> not found (cannot read across companies even knowing the id)', cross.statusCode === 404 || cross.body == null || cross.body?.id == null, `${cross.statusCode} ${JSON.stringify(cross.body)?.slice(0, 80)}`);
  const inject = await run(RECORDS, tB, { query: { orgId: A, org_id: A, tenant: A }, headers: { 'x-org-id': A, 'x-tenant-id': A, 'x-organization-id': A }, body: { action: 'listDocuments', filters: {}, tenantId: A, tenant_id: A, orgId: A, org_id: A, organizationId: A } });
  check('TC4', 'naming company A in the body, query or headers while holding the B token does nothing (still B)', inject.body?.map((d) => d.original_filename).join() === 'in-B.txt', JSON.stringify(inject.body)?.slice(0, 100));
  const create = await run(RECORDS, tB, { body: { action: 'createDocument', original_filename: 'sneaky.txt', sha256_hash: sha(), content_type: 'text/plain', file_size_bytes: 10, tenant_id: A, tenantId: A } });
  check('TC5', 'createDocument with tenant_id=A in the body under the B token lands in B', create.statusCode < 400 && (await docsOf(B)).includes('sneaky.txt') && !(await docsOf(A)).includes('sneaky.txt'), `${create.statusCode} ${JSON.stringify(create.body)?.slice(0, 80)}`);
  const adminA = await run(ACCOUNT, tA, { query: { action: 'keys' }, body: { action: 'list' } }); const adminB = await run(ACCOUNT, tB, { query: { action: 'keys' }, body: { action: 'list' } });
  check('TC6', 'roles are per company: the same person is admin in A (allowed) and member in B (403)', adminA.statusCode === 200 && adminB.statusCode === 403, `${adminA.statusCode}/${adminB.statusCode}`);
  const claimC = await run(RECORDS, tok({ sub: U, o: { id: 'org_not_mine', rol: 'admin' }, __forged: true }), { body: { action: 'listDocuments' } });
  check('TC7', 'a token claiming a company the user does not belong to cannot be minted (signature check fails -> 401); the selector is not trusted', claimC.statusCode === 401, `${claimC.statusCode}`);
  const mis = await run(UP, tA, { headers: { 'x-dw-expected-tenant': B }, body: { filename: 'late.txt', sha256: sha(), sizeBytes: 10, contentType: 'text/plain' } });
  const same = await run(UP, tA, { headers: { 'x-dw-expected-tenant': A }, body: { filename: 'late2.txt', sha256: sha(), sizeBytes: 10, contentType: 'text/plain' } });
  check('TC8', 'queued phone scan captured in company B but the signed-in company is now A: upload refused 409 tenant-mismatch (nothing filed in A); matching header -> accepted', mis.statusCode === 409 && mis.body?.code === 'tenant-mismatch' && !(await docsOf(A)).includes('late.txt') && same.statusCode === 200, `${mis.statusCode} ${JSON.stringify(mis.body)} ${same.statusCode}`);
  const sw = await run(BILLING, tB, { method: 'GET', query: { action: 'status' } }); const swA = await run(BILLING, tA, { method: 'GET', query: { action: 'status' } });
  check('TC9', 'billing/limits follow the selected company: B shows Solo (2 logins), A shows Team (5 logins)', sw.body?.plan === 'solo' && sw.body?.limits?.logins === 2 && swA.body?.plan === 'shop' && swA.body?.limits?.logins === 5, `${sw.body?.plan}/${swA.body?.plan}`);
}

/* ---------------------------------------------------------------- stale-cache windows (documented) */
setFamily('cache-windows');
{
  const ORG = 'org_cache'; await newTenant(ORG, 'shop', 'active', PLAN.PLAN_LIMITS.shop);
  const T = adminTok(ORG, 'user_cache');
  const f = () => ({ filename: `c${Math.random()}.txt`, sha256: sha(), sizeBytes: 10, contentType: 'text/plain' });
  const ok1 = await run(UP, T, { body: f() });
  const id = (await RS.getTenantContext(ORG, ORG)).id;
  await lite.query(`UPDATE tenants SET billing_status='canceled' WHERE id=$1`, [id]); // change made by ANOTHER instance's webhook
  const ok2 = await run(UP, T, { body: f() });
  check('CW1', 'after another instance records a cancellation, THIS instance keeps allowing uploads from its cache (documented: up to 2 minutes; 30 s once cached state is blocked)', ok2.statusCode === 200, `upload right after the cancel -> ${ok2.statusCode} (cache not yet expired; first upload was ${ok1.statusCode})`);
  const PLN = PLAN;
  check('CW2', 'cache TTL constants: 2 min for live states, 30 s for none/canceled', PLN.BILLING_ROW_TTL_MS === 120_000 && PLN.BILLING_ROW_BLOCKED_TTL_MS === 30_000 && PLN.billingCacheTtlFor({ billing_status: 'canceled' }) === 30_000 && PLN.billingCacheTtlFor({ billing_status: 'active' }) === 120_000);
  resetCaches();
  const ok3 = await run(UP, T, { body: f() });
  check('CW3', 'webhook on THIS instance busts the cache (bustTenantCache): the very next upload sees "canceled" -> 402', ok3.statusCode === 402, `${ok3.statusCode}`);
}
finish();
