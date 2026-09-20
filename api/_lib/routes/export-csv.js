/**
 * GET /api/v1/export?kind=documents|customers|equipment
 * (handoffs/DATA_INTEGRITY_2026-09-20.md section E). Dispatched from
 * api/v1.js's `?resource=export`.
 *
 * Auth: a Clerk session with the admin role (or a solo tenant, its own
 * admin), OR an API key with the 'read' scope — same
 * hasShop/requireRole('admin') pattern as document-delete.js, layered on top
 * of requireAuthOrKey/assertScope('read') the same way every other v1 read
 * route uses them. A bulk export of every customer/document/equipment row is
 * more sensitive than any single lookup this API otherwise offers, hence the
 * extra admin gate for a session (a key was already deliberately minted for
 * this).
 *
 * text/csv, RFC4180-ish quoting (integrity.js's csvRow), capped at
 * MAX_ROWS — a hard ceiling, not a page size; a tenant past it exports its
 * most recent MAX_ROWS.
 */
import { handleCors, handleError } from "../claude.js";
import { denyAuth, hasShop, requireRole } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { alertTier } from "../warrantyRules.js";
import { csvRow } from "../integrity.js";

const MAX_ROWS = 10_000;
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const KINDS = new Set(["documents", "customers", "equipment"]);

async function requireExportAuth(req) {
  const auth = await requireAuthOrKey(req);
  assertScope(auth, "read");
  if (!auth.viaKey && hasShop(auth)) requireRole(auth, "admin");
  return auth;
}

async function loadDocumentsCsv(db) {
  const rows = await db.raw(
    `WITH cust AS (
       SELECT l.document_id, c.customer_number, c.data->>'customer_name' AS customer_name
         FROM document_entity_links l JOIN entities c ON c.id = l.entity_id
        WHERE c.entity_type = 'customer' AND l.tenant_id = (current_setting('app.tenant_id', true))::uuid
        UNION
       SELECT l.document_id, cc.customer_number, cc.data->>'customer_name'
         FROM document_entity_links l
         JOIN entities eq ON eq.id = l.entity_id AND eq.entity_type = 'equipment' AND eq.customer_id IS NOT NULL
         JOIN entities cc ON cc.id = eq.customer_id
        WHERE l.tenant_id = (current_setting('app.tenant_id', true))::uuid
        UNION
       SELECT x.document_id, cc.customer_number, cc.data->>'customer_name'
         FROM extractions x
         JOIN entities eq ON eq.id = x.entity_id AND eq.entity_type = 'equipment' AND eq.customer_id IS NOT NULL
         JOIN entities cc ON cc.id = eq.customer_id
        WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid
     ),
     cust_one AS (
       SELECT DISTINCT ON (document_id) document_id, customer_number, customer_name
         FROM cust ORDER BY document_id, customer_number NULLS LAST
     ),
     serials AS (
       SELECT document_id, string_agg(DISTINCT value, '; ') AS serials
         FROM extractions WHERE field_key = 'serial_number' AND ${TENANT}
         GROUP BY document_id
     ),
     svc AS (
       SELECT DISTINCT ON (document_id) document_id, value AS service_date
         FROM extractions WHERE field_key = 'service_date' AND ${TENANT}
         ORDER BY document_id, confidence DESC NULLS LAST, id
     ),
     addr AS (
       SELECT DISTINCT ON (document_id) document_id, value AS service_address
         FROM extractions WHERE field_key = 'service_address' AND ${TENANT}
         ORDER BY document_id, confidence DESC NULLS LAST, id
     )
     SELECT d.id, d.original_filename, d.document_type, d.stage,
            co.customer_number, co.customer_name, addr.service_address, svc.service_date,
            serials.serials, d.verified_by, d.created_at
       FROM documents d
       LEFT JOIN cust_one co ON co.document_id = d.id
       LEFT JOIN serials ON serials.document_id = d.id
       LEFT JOIN svc ON svc.document_id = d.id
       LEFT JOIN addr ON addr.document_id = d.id
      WHERE d.${TENANT}
      ORDER BY d.created_at DESC
      LIMIT ${MAX_ROWS}`,
    []
  );

  let out = csvRow(['id', 'filename', 'type', 'stage', 'customer_number', 'customer_name', 'service_address', 'service_date', 'serials', 'verified_by', 'created_at']);
  for (const r of rows.rows) {
    out += csvRow([
      r.id, r.original_filename, r.document_type, r.stage, r.customer_number, r.customer_name,
      r.service_address, r.service_date, r.serials, r.verified_by,
      r.created_at ? new Date(r.created_at).toISOString() : '',
    ]);
  }
  return out;
}

async function loadCustomersCsv(db) {
  const rows = await db.listCustomersSummary({ limit: MAX_ROWS });
  let out = csvRow(['customer_number', 'name', 'service_address', 'phone', 'email', 'document_count', 'equipment_count', 'last_activity']);
  for (const r of rows) {
    out += csvRow([
      r.customer_number, r.data?.customer_name, r.data?.service_address, r.data?.phone, r.data?.email,
      r.doc_count, r.equipment_count, r.last_activity ? new Date(r.last_activity).toISOString() : '',
    ]);
  }
  return out;
}

async function loadEquipmentCsv(db) {
  const rows = await db.raw(
    `SELECT e.data->>'serial_number' AS serial, e.data->>'model' AS model, e.data->>'manufacturer' AS manufacturer,
            e.data->>'installation_date' AS installation_date, e.data->'warranty' AS warranty,
            c.customer_number, c.data->>'customer_name' AS customer_name, e.data->>'service_address' AS service_address
       FROM entities e
       LEFT JOIN entities c ON c.id = e.customer_id
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT}
      ORDER BY e.updated_at DESC
      LIMIT ${MAX_ROWS}`,
    []
  );
  const today = new Date().toISOString().slice(0, 10);
  let out = csvRow(['serial', 'model', 'manufacturer', 'install_date', 'warranty_expires', 'warranty_tier', 'customer_number', 'customer_name', 'service_address']);
  for (const r of rows.rows) {
    const warranty = r.warranty ?? null;
    out += csvRow([
      r.serial, r.model, r.manufacturer, r.installation_date,
      warranty?.expires ?? '', warranty ? alertTier(warranty, today) : '',
      r.customer_number, r.customer_name, r.service_address,
    ]);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireExportAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "read"))) return;

  const kind = String(req.query?.kind ?? "");
  if (!KINDS.has(kind)) {
    return handleCors(res, req).status(400).json({ error: "?kind must be one of documents, customers, equipment" });
  }

  try {
    const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
    const csv = await withTenant(ctx, (db) => {
      if (kind === "documents") return loadDocumentsCsv(db);
      if (kind === "customers") return loadCustomersCsv(db);
      return loadEquipmentCsv(db);
    });

    handleCors(res, req);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="deepwell-${kind}.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    return handleError(res, error, req);
  }
}
