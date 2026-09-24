/**
 * Financials layer — the one-line hooks other files call (queue.js's extract-fields function
 * and api/extract.js's inline path). Best-effort by construction: a financial extraction
 * problem of ANY kind (model error, budget cap, table not migrated yet) is logged by name only
 * and swallowed, because the document's main extraction has already succeeded and the
 * backfill (backfill.js) will pick up whatever this missed.
 *
 * FINANCIALS=0 switches the whole layer off at the extraction side.
 */
import { withTenant } from '../recordsStore.js';
import { extractFinancialsForDocument } from './extract.js';
import { isFinancialDocumentType } from './normalize.js';

export function isFinancialsEnabled(env = process.env) {
  return env?.FINANCIALS !== '0';
}

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {string} documentId
 * @param {{documentType?: string, modelAttempts?: number}} [opts]
 * @returns {Promise<{status: string, reason?: string}>} never throws
 */
export async function extractFinancialsBestEffort(ctx, documentId, opts = {}) {
  if (!isFinancialsEnabled()) return { status: 'skipped', reason: 'disabled' };
  if (opts.documentType && !isFinancialDocumentType(opts.documentType)) return { status: 'skipped', reason: 'not_financial' };
  try {
    return await extractFinancialsForDocument(ctx, documentId, { withTenant, documentType: opts.documentType, modelAttempts: opts.modelAttempts });
  } catch (err) {
    console.error('financials: extraction skipped:', err?.name === 'ModelBudgetExceededError' ? 'model budget' : err?.name ?? 'error');
    return { status: 'failed', reason: err?.name === 'ModelBudgetExceededError' ? 'budget' : 'error' };
  }
}
