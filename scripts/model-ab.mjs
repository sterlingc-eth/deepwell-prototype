#!/usr/bin/env node
/**
 * MODEL A/B — ROUND 20 (J4, credit-return readiness), task 3.
 *
 * Runs any exam/generalization set TWICE — rules-only (the $0 no-model path every offline-exam.mjs run
 * already proves works) vs rules+model (the real production /api/ask pipeline, model calls included) —
 * and reports accuracy, WRONG (confident-wrong is the metric this round's contract calls out as the #1
 * problem, never conflated with an honest decline/skip), latency, and $/question, broken down by
 * category. A `--budget` is a hard stop, in both modes. Nothing here duplicates offline-exam.mjs's or
 * scorecard/runner.js's own machinery — both passes are literally those same functions, called twice.
 *
 * TWO MODES:
 *   dry-run (default, and the one THIS ROUND can actually exercise — Anthropic credits are out):
 *     - runs the REAL rules-only pass (offline-exam.mjs's runOfflineExam, $0, model calls physically
 *       blocked) against the given export, exactly like `node scripts/offline-exam.mjs` does;
 *     - for exactly the questions THAT pass marks `needs-model` (never all of them — most of a real
 *       exam already answers for free), ESTIMATES what a real model call would cost, from REAL prompt
 *       token counts (promptCache.js's own estimator) of the ACTUAL system prompts/tool schemas this
 *       codebase sends (analytics.js's ANALYTICS_SYSTEM_PROMPT/ANALYTICS_TOOL for a plan call,
 *       agent/loopV2.js's RESEARCH_SYSTEM_PROMPT/tools.js's ALL_TOOL_DEFS_V2 for a research-agent run) —
 *       never a made-up number;
 *     - a `--budget` stops the estimate accumulation early once the running total would cross it,
 *       reporting how many questions were left un-costed;
 *     - with NO export given at all, still runs (self-contained, no PGlite, no DB): every question in
 *       the requested set is treated as needing the model (no rules-only classification is possible
 *       with no tenant data to ask against) and costed the same way — clearly labeled as the cruder of
 *       the two dry-run shapes.
 *   --live (only meaningful once credits exist — UNTESTED this round, see this file's own note below):
 *     runs the SAME questions for real through scorecard/runner.js's runScorecard (the actual /api/ask
 *     handler, real model calls, real $, real latency, its OWN --budget enforcement reused verbatim) and
 *     diffs against the rules-only pass: any question that went from null/honest-decline to a WRONG
 *     graded answer once the model was allowed in is flagged as a NEW confident-wrong — the exact go/
 *     no-go signal handoffs/CREDIT_RETURN_PLAYBOOK.md's first live run is built around.
 *
 * Usage:
 *   node scripts/model-ab.mjs [export.json] [--budget=5] [--live] [--agent-avg-turns=2] [--out=path]
 *
 *   node scripts/model-ab.mjs                          # dry-run, no export: crude, self-contained estimate
 *   node scripts/model-ab.mjs export.json               # dry-run: real rules-only pass + real cost estimate
 *   node scripts/model-ab.mjs export.json --budget=2    # same, stop estimating past $2
 *   node scripts/model-ab.mjs export.json --live         # (credits required) real A/B, hard-capped at $5
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  installPgHarness, installModelBlock, createPGlite, setActiveDatabase,
  loadExportIntoNewTenant, runOfflineExam, loadFullExam,
} from "./offline-exam.mjs";
import { preClassifyAnalytics, ANALYTICS_TOOL, ANALYTICS_SYSTEM_PROMPT } from "../api/_lib/analytics.js";
import { ANALYTICS_MODEL } from "../api/_lib/routes/analytics.js";
import { estimateTokens as promptEstimateTokens } from "../api/_lib/promptCache.js";
import { estimateModelCostUsd } from "../api/_lib/usage.js";

/* ============================================================== 0. CLI args (pure, exported for tests) */

export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_AGENT_AVG_TURNS = 2;

