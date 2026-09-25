/**
 * TEAM H (2026-09-24): the AUTONOMOUS PER-TENANT LEARNING LOOP — the
 * orchestrator that generalizes the existing founder-only nightly loop
 * (learning/sweep.js, scorecard/routes) to EVERY paying/active tenant,
 * fairly rotated within the cron's own time budget, industry-agnostic (it
 * only ever touches a tenant's own pack via api/_lib/industry/index.js).
 *
 * One entry point for cron-sweep.js:
 *   runAutopilotSweepStep({deadlineAt}) — for as many eligible tenants as
 *   the shared deadline and the platform daily $ cap allow, in fair
 *   rotation order (learning/rotation.js), claims that tenant's turn (once
 *   per UTC day, via the SAME generic claim_platform_daily_task migration
 *   25 already provides — no new claim mechanism needed), then for that
 *   tenant: (a) replays its own open misses, (b) runs a small auto-
 *   generated exam slice from its pack's examTemplates, (c) lets that
 *   exam's failures feed back into ask_misses (runScorecard's own
 *   feedMisses, unchanged), (d) mines new vocabulary from its own
 *   documents, (e) auto-promotes/demotes per autopilotPolicy.js's safe
 *   rules. Every automatic decision this file makes is already audited by
 *   the functions it calls (learning_decide's decided_by='system:...',
 *   donovan_learned_tenant's own reason column); this file additionally
 *   writes ONE counts-only audit_log row per tenant per night
 *   ('donovan.autopilot_run') for the operator UI — never question text.
 *
 * Never touches the model directly for replay/exam work — those are
 * replayMisses/runScorecard's job, reused unchanged. The only direct model
 * calls here are vocabMining.js's own (≤5/tenant/night).
 */
import { getPool, withTenant } from '../recordsStore.js';
import { VOCAB } from '../nlNormalize.js';
import { rotationForDate } from './rotation.js';
import { createSpendTracker } from './tenantCaps.js';
import { replayMisses } from './replay.js';
import { runScorecard } from '../scorecard/runner.js';
import { buildTenantExam } from '../scorecard/tenantExam.js';
import { packForTenant } from '../industry/index.js';
import {
  mineCandidateTerms, topCandidatesForLabeling, labelCandidatesWithModel, packKnownVocab, validateTenantVocabProposal,
} from './vocabMining.js';
import { decideTenantVocabStatus, shouldAutoDemote } from './autopilotPolicy.js';
import { findTenantVocab, upsertTenantVocab } from './tenantOverlay.js';
import { invalidateTenantOverlayCache, invalidateActiveOverlayCache } from './overlay.js';
import * as store from './store.js';
import { RECIPE_KIND, normalizeRecipeQuestion } from './recipes.js';
import { buildGapReport, storeGapReport } from './gapReport.js';
import { runExamGatedLearningPass } from './examGate.js';
import askHandler from '../../ask.js';

const AUTOPILOT_TASK_KEY = 'donovan-autopilot';
const GAP_REPORT_TASK_KEY = 'donovan-gap-report';
export const MIN_TENANT_MS = 10_000; // never start a new tenant with less than this left on the shared deadline
const EXTRACTIONS_SAMPLE_LIMIT = 500;
export const DEFAULT_EXAM_SIZE = 12;

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Monday (UTC) of the ISO week containing `dateStr`. Pure. Exported for tests. */
export function isoWeekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Every active/trialing tenant with a resolvable tenant key — reuses the EXISTING
 *  list_notification_eligible_tenants() (M3-config/16-notifications.sql), the same
 *  "billing_status IN ('active','trialing')" eligibility the warranty-notification
 *  sweep already uses. No new SQL needed for this. */
export async function listEligibleTenants() {
  try {
    const { rows } = await getPool().query('SELECT * FROM list_notification_eligible_tenants()');
    return rows.map((r) => ({ tenantKey: r.tenant_key, tenantName: r.tenant_name }));
  } catch (err) {
    console.warn('autopilot: could not list eligible tenants:', err?.message);
    return [];
  }
}

/** Generic once-per-key-per-date claim, reusing migration 25's own claim_platform_daily_task. */
async function claimPlatformTask(tenantKey, taskKey, dateStr) {
  try {
    const { rows } = await getPool().query('SELECT claim_platform_daily_task($1,$2,$3) AS claimed', [tenantKey, taskKey, dateStr]);
    return Boolean(rows[0]?.claimed);
  } catch (err) {
    console.warn(`autopilot: claim_platform_daily_task(${taskKey}) failed:`, err?.message);
    return false;
  }
}

