/**
 * The answer contract, shared by /api/ask and anything else that needs to
 * produce a sourced answer.
 *
 * Three rules live here, and they are the product:
 *
 *   1. The model may only return the `answer` tool — no free prose path.
 *
 *   2. Every fact must cite a page (or an already-extracted field) that the
 *      retrieval step actually returned FOR THAT EXACT DOCUMENT — not merely
 *      a document that happens to be in the allowed set. Checking only
 *      `allowedDocs.has(documentId)` let a fact through with a real,
 *      retrieved document and a fabricated or empty `location`: the document
 *      genuinely was evidence, but the specific claim ("page 4 says X") was
 *      never checked, so it could be invented anyway. `buildAllowed` /
 *      `shapeAnswer` below track pages and extracted-field names per
 *      document and reject a citation that doesn't match one exactly.
 *
 *   3. A fact whose value was produced by arithmetic (not read off a page)
 *      says so via `basis: "computed"`, so nothing downstream can render a
 *      calculated date as though a document stated it. Nothing that reaches
 *      this file today is computed — extraction is forbidden from doing
 *      arithmetic itself (see warrantyRules.js) — so `shapeAnswer` only
 *      trusts a model's "computed" claim when the caller opts in via
 *      `allowComputed`. /api/ask never passes that, so a model can't dodge
 *      rule 2 just by labelling a fabrication "computed"; a future
 *      computed-answer endpoint (e.g. for warranty dates) can pass
 *      `allowComputed: true` once it supplies real computed evidence.
 *
 * `shapeAnswer` enforces all of this in code, not by asking the model
 * nicely: it drops any source that doesn't check out and then drops facts
 * left with no source at all.
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
            basis: {
              type: "string",
              enum: ["printed", "computed"],
              description:
                "'printed' (default): the value is written on the cited page or was already extracted from one. " +
                "'computed': you personally did arithmetic on other evidence to produce this value (e.g. adding a " +
                "term length to an install date). Use 'computed' ONLY for a value you calculated; a value you simply " +
                "read, even one that required combining two sentences, is still 'printed'.",
            },
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
- Answer only from the evidence above. Every fact must cite at least one source, copying documentId exactly as given.
- For a passage, location must be { "page": <the page number shown for that passage> } — the exact number, never a guess or a nearby page.
- For an already-extracted field, location must be { "field": "<field name exactly as shown>" } — those aren't tied to a single page here, so do not invent a page number for one.
- Never invent a document, a page, a date, a serial, a model number, or a price. If the evidence does not answer the question, set text to "Nothing in your records answers that." and return no facts.
- If two passages disagree, say so in text and cite both rather than picking one.
- Facts are a key/value grid: keep labels short ("Warranty", "Installed by", "Cost"). Use status "ok" for an active warranty, "warn" for one expiring within 90 days, "bad" for expired.
- basis is "printed" unless you personally computed the value yourself — see the basis field description.
- text is 1–3 sentences a dispatcher would say out loud.`;

/**
 * ---------------------------------------------------------------------------
 * Prompt-caching split (added for /api/ask cost accounting — see
 * scripts/verify-caching.mjs and handoffs/HANDOFF-B.md).
 *
 * buildPrompt() above stays exactly as it was: it's still exercised directly
 * by scripts/verify-answer.mjs and scripts/verify-retrieval.mjs, and nothing
 * here changes what it returns.
 *
 * /api/ask itself no longer sends one flat user-message string, because a
 * flat string can't have an Anthropic cache breakpoint in the middle of it.
 * Instead it sends three pieces, ordered so a cache breakpoint after each of
 * the first two can be reused by the next call:
 *
 *   1. SYSTEM_PROMPT       — the task framing + RULES. Zero variables: the
 *                            same text on every single call, for every
 *                            tenant, forever (until this file changes).
 *   2. buildContextBlock() — the retrieved passages/extractions for THIS
 *                            question. Varies per call, but a follow-up
 *                            question that retrieves the same top passages
 *                            (the common case — "and when was it installed"
 *                            right after "what's the warranty on unit 3")
 *                            reproduces this block byte-for-byte, so it's
 *                            the one placed behind a cache breakpoint, ahead
 *                            of the question. This is the one that matters:
 *                            it's usually the largest block by far (up to 12
 *                            passages x 1200 chars), and it's the one that
 *                            repeats across a real conversation.
 *   3. buildQuestionBlock() — today's date + the question itself. Always
 *                            different (today ticks daily even on a
 *                            word-for-word repeated question), so it is
 *                            NEVER given cache_control — see api/ask.js.
 *
 * Concatenating all three (in order, with the same blank-line join buildPrompt
 * uses) reproduces buildPrompt()'s own text, so this is a pure decomposition,
 * not a second, drifting copy of the wording.
 */

const PREAMBLE =
  "You are a grounded question-answering assistant for an HVAC dispatch " +
  'company. You will be given retrieved passages from the customer\'s own ' +
  'documents, then a question. Answer using only the "answer" tool.';

export const SYSTEM_PROMPT = `${PREAMBLE}\n\n${RULES}`;

