import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { limit, assertModelBudget, sendModelBudgetExceeded } from "./_lib/rateLimit.js";
import { withTenant, normalizeMatchText } from "./_lib/recordsStore.js";
import { mergeDocumentVia, formatVia } from "./_lib/routes/customers.js";
import {
  ANSWER_TOOL,
  buildAllowed,
  shapeAnswer,
  SYSTEM_PROMPT,
  buildContextBlock,
  buildQuestionBlock,
  selectPassagesForContext,
} from "./_lib/answer.js";
import { planCacheBreakpoints, modelCallLogLine } from "./_lib/promptCache.js";
import { recordModelCall, incrementAsksThisMonth as incrementAsksThisMonthRaw, isCountableAskSource, monthStartUtc } from "./_lib/usage.js";
import { documentTypeLabel } from "./_lib/documentTypes.js";
import { gateAsk } from "./_lib/plan.js";
import { startTimer, formatServerTiming } from "./_lib/timing.js";
import { getCacheEntry, isCacheHit, upsertCacheEntry, shouldCache, ASK_CACHE_ENABLED as ASK_CACHE_ENABLED_RAW } from "./_lib/askCache.js";
import { classifyFastPath, isFastPathEnabled } from "./_lib/fastPath.js";
import { runFastPath } from "./_lib/fastPathQuery.js";
// Team A (2026-09-24): deterministic history/comparison/maintenance router (no model call, cited answers).
import { classifyDeterministic, runDeterministic } from "./_lib/deterministicRouter.js";
import { preClassifyAnalytics, looksLikeSingleRecordReference, isMoneyQuestion, moneyFallbackAnswer, detectedConditions } from "./_lib/analytics.js";
// FINANCIALS layer (handoffs/FINANCIALS_2026-09-23.md): answers money questions from SQL over document_financials.
import { answerMoneyQuestion, moneyNoMatchAnswer } from "./_lib/financials/moneyGate.js";
import { isFinancialQuestion } from "./_lib/financials/classify.js";
// TEAM C (citations everywhere): one citation contract for every answer kind (records / recordsTotal / basis).
import { attachCitations, finalizeCitations, unitRecord, documentRecord } from "./_lib/citations/records.js";
import { attachRetrievalCitations } from "./_lib/citations/retrieval.js";
import { metaCount, metaListCitations, metaDocumentTypes, withCitations, honestZeroCitations, searchedLibraryBasis } from "./_lib/citations/enrich.js";
import { runAnalyticsQuestion, isAnalyticsEnabled } from "./_lib/routes/analytics.js";
import { parseContactLookupQuestion, runContactLookup } from "./_lib/contactLookup.js";
import { parseDocLookupQuestion, runDocLookup, resolveHonestZeroContext, buildHonestZeroText, customerDocumentIds } from "./_lib/docLookup.js";
// TEAM E (2026-09-24): full-corpus content-count questions ("how many jobs mention a capacitor", "which customers had
// a coil issue on file") — a deterministic scan of document_pages.text (all of it, not a top-K search), never the
// agent's own search_documents fallback which was silently undercounting. See contentCount.js's own doc comment.
import { parseContentCountQuestion, runContentCount } from "./_lib/contentCount.js";
// Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): every honest
// fallback / no-answer / ambiguous-lookup / analytics-fallthrough gets a row
// in ask_misses for the weekly review — see missStore.js's own doc comment
// for why every call site here is fire-and-forget and tolerant of the table
// not existing yet.
import { insertAskMiss, recordAskMiss, MISS_OUTCOMES } from "./_lib/missStore.js";
import { getStreetVocab, correctStreetTypos } from "./_lib/streetVocab.js";
// Day 1 training-plan normalization layer (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
// aliased because this file already has its own `normalizeQuestion` (the
// retrieval-cache one, below) — the analytics pre-classifier gate needs the
// NL-normalized text (abbreviations expanded, typos fixed) so a sloppy
// phrasing gets the same routing decision a clean one would, not this file's
// plainer lowercase/trim/strip-punctuation normalization.
import { normalizeQuestion as normalizeQuestionForAnalytics } from "./_lib/nlNormalize.js";
// Tier 2 learning loop, Part A (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
// the process-wide ACTIVE overlay of every approved learned abbreviation/
// typo/synonym/few-shot example — cached 10 minutes, {} on any error (e.g.
// migration 26 not applied yet). Threaded explicitly into every overlay-aware
// call below rather than read again by each one.
import { getActiveOverlay } from "./_lib/learning/overlay.js";
// Donovan agent fallback (api/_lib/agent/): a bounded read-only tool-use loop tried when every
// pre-router / the analytics planner / retrieval+model could not answer. DONOVAN_AGENT=0 disables it.
import { runDonovanAgent, isAgentEnabled, agentQuestionHash, AGENT_PROMPT_VERSION, agentDebugTrace } from "./_lib/agent/loop.js";
import { isAgentFirstQuestion, isEnumerationQuestion, isUnitRankingQuestion, isReasoningQuestion } from "./_lib/agent/intents.js";
import { runRecipeFastPath } from "./_lib/agent/fastReplay.js";
// Recipes (api/_lib/learning/recipes.js): worked examples an approved/confirmed grounded answer taught the agent.
import { findExactRecipe } from "./_lib/learning/recipes.js";
import { submitRecipe } from "./_lib/learning/replay.js";
import { isPlatformOperator } from "./_lib/missDigest.js";
// Donovan Scorecard (api/_lib/scorecard/): in-process calls carry {auth, escalate} under a Symbol no HTTP request can set.
import { takeScorecardCall } from "./_lib/scorecard/hook.js";

/** Billing gate (handoffs/BILLING_RULES.md): ask stays readable through
 * past-due grace and past-grace alike — only a never-subscribed tenant past
 * its free preview, or a canceled subscription, blocks it. */
async function checkAskGate(auth) {
  // Fail OPEN: a billing lookup that errors (e.g. migration 14 not applied
  // yet, or a DB blip) must never turn into a 500 for every customer.
  try {
    return await checkAskGateInner(auth);
  } catch (err) {
    console.error("billing gate failed open (checkAskGate):", err?.message);
    return { allowed: true };
  }
}

async function checkAskGateInner(auth) {
  return withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, async (db) => {
    // Latency fix (2026-09-20, handoffs/ASK_LATENCY_2026-09-20.md): this used
    // to be two sequential queries (the tenant row, then countDocuments()) —
    // two round trips inside a withTenant transaction that already costs
    // BEGIN + resolve_tenant + SET LOCAL + COMMIT on top. One query, one
    // round trip, same two facts. asksThisMonth (2026-09-21, monthly
    // allowance) joins the same round trip rather than costing a second one —
    // see usage.js's getAsksThisMonth for why this can't just be that
    // function called separately (same table, same RLS, cheaper as one more
    // subselect here than a whole extra query).
    const { rows } = await db.raw(
      `SELECT
         (SELECT row_to_json(t) FROM (
            SELECT plan, billing_status, trial_ends_at, current_period_end
              FROM tenants WHERE id = $1
          ) t) AS tenant,
         (SELECT count(*)::int FROM documents WHERE tenant_id = $1) AS documents_stored,
         (SELECT units FROM rate_limit_windows
           WHERE tenant_id = $1 AND bucket = 'ask_month' AND window_start = $2::timestamptz) AS asks_this_month`,
      [db.tenantId, monthStartUtc().toISOString()]
    );
    return gateAsk(rows[0]?.tenant ?? {}, {
      documentsStored: rows[0]?.documents_stored ?? 0,
      asksThisMonth: rows[0]?.asks_this_month ?? 0,
    });
  });
}

/**
 * SHA-256 of a question, never the question itself. Pure and exported so it
 * can be unit tested without a database — see scripts/verify-ops.mjs.
 *
 * WHY THE QUESTION TEXT IS NEVER LOGGED: a dispatcher's question routinely
 * contains a customer's name, address, or unit serial ("what's the warranty
 * on the Andersons' furnace at 12 Elm St") typed straight into a free-text
 * box. audit_log exists to answer "who saw this customer's document" — it is
 * not a place to accumulate a second, unprotected copy of customer PII next
 * to the answer. The hash still lets the same question asked twice be
 * recognized as the same question (e.g. for rate limiting or repeat-question
 * metrics) without ever storing what was actually typed.
 */
export function hashQuestion(question) {
  return crypto.createHash("sha256").update(String(question)).digest("hex");
}

/**
 * POST /api/ask
 * body: { question, today? }
 *
 * Retrieval happens HERE, on the server, against the tenant's own rows:
 * full-text and identifier search over document_pages, plus any
 * already-extracted fields that mention the same identifiers. Only the
 * passages and extractions retrieval actually returns go into the prompt,
 * and shapeAnswer() then drops any fact whose citation doesn't match one of
 * those exact rows (document AND page, or document AND field — see
 * _lib/answer.js). Cost doesn't scale with corpus size, and the model is
 * handed real pages rather than a summary of them, so a fact it cites is a
 * fact on a page.
 *
 * THE TRUST BUG THIS REPLACES: this endpoint used to accept a client-
 * supplied `records` array and answer from it whenever server retrieval came
 * back empty. That fallback is gone, on purpose, not just moved.
 *
 * The reason isn't request size or latency — it's that the browser has no
 * way to send anything BUT its local entity graph, and today that graph is
 * always `src/domains/hvac/seed.ts`: a hardcoded demo fixture, bootstrapped
 * unconditionally on every page load (see src/main.tsx). There is currently
 * no code path that puts a real customer's own data into that graph. So "no
 * server passages, fall back to client records" meant, in practice: a real
 * customer with zero or partially-ingested documents gets a confident,
 * fully-cited answer built entirely out of demo equipment, demo warranties
 * and demo work orders. `shapeAnswer` could not catch this, because the
 * cited "document" genuinely was in the set the fallback handed it — the
 * whole set was just never the customer's.
 *
 * The product's one promise is "every fact comes from your own documents."
 * An honest "nothing in your records answers that yet" keeps that promise;
 * a fabricated-but-cited answer breaks it, and breaks it worse the more
 * confident it sounds. So when retrieval finds nothing, we say so and stop.
 * We do not reach for a second "evidence" source that was never the
 * customer's to begin with — and there is no server-side flag or client
 * field left that could quietly turn it back on. If a real client-side
 * ingestion path is built later, it should hand the SERVER the raw material
 * to retrieve from, so it goes through this same tenant-scoped, retrieval-
 * gated path, not hand the model a pre-packaged, unverifiable "here are the
 * facts" payload directly.
 */
