/**
 * Typed client for POST /api/account?action=expenses — the owners-only
 * expense tracker (handoffs/EXPENSES_2026-09-22.md). Same call()/authHeader
 * shape as followupsClient.ts/outreachClient.ts. Every sub-op is a POST with
 * an `op` field in the body (see api/_lib/routes/expenses.js). Every op
 * except `operatorStatus` 403s for anyone who isn't a DeepWell platform
 * operator — ExpensesScreen never renders for anyone else (see
 * AppShell.tsx's nav gate), but this client makes no assumption about that;
 * a 403 here is just an ordinary thrown error.
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const API_URL = '/api/account?action=expenses';

export class ExpensesApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ExpensesApiError';
    this.status = status;
  }
}

export const EXPENSE_CATEGORIES = [
  'Software & Subscriptions',
  'AI & Cloud Services',
  'Office Equipment',
  'Professional Services',
  'Marketing',
  'Vehicle & Transportation',
  'Travel & Meals',
  'Office & Operations',
  'Insurance',
  'Taxes & Fees',
  'Other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type ExpenseRangeKind = 'month' | 'year' | 'ytd' | 'custom';

export interface ExpenseRange {
  from: string | null;
  to: string | null;
}

export interface ExpenseRow {
  id: string;
  occurred_on: string;
  vendor: string;
  amount_cents: number;
  currency: string;
  category: ExpenseCategory;
  note: string | null;
  receipt_key: string | null;
  receipt_filename: string | null;
  source: 'manual' | 'receipt';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseFieldsInput {
  occurredOn: string;
  vendor: string;
  /** Either a display string ("$1,234.50", "21.66") or, if already known,
   *  amountCents directly — the server accepts either. */
  amount?: string;
  amountCents?: number;
  category: ExpenseCategory;
  note?: string | null;
  receiptKey?: string | null;
  receiptFilename?: string | null;
  source?: 'manual' | 'receipt';
}

export interface ExpenseCategoryTotal {
  category: string;
  totalCents: number;
  count: number;
}

export interface ExpenseMonthTotal {
  month: string;
  totalCents: number;
  count: number;
}

export interface ExpenseTotals {
  range: ExpenseRange;
  grandTotalCents: number;
  byCategory: ExpenseCategoryTotal[];
  byMonth: ExpenseMonthTotal[];
}

export interface ReceiptDraft {
  vendor: string;
  occurredOn: string | null;
  amountCents: number | null;
  category: ExpenseCategory;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.headers.get('content-type')?.includes('text/csv')) {
    return (await res.blob()) as unknown as T;
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    throw new ExpensesApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

/** Cheap, no-DB check: is the signed-in caller a DeepWell platform operator?
 *  Drives AppShell's Expenses nav item and ExpensesScreen's own self-guard.
 *  Never 403s — it answers the question rather than being gated by it. */
export function fetchExpensesOperatorStatus(): Promise<{ isOperator: boolean }> {
  return call({ op: 'operatorStatus' });
}

export function listExpenses(range: { range?: ExpenseRangeKind; from?: string; to?: string }): Promise<{ items: ExpenseRow[]; range: ExpenseRange }> {
  return call({ op: 'list', ...range });
}

export function addExpense(fields: ExpenseFieldsInput): Promise<{ id: string }> {
  return call({ op: 'add', ...fields });
}

export function updateExpense(id: string, fields: ExpenseFieldsInput): Promise<{ ok: true }> {
  return call({ op: 'update', id, ...fields });
}

export function deleteExpense(id: string): Promise<{ ok: true }> {
  return call({ op: 'delete', id });
}

export function fetchExpenseTotals(range: { range?: ExpenseRangeKind; from?: string; to?: string }): Promise<ExpenseTotals> {
  return call({ op: 'totals', ...range });
}

export function requestReceiptUploadUrl(filename: string, contentType: string): Promise<{ receiptKey: string; uploadUrl: string }> {
  return call({ op: 'receiptUploadUrl', filename, contentType });
}

/** PUTs the file's bytes straight to the presigned R2 URL — same idiom as
 *  ingestClient.ts's upload step, no server round trip for the bytes themselves. */
export async function uploadReceiptBytes(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new ExpensesApiError(`Upload failed: ${res.status}`, res.status);
}

export function extractReceipt(receiptKey: string, contentType: string): Promise<{ draft: ReceiptDraft }> {
  return call({ op: 'receiptExtract', receiptKey, contentType });
}

/** Triggers a browser download of the CSV — the response is a Blob (see
 *  `handle` above), not JSON. */
export async function exportExpensesCsv(range: { range?: ExpenseRangeKind; from?: string; to?: string }): Promise<void> {
  const blob = await call<Blob>({ op: 'exportCsv', ...range });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deepwell-expenses.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Only succeeds (seeded: true) the first time, while the table is empty —
 *  see ExpensesScreen's "Seed starter entries" button. */
export function seedInitialExpenses(): Promise<{ seeded: boolean; count?: number; reason?: string }> {
  return call({ op: 'seedInitial' });
}
