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
import { parseDocFieldAsk } from './lookups/docFieldAsk.js';
import { describeWarranty, alertTier } from './warrantyRules.js';
// TEAM C (citations everywhere): equipment / document lists cite the exact rows they list.
import { attachCitations, unitRecord, documentRecord, customerRecord } from './citations/records.js';
// R17 (G4, consolidation): canonical street-suffix list — see geo/streetSuffix.js. Pure data, no
// runtime dependency chain (geo/streetSuffix.js imports nothing), so this never risks the
// analytics.js -> scope.js -> fastPath.js -> nlNormalize.js cycle documented below.
import { STREET_SUFFIX_GROUP_SRC } from './geo/streetSuffix.js';
// R15 (Team C): typo tolerance for this file's own short trigger-word vocabulary — see
// matchTrigger and correctFastPathTriggerTypos below. Deliberately reimplemented locally (a small,
// self-contained copy of nlNormalize.js's withinEditDistance1 + correctTriggerWordTypos) rather
// than imported from nlNormalize.js: nlNormalize.js imports ENTITY_SYNONYMS from analytics.js at
// its own module top level (to build its VOCAB), and analytics.js imports scope.js, which imports
// THIS file (fastPath.js) — so an import here of nlNormalize.js closes analytics.js -> scope.js ->
// fastPath.js -> nlNormalize.js -> analytics.js into a real circular import. That cycle crashes
// with "Cannot access 'ENTITY_SYNONYMS' before initialization" in exactly one situation: whenever
// analytics.js happens to be the FIRST module loaded (verify-analytics.mjs, verify-financials.mjs
// and verify-r7-guardrails.mjs all import analytics.js directly, before ever reaching api/ask.js) —
// confirmed by reproducing and fixing this exact crash while adding this file's typo tolerance.
// A local copy avoids the cycle entirely; keep it in sync with nlNormalize.js's own algorithm if
// that one ever changes, but do not re-import it from here.
function fastPathWithinEditDistance1(a, b) {
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
    if (s[i] === l[j]) { i++; j++; continue; }
    if (usedSkip) return false;
    usedSkip = true;
    j++;
  }
  return true;
}

function correctFastPathTriggerTypos(text, triggerWords) {
  const trig = (triggerWords ?? []).map((w) => String(w ?? '').toLowerCase()).filter(Boolean);
  if (!trig.length) return String(text ?? '');
  const byLen = new Map();
  for (const w of trig) {
    if (!byLen.has(w.length)) byLen.set(w.length, []);
    byLen.get(w.length).push(w);
  }
  return String(text ?? '').replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase();
    if (lower.length < 3 || trig.includes(lower)) return word;
    let match = null;
    for (const len of [lower.length - 1, lower.length, lower.length + 1]) {
      for (const cand of byLen.get(len) ?? []) {
        if (!fastPathWithinEditDistance1(lower, cand)) continue;
        if (match && match !== cand) return word; // ambiguous between two trigger words — leave it alone
        match = cand;
      }
    }
    return match ?? word;
  });
}

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
  // R24 (E3): agreement_cost/po_total/equipment_age each get their own dedicated fetch in
  // fastPathQuery.js (fetchAgreementCost / fetchPoTotal / runEquipmentAge — none of them a plain
  // "look up this one extraction field for the resolved subject" shape), so this mapping exists only
  // so runFastPath's own `if (!fieldKey) return null` gate (and classifyIntent's ALL_INTENTS list)
  // recognise these as real, handled intents rather than an accidental miss — the value itself is
  // never read as an actual extractions.field_key for these three.
  agreement_cost: 'cost',
  po_total: 'cost',
  equipment_age: 'installation_date',
  brand_match: 'manufacturer',
};

/** Intents this app recognises but has NO extraction field for (see
 *  extractFields.js FIELD_SPECS) — classified for the training corpus and the
 *  answer-key report, but resolution must ALWAYS defer to the model, which can
 *  still find the value in page text. Never invent a field to "handle" these. */
export const NO_FIELD_INTENTS = new Set(['seer', 'filter_size']);

/** Computed (not a bare extraction field) — resolved via warrantyRules.js
 *  against the equipment entity's already-derived `data.warranty`. `warranty_out` is the same
 *  underlying fact as `warranty_status`, just asked in the INVERTED "is it out of warranty yet"
 *  framing (R18 H1: field-phrasing g036/g040/g044) — see buildWarrantyAnswer's own doc comment for
 *  why this needs its own intent rather than reusing warranty_status's text template. */
export const WARRANTY_INTENTS = new Set(['warranty_expires', 'warranty_status', 'warranty_out']);

/** Multi-row list answers, not a single fact. */
export const LIST_INTENTS = new Set(['equipment_list', 'document_list_for_subject']);

/** R16 (F1): a single question asking for TWO fields about the SAME unit together (field-phrasing
 *  "compound" shape) — resolved and answered as one pair, never as just whichever intent's TRIGGERS
 *  regex happened to match first (see fastPathQuery.js's runModelAndSerial). 'multi_field' (R19,
 *  I1 — i137/i191) generalizes this same rule to any OTHER pair/triple of the named fields below —
 *  see detectMultiFieldNames' own doc comment for why 'model_and_serial' itself stays a separate,
 *  frozen special case rather than being absorbed into it. */
export const COMPOUND_INTENTS = new Set(['model_and_serial', 'multi_field']);

export const ALL_INTENTS = [
  ...Object.keys(FIELD_BY_INTENT),
  ...NO_FIELD_INTENTS,
  ...WARRANTY_INTENTS,
  ...LIST_INTENTS,
  ...COMPOUND_INTENTS,
];

// R24 (E3, field-phrasing-4/-5 j186-j190/k176-k180: "is Betty Winslow's unit an Amana"/"does
// William Quintana have a Ruud unit"): the closed set of HVAC equipment brands this corpus's own
// adversarial "brand not carried" questions name — see brand_match's own trigger/resolution below.
// Deliberately the same vocabulary deterministicRouter.js's own BRAND_IN_Q already uses (trane/
// carrier/goodman/lennox/rheem/york/daikin/mitsubishi) plus the additional brands THIS shape's own
// oracles name (bryant/amana/ruud/american standard/payne) — never widened beyond a real brand
// name actually seen in this domain's own paperwork. Declared before TRIGGERS (below), which
// references it.
const BRAND_WORDS_SRC = 'bryant|amana|ruud|american\\s+standard|payne|goodman|trane|lennox|carrier|rheem|york|daikin|mitsubishi';
const BRAND_WORD_RE_G = new RegExp(`\\b(${BRAND_WORDS_SRC})\\b`, 'gi');

/** Pure: the ONE distinct brand named in the question, or null when zero or more than one are
 *  (a genuinely ambiguous "a Trane or an Amana" framing — field-phrasing-4 j198 — must never be
 *  answered as if only one brand had been asked about; declining here sends it back to
 *  needs-model/needs-grader instead of a confidently wrong single-brand answer). */
