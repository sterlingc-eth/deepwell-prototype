/**
 * Donovan agent - view_document_page: let the model LOOK at the original image / page of a document.
 *
 * The transcript in document_pages is a model's reading of the scan. For a nameplate photo, handwriting, a
 * gauge, or anything the transcript is unclear about, the most accurate answer comes from looking at the
 * original. This tool fetches the stored bytes from R2 (the same fetch readDocument.js uses) and hands them
 * back to the model as an image / document content block inside the tool result.
 *
 * Rules, all enforced here in code:
 *   - only a document ALREADY returned by another tool in this run (the evidence ledger's docStage) may be
 *     viewed - the model cannot fish for ids, and RLS scopes the row lookup to the tenant regardless;
 *   - at most MAX_VIEWS (2) views per question;
 *   - images: jpeg / png / gif / webp only (HEIC is rejected at ingest and cannot be shown - the tool says so
 *     and points at the transcript); PDFs: only when <= 5 pages AND <= 4 MB, otherwise the model is told to
 *     use the text tools instead; size is checked BEFORE anything is sent to the model;
 *   - a successful view registers (documentId, page) as citable evidence, so a fact the model reads off the
 *     page can cite that document + page and survives shape.js's grounding pass. Nothing else is registered.
 *
 * The bytes never leave this process except inside the model request; no text or bytes are logged.
 */
import { getObject } from "../r2.js";
import { sniffMagicBytes } from "../readDocument.js";

export const MAX_VIEWS = 2;
export const MIN_VIEW_MS = 15_000;
export const MAX_VIEW_PDF_PAGES = 5;
export const MAX_VIEW_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024; // the vision API's own per-image ceiling
export const VIEW_TOOL_NAME = "view_document_page";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VIEW_PAGE_TOOL_DEF = {
  name: VIEW_TOOL_NAME,
  description:
    "Look at the ORIGINAL image or page of a document you already found with another tool (not the transcript). Use it to read a nameplate model/serial, handwriting, a photo, a gauge, or anything the transcript text is unclear or looks wrong about. At most 2 views per question; costs tokens, so only when the text is not enough.",
  input_schema: {
    type: "object",
    properties: {
      documentId: { type: "string", description: "A documentId returned by search_documents, get_customer or run_query in this conversation." },
      page: { type: "number", description: "Page number to look at (1 for a photo or a single page)." },
    },
    required: ["documentId"],
  },
};

/** Goes in the system prompt (after the SQL view docs). */
export const VIEW_PAGE_DOCS = `LOOKING AT THE ORIGINAL: view_document_page shows you the original photo or scanned page of a document you already found (max 2 per question). Use it for nameplate model/serial reads, handwriting, photos, gauges and any time the transcript is unclear, garbled or looks wrong for a value the question depends on. Do not use it when the transcript text already answers the question. A fact you read from a viewed page must cite that documentId and page (location {page}); say in text that you read it from the original.`;

/** Rough PDF page count without a parser: the number of /Type /Page objects (not /Pages). */
export function countPdfPages(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const m = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return m ? m.length : 0;
}

/**
 * @param {{withTenant: Function, ctxArg: object, ledger: import("./tools.js").EvidenceLedger,
 *   fetchObject?: (key: string) => Promise<Buffer>}} deps  fetchObject is injectable for tests.
 */
export function createPageViewer({ withTenant, ctxArg, ledger, fetchObject = getObject, deadlineAt = Infinity }) {
  let views = 0;
  const fail = (message) => ({ ok: false, content: `ERROR: ${message}`, rowCount: 0, inputSummary: "view" });

  return async function viewDocumentPage(input) {
    const documentId = typeof input?.documentId === "string" ? input.documentId.trim().toLowerCase() : "";
    if (!UUID_RE.test(documentId)) return fail("documentId must be a documentId returned by another tool");
    // Ledger enforcement: the document must already have been shown to the model in this run.
    if (!ledger.docStage.has(documentId)) return fail("that document has not been returned by another tool in this conversation; find it with search_documents, get_customer or run_query first");
    // The R2 fetch (<= 10 s) plus the model's read of the image must fit inside the request's deadline.
    if (deadlineAt - Date.now() < MIN_VIEW_MS) return fail("there is not enough time left to look at the original; answer from what you have");
    if (views >= MAX_VIEWS) return fail(`you have already used your ${MAX_VIEWS} views for this question; answer from what you have`);
    const pageNo = Math.max(1, Math.trunc(Number(input?.page)) || 1);

    const doc = await withTenant(ctxArg, (db) => db.getDocument(documentId));
    if (!doc) return fail("no such document");
    if (!doc.storage_key) return fail("this document has no stored original; use the transcript text");
    if (doc.page_count && pageNo > doc.page_count) return fail(`this document has only ${doc.page_count} page(s)`);

    let bytes;
    try {
      bytes = await fetchObject(doc.storage_key);
    } catch {
      return fail("could not fetch the original file; use the transcript text");
    }
    const type = sniffMagicBytes(bytes) || doc.content_type || "";
    let block;
    if (IMAGE_TYPES.has(type)) {
      if (bytes.length > MAX_VIEW_IMAGE_BYTES) return fail("the image is too large to show; use the transcript text");
      if (pageNo !== 1) return fail("an image has only page 1");
      block = { type: "image", source: { type: "base64", media_type: type, data: Buffer.from(bytes).toString("base64") } };
    } else if (type === "application/pdf") {
      if (bytes.length > MAX_VIEW_PDF_BYTES) return fail(`the PDF is larger than ${MAX_VIEW_PDF_BYTES / 1024 / 1024} MB; use the transcript text (search_documents)`);
      const pages = doc.page_count || countPdfPages(bytes);
      if (pages > MAX_VIEW_PDF_PAGES) return fail(`the PDF has ${pages} pages (the limit for viewing is ${MAX_VIEW_PDF_PAGES}); use the transcript text (search_documents)`);
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") } };
    } else if (type === "image/heic" || type === "image/heif") {
      return fail("this is an iPhone HEIC photo the system cannot display; use the transcript text");
    } else {
      return fail("this file type cannot be viewed; use the transcript text");
    }

    views++;
    // The only evidence a view adds: this document + page is now citable.
    ledger.addPassage(documentId, pageNo, doc.stage, doc.original_filename);
    const note = `Original of document ${documentId}${block.type === "document" ? `, look at page ${pageNo}` : ""} (${views} of ${MAX_VIEWS} views used). Cite it as documentId ${documentId}, page ${pageNo}.`;
    return {
      ok: true,
      content: [block, { type: "text", text: note }],
      rowCount: 1,
      inputSummary: `view:${block.type}`,
    };
  };
}
