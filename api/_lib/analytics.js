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
import { alertTier, normalizeBrand, BRAND_RULES } from './warrantyRules.js';

// Plain readFileSync + JSON.parse rather than an import attribute (`with {
// type: 'json' }`) — same idiom claude.js already uses for .env.local, and it
// avoids depending on every downstream bundler/typechecker (Vercel, tsc,
// tsx-run verify scripts) supporting import-attribute syntax for a file that
// only ever needs to be read once, synchronously, at module load.
const __dirname = dirname(fileURLToPath(import.meta.url));
const zipCounty = JSON.parse(readFileSync(join(__dirname, 'geo', 'zip-county.json'), 'utf8'));

/* ============================================================ plan vocabulary */

export const ENTITIES = ['customers', 'equipment', 'documents', 'serviceVisits', 'warranties'];
export const OPS = ['count', 'list', 'groupBy', 'sum'];
export const GROUP_BY_FIELDS = ['city', 'county', 'state', 'zip', 'brand', 'documentType', 'month', 'technician', 'warrantyStatus'];
/** Closed field vocabulary a filter's `field` must be one of — see the brief. */
export const FILTER_FIELDS = [
  'state', 'county', 'city', 'zip', 'brand', 'model', 'equipmentType', 'tonnage',
  'refrigerant', 'installYear', 'warrantyStatus', 'documentType', 'technician', 'customerName',
];
export const FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in'];
export const WARRANTY_STATUSES = ['active', 'expiring', 'expired', 'unknown'];
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 500;

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
const AGGREGATE_NOUN = /\b(customers?|clients?|units?|equipment|pieces? of equipment|documents?|invoices?|warrant(?:y|ies)|records?)\b/i;
const QUANTIFIER = /\b(how many|count|list|which|show me|total)\b/i;
const CONTEXT = /\b(in|from|by|of|older than|newer than|out of warranty|under warranty|expiring|expired|active|unknown|warranty status|this month|last month|this year|county|arizona|\baz\b|city|state|zip|brand|technician)\b/i;
/** "group X by Y" / "breakdown by Y" / "grouped by Y" — an aggregate-request
 *  shape regardless of which noun is being broken down, so a groupBy
 *  dimension word alone (technician, brand, month) is enough even without one
 *  of AGGREGATE_NOUN's fixed nouns ("show me a breakdown by technician"). */
const GROUP_SHAPE_RE = /\b(group(?:ed)?\b[\s\S]*\bby\b|breakdown\b[\s\S]*\bby\b|\bby\b\s+(city|county|state|zip|brand|month|technician|warranty status)\b)/i;
const WHO_SERVICED_RE = /\bwho did we (service|work for)\b/i;
const WHICH_CUSTOMERS_RE = /\bwhich customers\b/i;
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
/**
 * Every accepted brand spelling (BRAND_RULES' labels + aliases,
 * warrantyRules.js — the SAME list normalizeBrand/brandMatches already
 * recognize, so the classifier never knows a brand name the planner
 * couldn't also resolve), so "how many Trane units" / "how many Goodman
 * units" pass CONTEXT even though neither names any of CONTEXT's other
 * generic words (a county, "brand", a time range, ...). Built once at module
 * load, not hand-duplicated, so a brand added to warrantyRules.js is
 * recognized here for free.
 */
