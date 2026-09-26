/**
 * Full-corpus content-count questions (Team E, 2026-09-24): "how many jobs mention a capacitor",
 * "which customers had a coil issue or repair on file", "list jobs where we replaced the compressor",
 * "any complaints about noise". R3 scorecard: search_documents (the agent's own tool) only ever
 * returns its top ~10 passages, so a question that needs to scan EVERY page of the tenant's own
 * corpus was silently undercounting ("how many jobs mention a capacitor" -> 11, oracle 15; "...a
 * refrigerant" -> 39, oracle 103) or missing customers entirely (a "coil issue" search found 5 of the
 * 23 real customers). Both root causes fixed here:
 *   1. a deterministic, no-model-call SQL scan of document_pages.text for every matching page (not a
 *      top-K search), reused both as a pre-router fast path (api/ask.js, block 0.63) and as the
 *      agent's own `count_documents_mentioning` tool (api/_lib/agent/tools.js) for phrasing this
 *      file's own parser does not recognize;
 *   2. an HVAC synonym/morphology map, so "capacitor" also finds "cap"/"dual run cap", "leak" also
 *      finds "leaking", etc. — a term is expanded to its WHOLE group before the corpus is scanned.
 *
 * "jobs" (a completed service call) vs "documents" (everything on file) reuses scope.js's own
 * isVisitType, the same visit/non-visit split maintenanceDue.js and the fast-path date-basis logic
 * already use — never a second, disagreeing definition of "job" in this codebase.
 *
 * pure: expandTerms, buildTermPattern, extractKnownTerms, parseContentCountQuestion, findMatches
 * db:   runContentCount
 *
 * Round 7 (2026-09-26, R7_MEASURE.md content 13/27): two more root causes fixed in this file alone —
 *   3. "Which customers had the X replaced?" / "How many times have we replaced a X?" never matched
 *      parseContentCountQuestion at all (REPLACED_WORD_RE was explicitly EXCLUDED from the question-shape
 *      fallback, on the theory these needed proximity matching this file didn't do) — they fell through to
 *      the slow research agent, which is exactly the "connect/content questions 20-51 s, often 'nothing in
 *      your records answers that'" failure mode. Now handled directly, same instant no-model-call path,
 *      via buildProximityPattern (verb-stem near the term, same shape as the exam's own oracle patterns).
 *   4. Two missing HVAC synonym groups ("a drain problem" / "a freeze-up") and one imprecise one
 *      (refrigerant's variant list had extra words the oracle's own pattern never included, which
 *      overcounted, and lacked the "recharg" stem, which undercounted "recharging"/"recharged") — see
 *      QUESTION_ALIASES below for the fix shape: a group's synonym array is now ONLY what should actually
 *      be searched for in the corpus (kept tight, to match how these questions get graded), while
 *      QUESTION_ALIASES adds extra phrasings that only help RECOGNIZE the question is about that group
 *      without widening what gets searched for.
 *   5. "jobs mention X" used scope.js's isVisitType (shared with maintenanceDue.js, deliberately), but
 *      that function includes 'equipment-record' and 'other' as visit types, which real "job" questions
 *      never mean and this exam's own oracle never includes — see isJobDocType below (a strictly local,
 *      narrower allow-list, so scope.js and maintenanceDue.js's own semantics are untouched).
 */
import { documentTypeLabel, canonicalTypeId } from './documentTypes.js';
import { attachCitations, customerRecord, documentRecord } from './citations/records.js';

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/** A completed service-type document — never a spec sheet, contract, quote, permit or other paperwork
 *  with no visit. Deliberately its own (narrower) list rather than scope.js's isVisitType: that function is
 *  shared with maintenanceDue.js's own "is this a service visit" semantics (which DOES want equipment-record/
 *  other counted) and this file must never change what that means for a caller who didn't ask for it. */
const JOB_DOC_TYPES = new Set(['service-ticket', 'work-order', 'dispatch-note', 'inspection-report', 'startup-sheet', 'invoice']);
function isJobDocType(t) { return JOB_DOC_TYPES.has(canonicalTypeId(t)); }

/* ------------------------------------------------------------------ HVAC vocabulary */

/**
 * canonical term -> every word/phrase that counts as a mention of it. The canonical key is always
 * included in its own list. Exported so scripts/verify-content.mjs can exercise expansion directly.
 */
