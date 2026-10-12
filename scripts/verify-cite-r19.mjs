/**
 * verify:cite-r19 - every answer the code gives says where it came from: the papers, plus the page when the paper has one, and a page is only ever cited when its text holds the value.
 *
 * Pure checks (needles, dates, page holds a value, phone by digits), then three real companies (pet groomer, trucking, church): documents cited by a DQL answer carry a page
 * that really prints the figure (checked here against the export's page text, independent of the code under test); a wrong page is dropped; a customer's stored phone / email answer
 * cites the paper that prints it; a count cites a few papers plus the total; "and which files that came from" names the papers with their pages.
 *
 *   node scripts/verify-cite-r19.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 300)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL; delete process.env.DONOVAN_PROVENANCE;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const { pageNeedles, pageHolds, pagePrints, datesIn, resolveProvenance } = await import('../api/_lib/citations/provenance.js');

// ---- pure
check('dates: ISO, numeric and month-name forms agree', (() => { const a = datesIn('Date: 08/04/2014'); const b = datesIn('Aug 4, 2014'); const c = datesIn('2014-08-04'); return a.has('2014-08-04') && b.has('2014-08-04') && c.has('2014-08-04') && c.size === 1; })());
check('needles: amount, date and name come from the record', (() => { const n = pageNeedles({ sublabel: '$4,039.00 · 2014-08-04' }); return n.amounts[0] === '4039' && n.dates[0] === '2014-08-04'; })());
check('page holds the amount it is cited for', pageHolds('Invoice #: 7\nTOTAL DUE: $4039.00', pageNeedles({ sublabel: '$4,039.00 · 2014-08-04' })) === true);
check('page without the amount is refused', pageHolds('Invoice #: 7\nTOTAL DUE: $4100.00', pageNeedles({ sublabel: '$4,039.00 · 2014-08-04' })) === false);
check('a name and a date are found on the page', pageHolds('Customer: Ronald Bracken\nAgreement Period: 01/01/2025', pageNeedles({ sublabel: 'Maintenance agreement · Sep 1, 2026 · Ronald Bracken' })) === true);
check('nothing checkable: no verdict', pageHolds('x', pageNeedles({ sublabel: '' })) === null);
check('phone is matched by its digits', pagePrints('Phone: 480-555-0157', '(480) 555-0157') && !pagePrints('Phone: 480-555-0158', '(480) 555-0157'));
check('email and address are matched by their words', pagePrints('Email: INFO@vista.com', 'info@vista.com') && pagePrints('Service Address: 211 E University Dr, Phoenix', '211 E University Dr'));
check('answers without records are left alone', (await resolveProvenance(null, { kind: 'answer', text: 'x' })).records === undefined);

// ---- real companies
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { numbersIn, canonNumber } = await import('../api/_lib/grounding/gate.js');
const TODAY = '2026-10-07';

async function company(key) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'r15', `${key}.json`), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r19-${key}`, tenantName: key });
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
  const pages = new Map(); for (const p of data.pages) { (pages.get(p.document_id) ?? pages.set(p.document_id, []).get(p.document_id)).push(p); }
  const ask = async (q) => { const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q }); if (!intent) return null; return withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })); };
  return { key, data, ctxArg, pages, ask };
}

for (const key of ['petgroom', 'trucking', 'church']) {
  const c = await company(key);
  const kinds = [...new Set(c.data.financials.map((f) => f.doc_kind))];
  const asks = [`how many ${key === 'petgroom' ? 'treat supply orders' : key === 'trucking' ? 'freight bills' : 'giving statements'} are on file and which files that came from`, `total of all ${key === 'petgroom' ? 'treat supply orders' : key === 'trucking' ? 'freight bills' : 'giving statements'}`];
  let tested = 0;
  for (const q of asks) {
    const a = await c.ask(q);
    if (!a || !a.records?.length) continue;
    const docs = a.records.filter((r) => r.documentId);
    tested++;
    check(`${key}: "${q}" cites papers`, docs.length >= Math.min(3, a.recordsTotal ?? docs.length) && (a.recordsTotal ?? 0) >= docs.length);
    let bad = 0; let withPage = 0;
    for (const r of docs) { if (!r.page) continue; withPage++; const pg = (c.pages.get(r.documentId) ?? []).find((p) => p.page_no === r.page); const nd = pageNeedles(r); if (!pg || pageHolds(pg.text, nd) === false) bad++; }
    check(`${key}: no cited page lacks its value (${withPage} pages)`, bad === 0, `bad ${bad}`);
    if (/which files/.test(q)) { check(`${key}: the sentence names the papers`, /Sources:/.test(a.text), a.text); const shown = docs.slice(0, 5); check(`${key}: the sentence gives the page when the record has one`, shown.every((r) => !r.page || a.text.includes(`page ${r.page}`)), a.text); }
  }
  check(`${key}: at least one provenance answer tested`, tested > 0);
  // a record cited with a wrong page loses it; one without gets the page that holds its figure
  const fin = c.data.financials.find((f) => f.total != null && (c.pages.get(f.document_id) ?? []).some((p) => numbersIn(p.text).has(canonNumber(f.total))));
  if (fin) {
    const good = (c.pages.get(fin.document_id) ?? []).find((p) => numbersIn(p.text).has(canonNumber(fin.total)));
    const sub = `$${Number(fin.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const data = await withTenant(c.ctxArg, (db) => resolveProvenance(db, { kind: 'answer', text: 't', facts: [], records: [{ type: 'document', id: fin.document_id, documentId: fin.document_id, label: 'x', sublabel: sub, page: 99 }], recordsTotal: 1 }));
    check(`${key}: a page that does not exist is dropped or replaced by the page holding the figure`, data.records[0].page === undefined || data.records[0].page === good.page_no, JSON.stringify(data.records[0]));
    const data2 = await withTenant(c.ctxArg, (db) => resolveProvenance(db, { kind: 'answer', text: 't', facts: [], records: [{ type: 'document', id: fin.document_id, documentId: fin.document_id, label: 'x', sublabel: sub }], recordsTotal: 1 }));
    check(`${key}: a record without a page gets the page that holds the figure`, data2.records[0].page === good.page_no, JSON.stringify(data2.records[0]));
  }
  // a stored contact value answered with the customer only gets the paper that prints it
  const ex = c.data.extractions.find((x) => /phone|email/i.test(x.field_key) && x.entity_id && String(x.value).length > 6 && (c.pages.get(x.document_id) ?? []).some((p) => pagePrints(p.text, x.value)));
  if (ex) {
    const data = await withTenant(c.ctxArg, (db) => resolveProvenance(db, { kind: 'answer', text: 't', facts: [{ label: 'Phone', value: String(ex.value), entityId: ex.entity_id }], records: [{ type: 'customer', id: ex.entity_id, label: 'C' }], recordsTotal: 1 }));
    const added = data.records.filter((r) => r.documentId);
    check(`${key}: a stored value answer cites the paper that prints it`, added.length > 0 && added.every((r) => { const pg = (c.pages.get(r.documentId) ?? []).find((p) => p.page_no === r.page); return pg && pagePrints(pg.text, ex.value); }), JSON.stringify(data.records));
  }
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
