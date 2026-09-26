// Shared Claude API utilities, env loading, and CORS handling
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { captureException } from "./telemetry.js";

// --- Load .env.local manually (no dotenv dependency needed) ---
// vercel dev does not reliably inject .env.local into serverless functions,
// so we read the file ourselves. Only fills in vars that aren't already set.
function loadEnvLocal() {
  const here = dirname(fileURLToPath(import.meta.url)); // .../api/_lib
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(here, "..", "..", ".env.local"), // project root relative to api/_lib
    resolve(here, "..", ".env.local"),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
    return file;
  }
  return null;
}

loadEnvLocal();

/**
 * A server misconfiguration, which is nobody's fault but ours.
 *
 * Its `message` is ALREADY the safe, user-facing text, and the real diagnostic
 * lives in `cause` where only the log can see it. That matters because two
 * different places read `error.message` and send it somewhere it should not go:
 * handleError returned it to the browser, and recordIngestFailure writes it
 * onto the document row. Making the message safe at the throw site fixes both
 * without either of them needing to know about this class.
 */
export class ConfigError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ConfigError";
    this.cause = cause;
  }
}

/**
 * ROUND 14 (owner: 71 pending learning proposals, 36% scorecard, "405 misses, 153 proposals"): the
 * Anthropic API credits are OUT — every model call fails, and until now every one of those failures
 * was indistinguishable from Donovan genuinely not knowing an answer. That miscounts a billing problem
 * as 351+ product failures across the scorecard, the miss log, and the learning queue.
 *
 * `classifyProviderError` recognizes the THREE shapes a provider outage takes (never a wrong answer,
 * never a slow one — this is specifically "the account cannot call the model at all right now"):
 *   - 'credits'    400 invalid_request_error whose message names a credit/balance/billing problem.
 *   - 'auth'       401/403 — a bad or revoked API key, not a per-request auth failure.
 *   - 'overloaded' 529/"overloaded_error" that SURVIVED withBackoff's own retries (a transient 529 is
 *                  already retried there; classifying it here too only matters once retries are spent).
 * A caller that gets a non-null result back should treat the run as UNANSWERABLE-BY-DESIGN right now,
 * not as a wrong or missing answer: skip it, don't score it as a failure, don't log it as a miss, and
 * say so plainly rather than guessing at "no answer found".
 */
export class ProviderUnavailableError extends Error {
  constructor(reason, detail, cause) {
    super(PROVIDER_UNAVAILABLE_MESSAGE[reason] ?? "The AI provider is temporarily unavailable.");
    this.name = "ProviderUnavailableError";
    this.reason = reason; // 'credits' | 'auth' | 'overloaded'
    this.detail = detail ?? null;
    this.cause = cause;
  }
}

const PROVIDER_UNAVAILABLE_MESSAGE = {
  credits: "The AI provider account is out of credits.",
  auth: "The AI provider API key is invalid or was revoked.",
  overloaded: "The AI provider is overloaded right now.",
};

// A 400 whose message says any of these is a billing/credit problem, never a malformed request from
// our own code — Anthropic's own wording varies slightly release to release, so this matches on
// substance ("credit balance", "insufficient credit", "billing") rather than one exact sentence.
const CREDIT_ERROR_RE = /credit balance|insufficient credit|billing (?:issue|problem|hard limit)|has been suspended/i;

/**
 * @param {unknown} error  whatever the Anthropic SDK (or a mock of it) threw
 * @returns {{reason: 'credits'|'auth'|'overloaded', detail: string}|null}  null when this is some OTHER
 *   kind of failure (a timeout, a malformed request, a genuine 500) that callers should keep handling
 *   exactly as they already do.
 */
export function classifyProviderError(error) {
  if (!error) return null;
  const status = Number(error.status ?? error.statusCode ?? 0);
  const type = String(error.type ?? error.error?.type ?? "");
  const message = String(error.message ?? error.error?.message ?? "");

  if (status === 400 && (type === "invalid_request_error" || !type) && CREDIT_ERROR_RE.test(message)) {
    return { reason: "credits", detail: message.slice(0, 300) };
  }
  if (status === 401 || status === 403) {
    return { reason: "auth", detail: message.slice(0, 300) || `HTTP ${status}` };
  }
  if (status === 529 || type === "overloaded_error") {
    return { reason: "overloaded", detail: message.slice(0, 300) || "overloaded_error" };
  }
  return null;
}

/**
 * A short-lived, IN-PROCESS "the provider is down" flag. Deliberately not a queue or a circuit
 * breaker — just enough state that the SAME request/process that just watched a model call fail with
 * classifyProviderError doesn't have to re-derive that fact from a generic "no answer" a moment later
 * (the scorecard runner, the miss logger and the learning replay loop all ask this instead of re-parsing
 * errors themselves). `providerStatus.js` layers a best-effort DB-persisted marker on top of this for
 * the cross-invocation case (a nightly cron run and a live request are different serverless instances);
 * this in-process copy is the fast path every one of those callers checks first.
 */
