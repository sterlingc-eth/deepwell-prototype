/**
 * Planner grammar and honest partial answers (round 2, B3). Five mechanisms, each with a positive case (answered correctly)
 * and a release case (the lane cannot answer the whole question, so it answers nothing):
 *   1. negation as polarity   decompose/negation.js, router/leftover.js (unused negation), router/classifyAll.js
 *   2. honest partial answers router/leftover.js grammar markers, financials/moneyGate.js
 *   3. period grammar         timeSpans.js (halves, year before last, two years combined)
 *   4. measure and scope      lookups/aggTemplates.js (top N by total, share, mean), lookups/aggregates.js (fewest tickets), percent over a threshold
 *   5. multi-part             decompose/compound.js (measure of "them", a noun list, a person swap, extremes pair)
 * Same harness as verify-compound.mjs: real migrations in PGlite, the golden export as data, no network, no key.
 *   node scripts/verify-grammar.mjs
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

/* ---------------------------------------------------------------- 1. negation as polarity */
{
  const n = parseNegation('how many invoices were not over $3000');
  check('negation: "not over $3000" splits into the whole and the positive reading', n?.total === 'how many invoices' && /over \$3000/.test(n?.positive ?? ''), JSON.stringify(n));
  check('negation: "other than <name>" keeps the whole without the dangling verb', parseNegation('how many service tickets were handled by someone other than Danny Ochoa')?.total === 'how many service tickets');
  check('negation: a list question is not complemented', parseNegation('which invoices were not over $3000') === null);
  check('negation: two negations are ambiguous and released', parseNegation('how many invoices were not over $3000 and not paid') === null);
  check('negation: "no email" (an absence of a record) is not this lane', parseNegation('how many customers have no email') === null);
  const a = await dec('how many invoices were not over $3000');
  check('negation: invoices not over $3000 = 120 - 106 = 14', a.data && has(a.data, '14', '106', '120'), blob(a.data));
  const b = await dec('how many proposals were not issued in 2026');
  check('negation: proposals not issued in 2026 = 60 - 9 = 51', b.data && has(b.data, '51'), blob(b.data));
  const c = await dec('how many tickets are not PM');
  check('negation release: a positive reading that drops the condition (positive == whole) is released, never the positive count', c.data === null, blob(c.data));
  const d = await dec('number of invoices excluding Rheem');
  check('negation release: a positive reading no lane can read is released', d.data === null, blob(d.data));
}

/* ---------------------------------------------------------------- 2. honest partial answers */
{
  const sigDet = (q) => JSON.stringify(classifyDeterministic(q, {}) ?? null);
  check('markers: a negation word is found', grammarSpans('how many units aren\'t 3 ton').some((s) => s.kind === 'negation'));
  check('markers: "top 5" is found', grammarSpans('top 5 customers by invoice total').some((s) => s.kind === 'topn'));
  check('markers: a service-type modifier on tickets is found', grammarSpans('how many repair tickets').some((s) => s.kind === 'service-type'));
  check('markers: "customers outside Tucson, how many" has no second clause', !grammarSpans('customers outside Tucson, how many').some((s) => s.kind === 'second-head'));
  check('unused: personamt read "not" as a name, so the negation is reported unused', unusedGrammar('how many invoices were not over $3000', sigDet).includes('not'));
  check('used: a negation the lane reads (a field absence) is not reported', unusedGrammar('how many customers have no email on file', sigDet).length === 0, JSON.stringify(unusedGrammar('how many customers have no email on file', sigDet)));
  const m1 = await money('how many invoices were not over $3000');
  check('money lane releases a negated threshold (never "106 invoices are over $3,000")', m1.handled === false, JSON.stringify(m1).slice(0, 160));
  const m2 = await money('total invoiced in 2021 and 2022');
  check('money lane releases a second year it did not apply', m2.handled === false, JSON.stringify(m2).slice(0, 160));
  const m3 = await money('total invoiced in 2022');
  check('money lane still answers one year', m3.handled === true && has(m3.data, '31,634'), blob(m3.data));
  const m4 = await money('how many proposals in 2026 and their total value');
  check('money lane releases "and their total value" it did not apply', m4.handled === false, JSON.stringify(m4).slice(0, 160));
}