/** Pure argv parser — no process/env reads, so scripts/verify-model-ab.mjs can assert it directly. */
export function parseArgs(argv) {
  const args = { exportPath: null, budgetUsd: DEFAULT_BUDGET_USD, live: false, agentAvgTurns: DEFAULT_AGENT_AVG_TURNS, out: null };
  const positional = [];
  for (const a of argv) {
    if (a === "--live") args.live = true;
    else if (a.startsWith("--budget=")) { const n = Number(a.slice(9)); if (Number.isFinite(n) && n > 0) args.budgetUsd = n; }
    else if (a.startsWith("--agent-avg-turns=")) { const n = Number(a.slice(18)); if (Number.isFinite(n) && n >= 1) args.agentAvgTurns = n; }
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (!a.startsWith("--")) positional.push(a);
  }
  args.exportPath = positional[0] ?? null;
  return args;
}

/* ============================================================== 1. cost estimation from REAL token counts
 *
 * Every number here comes from measuring the ACTUAL prompts/schemas this codebase sends (never a guess
 * at what a call "probably" costs) — the same estimateTokens promptCache.js's own caching decisions use,
 * fed into usage.js's estimateModelCostUsd (the exact arithmetic recordModelCall's real cost figures
 * use). This is still an ESTIMATE, not a bill: it does not know the real output length or how many turns
 * a given research-agent question will actually take — see each function's own doc comment for exactly
 * what it assumes, so a reader of the report can judge how much to trust it.
 */

/** One analytics-planner call: the tool schema + system prompt (byte-identical to what
 *  planAnalyticsQuestion actually sends — see routes/analytics.js) + a short per-question question/date
 *  line, output bounded by the real max_tokens: 400 that call passes (never bigger; a plan is a handful
 *  of enum strings, so 120 is a realistic middle, not the ceiling). ONE call, always — the analytics
 *  planner is a single tool-use round trip, never a loop. */
export function estimateAnalyticsCallCostUsd() {
  const inputTokens =
    promptEstimateTokens(ANALYTICS_SYSTEM_PROMPT) +
    promptEstimateTokens({ ...ANALYTICS_TOOL, cache_control: undefined }) +
    40; // "Today's date: YYYY-MM-DD\n\nQUESTION: ..." — small and roughly constant
  const outputTokens = 120;
  return estimateModelCostUsd(ANALYTICS_MODEL, { inputTokens, outputTokens });
}

/**
 * One research-agent RUN (not one call): `avgTurns` model calls, each paying the full system prompt +
 * every tool schema's tokens again (a CONSERVATIVE/over- not under-estimate — a real run's 2nd+ turn is
 * usually served from Anthropic's prompt cache at ~1/10th the input price once agent/loopV2.js's own
 * planCacheBreakpoints wiring is actually hitting Anthropic's real cache, which this estimate does not
 * assume, on purpose: the FIRST live run should be judged against the worst case, not the optimistic
 * one). `avgTurns` defaults to DEFAULT_AGENT_AVG_TURNS (2) — override with `--agent-avg-turns` once a
 * live run's own modelCallsMs/model_calls tells us the real distribution.
 */
export async function estimateAgentRunCostUsd(avgTurns = DEFAULT_AGENT_AVG_TURNS) {
  const { RESEARCH_SYSTEM_PROMPT, RESEARCH_MODEL } = await import("../api/_lib/agent/loopV2.js");
  const { ALL_TOOL_DEFS_V2 } = await import("../api/_lib/agent/tools.js");
  const toolsTokens = ALL_TOOL_DEFS_V2.reduce((sum, t) => sum + promptEstimateTokens({ ...t, cache_control: undefined }), 0);
  const perTurnInput = promptEstimateTokens(RESEARCH_SYSTEM_PROMPT) + toolsTokens + 250; // + growing tool-result/question context per turn
  const perTurnOutput = 300; // MAX_OUTPUT_TOKENS_V2 caps each call at 1400; a real answer is usually well under it
  return { model: RESEARCH_MODEL, costUsd: estimateModelCostUsd(RESEARCH_MODEL, { inputTokens: perTurnInput * avgTurns, outputTokens: perTurnOutput * avgTurns }) };
}

