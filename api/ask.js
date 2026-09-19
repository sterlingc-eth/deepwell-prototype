import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { limit, assertModelBudget, sendModelBudgetExceeded } from "./_lib/rateLimit.js";
import { withTenant } from "./_lib/recordsStore.js";
import {
  ANSWER_TOOL,
  buildAllowed,
  shapeAnswer,
  SYSTEM_PROMPT,
  buildContextBlock,
  buildQuestionBlock,
} from "./_lib/answer.js";
import { withCache, modelCallLogLine } from "./_lib/promptCache.js";
import { recordModelCall } from "./_lib/usage.js";
import { documentTypeLabel } from "./_lib/documentTypes.js";

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
export const ASK_MODEL = "claude-sonnet-4-5";

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
function normalizeQuestion(q) {
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

export function classifyMetaQuestion(question) {
  const q = normalizeQuestion(question);
  if (!q) return null;
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
  const { rows } = await db.raw(
    `SELECT id FROM documents WHERE ${filter} ORDER BY created_at DESC LIMIT $1`,
    [META_LIST_LIMIT]
  );
  const sources = rows.map((r) => ({ documentId: r.id, location: {} }));
  const noun = unverifiedOnly ? "unverified document" : "document";
  const text = total > sources.length
    ? `${total} ${noun}s — showing the first ${sources.length}.`
    : `${total} ${noun}${total === 1 ? "" : "s"}.`;
  return { kind: "answer", text, facts: [], sources, confidence: 1, verifiedCount: sources.length, unverifiedCount: 0, closest: [] };
}

async function listCustomers(db) {
  const total = (await db.raw(
    `SELECT COUNT(*)::int AS n FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}`, []
  )).rows[0].n;
  const { rows } = await db.raw(
    `SELECT data->>'customer_name' AS name, data->>'service_address' AS address
       FROM entities WHERE entity_type = 'customer' AND ${TENANT_SQL}
      ORDER BY updated_at DESC LIMIT $1`,
    [META_LIST_LIMIT]
  );
  const facts = rows.map((r) => ({ label: r.name || "Unnamed customer", value: r.address || "—", sources: [] }));
  const text = total > facts.length
    ? `${total} customers — showing the first ${facts.length}.`
    : `${total} customer${total === 1 ? "" : "s"}.`;
  return { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] };
}

async function listDocumentTypes(db) {
  const { rows } = await db.raw(
    `SELECT document_type, COUNT(*)::int AS n FROM documents WHERE ${TENANT_SQL}
      GROUP BY document_type ORDER BY n DESC`,
    []
  );
  const facts = rows.map((r) => ({ label: documentTypeLabel(r.document_type), value: String(r.n), sources: [] }));
  const text = facts.length ? `${facts.length} document type${facts.length === 1 ? "" : "s"} in use.` : "No documents yet.";
  return { kind: "answer", text, facts, sources: [], confidence: 1, verifiedCount: facts.length, unverifiedCount: 0, closest: [] };
}

const IMPERATIVE_TEXT = {
  delete: "To delete a document: go to Browse → Documents, select it, then choose Delete selected.",
  upload: "To upload a document: go to Intake and drop your files there.",
};

