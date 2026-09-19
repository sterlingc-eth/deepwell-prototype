import Anthropic from "@anthropic-ai/sdk";
import { withTenant } from "./recordsStore.js";
import { getObject } from "./r2.js";
import { getApiKey, MODEL_TIMEOUT_MS } from "./claude.js";
import { captureException } from "./telemetry.js";
import { recordModelCall } from "./usage.js";

/**
 * The ingestion pipeline itself, with no HTTP in it.
 *
 * It lives here rather than inside api/read-document.js because it now has two
 * callers that must behave identically: the HTTP route (when the queue is off)
 * and the Inngest worker (when it is on). Two copies of a transcription
 * pipeline is two pipelines that drift, and the one that drifts is always the
 * one nobody is watching.
 *
 * Stays in api/_lib/ for the reason written across this codebase in blood:
 * Vercel bundles each function from its own folder, and an import reaching
 * outside api/ is never shipped.
 */

export const MAX_PDF_BYTES = 24 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|csv|xml))/;
const PAGE_CHARS = 6000;

// The vision API accepts exactly these. HEIC/HEIF — what an iPhone camera
// produces by default — is not among them; sending it anyway is how a
// technician's photo turns into an opaque 500 from Anthropic's API instead of
// a message that tells them what to do about it.
const VISION_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const IPHONE_PHOTO_MESSAGE =
  "iPhone photos need to be JPEG or PNG — change your camera's format setting " +
  "(Settings > Camera > Formats > Most Compatible) or share the photo rather " +
  "than sending the original, then upload again.";

/** Strip control characters a text column should never hold. NUL (0x00) is
 * fatal to Postgres TEXT; the rest are junk no transcribed page has business
 * carrying. Tab, newline and carriage return are left alone. */
function stripControlChars(s) {
  // Control characters only (NUL..US, and DEL) — never printable ones.
  // An earlier form of this regex had its escapes mangled into a literal
  // space-to-hyphen range, which deleted every space, comma, hyphen and
  // dollar sign from transcribed pages ("TOTALDUE9127.00") and made
  // word search impossible. Keep this written with explicit \x escapes.
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Is this the infrastructure having a bad second, or the document being wrong?
 *
 * It matters because recording a failure is a one-way door on the inline path:
 * the browser polls document-status, treats any extract_error as terminal, and
 * tells the technician their file failed. A 429 from Anthropic during a
 * 200-file drop is the most ordinary thing that can happen here and is over in
 * seconds — stamping it on the document turns a delay into a lost file. The
 * queue makes this distinction already (queue.js's fatal/recordIfFinal); with
 * the queue off, the inline path needs it too.
 *
 * 429 (rate limited) and 529 (Anthropic overloaded) are both covered by the
 * generic `status === 429 || status >= 500` check below — 529 is a 5xx. The
 * explicit `type` check underneath is a safety net for the shape the SDK uses
 * when an error body carries `overloaded_error` / `rate_limit_error` but,
 * for whatever reason (a proxy rewriting the status, a mocked response in a
 * test), no usable numeric status made it onto the error object.
 */
export function isTransientError(error) {
  if (!error) return false;
  if (error.name === "IngestError") return error.status === 429;
  const status = Number(error.status ?? error.statusCode ?? 0);
  if (status === 408 || status === 429 || status >= 500) return true;
  const code = String(error.code ?? "");
  if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
  const name = String(error.name ?? "");
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError" || name === "AbortError") return true;
  const type = String(error.type ?? error.error?.type ?? "");
  if (type === "overloaded_error" || type === "rate_limit_error") return true;
  return false;
}

const DOCUMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure: is `v` shaped like a real uuid? Every documents.id column IS a uuid;
 * a value that is merely a non-empty string ("not-a-uuid") survives a bare
 * typeof/truthiness check and then makes Postgres raise "invalid input
 * syntax for type uuid" the moment it's bound against that column — a raw
 * 500, not the clean 400 a bad request deserves. Exported so every route (and
 * the Inngest queue worker, which calls ingestDocument/extractDocumentFields
 * directly with no HTTP layer in front of it) can guard the same way, once,
 * before ever reaching a query.
 */
export function isValidDocumentId(v) {
  return typeof v === "string" && DOCUMENT_ID_RE.test(v);
}

/** Thrown for conditions the caller should report as 4xx, not retry forever. */
export class IngestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "IngestError";
    this.status = status;
  }
}

