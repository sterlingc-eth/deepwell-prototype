/**
 * Model-free fast path for /api/ask (handoffs/ASK_LATENCY_2026-09-20.md): the
 * model costs 1.1-3.4s per question; retrieval + a model call is the only
 * part of /api/ask that scales with cost. Most dispatcher questions are a
 * single field lookup ("what's the serial on the unit at 3247 Elm") that is
 * already sitting in `extractions` or on the equipment/customer entity — this
 * file answers those in ~0.3s straight from the database, with the same
 * citation contract as the model path (see answer.js), and returns null the
 * instant it isn't SURE, so api/ask.js falls through to retrieval+model.
 *
 * This file is pure (no `db`, no I/O) so every rule here is unit-testable —
 * see scripts/verify-fastpath.mjs. api/_lib/fastPathQuery.js does the actual
 * database reads and calls back into the builders here.
 *
 * THE ONE RULE THAT MATTERS: never answer wrong. A fast path that is
 * occasionally fast and wrong is worse than no fast path — it undercuts the
 * one promise /api/ask makes (every fact is real and cited). So every step
 * below is written to fail toward "return null, let the model handle it"
 * rather than toward a guess: ambiguous subject -> null, no value on file for
 * the resolved subject -> null, an intent this file has no extraction field
 * for (seer, filter size) -> null, always.
 */
import { describeWarranty, alertTier } from './warrantyRules.js';
// TEAM C (citations everywhere): equipment / document lists cite the exact rows they list.
import { attachCitations, unitRecord, documentRecord } from './citations/records.js';

/* ============================================================ intent catalogue */

/** Field-lookup intents backed by one `extractions.field_key`. */
export const FIELD_BY_INTENT = {
  model: 'model',
  serial: 'serial_number',
  manufacturer: 'manufacturer',
  install_date: 'installation_date',
  installer: 'technician',
  last_service_tech: 'technician',
  last_service_date: 'service_date',
  service_address: 'service_address',
  customer_phone: 'customer_phone',
  customer_email: 'customer_email',
  customer_name: 'customer_name',
  refrigerant: 'refrigerant',
  tonnage: 'tonnage',
  permit_number: 'permit_number',
  invoice_total: 'cost',
  agreement_term: 'agreement_term',
};

/** Intents this app recognises but has NO extraction field for (see
 *  extractFields.js FIELD_SPECS) — classified for the training corpus and the
 *  answer-key report, but resolution must ALWAYS defer to the model, which can
 *  still find the value in page text. Never invent a field to "handle" these. */
export const NO_FIELD_INTENTS = new Set(['seer', 'filter_size']);

/** Computed (not a bare extraction field) — resolved via warrantyRules.js
 *  against the equipment entity's already-derived `data.warranty`. */
export const WARRANTY_INTENTS = new Set(['warranty_expires', 'warranty_status']);

/** Multi-row list answers, not a single fact. */
export const LIST_INTENTS = new Set(['equipment_list', 'document_list_for_subject']);

export const ALL_INTENTS = [
  ...Object.keys(FIELD_BY_INTENT),
  ...NO_FIELD_INTENTS,
  ...WARRANTY_INTENTS,
  ...LIST_INTENTS,
];

/* ================================================================ classification
 *
 * Ordered [intent, RegExp] triggers, first match wins. Ordered specific ->
 * generic so e.g. "still under warranty" (status) is claimed before the
 * looser "warranty" + expiry-cue pair (expires). Every trigger requires an
 * unambiguous keyword combination; a bare word that could mean several
 * things ("make", "contact", "unit") is deliberately left OUT — see the file
 * header's "never answer wrong" rule. A question that matches nothing here
 * returns null from classifyIntent and the whole question defers to the
 * model, which is the safe default for anything not confidently one of
 * these.
 */
