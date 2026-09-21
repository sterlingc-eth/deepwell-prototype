import { ingestDocument, recordIngestFailure } from "./readDocument.js";
import { extractDocumentFields } from "./extractDocument.js";
import { getDailyModelBudgetStatus } from "./rateLimit.js";
import { assertActiveBilling } from "./plan.js";

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

/**
 * True when the app is configured to queue rather than run ingestion inline.
 *
 * BOTH keys, not just the event key. Sending an event needs only
 * INNGEST_EVENT_KEY, so with that set alone every enqueue succeeded and
 * /api/read-document answered 202 queued — but the callback into /api/inngest
 * is verified against INNGEST_SIGNING_KEY and fails closed without it, so the
 * work never ran. Every document said "queued" forever, and nothing anywhere
 * recorded an error. Requiring both means a half-configured queue falls back to
 * the inline path, which is slower but actually finishes.
 */
export function isQueueEnabled() {
  return Boolean(process.env.INNGEST_EVENT_KEY) && Boolean(process.env.INNGEST_SIGNING_KEY);
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

/**
 * 4xx conditions are the document's fault, not the infrastructure's. Do not
 * retry them. Exported for scripts/verify-hardening.mjs (H3, 2026-09-19
 * adversarial audit) — it used to be reachable only through the two Inngest
 * function closures, which meant its classification rules could only be
 * tested by standing up a fake Inngest run.
 *
 * Three cases beyond the original IngestError-4xx rule, each traced against a
 * real failure the original rule missed:
 *
 *   - A document deleted mid-ingestion: the page-write's INSERT violates its
 *     FK to `documents` (ON DELETE CASCADE requires the parent row to still
 *     exist). That's a plain `pg` error — `err.name` is `"error"`, `err.code`
 *     is Postgres's own '23503' — not an IngestError, so the original rule
 *     never caught it and Inngest retried the whole step, billing a second
 *     full-price transcription of a document Postgres was always going to
 *     refuse to accept again.
 *   - An R2 object that is permanently missing (404) or forbidden (403): see
 *     r2.js's R2Error — retrying can never make a deleted object exist again.
 *     A genuine 5xx from R2 is NOT included here on purpose; that one really
 *     might succeed on retry.
 *   - The daily model-spend budget (rateLimit.js's ModelBudgetExceededError):
 *     retrying THIS run cannot succeed — the budget resets at UTC midnight,
 *     not a few seconds later — so this is fatal (deferred, recorded, not
 *     retried) regardless of its 429-shaped `.status`, unlike an ordinary
 *     429 from Anthropic itself, which the IngestError branch below still
 *     excludes on purpose (that one DOES clear up in seconds).
 */
export function fatal(error) {
  const status = error?.status;
  if (error?.name === "IngestError" && status >= 400 && status < 500 && status !== 429) return true;
  if (error?.name === "ModelBudgetExceededError") return true;
  if (error?.code === "23503") return true;
  if (error?.name === "R2Error" && (status === 404 || status === 403 || status === 400)) return true;
  return false;
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

/* ---------------------------------------------------------- scale config */

/**
 * A customer dropping in 5,000 documents at once used to mean 5,000
 * concurrent Inngest runs, each opening its own Postgres connections and
 * racing every other tenant's traffic for the same Anthropic rate limit.
 * These three env vars are the knobs that keep that bounded, all optional
 * with defaults sized for this codebase's current infrastructure (a Neon
 * pooler and an Anthropic Tier-1/2 account, ~50 req/min):
 *
 *   INGEST_CONCURRENCY_GLOBAL (default 5)  — at most this many read-document
 *     runs in flight AT ONCE, across every tenant. Bounds shared, finite
 *     things: the Anthropic rate limit and recordsStore.js's own Postgres
 *     pool (5 connections per warm instance as of this build — see
 *     recordsStore.js).
 *   INGEST_CONCURRENCY_TENANT (default 3)  — at most this many of ONE
 *     tenant's documents processing at once, so a single customer's bulk
 *     drop cannot occupy the entire global budget above and starve every
 *     other tenant's ordinary traffic for the length of their import.
 *   INGEST_THROTTLE_PER_MIN (default 40)   — Inngest's `throttle` (not
 *     `rateLimit`: rateLimit is LOSSY and silently drops runs over the cap;
 *     throttle queues them and starts them as capacity frees up, which is
 *     what a durable ingestion queue is for) caps how many read-document
 *     RUNS START per minute, globally. 40 leaves headroom under a ~50/min
 *     Anthropic budget for the ask/extract traffic sharing the same account,
 *     without needing to know either function's own request rate exactly.
 *
 * All three are read fresh each time a function is built (see `load()`
 * above) rather than cached at module scope, so scripts/verify-scale.mjs can
 * assert the parsing against different `process.env` values without a
 * module-cache reset trick — the resolve* functions below are pure.
 */
const DEFAULT_CONCURRENCY_GLOBAL = 5; // Inngest free tier caps at 5; raise via env after upgrading
const DEFAULT_CONCURRENCY_TENANT = 3;
const DEFAULT_THROTTLE_PER_MIN = 40;

/** A positive integer from an env string, or `fallback` for anything else
 *  (unset, blank, zero, negative, NaN, non-numeric) — never a value that
 *  would turn into a zero or negative Inngest limit. Pure; exported for
 *  scripts/verify-scale.mjs. */
export function parsePositiveIntEnv(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * `concurrency: [{ limit }, { key, limit }]` — inngest v4's actual shape
 * (checked against node_modules/inngest/components/InngestFunction.d.ts:
 * `concurrency?: number | ConcurrencyOption | RecursiveTuple<ConcurrencyOption, 2>`,
 * i.e. AT MOST TWO entries, each `{limit: number, key?: string, scope?}`).
 * `key` is a CEL expression evaluated against the triggering event —
 * `"event.data.tenantKey"` reads the same field `enqueueDocument` above
 * always sets, so every tenant's documents share one sub-queue no matter
 * which Clerk org or API key key enqueued them. Pure; exported for
 * scripts/verify-scale.mjs.
 */
export function resolveIngestConcurrency(env = process.env) {
  return [
    { limit: parsePositiveIntEnv(env.INGEST_CONCURRENCY_GLOBAL, DEFAULT_CONCURRENCY_GLOBAL) },
    { key: "event.data.tenantKey", limit: parsePositiveIntEnv(env.INGEST_CONCURRENCY_TENANT, DEFAULT_CONCURRENCY_TENANT) },
  ];
}

/**
 * `throttle: { limit, period }` — inngest v4's actual shape (same file:
 * `throttle?: { key?, limit, period, burst? }`, distinct from the separate,
 * LOSSY `rateLimit` option — see the block comment above for why throttle,
 * not rateLimit, is the right one here). Pure; exported for
 * scripts/verify-scale.mjs.
 */
export function resolveIngestThrottle(env = process.env) {
  return { limit: parsePositiveIntEnv(env.INGEST_THROTTLE_PER_MIN, DEFAULT_THROTTLE_PER_MIN), period: "1m" };
}

/**
 * The message stamped on a document when the tenant's daily model-spend cap
 * (rateLimit.js's getDailyModelBudgetStatus) is already exhausted. Exported
 * so scripts/verify-scale.mjs can assert the queue never retries a document
 * bearing it (NonRetriableError, not a transient one) and so the wording
 * stays in exactly one place.
 */
export const DAILY_BUDGET_EXCEEDED_MESSAGE = "Daily processing limit reached — resumes tomorrow";

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
      // Protects three shared, finite things at once: the Anthropic rate
      // limit, recordsStore's shared Postgres pool, and one tenant's own
      // bulk import from starving every other tenant's traffic — see the
      // "scale config" block above for what each env var controls.
      concurrency: resolveIngestConcurrency(),
      throttle: resolveIngestThrottle(),
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

      // HARD GATE (Reviewer NO-GO, 2026-09-21): re-checked here, not just at
      // enqueue time — a document can sit queued for a while (throttled,
      // retried, or just behind other work), and the tenant's subscription
      // can lapse in the meantime. Checked BEFORE the read itself, since that
      // is the Anthropic-billed step this whole gate exists to stop.
      //
      // Deliberately does NOT call recordIngestFailure: extract_error must
      // stay null, so this document looks exactly like one still waiting its
      // turn, not a failed one — the browser's status poll treats any
      // extract_error as terminal (see readDocument.js), and "the tenant
      // hasn't paid" is not a per-document failure to report, it is a
      // whole-account state that resolves itself the moment they do (cron-
      // sweep's listStuckDocuments will pick this document back up then, no
      // extra plumbing needed). NonRetriableError so Inngest marks this run
      // skipped once and does not retry-storm a condition that retrying
      // cannot fix within this run's own retry window either.
      const billingGate = await step.run("check-active-billing", () => assertActiveBilling(ctx));
      if (!billingGate.allowed) {
        console.log(`queue: billing-gated, skipping read for document ${documentId} (tenant ${tenantKey})`);
        throw new NonRetriableError("billing-gated");
      }

      // Cost guard: a customer's daily model-spend cap (tenants.limits.
      // maxModelCallsPerDay, default sized for a Shop plan — see
      // rateLimit.js) is checked BEFORE this run pays for another Anthropic
      // call. Wrapped in step.run so a retried run doesn't re-spend this
      // check pointlessly, though NonRetriableError below ends the run
      // immediately when it fires, so there is nothing to retry anyway.
      const budget = await step.run("check-daily-model-budget", () => getDailyModelBudgetStatus(ctx));
      if (budget.exceeded) {
        await recordIngestFailure(ctx, documentId, new Error(DAILY_BUDGET_EXCEEDED_MESSAGE));
        // Permanent for TODAY, not forever — but there is no "retry tomorrow"
        // concept in Inngest's retry model, and retrying within the next few
        // minutes (this function's actual retry window) would just fail the
        // same way and burn the retry budget on a document that was never
        // going to succeed today. The cron sweep (cron-sweep.js) re-attempts
        // documents stuck at 'received' on its own daily cadence, which is
        // exactly the "resumes tomorrow" this message promises.
        throw new NonRetriableError(DAILY_BUDGET_EXCEEDED_MESSAGE);
      }

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
      // H1 (2026-09-19 adversarial audit): this used to be `{ limit: 5 }` —
      // global only, no per-tenant key — while readDocument's own concurrency
      // above deliberately caps one tenant at 3 of the global 5 slots so a
      // single bulk import can't starve every other tenant. Missing that same
      // key here let a single tenant's burst occupy all 5 global extraction
      // slots, which both defeated readDocument's own per-tenant cap one step
      // later AND increased how many of that tenant's OWN documents run
      // findOrCreateEquipment/findOrCreateCustomer concurrently (B2) — up to 5
      // at once instead of the 3 the read step caps it to. Same helper, same
      // env vars, same shape as readDocument's — not a second, drifting copy.
      concurrency: resolveIngestConcurrency(),
      retries: RETRIES,
      triggers: [{ event: EVENTS.read }],
    },
    async ({ event, step, attempt, maxAttempts }) => {
      const { documentId, tenantKey, tenantName, userId } = event.data ?? {};
      if (!documentId || !tenantKey) throw new NonRetriableError("documentId and tenantKey are required");
      const ctx = { tenantKey, tenantName: tenantName ?? tenantKey };

      // HARD GATE (Reviewer NO-GO, 2026-09-21): same re-check as the read
      // step above, and for the same reason — this event can be queued for a
      // while, and extraction is its own Anthropic-billed call. No
      // recordIngestFailure here either: extract_error stays null, leaving
      // the document at whatever stage the (billing-gated) read step left it
      // — see the read step's own comment for why this is silent rather than
      // a recorded failure.
      const billingGate = await step.run("check-active-billing", () => assertActiveBilling(ctx));
      if (!billingGate.allowed) {
        console.log(`queue: billing-gated, skipping extraction for document ${documentId} (tenant ${tenantKey})`);
        throw new NonRetriableError("billing-gated");
      }

      return step.run("extract", async () => {
        try {
          // H2: attempts=1 — under the queue, Inngest's own `retries: RETRIES`
          // above already re-runs this whole step on failure. Leaving
          // extractDocumentFields's internal withBackoff at its inline-path
          // default of 3 would nest a second retry loop inside the first,
          // multiplying one document's Anthropic spend up to RETRIES x 3 = 9x
          // under a sustained 429/529 before either succeeding or giving up —
          // never checked against the daily budget above or against itself.
          // Inngest already waits between attempts, so it alone should own
          // backing off a 429 here.
          const r = await extractDocumentFields(ctx, documentId, { userId, modelAttempts: 1 });
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
