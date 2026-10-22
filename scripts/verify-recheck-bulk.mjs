/**
 * verify:recheck-bulk (2026-10-22) — regression for the Inbox's "Re-check all missing fields" returning
 * "Internal server error" in production (Sonoran Comfort Air, ~1,230 documents).
 *
 * Root cause: recheckTenantMissing() bound `force` as $2 but the SQL never referenced $2 (the document ids were $3).
 * Postgres/Neon rejects a statement with an untyped, unused parameter (42P18 "could not determine data type of
 * parameter $2"; PGlite reports the same mistake as 08P01 "bind message supplies N parameters"), so every call
 * failed: the Inbox button (with ids) AND the nightly sweep (without ids).
 *
 * This suite drives recheckTenantMissing() exactly the way api/review.js's `recheckMissing` case does for the button
 * (batches of 100 ids, limit 100, force: true) against a real Postgres (PGlite, as deepwell_rls) holding a large,
 * messy tenant: 1,230 documents, documents with no type, VOID papers, duplicates, null / blank / odd field values,
 * documents with no page text, ids from another tenant, unknown ids and garbage strings. It also covers the nightly
 * (no ids) path on the same tenant, where the old code also lost extractions past the 500-document lookup cap.
 *
 * No network, no model, no DATABASE_URL. Fails on the pre-fix recheck.js; passes after.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);
const realLog = console.log;
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; realLog(`PASS  ${name}`); } else { fail++; realLog(`FAIL  ${name}${extra ? `\n      ${extra}` : ''}`); } };

process.env.NEON_CONNECTION_STRING ||= 'postgres://verify:verify@localhost-pooler/verify';
process.env.DATABASE_URL ||= process.env.NEON_CONNECTION_STRING;

let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  realLog(`FAIL  PGlite is not installed (${err?.message}); this regression needs a real Postgres.`);
  process.exit(1);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = rel('M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerance as verify-r33-dates */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* */ }

// Route the app's pg Pool through PGlite as the RLS role. Also record every statement whose bound parameter count
// exceeds the highest $n it references (the exact class of bug that broke production).
const unusedParamStatements = [];
const audit = (sql, params) => {
  if (!Array.isArray(params) || !params.length) return;
  const refs = [...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = refs.length ? Math.max(...refs) : 0;
  const used = new Set(refs);
  for (let i = 1; i <= params.length; i++) if (!used.has(i)) { unusedParamStatements.push({ sql: String(sql).slice(0, 120), params: params.length, max, missing: i }); break; }
};
const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => { audit(sql, params); return lite.query(sql, params); }, release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) { audit(sql, params); const release = await lock(); try { return await lite.query(sql, params); } finally { release(); } };

const { getTenantContext } = await import(rel('api/_lib/recordsStore.js'));
const RC = await import(rel('api/_lib/recheck.js'));

