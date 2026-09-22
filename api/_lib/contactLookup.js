/**
 * Contact-lookup-by-name fast path (live miss cluster 1, 2026-09-21
 * 270-question sample): "what's the phone number on file for donna
 * thornton", "what's the email for sandra wyckoff", "what's the ph# on file
 * for brian chavez" all returned "Nothing in your records answers that" —
 * retrieval had nothing to cite because the value was never printed on a
 * document page at all, it's a plain column on the customer's own entity row
 * (data->>'phone' / data->>'email' / data->>'service_address').
 *
 * api/_lib/fastPath.js already has customer_phone/customer_email intents,
 * but classifyIntent (fastPath.js) requires either a real extracted subject
 * (extractSubject's NAME_HINT_RE et al., which all require a CAPITALIZED
 * name) or an HVAC domain anchor (condenser/furnace/...). A dispatcher typing
 * a lowercase name with no HVAC-specific word satisfies neither, so
 * classifyFastPath returns null there and the question falls through to
 * retrieval, which has no page to cite. This file is a separate, narrower
 * fast path for exactly that shape — case-INSENSITIVE on the name on
 * purpose, since that's precisely the gap above.
 *
 * Wired into api/ask.js BEFORE the analytics gate and before retrieval (see
 * that file's own comment at the call site). No model call, ever: the
 * answer is built straight from a customers row — see usage.js's
 * isCountableAskSource, which never lists 'contact-lookup' as countable.
 *
 * Pure functions (parseContactLookupQuestion, fuzzyNameMatches,
 * buildContactAnswer) are unit-tested with no database — see
 * scripts/verify-analytics.mjs's contact-lookup section. resolveContact/
 * runContactLookup are the only functions here that touch `db`.
 */
import { normalizeQuestion } from "./nlNormalize.js";
import { ENTITY_SYNONYMS } from "./analytics.js";
import { documentTypeLabel } from "./documentTypes.js";

/* ============================================================ shape detection */

// Field trigger words, checked in this order (most specific first isn't
// actually required here — the three groups share no words — but keeping a
// fixed order makes the classifier's `field` choice deterministic when a
// question somehow contains more than one, e.g. "phone or email").
// "ph#" ends in a non-word character, so it can't share the OTHER
// alternatives' trailing `\b` (a word boundary requires one side to be a
// word character — "#" followed by a space has no boundary there at all) —
// given its own alternative with no trailing boundary requirement instead.
// HVAC persona bank (2026-09-21): "bracken serial" / "whats bracken's
// serial" / "ellison last visit" — half-sentence dispatcher shorthand for
// exactly the same "<name> <field>" shape phone/email/address already own,
// just for two more fields. 'serial' resolves for real (a correlated
// subquery onto the customer's own equipment row — see CUSTOMER_ROW_COLUMNS
// below); 'lastVisit' has no backing column at all (this corpus tracks no
// service-visit history — same note hvac-personas.mjs's own "last visit"
// questions carry) so it always falls into buildContactAnswer's honest
// "No X on file" branch below, never a guess.
// HVAC persona bank (2026-09-21): "what's the number for donna thornton" —
// dispatcher shorthand for "phone number" that never says the word "phone"
// at all. A bare "number" is safe to treat as phone specifically (never
// email/address, which always name themselves) as long as it isn't the
// TAIL of "serial number" — the negative lookbehind excludes exactly that
// one collision, so "serial number"/"serial #" still only ever matches the
// serial field below, never phone.
const FIELD_RE = {
  phone: /\bphone(?:\s*number)?\b|\bph\s?#|(?<!serial\s)\bnumber\b/i,
  email: /\be-?mail\b/i,
  address: /\b(?:service\s+)?address\b/i,
  serial: /\bserial(?:\s*number)?\b/i,
  lastVisit: /\blast\s+(?:visit|service)\b/i,
};
const FIELD_ORDER = ["phone", "email", "address", "serial", "lastVisit"];

// The name phrase must be the LAST thing in the question, right after
// "for"/"on file for" — every word slot here is letters (plus
// apostrophe/period/hyphen) only, so a street address ("...for 1234 Main
// St") or an analytics question with no trailing name ("...have a phone")
// never satisfies this and the whole match fails, deferring to fastPath/
// retrieval/analytics exactly as before. Capped at 3 words (a first + middle
// + last name), matching the brief's "1-3 capitalized-or-not words".
// HVAC persona bank (2026-09-21): "of" was dropped from this alternation —
// "which customers have no email so i know who to call instead of emailing"
// matched its own trailing "of emailing" and captured namePhrase="emailing",
// a false-positive contact lookup on a real aggregate question. "of"
// introduces far more generic English tails ("end of day", "instead of
// emailing") than it ever introduces a trailing name — the exact reasoning
// analytics.js's own TRAILING_NAME_RE already documents for excluding "of"
// from its own, near-identical trailing-name shape.
const CONNECTOR_NAME_RE =
  /\b(?:on file for|for)\s+([a-zA-Z][a-zA-Z'.-]*(?:\s+[a-zA-Z][a-zA-Z'.-]*){0,2})\s*\??\s*$/i;

// The same field words FIELD_RE recognizes, as one alternation string, for
// the possessive shape below ("<name>'s phone number" / "<name> address") —
// built from FIELD_RE's own source text so the two can never drift apart.
// "serial(?:\s*number)?" is listed BEFORE the bare "number" alternative on
// purpose — a name-first "bracken serial number" must still resolve to the
// serial field, never phone, the same collision FIELD_RE's own phone pattern
// guards against with its negative lookbehind.
const FIELD_WORDS_ALT = "phone(?:\\s*number)?|ph\\s?#|e-?mail|(?:service\\s+)?address|serial(?:\\s*number)?|last\\s+(?:visit|service)|number";

