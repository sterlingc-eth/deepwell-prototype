/**
 * POST /api/account?action=expenses — the OWNERS-ONLY EXPENSE TRACKER
 * (handoffs/EXPENSES_2026-09-22.md). DeepWell's own business expenses —
 * software, AI/cloud spend, travel — never a tenant's data and never
 * reachable by one. Every op below (except `operatorStatus`, which answers
 * exactly the question "am I allowed to see this") is gated by
 * isPlatformOperator BEFORE any DB or rate-limit work, same gate and same
 * ordering as api/review.js's OPERATOR_ACTIONS (missDigest, learningList,
 * ...): a forged non-operator request never causes a DB round trip or a
 * rate-limit counter write on its way to the 403.
 *
 * Sub-ops (body.op):
 *   operatorStatus                          -> { isOperator }
 *   list      { range?, from?, to? }        -> { items, range }
 *   add       { occurredOn, vendor, amount|amountCents, category, note?, receiptKey?, receiptFilename?, source? } -> { id }
 *   update    { id, ...same fields as add } -> { ok }
 *   delete    { id }                        -> { ok }
 *   totals    { range?, from?, to? }        -> { range, grandTotalCents, byCategory, byMonth }
 *   receiptUploadUrl { filename, contentType } -> { receiptKey, uploadUrl }
 *   receiptExtract   { receiptKey, contentType } -> { draft: {vendor, occurredOn, amountCents, category} }
 *   exportCsv { range?, from?, to? }        -> text/csv response (not JSON)
 *   seedInitial                             -> { seeded, count } — only when the table is empty
 *
 * Storage: api/_lib/expensesStore.js (platform_expenses, SECURITY DEFINER
 * functions from M3-config/28-expenses.sql). A migration that hasn't been
 * pasted yet surfaces as ExpensesMigrationPendingError, mapped to a clean
 * 503 below rather than a raw 500 — same "degrade, don't break" contract as
 * every other cross-tenant table in this codebase.
 */
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth, denyAuth } from '../auth.js';
import { handleCors, handleError, getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { limit as rateLimit } from '../rateLimit.js';
import { isPlatformOperator } from '../missDigest.js';
import { presign, getObject } from '../r2.js';
import {
  EXPENSE_CATEGORIES,
  isValidExpenseCategory,
  parseAmountToCents,
  MAX_EXPENSE_CENTS,
  buildExpensesCsv,
  resolveExpenseDateRange,
  shapeExpenseTotals,
  listExpenses,
  insertExpense,
  updateExpense,
  deleteExpense,
  totalsExpenses,
  ExpensesMigrationPendingError,
} from '../expensesStore.js';

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

/** Thrown for a bad request body. `.status` is the HTTP status to report. */
class ExpensesValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExpensesValidationError';
    this.status = status;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidIsoDate(s) {
  return typeof s === 'string' && ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rangeFromBody(body) {
  const range = typeof body?.range === 'string' ? body.range : null;
  if (range) return resolveExpenseDateRange(range, new Date(), { from: body?.from ?? null, to: body?.to ?? null });
  return { from: typeof body?.from === 'string' ? body.from : null, to: typeof body?.to === 'string' ? body.to : null };
}

/** Shared by `add`/`update`: validate and normalize the editable fields.
 *  Throws ExpensesValidationError on anything wrong. */
export function validateExpenseFields(body) {
  const occurredOn = body?.occurredOn;
  if (!isValidIsoDate(occurredOn)) throw new ExpensesValidationError('occurredOn must be a YYYY-MM-DD date');

  const vendor = typeof body?.vendor === 'string' ? body.vendor.trim() : '';
  if (!vendor) throw new ExpensesValidationError('vendor is required');

  const category = body?.category;
  if (!isValidExpenseCategory(category)) {
    throw new ExpensesValidationError(`category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`);
  }

  let amountCents;
  if (typeof body?.amountCents === 'number' && Number.isFinite(body.amountCents)) {
    amountCents = Math.round(body.amountCents);
  } else {
    amountCents = parseAmountToCents(body?.amount);
  }
  if (amountCents === null || amountCents === undefined || !Number.isFinite(amountCents)) {
    throw new ExpensesValidationError('amount must be a dollar amount like "21.66" or "$1,234.50"');
  }
  if (Math.abs(amountCents) > MAX_EXPENSE_CENTS) {
    throw new ExpensesValidationError('amount must be $1,000,000.00 or less');
  }

  const note = typeof body?.note === 'string' ? body.note.slice(0, 2000) : null;
  const receiptKey = typeof body?.receiptKey === 'string' ? body.receiptKey : null;
  const receiptFilename = typeof body?.receiptFilename === 'string' ? body.receiptFilename.slice(0, 300) : null;
  const source = body?.source === 'receipt' || body?.source === 'manual' ? body.source : (receiptKey ? 'receipt' : 'manual');

  return { occurredOn, vendor, amountCents, currency: 'USD', category, note, receiptKey, receiptFilename, source };
}

/* --------------------------------------------------- receipt attachments */

// What the model will actually read. Same allowed set as upload-url.js's
// MODEL_READ_TYPES — a receipt is always a photo or a scanned PDF.
const RECEIPT_TYPES = /^(application\/pdf|image\/(jpeg|png|gif|webp))$/;
const MAX_RECEIPT_BYTES = 24 * 1024 * 1024; // matches upload-url.js's MODEL_READ_TYPES ceiling

async function handleReceiptUploadUrl(body) {
  const contentType = body?.contentType;
  if (typeof contentType !== 'string' || !RECEIPT_TYPES.test(contentType)) {
    throw new ExpensesValidationError('contentType must be a PDF or a photo (jpeg/png/gif/webp)');
  }
  const key = `platform/expenses/${crypto.randomUUID()}`;
  let uploadUrl;
  try {
    uploadUrl = presign('PUT', key, 900);
  } catch (err) {
    const e = new ExpensesValidationError('File storage is not configured for this environment.', 503);
    e.cause = err;
    throw e;
  }
  return { receiptKey: key, uploadUrl };
}

export const EXPENSE_EXTRACT_MODEL = process.env.EXPENSE_EXTRACT_MODEL || process.env.EXTRACT_MODEL || 'claude-haiku-4-5';

const RECEIPT_EXTRACT_TOOL = {
  name: 'extract_receipt',
  description:
    'Read this receipt or invoice and return the vendor, the transaction date, the total amount charged, ' +
    'and which expense category it most likely belongs to. Never guess a value the document does not show.',
  input_schema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'The vendor/merchant name as printed.' },
      date: { type: 'string', description: 'Transaction date as YYYY-MM-DD. Omit if illegible or not printed.' },
      total: { type: 'string', description: 'The total amount charged, as a bare number with no currency symbol or commas, e.g. "21.66".' },
      category: { type: 'string', enum: [...EXPENSE_CATEGORIES], description: 'Best-guess category from this fixed list.' },
    },
    required: ['vendor', 'total', 'category'],
  },
};

