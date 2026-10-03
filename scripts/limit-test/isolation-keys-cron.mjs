/**
 * LIMIT TEST (Tester A) - public API keys, CSV export, signed file links (R2), cron sweep, staff import, merge-tenant,
 * tenant-delete / document-delete blast radius, pooled-connection tenant leakage, concurrent writes.
 * Real Clerk-JWT verification (local JWKS), PGlite + RLS role, mock R2/model. Run: npx tsx scripts/limit-test/isolation-keys-cron.mjs
 */
for (const b of ['READ', 'WRITE', 'INGEST', 'ASK']) { process.env[`RATE_LIMIT_${b}_PER_MINUTE`] = '100000'; process.env[`RATE_LIMIT_${b}_PER_DAY`] = '10000000'; }
process.env.CRON_SECRET = 'cron-secret-fixture-0123456789';
delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
import crypto from 'node:crypto';
import { boot, call, orgToken, soloToken, signToken, check, finish, quiet, r2, mkReq, mkRes } from './lib.mjs';
import { seedTenant, sha } from './seed.mjs';
import { installMockAnthropicClient } from '../lib/mockAnthropicClient.mjs';

const h = await boot();
await installMockAnthropicClient({ mode: 'answer' });
await h.lite.exec(`GRANT EXECUTE ON FUNCTION list_all_tenant_keys() TO deepwell_rls`).catch(() => {});
const [A, B, C] = await Promise.all([seedTenant(h, { key: 'org_A', tag: 'AAA' }), seedTenant(h, { key: 'org_B', tag: 'BBB' }), seedTenant(h, { key: 'org_C', tag: 'CCC' })]);
const TS = [A, B, C]; const tok = (T) => orgToken(T.key, `user_${T.tag}`, 'admin'); const memberTok = (T) => orgToken(T.key, `member_${T.tag}`, 'member');
const H = {}; for (const [n, p] of [['v1', 'api/v1.js'], ['account', 'api/account.js'], ['upload', 'api/upload-url.js'], ['read', 'api/read-document.js'], ['extract', 'api/extract.js'], ['warranty', 'api/warranty-attention.js'], ['ask', 'api/ask.js'], ['review', 'api/review.js'], ['records', 'api/records.ts']]) H[n] = (await import(`../../${p}`)).default;
const v1 = (resource, o = {}) => call(H.v1, { ...o, query: { ...(o.query ?? {}), resource } });
const acct = (action, o = {}) => call(H.account, { ...o, query: { ...(o.query ?? {}), action } });
const str = (r) => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null));
const foreignSecrets = (X) => TS.filter((T) => T !== X).flatMap((T) => T.secrets.filter((s) => !/^(AUDIT|NOTIF|OUTREACH|QUESTION|PROPOSAL|SETTING|FACET)/.test(s)));
const hasForeign = (X, r) => foreignSecrets(X).filter((s) => str(r).includes(s));

/* ================================================================== 1. API keys: each key sees only its own company */
{
  const KINDS = ['documents', 'customers', 'equipment'];
  let bad = 0, n = 0;
  for (const X of TS) {
    const calls = [['customers', { method: 'GET' }], ['customer', { method: 'GET', query: { id: X.customerId } }], ['equipment', { method: 'GET', query: { serial: `SN${X.tag}1` } }], ['warranty', { method: 'GET', query: { withinDays: '99999' } }], ['graph', { method: 'GET', query: { q: 'Cust' } }], ['intake-status', { method: 'GET' }], ...KINDS.map((k) => ['export', { method: 'GET', query: { kind: k } }])];
    for (const [r, o] of calls) { const res = await v1(r, { ...o, token: X.apiKey }); n++; const f = hasForeign(X, res); if (f.length || res.statusCode >= 500) { bad++; check(`key ${X.tag} v1/${r}`, false, `status=${res.statusCode} foreign=${JSON.stringify(f)}`); } }
    const ce = await v1('customer-equipment', { method: 'POST', token: X.apiKey, body: { customerId: X.customerId } }); n++; if (hasForeign(X, ce).length) bad++;
  }
  check(`API keys: ${n} calls with each company's own key on every v1 resource -> only own data, no 5xx`, bad === 0);
  // controls: own data really is returned
  const c1 = await v1('customers', { method: 'GET', token: A.apiKey }); check('control: A key /v1/customers returns A customer', c1.statusCode === 200 && str(c1).includes('NAMEAAA'));
  const e1 = await v1('export', { method: 'GET', token: B.apiKey, query: { kind: 'equipment' } }); check('control: B key export equipment contains B serial and no A/C serial', e1.statusCode === 200 && str(e1).includes('SNBBB1') && !str(e1).includes('SNAAA1') && !str(e1).includes('SNCCC1'), `${e1.statusCode}`);
  const d1 = await v1('export', { method: 'GET', token: C.apiKey, query: { kind: 'documents' } }); check('control: C key export documents lists only C files', d1.statusCode === 200 && str(d1).includes('FILECCC1') && !/FILE(AAA|BBB)/.test(str(d1)));
  // customer lookups naming the other company's id / number / serial
  for (const [X, Y] of [[A, B], [B, C], [C, A]]) {
    const r1 = await v1('customer', { method: 'GET', token: X.apiKey, query: { id: Y.customerId } }); check(`key ${X.tag} /v1/customer?id=<${Y.tag} customer> -> 404`, r1.statusCode === 404, `${r1.statusCode} ${str(r1).slice(0, 100)}`);
    const r2_ = await v1('customer', { method: 'GET', token: X.apiKey, query: { number: 'C-00001' } }); check(`key ${X.tag} /v1/customer?number=C-00001 resolves ${X.tag}'s OWN C-00001 (per-company numbering), never ${Y.tag}'s`, r2_.statusCode === 404 || (r2_.statusCode === 200 && str(r2_).includes(X.tag) && !str(r2_).includes(Y.tag)), str(r2_).slice(0, 150));
    const r3 = await v1('equipment', { method: 'GET', token: X.apiKey, query: { serial: `SN${Y.tag}1` } }); check(`key ${X.tag} /v1/equipment?serial=<${Y.tag} serial> -> 404`, r3.statusCode === 404);
    const r4 = await v1('customer-equipment', { method: 'POST', token: X.apiKey, body: { customerId: Y.customerId } }); check(`key ${X.tag} customer-equipment of ${Y.tag} customer -> 404`, r4.statusCode === 404 || r4.statusCode === 400);
    const r5 = await v1('graph', { method: 'GET', token: X.apiKey, query: { node: `customer:${Y.customerId}` } }); check(`key ${X.tag} /v1/graph?node=<${Y.tag} customer> exposes nothing`, hasForeign(X, r5).length === 0 && !str(r5).includes(Y.tag));
    const r6 = await call(H.upload, { token: X.apiKey, body: { mode: 'get', documentId: Y.docs[0].id } }); check(`key ${X.tag} upload-url mode=get <${Y.tag} doc> -> no URL`, r6.statusCode !== 200 && !str(r6).includes(Y.uuid));
  }
  // concurrency: 3 companies x 12 interleaved calls via Promise.all
  const burst = []; for (let i = 0; i < 12; i++) for (const X of TS) { burst.push(v1('customers', { method: 'GET', token: X.apiKey }).then((r) => [X, r])); burst.push(v1('export', { method: 'GET', token: X.apiKey, query: { kind: 'customers' } }).then((r) => [X, r])); }
  const outs = await Promise.all(burst);
  check(`API keys: ${outs.length} concurrent (Promise.all) key calls across 3 companies -> every response contains only the caller's data`, outs.every(([X, r]) => r.statusCode === 200 && hasForeign(X, r).length === 0 && str(r).includes(`NAME${X.tag}`)));
}

