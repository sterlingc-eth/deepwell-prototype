/**
 * Donovan agent — tool definitions and executors (handoffs: Donovan agent fallback).
 *
 * Every executor runs inside ONE short `withTenant(ctxArg, async (db) => ...)`
 * transaction of its own (never one transaction held open across model
 * latency — the pool is tiny, see recordsStore.js's getPool), so app.tenant_id
 * is SET LOCAL and row-level security applies exactly as it does to every other
 * read in this codebase. Tools never write.
 *
 * The model sees ONE catalogue of read-only virtual views (VIEW_DOCS below),
 * implemented as a fixed WITH clause prepended to its SQL — see sqlGuard.js
 * for the layered defence around run_query.
 *
 * Nothing here logs question text or row values.
 */
import { guardSql, wrapSql, referencedNames, VIEW_NAMES } from "./sqlGuard.js";
import { resolveContactCandidates, resolveAddressCandidates } from "../contactLookup.js";
import { customerDocumentIds } from "../docLookup.js";
import { deriveGeo, warrantyStatusOf, normalizeStateValue } from "../analytics.js";
import { alertTier } from "../warrantyRules.js";
import { extractionsHaveUnitIndex } from "../recordsStore.js";

const TENANT = "(current_setting('app.tenant_id', true))::uuid";
const t = (alias) => `${alias}.tenant_id = ${TENANT}`;

export const RESULT_CHAR_CAP = 6000;
/** run_query results may be larger: a "who all" list of 40 customers must reach the model whole
 *  (a list silently cut at ~5 rows and phrased as complete was a live defect). */
export const QUERY_RESULT_CHAR_CAP = 10000;
export const MAX_QUERY_ROWS = 100;
const QUERY_TIMEOUT_MS = () => Math.max(200, Number(process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS) || 3000);
const DERIVED_ROW_CAP = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* ------------------------------------------------------------------ views */

/**
 * The CTE list (no leading WITH). `$1` is a jsonb document {c:[...], e:[...]} of JS-derived
 * columns (customer / equipment geography from analytics.js's deriveGeo, equipment warranty
 * status from warrantyRules.js's alertTier via analytics.js's warrantyStatusOf) — the SAME
 * deterministic logic the analytics executor uses, computed in JS and joined in, so there is
 * no second copy of warranty semantics in SQL.
 */
export function buildViewsSql({ hasUnitIndex = true } = {}) {
  const unit = hasUnitIndex ? "x.unit_index" : "NULL::smallint AS unit_index";
  return `
customers AS (
  SELECT e.id AS customer_id, e.customer_number, e.data->>'customer_name' AS name,
         e.data->>'service_address' AS address, e.data->>'phone' AS phone, e.data->>'email' AS email,
         g.city, g.state, g.zip, g.county, e.created_at
    FROM entities e
    LEFT JOIN jsonb_to_recordset(COALESCE($1::jsonb->'c', '[]'::jsonb)) AS g(id uuid, city text, state text, zip text, county text) ON g.id = e.id
   WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND ${t("e")}
),
equipment AS (
  SELECT e.id AS equipment_id, e.customer_id, e.data->>'serial_number' AS serial_number, e.data->>'model' AS model,
         e.data->>'manufacturer' AS manufacturer, e.data->>'equipment_type' AS equipment_type,
         e.data->>'tonnage' AS tonnage, e.data->>'refrigerant' AS refrigerant,
         e.data->>'installation_date' AS installation_date, e.data->>'service_address' AS address,
         g.city, g.state, g.zip, g.warranty_status, g.warranty_tier, g.warranty_expires,
         COALESCE(g.warranty_status IN ('active', 'expiring'), false) AS warranty_current
    FROM entities e
    LEFT JOIN jsonb_to_recordset(COALESCE($1::jsonb->'e', '[]'::jsonb)) AS g(id uuid, city text, state text, zip text, warranty_status text, warranty_tier text, warranty_expires text) ON g.id = e.id
   WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND ${t("e")}
),
doc_links AS (
  SELECT l.document_id, l.entity_id, e.entity_type,
         CASE e.entity_type WHEN 'customer' THEN e.id WHEN 'equipment' THEN e.customer_id END AS customer_id,
         'link'::text AS via
    FROM document_entity_links l
    JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND ${t("e")}
   WHERE ${t("l")}
  UNION
  SELECT x.document_id, x.entity_id, e.entity_type,
         CASE e.entity_type WHEN 'customer' THEN e.id WHEN 'equipment' THEN e.customer_id END AS customer_id,
         'extraction'::text AS via
    FROM extractions x
    JOIN entities e ON e.id = x.entity_id AND e.merged_into IS NULL AND ${t("e")}
   WHERE x.entity_id IS NOT NULL AND ${t("x")}
),
documents_v AS (
  SELECT d.id, d.id AS document_id, d.original_filename AS filename, d.document_type, d.stage, d.created_at,
         (SELECT CASE WHEN s.v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(s.v, 10) END
            FROM (SELECT COALESCE(NULLIF(sx.corrected_value, ''), sx.value) AS v
                    FROM extractions sx
                   WHERE sx.document_id = d.id AND sx.field_key = 'service_date' AND ${t("sx")}
                   ORDER BY sx.created_at DESC LIMIT 1) s) AS service_date,
         (SELECT COALESCE(NULLIF(tx.corrected_value, ''), tx.value)
            FROM extractions tx
           WHERE tx.document_id = d.id AND tx.field_key = 'technician' AND ${t("tx")}
           ORDER BY tx.created_at DESC LIMIT 1) AS technician,
         dc.customer_id, dc.customer_name
    FROM documents d
    LEFT JOIN LATERAL (
      SELECT l.customer_id, c.name AS customer_name
        FROM doc_links l JOIN customers c ON c.customer_id = l.customer_id
       WHERE l.document_id = d.id
       ORDER BY l.via, l.customer_id LIMIT 1
    ) dc ON true
   WHERE ${t("d")}
),
facts AS (
  SELECT x.document_id, x.entity_id, x.field_key,
         COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value,
         ${unit}, f.page_no, x.confidence, x.created_at
    FROM extractions x
    LEFT JOIN facets f ON f.id = x.source_facet_id AND ${t("f")}
   WHERE ${t("x")}
)`.trim();
}

