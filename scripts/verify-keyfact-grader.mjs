/**
 * Checks for the R21 (L4) deterministic KEY-FACT grader (api/_lib/scorecard/keyFactGrader.js): the
 * $0 offline substitute for the LLM rubric grader, used when an exam `rubric` question also carries
 * a hand-derived, golden-data-verified `keyFacts` field (test-docs/scorecard/**).
 *
 * Pure unit tests only - no DB, no PGlite, no model, no network. `gradeKeyFacts` is a pure function
 * of {question, data} (an /api/ask-shaped answer payload), so every fixture here is a small literal
 * object, not a real exam question or a real Donovan answer.
 *
 *   npx tsx scripts/verify-keyfact-grader.mjs
 */
import {
  numbersIn, hasToken, factHolds, orderHolds, gradeKeyFacts, calibrationRow, summarizeCalibration,
} from '../api/_lib/scorecard/keyFactGrader.js';
import { norm } from '../api/_lib/scorecard/compare.js';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** A minimal /api/ask-shaped answer payload for gradeKeyFacts. */
const answer = (text, { facts = [], sources, records } = {}) => ({
  kind: 'answer', text, facts,
  ...(sources !== undefined ? { sources } : {}),
  ...(records !== undefined ? { records } : {}),
});

/* ============================================================== 1. normalization primitives */

console.log('-- normalization --');
eq('numbersIn: comma thousands separator', numbersIn('the total is 1,234 dollars'), [1234]);
eq('numbersIn: no comma, decimals, negatives', numbersIn('owes -12.5 on 3 invoices'), [-12.5, 3]);
eq('numbersIn: a 3-digit number is never mistaken for a comma group', numbersIn('123 items'), [123]);

check('hasToken: whole-word match', hasToken(norm('the unit is 3 ton'), norm('3 ton')));
check('hasToken: does not match a partial-word substring', !hasToken(norm('tonnage is unknown'), norm('ton')));
check('hasToken: empty needle never matches', !hasToken(norm('anything'), ''));

/* ============================================================== 2. factHolds: text / date / number */

console.log('-- factHolds --');
check('factHolds text: exact phrase present', factHolds({ type: 'text', value: 'Linda Fitzgerald' }, 'Linda Fitzgerald is overdue', norm('Linda Fitzgerald is overdue')));
check('factHolds text: any ONE alternative (name variant) is enough', factHolds({ type: 'text', value: ['Bob Smith', 'Robert Smith'] }, 'Robert Smith called', norm('Robert Smith called')));
check('factHolds text: case/punctuation-insensitive', factHolds({ type: 'text', value: 'R-410A' }, 'refrigerant: r410a', norm('refrigerant: r410a')) || factHolds({ type: 'text', value: 'R-410A' }, 'refrigerant: R-410A', norm('refrigerant: R-410A')));
check('factHolds text: absent phrase fails', !factHolds({ type: 'text', value: 'Copper Sky Dental' }, 'Sonoran Grill Restaurant', norm('Sonoran Grill Restaurant')));

check('factHolds date: ISO form', factHolds({ type: 'date', value: '2026-06-28' }, 'installed 2026-06-28', ''));
check('factHolds date: US slash form', factHolds({ type: 'date', value: '2026-06-28' }, 'installed 6/28/2026', ''));
check('factHolds date: "Month D, YYYY" form', factHolds({ type: 'date', value: '2026-06-28' }, 'installed June 28, 2026', ''));
check('factHolds date: "D Month YYYY" form (no comma)', factHolds({ type: 'date', value: '2026-06-28' }, 'installed 28 June 2026', ''));
check('factHolds date: abbreviated month', factHolds({ type: 'date', value: '2026-06-28' }, 'installed Jun. 28, 2026', ''));
check('factHolds date: wrong date fails', !factHolds({ type: 'date', value: '2026-06-28' }, 'installed June 25, 2026', ''));

