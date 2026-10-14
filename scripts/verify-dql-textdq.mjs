/**
 * verify:dql-textdq - the "textdq" family of the Donovan Query Language (api/_lib/dql/families/textdq.js) on the golden export, in a real PGlite database.
 *
 * What the papers say (negation, plurals, typos, honest zeros), invoice lines, cost breakdowns, duplicates, missing fields, finding one paper,
 * conflicts and future dates. Every positive answer is checked against an INDEPENDENT reading of the export file (plain JS over the raw rows
 * below, not the engine's own snapshot code). Also checked: the releases (a word we cannot read, an untracked field, an ambiguous reading, a
 * question the core family or another lane owns) and the wiring (one family claims a question, the kill switch, the 12-file api/ rule).
 *
 *   node scripts/verify-dql-textdq.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:dql-textdq', tenantName: 'dql-textdq' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { allFamilies } = await import('../api/_lib/dql/registry.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const { runDecompose } = await import('../api/_lib/decompose/index.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'dql-textdq' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

/* ------------------------------------------------------------------ the independent oracle (plain JS over the raw export rows) */
const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
const valuesOf = new Map(); // doc id -> field -> [every value]
for (const x of data.extractions) {
  if (!valuesOf.has(x.document_id)) valuesOf.set(x.document_id, {});
  const m = valuesOf.get(x.document_id);
  (m[x.field_key] ??= []).push(eff(x));
}
const last = (id, k) => { const v = valuesOf.get(id)?.[k]; return v ? v[v.length - 1] : null; };
const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
const ents = new Map(data.entities.map((e) => [e.id, e]));
const custOfDoc = new Map();
for (const l of data.document_entity_links) {
  const e = ents.get(l.entity_id); if (!e) continue;
  const cid = e.entity_type === 'customer' ? e.id : e.customer_id;
  if (cid && ents.get(cid)) { if (!custOfDoc.has(l.document_id)) custOfDoc.set(l.document_id, new Set()); custOfDoc.get(l.document_id).add(cid); }
}
const hr = new Set(data.documents.filter((d) => String(d.document_type).replace(/_/g, '-') === 'hr-letter').map((d) => d.id));
const internal = new Set(data.documents.filter((d) => last(d.id, '_audience') === 'internal').map((d) => d.id));
const docs = data.documents.filter((d) => !hr.has(d.id) && !internal.has(d.id)).map((d) => ({ ...d, type: String(d.document_type).replace(/_/g, '-') }));
const docIds = new Set(docs.map((d) => d.id));
const lines = data.financial_lines.filter((l) => docIds.has(l.document_id));
const customers = data.entities.filter((e) => e.entity_type === 'customer' && !e.merged_into);
const units = data.entities.filter((e) => e.entity_type === 'equipment' && !e.merged_into);
const int = (n) => n.toLocaleString('en-US');
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const textsOf = (d) => [...(valuesOf.get(d.id)?.work_performed ?? []), ...(valuesOf.get(d.id)?.notes ?? []), ...lines.filter((l) => l.document_id === d.id).map((l) => l.description)];
const mentions = (re, filter = () => true) => docs.filter((d) => filter(d) && textsOf(d).some((t) => re.test(t)));
const NEG = /\b(?:no|not|without|none|never)\b[^,;.]{0,24}\b(?:leak|leaks|leaking)\b/i;

/* ------------------------------------------------------------------ harness */
async function ask(q, extra = {}) {
  const debug = {};
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, debug, ...extra });
  if (!intent) return { intent: null, data: null, why: debug.why };
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, data: out };
}
const has = (r, ...parts) => r.data && parts.every((p) => String(r.data.text).includes(p));
const released = async (name, q, extra) => { const x = await ask(q, extra); check(`release :: ${name}`, x.data === null, `${x.intent?.plan?.op ?? 'no plan'} ${x.data?.text ?? ''}`); };
const mine = (r) => r.intent && ['text_search', 'line_search', 'cost_breakdown', 'duplicates', 'missing_field', 'find_document', 'field_conflict', 'future_dates', 'completeness', 'field_text', 'reverse_lookup'].includes(r.intent.plan.op);

