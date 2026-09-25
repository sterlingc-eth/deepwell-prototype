/**
 * Industry pack registry (Team G, 2026-09-24).
 *
 * DeepWell/Donovan is expanding out of HVAC-only into plumbing, electrical and
 * property management. Before this file, HVAC knowledge was hard-coded across
 * a dozen api/_lib modules (document types, extraction fields, synonym maps,
 * maintenance cadence, warranty rules, agent prompt wording, question banks,
 * scorecard exam templates). This file — and api/_lib/industry/packs/*.js —
 * is the single seam every one of those modules now reads through instead.
 *
 * CONTRACT (Team H's autonomous-learning-loop work consumes this; do not
 * change shape without updating both sides):
 *
 *   getPack(id)            -> a pack object (see packs/*.js), or the hvac
 *                             pack if `id` is unknown/empty (never throws,
 *                             never returns null/undefined).
 *   listPacks()             -> [pack, pack, ...] in PACK_IDS order.
 *   PACK_IDS                -> ['hvac', 'plumbing', 'electrical', 'property']
 *   packForTenant(dbOrCtx)  -> resolves the CALLING tenant's industry from
 *                             tenants.settings->>'industry' (default 'hvac';
 *                             tolerates a missing column/row/settings key —
 *                             never throws) and returns its pack.
 *
 * Pack shape (every field below is required on every pack):
 *   { id, label, businessNoun, documentTypes, fields, unitNoun, brands,
 *     synonyms, abbreviations, typos, maintenance, warranty, personas,
 *     examTemplates }
 * See packs/hvac.js for the fullest documentation of each field, since it is
 * the one pack whose values must reproduce today's HVAC behavior exactly.
 *
 * No DDL: `tenants.settings` is a JSONB column that has existed since
 * M3-config/01-create-schema.sql. Industry lives entirely in that JSON.
 */
import hvacPack from './packs/hvac.js';
import plumbingPack from './packs/plumbing.js';
import electricalPack from './packs/electrical.js';
import propertyPack from './packs/property.js';

export const PACK_IDS = ['hvac', 'plumbing', 'electrical', 'property'];

const PACKS_BY_ID = new Map([
  ['hvac', hvacPack],
  ['plumbing', plumbingPack],
  ['electrical', electricalPack],
  ['property', propertyPack],
]);

/** Always returns a usable pack — an unknown/empty id falls back to hvac, the
 *  historical default, rather than throwing or returning nothing. */
export function getPack(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return PACKS_BY_ID.get(key) ?? hvacPack;
}

export function listPacks() {
  return PACK_IDS.map((id) => PACKS_BY_ID.get(id));
}

/* ------------------------------------------------------------ tenant resolution */

const TENANT_INDUSTRY_TTL_MS = 10 * 60 * 1000;
const tenantIndustryCache = new Map();

/** Clears the resolved-industry cache; scripts/verify-industry.mjs uses this
 *  between fixtures so one PGlite tenant's settings never leak into another's
 *  assertions inside the same process. */
export function resetPackForTenantCacheForTests() {
  tenantIndustryCache.clear();
}

/** True for anything that already looks like an open, tenant-scoped store
 *  (recordsStore.js's makeStore() result, or a bare {raw|query} client) —
 *  i.e. something packForTenant can query directly, with no transaction of
 *  its own to open. */
function looksLikeDb(x) {
  return Boolean(x) && (typeof x.raw === 'function' || typeof x.query === 'function');
}

async function queryIndustry(db) {
  const run = typeof db.raw === 'function' ? db.raw.bind(db) : db.query.bind(db);
  const { rows } = await run(
    "SELECT settings->>'industry' AS industry FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid",
    []
  );
  return rows?.[0]?.industry ?? null;
}

/**
 * Resolves the tenant's industry pack.
 *
 * Accepts either:
 *   - a `db` handle already inside a tenant-scoped transaction (anything
 *     recordsStore.js's withTenant() hands its callback — has `.raw` or
 *     `.query`), queried directly; or
 *   - a `{withTenant, ctxArg}` bag, used to open one short-lived transaction
 *     of its own.
 *
 * Tolerant by design: a missing `tenants` row, a missing/null `settings`,
 * a settings blob with no `industry` key, or a value that names no known
 * pack all resolve to 'hvac' — the product's default and only industry
 * before this change — rather than throwing. A real query failure (a
 * connection error, RLS misconfiguration) also degrades to 'hvac' rather
 * than taking down the caller; industry selection must never be able to
 * break a request that would otherwise have worked.
 */