const PAGES_TOOL = {
  name: "pages",
  description: "Return the text of each page of the document, in order.",
  input_schema: {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page_no: { type: "number", description: "1-based page number" },
            text: {
              type: "string",
              description:
                "Everything readable on this page as plain text, in reading order. Preserve numbers, serials, model numbers, dates and dollar amounts EXACTLY as printed. Render tables as lines of 'label: value'. Do not summarise, interpret, or omit anything.",
            },
            confidence: {
              type: "number",
              description:
                "Your honest confidence that this transcription is complete and correct, from 0 (mostly guessing) to 1 (certain). Score it down for handwriting, faded or low-contrast text (e.g. old thermal-paper receipts), skewed or cropped scans, blur, or any word you had to guess at.",
            },
            reason: {
              type: "string",
              description:
                "If confidence is below 0.9, a short phrase naming why (e.g. 'handwritten', 'faded thermal receipt', 'skewed scan', 'blurry photo'). Omit or leave empty when confidence is high.",
            },
          },
          // confidence/reason are intentionally NOT required: an older prompt
          // or a model that ignores them still produces a valid tool call, and
          // shouldEscalate() below treats a missing confidence as "no signal"
          // rather than a parse failure.
          required: ["page_no", "text"],
        },
      },
    },
    required: ["pages"],
  },
};

/**
 * Has this document already been read? Pure and exported so the predicate can
 * be unit tested without a database — see scripts/verify-ops.mjs.
 *
 * The three conditions together are what "already read" means on this
 * pipeline: a page count over zero says text was actually written, no
 * extract_error says the last attempt didn't fail (a failed document has
 * page_count 0 and must be retried, not skipped), and stage !== 'received'
 * is markExtracted's own signal that a read completed (it advances
 * 'received' -> 'read' only on success — see markExtracted in
 * recordsStore.js). Checking stage as well as page_count matters for a
 * document mid-retry: a queued re-run of a document that failed after
 * writing SOME pages could otherwise be mistaken for done.
 */
export function alreadyIngested(doc) {
  return Boolean(doc) && Number(doc.page_count) > 0 && !doc.extract_error && doc.stage !== "received";
}

/**
 * Did transcription actually find anything? Pure and exported so it can be
 * unit tested without a database — see scripts/verify-transcribe.mjs.
 *
 * A page object with an empty (or whitespace-only) `text` is not a defect —
 * chunkText('') and a legitimate blank page both look exactly like this — so
 * this is the one place that decides "nothing here" for a whole document,
 * rather than every caller re-deriving it from `pages.length` alone (which a
 * single blank-text page would pass).
 */
export function hasReadableText(pages) {
  return Array.isArray(pages) && pages.some((p) => String(p?.text ?? "").trim().length > 0);
}

/** User-facing message for a document that read cleanly but states nothing
 *  extractable — a 0-byte upload, a blank page, a scan with nothing legible
 *  on it. Exported so read-document.js/extractDocument.js can recognize this
 *  exact terminal state without restating the wording. */
export const NO_READABLE_TEXT_MESSAGE =
  "No readable text was found in this file — it may be blank or a scan with nothing legible on it. " +
  "Delete it, or replace it with a clearer copy and upload again.";

/**
 * Total wall-clock budget this module gives itself for one ingestDocument
 * call, measured from the moment ingestDocument starts (see `startedAt`
 * below) rather than from whatever the true HTTP request start was — this
 * module has no visibility into work the caller did before invoking it, so it
 * approximates. Vercel's ceiling is 60s; leaving 10s of headroom for R2
 * latency variance, the Postgres writes that follow transcription, and
 * response serialization mirrors the reasoning behind MODEL_TIMEOUT_MS in
 * claude.js.
 */
export const INGEST_BUDGET_MS = 50_000;

/**
 * Below this much remaining budget, starting an escalation call is not worth
 * it: a Sonnet re-read of even one or two pages plus its own connection
 * overhead needs more room than this to have a real chance of finishing, and
 * starting it anyway just trades a fast, complete, low-confidence result for
 * a hard-killed function and no result at all.
 */
