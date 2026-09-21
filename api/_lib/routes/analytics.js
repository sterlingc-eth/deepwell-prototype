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
  ANALYTICS_SYSTEM_PROMPT,
  ANALYTICS_PROMPT_VERSION,
  analyticsQuestionHash,
  analyticsPlanHash,
  suspiciousUnfilteredCustomerPlan,
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
export async function planAnalyticsQuestion(question, { today } = {}) {
  try {
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const deadlineAt = Date.now() + MODEL_TIMEOUT_MS;
    const response = await withBackoff(
      () =>
        client.messages.create(
          {
            model: ANALYTICS_MODEL,
            max_tokens: 400,
            temperature: 0,
            system: ANALYTICS_SYSTEM_PROMPT,
            tools: [ANALYTICS_TOOL],
            tool_choice: { type: 'tool', name: 'analytics_plan' },
            messages: [{ role: 'user', content: `Today's date: ${today}\n\nQUESTION: ${question}` }],
          },
          { timeout: Math.max(1000, deadlineAt - Date.now()) }
        ),
      { deadlineAt }
    );
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    return validatePlan(toolUse?.input);
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

function shapeDocumentRow(r) {
  return {
    id: r.id, label: documentTypeLabel(r.document_type), value: r.original_filename || r.id,
    entityId: undefined, documentType: r.document_type,
    month: r.created_at ? new Date(r.created_at).toISOString().slice(0, 7) : null,
  };
}

/** Filters whose field this entity's row shape doesn't carry at all — e.g. a
 *  "brand" filter against `documents` — make the plan meaningless for this
 *  entity. Rather than silently ignoring it (answering a DIFFERENT question
 *  than what was asked), treat it as a fall-through, same as an invalid plan. */
const ENTITY_SUPPORTED_FIELDS = {
  customers: new Set(['state', 'county', 'city', 'zip', 'customerName']),
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

  // Only the equipment-level filters apply here (state/county/city/zip are
  // already on the unit's own row via its service_address; customerName has
  // no equivalent on an equipment row and is intentionally left to fail
  // closed — see matchesFilter's own null-actual -> false rule — rather than
  // silently ignored).
  const filtered = applyEntityFilters(unitRows, plan.filters);
  if (!filtered.length) return { rows: [], unfilteredCustomerIds: [] };

  const customerIds = [...new Set(filtered.map((r) => r.customerId))];
  const { rows: custRaw } = await db.raw(
    `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
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
      customerName: cust.customer_name,
      // Every equipment-level field, not just brand/model — executeAnalyticsPlan
      // re-runs applyEntityFilters on whatever this function returns (the same
      // idempotent second pass every other entity branch gets), so a plan
      // combining e.g. brand + warrantyStatus must still find both fields here.
      brand: unit.brand, model: unit.model, equipmentType: unit.equipmentType,
      tonnage: unit.tonnage, refrigerant: unit.refrigerant, installYear: unit.installYear,
      warrantyStatus: unit.warrantyStatus,
    });
  }
  return { rows };
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
export async function executeAnalyticsPlan(db, plan, { today } = {}) {
  // "who's our biggest customer" (round 4, item 1) — a distinct shape from
  // every other op: ranked, not filtered/counted. validatePlan already
  // guarantees sortBy only ever appears with entity 'customers' + op 'list'.
  if (plan.sortBy) {
    const rows = await queryTopCustomers(db, plan.sortBy, plan.limit ?? TOP_CUSTOMERS_LIMIT);
    return formatAnalyticsAnswer(plan, { total: rows.length, rows });
  }

  if (!filtersSupported(plan.entity, plan.filters)) return null;

  const hasEquipmentJoinFilter =
    plan.entity === 'customers' && (plan.filters ?? []).some((f) => EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN.has(f.field));

  let rows;
  if (hasEquipmentJoinFilter) {
    // Gaps 1 + 3: "which customers have Trane units" — a customer filtered
    // by an equipment-level attribute. queryCustomersByEquipmentFilter already
    // applies every filter itself (equipment-level AND the geo ones a unit's
    // own address also carries), so `filtered` below is a no-op pass-through
    // (matchesAllFilters([], []) === true) rather than re-filtering.
    ({ rows } = await queryCustomersByEquipmentFilter(db, plan, { today }));
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
    rows = raw.map((r) => shapeDocumentRow(r));
    if (plan.timeRange) {
      rows = rows.filter((r) => {
        if (plan.timeRange.from && (r.month ?? '') < plan.timeRange.from.slice(0, 7)) return false;
        if (plan.timeRange.to && (r.month ?? '') > plan.timeRange.to.slice(0, 7)) return false;
        return true;
      });
    }
  } else {
    // serviceVisits: service_date + technician are two different
    // extractions.field_key rows for the same document — fetched separately
    // and merged here, tenant-scoped identically to buildAnalyticsSQL's own
    // service_date query.
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
    rows = dateRows.map((r) => ({
      id: r.document_id, label: techByDoc.get(r.document_id) || 'Unassigned',
      value: r.value, entityId: undefined,
      technician: techByDoc.get(r.document_id) ?? null,
      month: /^\d{4}-\d{2}/.test(r.value ?? '') ? r.value.slice(0, 7) : null,
    }));
    if (plan.timeRange) {
      rows = rows.filter((r) => {
        if (plan.timeRange.from && (r.value ?? '') < plan.timeRange.from) return false;
        if (plan.timeRange.to && (r.value ?? '') > plan.timeRange.to) return false;
        return true;
      });
    }
  }

  const filtered = applyEntityFilters(rows, plan.filters);
  const total = filtered.length;

  let groups = [];
  if (plan.op === 'groupBy') groups = groupRows(filtered, keyOf(plan.groupBy));

  let sum = null;
  if (plan.op === 'sum') {
    sum = filtered.reduce((acc, r) => acc + (Number(r.tonnage ?? r.value) || 0), 0);
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

  return formatAnalyticsAnswer(plan, {
    total, groups, rows: filtered, sum, unfilteredTotal, broaderGroups,
  });
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
export async function runAnalyticsQuestion({ withTenant, ctxArg, question, today }) {
  const EMPTY = { handled: false, data: null, cacheHit: false, writes: [] };
  try {
    // ---- Tier 1: exact question text, checked BEFORE the Haiku call -------
    const qHash = analyticsQuestionHash(question);
    const qProbe = await withTenant(ctxArg, (db) =>
      getCacheEntry(db, { questionHash: qHash, today, promptVersion: ANALYTICS_PROMPT_VERSION })
    );
    if (isCacheHit(qProbe.row, qProbe.corpusStamp)) {
      return { handled: true, data: qProbe.row.answer, cacheHit: true, writes: [] };
    }

    const plan = await planAnalyticsQuestion(question, { today });
    if (!plan) return EMPTY;

    // A1(b): a question that named something specific (a street number, a
    // ZIP, a serial fragment) but produced an unfiltered customers list/count
    // plan is a sign the classifier let a single-record question through —
    // fall back to retrieval+model rather than confidently answering "every
    // customer" for what was really a lookup about one of them.
    if (suspiciousUnfilteredCustomerPlan(plan, question)) return EMPTY;

    // ---- Tier 2: the plan itself, checked once the plan is known ----------
    // Two different phrasings that resolve to the identical plan reuse one
    // answer here without ever re-running the SQL — see analyticsPlanHash's
    // own doc comment for why this can never collide with a DIFFERENT plan.
    const pHash = analyticsPlanHash(plan);
    const pProbe = await withTenant(ctxArg, (db) =>
      getCacheEntry(db, { questionHash: pHash, today, promptVersion: ANALYTICS_PROMPT_VERSION })
    );

    let data;
    if (isCacheHit(pProbe.row, pProbe.corpusStamp)) {
      data = pProbe.row.answer;
    } else {
      data = await withTenant(ctxArg, (db) => executeAnalyticsPlan(db, plan, { today }));
      if (!data) return EMPTY;
    }

    // Both tiers get written on a fresh answer (or a Tier-2 hit that Tier 1
    // hadn't seen yet, so the NEXT identical phrasing hits Tier 1 directly).
    // Corpus stamps for the two probes are computed a few milliseconds apart
    // from the same STAMP_EXPR query; using each probe's own stamp for its
    // own row is correct even in the vanishingly rare case a write landed
    // between them — worst case is one extra cache miss next time, never a
    // wrong answer.
    return {
      handled: true, data, cacheHit: false,
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
