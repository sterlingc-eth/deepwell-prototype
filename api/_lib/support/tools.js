/**
 * Round 28 — Support Assistant, READ-ONLY account lookups for signed-in surfaces (app / mobile).
 *
 * Two lookups, both fixed-shape and tiny:
 *   getPlanAndUsage(auth)        plan, billing state, dates (admins only), login cap, pages vs allowance, storage
 *   getRecentUploadStatus(auth)  documents received in the last 7 days by stage + how many have an open question
 *
 * Guarantees (asserted by a static scan in scripts/verify-support-assistant.mjs):
 *   - SELECT only: no INSERT/UPDATE/DELETE anywhere in this file.
 *   - The tenant comes ONLY from the verified `auth` object (Clerk session) — never from the request body,
 *     never from anything the visitor or the model typed. Every read runs inside withTenant (forced RLS).
 *   - No filenames, no extracted text, no customer names, no Stripe ids: counts, stage names and dates only.
 *     So an uploaded document can never inject text into the support bot, and nothing sensitive leaves the DB.
 */
import { withTenant, getTenantContext } from '../recordsStore.js';
import { planStateFor, PLAN_LIMITS, hasApiAccess } from '../plan.js';
import { TENANT_SQL } from '../scope.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000; // same trailing window api/billing.js computeStatus counts pages over
const STAGES = ['received', 'read', 'mapped', 'linked', 'verified'];

const ctxFor = (auth) => ({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId });
const isAdminOrSolo = (auth) => !auth?.orgId || auth?.orgRole === 'admin';
const iso = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null; };

/** @returns {Promise<object>} */
export async function getPlanAndUsage(auth) {
  const ctx = ctxFor(auth);
  const t = await getTenantContext(ctx.tenantKey, ctx.tenantName);
  const row = { billing_status: t.billingStatus, trial_ends_at: t.trialEndsAt, current_period_end: t.currentPeriodEnd };
  const plan = t.plan && Object.prototype.hasOwnProperty.call(PLAN_LIMITS, t.plan) ? t.plan : null;
  const limits = plan ? PLAN_LIMITS[plan] : null;
  const { documentsStored, pagesLast30d } = await withTenant(ctx, async (store) => ({
    documentsStored: await store.countDocuments(),
    pagesLast30d: await store.countPagesSince(new Date(Date.now() - MONTH_MS).toISOString()),
  }));
  const admin = isAdminOrSolo(auth);
  return {
    plan,
    state: planStateFor(row),
    canSeeBilling: admin,
    trialEndsAt: admin ? iso(t.trialEndsAt) : null,
    currentPeriodEnd: admin ? iso(t.currentPeriodEnd) : null,
    loginCap: limits ? limits.logins : null,       // null on Fleet = no DeepWell cap
    pagesLast30d,
    pagesAllowance: limits ? limits.pagesPerMonth : null,
    documentsStored,
    documentsCap: limits ? limits.documentsStored : null,
    apiAccess: hasApiAccess(plan),
  };
}

/** @returns {Promise<{days: number, total: number, byStage: Record<string, number>, openQuestions: number|null}>} */
export async function getRecentUploadStatus(auth) {
  return withTenant(ctxFor(auth), async (db) => {
    const { rows } = await db.raw(
      `SELECT stage, count(*)::int AS n FROM documents
        WHERE ${TENANT_SQL} AND created_at >= now() - interval '7 days'
        GROUP BY stage`, []);
    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
    let total = 0;
    for (const r of rows) { if (r.stage in byStage) { byStage[r.stage] = r.n; total += r.n; } }
    let openQuestions = null;
    try {
      const q = await db.raw(`SELECT count(*)::int AS n FROM intake_needs_info WHERE ${TENANT_SQL} AND status = 'open'`, []);
      openQuestions = q.rows[0]?.n ?? 0;
    } catch { openQuestions = null; } // migration 43 not applied: say nothing rather than guess
    return { days: 7, total, byStage, openQuestions };
  });
}