export const MIN_ESCALATION_BUDGET_MS = 8_000;

/** Left unspent even when an escalation call runs, for the DB writes after it. */
export const ESCALATION_SAFETY_MARGIN_MS = 2_000;

/** How much of the ingest budget remains, in ms, as of `now`. Pure and
 * exported so the budget decision can be unit tested without real clocks. */
export function remainingBudgetMs(startedAt, now = Date.now()) {
  return INGEST_BUDGET_MS - (now - startedAt);
}

/** Parse TRANSCRIBE_ESCALATE_BELOW, falling back to 0.75 for anything that
 * isn't a finite number in [0, 1] — unset, blank, or a typo'd env value all
 * land on the same safe default rather than silently disabling escalation
 * (0) or escalating everything (NaN comparisons are always false, which
 * would look like "never escalate", not "always"). */
export function parseEscalateThreshold(raw = process.env.TRANSCRIBE_ESCALATE_BELOW) {
  const DEFAULT = 0.75;
  if (raw == null || raw === "") return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT;
  return n;
}

/**
 * Which models to use, and whether escalation is even in play.
 *
 * The legacy TRANSCRIBE_MODEL var, if set, wins outright and disables
 * escalation entirely — that is what "nothing breaks" means for anyone who
 * already pinned a model in their environment before this change existed.
 */
export function resolveTranscribeModels(env = process.env) {
  const legacyModel = env.TRANSCRIBE_MODEL;
  if (legacyModel) {
    return { fast: legacyModel, strong: legacyModel, legacy: true };
  }
  return {
    fast: env.TRANSCRIBE_MODEL_FAST || "claude-haiku-4-5",
    strong: env.TRANSCRIBE_MODEL_STRONG || "claude-sonnet-4-5",
    legacy: false,
  };
}

// ---- shouldEscalate heuristics ---------------------------------------------
//
// These run on every page regardless of what the model self-reported, because
// a model that is confidently wrong is exactly the failure mode a pure
// self-score cannot catch. Each threshold is deliberately conservative (few
// false positives) since a false positive only costs one extra Sonnet call on
// one page, while a false negative ships a wrong transcription that gets
// cited to a customer.

const EMPTY_TEXT_THRESHOLD = 2; // trimmed length <= this counts as "near-empty"
const GARBAGE_RATIO_THRESHOLD = 0.3; // fraction of "junk" characters that trips the heuristic
const GARBAGE_MIN_LENGTH = 20; // don't judge a garbage ratio on a handful of characters
const REPEATED_RUN_LENGTH = 10; // this many identical non-whitespace characters in a row

