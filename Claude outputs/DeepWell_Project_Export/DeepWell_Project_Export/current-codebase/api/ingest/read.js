// POST /api/ingest/read — universal reading pass. Contract: docs/INGEST_API.md
//
//   guard    → api/_lib/guard.js (checkIngestGuard: INGEST_ENABLED, origin, 8 MB body,
//              per-IP bucket, INGEST_DAILY_PAGES) + reserveIngestPages right before the call
//   generate → claude-sonnet-4-5, vision, tool-forced to `extract_page_reading`, temperature 0, 15s timeout
//   sanitize → drop any facet whose bbox falls outside [0,1] on any axis, cap 60 facets/page
//
// Nothing is filtered by field meaning here — every label/value pair the
// model can see goes in `facets`, matched or not. No field registry is ever
// passed into this prompt (see docs/INGEST_API.md).
//
// `readHandler(req, res, deps)` is the testable core; `deps.createMessage`
// replaces the real API call and `deps.now` the clock. The default export is
// what Vercel runs.

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, handleCors } from "../_lib/claude.js";
import { checkIngestGuard, reserveIngestPages } from "../_lib/guard.js";

export const MODEL = "claude-sonnet-4-5";
const MAX_FACETS_PER_PAGE = 60;
const TIMEOUT_MS_DEFAULT = 15000;

const SEGMENT_KINDS = new Set(["header", "party-block", "line-item-table", "terms", "signature", "handwritten-note", "stamp", "photo-region", "other"]);
const VALUE_TYPE_GUESSES = new Set(["text", "date", "money", "serial", "number", "address", "name", "checkbox", "identifier"]);
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const BBOX_SCHEMA = {
  type: "object",
  description: "Bounding box as a FRACTION of the page image, each value between 0 and 1 — never a pixel coordinate. Example: a box starting an eighth of the way across and a third of the way down a page, spanning a quarter of the width, is {\"x\":0.125,\"y\":0.33,\"w\":0.25,\"h\":0.1}.",
  properties: {
    x: { type: "number", minimum: 0, maximum: 1, description: "Left edge as a fraction of page width, 0–1 (e.g. 0.1, NOT 104)." },
    y: { type: "number", minimum: 0, maximum: 1, description: "Top edge as a fraction of page height, 0–1 (e.g. 0.3, NOT 300)." },
    w: { type: "number", minimum: 0, maximum: 1, description: "Width as a fraction of page width, 0–1." },
    h: { type: "number", minimum: 0, maximum: 1, description: "Height as a fraction of page height, 0–1." },
  },
  required: ["x", "y", "w", "h"],
};

const TOOL = {
  name: "extract_page_reading",
  description: "Report every segment and every label/value pair (facet) visible on this page image, schema-free — do not filter or judge relevance.",
  input_schema: {
    type: "object",
    properties: {
      segments: {
        type: "array",
        description: "Structural regions of the page.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...SEGMENT_KINDS] },
            bbox: BBOX_SCHEMA,
          },
          required: ["kind", "bbox"],
        },
      },
      facets: {
        type: "array",
        description: "Every label→value pair, table cell, checkbox, date, amount, identifier, name, address or free-text note visible — unfiltered.",
        items: {
          type: "object",
          properties: {
            labelRaw: { type: "string", description: "The label exactly as printed/written." },
            valueRaw: { type: "string", description: "The value exactly as printed/written." },
            valueTypeGuess: { type: "string", enum: [...VALUE_TYPE_GUESSES] },
            bbox: BBOX_SCHEMA,
            confidence: { type: "number", description: "0–1, confidence this is a real label/value pair." },
          },
          required: ["labelRaw", "valueRaw", "valueTypeGuess", "bbox", "confidence"],
        },
      },
    },
    required: ["segments", "facets"],
  },
};

function systemPrompt(hint) {
  const hintLine = hint?.filename || hint?.priorAspects?.length
    ? `\nAdvisory hint only, not a gate — the page may be something else entirely: ${[hint?.filename ? `filename "${hint.filename}"` : "", hint?.priorAspects?.length ? `prior aspects seen: ${hint.priorAspects.join(", ")}` : ""].filter(Boolean).join("; ")}`
    : "";
  return `You are the universal reading pass of a document-understanding pipeline. Look at the page image and report EVERYTHING you can see, independent of any known schema or document type: structural segments (header, party block, line-item table, terms, signature block, handwritten note, stamp, photo region, other), each boxed; and facets — every label→value pair, table cell, checkbox, date, amount, identifier, name, address or free-text note, each boxed with a 0–1 confidence and a best-guess value type. Every bbox (for both segments and facets) MUST use fractional coordinates from 0 to 1 relative to the page image's own width and height — never pixel coordinates. Treat the top-left corner of the page as (0,0) and the bottom-right as (1,1); a box in the exact center of the page is roughly {"x":0.4,"y":0.4,"w":0.2,"h":0.2}. Nothing is filtered here: report a facet even if its label looks unfamiliar or unrelated to HVAC, and even if the page is handwritten, skewed, low-quality, or hard to read — report your best reading rather than skipping it. Do not invent text that is not visibly present. Use the extract_page_reading tool.${hintLine}`;
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

/** Validate the request per docs/INGEST_API.md. Returns { ok:true, body } or { ok:false, error }. */
export function validateBody(raw) {
  if (!raw) return { ok: false, error: "Body must be a JSON object" };
  const pageImageBase64 = typeof raw.pageImageBase64 === "string" ? raw.pageImageBase64.trim() : "";
  if (!pageImageBase64) return { ok: false, error: "Missing pageImageBase64" };
  const mediaType = typeof raw.mediaType === "string" ? raw.mediaType.trim().toLowerCase() : "";
  if (!MEDIA_TYPES.has(mediaType)) return { ok: false, error: `mediaType must be one of ${[...MEDIA_TYPES].join(", ")}` };
  const documentId = typeof raw.documentId === "string" ? raw.documentId.trim() : "";
  if (!documentId) return { ok: false, error: "Missing documentId" };
  const page = Number.isInteger(raw.page) ? raw.page : Number.parseInt(raw.page, 10);
  if (!Number.isInteger(page) || page < 1) return { ok: false, error: "page must be a positive integer" };

  let hint;
  if (raw.hint && typeof raw.hint === "object") {
    hint = {};
    if (typeof raw.hint.filename === "string") hint.filename = raw.hint.filename;
    if (Array.isArray(raw.hint.priorAspects)) hint.priorAspects = raw.hint.priorAspects.filter((a) => typeof a === "string");
  }

  return { ok: true, body: { pageImageBase64, mediaType, documentId, page, hint } };
}

// ---------------------------------------------------------------------------
// Response sanitation — nothing is trusted from the model unchecked
// ---------------------------------------------------------------------------

function inUnitRange(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** A bbox is kept only when every axis falls within [0,1]. `page` is stamped by the caller, not the model. */
function cleanBbox(page, raw) {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, w, h } = raw;
  if (!inUnitRange(x) || !inUnitRange(y) || !inUnitRange(w) || !inUnitRange(h)) return null;
  return { page, x, y, w, h };
}

function clampConfidence(n) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(1, Math.max(0, v));
}

