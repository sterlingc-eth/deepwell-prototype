/**
 * R40: "the invoice for 3470" / "$3,470 invoice" / "invoice for 3470.00 from a customer" - a question that NAMES an invoice amount.
 *
 * Why this exists: before R40 no lane read an amount as an identifier. The question fell to retrieval + the model, which glued the asked-for
 * amount onto a different document that merely shared an address (a confident wrong answer with a wrong citation), or to a lane that dropped
 * the amount and answered the shop-wide total ("$572,562.00 across 121 invoices") or count ("You have 121 invoices").
 *
 * parseAmountInvoiceQuestion is PURE and FAILS CLOSED: it claims a question only when (1) the question names the word invoice, (2) exactly ONE
 * standalone amount token is present in a recognised amount form, and (3) every other word is plain filler ("where's the", "from a customer",
 * "show me"). Anything else (a customer name, a date, a status, a second number, over/under/between, about/around) is NOT claimed here -
 * the money gate then refuses to answer such a question with an unfiltered total (see amountMentioned).
 * The amount-RANGE lane stays banned: "between $X and $Y" is never claimed.
 */
import { parseThreshold, betweenWithCurrency } from '../amountWords.js';

const FILLER = new Set(`a an the this that these those it its is are was were be been being do does did have has had there here
where wheres where's whats what's what which who whom whose how much many show shows me find get pull up look lookup give need want see list
please can could would you i we us w our my your tell about from customer customers client clients on file filed in on for of with to and or any
all every one ones only just also total totals totaling totalling worth amount amounts amounting dollar dollars usd bucks buck at
invoice invoices invoiced count send sent anything anyone number numbers record records document documents pdf copy one's number's name names`.split(/\s+/));
const FORBIDDEN = /\b(?:between|over|under|above|below|more than|less than|fewer than|greater than|at least|at most|up to|no more than|no less than|around|about|roughly|approximately|approx|nearly|almost|close to|near|exceed\w*|average|avg|median|largest|biggest|smallest|highest|lowest|most|least|sum|combined|together|each|per|unpaid|paid|open|overdue|outstanding|owed|owe|partial|quote|quotes|estimate|estimates|proposal|po|purchase|vendor|payable|payables|credit|memo)\b/i;

/** Normalise a matched number token to integer cents (string) or null when malformed. */
function toCents(raw, kSuffix) {
  let s = String(raw).trim();
  if (!/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/.test(s) && !(kSuffix && /^\d+(?:\.\d{1,3})?$/.test(s))) return null;
  s = s.replace(/,/g, '');
  const n = Number(s) * (kSuffix ? 1000 : 1);
  if (!Number.isFinite(n) || n <= 0 || n >= 1e10) return null;
  return String(Math.round(n * 100));
}
export const centsToDollars = (c) => { const s = String(c).padStart(3, '0'); return `${s.slice(0, -2)}.${s.slice(-2)}`; };

// An amount token, standing alone: not glued to letters/digits/#/-// on either side, not part of a date, phone, serial or longer number.
const TOKEN = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
function findTokens(q) {
  const out = [];
  const re = new RegExp(`(?<![\\w#/.,$])(?<!\\w-)(\\$\\s?)?${TOKEN}(\\s?k\\b)?(?![\\w/\\-]|[.,]\\d)`, 'gi');
  let m;
  while ((m = re.exec(q))) out.push({ neg: q[m.index - 1] === '-', start: m.index, end: m.index + m[0].length, dollar: Boolean(m[1]), raw: m[2], k: Boolean(m[3]), text: m[0] });
  return out;
}

/** Every digit group in the question (any form). Used to make sure the one recognised token is the ONLY number. */
const digitGroups = (q) => q.match(/\d[\d,.]*/g) ?? [];

/**
 * @returns {null | {cents: string, amount: string, bare: boolean, marker: string, kForm: boolean}}
 */
