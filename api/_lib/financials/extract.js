/**
 * Financials layer — the extraction call (one Haiku tool-use call per money document).
 *
 * WHY A SEPARATE CALL (deviation from handoffs/FINANCIALS_DESIGN_2026-09-21.md section 3, which
 * extended the existing extract_fields call): the existing call's tool schema + cached 1-hour
 * system prefix (extractFields.js / extractDocument.js) is shared by EVERY document type and
 * runs before the document type is even known; adding an invoice-only block to it would bloat
 * the schema for the ~80% of documents that carry no money and change a cached prefix another
 * workstream is tuning. The backfill also has to re-read STORED page text for documents
 * extracted long before this existed, which needs a standalone call regardless. Cost is
 * still small: money-kind documents only, page text only (no OCR), ~1.5-3k input + ~300
 * output tokens at Haiku 4.5 = roughly $0.003 per document (measured in the verify script's
 * cost line, see estimateFinancialsCost), versus $0.012 for the base PDF read.
 *
 * Model: Haiku (EXTRACT_MODEL / FINANCIALS_MODEL override), temperature 0, tool_choice forced.
 * The model call is injectable (`callModel`) so scripts/verify-financials.mjs needs no key.
 *
 * Never logs page text, amounts or names: only token counts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from '../claude.js';
import { assertModelBudget } from '../rateLimit.js';
import { recordModelCall } from '../usage.js';
import { modelCallLogLine } from '../promptCache.js';
import { selectPages } from '../extractFields.js';
import { normalizeFinancials, FINANCIAL_DOCUMENT_TYPES, isFinancialDocumentType } from './normalize.js';
import { financialsTableExists, upsertFinancials } from './store.js';

export const FINANCIALS_MODEL = process.env.FINANCIALS_MODEL || process.env.EXTRACT_MODEL || 'claude-haiku-4-5';
/** Page-text budget for one call: money documents are short; totals sit on the last page. */
const PAGE_BUDGET_CHARS = 30_000;

const MONEY_PROP = {
  type: 'object',
  properties: {
    value: { type: 'string', description: 'The amount exactly as printed, digits only with an optional decimal point and leading minus (no $ or commas). Omit the whole field if it is not printed.' },
    page_no: { type: 'number', description: 'Page number from the [page N] marker.' },
    verbatim: { type: 'string', description: 'The short phrase on the page this was read from, copied exactly (e.g. "TOTAL DUE $1,240.50").' },
    confidence: { type: 'number', description: '0 to 1; below 0.6 if smudged, ambiguous or partly illegible.' },
  },
  required: ['value', 'page_no'],
};

