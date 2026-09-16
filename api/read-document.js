import { requireAuth, denyAuth } from "./_lib/auth.js";
import { handleCors, handleError } from "./_lib/claude.js";
import { ingestDocument, recordIngestFailure, isTransientError } from "./_lib/readDocument.js";
import { isQueueEnabled, enqueueDocument } from "./_lib/queue.js";

/**
 * POST /api/read-document
 * body: { documentId, sync?: boolean, extract?: boolean }
 *
 * -> queued:  202 { documentId, queued: true }
 * -> inline:  200 { documentId, pages, method, queued: false }
 *
 * Step two of ingestion, and the bridge between the two stores: pull the bytes
 * back out of R2, turn them into text, and write that text into Postgres as
 * document_pages rows. /api/ask then searches those rows.
 *
 * Not to be confused with /api/extract, which is a different job: this one
 * transcribes a whole stored document into searchable page text; that one reads
 * the page text back and pulls canonical fields out of it. Both are needed;
 * they are separate routes on purpose, and the queue chains them.
 *
 * Two modes, and which one runs is decided by configuration, not by the caller:
 *
 *   queue on  (INNGEST_EVENT_KEY set) — hand the document to Inngest and return
 *     202 immediately. The browser polls /api/document-status. This is what
 *     makes a 200-document drop survivable: each document is a durable run that
 *     retries on its own, and nothing is bounded by one 60-second request.
 *
 *   queue off (no key) — do the work inline and return 200, exactly as this
 *     endpoint behaved before the queue existed. Deploying this change with no
 *     Inngest configuration therefore changes nothing, which is the point.
 *
 * `sync: true` forces inline regardless, for scripts and verification runs that
 * want the result rather than a promise of one.
 *
 * Plain text and CSV are decoded directly; there is no reason to pay a model to
 * read a file that is already text. PDFs and images go to Claude, which reads
 * scanned pages as well as digital ones — an HVAC office's documents are mostly
 * phone photos of equipment plates and faxed warranty cards, so OCR that only
 * handled clean PDFs would miss most of the corpus.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "16kb" } },
  maxDuration: 60,
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

  const { documentId, sync = false, extract = true } = req.body ?? {};
  if (typeof documentId !== "string" || !documentId) {
    return res.status(400).json({ error: "documentId is required" });
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  // ---- queued ------------------------------------------------------------
  if (isQueueEnabled() && !sync) {
    try {
      await enqueueDocument({
        documentId,
        tenantKey: auth.tenantId,
        tenantName: auth.orgId ?? auth.tenantId,
        userId: auth.userId,
        autoExtract: extract !== false,
      });
      // `extract` tells the browser whether a second stage is coming. Without
      // it the poller would call the document finished the moment the read
      // step set extracted_at, and report zero fields on a document whose
      // extraction had not started yet.
      return handleCors(res, req)
        .status(202)
        .json({ documentId, queued: true, extract: extract !== false });
    } catch (error) {
      // Inngest being unreachable must not cost the user their upload. Fall
      // through and do it inline; a slow ingest beats a lost one.
      console.error("Enqueue failed, running inline:", error?.message);
    }
  }

  // ---- inline ------------------------------------------------------------
  try {
    const result = await ingestDocument(ctx, documentId, { userId: auth.userId });
    return handleCors(res, req).status(200).json({ ...result, queued: false });
  } catch (error) {
    // Recording a failure is a one-way door on this path: the browser polls
    // document-status and treats any extract_error as terminal, so a document
    // stamped here is a document the technician is told to give up on. That is
    // the right answer for a file we genuinely cannot read, and the wrong one
    // for a rate limit that clears in four seconds — which is the single most
    // likely thing to happen when someone drops a folder of 200 files on a
    // deployment running ingestion inline. Transient failures are reported as
    // retryable and left OFF the document.
    const transient = isTransientError(error);

    if (error?.name === "IngestError") {
      // markExtracted already ran for the unsupported-type case; for the rest,
      // record the reason so the document does not sit at 'received' silently.
      if (error.status !== 415 && !transient) await recordIngestFailure(ctx, documentId, error);
      return handleCors(res, req).status(error.status ?? 400).json({ error: error.message });
    }

    if (transient) {
      console.error("Transient ingest failure, not recorded:", error?.message);
      const out = handleCors(res, req);
      out.setHeader("Retry-After", "10");
      return out.status(503).json({
        error: "Busy right now — this document has not been read yet. Try again in a moment.",
        retryable: true,
      });
    }

    await recordIngestFailure(ctx, documentId, error);
    return handleError(res, error, req);
  }
}
