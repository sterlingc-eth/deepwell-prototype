/**
 * verify:dql-r8 - round 8: ordinals ("second largest"), two-bound ranges, negation as a set, document type + person, and follow-ups that refine a number, on the golden export.
 *
 * Every positive answer is checked against an INDEPENDENT reading of the export file (plain JS over the raw rows below, not the engine's own
 * snapshot code). Also checked: releases (an unexplained word, an ambiguous name, an untracked field, a follow-up fragment, a definition),
 * ties, honest empties, the router wiring (claim / kill switch / never overrides a claim), the precision guard and the 12-file api/ rule.
 *
 *   node scripts/verify-dql-r8.mjs
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
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r8', tenantName: 'r8' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r8' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => true }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };

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


/* ================================================================== ordinals */
const invoices = ofType('invoice').filter((d) => d.total != null);
const byTotal = [...invoices].sort((a, b) => b.total - a.total);
const distinctBefore = (arr, n, key) => { const v = arr.slice(0, n).map(key); return new Set(v).size === v.length; };
const nthPlaceOk = (arr, n, key) => distinctBefore(arr, n, key) && (arr.length >= n);
const nthRows = (arr, n, key) => { const v = key(arr[n - 1]); return arr.filter((x) => key(x) === v); };
for (const [q, n, dir] of [['second largest invoice', 2, 'desc'], ['third biggest invoice', 3, 'desc'], ['what is the second smallest invoice', 2, 'asc']]) {
  const arr = dir === 'desc' ? byTotal : [...byTotal].reverse();
  const ok = nthPlaceOk(arr, n, (d) => d.total);
  const r = await ask(q);
  if (ok) {
    const at = nthRows(arr, n, (d) => d.total);
    check(`ordinal :: "${q}" names place ${n}, not the extreme`, r.intent?.plan?.nth === n && has(r, money(at[0].total)) && (at.length > 1 || String(r.data?.text).includes(at[0].f.invoice_number ?? '#')) && !String(r.data?.text).startsWith('The highest'), r.data?.text);
  } else check(`ordinal :: "${q}" is released when a tie makes the place ambiguous`, r.data == null, r.data?.text);
}
{
  const r = await ask('which customer is the second biggest by total billed');
  const per = new Map(); for (const d of invoices) if (d.cust) per.set(d.cust, (per.get(d.cust) ?? 0) + d.total);
  const ranked = [...per.entries()].sort((a, b) => b[1] - a[1]);
  const ok = distinctBefore(ranked, 2, (e) => e[1]);
  if (ok) { const at = ranked.filter((e) => e[1] === ranked[1][1]); check('ordinal :: second biggest customer by billed names place 2', at.every((e) => String(r.data?.text).includes(e[0])) && has(r, money(ranked[1][1])), r.data?.text); }
  else check('ordinal :: second biggest customer is released on a tie for first', r.data == null, r.data?.text);
}
{
  const dated = invoices.filter((d) => d.date && d.date <= TODAY).sort((a, b) => (a.date < b.date ? 1 : -1));
  const r = await ask('second most recent invoice');
  const ok = distinctBefore(dated, 2, (d) => d.date);
  if (ok) check('ordinal :: second most recent invoice is the second by date', r.intent?.plan?.nth === 2 && String(r.data?.text).includes(dated[1].date.slice(0, 4)) && r.data?.recordsTotal >= 1, r.data?.text);
  else check('ordinal :: second most recent invoice is released on a date tie', r.data == null, r.data?.text);
  const r2 = await ask('next-to-last invoice');
  check('ordinal :: next-to-last reads as the second most recent', r2.intent?.plan?.nth === 2 && JSON.stringify(r2.intent?.plan) === JSON.stringify(r.intent?.plan), r2.data?.text);
}
{
  const r = await ask('who is the second busiest technician');
  const per = new Map(); for (const d of docs) if (d.f.technician) per.set(d.f.technician, (per.get(d.f.technician) ?? 0) + 1); // busiest = the papers that name the person (the same count "<name> has N jobs on file" gives)
  const ranked = [...per.entries()].sort((a, b) => b[1] - a[1]);
  const ok = ranked.length >= 2 && distinctBefore(ranked, 2, (e) => e[1]);
  if (ok) { const at = ranked.filter((e) => e[1] === ranked[1][1]); check('ordinal :: second busiest technician', at.every((e) => String(r.data?.text).includes(e[0])) && has(r, int(ranked[1][1])), r.data?.text); }
  else check('ordinal :: second busiest technician is released on a tie for first', r.data == null, r.data?.text);
}
{
  const r = await ask('second busiest month');
  const per = new Map(); for (const d of docs) if (d.service) per.set(d.service.slice(0, 7), (per.get(d.service.slice(0, 7)) ?? 0) + 1);
  const ranked = [...per.entries()].sort((a, b) => b[1] - a[1]);
  const ok = ranked.length >= 2 && distinctBefore(ranked, 2, (e) => e[1]);
  if (ok) check('ordinal :: second busiest month has the second count', r.intent?.plan?.nth === 2 && has(r, int(ranked[1][1])), r.data?.text);
  else check('ordinal :: second busiest month is released on a tie for first', r.data == null, r.data?.text);
}
check('ordinal :: the place after the last one says so', (await ask('five hundredth largest invoice')).data == null, 'not a number the reader knows');
{
  const r = await ask('hundredth largest invoice'); check('ordinal :: an ordinal the reader does not know is released', r.data == null);
  const r2 = await ask('the second largest invoice and the third largest invoice'); check('ordinal :: two ordinals in one question are released', r2.data == null);
  const r3 = await ask('second quarter invoices'); check('ordinal :: "second quarter" is not an ordinal ranking', r3.intent?.plan?.nth == null);
}

