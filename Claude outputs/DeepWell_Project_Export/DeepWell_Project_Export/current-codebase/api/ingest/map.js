// POST /api/ingest/map — schema-aware mapping pass. Contract: docs/INGEST_API.md
//
//   guard    → api/_lib/guard.js (checkIngestGuard: INGEST_ENABLED, origin, 8 MB body, per-IP bucket)
//              Does NOT consume the INGEST_DAILY_PAGES budget — that meters the vision
//              (page-reading) pass only; mapping is a text-only reasoning call over
//              already-read facets, so it's called with pages:0 (see checkIngestGuard).
//   generate → claude-sonnet-4-5, tool-forced to `map_facets`, temperature 0, 10s timeout
//   validate → every facetIndex must exist in the request; every (entityType, fieldKey)
//              pair must exist in the supplied registry; `method` must be one of
//              registry|synonym|learned. Anything else is dropped server-side and its
//              facetIndex folded into `unmatchedIndices`, regardless of what the model said.
//
// `mapHandler(req, res, deps)` is the testable core; `deps.createMessage` replaces the
// real API call and `deps.now` the clock. The default export is what Vercel runs.

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, handleCors } from "../_lib/claude.js";
import { checkIngestGuard } from "../_lib/guard.js";
import { normalizeByType } from "../_lib/normalize.js";

export const MODEL = "claude-sonnet-4-5";
const TIMEOUT_MS_DEFAULT = 10000;
const MAX_FACETS = 60; // matches read.js's per-page cap; a map request is at most one page's facets
const METHODS = new Set(["registry", "synonym", "learned"]);

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const TOOL = {
  name: "map_facets",
  description: "Match each facet to the supplied registry by field key, known synonym, or value-type + position context. Every facet index must be classified as either a match or left unmatched.",
  input_schema: {
    type: "object",
    properties: {
      documentType: {
        type: "object",
        description: "Best-guess document type from the registry's documentTypes, or a proposed new one.",
        properties: {
          id: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["id", "confidence"],
      },
      aspects: {
        type: "array",
        description: "Document type ids this page matches; a document can be more than one thing at once.",
        items: { type: "string" },
      },
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            facetIndex: { type: "number", description: "Index into the request's facets array." },
            entityType: { type: "string" },
            fieldKey: { type: "string" },
            valueNorm: { type: "string" },
            confidence: { type: "number" },
            method: { type: "string", enum: ["registry", "synonym", "learned"] },
          },
          required: ["facetIndex", "entityType", "fieldKey", "valueNorm", "confidence", "method"],
        },
      },
      unmatchedIndices: {
        type: "array",
        items: { type: "number" },
      },
    },
    required: ["aspects", "matches", "unmatchedIndices"],
  },
};

const SYSTEM_PROMPT = `You are the mapping pass of a document-understanding pipeline. You are given facets already read from a page (label, value, value-type guess) and the CURRENT REGISTRY of known document types and fields (with synonyms). Match each facet to a registry field by field key, known synonym, or value-type + position context. A facet that fits nothing in the registry is left unmatched — do not force a match, and never invent a field key or entity type that is not in the supplied registry (matches are checked against the registry and dropped otherwise, so guessing outside it only wastes a match). method must be "registry" (matched the field's own key/label), "synonym" (matched a listed synonym), or "learned" (matched by value-type + context pattern, no literal synonym) — never "human".

documentType and aspects are different: this is an OPEN, self-extending schema, and a document that is clearly some real, coherent kind of paperwork — just not one of the registry's listed document types — is exactly what the pipeline is meant to notice and grow from. Prefer a listed document type whenever the page's facets are substantially the fields that type is defined by, even if the page's layout is a little different (a table of several past service visits is still made of work-order fields — date, technician, work performed — so it is still "work-order", not a new type just because it lists more than one visit). Only propose a new short, descriptive, lowercase-kebab-case id when the page is a materially different kind of paperwork that no listed type reasonably describes (a utility rebate application, a permit inspection checklist, a product recall notice, a financing agreement — nothing in the registry is any of those) — and even then, don't default to a generic catch-all; name what it actually is. Fall back to a listed generic/other type only when the page truly has no coherent document identity at all (a blank page, a scrap with no discernible purpose). A document can carry more than one aspect at once. Use the map_facets tool.`;

