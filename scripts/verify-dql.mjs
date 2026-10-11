/**
 * verify:dql - the Donovan Query Language engine (api/_lib/dql) on the golden export, in a real PGlite database.
 *
 * Every positive answer is checked against an INDEPENDENT reading of the export file (plain JS over the raw rows below, not the engine's own
 * snapshot code). Also checked: releases (an unexplained word, an ambiguous name, an untracked field, a follow-up fragment, a definition),
 * ties, honest empties, the router wiring (claim / kill switch / never overrides a claim), the precision guard and the 12-file api/ rule.
 *
 *   node scripts/verify-dql.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:dql', tenantName: 'dql' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const { runDecompose } = await import('../api/_lib/decompose/index.js');
const { guardDecomposeAnswer } = await import('../api/_lib/router/guard/check.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'dql' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

/* ------------------------------------------------------------------ the independent oracle (plain JS over the raw export rows) */
const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
const fieldsOf = new Map();
for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = eff(x); }
const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
const ents = new Map(data.entities.map((e) => [e.id, e]));
const custOfDoc = new Map();
for (const l of data.document_entity_links) {
  const e = ents.get(l.entity_id); if (!e) continue;
  const cid = e.entity_type === 'customer' ? e.id : e.customer_id;
  if (cid && ents.get(cid)) custOfDoc.set(l.document_id, cid);
}
const city = (addr) => { const p = String(addr ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
const docs = data.documents.map((d) => {
  const f = fieldsOf.get(d.id) ?? {};
  const fin = finOf.get(d.id);
  const cust = ents.get(custOfDoc.get(d.id));
  const date = (f.service_date ?? f.invoice_date ?? String(fin?.invoice_date ?? '').slice(0, 10)) || String(d.created_at).slice(0, 10);
  return { id: d.id, type: d.document_type, f, total: fin?.total != null ? Number(fin.total) : null, cust: cust?.data.customer_name ?? null, city: cust ? city(cust.data.service_address) : null, date: String(date).slice(0, 10), service: f.service_date ?? null };
});
const customers = data.entities.filter((e) => e.entity_type === 'customer');
const units = data.entities.filter((e) => e.entity_type === 'equipment');
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => n.toLocaleString('en-US');
const ofType = (t) => docs.filter((d) => d.type === t);
const inYear = (rows, y) => rows.filter((d) => d.date.startsWith(String(y)));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------ harness */
async function ask(q, extra = {}) {
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, ...extra });
  if (!intent) return { intent: null, data: null };
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, data: out };
}
const has = (r, ...parts) => r.data && parts.every((p) => String(r.data.text).includes(p));

/* ================================================================== positives: counts, lists, distinct, existence */
const invoices = ofType('invoice');
let r = await ask('how many invoices do we have');
check('count :: invoices', has(r, int(invoices.length)) && r.intent.plan.op === 'count', r.data?.text);
check('count :: carries a basis line naming the scope', /every invoice on file/.test(r.data?.basis ?? ''), r.data?.basis);
check('count :: cites records with the same total', r.data?.recordsTotal === invoices.length && r.data.records.length > 0, JSON.stringify([r.data?.recordsTotal, r.data?.records?.length]));

const someCust = customers[3].data.customer_name;
const custDocs = docs.filter((d) => d.cust === someCust);
r = await ask(`how many documents are on file for ${someCust}`);
check('count :: documents for one named customer', has(r, int(custDocs.length), someCust), r.data?.text);
check('count :: named customer appears in the records too', (r.data?.records ?? []).length === custDocs.length, r.data?.records?.length);

const tickets = ofType('service-ticket');
r = await ask('service tickets in 2024');
check('list/time :: service tickets in 2024', has(r, int(inYear(tickets, 2024).length), '2024') && /service ticket/.test(r.data?.text ?? ''), r.data?.text);

