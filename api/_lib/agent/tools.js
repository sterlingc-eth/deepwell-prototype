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
// view_document_page (viewPage.js): the model may look at the original image/page of a document it already found.
import { createPageViewer, VIEW_PAGE_TOOL_DEF, VIEW_TOOL_NAME } from "./viewPage.js";
// FINANCIALS layer (handoffs/FINANCIALS_2026-09-23.md): the `financials` / `invoice_lines` views live in
// financeViews.js; the table probe + catalogue block live in financials/store.js. Hooked in below with small hunks.
import { financeViewsSql, FINANCE_VIEW_DOCS } from "./financeViews.js";
import { financialsTableExists, financialsCatalogue } from "../financials/store.js";
// TEAM C (citations everywhere): capture the customer / unit / document each run_query row IS, and what search_documents searched.
import { collectQueryIdentities, noteQueryIdentities, noteSearch } from "../citations/agent.js";
// TEAM E (2026-09-24): full-corpus content-count ("how many jobs mention a capacitor") — search_documents only ever
// returns its top ~10 passages, which was silently undercounting; this scans every page. See contentCount.js.
import { runContentCount, canonicalizeTerm } from "../contentCount.js";
import { packForTenant } from "../industry/index.js";
// Team J (2026-09-25): filter_records exposes compose.js's deterministic composable filter engine to the
// model as a tool, so a multi-hop question the model recognizes but the pre-router's own text parse
// missed still gets an exact, code-computed answer instead of hand-rolled (and easily wrong) run_query SQL.
import { runCompose } from "../compose.js";
// Donovan v2 (research agent) tools: safe arithmetic/date math for the compute() tool (see its own doc comment).
import { computeExpression } from "./computeExpr.js";
// TEAM T2 (2026-09-25) knowledge layer, wired into v2 ONLY (see createToolbox's `variant` param below) — v1's
// loop.js keeps calling db.searchPassages exactly as it always has, so verify-agent.mjs's v1 assertions are
// untouched. searchKnowledge is the SAME hybrid db.searchPassages under the hood, plus entity-first filter
// resolution, Voyage rerank and near-dup collapse (see knowledge.js's own header); getDossier and
// mapReduceAnswer back the two new v2-only tools below.
import { searchKnowledge } from "../search/knowledge.js";
import { getDossier } from "../search/dossier.js";
import { mapReduceAnswer } from "../search/mapReduce.js";

const TENANT = "(current_setting('app.tenant_id', true))::uuid";
const t = (alias) => `${alias}.tenant_id = ${TENANT}`;

export const RESULT_CHAR_CAP = 6000;
/** run_query results may be larger: a "who all" list of 40 customers must reach the model whole
 *  (a list silently cut at ~5 rows and phrased as complete was a live defect). */
export const QUERY_RESULT_CHAR_CAP = 10000;
/** read_document (v2): larger than a query result cap since a full page of transcript is meant to be read
 *  whole; still bounded, with pagination (nextPage) picking up whatever did not fit. */
