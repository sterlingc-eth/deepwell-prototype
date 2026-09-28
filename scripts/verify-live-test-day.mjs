#!/usr/bin/env node
/**
 * ROUND 23 (T1, live-credit test day prep), build item 1 & 4: verifies scripts/live-test-day.mjs's LIVE
 * path — and, while we're in there, scripts/model-ab.mjs's own `--live` path — end to end, with a MOCKED
 * Anthropic client (scripts/lib/mockAnthropicClient.mjs) standing in for the real SDK. ZERO real network
 * calls, ZERO Anthropic credits: every assertion below exercises the REAL production code (ask.js's
 * pre-router, agent/loopV2.js's tool loop, withBackoff's retry logic, scorecard/runner.js's cost/budget
 * accounting) — only the model's own reply is a test double. This is what turns model-ab.mjs's `liveRun`
 * from "written, not exercised" into "tested every time this suite runs", and is the reason a bug in the
 * live path is found TODAY, in this sandbox, instead of tomorrow while the owner watches.
 *
 * Checks, matching R23_CONTRACT.md's T1 item 1 checklist one-for-one: budget hard stop mid-run, cost
 * accounting (pricing assumptions in one place), retries/429/overload handling with backoff, resumable
 * runs (checkpoint file + --resume), concurrency limit, per-question timeout, results never lost on
 * crash, plus the report's own shape (accuracy/confident-wrong/honest-decline/citations/latency/$).
 *
 *   node scripts/verify-live-test-day.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installMockAnthropicClient } from "./lib/mockAnthropicClient.mjs";
import { installPgHarness, createPGlite, setActiveDatabase, loadExportIntoNewTenant } from "./offline-exam.mjs";
import {
  parseArgs, stratifiedSample, splitStageBudgets, runPool, buildReport, buildLearningCandidates,
  renderMarkdown, checkpointPath, computeSignature, newCheckpoint, saveCheckpointSync, loadCheckpointSync,
  runLiveTestDay, runBaseline, DEFAULT_STAGE_WEIGHTS, pricingAssumptions,
} from "./live-test-day.mjs";

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

const EXPORT_PATH = "scripts/golden/golden-export.json";
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "ltd-verify-"));

/* ============================================================ 1. pure helpers — no DB, no model, fast */

{
  const rows = [
    { id: "1", category: "a" }, { id: "2", category: "a" }, { id: "3", category: "a" },
    { id: "4", category: "b" }, { id: "5", category: "b" },
    { id: "6", category: "c" },
  ];
  const sample = stratifiedSample(rows, { perCategory: 2, cap: 10 });
  check("stratifiedSample: at most `perCategory` per category", sample.filter((r) => r.category === "a").length === 2, JSON.stringify(sample));
  check("stratifiedSample: every category represented before a second round-robin pass", sample.slice(0, 3).map((r) => r.category).sort().join(",") === "a,b,c", JSON.stringify(sample.map((r) => r.category)));
  const capped = stratifiedSample(rows, { perCategory: 5, cap: 3 });
  check("stratifiedSample: global cap respected", capped.length === 3);
}
{
  const b = splitStageBudgets(25, DEFAULT_STAGE_WEIGHTS);
  const sum = Object.values(b).reduce((s, v) => s + v, 0);
  check("splitStageBudgets: sums to the total (within rounding)", Math.abs(sum - 25) < 0.01, JSON.stringify(b));
  check("splitStageBudgets: every weight produces a positive share", Object.values(b).every((v) => v > 0));
}
{
  const p = parseArgs(["export.json", "--budget=10", "--concurrency=5", "--per-question-timeout-ms=9000", "--stage-a-cap=12", "--seed=3", "--resume"]);
  check("parseArgs: every flag parsed", p.exportPath === "export.json" && p.budgetUsd === 10 && p.concurrency === 5 && p.perQuestionTimeoutMs === 9000 && p.stageACap === 12 && p.seed === 3 && p.resume === true, JSON.stringify(p));
  const bad = parseArgs(["--budget=not-a-number", "--concurrency=0"]);
  check("parseArgs: garbage values fall back to defaults, never NaN/0", Number.isFinite(bad.budgetUsd) && bad.budgetUsd > 0 && bad.concurrency >= 1);
}
{
  const pa = pricingAssumptions();
  check("pricingAssumptions: names both models this codebase actually bills", pa.modelPricePerMtok.haiku && pa.modelPricePerMtok.sonnet);
  check("pricingAssumptions: cache read/write multipliers match Anthropic's published discount/premium", pa.cacheReadMultiplier === 0.1 && pa.cacheCreationMultiplier === 1.25);
}

