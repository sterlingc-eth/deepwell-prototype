/**
 * decompose/clauses.js — Round 11, item 1 (literature #2, query decomposition), the PURE half: no db, no
 * model. Parses a multi-part/conjunctive question into a closed set of typed "sub-query" clauses, or a
 * two-sided comparison — the same "closed vocabulary, never free-form SQL" idiom compose.js/
 * relations/questions.js already use for their own conjunctive shapes. Deliberately conservative: a
 * question decompose/index.js should NOT claim returns an empty clause list (or null for a comparison
 * that isn't fully two-sided), never a best-effort guess.
 *
 * Where this overlaps compose.js's own condition vocabulary (brand/ageOlder/warrantyStatus/hasDocType/
 * geoCity/noEmail/...), the SAME condition `type` strings are used on purpose so
 * decompose/entitySets.js can hand a shared condition straight to compose.js's own exported
 * `matchesCondition` against ONE shared customer universe (compose.js's exported `fetchUniverse`) rather
 * than re-deriving a second definition of "does this customer satisfy X". This file exists because
 * compose.js's own parser only recognizes ONE fixed phrasing per condition and has no vocabulary at all
 * for a cross-document-timeline condition (a callback) or an absolute-date condition ("no visit since
 * 2024") — see this file's own CLAUSE matchers below for exactly what it adds.
 */

import { KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from '../analytics.js';

const reEscape = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/* ==================================================================== comparison shape */

// "Compare invoices vs POs for the Rios job" / "Compare invoices to purchase orders for 214 Mercer St"
// / "invoices versus POs for the Bracken account". Two doc-type phrases and one subject (an address or a
// customer/job name); the trailing "job"/"account"/"property" noun is stripped from the subject before
// resolution (decompose/compare.js resolves the bare name/address).
const COMPARE_RE =
  /^(?:compare\s+)?(.+?)\s+(?:vs\.?|versus|to|and)\s+(.+?)\s+for\s+(?:the\s+)?(.+?)(?:\s+(?:job|account|property))?\??$/i;

/** Canonical financial doc_kind(s) (financials/normalize.js's FINANCIAL_KINDS_BY_TYPE) a comparison
 *  phrase means, or null when the phrase names nothing this engine can compare. A closed, small table —
 *  never guessed — because a comparison's two sides must each resolve to an UNAMBIGUOUS doc_kind set. */
const COMPARE_PHRASE_TO_KINDS = {
  invoice: ['invoice'], invoices: ['invoice'], bill: ['invoice'], bills: ['invoice'],
  po: ['po'], pos: ['po'], 'purchase order': ['po'], 'purchase orders': ['po'],
  estimate: ['estimate'], estimates: ['estimate'], quote: ['estimate'], quotes: ['estimate'], proposal: ['estimate'], proposals: ['estimate'],
  'change order': ['change_order'], 'change orders': ['change_order'],
  'credit memo': ['credit_memo'], 'credit memos': ['credit_memo'],
  agreement: ['agreement'], agreements: ['agreement'],
  statement: ['statement'], statements: ['statement'],
  receipt: ['receipt'], receipts: ['receipt'],
};

function phraseToKinds(phrase) {
  const p = String(phrase ?? '').trim().toLowerCase();
  return COMPARE_PHRASE_TO_KINDS[p] ?? null;
}

/** Pure: question -> {mode:'compare', aLabel, aKinds, bLabel, bKinds, subject} or null. */
export function parseComparison(question) {
  const q = String(question ?? '').trim();
  const m = COMPARE_RE.exec(q);
  if (!m) return null;
  const aKinds = phraseToKinds(m[1]);
  const bKinds = phraseToKinds(m[2]);
  const subject = m[3].trim();
  if (!aKinds || !bKinds || !subject) return null;
  return { mode: 'compare', aLabel: m[1].trim(), aKinds, bLabel: m[2].trim(), bKinds, subject };
}

/* ==================================================================== conjunctive clauses */

const DOC_PHRASE_EXCLUDE = new Set(['other', 'internal', 'equipment-record', 'nameplate-photo', 'correspondence']);

function docTypePhrases(pack) {
  return (pack?.documentTypes ?? [])
    .filter((t) => !DOC_PHRASE_EXCLUDE.has(t.id))
    .map((t) => ({ id: t.id, phrase: String(t.label ?? t.id).toLowerCase().trim() }))
    .filter((t) => t.phrase);
}

/** Bare-noun doc-type mention ("no agreement", "an agreement on file") — broader than compose.js's own
 *  docTypeMention, which requires the FULL phrase ("no maintenance agreement"). Matches the LAST word of
 *  the phrase too, so "no agreement"/"no maintenance agreement" both resolve to the same canonical id -
 *  the shape the R11 brief's own "with no agreement" example needs and compose.js's parser doesn't cover. */
function docTypeMention(q, phrase) {
  const words = phrase.split(/\s+/);
  const bare = words[words.length - 1]; // "agreement" out of "maintenance agreement"
  const alt = bare === phrase ? reEscape(phrase) : `(?:${reEscape(phrase)}|${reEscape(bare)})`;
  const NEG = [
    new RegExp(`\\bno\\s+${alt}s?\\b`, 'i'),
    new RegExp(`\\bwithout\\s+(?:a |an )?${alt}\\b`, 'i'),
    new RegExp(`\\b(?:don'?t|do not) have\\s+(?:a |an )?${alt}\\b`, 'i'),
    new RegExp(`\\bnever (?:had|signed|has)\\s+(?:a |an )?${alt}\\b`, 'i'),
    new RegExp(`\\blacks?\\s+(?:a |an )?${alt}\\b`, 'i'),
  ];
  if (NEG.some((re) => re.test(q))) return 'lacks';
  const POS = [
    new RegExp(`\\b(?:have|has)(?: both)?\\s+(?:a |an )?${alt}\\b`, 'i'),
    new RegExp(`\\bwith\\s+(?:a |an )?${alt}\\b`, 'i'),
    new RegExp(`\\bsigned\\s+(?:a |an )?${alt}\\b`, 'i'),
    new RegExp(`${alt} on file`, 'i'),
  ];
  if (POS.some((re) => re.test(q))) return 'has';
  return null;
}

// "in <City>" anywhere in the question (broader than compose.js's own geoCity, which requires the city
// be immediately followed by "have"/"has") — "customers in Mesa with units older than..." needed this.
// R11 (hvac-owner-0027, golden tenant): a single-word capture truncated a real two-word city ("Casa
// Grande" -> "Casa"), which then matched NO on-file address at all (deriveGeo's own city parse keeps
// the whole name) and silently zeroed the answer. Matched against the tenant's own real city
// vocabulary instead (KNOWN_AZ_CITY_NAMES/KNOWN_US_CITY_NAMES — the same list, and the same
// longest-name-first idiom, analytics.js's own schema-linking city match already uses), longest name
// first so "Casa Grande" wins over a shorter city that happens to be a substring of it.
const CITY_NAMES_BY_LENGTH = [...new Set([...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES])].sort((a, b) => b.length - a.length);
function geoCityFrom(q) {
  if (/\bin\s+[A-Za-z]/.test(q)) {
    const lower = q.toLowerCase();
    const hit = CITY_NAMES_BY_LENGTH.find((c) => new RegExp(`\\bin\\s+${reEscape(c)}\\b`, 'i').test(lower));
    if (hit) return hit.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  // R14 (K4): a follow-up narrowing's own idiom — "...what about just the Mesa ones?" — names the city
  // with no "in" at all. Matched the same way (longest known city name first) against ONLY this one
  // extra shape, never a bare "the Mesa ones" with no "just" (too easy to collide with an unrelated
  // "the <adjective> ones" sentence that never meant a city).
  const justThe = /\bjust the ([A-Za-z][A-Za-z .'-]*?) ones\b/i.exec(q);
  if (justThe) {
    const lower = justThe[1].toLowerCase().trim();
    const hit = CITY_NAMES_BY_LENGTH.find((c) => c === lower);
    if (hit) return hit.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return null;
}

// "no visit since 2024" / "haven't had a service visit since 2024" / "no service since 2024" — an
// ABSOLUTE year cutoff, distinct from compose.js's own lacksRecentService (a rolling N-month window).
const NO_VISIT_SINCE_RE = /\b(?:no|hasn'?t had a?|haven'?t had a?)\s+(?:service\s+)?visit\s+since\s+(\d{4})\b/i;
const NO_SERVICE_SINCE_RE = /\bno\s+service\s+since\s+(\d{4})\b/i;

// "a callback (with)in N days" (compose.js/relations already parse this shape) OR, new here, an
// unqualified "had a callback this year" / "had a callback since 2024" — a callback with no day window
// named uses DEFAULT_CALLBACK_WINDOW_DAYS (the corpus's own modal value, see decompose/index.js).
const CALLBACK_DAYS_RE = /\bcallback\s+within\s+(\d{1,4})\s*days?\b/i;
const CALLBACK_THIS_YEAR_RE = /\bhad\s+a\s+callback\s+this\s+year\b/i;
const CALLBACK_SINCE_RE = /\bhad\s+a\s+callback\s+since\s+(\d{4})\b/i;

// "older than 10 years" / "over 10 years old" — both real phrasings the exam's own two-condition
// category uses for the identical shape ("a unit over 10 years old" alongside "older than 10 years").
const AGE_OLDER_RE = /\b(?:older than|over)\s+(\d{1,3})\s*years?(?:\s+old)?\b/i;
// "installed more than N days ago" — a DAY-accurate cutoff (today - N days), distinct from AGE_OLDER_RE's
// year-truncated comparison; compose.js's own 'ageOlder' has no vocabulary for this at all, so it was
// previously silently dropped here too (breadth-connect-052/056-059, golden tenant).
const AGE_OLDER_DAYS_RE = /\binstalled\s+more\s+than\s+(\d{1,4})\s*days?\s+ago\b/i;
// R14 (K4): "out of warranty" / "warranty (already) lapsed" are the SAME 'expired' status compose.js's
// warrantyStatus condition already computes (warrantyRules.js's own three-bucket expired/expiring/active) —
// just two more everyday phrasings for it, never a new status.
const WARRANTY_EXPIRED_RE = /\bexpired\s+warrant(?:y|ies)\b|\bwarrant(?:y|ies)\s+(?:already\s+)?lapsed\b|\bout\s+of\s+warranty\b/i;
const WARRANTY_EXPIRING_RE = /\bwarrant(?:y|ies)\s+expiring\b|\bexpiring\s+warrant(?:y|ies)\b/i;
const WARRANTY_ACTIVE_RE = /\bactive\s+warrant(?:y|ies)\b/i;
const NO_EMAIL_RE = /\b(?:no|missing|without)\s+(?:an?\s+)?email\b|\bemail\b.*\bmissing\b/i;
// R14 (K4): the positive counterpart — "have email on file" / "with an email on file" — needed for a
// follow-up narrowing ("...and how many of those have email on file?"), never confused with NO_EMAIL_RE
// (checked first by parseFilterClauses) since that one already claims every negated phrasing.
const HAS_EMAIL_RE = /\bhave\s+(?:an?\s+)?email\b|\bemail\s+on\s+file\b/i;
const NO_PHONE_RE = /\b(?:no|missing|without)\s+(?:a\s+)?phone\b|\bdon'?t have\s+(?:a\s+)?phone\b/i;
const UNIT_COUNT_RE = /\bmore than\s+(\d{1,3}|one)\s+units?\b/i;
const BRAND_SPREAD_RE = /\b(two|three|four|\d+)\s+or more\s+different\s+brands\b/i;
const TECHNICIAN_RE = /\bserviced by\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/;

/** Pure: every condition clause `q` names, in a closed vocabulary shared by parseFilterClauses and the
 *  follow-up combo parser below — factored out so a two-part "-- " question can collect conditions from
 *  EACH half with the exact same detectors, rather than a second, drifting copy of this list. */
function collectConditions(q, pack) {
  const conditions = [];

  const brands = (pack?.brands ?? []).filter((b) => new RegExp(`\\b${reEscape(b)}\\b`, 'i').test(q));
  if (brands.length) conditions.push({ type: 'brand', values: brands });

  const age = AGE_OLDER_RE.exec(q);
  if (age) conditions.push({ type: 'ageOlder', years: Number(age[1]) });

  const ageDays = AGE_OLDER_DAYS_RE.exec(q);
  if (ageDays) conditions.push({ type: 'ageOlderDays', days: Number(ageDays[1]) });

  if (WARRANTY_EXPIRED_RE.test(q)) conditions.push({ type: 'warrantyStatus', status: 'expired' });
  else if (WARRANTY_EXPIRING_RE.test(q)) conditions.push({ type: 'warrantyStatus', status: 'expiring' });
  else if (WARRANTY_ACTIVE_RE.test(q)) conditions.push({ type: 'warrantyStatus', status: 'active' });

  for (const { id, phrase } of docTypePhrases(pack)) {
    const mention = docTypeMention(q, phrase);
    if (mention === 'has') conditions.push({ type: 'hasDocType', id, phrase });
    else if (mention === 'lacks') conditions.push({ type: 'lacksDocType', id, phrase });
  }

  const city = geoCityFrom(q);
  if (city) conditions.push({ type: 'geoCity', value: city });

  const sinceMatch = NO_VISIT_SINCE_RE.exec(q) ?? NO_SERVICE_SINCE_RE.exec(q);
  if (sinceMatch) conditions.push({ type: 'noVisitSinceYear', year: Number(sinceMatch[1]) });

  const cbDays = CALLBACK_DAYS_RE.exec(q);
  const cbYear = CALLBACK_SINCE_RE.exec(q);
  if (cbDays) conditions.push({ type: 'callback', days: Number(cbDays[1]), scope: 'anytime' });
  else if (CALLBACK_THIS_YEAR_RE.test(q)) conditions.push({ type: 'callback', days: null, scope: 'thisYear' });
  else if (cbYear) conditions.push({ type: 'callback', days: null, scope: 'sinceYear', year: Number(cbYear[1]) });

  // R14 (K4): NO_EMAIL_RE checked first — it already claims every negated phrasing ("no email", "missing
  // an email") — so HAS_EMAIL_RE only ever fires on the positive phrasing a follow-up narrowing uses
  // ("...have email on file?"), never double-counted against the same clause.
  if (NO_EMAIL_RE.test(q)) conditions.push({ type: 'noEmail' });
  else if (HAS_EMAIL_RE.test(q)) conditions.push({ type: 'hasEmail' });

  if (NO_PHONE_RE.test(q)) conditions.push({ type: 'noPhone' });

  const unitCount = UNIT_COUNT_RE.exec(q);
  if (unitCount) conditions.push({ type: 'unitCountGt', n: /^\d+$/.test(unitCount[1]) ? Number(unitCount[1]) : 1 });

  const brandSpread = BRAND_SPREAD_RE.exec(q);
  if (brandSpread) conditions.push({ type: 'distinctBrandsGte', n: /^\d+$/.test(brandSpread[1]) ? Number(brandSpread[1]) : (NUM_WORDS[brandSpread[1].toLowerCase()] ?? 2) });

  const tech = TECHNICIAN_RE.exec(q);
  if (tech) conditions.push({ type: 'technician', name: tech[1] });

  return conditions;
}

/**
 * Pure: question + tenant pack -> {mode:'filter', conditions: Condition[]} or null. Requires at least
 * TWO recognized clauses (a single-condition question belongs to compose.js/analytics.js, which already
 * answer it well) UNLESS one of them is decompose's own callback/noVisitSinceYear clause standing next to
 * at least one other recognized clause — a bare "which customers had a callback this year" with no other
 * condition at all is not this engine's job either (no entity filter to intersect against).
 */
export function parseFilterClauses(question, pack) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  const conditions = collectConditions(q, pack);
  if (conditions.length < 2) return null;
  const op = /^\s*how many\b/i.test(q) ? 'count' : 'list';

  // R11 (breadth-connect-056/057/058/059, golden tenant): this engine only ever counts CUSTOMERS, never
  // units — a "how many units..." question is a per-UNIT count, and a customer who owns two-or-more
  // units that independently satisfy a hasDocType/lacksDocType condition (e.g. one has a warranty
  // registration on file, the other doesn't) is counted ONCE here but as two separate units by the
  // oracle, since docTypesByCust (compose.js's fetchUniverse) aggregates every linked document across a
  // customer's WHOLE equipment family, not per-unit. That collision is only ruled out when a `brand`
  // condition already narrows the question to (in practice) at most one qualifying unit per customer;
  // a bare "units in <City>..." with no brand has no such narrowing, so this returns null (fall through)
  // rather than risk the same undercount — an honest non-claim, never a wrong count.
  const brands = conditions.find((c) => c.type === 'brand');
  if (op === 'count' && /\bunits?\b/i.test(q) && !/\bcustomers?\b/i.test(q) && !brands
    && conditions.some((c) => c.type === 'hasDocType' || c.type === 'lacksDocType')) {
    return null;
  }
  return { mode: 'filter', op, conditions };
}

// "<premise clause> -- <narrowing clause>": a compact, self-contained conversational follow-up ("Expired
// warranties -- what about just the Mesa ones?", "Mesa customers -- and how many of those have email on
// file?") — every observed instance of this shape (R14 golden tenant) asks for a COUNT of the narrowed
// set, whether or not it happens to literally say "how many", so this is the one place op is fixed rather
// than sniffed from the text. Each half is parsed with the exact same collectConditions detectors as a
// single, ordinary filter question — never a special-cased regex against the WHOLE sentence, so a
// paraphrase or typo'd variant of either half (already run through this file's own typo-tolerant
// candidates — see relations/normalize.js) is caught the same way a one-shot two-condition question is.
const FOLLOWUP_SPLIT_RE = /\s+--\s+/;

/** Pure: question + tenant pack -> {mode:'filter', op:'count', conditions} or null. */
export function parseFollowupNarrowing(question, pack) {
  const q = String(question ?? '').trim();
  if (!FOLLOWUP_SPLIT_RE.test(q)) return null;
  const [first, ...rest] = q.split(FOLLOWUP_SPLIT_RE);
  const second = rest.join(' -- ').trim();
  if (!first || !second) return null;
  const seen = new Set();
  const conditions = [];
  for (const cond of [...collectConditions(first, pack), ...collectConditions(second, pack)]) {
    if (seen.has(cond.type)) continue; // the SAME clause type named twice ("Mesa" in both halves) counts once
    seen.add(cond.type);
    conditions.push(cond);
  }
  if (conditions.length < 2) return null;
  return { mode: 'filter', op: 'count', conditions };
}

/** Pure entry point: comparison shape tried first (structurally distinct from a conjunctive filter list),
 *  then a follow-up narrowing ("X -- what about just the Y ones?"), then the ordinary conjunctive-clause
 *  parse. Returns null the moment none of the three recognizes the question — decompose/index.js falls
 *  through to the normal chain exactly like every other deterministic router here. */
export function parseDecompose(question, pack) {
  return parseComparison(question) ?? parseFollowupNarrowing(question, pack) ?? parseFilterClauses(question, pack);
}

export { docTypePhrases };
