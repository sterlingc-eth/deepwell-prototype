/**
 * Compound questions — api/_lib/decompose/compound.js. One question that asks two or three small things
 * ("how many invoices in 2025 and what was the total") is split into clauses, each clause answered by the
 * existing no-model lanes, and the answers joined in order. If ANY clause cannot be answered the whole
 * question returns null (never a partial answer that looks complete).
 *
 * Same harness as verify-offline-exam.mjs: real migrations in PGlite, the golden export as the data, no network, no key.
 *   node scripts/verify-compound.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
const realError = console.error; console.error = () => {};
const realLog = console.log; const quiet = () => { console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); }; }; quiet();

const off = await import('./offline-exam.mjs');
await off.installPgHarness();
const counter = await off.installModelBlock();
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, exp, { tenantKey: 'verify:compound', tenantName: 'compound' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getPack } = await import('../api/_lib/industry/index.js');
const { classifyDecompose, runDecompose } = await import('../api/_lib/decompose/index.js');
const { parseCompound, completeClause } = await import('../api/_lib/decompose/compound.js');
const pack = getPack('hvac');
const TODAY = '2026-10-07';

async function ask(q) {
  const intent = classifyDecompose(q, { pack });
  if (!intent) return { intent: null, data: null };
  const data = await withTenant(ctx, (db) => runDecompose(db, intent, { today: TODAY }));
  return { intent, data };
}
const blob = (d) => [d?.text, ...(d?.facts ?? []).flatMap((f) => [f.label, f.value])].join(' ');
const has = (d, ...needles) => needles.every((n) => blob(d).replace(/,/g, '').includes(String(n).replace(/,/g, '')));

/* ---------------------------------------------------------------- pure: splitting and carrying */
{
  const p = parseCompound('how many invoices in 2025 and what was the total', pack);
  check('splits a count and a total into two clauses', p?.clauses?.length === 2, JSON.stringify(p));
  check('a plain single question is not split', parseCompound('how many customers have an email and a phone number', pack) === null);
  check('a name with "and" is not split', parseCompound('what is the phone number for Smith and Sons Plumbing', pack) === null);
  check('"A vs B" becomes two full clauses', JSON.stringify(parseCompound('how many pm tickets vs repair tickets do we have', pack)?.clauses) === JSON.stringify(['how many pm tickets do we have', 'how many repair tickets do we have']));
  check('two periods become two clauses', JSON.stringify(parseCompound('compare invoice totals 2024 vs 2025', pack)?.clauses) === JSON.stringify(['invoice totals in 2024', 'invoice totals in 2025']));
  const c = (a, b) => completeClause(a, b, pack)?.text ?? null;
  check('carries the noun and period into "and what was the total"', c('how many invoices in 2025', 'what was the total') === 'what is the total of invoices in 2025', c('how many invoices in 2025', 'what was the total'));
  check('carries a person into "and how many Denise Ford"', c('how many invoices did Kevin Pratt do', 'how many Denise Ford') === 'how many invoices did Denise Ford do', c('how many invoices did Kevin Pratt do', 'how many Denise Ford'));
  check('carries a place into "and how many in Gilbert"', c('how many customers in Tempe', 'how many in Gilbert') === 'how many customers in Gilbert');
  check('carries a year into "and how many in 2026"', c('how many invoices in 2024', 'how many in 2026') === 'how many invoices in 2026');
  check('a clause with its own noun stands alone', c('how many customers do we have', 'how many units') === 'how many units');
  check('a short lookup is about the record the first clause named', c('how much was INV-20075', 'who was the tech') === 'who was the tech for INV-20075');
  check('a bare "and how many" cannot be finished', c('which brand has the most units', 'how many') === null);
  check('an unfinishable clause is null', c('how many invoices in 2025', 'what is the weather') === null);
}

/* ---------------------------------------------------------------- D1 / D5 regressions */
{
  const v = (q) => parseCompound(q, pack)?.clauses ?? null;
  check('D1: month+year carried, only the year swapped', JSON.stringify(v('how many invoices in March 2025 vs 2026')) === JSON.stringify(['how many invoices in March 2025', 'how many invoices in March 2026']), JSON.stringify(v('how many invoices in March 2025 vs 2026')));
  check('D1: full month+year on both sides', JSON.stringify(v('how many invoices in March 2025 vs April 2026')) === JSON.stringify(['how many invoices in March 2025', 'how many invoices in April 2026']));
  const c = (a, b) => completeClause(a, b, pack)?.text ?? null;
  void c;
  const q1 = await ask('how many invoices in 2025 and how many quotes');
  check('D5: second clause keeps the 2025 period (never all-time quotes)', q1.data === null || /2025/.test(blob(q1.data).replace(/\$[\d,.]+/g, '')) && /quote/i.test(q1.data.text) && /2025/.test(q1.data.text.split(/2\./)[1] ?? ''), q1.data?.text);
  const q2 = await ask('how many invoices in 2025, how many quotes, and what was the total');
  check('D5: total after two different nouns is not guessed', q2.data === null, q2.data?.text);
}

/* ---------------------------------------------------------------- two counts */
{
  const { data } = await ask('how many customers in Tempe and how many in Gilbert');
  check('two counts: both numbers, in order, each labelled', Boolean(data) && /1\..*Tempe.*8.*2\..*Gilbert.*8/s.test(data.text), data?.text);
  const r = await ask('how many customers do we have and how many units');
  check('two counts of different things: 120 customers and 132 units', has(r.data, 120, 132), r.data?.text);
}
/* ---------------------------------------------------------------- a count plus a total */
{
  const { data } = await ask('how many invoices in 2025 and what was the total');
  check('count plus total: 8 invoices and $35,210', has(data, 8, '35210.00'), data?.text);
  const r = await ask('compare invoice totals 2024 vs 2025');
  check('year against year: both totals', has(r.data, '28975.00', '35210.00'), r.data?.text);
  const t = await ask('total of proposals and total of maintenance agreements');
  check('two totals of two kinds of paper', has(t.data, '86410.00', '21440.00'), t.data?.text);
}
/* ---------------------------------------------------------------- two lookups on one record / person */
{
  const { data } = await ask('how much was INV-20075 and who was the tech');
  check('two lookups on one invoice: the amount and the technician', has(data, '7875.00', 'Denise Ford'), data?.text);
  const r = await ask('how many invoices did Kevin Pratt do and how many Denise Ford');
  check('same question about two people: 21 and 19', has(r.data, 21, 19) && /Kevin Pratt/.test(r.data?.text) && /Denise Ford/.test(r.data?.text), r.data?.text);
}
/* ---------------------------------------------------------------- one unanswerable clause => null, never a partial answer */
{
  for (const q of [
    'how many customers in Tempe and what is the weather',
    'how many invoices in 2025 and how many warranty claims',
    'how many invoices in 2025 and what was the customer satisfaction score',
    'which brand has the most units and how many',
  ]) {
    const { intent, data } = await ask(q);
    check(`unanswerable clause returns null: "${q}"`, data === null, intent ? blob(data) : 'no intent');
  }
}
check('no model call was attempted anywhere above', counter.n === 0, String(counter.n));

console.log = realLog; console.error = realError;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