const PROVIDER_OUTAGE_TTL_MS = 3 * 60 * 1000; // matches roughly one scorecard page / one replay batch
let providerOutage = null; // {reason, detail, since (epoch ms), lastSeenAt (epoch ms)} | null

/** Marks the provider as unavailable right now. `since` is kept from the FIRST sighting still inside
 *  the TTL window, so "AI credits exhausted since <time>" names when the outage actually started, not
 *  the most recent request that happened to hit it. */
export function recordProviderOutage({ reason, detail } = {}, now = Date.now()) {
  if (!reason) return;
  const stillOpen = providerOutage && now - providerOutage.lastSeenAt <= PROVIDER_OUTAGE_TTL_MS;
  providerOutage = { reason, detail: detail ?? null, since: stillOpen ? providerOutage.since : now, lastSeenAt: now };
}

/** A successful model call (or an operator/probe confirming credits are back) clears the flag immediately. */
export function clearProviderOutage() {
  providerOutage = null;
}

/** @returns {{reason: string, detail: string|null, since: number}|null} the CURRENT outage, or null when
 *  none is recorded or the last sighting has aged out of the TTL window (a stale flag must never keep
 *  quietly skipping work forever if nothing has actually retried the model since). */
export function getProviderOutage(now = Date.now()) {
  if (!providerOutage) return null;
  if (now - providerOutage.lastSeenAt > PROVIDER_OUTAGE_TTL_MS) { providerOutage = null; return null; }
  return { reason: providerOutage.reason, detail: providerOutage.detail, since: providerOutage.since };
}

/** Test-only reset (mirrors resetCatalogueCacheForTests / resetScorecardStoreForTests elsewhere). */
export function resetProviderOutageForTests() { providerOutage = null; }

/**
 * Warms the in-process flag from a KNOWN start time (providerStatus.js's DB fallback, when this
 * process has no local sighting but another process's persisted marker does) — `since` is the real
 * first-sighting time, `lastSeenAt` is "confirmed just now" so the TTL clock starts fresh rather than
 * already being most of the way to stale. Never overwrites a local sighting that is still fresh.
 */
export function seedProviderOutage({ reason, detail, since }, now = Date.now()) {
  if (!reason || providerOutage) return;
  providerOutage = { reason, detail: detail ?? null, since: Number.isFinite(since) ? since : now, lastSeenAt: now };
}

export function getApiKey() {
  const key = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes("YOUR_API_KEY")) {
    // Used to throw a message naming the env var and the key format, which
    // handleError's substring match then turned into 401 "Authentication
    // failed" — telling a technician in an attic that their session had
    // expired when the truth was that nobody set a server variable. They would
    // sign out and back in, forever, and it would never help.
    throw new ConfigError(
      "AI features are not configured for this environment. This is a server setting — an administrator needs to fix it.",
      "CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is unset or still a placeholder"
    );
  }
  return key;
}


/**
 * Every Anthropic call in this codebase carries an explicit timeout, and the
 * number is chosen against the PLATFORM ceiling, not the SDK's.
 *
 * THE NUMBERS HAVE TO SUM. Ingestion fetches bytes from R2 and THEN calls the
 * model, sequentially, inside one 60-second request. The first version of this
 * set them independently — 20s for R2 and 45s for the model — which adds to 65
 * seconds. Each one was individually under the ceiling and together they were
 * over it, so the slowest documents were still hard-killed by the platform with
 * no catch block, which is the exact failure both timeouts were added to
 * prevent. 10 + 35 leaves 15 seconds of headroom for everything else in the
 * request.
 *
 * The SDK defaults to roughly ten minutes. Vercel kills the function at 60
 * seconds (less, on routes that do not set maxDuration). So the SDK's timeout
 * could never fire first: a hung API call was always a hard kill, which means
 * no catch block ran, nothing was recorded, and an ingesting document was left
 * at stage 'received' with no error — indistinguishable from one still being
 * worked on. The browser then polled it for fifteen minutes and gave up.
 *
 * With a timeout below the ceiling, a hang becomes an ordinary catchable error.
 * isTransientError already classifies AbortError as transient, so it is
 * reported as retryable rather than stamped on the document as permanent.
 */
export const MODEL_TIMEOUT_MS = 35_000;

