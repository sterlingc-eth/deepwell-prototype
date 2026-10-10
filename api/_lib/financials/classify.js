/**
 * Financials layer — a broad, standalone "is this a financial question at all" classifier
 * for api/ask.js's 0.65 money gate.
 *
 * R3_FAILS.md (2026-09-24, live production): 27 financial answers wrong, most because the
 * question never reached the money gate in the first place. analytics.js's isMoneyQuestion
 * (MONEY_RE) is narrow by design (it grew one phrasing at a time off live-miss samples) and
 * has no coverage at all for "overdue"/"past due", bare "paid"/"owe(s)"/"owed to us", a
 * dollar threshold ("over $5,000"), a superlative ("biggest invoice"), "sales tax", or
 * "quotes waiting" — so those questions fell through to the 0.7 analytics pre-router, which
 * has no concept of payment status/thresholds and answered a bare document count instead
 * ("You have 68 documents.").
 *
 * This is deliberately permissive and OR'd with isMoneyQuestion in ask.js, never replacing
 * it: a false positive here costs nothing (parseMoneyIntent returns null, same fallthrough
 * to the agent as today); a false negative repeats exactly this bug. Typo tolerance for
 * ordinary 5+ letter words ("invocie", "ovedue") is already handled upstream by
 * nlNormalize's fuzzyCorrect before `normalizedForAnalytics` (what this is tested against)
 * is built — this file adds no typo table of its own.
 *
 * Pure (no DB). Tested with many phrasings in scripts/verify-financials.mjs.
 */
import { parseThreshold } from '../amountWords.js';

// A money-document noun ("invoice", "quote", "PO", "bill", "agreement", ...). Stems, not
// literal words, so invoice/invoiced/invoicing, bill/billed/billing/bills, quote/quoted/
// quotes/quoting all match.
import { isPoMoneyQuestion } from '../lookups/vendorPo.js';
const FIN_NOUN_RE = /\b(?:invoic\w*|quote[sd]?|quoting|estimat\w*|proposal\w*|purchase\s*orders?|\bpos?\b|receipts?|agreements?|bill(?:s|ed|ing)?)\b/i;

// A payment/status word that only makes sense next to money.
const FIN_STATUS_RE = /\b(?:overdue|past[\s-]?due|unpaid|outstanding|delinquent|paid|partial(?:ly)?|open|owe[sd]?|owing|owed|uncollected|collected|verify|verified|unverified)\b/i;

// A bare money-domain word that is unambiguous on its own (no noun required).
// R20 (J3, i013): "income" added — the same unambiguous-on-its-own money word "revenue" already
// is, just a second everyday synonym for it ("is our income higher this year than last year").
const FIN_MONEY_WORD_RE = /\b(?:revenue|income|balances?|receivables?|payables?|invoiced|billed|sales\s*tax|taxe?s?)\b/i;

// JOB COSTING (M3-config/36-job-costing.sql, 2026-09-26): "margin"/"profit(able)" are
// unambiguous money words even with no invoice/quote/PO noun in sight ("gross margin by
// job", "which jobs lost money", "cost vs revenue for the Bracken job", "over budget").
const FIN_JOB_COST_RE = /\bmargins?\b|\bprofit(?:able|ability)?\b|\bover[\s-]?budget\b|\bcost\w*\s+(?:vs\.?|versus)\s+revenue\b|\brevenue\s+(?:vs\.?|versus)\s+cost\w*\b|\bjob\s+cost(?:ing)?\b|\blost\s+money\b/i;

// "owes us"/"owe us"/"owed to us"/"paid us"/"owe our vendors"/"is X all paid up" — a cluster
// that names no invoice/bill noun at all ("which customer owes us the most", "is Mercer all
// paid up", "how much do we owe vendors").
const FIN_STANDALONE_RE = /\bowe[sd]?\s+us\b|\bowed\s+to\s+us\b|\bpaid\s+us\b|\bowe\s+(?:our\s+|the\s+)?(?:vendors?|suppliers?)\b|\bpaid\s+up\b|\bar\s+aging\b|\baging\b|\bageing\b|\bpast[\s-]?due\b/i;

// "quotes/proposals ... waiting" (either order) — a real yes/no shape with no other money
// word present.
const FIN_QUOTE_WAITING_RE = /\b(?:quotes?|proposals?|estimates?)\b[^?]*\bwaiting\b|\bwaiting\b[^?]*\b(?:quotes?|proposals?|estimates?)\b/i;

// A dollar threshold ("over $5,000", "under $500", "more than 5000 dollars"). Excludes a
// day-count ("more than 60 days overdue") via the negative lookahead so it never steals a
// pure aging/overdue question.
const FIN_THRESHOLD_RE = /\b(?:over|above|more than|greater than|under|below|less than)\s*\$?\s?[\d,]+(?:\.\d+)?\b(?!\s*days?\b)|\$\s?\d/i;

