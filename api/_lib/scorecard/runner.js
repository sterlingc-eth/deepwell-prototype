/**
 * Donovan Scorecard - the runner.
 *
 *   runScorecard({ctx, questions, budgetUsd, ...})   run (a page of) the golden exam against ONE tenant's own data
 *
 * For each question: run its oracle (oracle.js, independent SQL over the base tables) to get the expected
 * answer for the CURRENT data, ask Donovan through the real /api/ask handler (askCall.js: the same pipeline
 * production uses, never counted against a customer's monthly allowance, model spend still recorded), and
 * compare (compare.js; free-text rubric questions get ONE cheap Haiku grade, grader.js). Failures are retried
 * once on the escalation model when the first answer came from the agent (the retry's outcome is stored in the
 * result's `detail.retry`; the SCORE is the first, production-faithful attempt) and are fed into the learning
 * loop as misses (outcome 'scorecard-fail') so replay/recipes act on them.
 *
 * Paging (60 s function limit): a run is filled `pageSize` (default 6) questions per invocation. The caller
 * passes back {runId, offset}; the return value carries `nextOffset` (null when the exam is complete) and a
 * `done` flag. A page also stops early when the request's deadline is close, or when the run's cost reaches
 * the budget (DONOVAN_SCORECARD_BUDGET_USD, default $5) - then the run is marked 'stopped' with a reason and
 * the score covers what was answered. Cost is the true per-question spend from the usage meter.
 *
 * No question text is logged (counts only).
 */
import { withTenant } from "../recordsStore.js";
import { recordAskMiss, MISS_OUTCOMES } from "../missStore.js";
import { getActiveOverlayForTenant } from "../learning/overlay.js";
import { missKey } from "../learning/replay.js";
import { escalationModel } from "../agent/escalation.js";
import { runOracle } from "./oracle.js";
import { compareAnswer, answerView, summarizeAnswer, summarizeExpected, scoreResults, withCitation } from "./compare.js";
import { gradeRubric } from "./grader.js";
import { askViaHandler } from "./askCall.js";
import { createRun, saveResults, getRun } from "./store.js";

export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_PAGE_SIZE = 6;
// TEAM F (speed, 2026-09-24): was 25_000. An agent answer that escalates to Sonnet can itself take
// ~30s (see handoffs on agent latency); starting one with 25s left on a 60s function risked the
// page's OWN deadline cutting it off mid-question (worse than not starting it at all - a half-run
// question with no result). Raised to 35_000 so a question is only started when it can plausibly
// finish, including its own retry-on-escalation-model pass.
export const MIN_QUESTION_MS = 35_000;
export const MAX_PAGE_SIZE = 12;
// TEAM F (speed): questions within a page are independent (own oracle, own ask, own grade) - run this
// many at once instead of one at a time, so a page answers roughly twice as many questions inside the
// same 60s budget. Kept small (not e.g. 6) because each question can itself run a multi-turn agent
// loop with its own DB connections (see agent/loop.js's TOOL_CONCURRENCY and recordsStore.js's tiny
// connection pool) - 2 keeps total concurrent DB usage bounded even when every question in the batch
// happens to need the agent.
export const QUESTION_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.DONOVAN_SCORECARD_CONCURRENCY) || 2));

