/**
 * Donovan self-learning loop, Tier 2 Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
 * the verification engine. Pure — no DB, no model, no network — everything
 * it needs (the miss questions a proposal claims to fix, the routing bank,
 * the negative set) is handed in by the caller. See
 * scripts/verify-learning.mjs for the unit tests, and
 * scripts/gen-question-bank.mjs for how test-docs/question-bank/
 * routing-bank.json (loadRoutingBank's default source) is built.
 *
 * A proposal only ever reaches this file after api/_lib/learning/
 * proposals.js's validateProposal has already accepted it — this is the
 * SECOND gate: static schema validation can't know that, say, a learned
 * abbreviation "main" -> "arizona" would silently corrupt every "1234 Main
 * St" address token it ever touches. That's a live-behavior regression only
 * the routing bank can catch, which is exactly what step (c) below is for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeQuestion } from '../nlNormalize.js';
import { preClassifyAnalytics, looksLikeSingleRecordReference, isMoneyQuestion, detectedConditions } from '../analytics.js';
import { parseContactLookupQuestion } from '../contactLookup.js';

/**
 * Builds a fresh, one-item overlay object from a single CANDIDATE proposal —
 * the same shape learning/overlay.js's getActiveOverlay() builds from every
 * approved row, but for exactly one not-yet-approved proposal. Always a NEW
 * object (never the shared process-wide active overlay), so verifying one
 * proposal can never leak into, or be affected by, verifying another one —
 * see nlNormalize.js/analytics.js's own per-object overlay caches, which key
 * off object identity for exactly this reason.
 */
export function overlayFromProposal(proposal) {
  const overlay = { abbreviations: {}, typos: {}, vocab: [], synonyms: {}, fewShot: [] };
  const kind = proposal?.kind;
  const payload = proposal?.payload;
  if (!payload) return overlay;
  switch (kind) {
    case 'abbreviation':
      if (payload.from && payload.to) overlay.abbreviations[payload.from] = payload.to;
      break;
    case 'typo':
      if (payload.from && payload.to) overlay.typos[payload.from] = payload.to;
      break;
    case 'synonym':
      if (payload.entity && payload.word) {
        overlay.synonyms[payload.entity] = [payload.word];
        overlay.vocab = [payload.word];
      }
      break;
    case 'few_shot':
      if (payload.question && payload.plan) overlay.fewShot = [{ question: payload.question, plan: payload.plan }];
      break;
    default:
      // capability_gap and anything unrecognized: no overlay effect at all —
      // matches learning/overlay.js's own rowsToOverlay, which ignores it too.
      break;
  }
  return overlay;
}

/** A/L/R/U route classification, computed the SAME way api/ask.js's own
 *  routing gate is ordered (money/maintenance honest fallback first, then
 *  contact lookup, then a genuine single-record reference, then analytics) —
 *  see that file's own call-site comments for why this exact order matters:
 *  looksLikeSingleRecordReference is deliberately NOT overlay-aware (it keys
 *  off the RAW, un-normalized text), so no learned overlay can ever cause a
 *  real single-record question to be reclassified as analytics — the same
 *  guarantee production code gets from checking it before
 *  preClassifyAnalytics. `overlay` may be null/undefined for a baseline
 *  (no-overlay) classification. */
function classifyRoute(text, overlay) {
  const { normalized } = normalizeQuestion(text, { overlay });
  const conditions = detectedConditions(normalized);
  if (isMoneyQuestion(normalized) || conditions.has('maintenance')) return 'U';
  if (parseContactLookupQuestion(text, { overlay })) return 'L';
  if (looksLikeSingleRecordReference(text)) return 'R';
  if (preClassifyAnalytics(normalized, { overlay })) return 'A';
  return 'R';
}

/** Two deliberate leniencies, both mirroring scripts/verify-question-bank.mjs's
 *  own scoring (never inventing a stricter bar than the tool this whole
 *  engine is meant to match):
 *   - expected 'U' (unsupported-honest) passes on live 'U' OR 'A' — most
 *     U-coded bank entries are structurally analytics-SHAPED questions that
 *     only turn into an honest fallback once a real plan is executed against
 *     the DB (missingConditions/isMoneyQuestion, analytics.js), which this
 *     offline, DB-free check can't see either way.
 *   - expected 'L' or 'R' (lookup/contact vs. a bare single-record reference)
 *     passes on EITHER live code — verify-question-bank.mjs's own `classify`
 *     scores a 'lookup' entry as a pass on contactLookup OR singleRecord,
 *     whichever actually fires, never demanding one specific one.
 *  The one code this is never lenient about is 'A' (a real, supported
 *  analytics answer) — that's the family this whole engine exists to protect
 *  from a bad overlay silently costing (or gaining) a real analytics route. */
function routePasses(liveCode, expectedCode) {
  if (liveCode === expectedCode) return true;
  if (expectedCode === 'U' && (liveCode === 'A' || liveCode === 'U')) return true;
  if ((expectedCode === 'L' || expectedCode === 'R') && (liveCode === 'L' || liveCode === 'R')) return true;
  return false;
}

