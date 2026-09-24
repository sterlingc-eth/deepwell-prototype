/**
 * Donovan Scorecard - the operator actions behind api/review.js's `scorecardRun` / `scorecardStatus`, and the
 * nightly cron step (runScorecardSweepStep). Kept out of review.js/cron-sweep.js so those files only carry a
 * small dispatch hunk.
 *
 * Everything runs against the CALLING operator's own tenant (the founder shop): a scorecard only ever asks
 * questions of, and compares against, that tenant's own data. The spend ceiling is env-controlled
 * (DONOVAN_SCORECARD_BUDGET_USD, default $5); a caller can only ask for LESS.
 */
import { getPool } from "../recordsStore.js";
import askHandler from "../../ask.js";
import { loadExam } from "../scorecard/exam.js";
import { runScorecard, scorecardBudgetUsd, nightlySlice, NIGHTLY_SLICE, DEFAULT_PAGE_SIZE } from "../scorecard/runner.js";
import { listRuns, getRun } from "../scorecard/store.js";

const todayUtc = () => new Date().toISOString().slice(0, 10);
const TASK_KEY = "donovan-scorecard";

/** Pure: the question list for a scope. */
export function selectQuestions(exam, { scope = "full", today, category, ids } = {}) {
  const all = exam.questions;
  if (scope === "slice") return nightlySlice(all, today ?? todayUtc(), NIGHTLY_SLICE);
  if (scope === "category" && typeof category === "string") return all.filter((q) => q.category === category);
  if (scope === "ids" && Array.isArray(ids)) { const want = new Set(ids); return all.filter((q) => want.has(q.id)); }
  return all;
}

/** One page of a scorecard run. Payload: {scope?, runId?, offset?, pageSize?, today?, category?, retryOfRunId?, budgetUsd?}. */
export async function scorecardRunAction(ctx, auth, payload = {}) {
  const exam = loadExam();
  if (!exam.questions.length) return { error: "exam-missing", message: "The scorecard exam file is not deployed (test-docs/scorecard/exam.json)." };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.today ?? "")) ? payload.today : todayUtc();
  let scope = payload.scope === "slice" || payload.scope === "category" || payload.scope === "ids" ? payload.scope : "full";
  let ids;
  // "Re-run failures": the failing questions of an earlier run.
  if (typeof payload.retryOfRunId === "string" && payload.retryOfRunId) {
    const prior = await getRun(ctx, payload.retryOfRunId);
    ids = (prior?.results ?? []).filter((r) => !r.passed).map((r) => r.questionId);
    scope = "ids";
  }
  const questions = selectQuestions(exam, { scope, today, category: payload.category, ids });
  const asked = Number(payload.budgetUsd);
  const budgetUsd = Number.isFinite(asked) && asked > 0 ? Math.min(asked, scorecardBudgetUsd()) : scorecardBudgetUsd();
  const out = await runScorecard({
    ctx, questions, budgetUsd, handler: askHandler,
    auth: { tenantId: auth.tenantId, orgId: auth.orgId ?? auth.tenantId, userId: auth.userId ?? null },
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    offset: Number(payload.offset) || 0,
    pageSize: Number(payload.pageSize) || DEFAULT_PAGE_SIZE,
    source: ids ? "retry" : "operator", examVersion: exam.version, today,
  });
  return {
    runId: out.runId, backend: out.backend, nextOffset: out.nextOffset, done: out.done, stopped: out.stopped, today, scope,
    total: questions.length, spentUsd: out.spentUsd, run: out.run,
    page: out.pageResults.map((r) => ({ questionId: r.questionId, passed: r.passed, skipped: Boolean(r.skipped) })),
  };
}