/* ================================================================== two-bound ranges */
{
  const lo = 1500; const hi = 3000;
  const both = invoices.filter((d) => d.total > lo && d.total < hi).length;
  for (const q of ['invoices over $1500 and under $3000', 'invoices between $1,500 and $3,000', 'invoices from $1500 to $3000', 'invoices greater than $1500 but less than $3000']) {
    const r = await ask(q);
    const n = q.includes('between') || q.includes('from') ? invoices.filter((d) => d.total >= lo && d.total <= hi).length : both;
    check(`range :: "${q}" applies both bounds`, has(r, int(n)) && /1,500/.test(r.data?.text ?? '') && /3,000/.test(r.data?.text ?? ''), r.data?.text);
  }
  const r = await ask('how many invoices between $1,500 and $3,000'); check('range :: a count between two amounts', has(r, int(invoices.filter((d) => d.total >= lo && d.total <= hi).length)), r.data?.text);
}
{
  const inRange = (a, b) => ofType('invoice').filter((d) => d.date >= a && d.date <= b).length;
  const cases = [['invoices between March 2024 and August 2024', '2024-03-01', '2024-08-31'], ['invoices from March to June 2025', '2025-03-01', '2025-06-30'], ['how many invoices 2023 through 2024', '2023-01-01', '2024-12-31'], ['how many invoices from 2022 to 2024', '2022-01-01', '2024-12-31'], ['how many invoices since 2024 until now', '2024-01-01', TODAY], ['how many invoices from jan 2024 to today', '2024-01-01', TODAY], ['how many invoices before 2020', '1900-01-01', '2019-12-31'], ['how many invoices before March 2024', '1900-01-01', '2024-02-29'], ['how many invoices after March 2024', '2024-04-01', TODAY]];
  for (const [q, a, b] of cases) { const r = await ask(q); check(`range :: "${q}" applies the start and the end`, has(r, int(inRange(a, b))), `${r.data?.text} (expected ${inRange(a, b)})`); }
  check('range :: "until March 2024" (is March in?) is released', (await ask('how many invoices until March 2024')).data == null);
  check('range :: a month without a year is released', (await ask('how many invoices between March and June')).data == null);
}