/** What the model is told about the views (goes in the cached system prompt). */
export const VIEW_DOCS = `VIEWS available to run_query (PostgreSQL; one SELECT; query these names only):
- customers(customer_id, customer_number, name, address, phone, email, city, state, zip, county, created_at) — one row per customer.
- equipment(equipment_id, customer_id, serial_number, model, manufacturer, equipment_type, tonnage, refrigerant, installation_date, address, city, state, zip, warranty_status, warranty_tier, warranty_expires, warranty_current) — one row per unit. warranty_status is the app's own deterministic status: 'active' | 'expiring' | 'expired' | 'unknown'; warranty_current = active or expiring. warranty_expires is a YYYY-MM-DD text. Never compute warranty status yourself.
- documents_v(id, document_id, filename, document_type, stage, created_at, service_date, technician, customer_id, customer_name) — one row per uploaded document. service_date is the job date as 'YYYY-MM-DD' text (NULL if none). document_type is one of: work-order, invoice, warranty-registration, startup-sheet, permit, nameplate-photo, maintenance-agreement, service-ticket, dispatch-note, proposal-quote, inspection-report, purchase-order, equipment-record, correspondence, internal, other. A service visit = a document with a service_date.
- facts(document_id, entity_id, field_key, value, unit_index, page_no, confidence, created_at) — extracted fields (corrected values already applied). field_key examples: customer_name, service_address, serial_number, model, manufacturer, permit_number, invoice_number, service_type, work_performed, part_number, technician, agreement_term, cost. Call describe_data to see which exist.
- doc_links(document_id, entity_id, entity_type, customer_id, via) — which customer each document belongs to (directly or through a unit).
SQL rules: SELECT/WITH only, no semicolons, no comments, no double-quoted identifiers, plain functions only. Dates are text: compare like service_date >= '2026-01-01' and use left(service_date, 7) for months. Always select the ids you will cite (customer_id, document_id). Count with count(*) or count(DISTINCT customer_id) instead of counting rows yourself. Max 100 rows come back; if a result says truncated, select fewer columns or narrow the query and run it again - never answer from a truncated list as if it were complete.
Common shapes (adapt, do not copy values):
- customers with a current warranty: SELECT c.customer_id, c.name, e.model, e.warranty_status, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE e.warranty_current ORDER BY c.name
- newest / oldest unit installed: SELECT e.equipment_id, e.manufacturer, e.model, e.serial_number, e.installation_date, e.address FROM equipment e WHERE e.installation_date IS NOT NULL ORDER BY e.installation_date DESC LIMIT 5 (installation_date is text: if the top rows are not YYYY-MM-DD, say the ordering may be unreliable).
- documents of a brand: a document belongs to a brand when it is linked to a unit of that brand or to a customer who owns one. SELECT count(DISTINCT dl.document_id) FROM doc_links dl WHERE dl.customer_id IN (SELECT customer_id FROM equipment WHERE lower(manufacturer) = 'trane'). State that definition in your answer text.`;

/* ----------------------------------------------------------- tool schemas */

export const ANSWER_TOOL_NAME = "answer";