/** Latest run + trend + failing list + exam shape. Payload: {runId?}. */
export async function scorecardStatusAction(ctx, payload = {}) {
  const exam = loadExam();
  const { runs, backend } = await listRuns(ctx, { limit: 8 });
  const complete = runs.filter((r) => r.status !== "running" || r.answered > 0);
  const wanted = typeof payload.runId === "string" && payload.runId ? payload.runId : complete[0]?.id;
  const detail = wanted ? await getRun(ctx, wanted) : null;
  const run = detail?.run ?? null;
  // Trend: compare with the newest OTHER run that answered at least half as many questions (a partial slice is not comparable).
  const previous = runs.find((r) => r.id !== run?.id && r.score != null && run && r.answered >= Math.min(20, (run.answered || 0) / 2) && Date.parse(r.startedAt) < Date.parse(run.startedAt)) ?? null;
  const categories = {};
  for (const q of exam.questions) categories[q.category] = (categories[q.category] ?? 0) + 1;
  return {
    backend: detail?.backend ?? backend,
    exam: { version: exam.version, questions: exam.questions.length, categories },
    budgetUsd: scorecardBudgetUsd(),
    run, previous: previous ? { id: previous.id, score: previous.score, startedAt: previous.startedAt, answered: previous.answered } : null,
    runs: runs.map((r) => ({ id: r.id, source: r.source, status: r.status, score: r.score, answered: r.answered, startedAt: r.startedAt, costUsd: r.costUsd })),
    failing: (detail?.results ?? []).filter((r) => !r.passed).slice(0, 80).map((r) => ({
      questionId: r.questionId, category: r.category, question: r.question, expected: r.expected, got: r.got, models: r.models,
      ...(r.detail?.retry ? { retry: r.detail.retry } : {}), ...(r.error ? { error: r.error } : {}),
    })),
  };
}

/**
 * Nightly cron step: a rotating ~40-question slice for the founder/operator tenant, inside the time and money
 * left (the sweep's shared deadline; DONOVAN_SCORECARD_BUDGET_USD). Once per UTC day (claim_platform_daily_task),
 * skipped when there is no founder tenant configured. Never throws.
 */
export async function runScorecardSweepStep({ deadlineAt, handler = askHandler, env = process.env, claim = true } = {}) {
  try {
    const founder = env.DEEPWELL_FOUNDER_TENANT_ID;
    if (!founder) return { skipped: "no-founder-tenant" };
    if (env.DONOVAN_SCORECARD_NIGHTLY === "0") return { skipped: "disabled" };
    const exam = loadExam();
    if (!exam.questions.length) return { skipped: "exam-missing" };
    if ((deadlineAt ?? Infinity) - Date.now() < 20_000) return { skipped: "no-time" };
    const today = todayUtc();
    if (claim) {
      try {
        const { rows } = await getPool().query("SELECT claim_platform_daily_task($1,$2,$3) AS claimed", [founder, TASK_KEY, today]);
        if (!rows[0]?.claimed) return { skipped: "already-ran-today" };
      } catch (err) {
        console.warn("scorecard: claim_platform_daily_task failed:", err?.message);
        return { skipped: "guard-unavailable" };
      }
    }
    const ctx = { tenantKey: founder, tenantName: founder };
    const questions = nightlySlice(exam.questions, today, NIGHTLY_SLICE);
    let offset = 0;
    let runId;
    let last = null;
    // Pages until the slice is done or the deadline is near; each page is small and independent.
    for (let guard = 0; guard < 12; guard++) {
      last = await runScorecard({ ctx, questions, handler, runId, offset, pageSize: 6, deadlineAt, source: "nightly", examVersion: exam.version, today });
      runId = last.runId;
      if (last.done || last.nextOffset == null || last.stopped) break;
      offset = last.nextOffset;
    }
    return { runId, answered: last?.run?.answered ?? 0, passed: last?.run?.passed ?? 0, score: last?.run?.score ?? null, slice: questions.length, stopped: last?.stopped ?? null, spentUsd: last?.spentUsd ?? 0 };
  } catch (err) {
    console.error("scorecard sweep step failed (non-fatal):", err?.message);
    return { error: err?.message };
  }
}
