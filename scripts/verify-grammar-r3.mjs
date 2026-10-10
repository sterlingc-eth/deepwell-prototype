/**
 * Round 3, builder B2: aggregate and scope grammar, plus the honest owed-balance answer. Each mechanism has a positive case and a release case:
 *   1. owed / past due / aging / receivables when no invoice records a payment status -> plain "not recorded" answer (and still answers when a status exists)
 *   2. two years in one sentence -> one clause per year ("each"), one window ("combined", "across", "plus"), never the first year alone
 *   3. subject scope -> "documents filed under X", "paperwork on X", "tickets that list X as the technician"
 *   4. ranking and values -> "who wrote the most invoices in 2024", "fewest repair tickets", "the five biggest invoices in 2023"
 *   5. threshold plus total, average per technician, total of a technician's invoices, negation with a period
 * Same harness as verify-grammar.mjs: real migrations in PGlite, the golden export as data, no network, no key.
 *   node scripts/verify-grammar-r3.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ANTHROPIC_API_KEY;
console.warn = () => {};
console.error = () => {};
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); };

const off = await import('./offline-exam.mjs');
await off.installPgHarness();
await off.installModelBlock();
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, exp, { tenantKey: 'verify:grammar', tenantName: 'grammar' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getPack } = await import('../api/_lib/industry/index.js');
const { classifyDecompose, runDecompose } = await import('../api/_lib/decompose/index.js');
const { parseNegation, parseRatio } = await import('../api/_lib/decompose/negation.js');
const { grammarSpans, unusedGrammar } = await import('../api/_lib/router/leftover.js');
const { resolveAnyTimeRange } = await import('../api/_lib/analytics.js');
const { answerMoneyQuestion } = await import('../api/_lib/financials/moneyGate.js');
const { parseTemplate, runTemplate } = await import('../api/_lib/lookups/aggTemplates.js');
const { parseAggregate, runAggregate } = await import('../api/_lib/lookups/aggregates.js');
const { classifyDeterministic } = await import('../api/_lib/deterministicRouter.js');
const { yearPairRewrite } = await import('../api/_lib/router/leftover.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const pack = getPack('hvac');
const TODAY = '2026-10-07';
const blob = (d) => [d?.text, ...(d?.facts ?? []).flatMap((f) => [f.label, f.value])].join(' ');
const has = (d, ...needles) => needles.every((n) => blob(d).replace(/,/g, '').includes(String(n).replace(/,/g, '')));
async function dec(q) {
  const intent = classifyDecompose(q, { pack });
  if (!intent) return { intent: null, data: null };
  return { intent, data: await withTenant(ctx, (db) => runDecompose(db, intent, { today: TODAY })) };
}
const money = async (q) => (await answerMoneyQuestion({ withTenant: (_c, fn) => withTenant(ctx, fn), ctxArg: null, question: q, today: TODAY }));


const mon = async (q) => (await money(q))?.data ?? null;
const runT = async (q) => { const t = parseTemplate(q); return t ? withTenant(ctx, (db) => runTemplate(db, t, { today: TODAY })) : null; };
const { parseTechnician } = await import('../api/_lib/lookups/technician.js');
const techVocab = { technicians: { phrases: ['Denise Ford', 'Kevin Pratt', 'Marisol Vega', 'Danny Ochoa', 'Wyatt Coburn', 'Ray Sutton'] } };

/* ---------------------------------------------------------------- 1. owed / past due when no payment status is recorded */
{
  for (const q of ['who still owes us money', 'show me past due invoices', "what's our accounts receivable total", 'what is the aging on our receivables']) {
    const d = await mon(q);
    check(`owed: "${q}" says payment status is not recorded`, d && /isn't recorded/.test(d.text) && !/No open invoices/.test(d.text), d?.text);
    check(`owed: "${q}" offers what is on file`, d && /On file: 120 invoices/.test(d.text), d?.text);
  }
  const one = await mon("what's the outstanding balance for Copper Sky Dental");
  check('owed: one customer is named and its invoices are counted', one && /Copper Sky Dental's invoices/.test(one.text) && /On file: 1 invoice/.test(one.text), one?.text);
  // a payment status that IS recorded: the old behaviour is unchanged
  await lite.exec(`UPDATE document_financials SET status = 'unpaid', due_date = '2026-01-01' WHERE document_id IN (SELECT document_id FROM document_financials WHERE doc_kind = 'invoice' ORDER BY document_id LIMIT 3)`);
  const live = await mon('who still owes us money');
  check('owed: with a recorded status the open invoices are still answered', live && !/isn't recorded/.test(live.text) && /owe/i.test(live.text), live?.text);
  await lite.exec(`UPDATE document_financials SET status = 'unknown', due_date = NULL`);
}

/* ---------------------------------------------------------------- 2. two years in one sentence */
{
  check('years: "each" gives one clause per year', yearPairRewrite('invoices in 2025 and in 2026, how many of each') === 'how many invoices in 2025, and how many invoices in 2026');
  check('years: "count each year" gives one clause per year', yearPairRewrite('proposals for 2024 and 2025, count each year') === 'how many proposals for 2024, and how many proposals for 2025');
  check('years: "invoice count for 2022 and 2023" gives one clause per year', yearPairRewrite('invoice count for 2022 and 2023') === 'how many invoices for 2022, and how many invoices for 2023');
  check('years: "across" is one combined window', yearPairRewrite('total billed across 2023 and 2024') === 'total billed in 2023 and 2024 combined');
  check('years: "plus" is one combined window', yearPairRewrite('how many work orders in 2024 plus 2025') === 'how many work orders in 2024 and 2025 combined');
  check('years: combined non-consecutive years are never one year (per-year clauses)', yearPairRewrite('2023 plus 2025 invoice total') === 'what is the total of invoices in 2023, and what is the total of invoices in 2025');
  check('years: "each of" is one clause per year, no year read as an amount', yearPairRewrite('each of 2024 and 2025 invoice totals') === 'what is the total of invoices in 2024, and what is the total of invoices in 2025' && yearPairRewrite('invoices in each of 2024 and 2025') === 'how many invoices in 2024, and how many invoices in 2025');
  check('years: "how many invoices 2023 plus 2025" is per year', yearPairRewrite('how many invoices 2023 plus 2025') === 'how many invoices in 2023, and how many invoices in 2025');
  check('years: three years are not handled here', yearPairRewrite('invoices in 2023, 2024 and 2025 each') === null);
  check('years: the older two-window respelling is kept', yearPairRewrite('total of invoices in 2024 and 2025') === 'total of invoices in 2024 and in 2025');
  check('years: a respelled question is not respelled again', yearPairRewrite('total of invoices in 2024 and in 2025') === null);
  const e = await dec(yearPairRewrite('invoices in 2025 and in 2026, how many of each'));
  check('years: 8 invoices in 2025 and 6 in 2026, labelled', e.data && has(e.data, '8', '6', '2025', '2026'), blob(e.data));
  const p = await dec(yearPairRewrite('proposals for 2024 and 2025, count each year'));
  check('years: 3 proposals in 2024 and 4 in 2025 (never the first year alone)', p.data && has(p.data, '3 quotes', '4 quotes'), blob(p.data));
  const c = await mon(yearPairRewrite('total billed across 2023 and 2024'));
  check('years: across 2023 and 2024 is one total, $58,409', c && has(c, '58,409'), blob(c));
}

/* ---------------------------------------------------------------- 3. subject scope */
{
  check('scope: "filed under X" is the documents-for-X question', yearPairRewrite('how many documents are filed under Jason Zamora') === 'how many documents do we have for Jason Zamora');
  check('scope: "paperwork on X"', yearPairRewrite('count the paperwork on James Tovar') === 'how many documents do we have for James Tovar');
  check('scope: "documents that mention X"', yearPairRewrite('how many documents mention Denise Ford') === 'how many documents do we have for Denise Ford');
  check('scope: "tickets that list X as the technician" is the technician count', yearPairRewrite('how many service tickets list Denise Ford as the technician') === 'how many service tickets were done by Denise Ford');
  check('scope: an extra condition is released (no rewrite)', yearPairRewrite('how many documents mention Denise Ford in Mesa') === null && yearPairRewrite('how many documents are filed under Jason Zamora in 2025') === null);
  check('scope: a lower-case name is not rewritten', yearPairRewrite('how many documents mention denise ford') === null);
  const t1 = parseTechnician('how many documents do we have for Denise Ford', techVocab, {});
  check('scope: a technician on the roster reads "documents" as the documents that list them', t1?.kind === 'total' && t1.docNoun === true && t1.techs[0] === 'Denise Ford', JSON.stringify(t1));
  check('scope: a documents question with a city or type is released', parseTechnician('how many documents do we have for Denise Ford in Mesa', techVocab, {}) === null && parseTechnician('how many repair documents do we have for Denise Ford', techVocab, {}) === null);
  check('scope: a name that is not on the roster is not a technician', parseTechnician('how many documents do we have for Zed Nobody', techVocab, {}) === null);
  const r = await withTenant(ctx, async (db) => { const { runTechnician } = await import('../api/_lib/lookups/technician.js'); return runTechnician(db, t1); });
  check('scope: 55 documents list Denise Ford, and the answer says which scope was used', r && /^55 documents list Denise Ford as the technician\./.test(r.text), r?.text);
}

/* ---------------------------------------------------------------- 4. ranking and values */
{
  const w = await runT('who wrote the most invoices in 2024');
  check('rank: who wrote the most invoices in 2024 -> Denise Ford', w && /Denise Ford, 5/.test(w.text) && /in 2024/.test(w.text), w?.text);
  const f = await runT('which technician logged the fewest repair tickets');
  check('rank: fewest repair tickets -> Wyatt Coburn, with the filter named', f && /^Fewest service visits \(repair visits\): Wyatt Coburn, 2\./.test(f.text), f?.text);
  const tie = await runT('who wrote the fewest invoices');
  check('rank: a tie for the fewest lists everyone tied', tie && /3 technicians tie for the fewest/.test(tie.text) && /Denise Ford/.test(tie.text) && /Wyatt Coburn/.test(tie.text), tie?.text);
  const top5 = await runT('the five biggest invoices in 2023');
  check('rank: the five biggest invoices of 2023, largest first', top5 && ['7,738.00', '5,540.00', '5,272.00', '5,004.00', '3,074.00'].every((v, i) => top5.text.indexOf(v) > -1 && (i === 0 || top5.text.indexOf(v) > top5.text.indexOf(['7,738.00', '5,540.00', '5,272.00', '5,004.00'][i - 1]))), top5?.text);
  const z = await runT('which technician wrote the fewest invoices in 2025');
  check('rank: fewest includes technicians with 0 in the window', z && /tie for the fewest invoices in 2025 at 0/.test(z.text) && /Denise Ford/.test(z.text), z?.text);
  const z2 = await runT('fewest invoices by technician in 2026');
  check('rank: "fewest invoices by technician" measures invoices', z2 && /fewest invoices in 2026/.test(z2.text) && !/visit/.test(z2.text), z2?.text);
  check('rank: most uses the plain "Most invoices" sentence', w && /^Most invoices in 2024: Denise Ford, 5\./.test(w.text), w?.text);
  check('rank: bottom N and rolling windows are still released', parseTemplate('bottom 3 technicians by invoices') === null && parseTemplate('who wrote the most invoices this month') === null);
  check('rank: "top 3 technicians by number of service tickets" is unchanged', parseTemplate('top 3 technicians by number of service tickets')?.t === 'top');
}

/* ---------------------------------------------------------------- 5. threshold plus total, per-group average, a technician's total, negation with a period */
{
  const th = await mon("what's the total for invoices over $3000");
  check('threshold: the total of invoices over $3000 is $547,765', th && has(th, '106 invoices', '547,765.00') && /totaling/.test(th.text), th?.text);
  const thc = await mon('how many invoices over $3000');
  check('threshold: a plain count has no total added', thc && has(thc, '106 invoices') && !/totaling/.test(thc.text), thc?.text);
  const pa = await runT('average invoice per technician');
  check('average: one figure per technician, never the shop-wide average', pa && /per technician/.test(pa.text) && has(pa, 'Marisol Vega $4,737.82 (22 invoices)'), pa?.text);
  const one = await runT('average invoice for Marisol Vega');
  check('average: a technician\'s invoices average $4,737.82', one && has(one, '4,737.82'), one?.text);
  const tot = await runT("total of Kevin Pratt's invoices");
  check('total: Kevin Pratt\'s invoices total $95,030, said to be matched on the technician', tot && has(tot, '95,030.00', '21 invoices') && /technician/.test(tot.text), tot?.text);
  const none = await runT("total of Kevin Pratt's invoices in 2024");
  check('total: an empty window is $0.00', none && /\$0\.00/.test(none.text), none?.text);
  check('total: a name that is not a technician or customer is released', await runT("total of Zed Nobody's invoices") === null);
  const n1 = await dec('how many invoices were written by someone other than Danny Ochoa in 2025');
  check('negation: the window is on the whole as well as the part (8 in 2025, 0 by Danny)', n1.data && has(n1.data, '8 invoices in 2025', 'minus 0'), blob(n1.data));
  const n2 = await dec('how many invoices were written by someone other than Zed Nobody in 2025');
  check('negation: a person who is not a technician with none found is released', n2.data === null, blob(n2.data));
  const n3 = await dec('how many invoices were not over $3000 in 2025');
  check('negation: not over $3000 in 2025 is 8 minus 7', n3.data && has(n3.data, '8 on file', 'minus 7'), blob(n3.data));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
