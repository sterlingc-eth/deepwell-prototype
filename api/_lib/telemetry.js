/**
 * Minimal error/event telemetry, tolerant of Sentry being unconfigured.
 *
 * ROUND 22 (S2, privacy — owner ask: "Sentry is used for logs", "can DeepWell see our data?"):
 * this file went from "an allowlist on the context WE choose to pass in" to "an allowlist enforced on
 * EVERYTHING Sentry's SDK would otherwise capture on its own" — sendDefaultPii is explicitly false
 * (Sentry defaults it false already, but this pins it so a future Sentry major version changing that
 * default can't silently start sending cookies/IP/request bodies), and beforeSend/beforeBreadcrumb
 * below are the real enforcement: they run on every event/breadcrumb Sentry's own default
 * integrations create (console breadcrumbs, http breadcrumbs with full URLs+query strings, an
 * exception's own request context with headers/body), not just on what captureException's caller
 * passed as `context`. See scripts/verify-privacy.mjs's "Sentry scrubbing" section for synthetic
 * events asserting a request body/header/email/question/document-text field never survives either
 * hook.
 *
 * SENTRY_DSN has shipped as a literal placeholder ("https://<your-sentry-dsn>")
 * in every environment file this codebase has, and nothing ever read it. This
 * is the first thing that does — and it is written so that turning Sentry ON
 * later is a matter of setting the real DSN, not shipping new code.
 *
 * Follows the same lazy, import-safe pattern as api/_lib/queue.js's Inngest
 * loading: @sentry/node is never imported at module scope, so a deployment
 * with no DSN set (every deployment today) never constructs a client, never
 * touches the network, and cannot fail merely because the package is absent
 * or fails to load. With a DSN set, the import happens once and is reused.
 *
 * captureException / captureMessage NEVER throw. A telemetry failure must
 * never take down the request that called it — the whole point of this file
 * is to make failures visible, not to add a new one.
 *
 * With no DSN (or a failed Sentry import), every call falls through to a
 * single-line, structured console.error — timestamp, level, route, tenant,
 * message, error name and code — so Vercel's log stream is at least greppable
 * on `"level":"error"` or a route name, which is strictly better than the
 * plain `console.error("API Error:", error)` this sits behind in claude.js.
 */

import { redactText, hashForLog } from "./privacy/redact.js";

let sentryPromise = null;

function isConfigured() {
  const dsn = process.env.SENTRY_DSN;
  return Boolean(dsn) && !dsn.includes("<your-sentry-dsn>");
}

function loadSentry() {
  if (!sentryPromise) {
    sentryPromise = import("@sentry/node")
      .then((Sentry) => {
        Sentry.init({
          dsn: process.env.SENTRY_DSN,
          environment: process.env.VERCEL_ENV || "development",
          // Tracing is a separate, billed feature this file has no opinion on;
          // error/message capture only.
          tracesSampleRate: 0,
          // Explicit, not relied-on-as-default: no IP address, no cookies, no
          // request body/headers, no "user" object auto-attached from a
          // request. See this file's own module doc.
          sendDefaultPii: false,
          beforeSend: (event) => scrubSentryEvent(event),
          beforeSendTransaction: (event) => scrubSentryEvent(event),
          beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
        });
        return Sentry;
      })
      .catch((err) => {
        consoleFallback("error", "Failed to load @sentry/node; falling back to console logging", {
          name: err?.name,
          code: err?.code,
        }, {});
        return null;
      });
  }
  return sentryPromise;
}

async function getSentry() {
  if (!isConfigured()) return null;
  try {
    return await loadSentry();
  } catch {
    return null;
  }
}

/**
 * What is allowed to leave this process as "context". An ALLOWLIST, not a
 * denylist — a denylist is only ever as good as the field names someone
 * remembered to exclude, and a request body, a bearer token or
 * NEON_CONNECTION_STRING added to a call site's context next year would sail
 * straight through a denylist unnoticed. Nothing outside this list is ever
 * forwarded to Sentry or logged, no matter what a caller passes.
 */
const ALLOWED_CONTEXT_KEYS = ["route", "tenant", "tenantId", "documentId", "stage", "userId", "requestId"];

// Round 22 (S2, privacy): these identify a PERSON or an ORGANIZATION (a Clerk org id is that shop's
// own identity, a Clerk user id is a specific human) rather than an opaque internal record pointer
// (documentId, stage, requestId are all fine in the clear — they name a row/step, not a person/org),
// so they leave this process as a one-way hash, never the raw id. Two events about the "same" tenant
// still show the same hash, so grouping/search in Sentry still works — the raw id just never appears.
const HASHED_CONTEXT_KEYS = new Set(["tenant", "tenantId", "userId"]);

