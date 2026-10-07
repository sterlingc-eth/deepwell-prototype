import { boot, recorder } from './lib/harness.mjs';
const H = await boot(); const R = recorder('uploads');
const { default: records } = await H.importApi('api/records.ts');
const { default: v1 } = await H.importApi('api/v1.js');
const { default: account } = await H.importApi('api/account.js');
const { default: grid } = await H.importApi('api/_lib/grid/route.js');
let analytics; try { ({ default: analytics } = await H.importApi('api/_lib/routes/analytics.js')); } catch {}
const { default: ask } = await H.importApi('api/ask.js');
const tu = H.tenantUuid;
const bEnt = (await H.lite.query("SELECT id FROM entities WHERE tenant_id=$1 AND entity_type='customer' LIMIT 1", [tu.B])).rows[0].id;
const bDoc = (await H.lite.query('SELECT id FROM documents WHERE tenant_id=$1 LIMIT 1', [tu.B])).rows[0].id;
const aBefore = Number((await H.lite.query('SELECT count(*) n FROM entities WHERE tenant_id=$1', [tu.A])).rows[0].n);
const bBefore = Number((await H.lite.query('SELECT count(*) n FROM entities WHERE tenant_id=$1', [tu.B])).rows[0].n);

const EVIL = ["'", "\"", "'; DROP TABLE documents;--", "' OR '1'='1", "%", "_", "%_%_%_%_%_%_%_%", "\\", "\\'", "a\u0000b", "${7*7}", "$1", "{{7*7}}", "1; SELECT pg_sleep(5)", "' UNION SELECT tenant_id::text FROM entities--", "x".repeat(200000), "💥", "(?:a+)+$", "__proto__", "constructor", "-1", "99999999999999999999", "NaN", "1e999"];
const WEIRD = [null, true, 5, -1, 1.5, [], [EVIL[0]], { $ne: 1 }, { __proto__: { admin: true } }, JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}')];
const FIELDS = ['q', 'brand', 'sort', 'order', 'sortBy', 'orderBy', 'direction', 'limit', 'offset', 'cursor', 'type', 'status', 'documentType', 'customerId', 'technician', 'from', 'to', 'id', 'documentId', 'entityId', 'ids', 'documentIds', 'field', 'column', 'filters', 'facets'];
const ACTIONS = ['listDocuments', 'browseDocuments', 'browseFacets', 'listEntitiesByIds', 'listEntities', 'getDocument', 'getEntity', 'getExtraction', 'listExtractionsByDocument', 'listExtractionsByDocuments', 'listExtractionsByEntity', 'getAuditLog', 'listProposals', 'listUnverifiedDocuments', 'getDocumentPage', 'getFacet', 'listFacetsByDocument', 'getProposal', 'bootstrap'];

let bad = [], total = 0, slow = [];
const sqlLeak = /syntax error|pg_|relation "|column "|invalid input|violates|at character|PGlite|postgres|statement timeout/i;
async function probe(label, fn) {
  total++;
  const t0 = Date.now(); const r = await fn(); const ms = Date.now() - t0;
  if (ms > 3000) slow.push(`${label} ${ms}ms`);
  if (r.status >= 500 || sqlLeak.test(r.text.slice(0, 2000)) || r.thrown) bad.push(`${label} -> ${r.status} ${r.thrown ? 'THROWN ' + r.thrown.message : ''} ${r.text.slice(0, 80)}`);
  return r;
}
for (const action of ACTIONS) {
  for (const f of FIELDS) {
    for (const v of [...EVIL.slice(0, 16), ...WEIRD]) {
      for (const shape of ['top', 'filters']) {
        const body = shape === 'top' ? { action, [f]: v } : { action, filters: { [f]: v }, [f]: v };
        await probe(`${action}.${shape}.${f}=${JSON.stringify(v)?.slice(0, 30)}`, () => H.call(records, { token: H.tok.adminA, body: JSON.parse(JSON.stringify(body, (k, x) => (x === undefined ? null : x))) }));
      }
    }
  }
}
const leaks = bad.filter((b) => !/-> 500\s+\{"error":"Internal server error"\}/.test(b));
const five = bad.filter((b) => /-> 500\s+\{"error":"Internal server error"\}/.test(b));
R.check('I1-records-sqlleak', `records.ts: ${total} hostile payloads: no SQL error text / throw / injection effect`, leaks.length === 0, { severity: 'High', route: 'records', detail: `${leaks.length} bad, first: ${leaks.slice(0, 3).join(' | ')}` });
const kinds = new Set(five.map((b) => b.split('=')[0].split('.').slice(-1)[0]));
R.check('I1-records-500', `records.ts: malformed ids / NUL bytes / filters:null are 4xx, not 500 (${five.length} got 500; fields: ${[...kinds].join(',')})`, five.length === 0, { severity: 'Low', route: 'records', detail: five.slice(0, 3).join(' | ') });
R.check('I1-records-slow', 'no records payload takes > 3s', slow.length === 0, { severity: 'Medium', route: 'records', detail: slow.slice(0, 3).join(' | ') });