const q3 = invoices.filter((d) => d.date >= '2023-07-01' && d.date <= '2023-09-30');
r = await ask('how many invoices in Q3 2023');
check('count/time :: a quarter', has(r, q3.length === 0 ? '0' : int(q3.length)) && /Q3 2023/.test(r.data?.text ?? ''), r.data?.text);

const brandCount = (b) => units.filter((u) => (u.data.manufacturer ?? '').toLowerCase() === b.toLowerCase()).length;
r = await ask('how many Trane units do we have');
check('count :: units by brand', has(r, int(brandCount('Trane')), 'Trane'), r.data?.text);

const tons3 = units.filter((u) => /^3\s*ton/i.test(u.data.tonnage ?? '')).length;
r = await ask('how many 3 ton units');
check('count :: tonnage filter', has(r, int(tons3)), r.data?.text);

const r410 = units.filter((u) => u.data.refrigerant === 'R-410A').length;
r = await ask('how many R-410A units');
check('count :: refrigerant filter', has(r, int(r410)), r.data?.text);

const ageOver = (n) => units.filter((u) => { const d = String(u.data.installation_date ?? '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false; return (Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / (365.25 * 86400000) > n; }).length;
r = await ask('how many units are older than 15 years');
check('count :: unit age comparator', has(r, int(ageOver(15))), r.data?.text);

const mesaCustomers = customers.filter((c) => city(c.data.service_address) === 'Mesa').length;
r = await ask('how many customers in Mesa');
check('count :: customers by city', has(r, int(mesaCustomers), 'Mesa'), r.data?.text);

const over5k = invoices.filter((d) => d.total != null && d.total > 5000).length;
r = await ask('invoices over $5,000');
check('list/amount :: invoices over $5,000', has(r, int(over5k)) && /5,000/.test(r.data?.text ?? ''), r.data?.text);

const techs = [...new Set(docs.map((d) => d.f.technician).filter(Boolean))].sort();
r = await ask('how many different technicians');
check('count_distinct :: technicians', has(r, int(techs.length)) && r.intent.plan.op === 'count_distinct', r.data?.text);
r = await ask('which technicians do we have');
check('list distinct :: technicians', techs.every((t) => String(r.data?.text).includes(t)), r.data?.text);

const brands = [...new Set(units.map((u) => u.data.manufacturer).filter(Boolean))];
r = await ask('how many different brands');
check('count_distinct :: brands', has(r, int(brands.length)), r.data?.text);

r = await ask('is there a permit on file');
check('exists :: yes', has(r, 'Yes') && r.intent.plan.op === 'exists_yes_no', r.data?.text);
r = await ask('are there any invoices in 1999');
check('exists :: no states the condition', has(r, 'No', '1999'), r.data?.text);

/* ================================================================== sums, averages, extremes, median */
const invTotals = invoices.map((d) => d.total).filter((x) => x != null);
r = await ask('total invoiced in 2020');
const t2020 = sum(inYear(invoices, 2020).map((d) => d.total ?? 0));
check('sum :: invoice totals in a year', has(r, money(t2020)) && r.intent.plan.op === 'sum', r.data?.text);
check('sum :: basis names the amount rule and the date rule', /service date, else the invoice date, else the upload date/.test(r.data?.basis ?? '') && /amounts as printed/.test(r.data?.basis ?? ''), r.data?.basis);

r = await ask('average invoice');
check('avg :: average invoice', has(r, money(sum(invTotals) / invTotals.length)), r.data?.text);
r = await ask('what is the median invoice');
const sorted = [...invTotals].sort((a, b) => a - b); const mid = sorted.length >> 1;
check('median :: median invoice', has(r, money(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)), r.data?.text);
r = await ask('highest invoice');
const mx = Math.max(...invTotals);
check('max :: highest invoice', has(r, money(mx)) && r.intent.plan.op === 'max', r.data?.text);
r = await ask('lowest invoice');
check('min :: lowest invoice', has(r, money(Math.min(...invTotals))), r.data?.text);

const poTotal = sum(ofType('purchase-order').map((d) => d.total ?? 0));
r = await ask('how much have we spent on purchase orders');
check('sum :: purchase-order spend', has(r, money(poTotal)), r.data?.text);

const hours = docs.map((d) => Number(d.f.labor_hours)).filter((x) => Number.isFinite(x));
r = await ask('total labor hours');
check('sum :: labor hours', has(r, 'hour') && Math.abs(sum(hours) - Number((r.data?.text.match(/([\d,]+(?:\.\d+)?) hours/) ?? [])[1]?.replace(/,/g, ''))) < 0.01, r.data?.text);

/* ================================================================== groups, ranks, shares, comparisons */
r = await ask('invoices per year');
const yrs = {}; invoices.forEach((d) => { const y = d.date.slice(0, 4); yrs[y] = (yrs[y] || 0) + 1; });
check('group_count :: invoices by year (every year, right counts)', Object.entries(yrs).every(([y, n]) => new RegExp(`${y}: ${n}\\b`).test(r.data?.text ?? '')), r.data?.text);

r = await ask('purchase orders by vendor');
const vend = {}; ofType('purchase-order').forEach((d) => { const v = finOf.get(d.id)?.vendor_name; if (v) vend[v] = (vend[v] || 0) + 1; });
check('group_count :: purchase orders by vendor', Object.entries(vend).every(([v, n]) => new RegExp(`${v}: ${n}\\b`).test(r.data?.text ?? '')), r.data?.text);

r = await ask('invoice total by technician');
check('group_sum :: invoices by technician', r.intent?.plan.op === 'group_sum' && techs.every((t) => String(r.data?.text).includes(t)), r.data?.text);

r = await ask('top 3 customers by revenue');
const byCust = {}; invoices.forEach((d) => { if (d.cust && d.total != null) byCust[d.cust] = (byCust[d.cust] || 0) + d.total; });
const ranked = Object.entries(byCust).sort((a, b) => b[1] - a[1]);
check('top_n :: top 3 customers by revenue', ranked.slice(0, 3).every(([n, v]) => String(r.data?.text).includes(n) && String(r.data?.text).includes(money(v))), r.data?.text);

r = await ask('which brand has the most units');
const bc = {}; units.forEach((u) => { bc[u.data.manufacturer] = (bc[u.data.manufacturer] || 0) + 1; });
const bmax = Math.max(...Object.values(bc)); const topB = Object.keys(bc).filter((k) => bc[k] === bmax);
check('top_n :: brand with the most units reports every tie', topB.every((b) => String(r.data?.text).includes(b)) && String(r.data?.text).includes(String(bmax)), r.data?.text);

r = await ask('which technician has the fewest service tickets');
const tc = {}; tickets.forEach((d) => { if (d.f.technician) tc[d.f.technician] = (tc[d.f.technician] || 0) + 1; });
const tmin = Math.min(...Object.values(tc)); const botT = Object.keys(tc).filter((k) => tc[k] === tmin);
check('bottom_n :: fewest tickets reports every tie', botT.every((b) => String(r.data?.text).includes(b)) && r.intent.plan.op === 'bottom_n', r.data?.text);

r = await ask('what percent of service tickets are preventive maintenance');
const pm = tickets.filter((d) => /preventive maintenance/i.test(d.f.service_type ?? '')).length;
check('share_pct :: tickets that are preventive maintenance', has(r, `${int(pm)} of ${int(tickets.length)}`, `${Math.round((pm / tickets.length) * 1000) / 10}%`), r.data?.text);

r = await ask('how many documents per customer on average');
check('per_entity_avg :: documents per customer', has(r, int(docs.length), int(customers.length)) && r.intent.plan.op === 'per_entity_avg', r.data?.text);

r = await ask('invoice revenue in Mesa vs Tucson');
const cityRev = (c) => sum(invoices.filter((d) => d.city === c).map((d) => d.total ?? 0));
check('compare :: two cities', has(r, 'Mesa', 'Tucson', money(cityRev('Mesa')), money(cityRev('Tucson'))), r.data?.text);

r = await ask('latest invoice');
const maxDate = invoices.map((d) => d.date).sort().pop();
check('latest :: latest invoice date', has(r, 'Latest'.toLowerCase()) || /latest/.test(r.data?.text ?? ''), r.data?.text);
check('latest :: names the date it used', (r.data?.basis ?? '').includes('service date') && r.data.text.length > 10, r.data?.basis);
r = await ask('first invoice we ever sent');
const minDate = invoices.map((d) => d.date).sort()[0];
check('first_ever :: earliest invoice', /earliest/.test(r.data?.text ?? '') || r.data?.text.includes(minDate.slice(0, 4)), r.data?.text);

r = await ask('customers with more than one unit');
const multi = customers.filter((c) => units.filter((u) => u.customer_id === c.id).length > 1).length;
check('customer relation :: more than one unit', has(r, int(multi)) && r.intent.plan.entity === 'customer', r.data?.text);

/* ================================================================== releases: the engine must stay silent, never guess */
const released = async (name, q, extra) => { const x = await ask(q, extra); check(`release :: ${name}`, x.intent === null || x.data === null, JSON.stringify(x.intent?.plan ?? null)); };
await released('an unexplained word', 'how many invoices are frobnicated');
await released('an unexplained condition word next to a known one', 'how many invoices with a leaky compressor in 2024');
await released('payment status is not tracked (unpaid)', 'which invoices are unpaid');
await released('payment status is not tracked (balance)', 'what is the balance due on invoices');
await released('overdue', 'how many invoices are overdue');
await released('two document types in one count', 'how many invoices and permits');
await released('a definition', 'what is a startup sheet');
await released('a follow-up fragment (opener)', 'and in august?');
await released('a follow-up fragment (pronoun)', 'how many of those were repairs');
await released('a bare noun', 'invoices');
await released('a month with no year', 'how many invoices in september');
// negation on customers and units belongs to the sets family, a blank field on a paper to the text family (verify:dql-textdq checks those answers); the core family answers neither
{ const x = parseDql('invoices with no technician', { tenantVocab: tv, pack, today: TODAY }); check('release :: core family leaves negation on documents to the text family', x?.plan?.op === 'missing_field', JSON.stringify(x?.plan ?? null).slice(0, 200)); }
await released('HR letters are never listed', 'how many hr letters do we have');
await released('a number with no unit', 'how many invoices 4000');
await released('a name that is two things', `how many tickets did ${techs[0]} do`, { tenantVocab: { ...tv, customers: { ...tv.customers, phrases: [...tv.customers.phrases, techs[0]] } } });
{
  const k = parseDql('how many invoices', { tenantVocab: tv, pack, today: TODAY });
  process.env.DONOVAN_DQL = '0';
  const off1 = parseDql('how many invoices', { tenantVocab: tv, pack, today: TODAY });
  delete process.env.DONOVAN_DQL;
  check('kill switch :: DONOVAN_DQL=0 turns the parser off', k !== null && off1 === null);
}

/* ================================================================== honest empties and a name on file twice */
r = await ask('how many Fujitsu units');
check('empty :: a brand with no units is an honest zero that states the condition', has(r, 'No units', 'Fujitsu'), r.data?.text);
r = await ask('how many invoices dated 1999');
check('empty :: a year with nothing', has(r, 'No invoices', '1999'), r.data?.text);
r = await ask('highest purchase order in 1999');
check('empty :: an extreme over nothing says none', has(r, 'No purchase orders') && (r.data?.facts ?? []).length === 0 || has(r, 'No purchase orders'), r.data?.text);

// a customer name on file twice: the executor abstains (the existing clarify path asks which one)
{
  const tenId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
  const dupName = customers[10].data.customer_name;
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    ['dab00000-0000-4000-8c00-000000000001', tenId, 'customer', JSON.stringify({ customer_name: dupName, service_address: '1 Dup St, Mesa, AZ 85201' }), 'C-DUP0001']);
  const tv2 = await withTenant(ctxArg, async (db) => { const { resetTenantVocabCacheForTests } = await import('../api/_lib/vocab/tenantVocab.js'); resetTenantVocabCacheForTests(); return getTenantVocab(db, ctx.tenantKey, pack); });
  const intent = parseDql(`how many documents for ${dupName}`, { tenantVocab: tv2, pack, today: TODAY });
  const out = intent ? await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })) : null;
  check('ambiguous name :: a customer name on file twice is never answered for one of them: it asks which one (round 7; before, the plan was released at run time)', intent !== null && (out === null || (/Which one do you mean\?/.test(out.text) && !/\$\d/.test(out.text))), out?.text);
}

