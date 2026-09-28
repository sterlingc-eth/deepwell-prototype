#!/usr/bin/env node
/**
 * LIVE TEST DAY — ROUND 23 (T1, live-credit test day prep), build item 2.
 *
 * ONE command for the day the owner loads real Anthropic credits and wants to know, safely and
 * cheaply, whether Donovan is actually ready: a total $ budget (hard stop, checked before every model
 * call is dispatched — never after), run in stages, each independently useful and independently
 * checkpointed so a crash (or Ctrl-C, or a laptop closing) loses at most the batch in flight:
 *
 *   (a) STRATIFIED SAMPLE of "needs-model" questions across every question set this repo has — the
 *       main exam (test-docs/scorecard/exam.json), all four field-phrasing generalization sets, and a
 *       needs-model sample of dialogue turns (test-docs/scorecard/generalization/dialogues-*.json,
 *       asked standalone — see "LIMITS" below) — classified as needing the model by the SAME mechanism
 *       scripts/offline-exam.mjs uses (a blocked-model rules-only pass; anything that still tried to
 *       call the model is "needs-model", never scored as wrong).
 *   (b) the CURRENT known-wrong ids — every question the rules-only pass gets wrong TODAY (computed
 *       fresh every run, never a hardcoded list — R23_CONTRACT.md: "KNOWN lists shrink-only", and a
 *       hardcoded id list could never shrink on its own as D1 fixes things). Re-asked with the model
 *       allowed, to answer one question empirically: does allowing the model change anything for a
 *       question the DETERMINISTIC router already answered (wrongly, confidently)? See "WHY STAGE (b)
 *       ALMOST ALWAYS COSTS ~$0" below — this is not a trick, it is how ask.js's pre-router works.
 *   (c) A/B on a SEPARATE stratified sample across every category and status (not just needs-model, so
 *       the rules-only side has a real accuracy number too, not a trivial 0%): rules-only ($0, blocked
 *       model) vs rules+model (real answers), same questions, so a category-by-category "does allowing
 *       the model help or hurt here" table falls out directly.
 *   (d) Haiku vs. Sonnet on a small slice, toggling the ALREADY-SUPPORTED `DONOVAN_RESEARCH_AGENT` env
 *       var around two calls to the SAME question (v2/Sonnet research agent vs. v1/Haiku-first loop
 *       with its own escalation heuristic) — no answer-logic change, an existing flag used twice.
 *
 * Every stage's real work goes through ONE small wrapper (`askAndGradeOne`, section 5) built from the
 * exact same functions scripts/offline-exam.mjs and api/_lib/scorecard/runner.js already use and this
 * round's own scripts/verify-*.mjs suite already exercises (runOracle, compareAnswer, gradeAnswer,
 * checkCitationPrecision, askViaHandler) — nothing here re-implements grading, oracle SQL, or citation
 * checking; it only orchestrates budget, concurrency, timeout and checkpointing around calls that were
 * already correct.
 *
 * OUTPUT: docs/reports/live-test-day-<date>.json (machine-readable) and the matching .md (for the
 * owner), plus a *.learning-candidates.json alongside them (see section 9) and a *.checkpoint.json
 * that IS the resume state (see section 4) — not a byproduct, the mechanism.
 *
 * WHY STAGE (b) ALMOST ALWAYS COSTS ~$0: a "wrong" (as opposed to "needs-model") question is one the
 * deterministic pre-router chain in ask.js (meta -> relations -> deterministic router -> fastPath ->
 * contactLookup -> docLookup -> contentCount -> money -> analytics) already answered with enough
 * confidence to return, before the agent or any model-based retrieval is ever reached — confidently,
 * and wrongly. Allowing the model does not change that: ask.js returns at the FIRST stage that answers,
 * so re-asking with the model allowed reaches the exact same deterministic stage and gets the exact
 * same (wrong) answer, without spending a token. Stage (b) exists to VERIFY this empirically for today's
 * actual known-wrong list (a mismatch — the model-allowed answer differs from the rules-only one — would
 * itself be a finding worth flagging) and to say so plainly in the report, rather than mislabeling a
 * rules-layer bug as something a live run could fix.
 *
 * LOCAL vs PRODUCTION mode — see docs/LIVE_TEST_DAY.md for the full, plain-language walkthrough:
 *   --mode=local (default)       an admin data export (test-docs/scorecard/golden export shape) loaded
 *                                 into an in-process PGlite tenant, graded against that tenant's own
 *                                 oracle — full accuracy/citation/cost reporting, resumable, the primary
 *                                 path this file is built and verified against.
 *   --mode=production --base-url=<https://...> --api-key-env=<ENV VAR NAME holding a dw_live_... key>
 *                                 an UNGRADED smoke test against the real deployed /api/ask (no oracle,
 *                                 no local DB — nothing here ever holds a production DB credential):
 *                                 asks a small sample of plain question texts over HTTPS with the given
 *                                 API key (see docs/LIVE_TEST_DAY.md for how to mint one with ONLY the
 *                                 "ask" scope), records latency/answered-vs-declined/citation-presence,
 *                                 and hands back the raw Q&A pairs for a human to eyeball — it cannot
 *                                 grade correctness without the tenant's own data, which this script is
 *                                 never given.
 *
 * LIMITS (say these plainly in the report, never overclaim):
 *   - A dialogue turn (stage a) is asked STANDALONE, not threaded through conversationContext the way
 *     scripts/run-dialogues.mjs (D1-owned) replays a real conversation — this exercises the model path
 *     realistically but does not test multi-turn follow-up resolution. run-dialogues.mjs is still the
 *     source of truth for dialogue accuracy; this only harvests needs-model QUESTION SHAPES from it.
 *   - Stage (d)'s "Haiku" side is v1's loop.js with DONOVAN_RESEARCH_AGENT=0, which still escalates
 *     itself to Sonnet for a question its own difficulty classifier calls hard — this is "the code's own
 *     existing default-off-ramp", not a guaranteed pure-Haiku answer; the report says which model each
 *     side actually used (from the response's own debug trace), never assumes it.
 *   - Per-tenant DAILY $ caps (api/_lib/planner/spend.js's ROUTE_BUCKETS, api/_lib/agent/escalation.js's
 *     Sonnet cap) are PER CALENDAR DAY, keyed to the tenant, and separate from this script's OWN --budget
 *     — see docs/LIVE_TEST_DAY.md's pre-flight checklist for why a $25 test day needs those raised first
 *     in PRODUCTION mode (local mode's synthetic PGlite tenant starts fresh every run, so it never hits
 *     them, but that also means local mode CANNOT catch a daily-cap misconfiguration — only a production
 *     run can, which is exactly why the pre-flight checklist calls it out by name).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  installPgHarness, createPGlite, setActiveDatabase, loadExportIntoNewTenant, runOfflineExam, loadFullExam,
} from "./offline-exam.mjs";
import { guessRoute, DEFAULT_AGENT_AVG_TURNS } from "./model-ab.mjs";
import { MODEL_PRICE_PER_MTOK } from "../api/_lib/usage.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, "..");
const GENERALIZATION_DIR = path.join(ROOT, "test-docs", "scorecard", "generalization");

/* ============================================================== 0. pricing assumptions, in ONE place
 *
 * "cost accounting matches Anthropic pricing for the models the code uses" (R23_CONTRACT.md, T1 item
 * 1) — every dollar figure in this file's report comes from api/_lib/usage.js's estimateModelCostUsd,
 * which prices from MODEL_PRICE_PER_MTOK below (env-overridable: AI_COST_HAIKU_INPUT_PER_MTOK etc — see
 * usage.js). Listed here, once, so a reader can check it against Anthropic's own published pricing
 * before trusting tomorrow's $ figures:
 *   claude-haiku-4-5 (ASK_MODEL/ANALYTICS_MODEL default): $1 / MTok input, $5 / MTok output
 *   claude-sonnet-4-5 (RESEARCH_MODEL/escalation default): $3 / MTok input, $15 / MTok output
 *   prompt-cache READ:  0.1x  the input rate (matches Anthropic's published ~90% cache discount)
 *   prompt-cache WRITE (creation): 1.25x the input rate (matches Anthropic's published 5-minute cache write premium)
 * These are the values api/_lib/usage.js ships as DEFAULTS today (2026-09) — Anthropic's price list can
 * change; if the owner's Anthropic console shows different numbers before tomorrow's run, set the
 * AI_COST_*_PER_MTOK env vars (see usage.js) rather than editing this file or that one.
 */