export const ANSWER_TOOL_DEF = {
  name: ANSWER_TOOL_NAME,
  description:
    "Give the final answer. Call exactly once, after you have what you need. For a list question include EVERY row as a fact (up to 40) and state the true total in text; never a partial list phrased as complete. status 'answered' needs facts backed by tool results; 'none_found' = the data was searched and legitimately has nothing; 'cannot_answer' = these records cannot answer (say what is missing in `missing`).",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["answered", "none_found", "cannot_answer"] },
      text: { type: "string", description: "1-2 plain sentences a dispatcher would say. Only numbers/names that appear in tool results." },
      facts: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short label (customer name, field name)." },
            value: { type: "string", description: "Value copied from tool results (a count, a date, a status, a place)." },
            status: { type: "string", enum: ["ok", "warn", "bad", "info", "muted"] },
            entityId: { type: "string", description: "customer_id / equipment_id exactly as returned, when the fact is about one record." },
            sources: {
              type: "array",
              description: "Only when the fact comes from a document: [{documentId, location:{page}|{field}}]. page = a passage's page_no from search_documents; field = a facts.field_key; {field:'document'} for a whole document row. Omit for pure aggregates.",
              items: {
                type: "object",
                properties: {
                  documentId: { type: "string" },
                  location: { type: "object", properties: { page: { type: "number" }, field: { type: "string" } } },
                },
                required: ["documentId"],
              },
            },
          },
          required: ["label", "value"],
        },
      },
      confidence: { type: "number" },
      interpretation: { type: "string", description: "One short clause: how you read the question." },
      missing: { type: "string", description: "For cannot_answer: what data is missing." },
    },
    required: ["status", "text"],
  },
};

export const TOOL_DEFS = [
  {
    name: "describe_data",
    description: "What exists in this shop's records: entity counts, documents per type, extracted field keys (with example values) and date ranges. Call first when unsure which fields or document types exist.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_documents",
    description: "Full-text search of the words on uploaded document pages (permit numbers, work performed, notes, PO numbers, names). Returns excerpts with documentId and page.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        documentType: { type: "string", description: "Optional document_type filter, e.g. permit." },
        customerId: { type: "string", description: "Optional customer_id: search only the documents linked to that customer (use for 'has this unit had X replaced' and other history questions about one customer/address)." },
        limit: { type: "number", description: "Max 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "find_customers",
    description: "Find customers by name, street address, city, state or zip. Returns customerId, name, address, phone, email.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, address: { type: "string" }, city: { type: "string" },
        state: { type: "string" }, zip: { type: "string" }, limit: { type: "number", description: "Max 20." },
      },
    },
  },
  {
    name: "get_customer",
    description: "One customer's contact fields, equipment (model, serial, install date, warranty status) and documents (type, date).",
    input_schema: { type: "object", properties: { customerId: { type: "string" } }, required: ["customerId"] },
  },
  {
    name: "run_query",
    description: "Read-only SQL over the views in the system prompt. Use for counts, lists, rankings, 'who all', 'which', 'how many', date and negation filters. On an error, fix the SQL and retry.",
    input_schema: {
      type: "object",
      properties: { sql: { type: "string" }, purpose: { type: "string", description: "Why, in a few words." } },
      required: ["sql"],
    },
  },
];

export const ALL_TOOL_DEFS = [...TOOL_DEFS, ANSWER_TOOL_DEF];

/* ----------------------------------------------------------------- ledger */

/**
 * Everything the tools actually RETURNED to the model in this run — the only
 * evidence a final answer may cite (shape.js builds answer.js's `allowed` from it).
 */
export class EvidenceLedger {
  constructor() {
    this.passages = []; // {documentId, page, stage}
    this.fields = []; // {documentId, field, stage}
    this.docStage = new Map(); // documentId -> stage
    this.docName = new Map(); // documentId -> filename
    this.ids = new Set(); // every uuid shown to the model (customers, equipment, documents)
    this.corpusParts = []; // the exact text shown to the model
    this.dataCalls = 0; // successful data-returning tool calls
    this.emptyResults = 0; // successful calls that legitimately found nothing
    this.lastQuery = null; // {rowCount, shown, capped} of the most recent successful run_query (list completeness)
  }

  addShown(text) {
    this.corpusParts.push(String(text).toLowerCase());
    for (const m of String(text).match(UUID_G) ?? []) this.ids.add(m.toLowerCase());
  }

  addDoc(documentId, stage, filename) {
    if (typeof documentId !== "string" || !UUID_RE.test(documentId)) return;
    const id = documentId.toLowerCase();
    if (stage && !this.docStage.has(id)) this.docStage.set(id, stage);
    if (!this.docStage.has(id)) this.docStage.set(id, "");
    if (filename && !this.docName.has(id)) this.docName.set(id, filename);
    this.ids.add(id);
  }

