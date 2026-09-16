import { Inngest, NonRetriableError } from "inngest";
import { ingestDocument, recordIngestFailure } from "./readDocument.js";
import { extractDocumentFields } from "./extractDocument.js";

/**
 * The ingestion queue.
 *
 * Why it exists: /api/read-document ran inline, so the browser held a request
 * open for the length of a model transcription and the whole thing died at
 * Vercel's 60-second ceiling. Three files at a time was survivable; a customer
 * dropping in a folder of 200 was not — and a timeout there left the document
 * at stage 'received' with the bytes already paid for and uploaded.
 *
 * Queued, each document is its own durable run: it retries on its own, a rate
 * limit costs a delay instead of a document, and the browser gets an id back in
 * a few hundred milliseconds instead of waiting.
 *
 * THE QUEUE IS OPTIONAL AND OFF BY DEFAULT. With no INNGEST_EVENT_KEY set,
 * `isQueueEnabled()` is false and /api/read-document runs inline exactly as it
 * does today. That is deliberate: this can be deployed and verified before any
 * Inngest configuration exists, and it degrades to the current behaviour rather
 * than to a broken endpoint if the key is ever missing.
 */

export const EVENTS = {
  uploaded: "deepwell/document.uploaded",
  read: "deepwell/document.read",
};

export const inngest = new Inngest({
  id: "deepwell",
  // Inngest reads INNGEST_EVENT_KEY from the environment itself; naming it here
  // keeps the dependency visible to anyone reading this file.
  eventKey: process.env.INNGEST_EVENT_KEY,
});

/** True when the app is configured to queue rather than run ingestion inline. */
export function isQueueEnabled() {
  return Boolean(process.env.INNGEST_EVENT_KEY);
}

/**
 * Hand one document to the queue.
 * The tenant travels in the event payload because the worker has no request to
 * derive it from — it is resolved from the verified token at enqueue time and
 * never read from a request body, so the worker cannot be pointed at a tenant
 * the uploader could not already reach.
 */
export async function enqueueDocument({ documentId, tenantKey, tenantName, userId, autoExtract = true }) {
  await inngest.send({
    name: EVENTS.uploaded,
    // One run per document: a double-click, a retry, or a duplicated event
    // collapses into the same run instead of transcribing the file twice.
    id: `read-${documentId}`,
    data: { documentId, tenantKey, tenantName, userId, autoExtract },
  });
}

/** 4xx conditions are the document's fault, not the infrastructure's. Do not retry them. */
function fatal(error) {
  const status = error?.status;
  return error?.name === "IngestError" && status >= 400 && status < 500 && status !== 429;
}

/**
 * `retries: N` in Inngest means N TOTAL attempts, not N retries after the first
 * — the final attempt is index N-1, because `attempt` is zero-based. Getting
 * this wrong by one is not a rounding error: too high and the last attempt is
 * never recognised as final, so a permanently failed document records nothing
 * and the browser waits out its whole timeout on a run Inngest abandoned
 * minutes earlier.
 */
const RETRIES = 3;

/**
 * Write the failure onto the document ONLY when it is actually final.
 *
 * The earlier version recorded every error, including ones Inngest was about to
 * retry — which turned the queue's main benefit into its main bug. A 429 from
 * Anthropic is exactly the case this queue exists to absorb, but it would stamp
 * `extract_error` on the document, and the browser polls every 2.5 seconds and
 * treats any `extract_error` as terminal. The user would be told the file
 * failed, the retry would quietly succeed a moment later, and nobody would ever
 * find out. A document mid-retry must look like a document still working.
 */
async function recordIfFinal(ctx, documentId, err, { attempt, maxAttempts }) {
  // Prefer the value the executor reports for THIS run over our own constant,
  // so the two cannot drift apart if `retries` is ever changed above.
  const last = (maxAttempts ?? RETRIES) - 1;
  if (fatal(err) || attempt >= last) await recordIngestFailure(ctx, documentId, err);
}

const readDocument = inngest.createFunction(
  {
    id: "read-document",
    name: "Read a stored document into page text",
    // Protects two shared, finite things at once: the Anthropic rate limit and
    // the Postgres pool, which recordsStore caps at 3 connections per instance.
    concurrency: { limit: 5 },
    retries: RETRIES,
  },
  { event: EVENTS.uploaded },
  async ({ event, step, attempt, maxAttempts }) => {
    const { documentId, tenantKey, tenantName, userId, autoExtract } = event.data ?? {};
    if (!documentId || !tenantKey) throw new NonRetriableError("documentId and tenantKey are required");
    const ctx = { tenantKey, tenantName: tenantName ?? tenantKey };

    // One step, not two. The page text of a long document is megabytes, and
    // handing it between steps would push it through Inngest's step-output
    // limit for no benefit — the read and the write belong together anyway.
    const result = await step.run("read-and-store", async () => {
      try {
        return await ingestDocument(ctx, documentId, { userId });
      } catch (err) {
        await recordIfFinal(ctx, documentId, err, { attempt, maxAttempts });
        if (fatal(err)) throw new NonRetriableError(err.message, { cause: err });
        throw err;
      }
    });

    if (autoExtract) {
      await step.sendEvent("queue-extraction", {
        name: EVENTS.read,
        id: `extract-${documentId}`,
        data: { documentId, tenantKey, tenantName, userId },
      });
    }

    return result;
  }
);

const extractFields = inngest.createFunction(
  {
    id: "extract-fields",
    name: "Extract structured fields from page text",
    concurrency: { limit: 5 },
    retries: RETRIES,
  },
  { event: EVENTS.read },
  async ({ event, step, attempt, maxAttempts }) => {
    const { documentId, tenantKey, tenantName, userId } = event.data ?? {};
    if (!documentId || !tenantKey) throw new NonRetriableError("documentId and tenantKey are required");
    const ctx = { tenantKey, tenantName: tenantName ?? tenantKey };

    return step.run("extract", async () => {
      try {
        const r = await extractDocumentFields(ctx, documentId, { userId });
        // The full field list is the route's return value, not the queue's;
        // keep the step output small.
        return { documentId, fields: r.fields.length, entityId: r.entityId, truncated: r.truncated };
      } catch (err) {
        // Extraction failures used to be invisible: the read step had already
        // set extracted_at, so a document whose fields never extracted looked
        // identical to one that genuinely had no fields on it. Recording the
        // error leaves extracted_at alone (markExtracted only touches it on
        // success) and gives the status poll something to report.
        await recordIfFinal(ctx, documentId, err, { attempt, maxAttempts });
        if (fatal(err)) throw new NonRetriableError(err.message, { cause: err });
        throw err;
      }
    });
  }
);

export const functions = [readDocument, extractFields];