// maxDuration is explicit rather than inherited. A route without it runs on
// the platform's bare default, which is SHORTER than 60s — so the model call
// below could be hard-killed before its own timeout ever fired, and a hard kill
// runs no catch block and tells the user nothing.
export const config = { api: { bodyParser: { sizeLimit: "512kb" } }, maxDuration: 60 };

const MAX_QUESTION = 2000;
const MAX_PASSAGES = 12;
const MAX_EXCERPT = 1200;
// Haiku by default (owner decision 2026-09-20: cost). Set ASK_MODEL in Vercel
// env to switch without a deploy. Retrieval is what makes answers right;
// the model only phrases and cites what retrieval returned.
export const ASK_MODEL = process.env.ASK_MODEL || "claude-haiku-4-5";

/**
 * ---------------------------------------------------------------------------
 * Meta-question pre-router: "how many documents are in the system", "list
 * all customers" — inventory questions with a single, deterministic SQL
 * answer. No model call, no retrieval, no cost, and no chance of the
 * grounding bug above (there is nothing for a model to hallucinate).
 *
 * Classification is exact-match on a normalized question, on purpose: a
 * flexible regex here ("how many X do we have") would also swallow
 * per-entity questions like "how many documents does Plaza Dental have" or
 * "how many tons is the Goodman" — those must keep going through retrieval
 * (buildAllowed/searchPassages), which already answers them correctly.
 * classifyMetaQuestion is exported so scripts/verify-retrieval.mjs can check
 * both the positive phrasings and those negatives without a database.
 */
export function normalizeQuestion(q) {
  return String(q ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
}

const COUNT_QUESTIONS = {
  "how many documents are in the system": "documents",
  "how many documents do we have": "documents",
  "how many documents are there": "documents",
  "how many docs do we have": "documents",
  "how many customers do we have": "customers",
  "how many customers are there": "customers",
  "how many clients do we have": "customers",
  "how many units do we have": "equipment",
  "how many pieces of equipment do we have": "equipment",
  "how many equipment records are there": "equipment",
  "how many invoices do we have": "invoices",
  "how many invoices are there": "invoices",
  "how many warranties do we have": "warranties",
  "how many warranty registrations are there": "warranties",
  "how many documents are verified": "verified",
  "how many are verified": "verified",
  "how many documents are unverified": "unverified",
  "how many are unverified": "unverified",
  "how many are still unverified": "unverified",
};

const LIST_DOCUMENTS = new Set([
  "list all documents", "list documents", "show all documents",
  "show me all documents", "what documents do we have", "what documents exist",
]);
const LIST_UNVERIFIED = new Set([
  "which documents are unverified", "list unverified documents",
  "show unverified documents", "what documents are unverified", "what needs review",
]);
const LIST_CUSTOMERS = new Set([
  "list all customers", "list customers", "show all customers", "who are our customers",
]);
const LIST_TYPES = new Set([
  "what document types do we have", "what types of documents do we have",
  "list document types", "what document types exist",
]);

// Customer numbers (M3-config/15-customer-profiles.sql, 'C-00001' style).
// Matched case-insensitively against the RAW question (never the lowercased
// `q` normalizeQuestion produces) so the returned id keeps canonical
// uppercase 'C-' regardless of how the dispatcher typed it.
const CUSTOMER_NUMBER_RE = /\bC-(\d{5})\b/i;

/** Pure: pull a customer number out of free text, or null. Exported so this
 *  is testable with no database (scripts/verify-retrieval.mjs). */
export function extractCustomerNumber(question) {
  const m = String(question ?? "").match(CUSTOMER_NUMBER_RE);
  return m ? `C-${m[1]}` : null;
}

const SHOW_EVERYTHING_RE = /^show (?:me )?everything (?:for|about) (c-\d{5})$/;

export function classifyMetaQuestion(question) {
  const q = normalizeQuestion(question);
  if (!q) return null;
  const everything = q.match(SHOW_EVERYTHING_RE);
  if (everything) return { kind: "customer", number: everything[1].toUpperCase() };
  if (COUNT_QUESTIONS[q]) return { kind: "count", target: COUNT_QUESTIONS[q] };
  if (LIST_DOCUMENTS.has(q)) return { kind: "list", target: "documents" };
  if (LIST_UNVERIFIED.has(q)) return { kind: "list", target: "unverified-documents" };
  if (LIST_CUSTOMERS.has(q)) return { kind: "list", target: "customers" };
  if (LIST_TYPES.has(q)) return { kind: "list", target: "document-types" };
  // Imperative: the Ask box can't do these — point at where in the app can.
  if (/^(please\s+)?(delete|remove)\b/.test(q)) return { kind: "imperative", action: "delete" };
  if (/^(please\s+)?upload\b/.test(q)) return { kind: "imperative", action: "upload" };
  return null;
}

/**
 * Every document id reachable for one customer, via the same three paths as
 * the customer profile screen (api/_lib/routes/customers.js) — direct
 * customer link, owned-equipment link/extraction, or a name+address text
 * match. Returns null (not []) when the number resolves to no customer, so
 * callers can tell "found the customer, they have zero documents" (a real []
 * — retrieval should find nothing) apart from "that number doesn't exist"
 * (null — the meta path answers that directly; the scoping path falls back
 * to answering unscoped rather than silently returning zero results for a
 * typo'd number).
 */
async function resolveCustomerDocumentIds(db, number) {
  const row = await db.getCustomerByIdOrNumber({ number });
  if (!row || row.merged_into) return { row: null, documentIds: null };
  const name = normalizeMatchText(row.data?.customer_name);
  const address = normalizeMatchText(row.data?.service_address);
  const [linkRows, nameMatchRows] = await Promise.all([
    db.listCustomerDocumentLinks(row.id),
    db.listNameMatchedDocuments(name, address),
  ]);
  const via = mergeDocumentVia([
    ...linkRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
    ...nameMatchRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
  ]);
  return { row, documentIds: via.map((v) => v.documentId).slice(0, 2000), via };
}

/** "show everything for C-00012" — model-free: lists this customer's
 *  documents and equipment with sources, same shape as listCustomers/
 *  listDocuments above. */
async function showCustomerEverything(db, number) {
  const { row, documentIds, via } = await resolveCustomerDocumentIds(db, number);
  if (!row) {
    return attachCitations(
      { kind: "no-answer", text: `No customer found for ${number}.`, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Looked up customer number ${number} in your customer records; no customer has that number.` } // TEAM C
    );
  }
  const [equipmentRows, documentDetails] = await Promise.all([
    db.listCustomerEquipment(row.id),
    db.listDocumentDetails(documentIds),
  ]);
  const viaByDoc = new Map(via.map((v) => [v.documentId, v]));
  const facts = documentDetails.slice(0, META_LIST_LIMIT).map((d) => {
    const v = viaByDoc.get(d.id);
    return {
      label: documentTypeLabel(d.document_type),
      value: `${d.original_filename ?? d.id} (${formatVia(v?.via, v?.serial)})`,
      sources: [{ documentId: d.id, location: {} }],
    };
  });
  for (const u of equipmentRows.slice(0, META_LIST_LIMIT)) {
    facts.push({ label: "Equipment", value: [u.serial_number, u.model].filter(Boolean).join(" — ") || u.id, sources: [] });
  }
  const name = row.data?.customer_name ?? "Unnamed customer";
  const text = `${name} (${row.customer_number}) — ${documentDetails.length} document${documentDetails.length === 1 ? "" : "s"}, ${equipmentRows.length} piece${equipmentRows.length === 1 ? "" : "s"} of equipment.`;
  // TEAM C: the records are the same documents + units the sentence counts.
  const everything = [
    ...documentDetails.map((d) => documentRecord(d, { label: `${documentTypeLabel(d.document_type)} · ${d.original_filename ?? d.id}` })),
    ...equipmentRows.map((u) => unitRecord(u, { customerId: row.id })),
  ];
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    { records: everything, total: everything.length, claimedCount: documentDetails.length + equipmentRows.length,
      basis: `Everything linked to ${name} (${row.customer_number}): documents linked directly, through their equipment, or by matching name and address, plus their equipment.` }
  );
}

const META_LIST_LIMIT = 50;
// Belt-and-braces alongside RLS, same predicate recordsStore.js's private
// TENANT constant uses — see withTenant() there. This route only reaches the
// database via db.raw(), the tenant-scoped escape hatch recordsStore.js
// already exposes for exactly this (see its own doc comment).
const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

const COUNT_LABEL = {
  documents: "documents",
  customers: "customers",
  equipment: "pieces of equipment",
  invoices: "invoices",
  warranties: "warranty registrations",
  verified: "verified documents",
  unverified: "unverified documents",
};

async function countFor(db, target) {
  const table = target === "customers" || target === "equipment" ? "entities" : "documents";
  const where = {
    documents: TENANT_SQL,
    customers: `entity_type = 'customer' AND ${TENANT_SQL}`,
    equipment: `entity_type = 'equipment' AND ${TENANT_SQL}`,
    invoices: `document_type = 'invoice' AND ${TENANT_SQL}`,
    // 'warranty' is the pre-migration legacy id (see handoffs/TEAM_BRIEF); a
    // never-reprocessed row can still carry it.
    warranties: `document_type IN ('warranty-registration','warranty') AND ${TENANT_SQL}`,
    verified: `stage = 'verified' AND ${TENANT_SQL}`,
    unverified: `stage <> 'verified' AND ${TENANT_SQL}`,
  }[target];
  const { rows } = await db.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, []);
  return rows[0].n;
}

async function listDocuments(db, unverifiedOnly) {
  const filter = unverifiedOnly ? `stage <> 'verified' AND ${TENANT_SQL}` : TENANT_SQL;
  const total = (await db.raw(`SELECT COUNT(*)::int AS n FROM documents WHERE ${filter}`, [])).rows[0].n;
  // TEAM C: the citation records come from this same query (more columns, up to the record cap); the
  // response `sources` keep their original first-META_LIST_LIMIT size.
  const { rows: allRows } = await db.raw(
    `SELECT id, document_type, original_filename, created_at FROM documents WHERE ${filter} ORDER BY created_at DESC LIMIT 200`,
    []
  );
  const rows = allRows.slice(0, META_LIST_LIMIT);
  const sources = rows.map((r) => ({ documentId: r.id, location: {} }));
  const noun = unverifiedOnly ? "unverified document" : "document";
  const text = total > sources.length
    ? `${total} ${noun}s — showing the first ${sources.length}.`
    : `${total} ${noun}${total === 1 ? "" : "s"}.`;
  return attachCitations(
    { kind: "answer", text, facts: [], sources, confidence: 1, verifiedCount: sources.length, unverifiedCount: 0, closest: [] },
    { ...metaListCitations(unverifiedOnly ? "unverified" : "documents", allRows, total), basis: unverifiedOnly ? "Listed documents that have not been verified yet, newest upload first." : "Listed documents, newest upload first." }
  );
}

async function listCustomers(db) {
  const total = (await db.raw(
    `SELECT COUNT(*)::int AS n FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}`, []
  )).rows[0].n;
  // TEAM C: id column added so each listed customer is a clickable record (same rows, same order).
  const { rows: allRows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address
       FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}
      ORDER BY updated_at DESC LIMIT 200`,
    []
  );
  const rows = allRows.slice(0, META_LIST_LIMIT);
  const facts = rows.map((r) => ({ label: r.name || "Unnamed customer", value: r.address || "—", entityId: r.id, sources: [] }));
  const text = total > facts.length
    ? `${total} customers — showing the first ${facts.length}.`
    : `${total} customer${total === 1 ? "" : "s"}.`;
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    metaListCitations("customers", allRows.map((r) => ({ ...r, customer_name: r.name, service_address: r.address })), total)
  );
}

async function listDocumentTypes(db) {
  // TEAM C: same GROUP BY, now also carrying the documents in each group (records keep the type as their group key).
  const { rows, citations } = await metaDocumentTypes(db);
  const facts = rows.map((r) => ({ label: documentTypeLabel(r.document_type), value: String(r.n), sources: [] }));
  const text = facts.length ? `${facts.length} document type${facts.length === 1 ? "" : "s"} in use.` : "No documents yet.";
  return attachCitations(
    { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] },
    citations
  );
}

