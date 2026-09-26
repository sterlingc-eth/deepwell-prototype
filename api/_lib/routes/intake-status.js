import { handleCors, handleError } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { intakeStatus } from "../intake/status.js";
import { listIntakeQueue, documentIntakeSummaries } from "../intake/queue.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/intake-status
 *
 * The admin-visible straight-through-processing metric (Round 12 contract, item 5): how much of
 * intake finished with nobody touching it. Same auth/rate-limit shape as every other v1 read
 * route (v1-warranty.js, customers.js) — Clerk session OR an API key with the 'read' scope,
 * tenant-scoped via recordsStore.js's withTenant/RLS. The base computation lives in
 * api/_lib/intake/status.js (pure SQL, no model call); this file is the HTTP wrapper.
 *
 * Round 13 (H2) extends the SAME resource with two optional, additive reads rather than opening
 * new routes for them — the STP header and the queue of cards it sits above are one screen:
 *
 *   GET /api/v1/intake-status                          -> unchanged: {total, autoVerified, ...}
 *   GET /api/v1/intake-status?queue=1&limit=&cursor=    -> adds `queue: {items, nextCursor,
 *                                                          openDocumentCount, tracked}`
 *                                                          (api/_lib/intake/queue.js#listIntakeQueue)
 *   GET /api/v1/intake-status?documentIds=a,b,c         -> `documents: [...]` per-document
 *                                                          summaries for the Scan tab's post-upload
 *                                                          status (bare stage/field-count reads,
 *                                                          not the STP rollup) — the two query
 *                                                          shapes are mutually exclusive; `queue`
 *                                                          wins if both are somehow passed.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuthOrKey(req);
    assertScope(auth, "read");
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "read"))) return;

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  const wantsQueue = String(req.query?.queue ?? "") === "1";
  const idsParam = typeof req.query?.documentIds === "string" ? req.query.documentIds : "";

  try {
    if (wantsQueue) {
      const limit = Number(req.query?.limit);
      const cursor = typeof req.query?.cursor === "string" && req.query.cursor ? req.query.cursor : null;
      const [status, queue] = await withTenant(ctx, async (db) => [await intakeStatus(db), await listIntakeQueue(db, { limit, cursor })]);
      return handleCors(res, req).status(200).json({ ...status, queue });
    }
    if (idsParam) {
      const ids = idsParam.split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 50);
      const documents = await withTenant(ctx, (db) => documentIntakeSummaries(db, ids));
      return handleCors(res, req).status(200).json({ documents });
    }
    const status = await withTenant(ctx, (db) => intakeStatus(db));
    return handleCors(res, req).status(200).json(status);
  } catch (error) {
    return handleError(res, error, req);
  }
}