export async function packForTenant(dbOrCtx) {
  if (looksLikeDb(dbOrCtx)) {
    const cacheKey = dbOrCtx.tenantId ? `db:${dbOrCtx.tenantId}` : null;
    if (cacheKey) {
      const hit = tenantIndustryCache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return getPack(hit.industry);
    }
    let industry = null;
    try { industry = await queryIndustry(dbOrCtx); } catch { industry = null; }
    if (cacheKey) tenantIndustryCache.set(cacheKey, { industry, expiresAt: Date.now() + TENANT_INDUSTRY_TTL_MS });
    return getPack(industry);
  }

  const ctx = dbOrCtx?.ctxArg ?? dbOrCtx;
  const withTenant = dbOrCtx?.withTenant;
  const cacheKey = ctx?.tenantKey ? `ctx:${ctx.tenantKey}` : null;
  if (cacheKey) {
    const hit = tenantIndustryCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return getPack(hit.industry);
  }
  if (typeof withTenant !== 'function' || !ctx) return hvacPack;

  let industry = null;
  try {
    industry = await withTenant(ctx, (db) => queryIndustry(db));
  } catch {
    industry = null;
  }
  if (cacheKey) tenantIndustryCache.set(cacheKey, { industry, expiresAt: Date.now() + TENANT_INDUSTRY_TTL_MS });
  return getPack(industry);
}

/* ------------------------------------------------------------ oracle SQL templates
 *
 * Scorecard exam templates (see packs/*.js's `examTemplates`) reference one of
 * these by id instead of embedding bespoke SQL, so every industry's exam is
 * provably built ONLY against the six generic tables every tenant has:
 * documents, document_pages, extractions, entities, document_entity_links,
 * document_financials — never a HVAC-only column or view. Every template
 * takes the tenant id as its first bound parameter ($1); its own params
 * follow in the order listed. `resolveOracle` below parses the compact
 * "templateId:param1:param2" string form the contract calls for (`oracle:
 * 'sqlTemplateId'`) into the {sql, params} run_query needs.
 */
