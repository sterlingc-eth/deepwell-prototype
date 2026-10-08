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
import { parseMoneyIntent, runMoneyIntent, dropRoleBeforeInvoices } from './answers.js';
import { leftoverWords } from '../router/leftover.js';
import { resolveContactCandidates } from '../contactLookup.js';
import { parseAmountInvoiceQuestion, amountMentioned } from './amountInvoice.js';
import { docLaneFromUnderstanding } from '../understanding/route.js';
import { namedMoneyShape } from '../lookups/namedMoney.js';
import { nameVerdict, clarifyText, nameTokens } from '../lookups/nameMatch.js';

/** R39: a plain "how many invoices/quotes/purchase orders" count answers from the document kind, the period and the named subject ONLY. Any other
 *  non-grammar word the question carried (a person nobody resolved, "did Dana Whitfield do", a negation, ...) was silently dropped and the whole-shop
 *  count came back as the answer; the lane declines instead (the agent / honest fallback handles it). */
function countLeftover(question, today) {
  const sig = (q) => { const i = parseMoneyIntent(q, { today }); return i ? JSON.stringify([i.intent, i.docKindWord ?? null, i.period ?? null, i.subject ?? null]) : null; };
  const i0 = parseMoneyIntent(question, { today });
  const bare = Boolean(i0) && !i0.period && !i0.subject; // the whole-shop count: only right when nothing else was asked
  return leftoverWords(question, sig, { lane: 'money-count', plain: bare, entityKey: 'documents' });
}

