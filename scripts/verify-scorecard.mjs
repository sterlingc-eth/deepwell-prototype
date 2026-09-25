/**
 * Checks for the Donovan Scorecard, Sonnet escalation, view_document_page and the body-name customer link.
 *
 * No network, no Anthropic key, no DATABASE_URL: models are scripted and the database is a REAL Postgres
 * (PGlite) loaded from the actual M3-config/*.sql migrations and queried as the app's NOBYPASSRLS role, exactly
 * like scripts/verify-agent.mjs (same harness).
 *
 *   1. The golden exam file: contract (size, categories, rubric cap, oracle SQL shape, generator freshness).
 *   2. Comparators (pure): number / set / value / yesno / honest-zero / rubric.
 *   3. Oracles on seeded data: every family's SQL runs and returns the hand-computed answer; every oracle in
 *      the shipped exam executes without error.
 *   4. The runner: pass/fail scoring, skip semantics, learning-loop feed, retry, budget stop, paging, the
 *      nightly slice, persistence WITH and WITHOUT migration 30 (tables vs audit_log fallback), the in-process
 *      hook (no HTTP request can use it; allowance/cache untouched).
 *   5. Escalation: every trigger, the daily Sonnet cap, pricing, the debug trace.
 *   6. view_document_page: ledger enforcement, size caps, max views, grounding of what a view reads.
 *   7. Body-name customer link: unique links, ambiguity/partials go to review, other tenants never matched.
 *   8. Accuracy + breadth (Team B): the ADJUDICATED oracles (geography with odd address shapes, "no email", customers vs units,
 *      last service, visits, technician breakdown, upload-vs-service date, ambiguous surnames), citation scoring, alternate
 *      definitions that must be STATED, retirement when the financials tables/rows are absent, and every one of the 200+
 *      breadth questions (financials, content, semantic, multi-hop, trends, rankings, tech, data-quality, existence,
 *      explain, persona) run against a seeded shop with hand-computed answers.
 *
 *   node scripts/verify-scorecard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_ESCALATION;
delete process.env.DONOVAN_SONNET_DAILY_USD;
delete process.env.DONOVAN_ESCALATION_MODEL;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
const realWarn = console.warn;
console.warn = () => {};
const realErr = console.error;
console.error = () => {};

const { validQuestions, loadExam } = await import('../api/_lib/scorecard/exam.js');
const { compareAnswer, expectedFromRows, scoreResults, warrantyStatusFromText, datesIn, countCitations, isSubstantive } = await import('../api/_lib/scorecard/compare.js');
const { oracleSqlOk, runOracle } = await import('../api/_lib/scorecard/oracle.js');
const { classify } = await import('./gen-scorecard.mjs');

/* ================================================================== 1. the exam file */
const exam = loadExam();
{
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/scorecard/exam.json'), 'utf8'));
  const qs = exam.questions;
  check('exam: loads and every question is well-formed (validQuestions drops none)', qs.length === raw.questions.length && qs.length > 0, `${qs.length} vs ${raw.questions.length}`);
  check('exam: 480-800 questions (the bank sample plus 200+ breadth questions)', qs.length >= 480 && qs.length <= 800, String(qs.length));
  const rubric = qs.filter((q) => q.cmp === 'rubric').length;
  check('exam: rubric (model-graded) questions are at most 15% of the set', rubric / qs.length <= 0.15, `${rubric}/${qs.length}`);
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/question-bank/bank.json'), 'utf8'));
  const cats = new Set(bank.map((b) => b.category));
  const covered = new Set(qs.map((q) => q.category));
  eq('exam: every question-bank category is covered (money moved to the financials breadth category)', [...cats].filter((c) => !covered.has(c) && c !== 'money'), []);
  check('exam: canonical AND typo/abbreviated wordings are present', ['canonical', 'typo', 'abbreviated'].every((v) => qs.some((q) => q.variant === v)));
  eq('exam: every comparison type is used', ['number', 'set', 'value', 'yesno', 'honest-zero', 'rubric'].filter((c) => !qs.some((q) => q.cmp === c)), []);
  check('exam: ids unique and question text within the 300-char storage limit', new Set(qs.map((q) => q.id)).size === qs.length && qs.every((q) => q.text.length <= 300));
  check('exam: every oracle is a single read-only SELECT (oracleSqlOk) and binds the params it uses',
    qs.every((q) => oracleSqlOk(q.oracle.sql) && Math.max(0, ...[...q.oracle.sql.matchAll(/\$(\d+)/g)].map((m) => +m[1])) === q.oracle.params.length));
  check('exam: oracles read base tables only (no views, no analytics helpers)', qs.every((q) => !/\b(?:documents_v|facts|customers_v)\b/.test(q.oracle.sql) && /\b(?:entities|documents|extractions|document_pages|document_financials|pg_tables)\b/.test(q.oracle.sql)));
  check('exam: honest-zero questions carry a data guard so they retire themselves when the data appears', qs.filter((q) => q.cmp === 'honest-zero').every((q) => /\bn\b/.test(q.oracle.sql)));
  check('validQuestions rejects malformed entries', validQuestions([{ id: 'x' }, { id: 'y', text: 't', category: 'c', cmp: 'nope', oracle: { sql: 'select 1' } }, { id: 'z', text: 't', category: 'c', cmp: 'rubric', oracle: { sql: 'select 1' } }]).length === 0);
  const breadth = qs.filter((q) => q.id.startsWith('breadth-'));
  check('exam: at least 200 breadth questions', breadth.length >= 200, String(breadth.length));
  eq('exam: every breadth category is present', ['financials', 'content', 'semantic', 'multi-hop', 'trends', 'rankings', 'tech-performance', 'data-quality', 'existence', 'explain', 'persona'].filter((c) => !breadth.some((q) => q.category === c)), []);
  eq('exam: breadth questions cover all four personas', ['owner', 'office', 'tech', 'bookkeeper'].filter((p) => !breadth.some((q) => q.persona === p)), []);
  check('exam: every breadth question carries a persona; rubric ones say what must be cited', breadth.every((q) => q.persona) && breadth.filter((q) => q.cmp === 'rubric').every((q) => typeof q.citeWhat === 'string' && q.citeWhat.length > 3), JSON.stringify(breadth.filter((q) => !q.persona || (q.cmp === 'rubric' && !q.citeWhat)).map((q) => q.id).slice(0, 5)));
  check('exam: no breadth question opts out of citations except by an explicit citationRequired:false', breadth.every((q) => q.citationRequired === undefined || q.citationRequired === false));
  check('exam: money breadth questions are graded as figures (tolerance + any number in the sentence)', breadth.filter((q) => q.category === 'financials' && q.cmp === 'number' && /\b(?:owed?|invoice|revenue|receivable|collected|paid|spent|quote|fee|bring)/i.test(q.text) && /coalesce\(sum|avg|max|min/i.test(q.oracle.sql)).every((q) => q.tolerance === 1 && q.anyNumber === true));
  eq('exam: financials questions retire (skip) when the table is absent: each carries a document_financials guard', breadth.filter((q) => /document_financials/.test(q.oracle.sql) && !/document_financials/.test(q.oracle.requires?.sql ?? '')).map((q) => q.id), []);
  let stale = null;
  try { execFileSync('node', ['scripts/gen-scorecard.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }); } catch (err) { stale = String(err.stderr ?? err.message).slice(0, 300); }
  check('exam: exam.json matches what scripts/gen-scorecard.mjs generates from the bank (not stale)', stale === null, stale ?? '');
}

/* ================================================================== 2. comparators (pure) */
{
  const ans = (text, facts = [], kind = 'answer') => ({ kind, text, facts, sources: [] });
  const cmp = (cmpType, expected, data, question = '') => compareAnswer({ cmp: cmpType, expected, question, citationRequired: false }, data);
  // number
  check('number: exact match in the text passes', cmp('number', 13, ans('You have 13 customers in Mesa.')).passed);
  check('number: off by one fails', !cmp('number', 13, ans('You have 12 customers in Mesa.')).passed);
  check('number: the number is read from the first fact when the text has none', cmp('number', 7, ans('Here you go.', [{ label: 'Units', value: '7' }])).passed);
  check('number: a number that only echoes the question does not count', !cmp('number', 5, ans('Units older than 5 years: 19.'), 'How many units are older than 5 years?').passed);
  check('number: expected zero passes on an honest "none"', cmp('number', 0, ans('No customers match.')).passed);
  check('number: a no-answer fails', !cmp('number', 3, ans('I could not find that.', [], 'no-answer')).passed);
  // count-with-unknown (TEAM F, scorecard correctness): a status count where most rows print no status
  const cwu = (expected, data) => cmp('count-with-unknown', expected, data);
  check('count-with-unknown: right known count with no unknowns behaves like a plain number', cwu({ known: 3, unknown: 0 }, ans('3 invoices are unpaid.')).passed && !cwu({ known: 3, unknown: 0 }, ans('2 invoices are unpaid.')).passed);
  check('count-with-unknown: a confident "0" with unmentioned unknowns FAILS even though the number is right', !cwu({ known: 0, unknown: 67 }, ans('None of your invoices are unpaid.')).passed);
  check('count-with-unknown: the same right number PASSES once the answer states the unknown count', cwu({ known: 0, unknown: 67 }, ans('None show as unpaid; the other 67 do not print a payment status, so I cannot tell.')).passed);
  check('count-with-unknown: a non-zero known count also needs the unknowns disclosed to pass', !cwu({ known: 1, unknown: 67 }, ans('1 invoice is paid.')).passed && cwu({ known: 1, unknown: 67 }, ans("1 invoice shows paid; the other 67 don't record a status.")).passed);
  check('count-with-unknown: a wrong known count fails regardless of unknown wording', !cwu({ known: 5, unknown: 2 }, ans('3 invoices are unpaid; 2 unclear.')).passed);
  check('count-with-unknown: mentioning the literal unknown number also counts as disclosing it', cwu({ known: 0, unknown: 67 }, ans('0 are unpaid (67 have no status field at all).')).passed);
  // set
  const names = ['Ann Lee', 'Bo Chan', 'Cy Diaz', 'Di Evans', 'Ed Ford', 'Flo Gray', 'Gus Hill', 'Hal Ives', 'Ivy Jones', 'Jo Kim'];
  const factsFor = (list) => list.map((n) => ({ label: n, value: 'Mesa' }));
  check('set: full list passes', cmp('set', names, ans('Here are 10 customers.', factsFor(names))).passed);
  check('set: 9 of 10 (recall 0.9) still passes', cmp('set', names, ans('Here are 9.', factsFor(names.slice(0, 9)))).passed);
  const r8 = cmp('set', names, ans('Here are 8.', factsFor(names.slice(0, 8))));
  check('set: 8 of 10 fails on recall, and says so', !r8.passed && r8.recall === 0.8, JSON.stringify(r8));
  const extra = cmp('set', names, ans('x', factsFor([...names, 'Zed One', 'Zed Two', 'Zed Three'])));
  check('set: invented extra rows fail on precision', !extra.passed && extra.precision < 0.9, JSON.stringify(extra));
  check('set: "label|n" items need both parts in one fact', cmp('set', ['trane|4', 'carrier|5'], ans('x', [{ label: 'Trane', value: '4' }, { label: 'Carrier', value: '5' }])).passed
    && !cmp('set', ['trane|4', 'carrier|5'], ans('x', [{ label: 'Trane', value: '5' }, { label: 'Carrier', value: '4' }])).passed);
  check('set: an empty expected list passes only when nothing is returned', cmp('set', [], ans('No matches.')).passed && !cmp('set', [], ans('x', factsFor(['Ann Lee']))).passed);
  // value
  check('value: a phone number matches on digits regardless of formatting', cmp('value', ['480-555-0114'], ans('Phone: (480) 555-0114')).passed);
  check('value: a wrong phone fails', !cmp('value', ['480-555-0114'], ans('Phone: (480) 555-0999')).passed);
  check('value: a date matches across formats', cmp('value', ['2026-03-05'], ans('Last serviced on March 5, 2026.')).passed && cmp('value', ['2026-03-05'], ans('It was 3/5/2026')).passed);
  check('value: a warranty status matches by meaning', cmp('value', ['expired'], ans('That unit is out of warranty.')).passed && !cmp('value', ['active'], ans('That unit is out of warranty.')).passed);
  check('value: any accepted alternative passes', cmp('value', ['GD-2002', 'GSX140361K'], ans('Model GSX140361K')).passed);
  check('value: an EMPTY expectation means "not on file": inventing one fails, declining passes', !cmp('value', [], ans('The serial is TR-1234.', [{ label: 'Serial', value: 'TR-1234' }])).passed && cmp('value', [], ans('There is no serial on file.')).passed);
  eq('warrantyStatusFromText reads the four states', ['expired soon?', 'still under warranty', 'no warranty on file', 'expiring in 3 weeks'].map(warrantyStatusFromText), ['expired', 'active', 'unknown', 'expiring']);
  eq('datesIn parses ISO, US and long dates', [...datesIn('2026-01-02 and 3/4/2025 and Sep 10, 2026')].sort(), ['2025-03-04', '2026-01-02', '2026-09-10']);
  // yesno
  check('yesno: "Yes, ..." matches true; "No, ..." matches false', cmp('yesno', true, ans('Yes, we do.')).passed && cmp('yesno', false, ans('No, there is no permit on file.')).passed);
  check('yesno: the wrong commitment fails', !cmp('yesno', true, ans('No, nothing.')).passed && !cmp('yesno', false, ans('Yes, there is one.')).passed);
  // honest-zero
  check('honest-zero: declining passes', cmp('honest-zero', null, ans('I do not have invoice totals yet.', [], 'no-answer')).passed && cmp('honest-zero', null, ans('That is not tracked in the records.')).passed);
  check('honest-zero: inventing a figure or facts fails', !cmp('honest-zero', null, ans('You invoiced $12,400 last month.')).passed && !cmp('honest-zero', null, ans('x', [{ label: 'Revenue', value: '12400' }])).passed);
  // expectedFromRows + scoreResults
  eq('expectedFromRows: number/set/value/yesno/honest-zero conventions',
    [expectedFromRows('number', [{ n: '4' }]).expected, expectedFromRows('set', [{ item: 'a' }, { item: null }, { item: 'b' }]).expected, expectedFromRows('value', [{ v: 'x' }, { v: '' }]).expected, expectedFromRows('yesno', [{ v: true }]).expected, expectedFromRows('honest-zero', [{ n: 0 }]).dataExists, expectedFromRows('honest-zero', [{ n: 2 }]).dataExists],
    [4, ['a', 'b'], ['x'], true, false, true]);
  const sc = scoreResults([{ category: 'a', passed: true }, { category: 'a', passed: false }, { category: 'b', passed: true }, { category: 'b', skipped: true, passed: false }]);
  eq('scoreResults: overall and per category, skipped questions excluded', [sc.total, sc.passed, sc.score, sc.byCategory.a.score, sc.byCategory.b.total], [3, 2, 0.6667, 0.5, 1]);
  // ---- adjudicated grader behaviour
  check('adjudication: "no warranty date on file" is the same answer as an oracle "unknown"', cmp('value', ['unknown'], ans('There is no warranty date on file for the Salazar unit.')).passed && cmp('value', ['unknown'], ans("The warranty date isn't on file.")).passed && !cmp('value', ['active'], ans('There is no warranty date on file.')).passed);
  eq('warrantyStatusFromText: "no warranty date on file" / "warranty not recorded" read as unknown', ['No warranty date on file', 'Warranty expiration not recorded', 'no expiry listed'].map(warrantyStatusFromText), ['unknown', 'unknown', 'unknown']);
  // ---- money figures: tolerance and any number in the sentence
  check('money: the figure may be any number in the sentence, within a dollar', compareAnswer({ cmp: 'number', expected: 4700.5, question: 'How much have we invoiced?', tolerance: 1, anyNumber: true, citationRequired: false }, ans('You have 4 invoices totaling $4,700.50.')).passed
    && compareAnswer({ cmp: 'number', expected: 4700.5, question: 'q', tolerance: 1, anyNumber: true, citationRequired: false }, ans('About $4,701 invoiced.')).passed
    && !compareAnswer({ cmp: 'number', expected: 4700.5, question: 'q', tolerance: 1, anyNumber: true, citationRequired: false }, ans('You invoiced $4,200.')).passed);
  // ---- alternate definitions count ONLY when the answer states which one it used
  const altQ = { cmp: 'number', expected: 239, question: 'How many documents have we added year to date?', citationRequired: false, alts: [{ expected: 123, says: 're:(service|work) dates?|dated' }] };
  check('alt definition: a number from the other reading passes only if the answer says which reading it used', compareAnswer(altQ, ans('123 documents by service date this year.')).passed && compareAnswer(altQ, ans('239 documents were uploaded this year.')).passed
    && !compareAnswer(altQ, ans('You added 123 documents this year.')).passed && !compareAnswer(altQ, ans('You added 77 documents by service date.')).passed);
  const said = compareAnswer(altQ, ans('123 documents by service date this year.'));
  check('alt definition: the verdict records which alternate was accepted', /alternate/.test(said.why) && said.usedAlt, JSON.stringify(said));
  // ---- CITATIONS: a right value with no source fails; the accepted shapes all count
  const src = [{ documentId: 'd1', location: {} }];
  const needs = (data, extra = {}) => compareAnswer({ cmp: 'number', expected: 13, question: 'How many customers in Mesa?', ...extra }, data);
  const uncited = needs(ans('You have 13 customers in Mesa.'));
  check('citation: the right number with NO source fails, and says why', !uncited.passed && uncited.valueOk === true && uncited.cited === false && uncited.citationRequired === true && /citation/.test(uncited.why), JSON.stringify(uncited));
  check('citation: data.sources passes', needs({ ...ans('You have 13 customers in Mesa.'), sources: src }).passed);
  check('citation: facts[].sources passes', needs(ans('You have 13 customers in Mesa.', [{ label: 'Mesa', value: '13', sources: src }])).passed);
  check('citation: data.records (aggregate drill-down) passes', needs({ ...ans('You have 13 customers in Mesa.'), records: [{ id: 'c1', label: 'Karen Abernathy' }] }).passed);
  check('citation: data.citations and facts[].documentId pass', needs({ ...ans('You have 13 customers in Mesa.'), citations: [{ documentId: 'd1' }] }).passed && needs(ans('You have 13 customers in Mesa.', [{ label: 'Mesa', value: '13', documentId: 'd1' }])).passed);
  check('citation: an empty sources array does not count', !needs({ ...ans('You have 13 customers in Mesa.'), sources: [], records: [] }).passed);
  eq('countCitations counts every accepted shape', countCitations({ sources: [1], citations: [1, 2], records: [1], facts: [{ sources: [1], documentId: 'd' }] }), 6);
  check('citation: a WRONG value with a source still fails (value first)', !needs({ ...ans('You have 12 customers in Mesa.'), sources: src }).passed);
  check('citation: citationRequired:false turns the check off for that question', needs(ans('You have 13 customers in Mesa.'), { citationRequired: false }).passed);
  check('citation: nothing to cite when the right answer is none (zero / no / not on file / honest decline)',
    compareAnswer({ cmp: 'number', expected: 0, question: 'q' }, ans('No customers match.')).passed && compareAnswer({ cmp: 'yesno', expected: false, question: 'q' }, ans('No, we have none.')).passed
    && compareAnswer({ cmp: 'value', expected: [], question: 'q' }, ans('There is no serial on file.')).passed && compareAnswer({ cmp: 'honest-zero', expected: null, question: 'q' }, ans('That is not tracked.', [], 'no-answer')).passed
    && compareAnswer({ cmp: 'set', expected: [], question: 'q' }, ans('No matches.')).passed);
  check('citation: a right yes / a right list / a right value with no source fail', !compareAnswer({ cmp: 'yesno', expected: true, question: 'q' }, ans('Yes, we do.')).passed
    && !compareAnswer({ cmp: 'set', expected: ['Ann Lee'], question: 'q' }, ans('x', [{ label: 'Ann Lee', value: 'Mesa' }])).passed && !compareAnswer({ cmp: 'value', expected: ['(480) 555-0114'], question: 'q' }, ans('Phone: (480) 555-0114')).passed);
  check('isSubstantive: only an affirmative expected answer needs a source', isSubstantive({ cmp: 'number', expected: 3 }) && !isSubstantive({ cmp: 'number', expected: 0 }) && !isSubstantive({ cmp: 'yesno', expected: false }) && !isSubstantive({ cmp: 'honest-zero' }) && isSubstantive({ cmp: 'rubric', expected: ['x'] }) && !isSubstantive({ cmp: 'rubric', expected: [] }));
  const scored = scoreResults([
    { category: 'a', passed: true, valueOk: true, cited: true, citationRequired: true }, { category: 'a', passed: false, valueOk: true, cited: false, citationRequired: true },
    { category: 'b', passed: false, valueOk: false, cited: true, citationRequired: true }, { category: 'b', passed: true, valueOk: true, cited: false, citationRequired: false },
  ]);
  eq('scoreResults: pass score, value-only score and citation coverage are reported separately', [scored.score, scored.valueScore, scored.citation.required, scored.citation.cited, scored.citation.coverage, scored.byCategory.a.citationCoverage, scored.byCategory.b.valueScore], [0.5, 0.75, 3, 2, 0.6667, 0.5, 0.5]);
  // TEAM T3 (2026-09-25): citation precision / unsupported-claim rate, list recall and average cost are all
  // averaged from detail.citationPrecision / detail.recall / costUsd - null/absent when nothing measured it.
  const qualityResults = [
    { category: 'a', passed: true, costUsd: 0.01, comparison: 'number', latencyMs: 100, detail: { citationPrecision: 1, recall: 1 } },
    { category: 'a', passed: false, costUsd: 0.02, comparison: 'set', latencyMs: 200, detail: { citationPrecision: 0.5, recall: 0.8 } },
    { category: 'b', passed: true, costUsd: 0.03, comparison: 'number', latencyMs: 300, detail: {} },
  ];
  const qs = scoreResults(qualityResults);
  eq('scoreResults: citation precision / unsupported-claim rate averaged over answers actually checked', [qs.citation.precisionAvg, qs.citation.unsupportedClaimRate, qs.citation.checked], [0.75, 0.25, 2]);
  eq('scoreResults: list recall (completeness) averaged over set-comparison answers', [qs.completeness.recallAvg, qs.completeness.n], [0.9, 2]);
  eq('scoreResults: average cost per question, overall and per category', [qs.avgCostUsd, qs.byCategory.a.avgCostUsd, qs.byCategory.b.avgCostUsd], [0.02, 0.015, 0.03]);
  eq('scoreResults: latency bucketed by comparison type (the nearest available route proxy)', [qs.latencyByComparison.number.n, qs.latencyByComparison.number.p50Ms, qs.latencyByComparison.set.n], [2, 100, 1]);
  eq('scoreResults: no measurable citation precision/recall reports null, not zero', scoreResults([{ category: 'a', passed: true, costUsd: 0.01 }]).citation.precisionAvg, null);
  eq('scoreResults: results stored before citation scoring count their pass as the value verdict', scoreResults([{ category: 'a', passed: true }]).valueScore, 1);
  check('oracleSqlOk refuses writes, multi-statements and non-selects', !oracleSqlOk('DELETE FROM entities') && !oracleSqlOk('SELECT 1; DROP TABLE x') && !oracleSqlOk('WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x') && oracleSqlOk("SELECT 'update' AS v"));
}

/* ================================================================== harness: real Postgres via PGlite (as verify-agent.mjs) */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  realLog(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  realLog(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed (database-backed checks skipped).`);
  process.exit(failures ? 1 : 0);
}
const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* harness notes are printed by verify-agent */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* as verify-agent */ }

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const usage = await import('../api/_lib/usage.js');
const { runDonovanAgent, agentDebugTrace, AGENT_MODEL } = await import('../api/_lib/agent/loop.js');
const esc = await import('../api/_lib/agent/escalation.js');
const { createToolbox } = await import('../api/_lib/agent/tools.js');
const { shapeAgentAnswer } = await import('../api/_lib/agent/shape.js');
const { runScorecard, nightlySlice, NIGHTLY_SLICE } = await import('../api/_lib/scorecard/runner.js');
const store = await import('../api/_lib/scorecard/store.js');
const { SCORECARD_CALL, takeScorecardCall } = await import('../api/_lib/scorecard/hook.js');
const routes = await import('../api/_lib/routes/scorecard.js');
const { findCustomersInBody, applyBodyNameLinks } = await import('../api/_lib/bodyNameLink.js');
const integrity = await import('../api/_lib/routes/integrity.js');
const { significantTokens, claimSupportedByText, citationPrecision, checkCitationPrecision } = await import('../api/_lib/scorecard/citationCheck.js');
const baseline = await import('../api/_lib/scorecard/baseline.js');
const baselineStore = await import('../api/_lib/scorecard/baselineStore.js');

const TODAY = '2026-09-23';
const ctxA = { tenantKey: 'org_harness_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_harness_b', tenantName: 'Other Shop' };
const ctxC = { tenantKey: 'org_harness_c', tenantName: 'Body Name Shop' };
const ctxD = { tenantKey: 'org_harness_d', tenantName: 'Cap Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const tenC = (await getTenantContext(ctxC.tenantKey, ctxC.tenantName)).id;
await getTenantContext(ctxD.tenantKey, ctxD.tenantName);
const uid = (t, k, n) => `${t}${k}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedTenant(t, tenantId, world) {
  const ent = (id, type, data, extra = {}) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5,$6)',
    [id, tenantId, type, JSON.stringify(data), extra.customerId ?? null, extra.number ?? null]);
  for (const c of world.customers) await ent(uid(t, 'c', c.n), 'customer', { customer_name: c.name, service_address: c.address, phone: c.phone ?? null, email: c.email ?? null, ...(c.nameSource ? { name_source: c.nameSource } : {}) }, { number: `C-${t}${String(c.n).padStart(4, '0')}` });
  for (const e of world.equipment ?? []) {
    await ent(uid(t, 'e', e.n), 'equipment', { manufacturer: e.mfr, model: e.model, serial_number: e.serial, equipment_type: e.type, installation_date: e.installed, service_address: e.address, ...(e.warranty ? { warranty: e.warranty } : {}) }, { customerId: uid(t, 'c', e.customer) });
  }
  for (const d of world.docs ?? []) {
    await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(t, 'd', d.n), tenantId, d.file, d.type, `${t}-hash-${d.n}`, d.stage ?? 'verified']);
    if (d.storage) await lite.query('UPDATE documents SET storage_key = $2, content_type = $3, page_count = $4 WHERE id = $1', [uid(t, 'd', d.n), d.storage.key, d.storage.type, d.storage.pages ?? 1]);
    for (const link of d.links ?? []) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', d.n), link]);
    for (const x of d.facts ?? []) {
      await lite.query('INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.9)', [tenantId, uid(t, 'd', d.n), x.entity ?? null, x.key, x.value]);
    }
    for (const [i, text] of (d.pages ?? []).entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [uid(t, 'd', d.n), tenantId, i + 1, text]);
  }
}

// Tenant A: the same shop verify-agent.mjs uses, plus a nameplate photo and a scanned PDF for the view tests.
const worldA = {
  customers: [
    { n: 1, name: 'Karen Abernathy', address: '412 Elm St, Mesa, AZ 85201', phone: '(480) 555-0148', email: 'karen@example.com' },
    { n: 2, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 3, name: 'Plaza Dental Group', address: '2210 E Main St, Gilbert, AZ 85234' },
    { n: 4, name: 'Donna Thornton', address: '17 Cactus Ln, Tucson, AZ 85701', email: 'donna@example.com' },
    { n: 5, name: 'Old Timer', address: '5 Oak Rd, Phoenix, AZ 85001' },
  ],
  equipment: [
    { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'TR-1001', type: 'condenser', installed: '2020-05-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2030-05-01' } },
    { n: 2, customer: 2, mfr: 'Goodman', model: 'GSX140361K', serial: 'GD-2002', type: 'condenser', installed: '2016-10-15', address: '88 Whitmore Ave, Mesa, AZ 85201', warranty: { expires: '2026-10-15' } },
    { n: 3, customer: 3, mfr: 'Carrier', model: '24ACC636', serial: 'CR-3003', type: 'condenser', installed: '2014-01-01', address: '2210 E Main St, Gilbert, AZ 85234', warranty: { expires: '2024-01-01' } },
    { n: 4, customer: 4, mfr: 'Lennox', model: 'EL16XC1', serial: 'LX-4004', type: 'condenser', installed: '2019-03-03', address: '17 Cactus Ln, Tucson, AZ 85701' },
    { n: 5, customer: 1, mfr: 'Trane', model: 'S9V2', serial: 'TR-1005', type: 'furnace', installed: '2021-01-01', address: '412 Elm St, Mesa, AZ 85201', warranty: { expires: '2029-01-01' } },
  ],
  docs: [
    { n: 1, file: 'karen-service-sep.pdf', type: 'service-ticket', links: [uid('a', 'c', 1)], facts: [{ key: 'service_date', value: '2026-09-10' }, { key: 'technician', value: 'Danny Ochoa' }], pages: ['Service ticket Karen Abernathy 412 Elm St'] },
    { n: 2, file: 'karen-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 1)] },
    { n: 3, file: 'whitmore-service-2025.pdf', type: 'service-ticket', links: [uid('a', 'c', 2)], facts: [{ key: 'service_date', value: '2025-11-02' }] },
    { n: 4, file: 'whitmore-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 2)] },
    { n: 5, file: 'plaza-maint-agreement.pdf', type: 'maintenance-agreement', links: [uid('a', 'c', 3)] },
    { n: 6, file: 'thornton-permit.pdf', type: 'permit', links: [uid('a', 'c', 4)], facts: [{ key: 'permit_number', value: 'BP-2024-08841' }], pages: ['City of Tucson building permit BP-2024-08841 issued for 17 Cactus Ln condenser replacement'] },
    { n: 7, file: 'plaza-service-sep.pdf', type: 'service-ticket', links: [uid('a', 'e', 3)], facts: [{ key: 'service_date', value: '2026-09-15' }, { key: 'technician', value: 'Danny Ochoa' }] },
    { n: 8, file: 'thornton-workorder.pdf', type: 'work-order', links: [uid('a', 'c', 4)], stage: 'read', facts: [{ key: 'service_date', value: '2026-03-05' }], pages: ['Work order Thornton 17 Cactus Ln. Replaced capacitor.'] },
    { n: 9, file: 'thornton-nameplate.png', type: 'nameplate-photo', links: [uid('a', 'e', 4)], storage: { key: 'k/nameplate.png', type: 'image/png', pages: 1 }, pages: ['Nameplate photo (smudged) LX-4OO4'] },
    { n: 10, file: 'plaza-scan-6pg.pdf', type: 'other', links: [uid('a', 'c', 3)], storage: { key: 'k/six.pdf', type: 'application/pdf', pages: 6 }, pages: ['Plaza scan page 1', 'p2', 'p3', 'p4', 'p5', 'p6'] },
    { n: 11, file: 'plaza-scan-1pg.pdf', type: 'other', links: [uid('a', 'c', 3)], storage: { key: 'k/one.pdf', type: 'application/pdf', pages: 1 }, pages: ['Plaza single page scan'] },
    { n: 12, file: 'plaza-scan-huge.pdf', type: 'other', links: [uid('a', 'c', 3)], storage: { key: 'k/huge.pdf', type: 'application/pdf', pages: 2 }, pages: ['Plaza huge scan'] },
    { n: 13, file: 'thornton-heic.heic', type: 'other', links: [uid('a', 'c', 4)], storage: { key: 'k/photo.heic', type: 'image/heic', pages: 1 }, pages: ['Thornton iPhone photo'] },
  ],
};
const worldB = {
  customers: [{ n: 1, name: 'Zed Competitor', address: '1 Secret Way, Reno, NV 89501' }],
  equipment: [{ n: 1, customer: 1, mfr: 'York', model: 'B-MODEL', serial: 'YK-9', type: 'condenser', installed: '2022-01-01', address: '1 Secret Way, Reno, NV 89501', warranty: { expires: '2035-01-01' } }],
  docs: [{ n: 1, file: 'b-secret-permit.pdf', type: 'permit', links: [uid('b', 'c', 1)], pages: ['Secret permit Zed Competitor'] }],
};
// Tenant C: memos for the body-name link.
const memo = (n, text, extra = {}) => ({ n, file: `memo-${n}.txt`, type: 'correspondence', stage: 'read', pages: [text], ...extra });
const worldC = {
  customers: [
    { n: 1, name: 'David Prentiss', address: '9 Pine Ct, Mesa, AZ 85201' },
    { n: 2, name: 'Ann Lee', address: '3 A St, Tucson, AZ 85701' },
    { n: 3, name: 'Ann Lee', address: '4 B St, Tucson, AZ 85701' },
    { n: 4, name: 'Sam Ortega', address: '21 Ridge Rd, Gilbert, AZ 85234' },
    { n: 5, name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { n: 6, name: 'Customer at 12 Elm St', address: '12 Elm St, Mesa, AZ 85201', nameSource: 'address' },
  ],
  docs: [
    memo(1, "Reminder logged for David Prentiss's account: confirm filter size on next visit."),
    memo(2, 'Call Ann Lee about the noisy condenser.'),
    memo(3, 'Follow up with Prentiss about the invoice.'),
    memo(4, 'Reminder for Zed Competitor: renew the agreement.'),
    memo(5, 'Dropped off parts at 88 Whitmore Ave, Mesa.'),
    memo(6, 'Sam Ortega asked about the unit at 88 Whitmore Ave.'),
    memo(7, "Reminder logged for David Prentiss's account: check the thermostat.", { links: [uid('c', 'c', 4)] }),
    memo(8, "Reminder logged for David Prentiss's account: call back Friday."),
    memo(9, 'Note about the unit at 12 Elm St for the record.'),
    memo(10, 'David Prentiss called about billing.', { facts: [{ key: 'customer_name', value: 'D. Prentiss (handwritten)' }] }),
  ],
};
await seedTenant('a', tenA, worldA);
await seedTenant('b', tenB, worldB);
await seedTenant('c', tenC, worldC);
// Document 8 in tenant C was explicitly unlinked from a customer by a person: never auto-linked afterwards.
await withTenant(ctxC, (db) => db.logAction({ action: 'review.document_unlinked', resource_type: 'document', resource_id: uid('c', 'd', 8), changes: { removed: true } }));

/* ================================================================== 3. oracles on seeded data */
const oracleOf = async (ctx, entry, today = TODAY) => {
  const spec = classify(entry);
  if (!spec) return { spec: null };
  const q = { text: entry.text, cmp: spec.cmp, oracle: { sql: spec.sql, params: spec.params, ...(spec.requires ? { requires: spec.requires } : {}), ...(spec.alt ? { alt: spec.alt } : {}) }, ...(spec.rubric ? { rubric: spec.rubric } : {}), ...(spec.maxItems ? { maxItems: spec.maxItems } : {}) };
  return { spec, ...(await runOracle(withTenant, ctx, q, { today })), question: q };
};
const an = (text, expect, category = 'x') => ({ id: 'h', text, category, expect: { route: 'analytics', ...expect } });
const lk = (text, expect = { route: 'lookup' }, category = 'lookups') => ({ id: 'h', text, category, expect });
const CUST = (extra) => ({ entity: 'customers', ...extra });
const F = (field, value, op = 'eq') => ({ field, op, value });
{
  const o = async (entry) => oracleOf(ctxA, entry);
  const ex = async (entry) => (await o(entry)).expected;
  eq('oracle: customers in Mesa (city regex over service_address) = 2', await ex(an('How many customers do we have in Mesa?', CUST({ filters: [F('city', 'Mesa')], answerValue: 2 }))), 2);
  eq('oracle: customers in zip 85701 = 1', await ex(an('How many customers in 85701?', CUST({ filters: [F('zip', '85701')], answerValue: 1 }))), 1);
  eq('oracle: units by brand (Trane) = 2', await ex(an('How many Trane units do we have?', { entity: 'equipment', filters: [F('brand', 'Trane')], answerValue: 2 })), 2);
  eq('oracle: units older than 5 years (install year < 2021, relative to the run date) = 4', await ex(an('How many units are older than 5 years?', { entity: 'equipment', filters: [F('installYear', 2021, 'lt')], answerValue: 4 })), 4);
  eq('oracle: units older than 10 years (install year < 2016) = 1', await ex(an('How many units older than 10 years do we have?', { entity: 'equipment', filters: [F('installYear', 2016, 'lt')], answerValue: 1 })), 1);
  eq('oracle: warranty expired / expiring / active / unknown = 1 / 1 / 2 / 1 (status computed from data->warranty->expires vs the run date)',
    await Promise.all([['expired', 'How many units are out of warranty?'], ['expiring', 'How many units are expiring soon?'], ['active', 'How many units have an active warranty?'], ['unknown', 'How many units have an unknown warranty status?']]
      .map(([s, t]) => ex(an(t, { entity: 'warranties', filters: [F('warrantyStatus', s)], answerValue: 0 })))), [1, 1, 2, 1]);
  eq('oracle: total documents = 13, invoices = 0', [await ex(an('How many documents do we have?', { entity: 'documents', answerValue: 13 })), await ex(an('How many invoices do we have?', { entity: 'documents', filters: [F('documentType', 'invoice')], answerValue: 0 }))], [13, 0]);
  eq('oracle: customers with an email on file / missing one = 2 / 3', [await ex(an('How many customers have an email on file?', CUST({ filters: [F('hasEmail', true)], answerValue: 2 }))), await ex(an('How many customers are missing an email address?', CUST({ filters: [F('hasEmail', false)], answerValue: 3 })))], [2, 3]);
  eq('oracle: two conditions - "Which customers have an expired warranty in Gilbert" is a SET', await ex(an('Which customers have an expired warranty in Gilbert?', CUST({ filters: [F('city', 'Gilbert'), F('warrantyStatus', 'expired')], answerValue: 1 }))), ['Plaza Dental Group']);
  eq('oracle: two conditions - Mesa + expired is an empty set', await ex(an('Which customers have an expired warranty in Mesa?', CUST({ filters: [F('city', 'Mesa'), F('warrantyStatus', 'expired')], answerValue: 0 }))), []);
  eq('oracle: yes/no - Trane customers in Gilbert = false, in Mesa = true',
    [await ex(an('Do we have any Trane customers in Gilbert?', CUST({ filters: [F('brand', 'Trane'), F('city', 'Gilbert')], answerValue: false }))), await ex(an('Do we have any Trane customers in Mesa?', CUST({ filters: [F('brand', 'Trane'), F('city', 'Mesa')], answerValue: true })))], [false, true]);
  eq('oracle: group units by brand is a set of "brand|n"', (await ex(an('Group equipment by brand', { entity: 'equipment', groupBy: 'brand', answerValue: { Trane: 2 } })))?.sort(), ['carrier|1', 'goodman|1', 'lennox|1', 'trane|2']);
  eq('oracle: "how many different zip codes" = 4', await ex(an('How many different zip codes do we cover?', CUST({ groupBy: 'zip', answerValue: 4 }))), 4);
  eq('oracle: "which zip codes do we serve" lists names only (no counts)', (await ex(an('What zip codes do we serve?', CUST({ groupBy: 'zip', answerValue: {} }))))?.sort(), ['85001', '85201', '85234', '85701']);
  check('generator: "the top brand" (a one-item answer) and unexpressible time filters are NOT turned into a set/number oracle',
    classify(an('Which brand do we have the most of?', { entity: 'equipment', groupBy: 'brand', answerValue: {} })) === null
    && classify(an('Customers whose warranty expires in the next 90 days?', { entity: 'warranties', answerValue: 1 })) === null);
  // lookups
  eq('oracle: phone for a named customer', await ex(lk("What's the phone number on file for Karen Abernathy?")), ['(480) 555-0148']);
  eq('oracle: email for a customer with none is EMPTY (Donovan must not invent one)', await ex(lk("What's the email for Bill Whitmore?")), []);
  eq('oracle: serial by surname', await ex(lk("what's the serial on the Whitmore unit")), ['GD-2002']);
  eq('oracle: install date by address', await ex(lk('When was the unit at 17 Cactus Ln installed?')), ['2019-03-03']);
  eq('oracle: who makes the unit at an address', await ex(lk('Who makes the unit at 412 Elm St, Mesa, AZ 85201?')), ['Trane', 'Trane']);
  eq('oracle: warranty status of the unit at an address = expiring', await ex(lk('Is the unit at 88 Whitmore Ave still under warranty?')), ['expiring']);
  eq('oracle: permit yes / no by address', [await ex(lk('did we pull a permit for 17 Cactus Ln')), await ex(lk('Did we pull a permit for 412 Elm St'))], [true, false]);
  eq('oracle: maintenance agreement by surname', await ex(lk('do we have a maintenance agreement on file for the Thornton job')), false);
  eq('oracle: invoices for a customer (none) = 0', await ex(lk('List invoices for Whitmore')), 0);
  eq('oracle: last service date by address (the latest ISO service_date among its documents)', await ex(lk('When did we last service the unit at 17 Cactus Ln, Tucson, AZ 85701?', { route: 'lookup' }, 'history')), ['2026-03-05']);
  const ghost = await o(lk("What's the phone number on file for Linda Fitzgerald?"));
  check('oracle: a customer this shop does not have is SKIPPED (requires guard), not failed', ghost.ok && ghost.skip === true, JSON.stringify(ghost).slice(0, 200));
  const otherTenant = await o(lk("What's the phone number on file for Zed Competitor?"));
  check('oracle: another tenant\'s customer is not visible to this tenant\'s oracle (RLS) -> skipped', otherTenant.skip === true);
  // time / technician
  eq('oracle: service calls this month (2026-09) = 2, last month = 0', [await ex(an('How many service calls this month?', { entity: 'serviceVisits', timeRange: { from: '2026-09', to: '2026-09' } }, 'time')), await ex(an('How many service calls last month?', { entity: 'serviceVisits', timeRange: {} }, 'time'))], [2, 0]);
  eq('oracle: jobs by a named technician this month = 2', await ex(an('How many jobs did Danny Ochoa run this month?', { entity: 'serviceVisits', filters: [F('technician', 'Danny Ochoa')], timeRange: {} }, 'technician')), 2);
  eq('oracle: "which customers did we service this month" is a set', (await ex(an('Which customers did we service this month?', { entity: 'serviceVisits', timeRange: {} }, 'live-misses-2026-09-21b')))?.sort(), ['Karen Abernathy']);
  const tr = await o(an('Who did the most jobs this month?', { entity: 'serviceVisits', timeRange: {} }, 'technician'));
  check('oracle: "who did the most jobs" is a deterministic VALUE (the busiest technician), not a model-graded rubric', tr.spec.cmp === 'value' && tr.expected.includes('Danny Ochoa'), JSON.stringify(tr.expected));
  // honest-zero
  // The harness has the financials migration (22) applied: hide its two tables so "no financials table" is true first.
  await lite.exec('ALTER TABLE document_financial_lines RENAME TO hidden_dfl; ALTER TABLE document_financials RENAME TO hidden_df');
  const money = await o(an('How much revenue came in last month?', { entity: 'documents', unsupported: true, note: 'financials layer' }, 'money'));
  check('oracle: a money question is an honest-zero while no financials table exists', money.spec.cmp === 'honest-zero' && money.ok && !money.skip);
  await lite.exec('CREATE TABLE financial_records_probe (id int)');
  const moneyLater = await o(an('How much revenue came in last month?', { entity: 'documents', unsupported: true, note: 'financials layer' }, 'money'));
  check('oracle: once a financials table exists, the money question retires itself (skipped, not failed)', moneyLater.skip === true, JSON.stringify(moneyLater).slice(0, 160));
  await lite.exec('DROP TABLE financial_records_probe');
  // The real financials tables (document_financials) retire it too - the pattern must match their name.
  await lite.exec('ALTER TABLE hidden_df RENAME TO document_financials; ALTER TABLE hidden_dfl RENAME TO document_financial_lines');
  const moneyReal = await o(an('How much revenue came in last month?', { entity: 'documents', unsupported: true, note: 'financials layer' }, 'money'));
  check('oracle: the real document_financials table retires the money honest-zero question', moneyReal.skip === true, JSON.stringify(moneyReal).slice(0, 160));
  const comp = await o(lk('Has this unit had a compressor replaced? 17 Cactus Ln', { route: 'retrieval', unsupported: true }, 'notes'));
  check('oracle: "compressor replaced" is an honest-zero while no page mentions a compressor', comp.spec.cmp === 'honest-zero' && !comp.skip);
  // the whole shipped exam executes cleanly on real Postgres
  let broken = [];
  let skipped = 0;
  for (const q of exam.questions) {
    const r = await runOracle(withTenant, ctxA, q, { today: TODAY });
    if (!r.ok) broken.push(`${q.id}: ${r.error}`); else if (r.skip) skipped++;
  }
  eq(`every one of the ${exam.questions.length} shipped oracles executes without a SQL error on tenant A (${skipped} skipped: subject not in this shop)`, broken.slice(0, 5), []);
}

/* ================================================================== 3b. adjudicated oracles + breadth on a seeded shop */
const ctxF = { tenantKey: 'org_harness_f', tenantName: 'Adjudication Shop' };
const tenF = (await getTenantContext(ctxF.tenantKey, ctxF.tenantName)).id;
const worldF = {
  customers: [
    { n: 1, name: 'Ann Alpha', address: '10 Main St, Mesa, AZ 85201', phone: '(480) 555-0101', email: 'ann@example.com' },
    { n: 2, name: 'Bob Bravo', address: '20 Oak Ave, Tempe AZ 85281', phone: '(480) 555-0102', email: 'bob@example.com' }, // no comma before the state
    { n: 3, name: 'Cy Charlie', address: '30 Elm Rd, Suite 110, Mesa, AZ 85202-1234', phone: '(480) 555-0103' }, // suite segment + ZIP+4
    { n: 4, name: 'Di Delta', address: '40 Pine Ln, Gilbert, AZ' }, // no zip
    { n: 5, name: 'Ed Echo', address: '50 Cedar Dr, Las Vegas, NV 89101', phone: '(702) 555-0105', email: 'ed@example.com' },
    { n: 6, name: 'Fay Foxtrot', address: '60 Birch Ct, Mesa AZ 85203', phone: '(480) 555-0106' }, // no comma before the state
    { n: 7, name: 'Gus Golf', address: '70 Palm Way, Tucson, AZ 85701' },
    { n: 8, name: 'Ann Alpha', address: '11 Main St, Mesa, AZ 85201', phone: '(480) 555-0108' }, // a second customer with the same name
  ],
  equipment: [
    { n: 1, customer: 1, mfr: 'Trane', model: 'XR14', serial: 'S1', type: 'condenser', installed: '2020-06-01', address: '10 Main St, Mesa, AZ 85201', warranty: { expires: '2030-06-01' } },
    { n: 2, customer: 1, mfr: 'Carrier', model: 'C2', serial: 'S2', type: 'condenser', installed: '2012-01-01', address: '10 Main St, Mesa, AZ 85201', warranty: { expires: '2022-01-01' } },
    { n: 3, customer: 2, mfr: 'Trane', model: 'XR14', serial: 'S3', type: 'condenser', installed: '2021-03-01', address: '20 Oak Ave, Tempe AZ 85281' },
    { n: 4, customer: 3, mfr: 'Lennox', model: 'L4', serial: '', type: 'furnace', installed: '2005-05-05', address: '30 Elm Rd, Suite 110, Mesa, AZ 85202-1234' },
    { n: 5, customer: 5, mfr: 'Trane', model: 'XR16', serial: 'S5', type: 'condenser', installed: '2024-01-01', address: '50 Cedar Dr, Las Vegas, NV 89101', warranty: { expires: '2034-01-01' } },
    { n: 6, customer: 7, mfr: 'Goodman', model: 'G6', serial: '', type: 'condenser', installed: '2009-09-09', address: '70 Palm Way, Tucson, AZ 85701', warranty: { expires: '2019-09-09' } },
    { n: 7, customer: 1, mfr: 'Lennox', model: 'L7', serial: 'S7', type: 'furnace', installed: '2022-02-02', address: '10 Main St, Mesa, AZ 85201' },
    { n: 8, customer: 2, mfr: 'Rheem', model: 'R8', serial: 'S8', type: 'condenser', installed: '2023-03-03', address: '20 Oak Ave, Tempe AZ 85281' },
    { n: 9, customer: 7, mfr: 'Trane', model: 'XR9', serial: 'S9', type: 'condenser', installed: '2010-10-10', address: '70 Palm Way, Tucson, AZ 85701' },
  ],
  docs: [
    { n: 1, file: 'ann-sep.pdf', type: 'service-ticket', links: [uid('f', 'c', 1)], facts: [{ key: 'service_date', value: '2026-09-10' }, { key: 'technician', value: 'Danny Ochoa' }], pages: ['Replaced capacitor. Customer said the unit was loud.'] },
    { n: 2, file: 'ann-scheduled.pdf', type: 'service-ticket', links: [uid('f', 'c', 1)], facts: [{ key: 'service_date', value: '2027-11-14' }, { key: 'technician', value: 'Danny Ochoa' }], pages: ['Scheduled follow-up visit.'] },
    { n: 3, file: 'ann-agreement.pdf', type: 'maintenance-agreement', links: [uid('f', 'c', 1)], facts: [{ key: 'service_date', value: '2028-01-01' }], pages: ['Maintenance agreement term'] },
    { n: 4, file: 'cy-2025.pdf', type: 'service-ticket', links: [uid('f', 'c', 3)], facts: [{ key: 'service_date', value: '2025-01-05' }, { key: 'technician', value: 'Marisol Vega' }], pages: ['Refrigerant recharge, R-410A added. Found a leak at the coil.'] },
    { n: 5, file: 'cy-2025-wo.pdf', type: 'work-order', links: [uid('f', 'c', 3)], facts: [{ key: 'service_date', value: '2025-01-05' }, { key: 'technician', value: 'Marisol Vega' }], pages: ['Work order: coil sealed. Installed by Marisol Vega.'] },
    { n: 6, file: 'cy-2024.pdf', type: 'service-ticket', links: [uid('f', 'c', 3)], facts: [{ key: 'service_date', value: '2024-03-01' }, { key: 'technician', value: 'Marisol Vega' }], pages: ['Filter change. Replaced air filter.'] },
    { n: 7, file: 'cy-agreement.pdf', type: 'maintenance-agreement', links: [uid('f', 'c', 3)], pages: ['Agreement'] },
    { n: 8, file: 'gus-inv.pdf', type: 'invoice', links: [uid('f', 'c', 7)], facts: [{ key: 'service_date', value: '2026-08-15' }], pages: ['Invoice Gus Golf'] },
    { n: 9, file: 'ed-inv.pdf', type: 'invoice', links: [uid('f', 'c', 5)], facts: [{ key: 'service_date', value: '2026-07-01' }], pages: ['Invoice Ed Echo'] },
    { n: 10, file: 'bob-inv.pdf', type: 'invoice', links: [uid('f', 'c', 2)], facts: [{ key: 'service_date', value: '2026-08-20' }], pages: ['Invoice Bob Bravo'] },
    { n: 11, file: 'orphan.pdf', type: 'other' },
    { n: 12, file: 'fay-permit.pdf', type: 'permit', links: [uid('f', 'c', 6)], pages: ['Permit'] },
    { n: 13, file: 'ann-inv.pdf', type: 'invoice', links: [uid('f', 'c', 1)], facts: [{ key: 'service_date', value: '2026-09-01' }], pages: ['Invoice Ann Alpha'] },
    { n: 14, file: 'ann-quote.pdf', type: 'proposal-quote', links: [uid('f', 'c', 1)], pages: ['Quote Ann Alpha'] },
    { n: 15, file: 'vendor-po.pdf', type: 'purchase-order', pages: ['PO to a supplier'] },
  ],
};
await seedTenant('f', tenF, worldF);
{
  const fin = (docN, kind, dir, date, due, total, paid, balance, status, corrections = {}) => lite.query(
    `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, invoice_date, due_date, total, amount_paid, balance_due, status, corrections) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [tenF, uid('f', 'd', docN), kind, dir, date, due, total, paid, balance, status, JSON.stringify(corrections)]);
  await fin(8, 'invoice', 'receivable', '2026-08-15', '2026-09-14', 1000, 0, 1000, 'unpaid');
  await fin(9, 'invoice', 'receivable', '2026-07-01', '2026-07-31', 2500.5, 2500.5, 0, 'paid');
  await fin(10, 'invoice', 'receivable', '2026-08-20', '2026-10-01', 400, 100, 300, 'partial');
  await fin(13, 'invoice', 'receivable', '2026-09-01', '2026-09-15', 750, 0, 750, 'unpaid', { total: '800.00' }); // the reviewed total wins
  await fin(14, 'estimate', 'receivable', null, null, 5000, null, null, 'unknown');
  await fin(15, 'po', 'payable', '2026-09-02', null, 320, 0, 320, 'unpaid');
}
const qText = (t) => exam.questions.find((q) => q.text === t);
const ex2 = async (t, ctx = ctxF) => { const q = qText(t); if (!q) return { missing: t }; return runOracle(withTenant, ctx, q, { today: TODAY }); };
const val = async (t) => { const r = await ex2(t); return r.skip ? `SKIP:${r.why}` : r.ok ? r.expected : `ERR:${r.error ?? r.missing}`; };
{
  const of = async (entry) => oracleOf(ctxF, entry);
  const exF = async (entry) => (await of(entry)).expected;
  // ---- geography: the shapes the first oracle dropped (Mesa 18 vs 19, AZ 44 vs 45)
  eq('adjudicated geo: Mesa = 4 (comma and no-comma states, a Suite segment and ZIP+4 all count)', await exF(an('How many customers do we have in Mesa?', CUST({ filters: [F('city', 'Mesa')], answerValue: 4 }))), 4);
  eq('adjudicated geo: AZ = 7 and NV = 1 (a state with no zip, or no comma before it, still counts)', [await exF(an('How many customers in AZ?', CUST({ filters: [F('state', 'AZ')], answerValue: 7 }))), await exF(an('How many customers in NV?', CUST({ filters: [F('state', 'NV')], answerValue: 1 })))], [7, 1]);
  eq('adjudicated geo: the by-city breakdown loses no customer (its counts add up to all 8)', (await exF(an('Show me a breakdown of customers by city', CUST({ groupBy: 'city', answerValue: {} })))).map((x) => Number(x.split('|')[1])).reduce((a, b) => a + b, 0), 8);
  eq('adjudicated geo: by-state breakdown is AZ 7, NV 1', (await exF(an('breakdown of customers by state', CUST({ groupBy: 'state', answerValue: {} })))).sort(), ['AZ|7', 'NV|1']);
  eq('adjudicated geo: zip 85202 finds the ZIP+4 customer', await exF(an('How many customers in 85202?', CUST({ filters: [F('zip', '85202')], answerValue: 1 }))), 1);
  // ---- "no email" is a count of customers WITHOUT one (46 vs 29), never the whole customer list
  const noEmail = { id: 'h', text: 'how many customers have no email on file', category: 'live-misses-2026-09-22', expect: { route: 'analytics', entity: 'customers', conditionsOnly: ['email'] } };
  eq('adjudicated: "how many customers have no email on file" counts the customers without one (5 of 8), not all 8', await exF(noEmail), 5);
  eq('adjudicated: "which customers have a phone number on file" is the phone filter, not the whole list', (await exF({ ...noEmail, text: 'which customers have a phone number on file', expect: { route: 'analytics', entity: 'customers', conditionsOnly: ['phone'] } })).length, 6);
  check('adjudicated: a conditionsOnly entry that cannot be derived is dropped, never graded as an unfiltered count', classify({ ...noEmail, text: 'how many customers do we have in stock', expect: { route: 'analytics', entity: 'customers', conditionsOnly: ['brand'] } }) === null);
  // ---- customers vs units
  eq('adjudicated: "customers with a unit newer than 5 years" counts CUSTOMERS (3), not units (4)', await exF(an('How many customers have a unit newer than 5 years old?', { entity: 'equipment', filters: [F('installYear', 2021, 'gte')], answerValue: 4 })), 3);
  eq('adjudicated: "units newer than 5 years" still counts units (4)', await exF(an('How many units are newer than 5 years old?', { entity: 'equipment', filters: [F('installYear', 2021, 'gte')], answerValue: 4 })), 4);
  // ---- last service: a completed visit, never a future or agreement date; apt aware
  eq('adjudicated: last service = newest COMPLETED visit (2026-09-10); the 2027 scheduled visit and the 2028 agreement date are not "last service"', await exF(lk('When did we last service the unit at 10 Main St, Mesa, AZ 85201?', { route: 'lookup' }, 'history')), ['2026-09-10']);
  eq('adjudicated: visits for Cy Charlie = 2 distinct service dates (3 documents)', [await exF(lk('how many times have we been to Charlie\'s', { route: 'retrieval' }, 'live-misses-2026-09-22')), (await of(lk('how many times have we been to Charlie\'s', { route: 'retrieval' }, 'live-misses-2026-09-22'))).rows.length], [2, 1]);
  {
    const q = (await of(lk("how many times have we been to Charlie's", { route: 'retrieval' }, 'live-misses-2026-09-22'))).question;
    const r = await runOracle(withTenant, ctxF, q, { today: TODAY });
    check('adjudicated: the visit count also accepts "3 service documents" - but only if the answer says documents', r.alts?.some((a) => a.expected === 3 && /documents/.test(a.says)), JSON.stringify(r.alts));
    check('adjudicated: visit count grading - "2 visits" passes; "3 documents" passes; a bare "3 visits" fails',
      compareAnswer({ cmp: 'number', expected: r.expected, alts: r.alts, question: q.text, citationRequired: false }, { kind: 'answer', text: '2 visits to Cy Charlie on file.', facts: [], sources: [] }).passed
      && compareAnswer({ cmp: 'number', expected: r.expected, alts: r.alts, question: q.text, citationRequired: false }, { kind: 'answer', text: '3 service documents for Cy Charlie.', facts: [], sources: [] }).passed
      && !compareAnswer({ cmp: 'number', expected: r.expected, alts: r.alts, question: q.text, citationRequired: false }, { kind: 'answer', text: '3 visits to Cy Charlie.', facts: [], sources: [] }).passed);
  }
  // ---- technician breakdown is a deterministic set of "tech|jobs"
  eq('adjudicated: "breakdown by technician" is a SET of tech|jobs (Danny 2, Marisol 3), not a model-graded rubric', (await exF(an('Show me a breakdown by technician', { entity: 'serviceVisits' }, 'technician'))).sort(), ['Danny Ochoa|2', 'Marisol Vega|3']);
  // ---- added vs serviced: both readings, the second only when stated
  {
    const r = await of(an('How many documents have we added year to date?', { entity: 'documents', timeRange: {} }, 'time'));
    const rr = await runOracle(withTenant, ctxF, r.question, { today: TODAY });
    check('adjudicated: "added year to date" = upload date (all 15 seeded today or earlier this year is data-dependent) and offers the work-date reading only if stated', typeof rr.expected === 'number' && rr.alts?.length === 1 && /service|work/.test(rr.alts[0].says), JSON.stringify(rr));
  }
  // ---- ambiguous surname: an answer about ONE customer is right if it names which
  {
    const q = (await of(lk('List invoices for Alpha', { route: 'lookup' }))).question;
    const r = await runOracle(withTenant, ctxF, q, { today: TODAY });
    check('adjudicated: "invoices for Alpha" (two Ann Alphas) = 1 in total, each customer\'s own count accepted when the answer names her', r.expected === 1 && r.alts?.length === 2 && r.alts.every((a) => /ann alpha/.test(a.says)), JSON.stringify(r));
  }
  // ---- installer: only what a document's own text says
  eq('adjudicated: "who installed" reads the document text ("Installed by Marisol Vega"); nothing else counts', await exF(lk('Who installed the unit at 30 Elm Rd, Suite 110?', { route: 'lookup' }, 'history')), ['Marisol Vega']);
  eq('adjudicated: a unit with no installer in any document has an EMPTY expectation (Donovan must not invent one)', await exF(lk('Who installed the unit at 70 Palm Way?', { route: 'lookup' }, 'history')), []);
  // ---- apt-aware address: "Suite 110" is part of the subject
  eq('adjudicated: an address with a Suite/Apt selects that unit only', await exF(lk('What is the serial of the unit at 30 Elm Rd, Suite 110?', { route: 'lookup' })), []);
  // ---- comparisons: "more X or more Y" is a rubric over the two counts
  const more = classify({ id: 'h', text: 'Do we have more invoices or more service tickets on file?', category: 'comparisons', expect: { route: 'analytics', entity: 'documents', groupBy: 'documentType' } });
  check('adjudicated: "more invoices or more service tickets" compares the two types (rubric with both counts), not a 15-type list', more?.cmp === 'rubric' && more.params.flat().includes('invoice') && more.params.flat().includes('service-ticket'), JSON.stringify(more)?.slice(0, 200));
  // ---- overdue maintenance: customers whose last completed visit is over a year old
  const od = await of(an('Which customers are overdue for maintenance?', { entity: 'customers', unsupported: true, conditionsOnly: ['maintenance'] }, 'live-misses-2026-09-21'));
  check('adjudicated: "overdue for maintenance" = last completed visit more than 12 months ago (Cy Charlie: 2025-01-05), never someone with a recent visit', od.spec.cmp === 'rubric' && od.expected.some((r) => /Cy Charlie \| last service 2025-01-05/.test(r)) && !od.expected.some((r) => /Ann Alpha/.test(r)), JSON.stringify(od.expected));
}

/* ---- the breadth questions, hand-computed on the seeded shop */
{
  // TEAM F: unpaid/paid/overdue/partial are now cmp "count-with-unknown" ({known, unknown} - see
  // compare.js's compareCountWithUnknown); this fixture's 4 invoices all print an explicit status, so
  // unknown = 0 for every one of them (the "some unknown" path is covered by the pure unit test below).
  const known = (v) => v?.known;
  eq('breadth financials: invoices on file = 4, unpaid/open = 3, paid = 1, partial = 1', [await val('How many invoices do we have on file?'), known(await val('How many invoices are still unpaid?')), known(await val('How many invoices have been paid?')), known(await val('How many invoices are partially paid?'))], [4, 3, 1, 1]);
  eq('breadth financials: unpaid/paid/partial have no unknowns in this fixture (every invoice prints a status)', [await val('How many invoices are still unpaid?'), await val('How many invoices have been paid?'), await val('How many invoices are partially paid?')].map((v) => v.unknown), [0, 0, 0]);
  eq('breadth financials: overdue = 2 (due 09-14 and 09-15 vs today 09-23); more than 60 days = 0', [known(await val('How many invoices are overdue?')), known(await val('How many invoices are more than 60 days overdue?'))], [2, 0]);
  eq('breadth financials: total owed = 2050 (1000 + 300 partial balance + 750)', await val('How much are we owed in total?'), 2050);
  eq('breadth financials: invoiced total = 4700.50 (the reviewed 800.00 correction beats the extracted 750)', Number(await val('How much have we invoiced in total?')), 4700.5);
  eq('breadth financials: last month (August) = 1400, this month = 800, this year = 4700.50', [Number(await val('How much did we invoice last month?')), Number(await val('How much did we invoice this month?')), Number(await val('How much did we invoice this year?'))], [1400, 800, 4700.5]);
  eq('breadth financials: collected = 2600.50, average invoice = 1175.125, largest = 2500.50, smallest = 400', [Number(await val('How much have we collected in total?')), Number(await val("What's our average invoice amount?")), Number(await val("What's the biggest invoice we've ever sent?")), Number(await val("What's our smallest invoice?"))], [2600.5, 1175.125, 2500.5, 400]);
  eq('breadth financials: AR aging - past due 1750, over 30 days 0', [Number(await val('How much is past due?')), Number(await val("What's our AR aging: how much is more than 30 days past due?"))], [1750, 0]);
  eq('breadth financials: biggest customer by revenue = Ed Echo; owes the most = Gus Golf', [await val("Who's our biggest customer by revenue?"), await val('Which customer owes us the most right now?')], [['Ed Echo'], ['Gus Golf']]);
  eq('breadth financials: customers with unpaid invoices', (await val('Which customers have unpaid invoices?')).sort(), ['Ann Alpha', 'Bob Bravo', 'Gus Golf']);
  eq('breadth financials: quotes = 1 worth 5000; purchase orders = 1 worth 320; owed to vendors = 320', [await val('How many quotes or estimates do we have on file?'), Number(await val("What's the total value of our quotes?")), await val('How many purchase orders do we have?'), Number(await val('How much do we owe vendors right now?'))], [1, 5000, 1, 320]);
  eq('breadth financials: per-customer money ("Golf" owes 1000; invoiced Golf 1000)', [Number(await val('How much does Mercer owe us?')), await val('How much does Mercer owe us?')].slice(1), ['SKIP:subject or data not in this shop\'s records']);
  eq('breadth financials: invoices with no due date / missing a total = 0', [await val('How many invoices have no due date?'), await val('How many invoices are missing a total?')], [0, 0]);
  eq('breadth existence: any overdue invoices = yes; any unpaid = yes', [await val('Do we have any overdue invoices?'), await val('Are there any unpaid invoices?')], [true, true]);
  eq('breadth trends: last-quarter vs prior-quarter service calls (both zero) = not more', await val('Did we do more service calls last quarter than the quarter before?'), false);
  eq('breadth trends: invoiced more last month (1400) than the month before (July: 2500.50)? no', await val('Did we invoice more last month than the month before?'), false);
  // content: text-only facts
  eq('breadth content: which customers had a capacitor issue = Ann Alpha; refrigerant = Cy Charlie; leak = Cy Charlie', [await val('Which customers had a capacitor issue or repair on file?'), await val('Which customers had a refrigerant issue or repair on file?'), await val('Which customers had a leak issue or repair on file?')], [['Ann Alpha'], ['Cy Charlie'], ['Cy Charlie']]);
  eq('breadth content: jobs mentioning a filter = 1; the air filter was replaced for Cy Charlie', [await val('How many jobs mention a filter?'), await val('Which customers had the air filter replaced?')], [1, ['Cy Charlie']]);
  eq('breadth semantic: "the unit is loud" finds the noise complaint (Ann Alpha), and a leak paraphrase finds the coil leak (Cy Charlie)', [await val('Which customers complained the unit is loud?'), await val('Who called about a leak?')], [['Ann Alpha'], ['Cy Charlie']]);
  eq('breadth content: nothing on file mentions a compressor replacement (an honest zero to hold Donovan to)', await val('How many jobs mention a compressor replacement?'), 0);
  // multi-hop
  eq('breadth multi-hop: Trane older than 10 years with no agreement = Gus Golf', await val('Which customers have a Trane unit older than 10 years and no maintenance agreement?'), ['Gus Golf']);
  eq('breadth multi-hop: customers with more than one unit = 3 (Ann, Bob, Gus)', await val('How many customers have more than one unit?'), 3);
  eq('breadth multi-hop: Mesa customers with no maintenance agreement = 2 (Fay and the second Ann; Ann #1 and Cy have one)', await val('How many customers in Mesa have no maintenance agreement?'), 2);
  // rankings
  eq('breadth rankings: most units = Ann Alpha (3); most common brand = trane; city with the most customers = Mesa', [await val('Which customer has the most units?'), await val("What's our most common brand?"), await val('Which city has the most customers?')], [['Ann Alpha'], ['trane'], ['Mesa']]);
  eq('breadth rankings: document type with the most documents = invoice and service-ticket (tied at 4)', (await val('Which document type do we have the most of?')).sort(), ['invoice', 'service-ticket']);
  // tech
  eq('breadth tech: Danny 2 jobs, Marisol 3; Marisol worked for 1 customer; busiest this year = Danny', [await val('How many jobs has Danny Ochoa done in total?'), await val('How many jobs has Marisol Vega done in total?'), await val('How many different customers has Marisol Vega worked for?'), await val('Who\'s our busiest technician this year?')], [2, 3, 1, ['Danny Ochoa']]);
  eq('breadth tech: a technician the shop does not have is skipped, not failed', await val('How many jobs has Wyatt Coburn done in total?'), "SKIP:subject or data not in this shop's records");
  eq('breadth tech: Danny\'s most recent COMPLETED job is 2026-09-10 (the 2027 visit is scheduled)', await val("When was Danny Ochoa's most recent job?"), ['2026-09-10']);
  // data quality
  eq('breadth data-quality: 2 documents not linked to a customer; 2 customers with no documents; 2 units missing a serial', [await val("How many documents aren't linked to any customer?"), await val('How many customers have no documents on file?'), await val('How many units are missing a serial number?')], [2, 2, 2]);
  eq('breadth data-quality: duplicate customers exist (Ann Alpha twice); one address is missing a zip', [await val('Do we have any duplicate customers?'), await val('How many customer addresses are missing a zip code?')], [true, 1]);
  // existence
  eq('breadth existence: Mitsubishi = no; Las Vegas customers = yes; Chandler = no; permits on file = yes', [await val('Do we have any Mitsubishi units?'), await val('Do we have any customers in Las Vegas?'), await val('Do we have any customers in Chandler?'), await val('Do we have any permits on file?')], [false, true, false, true]);
  // explain: subjects the shop does not have are skipped
  eq('breadth explain: a why-question about a customer the shop does not have is skipped', await val('Why is the Mercer unit flagged for a warranty alert?'), "SKIP:subject or data not in this shop's records");
  // persona
  eq('breadth persona: 2 Trane customers... in Mesa = 1 (Ann); how many customers = 8; units tracked = 9', [await val('Of our Trane customers, how many are in Mesa?'), await val('How many customers do we have in total?'), await val('How many units are we tracking?')], [1, 8, 9]);
  // retirement: with the financials tables absent every money question is SKIPPED (never failed); rows absent -> skipped too
  await lite.exec('ALTER TABLE document_financial_lines RENAME TO hidden_dfl2; ALTER TABLE document_financials RENAME TO hidden_df2');
  const finQs = exam.questions.filter((q) => /document_financials/.test(q.oracle.sql));
  const retired = [];
  for (const q of finQs) { const r = await runOracle(withTenant, ctxF, q, { today: TODAY }); if (!(r.ok && r.skip)) retired.push(`${q.id}:${r.error ?? 'not skipped'}`); }
  eq(`retire: all ${finQs.length} financials questions are skipped gracefully (not failed) while the table is absent`, retired.slice(0, 4), []);
  await lite.exec('ALTER TABLE hidden_df2 RENAME TO document_financials; ALTER TABLE hidden_dfl2 RENAME TO document_financial_lines');
  const emptyShop = await runOracle(withTenant, ctxB, qText('How many invoices do we have on file?'), { today: TODAY });
  check('retire: a shop with the table but NO invoice rows skips the money questions (nothing to grade)', emptyShop.skip === true, JSON.stringify(emptyShop).slice(0, 160));
  const tooLong = await runOracle(withTenant, ctxF, { ...qText('Which customers had a leak issue or repair on file?'), maxItems: 0 }, { today: TODAY });
  check('retire: a set longer than maxItems is skipped ("too long to grade"), not failed', tooLong.skip === true && /too long/.test(tooLong.why), JSON.stringify(tooLong).slice(0, 160));
  // EVERY shipped question executes on this shop and on tenant A with no SQL error
  for (const [label, ctx] of [['seeded shop F', ctxF], ['tenant A', ctxA]]) {
    const errs = []; let ran = 0; let skipped = 0;
    for (const q of exam.questions) { const r = await runOracle(withTenant, ctx, q, { today: TODAY }); if (!r.ok) errs.push(`${q.id}: ${r.error}`); else if (r.skip) skipped++; else ran++; }
    eq(`all ${exam.questions.length} shipped oracles (incl. breadth) execute without a SQL error on ${label} (${ran} ran, ${skipped} skipped)`, errs.slice(0, 5), []);
  }
}

/* ================================================================== 4. runner */
await lite.query(`DELETE FROM ask_misses`).catch(() => {});
const exQ = async (entry, id) => { const r = await oracleOf(ctxA, entry); return { id, text: entry.text, category: entry.category, cmp: r.spec.cmp, ...(r.spec.rubric ? { rubric: r.spec.rubric } : {}), oracle: { sql: r.spec.sql, params: r.spec.params, ...(r.spec.requires ? { requires: r.spec.requires } : {}) } }; };
const qMesa = await exQ(an('How many customers do we have in Mesa?', CUST({ filters: [F('city', 'Mesa')], answerValue: 2 }), 'counts-geo'), 'q-mesa');
const qTrane = await exQ(an('How many Trane units do we have?', { entity: 'equipment', filters: [F('brand', 'Trane')], answerValue: 2 }, 'counts-brand'), 'q-trane');
const qGil = await exQ(an('Which customers have an expired warranty in Gilbert?', CUST({ filters: [F('city', 'Gilbert'), F('warrantyStatus', 'expired')], answerValue: 1 }), 'two-condition'), 'q-gilbert');
const qMoney = await exQ(an('How much revenue came in last month?', { entity: 'documents', unsupported: true, note: 'financials layer' }, 'money'), 'q-money');
const qGhost = await exQ(lk("What's the phone number on file for Linda Fitzgerald?"), 'q-ghost');
const qHist = await exQ(lk('What do we have on file for Karen Abernathy?', { route: 'retrieval' }, 'history'), 'q-hist');
const qPhone = await exQ(lk("What's the phone number on file for Karen Abernathy?"), 'q-phone');

let tuCounter = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${++tuCounter}`, name, input });
const lastToolResult = (messages) => {
  const last = messages[messages.length - 1];
  const block = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : null;
  return block ? { text: block.content, isError: Boolean(block.is_error) } : null;
};
function scripted(turns, usageObj = { input_tokens: 1200, output_tokens: 120 }) {
  let i = 0;
  const calls = [];
  const fn = async (req) => {
    calls.push({ model: req.model, temperature: req.temperature, tools: req.tools.map((t) => t.name), tool_choice: req.tool_choice, system: req.system, messages: req.messages, lastResult: lastToolResult(req.messages) });
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    const out = typeof turn === 'function' ? turn(req.messages, req) : turn;
    return { content: Array.isArray(out) ? out : out.content, usage: out.usage ?? usageObj, stop_reason: 'tool_use' };
  };
  fn.calls = calls;
  return fn;
}

// A fake /api/ask handler: answers by question text, meters model spend like the real one.
function fakeHandler(script, { tokens = 0, model = 'claude-haiku-4-5', agentModelByQuestion = {}, delayMs = 0 } = {}) {
  const seen = [];
  const handler = async (req, res) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); // TEAM F: simulate model/DB latency for concurrency tests
    const call = req[SCORECARD_CALL];
    const question = req.body.question;
    seen.push({ question, escalate: call?.escalate === true, hasHook: Boolean(call), auth: call?.auth });
    if (tokens) await usage.recordModelCall(ctxA, { inputTokens: tokens, outputTokens: 0, model: call?.escalate ? 'claude-sonnet-4-5' : model });
    const a = typeof script === 'function' ? script(question, call) : script[question];
    const data = a ?? { kind: 'no-answer', text: 'I could not find that.', facts: [], sources: [] };
    const m = agentModelByQuestion[question];
    return res.status(200).json({ success: true, data: { ...data, debug: { model: call?.escalate ? 'claude-sonnet-4-5' : m ?? model, models: [call?.escalate ? 'claude-sonnet-4-5' : m ?? model] } } });
  };
  handler.seen = seen;
  return handler;
}
const SRC = [{ documentId: 'doc-1', location: {} }]; // an answer that carries a citation
const ANSWERS = {
  [qMesa.text]: { kind: 'answer', text: 'You have 2 customers in Mesa.', facts: [], sources: SRC },
  [qTrane.text]: { kind: 'answer', text: 'You have 5 Trane units.', facts: [], sources: [] }, // wrong (2)
  [qGil.text]: { kind: 'answer', text: 'One customer.', facts: [{ label: 'Plaza Dental Group', value: 'Gilbert', sources: SRC }], sources: [] },
  [qMoney.text]: { kind: 'answer', text: 'You invoiced $12,400 last month.', facts: [{ label: 'Revenue', value: '$12,400' }], sources: [] }, // fabricated
  [qHist.text]: { kind: 'answer', text: 'Karen has a service ticket from 2026-09-10 and a maintenance agreement.', facts: [], sources: SRC },
  [qPhone.text]: { kind: 'answer', text: 'Karen Abernathy: (480) 555-0148', facts: [], sources: SRC },
};
const graderModel = (pass) => async () => ({ content: [tu('grade', { pass, reason: pass ? 'consistent' : 'contradicts' })], usage: { input_tokens: 500, output_tokens: 30 } });

{
  store.resetScorecardStoreForTests();
  const handler = fakeHandler(ANSWERS);
  const questions = [qMesa, qTrane, qGil, qMoney, qGhost, qHist, qPhone];
  // No financials tables for this run: the money question must still be an active honest-zero (it retires once they exist).
  await lite.exec('ALTER TABLE document_financial_lines RENAME TO hidden_dfl; ALTER TABLE document_financials RENAME TO hidden_df');
  const out = await runScorecard({ ctx: ctxA, questions, handler, pageSize: 12, today: TODAY, callModel: graderModel(true), examVersion: 'test-1' });
  await lite.exec('ALTER TABLE hidden_df RENAME TO document_financials; ALTER TABLE hidden_dfl RENAME TO document_financial_lines');
  const byId = Object.fromEntries(out.pageResults.map((r) => [r.questionId, r]));
  eq('runner: correct number / set / value / rubric answers pass; a wrong number and a fabricated money answer fail',
    ['q-mesa', 'q-trane', 'q-gilbert', 'q-money', 'q-hist', 'q-phone'].map((k) => byId[k].passed), [true, false, true, false, true, true]);
  check('runner: a question about a customer the shop does not have is skipped (not asked, not scored)', byId['q-ghost'].skipped === true && !handler.seen.some((s) => /Fitzgerald/.test(s.question)));
  eq('runner: score = passed / graded (4 of 6), skipped excluded', [out.run.answered, out.run.passed, out.run.score], [6, 4, 0.6667]);
  eq('runner: by-category breakdown is stored', [out.run.byCategory['counts-brand'].score, out.run.byCategory['counts-geo'].score], [0, 1]);
  check('runner: the wrong answer records expected vs got for the failing list', byId['q-trane'].expected === '2' && /5 Trane/.test(byId['q-trane'].got), JSON.stringify(byId['q-trane']));
  check('runner: every ask went through the in-process hook with the operator tenant\'s auth', handler.seen.every((s) => s.hasHook && s.auth.tenantId === ctxA.tenantKey));
  await new Promise((r) => setTimeout(r, 300));
  const misses = await lite.query(`SELECT question_normalized FROM ask_misses WHERE outcome = 'scorecard-fail' ORDER BY 1`);
  check('runner: failures feed the learning loop as ask_misses (outcome scorecard-fail), passes do not', misses.rows.length === 2, JSON.stringify(misses.rows));
  check('runner: the run finished and was stored in the tables (migration 30 present)', out.done && out.backend === 'tables' && out.run.status === 'complete', JSON.stringify({ d: out.done, b: out.backend, s: out.run?.status }));

  // retry on the escalation model: an agent-answered failure is retried once with escalate:true; the SCORE stays the first attempt
  const retryH = fakeHandler((q, call) => (q === qTrane.text ? (call?.escalate ? { kind: 'answer', text: 'You have 2 Trane units.', facts: [], sources: SRC } : ANSWERS[q]) : ANSWERS[q]));
  const rr = await runScorecard({ ctx: ctxA, questions: [qTrane], handler: retryH, today: TODAY });
  const r0 = rr.pageResults[0];
  check('runner: a failed answer is retried ONCE with escalate:true; the score is the first attempt, the retry is recorded', retryH.seen.length === 2 && retryH.seen[1].escalate === true && r0.passed === false && r0.detail.retry?.passed === true && /sonnet/.test(r0.detail.retry.model), JSON.stringify(r0.detail));
  const noRetry = fakeHandler(ANSWERS);
  await runScorecard({ ctx: ctxA, questions: [qTrane], handler: noRetry, today: TODAY, retryFailures: false });
  eq('runner: retryFailures:false asks once', noRetry.seen.length, 1);
  // CITATION scoring end to end: a right-but-uncited answer FAILS (and is not retried on Sonnet: more tokens will not add a source)
  const uncitedH = fakeHandler({ [qMesa.text]: { kind: 'answer', text: 'You have 2 customers in Mesa.', facts: [], sources: [] }, [qPhone.text]: ANSWERS[qPhone.text] });
  const uc = await runScorecard({ ctx: ctxA, questions: [qMesa, qPhone], handler: uncitedH, today: TODAY, feedMisses: false });
  const ucMesa = uc.pageResults.find((r) => r.questionId === 'q-mesa');
  check('runner: a right value with NO citation fails; the result records valueOk / cited / citationRequired', ucMesa.passed === false && ucMesa.valueOk === true && ucMesa.cited === false && ucMesa.citationRequired === true && /citation/.test(ucMesa.detail.why), JSON.stringify(ucMesa));
  eq('runner: an uncited failure is not retried on the escalation model (only wrong VALUES are)', uncitedH.seen.filter((x) => x.question === qMesa.text).length, 1);
  const ucScore = scoreResults(uc.pageResults);
  eq('runner: the run reports pass score, value-only score and citation coverage separately', [ucScore.score, ucScore.valueScore, ucScore.citation.coverage], [0.5, 1, 0.5]);
  const ucStored = await store.getRun(ctxA, uc.runId);
  check('runner: citation fields survive persistence (tables backend)', ucStored.results.find((r) => r.questionId === 'q-mesa')?.valueOk === true && ucStored.results.find((r) => r.questionId === 'q-mesa')?.cited === false && ucStored.results.find((r) => r.questionId === 'q-phone')?.cited === true, JSON.stringify(ucStored.results.map((r) => [r.questionId, r.valueOk, r.cited])));
  // a rubric answer is also held to the citation rule; the grader is told what must be cited
  const rq = { id: 'q-rub', text: 'What was found or done on the Mercer job?', category: 'content', cmp: 'rubric', rubric: 'Reports the findings.', citeWhat: 'the service ticket', oracle: { sql: "SELECT 'Replaced capacitor' AS ref", params: [] } };
  const seenRubric = [];
  const rubricModel = async (req) => { seenRubric.push(req.messages[0].content[0].text); return { content: [tu('grade', { pass: true, reason: 'ok' })], usage: { input_tokens: 10, output_tokens: 5 } }; };
  const rubUncited = await runScorecard({ ctx: ctxA, questions: [rq], handler: fakeHandler({ [rq.text]: { kind: 'answer', text: 'They replaced the capacitor.', facts: [], sources: [] } }), today: TODAY, callModel: rubricModel, feedMisses: false, retryFailures: false });
  const rubCited = await runScorecard({ ctx: ctxA, questions: [rq], handler: fakeHandler({ [rq.text]: { kind: 'answer', text: 'They replaced the capacitor.', facts: [], sources: SRC } }), today: TODAY, callModel: rubricModel, feedMisses: false, retryFailures: false });
  check('runner: a rubric answer the grader likes still fails without a citation, and passes with one', rubUncited.pageResults[0].passed === false && rubUncited.pageResults[0].valueOk === true && rubCited.pageResults[0].passed === true, JSON.stringify([rubUncited.pageResults[0].detail, rubCited.pageResults[0].passed]));
  check('runner: the rubric grader is told what must be cited', /must cite the service ticket/.test(seenRubric[0]) && /citations attached to the answer: 0/.test(seenRubric[0]), seenRubric[0]);

  // TEAM K (2026-09-25, R5_FAILS.md "maintenance-due 1/5 ... invents customer names"): the grader
  // must see the answer's OWN citation records (not just the truncated oracle REFERENCE sample), so
  // it stops mistaking "name absent from a capped reference" for "invented".
  const mdq = {
    id: 'q-maint-due', category: 'maintenance-due', cmp: 'rubric',
    text: "Who's due for fall maintenance?",
    rubric: 'Names customers overdue or coming due, each backed by a citation.',
    oracle: { sql: "SELECT 'Betty Winslow | last service 2024-01-01' AS ref", params: [] },
  };
  const seenMaint = [];
  const maintModel = async (req) => { seenMaint.push(req.messages[0].content[0].text); return { content: [tu('grade', { pass: true, reason: 'ok' })], usage: { input_tokens: 10, output_tokens: 5 } }; };
  const maintAnswer = {
    kind: 'answer', text: 'Betty Winslow and Carol Rios are due for fall maintenance.', facts: [], sources: [],
    records: [
      { type: 'customer', id: 'c1', label: 'Betty Winslow', sublabel: 'last maintenance visit Jan 2024' },
      { type: 'customer', id: 'c2', label: 'Carol Rios', sublabel: 'last maintenance visit Jun 2024, agreement due sooner' },
    ], recordsTotal: 2, recordsKind: 'basis', basis: 'test',
  };
  await runScorecard({ ctx: ctxA, questions: [mdq], handler: fakeHandler({ [mdq.text]: maintAnswer }), today: TODAY, callModel: maintModel, feedMisses: false, retryFailures: false });
  check('runner: the grader sees the answer\'s own citation records, including a name absent from the (truncated) oracle reference',
    /RECORDS THE ANSWER CITES/.test(seenMaint[0]) && /Carol Rios/.test(seenMaint[0]) && /Betty Winslow/.test(seenMaint[0]), seenMaint[0]);
}
{
  // budget stop: each ask costs $1.00 (1,000,000 Haiku input tokens at $1/MTok). TEAM F (speed): questions
  // now run QUESTION_CONCURRENCY (2) at a time, so the budget is checked once per PAIR, not per question -
  // a $2.50 budget lets 2 pairs (4 questions, $4) start before the 3rd pair's pre-check (spent=4 >= 2.5) stops it.
  const questions = Array.from({ length: 8 }, (_, i) => ({ ...qMesa, id: `b-${i}` }));
  const h = fakeHandler(ANSWERS, { tokens: 1_000_000 });
  const out = await runScorecard({ ctx: ctxA, questions, handler: h, budgetUsd: 2.5, pageSize: 12, today: TODAY, retryFailures: false });
  check('budget stop: the run stops once spend reaches the budget, is marked stopped/budget, and scores what was answered', out.stopped === 'budget' && out.pageResults.length === 4 && out.run.status === 'stopped' && out.run.stopReason === 'budget' && out.done === true, JSON.stringify({ s: out.stopped, n: out.pageResults.length, run: out.run?.status }));
  check('budget stop: cost is the TRUE per-question spend from the usage meter (~$1 each)', Math.abs(out.spentUsd - 4) < 0.01 && Math.abs(out.pageResults[0].costUsd - 1) < 0.001, `${out.spentUsd} ${out.pageResults[0].costUsd}`);
  eq('budget default: env DONOVAN_SCORECARD_BUDGET_USD, else $5', [(await import('../api/_lib/scorecard/runner.js')).scorecardBudgetUsd({}), (await import('../api/_lib/scorecard/runner.js')).scorecardBudgetUsd({ DONOVAN_SCORECARD_BUDGET_USD: '1.5' })], [5, 1.5]);
}
{
  // TEAM F (speed): 4 questions run 2-at-a-time (QUESTION_CONCURRENCY) finish in ~2 batches of wall-clock
  // time, not 4 sequential ones - proven with an artificial per-ask delay, same shape as the agent's own
  // tool-concurrency test in verify-agent.mjs.
  const { QUESTION_CONCURRENCY } = await import('../api/_lib/scorecard/runner.js');
  const questions = Array.from({ length: 4 }, (_, i) => ({ ...qMesa, id: `c-${i}` }));
  const delayMs = 120;
  const h = fakeHandler(ANSWERS, { delayMs });
  const started = Date.now();
  const out = await runScorecard({ ctx: ctxA, questions, handler: h, pageSize: 4, today: TODAY, retryFailures: false });
  const elapsed = Date.now() - started;
  check(`runner concurrency: 4 questions at QUESTION_CONCURRENCY=${QUESTION_CONCURRENCY} take well under 4x the per-question delay`,
    elapsed < delayMs * 3.5, `elapsed=${elapsed}ms delay=${delayMs}ms (4 sequential would be >= ${delayMs * 4}ms)`);
  eq('runner concurrency: all 4 still graded, in question order', out.pageResults.map((r) => r.questionId), questions.map((q) => q.id));
}
{
  // paging: 5 questions, 2 per invocation (3 pages), one run, offset cursor, skipped ones do not stall it
  const questions = [qMesa, qGhost, { ...qMesa, id: 'p-2' }, { ...qMesa, id: 'p-3' }, { ...qMesa, id: 'p-4' }];
  const h = fakeHandler(ANSWERS);
  let runId; let offset = 0; const pages = []; let last;
  for (let guard = 0; guard < 6; guard++) {
    last = await runScorecard({ ctx: ctxA, questions, handler: h, runId, offset, pageSize: 2, today: TODAY, retryFailures: false });
    runId = last.runId; pages.push(last.pageResults.length);
    if (last.done) break;
    offset = last.nextOffset;
  }
  eq('paging: 5 questions at 2 per invocation take 3 pages and one run; the skipped question does not loop', [pages, offset, last.done, last.run.answered, last.run.totalQuestions], [[2, 2, 1], 4, true, 4, 5]);
  const detail = await store.getRun(ctxA, runId);
  eq('paging: the stored run holds every page\'s results (4 graded)', detail.results.length, 4);
  // deadline: a page never starts a question it cannot finish
  const dl = await runScorecard({ ctx: ctxA, questions, handler: h, pageSize: 6, deadlineAt: Date.now() + 500, today: TODAY });
  check('paging: a page stops before a question when the request deadline is near (60 s limit)', dl.stopped === 'deadline' && dl.nextOffset === 0 && dl.pageResults.length === 0, JSON.stringify({ s: dl.stopped, n: dl.nextOffset }));
  const day1 = nightlySlice(exam.questions, '2026-09-23'); const day2 = nightlySlice(exam.questions, '2026-09-24');
  check('nightly slice: 40 questions, deterministic per day, a different window the next day, wraps around', day1.length === NIGHTLY_SLICE && JSON.stringify(day1) === JSON.stringify(nightlySlice(exam.questions, '2026-09-23')) && day1[0].id !== day2[0].id && nightlySlice(exam.questions, '2026-09-23', exam.questions.length + 5).length === exam.questions.length);
  const covered = new Set(); for (let d = 0; d < Math.ceil(exam.questions.length / NIGHTLY_SLICE) + 1; d++) for (const q of nightlySlice(exam.questions, `2026-10-${String(1 + d).padStart(2, '0')}`)) covered.add(q.id);
  check('nightly slice: consecutive days rotate through the whole exam', covered.size === exam.questions.length, `${covered.size}/${exam.questions.length}`);
}
{
  // persistence: with migration 30 (tables) - already exercised above. Now WITHOUT it: drop the two tables in this throwaway DB.
  await lite.exec('DROP TABLE donovan_scorecard_results; DROP TABLE donovan_scorecard_runs;');
  store.resetScorecardStoreForTests();
  const h = fakeHandler(ANSWERS);
  const out = await runScorecard({ ctx: ctxA, questions: [qMesa, qTrane], handler: h, pageSize: 5, today: TODAY, retryFailures: false, examVersion: 'test-2' });
  check('no migration 30: the run still works and falls back to audit_log', out.backend === 'audit' && out.run.answered === 2 && out.run.passed === 1 && out.done, JSON.stringify({ b: out.backend, r: out.run }));
  const got = await store.getRun(ctxA, out.runId);
  check('no migration 30: getRun reads the run and its per-question results back from audit_log', got?.backend === 'audit' && got.results.length === 2 && got.results[0].passed === false, JSON.stringify(got)?.slice(0, 200));
  const runs = await store.listRuns(ctxA, { limit: 5 });
  check('no migration 30: listRuns returns it (the trend needs no table)', runs.runs.some((r) => r.id === out.runId && r.score === 0.5), JSON.stringify(runs.runs.map((r) => r.id)));
  // paging continues across invocations with the audit backend too
  const p1 = await runScorecard({ ctx: ctxA, questions: [qMesa, { ...qMesa, id: 'a-1' }, { ...qMesa, id: 'a-2' }], handler: h, pageSize: 2, today: TODAY });
  const p2 = await runScorecard({ ctx: ctxA, questions: [qMesa, { ...qMesa, id: 'a-1' }, { ...qMesa, id: 'a-2' }], handler: h, runId: p1.runId, offset: p1.nextOffset, pageSize: 2, today: TODAY });
  eq('no migration 30: a paged run accumulates across invocations', [p1.backend, p2.run.answered, p2.run.passed, p2.done], ['audit', 3, 3, true]);
  const auditRows = (await lite.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'donovan.scorecard%'`)).rows[0].n;
  check('no migration 30: only compact summaries are written to audit_log', auditRows > 0);
  // status action: latest run, trend vs previous, failing list, exam shape
  const st = await routes.scorecardStatusAction(ctxA, {});
  check('scorecardStatus: returns the latest run, exam shape, budget and a failing list with expected/got', st.exam.questions === exam.questions.length && st.run && Array.isArray(st.failing) && st.budgetUsd === 5 && st.backend === 'audit', JSON.stringify({ e: st.exam.questions, r: st.run?.id, b: st.backend }));
  const fail = st.failing[0];
  check('scorecardStatus: a failing entry carries question, expected and got', !fail || (fail.question && fail.expected !== undefined && fail.got !== undefined), JSON.stringify(fail));
}
{
  // restore the tables (migration 30) and prove the trend against a previous run
  await lite.exec(fs.readFileSync(path.join(cfgDir, '30-donovan-scorecard.sql'), 'utf8'));
  await lite.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON donovan_scorecard_runs, donovan_scorecard_results TO deepwell_rls`);
  store.resetScorecardStoreForTests();
  const many = Array.from({ length: 24 }, (_, i) => ({ ...qMesa, id: `t-${i}` }));
  const h1 = fakeHandler(ANSWERS);
  await runScorecard({ ctx: ctxA, questions: many, handler: h1, pageSize: 12, today: TODAY, retryFailures: false, feedMisses: false });
  let cursor = 12; let rid;
  const first = await runScorecard({ ctx: ctxA, questions: many, handler: h1, pageSize: 12, offset: 0, today: TODAY, retryFailures: false, feedMisses: false });
  rid = first.runId;
  await runScorecard({ ctx: ctxA, questions: many, handler: h1, runId: rid, offset: cursor, pageSize: 12, today: TODAY, retryFailures: false, feedMisses: false });
  await new Promise((r) => setTimeout(r, 30));
  const worse = fakeHandler((q) => (q === qMesa.text ? { kind: 'answer', text: 'You have 9 customers.', facts: [], sources: SRC } : ANSWERS[q]));
  await runScorecard({ ctx: ctxA, questions: many, handler: worse, pageSize: 12, today: TODAY, retryFailures: false, feedMisses: false });
  const st = await routes.scorecardStatusAction(ctxA, {});
  check('scorecardStatus: reports value accuracy and citation coverage separately, plus the adjudication note', typeof st.run.valueScore === 'number' && st.run.citation && st.run.citation.required > 0 && typeof st.run.citation.coverage === 'number' && /ADJUDICATION\.md/.test(st.adjudicationNote) && st.previous && 'valueScore' in st.previous && 'citationCoverage' in st.previous, JSON.stringify({ v: st.run?.valueScore, c: st.run?.citation, n: st.adjudicationNote?.slice(0, 40), p: st.previous }));
  check('scorecardStatus: byCategory carries per-category value score and citation coverage; failing entries say whether the VALUE or only the citation was the problem', Object.values(st.run.byCategory).every((c) => 'valueScore' in c && 'citationCoverage' in c) && (st.failing.length === 0 || st.failing.every((f) => 'valueOk' in f && 'cited' in f && 'citationRequired' in f)), JSON.stringify(st.failing[0]));
  check('scorecardStatus: exam shape includes the persona mix', st.exam.personas && st.exam.personas.owner > 0 && st.exam.personas.bookkeeper > 0, JSON.stringify(st.exam.personas));
  check('scorecardStatus: trend compares with the previous comparable run; backend is tables again', st.backend === 'tables' && st.previous && typeof st.previous.score === 'number' && st.run.score <= st.previous.score, JSON.stringify({ r: st.run?.score, p: st.previous?.score, b: st.backend }));
  // TEAM K (2026-09-25): per-category trend alongside the overall one - qMesa's category is the only one
  // present in both runs, and its score got WORSE (the "9 customers" answer), so its delta must be negative.
  const catKey = qMesa.category;
  check('scorecardStatus: categoryTrend reports a per-category score/prevScore/delta against the same previous run', st.categoryTrend && st.categoryTrend[catKey] && typeof st.categoryTrend[catKey].score === 'number' && typeof st.categoryTrend[catKey].prevScore === 'number' && st.categoryTrend[catKey].delta < 0, JSON.stringify(st.categoryTrend));
  // TEAM F (speed): p50/p95 latency in the run summary, computed from the stored per-question latencyMs.
  check('scorecardStatus: run.latency reports p50/p95 over the answered (non-skipped) questions', st.run.latency && st.run.latency.n === st.run.answered && typeof st.run.latency.p50Ms === 'number' && typeof st.run.latency.p95Ms === 'number' && st.run.latency.p95Ms >= st.run.latency.p50Ms, JSON.stringify(st.run.latency));
}
{
  // TEAM F (scorecard correctness): a rubric failure's grader reason reaches the failing list as `why`,
  // so an operator can tell "the grader disagreed" from "Donovan was wrong" without re-running anything.
  const rq = { id: 'q-rub-why', text: 'What was found on the Ortiz job?', category: 'content', cmp: 'rubric', rubric: 'Names the part replaced.', oracle: { sql: "SELECT 'Replaced contactor' AS ref", params: [] } };
  const badGrade = async () => ({ content: [tu('grade', { pass: false, reason: 'answer never names a part' })], usage: { input_tokens: 10, output_tokens: 5 } });
  const run = await runScorecard({ ctx: ctxA, questions: [rq], handler: fakeHandler({ [rq.text]: { kind: 'answer', text: 'A technician visited.', facts: [], sources: SRC } }), today: TODAY, callModel: badGrade, feedMisses: false, retryFailures: false });
  const st = await routes.scorecardStatusAction(ctxA, { runId: run.runId });
  const f = st.failing.find((x) => x.questionId === 'q-rub-why');
  check('scorecardStatus: failing[].why carries the grader\'s own reason', f && f.why === 'answer never names a part', JSON.stringify(f));
  check('scorecardStatus: failing[].latencyMs is the question\'s own latency', f && typeof f.latencyMs === 'number' && f.latencyMs >= 0, JSON.stringify(f));
}
{
  // the nightly sweep step: claims once per day, runs the slice for the founder tenant with the injected handler
  const h = fakeHandler(ANSWERS);
  const env = { DEEPWELL_FOUNDER_TENANT_ID: ctxA.tenantKey };
  const noFounder = await routes.runScorecardSweepStep({ deadlineAt: Date.now() + 120_000, handler: h, env: {}, claim: false });
  check('nightly step: skipped when no founder tenant is configured', noFounder.skipped === 'no-founder-tenant');
  const off = await routes.runScorecardSweepStep({ deadlineAt: Date.now() + 120_000, handler: h, env: { ...env, DONOVAN_SCORECARD_NIGHTLY: '0' }, claim: false });
  check('nightly step: DONOVAN_SCORECARD_NIGHTLY=0 disables it', off.skipped === 'disabled');
  const late = await routes.runScorecardSweepStep({ deadlineAt: Date.now() + 5_000, handler: h, env, claim: false });
  check('nightly step: never starts with less than 20 s left on the sweep\'s deadline (customer-facing steps come first)', late.skipped === 'no-time');
  const ran = await routes.runScorecardSweepStep({ deadlineAt: Date.now() + 240_000, handler: h, env, claim: false });
  check('nightly step: runs a 40-question rotating slice as source "nightly"', ran.slice === 40 && ran.answered > 0 && !ran.error, JSON.stringify(ran));
  const stored = await store.getRun(ctxA, ran.runId);
  eq('nightly step: the run is recorded with source nightly', stored?.run.source, 'nightly');
}
{
  // the in-process hook
  check('hook: an ordinary HTTP-shaped request carries no scorecard call', takeScorecardCall({ headers: { 'x-scorecard-call': '1' }, body: { auth: { tenantId: 'x' }, scorecard: true }, query: { escalate: '1' } }) === null);
  check('hook: JSON cannot create a Symbol-keyed property (a body that tries is ignored)', takeScorecardCall(JSON.parse('{"Symbol(donovan.scorecard.call)":{"auth":{"tenantId":"x"}}}')) === null);
  check('hook: an in-process call with auth is recognised', takeScorecardCall({ [SCORECARD_CALL]: { auth: { tenantId: 't' }, escalate: true } })?.escalate === true);
  const askSrc = fs.readFileSync(path.join(ROOT, 'api/ask.js'), 'utf8');
  check('hook: ask.js skips the rate limiter and billing gate, never counts the allowance and bypasses the answer cache for scorecard calls',
    /const incrementAsksThisMonth = scorecardCall \? async \(\) => \{\} : incrementAsksThisMonthRaw/.test(askSrc) && /!scorecardCall && !\(await timer\.time\("limit"/.test(askSrc) && /ASK_CACHE_ENABLED_RAW && !scorecardCall/.test(askSrc) && /scorecardCall \? Promise\.resolve\(\{ allowed: true \}\)/.test(askSrc));
  check('allowance: an escalated ask is counted ONCE (one increment per agent result, not per model run)', (askSrc.match(/isCountableAskSource\("agent"\)\) await incrementAsksThisMonth\(db\)/g) ?? []).length === 1);
  // and the real handler end to end, on a question the deterministic paths answer with no model at all
  const askMod = await import('../api/ask.js');
  const { askViaHandler } = await import('../api/_lib/scorecard/askCall.js');
  const before = (await lite.query('SELECT count(*)::int AS n FROM ask_cache').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const allowanceBefore = (await lite.query(`SELECT COALESCE(sum(asks_this_month),0)::int AS n FROM usage_counters WHERE tenant_id = $1`, [tenA]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const real = await askViaHandler({ handler: askMod.default, auth: { tenantId: ctxA.tenantKey, orgId: ctxA.tenantKey, userId: null }, question: "What's the phone number on file for Karen Abernathy?", today: TODAY });
  const cmpReal = real.data ? compareAnswer({ cmp: 'value', expected: ['(480) 555-0148'], question: 'phone', citationRequired: false }, real.data) : null;
  check('REAL /api/ask handler through the hook: answers from the live pipeline without an HTTP request, token or model (Karen\'s phone matches the oracle)', Boolean(real.data) && cmpReal?.passed, JSON.stringify({ status: real.status, error: real.error, got: cmpReal?.got }));
  const after = (await lite.query('SELECT count(*)::int AS n FROM ask_cache').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const allowanceAfter = (await lite.query(`SELECT COALESCE(sum(asks_this_month),0)::int AS n FROM usage_counters WHERE tenant_id = $1`, [tenA]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  eq('REAL handler through the hook: nothing written to the answer cache and no allowance counted', [after - before, allowanceAfter - allowanceBefore], [0, 0]);
  const noHook = await askViaHandler({ handler: async (req, res) => askMod.default({ ...req, [SCORECARD_CALL]: undefined }, res), auth: { tenantId: ctxA.tenantKey }, question: "What's the phone number on file for Karen Abernathy?", today: TODAY });
  check('REAL handler WITHOUT the hook: an unauthenticated request is refused (401), not answered', noHook.status === 401 || noHook.status === 403, `status ${noHook.status}`);
}

/* ================================================================== 5. Sonnet escalation */
const SONNET = 'claude-sonnet-test';
const envOn = { DONOVAN_ESCALATION_MODEL: SONNET, DONOVAN_SONNET_DAILY_USD: '2' };
const runAgent = (question, callModel, extra = {}) => runDonovanAgent({ withTenant, ctxArg: ctxA, question, today: TODAY, callModel, env: envOn, ...extra });
const answerTool = (text = 'You have 5 customers.', value = '5') => tu('answer', { status: 'answered', text, facts: [{ label: 'Customers', value }], confidence: 0.9 });
// Turns per MODEL (escalation runs are separate loops): {haiku: [...], sonnet: [...]}, each turn fn(messages, req) -> blocks
const perModel = (turns, usageObj) => {
  const idx = { haiku: 0, sonnet: 0 };
  return scripted([(m, req) => { const k = req.model === SONNET ? 'sonnet' : 'haiku'; const list = turns[k]; const t = list[Math.min(idx[k]++, list.length - 1)]; return typeof t === 'function' ? t(m, req) : t; }], usageObj);
};
const countQuery = () => tu('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'count' });
const cannot = () => [tu('answer', { status: 'cannot_answer', text: 'x' })];
const countThenAnswer = () => scripted([() => [tu('run_query', { sql: 'SELECT count(*) AS n FROM customers', purpose: 'count' })], () => [answerTool()]]);
{
  eq('pricing: Sonnet is priced at $3 / $15 per MTok, Haiku at $1 / $5, cache reads at 0.1x', [
    usage.estimateModelCostUsd('claude-sonnet-4-5', { inputTokens: 1e6, outputTokens: 1e6 }),
    usage.estimateModelCostUsd('claude-haiku-4-5', { inputTokens: 1e6, outputTokens: 1e6 }),
    usage.estimateModelCostUsd('claude-sonnet-4-5', { cacheReadInputTokens: 1e6 }),
  ], [18, 6, 0.3]);
  eq('escalation model defaults to the Sonnet id readDocument.js documents; env overrides it', [esc.escalationModel({}), esc.escalationModel({ DONOVAN_ESCALATION_MODEL: 'x' })], ['claude-sonnet-4-5', 'x']);
  check('classifier: comparison / why / trend / stacked conditions are hard; a plain count is not',
    esc.classifyQuestionDifficulty('Why did expired warranties grow compared to last year in Mesa?').hard
    && esc.classifyQuestionDifficulty('Which Trane customers in Tucson have no service and an expired warranty but an active agreement?').hard
    && !esc.classifyQuestionDifficulty('how many customers do we have').hard && !esc.classifyQuestionDifficulty("what's Karen's phone number").hard);

  // easy question: stays on Haiku, one run
  const easy = countThenAnswer();
  const re = await runAgent('how many customers do we have on file', easy);
  check('escalation: an easy question runs on Haiku only', re.handled && easy.calls.every((c) => c.model === AGENT_MODEL) && !re.escalation && re.models.length === 1, JSON.stringify({ m: easy.calls.map((c) => c.model), e: re.escalation }));
  // (a) hard question: starts on Sonnet
  const hard = countThenAnswer();
  const rh = await runAgent('Why did expired warranties grow compared to last year in Mesa?', hard);
  check('escalation (a): a hard question runs on the escalation model from the first call', rh.handled && hard.calls.every((c) => c.model === SONNET) && rh.escalation?.reason === 'hard-question' && rh.models.join() === SONNET, JSON.stringify({ m: hard.calls.map((c) => c.model), e: rh.escalation }));
  check('escalation: temperature stays 0 on the escalation model', hard.calls.every((c) => c.temperature === 0));
  const dbg = agentDebugTrace(rh);
  check('debug trace shows which model answered (model, escalation)', dbg.model === SONNET && dbg.escalation?.reason === 'hard-question', JSON.stringify(dbg).slice(0, 300));
  // (b1) no answer on Haiku -> Sonnet answers
  const nb = perModel({ haiku: [cannot], sonnet: [() => [countQuery()], () => [answerTool()]] });
  const rn = await runAgent('how many customers do we have on file', nb);
  check('escalation (b): a Haiku cannot_answer is retried on Sonnet, and the Sonnet answer is used',
    rn.handled && rn.data.facts[0].value === '5' && nb.calls[0].model === AGENT_MODEL && nb.calls.at(-1).model === SONNET && rn.escalation?.reason === 'no-answer' && rn.escalation?.outcome === 'sonnet-answer-used' && rn.models.length === 2, JSON.stringify({ m: nb.calls.map((c) => c.model), e: rn.escalation }));
  // (b2) SQL rejected twice
  const rej = perModel({
    haiku: [() => [tu('run_query', { sql: 'SELECT * FROM documents', purpose: 'bad table' })], () => [tu('run_query', { sql: 'SELECT no_such FROM customers', purpose: 'bad column' })], () => [countQuery()], () => [answerTool()]],
    sonnet: [() => [countQuery()], () => [answerTool()]],
  });
  const rr = await runAgent('how many customers do we have on file', rej);
  check('escalation (b): two rejected/failed SQL statements on Haiku trigger a Sonnet run', rr.escalation?.reason === 'sql-rejected-twice' && rej.calls.some((c) => c.model === SONNET), JSON.stringify({ m: rej.calls.map((c) => c.model), e: rr.escalation }));
  // (b3) grounding dropped facts
  const drop = perModel({
    haiku: [() => [countQuery()], () => [tu('answer', { status: 'answered', text: 'You have 999 customers.', facts: [{ label: 'Customers', value: '999' }, { label: 'Real', value: '5' }], confidence: 0.9 })]],
    sonnet: [() => [countQuery()], () => [answerTool()]],
  });
  const rd = await runAgent('how many customers do we have on file', drop);
  check('escalation (b): an answer whose facts the grounding pass had to drop triggers a Sonnet run', rd.escalation?.reason === 'grounding-dropped-facts' && drop.calls.some((c) => c.model === SONNET), JSON.stringify({ m: drop.calls.map((c) => c.model), e: rd.escalation }));
  // (c) forced (thumbs-down replay / scorecard retry)
  const forced = countThenAnswer();
  const rf = await runAgent('how many customers do we have on file', forced, { escalate: true });
  check('escalation (c): escalate:true (thumbs-down replay, scorecard retry) runs Sonnet from the start', forced.calls.every((c) => c.model === SONNET) && rf.escalation?.reason === 'forced');
  // switches
  const off = countThenAnswer();
  const ro = await runAgent('Why did expired warranties grow compared to last year in Mesa?', off, { env: { ...envOn, DONOVAN_ESCALATION: '0' } });
  check('escalation: DONOVAN_ESCALATION=0 turns it off entirely (even for a hard/forced question)', off.calls.every((c) => c.model === AGENT_MODEL) && !ro.escalation);
  // daily cap
  const capCtx = { withTenant, ctxArg: ctxD, today: TODAY };
  check('daily cap: default $2, env-overridable, 0 disables Sonnet', esc.sonnetDailyCapUsd({}) === 2 && esc.sonnetDailyCapUsd({ DONOVAN_SONNET_DAILY_USD: '0.5' }) === 0.5 && (await esc.sonnetAllowed(withTenant, ctxD, { DONOVAN_SONNET_DAILY_USD: '0' })).why === 'cap-zero');
  const under = await esc.sonnetAllowed(withTenant, ctxD, envOn);
  await esc.recordSonnetSpend(withTenant, ctxD, 1.5);
  const stillOk = await esc.sonnetAllowed(withTenant, ctxD, envOn);
  await esc.recordSonnetSpend(withTenant, ctxD, 0.6);
  const over = await esc.sonnetAllowed(withTenant, ctxD, envOn);
  check('daily cap: spend accumulates per tenant per UTC day; allowed until it reaches the cap ($2)', under.allowed && stillOk.allowed && Math.abs(stillOk.spentUsd - 1.5) < 1e-6 && !over.allowed && over.why === 'daily-cap', JSON.stringify({ under, stillOk, over }));
  const capped = countThenAnswer();
  const rc = await runDonovanAgent({ ...capCtx, question: 'Why did expired warranties grow compared to last year in Mesa?', callModel: capped, env: envOn });
  check('daily cap: once reached, every question stays on Haiku (the answer is still given) and the trace says why', capped.calls.every((c) => c.model === AGENT_MODEL) && rc.escalation?.skipped === 'daily-cap', JSON.stringify(rc.escalation));
  const other = await esc.sonnetAllowed(withTenant, ctxA, envOn);
  check('daily cap: one tenant\'s Sonnet spend does not touch another tenant\'s', other.allowed);
  const spentRun = countThenAnswer();
  const before = (await esc.sonnetSpentTodayUsd(withTenant, ctxB)) ?? 0;
  await runDonovanAgent({ withTenant, ctxArg: ctxB, question: 'Why did expired warranties grow compared to last year in Mesa?', today: TODAY, callModel: spentRun, env: envOn }).catch(() => {});
  const afterSpend = (await esc.sonnetSpentTodayUsd(withTenant, ctxB)) ?? 0;
  check('daily cap: a Sonnet run records its own cost against the day\'s total (fail-closed metering)', spentRun.calls.length === 0 || afterSpend >= before, `${before} -> ${afterSpend}`);
  const before2 = (await esc.sonnetSpentTodayUsd(withTenant, ctxA)) ?? 0;
  const spendRun = countThenAnswer();
  await runAgent('Why did expired warranties grow compared to last year in Mesa?', spendRun);
  const after2 = (await esc.sonnetSpentTodayUsd(withTenant, ctxA)) ?? 0;
  const expected = usage.estimateModelCostUsd(SONNET, { inputTokens: 2400, outputTokens: 240 });
  check('daily cap: the recorded Sonnet spend equals the run\'s priced cost (2 calls x 1200 in / 120 out)', Math.abs(after2 - before2 - expected) < 0.000002, `${after2 - before2} vs ${expected}`);
  const noTime = perModel({ haiku: [cannot], sonnet: [cannot] });
  const rt = await runAgent('how many customers do we have on file', noTime, { deadlineAt: Date.now() + 8000 });
  check('escalation: never starts a Sonnet run with under 10 s left on the deadline', noTime.calls.length === 1 && rt.escalation?.skipped === 'no-time', JSON.stringify({ e: rt.escalation, calls: noTime.calls.length, r: rt.reason }));
}

/* ================================================================== 6. view_document_page */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
const pdfBytes = (pages, pad = 0) => Buffer.concat([Buffer.from('%PDF-1.4\n'), ...Array.from({ length: pages }, () => Buffer.from('<< /Type /Page /Parent 1 0 R >>\n')), Buffer.alloc(pad, 32)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
const objects = { 'k/nameplate.png': PNG, 'k/six.pdf': pdfBytes(6), 'k/one.pdf': pdfBytes(1), 'k/huge.pdf': pdfBytes(2, 4 * 1024 * 1024 + 10), 'k/photo.heic': HEIC };
const fetchObject = async (key) => { if (!objects[key]) throw new Error('missing'); return objects[key]; };
{
  const tb = () => createToolbox({ withTenant, ctxArg: ctxA, today: TODAY, fetchObject });
  const view = (t, documentId, page) => t.execute('view_document_page', { documentId, ...(page ? { page } : {}) });
  const seen = async (t, q) => { await t.execute('search_documents', { query: q }); };

  let t1 = tb();
  const notYet = await view(t1, uid('a', 'd', 9), 1);
  check('view_page: a document no tool has returned yet is REFUSED (evidence ledger), even though it exists', !notYet.ok && /not been returned/.test(notYet.content), notYet.content);
  const fake = await view(t1, uid('b', 'd', 1), 1);
  check('view_page: another tenant\'s document id is refused', !fake.ok);
  const garbage = await view(t1, 'not-a-uuid');
  check('view_page: a malformed id is refused', !garbage.ok);
  await seen(t1, 'nameplate LX-4OO4');
  const ok = await view(t1, uid('a', 'd', 9), 1);
  check('view_page: after search_documents returned it, an image is sent as an image block (base64 png)', ok.ok && Array.isArray(ok.content) && ok.content[0].type === 'image' && ok.content[0].source.media_type === 'image/png' && ok.content[0].source.data === PNG.toString('base64'), JSON.stringify(ok).slice(0, 200));
  const page2 = await view(t1, uid('a', 'd', 9), 2);
  check('view_page: an image has only page 1 (asking for page 2 is refused, and does not spend a view)', !page2.ok);

  const t2 = tb();
  await seen(t2, 'Plaza scan');
  const six = await view(t2, uid('a', 'd', 10), 1);
  check('view_page: a PDF over 5 pages is refused with a pointer to the text tools', !six.ok && /6 pages/.test(six.content) && /search_documents/.test(six.content), six.content);
  const huge = await view(t2, uid('a', 'd', 12), 1);
  check('view_page: a PDF over 4 MB is refused BEFORE anything is sent to the model', !huge.ok && /4 MB/.test(huge.content), huge.content);
  const one = await view(t2, uid('a', 'd', 11), 1);
  check('view_page: a small PDF (1 page) is sent as a document block', one.ok && one.content[0].type === 'document' && one.content[0].source.media_type === 'application/pdf', JSON.stringify(one).slice(0, 160));
  const t3 = tb();
  await seen(t3, 'Thornton iPhone photo');
  const heic = await view(t3, uid('a', 'd', 13), 1);
  check('view_page: an iPhone HEIC photo is refused with a clear message (the API cannot show it)', !heic.ok && /HEIC/.test(heic.content), heic.content);

  // max 2 views per question
  const t4 = tb();
  await seen(t4, 'nameplate LX-4OO4'); await seen(t4, 'Plaza single page scan');
  const v1 = await view(t4, uid('a', 'd', 9), 1);
  const v2 = await view(t4, uid('a', 'd', 11), 1);
  const v3 = await view(t4, uid('a', 'd', 9), 1);
  check('view_page: at most 2 views per question (the third is refused)', v1.ok && v2.ok && !v3.ok && /2 views/.test(v3.content), v3.content);

  // grounding: a fact read from a viewed page cites document+page and survives; without the view it would not
  const t5 = tb();
  await seen(t5, 'nameplate LX-4OO4');
  const beforeView = shapeAgentAnswer({ status: 'answered', text: 'The serial is LX-4004.', facts: [{ label: 'Serial', value: 'LX-4004', sources: [{ documentId: uid('a', 'd', 9), location: { page: 2 } }] }] }, t5.ledger, { question: 'serial on the nameplate photo', today: TODAY });
  await view(t5, uid('a', 'd', 9), 1);
  const cited = shapeAgentAnswer({ status: 'answered', text: 'The serial is LX-4004 (read from the original photo).', facts: [{ label: 'Serial', value: 'LX-4004', sources: [{ documentId: uid('a', 'd', 9), location: { page: 1 } }] }] }, t5.ledger, { question: 'serial on the nameplate photo', today: TODAY });
  check('view_page grounding: a fact citing the viewed document + page passes shape.js; a page never returned is dropped', cited.answered && cited.data.facts.length === 1 && cited.data.sources[0].filename === 'thornton-nameplate.png' && !beforeView.answered, JSON.stringify({ c: cited.data?.sources, b: beforeView.answered }));
  const viewOnlyPage1 = shapeAgentAnswer({ status: 'answered', text: 'x', facts: [{ label: 'Serial', value: 'LX-4004', sources: [{ documentId: uid('a', 'd', 11), location: { page: 1 } }] }] }, t5.ledger, { question: 'q', today: TODAY });
  check('view_page grounding: viewing one document does not make another document citable', !viewOnlyPage1.answered);

  // the whole loop: search -> view -> answer citing the page
  const model = scripted([
    () => [tu('search_documents', { query: 'nameplate LX-4OO4' })],
    () => [tu('view_document_page', { documentId: uid('a', 'd', 9), page: 1 })],
    () => [tu('answer', { status: 'answered', text: 'The nameplate reads serial LX-4004 (read from the original photo).', facts: [{ label: 'Serial', value: 'LX-4004', sources: [{ documentId: uid('a', 'd', 9), location: { page: 1 } }] }], confidence: 0.9 })],
  ]);
  const r = await runDonovanAgent({ withTenant, ctxArg: ctxA, question: 'what is the serial on the Thornton nameplate photo', today: TODAY, callModel: model, env: envOn, fetchObject });
  check('agent loop: search -> view_document_page (image block reaches the model) -> grounded answer citing the page',
    r.handled && r.data.facts[0].value === 'LX-4004' && model.calls[0].tools.includes('view_document_page') && Array.isArray(model.calls[2].lastResult.text) && model.calls[2].lastResult.text[0].type === 'image', JSON.stringify({ h: r.handled, reason: r.reason, res: model.calls[2]?.lastResult?.text?.[0]?.type }));
  check('agent prompt: says when to use the view tool and to cite document + page', /view_document_page/.test(model.calls[0].system.map((b) => b.text).join('')) && /must cite that documentId and page/.test(model.calls[0].system.map((b) => b.text).join('')));
  const toolDef = JSON.stringify(model.calls[0].tools);
  check('agent: the view tool is offered alongside the existing tools', /view_document_page/.test(toolDef) || model.calls[0].tools.includes('view_document_page'));
}

/* ================================================================== 7. body-name customer link */
{
  const cust = [
    { id: 'p', name: 'David Prentiss', address: '9 Pine Ct, Mesa, AZ 85201' }, { id: 'l1', name: 'Ann Lee', address: '3 A St, Tucson, AZ 85701' },
    { id: 'l2', name: 'Ann Lee', address: '4 B St, Tucson, AZ 85701' }, { id: 'w', name: 'Bill Whitmore', address: '88 Whitmore Ave, Mesa, AZ 85201' },
    { id: 's', name: 'Sam Ortega', address: '21 Ridge Rd, Gilbert, AZ 85234' }, { id: 'ph', name: 'Customer at 12 Elm St', address: '12 Elm St, Mesa, AZ 85201', nameSource: 'address' },
  ];
  const pg = (text) => [{ page_no: 1, text }];
  const v = (t) => findCustomersInBody(pg(t), cust);
  eq('match (pure): a full name with a possessive is unique', [v("Reminder logged for David Prentiss's account: confirm filter size").status, v("Reminder logged for David Prentiss's account: confirm filter size").matches[0]?.customerId], ['unique', 'p']);
  check('match (pure): case, punctuation and line breaks do not matter', v('re: DAVID\n prentiss, call back').status === 'unique');
  eq('match (pure): a street address alone is unique (basis address)', [v('parts at 88 Whitmore Ave, Mesa').status, v('parts at 88 Whitmore Ave, Mesa').matches[0].basis], ['unique', 'address']);
  eq('match (pure): the same full name on two customers is AMBIGUOUS', v('Call Ann Lee').status, 'ambiguous');
  eq('match (pure): a name and an address of two different customers is AMBIGUOUS', v('Sam Ortega asked about 88 Whitmore Ave').status, 'ambiguous');
  eq('match (pure): a surname alone is only PARTIAL (review), never unique', [v('Follow up with Prentiss').status, v('Follow up with Prentiss').candidates.map((c) => c.customerId)], ['partial', ['p']]);
  eq('match (pure): a first name alone, a different person, or no name is none', [v('David called').status, v('Davidson Prentice called').status, v('nothing here').status], ['none', 'none', 'none']);
  eq('match (pure): a "Customer at <address>" placeholder is never matched by its made-up NAME, only by its real street address', [v('Customer at 12 Elm St').matches[0]?.basis, findCustomersInBody(pg('Customer at 99 Nowhere Rd'), cust).status], ['address', 'none']);
  check('match (pure): a longer house number or street ("188 Whitmore Ave", "88 Whitmore Avenue Extension") is never an address match (at most a partial to review)', v('188 Whitmore Ave').status !== 'unique' && v('88 Whitmore Avenue Extension').status !== 'unique');

  const db = async (sql, p = []) => (await lite.query(sql, p)).rows;
  const links = async (n) => db(`SELECT l.entity_id, l.linked_by FROM document_entity_links l WHERE l.document_id = $1`, [uid('c', 'd', n)]);
  const custName = async (n) => (await db(`SELECT value FROM extractions WHERE document_id = $1 AND field_key = 'customer_name'`, [uid('c', 'd', n)])).map((r) => r.value);

  const dry = await applyBodyNameLinks(ctxC, { dryRun: true });
  eq('body-name (DB): a dry run previews the unique matches and writes nothing', [dry.linked.map((x) => x.documentId).sort(), (await links(1)).length, (await custName(1)).length], [[uid('c', 'd', 1), uid('c', 'd', 10), uid('c', 'd', 5), uid('c', 'd', 9)].sort(), 0, 0]);
  const scan = await integrity.integrityScan(ctxC);
  check('body-name (DB): the integrity scan reports them (bodyNameLinks / bodyNameReview counts)', scan.counts.bodyNameLinks === 4 && scan.counts.bodyNameReview === 3, JSON.stringify(scan.counts));

  const res = await integrity.integrityFixTenant(ctxC, { apply: ['linkBodyNames'], dryRun: false });
  eq('body-name (DB): the integrity fix links the 4 unambiguous memos', res.bodyNamesLinked.map((x) => x.documentId).sort(), [uid('c', 'd', 1), uid('c', 'd', 10), uid('c', 'd', 5), uid('c', 'd', 9)].sort());
  eq('body-name (DB): "Reminder logged for David Prentiss\'s account" is linked to David Prentiss with linked_by name-in-body', await links(1), [{ entity_id: uid('c', 'c', 1), linked_by: 'name-in-body' }]);
  eq('body-name (DB): the missing customer_name field is filled ("Missing required field: Customer" clears)', await custName(1), ['David Prentiss']);
  eq('body-name (DB): a document that already had a customer_name extraction keeps it (not overwritten or duplicated) but is linked', [await custName(10), (await links(10)).map((l) => l.linked_by)], [['D. Prentiss (handwritten)'], ['name-in-body']]);
  eq('body-name (DB): an address-only match links to that address\'s customer (Bill Whitmore)', (await links(5)).map((l) => l.entity_id), [uid('c', 'c', 5)]);
  eq('body-name (DB): the ambiguous memos (two Ann Lees; a name and an address that disagree) are NOT linked - they go to review',
    [(await links(2)).length, (await links(6)).length, res.bodyNamesForReview.filter((r) => r.kind === 'ambiguous').map((r) => r.documentId).sort()], [0, 0, [uid('c', 'd', 2), uid('c', 'd', 6)].sort()]);
  eq('body-name (DB): a surname-only memo is NOT linked - "Needs your review" (partial)', [(await links(3)).length, res.bodyNamesForReview.find((r) => r.documentId === uid('c', 'd', 3))?.kind], [0, 'partial']);
  eq('body-name (DB): a customer that exists only in ANOTHER tenant is never matched (Zed Competitor)', [(await links(4)).length, res.bodyNamesForReview.some((r) => r.documentId === uid('c', 'd', 4))], [0, false]);
  eq('body-name (DB): a document that already has a link is left alone', (await links(7)).map((l) => l.entity_id), [uid('c', 'c', 4)]);
  eq('body-name (DB): a document a person explicitly unlinked is left alone', (await links(8)).length, 0);
  eq('body-name (DB): a memo naming only a street address links to that address\'s (placeholder) customer, by address', (await links(9)).map((l) => l.entity_id), [uid('c', 'c', 6)]);
  const again = await integrity.integrityFixTenant(ctxC, { apply: ['linkBodyNames'], dryRun: false });
  eq('body-name (DB): running it again changes nothing (idempotent)', again.bodyNamesLinked.length, 0);
  const audit = await db(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'integrity.link_body_name'`);
  check('body-name (DB): each link is audited (no question/PII in logs; the audit row holds ids and the basis)', audit[0].n === 4);
  const crossTenant = await db(`SELECT count(*)::int AS n FROM document_entity_links WHERE tenant_id = $1 AND entity_id IN (SELECT id FROM entities WHERE tenant_id <> $1)`, [tenC]);
  eq('body-name (DB): no link crosses a tenant boundary', crossTenant[0].n, 0);
  check('body-name: wired into the integrity fix list (server APPLY_ACTIONS, client ALL_INTEGRITY_FIXES, nightly sweep, ingest)',
    integrity.APPLY_ACTIONS.has('linkBodyNames')
    && /ALL_INTEGRITY_FIXES[^]*?'linkBodyNames'/.test(fs.readFileSync(path.join(ROOT, 'src/services/reviewClient.ts'), 'utf8'))
    && /'linkBodyNames'/.test(fs.readFileSync(path.join(ROOT, 'api/_lib/routes/cron-sweep.js'), 'utf8'))
    && /applyBodyNameLinks\(ctx, \{ documentId \}\)/.test(fs.readFileSync(path.join(ROOT, 'api/_lib/extractDocument.js'), 'utf8')));
  const prompt = (await import('../api/_lib/extractFields.js')).buildExtractPrompt([{ page: 1, text: 'x' }], 'correspondence');
  check('extraction prompt: tells the model to capture a customer named only in a memo body as customer_name', /names a customer only in its body/.test(JSON.stringify(prompt)) && /David Prentiss/.test(JSON.stringify(prompt)));
  const chip = fs.readFileSync(path.join(ROOT, 'src/components/DocumentPreview.tsx'), 'utf8');
  check('UI: a non-blocking "Linked from name in document - confirm" chip renders from linked_by name-in-body (not a DocumentIssue)', /Linked from name in document/.test(chip) && /linkedFromBodyName/.test(fs.readFileSync(path.join(ROOT, 'src/hooks/usePostgresSync.ts'), 'utf8')));
}

/* ================================================================== 9. citation precision (TEAM T3) */
{
  eq('significantTokens: numbers verbatim, words 4+ letters, no stopwords, de-duplicated', significantTokens('Replaced the capacitor on 2026-09-10, twice'), ['2026', '09', '10', 'replaced', 'capacitor', 'twice']);
  check('claimSupportedByText: nothing concrete to check ("Yes.") is always supported', claimSupportedByText('Yes.', 'unrelated text entirely'));
  check('claimSupportedByText: a claim whose concrete tokens are in the text is supported', claimSupportedByText('technician Danny Ochoa', 'Visit by Danny Ochoa on site'));
  check('claimSupportedByText: a claim whose concrete tokens are absent is NOT supported', !claimSupportedByText('total 4300 dollars', 'Replaced capacitor, no charge'));
  {
    const data = { facts: [{ label: 'technician', value: 'Danny Ochoa', documentId: 'd1' }, { label: 'total', value: '4300', documentId: 'd1' }], sources: [{ documentId: 'd1' }] };
    const map = new Map([['d1', 'Visit by Danny Ochoa. Replaced capacitor, no charge.']]);
    const p = citationPrecision(data, map);
    eq('citationPrecision: precision is supported/total over the facts actually cited, with the unsupported one named', [p.citedCount, p.supportedCount, p.precision, p.unsupportedClaims.length], [2, 1, 0.5, 1]);
  }
  eq('citationPrecision: no citation and/or no facts reports null (nothing to check), not zero', citationPrecision({ facts: [] }, new Map()).precision, null);
  {
    const data = { facts: [{ label: 'note', value: 'Replaced capacitor', documentId: uid('f', 'd', 1) }], sources: [{ documentId: uid('f', 'd', 1) }] };
    const cp = await checkCitationPrecision(withTenant, ctxF, data);
    eq('checkCitationPrecision (DB): fetches the cited document\'s own text and confirms the claim against it', [cp.citedCount, cp.precision], [1, 1]);
    const wrong = { facts: [{ label: 'note', value: 'Replaced the entire compressor unit', documentId: uid('f', 'd', 1) }], sources: [{ documentId: uid('f', 'd', 1) }] };
    check('checkCitationPrecision (DB): a claim the cited document does not support scores below 1', (await checkCitationPrecision(withTenant, ctxF, wrong)).precision < 1);
  }
  check('checkCitationPrecision (DB): a bogus document id never throws, just reports null', (await checkCitationPrecision(withTenant, ctxF, { facts: [{ label: 'x', value: 'y', documentId: '00000000-0000-0000-0000-000000000000' }] })).precision === null || typeof (await checkCitationPrecision(withTenant, ctxF, { facts: [{ label: 'x', value: 'y', documentId: '00000000-0000-0000-0000-000000000000' }] })).precision === 'number');
}

/* ================================================================== 10. Claude baseline (TEAM T3) */
{
  eq('baseline.keywordsOf: significant words only (stopwords/short words dropped), capped at 6', baseline.keywordsOf('Has Ann Alpha had any part replaced more than once on the same unit?'), ['alpha', 'part', 'replaced', 'more', 'once', 'same']);

  await withTenant(ctxF, async (db) => {
    const scoped = { oracle: { scope: { sql: `SELECT document_id FROM document_entity_links WHERE entity_id = $1`, params: [uid('f', 'c', 1)] } } };
    const ids = await baseline.candidateDocIds(db, scoped, { today: TODAY });
    check('baseline.candidateDocIds: uses oracle.scope when present (the oracle\'s own candidate set)', ids.length > 0 && ids.every((id) => [1, 2, 3, 13, 14].map((n) => uid('f', 'd', n)).includes(id)), JSON.stringify(ids));

    const unscoped = { text: 'What was found about the capacitor?' };
    const fallback = await baseline.candidateDocIds(db, unscoped, { today: TODAY });
    check('baseline.candidateDocIds: falls back to keyword full-text search when there is no oracle.scope', fallback.includes(uid('f', 'd', 1)), JSON.stringify(fallback));

    const built = await baseline.scopeText(db, [uid('f', 'd', 1)]);
    check('baseline.scopeText: labels each document and includes its page text', built.text.includes('Replaced capacitor') && built.docIds.length === 1);
  });

  // citationRequired:false isolates the caching/budget/gap behavior under test from citation grading,
  // which has its own dedicated coverage above (runner/compare tests) and is unaffected by this scripted model.
  const q1 = { id: 'baseline-t3-001', category: 'connect', text: 'Was the capacitor replaced for Ann Alpha?', cmp: 'yesno', citationRequired: false, oracle: { sql: `SELECT true AS v`, params: [] } };
  let calls = 0;
  const scriptedModel = async () => {
    calls++;
    return { usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'tool_use', name: 'answer', input: { text: 'Yes, the capacitor was replaced.', facts: [], citedDocumentIds: [] } }] };
  };
  const examV = 'verify-scorecard-baseline-test';
  baselineStore.resetBaselineStoreForTests?.();
  const r1 = await baseline.runBaselineForQuestion({ ctxArg: ctxF, withTenant, question: q1, examVersion: examV, today: TODAY, callModel: scriptedModel, deadlineAt: Date.now() + 60_000 });
  check('runBaselineForQuestion: asks the model and grades + caches the result', calls === 1 && r1.cached === false && r1.passed === true, JSON.stringify(r1));
  const r2 = await baseline.runBaselineForQuestion({ ctxArg: ctxF, withTenant, question: q1, examVersion: examV, today: TODAY, callModel: scriptedModel, deadlineAt: Date.now() + 60_000 });
  check('runBaselineForQuestion: a second call for the same (examVersion, questionId) is served from cache, never re-asks the model', calls === 1 && r2.cached === true, `calls=${calls}`);

  {
    const q2 = { id: 'baseline-t3-002', category: 'connect', text: 'Was Bob Bravo billed for his unit?', cmp: 'yesno', citationRequired: false, oracle: { sql: `SELECT true AS v`, params: [] } };
    const examV2 = 'verify-scorecard-baseline-budget-test';
    const page = await baseline.runBaselinePage({ ctxArg: ctxF, withTenant, questions: [q1, q2], examVersion: examV2, today: TODAY, offset: 0, pageSize: 6, budgetUsd: 0.0000001, deadlineAt: Date.now() + 60_000, callModel: scriptedModel });
    check('runBaselinePage: stops as soon as spend reaches a tiny budget (one question answered, then stopped/budget, done)', page.stopped === 'budget' && page.results.length === 1 && page.done === true, JSON.stringify({ stopped: page.stopped, n: page.results.length, done: page.done }));
    const page2 = await baseline.runBaselinePage({ ctxArg: ctxF, withTenant, questions: [q1, q2], examVersion: examV2, today: TODAY, offset: 0, pageSize: 6, budgetUsd: 5, deadlineAt: Date.now() + 1_000, callModel: scriptedModel });
    check('runBaselinePage: stops when the deadline is too close to safely start another question', page2.stopped === 'deadline' && page2.results.length === 0, JSON.stringify(page2.stopped));

    const examV3 = 'verify-scorecard-baseline-pagesize-test';
    const page3 = await baseline.runBaselinePage({ ctxArg: ctxF, withTenant, questions: [q1, q2], examVersion: examV3, today: TODAY, offset: 0, pageSize: 1, budgetUsd: 5, deadlineAt: Date.now() + 60_000, callModel: scriptedModel });
    check('runBaselinePage: a single call never asks more than pageSize questions, and hands back the right nextOffset to resume', page3.results.length === 1 && page3.nextOffset === 1 && page3.done === false && page3.stopped === null, JSON.stringify({ n: page3.results.length, next: page3.nextOffset, done: page3.done, stopped: page3.stopped }));
  }

  {
    const donovanResults = [
      { questionId: q1.id, category: 'connect', passed: true, skipped: false },
      { questionId: 'baseline-t3-999', category: 'connect', passed: false, skipped: false },
      { questionId: 'baseline-t3-other', category: 'lists', passed: true, skipped: false },
    ];
    const gap = await baseline.baselineGapReport(ctxF, examV, donovanResults);
    eq('baselineGapReport: donovan vs cached baseline per category, gap = donovan - baseline', [gap.connect.donovanScore, gap.connect.baselineScore, gap.connect.gap, gap.connect.baselineCoverage], [0.5, 1, -0.5, 0.5]);
    eq('baselineGapReport: a category with no cached baseline at all reports null (not a misleading 0)', [gap.lists.baselineScore, gap.lists.gap], [null, null]);
  }
}

/* ================================================================== hygiene */
{
  const apiTop = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
  eq('api/ has exactly 12 top-level files (Vercel function limit)', apiTop.length, 12);
  const scoreFiles = fs.readdirSync(path.join(ROOT, 'api/_lib/scorecard')).map((f) => fs.readFileSync(path.join(ROOT, 'api/_lib/scorecard', f), 'utf8')).join('\n');
  const logCalls = [...scoreFiles.matchAll(/console\.(?:log|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
  check('no question text or PII in scorecard logs (log payloads carry counts/ids only)', logCalls.every((c) => !/\bq\.text\b|\bquestion\b|\banswer\b|\bgot\b|\bexpected\b/.test(c.replace(/asked|nextOffset|route: "scorecard"/g, ''))), logCalls.join(' | ').slice(0, 300));
  check('grader and agent run at temperature 0', /temperature: 0/.test(fs.readFileSync(path.join(ROOT, 'api/_lib/scorecard/grader.js'), 'utf8')) && /temperature: 0/.test(fs.readFileSync(path.join(ROOT, 'api/_lib/agent/loop.js'), 'utf8')));
  const mig = fs.readFileSync(path.join(ROOT, 'M3-config/30-donovan-scorecard.sql'), 'utf8');
  check('migration 30: two tables, tenant RLS ENABLE + FORCE, optional', /FORCE\s+ROW LEVEL SECURITY/.test(mig) && (mig.match(/FORCE\s+ROW LEVEL SECURITY/g) ?? []).length === 2 && /OPTIONAL/.test(mig));
  const review = fs.readFileSync(path.join(ROOT, 'api/review.js'), 'utf8');
  check('operator actions scorecardRun / scorecardStatus / scorecardBaseline are registered as OPERATOR_ACTIONS', /OPERATOR_ACTIONS[^;]*scorecardRun/.test(review.replace(/\n/g, ' ')) && /OPERATOR_ACTIONS[^;]*scorecardStatus/.test(review.replace(/\n/g, ' ')) && /OPERATOR_ACTIONS[^;]*scorecardBaseline/.test(review.replace(/\n/g, ' ')));
  check('scorecardBaseline is wired into the action switch and rate limiter alongside the other scorecard actions', /case 'scorecardBaseline':/.test(review) && /INTEGRITY_RATE_LIMIT_ACTIONS[^;]*scorecardBaseline/.test(review.replace(/\n/g, ' ')));
}

console.log = realLog; console.warn = realWarn; console.error = realErr;
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
process.exit(0);
