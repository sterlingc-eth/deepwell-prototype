/**
 * dql/load.js - ONE tenant-scoped read of the organization's records per request: documents, extractions (a corrected value wins),
 * customers, equipment, links, financials and financial lines. db.raw + TENANT_SQL, the same way relations/timeline.js and compose.js read.
 * Merged entities are left out here (merged_into IS NULL); internal-audience documents are left out by the shared audience fragment
 * (audience/sql.js) and again by snapshot.js, which also never reads an HR letter.
 */
import { TENANT_SQL, todayIso } from '../scope.js';
import { documentsHaveAudience } from '../audience/probe.js';
import { audienceFilterSql } from '../audience/sql.js';
import { buildSnapshot } from './snapshot.js';

const MAX_ROWS = 200000;

export async function loadRaw(db) {
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const audience = audienceFilterSql({ docAlias: 'd', hasAudienceColumn });
  const [docs, ex, ents, links] = await Promise.all([
    db.raw(`SELECT d.id, d.original_filename, d.document_type, d.created_at FROM documents d WHERE d.${TENANT_SQL} AND (${audience}) LIMIT ${MAX_ROWS}`, []),
    db.raw(`SELECT x.document_id, x.entity_id, x.field_key, x.value, x.corrected_value, x.created_at FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key NOT LIKE '\\_%' LIMIT ${MAX_ROWS}`, []),
    db.raw(`SELECT e.id, e.entity_type, e.customer_id, e.customer_number, e.data, e.merged_into FROM entities e WHERE e.merged_into IS NULL AND e.entity_type IN ('customer', 'equipment') AND e.${TENANT_SQL} LIMIT ${MAX_ROWS}`, []),
    db.raw(`SELECT l.document_id, l.entity_id FROM document_entity_links l WHERE l.${TENANT_SQL} LIMIT ${MAX_ROWS}`, []),
  ]);
  let financials = []; let lines = [];
  // probe first: a failed statement would abort the surrounding transaction
  const has = await db.raw(`SELECT to_regclass('document_financials') IS NOT NULL AS ok`, []);
  if (has.rows?.[0]?.ok) {
    financials = (await db.raw(`SELECT f.* FROM document_financials f WHERE f.${TENANT_SQL} LIMIT ${MAX_ROWS}`, [])).rows;
    lines = (await db.raw(`SELECT l.id, l.financial_id, l.document_id, l.line_no, l.description, l.qty, l.unit_price, l.amount FROM document_financial_lines l WHERE l.${TENANT_SQL} LIMIT ${MAX_ROWS}`, [])).rows;
  }
  const rows = (r) => r.rows ?? [];
  // a read that hit the row limit is a partial picture: DQL then declines to answer rather than count a part as the whole
  const truncated = [docs, ex, ents, links].some((r) => (r.rows?.length ?? 0) >= MAX_ROWS) || financials.length >= MAX_ROWS || lines.length >= MAX_ROWS;
  const toIso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    documents: rows(docs).map((d) => ({ ...d, created_at: toIso(d.created_at) })),
    extractions: rows(ex).map((e) => ({ ...e, created_at: toIso(e.created_at) })),
    entities: rows(ents),
    links: rows(links),
    financials: financials.map((f) => ({ ...f, invoice_date: toIso(f.invoice_date), due_date: toIso(f.due_date) })),
    lines,
    truncated,
  };
}

/** The snapshot DQL executes over (see snapshot.js for its shape). */
export async function loadSnapshot(db, { today } = {}) {
  const raw = await loadRaw(db);
  const snap = buildSnapshot(raw, { today: todayIso(today) });
  snap.truncated = Boolean(raw.truncated);
  return snap;
}
