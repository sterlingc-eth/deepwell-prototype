/**
 * verify:demo-financials - the money in the public industry demo (/demo/) agrees with itself to the cent, for every industry.
 *   npm run verify:demo-financials                  all industries
 *   npx tsx scripts/verify-demo-financials.ts --only realty,hotel
 * Every industry's sample workspace is recomputed from its documents in whole cents (scripts/lib/demo-financials.ts, which shares no code with the
 * demo's dashboard) and must agree with what the demo computes and shows:
 *   1. a paper's lines add to its subtotal; subtotal + tax is its total; the page's TOTAL is that total; fields and lines are its own figures; every amount is written $1,234.00
 *   2. paid + balance = total; status, due date and payment date are consistent and measured against the demo's pinned "today" (never the real clock)
 *   3. dashboard: billed = collected + open; the aging rows add to open; the customer rows add to the company; overdue is the overdue rows; the demo's own
 *      dashboard code returns exactly these cents (also part-way through the upload)
 *   4. Donovan's sample answers quote exactly the figures of the documents they cite, and add up every document they claim to add up
 *   5. the reader's records (the data the answers were produced from) hold the same totals, subtotals, tax, paid, balance, due dates and statuses
 *   6. the gate bites: a one-cent change in any of these is caught
 * The rendered screens are checked by verify:demo-financials-ui (a real browser). Needs no network, no key, no model call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardOf, daysOverdue, money, billingOf, toCents, type DemoFixture, type DemoIndex } from '../src/demo/engine';
import { auditAnswers, auditIndustry, cents, expectedOf, fmtC } from './lib/demo-financials';
// @ts-expect-error plain JS module
import { DEMO_TODAY } from './demo/demoData.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'src', 'demo', 'fixtures'); const REC = path.join(ROOT, 'scripts', 'fixtures', 'industry-demo');
const argv = process.argv.slice(2); const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1]!.split(',') : null;
let passed = 0; const failures: string[] = [];
const ok = (c: unknown, name: string) => { if (c) passed++; else failures.push(name); };
const load = (slug: string) => ({ fx: JSON.parse(fs.readFileSync(path.join(FX, `${slug}.demo.json`), 'utf8')) as DemoFixture, rec: JSON.parse(fs.readFileSync(path.join(REC, `${slug}.records.json`), 'utf8')) });

const index = JSON.parse(fs.readFileSync(path.join(FX, 'index.json'), 'utf8')) as DemoIndex;
const slugs = index.industries.map((i) => i.slug).filter((s) => !only || only.includes(s));
ok(slugs.length > 0, 'there are industries to check');
ok(fs.readdirSync(FX).filter((f) => f.endsWith('.demo.json')).length === index.industries.length, 'every workspace file is in the picker and every picker entry has a workspace');

/* ------------------------------------------------------------ 1-5: every industry */
let withBills = 0, withoutBills = 0, withOverdue = 0;
const fxs: Array<{ fx: DemoFixture; rec: ReturnType<typeof load>['rec'] }> = [];
for (const slug of slugs) {
  const { fx, rec } = load(slug); fxs.push({ fx, rec });
  const t = `[${slug}]`;
  for (const m of auditIndustry(fx, rec, DEMO_TODAY)) failures.push(m);
  for (const m of auditAnswers(fx)) failures.push(m);
  passed += 1;

  // the demo's own dashboard code agrees with the independent recomputation, to the cent
  const e = expectedOf(fx); const dash = dashboardOf(fx); const b = dash.billing;
  ok((b === null) === (e.invoices === 0), `${t} the demo shows billing figures exactly when the workspace has bills`);
  if (b) {
    withBills++; if (e.overdueInvoices > 0) withOverdue++;
    const same = (x: number, yc: number, what: string) => ok(toCents(x) === yc && Math.abs(x * 100 - yc) < 1e-6, `${t} dashboard ${what}: demo ${money(x)} vs recomputed ${fmtC(yc)}`);
    same(b.billed, e.billedC, 'billed'); same(b.collected, e.collectedC, 'collected'); same(b.open, e.openC, 'open balance'); same(b.overdue, e.overdueC, 'overdue');
    ok(b.invoices === e.invoices && b.openInvoices === e.openInvoices && b.overdueInvoices === e.overdueInvoices, `${t} dashboard bill counts`);
    ok(b.aging.length === e.aging.length && b.aging.every((a, i) => a.label === e.aging[i]!.label && a.invoices === e.aging[i]!.invoices && toCents(a.amount) === e.aging[i]!.amountC), `${t} dashboard aging rows`);
    ok(b.byCustomer.length === e.byCustomer.length && b.byCustomer.every((c, i) => c.name === e.byCustomer[i]!.name && c.invoices === e.byCustomer[i]!.invoices && toCents(c.billed) === e.byCustomer[i]!.billedC && toCents(c.collected) === e.byCustomer[i]!.collectedC && toCents(c.open) === e.byCustomer[i]!.openC), `${t} dashboard customer rows`);
    ok(toCents(dash.billed) === e.billedC && toCents(dash.openBalance) === e.openC && dash.openInvoices === e.openInvoices, `${t} dashboard summary fields`);
    // tiles on screen: billed - collected = open, using the displayed (rounded) strings
    ok(toCents(b.billed) - toCents(b.collected) === toCents(b.open), `${t} Billed - Collected = Open Balance on the tiles`);
    // the documents table: the Open / Overdue pills add to the Open balance tile
    const pillSum = fx.documents.filter((d) => d.pay && d.pay.balance > 0).reduce((a, d) => a + cents(d.pay!.balance), 0);
    ok(pillSum === e.openC, `${t} the Open / Overdue pills in the documents table add to the Open balance`);
  } else {
    withoutBills++;
    ok(toCents(dash.amountsOnFile) === e.amountsOnFileC && dash.amountDocuments === e.amountDocuments, `${t} Amounts on file = the sum of the documents' amounts`);
    ok(fx.documents.every((d) => !d.pay && !d.billable), `${t} no payment status without a bill`);
  }
  ok(billingOf(fx.documents, fx.demoToday) === null ? e.invoices === 0 : true, `${t} billingOf agrees`);
  // part-way through the upload the dashboard still adds up (documents appear one at a time)
  let last = 0;
  for (let k = 0; k <= fx.documents.length; k++) {
    const part = dashboardOf(fx, k); const pe = expectedOf(fx, fx.documents.slice(0, k));
    const pb = part.billing; const billed = pb ? toCents(pb.billed) : 0;
    if ((pb ? billed : 0) !== pe.billedC || (pb ? toCents(pb.open) : 0) !== pe.openC || (pb ? toCents(pb.collected) : 0) !== pe.collectedC || billed < last) { failures.push(`${t} dashboard part-way through the upload (${k} of ${fx.documents.length} documents) differs from the recomputation`); break; }
    last = billed;
  }
  // overdue is computed against the demo's pinned day, not the real clock: moving the real clock changes nothing
  const first = fx.documents.find((d) => d.pay && d.pay.balance > 0);
  if (first) ok(daysOverdue(first, fx.demoToday) === Math.max(0, Math.floor((Date.UTC(+fx.demoToday.slice(0, 4), +fx.demoToday.slice(5, 7) - 1, +fx.demoToday.slice(8, 10)) - Date.UTC(+first.pay!.dueOn.slice(0, 4), +first.pay!.dueOn.slice(5, 7) - 1, +first.pay!.dueOn.slice(8, 10))) / 86400000)), `${t} days overdue are counted from the demo's today`);
}
ok(new Set(fxs.map((x) => x.fx.demoToday)).size <= 1, 'every industry uses the same pinned "today"');
ok(only !== null || withBills >= 30, `most industries have bills to show (${withBills} with, ${withoutBills} without)`);
ok(only !== null || withOverdue >= 25, `most industries with bills show an overdue bill (${withOverdue})`);

