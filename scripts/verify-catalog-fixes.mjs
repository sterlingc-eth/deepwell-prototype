/**
 * Catalog fixes: question templates that used to get a WRONG answer with no model call now answer correctly or release (go to the model / honest decline).
 * Real ask handler, PGlite, golden export as data, no network, no key.   node scripts/verify-catalog-fixes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {}; console.error = () => {};
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); };

const off = await import('./offline-exam.mjs');
await off.installPgHarness();
const counter = await off.installModelBlock();
const { SCORECARD_CALL } = await import('../api/_lib/scorecard/hook.js');
const { createUsageMeter, runWithUsageMeter } = await import('../api/_lib/usage.js');
const { default: askHandler } = await import('../api/ask.js');
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, exp, { tenantKey: 'verify:catalog', tenantName: 'catalog' })).ctx;
const auth = { tenantId: ctx.tenantKey, orgId: 'catalog', userId: null };
function makeRes() { const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; res.headersSent = true; return res; }, end() { res.headersSent = true; return res; } }; return res; }
async function ask(question) {
  counter.n = 0;
  const req = { method: 'POST', headers: {}, query: {}, body: { question, today: '2026-10-07' }, [SCORECARD_CALL]: { auth, escalate: false } };
  const res = makeRes();
  try { await runWithUsageMeter(createUsageMeter(), () => askHandler(req, res)); } catch { /* ignore */ }
  const d = res.body?.success ? res.body.data : null;
  return { text: String(d?.text ?? ''), model: counter.n > 0 };
}
const fin = (exp.financials ?? []).filter((r) => r.doc_kind === 'invoice' && r.direction === 'receivable' && r.currency === 'USD');
const year = (y) => fin.filter((r) => String(r.invoice_date ?? '').startsWith(String(y)));
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const y = [2009, 2010, 2011, 2012, 2013].map((v) => [v, year(v)]).find(([, r]) => r.length >= 2) ?? [2009, year(2009)];
const sum = y[1].reduce((a, r) => a + Number(r.total ?? 0), 0);

let r = await ask('how many different customers have been invoiced');
check('distinct customers invoiced: counts customers, not dollars or invoices', /\d+ customers? \(of \d+\)/.test(r.text) && !/\$/.test(r.text), r.text);
r = await ask('how many customers have never been invoiced');
check('never invoiced: customers with no invoice', /(?:customers? \(of \d+\)|Every customer).*invoice/.test(r.text), r.text);
r = await ask('which year did we write the most invoices');
check('busiest year is named, not a document count', /Busiest year/.test(r.text) && !/^\d+ documents\.?$/.test(r.text), r.text);
r = await ask(`what did we bill in ${y[0]}`);
check(`bill in a year states the total (${money(sum)})`, r.text.replace(/,/g, '').includes(money(sum).replace(/,/g, '')) && /in all/.test(r.text), r.text);
r = await ask('total labor hours across all invoices');
check('labor hours is not answered as an invoice count', !/^You have \d+ invoices\.?$/.test(r.text.trim()), r.text);
r = await ask('the 3 customers with the most invoices');
check('top 3 customers by invoice count honors N', /^Top 3 customers by number of invoices/.test(r.text), r.text);
r = await ask('the 2 customers with the highest proposal totals');
check('top 2 customers by proposal total honors N', /^Top 2 customers by quote amount/.test(r.text), r.text);
r = await ask('the 4 customers with the highest proposal totals');
check('top 4 customers by proposal total honors N', /^Top 4 customers by quote amount/.test(r.text), r.text);
r = await ask('which brand do we sell and install the most of');
check('most-sold brand is not answered with an unranked list', !/brands on file/.test(r.text), r.text);
r = await ask('which brand shows up on the fewest invoices');
check('fewest invoices is not answered with unit counts', !/fewest units/.test(r.text), r.text);
r = await ask('which brand has the fewest units');
check('fewest units still answered from units', /fewest|smallest|tied|brand/i.test(r.text) && !r.model, r.text);
for (const q of ['total labor hours across all invoices', 'which brand shows up on the fewest invoices']) {
  r = await ask(q); check(`released to the model: ${q}`, r.model || r.text === '', JSON.stringify(r));
}
// timing budget: lanes that hand a question back and forth must terminate (this once spun for 60s)
for (const q of ['top 5 cities by number of invoices', 'top 5 cities by number of units', 'top 5 technicians by number of mistakes']) {
  const t0 = Date.now(); r = await ask(q); const ms = Date.now() - t0;
  check(`no spin (<15s): ${q}`, ms < 15000, `${ms}ms`);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