check('factHolds number: exact match', factHolds({ type: 'number', value: 1234 }, 'total $1,234 due', ''));
check('factHolds number: comma-insensitive', factHolds({ type: 'number', value: 1234 }, 'total $1,234', ''));
check('factHolds number: within tolerance (rounding)', factHolds({ type: 'number', value: 1234.4, tolerance: 0.5 }, 'total $1234', ''));
check('factHolds number: outside tolerance fails', !factHolds({ type: 'number', value: 1234, tolerance: 0.5 }, 'total $1230', ''));
check('factHolds: malformed fact never throws / is false', !factHolds(null, 'anything', 'anything') && !factHolds({}, 'anything', 'anything'));

/* ============================================================== 3. orderHolds: chronological constraint */

console.log('-- orderHolds --');
check('orderHolds: dates in required order pass', orderHolds(['2026-01-01', '2026-06-01'], 'Visit on January 1, 2026, then again June 1, 2026.'));
check('orderHolds: dates reversed in the text fail', !orderHolds(['2026-01-01', '2026-06-01'], 'Visit on June 1, 2026, then earlier January 1, 2026.'));
check('orderHolds: a date not found at all is skipped, not a failure by itself', orderHolds(['2026-01-01', '2099-12-31'], 'Only January 1, 2026 is mentioned.'));
eq('orderHolds: empty list trivially holds', orderHolds([], 'anything'), true);

/* ============================================================== 4. gradeKeyFacts: required / forbidden / citation */

console.log('-- gradeKeyFacts: required facts --');
{
  const q = { keyFacts: { required: [{ type: 'text', value: 'Linda Fitzgerald' }, { type: 'date', value: '2024-02-11' }] } };
  const good = gradeKeyFacts({ question: q, data: answer('Linda Fitzgerald is overdue - last visit February 11, 2024.', { records: [{ label: 'x' }] }) });
  check('gradeKeyFacts: all required facts present + cited -> pass', good.passed, JSON.stringify(good));
  eq('gradeKeyFacts: partialCredit is 1.0 when all required facts hold', good.partialCredit, 1);

  const missingOne = gradeKeyFacts({ question: q, data: answer('Linda Fitzgerald is overdue.', { records: [{ label: 'x' }] }) });
  check('gradeKeyFacts: one missing required fact -> fail', !missingOne.passed, JSON.stringify(missingOne));
  eq('gradeKeyFacts: partialCredit is 0.5 with 1 of 2 required facts', missingOne.partialCredit, 0.5);
  check('gradeKeyFacts: missingRequired names the missing fact', missingOne.missingRequired.some((s) => s.includes('2024-02-11')), JSON.stringify(missingOne.missingRequired));
}

console.log('-- gradeKeyFacts: forbidden facts --');
{
  // Copper Sky Dental refrigerant shape: must state R-410A for the unit that has it, and must NOT
  // claim a refrigerant for the OTHER customer's unit (a forbidden fact - fabricated/out-of-scope data).
  const q = { keyFacts: {
    required: [{ type: 'text', value: 'R-410A' }],
    forbidden: [{ type: 'text', value: 'R-22' }, { type: 'text', value: 'Sonoran Grill Restaurant' }],
  } };
  const good = gradeKeyFacts({ question: q, data: answer('The Trane unit at Copper Sky Dental has R-410A on file.', { records: [{ label: 'x' }] }) });
  check('gradeKeyFacts: required present, no forbidden fact -> pass', good.passed, JSON.stringify(good));

  const bad = gradeKeyFacts({ question: q, data: answer('Copper Sky Dental has R-410A; Sonoran Grill Restaurant has R-22.', { records: [{ label: 'x' }] }) });
  check('gradeKeyFacts: a forbidden fact (other customer\'s data) fails regardless of required facts', !bad.passed, JSON.stringify(bad));
  check('gradeKeyFacts: forbiddenFound reports both hits', bad.forbiddenFound.length === 2, JSON.stringify(bad.forbiddenFound));
}

