/**
 * Round 20 (J1) — untracked-concept registry (R20_CONTRACT.md cluster F6, r19_blind3_clusters.json):
 * "how many open warranty claims do we have right now" / "have we sent a renewal reminder on any of the
 * maintenance agreements" get routed into an unrelated count/yes-no template and answered with a fabricated,
 * confident number ("You have 132 units.", "Yes, you have 27 documents.") instead of the honest decline this
 * corpus's OWN schema already implies: a warranty "claim" and a maintenance-agreement "renewal reminder" are
 * never extracted anywhere at all (see extractFields.js's FIELD_SPECS — there is no claim_number,
 * claim_status, renewal_notice_sent, or renewal_reminder field; only warranty_registered_date/
 * warranty_expires/warranty_term/agreement_term are ever recorded).
 *
 * "Tracked" is derived from the schema, not hand-maintained as a parallel guess: each entry below names the
 * extractions.field_key(s) that would have to exist for this corpus to track that concept at all
 * (`isTracked` checks them against extractFields.js's own FIELD_SPECS, or a pack's own fields when one is
 * passed — see packForTenant/industry/index.js) — so a future FIELD_SPECS addition (a real claim_number
 * field, say) silently and correctly stops this concept from ever firing again, with no edit needed here.
 *
 * Every entry's phrase regex is deliberately narrow and specific (never a bare "warranty" or "maintenance",
 * both of which are heavily used elsewhere for real, correctly-tracked questions) — see
 * scripts/verify-precision-guard.mjs's own negative checks for the many real warranty/maintenance-agreement
 * phrasings that must NEVER match here.
 *
 * detectUntrackedConcept(question, {pack}) -> {id, label, text} | null. Pure, no DB, no model call — the
 * schema check is against the static FIELD_SPECS table (or the pack object the caller already resolved),
 * never a live query.
 */
import { FIELD_SPECS } from '../extractFields.js';

const BASE_FIELD_KEYS = new Set(FIELD_SPECS.map((f) => f.key));

function isTracked(fieldKeys, pack) {
  const keys = pack?.fields?.length ? new Set(pack.fields.map((f) => f.key)) : BASE_FIELD_KEYS;
  return fieldKeys.some((k) => keys.has(k));
}

/**
 * Each concept: `phrase` must match the question; `fieldKeys` are the extractions.field_key(s) that would
 * make this concept a real, trackable thing in this schema — if NONE of them exist, the concept is
 * untracked for this tenant and `decline(matchedText)` is the honest answer. Ordered narrowest/most-specific
 * phrase first (not load-bearing today — every phrase below is already mutually exclusive — kept in case a
 * future entry's phrase could otherwise shadow an earlier one).
 */
const UNTRACKED_CONCEPTS = [
  {
    id: 'warranty-claim',
    label: 'warranty claims',
    fieldKeys: ['claim_number', 'claim_status', 'warranty_claim'],
    // "warranty claim(s)", "claim number", "filed a claim", "open claim(s)" — never a bare "warranty"
    // (registration/expiry/status questions, all real and well-tracked, all stay untouched) and never a
    // bare "claim" with no warranty context (out of scope for this concept either way).
    phrase: /\b(?:warranty\s+claims?|(?:open|filed|filing|pending)\s+(?:a\s+|an\s+)?(?:warranty\s+)?claims?|claim\s+number|claims?\s+(?:we(?:'ve| have)?\s+)?filed)\b/i,
    decline: () =>
      "DeepWell doesn't track warranty claims as their own record yet — I can tell you a unit's warranty registration date and expiration if that helps.",
  },
  {
    id: 'renewal-reminder',
    label: 'renewal reminders',
    fieldKeys: ['renewal_notice_sent', 'renewal_reminder'],
    // "renewal reminder", "renewal notice" — deliberately requires the word "renewal" right next to
    // "reminder"/"notice" so an ordinary maintenance-agreement question ("when does the agreement renew",
    // "what's the agreement term") never matches.
    phrase: /\brenewal\s+(?:reminder|notice)s?\b/i,
    decline: () =>
      "DeepWell doesn't track whether a renewal reminder was sent yet — I can tell you what maintenance agreements are on file and their term if that helps.",
  },
  {
    id: 'inventory-stock',
    label: 'stock levels',
    fieldKeys: ['stock_level', 'inventory_count', 'quantity_on_hand'],
    // "stock level(s)", "how many <part> in stock", "inventory count" — never a bare "inventory" (an
    // equipment-record synonym elsewhere in this codebase) or "how many units/parts do we have" (a real,
    // well-tracked equipment/part-number count).
    phrase: /\b(?:stock\s+levels?|in\s+stock|inventory\s+count|quantity\s+on\s+hand)\b/i,
    decline: () =>
      "DeepWell doesn't track warehouse stock/inventory levels yet — I can tell you what equipment is on file for a customer if that helps.",
  },
  {
    id: 'payroll',
    label: 'payroll',
    fieldKeys: ['payroll_amount', 'wages_paid'],
    // "payroll", "wages paid", "employee pay" — a bookkeeping concept this corpus (customer/equipment/
    // document records) has no schema for at all.
    phrase: /\b(?:payroll|wages\s+paid|employee\s+pay)\b/i,
    decline: () => "DeepWell doesn't track payroll or employee wages — that's outside what's on file here.",
  },
];

/** question (+ optional `pack`, the tenant's industry pack — packForTenant/industry/index.js, only its own
 *  `fields` list is read) -> the first untracked concept the question names, or null. Never fires for a
 *  concept this corpus (or the tenant's own pack) actually DOES track a field for. */
export function detectUntrackedConcept(question, { pack } = {}) {
  const q = String(question ?? '');
  for (const concept of UNTRACKED_CONCEPTS) {
    if (!concept.phrase.test(q)) continue;
    if (isTracked(concept.fieldKeys, pack)) continue;
    return { id: concept.id, label: concept.label, text: concept.decline() };
  }
  return null;
}

/** The honest-decline `data` shape api/ask.js sends straight through — no facts, no sources, no $ figure —
 *  same shape moneyFallbackAnswer()/unsupportedConditionAnswer() already use (analytics.js), which is
 *  exactly what the scorecard's own compareHonestZero (scorecard/compare.js) requires to pass: any
 *  `kind !== 'no-answer'` answer with zero facts and no dollar sign is a correct, non-fabricated honest-zero. */
export function untrackedConceptAnswer(concept) {
  return {
    kind: 'answer',
    text: concept.text,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

export { UNTRACKED_CONCEPTS };
