/**
 * Donovan v2 — the router between the high-confidence deterministic fast layer and the research agent.
 *
 * The fast layer stays exactly what it was before v2 (api/ask.js's own pre-routers, in order: the
 * meta-question router, deterministicRouter.js, fastPath.js, contactLookup.js, docLookup.js,
 * contentCount.js, and the financials money gate) — each answers an EXACT, provably-right shape with
 * no model call at all. Nothing here changes those; this module only classifies what is left, once
 * every one of those has already declined, so ask.js can log why a question is about to go to the
 * (Sonnet, expensive-by-comparison) research agent instead of quietly always doing so.
 *
 * No real Haiku call: classifyRoute is a pure, free regex pass reusing the SAME cheap signals the
 * codebase already computes for this decision (agent/intents.js's enumeration/reasoning/ranking shapes
 * and agent/escalation.js's hard-question scorer) — the build spec explicitly allows "a cheap Haiku
 * classifier (OR THE EXISTING INTENTS)"; reusing them costs nothing and never disagrees with the
 * decisions those modules already make elsewhere in the pipeline.
 *
 * logRouteDecision logs COUNTS ONLY: a route id and a list of short reason codes, never question text,
 * never an answer, never a row value — same rule every other log line in this codebase follows.
 */
import { isEnumerationQuestion, isRepairHistoryQuestion, isUnitRankingQuestion, isReasoningQuestion } from "./intents.js";
import { classifyQuestionDifficulty } from "./escalation.js";

/**
 * Pure. `{route: 'research'|'simple', reasons: string[]}` — every question that reaches this point
 * already fell through the whole deterministic fast layer, so `route` is 'research' by default; 'simple'
 * only marks a question that also looks like a single, narrow lookup (no comparison/reasoning/list
 * shape) purely for the route-decision log, since even a 'simple' question here still runs on the
 * research agent (it just needs fewer tools/turns to answer, which the agent's own budgeting handles).
 */
export function classifyRoute(question) {
  const q = String(question ?? "");
  const reasons = [];
  if (isEnumerationQuestion(q)) reasons.push("enumeration");
  if (isRepairHistoryQuestion(q)) reasons.push("repair-history");
  if (isUnitRankingQuestion(q)) reasons.push("unit-ranking");
  if (isReasoningQuestion(q)) reasons.push("reasoning");
  const diff = classifyQuestionDifficulty(q);
  if (diff.hard) reasons.push(...diff.reasons.map((r) => `hard:${r}`));
  return { route: reasons.length ? "research" : "simple", reasons };
}

// In-process counters (best-effort telemetry only, reset on cold start — a durable count belongs in a
// dashboard reading the log lines below, not in this process's memory).
const counts = new Map();

/** Logs ONE JSON line: {route: 'donovan_route', decision: 'research'|'simple', reasons: [...]}. No
 *  question text, no answer content. Also keeps an in-process running count for a cheap /debug surface. */
export function logRouteDecision(question, extra = {}) {
  const { route, reasons } = classifyRoute(question);
  const key = `${route}:${reasons.join(",")||"none"}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  console.log(JSON.stringify({ route: "donovan_route", decision: route, reasons, ...extra }));
  return { route, reasons };
}

/** Test/debug only: the in-process route-decision tally since cold start. */
export function routeDecisionCounts() {
  return Object.fromEntries(counts);
}

export function resetRouteDecisionCountsForTests() {
  counts.clear();
}
