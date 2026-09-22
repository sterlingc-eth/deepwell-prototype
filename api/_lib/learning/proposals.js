/**
 * Donovan self-learning loop, Tier 2 Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
 * the strict, closed-vocabulary schema every learning proposal must satisfy
 * before it is ever stored, verified against the routing bank, or shown to
 * an operator for a decision. Pure — no DB, no model, no I/O — so this is
 * directly testable (scripts/verify-learning.mjs) exactly like
 * api/_lib/analytics.js's validatePlan is.
 *
 * Same "the model never invents a word" discipline the rest of Donovan's
 * training plan uses: a learned abbreviation/typo may only map a NEW token
 * INTO vocabulary the system already trusts (nlNormalize.js's own VOCAB —
 * every entity synonym, HVAC brand, city/county/state and month name), never
 * invent a brand-new word on either side. A synonym proposal is the one kind
 * allowed to add a genuinely new word, because that IS the point of it —
 * teaching Donovan a new plain-English name for an entity it already has a
 * closed vocabulary for.
 *
 * Five kinds (payload shape in parentheses):
 *   abbreviation  {from, to}   — e.g. "hoas" -> "homeowners"
 *   typo          {from, to}   — e.g. "waranty" -> "warranty"
 *   synonym       {entity, word} — e.g. entity "equipment", word "hvac"
 *   few_shot      {question, plan} — a question -> analytics_plan pair
 *   capability_gap {title, example, note} — informational only, never
 *                  turned into an overlay entry (see learning/overlay.js's
 *                  rowsToOverlay, which simply ignores this kind)
 */
import { VOCAB } from '../nlNormalize.js';
import { ENTITY_SYNONYMS, validatePlan, looksLikeSingleRecordReference } from '../analytics.js';

export const PROPOSAL_KINDS = ['abbreviation', 'typo', 'synonym', 'few_shot', 'capability_gap'];

const WORD_RE = /^[a-z0-9&#]{2,30}$/;
const MAX_TEXT_FIELD = 300;

/** Every 2-letter USPS state code (lower-case) — a learned `from` word must
 *  never shadow one of these ("or" is both a state code AND a common
 *  stopword; either check alone would catch it, both are kept for clarity). */
const US_STATE_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
  'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt',
  'va', 'wa', 'wv', 'wi', 'wy', 'dc',
]);

/** Street-suffix words (nlNormalize.js's own STREET_SUFFIX_WORD_RE list,
 *  duplicated rather than imported — that regex isn't exported, and this is
 *  six words, not worth changing that file's own surface for). A learned
 *  `from` word must never be one of these: "st"/"dr"/"ave" et al. show up in
 *  nearly every street address, and blindly expanding one would corrupt an
 *  address the same way nlNormalize.js's own doc comment already warns
 *  against for "st"/"hvac" in the base ABBREV table. */
const STREET_SUFFIX_WORDS = new Set([
  'ave', 'avenue', 'rd', 'road', 'st', 'street', 'blvd', 'boulevard', 'dr', 'drive',
  'ln', 'lane', 'ct', 'court', 'way', 'cir', 'circle', 'hwy', 'pkwy', 'pl', 'ter',
]);

/** A small, closed set of common English function words — a learned `from`
 *  word must never be one of these, the same "never shadow a load-bearing
 *  word" reasoning analytics.js's own EXTRA_DOMAIN_WORDS comment gives for
 *  why "which"/"count"/"total" had to be ADDED to vocab rather than left
 *  correctable. */
// Exported (Part B, handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md): proposer.js
// reuses this SAME set at candidate-GENERATION time — a false-positive typo
// candidate like "many" -> "may" (the month) is schema-valid (neither word is
// a stopword collision this file originally guarded, since "many"/"much"
// weren't in this list) but obviously wrong; generating it at all is wasted
// verification work even though verifyProposalLive would likely catch it via
// a routing-bank regression eventually. Better for both sides to share one
// canonical "never touch these" list than risk it drifting into two.
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'as',
  'by', 'from', 'but', 'not', 'no', 'so', 'if', 'then', 'than', 'we', 'you', 'they', 'he',
  'she', 'i', 'my', 'your', 'our', 'their', 'his', 'her', 'do', 'does', 'did', 'has', 'have',
  'had', 'will', 'would', 'can', 'could', 'should', 'what', 'who', 'which', 'how', 'when',
  'where', 'why', 'all', 'any', 'some', 'each', 'few', 'more', 'most', 'other', 'such',
  'only', 'own', 'same', 'too', 'very', 'just',
  // Live gap (2026-09-22, found by scripts/verify-learning.mjs's own
  // deterministic-proposer test): "many"/"much" are exactly as common and
  // load-bearing in a dispatcher question ("how MANY customers...") as
  // "which"/"how" above, and "many" sits one deletion away from the month
  // name "may" — without this, deterministicCandidatesForQuestion proposed
  // "many" -> "may" on almost any counting question.
  'many', 'much',
]);

function isWordFormat(s) {
  return typeof s === 'string' && WORD_RE.test(s);
}

function normalizeWord(s) {
  return String(s ?? '').trim().toLowerCase();
}

