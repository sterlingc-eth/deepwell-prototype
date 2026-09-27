/**
 * Proactive insights — money detectors (R17 contract, items 2 + 3).
 *
 * Reuses api/_lib/financials/answers.js's own SQL runners (runMoneyIntent)
 * and api/_lib/financials/jobCosting.js's computeJobCosts — never
 * re-implements the `financials` view/scope rules (REVENUE_WHERE, USD-only,
 * printed-total-only, etc.) those files already encode. Also reuses
 * financialsSummary() for the one clean total/count pair (overdue total
 * dollars + invoice count) rather than re-deriving it from runMoneyIntent's
 * chat-shaped text.
 *
 * Both runMoneyIntent and computeJobCosts operate directly on `db` (they
 * never open their own withTenant), so calling them here from inside the
 * insights route's own transaction is safe — no nested transaction.
 */
import { tenantHasFinancialRows } from '../../financials/store.js';
import { runMoneyIntent, financialsSummary } from '../../financials/answers.js';
import { computeJobCosts } from '../../financials/jobCosting.js';

const MAX_ITEMS = 8;

/** A financials-answer's own `.records` (attachCitations' normalized shape —
 *  {type, id, label, sublabel, documentId, customerId}) -> insight items,
 *  grouped back to one row per record (never per document) and capped. */
function itemsFromRecords(records, { customerIdField = 'customerId' } = {}) {
  return (records ?? []).slice(0, MAX_ITEMS).map((r) => ({
    label: [r.label, r.sublabel].filter(Boolean).join(' · '),
    entityId: r[customerIdField] ?? (r.type === 'customer' ? r.id : null),
    documentIds: r.documentId ? [r.documentId] : [],
  }));
}

/** Item 2a: quotes with no invoice dated on or after them for the same
 *  customer — the exact "waiting" rule quotesWaiting() already answers with
 *  in chat (api/_lib/financials/answers.js), reused verbatim via
 *  runMoneyIntent rather than re-querying document_financials. */
async function detectQuotesWaiting(db, { today }) {
  const answer = await runMoneyIntent(db, { intent: 'quotes_waiting', period: null, subject: null, raw: '', rawOriginal: '' }, { today });
  const n = answer?.recordsTotal ?? 0;
  if (!n) return null;
  return {
    id: 'quotes-not-invoiced',
    kind: 'financial',
    severity: 'medium',
    title: 'Quotes waiting on an invoice',
    count: n,
    items: itemsFromRecords(answer.records),
    action: { label: 'Ask about waiting quotes', href: 'ask:Do we have any quotes waiting on a customer?' },
  };
}

/** Item 2b: "work done with no invoice" — a job (address) with a cost
 *  document (vendor bill/PO) on file but no revenue document at all, from
 *  computeJobCosts' own job grouping (never re-derived). */
async function detectWorkNoInvoice(db) {
  const { jobs } = await computeJobCosts(db, {});
  const noInvoice = jobs.filter((j) => j.hasCost && !j.hasRevenue);
  if (!noInvoice.length) return null;
  noInvoice.sort((a, b) => Number(b.cost) - Number(a.cost));
  const dollars = noInvoice.reduce((sum, j) => sum + Number(j.cost || 0), 0);
  return {
    id: 'work-no-invoice',
    kind: 'financial',
    severity: 'high',
    title: 'Work done with no invoice',
    count: noInvoice.length,
    dollars: Math.round(dollars * 100) / 100,
    items: noInvoice.slice(0, MAX_ITEMS).map((j) => ({
      label: `${j.address || j.jobKey} — ${j.costDocs.length} cost document${j.costDocs.length === 1 ? '' : 's'}, no invoice on file`,
      entityId: null,
      documentIds: j.costDocs.map((d) => d.documentId).filter(Boolean),
    })),
    action: { label: 'Ask about unbilled jobs', href: 'ask:Which jobs have cost documents but no invoice?' },
  };
}

/** Item 3: overdue receivables — total/count from financialsSummary() (the
 *  same document_financials-effective-value predicates the Dashboard's own
 *  FinancialsCard already reads), top customers from the balance-leaderboard
 *  answer (ranked by open balance, capped at 5 by that handler itself). */
async function detectOverdueReceivables(db, { today }) {
  const summary = await financialsSummary(db, { today });
  const n = summary?.overdue?.invoices ?? 0;
  if (!n) return null;
  const leaderboard = await runMoneyIntent(db, { intent: 'balance_leaderboard', period: null, subject: null, raw: '', rawOriginal: '' }, { today });
  return {
    id: 'overdue-receivables',
    kind: 'financial',
    severity: summary.overdue.total >= 10000 ? 'high' : summary.overdue.total >= 1000 ? 'medium' : 'low',
    title: 'Overdue receivables',
    count: n,
    dollars: Math.round(Number(summary.overdue.total) * 100) / 100,
    items: itemsFromRecords(leaderboard?.records),
    action: { label: 'Ask about overdue invoices', href: 'ask:Which invoices are overdue?' },
  };
}

/** @returns {Promise<object[]>} zero to three insight objects; never throws
 *  (a single detector's own failure is dropped, not fatal to the rest). */
export async function detectFinancialInsights(db, { today } = {}) {
  if (!(await tenantHasFinancialRows(db))) return [];
  const results = await Promise.allSettled([
    detectQuotesWaiting(db, { today }),
    detectWorkNoInvoice(db),
    detectOverdueReceivables(db, { today }),
  ]);
  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}