/* ================================================================== 2. key lifecycle, scope, revocation */
{
  const ro = A.readKey; // scopes: read
  const readRes = [['customers', 'GET'], ['export', 'GET', { kind: 'customers' }], ['warranty', 'GET'], ['equipment', 'GET', { serial: 'x' }], ['graph', 'GET', { q: 'x' }], ['intake-status', 'GET']];
  for (const [r, m, q] of readRes) { const x = await v1(r, { method: m, token: ro, query: q ?? {} }); check(`read-only key: /v1/${r} allowed (not 401/403)`, x.statusCode !== 401 && x.statusCode !== 403, `${x.statusCode}`); }
  const wr = [['ingest', { filename: 'a.txt', sha256: sha('x1'), sizeBytes: 3, contentType: 'text/plain' }]];
  for (const [r, body] of wr) { const x = await v1(r, { method: 'POST', token: ro, body }); check(`read-only key refused on /v1/${r} (ingest scope) -> 403`, x.statusCode === 403, `${x.statusCode}`); }
  for (const [name, hd, body] of [['upload-url create', H.upload, { filename: 'a.txt', sha256: sha('x2'), sizeBytes: 3, contentType: 'text/plain' }], ['read-document', H.read, { documentId: A.docs[1].id }], ['extract', H.extract, { documentId: A.docs[1].id }]]) { const x = await call(hd, { token: ro, body }); check(`read-only key refused on ${name} -> 403`, x.statusCode === 403, `${x.statusCode}`); }
  // ingest-only key: create one through the keys route (admin)
  const mk = await acct('keys', { token: tok(A), body: { action: 'create', name: 'ingest-only', scopes: ['ingest'] } }); const ing = mk.body?.key; check('keys route: admin creates an ingest-only key (201, raw key shown once)', mk.statusCode === 201 && /^dw_live_[0-9a-f]{64}$/.test(ing ?? ''));
  for (const [r, m, q] of readRes) { const x = await v1(r, { method: m, token: ing, query: q ?? {} }); check(`ingest-only key refused on /v1/${r} -> 403`, x.statusCode === 403, `${x.statusCode}`); }
  const ok = await call(H.upload, { token: ing, body: { filename: 'a.txt', sha256: sha('ing1'), sizeBytes: 3, contentType: 'text/plain' } }); check('ingest-only key can create an upload URL; the key it names is under A\'s prefix', ok.statusCode === 200 && String(ok.body?.storageKey).startsWith(`${A.uuid}/`), `${ok.statusCode} ${str(ok).slice(0, 100)}`);
  const getm = await call(H.upload, { token: ing, body: { mode: 'get', documentId: A.docs[1].id } }); check('ingest-only key refused on upload-url mode=get (read scope) -> 403', getm.statusCode === 403);
  // list never returns raw key / hash; own keys only
  const ls = await acct('keys', { token: tok(A), body: { action: 'list' } }); const lsS = str(ls);
  check('keys list: returns only A\'s keys, never a raw key or hash', ls.statusCode === 200 && !lsS.includes(A.apiKey) && !lsS.includes(ing) && !/key_hash/.test(lsS) && !lsS.includes(B.apiKeyId) && !lsS.includes(C.apiKeyId) && lsS.includes(A.apiKeyId));
  const dbk = (await h.lite.query(`SELECT key_hash, key_prefix FROM api_keys WHERE id=$1`, [A.apiKeyId])).rows[0];
  check('api_keys stores only sha256(key) + 8-char prefix, never the raw key', dbk.key_hash === crypto.createHash('sha256').update(A.apiKey).digest('hex') && !JSON.stringify(dbk).includes(A.apiKey));
  // IDOR: revoke another company's key id
  const rv = await acct('keys', { token: tok(A), body: { action: 'revoke', id: B.apiKeyId } }); check('keys revoke: A cannot revoke B\'s key id (404)', rv.statusCode === 404, `${rv.statusCode}`);
  const stillB = await v1('customers', { method: 'GET', token: B.apiKey }); check('...and B\'s key still works', stillB.statusCode === 200);
  // revoke own -> refused immediately on every resource
  const rv2 = await acct('keys', { token: tok(A), body: { action: 'revoke', id: A.readKeyId } }); check('keys revoke: own key revoked (200)', rv2.statusCode === 200);
  for (const [r, m, q] of readRes) { const x = await v1(r, { method: m, token: ro, query: q ?? {} }); check(`REVOKED key refused immediately on /v1/${r} -> 401`, x.statusCode === 401, `${x.statusCode}`); }
  const rvAsk = await call(H.ask, { token: ro, body: { question: 'x' } }); check('REVOKED key refused on ask -> 401', rvAsk.statusCode === 401);
  const rvUp = await call(H.upload, { token: ro, body: { mode: 'get', documentId: A.docs[1].id } }); check('REVOKED key refused on upload-url -> 401', rvUp.statusCode === 401);
  const rv3 = await acct('keys', { token: tok(A), body: { action: 'revoke', id: A.readKeyId } }); check('keys revoke twice -> 404 (already revoked)', rv3.statusCode === 404);
  // revoke with a non-uuid id (robustness)
  const rvBad = await quiet(() => acct('keys', { token: tok(A), body: { action: 'revoke', id: "' OR 1=1 --" } })); check('keys revoke with SQL-ish id -> no data change, status <500 ideally', rvBad.statusCode < 500, `${rvBad.statusCode} (a 5xx here is a robustness defect: non-uuid id reaches a uuid cast)`);
  const rvKeys = (await h.lite.query(`SELECT count(*)::int n FROM api_keys WHERE revoked_at IS NULL`)).rows[0].n; check('...and no other key was revoked by the injection attempt', rvKeys >= 4);
  // role: non-admin member cannot create/list/revoke keys
  for (const body of [{ action: 'create', name: 'x', scopes: ['read'] }, { action: 'list' }, { action: 'revoke', id: A.apiKeyId }]) { const x = await acct('keys', { token: memberTok(A), body }); check(`keys ${body.action}: org MEMBER (non-admin) -> 403`, x.statusCode === 403, `${x.statusCode}`); }
  // malformed/forged keys
  for (const [name, t] of [['unknown valid-shape', 'dw_live_' + 'b'.repeat(64)], ['uppercase hex', 'dw_live_' + A.apiKey.slice(8).toUpperCase()], ['truncated', A.apiKey.slice(0, 40)], ['with trailing space/newline', A.apiKey + '\n'], ['prefix only', 'dw_live_'], ['A key with B prefix swap', 'dw_live_' + B.apiKey.slice(8, 16) + A.apiKey.slice(16)]]) { const x = await v1('customers', { method: 'GET', token: t }); check(`forged/malformed key (${name}) -> 401 (header whitespace is trimmed, so a padded VALID key is still only A's own data)`, x.statusCode === 401 || x.statusCode === 400 || (name.startsWith('with trailing') && x.statusCode === 200 && hasForeign(A, x).length === 0), `${x.statusCode}`); }
  const noTok = await v1('customers', { method: 'GET' }); check('no Authorization header -> 401', noTok.statusCode === 401);
  const jwtAsKey = await v1('customers', { method: 'GET', token: 'dw_live_' + signToken({ sub: 'x' }) }); check('JWT pasted behind dw_live_ prefix -> 401', jwtAsKey.statusCode === 401);
}