async function handleReceiptExtract(body) {
  const receiptKey = body?.receiptKey;
  if (typeof receiptKey !== 'string' || !receiptKey.startsWith('platform/expenses/')) {
    throw new ExpensesValidationError('receiptKey is required');
  }
  const contentType = typeof body?.contentType === 'string' && RECEIPT_TYPES.test(body.contentType) ? body.contentType : 'image/jpeg';

  const bytes = await getObject(receiptKey);
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new ExpensesValidationError('Receipt is too large to read (24 MB limit)', 413);
  }
  const data = bytes.toString('base64');
  const source =
    contentType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: contentType, data } };

  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  const startedAt = Date.now();
  const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
  const response = await withBackoff(
    () =>
      client.messages.create(
        {
          model: EXPENSE_EXTRACT_MODEL,
          max_tokens: 300,
          tools: [RECEIPT_EXTRACT_TOOL],
          tool_choice: { type: 'tool', name: RECEIPT_EXTRACT_TOOL.name },
          messages: [{ role: 'user', content: [source, { type: 'text', text: 'Extract this receipt.' }] }],
        },
        { timeout: Math.max(1000, deadlineAt - Date.now()) }
      ),
    { deadlineAt }
  );

  // Cost is real but tiny (Haiku, one small image, ~300 output tokens — see
  // handoffs/EXPENSES_2026-09-22.md for the measured ~$0.002/receipt) and is
  // DeepWell's own operating cost, not billed to any tenant — so unlike
  // extractDocument.js's recordModelCall this is a log line, not a usage row.
  console.log(
    JSON.stringify({
      event: 'expenses.receipt_extract',
      model: EXPENSE_EXTRACT_MODEL,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    })
  );

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  const input = toolUse?.input ?? {};
  const category = isValidExpenseCategory(input.category) ? input.category : 'Other';
  const amountCents = parseAmountToCents(input.total);
  const occurredOn = isValidIsoDate(input.date) ? input.date : null;

  return {
    draft: {
      vendor: typeof input.vendor === 'string' ? input.vendor : '',
      occurredOn,
      amountCents,
      category,
    },
  };
}

/* ------------------------------------------------------------------ CSV */

function ymdRangeLabel({ from, to }) {
  return `${from ?? 'all'}_to_${to ?? 'all'}`;
}

/* --------------------------------------------------------------- seed */