export function pricingAssumptions() {
  return {
    modelPricePerMtok: MODEL_PRICE_PER_MTOK,
    cacheReadMultiplier: 0.1,
    cacheCreationMultiplier: 1.25,
    source: "api/_lib/usage.js MODEL_PRICE_PER_MTOK (env-overridable) — verify against the Anthropic console before a real run",
  };
}

/* ============================================================== 1. CLI args (pure, exported for tests) */

export const DEFAULT_TOTAL_BUDGET_USD = 25;
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_PER_QUESTION_TIMEOUT_MS = 45_000;
export const DEFAULT_STAGE_A_SAMPLE_PER_CATEGORY = 3;
export const DEFAULT_STAGE_A_CAP = 60;
export const DEFAULT_STAGE_C_SAMPLE_PER_CATEGORY = 2;
export const DEFAULT_STAGE_C_CAP = 40;
export const DEFAULT_STAGE_D_SLICE = 6;
/** Default share of the total budget each stage may spend, before any stage-specific override flag.
 *  Stage (b) is a small fixed id list that (per this file's own header) almost always costs ~$0, so its
 *  "budget" is really just a safety cap, not a real allocation. */
export const DEFAULT_STAGE_WEIGHTS = Object.freeze({ a: 0.45, b: 0.05, c: 0.35, d: 0.15 });

export function parseArgs(argv) {
  const args = {
    exportPath: null, mode: "local", budgetUsd: DEFAULT_TOTAL_BUDGET_USD, out: null, resume: false,
    forceResume: false, concurrency: DEFAULT_CONCURRENCY, perQuestionTimeoutMs: DEFAULT_PER_QUESTION_TIMEOUT_MS,
    stageASamplePerCategory: DEFAULT_STAGE_A_SAMPLE_PER_CATEGORY, stageACap: DEFAULT_STAGE_A_CAP,
    stageCSamplePerCategory: DEFAULT_STAGE_C_SAMPLE_PER_CATEGORY, stageCCap: DEFAULT_STAGE_C_CAP,
    stageDSlice: DEFAULT_STAGE_D_SLICE, agentAvgTurns: DEFAULT_AGENT_AVG_TURNS, seed: null, dryRun: false,
    baseUrl: null, apiKeyEnv: null, stageWeights: { ...DEFAULT_STAGE_WEIGHTS },
  };
  const positional = [];
  for (const a of argv) {
    if (a === "--resume") args.resume = true;
    else if (a === "--force-resume") { args.resume = true; args.forceResume = true; }
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--budget=")) { const n = Number(a.slice(9)); if (Number.isFinite(n) && n > 0) args.budgetUsd = n; }
    else if (a.startsWith("--mode=")) { const m = a.slice(7); if (m === "local" || m === "production") args.mode = m; }
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (a.startsWith("--concurrency=")) { const n = Math.trunc(Number(a.slice(14))); if (Number.isFinite(n) && n >= 1) args.concurrency = n; }
    else if (a.startsWith("--per-question-timeout-ms=")) { const n = Math.trunc(Number(a.slice(26))); if (Number.isFinite(n) && n >= 1000) args.perQuestionTimeoutMs = n; }
    else if (a.startsWith("--stage-a-sample-per-category=")) { const n = Math.trunc(Number(a.slice(31))); if (Number.isFinite(n) && n >= 1) args.stageASamplePerCategory = n; }
    else if (a.startsWith("--stage-a-cap=")) { const n = Math.trunc(Number(a.slice(14))); if (Number.isFinite(n) && n >= 1) args.stageACap = n; }
    else if (a.startsWith("--stage-c-sample-per-category=")) { const n = Math.trunc(Number(a.slice(31))); if (Number.isFinite(n) && n >= 1) args.stageCSamplePerCategory = n; }
    else if (a.startsWith("--stage-c-cap=")) { const n = Math.trunc(Number(a.slice(14))); if (Number.isFinite(n) && n >= 1) args.stageCCap = n; }
    else if (a.startsWith("--stage-d-slice=")) { const n = Math.trunc(Number(a.slice(16))); if (Number.isFinite(n) && n >= 0) args.stageDSlice = n; }
    else if (a.startsWith("--agent-avg-turns=")) { const n = Number(a.slice(18)); if (Number.isFinite(n) && n >= 1) args.agentAvgTurns = n; }
    else if (a.startsWith("--seed=")) { const n = Number(a.slice(7)); if (Number.isFinite(n)) args.seed = n; }
    else if (a.startsWith("--base-url=")) args.baseUrl = a.slice(11);
    else if (a.startsWith("--api-key-env=")) args.apiKeyEnv = a.slice(14);
    else if (a.startsWith("--stage-weights=")) {
      // "a=0.4,b=0.1,c=0.3,d=0.2" — silently ignored if malformed (defaults stand), never a crash on a typo.
      const parsed = { ...DEFAULT_STAGE_WEIGHTS };
      let ok = true;
      for (const part of a.slice(16).split(",")) {
        const [k, v] = part.split("=");
        const n = Number(v);
        if (!["a", "b", "c", "d"].includes(k) || !Number.isFinite(n) || n < 0) { ok = false; break; }
        parsed[k] = n;
      }
      if (ok) args.stageWeights = parsed;
    }
    else if (!a.startsWith("--")) positional.push(a);
  }
  args.exportPath = positional[0] ?? null;
  return args;
}

/* ============================================================== 2. pure helpers: sampling, budgets */

/** Stratified sample: up to `perCategory` rows per `row.category`, in the ORIGINAL order within each
 *  category (never a random pick within-category — deterministic given the same input list, so a
 *  `--resume` recomputes the identical pool without needing to persist it), then globally capped at
 *  `cap` by round-robin ACROSS categories (never draining one category before touching the next) so a
 *  huge category (e.g. "connect", 152 rows) cannot crowd out every other category's slice. */
