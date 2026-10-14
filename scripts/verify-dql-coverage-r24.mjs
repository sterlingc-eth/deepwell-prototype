/**
 * verify:dql-coverage-r24 - general coverage words for the DQL coverage rule (api/_lib/dql/parse.js, unwrap.js).
 *
 *   1. a role noun right before a resolved name ("the client Linda Fitzgerald") is only a label of that name
 *   2. "total count / overall tally / headcount of X" is the count of X
 *   3. two relative spans joined by "and" ("this year and last year") are the two sides of a comparison: both are answered
 *   4. a spoken "so" lead-in before a question that stands alone; a "so" that points back (it, those, same, again, what about) stays released
 *   5. wrapped questions: pictures, "Mr." greetings and sign-off names are inert; counts, sums and rankings with a period are answered once unwrapped,
 *      kinds that were measured below the bar (group counts, a paper's person) stay with the model
 *   7. nothing that carries a condition, a second question, a payment status or a forecast is ever answered by these rules
 *   8. kill switches
 *
 *   node scripts/verify-dql-coverage-r24.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };

delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL; delete process.env.DONOVAN_DQL_UNWRAP; delete process.env.R24_SO_LEAD; delete process.env.R24_MULTI_LEFT;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:cov24', tenantName: 'cov24' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/index.js');
const { compileVocab } = await import('../api/_lib/dql/vocab.js');
const U = await import('../api/_lib/dql/unwrap.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'cov24' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const ask = (q, extra = {}) => parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q, ...extra });
const planOf = (q, extra) => { const r = ask(q, extra); return r && !r.plain ? JSON.stringify(r.plan) : null; };
const opOf = (q) => { const r = ask(q); return r && !r.plain ? r.plan.op : null; };

/* ---------- 1. a role noun before a resolved name */
for (const role of ['customer', 'client']) {
  for (const [lab, plain] of [
    [`how many invoices for the ${role} Linda Fitzgerald`, 'how many invoices for Linda Fitzgerald'],
    [`how many estimates for ${role} Linda Fitzgerald`, 'how many estimates for Linda Fitzgerald'],
    [`what is the total of invoices for the ${role} Linda Fitzgerald`, 'what is the total of invoices for Linda Fitzgerald'],
    [`how many invoices in 2023 for the ${role} named Linda Fitzgerald`, 'how many invoices in 2023 for Linda Fitzgerald'],
  ]) { const p = planOf(plain); check(`plain question is answered: ${plain}`, p != null); check(`role label reads the plain plan: ${lab}`, p != null && planOf(lab) === p, planOf(lab) == null ? 'released' : 'plan differs'); }
}
check('plural role noun is still a thing asked about: "how many customers Linda Fitzgerald" is not an invoice count', planOf('how many customers Linda Fitzgerald') !== planOf('how many invoices for Linda Fitzgerald'));
check('"how many customers does Linda Fitzgerald have" is not read as an invoice count', planOf('how many customers does Linda Fitzgerald have') !== planOf('how many invoices for Linda Fitzgerald'));

/* ---------- 2. total count / overall tally */
for (const [a, b] of [
  ['overall tally of invoices in 2022', 'how many invoices in 2022'],
  ['what is the total count of invoices in 2023', 'how many invoices in 2023'],
  ['total count of invoices for Linda Fitzgerald in 2023', 'how many invoices for Linda Fitzgerald in 2023'],
  ['grand count of invoices in 2021', 'how many invoices in 2021'],
  ['full count of estimates in 2022', 'how many estimates in 2022'],
  ['what is the headcount of invoices in 2022', 'how many invoices in 2022'],
]) { const pb = planOf(b); check(`count wording reads the plain plan: ${a}`, pb != null && planOf(a) === pb, planOf(a) == null ? 'released' : 'plan differs'); }
check('"total" alone is still money: the sum of invoices differs from the count', opOf('what is the total of invoices') !== opOf('how many invoices'));

/* ---------- 4. relative spans joined by and */
for (const q of ['number of invoices this year and last year', 'how many invoices this year and last year', 'count of invoices this quarter and last quarter']) {
  const p = ask(q); check(`two relative spans make a comparison (both numbers answered): ${q}`, p != null && !p.plain && /compare/.test(p.plan.op), p == null ? 'released' : p.plan.op);
}
check('two years joined by and are not forced into a comparison', opOf('how many invoices in 2023 and 2024') !== 'compare_two_values' || opOf('how many invoices in 2023 and 2024') == null);
check('kill: DONOVAN no switch needed - a single span is unchanged', opOf('how many invoices this year') === 'count');