/** Step (b): a miss question "now routes where a human would expect" means
 *  it reaches SOME real handler — contact lookup, a genuine single-record
 *  reference, or the analytics classifier — rather than falling all the way
 *  through unrouted. Checked directly against the three positive detectors
 *  (not via classifyRoute's code, which folds money/maintenance in as 'U'
 *  too broadly for this purpose). */
function missIsRouted(question, overlay) {
  const { normalized } = normalizeQuestion(question, { overlay });
  return (
    Boolean(parseContactLookupQuestion(question, { overlay })) ||
    looksLikeSingleRecordReference(question) ||
    preClassifyAnalytics(normalized, { overlay })
  );
}

/** R7 learning-quality guardrail (coordinator ask, 2026-09-25): a learned abbreviation/typo's "from"
 *  word must never equal a real customer/contact/technician name, or a token of one — the bug
 *  report: typo "vega" -> "vegas" would silently rewrite the real customer surname "Vega" every time
 *  it appears, because "Vega" alone is schema-valid (no vocab/stopword collision proposals.js's own
 *  checks would catch). Pure: `nameTokens` (a lower-cased Set of words drawn from customer/technician
 *  names on file) is supplied by the caller — the one DB read this rule needs stays OUT of this file
 *  (learning/sweep.js and learning/examGate.js each read it, tenant-scoped, and pass it in), so
 *  verify.js itself stays DB-free exactly as its own doc comment above promises. A missing/absent
 *  `nameTokens` is a no-op (this rule simply doesn't fire), never a rejection. */
export function proposalShadowsEntityName(proposal, nameTokens) {
  if (!nameTokens || typeof nameTokens.has !== 'function') return false;
  if (proposal?.kind !== 'abbreviation' && proposal?.kind !== 'typo') return false;
  const from = String(proposal?.payload?.from ?? '').trim().toLowerCase();
  return Boolean(from) && nameTokens.has(from);
}

/**
 * The verification engine. Returns
 * `{ ok, reasons[], missFixed: {fixed,total}, bankPass, bankTotal, regressions[], negativesPass }`.
 *
 *   (a) apply the overlay (overlayFromProposal, above — done implicitly by
 *       passing `{ overlay }` to every overlay-aware function below).
 *   (b) every named miss question must now be routed somewhere real.
 *   (c) the ENTIRE routing bank must show 0 regressions vs. the no-overlay
 *       baseline — a regression is either a bank entry that PASSED at
 *       baseline and now fails, or (for an 'R'/'L' — single-record/lookup —
 *       entry) the normalized text itself changing at all, which can only
 *       mean the overlay silently rewrote a word inside a real name/address
 *       (nlNormalize.js's own stated invariant is that it never touches
 *       those tokens; an overlay that breaks that invariant is a regression
 *       even if the coarse route code happens to survive).
 *   (d) the fixed negative set must stay non-analytics.
 *   (e) (R7) the proposal must not shadow a real entity name (proposalShadowsEntityName, above) —
 *       only fires when the caller passes `nameTokens`.
 */
