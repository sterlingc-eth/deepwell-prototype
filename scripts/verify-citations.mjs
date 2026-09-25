/**
 * Checks for "citations on EVERY answer" (api/_lib/citations/*, the records / recordsTotal /
 * recordsKind / basis contract, and its UI helpers in src/core/citations.ts).
 *
 * No network, no Anthropic key: the model is scripted and the database is a REAL Postgres (PGlite)
 * loaded from the actual M3-config/*.sql migrations and queried as the app's NOBYPASSRLS role, same
 * harness as scripts/verify-agent.mjs. The real /api/ask handler is called in-process (the
 * scorecard hook) for every deterministic answer kind.
 *
 *   npx tsx scripts/verify-citations.mjs
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
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
process.env.DONOVAN_AGENT = '0'; // the handler checks below must never reach a model
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY;

const logged = [];
const realLog = console.log;
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('{"')) { logged.push(a[0]); return; }
  realLog(...a);
};
const realErr = console.error;
console.error = () => {};

const C = await import('../api/_lib/citations/records.js');
const A = await import('../api/_lib/citations/analytics.js');
const UI = await import('../src/core/citations.ts');

/* ================================================================== 1. contract (pure) */
{
  const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => C.customerRecord({ id: `c${i}`, customer_name: `Cust ${i}`, service_address: `${i} Main` }, extra));
  const d = C.attachCitations({ kind: 'answer', text: 'x' }, { records: mk(500), total: 500, basis: 'Counted customers.', claimedCount: 500 });
  check('cap: 500 rows -> 200 records, recordsTotal stays 500', d.records.length === C.MAX_RECORDS && d.recordsTotal === 500 && d.recordsKind === 'basis');
  const g = C.attachCitations({ kind: 'answer' }, {
    records: [...mk(300, { group: 'Mesa' }), ...mk(5, { group: 'Gilbert' }).map((r, i) => ({ ...r, id: `g${i}` })), ...mk(3, { group: 'Unknown' }).map((r, i) => ({ ...r, id: `u${i}` }))],
    total: 308, basis: 'Grouped.',
  });
  check('cap keeps EVERY group represented (round-robin), not just the biggest', ['Mesa', 'Gilbert', 'Unknown'].every((k) => g.records.some((r) => r.group === k)) && g.records.length === 200);
  const before = C.citationStats.countMismatch;
  const bad = C.attachCitations({ kind: 'answer' }, { records: mk(3), total: 3, basis: 'Counted customers in Mesa.', claimedCount: 4 });
  check('count != recordsTotal: counted, and SAID in the basis (honesty over a tidy number)', C.citationStats.countMismatch === before + 1 && /figure stated is 4 but 3 matching/.test(bad.basis));
  check('a count mismatch logs a bare counter (no question text, no values)', logged.some((l) => /"citations":"count_mismatch"/.test(l) && !/Mesa|Cust/.test(l)));
  const ok = C.attachCitations({ kind: 'answer' }, { records: mk(3), total: 3, basis: 'Counted.', claimedCount: 3 });
  check('matching count: basis untouched', ok.basis === 'Counted.' && ok.recordsTotal === 3);
  const over = C.attachCitations({ kind: 'answer' }, { records: mk(5), total: 2, basis: 'x' });
  check('a producer can never list more records than recordsTotal (total is raised to the list)', over.recordsTotal === 5);
  check('makeRecord rejects a record with no id / an unknown type', C.makeRecord({ type: 'customer' }) === null && C.makeRecord({ type: 'spaceship', id: 'x' }) === null);
  const fin = C.finalizeCitations({ kind: 'answer', text: 't', facts: [{ label: 'Phone', value: '1', entityId: 'e1', sources: [{ documentId: 'd1', location: { page: 2 } }] }], sources: [{ documentId: 'd1', location: { page: 2 } }] });
  check('finalize: derives records from fact entityIds + cited pages and defaults a basis when a producer set none', fin.records.length === 2 && fin.records.some((r) => r.type === 'document' && r.page === 2) && typeof fin.basis === 'string' && fin.basis.length > 10);
  const na = C.finalizeCitations({ kind: 'no-answer', text: 'n', facts: [], sources: [] });
  check('finalize: even a bare no-answer states what it searched', Array.isArray(na.records) && /Searched/.test(na.basis));
  const twice = JSON.stringify(C.finalizeCitations(JSON.parse(JSON.stringify(fin))));
  check('finalize is idempotent', twice === JSON.stringify(fin));
  check('finalize leaves non-answer bodies alone', C.finalizeCitations({ error: 'x' }).records === undefined);

  // TEAM K (2026-09-25, R5_FAILS.md "several right answers had no citation"): a production counter,
  // never the question or answer text, fires whenever a real answer still ends up with zero records
  // after finalize's own best-effort derivation - the signal an operator needs to catch a producer
  // that silently stopped citing, without logging anything sensitive.
  const beforeUncited = C.citationStats.uncited;
  const bare = C.finalizeCitations({ kind: 'answer', text: 'Yes, 3 of them.', facts: [] });
  check('uncited_answer counter: a real answer with nothing to derive a record from is counted and logged (bare counter, no text)',
    C.citationStats.uncited === beforeUncited + 1 && bare.records.length === 0
    && logged.some((l) => /"citations":"uncited_answer"/.test(l) && !/Yes, 3 of them/.test(l)));
  const stillUncited = C.citationStats.uncited;
  C.finalizeCitations({ kind: 'no-answer', text: 'Nothing found.', facts: [] });
  check('uncited_answer counter: a no-answer never counts (nothing to cite by definition)', C.citationStats.uncited === stillUncited);
  const stillUncited2 = C.citationStats.uncited;
  C.finalizeCitations({ kind: 'answer', text: 'x', facts: [], records: [], recordsTotal: 0, recordsKind: 'searched', basis: 'Searched everything; nothing matched.' });
  check('uncited_answer counter: an honest "searched, found nothing" zero never counts either', C.citationStats.uncited === stillUncited2);
  const withRecord = C.finalizeCitations({ kind: 'answer', text: 'x', facts: [{ label: 'A', value: '1', entityId: 'e1', sources: [] }] });
  check('uncited_answer counter: an answer finalize CAN derive a record from is never counted', C.citationStats.uncited === stillUncited2 && withRecord.records.length === 1);

  const basis = (plan, o) => A.analyticsBasis(plan, o);
  check('basis: "Counted customers whose service address is in Mesa, AZ"-style sentence', /^Counted customers whose service address is in Mesa and whose service address is in AZ\.$/.test(basis({ entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }, { field: 'state', op: 'eq', value: 'AZ' }] })) || /^Counted customers whose service address is in Mesa/.test(basis({ entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }] })));
  check('basis: documents by month say which date they are dated by', /by service date/.test(basis({ entity: 'documents', op: 'groupBy', groupBy: 'month', filters: [] })) && /by upload date/.test(basis({ entity: 'documents', op: 'count', dateBasis: 'uploaded', filters: [] }, { monthLabel: 'September 2026' })) && /1 future-dated service record/.test(basis({ entity: 'serviceVisits', op: 'count', filters: [] }, { futureVisitCount: 1 })));
}

