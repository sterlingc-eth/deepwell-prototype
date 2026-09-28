/**
 * Round 20 (J1) — THE #1 PROBLEM: false confidence. r19_blind3_clusters.json's F1 cluster (25 wrong ids):
 * a novel filter/aggregate phrasing the deterministic layer doesn't fully recognize gets silently matched
 * to an UNRELATED template (usually a bare, unfiltered portfolio total) and answered with total confidence
 * instead of returning null so the chain falls through. The fix isn't a per-question patch — it's a GENERAL
 * mechanism: parse every constraint the QUESTION states, and (in guard/check.js) refuse to send an answer
 * that didn't visibly account for one of them.
 *
 * This module is the question-side half: a pure, deterministic parse of a question into typed constraints.
 * Deliberately built on TOP of the constraint detectors this codebase already has and already trusts —
 * detectedConditions (analytics.js) already recognizes email/phone/brand/county/city/state/zip/month/money/
 * maintenance/warranty/serviceType/a cross-visit relation/a ratio, each from its own already-tuned regex or
 * known-vocabulary list (KNOWN_AZ_CITY_NAMES, BRAND_WORDS, ...) — reused here verbatim, never re-implemented,
 * so this file can never drift from what routes/analytics.js's own missingConditions already agrees is a
 * real, detectable condition. What's ADDED here is the handful of constraint shapes detectedConditions has
 * no notion of at all (it only ever feeds an analytics FILTER-field check): a negated quantity ("zero
 * documents of any kind"), a numeric comparator/threshold ("more than 30 days", "at least two"), a
 * DISTINCT/uniqueness request, a superlative naming a specific date-ish field ("the earliest warranty
 * registration date"), and a named customer/business entity (tenant's own vocabulary first, a generic
 * "for the <Name> account" phrasing as a fallback for a tenant vocab miss).
 *
 * No I/O, no DB, no model call — pure string/regex matching over the question text (+ the tenant's own
 * already-fetched vocabulary, when the caller has one). Every detector here is intentionally narrow (a
 * handful of unambiguous, load-bearing phrasings) rather than a broad NLP guess: a false NEGATIVE here just
 * means the guard (check.js) has one less signal to work with for that question (today's status quo,
 * unchanged); a false POSITIVE would make the guard refuse to send a perfectly good answer, which is exactly
 * the failure mode the "zero correct->needs-model flips" floor (R20_CONTRACT.md) exists to catch — see
 * scripts/verify-precision-guard.mjs's own negative-phrasing checks for why each regex stops where it does.
 */
import { detectedConditions, resolveAnyTimeRange, CONDITION_CROSS_VISIT_RELATION, CONDITION_RATIO } from '../../analytics.js';

/** "zero documents of any kind", "no purchase orders at all", "not a single invoice on file" — a quantity
 *  the question itself asserts should be ZERO (an existence/count negation), distinct from a plain "no
 *  email on file" polarity filter (already 'email' via detectedConditions) — this is about the COUNT of
 *  matching rows being asserted zero, which no FILTER_FIELDS entry expresses; a plan that answers a plain
 *  positive total for a question shaped like this dropped the negation entirely. Deliberately requires one
 *  of a small closed set of trailing phrases (on file / at all / of any kind / whatsoever / on record) right
 *  after the negated noun span so a plain "no" used as ordinary conversational filler ("no, how many...")
 *  can never fire this — see verify-precision-guard.mjs's own negative-phrasing checks.
 */
const NEGATION_OF_COUNT_RE =
  /\b(?:zero|none|not (?:a|even a) single|not one)\b[\s\S]{0,45}\b(?:on file|at all|of any kind|whatsoever|on record)\b/i;

/** A numeric comparator/threshold naming a number the plan must filter by — "more than 30 days", "at least
 *  two", "longer than 30 days after install", "fewer than 3", "over 90 days", "more than one unit". A
 *  spelled-out small number (one..twelve — the same closed word list scorecard/compare.js's own
 *  NUMBER_WORDS already trusts) counts as a number here too. Deliberately requires the comparator word AND
 *  a number within a short window of each other (never a bare "more" with no number anywhere near it) so
 *  an unrelated "more" elsewhere in the sentence can't fire this. */
