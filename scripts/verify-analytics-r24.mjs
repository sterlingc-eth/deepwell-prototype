/**
 * Round 23 (D2, E2) — new analytics coverage for field-phrasing-5.json's k139/k141/k143/k186/k187
 * cluster (handoffs/ROUND23_DONOVAN.md's own "5 real, pre-existing analytics gaps"). Pure only — no
 * database, no network, no Anthropic call. Every question here is a fresh paraphrase or negative,
 * never copied from exam.json/generalization/*.json text — see this file's own header discipline
 * (same rule field-phrasing-2/3/4/5's own gen-*.mjs scripts follow).
 *
 * Covers:
 *   1. detectBareDimensionDistinctCount (analytics/detPlan.js) — a bare "how many technicians/
 *      manufacturers ... do we have" question (no "different"/"distinct") resolves to the technician/
 *      brand dimension's own DISTINCT count, never a plain, unfiltered service-visit/equipment total
 *      that a stray "jobs"/"unit" word elsewhere in the same sentence would otherwise win.
 *   2. detectDistinctDimensionList (analytics/detPlan.js) — "which manufacturers/technicians do we
 *      ..." / "list every/all manufacturer(s)/technician(s) ..." resolves to the dimension's own
 *      plain distinct VALUES (a name list), never a per-group count breakdown or an unrelated
 *      service-visit/equipment enumeration.
 *   3. detectTechnicianHeadToHead (analytics/detPlan.js) — "has X done/logged/run/... more jobs than
 *      Y" resolves to a real two-sided technician comparison plan (never just X's own bare count,
 *      which a "yesno" grader would score as an always-truthy "yes").
 *   4. formatAnalyticsAnswer's new `headToHead`/`distinctList` branches (analytics.js) — end to end
 *      with a small in-memory row fixture, no DB: a genuine TIE grades "No", an asymmetric pair grades
 *      correctly in both directions, and a distinct-value list prints the plain names (never counts).
 *   5. isServiceVisitsQuestion's new COVERAGE_DIMENSION_WORD_RE guard (analytics.js) — "which
 *      manufacturers/technicians do we service" is a dimension-coverage question, not a real,
 *      time-scoped service-visit event, so the serviceVisits override must not fire for it (mirroring
 *      the existing geo carve-out) — while a genuine "which Trane units did we service this month"
 *      (a specific brand NAME, not the bare word "manufacturer") must still be forced to serviceVisits.
 *
 *   node scripts/verify-analytics-r24.mjs
 */
import { detectAnalyticsPlan } from '../api/_lib/analytics/detPlan.js';
import { formatAnalyticsAnswer, isServiceVisitsQuestion, validatePlan } from '../api/_lib/analytics.js';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * 1. Bare technician/brand distinct COUNT — own paraphrases of k143.
 * ====================================================================== */

const BARE_TECH_COUNT_POSITIVES = [
  'how many technicians do we have logging jobs in this system',
  'how many techs do we have on the crew',
  'how many different technicians work here', // "different" still fine, same shape
];
for (const q of BARE_TECH_COUNT_POSITIVES) {
  const p = detectAnalyticsPlan(q, null, '2026-09-25');
  eq(`k143 (own paraphrase): "${q}" -> distinct technician count`, p, {
    entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician', countDistinct: true,
  });
}
{
  const p = detectAnalyticsPlan('how many manufacturers do we carry parts for', null, '2026-09-25');
  eq('bare "how many manufacturers ..." -> distinct brand count', p, {
    entity: 'equipment', op: 'groupBy', groupBy: 'brand', countDistinct: true,
  });
}
check(
  'k143 negative: a per-technician THRESHOLD question ("more than N each") is never guessed at as a distinct count (falls through to this file\'s ordinary generic path instead, unrelated to this round\'s new detector)',
  detectAnalyticsPlan('how many technicians logged more than 50 jobs each', null, '2026-09-25')?.countDistinct !== true
);
check(
  'k143 negative: "which technician has the fewest jobs" keeps its OWN superlative shape (h115/k141), never the bare distinct count',
  detectAnalyticsPlan('which technician has the fewest jobs logged, total', null, '2026-09-25')?.superlative === 'bottom'
);

/* ======================================================================
 * 2. Distinct-value LIST — own paraphrases of k186/k187.
 * ====================================================================== */