/* ---------- 5. a spoken "so" */
const SOQ = ['how many invoices did we have in 2023', 'what is the total amount of invoices in 2023', 'show me the biggest invoice we have on file', 'how many invoices did we have during 2022'];
for (const b of SOQ) {
  for (const lead of ['so basically', 'So,', 'uh so', 'okay so basically']) { const pb = planOf(b); check(`"${lead}" lead reads the plain plan: ${b}`, pb != null && planOf(`${lead} ${b}`) === pb, planOf(`${lead} ${b}`) == null ? 'released' : 'plan differs'); }
}
for (const q of ['so how many of those were in 2023', 'so what about estimates in 2023 please', 'so how many for last year', 'so and the same for estimates in 2023 then', 'so how many invoices were there again in 2023', 'so those invoices in 2023 how many are there']) check(`a "so" that leans on the last turn stays released: ${q}`, planOf(q) == null);

/* ---------- 6. wrapped questions */
const BASES = ['how many invoices in 2023', 'what is the total amount of invoices in 2022', 'which customer has the most invoices', 'what is the largest invoice'];
const WRAPS = [
  (q) => `Subject: Quick one\n\nHi Mr. Donovan,\n\nThe thermostat is stuck and my chair squeaks. ${q}\n\nThanks in advance,\nPaulina`,
  (q) => `Hola 😊 por fa: ${q} 🙏, mil gracias`,
  (q) => `Honestly I was on the phone with my wife last night and she asked me something I could not answer and I lose track of this stuff, anyway standing at the site right now - ${q}`,
];
for (const b of BASES) for (const [i, w] of WRAPS.entries()) { const pb = planOf(b); check(`wrapped (${i}) reads the plain plan: ${b}`, pb != null && planOf(w(b)) === pb, planOf(w(b)) == null ? 'released' : 'plan differs'); }
check('unwrapAllows: counts with a period, sums, rankings, comparisons and are now safe', ['count', 'sum', 'top_n', 'latest', 'exists_yes_no', 'tm_compare', 'compare_two_values'].every((op) => U.unwrapAllows({ op, filters: [] })));
check('unwrapAllows: group counts and the two-measure answer stay with the model', !U.unwrapAllows({ op: 'group_count' }) && !U.unwrapAllows({ op: 'multi' }) && !U.unwrapAllows({ op: 'set_select' }));
check('unwrapAllowsCore: "who / which manager worked on the last X" stays with the model', !U.unwrapAllowsCore({ op: 'latest', ask: 'tech' }, 'who worked on the last inspection') && !U.unwrapAllowsCore({ op: 'latest' }, 'which manager worked on last inspection report') && U.unwrapAllowsCore({ op: 'latest' }, 'when was the last inspection report'));
check('unwrapQuestion: an emoji is dropped, the words stay', U.unwrapQuestion('Hola 😊 por fa: how many invoices in 2023', compileVocab(tv, pack)) === 'how many invoices in 2023');

/* ---------- 7. nothing that carries a condition, a second question, a status or a forecast */
for (const q of [
  'so how many invoices are overdue in 2023 for the long list we talked about',
  'Hola 😊 por fa: how many invoices are unpaid in 2023, mil gracias',
  'Hi Mr. Donovan, how many invoices will we get next month? Thanks',
  'Hola, por fa: how many invoices in 2023? And how many estimates in 2022? gracias',
  'Hola, por fa: show the number of invoices by year, gracias',
  'Hi!\n1. how many invoices in 2023\n2. how many estimates in 2022',
  'the client Linda Fitzgerald',
  'which customer wins',
  'total count',
  'so basically',
]) check(`released: ${q.slice(0, 70).replace(/\n/g, ' / ')}`, planOf(q) == null);
check('a role label never moves a name onto another field: the name is a customer filter', /"role":"customer"/.test(planOf('how many invoices for the client Linda Fitzgerald') ?? ''));
check('a role label does not hide a different person: two names still release or differ', planOf('how many invoices for the client Linda Fitzgerald and Thomas Mercer') !== planOf('how many invoices for Linda Fitzgerald'));