/* ================================================================== 2. UI helpers (pure) */
{
  const recs = [
    { type: 'customer', id: 'c1', label: 'Karen Abernathy', sublabel: 'Mesa', group: 'Mesa' },
    { type: 'customer', id: 'c2', label: 'Bill Whitmore', sublabel: 'Mesa', group: 'Mesa' },
    { type: 'customer', id: 'c3', label: 'Plaza Dental', sublabel: 'Gilbert', group: 'Gilbert' },
    { type: 'unit', id: 'u1', label: 'Trane XR14', customerId: 'c1', group: 'Mesa' },
    { type: 'invoice', id: 'd1', documentId: 'd1', label: 'Invoice #7', page: 2 },
  ];
  eq('ui: groups in first-seen order', UI.recordGroups(recs), ['Mesa', 'Gilbert']);
  eq('ui: search filters label/sublabel/group case-insensitively', UI.filterRecords(recs, 'whit', null).map((r) => r.id), ['c2']);
  eq('ui: group filter (a clicked breakdown row) narrows the list', UI.filterRecords(recs, '', 'Gilbert').map((r) => r.id), ['c3']);
  eq('ui: search + group combine', UI.filterRecords(recs, 'karen', 'Gilbert').length, 0);
  eq('ui: customer record opens the customer profile', UI.recordTarget(recs[0]), { kind: 'customer', ref: 'c1' });
  eq('ui: unit opens its customer', UI.recordTarget(recs[3]), { kind: 'customer', ref: 'c1' });
  eq('ui: unit with no customer falls back to the entity', UI.recordTarget({ type: 'unit', id: 'u9', label: 'x' }), { kind: 'entity', id: 'u9' });
  eq('ui: invoice opens the DocumentPreview at the cited page', UI.recordTarget(recs[4]), { kind: 'document', documentId: 'd1', page: 2 });
  eq('ui: heading says what it is based on', UI.recordsHeading({ records: recs.slice(0, 3), recordsTotal: 19, recordsKind: 'basis' }), 'Based on 19 customers');
  eq('ui: honest-zero heading says searched', UI.recordsHeading({ records: [{ type: 'document', id: 'd', label: 'x' }], recordsTotal: 6, recordsKind: 'searched' }), 'Searched 6 documents');
  const n = UI.normalizeCitations({ records: [{ type: 'customer', id: 'a', label: 'A' }, { type: 'bogus', id: 'b' }, null, { type: 'unit' }], recordsTotal: 9, basis: '  how  ' });
  check('ui: normalizeCitations drops malformed rows, keeps recordsTotal and trims basis', n.records.length === 1 && n.recordsTotal === 9 && n.basis === 'how');
  check('ui: the panel is hidden when it would only repeat the Sources list', UI.showRecordsPanel({ records: [{ type: 'document', id: 'd1', label: 'x' }], sources: [{ documentId: 'd1', location: {} }], kind: 'answer' }) === false && UI.showRecordsPanel({ records: recs, sources: [], kind: 'answer' }) === true);

  // Owner report (2026-09-25): a two-sentence answer must split into one plain headline + a muted
  // secondary line, never render as one giant confusing claim.
  eq('ui: splitAnswerHeadline splits at the first sentence', UI.splitAnswerHeadline('13 customers have equipment currently under warranty (active or expiring status). 14 in all.'), { headline: '13 customers have equipment currently under warranty (active or expiring status).', secondary: '14 in all.' });
  eq('ui: splitAnswerHeadline leaves a single sentence alone', UI.splitAnswerHeadline('You have 6 customers.'), { headline: 'You have 6 customers.', secondary: null });
  eq('ui: splitAnswerHeadline never splits inside a dollar amount', UI.splitAnswerHeadline('The total is $1,250.00 across 3 invoices.'), { headline: 'The total is $1,250.00 across 3 invoices.', secondary: null });
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const k of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[k] = (await import(`@electric-sql/pglite/contrib/${k}`))[k];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* harness order quirks: same as verify-agent */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* */ }
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
const { runDonovanAgent } = await import('../api/_lib/agent/loop.js');
const { createToolbox } = await import('../api/_lib/agent/tools.js');
const { executeAnalyticsPlan } = await import('../api/_lib/routes/analytics.js');
const { answerMoneyQuestion } = await import('../api/_lib/financials/moneyGate.js');
const { askViaHandler } = await import('../api/_lib/scorecard/askCall.js');
const askMod = await import('../api/ask.js');

