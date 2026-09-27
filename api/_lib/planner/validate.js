/**
 * ROUND 20 (J4, credit-return readiness), task 1.
 *
 * THE #1 PROBLEM the R20 contract names is false confidence: a novel phrasing silently matched to an
 * unrelated template instead of returning null. Every plan the DETERMINISTIC planner
 * (analytics/detPlan.js) produces is code, not a guess, and is already trusted. A plan the MODEL
 * produces is a different animal — nothing stops a tool-use call from dropping a condition the
 * question actually named, or filling in a filter value the question never said at all (a hallucinated
 * brand/city/customer name is exactly as confident-looking as a real one). This file is the guard that
 * sits between "the model returned a plan" and "the executor trusts it": it is called ONCE, from
 * planAnalyticsQuestion's model-call section (routes/analytics.js), on the MODEL's raw tool_use input
 * only — never on the deterministic planner's output, which never passes through here.
 *
 * Reject, don't repair: unlike routes/analytics.js's own downstream missingConditions/
 * buildConditionOverrideFilter machinery (which tries to patch a plan that's missing something before
 * giving up), this file's job is to catch a model plan early and hand back null — the caller then falls
 * through exactly like any other planner miss, and ask.js's retrieval+model path (or an honest decline)
 * takes the question instead. That is a deliberately more conservative bar for MODEL output than for
 * code output, matching the R11 rule "never answer when a named condition can't be applied — return
 * null so the chain falls through."
 *
 * ADAPTER INTERFACE (ROUND 20, J1 wiring): `detectConstraints(question, opts)` now delegates to J1's
 * api/_lib/router/guard/constraints.js `extractConstraints` — the SAME question-side constraint parser
 * guard/check.js (the precision guard) runs against every deterministic answer — instead of the file's
 * own former local fallback straight over analytics.js's detectedConditions. One source of truth: a
 * phrasing the precision guard has learned to recognize (negation/comparator/distinct/superlative/
 * namedEntity, on top of every detectedConditions type it already reused) is now recognized here too,
 * with no separate vocabulary to drift out of sync. `findMissingConstraints` below still runs
 * analytics.js's own missingConditions for the original condition set (that function's plan-field
 * mapping is untouched), then separately checks the plan against the four EXTRA types
 * extractConstraints adds that missingConditions has no notion of at all — see that check's own doc
 * comment for why 'distinct'/'superlative' are unconditional (schema-verified: ANALYTICS_TOOL has no
 * property a raw model tool_use call could ever set for either) while 'comparator'/'negation' only flag
 * when the plan truly has no matching filter (both ARE legitimately model-expressible, per
 * ANALYTICS_TOOL's own field descriptions).
 */
import { missingConditions } from '../analytics.js';
import { DOCUMENT_TYPE_SYNONYMS } from '../documentTypes.js';
import { extractConstraints } from '../router/guard/constraints.js';

/**
 * Adapter seam (see doc comment above). Returns the Set of constraint type names extractConstraints
 * (guard/constraints.js, J1) recognizes in the question text — every detectedConditions type
 * (email/phone/brand/county/city/state/zip/month/money/maintenance/warranty/serviceType/the
 * cross-visit-relation and ratio idioms) PLUS negation/comparator/distinct/superlative/namedEntity.
 * `opts.tenantVocab` is optional and only widens namedEntity detection — every other type is unaffected
 * by it.
 */
export function detectConstraints(question, opts = {}) {
  return new Set(extractConstraints(question, opts).map((c) => c.type));
}

/** Constraint types extractConstraints (guard/constraints.js) adds ON TOP of analytics.js's own
 *  detectedConditions/missingConditions vocabulary — missingConditions has no CONDITION_PLAN_FIELD entry
 *  for any of these, so they need their own plan-level check here, not a second copy of that function's
 *  logic. */
const SCHEMA_NEVER_SET_BY_MODEL = new Set(['distinct', 'superlative']);

/** True when `plan` has at least one filter whose op is a numeric comparator (gt/gte/lt/lte) — the shape
 *  a real "more than X"/"older than N years" filter takes (ANALYTICS_TOOL's own field description tells
 *  the model to "compute the year and use op gt/lt" for installYear, so this constraint genuinely CAN be
 *  satisfied by a model plan, unlike distinct/superlative above). */
function planHasComparatorFilter(plan) {
  return (plan?.filters ?? []).some((f) => ['gt', 'gte', 'lt', 'lte'].includes(f?.op));
}

/** True when `plan` has at least one filter asserting a NEGATIVE/zero condition — a `lacks*` field
 *  (lacksDocType, lacksServiceType) or a `has*` field explicitly set to `false` (hasAnyDocument,
 *  hasAnyEquipment, hasEmail, ...) — the closed vocabulary a "zero X on file" plan would use. */