const NUMBER_WORD_ALT = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const COMPARATOR_RE = new RegExp(
  `\\b(?:more than|less than|fewer than|at least|at most|over|under|longer than|greater than|within)\\b` +
    `(?:\\s+\\S+){0,4}?\\s+(?:\\d+|${NUMBER_WORD_ALT})\\b`,
  'i'
);

/** "how many DISTINCT document types", "how many unique brands", "how many different types of
 *  documents" — a DISTINCT-count request, structurally different from a plain count of rows (see
 *  check.js's mentionsDistinctness, which requires the ANSWER to actually say "type"/"distinct"/"unique"/
 *  "kind" back before this is considered consumed). */
const DISTINCT_RE = /\b(?:distinct|unique|different (?:types?|kinds?))\b/i;

/** A superlative ("earliest"/"latest"/"oldest"/"newest"/"first"/"last") naming a date-ish field right
 *  alongside it — "the earliest warranty registration date", "the latest install", "our first customer" —
 *  a request for an EXTREME VALUE (a MIN/MAX), which a bare count answer structurally can never satisfy (see
 *  check.js's hasDateShapedValue). Both halves are required AND must be near each other (at most one filler
 *  word between them, either order): checking the two word-lists independently anywhere in the question
 *  false-positived on ordinary time phrasing that merely CO-OCCURS with an unrelated field word — e.g. "how
 *  many warranty jobs were completed last month" has both "warranty" and "last" but is a plain time-filtered
 *  count, not a request for an extreme date, and got wrongly blocked by guard/check.js's superlative check
 *  (no date-shaped value in a correct bare-count answer). A bare "last" with no date-ish word nearby is
 *  usually "last visit"/ordinary phrasing already covered by other routers, not this shape — see
 *  verify-precision-guard.mjs's own negative checks (e.g. "who was the last technician out" must NOT match).
 */
const SUPERLATIVE_WORD_ALT = 'earliest|latest|oldest|newest|first|last';
const SUPERLATIVE_FIELD_ALT = 'date|registration|registered|install(?:ed|ation)?|expir\\w*|warranty';
const SUPERLATIVE_RE = new RegExp(
  `\\b(?:${SUPERLATIVE_WORD_ALT})\\b(?:\\s+\\S+){0,1}\\s+\\b(?:${SUPERLATIVE_FIELD_ALT})\\b` +
    `|\\b(?:${SUPERLATIVE_FIELD_ALT})\\b(?:\\s+\\S+){0,1}\\s+\\b(?:${SUPERLATIVE_WORD_ALT})\\b`,
  'i'
);

/** A TIME-WINDOW phrase — "last year", "this month", "next quarter", "so far this year" — never a
 *  superlative-over-a-date request even though it shares the bare word "last"/"this"/"next" with
 *  SUPERLATIVE_WORD_ALT. i002 ("how many units did we install last year"): SUPERLATIVE_RE's own
 *  FIELD-then-WORD branch matched "install" immediately followed by "last" (zero filler words between
 *  them) and mis-read the trailing "year" as if it were naming an extreme-VALUE request ("the last
 *  install[ation]") instead of what it actually is — a plain, already-handled time window (this file's
 *  own 'month' constraint two lines above, resolveAnyTimeRange/detectedConditions' own vocabulary) — and
 *  sent a perfectly answerable count to needs-model. Masked out of the text SUPERLATIVE_RE tests against
 *  (not deleted from `q` itself — every other detector in this file still sees the real question) so
 *  "install last year" can never satisfy the WORD+FIELD adjacency test, while "the last install[ation]
 *  date" (an actual superlative, no time unit right after "last") is untouched. See
 *  verify-precision-guard.mjs for the false-positive regression (i002 and this file's own paraphrases) and
 *  the true-positive case ("the latest install date this year" still fires) it must never weaken. */