async function logTenantSummary(ctx, summary) {
  try {
    await withTenant(ctx, (db) => db.logAction({
      action: 'donovan.autopilot_run', resource_type: 'donovan_autopilot', resource_id: ctx.tenantKey, changes: summary,
    }));
  } catch (err) {
    console.warn('autopilot: per-tenant audit write failed (non-fatal):', err?.message);
  }
}

/* ------------------------------------------------------------------ (d) vocabulary mining */

async function loadTenantExtractionSample(ctxArg) {
  try {
    return await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT value, document_id AS "documentId" FROM extractions
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND value IS NOT NULL
          AND length(value) BETWEEN 2 AND 80
        ORDER BY created_at DESC LIMIT ${EXTRACTIONS_SAMPLE_LIMIT}`,
      []
    )).rows);
  } catch (err) {
    console.warn('autopilot: vocab mining sample read failed (non-fatal):', err?.message);
    return [];
  }
}

/**
 * Mine + auto-decide this tenant's own vocabulary candidates. Deterministic
 * mining (mineCandidateTerms) is free; at most MAX_LABEL_CALLS_PER_TENANT_NIGHT
 * Haiku calls label the top candidates. A candidate that already accumulated
 * enough count/docCount across nights auto-activates immediately (no model
 * call needed for THAT decision — decideTenantVocabStatus is purely
 * frequency-gated once verification passes).
 * @returns {Promise<{mined:number, labeled:number, promoted:number, pending:number, costUsd:number}>}
 */
export async function mineTenantVocabulary(ctxArg, pack, { allowLabeling = true, deadlineAt = Infinity, budgetUsd = Infinity } = {}) {
  const rows = await loadTenantExtractionSample(ctxArg);
  if (!rows.length) return { mined: 0, labeled: 0, promoted: 0, pending: 0, costUsd: 0 };

  const known = new Set([...VOCAB, ...packKnownVocab(pack)]);
  const candidates = mineCandidateTerms(rows, known);
  const top = topCandidatesForLabeling(candidates);
  if (!top.length) return { mined: candidates.length, labeled: 0, promoted: 0, pending: 0, costUsd: 0 };

  const { results, costUsd } = allowLabeling
    ? await labelCandidatesWithModel(top, pack, { deadlineAt, budgetUsd })
    : { results: top, costUsd: 0 };

  let promoted = 0;
  let pending = 0;
  for (const cand of results) {
    if (!cand.kind) continue; // model said 'none', or the call failed/was skipped
    const key = cand.kind === 'abbreviation' ? cand.payload.from : `${cand.payload.entity}:${cand.payload.word}`;
    const existing = await findTenantVocab(ctxArg, cand.kind, key);
    if (existing?.status === 'active') continue; // already live
    const verification = validateTenantVocabProposal(cand.kind, cand.payload, pack);
    const priorCount = existing?.status === 'pending' ? Number(existing.evidence?.count) || 0 : 0;
    const priorDocs = existing?.status === 'pending' ? Number(existing.evidence?.docCount) || 0 : 0;
    const count = priorCount + cand.count;
    const docCount = Math.max(priorDocs, cand.docCount);
    const decision = decideTenantVocabStatus({ count, docCount }, verification);
    const id = await upsertTenantVocab(ctxArg, {
      kind: cand.kind, key, value: cand.payload, status: decision.status,
      evidence: { count, docCount }, reason: decision.reason,
    });
    if (!id) continue;
    if (decision.status === 'active') { promoted++; invalidateTenantOverlayCache(ctxArg.tenantKey); }
    else if (decision.status === 'pending') pending++;
  }
  return { mined: candidates.length, labeled: results.filter((r) => r.kind).length, promoted, pending, costUsd };
}

/* ------------------------------------------------------------------ (e) auto-demote */

/**
 * Retire any ACTIVE (platform-level) recipe whose question the tenant's own
 * fresh auto-exam just failed under its independent oracle — the brief's
 * "auto-DEMOTE a live recipe when ... the oracle" disagrees trigger.
 * (Thumbs-down demotion is already wired separately, unchanged, via
 * replay.js's applyThumbsDown -> retireRecipeForQuestion.)
 * @param {Array<{question:string, passed:boolean, skipped?:boolean}>} examResults  runScorecard's pageResults
 */
export async function demoteRecipesDisagreeingWithExam(examResults) {
  const failing = new Set((examResults ?? []).filter((r) => r && !r.skipped && !r.passed).map((r) => normalizeRecipeQuestion(r.question)));
  if (!failing.size) return { demoted: 0 };
  const active = (await store.listActiveLearned()).filter((r) => r.kind === RECIPE_KIND);
  let demoted = 0;
  for (const row of active) {
    if (!failing.has(row.value?.question)) continue;
    if (!shouldAutoDemote({ oracleAgrees: false })) continue; // unreachable today (oracleAgrees is always false here), kept for symmetry
    if (await store.deactivateLearned(row.id)) demoted++;
  }
  if (demoted) invalidateActiveOverlayCache();
  return { demoted };
}

/* ------------------------------------------------------------------ one tenant's whole slice */

/**
 * One tenant's whole nightly autopilot slice: replay -> auto-exam (whose
 * failures already feed back into ask_misses via runScorecard's own
 * feedMisses) -> vocabulary mining -> auto-demotion. Budget-bounded by
 * `spend` (learning/tenantCaps.js) for BOTH this tenant and the platform as
 * a whole; never throws.
 * @param {{tenantKey:string, tenantName?:string}} ctx
 * @param {{today:string, spend:object, deadlineAt:number, handler?:Function, examSize?:number}} opts
 */
export async function runAutopilotForTenant(ctx, { today, spend, deadlineAt, handler = askHandler, examSize = DEFAULT_EXAM_SIZE } = {}) {
  const summary = {
    tenantKey: ctx.tenantKey, replayed: 0, answeredNow: 0, examAnswered: 0, examPassed: 0,
    vocabMined: 0, vocabPromoted: 0, demoted: 0, costUsd: 0, skipped: null,
  };
  const startAllowance = spend.allowanceFor(ctx.tenantKey);
  if (startAllowance <= 0.005) { summary.skipped = 'no-budget'; return summary; }

  // Team G's packForTenant resolves via a DB query; it needs the {withTenant,ctxArg}
  // call shape (ask.js's own convention) to actually look up this tenant's industry —
  // handing it bare `ctx` alone has no `.withTenant` and silently falls back to hvac.
  const pack = await packForTenant({ withTenant, ctxArg: ctx });

  // (a) replay this tenant's own open misses, budget- and time-bounded.
  try {
    const replayBudget = startAllowance * 0.5;
    const replayBudgetMs = Math.min(20_000, Math.max(2000, deadlineAt - Date.now() - 5000));
    const replay = await replayMisses({ ctxArg: ctx, source: 'autopilot', maxCostUsd: replayBudget, budgetMs: replayBudgetMs });
    summary.replayed = replay.attempted ?? 0;
    summary.answeredNow = replay.answeredNow ?? 0;
    spend.record(ctx.tenantKey, replay.costUsd ?? 0);
  } catch (err) {
    console.warn('autopilot: replay failed for a tenant (non-fatal):', err?.message);
  }

  // (b)+(c) a small auto-generated exam slice for this tenant; failures feed ask_misses automatically.
  let examResults = [];
  try {
    const remaining = spend.allowanceFor(ctx.tenantKey);
    if (remaining > 0.01 && deadlineAt - Date.now() > MIN_TENANT_MS) {
      const exam = await buildTenantExam(ctx, pack, today, examSize);
      if (exam.questions.length) {
        const out = await runScorecard({
          ctx, questions: exam.questions, handler, budgetUsd: remaining, pageSize: examSize, deadlineAt,
          source: 'nightly', examVersion: exam.version, today,
        });
        examResults = out.pageResults;
        summary.examAnswered = examResults.filter((r) => !r.skipped).length;
        summary.examPassed = examResults.filter((r) => r.passed).length;
        spend.record(ctx.tenantKey, out.spentUsd ?? 0);
      }
    }
  } catch (err) {
    console.warn('autopilot: tenant exam failed (non-fatal):', err?.message);
  }

  // (d) vocabulary mining — deterministic + up to 5 labeling calls, only if there is still budget.
  try {
    if (spend.allowanceFor(ctx.tenantKey) > 0.001) {
      const vocab = await mineTenantVocabulary(ctx, pack, { deadlineAt, budgetUsd: spend.allowanceFor(ctx.tenantKey) });
      summary.vocabMined = vocab.mined;
      summary.vocabPromoted = vocab.promoted;
      spend.record(ctx.tenantKey, vocab.costUsd ?? 0);
    }
  } catch (err) {
    console.warn('autopilot: vocab mining failed (non-fatal):', err?.message);
  }

  // (e) auto-demote a live recipe this tenant's own exam just disagreed with.
  try {
    const demo = await demoteRecipesDisagreeingWithExam(examResults);
    summary.demoted = demo.demoted;
  } catch (err) {
    console.warn('autopilot: demotion check failed (non-fatal):', err?.message);
  }

  summary.costUsd = spend.tenantSpentUsd(ctx.tenantKey);
  await logTenantSummary(ctx, summary);
  return summary;
}

/** The last `hours` of per-tenant autopilot summaries (list_autopilot_summary_window,
 *  M3-config/32 — tolerant of that migration not being applied). For the operator UI only:
 *  counts + cost, never question text (the same rows logTenantSummary itself wrote). */
export async function listRecentAutopilotSummaries(hours = 24) {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    const { rows } = await getPool().query('SELECT * FROM list_autopilot_summary_window($1,$2)', [from, to]);
    return rows.map((r) => ({ tenantId: r.tenant_id, ...r.changes, at: r.created_at }));
  } catch (err) {
    console.warn('autopilot: list_autopilot_summary_window failed (migration 32 may not be applied yet):', err?.message);
    return [];
  }
}

/* ------------------------------------------------------------------ weekly gap report */

async function maybeBuildWeeklyGapReport({ today, env }) {
  const founder = env.DEEPWELL_FOUNDER_TENANT_ID;
  const weekStart = isoWeekStart(today);
  if (founder) {
    const claimed = await claimPlatformTask(founder, GAP_REPORT_TASK_KEY, weekStart);
    if (!claimed) return null; // already built this week
  }
  const report = await buildGapReport({});
  await storeGapReport(report);
  return { weekStart: report.weekStart, totalFailures: report.totalFailures, clusters: report.clusters.length };
}

/* ------------------------------------------------------------------ the nightly cron step */

/**
 * cron-sweep.js's per-tenant autopilot step. Processes as many eligible
 * tenants as the shared `deadlineAt` and the platform daily cap allow, in
 * fair rotation order (rotation.js) — a tenant already claimed today (by an
 * earlier invocation of this same step) is skipped at zero cost. Also
 * builds+stores the weekly gap report, at most once per ISO week. Never
 * throws.
 * @param {{deadlineAt:number, env?:object, handler?:Function, claim?:boolean}} [opts]
 */
export async function runAutopilotSweepStep({ deadlineAt, env = process.env, handler = askHandler, claim = true } = {}) {
  try {
    if ((deadlineAt ?? Infinity) - Date.now() < MIN_TENANT_MS) return { skipped: 'no-time' };
    const today = todayUtc();
    const eligible = await listEligibleTenants();
    if (!eligible.length) return { skipped: 'no-eligible-tenants' };

    const order = rotationForDate(eligible, today);
    const spend = createSpendTracker({});
    const perTenant = [];

    for (const t of order) {
      if (deadlineAt - Date.now() < MIN_TENANT_MS) break;
      if (spend.platformExhausted()) break;
      const ctx = { tenantKey: t.tenantKey, tenantName: t.tenantName ?? t.tenantKey };
      if (claim && !(await claimPlatformTask(ctx.tenantKey, AUTOPILOT_TASK_KEY, today))) continue; // already ran today
      perTenant.push(await runAutopilotForTenant(ctx, { today, spend, deadlineAt, handler }));
    }

    let gapReport = null;
    try {
      gapReport = await maybeBuildWeeklyGapReport({ today, env });
    } catch (err) {
      console.warn('autopilot: gap report step failed (non-fatal):', err?.message);
    }

    // Workstream A: the EXAM-GATED LEARNING PASS — gapPromoter.js's cluster proposals, then
    // examGate.js's own promotePendingWithExamGate over every eligible PENDING proposal. Runs ONCE per
    // sweep (never once per tenant — a platform-level donovan_proposals row has no single "owning"
    // tenant, and re-evaluating the same pending backlog for every tenant in rotation would multiply
    // its cost for no benefit), against the founder/operator tenant's own exam data when configured,
    // else the first tenant this sweep actually processed. This is the ONLY nightly call site (the
    // learning-sweep step, runLearningSweepStep, deliberately does not also call it — see that file's
    // own doc comment) — the operator's own call site is runLearningNow, also exactly once per run.
    let examGatedLearning = null;
    try {
      const gateCtx = env.DEEPWELL_FOUNDER_TENANT_ID
        ? { tenantKey: env.DEEPWELL_FOUNDER_TENANT_ID, tenantName: env.DEEPWELL_FOUNDER_TENANT_ID }
        // Never fall back to a paying tenant: the gate swaps a candidate overlay in process-wide for its
        // tenant while it runs (overlay.js), so it must only ever target the founder/operator tenant.
        : null;
      if (gateCtx && deadlineAt - Date.now() > MIN_TENANT_MS) {
        examGatedLearning = await runExamGatedLearningPass(gateCtx, { deadlineAt, handler });
      }
    } catch (err) {
      console.warn('autopilot: exam-gated learning pass failed (non-fatal):', err?.message);
    }

    return {
      tenantsEligible: eligible.length,
      tenantsProcessed: perTenant.length,
      platformSpentUsd: spend.platformSpentUsd(),
      perTenant,
      ...(gapReport ? { gapReport } : {}),
      ...(examGatedLearning ? { examGatedLearning } : {}),
    };
  } catch (err) {
    console.error('autopilot sweep step failed (non-fatal):', err?.message);
    return { error: err?.message };
  }
}