export const ORACLE_SQL_TEMPLATES = {
  // How many documents of one canonical type does this tenant have?
  count_documents_by_type: (typeId) => ({
    sql: `SELECT count(*)::int AS n FROM documents d
            WHERE d.tenant_id = $1 AND lower(replace(d.document_type, '_', '-')) = $2`,
    params: [typeId],
  }),
  // How many DISTINCT customers have at least one document of that type?
  count_customers_with_doctype: (typeId) => ({
    sql: `SELECT count(DISTINCT c.id)::int AS n
            FROM documents d
            JOIN document_entity_links l ON l.document_id = d.id AND l.tenant_id = d.tenant_id
            JOIN entities e ON e.id = l.entity_id AND e.tenant_id = d.tenant_id AND e.merged_into IS NULL
            JOIN entities c ON c.id = (CASE WHEN e.entity_type = 'customer' THEN e.id ELSE (e.data->>'customer_id')::uuid END)
                            AND c.tenant_id = d.tenant_id AND c.entity_type = 'customer' AND c.merged_into IS NULL
           WHERE d.tenant_id = $1 AND lower(replace(d.document_type, '_', '-')) = $2`,
    params: [typeId],
  }),
  // How many documents ever recorded a non-empty value for one field key (any type)?
  count_documents_with_field: (fieldKey) => ({
    sql: `SELECT count(DISTINCT x.document_id)::int AS n
            FROM extractions x
           WHERE x.tenant_id = $1 AND x.field_key = $2 AND coalesce(x.value, '') <> ''`,
    params: [fieldKey],
  }),
  // How many extraction rows for a field key match a value (case-insensitive substring/regex)?
  count_field_value_matches: (fieldKey, pattern) => ({
    sql: `SELECT count(*)::int AS n
            FROM extractions x
           WHERE x.tenant_id = $1 AND x.field_key = $2 AND x.value ~* $3`,
    params: [fieldKey, pattern],
  }),
  // Distinct values on file for one field key (e.g. every brand/model/equipment type actually seen).
  count_distinct_field_values: (fieldKey) => ({
    sql: `SELECT count(DISTINCT lower(x.value))::int AS n
            FROM extractions x
           WHERE x.tenant_id = $1 AND x.field_key = $2 AND coalesce(x.value, '') <> ''`,
    params: [fieldKey],
  }),
  // Full-corpus regex scan of page text (content-count style — see contentCount.js).
  count_documents_mentioning: (pattern) => ({
    sql: `SELECT count(DISTINCT p.document_id)::int AS n
            FROM document_pages p
           WHERE p.tenant_id = $1 AND p.text ~* $2`,
    params: [pattern],
  }),
  // How many entities of one generic entity_type ('customer'|'equipment'|'property'|'technician')?
  count_entities_by_type: (entityType) => ({
    sql: `SELECT count(*)::int AS n FROM entities e
           WHERE e.tenant_id = $1 AND e.entity_type = $2 AND e.merged_into IS NULL`,
    params: [entityType],
  }),
  // Documents of a type that have NO extraction row at all for a field key that type requires — an honest gap count.
  count_documents_missing_field: (typeId, fieldKey) => ({
    sql: `SELECT count(*)::int AS n
            FROM documents d
           WHERE d.tenant_id = $1 AND lower(replace(d.document_type, '_', '-')) = $2
             AND NOT EXISTS (
               SELECT 1 FROM extractions x
                WHERE x.tenant_id = d.tenant_id AND x.document_id = d.id AND x.field_key = $3
                  AND coalesce(x.value, '') <> ''
             )`,
    params: [typeId, fieldKey],
  }),
  // Sum of document_financials.total, optionally narrowed to one doc_kind ('*' = every kind).
  sum_financials_total: (docKind) => ({
    sql: docKind && docKind !== '*'
      ? `SELECT coalesce(sum(f.total), 0)::numeric AS n, count(*)::int AS documents
           FROM document_financials f WHERE f.tenant_id = $1 AND f.doc_kind = $2`
      : `SELECT coalesce(sum(f.total), 0)::numeric AS n, count(*)::int AS documents
           FROM document_financials f WHERE f.tenant_id = $1`,
    params: docKind && docKind !== '*' ? [docKind] : [],
  }),
  // Count of document_financials rows in one status ('unpaid'|'partial'|'paid'|'unknown').
  count_financials_by_status: (status) => ({
    sql: `SELECT count(*)::int AS n FROM document_financials f
           WHERE f.tenant_id = $1 AND f.status = $2`,
    params: [status],
  }),
  // How many extraction rows for a date-shaped field fall within the next N days (an expiring-soon count)?
  count_field_date_within_days: (fieldKey, days) => ({
    sql: `SELECT count(*)::int AS n
            FROM extractions x
           WHERE x.tenant_id = $1 AND x.field_key = $2
             AND x.value ~ '^\\d{4}-\\d{2}(-\\d{2})?$'
             AND (CASE WHEN length(x.value) = 7 THEN x.value || '-01' ELSE x.value END)::date
                 BETWEEN CURRENT_DATE AND CURRENT_DATE + ($3 || ' days')::interval`,
    params: [fieldKey, days],
  }),
  // How many extraction rows for a date-shaped field are already in the past (an "already expired/overdue" count)?
  count_field_date_before_today: (fieldKey) => ({
    sql: `SELECT count(*)::int AS n
            FROM extractions x
           WHERE x.tenant_id = $1 AND x.field_key = $2
             AND x.value ~ '^\\d{4}-\\d{2}(-\\d{2})?$'
             AND (CASE WHEN length(x.value) = 7 THEN x.value || '-01' ELSE x.value END)::date < CURRENT_DATE`,
    params: [fieldKey],
  }),
  // Average of a numeric-shaped field (cost, labor_hours, amperage, gallons, ...).
  avg_numeric_field: (fieldKey) => ({
    sql: `SELECT avg(x.value::numeric)::numeric AS n
            FROM extractions x
           WHERE x.tenant_id = $1 AND x.field_key = $2 AND x.value ~ '^-?\\d+(\\.\\d+)?$'`,
    params: [fieldKey],
  }),
  // Total document count on file, no filter (the honest denominator for "how much of our corpus is X").
  count_documents_total: () => ({
    sql: `SELECT count(*)::int AS n FROM documents d WHERE d.tenant_id = $1`,
    params: [],
  }),
};

/** "templateId:param1:param2" -> {sql, values} ready for run_query, with $1 always the tenant id.
 *  Numeric-looking params are passed through as numbers (count_field_date_within_days's `days`);
 *  everything else stays a string. Unknown template ids return null rather than throwing, so a
 *  caller (verify-industry.mjs, the learning loop) can report "no such oracle" as data, not a crash. */
export function resolveOracle(oracleId, tenantId) {
  const [name, ...rawParams] = String(oracleId ?? '').split(':');
  const build = ORACLE_SQL_TEMPLATES[name];
  if (!build) return null;
  const params = rawParams.map((p) => (/^-?\d+$/.test(p) ? Number(p) : p));
  const { sql, params: extra } = build(...params);
  return { sql, values: [tenantId, ...extra] };
}

/* ------------------------------------------------------------ contract validation */

const REQUIRED_PACK_KEYS = [
  'id', 'label', 'businessNoun', 'documentTypes', 'fields', 'unitNoun',
  'brands', 'synonyms', 'abbreviations', 'typos', 'maintenance', 'warranty',
  'personas', 'examTemplates',
];