const TIME_WINDOW_PHRASE_RE = /\b(?:last|this|next)\s+(?:year|month|week|quarter|season)\b|\bso\s+far\s+this\s+year\b/gi;
function maskTimeWindows(q) {
  return q.replace(TIME_WINDOW_PHRASE_RE, (m) => ' '.repeat(m.length));
}

/** A named customer/business account mentioned generically ("for the Amy Isaacson account", "on file for
 *  the Bracken job", "at the Sonoran Grill account") — a fallback for when the caller has no tenant
 *  vocabulary (or the tenant vocab lookup missed this exact name): titlecase word(s) immediately before
 *  "account"/"customer"/"business", or immediately after "for the"/"for" + "'s". Deliberately narrow (this
 *  codebase's own address/customer detectors already handle the address-shaped case; this is only for the
 *  "<Name> account" phrasing decompose's own clause vocabulary has no way to ever filter by). */
const ACCOUNT_NAME_RE =
  /\bfor (?:the )?([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})(?:'s)?\s+(?:account|customer|business)\b/;

/**
 * question -> [{type, value?}], one entry per DISTINCT constraint type detected (never a duplicate type).
 * `opts.tenantVocab` (vocab/tenantVocab.js's getTenantVocab result, optional): widens named-entity detection
 * to this tenant's own customer names actually on file — the same glossary correctTenantNameTypos already
 * trusts. Types line up 1:1 with detectedConditions' own tokens where they overlap ('email', 'phone',
 * 'brand', 'county', 'city', 'state', 'zip', 'money', 'maintenance', 'warranty', 'month', 'serviceType', the
 * two CONDITION_* relation/ratio constants) plus this file's five additions: 'negation', 'comparator',
 * 'distinct', 'superlative', 'namedEntity'.
 */
export function extractConstraints(question, opts = {}) {
  const q = String(question ?? '');
  const found = new Map();
  for (const c of detectedConditions(q)) found.set(c, { type: c });
  // 'month' is analytics.js's own name for "the question names a time window" (this month/this
  // year/so far this year/since 2024/...); resolveAnyTimeRange is the single source of truth it's
  // already built from, reused verbatim here so a window this file recognizes can never disagree
  // with what detectedConditions/missingConditions already agree is a real time window.
  if (!found.has('month') && resolveAnyTimeRange(q) != null) found.set('month', { type: 'month' });
  if (NEGATION_OF_COUNT_RE.test(q)) found.set('negation', { type: 'negation' });
  if (COMPARATOR_RE.test(q)) found.set('comparator', { type: 'comparator' });
  if (DISTINCT_RE.test(q)) found.set('distinct', { type: 'distinct' });
  if (SUPERLATIVE_RE.test(maskTimeWindows(q))) found.set('superlative', { type: 'superlative' });

  const tenantVocab = opts?.tenantVocab;
  let namedEntity = null;
  // Customer names first, then technician names (vocab/tenantVocab.js's own glossary carries both) — a
  // bare "how many jobs has Denise Ford closed out" names a TECHNICIAN just as concretely as "for the Amy
  // Isaacson account" names a customer, and an answer that dropped it the same way (a portfolio-wide
  // "You have 317 service visits." with no mention of the technician at all) is the identical F1 shape.
  const namePhrases = [
    ...(tenantVocab?.customers?.phrases ?? []),
    ...(tenantVocab?.technicians?.phrases ?? []),
  ];
  if (namePhrases.length) {
    const lowerQ = q.toLowerCase();
    // Longest name first: a tenant with both "Amy Isaacson" and "Amy Isaacson Salon" on file must
    // match the more specific one when both would otherwise fire.
    const sorted = [...new Set(namePhrases)].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      if (name.length < 4) continue;
      if (lowerQ.includes(name.toLowerCase())) { namedEntity = name; break; }
    }
  }
  if (!namedEntity) {
    const m = q.match(ACCOUNT_NAME_RE);
    if (m) namedEntity = m[1];
  }
  if (namedEntity) found.set('namedEntity', { type: 'namedEntity', value: namedEntity });

  return [...found.values()];
}

export { CONDITION_CROSS_VISIT_RELATION, CONDITION_RATIO };