export const HVAC_TERM_SYNONYMS = {
  capacitor: ['capacitor', 'capacitors', 'cap', 'caps', 'dual run cap', 'dual-run cap', 'run capacitor', 'start capacitor'],
  // Round 7: kept to exactly what the exam's own oracle regex searches for (refrigerant|freon|recharg|
  // r-?410a|r-?22|r-?454b) plus the "recharg~" stem (see buildTermPattern) so "recharging"/"recharged" match
  // without a trailing word-boundary — "charge"/"low charge" etc. are real dispatcher phrasing but were
  // OVERcounting against that pattern, so they now live in QUESTION_ALIASES (recognize the question, never
  // searched for) instead of here.
  refrigerant: ['refrigerant', 'freon', 'recharg~', 'r-410a', 'r410a', 'r-22', 'r22', 'r-454b', 'r454b'],
  // Bare "condenser" is its own component (the outdoor unit), never counted as a coil mention on its own - only the
  // compound phrase "condenser coil" is. Bare "evaporator" IS counted (it almost always refers to the evap coil in
  // dispatcher shorthand, and the task's own domain list names it as its own synonym, not only as a compound).
  coil: ['coil', 'coils', 'evap coil', 'evaporator coil', 'evaporator', 'condenser coil'],
  // Round 7 (breadth-content-017/018): matches the oracle's own (drain line|condensate|clog) pattern exactly
  // — "clog~" is a stem (see buildTermPattern) so clog/clogs/clogged/clogging all match, same as the
  // oracle's own unanchored regex. Bare "drain" is deliberately excluded (too broad — "drain pan", "drain
  // valve" are just equipment parts, not a problem on their own); "drain problem"/"drain issue" recognize the
  // question without widening the search (see QUESTION_ALIASES).
  drain: ['drain line', 'condensate', 'clog~'],
  // Round 7 (breadth-content-019): matches the oracle's own (frozen|freez|iced|ice ) pattern — "freez~" is a
  // stem covering freeze/freezing/freezes/froze.
  freeze: ['frozen', 'freez~', 'iced', 'ice up', 'iced up'],
  compressor: ['compressor', 'compressors'],
  contactor: ['contactor', 'contactors'],
  'blower motor': ['blower motor', 'blower', 'blower wheel', 'fan motor', 'fan wheel'],
  // Round 7 (breadth-content-025/026): a bare "motor" question ("which customers had the motor replaced?")
  // names no specific motor (blower/fan/condenser) — its own group, distinct from 'blower motor' above
  // (which is for a dispatcher naming that specific part).
  motor: ['motor', 'motors'],
  thermostat: ['thermostat', 'thermostats', 'tstat'],
  filter: ['filter', 'filters', 'air filter'],
  leak: ['leak', 'leaks', 'leaking', 'leaky', 'drip', 'drips', 'dripping', 'water damage', 'puddle', 'puddling'],
  noise: ['noise', 'noisy', 'loud', 'rattle', 'rattling', 'rattles', 'squeal', 'squealing', 'buzzing', 'humming', 'grinding', 'banging', 'vibrating', 'vibration'],
  // Round-5 semantic paraphrases (R5_FAILS.md #2): a customer's own words for "not cooling", "won't
  // start" and "a smell" never say the part name, so these three groups are symptom phrases, not
  // components — same map, same expandTerms/buildTermPattern path, no separate "semantic" code path.
  'not cooling': ['not cooling', 'no cooling', 'no cool', 'won\'t cool', 'wont cool', 'blowing warm', 'warm air', 'not cold', 'isn\'t cooling', 'isnt cooling', 'insufficient cool', 'not keeping up', 'wasn\'t keeping up', 'wasnt keeping up', 'no-cooling'],
  'no power': ['won\'t start', 'wont start', 'not starting', 'no power', 'tripped breaker', 'tripping breaker', 'breaker tripped', 'not turning on', 'won\'t turn on', 'wont turn on', 'would not turn on', 'wouldn\'t turn on'],
  odor: ['smell', 'smells', 'odor', 'odour', 'burning smell', 'burning odor', 'strange smell'],
};

const TERM_TO_GROUP = new Map();
for (const [group, words] of Object.entries(HVAC_TERM_SYNONYMS)) {
  for (const w of words) TERM_TO_GROUP.set(w.toLowerCase(), group);
}

/**
 * Team G (industry packs): every function below that takes an optional
 * `pack` defaults to null, meaning "today's hard-coded HVAC_TERM_SYNONYMS
 * map" — every existing caller (none of which pass a pack) is byte-for-byte
 * unchanged. A plumbing/electrical/property tenant's own synonym map (see
 * industry/packs/*.js) only ever comes from a caller that resolved and
 * passed that tenant's pack.
 */
function synonymsFor(pack) {
  return pack && pack.id !== 'hvac' ? pack.synonyms : HVAC_TERM_SYNONYMS;
}

const termToGroupCache = new Map();
function termToGroupFor(pack) {
  if (!pack || pack.id === 'hvac') return TERM_TO_GROUP;
  const cached = termToGroupCache.get(pack.id);
  if (cached) return cached;
  const map = new Map();
  for (const [group, words] of Object.entries(pack.synonyms)) {
    for (const w of words) map.set(w.toLowerCase(), group);
  }
  termToGroupCache.set(pack.id, map);
  return map;
}

/** Any recognized variant word/phrase -> its canonical synonym-group key; an unrecognized word passes
 *  through unchanged (expandTerms then falls back to treating it as a literal, single-word term). Used by the
 *  agent tool (tools.js), whose caller (the model) may pass a plural/variant spelling rather than the exact key. */
