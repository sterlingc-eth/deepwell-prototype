/**
 * Donovan analytics: aggregate/counting/grouping questions that today have no
 * path in /api/ask ("how many customers in Arizona", "how many in Maricopa
 * County", "list customers in Gilbert", "which customers have Trane units").
 * See handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md and
 * handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md.
 *
 * Everything in THIS file is pure (no `db`, no Anthropic client, no I/O) so
 * it is directly testable with no database or network — see
 * scripts/verify-analytics.mjs. api/_lib/routes/analytics.js does the actual
 * Haiku call and the database reads, and calls back into the builders here.
 *
 * THE ONE RULE THAT MATTERS (same rule fastPath.js states for itself): the
 * model NEVER writes SQL and never freely answers. It fills one strict,
 * closed-vocabulary JSON plan (tool use); everything after that — which
 * columns are read, how they're filtered, how the answer is worded — is code,
 * not the model. `validatePlan` rejects anything the model returns that
 * doesn't fit the vocabulary below, and a rejected plan means the whole
 * question falls through to the existing retrieval+model pipeline, exactly
 * like a fast-path miss does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveCity } from './routes/customers.js';
import { alertTier, normalizeBrand } from './warrantyRules.js';
import { DOCUMENT_TYPE_IDS, docTypeFromWord, docTypeSynonymAlternation, documentTypeLabel } from './documentTypes.js';

// Plain readFileSync + JSON.parse rather than an import attribute (`with {
// type: 'json' }`) — same idiom claude.js already uses for .env.local, and it
// avoids depending on every downstream bundler/typechecker (Vercel, tsc,
// tsx-run verify scripts) supporting import-attribute syntax for a file that
// only ever needs to be read once, synchronously, at module load.
const __dirname = dirname(fileURLToPath(import.meta.url));
const zipCounty = JSON.parse(readFileSync(join(__dirname, 'geo', 'zip-county.json'), 'utf8'));

/** Brand/county name tables, moved above the classifier (they used to live
 *  down in the "honest fallback" section, below preClassifyAnalytics) so the
 *  classifier's own GEO_WORD_RE/BRAND_RE (see WE_YES_NO_RE's doc comment)
 *  can be built from them at module load without a temporal-dead-zone
 *  ordering problem — both are still exported/used exactly as before by
 *  detectedConditions further down. */
const BRAND_WORDS = ['trane', 'carrier', 'goodman', 'lennox', 'rheem', 'york', 'daikin', 'mitsubishi'];
const KNOWN_COUNTY_NAMES = [
  ...new Set(
    [...Object.values(zipCounty.azZip3Default), ...Object.values(zipCounty.azZipExceptions)]
      .filter(Boolean)
      .map((c) => String(c).toLowerCase())
  ),
];
// Exported (item 1, 2026-09-22): docLookup.js's own "must not hijack a
// geo-scoped analytics question" guard (e.g. "list invoices for Gilbert")
// reuses this SAME city-name vocabulary rather than hand-duplicating it.
export const KNOWN_AZ_CITY_NAMES = Object.keys(zipCounty.azCityCounty ?? {});
// HVAC persona bank (2026-09-21): "Who are our customers in Las Vegas?" —
// this corpus's own header names Phoenix/Tucson AND Nevada dispatchers, but
// GEO_WORD_RE (below) only ever knew AZ city names, missing every NV one
// (usCityCounty's keys are "city|state" — nlNormalize.js's own VOCAB builder
// already reads this same map for typo-correction; this is the
// classification side of the same data).
export const KNOWN_US_CITY_NAMES = Object.keys(zipCounty.usCityCounty ?? {}).map((k) => k.split('|')[0]);

/* ============================================================ plan vocabulary */

export const ENTITIES = ['customers', 'equipment', 'documents', 'serviceVisits', 'warranties'];
export const OPS = ['count', 'list', 'groupBy', 'sum'];
export const GROUP_BY_FIELDS = ['city', 'county', 'state', 'zip', 'brand', 'documentType', 'month', 'technician', 'warrantyStatus'];
/** Closed field vocabulary a filter's `field` must be one of — see the brief. */
export const FILTER_FIELDS = [
  'state', 'county', 'city', 'zip', 'brand', 'model', 'equipmentType', 'tonnage',
  'refrigerant', 'installYear', 'warrantyStatus', 'documentType', 'technician', 'customerName',
  'hasEmail', 'hasPhone', 'hasDocType', 'lacksDocType',
];
/** hasEmail/hasPhone (item 2, 2026-09-21 live miss): "how many customers have
 *  an email on file" returned the plain customer count — there was no filter
 *  field for "has contact info" at all, so the model's plan silently dropped
 *  the condition. Boolean-only (true/false), customers-only — see
 *  buildAnalyticsSQL/matchesFilter below for the two places that read them. */
export const BOOLEAN_FILTER_FIELDS = ['hasEmail', 'hasPhone'];
/** hasDocType/lacksDocType (100-question persona sample, 2026-09-22, item 7
 *  "customers with a maintenance agreement but no invoice"): customers-only,
 *  value a canonical DOCUMENT_TYPE_IDS string, op 'eq' only — see
 *  parseCrossDocCondition/validatePlan below and routes/analytics.js's
 *  queryCustomersByDocTypeCondition. The model never fills these itself
 *  today (no few-shot teaches it to); parseCrossDocCondition builds the plan
 *  deterministically instead, the same "code decides, not the model" rule
 *  resolveServiceVisitsOverride already follows for entity/op. Listed here
 *  anyway (rather than validated ad hoc) so the closed-vocabulary contract —
 *  "the model never contributes anything outside FILTER_FIELDS" — still
 *  holds for a plan built by this file's own code, not just the model's.*/
export const DOC_TYPE_FILTER_FIELDS = ['hasDocType', 'lacksDocType'];
export const FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in'];
export const WARRANTY_STATUSES = ['active', 'expiring', 'expired', 'unknown'];
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 500;
/** "who's our biggest customer" (round 4, item 1) — customers RANKED by a
 *  size measure, not filtered/counted. Only meaningful for entity
 *  'customers' + op 'list'; see queryTopCustomers, routes/analytics.js. */
export const SORT_FIELDS = ['equipmentCount', 'documentCount'];
export const TOP_CUSTOMERS_LIMIT = 10;

/* ================================================================ classifier
 *
 * Cheap, deterministic pre-check — regex only, no model call — that decides
 * whether a question is WORTH spending the one Haiku call on. False positives
 * here cost one wasted (cheap, cached-schema) model call that then gets
 * rejected by validatePlan and falls through; false negatives cost nothing
 * (the question just goes to retrieval, same as today). So this errs toward
 * catching real aggregate questions and explicitly excludes phrasings that
 * belong to a SINGLE record (already fastPath's or retrieval's job) — see
 * EXCLUDE below, which mirrors ask.js's own comment about "how many documents
 * does Plaza Dental have" needing retrieval, not a meta/aggregate answer.
 */
/**
 * Reviewer NO-GO (2026-09-21, round 4, item 1): "how many clients do we
 * have" answered "Nothing in your records answers that" — a plain-English
 * owner phrasing that never reaches a document at all, so retrieval had
 * nothing to cite. Two separate gaps caused it: (1) "clients" WAS already
 * accepted, but a bare "do we have" question names no location/time/brand
 * word, and CONTEXT (below, since removed as a gate — see
 * preClassifyAnalytics's own doc comment) required one; (2) most of the
 * plain-English synonyms an owner actually says out loud ("accounts",
 * "homeowners", "properties", "jobs", "rooftop units", "paperwork", ...)
 * were never in the noun list at all.
 *
 * ONE table, used by BOTH consumers: this classifier's AGGREGATE_NOUN regex,
 * and the planner's ANALYTICS_SYSTEM_PROMPT (buildEntitySynonymPromptLine,
 * below) — so a synonym added here is recognized by both without hand-
 * duplicating the list into the prompt text. Keys are the canonical
 * ENTITIES/groupBy-dimension names; `technicians` is not itself a plan
 * entity (there's no "how many technicians" op) but feeds GROUP_SHAPE_RE's
 * "by tech/by crew" dimension-word recognition below.
 */
export const ENTITY_SYNONYMS = {
  customers: [
    'customer', 'customers', 'client', 'clients', 'account', 'accounts',
    'homeowner', 'homeowners', 'household', 'households', 'property', 'properties',
    'site', 'sites', 'house', 'houses', 'business', 'businesses', 'people we service',
  ],
  equipment: [
    'equipment', 'unit', 'units', 'system', 'systems', 'ac', 'acs', 'air conditioner', 'air conditioners',
    'furnace', 'furnaces', 'heat pump', 'heat pumps', 'condenser', 'condensers', 'rtu', 'rtus',
    'rooftop unit', 'rooftop units', 'piece of equipment', 'pieces of equipment',
    // HVAC persona bank (2026-09-21, hvac-personas.mjs): "how many Trane
    // installs have we done since 2020" — "install"/"installs" is a plain,
    // common owner synonym for "installed unit", same shape as "unit"/
    // "system" above, not a new noun category.
    'install', 'installs',
  ],
  documents: [
    'document', 'documents', 'doc', 'docs', 'file', 'files', 'paperwork', 'record', 'records',
    'invoice', 'invoices', 'ticket', 'tickets', 'work order', 'work orders',
    // Day 1 training-plan question bank (2026-09-21, gen-question-bank.mjs)
    // measured a real classifier gap here: "how many permits do we have" /
    // "how many proposal quotes are there" / etc. never matched AGGREGATE_NOUN
    // at all — these are just more of the same per-document-type nouns as
    // "invoice"/"ticket"/"work order" above, not a new shape.
    'permit', 'permits', 'quote', 'quotes', 'proposal', 'proposals', 'agreement', 'agreements',
    'photo', 'photos', 'correspondence', 'startup sheet', 'startup sheets',
    'dispatch note', 'dispatch notes', 'inspection report', 'inspection reports',
    'purchase order', 'purchase orders',
    // HVAC persona bank: "how many maintenance plans do we have running" —
    // the owner's own name for a maintenance-agreement document.
    'maintenance plan', 'maintenance plans',
  ],
  serviceVisits: [
    'service visit', 'service visits', 'job', 'jobs', 'visit', 'visits', 'call', 'calls',
    'service call', 'service calls', 'ticket', 'tickets',
  ],
  warranties: ['warranty', 'warranties'],
  technicians: ['technician', 'technicians', 'tech', 'techs', 'guy', 'guys', 'crew'],
};

/** Longest phrase first, so a multi-word synonym ("rooftop units") matches
 *  before a shorter one that happens to be its own suffix ("units") could —
 *  harmless for `test()` (order never changes whether SOME alternative
 *  matches) but keeps the built pattern readable/debuggable in that order. */