async function runMetaQuestion(db, meta) {
  if (meta.kind === "imperative") {
    return { kind: "no-answer", text: IMPERATIVE_TEXT[meta.action], facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] };
  }
  if (meta.kind === "count") {
    const n = await countFor(db, meta.target);
    const label = COUNT_LABEL[meta.target];
    return {
      kind: "answer",
      text: `You have ${n} ${label}.`,
      facts: [{ label: label[0].toUpperCase() + label.slice(1), value: String(n), sources: [] }],
      sources: [], confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [],
    };
  }
  if (meta.target === "unverified-documents") return listDocuments(db, true);
  if (meta.target === "documents") return listDocuments(db, false);
  if (meta.target === "customers") return listCustomers(db);
  return listDocumentTypes(db);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuthOrKey(req);
    assertScope(auth, "ask");
  } catch (err) {
    return denyAuth(res, err);
  }

  // The single most rate-limit-relevant route in the codebase: every call is
  // a model call. 429 is already written when this returns false.
  if (!(await limit(req, res, auth, "ask"))) return;

  try {
    const { question, today } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }
    if (question.length > MAX_QUESTION) {
      return res.status(400).json({ error: "Question is too long" });
    }

    // ---- 0. meta-question pre-router (no model, no retrieval) --------------
    const meta = classifyMetaQuestion(question);
    if (meta) {
      try {
        const data = await withTenant(
          { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
          (db) => runMetaQuestion(db, meta)
        );
        try {
          await withTenant(
            { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
            (db) => db.logAction({
              action: "document.queried",
              resource_type: "question",
              clerk_user_id: auth.userId,
              changes: {
                question_hash: hashQuestion(question),
                documents: [...new Set(data.sources.map((s) => s.documentId))],
                passages: 0,
              },
            })
          );
        } catch (err) {
          console.error("Failed to write document.queried audit row (meta):", err?.message);
        }
        return handleCors(res, req).status(200).json({ success: true, data });
      } catch (err) {
        // A broken meta-query must not 500 a cheap question — fall through to
        // the normal retrieval+model path rather than failing the request.
        console.error("Meta-question router failed, falling through:", err?.message);
      }
    }

    // ---- 1. retrieve -------------------------------------------------------
    let passages = [];
    let extractions = [];
    try {
      const found = await withTenant(
        { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
        async (db) => ({
          passages: await db.searchPassages(question, MAX_PASSAGES),
          extractions: await db.searchExtractions(question),
        })
      );
      passages = found.passages;
      extractions = found.extractions;
    } catch (err) {
      // A retrieval failure must not take the endpoint down. It also must
      // NOT be papered over with a second, untrustworthy evidence source —
      // see the file header. Log it and fall through to the same honest
      // no-answer that "nothing matched" gets: a customer can't act any
      // differently on the difference between "we found nothing" and "we
      // couldn't check", and guessing is worse than either.
      console.error("Retrieval failed:", err?.message);
    }

    if (passages.length === 0 && extractions.length === 0) {
      return handleCors(res, req).status(200).json({
        success: true,
        data: {
          kind: "no-answer",
          text: "Nothing in your records answers that yet. Your documents may still be processing.",
          facts: [], sources: [], confidence: 0,
          verifiedCount: 0, unverifiedCount: 0, closest: [],
        },
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

    // What a citation is allowed to point at: exactly the documents (and,
    // per document, the pages/fields) retrieval returned above.
    const allowed = buildAllowed({ passages: mappedPassages, extractions: mappedExtractions });

    // B1 (2026-09-19 adversarial audit): /api/ask is the single most
    // expensive call site in the codebase (Sonnet, one call per question) and
    // used to be gated only by the `ask` bucket's REQUEST-count cap above —
    // a different number from the tenant's daily model-spend budget, and the
    // only one of the two ever checked here. Checked AFTER retrieval (a
    // question retrieval finds nothing already short-circuits above with no
    // model call) and right before the one Anthropic call this route makes,
    // so a tenant that is over budget never pays for it.
    await assertModelBudget({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId });

    // ---- 2. ask ------------------------------------------------------------
    // Three separate blocks, not one flat prompt string, so an Anthropic
    // cache breakpoint can land after the stable ones. See answer.js's
    // "Prompt-caching split" comment for why the split falls exactly here.
    //
    //   system  -> SYSTEM_PROMPT: fixed task framing + RULES, identical on
    //              every call for every tenant.
    //   tools   -> ANSWER_TOOL: fixed schema.
    //   content -> [context block (passages+extractions), question block],
    //              IN THAT ORDER, with cache_control only on the context
    //              block: a follow-up question that retrieves the same top
    //              passages reuses the cache through the end of that block
    //              and pays full price for only the (always-different)
    //              question after it.
    //
    // withCache() (api/_lib/promptCache.js) only attaches cache_control when
    // a block is actually long enough for Anthropic to cache (Sonnet: 1024
    // tokens, ~4096 chars) — a too-short SYSTEM_PROMPT or ANSWER_TOOL is left
    // alone rather than wasting one of the 4-per-request breakpoints. See
    // handoffs/HANDOFF-B.md for current measured sizes.
    const contextText = buildContextBlock({ passages: mappedPassages, extractions: mappedExtractions });
    const questionText = buildQuestionBlock({
      question,
      today: today ?? new Date().toISOString().slice(0, 10),
    });

    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const startedAt = Date.now();
    // Retries only 429/529/overloaded, with jitter, and never past the model
    // timeout budget — a burst of questions during a big import must not turn
    // into a wall of "try again" for the tech in the truck.
    const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
    const response = await withBackoff(() => client.messages.create({
      model: ASK_MODEL,
      max_tokens: 1500,
      // Deterministic on purpose: identical question, identical retrieved
      // evidence -> identical answer. The 2026-09-19 walkthrough saw the
      // SAME question return different dollar figures on two runs; that
      // can't happen at temperature 0.
      temperature: 0,
      system: [withCache({ type: "text", text: SYSTEM_PROMPT }, ASK_MODEL)],
      tools: [withCache(ANSWER_TOOL, ASK_MODEL)],
      tool_choice: { type: "tool", name: "answer" },
      messages: [
        {
          role: "user",
          content: [
            withCache({ type: "text", text: contextText }, ASK_MODEL),
            { type: "text", text: questionText }, // never cached — see above
          ],
        },
      ],
    }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
    const latencyMs = Date.now() - startedAt;

    // One structured line per call, no PII and no question text (see
    // hashQuestion's doc comment above for why questions never get logged
    // anywhere) — so Vercel logs show cache hit rates across tenants.
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
        })
      )
    );

    // Cost accounting, not request rate limiting (./_lib/rateLimit.js already
    // ran above) — best-effort and never fatal: recordModelCall already
    // swallows its own errors (see usage.js), and this call is wrapped again
    // for the same reason the audit write below is: a customer who got a
    // correct, sourced answer must not see a 500 because bookkeeping failed.
    try {
      await recordModelCall(
        { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
        {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
        }
      );
    } catch (err) {
      console.error("Failed to record ask usage:", err?.message);
    }

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

    // ---- 4. audit -----------------------------------------------------------
    // "Who saw this customer's document" has to be answerable, and until now
    // nothing wrote a row here at all: a question could cite any document in
    // the tenant's corpus and audit_log would never know it happened. One row
    // per question, scoped to the tenant by the same withTenant() used for
    // retrieval above. The question text itself is NEVER stored — see
    // hashQuestion's doc comment — only its hash, which documents were cited,
    // and how many passages were considered.
    //
    // Best-effort and non-fatal: a customer who asked a question and got a
    // correct, sourced answer must not see a 500 because the audit write
    // failed after the fact.
    try {
      const citedDocumentIds = [...new Set((data.sources ?? []).map((s) => s.documentId))];
      await withTenant(
        { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
        (db) =>
          db.logAction({
            action: "document.queried",
            resource_type: "question",
            clerk_user_id: auth.userId,
            changes: {
              question_hash: hashQuestion(question),
              documents: citedDocumentIds,
              passages: passages.length,
            },
          })
      );
    } catch (err) {
      console.error("Failed to write document.queried audit row:", err?.message);
    }

    return handleCors(res, req).status(200).json({ success: true, data });
  } catch (error) {
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
