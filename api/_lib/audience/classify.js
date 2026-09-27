/**
 * Audience classification — round 18, part 2, owner ask (a): "some of the correspondence and
 * service tickets are specifically for the techs and have nothing to do with the customer. how
 * do we incorporate those into the technicians' notifications and not mingle with the normal
 * documents strictly for customers?"
 *
 * Pure, deterministic, no model call — same contract as documentTypes.js's own inferDocumentType:
 * given doc type + text signals, decide whether a document is 'customer' (the default — every
 * customer-facing record: invoices, work orders, warranty registrations, ...) or 'internal' (shop
 * chatter that has NOTHING to do with any customer: a memo, a tech bulletin, a dispatch/job
 * assignment addressed to a tech, a parts/warehouse note, training/safety material, or
 * correspondence between staff). Generalizes by SHAPE (regex over doc type + free text), never by
 * memorizing exam text or a specific customer/tech name.
 *
 * THE ONE HARD RULE (owner's own example): "a service ticket at a customer address stays
 * customer." A document whose own extracted identity (customer_name/service_address/phone)
 * matches a REAL customer this tenant already has on file always wins outright — internal
 * keyword signals never override a confirmed customer match. That confirmation
 * (`customerIdentifierMatch`) is computed by the caller (see ./store.js's
 * documentMatchesKnownCustomer) against this tenant's own `entities` rows; this module never
 * touches a database, so it's directly testable with plain objects
 * (scripts/verify-audience.mjs), same split as documentTypes.js/followups.js.
 *
 * When neither a confirmed customer match nor a clear internal signal is present, or when an
 * internal signal fires alongside a customer name that DIDN'T match anything on file (typed
 * casually into a memo, say), the call is genuinely ambiguous: this returns 'customer' (the safe
 * default — never hide a document from the person it might be for) but flags `needsQuestion` so
 * the caller raises the existing intake exception queue's "Is this for the team only?" question
 * (see ../intake/audienceQuestions.js) instead of silently guessing either way.
 */

/** True when `v` is a non-empty extracted value — same shape documentTypes.js's `has()` (inside
 *  inferDocumentType) uses, kept as its own tiny copy here for the same reason every other file in
 *  this codebase keeps its own small copy of this idiom (see documentTypes.js's own header notes
 *  on why a pure classifier lives on its own with no imports). */
function present(v) {
  return v != null && String(v).trim() !== '';
}

/**
 * Strong internal signals — on their own, decisive: a memo/bulletin, an explicit "team/shop/
 * internal use only" marker, training/safety material, a parts/warehouse/inventory note, a
 * staff-wide address ("all techs", "all staff"), or a dispatch/job assignment phrased AT a
 * technician rather than describing customer work. Matched case-insensitively against the
 * document's own text (subject line, body, filename-derived notes — whatever the caller passes as
 * `text`).
 */
const STRONG_INTERNAL_RE = new RegExp(
  [
    '\\bmemo\\b', '\\bbulletin\\b', '\\btoolbox talk\\b',
    '\\b(safety|training)\\s+(meeting|session|bulletin|memo)\\b',
    '\\bstaff\\s+meeting\\b', '\\ball[- ]?(techs?|staff|technicians?)\\b',
    '\\b(parts?|warehouse|inventory|truck stock)\\s+(count|order|request|restock|inventory)\\b',
    '\\bwarehouse\\b',
    '\\b(team|shop|internal)[- ]?(use\\s+)?only\\b',
    '\\bdo not (share|send|forward)\\b.{0,30}\\bcustomer\\b',
    '\\b(internal|staff)[- ]?(memo|note|email|correspondence)\\b',
    '\\bdispatch(?:ing)?\\b.{0,25}\\b(tech|technician)\\b',
    '\\b(assigned|reporting)\\s+to\\s*[:\\-]?\\s*(tech|technician)\\b',
  ].join('|'),
  'i'
);

/** Weaker internal signals — contribute toward "ambiguous, ask" but never decide 'internal' on
 *  their own (too common in ordinary shop-to-customer correspondence to trust alone). */
const WEAK_INTERNAL_RE = /\b(fyi|heads[- ]?up|crew|schedule change|per our conversation with dispatch)\b/i;

/**
 * Prefix-only patterns (case-insensitive), each followed by a name captured SEPARATELY and
 * case-SENSITIVELY on the remainder of the string — same two-step split documentTypes.js's
 * extractTechnicianFromNotes already uses, and for the exact same reason: a single regex with
 * both the prefix AND the name capture under one `i` flag would make `[A-Z]` in the name class
 * match lowercase too (the `i` flag applies to the WHOLE pattern, character classes included), so
 * "Tech: assigned to Maria Alvarez" would wrongly capture "assigned to Maria" as the "name".
 * Splitting the match into two regexes — an `i`-flagged prefix, then a plain (case-sensitive) name
 * pattern applied only to what follows it — is what keeps the name capture genuinely
 * capital-letter-anchored.
 *
 * `TIGHT` prefixes require an immediate colon/dash ("To:", "Attn:") — "to" alone is far too common
 * in ordinary prose to trust without one. `LOOSE` prefixes are long/specific enough ("dispatching
 * to", "assigned to", "reporting to") that the colon is optional — a real dispatch assignment
 * routinely reads "assigned to Maria Alvarez" with no punctuation at all.
 */