const ctxA = { tenantKey: 'org_sonoran_bulk', tenantName: 'Sonoran Comfort Air' };
const ctxB = { tenantKey: 'org_other_bulk', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

let seq = 0;
const nid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;
const day = (n) => new Date(Date.UTC(2026, 9, 20) - n * 3600_000).toISOString();

// Bulk insert helpers (one statement per table per chunk keeps the 1,230-document build fast).
const docs = [], pages = [], facets = [], extractions = [], links = [];
async function flush() {
  const ins = async (table, cols, rows, casts) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params = [];
      const values = chunk.map((r) => `(${r.map((v, j) => { params.push(v); return `$${params.length}${casts[j] ?? ''}`; }).join(',')})`).join(',');
      await lite.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, params);
    }
  };
  await ins('documents', ['id', 'tenant_id', 'original_filename', 'document_type', 'sha256_hash', 'stage', 'created_at'], docs, ['', '', '', '', '', '', '::timestamptz']);
  await ins('document_pages', ['tenant_id', 'document_id', 'page_no', 'text'], pages, []);
  await ins('facets', ['id', 'tenant_id', 'document_id', 'page_no', 'segment_id', 'label_raw', 'value_raw', 'confidence', 'mapped_field_key', 'mapping_method', 'created_at'], facets, ['', '', '', '', '', '', '', '::numeric', '', '', '::timestamptz']);
  await ins('extractions', ['id', 'tenant_id', 'document_id', 'entity_id', 'field_key', 'value', 'confidence', 'source_facet_id', 'created_at'], extractions, ['', '', '', '', '', '', '::numeric', '', '::timestamptz']);
  await ins('document_entity_links', ['tenant_id', 'document_id', 'entity_id', 'confidence', 'linked_by', 'created_at'], links, ['', '', '', '::numeric', '', '::timestamptz']);
}
async function makeEntity(tenantId, type, data) {
  const id = nid();
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,NOW(),NOW())`, [id, tenantId, type, JSON.stringify(data)]);
  return id;
}
function makeDoc(tenantId, { type, stage = 'linked', text, fields = [], linkTo = null, createdAt, hash }) {
  const id = nid();
  docs.push([id, tenantId, `doc-${seq}.pdf`, type, hash ?? `h-${id}`, stage, createdAt]);
  if (text != null) pages.push([tenantId, id, 1, text]);
  for (const f of fields) {
    const fid = nid();
    facets.push([fid, tenantId, id, 1, 'field-extract', f.key, f.value, f.confidence ?? 0.95, f.key, 'registry', createdAt]);
    extractions.push([nid(), tenantId, id, null, f.key, f.value, f.confidence ?? 0.95, fid, createdAt]);
  }
  if (linkTo) links.push([tenantId, id, linkTo, 0.9, 'ai', createdAt]);
  return id;
}

const cust = await makeEntity(tenA, 'customer', { customer_name: 'William Quintana', service_address: '951 E Main St, Chandler, AZ 85224' });
const ticketText = (i, date) => [
  'SONORAN COMFORT AIR', `SERVICE TICKET #${10000 + i}`, `Date of Service: ${date}`,
  'Customer: William Quintana', 'Service Address: 951 E Main St, Chandler, AZ 85224',
  'Serial #: M100025', 'Work Performed: Checked refrigerant charge', 'Technician: Marisol Vega',
].join('\n');
const ticketFieldsNoDate = [
  { key: 'customer_name', value: 'William Quintana' }, { key: 'service_address', value: '951 E Main St, Chandler, AZ 85224' },
  { key: 'serial_number', value: 'M100025' }, { key: 'work_performed', value: 'Checked refrigerant charge' },
];
const ids = { fillable: [], unfixable: [], noType: [], voids: [], dupes: [], odd: [], noText: [], complete: [] };
let n = 0;
// 420 service tickets whose printed date was dropped at ingest (re-check can restore it).
for (let i = 0; i < 420; i++) ids.fillable.push(makeDoc(tenA, { type: 'service-ticket', text: ticketText(i, `09/${String(1 + (i % 28)).padStart(2, '0')}/2026`), fields: ticketFieldsNoDate, linkTo: cust, createdAt: day(n++) }));
// 200 invoices missing an amount that the page never prints (re-check must leave them for a person, no error).
for (let i = 0; i < 200; i++) ids.unfixable.push(makeDoc(tenA, { type: 'invoice', text: `INVOICE\nCustomer: William Quintana\nThank you for your business ${i}`, fields: [{ key: 'customer_name', value: 'William Quintana' }], linkTo: cust, createdAt: day(n++) }));
// 150 documents with no kind at all (document_type NULL): never candidates, never touched.
for (let i = 0; i < 150; i++) ids.noType.push(makeDoc(tenA, { type: null, stage: 'read', text: ticketText(5000 + i, '09/02/2026'), createdAt: day(n++) }));
// 100 VOID papers and 100 duplicate copies of a ticket.
for (let i = 0; i < 100; i++) ids.voids.push(makeDoc(tenA, { type: 'invoice', text: `VOID\nINVOICE #${i}\nVOID VOID`, fields: [], createdAt: day(n++) }));
for (let i = 0; i < 100; i++) ids.dupes.push(makeDoc(tenA, { type: 'service-ticket', text: ticketText(7, '09/07/2026'), fields: ticketFieldsNoDate, linkTo: cust, createdAt: day(n++) }));
// 130 documents with odd stored values: null, blank, whitespace, unicode, absurd length.
const oddVals = [null, '', '   ', 'N/A', '—', '\u0000x'.replace('\u0000', ''), 'Ünïcødé 名前', 'x'.repeat(5000)];
for (let i = 0; i < 130; i++) ids.odd.push(makeDoc(tenA, { type: i % 2 ? 'work-order' : 'service-ticket', text: i % 3 ? ticketText(9000 + i, '13/45/2026') : '', fields: [{ key: 'service_address', value: oddVals[i % oddVals.length] }, { key: 'service_date', value: oddVals[(i + 3) % oddVals.length] }], createdAt: day(n++) }));
// 80 documents with no page text at all.
for (let i = 0; i < 80; i++) ids.noText.push(makeDoc(tenA, { type: 'service-ticket', text: null, fields: [{ key: 'customer_name', value: 'William Quintana' }], createdAt: day(n++) }));
// 50 complete, unlinked work orders — the OLDEST documents (past position 500 newest-first).
for (let i = 0; i < 50; i++) ids.complete.push(makeDoc(tenA, { type: 'work-order', text: `WORK ORDER\nDate: 08/01/2026\nService Address: ${i} A St, Mesa, AZ 85201\nTechnician: Ray Sutton`, fields: [{ key: 'service_address', value: `${i} A St, Mesa, AZ 85201` }, { key: 'service_date', value: '2026-08-01' }, { key: 'technician', value: 'Ray Sutton' }], createdAt: day(5000 + n++) }));
// Tenant B: the same broken ticket — must never be touched by tenant A's run.
const bDoc = makeDoc(tenB, { type: 'service-ticket', text: ticketText(1, '09/03/2026'), fields: ticketFieldsNoDate, createdAt: day(1) });
const t0 = Date.now();
await flush();
const totalA = Number((await lite.query(`SELECT count(*)::int AS c FROM documents WHERE tenant_id = $1`, [tenA])).rows[0].c);
check(`fixture: large Sonoran-sized tenant built (${totalA} documents in ${((Date.now() - t0) / 1000).toFixed(1)}s)`, totalA === 1230);