/**
 * Every client also sets `maxRetries: 0`, and that is not optional — without it
 * the timeout above does not do its job.
 *
 * The SDK defaults to maxRetries: 2, and its `timeout` is PER ATTEMPT, not a
 * deadline for the whole call. On a timeout it sleeps a backoff and tries
 * again with the same 45 seconds. Three attempts plus two backoffs is roughly
 * ninety seconds — past the 60-second ceiling, so the platform still hard-kills
 * the function and we are back to the silent, uncatchable failure this was
 * written to prevent.
 *
 * Retrying is already owned one level up: isTransientError classifies the
 * timeout as retryable, and the Inngest queue re-runs the whole step when it is
 * on. The SDK retrying underneath that is a second, invisible retry loop with
 * no knowledge of the platform's clock.
 */

/** For routes with no maxDuration of their own, which get a shorter platform default. */
export const FAST_MODEL_TIMEOUT_MS = 25_000;

/**
 * Does this Anthropic error mean "the model is temporarily out of capacity,
 * try again shortly" — as opposed to every other kind of failure?
 *
 * Deliberately NARROWER than readDocument.js's own `isTransientError`: that
 * one (rightly, for its own callers) also treats a timeout/AbortError and any
 * 5xx as retriable, because the Inngest queue owns retrying a whole step and
 * can afford to wait out a fresh attempt. `withBackoff` below is for the
 * OPPOSITE situation — a call made synchronously inside a request that has a
 * hard platform deadline — where retrying a call that failed by timing out
 * would mean deliberately spending MORE of an already-exhausted budget on a
 * second attempt of the same length. Only 429 (rate limited) and 529 /
 * "overloaded_error" are retried here: both fail FAST (the API rejects the
 * request up front, it does not hang for the full timeout first), so a short
 * jittered pause and one more try is cheap in wall-clock time. Anything else
 * — a timeout, a 500, a malformed request, a 401 — is handed straight back to
 * the caller.
 */
export function isRetryableModelStatus(error) {
  if (!error) return false;
  const status = Number(error.status ?? error.statusCode ?? 0);
  if (status === 429 || status === 529) return true;
  const type = error.type || error.error?.type;
  return type === "overloaded_error" || type === "rate_limit_error";
}

const DEFAULT_BACKOFF_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 300;

/**
 * Retry `fn` on a 429/529/overloaded Anthropic error, with full-jitter
 * exponential backoff, for a synchronous request path (ask/extract) that
 * cannot afford the Inngest queue's own retry — the request itself has a
 * hard platform ceiling (see MODEL_TIMEOUT_MS's own comment above) and must
 * answer before it, one way or the other.
 *
 * @param {(attempt: number) => Promise<T>} fn      attempt is 0-based
 * @param {{
 *   attempts?: number,      total tries, not "retries after the first" — same convention as queue.js's RETRIES
 *   baseMs?: number,        backoff base; attempt N waits a random amount in [0, baseMs * 2**N]
 *   deadlineAt?: number,    absolute Date.now()-style ms after which no further attempt or wait is allowed
 *   now?: () => number,     injectable clock, for tests
 *   sleep?: (ms: number) => Promise<void>,  injectable delay, for tests — must resolve, never reject
 *   random?: () => number,  injectable [0,1) source, for tests
 * }} [options]
 * @returns {Promise<T>}
 *
 * NEVER exceeds `deadlineAt`: before every attempt (including the first) and
 * before every wait, the remaining budget is checked, and a wait is always
 * capped to whatever budget remains rather than the full jittered value. A
 * deadline that has already passed makes this throw immediately — the LAST
 * error seen, or a dedicated error if it hasn't even tried once — rather than
 * making one more attempt "since we're here"; the caller already has a
 * platform deadline of its own and this must never be the reason it is
 * blown.
 */
export async function withBackoff(fn, options = {}) {
  const {
    attempts = DEFAULT_BACKOFF_ATTEMPTS,
    baseMs = DEFAULT_BACKOFF_BASE_MS,
    deadlineAt = Infinity,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = options;

  const maxAttempts = Math.max(1, Math.trunc(attempts) || 1);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (now() >= deadlineAt) {
      throw lastError ?? new Error("withBackoff: deadline already passed before any attempt");
    }

    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!isRetryableModelStatus(err)) throw err;
      if (attempt >= maxAttempts - 1) throw err;

      // Full jitter: a uniformly random point in [0, cap], cap doubling each
      // attempt — spreads out concurrent retries instead of having every
      // caller that got 429'd at the same moment retry at the same moment.
      const cap = baseMs * 2 ** attempt;
      const jitterMs = random() * cap;
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) throw err;

      const delayMs = Math.min(jitterMs, remainingMs);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw lastError;
}

const ALLOWED_ORIGINS = [
  "https://deepwellinc.vercel.app",
  "https://deepwelltechnology.com",
  "https://www.deepwelltechnology.com",
  "http://localhost:5173",
  "http://localhost:4173",
];