/* ================================================================== what the papers say */
const cap = mentions(/capacitor/i);
let r = await ask('how many documents mention a capacitor');
check('text :: count of documents that mention a term', mine(r) && r.intent.plan.op === 'text_search' && has(r, int(cap.length), 'capacitor'), r.data?.text);
check('text :: basis names what was searched and what was left out', /work performed, notes and invoice line items/.test(r.data?.basis ?? '') && /Negated mentions/.test(r.data?.basis ?? '') === false && /full text of scanned pages was not searched/.test(r.data?.basis ?? ''), r.data?.basis);
check('text :: cites the matching papers', r.data?.records?.length === cap.length && r.data.recordsTotal === cap.length, `${r.data?.records?.length}/${r.data?.recordsTotal}`);

r = await ask('wich docs mention capactor');
check('text :: a misspelled search word is read as the word the records contain and says so', has(r, int(cap.length), 'capacitor') && /Read "capactor" as "capacitor"/.test(r.data?.basis ?? ''), `${r.data?.text} | ${r.data?.basis}`);

const filt = mentions(/filter/i);
r = await ask('how many documents mention filters');
check('text :: plural and singular are the same word', has(r, int(filt.length)), r.data?.text);

const replacedFilter = docs.filter((d) => textsOf(d).some((t) => /replaced\s+air\s+filter/i.test(t)));
r = await ask('which jobs replaced an air filter');
check('text :: a past-tense phrase with no cue word finds the same wording', mine(r) && has(r, int(replacedFilter.length)), r.data?.text);

const cooling = docs.filter((d) => textsOf(d).some((t) => /\bno cooling\b/i.test(t)));
r = await ask('how many say no cooling');
check('text :: a phrase that starts with "no" is searched as typed, not read as a negation', has(r, int(cooling.length)) && cooling.length > 0, r.data?.text);

const leakNeg = docs.filter((d) => d.type === 'inspection-report' && textsOf(d).some((t) => NEG.test(t)));
const leakPos = docs.filter((d) => d.type === 'inspection-report' && textsOf(d).some((t) => /leak/i.test(t) && !NEG.test(t)));
r = await ask('which inspection reports mention leaks');
check('negation :: "no leaks found" is not a leak', leakPos.length === 0 && /No inspection reports/.test(r.data?.text ?? ''), r.data?.text);
check('negation :: the answer says how many were left out because they were negated', leakNeg.length > 0 && new RegExp(`${leakNeg.length} inspection reports? say it only in a negated form`).test(r.data?.text ?? ''), r.data?.text);
r = await ask('anything about a leak');
check('negation :: R23: a zero from the stored fields is a lower bound, so it is released (or read from the pages) and never said as a plain none', !r.data || !/^No .* mention/.test(r.data.text) || /I read the text of (?:all|every)/.test(r.data.text), r.data?.text);

r = await ask('search for water damage');
check('empty :: R23: a real word not in the stored fields is not answered "No ... mention" from the fields (the page search may say none after reading every page)', !r.data || /I read the text of (?:all|every)/.test(r.data.text), r.data?.text);
r = await ask('any notes mentioning R-22');
check('empty :: R23: a code not in the stored fields is not answered "No ... mention" from the fields', !r.data || /I read the text of (?:all|every)/.test(r.data.text), r.data?.text);
await released('a search word nobody can read', 'search for zxqvbn');
await released('a search word that is not in the records when no cue word was typed', 'how many tickets involved flurbing');

const tix = docs.filter((d) => d.type === 'service-ticket' && textsOf(d).some((t) => /capacitor/i.test(t)));
r = await ask('which tickets mention a capacitor');
check('text :: a kind of paper with no match says which other papers do', tix.length === 0 && /^No (?:service )?tickets mention/.test(r.data?.text ?? '') && (r.intent.plan.op === 'page_find' || new RegExp(`${cap.length} invoices? do`).test(r.data?.text ?? '')), r.data?.text); // R22: a list ask is the page search, which names the kind it read