// A superlative ("biggest/smallest/highest/lowest invoice").
const FIN_SUPERLATIVE_RE = /\b(?:biggest|largest|smallest|highest|lowest|most\s+expensive|least\s+expensive|cheapest|priciest|(?:costs?|priced?|worth)\s+(?:the\s+)?(?:most|least))\b/i;

// R20 (J3, i020/i021): "how many purchase orders have we cut to Baker Distributing" — a per-vendor
// DOCUMENT count (analytics.js's detPlan.js now has a real, deterministic 'vendor' filter for this
// exact shape), never a dollar/status question — the same "bare count, not money" carve-out
// FIN_COUNT_OR_AVG_RE's own onlyAgreement branch already makes for "how many maintenance agreements
// are there", just triggered by a vendor RECIPIENT clause instead of the noun being "agreement".
const VENDOR_RECIPIENT_RE = /\b(?:cut|issued|sent|placed|written|made\s+out)\s+to\s+[a-z]/i;

// TEAM K (2026-09-25, R5_FAILS.md): "how many invoices do we have on file", "average quote
// amount", "total value of our quotes", "average annual fee on our agreements" - a plain count
// or average of a money-document noun, with no separate status/threshold/superlative word to
// trigger any check above.
// Also: "last/latest invoice for X" (a person's name gives it no other money word), "bring in"
// (agreement revenue) and "spent" (MONEY_RE only has "spend(?:ing)?", never the past tense).
// R21 M2 (breadth-financials-051): "how much" added alongside "how many" — always gated by
// FIN_NOUN_RE (a real money-document noun) at the call site just below, same as every other
// alternative here, so this can never fire on an unrelated "how much time"/"how much work" question.
const FIN_QUOTE_ASK_RE = /\b(?:quote[sd]?|estimates?|proposals?)\b[^?]*\b(?:price|amount|total|worth|cost|dated?|when)\b|\b(?:price|amount|total|cost|when|date)\b[^?]*\b(?:quote[sd]?|estimates?|proposals?)\b|\bwhat\b[^?]*\bdid we quote\b|\bquoted\s+price\b/i;
const FIN_CUSTOMER_PAY_RE = /\b(?:what|how much)\b[^?]*\b(?:did|does|do|has|have|will|was|were)\s+(?!we\b|you\b|i\b|they\b)(?:[a-z][\w'.-]*\s+){1,4}?(?:pay|paid|spend|spent|charged)\b/i;
const FIN_COUNT_OR_AVG_RE = /\b(?:how many|how(?:'?s)? much|amount\s+(?:of|on|for)|(?:come|comes)\s+to|average|avg|total\s+(?:value|amount|of)|annual\s+fee|last|latest|most recent|bring(?:s|ing)?\s+in|spent)\b/i;

/**
 * @param {string} question  the ALREADY fuzzy-corrected / lowercased question text
 *   (ask.js passes `normalizedForAnalytics`, same input isMoneyQuestion is tested against).
 * @returns {boolean}
 */
export function isFinancialQuestion(question) {
  const q = String(question ?? '').toLowerCase();
  if (!q.trim()) return false;
  if (isPoMoneyQuestion(q)) return true; // "PO total for Watsco" — purchase-order money question, any phrasing
  if (FIN_MONEY_WORD_RE.test(q)) return true;
  // R32: "did we invoice more in 2019 than 2023" / "did we bring in less this year than last" — a two-year invoiced-revenue comparison with no other money word.
  if (/\bthan\b/.test(q) && /\b(?:more|less|higher|lower|fewer|bigger|greater|smaller)\b/.test(q) && /\b(?:invoic\w*|bring(?:ing)?\s+in|brought\s+in|billed)\b/.test(q) && (q.match(/\bthis\s+year\b|\blast\s+year\b|\b(?:19|20)\d{2}\b/g) ?? []).length >= 2) return true;
  // B3: "what was invoiced in Q3", "what did we bill in the first half of 2025", "sum of invoices dated in 2019", "total proposals dollar value in 2026"
  if (/\b(?:what|how much)\b[^?]*\b(?:was|were|did we|have we|do we)\s+(?:invoic\w*|bill\w*|charg\w*)\b/.test(q)) return true;
  if (/\b(?:sum|total)\s+(?:of\s+)?(?:all\s+)?(?:our\s+)?(?:invoices?|bills?|quotes?|estimates?|proposals?)\b/.test(q)) return true;
  if (FIN_JOB_COST_RE.test(q)) return true;
  if (FIN_STANDALONE_RE.test(q)) return true;
  if (FIN_QUOTE_WAITING_RE.test(q)) return true;
  // D10: a threshold in words / shorthand ("over three thousand dollars", "above ten grand", "over 2.5k") is a dollar threshold too (amountWords.js).
  if ((FIN_THRESHOLD_RE.test(q) || parseThreshold(q)) && FIN_NOUN_RE.test(q)) return true;
  if (FIN_SUPERLATIVE_RE.test(q) && FIN_NOUN_RE.test(q)) return true;
  // Defect 19e: "biggest maintenance contract we have" - a service contract is a maintenance agreement (FIN_NOUN_RE only lists "agreement").
  if (FIN_SUPERLATIVE_RE.test(q) && /\b(?:maintenance|service)\s+(?:contracts?|plans?)\b/.test(q)) return true;
  // Defect 3: "what did we quote Ronald Bracken" / "quote total for Holy Trinity Church" / "when was the proposal sent to X" - a customer's quote amount or date.
  if (FIN_QUOTE_ASK_RE.test(q)) return true;
  // Defect 13: "what did William Quintana pay for his new system" / "how much did Amy Isaacson pay" / "what was Kevin Zimmerman charged" - what a named customer paid / was charged.
  if (FIN_CUSTOMER_PAY_RE.test(q)) return true;
  // R2: "what do we owe" / "owed to <vendor>" is a money question (the vendor bills)
  if (/\b(?:what|how much)\s+(?:do|did|will)\s+we\s+(?:still\s+)?owe\b(?!\s+us)/.test(q) || /\bowed\s+to\b/.test(q)) return true;
  // R2: a plain count of credit memos / purchase orders ("how many credit memos", "number of purchase orders") is a document count from the rows
  if (/\b(?:how many|number of|count of|total number of)\s+(?:credit\s*-?\s*memos?|purchase\s*orders?|pos)\b/.test(q)) return true;
  if (FIN_NOUN_RE.test(q) && FIN_COUNT_OR_AVG_RE.test(q)) {
    // Round 15 follow-up (P0 hook, generalization audit): "how many maintenance agreements are
    // there" / "how many customers are locked into a maintenance agreement" are a plain DOCUMENT
    // count — analytics.js's own detPlan already answers these deterministically via
    // detectLockedIntoDocType/DOC_TYPE_WORD_RE — but FIN_NOUN_RE's "agreements?" plus this
    // branch's bare "how many" stole them into the money gate before analytics ever saw them,
    // where they got declined (no dollar/fee data to report). Guarded narrowly, on "how many"
    // specifically (never "average"/"total value"/"annual fee"/"bring in"/"spent" — those other
    // FIN_COUNT_OR_AVG_RE triggers are already inherently amount/revenue questions, e.g. "how
    // much do our maintenance agreements bring in" must stay financial even with no other money
    // word in sight): a bare "how many <agreement noun only>" with no OTHER money-document noun
    // and no money word (fee, $, amount, invoice, bill, balance, owed…) is a document count, not
    // a money question. "how many invoices/quotes/POs..." (any OTHER money-document noun) is
    // unaffected: onlyAgreement is false for those, so they still return true exactly as before.
    const onlyAgreement = !/\b(?:invoic\w*|quote[sd]?|quoting|estimat\w*|proposal\w*|purchase\s*orders?|\bpos\b|receipts?|bill(?:s|ed|ing)?)\b/i.test(q);
    const bareHowMany = /\bhow many\b/i.test(q) && !/\$|\b(?:fees?|amounts?|dollars?|totals?|balances?|owe[sd]?|owing|money|cost)\b/i.test(q);
    // R20 (J3, i020/i021): a purchase-order (or other money-noun) count scoped to a named vendor
    // RECIPIENT ("...cut/issued/sent to X") is the same "plain count, not a dollar question" shape
    // as onlyAgreement just above — see VENDOR_RECIPIENT_RE's own doc comment.
    const vendorScopedCount = VENDOR_RECIPIENT_RE.test(q);
    if ((onlyAgreement || vendorScopedCount) && bareHowMany) {
      // fall through to the other branches (FIN_STATUS_RE etc.) rather than returning early -
      // "how many agreements are overdue" (a real status word alongside "how many") must still
      // be checked below, same as it always was.
    } else {
      return true;
    }
  }
  if (FIN_NOUN_RE.test(q) && FIN_STATUS_RE.test(q)) {
    // Review r3: "which customers have paid for a maintenance agreement" is a coverage/list question, not money.
    // An agreement noun with a status word needs a money word too (fee, $, amount, invoice, bill, balance, owed…).
    const onlyAgreement = !/\b(?:invoic\w*|quote[sd]?|quoting|estimat\w*|proposal\w*|purchase\s*orders?|\bpos\b|receipts?|bill(?:s|ed|ing)?)\b/i.test(q);
    if (onlyAgreement && !/\$|\b(?:fees?|amounts?|dollars?|totals?|balances?|owe[sd]?|owing|money|cost)\b/i.test(q)) return false;
    return true;
  }
  return false;
}

export const _internals = { FIN_NOUN_RE, FIN_STATUS_RE, FIN_MONEY_WORD_RE, FIN_JOB_COST_RE, FIN_STANDALONE_RE, FIN_QUOTE_WAITING_RE, FIN_THRESHOLD_RE, FIN_SUPERLATIVE_RE, FIN_COUNT_OR_AVG_RE };