/** Sanitize the model's tool input into the response contract. Drops out-of-range bboxes; caps facets at 60/page. */
export function sanitizeReading(input, page) {
  const rawSegments = Array.isArray(input?.segments) ? input.segments : [];
  const segments = [];
  for (const s of rawSegments) {
    const bbox = cleanBbox(page, s?.bbox);
    if (!bbox) continue;
    const kind = SEGMENT_KINDS.has(s?.kind) ? s.kind : "other";
    segments.push({ kind, bbox });
  }

  const rawFacets = Array.isArray(input?.facets) ? input.facets : [];
  const facets = [];
  let truncated = false;
  for (const f of rawFacets) {
    const bbox = cleanBbox(page, f?.bbox);
    if (!bbox) continue;
    if (typeof f?.labelRaw !== "string" || !f.labelRaw.trim()) continue;
    if (typeof f?.valueRaw !== "string") continue;
    if (facets.length >= MAX_FACETS_PER_PAGE) {
      truncated = true;
      continue;
    }
    facets.push({
      labelRaw: f.labelRaw.trim(),
      valueRaw: f.valueRaw.trim(),
      valueTypeGuess: VALUE_TYPE_GUESSES.has(f.valueTypeGuess) ? f.valueTypeGuess : "text",
      bbox,
      confidence: clampConfidence(f.confidence),
    });
  }

  return { segments, facets, truncated };
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
  const n = Number.parseInt(process.env.INGEST_READ_TIMEOUT_MS ?? "", 10);
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
      const err = new Error(`Reading pass took longer than ${ms} ms`);
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

export async function readHandler(req, res, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const started = now();

  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const guard = await checkIngestGuard(req, { now: started, pages: 1 });
  if (!guard.ok) return sendJson(res, guard.status, guard.body, guard.headers);
  const ip = guard.ip;

  const parsed = validateBody(parseBody(req));
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const body = parsed.body;

  handleCors(res, req);

  const slot = await reserveIngestPages(1, started);
  if (!slot.ok) return sendJson(res, slot.status, slot.body, slot.headers);

  try {
    const createMessage = deps.createMessage ?? defaultCreateMessage;
    const params = {
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      system: systemPrompt(body.hint),
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: body.mediaType, data: body.pageImageBase64 } },
            { type: "text", text: `documentId: ${body.documentId}, page: ${body.page}. Report every segment and facet you can see.` },
          ],
        },
      ],
    };

    let response;
    try {
      response = await callWithTimeout(createMessage, params, timeoutMs(deps));
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? "timeout" : "api-error";
      console.error(JSON.stringify({ ingestRead: reason, ip, ms: now() - started, documentId: body.documentId, page: body.page, message: String(err?.message ?? err).slice(0, 200) }));
      return sendJson(res, 502, { error: "Reading pass failed" });
    }

    const input = toolInput(response);
    if (!input) {
      console.error(JSON.stringify({ ingestRead: "no-tool-use", ip, documentId: body.documentId, page: body.page }));
      return sendJson(res, 502, { error: "Reading pass returned no structured result" });
    }

    const { segments, facets, truncated } = sanitizeReading(input, body.page);
    if (truncated) console.warn(JSON.stringify({ ingestRead: "truncated", documentId: body.documentId, page: body.page, cap: MAX_FACETS_PER_PAGE }));

    const latencyMs = now() - started;
    const usage = response?.usage ? { in: response.usage.input_tokens, out: response.usage.output_tokens } : {};
    console.log(JSON.stringify({ ingestRead: "done", ip, documentId: body.documentId, page: body.page, latencyMs, segments: segments.length, facets: facets.length, truncated, ...usage }));

    return res.status(200).json({ segments, facets });
  } catch (err) {
    console.error(JSON.stringify({ ingestRead: "error", ip, documentId: body.documentId, page: body.page, message: String(err?.message ?? err).slice(0, 200) }));
    return sendJson(res, 500, { error: "Reading pass failed" });
  }
}

export default function handler(req, res) {
  return readHandler(req, res);
}
