/**
 * verify:dql-clusters-r22 - round 22: the biggest groups of wrong answers found by the 2.17-million-question sweep are fixed or released.
 *  - "how are we doing this year vs last year on X" gives the count AND the dollars; "how much in X this year vs last" gives dollars
 *  - "average amount" leads with the average; "total and average" is still a pair
 *  - customers above the average receipt dollars use the dollars (not the count); an ambiguous "above average on receipts" is released
 *  - a line-item / quoted / "includes" condition beside two measures is released (never half applied)
 *  - "from <date>", "by <date>", "as of <date>" with no second date, "did X with us again", forecasts, and a typed year that vanished are released
 *  - "what is the gap / difference" leads with the difference; "up in 2022 compared to 2020" is a yes or no
 *  - an amount on a lease with no word rent / total is released; "N grand" is thousands; "in the system" is the software
 *   node scripts/verify-dql-clusters-r22.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r22', tenantName: 'r22' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, answerFromSnapshot } = await import('../api/_lib/dql/index.js');
const { buildSnapshot } = await import('../api/_lib/dql/snapshot.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r22' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const TODAY = '2026-10-07';
const internal = new Set(data.documents.filter((d) => d.audience === 'internal').map((d) => d.id)); for (const x of data.extractions) if (x.field_key === '_audience' && x.value === 'internal') internal.add(x.document_id);
const raw = { documents: data.documents.map((d) => ({ id: d.id, original_filename: d.original_filename, document_type: d.document_type, created_at: d.created_at })), extractions: data.extractions.filter((x) => !String(x.field_key).startsWith('_')), entities: data.entities.filter((e) => ['customer', 'equipment'].includes(e.entity_type)), links: data.document_entity_links, financials: data.financials ?? [], lines: data.financial_lines ?? [], internalDocIds: [...internal] };
const snap = buildSnapshot(raw, { today: TODAY });
/** @returns {{released:boolean, text:string, plan:object|null}} */
const ask = (q) => {
  let it = null; try { it = parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q }); } catch (e) { return { released: true, text: '', plan: null, err: String(e) }; }
  if (!it || it.plain) return { released: true, text: '', plan: null };
  let d = null; try { d = answerFromSnapshot(snap, it.plan, TODAY); } catch (e) { return { released: true, text: '', plan: it.plan, err: String(e) }; }
  if (!d?.text) return { released: true, text: '', plan: it.plan };
  return { released: false, text: d.text, plan: it.plan };
};
const released = (q) => { const r = ask(q); check(`released: ${q}`, r.released, r.text); };
const says = (q, re) => { const r = ask(q); check(`answers: ${q}`, !r.released && re.test(r.text), r.released ? 'released' : r.text); };
const notSays = (q, re) => { const r = ask(q); check(`answer (or release) without ${re}: ${q}`, r.released || !re.test(r.text), r.text); };