const TRIGGERS = [
  ['warranty_status', /\b(is|are)\b[^?.!]*\b(under warranty|still covered|in warranty|warranty status)\b/i],
  ['warranty_status', /\bstill (covered|under warranty|good|valid)\b/i],
  ['warranty_status', /\bdoes\b[^?.!]*\bhave (?:a )?warranty\b/i],
  ['warranty_status', /\bwarranty status\b/i],
  ['warranty_expires', /\bwarr[ae]nty\b[\s\S]*\b(when'?s?|whens|expir\w*|\bexp\b|\bup\b|end(?:s|ing)?|due|good (?:until|thru|through)|how long)\b/i],
  ['warranty_expires', /\b(when'?s?|whens)\b[\s\S]*\bwarr[ae]nty\b/i],
  ['agreement_term', /\b(maintenance )?agreement\b[\s\S]*\b(expire|expir\w*|term|end|renew)\b/i],
  ['agreement_term', /\bservice contract\b[\s\S]*\b(expire|term|end)\b/i],
  ['serial', /\bserial\b|\bs\/n\b|\bseriel\b|\bserail\b/i],
  ['model', /\bmodel\b|\bmodle\b/i],
  ['manufacturer', /\bwhat (?:brand|make)\b|\bmanufacturer\b|\bmanufaturer\b|\bwho makes\b/i],
  ['installer', /\bwho (?:installed|did the install)\b|\bwho put\b[\s\S]*\bin\b|\binstaller\b/i],
  ['install_date', /\binstall(?:ed|ation)?\b[\s\S]*\b(date|when)\b|\b(date|when)\b[\s\S]*\binstall(?:ed|ation)?\b|\binstall date\b/i],
  ['last_service_tech', /\bwho\b[\s\S]*\b(last|out|worked on|came out|serviced)\b/i],
  ['last_service_tech', /\b(last|latest) (?:tech|technician)\b/i],
  ['last_service_tech', /\b(?:which|what)\s+tech(?:nician)?\b/i],
  ['last_service_date', /\bwhen\b[\s\S]*\blast\b[\s\S]*\b(service|serviced|maintenance|visit|time)\b|\blast service(d)? date\b|\bwhen was it last serviced\b/i],
  ['customer_phone', /\bphone\b|\bcontact number\b/i],
  ['customer_email', /\bemail\b/i],
  ['customer_name', /\bwho is the customer\b|\bwho'?s the customer\b|\bwhose (?:house|unit|property|job|account) is\b|\bwho lives at\b|\bwho owns\b/i],
  ['service_address', /\bservice address\b|\bwhat'?s the address\b|\bwhat is the address\b/i],
  ['refrigerant', /\brefrigerant\b|\bfreon\b/i],
  ['tonnage', /\btonnage\b|\bhow many tons\b|\bwhat size (?:unit|system)\b|\bcapacity\b/i],
  ['seer', /\bseer2?\b|\befficiency\b/i],
  ['filter_size', /\bfilter size\b|\bwhat size filter\b|\bfilter dimensions?\b/i],
  ['permit_number', /\bpermit\b/i],
  ['invoice_total', /\b(invoice|bill)\b[\s\S]*\b(total|cost|amount|come to|how much)\b/i],
  ['invoice_total', /\bhow much\b[\s\S]*\b(invoice|bill|job|install(?:ation)?)\b/i],
  ['invoice_total', /\btotal (?:cost|amount|due)\b/i],
  ['invoice_total', /\b(?:last|latest|most recent)\s+(?:invoice|bill)\b/i],
  ['document_list_for_subject', /\bwhat documents?\b[\s\S]*\b(?:on|for)\b|\bwhat do we have\b[\s\S]*\b(?:on|for)\b|\bshow (?:me )?everything (?:on|for)\b|\ball documents? for\b/i],
  ['equipment_list', /\bwhat equipment\b|\bwhat units?\b[\s\S]*\bhave\b|\bwhat'?s installed at\b|\blist (?:the )?equipment\b/i],
];

/** Raw trigger match only — NOT the public classifier. "serial killer
 *  documentary recommendations", "what was the model of behavior therapy
 *  used in the study", and "who installed the app on this phone" all match
 *  one of these on the word alone; TRIGGERS exists to narrow which intent a
 *  domain question is about, not to decide that a question IS a domain
 *  question. classifyIntent (below) is the actual public entry point and
 *  never skips the domain-anchor gate. */
function matchTrigger(question) {
  const q = String(question ?? '');
  if (!q.trim()) return null;
  for (const [intent, re] of TRIGGERS) {
    if (re.test(q)) return intent;
  }
  return null;
}

/**
 * Domain anchors: phrases specific enough to HVAC dispatch paperwork that
 * their presence, by itself, confirms a question is actually about this
 * business's documents. Required (together with an extracted subject as the
 * other acceptable proof — see classifyIntent) before ANY intent is
 * accepted.
 *
 * Deliberately excludes every bare word that is ALSO one of TRIGGERS' own
 * ambiguous keywords — warranty, serial, model, install/installed alone,
 * unit, system, equipment, customer, technician, phone, email, address,
 * cost, agreement, permit, refrigerant, tonnage, seer, filter, manufacturer,
 * brand, make, compressor, thermostat. An anchor has to be independent
 * confirmation, not the same generic word restated: "serial" is common
 * English ("serial killer"), "serial number" on real HVAC paperwork is not.
 * Only compound phrases and equipment-type nouns with no everyday non-HVAC
 * meaning are listed. When neither this nor a real extracted subject
 * (address/customer number/serial/model token/name) is present, the
 * question defers — see scripts/verify-fastpath.mjs's adversarial NEGATIVES
 * for the exact false-positive class this closes off.
 */
// Deliberately a SHORT, narrow list — physical HVAC equipment nouns with
// essentially zero everyday non-HVAC usage. Earlier drafts also included
// "serial number", "model number", "invoice total", "work order",
// "installation date" etc. as compound anchors on the theory that a two-word
// phrase would be safer than the bare trigger word alone; adversarial testing
// disproved that ("what's the model number of my printer" anchors just fine
// on "model number" and has no HVAC content at all — printers, phones and
// appliances all have serial/model numbers and invoices too). Every one of
// those was removed. A field-lookup question with no domain noun from THIS
// list must therefore carry a real extracted subject (address/customer
// number/serial-or-model token/name) to be answered fast — see
// scripts/verify-fastpath.mjs's ADVERSARIAL_NEGATIVES for the exact cases
// this closes.
const ANCHOR_RE = new RegExp(
  '\\b(' +
    [
      'condenser', 'air handler', 'furnace', 'heat pump', 'rtu', 'mini[- ]?split',
      'package unit', 'hvac', 'evaporator coil', 'ductwork', 'nameplate',
    ].join('|') +
    ')\\b',
  'i'
);

/** Pure: does the question contain independent HVAC/document context, apart
 *  from whichever ambiguous trigger word matched an intent? */
export function hasAnchor(question) {
  return ANCHOR_RE.test(String(question ?? ''));
}

/**
 * Pure: question text -> intent id, or null.
 *
 * A trigger match alone is NOT enough — see matchTrigger's doc comment. The
 * question must also carry either a real extracted subject (a customer
 * number, an address, a serial/model-shaped identifier, or a name) or an
 * independent domain anchor (hasAnchor). Neither present means this could be
 * any generic English sentence that happens to share a word with an HVAC
 * question, and the safe answer is to defer to the model, which has actual
 * page text to check the question against.
 */
export function classifyIntent(question) {
  const intent = matchTrigger(question);
  if (!intent) return null;
  const subject = extractSubject(question);
  if (!subject.hasAny && !hasAnchor(question)) return null;
  return intent;
}

/* =================================================================== subject
 *
 * Pulls the thing the question is ABOUT out of the raw text: a customer
 * number, a street address fragment, an identifier (serial or model — both
 * are alnum tokens >= 8 chars with a digit, so one extraction covers both;
 * resolution below tries the token against both field_keys), a name, an
 * "most recent" ordinal, and a unit-type word. Every field is a best-effort
 * hint, not a claim — resolution (fastPathQuery.js) is what actually decides
 * whether it uniquely identifies one customer/unit, and refuses to guess.
 */

const CUSTOMER_NUMBER_RE = /\bC-(\d{5})\b/i;

const STREET_SUFFIX_RE =
  '(?:st(?:reet)?|ave(?:nue)?|rd|road|dr(?:ive)?|ln|lane|blvd|boulevard|way|ct|court|pl(?:ace)?|cir(?:cle)?|pkwy|parkway)';
// R11 fix (lookups-0010/0084, hvac-tech-0007/0036 — golden tenant): this used to stop capturing
// right after the street-suffix word, so "137 W Southern Ave, Mesa, AZ 85201" and "137 W
// Southern Ave, Phoenix, AZ 85001" (two DIFFERENT real addresses in this corpus that share a
// house number and street name) became the identical subject.address "137 W Southern Ave" —
// fastPathQuery.js's own ILIKE-ALL match then had no city/zip tokens to require and silently
// answered the Phoenix customer's real record for a Mesa address that was never on file. The
// trailing city/state/zip is optional (a bare "3247 Elm St" with no city still matches exactly
// as before) but, when present, is now part of the captured address so its tokens flow through
// significantAddressTokens/ILIKE ALL and a same-street-different-city collision can no longer
// resolve to the wrong customer. State is [A-Za-z]{2,12} (not just 2 letters) because
// normalizeQuestion.js may have already expanded "AZ" to "Arizona" upstream of this regex.
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,6}\\s+[A-Za-z0-9.']+(?:\\s+[A-Za-z0-9.']+){0,3}\\s+${STREET_SUFFIX_RE}(?:,?\\s+[A-Za-z][A-Za-z\\s]{1,24}?,?\\s+[A-Za-z]{2,12}\\s+\\d{5})?)\\b\\.?`,
  'i'
);
// A word that must never be swallowed into a loose address or mistaken for a
// name — question words and the common verbs/adjectives/nouns that follow
// "at <address>" or "for <name>" in a real sentence ("...at 3247 Elm still
// under warranty", "...on file for Henderson"). Negative-lookahead'd out of
// every word slot below rather than trimmed after the fact, so the regex
// itself stops at the right word instead of over-capturing and needing
// cleanup. Listed in both Capitalized and lowercase form (rather than an
// 'i'-flagged regex) so the NAME regexes below can stay genuinely case-
// SENSITIVE on the actual name they capture — a real customer/company name is
// always capitalized in these phrasings, and losing that requirement is what
// let "on file for Henderson" capture "file" as the name.
const STOP_WORDS_LOWER = [
  'is', 'are', 'was', 'were', 'does', 'did', 'do', 'still', 'under', 'warranty',
  'covered', 'valid', 'good', 'expire', 'expires', 'expired', 'take', 'takes',
  'need', 'needs', 'has', 'have', 'the', 'what', 'who', 'when', 'where', 'why',
  'which', 'how', 'file', 'record', 'on', 'for', 'at', 'in',
  'last', 'latest', 'recent',
];
const STOP_WORD_VARIANTS = STOP_WORDS_LOWER.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1)]);
const STOP_WORD = `(?:${STOP_WORD_VARIANTS.join('|')})`;

// No street-type word printed ("at 3247 Elm", "at 1519 W Juniper") — still a
// real address fragment, just needs an anchor word so a bare "3247" floating
// in a sentence (a year, a dollar figure) isn't mistaken for one. "for" is
// included alongside "at"/"on" ("what did the invoice come to for 1519 W
// Juniper"). Each word slot refuses a STOP_WORD so "at 3247 Elm still under
// warranty" stops at "Elm" instead of swallowing the rest of the sentence.
const LOOSE_ADDRESS_RE = new RegExp(
  `\\b(?:at|on|for|to|serviced?|installed)\\s+(\\d{1,6}(?:\\s+(?!${STOP_WORD}\\b)[A-Za-z][A-Za-z']*){1,3})`,
  'i'
);

// Identifier: alnum, >= 8 chars, at least one digit — the shape a serial or a
// model number takes on real HVAC paperwork (see extractFields.js FIELD_SPECS
// examples). A bare 4-digit year or a short word never qualifies.
const IDENTIFIER_RE = /\b[A-Za-z0-9][A-Za-z0-9-]{7,}\b/g;

const NAME_HINT_RE = new RegExp(`\\b(?:for|at|on)\\s+(?!${STOP_WORD}\\b)([A-Z][A-Za-z'&.-]+(?:\\s+[A-Z][A-Za-z'&.-]+){0,3})(?:'s)?\\b`);
const POSSESSIVE_NAME_RE = new RegExp(`\\b(?!${STOP_WORD}\\b)([A-Z][A-Za-z'-]+(?:\\s+[A-Z][A-Za-z'-]+)?)'s\\b`);
const THE_NAME_NOUN_RE =
  /\bthe\s+([A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2})\s+(?:unit|account|job|customer|install(?:ation)?|condenser|furnace|job site)\b/i;
// "does Henderson have/need/take" — a name with no leading preposition at all.
const DOES_NAME_HAVE_RE = new RegExp(`\\bdoes\\s+(?!${STOP_WORD}\\b)([A-Z][A-Za-z'-]+(?:\\s+[A-Za-z'-]+){0,2})\\s+(?:have|need|take)\\b`);

/** A name candidate that's really a customer-number fragment ("C-", "C")
 *  or too short to be a real name — discarded rather than returned, since
 *  extractSubject already captures the real customer number separately and
 *  resolution checks it first regardless. */
function isJunkName(s) {
  if (!s) return true;
  const t = s.trim();
  return t.length < 3 || /^c-?$/i.test(t);
}

const ORDINAL_RE = /\b(last|latest|most recent)\b/i;
const UNIT_TYPE_RE = /\b(condenser|air handler|furnace|heat pump|package unit|rtu|mini[- ]?split)\b/i;

/** Pure: free text -> best-effort subject hints. Never throws, never null —
 *  callers check `.hasAny` / individual fields. */
export function extractSubject(question) {
  const q = String(question ?? '');

  const numMatch = q.match(CUSTOMER_NUMBER_RE);
  const customerNumber = numMatch ? `C-${numMatch[1]}` : null;

  let address = null;
  const strongAddr = q.match(ADDRESS_RE);
  if (strongAddr) address = strongAddr[1].trim();
  else {
    const looseAddr = q.match(LOOSE_ADDRESS_RE);
    if (looseAddr) address = looseAddr[1].trim();
  }

  let identifier = null;
  for (const tok of q.match(IDENTIFIER_RE) ?? []) {
    if (/\d/.test(tok) && !/^\d{1,6}$/.test(tok)) { identifier = tok; break; }
  }

  let name = null;
  const hint = q.match(NAME_HINT_RE);
  if (hint && !isJunkName(hint[1])) name = hint[1].trim();
  if (!name) {
    const poss = q.match(POSSESSIVE_NAME_RE);
    if (poss && !isJunkName(poss[1])) name = poss[1].trim();
  }
  if (!name) {
    const theNoun = q.match(THE_NAME_NOUN_RE);
    if (theNoun && !isJunkName(theNoun[1])) name = theNoun[1].trim();
  }
  if (!name) {
    const doesHave = q.match(DOES_NAME_HAVE_RE);
    if (doesHave && !isJunkName(doesHave[1])) name = doesHave[1].trim();
  }

  const ordinal = ORDINAL_RE.test(q) ? 'last' : null;
  const unitMatch = q.match(UNIT_TYPE_RE);
  const unitType = unitMatch ? unitMatch[1].toLowerCase() : null;

  const hasAny = Boolean(customerNumber || address || identifier || name);

  return { customerNumber, address, identifier, name, ordinal, unitType, hasAny };
}

/**
 * Pure: question -> {intent, subject} or null. The single entry point
 * api/ask.js and fastPathQuery.js use.
 *
 * `subject.anchored` records whether the question carried a domain anchor
 * (as opposed to only an extracted subject) — fastPathQuery.js's whole-tenant
 * "no subject named" fallback requires this explicitly (in addition to the
 * tenant having exactly one candidate) before it will answer, per the same
 * "never guess" rule as everywhere else in this file: reaching this function
 * at all already guarantees `subject.hasAny || subject.anchored`
 * (classifyIntent's own gate), but the fallback checks it again itself
 * rather than relying on that invariant holding at every future call site.
 */
export function classifyFastPath(question) {
  const intent = classifyIntent(question);
  if (!intent) return null;
  const subject = extractSubject(question);
  return { intent, subject: { ...subject, anchored: hasAnchor(question) }, raw: String(question ?? '') };
}

/** Pure: env-injectable so this is testable without mutating process.env. */
export function isFastPathEnabled(env = process.env) {
  return env?.ASK_FAST_PATH !== '0';
}

/* =============================================================== resolution
 * helpers (pure) — fastPathQuery.js does the actual SELECTs and passes plain
 * row arrays in here; nothing below touches a database.
 */

/** Words too generic to help an address ILIKE match; dropped before building
 *  the token list resolution matches against. Deliberately drops the street-
 *  TYPE word itself ("St"/"Street") rather than trying to normalize both
 *  spellings — the number + street NAME alone is specific enough, and this
 *  sidesteps "St" vs "Street" mismatches entirely. */
const ADDRESS_STOPWORDS = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
  'blvd', 'boulevard', 'way', 'ct', 'court', 'pl', 'place', 'cir', 'circle',
  'pkwy', 'parkway', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'suite', 'ste', 'apt', 'unit',
]);

// R11 (verify-doclookup.mjs item 9 regression): a full state NAME ("Arizona") is the same
// disambiguating information as its abbreviation ("AZ") — the abbreviation was already never
// required (2 letters, filtered by the length>=3 check below), so requiring the spelled-out form
// only when the caller happened to spell it out was an inconsistency, not a real distinction, and
// broke a same-address match where the query spelled the state out and the stored record didn't.
// Single-word state names only (this corpus is Arizona-only; a two-word state name splits into
// two regex tokens anyway and isn't worth the added risk of over-stripping a real street word).
const STATE_NAME_WORDS = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming',
]);

// R11 (verify-doclookup.mjs item 9 regression): a unit/suite/apartment NUMBER named on only one
// side (a customer's own street address rarely repeats a caller's "Apt 101"/"Suite 200" in every
// question, and the stored service_address may have been entered without it at all) is not
// house-number-strength disambiguation the way a street name, city or zip is — it's exactly the
// kind of over-specific token this file's own comment above warns about matching too strictly on.
// The designator word itself was already an ADDRESS_STOPWORDS entry; this only additionally drops
// the NUMBER immediately following one, so "Apt 101" contributes nothing to the required set
// while the address's own house number (never preceded by a unit designator) still does.
const UNIT_DESIGNATOR_WORDS = new Set(['apt', 'suite', 'ste', 'unit']);

/** Pure: an address fragment -> the tokens worth requiring in an ILIKE match
 *  (each token becomes one `%token%` ANDed via ILIKE ALL — see
 *  fastPathQuery.js). Keeps the house number and any word of length >= 3 not
 *  in ADDRESS_STOPWORDS/STATE_NAME_WORDS, and drops a unit/suite/apt number
 *  (see UNIT_DESIGNATOR_WORDS above). Empty input -> empty list (caller must
 *  treat that as "can't resolve", never as "match everything"). */
export function significantAddressTokens(address) {
  const words = String(address ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const unitNumberIdx = new Set();
  for (let i = 0; i < words.length - 1; i++) {
    if (UNIT_DESIGNATOR_WORDS.has(words[i]) && /^\d+$/.test(words[i + 1])) unitNumberIdx.add(i + 1);
  }
  return words.filter((w, i) => !unitNumberIdx.has(i) && (/^\d+$/.test(w) || w.length >= 3) && !ADDRESS_STOPWORDS.has(w) && !STATE_NAME_WORDS.has(w));
}

/** Pure: does this list of candidate rows resolve to exactly one? Dedupes by
 *  `id` first (the same row can legitimately come back from more than one
 *  query path). Returns the single row, or null for zero OR more-than-one —
 *  ambiguity is never guessed through, per the file header. */
export function pickUnique(rows) {
  const byId = new Map();
  for (const r of rows ?? []) {
    if (r && r.id != null && !byId.has(r.id)) byId.set(r.id, r);
  }
  return byId.size === 1 ? [...byId.values()][0] : null;
}

/** Pure: matches the model path's own eligibility rule for a citation —
 *  api/_lib/recordsStore.js's searchPassages/searchExtractions apply NO stage
 *  filter at all (any document at any pipeline stage is real evidence once
 *  it's actually been extracted), so neither does the fast path. Kept as a
 *  named function, not an inline `true`, so a future change to the model
 *  path's eligibility rule has one obvious place here to update in lockstep
 *  — see scripts/verify-fastpath.mjs's stage-eligibility check. */
export function isStageEligible(_stage) {
  return true;
}

/** Pure: given every candidate extraction row for one field_key (already
 *  filtered to the resolved subject's own documents), pick the one the
 *  answer should cite — highest confidence, ties broken toward a verified
 *  document. Mirrors dedupe()'s tie rule in extractFields.js (confidence
 *  first) plus the model path's own verified-doc preference (answer.js
 *  shapeAnswer's verifiedCount logic). Returns null for an empty list. */
export function pickBestExtraction(rows) {
  const eligible = (rows ?? []).filter((r) => r && isStageEligible(r.stage));
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => {
    const verifiedDiff = (b.stage === 'verified' ? 1 : 0) - (a.stage === 'verified' ? 1 : 0);
    if (verifiedDiff) return verifiedDiff;
    const confDiff = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
    if (confDiff) return confDiff;
    return 0;
  })[0];
}

/** Pure: same idea, keyed by a date-shaped value (service_date, cost with a
 *  paired date) — used for "last"/"most recent" intents where the caller
 *  wants the newest row, not the highest-confidence one. Rows with no usable
 *  date sort last. Ties fall back to pickBestExtraction's ordering. */
export function pickMostRecent(rows) {
  const eligible = (rows ?? []).filter((r) => r && isStageEligible(r.stage));
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => {
    const ad = a.date ?? '';
    const bd = b.date ?? '';
    if (ad !== bd) return ad < bd ? 1 : -1;
    const verifiedDiff = (b.stage === 'verified' ? 1 : 0) - (a.stage === 'verified' ? 1 : 0);
    if (verifiedDiff) return verifiedDiff;
    return (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
  })[0];
}

/* ==================================================================== format */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Pure: 'YYYY-MM-DD' or 'YYYY-MM' -> "March 10, 2034" / "March 2034", the
 *  spoken style ANSWER_STYLE_RULES (answer.js) requires. Anything else is
 *  returned unchanged rather than mangled. */
export function formatDateHuman(ymd) {
  const s = String(ymd ?? '');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${MONTH_NAMES[mi]} ${Number(m[3])}, ${m[1]}`;
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${MONTH_NAMES[mi]} ${m[1]}`;
  }
  return s;
}

/** Pure: "1234.5" -> "$1,234.50". Non-numeric input passed through as-is. */
export function formatMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pure: a short human label for the resolved subject, used to open the
 *  answer sentence — "The Carrier condenser at 3247 Elm St" / "Henderson". */
export function subjectLabel(resolution) {
  if (resolution?.kind === 'equipment') {
    const d = resolution.equipment?.data ?? {};
    const descriptor = [d.manufacturer, d.equipment_type].filter(Boolean).join(' ');
    const at = d.service_address ? ` at ${d.service_address}` : '';
    return descriptor ? `The ${descriptor}${at}` : `The unit${at || ''}` || 'The unit';
  }
  if (resolution?.kind === 'customer') {
    const d = resolution.customer?.data ?? {};
    return d.customer_name || (resolution.customer?.customer_number ?? 'The customer');
  }
  return 'That';
}

/* =============================================================== answer building
 *
 * Everything below builds the exact shape /api/ask returns (see answer.js's
 * shapeAnswer output): {kind, text, facts, sources, confidence,
 * verifiedCount, unverifiedCount, closest, interpretation}. Pure: takes
 * already-fetched rows, returns a plain object; fastPathQuery.js is the only
 * caller and the only place that touches `db`.
 */

const FIELD_INTRO = {
  model: (label, value) => `${label} is a ${value}.`,
  serial: (label, value) => `${label}'s serial number is ${value}.`,
  manufacturer: (label, value) => `${label} is a ${value} unit.`,
  install_date: (label, value) => `${label} was installed on ${formatDateHuman(value)}.`,
  installer: (label, value) => `${value} installed ${label.replace(/^The /, 'the ')}.`,
  last_service_tech: (label, value) => `${value} was the last technician out to ${label.replace(/^The /, 'the ')}.`,
  last_service_date: (label, value) => `${label} was last serviced on ${formatDateHuman(value)}.`,
  service_address: (label, value) => `${label}'s service address is ${value}.`,
  customer_phone: (label, value) => `${label}'s phone number is ${value}.`,
  customer_email: (label, value) => `${label}'s email is ${value}.`,
  customer_name: (label, value) => `The customer is ${value}.`,
  refrigerant: (label, value) => `${label} takes ${value}.`,
  tonnage: (label, value) => `${label} is a ${value} unit.`,
  permit_number: (label, value) => `The permit number for ${label.replace(/^The /, 'the ')} is ${value}.`,
  invoice_total: (label, value) => `The most recent invoice for ${label.replace(/^The /, 'the ')} was ${formatMoney(value)}.`,
  agreement_term: (label, value) => `${label}'s maintenance agreement term is ${value}.`,
};

const FACT_LABEL = {
  model: 'Model', serial: 'Serial number', manufacturer: 'Manufacturer',
  install_date: 'Installed', installer: 'Installer', last_service_tech: 'Last technician',
  last_service_date: 'Last serviced', service_address: 'Service address',
  customer_phone: 'Phone', customer_email: 'Email', customer_name: 'Customer',
  refrigerant: 'Refrigerant', tonnage: 'Tonnage', permit_number: 'Permit number',
  invoice_total: 'Invoice total', agreement_term: 'Agreement term',
};

/**
 * Build the final answer object for a single field-lookup intent from the
 * already-resolved subject and the already-chosen best extraction row.
 * `row` is {document_id, field_key, value, confidence, stage} — exactly what
 * pickBestExtraction/pickMostRecent selects. Returns null only if the row is
 * missing (caller should already have checked this; kept here too since this
 * function is the contract boundary).
 */
export function buildFieldAnswer({ intent, resolution, row }) {
  if (!row || row.value == null || String(row.value).trim() === '') return null;
  const label = subjectLabel(resolution);
  const value = String(row.value);
  const intro = FIELD_INTRO[intent];
  const text = intro ? intro(label, value) : `${label}: ${value}.`;
  const displayValue =
    intent === 'invoice_total' ? formatMoney(value)
    : intent === 'install_date' || intent === 'last_service_date' ? formatDateHuman(value)
    : value;

  const fact = {
    label: FACT_LABEL[intent] ?? intent,
    value: displayValue,
    basis: 'printed',
    sources: [{ documentId: row.document_id, location: { field: row.field_key } }],
  };

  return {
    kind: 'answer',
    text,
    facts: [fact],
    sources: fact.sources,
    confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0.8)),
    interpretation: label,
    verifiedCount: row.stage === 'verified' ? 1 : 0,
    unverifiedCount: row.stage === 'verified' ? 0 : 1,
    closest: [],
    fastIntent: intent,
  };
}