export function verifyProposal(proposal, { missQuestions = [], routingBank = [], negatives = [], nameTokens = null } = {}) {
  if (!proposal || !proposal.kind || !proposal.payload) {
    return { ok: false, reasons: ['invalid proposal'], missFixed: { fixed: 0, total: 0 }, bankPass: 0, bankTotal: 0, regressions: [], negativesPass: true };
  }
  if (!Array.isArray(routingBank) || !routingBank.length) {
    return {
      ok: false, reasons: ['no-routing-bank'],
      missFixed: { fixed: 0, total: missQuestions.length }, bankPass: 0, bankTotal: 0, regressions: [], negativesPass: true,
    };
  }

  const overlay = overlayFromProposal(proposal);
  const reasons = [];

  // ---- (b) miss questions -------------------------------------------------
  let missFixedCount = 0;
  for (const q of missQuestions) {
    if (missIsRouted(q, overlay)) missFixedCount++;
  }
  const missFixed = { fixed: missFixedCount, total: missQuestions.length };
  if (missQuestions.length && missFixedCount < missQuestions.length) {
    reasons.push(`miss-not-fixed: ${missQuestions.length - missFixedCount}/${missQuestions.length} still unrouted`);
  }

  // ---- (c) routing bank regressions ---------------------------------------
  let bankPass = 0;
  const regressions = [];
  for (const entry of routingBank) {
    const [text, expected] = Array.isArray(entry) ? entry : [entry?.text, entry?.route];
    if (!text) continue;
    const baselineCode = classifyRoute(text, null);
    const overlayCode = classifyRoute(text, overlay);
    if (routePasses(overlayCode, expected)) bankPass++;

    const baselinePassed = routePasses(baselineCode, expected);
    const overlayPassed = routePasses(overlayCode, expected);
    const isNameOrAddressEntry = expected === 'R' || expected === 'L';
    const corrupted =
      isNameOrAddressEntry &&
      normalizeQuestion(text, { overlay: null }).normalized !== normalizeQuestion(text, { overlay }).normalized;
    if ((baselinePassed && !overlayPassed) || corrupted) {
      regressions.push({ text, expected, before: baselineCode, after: overlayCode, corrupted });
    }
  }
  const bankTotal = routingBank.length;
  if (regressions.length) reasons.push(`regressions: ${regressions.length}/${bankTotal}`);

  // ---- (e) entity-name shadow guard ---------------------------------------
  if (proposalShadowsEntityName(proposal, nameTokens)) {
    reasons.push(`shadows-entity-name: "${proposal.payload.from}" matches a real customer/contact/technician name on file`);
  }

  // ---- (d) fixed negative set ----------------------------------------------
  let negativesPass = true;
  for (const q of negatives) {
    const { normalized } = normalizeQuestion(q, { overlay });
    const isContactLookup = Boolean(parseContactLookupQuestion(q, { overlay }));
    const isSingleRecord = looksLikeSingleRecordReference(q);
    // A negative is a single-record/address/named-customer question. It must
    // never become an unfiltered ANALYTICS answer — becoming a contact
    // lookup is the correct handler for a named-customer question and is not
    // itself a failure, but only as long as analytics doesn't ALSO claim it
    // (mirrors api/ask.js's own !contactLookupIntent && !singleRecord gate
    // ahead of preClassifyAnalytics).
    const hijackedIntoAnalytics = !isContactLookup && !isSingleRecord && preClassifyAnalytics(normalized, { overlay });
    if (hijackedIntoAnalytics) {
      negativesPass = false;
      reasons.push(`negative hijacked into analytics: "${q}"`);
    }
  }

  return { ok: reasons.length === 0, reasons, missFixed, bankPass, bankTotal, regressions, negativesPass };
}

/* ---------------------------------------------------------------- loader */

const __dirname = dirname(fileURLToPath(import.meta.url));
let cachedBank; // undefined = not tried yet; null = tried and missing
let warnedMissingBank = false;

/**
 * Lazily loads test-docs/question-bank/routing-bank.json (a build artifact —
 * see scripts/gen-question-bank.mjs's own step for how it's produced).
 * Tolerant of it not existing (a checkout that hasn't run the generator, or
 * a deploy that doesn't ship test-docs/): a single console.warn, then `null`
 * forever after — never a thrown error. Cached once successfully loaded.
 */
export function loadRoutingBank() {
  if (cachedBank !== undefined) return cachedBank;
  try {
    const raw = readFileSync(join(__dirname, '..', '..', '..', 'test-docs', 'question-bank', 'routing-bank.json'), 'utf8');
    cachedBank = JSON.parse(raw);
  } catch (err) {
    if (!warnedMissingBank) {
      warnedMissingBank = true;
      console.warn('learning/verify: routing-bank.json not found (run `node scripts/gen-question-bank.mjs`):', err?.message);
    }
    cachedBank = null;
  }
  return cachedBank;
}

// Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md): a real single-record/
// lookup negative set, derived from the bundled bank itself rather than a
// second hand-maintained list, for callers (learning/policy.js, api/review.js's
// learningDecide) that have no negatives of their own to pass. Capped and
// cached once per loaded bank — this file's bank loop already costs O(bank
// size) per verify call, so a second full-size pass every time would roughly
// double it for marginal extra coverage; a fixed 300-entry slice is plenty to
// catch a proposal that corrupts a name/address word into an analytics term.
let cachedNegatives; // undefined = not derived yet
const MAX_DERIVED_NEGATIVES = 300;

function derivedNegativesFromBank(bank) {
  if (cachedNegatives !== undefined) return cachedNegatives;
  if (!Array.isArray(bank)) return (cachedNegatives = []);
  const out = [];
  for (const entry of bank) {
    const [text, expected] = Array.isArray(entry) ? entry : [entry?.text, entry?.route];
    if (text && (expected === 'R' || expected === 'L')) out.push(text);
    if (out.length >= MAX_DERIVED_NEGATIVES) break;
  }
  return (cachedNegatives = out);
}

/** Convenience wrapper for real (non-test) callers: loads the bundled
 *  routing bank and runs verifyProposal against it, returning the same
 *  `{ ok: false, reasons: ['no-routing-bank'], ... }` shape verifyProposal
 *  itself returns for an empty bank when the file can't be found at all.
 *  `negatives`, when omitted, defaults to a slice of the bank's own R/L
 *  (single-record/lookup) entries — see derivedNegativesFromBank above. */
export function verifyProposalLive(proposal, { missQuestions = [], negatives, nameTokens = null } = {}) {
  const routingBank = loadRoutingBank();
  const effectiveNegatives = negatives ?? derivedNegativesFromBank(routingBank);
  return verifyProposal(proposal, { missQuestions, routingBank: routingBank ?? [], negatives: effectiveNegatives, nameTokens });
}