export function stratifiedSample(rows, { perCategory = 3, cap = 60 } = {}) {
  const byCategory = new Map();
  for (const r of rows) {
    const list = byCategory.get(r.category) ?? [];
    if (list.length < perCategory) list.push(r);
    byCategory.set(r.category, list);
  }
  const cats = [...byCategory.keys()].sort();
  const out = [];
  let more = true;
  for (let i = 0; more && out.length < cap; i++) {
    more = false;
    for (const cat of cats) {
      const list = byCategory.get(cat);
      if (i < list.length) { out.push(list[i]); more = true; if (out.length >= cap) break; }
    }
  }
  return out;
}

/** Pure: split a total $ budget into stage sub-budgets from `weights` (normalized — need not sum to 1). */
export function splitStageBudgets(totalUsd, weights = DEFAULT_STAGE_WEIGHTS) {
  const sum = Object.values(weights).reduce((s, w) => s + Math.max(0, Number(w) || 0), 0) || 1;
  const out = {};
  for (const [k, w] of Object.entries(weights)) out[k] = Math.round((totalUsd * Math.max(0, Number(w) || 0) / sum) * 1_000_000) / 1_000_000;
  return out;
}

/* ============================================================== 3. checkpoint (crash-safety, --resume)
 *
 * "results never lost on crash" + "resumable runs (checkpoint file, --resume)" (R23_CONTRACT.md, T1 item
 * 1): the checkpoint file is written SYNCHRONOUSLY, via a temp-file-then-rename (atomic on every OS this
 * runs on — a crash mid-write leaves the OLD file intact, never a half-written one), after EVERY single
 * question's result — never batched, never only at stage boundaries. A `--resume` re-reads it, checks its
 * `signature` against THIS run's own inputs (export file content hash + budget + sample knobs + seed),
 * and — only on a match — skips every question id already present in a stage's `results`, continuing the
 * pool exactly where it left off. A signature mismatch (a different export, a changed sample size, ...)
 * refuses to resume (loudly) unless `--force-resume`, which starts over but keeps the old file as
 * `<path>.bak` rather than silently overwriting it.
 */
export function checkpointPath(outBase) {
  return `${outBase}.checkpoint.json`;
}

export function computeSignature({ exportPath, budgetUsd, seed, stageASamplePerCategory, stageACap, stageCSamplePerCategory, stageCCap, stageDSlice, mode }) {
  let exportDigest = "no-export";
  try { exportDigest = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(exportPath))).digest("hex").slice(0, 16); } catch { /* production mode has no export file */ }
  return crypto.createHash("sha256").update(JSON.stringify({ exportDigest, budgetUsd, seed, stageASamplePerCategory, stageACap, stageCSamplePerCategory, stageCCap, stageDSlice, mode })).digest("hex").slice(0, 24);
}

function emptyStage() { return { results: [], doneIds: [], spentUsd: 0, stoppedReason: null }; }

export function newCheckpoint(signature, opts) {
  return {
    version: 1, signature, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    opts, spentUsd: 0, baseline: null,
    stages: { a: emptyStage(), b: emptyStage(), c: { rulesOnly: null, model: emptyStage() }, d: { pairs: [] } },
  };
}

/** Atomic write: write to a sibling temp file, then rename over the real path — a crash between these
 *  two steps leaves whichever file was there before, never a truncated/partial one. Synchronous on
 *  purpose (see file header): the caller awaits nothing else between "this question's result is known"
 *  and "it is durably on disk". */