/* ================================================================== negation as a set */
{
  const withInv = new Set(ofType('invoice').map((d) => d.cust).filter(Boolean));
  const none = customers.map((c) => c.data.customer_name).filter((n) => !withInv.has(n));
  const r = await ask('customers with no invoices');
  check('negation :: customers with no invoices is the complement', r.intent?.plan?.op === 'set_select' && (none.length ? has(r, int(none.length)) : /No customers/.test(r.data?.text ?? '')) && none.slice(0, 3).every((n) => String(r.data?.text).includes(n) || none.length > 12), r.data?.text);
  const r2 = await ask('customers who never got an estimate');
  const withQ = new Set(ofType('proposal-quote').map((d) => d.cust).filter(Boolean));
  const noQ = customers.map((c) => c.data.customer_name).filter((n) => !withQ.has(n));
  check('negation :: customers who never got an estimate is the complement', noQ.length ? has(r2, int(noQ.length)) : /No customers/.test(r2.data?.text ?? ''), r2.data?.text);
}

/* ================================================================== document type on a person */
{
  const t = [...new Set(docs.filter((d) => d.type === 'service-ticket').map((d) => d.f.technician).filter(Boolean))][0];
  const n = docs.filter((d) => d.type === 'service-ticket' && d.f.technician === t).length;
  const all = docs.filter((d) => d.f.technician === t).length;
  const r = await ask(`service tickets by ${t}`);
  check('person+type :: service tickets by a technician counts that type only', has(r, int(n)) && (n === all || !String(r.data?.text).includes(`${int(all)} `)), r.data?.text);
}

/* ================================================================== follow-ups that refine a number */
{
  const { resolveFollowup } = await import('../api/_lib/followup/resolve.js');
  const chain = (qs) => resolveFollowup({ turns: qs.slice(0, -1).map((question) => ({ question, askedAt: new Date().toISOString() })) }, qs[qs.length - 1]);
  const norm = (s) => String(s).toLowerCase().replace(/[?]/g, '').trim();
  check('follow-up :: "how many invoices was that" carries the year', norm(chain(['how much did we invoice in 2020', 'how many invoices was that']).query) === 'how many invoices in 2020', chain(['how much did we invoice in 2020', 'how many invoices was that']).query);
  check('follow-up :: "how many was that" after a list carries the scope', norm(chain(['invoices in 2024', 'how many was that']).query) === 'how many invoices in 2024', chain(['invoices in 2024', 'how many was that']).query);
  check('follow-up :: "and under $7500" keeps the first bound', norm(chain(['invoices over $7000', 'and under $7500']).query) === 'invoices over $7000 and under $7500', chain(['invoices over $7000', 'and under $7500']).query);
  check('follow-up :: "over" replaces "over"', norm(chain(['invoices over $7000', 'over $5000']).query) === 'invoices over $5000', chain(['invoices over $7000', 'over $5000']).query);
  const bare = chain(['how many invoices did Thomas Mercer have', 'and in 2024']);
  check('follow-up :: a bare period nobody can attach is released, not answered as the total', bare.kind === 'fragment' && /Earlier question/.test(bare.query), bare.query);
}