function planHasNegationFilter(plan) {
  return (plan?.filters ?? []).some(
    (f) => typeof f?.field === 'string' && (f.field.startsWith('lacks') || (f.field.startsWith('has') && f.value === false))
  );
}

/** The extra constraint types (beyond missingConditions' own set) `plan` does not account for, given what
 *  extractConstraints found in `question`. Returns a plain array of type strings — merged into
 *  findMissingConstraints' own Set below. */
function findExtraMissingConstraints(plan, question, opts) {
  const constraints = extractConstraints(question, opts);
  const missing = [];
  for (const c of constraints) {
    if (SCHEMA_NEVER_SET_BY_MODEL.has(c.type)) {
      // Model output structurally cannot carry countDistinct or an install-/warranty-date-extreme
      // sortBy (see this file's doc comment) — if the question named it, a model plan can never be
      // the right answer, full stop.
      missing.push(c.type);
    } else if (c.type === 'comparator' && !planHasComparatorFilter(plan)) {
      missing.push(c.type);
    } else if (c.type === 'negation' && !planHasNegationFilter(plan)) {
      missing.push(c.type);
    }
  }
  return missing;
}

/**
 * Conditions the question named that `plan` has no corresponding filter/groupBy/timeRange for.
 * analytics.js's own missingConditions still decides its original condition set (unchanged); this adds
 * the four extra types the guard's own extractConstraints recognizes that missingConditions has no
 * notion of at all (see findExtraMissingConstraints' own doc comment) — one Set, one source of truth for
 * "what did the question ask for that this plan doesn't show".
 */
export function findMissingConstraints(plan, question, opts = {}) {
  const base = missingConditions(plan, question);
  for (const type of findExtraMissingConstraints(plan, question, opts)) base.add(type);
  return base;
}

/* ============================================================ invented-filter guard
 *
 * A model plan can satisfy validatePlan's closed field/op vocabulary (analytics.js) while still being
 * WRONG in a way that vocabulary can never catch: a real field, a real op, a VALUE the question never
 * said. "How many Trane units do we have" answered by a plan filtered to brand=Carrier is a coherent,
 * schema-valid plan and a completely different question. Every field below is a literal noun/adjective
 * a dispatcher would have had to actually say for the model to have any honest basis for it — a numeric/
 * derived field (installYear, tonnage, warrantyExpires, ...) is deliberately excluded: those are often
 * computed from a relative phrase ("older than 10 years") rather than typed verbatim, so a substring
 * check on them would misfire constantly and this guard is not the place to re-derive that arithmetic.
 */
const FREE_TEXT_VALUE_FIELDS = [
  'brand', 'city', 'county', 'state', 'zip', 'documentType', 'technician',
  'customerName', 'model', 'equipmentType', 'refrigerant', 'warrantyStatus',
];

/** "AZ" -> "arizona", "NV" -> "nevada" — the two states this corpus's own GEO_WORD_RE (analytics.js)
 *  recognizes. A state FILTER value is always the 2-letter code (ANALYTICS_TOOL's own schema says so),
 *  but the question just as often names the state in full ("customers in Arizona"), which a bare
 *  substring check on "az" would never find inside "arizona". */
const STATE_NAME_BY_CODE = { AZ: 'arizona', NV: 'nevada' };

/** documentType's filter value is one of DOCUMENT_TYPE_IDS ("work-order", "warranty-registration", ...)
 *  — a database id, not a word a dispatcher says. Mentioned when the question contains ANY of that
 *  type's own plain-English synonyms (documentTypes.js's own DOCUMENT_TYPE_SYNONYMS — "invoice"/
 *  "invoices" for "invoice", "ticket"/"tickets" for "service-ticket", ...), not the id itself. */
function documentTypeMentioned(canonicalId, qLower) {
  const words = DOCUMENT_TYPE_SYNONYMS[canonicalId] ?? [String(canonicalId ?? '').toLowerCase()];
  return words.some((w) => qLower.includes(w));
}

/** True when `rawValue` (a single filter value, never an array — callers unpack `in` themselves) has an
 *  honest basis in the question text for `field`. Deliberately loose (a plain case-insensitive substring
 *  check for most fields) rather than an exact-word match: the goal is catching a value the question
 *  never said AT ALL, not policing phrasing the way detectedConditions' own regexes do. */
function valueMentioned(field, rawValue, qLower) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (!value) return false;
  if (field === 'state') {
    const name = STATE_NAME_BY_CODE[value.toUpperCase()];
    return qLower.includes(value) || (name != null && qLower.includes(name));
  }
  if (field === 'warrantyStatus') return /\bwarrant/.test(qLower);
  if (field === 'documentType') return documentTypeMentioned(value, qLower);
  return qLower.includes(value);
}