function synonymAlternation(words) {
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

/**
 * Tier 2 "Donovan learns nightly" (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md),
 * Part A: every regex below that is built FROM ENTITY_SYNONYMS is produced by
 * this one factory, so a runtime-learned overlay (a newly-approved synonym
 * word for an existing entity) can rebuild exactly the same regexes from a
 * WIDENED synonym table with no risk of the two ever drifting apart. Called
 * once at module load with the base ENTITY_SYNONYMS (BASE_CLASSIFIER_REGEXES,
 * below — every existing top-level const just aliases a field of it, so
 * nothing downstream changes), and again, on demand, by withLearnedOverlay
 * for a specific overlay object.
 */
function buildClassifierRegexes(entitySynonyms) {
  const aggregateNoun = new RegExp(
    `\\b(${synonymAlternation([
      ...entitySynonyms.customers,
      ...entitySynonyms.equipment,
      ...entitySynonyms.documents,
      ...entitySynonyms.serviceVisits,
      ...entitySynonyms.warranties,
    ])})\\b`,
    'i'
  );
  const groupShape = new RegExp(
    `\\b(group(?:ed)?\\b[\\s\\S]*\\bby\\b|breakdown\\b[\\s\\S]*\\bby\\b|\\bby\\b\\s+(city|county|state|zip|brand|month|warranty status|${synonymAlternation(entitySynonyms.technicians)})\\b)`,
    'i'
  );
  const customersWhose = new RegExp(`\\b(${synonymAlternation(entitySynonyms.customers)})\\s+whose\\b`, 'i');
  const biggestCustomer = new RegExp(`\\b(biggest|largest|top)\\s+(\\d+\\s+)?(${synonymAlternation(entitySynonyms.customers)})\\b`, 'i');
  const weYesNoNoun = new RegExp(
    `\\b(${synonymAlternation([
      ...entitySynonyms.customers,
      ...entitySynonyms.equipment,
      ...entitySynonyms.documents,
      ...entitySynonyms.serviceVisits.filter((w) => w !== 'call' && w !== 'calls'),
      ...entitySynonyms.warranties,
    ])})\\b`,
    'i'
  );
  const pluralEntityWords = [
    ...new Set([
      ...entitySynonyms.customers, ...entitySynonyms.equipment,
      ...entitySynonyms.documents, ...entitySynonyms.serviceVisits,
      ...entitySynonyms.warranties,
    ]),
  ].filter((w) => /s$/i.test(w) || w === 'equipment');
  const whatPlural = new RegExp(`\\bwhat\\s+(${synonymAlternation(pluralEntityWords)})\\b`, 'i');
  const whatDidWe = new RegExp(
    `\\bwhat\\s+(${synonymAlternation(pluralEntityWords)})\\b[\\s\\S]{0,40}\\bdid we\\b|\\bwhat\\s+did we\\s+(service|install|repair|replace|fix|visit)\\b`,
    'i'
  );
  return { aggregateNoun, groupShape, customersWhose, biggestCustomer, weYesNoNoun, pluralEntityWords, whatPlural, whatDidWe };
}

const BASE_CLASSIFIER_REGEXES = buildClassifierRegexes(ENTITY_SYNONYMS);
const AGGREGATE_NOUN = BASE_CLASSIFIER_REGEXES.aggregateNoun;
const QUANTIFIER = /\b(how many|count|list|which|show me|total)\b/i;
// "group X by Y" / "breakdown by Y" / "grouped by Y" — an aggregate-request
// shape regardless of which noun is being broken down, so a groupBy
// dimension word alone (technician, brand, month) is enough even without one
// of AGGREGATE_NOUN's fixed nouns ("show me a breakdown by technician").
// Read as cr.groupShape (preClassifyAnalytics, below) — never through a
// top-level alias, since it must reflect whatever overlay is active for a
// given call (withLearnedOverlay).
const WHO_SERVICED_RE = /\bwho did we (service|work for)\b/i;
const WHICH_CUSTOMERS_RE = /\bwhich customers\b/i;
// HVAC persona bank (2026-09-21): "Customers whose warranty expires in the
// next 90 days?" — the same "a customer-noun filtered by a relative clause"
// shape WHICH_CUSTOMERS_RE already bypasses QUANTIFIER for, just opening
// with the bare noun ("Customers whose...") instead of "which customers".
// Built from the same customer synonym list so it matches as readily as
// "clients whose"/"accounts whose". Read as cr.customersWhose, same reason
// as GROUP_SHAPE_RE above.
// "who's/who is our biggest client" / "top 10 customers" / "our largest
// accounts" — asks for customers RANKED by some size measure (equipment or
// document count), not filtered/counted — a distinct op from every other
// bypass trigger (see routes/analytics.js's queryTopCustomers). Built from
// the SAME customer synonym list, so "biggest account"/"largest client"
// match exactly as readily as "biggest customer". Read as cr.biggestCustomer.
/**
 * Reviewer NO-GO (2026-09-21, round 2, gap 1): "who has Trane units" and
 * "customers with expired warranties" / "units older than 10 years" named a
 * real aggregate question but matched none of the bypass triggers above and
 * failed the generic QUANTIFIER check (no how-many/count/list/which/show-me/
 * total word present at all) — so they fell through to retrieval and got a
 * partial, unfiltered model answer instead of a real analytics one. These
 * three triggers bypass QUANTIFIER the same way WHICH_CUSTOMERS_RE already
 * does, for the same reason: the SHAPE of the sentence already says "many",
 * regardless of which specific quantifier word (if any) it used.
 */
const WHO_HAS_RE = /\bwho (?:has|have)\b/i;
/** "customers with X" / "units that have X" / "equipment who have X" — a
 *  noun followed by a possessive-filter preposition, never a single named
 *  record's own question (that's POSSESSIVE_SINGLE_RE's "does/did X have"
 *  shape, checked first and unaffected by this). */
const NOUN_WITH_RE = /\b(customers?|clients?|units?|equipment)\s+(with|that have|which have|who have|having)\b/i;
/** "units older than N years" / "installed before/after 2020" — an age/date
 *  filter shape on its own aggregate noun, with no quantifier word needed. */
const AGE_FILTER_RE = /\b(older than|newer than|installed (?:before|after|in))\b/i;
// HVAC persona bank (2026-09-21): "What's the oldest unit we're still
// servicing?" — a superlative-ranked ask on its own aggregate noun, the same
// "no quantifier word needed" shape AGE_FILTER_RE/BIGGEST_CUSTOMER_RE already
// bypass QUANTIFIER for; this covers oldest/newest/latest/earliest, which
// BIGGEST_CUSTOMER_RE's own biggest/largest/top list doesn't.
const SUPERLATIVE_RE = /\b(oldest|newest|latest|earliest)\b/i;
/**
 * Item 2 (2026-09-21 live miss): "customers missing a phone number" is a real
 * aggregate/filter question (the hasEmail/hasPhone shape below) but names no
 * QUANTIFIER word ("how many customers have an email on file" already passes
 * via QUANTIFIER + AGGREGATE_NOUN alone, same as any other filtered count) —
 * only the QUANTIFIER-less phrasings need this bypass, mirroring AGE_FILTER_RE
 * just above. Paired with AGGREGATE_NOUN the same way AGE_FILTER_RE is.
 */
const CONTACT_FILTER_RE = /\b(have|has|with|no|missing|without)\s+(an?\s+)?(email|phone)\b/i;

/**
 * HVAC persona bank (2026-09-21): a whole cluster of real yes/no owner
 * questions — "Do we have any commercial accounts?", "Do we have any
 * Goodman customers in Tucson?", "Have we ever installed a Daikin?", "Do we
 * service anything in Nevada?" — name no QUANTIFIER word at all and often no
 * fixed AGGREGATE_NOUN word either (a bare brand or state name is the only
 * noun present). The subject here is always the generic "we" — never a named
 * customer record, which POSSESSIVE_SINGLE_RE already excludes via its own
 * we/you/they/company/shop negative lookahead — so a "do/does/have/has we"
 * yes/no shape is safe to trust broadly once paired with SOME domain signal
 * (an entity noun, a known brand, a known AZ/NV city/county/state name, or a
 * bare zip-code mention). Deliberately excludes "did we" (the money live-miss
 * cluster's own "did we invoice/bill last month" phrasings must stay OFF
 * analytics and reach the money gate instead — see isMoneyQuestion, which is
 * checked before this classifier ever runs in api/ask.js).
 */
// HVAC persona bank (2026-09-21): "Do we have more invoices or more service
// tickets on file?" -> gen-question-bank.mjs's own voice-style transform
// rewrites "do we have" to "we got" ("we got more invoices or more service
// tickets on file"), the same plain dispatcher phrasing toVoiceStyle already
// applies everywhere else in this bank — "we got" added as its own
// alternative rather than widening the "do/does/have/has we" shape itself.
const WE_YES_NO_RE = /\b(?:do|does|have|has)\s+we\b|\bwe\s+got\b/i;
/** Same noun list AGGREGATE_NOUN uses, minus the bare 'call'/'calls' words —
 *  those two, alone, collide with an ordinary "...so I can call them" /
 *  "before end of day" callback-pleasantry tail (a sloppiness variant this
 *  bank generates, and plausible real dispatcher chatter too) which has
 *  nothing to do with a service call. "service call(s)" itself is unaffected
 *  (still present via ENTITY_SYNONYMS.serviceVisits' own two-word phrases).
 *  Read as cr.weYesNoNoun (preClassifyAnalytics, below), same reason as
 *  GROUP_SHAPE_RE's own comment above. */
const BRAND_RE = new RegExp(`\\b(${synonymAlternation(BRAND_WORDS)})\\b`, 'i');
const GEO_WORD_RE = new RegExp(
  `\\b(arizona|nevada|az|nv|${synonymAlternation(KNOWN_AZ_CITY_NAMES)}|${synonymAlternation(KNOWN_US_CITY_NAMES)}|${synonymAlternation(KNOWN_COUNTY_NAMES)})\\b`,
  'i'
);
const ZIP_CODE_WORD_RE = /\bzip\s*codes?\b/i;
// HVAC persona bank (2026-09-21): "customers in 85201" — a bare 5-digit ZIP
// value with no word "zip" at all, the same geo-filter shape GEO_WORD_RE
// already covers for a city/county name. Safe to combine with AGGREGATE_NOUN
// the same way GEO_WORD_RE is: a genuine single-record reference (a street
// address, an "at 123 Main St, 85201" full address, a serial number that
// happens to be 5 digits) is caught by looksLikeSingleRecordReference
// upstream and short-circuits preClassifyAnalytics before this ever runs.
const ZIP_VALUE_RE = /\b\d{5}\b/;

/**
 * "Which brand do we have the most of?" / "Who did the most jobs in August?"
 * — a ranking-by-count question, the same "SHAPE already says many" idea
 * BIGGEST_CUSTOMER_RE/WHO_SERVICED_RE already bypass QUANTIFIER for, just for
 * a non-customer entity (brand, technician) BIGGEST_CUSTOMER_RE's own
 * customer-only synonym list doesn't cover. Stands alone (no AGGREGATE_NOUN
 * required) the same way those two do — "the most" is on its own a strong
 * enough ranking signal in this domain, and any single-record phrasing that
 * happened to also say "the most" would already have been excluded above by
 * looksLikeSingleRecordReference (an address/serial/named-record question).
 */
const THE_MOST_RE = /\bthe\s+most\b/i;
/** "Who's due for fall maintenance?" — no aggregate noun at all ("fall
 *  maintenance" names neither a customer/equipment/document synonym), but
 *  "who's/who is/who needs due" is the same "which customers are overdue"
 *  aggregate ask in a different, equally common phrasing. */
// "whos due" (no apostrophe) is this bank's own voice-style transform of
// "who's due" (toVoiceStyle strips every apostrophe) — "whos" added as its
// own alternative alongside "who's" rather than making the apostrophe
// optional inside "who's", which would also start matching an unrelated
// "whose" ("customers whose warranty...", a different shape entirely).
const WHO_DUE_RE = /\bwho(?:'s|s\b|\s+is|\s+needs)\s+(?:due|overdue)\b/i;
/**
 * "Expired warranties -- what about just the Mesa ones?" / "Casa Grande
 * customers -- now just the ones with Goodman units" — a follow-up question
 * that narrows a PRIOR aggregate answer, phrased as a dash + "what about"/
 * "now" rather than repeating a quantifier word. Paired with AGGREGATE_NOUN
 * (never stands alone) since the dash-prefix shape alone isn't a strong
 * enough signal on its own.
 */
const FOLLOWUP_NARROW_RE = /--\s*(?:what about|now)\b/i;
/** "What zip codes do we serve?" / "How many different zip codes do we
 *  cover?" — zip/county/city/state are GROUP_BY_FIELDS dimension words, not
 *  entity nouns, so AGGREGATE_NOUN itself never covers them; this is the
 *  parallel noun list for exactly the "coverage" style questions that ask
 *  about the dimension itself ("what zip codes", "what counties") rather
 *  than a filtered count of customers/equipment/documents. */
const COVERAGE_NOUN_RE = /\b(zip\s*codes?|counties|cities|states)\b/i;

/**
 * Live miss (2026-09-21, "which units had service this month" cluster),
 * item 3: "what units were serviced this month" / "what equipment got
 * serviced this month" name no QUANTIFIER word at all ("which"/"how many"/
 * "list"/"show me"/"total") — plain English "what" is exactly as much a
 * quantifier as "which" is when it's immediately followed by a PLURAL entity
 * noun ("what units", "what customers") or when the question is a "what ...
 * did we" clause about US doing something to many ("what did we service in
 * September"). Bare "what" is ALSO how a genuine single-record lookup starts
 * ("what's the serial number at 1234 Elm St", "what's the phone number for
 * Sandra Wyckoff") — those never reach this far: looksLikeSingleRecordReference
 * is checked first and short-circuits preClassifyAnalytics entirely (see its
 * own doc comment), and a real single-record "what's ..." contraction never
 * matches "what\s+" in the first place (no space between "what" and "'s").
 * buildClassifierRegexes' own pluralEntityWords is every ENTITY_SYNONYMS word
 * that is actually plural (ends in "s"), plus "equipment" itself (a mass noun
 * with no distinct plural form) — never a bare singular ("what unit", "what
 * customer") on its own, which stays exactly as excludable as it already was.
 * Read as cr.whatPlural (preClassifyAnalytics, below) — never through a
 * top-level alias, same reason as GROUP_SHAPE_RE's own comment above.
 *
 * "what <plural entity noun> did we <verb>" (cr.whatDidWe) only — a bare
 * "what did we do for Ramirez" is a single customer's history and must stay
 * on retrieval.
 */

/** "how many documents does Plaza Dental have" / "does X have a warranty" —
 *  a single, named record's own attribute, not an aggregate across many. */
/**
 * Reviewer NO-GO (2026-09-21, round 4, item 1): "how many visits did we have
 * this week" (a real aggregate question, "we" as subject) matched this
 * regex's "did ... have" shape exactly like "does Henderson have a
 * warranty" (a real single-record one, a NAMED subject) and was wrongly
 * excluded. The negative lookahead excludes the common generic-subject
 * pronouns ("we"/"you"/"they"/"the company"/"the shop") right after
 * does/did — those are never a single customer RECORD, so "does/did <pronoun>
 * have" is never this pattern's intended shape; a genuinely named subject
 * ("Henderson", "the unit at 3247 Elm", "Plaza Dental") still matches.
 */
const POSSESSIVE_SINGLE_RE = /\b(does|did)\s+(?!we\b|you\b|they\b|the company\b|the shop\b)[\s\S]+\b(have|has|need)\b/i;

/**
 * Reviewer NO-GO (2026-09-21, A1): WHICH_CUSTOMERS_RE / WHO_SERVICED_RE /
 * GROUP_SHAPE_RE above return true WITHOUT the AGGREGATE_NOUN/CONTEXT check
 * the generic path uses — "Which customers are at 1234 Main St, Mesa AZ?"
 * matched WHICH_CUSTOMERS_RE and was pre-classified as analytics, which then
 * has no `field: "address"` in the closed vocabulary to filter on, so the
 * planner produced an unfiltered `list customers` plan that confidently
 * returned every customer. A question naming a SPECIFIC street address or a
 * serial/model-shaped token is asking about one record, never an aggregate —
 * exactly fastPath's own territory — so it is excluded here, BEFORE any of
 * the trigger regexes below get a chance to bypass the vocabulary check.
 * This is checked first and short-circuits every other rule, deliberately:
 * an address or identifier is a stronger, unambiguous signal than any
 * quantifier/aggregate-noun match could ever override.
 */
export const STREET_ADDRESS_RE =
  /\b\d{2,6}\s+[NSEW]?\.?\s*[A-Za-z0-9.' ]+\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court|cir|circle|hwy|pkwy|pl|ter)\b/i;
/**
 * Reviewer NO-GO (2026-09-21, round 3, item 3): round 2's WHO_HAS_RE bypass
 * ("who has Trane units") let "who has the unit at 1234 Main" through too —
 * STREET_ADDRESS_RE requires a recognized street-suffix word (st/ave/rd/...)
 * that "1234 Main" alone never supplies. "at <number> <word>" is a weaker but
 * still reliable single-record signal on its own — a real aggregate question
 * essentially never phrases itself "at 1234 Main" — so it is checked here too,
 * before WHO_HAS_RE (or any other trigger) gets a chance to fire. Known,
 * accepted trade-off: a question like "how many customers do we have at 3
 * locations" would also match this and get excluded; that is the same
 * "single-record signal outranks any aggregate signal" call
 * looksLikeSingleRecordReference already makes for STREET_ADDRESS_RE/serial
 * tokens, and false negatives here cost nothing (the question still reaches
 * retrieval, same as any other fast-path/analytics miss).
 */
export const AT_ADDRESS_RE = /\bat\s+\d{1,6}\s+\w/i;
/**
 * Reviewer NO-GO (2026-09-21, round 4, item 1): dropping CONTEXT as a
 * required gate (preClassifyAnalytics, below) opened one real regression —
 * "how many tons is the Whitmore unit" (an existing adversarial check, no
 * address, no digit token) would now pass QUANTIFIER + AGGREGATE_NOUN with
 * nothing left to exclude it. The one thing that DOES distinguish it from a
 * real aggregate question like "how many rooftop units" is the definite
 * article + capitalized proper noun: "the <Name> unit/system/..." names ONE
 * specific, already-identified record, the same shape fastPath itself
 * resolves ("the Whitmore unit", "the Ortega account"). Case-SENSITIVE on
 * purpose — a capital letter is the signal; "the rooftop units" (lowercase,
 * plural) never matches this.
 */
// HVAC persona bank (2026-09-21): "do we have a PO on file for the mercer
// job" / "is the isaacson unit still under warranty" / "startup sheet for the
// prentiss install" — real dispatcher phrasings of this exact shape, just
// never typed with a capital letter (a sloppy/voice/typo'd question is
// lowercase by construction). The capital-letter requirement above was a
// reasonable proxy when this rule was first written but is actually stricter
// than the signal it needs: "the <word> unit/job/account/..." naming ONE of
// this fixed, closed set of singular-record nouns is unambiguous regardless
// of case — a real aggregate question is never phrased "the X job" for any
// word X. Case-insensitive now; 'install'/'ticket'/'visit' added alongside
// the original noun set for the same "startup sheet for the X install"/
// "last service ticket for X" shapes.
// HVAC persona bank (2026-09-21): "What's the oldest unit we're still
// servicing?" fit this exact "the <word> unit" shape just as well as "the
// Thornton unit" does, wrongly flagging a genuine aggregate superlative ask
// as a single-record reference — "the X job" ISN'T always unambiguous, a
// superlative adjective in the X slot is the one case that names no specific
// record at all. Excluded via a negative lookahead (SUPERLATIVE_RE's own
// word list, plus the ranking adjectives BIGGEST_CUSTOMER_RE already
// recognizes) rather than narrowing the noun set, which still needs to catch
// every OTHER "the <real name> unit" phrasing untouched.
// Reviewer NO-GO (2026-09-22): a literal-word lookahead only ever excludes a
// CORRECTLY-SPELLED superlative — "what's the oewest unit we've installed"
// (a typo of "newest") still matched the broad "the <word> unit" shape,
// wrongly single-record-flagging it. Worse, this check runs on the
// ORIGINAL, uncorrected text (normalizeQuestion's own singleRecord guard, so
// nlNormalize's fuzzy corrector never even gets a chance to fix "oewest" to
// "newest" first — a typo that blocks its own fix from ever running, the
// same class of bug "mainttenance" was above. Fixed by splitting the check in
// two: SINGULAR_NAMED_RECORD_RE now just captures the adjective slot
// (group 1) with no exclusion built in, and hasSingularNamedRecord (below)
// rejects the match itself when that captured word is an EXACT OR
// near-typo (edit distance <= 1) match of a superlative/ranking word —
// covering "oewest"/"oldst"/every other single-edit misspelling of
// oldest/newest/latest/earliest/biggest/largest/smallest/most, not just the
// ones spelled correctly.
// Reviewer NO-GO (2026-09-22, follow-up): "Startup sheet for the Holbrook
// instbll?" — a typo of "install" ("instbll") isn't literally in the noun
// alternation, so the whole shape missed this single-record question.
// Tried a fully generic, fuzzy-matched noun slot first, but that reopened a
// worse hole: "instbll" earns its edit-distance-1 tolerance against
// "install", but so does the common PLURAL "customers" against the
// SINGULAR "customer" already in this list — and unlike "install", the
// singular/plural distinction here is load-bearing (an aggregate "group
// customers by county" must never single-record-match). Reverted to a
// literal alternation; "instbll" is added as its own named alternative
// instead, the same narrow, closed-list approach "mainttenance" above
// already uses for exactly this class of typo.
const SINGULAR_NAMED_RECORD_RE =
  /\bthe\s+([a-zA-Z][a-zA-Z']*)\s+(unit|system|account|job|customer|client|property|install|instbll|ticket|visit)\b/gi;
const SUPERLATIVE_WORDS = ['oldest', 'newest', 'latest', 'earliest', 'biggest', 'largest', 'smallest', 'most'];

/** Same Damerau-Levenshtein-<=1 idea nlNormalize.js's own withinEditDistance1
 *  and contactLookup.js's own copy of it already use — duplicated rather
 *  than imported (nlNormalize.js imports FROM this file, so the reverse
 *  import would be circular; see this file's own "must stay DB/model-free,
 *  duplicate the small stuff" convention elsewhere, e.g.
 *  TRAILING_NAME_STOPWORD_RE). Six lines of pure string math, not worth a
 *  shared module for. */
function isCloseTo(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffs = 0;
    let i1 = -1;
    let i2 = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffs++;
        if (diffs === 1) i1 = i;
        else if (diffs === 2) i2 = i;
        else return false;
      }
    }
    if (diffs <= 1) return true;
    return i2 === i1 + 1 && a[i1] === b[i2] && a[i2] === b[i1];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

function isSuperlativeWord(word) {
  const w = word.toLowerCase();
  return SUPERLATIVE_WORDS.some((sw) => isCloseTo(w, sw));
}

// Reviewer NO-GO (2026-09-22, follow-up 2): with the noun back to a literal
// alternation, a single question can still legitimately contain more than
// one "the <word> <noun>" occurrence (e.g. "the oldest unit" earlier in a
// sentence and "the Thornton job" later) — matchAll (global flag on the
// regex) checks every one for a superlative adjective rather than only the
// first, so an early false one can never mask a real match later in the
// same question.
function hasSingularNamedRecord(q) {
  for (const m of q.matchAll(SINGULAR_NAMED_RECORD_RE)) {
    if (!isSuperlativeWord(m[1])) return true;
  }
  return false;
}
/** An alnum token >= 8 chars with at least one digit — the same serial/model
 *  shape fastPath.js's own IDENTIFIER_RE looks for (see its file for why:
 *  that's the printed shape of a real HVAC serial/model number, and a bare
 *  4-digit year or short word never qualifies). Duplicated here rather than
 *  imported so this file has no dependency on fastPath.js's internals. */
const IDENTIFIER_TOKEN_RE = /\b[A-Za-z0-9][A-Za-z0-9-]{7,}\b/g;

function looksLikeIdentifierToken(question) {
  const tokens = String(question ?? '').match(IDENTIFIER_TOKEN_RE) ?? [];
  return tokens.some((tok) => /\d/.test(tok));
}

/** "for serial M100017" / "serial number Y100023" — a serial VALUE named
 *  right after the word "serial" is a single-record reference regardless of
 *  its own length (IDENTIFIER_TOKEN_RE's 8-char floor misses a short one like
 *  "M100017"'s 7 characters) — the word "serial" is itself the strong signal
 *  here, not the token shape. Excludes a bare "serial number(s)" with no
 *  value following (e.g. "what's the serial number of the unit at ...", "how
 *  many serial numbers do we have") so this never fires on a generic mention
 *  of the field name alone. */
const SERIAL_VALUE_RE = /\bserial\s*(?:number)?\s+(?!numbers?\b)[a-z0-9-]{3,}\b/i;

/** "at Thornton's" / "at Prentiss's" — a possessive name right after "at" is
 *  a single-record reference ("when were we last at Thornton's", "last 3
 *  visits at Prentiss's") the same way AT_ADDRESS_RE catches "at <number>
 *  <word>" — case-insensitive on purpose (see SINGULAR_NAMED_RECORD_RE's own
 *  doc comment for why case is not a reliable signal once sloppiness variants
 *  lowercase everything). */
const AT_POSSESSIVE_RE = /\bat\s+[a-z][a-z']*'s\b/i;

/** A small, fixed set of words that can never be the FIRST word of a real
 *  customer/company name — reused from contactLookup.js's own
 *  NAME_STOPWORD_RE list (kept as a separate, slightly larger copy here
 *  rather than an import, since this file must stay DB/model-free and
 *  contactLookup.js additionally touches `db`) plus the prepositions/
 *  quantifiers TRAILING_NAME_RE (below) actually needs to reject that
 *  contactLookup's own list never had to worry about ("in Mesa", "our Trane
 *  jobs", "last month's work"). */
const TRAILING_NAME_STOPWORD_RE =
  /^(?:the|a|an|this|that|these|those|our|their|his|her|my|your|its|which|who|what|how|does|do|did|is|are|list|show|has|have|in|on|at|of|for|with|without|and|or|no|not|any|some|all|last|next|first|second|third|most|many|few|several|day|days|today|week|weeks|month|months|year|years|end)$/i;

/** A captured "name" that is actually one of this domain's own nouns
 *  ("maintenance", "warranty", "service", "file", ...) is never a real
 *  customer name — guards the same trailing-preposition shape against a
 *  question like "which customers are overdue for maintenance" (a real
 *  aggregate ask, not "Maintenance" the customer). */
// "mainttenance" (a double-t typo this bank tests) needs its own alternative
// here rather than relying on nlNormalize.js's own fuzzy correction to fix it
// first: this check runs on the ORIGINAL, uncorrected text (see
// normalizeQuestion's own singleRecord guard, above), so a typo'd domain word
// that fails this match gets misread as a trailing NAME instead, which then
// blocks fuzzy correction for the whole question — a typo that stops its own
// fix from ever running.
const TRAILING_NAME_DOMAIN_WORD_RE =
  /\b(maintenance|mainttenance|warrant(?:y|ies)|service|services|tune-?up|checkup|agreement|agreements|invoice|invoices|quote|quotes|permit|permits|proposal|proposals|record|records|paperwork)\b/i;

/**
 * "List invoices for Fitzgerald" / "What was the last service ticket for
 * Bracken?" / "Show me all the invoices for Mercer" — a customer's SURNAME
 * (or short name) is the very last thing in the question, right after "for"/
 * "at", exactly the shape contactLookup.js's own CONNECTOR_NAME_RE
 * recognizes for a phone/email/address ask — this is the same shape for
 * every OTHER per-customer document/history question (invoices, tickets,
 * proposals, ...) that contactLookup.js has no field for and was never meant
 * to own. "of" is deliberately NOT one of the trigger prepositions here (it
 * is for contactLookup.js's own CONNECTOR_NAME_RE) — "of" introduces far more
 * generic English tails in this domain ("end of day", "breakdown of units")
 * than it ever introduces a trailing name. Capped at 1-2 words (a first+last
 * name at most) and anchored to the END of the string so a genuine aggregate
 * tail like "...on file for in Mesa" or "...owe us for last month's work"
 * (3+ words, or starting with a stopword) never matches — see
 * TRAILING_NAME_STOPWORD_RE/TRAILING_NAME_DOMAIN_WORD_RE above for the two
 * halves of that guard.
 */
const TRAILING_NAME_RE = /\b(?:for|at)\s+([a-zA-Z][a-zA-Z'.-]*(?:\s+[a-zA-Z][a-zA-Z'.-]*)?)\s*[?!.]*\s*$/;

// HVAC persona bank (2026-09-21): "List invoices for Fitzgerald so I can call
// them" / "...for Bracken for the file" / "...for Delgado, thanks" — a
// trailing-context sloppiness variant appends a pleasantry/purpose clause
// AFTER the real trailing name, which TRAILING_NAME_RE's own `$` anchor then
// never reaches (the name is no longer the last thing in the string) —
// wrongly falling through to a false-positive analytics classification
// instead ("list"+"invoices" alone satisfy QUANTIFIER+AGGREGATE_NOUN). The
// same closed, narrow chatter list contactLookup.js's own
// stripTrailingChatter already strips for exactly this reason — duplicated
// here rather than imported, same "this file must stay DB/model-free"
// reasoning TRAILING_NAME_STOPWORD_RE's own doc comment gives.
const TRAILING_CHATTER_RE =
  /,?\s*(?:so\s+i\s+can\s+[a-z]+(?:\s+[a-z]+){0,3}|for\s+the\s+(?:newsletter|file)|before\s+(?:end\s+of\s+day|eod)|thanks?|please)\s*$/i;

function stripTrailingChatterForNameCheck(q) {
  let out = q;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(TRAILING_CHATTER_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function hasTrailingNameReference(q) {
  const m = TRAILING_NAME_RE.exec(stripTrailingChatterForNameCheck(q));
  if (!m) return false;
  const namePhrase = m[1].trim();
  if (TRAILING_NAME_STOPWORD_RE.test(namePhrase.split(/\s+/)[0])) return false;
  return !TRAILING_NAME_DOMAIN_WORD_RE.test(namePhrase);
}

/**
 * "Did we send Isaacson a quote?" / "What proposal did we give Amy Isaacson?"
 * — a named customer as the OBJECT of "did/do/does we give/send/quote",
 * rather than the subject POSSESSIVE_SINGLE_RE already excludes.
 *
 * HVAC persona bank (2026-09-21): this used to require the captured object
 * word to be capitalized, the same trade-off SINGULAR_NAMED_RECORD_RE's own
 * case-sensitive era made — safe against "How many quotes did we send this
 * quarter?" (a real aggregate; "this"/"quarter" are always lowercase) but it
 * also silently failed every lowercase/typo/voice-style sloppiness variant of
 * the SAME lookup question ("did we send isaacson a quote"). Replaced with an
 * explicit stopword/aggregate-noun rejection instead — the same fix
 * TRAILING_NAME_STOPWORD_RE/AGGREGATE_NOUN already give hasTrailingNameReference
 * — which keeps the "this quarter" guard without needing case at all.
 */
const WE_ACTION_OBJECT_RE = /\b(?:did|do|does)\s+we\s+(?:ever\s+)?(?:give|send|quote)\s+(?:an?\s+)?([A-Za-z][a-zA-Z]*)/i;

function hasNamedActionObject(q) {
  const m = WE_ACTION_OBJECT_RE.exec(q);
  if (!m) return false;
  const word = m[1].toLowerCase();
  if (TRAILING_NAME_STOPWORD_RE.test(word)) return false;
  if (AGGREGATE_NOUN.test(word)) return false;
  return true;
}

/** True when the question names one specific record (a street address, an
 *  "at <number> <word>" reference, a serial/model-shaped token, a "does/did
 *  NAME have" possessive, a "the NAME unit/job/..." reference, a trailing
 *  "for/of/at NAME", or a named object of "did we give/send/quote NAME") —
 *  rather than asking about many. Exported so routes/analytics.js and
 *  scripts/verify-analytics.mjs can both exercise it directly. */
// Reviewer NO-GO (2026-09-22): duplicated from contactLookup.js's own
// STREET_ONLY_RE (same "this file must stay DB/model-free" reasoning
// TRAILING_NAME_STOPWORD_RE's own doc comment already gives — contactLookup.js
// touches `db`, so importing it here would pull that dependency in). Anchored
// the same way: "how many customers on Greenfield Rd" starts with "how
// many", never with "the guy .../customers? on|at", so it never matches here
// either and stays a normal analytics count.
const STREET_ONLY_RE =
  /^(?:the\s+(?:guy|lady|customer|account|people|folks)\s+(?:on|at|over on)|customers?\s+(?:on|at))\s+[a-zA-Z][a-zA-Z']*(?:\s+[a-zA-Z][a-zA-Z']*){0,2}\b/i;
// Same leading-noise words contactLookup.js's own UH_FILLER_RE/
// LEADING_QUANTIFIER_RE strip before trying its shapes — a sloppiness
// variant can stack "uh"/"list"/"pull up" in front of "the guy on
// Greenfield Road" the same way it does everywhere else in this bank, and
// STREET_ONLY_RE above is anchored at `^` so it never sees past them
// otherwise.
const UH_FILLER_STRIP_RE = /^(?:uh+|um+)\s+/i;
const LEADING_QUANTIFIER_STRIP_RE = /^(?:show me|pull up|list|need the)\s+/i;

function stripLeadingNoiseForStreetCheck(q) {
  let out = q;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(UH_FILLER_STRIP_RE, '').replace(LEADING_QUANTIFIER_STRIP_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export function looksLikeSingleRecordReference(question) {
  const q = String(question ?? '');
  return (
    STREET_ADDRESS_RE.test(q) ||
    AT_ADDRESS_RE.test(q) ||
    hasSingularNamedRecord(q) ||
    looksLikeIdentifierToken(q) ||
    SERIAL_VALUE_RE.test(q) ||
    AT_POSSESSIVE_RE.test(q) ||
    POSSESSIVE_SINGLE_RE.test(q) ||
    hasTrailingNameReference(q) ||
    hasNamedActionObject(q) ||
    STREET_ONLY_RE.test(stripLeadingNoiseForStreetCheck(q))
  );
}

/* ============================================================ learned overlay
 *
 * Tier 2 "Donovan learns nightly" (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md),
 * Part A — see nlNormalize.js's own copy of this same pattern for the fuller
 * rationale. No shared mutable overlay lives in this file: every caller
 * passes its own overlay object explicitly, and a WeakMap keyed on that
 * object's identity is the only "cache" involved, so two overlays (the
 * process-wide active one vs. a single candidate proposal being verified)
 * can never leak into each other regardless of call order.
 */
function isOverlayEmpty(overlay) {
  if (!overlay) return true;
  return !(overlay.synonyms && Object.keys(overlay.synonyms).length);
}

function mergedEntitySynonyms(overlay) {
  const merged = {};
  for (const [entity, words] of Object.entries(ENTITY_SYNONYMS)) merged[entity] = [...words];
  if (overlay?.synonyms) {
    for (const [entity, words] of Object.entries(overlay.synonyms)) {
      if (!merged[entity] || !Array.isArray(words)) continue;
      merged[entity] = [...new Set([...merged[entity], ...words.map((w) => String(w ?? '').toLowerCase())])];
    }
  }
  return merged;
}

const overlayClassifierCache = new WeakMap();

/** Calls `fn(classifierRegexes)` — the base, module-level regex bag when
 *  `overlay` is empty/absent (byte-for-byte the pre-overlay behavior), or a
 *  freshly-merged one (cached per overlay OBJECT identity) otherwise.
 *  Exported for scripts/verify-learning.mjs's overlay-purity checks. */
export function withLearnedOverlay(overlay, fn) {
  if (isOverlayEmpty(overlay)) return fn(BASE_CLASSIFIER_REGEXES);
  let cr = overlayClassifierCache.get(overlay);
  if (!cr) {
    cr = buildClassifierRegexes(mergedEntitySynonyms(overlay));
    overlayClassifierCache.set(overlay, cr);
  }
  return fn(cr);
}

/**
 * Reviewer NO-GO (2026-09-21, round 4, item 1): the generic path used to
 * require QUANTIFIER && AGGREGATE_NOUN && CONTEXT, where CONTEXT was a
 * location/time/brand word (a county, "this month", "brand", ...). That
 * gate is why "how many clients do we have" — the live owner question —
 * fell through to retrieval: it names no location/time/brand at all, only
 * the aggregate noun and the quantifier. Checked against every existing
 * verify case (adversarial included), the ONLY negative that actually
 * depended on CONTEXT for its exclusion was "how many tons is the Whitmore
 * unit", now independently caught by SINGULAR_NAMED_RECORD_RE above — every
 * other single-record negative was already excluded up front by
 * looksLikeSingleRecordReference or POSSESSIVE_SINGLE_RE. So CONTEXT is no
 * longer a required gate: QUANTIFIER + AGGREGATE_NOUN alone is enough once
 * the exclusions above have already run. A true false positive here (a
 * genuinely ambiguous "which one do you like" that happens to also contain
 * an aggregate noun) still costs nothing but one wasted, cheap planner call
 * that validatePlan/the executor then reject — the same trade-off this
 * file's own header comment has always accepted.
 */
/**
 * `opts.overlay` (Tier 2 learning, Part A): an optional runtime-learned
 * `{ synonyms: { <entity>: [words] } }` bag that widens the entity-noun
 * regexes above for this call only (see withLearnedOverlay below) — omitted,
 * null, or empty, this is byte-for-byte the same function as before overlays
 * existed. Every OTHER regex used here (WHO_HAS_RE, GEO_WORD_RE, BRAND_RE,
 * ...) is not synonym-driven and stays exactly as-is regardless of overlay.
 */
export function preClassifyAnalytics(question, opts = {}) {
  const overlay = opts?.overlay;
  const q = String(question ?? '').trim();
  if (!q) return false;
  // looksLikeSingleRecordReference now also covers POSSESSIVE_SINGLE_RE's own
  // "does/did NAME have" shape (see that function's own doc comment) — no
  // separate check needed here any more.
  if (looksLikeSingleRecordReference(q)) return false;
  return withLearnedOverlay(overlay, (cr) => {
    if (
      WHO_SERVICED_RE.test(q) ||
      WHICH_CUSTOMERS_RE.test(q) ||
      cr.customersWhose.test(q) ||
      cr.groupShape.test(q) ||
      WHO_HAS_RE.test(q) ||
      NOUN_WITH_RE.test(q) ||
      cr.biggestCustomer.test(q) ||
      cr.whatPlural.test(q) ||
      cr.whatDidWe.test(q) ||
      THE_MOST_RE.test(q) ||
      WHO_DUE_RE.test(q) ||
      (cr.aggregateNoun.test(q) && AGE_FILTER_RE.test(q)) ||
      (cr.aggregateNoun.test(q) && SUPERLATIVE_RE.test(q)) ||
      (cr.aggregateNoun.test(q) && CONTACT_FILTER_RE.test(q)) ||
      (cr.aggregateNoun.test(q) && FOLLOWUP_NARROW_RE.test(q)) ||
      // BRAND_RE deliberately excluded from this bare, no-quantifier combo —
      // unlike a city/zip (GEO_WORD_RE/ZIP_*, which only ever names a LOCATION,
      // never a single unit's own attribute), a brand name shows up just as
      // often inside a genuine single-record attribute question ("what is the
      // serial number on the Trane condenser") as it does in a real aggregate
      // one, and every real brand-aggregate case already reaches analytics via
      // QUANTIFIER+AGGREGATE_NOUN ("how many Trane units...") or WE_YES_NO_RE
      // ("do we have any Daikin customers...") below, both of which pair the
      // brand with an explicit count/existence question word first.
      (cr.aggregateNoun.test(q) && (GEO_WORD_RE.test(q) || ZIP_CODE_WORD_RE.test(q) || ZIP_VALUE_RE.test(q))) ||
      (WE_YES_NO_RE.test(q) && (cr.weYesNoNoun.test(q) || BRAND_RE.test(q) || GEO_WORD_RE.test(q) || ZIP_CODE_WORD_RE.test(q))) ||
      (QUANTIFIER.test(q) && COVERAGE_NOUN_RE.test(q)) ||
      (/\bwhat\b/i.test(q) && COVERAGE_NOUN_RE.test(q) && /\bdo we\b/i.test(q))
    ) {
      return true;
    }
    return QUANTIFIER.test(q) && cr.aggregateNoun.test(q);
  });
}

/**
 * Reviewer NO-GO (2026-09-21, A1b): defense-in-depth for the executor. Even
 * if the classifier above somehow lets a single-record question through (a
 * phrasing neither STREET_ADDRESS_RE nor an identifier token catches), an
 * unfiltered `list`/`count` plan over `customers` for a question that names
 * ANY number of 2+ digits (a street number, a ZIP, a customer number typo,
 * a serial fragment) is treated as a sign the question was actually about
 * something specific this plan lost — not a real "how many customers do we
 * have" question, which never contains a number at all. Pure, so this is
 * checked before the executor ever runs a query — see runAnalyticsQuestion
 * in routes/analytics.js.
 */
const TWO_OR_MORE_DIGITS_RE = /\d{2,}/;

export function suspiciousUnfilteredCustomerPlan(plan, question) {
  if (!plan || plan.entity !== 'customers') return false;
  if (plan.op !== 'list' && plan.op !== 'count') return false;
  if (Array.isArray(plan.filters) && plan.filters.length > 0) return false;
  return TWO_OR_MORE_DIGITS_RE.test(String(question ?? ''));
}

/* ============================================================ honest fallback
 *
 * Reviewer NO-GO (2026-09-21, round 5, item 3): a plan that silently DROPS a
 * condition the question actually named (the model has no filter for it, or
 * just forgot) still executes as an unfiltered query and answers confidently
 * — exactly item 2's original bug shape ("how many customers have an email
 * on file" -> the plain customer count), which the hasEmail/hasPhone filters
 * fixed for THAT one phrasing but not for the general case (a brand, a
 * county, a month the model dropped for some other reason). detectedConditions
 * is deliberately dumb and self-contained (word/known-name matching, nothing
 * from the classifier's own regexes) — a false positive here just means an
 * honest "can't filter by X yet" where a fuller plan would have worked, never
 * a wrong answer; see missingConditions/unsupportedConditionAnswer below for
 * how routes/analytics.js's runAnalyticsQuestion uses this.
 */
const CONTACT_WORD_RE = { email: /\bemail\b/i, phone: /\bphone\b/i };

/**
 * Live miss cluster 2 (2026-09-21 270-question sample): "What's the total
 * dollar amount of our open invoices?" / "how much did we invoice last
 * month" and friends returned a fabricated "$0.00 across N documents." —
 * there is no financials layer yet (handoffs/FINANCIALS_DESIGN_2026-09-21.md,
 * not built), so the `sum` op silently summed a non-numeric column (a
 * filename, a document id) down to 0 and printed it as though it were a real
 * total. Any question this matches must get the honest fallback below
 * instead of ever reaching the planner/executor — see api/ask.js's money
 * gate (checked BEFORE the Haiku planner call, so a money question never
 * spends a model call at all) and executeAnalyticsPlan's own sum-op guard
 * (routes/analytics.js) for the second line of defense. Deliberately broad
 * (a false positive here just means an honest "can't do that yet" where a
 * real analytics answer might have worked, never a wrong dollar figure).
 */
// Stemmed rather than a fixed "invoice"/"invoiced" pair — reviewer NO-GO
// (2026-09-21): "total invoiced this year" missed because the outer \b
// forced a word-boundary right after literal "invoice", which "invoiced"
// (word char 'd' next) never has. INVOICE_STEM covers invoice/invoiced/
// invoices/invoicing wherever this regex used to spell out only one form.
const INVOICE_STEM = 'invoic(?:e|ed|es|ing)';
// HVAC persona bank (2026-09-21) added three more real bookkeeper phrasings
// MONEY_RE was still missing:
//   - "total amount we've invoiced" — "total" and the invoice stem are both
//     present but in the OPPOSITE order/adjacency the two existing
//     "invoice-word total" patterns above require ("invoiced total"/"total
//     invoiced"); a bare "total amount" is just as much a money phrase on its
//     own in this domain and needs no invoice word next to it at all.
//   - "average ticket/invoice size/amount" — "what's our average ticket
//     size", "what's the average invoice amount for our Trane jobs".
//   - "what did we bill <customer>" — bare "bill" (not just "billed") as its
//     own verb, the same INVOICE_STEM-style gap "invoiced" once was.
// Live 100-question persona sample (2026-09-22): "total we've collected in
// maintenance agreement fees" / "what fees have we collected" / "have
// customers paid us" / "outstanding receivables" / "what's outstanding" all
// missed MONEY_RE — "collected"/"fees"/"paid us"/"receivables"/"outstanding"
// (bare, not just "outstanding balance") are just as much a no-financials-
// layer-yet money question as "billed"/"invoiced" already are.
const MONEY_RE = new RegExp(
  '\\b(revenue|' + INVOICE_STEM + '\\s+(?:total|amount)|' +
    'total\\s+(?:' + INVOICE_STEM + '|billed|dollar|amount|collected)|' +
    'average\\s+(?:ticket|' + INVOICE_STEM + ')\\s+(?:size|amount)|' +
    'how much (?:did we|have we|do we)\\s+(?:bill|' + INVOICE_STEM + '|charge|make|earn|spend|collect)|' +
    'what did we bill|' +
    'dollar amount|\\$\\s?\\d|\\bbill(?:ed)?\\b|owed|outstanding(?:\\s+balance)?|unpaid invoices?|by revenue|by sales|' +
    'spend(?:ing)?|collected|\\bfees?\\b|paid us|receivables?)\\b',
  'i'
);

export function isMoneyQuestion(question) {
  return MONEY_RE.test(String(question ?? ''));
}

/** The one honest answer every money question gets until the financials
 *  layer ships — no facts (there is no real number to show), not cached, no
 *  model call. Text is fixed on purpose so every money phrasing reads
 *  identically rather than each falling back through a different path with
 *  its own wording. */
export const MONEY_FALLBACK_TEXT =
  "I can't total invoice amounts yet — that's coming with the Financials update. I can count invoices and find a specific one if that helps.";

export function moneyFallbackAnswer() {
  return {
    kind: 'answer', text: MONEY_FALLBACK_TEXT,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

/**
 * Live miss cluster 3 (2026-09-21 270-question sample): "Which customers are
 * overdue for maintenance?" / "List customers due for a tune-up" matched the
 * classifier (WHICH_CUSTOMERS_RE / QUANTIFIER+AGGREGATE_NOUN) but named a
 * condition — "no service since" — that has no filter field anywhere in the
 * closed vocabulary (FILTER_FIELDS, analytics.js), so the model's plan came
 * back with zero filters and executed as a confident, unfiltered "49
 * customers." "Which customers have not had service in 12 months?" reads the
 * same way but happened to already fall through to retrieval honestly,
 * purely as a side effect of naming a 2+ digit number ("12") that trips
 * suspiciousUnfilteredCustomerPlan (below) — a coincidence, not a real fix.
 * This condition makes every phrasing of the same question honest the same
 * way: CONDITION_PLAN_FIELD has no entry for 'maintenance' (there is no such
 * plan field to ever satisfy it), so missingConditions() below always finds
 * it missing and runAnalyticsQuestion (routes/analytics.js) always returns
 * unsupportedConditionAnswer('maintenance', ...) instead of executing an
 * unfiltered query.
 */
// HVAC persona bank (2026-09-21): "Who's due for fall maintenance?" — a
// seasonal qualifier (fall/spring/annual/seasonal) between "due for" and the
// maintenance/tune-up word itself, which the original pattern's fixed
// "due for (?:a )" gap never allowed for.
const MAINTENANCE_DUE_RE =
  /\b(overdue for (?:a )?(?:maintenance|service)|due for (?:a )?(?:fall |spring |annual |seasonal )?(?:tune-?up|maintenance|service|checkup)|haven'?t been serviced|not had service|no (?:maintenance|service) in \d+\s*months?|needs?\s+(?:a )?service)\b/i;

/** A dumb, self-contained scan of the question TEXT for a handful of
 *  conditions a plan might drop: 'email'/'phone' (the hasEmail/hasPhone
 *  shape), 'brand' (a known manufacturer name), 'county' (the word "county"
 *  or a known AZ county name), 'month' (anything resolveQuestionTimeRange
 *  recognizes), 'money' (a dollar-total question with no financials layer to
 *  back it — see MONEY_RE), 'maintenance' (a "no service since" question with
 *  no such filter field — see MAINTENANCE_DUE_RE). Returns a Set; order is
 *  insertion order so a caller picking "the" missing condition when several
 *  are detected gets a stable, deterministic choice. */
export function detectedConditions(question) {
  const q = String(question ?? '').toLowerCase();
  const found = new Set();
  if (CONTACT_WORD_RE.email.test(q)) found.add('email');
  if (CONTACT_WORD_RE.phone.test(q)) found.add('phone');
  if (BRAND_WORDS.some((b) => new RegExp(`\\b${b}\\b`).test(q))) found.add('brand');
  if (/\bcounty\b/.test(q) || KNOWN_COUNTY_NAMES.some((c) => new RegExp(`\\b${c}\\b`).test(q))) found.add('county');
  // city/state/zip (item 4, 2026-09-22): the same "a known geo word is
  // present" signal GEO_WORD_RE/ZIP_VALUE_RE already use for classification,
  // reused here so missingConditions can flag a plan that dropped one.
  if ([...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES].some((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q))) {
    found.add('city');
  }
  if (/\barizona\b|\bnevada\b|\baz\b|\bnv\b/.test(q)) found.add('state');
  if (ZIP_VALUE_RE.test(q) || ZIP_CODE_WORD_RE.test(q)) found.add('zip');
  if (/\bthis month\b|\blast month\b/.test(q) || resolveAnyTimeRange(question) != null) found.add('month');
  if (MONEY_RE.test(q)) found.add('money');
  if (MAINTENANCE_DUE_RE.test(q)) found.add('maintenance');
  if (/\bwarrant/.test(q) && WARRANTY_STATUS_WORD_RE.test(q)) found.add('warranty');
  return found;
}

/** "active warranties" / "still under warranty" / "expired" / "out of
 *  warranty" / "expiring soon" — a warranty-status condition the plan must
 *  carry as a warrantyStatus filter. Live miss 2026-09-22 ("how many active
 *  warranties do we have"): the model dropped the status and the count came
 *  back as every unit, so this is decided in code like email/brand/geo. */
const WARRANTY_STATUS_WORD_RE =
  /\b(?:active|current|valid|still (?:under|covered|in) warranty|under warranty|in warranty|covered|expired|out of warranty|no longer (?:under|covered)|lapsed|expiring|expires? soon|about to expire|running out|unknown warranty|warranty (?:status )?unknown)\b/i;

/** The warrantyStatus bucket a question names, or null. Pure. */
export function warrantyStatusFromQuestion(question) {
  const q = String(question ?? '').toLowerCase();
  if (!/\bwarrant/.test(q)) return null;
  if (/\bexpir(?:ing|es? soon)\b|\babout to expire\b|\brunning out\b/.test(q)) return 'expiring';
  if (/\bexpired\b|\bout of warranty\b|\bno longer\b|\blapsed\b/.test(q)) return 'expired';
  if (/\bunknown\b/.test(q)) return 'unknown';
  if (/\bactive\b|\bcurrent\b|\bvalid\b|\bstill\b|\bunder warranty\b|\bin warranty\b|\bcovered\b/.test(q)) return 'active';
  return null;
}

const CONDITION_PLAN_FIELD = {
  email: 'hasEmail', phone: 'hasPhone', brand: 'brand', county: 'county',
  city: 'city', state: 'state', zip: 'zip', warranty: 'warrantyStatus',
};

/** Conditions detectedConditions(question) found that the validated PLAN has
 *  no corresponding filter (or, for 'month', no timeRange) for — the plan
 *  silently dropped something the question actually asked for. */
export function missingConditions(plan, question) {
  const missing = new Set();
  for (const c of detectedConditions(question)) {
    if (c === 'month') {
      if (!plan?.timeRange) missing.add(c);
      continue;
    }
    const field = CONDITION_PLAN_FIELD[c];
    if (!plan?.filters?.some((f) => f.field === field)) missing.add(c);
  }
  return missing;
}

function titleCaseWords(s) {
  return String(s ?? '')
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/**
 * Item 4 (100-question persona sample, 2026-09-22): rather than always
 * falling back honestly whenever the model's plan drops a condition the
 * question named, build the missing filter DETERMINISTICALLY when the
 * question gives enough to construct it with confidence — polarity from
 * "missing/without/no" vs "have/with/on file" for email/phone, the matched
 * brand/county/city word itself, a bare 5-digit zip, or a recognized state
 * name. Returns null when this specific condition can't be turned into a
 * filter this way (an unrecognized brand/county/city word, or a
 * state/zip that never actually appears despite the condition being
 * detected some other way) — the caller (routes/analytics.js) then keeps the
 * honest "can't filter by X yet" fallback for THAT condition, exactly as
 * before this existed. Never called for 'money'/'maintenance'/'month' —
 * those have no CONDITION_PLAN_FIELD entry at all and are handled earlier,
 * by the plan-independent up-front checks in runAnalyticsQuestion.
 */
export function buildConditionOverrideFilter(condition, question) {
  const q = String(question ?? '').toLowerCase();
  if (condition === 'email' || condition === 'phone') {
    const field = condition === 'email' ? 'hasEmail' : 'hasPhone';
    const negative = new RegExp(`\\b(?:no|missing|without)\\s+(?:an?\\s+)?${condition}\\b`, 'i');
    return { field, op: 'eq', value: !negative.test(q) };
  }
  if (condition === 'brand') {
    const word = BRAND_WORDS.find((b) => new RegExp(`\\b${b}\\b`).test(q));
    return word ? { field: 'brand', op: 'eq', value: titleCaseWords(word) } : null;
  }
  if (condition === 'county') {
    const word = [...KNOWN_COUNTY_NAMES]
      .sort((a, b) => b.length - a.length)
      .find((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q));
    return word ? { field: 'county', op: 'eq', value: titleCaseWords(word) } : null;
  }
  if (condition === 'city') {
    const names = [...new Set([...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES])].sort((a, b) => b.length - a.length);
    const word = names.find((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q));
    return word ? { field: 'city', op: 'eq', value: titleCaseWords(word) } : null;
  }
  if (condition === 'state') {
    if (/\barizona\b|\baz\b/.test(q)) return { field: 'state', op: 'eq', value: 'AZ' };
    if (/\bnevada\b|\bnv\b/.test(q)) return { field: 'state', op: 'eq', value: 'NV' };
    return null;
  }
  if (condition === 'zip') {
    const m = q.match(/\b(\d{5})\b/);
    return m ? { field: 'zip', op: 'eq', value: m[1] } : null;
  }
  if (condition === 'warranty') {
    const status = warrantyStatusFromQuestion(q);
    return status ? { field: 'warrantyStatus', op: 'eq', value: status } : null;
  }
  return null;
}

/** The honest "I can't do that yet" answer for one dropped condition —
 *  `kind: 'answer'` (never an error) so the client renders it exactly like
 *  any other analytics reply, just with no facts and no false count. */
export function unsupportedConditionAnswer(condition, entity = 'customers') {
  const noun = (ENTITY_NOUN[entity] ?? ENTITY_NOUN.customers)(2);
  return {
    kind: 'answer',
    text: `I can count ${noun}, but I can't filter by ${condition} yet.`,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

/**
 * Item 7 (100-question persona sample, 2026-09-22), "has X but no Y":
 * "customers with a maintenance agreement but no service this year" /
 * "customers with a proposal but no invoice" — a cross-document-type filter
 * with no path through the ordinary entity/filter vocabulary at all (a
 * customer either has or lacks a document of some type; nothing in
 * FILTER_FIELDS before hasDocType/lacksDocType existed could express that).
 * Detected and turned into a plan HERE, deterministically, before the model
 * is ever asked — the same "code decides the shape, never the model"
 * contract resolveServiceVisitsOverride already keeps for entity/op.
 *
 * When the "no ___" half names a real document type ("no invoice", "no
 * proposal"), both halves resolve to real hasDocType/lacksDocType filters and
 * the question is answered for real. When it names "service" instead (a
 * SERVICE VISIT, not a document type this corpus tracks as such) — optionally
 * with a time window ("no service this year") — there is no filter field for
 * that at all, so this returns `unsupported` naming exactly the part that
 * can't be expressed, and the caller (runAnalyticsQuestion) gives the honest
 * fallback instead of guessing.
 */
const CROSS_DOC_BUT_NO_RE = new RegExp(
  `\\b(${docTypeSynonymAlternation()})\\b(?:s)?[\\s\\S]{0,10}\\bbut\\s+no\\s+(${docTypeSynonymAlternation()}|service)\\b([\\s\\S]{0,25})?`,
  'i'
);
const CROSS_DOC_TIME_WINDOW_RE = /\b(this year|last year|this month|last month|this week|last week|since\s+\d{4})\b/i;

export function parseCrossDocCondition(question) {
  const q = String(question ?? '').toLowerCase();
  const m = q.match(CROSS_DOC_BUT_NO_RE);
  if (!m) return null;
  const hasType = docTypeFromWord(m[1]);
  if (!hasType) return null;
  const lacksWord = m[2].toLowerCase();
  const trailing = m[3] ?? '';
  if (lacksWord === 'service') {
    const windowMatch = trailing.match(CROSS_DOC_TIME_WINDOW_RE);
    return { hasType, lacksType: null, unsupported: 'service', windowLabel: windowMatch ? windowMatch[1] : null };
  }
  const lacksType = docTypeFromWord(lacksWord);
  if (!lacksType) return null;
  return { hasType, lacksType, unsupported: null };
}

/** The honest fallback for a cross-doc condition this file can't express
 *  (the "no service ___" half) — names the part that DOES work (the
 *  hasDocType half) alongside the part that doesn't, never a silent
 *  unfiltered answer. */
export function crossDocUnsupportedAnswer(cross) {
  const label = documentTypeLabel(cross.hasType).toLowerCase();
  const windowPart = cross.windowLabel ? ` ${cross.windowLabel}` : '';
  return {
    kind: 'answer',
    text: `I can find customers with a ${label}, but I can't filter by "no ${cross.unsupported}${windowPart}" yet.`,
    facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

/* =================================================================== schema */

export const ANALYTICS_TOOL = {
  name: 'analytics_plan',
  description:
    "Turn the dispatcher's counting/listing/grouping question into a structured query plan. " +
    'Never answer in prose and never write SQL — only fill this schema. Use ONLY the listed ' +
    'entities/ops/fields; if nothing in the vocabulary fits the question, still return your best ' +
    'guess (the caller validates and safely falls back if it does not fit).',
  input_schema: {
    type: 'object',
    properties: {
      entity: {
        type: 'string',
        enum: ENTITIES,
        description:
          'What is being counted/listed. Default to "customers" when the question names no ' +
          'entity at all (e.g. "how many in Maricopa County").',
      },
      op: {
        type: 'string',
        enum: OPS,
        description:
          '"count": a single number. "list": individual rows (customer names, etc). ' +
          '"groupBy": counts broken down by groupBy field (e.g. "by city"). "sum": total a numeric field.',
      },
      groupBy: {
        type: 'string',
        enum: GROUP_BY_FIELDS,
        description: 'Required when op is "groupBy". Omit otherwise.',
      },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: {
              type: 'string',
              enum: FILTER_FIELDS,
              description:
                'state: 2-letter code ("AZ") — "Arizona"/"arizona" both mean AZ. county: bare name, ' +
                'no the word "County" ("Maricopa", not "Maricopa County"). warrantyStatus: one of ' +
                `${WARRANTY_STATUSES.join('|')} ("out of warranty"/"expired" -> expired; "still under ` +
                'warranty"/"active" -> active; "expiring soon" -> expiring). installYear: the calendar ' +
                'year installed, for "older/newer than N years" compute the year and use op gt/lt. ' +
                'hasEmail (customers only, boolean value, op "eq"): "have/has an email on file" -> true; ' +
                '"missing/without/no email" -> false. hasPhone (customers only, boolean value, op "eq"): ' +
                '"have/has a phone (number) on file" -> true; "missing/without/no phone (number)" -> false.',
            },
            op: { type: 'string', enum: FILTER_OPS },
            value: { description: 'A string or number matching the field (an array only for op "in").' },
          },
          required: ['field', 'op', 'value'],
        },
      },
      timeRange: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        description: 'YYYY-MM-DD or YYYY-MM, for "this month"/"in August"/"since 2024" style questions.',
      },
      limit: { type: 'number', description: `Row cap for "list". Defaults to ${DEFAULT_LIMIT}.` },
      sortBy: {
        type: 'string',
        enum: SORT_FIELDS,
        description:
          'Only for entity "customers" + op "list": rank customers by size instead of filtering them. ' +
          '"who\'s our biggest/largest/top customer(s)" -> "equipmentCount" unless the question names ' +
          'documents/invoices/paperwork specifically, in which case "documentCount". Omit for every other question.',
      },
    },
    required: ['entity', 'op'],
  },
};

/** One line per canonical entity, its plain-English synonyms, built from
 *  ENTITY_SYNONYMS (above) so the prompt can never drift from the
 *  classifier's own noun list — see that table's own doc comment. */
function synonymPromptLine() {
  return Object.entries(ENTITY_SYNONYMS)
    .filter(([entity]) => entity !== 'technicians')
    .map(([entity, words]) => `${entity} = ${[...new Set(words)].join('/')}`)
    .join('; ');
}

export const ANALYTICS_SYSTEM_PROMPT_BASE =
  'You turn an HVAC dispatch company\'s counting/listing/grouping question into a query plan ' +
  'using the "analytics_plan" tool. You never see or write SQL, and you never answer the question ' +
  'yourself — you only choose entity/op/groupBy/filters from the closed vocabulary the tool schema ' +
  'declares. The owner uses plain English, not database terms — map every synonym to its canonical ' +
  `entity before filling the schema: ${synonymPromptLine()}. "Arizona"/"AZ"/"arizona" always means ` +
  'the state filter value "AZ". A bare county name ("Maricopa", "Pima") means the county filter with ' +
  'that name, no "County" suffix. A brand name (Trane, Carrier, Goodman, Lennox, Rheem, York, Daikin, ' +
  'Mitsubishi, ...) means the brand filter. "this month"/"last month"/"this week"/a named month means ' +
  'timeRange. "who\'s our biggest/largest/top customer(s)" means entity "customers", op "list", and ' +
  'sortBy "equipmentCount" (or "documentCount" if the question specifically names documents/invoices) ' +
  '— never a filter. "have/has an email on file" means filter hasEmail=true; "missing/without/no email" ' +
  'means hasEmail=false; the same mapping applies to "phone"/hasPhone. If the question names no entity, ' +
  'assume "customers". Always call the tool exactly once.';

/* ============================================================ few-shot examples
 *
 * Day 2 training plan (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): ~25
 * tricky question -> plan pairs, curated from the shapes the Day 1 question
 * bank and the live miss clusters actually found hard — a bare month with no
 * year, county vs city vs state, a brand+county combo, hasEmail/hasPhone in
 * both polarities, warrantyStatus, an installYear age filter, documentType
 * synonyms, a technician filter, every groupBy dimension, list vs count, a
 * brand-vs-brand comparison (groupBy + an `in` filter), and the customers-
 * via-equipment-join shape ("which customers in Mesa have Trane units").
 *
 * Each `plan` here is a real `analytics_plan` tool-input shape — every one is
 * checked against validatePlan by scripts/verify-analytics.mjs, so this list
 * can never silently drift out of the closed vocabulary it's meant to teach.
 * Questions are written in the NORMALIZED form the planner actually receives
 * (nlNormalize.js has already lowercased, expanded abbreviations like "az" ->
 * "arizona", and fixed typos before this prompt ever sees the question) — see
 * routes/analytics.js's planAnalyticsQuestion, which is called with
 * `question_n`, never the raw text.
 *
 * The last three are NEGATIVE examples: shapes the planner must not spend a
 * confident plan on because api/ask.js / runAnalyticsQuestion already
 * intercept them before (or instead of) trusting a plan — a money question
 * (isMoneyQuestion), a maintenance-due question (detectedConditions'
 * 'maintenance', MAINTENANCE_DUE_RE) and a single-record address lookup
 * (looksLikeSingleRecordReference). `fallback` names the exact internal
 * marker each one maps to — the same string these real detectors key off —
 * rather than a plan, and `plan` is deliberately absent (renderFewShotLine
 * below renders these as a `SKIP` line, never a JSON tool-input, since the
 * schema has no field for "decline"). scripts/verify-analytics.mjs checks
 * each of these three questions actually trips its named detector, so this
 * list can never drift out of sync with the real fallback logic either.
 */
export const ANALYTICS_FEW_SHOT = [
  // ---- time ----
  { q: 'how many jobs did we do in august', plan: { entity: 'serviceVisits', op: 'count' } },
  {
    q: 'how many invoices from august of 2023',
    plan: {
      entity: 'documents', op: 'count',
      filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }],
      timeRange: { from: '2023-08', to: '2023-08' },
    },
  },
  // ---- geo: county vs city vs state ----
  { q: 'how many customers in maricopa county', plan: { entity: 'customers', op: 'count', filters: [{ field: 'county', op: 'eq', value: 'Maricopa' }] } },
  { q: 'how many customers in chandler', plan: { entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Chandler' }] } },
  { q: 'how many customers in arizona', plan: { entity: 'customers', op: 'count', filters: [{ field: 'state', op: 'eq', value: 'AZ' }] } },
  // ---- brand + county combo ----
  {
    q: 'how many trane units in pima county',
    plan: { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }, { field: 'county', op: 'eq', value: 'Pima' }] },
  },
  // ---- hasEmail / hasPhone, both polarities ----
  { q: 'how many customers have an email on file', plan: { entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: true }] } },
  { q: 'how many customers are missing a phone number', plan: { entity: 'customers', op: 'count', filters: [{ field: 'hasPhone', op: 'eq', value: false }] } },
  // ---- warrantyStatus ----
  { q: 'which units have an expired warranty', plan: { entity: 'warranties', op: 'list', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] } },
  // ---- installYear age filter ----
  { q: 'which customers have units older than 10 years', plan: { entity: 'customers', op: 'list', filters: [{ field: 'installYear', op: 'lt', value: 2016 }] } },
  // ---- documentType synonyms ----
  { q: 'how many permits do we have', plan: { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'permit' }] } },
  { q: 'how many proposal quotes are there', plan: { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'proposal-quote' }] } },
  { q: 'how many service tickets do we have', plan: { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'service-ticket' }] } },
  // ---- technician ----
  { q: 'how many jobs did mike do last week', plan: { entity: 'serviceVisits', op: 'count', filters: [{ field: 'technician', op: 'eq', value: 'Mike' }] } },
  // ---- groupBy: month, brand, county ----
  { q: 'jobs per month this year', plan: { entity: 'serviceVisits', op: 'groupBy', groupBy: 'month' } },
  { q: 'how many units do we have by brand', plan: { entity: 'equipment', op: 'groupBy', groupBy: 'brand' } },
  { q: 'customers by county', plan: { entity: 'customers', op: 'groupBy', groupBy: 'county' } },
  // ---- list vs count ----
  { q: 'list customers in gilbert', plan: { entity: 'customers', op: 'list', filters: [{ field: 'city', op: 'eq', value: 'Gilbert' }] } },
  // ---- comparison: groupBy + an `in` filter, not two separate plans ----
  {
    q: 'trane vs carrier units',
    plan: { entity: 'equipment', op: 'groupBy', groupBy: 'brand', filters: [{ field: 'brand', op: 'in', value: ['Trane', 'Carrier'] }] },
  },
  // ---- customers-via-equipment join ----
  {
    q: 'which customers in mesa have trane units',
    plan: { entity: 'customers', op: 'list', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }, { field: 'brand', op: 'eq', value: 'Trane' }] },
  },
  // ---- "had/were serviced" shape (live miss, 2026-09-21) — entity
  // serviceVisits, never equipment/customers, which carry no service_date
  // column at all; see resolveServiceVisitsOverride's own doc comment for why
  // this is also forced deterministically rather than left to the model. ----
  { q: 'which units had service this month', plan: { entity: 'serviceVisits', op: 'list', timeRange: { from: '2026-09', to: '2026-09' } } },
  { q: 'how many service calls this month', plan: { entity: 'serviceVisits', op: 'count', timeRange: { from: '2026-09', to: '2026-09' } } },
  // ---- NEGATIVE: never plan these — already handled before/instead of you ----
  { q: 'how much did we invoice last month', fallback: 'money' },
  { q: 'which customers are overdue for maintenance', fallback: 'maintenance' },
  { q: "what's the warranty on the unit at 1234 elm street", fallback: 'single-record' },
];

