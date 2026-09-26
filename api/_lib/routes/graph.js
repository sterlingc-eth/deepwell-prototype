/**
 * Knowledge Graph layer — HTTP surface (POST /api/account?action=graph, dispatched by `op`).
 * Lives behind api/account.js, same shape as financials.js's own `op` dispatch (see that file's
 * header) — admin-only, bounded, resumable, no model call so no billing/cost gate is needed
 * (unlike financials.js's own `backfill` op, which spends a model call per document).
 *
 *   { op: 'status' }                        -> {enabled, totalDocuments, edgeCount}   admin
 *   { op: 'refresh', afterId?, limit? }      -> one bounded materialization batch     admin
 *   { op: 'refreshDocument', documentId }    -> refresh one document's kg_edges       admin
 *                                              (R11: refreshGraphForDocument — the ingest hook,
 *                                              wired for a person to trigger by hand too)
 *
 * Every op is tenant-scoped through recordsStore.withTenant (RLS). Nothing here logs question
 * text, names or amounts.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant } from "../recordsStore.js";
import { limit as rateLimit } from "../rateLimit.js";
import { refreshGraphBatch, refreshGraphForDocument, graphRefreshStatus } from "../graph/build.js";

export const config = { api: { bodyParser: { sizeLimit: "16kb" } }, maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (op === "status") {
      requireAdmin();
      return ok(await withTenant(ctx, (db) => graphRefreshStatus(db)));
    }
    if (op === "refresh") {
      requireAdmin();
      const afterId = typeof body.afterId === "string" && UUID_RE.test(body.afterId) ? body.afterId : null;
      return ok(await withTenant(ctx, (db) => refreshGraphBatch(db, { afterId, limit: body.limit, deadlineMs: body.deadlineMs })));
    }
    if (op === "refreshDocument") {
      requireAdmin();
      if (typeof body.documentId !== "string" || !UUID_RE.test(body.documentId)) {
        return res.status(400).json({ error: "documentId must be a uuid" });
      }
      return ok(await refreshGraphForDocument({ withTenant, ctxArg: ctx, documentId: body.documentId }));
    }
    return res.status(400).json({ error: "op must be one of: status, refresh, refreshDocument" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}
