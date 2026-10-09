/**
 * RECORDS-FIRST data access: the stored rows a look-up needs, read inside the asking organization only (every statement carries the tenant predicate,
 * and the request runs inside withTenant, which sets app.tenant_id). Corrections made in Review are applied (COALESCE(corrected, original)).
 * No model, no network. Light on purpose: it imports only financeViews.js (pure SQL text) so it does not slow a cold start.
 */
import { financeViewsSql, docCustomerCte } from "../agent/financeViews.js";
import { financialsTableExists } from "../financials/store.js";

const T = (a) => `${a}.tenant_id = (current_setting('app.tenant_id', true))::uuid`;
export const CUSTOMERS_CTE = `customers AS (SELECT e.id AS customer_id, e.customer_number, e.data->>'customer_name' AS name, e.data->>'service_address' AS address, e.data->>'phone' AS phone, e.data->>'email' AS email FROM entities e WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND ${T("e")})`;

async function rows(db, sql, params = []) { return (await db.raw(sql, params)).rows; }

export async function hasFinancials(db) { try { return await financialsTableExists(db); } catch { return false; } }

export async function loadCustomers(db) {
  return (await rows(db, `SELECT e.id, e.customer_number, e.data->>'customer_name' AS name, e.data->>'service_address' AS address, e.data->>'phone' AS phone, e.data->>'email' AS email
    FROM entities e WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND ${T("e")}`)).filter((r) => r.name);
}

/** documents of ONE customer, by the same attribution every other money lane uses (a document belongs to the one customer its links / extractions point at) */
export async function docsForCustomer(db, customerId) {
  return rows(db, `WITH ${CUSTOMERS_CTE}, ${docCustomerCte("doc_customer")}
    SELECT d.id AS document_id, d.document_type, d.original_filename AS filename, d.created_at::text AS created_at, dc.customer_id, dc.customer_name
      FROM documents d JOIN doc_customer dc ON dc.document_id = d.id
     WHERE dc.customer_id = $1 AND ${T("d")}
     ORDER BY d.created_at DESC, d.id`, [customerId]);
}

/** documents whose number is one of `codes` (alnum form). A bare-digit code matches a stored number whose digits equal it. */
export async function docsByNumber(db, codes) {
  if (!codes.length) return [];
  const alnumCodes = codes.map((c) => c.alnum);
  const digitCodes = codes.filter((c) => !c.prefixed && c.digits).map((c) => c.digits);
  const useFin = await hasFinancials(db);
  const finPart = useFin ? `UNION SELECT f.document_id FROM document_financials f WHERE ${T("f")} AND (regexp_replace(upper(coalesce(f.invoice_number,'')), '[^A-Z0-9]', '', 'g') = ANY($1::text[]) OR regexp_replace(upper(coalesce(f.po_number,'')), '[^A-Z0-9]', '', 'g') = ANY($1::text[])
       OR (cardinality($2::text[]) > 0 AND (regexp_replace(coalesce(f.invoice_number,''), '\\D', '', 'g') = ANY($2::text[]) OR regexp_replace(coalesce(f.po_number,''), '\\D', '', 'g') = ANY($2::text[]))))` : "";
  return rows(db, `WITH ${CUSTOMERS_CTE}, ${docCustomerCte("doc_customer")}
    SELECT d.id AS document_id, d.document_type, d.original_filename AS filename, d.created_at::text AS created_at, dc.customer_id, dc.customer_name
      FROM documents d LEFT JOIN doc_customer dc ON dc.document_id = d.id
     WHERE ${T("d")} AND d.id IN (
       SELECT x.document_id FROM extractions x WHERE ${T("x")} AND x.field_key IN ('invoice_number','po_number','permit_number')
          AND (regexp_replace(upper(coalesce(NULLIF(x.corrected_value,''), x.value, '')), '[^A-Z0-9]', '', 'g') = ANY($1::text[])
               OR (cardinality($2::text[]) > 0 AND regexp_replace(coalesce(NULLIF(x.corrected_value,''), x.value, ''), '\\D', '', 'g') = ANY($2::text[])))
       ${finPart})
     ORDER BY d.created_at DESC, d.id`, [alnumCodes, digitCodes]);
}

