/** Storage with NO migration: one facets row per document (segment_id 'doc-record-v1', value_raw = JSON). Optional dedicated table: see sql/document_records.sql (owner-run). */
import { RECORD_SEGMENT, RECORD_VERSION } from "./core.js";

const TENANT = "tenant_id = current_setting('app.tenant_id', true)::uuid";

export async function saveRecord(db, { documentId, record, status }) {
  await db.raw(`DELETE FROM facets WHERE document_id = $1::uuid AND segment_id = $2 AND ${TENANT}`, [documentId, RECORD_SEGMENT]);
  const stored = JSON.stringify({ ...record, status, stored_at: new Date().toISOString() });
  await db.createFacet({ document_id: documentId, page_no: null, segment_id: RECORD_SEGMENT, label_raw: "document record", value_raw: stored, value_type_guess: "json", confidence: null });
}
/** only documents a customer-facing answer may read (audience 'customer'); any query problem = no records (stricter-only) */
export async function loadRecords(db, { limit = 3000 } = {}) {
  try {
    const { rows } = await db.raw(
      `SELECT f.document_id, f.value_raw, d.original_filename, d.display_name
         FROM facets f JOIN documents d ON d.id = f.document_id
        WHERE f.segment_id = $1 AND f.${TENANT} AND d.audience = 'customer'
        ORDER BY f.created_at DESC LIMIT $2`, [RECORD_SEGMENT, limit]);
    const out = [];
    for (const r of rows) {
      try { const rec = JSON.parse(r.value_raw); if (rec?.v === RECORD_VERSION && rec.status === "verified") out.push({ documentId: r.document_id, name: r.display_name || r.original_filename, record: rec }); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}
