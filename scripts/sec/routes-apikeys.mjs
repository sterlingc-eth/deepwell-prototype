// Area routes (d): API keys. A's key against B's data, revoked keys, malformed keys and wrong headers, scope enforcement on every key-capable route,
// plan lapse, and key creation limits.   Run: npx tsx scripts/sec/routes-apikeys.mjs
import { setup } from './routes-common.mjs';
const S = await setup('routes-apikeys');
const { H, R, q, A, B, leaks, fingerprint, diffFp, api } = S;
const ask = await api('ask', 'api/ask.js'), account = await api('account', 'api/account.js'), v1 = await api('v1', 'api/v1.js'), upload = await api('upload', 'api/upload-url.js'), readDoc = await api('read', 'api/read-document.js');
const extract = await api('extract', 'api/extract.js'), warr = await api('warr', 'api/warranty-attention.js');
const bDoc = B.docIds[0], bCust = B.customers[0].id, aDoc = A.docs[0].id, aCust = A.customers[0].id, bSerial = B.equipment[0].data.serial_number;
const sha = (c) => c.repeat(64);
// one request per key-capable route and the scope it needs. `get` upload = read, every other upload = ingest.
const ROUTES = [
  ['v1.equipment', v1, 'read', { method: 'GET', query: { resource: 'equipment', serial: bSerial } }], ['v1.warranty', v1, 'read', { method: 'GET', query: { resource: 'warranty' } }], ['v1.customers', v1, 'read', { method: 'GET', query: { resource: 'customers' } }],
  ['v1.customer', v1, 'read', { method: 'GET', query: { resource: 'customer', id: aCust } }], ['v1.customer-equipment', v1, 'read', { method: 'POST', query: { resource: 'customer-equipment' }, body: { customerId: aCust } }],
  ['v1.graph', v1, 'read', { method: 'GET', query: { resource: 'graph', q: 'a' } }], ['v1.intake-status', v1, 'read', { method: 'GET', query: { resource: 'intake-status' } }], ['v1.export', v1, 'read', { method: 'GET', query: { resource: 'export', kind: 'customers' } }],
  ['v1.ingest', v1, 'ingest', { method: 'POST', query: { resource: 'ingest' }, body: { original_filename: 'k.pdf', sha256_hash: sha('d'), file_size_bytes: 10, content_type: 'application/pdf' } }],
  ['read-document', readDoc, 'ingest', { method: 'POST', body: { documentId: aDoc, sync: true } }], ['extract', extract, 'ingest', { method: 'POST', body: { documentId: aDoc } }],
  ['upload-url.single', upload, 'ingest', { method: 'POST', body: { original_filename: 'k2.pdf', sha256_hash: sha('e'), file_size_bytes: 10, content_type: 'application/pdf' } }],
  ['upload-url.batch', upload, 'ingest', { method: 'POST', body: { files: [{ original_filename: 'k3.pdf', sha256_hash: sha('f'), file_size_bytes: 10, content_type: 'application/pdf' }] } }],
  ['upload-url.get', upload, 'read', { method: 'POST', body: { mode: 'get', documentId: aDoc } }], ['warranty-attention', warr, 'read', { method: 'POST', body: {} }], ['ask', ask, 'ask', { method: 'POST', body: { question: 'how many customers do we have?' } }],
];
const scopeSets = [['read'], ['ingest'], ['ask'], ['read', 'ingest'], ['read', 'ask'], ['ingest', 'ask'], ['read', 'ingest', 'ask'], [], ['READ'], ['read '], ['*'], ['admin'], ['all'], ['read,ingest'], ['Read', 'Ingest', 'Ask']];
const bad = []; let n = 0;
const keyFor = new Map();
for (const sc of scopeSets) keyFor.set(JSON.stringify(sc), await H.mintKey('A', sc));
for (const sc of scopeSets) {
  const key = keyFor.get(JSON.stringify(sc));
  for (const [name, h, need, req] of ROUTES) {
    const r = await H.call(h, { token: key, method: req.method, query: req.query ?? {}, body: req.body ?? {} }); n++;
    const has = sc.includes(need);
    const refused = r.status === 403 && /scope/.test(r.text);
    if (has && refused) bad.push(`${JSON.stringify(sc)} ${name}: scope present but refused ${r.status}`);
    if (!has && !refused) bad.push(`${JSON.stringify(sc)} ${name} needs "${need}": got ${r.status} ${r.text.slice(0, 50)}`);
    if (!has && r.status === 200) bad.push(`LEAK ${JSON.stringify(sc)} ${name}: 200 without scope`);
  }
}
R.check('scope:every-route-enforces-its-scope', `${n} calls: each of ${ROUTES.length} key-capable routes refuses (403 naming the scope) any key lacking its scope (incl. empty, upper-case, padded, "*", "admin", comma-joined) and accepts one that has it`, bad.length === 0, { severity: 'High', route: 'v1/*, ask, upload-url, read-document, extract, warranty-attention', detail: bad.slice(0, 6).join(' | ') });

