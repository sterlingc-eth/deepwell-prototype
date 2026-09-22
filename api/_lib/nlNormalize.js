/**
 * Donovan NL normalization layer (Day 1, handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md).
 * Pure, no I/O beyond one synchronous read of the bundled geo table at module
 * load (same idiom api/_lib/analytics.js already uses for zip-county.json) —
 * no `db`, no Anthropic client, zero model calls. Cleans sloppy dispatcher
 * input BEFORE it reaches preClassifyAnalytics/the Haiku planner:
 *   - lowercases, strips a fixed set of leading filler phrases and trailing
 *     punctuation
 *   - expands a small, unambiguous abbreviation table (az -> arizona, ...)
 *   - fuzzy-corrects a likely typo (Damerau-Levenshtein <= 1) on any token of
 *     5+ letters against a closed vocabulary built from ENTITY_SYNONYMS,
 *     known HVAC brand names, month names, US state names, and the AZ/NV
 *     city/county names bundled in geo/zip-county.json
 *
 * `normalizeQuestion` never touches a token that looks like part of an
 * address or identifier (see the single-record guard below) — a street
 * number, a serial fragment, or any digit-bearing token must survive
 * untouched so looksLikeSingleRecordReference (analytics.js) keeps working
 * exactly the same on normalized text as on raw text. See
 * scripts/verify-question-bank.mjs for the checks that pin this down.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENTITY_SYNONYMS, looksLikeSingleRecordReference } from './analytics.js';
import { BRAND_RULES } from './warrantyRules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const zipCounty = JSON.parse(readFileSync(join(__dirname, 'geo', 'zip-county.json'), 'utf8'));

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
  'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
];

function wordsOf(phrase) {
  return String(phrase ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/** Closed vocabulary a fuzzy-corrected token must land on — every word from
 *  ENTITY_SYNONYMS (analytics.js's own noun table, so the two files can never
 *  drift apart), every known HVAC brand name/alias (warrantyRules.js's
 *  BRAND_RULES — the same table the warranty engine itself trusts), every
 *  month name, every US state name, and every AZ/NV city/county name the
 *  bundled geo table knows about. Built once at module load. */
// Day 1 question-bank baseline (2026-09-21, gen-question-bank.mjs) found a
// real gap: "phone"/"email"/"month"/"year"/"week" are load-bearing words for
// detectedConditions/resolveQuestionTimeRange (analytics.js) but appear in
// none of ENTITY_SYNONYMS/brands/months/states/cities — a typo'd "phnoe" or
// "monnth" had no vocabulary word to fuzzy-correct back to at all. These are
// exactly as unambiguous as anything else in the table above.
const EXTRA_DOMAIN_WORDS = [
  'email', 'phone', 'month', 'months', 'year', 'years', 'week', 'weeks', 'address',
  // QUANTIFIER's own trigger words (analytics.js) — same gap as the contact/
  // time words above: "which"/"count"/"total" are load-bearing for
  // preClassifyAnalytics but weren't anywhere in the vocabulary a typo could
  // land back on ("xhich customers have Lennox units" never recovered).
  'which', 'count', 'total',
  // Live miss clusters 2+3 (2026-09-21): 'money'/'maintenance' detection
  // (analytics.js's MONEY_RE/MAINTENANCE_DUE_RE) keys off exact words —
  // "billed"/"revenue"/"overdue" — that are just as load-bearing as the
  // contact/time words above and just as absent from every other list this
  // vocabulary is built from, so a typo'd "reevnue" or "overde" had nothing
  // to fuzzy-correct back to.
  'billed', 'revenue', 'overdue', 'maintenance',
  // HVAC persona bank (2026-09-21): "how many different zip coeds do we
  // cover" — analytics.js's ZIP_CODE_WORD_RE keys off the exact word "codes",
  // same load-bearing-word gap as 'billed'/'overdue' above; "codes" was
  // nowhere in this vocabulary for the typo to fuzzy-correct back to.
  'codes',
  // Live miss ("which units had service this month", 2026-09-21): "serviced"
  // is a real, correctly-spelled word (past tense of "service"), never a typo
  // of "service" — but at 8 letters, one edit-distance-1 deletion away from
  // the 7-letter "service" already in this vocabulary (via ENTITY_SYNONYMS'
  // "service visit"/"service call"), it was getting silently "corrected" to
  // "service" by fuzzyCorrect below every time, on every question that used
  // it. Harmless for classification itself (every consumer of "service(d)"
  // text — analytics.js's SERVICE_VISITS_OVERRIDE_RE included — matches both
  // spellings on purpose, see that regex's own doc comment) but still a
  // needless, surprising rewrite of a real word; keeping "serviced" in vocab
  // stops fuzzyCorrect from ever touching it in the first place.
  'serviced',
  // HVAC persona bank (2026-09-21): analytics.js's own SUPERLATIVE_RE keys off
  // these exact words ("oldest"/"newest"/...) the same load-bearing-word way
  // 'billed'/'overdue' above already do — none were anywhere in this
  // vocabulary for a typo ("oewest") to fuzzy-correct back to.
  'oldest', 'newest', 'latest', 'earliest',
  // 100-question persona sample (2026-09-22): the same load-bearing-word gap
  // as 'billed'/'overdue' above, now for this session's own new exact-word
  // regexes — HOW_MANY_TIMES_RE (contactLookup.js) keys off "times", and
  // MONEY_RE's item 6 additions (analytics.js) key off "collected"/"fees"/
  // "receivables"/"outstanding". "quarter" backs item 5's "this quarter"/
  // "last quarter" time windows the same way "week"/"month" above already do.
  'times', 'collected', 'fees', 'receivables', 'outstanding', 'quarter', 'quarters',
];

