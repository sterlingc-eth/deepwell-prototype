/**
 * Unit checks for the canonical street-suffix module (R17 G4 consolidation,
 * ../r16_d1_pipeline.json #5) and its four consumers. Pure only — no database,
 * no network.
 *
 *   1. Suffix coverage: the shared module carries the union of all four
 *      previously-independent lists PLUS the honestly-missing forms
 *      (highway/terrace/trail/loop) the task asked to widen with.
 *   2. Abbreviated forms resolve the same as their full spelling.
 *   3. Each of the four real consumers (fastPath.js, analytics.js,
 *      contactLookup.js, cache/semanticCache.js) actually recognizes the
 *      newly-widened suffix words through its own real, exported entry
 *      point — not just the shared module in isolation.
 *   4. No false positives: a suffix WORD appearing outside a real
 *      house-number-led address shape ("Court Reporter", "Way to go",
 *      "Place an order") must never be mistaken for an address by any of
 *      the four consumers.
 *
 *   node scripts/verify-geo.mjs
 */
import {
  STREET_SUFFIX_PAIRS,
  STREET_SUFFIX_WORDS,
  STREET_SUFFIX_WORD_SET,
  STREET_SUFFIX_ALTERNATION,
  STREET_SUFFIX_GROUP_SRC,
  STREET_SUFFIX_RE,
  isStreetSuffixWord,
} from '../api/_lib/geo/streetSuffix.js';
import { extractSubject } from '../api/_lib/fastPath.js';
import { STREET_ADDRESS_RE } from '../api/_lib/analytics.js';
import { parseContactLookupQuestion } from '../api/_lib/contactLookup.js';
import { extractSlots } from '../api/_lib/cache/semanticCache.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * 1. Suffix coverage — the union of all four original lists, plus the
 *    widened additions the task explicitly asked for.
 * ====================================================================== */

// Union of everything the four original hand-maintained lists carried
// (see ../r16_d1_pipeline.json #5 for the exact per-file deltas this
// reconstructs), plus the "etc." widening the R17 contract calls for:
// highway/terrace long forms and the trail/loop street types absent from
// all four originals.
const REQUIRED_WORDS = [
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
  'blvd', 'boulevard', 'way', 'ct', 'court', 'pl', 'place', 'cir', 'circle',
  'pkwy', 'parkway', 'hwy', 'highway', 'ter', 'terrace', 'trl', 'trail', 'loop',
];
for (const w of REQUIRED_WORDS) {
  check(`STREET_SUFFIX_WORDS includes "${w}"`, STREET_SUFFIX_WORD_SET.has(w));
}
eq('no duplicate words in the flat list', STREET_SUFFIX_WORDS.length, new Set(STREET_SUFFIX_WORDS).size);
check(
  'STREET_SUFFIX_PAIRS and the flat word list agree',
  STREET_SUFFIX_PAIRS.flatMap(([a, f]) => (f ? [a, f] : [a])).every((w) => STREET_SUFFIX_WORD_SET.has(w))
);
check('STREET_SUFFIX_ALTERNATION has no wrapping group', !STREET_SUFFIX_ALTERNATION.startsWith('('));
check('STREET_SUFFIX_GROUP_SRC is a non-capturing group', STREET_SUFFIX_GROUP_SRC.startsWith('(?:') && STREET_SUFFIX_GROUP_SRC.endsWith(')'));

/* ======================================================================
 * 2. Abbreviated forms resolve the same as their full spelling.
 * ====================================================================== */
for (const [abbrev, full] of STREET_SUFFIX_PAIRS) {
  check(`isStreetSuffixWord("${abbrev}")`, isStreetSuffixWord(abbrev));
  check(`isStreetSuffixWord("${abbrev.toUpperCase()}") is case-insensitive`, isStreetSuffixWord(abbrev.toUpperCase()));
  if (full) check(`isStreetSuffixWord("${full}")`, isStreetSuffixWord(full));
}
check('isStreetSuffixWord rejects a non-suffix word', !isStreetSuffixWord('dental'));
check('STREET_SUFFIX_RE matches a bare abbreviation', STREET_SUFFIX_RE.test('hwy'));
check('STREET_SUFFIX_RE matches a bare full form', STREET_SUFFIX_RE.test('terrace'));

/* ======================================================================
 * 3. Each real consumer recognizes the widened words through its own
 *    actual exported entry point.
 * ====================================================================== */

// fastPath.js: extractSubject(...).address
const FASTPATH_WIDENED = [
  ['what is the serial number at 456 Oak Ter', '456 Oak Ter'],
  ['what is the serial number at 456 Oak Terrace', '456 Oak Terrace'],
  ['what is the serial number at 123 Main Hwy', '123 Main Hwy'],
  ['what is the serial number at 123 Main Highway', '123 Main Highway'],
  ['what is the serial number at 90 River Trl', '90 River Trl'],
  ['what is the serial number at 90 River Trail', '90 River Trail'],
  ['what is the serial number at 12 Sunset Loop', '12 Sunset Loop'],
];
for (const [q, wantPrefix] of FASTPATH_WIDENED) {
  const { address } = extractSubject(q);
  check(`fastPath.extractSubject recognizes "${wantPrefix}"`, address === wantPrefix, `got ${JSON.stringify(address)}`);
}