function buildUserContent(body) {
  const facetsForPrompt = body.facets.map((f) => ({ index: f.index, labelRaw: f.labelRaw, valueRaw: f.valueRaw, valueTypeGuess: f.valueTypeGuess }));
  return `documentId: ${body.documentId}${body.filenameHint ? `\nfilenameHint: ${body.filenameHint}` : ""}

REGISTRY:
${JSON.stringify(body.registry)}

FACETS:
${JSON.stringify(facetsForPrompt)}`;
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

function parseBody(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  return b && typeof b === "object" && !Array.isArray(b) ? b : null;
}

const VALUE_TYPE_GUESSES = new Set(["text", "date", "money", "serial", "number", "address", "name", "checkbox", "identifier"]);

/** Validate the request per docs/INGEST_API.md. Returns { ok:true, body } or { ok:false, error }. */
export function validateBody(raw) {
  if (!raw) return { ok: false, error: "Body must be a JSON object" };
  const documentId = typeof raw.documentId === "string" ? raw.documentId.trim() : "";
  if (!documentId) return { ok: false, error: "Missing documentId" };

  if (!Array.isArray(raw.facets) || !raw.facets.length) return { ok: false, error: "Missing facets" };
  const facets = [];
  for (const f of raw.facets) {
    if (!f || typeof f !== "object") return { ok: false, error: "Malformed facet entry" };
    if (!Number.isInteger(f.index)) return { ok: false, error: "Each facet needs an integer index" };
    if (typeof f.labelRaw !== "string" || typeof f.valueRaw !== "string") return { ok: false, error: "Each facet needs labelRaw and valueRaw strings" };
    facets.push({
      index: f.index,
      labelRaw: f.labelRaw,
      valueRaw: f.valueRaw,
      valueTypeGuess: VALUE_TYPE_GUESSES.has(f.valueTypeGuess) ? f.valueTypeGuess : "text",
    });
  }
  if (facets.length > MAX_FACETS) return { ok: false, error: `Too many facets (max ${MAX_FACETS})` };
  const indices = new Set(facets.map((f) => f.index));
  if (indices.size !== facets.length) return { ok: false, error: "Duplicate facet index" };

  const rawRegistry = raw.registry && typeof raw.registry === "object" ? raw.registry : {};
  const fields = Array.isArray(rawRegistry.fields)
    ? rawRegistry.fields.filter((f) => f && typeof f.entityType === "string" && typeof f.key === "string")
    : [];
  const documentTypes = Array.isArray(rawRegistry.documentTypes) ? rawRegistry.documentTypes : [];
  const registry = { documentTypes, fields };

  const filenameHint = typeof raw.filenameHint === "string" ? raw.filenameHint : undefined;

  return { ok: true, body: { documentId, facets, registry, filenameHint } };
}

// ---------------------------------------------------------------------------
// Response validation — nothing from the model is trusted unchecked
// ---------------------------------------------------------------------------

function clampConfidence(n) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Validate the model's tool input against the request it was given.
 * - Every match.facetIndex must exist among the request's facets.
 * - Every (entityType, fieldKey) pair must exist in the supplied registry.fields.
 * - method must be one of registry|synonym|learned.
 * Anything failing these is dropped and its facetIndex (when known) folded into
 * unmatchedIndices — regardless of what the model claimed in unmatchedIndices itself.
 */
export function sanitizeMapping(input, body) {
  const validIndices = new Map(body.facets.map((f) => [f.index, f]));
  const validPairs = new Set(body.registry.fields.map((f) => `${f.entityType} ${f.key}`));

  const matches = [];
  const matchedIndices = new Set();
  for (const m of Array.isArray(input?.matches) ? input.matches : []) {
    if (!m || typeof m !== "object") continue;
    const facet = validIndices.get(m.facetIndex);
    if (!facet) continue; // hallucinated index — drop entirely, can't even attribute to unmatched
    if (typeof m.entityType !== "string" || typeof m.fieldKey !== "string") continue;
    if (!validPairs.has(`${m.entityType} ${m.fieldKey}`)) continue; // hallucinated field outside the registry
    if (!METHODS.has(m.method)) continue;
    if (matchedIndices.has(m.facetIndex)) continue; // one match per facet
    const valueNorm = typeof m.valueNorm === "string" && m.valueNorm.trim() ? m.valueNorm.trim() : normalizeByType(facet.valueTypeGuess, facet.valueRaw);
    matches.push({
      facetIndex: m.facetIndex,
      entityType: m.entityType,
      fieldKey: m.fieldKey,
      valueNorm,
      confidence: clampConfidence(m.confidence),
      method: m.method,
    });
    matchedIndices.add(m.facetIndex);
  }

  // unmatchedIndices is recomputed server-side, never trusted from the model: every
  // requested facet that didn't survive validation into a match is unmatched.
  const unmatchedIndices = body.facets.map((f) => f.index).filter((i) => !matchedIndices.has(i));

  const aspects = Array.isArray(input?.aspects) ? Array.from(new Set(input.aspects.filter((a) => typeof a === "string" && a.trim()))) : [];

  let documentType;
  if (input?.documentType && typeof input.documentType === "object" && typeof input.documentType.id === "string" && input.documentType.id.trim()) {
    documentType = { id: input.documentType.id.trim(), confidence: clampConfidence(input.documentType.confidence) };
  }

  return { documentType, aspects, matches, unmatchedIndices };
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  return res.status(status).json(body);
}

function timeoutMs(deps) {
  if (typeof deps.timeoutMs === "number") return deps.timeoutMs;
  const n = Number.parseInt(process.env.INGEST_MAP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS_DEFAULT;
}

let client = null;
function defaultCreateMessage(params, { signal, timeout }) {
  if (!client) client = new Anthropic({ apiKey: getApiKey() });
  return client.messages.create(params, { signal, timeout });
}

async function callWithTimeout(createMessage, params, ms) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`Mapping pass took longer than ${ms} ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([createMessage(params, { signal: controller.signal, timeout: ms }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function toolInput(response) {
  const block = Array.isArray(response?.content) ? response.content.find((b) => b?.type === "tool_use" && b.name === TOOL.name) : undefined;
  return block?.input;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function mapHandler(req, res, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const started = now();

  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  // pages:0 — mapping is a text-only pass, it doesn't spend the vision page budget.
  const guard = await checkIngestGuard(req, { now: started, pages: 0 });
  if (!guard.ok) return sendJson(res, guard.status, guard.body, guard.headers);
  const ip = guard.ip;

  const parsed = validateBody(parseBody(req));
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const body = parsed.body;

  handleCors(res, req);

  try {
    const createMessage = deps.createMessage ?? defaultCreateMessage;
    const params = {
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: buildUserContent(body) }],
    };

    let response;
    try {
      response = await callWithTimeout(createMessage, params, timeoutMs(deps));
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? "timeout" : "api-error";
      console.error(JSON.stringify({ ingestMap: reason, ip, ms: now() - started, documentId: body.documentId, message: String(err?.message ?? err).slice(0, 200) }));
      return sendJson(res, 502, { error: "Mapping pass failed" });
    }

    const input = toolInput(response);
    if (!input) {
      console.error(JSON.stringify({ ingestMap: "no-tool-use", ip, documentId: body.documentId }));
      return sendJson(res, 502, { error: "Mapping pass returned no structured result" });
    }

    const result = sanitizeMapping(input, body);
    const latencyMs = now() - started;
    const usage = response?.usage ? { in: response.usage.input_tokens, out: response.usage.output_tokens } : {};
    console.log(JSON.stringify({ ingestMap: "done", ip, documentId: body.documentId, latencyMs, facets: body.facets.length, matches: result.matches.length, unmatched: result.unmatchedIndices.length, ...usage }));

    return res.status(200).json(result);
  } catch (err) {
    console.error(JSON.stringify({ ingestMap: "error", ip, documentId: body.documentId, message: String(err?.message ?? err).slice(0, 200) }));
    return sendJson(res, 500, { error: "Mapping pass failed" });
  }
}

export default function handler(req, res) {
  return mapHandler(req, res);
}