/** One compact line per few-shot example — minified JSON for a real plan, or
 *  a `SKIP(marker)` line for a negative example (see ANALYTICS_FEW_SHOT's own
 *  doc comment for why a negative can't be a tool-input JSON value). */
function renderFewShotLine(ex) {
  if (ex.fallback) return `Q:"${ex.q}"->SKIP(${ex.fallback})`;
  return `Q:"${ex.q}"->${JSON.stringify(ex.plan)}`;
}

/** Appended at the END of the system prompt, after every other line, so the
 *  long STABLE prefix above (task framing, entity synonyms, rules) stays
 *  byte-for-byte first — Anthropic's prompt cache matches on a shared prefix,
 *  so anything that might grow/reorder in the future belongs after it, not
 *  interleaved with it. */
export const ANALYTICS_FEW_SHOT_BLOCK =
  '\n\nEXAMPLES (question -> analytics_plan tool input; SKIP means a question you must not invent a ' +
  "plan for — it's already handled before you're ever called):\n" +
  ANALYTICS_FEW_SHOT.map(renderFewShotLine).join('\n');

export const ANALYTICS_SYSTEM_PROMPT = ANALYTICS_SYSTEM_PROMPT_BASE + ANALYTICS_FEW_SHOT_BLOCK;

/** ~4 chars/token is a standard, conservative estimate for English prose and
 *  compact JSON alike — good enough for a soft cap, never sent to a
 *  tokenizer. Exported so scripts/verify-learning.mjs can pin the same
 *  arithmetic the cap below uses. */
