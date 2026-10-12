/**
 * verify:scale-r19 - Donovan at many documents (R19): the DQL snapshot is read in pages, reused while the company's data is unchanged, and never partial.
 *   1. equivalence: the snapshot read in tiny pages == the snapshot read in one page; the reused snapshot == a fresh one; ~60 questions answer identically
 *      with the snapshot memo on (DONOVAN_SNAPCACHE default) and off (DONOVAN_SNAPCACHE=0), on the golden company and on a 3x scaled copy of it.
 *   2. freshness: a new paper (data version change) shows in the next answer; concurrent misses share one load; a day change rebuilds.
 *   3. truncation: past the row cap the snapshot says truncated and runDql releases (null), never a partial answer.
 *   4. timing smoke: warm DQL answers over a ~3,000 paper company stay under a loose bound and the snapshot is built once.
 *   node scripts/verify-scale-r19.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const { SCORECARD_CALL } = await import('../api/_lib/scorecard/hook.js');
const { createUsageMeter, runWithUsageMeter } = await import('../api/_lib/usage.js');
const { default: askHandler } = await import('../api/ask.js');
const { loadSnapshot, loadRaw, _resetSnapshotMemo } = await import('../api/_lib/dql/load.js');
const { runDql } = await import('../api/_lib/dql/index.js');
const { loadScaled } = await import('./lib/scale-gen.mjs');
const { withTenant } = await import('../api/_lib/recordsStore.js');
const store = await import('../api/_lib/records/store.js');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));

function makeRes() { const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; } }; return res; }
async function ask(auth, question, today = '2026-10-07') {
  const req = { method: 'POST', headers: {}, query: {}, body: { question, today }, [SCORECARD_CALL]: { auth, escalate: false } };
  const res = makeRes();
  try { await runWithUsageMeter(createUsageMeter(), () => askHandler(req, res)); } catch { /* an unanswered question compares as such */ }
  const b = res.body; return b?.success ? String(b.data?.text ?? '') : '<none>';
}
const custs = [...new Set(base.entities.filter((e) => e.entity_type === 'customer' && e.data?.customer_name).map((e) => e.data.customer_name))];
const types = [...new Set(base.documents.map((d) => d.document_type))].filter((t) => t !== 'hr-letter').map((t) => t.replace(/-/g, ' '));
const QS = [
  'how many customers do we have', 'how many documents do we have', 'what is the total of all invoices', 'what was our average invoice', 'who are our top 5 customers by amount billed',
  'what is our biggest invoice', 'show me the 5 most recent invoices', 'who was our most recent customer', 'which customer has the most invoices', 'what did we bill by month in 2025',
  'which documents mention filter', 'any papers that mention a leak', 'how many invoices were there last year', 'list the invoices from last month',
  ...types.slice(0, 6).map((t) => `how many ${t}s do we have`),
  ...custs.slice(0, 8).flatMap((c) => [`how many invoices does ${c} have`, `what is the total billed to ${c}`, `show me everything for ${c}`]),
];
const dates = ['2026-10-07'];

async function company(label, copies) {
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const loaded = await loadScaled(off, lite, base, base.documents.length * copies, { tenantKey: label, tenantName: label });
  return { lite, loaded, auth: { tenantId: loaded.ctx.tenantKey, orgId: label, userId: null } };
}
const dbFor = (c) => (fn) => withTenant({ tenantKey: c.loaded.ctx.tenantKey, tenantName: c.loaded.ctx.tenantName }, fn);