function buildVocab() {
  const words = new Set();
  for (const w of EXTRA_DOMAIN_WORDS) words.add(w);
  for (const list of Object.values(ENTITY_SYNONYMS)) {
    for (const phrase of list) for (const w of wordsOf(phrase)) words.add(w);
  }
  for (const [brand, rule] of Object.entries(BRAND_RULES)) {
    for (const w of wordsOf(brand)) words.add(w);
    for (const alias of rule.aliases ?? []) for (const w of wordsOf(alias)) words.add(w);
  }
  for (const m of MONTH_NAMES) words.add(m);
  for (const s of US_STATE_NAMES) for (const w of wordsOf(s)) words.add(w);
  for (const city of Object.keys(zipCounty.azCityCounty ?? {})) for (const w of wordsOf(city)) words.add(w);
  for (const county of [
    ...Object.values(zipCounty.azZip3Default ?? {}),
    ...Object.values(zipCounty.azZipExceptions ?? {}),
  ]) {
    if (county) for (const w of wordsOf(county)) words.add(w);
  }
  for (const [key, v] of Object.entries(zipCounty.usCityCounty ?? {})) {
    const state = key.split('|')[1];
    if (state !== 'az' && state !== 'nv') continue;
    for (const w of wordsOf(key.split('|')[0])) words.add(w);
    if (v?.county) for (const w of wordsOf(v.county)) words.add(w);
  }
  return words;
}

export const VOCAB = buildVocab();

// Only vocab words of length >= 4 can ever be within edit distance 1 of a
// token we're willing to correct (5+ letters, |len diff| <= 1) — indexing by
// length keeps a fuzzy-correction pass over a whole question cheap even
// against a few-hundred-word vocabulary.
const VOCAB_BY_LEN = new Map();
for (const w of VOCAB) {
  if (w.length < 4) continue;
  if (!VOCAB_BY_LEN.has(w.length)) VOCAB_BY_LEN.set(w.length, []);
  VOCAB_BY_LEN.get(w.length).push(w);
}

/** True when `a`/`b` are the same word, one substitution/transposition apart
 *  (equal length), or one insertion/deletion apart (length differs by 1) —
 *  i.e. Damerau-Levenshtein distance <= 1. */
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
    if (s[i] === l[j]) { i++; j++; continue; }
    if (usedSkip) return false;
    usedSkip = true;
    j++;
  }
  return true;
}

/** A likely-typo correction for `token`, or null. Never called on a token
 *  already in vocab, shorter than 5 letters, or containing a digit — see
 *  normalizeQuestion's own guards, which check all three before calling this.
 *  `vocabByLen` defaults to the base table but a learned-overlay call passes
 *  its own merged one (see withLearnedOverlay below) — never mutated here. */
