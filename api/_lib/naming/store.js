/**
 * Naming engine — DB access (M3-config/41-document-display-names.sql).
 *
 * Every read/write here goes through `db.raw(sql, params)` (recordsStore.js's `makeStore`
 * exposes `.raw` for exactly this — same idiom as api/_lib/graph/build.js) inside a
 * `withTenant` transaction, so every statement carries the tenant predicate/RLS the rest of the
 * app relies on. Nothing here is a new curated recordsStore method — same reasoning as
 * routes/document-delete.js's own module comment: a naming-specific read/write shape doesn't
 * belong behind recordsStore's generic column-allowlist updater.
 *
 * WORKS BEFORE MIGRATION 41 IS PASTED: `displayNameColumnsExist` is probed once per warm
 * instance (same memoized-probe idiom as recordsStore.js's `documentsHaveUpdatedAt` /
 * `documentsHaveUploadedBy`) and every write/read below checks it first, degrading to a no-op
 * (never a 42703) when the column doesn't exist yet.
 */
import { TENANT_SQL } from '../scope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

let displayNameColumns = null;
/** Re-probed only on cold start (module-level cache) — reset for tests via
 *  `resetDisplayNameColumnsProbe`. */
export async function displayNameColumnsExist(db) {
  if (displayNameColumns !== null) return displayNameColumns;
  try {
    const { rows } = await db.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'display_name'`
    );
    displayNameColumns = rows.length > 0;
  } catch {
    displayNameColumns = false;
  }
  return displayNameColumns;
}

/** Test/harness only — clears the memoized probe so a freshly-migrated PGlite instance is
 *  re-checked instead of reusing a stale "false" from an earlier test in the same process. */
export function resetDisplayNameColumnsProbe() {
  displayNameColumns = null;
}

/** documents row this module needs, or null if it does not exist / is not this tenant's. */
export async function getNamingDocument(db, documentId) {
  if (!isUuid(documentId)) return null;
  const hasCol = await displayNameColumnsExist(db);
  const cols = hasCol
    ? 'id, document_type, verified_by, display_name, display_name_source'
    : 'id, document_type, verified_by, NULL AS display_name, NULL AS display_name_source';
  const { rows } = await db.raw(
    `SELECT ${cols} FROM documents WHERE id = $1 AND ${TENANT_SQL}`,
    [documentId]
  );
  return rows[0] ?? null;
}

/**
 * The classification confidence for this document's CURRENT document_type, read from the most
 * recent 'document.fields_extracted' audit_log entry (extractDocument.js already writes
 * `document_type_confidence`/`document_type` there — see that file's `logAction` call — so this
 * needs no new column). Returns null when no such entry exists (a document extracted before
 * that field was logged, or one whose type was set some other way) rather than guessing 0, so
 * callers can fall back to the `verified_by` signal alone.
 */
export async function getClassificationConfidence(db, documentId) {
  if (!isUuid(documentId)) return null;
  const { rows } = await db.raw(
    `SELECT (changes->>'document_type_confidence')::float8 AS confidence, changes->>'document_type' AS document_type
       FROM audit_log
      WHERE resource_id = $1 AND action = 'document.fields_extracted' AND ${TENANT_SQL}
      ORDER BY created_at DESC LIMIT 1`,
    [documentId]
  );
  const row = rows[0];
  if (!row || !Number.isFinite(Number(row.confidence))) return null;
  return { confidence: Number(row.confidence), documentType: row.document_type ?? null };
}

/** {field_key: value} for a document, corrected_value preferred over value (same "a human's
 *  correction wins" rule reviewStore.js/entityGraph.ts apply everywhere a fact is read). Only the
 *  columns the naming engine ever looks at are selected — this is a name, not a full field dump. */
const NAMING_FIELD_KEYS = [
  'customer_name', 'service_address', 'manufacturer', 'model', 'cost', 'invoice_number',
  'permit_number', 'service_date', 'installation_date', 'warranty_registered_date',
  'agreement_term', 'reminder_customer_name',
];
export async function getNamingFields(db, documentId) {
  if (!isUuid(documentId)) return {};
  const { rows } = await db.raw(
    `SELECT field_key, value, corrected_value FROM extractions
      WHERE document_id = $1 AND field_key = ANY($2::text[]) AND ${TENANT_SQL}`,
    [documentId, NAMING_FIELD_KEYS]
  );
  const fields = {};
  for (const r of rows) {
    const v = r.corrected_value ?? r.value;
    if (v != null && String(v).trim() !== '') fields[r.field_key] = v;
  }
  return fields;
}

/** Linked customer/equipment entities, in the {type, name, address, manufacturer, model} shape
 *  engine.js's `computeDisplayName` expects — a fallback for facts this document's OWN
 *  extraction didn't carry but a linked record already has on file (entities.data JSON, the same
 *  keys api/_lib/contactLookup.js / comparison.js / compose.js already read this way). */
export async function getNamingEntities(db, documentId) {
  if (!isUuid(documentId)) return [];
  const { rows } = await db.raw(
    `SELECT e.entity_type,
            e.data->>'customer_name' AS customer_name,
            e.data->>'service_address' AS service_address,
            e.data->>'manufacturer' AS manufacturer,
            e.data->>'model' AS model
       FROM document_entity_links l
       JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL
      WHERE l.document_id = $1 AND ${TENANT_SQL.replace('tenant_id', 'l.tenant_id')}`,
    [documentId]
  );
  return rows.map((r) => ({
    type: r.entity_type,
    name: r.customer_name ?? undefined,
    address: r.service_address ?? undefined,
    manufacturer: r.manufacturer ?? undefined,
    model: r.model ?? undefined,
  }));
}

/**
 * Sibling display_names for dedupe: other documents of the SAME type, linked to the same
 * customer entity (when one is linked), on the same date bucket — the exact "same customer/type/
 * date" grouping the round-12 contract calls out. A document with no linked customer and no
 * usable date dedupes against nothing (never over-matches on type alone, which would collide
 * unrelated customers' documents).
 */
export async function siblingDisplayNames(db, { documentId, typeId, customerId, dateKey }) {
  if (!(await displayNameColumnsExist(db))) return [];
  if (!customerId && !dateKey) return [];
  const conds = [`d.document_type = $1`, `d.display_name IS NOT NULL`, TENANT_SQL.replace('tenant_id', 'd.tenant_id')];
  const params = [typeId];
  if (documentId) { params.push(documentId); conds.push(`d.id <> $${params.length}`); }
  if (customerId) { params.push(customerId); conds.push(`EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = d.id AND l.entity_id = $${params.length})`); }
  if (dateKey) { params.push(dateKey); conds.push(`EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.field_key IN ('service_date','installation_date') AND COALESCE(x.corrected_value, x.value) = $${params.length})`); }
  const { rows } = await db.raw(
    `SELECT DISTINCT d.display_name FROM documents d WHERE ${conds.join(' AND ')} LIMIT 50`,
    params
  );
  return rows.map((r) => r.display_name).filter(Boolean);
}

/** The linked customer entity id for a document, if any (first customer link) — used to scope
 *  the dedupe query above. Not "the" owner in any broader sense, just a grouping key. */
export async function linkedCustomerId(db, documentId) {
  const { rows } = await db.raw(
    `SELECT e.id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.document_id = $1 AND e.entity_type = 'customer' AND ${TENANT_SQL.replace('tenant_id', 'l.tenant_id')}
      ORDER BY l.created_at LIMIT 1`,
    [documentId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Writes display_name/_source/_updated_at. No-op (returns false) when migration 41 has not been
 * pasted yet. `source` is 'auto' (assignDisplayName / backfill) or 'user' (a person renamed it) —
 * NEVER overwrites an existing 'user' name unless `force` is passed (renameDocument's own path).
 */
export async function writeDisplayName(db, documentId, name, source, { force = false } = {}) {
  if (!(await displayNameColumnsExist(db))) return false;
  const guard = force ? '' : ` AND display_name_source IS DISTINCT FROM 'user'`;
  const { rowCount } = await db.raw(
    `UPDATE documents SET display_name = $2, display_name_source = $3, display_name_updated_at = NOW()
      WHERE id = $1 AND ${TENANT_SQL}${guard}`,
    [documentId, name, source]
  );
  return rowCount > 0;
}

/** Documents eligible for the backfill batch: confirmed type (verified_by set OR a logged
 *  classification confidence — see assign.js's `isTypeConfirmed`), no display_name yet, oldest id
 *  first. Confidence is read per-candidate in assign.js (assignDisplayName), not filtered in SQL,
 *  since it lives in audit_log JSON rather than an indexable column. */
export async function listBackfillCandidates(db, { afterId = null, limit = 25 } = {}) {
  if (!(await displayNameColumnsExist(db))) return [];
  const params = [Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 25))];
  let cursorSql = '';
  if (afterId && isUuid(afterId)) { params.push(afterId); cursorSql = `AND id > $${params.length}`; }
  const { rows } = await db.raw(
    `SELECT id FROM documents
      WHERE ${TENANT_SQL} AND document_type IS NOT NULL AND display_name IS NULL ${cursorSql}
      ORDER BY id LIMIT $1`,
    params
  );
  return rows.map((r) => r.id);
}

export async function namingCounts(db) {
  if (!(await displayNameColumnsExist(db))) return { enabled: false, total: 0, named: 0, eligible: 0, remaining: 0 };
  const { rows: totalRows } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL}`, []);
  const { rows: namedRows } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL} AND display_name IS NOT NULL`, []);
  const { rows: eligibleRows } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL} AND document_type IS NOT NULL`, []);
  const { rows: remainingRows } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL} AND document_type IS NOT NULL AND display_name IS NULL`, []);
  return {
    enabled: true,
    total: totalRows[0]?.n ?? 0,
    named: namedRows[0]?.n ?? 0,
    eligible: eligibleRows[0]?.n ?? 0,
    remaining: remainingRows[0]?.n ?? 0,
  };
}
