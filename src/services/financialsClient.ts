/**
 * Typed client for POST /api/account?action=financials (api/_lib/routes/financials.js).
 * Every op is a POST with an `op` field. `enabled: false` means the M3-config/22 migration has not
 * been applied yet — callers hide their UI rather than show an error.
 */
import { authHeader } from './authToken';

const API_URL = '/api/account?action=financials';

export class FinancialsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FinancialsApiError';
    this.status = status;
  }
}

export type FinancialFieldKey =
  | 'invoice_number' | 'invoice_date' | 'due_date' | 'subtotal' | 'tax' | 'total'
  | 'amount_paid' | 'balance_due' | 'status' | 'vendor_name' | 'agreement_term' | 'po_number';

export interface FinancialField {
  /** Effective value: the correction when there is one, else what was read. */
  value: string | null;
  /** What was read off the document, kept beside any correction. */
  original: string | null;
  corrected: boolean;
  evidence: { page: number | null; verbatim: string | null; confidence: number | null } | null;
}

export interface DocumentFinancials {
  documentId: string;
  docKind: string;
  direction: 'receivable' | 'payable';
  currency: string;
  confidence: number | null;
  flags: string[];
  needsReview: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  correctedBy: string | null;
  fields: Partial<Record<FinancialFieldKey, FinancialField>>;
  lines: { lineNo: number; description: string | null; qty: string | null; unitPrice: string | null; amount: string | null; page: number | null }[];
}

export interface DocumentFinancialsResponse { enabled: boolean; financials: DocumentFinancials | null }

export interface FinancialsReviewItem {
  documentId: string;
  filename: string;
  docKind: string;
  invoiceNumber: string | null;
  total: string | null;
  flags: string[];
  confidence: number | null;
}

export interface FinancialsSummary {
  enabled: boolean;
  month?: { label: string; total: string; invoices: number };
  ytd?: { label: string; total: string; invoices: number };
  open?: { total: string; invoices: number };
  overdue?: { total: string; invoices: number };
  aging?: { current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; noDueDate: string };
  excluded?: { noTotal: number; undated: number };
  needsReview?: number;
  documents?: number;
}

export interface BackfillStatus { enabled: boolean; eligible: number; done: number; remaining: number }

export interface BackfillResult {
  enabled: boolean;
  processed: number;
  written: number;
  skipped: number;
  failed: number;
  remaining: number;
  stoppedReason: string;
  nextCursor?: string | null;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON */
    }
    throw new FinancialsApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export const financialsClient = {
  document: (documentId: string) => call<DocumentFinancialsResponse>({ op: 'document', documentId }),
  correct: (documentId: string, field: FinancialFieldKey, value: string, by: string) =>
    call<DocumentFinancialsResponse>({ op: 'correct', documentId, field, value, by }),
  verify: (documentId: string, by: string) => call<DocumentFinancialsResponse>({ op: 'verify', documentId, by }),
  needsReview: () => call<{ enabled: boolean; items: FinancialsReviewItem[] }>({ op: 'needsReview' }),
  summary: () => call<FinancialsSummary>({ op: 'summary' }),
  backfillStatus: () => call<BackfillStatus>({ op: 'backfillStatus' }),
  backfill: (afterId?: string | null) => call<BackfillResult>({ op: 'backfill', ...(afterId ? { afterId } : {}) }),
};

/** "1240.50" -> "$1,240.50" (display only; never used to add amounts up). */
export function formatMoney(v: string | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const FLAG_LABEL: Record<string, string> = {
  total_mismatch: "Subtotal + tax doesn't equal the total",
  lines_mismatch: "Line items don't add up to the subtotal",
  line_math: "A line's quantity x price doesn't equal its amount",
  balance_mismatch: "Total minus paid doesn't equal the balance",
  status_conflict: "The printed status disagrees with the balance",
  amount_not_on_page: 'An amount could not be found on the page and was left blank',
  no_total: 'No total is printed',
  due_before_invoice: 'Due date is before the invoice date',
  non_usd: 'Not in US dollars (left out of totals)',
};
