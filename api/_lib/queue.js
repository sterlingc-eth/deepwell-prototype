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
 * does today.
 *
 * NOTHING IN THIS FILE TOUCHES THE `inngest` PACKAGE AT IMPORT TIME, and that
 * is load-bearing rather than tidy. The first version imported `inngest` at the
 * top and built both function definitions at module scope, so merely importing
 * this file constructed a client and registered two functions — work that a
 * deployment with the queue switched OFF has no reason to do. It took down
 * /api/read-document and /api/inngest with FUNCTION_INVOCATION_FAILED on a
 * deployment that had no INNGEST_EVENT_KEY at all: a disabled optional feature
 * crashed the route it was supposed to leave untouched. The package is now
 * pulled in by dynamic import, on the first call that genuinely needs it, so a
 * queue that is off costs nothing and a package that cannot load fails only the
 * enqueue — where read-document already catches it and runs inline instead.
 */

export const EVENTS = {
  uploaded: "deepwell/document.uploaded",
  read: "deepwell/document.read",
};

/** True when the app is configured to queue rather than run ingestion inline. */
export function isQueueEnabled() {
  return Boolean(process.env.INNGEST_EVENT_KEY);
}

/* --------------------------------------------------------------- lazy load */

let loadPromise = null;

/**
 * Import the package, build the client, and define the functions — once.
 *
 * Memoizes the in-flight PROMISE, not the resolved value. Memoizing the value
 * looks equivalent and is not: two concurrent cold requests both find the slot
 * empty, both run the whole load, and the second overwrites the first. That
 * hands out two different Inngest clients, and because every function object
 * carries its own bound client, /api/inngest could then serve a `functions`
 * array bound to one instance alongside a `client` that is a different
 * instance. Harmless today — the clients are built from identical static config
 * and the comm handler never compares them — but it is a real race, and the
 * promise form costs nothing to get right.
 *
 * Failures are deliberately NOT memoized: the slot is cleared on rejection so a
 * transient import error can be retried on the next request rather than
 * poisoning the instance for its lifetime.
 */
function load() {
  if (!loadPromise) {
    loadPromise = buildRuntime().catch((err) => {
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

async function buildRuntime() {
  const { Inngest, NonRetriableError } = await import("inngest");
  const client = new Inngest({
    id: "deepwell",
    // Inngest reads INNGEST_EVENT_KEY from the environment itself; naming it
    // here keeps the dependency visible to anyone reading this file.
    eventKey: process.env.INNGEST_EVENT_KEY,
    // Explicit, because the inferred value is the dangerous one: left alone,
    // the client can decide it is in dev mode and quietly try to reach a dev
    // server on localhost:8288 from a production function, where nothing is
    // listening. Opt in with INNGEST_DEV=1 when running the local dev server.
    isDev: process.env.INNGEST_DEV === "1",
  });
  return { client, functions: buildFunctions(client, NonRetriableError) };
}

/** The Inngest client, built on first use. Only /api/inngest needs this. */
export async function getClient() {
  return (await load()).client;
}

/** The function definitions, built on first use. Only /api/inngest needs this. */
export async function getFunctions() {
  return (await load()).functions;
}

/**
 * Hand one document to the queue.
 * The tenant travels in the event payload because the worker has no request to
 * derive it from — it is resolved from the verified token at enqueue time and
 * never read from a request body, so the worker cannot be pointed at a tenant
 * the uploader could not already reach.
 */
export async function enqueueDocument({ documentId, tenantKey, tenantName, userId, autoExtract = true }) {
  const { client } = await load();
  await client.send({
    name: EVENTS.uploaded,
    // One run per document: a double-click, a retry, or a duplicated event
    // collapses into the same run instead of transcribing the file twice.
    id: `read-${documentId}`,
    data: { documentId, tenantKey, tenantName, userId, autoExtract },
  });
}

/* ------------------------------------------------------------- the workers */

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

/**
 * Both function definitions, parameterised by the client and the error class so
 * that neither has to be reachable from module scope.
 */
function buildFunctions(inngest, NonRetriableError) {
  const readDocument = inngest.createFunction(
    {
      id: "read-document",
      name: "Read a stored document into page text",
      // Protects two shared, finite things at once: the Anthropic rate limit and
      // the Postgres pool, which recordsStore caps at 3 connections per instance.
      concurrency: { limit: 5 },
      retries: RETRIES,
      // inngest v4 takes the trigger INSIDE the config object and the handler as
      // the second argument. The v3 three-argument form — (config, trigger,
      // handler) — throws at definition time, which on Vercel means the module
      // never finishes importing and the route answers every request with
      // FUNCTION_INVOCATION_FAILED before it reaches a line of our own code.
      triggers: [{ event: EVENTS.uploaded }],
    },
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
      triggers: [{ event: EVENTS.read }],
    },
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

  return [readDocument, extractFields];
}
