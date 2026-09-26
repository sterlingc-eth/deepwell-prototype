/**
 * Donovan analytics executor: the Haiku planner call, the parameterized DB
 * reads it drives, and the deterministic answer built from what came back.
 * The pure classifier/schema/geo/formatting logic all lives in
 * api/_lib/analytics.js (no `db`, no Anthropic client) so it's testable with
 * no database or network — see scripts/verify-analytics.mjs. This file is the
 * impure half: it's the only place in the analytics path that touches
 * Postgres or calls Anthropic.
 *
 * Wired into api/ask.js AFTER the meta-router and fast path, BEFORE
 * retrieval — see handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { getCacheEntry, isCacheHit } from '../askCache.js';
import { documentTypeLabel } from '../documentTypes.js';
import {
  ANALYTICS_TOOL,
  buildAnalyticsSystemPrompt,
  ANALYTICS_PROMPT_VERSION,
  analyticsQuestionHash,
  analyticsPlanHash,
  suspiciousUnfilteredCustomerPlan,
  reconcileTimeRange,
  resolveServiceVisitsOverride,
  resolveAgeFilter,
  resolveAnyTimeRange,
  withinTimeRange,
  monthRangeLabel,
  missingConditions,
  detectedConditions,
  unsupportedConditionAnswer,
  buildConditionOverrideFilter,
  parseCrossDocCondition,
  crossDocUnsupportedAnswer,
  moneyFallbackAnswer,
  isExistenceQuestion,
  existenceWrap,
  CONDITION_CROSS_VISIT_RELATION,
  CONDITION_RATIO,
  BOOLEAN_FILTER_FIELDS,
  DOC_TYPE_FILTER_FIELDS,
  validatePlan,
  deriveGeo,
  normalizeStateValue,
  matchesAllFilters,
  buildAnalyticsSQL,
  groupRows,
  formatAnalyticsAnswer,
  brandMatches,
  installYearOf,
  warrantyStatusOf,
  UNKNOWN_BUCKET,
  TOP_CUSTOMERS_LIMIT,
} from '../analytics.js';
import { normalizeQuestion } from '../nlNormalize.js';
// Round 11 (literature #6/#7): per-tenant vocabulary schema-linking for the planner prompt (above).
import { schemaLinkedVocabLines } from '../vocab/tenantVocab.js';
// TEAM C (citations everywhere): records/basis come from the SAME rows the number was computed from.
import { withAnalyticsCitations } from '../citations/analytics.js';
// Team A (2026-09-24): time semantics (uploaded vs service date) and future-dated service records.
import { dateBasisOf, todayIso, splitFuture } from '../scope.js';
// Tier 2 learning loop, Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
// overlayFewShotHash mixes the active overlay's few-shot items into this
// file's own analytics cache promptVersion (see runAnalyticsQuestion below)
// so approving a new example invalidates every previously-cached plan.
import { overlayFewShotHash } from '../learning/overlay.js';

export const ANALYTICS_MODEL = process.env.ANALYTICS_MODEL || process.env.ASK_MODEL || 'claude-haiku-4-5';
export function isAnalyticsEnabled(env = process.env) {
  return env?.ASK_ANALYTICS !== '0';
}

/**
 * The one Haiku tool-use call this feature makes. Returns a VALIDATED plan
 * (never raw model output) or null — a schema violation, a timeout, or any
 * Anthropic error all fall through to null, which api/ask.js treats exactly
 * like a fast-path miss: run retrieval+model instead. `max_tokens` is small
 * (a plan is a handful of enum strings) — see the brief's cost note.
 */
export async function planAnalyticsQuestion(question, { today, overlay, tenantVocab } = {}) {
  try {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const deadlineAt = Date.now() + MODEL_TIMEOUT_MS;
    // Tier 2 learning (Part A): the active overlay's approved few-shot
    // examples, appended after the curated ANALYTICS_FEW_SHOT_BLOCK — see
    // buildAnalyticsSystemPrompt's own doc comment for the 12-item/500-token
    // cap. No overlay (or none with few-shot items) returns the exact same
    // ANALYTICS_SYSTEM_PROMPT constant as before this existed.
    // Round 11 (literature #6, schema linking): `tenantVocab` (vocab/tenantVocab.js's getTenantVocab),
    // when present, contributes a short, question-relevant subset of this tenant's own brand/document-
    // type/city vocabulary — omitted (no tenantVocab, or none of it matches this question) leaves the
    // prompt byte-identical to before this existed.
    const systemPrompt = buildAnalyticsSystemPrompt({ extraFewShot: overlay?.fewShot, vocabLines: schemaLinkedVocabLines(question, tenantVocab) });
    const response = await withBackoff(
      () =>
        client.messages.create(
          {
            model: ANALYTICS_MODEL,
            max_tokens: 400,
            temperature: 0,
            system: systemPrompt,
            tools: [ANALYTICS_TOOL],
            tool_choice: { type: 'tool', name: 'analytics_plan' },
            messages: [{ role: 'user', content: `Today's date: ${today}\n\nQUESTION: ${question}` }],
          },
          { timeout: Math.max(1000, deadlineAt - Date.now()) }
        ),
      { deadlineAt }
    );
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    const rawInput = toolUse?.input;
    // Live miss (2026-09-21, "which units had service this month"): a
    // "<units/equipment/customers> <had/got/were> service(d)" / "<did/do> we
    // service" / "service call(s)" shape forces entity 'serviceVisits' and a
    // deterministic op, exactly like reconcileTimeRange below forces
    // timeRange — see resolveServiceVisitsOverride's own doc comment for why
    // this can never depend on the model choosing the entity correctly.
    // Filters are dropped when this fires: none of the known phrasings need
    // one, and a stray model filter for the WRONG entity (customers/
    // equipment) would otherwise reject the whole plan downstream.
    const serviceVisitsOverride = resolveServiceVisitsOverride(question);
    const base = serviceVisitsOverride
      ? { ...(rawInput ?? {}), ...serviceVisitsOverride, filters: [] }
      : rawInput;
    // Item 1 (2026-09-21 live miss) + round 5 item 2: a literal month name/
    // "this month"/"last month" phrase in the QUESTION overrides whatever
    // timeRange the model filled in, computed deterministically from `today`
    // — UNLESS the model's own timeRange is well-formed and names a year the
    // question itself actually wrote out (reconcileTimeRange, analytics.js) —
    // see that function's own doc comment for why the model's date math is
    // not trusted by default, and when it is trusted anyway.
    let input = base ? { ...base, timeRange: reconcileTimeRange(base.timeRange, question, today) } : base;
    // Team A (2026-09-24): "older/newer than N years" is year arithmetic done in code, not by the model; and a documents
    // time window is decided by the wording - "added/uploaded/received/scanned/filed" -> upload date (created_at),
    // "serviced/visited/job/work done" -> service date. Both override whatever the model guessed.
    if (input) {
      const age = resolveAgeFilter(question, today);
      if (age) input = { ...input, filters: [...(input.filters ?? []).filter((f) => f?.field !== 'installYear'), age] };
      const basis = dateBasisOf(question);
      if (input.entity === 'documents' && basis) input = { ...input, dateBasis: basis };
    }
    return validatePlan(input);
  } catch (err) {
    console.error('Analytics planner failed, falling through:', err?.message);
    return null;
  }
}

