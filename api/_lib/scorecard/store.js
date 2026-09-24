/**
 * Donovan Scorecard - persistence, tolerant of migration 30 not being applied.
 *
 * Preferred: donovan_scorecard_runs / donovan_scorecard_results (M3-config/30-donovan-scorecard.sql, tenant
 * scoped, FORCE RLS). When those tables are missing (the owner has not pasted the migration yet) every
 * function falls back to audit_log, the table every deploy already has: one 'donovan.scorecard_run' row per
 * run (summary + the failing list, rewritten as the run pages forward) and one 'donovan.scorecard_page' row
 * per page of results. Audit rows are append-only, so the fallback reads the newest run row per run id and
 * the union of its page rows. If even that fails, an in-process Map keeps the current process's runs so the
 * operator at least sees the run they just started (lossy across serverless instances, and said so by
 * `backend`).
 *
 * `backend` on every return value says which store answered: 'tables' | 'audit' | 'memory'.
 * Nothing here logs question text. `expected`/`got` hold short summaries of the operator's own shop data.
 */
import { randomUUID } from "node:crypto";
import { withTenant } from "../recordsStore.js";
import { scoreResults } from "./compare.js";

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const RUN_ACTION = "donovan.scorecard_run";
const PAGE_ACTION = "donovan.scorecard_page";
const MAX_FAILING_IN_AUDIT = 60;
const RETRY_TABLES_AFTER_MS = 5 * 60 * 1000;

let tablesMissingSince = 0;
const memory = new Map(); // runId -> {run, results[]}

export function resetScorecardStoreForTests() { tablesMissingSince = 0; memory.clear(); }
const tablesUsable = () => !tablesMissingSince || Date.now() - tablesMissingSince > RETRY_TABLES_AFTER_MS;
function noteTablesMissing(err) {
  if (/donovan_scorecard|does not exist|42P01/i.test(String(err?.message ?? err) + String(err?.code ?? ""))) {
    tablesMissingSince = Date.now();
    return true;
  }
  return false;
}

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const num = (v, d = 4) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);

function rowToRun(r) {
  return {
    id: r.id, source: r.source, examVersion: r.exam_version ?? null, status: r.status, stopReason: r.stop_reason ?? null,
    totalQuestions: Number(r.total_questions) || 0, answered: Number(r.answered) || 0, passed: Number(r.passed) || 0,
    score: r.score == null ? null : Number(r.score), byCategory: r.by_category ?? {}, costUsd: Number(r.cost_usd) || 0,
    models: Array.isArray(r.models) ? r.models : [], startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  };
}
function rowToResult(r) {
  return {
    questionId: r.question_id, category: r.category, comparison: r.comparison, question: r.question, passed: Boolean(r.passed),
    score: r.score == null ? null : Number(r.score), expected: r.expected ?? null, got: r.got ?? null, detail: r.detail ?? {},
    models: Array.isArray(r.models) ? r.models : [], costUsd: Number(r.cost_usd) || 0, latencyMs: r.latency_ms ?? null, error: r.error ?? null,
    // citation scoring travels inside `detail` (no migration): results stored before it have no valueOk, so pass = value verdict
    valueOk: r.detail?.valueOk === undefined ? Boolean(r.passed) : Boolean(r.detail.valueOk),
    cited: Boolean(r.detail?.cited), citationRequired: Boolean(r.detail?.citationRequired),
  };
}

/* ------------------------------------------------------------------ create */

/** @returns {Promise<{id: string, backend: string}>} */
export async function createRun(ctxArg, { source = "operator", examVersion = null, totalQuestions = 0 } = {}) {
  const id = randomUUID();
  if (tablesUsable()) {
    try {
      await withTenant(ctxArg, (db) => db.raw(
        `INSERT INTO donovan_scorecard_runs (id, tenant_id, source, exam_version, total_questions)
         VALUES ($1, (current_setting('app.tenant_id', true))::uuid, $2, $3, $4)`,
        [id, source, clip(examVersion, 40), totalQuestions]));
      return { id, backend: "tables" };
    } catch (err) {
      if (!noteTablesMissing(err)) console.warn("scorecard-store: table insert failed, using audit_log:", err?.name ?? "error");
    }
  }
  const run = { id, source, examVersion, status: "running", stopReason: null, totalQuestions, answered: 0, passed: 0, score: null, byCategory: {}, costUsd: 0, models: [], startedAt: new Date().toISOString(), finishedAt: null };
  try {
    await withTenant(ctxArg, (db) => db.logAction({ action: RUN_ACTION, resource_type: "scorecard", resource_id: id, changes: { run, failing: [] } }));
    return { id, backend: "audit" };
  } catch {
    memory.set(id, { run, results: [] });
    return { id, backend: "memory" };
  }
}

/* ------------------------------------------------------------------ append + update */

