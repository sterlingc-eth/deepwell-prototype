/**
 * R3 open declines: "<name> - how much", "whats <name> balance", "amount due from <name>", "look up <name>", "how much money did we make off <name>", "need the total on <name>s job".
 * A CLOSED shape: money/lookup words from a fixed list + a name. Every other word is a name candidate; the name must be a whole customer (nameMatch.js) before anything is answered,
 * so a question with any other content ("<name>'s furnace warranty") is never claimed here. Pure parse; the caller resolves the name inside the organization.
 */
import { nameTokens, TITLE_TOKENS } from "./nameMatch.js";

const MONEY = new Set(["balance", "amount", "due", "total", "totals", "owe", "owes", "owed", "billed", "bill", "bills", "invoice", "invoices", "invoiced", "charged", "charge", "paid", "pay", "pays", "make", "made", "money", "cost", "costs", "spent", "spend", "revenue", "earned", "sales", "outstanding", "unpaid", "overdue", "late", "payable", "payables", "much", "worth", "statement", "statements", "account", "history", "summary", "everything", "story", "job", "jobs"]);
const GLUE = new Set(["how", "did", "we", "off", "from", "whats", "what", "whos", "who", "is", "are", "was", "the", "a", "an", "on", "look", "up", "lookup", "find", "tell", "me", "about", "for", "does", "do", "has", "have", "been", "us", "give", "show", "pull", "get", "account", "please", "pls", "their", "his", "her", "last", "latest", "newest", "to", "of", "ever", "anything", "any", "all", "and", "my", "our", "s", "can", "you", "i", "need", "want", "see", "much", "with", "by", "it", "that", "this", "now", "so", "far", "in", "total", "biggest", "largest", "smallest", "oldest", "newest", "highest", "lowest", "average", "avg", "sent", "past", "year", "month", "this", "ever", "got", "called", "about", "billed", "work", "order", "estimate", "quote", "over", "under", "above", "below", "between", "before", "after", "since", "than", "least", "most", "during", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "quarter", "week", "weeks", "months", "years", "today", "yesterday", "tomorrow", "ago", "last", "next", "previous", "current", "compare", "versus", "vs", "or", "total", "totals", "k"]);

/** @returns {null | {name: string, askPay: boolean, order: 'latest'|null}} */
export function namedMoneyShape(question) {
  const raw = String(question ?? "");
  if (raw.length > 160) return null;
  // a number is another lane's business when it is an invoice number or street address; an amount / year condition is carried as `cond` and said, never silently dropped
  if (/#\s*\d|\b(?:invoice|inv|bill|po)\s*(?:no\.?|number)?\s*\d|\d+\s+[a-z]+\s+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|ln|lane|way|ct|court)\b/i.test(raw)) return null;
  const condM = [...raw.matchAll(/(?:(?:over|under|above|below|between|before|after|since|in|during|from|at least|at most|more than|less than)\s+)?\$?\d[\d,.]*\s*k?(?:\s*(?:and|to|-)\s*\$?\d[\d,.]*\s*k?)?/gi)].map((m) => m[0].trim()).filter(Boolean);
  const cond = condM.length ? condM.join("; ") : null;
  const words = raw.toLowerCase().replace(/[’`´]/g, "'").replace(/'s\b/g, "").replace(/'/g, "").split(/[^a-zÀ-ɏ]+/).filter(Boolean);
  if (!words.length) return null;
  const money = words.some((w) => MONEY.has(w)) || /\blook\s?up\b|\bfind\b|\bpull up\b|\btell me about\b/.test(raw.toLowerCase());
  const cand0 = words.filter((w) => !GLUE.has(w) && !MONEY.has(w) && !TITLE_TOKENS.has(w));
  // a bare name ("Mercer Thomas", "Roald Bracken"): two or three words and nothing else
  const bare = !money;
  if (!money && !bare) return null;
  const cand = words.filter((w) => !MONEY.has(w) && !GLUE.has(w) && !TITLE_TOKENS.has(w));
  // possessive-s glued to the last name word ("thomas mercers job") is repaired by nameMatch (trailing s); a leftover that is only a title / glue word is not a name
  if (!cand.length || cand.length > 8) return null;
  const toks = nameTokens(cand.join(" "));
  if (!toks.length) return null;
  return { cond, name: cand.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), bare, askPay: words.some((w) => ["pay", "pays", "paid", "owe", "owes", "owed", "due", "balance", "outstanding", "unpaid", "overdue", "late", "payable", "payables"].includes(w)), order: /\b(last|latest|newest)\b/i.test(raw) ? "latest" : null };
}