// key created through the API: scopes must be drawn from the allow-list; names bounded
{
  const tk = H.tok.adminA; const out = [];
  for (const sc of [['*'], ['admin'], ['READ'], [], 'read', null, [['read']], [{ a: 1 }], ['read', 'bogus']]) { const r = await H.call(account, { token: tk, query: { action: 'keys' }, body: { action: 'create', name: 'x', scopes: sc } }); if (r.status !== 400) out.push(`${JSON.stringify(sc)}=${r.status}`); }
  for (const nm of ['', '  ', 'x'.repeat(101), null, 5, { a: 1 }, ['x']]) { const r = await H.call(account, { token: tk, query: { action: 'keys' }, body: { action: 'create', name: nm, scopes: ['read'] } }); if (r.status !== 400) out.push(`name ${JSON.stringify(nm)?.slice(0, 20)}=${r.status}`); }
  R.check('keys:create-validates-scopes-and-name', 'key creation refuses scopes outside read/ingest/ask and names outside 1-100 chars', out.length === 0, { severity: 'Medium', route: 'account?action=keys', detail: out.join(' ') });
  const c = await H.call(account, { token: tk, query: { action: 'keys' }, body: { action: 'create', name: '<img src=x onerror=1>', scopes: ['read', 'read'] } });
  const l = await H.call(account, { token: tk, query: { action: 'keys' }, body: { action: 'list' } });
  R.check('keys:list-never-returns-secret', 'the key list shows prefix/scopes only (no hash, no full key, no other company keys); the full key is returned once on create', !/key_hash|"key":"dw_live_|rawKey/.test(l.text) && !leaks(l).length && c.status === 201 && /^dw_live_[0-9a-f]{64}$/.test(c.body?.key ?? ''), { severity: 'High', route: 'account?action=keys', detail: l.text.slice(0, 160) });
}

// revoked key, revoke through the API (takes effect on the very next call), keys of the other company
{
  const rk = await H.mintKey('A', ['read', 'ingest', 'ask'], { revoked: true });
  const fails = [];
  for (const [name, h, , req] of ROUTES) { const r = await H.call(h, { token: rk, method: req.method, query: req.query ?? {}, body: req.body ?? {} }); if (r.status !== 401) fails.push(`${name}=${r.status}`); }
  R.check('revoked:key-refused-everywhere', 'a revoked key is refused (401) on every key-capable route', fails.length === 0, { severity: 'Critical', route: 'all key routes', detail: fails.join(' ') });
  const c = await H.call(account, { token: H.tok.adminA, query: { action: 'keys' }, body: { action: 'create', name: 'temp', scopes: ['read'] } });
  const before = await H.call(v1, { token: c.body.key, method: 'GET', query: { resource: 'customers', limit: 1 } });
  const rv = await H.call(account, { token: H.tok.adminA, query: { action: 'keys' }, body: { action: 'revoke', id: c.body.id } });
  const after = await H.call(v1, { token: c.body.key, method: 'GET', query: { resource: 'customers', limit: 1 } });
  const again = await H.call(account, { token: H.tok.adminA, query: { action: 'keys' }, body: { action: 'revoke', id: c.body.id } });
  R.check('revoked:takes-effect-immediately', 'a key works, is revoked through the API, and the very next call is refused (no cache window)', before.status === 200 && rv.status === 200 && after.status === 401 && again.status === 404, { severity: 'High', route: 'account?action=keys', detail: `${before.status} ${rv.status} ${after.status} ${again.status}` });
  const aKeyId = (await q('select id::text id from api_keys where tenant_id=$1 and revoked_at is null limit 1', [A.tenant]))[0].id;
  const xr = await H.call(account, { token: H.tok.adminB, query: { action: 'keys' }, body: { action: 'revoke', id: aKeyId } });
  const stillLive = (await q('select revoked_at from api_keys where id=$1', [aKeyId]))[0].revoked_at == null;
  const xl = await H.call(account, { token: H.tok.adminB, query: { action: 'keys' }, body: { action: 'list' } });
  R.check('keys:other-company-cannot-revoke-or-list', "B's admin cannot revoke A's key (404, key stays live) and B's key list shows none of A's", xr.status === 404 && stillLive && !xl.text.includes(aKeyId), { severity: 'Critical', route: 'account?action=keys', detail: `${xr.status} live=${stillLive}` });
  const r2 = await H.call(v1, { headers: { authorization: `Bearer  ${rk} ` }, method: 'GET', query: { resource: 'customers' } });
  R.check('revoked:padded-bearer-still-refused', 'padding the revoked key with spaces does not bring it back', r2.status === 401, { severity: 'High', route: 'api/v1', detail: String(r2.status) });
}

// A's key against B's data: every key route, B ids in every position, and each key sees its own company's rows only
{
  const kA = await H.mintKey('A', ['read', 'ingest', 'ask']), kB = await H.mintKey('B', ['read', 'ingest', 'ask']);
  const fa = await fingerprint(B.tenant); const fails = [];
  const cases = [
    ['customer id', { method: 'GET', query: { resource: 'customer', id: bCust } }], ['customer number', { method: 'GET', query: { resource: 'customer', number: B.customers[0].customer_number } }], ['equipment serial', { method: 'GET', query: { resource: 'equipment', serial: bSerial } }],
    ['equipment cust', { method: 'GET', query: { resource: 'equipment', customerId: bCust } }], ['customer-equipment', { method: 'POST', query: { resource: 'customer-equipment' }, body: { customerId: bCust } }], ['graph node', { method: 'GET', query: { resource: 'graph', node: `customer:${bCust}`, depth: 3 } }],
    ['graph q', { method: 'GET', query: { resource: 'graph', q: 'Zed' } }], ['customers q', { method: 'GET', query: { resource: 'customers', q: 'Zed Zimmer', limit: 100 } }], ['intake docs', { method: 'GET', query: { resource: 'intake-status', documentIds: B.docIds.slice(0, 20).join(',') } }],
    ['warranty-attention', { method: 'POST', body: { today: '2026-09-25', registerWithinDays: 3650, expiringWithinDays: 3650 }, h: warr }], ['read-document B', { method: 'POST', body: { documentId: bDoc, sync: true, force: true }, h: readDoc }], ['extract B', { method: 'POST', body: { documentId: bDoc }, h: extract }],
    ['upload get B', { method: 'POST', body: { mode: 'get', documentId: bDoc }, h: upload }], ['upload same hash', { method: 'POST', body: { original_filename: 'x.pdf', sha256_hash: B.docs[3].sha256_hash, file_size_bytes: 10, content_type: 'application/pdf' }, h: upload }],
    ['ask B names', { method: 'POST', body: { question: 'show invoices for Zed Zimmer at Beta Cooling BINV-' }, h: ask }],
  ];
  for (const [nm, c] of cases) {
    const r = await H.call(c.h ?? v1, { token: kA, method: c.method, query: c.query ?? {}, body: c.body ?? {} });
    const sup = [bCust, bDoc, bSerial, B.customers[0].customer_number, B.docs[3].sha256_hash].filter((x) => JSON.stringify(c).includes(x));
    const f = leaks(r, [...sup, 'Zed Zimmer', 'Beta Cooling', 'BINV-']);
    if (f.length) fails.push(`${nm}: ${f[0]}`);
  }
  R.check('crosskey:A-key-sees-nothing-of-B', "A's key, naming B's customer/document/serial/hash/name on every key route, gets nothing of B", fails.length === 0, { severity: 'Critical', route: 'v1/*, ask, upload-url, read-document, extract', detail: fails.join(' | ') });
  R.check('crosskey:B-unchanged', 'those calls changed nothing of B', diffFp(fa, await fingerprint(B.tenant)).length === 0, { severity: 'Critical', route: 'ingest paths', detail: diffFp(fa, await fingerprint(B.tenant)).join(',') });
  const la = await H.call(v1, { token: kA, method: 'GET', query: { resource: 'customers', limit: 200 } }); const lb = await H.call(v1, { token: kB, method: 'GET', query: { resource: 'customers', limit: 200 } });
  const ca = new Set(la.body.customers.map((c) => c.id)), cb = new Set(lb.body.customers.map((c) => c.id));
  const aSet = new Set((await q("select id::text id from entities where tenant_id=$1 and entity_type='customer'", [A.tenant])).map((r) => r.id)), bSet = new Set((await q("select id::text id from entities where tenant_id=$1 and entity_type='customer'", [B.tenant])).map((r) => r.id));
  R.check('crosskey:keys-are-bound-to-their-company', "each key's customer list contains only its own company's rows (and is not empty)", ca.size > 0 && cb.size > 0 && [...ca].every((x) => aSet.has(x)) && [...cb].every((x) => bSet.has(x)), { severity: 'Critical', route: 'api/v1 customers', detail: `A:${ca.size} B:${cb.size}` });
  const sm = await H.call(v1, { token: kA, method: 'GET', query: { resource: 'customers', tenantId: B.tenant, orgId: B.org, tenant_id: B.tenant, limit: 200 }, headers: { 'x-tenant-id': B.tenant, 'x-org-id': B.org, 'x-clerk-org-id': B.org, 'x-dw-tenant': B.org, 'x-dw-expected-tenant': B.org }, body: { tenantId: B.tenant, orgId: B.org } });
  R.check('crosskey:smuggled-tenant-ignored', "putting B's tenant/org id in query, headers or body of a key call does not rebind the key", sm.status === 200 && leaks(sm).length === 0 && sm.body.customers.every((c) => aSet.has(c.id)), { severity: 'Critical', route: 'api/v1', detail: `${sm.status}` });
  const adm = [];
  for (const [nm, h, req] of [['keys', account, { query: { action: 'keys' }, body: { action: 'list' } }], ['export', account, { query: { action: 'export' } }], ['delete', account, { query: { action: 'delete' }, body: { confirm: A.org } }], ['merge', account, { query: { action: 'merge' } }], ['naming', account, { query: { action: 'naming' }, body: { op: 'backfill' } }], ['graph', account, { query: { action: 'graph' }, body: { op: 'refresh' } }], ['entity-merge', account, { query: { action: 'entity-merge' }, body: { op: 'list' } }]]) { const r = await H.call(h, { token: kA, method: 'POST', query: req.query, body: req.body ?? {} }); if (r.status !== 401) adm.push(`${nm}=${r.status}`); }
  R.check('crosskey:key-cannot-reach-admin-routes', 'a key with every scope is refused (401) on keys, export, delete, merge, naming, graph and entity-merge (hasShop() is false for a key, so these gates would not hold if a key ever got through)', adm.length === 0, { severity: 'Critical', route: 'account.js', detail: adm.join(' ') });
  const ex = await H.call(v1, { token: kA, method: 'GET', query: { resource: 'export', kind: 'documents' } });
  R.check('crosskey:export-own-company-only', "the CSV export through A's read key holds only A's rows", ex.status === 200 && leaks(ex).length === 0, { severity: 'Critical', route: 'api/v1 export', detail: `${ex.status} ${leaks(ex)[0] ?? ''}` });
}

// plan lapse: Fleet-only. A company that left Fleet is refused (403) and the key works again when restored. A CANCELLED Fleet company: reads stay open
// (the data is the owner's) but everything that spends money or adds documents must be refused.
{
  const kA = await H.mintKey('A', ['read', 'ingest', 'ask']);
  const one = async () => (await H.call(v1, { token: kA, method: 'GET', query: { resource: 'customers', limit: 1 } })).status;
  const s0 = await one();
  await H.setTenant('A', "plan='solo'"); const s1 = await one();
  const sIngest1 = (await H.call(v1, { token: kA, method: 'POST', query: { resource: 'ingest' }, body: { original_filename: 'p.pdf', sha256_hash: sha('9'), file_size_bytes: 10, content_type: 'application/pdf' } })).status;
  await H.setTenant('A', "plan='fleet', billing_status='canceled'");
  const s2 = await one(); const paid = [];
  for (const [name, h, , req] of ROUTES.filter((r) => ['v1.ingest', 'read-document', 'extract', 'upload-url.single', 'upload-url.batch', 'ask'].includes(r[0]))) { const r = await H.call(h, { token: kA, method: req.method, query: req.query ?? {}, body: req.body ?? {} }); if (r.status === 200 || r.status === 202) paid.push(`${name}=${r.status}`); }
  await H.setTenant('A', "plan='fleet', billing_status='active'"); const s3 = await one();
  R.check('plan:non-fleet-key-refused', 'a key on a company that left Fleet is refused (403) on reads and ingest; restored Fleet works again', s0 === 200 && s1 === 403 && sIngest1 === 403 && s3 === 200, { severity: 'High', route: 'api/_lib/apiKeyAuth.js', detail: `fleet=${s0} solo=${s1} soloIngest=${sIngest1} restored=${s3}` });
  R.check('plan:canceled-fleet-key-cannot-spend', `a key on a CANCELLED Fleet company is refused on ingest / read-document / extract / upload-url / ask (reads stay open: customers=${s2})`, paid.length === 0, { severity: 'High', route: 'api/_lib/apiKeyAuth.js + plan.js', detail: paid.join(' ') });
}

// malformed keys / wrong headers
{
  const k = await H.mintKey('A', ['read', 'ingest', 'ask']); const hex = k.slice(8);
  const variants = { 'x-api-key': { 'x-api-key': k }, 'api-key hdr': { 'api-key': k, apikey: k }, 'basic': { authorization: `Basic ${Buffer.from(`${k}:`).toString('base64')}` }, 'token scheme': { authorization: `Token ${k}` }, 'ApiKey scheme': { authorization: `ApiKey ${k}` }, 'lowercase bearer': { authorization: `bearer ${k}` }, 'no scheme': { authorization: k },
    'wrong prefix dw_test_': { authorization: `Bearer dw_test_${hex}` }, 'sk_ prefix': { authorization: `Bearer sk_live_${hex}` }, 'upper prefix': { authorization: `Bearer DW_LIVE_${hex}` }, 'upper hex': { authorization: `Bearer dw_live_${hex.toUpperCase()}` }, 'short': { authorization: `Bearer dw_live_${hex.slice(0, 63)}` }, 'long': { authorization: `Bearer ${k}0` }, 'empty hex': { authorization: 'Bearer dw_live_' },
    'zeros (nonexistent)': { authorization: `Bearer dw_live_${'0'.repeat(64)}` }, 'sql meta': { authorization: "Bearer dw_live_' OR '1'='1" }, 'sql in hex slot': { authorization: `Bearer dw_live_${hex.slice(0, 40)}' OR 1=1 --${hex.slice(0, 5)}` }, 'trailing junk': { authorization: `Bearer ${k} junk` }, 'two keys': { authorization: `Bearer ${k}, Bearer ${k}` }, 'nul byte': { authorization: `Bearer ${k}\u0000` },
    'huge header': { authorization: `Bearer dw_live_${'a'.repeat(100000)}` } };
  const bad2 = [];
  for (const [nm, headers] of Object.entries(variants)) { for (const [rn, h, , req] of ROUTES.filter((_, i) => i % 3 === 0)) { const r = await H.call(h, { method: req.method, query: req.query ?? {}, body: req.body ?? {}, headers }); if (r.status !== 401) bad2.push(`${nm} on ${rn}=${r.status}`); } }
  R.check('format:malformed-keys-and-wrong-headers-refused', `${Object.keys(variants).length} malformed / mis-placed key forms (header names, schemes, case, length, SQL, NUL, 100 KB) are refused with 401`, bad2.length === 0, { severity: 'High', route: 'api/_lib/apiKeyAuth.js', detail: bad2.slice(0, 5).join(' | ') });
  const qk = await H.call(v1, { method: 'GET', query: { resource: 'customers', api_key: k, key: k, apikey: k, token: k, access_token: k } });
  R.check('format:key-in-url-not-accepted', 'a key placed in the query string is not accepted', qk.status === 401, { severity: 'Medium', route: 'api/v1', detail: String(qk.status) });
  const rk = await H.mintKey('A', ['read'], { revoked: true });
  const e1 = await H.call(v1, { token: rk, method: 'GET', query: { resource: 'customers' } }), e2 = await H.call(v1, { token: `dw_live_${'1'.repeat(64)}`, method: 'GET', query: { resource: 'customers' } });
  R.check('format:revoked-and-unknown-look-alike', 'a revoked key and a never-issued key get the same status and message', e1.status === e2.status && e1.text === e2.text, { severity: 'Low', route: 'api/_lib/apiKeyAuth.js', detail: `${e1.text.slice(0, 60)} | ${e2.text.slice(0, 60)}` });
}
R.finish();