/**
 * Persist one page of results and refresh the run's aggregates from ALL its results so far.
 * @param {object[]} results  {questionId, category, comparison, question, passed, score, expected, got, detail, models, costUsd, latencyMs, error, skipped?}
 * @returns {Promise<{run: object, backend: string}>}
 */
export async function saveResults(ctxArg, runId, results, { source = "operator", examVersion = null, totalQuestions = 0, finish = null } = {}) {
  const graded = results.filter((r) => !r.skipped);
  if (tablesUsable()) {
    try {
      return await withTenant(ctxArg, async (db) => {
        for (const r of graded) {
          await db.raw(
            `INSERT INTO donovan_scorecard_results (tenant_id, run_id, question_id, category, comparison, question, passed, score, expected, got, detail, models, cost_usd, latency_ms, error)
             VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
             ON CONFLICT (run_id, question_id) DO UPDATE SET passed = EXCLUDED.passed, score = EXCLUDED.score, expected = EXCLUDED.expected,
               got = EXCLUDED.got, detail = EXCLUDED.detail, models = EXCLUDED.models, cost_usd = EXCLUDED.cost_usd, latency_ms = EXCLUDED.latency_ms, error = EXCLUDED.error`,
            [runId, r.questionId, r.category, r.comparison, clip(r.question, 300), Boolean(r.passed), num(r.score), clip(r.expected, 300), clip(r.got, 300),
              JSON.stringify(r.detail ?? {}), JSON.stringify(r.models ?? []), Math.min(9999, num(r.costUsd) ?? 0), r.latencyMs ?? null, clip(r.error, 200)]);
        }
        const { rows } = await db.raw(
          `SELECT category, passed, detail, cost_usd, models FROM donovan_scorecard_results WHERE ${TENANT_SQL} AND run_id = $1`, [runId]);
        const agg = scoreResults(rows.map((x) => ({ category: x.category, passed: x.passed, valueOk: x.detail?.valueOk, cited: x.detail?.cited, citationRequired: x.detail?.citationRequired })));
        const cost = rows.reduce((n, x) => n + (Number(x.cost_usd) || 0), 0);
        const models = [...new Set(rows.flatMap((x) => (Array.isArray(x.models) ? x.models : [])))];
        const upd = await db.raw(
          `UPDATE donovan_scorecard_runs SET answered = $2, passed = $3, score = $4, by_category = $5::jsonb, cost_usd = $6, models = $7::jsonb,
                  status = COALESCE($8, status), stop_reason = COALESCE($9, stop_reason), finished_at = CASE WHEN $8 IS NULL THEN finished_at ELSE NOW() END
            WHERE id = $1 AND ${TENANT_SQL} RETURNING *`,
          [runId, agg.total, agg.passed, agg.score, JSON.stringify(agg.byCategory), Math.min(9999, cost), JSON.stringify(models), finish?.status ?? null, clip(finish?.stopReason, 80)]);
        return { run: upd.rows[0] ? rowToRun(upd.rows[0]) : null, backend: "tables" };
      });
    } catch (err) {
      if (!noteTablesMissing(err)) console.warn("scorecard-store: table write failed, using audit_log:", err?.name ?? "error");
    }
  }
  return saveResultsAudit(ctxArg, runId, results, { source, examVersion, totalQuestions, finish });
}

function compactResult(r) {
  return { questionId: r.questionId, category: r.category, comparison: r.comparison, question: clip(r.question, 300), passed: Boolean(r.passed), valueOk: r.valueOk === undefined ? Boolean(r.passed) : Boolean(r.valueOk), cited: Boolean(r.cited), citationRequired: Boolean(r.citationRequired), score: num(r.score), expected: clip(r.expected, 200), got: clip(r.got, 200), models: r.models ?? [], costUsd: num(r.costUsd) ?? 0, latencyMs: r.latencyMs ?? null, error: clip(r.error, 120) };
}

async function readAuditRun(db, runId) {
  const runRows = (await db.raw(
    `SELECT changes, created_at FROM audit_log WHERE ${TENANT_SQL} AND action = $1 AND resource_id = $2 ORDER BY created_at DESC LIMIT 1`, [RUN_ACTION, runId])).rows;
  const pageRows = (await db.raw(
    `SELECT changes FROM audit_log WHERE ${TENANT_SQL} AND action = $1 AND resource_id = $2 ORDER BY created_at ASC LIMIT 600`, [PAGE_ACTION, runId])).rows;
  const byId = new Map();
  for (const p of pageRows) for (const r of p.changes?.results ?? []) byId.set(r.questionId, r);
  return { last: runRows[0]?.changes?.run ?? null, results: [...byId.values()] };
}