console.log('-- gradeKeyFacts: order constraint --');
{
  const q = { keyFacts: {
    required: [{ type: 'date', value: '2026-01-10' }, { type: 'date', value: '2026-05-20' }],
    order: { dates: ['2026-01-10', '2026-05-20'] },
  } };
  const good = gradeKeyFacts({ question: q, data: answer('First serviced January 10, 2026, then again May 20, 2026.', { records: [{ label: 'x' }] }) });
  check('gradeKeyFacts: correct chronological order -> pass', good.passed, JSON.stringify(good));
  const bad = gradeKeyFacts({ question: q, data: answer('Serviced May 20, 2026 and January 10, 2026.', { records: [{ label: 'x' }] }) });
  check('gradeKeyFacts: dates present but out of the required order -> fail', !bad.passed, JSON.stringify(bad));
}

console.log('-- gradeKeyFacts: citation requirement --');
{
  const q = { keyFacts: { required: [{ type: 'number', value: 3 }] } };
  const noCitation = gradeKeyFacts({ question: q, data: answer('3 units are on file.') }); // no sources/records
  check('gradeKeyFacts: right value but no citation -> fail (citation required by default when facts exist)', !noCitation.passed, JSON.stringify(noCitation));
  check('gradeKeyFacts: factsOk is still true (value was right; only citation is missing)', noCitation.factsOk, JSON.stringify(noCitation));
  const cited = gradeKeyFacts({ question: q, data: answer('3 units are on file.', { sources: [{ id: 1 }] }) });
  check('gradeKeyFacts: right value + a source -> pass', cited.passed, JSON.stringify(cited));

  const optOut = gradeKeyFacts({ question: { keyFacts: { required: [{ type: 'number', value: 3 }], citationRequired: false } }, data: answer('3 units are on file.') });
  check('gradeKeyFacts: citationRequired:false skips the citation check', optOut.passed, JSON.stringify(optOut));
}

console.log('-- gradeKeyFacts: no-answer / decline --');
{
  const q = { keyFacts: { required: [{ type: 'text', value: 'R-410A' }] } };
  const declined = gradeKeyFacts({ question: q, data: { kind: 'no-answer', text: 'I don\'t have that on file.', facts: [] } });
  check('gradeKeyFacts: a decline never passes a question with required facts', !declined.passed, JSON.stringify(declined));
}

console.log('-- gradeKeyFacts: no keyFacts on the question -> null (falls back to needs-grader upstream)');
check('gradeKeyFacts: returns null when the question has no keyFacts field', gradeKeyFacts({ question: { cmp: 'rubric' }, data: answer('anything') }) === null);

/* ============================================================== 5. representative item-shape fixtures */
// One hand-written good + bad pair per real exam item SHAPE this grader covers (not full exam
// questions - see test-docs/scorecard/exam.json / generalization/*.json for the real, golden-data-
// derived keyFacts objects these mirror).