const IMPERATIVE_TEXT = {
  delete: "To delete a document: go to Browse → Documents, select it, then choose Delete selected.",
  upload: "To upload a document: go to Intake and drop your files there.",
};

async function runMetaQuestion(db, meta) {
  if (meta.kind === "imperative") {
    return attachCitations(
      { kind: "no-answer", text: IMPERATIVE_TEXT[meta.action], facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, basis: "This is a how-to about the app, not something drawn from your records." } // TEAM C
    );
  }
  if (meta.kind === "count") {
    // TEAM C: ONE query yields the number AND the rows behind it (window COUNT), so they cannot disagree.
    const counted = await metaCount(db, meta.target);
    const n = counted ? counted.n : await countFor(db, meta.target);
    const label = COUNT_LABEL[meta.target];
    const answer = {
      kind: "answer",
      text: `You have ${n} ${label}.`,
      facts: [{ label: label[0].toUpperCase() + label.slice(1), value: String(n), sources: [] }],
      sources: [], confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [],
    };
    return counted ? attachCitations(answer, counted.citations) : answer;
  }
  if (meta.kind === "customer") return showCustomerEverything(db, meta.number);
  if (meta.target === "unverified-documents") return listDocuments(db, true);
  if (meta.target === "documents") return listDocuments(db, false);
  if (meta.target === "customers") return listCustomers(db);
  return listDocumentTypes(db);
}

/**
 * Evidence retrieval for one question: the customer-number scope (if any)
 * plus the two independent reads (searchPassages/searchExtractions), all in
 * ONE withTenant transaction — was three separate withTenant calls (each its
 * own connect + BEGIN + resolve_tenant + SET LOCAL + COMMIT), now one, with
 * the two searches themselves run with Promise.all since neither depends on
 * the other. See handoffs/ASK_LATENCY_2026-09-20.md.
 *
 * Same failure semantics as before: a customer-scope lookup failure falls
 * back to an unscoped search (not an error); a search failure returns empty
 * results (the same "nothing matched" the honest no-answer path already
 * handles) rather than a 500.
 */
// EMPTY_RETRIEVAL: the shared "nothing here" return shape, extended with the
// cache bookkeeping fields (questionHash/corpusStamp) every caller destructures
// regardless of which branch produced it.
const EMPTY_RETRIEVAL = { passages: [], extractions: [], cacheHit: false, cachedAnswer: null, questionHash: null, corpusStamp: null };

