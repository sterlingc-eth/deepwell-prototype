/**
 * The answer contract, shared by /api/ask and anything else that needs to
 * produce a sourced answer.
 *
 * Two rules live here, and they are the product:
 *   1. The model may only return the `answer` tool — no free prose path.
 *   2. Every fact must cite a document the retrieval step actually returned.
 *      `shapeAnswer` drops citations to anything else and then drops facts left
 *      with no citation, so "no fact without a source" is enforced by code,
 *      not by asking the model nicely.
 */

export const ANSWER_TOOL = {
  name: "answer",
  description: "Return the answer to the user's question using only the supplied evidence.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "1–3 plain-English sentences answering the question. If the evidence doesn't support an answer, say so plainly and do not guess.",
      },
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
                  location: {
                    type: "object",
                    properties: { page: { type: "number" }, field: { type: "string" } },
                  },
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
};

const RULES = `Rules:
- Answer only from the evidence above. Every fact must cite at least one source, copying documentId exactly as given and using that passage's page number.
- Never invent a document, a date, a serial, a model number, or a price. If the evidence does not answer the question, set text to "Nothing in your records answers that." and return no facts.
- If two passages disagree, say so in text and cite both rather than picking one.
- Facts are a key/value grid: keep labels short ("Warranty", "Installed by", "Cost"). Use status "ok" for an active warranty, "warn" for one expiring within 90 days, "bad" for expired.
- text is 1–3 sentences a dispatcher would say out loud.`;

export function buildPrompt({ question, today, includeUnverified, passages, extractions, records }) {
  const head = `Today's date: ${today}`;

  if (passages) {
    const ev = passages
      .map(
        (p, i) =>
          `[${i + 1}] documentId: ${p.documentId} | page: ${p.page} | file: ${p.filename}${
            p.documentType ? ` (${p.documentType})` : ""
          }\n${p.excerpt}`
      )
      .join("\n\n");

    const facts = extractions?.length
      ? `\n\nALREADY-EXTRACTED FIELDS (verified by the pipeline; cite the documentId shown):\n` +
        extractions
          .map((x) => `- ${x.field} = ${x.value}  [documentId: ${x.documentId} | file: ${x.filename}]`)
          .join("\n")
      : "";

    return `${head}

These passages were retrieved from the customer's own documents because they match the question. They are the only evidence you have.

PASSAGES:
${ev}${facts}

QUESTION: ${question}

${RULES}`;
  }

  return `${head}
Records are ${includeUnverified ? "linked and verified" : "verified only"}.

RECORDS (JSON; each field lists the documents it came from):
${JSON.stringify(records)}

QUESTION: ${question}

${RULES}`;
}

export function shapeAnswer(raw, allowedDocs) {
  const input = raw ?? { text: "Nothing in your records answers that.", facts: [], confidence: 0 };

  const facts = (input.facts ?? [])
    .map((f) => ({
      ...f,
      sources: (f.sources ?? []).filter((s) => allowedDocs.has(s.documentId)),
    }))
    .filter((f) => f.sources.length > 0);

  return {
    kind: facts.length ? "answer" : "no-answer",
    text: facts.length ? input.text : input.text ?? "Nothing in your records answers that.",
    facts,
    sources: facts.flatMap((f) => f.sources),
    confidence: facts.length ? input.confidence ?? 0.8 : 0,
    entityId: input.entityId,
    interpretation: input.interpretation,
    verifiedCount: new Set(facts.flatMap((f) => f.sources.map((s) => s.documentId))).size,
    unverifiedCount: 0,
    closest: [],
  };
}
