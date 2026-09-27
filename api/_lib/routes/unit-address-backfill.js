/**
 * Unit <-> service-address backfill — HTTP surface (POST /api/account?action=unit-address),
 * same op-dispatch shape as naming.js's own status/backfill admin ops (see that file's header).
 *
 *   { op: 'status' }                                -> whole-tenant, read-only, time-boxed dry-run
 *                                                        preview (counts + a small conflict sample)
 *   { op: 'backfill', afterId?, limit?, dryRun? }    -> one bounded, resumable batch — applies unless
 *                                                        dryRun:true is passed (see the same batch
 *                                                        preview, without writing anything)
 *
 * Both admin-gated bulk/diagnostic ops, same bar as graph.js/naming.js's own status/backfill — no
 * model call anywhere in this feature (pure SQL + api/_lib/intake/unitAddress.js's deterministic
 * rule engine), so only rate limiting, no billing/cost gate.
 *
 * Operator runbook: call `status` first (always dry-run, never writes) to see how many units this
 * would touch and sample any conflicts, then call `backfill` repeatedly with `afterId` set to the
 * previous call's `nextAfterId` until it comes back null (`done: true`) — the same paging shape
 * naming.js's own backfill batch already uses, so an operator who has run that one before already
 * knows this one.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { runUnitAddressBackfillBatch, unitAddressBackfillStatus } from "../backfill/unitAddress.js";

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
      const afterId = typeof body.afterId === "string" && UUID_RE.test(body.afterId) ? body.afterId : null;
      return ok(await unitAddressBackfillStatus(ctx, { batchSize: body.batchSize, deadlineMs: body.deadlineMs, afterId }));
    }
    if (op === "backfill") {
      requireAdmin();
      const afterId = typeof body.afterId === "string" && UUID_RE.test(body.afterId) ? body.afterId : null;
      return ok(await runUnitAddressBackfillBatch(ctx, { afterId, limit: body.limit, dryRun: Boolean(body.dryRun) }));
    }
    return res.status(400).json({ error: "op must be one of: status, backfill" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}