export const READ_DOCUMENT_CHAR_CAP = 12000;
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
export function buildViewsSql({ hasUnitIndex = true, hasFinancials = false } = {}) {
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
),
${financeViewsSql({ hasFinancials })}`.trim();
}

/** What the model is told about the views (goes in the cached system prompt). */
export const VIEW_DOCS = `VIEWS available to run_query (PostgreSQL; one SELECT; query these names only):
- customers(customer_id, customer_number, name, address, phone, email, city, state, zip, county, created_at) — one row per customer.
- equipment(equipment_id, customer_id, serial_number, model, manufacturer, equipment_type, tonnage, refrigerant, installation_date, address, city, state, zip, warranty_status, warranty_tier, warranty_expires, warranty_current) — one row per unit. warranty_status is the app's own deterministic status: 'active' | 'expiring' | 'expired' | 'unknown'; warranty_current = active or expiring. warranty_expires is a YYYY-MM-DD text. Never compute warranty status yourself.
- documents_v(id, document_id, filename, document_type, stage, created_at, service_date, technician, customer_id, customer_name) — one row per uploaded document. service_date is the job date as 'YYYY-MM-DD' text (NULL if none). document_type is one of: work-order, invoice, warranty-registration, startup-sheet, permit, nameplate-photo, maintenance-agreement, service-ticket, dispatch-note, proposal-quote, inspection-report, purchase-order, equipment-record, correspondence, internal, other. A service visit = a document with a service_date.
- facts(document_id, entity_id, field_key, value, unit_index, page_no, confidence, created_at) — extracted fields (corrected values already applied). field_key examples: customer_name, service_address, serial_number, model, manufacturer, permit_number, invoice_number, service_type, work_performed, part_number, technician, agreement_term, cost. Call describe_data to see which exist.
- doc_links(document_id, entity_id, entity_type, customer_id, via) — which customer each document belongs to (directly or through a unit).
${FINANCE_VIEW_DOCS}
SQL rules: SELECT/WITH only, no semicolons, no comments, no double-quoted identifiers, plain functions only. Dates are text: compare like service_date >= '2026-01-01' and use left(service_date, 7) for months. Always select the ids you will cite (customer_id, equipment_id, document_id). CITATIONS: for every list, count or breakdown, ALSO select those id columns (one row per record, e.g. SELECT c.customer_id, c.name, count(*) OVER () AS total_count ... LIMIT 100) so the exact rows behind your number can be shown to the owner; for a breakdown add the group value as AS group_key. A bare count(*) with no ids leaves the number with nothing to click - only use it when the rows would exceed 100, and then say so. Count with count(*) or count(DISTINCT customer_id) instead of counting rows yourself. Max 100 rows come back; if a result says truncated, select fewer columns or narrow the query and run it again - never answer from a truncated list as if it were complete.
Common shapes (adapt, do not copy values):
- customers with a current warranty: SELECT c.customer_id, c.name, e.model, e.warranty_status, e.warranty_expires FROM equipment e JOIN customers c ON c.customer_id = e.customer_id WHERE e.warranty_current ORDER BY c.name
- newest / oldest unit installed: SELECT e.equipment_id, e.manufacturer, e.model, e.serial_number, e.installation_date, e.address FROM equipment e WHERE e.installation_date IS NOT NULL ORDER BY e.installation_date DESC LIMIT 5 (installation_date is text: if the top rows are not YYYY-MM-DD, say the ordering may be unreliable).
- documents of a brand: a document belongs to a brand when it is linked to a unit of that brand or to a customer who owns one. SELECT count(DISTINCT dl.document_id) FROM doc_links dl WHERE dl.customer_id IN (SELECT customer_id FROM equipment WHERE lower(manufacturer) = 'trane'). State that definition in your answer text.
- COVERAGE ("what cities/counties/zip codes do we cover or serve", "do we service anything in Nevada"): never SELECT DISTINCT county FROM customers alone - a bare distinct value has no customer_id, so nothing can be shown to back it up. Instead SELECT c.county, c.customer_id, c.name FROM customers c WHERE c.county IS NOT NULL ORDER BY c.county (same shape for city/state/zip), then name every distinct value in text with at least one customer per value cited as evidence. "Do we serve X" is the same query filtered to that one place: cite the matching customers, or say none if the result is empty.
- COMPARISONS need citable rows on BOTH sides, not just two bare counts: SELECT customer_id, name FROM ... side A ... and the same shape for side B (LIMIT 100 each, or a sample if the count itself would exceed 100), state both totals and cite a few ids from each side - a count(*) with no ids on either side leaves the comparison with nothing to click.`;

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
      basis: { type: "string", description: "One short sentence saying how the answer was computed (what was counted or searched, and by what field). Only numbers that appear in tool results." },
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
    name: "count_documents_mentioning",
    description:
      "Exact full-corpus count of jobs/documents whose page text mentions ANY of the given terms - scans EVERY page, not a top-10 search, so use this instead of search_documents for 'how many jobs/documents mention X', 'which customers had an X issue/repair on file', 'list jobs where we replaced X', 'any complaints about X'. Terms are matched with this shop's own industry synonym/morphology map (e.g. an HVAC tenant's 'capacitor' also finds 'cap'/'dual run cap'; 'leak' also finds 'leaking'; 'noise' also finds 'rattle'/'squeal'/'loud') - pass the plain part/issue word, not every synonym yourself.",
    input_schema: {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" }, maxItems: 10, description: "One or more part/issue words, e.g. ['capacitor'] or ['noise']. OR'd together." },
        documentType: { type: "string", enum: ["jobs", "documents"], description: "'jobs' = completed service-type documents only (service tickets, work orders, invoices, inspections, dispatch notes, startup sheets) - never proposals/permits/paperwork with no visit. Default 'documents' = everything on file. State which you used in your answer." },
        groupBy: { type: "string", enum: ["customer", "document"], description: "'customer' lists the customers instead of the documents (use for 'which customers had...'). Default 'document'." },
      },
      required: ["terms"],
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
  {
    name: "filter_records",
    description:
      "Deterministic composable filter over customers: every condition is AND'd together (code, not SQL you write), then either counted or listed. Prefer this over run_query whenever the question is customers matching several conditions at once (brand, unit age, warranty status, has/lacks a document type, geography, service history, technician, an invoiced-amount threshold) - it is exact and cannot mis-join the way hand-written SQL can.",
    input_schema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["count", "list"], description: "'count' for 'how many', 'list' for 'which customers'." },
        conditions: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          description: "ANDed together. Each condition is one shape:\n" +
            "brand {values:[string,...]} - OR of manufacturer names\n" +
            "ageOlder {years:number} - a unit installed more than N years ago\n" +
            "warrantyStatus {status:'expired'|'expiring'|'active'}\n" +
            "hasDocType / lacksDocType {id:string, phrase?:string} - id is the canonical document type (e.g. 'maintenance-agreement','permit','invoice','purchase-order')\n" +
            "lacksRecentService {months:number} - no service visit in the last N months\n" +
            "neverServiced {} - no service visit on file at all\n" +
            "unitCountGt {n:number} - more than N units\n" +
            "distinctBrandsGte {n:number} - units from N or more distinct brands\n" +
            "noEmail {} - no email on file\n" +
            "geoCity {value:string} - service address in this city\n" +
            "invoicedGt {amount:number} - invoiced more than this dollar amount\n" +
            "technician {name:string} - serviced at least once by this technician",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["brand", "ageOlder", "warrantyStatus", "hasDocType", "lacksDocType", "lacksRecentService", "neverServiced", "unitCountGt", "distinctBrandsGte", "noEmail", "geoCity", "invoicedGt", "technician"] },
              values: { type: "array", items: { type: "string" } },
              years: { type: "number" }, status: { type: "string", enum: ["expired", "expiring", "active"] },
              id: { type: "string" }, phrase: { type: "string" }, months: { type: "number" }, n: { type: "number" },
              value: { type: "string" }, amount: { type: "number" }, name: { type: "string" },
            },
            required: ["type"],
          },
        },
      },
      required: ["op", "conditions"],
    },
  },
];

export const ALL_TOOL_DEFS = [...TOOL_DEFS, VIEW_PAGE_TOOL_DEF, ANSWER_TOOL_DEF];

/* ------------------------------------------------------ v2 (research agent) tool schemas */
// Donovan v2 (2026-09-25): the extra capability a Claude-grade research agent needs that the bounded
// Haiku loop above never did — reading a WHOLE document (not a top-K excerpt), a unit's own profile,
// walking the customer<->unit<->document<->technician graph explicitly, a real chronology, and doing
// its own arithmetic/date math through a tool instead of prose (see computeExpr.js). These are additive:
// TOOL_DEFS/ALL_TOOL_DEFS (the v1 Haiku loop, loop.js) are untouched, so v1's behavior and every existing
// verify-agent.mjs assertion against it stay exactly as they were. loopV2.js is what actually exposes
// ALL_TOOL_DEFS_V2 to the model.

export const READ_DOCUMENT_TOOL_NAME = "read_document";
export const READ_DOCUMENT_TOOL_DEF = {
  name: READ_DOCUMENT_TOOL_NAME,
  description:
    "Read the FULL transcribed text of a document, page by page — not a search excerpt. Use this when a question depends on the whole document (a multi-page contract's terms, everything a long work order says, reconciling two documents against each other) or when search_documents' excerpt is not enough context. Paginates: a long document may say 'more pages: call again with fromPage'.",
  input_schema: {
    type: "object",
    properties: {
      documentId: { type: "string", description: "A documentId returned by another tool." },
      fromPage: { type: "number", description: "First page to read (1-based). Default 1." },
    },
    required: ["documentId"],
  },
};

export const GET_UNIT_TOOL_NAME = "get_unit";
export const GET_UNIT_TOOL_DEF = {
  name: GET_UNIT_TOOL_NAME,
  description: "One piece of equipment's full profile: manufacturer/model/serial/install date, warranty status, its owning customer, and every document linked to THIS unit specifically (not the whole customer).",
  input_schema: { type: "object", properties: { equipmentId: { type: "string" } }, required: ["equipmentId"] },
};

export const FOLLOW_LINKS_TOOL_NAME = "follow_links";
export const FOLLOW_LINKS_TOOL_DEF = {
  name: FOLLOW_LINKS_TOOL_NAME,
  description:
    "Walk the record graph from one id (a customerId, equipmentId or documentId returned by another tool): what it connects to — a customer's units and documents, a unit's customer and documents, or a document's customer/units/technician/service date. Use this to connect entities across documents (e.g. 'which other units does this customer have', 'what else do we have for the technician on this ticket').",
  input_schema: { type: "object", properties: { entityId: { type: "string" } }, required: ["entityId"] },
};

export const TIMELINE_TOOL_NAME = "timeline";
export const TIMELINE_TOOL_DEF = {
  name: TIMELINE_TOOL_NAME,
  description:
    "Chronological list of events (service visits, uploads) for a customer or unit, or across a date range — each with its date, document type, technician and documentId. Use this for 'what happened over time', 'last N visits', 'everything between these dates', and to work out which of two documents is NEWER (more authoritative) when they disagree.",
  input_schema: {
    type: "object",
    properties: {
      customerId: { type: "string" }, equipmentId: { type: "string" },
      dateFrom: { type: "string", description: "YYYY-MM-DD, inclusive." }, dateTo: { type: "string", description: "YYYY-MM-DD, inclusive." },
      documentType: { type: "string" },
      order: { type: "string", enum: ["asc", "desc"], description: "Default desc (most recent first)." },
    },
  },
};

export const COMPUTE_TOOL_NAME = "compute";
export const COMPUTE_TOOL_DEF = {
  name: COMPUTE_TOOL_NAME,
  description:
    "Arithmetic and date math (+ - * /, and today()/daysBetween/monthsBetween/yearsBetween/addDays/addMonths/addYears over 'YYYY-MM-DD' dates). Use this for ANY arithmetic in your answer (a sum, an age, a days-until) instead of doing it yourself — a number in your answer must come from a tool.",
  input_schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
};

// TEAM T2 knowledge layer, v2 only (2026-09-25): a precomputed rolling summary for a broad "everything
// about X" question (cheaper and less turn-hungry than several search_documents/get_customer calls), and
// synthesis over many documents at once for a question no single lookup answers.
export const GET_DOSSIER_TOOL_NAME = "get_dossier";
export const GET_DOSSIER_TOOL_DEF = {
  name: GET_DOSSIER_TOOL_NAME,
  description:
    "A precomputed, cited rolling summary for ONE customer or unit — short factual sentences, each citing the document and page it came from, built up over every document ever linked to that entity. Use this FIRST for a broad 'everything about X' / 'what do we know about this customer' / 'tell me about this unit's history' question, before reaching for several search_documents/get_customer/timeline calls. Returns dossier:null (not an error) when none has been built yet for this entity — fall back to get_customer/get_unit/search_documents in that case.",
  input_schema: {
    type: "object",
    properties: { entityId: { type: "string", description: "A customerId or equipmentId returned by another tool." } },
    required: ["entityId"],
  },
};

export const SYNTHESIZE_TOOL_NAME = "synthesize";
export const SYNTHESIZE_TOOL_DEF = {
  name: SYNTHESIZE_TOOL_NAME,
  description:
    "Answer a question that spans MANY documents at once (dozens to hundreds) by reading each matching one and combining cited facts into a single answer with an honest coverage note — for 'across all of...' / 'every time we...' / a whole customer's history question that a handful of search_documents/read_document calls cannot cover completely. Slower and more expensive than the other tools: use it only when the question genuinely needs many documents combined, not just the best few (search_documents) or one customer's profile (get_customer/get_dossier). May come back as status:'dossier' (answered from the precomputed summary instead, when the exact document set is too large) or status:'queued' (too large even for that; a fuller report will be emailed) — say so plainly in your answer rather than presenting either as a complete fresh read.",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to answer from the matching documents." },
      customerId: { type: "string" },
      equipmentId: { type: "string" },
      docType: { type: "string", description: "Optional document_type filter, e.g. invoice." },
      technician: { type: "string" },
      dateFrom: { type: "string", description: "YYYY-MM-DD" },
      dateTo: { type: "string", description: "YYYY-MM-DD" },
    },
    required: ["question"],
  },
};

export const TOOL_DEFS_V2 = [...TOOL_DEFS, READ_DOCUMENT_TOOL_DEF, GET_UNIT_TOOL_DEF, FOLLOW_LINKS_TOOL_DEF, TIMELINE_TOOL_DEF, COMPUTE_TOOL_DEF, GET_DOSSIER_TOOL_DEF, SYNTHESIZE_TOOL_DEF];
export const ALL_TOOL_DEFS_V2 = [...TOOL_DEFS_V2, VIEW_PAGE_TOOL_DEF, ANSWER_TOOL_DEF];

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
      // financials view rows: a returned money column can be cited as that field ({field:'total'}); total_page is its page.
      for (const col of ["total", "subtotal", "tax", "amount_paid", "balance_due", "open_balance"]) if (r[col] != null) ledger.addField(docId, col, typeof r.stage === "string" ? r.stage : "");
      const pn = (r.page_no ?? r.total_page) == null ? null : Number(r.page_no ?? r.total_page);
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
 * @param {{withTenant: Function, ctxArg: object, today: string, variant?: 'v1'|'v2'}} opts
 *   `variant: 'v2'` (loopV2.js only; loop.js's v1 toolbox omits it and keeps its original behavior
 *   byte-for-byte) turns search_documents' retrieval over to searchKnowledge (entity-first filters +
 *   Voyage rerank + near-dup collapse — see the TEAM T2 import above) and enables get_dossier/synthesize.
 * @returns an object with execute(name, input) -> {ok, content, rowCount, inputSummary}
 *   and .ledger. Never throws.
 */
export function createToolbox({ withTenant, ctxArg, today, fetchObject, deadlineAt, variant = "v1" }) {
  const isV2 = variant === "v2";
  const ledger = new EvidenceLedger();
  const viewDocumentPage = createPageViewer({ withTenant, ctxArg, ledger, ...(fetchObject ? { fetchObject } : {}), ...(deadlineAt ? { deadlineAt } : {}) });
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
    return buildViewsSql({ hasUnitIndex: await extractionsHaveUnitIndex(db), hasFinancials: await financialsTableExists(db) });
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
      const fin = await financialsCatalogue(db); // null when the financials layer is off / empty
      return { ents, docs, fields, sd, fin };
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
      ...(out.fin ? { financials: out.fin } : {}),
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
    let searchScope = null; // TEAM C: what this search covered, for an honest-zero citation
    const found = await withTenant(ctxArg, async (db) => {
      let scopeIds = null;
      // Customer's OWN equipment entity ids, only needed for the v2/searchKnowledge branch below —
      // searchKnowledge's filters merge customerIds+unitIds into ONE union query (see knowledge.js's
      // resolveFilterDocumentIds), so passing both replicates customerDocumentIds()'s broader "linked
      // to the customer directly OR to one of their units" scope exactly, without a second definition of it.
      let scopeEquipmentIds = [];
      if (scopeCustomer) {
        const { rows: cr } = await db.raw(
          `SELECT id, data->>'customer_name' AS customer_name, data->>'service_address' AS service_address
             FROM entities WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND ${t("entities")}`, [scopeCustomer]);
        if (!cr[0]) return [];
        scopeIds = await customerDocumentIds(db, cr[0]);
        searchScope = { name: cr[0].customer_name, docIds: scopeIds };
        if (!scopeIds.length) return [];
        if (isV2) {
          scopeEquipmentIds = (await db.raw(
            `SELECT id FROM entities WHERE customer_id = $1 AND entity_type = 'equipment' AND merged_into IS NULL AND ${t("entities")}`,
            [scopeCustomer])).rows.map((r) => r.id);
        }
      }
      let rows;
      if (isV2) {
        // TEAM T2 wiring (build spec item 3): entity-first filters + Voyage rerank + near-dup collapse.
        // With no customerId given, searchKnowledge also tries its own (never-guessing) entity-first
        // read of `query` itself — pure upside over the v1 branch below, which never attempted that.
        const filters = {};
        if (scopeCustomer) filters.customerIds = [scopeCustomer, ...scopeEquipmentIds];
        if (docType) filters.docTypes = [docType];
        const hits = await searchKnowledge(db, { query, filters, k: limit, rerank: true });
        rows = hits.map((h) => ({
          document_id: h.doc.id, page_no: h.page, original_filename: h.doc.filename,
          document_type: h.doc.docType, stage: h.doc.stage, excerpt: h.excerpt,
        }));
      } else {
        rows = await db.searchPassages(query, scopeIds ? 40 : docType ? 40 : limit + 4, scopeIds ? { documentIds: scopeIds } : {});
        if (docType) rows = rows.filter((r) => String(r.document_type ?? "").toLowerCase() === docType);
        rows = rows.slice(0, limit);
      }
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
    noteSearch(ledger, { query, scopeName: searchScope?.name, docIds: searchScope?.docIds, results: found.length }); // TEAM C
    return { ok: true, content: text, rowCount: found.length, inputSummary: `search${docType ? `:${docType}` : ""}${scopeCustomer ? ":customer" : ""}` };
  }

  /* ---- count_documents_mentioning ---- */
  async function countDocumentsMentioning(input) {
    const rawTerms = (Array.isArray(input?.terms) ? input.terms : []).filter((tm) => String(tm ?? "").trim());
    if (!rawTerms.length) return fail("terms is required: one or more part/issue words", "count_mentions");
    const scope = input?.documentType === "jobs" ? "jobs" : "documents";
    const groupBy = input?.groupBy === "customer" ? "customer" : null;
    let data;
    try {
      // One transaction: resolve the tenant's pack (Team G) and run the scan
      // against it, so a plumbing/electrical/property tenant's own synonym
      // map (e.g. "water heater"/"tankless") is what terms are canonicalized
      // and expanded against, not only HVAC's.
      data = await withTenant(ctxArg, async (db) => {
        const pack = await packForTenant(db);
        const terms = [...new Set(rawTerms.map((tm) => canonicalizeTerm(tm, pack)).filter(Boolean))].slice(0, 10);
        return runContentCount(db, { terms, scope, groupBy }, pack);
      });
    } catch (err) {
      return fail(String(err?.message ?? err).slice(0, 300), "count_mentions");
    }
    if (!data) return fail("could not compute a count for those terms", "count_mentions");
    const records = (data.records ?? []).slice(0, 40).map((r) => ({
      type: r.type, id: r.id, label: r.label, sublabel: r.sublabel, documentId: r.documentId, page: r.page, group: r.group,
    }));
    const text = JSON.stringify({ text: data.text, recordsTotal: data.recordsTotal, basis: data.basis, records });
    ledger.addShown(text);
    for (const r of records) {
      if (typeof r.documentId === "string" && UUID_RE.test(r.documentId)) {
        ledger.addDoc(r.documentId);
        if (typeof r.page === "number") ledger.addPassage(r.documentId, r.page);
      }
    }
    return {
      ok: true, content: text, rowCount: data.recordsTotal ?? 0,
      inputSummary: `count_mentions:${scope}${groupBy ? `:${groupBy}` : ""}`, empty: (data.recordsTotal ?? 0) === 0,
    };
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
          // TEAM C: the customer / unit / document each returned row IS (same rows as the number), labelled from
          // this tenant's own rows inside this same transaction. Never allowed to fail the query.
          let identities = null;
          try { identities = await collectQueryIdentities(db, res.rows ?? [], { maxRows: MAX_QUERY_ROWS }); } catch { identities = null; }
          return { ok: true, res, docInfo, identities };
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
    noteQueryIdentities(ledger, result.identities, { purpose, views: [...names], rowCount: rows.length }); // TEAM C
    const empty = rows.length === 0 || (rows.length === 1 && cols.every((c) => isZeroish(rows[0][c])));
    return { ok: true, content: text, rowCount: rows.length, inputSummary: `query:${purpose}`, empty, rows, columns: cols };
  }

  /* ---- filter_records (Team J: same engine as compose.js's own deterministic pre-router) ---- */
  async function filterRecords(input) {
    const op = input?.op === "count" ? "count" : "list";
    const raw = Array.isArray(input?.conditions) ? input.conditions.slice(0, 6) : [];
    if (!raw.length) return fail("conditions is required (at least one)", "filter_records");
    // A doc-type condition with no human `phrase` still needs one for the answer text - derive it from
    // the id (compose.js's own parser always supplies one from the tenant's pack label; the model may not).
    const conditions = raw.map((c) =>
      (c?.type === "hasDocType" || c?.type === "lacksDocType") && !c.phrase
        ? { ...c, phrase: String(c.id ?? "record").replace(/-/g, " ") }
        : c
    );
    let out;
    try {
      out = await withTenant(ctxArg, (db) => runCompose(db, { op, conditions }, { today }));
    } catch (err) {
      return fail(String(err?.message ?? err).slice(0, 300), "filter_records");
    }
    const text = JSON.stringify({ text: out.text, recordsTotal: out.recordsTotal, basis: out.basis });
    ledger.addShown(text);
    for (const rec of out.records ?? []) {
      if (rec.id) ledger.ids.add(String(rec.id).toLowerCase());
      if (rec.documentId) ledger.addDoc(rec.documentId);
    }
    return { ok: true, content: text, rowCount: out.recordsTotal ?? 0, inputSummary: "filter_records", empty: (out.recordsTotal ?? 0) === 0 };
  }

  /* ---- read_document (v2): FULL page text, paginated ---- */
  async function readDocument(input) {
    const id = typeof input?.documentId === "string" ? input.documentId.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return fail("documentId must be a documentId returned by another tool", "read_document");
    const fromPage = Math.max(1, Math.trunc(Number(input?.fromPage)) || 1);
    const out = await withTenant(ctxArg, async (db) => {
      const { rows: dr } = await db.raw(`SELECT id, document_type, original_filename, stage FROM documents WHERE id = $1 AND ${t("documents")}`, [id]);
      if (!dr[0]) return null;
      const { rows: pages } = await db.raw(
        `SELECT page_no, text FROM document_pages WHERE document_id = $1 AND ${t("document_pages")} AND page_no >= $2 ORDER BY page_no LIMIT 200`,
        [id, fromPage]
      );
      return { doc: dr[0], pages };
    });
    if (!out) return fail("no such document", "read_document");
    if (!out.pages.length) return fail(fromPage > 1 ? `this document has no page ${fromPage} or later` : "this document has no transcribed text yet", "read_document");
    const cap = READ_DOCUMENT_CHAR_CAP;
    let used = 80;
    const included = [];
    for (const p of out.pages) {
      const body = String(p.text ?? "").slice(0, 6000);
      const chunk = `\n--- page ${p.page_no} ---\n${body}`;
      if (used + chunk.length > cap && included.length) break;
      included.push({ page: p.page_no, text: body });
      used += chunk.length;
    }
    const lastIncluded = included[included.length - 1]?.page ?? fromPage;
    const nextPage = out.pages.some((p) => p.page_no > lastIncluded) ? lastIncluded + 1 : null;
    const body = included.map((p) => `\n--- page ${p.page} ---\n${p.text}`).join("");
    const text = JSON.stringify({
      documentId: id, documentType: out.doc.document_type, filename: out.doc.original_filename,
      pagesShown: included.map((p) => p.page), nextPage,
      ...(nextPage ? { note: `more pages follow — call read_document again with fromPage:${nextPage} to continue` } : {}),
    }) + body;
    for (const p of included) ledger.addPassage(id, p.page, out.doc.stage, out.doc.original_filename);
    ledger.addShown(text);
    return { ok: true, content: text, rowCount: included.length, inputSummary: `read_document:${fromPage}` };
  }

  /* ---- get_unit (v2): one piece of equipment's full profile ---- */
  async function getUnit(input) {
    const id = typeof input?.equipmentId === "string" ? input.equipmentId.trim() : "";
    if (!UUID_RE.test(id)) return fail("equipmentId must be an equipment_id returned by another tool", "get_unit");
    const out = await withTenant(ctxArg, async (db) => {
      const { rows: er } = await db.raw(
        `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'model' AS model, data->>'serial_number' AS serial_number,
                data->>'equipment_type' AS equipment_type, data->>'tonnage' AS tonnage, data->>'installation_date' AS installation_date,
                data->>'service_address' AS address, data->'warranty' AS warranty
           FROM entities WHERE id = $1 AND entity_type = 'equipment' AND merged_into IS NULL AND ${t("entities")}`, [id]);
      const e = er[0];
      if (!e) return null;
      const { rows: cr } = await db.raw(
        `SELECT id, customer_number, data->>'customer_name' AS customer_name FROM entities
          WHERE id = $1 AND entity_type = 'customer' AND ${t("entities")}`, [e.customer_id]);
      const v = await views(db);
      const { rows: docRows } = await db.raw(
        `WITH ${v} SELECT DISTINCT dv.id, dv.filename, dv.document_type, dv.stage, dv.created_at, dv.service_date, dv.technician
           FROM doc_links dl JOIN documents_v dv ON dv.id = dl.document_id
          WHERE dl.entity_id = $2 AND dl.entity_type = 'equipment'
          ORDER BY dv.service_date DESC NULLS LAST, dv.created_at DESC LIMIT 60`,
        [JSON.stringify({ c: [], e: [] }), id]);
      return { e, c: cr[0] ?? null, docRows };
    });
    if (!out) return { ok: true, content: '{"unit":null,"note":"no such unit"}', rowCount: 0, inputSummary: "get_unit", empty: true };
    const w = out.e.warranty && typeof out.e.warranty === "object" ? out.e.warranty : null;
    const docs = out.docRows.map((d) => ({
      documentId: d.id, filename: d.filename, documentType: d.document_type,
      serviceDate: isoDay(d.service_date), uploaded: isoDay(d.created_at instanceof Date ? d.created_at.toISOString() : d.created_at), technician: d.technician,
    }));
    const text = JSON.stringify({
      unit: {
        equipmentId: out.e.id, manufacturer: out.e.manufacturer, model: out.e.model, serial: out.e.serial_number,
        type: out.e.equipment_type, tonnage: out.e.tonnage, installed: out.e.installation_date, address: out.e.address,
        warrantyStatus: warrantyStatusOf(w, today), warrantyExpires: isoDay(w?.expires),
      },
      customer: out.c ? { customerId: out.c.id, customerNumber: out.c.customer_number, name: out.c.customer_name } : null,
      documents: docs,
    });
    ledger.addShown(text);
    if (out.c) ledger.ids.add(String(out.c.id).toLowerCase());
    ledger.ids.add(id.toLowerCase());
    for (const d of docs) ledger.addDoc(d.documentId, undefined, d.filename);
    return { ok: true, content: text, rowCount: docs.length + 1, inputSummary: "get_unit" };
  }

  /* ---- follow_links (v2): one hop of the customer<->unit<->document<->technician graph ---- */
  async function followLinks(input) {
    const id = typeof input?.entityId === "string" ? input.entityId.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return fail("entityId must be an id returned by another tool", "follow_links");
    const out = await withTenant(ctxArg, async (db) => {
      const v = await views(db);
      const params = [JSON.stringify({ c: [], e: [] }), id];
      const { rows: cust } = await db.raw(`WITH ${v} SELECT customer_id, name FROM customers WHERE customer_id = $2`, params);
      if (cust[0]) {
        const { rows: equip } = await db.raw(`WITH ${v} SELECT equipment_id, manufacturer, model FROM equipment WHERE customer_id = $2`, params);
        const { rows: docs } = await db.raw(`WITH ${v} SELECT DISTINCT document_id, entity_type FROM doc_links WHERE customer_id = $2`, params);
        return { kind: "customer", id, name: cust[0].name, equipment: equip, documentIds: docs.map((d) => d.document_id) };
      }
      const { rows: equip } = await db.raw(`WITH ${v} SELECT equipment_id, customer_id, manufacturer, model FROM equipment WHERE equipment_id = $2`, params);
      if (equip[0]) {
        const { rows: docs } = await db.raw(`WITH ${v} SELECT DISTINCT document_id FROM doc_links WHERE entity_id = $2 AND entity_type = 'equipment'`, params);
        return { kind: "equipment", id, customerId: equip[0].customer_id, manufacturer: equip[0].manufacturer, model: equip[0].model, documentIds: docs.map((d) => d.document_id) };
      }
      const { rows: doc } = await db.raw(`WITH ${v} SELECT id, customer_id, customer_name, technician, service_date, document_type FROM documents_v WHERE id = $2`, params);
      if (doc[0]) {
        const { rows: linked } = await db.raw(`WITH ${v} SELECT entity_id FROM doc_links WHERE document_id = $2 AND entity_type = 'equipment'`, params);
        return { kind: "document", id, customerId: doc[0].customer_id, customerName: doc[0].customer_name, technician: doc[0].technician, serviceDate: isoDay(doc[0].service_date), documentType: doc[0].document_type, equipmentIds: linked.map((r) => r.entity_id) };
      }
      return null;
    });
    if (!out) return fail("no customer, unit or document with that id", "follow_links");
    const text = JSON.stringify(out);
    ledger.addShown(text);
    return { ok: true, content: text, rowCount: (out.documentIds?.length ?? 0) + (out.equipmentIds?.length ?? 0) + 1, inputSummary: `follow_links:${out.kind}` };
  }

  /* ---- timeline (v2): chronological events for a customer/unit or date range ---- */
  async function timelineTool(input) {
    const customerId = typeof input?.customerId === "string" && UUID_RE.test(input.customerId) ? input.customerId : null;
    const equipmentId = typeof input?.equipmentId === "string" && UUID_RE.test(input.equipmentId) ? input.equipmentId : null;
    if (!customerId && !equipmentId) return fail("give customerId or equipmentId (from another tool)", "timeline");
    const order = input?.order === "asc" ? "ASC" : "DESC";
    const docType = typeof input?.documentType === "string" && input.documentType.trim() ? input.documentType.trim().toLowerCase() : null;
    const dateFrom = typeof input?.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom) ? input.dateFrom : null;
    const dateTo = typeof input?.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dateTo) ? input.dateTo : null;
    const rows = await withTenant(ctxArg, async (db) => {
      const v = await views(db);
      const params = [JSON.stringify({ c: [], e: [] }), customerId ?? equipmentId];
      const scopeClause = customerId ? "dl.customer_id = $2" : "dl.entity_id = $2 AND dl.entity_type = 'equipment'";
      // SELECT DISTINCT requires its ORDER BY expression in the select list itself (a document reachable
      // via more than one doc_links row — a direct link AND an extraction link to the same customer,
      // say — would otherwise duplicate); order_key carries it, and is not part of the mapped output below.
      const { rows: r } = await db.raw(
        `WITH ${v} SELECT DISTINCT dv.id AS document_id, dv.document_type, dv.filename, dv.stage, dv.service_date, dv.technician, dv.created_at,
                COALESCE(dv.service_date, left(dv.created_at::text, 10)) AS order_key
           FROM doc_links dl JOIN documents_v dv ON dv.id = dl.document_id
          WHERE ${scopeClause}
          ORDER BY order_key ${order} LIMIT 80`,
        params);
      return r;
    });
    let events = rows.map((r) => ({
      documentId: r.document_id, date: isoDay(r.service_date) ?? isoDay(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at),
      dateKind: r.service_date ? "service" : "uploaded", documentType: r.document_type, filename: r.filename, technician: r.technician,
    }));
    if (docType) events = events.filter((e) => e.documentType === docType);
    if (dateFrom) events = events.filter((e) => e.date && e.date >= dateFrom);
    if (dateTo) events = events.filter((e) => e.date && e.date <= dateTo);
    events = events.slice(0, 60);
    const text = JSON.stringify({ eventCount: events.length, events });
    ledger.addShown(text);
    for (const e of events) ledger.addDoc(e.documentId, undefined, e.filename);
    return { ok: true, content: text, rowCount: events.length, inputSummary: "timeline", empty: events.length === 0 };
  }

  /* ---- compute (v2): safe arithmetic/date math, see computeExpr.js ---- */
  async function computeTool(input) {
    const r = computeExpression(input?.expression, today);
    if (!r.ok) return fail(r.error, "compute");
    const text = JSON.stringify({ expression: String(input.expression).slice(0, 300), result: r.value });
    ledger.addShown(text);
    return { ok: true, content: text, rowCount: 1, inputSummary: "compute" };
  }

  /* ---- get_dossier (v2, TEAM T2): a precomputed, cited rolling summary for one customer/unit ---- */
  async function getDossierTool(input) {
    const id = typeof input?.entityId === "string" ? input.entityId.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return fail("entityId must be a customerId or equipmentId returned by another tool", "get_dossier");
    let out;
    try {
      out = await withTenant(ctxArg, (db) => getDossier(db, id));
    } catch (err) {
      return fail(String(err?.message ?? err).slice(0, 300), "get_dossier");
    }
    if (!out) {
      return {
        ok: true, content: '{"dossier":null,"note":"no rolling summary built yet for this entity - use search_documents, get_customer or get_unit instead"}',
        rowCount: 0, inputSummary: "get_dossier", empty: true,
      };
    }
    const sentences = (out.sentences ?? []).map((s) => ({ text: s.text, citations: s.citations ?? [] }));
    const text = JSON.stringify({ entityId: out.entityId, entityType: out.entityType, summary: out.summary, sentences, updatedAt: out.updatedAt });
    ledger.addShown(text);
    ledger.ids.add(id);
    for (const s of sentences) {
      for (const c of s.citations) {
        if (typeof c?.documentId === "string" && UUID_RE.test(c.documentId)) ledger.addPassage(c.documentId, typeof c.page === "number" ? c.page : undefined);
      }
    }
    return { ok: true, content: text, rowCount: sentences.length, inputSummary: "get_dossier", empty: sentences.length === 0 };
  }

  /* ---- synthesize (v2, TEAM T2): mapReduceAnswer over many documents at once ---- */
  async function synthesizeTool(input) {
    const question = typeof input?.question === "string" ? input.question.trim().slice(0, 500) : "";
    if (!question) return fail("question is required", "synthesize");
    const filters = {};
    const custId = typeof input?.customerId === "string" && UUID_RE.test(input.customerId) ? input.customerId : null;
    const equipId = typeof input?.equipmentId === "string" && UUID_RE.test(input.equipmentId) ? input.equipmentId : null;
    if (custId) filters.customerIds = [custId];
    if (equipId) filters.unitIds = [equipId];
    if (typeof input?.docType === "string" && input.docType.trim()) filters.docTypes = [input.docType.trim().toLowerCase()];
    if (typeof input?.technician === "string" && input.technician.trim()) filters.technician = input.technician.trim();
    if (typeof input?.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom)) filters.dateFrom = input.dateFrom;
    if (typeof input?.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dateTo)) filters.dateTo = input.dateTo;
    // Leaves a margin for the reduce step's own response + this run's remaining turns; never runs past
    // the agent's own overall deadline (deadlineAt, threaded in from loopV2.js's caller-supplied budget).
    const budgetMs = deadlineAt ? Math.max(5000, Math.min(60_000, deadlineAt - Date.now() - 5000)) : 45_000;
    let out;
    try {
      out = await mapReduceAnswer(ctxArg, { question, filters, deadlineMs: budgetMs, budgetUsd: 0.5 });
    } catch (err) {
      return fail(String(err?.message ?? err).slice(0, 300), "synthesize");
    }
    if (out.status === "error") return fail(out.error ?? "synthesis is not available right now", "synthesize");
    const text = JSON.stringify(out);
    ledger.addShown(text);
    for (const c of out.citations ?? []) {
      if (typeof c?.documentId === "string" && UUID_RE.test(c.documentId)) ledger.addPassage(c.documentId, typeof c.page === "number" ? c.page : undefined);
    }
    const rowCount = out.citations?.length ?? 0;
    return { ok: true, content: text, rowCount, inputSummary: `synthesize:${out.status}`, empty: out.status === "answered" && rowCount === 0 };
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
      else if (name === "count_documents_mentioning") r = await countDocumentsMentioning(input ?? {});
      else if (name === "find_customers") r = await findCustomers(input ?? {});
      else if (name === "get_customer") r = await getCustomer(input ?? {});
      else if (name === "run_query") r = await runQuery(input ?? {});
      else if (name === "filter_records") r = await filterRecords(input ?? {});
      else if (name === READ_DOCUMENT_TOOL_NAME) r = await readDocument(input ?? {});
      else if (name === GET_UNIT_TOOL_NAME) r = await getUnit(input ?? {});
      else if (name === FOLLOW_LINKS_TOOL_NAME) r = await followLinks(input ?? {});
      else if (name === TIMELINE_TOOL_NAME) r = await timelineTool(input ?? {});
      else if (name === COMPUTE_TOOL_NAME) r = await computeTool(input ?? {});
      else if (name === GET_DOSSIER_TOOL_NAME) r = await getDossierTool(input ?? {});
      else if (name === SYNTHESIZE_TOOL_NAME) r = await synthesizeTool(input ?? {});
      else if (name === VIEW_TOOL_NAME) r = await viewDocumentPage(input ?? {});
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
