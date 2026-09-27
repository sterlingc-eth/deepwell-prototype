/**
 * Round 14 (K3): a DETERMINISTIC analytics planner. Builds the exact same
 * "raw plan" shape planAnalyticsQuestion's one Haiku tool-use call produces
 * (an `{entity, op, groupBy?, filters?, sortBy?}` object matching
 * ANALYTICS_TOOL's schema) from regex/vocabulary matching alone — no model
 * call, no I/O, no `db`. planAnalyticsQuestion (routes/analytics.js) tries
 * this FIRST and only calls the model when this returns null; whatever this
 * returns is fed through the EXACT SAME post-processing every model plan
 * already gets (resolveServiceVisitsOverride, reconcileTimeRange,
 * resolveAgeFilter, dateBasis, validatePlan) — so this file never
 * duplicates any of that, and a plan this file gets wrong in some small way
 * is still caught by validatePlan/missingConditions exactly like a wrong
 * model plan would be.
 *
 * THE ONE RULE THAT MATTERS (same as analytics.js's own): never guess. A
 * question whose shape this file doesn't recognize with confidence returns
 * null — the caller falls through to the model (or, offline, to
 * needs-model) exactly like a fast-path miss. Getting a plan WRONG here is
 * far worse than falling back, so every detector below is narrow and
 * shape-based (never keyed to a specific exam question's exact wording —
 * every shape here is a general English construction a dispatcher/owner
 * could type in many paraphrases/typos, all of which normalizeQuestion
 * already funnels to the same normalized words this file matches on).
 *
 * Filter-building deliberately reuses analytics.js's OWN, already-tested
 * condition detectors — detectedConditions/buildConditionOverrideFilter,
 * warrantyStatusFromQuestion — the same functions the "the model's plan
 * silently dropped a condition" override path already trusts to turn a
 * matched word into a real filter (see analytics.js's own doc comments on
 * missingConditions/buildConditionOverrideFilter). This file's own job is
 * the other half those functions don't do: deciding entity/op/groupBy/
 * sortBy from the question's shape and picking out the two filter kinds
 * (documentType, technician) that the missing-condition safety net does not
 * cover (CONDITION_PLAN_FIELD, analytics.js, has no entry for either).
 */
import {
  ENTITY_SYNONYMS,
  GROUP_BY_FIELDS,
  detectedConditions,
  buildConditionOverrideFilter,
  warrantyStatusFromQuestion,
  hasAmbiguousWarrantyStatusNegation,
  isExistenceQuestion,
  resolveAnyTimeRange,
  SERVICE_TYPE_PHRASE_RE,
  serviceTypeValueOf,
} from '../analytics.js';
import { docTypeFromWord, docTypeSynonymAlternation } from '../documentTypes.js';

/* ============================================================ small helpers */

function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function altOf(words) {
  return [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
}

function titleCaseWords(s) {
  return String(s ?? '')
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

// Same noun tables preClassifyAnalytics/ANALYTICS_SYSTEM_PROMPT already key
// off (ENTITY_SYNONYMS, analytics.js) — a synonym added there is picked up
// here automatically, never a second hand-copied list.
const CUSTOMER_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.customers)})\\b`, 'i');
const EQUIPMENT_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.equipment)})\\b`, 'i');
const DOCUMENT_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.documents)})\\b`, 'i');
const SERVICE_VISIT_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.serviceVisits)})\\b`, 'i');
const WARRANTY_NOUN_RE = /\bwarrant(?:y|ies)\b/i;
const DOC_TYPE_WORD_RE = new RegExp(`\\b(${docTypeSynonymAlternation()})\\b`, 'i');

const HOW_MANY_RE = /\bhow many\b/i;
const LIST_VERB_RE = /\b(which|list|show me|give me)\b/i;

/** Index of the first match of `re` in `q`, or Infinity when it never matches
 *  — lets entityFromNouns below pick whichever noun the question names
 *  EARLIEST, the same "the head noun is the real subject" heuristic a human
 *  reader uses ("how many CUSTOMERS are running units older than 15 years"
 *  is about customers; "how many DOCUMENTS aren't linked to any customer" is
 *  about documents, even though both sentences also mention the other
 *  noun). */
function firstIndex(re, q) {
  const m = re.exec(q);
  return m ? m.index : Infinity;
}

/**
 * Entity from the question's own nouns — the earliest-matching one wins
 * (see firstIndex's own doc comment). 'warranties' is picked over
 * 'equipment' only when a warrantyStatus condition is present AND no
 * equipment noun matches at all (equipment/warranties are the identical SQL
 * entity — see analytics.js's buildAnalyticsSQL — so this only ever changes
 * the wording, never the count). Defaults to 'customers' when nothing
 * matches at all (same default the ANALYTICS_TOOL schema documents for the
 * model: "If the question names no entity, assume customers").
 */
function entityFromNouns(q) {
  const candidates = [
    { entity: 'customers', idx: firstIndex(CUSTOMER_NOUN_RE, q) },
    { entity: 'documents', idx: firstIndex(DOCUMENT_NOUN_RE, q) },
    { entity: 'equipment', idx: firstIndex(EQUIPMENT_NOUN_RE, q) },
    { entity: 'serviceVisits', idx: firstIndex(SERVICE_VISIT_NOUN_RE, q) },
  ];
  candidates.sort((a, b) => a.idx - b.idx);
  const best = candidates[0];
  if (best.idx === Infinity) {
    if (WARRANTY_NOUN_RE.test(q)) return 'warranties';
    return 'customers';
  }
  return best.entity;
}

/** count vs list — 'which'/'list'/'show me' means individual rows; a bare
 *  "how many" (or no explicit quantifier at all — a bare "mesa customers")
 *  means a single count. Never 'groupBy'/'sum' — those are decided by their
 *  own dedicated detectors below, tried first. */
function opFromShape(q) {
  return LIST_VERB_RE.test(q) && !HOW_MANY_RE.test(q) ? 'list' : 'count';
}

/** Conditions this file hands off to analytics.js's OWN, already-tested
 *  filter builder — every one of these has a CONDITION_PLAN_FIELD entry
 *  (analytics.js), so a condition this misses is independently re-detected
 *  and backfilled (or honestly declined) by missingConditions/
 *  buildConditionOverrideFilter in routes/analytics.js's runAnalyticsQuestion
 *  — never silently dropped. Building them here too (rather than leaving
 *  every one of them to that safety net) matters for one reason:
 *  suspiciousUnfilteredCustomerPlan (analytics.js) falls back to the model
 *  whenever a customers list/count plan has NO filters at all and the
 *  question names a 2+-digit number (a zip, most ages) — so a filter this
 *  function can build must be built here, before that gate ever runs. */
// R18 P4 (C2, multi-hop AND-drop): 'serviceType' added — "how many trane customers needed a
// repair visit" names TWO conditions (brand + a repair-visit condition); buildConditionOverrideFilter
// resolves it via SERVICE_TYPE_PHRASE_RE the same way it resolves brand/city/etc, and a plan
// that can't resolve it (buildConditionOverrideFilter returning null for a genuinely detected
// condition) makes buildSafetyNetFilters' own `unresolved` flag bail the WHOLE plan, same as
// every other safety-net condition.
const SAFETY_NET_CONDITIONS = ['email', 'phone', 'brand', 'county', 'city', 'state', 'zip', 'warranty', 'serviceType'];

/** Returns {filters, unresolved} — `unresolved` is true when a REAL condition was detected in the
 *  question text (detectedConditions) but buildConditionOverrideFilter declined to turn it into a filter
 *  (e.g. a negated brand mention on a customers-entity question — see that function's own doc comment).
 *  That is never the same as "no condition detected" — silently continuing with whatever filters WERE
 *  built would answer a different, unfiltered question with full confidence, exactly the "plan silently
 *  drops a condition" bug this whole file exists to prevent — so detectAnalyticsPlan below must bail
 *  (return null) whenever this comes back true, rather than ever returning a partial plan. */