// Characters a real transcription is made of: letters (any script), digits,
// whitespace, and the punctuation that shows up in addresses, prices, dates,
// and model/serial numbers. Anything else in bulk is what OCR garbage looks
// like: runs of substituted symbols where the model matched shapes, not text.
const PLAUSIBLE_CHAR_RE = /[\p{L}\p{N}\s.,;:!?'"()\-/$%&@#*+=_°]/u;

function garbageRatio(text) {
  if (text.length < GARBAGE_MIN_LENGTH) return 0;
  let junk = 0;
  for (const ch of text) {
    if (!PLAUSIBLE_CHAR_RE.test(ch)) junk++;
  }
  return junk / text.length;
}

const REPEATED_RUN_RE = new RegExp(`([^\\s])\\1{${REPEATED_RUN_LENGTH - 1},}`);
function hasRepeatedRun(text) {
  return REPEATED_RUN_RE.test(text);
}

/**
 * Decide which pages need a second, stronger read.
 *
 * Pure and exported so it can be unit tested without touching the network —
 * see scripts/verify-transcribe.mjs. Takes the fast pass's pages (each
 * `{page_no, text, confidence?}`) and the confidence threshold below which
 * the model's own score is distrusted, and returns one decision per page:
 * `{page_no, escalate, reasons}`. `reasons` is always an array (possibly
 * empty) rather than a single string, since a page can trip more than one
 * heuristic at once and callers may want to log all of them.
 *
 * Four independent signals, ANY of which is enough to escalate a page:
 *   1. Self-reported confidence below `threshold`. Trusts the model when it
 *      says it struggled.
 *   2. Near-empty text. The prompt tells the model an empty string is fine
 *      for a genuinely blank page, so this does re-confirm some real blank
 *      pages at the cost of one extra call — cheap insurance against a page
 *      the model gave up on and returned nothing for instead.
 *   3. A high ratio of non-alphanumeric "garbage" characters, which is what
 *      OCR looks like when the model is pattern-matching shapes it can't
 *      actually read.
 *   4. A long run of one repeated character, a common failure shape for
 *      skewed or heavily degraded scans.
 */
export function shouldEscalate(pages, threshold = 0.75) {
  return (Array.isArray(pages) ? pages : []).map((p) => {
    const reasons = [];
    const text = String(p?.text ?? "");
    const confidence = Number(p?.confidence);

    if (Number.isFinite(confidence) && confidence < threshold) {
      reasons.push(`self-reported confidence ${confidence.toFixed(2)} below ${threshold}`);
    }
    if (text.trim().length <= EMPTY_TEXT_THRESHOLD) {
      reasons.push("page produced almost no text");
    }
    const ratio = garbageRatio(text);
    if (ratio > GARBAGE_RATIO_THRESHOLD) {
      reasons.push(`high ratio of non-alphanumeric characters (${Math.round(ratio * 100)}%)`);
    }
    if (hasRepeatedRun(text)) {
      reasons.push("long run of a repeated character");
    }

    return { page_no: p?.page_no, escalate: reasons.length > 0, reasons };
  });
}

/**
 * Read one stored document and write its page text into Postgres.
 *
 * Idempotent twice over. `upsertPages` is an upsert on (document_id,
 * page_no), so a retry that DOES re-run the model — which is exactly what a
 * queue does — converges on the same rows instead of duplicating them. And
 * before that: a document that has already been read successfully (see
 * `alreadyIngested`) returns its cached result WITHOUT calling the model at
 * all, unless `force` is set. Without this, a double-click on "read
 * document," or a retry issued after a slow-but-successful response, re-pays
 * for a full transcription of a document that was already read — silently,
 * since the second call looks identical to the first from the caller's side
 * and both return 200.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{userId?: string, force?: boolean}} [opts] `force: true` bypasses
 *   the cached-result short-circuit and re-transcribes regardless.
 * @returns {Promise<{documentId: string, pages: number, method: string, skipped?: boolean}>}
 */
export async function ingestDocument(ctx, documentId, { userId, force = false } = {}) {
  const startedAt = Date.now();

  if (!isValidDocumentId(documentId)) {
    throw new IngestError("documentId must be a uuid", 400);
  }

  // Read the row in its own short transaction. The model call that follows can
  // take 30+ seconds, and holding a Postgres connection open across it would
  // exhaust the pool under any real upload burst.
  const doc = await withTenant(ctx, (db) => db.getDocument(documentId));
  if (!doc) throw new IngestError("Document not found", 404);

  if (!force && alreadyIngested(doc)) {
    return { documentId, pages: doc.page_count, method: "cached", skipped: true };
  }

  if (!doc.storage_key) throw new IngestError("Document has no stored file", 409);

  const bytes = await getObject(doc.storage_key);
  // Magic bytes beat a declared content type, which is only ever a browser's
  // guess. Trusting a wrong guess — `doc.content_type || sniff(...)` used to
  // fall back to sniffing ONLY when nothing was declared — is how a photo the
  // browser mislabels (or a client that hardcodes "image/jpeg") gets sent to
  // the wrong pipeline under the wrong label. When the bytes say something
  // definite, that wins; a declared (or extension-guessed) type only fills in
  // when the bytes are inconclusive, e.g. plain text has no magic number.
  const sniffed = sniffMagicBytes(bytes);
  const contentType = sniffed || doc.content_type || sniff(bytes, doc.original_filename);

  let pages;
  let method;

  if (TEXT_TYPES.test(contentType)) {
    pages = chunkText(decodeText(bytes));
    method = "text";
  } else if (contentType === "application/pdf" || VISION_IMAGE_TYPES.has(contentType)) {
    if (bytes.length > MAX_PDF_BYTES) {
      throw new IngestError("File is too large to extract in one pass", 413);
    }
    pages = await extractWithClaude(bytes, contentType, ctx, startedAt);
    method = "model";
  } else {
    const message =
      contentType === "image/heic" || contentType === "image/heif"
        ? IPHONE_PHOTO_MESSAGE
        : `Cannot read ${contentType} yet`;
    await withTenant(ctx, (db) =>
      db.markExtracted(documentId, { error: message })
    );
    throw new IngestError(message, 415);
  }

  // NUL and other control characters have no business in transcribed text —
  // NUL is fatal to Postgres TEXT outright — so sanitize before either write
  // path (chunkText for plain text, the model transcription for PDFs/images)
  // reaches the database. `model`/`confidence` ride along when the model pass
  // set them; recordsStore's upsertPages currently ignores fields it doesn't
  // know about, so this is inert until document_pages grows the columns
  // described in this module's handoff — carrying them here now means that
  // becomes a one-file change instead of two.
  pages = pages.map((p) => ({
    page_no: p.page_no,
    text: stripControlChars(p.text),
    ...(p.model ? { model: p.model } : {}),
    ...(Number.isFinite(p.confidence) ? { confidence: p.confidence } : {}),
  }));

  // A 0-byte upload, a blank scan, or a photo of nothing legible reads
  // cleanly (no exception anywhere above) but states nothing extractable.
  // That is a real, distinct outcome from "not read yet" (extractDocument.js's
  // own 409) and from "we can't read this type at all" (415, above) — and
  // without this check it used to sail through as a normal success: one
  // blank-text page written, page_count > 0, stage advanced to 'read', no
  // error anywhere. The document then sat there until something tried to
  // EXTRACT it and got the confusing "run /api/read-document first" 409 (it
  // had run) — which the queue's autoExtract chain does automatically and
  // immediately, so this document was for all practical purposes stuck.
  //
  // Recorded exactly like the unsupported-content-type (415) case just above:
  // markExtracted with a terminal error BEFORE throwing. Throwing (rather
  // than returning a "success") is what stops the queue's read step ever
  // reaching `if (autoExtract) step.sendEvent(...)` in queue.js — the SAME
  // reason that case never chains into extraction either. document_type is
  // set to 'other' (documentTypes.js's canonical id for "nothing to
  // classify") so document-status.js's completeness comes back trivially
  // satisfied instead of "Blocked at Classified", and the document reads as a
  // clean, deletable failure rather than something stuck mid-pipeline.
  if (!hasReadableText(pages)) {
    await withTenant(ctx, async (db) => {
      await db.markExtracted(documentId, { page_count: 0, error: NO_READABLE_TEXT_MESSAGE });
      await db.updateDocument(documentId, { document_type: "other" });
    });
    throw new IngestError(NO_READABLE_TEXT_MESSAGE, 422);
  }

  const written = await withTenant(ctx, async (db) => {
    const n = await db.upsertPages(documentId, pages);
    await db.markExtracted(documentId, { page_count: pages.length });
    await db.logAction({
      action: "document.extracted",
      resource_type: "document",
      resource_id: documentId,
      clerk_user_id: userId,
      changes: { pages: pages.length, method },
    });
    return n;
  });

  return { documentId, pages: written, method };
}

/**
 * Record a failure on the document so the UI can show it and a retry is
 * possible. A document stuck at "received" with no reason is the worst outcome
 * for the person who uploaded it. Never throws — it runs on the error path.
 */
export async function recordIngestFailure(ctx, documentId, error) {
  await captureException(error, { route: "ingestDocument", documentId, tenant: ctx?.tenantKey });
  await withTenant(ctx, (db) =>
    db.markExtracted(documentId, { error: String(error?.message ?? error).slice(0, 500) })
  ).catch(() => {});
}

/** recordModelCall already swallows its own errors, but that lives in a file
 * this build does not own; this wrapper is defense in depth so a change over
 * there can never turn a successful transcription into a failed ingestion. */
async function recordUsageSafely(ctx, usage) {
  try {
    await recordModelCall(ctx, usage);
  } catch (err) {
    console.error("readDocument: usage recording failed (ingestion continues):", err?.message);
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

// Test seam only — production code never calls the setter. callTranscribe
// goes through this indirection instead of `new Anthropic(...)` directly so
// scripts/verify-transcribe.mjs can exercise the escalation control flow
// (which pages get re-run, the merge, the budget skip, truncation handling)
// against a fake `messages.create` with no network and no API key. Real
// requests always get the default factory below.
let anthropicClientFactory = (timeoutMs) =>
  new Anthropic({ apiKey: getApiKey(), timeout: timeoutMs, maxRetries: 0 });

export function __setAnthropicClientFactoryForTests(factory) {
  anthropicClientFactory = factory || ((timeoutMs) => new Anthropic({ apiKey: getApiKey(), timeout: timeoutMs, maxRetries: 0 }));
}

/** How many pages the (possibly truncated) tool call managed to return, for the
 * error message only — a truncated tool_use input may not even parse. */
function toolUseCount(response) {
  const toolUse = response?.content?.find?.((b) => b.type === "tool_use");
  return Array.isArray(toolUse?.input?.pages) ? toolUse.input.pages.length : 0;
}

/**
 * One Anthropic call against the PAGES_TOOL, shared by both the fast pass and
 * the strong-model escalation.
 *
 * `pageFilter`, when given, asks the model to transcribe only those page
 * numbers rather than the whole document — this is what "re-run only the
 * failed pages" means for a PDF/image input: there is no cheap way to slice
 * a PDF into single-page bytes without a PDF library this build does not
 * depend on, so escalation resends the same bytes but asks for (and pays
 * output tokens for) only the flagged pages, keeping their original page
 * numbers so the merge in extractWithClaude lines up.
 *
 * `strict` controls what a `max_tokens` TRUNCATION means (a partial result,
 * not a whole one): true (the fast pass, and any legacy single-model call)
 * throws, because a silently-partial FIRST read of a document must not be
 * recorded as complete. false (an escalation re-run) logs and returns
 * whatever pages did parse, because the fast pass already produced a usable,
 * complete-if-imperfect result for the whole document — a failed escalation
 * should degrade to that, not fail the ingestion outright.
 *
 * An EMPTY result (zero pages back from the model at all) is not treated as
 * a failure here regardless of `strict` — a genuinely blank document is a
 * real, legitimate outcome, not a transcription defect. ingestDocument's own
 * hasReadableText() check is what turns that into one clean terminal
 * document state; this function just reports faithfully what came back.
 */
async function callTranscribe({ model, bytes, contentType, timeoutMs, pageFilter, strict = true }) {
  const client = anthropicClientFactory(timeoutMs);
  const data = bytes.toString("base64");
  const source =
    contentType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: contentType, data } };

  const instructions =
    pageFilter && pageFilter.length
      ? `Transcribe ONLY page(s) ${pageFilter.join(", ")} of this document — skip every other page entirely. ` +
        `Number each returned page with its real position in the full document (e.g. if you are asked for ` +
        `page 7, return page_no 7, not 1). Copy serial numbers, model numbers, dates, and dollar amounts ` +
        `character for character — they are what this document will be searched by. Give an honest ` +
        `confidence score for each page.`
      : "Transcribe this document page by page. Return every page, including ones that are mostly blank " +
        "(use an empty string for those). Copy serial numbers, model numbers, dates, and dollar amounts " +
        "character for character — they are what this document will be searched by. Give an honest " +
        "confidence score for each page.";

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    tools: [PAGES_TOOL],
    tool_choice: { type: "tool", name: "pages" },
    messages: [
      {
        role: "user",
        content: [source, { type: "text", text: instructions }],
      },
    ],
  });

  const usage = {
    inputTokens: response?.usage?.input_tokens ?? 0,
    outputTokens: response?.usage?.output_tokens ?? 0,
  };

  // A transcription that ran out of output tokens comes back looking exactly
  // like a complete one: a well-formed pages array, just short. Without this
  // check the partial result was written, markExtracted set page_count to
  // whatever arrived, and the document was recorded as SUCCESSFULLY READ with
  // its back half missing — searchable, citable, and quietly incomplete. A
  // document that is wrong in a way nobody can see is worse than one that
  // failed, so a strict call fails loudly and takes the normal error path
  // instead.
  if (response.stop_reason === "max_tokens") {
    const got = toolUseCount(response);
    if (strict) {
      // IngestError with a 4xx status, NOT a plain Error, and the distinction is
      // not cosmetic: queue.js's fatal() only treats a non-429 4xx IngestError as
      // permanent. As a plain Error this would be retried three times under the
      // queue, re-sending the same oversized document to the model and truncating
      // at the same place every time before finally being recorded. The document
      // is too long — that is the document's property, not the infrastructure's,
      // and it will not become shorter on the second attempt.
      throw new IngestError(
        `Transcription was cut off after ${got} page(s) — this document is too long to read in one pass. ` +
        `Split it into smaller files and upload them separately.`,
        413
      );
    }
    console.warn(`readDocument: escalation call for page(s) ${pageFilter?.join(", ")} was cut off after ${got} page(s); keeping the fast result for any page not returned`);
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const raw = toolUse?.input?.pages ?? [];
  const pages = raw
    .filter((p) => Number.isFinite(p?.page_no))
    .map((p) => ({
      page_no: Math.trunc(p.page_no),
      text: String(p.text ?? ""),
      confidence: clamp01(Number(p?.confidence)),
      reason: typeof p?.reason === "string" && p.reason.trim() ? p.reason.trim().slice(0, 200) : undefined,
    }))
    .sort((a, b) => a.page_no - b.page_no);

  return { pages, usage };
}

