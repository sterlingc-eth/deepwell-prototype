/**
 * Summary lane - DB readers. Every number the lane states comes from one of these reads (documents, extractions, document_financials,
 * entities), through the same tenant scope every other reader uses. No model call.
 */
import { TENANT_SQL, isoDate, docTypeAliases, typeSql } from "../scope.js";
import { customerDocumentIds } from "../docLookup.js";
import { documentsHaveAudience } from "../audience/probe.js";
import { audienceFilterSql } from "../audience/sql.js";
import { hrGateSql } from "../companyFilesStore.js";

const FIELDS = ["invoice_date", "service_date", "warranty_registered_date", "technician", "status", "invoice_number"];
const MAX_DOCS = 20000;

/** Latest value per (document, field), corrections applied. */
async function extractionMap(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await db.raw(
    `SELECT DISTINCT ON (x.document_id, x.field_key) x.document_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS v
       FROM extractions x
      WHERE x.document_id = ANY($1::uuid[]) AND x.field_key = ANY($2::text[]) AND x.${TENANT_SQL}
      ORDER BY x.document_id, x.field_key, x.created_at DESC`,
    [ids, FIELDS]
  );
  for (const r of rows) {
    const m = out.get(String(r.document_id)) ?? {};
    m[r.field_key] = r.v == null ? null : String(r.v).trim();
    out.set(String(r.document_id), m);
  }
  return out;
}

const eff = (col, cast) => `(CASE WHEN f.corrections ? '${col}' THEN NULLIF(f.corrections->>'${col}', '') ELSE f.${col}::text END)::${cast}`;

async function financialMap(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  let rows = [];
  try {
    ({ rows } = await db.raw(
      `SELECT f.document_id, ${eff("total", "numeric")} AS total, ${eff("invoice_date", "date")}::text AS invoice_date, f.currency, f.direction, f.doc_kind,
              ${eff("invoice_number", "text")} AS invoice_number
         FROM document_financials f
        WHERE f.document_id = ANY($1::uuid[]) AND f.${TENANT_SQL}
        ORDER BY f.created_at DESC`,
      [ids]
    ));
  } catch { return out; } // the money tables are optional on a tenant: no totals then, never a guess
  for (const r of rows) if (!out.has(String(r.document_id))) out.set(String(r.document_id), r);
  return out;
}

let _hdn = null;
async function hasDisplayName(db) {
  if (_hdn !== null) return _hdn;
  try { const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'display_name'`); _hdn = r.rowCount > 0; } catch { return false; }
  return _hdn;
}

/** The documents behind a summary, with type, date, total and the stored fields the lane reports. */
export async function loadDocuments(db, ids) {
  const list = [...new Set(ids.map(String))];
  if (!list.length) return [];
  if (list.length > MAX_DOCS) return null;
  // internal (team-only) and People-and-HR papers never feed an answer about customers or the business, the same rule every other document reader follows
  const audience = audienceFilterSql({ docAlias: "d", hasAudienceColumn: await documentsHaveAudience(db) });
  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, ${await hasDisplayName(db) ? "d.display_name" : "NULL::text"} AS display_name, d.created_at FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT_SQL} AND (${audience}) AND ${hrGateSql("d")}`,
    [list]
  );
  const ids2 = rows.map((r) => String(r.id));
  const [ex, fin] = await Promise.all([extractionMap(db, ids2), financialMap(db, ids2)]);
  return rows.map((r) => {
    const id = String(r.id);
    const e = ex.get(id) ?? {};
    const f = fin.get(id) ?? null;
    const created = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? "");
    const date = isoDate(f?.invoice_date) ?? isoDate(e.invoice_date) ?? isoDate(e.service_date) ?? isoDate(e.warranty_registered_date) ?? isoDate(created);
    const total = f && f.total != null && Number.isFinite(Number(f.total)) && String(f.currency ?? "USD").toUpperCase() === "USD" ? Number(f.total) : null;
    return {
      id,
      type: String(r.document_type ?? "other").trim().toLowerCase().replace(/_/g, "-"),
      filename: r.original_filename ?? null,
      displayName: r.display_name ?? null,
      date,
      total,
      number: (f?.invoice_number ?? e.invoice_number) || null,
      status: e.status || null,
      tech: e.technician || null,
    };
  });
}

export async function documentIdsOfType(db, typeId) {
  const { rows } = await db.raw(`SELECT d.id FROM documents d WHERE d.${TENANT_SQL} AND ${typeSql("d.document_type")} = ANY($1::text[]) LIMIT ${MAX_DOCS + 1}`, [docTypeAliases(typeId)]);
  return rows.map((r) => String(r.id));
}

export async function allDocumentIds(db) {
  const { rows } = await db.raw(`SELECT d.id FROM documents d WHERE d.${TENANT_SQL} LIMIT ${MAX_DOCS + 1}`, []);
  return rows.map((r) => String(r.id));
}

export async function customerDocIds(db, row) {
  return (await customerDocumentIds(db, row)).map(String);
}

/** Technician names on record (corrections applied), exact set. */
export async function technicianNames(db) {
  const { rows } = await db.raw(
    `SELECT DISTINCT COALESCE(NULLIF(x.corrected_value, ''), x.value) AS v FROM extractions x WHERE x.field_key = 'technician' AND x.${TENANT_SQL} AND COALESCE(x.value, '') <> '' LIMIT 500`,
    []
  );
  return rows.map((r) => String(r.v).trim()).filter(Boolean);
}

export async function technicianDocIds(db, name) {
  const { rows } = await db.raw(
    `SELECT DISTINCT x.document_id FROM extractions x WHERE x.field_key = 'technician' AND x.${TENANT_SQL}
        AND lower(regexp_replace(trim(COALESCE(NULLIF(x.corrected_value, ''), x.value)), '\\s+', ' ', 'g')) = lower($1)`,
    [name.replace(/\s+/g, " ").trim()]
  );
  return rows.map((r) => String(r.document_id));
}

export async function equipmentRows(db, { customerId = null } = {}) {
  const { rows } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type, e.data->>'model' AS model,
            e.data->>'tonnage' AS tonnage, e.data->>'installation_date' AS installed, e.data->>'serial_number' AS serial_number
       FROM entities e
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
        AND ($1::uuid IS NULL OR e.customer_id = $1::uuid)
      LIMIT 20000`,
    [customerId]
  );
  return rows;
}

export async function customerBase(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address, data->>'phone' AS phone, data->>'email' AS email
       FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND COALESCE(data->>'customer_name', '') <> '' LIMIT 20000`,
    []
  );
  return rows;
}

/** Of these document ids, the ones a summary may use (not internal, not People and HR). */
export async function visibleDocumentIds(db, ids) {
  const list = [...new Set((ids ?? []).map(String))];
  if (!list.length) return new Set();
  const audience = audienceFilterSql({ docAlias: "d", hasAudienceColumn: await documentsHaveAudience(db) });
  const { rows } = await db.raw(`SELECT d.id FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT_SQL} AND (${audience}) AND ${hrGateSql("d")}`, [list]);
  return new Set(rows.map((r) => String(r.id)));
}