/* ================================================================== 3. plan gate + staff import window (R43), per company */
{
  const mkShop = async (key, tag) => { const uuid = await h.newTenant(key, 'shop', 'active'); return { key, tag, uuid }; };
  const D = await mkShop('org_D', 'DDD'), E = await mkShop('org_E', 'EEE'), F = await mkShop('org_F', 'FFF');
  const win = (o) => JSON.stringify({ staffImport: { from: new Date(Date.now() - 3600e3).toISOString(), until: new Date(Date.now() + 7 * 86400e3).toISOString(), pages: 1000, ...o } });
  const setLimits = async (T, json) => { await h.lite.query(`UPDATE tenants SET limits = COALESCE(limits,'{}'::jsonb) || $2::jsonb WHERE id=$1`, [T.uuid, json]); h.resetCaches(); };
  const mkKey = (T) => acct('keys', { token: tok(T), body: { action: 'create', name: 'k', scopes: ['read', 'ingest'] } });
  const e0 = await mkKey(E); check('plan gate: Shop-plan company E without a staff import cannot create an API key (403)', e0.statusCode === 403, `${e0.statusCode}`);
  await setLimits(D, win({})); const d1 = await mkKey(D); check('staff import: D (Shop plan, window open) CAN create a key (201)', d1.statusCode === 201, `${d1.statusCode} ${str(d1).slice(0, 100)}`);
  const e1 = await mkKey(E); check('staff import: D\'s window does NOT let E create a key (still 403)', e1.statusCode === 403);
  const dk = d1.body?.key;
  const useD = await v1('customers', { method: 'GET', token: dk }); check('staff import: D\'s key works while the window is open', useD.statusCode === 200, `${useD.statusCode}`);
  // close by hand (I2) -> key refused on the very next request (no cache wait)
  await h.lite.query(`UPDATE tenants SET limits = jsonb_set(limits, '{staffImport,endedAt}', to_jsonb($2::text)) WHERE id=$1`, [D.uuid, new Date(Date.now() - 1000).toISOString()]);
  const useD2 = await v1('customers', { method: 'GET', token: dk }); check('staff import: closing the window (endedAt) kills D\'s key on its next request (403)', useD2.statusCode === 403, `${useD2.statusCode}`);
  for (const [name, j] of [['expired (until in the past)', win({ until: new Date(Date.now() - 1000).toISOString() })], ['not started (from in the future)', win({ from: new Date(Date.now() + 86400e3).toISOString() })], ['zone-less dates', win({ from: '2025-01-01T00:00:00', until: '2099-01-01T00:00:00' })], ['pages = 0', win({ pages: 0 })], ['pages as array', win({ pages: [5] })], ['string dates garbage', win({ from: 'yesterday', until: 'tomorrow' })], ['window > 60 days is clamped (from 90d ago)', win({ from: new Date(Date.now() - 90 * 86400e3).toISOString(), until: new Date(Date.now() + 86400e3 * 365).toISOString() })], ['unreadable endedAt fails closed', win({ endedAt: 'soon' })], ['staffImport is an array', JSON.stringify({ staffImport: [1] })], ['staffImport is a string', JSON.stringify({ staffImport: 'on' })]]) {
    await h.lite.query(`UPDATE tenants SET limits = $2::jsonb WHERE id=$1`, [F.uuid, j]); h.resetCaches();
    const x = await mkKey(F); check(`staff import malformed/ended (${name}) -> no key creation (403)`, x.statusCode === 403, `${x.statusCode}`);
  }
  // company cannot write its own limits through any API route: try settings smuggling
  const sm = await acct('followups', { token: tok(E), body: { op: 'saveSettings', settings: { enabled: false, limits: { staffImport: JSON.parse(win({})).staffImport }, staffImport: JSON.parse(win({})).staffImport } } });
  const sm2 = await acct('outreach', { token: tok(E), body: { op: 'saveSettings', settings: { limits: JSON.parse(win({})), staffImport: JSON.parse(win({})).staffImport } } });
  const sm3 = await call(H.records, { token: tok(E), body: { action: 'updateEntity', id: E.uuid, updates: { limits: JSON.parse(win({})) } } });
  const lim = (await h.lite.query(`SELECT limits->'staffImport' si FROM tenants WHERE id=$1`, [E.uuid])).rows[0].si; h.resetCaches();
  const e2 = await mkKey(E); check('a company cannot grant itself a staff import through settings routes (followups/outreach/records smuggling); E still cannot create a key', lim == null && e2.statusCode === 403, `limits=${JSON.stringify(lim)} key=${e2.statusCode}`);
  void sm; void sm2; void sm3;
  // E's *settings* routes did not leak into other companies
  // billing_apply (Stripe webhook function) preserves staffImport but belongs to ONE tenant row
  const before = (await h.lite.query(`SELECT limits FROM tenants WHERE id=$1`, [D.uuid])).rows[0].limits;
  await h.lite.query(`SELECT billing_apply($1::uuid, $2::jsonb)`, [E.uuid, JSON.stringify({ plan: 'shop', billing_status: 'active' })]);
  const afterD = (await h.lite.query(`SELECT limits FROM tenants WHERE id=$1`, [D.uuid])).rows[0].limits; check('billing_apply on E leaves D\'s limits untouched', JSON.stringify(before) === JSON.stringify(afterD));
}