/** Structural check against the contract this file documents above — used by
 *  scripts/verify-industry.mjs, exported so any other caller (Team H's
 *  learning loop, a future pack-authoring tool) can validate a candidate pack
 *  the same way. Returns a list of problem strings; empty = valid. */
export function validatePack(pack) {
  const problems = [];
  if (!pack || typeof pack !== 'object') return ['pack is not an object'];
  for (const key of REQUIRED_PACK_KEYS) {
    if (!(key in pack)) problems.push(`missing key: ${key}`);
  }
  if (typeof pack.id !== 'string' || !pack.id) problems.push('id must be a non-empty string');
  if (typeof pack.businessNoun !== 'string' || !pack.businessNoun) problems.push('businessNoun must be a non-empty string');
  if (typeof pack.unitNoun !== 'string' || !pack.unitNoun) problems.push('unitNoun must be a non-empty string');
  if (!Array.isArray(pack.documentTypes) || !pack.documentTypes.length) problems.push('documentTypes must be a non-empty array');
  for (const dt of pack.documentTypes ?? []) {
    if (!dt?.id || !dt?.label || !dt?.definition) problems.push(`documentType missing id/label/definition: ${JSON.stringify(dt)}`);
    if (!Array.isArray(dt?.requires)) problems.push(`documentType.requires must be an array: ${dt?.id}`);
    if (typeof dt?.visitType !== 'boolean') problems.push(`documentType.visitType must be boolean: ${dt?.id}`);
    if (typeof dt?.financial !== 'boolean') problems.push(`documentType.financial must be boolean: ${dt?.id}`);
  }
  if (!Array.isArray(pack.fields) || !pack.fields.length) problems.push('fields must be a non-empty array');
  for (const f of pack.fields ?? []) {
    if (!f?.key || !f?.label) problems.push(`field missing key/label: ${JSON.stringify(f)}`);
    if (typeof f?.perUnit !== 'boolean') problems.push(`field.perUnit must be boolean: ${f?.key}`);
  }
  if (!Array.isArray(pack.brands)) problems.push('brands must be an array');
  if (!pack.synonyms || typeof pack.synonyms !== 'object') problems.push('synonyms must be an object');
  if (!pack.abbreviations || typeof pack.abbreviations !== 'object') problems.push('abbreviations must be an object');
  if (!pack.typos || typeof pack.typos !== 'object') problems.push('typos must be an object');
  if (!pack.maintenance || typeof pack.maintenance.defaultCadenceMonths !== 'number') problems.push('maintenance.defaultCadenceMonths must be a number');
  if (!Array.isArray(pack.maintenance?.cadencePhrases)) problems.push('maintenance.cadencePhrases must be an array');
  if (!pack.maintenance?.seasons || typeof pack.maintenance.seasons !== 'object') problems.push('maintenance.seasons must be an object');
  if (!pack.warranty || typeof pack.warranty !== 'object') problems.push('warranty must be an object');
  if (!Array.isArray(pack.personas) || !pack.personas.length) problems.push('personas must be a non-empty array');
  for (const p of pack.personas ?? []) {
    if (!p?.id || !p?.label) problems.push(`persona missing id/label: ${JSON.stringify(p)}`);
    if (!Array.isArray(p?.sampleQuestions) || !p.sampleQuestions.length) problems.push(`persona.sampleQuestions must be non-empty: ${p?.id}`);
  }
  if (!Array.isArray(pack.examTemplates) || !pack.examTemplates.length) problems.push('examTemplates must be a non-empty array');
  const seenExamIds = new Set();
  for (const t of pack.examTemplates ?? []) {
    if (!t?.id || !t?.category || !t?.question) problems.push(`examTemplate missing id/category/question: ${JSON.stringify(t)}`);
    if (t?.id && seenExamIds.has(t.id)) problems.push(`duplicate examTemplate id: ${t.id}`);
    if (t?.id) seenExamIds.add(t.id);
    if (!t?.oracle) problems.push(`examTemplate missing oracle: ${t?.id}`);
    if (typeof t?.oracle === 'string' && !resolveOracle(t.oracle, '00000000-0000-0000-0000-000000000000')) {
      problems.push(`examTemplate oracle references unknown sql template: ${t?.id} -> ${t.oracle}`);
    }
    if (!['number', 'set', 'value', 'honest-zero', 'rubric'].includes(t?.compare)) problems.push(`examTemplate.compare invalid: ${t?.id} -> ${t?.compare}`);
    if (t?.compare === 'rubric' && !t?.rubric) problems.push(`examTemplate compare=rubric needs a rubric: ${t?.id}`);
    if (typeof t?.citationRequired !== 'boolean') problems.push(`examTemplate.citationRequired must be boolean: ${t?.id}`);
  }
  return problems;
}