const extractionCount = async (tenantId) => Number((await lite.query(`SELECT count(*)::int AS c FROM extractions WHERE tenant_id = $1`, [tenantId])).rows[0].c);
const beforeB = await extractionCount(tenB);
const noTypeBefore = Number((await lite.query(`SELECT count(*)::int AS c FROM extractions WHERE document_id = ANY($1::uuid[])`, [ids.noType])).rows[0].c);

// ---- 1. The Inbox button: ReviewScreen sends the ids it shows in batches of 100, limit 100, force: true
//         (reviewClient.recheckMissing) -> api/review.js `recheckMissing` -> recheckTenantMissing(ctx, {documentIds, limit, force, deadlineAt}).
const target = [
  ...ids.fillable, ...ids.unfixable, ...ids.noType, ...ids.voids, ...ids.dupes, ...ids.odd, ...ids.noText,
  bDoc, '00000000-0000-4000-9999-000000000000', 'not-a-uuid', '',
];
async function pressButton() {
  const tot = { calls: 0, scanned: 0, rechecked: 0, filled: 0, fields: 0, errors: 0, maxMs: 0, threw: null };
  for (let i = 0; i < target.length; i += 100) {
    const s = Date.now();
    try {
      const r = await RC.recheckTenantMissing(ctxA, { documentIds: target.slice(i, i + 100), force: true, actorClerkId: 'user_owner', source: 'inbox-bulk', limit: Math.min(300, 100), deadlineAt: Date.now() + 240_000 });
      for (const k of ['scanned', 'rechecked', 'filled', 'fields', 'errors']) tot[k] += r[k] ?? 0;
    } catch (err) {
      tot.threw = `${err?.code ?? ''} ${err?.message ?? err}`;
      break;
    }
    tot.calls++;
    tot.maxMs = Math.max(tot.maxMs, Date.now() - s);
  }
  return tot;
}
const first = await pressButton();
check('Re-check all (button path, ids in batches of 100, force): no call throws', !first.threw, first.threw ?? '');
check('...every batch completed', first.calls === Math.ceil(target.length / 100), `calls=${first.calls}`);
check('...no per-document errors', first.errors === 0, `errors=${first.errors}`);
realLog("  stats: " + JSON.stringify(first)); check('...restores the printed date on the dropped-date tickets', first.filled >= ids.fillable.length && first.fields >= ids.fillable.length, JSON.stringify(first));
check('...each batch stays well inside the 300 s function limit', first.maxMs < 60_000, `slowest batch ${first.maxMs} ms`);
check('...tenant B is never touched (ids from another account are ignored)', (await extractionCount(tenB)) === beforeB);
check('...documents with no kind are never touched', Number((await lite.query(`SELECT count(*)::int AS c FROM extractions WHERE document_id = ANY($1::uuid[])`, [ids.noType])).rows[0].c) === noTypeBefore);