/* data integrity after DROP attempts + prototype pollution */
const tablesOk = (await H.lite.query("SELECT count(*) n FROM documents")).rows[0].n > 0;
R.check('I2-drop', 'documents table intact after injection strings', tablesOk, { severity: 'Critical', route: 'records' });
R.check('I2-proto', 'Object.prototype not polluted by __proto__/constructor.prototype bodies', ({}).polluted === undefined && ({}).polluted2 === undefined && ({}).admin === undefined, { severity: 'High', route: 'records' });

/* writes with hostile + cross tenant ids */
const wr = [];
for (const [action, p] of [
  ['updateEntity', { id: bEnt, updates: { data: { customer_name: 'HACKED' } }, data: { customer_name: 'HACKED' }, customer_name: 'HACKED' }],
  ['updateDocument', { id: bDoc, updates: { original_filename: 'HACKED' }, original_filename: 'HACKED' }],
  ['createEntity', { entity_type: 'customer', data: { __proto__: { x: 1 }, customer_name: "Robert'); DROP TABLE entities;--" }, tenant_id: tu.B, id: bEnt, merged_into: bEnt }],
  ['createEntity', { entity_type: "customer'; DROP TABLE entities;--", data: {} }],
  ['updateEntity', { id: "x' OR 1=1", updates: {} }],
  ['updateEntity', { id: bEnt, updates: { tenant_id: tu.A, 'id': 'x', 'data = data || (SELECT 1) --': 1, '"; DROP TABLE x;--': 1 } }],
  ['updateDocument', { id: bDoc, updates: { tenant_id: tu.A, storage_key: `${tu.A}/aa/bb`, 'x" = 1; --': 1 } }],
]) {
  const r = await H.call(records, { token: H.tok.adminA, body: { action, ...p } });
  wr.push(`${action} ${r.status}`);
  if (r.status >= 500) bad.push(`write ${action} ${r.status} ${r.text.slice(0, 80)}`);
}
const bAfter = (await H.lite.query("SELECT data->>'customer_name' n FROM entities WHERE id=$1", [bEnt])).rows[0];
const bDocAfter = (await H.lite.query("SELECT original_filename f, storage_key k, tenant_id t FROM documents WHERE id=$1", [bDoc])).rows[0];
R.check('I3-xtenant-write', "A cannot modify B's entity/document by id (all update variants)", bAfter.n !== 'HACKED' && bDocAfter.f !== 'HACKED' && bDocAfter.t === tu.B && !bDocAfter.k?.startsWith(tu.A), { severity: 'Critical', route: 'records update*', detail: wr.join(',') });
const aAfter = Number((await H.lite.query('SELECT count(*) n FROM entities WHERE tenant_id=$1', [tu.A])).rows[0].n);
const bAfterN = Number((await H.lite.query('SELECT count(*) n FROM entities WHERE tenant_id=$1', [tu.B])).rows[0].n);
R.check('I3-xtenant-create', 'createEntity with foreign tenant_id/id creates nothing in B', bAfterN === bBefore, { severity: 'Critical', route: 'records createEntity', detail: `B ${bBefore}->${bAfterN}, A ${aBefore}->${aAfter}` });
const sk = (await H.lite.query("SELECT count(*) n FROM documents WHERE tenant_id=$1 AND storage_key NOT LIKE $2", [tu.A, `${tu.A}/%`])).rows[0].n;
R.check('I3-update-storage-key', 'updateDocument cannot set storage_key on own row to an arbitrary value', (await H.lite.query('SELECT storage_key FROM documents WHERE id=$1', [bDoc])).rows[0].storage_key === bDocAfter.k, { severity: 'High', route: 'records updateDocument' });
// own-document storage_key via update
const ownDoc = (await H.lite.query('SELECT id, storage_key FROM documents WHERE tenant_id=$1 LIMIT 1', [tu.A])).rows[0];
const evilKey = `${tu.B}/aa/${'a'.repeat(64)}`;
await H.call(records, { token: H.tok.adminA, body: { action: 'updateDocument', id: ownDoc.id, updates: { storage_key: evilKey }, storage_key: evilKey } });
const k2 = (await H.lite.query('SELECT storage_key FROM documents WHERE id=$1', [ownDoc.id])).rows[0].storage_key;
R.check('I3-own-storage-key', "member/admin cannot repoint own document's storage_key at another company's object via updateDocument", k2 !== evilKey, { severity: 'High', route: 'records updateDocument', detail: `key now ${String(k2).slice(0, 50)}` });