export const FINANCIALS_TOOL = {
  name: 'extract_financials',
  description:
    'Read the money on this document. Return only amounts that are PRINTED on the pages. ' +
    'Never add, subtract, estimate or infer an amount; a field the document does not print is omitted.',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['invoice', 'credit_memo', 'statement', 'receipt', 'estimate', 'change_order', 'po', 'agreement'],
        description: 'What money document this is. credit_memo = a credit/refund note; statement = an account statement listing several invoices; receipt = proof of payment; estimate = proposal/quote; po = purchase order; agreement = maintenance/service agreement.',
      },
      direction: { type: 'string', enum: ['receivable', 'payable'], description: 'receivable = the HVAC company billed a customer; payable = a vendor/supplier billed the HVAC company (or a purchase order the company issued).' },
      currency: { type: 'string', description: '3-letter code, default USD.' },
      invoice_number: { type: 'string', description: 'Invoice / quote / estimate / agreement number as printed.' },
      po_number: { type: 'string' },
      invoice_date: { type: 'string', description: 'The date printed on the document (invoice / quote / PO / agreement date) as YYYY-MM-DD.' },
      due_date: { type: 'string', description: 'Payment due date as YYYY-MM-DD, only if printed (not "Net 30" alone).' },
      period_start: { type: 'string', description: 'Agreement/statement period start, YYYY-MM-DD.' },
      period_end: { type: 'string', description: 'Agreement/statement period end, YYYY-MM-DD.' },
      agreement_term: { type: 'string', description: 'For maintenance agreements: the term as printed, e.g. "12 months" or "01/01/2026 - 12/31/2026".' },
      customer_name: { type: 'string', description: 'The customer being billed ("Bill To") for receivables.' },
      vendor_name: { type: 'string', description: 'The vendor/supplier for payables and purchase orders.' },
      job_address: { type: 'string', description: 'The property/service address where the JOB was done, exactly as printed — labels like "Service Address:", "Service Location:", "Job Address:", or a purchase order\'s "For job at: <address>" line. Never the shop\'s own letterhead address. Omit if no such address is printed on this document.' },
      job_number: { type: 'string', description: 'An explicit job/ticket number printed on the document, ONLY if distinct from invoice_number/po_number (e.g. "Job #4471"). Omit otherwise.' },
      printed_status: { type: 'string', enum: ['paid', 'unpaid', 'partial', 'overdue', 'open', 'none'], description: 'ONLY what is stamped/printed (PAID, BALANCE DUE, PAST DUE). "none" if the document prints no payment status.' },
      subtotal: MONEY_PROP,
      tax: MONEY_PROP,
      total: { ...MONEY_PROP, description: 'The document total: TOTAL / AMOUNT DUE / INVOICE TOTAL; for a quote the quote total; for a PO the PO total; for a maintenance agreement the agreement fee/price. Not a subtotal.' },
      amount_paid: MONEY_PROP,
      balance_due: MONEY_PROP,
      line_items: {
        type: 'array',
        description: 'One entry per printed line item, in order. Empty if the document lists none.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            qty: { type: 'string' },
            unit_price: { type: 'string' },
            amount: { type: 'string', description: 'The line amount as printed (extended price).' },
            category_guess: { type: 'string', enum: ['labor', 'parts', 'equipment', 'refrigerant', 'permit', 'fee', 'other'] },
            page_no: { type: 'number' },
          },
        },
      },
      confidence: { type: 'number', description: '0 to 1 overall confidence in the amounts.' },
    },
    required: ['kind'],
  },
};

const RULES = `Rules:
- Copy amounts character for character from the page. A total that is not printed stays omitted: never compute one from line items, and never add tax to a subtotal yourself.
- total is the amount the customer/company is asked to pay for the whole document (TOTAL, AMOUNT DUE, INVOICE TOTAL, GRAND TOTAL). If both "total" and "balance due" are printed and differ, return both. A subtotal is not the total.
- For a credit memo, return amounts as printed (the system stores them negative).
- For a maintenance agreement, total is the agreement fee/annual price as printed; leave it out if no fee is printed.
- printed_status reflects only a printed stamp or label (PAID, PAID IN FULL, BALANCE DUE, PAST DUE). No label means "none". Never infer paid from a zero or missing balance.
- Dates as YYYY-MM-DD. Leave a date out if only a month/year or a term like "Net 30" is printed.
- page_no must be the page (from the [page N] marker) where the amount is printed.
- Return every printed line item in order with its own printed amount; leave qty/unit_price out when not printed.
- job_address is the JOB SITE, not the shop's own header address: copy it exactly as printed (e.g. "Service Address: 840 S Ellsworth Rd, Gilbert, AZ 85234" -> "840 S Ellsworth Rd, Gilbert, AZ 85234"; "For job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)" -> "248 W Guadalupe Rd, Phoenix, AZ 85001"). Omit it rather than guess.`;

/** Pure: the user prompt for one document. */
export function buildFinancialsPrompt(pages, documentType) {
  const body = pages.map((p) => `[page ${p.page_no}]\n${p.text}`).join('\n\n');
  return `Below is the text of a ${documentType || 'document'} belonging to an HVAC company, one page at a time.\n\n${body}\n\nRead the money on this document using the extract_financials tool.\n\n${RULES}`;
}

/** Rough $ cost of one call at Haiku 4.5 list price ($1 / $5 per Mtok) — for the budget line. */
export function estimateFinancialsCost({ inputTokens = 0, outputTokens = 0 } = {}) {
  return (inputTokens * 1 + outputTokens * 5) / 1_000_000;
}