/* ---------------------------------------------------------------- 3. period grammar */
{
  const r = (q) => resolveAnyTimeRange(q, TODAY);
  check('period: first half of 2025', r('invoiced in the first half of 2025')?.to === '2025-06-30');
  check('period: second half of 2025', r('service tickets in the second half of 2025')?.from === '2025-07-01');
  check('period: H2 2024', r('H2 2024')?.from === '2024-07-01');
  check('period: the year before last', r('how many invoices the year before last')?.from === '2024-01-01');
  check('period: two consecutive years combined', r('2021 and 2022 combined')?.to === '2022-12-31');
  check('period release: two years that are not consecutive are not one window', r('2019 and 2022 combined') === null);
  const m = await money('what did we bill in the first half of 2025');
  check('period: billed in the first half of 2025 = $11,706 (not the whole year)', m.handled && has(m.data, '11,706'), blob(m.data));
  const q3 = await money('what was invoiced in the third quarter of 2025');
  check('period: third quarter of 2025 is not read as a customer name', q3.handled && has(q3.data, '22,664'), blob(q3.data));
  const y = await money('total invoiced in 2021 and 2022 combined');
  check('period: 2021 and 2022 combined = $68,668', y.handled && has(y.data, '68,668'), blob(y.data));
}

/* ---------------------------------------------------------------- 4. measure and scope */
{
  const t = parseTemplate('top 5 customers by invoice total');
  check('measure: "invoice total" is the dollar amount', t?.measure === 'amount' && t?.n === 5, JSON.stringify(t));
  const top = await withTenant(ctx, (db) => runTemplate(db, t, { today: TODAY }));
  check('measure: top 5 customers by invoice total lists five customers, biggest first', top && /1\. Kenneth Gallardo \$7,875\.00/.test(top.text) && /5\. /.test(top.text), top?.text);
  const mean = await withTenant(ctx, (db) => runTemplate(db, parseTemplate('mean invoice size in 2025'), { today: TODAY }));
  check('measure: mean invoice size in 2025 = $4,401.25', mean && has(mean, '4,401.25'), mean?.text);
  const share = await withTenant(ctx, (db) => runTemplate(db, parseTemplate('what share of our tickets were preventive maintenance visits'), { today: TODAY }));
  check('measure: share of tickets that were PM = 29.2% of 120 service tickets', share && has(share, '35', '120', '29.2'), share?.text);
  const ag = parseAggregate('which tech has the fewest tickets');
  const fewest = await withTenant(ctx, (db) => runAggregate(db, ag, { today: TODAY }));
  check('measure: the fewest TICKETS counts service tickets only (19), not every document naming the technician', fewest && has(fewest, '19') && /service tickets/.test(fewest.text), fewest?.text);
  const pr = parseRatio('what percent of invoices were over $5000');
  check('measure: percent over a threshold parses to part over whole', pr?.total === 'how many invoices' && /over \$5000/.test(pr?.positive ?? ''), JSON.stringify(pr));
  const pct = await dec('what percent of invoices were over $5000');
  check('measure: 54 of 120 invoices over $5000 = 45%', pct.data && has(pct.data, '45%', '54', '120'), blob(pct.data));
  const bad = await dec('what percent of tickets were PM');
  check('measure release: a part that drops its condition (part == whole) is released', bad.data === null, blob(bad.data));
}