export function handleCors(res, req) {
  // An allowlist, not "*". With credentials in play, "*" would let any site on
  // the internet call these endpoints from a signed-in user's browser.
  const origin = req?.headers?.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

/**
 * Startup performance (handoffs/STARTUP_PERF_R13.md): a handful of GETs this
 * app polls repeatedly (billing status every reload + Stripe-return poll,
 * notifications every 5 minutes) are per-tenant reads that don't change on
 * every request — a short PRIVATE cache (never shared/CDN — this is
 * per-tenant data behind a bearer token) plus an ETag lets an unchanged poll
 * come back as a 304 with no body, instead of re-shipping the same JSON.
 * `maxAgeSeconds` should stay short (seconds, not minutes) — this is a
 * courtesy for a browser re-fetching its own last response seconds later, not
 * a substitute for real invalidation (there is none here: a write elsewhere,
 * e.g. the billing webhook, does not bust this).
 */
export function sendPrivateCacheableJson(res, req, body, maxAgeSeconds = 15) {
  const json = JSON.stringify(body);
  const etag = 'W/"' + createHash("sha1").update(json).digest("hex") + '"';
  res.setHeader("Cache-Control", `private, max-age=${maxAgeSeconds}, must-revalidate`);
  res.setHeader("ETag", etag);
  // Reviewer NO-GO (2026-09-26): the response varies on the caller's
  // identity (the tenant/org is derived from this bearer token — see
  // auth.js's requireAuth), so a cache sitting in front of this response
  // (a shared proxy, or the browser's own HTTP cache keyed loosely) must
  // never reuse one caller's cached body for a request carrying a
  // different token. There is no separate org/tenant header today — the
  // JWT itself is the only thing that varies the answer — but if one is
  // ever added (a header the client sends alongside Authorization to pick
  // an active org), it MUST be added to this Vary list too.
  res.setHeader("Vary", "Authorization");
  if (req?.headers?.["if-none-match"] === etag) {
    return res.status(304).end();
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(json);
}

export function handleError(res, error, req, extra = {}) {
  // Log the detail; return none of it. `error.message` here can carry the
  // Anthropic SDK's internals, our own config hints, or a stack fragment —
  // all of it useful to an attacker and useless to a user.
  console.error("API Error:", error);

  // Fire-and-forget: telemetry must never delay or fail the response it is
  // reporting on. `extra` lets a caller that already has it (ask.js,
  // read-document.js) pass tenantId through; callers that don't just get
  // route-level visibility, which is still strictly more than nothing.
  captureException(error, { route: req?.url, ...extra }).catch(() => {});

  const msg = (error && error.message) || "";
  const status = error && error.status;

  // Before the 401 check, because a missing server key is not an auth failure
  // and must never be reported as one.
  if (error?.name === "ConfigError") {
    return handleCors(res, req).status(503).json({ error: error.message });
  }

  // ROUND 14: the Anthropic account itself is out of credits/overloaded/misconfigured — record it
  // (recordProviderOutage) so every other model-needing call in this process knows to skip rather than
  // retry a call that cannot succeed, and tell the caller plainly rather than a generic 500. Checked
  // before the 401 branch below: an outage classified as 'auth' is a SERVER key problem, same reasoning
  // as the ConfigError branch above, never "your session expired".
  const providerOutage = error?.name === "ProviderUnavailableError"
    ? { reason: error.reason, detail: error.detail }
    : classifyProviderError(error);
  if (providerOutage) {
    recordProviderOutage(providerOutage);
    return handleCors(res, req).status(503).json({
      error: "AI features are temporarily unavailable — the provider account " +
        (providerOutage.reason === "credits" ? "is out of credits." : providerOutage.reason === "auth" ? "key is invalid." : "is overloaded."),
      code: "provider_unavailable",
      reason: providerOutage.reason,
    });
  }

  // A Postgres "undefined column / table / function" error means a migration
  // in M3-config/ has not been applied to this database yet. Say so plainly
  // (no schema detail) instead of a generic 500, so the UI and the owner can
  // tell "run the migration" apart from "something broke".
  if (error?.code === "42703" || error?.code === "42P01" || error?.code === "42883") {
    return handleCors(res, req).status(503).json({
      error: "This feature needs a database update that hasn't been applied yet. Please try again later.",
      code: "migration_pending",
    });
  }

  if (status === 401 || msg.includes("401") || msg.includes("authentication") || msg.includes("API key") || msg.includes("CLAUDE_API_KEY")) {
    return handleCors(res, req).status(401).json({ error: "Authentication failed" });
  }

  if (status === 429 || msg.includes("429")) {
    return handleCors(res, req).status(429).json({
      error: "Rate limited",
      details: "Too many requests. Please try again in a moment.",
    });
  }

  return handleCors(res, req).status(500).json({ error: "Processing failed" });
}
