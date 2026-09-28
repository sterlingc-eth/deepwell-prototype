/**
 * Donovan Scorecard - the KEY-FACT grader (R21, L4, "rubric grader" build item).
 *
 * A deterministic, $0 alternative to the LLM rubric grader (grader.js) for the subset of `rubric`
 * exam questions whose exam-item now also carries an ADDITIVE `keyFacts` field (test-docs/scorecard/**),
 * hand-derived from the golden data (scripts/golden/golden-export.json) once per item - never from exam
 * text, never from engine internals. `keyFacts` never changes a question's `rubric`/`expected`/oracle;
 * it is a second, independent grading path that can run with the model fully blocked (see
 * scripts/offline-exam.mjs's installModelBlock), and it is intentionally STRICTER-SHAPED than the
 * free-text LLM grader: a small set of machine-checkable facts, not "does this read like a good answer".
 *
 * Shape (see any exam item's own `keyFacts` for real examples):
 *   keyFacts.required  Fact[]   every one must hold (see `factHolds`) for the answer to pass
 *   keyFacts.forbidden Fact[]   none may hold - a hit here fails the answer regardless of `required`
 *   keyFacts.order     {dates: string[]}   optional: those ISO dates must occur in the answer text in
 *                       exactly this order (earlier date at or before a later one's first occurrence) -
 *                       for "newest first" / "in order" rubric items. Only checked among dates that were
 *                       independently found present; a missing date is already a `required` failure.
 *   keyFacts.citationRequired  boolean, default true when `required` is non-empty (same "is there
 *                       something to cite" rule compare.js's `isSubstantive`/`citationRequiredFor` use for
 *                       every other comparison type - reused here via `withCitation`, not reimplemented).
 *
 *   Fact = { type: 'text'|'date'|'number', value: string|string[]|number, tolerance?: number }
 *     text    value (or, given an array, ANY one alternative) must appear in the answer, matched the
 *             same normalized way compare.js's own `hasToken`/`norm` do (case/punctuation-insensitive,
 *             whole-word) - covers names, phrases, statuses, doc types, "tied"/"agree" wording, etc.
 *     date    an ISO yyyy-mm-dd; matched via compare.js's own `datesIn` (already handles "9/10/2026",
 *             "Sep 10, 2026", "10 September 2026", ...), so a keyFacts date never has to guess the
 *             answer's own date format.
 *     number  matched via numbers found in the answer text/facts, comma-insensitive (numbersIn below),
 *             within `tolerance` (default 0) - covers counts and money (rubric text says rounding to the
 *             dollar is fine, so a money fact typically sets tolerance: 0.5).
 *
 * Nothing here touches a database or a model: `gradeKeyFacts` is pure given an /api/ask-shaped `data`
 * payload (see compare.js's `answerView`). Per-fact CITATION precision (is a stated fact's claim actually
 * backed by the text of what it cites, not just "was anything cited at all") is a separate, DB-touching
 * check the caller folds in afterwards - see scripts/offline-exam.mjs's use of citationCheck.js's
 * `checkCitationPrecision`, reused unchanged rather than duplicated here.
 */
import { escapeRegex } from '../util/escape.js';
import { answerView, norm, datesIn, withCitation, summarizeAnswer } from './compare.js';

