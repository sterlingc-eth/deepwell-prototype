/**
 * Proactive insights — HTTP surface (POST /api/account?action=insights), R17 contract (G1).
 *
 * "Donovan surfaces what needs attention before anyone asks" — a small, ranked "Needs attention"
 * list computed deterministically (no model call anywhere in api/_lib/insights/**) from existing
 * engines: warrantyRules/analytics (warranty), financials/answers + jobCosting (money),
 * relations/connect2 + relations/timeline (repeat failures/callbacks), intake/queue (data gaps).
 * See api/_lib/insights/detect.js for the orchestration and each detectors/*.js file for which
 * engine it reuses.
 *
 *   POST /api/account?action=insights  { limit?, offset? }
 *     -> { items: Insight[], total, generatedAt, cached }
 *
 *   Insight = { id, kind, severity, title, count, dollars?, items: [{label, entityId, documentIds}],
 *               action: { label, href } }
 *
 * Cached per tenant (api/_lib/insights/store.js), keyed by the same corpus_stamp expression the
 * exact-match ask cache and the rollups already share — a repeat read of an unchanged tenant skips
 * the compute pass entirely (budget: <150ms warm). Any authenticated tenant member may call this —
 * read-only, no admin gate, same bar as ask-suggest.js's own ops.
 */
import { requireAuth, denyAuth, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { computeInsights, moneyInsightsEnabled } from "../insights/detect.js";
import { getCachedInsights, setCachedInsights, getCorpusStamp } from "../insights/store.js";

export const config = { api: { bodyParser: { sizeLimit: "8kb" } }, maxDuration: 30 };

const clampInt = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "read"))) return;

  const body = req.body ?? {};
  const limitN = clampInt(body.limit, 8, 1, 50);
  const offset = clampInt(body.offset, 0, 0, 1000);
  const today = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    const { items, generatedAt, cached } = await withTenant(ctx, async (db) => {
      const hit = await getCachedInsights(db, { today });
      if (hit) return { items: hit.payload.items ?? [], generatedAt: hit.payload.generatedAt, cached: true };

      const computed = await computeInsights(db, { today });
      const corpusStamp = await getCorpusStamp(db, { today });
      if (corpusStamp != null) await setCachedInsights(db, corpusStamp, computed);
      return { ...computed, cached: false };
    });

    // Money insights are off unless explicitly enabled (see detect.js moneyInsightsEnabled) — also filtered here so
    // a cache row written while the flag was on never leaks them after it is turned off.
    const visible = moneyInsightsEnabled() ? items : items.filter((i) => i?.kind !== 'financial');
    const page = visible.slice(offset, offset + limitN);
    return handleCors(res, req).status(200).json({ items: page, total: visible.length, generatedAt, cached });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}