const SUBJECT_SCOPED = new Set(['open_invoices', 'overdue', 'ar_aging', 'total_invoiced', 'last_invoice', 'payment_status', 'customer_paid_up', 'avg_invoice']);
function subjectLeftover(question, today) {
  const sig = (q) => { const i = parseMoneyIntent(q, { today }); return i ? JSON.stringify([i.intent, i.docKindWord ?? null, i.period ?? null, i.subject ?? null]) : null; };
  return leftoverWords(question, sig, { lane: 'money-subject', plain: false, entityKey: 'documents' });
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
  question = dropRoleBeforeInvoices(question); // E2 A4: "customer invoices" counts invoices; the role word is not a leftover name
  try {
    return await withTenant(ctxArg, async (db) => {
      if (!(await tenantHasFinancialRows(db))) return { handled: false, hasData: false };
      const intent = parseMoneyIntent(question, { today });
      if (!intent) return { handled: false, hasData: true };
      // R40: a question that names an invoice amount is never answered with a shop-wide total / count / last-invoice that ignores the amount.
      if (intent.intent !== 'threshold_invoices' && amountMentioned(question)) return { handled: false, hasData: true, intent: intent.intent };
      // R3: "has Wyckoff Sandra paid us": a name-bearing collected-money question is never answered with the whole shop's figure; the named-customer lane (answerNamedMoneyQuestion) takes it
      if (intent.intent === 'collected_total' && !intent.subject) { const nm = namedMoneyShape(question); if (nm && !(await nameVerdict(db, nm.name)).deny) return { handled: false, hasData: true, intent: intent.intent }; }
      if (intent.intent === 'document_count' && countLeftover(question, today).length) return { handled: false, hasData: true, intent: intent.intent };
      // E2 A7: a subject-scoped money question that came back with NO subject while the question carries a name-like word ("Henderson invoices unpaid" read as the
      // whole shop's open money, typo or no typo) never drops the name: it is applied when it resolves to customers on file, otherwise the lane declines.
      if (!intent.subject && SUBJECT_SCOPED.has(intent.intent)) {
        // only a NAME-like leftover word ("Henderson", "henderson", "Ibarra's") counts: amounts ("5k", "over 5k") and initialisms ("AR") are not names and keep their old, disclosed handling
        const left = subjectLeftover(question, today).filter((w) => /^[A-Za-z][A-Za-z'’.-]{2,}$/.test(w) && !/^[A-Z]+$/.test(w));
        if (left.length) {
          const phrase = left.map((w) => w.replace(/['’]s$/i, '')).join(' ');
          const cands = phrase ? await resolveContactCandidates(db, phrase).catch(() => []) : [];
          // an unresolvable name declines (never the whole shop's figure); one or several customers are applied (several are answered separately by full name, never merged)
          if (!cands.length) return { handled: false, hasData: true, intent: intent.intent };
          intent.subject = phrase;
        }
      }
      // R3: the reading kept only PART of a full name ("Bracken Ronald" read as "Ronald"): the named-customer lane takes it when exactly one customer holds all the asked words
      if (intent.subject) { const nm = namedMoneyShape(question); if (nm && nameTokens(nm.name).length > nameTokens(intent.subject).length) { const vv = await nameVerdict(db, nm.name); if (!vv.deny && vv.canonical && vv.type === 'customer' && vv.full.some((e) => e.covers)) return { handled: false, hasData: true, intent: intent.intent }; } }
      if (!intent.subject && intent.intent !== 'threshold_invoices' && await carriesKnownName(db, question)) return { handled: false, hasData: true, intent: intent.intent };
      const data = await runMoneyIntent(db, intent, { today });
      if (!data) return { handled: false, hasData: true, intent: intent.intent };
      return { handled: true, hasData: true, data, intent: intent.intent };
    });
  } catch (err) {
    console.error('financials: money answer failed:', err?.name === 'Error' ? 'query error' : err?.name ?? 'error'); if (process.env.E4DBG) console.error(err);
    return { handled: false, hasData: false };
  }
}

/**
 * R40: "the invoice for 3470": decided by the organization's financial rows whose total equals the amount. Never throws; {handled:false} when the question is not
 * of this exact shape or the organization has no financial rows (the caller then continues down the normal, grounding-gated path).
 */
/** RECORDS-R2: the money lanes read ONE thing (an amount). A question that asks who did the work / how long / hours / notes / labor belongs to the records lane, never to a total */
const NOT_MONEY_FACT = /\b(?:who|whom|tech\w*|how long|hours?|hrs?|crew|notes?|labou?r|man[- ]?hours?|quotes?|estimates?|proposals?)\b/i;
const NOT_MONEY_FACT_OK = /\b(?:who (?:owes|paid|pays|has not paid|hasn't paid|haven't paid|is late|are late)|who(?:'s| is| are) (?:overdue|unpaid|late))\b/i;
export const asksNonMoneyFact = (q) => NOT_MONEY_FACT.test(String(q)) && !NOT_MONEY_FACT_OK.test(String(q));

export async function answerAmountInvoiceQuestion({ withTenant = defaultWithTenant, ctxArg, question, today, understanding = null }) {
  // R41U: the shared reading (understanding/understand.js) decides the lane; the R40 strict parser stays as the second door for the exact R40 shape.
  const lane = understanding ? docLaneFromUnderstanding(understanding, question) : null;
  const amt = lane?.intent === 'invoice_by_amount' ? { cents: lane.amountCents, bare: lane.amountBare } : parseAmountInvoiceQuestion(question);
  if (!lane && !amt) return { handled: false, hasData: false };
  if (lane && ['customer_docs', 'doc_extreme'].includes(lane.intent) && asksNonMoneyFact(question)) return { handled: false, hasData: false };
  const intent = (lane?.intent === 'doc_extreme' || lane?.intent === 'customer_docs' || lane?.intent === 'direction_ask' || lane?.intent === 'docs_in_window' || lane?.intent === 'doc_count' || lane?.intent === 'side_docs' || lane?.intent === 'which_ask' || lane?.intent === 'bill_threshold')
    ? { raw: String(question).toLowerCase(), rawOriginal: String(question), period: null, subject: null, ...lane }
    : { intent: 'invoice_by_amount', amountCents: amt.cents, amountBare: amt.bare, raw: String(question).toLowerCase(), rawOriginal: String(question), period: null, subject: null, ...(lane ?? {}) };
  try {
    return await withTenant(ctxArg, async (db) => {
      if (!(await tenantHasFinancialRows(db))) return { handled: false, hasData: false };
      if (lane && !['customer_docs', 'invoice_by_amount', 'bill_threshold'].includes(lane.intent) && await carriesKnownName(db, question)) return { handled: false, hasData: true };
      const data = await runMoneyIntent(db, intent, { today });
      if (!data) return { handled: false, hasData: true, intent: intent.intent };
      return { handled: true, hasData: true, data, intent: intent.intent };
    });
  } catch (err) {
    console.error('financials: amount answer failed:', err?.name === 'Error' ? 'query error' : err?.name ?? 'error');
    return { handled: false, hasData: false };
  }
}

/**
 * R3: a money / lookup question about ONE NAMED customer that every other lane left unanswered ("<name> - how much", "whats <name> balance", "look up <name>", a flipped or misspelled name).
 * Runs only after the other deterministic lanes declined, so it never takes a question another lane answers. Answers only when the name is a whole customer of THIS organization
 * (nameMatch.js); an unclear name gets the tap-one clarifying list; payment / due-date questions get an honest no-answer with no figure. Never throws.
 */
/** a question that carries a name some customer/vendor of this organization fully accounts for: a whole-shop answer would silently drop it */
async function carriesKnownName(db, question) {
  const nm = namedMoneyShape(question); if (!nm) return false;
  const v = await nameVerdict(db, nm.name); if (v.deny) return false;
  return [...v.full, ...v.partial].some((e) => e.covers);
}

export async function answerNamedMoneyQuestion({ withTenant = defaultWithTenant, ctxArg, question, today }) {
  const named = namedMoneyShape(question);
  if (!named || asksNonMoneyFact(question)) return { handled: false, hasData: false };
  try {
    return await withTenant(ctxArg, async (db) => {
      if (!(await tenantHasFinancialRows(db))) return { handled: false, hasData: false };
      const base = { raw: String(question).toLowerCase(), rawOriginal: String(question), period: null };
      const condNote = named.cond ? [`I did not apply "${named.cond}", so this covers all of their invoices`] : [];
      const run = (o) => runMoneyIntent(db, { ...base, ...o }, { today });
      const v0 = await nameVerdict(db, named.name);
      if (v0.deny) return { handled: false, hasData: true };
      // two (or more) customers named in one question ("compare A and B", "A or B invoice"): each answered by its own name, nobody dropped
      const asked = nameTokens(named.name);
      const whole = [...v0.full, ...v0.partial].filter((e) => e.type === 'customer' && nameTokens(e.name).length > 1 && nameTokens(e.name).every((t) => asked.includes(t)));
      const pool = [...new Map(whole.map((e) => [e.name.toLowerCase(), e])).values()];
      // an exact, unique split of the asked words into whole customer names (disjoint); several possible splits = not guessed
      const covers = [];
      const walk = (left, from, picked) => { if (!left.length) { covers.push(picked); return; } for (let i = from; i < pool.length && covers.length < 3; i++) { const t = nameTokens(pool[i].name); if (t.every((x) => left.includes(x))) { const rest = [...left]; for (const x of t) rest.splice(rest.indexOf(x), 1); walk(rest, i + 1, [...picked, pool[i]]); } } };
      if (pool.length >= 2) walk([...asked], 0, []);
      const uniq = covers.length === 1 ? covers[0] : [];
      if (uniq.length >= 2 && uniq.length <= 4) {
        const parts = [];
        for (const e of uniq) { const d = await run({ intent: named.askPay ? 'name_pay_decline' : 'customer_docs', subject: e.name, order: named.order, askPay: named.askPay, declineByName: false, direction: null, docNoun: 'invoice', wants: [], window: null, readNotes: condNote, __nameRetry: true }); if (d) parts.push(d); }
        if (parts.length === uniq.length) {
          const first = parts[0];
          return { handled: true, hasData: true, intent: 'name_multi', data: { ...first, text: parts.map((p) => p.text).join(' '), facts: parts.flatMap((p) => p.facts ?? []), sources: parts.flatMap((p) => p.sources ?? []), kind: parts.every((p) => p.kind === 'no-answer') ? 'no-answer' : 'answer' } };
        }
      }
      // only entities that account for EVERY word of the name count (a leftover word such as "many" means this is not a bare name question)
      const v = { ...v0, full: v0.full.filter((e) => e.covers), partial: v0.partial.filter((e) => e.covers) };
      if (v0.canonical && !v.full.some((e) => e.name === v0.canonical)) v.canonical = null;
      if (!v.full.length && !v.partial.length) return { handled: false, hasData: true };
      // a bare full name already in the customer's own word order belongs to the profile lane; only a flipped or misspelled one comes here
      if (named.bare && !named.cond && nameTokens(named.name).length > 1 && v.canonical && nameTokens(v.canonical).join(' ') === nameTokens(named.name).join(' ')) return { handled: false, hasData: true };
      let nd = null; let intentName = 'customer_docs';
      if (v.canonical && v.type === 'customer') {
        intentName = named.askPay ? 'name_pay_decline' : 'customer_docs';
        nd = await run({ intent: intentName, subject: v.canonical, order: named.order, askPay: named.askPay, declineByName: false, direction: null, docNoun: 'invoice', wants: [], window: null, readNotes: condNote, __nameRetry: true });
      } else if (v.canonical && v.type === 'vendor') {
        intentName = 'customer_docs';
        nd = await run({ intent: 'customer_docs', subject: v.canonical, order: named.order, askPay: false, declineByName: false, direction: 'out', docNoun: 'bill', wants: [], window: null, readNotes: [], __nameRetry: true });
      } else if (named.askPay && v.full.filter((e) => e.type === 'customer').length > 1) {
        intentName = 'name_pay_multi';
        nd = await run({ intent: 'name_pay_multi', __asked: named.name, __names: v.full.filter((e) => e.type === 'customer').map((e) => e.name) });
      } else if (v.full.some((e) => e.type === 'customer') || (!v.full.length && v.partial.some((e) => e.type === 'customer'))) {
        const only = { ...v, full: v.full.filter((e) => e.type === 'customer'), partial: v.partial.filter((e) => e.type === 'customer') };
        intentName = 'name_clarify';
        nd = await run({ intent: 'name_clarify', __clarify: { raw: named.name, v: only } });
      }
      return nd ? { handled: true, hasData: true, data: nd, intent: intentName } : { handled: false, hasData: true };
    });
  } catch (err) {
    console.error('financials: named money failed:', err?.name === 'Error' ? 'query error' : err?.name ?? 'error');
    return { handled: false, hasData: false };
  }
}
