/**
 * relations/normalize.js — Round 14 (K4). A tiny, pure typo-tolerance shim shared by
 * relations/questions.js's and decompose/clauses.js's own classifiers.
 *
 * ask.js's own fuzzy-typo correction (nlNormalize.js's normalizeQuestion) already fixes MOST of the
 * generic English typos the exam's own "-typo"/"-abbreviated" variants throw at a question ("custs" ->
 * "customers", "casa grade" -> "casa grande", "e-mail" -> "email", "mo" -> "month") — but ask.js only ever
 * runs it for the analytics planner (line ~832's `normalizedForAnalytics`), never before the relations/
 * decompose classifiers (line ~804/831 both classify the RAW question). Rather than depending on an ask.js
 * change (out of scope for this file's owner), every classifier here tries the RAW question first (so an
 * already-correct question never pays any normalization cost or risks a false correction) and, only if
 * that fails, a NORMALIZED candidate built from the same shared utility.
 *
 * Two independent gaps in that shared utility, discovered against this round's own typo variants, are
 * patched HERE rather than in nlNormalize.js (out of scope for this file's owner):
 *   1. normalizeQuestion's own generic vocabulary fixes "yrs"/"yr" -> "years" but not a same-length
 *      TRANSPOSITION typo of "years" itself ("yeasr") — nor "breakdown"/"group", which its base vocabulary
 *      doesn't carry at all ("breakdoxn", "grovp"). correctTriggerWordTypos (also exported by
 *      nlNormalize.js, the same utility deterministicRouter.js/maintenanceDue.js already use for their own
 *      trigger words) fixes exactly this class of typo against an explicit, closed word list — applied
 *      BEFORE normalizeQuestion so its own abbreviation expansion still runs afterward.
 *   2. normalizeQuestion's generic corrector has a known false-positive collision: "older" (not itself in
 *      its base vocabulary) gets "corrected" to the real word "order" ("units older than" -> "units order
 *      than"), which silently breaks every age-window regex. "older" is shielded with a placeholder before
 *      normalizeQuestion runs and restored after — the ONLY token this file special-cases, because it is
 *      the one collision actually observed against this corpus's own question set, not a guess.
 */
import { normalizeQuestion, correctTriggerWordTypos } from '../nlNormalize.js';

// Closed, explicit list — every word one of THIS file's own regexes (relations/questions.js,
// decompose/clauses.js) keys off that a single-letter/transposition typo could plausibly hit in the exam's
// own "-typo" variants. Never the exam's own question text or ids — just the vocabulary the regexes need.
const TRIGGER_WORDS = [
  'years', 'warranty', 'warranties', 'customers', 'customer', 'email', 'calls', 'call', 'units', 'unit',
  'group', 'breakdown', 'permit', 'permits', 'tickets', 'orders', 'percent', 'tracking', 'missing',
  'lapsed', 'invoice', 'invoices', 'invoiced', 'quoted', 'quote', 'replacement', 'replaced', 'repairs',
  'installed', 'installs', 'installation', 'technicians', 'technician', 'address', 'addresses', 'capacitor',
  'contactor', 'thermostat',
];

const OLDER_PLACEHOLDER = '§OLDER§';

/** question -> [raw, ...normalized candidates] (deduped, raw always first) for a classifier to try in
 *  order, stopping at the first one that matches. Pure — no db, no model. */
export function classifyCandidates(question) {
  const raw = String(question ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  // "e-mail"/"e mail" -> "email": a plain, unambiguous English spelling variant, fixed BEFORE
  // correctTriggerWordTypos runs so "mail" (a real, unrelated word) is never tokenized on its own and
  // "corrected" into "e-email".
  const emailFixed = raw.replace(/\be[\s-]mail\b/gi, 'email');
  const triggerFixed = correctTriggerWordTypos(emailFixed, TRIGGER_WORDS);
  const shielded = triggerFixed.replace(/\bolder\b/gi, OLDER_PLACEHOLDER);
  let normalized;
  try {
    normalized = normalizeQuestion(shielded).normalized.replace(new RegExp(OLDER_PLACEHOLDER, 'gi'), 'older');
  } catch {
    normalized = triggerFixed;
  }
  return [...new Set([raw, triggerFixed, normalized])];
}

/** Runs `classify` (a pure question -> intent-or-null function) against classifyCandidates(question) in
 *  order and returns the first non-null result. */
export function classifyWithTypoTolerance(question, classify) {
  for (const candidate of classifyCandidates(question)) {
    const hit = classify(candidate);
    if (hit) return hit;
  }
  return null;
}