/* ============================================================ row shaping
 * Each entity's fetched rows get one extra pass here that attaches the
 * derived/computed fields (geo, brand-normalized, warranty tier, install
 * year) the closed vocabulary promises, before matchesAllFilters/groupRows
 * (both pure, in analytics.js) ever see them.
 */

// Reviewer NO-GO (2026-09-21, round 2, gap 2): `value` used to be the full
// service_address, which read fine at a 12-row cap but got noisy once the
// list cap rose to 50 (MAX_FACT_ROWS, analytics.js) — "compact one-line rows
// (name · city)" is the requested shape, so a plain customer-list row shows
// just the city here (still the full address on the row itself in the app
// once opened via entityId).
function shapeCustomerRow(r) {
  const geo = deriveGeo(r.service_address);
  return {
    id: r.id, label: r.customer_name || 'Unnamed customer', value: geo.city || r.service_address || '—',
    entityId: r.id, city: geo.city, county: geo.county, state: geo.state, zip: geo.zip,
    customerName: r.customer_name,
    // hasEmail/hasPhone (item 2) read these two via matchesFilter's own
    // HAS_FIELD_ROW_KEY map (analytics.js) — buildAnalyticsSQL's customers
    // SELECT already carries both columns.
    email: r.email, phone: r.phone,
  };
}

function shapeEquipmentRow(r, today) {
  const geo = deriveGeo(r.service_address);
  return {
    id: r.id, label: [r.manufacturer, r.equipment_type].filter(Boolean).join(' ') || 'Equipment',
    value: r.model || r.id, entityId: r.customer_id || r.id,
    brand: r.manufacturer, model: r.model, equipmentType: r.equipment_type, tonnage: r.tonnage,
    refrigerant: r.refrigerant, installYear: installYearOf(r.installation_date),
    warrantyStatus: warrantyStatusOf(r.warranty, today),
    city: geo.city, county: geo.county, state: geo.state, zip: geo.zip,
  };
}

function shapeDocumentRow(r, dateBasis) {
  // Item 1: month by the WORK date (extractions.service_date, left-joined in
  // buildAnalyticsSQL's documents branch), not the upload date — falls back
  // to created_at only for a document nothing was ever extracted as its
  // service_date for. `date` (item 5, 2026-09-22) is the same value at full
  // day precision, for the extended day-grain time windows (this week,
  // since 2024, ...) that a month truncation alone can't compare correctly —
  // see analytics.js's withinTimeRange.
  const fullDate = r.service_date && /^\d{4}-\d{2}-\d{2}/.test(String(r.service_date))
    ? String(r.service_date).slice(0, 10)
    : null;
  const uploadDate = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null;
  // Team A: an "uploaded/added/received" question is about when the paper arrived (created_at), never the job date.
  const date = dateBasis === 'uploaded' ? uploadDate : (fullDate ?? uploadDate);
  const month = date ? date.slice(0, 7) : r.service_date ? String(r.service_date).slice(0, 7) : null;
  return {
    id: r.id, label: documentTypeLabel(r.document_type), value: r.original_filename || r.id,
    entityId: undefined, documentType: r.document_type, month, date,
  };
}

/** Filters whose field this entity's row shape doesn't carry at all — e.g. a
 *  "brand" filter against `documents` — make the plan meaningless for this
 *  entity. Rather than silently ignoring it (answering a DIFFERENT question
 *  than what was asked), treat it as a fall-through, same as an invalid plan. */
const ENTITY_SUPPORTED_FIELDS = {
  customers: new Set(['state', 'county', 'city', 'zip', 'customerName', 'hasEmail', 'hasPhone', 'hasDocType', 'lacksDocType']),
  equipment: new Set(['state', 'county', 'city', 'zip', 'brand', 'model', 'equipmentType', 'tonnage', 'refrigerant', 'installYear', 'warrantyStatus']),
  warranties: new Set(['state', 'county', 'city', 'zip', 'brand', 'model', 'equipmentType', 'warrantyStatus']),
  documents: new Set(['documentType']),
  serviceVisits: new Set(['technician']),
};