/* ---------------------------------------------------------------- 5. multi-part */
{
  const a = await dec('how many invoices in 2022 and what did they total');
  check('multi: count then "what did they total" answers both, in order', a.data && has(a.data, '7 invoices', '31,634'), blob(a.data));
  const b = await dec('how many proposals in 2026 and their total value');
  check('multi: count then "their total value"', b.data && has(b.data, '9', '19,385'), blob(b.data));
  const c = await dec('total invoiced and total proposed');
  check('multi: two totals by verb form', c.data && has(c.data, '572,212', '86,410'), blob(c.data));
  const d = await dec('how many service tickets and invoices do we have');
  check('multi: one count word, two kinds of paper', d.data && has(d.data, '120') && (d.data.text.match(/120/g) ?? []).length >= 2, blob(d.data));
  const e = await dec('how many tickets did Danny Ochoa do and how many did Kevin Pratt do');
  check('multi: the same sentence about a second person', e.data && has(e.data, 'Danny Ochoa', 'Kevin Pratt'), blob(e.data));
  const f = await dec('smallest and largest invoice');
  check('multi: an extremes pair answers both ends', f.data && has(f.data, '840', '7,875'), blob(f.data));
  const g = await dec('tickets in 2024, tickets in 2025 and tickets in 2026');
  check('multi: one kind of paper in three windows', g.data && has(g.data, '6', '5', '28'), blob(g.data));
  const h = await dec('how many invoices in 2022 and what did the moon total');
  check('multi release: an unresolved clause releases the whole question', h.data === null, blob(h.data));
  const i = await dec('how many Trane units and how many Daikin units');
  check('multi: two brands are two answers, never one merged count', i.data && has(i.data, '16', '17') && !/33 of 132/.test(i.data.text), blob(i.data));
  const j = await dec('how many invoices did Wyatt Coburn write and what did they add up to');
  check('multi release: a person\'s invoice total is not guessed from the shop total', j.data === null, blob(j.data));
}

/* ---------------------------------------------------------------- 6. fix round: percent, ranking scope, wording, year pairs */
{
  // 1. percent with "not" / "or" is released, never the positive version
  check('percent: "not Trane" is released', parseTemplate('what percent of units are not Trane') === null);
  check('percent: "not repairs" is released', parseTemplate('what percent of tickets were not repairs') === null);
  check('percent: "Trane or Carrier" is released (never "Carrier and Trane")', parseTemplate('what percent of units are Trane or Carrier') === null);
  check('percent: a plain share still parses', parseTemplate('what share of our tickets were preventive maintenance visits')?.t === 'share');
  // 2. the denominator carries every filter but the measured one, or the question is released
  check('percent: "of Trane units are in Mesa" (denominator would be Trane units) is released', parseTemplate('what percent of Trane units are in Mesa') === null);
  check('percent: two conditions on the measured side are released', parseTemplate('what percent of tickets that were repairs for Danny Ochoa') === null);
  const r1 = parseRatio('what percent of invoices were over $5000 in 2025');
  check('percent: the window is on the whole as well as the part', r1?.total === 'how many invoices in 2025' && r1?.positive === 'how many invoices were over $5000 in 2025', JSON.stringify(r1));
  const r2 = await dec('what percent of invoices were over $5000 in 2025');
  check('percent: 3 of the 8 invoices in 2025 (not of all invoices)', r2.data && has(r2.data, '37.5%', '3 of 8'), blob(r2.data));
  check('percent: asked in dollars is released', parseRatio('what percent of invoices in dollars were over $5000') === null);
  // 3. ranking keeps its filters or is released
  check('rank: top 0 is released', parseTemplate('top 0 customers by invoice total') === null);
  check('rank: top 1000 is released', parseTemplate('top 1000 customers by invoice total') === null);
  check('rank: "this month" is released (never the all-time ranking)', parseTemplate('top 3 techs this month') === null);
  check('rank: top and bottom together is released', parseTemplate('top 3 customers by invoice total and bottom 2') === null);
  check('rank: a place is a marker no ranking lane reads', grammarSpans('top 5 customers by invoice total in Mesa').some((x) => x.kind === 'rank-scope'));
  check('rank: "the 2 smallest invoices" is released by the money check', unusedGrammar('the 2 smallest invoices', () => 'null', 'x', { include: ['year', 'period'] }).length > 0);
  check('rank: top 50 is released by the money check', unusedGrammar('top 50 customers by invoice total', (q) => q, undefined, { include: ['year', 'period'] }).length > 0);
  const bc = parseTemplate('who is our biggest customer in 2025');
  check('rank: "biggest customer" is by dollars, one customer', bc?.measure === 'amount' && bc?.n === 1, JSON.stringify(bc));
  const bn = parseTemplate('top 10 brands');
  const bnr = bn ? await withTenant(ctx, (db) => runTemplate(db, bn, { today: TODAY })) : null;
  check('rank: asking for more than exist says "all N on file"', bnr && /^All \d+ brands on file \(you asked for 10\)/.test(bnr.text), bnr?.text);
  // 4. complement wording
  const w = await dec('how many invoices were not from 2025');
  check('wording: plain sentence for a complement', w.data && /^\d+ invoices are not from 2025: \d+ on file, minus \d+ from 2025\.$/.test(w.data.text), w.data?.text);
  const w2 = await dec('how many invoices didn\'t Ray Sutton write');
  check('wording: a did-form condition becomes "written by <person>"', w2.data && /^101 invoices are not written by Ray Sutton: 120 on file, minus 19 written by Ray Sutton\.$/.test(w2.data.text), w2.data?.text);
  check('wording: asked in dollars, a count complement is not given', parseNegation('how many invoices were not from 2025 in total dollars') === null && parseNegation('invoices not from 2025 in total dollars') === null);
  // 5. two years are never an amount
  check('years: "2024 and 2025" is respelled as two windows', yearPairRewrite('total of invoices in 2024 and 2025') === 'total of invoices in 2024 and in 2025');
  check('years: "between 2019 and 2021" is a range, left alone', yearPairRewrite('how many invoices between 2019 and 2021') === null);
  check('years: "2021 and 2022 combined" is left to the combined window', yearPairRewrite('total invoiced in 2021 and 2022 combined') === null);
  const yp = await dec('total of invoices in 2024 and in 2025');
  check('years: each window gets its own total, no year read as $2,025', yp.data && has(yp.data, '28,975', '35,210') && !/2,025/.test(yp.data.text), blob(yp.data));
  const ca = await classifyAll('total of invoices in 2024 and 2025', { today: TODAY });
  // the merged tenant-count route may claim the respelled question first; it hands the same two-window question on, so the answer is unchanged
  check('years: the router claims it as the two-window question', ['decompose', 'deterministic'].includes(ca.winner?.name) && /and in 2025/.test(ca.effectiveQuestion ?? ''), JSON.stringify(ca.winner)?.slice(0, 120));
}

