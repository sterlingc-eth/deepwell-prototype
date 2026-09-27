/**
 * ROUND 20 (J4, credit-return readiness), task 3: checks for scripts/model-ab.mjs — specifically the
 * pieces that can actually run this week (Anthropic credits are out): argument parsing and the dry-run
 * cost estimator. The `--live` path (scorecard/runner.js's runScorecard against a real model) is NOT
 * exercised here — see model-ab.mjs's own doc comment on that function ("written, not exercised").
 *
 *   node scripts/verify-model-ab.mjs
 */
import { parseArgs, estimateAnalyticsCallCostUsd, estimateAgentRunCostUsd, guessRoute, estimatePlan, DEFAULT_BUDGET_USD, DEFAULT_AGENT_AVG_TURNS } from './model-ab.mjs';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/* ============================================================ 1. parseArgs (pure) */

{
  const a = parseArgs([]);
  check('parseArgs: no args -> sane defaults', a.exportPath === null && a.budgetUsd === DEFAULT_BUDGET_USD && a.live === false && a.agentAvgTurns === DEFAULT_AGENT_AVG_TURNS && a.out === null);
}
{
  const a = parseArgs(['export.json', '--budget=3.5', '--live', '--agent-avg-turns=4', '--out=x.json']);
  check('parseArgs: every flag parsed correctly', a.exportPath === 'export.json' && a.budgetUsd === 3.5 && a.live === true && a.agentAvgTurns === 4 && a.out === 'x.json', JSON.stringify(a));
}
{
  const a = parseArgs(['--budget=not-a-number']);
  check('parseArgs: a garbage --budget value falls back to the default, never NaN', a.budgetUsd === DEFAULT_BUDGET_USD);
}
{
  const a = parseArgs(['--budget=-5']);
  check('parseArgs: a negative --budget falls back to the default', a.budgetUsd === DEFAULT_BUDGET_USD);
}
{
  const a = parseArgs(['first.json', 'second.json']);
  check('parseArgs: only the FIRST positional arg is the export path', a.exportPath === 'first.json');
}

/* ============================================================ 2. cost estimation (real token counts, no network) */

{
  const cost = estimateAnalyticsCallCostUsd();
  check('estimateAnalyticsCallCostUsd: a small positive dollar figure (a Haiku plan call is cheap)', cost > 0 && cost < 0.01, String(cost));
}
{
  const est1 = await estimateAgentRunCostUsd(1);
  const est2 = await estimateAgentRunCostUsd(2);
  check('estimateAgentRunCostUsd: names the real research model', est1.model === 'claude-sonnet-4-5' || typeof est1.model === 'string', est1.model);
  check('estimateAgentRunCostUsd: more turns costs strictly more', est2.costUsd > est1.costUsd, `${est1.costUsd} vs ${est2.costUsd}`);
  check('estimateAgentRunCostUsd: a research-agent run costs meaningfully more than one analytics-planner call', est1.costUsd > estimateAnalyticsCallCostUsd() * 5, `agent=${est1.costUsd}, analytics=${estimateAnalyticsCallCostUsd()}`);
}

/* ============================================================ 3. route guessing */

check('guessRoute: a plain count/brand question -> analytics-planner', guessRoute('how many trane units do we have') === 'analytics-planner');
check('guessRoute: a narrative/history question -> agent', guessRoute('what did we discuss with the customer about the leak last year') === 'agent');

/* ============================================================ 4. estimatePlan: budget is a hard stop */

{
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, category: 'test', question: 'how many trane units do we have' }));
  const analyticsCost = estimateAnalyticsCallCostUsd();
  const tinyBudget = analyticsCost * 3.5; // room for 3, not 4
  const plan = await estimatePlan(rows, { budgetUsd: tinyBudget, agentAvgTurns: 1 });
  check('estimatePlan: prices exactly as many questions as fit the budget', plan.priced.length === 3, `priced=${plan.priced.length}`);
  check('estimatePlan: defers the rest, never drops them silently', plan.deferred.length === 7, `deferred=${plan.deferred.length}`);
  check('estimatePlan: total estimated spend never exceeds the budget', plan.totalEstimatedUsd <= tinyBudget + 1e-9, `${plan.totalEstimatedUsd} vs ${tinyBudget}`);
  check('estimatePlan: byCategory rolls up to the same priced count', plan.byCategory.test.count === plan.priced.length);
}
{
  const rows = [{ id: 'a', category: 'cat1', question: 'how many trane units do we have' }, { id: 'b', category: 'cat2', question: 'tell me the whole history of this customer and every visit' }];
  const plan = await estimatePlan(rows, { budgetUsd: 1000, agentAvgTurns: 2 });
  check('estimatePlan: a generous budget prices every question', plan.priced.length === 2 && plan.deferred.length === 0);
  check('estimatePlan: each question is routed independently', plan.priced.find((p) => p.id === 'a')?.route === 'analytics-planner' && plan.priced.find((p) => p.id === 'b')?.route === 'agent');
}
{
  const plan = await estimatePlan([], { budgetUsd: 5 });
  check('estimatePlan: an empty question list -> empty plan, never throws', plan.priced.length === 0 && plan.deferred.length === 0 && plan.totalEstimatedUsd === 0);
}

console.log('');
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