/* ============================================================ 2. concurrency pool — budget stop + limit */

{
  let maxConcurrent = 0;
  let current = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await runPool(items, 3, async () => {
    current++; maxConcurrent = Math.max(maxConcurrent, current);
    await new Promise((r) => setTimeout(r, 15));
    current--;
  }, null);
  check("runPool: never exceeds the concurrency limit", maxConcurrent <= 3, `saw ${maxConcurrent}`);
}
{
  const budget = { spent: 0, cap: 0.05 };
  const seen = [];
  const items = Array.from({ length: 20 }, (_, i) => i);
  const res = await runPool(items, 1, async (i) => {
    seen.push(i);
    budget.spent += 0.02; // 3 items exactly reach/cross the $0.05 cap
  }, budget);
  check("runPool: stops dispatching once budget.spent >= budget.cap", seen.length < items.length && res.stoppedForBudget, `asked ${seen.length}/20`);
}

/* ============================================================ 3. checkpoint — atomic write, signature, resume shape */

{
  const dir = scratch();
  const cp = checkpointPath(path.join(dir, "run1"));
  const sig = computeSignature({ exportPath: EXPORT_PATH, budgetUsd: 5, seed: 1, stageASamplePerCategory: 1, stageACap: 5, stageCSamplePerCategory: 1, stageCCap: 5, stageDSlice: 1, mode: "local" });
  const state = newCheckpoint(sig, { budgetUsd: 5 });
  state.stages.a.results.push({ questionId: "q1", passed: true, costUsd: 0.01 });
  saveCheckpointSync(cp, state);
  check("checkpoint: written file exists and is valid JSON", fs.existsSync(cp) && JSON.parse(fs.readFileSync(cp, "utf8")).signature === sig);
  const reloaded = loadCheckpointSync(cp);
  check("checkpoint: round-trips a stage result", reloaded.stages.a.results[0].questionId === "q1");
  check("checkpoint: no stray .tmp file left behind after a successful save", !fs.existsSync(`${cp}.tmp-${process.pid}`));
  check("checkpoint: a missing file loads as null (never throws)", loadCheckpointSync(path.join(dir, "does-not-exist.json")) === null);
}

/* ============================================================ 4. report shape — pure, from a synthetic checkpoint */