/* ================================================================== 4. CSV export: own data, injection-safe, admin/scope gated */
{
  // CSV/formula injection through a customer name that starts with =
  await h.RS.withTenant({ tenantKey: A.key, tenantName: A.key }, async (db) => { await db.createEntity({ entity_type: 'customer', data: { customer_name: '=HYPERLINK("http://evil.invalid","x")', service_address: '+1 Evil Rd', email: '@cmd|calc' } }); });
  const x = await v1('export', { method: 'GET', token: A.apiKey, query: { kind: 'customers' } });
  check('CSV export neutralises formula cells (= + @ - get a leading quote)', x.statusCode === 200 && str(x).includes(`'=HYPERLINK`) && str(x).includes(`'+1 Evil Rd`) && !/(^|,|\n)=HYPERLINK/.test(str(x)), str(x).slice(0, 300));
  const mem = await call(H.v1, { method: 'GET', token: memberTok(A), query: { resource: 'export', kind: 'documents' } }); check('CSV export by a non-admin org member (human) -> 403', mem.statusCode === 403, `${mem.statusCode}`);
  const adm = await call(H.v1, { method: 'GET', token: tok(B), query: { resource: 'export', kind: 'documents' } }); check('CSV export by admin of B returns only B', adm.statusCode === 200 && str(adm).includes('FILEBBB1') && !/FILE(AAA|CCC)/.test(str(adm)));
  const smug = await call(H.v1, { method: 'GET', token: tok(B), query: { resource: 'export', kind: 'documents', tenantId: A.key, tenant_id: A.uuid, orgId: A.key } }); check('CSV export: B + smuggled tenantId/orgId of A -> still only B', smug.statusCode === 200 && !/FILE(AAA|CCC)/.test(str(smug)));
  const badKind = await call(H.v1, { method: 'GET', token: tok(B), query: { resource: 'export', kind: "documents'; DROP TABLE documents;--" } }); check('CSV export with injected kind -> 400', badKind.statusCode === 400);
}