/** Numbers in a string, comma-insensitive (same rule compare.js's own private numbersIn uses). */
export function numbersIn(s) {
  return [...String(s ?? '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((m) => Number(m[0]));
}

/** Whole-word containment after normalization (same rule compare.js's own private hasToken uses). */
export function hasToken(hayNorm, needleNorm) {
  if (!needleNorm) return false;
  return new RegExp(`(?:^| )${escapeRegex(needleNorm)}(?: |$)`).test(hayNorm);
}

/** True if `alt` (already a plain string) is present in the haystack, as a whole phrase. */
function textAltPresent(alt, hayNorm) {
  const n = norm(alt);
  if (!n) return false;
  return hasToken(hayNorm, n) || hayNorm.includes(n);
}

/**
 * Does one Fact hold against this answer? `hay` = raw (unnormalized) text+facts, for date/number
 * matching (which need the original digits/month names); `hayNorm` = its normalized form, for text
 * matching. Pure.
 */
export function factHolds(fact, hay, hayNorm) {
  if (!fact || typeof fact !== 'object') return false;
  switch (fact.type) {
    case 'date': {
      const dates = datesIn(hay);
      const alts = Array.isArray(fact.value) ? fact.value : [fact.value];
      return alts.some((v) => dates.has(String(v)));
    }
    case 'number': {
      const nums = numbersIn(hay);
      const alts = Array.isArray(fact.value) ? fact.value : [fact.value];
      const tol = Number.isFinite(fact.tolerance) ? Math.max(0, fact.tolerance) : 0;
      return alts.some((v) => { const want = Number(v); return nums.some((n) => Math.abs(n - want) <= tol); });
    }
    case 'text':
    default: {
      const alts = Array.isArray(fact.value) ? fact.value : [fact.value];
      return alts.some((v) => textAltPresent(String(v), hayNorm));
    }
  }
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** First character index `iso` (yyyy-mm-dd) occurs at in `text`, in any format `datesIn` recognizes, or -1. */
function dateOccurrenceIndex(text, iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return -1;
  const [, y, mm, dd] = m;
  const mi = Number(mm) - 1;
  if (mi < 0 || mi > 11) return -1;
  const full = MONTH_NAMES[mi];
  const abbr = full.slice(0, 3);
  const d = String(Number(dd));
  const patterns = [
    new RegExp(`\\b${y}-${mm}-${dd}\\b`),
    new RegExp(`\\b0?${Number(mm)}/0?${Number(dd)}/${y}\\b`),
    new RegExp(`\\b(?:${full}|${abbr})\\.?\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}\\b`, 'i'),
    new RegExp(`\\b0?${d}(?:st|nd|rd|th)?\\s+(?:${full}|${abbr})\\.?,?\\s+${y}\\b`, 'i'),
  ];
  let best = -1;
  for (const p of patterns) {
    const mm2 = p.exec(text);
    if (mm2 && (best === -1 || mm2.index < best)) best = mm2.index;
  }
  return best;
}

/** Pure: do `dates` (ISO strings, in the REQUIRED order) occur in `text` in that same relative order?
 *  Dates not found at all are skipped here (their absence already fails as a `required` fact). */
export function orderHolds(dates, text) {
  const idxs = (Array.isArray(dates) ? dates : []).map((d) => dateOccurrenceIndex(text, d)).filter((i) => i >= 0);
  for (let i = 1; i < idxs.length; i++) if (idxs[i] < idxs[i - 1]) return false;
  return true;
}

/** Short, stable label for a Fact, for `missingRequired`/`forbiddenFound` reporting. */
function describeFact(fact) {
  const v = Array.isArray(fact?.value) ? fact.value[0] : fact?.value;
  return `${fact?.type ?? 'text'}:${String(v ?? '').slice(0, 60)}`;
}

/**
 * Grade one `rubric` question's answer against its `keyFacts` - no DB, no model. Returns a shape
 * compatible with the other scorecard comparators (`passed`, `valueOk`, `cited`, `citationRequired`,
 * `score`, `got`, `why`, `expectedSummary`), PLUS `partialCredit` (fraction of required facts present,
 * reported separately - build item 2 asks that partial credit never loosen the strict pass/fail),
 * `missingRequired`/`forbiddenFound` (short fact labels, for a failure report), and `factsOk` (the
 * value-only verdict before citation is folded in, so a caller can tell "wrong content" apart from
 * "right content, not cited").
 *
 * @param {{keyFacts: {required?: object[], forbidden?: object[], order?: {dates: string[]}, citationRequired?: boolean}}} question
 * @param {object} data  an /api/ask-shaped answer payload
 */
export function gradeKeyFacts({ question, data }) {
  const kf = question?.keyFacts;
  if (!kf) return null;
  const view = answerView(data);
  const hay = `${view.text}\n${view.factText.join('\n')}`;
  const hayNorm = norm(hay);

  const required = Array.isArray(kf.required) ? kf.required : [];
  const forbidden = Array.isArray(kf.forbidden) ? kf.forbidden : [];

  const missing = required.filter((f) => !factHolds(f, hay, hayNorm));
  const found = forbidden.filter((f) => factHolds(f, hay, hayNorm));
  const orderOk = kf.order && Array.isArray(kf.order.dates) ? orderHolds(kf.order.dates, view.text) : true;

  const factsOk = view.kind !== 'no-answer' && missing.length === 0 && found.length === 0 && orderOk;
  const partialCredit = required.length ? Math.round(((required.length - missing.length) / required.length) * 1000) / 1000 : (factsOk ? 1 : 0);

  const why = factsOk ? '' : [
    missing.length ? `missing: ${missing.map(describeFact).join('; ')}` : '',
    found.length ? `forbidden fact stated: ${found.map(describeFact).join('; ')}` : '',
    !orderOk ? 'dates not in the required order' : '',
    view.kind === 'no-answer' ? 'no answer' : '',
  ].filter(Boolean).join(' | ');

  const base = { passed: factsOk, score: factsOk ? 1 : 0, got: summarizeAnswer(view), why };
  // Reuse compare.js's own citation rule verbatim (isSubstantive/citationRequiredFor via withCitation) -
  // "is there something concrete to cite" is exactly `required.length > 0`, unless the item overrides it.
  const q = { cmp: 'rubric', citationRequired: kf.citationRequired, expected: required.length ? ['keyfacts'] : null };
  const withCite = withCitation(base, q, view);

  return {
    ...withCite,
    expectedSummary: `keyFacts: ${required.length} required, ${forbidden.length} forbidden${kf.order ? ', ordered' : ''}`,
    partialCredit,
    missingRequired: missing.map(describeFact),
    forbiddenFound: found.map(describeFact),
    factsOk,
  };
}

/* ============================================================================================
 * CALIBRATION MODE (build item 2's "when both exist, report agreement rate"): compares this
 * deterministic verdict against the LLM grader's (grader.js's `gradeRubric`) verdict for the SAME
 * question/answer, once credits are back. Pure aggregation only - never calls a model itself; the
 * caller (scripts/offline-exam.mjs's optional --calibrate path) is responsible for actually invoking
 * `gradeRubric` (unchanged, still model-gated) and passing its `passed` in here alongside ours.
 * ============================================================================================ */

/** One question's two verdicts -> did they agree? Pure. */
export function calibrationRow(id, keyFactPassed, llmPassed) {
  return { id, keyFactPassed: Boolean(keyFactPassed), llmPassed: Boolean(llmPassed), agree: Boolean(keyFactPassed) === Boolean(llmPassed) };
}

/** Aggregate a list of `calibrationRow` results into an agreement rate + the disagreements, for a report. */
export function summarizeCalibration(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const disagreements = list.filter((r) => !r.agree).map((r) => r.id);
  return {
    n: list.length,
    agree: list.length - disagreements.length,
    agreementRate: list.length ? Math.round(((list.length - disagreements.length) / list.length) * 1000) / 1000 : null,
    disagreements,
  };
}
