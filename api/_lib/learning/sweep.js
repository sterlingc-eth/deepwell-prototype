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
import { getPool, withTenant } from '../recordsStore.js';
import { getProviderOutage } from '../claude.js';
import { buildMissDigest } from '../missDigest.js';
import { proposeFixesForMisses } from './proposer.js';
import { verifyProposalLive } from './verify.js';
import { decidePolicyStatus } from './policy.js';
import * as store from './store.js';
import { replayMisses, autoResolveCapabilityGaps } from './replay.js';
import { runExamGatedLearningPass } from './examGate.js';

const TASK_KEY = 'donovan-learning';

/** R7 learning-quality guardrail (coordinator ask, 2026-09-25): every distinct word appearing in a
 *  customer name or a technician name on file, lower-cased — fed to verify.js's
 *  proposalShadowsEntityName so a learned abbreviation/typo can never quietly rewrite a real name
 *  (the bug report: typo "vega" -> "vegas" would have corrupted the real customer surname "Vega").
 *  Tenant-scoped (withTenant — the same safe, RLS-respecting read every other entity query in this
 *  codebase uses), against the SAME founder/operator tenant this whole loop already runs its
 *  exam-gate/replay steps against — never a cross-tenant, RLS-bypassing read. Best-effort: any
 *  failure (no tenant, migration/table issue) yields an empty Set, i.e. this guard simply does not
 *  fire rather than blocking every proposal. Small and self-contained rather than shared with
 *  learning/examGate.js's own copy — same "duplicate a handful of lines rather than widen a file's
 *  surface" idiom this whole directory already uses (proposals.js/proposer.js's own doc comments).
 */
async function loadEntityNameTokens(ctxArg) {
  const ctx = ctxArg ?? (process.env.DEEPWELL_FOUNDER_TENANT_ID
    ? { tenantKey: process.env.DEEPWELL_FOUNDER_TENANT_ID, tenantName: process.env.DEEPWELL_FOUNDER_TENANT_ID }
    : null);
  if (!ctx?.tenantKey) return new Set();
  try {
    return await withTenant(ctx, async (db) => {
      const [{ rows: custRows }, { rows: techRows }] = await Promise.all([
        db.raw("SELECT data->>'customer_name' AS name FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL LIMIT 5000", []),
        db.raw("SELECT DISTINCT COALESCE(NULLIF(corrected_value, ''), value) AS name FROM extractions WHERE field_key = 'technician' LIMIT 2000", []),
      ]);
      const tokens = new Set();
      for (const r of [...custRows, ...techRows]) {
        for (const w of String(r.name ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
          if (w.length >= 2) tokens.add(w);
        }
      }
      return tokens;
    });
  } catch (err) {
    console.warn('donovan-learning: could not load entity name tokens for the shadow guard (non-fatal):', err?.message);
    return new Set();
  }
}

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
  // ROUND 14 (brief item 4, owner: "71 pending" / "Run learning now does nothing"): capability_gap
  // proposals are informational-only by policy (policy.js line ~71) and sit pending FOREVER unless
  // something explicitly re-checks their example question — replayMisses above only re-runs OPEN
  // MISSES (ask_misses), never the proposal queue, which is why the button never touched them before.
  let gapAutoResolve = { skipped: 'no-founder-tenant' };
  if (replayCtx) {
    try {
      replay = await replayMisses({ ctxArg: replayCtx, source: ctxArg ? 'run-now' : 'nightly', callModel });
    } catch (err) {
      console.error('donovan-learning: replay failed (non-fatal):', err?.name);
      replay = { error: 'replay-failed' };
    }
    try {
      gapAutoResolve = await autoResolveCapabilityGaps({ ctxArg: replayCtx });
    } catch (err) {
      console.error('donovan-learning: capability-gap auto-resolve failed (non-fatal):', err?.name);
      gapAutoResolve = { error: 'auto-resolve-failed' };
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
  summary.gapAutoResolve = gapAutoResolve;
  // ROUND 14 (brief item 3: "the loop must skip model steps and say 'AI credits exhausted — learning
  // paused' instead of silently doing nothing"): checked AFTER the replay/gap-resolve steps above (both
  // already skip their own model calls once they hit the outage — see replay.js) so this is an honest
  // status message, not a guess made before anything actually ran.
  if (getProviderOutage()) {
    summary.providerStatus = 'AI credits exhausted — learning paused';
  }
  if (!missGroups.length) return { ...summary, skipped: 'no-new-misses' };

  if (getProviderOutage()) {
    // The proposer (proposer.js) makes its own Haiku calls to draft typo/synonym/few-shot fixes from
    // this run's miss groups — with the provider down every one of those would fail the exact same
    // way replay/gap-resolve just did. Skip the whole model-billed step rather than spending the
    // deadline on calls that cannot succeed, and say so plainly instead of silently proposing nothing.
    return { ...summary, skipped: 'provider-unavailable' };
  }

  const maxModelCalls = Number(process.env.DONOVAN_LEARN_MAX_CALLS) || 20;
  const { proposals, modelCallsMade, estimatedCostUsd } = await proposeFixesForMisses(missGroups, { maxModelCalls });
  summary.modelCallsMade = modelCallsMade;
  summary.estimatedCostUsd = estimatedCostUsd;

  // R7 guardrail: only worth the query when at least one fresh candidate could actually use it
  // (an abbreviation/typo — the only kinds proposalShadowsEntityName ever checks).
  const nameTokens = proposals.some((p) => p.valid && (p.kind === 'abbreviation' || p.kind === 'typo'))
    ? await loadEntityNameTokens(ctxArg)
    : new Set();

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
        { missQuestions: p.evidence?.questions ?? [], nameTokens }
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
 *  guard, still skipped when the migration isn't applied. Never throws.
 *
 *  Workstream A: ALSO runs the exam-gated learning pass exactly once here
 *  (gapPromoter.js's cross-tenant cluster proposals, then examGate.js's own
 *  promotePendingWithExamGate over every eligible PENDING proposal, old or
 *  new) — never inside runLearningCore/runLearningSweepStep, so the nightly
 *  cron's own once-per-day 'donovan-learning' step never ALSO runs it (the
 *  nightly path is autopilot.js's runAutopilotSweepStep instead — see that
 *  file's own doc comment); a pending item is never evaluated (or billed)
 *  twice in the one run this button starts. */
export async function runLearningNow(ctxArg) {
  if (!(await migrationApplied())) return { skipped: 'migration-not-applied' };
  try {
    const core = await runLearningCore({ ctxArg });
    const gateCtx = ctxArg ?? (process.env.DEEPWELL_FOUNDER_TENANT_ID
      ? { tenantKey: process.env.DEEPWELL_FOUNDER_TENANT_ID, tenantName: process.env.DEEPWELL_FOUNDER_TENANT_ID }
      : null);
    if (gateCtx) {
      try {
        core.examGatedLearning = await runExamGatedLearningPass(gateCtx);
      } catch (err) {
        console.error('donovan-learning: exam-gated learning pass failed (non-fatal):', err?.message);
        core.examGatedLearning = { error: err?.message };
      }
    }
    return core;
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