const yr = docs.filter((d) => d.type === 'service-ticket' && textsOf(d).some((t) => /replaced\s+air\s+filter/i.test(t)) && String(last(d.id, 'service_date') ?? last(d.id, 'invoice_date') ?? d.created_at).startsWith('2024'));
r = await ask('how many service tickets replaced an air filter in 2024');
check('text :: a past-tense phrase with a kind of paper and a year', mine(r) && yr.length > 0 && has(r, int(yr.length), '2024'), `${yr.length} ${r.data?.text}`);
await released('a question with no cue word and no kind of paper named is not read as a text search', 'how many air filter replacements in 2024');

/* ================================================================== invoice lines */
const l454 = lines.filter((l) => /r-?454b/i.test(l.description));
r = await ask('all lines that say R-454B');
check('lines :: line items that mention a refrigerant code', r.intent?.plan.op === 'line_search' && l454.length > 0 && has(r, int(new Set(l454.map((l) => l.document_id)).size), 'R-454B'), r.data?.text);

const tr = lines.filter((l) => /trane/i.test(l.description) && /install/i.test(l.description));
r = await ask('how much have we billed for Trane installs');
check('lines :: billed for a brand of install adds up the matching line amounts', has(r, money(sum(tr.map((l) => Number(l.amount))))) && tr.length > 0, r.data?.text);
r = await ask('how many Carrier installs have we billed');
const car = lines.filter((l) => /carrier/i.test(l.description) && /install/i.test(l.description));
check('lines :: how many installs of a brand were billed', has(r, int(car.length)), r.data?.text);
const t3 = lines.filter((l) => /\b3\s*ton\b/i.test(l.description) && /install/i.test(l.description));
r = await ask('how much did we charge for 3 ton installs');
check('lines :: a tonnage and the word install', has(r, money(sum(t3.map((l) => Number(l.amount))))), r.data?.text);
r = await ask('any line items mentioning compressor replacement');
check('lines :: R23: a service not in the stored lines is released, not an honest zero', !r.data, r.data?.text);
await released('a price question with no match is not answered as if nothing was billed', 'what did we charge for the compressor replacement');
r = await ask('which invoices have a parts line');
const partsInv = new Set(lines.filter((l) => /^parts$/i.test(l.description) && docs.find((d) => d.id === l.document_id)?.type === 'invoice').map((l) => l.document_id));
check('lines :: the kind of paper is respected (purchase orders are not invoices)', partsInv.size === 0 ? !r.data : has(r, int(partsInv.size)), r.data?.text);

