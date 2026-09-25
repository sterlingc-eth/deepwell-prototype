/**
 * Donovan self-learning loop, Workstream A item 1: the EXAM GATE.
 *
 * WHY: today, a synonym/few_shot proposal stays 'pending' forever under the default
 * DONOVAN_AUTO_LEARN='vocab' (policy.js), a recipe needs seen>=2 or an operator, and a capability_gap
 * is informational only — so most of what the nightly loop discovers never actually changes what
 * Donovan does. verify.js's own routing-bank check is real, but it is a STATIC, DB-free regression
 * check (does the overlay still route every bank question the same coarse way) — it cannot catch a
 * candidate that routes correctly but simply gives a WORSE answer. This file is the stronger check:
 * it runs a stratified slice of the real golden exam (test-docs/scorecard/exam.json) through the SAME
 * pipeline a customer's own question takes (scorecard/runner.js runScorecard -> askViaHandler -> the
 * real /api/ask handler), once with today's overlay and once with the candidate laid on top, and
 * compares. A candidate that never lowers the pass rate or any single category's pass COUNT may be
 * auto-approved even when the ordinary per-kind policy would have left it pending — never when
 * DONOVAN_AUTO_LEARN='off' (promotePendingWithExamGate's own guard), and never for capability_gap
 * (which never reaches this file at all — see proposals.js's own doc comment).
 *
 * HOW THE CANDIDATE IS APPLIED WITHOUT TOUCHING scorecard/runner.js OR ask.js: neither file is owned
 * by this workstream, and neither accepts an overlay override as a parameter — every layer of the real
 * pipeline resolves it itself, from THIS module's own getActiveOverlayForTenant(ctx) (api/ask.js's own
 * overlay line, and runScorecard's own missKey tagging both call it). So the "after" run is produced by
 * asking the very same real pipeline, having first told THIS module — via setCandidateOverlayForGate,
 * below — to answer getActiveOverlayForTenant(ctx) for that one tenant with the candidate merged on
 * top, for exactly the duration of that one gating call (cleared in a `finally`, never cached). No
 * proposal ever needs to be written to donovan_learned to be evaluated this way.
 *
 * NARROW CONCURRENCY NOTE: the override is process-global, keyed by tenantKey. A gate run and a live
 * customer question for the SAME tenant key, truly concurrent in the SAME warm process, could
 * momentarily cross — acceptable here because both callers (the nightly cron sweep and the operator's
 * "Run learning now" button) run the gate against the founder/operator tenant, never a paying
 * customer's own tenant, and always inside a single dedicated invocation. Documented, not silently
 * assumed safe.
 */
import { loadExam } from '../scorecard/exam.js';
import { runScorecard as runScorecardLive, DEFAULT_BUDGET_USD, MAX_PAGE_SIZE } from '../scorecard/runner.js';
import { setCandidateOverlayForGate, clearCandidateOverlayForGate, invalidateActiveOverlayCache } from './overlay.js';
import { overlayFromProposal } from './verify.js';
import { proposeFixesForClusters, MAX_CLUSTERS_PER_RUN } from './gapPromoter.js';
import { buildGapReport, latestGapReport } from './gapReport.js';
import { parseAutoLearnPolicy } from './policy.js';
import * as store from './store.js';

export const DEFAULT_GATE_SAMPLE_SIZE = 60;
export const DEFAULT_NIGHTLY_CAP = 10;
const MIN_GATE_MS = 15_000; // never start a candidate's exam pair with less than this left on a shared deadline
const GATE_KINDS = new Set(['synonym', 'few_shot', 'recipe']); // never abbreviation/typo (already vocab-gated) or capability_gap (informational only)

/* ------------------------------------------------------------------ pure: sampling + scoring */

/**
 * A deterministic, category-stratified sample of up to `size` questions: round-robin across every
 * category present (alphabetical, so re-runs are reproducible) rather than a straight prefix slice, so
 * a candidate cannot pass simply because the categories it would help happen to sort first. Pure,
 * exported for tests.
 */
