/**
 * TEAM H (2026-09-24): builds ONE TENANT's own auto-generated exam from its
 * industry pack's examTemplates (api/_lib/industry/index.js) — fills any
 * {placeholder} tokens from that tenant's OWN data (customer names,
 * addresses, brands, document types, months — never a hard-coded value),
 * deterministically seeded by (tenantKey, date, templateId) so the same
 * tenant+day always regenerates the identical exam, and skips a template
 * outright when this tenant has no data for a placeholder it needs (never a
 * failure — same "skip, don't fail" discipline oracle.js's own `requires`
 * guard already uses for the founder's static exam).
 *
 * The output is exactly scorecard/runner.js's own question shape
 * ({id, category, text, cmp, oracle, rubric?, citationRequired, ...}), so
 * runScorecard() needs NO change at all to run a tenant's own exam — it
 * already takes an arbitrary `questions` array.
 */
import { withTenant } from '../recordsStore.js';
import { VALID_CMP } from './exam.js';
import { stableHash } from '../learning/rotation.js';

/** Pure: exam.js's own validQuestions requires the founder exam.json's object-shaped
 *  {sql,params} oracle; an industry-pack examTemplate's oracle is Team G's compact
 *  "templateId:param" STRING form instead (resolved at run time by oracle.js via
 *  resolveOracle), so a tenant exam question is well-formed with either shape. */