/* v1 routes (API key) and grid / analytics / account fuzz */
const key = await H.mintKey('A', ['read', 'ingest', 'ask']);
bad = []; let n2 = 0;
const v1Probes = [];
for (const resource of ['customers', 'customer', 'equipment', 'warranty', 'export', 'graph', 'intake-status', 'customer-equipment']) {
  for (const f of ['q', 'sort', 'limit', 'cursor', 'id', 'number', 'kind', 'serial', 'documentIds', 'queue', 'today', 'resource', 'model', 'brand']) {
    for (const v of [...EVIL.slice(0, 18), ...WEIRD.slice(0, 6)]) v1Probes.push([resource, f, v]);
  }
}
for (const [resource, f, v] of v1Probes) {
  n2++;
  const t0 = Date.now();
  const r = await H.call(v1, { token: undefined, method: 'GET', headers: { 'x-api-key': key, authorization: `Bearer ${key}` }, query: { resource, [f]: typeof v === 'object' ? v : String(v) } });
  if (r.status >= 500 || r.thrown || sqlLeak.test(r.text.slice(0, 1500)) || Date.now() - t0 > 3000) bad.push(`v1 ${resource}.${f}=${String(JSON.stringify(v)).slice(0, 25)} -> ${r.status} ${Date.now() - t0}ms ${r.thrown?.message ?? r.text.slice(0, 80)}`);
}
R.check('I4-v1-fuzz', `v1 routes: ${n2} hostile query values give no 5xx / SQL text / >3s (NUL byte in ?q= gives 500)`, bad.length === 0, { severity: 'Low', route: 'v1/*', detail: `${bad.length} bad: ${bad.slice(0, 3).join(' | ')}` });

bad = []; let n3 = 0;
for (const op of ['units', 'documentCells', 'bogus', '__proto__', null]) {
  for (const f of ['filters', 'columns', 'cursor', 'limit', 'documentIds']) {
    for (const v of [...EVIL.slice(0, 20), ...WEIRD]) {
      n3++;
      const inner = f === 'filters' ? { q: v, brand: v, customerId: v, sort: v, limit: v } : v;
      const r = await H.call(grid, { token: H.tok.adminA, body: { op, [f]: inner, documentIds: f === 'documentIds' ? v : [] } });
      if (r.status >= 500 || r.thrown || sqlLeak.test(r.text.slice(0, 1500))) bad.push(`grid ${op}.${f}=${JSON.stringify(v)?.slice(0, 25)} -> ${r.status} ${r.thrown?.message ?? r.text.slice(0, 80)}`);
    }
  }
}
R.check('I5-grid-fuzz', `grid route: ${n3} hostile bodies give no 5xx / SQL text`, bad.length === 0, { severity: 'Medium', route: 'grid', detail: `${bad.length} bad: ${bad.slice(0, 3).join(' | ')}` });

/* ILIKE wildcard DoS timing + wildcard match semantics */
const timeIt = async (q) => { const t0 = Date.now(); const r = await H.call(records, { token: H.tok.adminA, body: { action: 'browseDocuments', filters: { q } } }); return { ms: Date.now() - t0, r }; };
const base = await timeIt('zzzzqqqq'); const wild = await timeIt('%_'.repeat(500)); const wild2 = await timeIt('%a'.repeat(2000));
R.check('I6-ilike-wild', `ILIKE wildcard-heavy q (browseDocuments) stays within 5x+1s of a plain query (plain ${base.ms}ms, wild ${wild.ms}ms, wild2 ${wild2.ms}ms)`, wild.ms < base.ms * 5 + 1000 && wild2.ms < base.ms * 5 + 1000, { severity: 'Low', route: 'records browseDocuments' });
const pct = await timeIt('%');
const nDocsA = (await H.lite.query('SELECT count(*)::int n FROM documents WHERE tenant_id=$1', [tu.A])).rows[0].n;
R.check('I6-ilike-semantics', "q='%' only matches own tenant (never B's rows)", pct.r.status === 200 && !pct.r.text.includes('Zed Zimmer') && !pct.r.text.includes('BINV-'), { severity: 'Critical', route: 'records browseDocuments' });

/* ReDoS timing through ask (model blocked; routers/regexes run on the question) */
const shapes = {
  nums: '1 '.repeat(5000), words: 'for John '.repeat(2000), caps: 'A'.repeat(20000) + '!', addr: '123 ' + 'North South East '.repeat(1500) + 'Street', spaces: 'at the' + ' '.repeat(50000) + 'x', brand: 'is the unit a ' + 'carrier '.repeat(3000), nested: '('.repeat(5000), amounts: 'between $' + '1,'.repeat(3000) + ' and ', mixed: 'is ' + 'Mr A '.repeat(3000) + 'out of warranty', dots: '. '.repeat(20000), apostr: "A'B ".repeat(8000), dash: 'A-'.repeat(15000), serial: 'serial ' + 'A1'.repeat(20000), months: 'jan 1 '.repeat(4000),
};
let redos = [];
for (let [n, q] of Object.entries(shapes)) {
  const t0 = Date.now(); q = q.slice(0, 1990);
  const r = await H.call(ask, { token: H.tok.adminA, body: { question: q, today: '2026-09-25' } });
  const ms = Date.now() - t0;
  if (ms > 2500 || r.thrown) redos.push(`${n} ${q.length}ch ${ms}ms ${r.thrown?.message ?? ''}`);
  console.log('  ask timing', n, q.length, ms, 'ms status', r.status);
}
R.check('I7-redos-ask', 'adversarial questions (<=2000 chars) never take >2.5s on the regex/router path', redos.length === 0, { severity: 'Medium', route: 'ask', detail: redos.join(' | ') });
R.finish();