const SEED_ROWS = [
  { occurredOn: '2026-09-11', vendor: 'Anthropic', amount: '21.66', note: 'Claude Max 20 — $200/mo, prorated (invoice ZRI2RP7U-0001)' },
  { occurredOn: '2026-09-13', vendor: 'Anthropic', amount: '168.10', note: 'Claude Max 20 — prorated (invoice ROZEYCXP-0005)' },
  { occurredOn: '2026-09-20', vendor: 'Anthropic', amount: '21.66', note: 'Claude Max 20 — $200/mo, prorated (invoice ZRI2RP7U-0002)' },
];

async function handleSeedInitial(auth) {
  const existing = await listExpenses({});
  if (existing.length > 0) return { seeded: false, reason: 'not-empty' };
  for (const row of SEED_ROWS) {
    await insertExpense({
      occurredOn: row.occurredOn,
      vendor: row.vendor,
      amountCents: parseAmountToCents(row.amount),
      currency: 'USD',
      category: 'AI & Cloud Services',
      note: row.note,
      receiptKey: null,
      receiptFilename: null,
      source: 'manual',
      createdBy: auth.userId ?? null,
    });
  }
  return { seeded: true, count: SEED_ROWS.length };
}

/* ------------------------------------------------------------------ ops that need the rate limiter/DB */

const DB_OPS = new Set(['list', 'add', 'update', 'delete', 'totals', 'receiptUploadUrl', 'receiptExtract', 'exportCsv', 'seedInitial']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleCors(res, req).status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const body = req.body ?? {};
  const op = typeof body.op === 'string' ? body.op : '';

  // operatorStatus is the one op that answers "am I allowed to see this" —
  // it cannot itself be gated by the answer it's about to give. It does no
  // DB work and needs no rate limit.
  if (op === 'operatorStatus') {
    return handleCors(res, req).status(200).json({ isOperator: isPlatformOperator(auth) });
  }

  // STRICTEST gate in this route, checked BEFORE any DB or rate-limit work
  // (same ordering as api/review.js's OPERATOR_ACTIONS) — a tenant's own
  // admin, even the founder shop's non-founder admins, gets 403 here.
  if (!isPlatformOperator(auth)) {
    return res.status(403).json({ error: 'This action is restricted to DeepWell platform operators.' });
  }

  if (!DB_OPS.has(op)) {
    return handleCors(res, req).status(400).json({ error: `Unknown op: ${op}` });
  }

  if (!(await rateLimit(req, res, auth, 'write'))) return; // 429 already written

  try {
    if (op === 'list') {
      const range = rangeFromBody(body);
      const items = await listExpenses(range);
      return handleCors(res, req).status(200).json({ items, range });
    }

    if (op === 'add') {
      const fields = validateExpenseFields(body);
      const id = await insertExpense({ ...fields, createdBy: auth.userId ?? null });
      return handleCors(res, req).status(200).json({ id });
    }

    if (op === 'update') {
      const id = body?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ExpensesValidationError('id must be a uuid');
      const fields = validateExpenseFields(body);
      const ok = await updateExpense(id, fields);
      if (!ok) throw new ExpensesValidationError('Expense not found', 404);
      return handleCors(res, req).status(200).json({ ok: true });
    }

    if (op === 'delete') {
      const id = body?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ExpensesValidationError('id must be a uuid');
      const ok = await deleteExpense(id);
      if (!ok) throw new ExpensesValidationError('Expense not found', 404);
      return handleCors(res, req).status(200).json({ ok: true });
    }

    if (op === 'totals') {
      const range = rangeFromBody(body);
      const rows = await totalsExpenses(range);
      return handleCors(res, req).status(200).json({ range, ...shapeExpenseTotals(rows) });
    }

    if (op === 'receiptUploadUrl') {
      const result = await handleReceiptUploadUrl(body);
      return handleCors(res, req).status(200).json(result);
    }

    if (op === 'receiptExtract') {
      const result = await handleReceiptExtract(body);
      return handleCors(res, req).status(200).json(result);
    }

    if (op === 'exportCsv') {
      const range = rangeFromBody(body);
      const items = await listExpenses(range);
      const csv = buildExpensesCsv(items);
      handleCors(res, req);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="deepwell-expenses-${ymdRangeLabel(range)}.csv"`);
      return res.status(200).send(csv);
    }

    if (op === 'seedInitial') {
      const result = await handleSeedInitial(auth);
      return handleCors(res, req).status(200).json(result);
    }

    return handleCors(res, req).status(400).json({ error: `Unknown op: ${op}` });
  } catch (error) {
    if (error instanceof ExpensesValidationError) {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    if (error instanceof ExpensesMigrationPendingError) {
      return handleCors(res, req).status(503).json({ error: error.message, code: 'migration_pending' });
    }
    return handleError(res, error, req);
  }
}