// ---------- 1. equivalence
const stripFns = (s) => JSON.stringify({ d: s.documents, c: s.customers, u: s.units, f: s.fin.map((x) => ({ ...x, doc: x.doc.id })), l: s.lines.map((x) => ({ ...x, doc: x.doc.id })), today: s.today });
for (const copies of [1, 3]) {
  const c = await company(`eq${copies}`, copies);
  const run = dbFor(c);
  process.env.DQL_PAGE_ROWS = '700';
  _resetSnapshotMemo(); process.env.DONOVAN_SNAPCACHE = '0';
  const paged = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
  delete process.env.DQL_PAGE_ROWS;
  const whole = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
  check(`x${copies}: snapshot read in pages of 700 == read in one page`, stripFns(paged) === stripFns(whole) && paged.documents.length > 0, `${paged.documents.length} vs ${whole.documents.length}`);
  check(`x${copies}: paged read is complete (truncated=false)`, paged.truncated === false && whole.truncated === false);
  delete process.env.DONOVAN_SNAPCACHE; _resetSnapshotMemo();
  const a1 = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
  const a2 = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
  check(`x${copies}: second question reuses the snapshot (same object)`, a1 === a2);
  check(`x${copies}: reused snapshot == fresh snapshot`, stripFns(a1) === stripFns(whole));
  // answers with the memo on vs off
  const on = []; const offA = [];
  _resetSnapshotMemo(); delete process.env.DONOVAN_SNAPCACHE;
  for (const q of QS) on.push(await ask(c.auth, q));
  _resetSnapshotMemo(); process.env.DONOVAN_SNAPCACHE = '0';
  for (const q of QS) offA.push(await ask(c.auth, q));
  delete process.env.DONOVAN_SNAPCACHE;
  const diff = QS.map((q, i) => (on[i] === offA[i] ? null : `${q}\n   on : ${on[i].slice(0, 120)}\n   off: ${offA[i].slice(0, 120)}`)).filter(Boolean);
  check(`x${copies}: ${QS.length} questions answer identically with the snapshot memo on and off`, diff.length === 0, diff.slice(0, 2).join('\n'));
  check(`x${copies}: most questions are answered (not all declined)`, on.filter((t) => t && t !== '<none>' && t.length > 8).length >= QS.length * 0.5);
  // the records lane's attribution pass limited to the papers it is asked about gives the same rows as the pass over the whole company
  {
    const ids = a1.customers.slice(0, 60).map((x) => x.id); const uids = a1.units.slice(0, 40).map((x) => x.id);
    const same = async (f) => JSON.stringify(await f(true)) === JSON.stringify(await f(false));
    let badC = 0; let badU = 0;
    for (const id of ids) if (!(await same((sc) => run((db) => store.docsForCustomer(db, id, { scoped: sc }))))) badC++;
    for (const id of uids) if (!(await same((sc) => run((db) => store.docsForUnit(db, id, { scoped: sc }))))) badU++;
    check(`x${copies}: docsForCustomer scoped == whole-company pass (${ids.length} customers)`, badC === 0, `${badC} differ`);
    check(`x${copies}: docsForUnit scoped == whole-company pass (${uids.length} units)`, badU === 0, `${badU} differ`);
    const docIds = a1.documents.map((d) => d.id); let badB = 0;
    for (let i = 0; i < 4; i++) { const chunk = docIds.slice(i * 40, i * 40 + 40); if (chunk.length && !(await same((sc) => run((db) => store.loadBundle(db, chunk, { scoped: sc }).then((b) => ({ ...b, fin: [...b.fin] })))))) badB++; }
    check(`x${copies}: loadBundle scoped == whole-company pass (4 batches of 40 papers)`, badB === 0, `${badB} differ`);
  }
  if (copies === 1) {
    // ---------- 2. freshness
    _resetSnapshotMemo();
    const before = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
    const nDocs = before.documents.length;
    const tenantId = c.loaded.tenantId;
    await c.lite.query(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, created_at, updated_at) VALUES ('99999999-0000-4000-8000-000000000001', $1, 'new-invoice.pdf', 'invoice', 'zz', 1, 'linked', now(), now())`, [tenantId]);
    const after = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
    check('fresh: a new paper changes the data version, so the next snapshot has it', after.documents.length === nDocs + 1 && after !== before, `${nDocs} -> ${after.documents.length}`);
    const nextDay = await run((db) => loadSnapshot(db, { today: '2026-10-08' }));
    check('fresh: a different day rebuilds (warranty status is date-relative)', nextDay !== after && nextDay.today === '2026-10-08');
    const [p1, p2] = await Promise.all([run((db) => loadSnapshot(db, { today: '2026-10-09' })), run((db) => loadSnapshot(db, { today: '2026-10-09' }))]);
    check('fresh: two requests that miss together share one snapshot', p1 === p2);
    // ---------- 3. truncation
    _resetSnapshotMemo(); process.env.DQL_MAX_ROWS = '50'; process.env.DQL_PAGE_ROWS = '20';
    const cut = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
    check('trunc: past the row cap the snapshot is flagged truncated', cut.truncated === true);
    const intent = { plan: { op: 'count', entity: 'document', doc_type: 'invoice', measure: null, filters: [], time: null, group_by: [], sort: null, limit: null, second: null, hop: null } };
    const released = await run((db) => runDql(db, intent, { today: '2026-10-07' }));
    check('trunc: runDql releases (null) instead of answering from a part', released === null);
    delete process.env.DQL_MAX_ROWS; delete process.env.DQL_PAGE_ROWS;
    const again = await run((db) => loadSnapshot(db, { today: '2026-10-07' }));
    check('trunc: a cut snapshot is never kept for the next question', again.truncated === false && again !== cut);
  }
}

// ---------- 4. timing smoke (~3,000 papers)
{
  const c = await company('smoke', 5); const run = dbFor(c);
  _resetSnapshotMemo();
  let reads = 0; const oq = c.lite.query.bind(c.lite);
  c.lite.query = async (sql, p) => { if (/FROM extractions x WHERE/.test(String(sql)) && /_ctid/.test(String(sql))) reads++; return oq(sql, p); };
  const qs = QS.slice(0, 24); const ms = [];
  for (const q of qs) { const t = Date.now(); await ask(c.auth, q); ms.push(Date.now() - t); }
  const warm = ms.slice(1).sort((a, b) => a - b); const p50 = warm[Math.floor(warm.length / 2)];
  check(`smoke: the snapshot is read once for ${qs.length} questions (extraction reads: ${reads})`, reads <= 1);
  check(`smoke: warm p50 ${p50} ms under 1500 ms at ${c.loaded.docs} papers`, p50 < 1500, JSON.stringify(ms));
}
console.log = realLog;
console.log(`\nverify:scale-r19  ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
