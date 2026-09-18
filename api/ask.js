import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { limit } from "./_lib/rateLimit.js";
import { withTenant } from "./_lib/recordsStore.js";
import { ANSWER_TOOL, buildPrompt, buildAllowed, shapeAnswer } from "./_lib/answer.js";

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
    }));
    const mappedExtractions = extractions.map((x) => ({
      documentId: x.document_id,
      filename: x.original_filename,
      field: x.field_key,
      value: x.value,
      entityType: x.entity_type,
    }));

    // What a citation is allowed to point at: exactly the documents (and,
    // per document, the pages/fields) retrieval returned above.
    const allowed = buildAllowed({ passages: mappedPassages, extractions: mappedExtractions });

    // ---- 2. ask ------------------------------------------------------------
    const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      tools: [ANSWER_TOOL],
      tool_choice: { type: "tool", name: "answer" },
      messages: [
        {
          role: "user",
          content: buildPrompt({
            question,
            today: today ?? new Date().toISOString().slice(0, 10),
            passages: mappedPassages,
            extractions: mappedExtractions,
          }),
        },
      ],
    });

    // ---- 3. enforce sourcing ------------------------------------------------
    // allowComputed defaults to false here: nothing on this endpoint's
    // evidence path is a computed value (extraction never does arithmetic —
    // see warrantyRules.js), so a model claiming basis "computed" is
    // overruled back to "printed" and held to the ordinary page/field check
    // rather than getting a free pass around it.
    const toolUse = response.content.find((b) => b.type === "tool_use");
    const data = shapeAnswer(toolUse?.input, allowed);

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
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
