/**
 * Round 18 (H4): the "what is this follow-up ABOUT" half of the multi-turn engine — pulling a subject
 * (address/name/customer number/unit) either out of a turn's own question text (reusing fastPath.js's
 * already-battle-tested extractSubject, never a second hand-rolled address/name regex) or out of a
 * turn's resolvedEntities (the client-supplied hint carrying the ids/labels the PREVIOUS answer's own
 * citations named — see conversation.js's module header for the shape and trust boundary).
 *
 * Pure. No DB, no model. See resolve.js for how these subjects get composed into a rewritten question.
 */
import { extractSubject } from '../fastPath.js';
import { BRAND_RULES } from '../warrantyRules.js';

/** Which plural noun a pronoun ("those"/"them"/"these") most likely stands for, guessed from the
 *  words actually in the sentence it appeared in — never a claim, just the best available guess for
 *  composing readable rewritten text. Defaults to 'units' (the single most common referent in this
 *  domain: "how many of those are Trane" is almost always about equipment). */
export function inferNoun(text) {
  const q = String(text ?? '');
  if (/\b(document|documents|invoice|invoices|permit|permits|work order|work orders|ticket|tickets)\b/i.test(q)) return 'documents';
  if (/\b(customer|customers|account|accounts|property|properties)\b/i.test(q)) return 'customers';
  if (/\b(unit|units|equipment|condenser|furnace|heat pump|air handler|rtu|mini[- ]?split|package unit)\b/i.test(q)) return 'units';
  return 'units';
}

/** @returns {{address:?string, name:?string, customerNumber:?string, identifier:?string, unitType:?string, noun:string, hasAny:boolean}} */
export function subjectFromText(question) {
  const s = extractSubject(question);
  return {
    address: s.address || null,
    name: s.name || null,
    customerNumber: s.customerNumber || null,
    identifier: s.identifier || null,
    unitType: s.unitType || null,
    noun: inferNoun(question),
    hasAny: Boolean(s.hasAny),
  };
}

/**
 * Best-effort subject built from a turn's resolvedEntities (client-supplied; see conversation.js for
 * sanitation/shape). NEVER treated as ground truth for fetching a record directly — only for composing
 * readable text (a label/sublabel) that the SAME tenant-scoped deterministic handlers re-resolve from
 * scratch, exactly as if it had been typed. `candidateCustomers`/`candidateUnits` are exposed so
 * disambiguation-reply / "the other one" resolution can pick among them.
 * @param {object[]|undefined} entities
 */
export function subjectFromEntities(entities) {
  const list = Array.isArray(entities) ? entities : [];
  const customers = list.filter((e) => e?.type === 'customer');
  const units = list.filter((e) => e?.type === 'unit');
  const out = {
    address: null,
    name: null,
    customerNumber: null,
    identifier: null,
    unitType: null,
    noun: units.length ? 'units' : 'customers',
    hasAny: list.length > 0,
    candidateCustomers: customers,
    candidateUnits: units,
  };
  if (customers.length === 1) {
    out.name = customers[0].label || null;
    out.address = customers[0].sublabel || null;
  }
  if (units.length === 1) {
    out.name = out.name || units[0].sublabel?.split('·')[0]?.trim() || null;
    out.unitType = units[0].label || null;
  }
  return out;
}

// ---------------------------------------------------------------------- brand mentions
// Built from warrantyRules.js's own BRAND_RULES (key + aliases) rather than a second hand-maintained
// brand list — the same "no root-cause duplication" rule every other lookup module in this codebase
// follows (see e.g. contactLookup.js reusing documentTypes.js's completeness rules).
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const BRAND_WORD_ENTRIES = Object.entries(BRAND_RULES).flatMap(([key, v]) => [
  { word: key, key, label: v.label },
  ...((v.aliases ?? []).map((a) => ({ word: a, key, label: v.label }))),
]).sort((a, b) => b.word.length - a.word.length); // longest alias first ("american standard" before a shorter clash)

/** First known HVAC brand mentioned in free text, or null. Deterministic, no model. */
export function brandMentionIn(text) {
  const q = String(text ?? '');
  for (const { word, key, label } of BRAND_WORD_ENTRIES) {
    if (new RegExp(`\\b${escapeRe(word)}\\b`, 'i').test(q)) return { key, label };
  }
  return null;
}

// ---------------------------------------------------------------------- brand-vs-brand "those"
// R20 (J4, dialogue d036 — "how many goodman units are on our books" / "do we have more of those than
// lennox"): a bare `brandMentionIn(question)` check can't tell a question that already names ITS OWN
// brand ("how many of those Trane units...") apart from a two-brand COMPARISON where the pronoun and
// the named brand are two DIFFERENT halves of the same sentence — "those" (Goodman, from the prior
// turn) versus "lennox" (this turn's own comparison target). Treating the latter as "already has a
// brand" (the naive check) drops the Goodman reference entirely and answers a completely different,
// unfiltered comparison. resolve.js's inheritedBrandFrom uses this instead of a bare brandMentionIn
// call for exactly the 'refinement' kind.
const THAN_RE = /\bthan\b/i;
const COMPARISON_PRONOUN_RE = /\b(?:those|these|them)\b/i;

