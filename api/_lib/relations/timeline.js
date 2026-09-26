/**
 * relations/timeline.js — Workstream B ("connect the dots"): builds per-customer / per-unit /
 * per-technician service-visit timelines AT QUERY TIME, straight off documents/extractions/
 * document_entity_links. No new table is required at this corpus size (a few thousand documents):
 * the whole-tenant visit list is one bounded, indexed read (see fetchAllVisits) and every family in
 * questions.js scans it in JS. If a future tenant's corpus grows past ~100k documents this fetch
 * should move behind M3-config/36-relations.sql (a materialized `relations_visits` table refreshed
 * on ingest) — questions.js's own callers never need to change, only fetchAllVisits's body would.
 *
 * A VISIT is a document of one of VISIT_DOC_TYPES with a parseable service_date. This is the EXACT
 * closed list the scorecard oracle SQL uses for every "connect" family (repeat visit after install,
 * callback within N days, two-technician overlap within N days) — matching it byte for byte matters
 * more here than reusing scope.js's broader isVisitType (a looser "not a contract/quote/registration"
 * definition that would silently disagree with the oracle on any extra document type this corpus
 * happens to carry).
 *
 * Every fetch here is tenant-scoped via TENANT_SQL (scope.js), same idiom as maintenanceDue.js /
 * compose.js / rankings.js. No question text or row values are ever logged.
 */
import { TENANT_SQL, isoDate } from '../scope.js';

/** The 7 document types the scorecard oracle treats as a "visit" — see this file's own header. */
export const VISIT_DOC_TYPES = [
  'service-ticket', 'service-report', 'work-order', 'dispatch-note',
  'inspection-report', 'startup-sheet', 'invoice',
];

