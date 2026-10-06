/**
 * industry (2A) - POST /api/account?action=industry
 *   { op: 'get' }                  -> { industry, label, unitNoun, packs, features, choices:[{id,label,unitNoun}] }   any member
 *   { op: 'attention' }            -> { items:[{kind,category,label,date,days,documentId,page}] }   electrical only: licence / insurance / bond
 *                                     expiries and tests due within 60 days (read-only, same definitions as the question lane)
 *                                     plumbing: backflow tests overdue / due within 60 days, failed tests needing a retest, water heater
 *                                     warranties expiring within 60 days, permits expiring or expired-open (same definitions as its lane)
 *   { op: 'set', industry }        -> same shape, after saving                       owner / admin only, audit-logged
 * Industry lives in tenants.settings (JSONB, no DDL). The write is keyed on the
 * caller's own tenant, so one company can never change another's industry.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { packForTenant } from "../industry/index.js";
import { resolveToday } from "../util/localDate.js";
import { industrySummaryFromSettings, industryChoices, setTenantIndustry, INDUSTRY_IDS } from "../industry/resolver.js";

export const config = { api: { bodyParser: { sizeLimit: "4kb" } }, maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let auth;
  try { auth = await requireAuth(req); } catch (err) { return denyAuth(res, err); }
  const body0 = req.body ?? {};
  if (!(await rateLimit(req, res, auth, body0.op === "set" ? "write" : "read"))) return;
  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  const body = req.body ?? {};
  const op = typeof body.op === "string" ? body.op : "get";
  try {
    if (op === "attention") {
      const pack = await packForTenant({ withTenant, ctxArg: ctx });
      if (pack.id !== "electrical" && pack.id !== "plumbing") return handleCors(res, req).status(200).json({ items: [] });
      const today = resolveToday(typeof body.today === "string" ? body.today : undefined);
      const attention = pack.id === "plumbing"
        ? (await import("../industry/plumbing/lane.js")).plumbingAttention
        : (await import("../industry/electrical/lane.js")).electricalAttention;
      const out = await withTenant(ctx, (store) => attention(store, { today, withinDays: 60 }));
      return handleCors(res, req).status(200).json(out);
    }
    if (op === "set") {
      if (hasShop(auth)) requireRole(auth, "admin");
      const industry = typeof body.industry === "string" ? body.industry.trim().toLowerCase() : "";
      if (!INDUSTRY_IDS.includes(industry)) return handleCors(res, req).status(400).json({ error: `industry must be one of: ${INDUSTRY_IDS.join(", ")}` });
      await withTenant(ctx, (store) => setTenantIndustry(store, industry, { clerkUserId: auth.userId ?? null, tenantKey: ctx.tenantKey, ifUnset: body.ifUnset === true }));
    } else if (op !== "get") {
      return handleCors(res, req).status(400).json({ error: "op must be one of: get, set, attention" });
    }
    const settings = await withTenant(ctx, async (store) => {
      const { rows } = await store.raw(`SELECT settings FROM tenants WHERE id = $1`, [store.tenantId]);
      return rows[0]?.settings ?? null;
    });
    return handleCors(res, req).status(200).json({ ...industrySummaryFromSettings(settings), choices: industryChoices() });
  } catch (err) {
    if (err instanceof AuthError) return denyAuth(res, err);
    return handleError(res, err);
  }
}
