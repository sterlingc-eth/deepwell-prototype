import Anthropic from "@anthropic-ai/sdk";
import { isValidDocumentId } from "./_lib/readDocument.js";
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "./_lib/claude.js";
import { denyAuth } from "./_lib/auth.js";
import { EXTRACT_TOOL, buildExtractPrompt, normalizeFields } from "./_lib/extractFields.js";
import { extractDocumentFields, EXTRACT_MODEL, splitExtractPrompt } from "./_lib/extractDocument.js";
import { sniffMagicBytes } from "./_lib/readDocument.js";
import { requireAuthOrKey, assertScope } from "./_lib/apiKeyAuth.js";
import { limit, assertModelBudget, sendModelBudgetExceeded } from "./_lib/rateLimit.js";
import { recordModelCall } from "./_lib/usage.js";
import { withCache, modelCallLogLine } from "./_lib/promptCache.js";

/**
 * POST /api/extract
 * body: { documentId }                             — the real path
 *       { imageData, mediaType?, documentType? }   — one photographed plate, not stored
 *
 * -> { documentId, entityId, fields, dropped, truncated, model }
 *
 * Step three of ingestion. /api/read-document turns bytes into page text; this
 * turns page text into `extractions` rows keyed by a canonical field name.
 *
 * Until now nothing wrote that table, which is why the entity screens and the
 * warranty math had nothing to stand on: "what's the model on unit 3" could
 * only be answered by full-text search over prose, and "which warranties expire
 * this quarter" could not be answered at all — that is a query over fields, not
 * a search over words.
 *
 * The work itself is in _lib/extractDocument.js so the Inngest worker runs the
 * same code this route does.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "12mb" } }, // the image path posts base64
  maxDuration: 60,
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuthOrKey(req);
    assertScope(auth, "ingest");
  } catch (err) {
    return denyAuth(res, err);
  }

  if (!(await limit(req, res, auth, "ingest"))) return; // 429 already written

  const { documentId, imageData, mediaType, documentType } = req.body ?? {};

  try {
    if (!documentId && imageData) {
      return await extractFromImage(req, res, { auth, imageData, mediaType, documentType });
    }
    if (typeof documentId !== "string" || !documentId) {
      return res.status(400).json({ error: "documentId is required" });
    }
    if (!isValidDocumentId(documentId)) {
      return res.status(400).json({ error: "documentId must be a uuid" });
    }

    const result = await extractDocumentFields(
      { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
      documentId,
      { userId: auth.userId, documentType }
    );
    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    // B1 (2026-09-19 adversarial audit): checked before the generic handler
    // for the same reason as ask.js — a clean 429 + Retry-After, one shared
    // shape across every model-budget-gated endpoint. Covers both paths this
    // handler can take: extractDocumentFields throws it internally (the
    // stored-document path, gated inside extractDocument.js) and
    // extractFromImage below calls assertModelBudget directly.
    if (error?.name === "ModelBudgetExceededError") {
      return sendModelBudgetExceeded(handleCors(res, req), error);
    }
    // IngestError carries a status the caller should see (404 / 409); anything
    // else goes through handleError, which never leaks internals.
    if (error?.name === "IngestError") {
      return handleCors(res, req).status(error.status ?? 400).json({ error: error.message });
    }
    return handleError(res, error, req);
  }
}

/* ------------------------------------------------------ one photographed plate */

/**
 * The camera path: a technician points a phone at an equipment plate and wants
 * the serial read back. There is no document behind it, so nothing is stored —
 * the caller gets the fields and decides what to do with them.
 */
async function extractFromImage(req, res, { auth, imageData, mediaType, documentType }) {
  if (typeof imageData !== "string" || !imageData) {
    return res.status(400).json({ error: "imageData must be a base64 string" });
  }

  // B1: this path spends a Haiku call exactly like extractDocumentFields does,
  // but never goes through it (no document is stored for a photographed
  // plate), so it needs its own budget check rather than inheriting one.
  await assertModelBudget({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId });
  // base64 carries 3 bytes per 4 characters.
  if (imageData.length * 0.75 > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: "Image is too large" });
  }

  // Bytes beat a declared (or missing) mediaType. This used to silently
  // relabel anything IMAGE_TYPES didn't recognize as "image/jpeg" and send it
  // to the model anyway — which is how a corrupt, mislabeled, or HEIC photo
  // became a generic 500 from Anthropic's API instead of a message that says
  // what's wrong. A magic-byte match always wins over what the caller claims;
  // an unsupported type (HEIC or anything else) is refused, never relabeled.
  let sniffed = null;
  try {
    sniffed = sniffMagicBytes(Buffer.from(imageData.slice(0, 32), "base64"));
  } catch {
    sniffed = null;
  }
  const declared = typeof mediaType === "string" ? mediaType : null;
  const type = sniffed || declared || "image/jpeg";

  if (!IMAGE_TYPES.has(type)) {
    const message =
      type === "image/heic" || type === "image/heif"
        ? "iPhone photos need to be JPEG or PNG — change your camera's format setting " +
          "(Settings > Camera > Formats > Most Compatible) or share the photo rather " +
          "than sending the original, then try again."
        : `Cannot read ${type} images yet — please use JPEG, PNG, GIF, or WEBP.`;
    return res.status(415).json({ error: message });
  }

  // Same system/tools caching split as extractDocument.js's document path —
  // see splitExtractPrompt()'s doc comment there. `stable` (field guide +
  // rules) is currently well under Haiku's cacheable minimum, so withCache()
  // correctly leaves it uncached; see handoffs/HANDOFF-B.md.
  const fullPrompt = buildExtractPrompt(
    [{ page_no: 1, text: "(the photograph above is page 1)" }],
    documentType || "photograph of an equipment nameplate"
  );
  const { dynamic: dynamicPrompt, stable: stablePrompt } = splitExtractPrompt(fullPrompt);

  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  const startedAt = Date.now();
  const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
  const response = await withBackoff(() => client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 2000,
    ...(stablePrompt ? { system: [withCache({ type: "text", text: stablePrompt }, EXTRACT_MODEL)] } : {}),
    tools: [withCache(EXTRACT_TOOL, EXTRACT_MODEL)],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: type, data: imageData } },
          { type: "text", text: dynamicPrompt },
        ],
      },
    ],
  }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
  const latencyMs = Date.now() - startedAt;

  console.log(
    JSON.stringify(
      modelCallLogLine({
        route: "extract-image",
        model: EXTRACT_MODEL,
        inputTokens: response.usage?.input_tokens,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
        outputTokens: response.usage?.output_tokens,
        latencyMs,
      })
    )
  );

  await recordModelCall(
    { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId },
    {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
    }
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const { fields, dropped } = normalizeFields(toolUse?.input?.fields, { pageCount: 1 });

  return handleCors(res, req).status(200).json({
    documentId: null,
    entityId: null,
    fields,
    dropped,
    truncated: false,
    model: EXTRACT_MODEL,
    stored: false,
  });
}