/** Pure and exported so it can be unit tested without a DSN or a network. */
export function scrubContext(context) {
  const out = {};
  if (!context || typeof context !== "object") return out;
  for (const key of ALLOWED_CONTEXT_KEYS) {
    if (context[key] == null) continue;
    const value = String(context[key]).slice(0, 200);
    out[key] = HASHED_CONTEXT_KEYS.has(key) ? hashForLog(value) : value;
  }
  return out;
}

function safeHost(url) {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same idea as scrubContext, for one Sentry breadcrumb. Sentry's default integrations create a
 * breadcrumb for every console.* call (which could carry a question or a customer name if some
 * OTHER call site ever logs one raw — see api/_lib/privacy/redact.js's own callers) and for every
 * outgoing fetch/http call (a full URL, including query string — which could carry a signed R2 URL's
 * query parameters or a search term). `data` is dropped wholesale for everything except a trimmed
 * method+host for fetch/xhr; category/type/level/timestamp never carry content and pass through
 * unchanged. Pure, exported so scripts/verify-privacy.mjs can feed it a synthetic breadcrumb built
 * from a request body/query string and assert none of it survives. Wired as beforeBreadcrumb above.
 */
export function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  try {
    const out = { category: breadcrumb.category, type: breadcrumb.type, level: breadcrumb.level, timestamp: breadcrumb.timestamp };
    if (typeof breadcrumb.message === "string") out.message = redactText(breadcrumb.message).slice(0, 500);
    if (breadcrumb.category === "fetch" || breadcrumb.category === "xhr") {
      out.data = { method: breadcrumb.data?.method, host: safeHost(breadcrumb.data?.url) };
    }
    return out;
  } catch {
    return null; // fail CLOSED — drop the breadcrumb rather than risk forwarding it unscrubbed
  }
}

/**
 * The beforeSend/beforeSendTransaction hook: strips exactly what ALLOWED_CONTEXT_KEYS never sees in
 * the first place — the request object (headers, query string, cookies, body — dropped wholesale,
 * not picked apart, same allowlist-not-denylist reasoning as scrubContext), a "user" object (defense
 * in depth on top of sendDefaultPii: false), and runs any free-text message/exception value through
 * redactText in case an error message itself echoed a request value (a DB constraint violation
 * naming the offending value, say). tags/extra are re-passed through scrubContext in case a future
 * call site or SDK integration ever attaches something directly, bypassing captureException's own
 * scrubbing. Pure and exported for the same reason scrubBreadcrumb is. Fails CLOSED: an exception
 * while scrubbing drops the event (returns null, same as beforeSend normally does to suppress an
 * event) rather than risk forwarding it unscrubbed — the plain console.error fallback this file's
 * captureException already falls back to on any Sentry failure means the error is never silently
 * lost, only the extra Sentry copy of it.
 */
export function scrubSentryEvent(event) {
  if (!event || typeof event !== "object") return event;
  try {
    const out = { ...event };
    delete out.request;
    delete out.user;
    if (Array.isArray(out.breadcrumbs)) {
      out.breadcrumbs = out.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter(Boolean);
    }
    if (out.message) out.message = redactText(out.message).slice(0, 2000);
    if (Array.isArray(out.exception?.values)) {
      out.exception = {
        ...out.exception,
        values: out.exception.values.map((v) => ({
          ...v,
          value: v?.value != null ? redactText(String(v.value)).slice(0, 2000) : v?.value,
        })),
      };
    }
    if (out.tags) out.tags = scrubContext(out.tags);
    if (out.extra) out.extra = scrubContext(out.extra);
    return out;
  } catch {
    return null; // fail CLOSED — see this function's own doc comment
  }
}

function consoleFallback(level, message, meta, context) {
  try {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: message ? String(message).slice(0, 2000) : undefined,
        name: meta?.name,
        code: meta?.code,
        ...scrubContext(context),
      })
    );
  } catch {
    // Logging must never itself throw into the caller's error path.
  }
}

/** Report a caught error. Never throws, and never includes request bodies,
 * tokens, or connection strings — only what scrubContext allows through. */
export async function captureException(err, context = {}) {
  try {
    const Sentry = await getSentry();
    if (Sentry) {
      Sentry.captureException(err, { extra: scrubContext(context), tags: scrubContext(context) });
      return;
    }
  } catch {
    // Fall through to the console path below.
  }
  consoleFallback("error", err?.message ?? String(err), { name: err?.name, code: err?.code }, context);
}

/** Report a notable event that is not an exception (e.g. a cron sweep
 * summary). Never throws. */
export async function captureMessage(message, context = {}) {
  try {
    const Sentry = await getSentry();
    if (Sentry) {
      Sentry.captureMessage(message, { level: "info", extra: scrubContext(context) });
      return;
    }
  } catch {
    // Fall through to the console path below.
  }
  consoleFallback("info", message, {}, context);
}