// ---- 1. this year vs last year: the count AND the dollars
says('how are we doing this year vs last year on invoices', /Invoices: .* had \d+ .* Invoices total: .* had \$[\d,.]+ .* had \$[\d,.]+/);
says('how are we doing this year vs last year on purchase orders', /Purchase orders total: .* had \$/);
says('how are we doing this year vs last year on proposals', /total: .* had \$/);
says('how much in invoices this year vs last year', /had \$[\d,.]+ and .* had \$[\d,.]+/);
notSays('how much in purchase orders this year vs last year', /had \d+ and/);
says('how many invoices this year vs last year', /had \d+ and/);
notSays('how many invoices this year vs last year', /total:/);
released('this year vs last year for invoices - how many and how much');
says('how do invoices this year compare to last year, # and dollars', /total: .* had \$/);
// ---- 2. average
says("what's the average invoice amount", /average invoice total is \$/);
notSays("what's the average invoice amount", /^Invoices total/);
says('average proposal total', /average proposal/i);
says('total and average of invoices', /total.*average/i);
says('give me the total and the average invoice amount', /total.*average/is);
// ---- 3. above average
says('customers with more invoices than average, how many', /above the average invoice count/);
released('how many customers are above average on invoices');
released('how many customers are above average on receipts');
released('owners above average on quotes');
// ---- 4. two measures with a text / line-item condition
notSays('how many purchase orders have a "belts" line item and the sum of them', /^\d+ purchase orders on file/);
released('how many invoices mention "compressor" and what is the total');
notSays('how many purchase orders include filters and the total dollars', /^\d+ purchase orders on file/);
says('how many invoices in 2025 and the total', /\d+ invoices.*Invoices total/is);
released('how many invoices are there and what is the total');
// ---- 5. dates
released('count purchase orders from 20 Dec 2024');
released('number of invoices from 2025-03-01');
released('invoices by 15 August 2025 - total dollars');
released('As 2026-08-25, how many invoices');
says('count invoices from 2025-03-01 to 2025-06-30', /\d+ invoices/);
says('how many invoices on March 3, 2025', /invoice/i);
says('how many invoices in the past year', /invoice/i);
released('how many invoices within the last year');
released('how many invoices in the last year'); // the calendar year or the last twelve months: not guessed
{ const a = ask('how many invoices last year'); check('"last year" alone stays the previous calendar year', !a.released && /2025/.test(a.text), a.text); }
// ---- 6. repeat / again / forecast
released('how many customers did invoices with us again');
released('how many customers came back after an invoice');
released('what will revenue be next month');
released('how many invoices will we get next month');
says('how many customers had invoices', /customers? with an invoice/i);
// ---- 7. a year that vanished
released('in 2021, number on the first invoice');
says('the first invoice in 2021', /2021|No invoices/i);
// ---- 8. files vs people
released('count the files for the customer Ruth Fuller');
// ---- 9. gap / difference lead
says('what is the difference in the number of invoices between 2021 and 2022', /^The difference is \d+:/);
says('what is the gap in invoice dollars between 2021 and 2022', /^The difference is \$/);
says('is the number of invoices up in 2022 compared to 2021', /^(Yes|No), /);
says('did 2022 have more invoices than 2021', /^(Yes|No), /);
// ---- 10. amounts
says('invoices over 3 grand', /\$3,000/);
notSays('invoices over 3 grand', /over \$3\b(?!,)/);
says('any invoices above 2k', /\$2,000/);
// ---- 11. "in the system" is the software
notSays('how many customers in the system', /unit/i);
// ---- 12. comparisons that release
released('quotes more than 2000 during 2019');
released('compare this yera to last year: invoices count and dolalrs');
// ---- 13. more of the same
says('average proposal amount', /average/i);
says('what is the average purchase order total in 2025', /average/i);
released('customers above the average for receipt dollars with a mention of "tire"');
says('how many invoices on or after March 1, 2025', /invoice/i);
released('count work orders from 05/05/2025');
released('invoices as of 2025-06-01');
released('how many customers did work orders with us again please');
released('what will invoices total next quarter');
says('how many invoices between 2021 and 2023', /invoice/i);
notSays('invoices in 2021 and 2022', /^\d+ invoices on file/);
released('how are we doing this year vs last year on work orders'); // no totals on those papers: the dollars cannot be given, so the whole question is released
says('how much in work orders this year vs last year', /total/i);
// ---- 13b. round 22 g: guards that were too wide
check('warranties before 2028 answers with 2027 or is released', (() => { const r = ask('warranties expiring before 2028'); return r.released || /2027/.test(r.text); })());
check('papers after 2020 answer from 2021 or are released', (() => { const r = ask('how many invoices after 2020'); return r.released || /2021|after/i.test(r.text); })());
says('which customers have more than 5 documents', /customer/i);
says("what city is Linda Fitzgerald in - going by what's on file thank you", /Linda|city/i);
says('excuse me, total dollars and average size of invoices', /total.*average|average.*total/i);
says('por favor, invoices so far this year against the whole of last year, count and dollars', /\$[\d,]+/);
notSays('invoices above $19,000 and below $57,500', /are over \$19,000/);
notSays('how many supplier invoice in the system', /No vendor/);
notSays('how many repair invoice in the system', /invoices on file/);
// ---- 13c. round 23: a misspelled "average" beside a total keeps the pair; a misspelled measure the learned planner ignored releases
says('sum and avearge of invoices in 2025', /total.*average|average.*total/i);
says('how much in total for invoices before 2030 and whats the averge', /total.*average|average.*total/i);
notSays('avearge invoice amount and total in 2025', /^The average invoice total is/);
check('misspelled total ignored as chatter is not answered as a list', (() => { const r = ask('whats the toal of all for invoices in the first quartr of 2023 for me'); return r.released || /\$[\d,.]+ (?:in|total)|total/i.test(r.text) && !/ are |: INV-/.test(r.text); })());
// ---- 14. files untouched
const apiTop = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
check('api/ keeps 12 top-level files', apiTop === 12, String(apiTop));
console.log = realLog; console.log(`\n${passes} passed, ${failures} failed`); process.exit(failures ? 1 : 0);