export function stratifiedSample(questions, size = DEFAULT_GATE_SAMPLE_SIZE) {
  const list = Array.isArray(questions) ? questions.filter(Boolean) : [];
  if (list.length <= size) return [...list];
  const byCategory = new Map();
  for (const q of list) {
    const cat = q?.category ?? 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(q);
  }
  const cats = [...byCategory.keys()].sort();
  const out = [];
  let round = 0;
  while (out.length < size) {
    let addedAny = false;
    for (const cat of cats) {
      const bucket = byCategory.get(cat);
      if (round < bucket.length) {
        out.push(bucket[round]);
        addedAny = true;
        if (out.length >= size) break;
      }
    }
    if (!addedAny) break;
    round++;
  }
  return out;
}

/** {category -> {passed, total}} from a scorecard pageResults array, skipped rows excluded. Pure. */
export function perCategoryCounts(results) {
  const out = {};
  for (const r of results ?? []) {
    if (r?.skipped) continue;
    const cat = r.category ?? 'other';
    if (!out[cat]) out[cat] = { passed: 0, total: 0 };
    out[cat].total++;
    if (r.passed) out[cat].passed++;
  }
  return out;
}

/**
 * The promotion policy itself, pure: NEVER promote a candidate that lowers the overall pass rate or
 * ANY category's pass COUNT, and never trust an "after" run that answered fewer questions than
 * "before" (an incomplete comparison — e.g. the after run hit its budget/deadline first — is treated as
 * a failure to prove safety, not as a pass). Exported for tests.
 * @param {{pageResults: object[]}} before
 * @param {{pageResults: object[]}} after
 */
export function gateDecision(before, after) {
  const beforeResults = before?.pageResults ?? [];
  const afterResults = after?.pageResults ?? [];
  const beforeTotal = beforeResults.filter((r) => !r?.skipped).length;
  const beforePassed = beforeResults.filter((r) => r?.passed).length;
  const afterTotal = afterResults.filter((r) => !r?.skipped).length;
  const afterPassed = afterResults.filter((r) => r?.passed).length;
  const beforeRate = beforeTotal ? beforePassed / beforeTotal : 0;
  const afterRate = afterTotal ? afterPassed / afterTotal : 0;

  const beforeCats = perCategoryCounts(beforeResults);
  const afterCats = perCategoryCounts(afterResults);
  const regressions = [];
  for (const cat of Object.keys(beforeCats)) {
    const b = beforeCats[cat].passed;
    const a = afterCats[cat]?.passed ?? 0;
    if (a < b) regressions.push({ category: cat, before: b, after: a });
  }

  const incomplete = afterTotal < beforeTotal;
  if (incomplete) regressions.push({ category: '*incomplete-after-run*', before: beforeTotal, after: afterTotal });

  const ok = !incomplete && afterRate >= beforeRate && regressions.length === 0;
  const improved = ok && (afterRate > beforeRate || afterPassed > beforePassed);
  return { ok, improved, regressions, beforeRate, afterRate, beforePassed, afterPassed, beforeTotal, afterTotal };
}

/* ------------------------------------------------------------------ the live gate run */

async function runFullExam(runScorecardFn, { ctx, questions, handler, budgetUsd, deadlineAt }) {
  const merged = [];
  let offset = 0;
  let runId;
  let costUsd = 0;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, questions.length));
  // Bounded loop: at most one page per (up to MAX_PAGE_SIZE) questions, plus one — never infinite even
  // if a stub `runScorecardFn` in a test forgets to advance `nextOffset`.
  const maxPages = Math.ceil(questions.length / pageSize) + 1;
  for (let page = 0; page < maxPages; page++) {
    const res = await runScorecardFn({
      ctx, questions, handler, budgetUsd, pageSize, offset, runId, deadlineAt,
      source: 'exam-gate', feedMisses: false, retryFailures: false,
    });
    runId = res.runId;
    merged.push(...(res.pageResults ?? []));
    costUsd += Number(res.spentUsd) || 0;
    if (res.done || res.nextOffset == null || res.nextOffset <= offset) break;
    offset = res.nextOffset;
  }
  return { runId, pageResults: merged, costUsd };
}

/**
 * Runs the golden exam TWICE against `ctx`'s own data — once under whatever overlay production sees
 * for this tenant right now, once with `candidateOverlay` merged on top — and decides whether the
 * candidate is safe to promote. Never writes ask_misses/recipes for either run (feedMisses:false).
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {{abbreviations?, typos?, vocab?, synonyms?, fewShot?, recipes?}} candidateOverlay  the overlay
 *   delta ONE candidate proposal would add (learning/verify.js's overlayFromProposal, or a hand-built
 *   `{recipes: [payload]}` for a 'recipe' proposal — overlayFromProposal itself has no recipe case).
 * @param {{sampleSize?: number, handler?: Function, budgetUsd?: number, deadlineAt?: number, runScorecard?: Function}} [opts]
 * @returns {Promise<{ok:boolean, improved:boolean, regressions:object[], before:object, after:object, sample:number, perCategory:object, runIds:object, costUsd:number, skipped?:string}>}
 */