/**
 * Warranty intents (warranty_expires / warranty_status). `stable` is the
 * equipment entity's already-computed `data.warranty` (deriveWarranty's
 * output, stored at ingest — see warrantyRules.js's module comment and
 * extractDocument.js). `citationRow` is whichever extraction backs the
 * expiry: the printed warranty_expires row when stable.expiresBasis ===
 * 'printed', or the installation_date row when it's 'computed' — the source
 * fact the arithmetic actually ran on. Returns null when there isn't enough
 * on file to say anything (no brand rule, no expiry, or no citation row) —
 * this is exactly where the fast path must defer rather than guess.
 */
export function buildWarrantyAnswer({ intent, resolution, stable, today, citationRow }) {
  if (!stable || !stable.expires || !citationRow) return null;
  const tier = alertTier(stable, today);
  if (tier === 'unknown') return null;
  const described = describeWarranty(stable, today);

  const label = subjectLabel(resolution);
  const dateHuman = formatDateHuman(stable.expires);
  const basis = stable.expiresBasis === 'computed' ? 'computed' : 'printed';
  const computedNote = basis === 'computed' ? ' (computed)' : '';

  let text;
  if (intent === 'warranty_status') {
    if (tier === 'expired') {
      text = `No — ${label}'s warranty expired ${dateHuman}${computedNote}.`;
    } else {
      const daysNote = described.daysToExpiry != null && tier !== 'ok'
        ? `, expiring in ${described.daysToExpiry} day(s)`
        : '';
      text = `Yes — ${label} is still under warranty${daysNote}, valid through ${dateHuman}${computedNote}.`;
    }
  } else {
    text = tier === 'expired'
      ? `${label}'s warranty expired ${dateHuman}${computedNote}.`
      : `${label}'s warranty expires ${dateHuman}${computedNote}.`;
  }

  const status = tier === 'expired' ? 'bad' : (tier === 'expiring-30' || tier === 'expiring-90') ? 'warn' : 'ok';
  const fact = {
    label: 'Warranty',
    value: `${dateHuman}${computedNote}`,
    status,
    basis,
    sources: [{ documentId: citationRow.document_id, location: { field: citationRow.field_key } }],
  };

  return {
    kind: 'answer',
    text,
    facts: [fact],
    sources: fact.sources,
    confidence: basis === 'printed' ? Math.max(0, Math.min(1, Number(citationRow.confidence) || 0.9)) : 0.85,
    interpretation: label,
    verifiedCount: citationRow.stage === 'verified' ? 1 : 0,
    unverifiedCount: citationRow.stage === 'verified' ? 0 : 1,
    closest: [],
    fastIntent: intent,
  };
}