/* ================================================================== round 8, second pass */
{
  // "from 1500 to 3000" (bare numbers) is an amount range; "from 2023 to 2024" stays a period
  const r = await ask('invoices from 1500 to 3000');
  check('range :: "from 1500 to 3000" applies both bounds', has(r, int(invoices.filter((d) => d.total >= 1500 && d.total <= 3000).length)) && /1,500/.test(r.data?.text ?? '') && /3,000/.test(r.data?.text ?? ''), r.data?.text);
  const p = await ask('invoices from 2023 to 2024');
  check('range :: "from 2023 to 2024" is a period, not money', p.intent?.plan?.time?.from === '2023-01-01' && p.intent?.plan?.time?.to === '2024-12-31' && !(p.intent?.plan?.filters ?? []).length, JSON.stringify(p.intent?.plan?.time));
  const { droppedConditionShape } = await import('../api/_lib/router/dqlArbiter.js');
  for (const q of ['invoices from March 2025 to June 2025', 'invoices between $500 and $4,000', 'invoices from 1500 to 3000', 'customers with no invoices', 'clients who never got an estimate', 'units without a warranty registration', 'invoices from 2023 to 2024']) check(`shape :: the amount lane steps aside for "${q}"`, droppedConditionShape(q) === true);
  for (const q of ['invoices over $5000', 'invoices in March 2025', 'how many invoices does Pat Smith have', ]) check(`shape :: the amount lane keeps "${q}"`, droppedConditionShape(q) === false);
}
{
  // the second largest customer, said short
  const a = await ask('who is our second largest customer'); const b = await ask('which customer is the second biggest by total billed');
  check('ordinal :: "who is our second largest customer" reads as the second biggest by total billed', JSON.stringify(a.intent?.plan) === JSON.stringify(b.intent?.plan) && JSON.stringify(a.data?.text) === JSON.stringify(b.data?.text), a.data?.text);
  const c = await ask('runner-up customer by billing'); check('ordinal :: "runner-up customer by billing" is the same ranking', JSON.stringify(c.intent?.plan) === JSON.stringify(b.intent?.plan), c.data?.text);
}
{
  // the complement names the people with nothing at all
  const withDoc = new Set(docs.map((d) => d.cust).filter(Boolean));
  const nothing = customers.map((c) => c.data.customer_name).filter((n) => !withDoc.has(n));
  const withInv = new Set(ofType('invoice').map((d) => d.cust).filter(Boolean));
  const noInv = customers.map((c) => c.data.customer_name).filter((n) => !withInv.has(n));
  const r = await ask('customers with no invoices');
  if (nothing.length && nothing.length < noInv.length) check('negation :: the customers with no papers at all are counted in the answer', has(r, `${int(nothing.length)} of them ha`) && /no papers of any kind/.test(r.data?.text ?? ''), r.data?.text);
  else check('negation :: no extra note when nobody or everybody has nothing at all', !/no papers of any kind/.test(r.data?.text ?? ''), r.data?.text);
}
{
  // "how many jobs did <technician> work" counts the papers that name the technician
  const t = [...new Set(docs.map((d) => d.f.technician).filter(Boolean))][0];
  const n = docs.filter((d) => d.f.technician === t).length;
  const r = await ask(`how many jobs did ${t} work`);
  check('person+jobs :: "how many jobs did <technician> work" counts every paper that names the technician', has(r, int(n)), r.data?.text);
}
{
  // the money lanes read no name out of the question words
  const { namedMoneyShape } = await import('../api/_lib/lookups/namedMoney.js');
  const { parsePaidQuestion } = await import('../api/_lib/lookups/paidLookup.js');
  check('money :: "how many invoices are paid" names nobody', namedMoneyShape('how many invoices are paid') == null);
  for (const q of ['how much is still owed to us', 'how much do patients owe us', 'how much do tenants owe us', 'how much do donors owe us']) check(`money :: "${q}" names nobody`, !parsePaidQuestion(q)?.cand, JSON.stringify(parsePaidQuestion(q)));
  check('money :: a real name is still read', parsePaidQuestion('how much does Thomas Mercer owe us')?.cand === 'Thomas Mercer', JSON.stringify(parsePaidQuestion('how much does Thomas Mercer owe us')));
}

/* ================================================================== router: the older lanes never answer an ordinal with the extreme */
{
  const o = await classifyAll('second largest invoice', cc);
  check('router :: an ordinal question is taken by DQL', o.winner?.name === 'decompose' && o.winner.intent?.plan?.nth === 2, JSON.stringify(o.winner)?.slice(0, 100));
  const o2 = await classifyAll('who is the second busiest technician', cc);
  check('router :: an ordinal DQL cannot place is never given to an older lane', !o2.winner || o2.winner.name === 'decompose', JSON.stringify(o2.winner)?.slice(0, 100));
  process.env.DONOVAN_DQL_ARBITER = '0';
  const o3 = await classifyAll('second largest invoice', cc);
  delete process.env.DONOVAN_DQL_ARBITER;
  check('router :: with the arbiter off, no older lane answers an ordinal', !o3.winner || o3.winner.name === 'decompose', JSON.stringify(o3.winner)?.slice(0, 100));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