/**
 * Transcribe a PDF/image, cheap model first, escalating to the strong model
 * only for pages that don't look trustworthy.
 *
 * With TRANSCRIBE_MODEL set (legacy behavior), this makes exactly one call —
 * no escalation, no second model, byte for byte what this function did before
 * hybrid transcription existed.
 *
 * Otherwise: read every page with TRANSCRIBE_MODEL_FAST, run shouldEscalate
 * over the result, and if any page trips a heuristic, re-read ONLY those
 * page numbers with TRANSCRIBE_MODEL_STRONG and merge the results in. If
 * there isn't enough of the ingest's time budget left to safely attempt that
 * second call, escalation is skipped (logged), and the fast result ships as-
 * is — a complete, possibly-lower-confidence transcription beats a function
 * that gets hard-killed by the platform partway through and records nothing
 * at all.
 */
export async function extractWithClaude(bytes, contentType, ctx, startedAt) {
  const { fast, strong, legacy } = resolveTranscribeModels();

  const fastResult = await callTranscribe({
    model: fast,
    bytes,
    contentType,
    timeoutMs: MODEL_TIMEOUT_MS,
    strict: true,
  });
  await recordUsageSafely(ctx, fastResult.usage);

  const pages = fastResult.pages.map((p) => ({ ...p, model: fast }));

  if (legacy) {
    // TRANSCRIBE_MODEL forces a single model. No escalation, matching the
    // pre-existing behavior exactly.
    return pages;
  }

  const threshold = parseEscalateThreshold();
  const decisions = shouldEscalate(pages, threshold);
  const failingPageNos = decisions.filter((d) => d.escalate).map((d) => d.page_no);

  if (!failingPageNos.length) {
    return pages;
  }

  const remaining = remainingBudgetMs(startedAt);
  if (remaining < MIN_ESCALATION_BUDGET_MS) {
    console.warn(
      `readDocument: skipping escalation for page(s) ${failingPageNos.join(", ")} — ` +
      `only ${remaining}ms left of the ${INGEST_BUDGET_MS}ms ingest budget; keeping the fast result. ` +
      `Flagged pages: model="${fast}" with their self-reported confidence, which a caller can treat as ` +
      `"needs a human look" until document_pages has a confidence column to query on directly.`
    );
    return pages;
  }

  const strongTimeoutMs = Math.max(1000, Math.min(MODEL_TIMEOUT_MS, remaining - ESCALATION_SAFETY_MARGIN_MS));

  let strongResult;
  try {
    strongResult = await callTranscribe({
      model: strong,
      bytes,
      contentType,
      timeoutMs: strongTimeoutMs,
      pageFilter: failingPageNos,
      strict: false,
    });
  } catch (err) {
    // The fast read already succeeded for the whole document; a failed
    // escalation call (network blip, the strong model also struggling, the
    // trimmed timeout expiring) should degrade to that result, not turn a
    // usable transcription into a hard ingestion failure.
    console.warn(`readDocument: escalation call failed, keeping fast result for page(s) ${failingPageNos.join(", ")}: ${err?.message}`);
    return pages;
  }
  await recordUsageSafely(ctx, strongResult.usage);

  const byPageNo = new Map(pages.map((p) => [p.page_no, p]));
  for (const sp of strongResult.pages) {
    if (byPageNo.has(sp.page_no)) {
      byPageNo.set(sp.page_no, { ...sp, model: strong });
    }
  }
  return Array.from(byPageNo.values()).sort((a, b) => a.page_no - b.page_no);
}