function retrieveEvidence(ctxArg, question, customerNumber, timer, { today, questionHash, noCache = false }) {
  return timer.time("retrieve", async () => {
    try {
      return await withTenant(ctxArg, async (db) => {
        let documentIdsFilter = null;
        if (customerNumber) {
          const scopeStart = Date.now();
          try {
            const resolved = await resolveCustomerDocumentIds(db, customerNumber);
            documentIdsFilter = resolved.documentIds; // null (unknown number) or a real (possibly empty) list
          } catch (err) {
            console.error("Customer-number scoping failed, answering unscoped:", err?.message);
          } finally {
            timer.add("scope", Date.now() - scopeStart);
          }
        }

        // ---- answer cache (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md) -----
        // Stamp + cache row in the SAME round trip as each other (see
        // askCache.js's COMBINED_SQL), inside this same withTenant
        // transaction — no extra connection just to check the cache.
        let corpusStamp = null;
        let cachedAnswer = null;
        await timer.time("cache", async () => {
          if (noCache) return; // scorecard calls always run the live pipeline
          try {
            const entry = await getCacheEntry(db, { questionHash, today });
            corpusStamp = entry.corpusStamp;
            if (isCacheHit(entry.row, entry.corpusStamp)) cachedAnswer = entry.row.answer;
          } catch (err) {
            console.error("Ask cache lookup failed, answering without cache:", err?.message);
          }
        });
        if (cachedAnswer) {
          return { passages: [], extractions: [], cacheHit: true, cachedAnswer, questionHash, corpusStamp };
        }

        const [passages, extractions] = await Promise.all([
          db.searchPassages(question, MAX_PASSAGES, { documentIds: documentIdsFilter }),
          db.searchExtractions(question, 25, { documentIds: documentIdsFilter }),
        ]);
        return { passages, extractions, cacheHit: false, cachedAnswer: null, questionHash, corpusStamp };
      });
    } catch (err) {
      // A retrieval failure must not take the endpoint down. It also must
      // NOT be papered over with a second, untrustworthy evidence source —
      // see the file header. Log it and fall through to the same honest
      // no-answer that "nothing matched" gets: a customer can't act any
      // differently on the difference between "we found nothing" and "we
      // couldn't check", and guessing is worse than either.
      console.error("Retrieval failed:", err?.message);
      return EMPTY_RETRIEVAL;
    }
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Server-Timing + the ASK_DEBUG_TIMINGS escape hatch (both handoffs/
  // ASK_LATENCY_2026-09-20.md) — ms only, no PII, no question text.
  const timer = startTimer();
  const send = (status, body) => {
    // TEAM C: last-resort guarantee that EVERY answer carries the citation contract (idempotent; mutates in place
    // so the answer cache stores it too). Producers attach richer records/basis earlier; this only fills gaps.
    if (body?.data && typeof body.data === "object") {
      try { finalizeCitations(body.data); } catch (err) { console.error("finalizeCitations failed, sending answer without it:", err?.message); }
    }
    const header = formatServerTiming(timer.snapshot());
    if (header && !res.headersSent) res.setHeader("Server-Timing", header);
    if (process.env.ASK_DEBUG_TIMINGS === "1" && body?.data && typeof body.data === "object") {
      body.data.timingsMs = timer.snapshot();
    }
    return handleCors(res, req).status(status).json(body);
  };

  // Scorecard call (hook.js): null for every real request. When set it supplies the auth, skips the rate
  // limiter / billing gate, never counts against the monthly allowance and never touches the answer cache.
  const scorecardCall = takeScorecardCall(req);
  const incrementAsksThisMonth = scorecardCall ? async () => {} : incrementAsksThisMonthRaw;
  const ASK_CACHE_ENABLED = ASK_CACHE_ENABLED_RAW && !scorecardCall;

  let auth;
  try {
    auth = scorecardCall
      ? scorecardCall.auth
      : await timer.time("auth", async () => {
          const a = await requireAuthOrKey(req);
          assertScope(a, "ask");
          return a;
        });
  } catch (err) {
    return denyAuth(res, err);
  }

  // The single most rate-limit-relevant route in the codebase: every call is
  // a model call. 429 is already written when this returns false.
  if (!scorecardCall && !(await timer.time("limit", () => limit(req, res, auth, "ask")))) return;

  try {
    let { question, today } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }
    if (question.length > MAX_QUESTION) {
      return res.status(400).json({ error: "Question is too long" });
    }

    const ctxArg = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
    const meta = classifyMetaQuestion(question);
    // Never throws (see getActiveOverlay's own doc comment) — safe to await
    // directly with no try/catch here.
    const overlay = await timer.time("overlay", () => getActiveOverlay());

    // ---- street-name typo correction (live miss cluster 4, 2026-09-21) ----
    // "when was the unit at 766 n val ivsta dr, tucson installed" — the
    // ADDRESS SHAPE is fine (fastPath's own ADDRESS_RE needs only a number +
    // words + a street-suffix word), but the typo'd street NAME never
    // matches a real address token during DB resolution, so both fastPath
    // and the retrieval fallback come up empty. nlNormalize's own fuzzy
    // correction deliberately skips every word of a single-record question
    // (a general word list has no business rewriting an address) — this
    // corrects against the TENANT'S OWN street vocabulary instead (see
    // streetVocab.js), cached 10 minutes per tenant so this costs a real DB
    // round trip only on a cache miss, and only for a question that already
    // looks like a single-record reference (never for an aggregate/analytics
    // question — no address to correct there). Runs before fastPathIntent/
    // customerNumber/retrieval are computed so all three see the corrected
    // text; `question` is reassigned in place (let, not const) rather than
    // threading a second "effective question" variable through every
    // downstream call site.
    if (!meta && looksLikeSingleRecordReference(question)) {
      try {
        const streetVocab = await timer.time("streetvocab", () =>
          withTenant(ctxArg, (db) => getStreetVocab(db, auth.tenantId))
        );
        const { corrected, corrections } = correctStreetTypos(question, streetVocab);
        if (corrections.length) {
          console.log(JSON.stringify({ route: "ask", street_typo_corrections: corrections }));
          question = corrected;
        }
      } catch (err) {
        console.error("Street vocab correction failed, using original question:", err?.message);
      }
    }

    // Fast path (handoffs/FAST_PATH_2026-09-20.md): a model-free field lookup
    // straight from `extractions`, tried after the meta-router and before
    // retrieval/the answer cache — see the block below. Never attempted for a
    // meta question (the meta-router already owns those) or when
    // ASK_FAST_PATH=0. classifyFastPath is pure (no DB) so this costs nothing
    // when it returns null, which most non-meta questions still will.
    const fastPathIntent = !meta && isFastPathEnabled() ? classifyFastPath(question) : null;
    // Team A: comparison / maintenance-due / address-history questions (pure shape detection, no DB) - see block 0.4.
    const detIntent = !meta ? classifyDeterministic(question) : null;
    // Contact-lookup-by-name pre-router (live miss cluster 1, 2026-09-21):
    // "what's the phone number on file for donna thornton" — a lowercase
    // name with no HVAC anchor satisfies neither of fastPath's own gates
    // (extractSubject's name regexes require capitalization; hasAnchor needs
    // an HVAC-specific word) so fastPath itself never claims these. Pure
    // shape detection only here (no DB) — see contactLookup.js.
    const contactLookupIntent = !meta ? parseContactLookupQuestion(question, { overlay }) : null;
    // Document-lookup-by-customer/address pre-router (100-question persona
    // sample, item 1, 2026-09-22): "do we have a maintenance agreement on file
    // for the Bracken job" / "list the invoices for 214 Mercer St" — resolved
    // straight from documents/document_entity_links, no model call, no
    // citation-worthy passage needed. Only tried when contact-lookup itself
    // didn't already claim the question (its own field-lookup shapes are
    // checked first and take priority on any overlap). Pure shape detection
    // only here (no DB) — see docLookup.js.
    const docLookupIntent = !meta && !contactLookupIntent ? parseDocLookupQuestion(question, { overlay }) : null;
    // Content-count pre-router (Team E, 2026-09-24): "how many jobs mention a capacitor" / "which customers had a
    // coil issue on file" — pure shape detection only here (no DB); see contentCount.js. Tried after contact/doc
    // lookup (their own shapes take priority on any overlap) and, like them, never for a meta question.
    const contentCountIntent = !meta && !contactLookupIntent && !docLookupIntent ? parseContentCountQuestion(question) : null;
    const normalizedForAnalytics = normalizeQuestionForAnalytics(question, { overlay }).normalized;
    // Money gate (live miss cluster 2, 2026-09-21): "what's the total dollar
    // amount of our open invoices" style questions have no honest answer yet
    // — there is no financials layer (handoffs/FINANCIALS_DESIGN_2026-09-21.md,
    // not built) and the analytics `sum` op has no real currency support, so
    // answering anyway produces a confident, fabricated "$0.00 across N
    // documents." Checked here, before the analytics pre-router, so a money
    // question NEVER reaches the Haiku planner at all — see
    // isMoneyQuestion/moneyFallbackAnswer (analytics.js).
    // R3_FAILS.md 2026-09-24: isMoneyQuestion alone missed "overdue"/"past due", bare
    // "paid"/"owe(s) us", a dollar threshold ("over $5,000") and a superlative ("biggest
    // invoice") entirely, so those 27 financial questions fell into the analytics
    // pre-router below and got a bare document count instead. isFinancialQuestion
    // (financials/classify.js) is deliberately broader and OR'd in here — see its own
    // doc comment for why a false positive here is harmless.
    // Team E: a content-count question ("how many jobs mention a capacitor") is never a money question.
    const moneyQuestion = !meta && !docLookupIntent && !contentCountIntent && (isMoneyQuestion(normalizedForAnalytics) || isFinancialQuestion(normalizedForAnalytics));
    // Analytics pre-router (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md): a
    // cheap deterministic regex gate (preClassifyAnalytics, no DB/model cost)
    // decides whether this question is even WORTH the one Haiku planner call
    // below — most questions still won't match and pay nothing extra. Tried
    // after meta, fast path, contact lookup and the money gate (all of which
    // already own their own question shapes) and, like fast path, never
    // fired for a meta question.
    // looksLikeSingleRecordReference is checked against the RAW question, not
    // the normalized one: SINGULAR_NAMED_RECORD_RE (analytics.js) keys off a
    // capitalized proper noun ("the Whitmore unit") to catch a named-record
    // question with no address/identifier — a signal normalization's own
    // lowercasing necessarily destroys. Checking it here, before
    // normalization, keeps that exclusion working for input that arrives
    // capitalized, on top of whatever preClassifyAnalytics(normalized) itself
    // already re-checks (redundant on lowercased text, never wrong).
    const analyticsCandidate =
      !meta && !fastPathIntent && !contactLookupIntent && !docLookupIntent && !contentCountIntent && !moneyQuestion && isAnalyticsEnabled() &&
      !looksLikeSingleRecordReference(question) &&
      // "newest/oldest unit": ranking the whole fleet needs an ORDER BY, which the closed-vocabulary planner
      // does not have (it would list every unit) - the agent answers these (agent-first, below).
      !(isAgentEnabled() && isUnitRankingQuestion(question)) &&
      // Team A: comparison / why / trend questions the deterministic router could not parse go to the agent (Sonnet-
      // escalated by the hard-question classifier) instead of a planner that flattens them into one count.
      !(isAgentEnabled() && isReasoningQuestion(question)) &&
      preClassifyAnalytics(normalizedForAnalytics, { overlay });
    const customerNumber = extractCustomerNumber(question);
    // Resolved once, reused for both the answer cache key's `today` and the
    // question block the model sees (buildQuestionBlock, below) — was
    // computed twice (inconsistently) before the cache needed it up front.
    const todayResolved = today ?? new Date().toISOString().slice(0, 10);
    // Cache key (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md): normalized so
    // near-identical phrasings ("What's the warranty?" / "whats the warranty")
    // share a cache entry — same normalization the meta-router already uses.
    const questionHash = hashQuestion(normalizeQuestion(question));

    // ---- Donovan agent fallback (DONOVAN_AGENT, default on) ----------------
    // Tried at most once per request, from three places below: an honest analytics fallback / an
    // unhandled analytics candidate, retrieval finding nothing, and the retrieval+model path
    // shaping a no-answer. Answers are cached under their own namespaced hash + prompt version
    // (never shared with retrieval or analytics rows) and count ONCE against the monthly allowance
    // (usage.js "agent"). Any agent error / timeout / no-answer returns false and the caller
    // continues with exactly today's behaviour. The operator-only `data.debug` trace needs both an
    // operator caller AND body.debug === true. Returns true iff it already sent the response.
    const agentOn = isAgentEnabled();
    const agentDebug = agentOn && (Boolean(scorecardCall) || (req.body?.debug === true && isPlatformOperator(auth)));
    const requestStartedAt = Date.now();
    let agentTried = false;
    const tryAgent = async ({ extraUsage = null, budgetMs = 50_000, recordMiss = true } = {}) => {
      if (!agentOn || agentTried) return false;
      agentTried = true;
      const qHash = agentQuestionHash(question);
      let corpusStamp = null;
      let result = null;
      try {
        if (ASK_CACHE_ENABLED) {
          try {
            const probe = await withTenant(ctxArg, (db) => getCacheEntry(db, { questionHash: qHash, today: todayResolved, promptVersion: AGENT_PROMPT_VERSION }));
            corpusStamp = probe.corpusStamp;
            if (isCacheHit(probe.row, probe.corpusStamp)) {
              const cachedData = { ...probe.row.answer, cached: true };
              send(200, { success: true, data: cachedData });
              await timer.time("bookkeeping", async () => {
                try {
                  await withTenant(ctxArg, async (db) => {
                    await db.logAction({
                      action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                      changes: { question_hash: hashQuestion(question), documents: [...new Set((cachedData.sources ?? []).map((x) => x.documentId))], passages: 0, agent: true, cached: true },
                    });
                    if (extraUsage && isCountableAskSource("model")) await incrementAsksThisMonth(db);
                  });
                } catch (err) {
                  console.error("Agent cache-hit bookkeeping failed:", err?.message);
                }
                if (extraUsage) await recordModelCall(ctxArg, extraUsage).catch(() => {});
              });
              return true;
            }
          } catch (err) {
            console.error("Agent cache probe failed:", err?.message);
          }
        }
        // Exact-match recipe (an ACTIVE, approved/confirmed recipe for this very question): re-run its
        // SQL fresh through the same guard and answer from the rows - no model call. Anything that
        // differs falls through to the normal agent below.
        const recipe = findExactRecipe(overlay?.recipes, question);
        if (recipe) {
          const fast = await timer.time("recipe", () => runRecipeFastPath({ withTenant, ctxArg, recipe, question, today: todayResolved }));
          if (fast.handled) result = fast;
        }
        if (!result) {
          result = await timer.time("agent", () =>
            runDonovanAgent({ withTenant, ctxArg, question, today: todayResolved, overlay, deadlineAt: Math.min(requestStartedAt + budgetMs, scorecardCall?.deadlineAt ?? Infinity), escalate: scorecardCall?.escalate === true })
          );
        }
      } catch (err) {
        // Includes ModelBudgetExceededError: the standard fallback below decides what a
        // budget-exhausted tenant sees, exactly as it did before the agent existed.
        console.error("Donovan agent failed, using the standard fallback:", err?.name === "ModelBudgetExceededError" ? "model budget" : err?.message);
      }
      if (!result?.handled) {
        // recordMiss:false for the agent-first probe: retrieval still gets its turn, and whatever it
        // ends with is what gets logged as the miss (or not).
        if (recordMiss) recordAskMiss(ctxArg, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.AGENT_NO_ANSWER }).catch(() => {});
        return false;
      }
      const data = result.data;
      send(200, { success: true, data: agentDebug ? { ...data, debug: agentDebugTrace(result) } : data });
      await timer.time("bookkeeping", async () => {
        try {
          await withTenant(ctxArg, async (db) => {
            try {
              await db.logAction({
                action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
                changes: { question_hash: hashQuestion(question), documents: [...new Set((data.sources ?? []).map((x) => x.documentId))], passages: 0, agent: true },
              });
            } catch (err) {
              console.error("Failed to write document.queried audit row (agent):", err?.message);
            }
            // A recipe replay made no model call: it never counts against the allowance.
            if (!result.fastReplay && isCountableAskSource("agent")) await incrementAsksThisMonth(db);
            if (ASK_CACHE_ENABLED && corpusStamp && shouldCache(data.kind, 0, 0)) {
              await db.raw("SAVEPOINT agent_cache_upsert", []);
              try {
                await upsertCacheEntry(db, { questionHash: qHash, corpusStamp, today: todayResolved, answer: data });
                await db.raw("RELEASE SAVEPOINT agent_cache_upsert", []);
              } catch (err) {
                console.error("Failed to upsert agent cache row:", err?.message);
                await db.raw("ROLLBACK TO SAVEPOINT agent_cache_upsert", []).catch(() => {});
              }
            }
          });
        } catch (err) {
          console.error("Agent bookkeeping transaction failed:", err?.message);
        }
        if (extraUsage) await recordModelCall(ctxArg, extraUsage).catch(() => {});
        // A fresh grounded agent answer teaches a recipe proposal (goes live only once confirmed:
        // same result twice, or an operator/thumbs-up approves it - learning/policy.js). Never throws.
        if (!result.fastReplay) await submitRecipe({ ctxArg, question, run: result });
      });
      return true;
    };

    // ---- overlap, not a chain (handoffs/ASK_LATENCY_2026-09-20.md) --------
    // Three independent reads that used to run one after another. `limit`
    // above stays first (it writes the 429 itself and must do so before
    // anything else responds); everything below it is safe to overlap:
    //   - assertModelBudget is a single already-combined round trip
    //     (getDailyModelBudgetStatus) on its own connection/pool. Fired now
    //     so its latency overlaps the gate check and retrieval instead of
    //     stacking after both — it is only actually CONSULTED (awaited)
    //     right before the model call below, exactly where it always was;
    //     starting it early changes nothing about when it's enforced. The
    //     `.catch` silences the "unhandled rejection" warning for a request
    //     that never reaches the model at all (blocked by billing, or
    //     answered by the meta-router) and therefore never awaits it again.
    //   - checkAskGate needs its own connection regardless.
    //   - retrieveEvidence needs its own connection regardless, and doesn't
    //     depend on the gate's answer — skipped here for a meta question,
    //     which answers from a single deterministic query instead; on the
    //     rare case the meta query itself fails, retrieval is (re)run
    //     inline below, same as the very first implementation.
    // Pool is max 5 (recordsStore.js) — cap this request at 2 concurrent
    // connections: gate→budget chained on one, retrieval on the other.
    const gatePromise = scorecardCall ? Promise.resolve({ allowed: true }) : timer.time("gate", () => checkAskGate(auth));
    const budgetPromise = gatePromise.then(() => timer.time("budget", () => assertModelBudget(ctxArg)));
    budgetPromise.catch(() => {});
    // Neither a meta question nor a fast-path candidate needs retrieval fired
    // early — both may answer without it. A fast-path candidate that turns out
    // to have no DB answer (ambiguous subject, no value on file) re-runs
    // retrieval inline below, same fallback shape as the meta-router's own.
    const retrievalPromise = meta || detIntent || fastPathIntent || contactLookupIntent || docLookupIntent || contentCountIntent || moneyQuestion || analyticsCandidate
      ? null
      : retrieveEvidence(ctxArg, question, customerNumber, timer, { today: todayResolved, questionHash, noCache: Boolean(scorecardCall) });

    const gate = await gatePromise;
    if (!gate.allowed) {
      if (retrievalPromise) await retrievalPromise; // don't leak an in-flight transaction on the way out
      return send(gate.status, { error: gate.error, url: gate.url });
    }

    // ---- 0. meta-question pre-router (no model, no retrieval) --------------
    if (meta) {
      try {
        const data = await timer.time("retrieve", () => withTenant(ctxArg, (db) => runMetaQuestion(db, meta)));
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, async (db) => {
              await db.logAction({
                action: "document.queried",
                resource_type: "question",
                clerk_user_id: auth.userId,
                changes: {
                  question_hash: hashQuestion(question),
                  documents: [...new Set(data.sources.map((s) => s.documentId))],
                  passages: 0,
                },
              });
              if (data.kind === "no-answer") {
                await insertAskMiss(db, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.NO_ANSWER });
              }
            });
          } catch (err) {
            console.error("Failed to write document.queried audit row (meta):", err?.message);
          }
        });
        return send(200, { success: true, data });
      } catch (err) {
        // A broken meta-query must not 500 a cheap question — fall through to
        // the normal retrieval+model path rather than failing the request.
        console.error("Meta-question router failed, falling through:", err?.message);
      }
    }

    // ---- 0.4 deterministic history router (Team A, no model, DB only) ------
    // "do we have more invoices or more service tickets", "who's overdue for maintenance", "when did we last service the
    // unit at <address>", "who installed the Mitsubishi at <address>", "last 3 visits at Zimmerman's": date arithmetic and
    // counts over the shop's own records, answered with a citation per fact (deterministicRouter.js). null = not
    // confident -> the normal chain (fast path, lookups, analytics, agent, retrieval) carries on unchanged.
    if (detIntent) {
      let detData = null;
      try {
        detData = await timer.time("deterministic", () =>
          withTenant(ctxArg, (db) => withCitations(db, runDeterministic(db, detIntent, { today: todayResolved }))) // TEAM C
        );
      } catch (err) {
        console.error("Deterministic router failed, falling through:", err?.message);
      }
      console.log(JSON.stringify({ route: "ask", det_route: detIntent.route, det_kind: detIntent.kind ?? null, det_hit: Boolean(detData) }));
      if (detData) {
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, (db) => db.logAction({
              action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
              changes: { question_hash: hashQuestion(question), documents: [...new Set((detData.sources ?? []).map((x) => x.documentId))], passages: 0, deterministic: detIntent.route },
            }));
          } catch (err) {
            console.error("Failed to write document.queried audit row (deterministic):", err?.message);
          }
        });
        return send(200, { success: true, data: detData });
      }
    }

    // ---- 0.5 fast-path pre-router (no model, DB only) ----------------------
    // Distinct from the meta-router above: meta answers deterministic
    // inventory questions ("how many documents"); this answers a specific
    // field lookup ("what's the serial on the unit at 3247 Elm") straight from
    // `extractions`, with the same citation contract the model path enforces
    // (see fastPath.js buildFieldAnswer/buildWarrantyAnswer). Cheap to run and
    // cheap to be wrong about deciding NOT to answer, so it is tried whenever
    // classification found an intent, and any failure — DB error, ambiguous
    // subject, no value on file — falls through to retrieval+model rather than
    // ever guessing or 500ing. Not cached (see askCache.js's shouldCache — a
    // fast answer is already ~0.3s, caching it buys nothing) but still
    // audit-logged, same as every other answer this endpoint gives.
    if (fastPathIntent) {
      let fastData = null;
      try {
        fastData = await timer.time("fast", () =>
          withTenant(ctxArg, (db) => withCitations(db, runFastPath(db, fastPathIntent, { today: todayResolved }))) // TEAM C
        );
      } catch (err) {
        console.error("Fast path failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask",
        fast_intent: fastPathIntent.intent,
        fast_hit: Boolean(fastData),
      }));
      if (fastData) {
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, (db) => db.logAction({
              action: "document.queried",
              resource_type: "question",
              clerk_user_id: auth.userId,
              changes: {
                question_hash: hashQuestion(question),
                documents: [...new Set((fastData.sources ?? []).map((s) => s.documentId))],
                passages: 0,
                fast: true,
              },
            }));
          } catch (err) {
            console.error("Failed to write document.queried audit row (fast path):", err?.message);
          }
        });
        return send(200, { success: true, data: fastData, fast: true });
      }
      // fastData is null: DB found nothing certain enough. Retrieval was never
      // started above (retrievalPromise is null for a fast-path candidate), so
      // run it now, inline — identical fallback shape to the meta-router's own.
    }

    // ---- 0.6 contact-lookup pre-router (no model, DB only) -----------------
    // "what's the phone number on file for donna thornton" — answered
    // straight from the customer's own entity row (data->>'phone' etc.), no
    // document to cite, no model call — see contactLookup.js's own doc
    // comment. Never a model call: 'contact-lookup' is not in
    // usage.js's COUNTABLE_ASK_SOURCES, so nothing here ever touches
    // incrementAsksThisMonth.
    if (contactLookupIntent) {
      let contactData = null;
      try {
        contactData = await timer.time("contact", () =>
          withTenant(ctxArg, (db) => withCitations(db, runContactLookup(db, question, { overlay, today: todayResolved }))) // TEAM C
        );
      } catch (err) {
        console.error("Contact lookup failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask",
        contact_lookup_field: contactLookupIntent.field,
        contact_lookup_hit: Boolean(contactData),
      }));
      if (contactData) {
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, async (db) => {
              await db.logAction({
                action: "document.queried",
                resource_type: "question",
                clerk_user_id: auth.userId,
                changes: {
                  question_hash: hashQuestion(question),
                  documents: [],
                  passages: 0,
                  contactLookup: true,
                },
              });
              // Miss loop: more than one customer matched the name — the
              // dispatcher got a "which one did you mean" instead of a value
              // (candidateCount, contactLookup.js's buildAmbiguousContactAnswer).
              if ((contactData.candidateCount ?? 1) > 1) {
                await insertAskMiss(db, {
                  question, questionNormalized: normalizedForAnalytics,
                  outcome: MISS_OUTCOMES.CONTACT_AMBIGUOUS,
                });
              }
            });
          } catch (err) {
            console.error("Failed to write document.queried audit row (contact lookup):", err?.message);
          }
        });
        return send(200, { success: true, data: contactData });
      }
      // contactData is null: no customer matched the name. Miss loop: zero
      // candidates is itself the miss worth reviewing, regardless of what
      // retrieval (run inline just below, same fallback shape as the
      // fast-path miss above) manages to answer instead — fired with no
      // await (true fire-and-forget: nothing else here is awaited yet
      // either), never delaying the retrieval fallback.
      recordAskMiss(ctxArg, {
        question, questionNormalized: normalizedForAnalytics,
        outcome: MISS_OUTCOMES.CONTACT_ZERO,
      }).catch(() => {});
    }

    // ---- 0.62 doc-lookup pre-router (no model, DB only) --------------------
    // "do we have a maintenance agreement on file for the Bracken job" —
    // answered straight from documents/document_entity_links, no model call.
    // Never counted against the monthly model allowance: 'doc-lookup' is not
    // in usage.js's COUNTABLE_ASK_SOURCES, so nothing here ever touches
    // incrementAsksThisMonth.
    if (docLookupIntent) {
      let docData = null;
      try {
        docData = await timer.time("doclookup", () =>
          withTenant(ctxArg, (db) => withCitations(db, runDocLookup(db, question, { overlay }))) // TEAM C
        );
      } catch (err) {
        console.error("Doc lookup failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask",
        doc_lookup_type: docLookupIntent.doctype,
        doc_lookup_hit: Boolean(docData),
      }));
      if (docData) {
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, async (db) => {
              await db.logAction({
                action: "document.queried",
                resource_type: "question",
                clerk_user_id: auth.userId,
                changes: {
                  question_hash: hashQuestion(question),
                  documents: [...new Set((docData.sources ?? []).map((s) => s.documentId))],
                  passages: 0,
                  docLookup: true,
                },
              });
              if ((docData.candidateCount ?? 1) > 1) {
                await insertAskMiss(db, {
                  question, questionNormalized: normalizedForAnalytics,
                  outcome: MISS_OUTCOMES.CONTACT_AMBIGUOUS,
                });
              }
            });
          } catch (err) {
            console.error("Failed to write document.queried audit row (doc lookup):", err?.message);
          }
        });
        return send(200, { success: true, data: docData });
      }
      // docData is null: no customer/address matched, or matched but had no
      // document of that type on file — same fallback shape as contact
      // lookup's own miss above: retrieval (run inline just below) still gets
      // a shot, fire-and-forget miss logging never delays it.
      recordAskMiss(ctxArg, {
        question, questionNormalized: normalizedForAnalytics,
        outcome: MISS_OUTCOMES.DOC_LOOKUP_ZERO,
      }).catch(() => {});
    }

    // ---- 0.63 content-count pre-router (no model, DB only) -----------------
    // "how many jobs mention a capacitor" / "which customers had a coil issue on file" — a deterministic scan of
    // EVERY page of the tenant's own corpus (contentCount.js), never the agent's own top-K search_documents. Always
    // answers once the shape+term are recognized (even at zero matches: an honest "no jobs mention X" is itself the
    // answer), so this never falls through to retrieval the way contact/doc lookup do on a miss.
    if (contentCountIntent) {
      let contentData = null;
      try {
        contentData = await timer.time("contentcount", () => withTenant(ctxArg, (db) => runContentCount(db, contentCountIntent)));
      } catch (err) {
        console.error("Content-count router failed, falling through to retrieval+model:", err?.message);
      }
      console.log(JSON.stringify({
        route: "ask", content_count_scope: contentCountIntent.scope, content_count_group_by: contentCountIntent.groupBy,
        content_count_hit: Boolean(contentData),
      }));
      if (contentData) {
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, (db) => db.logAction({
              action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
              changes: { question_hash: hashQuestion(question), documents: (contentData.records ?? []).map((r) => r.documentId).filter(Boolean), passages: 0, contentCount: true },
            }));
          } catch (err) {
            console.error("Failed to write document.queried audit row (content count):", err?.message);
          }
        });
        return send(200, { success: true, data: contentData });
      }
      // contentData is null only on an unexpected error above; retrieval (run inline just below) still gets a shot.
    }

    // ---- 0.65 money gate (no model, no DB, no cache) -----------------------
    // "What's the total dollar amount of our open invoices?" — the honest
    // "not built yet" answer, always, never a fabricated dollar figure. See
    // isMoneyQuestion/moneyFallbackAnswer (analytics.js) for why this can
    // never produce "$0.00 across N documents." again. Not cached (nothing
    // here should ever be served back stale once financials ships) and not
    // counted against the monthly model allowance (no model call was made).
    if (moneyQuestion) {
      // FINANCIALS hook: when M3-config/22 exists AND this tenant has financial rows, answer from real data
      // (deterministic SQL first, then the Donovan agent over the `financials` view); otherwise `fin.hasData`
      // is false and everything below is exactly the old honest refusal.
      const fin = await timer.time("financials", () => answerMoneyQuestion({ withTenant, ctxArg, question, today: todayResolved }));
      if (fin.handled) {
        send(200, { success: true, data: fin.data });
        await timer.time("bookkeeping", () =>
          withTenant(ctxArg, (db) => db.logAction({
            action: "document.queried", resource_type: "question", clerk_user_id: auth.userId,
            changes: { question_hash: hashQuestion(question), documents: [...new Set((fin.data.sources ?? []).map((x) => x.documentId))], passages: 0, financials: fin.intent },
          })).catch((err) => console.error("Failed to write document.queried audit row (financials):", err?.message))
        );
        return;
      }
      if (fin.hasData && (await tryAgent())) return;
      const data = fin.hasData ? moneyNoMatchAnswer() : moneyFallbackAnswer();
      send(200, { success: true, data });
      await timer.time("bookkeeping", () =>
        withTenant(ctxArg, async (db) => {
          await db.logAction({
            action: "document.queried",
            resource_type: "question",
            clerk_user_id: auth.userId,
            changes: { question_hash: hashQuestion(question), documents: [], passages: 0, money: true },
          });
          await insertAskMiss(db, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.MONEY_FALLBACK });
        }).catch((err) => console.error("Failed to write document.queried audit row (money):", err?.message))
      );
      return;
    }

    // ---- 0.7 analytics pre-router (ONE Haiku tool-use call, before retrieval) --
    // "how many customers in Arizona", "list customers in Gilbert", "which
    // customers have Trane units" — counting/grouping/listing questions that
    // otherwise have no path (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md). The
    // model gets exactly one tool-use call with a strict, closed-vocabulary
    // schema (api/_lib/analytics.js's ANALYTICS_TOOL) and NEVER writes SQL or
    // free prose; the answer text itself is composed deterministically in code
    // from the query results, same "no second model call" contract the
    // meta-router and fast path both already keep. A plan the model returns
    // that doesn't fit the vocabulary, or that matches no data the executor
    // can act on, falls through to retrieval+model exactly like a fast-path
    // miss — see runAnalyticsQuestion's own doc comment.
    if (analyticsCandidate) {
      let analyticsResult = null;
      try {
        // The one real model call this branch can make must respect the same
        // daily spend budget the main retrieval+model path enforces — already
        // in flight (fired concurrently with the gate check above), just
        // consulted here instead of after retrieval.
        await budgetPromise;
        // No `questionHash` passed through: runAnalyticsQuestion computes its
        // own namespaced hashes (api/_lib/analytics.js's analyticsQuestionHash/
        // analyticsPlanHash) so an analytics cache row can never collide with
        // — or be shadowed by — a retrieval-cached row for the same question
        // text (2026-09-21 reviewer fix, handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md).
        analyticsResult = await timer.time("analytics_plan", () =>
          runAnalyticsQuestion({ withTenant, ctxArg, question, today: todayResolved, overlay, noCache: Boolean(scorecardCall) })
        );
      } catch (err) {
        // A tenant already over its daily model budget must not spend a
        // retrieval round trip finding that out a second time right below —
        // let the outer handler's own ModelBudgetExceededError branch answer
        // this exactly once, the same clean 429 the main model call gets.
        if (err?.name === "ModelBudgetExceededError") throw err;
        console.error("Analytics path failed, falling through to retrieval+model:", err?.message);
      }
      console.log(
        JSON.stringify({
          route: "ask",
          analytics_candidate: true,
          analytics_hit: Boolean(analyticsResult?.handled),
          analytics_cache_hit: Boolean(analyticsResult?.cacheHit),
        })
      );
      if (analyticsResult?.handled) {
        // An honest analytics fallback (maintenance / unsupported condition / cross-doc) gets one
        // shot at the agent first. The money gate is deliberately left alone (financials phase).
        if (analyticsResult.missOutcome && analyticsResult.missOutcome !== MISS_OUTCOMES.MONEY_FALLBACK && (await tryAgent())) return;
        const data = analyticsResult.cacheHit ? { ...analyticsResult.data, cached: true } : analyticsResult.data;
        send(200, { success: true, data });
        await timer.time("bookkeeping", async () => {
          try {
            await withTenant(ctxArg, async (db) => {
              try {
                await db.logAction({
                  action: "document.queried",
                  resource_type: "question",
                  clerk_user_id: auth.userId,
                  changes: {
                    question_hash: hashQuestion(question),
                    documents: [],
                    passages: 0,
                    analytics: true,
                    cached: analyticsResult.cacheHit,
                  },
                });
              } catch (err) {
                console.error("Failed to write document.queried audit row (analytics):", err?.message);
              }
              // Miss loop: this "handled" answer is actually an honest
              // fallback (money/maintenance/"can't filter by X yet"), not a
              // real count/list — runAnalyticsQuestion (routes/analytics.js)
              // marks these with missOutcome; a genuine analytics answer
              // never sets it.
              if (analyticsResult.missOutcome) {
                await insertAskMiss(db, {
                  question, questionNormalized: normalizedForAnalytics,
                  outcome: analyticsResult.missOutcome,
                  detectedConditions: detectedConditions(normalizedForAnalytics),
                  plan: analyticsResult.missMeta?.plan ?? null,
                });
              }
              // Monthly ask allowance (owner decision, 2026-09-21): counts iff
              // the one Haiku planner call actually ran (modelCalled — see
              // routes/analytics.js's runAnalyticsQuestion doc comment). A
              // Tier-1 cache hit answers before that call is ever made, so
              // it's free, same as the retrieval+model path's own cache hit.
              if (isCountableAskSource(analyticsResult.modelCalled ? "analytics-model" : "analytics-cache")) {
                await incrementAsksThisMonth(db);
              }
              // Cache write — same corpus_stamp mechanism askCache.js already
              // gives the retrieval+model path (design point 3: "cache via
              // askCache with corpus_stamp"), but under analytics' OWN
              // namespaced hashes, never the shared `questionHash` above (see
              // runAnalyticsQuestion's doc comment). Two rows on a fresh
              // answer — Tier 1 (this exact question text) and Tier 2 (this
              // exact plan, reusable by a differently-worded question that
              // resolves to it) — a cache hit above already reused a prior
              // write, so `writes` is empty and this loop is a no-op.
              if (!analyticsResult.cacheHit && ASK_CACHE_ENABLED && shouldCache(data.kind, 0, 0)) {
                for (const w of analyticsResult.writes ?? []) {
                  if (!w.corpusStamp) continue;
                  await db.raw("SAVEPOINT analytics_cache_upsert", []);
                  try {
                    await upsertCacheEntry(db, {
                      questionHash: w.questionHash, corpusStamp: w.corpusStamp, today: todayResolved, answer: data,
                    });
                    await db.raw("RELEASE SAVEPOINT analytics_cache_upsert", []);
                  } catch (err) {
                    console.error("Failed to upsert analytics cache row:", err?.message);
                    await db.raw("ROLLBACK TO SAVEPOINT analytics_cache_upsert", []).catch(() => {});
                  }
                }
              }
            });
          } catch (err) {
            console.error("Analytics bookkeeping transaction failed:", err?.message);
          }
        });
        return;
      }
      // Not handled (invalid plan, no matching data, or an error): retrieval
      // was never started above (retrievalPromise is null for an analytics
      // candidate), so run it now, inline — identical fallback shape to the
      // fast-path miss above. Miss loop: this fallthrough is itself worth
      // reviewing regardless of what retrieval manages next — fired with no
      // await (nothing else here is awaited yet either), never delaying the
      // retrieval fallback.
      // "Analytics plan rejected" (live miss cluster): the agent gets a shot before retrieval.
      if (await tryAgent({ budgetMs: 18_000 }) /* retrieval + model (35s) still follows on a miss: stay inside maxDuration 60 */) return;
      recordAskMiss(ctxArg, {
        question, questionNormalized: normalizedForAnalytics,
        outcome: MISS_OUTCOMES.ANALYTICS_FALLTHROUGH,
        detectedConditions: detectedConditions(normalizedForAnalytics),
      }).catch(() => {});
    }

    // ---- 1. retrieve (already in flight above unless meta, fast path, or analytics fell through) ---
    const { passages, extractions, cacheHit, cachedAnswer, corpusStamp } = retrievalPromise
      ? await retrievalPromise
      : await retrieveEvidence(ctxArg, question, customerNumber, timer, { today: todayResolved, questionHash, noCache: Boolean(scorecardCall) });

    // ---- cache hit: no retrieval was even needed above, no model call -----
    if (cacheHit) {
      const data = { ...cachedAnswer, cached: true };
      send(200, { success: true, data });
      await timer.time("bookkeeping", () =>
        withTenant(ctxArg, (db) => db.logAction({
          action: "document.queried",
          resource_type: "question",
          clerk_user_id: auth.userId,
          changes: {
            question_hash: hashQuestion(question),
            documents: [...new Set((data.sources ?? []).map((s) => s.documentId))],
            passages: 0,
            cached: true,
          },
        })).catch((err) => console.error("Failed to write document.queried audit row (cache hit):", err?.message))
      );
      return;
    }

    if (passages.length === 0 && extractions.length === 0) {
      if (await tryAgent()) return;
      // Miss loop: fired with no await — nothing else on this path is
      // awaited before the response either, and this must never delay it.
      recordAskMiss(ctxArg, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.NO_ANSWER }).catch(() => {});
      // Item 8 (100-question persona sample, 2026-09-22): a single-record
      // question ("do we have anything about a compressor replacement for
      // Thomas Mercer") that resolves to exactly one known customer/address
      // gets a specific honest zero naming them, instead of the generic
      // "Nothing in your records answers that yet" — see docLookup.js's own
      // doc comment. Only attempted for a question that already looks like a
      // single-record reference (never for an aggregate/analytics-shaped one
      // that merely happened to retrieve nothing); any failure here falls
      // back to the generic line rather than risking a wrong/500 response on
      // an already-given-up path.
      let honestZeroText = null;
      // TEAM C: what was searched, from the same transaction (documents linked to the resolved customer, or the whole library).
      let zeroCitations = null;
      try {
        zeroCitations = await withTenant(ctxArg, async (db) => {
          let cites = null;
          if (looksLikeSingleRecordReference(question)) {
            try {
              const ctx = await resolveHonestZeroContext(db, question);
              if (ctx) {
                honestZeroText = buildHonestZeroText(ctx);
                cites = await honestZeroCitations(db, ctx, { documentIdsFor: customerDocumentIds });
              }
            } catch (err) {
              console.error("Honest-zero context resolution failed, using generic no-answer:", err?.message);
            }
          }
          return cites ?? { records: [], total: 0, kind: "searched", basis: await searchedLibraryBasis(db) };
        });
      } catch (err) {
        console.error("Honest-zero context resolution failed, using generic no-answer:", err?.message);
      }
      return send(200, {
        success: true,
        data: attachCitations({
          kind: "no-answer",
          text: honestZeroText ?? "Nothing in your records answers that yet. Your documents may still be processing.",
          facts: [], sources: [], confidence: 0,
          verifiedCount: 0, unverifiedCount: 0, closest: [],
        }, zeroCitations ?? { records: [], total: 0, kind: "searched", basis: "Searched your documents; nothing matched." }),
      });
    }

    const mappedPassages = passages.map((p) => ({
      documentId: p.document_id,
      filename: p.original_filename,
      documentType: p.document_type,
      page: p.page_no,
      excerpt: String(p.excerpt ?? "").slice(0, MAX_EXCERPT),
      stage: p.stage,
    }));
    const mappedExtractions = extractions.map((x) => ({
      documentId: x.document_id,
      filename: x.original_filename,
      field: x.field_key,
      value: x.value,
      entityType: x.entity_type,
      stage: x.stage,
    }));

    // Cost cut (2026-09-20, owner decision): dedupe by (documentId, page) and
    // cap the context block to ~6K tokens — see selectPassagesForContext's
    // doc comment. `candidates` below (for the no-answer "closest" list)
    // still uses the FULL retrieved set; only what's actually SHOWN to the
    // model, and therefore what a citation may point at, is capped.
    const contextPassages = selectPassagesForContext(mappedPassages);

    // What a citation is allowed to point at: exactly the documents (and,
    // per document, the pages/fields) actually shown to the model above.
    const allowed = buildAllowed({ passages: contextPassages, extractions: mappedExtractions });

    // B1 (2026-09-19 adversarial audit): /api/ask is the single most
    // expensive call site in the codebase (Sonnet, one call per question) and
    // used to be gated only by the `ask` bucket's REQUEST-count cap above —
    // a different number from the tenant's daily model-spend budget, and the
    // only one of the two ever checked here. Checked AFTER retrieval (a
    // question retrieval finds nothing already short-circuits above with no
    // model call) and right before the one Anthropic call this route makes,
    // so a tenant that is over budget never pays for it. Already IN FLIGHT
    // (fired concurrently with the gate check and retrieval above) — this
    // just consults the result at the same point in the flow it always was.
    await budgetPromise;

    // Enumerations ("who all has ...", "list every ...") and repair-history questions ("has this unit had a
    // compressor replaced?") go to the agent BEFORE the retrieval model: retrieval answers from the top few
    // pages and caps a reply at 5 facts, which silently truncated a 13-customer list. Falls through to
    // retrieval when the agent cannot answer (its budget leaves room for the retrieval call inside maxDuration).
    if (isAgentFirstQuestion(question) && (await tryAgent({ budgetMs: 20_000, recordMiss: false }))) return;

    // ---- 2. ask ------------------------------------------------------------
    // Three separate blocks, not one flat prompt string, so an Anthropic
    // cache breakpoint can land after the stable ones. See answer.js's
    // "Prompt-caching split" comment for why the split falls exactly here.
    //
    //   system  -> SYSTEM_PROMPT: fixed task framing + RULES, identical on
    //              every call for every tenant.
    //   tools   -> ANSWER_TOOL: fixed schema.
    //   content -> [context block (passages+extractions), question block],
    //              IN THAT ORDER — the question block never gets a breakpoint
    //              (it's different on every single call, cached or not) so a
    //              follow-up question that retrieves the same top passages
    //              reuses the cache through the end of the context block and
    //              pays full price for only the question after it.
    //
    // planCacheBreakpoints() (api/_lib/promptCache.js, corrected 2026-09-20
    // late) decides breakpoints off the CUMULATIVE estimated prefix in
    // Anthropic's own billed order (tools -> system -> content), not each
    // block measured alone — so a context block that's individually short
    // still gets cached once the (now-large) system prompt ahead of it has
    // already cleared the model's minimum. See handoffs/COST_REPORT_2026-09-20.md's
    // "Correction" section for current measured sizes.
    const contextText = buildContextBlock({ passages: contextPassages, extractions: mappedExtractions });
    const questionText = buildQuestionBlock({
      question,
      today: todayResolved,
    });

    const { tools: cachedTools, system: cachedSystem, messageBlocks: cachedContent } = planCacheBreakpoints(
      {
        tools: [{ block: ANSWER_TOOL, breakpoint: true }],
        system: [{ block: { type: "text", text: SYSTEM_PROMPT }, breakpoint: true }],
        messageBlocks: [
          { block: { type: "text", text: contextText }, breakpoint: true },
          { block: { type: "text", text: questionText }, breakpoint: false }, // never cached — always different
        ],
      },
      ASK_MODEL
    );

    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const startedAt = Date.now();
    // Retries only 429/529/overloaded, with jitter, and never past the model
    // timeout budget — a burst of questions during a big import must not turn
    // into a wall of "try again" for the tech in the truck.
    const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
    const response = await withBackoff(() => client.messages.create({
      model: ASK_MODEL,
      // 900, not 700 (2026-09-20 late correction): the disambiguation fix
      // below (RULES + the text/facts descriptions in answer.js) means an
      // ambiguous question's answer now legitimately names other candidate
      // records or returns up to 5 per-record facts instead of refusing —
      // both cost a few more output tokens than a single-match answer. 700
      // was sized for the single-match case only; 900 keeps headroom for
      // 5 facts + a text clause naming the other matches without reintroducing
      // the unused 1500 headroom this was cut from in the first place.
      max_tokens: 900,
      // Deterministic on purpose: identical question, identical retrieved
      // evidence -> identical answer. The 2026-09-19 walkthrough saw the
      // SAME question return different dollar figures on two runs; that
      // can't happen at temperature 0.
      temperature: 0,
      system: cachedSystem,
      tools: cachedTools,
      tool_choice: { type: "tool", name: "answer" },
      messages: [{ role: "user", content: cachedContent }],
    }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
    const latencyMs = Date.now() - startedAt;
    timer.add("model", latencyMs);

    // ---- 3. enforce sourcing ------------------------------------------------
    // allowComputed defaults to false here: nothing on this endpoint's
    // evidence path is a computed value (extraction never does arithmetic —
    // see warrantyRules.js), so a model claiming basis "computed" is
    // overruled back to "printed" and held to the ordinary page/field check
    // rather than getting a free pass around it.
    const toolUse = response.content.find((b) => b.type === "tool_use");
    // candidates: what retrieval actually returned, for shapeAnswer to build
    // `closest` from IF everything gets downgraded to no-answer — see the
    // Bug 1 fix in answer.js's shapeAnswer doc comment.
    const candidates = [
      ...mappedPassages.map((p) => ({ documentId: p.documentId })),
      ...mappedExtractions.map((x) => ({ documentId: x.documentId })),
    ];
    const data = shapeAnswer(toolUse?.input, allowed, { candidates });
    // TEAM C: label the cited pages and say what the answer was selected from (a no-answer cites what was searched).
    attachRetrievalCitations(data, { passages: mappedPassages, extractions: mappedExtractions });
    // Retrieval+model shaped an honest no-answer: the agent gets one shot (its own answer is
    // counted once, and this call's usage is recorded with it).
    if (data.kind === "no-answer" && (await tryAgent({
      extraUsage: {
        inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens, cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
      },
    }))) return;

    // Retrieval caps a reply at 5 facts. When an enumeration question still ends up here (the agent
    // could not answer it) and hit that cap, never let 5 read as the whole list.
    if (data.kind === "answer" && data.facts.length >= 5 && isEnumerationQuestion(question)) {
      data.text = `${String(data.text ?? "").replace(/[.\s]+$/, "")}. These are the 5 closest matches, not necessarily every one.`;
    }

    // One structured line per call, no PII and no question text (see
    // hashQuestion's doc comment above for why questions never get logged
    // anywhere) — so Vercel logs show cache hit rates across tenants. Logged
    // (and the response sent) BEFORE the bookkeeping below runs — neither
    // needs the customer to wait on it. `timingsMs` is the same snapshot the
    // Server-Timing header below carries; see handoffs/ASK_LATENCY_2026-09-20.md.
    //
    // stop_reason/facts_raw/facts_kept (2026-09-20 late): counts only, no
    // content — stop_reason tells "genuine no-answer" apart from "the model
    // got cut off"; facts_raw vs. facts_kept is how many facts the model
    // actually cited that shapeAnswer's grounding check then dropped, which
    // is exactly the signal for whether the disambiguation-vs-no-answer
    // regression fix above is doing its job in production.
    console.log(
      JSON.stringify(
        modelCallLogLine({
          route: "ask",
          model: ASK_MODEL,
          inputTokens: response.usage?.input_tokens,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
          outputTokens: response.usage?.output_tokens,
          latencyMs,
          timingsMs: timer.snapshot(),
          stopReason: response.stop_reason,
          factsRaw: Array.isArray(toolUse?.input?.facts) ? toolUse.input.facts.length : 0,
          factsKept: data.facts.length,
        })
      )
    );

    // ---- respond FIRST, bookkeeping after (2026-09-20, handoffs/
    // ASK_LATENCY_2026-09-20.md) --------------------------------------------
    // The customer already has a correct, sourced answer at this point.
    // Recording spend and writing the audit row are real work that must
    // still happen, but neither should make the customer wait on it — this
    // sends the response now, then keeps the function alive (Vercel does not
    // freeze a serverless function until its handler's own promise settles)
    // to finish both, same non-fatal try/catch semantics as before, just run
    // together instead of one after the other after the response.
    send(200, { success: true, data });

    // ---- 4. bookkeeping (post-response) ------------------------------------
    // "Who saw this customer's document" has to be answerable, and cost
    // accounting is not request rate limiting (./_lib/rateLimit.js already
    // ran above) — both best-effort and non-fatal: a customer who already got
    // their answer must not see anything different because either write
    // failed after the fact. The question text itself is NEVER stored — see
    // hashQuestion's doc comment — only its hash, which documents were cited,
    // and how many passages were considered.
    const citedDocumentIds = [...new Set((data.sources ?? []).map((s) => s.documentId))];
    // ONE connection, sequential (2026-09-20 fix): running the three writes
    // as parallel withTenant calls exhausted the 5-client pool under Fluid
    // compute — production logged "Failed to upsert ask cache row: timeout
    // exceeded when trying to connect", so answers were never cached. The
    // response is already sent; nothing here is on the customer's clock.
    await timer.time("bookkeeping", async () => {
      try {
        await withTenant(ctxArg, async (db) => {
          try {
            await db.logAction({
              action: "document.queried",
              resource_type: "question",
              clerk_user_id: auth.userId,
              changes: {
                question_hash: hashQuestion(question),
                documents: citedDocumentIds,
                passages: passages.length,
              },
            });
          } catch (err) {
            console.error("Failed to write document.queried audit row:", err?.message);
          }
          // Miss loop: the model itself declined (shapeAnswer downgraded
          // every fact to no-answer, e.g. nothing it cited actually
          // grounded) — reuses this same connection/transaction.
          if (data.kind === "no-answer") {
            await insertAskMiss(db, { question, questionNormalized: normalizedForAnalytics, outcome: MISS_OUTCOMES.NO_ANSWER });
          }
          // Monthly ask allowance (owner decision, 2026-09-21): this branch is
          // only ever reached after the one Anthropic call above succeeded —
          // cache hits and the "no evidence" no-answer both already returned
          // earlier — so it always counts, regardless of whether shapeAnswer's
          // result kind ended up "answer" or "no-answer" (the model was still
          // reached either way; see usage.js's isCountableAskSource doc comment).
          if (isCountableAskSource("model")) await incrementAsksThisMonth(db);
          // Cache write (handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md): a cache
          // miss above means `corpusStamp` came from the SAME transaction that
          // just ran retrieval, so it is still the stamp this answer was built
          // against.
          if (ASK_CACHE_ENABLED && corpusStamp && shouldCache(data.kind, passages.length, extractions.length)) {
            // SAVEPOINT: a failed upsert must not abort the transaction and
            // silently roll back the audit row written just above.
            await db.raw("SAVEPOINT ask_cache_upsert", []);
            try {
              await upsertCacheEntry(db, { questionHash, corpusStamp, today: todayResolved, answer: data });
              await db.raw("RELEASE SAVEPOINT ask_cache_upsert", []);
            } catch (err) {
              console.error("Failed to upsert ask cache row:", err?.message);
              await db.raw("ROLLBACK TO SAVEPOINT ask_cache_upsert", []).catch(() => {});
            }
          }
        });
      } catch (err) {
        console.error("Ask bookkeeping transaction failed:", err?.message);
      }
      try {
        await recordModelCall(ctxArg, {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
        });
      } catch (err) {
        console.error("Failed to record ask usage:", err?.message);
      }
    });
  } catch (error) {
    try {
      const header = formatServerTiming(timer.snapshot());
      if (header && !res.headersSent) res.setHeader("Server-Timing", header);
    } catch { /* never let timing observability break error reporting */ }
    if (res.headersSent) {
      // Only reachable if the post-response bookkeeping above somehow threw
      // past its own per-promise .catch — the customer already has their
      // answer, so there is nothing left to send.
      console.error("ask: error after response already sent:", error?.message);
      return;
    }
    // Checked before the generic handler: handleError's own 429 branch would
    // catch this too (status 429), but with a different message and no
    // Retry-After header — every model-budget-gated endpoint should answer
    // this exact condition the same way (see rateLimit.js's
    // sendModelBudgetExceeded doc comment).
    if (error?.name === "ModelBudgetExceededError") {
      return sendModelBudgetExceeded(handleCors(res, req), error);
    }
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