export async function runGatingExam(ctx, candidateOverlay, {
  sampleSize = DEFAULT_GATE_SAMPLE_SIZE, handler, budgetUsd = DEFAULT_BUDGET_USD, deadlineAt, runScorecard: runScorecardFn = runScorecardLive,
} = {}) {
  const empty = { ok: false, improved: false, regressions: [], before: { passed: 0, total: 0, rate: 0 }, after: { passed: 0, total: 0, rate: 0 }, sample: 0, perCategory: { before: {}, after: {} }, runIds: {}, costUsd: 0 };
  if (!ctx?.tenantKey) return { ...empty, skipped: 'no-tenant' };
  const exam = loadExam();
  if (!exam.questions.length) return { ...empty, skipped: 'no-exam' };
  const sample = stratifiedSample(exam.questions, sampleSize);
  if (!sample.length) return { ...empty, skipped: 'empty-sample' };

  const askHandler = handler ?? (await import('../../ask.js')).default;
  const deadline = deadlineAt ?? Date.now() + 55_000;

  const before = await runFullExam(runScorecardFn, { ctx, questions: sample, handler: askHandler, budgetUsd, deadlineAt: deadline });

  setCandidateOverlayForGate(ctx.tenantKey, candidateOverlay);
  let after;
  try {
    after = await runFullExam(runScorecardFn, { ctx, questions: sample, handler: askHandler, budgetUsd, deadlineAt: deadline });
  } finally {
    clearCandidateOverlayForGate(ctx.tenantKey);
  }

  const decision = gateDecision(before, after);
  return {
    ok: decision.ok,
    improved: decision.improved,
    regressions: decision.regressions,
    before: { passed: decision.beforePassed, total: decision.beforeTotal, rate: decision.beforeRate },
    after: { passed: decision.afterPassed, total: decision.afterTotal, rate: decision.afterRate },
    sample: sample.length,
    perCategory: { before: perCategoryCounts(before.pageResults), after: perCategoryCounts(after.pageResults) },
    runIds: { before: before.runId, after: after.runId },
    costUsd: Math.round((before.costUsd + after.costUsd) * 10000) / 10000,
  };
}

/* ------------------------------------------------------------------ overlay for one candidate */

/** The overlay delta for one PENDING proposal row, whatever its kind — overlayFromProposal has no
 *  'recipe' case (learning/verify.js's own doc comment: recipes never reach it in production, since a
 *  recipe candidate is verified via recipes.js's own verifyRecipe, not verify.js), so that one kind is
 *  built by hand here instead. Pure. */
function overlayForCandidate(kind, payload) {
  if (kind === 'recipe') return { abbreviations: {}, typos: {}, vocab: [], synonyms: {}, fewShot: [], recipes: [payload] };
  return overlayFromProposal({ kind, payload });
}

/**
 * Exam-gate-promotes up to `cap` currently PENDING donovan_proposals rows of an eligible kind
 * (synonym/few_shot/recipe — the WHY: today these stay pending under the default policy no matter how
 * much evidence piles up). Each candidate is tested ALONE, so one rejection never blocks the others in
 * the same run. A candidate that clears the gate is decided 'auto_approved' (store.decideProposal,
 * which atomically activates it via the existing learning_decide function — migration 26/29, unchanged)
 * and its exam result is recorded on the proposal row (migration 34) plus one donovan_gap_promotions
 * audit row — both tolerant of migration 34 not being applied yet (store.js's own warn-once, no-op
 * degrade). Runs under DONOVAN_AUTO_LEARN='vocab' or 'all' (never 'off' — the operator's own explicit
 * kill switch for ALL automatic learning, honored here exactly as everywhere else in this loop).
 * @param {{tenantKey: string, tenantName?: string}} ctx  whose exam data validates every candidate
 */