export function saveCheckpointSync(cpPath, state) {
  state.updatedAt = new Date().toISOString();
  const tmp = `${cpPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, cpPath);
}

export function loadCheckpointSync(cpPath) {
  try { return JSON.parse(fs.readFileSync(cpPath, "utf8")); } catch { return null; }
}

/* ============================================================== 4. concurrency pool + budget + timeout
 *
 * A minimal worker pool (no dependency — R23_CONTRACT.md: no npm install). `limit` bounds how many
 * `worker(item)` calls run at once; the pool STOPS DISPATCHING (in-flight calls still finish) the
 * moment `budget.spent >= budget.cap` — checked before every dispatch, never only after, which is what
 * makes "budget hard stop works mid-run" true even under concurrency (a few calls already in flight can
 * still land after the cap is technically crossed — the same "in-flight settles, nothing new starts"
 * shape runScorecard's own budget check already uses).
 */
export async function runPool(items, limit, worker, budget) {
  let i = 0;
  let stoppedForBudget = false;
  async function lane() {
    while (i < items.length) {
      if (budget && budget.spent >= budget.cap) { stoppedForBudget = true; return; }
      const item = items[i++];
      await worker(item);
    }
  }
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => lane());
  await Promise.all(lanes);
  return { stoppedForBudget, remaining: items.length - Math.min(i, items.length) };
}

/* ============================================================== 5. one question, asked and graded
 *
 * Built from the SAME functions offline-exam.mjs / scorecard/runner.js already import (runOracle,
 * compareAnswer, gradeAnswer, checkCitationPrecision, askViaHandler) — this does not reimplement
 * grading; it orchestrates them with a per-question deadline and exposes the raw answer `kind` (honest
 * decline vs. answered) and a guessed `route`, neither of which runScorecard's own summarized
 * pageResults carry, and both of which this round's report needs.
 */
export async function askAndGradeOne({ ctx, handler, auth, question, today, timeoutMs, callModel }) {
  const { withTenant } = await import("../api/_lib/recordsStore.js");
  const { runOracle } = await import("../api/_lib/scorecard/oracle.js");
  const { summarizeExpected } = await import("../api/_lib/scorecard/compare.js");
  const { checkCitationPrecision } = await import("../api/_lib/scorecard/citationCheck.js");
  const { gradeAnswer } = await import("../api/_lib/scorecard/runner.js");
  const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");

  const base = { questionId: question.id, category: question.category, comparison: question.cmp ?? null, question: question.text };
  const deadlineAt = Date.now() + timeoutMs;
  const started = Date.now();

  let oracle = { ok: true, skip: false, expected: undefined, alts: undefined };
  if (question.cmp) {
    oracle = await runOracle(withTenant, ctx, question, { today });
    if (!oracle.ok) return { ...base, skipped: true, passed: false, error: oracle.error, costUsd: 0, latencyMs: 0 };
    if (oracle.skip) return { ...base, skipped: true, passed: false, error: oracle.why, costUsd: 0, latencyMs: 0 };
  }

  let asked;
  try {
    asked = await askViaHandler({ handler, auth, question: question.text, today, deadlineAt });
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") return { ...base, skipped: true, passed: false, error: "daily-model-budget-reached", costUsd: 0, latencyMs: Date.now() - started, dailyBudgetHit: true };
    return { ...base, skipped: true, passed: false, error: `ask threw: ${err?.name ?? err}`, costUsd: 0, latencyMs: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  const costUsd = asked.usage?.costUsd ?? 0;
  const models = [...new Set((asked.usage?.models ?? []).filter((m) => m && m !== "unattributed"))];
  const route = models.length ? models.join("+") : guessRoute(question.text);

  if (!asked.data) {
    // ROUND 14 (same rule scorecard/runner.js's own runOneQuestion follows): a question that could ONLY
    // fail because the AI provider is unavailable right now (out of credits, bad key, overloaded past
    // withBackoff's own retries) is not a Donovan mistake and must never be scored as one — it is
    // SKIPPED, exactly like the real scorecard does, never counted as wrong/confident-wrong.
    const { getProviderOutage } = await import("../api/_lib/claude.js");
    const outage = getProviderOutage();
    if (outage) {
      return { ...base, skipped: true, passed: false, error: "model-unavailable", providerUnavailable: outage.reason, costUsd, latencyMs, route, models };
    }
    return { ...base, passed: false, skipped: false, kind: "no-answer", error: asked.error ?? "no-response", costUsd, latencyMs, route, models, got: `error: ${asked.error ?? "no response"}`, cited: false };
  }
  const kind = asked.data.kind ?? null;
  const citedCount = Array.isArray(asked.data.sources) ? asked.data.sources.length : (Array.isArray(asked.data.records) ? asked.data.records.filter((r) => r.type === "document").length : 0);

  if (!question.cmp) {
    // No oracle/cmp (a dialogue turn harvested standalone, or any question asked with no ground truth to
    // grade against) — ungraded: report the shape (kind/cost/latency/citations) only, never a passed/wrong
    // verdict this file has no way to actually check.
    return { ...base, skipped: false, ungraded: true, kind, costUsd, latencyMs, route, models, cited: citedCount > 0, got: (asked.data.text ?? "").slice(0, 200) };
  }

  const graded = await gradeAnswer({ ctx, question, expected: oracle.expected, alts: oracle.alts, data: asked.data, callModel, deadlineAt });
  const totalCost = costUsd + (graded.costUsd ?? 0);
  if (graded.skipped) {
    return { ...base, skipped: true, passed: false, error: graded.why, costUsd: totalCost, latencyMs, route, models, providerUnavailable: Boolean(graded.providerUnavailable) };
  }
  let citationPrecision;
  if (graded.cited) {
    const cp = await checkCitationPrecision(withTenant, ctx, asked.data);
    if (typeof cp.precision === "number") citationPrecision = cp.precision;
  }
  return {
    ...base, skipped: false, passed: Boolean(graded.passed), score: graded.score, kind,
    valueOk: graded.valueOk ?? Boolean(graded.passed), cited: Boolean(graded.cited), citationRequired: Boolean(graded.citationRequired), citationPrecision,
    expected: graded.expectedSummary ?? summarizeExpected({ ...question, expected: oracle.expected }), got: graded.got,
    costUsd: totalCost, latencyMs, route, models,
  };
}

/* ============================================================== 6. baseline: rules-only pass, $0
 *
 * ONE pass over the full exam (exam.json + every generalization file loadFullExam already merges — see
 * that function's own doc comment) with the model physically blocked (offline-exam.mjs's own, already-
 * tested installModelBlock), plus a lightweight needs-model classification of every dialogue TURN (no
 * oracle, no grading — dialogue turns aren't exam-shaped; only "did this reach the model" matters for
 * stage (a)'s sampling pool). This is the SAME $0 measurement `npm run verify:offline-exam`/the R23
 * contract's own baseline command produces — run fresh here (not reused from a stale prior run) so a
 * live-test-day report's "current known-wrong" list can never drift from what the code does RIGHT NOW.
 */
/**
 * Runs `fn(modelCounter)` with the shared Anthropic prototype's `create` FORCED to offline-exam.mjs's
 * own blocking implementation, then restores whatever `create` was installed before this call (the real
 * SDK, or — in a mocked run under scripts/verify-live-test-day.mjs — the mock) — so a rules-only sub-pass
 * (the baseline, and stage (c)'s rules-only half) can share ONE process with the model-ALLOWED stages
 * without permanently clobbering the live client the other stages need. Both offline-exam.mjs's
 * installModelBlock and scripts/lib/mockAnthropicClient.mjs patch the exact same shared prototype method
 * with no restore of their own (by design — a whole-script run only ever wants ONE), so that save/restore
 * has to happen here, at the one place in this file that calls both "model allowed" and "model blocked"
 * code in the same process.
 */
async function withModelBlocked(fn) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const probe = new Anthropic({ apiKey: "x" });
  const proto = Object.getPrototypeOf(probe.messages);
  const savedCreate = proto.create;
  const { installModelBlock } = await import("./offline-exam.mjs");
  const counter = await installModelBlock();
  try {
    return await fn(counter);
  } finally {
    proto.create = savedCreate;
  }
}

async function loadDialogueTurnPool() {
  let files = [];
  try { files = fs.readdirSync(GENERALIZATION_DIR).filter((f) => /^dialogues.*\.json$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(GENERALIZATION_DIR, f), "utf8")); } catch { continue; }
    const cat = parsed?.category || f.replace(/\.json$/, "");
    for (const d of parsed?.dialogues ?? []) {
      for (const [i, turn] of (d.turns ?? []).entries()) {
        if (typeof turn?.text === "string" && turn.text.trim()) out.push({ id: `${d.id}-t${i + 1}`, category: cat, text: turn.text });
      }
    }
  }
  return out;
}

export async function runBaseline({ ctx, exportTenantKey, today }) {
  const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../api/ask.js");
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
  const exam = await loadFullExam(exportTenantKey ?? null);
  const dialogueTurns = await loadDialogueTurnPool();

  return withModelBlocked(async (modelCounter) => {
    const rulesOnly = await runOfflineExam({ ctx, questions: exam.questions, today, modelCounter });
    const dialogueNeedsModel = [];
    for (const t of dialogueTurns) {
      modelCounter.n = 0;
      try { await askViaHandler({ handler: askHandler, auth, question: t.text, today }); } catch { continue; }
      if (modelCounter.n > 0) dialogueNeedsModel.push(t);
    }
    return { examVersion: exam.version, rulesOnly, dialogueTurnsTotal: dialogueTurns.length, dialogueNeedsModel };
  });
}

/* ============================================================== 7. stage pools, from the baseline */

export function buildStageAPool(baseline, { perCategory, cap }) {
  const examNeedsModel = baseline.rulesOnly.perQuestion
    .filter((r) => r.status === "needs-model")
    .map((r) => ({ id: r.id, category: r.category, text: r.question, cmp: undefined })); // cmp intentionally re-attached by caller from the real question object
  const pool = [...examNeedsModel, ...baseline.dialogueNeedsModel.map((t) => ({ ...t, fromDialogue: true }))];
  return stratifiedSample(pool, { perCategory, cap });
}

export function buildStageBList(baseline) {
  return baseline.rulesOnly.perQuestion.filter((r) => r.status === "wrong").map((r) => ({ id: r.id, category: r.category, text: r.question }));
}

export function buildStageCPool(baseline, { perCategory, cap }) {
  const rows = baseline.rulesOnly.perQuestion.map((r) => ({ id: r.id, category: r.category, text: r.question, baselineStatus: r.status }));
  return stratifiedSample(rows, { perCategory, cap });
}

/* ============================================================== 8. report: accuracy, confident-wrong,
 * honest-decline, citations, latency, $/question — the metrics R23_CONTRACT.md's T1 item asks for.
 */
function percentileOf(values, p) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const rank = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[rank];
}

function summarizeResults(results, { rulesOnlyById } = {}) {
  const graded = results.filter((r) => !r.skipped && !r.ungraded);
  const passed = graded.filter((r) => r.passed).length;
  const wrong = graded.filter((r) => !r.passed);
  const honestDeclineCandidates = results.filter((r) => !r.skipped);
  const honestDeclines = honestDeclineCandidates.filter((r) => r.kind && r.kind !== "answer");
  const confidentWrong = rulesOnlyById
    ? wrong.filter((r) => {
        const before = rulesOnlyById.get(r.questionId);
        const wasAnswerable = before?.status === "correct" || before?.status === "wrong";
        return !wasAnswerable;
      })
    : [];
  // CONFIDENT-WRONG (above) is model-ab.mjs's own definition (isNewConfidentWrong, shared so the two
  // reports never mean two different things) — it does NOT distinguish a FABRICATED wrong answer from an
  // honest decline that happens to be wrong (the oracle expected a real value; Donovan correctly said it
  // couldn't answer, which still grades as "wrong" against a non-empty expected value — see a total
  // provider-outage scenario, where the safe, correct behavior is exactly this: decline, don't invent).
  // confidentFabrication is the STRICTER, more actionable subset — kind === "answer", i.e. Donovan stated
  // something as fact and it was wrong — which is what should actually alarm a reader of this report.
  const confidentFabrication = confidentWrong.filter((r) => r.kind === "answer");
  const citedRequired = graded.filter((r) => r.citationRequired);
  const citedOk = citedRequired.filter((r) => r.cited);
  const precisions = graded.map((r) => r.citationPrecision).filter((n) => typeof n === "number");
  const latencies = results.map((r) => r.latencyMs).filter((n) => Number.isFinite(n));
  const costs = results.map((r) => r.costUsd).filter((n) => Number.isFinite(n));
  return {
    total: results.length, graded: graded.length, skipped: results.length - graded.length - results.filter((r) => r.ungraded).length,
    correct: passed, wrong: wrong.length,
    accuracy: graded.length ? Math.round((passed / graded.length) * 1000) / 1000 : null,
    confidentWrongCount: confidentWrong.length,
    confidentWrongIds: confidentWrong.map((r) => r.questionId),
    confidentFabricationCount: confidentFabrication.length,
    confidentFabricationIds: confidentFabrication.map((r) => r.questionId),
    honestDeclineRate: honestDeclineCandidates.length ? Math.round((honestDeclines.length / honestDeclineCandidates.length) * 1000) / 1000 : null,
    citationPresenceRate: citedRequired.length ? Math.round((citedOk.length / citedRequired.length) * 1000) / 1000 : null,
    citationSupportRateAvg: precisions.length ? Math.round((precisions.reduce((a, b) => a + b, 0) / precisions.length) * 1000) / 1000 : null,
    latencyMsP50: percentileOf(latencies, 50), latencyMsP95: percentileOf(latencies, 95),
    totalCostUsd: Math.round(costs.reduce((a, b) => a + b, 0) * 1_000_000) / 1_000_000,
    costUsdPerQuestion: results.length ? Math.round((costs.reduce((a, b) => a + b, 0) / results.length) * 1_000_000) / 1_000_000 : 0,
  };
}

function byCategoryAndModel(results) {
  const byCategory = {};
  const byModel = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
    for (const m of r.models?.length ? r.models : [r.route ?? "unknown"]) {
      if (!byModel[m]) byModel[m] = [];
      byModel[m].push(r);
    }
  }
  const summarize = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => [k, summarizeResults(rs)]));
  return { byCategory: summarize(byCategory), byModel: summarize(byModel) };
}

/** The full JSON report from a finished (or partially finished — budget/crash cutoffs are legitimate,
 *  reportable states, not errors) checkpoint state. Pure — no I/O, so scripts/verify-live-test-day.mjs
 *  can assert its shape directly against a synthetic checkpoint. */
export function buildReport(state) {
  const rulesOnlyById = new Map((state.baseline?.rulesOnly?.perQuestion ?? []).map((r) => [r.id, r]));
  const aResults = state.stages.a.results;
  const bResults = state.stages.b.results;
  const cModelResults = state.stages.c.model.results;
  const cRulesOnly = state.stages.c.rulesOnly;

  const wrongAnswers = [...aResults, ...bResults, ...cModelResults]
    .filter((r) => !r.skipped && !r.ungraded && !r.passed)
    .map((r) => ({ id: r.questionId, category: r.category, question: r.question, expected: r.expected, got: r.got, route: r.route, costUsd: r.costUsd, kind: r.kind ?? null, fabricated: r.kind === "answer" }));

  const bMatchesBaseline = bResults.filter((r) => !r.skipped).filter((r) => {
    const before = rulesOnlyById.get(r.questionId);
    return before && String(r.got ?? "").trim() === String(before.got ?? "").trim();
  }).length;

  return {
    generatedAt: new Date().toISOString(),
    pricingAssumptions: pricingAssumptions(),
    baseline: state.baseline ? {
      examVersion: state.baseline.examVersion,
      overall: state.baseline.rulesOnly.overall,
      dialogueTurnsClassified: state.baseline.dialogueTurnsTotal,
      dialogueNeedsModelCount: state.baseline.dialogueNeedsModel.length,
    } : null,
    stages: {
      a_stratified_needs_model: { ...summarizeResults(aResults, { rulesOnlyById }), ...byCategoryAndModel(aResults), stoppedReason: state.stages.a.stoppedReason },
      b_known_wrong_reasked: {
        ...summarizeResults(bResults, { rulesOnlyById }),
        identicalToRulesOnlyCount: bMatchesBaseline,
        note: "A question here is 'wrong' at the DETERMINISTIC layer (ask.js answers before the model is ever reached) — allowing the model essentially never changes the answer. identicalToRulesOnlyCount == graded is the expected, healthy result; any mismatch is worth a look.",
        stoppedReason: state.stages.b.stoppedReason,
      },
      c_ab_rules_vs_model: {
        rulesOnly: cRulesOnly ? { overall: cRulesOnly.overall, byCategory: cRulesOnly.byCategory } : null,
        model: { ...summarizeResults(cModelResults, { rulesOnlyById }), ...byCategoryAndModel(cModelResults), stoppedReason: state.stages.c.model.stoppedReason },
      },
      d_haiku_vs_sonnet: {
        pairs: state.stages.d.pairs,
        note: "Toggles the existing DONOVAN_RESEARCH_AGENT env var around two calls to the same question — see this file's own header LIMITS note on what 'Haiku side' actually guarantees.",
      },
    },
    wrongAnswers,
    spentUsd: state.spentUsd,
    budgetUsd: state.opts.budgetUsd,
  };
}

export function renderMarkdown(report) {
  const pct = (n) => (n == null ? "—" : `${Math.round(n * 1000) / 10}%`);
  const lines = [
    "# Live test day report", "",
    `Generated ${report.generatedAt} · budget $${report.budgetUsd} · spent $${Math.round(report.spentUsd * 100) / 100}`, "",
    "## Pricing assumptions", "",
    "```json", JSON.stringify(report.pricingAssumptions, null, 1), "```", "",
  ];
  if (report.baseline) {
    lines.push(
      "## Baseline (rules-only, $0)", "",
      `Exam version \`${report.baseline.examVersion}\` — ${report.baseline.overall.total} questions, ${report.baseline.overall.answeredWithoutModel} answered without the model, ${report.baseline.overall.correct} correct, **${report.baseline.overall.wrong} wrong**.`,
      `${report.baseline.dialogueNeedsModelCount} of ${report.baseline.dialogueTurnsClassified} dialogue turns need the model.`, "",
    );
  }
  const stageSection = (title, s) => [
    `### ${title}`, "",
    `${s.total} asked, ${s.graded} graded, ${s.skipped} skipped. Accuracy **${pct(s.accuracy)}** (${s.correct}/${s.graded}).`,
    `**CONFIDENT-WRONG: ${s.confidentWrongCount}**${s.confidentWrongCount ? ` (${s.confidentWrongIds.join(", ")})` : ""} — a question the rules-only pass could not answer at all, now answered WRONG once the model was allowed (includes an honest decline that happens to be wrong against a non-empty expected value — see below for the stricter figure).`,
    `**of those, FABRICATED (stated as fact, wrong): ${s.confidentFabricationCount}**${s.confidentFabricationCount ? ` (${s.confidentFabricationIds.join(", ")})` : ""} — this is the number to actually worry about.`,
    `Honest-decline rate: ${pct(s.honestDeclineRate)}. Citation presence: ${pct(s.citationPresenceRate)}. Citation support (avg precision): ${pct(s.citationSupportRateAvg)}.`,
    `Latency p50/p95: ${s.latencyMsP50 ?? "—"}ms / ${s.latencyMsP95 ?? "—"}ms. $/question: $${s.costUsdPerQuestion}. Total: $${s.totalCostUsd}.`,
    s.stoppedReason ? `**Stopped early: ${s.stoppedReason}.**` : "", "",
  ].filter((l) => l !== "");
  lines.push("## (a) Stratified needs-model sample", "", ...stageSection("Result", report.stages.a_stratified_needs_model));
  lines.push("## (b) Current known-wrong ids, re-asked with the model allowed", "");
  lines.push(report.stages.b_known_wrong_reasked.note, "", ...stageSection("Result", report.stages.b_known_wrong_reasked), `${report.stages.b_known_wrong_reasked.identicalToRulesOnlyCount} of ${report.stages.b_known_wrong_reasked.graded} came back byte-identical to the rules-only answer.`, "");
  lines.push("## (c) A/B — rules-only vs. rules+model", "");
  if (report.stages.c_ab_rules_vs_model.rulesOnly) {
    lines.push(`Rules-only (same sample, $0): ${report.stages.c_ab_rules_vs_model.rulesOnly.overall.correct}/${report.stages.c_ab_rules_vs_model.rulesOnly.overall.total} correct, ${report.stages.c_ab_rules_vs_model.rulesOnly.overall.wrong} wrong.`, "");
  }
  lines.push(...stageSection("Rules+model", report.stages.c_ab_rules_vs_model.model));
  lines.push("## (d) Haiku vs. Sonnet (small slice)", "", report.stages.d_haiku_vs_sonnet.note, "");
  if (report.stages.d_haiku_vs_sonnet.pairs.length) {
    lines.push("| question | haiku model used | haiku passed | sonnet model used | sonnet passed |", "|---|---|---|---|---|");
    for (const p of report.stages.d_haiku_vs_sonnet.pairs) lines.push(`| ${p.category} | ${p.haiku?.models?.join(",") ?? "—"} | ${p.haiku?.passed ?? "—"} | ${p.sonnet?.models?.join(",") ?? "—"} | ${p.sonnet?.passed ?? "—"} |`);
    lines.push("");
  }
  lines.push("## Every wrong answer", "");
  if (!report.wrongAnswers.length) lines.push("None.");
  else {
    lines.push("| id | category | question | expected | got | route | cost |", "|---|---|---|---|---|---|---:|");
    for (const w of report.wrongAnswers) lines.push(`| ${w.id} | ${w.category} | ${String(w.question).replace(/\|/g, "\\|").slice(0, 80)} | ${String(w.expected).replace(/\|/g, "\\|").slice(0, 60)} | ${String(w.got).replace(/\|/g, "\\|").slice(0, 60)} | ${w.route ?? "—"} | $${w.costUsd ?? 0} |`);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

/* ============================================================== 9. learning candidates
 *
 * "so model-answered wins can later be distilled into free deterministic rules" — every CORRECT,
 * model-answered question (stage a's sample, by construction: rules-only could NOT answer it, and the
 * model then got it right) is a candidate for D1 to look at when writing the next deterministic rule.
 * Shape: exportMisses' own {text, suggestedRoute} item (api/_lib/missStore.js) PLUS enough context to
 * act on it — this is a REVIEW FILE for a human, never written into ask_misses (that table is for
 * things Donovan got WRONG, and these are wins; writing a win into the misses table would be the wrong
 * kind of pollution of the real learning loop).
 */
export function buildLearningCandidates(aResults) {
  return aResults
    .filter((r) => !r.skipped && !r.ungraded && r.passed)
    .map((r) => ({
      text: r.question, suggestedRoute: r.route ?? "agent", category: r.category, questionId: r.questionId,
      answeredVia: r.models?.join("+") || r.route, costUsd: r.costUsd, citationCount: r.cited ? 1 : 0,
    }));
}

/* ============================================================== 10. orchestrator (local mode) */

const DEFAULT_OUT_BASE = () => path.join(ROOT, "docs", "reports", `live-test-day-${new Date().toISOString().slice(0, 10)}`);

/**
 * @param {object} opts  parseArgs() shape, plus TEST-ONLY `__testCrashAfterResults` (a total completed-
 *   result count across all stages at which this function throws immediately, BEFORE dispatching more
 *   work — simulates a killed process for scripts/verify-live-test-day.mjs's crash+resume assertion;
 *   never set by the CLI, never documented to the owner).
 */
export async function runLiveTestDay(opts) {
  const outBase = opts.out ? path.resolve(opts.out) : DEFAULT_OUT_BASE();
  const cpPath = checkpointPath(outBase);
  const signature = computeSignature(opts);

  let state = opts.resume ? loadCheckpointSync(cpPath) : null;
  if (state && state.signature !== signature && !opts.forceResume) {
    throw new Error(`live-test-day: checkpoint at ${cpPath} was started with different options (signature mismatch) — pass --force-resume to discard it and start over, or point --out elsewhere.`);
  }
  if (state && state.signature !== signature && opts.forceResume) {
    try { fs.copyFileSync(cpPath, `${cpPath}.bak`); } catch { /* best effort */ }
    state = null;
  }
  if (!state) state = newCheckpoint(signature, opts);

  let completedCount = [...state.stages.a.results, ...state.stages.b.results, ...state.stages.c.model.results].length;
  const maybeCrash = () => {
    if (opts.__testCrashAfterResults != null && completedCount >= opts.__testCrashAfterResults) {
      throw new Error(`live-test-day: TEST-ONLY simulated crash after ${completedCount} results`);
    }
  };

  await installPgHarness();
  const lite = await createPGlite();
  await setActiveDatabase(lite);
  const exportData = JSON.parse(fs.readFileSync(path.resolve(opts.exportPath), "utf8"));
  const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: exportData.tenantKey ? `live-test-day:${exportData.tenantKey}` : "live-test-day", tenantName: "Live Test Day" });
  const today = process.env.EXAM_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXAM_TODAY) ? process.env.EXAM_TODAY : new Date().toISOString().slice(0, 10);
  const { default: askHandler } = await import("../api/ask.js");
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null };

  if (!state.baseline) {
    // TEST-ONLY: scripts/verify-live-test-day.mjs computes the ($0, model-blocked) baseline ONCE and
    // reuses it across many small scenario runs — the baseline is pure classification (ids/categories/
    // status/text), never a live DB handle, so reusing one computed against a freshly-loaded, byte-
    // identical export is exactly as valid as recomputing it, just far faster for a verify suite that
    // exercises a dozen scenarios in one process. Never set by the CLI.
    state.baseline = opts.__testPrebuiltBaseline ?? await runBaseline({ ctx, exportTenantKey: exportData.tenantKey ?? null, today });
    saveCheckpointSync(cpPath, state);
  }

  const stageBudgets = splitStageBudgets(opts.budgetUsd, opts.stageWeights);
  const examById = new Map((await loadFullExam(exportData.tenantKey ?? null)).questions.map((q) => [q.id, q]));

  // ------------------------------------------------------------ stage (a)
  const poolA = buildStageAPool(state.baseline, { perCategory: opts.stageASamplePerCategory, cap: opts.stageACap })
    .map((row) => examById.get(row.id) ?? { id: row.id, category: row.category, text: row.text, cmp: undefined, fromDialogue: true });
  const doneA = new Set(state.stages.a.results.map((r) => r.questionId));
  const budgetA = { spent: state.stages.a.spentUsd, cap: stageBudgets.a };
  const resA = await runPool(poolA.filter((q) => !doneA.has(q.id)), opts.concurrency, async (q) => {
    maybeCrash();
    const r = await askAndGradeOne({ ctx, handler: askHandler, auth, question: q, today, timeoutMs: opts.perQuestionTimeoutMs });
    state.stages.a.results.push(r); state.stages.a.spentUsd += r.costUsd; state.spentUsd += r.costUsd; budgetA.spent += r.costUsd; completedCount++;
    saveCheckpointSync(cpPath, state);
  }, budgetA);
  if (resA.stoppedForBudget) state.stages.a.stoppedReason = "budget"; else if (!state.stages.a.stoppedReason) state.stages.a.stoppedReason = "complete";
  saveCheckpointSync(cpPath, state);

  // ------------------------------------------------------------ stage (b)
  const listB = buildStageBList(state.baseline).map((row) => ({ ...examById.get(row.id), id: row.id, category: row.category, text: row.text }));
  const doneB = new Set(state.stages.b.results.map((r) => r.questionId));
  const budgetB = { spent: state.stages.b.spentUsd, cap: stageBudgets.b };
  const resB = await runPool(listB.filter((q) => !doneB.has(q.id)), opts.concurrency, async (q) => {
    maybeCrash();
    const r = await askAndGradeOne({ ctx, handler: askHandler, auth, question: q, today, timeoutMs: opts.perQuestionTimeoutMs });
    state.stages.b.results.push(r); state.stages.b.spentUsd += r.costUsd; state.spentUsd += r.costUsd; budgetB.spent += r.costUsd; completedCount++;
    saveCheckpointSync(cpPath, state);
  }, budgetB);
  if (resB.stoppedForBudget) state.stages.b.stoppedReason = "budget"; else if (!state.stages.b.stoppedReason) state.stages.b.stoppedReason = "complete";
  saveCheckpointSync(cpPath, state);

  // ------------------------------------------------------------ stage (c)
  const poolCRows = buildStageCPool(state.baseline, { perCategory: opts.stageCSamplePerCategory, cap: opts.stageCCap });
  const poolC = poolCRows.map((row) => examById.get(row.id)).filter(Boolean);
  if (!state.stages.c.rulesOnly) {
    state.stages.c.rulesOnly = await withModelBlocked((counter) => runOfflineExam({ ctx, questions: poolC, today, modelCounter: counter }));
    saveCheckpointSync(cpPath, state);
  }
  const doneC = new Set(state.stages.c.model.results.map((r) => r.questionId));
  const budgetC = { spent: state.stages.c.model.spentUsd, cap: stageBudgets.c };
  const resC = await runPool(poolC.filter((q) => !doneC.has(q.id)), opts.concurrency, async (q) => {
    maybeCrash();
    const r = await askAndGradeOne({ ctx, handler: askHandler, auth, question: q, today, timeoutMs: opts.perQuestionTimeoutMs });
    state.stages.c.model.results.push(r); state.stages.c.model.spentUsd += r.costUsd; state.spentUsd += r.costUsd; budgetC.spent += r.costUsd; completedCount++;
    saveCheckpointSync(cpPath, state);
  }, budgetC);
  if (resC.stoppedForBudget) state.stages.c.model.stoppedReason = "budget"; else if (!state.stages.c.model.stoppedReason) state.stages.c.model.stoppedReason = "complete";
  saveCheckpointSync(cpPath, state);

  // ------------------------------------------------------------ stage (d) — sequential, env-toggled
  const sliceD = [...poolA, ...poolC].filter((q, i, arr) => arr.findIndex((x) => x.id === q.id) === i).slice(0, opts.stageDSlice);
  const doneD = new Set(state.stages.d.pairs.map((p) => p.id));
  let spentD = state.stages.d.pairs.reduce((s, p) => s + (p.haiku?.costUsd ?? 0) + (p.sonnet?.costUsd ?? 0), 0);
  for (const q of sliceD) {
    if (doneD.has(q.id) || spentD >= stageBudgets.d) continue;
    maybeCrash();
    const savedFlag = process.env.DONOVAN_RESEARCH_AGENT;
    process.env.DONOVAN_RESEARCH_AGENT = "0"; // v1 loop.js — Haiku-first, self-escalates on hard questions
    const haiku = await askAndGradeOne({ ctx, handler: askHandler, auth, question: q, today, timeoutMs: opts.perQuestionTimeoutMs });
    if (savedFlag === undefined) delete process.env.DONOVAN_RESEARCH_AGENT; else process.env.DONOVAN_RESEARCH_AGENT = savedFlag;
    const sonnet = await askAndGradeOne({ ctx, handler: askHandler, auth, question: q, today, timeoutMs: opts.perQuestionTimeoutMs });
    state.stages.d.pairs.push({ id: q.id, category: q.category, question: q.text, haiku, sonnet });
    spentD += (haiku.costUsd ?? 0) + (sonnet.costUsd ?? 0);
    state.spentUsd += (haiku.costUsd ?? 0) + (sonnet.costUsd ?? 0);
    completedCount += 2;
    saveCheckpointSync(cpPath, state);
  }

  const report = buildReport(state);
  const learningCandidates = buildLearningCandidates(state.stages.a.results);
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outBase}.md`, renderMarkdown(report));
  fs.writeFileSync(`${outBase}.learning-candidates.json`, JSON.stringify(learningCandidates, null, 2));
  return { outBase, cpPath, report, learningCandidates, state };
}

/* ============================================================== 11. production smoke test (ungraded) */

export async function runProductionSmokeTest(opts) {
  if (!opts.baseUrl) throw new Error("live-test-day --mode=production requires --base-url=https://...");
  const apiKey = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : null;
  if (!apiKey) throw new Error(`live-test-day --mode=production requires --api-key-env=<ENV VAR NAME> naming an env var that holds a dw_live_... key (see docs/LIVE_TEST_DAY.md) — ${opts.apiKeyEnv ?? "(none given)"} is not set.`);

  const outBase = opts.out ? path.resolve(opts.out) : `${DEFAULT_OUT_BASE()}-production-smoke`;
  const cpPath = checkpointPath(outBase);
  const signature = computeSignature(opts);
  let state = opts.resume ? loadCheckpointSync(cpPath) : null;
  if (!state || (state.signature !== signature && !opts.forceResume)) state = { version: 1, signature, results: [], spentCount: 0 };

  // No local export/oracle in production mode — question texts come straight from the SAME generalization
  // files stage (a) samples from (field-phrasing-1..4, category names only, no tenant data needed to pick
  // which TEXTS to ask), capped by --stage-a-cap purely as a call-count budget (production's /api/ask
  // response never reports $ spent to the caller — see this file's own header).
  let files = [];
  try { files = fs.readdirSync(GENERALIZATION_DIR).filter((f) => /^field-phrasing/.test(f)); } catch { /* none found */ }
  const pool = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(GENERALIZATION_DIR, f), "utf8"));
      for (const q of parsed?.questions ?? []) pool.push({ id: q.id, category: q.category, text: q.text });
    } catch { /* skip unreadable file */ }
  }
  const sample = stratifiedSample(pool, { perCategory: opts.stageASamplePerCategory, cap: opts.stageACap });
  const done = new Set(state.results.map((r) => r.id));

  await runPool(sample.filter((q) => !done.has(q.id)), opts.concurrency, async (q) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.perQuestionTimeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/api/ask`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ question: q.text }),
      });
      const body = await res.json().catch(() => null);
      state.results.push({
        id: q.id, category: q.category, question: q.text, httpStatus: res.status, latencyMs: Date.now() - started,
        kind: body?.data?.kind ?? null, text: body?.data?.text ?? body?.error ?? null,
        citationCount: Array.isArray(body?.data?.sources) ? body.data.sources.length : 0,
      });
    } catch (err) {
      state.results.push({ id: q.id, category: q.category, question: q.text, httpStatus: null, latencyMs: Date.now() - started, error: err?.name === "AbortError" ? "timeout" : String(err?.message ?? err) });
    } finally {
      clearTimeout(timer);
      saveCheckpointSync(cpPath, state);
    }
  }, null);

  const honestDeclines = state.results.filter((r) => r.kind && r.kind !== "answer").length;
  const latencies = state.results.map((r) => r.latencyMs).filter((n) => Number.isFinite(n));
  const report = {
    generatedAt: new Date().toISOString(), mode: "production-smoke-test (UNGRADED — no oracle, eyeball the answers)",
    baseUrl: opts.baseUrl, total: state.results.length,
    answered: state.results.filter((r) => r.kind === "answer").length, honestDeclines,
    errors: state.results.filter((r) => r.error).length,
    latencyMsP50: percentileOf(latencies, 50), latencyMsP95: percentileOf(latencies, 95),
    results: state.results,
  };
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(report, null, 2));
  return { outBase, cpPath, report };
}

