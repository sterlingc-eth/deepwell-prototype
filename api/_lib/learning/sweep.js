/**
 * Donovan self-learning loop, Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md):
 * the nightly (and on-demand) ORCHESTRATOR — wires the last-24h miss digest
 * (api/_lib/missDigest.js) into the proposer (proposer.js), each candidate
 * into the verifier (verify.js) and decision policy (policy.js), and every
 * outcome into the proposal store (store.js). Never touches the model or the
 * routing bank directly itself — those are proposer.js/verify.js's jobs.
 *
 * Two entry points:
 *   - runLearningSweepStep()  — api/_lib/routes/cron-sweep.js's nightly step.
 *     Guarded to run at most once per UTC day (claim_platform_daily_task,
 *     task key 'donovan-learning' — the SAME generic guard/table
 *     missDigest.js's own step uses, M3-config/25-miss-digest.sql), and
 *     skips entirely (no claim spent) when migration 26's functions aren't
 *     applied yet. Never throws — every error is caught and returned as
 *     `{error}`, exactly like every other cron-sweep step.
 *   - runLearningNow()        — api/review.js's learningRunNow action (an
 *     operator's "Run learning now" button). Same work, no once-per-day
 *     guard — an operator explicitly asking for it should always get a real
 *     run, but still skipped when the migration isn't applied.
 */
import { getPool } from '../recordsStore.js';
import { buildMissDigest } from '../missDigest.js';
import { proposeFixesForMisses } from './proposer.js';
import { verifyProposalLive } from './verify.js';
import { decidePolicyStatus } from './policy.js';
import * as store from './store.js';
import { replayMisses } from './replay.js';

const TASK_KEY = 'donovan-learning';

// Best-effort fallback ONLY for a deployment that hasn't set
// DEEPWELL_FOUNDER_TENANT_ID — same "prevents the same warm process from
// double-running today, does not survive a cold start" idiom as
// missDigest.js's own lastRunDateNoFounderTenant.
let lastRunDateNoFounderTenant = null;

let warnedMigrationCheck = false;

/** Pure decision the no-founder-tenant fallback path makes before doing any
 *  work — identical shape to missDigest.js's own shouldRunDigestToday,
 *  exported so scripts/verify-learning.mjs can assert it without a database
 *  or a fabricated clock inside this module.
 *  @param {string|null} lastRunDate YYYY-MM-DD or null
 *  @param {string} today YYYY-MM-DD */
export function shouldRunLearningToday(lastRunDate, today) {
  return lastRunDate !== today;
}

/** True once M3-config/26-donovan-learning.sql has actually been applied —
 *  checked directly (rather than inferring it from a try/catch on a real
 *  read) so a night with genuinely zero misses and a night with a missing
 *  migration are never confused with each other in the sweep summary. */
async function migrationApplied() {
  try {
    const { rows } = await getPool().query("SELECT to_regprocedure('public.learning_list_active()') IS NOT NULL AS ok");
    return Boolean(rows[0]?.ok);
  } catch (err) {
    if (!warnedMigrationCheck) {
      warnedMigrationCheck = true;
      console.warn('donovan-learning: migration check failed (treating as not-applied):', err?.message);
    }
    return false;
  }
}

/** buildMissDigest()'s {groups:[{outcome,count,questions:[...]}]} shape ->
 *  the flat {question,outcome,count,tenantCount,detectedConditions}[] list
 *  proposeFixesForMisses expects — one entry per (outcome, question), which
 *  is exactly the grain the brief asks for ("grouped misses ... question_
 *  normalized, outcome, count, tenantCount, detected conditions"). */
function flattenMissGroups(digest) {
  const out = [];
  for (const g of digest?.groups ?? []) {
    for (const q of g.questions ?? []) {
      out.push({
        question: q.question,
        outcome: g.outcome,
        count: q.count,
        tenantCount: q.tenantCount,
        detectedConditions: q.detectedConditions ?? [],
      });
    }
  }
  return out;
}

/** Inserts one proposal row (always starting 'pending', matching
 *  insertProposal's own default) and immediately decides it when the policy
 *  computed anything other than 'pending' — so decided_at/decided_by are
 *  only ever set for a proposal an actual decision (human or system) was
 *  made on, and 'auto_approved' proposals atomically get their
 *  donovan_learned row via learning_decide (M3-config/26). A kind that
 *  couldn't even be validated into one of the five known values (should be
 *  unreachable — the model's tool schema enforces the enum — but proposer.js
 *  can still hand back `kind: null` for an unparseable response) is logged
 *  and skipped rather than inserted, since donovan_proposals' own CHECK
 *  constraint would reject it anyway. */
async function persistOne(p, status, reason, verification) {
  if (!p.kind) {
    console.warn(`donovan-learning: dropping an unusable ${p.source} proposal — ${reason ?? p.reason}`);
    return null;
  }
  const id = await store.insertProposal({
    kind: p.kind,
    payload: p.payload,
    evidence: p.evidence,
    verification: verification ?? {},
    status: 'pending',
    reason: reason ?? null,
  });
  if (id && status && status !== 'pending') {
    await store.decideProposal(id, status, 'system:nightly-sweep');
  }
  return id;
}