const kind = (d) => { const w = /^[A-Za-z]+/.exec(String(d ?? '').trim()); return w && w[0].length >= 3 && /^[A-Za-z]+(?:[\s,:(]|$)/.test(String(d).trim()) ? w[0][0].toUpperCase() + w[0].slice(1).toLowerCase() : 'Other'; };
const byKind = new Map(); for (const l of lines) { if (l.amount == null) continue; const k = kind(l.description); byKind.set(k, (byKind.get(k) ?? 0) + Number(l.amount)); }
r = await ask('break down line items by what they were for');
check('cost_breakdown :: every kind of line with its total', r.intent?.plan.op === 'cost_breakdown' && [...byKind.entries()].every(([k, v]) => String(r.data?.text).includes(`${k} ${money(v)}`)), r.data?.text);
r = await ask('split of our line item spend between parts and service');
check('cost_breakdown :: only the named kinds', has(r, `Parts ${money(byKind.get('Parts') ?? 0)}`, `Service ${money(byKind.get('Service') ?? 0)}`) && !/Install/.test(r.data?.text ?? ''), r.data?.text);

/* ================================================================== duplicates */
r = await ask('any duplicate serial numbers');
const serials = units.map((u) => u.data.serial_number).filter(Boolean);
check('duplicates :: none found states what was compared', new Set(serials).size === serials.length && has(r, 'No repeats', int(serials.length)), r.data?.text);
r = await ask('check for duplicate PO numbers');
check('duplicates :: none found for PO numbers', has(r, 'No repeats', 'PO number') && r.intent?.plan.op === 'duplicates', r.data?.text);
r = await ask('are there duplicate customers in the system');
const nameCount = new Map(); for (const c of customers) { const n = String(c.data.customer_name ?? '').toLowerCase(); nameCount.set(n, (nameCount.get(n) ?? 0) + 1); }
const dupNames = [...nameCount.entries()].filter(([, n]) => n > 1);
check('duplicates :: no customer name is on two records: none found with the count checked', dupNames.length === 0 && has(r, 'No repeats', int(customers.length)), r.data?.text);
r = await ask('any phone numbers shared by more than one customer');
const ph = new Map(); for (const c of customers) { const d = String(c.data.phone ?? '').replace(/\D/g, ''); if (d.length >= 7) ph.set(d.slice(-10), (ph.get(d.slice(-10)) ?? 0) + 1); }
const sharedPhones = [...ph.values()].filter((n) => n > 1).length;
check('duplicates :: a phone number on two customers (digits only)', sharedPhones > 0 ? has(r, int(sharedPhones)) : has(r, 'No repeats'), r.data?.text);
r = await ask('is a document ever uploaded twice by mistake');
check('duplicates :: the same file twice is recognised on upload', has(r, 'No duplicates') && /filed only once/.test(r.data?.text ?? ''), r.data?.text);
r = await ask('did we bill anyone twice for the same job');
const seenInv = new Map(); let dupInv = 0;
for (const d of docs.filter((x) => x.type === 'invoice')) { const f = finOf.get(d.id); const cs = custOfDoc.get(d.id); if (!f || f.total == null || !cs || cs.size !== 1) continue; const k = `${[...cs][0]}|${f.total}|${f.job_key ?? ''}`; seenInv.set(k, (seenInv.get(k) ?? 0) + 1); }
for (const n of seenInv.values()) if (n > 1) dupInv++;
check('duplicates :: invoices with the same customer, job site and amount', dupInv === 0 ? has(r, 'No repeats', 'customer, job site and amount') : has(r, int(dupInv)), r.data?.text);
r = await ask('any customers with two visits on the same day');
const visitDay = new Map();
for (const d of docs) { const sd = last(d.id, 'service_date'); const cs = custOfDoc.get(d.id); if (!sd || !cs || cs.size !== 1) continue; const k = `${[...cs][0]}|${String(sd).slice(0, 10)}`; visitDay.set(k, (visitDay.get(k) ?? 0) + 1); }
const visitCusts = new Set([...visitDay.entries()].filter(([, n]) => n > 1).map(([k]) => k.split('|')[0]));
check('duplicates :: customers with two visits on one day', has(r, `${int(visitCusts.size)} customer`), `${visitCusts.size} ${r.data?.text}`);

/* ================================================================== missing fields */
const noPhone = customers.filter((c) => !String(c.data.phone ?? '').trim()).length;
r = await ask('how many customers dont have a phone number');
check('missing :: customers with no phone', mine(r) && has(r, int(noPhone), 'phone number'), r.data?.text);
const noEmail = customers.filter((c) => !String(c.data.email ?? '').trim());
r = await ask('which customers have no email on file');
check('missing :: customers with no email (every one listed)', has(r, int(noEmail.length)) && noEmail.slice(0, 5).every((c) => (r.data?.text ?? '').includes(c.data.customer_name) || noEmail.length > 40), r.data?.text);
const neither = customers.filter((c) => !String(c.data.phone ?? '').trim() && !String(c.data.email ?? '').trim()).length;
r = await ask('who has neither phone nor email');
check('missing :: neither of two fields', has(r, int(neither), 'no phone number and no email'), r.data?.text);
const unlinked = docs.filter((d) => !custOfDoc.has(d.id)).length;
r = await ask('how many documents are missing a customer');
check('missing :: documents with no customer link', has(r, int(unlinked)), r.data?.text);
const invNoTech = docs.filter((d) => d.type === 'invoice' && !last(d.id, 'technician')).length;
r = await ask('invoices missing a technician');
check('missing :: invoices with no technician', has(r, int(invNoTech)), r.data?.text);
const unreg = units.filter((u) => !u.data.warranty_registered_date).length;
r = await ask('units that never got registered');
check('missing :: units with no warranty registration', has(r, int(unreg)), r.data?.text);
r = await ask('documents missing a date');
check('missing :: a document\'s date falls back to the upload date, and the answer says so', has(r, 'None of the') && /service or invoice date on the paper/.test(r.data?.text ?? ''), r.data?.text);
r = await ask('service tickets missing a technician');
const stNoTech = docs.filter((d) => d.type === 'service-ticket' && !last(d.id, 'technician')).length;
check('missing :: zero is stated as none found with the count checked', stNoTech === 0 ? has(r, 'None of the', int(docs.filter((d) => d.type === 'service-ticket').length)) : has(r, int(stNoTech)), r.data?.text);
r = await ask('how many patients have no contact info');
check('missing :: "no contact info" means neither phone nor email', has(r, int(neither)), r.data?.text);
await released('"missing contact info" could mean either one', 'which tenants are missing contact info');
await released('a due date is not tracked', 'which invoices dont have a due date');
await released('amount paid is not tracked', 'how many invoices are missing amount paid');
await released('a model number with no kind of paper named', 'how many docs are missing a model number');

/* ================================================================== finding one paper */
const inv50 = docs.find((d) => finOf.get(d.id)?.invoice_number === 'INV-20050');
r = await ask('pull up invoice INV-20050');
check('find :: a document by its number', mine(r) && has(r, 'INV-20050', money(Number(finOf.get(inv50.id).total))), r.data?.text);
r = await ask('show me invoice INV-99999');
check('find :: a number that is not on file is stated, not guessed', has(r, 'INV-99999', 'not found'), r.data?.text);
const inv2800 = docs.filter((d) => d.type === 'invoice' && finOf.get(d.id)?.total != null && Number(finOf.get(d.id).total) === 2800);
r = await ask('find the invoice for exactly $2,800');
check('find :: an invoice by its exact amount', inv2800.length > 0 && inv2800.every((d) => String(r.data?.text).includes(finOf.get(d.id).invoice_number)), r.data?.text);
const ser = last(docs.find((d) => d.type === 'warranty-registration').id, 'serial_number');
const serDocs = docs.filter((d) => String(last(d.id, 'serial_number') ?? '').toLowerCase() === String(ser).toLowerCase() || Object.values(valuesOf.get(d.id) ?? {}).flat().some((v) => typeof v === 'string' && v.toLowerCase().split(/[^a-z0-9]+/).includes(String(ser).toLowerCase())));
r = await ask(`all paperwork on serial ${ser}`);
check('find :: every paper that carries a serial number', has(r, int(serDocs.length), String(ser)) , `${serDocs.length} ${r.data?.text}`);

/* ================================================================== conflicts, future dates, completeness, starts-with */
r = await ask('serial numbers that show up in two different brands');
check('conflict :: a serial under two brands states what was compared', mine(r) && has(r, 'No serial number appears', 'checked'), r.data?.text);
r = await ask('are there any dates in the future');
check('future :: none found states today and what was checked', has(r, 'None of the documents', 'Oct 7, 2026', 'after') && /Agreement terms and warranty end dates/.test(r.data?.basis ?? ''), r.data?.text);
const noTon = units.filter((u) => !String(u.data.tonnage ?? '').trim()).length;
r = await ask('how complete is the equipment data');
check('completeness :: how many units are blank on each key field', has(r, `tonnage: ${int(noTon)}`, `warranty registration: ${int(unreg)}`, 'serial number: 0'), r.data?.text);
const m24 = units.filter((u) => String(u.data.model ?? '').toLowerCase().startsWith('24acc')).length;
r = await ask('how many model numbers start with 24ACC');
check('field_text :: a model number that starts with a code (the count)', has(r, int(m24), '24ACC'), r.data?.text);
// the same question as a list is released once it runs past ten rows: a cut-off list reads as a short one
await released('field_text :: a list of more than ten matches is not read out', 'model numbers starting with 24ACC');

/* ================================================================== a customer on file twice (rows added to the tenant for this check only) */
{
  const tenId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
  for (const [id, num] of [['dab00000-0000-4000-8c00-0000000000a1', 'C-DUPA1'], ['dab00000-0000-4000-8c00-0000000000a2', 'C-DUPA2']]) {
    await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [id, tenId, 'customer', JSON.stringify({ customer_name: 'Zelda Twinfield', phone: '(602) 555-0188', service_address: '9 Twin St, Mesa, AZ 85201' }), num]);
  }
  const tv2 = await withTenant(ctxArg, async (db) => { const { resetTenantVocabCacheForTests } = await import('../api/_lib/vocab/tenantVocab.js'); resetTenantVocabCacheForTests(); return getTenantVocab(db, ctx.tenantKey, pack); });
  const ask2 = async (q) => { const intent = parseDql(q, { tenantVocab: tv2, pack, today: TODAY }); const out = intent ? await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })) : null; return { intent, data: out }; };
  let x = await ask2('are there duplicate customers in the system');
  check('duplicates :: the same name on two customer records is found', x.data && /Zelda Twinfield/.test(x.data.text) && /Yes/.test(x.data.text), x.data?.text);
  x = await ask2('any phone numbers shared by more than one customer');
  check('duplicates :: one more phone number shared by two customers is counted (digits only)', x.data && new RegExp(`^Yes\\. ${sharedPhones + 1} phone numbers are shared`).test(x.data.text), x.data?.text);
  x = await ask2('who shares an address');
  check('duplicates :: an address shared by two customers is found', x.data && /9 Twin St/.test(x.data.text), x.data?.text);
  x = await ask2('are there two Zelda Twinfields');
  check('duplicates :: "are there two <name>" counts the customers of that name', x.data && /2 customers are named Zelda Twinfield/.test(x.data.text), x.data?.text);
}

