/**
 * R10: ordinary words, dates and time words are never a person. One shared test used by every lane that is about to read part of a
 * question as a customer/vendor name ("documents other than invoices", "upcoming invoices", "fourth quarter 2025 invoices",
 * "invoices by Friday", "most recent permits", "second visit"). When it says true the lane steps aside instead of denying a name.
 * Pure, no I/O.
 */
const ORD = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|[4-9]th|10th";
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun";
const MONTH = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const WORD = "upcoming|recent|recently|latest|newest|oldest|earliest|previous|prior|past|next|coming|current|overdue|outstanding|quarter|quarterly|fiscal|annual|monthly|weekly|daily|yearly|ytd|today|yesterday|tomorrow|tonight|week|weekend|month|year|decade|ago|since|until|before|after|between|during|other|another|others|except|besides|excluding|including|documents?|docs?|paperwork|files?|records?|invoices?|permits?|quotes?|estimates?|proposals?|contracts?|leases?|agreements?|tickets?|visits?|jobs?|orders?|bills?|receipts?|payments?|statements?|certificates?|warranties|warranty";
const TOKEN_RE = new RegExp(`^(?:${ORD}|${WEEKDAY}|${MONTH}|${WORD}|q[1-4]|h[12]|fy\\d{0,4}|\\d{1,4}(?:st|nd|rd|th)?|than|the|of|and|or|a|an|in|on|by|for|to|from|this|that|these|those|last|most|least|all|any|every|each|our|my|we|how|many|much)$`, "i");

/** true when EVERY word of the phrase is an ordinary word / date / time / ordinal / document word (so none can be a person's name) */
export function isNotAPerson(phrase) {
  const toks = String(phrase ?? "").toLowerCase().replace(/[^a-z0-9\s'’-]/g, " ").split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  return toks.every((t) => TOKEN_RE.test(t.replace(/['’]s$/, "")));
}