const LIST_POSITIVES = [
  ['which manufacturers do we service, across every unit on the books', { entity: 'equipment', op: 'groupBy', groupBy: 'brand', distinctList: true }],
  ["list every technician we've got logging jobs in the system", { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician', distinctList: true }],
  ['list all our technicians', { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician', distinctList: true }],
  ['which brands do we have on the books', { entity: 'equipment', op: 'groupBy', groupBy: 'brand', distinctList: true }],
];
for (const [q, want] of LIST_POSITIVES) {
  eq(`k186/k187 (own paraphrase): "${q}" -> distinct value list`, detectAnalyticsPlan(q, null, '2026-09-25'), want);
}
check(
  'k186/k187 negative: "which manufacturer do we have the fewest units of" (h113) keeps its OWN superlative shape, never distinctList',
  detectAnalyticsPlan('which manufacturer do we have the fewest units of', null, '2026-09-25')?.superlative === 'bottom'
);
check(
  'k186/k187 negative: "which customers have Trane units" is an unrelated customer filter, not a distinct-value list',
  detectAnalyticsPlan('which customers have Trane units', null, '2026-09-25')?.entity !== 'equipment'
);

/* ======================================================================
 * 3. Technician head-to-head — own paraphrases of k139 (both directions + a tie).
 * ====================================================================== */

const HEAD_TO_HEAD_POSITIVES = [
  ['has Denise Ford done more jobs than Ray Sutton', 'Denise Ford', 'Ray Sutton'],
  ['has Wyatt Coburn logged more visits total than Kevin Pratt', 'Wyatt Coburn', 'Kevin Pratt'],
  ['did Marisol Vega run more service calls than Danny Ochoa', 'Marisol Vega', 'Danny Ochoa'],
];
for (const [q, left, right] of HEAD_TO_HEAD_POSITIVES) {
  const p = detectAnalyticsPlan(q, null, '2026-09-25');
  check(`k139 (own paraphrase): "${q}" -> head-to-head plan naming both sides`,
    p?.entity === 'serviceVisits' && p.op === 'count' && p.headToHead?.left === left && p.headToHead?.right === right &&
      p.filters?.length === 1 && p.filters[0].field === 'technician' && p.filters[0].op === 'in' &&
      JSON.stringify(p.filters[0].value) === JSON.stringify([left, right]),
    JSON.stringify(p));
}
check(
  'k139 negative: a customer-vs-customer comparison (fuzzy name matching, out of this engine\'s scope) is never mistaken for a technician comparison',
  detectAnalyticsPlan('has Rebecca Montoya had more documents than Charles Montoya', null, '2026-09-25') === null
);
check(
  'k139 negative: a brand-vs-brand comparison stays with its own dedicated engine, never the technician head-to-head shape',
  detectAnalyticsPlan('do we have more Mitsubishi units installed than Trane', null, '2026-09-25')?.headToHead === undefined
);

// R24 review: generic phrases are never treated as two technicians' names.
for (const q of [
  'has the new tech done more jobs than the old crew',
  'has our lead done more visits than another tech',
  'did a helper run more calls than my apprentice',
]) {
  check(`head-to-head negative (not names): "${q}"`, detectAnalyticsPlan(q, null, '2026-09-25')?.headToHead === undefined);
}

/* ======================================================================
 * 4. End-to-end formatting (no DB) — validatePlan -> formatAnalyticsAnswer.
 * ====================================================================== */

{
  // A genuine TIE (k139's own shape: Denise Ford and Ray Sutton both at 55) must grade "No" — never
  // the always-truthy bare-count fallback the yesno grader used to accept.
  const plan = validatePlan({
    entity: 'serviceVisits', op: 'count',
    filters: [{ field: 'technician', op: 'in', value: ['Denise Ford', 'Ray Sutton'] }],
    headToHead: { left: 'Denise Ford', right: 'Ray Sutton', leftLabel: "Denise Ford's jobs", rightLabel: "Ray Sutton's jobs" },
  });
  check('validatePlan carries headToHead through for a serviceVisits count plan', Boolean(plan?.headToHead));
  const rows = [
    ...Array.from({ length: 55 }, () => ({ technician: 'Denise Ford' })),
    ...Array.from({ length: 55 }, () => ({ technician: 'Ray Sutton' })),
  ];
  const out = formatAnalyticsAnswer(plan, { total: rows.length, rows });
  check('headToHead tie -> "No" (neither did MORE than the other), never the old always-truthy fallback',
    /^No,/.test(out.text), out.text);
  eq('headToHead tie -> both facts report the real, equal counts', out.facts.map((f) => f.value), ['55', '55']);
}
{
  // R24 review: a side with no jobs on file is never stated as "has 0 jobs" in a Yes/No comparison.
  const plan = validatePlan({
    entity: 'serviceVisits', op: 'count',
    filters: [{ field: 'technician', op: 'in', value: ['Denise Ford', 'Nobody Here'] }],
    headToHead: { left: 'Denise Ford', right: 'Nobody Here', leftLabel: "Denise Ford's jobs", rightLabel: "Nobody Here's jobs" },
  });
  const rows = Array.from({ length: 12 }, () => ({ technician: 'Denise Ford' }));
  const out = formatAnalyticsAnswer(plan, { total: rows.length, rows });
  check('headToHead with an unknown side -> honest "no jobs on file", never Yes/No', /^I don't have any jobs on file for Nobody Here/.test(out.text) && out.facts.length === 0, out.text);
}
{
  // Asymmetric, in BOTH directions.
  const planAB = validatePlan({
    entity: 'serviceVisits', op: 'count',
    filters: [{ field: 'technician', op: 'in', value: ['Wyatt Coburn', 'Ray Sutton'] }],
    headToHead: { left: 'Wyatt Coburn', right: 'Ray Sutton', leftLabel: "Wyatt Coburn's jobs", rightLabel: "Ray Sutton's jobs" },
  });
  const rowsAB = [
    ...Array.from({ length: 56 }, () => ({ technician: 'Wyatt Coburn' })),
    ...Array.from({ length: 50 }, () => ({ technician: 'Ray Sutton' })),
  ];
  check('headToHead asymmetric (left > right) -> "Yes"', /^Yes,/.test(formatAnalyticsAnswer(planAB, { total: rowsAB.length, rows: rowsAB }).text));
  const planBA = validatePlan({
    entity: 'serviceVisits', op: 'count',
    filters: [{ field: 'technician', op: 'in', value: ['Ray Sutton', 'Wyatt Coburn'] }],
    headToHead: { left: 'Ray Sutton', right: 'Wyatt Coburn', leftLabel: "Ray Sutton's jobs", rightLabel: "Wyatt Coburn's jobs" },
  });
  check('headToHead asymmetric (left < right) -> "No"', /^No,/.test(formatAnalyticsAnswer(planBA, { total: rowsAB.length, rows: rowsAB }).text));
}
{
  // distinctList: plain names, never counts, never truncated below MAX_FACT_ROWS.
  const plan = validatePlan({ entity: 'equipment', op: 'groupBy', groupBy: 'brand', distinctList: true });
  check('validatePlan carries distinctList through for a groupBy plan', Boolean(plan?.distinctList));
  const groups = [
    { key: 'Trane', count: 20 }, { key: 'Lennox', count: 18 }, { key: 'Rheem', count: 15 }, { key: 'York', count: 12 },
    { key: 'Daikin', count: 10 }, { key: 'Mitsubishi', count: 9 }, { key: 'Carrier', count: 8 }, { key: 'Goodman', count: 40 },
  ];
  const out = formatAnalyticsAnswer(plan, { total: groups.reduce((a, g) => a + g.count, 0), groups });
  eq('distinctList facts are the plain names (never a count value)', out.facts.map((f) => f.value), groups.map((g) => g.key));
  check('distinctList text names the real count of distinct values, not the summed row total',
    out.text.includes('8 brands on file'), out.text);
}

/* ======================================================================
 * 5. isServiceVisitsQuestion's new coverage-dimension guard — own paraphrases.
 * ====================================================================== */

const COVERAGE_NEGATIVES = [
  'which manufacturers do we service, across every unit on the books',
  'what brands do we service',
  'which technicians do we have logging jobs',
];
for (const q of COVERAGE_NEGATIVES) {
  check(`k186 (own paraphrase): "${q}" -> serviceVisits override does NOT fire (a dimension-coverage question, not a visit event)`,
    isServiceVisitsQuestion(q) === false);
}
const COVERAGE_STILL_TRUE = [
  'which Trane units did we service this month',
  'which units had service this month',
  'how many service calls this month',
];
for (const q of COVERAGE_STILL_TRUE) {
  check(`k186 negative: "${q}" (a real, time-scoped visit shape) still forces serviceVisits`, isServiceVisitsQuestion(q) === true);
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
