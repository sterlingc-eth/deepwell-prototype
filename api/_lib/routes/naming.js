/**
 * Document naming layer — HTTP surface (POST /api/account?action=naming, dispatched by `op`).
 * Lives behind api/account.js, same shape as graph.js's own `op` dispatch (see that file's
 * header) — no model call anywhere in this feature, so (like graph.js) there is no billing/cost
 * gate, only rate limiting.
 *
 *   { op: 'status' }                         -> {enabled, total, named, eligible, remaining} admin
 *   { op: 'backfill', afterId?, limit? }      -> one bounded naming batch                     admin
 *   { op: 'assign', documentId }              -> name ONE document now (idempotent)           admin
 *   { op: 'rename', documentId, name }        -> a person's own title for one document;
 *                                                `name: ''` clears back to auto-derived        any member
 *
 * `rename` is the one op any authenticated tenant member can call (no admin gate) — same bar as
 * api/review.js's correctField/linkDocument (a field tech correcting or naming a document they
 * can already see is not an admin action); `status`/`backfill`/`assign` are bulk/diagnostic
 * admin tools, gated like graph.js's own status/refresh/refreshDocument.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { assignDisplayName, runNamingBackfillBatch, namingBackfillStatus, renameDocument } from "../naming/assign.js";
import { withTenant } from "../recordsStore.js";

export const config = { api: { bodyParser: { sizeLimit: "16kb" } }, maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RENAME_LENGTH = 200; // sanitizeDisplayName itself caps the STORED name at 70; this just
                                // bounds what we bother reading off the wire before sanitizing.

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
      return ok(await namingBackfillStatus(ctx, { withTenantFn: withTenant }));
    }
    if (op === "backfill") {
      requireAdmin();
      const afterId = typeof body.afterId === "string" && UUID_RE.test(body.afterId) ? body.afterId : null;
      return ok(await runNamingBackfillBatch(ctx, { afterId, limit: body.limit, deadlineMs: body.deadlineMs, withTenantFn: withTenant }));
    }
    if (op === "assign") {
      requireAdmin();
      if (typeof body.documentId !== "string" || !UUID_RE.test(body.documentId)) {
        return res.status(400).json({ error: "documentId must be a uuid" });
      }
      return ok(await assignDisplayName({ withTenant, ctxArg: ctx, documentId: body.documentId }));
    }
    if (op === "rename") {
      if (typeof body.documentId !== "string" || !UUID_RE.test(body.documentId)) {
        return res.status(400).json({ error: "documentId must be a uuid" });
      }
      if (typeof body.name !== "string" || body.name.length > MAX_RENAME_LENGTH) {
        return res.status(400).json({ error: `name must be a string of ${MAX_RENAME_LENGTH} characters or fewer` });
      }
      return ok(await renameDocument(ctx, { documentId: body.documentId, name: body.name }, { withTenantFn: withTenant }));
    }
    return res.status(400).json({ error: "op must be one of: status, backfill, assign, rename" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}