async function saveResultsAudit(ctxArg, runId, results, { source, examVersion, totalQuestions, finish }) {
  const compact = results.filter((r) => !r.skipped).map(compactResult);
  try {
    return await withTenant(ctxArg, async (db) => {
      const prev = await readAuditRun(db, runId);
      if (compact.length) {
        await db.logAction({ action: PAGE_ACTION, resource_type: "scorecard", resource_id: runId, changes: { results: compact } });
      }
      const all = new Map(prev.results.map((r) => [r.questionId, r]));
      for (const r of compact) all.set(r.questionId, r);
      const merged = [...all.values()];
      const agg = scoreResults(merged);
      const base = prev.last ?? { id: runId, source, examVersion, startedAt: new Date().toISOString(), totalQuestions };
      const run = {
        ...base, totalQuestions: totalQuestions || base.totalQuestions, answered: agg.total, passed: agg.passed, score: agg.score, byCategory: agg.byCategory,
        costUsd: Math.round(merged.reduce((n, r) => n + (r.costUsd || 0), 0) * 10000) / 10000,
        models: [...new Set(merged.flatMap((r) => r.models ?? []))],
        status: finish?.status ?? base.status ?? "running", stopReason: finish?.stopReason ?? base.stopReason ?? null,
        finishedAt: finish ? new Date().toISOString() : base.finishedAt ?? null,
      };
      const failing = merged.filter((r) => !r.passed).slice(0, MAX_FAILING_IN_AUDIT);
      await db.logAction({ action: RUN_ACTION, resource_type: "scorecard", resource_id: runId, changes: { run, failing } });
      return { run, backend: "audit" };
    });
  } catch {
    const mem = memory.get(runId) ?? { run: { id: runId, source, examVersion, status: "running", totalQuestions, startedAt: new Date().toISOString() }, results: [] };
    const byId = new Map(mem.results.map((r) => [r.questionId, r]));
    for (const r of results.filter((x) => !x.skipped)) byId.set(r.questionId, compactResult(r));
    mem.results = [...byId.values()];
    const agg = scoreResults(mem.results);
    mem.run = { ...mem.run, answered: agg.total, passed: agg.passed, score: agg.score, byCategory: agg.byCategory, costUsd: mem.results.reduce((n, r) => n + (r.costUsd || 0), 0), models: [...new Set(mem.results.flatMap((r) => r.models ?? []))], ...(finish ? { status: finish.status, stopReason: finish.stopReason ?? null, finishedAt: new Date().toISOString() } : {}) };
    memory.set(runId, mem);
    return { run: mem.run, backend: "memory" };
  }
}

/* ------------------------------------------------------------------ read */

/** Newest-first run summaries (no per-question rows). */
export async function listRuns(ctxArg, { limit = 10 } = {}) {
  const n = Math.max(1, Math.min(30, limit));
  if (tablesUsable()) {
    try {
      const rows = await withTenant(ctxArg, async (db) => (await db.raw(
        `SELECT * FROM donovan_scorecard_runs WHERE ${TENANT_SQL} ORDER BY started_at DESC LIMIT ${n}`, [])).rows);
      return { runs: rows.map(rowToRun), backend: "tables" };
    } catch (err) {
      if (!noteTablesMissing(err)) console.warn("scorecard-store: table read failed:", err?.name ?? "error");
    }
  }
  try {
    const rows = await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT DISTINCT ON (resource_id) resource_id, changes, created_at FROM audit_log
        WHERE ${TENANT_SQL} AND action = $1 ORDER BY resource_id, created_at DESC LIMIT 100`, [RUN_ACTION])).rows);
    const runs = rows.map((r) => r.changes?.run).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, n);
    const mem = [...memory.values()].map((m) => m.run).filter((r) => !runs.some((x) => x.id === r.id));
    return { runs: [...runs, ...mem].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, n), backend: "audit" };
  } catch {
    return { runs: [...memory.values()].map((m) => m.run), backend: "memory" };
  }
}

/** One run plus its per-question results (failing first). */
export async function getRun(ctxArg, runId) {
  if (tablesUsable()) {
    try {
      const out = await withTenant(ctxArg, async (db) => {
        const run = (await db.raw(`SELECT * FROM donovan_scorecard_runs WHERE ${TENANT_SQL} AND id = $1`, [runId])).rows[0];
        if (!run) return null;
        const results = (await db.raw(
          `SELECT * FROM donovan_scorecard_results WHERE ${TENANT_SQL} AND run_id = $1 ORDER BY passed ASC, category, question_id LIMIT 1500`, [runId])).rows;
        return { run: rowToRun(run), results: results.map(rowToResult) };
      });
      if (out) return { ...out, backend: "tables" };
    } catch (err) {
      if (!noteTablesMissing(err)) console.warn("scorecard-store: table read failed:", err?.name ?? "error");
    }
  }
  try {
    const out = await withTenant(ctxArg, async (db) => readAuditRun(db, runId));
    if (out.last) {
      const results = out.results.sort((a, b) => Number(a.passed) - Number(b.passed));
      return { run: out.last, results, backend: "audit" };
    }
  } catch { /* fall through to memory */ }
  const mem = memory.get(runId);
  return mem ? { run: mem.run, results: [...mem.results].sort((a, b) => Number(a.passed) - Number(b.passed)), backend: "memory" } : null;
}
