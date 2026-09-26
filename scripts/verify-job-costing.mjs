/**
 * JOB COST & MARGIN (M3-config/36-job-costing.sql, api/_lib/financials/{jobKey,jobCosting}.js,
 * normalize.js/extract.js/store.js/backfill.js/answers.js extensions).
 *
 * Same harness as scripts/verify-r7-finance.mjs: no network, no Anthropic key, no DATABASE_URL —
 * a real Postgres (PGlite) loaded from the actual M3-config/*.sql migrations, queried as the
 * app's non-superuser NOBYPASSRLS role (deepwell_rls).
 *
 *   1. pure: extractJobReference / normalizeJobKey (address variants agree; PO free text and an
 *      invoice's "Service Address:" line resolve to the SAME key), normalize.js job derivation
 *      (job_address / job_number, confidence, "never invent" — a garbled address yields no key).
 *   2. migration 36: idempotent, adds only columns (no new table/policy needed), RLS unchanged.
 *   3. extraction pipeline end to end: an invoice and a PO's "For job at:" line both land in
 *      document_financials.job_key via extractFinancialsForDocument (extract.js -> normalize.js
 *      -> store.js), matching to the SAME job.
 *   4. computeJobCosts: revenue/cost grouped by job, exact to the cent; a job with only one side
 *      never reports a fake 100%/-100% margin; a document below JOB_MATCH_CONFIDENCE (or with no
 *      resolvable address at all) is listed as unmatched, never guessed into a group.
 *   5. backfill: populates job_key on rows extracted before this feature existed from the
 *      customer's on-file address or a page-text regex, no model call; never touches a
 *      human-reviewed row; idempotent.
 *   6. every deterministic job-costing answer (margin for one job, cost vs revenue for a
 *      customer, gross margin by job, most/least profitable, jobs over budget, average margin),
 *      each with citations naming the invoice(s) and purchase order(s)/bill(s) matched.
 *   7. fallback WITHOUT migration 36 (columns dropped): the same job groupings still compute,
 *      from the customer's on-file address / a live page-text regex read, at a lower confidence.
 *
 *   node scripts/verify-job-costing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

/* ================================================================== 1. pure */
const JK = await import('../api/_lib/financials/jobKey.js');
const N = await import('../api/_lib/financials/normalize.js');
const TODAY = '2026-09-23';
{
  eq('normalizeJobKey: house number + significant street words + printed CITY, suffix/case/comma-insensitive (a printed zip is never required)',
    [JK.normalizeJobKey('248 W Guadalupe Rd, Phoenix, AZ 85001'), JK.normalizeJobKey('248 Guadalupe Road, Phoenix, AZ'), JK.normalizeJobKey('not an address')],
    ['248-guadalupe-phoenix', '248-guadalupe-phoenix', null]);
  eq('normalizeJobKey: REVIEW FIX — same house+street, different printed city, never the same key (would otherwise merge two different customers\' jobs)',
    JK.normalizeJobKey('123 N Main St, Phoenix, AZ 85003') === JK.normalizeJobKey('123 N Main St, Gilbert, AZ 85234'), false);
  eq('normalizeJobKey: REVIEW FIX — same street address, different Apt/unit, never the same key',
    JK.normalizeJobKey('3300 S Alma School Rd, Apt 1, Mesa, AZ') === JK.normalizeJobKey('3300 S Alma School Rd, Apt 2, Mesa, AZ'), false);
  check('normalizeJobKey: no printed city at all -> a bare house+street(+unit) key, never guessed with a city attached',
    JK.normalizeJobKey('123 N Main St') === JK.jobKeyParts('123 N Main St, Phoenix, AZ').core);
  check('extractJobReference: a PO\'s "For job at:" line and an invoice\'s "Service Address:" line both parse, trailing "(name)" excluded from the address',
    JK.extractJobReference('For job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)\nParts:').address === '248 W Guadalupe Rd, Phoenix, AZ 85001'
    && JK.extractJobReference('For job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)\nParts:').customerName === 'Amy Isaacson'
    && JK.extractJobReference('Service Address: 840 S Ellsworth Rd, Gilbert, AZ 85234\nPhone: x').address === '840 S Ellsworth Rd, Gilbert, AZ 85234'
    && JK.extractJobReference('Job Address: 9 Test Ct, Mesa, AZ').address === '9 Test Ct, Mesa, AZ'
    && JK.extractJobReference('nothing relevant here') === null);
  check('a PO\'s job address and the matching invoice\'s service address normalize to the SAME job_key',
    JK.normalizeJobKey(JK.extractJobReference('For job at: 840 S Ellsworth Rd, Gilbert, AZ 85234 (Emily Whitfield)').address)
      === JK.normalizeJobKey(JK.extractJobReference('Service Address: 840 S Ellsworth Rd, Gilbert, AZ 85234').address));

  const M = (v, conf) => ({ value: v, page_no: 1, confidence: conf });
  const withAddr = N.normalizeFinancials({ kind: 'invoice', total: M('100.00', 0.9), job_address: M('248 W Guadalupe Rd, Phoenix, AZ 85001', 0.8) }, { documentType: 'invoice', pages: [{ page_no: 1, text: 'Total 100.00' }] });
  check('normalize: job_address -> job_key/job_key_source/job_confidence/job_raw', withAddr.header.job_key === JK.normalizeJobKey('248 W Guadalupe Rd, Phoenix, AZ 85001') && withAddr.header.job_key_source === 'extracted' && withAddr.header.job_confidence === 0.8 && withAddr.header.job_raw === '248 W Guadalupe Rd, Phoenix, AZ 85001', JSON.stringify(withAddr.header));
  const withNum = N.normalizeFinancials({ kind: 'po', direction: 'payable', total: M('50.00', 0.9), job_number: 'Job #4471' }, { documentType: 'purchase-order', pages: [{ page_no: 1, text: 'Total 50.00' }] });
  check('normalize: no address but a job_number -> a stable fallback key, never null', withNum.header.job_key === 'jobnum-job-4471' && withNum.header.job_key_source === 'extracted');
  const garbled = N.normalizeFinancials({ kind: 'invoice', total: M('50.00', 0.9), job_address: 'not a street address at all' }, { documentType: 'invoice', pages: [{ page_no: 1, text: '50.00' }] });
  check('normalize: NEVER INVENT — text that does not parse as an address yields no job_key (never a guess)', garbled.header.job_key === null && garbled.header.job_key_source === null);
  const none = N.normalizeFinancials({ kind: 'invoice', total: M('50.00', 0.9) }, { documentType: 'invoice', pages: [{ page_no: 1, text: '50.00' }] });
  check('normalize: no job_address/job_number printed -> job_key stays null (not fabricated from anything else)', none.header.job_key === null);
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const harnessNotes = [];
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { harnessNotes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk, same as verify-financials.mjs */ }
check('harness: migration 36 loaded cleanly (no error from 36-job-costing.sql)', !harnessNotes.some((n) => n.startsWith('36-')), harnessNotes.join(' | '));

const pgMod = (await import('pg')).default;
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

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const JC = await import('../api/_lib/financials/jobCosting.js');
const X = await import('../api/_lib/financials/extract.js');
const B = await import('../api/_lib/financials/backfill.js');
const G = await import('../api/_lib/financials/moneyGate.js');
const Classify = await import('../api/_lib/financials/classify.js');

const ctx = { tenantKey: 'org_job_costing', tenantName: 'Job Costing Shop' };
const tenId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
const uid = (kind, n) => `${kind}c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cust = (n) => uid('c', n);
const doc = (n) => uid('d', n);

// Expected keys, computed through the real function rather than hardcoded — the fix under
// test CHANGES the key format (folds in city/unit), so these must track it, not a literal.
const K_GUADALUPE = JC.normalizeJobKey('248 W Guadalupe Rd, Phoenix, AZ 85001');
const K_ELM = JC.normalizeJobKey('412 Elm St, Mesa, AZ 85201');
const K_CACTUS = JC.normalizeJobKey('17 Cactus Ln, Tucson, AZ 85701');
const K_ELLSWORTH = JC.normalizeJobKey('840 S Ellsworth Rd, Gilbert, AZ 85234');
const K_LOCKED = JC.normalizeJobKey('55 Locked Rd, Peoria, AZ 85345');
const K_OAK_PHX = JC.normalizeJobKey('500 N Oak St, Phoenix, AZ 85003');
const K_OAK_GLB = JC.normalizeJobKey('500 N Oak St, Gilbert, AZ 85234');
const K_ALMA1 = JC.normalizeJobKey('3300 S Alma School Rd, Apt 1, Mesa, AZ 85210');
const K_ALMA2 = JC.normalizeJobKey('3300 S Alma School Rd, Apt 2, Mesa, AZ 85210');
const K_TESTAVE = JC.normalizeJobKey('900 W Test Ave, Tempe, AZ 85281');
const K_TESTAVE_BARE = JK.jobKeyParts('900 W Test Ave').core; // what a bare (no-city) PO stores on its own

/* ---------- 2. migration ---------- */
{
  check('migration 36: job_key/job_key_source/job_confidence/job_raw columns exist', await withTenant(ctx, (db) => JC.jobCostingColumnsExist(db)));
  const rls = (await lite.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'document_financials'")).rows[0];
  check('migration 36 added no new table: document_financials keeps ENABLE + FORCE ROW LEVEL SECURITY from migration 22', rls.rls && rls.force);
  const twice = await lite.exec(fs.readFileSync(path.join(cfgDir, '36-job-costing.sql'), 'utf8')).then(() => true, () => false);
  check('migration 36 is idempotent (re-running it changes nothing and errors nothing)', twice);
}

/* ---------- fixtures ---------- */
async function addCustomer(n, name, address) {
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,\'customer\',$3::jsonb,$4)',
    [cust(n), tenId, JSON.stringify({ customer_name: name, service_address: address }), `C-JC-${n}`]);
}
async function addDoc(n, {
  type = 'invoice', customerId = null, docKind, direction = 'receivable', currency = 'USD',
  invoiceDate = null, total = null, balanceDue = null, status = 'unknown', invoiceNumber = null, poNumber = null,
  customerName = null, vendorName = null, jobKey = null, jobKeySource = null, jobConfidence = null, jobRaw = null,
  corrections = {}, verifiedBy = null, pageText = null,
} = {}) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc(n), tenId, `${type}-${n}.pdf`, type, `jc-hash-${n}`, 'linked']);
  if (customerId) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, doc(n), customerId]);
  await lite.query(
    `INSERT INTO document_financials
       (tenant_id, document_id, doc_kind, direction, currency, invoice_number, po_number, invoice_date, total, balance_due, status,
        customer_name, vendor_name, job_key, job_key_source, job_confidence, job_raw, corrections, verified_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::numeric,$17,$18::jsonb,$19)`,
    [tenId, doc(n), docKind, direction, currency, invoiceNumber, poNumber, invoiceDate, total, balanceDue, status,
      customerName, vendorName, jobKey, jobKeySource, jobConfidence, jobRaw, JSON.stringify(corrections), verifiedBy]);
  if (pageText) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)', [doc(n), tenId, pageText]);
}

await addCustomer(1, 'Amy Isaacson', '248 W Guadalupe Rd, Phoenix, AZ 85001');
await addCustomer(2, 'Karen Abernathy', '412 Elm St, Mesa, AZ 85201');
await addCustomer(3, 'Donna Thornton', '17 Cactus Ln, Tucson, AZ 85701');
await addCustomer(4, 'Emily Whitfield', '840 S Ellsworth Rd, Gilbert, AZ 85234');
// REVIEW FIX fixtures — city/unit disambiguation and the customer-entity elevation rule.
await addCustomer(5, 'Oak Phoenix Co', '500 N Oak St, Phoenix, AZ 85003');
await addCustomer(6, 'Oak Gilbert Co', '500 N Oak St, Gilbert, AZ 85234');
await addCustomer(7, 'Alma Apt1 Tenant', '3300 S Alma School Rd, Apt 1, Mesa, AZ 85210');
await addCustomer(8, 'Alma Apt2 Tenant', '3300 S Alma School Rd, Apt 2, Mesa, AZ 85210');
await addCustomer(10, 'Test Ave Tenant', null); // no on-file address — forces the page-text path below
await addCustomer(11, 'Different Co', null);    // no on-file address, and NOT the same customer as cust(10)

// Group A — both sides already resolved via a stored ('extracted') job_key: 248-guadalupe(-phoenix), 75% margin.
await addDoc(1, { customerId: cust(1), docKind: 'invoice', total: 1200, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-J1',
  invoiceDate: '2026-06-01', customerName: 'Amy Isaacson', jobKey: K_GUADALUPE, jobKeySource: 'extracted', jobConfidence: 0.9, jobRaw: '248 W Guadalupe Rd, Phoenix, AZ 85001' });
await addDoc(2, { docKind: 'po', direction: 'payable', total: 300, status: 'unknown', poNumber: 'PO-J1', vendorName: 'Ferguson Supply',
  invoiceDate: '2026-06-02', jobKey: K_GUADALUPE, jobKeySource: 'extracted', jobConfidence: 0.85, jobRaw: '248 W Guadalupe Rd, Phoenix, AZ 85001',
  pageText: 'PURCHASE ORDER\nPO #: PO-J1\nVendor: Ferguson Supply\nFor job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)\nTotal: $300.00' });

// Group B — revenue only (no PO ever references this address); job_key left NULL (pre-feature rows) so
// these also exercise the customer_address fallback (both on the fly AND via backfill below): 412-elm.
await addDoc(3, { customerId: cust(2), docKind: 'invoice', total: 500, balanceDue: 500, status: 'unpaid', invoiceNumber: 'INV-J2', invoiceDate: '2026-06-10', customerName: 'Karen Abernathy' });
await addDoc(7, { customerId: cust(2), docKind: 'invoice', total: 300, balanceDue: 300, status: 'unpaid', invoiceNumber: 'INV-J2B', invoiceDate: '2026-07-01', customerName: 'Karen Abernathy' });

// Group C — over budget: 17-cactus, revenue $200 < cost $650 (-225% margin). The PO's job_key is left
// NULL (an older extraction that missed job_address) so it exercises the page-text regex fallback.
await addDoc(5, { customerId: cust(3), docKind: 'invoice', total: 200, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-J3', invoiceDate: '2026-07-15', customerName: 'Donna Thornton', jobKey: K_CACTUS, jobKeySource: 'extracted', jobConfidence: 0.9, jobRaw: '17 Cactus Ln, Tucson, AZ 85701' });
await addDoc(4, { docKind: 'po', direction: 'payable', total: 650, status: 'unknown', poNumber: 'PO-J2', vendorName: 'Baker Distributing', invoiceDate: '2026-07-10',
  pageText: 'PURCHASE ORDER\nPO #: PO-J2\nVendor: Baker Distributing\nFor job at: 17 Cactus Ln, Tucson, AZ 85701 (Donna Thornton)\nTotal: $650.00' });

// Group D — unmatched: no job address anywhere, no customer link.
await addDoc(6, { docKind: 'po', direction: 'payable', total: 150, status: 'unknown', poNumber: 'PO-J3', vendorName: 'Random Vendor', invoiceDate: '2026-07-20',
  pageText: 'PURCHASE ORDER\nPO #: PO-J3\nVendor: Random Vendor\nTotal: $150.00' });

// Group E — a stored key BELOW JOB_MATCH_CONFIDENCE with no other resolvable source -> unmatched
// (never guessed into a group just because a key string exists).
await addDoc(9, { docKind: 'invoice', total: 90, status: 'unknown', invoiceNumber: 'INV-J5', invoiceDate: '2026-08-01',
  jobKey: '9-phantom', jobKeySource: 'extracted', jobConfidence: 0.3, jobRaw: '9 Phantom Way' });

// Group F — a human-verified row: backfill must never touch it, even though its page text would
// otherwise resolve fine (the on-the-fly read for ANSWERING is unaffected; only the WRITE is guarded).
await addDoc(8, { docKind: 'po', direction: 'payable', total: 400, status: 'unknown', poNumber: 'PO-J4', vendorName: 'Baker Distributing', invoiceDate: '2026-08-05',
  verifiedBy: 'Owner', pageText: 'PURCHASE ORDER\nPO #: PO-J4\nFor job at: 55 Locked Rd, Peoria, AZ 85345 (Someone)\nTotal: $400.00' });

// Group G — REVIEW FIX: same house number + street name, printed in TWO DIFFERENT CITIES ->
// must NEVER merge into one job (the pre-fix bug: normalizeJobKey dropped the city entirely).
await addDoc(12, { customerId: cust(5), docKind: 'invoice', total: 900, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-J6', invoiceDate: '2026-08-10', customerName: 'Oak Phoenix Co' });
await addDoc(13, { docKind: 'po', direction: 'payable', total: 250, status: 'unknown', poNumber: 'PO-J6', vendorName: 'Cool Supply', invoiceDate: '2026-08-11',
  pageText: 'PURCHASE ORDER\nPO #: PO-J6\nVendor: Cool Supply\nFor job at: 500 N Oak St, Gilbert, AZ 85234 (Oak Gilbert Co)\nTotal: $250.00' });

// Group H — REVIEW FIX: same street address, different Apt/unit -> must NEVER merge (two
// different tenants' invoices at the same complex).
await addDoc(14, { customerId: cust(7), docKind: 'invoice', total: 400, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-J7', invoiceDate: '2026-08-12', customerName: 'Alma Apt1 Tenant' });
await addDoc(15, { customerId: cust(8), docKind: 'invoice', total: 600, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-J8', invoiceDate: '2026-08-13', customerName: 'Alma Apt2 Tenant' });

// Group I — REVIEW FIX: no city printed on the PO's own free text at all. Elevation is only
// safe when the SAME customer entity is also behind a confident, city-bearing job at the same
// core address — cust(10) has NO on-file address (so customer_address itself never resolves for
// either of its documents), forcing a genuine bare page_text read for doc17, and doc16's stored
// job_key (from ITS OWN printed "Service Address:" line) is what supplies the confident city.
await addDoc(16, { customerId: cust(10), docKind: 'invoice', total: 700, balanceDue: 0, status: 'paid', invoiceNumber: 'INV-J9', invoiceDate: '2026-08-14', customerName: 'Test Ave Tenant',
  jobKey: K_TESTAVE, jobKeySource: 'extracted', jobConfidence: 0.9, jobRaw: '900 W Test Ave, Tempe, AZ 85281' });
await addDoc(17, { customerId: cust(10), docKind: 'po', direction: 'payable', total: 150, status: 'unknown', poNumber: 'PO-J8', vendorName: 'Bare Vendor', invoiceDate: '2026-08-15',
  pageText: 'PURCHASE ORDER\nPO #: PO-J8\nFor job at: 900 W Test Ave (Someone)\nTotal: $150.00' });
// Same bare core address ("900 W Test Ave", no city printed) but a DIFFERENT customer entity —
// must stay unmatched ("too uncertain"), never silently folded into cust(10)'s job.
await addDoc(18, { customerId: cust(11), docKind: 'po', direction: 'payable', total: 75, status: 'unknown', poNumber: 'PO-J9', vendorName: 'Bare Vendor 2', invoiceDate: '2026-08-16',
  pageText: 'PURCHASE ORDER\nPO #: PO-J9\nFor job at: 900 W Test Ave (Different Co)\nTotal: $75.00' });

/* ---------- 3. extraction pipeline end to end (840-ellsworth: 96.39% margin) ---------- */
await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
  [doc(10), tenId, 'invoice-10.pdf', 'invoice', 'jc-hash-10', 'linked']);
await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenId, doc(10), cust(4)]);
await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)',
  [doc(10), tenId, 'DOC-10 INVOICE Bill To Emily Whitfield Service Address: 840 S Ellsworth Rd, Gilbert, AZ 85234 TOTAL DUE: $5540.00']);
await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
  [doc(11), tenId, 'purchase-order-11.pdf', 'purchase-order', 'jc-hash-11', 'linked']);
await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)',
  [doc(11), tenId, 'DOC-11 PURCHASE ORDER PO #: PO-J5 Vendor: Baker Distributing For job at: 840 S Ellsworth Rd, Gilbert, AZ 85234 (Emily Whitfield) Total: $200.00']);

const money = (v, conf = 0.9) => ({ value: v, page_no: 1, verbatim: `x ${v}`, confidence: conf });
const fakeModel = ({ prompt }) => {
  const m = prompt.match(/DOC-(\d+)/);
  if (m?.[1] === '10') {
    return Promise.resolve({ input: { kind: 'invoice', invoice_number: 'INV-20020', invoice_date: '2026-05-13', customer_name: 'Emily Whitfield',
      job_address: money('840 S Ellsworth Rd, Gilbert, AZ 85234'), total: money('5540.00'), confidence: 0.95 }, usage: { inputTokens: 1500, outputTokens: 250 } });
  }
  if (m?.[1] === '11') {
    return Promise.resolve({ input: { kind: 'po', direction: 'payable', po_number: 'PO-J5', invoice_date: '2026-05-20', vendor_name: 'Baker Distributing',
      job_address: money('840 S Ellsworth Rd, Gilbert, AZ 85234'), total: money('200.00'), confidence: 0.9 }, usage: { inputTokens: 1200, outputTokens: 200 } });
  }
  return Promise.resolve({ input: null, usage: {} });
};
{
  const r1 = await X.extractFinancialsForDocument(ctx, doc(10), { withTenant, callModel: fakeModel, skipBudget: true, today: TODAY });
  const r2 = await X.extractFinancialsForDocument(ctx, doc(11), { withTenant, callModel: fakeModel, skipBudget: true, today: TODAY });
  eq('extraction pipeline: both the invoice and the PO wrote cleanly', [r1.status, r2.status], ['written', 'written']);
  const rows = (await lite.query("SELECT document_id, job_key, job_key_source, job_confidence, job_raw FROM document_financials WHERE document_id = ANY($1::uuid[]) ORDER BY document_id", [[doc(10), doc(11)]])).rows;
  check('extraction pipeline: extract.js\'s job_address field flows through normalize.js into store.js -> document_financials.job_key, same key for the invoice and its PO',
    rows.length === 2 && rows.every((r) => r.job_key === K_ELLSWORTH && r.job_key_source === 'extracted' && Number(r.job_confidence) > 0)
    && rows.every((r) => r.job_raw === '840 S Ellsworth Rd, Gilbert, AZ 85234'),
    JSON.stringify(rows));
}

/* ---------- 4. computeJobCosts: grouping, exactness, honesty, unmatched ---------- */
{
  const { jobs, unmatched, hasJobColumns, excludedCurrency } = await withTenant(ctx, (db) => JC.computeJobCosts(db));
  check('hasJobColumns reports true (migration 36 is loaded)', hasJobColumns === true);
  eq('no documents excluded for currency (everything on file so far is USD)', excludedCurrency, 0);
  const byKey = Object.fromEntries(jobs.map((j) => [j.jobKey, j]));
  // 10 groups: the original 5 (55-locked = PO-J4 alone — verified, so backfill will never WRITE
  // its job_key, checked below, but reading it for an aggregate answer is unaffected by that
  // guard) plus the 5 REVIEW FIX groups (G: two different cities never merge; H: two different
  // units never merge; I: the bare page-text PO elevates to cust(10)'s confident job).
  eq('10 jobs matched (5 original + 5 from the REVIEW FIX city/unit/elevation fixtures)', Object.keys(byKey).sort(),
    [K_ALMA1, K_ALMA2, K_CACTUS, K_ELLSWORTH, K_ELM, K_GUADALUPE, K_LOCKED, K_OAK_GLB, K_OAK_PHX, K_TESTAVE].sort());

  const g = byKey[K_GUADALUPE];
  eq(`${K_GUADALUPE}: revenue $1,200.00, cost $300.00, margin $900.00 (75%), both sides present`, [g.revenue, g.cost, g.marginDollars, g.marginPercent, g.hasRevenue, g.hasCost], ['1200.00', '300.00', '900.00', 75, true, true]);

  const e = byKey[K_ELM];
  check(`${K_ELM}: revenue-only ($800.00 across 2 invoices) — no cost documents, marginPercent is null (never a fake 100%)`, e.revenue === '800.00' && e.cost === '0.00' && e.hasRevenue && !e.hasCost && e.marginPercent === null, JSON.stringify(e));

  const c = byKey[K_CACTUS];
  check(`${K_CACTUS}: over budget — revenue $200.00 < cost $650.00, margin -$450.00 (-225%), resolved via the page-text fallback (no stored job_key on the PO)`, c.revenue === '200.00' && c.cost === '650.00' && c.marginDollars === '-450.00' && c.marginPercent === -225 && c.sources.includes('page_text'), JSON.stringify(c));

  const w = byKey[K_ELLSWORTH];
  eq(`${K_ELLSWORTH}: revenue $5,540.00, cost $200.00, margin $5,340.00 (96.39%)`, [w.revenue, w.cost, w.marginDollars, w.marginPercent], ['5540.00', '200.00', '5340.00', 96.39]);

  // REVIEW FIX G: "500 N Oak St" in two different cities — must be two separate jobs, one
  // revenue-only (Phoenix) and one cost-only (Gilbert), never merged into a single $900/$250 job.
  eq(`REVIEW FIX — ${K_OAK_PHX} (Phoenix) and ${K_OAK_GLB} (Gilbert) are DIFFERENT jobs despite the same house+street`, K_OAK_PHX === K_OAK_GLB, false);
  check(`${K_OAK_PHX}: revenue-only $900.00, no cost (the Gilbert PO never counts against it)`, byKey[K_OAK_PHX]?.revenue === '900.00' && byKey[K_OAK_PHX]?.cost === '0.00', JSON.stringify(byKey[K_OAK_PHX]));
  check(`${K_OAK_GLB}: cost-only $250.00, no revenue (the Phoenix invoice never counts against it)`, byKey[K_OAK_GLB]?.cost === '250.00' && byKey[K_OAK_GLB]?.revenue === '0.00', JSON.stringify(byKey[K_OAK_GLB]));

  // REVIEW FIX H: same street, different Apt/unit — two separate tenants' jobs, never merged.
  eq(`REVIEW FIX — ${K_ALMA1} (Apt 1) and ${K_ALMA2} (Apt 2) are DIFFERENT jobs despite the same street address`, K_ALMA1 === K_ALMA2, false);
  check(`${K_ALMA1}: $400.00 revenue (Apt 1's own invoice only)`, byKey[K_ALMA1]?.revenue === '400.00', JSON.stringify(byKey[K_ALMA1]));
  check(`${K_ALMA2}: $600.00 revenue (Apt 2's own invoice only)`, byKey[K_ALMA2]?.revenue === '600.00', JSON.stringify(byKey[K_ALMA2]));

  // REVIEW FIX I: doc17's PO prints NO city at all ("For job at: 900 W Test Ave") — it is only
  // grouped with doc16 because cust(10) (linked to BOTH documents) is also behind doc16's
  // confident, city-bearing stored job_key at the same core address.
  const t = byKey[K_TESTAVE];
  check(`${K_TESTAVE}: the bare-address PO (doc17, no printed city) IS elevated into cust(10)'s job — revenue $700.00, cost $150.00, margin $550.00`,
    t?.revenue === '700.00' && t?.cost === '150.00' && t?.marginDollars === '550.00', JSON.stringify(t));

  const um = Object.fromEntries(unmatched.map((u) => [u.poNumber ?? u.invoiceNumber, u]));
  check('PO-J3 (no job address anywhere, no customer link) is unmatched, never guessed into a group', 'PO-J3' in um && /no job address/.test(um['PO-J3'].reason));
  check('INV-J5 (a stored job_key below JOB_MATCH_CONFIDENCE, no other resolvable source) is unmatched, never linked on a low-confidence guess', 'INV-J5' in um && /too uncertain/.test(um['INV-J5'].reason));
  check('REVIEW FIX — PO-J9 (same bare "900 W Test Ave" core as doc17, but linked to a DIFFERENT customer entity, cust(11)) stays unmatched: no city on its own text, and the customer entity does not corroborate it', 'PO-J9' in um && /too uncertain/.test(um['PO-J9'].reason) && !(K_TESTAVE in byKey && byKey[K_TESTAVE].costDocs.some((d) => d.poNumber === 'PO-J9')));
  eq('exactly 3 unmatched documents shopwide (PO-J3, INV-J5, PO-J9)', unmatched.length, 3);
  check(`PO-J4 (verified, page-text address resolves fine) IS grouped for answering — the human-review guard blocks WRITES, not reading (${K_LOCKED})`, byKey[K_LOCKED]?.cost === '400.00');
}

/* ---------- 5. backfill: job_key from data already on disk, no model call ---------- */
{
  // doc9 already carries a (low-confidence) stored job_key, so it is not NULL and is not a
  // backfill candidate at all — that is intentional (see "eligible/remaining" note below).
  const preIds = [doc(3), doc(4), doc(6), doc(7), doc(8), doc(12), doc(13), doc(14), doc(15), doc(17), doc(18)];
  const before = (await lite.query('SELECT document_id, job_key FROM document_financials WHERE tenant_id = $1 AND job_key IS NULL', [tenId])).rows;
  check('before backfill: doc3/doc4/doc6/doc7/doc8 and the REVIEW FIX docs (12,13,14,15,17,18) all have no stored job_key yet', preIds.every((id) => before.some((r) => r.document_id === id)));

  const b1 = await B.runJobKeyBackfill(ctx, { limit: 200 });
  eq('backfill: 9 resolvable rows get a job_key populated (doc3,doc4,doc7,doc12,doc13,doc14,doc15,doc17,doc18); doc6 (no address anywhere) does not; doc8 (verified) and doc9 (already has a job_key) are never candidates', b1.updated, 9);
  check('backfill status: eligible counts every job-relevant document (18); remaining = the 2 that still have no job_key at all (doc6: no address anywhere; doc8: verified, never a candidate)', b1.eligible === 18 && b1.remaining === 2, JSON.stringify(b1));

  const after = (await lite.query('SELECT document_id, job_key, job_key_source FROM document_financials WHERE document_id = ANY($1::uuid[]) ORDER BY document_id', [preIds])).rows;
  const byId = Object.fromEntries(after.map((r) => [r.document_id, r]));
  eq(`doc3 & doc7 (Karen Abernathy invoices): job_key ${K_ELM} via customer_address`, [byId[doc(3)].job_key, byId[doc(3)].job_key_source, byId[doc(7)].job_key], [K_ELM, 'customer_address', K_ELM]);
  eq(`doc4 (PO, no customer link): job_key ${K_CACTUS} via a page-text regex read, no re-OCR, no model call`, [byId[doc(4)].job_key, byId[doc(4)].job_key_source], [K_CACTUS, 'page_text']);
  eq('doc8 (verified by a person): backfill never wrote to it', byId[doc(8)].job_key, null);
  eq(`REVIEW FIX — doc12/doc13 (same house+street, different printed city) get DIFFERENT stored keys: ${K_OAK_PHX} / ${K_OAK_GLB}`, [byId[doc(12)].job_key, byId[doc(13)].job_key], [K_OAK_PHX, K_OAK_GLB]);
  eq(`REVIEW FIX — doc14/doc15 (same street, different Apt) get DIFFERENT stored keys: ${K_ALMA1} / ${K_ALMA2}`, [byId[doc(14)].job_key, byId[doc(15)].job_key], [K_ALMA1, K_ALMA2]);
  eq('REVIEW FIX — doc17/doc18 (neither PO prints a city) both store the SAME bare core key; disambiguation happens at READ time via the customer entity (below), not by refusing to write', [byId[doc(17)].job_key, byId[doc(18)].job_key], [K_TESTAVE_BARE, K_TESTAVE_BARE]);

  const one = await withTenant(ctx, (db) => JC.backfillOneJobKey(db, doc(8)));
  eq('backfillOneJobKey on a verified row refuses explicitly (not silently skipped as "no address")', [one.updated, one.reason], [false, 'human_reviewed']);

  const b2 = await B.runJobKeyBackfill(ctx, { limit: 200 });
  eq('backfill is idempotent: a second run updates nothing further (doc6/doc8 still unresolved)', [b2.updated, b2.remaining], [0, 2]);

  // The bare stored keys from doc17/doc18 above still resolve CORRECTLY on the next read: doc17
  // elevates via cust(10), doc18 does not (different customer) — same outcome as section 4's
  // live (pre-backfill) computation, proving the elevation rule is independent of storage.
  const { jobs: jobsAfterBackfill, unmatched: unmatchedAfterBackfill } = await withTenant(ctx, (db) => JC.computeJobCosts(db));
  const byKeyAfter = Object.fromEntries(jobsAfterBackfill.map((j) => [j.jobKey, j]));
  check('after backfill: doc17 still elevates into cust(10)\'s job from its now-STORED bare key', byKeyAfter[K_TESTAVE]?.cost === '150.00', JSON.stringify(byKeyAfter[K_TESTAVE]));
  const umAfter = Object.fromEntries(unmatchedAfterBackfill.map((u) => [u.poNumber ?? u.invoiceNumber, u]));
  check('after backfill: PO-J9 (doc18, different customer) still stays unmatched from its now-STORED bare key', 'PO-J9' in umAfter && /too uncertain/.test(umAfter['PO-J9'].reason));
}

/* ---------- 6. deterministic job-costing answers, with citations ---------- */
const gate = (q) => G.answerMoneyQuestion({ withTenant, ctxArg: ctx, question: q, today: TODAY });
const text = (r) => r.data?.text ?? '';
{
  check('classify.js: job-costing phrasing is recognized as a financial question even with no invoice/quote/PO noun', ['what was our margin on the job at 248 Guadalupe Rd', 'gross margin by job', 'which job was least profitable', 'jobs where cost exceeded revenue', 'average margin this year'].every((q) => Classify.isFinancialQuestion(q)));

  const m1 = await gate('what was our margin on the job at 248 W Guadalupe Rd, Phoenix?');
  check('ANSWER job margin (address): 248-guadalupe — $1,200.00 revenue, $300.00 cost, $900.00 margin (75%), cited to BOTH the invoice and the PO', m1.handled && /\$1,200\.00/.test(text(m1)) && /\$300\.00/.test(text(m1)) && /\$900\.00/.test(text(m1)) && /75%/.test(text(m1))
    && m1.data.sources.some((s) => s.documentId === doc(1)) && m1.data.sources.some((s) => s.documentId === doc(2)), text(m1));

  const m2 = await gate('what is the margin on the job at 412 Elm St, Mesa?');
  check('ANSWER job margin (revenue only): says plainly no cost documents are linked, never reports a 100% margin', m2.handled && /\$800\.00/.test(text(m2)) && /no purchase order or vendor bill/i.test(text(m2)) && !/100%/.test(text(m2)), text(m2));

  const m3 = await gate('cost vs revenue for Donna Thornton');
  check('ANSWER cost vs revenue (customer name -> their on-file address -> the job): 17-cactus, -$450.00 margin (-225%), a real negative percent (never -100%)', m3.handled && /\$200\.00/.test(text(m3)) && /\$650\.00/.test(text(m3)) && /-\$450\.00/.test(text(m3)) && /-225%/.test(text(m3)), text(m3));

  const over = await gate('which jobs had cost exceed revenue?');
  check('ANSWER jobs over budget: only 17-cactus, with the actual overage amount', over.handled && /17-cactus|Cactus/.test(text(over)) && /\$450\.00/.test(text(over)) && !/Guadalupe/.test(text(over)), text(over));
  const overNone = await gate('which jobs had cost exceed revenue for a customer named zzyzx?');
  void overNone; // no such shape - not asserted, just guards the regex above doesn't crash on odd phrasing

  const most = await gate('which job was most profitable?');
  check('ANSWER most profitable job: 840-ellsworth (96.39%), not 248-guadalupe (75%) — a real ranking, not "the only one with both sides"', most.handled && /Ellsworth/.test(text(most)) && /96\.39%/.test(text(most)), text(most));
  const least = await gate('which job was least profitable?');
  check('ANSWER least profitable job: 17-cactus (-225%), and the revenue-only/unmatched jobs are excluded from ranking, not silently counted as 0%', least.handled && /Cactus/.test(text(least)) && /-225%/.test(text(least)) && /excluded/.test(text(least)), text(least));

  // 4 jobs now have both revenue and cost on file (the original 3 plus REVIEW FIX's K_TESTAVE,
  // $700 revenue / $150 cost / 78.57% margin): simple avg (75 - 225 + 96.39 + 78.57)/4 = 6.24%;
  // weighted = $6,340.00 margin / $7,640.00 revenue = 82.98%.
  const avg = await gate('what is our average margin this year?');
  check('ANSWER average margin: both a per-job simple average (6.24%) and a revenue-weighted overall figure (82.98%), the revenue-only/cost-only jobs explicitly excluded', avg.handled && /6\.24%/.test(text(avg)) && /82\.98%/.test(text(avg)) && /\$6,340\.00/.test(text(avg)) && /excluded/.test(text(avg)), text(avg));

  const byJob = await gate('gross margin by job');
  const byJobLabels = byJob.data?.facts?.map((f) => f.label).join(' | ') ?? '';
  check('ANSWER gross margin by job: lists all 10 matched jobs (facts, sorted by revenue) and names the unmatched documents in the summary rather than dropping them silently', byJob.handled && /Ellsworth/.test(byJobLabels) && /Guadalupe/.test(byJobLabels) && /Elm/.test(byJobLabels) && /Cactus/.test(byJobLabels) && /3 documents/.test(text(byJob)), byJobLabels + ' || ' + text(byJob));
  check('gross margin by job: every fact carries a citation (a number without a source is never acceptable here)', byJob.data.facts.every((f) => Array.isArray(f.sources)) && byJob.data.sources.length > 0);

  const noAddr = await gate('what was our margin on the job at 9999 Nowhere Ave, Nowhere?');
  check('ANSWER job margin for an address with nothing on file: an honest "no documents", not a false zero', noAddr.handled && /don't have any/.test(text(noAddr)) && !/\$0\.00/.test(text(noAddr)), text(noAddr));

  const allAnswers = [m1, m2, m3, over, most, least, avg, byJob];
  check('EVERY job-costing answer is well-formed with citations and no fabricated NaN/undefined/null amount', allAnswers.every((r) => r.data.kind === 'answer' && Array.isArray(r.data.facts) && Array.isArray(r.data.sources)) && allAnswers.every((r) => !/NaN|undefined function|"null"/.test(JSON.stringify(r.data))));
}

/* ---------- 6b. REVIEW FIX: currency filter (jobCosting.js's f.currency = 'USD' scoping) ---------- */
{
  // A EUR invoice linked to Amy Isaacson (the SAME customer/address as K_GUADALUPE) must never
  // silently inflate that job's revenue, and must be disclosed rather than dropped without a trace.
  await addDoc(19, { customerId: cust(1), docKind: 'invoice', currency: 'EUR', total: 300, balanceDue: 0, status: 'paid',
    invoiceNumber: 'INV-EUR1', invoiceDate: '2026-08-20', customerName: 'Amy Isaacson' });
  const { jobs, excludedCurrency } = await withTenant(ctx, (db) => JC.computeJobCosts(db));
  const byKey = Object.fromEntries(jobs.map((j) => [j.jobKey, j]));
  eq('REVIEW FIX — the EUR invoice is counted as excluded-for-currency, not silently summed or silently dropped', excludedCurrency, 1);
  eq(`REVIEW FIX — ${K_GUADALUPE}'s revenue stays $1,200.00 (the EUR invoice never joins it, even though it's the same customer/address)`, byKey[K_GUADALUPE]?.revenue, '1200.00');

  const m1eur = await gate('what was our margin on the job at 248 W Guadalupe Rd, Phoenix?');
  check('REVIEW FIX — the job margin answer discloses the excluded non-USD document', m1eur.handled && /\$1,200\.00/.test(text(m1eur)) && /1 document in another currency/i.test(text(m1eur)), text(m1eur));
}

/* ---------- 7. fallback WITHOUT migration 36 ---------- */
{
  await lite.query('ALTER TABLE document_financials DROP COLUMN job_key, DROP COLUMN job_key_source, DROP COLUMN job_confidence, DROP COLUMN job_raw');
  JC._resetJobCostingProbe();
  const hasCols = await withTenant(ctx, (db) => JC.jobCostingColumnsExist(db));
  check('columns dropped: jobCostingColumnsExist reports false', hasCols === false);
  const { jobs, hasJobColumns } = await withTenant(ctx, (db) => JC.computeJobCosts(db));
  check('hasJobColumns now false', hasJobColumns === false);
  const byKey = Object.fromEntries(jobs.map((j) => [j.jobKey, j]));
  eq(`WITHOUT migration 36: ${K_GUADALUPE} still computes correctly, purely from the customer's on-file address (the invoice) and a live page-text read (the PO)`,
    [byKey[K_GUADALUPE]?.revenue, byKey[K_GUADALUPE]?.cost, byKey[K_GUADALUPE]?.marginDollars], ['1200.00', '300.00', '900.00']);
  eq(`WITHOUT migration 36: ${K_CACTUS} (over budget) still computes the same`, [byKey[K_CACTUS]?.revenue, byKey[K_CACTUS]?.cost], ['200.00', '650.00']);
  const stillAnswers = await gate('what was our margin on the job at 248 W Guadalupe Rd, Phoenix?');
  check('WITHOUT migration 36: the same question still answers correctly through the money gate', stillAnswers.handled && /\$900\.00/.test(text(stillAnswers)), text(stillAnswers));
}

/* ---------- static checks ---------- */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json: verify:job-costing exists and is part of verify:all', pkg.scripts['verify:job-costing'] === 'node scripts/verify-job-costing.mjs' && /verify:job-costing/.test(pkg.scripts['verify:all']));
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile());
  eq('api/ top-level file count is unchanged (no new serverless function added for this feature)', apiFiles.length, 12);
  const srcs = ['jobKey', 'jobCosting', 'normalize', 'store', 'extract', 'answers', 'backfill', 'classify'].map((f) => fs.readFileSync(path.join(ROOT, `api/_lib/financials/${f}.js`), 'utf8')).join('\n');
  check('no job-costing source logs question text, names or amounts', !/console\.(log|error|warn)\([^)]*(question|customerName|jobRaw|address|total|amount)\b/i.test(srcs));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
