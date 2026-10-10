/**
 * R45 (Builder 2) - "will the research agent answer this anyway?" Pure, no I/O.
 *
 * The Haiku analytics planner (routes/analytics.js planAnalyticsQuestion) emits ONE plan in a closed vocabulary (count / list / groupBy / sum
 * over five entities). For questions whose SHAPE that vocabulary cannot express - a ratio, an average, a comparison, a busiest-period, a trend, a
 * "why", a repair-history lookup, a fleet ranking, a vague season / "year before last" / "soon" - the plan comes back unusable and the Sonnet
 * research agent runs next anyway, so the planner call was pure cost. When the agent is enabled those questions skip the planner and go straight to it.
 *
 * Enumerations ("which customers have ...") are deliberately NOT agent-bound here: the planner handles them, and sending them to Sonnet instead
 * would cost more. With the agent off nothing changes: every question still gets the planner.
 */
import { isRepairHistoryQuestion, isUnitRankingQuestion, isReasoningQuestion } from "../agent/intents.js";

export const plannerSkipEnabled = () => process.env.DONOVAN_PLANNER_SKIP !== "0";

/** Is the research agent the next stop for a question the planner cannot plan? (same switches ask.js's tryAgent obeys) */
export function researchAgentOn(env = process.env) {
  return env?.DONOVAN_AGENT !== "0" && env?.DONOVAN_RESEARCH_AGENT !== "0" && env?.DONOVAN_ESCALATION !== "0";
}

const UNPLANNABLE_RES = [
  /\b(?:percent(?:age)?|proportion|ratio|fraction)\b|\bshare\s+of\b|%/i,
  /\b(?:average|averages|avg|mean|median|typical)\b/i,
  /\b(?:busiest|slowest|quietest|peak)\b|\bwhich\s+(?:month|year|week|day|season)\s+(?:had|has|saw|did)\b/i,
  /\b(?:compare|compared|comparison|versus|vs\.?)\b/i,
  /\b(?:year\s+before\s+last|(?:this|last|next|past)\s+(?:spring|summer|fall|autumn|winter)|lately|recently|a\s+while\s+(?:ago|back))\b/i,
  /\b(?:soon|might|probably|likely|should\s+we|worth)\b/i,
];

/** True when this question's shape is outside the planner's vocabulary and the agent would run next anyway. */
export function isAgentBoundShape(question) {
  const q = String(question ?? "");
  if (!q.trim()) return false;
  return isReasoningQuestion(q) || isRepairHistoryQuestion(q) || isUnitRankingQuestion(q) || UNPLANNABLE_RES.some((re) => re.test(q));
}

/** The one decision routes/analytics.js asks: skip the Haiku planner call for this question? */
export function shouldSkipPlanner(question, env = process.env) {
  return plannerSkipEnabled() && researchAgentOn(env) && isAgentBoundShape(question);
}
