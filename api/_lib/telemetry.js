/**
 * Minimal error/event telemetry, tolerant of Sentry being unconfigured.
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
const ALLOWED_CONTEXT_KEYS = ["route", "tenant", "tenantId", "documentId", "stage", "userId"];

/** Pure and exported so it can be unit tested without a DSN or a network. */
export function scrubContext(context) {
  const out = {};
  if (!context || typeof context !== "object") return out;
  for (const key of ALLOWED_CONTEXT_KEYS) {
    if (context[key] != null) out[key] = String(context[key]).slice(0, 200);
  }
  return out;
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