/**
 * Decode a text file honestly instead of assuming UTF-8.
 *
 * `bytes.toString("utf8")` on a UTF-16 file is not a near miss, it is garbage:
 * a degree sign and an accented name come back as replacement characters once
 * the interleaved NUL bytes are stripped. Nothing errors. page_count is right.
 * Extraction then runs happily over corrupted text and writes a customer name
 * with a replacement character in it, into the exact field findOrCreateCustomer
 * matches on.
 *
 * This is not an exotic input. "Unicode text" is what Windows Notepad and some
 * Excel exports mean by their default text encoding, and a contractor exporting
 * a customer list from an old system lands squarely in that path.
 *
 * Byte-order marks are checked first because they are unambiguous. Without one,
 * UTF-16 is still detectable by the NUL bytes that ASCII-range characters leave
 * in every other position, a pattern that essentially never occurs in real
 * UTF-8 text.
 */
export function decodeText(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return swap16(bytes.subarray(2)).toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }

  // No BOM. Sample the head for the alternating-NUL signature of UTF-16.
  const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
  let evenNuls = 0;
  let oddNuls = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i] === 0x00) evenNuls++;
    if (sample[i + 1] === 0x00) oddNuls++;
  }
  const pairs = Math.floor(sample.length / 2);
  if (pairs >= 8) {
    if (oddNuls / pairs > 0.3 && evenNuls / pairs < 0.1) return bytes.toString("utf16le");
    if (evenNuls / pairs > 0.3 && oddNuls / pairs < 0.1) return swap16(bytes).toString("utf16le");
  }

  return bytes.toString("utf8");
}