  addPassage(documentId, page, stage, filename) {
    this.addDoc(documentId, stage, filename);
    if (typeof page === "number") this.passages.push({ documentId: String(documentId).toLowerCase(), page, stage: stage || undefined });
  }

  addField(documentId, field, stage) {
    this.addDoc(documentId, stage);
    if (field) this.fields.push({ documentId: String(documentId).toLowerCase(), field, stage: stage || undefined });
  }

  get corpus() { return this.corpusParts.join("\n"); }

  /** {passages, extractions} in the shape answer.js's buildAllowed() takes. Every returned
   *  document additionally gets the pseudo-field 'document' (a whole-document citation). */
  allowedInput() {
    const extractions = [
      ...this.fields.map((f) => ({ documentId: f.documentId, field: f.field, stage: f.stage })),
      ...[...this.docStage.entries()].map(([documentId, stage]) => ({ documentId, field: "document", stage: stage || undefined })),
    ];
    return { passages: this.passages, extractions };
  }
}

/* --------------------------------------------------------------- rendering */

function jsonSafe(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  if (typeof v === "object") { try { const s = JSON.stringify(v); return s.length > 200 ? `${s.slice(0, 200)}…` : s; } catch { return null; } }
  return v;
}

function isZeroish(v) { return v == null || v === 0 || v === "0" || v === false || v === ""; }

/** Rows -> compact JSON text under the char cap; returns which rows were actually shown. */
export function renderRows(columns, rows, cap = RESULT_CHAR_CAP) {
  const parts = [];
  const shown = [];
  let len = 160;
  for (const r of rows) {
    const s = JSON.stringify(columns.map((c) => jsonSafe(r[c])));
    if (len + s.length + 1 > cap) break;
    parts.push(s);
    shown.push(r);
    len += s.length + 1;
  }
  const cut = shown.length < rows.length;
  const capped = rows.length >= MAX_QUERY_ROWS;
  const note = cut
    ? `,"truncated":true,"note":"only ${shown.length} of ${rows.length} rows fit - select fewer columns or narrow the query and run it again; do not present these ${shown.length} as the whole list"`
    : capped ? `,"capped":true,"note":"the ${MAX_QUERY_ROWS}-row cap was reached, so there may be more rows than this"` : "";
  const text = `{"rowCount":${rows.length},"shown":${shown.length},"columns":${JSON.stringify(columns)},"rows":[${parts.join(",")}]${note}}`;
  return { text, shown };
}

function registerRows(ledger, shown) {
  for (const r of shown) {
    const docId = r.document_id ?? r.documentId;
    if (typeof docId === "string" && UUID_RE.test(docId)) {
      ledger.addDoc(docId, typeof r.stage === "string" ? r.stage : "", typeof r.filename === "string" ? r.filename : undefined);
      if (typeof r.field_key === "string" && r.field_key) ledger.addField(docId, r.field_key, typeof r.stage === "string" ? r.stage : "");
      const pn = r.page_no == null ? null : Number(r.page_no);
      if (pn != null && Number.isFinite(pn)) ledger.addPassage(docId, pn, typeof r.stage === "string" ? r.stage : "", undefined);
    }
  }
}