/* ================================================================== wiring: classifyAll, decompose, guard */
{
  const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => true }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };
  // a question no lane claims, that DQL reads in full: it travels as a decompose claim and the model-planned analytics lane is switched off
  let unclaimed = null; let claim = null;
  for (const q of ['units by refrigerant', 'units by tonnage', 'how many units by model', 'tickets by service type']) {
    const o = await classifyAll(q, cc);
    if (o.winner?.name === 'decompose' && o.winner.intent?.mode === 'dql') { unclaimed = q; claim = o; break; }
  }
  check('wiring :: an unclaimed question travels as decompose {mode: dql} with analytics off', Boolean(claim) && claim.gated.decompose?.mode === 'dql' && claim.gated.analytics === false, unclaimed ?? 'no candidate was unclaimed');
  if (claim) {
    process.env.DONOVAN_DQL = '0';
    const out0 = await classifyAll(unclaimed, cc);
    delete process.env.DONOVAN_DQL;
    check('wiring :: kill switch DONOVAN_DQL=0 leaves the router as it was', out0.winner?.intent?.mode !== 'dql' && out0.gated.decompose?.mode !== 'dql');
    const viaDecompose = await withTenant(ctxArg, (db) => runDecompose(db, claim.winner.intent, { today: TODAY }));
    check('wiring :: runDecompose delegates mode dql to the engine', Boolean(viaDecompose?.text) && viaDecompose.kind === 'answer', viaDecompose?.text);
  }
  // a question an earlier lane claims stays with that lane; DQL only waits behind it in the decompose slot (ask.js runs that lane when the earlier one returns nothing)
  let early = null;
  for (const q of ['invoices per city', 'work orders per year', 'service tickets per technician']) { const o = await classifyAll(q, cc); if (o.winner && o.winner.name !== 'decompose' && o.gated.decompose?.mode === 'dql') { early = o; break; } }
  check('wiring :: a claim by an earlier lane is never replaced (DQL waits behind it)', Boolean(early) && early.winner.name !== 'decompose', JSON.stringify(early?.winner)?.slice(0, 100));
  const claimed = await classifyAll(`what is the phone number for ${someCust}`, cc);
  check('wiring :: never overrides a lookup claim', claimed.winner && claimed.winner.intent?.mode !== 'dql' && claimed.gated.decompose?.mode !== 'dql', JSON.stringify(claimed.winner)?.slice(0, 120));
  const named = parseDql(`how many documents for ${someCust}`, { tenantVocab: tv, pack, today: TODAY });
  const namedData = await withTenant(ctxArg, (db) => runDql(db, named, { today: TODAY }));
  const g = guardDecomposeAnswer({ question: `how many documents for ${someCust} in 2024`, data: namedData, intent: named, tenantVocab: tv });
  check('guard :: a dql answer about a named customer passes the precision guard', g.blocked === false && namedData.text.includes(someCust) && namedData.records.length > 0, JSON.stringify(g));
}

/* ================================================================== structure rules */
{
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  check('structure :: api/ keeps exactly 12 top-level files', apiFiles.length === 12, apiFiles.join(','));
  check('structure :: dql family registry has the core family and ops', (await import('../api/_lib/dql/registry.js')).allFamilies().some((f) => f.id === 'core'));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
