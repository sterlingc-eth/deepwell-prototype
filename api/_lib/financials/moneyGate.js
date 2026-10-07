/**
 * Financials layer — the money gate's new brain (api/ask.js "0.65 money gate").
 *
 * Before this layer every money question got the fixed honest refusal
 * (analytics.js moneyFallbackAnswer). Now:
 *
 *   1. financials table missing (migration 22 not pasted)      -> {handled:false, hasData:false}
 *      -> ask.js keeps today's refusal text unchanged.
 *   2. table exists but this tenant has no financial row with a total
 *                                                             -> {handled:false, hasData:false}
 *      -> same honest refusal (there is nothing true to say yet).
 *   3. tenant has financial rows: parse the question into a money shape and answer it from
 *      SQL (answers.js)                                        -> {handled:true, data}
 *   4. rows exist but the question is not a shape answers.js knows (or names a customer it
 *      cannot resolve)                                         -> {handled:false, hasData:true}
 *      -> ask.js hands it to the Donovan agent, which may total ONLY through the `financials`
 *         view, else falls to NO_MATCH_TEXT below (never the "can't total yet" claim, which
 *         would now be false).
 *
 * No model call here. DB reads only, inside the caller's tenant.
 */
import { withTenant as defaultWithTenant } from '../recordsStore.js';
import { tenantHasFinancialRows } from './store.js';
import { parseMoneyIntent, runMoneyIntent } from './answers.js';
import { leftoverWords } from '../router/leftover.js';
import { parseAmountInvoiceQuestion, amountMentioned } from './amountInvoice.js';

/** R39: a plain "how many invoices/quotes/purchase orders" count answers from the document kind, the period and the named subject ONLY. Any other
 *  non-grammar word the question carried (a person nobody resolved, "did Dana Whitfield do", a negation, ...) was silently dropped and the whole-shop
 *  count came back as the answer; the lane declines instead (the agent / honest fallback handles it). */
function countLeftover(question, today) {
  const sig = (q) => { const i = parseMoneyIntent(q, { today }); return i ? JSON.stringify([i.intent, i.docKindWord ?? null, i.period ?? null, i.subject ?? null]) : null; };
  const i0 = parseMoneyIntent(question, { today });
  const bare = Boolean(i0) && !i0.period && !i0.subject; // the whole-shop count: only right when nothing else was asked
  return leftoverWords(question, sig, { lane: 'money-count', plain: bare, entityKey: 'documents' });
}

export const MONEY_NO_MATCH_TEXT =
  "I have invoice totals on file, but I couldn't work that particular question out from them. Try asking for a customer's last invoice, invoiced totals for a month or year, open or overdue invoices, or agreement fees.";

export function moneyNoMatchAnswer() {
  return { kind: 'answer', text: MONEY_NO_MATCH_TEXT, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] };
}

/**
 * @returns {Promise<{handled: boolean, hasData: boolean, data?: object, intent?: string}>} never throws
 *   (any failure degrades to {handled:false, hasData:false}, i.e. today's behaviour).
 */
export async function answerMoneyQuestion({ withTenant = defaultWithTenant, ctxArg, question, today }) {
  try {
    return await withTenant(ctxArg, async (db) => {
      if (!(await tenantHasFinancialRows(db))) return { handled: false, hasData: false };
      const intent = parseMoneyIntent(question, { today });
      if (!intent) return { handled: false, hasData: true };
      // R40: a question that names an invoice amount is never answered with a shop-wide total / count / last-invoice that ignores the amount.
      if (intent.intent !== 'threshold_invoices' && amountMentioned(question)) return { handled: false, hasData: true, intent: intent.intent };
      if (intent.intent === 'document_count' && countLeftover(question, today).length) return { handled: false, hasData: true, intent: intent.intent };
      const data = await runMoneyIntent(db, intent, { today });
      if (!data) return { handled: false, hasData: true, intent: intent.intent };
      return { handled: true, hasData: true, data, intent: intent.intent };
    });
  } catch (err) {
    console.error('financials: money answer failed:', err?.name === 'Error' ? 'query error' : err?.name ?? 'error');
    return { handled: false, hasData: false };
  }
}

/**
 * R40: "the invoice for 3470": decided by the organization's financial rows whose total equals the amount. Never throws; {handled:false} when the question is not
 * of this exact shape or the organization has no financial rows (the caller then continues down the normal, grounding-gated path).
 */
export async function answerAmountInvoiceQuestion({ withTenant = defaultWithTenant, ctxArg, question, today }) {
  const amt = parseAmountInvoiceQuestion(question);
  if (!amt) return { handled: false, hasData: false };
  try {
    return await withTenant(ctxArg, async (db) => {
      if (!(await tenantHasFinancialRows(db))) return { handled: false, hasData: false };
      const data = await runMoneyIntent(db, { intent: 'invoice_by_amount', amountCents: amt.cents, amountBare: amt.bare, raw: String(question).toLowerCase(), rawOriginal: String(question), period: null, subject: null }, { today });
      if (!data) return { handled: false, hasData: true, intent: 'invoice_by_amount' };
      return { handled: true, hasData: true, data, intent: 'invoice_by_amount' };
    });
  } catch (err) {
    console.error('financials: amount answer failed:', err?.name === 'Error' ? 'query error' : err?.name ?? 'error');
    return { handled: false, hasData: false };
  }
}
