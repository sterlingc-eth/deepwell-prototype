import { isQueueEnabled, getClient, getFunctions } from "./_lib/queue.js";

/**
 * The endpoint Inngest calls back into.
 *
 * `inngest/express`, not `inngest/vercel` — the latter does not exist in
 * inngest v4; the export map is ./next, ./express, ./node and friends. A Vercel
 * Node function gets an express-shaped (req, res) with `req.body` already
 * parsed and `req.query` populated, which is exactly what this adapter expects.
 *
 * Every step of a queued run arrives here as its own HTTP request, so the
 * 60-second ceiling applies per step rather than to the whole document.
 *
 * Both the adapter and the client are loaded on the first request rather than
 * at import time. When the queue is switched off there is nothing for this
 * endpoint to serve, and building a handler for it was enough to crash the
 * function on boot — a 503 that says so is the honest answer, and it keeps the
 * failure here instead of spreading to /api/read-document.
 *
 * SECURITY: set INNGEST_SIGNING_KEY. In cloud mode the handler fails CLOSED
 * without it — every execution request is rejected — so the symptom of
 * forgetting it is a queue that silently never runs, not an open door. The
 * residual exposure is the unauthenticated introspection GET, which lists
 * function and event names to anyone who asks.
 */
export const config = { maxDuration: 60 };

// The in-flight promise, not the resolved handler — see the same note in
// queue.js. Two concurrent cold requests would otherwise each build a handler.
let handlerPromise = null;

function getHandler() {
  if (!handlerPromise) {
    handlerPromise = buildHandler().catch((err) => {
      handlerPromise = null;
      throw err;
    });
  }
  return handlerPromise;
}

async function buildHandler() {
  const { serve } = await import("inngest/express");
  return serve({
    client: await getClient(),
    functions: await getFunctions(),
    signingKey: process.env.INNGEST_SIGNING_KEY,
    // Vercel gives the host header but no protocol; the adapter defaults to
    // https, which is right in production and for `vercel dev` over the tunnel.
    serveOrigin: process.env.INNGEST_SERVE_ORIGIN,
  });
}

export default async function inngestRoute(req, res) {
  if (!isQueueEnabled()) {
    // Not an error state. Ingestion runs inline in this configuration, and
    // saying so plainly beats a 500 that looks like the app is broken.
    return res.status(503).json({
      error: "Ingestion queue is not configured on this deployment",
      hint: "Set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY to enable it. Documents are read inline until then.",
    });
  }

  try {
    return await (await getHandler())(req, res);
  } catch (error) {
    console.error("Inngest handler failed:", error?.message);
    if (!res.headersSent) res.status(500).json({ error: "Queue handler unavailable" });
  }
}