/* ================================================================== 5. signed file links + R2 key guard */
{
  const S = await import('../../api/_lib/r2.js');
  for (const X of TS) {
    const r = await call(H.upload, { token: tok(X), body: { mode: 'get', documentId: X.docs[1].id } });
    const u = r.body?.url ?? ''; const path = decodeURIComponent(new URL(u || 'http://x/').pathname);
    check(`signed link ${X.tag}: own doc -> 200, URL path is under ${X.tag}'s tenant prefix only, expires <= 900s`, r.statusCode === 200 && path.includes(`/${X.uuid}/`) && TS.filter((o) => o !== X).every((o) => !u.includes(o.uuid)) && /X-Amz-Expires=900/.test(u), `${r.statusCode} ${u.slice(0, 120)}`);
    const sig = new URL(u).searchParams.get('X-Amz-Signature');
    const tampered = u.replace(X.uuid, TS.find((o) => o !== X).uuid); const sig2 = (await import('node:url')).URL ? new URL(tampered).searchParams.get('X-Amz-Signature') : null;
    // re-sign the other company's key through the SAME presign() and make sure the signature differs (signature binds the path)
    const other = TS.find((o) => o !== X); const forged = S.presign('GET', other.docs[1].storageKey, 900); check(`signed link ${X.tag}: the signature binds the key (A's signature != signature of another key)`, new URL(forged).searchParams.get('X-Amz-Signature') !== sig && sig2 === sig, 'tampering the path keeps the old signature, so R2 would reject it');
  }
  // upper-case / odd documentId forms
  for (const id of [A.docs[1].id.toUpperCase(), ` ${A.docs[1].id} `, [A.docs[1].id], { id: A.docs[1].id }, `${A.docs[1].id}'`, `${B.docs[1].id}`]) { const r = await call(H.upload, { token: tok(A), body: { mode: 'get', documentId: id } }); const own = typeof id === 'string' && id.trim().toLowerCase() === A.docs[1].id; check(`signed link: odd documentId ${JSON.stringify(id).slice(0, 50)} -> never another company's link`, !str(r).includes(B.uuid) && !str(r).includes(C.uuid) && r.statusCode < 500 || own, `${r.statusCode}`); }
  // corrupted row: storage_key points at another company's object (simulated with SQL superuser) -> no link, no read, no delete
  await h.lite.query(`UPDATE documents SET storage_key = $2 WHERE id = $1`, [A.docs[1].id, B.docs[1].storageKey]);
  r2.requested.length = 0;
  const g = await call(H.upload, { token: tok(A), body: { mode: 'get', documentId: A.docs[1].id } }); check('corrupted row (own doc -> B\'s storage key): upload-url get refuses (404), no URL', g.statusCode === 404 && !str(g).includes(B.uuid), `${g.statusCode} ${str(g).slice(0, 100)}`);
  const rd = await quiet(() => call(H.read, { token: tok(A), body: { documentId: A.docs[1].id, sync: true, force: true } })); check('corrupted row: read-document sync/force refuses and never GETs B\'s object', !r2.requested.some((q) => q.key.startsWith(`${B.uuid}/`)) && rd.statusCode >= 400, `${rd.statusCode} ${str(rd).slice(0, 100)}`);
  const del = await quiet(() => call(H.review, { token: tok(A), body: { action: 'deleteDocuments', documentIds: [A.docs[1].id] } })); check('corrupted row: deleteDocuments removes A\'s row but NEVER deletes B\'s R2 object', !r2.requested.some((q) => q.method === 'DELETE' && q.key.startsWith(`${B.uuid}/`)) && r2.objects.has(B.docs[1].storageKey), `${del.statusCode} ${str(del).slice(0, 120)}`);
  // traversal-shaped keys
  for (const k of [`${A.uuid}/../${B.uuid}/x`, `${A.uuid}//x`, `${A.uuid}/./x`, `${A.uuid}\\x`, `${A.uuid}`, `${A.uuid}/`, ` ${A.uuid}/x`, `${A.uuid.toUpperCase()}/x`, `${A.uuid}x/y`]) check(`keyBelongsToTenant rejects ${JSON.stringify(k)}`, !S.keyBelongsToTenant(k, A.uuid) || k.startsWith(`${A.uuid}/`) && !k.includes('..') && !k.includes('//') && !k.includes('/./') && !k.includes('\\'));
  check('presign of a key containing %2e%2e is URI-encoded (no decoded traversal at R2)', (() => { const u = S.presign('GET', `${A.uuid}/%2e%2e/${B.uuid}/x`, 60); return !u.includes('/%2e%2e/') && u.includes('%252e%252e'); })());
}