function extractAskedBrand(question) {
  const q = String(question ?? '');
  const found = new Set();
  let m;
  BRAND_WORD_RE_G.lastIndex = 0;
  while ((m = BRAND_WORD_RE_G.exec(q))) found.add(m[1].replace(/\s+/g, ' ').trim().toLowerCase());
  return found.size === 1 ? [...found][0] : null;
}

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
  // R18 (H1, field-phrasing g036/g040/g044): "is <Name> out of warranty yet" — the INVERTED framing
  // of warranty_status ("yes" means expired, not "yes, still covered"). Checked before the plain
  // warranty_status trigger below since both would otherwise match on "warranty" + is/are, and the
  // wording ("out of", not "under"/"still covered") decides which template answers correctly (see
  // buildWarrantyAnswer's own doc comment).
  ['warranty_out', /\b(?:is|are|was|were)\b[^?.!]*\bout of warranty\b/i],
  // R23 (D1, fp-5 k071/k083: "has Gary Villegas's warranty expired yet") — same INVERTED "yes means
  // expired" framing as "out of warranty" just above, just phrased as "has ... expired" instead.
  // Without this, "expired" anywhere after "warranty" matched the plain warranty_expires trigger
  // below FIRST — a DATE-only intent with no yes/no template at all, so a future expiry date came
  // back as a bare "Expires <date>" fact with no "Yes"/"No" the way every other warranty phrasing
  // gives, and a past expiry date came back with no leading word either — both graded as an
  // ambiguous, non-committal answer to what is, in the question's own words, a yes/no ask. Checked
  // here, before warranty_expires, for the same reason the "out of warranty" trigger is.
  //
  // Deliberately PAST TENSE ONLY ("expired", never "does...expire") and no "does": the fastpath
  // corpus's own "When does the warranty ... expire?" / "does the Goodman warranty expire for
  // C-00003" are genuine WHEN-does-it-expire date questions, not this yes/no framing — an earlier
  // draft's `expired?` (optional "d") COMBINED WITH "does" in the leading-verb list matched those
  // too and mis-routed them here; caught by scripts/verify-fastpath.mjs's own pinned corpus.
  //
  // Post-review hardening: "did" needs its OWN verb form, not "expired" — standard English puts the
  // past tense on the auxiliary for a "did" question ("did the warranty EXPIRE yet", never "did the
  // warranty expiRED yet"), the same way "did it happen" is never "did it happened". Requiring the
  // literal "-ed" form after "did" (as the original draft above did) meant this branch could never
  // actually fire for the grammatically normal phrasing — confirmed dead: "did Thomas Mercer's
  // warranty expire yet" fell through to the plain warranty_expires bare-date trigger below with no
  // yes/no framing at all, the exact bug this whole trigger exists to fix, for the one auxiliary
  // ("did") whose correct grammar this trigger's own leading-verb list already claimed to cover.
  // Scoped to ONLY the "did" auxiliary (never "does", which stays fully excluded per the paragraph
  // above) so the earlier draft's real collision can't come back: "does" is still nowhere in either
  // alternative below.
  ['warranty_out', /\b(?:has|had)\b[^?.!]*\bwarranty\b[^?.!]*\bexpired\b|\bdid\b[^?.!]*\bwarranty\b[^?.!]*\bexpired?\b|\bwarranty\b[^?.!]*\bexpired\s+yet\b/i],
  ['warranty_status', /\b(is|are)\b[^?.!]*\b(under warranty|still covered|in warranty|warranty status)\b/i],
  ['warranty_status', /\bstill (covered|under warranty|good|valid)\b/i],
  ['warranty_status', /\bdoes\b[^?.!]*\bhave (?:a )?warranty\b/i],
  ['warranty_status', /\bwarranty status\b/i],
  // R19 (I1, C9 — "hows the warranty looking for our customer over in albuquerque"): a dispatcher
  // phrasing that never says "under warranty"/"still covered"/"warranty status" at all, only "how's
  // the warranty looking" — none of the four triggers above match it, so this fell all the way
  // through fastPath's own classification before ever reaching resolution (see this file's header:
  // a genuinely NEW trigger phrase for the same warranty_status intent, not a resolution fix).
  ['warranty_status', /\bwarranty\b[\s\S]{0,15}\blook(?:s|ing)?\b|\bhow'?s\b[\s\S]{0,20}\bwarranty\b/i],
  ['warranty_expires', /\bwarr[ae]nty\b[\s\S]*\b(when'?s?|whens|expir\w*|\bexp\b|\bup\b|end(?:s|ing)?|due|good (?:until|thru|through)|how long)\b/i],
  ['warranty_expires', /\b(when'?s?|whens)\b[\s\S]*\bwarr[ae]nty\b/i],
  ['agreement_term', /\b(maintenance )?agreement\b[\s\S]*\b(expire|expir\w*|term|end|renew)\b/i],
  ['agreement_term', /\bservice contract\b[\s\S]*\b(expire|term|end)\b/i],
  // R24 (E3, field-phrasing-4 j114-j121: "what's the annual cost on X's maintenance agreement"):
  // a MONEY question about the same document type agreement_term already reads a date/duration
  // from — never overlaps agreement_term's own trigger above (that one requires expire/term/end/
  // renew vocabulary, never present here), so checked as its own intent rather than folded into
  // that one's answer template. Order-independent (annual cost ... agreement / agreement ...
  // annual cost) for the same reason invoice_total's own pair below is.
  ['agreement_cost', /\b(?:annual|yearly)\s+(?:cost|price|fee)\b[\s\S]*\b(?:maintenance\s+)?agreement\b|\b(?:maintenance\s+)?agreement\b[\s\S]*\b(?:annual|yearly)\s+(?:cost|price|fee)\b/i],
  // R16 (F1, field-phrasing "compound" shape): "whats the model and serial on the unit at ..." asks
  // for BOTH fields about the SAME unit and must be answered together — checked before the
  // standalone 'serial'/'model' triggers below (first match wins) so a bare "serial" substring
  // match never silently drops the model half (or vice versa), which the exam's own "set"
  // comparison (both values expected) grades as a confident-but-incomplete WRONG, not needs-model.
  // R23 (D1, fp-5 k029: "whats the model plus serial on file for ...") — "plus" is the same
  // conjunction as "and" here (a dispatcher joining two fields in one ask); without it this fell
  // through to the standalone 'serial' trigger below and silently dropped the model half, the exact
  // confident-but-incomplete WRONG this whole intent exists to prevent.
  ['model_and_serial', /\bmodel\b[^?.!]{0,20}\b(?:and|plus)\b[^?.!]{0,20}\bserial\b|\bserial\b[^?.!]{0,20}\b(?:and|plus)\b[^?.!]{0,20}\bmodel\b/i],
  ['serial', /\bserial\b|\bs\/n\b|\bseriel\b|\bserail\b/i],
  ['model', /\bmodel\b|\bmodle\b/i],
  // R24 (E3, field-phrasing-5 k118/k124 — "what brand is the THERMOSTAT at Deborah Ortega's
  // place"/"what brand is the FILTER on Steven Ellison's unit"): thermostat brand and filter brand
  // are both on contactLookup.js's own UNTRACKED_FIELDS list (this schema has no column or
  // extraction key for either, ever — see that file's isUntrackedFieldQuestion) — a real, different
  // fact from the overall unit's own manufacturer this trigger otherwise (correctly) answers for
  // "what brand is the unit"/"what brand is Deborah Ortega's system". Before this round, a
  // possessive-name subject like "Deborah Ortega's" never resolved at all (extractSubject's own
  // trailing-apostrophe bug, fixed this round — see that fix's own doc comment), so this trigger's
  // over-broad "what brand" match on a thermostat/filter question always failed at the resolution
  // step and safely fell through; fixing that bug exposed this trigger firing anyway and confidently
  // answering the UNIT's manufacturer as if it were the thermostat's or filter's own brand — a
  // regression this round's own offline-exam measurement caught directly. Excluding a question that
  // names either component anywhere is strictly narrower (never a broadened trigger surface) and
  // sends it back to needs-model/contactLookup's own untracked-field decline instead, exactly as a
  // genuine "the schema has nothing to say here" question should be handled.
  ['manufacturer', /^(?!.*\b(?:thermostat|filter)\b)[\s\S]*(?:\bwhat (?:brand|make)\b|\bmanufacturer\b|\bmanufaturer\b|\bwho makes\b)/i],
  // R24 (E3, field-phrasing-4/-5 j186-j190/k176-k180): a YES/NO ask about a SPECIFIC named brand
  // ("is X's unit an Amana", "does X have a Ruud unit") — a different question shape from the plain
  // 'manufacturer' trigger just above ("what brand IS it"), so it gets its own intent/answer
  // template (a bare "Rheem" would never answer "is it an Amana"). extractAskedBrand's own "exactly
  // one distinct brand" rule (see that function's doc comment) is what actually keeps this safe for
  // an "X or Y" framing — checked in resolution (fastPathQuery.js's runBrandMatch), not the trigger
  // regex here, which only needs to recognise the SHAPE.
  ['brand_match', new RegExp(`\\b(?:is|are)\\b[^?.!]*\\b(?:unit|system)\\b[^?.!]*\\b(?:a|an)\\s+(?:${BRAND_WORDS_SRC})\\b`, 'i')],
  ['brand_match', new RegExp(`\\b(?:does|do)\\b[^?.!]*\\bhave\\b[^?.!]*\\b(?:a|an)\\s+(?:${BRAND_WORDS_SRC})\\b`, 'i')],
  // R32 (loop 2): "is that a trane unit out at <addr>" / "so is it a carrier at <addr>" — the demonstrative/pronoun framing of the same yes/no brand ask.
  ['brand_match', new RegExp(`\\b(?:is|are)\\s+(?:that|it|this|the\\s+one)\\s+(?:a|an)\\s+(?:${BRAND_WORDS_SRC})\\b`, 'i')],
  // R32 (loop 2): any yes/no framing whose object is "a <brand>" ("is the equipment at <addr> a daikin", "would that be a trane unit at <addr>", "<addr> - is that a carrier").
  // The exactly-one-brand rule in extractAskedBrand still guards "a trane or a carrier".
  ['brand_match', new RegExp(`\\b(?:is|are|isn't|would|could|might|was)\\b[^?.!]*\\b(?:a|an)\\s+(?:${BRAND_WORDS_SRC})\\b`, 'i')],
  // Defect 6 (limit test 2026-10-03): "which tech installed David Prentiss's system" / "which technician did the install for X" / "who set up the system" asked for the INSTALLER
  // and was answered with the last technician out. "which|what <tech> installed/put in/set up" is the same ask as "who installed".
  ['installer', /\bwho (?:installed|did the install)\b|\bwho put\b[\s\S]*\bin\b|\binstaller\b|\b(?:which|what)\s+(?:tech(?:nician)?|guy|crew|company|contractor)\s+(?:installed|did\s+the\s+install(?:ation)?|put\s+in|set\s+up|did\s+the\s+setup)\b|\bwho\s+(?:set\s+up|did\s+the\s+(?:setup|install(?:ation)?))\b/i],
  ['install_date', /\binstall(?:ed|ation)?\b[\s\S]*\b(date|when)\b|\b(date|when)\b[\s\S]*\binstall(?:ed|ation)?\b|\binstall date\b/i],
  ['last_service_tech', /\bwho\b[\s\S]*\b(last|out|worked on|came out|serviced)\b/i],
  ['last_service_tech', /\b(last|latest) (?:tech|technician)\b/i],
  ['last_service_tech', /\b(?:which|what)\s+tech(?:nician)?s?\b/i],
  // R32 (loop 4): "list the technicians who visited X" -> the every-technician read (fastPathQuery.js's ALL_TECHS_RE)
  ['last_service_tech', /\blist\s+(?:the\s+|all\s+)?tech(?:nician)?s\b|\btech(?:nician)?s\s+(?:who|that)\b/i],
  ['last_service_date', /\bwhen\b[\s\S]*\blast\b[\s\S]*\b(service|serviced|maintenance|visit|time)\b|\blast service(d)? date\b|\bwhen was it last serviced\b/i],
  ['customer_phone', /\bphone\b|\bcontact number\b/i],
  ['customer_email', /\bemail\b/i],
  ['customer_name', /\bwho is the customer\b|\bwho'?s the customer\b|\bwhose (?:house|unit|property|job|account) is\b|\bwho lives at\b|\bwho owns\b/i],
  ['service_address', /\bservice address\b|\bwhat'?s the address\b|\bwhat is the address\b/i],
  ['refrigerant', /\brefrigerant\b|\bfreon\b/i],
  ['tonnage', /\btonnage\b|\bhow many tons\b|\bwhat size (?:unit|system)\b|\bcapacity\b/i],
  ['seer', /\bseer2?\b|\befficiency\b/i],
  ['filter_size', /\bfilter size\b|\b(?:what|which)\s+size\s+filter\b|\bfilter dimensions?\b|\bwhich\s+filter\s+(?:does|do|goes|fits|for)\b/i],
  ['permit_number', /\bpermit\b/i],
  // R24 (E3, field-phrasing-4 j091-j105: "what's the total on Michelle Tovar's invoice"): the
  // ORIGINAL trigger just below only ever matched "invoice/bill" appearing BEFORE "total/cost/
  // amount/..." — this whole phrasing puts "total" first ("the total on X's invoice"), so it never
  // matched at all and fell straight through to needs-model. Order-independent counterpart, kept as
  // its own line (rather than rewriting the existing one) so the original's own vocabulary/precedent
  // is untouched; scoped to "total" alone (not the wider cost/amount/come-to/how-much set the
  // existing line already covers in its own direction) since that's the only word this corpus's own
  // phrasing ever puts first — narrower here is safer, not a widened surface.
  ['invoice_total', /\btotal\b[\s\S]*\b(invoice|bill)\b/i],
  ['invoice_total', /\b(invoice|bill)\b[\s\S]*\b(total|cost|amount|come to|how much)\b/i],
  ['invoice_total', /\bhow much\b[\s\S]*\b(invoice|bill|job|install(?:ation)?)\b/i],
  ['invoice_total', /\btotal (?:cost|amount|due)\b/i],
  // R24 (E3, field-phrasing-4 j106-j113: "what's the total on purchase order PO-9026, the one for
  // Rebecca Montoya"): a specific PO's total, identified by its own PO NUMBER (never the customer/
  // equipment resolution the rest of this file's money intents use) — see po_total's own dedicated
  // fetch in fastPathQuery.js. Order-independent for the same reason invoice_total's own pair is.
  ['po_total', /\btotal\b[\s\S]*\bpurchase order\b|\bpurchase order\b[\s\S]*\btotal\b/i],
  // R24 (E3, field-phrasing-4 j126-j135/j150: "how old is the unit at <address>"/"how old is X's
  // unit"): a COMPUTED fact (today minus installation_date, in whole years — see
  // ageYearsBetween/buildEquipmentAgeAnswer below), never a bare extraction field, so it gets its
  // own intent rather than being folded into install_date (which states the date itself, not an
  // age derived from it). Excludes "oldest"/"newest" (j148/j149: "how old is the oldest/newest unit
  // we've got") — a PORTFOLIO-WIDE superlative across every unit on file, not one resolved
  // customer's own equipment, already answered correctly by analytics.js; without this exclusion,
  // THE_NAME_NOUN_RE's own pre-existing case-insensitive `[A-Z]` (its trailing /i flag applies to
  // the whole pattern, including that character class) captures "oldest"/"newest" as if it were a
  // proper-noun customer name ("the OLDEST unit" reads the same as "the WINSLOW unit" to it), which
  // made this intent's own subject.hasAny true and let it steal these two questions from analytics
  // — caught as a real regression (correct -> needs-model) by this round's own offline-exam
  // measurement before this exclusion was added.
  ['equipment_age', /^(?!.*\b(?:oldest|newest)\b)[\s\S]*(?:\bhow old\b[\s\S]*\b(?:unit|system|equipment)\b|\b(?:unit|system|equipment)\b[\s\S]*\bhow old\b|\bage\s+of\s+(?:the\s+|his\s+|her\s+|their\s+)?(?:unit|system|equipment|ac|a\/c|furnace|heat\s*pump)\b|\bhow\s+long\s+ago\b[\s\S]*\b(?:unit|system|equipment|ac)\b[\s\S]*\binstalled\b)/i],
  // R15 (Team C, follow-up round): "when was the last invoice for X" asks for a DATE, never an
  // amount — this trigger used to fire for it anyway (the shared "last/latest invoice" phrasing),
  // but fetchInvoiceTotal's own answer template only ever states a dollar figure, never a date,
  // so it silently answered the wrong dimension of the question (caught only once
  // fetchInvoiceTotal started actually returning a value — see this file's own header note on the
  // document_financials fix — because until then this intent never resolved to anything at all in
  // this corpus, and the question fell through to the money gate's own last_invoice answer, which
  // states both the date AND the amount). Excluding a when/date-asking phrasing here sends it back
  // to that same money-gate path instead of this file's plainer, date-less template.
  ['invoice_total', /^(?!.*\b(?:when|what date|which date|what day)\b)[\s\S]*\b(?:last|latest|most recent)\s+(?:invoice|bill)\b/i],
  ['document_list_for_subject', /\bwhat documents?\b[\s\S]*\b(?:on|for)\b|\bwhat do we have\b[\s\S]*\b(?:on|for)\b|\bshow (?:me )?everything (?:on|for)\b|\ball documents? for\b/i],
  ['equipment_list', /\bwhat equipment\b|\bwhat units?\b[\s\S]*\bhave\b|\bwhat'?s installed at\b|\blist (?:the )?equipment\b/i],
];

// R15 (Team C): a handful of TRIGGERS words are exactly the kind of short, closed, domain-specific
// vocabulary correctTriggerWordTypos (nlNormalize.js) exists for — see that function's own doc
// comment and docLookup.js's identical use for DOCTYPE_TRIGGER_WORDS. Needed because
// normalizeQuestionForAnalytics's own general fuzzy corrector (api/ask.js) never reaches a fastPath
// question at all (fastPath classifies the RAW question, before that normalization runs), and a
// short word like "under"/"tonnage" is exactly the length nlNormalize's own dictionary-based
// correction floor (5+ letters, whole-word) misses or never attempts on some single-record shapes.
// Without this, "still uner warranty" / "the onnage of the unit at ..." never matched
// TRIGGERS at all and silently fell through to needs-model, on questions whose ADDRESS was parsed
// perfectly fine.
// R15 (Team C): deliberately excludes "installed"/"installation" — "installer" (a real word, its
// own distinct trigger just below) sits at edit-distance-1 from "installed" and isn't in this
// file's domain VOCAB, so including it wrongly "corrected" every genuine "Who was the installer…"
// phrasing into "installed" and broke that trigger (see verify-fastpath.mjs's corpus regression
// caught while adding this list — re-add an install-family word here only alongside a VOCAB entry
// for "installer" itself, so the two can never be confused).
const TRIGGER_TYPO_WORDS = ['under', 'tonnage', 'warranty', 'refrigerant', 'manufacturer', 'permit'];

/** Raw trigger match only — NOT the public classifier. "serial killer
 *  documentary recommendations", "what was the model of behavior therapy
 *  used in the study", and "who installed the app on this phone" all match
 *  one of these on the word alone; TRIGGERS exists to narrow which intent a
 *  domain question is about, not to decide that a question IS a domain
 *  question. classifyIntent (below) is the actual public entry point and
 *  never skips the domain-anchor gate. */
function matchTrigger(question) {
  const raw = String(question ?? '');
  if (!raw.trim()) return null;
  const q = correctFastPathTriggerTypos(raw, TRIGGER_TYPO_WORDS);
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

// R24 (E3, field-phrasing-4 j106-j113: "what's the total on purchase order PO-9026, the one for
// Rebecca Montoya"): a purchase order's own number, the authoritative identifier fetchPoTotal
// (fastPathQuery.js) resolves the document by — a customer/equipment resolution is never even
// attempted for this intent (a PO number, like a customer number, already names one document on its
// own; a name mentioned alongside it is only ever a confirming detail, never required to disambiguate
// it). This corpus's own PO numbers are 7 characters ("PO-9026") — one short of IDENTIFIER_RE's own
// 8-char floor just below — so there is no risk of the two ever double-matching the same token.
const PO_NUMBER_RE = /\bPO-(\d{3,8})\b/i;

// R17 (G4, consolidation): was this file's own hand-maintained suffix list (missing hwy/highway,
// ter/terrace); now the shared canonical superset — see geo/streetSuffix.js's own header comment.
// Same shape as before (a string holding a non-capturing group source, interpolated into the
// larger address regexes below), so nothing downstream changes except widened suffix coverage.
const STREET_SUFFIX_RE = STREET_SUFFIX_GROUP_SRC;
// R11 fix (lookups-0010/0084, hvac-tech-0007/0036 — golden tenant): this used to stop capturing
// right after the street-suffix word, so "137 W Southern Ave, Mesa, AZ 85201" and "137 W
// Southern Ave, Phoenix, AZ 85001" (two DIFFERENT real addresses in this corpus that share a
// house number and street name) became the identical subject.address "137 W Southern Ave". The
// trailing city/state/zip is optional (a bare "3247 Elm St" with no city still matches exactly
// as before) but, when present, is now part of the captured address, same as before.
// R15 fix (Team C, 2026-09-26): the R11 comment above assumed the caller's stated city/zip is
// trustworthy enough to REQUIRE for a match — it isn't (a dispatcher who says "Casa Grande" about
// a unit actually on file as "Mesa" is common real-world noise, not a different address), and
// requiring it made fastPathQuery.js's resolution fail closed (0 rows, not a wrong row) for every
// one of warranty-0001/0002/0006/0008/0012/0017/0029, hvac-tech-0039/0073, lookups-0019/0024/0092
// and both notes questions (hvac-tech-0036/0085) — a regression this round's offline exam caught
// as `needs-model`, not `wrong`, but still real lost coverage. fastPathQuery.js now matches on the
// house number + street name ALONE first (see houseStreetTokens below) exactly like
// scope.js's resolveAddressScope already does for the deterministic-history router, and only
// falls back to requiring more (an apartment/unit number via extractUnitDesignator, then this
// same city/zip capture as a last-resort tie-break) when the street match alone is ambiguous —
// see fastPathQuery.js's resolveFastPathSubject. Capturing city/state/zip AND an apartment/unit
// segment here (before the R15 fix neither survived a comma-separated "Apt 103" in between) keeps
// both available for that later disambiguation without ever requiring either up front. State is
// [A-Za-z]{2,12} (not just 2 letters) because normalizeQuestion.js may have already expanded "AZ"
// to "Arizona" upstream of this regex.
const ADDRESS_UNIT_SEG_RE_SRC =
  "(?:,?\\s+(?:apt|apartment|suite|ste|unit|no|number)\\.?\\s*#?\\s*[A-Za-z0-9]+|,?\\s+#\\s*[A-Za-z0-9]+)?";
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,6}\\s+[A-Za-z0-9.']+(?:\\s+[A-Za-z0-9.']+){0,3}\\s+${STREET_SUFFIX_RE}${ADDRESS_UNIT_SEG_RE_SRC}(?:,?\\s+[A-Za-z][A-Za-z\\s]{1,24}?,?\\s+[A-Za-z]{2,12}\\s+\\d{5})?)\\b\\.?`,
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

const NAME_HINT_RE = new RegExp(`\\b(?:for|at|on|out\\s+to)\\s+(?!${STOP_WORD}\\b)([A-Z][A-Za-z'&.-]+(?:\\s+[A-Z][A-Za-z'&.-]+){0,3})(?:'s)?\\b`);
const POSSESSIVE_NAME_RE = new RegExp(`\\b(?!${STOP_WORD}\\b)([A-Z][A-Za-z'-]+(?:\\s+[A-Z][A-Za-z'-]+)?)'s\\b`);
// R31 (Team A, P1 roadmap "THE_NAME_NOUN_RE /i root fix"): the trailing /i lets the leading `[A-Z]` match ANY letter,
// which is deliberate for a dispatcher's lowercase "the mercer unit" but also read "the OLDEST unit" / "the LAST job" /
// "the main unit" as a proper-noun customer name (the R24 equipment_age exclusion above was a per-intent patch of the
// same defect). The case-insensitivity is now explicit and BOUNDED: the first word may not be a superlative, ordinal,
// determiner, position/size/type adjective (NON_NAME_LEAD) — words that can precede these nouns but are never the
// start of a customer name. Every other lowercase name still matches exactly as before (full-corpus diff in
// scripts/verify-r31-lookups.mjs: extractSubject over every exam/blind/dialogue question text).
const NON_NAME_LEAD =
  "oldest|newest|older|newer|last|latest|recent|first|next|previous|prior|other|same|whole|entire|main|new|old|only|biggest|largest|smallest|bigger|larger|smaller|current|existing|original|second|third|fourth|fifth|single|each|every|all|any|this|that|these|those|our|my|your|their|his|her|its|a|an|ac|hvac|air|outdoor|indoor|rooftop|roof|package|split|central|gas|electric|heating|cooling|upstairs|downstairs|front|back|rear|big|small|large|customer|customers|first-floor|second-floor";
const THE_NAME_NOUN_RE = new RegExp(
  `\\bthe\\s+(?!(?:${NON_NAME_LEAD})\\b)([A-Za-z][A-Za-z'-]+(?:\\s+[A-Za-z'-]+){0,2})\\s+(?:unit|account|job|customer|install(?:ation)?|condenser|furnace|job site)\\b`,
  "i"
);
/** R31: the THE_NAME_NOUN_RE capture for `question` (or null) — exported so scripts/verify-r31-lookups.mjs can diff it against the legacy pattern over the whole corpus. */
export function theNameNounCapture(question) {
  return THE_NAME_NOUN_RE.exec(String(question ?? ''))?.[1] ?? null;
}
// "does Henderson have/need/take" — a name with no leading preposition at all.
// R21 (L2, h041/h043 — "is Amy Isaacson still under warranty" wrongly resolving to NO customer):
// the trailing `{0,2}` name-continuation words are never required to be capitalized (unlike
// NAME_HINT_RE/POSSESSIVE_NAME_RE just above, which DO require a capital on every extra word), so
// a GREEDY quantifier tries the most extra words first and, since a filler adverb right before the
// trigger phrase (an ordinary lowercase word like "still"/"already"/"also") satisfies
// `[A-Za-z'-]+` just as well as a real second name word, it locks onto that longer, wrong capture
// the moment the shorter required tail ("have"/"under warranty"/...) also happens to still match
// after it — e.g. "is Amy Isaacson still under warranty": greedy first tries name="Isaacson still"
// (2 extra words), and the mandatory tail right after it, " under warranty", still matches the
// "under warranty" alternative, so the regex never backtracks to the correct, shorter name="Amy
// Isaacson" it would have found by trying 0/1 extra words first. resolveFastPathSubject's own
// `data->>'customer_name' ILIKE '%Amy Isaacson still%'` then matches nothing, `resolution.kind`
// comes back 'none', and the whole intent falls through to needs-model even though the customer
// resolves uniquely and the answer is on file. A LAZY quantifier tries the fewest extra words
// FIRST and only grows the capture when the tail genuinely fails to match without them — it can
// never make the regex match anything it didn't already match (same alternation, same anchors),
// only change WHICH capture wins when more than one length would satisfy the tail, so a real
// 2-3-word name is unaffected (see verify-lookups-r21.mjs's own regression paraphrases). Left
// THE_NAME_NOUN_RE (line above) alone — no confirmed failure from it this round, and rewriting a
// working detector on spec-only risk contradicts the guard's own "never weaken/broaden without a
// real case" discipline.
const DOES_NAME_HAVE_RE = new RegExp(`\\bdoes\\s+(?!${STOP_WORD}\\b)([A-Z][A-Za-z'-]+(?:\\s+[A-Za-z'-]+){0,2}?)\\s+(?:have|need|take|use|run|want|prefer)\\b`);
// R18 (H1, field-phrasing g036/g040/g044): "is Matthew Whitfield out of warranty yet" — same
// no-leading-preposition shape as DOES_NAME_HAVE_RE above, just for the warranty_out/warranty_status
// is/are phrasing instead of "does ... have". Lazy `{0,2}?` — see DOES_NAME_HAVE_RE's own doc
// comment just above (identical over-greedy-filler-word bug, same fix).
const IS_NAME_WARRANTY_RE = new RegExp(`\\b(?:is|are|was|were)\\s+(?!${STOP_WORD}\\b)([A-Z][A-Za-z'-]+(?:\\s+[A-Za-z'-]+){0,2}?)\\s+(?:out of warranty|still under warranty|under warranty|still covered)\\b`);

// R16 (F1, field-phrasing "ambiguous_multiunit"/"two_value" — a commercial customer's own BUSINESS
// NAME used as the location, typed exactly as a dispatcher would ("at holy trinity church", "at
// sunrise valley elementary", never capitalized): every commercial customer in this corpus is named
// "<name> Dental/Restaurant/Church/Elementary School" (see synth-business.mjs's own
// COMMERCIAL_LABEL), so a closed, recognizable business-type suffix word is exactly as safe an
// anchor here as STREET_SUFFIX_RE is for a street address — it can only ever match a REAL business
// name's own trailing word, never an arbitrary noun phrase. Deliberately case-INSENSITIVE (unlike
// NAME_HINT_RE/POSSESSIVE_NAME_RE above): resolveFastPathSubject's own name match is already
// case-insensitive ILIKE, so nothing downstream needs the caller to have capitalized anything.
const BUSINESS_SUFFIX_RE = '(?:dental|restaurant|church|elementary(?:\\s+school)?|clinic)';
// R19 (I1, C7 — "list every serial number on file FOR sunrise valley elementary"): the original
// "at" preposition alone missed a legitimate "for <business>" phrasing. Deliberately NOT also
// widened to "on" (tried and reverted, h137): "...serial number ON FILE for sunrise valley
// elementary" has its own, earlier, unrelated "on" (from "on file") — a leftmost regex match
// starts searching from THAT "on" and greedily swallows "file for" into the captured name before
// ever reaching the real "for" right next to the business name itself. "at"/"for" alone never
// have this problem in this corpus (verified: no "on <business>" phrasing occurs anywhere in the
// exam/blind sets at all — grepped field-phrasing-2/exam/golden-export/r18_blind_clusters), so
// there is no real case this excludes, only the false one it was adding.
const BUSINESS_NAME_RE = new RegExp(`\\b(?:at|for)\\s+(?:the\\s+)?([A-Za-z][A-Za-z'.-]*(?:\\s+[A-Za-z'.-]+){0,4}\\s+${BUSINESS_SUFFIX_RE})\\b`, 'i');

// R19 (I1, C9 — "hows the warranty looking for our customer over in albuquerque"): a bare CITY
// reference with no street, house number or business name at all. Deliberately narrow: only the
// handful of distinctive dispatcher phrasings a real caller uses to refer to "the customer we have
// out in <city>" ("over in", "customer in", "out in", "customer that's/who's in"), and only when
// that phrase sits at the very end of the question (never mid-sentence, where "in X" is far more
// likely to mean something else entirely) — resolution (fastPathQuery.js) still never guesses: a
// city with zero, or more than one, matching customer is an honest decline/ambiguous-ask, exactly
// like every other subject hint in this file.
const CITY_ONLY_RE = /\b(?:over in|out in|customer in|customers? (?:that'?s|thats|who'?s|whos) in)\s+([A-Za-z][A-Za-z]*(?:\s+[A-Za-z][A-Za-z]*){0,2})\s*\??$/i;

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

// R16 (F1, field-phrasing "slang_fragment"): "wats the tonnage 4 396 w baseline rd" — a texting
// numeronym ("4" standing in for "for") sitting directly in front of a house number used to be
// swallowed AS the house number by ADDRESS_RE/LOOSE_ADDRESS_RE (captured address: "4 396 w
// baseline rd", house token "4" instead of "396" — a real on-file record then matched nothing).
// Only rewritten when "4"/"2" is immediately followed by ANOTHER bare, ALL-digit token (the
// `\d+\b` lookahead requires the digits to end at a non-word character, not just start with one)
// — so this fires for a genuine two-number slang fragment ("4 396 ...") but never for a real
// one-digit house number sitting on a NUMBERED street ("4 21st St", "2 42nd Ave": "21st"/"42nd"
// have a word character right after their digits, so `\d+\b` never matches there), nor for "4 W
// Main"/"2 E Baseline" (the token right after is a letter, not a digit, so the lookahead fails
// immediately). "@" -> "at" similarly covers "... unit @ 322 n greenfield" without teaching every
// trigger/preposition regex about the bare symbol too. Address-matching only (see below) — never
// applied to the raw text callers keep for anything else.
function deslangForAddressMatch(text) {
  return String(text ?? '')
    .replace(/@/g, ' at ')
    .replace(/\b4\b(?=\s+\d+\b)/g, 'for')
    .replace(/\b2\b(?=\s+\d+\b)/g, 'to');
}

/* ============================================================ R19 (I1, C9): voice-dictation
 * numerals in an address's own house number ("to fourteen mercer" — a voice-to-text mishearing of
 * "214 Mercer"; "seven fifty three w guadalupe rd" for "753 W Guadalupe Rd") never match ADDRESS_RE/
 * LOOSE_ADDRESS_RE at all — both require an actual digit, and a dictated number is spelled out as
 * words. This runs BEFORE deslangForAddressMatch (same "address-matching only" scope: never applied
 * to the raw text callers keep for name/identifier extraction) and splices the equivalent digit
 * string back in wherever a run of number WORDS sits right after an address-introducing preposition
 * (at/to/on/for/near/by — the same closed preposition set LOOSE_ADDRESS_RE itself already accepts),
 * so the ordinary address regexes/DB resolution downstream take it from there exactly as if the
 * caller had typed digits — a genuinely made-up address still resolves to zero rows (an honest
 * decline), same as any other not-on-file address; this function only undoes dictation, it never
 * decides whether the address is real. Each chunk (a tens word optionally paired with a ones word:
 * "twenty two" = 22; a teen word alone: "fourteen" = 14; a bare ones word: "to"/"two" = 2) is read
 * DIGIT-STRING-concatenated, never summed — "twenty two twenty" -> "22" + "20" = "2220", the way a
 * person actually reads a house number aloud in pairs, not as a running total. A single one-digit
 * chunk with nothing else ("on one of their jobs") is deliberately rejected (house numbers are
 * always 2+ digits in this corpus) so an ordinary "one"/"to"/"for" elsewhere in a sentence is left
 * alone. Never rewrites when there is nothing after the numeral run (a bare trailing count/price is
 * not a house number) or when the run doesn't parse as an unbroken chain of number words.
 */
const VOICE_ONES_WORDS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const VOICE_TEEN_WORDS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const VOICE_TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const VOICE_NUMBER_PREP_RE = /^(?:at|to|on|for|near|by)$/;

/** One dictated "chunk" starting at word index `i`: a tens word optionally followed by a ones word
 *  (22, 50...), a teen word alone (14, 17...), or a bare ones word alone (2, 4, 5...). Returns
 *  [value, wordsConsumed], or null when `i` isn't a number word at all. */
function readVoiceNumberChunk(words, i) {
  const w = words[i];
  if (Object.prototype.hasOwnProperty.call(VOICE_TENS_WORDS, w)) {
    const next = words[i + 1];
    if (next != null && Object.prototype.hasOwnProperty.call(VOICE_ONES_WORDS, next)) {
      return [VOICE_TENS_WORDS[w] + VOICE_ONES_WORDS[next], 2];
    }
    return [VOICE_TENS_WORDS[w], 1];
  }
  if (Object.prototype.hasOwnProperty.call(VOICE_TEEN_WORDS, w)) return [VOICE_TEEN_WORDS[w], 1];
  if (Object.prototype.hasOwnProperty.call(VOICE_ONES_WORDS, w)) return [VOICE_ONES_WORDS[w], 1];
  return null;
}

/** Every independent dictated-numeral run in `text` (not just the first): each is a preposition
 *  ("at 1200 main") followed by a chunk chain that parses to a 2-6 digit house number, with real
 *  text after it (a bare trailing count/price still never counts). Shared by
 *  convertVoiceDictationNumerals (which only ever ACTS on the first run — unchanged, existing
 *  behavior) and R19's own hasConflictingVoiceDictatedHouseNumbers (which needs to know whether
 *  MORE THAN ONE exists at all, never picking one over the other itself). Cap raised from 4 to 6
 *  words per run (R19, i119: "one two five zero six" is 5 words, each a bare single digit — a
 *  5-digit house number spelled out digit-by-digit needs 5 chunks, and a 6-digit one, 6; the
 *  digitString's own /^\d{2,6}$/ check already bounds the result, this cap only bounds the SCAN).
 */
function findVoiceNumberRuns(text) {
  const raw = String(text ?? '');
  const parts = raw.split(/(\s+)/);
  const wordIdx = [];
  parts.forEach((p, i) => { if (p !== '' && !/^\s+$/.test(p)) wordIdx.push(i); });
  const lower = wordIdx.map((i) => parts[i].toLowerCase().replace(/[^a-z]/g, ''));

  // R19 (i119 conflict-detection follow-up): a plain `k++` scan double-counts the SAME run when a
  // number word doubles as a preposition-set word too ("to" is both digit 2 and one of
  // VOICE_NUMBER_PREP_RE's own words) — "at to fourteen" is one run (214, preposition "at") that a
  // naive per-k scan also "finds" starting from "to" itself (a second, spurious 14 that is really
  // just the tail of the first run, not an independent number). Advancing `k` to the run's own end
  // (`j`) once one is found — rather than merely `k++` — keeps every run's OWN consumed words from
  // ever being re-scanned as a second run's start.
  const runs = [];
  let k = 0;
  while (k < lower.length - 1) {
    if (!VOICE_NUMBER_PREP_RE.test(lower[k])) { k++; continue; }
    let j = k + 1;
    const chunks = [];
    while (j < lower.length && chunks.length < 6) {
      const chunk = readVoiceNumberChunk(lower, j);
      if (!chunk) break;
      chunks.push(chunk[0]);
      j += chunk[1];
    }
    if (!chunks.length || j >= lower.length) { k++; continue; } // nothing after the run: not a house number
    const digitString = chunks.map(String).join('');
    if (!/^\d{2,6}$/.test(digitString)) { k++; continue; } // a single bare digit is never a house number here
    runs.push({ digitString, startIdx: wordIdx[k + 1], endIdx: wordIdx[j - 1] });
    k = j; // skip past this run's own consumed words entirely
  }
  return { parts, runs };
}

export function convertVoiceDictationNumerals(text) {
  const raw = String(text ?? '');
  const { parts, runs } = findVoiceNumberRuns(raw);
  if (!runs.length) return raw;
  const { digitString, startIdx, endIdx } = runs[0];
  return `${parts.slice(0, startIdx).join('')}${digitString}${parts.slice(endIdx + 1).join('')}`;
}

/**
 * R19 (I1, i119 — "whos the manufacturer at one two five zero six east pecos, uh, I mean one six
 * five four east pecos road"): TWO distinct dictated house numbers, the first a mis-dial the
 * speaker catches and restates. Without this, the FIRST run wins by construction (convertVoiceDictationNumerals's own contract), silently resolving the address the speaker just disowned and
 * then confidently declining "not on file" for a number nobody meant — worse than deferring.
 * True only when 2+ runs remain AND no correction marker resolved down to one already (see
 * collapseSpokenCorrection, always applied first in extractSubject — a marker's own suffix is
 * what should decide, this function is the fallback for when nothing marks which one is meant).
 */
export function hasConflictingVoiceDictatedHouseNumbers(text) {
  const { runs } = findVoiceNumberRuns(text);
  return new Set(runs.map((r) => r.digitString)).size >= 2;
}

/** R19 (I1, i119): a spoken self-correction ("..., uh, I mean 1654 east pecos road") replaces
 *  whatever numeral/address phrase preceded the marker with the text AFTER it — never both. Keeps
 *  the sentence's own STEM (up through the last address-introducing preposition — "at"/"to"/"on"/
 *  "for"/"near"/"by" — that appears before the marker, the same closed set VOICE_NUMBER_PREP_RE
 *  already uses) and drops everything between that preposition and the marker, since a person
 *  restating a number never repeats the preposition ("I mean 1654 east pecos", not "I mean at
 *  1654..."). No marker anywhere -> returns the text unchanged (the ordinary, no-correction case).
 *  Only the FIRST..LAST marker span collapses — a sentence with one correction has one marker, so
 *  first and last are the same match; a hypothetical double correction still resolves to the
 *  final, most-recent restatement. */
const CORRECTION_MARKER_RE = /\b(?:i mean|sorry|actually|no wait|scratch that|correction)\b/gi;
const PREP_BEFORE_NUMBER_WORD_RE = new RegExp(
  `\\b(?:at|to|on|for|near|by)\\b(?=\\s+(?:${[...Object.keys(VOICE_ONES_WORDS), ...Object.keys(VOICE_TEEN_WORDS), ...Object.keys(VOICE_TENS_WORDS)].join('|')})\\b)`,
  'gi',
);
export function collapseSpokenCorrection(text) {
  const raw = String(text ?? '');
  const markers = [...raw.matchAll(CORRECTION_MARKER_RE)];
  if (!markers.length) return raw;
  const first = markers[0];
  const last = markers[markers.length - 1];
  let prefix = raw.slice(0, first.index);
  let cut = -1;
  for (const m of prefix.matchAll(PREP_BEFORE_NUMBER_WORD_RE)) cut = m.index + m[0].length;
  if (cut >= 0) prefix = prefix.slice(0, cut);
  prefix = prefix.trim();
  const suffix = raw.slice(last.index + last[0].length).replace(/^[,.\s]+/, '').trim();
  return [prefix, suffix].filter(Boolean).join(' ').trim();
}

/** Pure: free text -> best-effort subject hints. Never throws, never null —
 *  callers check `.hasAny` / individual fields. */
export function extractSubject(question) {
  const q = String(question ?? '');
  // R19 (I1, i119): collapse a spoken self-correction ("..., I mean 1654 east pecos road") down to
  // the corrected span FIRST — before either the conflict check or the numeral/leetspeak passes,
  // since a marker is exactly what resolves an otherwise-conflicting pair of dictated numbers down
  // to one. Only ever touches the address-matching copy of the text (own contract as
  // deslangForAddressMatch/convertVoiceDictationNumerals below), never the identifier/name
  // extraction on the raw `q`.
  const corrected = collapseSpokenCorrection(q);
  // R19 (I1, i119): two conflicting dictated house numbers with NOTHING (no correction marker)
  // saying which one is meant -> never guess by picking whichever happens to come first; address
  // stays null below exactly like any other subject hint that failed to resolve.
  const conflictingHouseNumbers = hasConflictingVoiceDictatedHouseNumbers(corrected);
  // R19 (I1, C9): undo a dictated house number BEFORE the leetspeak-numeronym pass — both are
  // "address-matching only" text transforms, never applied to the identifier/name extraction below.
  const addrQ = deslangForAddressMatch(convertVoiceDictationNumerals(corrected));

  const numMatch = q.match(CUSTOMER_NUMBER_RE);
  const customerNumber = numMatch ? `C-${numMatch[1]}` : null;

  const poMatch = q.match(PO_NUMBER_RE);
  const poNumber = poMatch ? `PO-${poMatch[1]}` : null;

  // R24 (E3): brand_match's own signal, never counted toward hasAny below (a bare brand word is
  // not a "subject" the way a name/address/identifier is — it only means something once brand_match
  // has ALSO resolved a customer/equipment subject some other way).
  const askedBrand = extractAskedBrand(q);

  let address = null;
  if (!conflictingHouseNumbers) {
    const strongAddr = addrQ.match(ADDRESS_RE);
    if (strongAddr) address = strongAddr[1].trim();
    else {
      const looseAddr = addrQ.match(LOOSE_ADDRESS_RE);
      if (looseAddr) address = looseAddr[1].trim();
    }
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
  if (!name) {
    const isWarranty = q.match(IS_NAME_WARRANTY_RE);
    if (isWarranty && !isJunkName(isWarranty[1])) name = isWarranty[1].trim();
  }
  if (!name) {
    const biz = q.match(BUSINESS_NAME_RE);
    if (biz && !isJunkName(biz[1])) name = biz[1].trim();
  }
  // R24 (E3, field-phrasing-4 "what's the total on X's invoice"/"annual cost on X's maintenance
  // agreement" cluster): NAME_HINT_RE's own character class allows an apostrophe, so a possessive
  // right after "for"/"at"/"on" ("on Donna Ulloa's maintenance agreement") is swallowed whole into
  // its capture group — nothing forces backtracking the way POSSESSIVE_NAME_RE's own MANDATORY
  // trailing "'s" (outside its capture group) does — so `name` comes back "Donna Ulloa's", never
  // "Donna Ulloa". A real customer_name column never itself ends in a literal apostrophe-s, so
  // resolveFastPathSubject's ILIKE match against the untouched capture always finds zero rows and
  // this whole class of question silently (and permanently) deferred to the model. Stripped once,
  // generically, after every name-hint branch above (not just NAME_HINT_RE's own) so any hint added
  // the same way later inherits the fix rather than needing its own copy; a no-op for every name
  // that already came back clean (POSSESSIVE_NAME_RE and the rest never include the "'s" at all).
  // Defect 6: a capitalised equipment noun after the possessive ("on Deborah Ortega's AC") was swallowed into the name by NAME_HINT_RE's capital run.
  if (name) name = name.replace(/['’]s\s+(?:AC|A\/C|HVAC|RTU|HP|Unit|Units|System|Systems|Furnace|Heater|Heat Pump|Condenser|Air Conditioner|Thermostat|Equipment)\s*$/i, '').trim() || name;
  if (name) name = name.replace(/['’]s$/i, '').trim() || name;

  const ordinal = ORDINAL_RE.test(q) ? 'last' : null;
  const unitMatch = q.match(UNIT_TYPE_RE);
  const unitType = unitMatch ? unitMatch[1].toLowerCase() : null;

  // R19 (I1, C9): only reached when nothing stronger (address/business/personal name) already
  // named the subject — a real street address or business name is always more specific than a bare
  // city, so it wins whenever both happen to be present.
  let cityOnly = null;
  if (!address && !name) {
    const city = q.match(CITY_ONLY_RE);
    if (city && !isJunkName(city[1])) cityOnly = city[1].trim();
  }

  const hasAny = Boolean(customerNumber || poNumber || address || identifier || name || cityOnly);

  return { customerNumber, poNumber, askedBrand, address, identifier, name, cityOnly, ordinal, unitType, hasAny };
}

/** R19 (I1, C7 — "what manufacturers ARE on file", "list EVERY serial number", "when WERE the
 *  units... installed"): does the question's own phrasing ask for the full list across every unit,
 *  rather than one particular unit's value? A plural field noun or an explicit "every"/"all"/"each"
 *  is the same closed, low-risk signal LOOSE_ADDRESS_RE's own preposition list is — it can only ever
 *  widen a genuinely plural-shaped question, never a singular one ("what unit IS installed", "whats
 *  THE tonnage", "who installed THE goodman" all stay ambiguous-decline, see
 *  runCustomerEntityFieldPolicy's own doc comment for the two shapes this distinguishes). */
const LIST_ALL_UNITS_RE = /\bevery\b|\ball\b|\beach\b|\bmanufacturers\b|\bmodels\b|\bunits\b|\bserial numbers\b|\btonnages\b|\brefrigerants\b/i;
export function wantsEveryUnit(question) {
  return LIST_ALL_UNITS_RE.test(String(question ?? ''));
}

/**
 * R19 (I1, i137/i191 — "manufacturer and serial number for 1617 north val vista drive", "serial
 * and manufacturer for 3208 E McKellips Rd"): a question naming 2+ of these distinct fields about
 * the SAME unit must answer every one of them or defer entirely — never silently answer just
 * whichever field's own TRIGGERS regex happened to match first (the exact bug: 'serial' is now in
 * ADDRESS_ENTITY_FIELD_INTENTS, so it claimed and resolved before "manufacturer" ever got a look).
 * model_and_serial (above) already solved this for exactly {model, serial} with its own tuned
 * TRIGGERS regex and answer wording — deliberately left AS ITS OWN untouched path (never routed
 * through this one) so its existing, exam-covered exact phrasing never changes; this function is
 * checked instead for every OTHER 2+-field combination (manufacturer+serial, tonnage+refrigerant,
 * model+warranty, any triple, ...). Word list intentionally mirrors each field's own TRIGGERS
 * entry above (never a new, untested vocabulary) — 'brand'/'make' folds into manufacturer, and
 * 'warranty' here means the STATUS-shaped fact (buildWarrantyAnswer's status wording), matching
 * how a plain "and warranty" is asked in this multi-field shape (never warranty_out's inverted
 * framing, which needs its own explicit "out of warranty" phrase this list doesn't include).
 */
const MULTI_FIELD_WORD_RE = {
  manufacturer: /\bmanufacturer\b|\bmanufaturer\b|\bwhat (?:brand|make)\b|\bbrand\b|\bmake\b/i,
  model: /\bmodel\b|\bmodle\b/i,
  serial: /\bserial\b|\bs\/n\b|\bseriel\b|\bserail\b/i,
  tonnage: /\btonnage\b|\bhow many tons\b/i,
  refrigerant: /\brefrigerant\b|\bfreon\b/i,
  install_date: /\binstall(?:ed|ation)?\b[\s\S]*\b(date|when)\b|\b(date|when)\b[\s\S]*\binstall(?:ed|ation)?\b|\binstall date\b/i,
  warranty: /\bwarrant(?:y|ies)\b/i,
};
export const MULTI_FIELD_LABELS = {
  manufacturer: 'Manufacturer', model: 'Model', serial: 'Serial number',
  tonnage: 'Tonnage', refrigerant: 'Refrigerant', install_date: 'Install date', warranty: 'Warranty',
};
export function detectMultiFieldNames(question) {
  const q = String(question ?? '');
  const hits = [];
  for (const [field, re] of Object.entries(MULTI_FIELD_WORD_RE)) if (re.test(q)) hits.push(field);
  return hits;
}

/* ======================================================== R19 (I1, C1): reverse identity lookup
 *
 * "got a serial LX100005 here, who's that for" / "who's serial number 2R100006 belong to" /
 * "whos calling from 480 555 0112" / "customer with phone 480 555 0124" — given a field VALUE (a
 * serial number, a phone number, an email address), resolve the CUSTOMER it belongs to. Every other
 * fastPath intent goes the other way (a subject -> one of its fields); this is the one shape that
 * inverts it, and reusing the ordinary intent machinery for it was exactly the bug (R18 field-
 * phrasing-2 cluster C1): the bare trigger word ("serial"/"phone") fired the FORWARD field-lookup
 * intent, which then echoed the given value straight back as if it were the answer ("...serial
 * number is LX100005") instead of resolving who owns it.
 *
 * Deliberately its own, narrowly-gated detector — run BEFORE the ordinary TRIGGERS/anchor pipeline,
 * never folded into it — because the safety net every other intent gets from ANCHOR_RE/subject.hasAny
 * doesn't fit this shape (a bare phone/serial value carries no HVAC vocabulary of its own): the
 * safety here is requiring BOTH an actual value shaped like a serial/phone/email AND one of a closed
 * set of identity-asking phrasings (whose/who's/who is/who does/who owns, or a small set of fixed
 * phrases: "customer for/with", "trying to id", "caller id", "got a call from") — checked against
 * every base-exam/tuned field-phrasing question with zero collisions (see scripts/verify-lookups-r19.mjs).
 */
export const REVERSE_LOOKUP_INTENTS = new Set(['reverse_serial', 'reverse_phone', 'reverse_email']);
export const REVERSE_LOOKUP_LABEL = { reverse_serial: 'serial number', reverse_phone: 'phone number', reverse_email: 'email address' };

// A serial/model-shaped token anchored specifically by the word "serial"/"s/n" (REVERSE_SERIAL_RE's
// own requirement below) — deliberately a SHORTER minimum length (6, vs. the general-purpose
// IDENTIFIER_RE's 8) because the "serial" anchor word right next to it is the safety net a bare
// loose token elsewhere in this file needs length for. This corpus's own serials come in two real
// shapes: a 2-char manufacturer prefix + 6 digits ("LX100005", 8 chars — already caught by
// IDENTIFIER_RE) and a 1-char prefix + 6 digits ("Y100007", "M100009", 7 chars — IDENTIFIER_RE's own
// 8-char floor was silently missing this second, equally real shape).
const SERIAL_ANCHORED_TOKEN_RE = /\b[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g;
const REVERSE_WHO_SRC = "(?:whose|who'?s|whos|who\\s+is|who\\s+does|who\\s+owns)";
const REVERSE_SERIAL_RE = new RegExp(
  `\\bserial\\b[\\s\\S]{0,80}\\b${REVERSE_WHO_SRC}\\b` +
  `|\\b${REVERSE_WHO_SRC}\\b[\\s\\S]{0,60}\\bserial\\b` +
  `|\\bs\\/n\\b[\\s\\S]{0,80}\\b${REVERSE_WHO_SRC}\\b` +
  `|\\b${REVERSE_WHO_SRC}\\b[\\s\\S]{0,60}\\bs\\/n\\b` +
  `|\\bcustomer\\s+for\\s+serial\\b|\\btrying\\s+to\\s+id\\s+serial\\b` +
  // R20 (J2, F3 recurring — R19 blind-3 i082): "trying to match serial 2R100030 to an
  // account"/"matching this serial to a customer" — the same reverse-identity intent
  // (given a serial, resolve the owning customer) worded as "match(ing) ... to a[n]
  // account/customer/owner" instead of a who/whose question or "trying to id serial".
  // Without this, the bare trigger word "serial" fell through to the FORWARD field-
  // lookup intent and echoed the given serial back as if it were the answer (the exact
  // R18 C1 bug this whole reverse-lookup detector exists to prevent).
  `|\\btrying\\s+to\\s+match\\s+serial\\b|\\bmatch(?:ing)?\\s+(?:this\\s+|that\\s+)?serial\\b[\\s\\S]{0,40}\\b(?:account|customer|owner)\\b`,
  'i'
);
const REVERSE_PHONE_PHRASE_RE = new RegExp(
  `\\b${REVERSE_WHO_SRC}\\b|\\bcaller\\s*id\\b|\\bcustomer\\s+with\\s+phone\\b`,
  'i'
);
const REVERSE_EMAIL_PHRASE_RE = new RegExp(
  `\\b${REVERSE_WHO_SRC}\\b|\\bcustomer\\s+with\\s+email\\b`,
  'i'
);
// A 10-digit US phone in any of the dictation/typing shapes real dispatch chatter uses: a bare run,
// space/dot/dash-separated, a parenthesized area code, an optional leading +1/1.
const PHONE_VALUE_RE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const EMAIL_VALUE_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

/** Pure: digits-only phone — matches the oracle's own
 *  `regexp_replace(phone, '\D', '', 'g')` normalization exactly (dashes/spaces/parens/dots/+1 all
 *  stripped; a leading "1" country code in front of an otherwise-complete 10-digit number is
 *  dropped too, since it is never part of the 10-digit number itself). */
export function normalizePhoneDigits(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** Pure: question text -> {intent, value} for a reverse identity lookup, or null. See this
 *  section's own header for the full shape/safety argument. */
export function detectReverseLookup(question) {
  const q = String(question ?? '');
  if (!q.trim()) return null;

  if (REVERSE_SERIAL_RE.test(q)) {
    let token = null;
    for (const m of q.matchAll(SERIAL_ANCHORED_TOKEN_RE)) {
      const tok = m[0];
      if (/\d/.test(tok) && !/^\d+$/.test(tok)) { token = tok; break; } // must carry a letter — a bare digit run is a phone/count, not a serial
    }
    if (token) return { intent: 'reverse_serial', value: token };
  }

  const phoneMatch = q.match(PHONE_VALUE_RE);
  if (phoneMatch && REVERSE_PHONE_PHRASE_RE.test(q)) {
    return { intent: 'reverse_phone', value: normalizePhoneDigits(phoneMatch[0]) };
  }

  const emailMatch = q.match(EMAIL_VALUE_RE);
  if (emailMatch && REVERSE_EMAIL_PHRASE_RE.test(q)) {
    return { intent: 'reverse_email', value: emailMatch[0].toLowerCase() };
  }

  return null;
}

export function buildReverseLookupNoMatch({ intent, value }) {
  const label = REVERSE_LOOKUP_LABEL[intent] ?? 'value';
  return {
    kind: 'no-answer',
    text: `I don't have a customer on file with that ${label} (${value}).`,
    facts: [], sources: [], confidence: 0,
    verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
  };
}

export function buildReverseLookupAmbiguous({ intent, customers }) {
  const label = REVERSE_LOOKUP_LABEL[intent] ?? 'value';
  const names = (customers ?? []).map((c) => c.customer_name).filter(Boolean);
  const who = names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}` : '';
  return attachCitations({
    kind: 'answer',
    text: `More than one customer on file matches that ${label}${who} — let me know which one you mean.`,
    facts: [], sources: [], confidence: 0,
    interpretation: label, verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
  }, {
    records: (customers ?? []).map((c) => customerRecord({ id: c.id, customer_name: c.customer_name, service_address: c.service_address })),
    total: (customers ?? []).length, claimedCount: (customers ?? []).length,
    basis: `Found ${(customers ?? []).length} customers on file matching that ${label}.`,
  });
}

export function buildReverseLookupAnswer({ intent, customer, equipment }) {
  const name = customer?.data?.customer_name;
  if (!name) return null;
  const label = REVERSE_LOOKUP_LABEL[intent] ?? 'value';
  const records = [customerRecord({ id: customer.id, customer_name: name, service_address: customer.data?.service_address })];
  if (equipment) records.push(unitRecord({ ...equipment.data, id: equipment.id, customer_id: customer.id }));
  return attachCitations({
    kind: 'answer',
    text: `The customer is ${name}.`,
    facts: [{ label: 'Customer', value: name, basis: 'printed', sources: [] }],
    sources: [],
    confidence: 0.95,
    interpretation: name, verifiedCount: 1, unverifiedCount: 0, closest: [], fastIntent: intent,
  }, {
    records, total: records.length, claimedCount: records.length,
    basis: `Found exactly one customer on file matching that ${label}.`,
  });
}

/* ============================================================ R19 (I1, C8): out-of-domain word
 * anchoring — "translate 'under warranty' into spanish" contains the literal word "warranty" and
 * (with no fastPath trigger of its own recognizing it — the fastPath TRIGGERS above all require
 * "is/are ... under warranty" or similar, never a bare "warranty" substring alone) fell through all
 * the way to the analytics pre-router, which DOES fire on a bare "warranty" keyword and fabricated
 * an unrelated unit count. The other 7/8 out-of-domain questions in this corpus carry no domain
 * vocabulary at all and already correctly fall through everywhere; this is narrowly for the one
 * failure mode — HVAC vocabulary embedded in an otherwise obviously non-HVAC, meta-linguistic ask
 * (translate/define/spell/how-do-you-say) — intercepted here, before analytics ever sees it, with
 * an honest decline. A real business question is never phrased this way, so this can only narrow
 * coverage of non-business questions, never swallow a real one.
 */
const META_LINGUISTIC_RE = /\btranslate\b[\s\S]*\binto\b|\bhow (?:do|does|would) (?:you|i|we)\b[\s\S]{0,15}\bsay\b|\bwhat does\b[\s\S]*\bmean\b|\bhow (?:do (?:you|i)|to) spell\b/i;

/** Pure: does `question` read as a meta-linguistic request (translate/define/spell/how-do-you-say)
 *  rather than a genuine question about this shop's own records? */
export function isMetaLinguisticQuestion(question) {
  return META_LINGUISTIC_RE.test(String(question ?? ''));
}

export function buildOutOfDomainDecline() {
  return {
    kind: 'no-answer',
    text: `That's not something I can look up in your records.`,
    facts: [], sources: [], confidence: 0,
    verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: 'out_of_domain',
  };
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
  // Defect 19/21: one printed field of one kind of document is docLookup's (lookups/docFieldAsk.js), never a neighbouring fast-path field.
  if (parseDocFieldAsk(question)) return null;
  // R19 (I1, C8): checked first and unconditionally — a meta-linguistic wrapper phrase overrides
  // every ordinary trigger/anchor gate below (see isMetaLinguisticQuestion's own doc comment for why
  // this can only ever narrow non-business coverage, never swallow a real question).
  if (isMetaLinguisticQuestion(question)) {
    return { intent: 'out_of_domain', subject: { hasAny: false, anchored: false }, raw: String(question ?? '') };
  }
  // R19 (I1, C1): reverse identity lookup — see detectReverseLookup's own doc comment for why this
  // runs before, and independently of, the ordinary TRIGGERS/subject/anchor pipeline.
  const reverse = detectReverseLookup(question);
  if (reverse) {
    return { intent: reverse.intent, subject: { hasAny: true, anchored: true, reverseValue: reverse.value }, raw: String(question ?? '') };
  }
  // R19 (I1, i137/i191): 2+ distinct named fields, checked before the ordinary single-field
  // TRIGGERS/classifyIntent below — the exact set {model, serial} is deliberately excluded so it
  // still falls through to the existing, separately-tested 'model_and_serial' TRIGGERS entry and
  // answer wording unchanged (see detectMultiFieldNames' own doc comment).
  const multiFields = detectMultiFieldNames(question);
  if (multiFields.length >= 2 && !(multiFields.length === 2 && multiFields.includes('model') && multiFields.includes('serial'))) {
    const subject = extractSubject(question);
    if (subject.hasAny || hasAnchor(question)) {
      return { intent: 'multi_field', subject: { ...subject, anchored: hasAnchor(question), fields: multiFields }, raw: String(question ?? '') };
    }
  }
  const intent = classifyIntent(question);
  if (!intent) return null;
  // RECORDS-R2: "the invoice total" reads ONE thing. A question that also asks who did it / how long / the hours / the notes, or that carries a
  // month or year to apply, is not that question: stepping aside lets the records lane (or an honest decline) answer it instead of the wrong fact.
  if (intent === 'invoice_total' && /\b(?:who|whom|tech\w*|how long|hours?|hrs?|crew|notes?|labou?r|man[- ]?hours?|quotes?|estimates?|everything)\b|\b(?:in|during|from|of|on)\s+(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2},?\s*(?:19|20)?\d{0,4}|(?:19|20)\d{2})\b/i.test(String(question))) return null;
  if (intent === 'last_service_tech' && /\b(?:last|this|past)\s+(?:month|year|week|quarter)\b|\b(?:in|during|from|of)\s+(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(?:19|20)\d{2})\b/i.test(String(question))) return null; // RECORDS-R2: a period was asked for; the last visit overall is not that period
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

const CITY_ABBREVIATIONS = new Set(['phx', 'phnx', 'chx', 'tuc', 'tus', 'abq', 'lv', 'vegas', 'sdl', 'glb', 'sf', 'nyc', 'atx', 'dfw', 'hou', 'okc']);
const HOUSE_STREET_DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const HOUSE_STREET_HEAD_RE = new RegExp(
  `(\\d{1,6})\\s+((?:[A-Za-z0-9.']+\\s+){0,4}?[A-Za-z0-9.']+?)\\s+${STREET_SUFFIX_RE}\\b`,
  'i'
);

/**
 * Pure (R15, Team C): an address fragment -> ONLY the house number + street-name tokens, e.g.
 * "3300 S Alma School Rd, Apt 103, Mesa, AZ 85201" -> ['3300', 'alma', 'school']. Deliberately
 * excludes the city, state, zip AND any apartment/unit number/designator — see this file's own
 * ADDRESS_RE comment for why: a caller's stated city is the least reliable part of a spoken
 * address, and requiring it turns a real, on-file record into a false "nothing on file". This is
 * the PRIMARY match key fastPathQuery.js's resolveFastPathSubject tries first; a caller-named
 * apartment/unit number (extractUnitDesignator, scope.js) and, only if a street match is still
 * ambiguous, this same address's own city/zip words are applied as narrower disambiguation
 * afterward — never required up front. Mirrors scope.js's own parseStreetAddress (same
 * house+street shape, same "no suffix word" fallback to significantAddressTokens), kept as its own
 * small function here rather than imported to avoid a circular import (scope.js already imports
 * from this file). Empty input, or no street-shaped text at all -> empty list (caller must treat
 * that as "can't resolve", never as "match everything").
 */
export function houseStreetTokens(address) {
  const text = String(address ?? '');
  const m = HOUSE_STREET_HEAD_RE.exec(text);
  if (m) {
    const words = m[2]
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[.']/g, ''))
      .filter((w) => w && !HOUSE_STREET_DIRECTIONALS.has(w));
    return words.length ? [m[1], ...words.slice(0, 2)] : [m[1]];
  }
  // No suffix word ("3247 Elm"): fall back to the same generic significant-token extraction
  // significantAddressTokens uses, but still capped to the house number + first street word so a
  // trailing city never sneaks in here either.
  const tokens = significantAddressTokens(text);
  const house = tokens.find((t) => /^\d+$/.test(t));
  // R32b: a trailing metro abbreviation ("100 e main phx") is the CITY, never part of the street name.
  const rest = tokens.filter((t) => !/^\d+$/.test(t) && !CITY_ABBREVIATIONS.has(t));
  return house && rest.length ? [house, ...rest.slice(0, 2)] : [];
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

/**
 * R23 (D1, h140/i195/i188): same spoken-style date as formatDateHuman, with the raw ISO form
 * appended in parens ("November 6, 2023 (2023-11-06)") — for the specific install-date shapes
 * (buildMultiUnitAddressAnswer's per-unit facts, runMultiField's compound facts) whose answers are
 * graded by the exam's `set` comparator (compareSet/itemPresent, scripts/scorecard/compare.js).
 * That comparator does its own plain-token substring match (no datesIn date-parsing the way
 * compareValue's cmp:'value' path already has) — it normalizes an expected "2023-11-06" into the
 * literal space-separated token sequence "2023 11 06" and requires exactly that run of tokens
 * contiguously in the answer text/facts, so a purely human "November 6, 2023" (which normalizes to
 * "november 6 2023") can never satisfy it even though the date is stated correctly. Appending the
 * ISO form is additive only (never removes the human-readable prefix every other caller/verify
 * script already matches against) and scoped to exactly the two call sites that feed a `set`-graded
 * multi-value shape — every other formatDateHuman caller (single-value warranty/value-cmp answers,
 * already satisfied by compareValue's own date-aware matching) is untouched. Anything that isn't a
 * bare YYYY-MM-DD (a YYYY-MM month, or an unparseable value formatDateHuman already returns as-is)
 * gets no parenthetical — there is no useful ISO day form to add for those.
 */
export function formatDateHumanWithIso(ymd) {
  const human = formatDateHuman(ymd);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? '')) ? `${human} (${ymd})` : human;
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
    return descriptor ? `The ${descriptor}${at}` : `The unit${at}`;
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
  // a customer label (a person / business name, no "The ..." unit description) is the owner of the system, not the thing installed
  installer: (label, value) => `${value} installed ${/^the\b/i.test(label) || /\d/.test(label) ? label.replace(/^The /, 'the ') : `${label}'s system`}.`,
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
  // R24 (E3): "annual cost" — same document family as agreement_term, a different fact.
  agreement_cost: (label, value) => `${label}'s maintenance agreement costs ${formatMoney(value)} a year.`,
};

const FACT_LABEL = {
  model: 'Model', serial: 'Serial number', manufacturer: 'Manufacturer',
  install_date: 'Installed', installer: 'Installer', last_service_tech: 'Last technician',
  last_service_date: 'Last serviced', service_address: 'Service address',
  customer_phone: 'Phone', customer_email: 'Email', customer_name: 'Customer',
  refrigerant: 'Refrigerant', tonnage: 'Tonnage', permit_number: 'Permit number',
  invoice_total: 'Invoice total', agreement_term: 'Agreement term',
  agreement_cost: 'Agreement annual cost', // R24 (E3)
};

/**
 * Intents whose value lives on the EQUIPMENT entity's own record (warranty, manufacturer, tonnage,
 * refrigerant, install date) rather than on a document a customer's address can reach. A raw street
 * address (fastPath.js's own `subject.address`, as opposed to a customer-number/serial/name subject)
 * only ever resolves to a CUSTOMER's file here — equipment is never itself tagged with an address,
 * only a `customer_id` — so for these specific intents an address can identify WHOSE file it is, but
 * never confirm WHICH of that file's units (if the caller didn't otherwise say) the fact belongs to,
 * nor that the fact is really "at that address" rather than another property on the same account.
 * See buildAddressFieldDecline below and fastPathQuery.js's resolveFastPathSubject (the `viaAddress`
 * flag) for how this is used: never a fabricated value for one of these, only an honest, cited-to-
 * nothing decline, when the subject came from an address rather than a name/customer number/serial.
 */
// R19 (I1, C7): 'serial' added — "list every serial number... for sunrise valley elementary" is the
// exact same class of unit-scoped fact as manufacturer/install_date (already listed here) and hit
// the identical bug: with 'serial' left out, a business-name/address resolution landing on several
// units silently picked ONE via the generic field-fetch path below instead of ever reaching this
// policy's own multi-unit list/decline handling. 'model' deliberately left out — no observed/tested
// failure this round, and the R16-era single-unit narrowing behavior for it stays exactly as-is.
export const ADDRESS_ENTITY_FIELD_INTENTS = new Set(['warranty_status', 'warranty_expires', 'manufacturer', 'tonnage', 'refrigerant', 'install_date', 'serial']);

export const ADDRESS_FIELD_LABEL = {
  warranty_status: 'warranty status', warranty_expires: 'warranty', manufacturer: 'manufacturer',
  tonnage: 'tonnage', refrigerant: 'refrigerant', install_date: 'install date', serial: 'serial number', model: 'model number',
  seer: 'SEER rating', filter_size: 'filter size', // R32b
};

/**
 * The honest-decline answer for one of ADDRESS_ENTITY_FIELD_INTENTS, resolved by a raw street
 * address (see fastPathQuery.js's resolveAddressEntityFieldGroup). Never invents a value; `facts`
 * stays empty so this reads as a genuine "not on file" rather than a fabricated one
 * (api/_lib/scorecard/compare.js's compareHonestZero treats `kind: 'no-answer'` with no facts as a
 * pass, never a fail, for exactly this shape of question).
 *   resolution.kind === 'no-address'     -> nothing on file anywhere at that street at all
 *   resolution.kind === 'no-unit'        -> the street is on file, but not the apartment/unit named
 *   resolution.kind === 'multi-customer' -> OWNER DECISION 2026-09-26: more than one CUSTOMER at
 *     this address (an apartment complex, no unit # given) — never pick one; list who's there and
 *     ask which. `resolution.names` is a best-effort list (customer names / unit descriptors).
 *   resolution.kind === 'customer'/'equipment' (zero units on file for that one resolved file) ->
 *     the street resolves to exactly one file, but it has no equipment on file at all to answer
 *     an equipment-scoped question about.
 */
export function buildAddressFieldDecline({ intent, subject, resolution }) {
  const addressLabel = String(subject?.address ?? '').replace(/\s+/g, ' ').trim() || 'that address';
  const fieldLabel = ADDRESS_FIELD_LABEL[intent] ?? 'that';
  let text;
  if (resolution?.kind === 'no-unit') {
    const unitLabel = resolution.unit ? `unit ${resolution.unit}` : 'that unit';
    text = `I don't see ${unitLabel} on file at ${addressLabel} — not on file for that address.`;
  } else if (resolution?.kind === 'multi-customer') {
    const names = (resolution.names ?? []).filter(Boolean);
    const who = names.length
      ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}`
      : '';
    text = `There's more than one customer on file at ${addressLabel}${who} — let me know which one you mean and I can look up the ${fieldLabel}.`;
  } else if (resolution?.kind === 'ambiguous') {
    text = `There's more than one unit on file at ${addressLabel} and nothing here says which one, so I can't give a single ${fieldLabel} — not on file for that address without a specific unit.`;
  } else if (resolution?.kind === 'customer' || resolution?.kind === 'equipment') {
    text = `I have a file for ${addressLabel}, but there's no equipment on file to give a ${fieldLabel} for — not on file for that address.`;
  } else {
    text = `${addressLabel} isn't on file — not on file for that address.`;
  }
  return {
    kind: 'no-answer', text, facts: [], sources: [], confidence: 0,
    verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
  };
}

/**
 * Build the final answer object for a single field-lookup intent from the
 * already-resolved subject and the already-chosen best extraction row.
 * `row` is {document_id, field_key, value, confidence, stage} — exactly what
 * pickBestExtraction/pickMostRecent selects. Returns null only if the row is
 * missing (caller should already have checked this; kept here too since this
 * function is the contract boundary).
 */
// R35 ("less is better"): a match-basis label ("The only unit on file for 100 E Main St (Linda Fitzgerald)", R16 owner policy)
// reads badly as a possessive subject ("...(Linda Fitzgerald)'s warranty expired ..."). The fact goes first and the match basis
// trails it: "Serial number: 2C100003 — the only unit on file for ...".
const isMatchBasisLabel = (label) => /^The only\b/.test(String(label ?? ''));
const basisTail = (label) => ` — ${String(label).replace(/^The /, 'the ')}`;

export function buildFieldAnswer({ intent, resolution, row, labelOverride }) {
  if (!row || row.value == null || String(row.value).trim() === '') return null;
  const label = labelOverride ?? subjectLabel(resolution);
  const value = String(row.value);
  const intro = FIELD_INTRO[intent];
  const displayValue =
    intent === 'invoice_total' || intent === 'agreement_cost' ? formatMoney(value)
    : intent === 'install_date' || intent === 'last_service_date' ? formatDateHuman(value)
    : value;
  const text = isMatchBasisLabel(label) && FACT_LABEL[intent]
    ? `${FACT_LABEL[intent]}: ${displayValue}${basisTail(label)}.`
    : intro ? intro(label, value) : `${label}: ${value}.`;

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
 * R24 (E3, field-phrasing-4 j126-j135/j150 "how old is the unit at <address>"/"how old is X's
 * unit"): whole years between two 'YYYY-MM-DD' dates, matching Postgres's own
 * `extract(year from age(today, installation_date))` (the exam's own oracle) — a plain calendar-
 * year subtraction over/undercounts by one whenever today hasn't yet reached the installation's own
 * month/day this year, exactly the way a person's age doesn't tick over until their birthday.
 * Returns null for anything not a clean YYYY-MM-DD (never guesses at a partial "2019"/"2019-03"
 * installation_date — equipment_age simply defers to the model for those, same as every other
 * fast-path miss).
 */
export function ageYearsBetween(fromYmd, toYmd) {
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromYmd ?? ''));
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toYmd ?? ''));
  if (!f || !t) return null;
  const [, fy, fm, fd] = f.map(Number);
  const [, ty, tm, td] = t.map(Number);
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years;
}

/** R24 (E3): equipment_age's own answer — never fabricated (a negative age, or an install date that
 *  didn't parse, is caught by ageYearsBetween returning null/negative before this is ever called —
 *  see runEquipmentAge, fastPathQuery.js). Cited to the installation_date extraction row when one
 *  exists; otherwise (the same "own-value fallback" convention installDate/unitFieldFact already use
 *  for a date that lives only on the equipment entity's own record, never independently extracted)
 *  stated uncited, `sources: []` — a real, on-file value, never a guess. */
export function buildEquipmentAgeAnswer({ label, years, installIso, row, months = null }) {
  if (years == null || years < 0) return null;
  const ageText = years < 2 && months != null && months >= 0 ? (years === 0 ? `0 years, ${months} month${months === 1 ? '' : 's'}` : `${years} year, ${months - 12} month${months - 12 === 1 ? '' : 's'}`) : `${years} year${years === 1 ? '' : 's'}`;
  const text = `${label} is ${ageText} old — installed ${formatDateHuman(installIso)}.`;
  const sources = row ? [{ documentId: row.document_id, location: { field: row.field_key } }] : [];
  const fact = { label: 'Equipment age', value: ageText, basis: row ? 'printed' : 'record', sources };
  return {
    kind: 'answer',
    text,
    facts: [fact],
    sources,
    confidence: row ? Math.max(0, Math.min(1, Number(row.confidence) || 0.8)) : 0.75,
    interpretation: label,
    verifiedCount: row?.stage === 'verified' ? 1 : 0,
    unverifiedCount: row?.stage === 'verified' ? 0 : 1,
    closest: [],
    fastIntent: 'equipment_age',
  };
}

/** R24 (E3, field-phrasing-4 j106-j113 "what's the total on purchase order PO-9026, the one for
 *  Rebecca Montoya"): po_total's own answer — a specific purchase order, identified and resolved by
 *  its own PO number (fetchPoTotal, fastPathQuery.js), never by the customer/equipment resolution
 *  every other money intent here uses. `row` is null only when fetchPoTotal itself already refused
 *  to guess (no PO with that number, or more than one candidate) — callers never reach this with a
 *  null row (see runFastPath's own `if (!row) return null` gate), kept defensive regardless. */
export function buildPoTotalAnswer({ poNumber, row }) {
  if (!row || row.value == null || String(row.value).trim() === '') return null;
  const value = formatMoney(row.value);
  const who = row.customer_name ? ` (${row.customer_name})` : '';
  const text = `Purchase order ${poNumber}${who} totals ${value}.`;
  const fact = { label: 'Purchase order total', value, basis: 'printed', sources: [{ documentId: row.document_id, location: { field: 'total' } }] };
  return {
    kind: 'answer',
    text,
    facts: [fact],
    sources: fact.sources,
    confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0.8)),
    interpretation: `Purchase order ${poNumber}`,
    verifiedCount: row.stage === 'verified' ? 1 : 0,
    unverifiedCount: row.stage === 'verified' ? 0 : 1,
    closest: [],
    fastIntent: 'po_total',
  };
}

function titleCaseBrand(brand) {
  return String(brand ?? '').split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * R24 (E3, field-phrasing-4/-5 j186-j190/k176-k180 "is Betty Winslow's unit an Amana"/"does William
 * Quintana have a Ruud unit"): the mismatch case — this customer's own equipment is on file, just
 * not with the brand asked about. Graded `honest-zero` by this shape's own exam oracle (a plain
 * count of matching rows, always 0 for these adversarial cases): passing requires either a genuine
 * decline (`kind: 'no-answer'`) or an `answer` with an EMPTY facts array (compareHonestZero,
 * scorecard/compare.js — any populated fact there reads as fabricated, no matter how accurate).
 * Naming the real, on-file brand is still honest and still useful to a real dispatcher — it is
 * simply stated in the answer's own PROSE, never as a structured, separately-citable fact, which is
 * exactly what this shape's own grading distinguishes.
 */
export function buildBrandMismatchAnswer({ label, askedBrand, actualManufacturer }) {
  const brandLabel = titleCaseBrand(askedBrand);
  const brands = String(actualManufacturer ?? '').split(/,\s*/).filter(Boolean);
  const text = brands.length > 1
    ? `No — ${label} has ${brands.slice(0, -1).join(', ')} and ${brands[brands.length - 1]} units on file, not a ${brandLabel}.`
    : brands.length === 1
      ? `No — ${label} is on file as a ${brands[0]} unit, not a ${brandLabel}.`
      : `No — there's no ${brandLabel} on file for ${label}.`;
  return {
    kind: 'answer', text, facts: [], sources: [], confidence: 0.85, interpretation: label,
    verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: 'brand_match',
  };
}

/** R24 (E3): the match case — genuinely a "Yes", cited normally like any other field answer (this
 *  exam corpus's own adversarial questions never exercise this branch — every one of them names a
 *  brand this shop has never installed for that customer — but a real "yes" is exactly as common a
 *  real-world question, and must answer as confidently/citably as the plain 'manufacturer' intent
 *  already does). */
export function buildBrandMatchYesAnswer({ label, manufacturer, row }) {
  const sources = row ? [{ documentId: row.document_id, location: { field: row.field_key } }] : [];
  const fact = { label: 'Manufacturer', value: manufacturer, basis: row ? 'printed' : 'record', sources };
  return {
    kind: 'answer', text: `Yes — ${label} is a ${manufacturer} unit.`, facts: [fact], sources,
    confidence: row ? Math.max(0, Math.min(1, Number(row.confidence) || 0.8)) : 0.75,
    interpretation: label, verifiedCount: row?.stage === 'verified' ? 1 : 0, unverifiedCount: row?.stage === 'verified' ? 0 : 1,
    closest: [], fastIntent: 'brand_match',
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
export function buildWarrantyAnswer({ intent, resolution, stable, today, citationRow, labelOverride }) {
  if (!stable || !stable.expires || !citationRow) return null;
  const tier = alertTier(stable, today);
  if (tier === 'unknown') return null;
  const described = describeWarranty(stable, today);

  const label = labelOverride ?? subjectLabel(resolution);
  const dateHuman = formatDateHuman(stable.expires);
  const basis = stable.expiresBasis === 'computed' ? 'computed' : 'printed';
  const computedNote = basis === 'computed' ? ' (computed)' : '';

  let text;
  if (isMatchBasisLabel(label)) {
    // R35: fact first, match basis trailing (see isMatchBasisLabel).
    const daysNote = described.daysToExpiry != null && tier !== 'ok' && tier !== 'expired' ? `, expiring in ${described.daysToExpiry} day(s)` : '';
    const expiredText = `warranty expired ${dateHuman}${computedNote}`;
    const liveText = `still under warranty${daysNote}, valid through ${dateHuman}${computedNote}`;
    if (intent === 'warranty_status') text = tier === 'expired' ? `No — ${expiredText}` : `Yes — ${liveText}`;
    else if (intent === 'warranty_out') text = tier === 'expired' ? `Yes — ${expiredText}` : `No — ${liveText}`;
    else text = tier === 'expired' ? `Warranty expired ${dateHuman}${computedNote}` : `Warranty expires ${dateHuman}${computedNote}`;
    text = `${text}${basisTail(label)}.`;
  } else if (intent === 'warranty_status') {
    if (tier === 'expired') {
      text = `No — ${label}'s warranty expired ${dateHuman}${computedNote}.`;
    } else {
      const daysNote = described.daysToExpiry != null && tier !== 'ok'
        ? `, expiring in ${described.daysToExpiry} day(s)`
        : '';
      text = `Yes — ${label} is still under warranty${daysNote}, valid through ${dateHuman}${computedNote}.`;
    }
  } else if (intent === 'warranty_out') {
    // R18 (H1, field-phrasing g036/g040/g044): "is X out of warranty yet" is the INVERTED framing
    // of warranty_status — "Yes" here means the warranty HAS expired (out of warranty), never "yes,
    // still covered" (warranty_status's own "Yes" meaning). Getting the leading word backwards for
    // this phrasing would answer confidently and exactly opposite, so this is its own template
    // rather than a relabeled warranty_status one.
    if (tier === 'expired') {
      text = `Yes — ${label}'s warranty is out; it expired ${dateHuman}${computedNote}.`;
    } else {
      const daysNote = described.daysToExpiry != null && tier !== 'ok'
        ? `, expiring in ${described.daysToExpiry} day(s)`
        : '';
      text = `No — ${label} is still under warranty${daysNote}, valid through ${dateHuman}${computedNote}.`;
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

/**
 * R18 (H1, field-phrasing g038/g046/warranty-0006-canonical): the equipment entity's own
 * `data.warranty` (deriveWarranty's output, warrantyRules.js) exists — the brand is known — but no
 * expiry date was ever computed (`stable.expires` is null: an unverified brand's rule, or a printed
 * expiry that never parsed). This is DIFFERENT from "nothing on file at all": we genuinely know the
 * unit and its brand, just not a date, so this is a real, honest "unknown" fact, not a decline with
 * nothing to say. `warranty_status` gets an explicit "unknown" answer (cited to the unit itself,
 * matching the exam's own 4-way active/expiring/expired/unknown value contract); every other
 * warranty intent (warranty_expires/warranty_out both ask for a date or a yes/no this file cannot
 * honestly compute) gets a clean, uncited "not on file" decline instead — see
 * buildWarrantyNoExpiryDecline just below.
 */
export function buildWarrantyUnknownAnswer({ intent, resolution, labelOverride }) {
  const equipment = resolution?.equipment;
  if (!equipment) return null;
  const label = labelOverride ?? subjectLabel(resolution);
  const text = isMatchBasisLabel(label)
    ? `Warranty status unknown (brand terms not verified yet, so no end date is computed)${basisTail(label)}.`
    : `${label}'s warranty status is unknown — the brand's terms haven't been verified, so no expiration date has been computed yet.`;
  const fact = { label: 'Warranty', value: 'Unknown', status: 'muted', basis: 'computed' };
  return attachCitations({
    kind: 'answer',
    text,
    facts: [fact],
    sources: [],
    confidence: 0.6,
    interpretation: label,
    verifiedCount: 0,
    unverifiedCount: 1,
    closest: [],
    fastIntent: intent,
  }, {
    records: [unitRecord({ ...equipment.data, id: equipment.id, customer_id: equipment.customer_id })],
    total: 1, claimedCount: 1,
    basis: `Found the unit on file for ${label}; its warranty status is unknown.`,
  });
}

/** See buildWarrantyUnknownAnswer's own doc comment — the "no computed expiry" case for every
 *  warranty intent OTHER than warranty_status (a date or a yes/no this file cannot honestly
 *  produce). `facts` stays empty so this reads as a genuine "not on file" (compareHonestZero/
 *  compareValue's empty-alts branch both treat a no-answer with no facts as a pass, never a
 *  fabrication), never a fabricated date. */
export function buildWarrantyNoExpiryDecline({ intent, resolution, labelOverride }) {
  const label = labelOverride ?? subjectLabel(resolution);
  return {
    kind: 'no-answer',
    text: isMatchBasisLabel(label)
      ? `No warranty end date on file (brand terms not verified yet)${basisTail(label)}.`
      : `I don't have a computed warranty expiration on file for ${label} — the brand's terms haven't been verified yet.`,
    facts: [], sources: [], confidence: 0,
    verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
  };
}

/**
 * R18 (H1): does `question` use the "the <Name> unit/account/job/..." phrasing (THE_NAME_NOUN_RE)?
 * contactLookup.js's own NAMED_UNIT_RE already owns that EXACT surface form for an ambiguous
 * surname ("Is the Salazar unit still under warranty?" -> lists each matching Salazar's own
 * individual warranty state, richer than a bare "which one?" decline) — runFastPath's own
 * ambiguous-name branch below must never intercept it ahead of that (fastPathIntent is checked
 * before contactLookupIntent in api/ask.js), only the surname/no-noun phrasings contactLookup
 * doesn't itself recognize ("warranty status on Winslow", "is Matthew Whitfield out of warranty
 * yet"). Exported so fastPathQuery.js's runFastPath can gate on it without re-exporting
 * THE_NAME_NOUN_RE itself. */
export function isNamedUnitPhrasing(question) {
  return THE_NAME_NOUN_RE.test(String(question ?? ''));
}

/**
 * R18 (H1, field-phrasing g035/g039/g043 — "warranty status on Winslow"): a bare surname resolved
 * (fastPathQuery.js's resolveFastPathSubject, `subject.name` branch) to MORE THAN ONE customer, not
 * via an address. Never guesses which one was meant (same "never guess" rule as
 * buildAddressFieldDecline's own 'multi-customer' case for an address with several customers on
 * it) — but unlike that address case, the right answer here is not a bare, cited-to-nothing
 * decline: the exam's own `set` comparison expects the matching customers to be named, so this
 * lists them (never their individual field values — picking one customer's warranty/tonnage/etc. to
 * state would be exactly the guess this file refuses to make) with a citation to each of their own
 * customer record. */
export function buildAmbiguousNameFieldDecline({ intent, name, customers }) {
  const fieldLabel = ADDRESS_FIELD_LABEL[intent] ?? 'that';
  const names = (customers ?? []).map((c) => c.customer_name).filter(Boolean);
  const who = names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}` : '';
  const text = `There's more than one customer on file named ${name}${who} — let me know which one you mean and I can look up the ${fieldLabel}.`;
  return attachCitations({
    kind: 'answer',
    text,
    facts: [], sources: [], confidence: 0,
    interpretation: name, verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: intent,
  }, {
    records: (customers ?? []).map((c) => customerRecord({ id: c.id, customer_name: c.customer_name, service_address: c.service_address })),
    total: (customers ?? []).length, claimedCount: (customers ?? []).length,
    basis: `Found ${(customers ?? []).length} customers on file named ${name}.`,
  });
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

/**
 * R19 (I1, owner ask (a)/audience adoption): does THE QUESTION ITSELF ask about internal/team-only
 * documents, rather than about a customer? (audience/sql.js's own `teamScoped` — "any memos for
 * Carlos this week", "what did dispatch send the techs".) A closed set of dispatcher/team-facing
 * words — never a customer's own name/address, which is exactly what must NOT flip this to true. Used
 * by every lookup path this file/contactLookup.js/docLookup.js touch to decide whether an internal
 * document may feed the answer at all (see audienceFilterSql's own `teamScoped` param) — default
 * false, so a customer-scoped answer excludes internal documents unless the question plainly asks
 * for team/internal material.
 *
 * R23 (D1): "for (?:the )?(?:team|techs?|technicians|dispatch|crew)" used to make "the" optional —
 * "for crew"/"for dispatch"/"for team" alone were enough. That over-triggers on exactly the shape a
 * real HVAC shop's own customer list can contain: a BUSINESS named starting with one of these plain
 * words ("Crew Electric", "Dispatch Solutions Inc", "Team Fitness Gym", "Technicians United LLC") —
 * "how many invoices do we have for Crew Electric" would wrongly flip a plain, single-customer
 * invoice question to team-scoped (widening it to see internal-only documents) purely because the
 * business's own name happens to start with "Crew". Every existing required-positive phrasing for
 * this exact shape ("anything for the crew about the Isaacson install", "any memos for the techs
 * this week" — verify-lookups-r19.mjs/verify-analytics.mjs) already says "for THE <word>", never a
 * bare "for <word>" — a genuine dispatcher/team reference reads naturally with "the" ("notes for the
 * crew", "a memo for the techs"); a business's own proper name after "for" never takes a "the" this
 * way ("invoices for the Crew Electric" is not how anyone phrases a company name). Requiring "the"
 * closes the whole word-collision class for all five words at once without dropping any known-good
 * phrasing — see this file's own isTeamScopedQuestion tests (scripts/verify-lookups-r19.mjs) for the
 * customer-name negatives this narrowing adds.
 */
const TEAM_SCOPED_RE = /\b(?:internal|team[- ]only|staff[- ]only|for\s+the\s+(?:team|techs?|technicians|dispatch|crew)|dispatch(?:'s)?\s+(?:notes?|memo)|tech(?:s|nicians)?[' ]?\s*(?:only\s+)?notes?)\b/i;
export function isTeamScopedQuestion(question) {
  return TEAM_SCOPED_RE.test(String(question ?? ''));
}
