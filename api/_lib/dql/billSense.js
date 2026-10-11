/**
 * dql/billSense.js - which side of the books a question means by "bills". Pure.
 *   customer  "bills we sent", "bills to our customers"           -> the invoices the company sends
 *   vendor    "our bills", "bills we got", "bills from vendors"   -> what vendors send the company (vendor bills, or the purchase orders placed with them)
 *   bare      "how many bills", "bills" alone                      -> either; a company that has both sides is asked
 *   null      the question has no "bill(s)" word
 */
const CUSTOMER = /\bbills?\s+(?:that\s+)?(?:we|i)\s+(?:sent|send|issued|issue|mailed|gave|created|wrote|billed)\b|\b(?:sent|issued)\s+bills?\b|\bbills?\s+(?:sent|issued)\b|\bbills?\s+(?:to|for)\s+(?:our\s+|my\s+|the\s+)?(?:customers?|clients?|patients?|tenants?|donors?|members?)\b|\b(?:customer|client|patient|tenant|donor|member)s?['’]?\s+bills?\b/i;
const VENDOR = /\bour\s+bills?\b|\bbills?\s+(?:that\s+)?(?:we|i)\s+(?:got|get|received|receive|have\s+to\s+pay|need\s+to\s+pay|must\s+pay|owe|paid|pay|have\s+received)\b|\bbills?\s+(?:from|by)\s+(?:our\s+|the\s+|my\s+|all\s+(?:our\s+)?)?(?:vendors?|suppliers?|distributors?)\b|\b(?:vendor|supplier|distributor)s?['’]?\s+bills?\b/i;

const SENT = /\bbills?\s+(?:that\s+)?(?:we|i)\s+(?:sent|send|issued|issue|mailed|gave|created|wrote|billed)\b|\b(?:sent|issued)\s+bills?\b|\bbills?\s+(?:sent|issued)\b|\bbills?\s+to\s+(?:our\s+|my\s+|the\s+)?(?:customers?|clients?|patients?|tenants?|donors?|members?)\b/i;
/** "bills we sent" and the like, as invoices. A business's own word for its invoices ("patient bills", "tenant bills") is left as it was typed. */
export function billsSentAsInvoices(question) {
  const q = String(question ?? '');
  return SENT.test(q) ? q.replace(/\bbill(s?)\b/gi, (_m, s) => `invoice${s}`) : null;
}
export function billSense(question) {
  const q = String(question ?? '');
  if (!/\bbills?\b/i.test(q)) return null;
  if (CUSTOMER.test(q)) return 'customer';
  if (VENDOR.test(q)) return 'vendor';
  return /\bbills\b/i.test(q) ? 'bare' : null; // "what did we bill X" uses the verb
}

/** "our bills" -> "purchase orders" (and the words that only said which side) for a company whose vendor paper is purchase orders. */
export function vendorBillsAsPurchaseOrders(question) {
  return String(question ?? '')
    .replace(/\bbills?\s+(?:that\s+)?(?:we|i)\s+(?:got|get|received|receive|have\s+to\s+pay|need\s+to\s+pay|must\s+pay|owe|paid|pay|have\s+received)\b/gi, 'purchase orders')
    .replace(/\bbills?\s+(?:from|by)\s+(?:our\s+|the\s+|my\s+|all\s+(?:our\s+)?)?(?:vendors?|suppliers?|distributors?)\b/gi, 'purchase orders')
    .replace(/\b(?:vendor|supplier|distributor)s?['’]?\s+bills?\b/gi, 'purchase orders')
    .replace(/\bour\s+bills?\b/gi, 'purchase orders')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:the\s+|all\s+(?:the\s+)?|show\s+me\s+)?(purchase orders)\s*[?.!]*$/i, 'how many $1');
}