{
  const { namedCondition } = await import('../api/_lib/decompose/negation.js');
  check('wording: a year', namedCondition('from 2025') === 'from 2025' && namedCondition('in 2025') === 'in 2025');
  check('wording: an amount', namedCondition('were over $3000') === 'over $3000');
  check('wording: a person (possessive allowed)', namedCondition("for Danny Ochoa's") === 'for Danny Ochoa' && namedCondition('by Danny Ochoa') === 'by Danny Ochoa');
  check('wording: a participle with a window', namedCondition('logged in 2026') === 'logged in 2026');
  check('wording release: "happen in 2025" cannot be named, so it is released', namedCondition('did happen in 2025') === null);
  check('wording release: leftover typed words never form a sentence', namedCondition('Ray Sutton write') === null && namedCondition('Rheem') === null);
  const rel = await dec("how many invoices didn't happen in 2025");
  check('wording: an unnameable complement answers nothing', rel.data === null, blob(rel.data));
  // rolling windows and "N busiest"
  check('rank: "this month" is released, not an empty or all-time ranking', parseTemplate('top 3 techs this month') === null && parseTemplate('3 busiest techs this week') === null);
  const bt = parseTemplate('3 busiest techs');
  const btr = bt ? await withTenant(ctx, (db) => runTemplate(db, bt, { today: TODAY })) : null;
  check('rank: "3 busiest techs" lists three technicians', btr && /^Top 3 technicians/.test(btr.text) && /3\. /.test(btr.text), btr?.text);
  const one = await withTenant(ctx, (db) => runTemplate(db, parseTemplate('who is our biggest customer in 2025'), { today: TODAY }));
  check('rank: N = 1 is a plain sentence', one && /^Biggest customer by invoice amount in 2025: Jessica Bennett, \$6,636\.00\. /.test(one.text) && !/Top 1/.test(one.text), one?.text);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