export function estimateTokens(s) {
  return Math.ceil(String(s ?? '').length / 4);
}

const LEARNED_FEW_SHOT_MAX_ITEMS = 12;
const LEARNED_FEW_SHOT_MAX_TOKENS = 500;

/**
 * Tier 2 learning (Part A): `extraFewShot` is the ACTIVE overlay's own
 * approved `few_shot` items (learning/overlay.js's getActiveOverlay) —
 * `{question, plan}` pairs an operator approved after seeing them fix a real
 * miss. Appended AFTER ANALYTICS_FEW_SHOT_BLOCK (never interleaved with the
 * curated, stable examples above it — same prompt-cache-prefix reasoning
 * ANALYTICS_FEW_SHOT_BLOCK's own doc comment gives), capped at 12 items / an
 * estimated 500 tokens so a runaway learned set can never blow up every
 * planner call's cost. Greedy: items are taken in order until either cap
 * would be exceeded, then stops (never drops an earlier item to fit a later,
 * bigger one). No `extraFewShot` (or none of it fits) returns the exact same
 * ANALYTICS_SYSTEM_PROMPT constant — so this is a pure widening, never a
 * mutation of the base prompt.
 */
export function buildAnalyticsSystemPrompt({ extraFewShot } = {}) {
  if (!Array.isArray(extraFewShot) || !extraFewShot.length) return ANALYTICS_SYSTEM_PROMPT;
  const lines = [];
  let tokens = 0;
  for (const ex of extraFewShot) {
    if (lines.length >= LEARNED_FEW_SHOT_MAX_ITEMS) break;
    if (!ex || typeof ex.question !== 'string' || !ex.question.trim() || !ex.plan) continue;
    const validated = validatePlan(ex.plan);
    if (!validated) continue;
    const line = `Q:"${ex.question}"->${JSON.stringify(validated)}`;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > LEARNED_FEW_SHOT_MAX_TOKENS) break;
    lines.push(line);
    tokens += lineTokens;
  }
  if (!lines.length) return ANALYTICS_SYSTEM_PROMPT;
  return `${ANALYTICS_SYSTEM_PROMPT}\n\nLEARNED EXAMPLES (operator-approved, same format as above):\n${lines.join('\n')}`;
}