// Reviewer NO-GO (2026-09-21): "whats thomas mercer's phone number" / "donna
// thornton's email" / "brian chavez address?" put the NAME before the field
// instead of after a "for/of" connector. Filler ("whats"/"what's"/"what is")
// is stripped first, then two shapes are tried against what's left, name
// tokens WITHOUT an apostrophe so the possessive "'s" itself is never
// swallowed into the name capture:
//   A. "<name>'s <field>"  — the possessive case
//   B. "<name> <field>"    — no possessive at all
// Anchored to the WHOLE remaining string ($) so this never fires on a
// question that merely happens to contain a name and a field word somewhere
// (e.g. an analytics question naming several other words in between).
const LEADING_FILLER_RE = /^(?:what'?s|whats|what\s+is)\s+/i;
const POSSESSIVE_NAME_FIELD_RE = new RegExp(
  `^([A-Za-z][A-Za-z.-]*(?:\\s+[A-Za-z][A-Za-z.-]*){0,2})'s\\s+(${FIELD_WORDS_ALT})\\s*\\??\\s*$`,
  "i"
);
const BARE_NAME_FIELD_RE = new RegExp(
  `^([A-Za-z][A-Za-z'.-]*(?:\\s+[A-Za-z][A-Za-z'.-]*){0,2})\\s+(${FIELD_WORDS_ALT})\\s*\\??\\s*$`,
  "i"
);

// A real person/company name is never introduced by an article, possessive
// pronoun, or a question/quantifier word — "for the newsletter", "for the
// file", "for our customers", "which customers ... email", "the shop['s]
// phone", "the Trane unit['s] address" are aggregate/incidental phrasings
// this shape must not mistake for a name (see the "never hijack an
// analytics question" requirement). Rejecting a captured phrase that STARTS
// with one of these closes that off without narrowing the name pattern
// itself.
// Reviewer NO-GO (2026-09-21, HVAC persona bank): "How many customers do we
// have an email on file for in Mesa?" — a real aggregate question, not a
// contact lookup at all — matched CONNECTOR_NAME_RE anyway (its trailing "for
// in Mesa" looks exactly like "for <name>") and namePhrase captured "in mesa"
// whole. "in"/"on"/"at"/"of"/"for"/"with" are prepositions, never the first
// word of a real name, the same reasoning firstWordIsStopword already applies
// to "the"/"our"/"which"/etc — added here rather than narrowing
// CONNECTOR_NAME_RE's own shape, which still needs to accept a real name that
// happens to start with any other word.
// 'serial'/'number'/'visit' guard the new serial/lastVisit fields the same
// way: "for serial M100017" must never be misread as a name "serial
// M100017" — see the serial/lastVisit fields' own doc comment above FIELD_RE.
const NAME_STOPWORD_RE =
  /^(?:the|a|an|this|that|these|those|our|their|his|her|my|your|its|which|who|what|how|does|do|did|is|are|list|show|has|have|in|on|at|of|for|with|without|serial|number|visit)$/i;

function firstWordIsStopword(namePhrase) {
  return NAME_STOPWORD_RE.test(namePhrase.split(/\s+/)[0]);
}

// HVAC persona bank (2026-09-21): "List customers missing a phone number" —
// a real aggregate/analytics question, not a contact lookup at all — was
// wrongly captured once LEADING_QUANTIFIER_RE (below) started stripping a
// leading "list ", leaving "customers missing a phone number", whose first
// three words ("customers missing a") satisfy BARE_NAME_FIELD_RE's generous
// up-to-3-word name capture just as well as a real name would ("customers"
// is not a NAME_STOPWORD_RE word — a real name can start with almost
// anything). A namePhrase containing one of analytics.js's own aggregate
// nouns (customer/unit/invoice/...) is never an actual person/company name,
// the same reasoning TRAILING_NAME_DOMAIN_WORD_RE already applies in
// analytics.js for its own trailing-name shape — reused here via
// ENTITY_SYNONYMS (analytics.js is DB/model-free, so importing it adds no
// dependency this file didn't already have transitively through
// normalizeQuestion's own vocabulary building).
const AGGREGATE_WORD_RE = new RegExp(
  `\\b(${[...new Set([
    ...ENTITY_SYNONYMS.customers,
    ...ENTITY_SYNONYMS.equipment,
    ...ENTITY_SYNONYMS.documents,
    ...ENTITY_SYNONYMS.serviceVisits,
    ...ENTITY_SYNONYMS.warranties,
  ])]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "i"
);

function isRealNamePhrase(namePhrase) {
  return !firstWordIsStopword(namePhrase) && !AGGREGATE_WORD_RE.test(namePhrase);
}

// Reviewer NO-GO (2026-09-21, round 6, item 2): "what's the phne number on
// file for amy isaacson" / "what's the emali for sandra wyckoff" reached
// production still misspelled — this file used to run on the RAW question,
// never nlNormalize.js's own normalizeQuestion pass (every other gate in
// api/ask.js already runs through it). Two fixes: (1) below, this file now
// normalizes its input the same way; (2) normalizeQuestion's own fuzzy
// correction only ever touches a token of 5+ letters (nlNormalize.js's own
// floor), which structurally can never reach a 4-letter typo like "phne" or
// "pone" — this tiny, closed table covers exactly the short field-word typos
// that floor misses. "e mail" (a literal typed space) is a phrase, not a
// token, so it's a substring replace rather than a table entry.
const FIELD_WORD_TYPO_FIXES = [
  [/\b(?:phne|phon|pone)\b/g, "phone"],
  [/\be mail\b/g, "email"],
  [/\b(?:emal|emial|emali)\b/g, "email"],
  [/\b(?:adress|addres|adres)\b/g, "address"],
  [/\b(?:terial|sreial|serail)\b/g, "serial"],
  [/\b(?:numbr|nubmer)\b/g, "number"],
];

function fixFieldWordTypos(q) {
  let out = q;
  for (const [re, to] of FIELD_WORD_TYPO_FIXES) out = out.replace(re, to);
  return out;
}

// Question-bank sloppiness variants (and plausible real dispatcher chatter)
// wrap this file's own end-anchored shapes in a leading quantifier word
// nlNormalize.js deliberately leaves alone (its own doc comment: "give me"/
// "show me"/"pull up"/"list"/"need the" carry the QUANTIFIER analytics.js
// relies on, so normalizeQuestion never strips them) and/or a trailing
// pleasantry/purpose clause ("thanks", "before end of day", "for the file",
// "so I can call them"). Neither belongs to the actual field/name shape this
// file matches, so both are stripped locally, only for THIS file's own
// parsing — analytics.js's own QUANTIFIER classification never sees this
// stripped text, so nothing about "list customers in Mesa" staying analytics
// changes. A strip that turns out to be wrong just means this file tries to
// match a slightly different string and still returns null on a real miss —
// never a wrong customer, per this file's own "never hijack" contract.
const LEADING_QUANTIFIER_RE = /^(?:show me|pull up|list|need the)\s+/i;
// Reviewer NO-GO (2026-09-22): "uh pull up the guy on greenfield road" — a
// spoken "uh"/"um" filler nlNormalize.js's own FILLER_PREFIX_RE doesn't strip
// (it isn't a real word carrying any meaning to preserve, unlike "show me"/
// "list"), folded into the SAME strip-until-stable loop as the quantifier
// words below rather than a separate one-shot replace, so "list uh pull up
// ..." (both stacked) still resolves once every leading noise word is gone.
const UH_FILLER_RE = /^(?:uh+|um+)\s+/i;
const TRAILING_CHATTER_RE =
  /,?\s*(?:so\s+i\s+can\s+[a-z]+(?:\s+[a-z]+){0,3}|for\s+the\s+(?:newsletter|file)|before\s+(?:end\s+of\s+day|eod)|thanks?|please)\s*$/i;

function stripTrailingChatter(q) {
  let out = q;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(TRAILING_CHATTER_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

// HVAC persona bank (2026-09-21): "Pull up Thornton" / "What do we have on
// file for Sandra Wyckoff?" ask for the WHOLE contact card, not one field —
// field: "full" below (buildContactAnswer's own branch) rather than a value
// from FIELD_RE. Anchored to the whole remaining string ($) the same way
// POSSESSIVE_NAME_FIELD_RE/BARE_NAME_FIELD_RE are, so this never fires on a
// question that merely happens to contain "pull up" or "on file" elsewhere
// (an analytics "list customers on file in Mesa" never matches — no name
// tail after "for", and "pull up" is never a QUANTIFIER prefix this file's
// own statement-form variant strips first).
const PULL_UP_NAME_RE = /^pull\s+up\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s*\??\s*$/i;
const ON_FILE_FOR_NAME_RE =
  /^what(?:'?s|\s+is)?\s+(?:do\s+we\s+have\s+on\s+file\s+for|on\s+file\s+for)\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s*\??\s*$/i;
// HVAC persona bank (2026-09-21): "list pull up thornton" / "need the pull up
// ortega" — a statement-form sloppiness variant stacks its OWN quantifier
// ("list "/"need the ") in front of the base question's already-quantified
// "pull up thornton", and the loop above (which strips leading
// quantifiers/filler one at a time until none are left) ends up removing
// "pull up" too, leaving a bare name with nothing left for PULL_UP_NAME_RE's
// own literal "pull up" prefix to match. Once EVERY leading quantifier/filler
// word has been stripped, whatever bare 1-3 word phrase remains is the same
// "full card" request PULL_UP_NAME_RE/ON_FILE_FOR_NAME_RE already grant — only
// tried when `stripped !== q` (see call site) so this never fires on a
// question that never had a quantifier to strip in the first place.
const BARE_NAME_ONLY_RE = /^([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s*\??\s*$/i;

// Reviewer NO-GO (2026-09-22): "pull up the guy on Greenfield Road" — the
// dispatcher never learned or never typed the customer's NAME at all, only
// the street they're on. Nothing above this point resolves that (every other
// shape needs an actual name token), so it's its own shape rather than a
// variant of one of them: a generic person/account noun ("the guy"/"the
// lady"/"the customer"/"the account"/"the people"/"the folks") or a bare
// "customer(s)" right before "on"/"at"/"over on" a street, with an optional
// trailing street-suffix word. The street WORDS are captured separately from
// the optional suffix (group 2) so the DB query (below) can search on just
// the street name — "Rd" vs "Road" in the address column must never block a
// match the way an exact-suffix requirement would.
const STREET_SUFFIX_ALT = "road|rd|street|st|ave|avenue|blvd|dr|drive|ln|lane|ct|way";
const STREET_ONLY_RE = new RegExp(
  `^(?:the\\s+(?:guy|lady|customer|account|people|folks)\\s+(?:on|at|over on)|customers?\\s+(?:on|at))\\s+` +
    `([a-zA-Z][a-zA-Z']*(?:\\s+[a-zA-Z][a-zA-Z']*){0,2}?)` +
    `(?:\\s+(${STREET_SUFFIX_ALT}))?\\s*\\??\\s*$`,
  "i"
);

// Live 100-question persona sample (2026-09-22), cluster "contact card
// completeness": "what's the serial on the Wyckoff unit" / "what's the model
// on the Wyckoff unit" — the field word comes BEFORE "the <name> unit", not
// after a "for"/possessive connector, so none of shapes 1-3 above match it.
// Both map to field 'serial' (never a separate 'model' field): runContactLookup
// answers either one with the customer's full equipment list, not a single
// scalar — see attachEquipmentFacts' own doc comment below.
const ON_THE_NAME_UNIT_RE =
  /^what(?:'s|\s+is)\s+the\s+(?:serial(?:\s*number)?|model(?:\s*number)?)\s+(?:on|for|of)\s+the\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s+unit\s*\??$/i;

// Live 100-question persona sample (2026-09-22), cluster "last visit/history
// by customer": "when were we last at Ellison's", "when did we last service
// Wyckoff", "last time we were at 322 N Greenfield", "how many times have we
// been to Mercer's" — none of these contain FIELD_RE.lastVisit's own "last
// visit"/"last service" words together, so they need their own shapes. A
// trailing possessive ("Ellison's") is stripped by the caller (see
// stripPossessive below); a phrase starting with a digit ("322 N
// Greenfield") is treated the same as STREET_ONLY_RE's own street shape.
const WHEN_LAST_AT_RE =
  /^when\s+(?:were\s+we|was\s+(?:the\s+)?(?:tech|crew|team))\s+last\s+(?:at|out\s+to)\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'.-]*){0,3})\s*\??$/i;
const WHEN_LAST_SERVICE_RE =
  /^when\s+did\s+we\s+last\s+service\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s*\??$/i;
const LAST_TIME_AT_RE =
  /^last\s+time\s+we\s+were\s+(?:at|out\s+to)\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'.-]*){0,4})\s*\??$/i;
const HOW_MANY_TIMES_RE =
  /^how\s+many\s+times\s+have\s+we\s+been\s+(?:to|out\s+to)\s+([A-Za-z0-9][A-Za-z0-9'.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'.-]*){0,3})\s*\??$/i;

function stripPossessive(s) {
  return String(s ?? "").replace(/'s$/i, "");
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/**
 * Pure: question text -> {field, namePhrase} or null.
 *   field: 'phone' | 'email' | 'address'
 *   namePhrase: the 1-3 word name as typed (any case)
 *
 * Deliberately conservative: no field keyword, or no name-shaped tail/head
 * next to it, and this returns null rather than guessing — the caller
 * (runContactLookup) then defers to whatever would have handled the
 * question anyway.
 */
export function parseContactLookupQuestion(question, opts = {}) {
  const overlay = opts?.overlay;
  const raw = String(question ?? "").trim();
  if (!raw) return null;
  const q = stripTrailingChatter(fixFieldWordTypos(normalizeQuestion(raw, { overlay }).normalized));
  if (!q) return null;

  // Shape 1: "<field> ... for/of <name>" (the original, more specific shape
  // — tried first since a "for/of"-connector match is a stronger signal
  // than the bare name-before-field shapes below).
  let field = null;
  for (const f of FIELD_ORDER) {
    if (FIELD_RE[f].test(q)) {
      field = f;
      break;
    }
  }
  if (field) {
    const m = q.match(CONNECTOR_NAME_RE);
    if (m) {
      const namePhrase = m[1].trim();
      if (namePhrase && isRealNamePhrase(namePhrase)) return { field, namePhrase };
    }
  }

  // Shape 2: "<name>['s] <field>" — the name comes first. Filler ("whats"/
  // "what's"/"what is") and a leading quantifier word ("list"/"pull up"/
  // "show me"/"need the" — see LEADING_QUANTIFIER_RE's own doc comment) are
  // both stripped, then the possessive form is tried before the bare form
  // (see POSSESSIVE_NAME_FIELD_RE's own doc comment).
  //
  // Stripped IN A LOOP, not once: a statement-form sloppiness variant can
  // stack two quantifiers ("list pull up thornton" — "list " layered in
  // front of the already-quantified "pull up thornton"), and a single
  // non-global .replace() only ever removes the first one, leaving "pull up
  // thornton" with no field word for shape 2 to match and no bare-"pull up"
  // start for shape 3 (below) to match either. Reused for shape 3 too, for
  // exactly that reason.
  let stripped = q.replace(LEADING_FILLER_RE, "").trim();
  for (let i = 0; i < 5; i++) {
    const next = stripped.replace(UH_FILLER_RE, "").replace(LEADING_QUANTIFIER_RE, "").trim();
    if (next === stripped) break;
    stripped = next;
  }
  for (const re of [POSSESSIVE_NAME_FIELD_RE, BARE_NAME_FIELD_RE]) {
    const m = stripped.match(re);
    if (!m) continue;
    const namePhrase = m[1].trim();
    const matchedField = fieldFromText(m[2]);
    if (namePhrase && matchedField && isRealNamePhrase(namePhrase)) {
      return { field: matchedField, namePhrase };
    }
  }

  // Shape 3: "pull up <name>" / "what do we have on file for <name>" — no
  // field named at all, the whole contact card (see buildContactAnswer's
  // "full" branch).
  for (const candidate of [q, stripped]) {
    for (const re of [PULL_UP_NAME_RE, ON_FILE_FOR_NAME_RE]) {
      const m = candidate.match(re);
      if (!m) continue;
      const namePhrase = m[1].trim();
      if (namePhrase && isRealNamePhrase(namePhrase)) return { field: "full", namePhrase };
    }
  }
  if (stripped !== q) {
    const m = stripped.match(BARE_NAME_ONLY_RE);
    if (m) {
      const namePhrase = m[1].trim();
      if (namePhrase && isRealNamePhrase(namePhrase)) return { field: "full", namePhrase };
    }
  }

  // Shape 3b: "what's the serial/model on the Wyckoff unit" — see
  // ON_THE_NAME_UNIT_RE's own doc comment. Always field 'serial': both the
  // serial and model wording resolve to the customer's full equipment list.
  {
    const m = q.match(ON_THE_NAME_UNIT_RE);
    if (m) {
      const namePhrase = m[1].trim();
      if (namePhrase && isRealNamePhrase(namePhrase)) return { field: "serial", namePhrase };
    }
  }

  // Shape 3c: visit-history questions with no "last visit"/"last service"
  // field word (see WHEN_LAST_AT_RE et al.'s own doc comment). Tried against
  // both `q` and the quantifier/filler-stripped `stripped` — same as Shape 4
  // below — so a leading "show me"/"list" ("show me when did we last service
  // Wyckoff") resolves the same way the bare form does. A trailing possessive
  // ("Ellison's") is stripped before the name/street check; a phrase starting
  // with a digit is treated as a street reference, the same "isStreet" shape
  // Shape 4 already returns.
  for (const candidate of [q, stripped]) {
    for (const [re, field] of [
      [WHEN_LAST_AT_RE, "lastVisit"],
      [WHEN_LAST_SERVICE_RE, "lastVisit"],
      [LAST_TIME_AT_RE, "lastVisit"],
      [HOW_MANY_TIMES_RE, "visitCount"],
    ]) {
      const m = candidate.match(re);
      if (!m) continue;
      const captured = stripPossessive(m[1].trim());
      if (!captured) continue;
      if (/^\d/.test(captured)) {
        const streetLabel = titleCase(captured);
        return { field, namePhrase: captured, isStreet: true, street: captured, streetLabel };
      }
      if (isRealNamePhrase(captured)) return { field, namePhrase: captured };
    }
  }

  // Shape 4: "the guy on Greenfield Road" / "customers on Greenfield Rd" — a
  // street-name-only reference, no customer name at all (see STREET_ONLY_RE's
  // own doc comment). Tried against both `q` and the quantifier/filler-
  // stripped `stripped` so "list uh pull up the guy on greenfield road"
  // resolves the same way the bare form does. `street` carries the bare
  // street name for the DB query; `streetLabel` is the same words, title-
  // cased with whatever suffix was actually typed, for the answer text.
  for (const candidate of [q, stripped]) {
    const m = candidate.match(STREET_ONLY_RE);
    if (!m) continue;
    const street = m[1].trim().toLowerCase();
    if (!street || NAME_STOPWORD_RE.test(street.split(/\s+/)[0])) continue;
    const streetLabel = titleCase(street) + (m[2] ? " " + titleCase(m[2]) : "");
    return { field: "full", namePhrase: street, isStreet: true, street, streetLabel };
  }

  return null;
}

/** Which canonical field a small matched fragment ("phone number", "ph#",
 *  "email", "address", "service address") represents — reuses FIELD_RE
 *  itself so this can never disagree with the shape-1 field detection
 *  above. */
function fieldFromText(text) {
  const t = String(text ?? "");
  for (const f of FIELD_ORDER) {
    if (FIELD_RE[f].test(t)) return f;
  }
  return null;
}

/* ============================================================ name matching */

export function nameTokens(namePhrase) {
  return String(namePhrase ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** True when `a`/`b` are the same word, one substitution/transposition apart
 *  (equal length), or one insertion/deletion apart (length differs by 1) —
 *  Damerau-Levenshtein distance <= 1. Duplicated from nlNormalize.js's own
 *  (unexported) withinEditDistance1 rather than adding a cross-file
 *  dependency for six lines of pure string math. */
function withinEditDistance1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffCount = 0;
    let i1 = -1;
    let i2 = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffCount++;
        if (diffCount === 1) i1 = i;
        else if (diffCount === 2) i2 = i;
        else return false;
      }
    }
    if (diffCount <= 1) return true;
    return i2 === i1 + 1 && a[i1] === b[i2] && a[i2] === b[i1];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let usedSkip = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (usedSkip) return false;
    usedSkip = true;
    j++;
  }
  return true;
}

/**
 * Pure: does this tenant customer's own name match the searched name tokens?
 * Surname (last token) within Damerau-Levenshtein <= 1 of the customer's own
 * last token, AND (the search named no first name at all — a surname-only
 * search — OR its first token equals the customer's own first token,
 * case-insensitively). Never matches on surname alone when a first name was
 * given and disagrees — that's exactly what keeps "brian chavez" from also
 * matching a "Brian Chavez" false-positive's near-namesake "Brian Chaves"
 * while still failing closed against an unrelated "Diane Chavez".
 */
export function fuzzyNameMatches(customerName, searchTokens) {
  const custTokens = nameTokens(customerName);
  if (!custTokens.length || !searchTokens?.length) return false;
  const custSurname = custTokens[custTokens.length - 1];
  const searchSurname = searchTokens[searchTokens.length - 1];
  if (!withinEditDistance1(custSurname, searchSurname)) return false;
  if (searchTokens.length === 1) return true; // surname-only search
  return custTokens[0] === searchTokens[0];
}

/* ============================================================ answer building */

const FIELD_WORD = {
  phone: "phone", email: "email", address: "service address",
  serial: "serial number",
  // No backing column for this one — see the serial/lastVisit fields' own
  // doc comment above FIELD_RE. CUSTOMER_FIELD_KEY intentionally has no
  // 'lastVisit' entry, so row[CUSTOMER_FIELD_KEY.lastVisit] is always
  // undefined and buildContactAnswer's honest "No X on file" branch fires
  // every time, never a guess.
  lastVisit: "last visit",
};
const CUSTOMER_FIELD_KEY = { phone: "phone", email: "email", address: "service_address", serial: "serial_number" };
// "full" (shape 3, above) has no single requested value to check — every
// field on file is shown regardless, same as the multi-field summary line
// every other branch below already builds.

/** {label, value, entityId, sources} for every contact field this customer
 *  row actually has on file — same "entityId links a fact to the customer,
 *  sources: []" shape analytics.js's own customer-row facts already use (see
 *  e.g. shapeCustomerRow/queryTopCustomers in routes/analytics.js) — the
 *  FactGrid component links a fact with an entityId to that customer's
 *  profile regardless of which endpoint produced it. */
function contactFacts(row) {
  const facts = [];
  if (row.phone) facts.push({ label: "Phone", value: row.phone, entityId: row.id, sources: [] });
  if (row.email) facts.push({ label: "Email", value: row.email, entityId: row.id, sources: [] });
  if (row.service_address) facts.push({ label: "Address", value: row.service_address, entityId: row.id, sources: [] });
  if (row.serial_number) facts.push({ label: "Serial", value: row.serial_number, entityId: row.id, sources: [] });
  return facts;
}

/** Pure: build the final answer for exactly one resolved customer row. A
 *  missing REQUESTED field is answered honestly ("No phone on file for
 *  Donna Thornton.") with no facts, rather than a confident-looking blank —
 *  the same "never guess" rule fastPath.js's own field lookups follow.
 *  Otherwise the answer names every contact field actually on file (not just
 *  the one asked about), same as a customer-profile card would show. */
export function buildContactAnswer(field, row) {
  const name = row.customer_name || row.customer_number || "This customer";

  if (field === "full") {
    const facts = contactFacts(row);
    if (!facts.length) {
      return {
        kind: "answer", text: `No contact info on file for ${name}.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      };
    }
    const summary = [row.phone, row.email, row.service_address].filter(Boolean).join(" · ");
    return {
      kind: "answer", text: `${name} — ${summary}`,
      facts, sources: [], confidence: 1,
      verifiedCount: facts.length, unverifiedCount: 0, closest: [],
    };
  }

  const requestedValue = row[CUSTOMER_FIELD_KEY[field]];

  if (!requestedValue) {
    return {
      kind: "answer",
      text: `No ${FIELD_WORD[field]} on file for ${name}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  const facts = contactFacts(row);
  const summary = [row.phone, row.email, row.service_address].filter(Boolean).join(" · ");
  return {
    kind: "answer",
    text: `${name} — ${summary}`,
    facts, sources: [], confidence: 1,
    verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  };
}

/** Pure: more than one customer matched the searched name — name them and
 *  ask which, rather than guessing one (same rule fastPath.js's own
 *  pickUnique/"ambiguity never guessed through" follows). Each candidate is
 *  its own linkable fact so the client can offer them as choices. */
export function buildAmbiguousContactAnswer(namePhrase, rows) {
  const names = rows.map((r) => r.customer_name || r.customer_number || "Unnamed customer");
  return {
    kind: "answer",
    text: `I found more than one match for "${namePhrase}": ${names.join(", ")}. Which one did you mean?`,
    facts: rows.map((r) => ({
      label: r.customer_name || r.customer_number || "Unnamed customer",
      value: r.service_address || "—",
      entityId: r.id, sources: [],
    })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    // Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): api/ask.js
    // reads this to log a 'contact-lookup-ambiguous' row (api/_lib/
    // missStore.js) — an extra field the client ignores, same as `cached`
    // added elsewhere to an answer shape.
    candidateCount: rows.length,
  };
}

/** Pure: 2-5 customers share a street (STREET_ONLY_RE, above) — named and
 *  asked which, the same "never guess" shape buildAmbiguousContactAnswer
 *  uses for a name match, just worded around the street rather than the
 *  typed name phrase. */
export function buildStreetAmbiguousAnswer(streetLabel, rows) {
  const names = rows.map((r) => r.customer_name || r.customer_number || "Unnamed customer");
  return {
    kind: "answer",
    text: `I found ${rows.length} customers on ${streetLabel}: ${names.join(", ")} — which one?`,
    facts: rows.map((r) => ({
      label: r.customer_name || r.customer_number || "Unnamed customer",
      value: r.service_address || "—",
      entityId: r.id, sources: [],
    })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    candidateCount: rows.length,
  };
}

/** Pure: zero customers matched the street — the honest fallback, never a
 *  fabricated "nobody lives there" guess dressed up as certainty. */
export function buildNoStreetMatchAnswer(streetLabel) {
  return {
    kind: "answer",
    text: `No customers on ${streetLabel} on file.`,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

/* ============================================================ DB resolution
 * The only two functions in this file that touch `db` (a recordsStore.js
 * store, called from inside a withTenant transaction — same calling
 * convention as fastPathQuery.js). Tenant-scoped throughout via the same
 * predicate ask.js/analytics.js each already duplicate for their own
 * db.raw() escape-hatch queries (see recordsStore.js's own TENANT constant).
 */
const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
// serial_number is not a customer-row column at all (it lives on the
// customer's own equipment entity — see the 'serial' field's own doc comment
// above FIELD_RE) — pulled via a correlated scalar subquery, same tenant
// scope as the outer query, most-recent unit wins (ORDER BY ... DESC LIMIT
// 1), the same idiom analytics.js's buildAnalyticsSQL already uses for its
// own document/service-visit correlated lookups.
const CUSTOMER_ROW_COLUMNS =
  "id, customer_number, data->>'customer_name' AS customer_name, " +
  "data->>'service_address' AS service_address, data->>'phone' AS phone, data->>'email' AS email, " +
  "(SELECT eq.data->>'serial_number' FROM entities eq " +
  "   WHERE eq.customer_id = entities.id AND eq.entity_type = 'equipment' AND eq.merged_into IS NULL AND eq." + TENANT_SQL +
  "   ORDER BY eq.updated_at DESC LIMIT 1) AS serial_number";

// A fuzzy fallback scan reads every customer name on the tenant (there is no
// SQL index for "last token within edit distance 1 of this"), so it's capped
// the same way ask.js's own meta-router list queries are bounded, rather
// than left unbounded.
const FUZZY_SCAN_LIMIT = 3000;

/**
 * Resolve a name phrase against this tenant's own customers: an exact-ish
 * ILIKE match on the full name first (cheap, and correct for the common
 * case); if that finds nothing, a fuzzy fallback scan matching the surname
 * (last token) within Damerau-Levenshtein <= 1 — see fuzzyNameMatches. Never
 * reaches across tenants: every query here carries the same TENANT_SQL
 * predicate every other tenant-scoped read in this codebase does.
 */
export async function resolveContactCandidates(db, namePhrase) {
  const searchTokens = nameTokens(namePhrase);
  if (!searchTokens.length) return [];

  const { rows: exact } = await db.raw(
    `SELECT ${CUSTOMER_ROW_COLUMNS}
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'customer_name' ILIKE $1
      LIMIT 10`,
    [namePhrase]
  );
  if (exact.length) return exact;

  const { rows: all } = await db.raw(
    `SELECT ${CUSTOMER_ROW_COLUMNS}
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'customer_name' IS NOT NULL AND data->>'customer_name' <> ''
      LIMIT ${FUZZY_SCAN_LIMIT}`,
    []
  );
  return all.filter((r) => fuzzyNameMatches(r.customer_name, searchTokens));
}

// Parameterized (never string-concatenated) and capped at 5, per this
// shape's own spec — a street name is a far broader match than a customer
// name (many households can share one), so this intentionally returns fewer
// rows than the name-based resolver's LIMIT 10 above; 2-5 is the ambiguous
// range buildStreetAmbiguousAnswer names, 6+ is treated as "too broad to be
// useful" the same way (only the first 5 are ever fetched at all).
export async function resolveStreetCandidates(db, street) {
  const cleaned = String(street ?? "").trim();
  if (!cleaned) return [];
  const { rows } = await db.raw(
    `SELECT ${CUSTOMER_ROW_COLUMNS}
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'service_address' ILIKE $1
      LIMIT 5`,
    [`%${cleaned}%`]
  );
  return rows;
}

/**
 * Full orchestration for one question: shape detection -> DB resolution ->
 * answer building. Returns null (never throws for a shape/resolution miss)
 * whenever this isn't confidently a contact lookup, or the name resolves to
 * zero customers — the caller (api/ask.js) then falls through to
 * fastPath/analytics/retrieval exactly as if this file didn't exist, per the
 * "never hijack" requirement: an address-based question ("who is at 1234
 * Main St") or an analytics question ("how many customers have a phone")
 * never even produces a namePhrase (see CONNECTOR_NAME_RE's own doc
 * comment), and a namePhrase that matches no customer is reported as a miss,
 * not guessed at.
 */
export async function runContactLookup(db, question, opts = {}) {
  const overlay = opts?.overlay;
  const parsed = parseContactLookupQuestion(question, { overlay });
  if (!parsed) return null;

  // Street-only shape (no customer name at all — see STREET_ONLY_RE's own
  // doc comment): unlike a name miss, this DOES answer honestly at 0 matches
  // instead of falling through to fastPath/analytics/retrieval, because
  // there is no other handler in the pipeline that could make sense of "the
  // guy on Greenfield Road" either — deferring here would just reach
  // retrieval with nothing to cite, the exact "Nothing in your records
  // answers that" gap this whole file exists to close.
  if (parsed.isStreet) {
    const candidates = await resolveStreetCandidates(db, parsed.street);
    if (candidates.length === 0) return buildNoStreetMatchAnswer(parsed.streetLabel);
    if (candidates.length > 1) return buildStreetAmbiguousAnswer(parsed.streetLabel, candidates);
    return buildResolvedAnswer(db, parsed.field === "lastVisit" || parsed.field === "visitCount" ? parsed.field : "full", candidates[0]);
  }

  const candidates = await resolveContactCandidates(db, parsed.namePhrase);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return buildAmbiguousContactAnswer(parsed.namePhrase, candidates);
  return buildResolvedAnswer(db, parsed.field, candidates[0]);
}

/* ============================================================ item 2: last
 * visit / visit history by customer, and item 3: contact card completeness
 * (equipment facts). Both need `db` (a real query against extractions/
 * equipment, not just the customer's own row), so they're orchestrated here
 * rather than in the pure buildContactAnswer above — that function's
 * existing behavior/signature is left untouched for its own callers/tests.
 */
const TENANT_SQL_VISITS = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

function formatVisitDateLabel(rawDate) {
  const s = String(rawDate ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || "an unknown date";
  const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return s;
  return `${MONTH_LABELS[idx]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * Every service-visit fact for one customer: their most recent service_date
 * extraction (with the document's type and, if extracted, the technician),
 * plus how many DISTINCT documents on file carry a service_date at all. Only
 * looks at documents this customer is directly/equipment-linked to (
 * db.listCustomerDocumentLinks) — a name-matched-but-never-linked document is
 * deliberately not counted here, the same "never guess" caution
 * buildAmbiguousContactAnswer's own doc comment states elsewhere in this
 * file. Returns {mostRecent: null, count: 0} for a customer with no service
 * visits on file at all — never a guess, never a crash.
 */
export async function computeVisitHistory(db, customerId) {
  const linkRows = await db.listCustomerDocumentLinks(customerId);
  const ids = [...new Set(linkRows.map((r) => r.document_id))];
  if (!ids.length) return { mostRecent: null, count: 0 };

  const { rows } = await db.raw(
    `SELECT x.document_id, x.value AS service_date, d.document_type,
            (SELECT t.value FROM extractions t
              WHERE t.document_id = x.document_id AND t.field_key = 'technician' AND t.${TENANT_SQL_VISITS}
              ORDER BY t.created_at DESC LIMIT 1) AS technician
       FROM extractions x
       JOIN documents d ON d.id = x.document_id
      WHERE x.field_key = 'service_date' AND x.document_id = ANY($1::uuid[]) AND x.${TENANT_SQL_VISITS}
      ORDER BY x.value DESC`,
    [ids]
  );
  if (!rows.length) return { mostRecent: null, count: 0 };
  const count = new Set(rows.map((r) => r.document_id)).size;
  const top = rows[0];
  return {
    mostRecent: { date: top.service_date, documentType: top.document_type, technician: top.technician ?? null },
    count,
  };
}

/** Pure: {field, row-derived name, visit history} -> the final answer. Honest
 *  zero when the customer has no service visits on file at all — never a
 *  guess, matching every other honest-zero answer in this file. */
export function buildVisitAnswer(field, row, visits) {
  const name = row.customer_name || row.customer_number || "This customer";
  if (!visits?.mostRecent) {
    return {
      kind: "answer", text: `No service visits on file for ${name}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }
  const n = visits.count;
  if (field === "visitCount") {
    return {
      kind: "answer", text: `${n} visit${n === 1 ? "" : "s"} to ${name} on file.`,
      facts: [{ label: "Visits on file", value: String(n), sources: [] }],
      sources: [], confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [],
    };
  }
  const dateLabel = formatVisitDateLabel(visits.mostRecent.date);
  const typeLabel = documentTypeLabel(visits.mostRecent.documentType).toLowerCase();
  const techPart = visits.mostRecent.technician ? `, tech ${visits.mostRecent.technician}` : "";
  return {
    kind: "answer",
    text: `Last visit for ${name}: ${dateLabel} (${typeLabel}${techPart}). ${n} visit${n === 1 ? "" : "s"} on file.`,
    facts: [
      { label: "Last visit", value: dateLabel, sources: [] },
      { label: "Visits on file", value: String(n), sources: [] },
    ],
    sources: [], confidence: 1, verifiedCount: 2, unverifiedCount: 0, closest: [],
  };
}

/** "M100017 · Trane XR16 · installed 2019-04-02 · warranty exp 2029-04-02" —
 *  every equipment fact this codebase has for one unit, in one compact line.
 *  Never guesses a value that isn't on the row; a unit with nothing at all
 *  falls back to a plain placeholder rather than an empty string. */
function equipmentFactValue(u) {
  const parts = [];
  if (u.serial_number) parts.push(u.serial_number);
  const brandModel = [u.manufacturer, u.model].filter(Boolean).join(" ");
  if (brandModel) parts.push(brandModel);
  if (u.installation_date) parts.push(`installed ${u.installation_date}`);
  const expires = u.warranty?.expires;
  if (expires) parts.push(`warranty exp ${expires}`);
  return parts.length ? parts.join(" · ") : "No details on file";
}

/**
 * Item 3 (contact card completeness): appends one fact per unit on file to an
 * already-built contact answer — "bracken serial" / "what's the serial on
 * the Wyckoff unit" / a bare "pull up X" must return the unit(s), not just
 * the single latest serial number buildContactAnswer's own 'serial' branch
 * already names. Pure given the equipment rows (db.listCustomerEquipment's
 * own shape); a customer with zero units on file gets the answer back
 * unchanged (its own "No X on file"/full-card text already stands on its
 * own).
 */
export function attachEquipmentFacts(answer, equipmentRows) {
  if (!equipmentRows?.length) return answer;
  const facts = equipmentRows.map((u, i) => ({
    label: equipmentRows.length === 1 ? "Equipment" : `Unit ${i + 1}`,
    value: equipmentFactValue(u),
    sources: [],
  }));
  return { ...answer, facts: [...answer.facts, ...facts], verifiedCount: answer.verifiedCount + facts.length };
}

const EQUIPMENT_ATTACHED_FIELDS = new Set(["serial", "full"]);

/** Resolves one candidate row to its final answer, dispatching on `field` —
 *  the one place runContactLookup needs `db` beyond the name/street
 *  resolution it already does. */
async function buildResolvedAnswer(db, field, row) {
  if (field === "lastVisit" || field === "visitCount") {
    const visits = await computeVisitHistory(db, row.id);
    return buildVisitAnswer(field, row, visits);
  }
  const answer = buildContactAnswer(field, row);
  if (EQUIPMENT_ATTACHED_FIELDS.has(field)) {
    // Item 3 (100-question persona sample, 2026-09-22): an enrichment step,
    // never load-bearing for the answer itself — a db shim that doesn't (yet)
    // implement listCustomerEquipment, or any other failure fetching it,
    // still returns the plain contact card rather than throwing the whole
    // lookup away.
    try {
      const equipmentRows = await db.listCustomerEquipment(row.id);
      return attachEquipmentFacts(answer, equipmentRows);
    } catch (err) {
      console.error("attachEquipmentFacts: listCustomerEquipment failed, returning plain contact card:", err?.message);
      return answer;
    }
  }
  return answer;
}
