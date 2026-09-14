import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, denyAuth } from "./_lib/auth.js";
import { withTenant } from "./_lib/recordsStore.js";
import { getObject } from "./_lib/r2.js";
import { handleCors, handleError, getApiKey } from "./_lib/claude.js";

/**
 * POST /api/extract
 * body: { documentId }
 * -> { documentId, pages, method }
 *
 * Step two of ingestion, and the bridge between the two stores: pull the bytes
 * back out of R2, turn them into text, and write that text into Postgres as
 * document_pages rows. /api/ask then searches those rows.
 *
 * Until this existed the app had nothing to retrieve — it kept a File object
 * just long enough to show a filename and then dropped it, so every "record"
 * was a label with no document behind it.
 *
 * Plain text and CSV are decoded directly; there is no reason to pay a model to
 * read a file that is already text. PDFs and images go to Claude, which reads
 * scanned pages as well as digital ones — an HVAC office's documents are mostly
 * phone photos of equipment plates and faxed warranty cards, so OCR that only
 * handles clean PDFs would miss most of the corpus.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "16kb" } },
  maxDuration: 60,
};

const MAX_PDF_BYTES = 24 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|csv|xml))/;
const PAGE_CHARS = 6000;

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
          },
          required: ["page_no", "text"],
        },
      },
    },
    required: ["pages"],
  },
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const { documentId } = req.body ?? {};
  if (typeof documentId !== "string" || !documentId) {
    return res.status(400).json({ error: "documentId is required" });
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    // Read the row first, in its own short transaction. The model call that
    // follows can take 30 seconds, and holding a Postgres connection open
    // across it would exhaust the pool under any real upload burst.
    const doc = await withTenant(ctx, (db) => db.getDocument(documentId));
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (!doc.storage_key) return res.status(409).json({ error: "Document has no stored file" });

    const bytes = await getObject(doc.storage_key);
    const contentType = doc.content_type || sniff(bytes, doc.original_filename);

    let pages;
    let method;

    if (TEXT_TYPES.test(contentType)) {
      pages = chunkText(bytes.toString("utf8"));
      method = "text";
    } else if (contentType === "application/pdf" || contentType.startsWith("image/")) {
      if (bytes.length > MAX_PDF_BYTES) {
        return res.status(413).json({ error: "File is too large to extract in one pass" });
      }
      pages = await extractWithClaude(bytes, contentType);
      method = "model";
    } else {
      await withTenant(ctx, (db) =>
        db.markExtracted(documentId, { error: `Unsupported file type: ${contentType}` })
      );
      return res.status(415).json({ error: `Cannot read ${contentType} yet` });
    }

    const written = await withTenant(ctx, async (db) => {
      const n = await db.upsertPages(documentId, pages);
      await db.markExtracted(documentId, { page_count: pages.length });
      await db.logAction({
        action: "document.extracted",
        resource_type: "document",
        resource_id: documentId,
        clerk_user_id: auth.userId,
        changes: { pages: pages.length, method },
      });
      return n;
    });

    return handleCors(res, req).status(200).json({ documentId, pages: written, method });
  } catch (error) {
    // Record the failure on the document so the UI can show it and a retry is
    // possible, then report it. A document stuck at "received" with no reason
    // is the worst outcome for the person who uploaded it.
    await withTenant(ctx, (db) =>
      db.markExtracted(documentId, { error: String(error?.message ?? error).slice(0, 500) })
    ).catch(() => {});
    return handleError(res, error, req);
  }
}

async function extractWithClaude(bytes, contentType) {
  const client = new Anthropic({ apiKey: getApiKey() });
  const data = bytes.toString("base64");
  const source =
    contentType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: contentType, data } };

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    tools: [PAGES_TOOL],
    tool_choice: { type: "tool", name: "pages" },
    messages: [
      {
        role: "user",
        content: [
          source,
          {
            type: "text",
            text: "Transcribe this document page by page. Return every page, including ones that are mostly blank (use an empty string for those). Copy serial numbers, model numbers, dates, and dollar amounts character for character — they are what this document will be searched by.",
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const raw = toolUse?.input?.pages ?? [];
  const pages = raw
    .filter((p) => Number.isFinite(p?.page_no))
    .map((p) => ({ page_no: Math.trunc(p.page_no), text: String(p.text ?? "") }))
    .sort((a, b) => a.page_no - b.page_no);

  if (!pages.length) throw new Error("No text could be read from this document");
  return pages;
}

/** Split a plain-text file into page-sized rows so citations stay specific. */
function chunkText(text) {
  const out = [];
  for (let i = 0; i < text.length; i += PAGE_CHARS) {
    out.push({ page_no: out.length + 1, text: text.slice(i, i + PAGE_CHARS) });
  }
  return out.length ? out : [{ page_no: 1, text: "" }];
}

/** Magic bytes beat file extensions, which beat nothing. */
function sniff(bytes, filename = "") {
  const head = bytes.subarray(0, 8);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  const ext = filename.toLowerCase().split(".").pop();
  return { txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/plain",
           pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
           webp: "image/webp" }[ext] ?? "application/octet-stream";
}
