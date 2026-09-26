import { handleCors, handleError } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { intakeStatus } from "../intake/status.js";

/**
 * GET /api/v1/intake-status
 *
 * The admin-visible straight-through-processing metric (Round 12 contract, item 5): how much of
 * intake finished with nobody touching it. Same auth/rate-limit shape as every other v1 read
 * route (v1-warranty.js, customers.js) — Clerk session OR an API key with the 'read' scope,
 * tenant-scoped via recordsStore.js's withTenant/RLS. All the actual computation lives in
 * api/_lib/intake/status.js (pure SQL, no model call) so this file is just the HTTP wrapper.
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

  try {
    const status = await withTenant({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }, (db) => intakeStatus(db));
    return handleCors(res, req).status(200).json(status);
  } catch (error) {
    return handleError(res, error, req);
  }
}