/**
 * The actual work, shared by both entry points below. Never throws (the two
 * wrappers still each carry their own try/catch, since this can still throw
 * on something neither wrapper anticipated — e.g. a store/proposer bug).
 */
export async function runLearningCore({ ctxArg, callModel } = {}) {
  const digest = await buildMissDigest();
  const missGroups = flattenMissGroups(digest);

  // MISS REPLAY (the loop-closing step): re-run the shop's open misses through the Donovan agent and
  // record answered-now / still-failing per miss; grounded answers become recipe proposals. Uses the
  // founder/operator tenant's OWN data and misses (never another shop's), respects the daily model
  // budget and its own cost ceiling. Runs even on a night with no new miss groups.
  const replayCtx = ctxArg ?? (process.env.DEEPWELL_FOUNDER_TENANT_ID ? { tenantKey: process.env.DEEPWELL_FOUNDER_TENANT_ID, tenantName: process.env.DEEPWELL_FOUNDER_TENANT_ID } : null);
  let replay = { skipped: 'no-founder-tenant' };
  if (replayCtx) {
    try {
      replay = await replayMisses({ ctxArg: replayCtx, source: ctxArg ? 'run-now' : 'nightly', callModel });
    } catch (err) {
      console.error('donovan-learning: replay failed (non-fatal):', err?.name);
      replay = { error: 'replay-failed' };
    }
  }

  const summary = {
    totalMissGroups: missGroups.length,
    modelCallsMade: 0,
    estimatedCostUsd: 0,
    byStatus: {},
    byKind: {},
  };
  summary.replay = replay;
  if (!missGroups.length) return { ...summary, skipped: 'no-new-misses' };

  const maxModelCalls = Number(process.env.DONOVAN_LEARN_MAX_CALLS) || 20;
  const { proposals, modelCallsMade, estimatedCostUsd } = await proposeFixesForMisses(missGroups, { maxModelCalls });
  summary.modelCallsMade = modelCallsMade;
  summary.estimatedCostUsd = estimatedCostUsd;

  for (const p of proposals) {
    let status;
    let reason = p.reason ?? null;
    let verification = {};

    if (!p.valid) {
      status = 'auto_rejected';
    } else {
      // ALWAYS re-verify here, immediately before deciding — never trust a
      // verification computed earlier in the same pass, so a proposal is
      // judged against the vocabulary/bank as of right now (verify.js's own
      // "second gate" reasoning, applied at decision time too, not just
      // proposal time).
      verification = verifyProposalLive(
        { kind: p.kind, payload: p.payload },
        { missQuestions: p.evidence?.questions ?? [] }
      );
      const decision = decidePolicyStatus(
        { kind: p.kind, tenantCount: p.evidence?.tenantCount ?? 0, count: p.evidence?.count ?? 0 },
        verification,
        process.env.DONOVAN_AUTO_LEARN
      );
      status = decision.status;
      reason = decision.reason;
    }

    const id = await persistOne(p, status, reason, verification);
    if (id) {
      summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
      summary.byKind[p.kind] = (summary.byKind[p.kind] ?? 0) + 1;
    }
  }

  return summary;
}

/** Operator-triggered ("Run learning now") — same work, no once-per-day
 *  guard, still skipped when the migration isn't applied. Never throws. */
export async function runLearningNow(ctxArg) {
  if (!(await migrationApplied())) return { skipped: 'migration-not-applied' };
  try {
    return await runLearningCore({ ctxArg });
  } catch (err) {
    console.error('donovan-learning: runLearningNow failed (non-fatal):', err?.message);
    return { error: err?.message };
  }
}

/** Nightly cron-sweep step (api/_lib/routes/cron-sweep.js), run AFTER the
 *  miss-digest step. Guarded to at most once per UTC day; never allowed to
 *  fail the sweep it's a step of. */
export async function runLearningSweepStep() {
  try {
    if (!(await migrationApplied())) return { skipped: 'migration-not-applied' };

    const today = new Date().toISOString().slice(0, 10);
    const founderTenantKey = process.env.DEEPWELL_FOUNDER_TENANT_ID;

    if (founderTenantKey) {
      let claimed;
      try {
        const { rows } = await getPool().query('SELECT claim_platform_daily_task($1,$2,$3) AS claimed', [
          founderTenantKey,
          TASK_KEY,
          today,
        ]);
        claimed = Boolean(rows[0]?.claimed);
      } catch (err) {
        console.warn('donovan-learning: claim_platform_daily_task failed:', err?.message);
        return { skipped: 'guard-unavailable' };
      }
      if (!claimed) return { skipped: 'already-ran-today' };
    } else {
      if (!shouldRunLearningToday(lastRunDateNoFounderTenant, today)) return { skipped: 'already-ran-today' };
      lastRunDateNoFounderTenant = today;
    }

    return await runLearningCore();
  } catch (err) {
    console.error('donovan-learning sweep step failed (non-fatal):', err?.message);
    return { error: err?.message };
  }
}
