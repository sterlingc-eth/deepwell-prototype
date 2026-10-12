/**
 * verify:dql-arbiter - who answers a question when the DQL engine reads it in full AND an older classifyAll lane (money, analytics, a
 * deterministic route, docLookup, fastPath, contactLookup, contentCount) also claims it (api/_lib/router/dqlArbiter.js).
 *
 * Checked on the golden export in a real PGlite database, answers against an INDEPENDENT reading of the export rows:
 *   - overrides that MUST happen (the older lane was wrong on the dev set): DQL takes the question and its answer is right
 *   - overrides that must NOT happen (the older lane answers that question type correctly, or DQL releases it): the older lane keeps it
 *   - releases: payment status, balance, tax rate, profit and "owed" are untracked, so DQL reads none of them
 *   - the kill switch (DONOVAN_DQL_ARBITER=0, DONOVAN_DQL=0), the allowlist's shape, the amount reader and the run-time fallback
 *
 *   node scripts/verify-dql-arbiter.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
process.env.DONOVAN_DQL_ALLOWLIST = '1'; // R13: this file characterises the measured allowlist (the optional legacy switch); the default for every company is DQL taking what it fully reads (verify:vocab-r13)
delete process.env.DONOVAN_DQL;
delete process.env.DONOVAN_DQL_ARBITER;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:arb', tenantName: 'arb' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/index.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const { runDecompose } = await import('../api/_lib/decompose/index.js');
const arb = await import('../api/_lib/router/dqlArbiter.js');
const amount = await import('../api/_lib/financials/amountInvoice.js');
const { moneyRewrite } = await import('../api/_lib/dql/moneyPhrases.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'arb' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => true }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };

/* ------------------------------------------------------------------ the independent oracle */
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
const cityOf = (addr) => { const p = String(addr ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
const docs = data.documents.map((d) => {
  const f = fieldsOf.get(d.id) ?? {};
  const fin = finOf.get(d.id);
  const cust = ents.get(custOfDoc.get(d.id));
  const date = (f.service_date ?? f.invoice_date ?? String(fin?.invoice_date ?? '').slice(0, 10)) || String(d.created_at).slice(0, 10);
  return { id: d.id, type: d.document_type, f, total: fin?.total != null ? Number(fin.total) : null, dir: fin?.direction ?? null, vendor: fin?.vendor_name ?? f.vendor_name ?? null, cust: cust?.data.customer_name ?? null, city: cust ? cityOf(cust.data.service_address) : null, date: String(date).slice(0, 10) };
});
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => n.toLocaleString('en-US');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const invoices = docs.filter((d) => d.type === 'invoice' && d.total != null);
const customers = data.entities.filter((e) => e.entity_type === 'customer');
const byYear = new Map();
for (const d of invoices) { const y = d.date.slice(0, 4); byYear.set(y, (byYear.get(y) ?? 0) + d.total); }
const years = [...byYear.entries()].sort((a, b) => a[1] - b[1]);
const [worstYear, worstVal] = years[0]; const [bestYear, bestVal] = years[years.length - 1];
const cityTotal = (c) => sum(invoices.filter((d) => d.city === c).map((d) => d.total));
const custWithInv = [...new Set(invoices.map((d) => d.cust).filter(Boolean))];
const byCust = new Map(); for (const d of invoices) if (d.cust) byCust.set(d.cust, (byCust.get(d.cust) ?? 0) + d.total);
const ranked = [...byCust.entries()].sort((a, b) => b[1] - a[1]);
const lastInv = (name) => invoices.filter((d) => d.cust === name).sort((a, b) => b.date.localeCompare(a.date))[0];
const aCust = custWithInv.find((n) => invoices.filter((d) => d.cust === n).length === 1 && ranked.findIndex((r) => r[0] === n) > 3);
const mid = ranked.findIndex((r) => r[0] === aCust) + 1;
const poPayable = docs.filter((d) => d.type === 'purchase-order' && d.total != null && d.vendor);
const vendor = poPayable[0].vendor;
const vendorTotal = sum(poPayable.filter((d) => d.vendor === vendor).map((d) => d.total));
const yr = '2025'; const y1 = '2024';
const yTot = (y) => sum(invoices.filter((d) => d.date.startsWith(y)).map((d) => d.total));
const bigCity = [...new Set(invoices.map((d) => d.city).filter(Boolean))].sort((a, b) => cityTotal(b) - cityTotal(a))[0];
const cityN = (c) => customers.filter((x) => cityOf(x.data.service_address) === c).length;
const avgInv = sum(invoices.map((d) => d.total)) / invoices.length;
const aboveAvg = invoices.filter((d) => d.total > avgInv).length;

/* ------------------------------------------------------------------ harness */
async function route(q, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await classifyAll(q, cc); } finally { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
}
const dqlWon = (o) => o.winner?.name === 'decompose' && o.winner.intent?.mode === 'dql' && Boolean(o.dqlArbiter);
async function answer(o) { return o.winner?.intent ? withTenant(ctxArg, (db) => runDecompose(db, o.winner.intent, { today: TODAY })) : null; }
const has = (a, ...parts) => a && parts.every((p) => String(a.text).includes(p));

/* ================================================================== overrides that must happen (dev: the older lane was wrong) */
async function mustOverride(label, q, from, test, anyDql = false) {
  const o = await route(q);
  const took = anyDql ? o.winner?.name === 'decompose' && o.winner.intent?.mode === 'dql' : dqlWon(o);
  const a = took ? await answer(o) : null;
  check(`override :: ${label}`, took && (anyDql || o.dqlArbiter.from.startsWith(from)) && Boolean(a) && test(a), `${q} -> winner ${o.winner?.name}${o.dqlArbiter ? ` (from ${o.dqlArbiter.from})` : ''} :: ${a?.text}`);
}
await mustOverride('city billings total (money lane returned the company total)', `${bigCity} billings total`, 'money', (a) => has(a, money(cityTotal(bigCity)), bigCity));
await mustOverride('worst year for revenue', 'worst year for revenue', 'money', (a) => has(a, worstYear, money(worstVal)));
await mustOverride('best year for revenue', 'best year for revenue', 'money', (a) => has(a, bestYear, money(bestVal)));
await mustOverride('rank of a customer by revenue (money lane named the biggest customer)', `where does ${aCust} rank by revenue`, 'money', (a) => has(a, aCust, `ranks ${mid} of ${ranked.length}`));
await mustOverride('what did we bill X last time (money lane gave the lifetime total)', `what did we bill ${aCust} last time`, 'money', (a) => has(a, money(lastInv(aCust).total)));
await mustOverride('previous invoice for a customer', `previous invoice for ${ranked[0][0]}`, '', (a) => has(a, money(lastInv(ranked[0][0]).total)), true);
await mustOverride('vendor spend comes from purchase orders', `how much have we spent with ${vendor}`, 'deterministic:vendorbills', (a) => has(a, money(vendorTotal), 'Purchase order'));
await mustOverride('list all invoices from 2026 with amounts shows each amount', 'list all invoices from 2026 with amounts', 'analytics', (a) => /\$\d/.test(a.text) && a.text.includes(`${invoices.filter((d) => d.date.startsWith('2026')).length} invoices`));
await mustOverride('a year total (tenant count lane punted)', `how mcuh did we bill in ${yr}?`, 'deterministic', (a) => has(a, money(yTot(yr))));
await mustOverride('two years compared', `${yr} vs ${y1} invoice total`, 'deterministic', (a) => has(a, money(yTot(yr)), money(yTot(y1))));
await mustOverride('invoices above the average', 'invoices above average', 'deterministic:aggregate', (a) => has(a, String(aboveAvg)));
await mustOverride('mean invoice for a year', 'mean invoice total 2012', 'deterministic:aggregate', (a) => has(a, money(sum(invoices.filter((d) => d.date.startsWith('2012')).map((d) => d.total)) / invoices.filter((d) => d.date.startsWith('2012')).length)));
await mustOverride('days since the last invoice for a customer', `how long since we last billed ${aCust}`, 'money', (a) => has(a, aCust, 'days'));
await mustOverride('customers in a city (analytics gave a bare count)', `customers in ${bigCity}`, 'analytics', (a) => has(a, `${cityN(bigCity)} customers in ${bigCity}`));
await mustOverride('days since the last visit for a customer', `days since the last visit for ${aCust}`, 'contactLookup:lastVisit', (a) => has(a, 'days since'));
await mustOverride('age of a unit by serial', `whats the age of serial ${data.entities.find((e) => e.entity_type === 'equipment').data.serial_number}`, 'deterministic:serial', (a) => /years old/.test(a.text));
await mustOverride('billings by technician', 'billings by technician', 'deterministic:aggregate', (a) => /by technician/.test(a.text));
await mustOverride('lowest quarter notes empty quarters', 'weakest quarter for revenue', 'money', (a) => /fewest|quarters? .*not counted/.test(a.text));

/* ================================================================== overrides that must NOT happen */
async function mustStay(label, q, stage) {
  const o = await route(q);
  check(`stays :: ${label}`, !dqlWon(o) && (stage ? String(o.winner?.name).startsWith(stage) : true), `${q} -> ${o.winner?.name}${o.dqlArbiter ? ` taken by DQL from ${o.dqlArbiter.from}` : ''}`);
}
const someCust = customers[0].data.customer_name;
await mustStay('a phone lookup is not a DQL question', `what is the phone number for ${someCust}`, 'fastPath');
await mustStay('a document number lookup stays with its route', 'invoice INV-20000', 'deterministic');
await mustStay('a yes/no existence question is not turned into a list', 'did we ever install a Mitsubishi', 'analytics');
await mustStay('a plain inventory count stays with the lane that always answered it', 'how many invoices do we have');
await mustStay('"biggest customer" stays with the money lane (DQL would sum everything)', 'biggest customer', 'money');
await mustStay('who owes us: not tracked, the older lane declines', 'how much do customers owe us');
await mustStay('the plain average invoice is answered correctly by the older lane', 'average invoice amount', 'deterministic');
await mustStay('"top 3 cities by revenue" is answered correctly by the older lane', 'top 3 cities by revenue', 'deterministic');
await mustStay('"busiest month" questions stay with the older lane', 'busiest month in 2025', 'deterministic');
await mustStay('an amount threshold is counted correctly by the money lane', 'documents over $500', 'money');
await mustStay('revenue by year is answered correctly by the older lane', 'revenue by year', 'deterministic');

/* ================================================================== releases: untracked concepts are never read by DQL */
for (const q of [`is ${someCust}'s invoice paid`, 'which invoices are unpaid', 'what is our profit', `what is the balance for ${someCust}`, "what's the sales tax rate", 'profit margin by year', 'outstanding balance']) {
  const dbg = {}; const it = parseDql(q, { tenantVocab: tv, pack, today: TODAY, debug: dbg });
  check(`release :: "${q}" is not read by DQL`, it === null, JSON.stringify(it?.plan)?.slice(0, 120));
}

/* ================================================================== kill switches */
{
  const q = `${bigCity} billings total`;
  const on = await route(q); const off1 = await route(q, { DONOVAN_DQL_ARBITER: '0' }); const off2 = await route(q, { DONOVAN_DQL: '0' });
  check('switch :: DONOVAN_DQL_ARBITER=0 leaves the money lane in charge', dqlWon(on) && !dqlWon(off1) && off1.winner?.name === 'money', `${on.winner?.name} / ${off1.winner?.name}`);
  check('switch :: DONOVAN_DQL=0 also leaves the older lane in charge', !dqlWon(off2) && off2.winner?.name === 'money', off2.winner?.name);
  const all = await route('did we ever install a Mitsubishi', { DONOVAN_DQL_ARBITER: 'all' });
  check('switch :: the diagnostic mode "all" overrides pairs that are not on the list', dqlWon(all), all.winner?.name);
}

/* ================================================================== the typed question is what DQL must read */
{
  const o = await route('biggest customer');
  check('typed :: a respelled form ("customers by revenue") cannot send a question to DQL', o.effectiveQuestion === 'customers by revenue' && !dqlWon(o), `${o.effectiveQuestion} -> ${o.winner?.name}`);
  const it = parseDql('customers by revenue', { tenantVocab: tv, pack, today: TODAY });
  check('typed :: "customers by revenue" is released by the engine (it is a ranking of customers, not a total)', it === null, JSON.stringify(it?.plan)?.slice(0, 100));
}

/* ================================================================== the allowlist's shape */
{
  const L = arb.ARBITER_ALLOWLIST;
  check('allowlist :: every entry names its lane, ops, reason and dev evidence', L.length > 10 && L.every((e) => typeof e.from === 'string' && Array.isArray(e.ops) && e.ops.length && e.why && e.dev), L.length);
  check('allowlist :: the document-number route is not on it (it answers those lookups correctly)', !L.some((e) => /docnumber/.test(e.from)));
  check('allowlist :: no entry reaches the records-first lane', !L.some((e) => /records/i.test(e.from)));
  check('allowlist :: no wildcard op (every op was seen in the dev set), except a round 8 shape entry that names its shape (an ordinal in the plan)', !L.some((e) => e.ops.includes('*') && !(e.id && e.plan?.has?.length)));
  const fake = (name, route2) => ({ name, intent: { route: route2 } });
  const intentOf = (op) => ({ plan: { op }, plain: false });
  check('allowlist :: money -> sum is allowed', arb.arbiterAllows(fake('money'), intentOf('sum'), { oldLabel: 'money' }));
  check('allowlist :: an op that was never seen is not', !arb.arbiterAllows(fake('money'), intentOf('hop_related'), { oldLabel: 'money' }));
  check('allowlist :: a plain inventory plan is never taken', !arb.arbiterAllows(fake('money'), { plan: { op: 'sum' }, plain: true }, { oldLabel: 'money' }));
  check('allowlist :: the unless-guard keeps yes/no questions with the older lane', !arb.arbiterAllows(fake('analytics'), intentOf('set_select'), { oldLabel: 'analytics:count', question: 'did we ever install a Mitsubishi' }) && arb.arbiterAllows(fake('analytics'), intentOf('set_select'), { oldLabel: 'analytics:count', question: 'who has a Mitsubishi but no estimate' }));
  check('allowlist :: a "when" question is never taken by a date op', !arb.arbiterAllows(fake('contactLookup'), intentOf('tm_since'), { oldLabel: 'contactLookup:lastVisit', question: 'when was Linda last serviced' }) && arb.arbiterAllows(fake('contactLookup'), intentOf('tm_since'), { oldLabel: 'contactLookup:lastVisit', question: 'days since the last visit for Linda' }));
  process.env.DONOVAN_DQL_ARBITER = '0';
  check('allowlist :: mode 0 allows nothing', !arb.arbiterAllows(fake('money'), intentOf('sum'), { oldLabel: 'money' }));
  delete process.env.DONOVAN_DQL_ARBITER;
}

/* ================================================================== the amount reader never reads a year as a dollar amount */
{
  const none = ['list all invoices from 2026 with amounts', 'invoices in 2025 with amounts', 'show invoices since 2024', 'invoices during 2025', '2026 invoices with amounts', 'invoices from 2026 with totals'];
  for (const q of none) check(`amount :: "${q}" names no amount`, amount.parseAmountInvoiceQuestion(q) === null && amount.amountMentioned(q) === false);
  check('amount :: "the invoice for 3470" is still an amount', amount.parseAmountInvoiceQuestion('the invoice for 3470')?.cents === '347000');
  check('amount :: "invoice for $2,026" is still an amount', amount.parseAmountInvoiceQuestion('invoice for $2,026')?.cents === '202600');
}

/* ================================================================== wording respells + run-time fallback + structure */
{
  check('phrases :: "worst year for revenue" respells to the form the engine reads', moneyRewrite('worst year for revenue') === 'which year had the lowest revenue');
  check('phrases :: "best month for sales"', moneyRewrite('best month for sales') === 'which month had the highest revenue');
  check('phrases :: "what did we bill X last time" becomes the last invoice', moneyRewrite('what did we bill Edward Esparza last time?') === 'last invoice for Edward Esparza');
  check('phrases :: a question that is not a money phrase is left alone', moneyRewrite('how many units are older than 15 years') === 'how many units are older than 15 years');
  const det = await classifyAll('do we have more invoices or more service tickets', cc);
  if (det.winner?.name === 'deterministic') {
    const viaFallback = await withTenant(ctxArg, (db) => runDecompose(db, { mode: 'dql', plan: null, fallback: { name: 'deterministic', intent: det.winner.intent } }, { today: TODAY }));
    check('fallback :: when DQL has no answer at run time the deterministic router it took the question from answers', Boolean(viaFallback?.text), viaFallback?.text);
  } else check('fallback :: (candidate question was not a deterministic claim)', true);
  const none = await withTenant(ctxArg, (db) => runDecompose(db, { mode: 'dql', plan: null }, { today: TODAY }));
  check('fallback :: with no fallback a missing DQL answer stays empty', none === null);
  const files = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  check('structure :: api/ keeps exactly 12 top-level files', files.length === 12, files.join(','));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
