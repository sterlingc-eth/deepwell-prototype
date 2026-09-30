/**
 * R31 (Team A, loop 4) — "was there X filed/issued/logged in <a FUTURE year>" is a question no record can answer.
 *
 * WHY: routes/analytics.js already answers a future-year question honestly and deterministically
 * (mentionsFutureYear -> futureDateAnswer: "That's a future date — I have nothing on file for it"), but only for the
 * questions the analytics classifier happens to claim. "was there a service call logged in June 2029", "anything on
 * file from December 2029", "what work did we do on March 15th, 2027", "is there a permit filed for October 2029"
 * are claimed by nobody (or by a fastPath that then fails), so each went to a paid model call to produce the same
 * "nothing on file". This module recognizes that shape so classifyAll can hand it to the existing analytics decline.
 *
 * CONSERVATIVE by construction: the year must sit in a date context ("in/for/from/of/dated/during <year>" or after a
 * month name), the question must be about a PAST-EVENT record (filed/issued/logged/dated/did/done/on file/paperwork...),
 * and it must carry NO forward-looking word (expire, due, scheduled, next, will, until, by, since, plan, term, renew...),
 * no possessive, no known customer / technician name, and no comparison. Anything else stays with the existing path.
 */
import { questionNamesKnownCustomer } from "../analytics/detPlan.js";

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const YEAR_CTX = new RegExp(`(?:\\b(?:in|for|from|of|during|dated|on|year)\\s+(?:the\\s+year\\s+)?|\\b(?:${MONTHS})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?)(20\\d{2}|21\\d{2})\\b`, "gi");
const PAST_EVENT = /\b(?:filed|issued|logged|dated|completed|finished|done|did|sent|placed|paid|registered|on file|on record|paperwork|invoices?|permits?|quotes?|purchase orders?|startup sheets?|work orders?|registrations?|service calls?|visits?|installs?|installed|installations?|jobs?|work|documents?|records?)\b/i;
const FORWARD = /\b(?:expir\w*|due|overdue|schedul\w*|upcoming|next|renew\w*|will|going to|gonna|plan\w*|until|till|through|thru|by|before|after|since|end|ends|ending|term|forecast\w*|project\w*|budget\w*|goal|target|coming|valid|active|still|good|covered|coverage|cover|remain\w*|lease|contract|agreement|compare\w*|versus|vs|than|or)\b/i;

export function isFutureRecordQuestion(question, { today, tenantVocab } = {}) {
  const q = String(question ?? "").trim();
  if (!q || q.length > 160) return false;
  const now = today ? new Date(today) : new Date();
  if (Number.isNaN(now.getTime())) return false;
  const thisYear = now.getUTCFullYear();
  let future = false;
  for (const m of q.matchAll(YEAR_CTX)) if (Number(m[1]) > thisYear && Number(m[1]) <= 2100) future = true;
  if (!future) return false;
  if (!PAST_EVENT.test(q)) return false;
  if (FORWARD.test(q) || /'s\b|’s\b/.test(q)) return false;
  if (/\b\d{1,5}\s+[nsew]?\.?\s*[a-z]+\s+(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|way|ct|court)\b/i.test(q)) return false;
  if (tenantVocab && questionNamesKnownCustomer(q, tenantVocab)) return false;
  const techs = tenantVocab?.technicians?.phrases;
  if (Array.isArray(techs) && techs.some((t) => t && new RegExp(`\\b${String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q))) return false;
  return true;
}