function isoDay(v) {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/* ---------------------------------------------------------------- toolbox */

/**
 * @param {{withTenant: Function, ctxArg: object, today: string}} opts
 * @returns an object with execute(name, input) -> {ok, content, rowCount, inputSummary}
 *   and .ledger. Never throws.
 */
export function createToolbox({ withTenant, ctxArg, today }) {
  const ledger = new EvidenceLedger();
  const cache = { describe: null, derivedC: null, derivedE: null };
  /** Every successful run_query of this run (sql, columns, rows) - what a recipe is built from. */
  const queries = [];

  async function loadDerived(db, needC, needE) {
    if (needC && !cache.derivedC) {
      const { rows } = await db.raw(
        `SELECT id, data->>'service_address' AS a FROM entities
          WHERE entity_type = 'customer' AND merged_into IS NULL AND ${t("entities")} LIMIT ${DERIVED_ROW_CAP}`, []);
      cache.derivedC = rows.map((r) => ({ id: r.id, ...pickGeo(deriveGeo(r.a)) }));
    }
    if (needE && !cache.derivedE) {
      const { rows } = await db.raw(
        `SELECT id, data->>'service_address' AS a, data->'warranty' AS w FROM entities
          WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${t("entities")} LIMIT ${DERIVED_ROW_CAP}`, []);
      cache.derivedE = rows.map((r) => {
        const w = r.w && typeof r.w === "object" ? r.w : null;
        const g = pickGeo(deriveGeo(r.a));
        return {
          id: r.id, city: g.city, state: g.state, zip: g.zip,
          warranty_status: warrantyStatusOf(w, today),
          warranty_tier: alertTier(w, today),
          warranty_expires: isoDay(w?.expires),
        };
      });
    }
    return JSON.stringify({ c: needC ? cache.derivedC : [], e: needE ? cache.derivedE : [] });
  }

  async function views(db) {
    return buildViewsSql({ hasUnitIndex: await extractionsHaveUnitIndex(db) });
  }

  const fail = (message, inputSummary) => ({ ok: false, content: `ERROR: ${message}`, rowCount: 0, inputSummary });

  /* ---- describe_data ---- */
  async function describeData() {
    if (cache.describe) return cache.describe;
    const out = await withTenant(ctxArg, async (db) => {
      const ents = (await db.raw(`SELECT entity_type, count(*)::int AS n FROM entities WHERE merged_into IS NULL AND ${t("entities")} GROUP BY 1 ORDER BY 1`, [])).rows;
      const docs = (await db.raw(
        `SELECT COALESCE(document_type, 'unclassified') AS document_type, count(*)::int AS n,
                min(created_at) AS first_uploaded, max(created_at) AS last_uploaded
           FROM documents WHERE ${t("documents")} GROUP BY 1 ORDER BY n DESC`, [])).rows;
      const fields = (await db.raw(
        `SELECT field_key, count(*)::int AS n,
                (array_agg(DISTINCT left(v, 40)) FILTER (WHERE v IS NOT NULL AND v <> ''))[1:2] AS examples
           FROM (SELECT field_key, COALESCE(NULLIF(corrected_value, ''), value) AS v FROM extractions WHERE ${t("extractions")}) q
          GROUP BY 1 ORDER BY n DESC LIMIT 60`, [])).rows;
      const sd = (await db.raw(
        `SELECT min(v) AS first_service, max(v) AS last_service, count(*)::int AS n
           FROM (SELECT left(COALESCE(NULLIF(corrected_value, ''), value), 10) AS v FROM extractions
                  WHERE field_key = 'service_date' AND ${t("extractions")}) q
          WHERE v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`, [])).rows[0];
      return { ents, docs, fields, sd };
    });
    const catalogue = {
      today,
      entities: Object.fromEntries(out.ents.map((r) => [r.entity_type, r.n])),
      documents: out.docs.map((r) => ({
        type: r.document_type, count: r.n,
        firstUploaded: isoDay(r.first_uploaded instanceof Date ? r.first_uploaded.toISOString() : r.first_uploaded),
        lastUploaded: isoDay(r.last_uploaded instanceof Date ? r.last_uploaded.toISOString() : r.last_uploaded),
      })),
      fields: out.fields.map((r) => ({
        key: r.field_key, count: r.n,
        examples: /phone|email/.test(r.field_key) ? undefined : (Array.isArray(r.examples) ? r.examples : undefined),
      })),
      serviceDates: out.sd && out.sd.n ? { first: out.sd.first_service, last: out.sd.last_service, documents: out.sd.n } : null,
    };
    let text = JSON.stringify(catalogue);
    if (text.length > RESULT_CHAR_CAP) {
      catalogue.fields = catalogue.fields.slice(0, 30).map((f) => ({ key: f.key, count: f.count }));
      text = JSON.stringify(catalogue);
    }
    const stable = { ...catalogue, today: undefined };
    let stableText = JSON.stringify(stable);
    if (stableText.length > RESULT_CHAR_CAP) { stable.fields = (stable.fields ?? []).slice(0, 30).map((f) => ({ key: f.key, count: f.count })); stableText = JSON.stringify(stable); }
    cache.describe = { text, stableText, rowCount: out.ents.length + out.docs.length + out.fields.length };
    return cache.describe;
  }

  /* ---- search_documents ---- */
  async function searchDocuments(input) {
    const query = typeof input?.query === "string" ? input.query.trim().slice(0, 300) : "";
    if (!query) return fail("query is required", "search");
    const limit = Math.max(1, Math.min(10, Math.trunc(Number(input.limit)) || 8));
    const docType = typeof input.documentType === "string" && input.documentType.trim() ? input.documentType.trim().toLowerCase() : null;
    const scopeCustomer = typeof input.customerId === "string" && UUID_RE.test(input.customerId.trim()) ? input.customerId.trim() : null;
    if (typeof input.customerId === "string" && input.customerId.trim() && !scopeCustomer) return fail("customerId must be a customer_id returned by another tool", "search");
    const found = await withTenant(ctxArg, async (db) => {
      let scopeIds = null;
      if (scopeCustomer) {
        const { rows: cr } = await db.raw(
          `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
             FROM entities WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND ${t("entities")}`, [scopeCustomer]);
        if (!cr[0]) return [];
        scopeIds = await customerDocumentIds(db, cr[0]);
        if (!scopeIds.length) return [];
      }
      let rows = await db.searchPassages(query, scopeIds ? 40 : docType ? 40 : limit + 4, scopeIds ? { documentIds: scopeIds } : {});
      if (docType) rows = rows.filter((r) => String(r.document_type ?? "").toLowerCase() === docType);
      rows = rows.slice(0, limit);
      const ids = [...new Set(rows.map((r) => r.document_id))];
      let names = new Map();
      if (ids.length) {
        const v = await views(db);
        const res = await db.raw(
          `WITH ${v} SELECT dl.document_id, min(cu.name) AS name FROM doc_links dl
             JOIN customers cu ON cu.customer_id = dl.customer_id WHERE dl.document_id = ANY($2::uuid[]) GROUP BY 1`,
          [JSON.stringify({ c: [], e: [] }), ids]);
        names = new Map(res.rows.map((r) => [r.document_id, r.name]));
      }
      return rows.map((r) => ({
        documentId: r.document_id, page: r.page_no, filename: r.original_filename, documentType: r.document_type,
        stage: r.stage, customer: names.get(r.document_id) ?? null, excerpt: String(r.excerpt ?? "").replace(/\s+/g, " ").slice(0, 320),
      }));
    });
    const parts = [];
    const shown = [];
    let len = 60;
    for (const r of found) {
      const s = JSON.stringify(r);
      if (len + s.length > RESULT_CHAR_CAP) break;
      parts.push(s); shown.push(r); len += s.length + 1;
    }
    const text = `{"resultCount":${found.length},"results":[${parts.join(",")}]}`;
    for (const r of shown) ledger.addPassage(r.documentId, r.page, r.stage, r.filename);
    return { ok: true, content: text, rowCount: found.length, inputSummary: `search${docType ? `:${docType}` : ""}${scopeCustomer ? ":customer" : ""}` };
  }

  /* ---- find_customers ---- */
  async function findCustomers(input) {
    const limit = Math.max(1, Math.min(20, Math.trunc(Number(input?.limit)) || 10));
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const address = typeof input?.address === "string" ? input.address.trim() : "";
    const city = typeof input?.city === "string" ? input.city.trim() : "";
    const state = typeof input?.state === "string" ? input.state.trim() : "";
    const zip = typeof input?.zip === "string" ? input.zip.trim() : "";
    if (!name && !address && !city && !state && !zip) return fail("give at least one of name, address, city, state, zip", "find");
    const rows = await withTenant(ctxArg, async (db) => {
      let base;
      if (name) base = await resolveContactCandidates(db, name);
      else if (address) base = await resolveAddressCandidates(db, address);
      else {
        const like = [city, zip].filter(Boolean).map((s) => `%${s.replace(/[\\%_]/g, "\\$&")}%`);
        base = (await db.raw(
          `SELECT id, customer_number, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
                  data->>'phone' AS phone, data->>'email' AS email
             FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${t("entities")}
              AND data->>'service_address' ILIKE ALL($1::text[]) ORDER BY updated_at DESC LIMIT 500`,
          [like.length ? like : ["%"]])).rows;
      }
      return base.filter((r) => {
        const g = deriveGeo(r.service_address);
        if (city && String(g.city ?? "").toLowerCase() !== city.toLowerCase()) return false;
        if (zip && g.zip !== zip.slice(0, 5)) return false;
        if (state) {
          const want = normalizeStateValue(state) ?? state;
          const have = normalizeStateValue(g.state) ?? g.state;
          if (String(have ?? "").toLowerCase() !== String(want).toLowerCase()) return false;
        }
        if (name && address && !String(r.service_address ?? "").toLowerCase().includes(address.toLowerCase().split(/\s+/)[0])) return false;
        return true;
      }).slice(0, limit);
    });
    const cols = ["customerId", "customerNumber", "name", "address", "phone", "email"];
    const objs = rows.map((r) => ({ customerId: r.id, customerNumber: r.customer_number, name: r.customer_name, address: r.service_address, phone: r.phone, email: r.email }));
    const { text, shown } = renderRows(cols, objs);
    ledger.addShown(text);
    void shown;
    return { ok: true, content: text, rowCount: rows.length, inputSummary: "find_customers" };
  }

  /* ---- get_customer ---- */
  async function getCustomer(input) {
    const id = typeof input?.customerId === "string" ? input.customerId.trim() : "";
    if (!UUID_RE.test(id)) return fail("customerId must be a customer_id returned by another tool", "get_customer");
    const out = await withTenant(ctxArg, async (db) => {
      const { rows: cr } = await db.raw(
        `SELECT id, customer_number, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address,
                data->>'phone' AS phone, data->>'email' AS email
           FROM entities WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND ${t("entities")}`, [id]);
      const c = cr[0];
      if (!c) return null;
      const { rows: er } = await db.raw(
        `SELECT id, data->>'manufacturer' AS manufacturer, data->>'model' AS model, data->>'serial_number' AS serial_number,
                data->>'equipment_type' AS equipment_type, data->>'installation_date' AS installation_date, data->'warranty' AS warranty
           FROM entities WHERE customer_id = $1 AND entity_type = 'equipment' AND merged_into IS NULL AND ${t("entities")}
          ORDER BY updated_at DESC LIMIT 20`, [id]);
      const docIds = await customerDocumentIds(db, c);
      const details = await db.listDocumentDetails(docIds);
      return { c, er, details };
    });
    if (!out) return { ok: true, content: '{"customer":null,"note":"no such customer"}', rowCount: 0, inputSummary: "get_customer", empty: true };
    const docs = out.details
      .map((d) => ({ documentId: d.id, filename: d.original_filename, documentType: d.document_type, stage: d.stage, serviceDate: isoDay(d.service_date), uploaded: isoDay(d.created_at instanceof Date ? d.created_at.toISOString() : d.created_at) }))
      .sort((a, b) => String(b.serviceDate ?? b.uploaded ?? "").localeCompare(String(a.serviceDate ?? a.uploaded ?? "")));
    const equipment = out.er.map((e) => {
      const w = e.warranty && typeof e.warranty === "object" ? e.warranty : null;
      return {
        equipmentId: e.id, manufacturer: e.manufacturer, model: e.model, serial: e.serial_number, type: e.equipment_type,
        installed: e.installation_date, warrantyStatus: warrantyStatusOf(w, today), warrantyExpires: isoDay(w?.expires),
      };
    });
    const lastService = docs.map((d) => d.serviceDate).filter(Boolean).sort().pop() ?? null;
    let text = "";
    let docsShown = docs.slice(0, 40);
    for (;;) {
      text = JSON.stringify({
        customer: { customerId: out.c.id, customerNumber: out.c.customer_number, name: out.c.customer_name, address: out.c.service_address, phone: out.c.phone, email: out.c.email },
        equipment, documentCount: docs.length, lastServiceDate: lastService, documents: docsShown,
      });
      if (text.length <= RESULT_CHAR_CAP || docsShown.length <= 1) break;
      docsShown = docsShown.slice(0, Math.max(1, Math.floor(docsShown.length * 0.7)));
    }
    ledger.addShown(text);
    for (const d of docsShown) ledger.addDoc(d.documentId, d.stage, d.filename);
    return { ok: true, content: text, rowCount: docs.length + equipment.length + 1, inputSummary: "get_customer" };
  }

  /* ---- run_query ---- */
  /**
   * Layers 2-4 (see sqlGuard.js): tenant transaction (already open via withTenant), READ ONLY,
   * statement_timeout, SAVEPOINT. `skipGuard` exists ONLY so scripts/verify-agent.mjs can prove
   * RLS + read-only hold even if the guard were bypassed; nothing in production passes it.
   */
  async function runQuery(input, { skipGuard = false, timeoutMs, registerAll = false } = {}) {
    const purpose = typeof input?.purpose === "string" ? input.purpose.slice(0, 60) : "";
    let wrapped;
    let names = new Set();
    if (skipGuard) {
      wrapped = { raw: String(input?.sql ?? "") };
    } else {
      const g = guardSql(input?.sql);
      if (!g.ok) return fail(g.error, `query:${purpose}`);
      names = referencedNames(g.code);
      wrapped = { guarded: g };
    }
    let result;
    try {
      result = await withTenant(ctxArg, async (db) => {
        const derived = skipGuard ? JSON.stringify({ c: [], e: [] }) : await loadDerived(db, names.has("customers"), names.has("equipment"));
        const sql = skipGuard ? wrapped.raw : wrapSql(wrapped.guarded, await views(db), MAX_QUERY_ROWS);
        const params = skipGuard ? [] : [derived];
        await db.raw("SET LOCAL transaction_read_only = on", []);
        await db.raw(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs ?? QUERY_TIMEOUT_MS())}`, []);
        const tenantBefore = (await db.raw("SELECT current_setting('app.tenant_id', true) AS t", [])).rows[0]?.t ?? null;
        await db.raw("SAVEPOINT agent_query", []);
        try {
          const res = await db.raw(sql, params);
          // Layer 5: if the statement somehow changed the tenant GUC (a guard bypass calling
          // set_config), throw the result away and undo it — the only thing RLS itself cannot stop.
          const tenantAfter = (await db.raw("SELECT current_setting('app.tenant_id', true) AS t", [])).rows[0]?.t ?? null;
          if (tenantAfter !== tenantBefore) {
            await db.raw("ROLLBACK TO SAVEPOINT agent_query", []).catch(() => {});
            return { ok: false, message: "query rejected: it changed session state" };
          }
          await db.raw("RELEASE SAVEPOINT agent_query", []);
          // Stage + filename of every document the rows name (so verified/unverified counts and
          // citation labels are real even when the model did not select those columns).
          let docInfo = [];
          const named = [...new Set((res.rows ?? []).map((r) => r.document_id ?? r.documentId).filter((v) => typeof v === "string" && UUID_RE.test(v)))].slice(0, MAX_QUERY_ROWS);
          if (named.length) {
            docInfo = (await db.raw(`SELECT id, stage, original_filename FROM documents WHERE id = ANY($1::uuid[]) AND ${t("documents")}`, [named])).rows;
          }
          return { ok: true, res, docInfo };
        } catch (err) {
          await db.raw("ROLLBACK TO SAVEPOINT agent_query", []).catch(() => {});
          return { ok: false, message: String(err?.message ?? err).slice(0, 300) };
        }
      });
    } catch (err) {
      return fail(String(err?.message ?? err).slice(0, 300), `query:${purpose}`);
    }
    if (!result.ok) return fail(result.message, `query:${purpose}`);
    const rows = result.res.rows ?? [];
    const columns = (result.res.fields ?? []).map((f) => f.name);
    const cols = columns.length ? columns : rows[0] ? Object.keys(rows[0]) : [];
    // registerAll (recipe fast replay only): code, not a model, composes the answer from every row, so
    // every row is evidence; the model-facing renderer keeps its char cap.
    const { text, shown } = registerAll ? renderRows(cols, rows, Number.MAX_SAFE_INTEGER) : renderRows(cols, rows, QUERY_RESULT_CHAR_CAP);
    ledger.addShown(text);
    ledger.lastQuery = { rowCount: rows.length, shown: shown.length, capped: rows.length >= MAX_QUERY_ROWS };
    if (typeof input?.sql === "string") queries.push({ sql: input.sql.trim(), purpose, columns: cols, rowCount: rows.length, rows: rows.slice(0, MAX_QUERY_ROWS) });
    const info = new Map((result.docInfo ?? []).map((d) => [String(d.id).toLowerCase(), d]));
    for (const r of shown) {
      const d = info.get(String(r.document_id ?? r.documentId ?? "").toLowerCase());
      if (d) { if (typeof r.stage !== "string") r.stage = d.stage; if (typeof r.filename !== "string") r.filename = d.original_filename; }
    }
    registerRows(ledger, shown);
    const empty = rows.length === 0 || (rows.length === 1 && cols.every((c) => isZeroish(rows[0][c])));
    return { ok: true, content: text, rowCount: rows.length, inputSummary: `query:${purpose}`, empty, rows, columns: cols };
  }

  async function execute(name, input) {
    const started = Date.now();
    let r;
    try {
      if (name === "describe_data") {
        const d = await describeData();
        ledger.addShown(d.text);
        r = { ok: true, content: d.text, rowCount: d.rowCount, inputSummary: "describe" };
      } else if (name === "search_documents") r = await searchDocuments(input ?? {});
      else if (name === "find_customers") r = await findCustomers(input ?? {});
      else if (name === "get_customer") r = await getCustomer(input ?? {});
      else if (name === "run_query") r = await runQuery(input ?? {});
      else r = fail(`unknown tool ${String(name).slice(0, 40)}`, "unknown");
    } catch (err) {
      r = fail(String(err?.message ?? err).slice(0, 300), String(name));
    }
    if (r.ok && name !== "describe_data") {
      ledger.dataCalls++;
      if (r.rowCount === 0 || r.empty) ledger.emptyResults++;
    }
    return { ...r, tool: name, ms: Date.now() - started };
  }

  /** Compact catalogue text for the cached system prompt (no `today`, so it is stable for the cache). */
  async function catalogueText() {
    const d = await describeData();
    ledger.addShown(d.text);
    return d.stableText;
  }

  /** Re-run one recipe query fresh through the SAME guard + tenant transaction as any model query. */
  const runRecipeQuery = async (sql) => {
    const r = await runQuery({ sql, purpose: "recipe" }, { registerAll: true });
    if (r.ok) { ledger.dataCalls++; if (r.rowCount === 0 || r.empty) ledger.emptyResults++; }
    return r;
  };

  return { ledger, execute, queries, catalogueText, runRecipeQuery, _runQueryForTests: runQuery, VIEW_NAMES };
}

function pickGeo(g) {
  return { city: g.city ?? null, state: g.state ?? null, zip: g.zip ?? null, county: g.county ?? null };
}
