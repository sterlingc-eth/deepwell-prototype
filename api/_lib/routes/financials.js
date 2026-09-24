/**
 * Financials layer — HTTP surface (POST /api/account?action=financials, dispatched by `op`).
 * Lives behind api/account.js so the api/ folder keeps its 12 functions.
 *
 *   { op: 'document', documentId }                -> {enabled, financials|null}      any member
 *   { op: 'correct', documentId, field, value, by } -> {enabled, financials}          any member (correction beside original)
 *   { op: 'verify', documentId, by }              -> {enabled, financials}             any member
 *   { op: 'needsReview' }                         -> {enabled, items:[...]}            any member
 *   { op: 'summary' }                             -> dashboard strip                   admin (shop) / solo owner
 *   { op: 'backfillStatus' }                      -> {eligible, done, remaining}       admin
 *   { op: 'backfill', maxCalls?, afterId? }       -> one bounded backfill batch        admin, billing-gated, rate-limited
 *
 * Every op is tenant-scoped through recordsStore.withTenant (RLS). The tenant and the acting user come
 * only from the verified token. Nothing here logs amounts, names or question text.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { withTenant } from "../recordsStore.js";
import { limit as rateLimit } from "../rateLimit.js";
import { assertActiveBilling } from "../plan.js";
import {
  getDocumentFinancials, correctFinancialField, verifyFinancials, listFinancialsNeedingReview, FinancialsError, financialsTableExists,
} from "../financials/store.js";
import { financialsSummary } from "../financials/answers.js";
import { runFinancialsBackfill, financialsBackfillStatus } from "../financials/backfill.js";

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
  const today = new Date().toISOString().slice(0, 10);
  const requireAdmin = () => { if (hasShop(auth)) requireRole(auth, "admin"); };

  try {
    if (op === "document" || op === "correct" || op === "verify") {
      if (typeof body.documentId !== "string" || !UUID_RE.test(body.documentId)) return res.status(400).json({ error: "documentId must be a uuid" });
    }
    if (op === "document") {
      return ok(await withTenant(ctx, (db) => getDocumentFinancials(db, body.documentId)));
    }
    if (op === "correct") {
      const out = await withTenant(ctx, async (db) => {
        const r = await correctFinancialField(db, { documentId: body.documentId, field: String(body.field ?? ""), value: body.value, by: body.by });
        await db.logAction({ action: "review.financials_corrected", resource_type: "document", resource_id: body.documentId, clerk_user_id: auth.userId, changes: { field: String(body.field ?? "").slice(0, 40) } });
        return r;
      });
      return ok(out);
    }
    if (op === "verify") {
      const out = await withTenant(ctx, async (db) => {
        const r = await verifyFinancials(db, { documentId: body.documentId, by: body.by });
        await db.logAction({ action: "review.financials_verified", resource_type: "document", resource_id: body.documentId, clerk_user_id: auth.userId, changes: {} });
        return r;
      });
      return ok(out);
    }
    if (op === "needsReview") {
      return ok(await withTenant(ctx, (db) => listFinancialsNeedingReview(db, { limit: 200 })));
    }
    if (op === "summary") {
      requireAdmin();
      return ok(await withTenant(ctx, async (db) => ((await financialsTableExists(db)) ? financialsSummary(db, { today }) : { enabled: false })));
    }
    if (op === "backfillStatus") {
      requireAdmin();
      return ok(await financialsBackfillStatus(ctx));
    }
    if (op === "backfill") {
      requireAdmin();
      // A billed model call per document: same fail-CLOSED billing gate review.js's reclassify takes.
      const gate = await assertActiveBilling(ctx);
      if (!gate.allowed) return res.status(gate.status).json({ error: gate.error, ...(gate.url ? { url: gate.url } : {}) });
      const afterId = typeof body.afterId === "string" && UUID_RE.test(body.afterId) ? body.afterId : null;
      return ok(await runFinancialsBackfill(ctx, { maxCalls: body.maxCalls, afterId, today }));
    }
    return res.status(400).json({ error: "op must be one of: document, correct, verify, needsReview, summary, backfillStatus, backfill" });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    if (error instanceof FinancialsError) return handleCors(res, req).status(error.status).json({ error: error.message });
    if (error?.name === "ModelBudgetExceededError") return handleCors(res, req).status(429).json({ error: error.message });
    return handleError(res, error, req);
  }
}