/** equipment_list: `units` is recordsStore.js's listCustomerEquipment() rows. */
export function buildEquipmentListAnswer({ resolution, units, today }) {
  if (!units || units.length === 0) return null;
  const label = subjectLabel(resolution);
  const facts = units.map((u) => {
    const descriptor = [u.manufacturer, u.equipment_type].filter(Boolean).join(' ') || 'Equipment';
    const bits = [u.model, u.serial_number ? `serial ${u.serial_number}` : null].filter(Boolean).join(', ');
    const tier = u.warranty ? alertTier(u.warranty, today) : 'unknown';
    return {
      label: descriptor,
      value: bits || u.id,
      status: tier === 'expired' ? 'bad' : tier === 'expiring-30' || tier === 'expiring-90' ? 'warn' : tier === 'ok' ? 'ok' : 'muted',
      sources: [],
    };
  });
  return attachCitations({
    kind: 'answer',
    text: `${label} has ${units.length} piece${units.length === 1 ? '' : 's'} of equipment on file.`,
    facts,
    sources: [],
    confidence: 1,
    interpretation: label,
    verifiedCount: 0,
    unverifiedCount: 0,
    closest: [],
    fastIntent: 'equipment_list',
  }, {
    records: units.map((u) => unitRecord(u)), total: units.length, claimedCount: units.length,
    basis: `Listed every piece of equipment on file for ${label}.`,
  });
}

/** document_list_for_subject: `documents` is [{id, document_type, ...}], same
 *  shape recordsStore.js's listDocumentDetails() rows. */
export function buildDocumentListAnswer({ resolution, documents, documentTypeLabel }) {
  if (!documents || documents.length === 0) return null;
  const label = subjectLabel(resolution);
  const facts = documents.map((d) => ({
    label: documentTypeLabel ? documentTypeLabel(d.document_type) : (d.document_type ?? 'Document'),
    value: d.original_filename ?? d.id,
    sources: [{ documentId: d.id, location: {} }],
  }));
  return attachCitations({
    kind: 'answer',
    text: `${label} has ${documents.length} document${documents.length === 1 ? '' : 's'} on file.`,
    facts,
    sources: [],
    confidence: 1,
    interpretation: label,
    verifiedCount: 0,
    unverifiedCount: 0,
    closest: [],
    fastIntent: 'document_list_for_subject',
  }, {
    records: documents.map((d) => documentRecord(d, { label: `${documentTypeLabel ? documentTypeLabel(d.document_type) : (d.document_type ?? 'Document')} · ${d.original_filename ?? d.id}` })),
    total: documents.length, claimedCount: documents.length,
    basis: `Listed every document linked to ${label}.`,
  });
}