export function parseAmountInvoiceQuestion(question) {
  const original = String(question ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!original || original.length > 160) return null;
  if (!/\binvoic\w*\b/i.test(original)) return null;
  if (FORBIDDEN.test(original)) return null;
  if (parseThreshold(original) || betweenWithCurrency(original)) return null;
  const toks = findTokens(original);
  if (toks.length !== 1) return null;
  const t = toks[0];
  if (t.neg) return null; // an explicit negative amount is not something this lane answers
  if (digitGroups(original).length !== 1) return null;
  const cents = toCents(t.raw, t.k);
  if (!cents) return null;
  const before = original.slice(0, t.start).toLowerCase().replace(/-\s*$/, '');
  const after = original.slice(t.end).toLowerCase();
  // How was the number marked as an AMOUNT (not an id, a year or a count)?
  const forMarker = /\b(?:for|of|at|is|was|totall?ing|totalled|worth|amounting to|in the amount of|that totals?|which totals?|totals?|come to|came to|comes to|invoiced|billed)\s*:?\s*(?:exactly\s*)?$/.test(before);
  const dollarAfter = /^\s*(?:dollars?|bucks?|usd)\b/.test(after);
  const beforeInvoice = /^\s*(?:dollars?\s+|usd\s+)?(?:invoices?|bills?)\b/.test(after);
  const marker = t.dollar ? '$' : dollarAfter ? 'dollars' : t.k ? 'k' : forMarker ? 'for' : beforeInvoice ? 'adj' : null;
  if (!marker) return null;
  // "customer 1042 invoice", "invoices for 3 customers", "the 7777 invoice": a count, a customer/job number or an invoice number is not an amount
  if (!t.dollar && !dollarAfter && !t.k && /^\s*(?:customers?|clients?|jobs?|units?|visits?|people|technicians?|tickets?|accounts?)\b/.test(after)) return null;
  if (!t.dollar && !dollarAfter && !t.k && /\b(?:customers?|clients?|jobs?|units?|tickets?|accounts?|acct|numbers?|no\.?|nr|id)\s*#?\s*$/.test(before)) return null;
  const hasDecimalOrComma = /[.,]/.test(t.raw);
  const bare = !t.dollar && !dollarAfter && !hasDecimalOrComma && !t.k;
  // A bare 4-digit number from 1900 to 2100 is far more likely a year than an amount.
  if (bare && /^(?:19|20)\d\d$/.test(t.raw) && marker !== 'adj' && !/(?:amount of|totall?ing|worth|totals?(?:\s+(?:is|was))?|amounting to)\s*(?:exactly\s*)?$/.test(before)) return null;
  // Everything that is not the amount or the word "invoice" must be plain filler.
  const rest = (original.slice(0, t.start) + ' ' + original.slice(t.end)).toLowerCase().replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (rest.some((w) => !FILLER.has(w))) return null;
  return { cents, amount: centsToDollars(cents), bare, marker, kForm: t.k, rawToken: t.text.trim() };
}

/**
 * True when the question carries an invoice amount in any recognised amount form, whatever else it says. The money gate uses this to refuse to
 * answer such a question with an unfiltered total/count (the question named an amount; an answer that ignores it is wrong).
 */
export function amountMentioned(question) {
  const original = String(question ?? '').replace(/\s+/g, ' ');
  if (!/\b(?:invoic\w*|bill(?:ed|s)?)\b/i.test(original)) return false;
  if (parseThreshold(original) || betweenWithCurrency(original)) return false; // over/under/between: the threshold lanes (and their own caveats) own these
  return findTokens(original).some((t) => {
    const before = original.slice(0, t.start).toLowerCase().replace(/-\s*$/, '');
    const after = original.slice(t.end).toLowerCase();
    const bare = !t.dollar && !/[.,]/.test(t.raw) && !t.k;
    const yearish = /^(?:19|20)\d\d$/.test(t.raw);
    if (bare && yearish) return /\b(?:for|of|is|was|totals?|totall?ing|worth|amount of|amounting to|billed|at)\s*$/.test(before) && (/^\s*(?:dollars?|bucks?|usd)\b/.test(after) || /amount of\s*$|totall?ing\s*$|worth\s*$|totals?(?:\s+(?:is|was))?\s*$/.test(before));
    // a bare standalone number of 3+ digits beside the word invoice(s) ("total invoices 3470", "average invoice 4210", "paid invoices 4210") may be the amount asked for; an aggregate/status answer that ignores it is wrong
    if (bare && !yearish && t.raw.length >= 3 && !/^\s*(?:days?|weeks?|months?|years?|hours?|minutes?|invoices?|customers?|jobs?|units?|visits?|miles?|%|percent|st|nd|rd|th|am|pm)\b/.test(after) && !/\b(?:last|past|next|previous|prior|top|first|within|recent|bottom|over the)\s*$/.test(before) && !/\b(?:in|during|since|from|until|by)\s*$/.test(before)) return true;
    return t.dollar || t.k || /[.,]/.test(t.raw) || /\b(?:for|of|at|is|was|totall?ing|totalled|worth|amounting to|that totals?|totals?|invoiced|billed)\s*:?\s*$/.test(before) || /^\s*(?:dollars?|bucks?|usd)\b/.test(after) || /^\s*(?:invoices?|bills?)\b/.test(after) || /\btotals?\s*:\s*$/.test(before);
  });
}