/** Which route a needs-model question would most likely hit — analytics.js's own free, no-DB
 *  classifier (the SAME signal routes/analytics.js's real pipeline uses to decide whether the
 *  analytics planner is even tried) vs everything else, which falls to the research agent. */
export function guessRoute(questionText) {
  return preClassifyAnalytics(questionText) ? "analytics-planner" : "agent";
}

/**
 * Cost out a list of `{id, category, question}` rows that need the model, stopping once the running
 * total would cross `budgetUsd` (a hard stop, same principle as scorecard/runner.js's own real one —
 * this is the dry-run's version of it). Returns the per-question estimates actually produced, the
 * questions left un-costed by the budget, and per-category/overall totals.
 */
export async function estimatePlan(needsModelRows, { budgetUsd = DEFAULT_BUDGET_USD, agentAvgTurns = DEFAULT_AGENT_AVG_TURNS } = {}) {
  const agentEstimate = await estimateAgentRunCostUsd(agentAvgTurns);
  const analyticsCostUsd = estimateAnalyticsCallCostUsd();
  const priced = [];
  const deferred = [];
  let runningTotal = 0;
  for (const row of needsModelRows) {
    const route = guessRoute(row.question);
    const costUsd = route === "analytics-planner" ? analyticsCostUsd : agentEstimate.costUsd;
    if (runningTotal + costUsd > budgetUsd) { deferred.push({ ...row, route }); continue; }
    runningTotal += costUsd;
    priced.push({ id: row.id, category: row.category, route, model: route === "analytics-planner" ? ANALYTICS_MODEL : agentEstimate.model, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 });
  }
  const byCategory = new Map();
  for (const p of priced) {
    const bucket = byCategory.get(p.category) ?? { count: 0, costUsd: 0, routes: {} };
    bucket.count += 1;
    bucket.costUsd += p.costUsd;
    bucket.routes[p.route] = (bucket.routes[p.route] ?? 0) + 1;
    byCategory.set(p.category, bucket);
  }
  for (const bucket of byCategory.values()) bucket.costUsd = Math.round(bucket.costUsd * 1_000_000) / 1_000_000;
  return {
    priced, deferred,
    totalEstimatedUsd: Math.round(runningTotal * 1_000_000) / 1_000_000,
    budgetUsd,
    byCategory: Object.fromEntries([...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))),
    perCallEstimate: { analyticsPlannerUsd: analyticsCostUsd, agentRunUsd: agentEstimate.costUsd, agentModel: agentEstimate.model, agentAvgTurns },
  };
}

/* ============================================================== 2. dry-run driver */

async function dryRunWithExport(exportPath, opts) {
  await installPgHarness();
  const modelCounter = await installModelBlock(); // physically cannot spend, even if something tried
  const lite = await createPGlite();
  await setActiveDatabase(lite);

  const exportData = JSON.parse(fs.readFileSync(path.resolve(exportPath), "utf8"));
  const exam = await loadFullExam(exportData.tenantKey ?? null);
  if (!exam.questions.length) {
    console.error("model-ab: no exam questions found (run `node scripts/gen-scorecard.mjs` first).");
    process.exit(1);
  }
  const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: exportData.tenantKey ? `offline:${exportData.tenantKey}` : "model-ab", tenantName: "Model A/B" });
  const today = new Date().toISOString().slice(0, 10);

  const rulesOnly = await runOfflineExam({ ctx, questions: exam.questions, today, modelCounter });
  if (modelCounter.n > 0) console.error(`model-ab: WARNING — ${modelCounter.n} model call(s) were attempted during the rules-only pass; this should never happen (installModelBlock blocks them, but a bug could still count them wrong).`);

  const needsModelRows = rulesOnly.perQuestion.filter((r) => r.status === "needs-model");
  const plan = await estimatePlan(needsModelRows, opts);

  return { mode: "dry-run", source: "export", examVersion: exam.version, rulesOnly, needsModelCount: needsModelRows.length, plan, ctx, questions: exam.questions, today };
}