/**
 * Reviewer NO-GO (2026-09-21, round 2, gap 1): "Which customers have Trane
 * units?" already passed the classifier AND validatePlan (brand is in the
 * closed FILTER_FIELDS vocabulary) — the planner correctly returned
 * `{entity: 'customers', op: 'list', filters: [{field: 'brand', ...}]}` — but
 * filtersSupported (above) rejected it outright because `customers` carries
 * no equipment-level column, so the whole question fell through to
 * retrieval+model. These are the equipment-level fields customers can be
 * filtered by via a join through equipment.customer_id — see
 * queryCustomersByEquipmentFilter below.
 */
const EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN = new Set([
  'brand', 'model', 'equipmentType', 'tonnage', 'refrigerant', 'installYear', 'warrantyStatus',
]);

function filtersSupported(entity, filters) {
  const supported = ENTITY_SUPPORTED_FIELDS[entity] ?? new Set();
  return (filters ?? []).every(
    (f) => supported.has(f.field) || (entity === 'customers' && EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN.has(f.field))
  );
}

/** brand/state filters need special-cased matching (normalizeBrand,
 *  normalizeStateValue) that plain matchesFilter's case-insensitive string
 *  compare doesn't give them — applied first, then the rest via
 *  matchesAllFilters. */
function applyEntityFilters(rows, filters) {
  const special = (filters ?? []).filter((f) => f.field === 'brand' || f.field === 'state');
  const plain = (filters ?? []).filter((f) => f.field !== 'brand' && f.field !== 'state');
  return rows.filter((r) => {
    for (const f of special) {
      if (f.field === 'brand') {
        const values = f.op === 'in' ? f.value : [f.value];
        const hit = values.some((v) => brandMatches(r.brand, v));
        if (f.op === 'neq' ? hit : !hit) return false;
      }
      if (f.field === 'state') {
        const want = normalizeStateValue(f.value);
        const have = r.state ? normalizeStateValue(r.state) : null;
        const hit = have === want;
        if (f.op === 'neq' ? hit : !hit) return false;
      }
    }
    return matchesAllFilters(r, plain);
  });
}

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * Reviewer NO-GO (2026-09-21, round 2, gaps 1 + 3): "customers" filtered by
 * an equipment-level field (brand, model, equipmentType, tonnage,
 * refrigerant, installYear, warrantyStatus) — "which customers have Trane
 * units", "how many customers have units older than 10 years". There is no
 * single `customers` SQL statement for this (a customer has zero or more
 * units), so this queries EQUIPMENT (reusing buildAnalyticsSQL's own
 * equipment branch + shapeEquipmentRow + applyEntityFilters — the exact same
 * matching a plain equipment-entity question already gets), then resolves
 * each surviving unit's customer_id to a customer row and de-duplicates to
 * ONE row per customer (a customer with 3 matching Trane units still counts
 * once). The matching unit's own brand/model is carried onto that row as the
 * list's detail column (gap 3: "Linda Fitzgerald · Trane 4TTR4036 · Mesa") —
 * the most-recently-updated matching unit wins when a customer has more than
 * one (buildAnalyticsSQL's equipment query is already `ORDER BY updated_at
 * DESC`), since that is the one most likely to be what "have Trane units"
 * was actually asking about today.
 */
async function queryCustomersByEquipmentFilter(db, plan, { today } = {}) {
  const equipmentPlan = { ...plan, entity: 'equipment' };
  const { sql, params } = buildAnalyticsSQL(equipmentPlan);
  const { rows: raw } = await db.raw(sql, params);
  const unitRows = raw
    .map((r) => ({ ...shapeEquipmentRow(r, today), customerId: r.customer_id || null }))
    .filter((r) => r.customerId);

  // Reviewer NO-GO (2026-09-21, round 5, item 1): hasEmail/hasPhone are
  // CUSTOMER-level facts a unit row never carries — applying them here (with
  // the rest of plan.filters, against a row that has no email/phone at all)
  // made matchesFilter compare against undefined and silently return wrong
  // rows (every unit looking like "no contact info"). Only the genuinely
  // equipment-level filters apply at this stage; hasEmail/hasPhone are
  // deferred to the CUSTOMER rows fetched below, then re-checked by
  // executeAnalyticsPlan's own second applyEntityFilters pass over what this
  // function returns (see that idempotent-pass comment further down).
  const unitFilters = (plan.filters ?? []).filter((f) => !BOOLEAN_FILTER_FIELDS.includes(f.field));

  // Only the equipment-level filters apply here (state/county/city/zip are
  // already on the unit's own row via its service_address; customerName has
  // no equivalent on an equipment row and is intentionally left to fail
  // closed — see matchesFilter's own null-actual -> false rule — rather than
  // silently ignored).
  const filtered = applyEntityFilters(unitRows, unitFilters);
  if (!filtered.length) return { rows: [], unfilteredCustomerIds: [], unitCount: 0 };

  const customerIds = [...new Set(filtered.map((r) => r.customerId))];
  const { rows: custRaw } = await db.raw(
    `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
            data->>'email' AS email, data->>'phone' AS phone
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND id = ANY($1::uuid[])`,
    [customerIds]
  );
  const custById = new Map(custRaw.map((c) => [c.id, c]));

  const rows = [];
  const seen = new Set();
  for (const unit of filtered) {
    if (seen.has(unit.customerId)) continue;
    const cust = custById.get(unit.customerId);
    if (!cust) continue; // merged/removed between the two queries — skip, don't guess
    seen.add(unit.customerId);
    const geo = deriveGeo(cust.service_address);
    const detail = [unit.brand, unit.model].filter(Boolean).join(' ');
    rows.push({
      id: unit.customerId, label: cust.customer_name || 'Unnamed customer',
      value: [detail, geo.city].filter(Boolean).join(' · ') || geo.city || cust.service_address || '—',
      entityId: unit.customerId, city: geo.city, county: geo.county, state: geo.state, zip: geo.zip,
      customerName: cust.customer_name, email: cust.email, phone: cust.phone,
      // Every equipment-level field, not just brand/model — executeAnalyticsPlan
      // re-runs applyEntityFilters on whatever this function returns (the same
      // idempotent second pass every other entity branch gets), so a plan
      // combining e.g. brand + warrantyStatus must still find both fields here.
      // hasEmail/hasPhone (round 5 item 1) are genuinely checked for the
      // FIRST time in that second pass, now that email/phone are on the row.
      brand: unit.brand, model: unit.model, equipmentType: unit.equipmentType,
      tonnage: unit.tonnage, refrigerant: unit.refrigerant, installYear: unit.installYear,
      warrantyStatus: unit.warrantyStatus,
    });
  }
  return { rows, unitCount: filtered.length };
}

/**
 * Round 4 item 1 (2026-09-21): "who's our biggest customer" — customers
 * RANKED by a size measure (equipmentCount or documentCount), not filtered.
 * A LEFT JOIN + COUNT + ORDER BY DESC + LIMIT — the join/columns are fixed,
 * whitelisted SQL text (never model input), and `limit` is a plan-validated
 * number, never a raw string. Deliberately ignores plan.filters for v1 (a
 * "biggest customer in Arizona" county/state filter combined with a sort) —
 * an honest, documented limitation (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md),
 * not a silent one: the brief's own examples never combine the two.
 */
async function queryTopCustomers(db, sortBy, limit) {
  const sql =
    sortBy === 'documentCount'
      ? `SELECT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
                COUNT(DISTINCT l.document_id) AS metric
           FROM entities c
           LEFT JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
          WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          GROUP BY c.id
          ORDER BY metric DESC, c.updated_at DESC
          LIMIT $1`
      : `SELECT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
                COUNT(DISTINCT e.id) AS metric
           FROM entities c
           LEFT JOIN entities e ON e.customer_id = c.id AND e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
          WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          GROUP BY c.id
          ORDER BY metric DESC, c.updated_at DESC
          LIMIT $1`;
  const { rows } = await db.raw(sql, [limit]);
  const noun = sortBy === 'documentCount' ? 'document' : 'unit';
  return rows.map((r) => {
    const n = Number(r.metric) || 0;
    return {
      id: r.id, label: r.customer_name || 'Unnamed customer',
      value: `${n} ${noun}${n === 1 ? '' : 's'}`, entityId: r.id,
    };
  });
}

/**
 * Item 7 (100-question persona sample, 2026-09-22): "customers with a
 * proposal but no invoice" — hasDocType/lacksDocType filters, resolved by
 * finding every customer directly/manually linked (document_entity_links) to
 * a document of the "has" type, then excluding any of THOSE customers also
 * linked to a document of the "lacks" type (when one is given at all — a
 * bare hasDocType with no lacksDocType is just "which customers have an X").
 * Deliberately simpler than queryCustomersByEquipmentFilter's own join: only
 * documents linked straight to the customer entity count (not a document
 * reachable only via one of their units, and not a name-matched-but-never-
 * linked document) — a maintenance agreement or invoice is, in practice,
 * always a customer-scoped document, never an equipment-scoped one, so this
 * trade-off costs nothing on the corpus this ships against.
 */
async function queryCustomersByDocTypeCondition(db, plan) {
  const hasFilter = (plan.filters ?? []).find((f) => f.field === 'hasDocType');
  const lacksFilter = (plan.filters ?? []).find((f) => f.field === 'lacksDocType');
  if (!hasFilter) return { rows: [] };

  const docCustomerSql = `
    SELECT DISTINCT c.id, c.data->>'customer_name' AS customer_name, c.data->>'service_address' AS service_address,
           c.data->>'email' AS email, c.data->>'phone' AS phone
      FROM entities c
      JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
      JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
     WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} AND d.document_type = $1`;

  const { rows: hasRows } = await db.raw(docCustomerSql, [hasFilter.value]);
  if (!lacksFilter) return { rows: hasRows.map((r) => shapeCustomerRow(r)) };

  const { rows: lacksRows } = await db.raw(
    `SELECT DISTINCT c.id
       FROM entities c
       JOIN document_entity_links l ON l.entity_id = c.id AND l.${TENANT_SQL}
       JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
      WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL} AND d.document_type = $1`,
    [lacksFilter.value]
  );
  const lacksIds = new Set(lacksRows.map((r) => r.id));
  return { rows: hasRows.filter((r) => !lacksIds.has(r.id)).map((r) => shapeCustomerRow(r)) };
}

function keyOf(groupBy) {
  return (row) => {
    if (groupBy === 'warrantyStatus') return row.warrantyStatus ?? UNKNOWN_BUCKET;
    const v = row[groupBy];
    return v == null || v === '' ? UNKNOWN_BUCKET : String(v);
  };
}

/**
 * Run one validated plan against the tenant's own data. `db` is a
 * recordsStore.js store (has `.raw`), called from inside a withTenant
 * transaction — same calling convention as fastPathQuery.js.
 */
export async function executeAnalyticsPlan(db, plan, { today, timeRangeLabel } = {}) {
  // "who's our biggest customer" (round 4, item 1) — a distinct shape from
  // every other op: ranked, not filtered/counted. validatePlan already
  // guarantees sortBy only ever appears with entity 'customers' + op 'list'.
  if (plan.sortBy) {
    const rows = await queryTopCustomers(db, plan.sortBy, plan.limit ?? TOP_CUSTOMERS_LIMIT);
    // TEAM C: citations from the same ranked rows.
    return withAnalyticsCitations(formatAnalyticsAnswer(plan, { total: rows.length, rows }), plan, { rows, total: rows.length });
  }

  if (!filtersSupported(plan.entity, plan.filters)) return null;

  const hasEquipmentJoinFilter =
    plan.entity === 'customers' && (plan.filters ?? []).some((f) => EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN.has(f.field));
  // Item 7 (100-question persona sample, 2026-09-22): hasDocType/lacksDocType
  // are resolved by their own dedicated query (queryCustomersByDocTypeCondition
  // above) — never by buildAnalyticsSQL, which has no notion of a
  // document_entity_links join. Checked before hasEquipmentJoinFilter since
  // the two are mutually exclusive in practice (validatePlan never mixes an
  // equipment-level filter into a cross-doc plan) but this ordering costs
  // nothing either way.
  const hasDocTypeFilter =
    plan.entity === 'customers' && (plan.filters ?? []).some((f) => DOC_TYPE_FILTER_FIELDS.includes(f.field));

  let rows;
  // Set only in the serviceVisits branch below, from the SAME already-fetched
  // (and already DESC-by-date-sorted) rows — never a second query — see
  // formatAnalyticsAnswer's own doc comment for how this powers the honest
  // zero-result wording ("which units had service this month" live miss).
  let mostRecentServiceVisit;
  // Team A: how many matching UNITS stand behind a customers-via-equipment count; how many service records are dated in
  // the future (excluded from "jobs done"/"last service").
  let unitCount = null;
  let futureVisitCount = 0;
  if (hasDocTypeFilter) {
    ({ rows } = await queryCustomersByDocTypeCondition(db, plan));
  } else if (hasEquipmentJoinFilter) {
    // Gaps 1 + 3: "which customers have Trane units" — a customer filtered
    // by an equipment-level attribute. queryCustomersByEquipmentFilter already
    // applies every filter itself (equipment-level AND the geo ones a unit's
    // own address also carries), so `filtered` below is a no-op pass-through
    // (matchesAllFilters([], []) === true) rather than re-filtering.
    ({ rows, unitCount } = await queryCustomersByEquipmentFilter(db, plan, { today }));
  } else if (plan.entity === 'customers') {
    const { sql, params } = buildAnalyticsSQL(plan);
    const { rows: raw } = await db.raw(sql, params);
    rows = raw.map((r) => shapeCustomerRow(r));
  } else if (plan.entity === 'equipment' || plan.entity === 'warranties') {
    const { sql, params } = buildAnalyticsSQL(plan);
    const { rows: raw } = await db.raw(sql, params);
    rows = raw.map((r) => shapeEquipmentRow(r, today));
  } else if (plan.entity === 'documents') {
    const { sql, params } = buildAnalyticsSQL(plan);
    const { rows: raw } = await db.raw(sql, params);
    rows = raw.map((r) => shapeDocumentRow(r, plan.dateBasis));
    // Item 5 (100-question persona sample, 2026-09-22): withinTimeRange
    // compares on the row's own `date` (full YYYY-MM-DD) when plan.timeRange
    // is itself day-grain (the new "this week"/"last N days"/etc. windows —
    // see resolveExtendedTimeRange in analytics.js), and falls back to the
    // pre-existing month-grain `month` comparison for a plain "August 2026"
    // style range — never a raw-date-vs-month-bound lexicographic compare
    // (see the serviceVisits branch's own comment below for why that traps).
    if (plan.timeRange) rows = rows.filter((r) => withinTimeRange(r, plan.timeRange));
  } else {
    // serviceVisits: service_date + technician are two different
    // extractions.field_key rows for the same document — fetched separately
    // and merged here, tenant-scoped identically to buildAnalyticsSQL's own
    // service_date query. customer_name/model now come back ON the
    // service_date row itself (buildAnalyticsSQL's own correlated
    // subqueries) — see that function's own doc comment ("which units had
    // service this month" live miss).
    const { sql, params } = buildAnalyticsSQL(plan);
    const [{ rows: dateRows }, { rows: techRows }] = await Promise.all([
      db.raw(sql, params),
      db.raw(
        `SELECT x.document_id, x.value FROM extractions x
          WHERE x.field_key = 'technician' AND tenant_id = (current_setting('app.tenant_id', true))::uuid
          LIMIT 500`,
        []
      ),
    ]);
    const techByDoc = new Map(techRows.map((r) => [r.document_id, r.value]));
    const allServiceVisitRows = dateRows.map((r) => ({
      id: r.document_id,
      label: r.customer_name || techByDoc.get(r.document_id) || 'Unassigned',
      // "brand/model · date" when a unit's model was extracted, else just the
      // date — the row's own raw date lives separately in `date` so the
      // timeRange filter below (and the zero-result "most recent" wording)
      // never has to parse this display string back apart.
      value: [r.model, r.value].filter(Boolean).join(' · ') || r.value,
      date: r.value, entityId: undefined,
      technician: techByDoc.get(r.document_id) ?? null,
      customerName: r.customer_name ?? null,
      model: r.model ?? null,
      month: /^\d{4}-\d{2}/.test(r.value ?? '') ? r.value.slice(0, 7) : null,
    }));
    // buildAnalyticsSQL's own query is `ORDER BY x.value DESC`, so the first
    // row (if any) is already the single most recent service visit on file,
    // regardless of what plan.timeRange narrows it to below — no second
    // query needed.
    // Team A: a service_date AFTER today is a scheduled visit or a typo - never "the most recent visit", never a job
    // that was done. splitFuture separates them (newest-first past list); they are reported as a count instead.
    const { past: pastVisitRows, future: futureVisitRows } = splitFuture(allServiceVisitRows, todayIso(today));
    futureVisitCount = futureVisitRows.length;
    const visitRowsToUse = pastVisitRows;
    mostRecentServiceVisit = visitRowsToUse.length
      ? { date: visitRowsToUse[0].date, customer: visitRowsToUse[0].customerName || null }
      : null;
    // Reviewer NO-GO (2026-09-21, "which units had service this month" live
    // miss): comparing the full YYYY-MM-DD date directly against a YYYY-MM
    // timeRange bound is a lexicographic trap — '2026-09-10' > '2026-09' is
    // TRUE (a longer string sharing the shorter one's prefix sorts after it),
    // so a real September visit was wrongly excluded from its OWN month's
    // range by the `to` check. Compare on `r.month` (already truncated to
    // YYYY-MM) against the bound truncated the same way, exactly like the
    // documents branch above already does — never the raw date against a
    // bound of a different granularity.
    // Item 5: same withinTimeRange helper as the documents branch above — day
    // grain for the new extended windows, month grain (via r.month) otherwise.
    rows = plan.timeRange ? visitRowsToUse.filter((r) => withinTimeRange(r, plan.timeRange)) : visitRowsToUse;
  }

  // hasDocType/lacksDocType are already fully resolved by
  // queryCustomersByDocTypeCondition's own two queries above — matchesFilter
  // has no notion of either field (row[field] is always undefined for them),
  // so re-applying them here would zero out every row. Every OTHER filter in
  // the plan (a geo filter combined with the doc-type condition, say) still
  // needs this pass, same as hasEquipmentJoinFilter's own rows above.
  const filtersToApply = hasDocTypeFilter
    ? (plan.filters ?? []).filter((f) => !DOC_TYPE_FILTER_FIELDS.includes(f.field))
    : plan.filters;
  const filtered = applyEntityFilters(rows, filtersToApply);
  const total = filtered.length;

  let groups = [];
  if (plan.op === 'groupBy') groups = groupRows(filtered, keyOf(plan.groupBy));

  let sum = null;
  if (plan.op === 'sum') {
    // Live miss cluster 2 (2026-09-21): tonnage is the ONLY numeric field
    // this codebase can honestly total today — there is no financials layer
    // (handoffs/FINANCIALS_DESIGN_2026-09-21.md, not built), so summing
    // anything else (r.value ends up being a filename/document id for a
    // `documents` plan) silently reduced to 0 and printed as a confident
    // "$0.00 across N documents." api/ask.js's money gate already intercepts
    // most money phrasings before a plan is ever made; this is the second
    // line of defense — refuse rather than guess, same as every other
    // "can't answer this confidently" path in this file.
    if (plan.entity !== 'equipment' && plan.entity !== 'warranties') return null;
    sum = filtered.reduce((acc, r) => acc + (Number(r.tonnage) || 0), 0);
  }

  // Ambiguity rule (design point 5): 0 results from a named filter — show
  // what the tenant's data DOES have for this entity instead of a bare "0".
  let broaderGroups = null;
  let unfilteredTotal = null;
  if (total === 0 && plan.filters?.length) {
    const geoField = plan.filters.find((f) => ['state', 'county', 'city', 'zip'].includes(f.field));
    const groupField = geoField?.field === 'state' ? 'state' : geoField ? 'county' : null;
    if (groupField) {
      broaderGroups = groupRows(rows, keyOf(groupField));
      unfilteredTotal = rows.length;
    }
  } else if (plan.filters?.length) {
    unfilteredTotal = rows.length;
  }

  // TEAM C: records + basis from the SAME `filtered` rows (and the same group keys) the answer counts.
  return withAnalyticsCitations(formatAnalyticsAnswer(plan, {
    total, groups, rows: filtered, sum, unfilteredTotal, broaderGroups, mostRecentServiceVisit, timeRangeLabel,
    unitCount, futureVisitCount,
  }), plan, {
    rows: filtered, total, groups, keyOf: plan.op === 'groupBy' ? keyOf(plan.groupBy) : null,
    unfilteredRows: total === 0 ? rows : null, timeRangeLabel, monthLabel: timeRangeLabel ? null : monthRangeLabel(plan.timeRange),
    futureVisitCount, // TEAM C: future-dated visits are mentioned in the basis, never cited as records
  });
}

/**
 * R7 guardrail item 2 ("yes/no shape"): exported for api/ask.js to apply to the OUTGOING response text only,
 * AFTER runAnalyticsQuestion's own cache write/read logic has already used the un-wrapped `data` — never baked
 * into what gets cached here, because a "how many Ruud units" and a "do we have any Ruud units" question can
 * resolve to the exact same Tier-2 plan-hash row, and only the second one wants the Yes/No lead-in; caching the
 * wrapped text would leak it onto the first question's answer too. Only wraps when the answer's own first fact
 * is cleanly a number (the ordinary count-op shape); anything else (a list breakdown, a sum, an honest fallback
 * with no facts) is left exactly as it was — never guesses at "yes"/"no" from a shape that doesn't actually say
 * a count. existenceWrap itself is idempotent, so an already-wrapped answer is never double-prefixed.
 */
export function applyExistenceShape(data, question) {
  if (!data || data.kind !== 'answer' || typeof data.text !== 'string' || !isExistenceQuestion(question)) return data;
  const n = Number(data.facts?.[0]?.value);
  if (!Number.isFinite(n)) return data;
  return { ...data, text: existenceWrap(data.text, n > 0) };
}

/**
 * Full orchestration for one question: cache check -> plan -> guard ->
 * execute. Returns {handled, data, cacheHit, writes} — `writes` lists every
 * (questionHash, corpusStamp) pair api/ask.js's own bookkeeping should
 * upsert on a fresh (non-cache-hit) answer; a cache hit needs no write.
 *
 * Reviewer NO-GO (2026-09-21, A2) fix: this used to take a `questionHash`
 * from api/ask.js and pass it straight to askCache.js's getCacheEntry — the
 * SAME hash the retrieval+model path caches under, and the SAME (retrieval's)
 * prompt version baked into its corpus_stamp. A question the classifier now
 * routes to analytics could therefore return a STALE retrieval-cached answer
 * as if it were a fresh analytics one. Fixed by computing this file's OWN
 * namespaced hashes (api/_lib/analytics.js's analyticsQuestionHash/
 * analyticsPlanHash — see that file's own doc comment for the two-tier
 * design) and passing ANALYTICS_PROMPT_VERSION to getCacheEntry, so an
 * analytics cache row can never be read as, or overwrite, a retrieval one,
 * regardless of what either path's prompt/schema does in the future.
 *
 * @param withTenant  api/_lib/recordsStore.js's withTenant, injected so this
 *                    stays easy to call from ask.js without a second import
 *                    cycle back through recordsStore.
 */
export async function runAnalyticsQuestion({ withTenant, ctxArg, question, today, overlay, tenantVocab, noCache = false }) {
  const EMPTY = { handled: false, data: null, cacheHit: false, modelCalled: false, writes: [] };
  // Day 1 training-plan normalization layer (nlNormalize.js): both the plan
  // and every cache key below key off the NORMALIZED text (more cache hits,
  // cheaper — a repeated question typed three different sloppy ways still
  // hits the same Tier-1 row) — `question` itself is kept only for anything
  // that might ever need to show the dispatcher back their own original
  // wording, which nothing in this file currently does.
  const { normalized: question_n } = normalizeQuestion(question, { overlay });
  // Tier 2 learning (Part A): the promptVersion namespace now also carries a
  // fingerprint of the active overlay's own few-shot items, so approving (or
  // retiring) one invalidates every previously-cached analytics answer —
  // otherwise a plan cached under the OLD prompt could be served forever
  // even after the planner starts seeing a new example.
  const promptVersion = `${ANALYTICS_PROMPT_VERSION}:${overlayFewShotHash(overlay)}`;
  try {
    // Reviewer NO-GO (2026-09-21, round 6): production still served a stale
    // cached "49 customers." for maintenance-due questions after this file's
    // own missingConditions check was added, because that check only ran
    // AFTER a plan existed, downstream of the Tier-1 cache probe below — a
    // cache row written before the fix (or under any future plan) short-
    // circuited straight past it. 'money' and 'maintenance' both have no
    // entry in CONDITION_PLAN_FIELD (analytics.js), so missingConditions()
    // would flag them as unsupported no matter what any plan says — that
    // makes them safe to decide HERE, before any cache lookup or model call,
    // so a stale/wrong cached answer can never be returned for them again.
    const conditionsUpFront = detectedConditions(question_n);
    if (conditionsUpFront.has('money')) {
      // Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): missOutcome
      // is api/ask.js's own signal to log this to ask_misses (api/_lib/
      // missStore.js) — a real answer never sets it, only an honest fallback.
      return { handled: true, data: moneyFallbackAnswer(), cacheHit: false, modelCalled: false, writes: [], missOutcome: 'money-fallback' };
    }
    if (conditionsUpFront.has('maintenance')) {
      return {
        handled: true, data: unsupportedConditionAnswer('maintenance', 'customers'), cacheHit: false, modelCalled: false, writes: [],
        missOutcome: 'maintenance-fallback',
      };
    }
    // R7 guardrail item 1 (R7_MEASURE.md: "How many Trane units had a repeat visit within 90 days of
    // installation?" answered with the plain Trane count — the plan silently dropped the relationship). Same
    // idiom as money/maintenance above: CONDITION_CROSS_VISIT_RELATION/CONDITION_RATIO have no
    // CONDITION_PLAN_FIELD entry (analytics.js) and never will (no flat plan can express either), so deciding
    // this before the plan/cache is both cheaper (no wasted Haiku call) and immune to a stale cached wrong
    // answer for the same reason the round-6 fix above was needed. missOutcome routes this through ask.js's
    // "give the agent one shot first" branch (api/ask.js, near tryAgent()) rather than a bare decline, since a
    // real multi-hop agent CAN answer these — this layer must only ever decline to guess, never answer wrong.
    if (conditionsUpFront.has(CONDITION_CROSS_VISIT_RELATION)) {
      return {
        handled: true, data: unsupportedConditionAnswer(CONDITION_CROSS_VISIT_RELATION, 'customers'), cacheHit: false, modelCalled: false, writes: [],
        missOutcome: 'unsupported-condition', missMeta: { condition: CONDITION_CROSS_VISIT_RELATION },
      };
    }
    if (conditionsUpFront.has(CONDITION_RATIO)) {
      return {
        handled: true, data: unsupportedConditionAnswer(CONDITION_RATIO, 'customers'), cacheHit: false, modelCalled: false, writes: [],
        missOutcome: 'unsupported-condition', missMeta: { condition: CONDITION_RATIO },
      };
    }

    // Item 7 (100-question persona sample, 2026-09-22): "customers with a
    // proposal but no invoice" — a fully deterministic hasDocType/lacksDocType
    // plan, decided the same up-front way as money/maintenance above (never
    // asked of the model — see parseCrossDocCondition's own doc comment in
    // analytics.js for why this is safer than teaching the planner a new
    // vocabulary). A cross-doc phrasing paired with a time window this file
    // can't express against a customers-level plan (e.g. "...but no service
    // this year" — service visits aren't a document type) falls back
    // honestly, naming the unsupported half, rather than silently ignoring it.
    const cross = parseCrossDocCondition(question_n);
    if (cross) {
      if (cross.unsupported) {
        return {
          handled: true, data: crossDocUnsupportedAnswer(cross), cacheHit: false, modelCalled: false, writes: [],
          missOutcome: 'cross-doc-unsupported',
        };
      }
      const crossPlan = {
        entity: 'customers', op: 'list',
        filters: [
          { field: 'hasDocType', op: 'eq', value: cross.hasType },
          ...(cross.lacksType ? [{ field: 'lacksDocType', op: 'eq', value: cross.lacksType }] : []),
        ],
      };
      const data = await withTenant(ctxArg, (db) => executeAnalyticsPlan(db, crossPlan, { today }));
      if (data) return { handled: true, data, cacheHit: false, modelCalled: false, writes: [] };
      // Fell through (no data) — treat like any other unusable plan and let
      // ask.js's own retrieval+model path take the question instead.
    }

    // ---- Tier 1: exact question text, checked BEFORE the Haiku call -------
    const qHash = analyticsQuestionHash(question_n);
    // noCache: Donovan Scorecard calls (api/_lib/scorecard) always exercise the live planner, never a stored answer.
    const qProbe = noCache ? { row: null, corpusStamp: null } : await withTenant(ctxArg, (db) =>
      getCacheEntry(db, { questionHash: qHash, today, promptVersion })
    );
    if (isCacheHit(qProbe.row, qProbe.corpusStamp)) {
      return { handled: true, data: qProbe.row.answer, cacheHit: true, modelCalled: false, writes: [] };
    }

    // modelCalled: true from here on, REGARDLESS of whether this question
    // ends up `handled` — planAnalyticsQuestion is the one Haiku call this
    // feature makes, and it just ran. Monthly-allowance counting (owner
    // decision, 2026-09-21, see usage.js's isCountableAskSource) keys off
    // this, not off `handled`: a plan that comes back but turns out
    // unusable (invalid, no matching data) still spent a real model call,
    // even though api/ask.js will fall through to retrieval+model right
    // after — that fallback's own model call is the one actually counted
    // for the question (see api/ask.js's own doc comment at its call site),
    // so this file never double-reports one question as two.
    const plan = await planAnalyticsQuestion(question_n, { today, overlay, tenantVocab });
    if (!plan) return { ...EMPTY, modelCalled: true };

    // A1(b): a question that named something specific (a street number, a
    // ZIP, a serial fragment) but produced an unfiltered customers list/count
    // plan is a sign the classifier let a single-record question through —
    // fall back to retrieval+model rather than confidently answering "every
    // customer" for what was really a lookup about one of them.
    if (suspiciousUnfilteredCustomerPlan(plan, question_n)) return { ...EMPTY, modelCalled: true };

    // Round 5 item 3: the plan silently dropped a condition the question
    // actually named (email/phone/brand/county/month) — answering the
    // unfiltered query anyway would look confidently right and be wrong
    // (exactly item 2's original bug shape). Answered honestly instead of
    // executed or falling through, and not cached — see missingConditions'
    // own doc comment in analytics.js.
    // Item 4 (100-question persona sample, 2026-09-22): a condition the
    // question named but the model's plan dropped is no longer an automatic
    // honest fallback — buildConditionOverrideFilter first tries to add the
    // filter deterministically (email/phone polarity from "no"/"without" vs
    // "have"/"on file"; brand/county/city/state/zip from the matched word
    // itself). Only a condition it genuinely can't resolve this way still
    // falls back honestly, and only for that one condition.
    const missing = missingConditions(plan, question_n);
    let planWithOverrides = plan;
    if (missing.size > 0) {
      const stillMissing = [];
      const addedFilters = [];
      for (const condition of missing) {
        const override = buildConditionOverrideFilter(condition, question_n);
        if (override) addedFilters.push(override);
        else stillMissing.push(condition);
      }
      if (stillMissing.length > 0) {
        const [condition] = stillMissing;
        return {
          handled: true, data: unsupportedConditionAnswer(condition, plan.entity), cacheHit: false, modelCalled: true, writes: [],
          missOutcome: 'unsupported-condition', missMeta: { condition, plan },
        };
      }
      planWithOverrides = { ...plan, filters: [...(plan.filters ?? []), ...addedFilters] };
    }

    // ---- Tier 2: the plan itself, checked once the plan is known ----------
    // Two different phrasings that resolve to the identical plan reuse one
    // answer here without ever re-running the SQL — see analyticsPlanHash's
    // own doc comment for why this can never collide with a DIFFERENT plan.
    // Hashed with the overrides already applied (planWithOverrides) so a
    // question needing a condition override never shares a cache row with
    // one that didn't.
    const pHash = analyticsPlanHash(planWithOverrides);
    const pProbe = noCache ? { row: null, corpusStamp: null } : await withTenant(ctxArg, (db) =>
      getCacheEntry(db, { questionHash: pHash, today, promptVersion })
    );
    // Item 5: the extended windows' own label ("in Q2 2026", "year to date",
    // ...) — resolveAnyTimeRange re-derives it from the question text rather
    // than threading it through planAnalyticsQuestion/validatePlan, since the
    // label is display-only and never part of the closed plan vocabulary.
    const timeRangeLabel = planWithOverrides.timeRange ? resolveAnyTimeRange(question_n, today)?.label ?? null : null;

    let data;
    if (isCacheHit(pProbe.row, pProbe.corpusStamp)) {
      data = pProbe.row.answer;
    } else {
      data = await withTenant(ctxArg, (db) => executeAnalyticsPlan(db, planWithOverrides, { today, timeRangeLabel }));
      if (!data) return { ...EMPTY, modelCalled: true };
    }

    // Both tiers get written on a fresh answer (or a Tier-2 hit that Tier 1
    // hadn't seen yet, so the NEXT identical phrasing hits Tier 1 directly).
    // Corpus stamps for the two probes are computed a few milliseconds apart
    // from the same STAMP_EXPR query; using each probe's own stamp for its
    // own row is correct even in the vanishingly rare case a write landed
    // between them — worst case is one extra cache miss next time, never a
    // wrong answer.
    return {
      handled: true, data, cacheHit: false, modelCalled: true,
      writes: [
        { questionHash: qHash, corpusStamp: qProbe.corpusStamp },
        { questionHash: pHash, corpusStamp: pProbe.corpusStamp },
      ],
    };
  } catch (err) {
    console.error('Analytics question failed, falling through to retrieval+model:', err?.message);
    return EMPTY;
  }
}
