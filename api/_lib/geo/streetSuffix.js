/**
 * Canonical street-suffix vocabulary — R17 (G4, consolidation, ../r16_d1_pipeline.json #5): four
 * files each hand-maintained their own street-suffix regex (fastPath.js's STREET_SUFFIX_RE,
 * contactLookup.js's STREET_SUFFIX_ALT, analytics.js's STREET_ADDRESS_RE, cache/semanticCache.js's
 * ADDRESS_RE) and each was missing different words — see that doc for the exact deltas. A real
 * address like "123 Main Hwy" or "456 Oak Ter" matched some of the four but not others, so the
 * semantic-cache slot for an address (which decides whether a cached answer is reused) could
 * disagree with what fastPath/analytics/contactLookup actually recognized as an address — a latent
 * cause of "stale cache serves the wrong address" bugs that would be very hard to reproduce from a
 * bug report alone.
 *
 * This module is the single source every one of those four sites imports from: the union of all
 * four lists (a strict superset only ever matches MORE, never less — behavior-preserving) plus a
 * few honestly-missing forms the union still lacked (the full "highway"/"terrace" spellings, and
 * "trail"/"loop", both common HVAC-service-area street types absent from all four originals).
 *
 * Each consumer keeps its OWN surrounding regex (anchors, capture groups, case flags, optional
 * street-number/city segments) — only the suffix WORD LIST is shared, via the plain alternation
 * source string below, so every consumer's existing structure is preserved exactly except for the
 * widened suffix coverage.
 */

// [abbreviation, full form] — full is null when there is no separate abbreviated form (e.g. "way",
// "loop"). Kept as pairs (rather than a flat list) so a caller that wants only abbreviations, only
// full forms, or both, can ask for exactly that.
export const STREET_SUFFIX_PAIRS = [
  ['ave', 'avenue'],
  ['blvd', 'boulevard'],
  ['cir', 'circle'],
  ['ct', 'court'],
  ['dr', 'drive'],
  ['hwy', 'highway'],
  ['ln', 'lane'],
  ['loop', null],
  ['pkwy', 'parkway'],
  ['pl', 'place'],
  ['rd', 'road'],
  ['st', 'street'],
  ['ter', 'terrace'],
  ['trl', 'trail'],
  ['way', null],
];

/** Every distinct suffix word form (abbreviated and full), lowercase, as a flat array. */
export const STREET_SUFFIX_WORDS = [
  ...new Set(STREET_SUFFIX_PAIRS.flatMap(([abbrev, full]) => (full ? [abbrev, full] : [abbrev]))),
];

/** Fast O(1) "is this lowercase word a recognized street-suffix word" check. */
export const STREET_SUFFIX_WORD_SET = new Set(STREET_SUFFIX_WORDS);

/** True when `word` (any case) is a recognized street-suffix word. */
export function isStreetSuffixWord(word) {
  return STREET_SUFFIX_WORD_SET.has(String(word ?? '').toLowerCase());
}

// Longest-first so an alternation that is embedded WITHOUT a trailing \b (or without the grouped
// `abbrev(?:rest)?` shorthand some consumers use) still prefers the longer match at a given
// position — the same "backtracking order shouldn't be load-bearing, but don't rely on it when a
// one-line sort makes it moot" caution this codebase already applies elsewhere (findTerms in
// cache/semanticCache.js sorts terms longest-first for the identical reason).
const WORDS_LONGEST_FIRST = [...STREET_SUFFIX_WORDS].sort((a, b) => b.length - a.length);

/** Bare alternation source, no surrounding group — e.g. "avenue|boulevard|...|way". Plug this
 *  directly into a capturing group `(${STREET_SUFFIX_ALTERNATION})` or a non-capturing one
 *  `(?:${STREET_SUFFIX_ALTERNATION})`, whichever the call site already used. */
export const STREET_SUFFIX_ALTERNATION = WORDS_LONGEST_FIRST.join('|');

/** Same alternation, pre-wrapped in a non-capturing group — for call sites (like fastPath.js's old
 *  STREET_SUFFIX_RE) that interpolate a single group-shaped string into a larger regex. */
export const STREET_SUFFIX_GROUP_SRC = `(?:${STREET_SUFFIX_ALTERNATION})`;

/** A ready-to-use, case-insensitive RegExp matching a single street-suffix word on its own (word
 *  boundaries both sides) — for a call site that just wants "is this token a suffix word", not an
 *  address extraction. Not shared by any of the four original consumers (they each embed the
 *  suffix list in a larger address pattern) but exported for convenience/tests. */
export const STREET_SUFFIX_RE = new RegExp(`\\b(?:${STREET_SUFFIX_ALTERNATION})\\b`, 'i');
