import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { ANSWER_TOOL, buildPrompt, shapeAnswer } from "./_lib/answer.js";

/**
 * POST /api/ask
 * body: { question, includeUnverified?, today?, records? }
 *
 * Retrieval happens HERE, on the server, against the tenant's own rows.
 *
 * It used to happen in the browser: the client exported every answerable field
 * it held and posted the whole corpus with each question. That capped the
 * product at a few hundred entities (a 512 KB body), cost a full-corpus prompt
 * per question, and meant the answer could only be as good as whatever the
 * browser happened to have in memory.
 *
 * Now the question selects its own evidence — full-text and identifier search
 * over document_pages, plus any already-extracted fields that mention the same
 * identifiers — and only those passages go into the prompt. Cost stops scaling
 * with corpus size, and the model is handed the pages rather than a summary of
 * them, so a fact it cites is a fact on a page.
 *
 * `records` is still accepted: when the tenant has no ingested pages yet (a
 * fresh account, or the demo data), the old client-supplied path is used so the
 * app keeps answering instead of going silent.
 */
export const config = { api: { bodyParser: { sizeLimit: "512kb" } } };

const MAX_QUESTION = 2000;
const MAX_RECORDS = 400;
const MAX_PASSAGES = 12;
const MAX_EXCERPT = 1200;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  try {
    const { question, records, includeUnverified = false, today } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }
    if (question.length > MAX_QUESTION) {
      return res.status(400).json({ error: "Question is too long" });
    }
    if (records != null && (!Array.isArray(records) || records.length > MAX_RECORDS)) {
      return res.status(400).json({ error: "Too many records in one request" });
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
      // A retrieval failure must not take the endpoint down; fall through to
      // the client-supplied records so the app still answers.
      console.error("Retrieval failed, falling back to client records:", err?.message);
    }

    const usingPassages = passages.length > 0;
    if (!usingPassages && !Array.isArray(records)) {
      return handleCors(res, req).status(200).json({
        success: true,
        data: {
          kind: "no-answer",
          text: "Nothing in your records answers that.",
          facts: [], sources: [], confidence: 0,
          verifiedCount: 0, unverifiedCount: 0, closest: [],
        },
      });
    }

    // Only documents the retrieval step actually returned may be cited.
    const allowedDocs = new Set();
    if (usingPassages) {
      for (const p of passages) allowedDocs.add(p.document_id);
      for (const x of extractions) allowedDocs.add(x.document_id);
    } else {
      for (const r of records) {
        for (const f of Object.values(r.fields ?? {})) {
          for (const s of f.sources ?? []) allowedDocs.add(s.documentId);
        }
      }
    }

    // ---- 2. ask ------------------------------------------------------------
    const client = new Anthropic({ apiKey: getApiKey() });
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
            includeUnverified,
            passages: usingPassages
              ? passages.map((p) => ({
                  documentId: p.document_id,
                  filename: p.original_filename,
                  documentType: p.document_type,
                  page: p.page_no,
                  excerpt: String(p.excerpt ?? "").slice(0, MAX_EXCERPT),
                }))
              : null,
            extractions: usingPassages
              ? extractions.map((x) => ({
                  documentId: x.document_id,
                  filename: x.original_filename,
                  field: x.field_key,
                  value: x.value,
                  entityType: x.entity_type,
                }))
              : null,
            records: usingPassages ? null : records,
          }),
        },
      ],
    });

    // ---- 3. enforce sourcing ----------------------------------------------
    const toolUse = response.content.find((b) => b.type === "tool_use");
    const data = shapeAnswer(toolUse?.input, allowedDocs);

    return handleCors(res, req).status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, req);
  }
}