/** Adds whole days to a YYYY-MM-DD date, returns YYYY-MM-DD (UTC, no DST surprises). */
export function addDaysIso(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Every service visit on file, tenant-scoped, dated on or before `today` — one row per
 * (customer, document): {custId, docId, date, tech}. `tech` is any technician value extracted from
 * the same document (first one found, same as the oracle's own `LIMIT 1` sub-select).
 * A document reaches a customer either directly (document_entity_links -> customer) or via one of
 * the customer's own equipment (document_entity_links -> equipment -> customer_id) — same two paths
 * the oracle's own `v` CTE joins.
 */
export async function fetchAllVisits(db, today) {
  const { rows } = await db.raw(
    `SELECT c.id AS cust_id, d.id AS doc_id,
            COALESCE(NULLIF(y.corrected_value, ''), y.value) AS service_date,
            (SELECT COALESCE(NULLIF(t.corrected_value, ''), t.value) FROM extractions t
              WHERE t.document_id = d.id AND t.field_key = 'technician' AND t.${TENANT_SQL} LIMIT 1) AS tech
       FROM document_entity_links l
       JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
       LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
       JOIN entities c ON (c.id = l.entity_id OR c.id = le.customer_id) AND c.entity_type = 'customer'
                       AND c.merged_into IS NULL AND c.${TENANT_SQL}
       JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
      WHERE lower(replace(d.document_type, '_', '-')) = ANY($1::text[]) AND l.${TENANT_SQL}
      LIMIT 40000`,
    [VISIT_DOC_TYPES]
  );
  const t = isoDate(today) ?? new Date().toISOString().slice(0, 10);
  const out = [];
  for (const r of rows) {
    const date = isoDate(r.service_date);
    if (!date || date > t) continue; // never a future/typo'd date — same rule as the oracle's own `<= $today`
    out.push({ custId: r.cust_id, docId: r.doc_id, date, tech: r.tech ? String(r.tech).trim() : null });
  }
  return out;
}

/** Every piece of equipment with an installation date, tenant-scoped: {id, customerId, manufacturer, installDate}. */
export async function fetchEquipmentInstalls(db) {
  const { rows } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'installation_date' AS installation_date
       FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND customer_id IS NOT NULL AND ${TENANT_SQL}
      LIMIT 20000`
  );
  return rows.map((r) => ({ id: r.id, customerId: r.customer_id, manufacturer: r.manufacturer ?? null, installDate: isoDate(r.installation_date) }));
}

/** Every customer, tenant-scoped: {id, name, address}. */
export async function fetchCustomers(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 20000`
  );
  return rows;
}

/** Customers whose name matches `%pattern%` (ILIKE), tenant-scoped. Empty array = the named customer isn't on file. */
export async function customersByNameLike(db, namePattern) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'customer_name' ILIKE $1`,
    [`%${escapeLikeText(namePattern)}%`]
  );
  return rows;
}

/**
 * Every dated technician job on file, tenant-scoped, optionally narrowed to technician names matching
 * `%namePattern%` (ILIKE): {docId, tech, date}. A "job" is a technician extraction on a document that
 * also carries a service_date — same definition the scorecard oracle's tech-performance queries use.
 */
export async function fetchTechnicianJobs(db, namePattern = null) {
  const { rows } = await db.raw(
    `SELECT t.document_id AS doc_id, COALESCE(NULLIF(t.corrected_value, ''), t.value) AS tech,
            (SELECT COALESCE(NULLIF(y.corrected_value, ''), y.value) FROM extractions y
              WHERE y.document_id = t.document_id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
              ORDER BY y.created_at DESC LIMIT 1) AS service_date
       FROM extractions t
      WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL}
        ${namePattern ? 'AND t.value ILIKE $1' : ''}
      LIMIT 20000`,
    namePattern ? [`%${escapeLikeText(namePattern)}%`] : []
  );
  return rows
    .map((r) => ({ docId: r.doc_id, tech: r.tech ? String(r.tech).trim() : null, date: isoDate(r.service_date) }))
    .filter((r) => r.date && r.tech);
}

/** True when at least one technician extraction anywhere in this tenant matches `%namePattern%` (ILIKE). */
export async function technicianNameExists(db, namePattern) {
  const { rows } = await db.raw(
    `SELECT count(*)::int AS n FROM extractions t
      WHERE t.field_key = 'technician' AND t.${TENANT_SQL} AND t.value ILIKE $1`,
    [`%${escapeLikeText(namePattern)}%`]
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** documents whose type matches one of `typeIds`' canonical aliases, tenant-scoped: {id}. */
export async function documentsOfType(db, typeAliases) {
  const { rows } = await db.raw(
    `SELECT id FROM documents WHERE lower(replace(document_type, '_', '-')) = ANY($1::text[]) AND ${TENANT_SQL} LIMIT 20000`,
    [typeAliases]
  );
  return rows.map((r) => r.id);
}

/** How many technicians are on record (distinct, case/space-insensitive) — matches the scorecard oracle's
 *  own `count(DISTINCT lower(btrim(value)))` exactly (no service_date required, unlike a "job"). */
export async function technicianCountOnRecord(db) {
  const { rows } = await db.raw(
    `SELECT count(DISTINCT lower(btrim(COALESCE(NULLIF(t.corrected_value, ''), t.value))))::int AS n
       FROM extractions t WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL}`
  );
  return rows[0]?.n ?? 0;
}

/** Every technician (grouped by the RAW extracted value, not lower-cased — matches the oracle's own
 *  `GROUP BY t.value` for the "list technicians" question) with a dated job behind it: {tech, n, docIds}. */
export async function technicianJobCounts(db) {
  const { rows } = await db.raw(
    `SELECT COALESCE(NULLIF(t.corrected_value, ''), t.value) AS tech, count(DISTINCT t.document_id)::int AS n,
            array_agg(DISTINCT t.document_id) AS doc_ids
       FROM extractions t JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
      WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL}
      GROUP BY tech ORDER BY tech LIMIT 500`
  );
  return rows.map((r) => ({ tech: r.tech, n: r.n, docIds: r.doc_ids ?? [] }));
}

/** documentIds of every dated service job with NO technician recorded on it. */
export async function jobsWithNoTechnician(db) {
  const { rows } = await db.raw(
    `SELECT DISTINCT y.document_id AS id FROM extractions y
      WHERE y.field_key = 'service_date' AND y.${TENANT_SQL}
        AND NOT EXISTS (SELECT 1 FROM extractions t WHERE t.document_id = y.document_id AND t.field_key = 'technician'
                          AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL})
      LIMIT 5000`
  );
  return rows.map((r) => r.id);
}

/** customer_id reachable from each of `documentIds` (direct link or via the customer's own equipment). */
export async function customerIdsForDocuments(db, documentIds) {
  const ids = [...new Set(documentIds ?? [])];
  if (!ids.length) return new Map();
  const { rows } = await db.raw(
    `SELECT l.document_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
       FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
      WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) if (r.customer_id) { const s = map.get(r.document_id) ?? new Set(); s.add(r.customer_id); map.set(r.document_id, s); }
  return map;
}

