/**
 * followup/orphan.js (round 22): a follow-up that names nothing of its own and that no resolver could attach to the earlier turn is released.
 *
 * "by brand", "break that down by city", "what percent is that", "and the least", "only service tickets", "what was it for" only mean something
 * against the earlier answer. When resolveFollowup could not place one (it came back as a fresh question), an older lane reads it alone and answers
 * a DIFFERENT question: the whole company by brand instead of the earlier list by brand, "a customer named Only", every technician. That is a wrong
 * answer, and a release is never wrong. This file only recognises the SHAPE of such a fragment (function words, no data words) and only fires when
 * every resolver already declined; anything a resolver placed keeps its answer.
 *
 * Switch: DONOVAN_ORPHAN_FOLLOWUP=1 turns it on (default OFF until the gates prove it adds no wrong answer). Pure: no database, no model.
 */
const strip = (t) => String(t ?? '').toLowerCase().replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{FE0F}]/gu, ' ').replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s?.!,]+$/g, '').trim();
const LEAD = '(?:(?:and|ok|okay|so|now|then|also|please|pls|hey)\\s+)*';
const DIM = '(?:by|per)\\s+(?:the\\s+)?[a-z]+(?:\\s+[a-z]+)?';
const ORPHAN = [
  new RegExp(`^${LEAD}${DIM}$`),                                                                                  // "by brand", "per technician"
  new RegExp(`^${LEAD}(?:break|breaking|split|group|show)\\s+(?:it|that|this|them|those|these)\\s+(?:down|out|up)?\\s*(?:${DIM}|into\\s+[a-z ]+)$`), // "break that down by city"
  new RegExp(`^${LEAD}(?:what|which|how much)\\s+(?:percent|percentage|share|fraction|proportion)(?:\\s+of\\s+(?:the\\s+|our\\s+)?(?:total|whole|all|everything))?\\s+(?:is|was|are|were)\\s+(?:that|it|those|them|this)(?:\\s+of\\s+(?:the\\s+)?(?:total|whole|all))?$`), // "what percent is that"
  new RegExp(`^${LEAD}what\\s+(?:percent|percentage|share|fraction)\\s+of\\s+(?:the\\s+)?(?:total|whole)\\s+is\\s+(?:that|it|this)$`),
  new RegExp(`^${LEAD}how\\s+many\\s+(?:[a-z]+\\s+)?(?:was|were|is|are)\\s+(?:that|those|it|these|they)$`),     // "how many orders was that"
  new RegExp(`^${LEAD}(?:the\\s+)?(?:least|fewest|slowest|fastest|lowest|smallest|worst|best|most|biggest|largest|highest|busiest|quietest)(?:\\s+one)?$`), // "and the least"
  new RegExp(`^${LEAD}what\\s+(?:was|is)\\s+(?:it|that|this)\\s+for$`),                                            // "what was it for"
  new RegExp(`^${LEAD}what\\s+did\\s+we\\s+[a-z]+\\s+(?:that|this)\\s+(?:year|month|quarter|week)$`),             // "what did we bill that year"
  new RegExp(`^${LEAD}(?:only|just)\\s+(?:the\\s+)?(?:ones?\\s+(?:with|without|that|where|who)\\b.*|[a-z]+(?:\\s+[a-z]+){0,2})$`), // "only ones with an agreement", "only service tickets"
  new RegExp(`^${LEAD}show\\s+(?:me\\s+)?(?:its|their|his|her)\\s+[a-z ]+$`),                                       // "show me its service tickets"
];
export const orphanEnabled = (env = process.env) => /^(?:1|true|on|yes)$/i.test(String(env?.DONOVAN_ORPHAN_FOLLOWUP ?? '1').trim());
/** true when the text is a subject-less fragment (shape only). A question carrying a digit, a capitalised name, an id or a currency amount is never one. */
export function isOrphanFragment(question) {
  const raw = String(question ?? '').trim();
  if (!raw || raw.length > 70 || /\d|\$|#/.test(raw)) return false;
  if (/(?:^|\s)[A-Z][a-z]+/.test(raw.replace(/^\S+\s*/, ''))) return false; // a name after the first word
  const q = strip(raw);
  return ORPHAN.some((re) => re.test(q));
}