async function dryRunNoExport(opts) {
  const exam = await loadFullExam(null);
  const rows = exam.questions.map((q) => ({ id: q.id, category: q.category, question: q.text }));
  const plan = await estimatePlan(rows, opts);
  return { mode: "dry-run", source: "no-export (every question treated as needs-model — pass an export.json for the real rules-only classification)", examVersion: exam.version, needsModelCount: rows.length, plan };
}

/* ============================================================== 3. live driver (credits required)
 *
 * WRITTEN, NOT EXERCISED THIS ROUND: Anthropic credits are out (R11_RULES.md/R20_CONTRACT.md hard rule
 * — nothing this round builds may require a real model call to test), so this function has never
 * actually run against a live API key. It is built entirely from scorecard/runner.js's own, already-
 * tested `runScorecard` (the exact production /api/ask path, its own real budget/latency/cost
 * accounting, already exercised end-to-end by scripts/verify-scorecard.mjs) — nothing new is invented
 * here, only wired together and diffed against the rules-only pass above. Treat this as reviewed-by-
 * reading code, not verified-by-running code, until the first real run — see
 * handoffs/CREDIT_RETURN_PLAYBOOK.md for exactly how to run that first one safely.
 */
async function liveRun(ctx, questions, today, budgetUsd, rulesOnlyById) {
  const { runScorecard } = await import("../api/_lib/scorecard/runner.js");
  const { default: askHandler } = await import("../api/ask.js");
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };

  let offset = 0;
  let done = false;
  const pageResults = [];
  let runId;
  while (!done) {
    const page = await runScorecard({
      ctx, questions, budgetUsd, auth, handler: askHandler, runId, offset, today,
      retryFailures: false, // this A/B scores the FIRST production attempt only — no escalation retry muddying the diff
      feedMisses: false, // an A/B dry run must never feed the live learning loop
    });
    runId = page.runId;
    pageResults.push(...page.pageResults);
    offset = page.nextOffset ?? offset;
    done = page.done;
    if (page.stopped) break;
  }

  // A NEW confident-wrong: rules-only had no answer at all for this id (status !== "correct"/"wrong" —
  // i.e. needs-model/needs-grader/skipped/oracle-error), but rules+model came back both graded AND wrong.
  // This is the exact go/no-go signal: the model path must never turn "we didn't know" into "we said the
  // wrong thing confidently" (R20_CONTRACT.md's #1 problem, this time on the MODEL side of the fence).
  const newConfidentWrong = pageResults.filter((r) => {
    const before = rulesOnlyById.get(r.questionId);
    const wasAnswerable = before?.status === "correct" || before?.status === "wrong";
    return !wasAnswerable && !r.skipped && r.passed === false;
  });

  const byCategory = new Map();
  for (const r of pageResults) {
    const bucket = byCategory.get(r.category) ?? { count: 0, correct: 0, wrong: 0, costUsd: 0, latenciesMs: [] };
    bucket.count += 1;
    if (!r.skipped) { if (r.passed) bucket.correct += 1; else bucket.wrong += 1; }
    bucket.costUsd += r.costUsd ?? 0;
    if (typeof r.latencyMs === "number") bucket.latenciesMs.push(r.latencyMs);
    byCategory.set(r.category, bucket);
  }
  const summarizedByCategory = {};
  for (const [cat, b] of [...byCategory.entries()].sort(([a], [b2]) => a.localeCompare(b2))) {
    const graded = b.correct + b.wrong;
    const sorted = [...b.latenciesMs].sort((a, c) => a - c);
    summarizedByCategory[cat] = {
      count: b.count, accuracy: graded ? Math.round((b.correct / graded) * 1000) / 1000 : null,
      costUsd: Math.round(b.costUsd * 1_000_000) / 1_000_000,
      costUsdPerQuestion: b.count ? Math.round((b.costUsd / b.count) * 1_000_000) / 1_000_000 : 0,
      latencyMsP50: sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : null,
    };
  }

  return {
    mode: "live", runId, pageResults, newConfidentWrong, byCategory: summarizedByCategory,
    totalSpentUsd: pageResults.reduce((s, r) => s + (r.costUsd ?? 0), 0),
  };
}