/**
 * True when `question` is a "than" comparison where ONE side is a bare pronoun ("those"/"these"/
 * "them") naming no brand of its own and the OTHER side names a real, different brand — the shape
 * that needs the pronoun's brand pulled from an EARLIER turn rather than read off this question's own
 * text (inheritedBrandFrom, resolve.js). A question with no "than" split at all falls back to the
 * plain "does this question mention any brand anywhere" check (unchanged from before this existed);
 * a "than" comparison naming no brand on EITHER side (a city/customer comparison, say) is left alone —
 * nothing to disambiguate.
 */
export function pronounNeedsBrandFromEarlierTurn(question) {
  const q = String(question ?? '');
  const idx = q.search(THAN_RE);
  if (idx < 0) return COMPARISON_PRONOUN_RE.test(q) && !brandMentionIn(q);
  const left = q.slice(0, idx);
  const right = q.slice(idx + 4);
  const leftBrand = brandMentionIn(left);
  const rightBrand = brandMentionIn(right);
  if (COMPARISON_PRONOUN_RE.test(left) && !leftBrand && rightBrand) return true;
  if (COMPARISON_PRONOUN_RE.test(right) && !rightBrand && leftBrand) return true;
  return false;
}

/**
 * Text this subject can stand in for inside a rewritten question — null when there is nothing usable.
 * `possessive` is deliberately a FIXED, address-free phrase ("the customer's") rather than "the
 * customer at <address>'s": fusing "'s" onto a raw address/house-number span risks corrupting the
 * exact substring a downstream address regex would otherwise match verbatim (an apostrophe-s glued
 * onto a street name is not a shape ADDRESS_RE/LOOSE_ADDRESS_RE were built to expect). `place` is
 * separately appended by the caller (see resolve.js's `ensureAnchorPresent`) so the anchor's own
 * unmodified text always appears somewhere in the composed question too.
 */
export function pronounReplacement(subject) {
  if (!subject) return null;
  const noun = subject.noun || 'units';
  if (subject.address) {
    return {
      place: `at ${subject.address}`,
      singular: `the unit at ${subject.address}`,
      plural: `the ${noun} at ${subject.address}`,
      possessive: `the customer's`,
    };
  }
  if (subject.name) {
    return {
      place: `for ${subject.name}`,
      singular: `${subject.name}'s ${subject.unitType || 'unit'}`,
      plural: `${subject.name}'s ${noun}`,
      possessive: `${subject.name}'s`,
    };
  }
  if (subject.customerNumber) {
    return {
      place: `for ${subject.customerNumber}`,
      singular: `the unit for ${subject.customerNumber}`,
      plural: `${subject.customerNumber}'s ${noun}`,
      possessive: `${subject.customerNumber}'s`,
    };
  }
  return null;
}

/** True when the anchor's own raw address/name span already appears verbatim in `text` — used to
 *  decide whether `repl.place` still needs appending after a pronoun substitution (see resolve.js). */
export function anchorAlreadyPresent(text, subject) {
  if (!subject) return true;
  const s = String(text ?? '');
  if (subject.address && s.includes(subject.address)) return true;
  if (subject.name && s.includes(subject.name)) return true;
  if (subject.customerNumber && s.includes(subject.customerNumber)) return true;
  return !(subject.address || subject.name || subject.customerNumber);
}

// One substitution per question is enough — a second pronoun-shaped word after the first is rewritten
// almost always something else in the sentence ("them" in "are them working" already got "it" above),
// and rewriting every match risks mangling the sentence rather than clarifying it.
const PRONOUN_TOKENS = [
  { re: /\bout there\b/i, kind: 'place' },
  { re: /\bover there\b/i, kind: 'place' },
  { re: /\bthere\b/i, kind: 'place' },
  { re: /\bthat one\b/i, kind: 'singular' },
  { re: /\bit\b/i, kind: 'singular' },
  { re: /\bthem\b/i, kind: 'plural' },
  { re: /\bthose\b/i, kind: 'plural' },
  { re: /\bthese\b/i, kind: 'plural' },
  { re: /\btheir\b/i, kind: 'possessive' },
];

/** Replaces the FIRST anaphoric token found with `repl`'s matching phrase. `changed` is false when the
 *  question carries no such token at all (nothing to substitute, caller falls back to appending). */
export function substitutePronouns(question, repl) {
  if (!repl) return { question, changed: false };
  for (const { re, kind } of PRONOUN_TOKENS) {
    if (repl[kind] && re.test(question)) {
      return { question: question.replace(re, repl[kind]), changed: true };
    }
  }
  return { question, changed: false };
}

export function stripTrailingPunct(q) {
  return String(q ?? '').replace(/[?.!]+\s*$/, '');
}