export async function promotePendingWithExamGate(ctx, {
  cap = DEFAULT_NIGHTLY_CAP, sampleSize = DEFAULT_GATE_SAMPLE_SIZE, handler, budgetUsd, deadlineAt, runScorecard: runScorecardFn,
} = {}) {
  const summary = { attempted: 0, promoted: 0, rejected: 0, skipped: 0 };
  if (!ctx?.tenantKey) return { ...summary, skipped: 'no-tenant' };
  if (parseAutoLearnPolicy(process.env.DONOVAN_AUTO_LEARN) === 'off') return { ...summary, skipped: 'auto-learn-off' };

  let pending;
  try {
    pending = await store.listProposals({ status: 'pending', limit: 300 });
  } catch (err) {
    console.warn('exam-gate: could not list pending proposals (non-fatal):', err?.message);
    return { ...summary, skipped: 'store-unavailable' };
  }
  const eligible = (pending ?? []).filter((p) => GATE_KINDS.has(p.kind)).slice(0, Math.max(0, cap));

  for (const p of eligible) {
    if (deadlineAt && deadlineAt - Date.now() < MIN_GATE_MS) break;
    summary.attempted++;
    const overlay = overlayForCandidate(p.kind, p.payload);
    if (!overlay) { summary.skipped++; continue; }

    let result;
    try {
      result = await runGatingExam(ctx, overlay, { sampleSize, handler, budgetUsd, deadlineAt, runScorecard: runScorecardFn });
    } catch (err) {
      console.warn('exam-gate: a gating run failed (non-fatal):', err?.message);
      summary.skipped++;
      continue;
    }
    if (result.skipped) { summary.skipped++; continue; }

    await store.recordExamResult(p.id, {
      examBefore: result.before, examAfter: result.after, examSample: result.sample, examRunId: result.runIds?.after ?? null,
    });

    if (!result.ok) { summary.rejected++; continue; }

    const decided = await store.decideProposal(p.id, 'auto_approved', 'system:exam-gate');
    if (!decided) { summary.skipped++; continue; }
    invalidateActiveOverlayCache();
    summary.promoted++;
    await store.insertGapPromotion(ctx, {
      proposalId: p.id, kind: p.kind, capability: p.evidence?.capability ?? null,
      examBefore: result.before, examAfter: result.after, examSample: result.sample,
    });
  }
  return summary;
}

/**
 * The whole exam-gated learning pass: this week's cross-tenant gap clusters -> up to
 * gapPromoter.MAX_CLUSTERS_PER_RUN candidate proposals (gapPromoter.js), then every eligible pending
 * proposal (old or new, whatever its origin) through the gate above. Used by BOTH the operator's "Run
 * learning now" (sweep.js runLearningNow) and the nightly autopilot sweep (autopilot.js
 * runAutopilotSweepStep) — each calls this EXACTLY ONCE per invocation, so a given pending item is
 * never evaluated twice (and never billed twice) in the same run.
 * @param {{tenantKey: string, tenantName?: string}} ctx  the founder/operator tenant, normally
 */
export async function runExamGatedLearningPass(ctx, {
  deadlineAt, handler, maxClusters = MAX_CLUSTERS_PER_RUN, cap = DEFAULT_NIGHTLY_CAP, sampleSize = DEFAULT_GATE_SAMPLE_SIZE,
} = {}) {
  const result = {
    gapPromotion: { attempted: 0, proposed: 0, rejected: 0, costUsd: 0 },
    gate: { attempted: 0, promoted: 0, rejected: 0, skipped: 0 },
  };
  if (!ctx?.tenantKey) return { ...result, skipped: 'no-tenant' };

  try {
    const report = (await latestGapReport()) ?? (await buildGapReport({}));
    result.gapPromotion = await proposeFixesForClusters(report?.clusters ?? [], { maxClusters });
  } catch (err) {
    console.warn('exam-gate: gap-promoter step failed (non-fatal):', err?.message);
  }

  try {
    result.gate = await promotePendingWithExamGate(ctx, { cap, sampleSize, handler, deadlineAt });
  } catch (err) {
    console.warn('exam-gate: promotion step failed (non-fatal):', err?.message);
  }

  return result;
}

/** Test/diagnostics only: the runId this module tags "gate" runs with is whatever runScorecard hands
 *  back — exported for symmetry with the rest of this loop's test-only resets, currently a no-op since
 *  this file keeps no module-level cache of its own beyond overlay.js's gate override (reset there). */
export function resetExamGateForTests() { /* no module-level state of its own */ }