/* ============================================================== 4. reporting */

function printDryRunReport(result) {
  console.log(`\nmodel-ab (dry-run) — ${result.source}`);
  if (result.rulesOnly) {
    console.log(`  rules-only pass ($0): ${result.rulesOnly.overall.total} questions, ${result.rulesOnly.overall.correct} correct, ${result.rulesOnly.overall.wrong} WRONG (confident-wrong), ${result.needsModelCount} need the model`);
  } else {
    console.log(`  ${result.needsModelCount} questions in the set (no rules-only pass run — no export given)`);
  }
  const { plan } = result;
  console.log(`  estimate per call: analytics-planner ~$${plan.perCallEstimate.analyticsPlannerUsd.toFixed(6)}, agent run (${plan.perCallEstimate.agentModel}, ~${plan.perCallEstimate.agentAvgTurns} turns) ~$${plan.perCallEstimate.agentRunUsd.toFixed(6)}`);
  console.log(`  priced ${plan.priced.length} question(s) within the $${plan.budgetUsd} budget, estimated total $${plan.totalEstimatedUsd}`);
  if (plan.deferred.length) console.log(`  ${plan.deferred.length} question(s) NOT priced — would exceed the $${plan.budgetUsd} budget`);
  console.log("  by category:");
  for (const [cat, b] of Object.entries(plan.byCategory)) {
    console.log(`    ${cat}: ${b.count} question(s), ~$${b.costUsd}, routes ${JSON.stringify(b.routes)}`);
  }
}

function printLiveReport(result) {
  console.log(`\nmodel-ab (live) — run ${result.runId}`);
  console.log(`  ${result.pageResults.length} question(s) asked, total spend $${Math.round(result.totalSpentUsd * 1_000_000) / 1_000_000}`);
  console.log(`  NEW confident-wrong (rules-only had no answer, rules+model answered WRONG): ${result.newConfidentWrong.length}`);
  if (result.newConfidentWrong.length) {
    console.log(`    ids: ${result.newConfidentWrong.map((r) => r.questionId).join(", ")}`);
  }
  console.log("  by category:");
  for (const [cat, b] of Object.entries(result.byCategory)) {
    console.log(`    ${cat}: n=${b.count} accuracy=${b.accuracy ?? "n/a"} $/q=${b.costUsdPerQuestion} p50=${b.latencyMsP50}ms`);
  }
}

/* ============================================================== 5. CLI */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let result;
  if (!args.exportPath) {
    result = await dryRunNoExport(args);
    printDryRunReport(result);
  } else if (!args.live) {
    result = await dryRunWithExport(args.exportPath, args);
    printDryRunReport(result);
  } else {
    // --live: run the rules-only pass first (needed for the confident-wrong diff), then the real thing
    // against the SAME already-loaded tenant/questions (no second PGlite instance, no re-import).
    const dry = await dryRunWithExport(args.exportPath, args);
    printDryRunReport(dry);
    const rulesOnlyById = new Map(dry.rulesOnly.perQuestion.map((r) => [r.id, r]));
    const live = await liveRun(dry.ctx, dry.questions, dry.today, args.budgetUsd, rulesOnlyById);
    printLiveReport(live);
    result = { dryRun: dry, live };
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2));
    console.log(`\nwrote ${args.out}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("model-ab: fatal:", err?.stack ?? err);
    process.exit(1);
  });
}