// analytics.js: STREET_ADDRESS_RE.test(...)
const ANALYTICS_WIDENED = [
  'Do we have a customer at 456 Oak Ter?',
  'Do we have a customer at 456 Oak Terrace?',
  'Do we have a customer at 123 Main Hwy?',
  'Do we have a customer at 123 Main Highway?',
  'Do we have a customer at 90 River Trl?',
  'Do we have a customer at 90 River Trail?',
  'Do we have a customer at 12 Sunset Loop?',
  'Do we have a customer at 200 Ocean Blvd?',
  'Do we have a customer at 200 Ocean Boulevard?',
];
for (const q of ANALYTICS_WIDENED) {
  check(`analytics.STREET_ADDRESS_RE matches "${q}"`, STREET_ADDRESS_RE.test(q));
}

// contactLookup.js: parseContactLookupQuestion's STREET_ONLY_RE shape (Shape 4) — a bare street
// reference with no customer name. Widened suffix words must now split OFF the street name
// (street === the name alone) rather than being swallowed into it (see this file's own doc
// comment on Shape 4 for why that distinction is the whole point of the fix).
const CONTACTLOOKUP_WIDENED = [
  ['the guy on Greenfield Highway', 'greenfield'],
  ['the guy on Greenfield Hwy', 'greenfield'],
  ['the guy on Larkspur Terrace', 'larkspur'],
  ['the guy on Larkspur Ter', 'larkspur'],
  ['the guy on Cedar Trail', 'cedar'],
  ['the guy on Sunset Loop', 'sunset'],
];
for (const [q, wantStreet] of CONTACTLOOKUP_WIDENED) {
  const parsed = parseContactLookupQuestion(q);
  check(
    `contactLookup.parseContactLookupQuestion("${q}") splits off the suffix`,
    parsed?.isStreet === true && parsed.street === wantStreet,
    `got ${JSON.stringify(parsed)}`
  );
}

// cache/semanticCache.js: extractSlots(...).addresses
const SEMANTICCACHE_WIDENED = [
  ['units at 456 oak ter', '456 oak ter'],
  ['units at 456 oak terrace', '456 oak terrace'],
  ['units at 123 main hwy', '123 main hwy'],
  ['units at 123 main highway', '123 main highway'],
  ['units at 90 river trl', '90 river trl'],
  ['units at 90 river trail', '90 river trail'],
  ['units at 12 sunset loop', '12 sunset loop'],
];
for (const [q, wantAddr] of SEMANTICCACHE_WIDENED) {
  const { addresses } = extractSlots(q);
  check(`semanticCache.extractSlots recognizes "${wantAddr}"`, addresses.includes(wantAddr), `got ${JSON.stringify(addresses)}`);
}

/* ======================================================================
 * 4. No false positives: a suffix word with no leading house number is
 *    never mistaken for an address by any of the four consumers.
 * ====================================================================== */
const NON_ADDRESS_SENTENCES = [
  'Please connect me with a Court Reporter',
  "Way to go on that install",
  'Can you Place an order for a new filter',
  'The technician was a real Trail blazer',
  'We went for a Loop around the building',
];
for (const q of NON_ADDRESS_SENTENCES) {
  const { address } = extractSubject(q);
  check(`fastPath.extractSubject: no address in "${q}"`, address === null, `got ${JSON.stringify(address)}`);
  check(`analytics.STREET_ADDRESS_RE: no match in "${q}"`, !STREET_ADDRESS_RE.test(q));
  const { addresses } = extractSlots(q);
  eq(`semanticCache.extractSlots: no address in "${q}"`, addresses, []);
}
// contactLookup.js's Shape 4 (STREET_ONLY_RE) captures ANY bare 1-3 word phrase after "the guy
// on"/"customers on" as a candidate street name whether or not a recognized suffix follows it
// (unrelated to this suffix list — a genuinely different street this business has, "Elm", behaves
// identically) — so a suffix word alone ("the guy on Court") is NOT a false positive to fix here.
// What DOES matter for this file's suffix list specifically: widening it must not change how a
// bare street-suffix-shaped word parses relative to an equally bare non-suffix word — both are
// still just "the street name", proving the widened list didn't newly special-case anything here.
for (const [suffixWord, controlWord] of [['court', 'elm'], ['way', 'birch'], ['place', 'maple']]) {
  const withSuffix = parseContactLookupQuestion(`the guy on ${suffixWord}`);
  const control = parseContactLookupQuestion(`the guy on ${controlWord}`);
  check(
    `contactLookup: bare "${suffixWord}" parses the same shape as bare "${controlWord}"`,
    withSuffix?.isStreet === control?.isStreet && withSuffix?.field === control?.field,
    `got ${JSON.stringify(withSuffix)} vs ${JSON.stringify(control)}`
  );
}

console.log(failures === 0 ? '\nAll geo/street-suffix checks passed.' : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
