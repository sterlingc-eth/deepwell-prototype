/**
 * Donovan agent - question shapes that go to the agent BEFORE the retrieval+model path.
 *
 * Retrieval answers from the top handful of document pages and caps a reply at 5 facts, which is
 * right for "what is the model at 17 Cactus Ln" and wrong for a corpus-wide enumeration ("who all
 * has current warranties" came back as 5 customers phrased as the whole list; the records held 13)
 * or a history question that needs the customer's own documents read ("has this unit had a
 * compressor replaced"). Pure, no DB, no model.
 */

const ENUMERATION_RES = [
  /\bwho all\b/i,
  /\b(?:list|show|give)(?: me)?(?: all| every)\b/i,
  /\b(?:all|every) (?:of )?(?:the |our |my )?(?:customers?|units?|systems?|equipment|jobs?|documents?|permits?|invoices?|warranties|agreements?|techs?|technicians?)\b/i,
  /\bwhich (?:of )?(?:our |my |the )?(?:customers?|units?|systems?|jobs?|documents?|permits?|warranties)\b[^?]*\b(?:have|has|had|are|is|were|was|do|does|did)\b/i,
];

/** "who all has ...", "list every ...", "which customers have ..." - an answer that must cover ALL matches. */
export function isEnumerationQuestion(question) {
  const q = String(question ?? "");
  return q.length > 0 && ENUMERATION_RES.some((re) => re.test(q));
}

const REPAIR_VERB = /\b(?:replac(?:e|ed|ing|ement)|repair(?:ed|ing)?|swap(?:ped)?|rebuil[dt]|recharg(?:e|ed)|refill(?:ed)?|fix(?:ed)?|changed|reprogrammed)\b/i;
const HISTORY_LEAD = /\b(?:has|have|had|did|was|were|ever)\b/i;

/** "has this unit had a compressor replaced? 12 Main St" - answered by reading that customer's documents. */
export function isRepairHistoryQuestion(question) {
  const q = String(question ?? "");
  return HISTORY_LEAD.test(q) && REPAIR_VERB.test(q);
}

const RANK_WORD = /\b(?:newest|oldest|latest|earliest|most recent)\b/i;
const UNIT_WORD = /\b(?:units?|systems?|equipment|install(?:ed|ation|s)?)\b/i;

/** "what's the newest unit we've installed" - a superlative over the units. The closed-vocabulary analytics
 *  planner has no sort for equipment (it would list them all), and retrieval reads a few pages, so neither can
 *  rank the whole fleet; a SQL ORDER BY through the agent can (live defect: retrieval named the wrong unit). */
export function isUnitRankingQuestion(question) {
  const q = String(question ?? "");
  return RANK_WORD.test(q) && UNIT_WORD.test(q);
}

const REASONING_RES = [
  /\b(?:more|fewer|less|greater)\s+(?!than\b)[a-z][a-z /&-]{1,40}?\s+(?:or|vs\.?|versus)\s+(?:more\s+|fewer\s+|less\s+)?[a-z]/i, // "more X or more Y"
  /\b(?:compare|comparison of|difference between)\b/i,
  /\bwhy\b|\bhow come\b/i,
  /\b(?:trend(?:ing|s)?|over time|year[- ]over[- ]year|month[- ]over[- ]month|growing|declin\w+)\b/i,
];

/** Team A (2026-09-24): comparisons ("more invoices or more tickets"), "why" and trend questions. The closed-vocabulary
 *  analytics planner cannot express them (it merged both sides of a comparison into one count), so an unparsed one goes
 *  to the agent - which the hard-question classifier then runs on the escalation model (agent/escalation.js). */
export function isReasoningQuestion(question) {
  const q = String(question ?? "");
  return q.length > 0 && REASONING_RES.some((re) => re.test(q));
}

/** True when the agent should get the first shot (ahead of retrieval + model). */
export function isAgentFirstQuestion(question) {
  return isEnumerationQuestion(question) || isRepairHistoryQuestion(question) || isUnitRankingQuestion(question) || isReasoningQuestion(question);
}