/* ------------------------------------------------------------ the demo never reads the real clock */
const demoDir = path.join(ROOT, 'src', 'demo');
for (const f of fs.readdirSync(demoDir).filter((x) => /\.(ts|tsx)$/.test(x) && !['tryown.ts', 'TryOwn.tsx'].includes(x))) {
  const src = fs.readFileSync(path.join(demoDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
  ok(!/Date\.now\s*\(|new Date\s*\(\s*\)|performance\.now|toLocaleDateString|Intl\.DateTimeFormat/.test(src), `src/demo/${f} never reads the real date (overdue and aging use fx.demoToday)`);
}
{
  const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'demo', 'demoData.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  ok(!/Date\.now\s*\(|new Date\s*\(\s*\)/.test(gen), 'the generator never reads the real date');
  ok(/export const DEMO_TODAY = '\d{4}-\d{2}-\d{2}'/.test(gen), 'DEMO_TODAY is a fixed date');
}

/* ------------------------------------------------------------ 6. the gate bites */
const dayGap = (d: DemoFixture['documents'][number]) => Math.round((Date.parse(d.pay!.dueOn) - Date.parse(d.date)) / 86400000);
{
  const pick = fxs.find((x) => x.fx.documents.some((d) => d.billable && d.pay && d.lines && d.tax != null)) ?? fxs[0]!;
  const clone = () => JSON.parse(JSON.stringify(pick)) as typeof pick;
  const caught = (name: string, mutate: (c: typeof pick) => void) => {
    const c = clone(); mutate(c);
    const bad = [...auditIndustry(c.fx, c.rec, DEMO_TODAY), ...auditAnswers(c.fx)];
    const e0 = expectedOf(c.fx); const d0 = dashboardOf(c.fx).billing; const drift = d0 ? toCents(d0.open) !== e0.openC || toCents(d0.billed) !== e0.billedC : false;
    ok(bad.length > 0 || drift, `gate catches: ${name}`);
  };
  const bill = (c: typeof pick) => c.fx.documents.find((d) => d.billable && d.pay && d.lines && d.tax != null)!;
  caught('a total off by one cent', (c) => { bill(c).total! += 0.01; });
  caught('a balance off by one cent', (c) => { bill(c).pay!.balance += 0.01; });
  caught('paid off by one cent', (c) => { bill(c).pay!.paid -= 0.01; });
  caught('a line off by one cent', (c) => { bill(c).lines![0]!.amount += 0.01; });
  caught('tax off by one cent', (c) => { bill(c).tax! += 0.01; });
  caught('the printed TOTAL off by one cent', (c) => { const d = bill(c); d.pages[0] = d.pages[0]!.replace(/TOTAL: \$[\d,.]+/, `TOTAL: ${fmtC(cents(d.total!) + 1)}`); });
  caught('a payment dated before the invoice', (c) => { const d = bill(c); d.pay!.paidOn = '2000-01-01'; if (d.pay!.paid === 0) { d.pay!.paid = 1; d.pay!.balance = d.total! - 1; } });
  caught('a payment dated in the future', (c) => { const d = bill(c); d.pay!.paidOn = '2999-01-01'; if (d.pay!.paid === 0) { d.pay!.paid = 1; d.pay!.balance = d.total! - 1; } });
  caught('the demo "today" moved', (c) => { c.fx.demoToday = '2026-10-21'; });
  caught('a clause giving a different payment deadline than the due date', (c) => { const d = bill(c); d.pages[0] = d.pages[0]!.replace(/\nTOTAL:/, `\nPayment is due within ${dayGap(d) + 7} days of the invoice date.\nTOTAL:`); });
  caught('a clause quoting a lump sum that is not on the paper', (c) => { const d = bill(c); d.pages[0] = d.pages[0]!.replace(/\nTOTAL:/, '\nA late fee of $1,234.56 applies.\nTOTAL:'); });
  caught('a clause quoting a tax rate that is not the paper\'s', (c) => { const d = bill(c); d.pages[0] = d.pages[0]!.replace(/\nTOTAL:/, '\nSales tax of 4% is included.\nTOTAL:'); });
  caught('an amount written without cents on a page', (c) => { const d = bill(c); d.pages[0] += '\nExtra: $1,200'; });
  caught('a money field larger than the total', (c) => { const d = bill(c); d.fields.push(['Deposit', fmtC(cents(d.total!) + 100)]); });
  caught('the records disagree by one cent', (c) => { const r = c.rec.financials.find((x: { total: string | null }) => x.total != null)!; r.total = (Number(r.total) + 0.01).toFixed(2); });
  caught('a document dropped from the records', (c) => { c.rec.documents.pop(); });
  caught('a bill with no payment status', (c) => { bill(c).pay = null; });
  const q = pick.fx.questions.find((x) => x.intent === 'total' || x.intent === 'sum');
  if (q) caught('Donovan quoting a total one cent off', (c) => { const x = c.fx.questions.find((y) => y.id === q.id)!; x.answer.text = x.answer.text.replace(/\$[\d,]+\.\d\d/, (m) => fmtC(cents(Number(m.replace(/[$,]/g, ''))) + 1)); x.answer.headline = null; });
  const sq = pickSum(fxs);
  if (sq) { const { fx: sfx, q: sumQ } = sq; const c = JSON.parse(JSON.stringify(sfx)) as DemoFixture; const x = c.questions.find((y) => y.id === sumQ.id)!; x.answer.docs = x.answer.docs.slice(1); ok(auditAnswers(c).length > 0, 'gate catches: a sum that leaves a document out'); }
}
function pickSum(list: Array<{ fx: DemoFixture }>) { for (const { fx } of list) { const q = fx.questions.find((x) => x.intent === 'sum' && x.answer.docs.length >= 2); if (q) return { fx, q }; } return null; }

console.log(`verify:demo-financials  ${passed} passed, ${failures.length} failed  (${slugs.length} industries; ${withBills} with bills, ${withoutBills} without)`);
for (const f of failures.slice(0, 60)) console.log('  FAIL ' + f);
if (failures.length > 60) console.log(`  ... and ${failures.length - 60} more`);
process.exit(failures.length ? 1 : 0);