console.log('-- representative item shapes --');
{
  // "walk me through the last two visits, in order" - required facts + order.
  const q = { keyFacts: {
    required: [{ type: 'date', value: '2025-03-01' }, { type: 'date', value: '2025-09-15' }, { type: 'text', value: 'filter replacement' }],
    order: { dates: ['2025-03-01', '2025-09-15'] },
  } };
  check('last-N-visits shape: complete + ordered + cited -> pass',
    gradeKeyFacts({ question: q, data: answer('On March 1, 2025 a filter replacement was performed; the next visit was September 15, 2025.', { records: [{ label: 'x' }] }) }).passed);
  check('last-N-visits shape: missing the work performed detail -> fail',
    !gradeKeyFacts({ question: q, data: answer('Visits on March 1, 2025 and September 15, 2025.', { records: [{ label: 'x' }] }) }).passed);
}
{
  // "compare X and Y" tie/agreement shape - a required "tied"/"same" wording plus both counts.
  const q = { keyFacts: { required: [{ type: 'number', value: 60 }, { type: 'text', value: ['tied', 'the same', 'equal'] }] } };
  check('comparison-tie shape: states both the count and the tie -> pass',
    gradeKeyFacts({ question: q, data: answer('Both invoices and service tickets are tied at 60.', { records: [{ label: 'x' }] }) }).passed);
  check('comparison-tie shape: states the count but not that it is a tie -> fail',
    !gradeKeyFacts({ question: q, data: answer('There are 60 invoices.', { records: [{ label: 'x' }] }) }).passed);
}
{
  // maintenance-due list shape - every name required, no other customer forbidden.
  const q = { keyFacts: {
    required: [{ type: 'text', value: 'Amanda Quinley' }, { type: 'text', value: 'Linda Fitzgerald' }],
    forbidden: [{ type: 'text', value: 'Karen Abernathy' }],
  } };
  check('maintenance-due shape: names the overdue customers, nobody extra -> pass',
    gradeKeyFacts({ question: q, data: answer('Overdue: Amanda Quinley and Linda Fitzgerald.', { records: [{ label: 'x' }] }) }).passed);
  check('maintenance-due shape: includes a customer who is NOT overdue -> fail',
    !gradeKeyFacts({ question: q, data: answer('Overdue: Amanda Quinley, Linda Fitzgerald, and Karen Abernathy.', { records: [{ label: 'x' }] }) }).passed);
}
{
  // financials narrative shape - a dollar total with 50-cent rounding tolerance.
  const q = { keyFacts: { required: [{ type: 'number', value: 4820.5, tolerance: 0.5 }] } };
  check('financials-number shape: rounded-to-the-dollar total -> pass',
    gradeKeyFacts({ question: q, data: answer('Total invoiced: $4,820.', { records: [{ label: 'x' }] }) }).passed);
  check('financials-number shape: a wrong total -> fail',
    !gradeKeyFacts({ question: q, data: answer('Total invoiced: $4,200.', { records: [{ label: 'x' }] }) }).passed);
}
{
  // the h167 shape: warranty status AND the separate most-recent-visit date both required.
  const q = { keyFacts: { required: [{ type: 'text', value: 'expired' }, { type: 'date', value: '2022-11-19' }, { type: 'date', value: '2022-04-25' }] } };
  check('warranty+last-visit shape: both parts answered -> pass',
    gradeKeyFacts({ question: q, data: answer('Warranty expired November 19, 2022; most recent visit April 25, 2022.', { records: [{ label: 'x' }] }) }).passed);
  check('warranty+last-visit shape: warranty status only, last visit omitted (the real h167 bug) -> fail',
    !gradeKeyFacts({ question: q, data: answer('Warranty expired November 19, 2022 (computed).', { records: [{ label: 'x' }] }) }).passed);
}

/* ============================================================== 6. calibration mode: pure aggregation only */
// Never calls a model - synthetic keyFactPassed/llmPassed pairs only (build item 2's "when both
// exist, report agreement rate"; the actual LLM call only ever happens behind offline-exam.mjs's
// explicit --calibrate CLI flag, never here).

console.log('-- calibration aggregation (no model calls) --');
{
  const rows = [
    calibrationRow('a', true, true),
    calibrationRow('b', false, false),
    calibrationRow('c', true, false),
    calibrationRow('d', false, true),
  ];
  eq('calibrationRow: agree flag set correctly', rows.map((r) => r.agree), [true, true, false, false]);
  const summary = summarizeCalibration(rows);
  eq('summarizeCalibration: n', summary.n, 4);
  eq('summarizeCalibration: agreementRate', summary.agreementRate, 0.5);
  eq('summarizeCalibration: disagreements named by id', summary.disagreements, ['c', 'd']);
}
eq('summarizeCalibration: empty input -> null rate, not NaN/crash', summarizeCalibration([]).agreementRate, null);
eq('summarizeCalibration: all-agree -> rate 1', summarizeCalibration([calibrationRow('x', true, true)]).agreementRate, 1);

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`All ${passes} checks passed.`);
process.exit(0);
