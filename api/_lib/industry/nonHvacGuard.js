/**
 * One central guard for non-HVAC companies (electrical, plumbing, property).
 *
 * The legacy deterministic answers (customers / units / service visits / "isn't on file for that address") are written in HVAC words. When an industry lane
 * declined a question and one of those answers falls out of the old chain, an electrical, plumbing or property company must never read "0 customers",
 * "No pieces of equipment match that" or "15 service visits". This post-filter replaces such an answer with an honest line in the trade's own words that
 * says what DeepWell can answer for that trade. Lane answers are never filtered (the caller skips them); HVAC (pack hvac) never reaches this file.
 *
 *   guardNonHvac(packId, data, question) -> replacement answer data | null (null = leave the answer alone)
 */
export const TRADE_CAN = {
  electrical: 'permits, inspections, panel schedules, licenses, insurance certificates and bonds',
  plumbing: 'backflow tests, water heaters and their warranties, permits, camera inspections, service tickets and invoices',
  property: 'work orders, vendor contracts and insurance certificates, leases, the rent roll, inspections and invoices',
};
const TRADE_NAME = { electrical: 'electrical', plumbing: 'plumbing', property: 'property management' };

const HVAC_WORDING = [
  /\b(?:you have )?0 customers?\b/i, // only the empty count: a real customer count is a fact, not HVAC wording
  /\bno (?:pieces of equipment|units|equipment) match(?:es)? that\b/i,
  /\b(?:you have )?\d+ pieces? of equipment\b/i,
  /\b\d+ service visits?\b/i,
  /\bno customer, unit, or document at that address\b/i,
  /\bcouldn.?t find a customer at\b/i,
  /\bcan.?t total invoice amounts yet\b.*\bfinancials update\b/i,
  /\bisn.?t on file\s*[—-]\s*not on file for that address\b/i,
  /\bnot on file for that address\b/i,
];
// a bare count of documents / work orders given to a question that asked for a state ("open", "overdue", "no vendor", ...) is a count of everything, not an answer
const STATE_Q = /\b(?:open|still|need(?:s|ed)? to be|to be done|outstanding|pending|overdue|unassigned|no vendor|not (?:yet )?(?:done|completed|assigned|closed)|incomplete|past due|failed|reinspect\w*)\b/i;
const BARE_COUNT = /^(?:yes, )?(?:you have )?\d+ (?:documents?|work orders?|service (?:tickets|visits))\b/i;
const CAPABILITY_Q = /\b(?:what can you do|what do you do|what can i ask|what can i ask you|how can you help|what are you able|what do you know)\b/i;
const NOT_IN_RECORDS = /^That.s not in your business records\./i;

const ADDR_RE = /\b(\d{1,6}\s+(?:[A-Za-z0-9.']+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Way|Ct|Court|Cir|Circle|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Trl|Trail|Loop))\b/i;

export function guardNonHvac(packId, data, question) {
  const can = TRADE_CAN[packId];
  if (!can || !data || typeof data !== 'object') return null;
  if (data.kind !== 'answer' && data.kind !== 'no-answer') return null;
  const text = String(data.text ?? '');
  const labels = Array.isArray(data.facts) ? data.facts.map((x) => String(x?.label ?? '')).join(' ') : '';
  const q = String(question ?? '');
  const hvac = HVAC_WORDING.some((re) => re.test(text) || re.test(labels));
  const stateCount = BARE_COUNT.test(text.trim()) && STATE_Q.test(q);
  const notInRecords = NOT_IN_RECORDS.test(text.trim());
  const capability = notInRecords && CAPABILITY_Q.test(q);
  if (!hvac && !stateCount && !notInRecords) return null;
  const addr = ADDR_RE.exec(q)?.[1]?.replace(/\s+/g, ' ');
  let out;
  if (capability) out = `I answer questions from your ${TRADE_NAME[packId]} paperwork: ${can}. Ask about one of those, for example a specific job or document.`;
  else if (notInRecords) out = `That's not in your ${TRADE_NAME[packId]} records. I can answer questions about ${can}.`;
  else if (addr && /\b(?:at that address|find a customer at|on file for|isn.?t on file)\b/i.test(text)) out = `I couldn't answer that for ${addr} from your ${TRADE_NAME[packId]} records. I can answer questions about ${can}.`;
  else out = `I can't answer that from your ${TRADE_NAME[packId]} records yet. I can answer questions about ${can}.`;
  return { kind: 'no-answer', text: out, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], tradeDecline: true, basis: `Nothing searched: that question does not match a ${TRADE_NAME[packId]} question DeepWell answers.` };
}