export function buildContextBlock({ passages, extractions } = {}) {
  const ev =
    (passages ?? [])
      .map(
        (p, i) =>
          `[${i + 1}] documentId: ${p.documentId} | page: ${p.page} | file: ${p.filename}${
            p.documentType ? ` (${p.documentType})` : ""
          }\n${p.excerpt}`
      )
      .join("\n\n") || "(no passages matched)";

  const factsBlock = extractions?.length
    ? `\n\nALREADY-EXTRACTED FIELDS (verified by the pipeline; cite with location: { "field": "<field>" }, no page):\n` +
      extractions
        .map((x) => `- ${x.field} = ${x.value}  [documentId: ${x.documentId} | file: ${x.filename}]`)
        .join("\n")
    : "";

  return `These passages were retrieved from the customer's own documents because they match the question. They are the only evidence you have.

PASSAGES:
${ev}${factsBlock}`;
}

export function buildQuestionBlock({ question, today }) {
  return `Today's date: ${today}

QUESTION: ${question}`;
}

export function buildPrompt({ question, today, passages, extractions }) {
  const ev =
    (passages ?? [])
      .map(
        (p, i) =>
          `[${i + 1}] documentId: ${p.documentId} | page: ${p.page} | file: ${p.filename}${
            p.documentType ? ` (${p.documentType})` : ""
          }\n${p.excerpt}`
      )
      .join("\n\n") || "(no passages matched)";

  const factsBlock = extractions?.length
    ? `\n\nALREADY-EXTRACTED FIELDS (verified by the pipeline; cite with location: { "field": "<field>" }, no page):\n` +
      extractions
        .map((x) => `- ${x.field} = ${x.value}  [documentId: ${x.documentId} | file: ${x.filename}]`)
        .join("\n")
    : "";

  return `Today's date: ${today}

These passages were retrieved from the customer's own documents because they match the question. They are the only evidence you have.

PASSAGES:
${ev}${factsBlock}

QUESTION: ${question}

${RULES}`;
}

/**
 * What retrieval actually returned, structured for citation-checking: which
 * documents are in play, and — per document — which pages and which
 * already-extracted field names were shown to the model. Built from the same
 * rows handed to buildPrompt, never from anything a client supplied.
 */
export function buildAllowed({ passages = [], extractions = [] } = {}) {
  const docs = new Set();
  const pages = new Map(); // documentId -> Set<page number>
  const fields = new Map(); // documentId -> Set<field name>

  for (const p of passages ?? []) {
    if (!p || typeof p.documentId !== "string") continue;
    docs.add(p.documentId);
    if (typeof p.page === "number") {
      if (!pages.has(p.documentId)) pages.set(p.documentId, new Set());
      pages.get(p.documentId).add(p.page);
    }
  }
  for (const x of extractions ?? []) {
    if (!x || typeof x.documentId !== "string") continue;
    docs.add(x.documentId);
    if (typeof x.field === "string" && x.field) {
      if (!fields.has(x.documentId)) fields.set(x.documentId, new Set());
      fields.get(x.documentId).add(x.field);
    }
  }
  return { docs, pages, fields };
}

/** Does this one source cite a specific, real piece of evidence? */
function sourceIsGrounded(s, allowed, isComputed) {
  if (!s || typeof s.documentId !== "string" || !allowed.docs.has(s.documentId)) return false;
  // A derived value has no page behind it by definition — but only when the
  // caller has actually vouched for computed evidence; see file header.
  if (isComputed) return true;
  const loc = s.location && typeof s.location === "object" ? s.location : {};
  if (typeof loc.page === "number" && allowed.pages.get(s.documentId)?.has(loc.page)) return true;
  if (typeof loc.field === "string" && loc.field && allowed.fields.get(s.documentId)?.has(loc.field)) return true;
  return false;
}

/**
 * @param raw     the model's raw tool_use input — untrusted.
 * @param allowed {docs, pages, fields} from buildAllowed(): what retrieval
 *                actually returned for THIS question.
 * @param opts.allowComputed  Only a caller that supplies real computed
 *                evidence should pass true. /api/ask does not, so a fact
 *                claiming basis "computed" is corrected back to "printed" and
 *                held to the normal page/field check rather than exempted
 *                from it.
 */
export function shapeAnswer(raw, allowed, { allowComputed = false } = {}) {
  const safeAllowed = allowed ?? buildAllowed();
  const input = raw && typeof raw === "object" ? raw : {};

  const facts = (Array.isArray(input.facts) ? input.facts : [])
    .filter((f) => f && typeof f === "object" && typeof f.label === "string" && typeof f.value === "string")
    .map((f) => {
      const basis = allowComputed && f.basis === "computed" ? "computed" : "printed";
      const sources = (Array.isArray(f.sources) ? f.sources : []).filter((s) =>
        sourceIsGrounded(s, safeAllowed, basis === "computed")
      );
      return { ...f, basis, sources };
    })
    .filter((f) => f.sources.length > 0);

  const rawText = typeof input.text === "string" ? input.text : "";

  return {
    kind: facts.length ? "answer" : "no-answer",
    text: facts.length ? rawText : rawText || "Nothing in your records answers that.",
    facts,
    sources: facts.flatMap((f) => f.sources),
    // Clamped, because ANSWER_TOOL declares confidence as a bare number with no
    // minimum or maximum — a model returning 5 passes schema validation, and
    // the client's `?? 0.8` fallback does not catch an out-of-range number
    // either. The type says 0–1; this makes that true.
    confidence: facts.length
      ? Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence : 0.8))
      : 0,
    entityId: typeof input.entityId === "string" ? input.entityId : undefined,
    interpretation: typeof input.interpretation === "string" ? input.interpretation : undefined,
    verifiedCount: new Set(facts.flatMap((f) => f.sources.map((s) => s.documentId))).size,
    unverifiedCount: 0,
    closest: [],
  };
}