const BRAND_NAME_RE = new RegExp(
  `\\b(${[...new Set(Object.values(BRAND_RULES).flatMap((v) => [v.label, ...(v.aliases ?? [])]))]
    .map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i'
);
/** "how many documents does Plaza Dental have" / "does X have a warranty" —
 *  a single, named record's own attribute, not an aggregate across many. */
const POSSESSIVE_SINGLE_RE = /\b(does|did)\s+[\s\S]+\b(have|has|need)\b/i;

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
const STREET_ADDRESS_RE =
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
const AT_ADDRESS_RE = /\bat\s+\d{1,6}\s+\w/i;
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

/** True when the question names one specific record (a street address, an
 *  "at <number> <word>" reference, or a serial/model-shaped token) rather
 *  than asking about many. Exported so routes/analytics.js and
 *  scripts/verify-analytics.mjs can both exercise it directly. */
export function looksLikeSingleRecordReference(question) {
  const q = String(question ?? '');
  return STREET_ADDRESS_RE.test(q) || AT_ADDRESS_RE.test(q) || looksLikeIdentifierToken(q);
}

export function preClassifyAnalytics(question) {
  const q = String(question ?? '').trim();
  if (!q) return false;
  if (looksLikeSingleRecordReference(q)) return false;
  if (POSSESSIVE_SINGLE_RE.test(q)) return false;
  if (
    WHO_SERVICED_RE.test(q) ||
    WHICH_CUSTOMERS_RE.test(q) ||
    GROUP_SHAPE_RE.test(q) ||
    WHO_HAS_RE.test(q) ||
    NOUN_WITH_RE.test(q) ||
    (AGGREGATE_NOUN.test(q) && AGE_FILTER_RE.test(q))
  ) {
    return true;
  }
  return QUANTIFIER.test(q) && AGGREGATE_NOUN.test(q) && (CONTEXT.test(q) || BRAND_NAME_RE.test(q));
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
                'year installed, for "older/newer than N years" compute the year and use op gt/lt.',
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
    },
    required: ['entity', 'op'],
  },
};

export const ANALYTICS_SYSTEM_PROMPT =
  'You turn an HVAC dispatch company\'s counting/listing/grouping question into a query plan ' +
  'using the "analytics_plan" tool. You never see or write SQL, and you never answer the question ' +
  'yourself — you only choose entity/op/groupBy/filters from the closed vocabulary the tool schema ' +
  'declares. "Arizona"/"AZ"/"arizona" always means the state filter value "AZ". A bare county name ' +
  '("Maricopa", "Pima") means the county filter with that name, no "County" suffix. A brand name ' +
  '(Trane, Carrier, Goodman, Lennox, Rheem, York, Daikin, Mitsubishi, ...) means the brand filter. ' +
  '"this month"/"last month"/a named month means timeRange. If the question names no entity, assume ' +
  '"customers". Always call the tool exactly once.';

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
export const ANALYTICS_VERSION = 'analytics-v1';
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
  });
}

/** Tier 2: namespaced by the PLAN's own canonical JSON, so distinct plans can
 *  never collide (the hash IS a digest of the plan) and two differently-
 *  worded questions that resolve to the identical plan share one cached
 *  answer instead of paying for the same SQL twice. */
export function analyticsPlanHash(plan) {
  return sha256Hex(`analytics-plan:${canonicalPlanString(plan)}`);
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

  return { entity: p.entity, op: p.op, groupBy, filters, timeRange, limit };
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

export function matchesFilter(row, filter) {
  const { field, op, value } = filter;
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
    const col = columnsFor[f.field];
    if (col) pushColumnFilter(where, params, col, f);
  }

  if (plan.entity === 'customers') {
    return {
      sql: `SELECT id, customer_number, data->>'customer_name' AS customer_name,
                   data->>'service_address' AS service_address, updated_at
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
    return {
      sql: `SELECT id, document_type, original_filename, created_at
              FROM documents
             WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT ${MAX_LIMIT}`,
      params,
    };
  }
  // serviceVisits: two field_keys off `extractions`, merged in JS (routes/analytics.js) —
  // no single row here carries both service_date and technician, so this returns
  // the base set (service_date rows); the executor runs a second, identically
  // shaped query for field_key = 'technician' and joins by document_id itself.
  return {
    sql: `SELECT x.document_id, x.value, x.confidence, x.stage
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
export function formatAnalyticsAnswer(plan, opts) {
  const { total = 0, groups = [], rows = [], sum = null, unfilteredTotal = null, broaderGroups = null } = opts ?? {};
  const noun = (ENTITY_NOUN[plan.entity] ?? (() => plan.entity))(total);

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
    const text = `You have ${total} ${noun}${of}.`;
    return {
      kind: 'answer', text,
      facts: [{ label: noun[0].toUpperCase() + noun.slice(1), value: String(total), sources: [] }],
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