export const scorecardBudgetUsd = (env = process.env) => {
  const n = Number(env?.DONOVAN_SCORECARD_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The first-attempt answer is worth a retry on the escalation model only if the agent is in the loop. */
function worthRetry(first, sonnet) {
  const model = first.debug?.model;
  if (model && model !== sonnet) return true;
  return first.data?.kind === "no-answer";
}

function labelModels(usage, debug) {
  const set = new Set((usage?.models ?? []).map((m) => (m === "unattributed" ? process.env.ASK_MODEL || "claude-haiku-4-5" : m)));
  if (debug?.model) set.add(debug.model);
  for (const m of debug?.models ?? []) set.add(m);
  return [...set];
}

/**
 * Grade one asked question. Returns {passed, score, got, expectedSummary, why, costUsd, skipped?}.
 * (Exported for tests.)
 */
export async function gradeAnswer({ ctx, question, expected, data, alts, callModel, deadlineAt }) {
  if (question.cmp !== "rubric") {
    const r = compareAnswer({ cmp: question.cmp, expected, question: question.text, citationRequired: question.citationRequired, alts, tolerance: question.tolerance, anyNumber: question.anyNumber }, data);
    return { ...r, costUsd: 0 };
  }
  const view = answerView(data);
  const cite = question.citeWhat ? ` The answer must cite ${question.citeWhat}.` : "";
  const g = await gradeRubric({
    ctxArg: ctx, question: question.text, rubric: `${question.rubric}${cite}`, reference: expected,
    answerText: `${view.text}\n${view.facts.map((f) => `${f.label}: ${f.value}`).join("\n")}\n[citations attached to the answer: ${view.citations}]`, callModel, deadlineAt,
  });
  if (g.error) return { passed: false, score: 0, skipped: true, got: summarizeAnswer(view), expectedSummary: summarizeExpected(question), why: `grader unavailable (${g.error})`, costUsd: g.costUsd };
  // A rubric answer is also held to the citation rule: the model grades the content, the citation check is deterministic.
  const r = withCitation({ passed: g.passed, score: g.passed ? 1 : 0, got: summarizeAnswer(view), why: g.reason }, { ...question, cmp: "rubric", expected }, view);
  return { ...r, costUsd: g.costUsd };
}

/**
 * @param {object} p
 * @param {{tenantKey: string, tenantName?: string}} p.ctx  the tenant whose own data is examined
 * @param {object[]} p.questions  exam questions (see test-docs/scorecard/exam.json)
 * @param {number} [p.budgetUsd]  hard spend ceiling for the WHOLE run (default env DONOVAN_SCORECARD_BUDGET_USD, else $5)
 * @param {{tenantId: string, orgId?: string, userId?: string}} [p.auth]  defaults from ctx
 * @param {Function} p.handler  the /api/ask handler (injected: api/review.js / cron pass ask.js's default export)
 * @param {string} [p.runId]  continue an existing run
 * @param {number} [p.offset]  index into `questions` to resume from
 * @param {number} [p.pageSize]
 * @param {number} [p.deadlineAt]  epoch ms; the page stops before starting a question that cannot finish
 * @param {string} [p.source]  'operator' | 'nightly' | 'retry'
 * @param {string} [p.examVersion]
 * @param {string} [p.today]
 * @param {boolean} [p.retryFailures]  retry an agent-answered failure once on the escalation model (default true)
 * @param {boolean} [p.feedMisses]  record failures as misses for the learning loop (default true)
 * @param {Function} [p.callModel]  injectable rubric-grader model (tests)
 * @returns {Promise<{runId: string, backend: string, offset: number, nextOffset: number|null, done: boolean, stopped: string|null,
 *   pageResults: object[], run: object|null, spentUsd: number}>}
 */
export async function runScorecard({
  ctx, questions, budgetUsd, auth, handler, runId, offset = 0, pageSize = DEFAULT_PAGE_SIZE, deadlineAt,
  source = "operator", examVersion = null, today = todayUtc(), retryFailures = true, feedMisses = true, callModel, env = process.env,
}) {
  const budget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : scorecardBudgetUsd(env);
  const list = Array.isArray(questions) ? questions : [];
  const deadline = deadlineAt ?? Date.now() + 45_000;
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE));
  const sonnet = escalationModel(env);
  const askAuth = auth ?? { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };

  let backend;
  let priorCost = 0;
  if (runId) {
    const existing = await getRun(ctx, runId);
    if (existing) { priorCost = Number(existing.run?.costUsd) || 0; backend = existing.backend; }
    else runId = undefined; // unknown run id (e.g. a lossy fallback lost it): start a fresh one
  }
  if (!runId) {
    const created = await createRun(ctx, { source, examVersion, totalQuestions: list.length });
    runId = created.id;
    backend = created.backend;
    priorCost = 0;
  }

  const pageResults = [];
  let spent = priorCost;
  let stopped = null;
  let i = Math.max(0, Math.trunc(offset) || 0);
  const end = Math.min(list.length, i + size);
  // TEAM H (2026-09-24): tenant-merged overlay — a no-op fallback to getActiveOverlay()'s own
  // result until autopilot has promoted something for this tenant.
  const overlay = feedMisses ? await getActiveOverlayForTenant(ctx) : null;

  // One question end-to-end (oracle -> ask -> grade -> optional retry). Pulled out of the loop body
  // so a page can run QUESTION_CONCURRENCY of these at once (TEAM F, speed) instead of one at a time -
  // each question's own DB/model work is otherwise pure wall-clock waiting. `spentBudgetHint` is the
  // spend already committed when the BATCH started (not live-updated across concurrent siblings) -
  // it only gates the optional escalation retry, so a slightly stale number just means that gate is
  // approximate under concurrency, never that the run's real spend accounting drifts (each result
  // still carries its own true costUsd, summed into `spent` after the batch settles).
  async function runOneQuestion(q, spentBudgetHint) {
    const base = { questionId: q.id, category: q.category, comparison: q.cmp, question: q.text };
    const oracle = await runOracle(withTenant, ctx, q, { today });
    if (!oracle.ok) return { push: { ...base, skipped: true, passed: false, error: oracle.error, costUsd: 0 }, cost: 0 };
    if (oracle.skip) return { push: { ...base, skipped: true, passed: false, error: oracle.why, costUsd: 0 }, cost: 0 };

    let asked;
    try {
      asked = await askViaHandler({ handler, auth: askAuth, question: q.text, today, deadlineAt: deadline });
    } catch (err) {
      if (err?.name === "ModelBudgetExceededError") return { push: null, cost: 0, stopReason: "model-budget" };
      throw err;
    }
    if (asked.status === 429) return { push: null, cost: 0, stopReason: "model-budget" };
    let cost = asked.usage.costUsd;
    let models = labelModels(asked.usage, asked.debug);
    if (!asked.data) {
      return {
        push: { ...base, passed: false, score: 0, expected: summarizeExpected({ ...q, expected: oracle.expected }), got: `error: ${asked.error ?? "no response"}`, error: asked.error ?? "no-response", models, costUsd: cost, latencyMs: asked.latencyMs, detail: {} },
        cost,
      };
    }

    let graded = await gradeAnswer({ ctx, question: q, expected: oracle.expected, alts: oracle.alts, data: asked.data, callModel, deadlineAt: deadline });
    cost += graded.costUsd ?? 0;
    if (graded.skipped) return { push: { ...base, skipped: true, passed: false, error: graded.why, costUsd: cost }, cost };

    const detail = {};
    if (asked.debug?.escalation) detail.escalation = asked.debug.escalation;
    if (typeof graded.precision === "number") { detail.precision = graded.precision; detail.recall = graded.recall; }
    if (graded.why) detail.why = graded.why;
    if (graded.usedAlt) detail.usedAlt = graded.usedAlt;
    detail.valueOk = graded.valueOk ?? Boolean(graded.passed);
    detail.cited = Boolean(graded.cited);
    detail.citationRequired = Boolean(graded.citationRequired);
    if (q.persona) detail.persona = q.persona;

    let stopReason = null;
    // A failure the agent produced (or declined) is retried ONCE on the escalation model; the score stays the
    // first attempt so the number keeps meaning "what a customer got".
    if (!graded.passed && graded.valueOk !== true && retryFailures && worthRetry(asked, sonnet) && spentBudgetHint + cost < budget && deadline - Date.now() >= MIN_QUESTION_MS) {
      try {
        const again = await askViaHandler({ handler, auth: askAuth, question: q.text, today, escalate: true, deadlineAt: deadline });
        cost += again.usage.costUsd;
        models = [...new Set([...models, ...labelModels(again.usage, again.debug)])];
        if (again.data) {
          const g2 = await gradeAnswer({ ctx, question: q, expected: oracle.expected, alts: oracle.alts, data: again.data, callModel, deadlineAt: deadline });
          cost += g2.costUsd ?? 0;
          detail.retry = { model: again.debug?.model ?? sonnet, passed: Boolean(g2.passed), got: g2.got };
        }
      } catch (err) {
        if (err?.name === "ModelBudgetExceededError") stopReason = "model-budget";
      }
    }

    return {
      push: {
        ...base, passed: Boolean(graded.passed), score: graded.score, expected: graded.expectedSummary, got: graded.got,
        valueOk: graded.valueOk ?? Boolean(graded.passed), cited: Boolean(graded.cited), citationRequired: Boolean(graded.citationRequired),
        detail, models, costUsd: cost, latencyMs: asked.latencyMs, error: null,
      },
      cost, stopReason, miss: !graded.passed,
    };
  }

  outer: while (i < end) {
    if (spent >= budget) { stopped = "budget"; break; }
    if (deadline - Date.now() < MIN_QUESTION_MS) { stopped = "deadline"; break; }
    const batch = list.slice(i, Math.min(end, i + QUESTION_CONCURRENCY));
    const spentAtBatchStart = spent;
    const settled = await Promise.all(batch.map((q) => runOneQuestion(q, spentAtBatchStart)));
    for (const r of settled) {
      i++;
      if (r.push) pageResults.push(r.push);
      spent += r.cost;
      if (r.push && !r.push.skipped && r.miss && feedMisses) {
        // Existing learning loop: a miss row is what replay, recipes and the weekly review act on.
        recordAskMiss(ctx, { question: r.push.question, questionNormalized: missKey(r.push.question, overlay), outcome: MISS_OUTCOMES.SCORECARD_FAIL }).catch(() => {});
      }
      if (r.stopReason) { stopped = r.stopReason; break outer; }
    }
  }

  const finished = !stopped && i >= list.length;
  const finish = finished ? { status: "complete" } : stopped ? { status: "stopped", stopReason: stopped } : null;
  const saved = await saveResults(ctx, runId, pageResults, { source, examVersion, totalQuestions: list.length, finish });

  console.log(JSON.stringify({ route: "scorecard", run: runId.slice(0, 8), backend: saved.backend, asked: pageResults.length, offset, next: finished ? null : i, stopped, spent_usd: Math.round(spent * 10000) / 10000 }));

  return {
    runId, backend: saved.backend ?? backend, offset, nextOffset: finished || stopped === "budget" || stopped === "model-budget" ? null : i,
    done: finished || stopped === "budget" || stopped === "model-budget", stopped, pageResults, run: saved.run ?? null, spentUsd: Math.round(spent * 10000) / 10000,
  };
}

/* ------------------------------------------------------------------ the nightly rotating slice */

export const NIGHTLY_SLICE = 40;

/** Pure: the questions for `dateStr`'s nightly slice - a contiguous window that advances by SLICE each day and wraps. */
export function nightlySlice(questions, dateStr, size = NIGHTLY_SLICE) {
  const n = questions.length;
  if (!n) return [];
  const day = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86_400_000);
  const start = ((Number.isFinite(day) ? day : 0) * size) % n;
  const out = [];
  for (let k = 0; k < Math.min(size, n); k++) out.push(questions[(start + k) % n]);
  return out;
}

export { scoreResults };