const afterFirst = await extractionCount(tenA);
const second = await pressButton();
check('pressing again is idempotent: no error, nothing new written', !second.threw && second.fields === 0 && (await extractionCount(tenA)) === afterFirst, second.threw ?? JSON.stringify(second));

// ---- 2. The nightly sweep path (no ids) on the same large tenant.
let cron = null, cronErr = null;
try { cron = await RC.recheckTenantMissing(ctxA, { limit: 25, source: 'cron', deadlineAt: Date.now() + 60_000 }); } catch (err) { cronErr = `${err?.code ?? ''} ${err?.message ?? err}`; }
check('nightly sweep path (no ids) on a 1,230-document tenant: no throw', !cronErr, cronErr ?? '');
// Candidate count without ids must equal the union of id-scoped counts (no document past the 500-id extraction cap
// may look like it is missing everything).
let viaIds = 0;
const allA = (await lite.query(`SELECT id FROM documents WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenA])).rows.map((r) => r.id);
let chunkErr = null;
for (let i = 0; i < allA.length && !chunkErr; i += 100) {
  try { viaIds += (await RC.recheckTenantMissing(ctxA, { documentIds: allA.slice(i, i + 100), limit: 1, deadlineAt: 0, source: 'cron' })).candidates; } catch (err) { chunkErr = err?.message; }
}
check('...candidate count matches the id-scoped count (old documents past #500 are judged on their real fields)', cron && !chunkErr && cron.candidates === viaIds, `noIds=${cron?.candidates} viaIds=${viaIds} ${chunkErr ?? ''}`);

// ---- 3. Every statement binds only parameters it references (the bug class itself).
check('every SQL statement run by the re-check binds only parameters it references', unusedParamStatements.length === 0, JSON.stringify(unusedParamStatements.slice(0, 2)));

// ---- 4. A remaining failure reaches the owner as a plain-words message, never a bare 500.
const review = fs.readFileSync(rel('api/review.js'), 'utf8');
const caseBlock = review.slice(review.indexOf("case 'recheckMissing':"), review.indexOf("case 'resortDocuments':"));
check('api/review.js recheckMissing: unexpected errors become a friendly ReviewError (not "Internal server error")', /catch \(err\)/.test(caseBlock) && /new reviewStore\.ReviewError\("We couldn't finish re-checking/.test(caseBlock));
const screen = fs.readFileSync(rel('src/screens/ReviewScreen.tsx'), 'utf8');
check('ReviewScreen: a failed batch shows a friendly message with what was already saved', /internal server error\|/.test(screen) && /re-checked and saved before it stopped/.test(screen));

realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