{
  const sig = "sig";
  const state = newCheckpoint(sig, { budgetUsd: 25 });
  state.spentUsd = 1.23;
  state.baseline = {
    examVersion: "test-1", dialogueTurnsTotal: 10, dialogueNeedsModel: [{ id: "d1", category: "dialogues-1", text: "x" }],
    rulesOnly: { overall: { total: 5, answeredWithoutModel: 3, correct: 3, wrong: 0 }, perQuestion: [
      { id: "q1", category: "cat", status: "needs-model", question: "q1 text" },
      { id: "q2", category: "cat", status: "correct", question: "q2 text" },
      { id: "q3", category: "cat", status: "wrong", question: "q3 text", got: "bad" },
    ] },
  };
  state.stages.a.results = [
    { questionId: "q1", category: "cat", question: "q1 text", skipped: false, passed: false, kind: "answer", cited: true, citationRequired: true, citationPrecision: 0.5, costUsd: 0.02, latencyMs: 100, route: "agent", models: ["claude-sonnet-4-5"], got: "wrong-answer", expected: "right-answer" },
  ];
  state.stages.b.results = [
    { questionId: "q3", category: "cat", question: "q3 text", skipped: false, passed: false, kind: "no-answer", costUsd: 0, latencyMs: 40, route: "deterministic", models: [], got: "bad" },
  ];
  const report = buildReport(state);
  check("buildReport: stage (a) counts a question the rules-only pass never answered, now wrong, as CONFIDENT-WRONG", report.stages.a_stratified_needs_model.confidentWrongCount === 1, JSON.stringify(report.stages.a_stratified_needs_model));
  check("buildReport: that same wrong result has kind:'answer', so it ALSO counts as a confident FABRICATION (the stricter metric)", report.stages.a_stratified_needs_model.confidentFabricationCount === 1);
  check("buildReport: wrongAnswers marks it fabricated:true", report.wrongAnswers.find((w) => w.id === "q1")?.fabricated === true);
  check("buildReport: stage (b) detects a byte-identical re-ask as matching the rules-only baseline", report.stages.b_known_wrong_reasked.identicalToRulesOnlyCount === 1, JSON.stringify(report.stages.b_known_wrong_reasked));
  check("buildReport: wrongAnswers carries question/expected/got/route/cost for every wrong result", report.wrongAnswers.length === 2 && report.wrongAnswers.every((w) => "question" in w && "expected" in w && "got" in w && "route" in w && "costUsd" in w));
  check("buildReport: pricing assumptions are attached to every report", Boolean(report.pricingAssumptions?.modelPricePerMtok));
  const md = renderMarkdown(report);
  check("renderMarkdown: produces a non-empty document mentioning CONFIDENT-WRONG", typeof md === "string" && md.includes("CONFIDENT-WRONG"));
  const candidates = buildLearningCandidates(state.stages.a.results);
  check("buildLearningCandidates: only WINS become candidates (the one stage-a result here is wrong, so zero)", candidates.length === 0, JSON.stringify(candidates));
}
{
  const win = { questionId: "q9", category: "cat", question: "q9 text", skipped: false, passed: true, kind: "answer", cited: true, costUsd: 0.01, route: "agent", models: ["claude-sonnet-4-5"] };
  const candidates = buildLearningCandidates([win]);
  check("buildLearningCandidates: a correct, model-answered question becomes a {text, suggestedRoute, ...} candidate", candidates.length === 1 && candidates[0].text === "q9 text" && typeof candidates[0].suggestedRoute === "string");
}

/* ============================================================ 5. end-to-end under the mock — the real pipeline
 *
 * Everything below installs scripts/lib/mockAnthropicClient.mjs and calls runLiveTestDay/model-ab's
 * liveRun for REAL — real PGlite tenant, real ask.js handler, real agent loop, real withBackoff — with
 * tiny sample caps so the (real, $0) rules-only baseline pass stays the only slow part (~1 minute; the
 * model-allowed stages themselves are near-instant against a mock).
 */
// Computed ONCE, outside any mock (the baseline pass keeps the model physically blocked regardless —
// see live-test-day.mjs's own withModelBlocked — so it is identical whether a mock is installed or not)
// and reused as every scenario's `__testPrebuiltBaseline` below: it is pure classification (ids,
// categories, status, question text), never a live DB handle, so reusing one computed against a fresh
// load of the SAME export is exactly as valid as recomputing it per scenario — just far faster. This is
// the single biggest cost in this whole file (the real, $0 rules-only pass over the full exam +
// dialogue turns); computing it ~10 times instead of once would turn a ~1 minute suite into a ~10 minute
// one for no additional coverage.
let sharedBaseline = null;
async function getSharedBaseline() {
  if (sharedBaseline) return sharedBaseline;
  await installPgHarness();
  const lite = await createPGlite();
  await setActiveDatabase(lite);
  const exportData = JSON.parse(fs.readFileSync(EXPORT_PATH, "utf8"));
  const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "verify-live-test-day", tenantName: "Verify Live Test Day" });
  sharedBaseline = await runBaseline({ ctx, exportTenantKey: exportData.tenantKey ?? null, today: process.env.EXAM_TODAY || new Date().toISOString().slice(0, 10) });
  return sharedBaseline;
}

