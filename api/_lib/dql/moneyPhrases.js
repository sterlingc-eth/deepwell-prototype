/**
 * dql/moneyPhrases.js - everyday money wording, respelled into the forms the DQL core already reads (pure, no data, no model).
 *
 *   "worst year for revenue", "best month for sales", "highest revenue month"   -> "which year had the lowest revenue"
 *   "which year did we bill the most"                                           -> "which year had the highest revenue"
 *   "what did we bill Edward Esparza last time", "previous invoice for Donna"   -> "last invoice for ..."
 *   "list all invoices from 2026 with amounts"                                  -> "list all invoices from 2026"   (a list already shows each amount)
 *
 * A respelling only restates the question; the coverage rule still releases anything the core cannot explain afterwards, and
 * payment status, balance, tax and profit stay untracked (jargon.js untrackedConcept runs on the ORIGINAL text before this).
 */
const PERIOD = '(year|month|quarter)';
const MEASURE = '(revenue|sales|billings?|invoicing|income|money|billed|invoiced|dollars|spend(?:ing)?|spent)';
const meas = (w) => (/^spen/i.test(String(w)) ? 'spend' : 'revenue');
const BEST = 'best|strongest|biggest|top|highest|busiest|greatest|most\\s+profitable';
const WORST = 'worst|weakest|lowest|slowest|smallest|poorest|lowest|quietest';
const doc = '(?:invoice|bill|po|purchase\\s+order|quote|estimate|proposal)';

const side = (w) => (new RegExp(`^(?:${BEST})`, 'i').test(w) ? 'highest' : 'lowest');

export function moneyRewrite(text) {
  let s = String(text ?? '').trim();
  if (!s) return s;
  let m;
  // best / worst period for a money measure
  if ((m = new RegExp(`\\b(?:our\\s+|the\\s+|a\\s+)?(${BEST}|${WORST})\\s+${PERIOD}\\s+(?:ever\\s+|overall\\s+|on\\s+record\\s+)?(?:for|in|of|on|by)\\s+(?:our\\s+|the\\s+)?${MEASURE}\\b`, 'i').exec(s))) {
    return `which ${m[2].toLowerCase()} had the ${side(m[1])} ${meas(m[3])}${s.slice(m.index + m[0].length).replace(/^\s*(?:ever|overall)\b/i, '')}`.trim();
  }
  if ((m = new RegExp(`\\b(?:our\\s+|the\\s+)?(${BEST}|${WORST})\\s+(?:revenue|sales|billings?|income)\\s+${PERIOD}\\b`, 'i').exec(s))) {
    return `which ${m[2].toLowerCase()} had the ${side(m[1])} revenue${s.slice(m.index + m[0].length)}`.trim();
  }
  if ((m = new RegExp(`\\b${PERIOD}\\s+(?:with|had|has)\\s+(?:the\\s+)?(most|highest|biggest|best|least|lowest|fewest|worst|smallest)\\s+(?:revenue|sales|billings?|income)\\b`, 'i').exec(s))) {
    return `which ${m[1].toLowerCase()} had the ${/^(most|highest|biggest|best)$/i.test(m[2]) ? 'highest' : 'lowest'} revenue${s.slice(m.index + m[0].length)}`.trim();
  }
  if ((m = new RegExp(`^\\s*(?:which|what)\\s+${PERIOD}\\s+did\\s+we\\s+(?:bill|invoice|make|earn|take\\s+in|collect|sell)\\s+(?:the\\s+)?(most|least|fewest)(?:\\s+(?:money|revenue|dollars|sales))?\\s*[?.!]*\\s*$`, 'i').exec(s))) {
    return `which ${m[1].toLowerCase()} had the ${/^most$/i.test(m[2]) ? 'highest' : 'lowest'} revenue`;
  }
  // the last invoice for a customer
  if ((m = /^\s*(?:what|how\s+much)\s+(?:did|have)\s+we\s+(?:bill|billed|invoice|invoiced|charge|charged)\s+(.+?)\s+(?:the\s+)?(?:l(?:as|sa)t\s+time|most\s+recently|most\s+recent\s+time|previously|last)\s*[?.!]*\s*$/i.exec(s))) {
    return `last invoice for ${m[1]}`;
  }
  if ((m = new RegExp(`\\b(?:the\\s+)?(?:previous|prior|preceding)\\s+(${doc})\\b`, 'i').exec(s)) && /\b(?:for|to|from)\s+\S+/i.test(s.slice(m.index + m[0].length))) {
    s = `${s.slice(0, m.index)}last ${m[1]}${s.slice(m.index + m[0].length)}`;
    return s.replace(/^\s*(?:what|which)\s+(?:was|is)\s+(?:the\s+)?/i, '');
  }
  // "list ... with amounts": the list already shows each amount, the word is not a second question
  if (/^\s*(?:list|show|display|give\s+me|pull\s+up)\b/i.test(s) && (m = /\s+(?:along\s+)?(?:with|and|showing|including)\s+(?:their\s+|the\s+)?(?:amounts?|totals?|dollar\s+amounts?|prices?)\s*$/i.exec(s))) {
    return s.slice(0, m.index);
  }
  return s;
}

/** true when a listing was asked to show the amounts ("list all invoices from 2026 with amounts"): the list then names each paper with its amount. */
export const asksAmounts = (text) => /^\s*(?:list|show|display|give\s+me|pull\s+up)\b/i.test(String(text ?? '')) && /\s(?:along\s+)?(?:with|and|showing|including)\s+(?:their\s+|the\s+)?(?:amounts?|totals?|dollar\s+amounts?|prices?)\s*[?.!]*\s*$/i.test(String(text ?? ''));