/* ============================================================== 12. CLI */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "production") {
    const { outBase, report } = await runProductionSmokeTest(opts);
    console.log(`live-test-day (production smoke test): ${report.total} asked, ${report.answered} answered, ${report.honestDeclines} honest declines, ${report.errors} errors -> ${outBase}.json`);
    return;
  }
  if (!opts.exportPath) {
    console.error("Usage: node scripts/live-test-day.mjs <export.json> [--budget=25] [--resume] [--dry-run] ...");
    process.exit(2);
  }
  if (opts.dryRun) {
    const { dryRunWithExport } = await import("./model-ab.mjs");
    const dry = await dryRunWithExport(opts.exportPath, { budgetUsd: opts.budgetUsd, agentAvgTurns: opts.agentAvgTurns });
    console.log(`live-test-day --dry-run: ${dry.rulesOnly.overall.total} questions, ${dry.needsModelCount} need the model, estimated cost at $${opts.budgetUsd} budget: $${dry.plan.totalEstimatedUsd} (${dry.plan.priced.length} priced, ${dry.plan.deferred.length} would exceed budget). This is model-ab.mjs's own estimator — the actual run below samples a subset (see --stage-a-cap etc.), so it will cost LESS than this full-exam estimate, not more.`);
    return;
  }
  const { outBase, report } = await runLiveTestDay(opts);
  console.log(`live-test-day: spent $${Math.round(report.spentUsd * 100) / 100} of $${report.budgetUsd} -> ${outBase}.json, ${outBase}.md`);
  console.log(`  (a) needs-model sample: ${report.stages.a_stratified_needs_model.correct}/${report.stages.a_stratified_needs_model.graded} correct, CONFIDENT-WRONG ${report.stages.a_stratified_needs_model.confidentWrongCount}`);
  console.log(`  (b) known-wrong re-asked: ${report.stages.b_known_wrong_reasked.identicalToRulesOnlyCount}/${report.stages.b_known_wrong_reasked.graded} identical to rules-only`);
  console.log(`  (c) A/B: rules-only ${report.stages.c_ab_rules_vs_model.rulesOnly?.overall.correct ?? "—"}/${report.stages.c_ab_rules_vs_model.rulesOnly?.overall.total ?? "—"} vs rules+model ${report.stages.c_ab_rules_vs_model.model.correct}/${report.stages.c_ab_rules_vs_model.model.graded}`);
  console.log(`  (d) Haiku vs Sonnet pairs: ${report.stages.d_haiku_vs_sonnet.pairs.length}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("live-test-day: fatal:", err?.stack ?? err);
    console.error("If a run gets here mid-way, its checkpoint file is intact — re-run with --resume to continue from where it stopped.");
    process.exit(1);
  });
}