/**
 * Every filter in `plan` whose VALUE has no honest basis in `question`'s own text — a model-invented
 * filter, never something the deterministic planner (pure code, no free-text guessing) can produce.
 * Returns `[]` (never rejects) for a plan with no filters, or one whose free-text filters are all
 * literally present in the question. hasEmail/hasPhone/hasDocType/lacksDocType and every other boolean/
 * enum-only field are intentionally NOT checked here — their whole value space is a closed yes/no or a
 * canonical id already fully validated by analytics.js's validatePlan; there is no "invented value" for
 * a boolean, and hasDocType/lacksDocType's own value is exactly documentType's own check (folded in via
 * the `field` name below only for the literal 'documentType' filter, the value-in-a-count-plan shape).
 */
export function findInventedFilters(plan, question) {
  const qLower = String(question ?? '').toLowerCase();
  const invented = [];
  for (const f of plan?.filters ?? []) {
    if (!f || !FREE_TEXT_VALUE_FIELDS.includes(f.field)) continue;
    const values = Array.isArray(f.value) ? f.value : [f.value];
    for (const v of values) {
      if (!valueMentioned(f.field, v, qLower)) invented.push({ field: f.field, value: v });
    }
  }
  return invented;
}

/* ============================================================ entity-id guard
 *
 * Forward-looking: today's ANALYTICS_TOOL schema (analytics.js) has no filter field that names a raw
 * tenant-scoped id (a customerId/equipmentId/documentId) — every field is a value drawn from the
 * question's own words (a brand, a city, a zip), never an opaque id the model would have to have
 * memorized. So this is a no-op against every plan this build can actually produce; it exists so a
 * FUTURE plan shape (or the Sonnet planner the owner's decision (a) describes: "Claude understands, our
 * code produces the facts") that DOES let the model name an id gets the same "never trust an id it
 * didn't get from tool output" treatment for free, without a second validator having to be written from
 * scratch. `knownEntityIds` is supplied by the caller (a Set of this tenant's own ids); omitted, this
 * fails OPEN — same principle as every other budget/limit check in this codebase (getDailyModelBudgetStatus,
 * sonnetAllowed, ...): no way to check membership must never mean "reject everything", only "skip this
 * one guard".
 */
const ENTITY_ID_FIELDS = ['entityId', 'customerId', 'equipmentId', 'documentId'];

export function findUnknownEntityIds(plan, { knownEntityIds } = {}) {
  if (!knownEntityIds) return [];
  const unknown = [];
  const check = (field, value) => {
    if (value == null) return;
    if (!knownEntityIds.has(String(value))) unknown.push({ field, value });
  };
  for (const field of ENTITY_ID_FIELDS) {
    if (plan?.[field] != null) check(field, plan[field]);
  }
  for (const f of plan?.filters ?? []) {
    if (f && ENTITY_ID_FIELDS.includes(f.field)) {
      for (const v of Array.isArray(f.value) ? f.value : [f.value]) check(f.field, v);
    }
  }
  return unknown;
}

/**
 * The one entry point planAnalyticsQuestion's model-call section calls. `plan` is the MODEL's raw
 * tool_use `input` (before analytics.js's own validatePlan/missingConditions run on it) — pass it in as
 * close to "just came back from the SDK" as possible; a malformed shape (missing `filters`, wrong types)
 * simply produces no findings here (validatePlan downstream is what actually enforces the schema) rather
 * than throwing, since a guard file's own bug must never be the reason a plan is rejected for the wrong
 * reason.
 *
 * @param {object} plan       the model's raw tool_use input (not yet schema-validated)
 * @param {string} question   the ORIGINAL question text (not normalized/lowercased by the caller)
 * @param {{knownEntityIds?: Set<string>, tenantVocab?: object}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string, missing?: string[], invented?: object[], unknownIds?: object[]}}
 */
export function validateModelPlan(plan, question, opts = {}) {
  if (!plan || typeof plan !== 'object') return { ok: false, reason: 'no-plan' };

  const missing = [...findMissingConstraints(plan, question, { tenantVocab: opts.tenantVocab })];
  if (missing.length > 0) {
    return { ok: false, reason: `missing-condition:${missing.join(',')}`, missing };
  }

  const invented = findInventedFilters(plan, question);
  if (invented.length > 0) {
    return {
      ok: false,
      reason: `invented-filter:${invented.map((i) => `${i.field}=${i.value}`).join(',')}`,
      invented,
    };
  }

  const unknownIds = findUnknownEntityIds(plan, opts);
  if (unknownIds.length > 0) {
    return {
      ok: false,
      reason: `unknown-entity-id:${unknownIds.map((i) => `${i.field}=${i.value}`).join(',')}`,
      unknownIds,
    };
  }

  return { ok: true };
}