export async function unitsForCustomer(db, customerId) {
  return rows(db, `SELECT e.id, e.customer_id, e.data FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.customer_id = $1 AND ${T("e")} ORDER BY e.created_at, e.id`, [customerId]);
}
export async function unitsBySerial(db, serials) {
  if (!serials.length) return [];
  return rows(db, `SELECT e.id, e.customer_id, e.data FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND ${T("e")}
     AND regexp_replace(upper(coalesce(e.data->>'serial_number','')), '[^A-Z0-9]', '', 'g') = ANY($1::text[])`, [serials]);
}
/** documents linked to (or extracted for) a unit */
export async function docsForUnit(db, unitId) {
  return rows(db, `WITH ${CUSTOMERS_CTE}, ${docCustomerCte("doc_customer")}
    SELECT d.id AS document_id, d.document_type, d.original_filename AS filename, d.created_at::text AS created_at, dc.customer_id, dc.customer_name
      FROM documents d LEFT JOIN doc_customer dc ON dc.document_id = d.id
     WHERE ${T("d")} AND d.id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id = $1 AND ${T("l")} UNION SELECT x.document_id FROM extractions x WHERE x.entity_id = $1 AND ${T("x")})
     ORDER BY d.created_at DESC, d.id`, [unitId]);
}
/** customers whose service address (customer record or any of their units) contains the street number AND the street word */
export async function customersByAddress(db, { number, street }) {
  const like = `%${number} %${String(street).replace(/[%_\\]/g, " ")}%`;
  return rows(db, `SELECT DISTINCT e.id, e.data->>'customer_name' AS name FROM entities e
     WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND ${T("e")} AND e.data->>'service_address' ILIKE $1
     UNION
     SELECT DISTINCT c.id, c.data->>'customer_name' FROM entities u JOIN entities c ON c.id = u.customer_id AND c.merged_into IS NULL AND ${T("c")}
     WHERE u.entity_type = 'equipment' AND u.merged_into IS NULL AND ${T("u")} AND u.data->>'service_address' ILIKE $1`, [like]);
}

/** everything stored about a set of documents: extraction facts, the money header, the line items and the page text */
export async function loadBundle(db, docIds) {
  const out = { facts: [], fin: new Map(), lines: [], pages: [] };
  if (!docIds.length) return out;
  out.facts = await rows(db, `SELECT x.document_id, x.entity_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value, x.created_at::text AS created_at, fa.page_no
      FROM extractions x LEFT JOIN facets fa ON fa.id = x.source_facet_id AND ${T("fa")}
     WHERE x.document_id = ANY($1::uuid[]) AND ${T("x")} ORDER BY x.created_at, x.id`, [docIds]);
  if (await hasFinancials(db)) {
    const fr = await rows(db, `WITH ${CUSTOMERS_CTE}, ${financeViewsSql({ hasFinancials: true })}
      SELECT f.document_id, f.doc_kind, f.direction, f.invoice_number, f.po_number, f.invoice_date::text AS invoice_date, f.due_date::text AS due_date, f.doc_date::text AS doc_date, f.agreement_term,
             f.subtotal::text AS subtotal, f.tax::text AS tax, f.total::text AS total, f.amount_paid::text AS amount_paid, f.balance_due::text AS balance_due, f.status, f.customer_name, f.vendor_name, f.total_page
        FROM financials f WHERE f.document_id = ANY($1::uuid[])`, [docIds]);
    for (const r of fr) out.fin.set(r.document_id, r);
    out.lines = await rows(db, `WITH ${CUSTOMERS_CTE}, ${financeViewsSql({ hasFinancials: true })}
      SELECT l.document_id, l.line_no, l.description, l.qty::text AS qty, l.unit_price::text AS unit_price, l.amount::text AS amount, l.category_guess, l.page_no FROM invoice_lines l WHERE l.document_id = ANY($1::uuid[]) ORDER BY l.document_id, l.line_no`, [docIds]);
  }
  out.pages = await rows(db, `SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE p.document_id = ANY($1::uuid[]) AND ${T("p")} ORDER BY p.document_id, p.page_no`, [docIds]);
  return out;
}

/** RECORDS-R3C: words of THIS organization that restrict a question instead of naming a fact: equipment makes / types and technician names. The menu pick may never call one of them "the word that means the fact". */
export async function loadPickVocab(db) {
  const out = new Set();
  try {
    const r = await rows(db, `SELECT lower(v) AS v FROM (
        SELECT e.data->>'manufacturer' AS v FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND ${T("e")}
        UNION SELECT e.data->>'equipment_type' FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND ${T("e")}
        UNION SELECT COALESCE(NULLIF(x.corrected_value, ''), x.value) FROM extractions x WHERE x.field_key IN ('technician', 'manufacturer', 'equipment_type', 'vendor_name') AND ${T("x")}) t WHERE v IS NOT NULL`);
    for (const row of r) for (const w of String(row.v).split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w);
  } catch { /* unreadable: the other checks still apply */ }
  return out;
}