/* ============================================================ cache namespace
 *
 * Reviewer NO-GO (2026-09-21, A2): analytics answers were being cached and
 * looked up under the SAME question_hash the retrieval+model path uses (both
 * computed as `hashQuestion(normalizeQuestion(question))` in api/ask.js) and
 * the SAME global corpus_stamp prompt-version mixed in by askCache.js's
 * `getCacheEntry` (that version is derived from the RETRIEVAL system prompt
 * + ANSWER_TOOL, not this file's). Two concrete bugs followed: (1) a question
 * previously answered and cached via retrieval, that the classifier now
 * routes to analytics, would have `getCacheEntry` return that OLD retrieval
 * answer (wrong shape, no aggregate math) as if it were a valid analytics
 * cache hit; (2) any future change to THIS file's prompt/schema/logic had no
 * way to bust old analytics cache rows, since the corpus_stamp it shared with
 * retrieval only reacts to retrieval's own prompt/schema changing.
 *
 * Fix: analytics gets its OWN prompt-version fingerprint (`ANALYTICS_PROMPT_
 * VERSION`, passed to askCache.js's `getCacheEntry` as `promptVersion` — see
 * that file) and its OWN namespaced hash space, computed by THESE functions,
 * never api/ask.js's shared `hashQuestion`. Two tiers:
 *   - `analyticsQuestionHash` — "analytics:" + the question text. Checked
 *     FIRST, before the Haiku planner call, so a repeated exact phrasing
 *     still costs nothing (the whole point of caching this at all).
 *   - `analyticsPlanHash` — "analytics-plan:" + the validated PLAN's own
 *     canonical JSON. Checked after a Tier-1 miss, once the plan is known —
 *     so two DIFFERENT phrasings that resolve to the SAME plan ("how many
 *     customers in Arizona" / "count customers in AZ") share one answer, and
 *     two DIFFERENT plans can never collide with each other's cached answer,
 *     because the hash IS a digest of the plan itself, not a guess at one.
 * See routes/analytics.js's runAnalyticsQuestion for how both tiers are used,
 * and askCache.js's getCacheEntry for the promptVersion parameter.
 */
