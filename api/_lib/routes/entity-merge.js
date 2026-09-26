/**
 * Duplicate-customer entity resolution — HTTP surface
 * (POST /api/account?action=entity-merge, dispatched by `op`). Same admin-
 * gated `op` dispatch shape as routes/graph.js (see that file's own header).
 *
 *   { op: 'list' }                                          -> clusters      admin
 *   { op: 'accept', entityIds, keepId?, suggestionId? }      -> merge         admin
 *   { op: 'reject', entityIds, clusterId? }                  -> dismiss       admin
 *   { op: 'undo', suggestionId }                             -> revert        admin
 *
 * Admin-only throughout — a duplicate-customer merge changes shared records
 * every technician relies on, same bar as routes/graph.js's refresh or
 * reviewStore.js's own mergeCustomers being reached only from an
 * admin-gated screen. `list` is admin-only too (not merely read-gated):
 * the underlying data (which customers look like duplicates, including ones
 * an admin has not yet decided about) is exactly the kind of record a plain
 * member has no reason to see before an admin has acted on it.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant } from "../recordsStore.js";
import { limit as rateLimit } from "../rateLimit.js";
import {
  listMergeSuggestions, acceptMergeSuggestion, rejectMergeSuggestion, undoMergeSuggestion, EntityMergeError,
} from "../entities/resolve.js";

export const config = { api: { bodyParser: { sizeLimit: "16kb" } }, maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && UUID_RE.test(x)) : []);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "write"))) return;

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  const body = req.body ?? {};
  const op = typeof body.op === "string" ? body.op : "";
  const ok = (data) => handleCors(res, req).status(200).json(data);
  const requireAdmin = () => { if (hasShop(auth)) requireRole(auth, "admin"); };

  try {
    requireAdmin();

    if (op === "list") {
      return ok(await withTenant(ctx, (db) => listMergeSuggestions(db)));
    }

    if (op === "accept") {
      const entityIds = uuids(body.entityIds);
      const keepId = typeof body.keepId === "string" && UUID_RE.test(body.keepId) ? body.keepId : null;
      const suggestionId = typeof body.suggestionId === "string" ? body.suggestionId : null;
      const clusterIdValue = typeof body.clusterId === "string" ? body.clusterId : null;
      // Deliberately NOT wrapped in this route's own withTenant — see
      // acceptMergeSuggestion's own doc comment on why it manages its own
      // (multiple, sequential) transactions instead.
      const result = await acceptMergeSuggestion(ctx, { suggestionId, clusterIdValue, entityIds, keepId }, auth.userId);
      return ok(result);
    }

    if (op === "reject") {
      const entityIds = uuids(body.entityIds);
      const clusterIdValue = typeof body.clusterId === "string" ? body.clusterId : null;
      if (!entityIds.length && !clusterIdValue) return res.status(400).json({ error: "entityIds (or clusterId) is required" });
      const result = await withTenant(ctx, (db) => rejectMergeSuggestion(db, { clusterIdValue, entityIds }, auth.userId));
      return ok(result);
    }

    if (op === "undo") {
      const suggestionId = typeof body.suggestionId === "string" ? body.suggestionId : null;
      if (!suggestionId) return res.status(400).json({ error: "suggestionId is required" });
      const result = await withTenant(ctx, (db) => undoMergeSuggestion(db, { suggestionId }, auth.userId));
      return ok(result);
    }

    return res.status(400).json({ error: "op must be one of: list, accept, reject, undo" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    if (error instanceof EntityMergeError) return handleCors(res, req).status(error.status).json({ error: error.message });
    if (error?.name === "ReviewError") return handleCors(res, req).status(error.status ?? 400).json({ error: error.message });
    return handleError(res, error, req, { tenantId: ctx.tenantKey });
  }
}