async function defaultCallModel({ prompt, ctx, modelAttempts }) {
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  const startedAt = Date.now();
  const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
  const response = await withBackoff(() => client.messages.create({
    model: FINANCIALS_MODEL,
    max_tokens: 3000,
    temperature: 0,
    tools: [FINANCIALS_TOOL],
    tool_choice: { type: 'tool', name: FINANCIALS_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt, attempts: modelAttempts });
  console.log(JSON.stringify(modelCallLogLine({
    route: 'extract-financials', model: FINANCIALS_MODEL, inputTokens: response.usage?.input_tokens,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens, cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
    outputTokens: response.usage?.output_tokens, latencyMs: Date.now() - startedAt,
  })));
  try {
    await recordModelCall(ctx, { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens });
  } catch { /* best-effort accounting, same as extractDocument.js */ }
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  return { input: toolUse?.input ?? null, usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 } };
}

/**
 * Extract + store the financials of ONE document from its stored page text.
 *
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {string} documentId
 * @param {object} deps  { withTenant, callModel?, documentType?, modelAttempts?, today?, skipBudget? }
 *   withTenant is injected (recordsStore's) so this module has no import cycle with extractDocument.js.
 * @returns {Promise<{status: 'written'|'skipped'|'failed', reason?: string, modelCalls: number, costUsd: number,
 *                    flags?: string[], hasTotal?: boolean}>}
 *   Never throws for a model/parse problem — a failed financial extraction must never fail the
 *   document's main extraction — except ModelBudgetExceededError, which the caller decides on.
 */
export async function extractFinancialsForDocument(ctx, documentId, deps) {
  const { withTenant, callModel = defaultCallModel, modelAttempts, today = new Date().toISOString().slice(0, 10) } = deps;
  const skipped = (reason) => ({ status: 'skipped', reason, modelCalls: 0, costUsd: 0 });

  const loaded = await withTenant(ctx, async (db) => {
    if (!(await financialsTableExists(db))) return { off: true };
    const doc = await db.getDocument(documentId);
    if (!doc) return { missing: true };
    const type = deps.documentType || doc.document_type;
    if (!isFinancialDocumentType(type)) return { notFinancial: true };
    const existing = (await db.raw(
      "SELECT (corrections <> '{}'::jsonb OR verified_by IS NOT NULL) AS human FROM document_financials WHERE document_id = $1 AND tenant_id = (current_setting('app.tenant_id', true))::uuid", [documentId])).rows[0];
    if (existing?.human) return { human: true };
    return { type, pages: await db.listPages(documentId) };
  });
  if (loaded.off) return skipped('table_missing');
  if (loaded.missing) return skipped('document_missing');
  if (loaded.notFinancial) return skipped('not_financial');
  if (loaded.human) return skipped('human_reviewed');
  const { pages: selected } = selectPages(loaded.pages, PAGE_BUDGET_CHARS);
  if (!selected.length) return skipped('no_page_text');

  if (!deps.skipBudget) await assertModelBudget(ctx);

  let out;
  try {
    out = await callModel({ prompt: buildFinancialsPrompt(selected, loaded.type), ctx, modelAttempts });
  } catch (err) {
    if (err?.name === 'ModelBudgetExceededError') throw err;
    console.error('financials: model call failed:', err?.name ?? 'error');
    return { status: 'failed', reason: 'model_error', modelCalls: 1, costUsd: 0 };
  }
  const costUsd = estimateFinancialsCost(out.usage);
  const highestPage = loaded.pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
  const norm = normalizeFinancials(out.input, { documentType: loaded.type, pages: loaded.pages, pageCount: highestPage, today });
  if (!norm.ok) return { status: 'failed', reason: 'unparseable', modelCalls: 1, costUsd };

  const res = await withTenant(ctx, async (db) => {
    const w = await upsertFinancials(db, documentId, norm, { model: FINANCIALS_MODEL });
    if (w.written) {
      await db.logAction({
        action: 'document.financials_extracted', resource_type: 'document', resource_id: documentId,
        changes: { kind: norm.header.doc_kind, has_total: norm.header.total != null, lines: norm.lines.length, flags: norm.flags, confidence: norm.confidence, model: FINANCIALS_MODEL },
      });
    }
    return w;
  });
  if (!res.written) return { status: 'skipped', reason: res.reason, modelCalls: 1, costUsd };
  return { status: 'written', modelCalls: 1, costUsd, flags: norm.flags, hasTotal: norm.header.total != null };
}

export { FINANCIAL_DOCUMENT_TYPES };