/** The shared "from" guard for abbreviation/typo: format-valid, and not
 *  already one of the closed set of words a learned correction is never
 *  allowed to shadow (existing vocab, a state code, a street-suffix word, a
 *  stopword). */
function validFromWord(from) {
  if (!isWordFormat(from)) return false;
  if (VOCAB.has(from)) return false;
  if (US_STATE_CODES.has(from)) return false;
  if (STREET_SUFFIX_WORDS.has(from)) return false;
  if (STOPWORDS.has(from)) return false;
  return true;
}

/** The shared "to" guard: must land INTO vocabulary the pipeline already
 *  trusts. VOCAB (nlNormalize.js) already carries every entity synonym,
 *  brand, city/county/state and month name — so this one check is exactly
 *  "a known city/brand/entity word" from the brief. */
function validToWord(to) {
  return isWordFormat(to) && VOCAB.has(to);
}

function validateAbbreviationOrTypo(kind, payload) {
  const from = normalizeWord(payload?.from);
  const to = normalizeWord(payload?.to);
  if (!validFromWord(from)) {
    return {
      ok: false,
      reason: `${kind}: "from" must be a new 2-30 char lowercase word (letters/digits/&/# only) that is not already known vocabulary, a US state code, a street-suffix word, or a common stopword`,
    };
  }
  if (!validToWord(to)) {
    return { ok: false, reason: `${kind}: "to" must already be known vocabulary (a real entity/brand/city/county/state/month word) — never a new word` };
  }
  if (from === to) return { ok: false, reason: `${kind}: "from" and "to" must differ` };
  return { ok: true, proposal: { kind, payload: { from, to } } };
}

function validateSynonym(payload) {
  const entity = normalizeWord(payload?.entity);
  const word = normalizeWord(payload?.word);
  if (!Object.prototype.hasOwnProperty.call(ENTITY_SYNONYMS, entity)) {
    return { ok: false, reason: `synonym: "entity" must be one of ${Object.keys(ENTITY_SYNONYMS).join('/')}` };
  }
  if (!isWordFormat(word)) {
    return { ok: false, reason: 'synonym: "word" must be a 2-30 char lowercase word (letters/digits/&/# only)' };
  }
  if ((ENTITY_SYNONYMS[entity] ?? []).includes(word)) {
    return { ok: false, reason: `synonym: "${word}" is already a known synonym for ${entity}` };
  }
  return { ok: true, proposal: { kind: 'synonym', payload: { entity, word } } };
}

function validateFewShot(payload) {
  const question = String(payload?.question ?? '').trim();
  if (!question || question.length > MAX_TEXT_FIELD) {
    return { ok: false, reason: `few_shot: "question" must be a non-empty string up to ${MAX_TEXT_FIELD} chars` };
  }
  if (looksLikeSingleRecordReference(question)) {
    return { ok: false, reason: 'few_shot: "question" must not be a single-record reference (address/serial/named-record) — those are never planned' };
  }
  const validated = validatePlan(payload?.plan);
  if (!validated) {
    return { ok: false, reason: 'few_shot: "plan" must be a valid analytics_plan (see analytics.js\'s validatePlan)' };
  }
  return { ok: true, proposal: { kind: 'few_shot', payload: { question, plan: validated } } };
}

function validateCapabilityGap(payload) {
  const title = String(payload?.title ?? '').trim();
  const example = String(payload?.example ?? '').trim();
  const note = String(payload?.note ?? '').trim();
  if (!title || title.length > MAX_TEXT_FIELD) return { ok: false, reason: `capability_gap: "title" must be a non-empty string up to ${MAX_TEXT_FIELD} chars` };
  if (!example || example.length > MAX_TEXT_FIELD) return { ok: false, reason: `capability_gap: "example" must be a non-empty string up to ${MAX_TEXT_FIELD} chars` };
  if (note.length > MAX_TEXT_FIELD) return { ok: false, reason: `capability_gap: "note" must be at most ${MAX_TEXT_FIELD} chars` };
  // Informational only: never turned into an overlay entry (see
  // learning/overlay.js's rowsToOverlay) — no vocabulary/plan check applies.
  return { ok: true, proposal: { kind: 'capability_gap', payload: { title, example, note } } };
}

/**
 * Strict, closed validation for one proposed learning item. Never throws;
 * rejects with a human-readable `reason` string a caller can log or show an
 * operator. Returns `{ ok: true, proposal: { kind, payload } }` with the
 * payload normalized (lowercased, plan re-validated/canonicalized) on
 * success.
 */
export function validateProposal(kind, payload) {
  if (!PROPOSAL_KINDS.includes(kind)) {
    return { ok: false, reason: `unknown proposal kind "${kind}"` };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: `${kind}: payload must be an object` };
  }
  switch (kind) {
    case 'abbreviation':
    case 'typo':
      return validateAbbreviationOrTypo(kind, payload);
    case 'synonym':
      return validateSynonym(payload);
    case 'few_shot':
      return validateFewShot(payload);
    case 'capability_gap':
      return validateCapabilityGap(payload);
    default:
      return { ok: false, reason: `unknown proposal kind "${kind}"` };
  }
}
