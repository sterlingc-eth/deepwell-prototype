import { serve } from "inngest/express";
import { inngest, functions } from "./_lib/queue.js";

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
 * SECURITY: set INNGEST_SIGNING_KEY. In cloud mode the handler fails CLOSED
 * without it — every execution request is rejected — so the symptom of
 * forgetting it is a queue that silently never runs, not an open door. The
 * residual exposure is the unauthenticated introspection GET, which lists
 * function and event names to anyone who asks.
 */
export const config = { maxDuration: 60 };

export default serve({
  client: inngest,
  functions,
  signingKey: process.env.INNGEST_SIGNING_KEY,
  // Vercel gives the host header but no protocol; the adapter defaults to
  // https, which is right in production and for `vercel dev` over the tunnel.
  serveOrigin: process.env.INNGEST_SERVE_ORIGIN,
});