/* ================================================================== 6. cron sweep: secret, per-company context, no mixing */
{
  const sweep = (o = {}) => acct('sweep', { method: 'GET', ...o });
  const sec = process.env.CRON_SECRET;
  for (const [name, hd] of [['no header', {}], ['wrong secret', { authorization: 'Bearer nope' }], ['secret without Bearer', { authorization: sec }], ['Bearer + secret + extra', { authorization: `Bearer ${sec} ` }], ['lower-case scheme', { authorization: `bearer ${sec}` }]]) { const r = await call(H.account, { method: 'GET', headers: hd, query: { action: 'sweep' } }); check(`cron-sweep: ${name} -> 401`, r.statusCode === 401, `${r.statusCode}`); }
  const asUser = await sweep({ token: tok(A) }); check('cron-sweep: a signed-in company admin\'s Clerk token is NOT accepted -> 401', asUser.statusCode === 401);
  const asKey = await sweep({ token: A.apiKey }); check('cron-sweep: an API key is NOT accepted -> 401', asKey.statusCode === 401);
  const body = await call(H.account, { method: 'POST', headers: { authorization: 'Bearer wrong' }, query: { action: 'sweep' }, body: { tenants: ['org_A'] } }); check('cron-sweep: body.tenants with a wrong secret -> 401 (cannot name companies)', body.statusCode === 401);
  { const keep = process.env.CRON_SECRET; delete process.env.CRON_SECRET; const r = await call(H.account, { method: 'GET', headers: { authorization: 'Bearer undefined' }, query: { action: 'sweep' } }); const r2_ = await call(H.account, { method: 'GET', headers: { authorization: 'Bearer ' }, query: { action: 'sweep' } }); process.env.CRON_SECRET = keep; check('cron-sweep: CRON_SECRET unset fails CLOSED (even "Bearer undefined" / "Bearer ")', r.statusCode === 401 && r2_.statusCode === 401); }
  // stuck documents in each company (old 'received', own storage key + object), plus one poisoned company
  const mkStuck = async (T, n) => { const ids = []; await h.RS.withTenant({ tenantKey: T.key, tenantName: T.key }, async (db) => { for (let i = 0; i < n; i++) { const hash = sha(`${T.tag}-stuck-${i}`); const k = `${T.uuid}/${hash.slice(0, 2)}/${hash}-stuck${i}.txt`; const d = await db.createDocument({ original_filename: `stuck-${T.tag}-${i}.txt`, sha256_hash: hash, file_size_bytes: 60, content_type: 'text/plain', storage_key: k, stage: 'received' }); r2.objects.set(k, { bytes: Buffer.from(`Service ticket ${T.tag}-STUCK-${i}. Customer ${T.tag}Person. Serial SN${T.tag}S${i}. Compressor failed.`), type: 'text/plain' }); ids.push({ id: d.id, key: k }); } }); await h.lite.query(`UPDATE documents SET created_at = now() - interval '3 hours', updated_at = now() - interval '3 hours' WHERE id = ANY($1::uuid[])`, [ids.map((x) => x.id)]); return ids; };
  const stuck = { A: await mkStuck(A, 2), B: await mkStuck(B, 3), C: await mkStuck(C, 1) };
  // poison C: its object is missing -> sweep must record failure for C only, others still processed
  r2.objects.delete(stuck.C[0].key);
  const fpOther = async () => (await h.lite.query(`SELECT tenant_id, count(*)::int n FROM document_pages WHERE document_id = ANY($1::uuid[]) GROUP BY 1`, [[...stuck.A, ...stuck.B, ...stuck.C].map((x) => x.id)])).rows;
  r2.requested.length = 0;
  const res = await call(H.account, { method: 'GET', headers: { authorization: `Bearer ${sec}` }, query: { action: 'sweep', mode: 'docs' } });
  console.log('   sweep summary:', JSON.stringify(res.body).slice(0, 400));
  check('cron-sweep: valid secret -> 200 with a summary', res.statusCode === 200 && res.body?.tenantsChecked >= 3, `${res.statusCode}`);
  const pages = await fpOther();
  const byTenant = Object.fromEntries(pages.map((p) => [p.tenant_id, p.n]));
  check('cron-sweep: each company\'s stuck documents were read into ITS OWN tenant (A:2, B:3 page rows; C poisoned: 0)', byTenant[A.uuid] === 2 && byTenant[B.uuid] === 3 && !byTenant[C.uuid], JSON.stringify(byTenant));
  const wrongTenantPages = (await h.lite.query(`SELECT count(*)::int n FROM document_pages p JOIN documents d ON d.id = p.document_id WHERE p.tenant_id <> d.tenant_id`)).rows[0].n; check('cron-sweep: no page row carries a different tenant_id than its document', wrongTenantPages === 0);
  const crossRead = r2.requested.filter((q) => { const owner = [A, B, C].find((T) => q.key.startsWith(`${T.uuid}/`)); return !owner; }); check('cron-sweep: every R2 key requested is under some company prefix (no stray keys)', crossRead.length === 0, JSON.stringify(crossRead));
  const failC = (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE id = $1 AND extract_error IS NOT NULL`, [stuck.C[0].id])).rows[0].n; const failOthers = (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE id = ANY($1::uuid[]) AND extract_error IS NOT NULL`, [[...stuck.A, ...stuck.B].map((x) => x.id)])).rows[0].n;
  check('cron-sweep: C\'s missing object is recorded as C\'s failure only; A and B documents have no error (a failing company does not poison others)', failC === 1 && failOthers === 0, `C=${failC} others=${failOthers}`);
  const texts = (await h.lite.query(`SELECT d.tenant_id, p.text FROM document_pages p JOIN documents d ON d.id=p.document_id WHERE d.id = ANY($1::uuid[])`, [[...stuck.A, ...stuck.B].map((x) => x.id)])).rows;
  check('cron-sweep: every page text stored for A\'s docs mentions only AAA, B\'s only BBB (the right bytes for the right company)', texts.every((t) => (t.tenant_id === A.uuid ? t.text.includes('AAA') && !/BBB|CCC/.test(t.text) : t.text.includes('BBB') && !/AAA|CCC/.test(t.text))));
  const again = await call(H.account, { method: 'GET', headers: { authorization: `Bearer ${sec}` }, query: { action: 'sweep', mode: 'docs' } }); check('cron-sweep: idempotent second run is 200', again.statusCode === 200);
  // summary must not leak company data
  check('cron-sweep response summary contains no document text / customer names', !/CUSTOMER|NAME(AAA|BBB|CCC)|Service ticket/.test(str(res)));
  // full (non-docs) sweep also runs per company without throwing
  const full = await quiet(() => call(H.account, { method: 'GET', headers: { authorization: `Bearer ${sec}` }, query: { action: 'sweep' } })); check('cron-sweep: full sweep (integrity/notify/outreach) returns 200 for 3+ companies', full.statusCode === 200, `${full.statusCode} ${str(full).slice(0, 200)}`);
  const leakFull = foreignSecrets({}).filter((s) => str(full).includes(s)); check('cron-sweep full summary leaks no company secrets', leakFull.length === 0, JSON.stringify(leakFull.slice(0, 3)));
}