function buildSafetyNetFilters(question, entity) {
  const found = detectedConditions(question);
  const filters = [];
  let unresolved = false;
  for (const c of SAFETY_NET_CONDITIONS) {
    if (!found.has(c)) continue;
    const f = buildConditionOverrideFilter(c, question, entity);
    if (f) filters.push(f);
    else unresolved = true;
  }
  return { filters, unresolved };
}

/** "How many units have expiring soon?" / "units running out" — the same
 *  warranty-status wording warrantyStatusFromQuestion (analytics.js) already
 *  recognizes, just without the literal word "warrant" anywhere in the
 *  sentence (that function requires it as a guard against misreading an
 *  unrelated "expired"/"active" word elsewhere). Safe to relax only in the
 *  equipment/warranties context this is always called with: "expiring
 *  soon"/"out of warranty"/"still active" said about a UNIT essentially
 *  always means that unit's own warranty status in this domain. */
// Reviewer NO-GO (2026-09-26, round 14): "how many units are not expired" / "which units aren't under
// warranty" name a real warranty-status condition that warrantyStatusFromQuestion correctly refuses to
// guess a bucket for (negation makes it genuinely ambiguous — see that function's own doc comment) —
// but silently building NO filter at all for a question that plainly named one is the exact same
// "silently drops a condition" bug as ever, just via a different path. The sentinel below lets this
// file's own caller bail on the WHOLE plan (never guess which of the other buckets was meant) instead of
// mistaking "negated" for "no warranty condition here at all".
const WARRANTY_STATUS_AMBIGUOUS = Symbol('warrantyStatusAmbiguous');

function impliedWarrantyStatus(q, entity) {
  const direct = warrantyStatusFromQuestion(q);
  if (direct) return direct;
  if (hasAmbiguousWarrantyStatusNegation(q)) return WARRANTY_STATUS_AMBIGUOUS;
  if (entity !== 'equipment' && entity !== 'warranties') return null;
  const relaxed = `${q} warranty`;
  const relaxedStatus = warrantyStatusFromQuestion(relaxed);
  if (relaxedStatus) return relaxedStatus;
  if (hasAmbiguousWarrantyStatusNegation(relaxed)) return WARRANTY_STATUS_AMBIGUOUS;
  return null;
}

/** "runs on R-22" / "uses R-410A" — a refrigerant CODE (the stored
 *  convention this corpus uses is "R-" + digits + an optional trailing
 *  letter, e.g. "R-410A"/"R-454B") named right after "runs on"/"uses"/
 *  "on <code>". A bare mention with no recognizable code (e.g. a stray "r"
 *  somewhere unrelated) never matches — this is deliberately narrow so it
 *  only ever fires on a real refrigerant-code token, never a guess. */
const REFRIGERANT_CODE_RE = /\br-?(\d{2,4}[a-z]?)\b/i;

function detectRefrigerantMention(q) {
  return REFRIGERANT_CODE_RE.test(q);
}

function buildRefrigerantFilter(q) {
  const m = REFRIGERANT_CODE_RE.exec(q);
  return m ? { field: 'refrigerant', op: 'eq', value: `R-${m[1].toUpperCase()}` } : null;
}

/** "customers without any contact info (on file) at all" — neither the bare
 *  word "email" nor "phone" appears, so detectedConditions' own CONTACT_WORD_RE
 *  never fires for either — a real, common owner phrasing for exactly the
 *  hasEmail=false AND hasPhone=false combination. */