function fuzzyCorrect(token, vocabByLen = VOCAB_BY_LEN) {
  for (const len of [token.length - 1, token.length, token.length + 1]) {
    const candidates = vocabByLen.get(len);
    if (!candidates) continue;
    for (const cand of candidates) {
      if (withinEditDistance1(token, cand)) return cand;
    }
  }
  return null;
}

/* ============================================================ learned overlay
 *
 * Tier 2 "Donovan learns nightly" (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md),
 * Part A: an optional, explicit `overlay` object —
 * `{ abbreviations: {from:to}, typos: {from:to}, vocab: [words] }` — that
 * WIDENS the tables above for one call, with ZERO effect when omitted or
 * empty (every existing caller/behavior is byte-for-byte unchanged). This
 * file never holds a shared, mutable "current overlay": normalizeQuestion
 * always takes the overlay as an explicit argument, so two callers (e.g. a
 * live request using the process-wide active overlay vs.
 * api/_lib/learning/verify.js probing a single CANDIDATE proposal) can never
 * see or leak into each other's tables, no matter what order they run in.
 *
 * withLearnedOverlay(overlay, fn) builds the merged {abbrev, vocab,
 * vocabByLen} bag (or reuses the base tables untouched when the overlay is
 * empty) and calls `fn(tables)` with it. A WeakMap caches the merged bag per
 * overlay OBJECT identity — the process-wide active overlay
 * (learning/overlay.js's getActiveOverlay, cached 10 minutes) is the same
 * object across many requests, so it's only ever merged once; a fresh
 * overlay object (a new proposal being tested) never collides with, or
 * reuses, another one's cached bag.
 */
function isOverlayEmpty(overlay) {
  if (!overlay) return true;
  return !(
    (overlay.abbreviations && Object.keys(overlay.abbreviations).length) ||
    (overlay.typos && Object.keys(overlay.typos).length) ||
    (overlay.vocab && overlay.vocab.length)
  );
}

function buildVocabByLen(vocab) {
  const map = new Map();
  for (const w of vocab) {
    if (w.length < 4) continue;
    if (!map.has(w.length)) map.set(w.length, []);
    map.get(w.length).push(w);
  }
  return map;
}

function mergeOverlayTables(overlay) {
  const abbrev =
    (overlay.abbreviations && Object.keys(overlay.abbreviations).length) ||
    (overlay.typos && Object.keys(overlay.typos).length)
      ? { ...ABBREV, ...(overlay.abbreviations ?? {}), ...(overlay.typos ?? {}) }
      : ABBREV;
  let vocab = VOCAB;
  if (overlay.vocab && overlay.vocab.length) {
    vocab = new Set(VOCAB);
    for (const w of overlay.vocab) vocab.add(String(w ?? '').toLowerCase());
  }
  const vocabByLen = vocab === VOCAB ? VOCAB_BY_LEN : buildVocabByLen(vocab);
  return { abbrev, vocab, vocabByLen };
}

/**
 * Conservative, unambiguous abbreviation table — expanded only as a whole
 * token (word-boundary), never as a substring, so it can never fire inside a
 * customer name, address, or serial number. "st" (street) and "hvac" are
 * deliberately NOT in this table: "st" collides with "Saint"/other proper
 * nouns often enough that blind expansion risks corrupting an address, and
 * "hvac" already accompanies a recognized noun (system/unit/...) in every
 * real phrasing, so expanding it buys no classification benefit for the risk
 * of introducing a new ambiguous word into the pipeline.
 */
const ABBREV = {
  az: 'arizona', nv: 'nevada', ca: 'california',
  cust: 'customer', custs: 'customers', ppl: 'people',
  ac: 'air conditioner', mo: 'month', yr: 'year', yrs: 'years',
  tech: 'technician', techs: 'technicians', qty: 'quantity', addy: 'address', addr: 'address',
  // HVAC persona bank (2026-09-21): "tuc customers" / "cg customers" —
  // dispatcher shorthand for the two AZ service-area cities this corpus
  // actually covers. "tuc" has no other meaning in this domain; "cg" is
  // added only for the one unambiguous city it already stands for in the
  // answer key (Casa Grande) — neither is a real word this table would ever
  // need to leave alone for some OTHER meaning.
  tuc: 'tucson', cg: 'casa grande',
};