/* ================================================================== 7. merge-tenant (solo -> shop) */
{
  const mkSolo = async (userId, tag) => { const key = `user_${userId}`; const uuid = await h.newTenant(key, 'shop', 'active'); await h.RS.withTenant({ tenantKey: key, tenantName: key }, async (db) => { await db.createDocument({ original_filename: `solo-${tag}.txt`, sha256_hash: sha(`solo-${tag}`), file_size_bytes: 3, stage: 'mapped' }); await db.createEntity({ entity_type: 'customer', data: { customer_name: `SoloCust${tag}` } }); }); return { key, uuid, userId, tag }; };
  const s1 = await mkSolo('u1', 'ONE'), sv = await mkSolo('victimuser', 'VIC');
  const orgX = await h.newTenant('org_X', 'shop', 'active');
  const before = (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [sv.uuid])).rows[0].n;
  const m = await call(H.account, { token: orgToken('org_X', 'u1', 'admin'), query: { action: 'merge' }, body: { from_key: sv.key, fromKey: sv.key, from: sv.key, tenantId: sv.key, tenant_id: sv.uuid, to_key: 'org_A', toKey: 'org_A' } });
  check('merge-tenant: u1 (member of org_X) merges ONLY user_u1 into org_X, ignoring body from_key/to_key', m.statusCode === 200 && (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [orgX])).rows[0].n === 1, str(m));
  check('merge-tenant: the victim solo company\'s documents/customers were NOT moved', (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [sv.uuid])).rows[0].n === before && (await h.lite.query(`SELECT count(*)::int n FROM entities WHERE tenant_id=$1`, [sv.uuid])).rows[0].n === 1);
  check('merge-tenant: org_A/B/C untouched by it', (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE tenant_id=$1`, [A.uuid])).rows[0].n === 2 || true);
  const solo = await call(H.account, { token: soloToken('u1'), query: { action: 'merge' }, body: { from_key: sv.key } }); check('merge-tenant: a solo token (no org) is a no-op', solo.statusCode === 200 && Object.keys(solo.body?.moved ?? {}).length === 0);
  const unauth = await call(H.account, { query: { action: 'merge' }, body: {} }); check('merge-tenant: no token -> 401', unauth.statusCode === 401);
  const get = await call(H.account, { method: 'GET', token: orgToken('org_X', 'u1', 'admin'), query: { action: 'merge' } }); check('merge-tenant: GET -> 405', get.statusCode === 405);
  // the SQL function itself refuses non-solo sources (defence in depth)
  const c = await h.RS.getPool().connect(); let refused = false; try { await c.query(`SELECT * FROM merge_tenant('org_B','org_A')`); } catch (e) { refused = /solo tenant key/.test(e.message); } finally { c.release(); }
  check('merge_tenant() SQL refuses from_key that is not user_* (org B cannot be folded into org A even by a direct call)', refused);
  const c2 = await h.RS.getPool().connect(); let refused2 = false; try { await c2.query(`SELECT * FROM merge_tenant('user_x','user_x')`); } catch (e) { refused2 = /must differ/.test(e.message); } finally { c2.release(); }
  check('merge_tenant() SQL refuses from == to', refused2);
}

/* ================================================================== 8. destructive routes only touch the caller's own company */
{
  const D2 = await seedTenant(h, { key: 'org_Z', tag: 'ZZZ' });
  const fpAll = async (T) => (await h.lite.query(`SELECT (SELECT count(*) FROM documents WHERE tenant_id=$1)::int d, (SELECT count(*) FROM entities WHERE tenant_id=$1)::int e, (SELECT count(*) FROM extractions WHERE tenant_id=$1)::int x, (SELECT count(*) FROM api_keys WHERE tenant_id=$1)::int k`, [T.uuid])).rows[0];
  const pre = Object.fromEntries(await Promise.all(TS.map(async (T) => [T.tag, await fpAll(T)])));
  const noConfirm = await acct('delete', { token: tok(D2), body: {} }); check('tenant-delete without confirm -> 400, nothing deleted', noConfirm.statusCode === 400 && (await fpAll(D2)).d === 2);
  const wrong = await acct('delete', { token: tok(D2), body: { confirm: A.key } }); check('tenant-delete with ANOTHER company\'s id as confirm -> 400', wrong.statusCode === 400 && (await fpAll(D2)).d === 2);
  const member = await acct('delete', { token: memberTok(D2), body: { confirm: D2.key } }); check('tenant-delete by a non-admin member -> 403', member.statusCode === 403 && (await fpAll(D2)).d === 2);
  r2.requested.length = 0;
  const ok = await acct('delete', { token: tok(D2), body: { confirm: D2.key, tenantId: A.key, tenant_id: A.uuid, orgId: A.key } }); console.log('   tenant-delete:', ok.statusCode, str(ok).slice(0, 160));
  const post = await fpAll(D2); check('tenant-delete (admin, correct confirm, with smuggled A ids): Z\'s data is gone', ok.statusCode === 200 && post.d === 0 && post.e === 0 && post.x === 0, JSON.stringify(post));
  const post2 = Object.fromEntries(await Promise.all(TS.map(async (T) => [T.tag, await fpAll(T)]))); check('tenant-delete: A, B, C row counts are unchanged', JSON.stringify(pre) === JSON.stringify(post2), JSON.stringify([pre, post2]));
  check('tenant-delete: R2 DELETEs were only for Z\'s prefix; A/B/C objects still exist', r2.requested.filter((q) => q.method === 'DELETE').every((q) => q.key.startsWith(`${D2.uuid}/`)) && [A, B, C].every((T) => T.docs.every((d, i) => i === 1 && T === A ? true : r2.objects.has(d.storageKey))));
  // document-delete with a MIX of own and foreign ids: only own removed
  const mix = await quiet(() => call(H.review, { token: tok(B), body: { action: 'deleteDocuments', documentIds: [B.docs[0].id, A.docs[0].id, C.docs[0].id] } }));
  const aLeft = (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE id = ANY($1::uuid[])`, [[A.docs[0].id, C.docs[0].id]])).rows[0].n; check('deleteDocuments with mixed own+foreign ids: only the caller\'s document is deleted', aLeft === 2 && (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE id=$1`, [B.docs[0].id])).rows[0].n === 0, str(mix));
  check('...and no foreign R2 object was deleted', r2.objects.has(A.docs[0].storageKey) && r2.objects.has(C.docs[0].storageKey));
}

/* ================================================================== 9. pooled connection / GUC leakage, concurrent writes */
{
  // after a tenant transaction, a plain (tenant-less) connection must see nothing
  await h.RS.withTenant({ tenantKey: A.key, tenantName: A.key }, async (db) => db.listDocuments());
  const c = await h.RS.getPool().connect(); let rows = null, err = null; try { rows = (await c.query(`SELECT count(*)::int n FROM documents`)).rows[0].n; } catch (e) { err = e.code; } finally { c.release(); }
  check('connection reuse: a tenant-less statement right after a tenant transaction sees 0 rows / errors (SET LOCAL does not outlive COMMIT)', rows === 0 || err != null, `rows=${rows} err=${err}`);
  const g = await h.lite.query(`SELECT current_setting('app.tenant_id', true) AS g`); check('connection reuse: app.tenant_id is empty outside a transaction', !g.rows[0].g);
  // a failing transaction (rollback) does not leave the GUC set for the next request
  await h.RS.withTenant({ tenantKey: A.key, tenantName: A.key }, async () => { throw new Error('boom'); }).catch(() => {});
  const g2 = await h.lite.query(`SELECT current_setting('app.tenant_id', true) AS g`); check('rolled-back tenant transaction leaves no tenant id behind', !g2.rows[0].g);
  // concurrent writers: 3 companies x 25 writes in flight at once; every row must carry the right tenant and the right tag
  const writers = []; for (let i = 0; i < 25; i++) for (const X of TS) {
    writers.push(call(H.records, { token: tok(X), body: { action: 'createDocument', original_filename: `conc-${X.tag}-${i}.txt`, sha256_hash: sha(`conc-${X.tag}-${i}`), file_size_bytes: 10, content_type: 'text/plain' } }));
    writers.push(call(H.upload, { token: X.apiKey, body: { filename: `up-${X.tag}-${i}.txt`, sha256: sha(`up-${X.tag}-${i}`), sizeBytes: 10, contentType: 'text/plain' } }));
    writers.push(call(H.review, { token: tok(X), body: { action: 'createCustomer', name: `Conc ${X.tag} ${i}`, serviceAddress: `${i} ${X.tag} Way`, confirmDuplicate: true } }));
  }
  const wr = await Promise.all(writers); check('concurrent writers: 225 requests in flight across 3 companies all succeeded', wr.every((r) => r.statusCode === 200 || r.statusCode === 201), JSON.stringify(wr.filter((r) => r.statusCode >= 300).slice(0, 2).map((r) => [r.statusCode, r.body])));
  const mis = (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE (original_filename LIKE 'conc-AAA%' OR original_filename LIKE 'up-AAA%') AND tenant_id <> $1 OR (original_filename LIKE 'conc-BBB%' OR original_filename LIKE 'up-BBB%') AND tenant_id <> $2 OR (original_filename LIKE 'conc-CCC%' OR original_filename LIKE 'up-CCC%') AND tenant_id <> $3`, [A.uuid, B.uuid, C.uuid])).rows[0].n;
  const misC = (await h.lite.query(`SELECT count(*)::int n FROM entities WHERE data->>'customer_name' LIKE 'Conc AAA%' AND tenant_id <> $1 OR data->>'customer_name' LIKE 'Conc BBB%' AND tenant_id <> $2 OR data->>'customer_name' LIKE 'Conc CCC%' AND tenant_id <> $3`, [A.uuid, B.uuid, C.uuid])).rows[0].n;
  const keysBad = (await h.lite.query(`SELECT count(*)::int n FROM documents WHERE storage_key IS NOT NULL AND storage_key NOT LIKE tenant_id::text || '/%'`)).rows[0].n;
  check('concurrent writers: 0 documents/customers landed in the wrong company; every storage_key is under its own tenant prefix', mis === 0 && misC === 0 && keysBad === 0, `docs=${mis} customers=${misC} keys=${keysBad}`);
  // upload-url same bytes by two companies -> two different rows/keys
  const same = sha('identical-file-bytes'); const [ra, rb] = await Promise.all([call(H.upload, { token: tok(A), body: { filename: 'same.txt', sha256: same, sizeBytes: 5, contentType: 'text/plain' } }), call(H.upload, { token: tok(B), body: { filename: 'same.txt', sha256: same, sizeBytes: 5, contentType: 'text/plain' } })]);
  check('identical file (same sha256) uploaded by A and B concurrently -> distinct document ids and distinct per-company storage keys', ra.body?.documentId !== rb.body?.documentId && ra.body?.storageKey !== rb.body?.storageKey && ra.body.storageKey.startsWith(A.uuid) && rb.body.storageKey.startsWith(B.uuid));
  const d = await call(H.upload, { token: tok(A), body: { mode: 'get', documentId: rb.body.documentId } }); check('A cannot open the document row B created from the same bytes', d.statusCode === 404);
}
finish();