/* ================================================================== who has this phone number / email, one paper's own fields, an address that contains a word */
{
  const withEmail = customers.find((c) => c.data.email);
  r = await ask(`which customer uses ${withEmail.data.email}`);
  check('reverse :: the customer who has an email address', mine(r) && has(r, withEmail.data.customer_name), JSON.stringify(r.intent?.plan)+' '+r.data?.text+' '+r.why);
  r = await ask(`is ${withEmail.data.email} one of ours`);
  check('reverse :: "is this email one of ours" answers yes with the name', has(r, 'Yes', withEmail.data.customer_name), r.data?.text);
  r = await ask('is zq.vx@example.org one of ours');
  check('reverse :: an email nobody has is an honest none', has(r, 'No customer has', 'on file'), r.data?.text);
  const withPhone = customers.find((c) => String(c.data.phone ?? '').replace(/\D/g, '').length >= 10);
  const digitsOf = (v) => String(v).replace(/\D/g, '').slice(-10);
  const sharing = customers.filter((c) => digitsOf(c.data.phone ?? '') === digitsOf(withPhone.data.phone));
  r = await ask(`look up phone ${withPhone.data.phone.replace(/^[^\d(]+/, '')}`);
  check('reverse :: a phone number finds every customer that has it', sharing.every((c) => (r.data?.text ?? '').includes(c.data.customer_name)), r.data?.text);

  const invHours = docs.find((d) => d.type === 'invoice' && finOf.get(d.id)?.invoice_number && last(d.id, 'labor_hours'));
  const invNo = finOf.get(invHours.id).invoice_number;
  r = await ask(`how many labor hours were on ${invNo}`);
  check('find :: one field of one paper by its number', mine(r) && has(r, invNo, `labor hours ${last(invHours.id, 'labor_hours')}`), r.data?.text);
  r = await ask(`${invNo} service date and tech`);
  check('find :: two fields of one paper', has(r, invNo, 'service date', 'technician'), r.data?.text);
  const someSerial = units[0].data.serial_number;
  await released('a bare serial question asks about the unit, not the papers', `pull up serial ${someSerial}`);
  r = await ask('all paperwork on serial ZZ900001');
  check('find :: a serial on no paper says it was not found', mine(r) && has(r, 'was not found'), r.data?.text);
  await released('another question about a unit is not a document search', `what model is serial ${someSerial}`);
  await released('who did the work is not a document search', `who did the startup on ${someSerial}`);
  await released('a customer number is not a document number', 'customer number C-00109 name');

  const suiteUnits = units.filter((u) => /\bsuite\b/i.test(ents.get(u.customer_id)?.data.service_address ?? '')).length;
  r = await ask('how many units are at addresses with a Suite number');
  check('field_text :: units at an address that contains a word', mine(r) && has(r, int(suiteUnits), 'Suite'), r.data?.text);
}
// the three questions below are about customers or units having (or lacking) papers: not duplicates, not text search. The text family stays out and the sets family answers (verify:dql-sets checks them).
const sets = async (name, q, re) => { const x = await ask(q); check(`not mine :: ${name}`, x.intent?.plan?.op === 'set_select' && re.test(String(x.data?.text ?? '')), `${x.intent?.plan?.op ?? 'no plan'} ${x.data?.text ?? ''}`); };
await sets('"more than once" counts customers by their quotes, it is not a duplicates question', 'which customers did we quote more than once', /^(?:No customers|\d[\d,]* customers) with more than 1 (?:proposal \/ )?quote/);
await sets('"repeat customers" is customers with several service visits', 'who are our repeat customers', /service visits/);
await sets('two things asked at once about units is one set: neither paper', 'how many units have no startup sheet AND no registration', /without a startup sheet or a warranty registration/);
await released('a brand is a value of a field, not a phrase on the papers', 'documents mentioning Trane');
{
  // a status word is a condition, never dropped: either the question is released, or the status is applied (the answer says so and counts only those papers)
  const tech = last(docs.find((d) => d.type === 'work-order' && last(d.id, 'technician')).id, 'technician');
  const x = await ask('completed work orders by ' + tech);
  const done = docs.filter((d) => d.type === 'work-order' && last(d.id, 'technician') === tech && /^completed$/i.test(last(d.id, 'status') ?? ''));
  check('release :: a status word is a condition: completed work orders', x.data === null || (/Completed/.test(x.data.text) && (x.data.text.match(/^(?:list )?(\d+)/)?.[1] ?? '') === String(done.length)), `${x.intent?.plan?.op ?? 'no plan'} ${x.data?.text ?? ''}`);
}
await released('a model number question with no kind of paper named', 'how many docs are missing a model number');

