/**
 * Proactive insights (R17 contract, G1): "Donovan surfaces what needs
 * attention before anyone asks." Deterministic, tenant-scoped, cited — no
 * model call anywhere in this file or anything it calls.
 *
 * Orchestrates the four detector families, each of which reuses an existing
 * engine rather than re-deriving its rule (see each detector's own header):
 *   1. warranty.js       — warrantyRules.js / analytics.js's registration split (R16)
 *   2/3. financials.js   — financials/answers.js (runMoneyIntent) + jobCosting.js
 *   4. repeatFailures.js — relations/connect2.js + relations/timeline.js
 *   5. dataGaps.js        — intake/queue.js + a plain completeness count
 *
 * Caching: computeInsights() is the expensive path (several SQL scans); the
 * route (api/_lib/routes/insights.js) is what wraps it with
 * insights/store.js's corpus_stamp cache so a repeat read of an unchanged
 * tenant is cheap. This file has no cache of its own — it always computes.
 */
import { detectWarrantyInsights } from './detectors/warranty.js';
import { detectFinancialInsights } from './detectors/financials.js';
import { detectRepeatFailureInsights } from './detectors/repeatFailures.js';
import { detectDataGapInsights } from './detectors/dataGaps.js';

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/** severity x dollars, per the contract's own ranking rule — a $0/undollared
 *  insight (warranty, repeat-failure, data-gap) ranks purely by severity;
 *  a dollared one (financial) is boosted further by its own size, without
 *  letting a huge dollar figure alone outrank a `high`-severity zero-dollar
 *  insight of the same tier (log-scaled, not linear). */
function score(insight) {
  const weight = SEVERITY_WEIGHT[insight.severity] ?? 1;
  const dollars = Number.isFinite(insight.dollars) ? insight.dollars : 0;
  return weight * 1000 + Math.log10(1 + Math.max(0, dollars)) * 10;
}

/**
 * @param {object} db  the caller's own tenant-scoped store (already inside a
 *   withTenant transaction) — never opens a transaction of its own.
 * @param {{today: string}} opts
 * @returns {Promise<{items: object[], generatedAt: string}>}
 */
/**
 * Owner decision (2026-09-26): money insights (quotes never invoiced, work with no invoice, overdue receivables)
 * are OFF by default. DeepWell only sees uploaded documents, so a payment recorded in the shop's accounting system
 * would surface here as a false "overdue" / "never invoiced" alarm. Enable per deployment with
 * DONOVAN_INSIGHTS_MONEY=1 (intended once a ledger integration — QuickBooks/Xero — makes payment status authoritative).
 */
export function moneyInsightsEnabled(env = process.env) {
  return String(env.DONOVAN_INSIGHTS_MONEY ?? '').trim() === '1';
}

export async function computeInsights(db, { today, includeMoney = moneyInsightsEnabled() } = {}) {
  const t = today || new Date().toISOString().slice(0, 10);
  const results = await Promise.allSettled([
    detectWarrantyInsights(db, { today: t }),
    includeMoney ? detectFinancialInsights(db, { today: t }) : Promise.resolve([]),
    detectRepeatFailureInsights(db, { today: t }),
    detectDataGapInsights(db, { today: t }),
  ]);
  const items = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value ?? []);
  for (const r of results) {
    if (r.status === 'rejected') console.error('insights: a detector failed (skipped, not fatal):', r.reason?.message ?? r.reason);
  }
  items.sort((a, b) => score(b) - score(a));
  return { items, generatedAt: new Date().toISOString() };
}