const NO_CONTACT_INFO_RE = /\b(?:no|not have|don'?t have|without|missing|lacking)\s+(?:any\s+)?contact\s+(?:info(?:rmation)?|details?)\b/i;

/** "installs ... since 2020" — see its one use-site's own doc comment. */
const SINCE_YEAR_RE = /\bsince\s+(\d{4})\b/i;

/* ============================================================ dimension words
 * (groupBy/coverage shapes — "by <dim>", "per <dim>", "how many different
 * <dim>", "each <dim>") — canonical GROUP_BY_FIELDS names, matched via their
 * own plain-English plural/singular spelling.
 */
const DIM_WORD_TO_FIELD = {
  zip: 'zip', 'zip code': 'zip', 'zip codes': 'zip',
  county: 'county', counties: 'county',
  city: 'city', cities: 'city',
  state: 'state', states: 'state',
  brand: 'brand', brands: 'brand',
  technician: 'technician', technicians: 'technician',
  month: 'month', months: 'month',
  'document type': 'documentType', 'document types': 'documentType',
  'warranty status': 'warrantyStatus',
};
const DIM_ALT = altOf(Object.keys(DIM_WORD_TO_FIELD));

/* ============================================================ dedicated shape detectors
 * Tried, in order, before the generic entity/op/filter path below — each one
 * is a narrow, well-known shape that the generic path would get wrong
 * (a different entity, a different op) if left to it.
 */

/** "how many jobs did Wyatt Coburn do last month" / "how many jobs did Danny
 *  Ochoa run this month" — a NAMED technician as the subject of do/run/
 *  close(out)/complete/handle. Never resolveServiceVisitsOverride's own
 *  territory (that regex only ever matches a generic "we"/"did we service"
 *  subject) — this is the same shape for a specific PERSON instead. */
const TECHNICIAN_ACTION_RE =
  /\b(?:did|do|does)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+(?:do|run|close(?:\s+out)?|complete|handle)\b/i;
const NON_NAME_STOPWORDS = new Set([
  'we', 'you', 'they', 'it', 'he', 'she', 'the', 'our', 'any', 'each', 'this', 'that',
  'customers', 'clients', 'units', 'equipment', 'jobs', 'work', 'service',
]);

/** "ddanny ochoa" — a doubled FIRST letter typo of a proper name (there is no
 *  closed technician-name vocabulary for normalizeQuestion's own fuzzy
 *  corrector to check a name against, so this common slip reaches this file
 *  uncorrected). Collapsing a doubled leading letter is a general typo shape,
 *  not a name-specific fix — the same "repeated-letter slip" family as the
 *  "yeears"/"eexpiring" tolerances above. */
function dedupeLeadingLetter(word) {
  const m = /^([a-z])\1(\w{3,})$/i.exec(word);
  return m ? m[1] + m[2] : word;
}

function detectTechnicianAction(q) {
  const m = TECHNICIAN_ACTION_RE.exec(q);
  if (!m) return null;
  const name = m[1].trim().split(/\s+/).map(dedupeLeadingLetter).join(' ');
  const firstWord = name.split(/\s+/)[0].toLowerCase();
  if (NON_NAME_STOPWORDS.has(firstWord)) return null;
  return {
    entity: 'serviceVisits',
    op: opFromShape(q),
    filters: [{ field: 'technician', op: 'eq', value: titleCaseWords(name) }],
  };
}

/** "breakdown by technician" / "each technician (close out/did/ran) ..." /
 *  "which technician did the most jobs" — technician is the ONLY dimension
 *  word that names no OTHER entity noun of its own ("jobs"/"units"/...) most
 *  of the time, so it needs its own forced-entity rule the same way
 *  resolveServiceVisitsOverride forces entity for its own shapes — a bare
 *  noun-based default would otherwise land on 'customers', which has no
 *  'technician' column at all. */
const TECHNICIAN_GROUPBY_RE =
  /\bbreakdown\s+by\s+technician\b|\beach\s+technician\b|\bwhich\s+technician\b[\s\S]*\b(?:most|top)\b/i;

function detectTechnicianGroupBy(q) {
  if (!TECHNICIAN_GROUPBY_RE.test(q)) return null;
  return { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' };
}

/** "how many different zip codes/counties/cities/states/brands/technicians
 *  do we cover/serve/have" — the DIMENSION's own distinct-value count, never
 *  a per-group breakdown (see analytics.js's formatAnalyticsAnswer, which
 *  reads plan.countDistinct to answer with a single number instead of a
 *  breakdown list). */
const DIFFERENT_DIM_RE = new RegExp(`\\bhow many different\\s+(${DIM_ALT})\\b`, 'i');

/**
 * Field-phrasing g133/g138 ("whats the oldest unit we have on file" /
 * "whats our newest install") — equipment RANKED by installation_date, never
 * a filtered/counted question. Scoped to a genuine equipment/install noun
 * (EQUIPMENT_NOUN_RE, the same table entityFromNouns above reads) so an
 * unrelated superlative this file has no ranking query for ("our newest
 * customer", "the latest invoice") is left alone rather than guessed at —
 * this shape, unlike sortBy for customers (validatePlan, analytics.js),
 * plugs into queryInstallDateExtreme/formatInstallDateExtremeAnswer
 * (routes/analytics.js), never buildAnalyticsSQL's plain filtered path.
 */
function detectInstallDateExtreme(q) {
  if (!EQUIPMENT_NOUN_RE.test(q)) return null;
  if (/\b(oldest|earliest)\b/i.test(q)) return { entity: 'equipment', op: 'list', sortBy: 'installDateAsc' };
  if (/\b(newest|latest)\b/i.test(q)) return { entity: 'equipment', op: 'list', sortBy: 'installDateDesc' };
  return null;
}

/**
 * Round 16 part 2, D2 item 3: exported so api/ask.js (F4) can stop routing this exact shape to the
 * agent-first path. agent/intents.js's isUnitRankingQuestion (and ask.js's own analyticsCandidate
 * gate, ~L872, plus the isAgentFirstQuestion check at ~L1656) both predate this file's new
 * detectInstallDateExtreme/queryInstallDateExtreme/formatInstallDateExtremeAnswer support and were
 * written when "the closed-vocabulary analytics planner has no sort for equipment" was still true —
 * it no longer is, for this one shape (oldest/newest/earliest/latest unit|system|equipment|install).
 * ask.js does not import analytics/detPlan.js today (only analytics.js, which cannot re-export
 * this — detPlan.js already imports from analytics.js, so the reverse import is circular and
 * throws a TDZ error on ENTITY_SYNONYMS at load) and is outside F2's ownership this round, so this
 * export is a hook, not a wire-up — see the round report for the exact ask.js patch needed (a new
 * import straight from './_lib/analytics/detPlan.js' plus two call-site edits) to stop
 * double-routing g133/g138-shaped questions to the model-backed agent when this deterministic path
 * can already answer them for free.
 */
export function isInstallDateExtremeQuestion(question) {
  return detectInstallDateExtreme(String(question ?? '')) !== null;
}

function detectDistinctDimensionCount(q) {
  const m = DIFFERENT_DIM_RE.exec(q);
  if (!m) return null;
  const field = DIM_WORD_TO_FIELD[m[1].toLowerCase()];
  if (!field) return null;
  const entity = field === 'brand' ? 'equipment' : field === 'technician' ? 'serviceVisits' : 'customers';
  return { entity, op: 'groupBy', groupBy: field, countDistinct: true };
}

/** "what zip codes do we serve/cover" / "customers by county" / "jobs per
 *  month" / "X per <dim>" / "each <dim>" (non-technician) / "breakdown by
 *  <dim>" / "group(ed) by <dim>" — a plain per-group breakdown, entity
 *  chosen the ordinary noun-based way (never forced, unlike technician). */
const GROUPBY_PHRASE_RE = new RegExp(
  `\\b(?:group(?:ed)?\\s+by|breakdown\\s+by|by)\\s+(${DIM_ALT})\\b|` +
    `\\bper\\s+(${DIM_ALT})\\b|` +
    `\\beach\\s+(${DIM_ALT})\\b|` +
    `\\bwhat\\s+(${DIM_ALT})\\b[\\s\\S]*\\b(?:do we (?:serve|cover|have)|are (?:on file|covered))\\b`,
  'i'
);

function detectGroupByPhrase(q) {
  const m = GROUPBY_PHRASE_RE.exec(q);
  if (!m) return null;
  const word = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
  const field = DIM_WORD_TO_FIELD[word];
  if (!field || !GROUP_BY_FIELDS.includes(field)) return null;
  if (field === 'technician') return { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' };
  const entity = field === 'brand' ? 'equipment' : entityFromNouns(q);
  return { entity, op: 'groupBy', groupBy: field };
}

/** "Trane vs Carrier units" / "Trane versus Carrier" — a brand comparison:
 *  groupBy brand narrowed to an `in` filter of just those two (or more)
 *  brands, exactly the shape ANALYTICS_FEW_SHOT's own "trane vs carrier
 *  units" example teaches the model. Reuses buildConditionOverrideFilter's
 *  own brand-word recognition (the same closed BRAND_WORDS table
 *  analytics.js already keys detectedConditions('brand') off) rather than a
 *  second hand-written brand list. */
const COMPARISON_JOIN_RE = /\b(?:vs\.?|versus|or)\b/i;

function detectBrandComparison(q) {
  if (!COMPARISON_JOIN_RE.test(q)) return null;
  if (!detectedConditions(q).has('brand')) return null;
  const parts = q.split(COMPARISON_JOIN_RE);
  if (parts.length < 2) return null;
  const brands = [];
  for (const part of parts) {
    const f = buildConditionOverrideFilter('brand', part);
    if (f && !brands.includes(f.value)) brands.push(f.value);
  }
  if (brands.length < 2) return null;
  return { entity: 'equipment', op: 'groupBy', groupBy: 'brand', filters: [{ field: 'brand', op: 'in', value: brands }] };
}

/** "customers locked into / enrolled in / signed up for / under a
 *  maintenance agreement" — the sentence's SUBJECT noun ("customers") is
 *  earliest, so the plain noun-based entity picker (entityFromNouns) would
 *  wrongly land on 'customers' — but the oracle counts the DOCUMENTS of that
 *  type (a customer "locked into an agreement" is really asking "how many
 *  such agreements are on file"), the same "documents" shape every other
 *  bare doc-type count few-shot already teaches ("how many permits do we
 *  have" -> documents). A real, generalizable English construction, not one
 *  tied to this exam's own wording. */
const LOCKED_INTO_DOCTYPE_RE = /\blocked into\s+(?:an?\s+)?([a-z][a-z\s-]*?)\s*[?.!]*\s*$/i;

function detectLockedIntoDocType(q) {
  const m = LOCKED_INTO_DOCTYPE_RE.exec(q);
  if (!m) return null;
  const docType = docTypeFromWord(m[1].trim());
  if (!docType) return null;
  return { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: docType }] };
}

/** "which customers are on a maintenance plan" / "have a PO on file" / "have
 *  a permit on file" / "are enrolled in / signed up for a <docType>" — unlike
 *  "locked into" (above), this phrasing asks about CUSTOMERS existentially
 *  linked to a document of that type (matches queryCustomersByDocTypeCondition's
 *  own hasDocType/lacksDocType semantics, routes/analytics.js) — a customer
 *  count/list, never a raw document count. Negation ("don't have a permit on
 *  file") flips it to lacksDocType. */
const DOCTYPE_NEGATION_RE = /\b(?:don'?t|doesn'?t|do\s+not|does\s+not|without|no|never|haven'?t|hasn'?t|lack(?:ing)?)\b/i;

function detectCustomersHasDocType(q) {
  if (entityFromNouns(q) !== 'customers') return null;
  const m = DOC_TYPE_WORD_RE.exec(q);
  if (!m) return null;
  const docType = docTypeFromWord(m[1]);
  if (!docType) return null;
  const negated = DOCTYPE_NEGATION_RE.test(q.slice(0, m.index));
  return {
    entity: 'customers',
    op: opFromShape(q),
    filters: [{ field: negated ? 'lacksDocType' : 'hasDocType', op: 'eq', value: docType }],
  };
}

/**
 * R18 P4 (blind generalization round 18 part 2, C2 multi-hop AND-drop / C4 negation): "how many
 * trane customers needed a repair visit" / "how many carrier customers have had a repair call" /
 * "how many customers have never had a preventive maintenance visit" / "customers who have had
 * only preventive maintenance, never a repair" — a customer existentially linked to a service
 * VISIT of a given type (extractions.service_type — see SERVICE_TYPE_FILTER_FIELDS' own doc
 * comment, analytics.js), the event-level sibling of detectCustomersHasDocType just above (a
 * document TYPE). Every SERVICE_TYPE_PHRASE_RE match in the question is read independently for its
 * own nearby negation (never just the first one), so "only X, never Y" builds BOTH a hasServiceType
 * AND a lacksServiceType filter in the same plan — the one shape a single safety-net condition
 * (buildConditionOverrideFilter, which only ever returns ONE filter) could never express.
 */
function detectCustomersHasServiceType(q) {
  if (entityFromNouns(q) !== 'customers') return null;
  const matches = [...q.matchAll(new RegExp(SERVICE_TYPE_PHRASE_RE.source, 'gi'))];
  if (!matches.length) return null;
  let hasValue = null;
  let lacksValue = null;
  for (const m of matches) {
    const value = serviceTypeValueOf(m[1]);
    if (hasNearbyNegation(q.slice(0, m.index), 4)) {
      if (!lacksValue) lacksValue = value;
    } else if (!hasValue) {
      hasValue = value;
    }
  }
  if (!hasValue && !lacksValue) return null;
  const filters = [];
  if (hasValue) filters.push({ field: 'hasServiceType', op: 'eq', value: hasValue });
  if (lacksValue && lacksValue !== hasValue) filters.push({ field: 'lacksServiceType', op: 'eq', value: lacksValue });
  return { entity: 'customers', op: opFromShape(q), filters };
}

/**
 * R18 P4 (C2): the general "every detected condition must be represented in the plan" guard —
 * applied to any dedicated shape detector's plan whose entity is 'customers' (the shapes this bug
 * class actually hit: detectCustomersHasDocType/detectCustomersHasServiceType dropped a SECOND
 * condition — brand, city, ... — the dedicated detector itself never looks for, exactly the "how
 * many mitsubishi customers have a maintenance agreement on file" bug: the doc-type filter was
 * right, but "mitsubishi" vanished). Reuses buildSafetyNetFilters — the SAME detector
 * detectAnalyticsPlan's own generic path already trusts — so a condition it can't confidently turn
 * into a filter bails the WHOLE plan (never a partial, silently-wrong one) rather than being
 * merged in half-built. Filters already present on the dedicated plan are left alone (never
 * duplicated or overridden) — this only ever ADDS a condition the dedicated detector didn't
 * already cover. Scoped to `entity === 'customers'` because that's the only entity every
 * SAFETY_NET_CONDITIONS field (brand/city/county/state/zip/warranty/serviceType) is actually
 * meaningful for via the customer-equipment join (routes/analytics.js's
 * EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN) or a customer-scoped cross-doc query — a dedicated plan for
 * any OTHER entity (documents/equipment/serviceVisits) is left untouched.
 */
// Fields that share ONE semantic "slot" for merge-dedup purposes even though they are different
// filter field names — a plan that already carries EITHER side of the pair has already fully
// resolved that condition (has/lacks, negation included), so the safety net's own (negation-blind)
// version of the same condition must never be added alongside it. Without this, "how many carrier
// customers have never had a preventive maintenance visit" — already correctly resolved by
// detectCustomersHasServiceType to lacksServiceType=PM — got a SECOND, contradictory
// hasServiceType=PM filter bolted on by the safety net's own 'serviceType' condition (which has no
// idea the dedicated detector already read the negation).
const MERGE_DEDUP_SLOT = {
  hasServiceType: 'serviceType', lacksServiceType: 'serviceType',
  hasDocType: 'docType', lacksDocType: 'docType',
};

function mergeDetectedConditions(plan, q) {
  if (!plan || plan.entity !== 'customers') return plan;
  const { filters: extra, unresolved } = buildSafetyNetFilters(q, plan.entity);
  if (unresolved) return null;
  if (!extra.length) return plan;
  const existingFields = new Set((plan.filters ?? []).map((f) => f.field));
  const existingSlots = new Set(
    (plan.filters ?? []).map((f) => MERGE_DEDUP_SLOT[f.field]).filter(Boolean)
  );
  const merged = [...(plan.filters ?? [])];
  for (const f of extra) {
    if (existingFields.has(f.field)) continue;
    if (MERGE_DEDUP_SLOT[f.field] && existingSlots.has(MERGE_DEDUP_SLOT[f.field])) continue;
    merged.push(f);
    existingFields.add(f.field);
  }
  return { ...plan, filters: merged };
}

/**
 * R18 P4 (C3, time-window drop): "how many units had their warranty expire in the past year" /
 * "any warranties expiring in the next 90 days" / "how many warranties expire by the end of this
 * calendar year" / "how many units warranty has expired so far this year" — a real calendar
 * WINDOW on the unit's own warranty.expires date, distinct from the fixed warrantyStatus bucket
 * (impliedWarrantyStatus, below — a fixed <=365-day-out slice) and unlike every other timeRange
 * consumer (documents/serviceVisits), never wired through plan.timeRange (equipment/warranties
 * questions never read plan.timeRange at all — see executeAnalyticsPlan, routes/analytics.js) —
 * this builds the concrete warrantyExpires filter bounds directly, reusing resolveAnyTimeRange
 * (the SAME central date-range parser reconcileTimeRange already applies to every other entity)
 * so a phrasing that function recognizes is honored here too, with no second date-math
 * implementation. Requires an explicit "expire(s)/expired" word (never a bare "under warranty" —
 * that's impliedWarrantyStatus's own, non-time-windowed territory) so this never fires for a
 * question that named no real window at all.
 */
const WARRANTY_EXPIRE_WORD_RE = /\bwarrant(?:y|ies)\b[\s\S]{0,20}\bexpir\w*\b|\bexpir\w*\b[\s\S]{0,20}\bwarrant(?:y|ies)\b/i;

function detectWarrantyExpiryWindow(q) {
  if (!WARRANTY_EXPIRE_WORD_RE.test(q)) return null;
  const range = resolveAnyTimeRange(q);
  if (!range) return null;
  const filters = [];
  if (range.from) filters.push({ field: 'warrantyExpires', op: 'gte', value: range.from });
  if (range.to) filters.push({ field: 'warrantyExpires', op: 'lte', value: range.to });
  if (!filters.length) return null;
  return { entity: 'equipment', op: opFromShape(q), filters };
}

/** "how many different years do we have customers on file for" — a DISTINCT-year count over
 *  service_date records (extractions.field_key='service_date'), forced to entity 'serviceVisits'
 *  the same way detectTechnicianGroupBy/detectDistinctDimensionCount force an entity a bare noun
 *  reading would get wrong ("customers" is the earliest noun here, but there is no customer-level
 *  "year" column — the years on file are the service visits' own dates). `year` is a groupBy
 *  dimension keyOf/GROUP_BY_FIELDS (analytics.js/routes/analytics.js) derive from each visit's own
 *  month string, never a real stored column. */
const DIFFERENT_YEARS_RE = /\bhow many different years?\b|\bhow many years?\b[\s\S]{0,20}\bon file\b/i;

function detectDistinctYearsCount(q) {
  if (!DIFFERENT_YEARS_RE.test(q)) return null;
  return { entity: 'serviceVisits', op: 'groupBy', groupBy: 'year', countDistinct: true };
}

/* ============================================================ main entry point */

/**
 * `question` is already-normalized text (routes/analytics.js's
 * planAnalyticsQuestion calls this with the same `question_n` it would hand
 * the model) — lowercased, typo-corrected, abbreviation-expanded. Returns a
 * raw plan object (the same shape `toolUse?.input` has) or null. Never
 * throws.
 */
/**
 * Self-join "does this row duplicate another row" shapes ("duplicate
 * customers", "appear more than once", "share an address with another
 * customer", "used by more than one unit") — a real condition, but not one
 * any flat entity/op/groupBy/filter plan can express (it needs a GROUP BY …
 * HAVING count(*) > 1 over the SAME entity, not a filter value). No plan
 * feature for this exists yet; naming it here (rather than leaving it to
 * fall through the generic path below) matters because these questions are
 * often otherwise-bare existence/list shapes ("do we have any duplicate
 * customers?") that would, without this check, produce a confident but
 * WRONG plain count/existence plan.
 */
// Round 15 (A) regression guard: "are there any equipment serial numbers
// that appear under more than one customer" is the same self-join family as
// "used by more than one unit" just paired with a different noun
// (customer/account/property instead of unit) — round 15's own
// preClassifyAnalytics widening (existence-shaped questions) now lets this
// shape reach detectAnalyticsPlan at all, so it must be named here rather
// than silently falling into the generic bare-count path below.
const SELF_DUPLICATE_RE =
  /\b(duplicate\s+customers?|appear\s+more\s+than\s+once|share\s+an?\s+address|used\s+by\s+more\s+than\s+one\s+unit|more\s+than\s+once\s+in\s+our\s+records|appear\s+under\s+more\s+than\s+one|more\s+than\s+one\s+customer\b|under\s+more\s+than\s+one\s+(?:customer|account))\b/i;

/**
 * R18 (H1, breadth-data-quality-017/018/019/023): SELF_DUPLICATE_RE's own doc comment above says
 * "No plan feature for this exists yet" - that changed this round. isDuplicateName/sharesAddress/
 * isDuplicateSerial (analytics.js's DATA_QUALITY_FIELD_ENTITY) are computed exactly like the flat
 * count(*) > 1 self-join the comment describes, just via a cross-row frequency map attached to
 * every already-fetched row (routes/analytics.js's attachDuplicateFlag) instead of a SQL HAVING
 * clause - the executor never fetches a FILTERED set for an unrecognized boolean field (see
 * buildAnalyticsSQL's own doc comment), so every row for the entity is already there to compute
 * the frequency over. Three concrete, narrow mappings (never a generic catch-all) so a
 * duplicate-shaped question none of these three recognizes still falls through to
 * SELF_DUPLICATE_RE's honest decline below, exactly as before this round.
 */
const DUPLICATE_ADDRESS_RE = /\bshare\s+an?\s+address\b/i;
const DUPLICATE_SERIAL_RE =
  /\bserial\s+numbers?\b[\s\S]{0,40}\bmore\s+than\s+one\s+(?:unit|equipment)\b|\bused\s+by\s+more\s+than\s+one\s+unit\b|\bappear(?:s)?\s+under\s+more\s+than\s+one\s+(?:customer|account)\b|\bunder\s+more\s+than\s+one\s+(?:customer|account)\b/i;
const DUPLICATE_NAME_RE =
  /\bduplicate\s+customers?\b|\bappear(?:s)?\s+more\s+than\s+once(?:\s+in\s+our\s+records)?\b|\bcustomers?\b[\s\S]{0,20}\bmore\s+than\s+once\b/i;

function detectDuplicateCondition(q) {
  // Checked in this order (address / serial before the generic "name" one) so the address and
  // serial phrasings, which never mention "once", can't be shadowed by a broader name match — and
  // so they get their own field even though they also loosely fit "duplicate ... records".
  if (DUPLICATE_ADDRESS_RE.test(q)) {
    return { entity: 'customers', op: opFromShape(q), filters: [{ field: 'sharesAddress', op: 'eq', value: true }] };
  }
  if (DUPLICATE_SERIAL_RE.test(q)) {
    return { entity: 'equipment', op: opFromShape(q), filters: [{ field: 'isDuplicateSerial', op: 'eq', value: true }] };
  }
  if (DUPLICATE_NAME_RE.test(q)) {
    return { entity: 'customers', op: opFromShape(q), filters: [{ field: 'isDuplicateName', op: 'eq', value: true }] };
  }
  return null;
}

/** Content-search shapes ("did any jobs involve/mention X", symptom words) —
 *  the real distinguishing condition is free-text search inside a document/
 *  visit note, which this planner's closed filter vocabulary cannot express
 *  at all (there is no "notes contain X" FILTER_FIELD). Left unrecognized,
 *  the generic path below would otherwise happily return a bare, wrong,
 *  unfiltered entity count/list just because a "how many"/"which" quantifier
 *  is present — this must return null instead so the question falls through
 *  to a path that actually searches text (contentCount / the agent). */
const CONTENT_SEARCH_DENY_RE =
  /\b(mention|involv|complain|noisy|rattl|hum(?:m)?ing|freez\w*|crack\w*|leak\w*|smell\w*|smoke|burn(?:ed|ing)?|tripp?ed|breaker|error\s+code|symptom)/i;

/** Multi-hop / self-referential "connect" shapes (K4's territory, per the
 *  round contract) — a mismatch between two of a customer's OWN records, a
 *  value repeated across DIFFERENT customers, or a combination of a time
 *  condition with an absent-document condition that this flat plan vocabulary
 *  cannot express as a single filter. Must return null so these fall through
 *  to relations/decompose (or the agent) rather than being confidently
 *  mis-answered as a bare filtered count. */
// "march" here also means "match" — nlNormalize.js's own general fuzzy-typo
// corrector (VOCAB includes month names) silently mangles "doesn't match"
// into "doesn't march" (edit distance 1: t->r) before this ever runs, the
// exact same collision class as "older"->"order" (see resolveAgeFilter's own
// doc comment, analytics.js) — worked around locally here rather than in
// nlNormalize.js (outside this round's file ownership).
const CONNECT_DENY_RE =
  /\b(more than once|doesn'?t (?:match|march)|don'?t (?:match|march)|shared by|share[sd]?\s+an?\s+address|different address|address\s+mismatch|no\s+warranty\s+registration|serial\s+numbers?\s+appear|quotes?d?\s+but\s+not\s+installed|replaced\s+more\s+than\s+once|installed\s+more\s+than\s+\d+\s+days\s+ago)\b|\bquotes?d?\b[\s\S]{0,60}\b(?:not\s+had|haven'?t\s+had|has\s+not\s+had|hasn'?t\s+had)\b[\s\S]{0,20}\binstalled\b/i;

// Round 15 follow-up (regression fix, breadth-connect-120): "how many
// maintenance agreements have zero service visits behind them" — a count of
// ONE entity (agreements) qualified by an EVENT COUNT on a DIFFERENT, related
// entity (service visits) being zero — is a join/HAVING-COUNT-0 shape this
// flat plan vocabulary has no field for at all, the same class of question
// CONNECT_DENY_RE already exists to decline. This used to reach here only
// through the financials money gate's own (over-broad) "agreement" match,
// which then escalated it to the real agent — narrowing that gate (this
// round's financials/classify.js hook) exposed it to this file directly,
// where the generic "how many <doc-type word>" path answered a bare,
// unqualified document count and silently dropped the "zero visits" half of
// the question entirely. Never a single-entity "no X on file" own-field
// check (those stay MISSING_FIELD_RULES' territory, below) — this is
// specifically an EVENT/VISIT noun from a DIFFERENT table being zero.
const ZERO_LINKED_EVENTS_RE =
  /\b(?:zero|no)\s+(?:service\s+)?(?:visits?|callbacks?|jobs?|invoices?|calls?|tickets?|work\s*orders?)\s+(?:behind\s+(?:them|it)|(?:since|after)\s+(?:install|installation|signup|purchase)|associated\s+with\s+(?:them|it)|to\s+(?:their|its)\s+name)\b/i;

/** A "follow-up" fragment referring back to a PREVIOUS turn's answer
 *  ("Expired warranties -- what about just the Mesa ones?") — this planner
 *  sees only the single question text, never prior conversation state, so it
 *  cannot know what "just the Mesa ones" is narrowing. Recognized by the
 *  em/en-dash (or " -- ") construct joining a topic fragment to a narrowing
 *  clause; returning null here (rather than guessing a plan from whichever
 *  noun happens to appear) is the same "never guess" rule as everywhere else
 *  in this file. */
const FOLLOW_UP_FRAGMENT_RE = /\s(?:--|—|-)\s.*\b(?:just|only|now)\b/i;

/** "no readable text extracted" — the one data-quality shape this file still
 *  declines: whether a document's OCR/facets pass ever produced any text at
 *  all has no reliable proxy in the closed plan vocabulary (the golden
 *  fixture's `facets` rows are not a signal this planner's tests can pin down
 *  either way — see the round 15 handoff), so this stays a deliberate
 *  fall-through rather than a guess dressed up as a filter. */
const READABLE_TEXT_DENY_RE = /\breadable text\b/i;

/**
 * Round 15 (A): "data-quality" / missing-field shapes — "documents aren't
 * linked to any customer", "customers have no documents on file", "no
 * service address on file", "missing a serial number", "no install date on
 * file", "don't have a model number recorded", "no tonnage on file", "no
 * warranty information at all", "units not linked to a customer", "install
 * date in the future", "documents classified as 'other'", "service documents
 * have no service date". Each maps to exactly one of analytics.js's
 * DATA_QUALITY_BOOLEAN_FIELDS (or, for "classified as other", a literal
 * documentType filter) — a closed, per-entity-restricted boolean vocabulary
 * validatePlan already enforces, so a rule below can never smuggle in a field
 * the executor doesn't actually know how to check. Every regex is anchored to
 * the CONDITION wording (never an exam id or exact sentence), so a paraphrase
 * ("units are missing a serial", "no serial on file") matches the same as the
 * canonical phrasing; a shape none of these recognizes falls through to
 * READABLE_TEXT_DENY_RE / the generic path / the model exactly as before.
 * `entity` here is fixed per rule (never entityFromNouns) because each field
 * only ever means one thing regardless of which noun the sentence happens to
 * lead with — see analytics.js's DATA_QUALITY_FIELD_ENTITY doc comment.
 */
const MISSING_FIELD_RULES = [
  // documents <-> customer link ("aren't linked", "missing a customer") — checked before the
  // customer-facing rules below so "documents missing a customer" never falls into hasAnyDocument.
  {
    entity: 'documents', field: 'hasCustomerLink', value: false,
    re: /\bdocuments?\b[\s\S]{0,30}\b(?:aren'?t|are\s+not|is\s+not|isn'?t|not)\s+linked(?:\s+to)?\s+(?:any\s+)?customers?\b|\bdocuments?\b[\s\S]{0,20}\bmissing\s+a\s+customer\b/i,
  },
  {
    entity: 'customers', field: 'hasAnyDocument', value: false,
    re: /\bcustomers?\b[\s\S]{0,25}\bno\s+documents?\s+on\s+file\b|\bcustomers?\b[\s\S]{0,25}\b(?:don'?t|do\s+not)\s+have\s+(?:any\s+)?documents?\s+on\s+file\b/i,
  },
  {
    entity: 'customers', field: 'hasServiceAddress', value: false,
    re: /\bno\s+service\s+address\s+on\s+file\b|\bmissing\s+a\s+service\s+address\b/i,
  },
  {
    entity: 'customers', field: 'hasZip', value: false,
    re: /\baddress(?:es)?\b[\s\S]{0,20}\bmissing\s+a?\s*zip\s*codes?\b|\bno\s+zip\s*codes?\s+on\s+file\b/i,
  },
  {
    entity: 'equipment', field: 'hasSerial', value: false,
    re: /\bmissing\s+a?\s*serial\s*(?:numbers?)?\b|\bno\s+serial\s*(?:numbers?)?\s+on\s+file\b/i,
  },
  {
    entity: 'equipment', field: 'hasInstallDate', value: false,
    re: /\bno\s+install(?:ation)?\s+dates?\s+on\s+file\b|\bmissing\s+a?n?\s*install(?:ation)?\s+date\b/i,
  },
  {
    entity: 'equipment', field: 'hasModel', value: false,
    re: /\b(?:don'?t|doesn'?t|do\s+not|does\s+not)\s+have\s+a?\s*model\s*(?:numbers?)?\s*(?:recorded)?\b|\bno\s+model\s*(?:numbers?)?\s+(?:recorded|on\s+file)\b|\bmissing\s+a?\s*model\s*(?:numbers?)?\b/i,
  },
  {
    // R18 P4 (blind generalization round 18 part 2, h128): "how many units have no tonnage
    // listed" — the same condition as "no tonnage on file", just a paraphrase ("listed" for "on
    // file") this regex didn't cover yet.
    entity: 'equipment', field: 'hasTonnage', value: false,
    re: /\bno\s+tonnage\s+(?:on\s+file|listed)\b|\bmissing\s+(?:a\s+|the\s+)?tonnage\b|\btonnage\s+(?:is\s+)?(?:not\s+listed|missing)\b/i,
  },
  {
    // R18 P4 (h053): "how many units are actually registered for warranty" — data.warranty.
    // registrationState === 'on_file' (see WARRANTY_REGISTERED_ROW_KEY, routes/analytics.js),
    // never the warrantyStatus coverage bucket (a unit can be registered AND expired, or
    // unregistered AND still active — the two are independent facts).
    entity: 'equipment', field: 'warrantyRegistered', value: true,
    re: /\b(?:actually\s+)?registered\s+for\s+warranty\b|\bwarranty\s+registration\s+(?:is\s+)?on\s+file\b/i,
  },
  {
    // R18 P4 (C4, negation, h134): "how many customers have zero equipment on file" — the
    // customers-side mirror of hasAnyDocument.
    entity: 'customers', field: 'hasAnyEquipment', value: false,
    re: /\bzero\s+equipment\s+on\s+file\b|\bno\s+equipment\s+on\s+file\b|\b(?:don'?t|do\s+not)\s+have\s+(?:any\s+)?equipment\b/i,
  },
  // "no warranty information AT ALL" -> warrantyStatus 'unknown', not a new
  // hasWarrantyInfo boolean: deriveWarranty (warrantyRules.js) always writes
  // a non-empty "stable" object onto every unit (registrationOnFile: null,
  // registrationState: 'unknown', ... even when nothing was ever extracted),
  // so "the warranty column is a non-empty object" is true for every unit
  // and can never distinguish real data from none at all. warrantyStatusOf
  // already resolves exactly this case to 'unknown' (alertTier returns
  // 'unknown' whenever there's no expiry date to compute from) — the same
  // bucket warrantyStatusFromQuestion/impliedWarrantyStatus already answer
  // for a "warranty status unknown" phrasing, just reached by a wording
  // (WARRANTY_STATUS_WORD_RE has no "no ... information" phrase) that
  // function doesn't itself recognize.
  {
    entity: 'equipment', field: 'warrantyStatus', value: 'unknown',
    re: /\bno\s+warranty\s+information\b|\bmissing\s+(?:all\s+)?warranty\s+information\b/i,
  },
  {
    entity: 'equipment', field: 'hasCustomerLink', value: false,
    re: /\b(?:units?|equipment)\b[\s\S]{0,30}\b(?:aren'?t|are\s+not|is\s+not|isn'?t|not)\s+linked(?:\s+to)?\s+(?:a\s+)?customers?\b/i,
  },
  {
    entity: 'equipment', field: 'installDateInFuture', value: true,
    re: /\binstall(?:ation)?\s+dates?\s+(?:that\s+are\s+|is\s+|are\s+)?in\s+the\s+future\b/i,
  },
];

/** "SERVICE documents" (as opposed to a permit/photo/proposal/registration/
 *  agreement/correspondence/shop-internal record) — the canonical document
 *  types that name an actual visit or job, the general business-paperwork
 *  category a dispatcher means by that word, never a specific exam id/text.
 *  Every other document type (permit, nameplate-photo, proposal-quote,
 *  warranty-registration, maintenance-agreement, purchase-order,
 *  equipment-record, correspondence, internal) is paperwork ABOUT a unit or
 *  account, not a record of doing the work itself. */
const SERVICE_DOCUMENT_TYPES = [
  'service-ticket', 'service-report', 'work-order', 'dispatch-note', 'inspection-report', 'startup-sheet', 'invoice',
];
const SERVICE_DOCUMENTS_RE = /\bservice\s+documents?\b/i;

{
  const noServiceDateRe = /\bno\s+service\s+dates?\b/i;
  MISSING_FIELD_RULES.push({
    entity: 'documents', field: 'hasServiceDate', value: false,
    re: noServiceDateRe,
    // "SERVICE documents have no service date" additionally narrows to the
    // SERVICE_DOCUMENT_TYPES set above — a bare "documents have no service
    // date" (no "service" qualifier) stays a plain documents-wide check.
    extraFilters: (q) => (SERVICE_DOCUMENTS_RE.test(q) ? [{ field: 'documentType', op: 'in', value: SERVICE_DOCUMENT_TYPES }] : []),
  });
}

/** "documents classified as 'other' instead of a real type" — a literal
 *  documentType filter, never docTypeFromWord (the word "other" names no
 *  business document type and so is deliberately absent from
 *  DOCUMENT_TYPE_SYNONYMS/docTypeSynonymAlternation — it's the catch-all
 *  DOCUMENT_TYPE_IDS member every unclassified/legacy value normalizes to,
 *  see documentTypes.js's normalizeDocumentType). */
const DOC_TYPE_OTHER_RE = /\bclassified\s+as\s+['"]?other['"]?\b/i;

/** Review fix (R15 blocking defect): every MISSING_FIELD_RULES regex bakes its
 *  own negation word ("no", "missing", "isn't linked", ...) directly into the
 *  shape it matches, but none of them guard against a FURTHER negation
 *  immediately in front of that match — "which units are NOT missing a
 *  serial number" (== HAS a serial number, the opposite of what the rule's
 *  own `value` asserts) still matches "missing a serial number" as a plain
 *  substring and silently produced the confidently wrong count (0, the same
 *  as "which units ARE missing a serial number"). Rather than re-derive the
 *  double-negated meaning here (risking a different confident-wrong shape),
 *  bail this rule entirely when a negation word sits within a few words
 *  immediately before its own match — the contract's own rule for exactly
 *  this situation: "return null (fall through) when unsure". A small
 *  trailing-word window (rather than requiring strict adjacency) also
 *  catches "don't have a missing install date" (negation separated from
 *  "missing" by a filler verb/article), while staying short enough that an
 *  unrelated "not" much earlier in the sentence ("he did not install it
 *  himself, but it's missing a serial number") never suppresses a real
 *  match. */
function hasNearbyNegation(before, maxWords = 4) {
  const words = before.trim().split(/\s+/).filter(Boolean).slice(-maxWords);
  return words.some((w) => /^(?:not|never|without)$/i.test(w) || /n't$/i.test(w));
}

function detectMissingFieldCondition(q) {
  if (READABLE_TEXT_DENY_RE.test(q)) return null;
  for (const rule of MISSING_FIELD_RULES) {
    const m = rule.re.exec(q);
    if (m) {
      if (hasNearbyNegation(q.slice(0, m.index))) return null;
      const extra = typeof rule.extraFilters === 'function' ? rule.extraFilters(q) : [];
      return { entity: rule.entity, op: 'count', filters: [{ field: rule.field, op: 'eq', value: rule.value }, ...extra] };
    }
  }
  if (DOC_TYPE_OTHER_RE.test(q)) {
    return { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'other' }] };
  }
  return null;
}

/**
 * Round 15 follow-up (P0, generalization audit): a central, tenantVocab-aware
 * backstop — never a substitute for the shape-based exclusions above (those
 * still run first and cost nothing), but a last line of defense for a named-
 * customer/business shape this file's own regex bank does not yet recognize
 * at all. NONE of the plans this file ever builds carries a `customerName`
 * filter (that field only ever gets filled by the MODEL path, which has
 * schema-linked vocabulary to work from) — so if this tenant's own name
 * glossary says the question names one of ITS customers by (close to) full
 * name, no plan built here could ever actually be scoped to that customer,
 * and answering with a tenant-wide aggregate instead would be exactly the
 * "confident wrong answer" this whole file exists to avoid. Bail (null) and
 * let the caller fall through to the model, which DOES have the vocabulary
 * to build a correctly-scoped `customerName` filter. Whole-phrase,
 * word-boundary match only (never a bare short word — "Wood" the customer
 * must not false-positive on every mention of the material) and skipped
 * entirely when no tenantVocab was supplied (every existing caller/test that
 * never threads it through keeps its exact current behavior).
 */
function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function questionNamesKnownCustomer(q, tenantVocab) {
  const phrases = tenantVocab?.customers?.phrases;
  if (!Array.isArray(phrases) || !phrases.length) return false;
  for (const raw of phrases) {
    const name = String(raw ?? '').trim();
    // A single short/common word ("Wood", "Ace") is too weak a signal on its
    // own to bail an otherwise-confident aggregate plan over; a real full
    // name always has at least two words or one longer than a short surname.
    if (name.length < 4 || (!/\s/.test(name) && name.length < 6)) continue;
    const pattern = name.split(/\s+/).map(escapeRegExp).join('\\s+');
    if (new RegExp(`\\b${pattern}\\b`, 'i').test(q)) return true;
  }
  return false;
}

export function detectAnalyticsPlan(question, tenantVocab) {
  try {
    const q = String(question ?? '').trim();
    if (!q) return null;
    if (tenantVocab && questionNamesKnownCustomer(q, tenantVocab)) return null;
    // R18 (H1): checked BEFORE the generic SELF_DUPLICATE_RE decline just below — see
    // detectDuplicateCondition's own doc comment for why this specific family can now be answered.
    const dup = detectDuplicateCondition(q);
    if (dup) return dup;
    if (SELF_DUPLICATE_RE.test(q)) return null;
    if (CONTENT_SEARCH_DENY_RE.test(q)) return null;
    if (CONNECT_DENY_RE.test(q)) return null;
    if (ZERO_LINKED_EVENTS_RE.test(q)) return null;
    if (FOLLOW_UP_FRAGMENT_RE.test(q)) return null;
    // "no readable text extracted" — see READABLE_TEXT_DENY_RE's own doc
    // comment. Denied at the TOP level (not just inside
    // detectMissingFieldCondition) so a miss here never falls through to the
    // generic bare-quantifier path below and answers a bare, unfiltered
    // "how many documents" instead — a confident wrong answer, the one
    // outcome this whole file exists to avoid.
    if (READABLE_TEXT_DENY_RE.test(q)) return null;

    // ---- dedicated shapes, most specific first --------------------------
    const missingField = detectMissingFieldCondition(q);
    if (missingField) return missingField;
    const lockedDocType = detectLockedIntoDocType(q);
    if (lockedDocType) return lockedDocType;

    // R18 P4 (multi-hop AND-drop): mergeDetectedConditions is ONLY applied to the two cross-doc
    // customer detectors (hasDocType/hasServiceType) below, whose whole job is "count customers with
    // THIS condition" and so are exactly the shape a second, brand/geo/contact-info condition rides
    // along with unnoticed (h090, h099-h105) — every OTHER dedicated detector (groupBy, distinct-count,
    // technician, install-date ranking, brand comparison) has its own complete, self-contained filter
    // semantics, and merging arbitrary safety-net filters into those risks a false "unresolved" bail
    // the moment the question merely mentions a safety-net keyword (county/zip/city/state) with no
    // extractable value of its own — e.g. "customers by county" (a groupBy, no county NAMED) or "how
    // many different zip codes do we cover" (a distinct-count, no zip NAMED) used to come back null
    // because buildConditionOverrideFilter('zip'|'county', ...) has nothing to build and reports
    // unresolved. Keep those detectors' results exactly as they build them.
    const crossDocDedicated = detectCustomersHasDocType(q) ?? detectCustomersHasServiceType(q);
    if (crossDocDedicated) return mergeDetectedConditions(crossDocDedicated, q);

    const dedicated =
      detectWarrantyExpiryWindow(q) ??
      detectDistinctYearsCount(q) ??
      detectTechnicianAction(q) ??
      detectTechnicianGroupBy(q) ??
      detectInstallDateExtreme(q) ??
      detectDistinctDimensionCount(q) ??
      detectBrandComparison(q) ??
      detectGroupByPhrase(q);
    if (dedicated) return dedicated;

    // ---- generic entity/op/filter path -----------------------------------
    let entity = entityFromNouns(q);
    const op = opFromShape(q);
    const { filters, unresolved } = buildSafetyNetFilters(q, entity);
    if (unresolved) return null;

    // R18 P4 (C2, multi-hop AND-drop): captured BEFORE the entity is possibly forced to
    // 'customers' just below, and used for every equipment-level condition after that point —
    // "how many trane units in mesa are still under warranty" (h091) used to force entity to
    // 'customers' (for the geo join) and then check `entity === 'equipment'` for the
    // installYear/warrantyStatus/refrigerant conditions right after, so none of them were ever
    // applied once the geo filter was present — the SAME "warrantyStatus" the question plainly
    // named silently vanished. queryCustomersByEquipmentFilter (routes/analytics.js) already joins
    // in every one of these equipment-level filters when they ride along with a customers-entity
    // plan, so building them is always safe regardless of which entity ends up on the final plan.
    const equipmentLike = entity === 'equipment' || entity === 'warranties';
    // impliedWarrantyStatus's own "relaxed" fallback (no literal "warrant" word at all — "units
    // expiring soon") is only meaningful for the unit's OWN entity, never the customers entity a
    // geo join may force `entity` to just below — captured here, before that reassignment.
    const warrantyStatusEntity = entity;

    // Equipment/warranties rows carry NO address of their own in this corpus
    // (only the CUSTOMER row does) — a geo filter (city/county/state/zip) can
    // only ever be resolved by joining back to the customer, so force the
    // entity to 'customers' whenever one is present; queryCustomersByEquipmentFilter
    // (routes/analytics.js) already joins in any equipment-level filters
    // (brand/warrantyStatus/installYear/...) that ride along with it.
    if (
      equipmentLike &&
      filters.some((f) => f.field === 'city' || f.field === 'county' || f.field === 'state' || f.field === 'zip')
    ) {
      entity = 'customers';
    }

    if (entity === 'documents') {
      const m = DOC_TYPE_WORD_RE.exec(q);
      if (m) {
        const docType = docTypeFromWord(m[1]);
        if (docType) filters.push({ field: 'documentType', op: 'eq', value: docType });
      }
    }

    // "how many Trane installs have we done SINCE 2020" — a literal 4-digit
    // year named on an equipment/install question means the INSTALL year cutoff,
    // never a document/visit created_at range (equipment has no created_at
    // concept in this domain) — resolveAgeFilter (analytics.js) only ever
    // parses "older/newer than N years", never a literal calendar year, so
    // this is this file's own job to build.
    if (equipmentLike && !filters.some((f) => f.field === 'installYear')) {
      const sm = SINCE_YEAR_RE.exec(q);
      if (sm) filters.push({ field: 'installYear', op: 'gte', value: Number(sm[1]) });
    }

    if (entity === 'customers' && NO_CONTACT_INFO_RE.test(q)) {
      if (!filters.some((f) => f.field === 'hasEmail')) filters.push({ field: 'hasEmail', op: 'eq', value: false });
      if (!filters.some((f) => f.field === 'hasPhone')) filters.push({ field: 'hasPhone', op: 'eq', value: false });
    }

    // warrantyStatus (equipment/warranties only — analytics.js's
    // detectedConditions/buildConditionOverrideFilter('warranty', ...) already
    // covers this via the safety-net loop above for ANY entity, but harmless
    // to be explicit and it saves a round trip through missingConditions for
    // the common "how many units are out of warranty" shape.
    if (equipmentLike && !filters.some((f) => f.field === 'warrantyStatus')) {
      const status = impliedWarrantyStatus(q, warrantyStatusEntity);
      if (status === WARRANTY_STATUS_AMBIGUOUS) return null; // never guess which bucket a negation meant
      if (status) filters.push({ field: 'warrantyStatus', op: 'eq', value: status });
    }

    // Refrigerant: named right in the question ("runs on R-22") but NOT one
    // of the safety-net conditions (CONDITION_PLAN_FIELD, analytics.js, has
    // no entry for it) — unlike those, a refrigerant mention this file fails
    // to turn into a filter is never silently dropped: better to fall
    // through to the model than confidently count every unit when the
    // question named one specific refrigerant.
    if (equipmentLike && detectRefrigerantMention(q)) {
      const rf = buildRefrigerantFilter(q);
      if (!rf) return null;
      if (!filters.some((f) => f.field === 'refrigerant')) filters.push(rf);
    }

    // A bare noun phrase with NOTHING recognized at all (no filter, no
    // "how many"/list-verb/existence quantifier) is too weak a signal to
    // trust — e.g. a stray "customers" mention inside a sentence this file
    // misparsed. isExistenceQuestion (analytics.js) is the same "do/does/is/
    // are/did/have/has we/there/you/our shop" shape preClassifyAnalytics's
    // own WE_YES_NO_RE and applyExistenceShape already treat as a real
    // quantifier ("do we have any Ruud units", "did we do any service calls
    // last month").
    const hasQuantifier = HOW_MANY_RE.test(q) || LIST_VERB_RE.test(q) || isExistenceQuestion(q);
    if (!filters.length && !hasQuantifier) return null;

    return { entity, op, filters };
  } catch {
    return null;
  }
}