function validTenantQuestions(list) {
  return (Array.isArray(list) ? list : []).filter((q) => q && typeof q.id === 'string' && typeof q.text === 'string' && q.text.length <= 300
    && typeof q.category === 'string' && VALID_CMP.has(q.cmp)
    && q.oracle && (typeof q.oracle === 'string' || typeof q.oracle.sql === 'string')
    && (q.cmp !== 'rubric' || typeof q.rubric === 'string'));
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

/** Deterministic pick: the same (seed, n) always picks the same index. Pure. */
function pickIndex(seed, n) {
  return n > 0 ? stableHash(seed) % n : -1;
}

/** One small, generic, read-only lookup per placeholder KIND (never per
 *  template) — RLS already scopes every row to this tenant, since this runs
 *  inside the same withTenant transaction oracle.js later reuses. An unknown
 *  placeholder kind has no entry here, so it resolves to an empty pool and
 *  every template that needs it is skipped, never left with a literal
 *  unfilled "{x}" in it. */
const PLACEHOLDER_QUERIES = {
  customer: "SELECT data->>'customer_name' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid AND data->>'customer_name' IS NOT NULL ORDER BY created_at ASC LIMIT 200",
  address: "SELECT data->>'service_address' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid AND data->>'service_address' IS NOT NULL ORDER BY created_at ASC LIMIT 200",
  brand: "SELECT DISTINCT data->>'manufacturer' AS v FROM entities WHERE entity_type = 'equipment' AND tenant_id = (current_setting('app.tenant_id', true))::uuid AND data->>'manufacturer' IS NOT NULL ORDER BY 1 LIMIT 50",
  docType: 'SELECT DISTINCT document_type AS v FROM documents WHERE tenant_id = (current_setting(\'app.tenant_id\', true))::uuid AND document_type IS NOT NULL ORDER BY 1 LIMIT 50',
  month: "SELECT DISTINCT to_char(created_at, 'YYYY-MM') AS v FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid ORDER BY 1 LIMIT 24",
};

/** Values for every placeholder KIND this pack's templates reference, one small query per kind. */
async function loadPlaceholderPools(ctxArg, kinds) {
  const pools = {};
  await withTenant(ctxArg, async (db) => {
    for (const kind of kinds) {
      const sql = PLACEHOLDER_QUERIES[kind];
      if (!sql) { pools[kind] = []; continue; }
      try {
        const { rows } = await db.raw(sql, []);
        pools[kind] = rows.map((r) => r.v).filter((v) => v != null && String(v).trim());
      } catch { pools[kind] = []; }
    }
  });
  return pools;
}

/** Pure: the placeholder kinds a template's question text references. */
export function placeholdersIn(text) {
  return [...new Set([...String(text ?? '').matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

/** Pure: substitute the same {placeholder} tokens into an oracle's own param
 *  list (a checked-in template may use the literal string "{customer}" as a
 *  param, the same sentinel idiom oracle.js already gives "@today" — the SQL
 *  TEXT itself is never templated with a value, only its bound params). */
function fillOracleParams(oracle, filled) {
  const sub = (v) => {
    if (typeof v !== 'string') return v;
    const m = /^\{(\w+)\}$/.exec(v);
    return m && filled[m[1]] !== undefined ? filled[m[1]] : v;
  };
  return {
    ...oracle,
    params: (oracle.params ?? []).map(sub),
    ...(oracle.requires ? { requires: { ...oracle.requires, params: (oracle.requires.params ?? []).map(sub) } } : {}),
    ...(oracle.alt ? { alt: { ...oracle.alt, params: (oracle.alt.params ?? []).map(sub) } } : {}),
  };
}

/**
 * Pure: fill one template's {placeholders} deterministically from `pools`.
 * Returns null (skip this template) when a referenced placeholder has no
 * data at all for this tenant.
 * @param {object} template  one industry/index.js examTemplates entry
 * @param {Record<string,string[]>} pools
 * @param {string} seedBase  e.g. "tenantKey:2026-09-24"
 */
export function fillTemplate(template, pools, seedBase) {
  const kinds = placeholdersIn(template.question);
  if (!kinds.length) return { ...template, filled: {} };
  const filled = {};
  for (const kind of kinds) {
    const pool = pools[kind] ?? [];
    if (!pool.length) return null;
    filled[kind] = pool[pickIndex(`${seedBase}:${template.id}:${kind}`, pool.length)];
  }
  let question = template.question;
  for (const [k, v] of Object.entries(filled)) question = question.split(`{${k}}`).join(v);
  return { ...template, question, filled, oracle: template.oracle ? fillOracleParams(template.oracle, filled) : template.oracle };
}

/**
 * Build one tenant's exam-slice questions for `dateStr` from its pack's
 * examTemplates.
 * @param {{tenantKey:string,tenantName?:string}} ctxArg
 * @param {object} pack     industry/index.js pack shape
 * @param {string} dateStr  "YYYY-MM-DD" — seeds the deterministic fill
 * @param {number} [size]   cap on how many resolved questions to include (default: all)
 * @returns {Promise<{version:string, questions:object[]}>}
 */
export async function buildTenantExam(ctxArg, pack, dateStr, size) {
  const templates = Array.isArray(pack?.examTemplates) ? pack.examTemplates : [];
  if (!templates.length) return { version: `${pack?.id ?? 'unknown'}-empty`, questions: [] };

  const kinds = [...new Set(templates.flatMap((t) => placeholdersIn(t.question)))];
  const pools = kinds.length ? await loadPlaceholderPools(ctxArg, kinds) : {};
  const seedBase = `${ctxArg?.tenantKey}:${dateStr}`;

  const questions = [];
  for (const t of templates) {
    const filled = fillTemplate(t, pools, seedBase);
    if (!filled) continue; // no data for this tenant -> skip, never fail
    questions.push({
      id: filled.id, category: filled.category, text: filled.question, cmp: filled.compare, oracle: filled.oracle,
      ...(filled.rubric ? { rubric: filled.rubric } : {}), citationRequired: Boolean(filled.citationRequired),
      ...(filled.tolerance != null ? { tolerance: filled.tolerance } : {}), ...(filled.anyNumber ? { anyNumber: true } : {}),
      ...(filled.maxItems != null ? { maxItems: filled.maxItems } : {}), ...(filled.persona ? { persona: filled.persona } : {}),
    });
  }
  const sliced = validTenantQuestions(questions);
  const out = Number.isFinite(size) && size > 0 ? sliced.slice(0, size) : sliced;
  return { version: `${pack?.id ?? 'unknown'}-${dateStr}`, questions: out };
}