// Bumped v1 -> v2 (2026-09-21, items 1+2): hasEmail/hasPhone added to the tool
// schema/prompt, so any plan cached under the old vocabulary must be
// invalidated (a cached "customers count" answer to "how many customers have
// an email on file" must never be served again now that the filter exists).
// Bumped v2 -> v3 (2026-09-21, round 6): a stale pre-fix cache row (e.g. the
// "49 customers." answer for a maintenance-due question) must never survive
// this deploy just because its promptVersion still matched — every prior
// analytics cache row is invalidated on deploy regardless of the new
// pre-cache guard above, which is the real fix; this is belt-and-suspenders.
// Bumped v3 -> v4 (Day 2 training plan, 2026-09-21): ANALYTICS_SYSTEM_PROMPT
// now carries the ANALYTICS_FEW_SHOT block — a real prompt change, so every
// prior cache row (planned under the few-shot-less prompt) must invalidate
// the same way v2's hasEmail/hasPhone bump and v3's belt-and-suspenders bump
// both already did.
// Bumped v4 -> v5 ("which units had service this month" live miss,
// 2026-09-21): two new few-shot examples were added to ANALYTICS_FEW_SHOT
// (another real prompt change) and the serviceVisits SQL now returns
// customer_name/model columns it never did before — any plan cached under
// the old vocabulary/shape must be invalidated the same way every prior bump
// already was.
// Bumped v6 -> v7 (100-question persona sample, 2026-09-22): FILTER_FIELDS
// grew hasDocType/lacksDocType (ANALYTICS_TOOL's own enum, so this is already
// covered by the tool-hash half of ANALYTICS_PROMPT_VERSION below — bumped
// anyway, belt-and-suspenders, matching v2/v3's own precedent) and the
// condition-override/cross-doc logic changed what a "missing condition" or
// "has X but no Y" question answers — a plan or answer cached under the old
// behavior must never be served again just because its own prompt text
// happened not to change.
export const ANALYTICS_VERSION = 'analytics-v8';
export const ANALYTICS_PROMPT_VERSION = createHash('sha256')
  .update(ANALYTICS_VERSION)
  .update(JSON.stringify(ANALYTICS_TOOL))
  .update(ANALYTICS_SYSTEM_PROMPT)
  .digest('hex')
  .slice(0, 12);

/** Mirrors api/ask.js's own normalizeQuestion exactly (trim/lowercase/
 *  collapse whitespace/strip trailing punctuation) — duplicated rather than
 *  imported so this _lib file has no dependency on the top-level endpoint
 *  file that already imports IT. Private: callers hash through the two
 *  functions below, never this directly. */
function normalizeQuestionForHash(q) {
  return String(q ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '');
}

function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** Tier 1: namespaced by question text alone, so a REPEATED exact phrasing
 *  never even calls the Haiku planner. Never equal to api/ask.js's own
 *  `hashQuestion(normalizeQuestion(question))` for the same text — the
 *  "analytics:" prefix guarantees the two hash spaces can never collide. */
export function analyticsQuestionHash(question) {
  return sha256Hex(`analytics:${normalizeQuestionForHash(question)}`);
}

/** A validated plan's filters, sorted by (field, op) so two plans that carry
 *  the same filters in a different array order still canonicalize to the
 *  same string — this is what makes analyticsPlanHash a true digest of the
 *  PLAN, not of whatever order the model happened to list filters in. */
function canonicalPlanString(plan) {
  const filters = [...(plan?.filters ?? [])]
    .map((f) => ({ field: f.field, op: f.op, value: f.value }))
    .sort((a, b) => (a.field === b.field ? (a.op < b.op ? -1 : a.op > b.op ? 1 : 0) : a.field < b.field ? -1 : 1));
  return JSON.stringify({
    entity: plan?.entity ?? null,
    op: plan?.op ?? null,
    groupBy: plan?.groupBy ?? null,
    filters,
    timeRange: plan?.timeRange ?? null,
    limit: plan?.limit ?? null,
    // round 4 item 1: a plain "list customers" and a "biggest customer"
    // sortBy plan must never share a cache row — they run different SQL.
    sortBy: plan?.sortBy ?? null,
  });
}

/** Tier 2: namespaced by the PLAN's own canonical JSON, so distinct plans can
 *  never collide (the hash IS a digest of the plan) and two differently-
 *  worded questions that resolve to the identical plan share one cached
 *  answer instead of paying for the same SQL twice. */
export function analyticsPlanHash(plan) {
  return sha256Hex(`analytics-plan:${canonicalPlanString(plan)}`);
}

/* ============================================================ month resolution
 *
 * Item 1 (2026-09-21 live miss): "how many jobs did we do in August" fell
 * through to retrieval. Root cause: the model was asked to fill `timeRange`
 * itself ("this month"/"last month"/a named month means timeRange" was the
 * only guidance) with no year math spelled out for a BARE month name, and a
 * bad/missing timeRange fails validatePlan's `^\d{4}(-\d{2}...)?$` shape check
 * and rejects the WHOLE plan -> null -> full fall-through, exactly like any
 * other invalid plan. Rather than trust the model's date arithmetic (the same
 * "the model never computes the real answer, code does" rule this file's
 * header already states for SQL and formatting), a literal month name/"this
 * month"/"last month" phrase in the QUESTION TEXT is resolved to an exact
 * YYYY-MM here, deterministically, from `today` — and routes/analytics.js
 * uses this to OVERRIDE whatever the model put in timeRange whenever the
 * question contains one of these phrases, so the model's only job is
 * recognizing that a time filter applies at all, never doing the year math.
 */
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
// Round 5 item 2 (2026-09-21 reviewer NO-GO): the year capture only matched a
// bare "August 2023" — "August of 2023" and "August, 2023" (both real ways an
// owner phrases it) never captured a year at all, so a genuinely-provided
// year was silently dropped. "[\s,]+" swallows any run of spaces/commas
// between the month and the year, and an optional "of " before the digits.
const MONTH_NAME_RE = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\b(?:[\\s,]+(?:of\\s+)?(\\d{4}))?`, 'i');

function monthRange(year, month1to12) {
  const ym = `${year}-${String(month1to12).padStart(2, '0')}`;
  return { from: ym, to: ym };
}

/**
 * Resolves "in August" / "in August 2024" / "this month" / "last month" in
 * `question` to an exact {from, to} YYYY-MM timeRange, using `today` (an
 * ISO date/timestamp string) as "now". A bare month name with no year
 * resolves to that month in today's year — unless that month is still in
 * the FUTURE relative to today, in which case it must mean last year's
 * occurrence of it (an owner asking about "August" in March 2026 means
 * August 2025, not a month that hasn't happened yet). Returns null when the
 * question contains none of these phrases — callers then leave the model's
 * own timeRange (if any) untouched.
 */
export function resolveQuestionTimeRange(question, today) {
  const q = String(question ?? '').toLowerCase();
  const now = today ? new Date(today) : new Date();
  if (Number.isNaN(now.getTime())) return null;

  if (/\bthis month\b/.test(q)) return monthRange(now.getUTCFullYear(), now.getUTCMonth() + 1);
  if (/\blast month\b/.test(q)) {
    const m = now.getUTCMonth(); // 0-indexed current month
    return m === 0 ? monthRange(now.getUTCFullYear() - 1, 12) : monthRange(now.getUTCFullYear(), m);
  }

  const m = q.match(MONTH_NAME_RE);
  if (!m) return null;
  const monthNum = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
  if (m[2]) return monthRange(Number(m[2]), monthNum);
  const currentMonth = now.getUTCMonth() + 1;
  const year = monthNum > currentMonth ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  return monthRange(year, monthNum);
}

/**
 * Live 100-question persona sample (2026-09-22), item 5 "TIME WINDOWS": this
 * week / last week / this quarter / last quarter / year to date|ytd / this
 * year / last year / since <year> / in the last N days|weeks|months / past N
 * ... — none of these are month-name phrases resolveQuestionTimeRange (above)
 * recognizes, and unlike a month they need DAY-grain bounds (a week or a
 * "since 2024" range never lines up on a calendar-month boundary). Kept as a
 * separate function (rather than folded into resolveQuestionTimeRange itself)
 * so that function's existing {from,to}-only return shape — and every eq()
 * test pinned to it — stays byte-for-byte unchanged; resolveAnyTimeRange
 * below is the single combined entry point every caller that needs BOTH
 * families (reconcileTimeRange, detectedConditions, the executor's zero-
 * result/count wording) actually uses.
 *
 * Returns {from, to, label} (day-grain YYYY-MM-DD) or null. `label` is prose
 * for the honest/zero-result wording ("this week", "Q2 2026", "since 2024",
 * "the last 30 days") — see routes/analytics.js's use of it in
 * formatAnalyticsAnswer's opts.
 */
export function resolveExtendedTimeRange(question, today) {
  const q = String(question ?? '').toLowerCase();
  const now = today ? new Date(today) : new Date();
  if (Number.isNaN(now.getTime())) return null;

  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  };
  const todayISO = iso(now);

  if (/\byear[\s-]?to[\s-]?date\b|\bytd\b/.test(q)) {
    return { from: `${now.getUTCFullYear()}-01-01`, to: todayISO, label: 'year to date' };
  }
  // Reviewer NO-GO (2026-09-22): Monday-anchored, not Sunday-anchored —
  // getUTCDay() is 0=Sunday..6=Saturday, so (getUTCDay()+6)%7 is the number
  // of days since the most recent Monday (0 on a Monday itself, 6 on a
  // Sunday). Verified: today 2026-09-22 (a Tuesday, getUTCDay()=2) -> offset
  // 1 -> this week starts 2026-09-21 (Monday); last week is then
  // 2026-09-14..2026-09-20.
  const mondayOffset = (now.getUTCDay() + 6) % 7;
  if (/\bthis week\b/.test(q)) {
    const start = addDays(now, -mondayOffset);
    return { from: iso(start), to: todayISO, label: 'this week' };
  }
  if (/\blast week\b/.test(q)) {
    const thisStart = addDays(now, -mondayOffset);
    const lastStart = addDays(thisStart, -7);
    const lastEnd = addDays(thisStart, -1);
    return { from: iso(lastStart), to: iso(lastEnd), label: 'last week' };
  }
  if (/\bthis quarter\b/.test(q)) {
    const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    const from = `${now.getUTCFullYear()}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
    return { from, to: todayISO, label: `in Q${qStartMonth / 3 + 1} ${now.getUTCFullYear()}` };
  }
  if (/\blast quarter\b/.test(q)) {
    const curQStart = Math.floor(now.getUTCMonth() / 3) * 3;
    let lastQStart = curQStart - 3;
    let year = now.getUTCFullYear();
    if (lastQStart < 0) {
      lastQStart += 12;
      year -= 1;
    }
    const from = `${year}-${String(lastQStart + 1).padStart(2, '0')}-01`;
    const endMonth = lastQStart + 2; // 0-indexed last month of that quarter
    const to = iso(new Date(Date.UTC(year, endMonth + 1, 0))); // last day of that month
    return { from, to, label: `in Q${lastQStart / 3 + 1} ${year}` };
  }
  if (/\bthis year\b/.test(q)) {
    const y = now.getUTCFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `in ${y}` };
  }
  if (/\blast year\b/.test(q)) {
    const y = now.getUTCFullYear() - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `in ${y}` };
  }
  const sinceMatch = q.match(/\bsince\s+(\d{4})\b/);
  if (sinceMatch) {
    return { from: `${sinceMatch[1]}-01-01`, to: todayISO, label: `since ${sinceMatch[1]}` };
  }
  const lastNMatch = q.match(/\b(?:in\s+the\s+last|last|past)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/);
  if (lastNMatch) {
    const n = Number(lastNMatch[1]);
    const unit = lastNMatch[2];
    let fromDate;
    let unitLabel;
    if (unit.startsWith('day')) {
      fromDate = addDays(now, -n);
      unitLabel = 'day';
    } else if (unit.startsWith('week')) {
      fromDate = addDays(now, -n * 7);
      unitLabel = 'week';
    } else {
      fromDate = new Date(now);
      fromDate.setUTCMonth(fromDate.getUTCMonth() - n);
      unitLabel = 'month';
    }
    return { from: iso(fromDate), to: todayISO, label: `in the last ${n} ${unitLabel}${n === 1 ? '' : 's'}` };
  }
  return null;
}

/** Combined entry point: resolveQuestionTimeRange's own month-name/this-
 *  month/last-month families first (labeled via monthRangeLabel, defined
 *  further below — forward-referenced here since it's a plain function
 *  declaration, hoisted), then resolveExtendedTimeRange's day-grain families.
 *  Returns {from, to, label} or null. Used wherever BOTH families need to be
 *  recognized as one capability (reconcileTimeRange, detectedConditions'
 *  own 'month' bit, and the executor's count/zero-result wording) — never by
 *  validatePlan, which only ever sees the stripped {from,to} a caller pulls
 *  out of this. */
export function resolveAnyTimeRange(question, today) {
  const base = resolveQuestionTimeRange(question, today);
  if (base) return { from: base.from, to: base.to, label: monthRangeLabel(base) };
  return resolveExtendedTimeRange(question, today);
}

const VALID_TIME_PART_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/**
 * Round 5 item 2: decides whether the model's own `timeRange` (raw tool_use
 * input, pre-validation) should be trusted as-is, or overridden by
 * resolveQuestionTimeRange's deterministic reading of the question text. The
 * model's timeRange wins ONLY when it is well-formed AND names a year that is
 * actually written in the question — i.e. the model read something real off
 * the page that our simple month-name regex has no way to know about (a plan
 * combining a month with a non-current year the question explicitly gave).
 * Every other case (the question names no year at all, or the model's
 * timeRange is malformed/missing) defers to the deterministic override,
 * exactly as before — see resolveQuestionTimeRange's own doc comment for why
 * the model's date math is not trusted by default. Pure, so this is testable
 * with no model call — see routes/analytics.js's planAnalyticsQuestion for
 * where the raw tool_use input is actually produced.
 */
export function reconcileTimeRange(rawTimeRange, question, today) {
  // resolveAnyTimeRange (item 5, 2026-09-22) also recognizes this week/last
  // week/this quarter/last quarter/YTD/this year/last year/since <year>/the
  // last N days|weeks|months, on top of resolveQuestionTimeRange's original
  // month-name families — only {from,to} is ever kept here (never `label`,
  // which validatePlan would strip anyway; see resolveAnyTimeRange's own
  // doc comment for who actually reads `label`).
  const overrideFull = resolveAnyTimeRange(question, today);
  const override = overrideFull ? { from: overrideFull.from, to: overrideFull.to } : null;
  if (!override) return rawTimeRange ?? undefined;

  const from = String(rawTimeRange?.from ?? '');
  const validShape =
    rawTimeRange &&
    typeof rawTimeRange === 'object' &&
    VALID_TIME_PART_RE.test(from) &&
    (rawTimeRange.to == null || VALID_TIME_PART_RE.test(String(rawTimeRange.to)));
  const yearMatch = /^(\d{4})/.exec(from);
  const yearInQuestion = yearMatch && new RegExp(`\\b${yearMatch[1]}\\b`).test(String(question ?? ''));
  if (validShape && yearInQuestion) return rawTimeRange;
  return override;
}

/**
 * Live miss (2026-09-21): the owner asked Donovan live "which units had
 * services this month" and got no usable answer. Root cause: entity choice
 * for a "did this get serviced" question was left entirely to the model —
 * exactly the kind of judgment call resolveQuestionTimeRange (above) already
 * refuses to leave to the model for DATES, for the same reason. `equipment`/
 * `customers` carry no service_date column at all, so a plan that picked
 * either one either got rejected downstream (no matching filter/column) or,
 * worse, silently ignored the timeRange and answered with EVERY row — the
 * data itself doesn't matter here; the entity choice must never depend on
 * the model getting it right. `serviceVisits` (backed by the
 * extractions.field_key = 'service_date' rows — see buildAnalyticsSQL) is
 * the ONLY entity whose rows are actually keyed by when the work happened, so
 * any question shaped like "<units/equipment/customers/...> <had/got/were/
 * received> service(d)" or "<did/do> we service" or naming "service call(s)"
 * outright is forced to entity 'serviceVisits' regardless of what the model
 * returned — see planAnalyticsQuestion (routes/analytics.js), which applies
 * this the same way it applies reconcileTimeRange, before validatePlan ever
 * runs. `service(?:d)?` (not just "service") so this still matches whether or
 * not nlNormalize's fuzzy-typo pass "corrects" a genuine "serviced" back to
 * "service" first (see EXTRA_DOMAIN_WORDS in nlNormalize.js, which now keeps
 * "serviced" in the vocabulary so that correction stops happening at all —
 * this regex is written to not depend on either behavior).
 */