/** Big-endian UTF-16 to little-endian, so Node can decode it. */
function swap16(buf) {
  const out = Buffer.from(buf);
  // An odd trailing byte cannot be half of a code unit; leave it rather than
  // reading past the end.
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

/** Split a plain-text file into page-sized rows so citations stay specific. */
export function chunkText(text) {
  const out = [];
  for (let i = 0; i < text.length; i += PAGE_CHARS) {
    out.push({ page_no: out.length + 1, text: text.slice(i, i + PAGE_CHARS) });
  }
  return out.length ? out : [{ page_no: 1, text: "" }];
}

// ISO-BMFF brands that mean HEIC/HEIF. iPhones write "heic" (single image) or
// "heix"/"heim"/"heis" (variants); "mif1"/"msf1" are the generic HEIF still-
// image/sequence brands some tools emit instead. All land in the same "we
// can't send this to the vision API" bucket.
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);

/**
 * Magic-byte detection only, independent of filename or declared type — this
 * is "what the bytes say" and nothing else. Returns null when the bytes don't
 * match a known signature (plain text has none; that's expected).
 */
export function sniffMagicBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const head = bytes.subarray(0, 12);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 8 && head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF"
      && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  // ISO-BMFF: a 4-byte box size, then "ftyp", then a 4-byte major brand.
  if (bytes.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (HEIC_BRANDS.has(brand)) return "image/heic";
  }
  return null;
}

const EXT_MEDIA_TYPES = {
  txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/plain",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", heic: "image/heic", heif: "image/heif",
};

/** Magic bytes beat file extensions, which beat nothing. */
export function sniff(bytes, filename = "") {
  const magic = sniffMagicBytes(bytes);
  if (magic) return magic;
  const ext = filename.toLowerCase().split(".").pop();
  return EXT_MEDIA_TYPES[ext] ?? "application/octet-stream";
}

/** Test-only handle on the scrubber so the whitespace regression above stays caught. */
export const __stripControlCharsForTests = stripControlChars;