const TODAY = '2026-09-23';
const ctxA = { tenantKey: 'org_cite_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_cite_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed(t, tenantId, world) {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address, phone: c.phone ?? null, email: c.email ?? null }, { number: `C-0000${c.n}` });
  for (const e of world.equipment) await ent(uid(t, 'e', e.n), 'equipment', { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: e.type, installation_date: e.installed, service_address: e.address }, { customerId: uid(t, 'c', e.customer) });
  for (const d of world.docs) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [uid(t, 'd', d.n), tenantId, d.file, d.type, `${t}-hash-${d.n}`, d.stage ?? 'verified']);
    for (const link of d.links ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', d.n), link]);
    for (const x of d.facts ?? []) await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenantId, uid(t, 'd', d.n), x.entity ?? null, x.key, x.value]);
    for (const [i, text] of (d.pages ?? []).entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid(t, 'd', d.n), tenantId, i + 1, text]);
    if (d.fin) {
      await lite.query(`INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, invoice_number, invoice_date, total, status, customer_name, confidence, evidence)
                        VALUES ($1,$2,'invoice','receivable',$3,$4,$5,$6,$7,0.95,$8::jsonb)`,
        [tenantId, uid(t, 'd', d.n), d.fin.no, d.fin.date, d.fin.total, d.fin.status ?? 'paid', d.fin.customer, JSON.stringify({ total: { page: 2 } })]);
    }
  }
}
const worldA = {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201', phone: '(480) 555-0148' },
    { n: 2, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 3, name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234' },
    { n: 4, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701' },
    { n: 5, name: 'Old Timer', address: '5 Oak Rd, Phoenix, AZ 85001' },
    { n: 6, name: 'Mesa Sixth Customer', address: '9 Palm Dr, Mesa, AZ 85202' },
  ],
  equipment: [
    { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'TR-1001', type: 'condenser', installed: '2020-05-01', address: '412 Elm St, Mesa, AZ 85201' },
    { n: 2, customer: 2, mfr: 'Goodman', model: 'GSX140361K', serial: 'GD-2002', type: 'condenser', installed: '2016-10-15', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 3, customer: 3, mfr: 'Trane', model: '24ACC636', serial: 'CR-3003', type: 'condenser', installed: '2014-01-01', address: '2210 E Main St, Gilbert, AZ 85234' },
    { n: 5, customer: 1, mfr: 'Trane', model: 'S9V2', serial: 'TR-1005', type: 'furnace', installed: '2021-01-01', address: '412 Elm St, Mesa, AZ 85201' },
  ],
  docs: [
    { n: 1, file: 'karen-service-sep.pdf', type: 'service-ticket', links: [uid('a', 'c', 1)], facts: [{ key: 'service_date', value: '2026-09-10' }], pages: ['Service ticket Karen Abernathy 412 Elm St'] },
    { n: 2, file: 'karen-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 1)] },
    { n: 3, file: 'whitmore-service-2025.pdf', type: 'service-ticket', links: [uid('a', 'c', 2)], facts: [{ key: 'service_date', value: '2025-11-02' }] },
    // Team A: a service date AFTER today (scheduled / typo) is mentioned but never counted or cited as a visit
    { n: 4, file: 'whitmore-future.pdf', type: 'service-ticket', links: [uid('a', 'c', 2)], facts: [{ key: 'service_date', value: '2027-03-01' }] },
    { n: 6, file: 'thornton-permit.pdf', type: 'permit', links: [uid('a', 'c', 4)], pages: ['City of Tucson building permit BP-2024-08841'] },
    { n: 20, file: 'karen-inv-1001.pdf', type: 'invoice', links: [uid('a', 'c', 1)], fin: { no: 'INV-1001', date: '2026-08-01', total: '500.00', customer: 'Karen Abernathy' } },
    { n: 21, file: 'karen-inv-1002.pdf', type: 'invoice', links: [uid('a', 'c', 1)], fin: { no: 'INV-1002', date: '2026-08-12', total: '1240.50', status: 'unpaid', customer: 'Karen Abernathy' } },
    { n: 22, file: 'whitmore-inv-2001.pdf', type: 'invoice', links: [uid('a', 'c', 2)], fin: { no: 'INV-2001', date: '2026-07-02', total: '300.00', customer: 'Bill Whitmore' } },
    // 230 bulk documents so the 200-record cap is exercised with a real table
    ...Array.from({ length: 230 }, (_, i) => ({ n: 100 + i, file: `bulk-${i}.pdf`, type: 'other' })),
  ],
};
const worldB = {
  customers: [{ n: 1, name: 'Zed Competitor', address: '1 Secret Way, Reno, NV 89501' }, { n: 2, name: 'Other Tenant Two', address: '2 Secret Way, Reno, NV 89501' }],
  equipment: [{ n: 1, customer: 1, mfr: 'York', model: 'B-MODEL', serial: 'YK-9', type: 'condenser', installed: '2022-01-01', address: '1 Secret Way, Reno, NV 89501' }],
  docs: [
    { n: 1, file: 'b-secret-permit.pdf', type: 'permit', links: [uid('b', 'c', 1)], pages: ['Secret permit Zed Competitor'] },
    { n: 2, file: 'b-secret-invoice.pdf', type: 'invoice', links: [uid('b', 'c', 1)], fin: { no: 'B-9', date: '2026-08-01', total: '99999.00', customer: 'Zed Competitor' } },
  ],
};
await seed('a', tenA, worldA);
await seed('b', tenB, worldB);
const idsOfB = new Set((await lite.query('SELECT id FROM entities WHERE tenant_id = $1 UNION SELECT id FROM documents WHERE tenant_id = $1', [tenB])).rows.map((r) => r.id));
const isTenantA = (id) => typeof id === 'string' && !idsOfB.has(id);
const noTenantB = (data) => !JSON.stringify(data).match(/Zed|Secret|Reno|Other Tenant|B-9|99,999/) && (data.records ?? []).every((r) => isTenantA(r.id) && (!r.documentId || isTenantA(r.documentId)) && (!r.customerId || isTenantA(r.customerId)));
const nDocsA = worldA.docs.length;

const ask = (question, ctx = ctxA) => askViaHandler({ handler: askMod.default, auth: { tenantId: ctx.tenantKey, orgId: ctx.tenantKey, userId: null }, question, today: TODAY });
const contractOk = (d) => d && Array.isArray(d.records) && Number.isFinite(d.recordsTotal) && d.recordsTotal >= d.records.length && d.records.length <= C.MAX_RECORDS
  && typeof d.basis === 'string' && d.basis.length > 8 && ['basis', 'searched'].includes(d.recordsKind)
  && d.records.every((r) => ['customer', 'unit', 'document', 'invoice'].includes(r.type) && typeof r.id === 'string' && typeof r.label === 'string' && r.label);

/* ================================================================== 3. meta-router (no model, DB only) */
{
  const r = (await ask('how many customers do we have')).data;
  check('meta count: "You have 6 customers." carries 6 customer records', r.text === 'You have 6 customers.' && r.recordsTotal === 6 && r.records.length === 6 && r.records.every((x) => x.type === 'customer' && x.label) && contractOk(r), JSON.stringify(r).slice(0, 300));
  check('meta count: the number and the rows come from ONE query and agree (counts == recordsTotal), tenant B never appears', r.facts[0].value === String(r.recordsTotal) && noTenantB(r));
  const d = (await ask('how many documents do we have')).data;
  check(`meta count of ${nDocsA} documents: records CAPPED at 200 but recordsTotal is the true ${nDocsA}`, d.recordsTotal === nDocsA && d.records.length === 200 && d.facts[0].value === String(nDocsA) && contractOk(d), `${d.recordsTotal}/${d.records.length}`);
  const inv = (await ask('how many invoices do we have')).data;
  check('meta count of invoices: 3 invoice records (type invoice), each openable by documentId', inv.recordsTotal === 3 && inv.records.every((x) => x.type === 'invoice' && x.documentId) && noTenantB(inv));
  const eqp = (await ask('how many units do we have')).data;
  check('meta count of equipment: unit records carry their customerId', eqp.recordsTotal === 4 && eqp.records.every((x) => x.type === 'unit' && x.customerId));
  const lc = (await ask('list all customers')).data;
  check('meta list customers: each fact links AND each is a record; total 6', lc.records.length === 6 && lc.facts.every((f) => f.entityId) && lc.recordsTotal === 6 && /Listed/.test(lc.basis));
  const ld = (await ask('list all documents')).data;
  check('meta list documents: 200 records of a true total, sources keep their own 50 cap', ld.records.length === 200 && ld.recordsTotal === nDocsA && ld.sources.length === 50);
  const ty = (await ask('what document types do we have')).data;
  const sumByGroup = {};
  for (const x of ty.records) sumByGroup[x.group] = (sumByGroup[x.group] ?? 0) + 1;
  check('meta breakdown by document type: every group key on records matches a fact label; counts add to the total', ty.facts.every((f) => sumByGroup[f.label] !== undefined) && ty.recordsTotal === nDocsA && contractOk(ty), JSON.stringify(ty.facts));
  const ev = (await ask('show everything for C-00001')).data;
  check('meta "everything for C-00001": documents + units as records, count matches', ev.records.some((x) => x.type === 'unit') && ev.records.some((x) => x.type === 'invoice' || x.type === 'document') && ev.recordsTotal === ev.records.length && noTenantB(ev));
  const nf = (await ask('show everything for C-00099')).data;
  check('meta unknown customer: honest zero says what was looked up', nf.kind === 'no-answer' && /C-00099/.test(nf.basis) && nf.recordsKind === 'searched');
  const imp = (await ask('please delete the whitmore invoice')).data;
  check('meta imperative: states it is a how-to, not from records', imp.kind === 'no-answer' && /not something drawn from your records/.test(imp.basis));
}

/* ================================================================== 4. contact / doc lookup / fast path */
{
  const p = (await ask("What's the phone number on file for Karen Abernathy?")).data;
  check('contact card: cites Karen\'s customer record (label + address), with a basis sentence', contractOk(p) && p.records.some((x) => x.type === 'customer' && /Karen Abernathy/.test(x.label) && /Mesa/.test(x.sublabel ?? '')) && /customer record/.test(p.basis) && noTenantB(p), JSON.stringify(p).slice(0, 400));
  const dl = (await ask('do we have a maintenance agreement on file for Karen Abernathy')).data;
  check('doc lookup: the maintenance agreement is a clickable document record + stated scope', contractOk(dl) && dl.records.some((x) => x.type === 'document' && /maintenance/i.test(x.label)) && /linked to Karen Abernathy/.test(dl.basis) && dl.recordsTotal === dl.records.length, JSON.stringify(dl).slice(0, 400));
  const dz = (await ask('do we have a permit on file for Karen Abernathy')).data;
  check('doc lookup honest zero: cites the documents SEARCHED ("Searched N documents ... none is a permit")', dz.recordsKind === 'searched' && /^Searched all \d+ documents? linked to Karen Abernathy; none is a permit/i.test(dz.basis) && dz.records.length === dz.recordsTotal && dz.recordsTotal >= 3, JSON.stringify({ b: dz.basis, n: dz.records.length }));
  const nf = (await ask('do we have a maintenance agreement on file for Nobody Atall')).data;
  if (nf) check('doc lookup: unknown customer -> honest zero states what was searched', contractOk(nf) && /Searched/.test(nf.basis) || nf.kind === 'no-answer', JSON.stringify(nf).slice(0, 200));
  const fp = (await ask('what equipment does Karen Abernathy have')).data;
  check('fast path / contact equipment list: unit records for Karen\'s 2 units', contractOk(fp) && fp.records.filter((x) => x.type === 'unit').length === 2, JSON.stringify(fp).slice(0, 300));
  const vis = (await ask('last service for Karen Abernathy')).data;
  check('last visit: the visit documents ARE the records; "Visits on file" == recordsTotal', contractOk(vis) && vis.records.length >= 1 && vis.records.every((x) => x.type === 'document') && String(vis.recordsTotal) === vis.facts.find((f) => /Visits on file/.test(f.label))?.value && /service dates found on the 1 document/.test(vis.basis), JSON.stringify(vis).slice(0, 300));
}

/* ================================================================== 5. honest-zero retrieval + generic no-answer */
{
  const hz = (await ask('do we have anything about a compressor replacement for Donna Thornton')).data;
  check('honest zero (single record): "Searched N documents ... none mention ..." with the searched documents listed', hz.kind === 'no-answer' && hz.recordsKind === 'searched' && /^Searched \d+ documents? on file for Donna Thornton — none mention compressor replacement\./.test(hz.basis) && hz.records.length === hz.recordsTotal && hz.records.every((x) => x.type === 'document' || x.type === 'invoice'), JSON.stringify({ t: hz.text, b: hz.basis, n: hz.records.length }));
  const gz = (await ask('what is the airspeed velocity of a laden swallow')).data;
  check(`generic no-answer: states the whole library was searched (${nDocsA} documents)`, gz.kind === 'no-answer' && gz.recordsKind === 'searched' && new RegExp(`all ${nDocsA} documents`).test(gz.basis), gz.basis);
}

/* ================================================================== 6. analytics executor: records ARE the counted rows */
const plan = (p) => withTenant(ctxA, (db) => executeAnalyticsPlan(db, { filters: [], ...p }, { today: TODAY }));
{
  const cnt = await plan({ entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }] });
  const n = Number(cnt.facts[0].value);
  check('analytics count "customers in Mesa": the stated number == recordsTotal == the rows listed (3), all customers', n === 3 && cnt.recordsTotal === 3 && cnt.records.length === 3 && cnt.records.every((x) => x.type === 'customer') && contractOk(cnt), JSON.stringify(cnt).slice(0, 300));
  check('analytics count: basis states how it was computed ("Counted customers whose service address is in Mesa")', /^Counted customers whose service address is in Mesa\.$/.test(cnt.basis), cnt.basis);
  check('analytics count: tenant B never appears', noTenantB(cnt));
  const grp = await plan({ entity: 'customers', op: 'groupBy', groupBy: 'city' });
  const per = {};
  for (const x of grp.records) per[x.group] = (per[x.group] ?? 0) + 1;
  check('analytics breakdown by city: EVERY group carries its key; per-group record counts == the counts stated', grp.facts.every((f) => per[f.label] === Number(f.value)) && grp.recordsTotal === grp.facts.reduce((s, f) => s + Number(f.value), 0) && /grouped by city/.test(grp.basis), JSON.stringify({ per, f: grp.facts }));
  const lst = await plan({ entity: 'customers', op: 'list', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  check('analytics list "customers with Trane units": customer records, ids resolve to customers, total matches the list text', lst.records.every((x) => x.type === 'customer') && lst.recordsTotal === lst.records.length && new RegExp(`^${lst.recordsTotal} customers`).test(lst.text) && /brand Trane/.test(lst.basis), JSON.stringify(lst).slice(0, 300));
  const eqc = await plan({ entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  check('analytics equipment count: unit records (customerId for navigation)', eqc.recordsTotal === 3 && eqc.records.every((x) => x.type === 'unit' && x.customerId));
  const docs = await plan({ entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }] });
  check('analytics documents count by type: invoice records open the document', docs.recordsTotal === 3 && docs.records.every((x) => x.type === 'invoice' && x.documentId), JSON.stringify(docs).slice(0, 240));
  const big = await plan({ entity: 'documents', op: 'count' });
  check(`analytics cap: ${nDocsA} documents -> 200 records, recordsTotal ${nDocsA} == the stated count`, big.records.length === 200 && big.recordsTotal === nDocsA && big.facts[0].value === String(nDocsA), `${big.records.length}/${big.recordsTotal}`);
  const zero = await plan({ entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Reno' }] });
  check('analytics honest zero (Reno exists only for tenant B): cites the 6 customers SEARCHED, never tenant B', zero.recordsKind === 'searched' && zero.recordsTotal === 6 && /^Searched all 6 customers on file for ones whose service address is in Reno; none found\./.test(zero.basis) && zero.records.every((x) => isTenantA(x.id)), zero.basis);
  const top = await plan({ entity: 'customers', op: 'list', sortBy: 'equipmentCount' });
  check('analytics ranking: customer records + "Ranked customers by ..." basis', top.records.length > 0 && top.records.every((x) => x.type === 'customer') && /^Ranked customers by/.test(top.basis));
}

/* ================================================================== 7. financial answers */
{
  const gate = (q, ctx = ctxA) => answerMoneyQuestion({ withTenant, ctxArg: ctx, question: q, today: TODAY });
  const inv = await gate('what have we invoiced this year');
  const d = inv.data;
  check('financial total: records are the invoices summed (3) at the page the total is printed; number == recordsTotal', inv.handled && d.recordsTotal === 3 && d.records.length === 3 && d.records.every((x) => x.type === 'invoice' && x.page === 2) && /\$2,040\.50/.test(d.text) && contractOk(d) && /Summed the printed totals of 3 invoices/.test(d.basis), JSON.stringify(d).slice(0, 400));
  check('financial total: tenant B\'s $99,999 invoice never appears', noTenantB(d));
  const open = await gate('who owes us money');
  check('financial open receivables: the unpaid invoice is the record, with the amount still owed', open.handled && open.data.records.length === 1 && /1,240\.50/.test(open.data.records[0].sublabel) && contractOk(open.data), JSON.stringify(open.data).slice(0, 300));
  const mon = await gate('revenue by month');
  const gm = {};
  for (const x of mon.data.records ?? []) gm[x.group] = (gm[x.group] ?? 0) + 1;
  check('financial revenue by month: every month row has records carrying that month as group key', mon.handled && mon.data.facts.every((f) => gm[f.label] >= 1) && contractOk(mon.data), JSON.stringify({ gm, f: mon.data.facts.map((f) => f.label) }));
  const none = await gate('what did we spend with ferguson');
  if (none.handled) check('financial honest zero cites what was searched', none.data.recordsKind === 'searched' && /Searched/.test(none.data.basis));

  // TEAM K (2026-09-25, R5_FAILS.md "citations everywhere"): every producer's representative answer
  // carries records/sources unless it is an honest zero (recordsKind 'searched', or a no-answer) -
  // exercised here over the newest financial intents (document counts, quotes total, PO superlative,
  // customer paid-up), each against the same seeded fixture used by every other check in this file.
  const citedOrHonestZero = (d) => Boolean(d) && (d.records.length > 0 || d.recordsKind === 'searched' || d.kind === 'no-answer');
  const docCount = await gate('How many invoices do we have on file?');
  check('financial document count: cites the invoices counted', docCount.handled && citedOrHonestZero(docCount.data) && docCount.data.records.length === 3, JSON.stringify(docCount.data).slice(0, 300));
  const custCount = await gate('How many customers have we invoiced?');
  check('financial customers-invoiced count: cites the customers, not a bare number', custCount.handled && citedOrHonestZero(custCount.data) && custCount.data.records.length === 2, JSON.stringify(custCount.data).slice(0, 300));
  const avgQuote = await gate("What's the average quote amount?");
  check('financial average quote (none on file): an honest zero, not a fabricated average', avgQuote.handled && citedOrHonestZero(avgQuote.data) && avgQuote.data.recordsKind === 'searched', JSON.stringify(avgQuote.data).slice(0, 300));
  const bigPo = await gate("What's our biggest purchase order?");
  check('financial biggest PO (none on file): an honest zero, not an invented figure', bigPo.handled && citedOrHonestZero(bigPo.data) && bigPo.data.recordsKind === 'searched', JSON.stringify(bigPo.data).slice(0, 300));
  const paidUp = await gate('Is Karen Abernathy all paid up?');
  check('financial "is X paid up": cites her invoices (not a bare yes/no)', paidUp.handled && citedOrHonestZero(paidUp.data) && paidUp.data.records.length >= 1 && /No —/.test(paidUp.data.text), JSON.stringify(paidUp.data).slice(0, 300));
}

/* ================================================================== 8. agent: run_query row identities */
let toolUseCounter = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolUseCounter}`, name, input });
const lastResult = (messages) => { const b = messages[messages.length - 1].content.find((x) => x.type === 'tool_result'); return b ? b.content : null; };
const scripted = (turns) => { let i = 0; return async (req) => { const t = turns[Math.min(i++, turns.length - 1)]; const out = typeof t === 'function' ? t(req.messages, req) : t; return { content: out, usage: { input_tokens: 900, output_tokens: 90 }, stop_reason: 'tool_use' }; }; };
const run = (question, callModel) => runDonovanAgent({ withTenant, ctxArg: ctxA, question, today: TODAY, callModel, env: { DONOVAN_ESCALATION: '0' } });
{
  const model = scripted([
    () => [tu('run_query', { purpose: 'customers in Mesa', sql: "SELECT customer_id, name, city, count(*) OVER () AS total_count FROM customers WHERE city = 'Mesa' ORDER BY name" })],
    (m) => { const p = JSON.parse(lastResult(m)); return [tu('answer', { status: 'answered', text: `You have ${p.rowCount} customers in Mesa.`, facts: [{ label: 'Customers in Mesa', value: String(p.rowCount) }] })]; },
  ]);
  const r = await run('how many customers are in Mesa', model);
  const d = r.data;
  check('agent run_query answer: records are the customers the SQL returned (3), recordsTotal == the stated 3', r.handled && d.recordsTotal === 3 && d.records.length === 3 && d.records.every((x) => x.type === 'customer' && isTenantA(x.id)) && d.records.some((x) => x.label === 'Karen Abernathy') && contractOk(d), JSON.stringify(d).slice(0, 400));
  check('agent: aggregates keep the unsourced shape (sources stay [] - records are separate)', d.sources.length === 0 && d.facts.every((f) => f.sources.length === 0));
  check('agent: basis is deterministic and names the views + purpose', /Computed from 3 matching records returned by a read-only query over your customer records \(customers in Mesa\)/.test(d.basis), d.basis);
  check('agent: tenant B never appears', noTenantB(d));
}
{
  // Owner report (2026-09-25): the model's own `basis` echoed the SQL schema it was shown
  // ("Counted distinct customer_id from equipment where warranty_current = true.") instead of plain
  // English. Even though every number in it is real evidence (so the digit-grounding check alone
  // would accept it), it must still be rejected as jargon and replaced with the deterministic,
  // always-human queryBasis() sentence.
  const model = scripted([
    () => [tu('run_query', { purpose: 'customers in Mesa', sql: "SELECT customer_id, name, city, count(*) OVER () AS total_count FROM customers WHERE city = 'Mesa' ORDER BY name" })],
    (m) => { const p = JSON.parse(lastResult(m)); return [tu('answer', { status: 'answered', text: `You have ${p.rowCount} customers in Mesa.`, basis: 'Counted distinct customer_id from customers where city_name = true.', facts: [{ label: 'Customers in Mesa', value: String(p.rowCount) }] })]; },
  ]);
  const r = await run('how many customers are in Mesa', model);
  check('agent: a SQL-jargon model basis is rejected for the deterministic, human sentence', /Computed from 3 matching records returned by a read-only query over your customer records/.test(r.data.basis) && !/customer_id|city_name/.test(r.data.basis), r.data.basis);
}
{
  // breakdown: group_key is carried per record
  const model = scripted([
    () => [tu('run_query', { purpose: 'customers by city', sql: 'SELECT customer_id, name, city AS group_key, count(*) OVER (PARTITION BY city) AS city_count FROM customers ORDER BY city, name' })],
    () => [tu('answer', { status: 'answered', text: 'You have 6 customers across 4 cities: Mesa 3, Gilbert 1, Tucson 1, Phoenix 1.', facts: [{ label: 'Mesa', value: '3' }, { label: 'Gilbert', value: '1' }, { label: 'Tucson', value: '1' }, { label: 'Phoenix', value: '1' }] })],
  ]);
  const r = await run('customers by city', model);
  const per = {};
  for (const x of r.data?.records ?? []) per[x.group] = (per[x.group] ?? 0) + 1;
  check('agent breakdown: records carry group_key so the UI can filter', r.handled && per.Mesa === 3 && per.Gilbert === 1 && per.Tucson === 1 && r.data.recordsTotal === 6, JSON.stringify({ per, r: r.reason, d: r.data && { t: r.data.text, b: r.data.basis, n: r.data.records?.length } }));
}
{
  // a bare count(*) has no ids: say so honestly instead of pretending
  const model = scripted([
    () => [tu('run_query', { purpose: 'count customers', sql: 'SELECT count(*) AS n FROM customers' })],
    () => [tu('answer', { status: 'answered', text: 'You have 6 customers.', facts: [{ label: 'Customers', value: '6' }] })],
  ]);
  const r = await run('how many customers', model);
  check('agent count with no id columns: no invented records; basis says the query returned totals only', r.handled && r.data.records.length === 0 && /returned totals only/.test(r.data.basis) && contractOk(r.data), JSON.stringify(r.data).slice(0, 300));
}
{
  // documents: the document ids returned are cited as records (invoice typed) at the printed page
  const model = scripted([
    () => [tu('run_query', { purpose: 'invoices summed', sql: "SELECT document_id, invoice_number, total, customer_name, total_page FROM financials WHERE doc_kind = 'invoice' AND direction = 'receivable' ORDER BY invoice_number" })],
    () => [tu('answer', { status: 'answered', text: 'You have 3 invoices.', facts: [{ label: 'Invoices', value: '3' }] })],
  ]);
  const r = await run('list our invoices', model);
  check('agent over the financials view: invoice records with the printed page, tenant B\'s invoice absent', r.handled && r.data.records.length === 3 && r.data.records.every((x) => x.type === 'invoice' && x.page === 2) && noTenantB(r.data), JSON.stringify(r.data).slice(0, 300));
}
{
  // honest zero from a customer-scoped search: cites the documents actually searched
  const model = scripted([
    () => [tu('search_documents', { query: 'compressor', customerId: uid('a', 'c', 1) })],
    () => [tu('answer', { status: 'none_found', text: 'Nothing mentions a compressor.' })],
  ]);
  const r = await run('did anyone replace the compressor for Karen Abernathy', model);
  check('agent honest zero: "Searched N documents linked to Karen Abernathy for “compressor”" + those documents as records', r.handled && r.data.recordsKind === 'searched' && /^Searched 4 documents linked to Karen Abernathy for “compressor” — none mention it\./.test(r.data.basis) && r.data.records.length === 4 && r.data.recordsTotal === 4, JSON.stringify({ b: r.data?.basis, n: r.data?.records?.length }));
}
{
  // ids the model saw but the tenant does not own can never become records (tenant B document id in SQL result is impossible; direct capture guard)
  const tb = createToolbox({ withTenant, ctxArg: ctxA, today: TODAY });
  const res = await tb.execute('run_query', { purpose: 'x', sql: "SELECT document_id FROM documents_v WHERE filename LIKE 'b-secret%'" });
  check('agent: tenant A cannot select tenant B rows, so no identity can be captured for them', res.ok && res.rowCount === 0 && !(tb.ledger.identityQueries ?? []).length);
}

/* ================================================================== 8b. Team A producers (deterministic router, comparison, maintenance, notes) */
{
  const { countCitations } = await import('../api/_lib/scorecard/compare.js');
  const cited = (d) => countCitations(d) > 0; // Team B's coverage check accepts `records`
  const ls = (await ask('when did we last service the unit at 88 Whitmore Ave')).data;
  check('history last-service: the visit documents behind the date are records; the future-dated one is mentioned, not cited', contractOk(ls) && ls.recordsKind === 'basis' && ls.records.length === 1 && ls.records[0].label.includes('whitmore-service-2025') && /by service date/.test(ls.basis) && /1 future-dated service record/.test(ls.basis) && !ls.records.some((x) => /future/.test(x.label)) && cited(ls) && noTenantB(ls), JSON.stringify({ b: ls.basis, r: ls.records, t: ls.text }));
  const l3 = (await ask('last 3 visits at 412 Elm St')).data;
  check('history last-N visits: records are exactly the listed visits, basis says by service date', contractOk(l3) && l3.records.length === 1 && l3.recordsTotal === 1 && /by service date/.test(l3.basis) && cited(l3), JSON.stringify({ b: l3?.basis, r: l3?.records }));
  const cmp = (await ask('do we have more invoices or more service tickets on file')).data;
  const grp = {};
  for (const x of cmp.records) grp[x.group] = (grp[x.group] ?? 0) + 1;
  check('comparison: both counted sides are listed (grouped by side); recordsTotal == the two stated numbers', contractOk(cmp) && cmp.comparison === true && cmp.recordsTotal === Number(cmp.facts[0].value) + Number(cmp.facts[1].value) && grp[cmp.facts[0].label] === Number(cmp.facts[0].value) && grp[cmp.facts[1].label] === Number(cmp.facts[1].value) && /no date filter/.test(cmp.basis) && cited(cmp) && noTenantB(cmp), JSON.stringify({ g: grp, f: cmp.facts, b: cmp.basis }));
  const inst = (await ask('when was the unit at 412 Elm St installed')).data;
  check('history install-date: cites the units whose installation date is stated', contractOk(inst) && inst.records.filter((x) => x.type === 'unit').length === 2 && cited(inst) && noTenantB(inst), JSON.stringify({ t: inst?.text, r: inst?.records }));
  const md = (await ask("who's overdue for maintenance")).data;
  check('maintenance due: cites the customers judged, basis states by service date', md && contractOk(md) && md.records.every((x) => x.type === 'customer') && md.recordsTotal >= 1 && /by service date/.test(md.basis) && cited(md) && noTenantB(md), JSON.stringify({ b: md?.basis, r: md?.records, t: md?.text }));
  const nt = (await ask('notes on the unit at 412 Elm St')).data;
  check('unit notes: honest zero cites the documents searched (or the notes\' documents)', contractOk(nt) && (nt.recordsKind === 'searched' ? /^Searched \d+ documents?/.test(nt.basis) : /Read the notes/.test(nt.basis)) && cited(nt) && noTenantB(nt), JSON.stringify({ b: nt?.basis, n: nt?.records?.length }));
  const ff = (await ask('pull up Karen Abernathy')).data;
  check('full customer file: the file\'s documents, units and the customer are all records', contractOk(ff) && ff.records.some((x) => x.type === 'customer') && ff.records.some((x) => x.type === 'unit') && ff.records.some((x) => x.type === 'document' || x.type === 'invoice') && /Everything on file/.test(ff.basis) && cited(ff), JSON.stringify({ b: ff?.basis, r: ff?.records?.length }));
  // Analytics with the merged scope.js: service-visit rows exclude the future one; basis says so
  const sv = await plan({ entity: 'serviceVisits', op: 'count' });
  check('analytics service visits: future-dated visit is not counted or cited but is mentioned', sv.records.every((x) => x.type === 'document') && sv.recordsTotal === sv.records.length && /by service date/.test(sv.basis) && /future-dated/.test(sv.basis), JSON.stringify({ b: sv.basis, n: sv.recordsTotal, t: sv.text }));
}

/* ================================================================== 9. wiring + hygiene */
{
  const ask = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  check('ask.js: `send` finalizes citations on every response body', /if \(body\?\.data && typeof body\.data === "object"\) \{\s*try \{ finalizeCitations\(body\.data\)/.test(ask));
  const dir = path.join(ROOT, 'api', '_lib', 'citations');
  const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  check('citations modules never log question text (counters only)', !/console\.(log|error)\([^)]*question/.test(src));
  check('citations modules never write (no INSERT/UPDATE/DELETE/DDL)', !/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i.test(src));
  const top = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
  eq('exactly 12 files directly under api/', top, 12);
  check('the VIEW_DOCS prompt requires id columns + total_count for lists and counts', /CITATIONS: for every list, count or breakdown, ALSO select those id columns/.test((await import('../api/_lib/agent/tools.js')).VIEW_DOCS));
  check('no tenant B text in any citation log line', logged.every((l) => !/Zed|Secret/.test(l)));
}

console.log = realLog;
console.error = realErr;
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`All ${passes} checks passed.`);
process.exit(0);