const SERVICE_VISITS_OVERRIDE_RE =
  /\b(?:had|got|were|received)\s+service(?:d|s)?\b|\b(?:did|do)\s+we\s+service\b|\bwe\s+service(?:d)?\b|\bservice\s+calls?\b/i;

/** True for any question this session's live-miss cluster named — exported
 *  so scripts/verify-analytics.mjs can pin the exact shapes down directly. */
export function isServiceVisitsQuestion(question) {
  return SERVICE_VISITS_OVERRIDE_RE.test(String(question ?? ''));
}

/**
 * The forced {entity, op} for a question isServiceVisitsQuestion recognizes,
 * or null. `op` is 'count' for a "how many" question, 'list' for every other
 * phrasing ("which"/"what"/"list ...") — the same count-vs-list distinction
 * every other entity already gets from the model, just decided deterministically
 * here instead of trusted from the model's own `op` choice, for the same
 * "never depend on the model getting it right" reason the entity itself is
 * forced. Never returns filters/timeRange — planAnalyticsQuestion layers
 * reconcileTimeRange's own deterministic timeRange on top of this separately,
 * and drops whatever filters the model may have guessed (this shape's 7 known
 * phrasings never need one).
 */
export function resolveServiceVisitsOverride(question) {
  if (!isServiceVisitsQuestion(question)) return null;
  const op = /\bhow many\b/i.test(String(question ?? '')) ? 'count' : 'list';
  return { entity: 'serviceVisits', op };
}

/** "August 2026" from a validated plan's {from: '2026-08', to: '2026-08'} —
 *  used to word a count answer as "N jobs in August 2026" (item 1) instead of
 *  a bare "You have N jobs.". Only fires for a single-month range (from ===
 *  to); a genuine multi-month range ("since 2024") gets no such label and
 *  falls back to the plain count wording. */
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export function monthRangeLabel(timeRange) {
  if (!timeRange?.from || timeRange.from !== timeRange.to) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(timeRange.from);
  if (!m) return null;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return null;
  return `${MONTH_LABELS[idx]} ${m[1]}`;
}

/** True when a timeRange's bounds are full YYYY-MM-DD dates (item 5's
 *  extended windows) rather than the original YYYY-MM month-grain shape —
 *  the executor (routes/analytics.js) uses this to decide whether to compare
 *  a row's exact date or its truncated month against the range. */