/* ================================================================== the core family and the other lanes keep their questions */
for (const [name, q, op] of [['a plain count', 'how many invoices do we have', 'count'], ['a sum', 'total invoiced in 2020', 'sum'], ['a group', 'invoices per year', 'group_count']]) {
  const x = await ask(q);
  check(`ownership :: ${name} stays with the core family`, x.intent?.plan.op === op, x.intent?.plan.op);
}
await released('payment status is not tracked', 'which invoices are unpaid');
await released('a definition', 'what is a startup sheet');
await released('a follow-up opener', 'same file uploaded twice?');
await released('a name that is two things at once', 'how many invoices missing a customer name Kevin Pratt', { tenantVocab: { ...tv, customers: { ...tv.customers, phrases: [...tv.customers.phrases, 'Kevin Pratt'] } } });

/* ================================================================== wiring */
{
  const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => true }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };
  const o = await classifyAll('any duplicate serial numbers', cc);
  check('wiring :: a duplicates question no lane owns travels as a dql claim', (o.winner?.name === 'decompose' && o.winner.intent?.mode === 'dql') || (o.gated?.decompose?.mode === 'dql'), JSON.stringify(o.winner)?.slice(0, 120));
  process.env.DONOVAN_DQL = '0';
  const o0 = await classifyAll('any duplicate serial numbers', cc);
  delete process.env.DONOVAN_DQL;
  check('wiring :: kill switch DONOVAN_DQL=0 leaves the router as it was', o0.winner?.intent?.mode !== 'dql' && o0.gated?.decompose?.mode !== 'dql');
  const intent = parseDql('how many documents mention a capacitor', { tenantVocab: tv, pack, today: TODAY });
  const viaDecompose = await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }));
  check('wiring :: runDecompose delegates mode dql to the engine', Boolean(viaDecompose?.text) && viaDecompose.kind === 'answer', viaDecompose?.text);
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  check('structure :: api/ keeps exactly 12 top-level files', apiFiles.length === 12, apiFiles.join(','));
  check('structure :: the textdq family is registered beside the core family', ['core', 'textdq'].every((id) => allFamilies().some((f) => f.id === id)));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