// Base tables + per-overlay-object cache for withLearnedOverlay above —
// declared here (not next to that function) because they need ABBREV, which
// must be defined first.
const BASE_TABLES = { abbrev: ABBREV, vocab: VOCAB, vocabByLen: VOCAB_BY_LEN };
const overlayTableCache = new WeakMap();

export function withLearnedOverlay(overlay, fn) {
  if (isOverlayEmpty(overlay)) return fn(BASE_TABLES);
  let tables = overlayTableCache.get(overlay);
  if (!tables) {
    tables = mergeOverlayTables(overlay);
    overlayTableCache.set(overlay, tables);
  }
  return fn(tables);
}

// Leading filler this project's dispatchers/owners actually type before the
// real question (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md's sloppiness
// variants). Deliberately excludes "give me"/"show me"/"pull up"/"list"/
// "need the" — those carry the quantifier QUANTIFIER (analytics.js) itself
// relies on, so they are kept as-is rather than stripped as pure filler.
const FILLER_PREFIX_RE =
  /^(hey|hi donovan|hi|quick question|real quick|can you tell me|could you|i want to know|i need to know|i need|please)[,:]?\s+/;

function stripFillerPrefixes(q) {
  let out = q;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(FILLER_PREFIX_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Symbol/compound abbreviations that aren't a single alnum token, handled as
 *  string substitutions before word-level splitting. Order matters: "w/o"
 *  must be checked before the plainer "w/" pattern, and "ph#" before the bare
 *  "#" one. */
// A handful of common short-word typos ("toal" for "total") that fuzzyCorrect
// below can never reach — its own floor only ever touches a 5+ letter token
// (see fuzzyCorrect's own doc comment for why), which structurally excludes
// a 4-letter word no matter how close it is to a real one. HVAC persona bank
// (2026-09-21): "what's the toal amount we've invoiced" fell through
// isMoneyQuestion entirely because MONEY_RE needs the literal word "total"
// right before "amount" — a tiny, closed table, the same shape
// contactLookup.js's own FIELD_WORD_TYPO_FIXES already uses for exactly this
// "too short for the general fuzzy floor" gap.
const SHORT_WORD_TYPO_FIXES = [
  [/\btoal\b/g, 'total'],
  [/\bwhch\b/g, 'which'],
  [/\bcals\b/g, 'calls'],
  // "moth" is a real word (the insect) so it's never in this domain's own
  // vocabulary to correct TO, but it never legitimately appears in an HVAC
  // dispatch question either — "what equipment got serviced this moth" is
  // always the "month" typo, never a bug question.
  [/\bmoth\b/g, 'month'],
  // "csuts" is a typo of the ABBREVIATION "custs", not of the full word
  // "customers" itself (too far apart for fuzzyCorrect's own edit-distance-1
  // floor to bridge) — mapped straight to the fully-expanded form so it
  // doesn't need a second, separate ABBREV-table pass to finish the job.
  [/\bcsuts\b/g, 'customers'],
  // 100-question persona sample (2026-09-22): "how many tims have we been to
  // Mercer's" — a deletion typo of "times" lands on a 4-letter token, the
  // same "too short for the general fuzzy floor" gap 'toal'/'whch' above
  // already document. HOW_MANY_TIMES_RE (contactLookup.js) needs the literal
  // word "times".
  [/\btims\b/g, 'times'],
];

// Used by normalizeQuestion's own fuzzy-correction guard (below) to protect
// the word right before a street-suffix from being "corrected" against the
// general vocabulary — a street name is never in that vocabulary to begin
// with, so without this guard a genuine one gets silently rewritten into
// whatever vocab word happens to be closest.
const STREET_SUFFIX_WORD_RE =
  /^(?:ave|avenue|rd|road|st|street|blvd|boulevard|dr|drive|ln|lane|ct|court|way)$/i;

function fixShortWordTypos(q) {
  let out = q;
  for (const [re, to] of SHORT_WORD_TYPO_FIXES) out = out.replace(re, to);
  return out;
}

function expandSymbols(q) {
  return fixShortWordTypos(q)
    .replace(/\bph#/g, 'phone number')
    .replace(/\be-mail\b/g, 'email')
    .replace(/\bw\/o\b/g, 'without')
    .replace(/\bw\//g, 'with ')
    .replace(/#/g, ' number ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * normalizeQuestion(text, { overlay }) -> { normalized, original, corrections }
 * `corrections` lists every abbreviation-expansion/fuzzy-fix actually made
 * (never filler/punctuation removal, which isn't a "correction" worth
 * surfacing) — kept for a future "showing results for..." UI affordance, not
 * wired into any UI yet.
 *
 * `overlay` (optional): a runtime-learned `{abbreviations, typos, vocab}`
 * bag (see withLearnedOverlay above) that widens the abbreviation/typo/vocab
 * tables for this call only — omitted, null, or empty, behavior is byte-for-
 * byte identical to before overlays existed.
 */
export function normalizeQuestion(text, opts = {}) {
  const overlay = opts?.overlay;
  const original = String(text ?? '');
  let q = original.toLowerCase().trim().replace(/\s+/g, ' ');
  q = q.replace(/[?!.]+$/, '').trim();
  q = stripFillerPrefixes(q);
  q = expandSymbols(q);

  const corrections = [];
  // A question that names a street address / "at <number> <word>" reference /
  // serial-shaped token must survive with its own words untouched — fuzzy
  // correction is skipped entirely for the whole question when the ORIGINAL
  // text already looks like a single-record reference (analytics.js's own
  // detector), rather than trying to guess which individual token is the
  // address and which isn't.
  const singleRecord = looksLikeSingleRecordReference(original);
  const words = q.split(' ').filter(Boolean);

  const normalized = withLearnedOverlay(overlay, (tables) => {
    const out = words.map((raw, idx) => {
      // HVAC persona bank (2026-09-21): "which custs' addresses might need
      // double checking" — a trailing bare possessive apostrophe ("custs'")
      // used to survive untouched (only ,;: were stripped here), so the ABBREV
      // exact-token lookup below never matched "custs'" against its "custs"
      // key and the question never got its "customers" expansion at all. A
      // trailing apostrophe with nothing after it is always a plural
      // possessive marker, never part of the word itself, so it's safe to
      // strip the same way trailing punctuation already is.
      const trailMatch = raw.match(/['’,;:]+$/);
      const trail = trailMatch ? trailMatch[0] : '';
      const core = trail ? raw.slice(0, -trail.length) : raw;
      const lower = core.toLowerCase();

      if (Object.prototype.hasOwnProperty.call(tables.abbrev, lower)) {
        const to = tables.abbrev[lower];
        corrections.push({ from: lower, to });
        return to + trail;
      }

      const isPlainWord = /^[a-z]+$/.test(lower);
      if (!singleRecord && isPlainWord && lower.length >= 5 && !tables.vocab.has(lower)) {
        // Extra belt-and-suspenders guard even outside the single-record case:
        // a word immediately after a number is almost always a street name
        // component ("123 Maple") — never fuzzy-corrected.
        const prevRaw = idx > 0 ? words[idx - 1].replace(/[^a-z0-9]/gi, '') : '';
        const prevIsNumber = /^\d+$/.test(prevRaw);
        // Reviewer NO-GO (2026-09-22): "Cgrande Ave" — a word immediately
        // BEFORE a street-suffix word (ave/rd/st/blvd/dr/ln/ct/way, or the
        // spelled-out forms) is a street name, the same strong "don't touch
        // this" signal a number right before it already is above. This one
        // has no digit anywhere to trip STREET_ADDRESS_RE/the singleRecord
        // guard at all, so it needed its own check.
        const nextRaw = idx < words.length - 1 ? words[idx + 1].replace(/[^a-z]/gi, '').toLowerCase() : '';
        const nextIsStreetSuffix = STREET_SUFFIX_WORD_RE.test(nextRaw);
        if (!prevIsNumber && !nextIsStreetSuffix) {
          const fixed = fuzzyCorrect(lower, tables.vocabByLen);
          if (fixed) {
            corrections.push({ from: lower, to: fixed });
            return fixed + trail;
          }
        }
      }
      return raw;
    });
    return out.join(' ').replace(/\s+/g, ' ').trim();
  });

  return { normalized, original, corrections };
}