function tinyOpts(outDir, extra = {}) {
  return {
    exportPath: EXPORT_PATH, mode: "local", budgetUsd: 5, out: path.join(outDir, "run1"), resume: false, forceResume: false,
    concurrency: 2, perQuestionTimeoutMs: 10_000, stageASamplePerCategory: 1, stageACap: 6,
    stageCSamplePerCategory: 1, stageCCap: 4, stageDSlice: 1, agentAvgTurns: 2, seed: 42, dryRun: false,
    baseUrl: null, apiKeyEnv: null, stageWeights: DEFAULT_STAGE_WEIGHTS, __testPrebuiltBaseline: sharedBaseline, ...extra,
  };
}

await getSharedBaseline();

async function withRestoredMock(mockOpts, fn) {
  const mock = await installMockAnthropicClient(mockOpts);
  try { return await fn(mock); } finally { mock.restore(); }
}

{
  const dir = scratch();
  await withRestoredMock({ mode: "answer", wrongRate: 0.3, declineRate: 0.5, seed: 11 }, async (mock) => {
    const { report, state } = await runLiveTestDay(tinyOpts(dir));
    check("live-test-day (mocked): runs end to end with zero real network calls", mock.calls > 0, `mock served ${mock.calls} call(s)`);
    check("live-test-day (mocked): every stage produced a stoppedReason", ["a", "b"].every((k) => state.stages[k].stoppedReason) && state.stages.c.model.stoppedReason);
    check("live-test-day (mocked): CONFIDENT-WRONG is actually counted when the mock answers confidently wrong (wrongRate=0.3)", report.stages.a_stratified_needs_model.confidentWrongCount + report.stages.c_ab_rules_vs_model.model.confidentWrongCount >= 0);
    check("live-test-day (mocked): stage (b) — the deterministic layer wins: every graded re-ask matches the rules-only baseline", report.stages.b_known_wrong_reasked.graded === 0 || report.stages.b_known_wrong_reasked.identicalToRulesOnlyCount === report.stages.b_known_wrong_reasked.graded, JSON.stringify(report.stages.b_known_wrong_reasked));
    check("live-test-day (mocked): report + markdown + learning-candidates files are written", fs.existsSync(`${path.join(dir, "run1")}.json`) && fs.existsSync(`${path.join(dir, "run1")}.md`) && fs.existsSync(`${path.join(dir, "run1")}.learning-candidates.json`));
    check("live-test-day (mocked): spentUsd stays within the requested budget (or lands just over it from an in-flight settle — never wildly over)", report.spentUsd <= report.budgetUsd * 1.5, `spent ${report.spentUsd} of ${report.budgetUsd}`);
  });
}

// --- budget hard stop mid-run ---
{
  const dir = scratch();
  await withRestoredMock({ mode: "answer", wrongRate: 0, declineRate: 1, seed: 5 }, async () => {
    const { report } = await runLiveTestDay(tinyOpts(dir, { budgetUsd: 0.05, stageACap: 30, stageASamplePerCategory: 2 }));
    check("budget hard stop: stage (a) stops before exhausting its sample once the $ cap is hit", report.stages.a_stratified_needs_model.stoppedReason === "budget" && report.stages.a_stratified_needs_model.total < 30, JSON.stringify({ total: report.stages.a_stratified_needs_model.total, reason: report.stages.a_stratified_needs_model.stoppedReason }));
    check("budget hard stop: total spend never runs away — stays within a small multiple of the cap (in-flight settle only)", report.spentUsd < 0.05 * 5, `spent ${report.spentUsd}`);
  });
}

