/**
 * Per-tenant MONTHLY TOTAL AI allowance (owner directive 2026-10-30). Every paid Claude call (ingest vision/extraction,
 * handoffs, audits, support, learning) adds its estimated dollars to one monthly counter; Sonnet caps (agent/escalation.js)
 * are sub-limits INSIDE this total. State lives in the existing rate_limit_windows table (bucket AI_TOTAL_BUCKET, window =
 * first of the UTC month, units = micro-dollars): no migration. Customers never see dollars: the message names a reset date.
 *
 * Pure decision (decideAllowance) is separate from the DB read so the verify script can exercise it with the stub provider.
 * FAIL CLOSED: an unreadable counter or unknown plan means "allowance used" for PAID calls only. Donovan-alone / free-path
 * answering never calls this, so it keeps working.
 */
export const AI_TOTAL_BUCKET = "ai_total_usd_micro_month";
/** Monthly all-in ceiling by plan, USD. Plan ids are plan.js's (solo, shop = "Team", crew, fleet). Trial is a TOTAL for the whole trial. */
export const AI_MONTHLY_CEILING_USD = Object.freeze({ solo: 20, shop: 40, crew: 80, fleet: 180, trial: 8, demo: 0 });

const posNum = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n >= 0 ? n : null; };

/** Env override: AI_MONTHLY_CEILING_USD_<SOLO|SHOP|CREW|FLEET|TRIAL|DEMO>. Unknown plan -> 0 (fail closed). */
export function aiMonthlyCeilingUsd(plan, billingStatus, env = process.env) {
  const key = /trial/i.test(String(billingStatus ?? "")) ? "trial" : String(plan ?? "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(AI_MONTHLY_CEILING_USD, key)) return 0;
  return posNum(env?.[`AI_MONTHLY_CEILING_USD_${key.toUpperCase()}`]) ?? AI_MONTHLY_CEILING_USD[key];
}

export const monthStartUtc = (now = Date.now()) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
export const nextResetUtc = (now = Date.now()) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Customer-facing text. Never a dollar amount. */
export function allowanceMessage(now = Date.now()) {
  const r = nextResetUtc(now);
  return `Your AI allowance for this month is used; it resets on ${MONTHS[r.getUTCMonth()]} ${r.getUTCDate()}.`;
}

/** Pure: may a paid call start? spentUsd null = unreadable -> deny. */
export function decideAllowance({ plan, billingStatus, spentUsd, env = process.env }) {
  const ceilingUsd = aiMonthlyCeilingUsd(plan, billingStatus, env);
  if (ceilingUsd <= 0) return { allowed: false, why: "no-allowance", ceilingUsd };
  if (spentUsd === null || spentUsd === undefined || !Number.isFinite(spentUsd)) return { allowed: false, why: "spend-unreadable", ceilingUsd };
  if (spentUsd >= ceilingUsd) return { allowed: false, why: "monthly-ceiling", ceilingUsd, spentUsd };
  return { allowed: true, ceilingUsd, spentUsd };
}

export const isAllowanceEnabled = (env = process.env) => env?.AI_ALLOWANCE !== "0";

/** DB read through withTenant (RLS): plan + this month's spend. Never throws; failure -> deny (null spend). */
export async function allowanceStatus(withTenant, ctxArg, env = process.env, now = Date.now()) {
  try {
    const out = await withTenant(ctxArg, async (db) => {
      const t = await db.raw(`SELECT plan, billing_status FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid`, []);
      const s = await db.raw(
        `SELECT units FROM rate_limit_windows WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND bucket = $1 AND window_start = $2::timestamptz`,
        [AI_TOTAL_BUCKET, monthStartUtc(now).toISOString()]);
      return { plan: t.rows[0]?.plan, billingStatus: t.rows[0]?.billing_status, spentUsd: (Number(s.rows[0]?.units) || 0) / 1_000_000 };
    });
    return { ...decideAllowance({ ...out, env }), plan: out.plan };
  } catch {
    return { allowed: false, why: "spend-unreadable", ceilingUsd: 0 };
  }
}

/** Add dollars to this month's total. Best-effort, never throws. */
export async function recordAllowanceSpend(withTenant, ctxArg, usd, now = Date.now()) {
  const micro = Math.max(0, Math.min(2_000_000_000, Math.round((Number(usd) || 0) * 1_000_000)));
  if (!micro) return false;
  try {
    await withTenant(ctxArg, (db) => db.raw(
      `INSERT INTO rate_limit_windows (tenant_id, bucket, window_start, units)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2::timestamptz, $3)
       ON CONFLICT (tenant_id, bucket, window_start) DO UPDATE SET units = LEAST(2000000000, rate_limit_windows.units + EXCLUDED.units)`,
      [AI_TOTAL_BUCKET, monthStartUtc(now).toISOString(), micro]));
    return true;
  } catch { return false; }
}