/* ---------- 7b. two-measure asks: pronoun stand-ins for the papers are explained only when BOTH halves are built for the same papers */
for (const q of ['how many invoices in 2023 and what do they add up to', 'how many invoices in 2023 and what is the total of them', 'count of invoices in 2023 plus the date of the latest one', 'how many invoices in 2023 and when was the latest one']) check(`both halves answered: ${q}`, opOf(q) === 'multi', String(opOf(q)));
check('a pronoun that does not close a pair is not explained: one measure with "they" stays released', planOf('how many of them') == null && planOf('what do they add up to') == null);
check('a stray word beside the pair keeps it released', planOf('how many invoices in 2023 and what do they add up to for the weird ones') == null);
process.env.R24_MULTI_LEFT = '0';
check('kill switch R24_MULTI_LEFT=0: the pronoun pair is released again', planOf('how many invoices in 2023 and what do they add up to') == null);
delete process.env.R24_MULTI_LEFT;

/* ---------- 7c. spelled-out numbers with hundred / thousand */
for (const [a, b] of [
  ['how many invoices in the past one hundred twenty days', 'how many invoices in the past 120 days'],
  ['how many invoices more than nine hundred dollars', 'how many invoices more than 900 dollars'],
  ['how many invoices over two hundred fifty dollars', 'how many invoices over 250 dollars'],
  ['how many invoices over three thousand five hundred dollars', 'how many invoices over 3500 dollars'],
  ['how many invoices over a hundred dollars', 'how many invoices over 100 dollars'],
]) { const pb = planOf(b); check(`spelled number reads the digit plan: ${a}`, pb != null && planOf(a) === pb, planOf(a) == null ? 'released' : 'plan differs'); }
check('short spelled numbers are untouched by the rewrite (a year said in words is not a count)', planOf('how many invoices in december twenty twenty one') === planOf('how many invoices in december twenty twenty one', { noUnwrap: true }));
process.env.R24_NUMWORDS = '0';
check('kill switch R24_NUMWORDS=0: spelled hundreds are released again', planOf('how many invoices more than nine hundred dollars') == null);
delete process.env.R24_NUMWORDS;

/* ---------- 7d. comparison and ranking wordings the engine already reads in other words */
for (const [a, b] of [
  ['was 2022 higher than 2018 on the total invoice amount', 'did 2022 have a higher total invoice amount than 2018'],
  ['is 2023 lower than 2022 for total invoice amount?', 'did 2023 have a lower total invoice amount than 2022?'],
  ['was 2022 bigger than 2018 in the number of invoices', 'did 2022 have a higher number of invoices than 2018'],
  ['between 2026 and 2020, which one had a higher number of invoices', 'which is higher on the number of invoices, 2026 or 2020'],
  ['which year had more invoices, 2020 or 2026', 'which is higher on the invoices, 2020 or 2026'],
  ['my top 5 customers by invoice dollars', 'our top 5 customers by invoice dollars'],
  ['top 5 customers by most invoices', 'top 5 customers by number of invoices'],
  ['number one customer by number of invoices', 'top 1 customer by number of invoices'],
]) { const pb = planOf(b); check(`wording reads the engine's own plan: ${a}`, pb != null && planOf(a) === pb, planOf(a) == null ? 'released' : 'plan differs'); }
check('a comparison of a thing with a number is not rewritten: "was the biggest invoice higher than 500 on total"', planOf('was the biggest invoice higher than 500 on total') == null);
process.env.R24_CMPREWRITE = '0';
check('kill switch R24_CMPREWRITE=0: "was 2022 higher than 2018 ..." is released again', planOf('was 2022 higher than 2018 on the total invoice amount') == null);
delete process.env.R24_CMPREWRITE;

check('unwrapAllowsCore: "count of A and of B" (two counts) stays with the model', !U.unwrapAllowsCore({ op: 'count' }, 'count of invoices and of estimates in 2023') && U.unwrapAllowsCore({ op: 'count' }, 'how many invoices in 2023'));
check('"from <one date> before the end of the day": the deadline phrase does not hide the single-date guard', planOf('how many invoices from 27 May 2026 before the end of the day') == null);

/* ---------- 8. kill switches */
process.env.R24_SO_LEAD = '0';
check('kill switch R24_SO_LEAD=0: the "so" lead is released again', planOf('so basically how many invoices did we have in 2023') == null);
delete process.env.R24_SO_LEAD;
check('kill switch off: "so" lead answered', planOf('so basically how many invoices did we have in 2023') != null);
process.env.DONOVAN_DQL_UNWRAP = '0';
check('DONOVAN_DQL_UNWRAP=0 releases wrapped questions', planOf(WRAPS[1]('how many invoices in 2023')) == null);
delete process.env.DONOVAN_DQL_UNWRAP;
check('api/ keeps its 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);

realLog(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