const ADDRESSED_TIGHT_PREFIX_RE = /\b(?:to|attn|attention)\s*[:-]\s*/gi;
const ADDRESSED_LOOSE_PREFIX_RE = /\b(?:dispatching to|assigned to|reporting to)\s*[:-]?\s*/gi;
const TECH_PREFIX_RE = /\btech(?:nician)?s?\s*[:-]\s*/gi;
const NAME_RE = /^([A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]*){0,2})/;

/**
 * Every plausible technician name this document's text addresses, deduped, in the order first
 * seen. Pure regex, no roster lookup — matching a name against the tenant's actual member roster
 * (fuzzy last-name fallback included) is ./notify.js's job, same split as documentTypes.js's
 * extractTechnicianFromNotes (extraction) vs. followups.js's technicianNameMatches (roster match).
 */
export function extractMentionedNames(text) {
  const s = String(text ?? '');
  const names = [];
  for (const prefixRe of [ADDRESSED_TIGHT_PREFIX_RE, ADDRESSED_LOOSE_PREFIX_RE, TECH_PREFIX_RE]) {
    prefixRe.lastIndex = 0;
    let m;
    while ((m = prefixRe.exec(s))) {
      const rest = s.slice(m.index + m[0].length);
      const nameMatch = rest.match(NAME_RE);
      if (nameMatch) {
        const name = nameMatch[1].replace(/\s+/g, ' ').trim();
        if (name && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

export const AUDIENCE_QUESTION_TEXT = 'Is this for the team only?';

/**
 * @param {object} input
 * @param {string|null} [input.documentType]  canonical or raw document type id
 * @param {string} [input.text]  the document's own text — subject/body/notes/filename-derived, as
 *   much as the caller has cheaply available at intake (page text, extracted `notes` field, or
 *   both concatenated — this function doesn't care which, it only pattern-matches)
 * @param {{customer_name?, service_address?, phone?}} [input.fields]  this document's own
 *   extracted customer-identifying fields, if any (documentTypes.js/extractFields.js shape)
 * @param {boolean} [input.customerIdentifierMatch]  true when the caller already confirmed this
 *   document's own customer_name/service_address/phone matches a REAL customer entity this tenant
 *   has on file (see ./store.js) — the one signal that always wins outright
 * @returns {{audience: 'customer'|'internal', confidence: number, needsQuestion: boolean,
 *   question?: string, reason: string, matchedTechNames: string[]}}
 */
export function classifyAudience({ documentType, text = '', fields = {}, customerIdentifierMatch = false } = {}) {
  const type = String(documentType ?? '').trim().toLowerCase();
  const matchedTechNames = extractMentionedNames(text);
  const hasCustomerField = present(fields?.customer_name) || present(fields?.service_address) || present(fields?.phone);

  // Rule 1 (owner's own example): a confirmed match against a real customer on file always wins,
  // no matter what internal-sounding language also appears in the text.
  if (customerIdentifierMatch) {
    return { audience: 'customer', confidence: 0.95, needsQuestion: false, reason: 'customer-identifier-match', matchedTechNames };
  }

  const strongHit = STRONG_INTERNAL_RE.test(text) || type === 'internal';
  const weakHit = !strongHit && WEAK_INTERNAL_RE.test(text);

  if (strongHit && !hasCustomerField) {
    return { audience: 'internal', confidence: 0.85, needsQuestion: false, reason: 'internal-signal-no-customer', matchedTechNames };
  }

  if (strongHit && hasCustomerField) {
    // A strong internal marker AND a customer name/address/phone somewhere that didn't match a
    // real entity on file — could be shop chatter that happens to mention someone, or could be a
    // real customer this tenant just hasn't linked yet. Never guess either way; ask.
    return {
      audience: 'customer', confidence: 0.5, needsQuestion: true, question: AUDIENCE_QUESTION_TEXT,
      reason: 'internal-signal-with-unmatched-customer-mention', matchedTechNames,
    };
  }

  if (weakHit) {
    return {
      audience: 'customer', confidence: 0.5, needsQuestion: true, question: AUDIENCE_QUESTION_TEXT,
      reason: 'weak-internal-signal', matchedTechNames,
    };
  }

  return { audience: 'customer', confidence: hasCustomerField ? 0.7 : 0.6, needsQuestion: false, reason: 'no-internal-signal', matchedTechNames };
}