export function timeRangeIsDayGrain(timeRange) {
  const s = String(timeRange?.from ?? timeRange?.to ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Item 5: day-grain windows (this week, since 2024, the last 30 days, ...)
 * need the row's own exact date compared against the range, never its
 * truncated month — comparing '2026-09-10' against a month-grain '2026-09'
 * bound already works (documents/serviceVisits' existing month filtering),
 * but a WEEK-grain range needs day precision or every day in the month would
 * wrongly match. `row` is {date, month} — date is the row's own YYYY-MM-DD
 * (or null if never extracted), month its YYYY-MM truncation.
 */
export function withinTimeRange(row, timeRange) {
  if (!timeRange) return true;
  if (timeRangeIsDayGrain(timeRange)) {
    const d = row?.date ?? null;
    if (!d) return false;
    if (timeRange.from && d < timeRange.from) return false;
    if (timeRange.to && d > timeRange.to) return false;
    return true;
  }
  const m = row?.month ?? '';
  if (timeRange.from && m < timeRange.from.slice(0, 7)) return false;
  if (timeRange.to && m > timeRange.to.slice(0, 7)) return false;
  return true;
}

/**
 * Validate + normalize the model's raw tool_use input against the closed
 * vocabulary. Returns a clean plan object, or null if ANYTHING is outside the
 * vocabulary — the whole plan is rejected rather than silently dropping one
 * bad filter, because a silently-dropped filter changes what question is
 * actually being answered without anyone knowing.
 */
export function validatePlan(raw) {
  const p = raw && typeof raw === 'object' ? raw : null;
  if (!p) return null;
  if (!ENTITIES.includes(p.entity)) return null;
  if (!OPS.includes(p.op)) return null;
  if (p.op === 'groupBy' && !GROUP_BY_FIELDS.includes(p.groupBy)) return null;
  const groupBy = p.op === 'groupBy' ? p.groupBy : undefined;

  const rawFilters = Array.isArray(p.filters) ? p.filters : [];
  const filters = [];
  for (const f of rawFilters) {
    if (!f || typeof f !== 'object') return null;
    if (!FILTER_FIELDS.includes(f.field)) return null;
    if (!FILTER_OPS.includes(f.op)) return null;
    if (f.value === undefined || f.value === null || f.value === '') return null;
    if (f.op === 'in' && !Array.isArray(f.value)) return null;
    if (f.field === 'warrantyStatus' && !WARRANTY_STATUSES.includes(String(f.value).toLowerCase())) return null;
    if (BOOLEAN_FILTER_FIELDS.includes(f.field)) {
      // hasEmail/hasPhone: customers-only, boolean-only, op "eq" only — a
      // closed enough shape that "in"/"gt"/etc make no sense and are rejected
      // rather than silently coerced. Accepts true/false or the strings
      // "true"/"false" (Haiku's tool_use JSON occasionally stringifies a
      // boolean argument) and normalizes to a real boolean either way.
      if (p.entity !== 'customers' || f.op !== 'eq') return null;
      const s = String(f.value).toLowerCase();
      if (f.value !== true && f.value !== false && s !== 'true' && s !== 'false') return null;
      filters.push({ field: f.field, op: f.op, value: f.value === true || s === 'true' });
      continue;
    }
    if (DOC_TYPE_FILTER_FIELDS.includes(f.field)) {
      // hasDocType/lacksDocType: customers-only, op "eq" only, value a real
      // canonical document type id — see this constant's own doc comment.
      if (p.entity !== 'customers' || f.op !== 'eq') return null;
      if (!DOCUMENT_TYPE_IDS.has(String(f.value))) return null;
      filters.push({ field: f.field, op: f.op, value: String(f.value) });
      continue;
    }
    filters.push({ field: f.field, op: f.op, value: f.value });
  }

  let timeRange;
  if (p.timeRange && typeof p.timeRange === 'object') {
    const { from, to } = p.timeRange;
    const okFrom = from == null || /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(from));
    const okTo = to == null || /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(to));
    if (!okFrom || !okTo) return null;
    if (from || to) timeRange = { from: from ?? null, to: to ?? null };
  }

  let limit = DEFAULT_LIMIT;
  if (p.limit != null) {
    const n = Number(p.limit);
    if (!Number.isFinite(n) || n < 1) return null;
    limit = Math.min(Math.trunc(n), MAX_LIMIT);
  }

  // "who's our biggest customer" (round 4, item 1) — only meaningful for
  // customers/list; an out-of-vocabulary value rejects the WHOLE plan, same
  // as any other field. Always caps to TOP_CUSTOMERS_LIMIT regardless of any
  // `limit` the model also set — "top 10" is what was asked, not "top 500".
  let sortBy;
  if (p.sortBy != null) {
    if (!SORT_FIELDS.includes(p.sortBy) || p.entity !== 'customers' || p.op !== 'list') return null;
    sortBy = p.sortBy;
    limit = Math.min(limit, TOP_CUSTOMERS_LIMIT);
  }

  return { entity: p.entity, op: p.op, groupBy, filters, timeRange, limit, sortBy };
}

/* =================================================================== geo */

/** "Arizona"/"AZ"/"az" -> "AZ"; a bare 2-letter code passed through
 *  uppercased; anything else returned uppercased as a best-effort code. Never
 *  guesses a state from nothing. */
const STATE_NAME_TO_CODE = { arizona: 'AZ' };

export function normalizeStateValue(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (STATE_NAME_TO_CODE[s]) return STATE_NAME_TO_CODE[s];
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return String(raw).trim().toUpperCase();
}

/** 2-letter state code from a free-text address's trailing "..., AZ 85234" or
 *  "...AZ 85234" (no comma). Also recognizes a spelled-out "Arizona" tail. */
export function deriveState(address) {
  const s = String(address ?? '');
  const m = s.match(/\b([A-Z]{2})\s*\d{5}(?:-\d{4})?\s*$/);
  if (m) return m[1];
  const m2 = s.match(/,\s*([A-Za-z]{2})\s*$/);
  if (m2 && /^[A-Za-z]{2}$/.test(m2[1])) return m2[1].toUpperCase();
  if (/\barizona\b/i.test(s)) return 'AZ';
  return null;
}

/** 5-digit ZIP from a free-text address (a 9-digit ZIP+4 is truncated to its
 *  first 5, the USPS delivery-area digits county lookups key off). */
export function deriveZip(address) {
  const m = String(address ?? '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
  return m ? m[1] : null;
}

/** ZIP -> county, via the 3-digit default plus 5-digit exceptions in
 *  zip-county.json. Returns null (never a guess) for a ZIP outside the AZ
 *  850-865 range this table covers. */
export function countyForZip(zip) {
  const z = String(zip ?? '').trim();
  if (!/^\d{5}$/.test(z)) return null;
  if (zipCounty.azZipExceptions[z]) return zipCounty.azZipExceptions[z];
  const prefix = z.slice(0, 3);
  return zipCounty.azZip3Default[prefix] ?? null;
}

/** city (+ optional state) -> county, via the bundled fallback tables. AZ
 *  cities are checked first (this product's home state); a US city outside
 *  AZ falls back to usCityCounty, keyed "city|state" — an unrecognized city
 *  returns null rather than a guess. */
export function countyForCity(city, state) {
  const c = String(city ?? '').trim().toLowerCase();
  if (!c) return null;
  if (zipCounty.azCityCounty[c] && (!state || normalizeStateValue(state) === 'AZ')) {
    return zipCounty.azCityCounty[c];
  }
  const st = state ? normalizeStateValue(state).toLowerCase() : null;
  if (st) {
    const hit = zipCounty.usCityCounty[`${c}|${st}`];
    if (hit) return hit.county;
  }
  // No state given (or it didn't match) — try any US entry for this city name.
  for (const [key, v] of Object.entries(zipCounty.usCityCounty)) {
    if (key.startsWith(`${c}|`)) return v.county;
  }
  return zipCounty.azCityCounty[c] ?? null;
}

/** Full derivation from a raw service_address: {city, state, zip, county}.
 *  Each field is independently best-effort and any of them may be null —
 *  callers bucket a null county as "Unknown", never as 0/omitted. */
export function deriveGeo(address) {
  const city = deriveCity(address);
  const state = deriveState(address);
  const zip = deriveZip(address);
  let county = zip ? countyForZip(zip) : null;
  if (!county && city) county = countyForCity(city, state);
  return { city, state, zip, county };
}

export const UNKNOWN_BUCKET = 'Unknown';

/* ============================================================ filter matching
 *
 * Pure predicate matching, applied client-side (in JS) to already-fetched
 * rows for every field the SQL layer can't cleanly express as a single
 * parameterized column comparison (city/county/state/zip are all derived from
 * one free-text address column; warrantyStatus is a computed tier, not a
 * column). The SQL builder (below) still narrows what's fetched wherever a
 * field maps directly to one column — this is the closing check that makes
 * the closed vocabulary authoritative regardless of what SQL narrowed.
 */
function coerceNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** hasEmail/hasPhone read the row's own `email`/`phone` property (its
 *  presence/non-blankness), never a literal `row.hasEmail` field — see
 *  shapeCustomerRow (routes/analytics.js), which is the only row shape that
 *  carries these two properties at all. */
const HAS_FIELD_ROW_KEY = { hasEmail: 'email', hasPhone: 'phone' };

export function matchesFilter(row, filter) {
  const { field, op, value } = filter;
  if (field in HAS_FIELD_ROW_KEY) {
    const raw = row[HAS_FIELD_ROW_KEY[field]];
    const has = raw != null && String(raw).trim() !== '';
    return has === (value === true);
  }
  const actual = row[field];
  if (op === 'in') {
    const arr = Array.isArray(value) ? value : [value];
    return arr.some((v) => matchesFilter(row, { field, op: 'eq', value: v }));
  }
  if (actual === null || actual === undefined) return false;
  if (op === 'eq' || op === 'neq') {
    const a = String(actual).toLowerCase();
    const b = String(value).toLowerCase();
    return op === 'eq' ? a === b : a !== b;
  }
  if (op === 'contains') return String(actual).toLowerCase().includes(String(value).toLowerCase());
  const an = coerceNumber(actual);
  const bn = coerceNumber(value);
  if (an === null || bn === null) return false;
  if (op === 'gt') return an > bn;
  if (op === 'gte') return an >= bn;
  if (op === 'lt') return an < bn;
  if (op === 'lte') return an <= bn;
  return false;
}

export function matchesAllFilters(row, filters) {
  return (filters ?? []).every((f) => matchesFilter(row, f));
}

/* =================================================================== SQL builder
 *
 * Pure: entity -> {sql, params}. Whitelisted columns and operators only — the
 * model never contributes a single character of SQL text, only the `plan`
 * object validatePlan already checked against the closed vocabulary above.
 * Every string embedded here is a fixed column/table name from this file, not
 * user or model input; every actual VALUE goes in as a $N parameter.
 *
 * Only filters that map to ONE real column are pushed into the WHERE clause
 * (a cheap, safe narrowing); the rest (city/county/state/zip/warrantyStatus/
 * month/technician-on-equipment) are left for matchesAllFilters/groupKey to
 * apply in JS after the fetch — see the module comment above. This keeps the
 * SQL small and testable as a fixture (scripts/verify-analytics.mjs) with no
 * database, while still means the model itself never determines what SQL
 * text runs — only which of these fixed, pre-written statements is used and
 * which already-whitelisted column each $N binds to.
 */
const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

// field -> a single real column expression, for the entity(ies) it applies to.
const SQL_COLUMN = {
  customers: { customerName: "data->>'customer_name'" },
  equipment: {
    brand: "data->>'manufacturer'",
    model: "data->>'model'",
    equipmentType: "data->>'equipment_type'",
    refrigerant: "data->>'refrigerant'",
  },
  documents: { documentType: 'document_type' },
};

/** hasEmail/hasPhone (item 2): not a plain column comparison (there is no
 *  value to bind — "IS NOT NULL AND <> ''" takes no parameter), so these are
 *  handled separately from pushColumnFilter/SQL_COLUMN below rather than
 *  forced into that shape. Column names are fixed text from this file, never
 *  model input, exactly like every other column expression in this file. */
const HAS_FIELD_COLUMN = { hasEmail: "data->>'email'", hasPhone: "data->>'phone'" };

const SQL_OP = { eq: '=', neq: '<>', contains: 'ILIKE', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function pushColumnFilter(where, params, column, filter) {
  if (filter.op === 'in') {
    const arr = Array.isArray(filter.value) ? filter.value : [filter.value];
    const placeholders = arr.map((v) => {
      params.push(String(v));
      return `$${params.length}`;
    });
    where.push(`${column} IN (${placeholders.join(', ')})`);
    return;
  }
  const sqlOp = SQL_OP[filter.op];
  if (!sqlOp) return; // not SQL-expressible (e.g. contains handled below) — left to JS
  if (filter.op === 'contains') {
    params.push(`%${filter.value}%`);
    where.push(`${column} ILIKE $${params.length}`);
    return;
  }
  params.push(String(filter.value));
  where.push(`${column} ${sqlOp} $${params.length}`);
}

/** @returns {{sql: string, params: any[]}} */
export function buildAnalyticsSQL(plan) {
  const where = [TENANT_SQL];
  const params = [];
  const columnsFor = SQL_COLUMN[plan.entity === 'warranties' ? 'equipment' : plan.entity] ?? {};
  for (const f of plan.filters ?? []) {
    if (f.field in HAS_FIELD_COLUMN) {
      const col = HAS_FIELD_COLUMN[f.field];
      where.push(f.value ? `(${col} IS NOT NULL AND ${col} <> '')` : `(${col} IS NULL OR ${col} = '')`);
      continue;
    }
    const col = columnsFor[f.field];
    if (col) pushColumnFilter(where, params, col, f);
  }

  if (plan.entity === 'customers') {
    return {
      sql: `SELECT id, customer_number, data->>'customer_name' AS customer_name,
                   data->>'service_address' AS service_address,
                   data->>'email' AS email, data->>'phone' AS phone, updated_at
              FROM entities
             WHERE entity_type = 'customer' AND merged_into IS NULL AND ${where.join(' AND ')}
             ORDER BY updated_at DESC
             LIMIT ${MAX_LIMIT}`,
      params,
    };
  }
  if (plan.entity === 'equipment' || plan.entity === 'warranties') {
    return {
      sql: `SELECT id, customer_id, data->>'model' AS model, data->>'manufacturer' AS manufacturer,
                   data->>'equipment_type' AS equipment_type, data->>'tonnage' AS tonnage,
                   data->>'refrigerant' AS refrigerant, data->>'installation_date' AS installation_date,
                   data->>'service_address' AS service_address, data->'warranty' AS warranty, updated_at
              FROM entities
             WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${where.join(' AND ')}
             ORDER BY updated_at DESC
             LIMIT ${MAX_LIMIT}`,
      params,
    };
  }
  if (plan.entity === 'documents') {
    // Item 1 (2026-09-21 live miss): "how many jobs/documents/invoices did we
    // do IN AUGUST" means the month the WORK happened, not the month the
    // paper was uploaded — documents.created_at is upload time and has no
    // reliable relationship to it (a job done in August scanned in October
    // would be missed entirely; an old backlog batch-uploaded in August would
    // be wrongly counted). extractions.field_key = 'service_date' (see
    // extractFields.js FIELD_SPECS) is the real job/service date; documents
    // itself has no such column (see M3-config/01-create-schema.sql), so it
    // is pulled via a correlated scalar subquery, same tenant scope as the
    // outer query, most-recent value per document. shapeDocumentRow (below)
    // falls back to created_at only for a document with no service_date
    // extraction at all, so a doc-count with no time filter is unaffected.
    return {
      sql: `SELECT d.id, d.document_type, d.original_filename, d.created_at,
                   (SELECT x.value FROM extractions x
                     WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
                     ORDER BY x.created_at DESC LIMIT 1) AS service_date
              FROM documents d
             WHERE ${where.join(' AND ')}
             ORDER BY d.created_at DESC
             LIMIT ${MAX_LIMIT}`,
      params,
    };
  }
  // serviceVisits: two field_keys off `extractions`, merged in JS (routes/analytics.js) —
  // no single row here carries both service_date and technician, so this returns
  // the base set (service_date rows); the executor runs a second, identically
  // shaped query for field_key = 'technician' and joins by document_id itself.
  //
  // Live miss (2026-09-21, "which units had service this month"): a bare
  // service_date row names no unit or customer at all — "which units/
  // customers had service this month" had nothing to list. Two cheap
  // correlated scalar subqueries, both tenant-scoped identically to the outer
  // query and to the documents branch's own service_date lookup above: the
  // document's linked CUSTOMER entity (via document_entity_links — a document
  // can link to a customer and/or equipment entity; entity_type = 'customer'
  // picks only the customer one, so a document also linked to an equipment
  // entity can never fan this out into two rows) for the customer's name, and
  // the document's own 'model' extraction for the unit. Most-recent-row-wins
  // (ORDER BY ... DESC LIMIT 1) on both, same idiom as service_date itself.
  return {
    // ROOT CAUSE of every live service-visit miss up to 2026-09-21: this
    // SELECT used to read `x.stage`, but `stage` is a documents column —
    // extractions has none (M3-config/01) — so Postgres rejected the query
    // and runAnalyticsQuestion's catch fell through to retrieval for EVERY
    // serviceVisits plan. Mock-db tests never executed real SQL, so it was
    // invisible offline. Columns here are checked against the schema file by
    // scripts/verify-analytics.mjs now.
    sql: `SELECT x.document_id, x.value, x.confidence,
                 (SELECT c.data->>'customer_name'
                    FROM document_entity_links l
                    JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer'
                                   AND c.merged_into IS NULL AND c.${TENANT_SQL}
                   WHERE l.document_id = x.document_id AND l.${TENANT_SQL}
                   ORDER BY l.created_at DESC LIMIT 1) AS customer_name,
                 (SELECT m.value FROM extractions m
                   WHERE m.document_id = x.document_id AND m.field_key = 'model' AND m.${TENANT_SQL}
                   ORDER BY m.created_at DESC LIMIT 1) AS model
            FROM extractions x
           WHERE x.field_key = 'service_date' AND ${TENANT_SQL}
           ORDER BY x.value DESC
           LIMIT ${MAX_LIMIT}`,
    params: [],
  };
}

/* =================================================================== formatting
 *
 * Deterministic text — NO second model call. Everything the user reads here
 * is composed from real counts/rows, in code, per the brief's design.
 */

/** Bucket rows by the plan's groupBy field into an ordered [{key, count}]
 *  list (largest first, "Unknown" always last regardless of count so a real
 *  place always outranks the leftover bucket at a glance). `keyOf` extracts
 *  the group key from one already-shaped row (see routes/analytics.js). */
export function groupRows(rows, keyOf) {
  const counts = new Map();
  for (const r of rows) {
    const k = keyOf(r) ?? UNKNOWN_BUCKET;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  entries.sort((a, b) => {
    if (a[0] === UNKNOWN_BUCKET) return 1;
    if (b[0] === UNKNOWN_BUCKET) return -1;
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  });
  return entries.map(([key, count]) => ({ key, count }));
}

const ENTITY_NOUN = {
  customers: (n) => `customer${n === 1 ? '' : 's'}`,
  equipment: (n) => `piece${n === 1 ? '' : 's'} of equipment`,
  documents: (n) => `document${n === 1 ? '' : 's'}`,
  serviceVisits: (n) => `service visit${n === 1 ? '' : 's'}`,
  warranties: (n) => `unit${n === 1 ? '' : 's'}`,
};

const GROUP_LABEL = {
  city: 'city', county: 'county', state: 'state', zip: 'ZIP', brand: 'brand',
  documentType: 'document type', month: 'month', technician: 'technician', warrantyStatus: 'warranty status',
};

/** "September 3, 2026" from a YYYY-MM-DD service_date value, "September 2026"
 *  from a bare YYYY-MM one, or the raw string as a last resort — used only by
 *  the serviceVisits zero-result wording below. Never throws on a garbled
 *  value; it just falls back to printing whatever was there. */
function formatServiceDateLabel(rawDate) {
  const s = String(rawDate ?? '').trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (full) {
    const idx = Number(full[2]) - 1;
    if (idx >= 0 && idx <= 11) return `${MONTH_LABELS[idx]} ${Number(full[3])}, ${full[1]}`;
  }
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(s);
  if (monthOnly) {
    const idx = Number(monthOnly[2]) - 1;
    if (idx >= 0 && idx <= 11) return `${MONTH_LABELS[idx]} ${monthOnly[1]}`;
  }
  return s || 'an unknown date';
}

/** Cap on how many groupBy/list rows go into `facts` — the client's "compact
 *  table" (see AnswerCard/FactGrid). Anything past this is summarized in
 *  `text` as "... and N more" rather than growing the response without bound.
 *  Reviewer NO-GO (2026-09-21, round 2, gap 2): 12 was too low for a live
 *  "which customers have Trane units" style answer ("18 customers — showing
 *  the first 12" cut off a third of them) — raised to 50, still bounded, and
 *  FactGrid's GroupTable (src/components/FactGrid.tsx) stays a compact
 *  one-line-per-row table at 50 rows exactly as it already did at 12. */
export const MAX_FACT_ROWS = 50;

/**
 * @param plan       the validated plan
 * @param opts.total total rows the executor scoped to the filters, BEFORE
 *                    LIMIT is applied — used for the "(of N in Arizona)"-style
 *                    parenthetical when a filter narrowed the population.
 * @param opts.groups groupRows() output, for op 'groupBy'.
 * @param opts.rows   individual matched rows (already shaped {label, value,
 *                    entityId?}), for op 'list'.
 * @param opts.sum    the computed total, for op 'sum'.
 * @param opts.unfilteredTotal total for the SAME entity with no filters at
 *                    all — powers the ambiguity rule (0 results -> tell them
 *                    what DOES exist) and the "(of 31 in Arizona)" framing.
 * @param opts.broaderLabel/broaderGroups  for the ambiguity rule (rule 5):
 *                    when a named filter value matches zero rows, name what
 *                    the tenant's data actually has instead.
 */

/** "Customers with an email on file" / "Customers missing a phone number" —
 *  item 2 (2026-09-21): a hasEmail/hasPhone-filtered count needs a fact label
 *  that says WHICH condition was counted, not the generic "Customers" a plain
 *  count gets. Both filters together ("have an email and a phone") join with
 *  "and". Returns null when neither filter is present, so callers fall back
 *  to the generic noun-based label. */
function customerContactFactLabel(entity, filters) {
  if (entity !== 'customers') return null;
  const parts = [];
  const email = (filters ?? []).find((f) => f.field === 'hasEmail');
  const phone = (filters ?? []).find((f) => f.field === 'hasPhone');
  if (email) parts.push(email.value ? 'with an email on file' : 'missing an email address');
  if (phone) parts.push(phone.value ? 'with a phone number on file' : 'missing a phone number');
  return parts.length ? `Customers ${parts.join(' and ')}` : null;
}

/** "Carrier units" instead of the generic "Pieces of equipment" — a
 *  brand-filtered equipment/warranties count should name the brand it was
 *  actually filtered to. Returns null when no brand filter (eq/in) is
 *  present, so callers fall back to the generic noun-based label. */
function brandFactLabel(entity, filters) {
  if (entity !== 'equipment' && entity !== 'warranties') return null;
  const f = (filters ?? []).find((x) => x.field === 'brand' && (x.op === 'eq' || x.op === 'in'));
  if (!f) return null;
  const brand = Array.isArray(f.value) ? f.value[0] : f.value;
  return brand ? `${brand} units` : null;
}

export function formatAnalyticsAnswer(plan, opts) {
  const {
    total = 0, groups = [], rows = [], sum = null, unfilteredTotal = null, broaderGroups = null,
    mostRecentServiceVisit, timeRangeLabel = null,
  } = opts ?? {};
  const noun = (ENTITY_NOUN[plan.entity] ?? (() => plan.entity))(total);

  // "who's our biggest customer" (round 4, item 1) — a ranked list, not a
  // filtered/counted one; its own wording so the answer reads as a ranking
  // ("Your top 3 customers by equipment count:") rather than a bare count.
  if (plan.sortBy) {
    const measure = plan.sortBy === 'documentCount' ? 'document count' : 'equipment count';
    const text = total === 0
      ? 'No customers on file yet.'
      : `Your top ${total} customer${total === 1 ? '' : 's'} by ${measure}: ${rows.map((r) => `${r.label} (${r.value})`).join(', ')}.`;
    return {
      kind: 'answer', text,
      facts: rows.map((r) => ({ label: r.label, value: r.value ?? '—', entityId: r.entityId, sources: [] })),
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  // Zero-result wording for a timeRange'd serviceVisits question (2026-09-21
  // "which units had service this month" cluster): the owner's account
  // genuinely has zero service visits in the asked-about range, and a bare
  // "0 service visits match that" (or, worse, a fall-through to retrieval's
  // "Nothing in your records answers that") is technically true but useless.
  // An honest zero needs the same kind of context the geo ambiguity rule
  // below gives a named filter that matched nothing: when the most recent
  // visit actually WAS. mostRecentServiceVisit is only ever passed for entity
  // 'serviceVisits' (see executeAnalyticsPlan, routes/analytics.js) — null
  // means the tenant has no service visits on file at all, ever; an object
  // names the single most recent one (rows are already fetched sorted DESC by
  // date, so this costs no extra query).
  if (plan.entity === 'serviceVisits' && plan.timeRange && total === 0 && mostRecentServiceVisit !== undefined) {
    // Item 5 (2026-09-22): timeRangeLabel covers the extended day-grain
    // windows (this week, since 2024, ...) formatAnalyticsAnswer itself has
    // no way to reverse-engineer from {from,to} alone — see
    // resolveAnyTimeRange's own doc comment. Falls back to the original
    // month-only label when the caller didn't pass one (e.g. a plan whose
    // timeRange came from the model's own well-formed, year-matching guess).
    // timeRangeLabel (item 5, 2026-09-22) already carries its own connector
    // word where one reads naturally ("in Q2 2026", "since 2024") and none
    // where it doesn't ("this week", "year to date") — never re-prefixed
    // with "in " here. The bare monthRangeLabel fallback (no connector of
    // its own) keeps needing one, exactly as before this existed.
    const monthLabel = monthRangeLabel(plan.timeRange);
    const scope = timeRangeLabel ? ` ${timeRangeLabel}` : monthLabel ? ` in ${monthLabel}` : '';
    const text = mostRecentServiceVisit
      ? `No service visits${scope}. The most recent one on file is ` +
        `${formatServiceDateLabel(mostRecentServiceVisit.date)}` +
        `${mostRecentServiceVisit.customer ? ` (${mostRecentServiceVisit.customer})` : ''}.`
      : 'No service visits on file yet.';
    return { kind: 'answer', text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] };
  }

  // ---- ambiguity rule (design point 5): a named filter matched zero rows,
  // but the tenant does have data for this entity elsewhere -> say so instead
  // of a bare "0". ----
  if (total === 0 && plan.filters?.length && broaderGroups?.length) {
    const named = broaderGroups.slice(0, 4).map((g) => `${g.key} (${g.count})`).join(', ');
    const text = `0 ${noun} match that — your ${plan.entity} are in ${named}${broaderGroups.length > 4 ? ', and others' : ''}.`;
    return { kind: 'answer', text, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] };
  }

  if (plan.op === 'count') {
    const of = unfilteredTotal != null && unfilteredTotal !== total ? ` (of ${unfilteredTotal} total)` : '';
    // Item 1: "N jobs in August 2026" style, once there's a real single-month
    // range to name — otherwise the plain "You have N X" wording. Item 5
    // (2026-09-22): timeRangeLabel covers the extended day-grain windows
    // ("this week", "year to date", "since 2024", ...) the same way — see
    // the serviceVisits zero-result branch above for why it's never
    // re-prefixed with "in " here.
    const monthLabel = monthRangeLabel(plan.timeRange);
    const scopedText = timeRangeLabel
      ? `${total} ${noun} ${timeRangeLabel}${of}.`
      : monthLabel
        ? `${total} ${noun} in ${monthLabel}${of}.`
        : null;
    const text = scopedText ?? `You have ${total} ${noun}${of}.`;
    const label =
      customerContactFactLabel(plan.entity, plan.filters) ??
      brandFactLabel(plan.entity, plan.filters) ??
      noun[0].toUpperCase() + noun.slice(1);
    return {
      kind: 'answer', text,
      facts: [{ label, value: String(total), sources: [] }],
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  if (plan.op === 'sum') {
    const formatted = Number.isFinite(sum) ? sum.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '0';
    const text = `${formatted} across ${total} ${noun}.`;
    return {
      kind: 'answer', text,
      facts: [{ label: 'Total', value: formatted, sources: [] }],
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  if (plan.op === 'groupBy') {
    const shown = groups.slice(0, MAX_FACT_ROWS);
    const rest = groups.length - shown.length;
    const breakdown = shown.map((g) => `${g.key} ${g.count}`).join(', ');
    const of = unfilteredTotal != null && unfilteredTotal !== total ? ` (of ${unfilteredTotal} total)` : '';
    const more = rest > 0 ? `, and ${rest} more ${GROUP_LABEL[plan.groupBy] ?? plan.groupBy}${rest === 1 ? '' : 's'}` : '';
    const text = `You have ${total} ${noun}${of} by ${GROUP_LABEL[plan.groupBy] ?? plan.groupBy}: ${breakdown}${more}.`;
    return {
      kind: 'answer', text,
      facts: shown.map((g) => ({ label: g.key, value: String(g.count), sources: [] })),
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  // op === 'list'
  const shown = rows.slice(0, MAX_FACT_ROWS);
  const rest = total - shown.length;
  // Reviewer NO-GO (2026-09-21, round 2, gap 2): "and N more" past the cap,
  // matching groupBy's own phrasing above, instead of a bare "showing the
  // first N" that never said how many were left out.
  const text = total === 0
    ? `No ${noun} match that.`
    : rest > 0
      ? `${total} ${noun} — showing ${shown.length}, and ${rest} more.`
      : `${total} ${noun}.`;
  return {
    kind: 'answer', text,
    facts: shown.map((r) => ({ label: r.label, value: r.value ?? '—', entityId: r.entityId, sources: [] })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

/** True brand-name filter value normalizes to a known BRAND_RULES key (or, if
 *  unrecognised, is at least compared case-insensitively as raw text) — used
 *  by routes/analytics.js so "Trane"/"trane"/"TRANE" all match the same rows
 *  regardless of how the manufacturer field was printed on the paperwork. */
export function brandMatches(manufacturerRaw, filterValue) {
  const normalized = normalizeBrand(manufacturerRaw);
  const target = normalizeBrand(filterValue) ?? String(filterValue ?? '').trim().toLowerCase();
  if (normalized && normalized === target) return true;
  return String(manufacturerRaw ?? '').trim().toLowerCase() === String(filterValue ?? '').trim().toLowerCase();
}

/** installYear from a raw installation_date extraction value (YYYY-MM-DD,
 *  YYYY-MM, or any string starting with a 4-digit year) — or null. */
export function installYearOf(installationDate) {
  const m = String(installationDate ?? '').match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** warrantyStatus bucket ('active'|'expiring'|'expired'|'unknown') from an
 *  equipment row's alertTier — folds the three "expiring-*" tiers together, a
 *  dispatcher asking "expiring" doesn't care whether it's in 20 or 80 days. */
export function warrantyStatusOf(warranty, today) {
  const tier = alertTier(warranty, today);
  if (tier === 'expired') return 'expired';
  if (tier === 'ok') return 'active';
  if (tier === 'unknown') return 'unknown';
  return 'expiring'; // expiring-30 / expiring-90 / expiring-365 / unregistered-window-closing
}