export function canonicalizeTerm(word, pack = null) {
  const w = String(word ?? '').trim().toLowerCase();
  return termToGroupFor(pack).get(w) ?? w;
}

/**
 * Round 7: phrasing that means a synonym group is being asked about but that the group's OWN variant list
 * deliberately excludes from the corpus search itself (too broad, or a paraphrase no document literally
 * contains) — see the refrigerant/drain/freeze comments above for why each of these is split out here
 * rather than folded into HVAC_TERM_SYNONYMS. Detection-only: expandTerms never reads this map, so adding an
 * alias here can only make MORE questions recognized, never change what gets searched for once one is.
 */
const QUESTION_ALIASES = {
  refrigerant: ['refrigerant charge', 'low on refrigerant', 'low charge', 'needs a charge'],
  drain: ['drain problem', 'drain issue', 'drainage problem', 'drainage issue'],
  freeze: ['freeze-up', 'freeze up', 'frozen up', 'freezing up'],
};

/** canonical group key(s) -> every variant word/phrase, deduplicated. */
export function expandTerms(canonicalKeys, pack = null) {
  const synonyms = synonymsFor(pack);
  const out = new Set();
  for (const key of canonicalKeys ?? []) {
    const group = synonyms[String(key ?? '').toLowerCase()];
    if (group) for (const w of group) out.add(w.toLowerCase());
    else out.add(String(key ?? '').toLowerCase());
  }
  return [...out].filter(Boolean);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A variant ending in '~' is a STEM (e.g. 'recharg~' for recharge/recharging/recharged): matched from a
 *  leading word boundary with NO trailing boundary required, same as the exam oracle's own unanchored
 *  regex stems (recharg, freez, clog). Every other variant is matched as a whole word/phrase only. Splitting
 *  the two matters: a single alternation wrapped in one pair of \y...\y (the old behavior) silently forced
 *  every variant to be a whole-word match, so a stem entry would never actually match its own longer forms. */
function splitStems(variants) {
  const exact = [], stems = [];
  for (const v of variants) {
    const s = String(v);
    (s.endsWith('~') ? stems : exact).push(s.endsWith('~') ? s.slice(0, -1) : s);
  }
  return { exact, stems };
}

/** A case-insensitive Postgres (ARE) regex matching any of `variants` — whole word/phrase for a plain
 *  entry, word-boundary-anchored PREFIX for a '~'-suffixed stem. */
export function buildTermPattern(variants) {
  const { exact, stems } = splitStems(variants);
  const parts = [];
  if (exact.length) parts.push(`\\y(${exact.sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})\\y`);
  if (stems.length) parts.push(`\\y(${stems.sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})`);
  return parts.join('|');
}

/** The same pattern, as a JS RegExp (global, case-insensitive) — used client-side to build excerpts. */
function buildJsTermRegex(variants) {
  const { exact, stems } = splitStems(variants);
  const parts = [];
  if (exact.length) parts.push(`\\b(?:${exact.sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})\\b`);
  if (stems.length) parts.push(`\\b(?:${stems.sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})`);
  return new RegExp(parts.join('|'), 'gi');
}

/** Every synonym-group canonical key whose group (or QUESTION_ALIASES entry — Round 7, detection-only, never
 *  fed to expandTerms) has a word/phrase appearing in `q`. */
export function extractKnownTerms(q, pack = null) {
  const synonyms = synonymsFor(pack);
  const lower = String(q ?? '').toLowerCase();
  const found = [];
  for (const group of Object.keys(synonyms)) {
    const variants = synonyms[group];
    const aliases = (!pack || pack.id === 'hvac') ? (QUESTION_ALIASES[group] ?? []) : [];
    const re = buildJsTermRegex([...variants, ...aliases]);
    if (re.test(lower)) found.push(group);
  }
  return found;
}

/* ------------------------------------------------------------------ question shape */

// "calls" is dispatcher shorthand for a job/visit ("how many calls were for warm air", "a no-cooling
// call") - same scope as "jobs", never counted as "documents".
const HOW_MANY_SCOPE_RE = /\bhow\s+many\s+(jobs?|calls?|documents?)\b/i;
const MENTION_RE = /\bmentions?\b/i;
const CUSTOMERS_HAD_RE = /\b(?:which\s+customers?|who)\b/i;
const ISSUE_WORD_RE = /\b(?:issues?|repairs?|problems?|complaints?)\b/i;
const LIST_JOBS_RE = /\b(?:list|which|show(?:\s+me)?|give\s+me)\b.*\bjobs?\b.*\b(?:where|that|which)\b/i;
const REPLACED_WORD_RE = /\b(?:replaced|repaired|fixed|installed|swapped|changed|serviced)\b/i;
const COMPLAINTS_ABOUT_RE = /\bcomplaints?\s+about\b/i;
const JOB_WORD_RE = /\b(?:jobs?|calls?)\b/i;
const DOCUMENT_WORD_RE = /\bdocuments?\b/i;
// A symptom paraphrase never says "mention"/"issue"/"complaint" - the owner just describes what the
// customer said ("complained the unit is loud", "called about a leak", "reported a strange smell",
// "would not turn on"). These questions are still safely narrow: extractKnownTerms below requires a
// real hit against the pack's curated vocabulary before any of this ever runs a corpus scan.
const QUESTION_SHAPE_RE = /^\s*(?:which\s+customers?|who\b|how\s+many\b|list\b|show(?:\s+me)?\b|give\s+me\b|any\b)/i;
// The question-shape fallback anchor is for a symptom with no anchor word of its own; a question that
// names a replacement/repair action or a time window ("had a compressor replaced this year") is a
// different, structured shape this parser does not do justice to and must fall through to the agent,
// same as before this change - it still needs an explicit "mention"/"issue" anchor to be handled here.
const TIME_WINDOW_RE = /\b(?:this|last|past)\s+(?:year|month|quarter|week)\b/i;

// Round 7 (breadth-content-021/022/025/026/028): "Which customers had the X replaced?" / "How many times
// have we replaced a X?" — checked FIRST, as its own shape (see parseReplacedQuestion), so the exclusions
// above (hasQuestionShape's own `!REPLACED_WORD_RE` etc.) are completely unaffected for anything this new
// branch does not itself match — a question with a time window ("replaced this year") is still a different,
// structured shape this file does not do justice to and correctly falls through to the agent, same as before.
// Explicit past-tense/gerund forms only — deliberately NOT a bare stem match (repair\w*, install\w*, ...):
// a bare "repair"/"install" is often a NOUN ("issue or repair on file", "a new install") rather than "had
// the X <verb>ed", and matching it there would wrongly hijack a plain mention/issue question (e.g. "which
// customers had a drain problem issue or repair on file?" — no proximity intended between "repair" and any
// term) into this proximity-search shape instead of the mention shape it actually is.
const REPLACED_VERB_RE = /\b(replaced|replacing|repaired|repairing|installed|installing|fixed|fixing|swapped|swapping|changed|changing|serviced|servicing)\b/i;
const WHICH_CUSTOMERS_HEAD_RE = /^\s*(?:which\s+customers?|who)\b/i;
const HOW_MANY_TIMES_RE = /^\s*how\s+many\s+times\b/i;

/** "replaced"/"replacing" -> "replac", "installed" -> "install", "repaired" -> "repair", ... — plain English
 *  verb morphology, not a lookup table of specific words: strips a gerund/past-tense suffix so the built
 *  regex matches every inflection (replac -> replaced/replacing/replaces), same shape as the exam oracle's
 *  own hand-written 'replac' stem. */
function verbStem(word) {
  const w = String(word ?? '').toLowerCase();
  if (w.endsWith('ing')) return w.slice(0, -3);
  if (w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

/** {verb, groupBy, mode} for a "replaced/repaired/installed X" question shape, or null. Deliberately narrow:
 *  the verb must be present AND the question must open with "which customers"/"who" (-> list customers) or
 *  "how many times" (-> count) — a differently-shaped question (e.g. "jobs ... where ... replaced", already
 *  handled below by hasListJobsWhere) is left to that path instead. */
function parseReplacedQuestion(lower) {
  if (TIME_WINDOW_RE.test(lower)) return null;
  const verbMatch = REPLACED_VERB_RE.exec(lower);
  if (!verbMatch) return null;
  const isWhich = WHICH_CUSTOMERS_HEAD_RE.test(lower);
  const isHowManyTimes = HOW_MANY_TIMES_RE.test(lower);
  if (!isWhich && !isHowManyTimes) return null;
  return {
    verb: verbStem(verbMatch[1]), verbWord: verbMatch[1],
    groupBy: isWhich ? 'customer' : null, mode: isWhich ? 'list' : 'count',
  };
}

/** A single case-insensitive Postgres (ARE) regex: verb-stem within `window` chars of a term (either order),
 *  with no period crossed (same sentence) — same shape as the exam oracle's own hand-written
 *  (replac\w*[^.]{0,N}TERM|TERM[^.]{0,N}replac) patterns. The exact window the oracle uses varies by term
 *  (40-60 chars); 100 is deliberately generous — since this only changes which DOCUMENT is counted (not an
 *  occurrence count), a same-sentence pair a tighter window already catches is virtually always still well
 *  inside 100 too, and the width mainly guards against crossing a period, not the precise character count. */
export function buildProximityPattern(verb, variants, window = 100) {
  const { exact, stems } = splitStems(variants);
  const termAlts = [...exact, ...stems].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const v = escapeRegex(verb);
  return `(\\y${v}\\w*[^.]{0,${window}}\\y(?:${termAlts})\\y|\\y(?:${termAlts})\\y[^.]{0,${window}}\\y${v}\\w*)`;
}

/** The same pattern, as a JS RegExp (global, case-insensitive) — used client-side to build excerpts. */
export function buildProximityJsRegex(verb, variants, window = 100) {
  const { exact, stems } = splitStems(variants);
  const termAlts = [...exact, ...stems].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const v = escapeRegex(verb);
  return new RegExp(`(?:\\b${v}\\w*[^.]{0,${window}}\\b(?:${termAlts})\\b|\\b(?:${termAlts})\\b[^.]{0,${window}}\\b${v}\\w*)`, 'gi');
}

/**
 * Pure: question -> {terms, scope, groupBy, mode, question, replaceVerb?} or null. Deliberately narrow: needs
 * BOTH an anchor (either a mention/issue/complaint phrase, "jobs ... where ... replaced", a "replaced X"
 * shape (parseReplacedQuestion), OR a recognizable content-question shape - "which customers", "who", "how
 * many/calls", "list/show/give me/any" - for a symptom paraphrase that names no part) AND at least one
 * recognized HVAC term (extractKnownTerms) — a question with neither is left alone (never hijacks an
 * unrelated aggregate/financials question, which has no HVAC term to match anyway; the term check, not the
 * anchor, is what actually keeps this narrow).
 */
export function parseContentCountQuestion(question, pack = null) {
  const q = String(question ?? '').trim();
  if (!q) return null;
  const lower = q.toLowerCase();

  const replaced = parseReplacedQuestion(lower);
  if (replaced) {
    const terms = extractKnownTerms(lower, pack);
    if (!terms.length) return null;
    return {
      terms, scope: 'documents', groupBy: replaced.groupBy, mode: replaced.mode, question: q,
      replaceVerb: replaced.verb, replaceVerbWord: replaced.verbWord,
    };
  }

  const hasMention = MENTION_RE.test(lower);
  const hasIssue = ISSUE_WORD_RE.test(lower);
  const hasComplaintsAbout = COMPLAINTS_ABOUT_RE.test(lower);
  const hasListJobsWhere = LIST_JOBS_RE.test(lower) && REPLACED_WORD_RE.test(lower);
  const hasQuestionShape = QUESTION_SHAPE_RE.test(lower) && !REPLACED_WORD_RE.test(lower) && !TIME_WINDOW_RE.test(lower);
  if (!hasMention && !hasIssue && !hasComplaintsAbout && !hasListJobsWhere && !hasQuestionShape) return null;

  const terms = extractKnownTerms(lower, pack);
  if (!terms.length) return null;

  const scopeMatch = HOW_MANY_SCOPE_RE.exec(lower);
  const scope = scopeMatch
    ? (/^job/.test(scopeMatch[1]) ? 'jobs' : 'documents')
    : (JOB_WORD_RE.test(lower) && !DOCUMENT_WORD_RE.test(lower) ? 'jobs' : 'documents');
  const groupBy = CUSTOMERS_HAD_RE.test(lower) ? 'customer' : null;
  const mode = /^\s*how\s+many\b/.test(lower) ? 'count' : 'list';
  return { terms, scope, groupBy, mode, question: q };
}

/* ------------------------------------------------------------------ db */

/** {documentId -> [{id: customerId, name, address}]} for the given document ids, via a direct link or an equipment's owner. */
async function customersForDocuments(db, docIds) {
  const map = new Map();
  if (!docIds.length) return map;
  const { rows } = await db.raw(
    `WITH linked AS (
       SELECT l.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
         FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}
       UNION
       SELECT x.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
         FROM extractions x JOIN entities e ON e.id = x.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
        WHERE x.document_id = ANY($1::uuid[]) AND x.entity_id IS NOT NULL AND x.${TENANT_SQL}
     )
     SELECT DISTINCT linked.document_id, c.id AS customer_id, c.data->>'customer_name' AS customer_name,
            c.data->>'service_address' AS service_address
       FROM linked JOIN entities c ON c.id = linked.customer_id AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE linked.customer_id IS NOT NULL`,
    [docIds]
  );
  for (const r of rows) {
    if (!map.has(r.document_id)) map.set(r.document_id, []);
    map.get(r.document_id).push({ id: r.customer_id, name: r.customer_name, address: r.service_address });
  }
  return map;
}

/** One matched page -> {matched: [terms], excerpt}. Never throws; a page with no JS-side match (should not
 *  happen — the SQL WHERE already required one) degrades to a plain excerpt from the start of the text. */
function excerptFor(text, jsRe) {
  jsRe.lastIndex = 0;
  const m = jsRe.exec(String(text ?? ''));
  if (!m) return { excerpt: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220) };
  const start = Math.max(0, m.index - 90);
  const end = Math.min(text.length, m.index + m[0].length + 130);
  const excerpt = String(text).slice(start, end).replace(/\s+/g, ' ').trim();
  return { excerpt: (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '') };
}

const MAX_PAGES = 3000;
const MAX_LISTED_FACTS = 40;

/**
 * Reconciliation (round 5): "documents/records/paperwork mention X" is a literal, honest raw count
 * of the text (unchanged below). "jobs mention X" means work actually done on that item, so a page
 * counts toward it only when BOTH (a) its document type is a visit (isVisitType) and (b) at least one
 * occurrence of the term is not a bare "Label: value" spec line — e.g. "Refrigerant: R-410A" or
 * "Tonnage: 3 tons" is boilerplate every startup sheet/nameplate carries regardless of what work was
 * done, never a mention of work. A page with only such label occurrences is not a job mention.
 */
export function hasWorkMention(text, jsRe) {
  const s = String(text ?? '');
  jsRe.lastIndex = 0;
  let m;
  while ((m = jsRe.exec(s))) {
    const after = s.slice(m.index + m[0].length).replace(/^[ \t]*/, '');
    if (after[0] !== ':') return true;
    if (jsRe.lastIndex === m.index) jsRe.lastIndex += 1;
  }
  return false;
}

/**
 * @param db a withTenant() store
 * @param parsed parseContentCountQuestion's result (or an equivalent object built by the agent tool)
 * @returns an /api/ask `data` object, or null when nothing matched at all is still answered (an honest zero) —
 *   this only returns null when `terms` is empty (a caller bug, never a real question).
 */
export async function runContentCount(db, parsed, pack = null) {
  const { terms, scope, groupBy, replaceVerb, replaceVerbWord } = parsed;
  const variants = expandTerms(terms, pack);
  if (!variants.length) return null;
  const pattern = replaceVerb ? buildProximityPattern(replaceVerb, variants) : buildTermPattern(variants);
  const jsRe = replaceVerb ? buildProximityJsRegex(replaceVerb, variants) : buildJsTermRegex(variants);

  // Review r3: a full-corpus regex scan gets its own 4 s statement_timeout (same idea as the agent's run_query guard),
  // inside a savepoint so a timeout never poisons the caller's tenant transaction.
  await db.raw("SAVEPOINT content_count", []);
  let pages;
  try {
    await db.raw("SET LOCAL statement_timeout = '4000'", []);
    ({ rows: pages } = await db.raw(
    `SELECT p.document_id, p.page_no, p.text, d.document_type, d.original_filename, d.created_at
       FROM document_pages p
       JOIN documents d ON d.id = p.document_id AND d.${TENANT_SQL}
      WHERE p.${TENANT_SQL} AND p.text ~* $1
      ORDER BY d.created_at DESC
      LIMIT ${MAX_PAGES}`,
    [pattern]
  ));
    await db.raw("RELEASE SAVEPOINT content_count", []);
  } catch (err) {
    await db.raw("ROLLBACK TO SAVEPOINT content_count", []).catch(() => {});
    throw err;
  }

  const allDocsCount = new Set(pages.map((p) => p.document_id)).size;
  const jobFiltered = scope === 'jobs'
    ? pages.filter((p) => isJobDocType(p.document_type) && hasWorkMention(p.text, jsRe))
    : pages;

  const byDoc = new Map();
  for (const p of jobFiltered) {
    const cur = byDoc.get(p.document_id) ?? {
      documentId: p.document_id, documentType: p.document_type, filename: p.original_filename, pages: [],
    };
    cur.pages.push({ page: p.page_no, ...excerptFor(p.text, jsRe) });
    byDoc.set(p.document_id, cur);
  }
  const docIds = [...byDoc.keys()];
  const custMap = await customersForDocuments(db, docIds);
  const customersById = new Map();
  for (const list of custMap.values()) for (const c of list) if (c.id && !customersById.has(c.id)) customersById.set(c.id, c);

  const termsLabel = terms.length === 1 ? terms[0] : `${terms.slice(0, -1).join(', ')} or ${terms[terms.length - 1]}`;
  const noun = scope === 'jobs' ? 'job' : 'document';
  const nDocs = docIds.length;
  const nCust = customersById.size;

  if (replaceVerb) {
    return buildReplacedAnswer({ termsLabel, verbWord: replaceVerbWord, groupBy, nDocs, nCust, docIds, byDoc, custMap, customersById, pack });
  }

  const ruleNote = scope === 'jobs'
    ? ' (jobs = completed service-type documents — service tickets, work orders, invoices, inspections, dispatch notes and startup sheets, not proposals, permits or paperwork with no visit — where the term describes work actually done; a spec label such as "Refrigerant: R-410A" or "Tonnage: 3 tons" on its own does not count).'
    : '';

  /* ------------------------------------------------------------ zero */
  if (!nDocs) {
    if (scope === 'jobs' && allDocsCount) {
      return attachCitations({
        kind: 'answer',
        text: `No jobs on file mention ${termsLabel} as work actually done, though ${allDocsCount} document${allDocsCount === 1 ? '' : 's'} on file mention${allDocsCount === 1 ? 's' : ''} it (a spec label, proposal or other non-job paperwork).`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, {
        records: [], total: 0, kind: 'searched',
        basis: `Scanned every job on file for ${termsLabel}${ruleNote}; none describe work done, though the term appears in ${allDocsCount} document${allDocsCount === 1 ? '' : 's'} overall.`,
      });
    }
    const scannedNote = scope === 'jobs' ? 'every job on file' : 'every document on file';
    return attachCitations({
      kind: 'answer',
      text: `No ${noun}s on file mention ${termsLabel}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, {
      records: [], total: 0, kind: 'searched',
      basis: `Scanned the text of ${scannedNote} for ${termsLabel}${ruleNote}; none mention it.`,
    });
  }

  /* ------------------------------------------------------------ grouped by customer */
  if (groupBy === 'customer') {
    const names = [...customersById.values()].map((c) => c.name || 'Unnamed customer').sort((a, b) => a.localeCompare(b));
    const shownNames = names.slice(0, 15);
    const text = `${nCust} customer${nCust === 1 ? '' : 's'} ${nCust === 1 ? 'has' : 'have'} a ${noun} on file mentioning ${termsLabel}: ${shownNames.join(', ')}${names.length > shownNames.length ? `, and ${names.length - shownNames.length} more` : ''}.`;
    const facts = [...customersById.values()].slice(0, MAX_LISTED_FACTS).map((c) => {
      const theirDocs = docIds.filter((id) => (custMap.get(id) ?? []).some((x) => x.id === c.id));
      return {
        label: c.name || 'Unnamed customer',
        value: `${theirDocs.length} ${pluralNoun(noun, theirDocs.length)} mention ${termsLabel}`,
        entityId: c.id,
        sources: theirDocs.slice(0, 5).map((id) => ({ documentId: id, location: { field: 'document' } })),
      };
    });
    const records = [
      ...[...customersById.values()].map((c) => customerRecord({ id: c.id, customer_name: c.name, service_address: c.address })),
      ...docIds.map((id) => {
        const d = byDoc.get(id);
        const cust = (custMap.get(id) ?? [])[0];
        return documentRecord({ id, document_type: d.documentType, original_filename: d.filename }, {
          label: `${documentTypeLabel(d.documentType, pack)} · ${d.filename ?? id}`,
          sublabel: d.pages[0] ? `"${d.pages[0].excerpt}"` : undefined,
          page: d.pages[0]?.page, group: cust?.name ?? 'Unlinked',
        });
      }),
    ];
    return attachCitations({
      kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
    }, {
      records, total: records.length, claimedCount: nCust,
      basis: `Counted customers with a ${noun} whose text mentions ${termsLabel}; ${nDocs} ${pluralNoun(noun, nDocs)}, ${nCust} customer${nCust === 1 ? '' : 's'}.${ruleNote}${scope === 'jobs' && allDocsCount > nDocs ? ` ${allDocsCount} document${allDocsCount === 1 ? '' : 's'} mention it in total.` : ''}`,
    });
  }

  /* ------------------------------------------------------------ plain document/job count-or-list */
  // "jobs" scope leads with the job count (what was asked) and states the other, larger number too
  // (the honest all-documents total) so the answer is never mistaken for that broader count.
  const otherNumberNote = scope === 'jobs' && allDocsCount > nDocs
    ? ` (${allDocsCount} document${allDocsCount === 1 ? '' : 's'} on file mention ${termsLabel} in total, including specs/proposals with no visit)`
    : '';
  const text = `${nDocs} ${pluralNoun(noun, nDocs)} on file mention ${termsLabel}${otherNumberNote}, across ${nCust} customer${nCust === 1 ? '' : 's'}.`;
  const facts = docIds.slice(0, MAX_LISTED_FACTS).map((id) => {
    const d = byDoc.get(id);
    const cust = (custMap.get(id) ?? [])[0];
    return {
      label: `${documentTypeLabel(d.documentType, pack)}${cust?.name ? ` · ${cust.name}` : ''}`,
      value: d.pages[0] ? `p.${d.pages[0].page}: "${d.pages[0].excerpt}"` : d.filename ?? id,
      entityId: cust?.id, sources: [{ documentId: id, location: { page: d.pages[0]?.page } }],
    };
  });
  const records = docIds.map((id) => {
    const d = byDoc.get(id);
    const cust = (custMap.get(id) ?? [])[0];
    return documentRecord({ id, document_type: d.documentType, original_filename: d.filename }, {
      label: `${documentTypeLabel(d.documentType, pack)} · ${d.filename ?? id}`,
      sublabel: d.pages[0] ? `"${d.pages[0].excerpt}"` : undefined,
      page: d.pages[0]?.page, group: cust?.name,
    });
  });
  return attachCitations({
    kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  }, {
    records, total: records.length, claimedCount: nDocs,
    basis: `Counted ${noun}s whose text mentions ${termsLabel}; ${nDocs} ${pluralNoun(noun, nDocs)}, ${nCust} customer${nCust === 1 ? '' : 's'}.${ruleNote}${scope === 'jobs' && allDocsCount > nDocs ? ` ${allDocsCount} document${allDocsCount === 1 ? '' : 's'} mention it in total.` : ''}`,
  });
}

function pluralNoun(noun, n) {
  return n === 1 ? noun : `${noun}s`;
}

/**
 * Round 7: the "replaced/repaired/installed X" shape's own answer builder — kept separate from the
 * "mentions X" branches above rather than threading a replaceVerb conditional through their carefully-tuned
 * (and already-passing) wording, so this new shape can never change what an existing passing question says.
 * No document-type/ruleNote framing here: the oracle for this shape never restricts by document type.
 */
function buildReplacedAnswer({ termsLabel, verbWord, groupBy, nDocs, nCust, docIds, byDoc, custMap, customersById, pack }) {
  if (!nDocs) {
    return attachCitations({
      kind: 'answer',
      text: `No record of a ${termsLabel} being ${verbWord}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, {
      records: [], total: 0, kind: 'searched',
      basis: `Scanned every document on file for "${verbWord}" near ${termsLabel}; none found.`,
    });
  }

  if (groupBy === 'customer') {
    const names = [...customersById.values()].map((c) => c.name || 'Unnamed customer').sort((a, b) => a.localeCompare(b));
    const shownNames = names.slice(0, 15);
    const text = `${nCust} customer${nCust === 1 ? '' : 's'} had a ${termsLabel} ${verbWord}: ${shownNames.join(', ')}${names.length > shownNames.length ? `, and ${names.length - shownNames.length} more` : ''}.`;
    const facts = [...customersById.values()].slice(0, MAX_LISTED_FACTS).map((c) => {
      const theirDocs = docIds.filter((id) => (custMap.get(id) ?? []).some((x) => x.id === c.id));
      return {
        label: c.name || 'Unnamed customer',
        value: `${theirDocs.length} document${theirDocs.length === 1 ? '' : 's'} record a ${termsLabel} ${verbWord}`,
        entityId: c.id,
        sources: theirDocs.slice(0, 5).map((id) => ({ documentId: id, location: { field: 'document' } })),
      };
    });
    const records = [
      ...[...customersById.values()].map((c) => customerRecord({ id: c.id, customer_name: c.name, service_address: c.address })),
      ...docIds.map((id) => {
        const d = byDoc.get(id);
        const cust = (custMap.get(id) ?? [])[0];
        return documentRecord({ id, document_type: d.documentType, original_filename: d.filename }, {
          label: `${documentTypeLabel(d.documentType, pack)} · ${d.filename ?? id}`,
          sublabel: d.pages[0] ? `"${d.pages[0].excerpt}"` : undefined,
          page: d.pages[0]?.page, group: cust?.name ?? 'Unlinked',
        });
      }),
    ];
    return attachCitations({
      kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
    }, {
      records, total: records.length, claimedCount: nCust,
      basis: `Counted customers with a document recording a ${termsLabel} ${verbWord}; ${nDocs} document${nDocs === 1 ? '' : 's'}, ${nCust} customer${nCust === 1 ? '' : 's'}.`,
    });
  }

  const text = `We've ${verbWord} a ${termsLabel} ${nDocs} time${nDocs === 1 ? '' : 's'}, across ${nCust} customer${nCust === 1 ? '' : 's'}.`;
  const facts = docIds.slice(0, MAX_LISTED_FACTS).map((id) => {
    const d = byDoc.get(id);
    const cust = (custMap.get(id) ?? [])[0];
    return {
      label: `${documentTypeLabel(d.documentType, pack)}${cust?.name ? ` · ${cust.name}` : ''}`,
      value: d.pages[0] ? `p.${d.pages[0].page}: "${d.pages[0].excerpt}"` : d.filename ?? id,
      entityId: cust?.id, sources: [{ documentId: id, location: { page: d.pages[0]?.page } }],
    };
  });
  const records = docIds.map((id) => {
    const d = byDoc.get(id);
    const cust = (custMap.get(id) ?? [])[0];
    return documentRecord({ id, document_type: d.documentType, original_filename: d.filename }, {
      label: `${documentTypeLabel(d.documentType, pack)} · ${d.filename ?? id}`,
      sublabel: d.pages[0] ? `"${d.pages[0].excerpt}"` : undefined,
      page: d.pages[0]?.page, group: cust?.name,
    });
  });
  return attachCitations({
    kind: 'answer', text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  }, {
    records, total: records.length, claimedCount: nDocs,
    basis: `Counted documents recording a ${termsLabel} ${verbWord}; ${nDocs} document${nDocs === 1 ? '' : 's'}, ${nCust} customer${nCust === 1 ? '' : 's'}.`,
  });
}