/** Escape LIKE/ILIKE wildcards in user-derived text (backslash is Postgres's default ESCAPE). */
function escapeLikeText(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/* ==================================================================== R14 (K4): financials/quotes */

/** "quoted a replacement" — a customer has a proposal/quote-type document whose page text names a
 *  replacement job, never a repair. Same closed phrase list for every family in this module that needs
 *  it (a text SHAPE, not any one document's or customer's own wording). */
const REPLACEMENT_QUOTE_TEXT_RE =
  "(replac\\w*\\s+(the\\s+)?(unit|system|equipment|condenser|furnace|ac)|new (unit|system)|full replacement|system replacement)";
const QUOTE_TYPE_ALIASES = ['proposal-quote', 'proposal', 'quote'];

/** Every customer with at least one proposal/quote document whose page text matches
 *  REPLACEMENT_QUOTE_TEXT_RE, tenant-scoped: {custId, docId, quotedAt (documents.created_at date)}[]. One
 *  row per (customer, matching document) — a customer with two such quotes appears twice, which is fine
 *  since every caller here only checks "at least one" or takes the earliest. */
export async function fetchReplacementQuotes(db) {
  const { rows } = await db.raw(
    `SELECT DISTINCT c.id AS cust_id, d.id AS doc_id, d.created_at::date AS quoted_at
       FROM document_entity_links l
       JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
       JOIN document_pages p ON p.document_id = d.id AND p.${TENANT_SQL}
       LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
       JOIN entities c ON (c.id = l.entity_id OR c.id = le.customer_id) AND c.entity_type = 'customer'
                       AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE lower(replace(d.document_type, '_', '-')) = ANY($1::text[]) AND l.${TENANT_SQL}
        AND p.text ~* $2
      LIMIT 20000`,
    [QUOTE_TYPE_ALIASES, REPLACEMENT_QUOTE_TEXT_RE]
  );
  return rows.map((r) => ({ custId: r.cust_id, docId: r.doc_id, quotedAt: isoDate(r.quoted_at) }));
}

/**
 * Every document_financials row reachable from a customer (directly or via the customer's own
 * equipment — the same two-path join every family in this file uses), tenant-scoped:
 * {custId, docId, finId, kind, direction, status, total, invoiceDate}[]. One row per (customer,
 * financial document); a document linked to more than one customer (rare) appears once per customer,
 * matching the oracle's own document_entity_links join.
 */
export async function fetchCustomerFinancials(db) {
  const { rows } = await db.raw(
    `SELECT DISTINCT c.id AS cust_id, f.document_id AS doc_id, f.id AS fin_id, f.doc_kind AS kind,
            f.direction, f.status, f.total, f.invoice_date
       FROM document_financials f
       JOIN document_entity_links l ON l.document_id = f.document_id AND l.${TENANT_SQL}
       LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
       JOIN entities c ON (c.id = l.entity_id OR c.id = le.customer_id) AND c.entity_type = 'customer'
                       AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE f.${TENANT_SQL}
      LIMIT 40000`
  );
  return rows.map((r) => ({
    custId: r.cust_id, docId: r.doc_id, finId: r.fin_id, kind: r.kind, direction: r.direction,
    status: r.status, total: r.total == null ? null : Number(r.total), invoiceDate: isoDate(r.invoice_date),
  }));
}
