import Anthropic from "@anthropic-ai/sdk";
import { handleCors, handleError, getApiKey } from "./_lib/claude.js";
import { requireAuth, denyAuth } from "./_lib/auth.js";

/**
 * POST /api/ask
 * body: { question, records: ExportedRecord[], includeUnverified, today }
 *
 * `records` is the client's export of answerable entity fields, each with the
 * document sources behind it. Claude is forced (via tool_choice) to return the
 * same Answer shape the mock produces, and may only cite document ids that
 * appear in `records`. Anything else is dropped before the response goes back,
 * so "no fact without a source" holds on this path too.
 *
 * This is the seam the prototype's mock answerService swaps out for; set
 * VITE_ANSWER_PROVIDER=claude in the frontend to use it.
 */
// Vercel's default body limit is 4.5MB; that is far too much to forward into a
// model prompt. Cap the request and the payload we actually use.
export const config = { api: { bodyParser: { sizeLimit: '512kb' } } };

const MAX_QUESTION = 2000;
const MAX_RECORDS = 400;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  void auth;


  try {
    const { question, records, includeUnverified = false, today } = req.body ?? {};
    if (!question || !Array.isArray(records)) {
      return res.status(400).json({ error: "Missing question or records" });
    }
    if (typeof question !== "string" || question.length > MAX_QUESTION) {
      return res.status(400).json({ error: "Question is too long" });
    }
    if (records.length > MAX_RECORDS) {
      return res.status(400).json({ error: "Too many records in one request" });
    }

    const allowedDocs = new Set();
    for (const r of records) for (const f of Object.values(r.fields ?? {})) for (const s of f.sources ?? []) allowedDocs.add(s.documentId);

    const client = new Anthropic({ apiKey: getApiKey() });
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      tools: [
        {
          name: "answer",
          description: "Return the answer to the user's question using only the supplied records.",
          input_schema: {
            type: "object",
            properties: {
              text: { type: "string", description: "1–3 plain-English sentences answering the question. If the records don't support an answer, say so plainly and do not guess." },
              facts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                    status: { type: "string", enum: ["ok", "warn", "bad", "info", "muted"] },
                    entityId: { type: "string" },
                    sources: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          documentId: { type: "string" },
                          location: { type: "object", properties: { page: { type: "number" }, field: { type: "string" } } },
                          excerpt: { type: "string" },
                        },
                        required: ["documentId", "location"],
                      },
                    },
                  },
                  required: ["label", "value", "sources"],
                },
              },
              confidence: { type: "number" },
              entityId: { type: "string" },
              interpretation: { type: "string" },
            },
            required: ["text", "facts", "confidence"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "answer" },
      messages: [
        {
          role: "user",
          content: `Today's date: ${today ?? new Date().toISOString().slice(0, 10)}
Records are ${includeUnverified ? "linked and verified" : "verified only"}.

RECORDS (JSON; each field lists the documents it came from):
${JSON.stringify(records)}

QUESTION: ${question}

Rules:
- Answer only from RECORDS. Every fact must cite at least one source copied exactly from the records (documentId + location).
- Never invent a document, a date, a serial, or a price. If the records do not answer the question, say "Nothing in your records answers that." and return no facts.
- Facts are a key/value grid: keep labels short ("Warranty", "Installed by", "Cost"). Use status "ok" for active warranty, "warn" for expiring within 90 days, "bad" for expired.
- text is 1–3 sentences a dispatcher would say out loud.`,
        },
      ],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    const raw = toolUse?.input ?? { text: "Nothing in your records answers that.", facts: [], confidence: 0 };

    // Enforce sourcing server-side: drop citations to unknown docs, then facts with no sources.
    const facts = (raw.facts ?? [])
      .map((f) => ({ ...f, sources: (f.sources ?? []).filter((s) => allowedDocs.has(s.documentId)) }))
      .filter((f) => f.sources.length > 0);

    return handleCors(res, req).status(200).json({
      success: true,
      data: {
        kind: facts.length ? "answer" : "no-answer",
        text: raw.text,
        facts,
        sources: facts.flatMap((f) => f.sources),
        confidence: facts.length ? raw.confidence ?? 0.8 : 0,
        entityId: raw.entityId,
        interpretation: raw.interpretation,
        verifiedCount: new Set(facts.flatMap((f) => f.sources.map((s) => s.documentId))).size,
        unverifiedCount: 0,
        closest: [],
      },
    });
  } catch (error) {
    return handleError(res, error, req);
  }
}
