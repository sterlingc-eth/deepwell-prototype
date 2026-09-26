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

// A money-document noun ("invoice", "quote", "PO", "bill", "agreement", ...). Stems, not
// literal words, so invoice/invoiced/invoicing, bill/billed/billing/bills, quote/quoted/
// quotes/quoting all match.
const FIN_NOUN_RE = /\b(?:invoic\w*|quote[sd]?|quoting|estimat\w*|proposal\w*|purchase\s*orders?|\bpos\b|receipts?|agreements?|bill(?:s|ed|ing)?)\b/i;

// A payment/status word that only makes sense next to money.
const FIN_STATUS_RE = /\b(?:overdue|past[\s-]?due|unpaid|outstanding|delinquent|paid|partial(?:ly)?|open|owe[sd]?|owing|owed|uncollected|collected|verify|verified|unverified)\b/i;

// A bare money-domain word that is unambiguous on its own (no noun required).
const FIN_MONEY_WORD_RE = /\b(?:revenue|balances?|receivables?|payables?|invoiced|billed|sales\s*tax|taxe?s?)\b/i;

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
const FIN_SUPERLATIVE_RE = /\b(?:biggest|largest|smallest|highest|lowest)\b/i;

// TEAM K (2026-09-25, R5_FAILS.md): "how many invoices do we have on file", "average quote
// amount", "total value of our quotes", "average annual fee on our agreements" - a plain count
// or average of a money-document noun, with no separate status/threshold/superlative word to
// trigger any check above.
// Also: "last/latest invoice for X" (a person's name gives it no other money word), "bring in"
// (agreement revenue) and "spent" (MONEY_RE only has "spend(?:ing)?", never the past tense).
const FIN_COUNT_OR_AVG_RE = /\b(?:how many|average|avg|total\s+(?:value|amount)|annual\s+fee|last|latest|most recent|bring(?:s|ing)?\s+in|spent)\b/i;

/**
 * @param {string} question  the ALREADY fuzzy-corrected / lowercased question text
 *   (ask.js passes `normalizedForAnalytics`, same input isMoneyQuestion is tested against).
 * @returns {boolean}
 */
export function isFinancialQuestion(question) {
  const q = String(question ?? '').toLowerCase();
  if (!q.trim()) return false;
  if (FIN_MONEY_WORD_RE.test(q)) return true;
  if (FIN_JOB_COST_RE.test(q)) return true;
  if (FIN_STANDALONE_RE.test(q)) return true;
  if (FIN_QUOTE_WAITING_RE.test(q)) return true;
  if (FIN_THRESHOLD_RE.test(q) && FIN_NOUN_RE.test(q)) return true;
  if (FIN_SUPERLATIVE_RE.test(q) && FIN_NOUN_RE.test(q)) return true;
  if (FIN_NOUN_RE.test(q) && FIN_COUNT_OR_AVG_RE.test(q)) return true;
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
