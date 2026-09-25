/**
 * TEAM H (2026-09-24): per-tenant / platform daily SPEND CAPS for the
 * autonomous per-tenant learning loop (autopilot.js). Pure — no DB, no
 * model, no I/O — a small stateful accumulator the orchestrator threads
 * through one nightly invocation.
 *
 * DONOVAN_LEARNING_DAILY_USD (default $0.25) — one tenant's whole nightly
 *   slice (replay + auto-exam + vocab-mining labeling, together).
 * DONOVAN_LEARNING_PLATFORM_DAILY_USD (default $10) — the whole night's
 *   spend across every tenant.
 *
 * Enforced WITHIN one sweep invocation (the nightly cron step is itself
 * claimed at most once per UTC day per tenant — see autopilot.js's use of
 * claim_platform_daily_task — so "this run's spend" already IS "today's
 * spend" for the tenants it actually touches). Never counts against a
 * customer's own monthly Ask allowance — see learning/replay.js's own doc
 * comment; this is a separate, model-spend-only ceiling for the autonomous
 * loop itself.
 */

export const DEFAULT_TENANT_DAILY_USD = 0.25;
export const DEFAULT_PLATFORM_DAILY_USD = 10;

export function tenantDailyCapUsd(env = process.env) {
  const n = Number(env?.DONOVAN_LEARNING_DAILY_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TENANT_DAILY_USD;
}

export function platformDailyCapUsd(env = process.env) {
  const n = Number(env?.DONOVAN_LEARNING_PLATFORM_DAILY_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PLATFORM_DAILY_USD;
}

/**
 * A fresh spend tracker for one nightly run.
 * @param {{platformCapUsd?: number, tenantCapUsd?: number}} [opts]
 */
export function createSpendTracker({ platformCapUsd, tenantCapUsd } = {}) {
  const platformCap = Number.isFinite(platformCapUsd) && platformCapUsd > 0 ? platformCapUsd : platformDailyCapUsd();
  const tenantCap = Number.isFinite(tenantCapUsd) && tenantCapUsd > 0 ? tenantCapUsd : tenantDailyCapUsd();
  let platformSpent = 0;
  const perTenant = new Map();

  const platformRemaining = () => Math.max(0, platformCap - platformSpent);
  const tenantRemaining = (tenantKey) => Math.max(0, tenantCap - (perTenant.get(tenantKey) ?? 0));

  return {
    platformCap,
    tenantCap,
    platformRemaining,
    tenantRemaining,
    /** How much a tenant may spend right now: never more than either cap has left. */
    allowanceFor(tenantKey) {
      return Math.max(0, Math.min(tenantRemaining(tenantKey), platformRemaining()));
    },
    record(tenantKey, amountUsd) {
      const a = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
      if (!a) return;
      platformSpent += a;
      perTenant.set(tenantKey, (perTenant.get(tenantKey) ?? 0) + a);
    },
    platformExhausted: () => platformSpent >= platformCap,
    platformSpentUsd: () => Math.round(platformSpent * 10000) / 10000,
    tenantSpentUsd: (tenantKey) => Math.round((perTenant.get(tenantKey) ?? 0) * 10000) / 10000,
  };
}