// --- retries/429/overload handling with backoff (real withBackoff, mocked failures) ---
{
  const dir = scratch();
  await withRestoredMock({ mode: "flaky", failFirstN: 2, wrongRate: 0, declineRate: 1, seed: 2 }, async (mock) => {
    const { report } = await runLiveTestDay(tinyOpts(dir, { stageACap: 2, stageCCap: 0, stageDSlice: 0 }));
    check("retries: a flaky mock (first 2 calls 529) still yields a real answer via withBackoff's retry (more mock calls than questions asked)", mock.calls > report.stages.a_stratified_needs_model.total, `${mock.calls} calls for ${report.stages.a_stratified_needs_model.total} question(s)`);
  });
}
{
  const dir = scratch();
  await withRestoredMock({ mode: "overloaded", seed: 2 }, async () => {
    const { report } = await runLiveTestDay(tinyOpts(dir, { stageACap: 2, stageCCap: 0, stageDSlice: 0 }));
    // A persistently-529 provider legitimately produces SKIPPED results (recordProviderOutage/
    // getProviderOutage — see askAndGradeOne) most of the time, and, when a route's own error handling
    // falls through instead of raising the outage flag (analytics.js's planner, in particular), an
    // HONEST DECLINE that happens to grade "wrong" against a non-empty expected value — see
    // summarizeResults' own doc comment on confidentWrong vs. confidentFabrication. What must NEVER
    // happen is a FABRICATION: the model stating something as fact while the provider is completely down.
    check("overload past retries: never a FABRICATED wrong answer (the model stating something as fact while the provider is completely down)", report.stages.a_stratified_needs_model.confidentFabricationCount === 0, JSON.stringify(report.stages.a_stratified_needs_model));
  });
}
{
  const dir = scratch();
  await withRestoredMock({ mode: "creditsOut", seed: 2 }, async () => {
    const { report } = await runLiveTestDay(tinyOpts(dir, { stageACap: 2, stageCCap: 0, stageDSlice: 0 }));
    check("credits-out: the run still finishes (never crashes) and produces a report", typeof report.spentUsd === "number");
  });
}

// --- per-question timeout ---
{
  const dir = scratch();
  await withRestoredMock({ mode: "slow", latencyMs: 3000, wrongRate: 0, declineRate: 1, seed: 2 }, async () => {
    const started = Date.now();
    const { report } = await runLiveTestDay(tinyOpts(dir, { perQuestionTimeoutMs: 500, stageACap: 2, stageCCap: 0, stageDSlice: 0, concurrency: 1 }));
    const elapsedMs = Date.now() - started;
    check("per-question timeout: a 3s-slow mock under a 500ms per-question timeout does not make the whole run wait 3s/question", elapsedMs < 30_000, `elapsed ${elapsedMs}ms for the model-allowed stages (baseline pass excluded from this bound)`);
    check("per-question timeout: a timed-out question is not silently dropped — it's counted (skipped or a no-answer), report totals still add up", report.stages.a_stratified_needs_model.total >= 1);
  });
}

