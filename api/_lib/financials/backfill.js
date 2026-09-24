/**
 * Financials layer — backfill for documents extracted before the layer existed.
 *
 * Operator/admin action (POST /api/account?action=financials {op:'backfill'}), called
 * repeatedly by the UI until `remaining` reaches 0. Each invocation:
 *   - takes the next batch of money-kind documents (invoice / proposal-quote /
 *     purchase-order / maintenance-agreement) that have stored page text (no re-OCR) and no
 *     financials row yet, oldest id first;
 *   - makes AT MOST `maxCalls` model calls (default 20, hard cap 40) and stops early at
 *     `maxCostUsd` (default 0.15), a wall-clock deadline, or the tenant's daily model budget;
 *   - is idempotent: a document with a row is never selected again, and a row a person
 *     corrected or verified is never overwritten (extract.js).
 *
 * `afterId` (returned as `nextCursor`) lets one paging session step past a document that
 * failed, so a single bad document cannot pin the loop; the next session retries it.
 */
import { withTenant } from '../recordsStore.js';
import { extractFinancialsForDocument } from './extract.js';
import { FINANCIAL_DOCUMENT_TYPES } from './normalize.js';
import { listBackfillCandidates, backfillCounts, financialsTableExists } from './store.js';

export const BACKFILL_DEFAULTS = Object.freeze({ maxCalls: 20, hardMaxCalls: 40, maxCostUsd: 0.15, deadlineMs: 45_000, concurrency: 4 });

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{maxCalls?: number, maxCostUsd?: number, deadlineMs?: number, afterId?: string|null,
 *          concurrency?: number, callModel?: Function, withTenantFn?: Function, skipBudget?: boolean, today?: string}} [opts]
 */
export async function runFinancialsBackfill(ctx, opts = {}) {
  const wt = opts.withTenantFn ?? withTenant;
  const maxCalls = Math.max(1, Math.min(BACKFILL_DEFAULTS.hardMaxCalls, Math.trunc(Number(opts.maxCalls)) || BACKFILL_DEFAULTS.maxCalls));
  const maxCostUsd = Number.isFinite(Number(opts.maxCostUsd)) && Number(opts.maxCostUsd) > 0 ? Number(opts.maxCostUsd) : BACKFILL_DEFAULTS.maxCostUsd;
  const deadlineAt = Date.now() + (Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : BACKFILL_DEFAULTS.deadlineMs);
  const concurrency = Math.max(1, Math.min(6, Math.trunc(Number(opts.concurrency)) || BACKFILL_DEFAULTS.concurrency));

  const enabled = await wt(ctx, (db) => financialsTableExists(db));
  if (!enabled) return { enabled: false, processed: 0, written: 0, skipped: 0, failed: 0, modelCalls: 0, costUsd: 0, remaining: 0, eligible: 0, nextCursor: null, stoppedReason: 'table_missing' };

  const candidates = await wt(ctx, (db) => listBackfillCandidates(db, { afterId: opts.afterId ?? null, limit: maxCalls, documentTypes: [...FINANCIAL_DOCUMENT_TYPES] }));
  const out = { enabled: true, processed: 0, written: 0, skipped: 0, failed: 0, modelCalls: 0, costUsd: 0, stoppedReason: null };
  let cursor = opts.afterId ?? null;
  let i = 0;
  let stop = false;

  const worker = async () => {
    while (!stop) {
      const c = candidates[i++];
      if (!c) return;
      if (Date.now() > deadlineAt) { stop = true; out.stoppedReason = 'deadline'; return; }
      if (out.costUsd >= maxCostUsd) { stop = true; out.stoppedReason = 'cost_cap'; return; }
      if (out.modelCalls >= maxCalls) { stop = true; out.stoppedReason = 'call_cap'; return; }
      out.modelCalls++; // reserved before the await so concurrent workers respect the cap
      try {
        const r = await extractFinancialsForDocument(ctx, c.id, {
          withTenant: wt, callModel: opts.callModel, documentType: c.document_type, modelAttempts: 1, skipBudget: opts.skipBudget, today: opts.today,
        });
        out.processed++;
        out.costUsd += r.costUsd ?? 0;
        if (r.modelCalls === 0) out.modelCalls--; // nothing was billed (skipped before the call)
        if (r.status === 'written') out.written++;
        else if (r.status === 'skipped') out.skipped++;
        else out.failed++;
      } catch (err) {
        if (err?.name === 'ModelBudgetExceededError') { stop = true; out.stoppedReason = 'daily_budget'; out.modelCalls--; return; }
        out.processed++; out.failed++;
      }
      if (cursor == null || c.id > cursor) cursor = c.id;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

  const counts = await wt(ctx, (db) => backfillCounts(db, { documentTypes: [...FINANCIAL_DOCUMENT_TYPES] }));
  out.costUsd = Math.round(out.costUsd * 10000) / 10000;
  if (!out.stoppedReason) out.stoppedReason = candidates.length === 0 ? 'done' : 'batch_complete';
  return { ...out, eligible: counts.eligible, remaining: counts.remaining, nextCursor: candidates.length ? cursor : null };
}

export async function financialsBackfillStatus(ctx, { withTenantFn } = {}) {
  const wt = withTenantFn ?? withTenant;
  return wt(ctx, (db) => backfillCounts(db, { documentTypes: [...FINANCIAL_DOCUMENT_TYPES] }));
}