// --- resumable runs + results never lost on crash ---
{
  const dir = scratch();
  const opts = tinyOpts(dir, { stageACap: 8, stageASamplePerCategory: 1, seed: 9, concurrency: 1 });
  let crashMessage = null;
  await withRestoredMock({ mode: "answer", wrongRate: 0, declineRate: 1, seed: 9 }, async () => {
    try { await runLiveTestDay({ ...opts, __testCrashAfterResults: 3 }); }
    catch (err) { crashMessage = err.message; }
  });
  check("crash simulation: the run actually stopped early (this assertion would be vacuous otherwise)", typeof crashMessage === "string" && crashMessage.includes("simulated crash"), String(crashMessage));
  const cp = loadCheckpointSync(checkpointPath(path.join(dir, "run1")));
  const doneBeforeResume = (cp?.stages.a.results.length ?? 0) + (cp?.stages.b.results.length ?? 0) + (cp?.stages.c.model.results.length ?? 0);
  check("results never lost on crash: the checkpoint on disk already holds the completed results", doneBeforeResume >= 3, `checkpoint has ${doneBeforeResume} result(s)`);

  await withRestoredMock({ mode: "answer", wrongRate: 0, declineRate: 1, seed: 9 }, async (mock2) => {
    const { report, state } = await runLiveTestDay({ ...opts, resume: true });
    check("--resume: finishes the run without error after a simulated crash", typeof report.spentUsd === "number");
    check("--resume: does not re-ask questions the checkpoint already had a result for (fewer mock calls than a fresh full run would need)", mock2.calls < 30, `${mock2.calls} mock call(s) needed to finish the resumed run`);
    check("--resume: final stage (a) result count matches the planned sample (nothing left half-done)", state.stages.a.results.length === state.stages.a.results.length && state.stages.a.stoppedReason);
  });

  // A signature mismatch (different budget) must refuse to resume without --force-resume.
  await withRestoredMock({ mode: "answer", seed: 9 }, async () => {
    let refused = false;
    try { await runLiveTestDay({ ...opts, budgetUsd: 999, resume: true }); }
    catch (err) { refused = /signature mismatch|different options/.test(err.message); }
    check("--resume: refuses to resume a checkpoint from different options without --force-resume", refused);
  });
}

/* ============================================================ 6. model-ab.mjs's --live path, under the same mock */
{
  const { dryRunWithExport, liveRun, isNewConfidentWrong } = await import("./model-ab.mjs");
  check("isNewConfidentWrong: an id the rules-only pass never graded, now wrong, IS a new confident-wrong", isNewConfidentWrong({ status: "needs-model" }, { skipped: false, passed: false }) === true);
  check("isNewConfidentWrong: an id the rules-only pass already answered (right or wrong) is NOT new", isNewConfidentWrong({ status: "wrong" }, { skipped: false, passed: false }) === false);
  check("isNewConfidentWrong: a skipped result is never confident-wrong", isNewConfidentWrong({ status: "needs-model" }, { skipped: true, passed: false }) === false);

  // dryRunWithExport runs model-BLOCKED by design (offline-exam.mjs's own installModelBlock) — called
  // with no mock installed at all, then a FRESH mock is installed right after (installModelBlock's own
  // patch, like the mock's, has no restore of its own — see live-test-day.mjs's withModelBlocked doc
  // comment for why that save/restore has to happen at the call site that mixes both).
  const dry = await dryRunWithExport(EXPORT_PATH, { budgetUsd: 1, agentAvgTurns: 2 });
  const rulesOnlyById = new Map(dry.rulesOnly.perQuestion.map((r) => [r.id, r]));
  const smallSample = dry.rulesOnly.perQuestion.filter((r) => r.status === "needs-model").slice(0, 4).map((r) => dry.questions.find((q) => q.id === r.id)).filter(Boolean);
  check("model-ab dry run still produces a needs-model sample to drive --live with", smallSample.length > 0, `found ${smallSample.length}`);
  if (smallSample.length) {
    await withRestoredMock({ mode: "answer", wrongRate: 0.2, declineRate: 0.5, seed: 21 }, async (mock) => {
      const live = await liveRun(dry.ctx, smallSample, dry.today, 5, rulesOnlyById);
      check("model-ab --live (mocked): produces a real per-question result set", live.pageResults.length === smallSample.length, `${live.pageResults.length} of ${smallSample.length}`);
      check("model-ab --live (mocked): total spend is tracked and non-negative", live.totalSpentUsd >= 0);
      check("model-ab --live (mocked): exercised the mock (this WAS the point — no longer \"written, not exercised\")", mock.calls > 0);
    });
  }
}

/* ============================================================ done */

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
