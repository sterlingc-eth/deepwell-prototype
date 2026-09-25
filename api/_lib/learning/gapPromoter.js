/**
 * Donovan self-learning loop, Workstream A item 2: the GAP PROMOTER.
 *
 * WHY: gapReport.js's weekly cross-tenant clusters (learning/gapReport.js clusterFailures) are, today,
 * informational only — a human reads them and writes a fix by hand. This file turns a cluster with
 * ENOUGH evidence (seen at more than one shop, more than a couple of times) into a candidate
 * synonym/few_shot proposal, ONE Haiku call per cluster (the EXISTING proposer model pass — same
 * client, same model, same PROPOSAL_TOOL schema, same cost order of magnitude — reused via
 * proposer.js's callModelForCluster, not reinvented here), validated exactly like every other proposal
 * (proposals.js validateProposal, verify.js verifyProposalLive against the live routing bank), then
 * inserted as an ordinary PENDING donovan_proposals row. Promotion itself — the only thing that may
 * actually activate it — is examGate.js's job alone; this file never decides a proposal.
 *
 * A cluster whose capability tag is itself a dead end (gapReport.js's own "read the examples, no
 * pattern found yet" categories: scorecard-other/other/no-answer/user-corrected) is never sent to the
 * model at all — NEVER_ACTIONABLE below filters those out before spending a call on them. The model's
 * OWN tool schema (proposer.js's PROPOSAL_TOOL) can still answer kind='capability_gap' for a cluster
 * that WAS worth trying — that answer is treated exactly like "found nothing generalizable" (never
 * inserted as a proposal), since proposals.js's own doc comment is explicit that kind is
 * informational-only by design.
 *
 * Cap 5 clusters per run (MAX_CLUSTERS_PER_RUN) — nightly and operator "Run learning now" alike.
 */
import { clusterFailures } from './gapReport.js';
import { validateProposal } from './proposals.js';
import { verifyProposalLive } from './verify.js';
import { callModelForCluster, payloadFromModelInput, LEARN_MODEL } from './proposer.js';
import { estimateCostUsd } from '../usage.js';
import * as store from './store.js';

export const MAX_CLUSTERS_PER_RUN = 5;
// "enough evidence": seen at more than one shop (never a single shop's own quirk generalized to
// everyone) and more than a couple of times overall — the same order-of-magnitude bar policy.js's own
// MIN_TENANT_COUNT_FOR_AUTO/MIN_COUNT_FOR_AUTO use for a single proposal, applied here to a cluster.
export const MIN_CLUSTER_COUNT = 3;
export const MIN_CLUSTER_TENANTS = 2;

// Capability tags clusterFailures can produce that are NEVER worth a model call: capability_gap's own
// informational-only tags, plus the two catch-alls gapReport.js uses for "no pattern found yet, a human
// should read the individual examples" (scorecard-other, other) and the two that are corrective/
// diagnostic rather than a missing WORD or PLAN (no-answer: the corpus may genuinely lack the data;
// user-corrected: a human already needs to look at this one, not have a guess synthesized for it).
const NEVER_ACTIONABLE = new Set(['scorecard-other', 'other', 'no-answer', 'user-corrected']);

/**
 * Clusters worth a model call: enough evidence, seen across more than one shop, at least two distinct
 * example questions to generalize FROM (one example is not a pattern), and not one of the
 * never-actionable capability tags above. Pure, exported for tests.
 */
export function clustersWorthPromoting(clusters) {
  return (Array.isArray(clusters) ? clusters : []).filter(
    (c) => c && !NEVER_ACTIONABLE.has(c.capability) && Number(c.count) >= MIN_CLUSTER_COUNT
      && Number(c.tenantCount) >= MIN_CLUSTER_TENANTS && Array.isArray(c.examples) && c.examples.length >= 2
  );
}

/**
 * One cluster -> one candidate proposal, or a reason it produced none. Never throws.
 * @param {{capability: string, examples: string[]}} cluster
 * @param {{callModel?: Function}} [opts]  injectable for tests (default: proposer.js's real Haiku call)
 * @returns {Promise<{capability: string, kind: string|null, payload: object|null, valid: boolean, reason: string|null, costUsd: number, examples?: string[], verification?: object}>}
 */
export async function synthesizeProposalForCluster(cluster, { callModel = callModelForCluster } = {}) {
  const capability = cluster?.capability ?? 'other';
  const examples = (cluster?.examples ?? []).slice(0, 5);
  if (examples.length < 2) return { capability, kind: null, payload: null, valid: false, reason: 'not enough distinct examples to generalize from', costUsd: 0 };

  const result = await callModel(capability, examples);
  if (result?.skipped) {
    return { capability, kind: null, payload: null, valid: false, reason: `model call skipped/failed: ${result.skipped}`, costUsd: 0 };
  }
  const costUsd = estimateCostUsd(result.usage);
  const rawKind = result.raw?.kind;
  if (!rawKind || rawKind === 'capability_gap') {
    return { capability, kind: null, payload: null, valid: false, reason: 'model found no generalized fix', costUsd };
  }
  if (rawKind === 'abbreviation' || rawKind === 'typo') {
    return { capability, kind: null, payload: null, valid: false, reason: `cluster proposer may only generalize a synonym/few_shot (got ${rawKind})`, costUsd };
  }

  const payload = payloadFromModelInput(rawKind, result.raw);
  const v = validateProposal(rawKind, payload);
  if (!v.ok) return { capability, kind: rawKind, payload, valid: false, reason: v.reason, costUsd };

  // The SAME second gate every other proposal goes through before it is ever stored (verify.js's own
  // doc comment): a generalized synonym/few_shot could still corrupt the routing bank even though it
  // schema-validated cleanly.
  const verification = verifyProposalLive(v.proposal, { missQuestions: examples });
  if (!verification.ok) {
    return { capability, kind: v.proposal.kind, payload: v.proposal.payload, valid: false, reason: verification.reasons.join('; '), costUsd, verification };
  }
  return { capability, kind: v.proposal.kind, payload: v.proposal.payload, valid: true, reason: null, costUsd, verification, examples };
}

/**
 * The whole pass: gap-report clusters -> up to `maxClusters` candidate proposals, each inserted as a
 * PENDING donovan_proposals row carrying its cluster evidence (capability, the examples it was
 * generalized from) so a later reviewer — or examGate.js's own promotePendingWithExamGate — can see
 * where it came from. Never decides a proposal itself.
 * @param {Array} clusters  gapReport.js's clusterFailures() output (or a stored report's own `.clusters`)
 * @param {{callModel?: Function, maxClusters?: number}} [opts]
 */
export async function proposeFixesForClusters(clusters, { callModel, maxClusters = MAX_CLUSTERS_PER_RUN } = {}) {
  const worth = clustersWorthPromoting(clusters).slice(0, Math.max(0, maxClusters));
  const summary = { attempted: 0, proposed: 0, rejected: 0, costUsd: 0, proposals: [] };

  for (const cluster of worth) {
    summary.attempted++;
    const r = await synthesizeProposalForCluster(cluster, callModel ? { callModel } : {});
    summary.costUsd = Math.round((summary.costUsd + (r.costUsd ?? 0)) * 10000) / 10000;
    if (!r.valid) {
      summary.rejected++;
      summary.proposals.push({ capability: r.capability, kind: r.kind, valid: false, reason: r.reason });
      continue;
    }
    const id = await store.insertProposal({
      kind: r.kind,
      payload: r.payload,
      evidence: { source: 'gap-report', capability: r.capability, examples: r.examples },
      verification: r.verification ?? {},
      status: 'pending',
      reason: null,
    });
    if (!id) { summary.rejected++; summary.proposals.push({ capability: r.capability, kind: r.kind, valid: false, reason: 'store unavailable' }); continue; }
    summary.proposed++;
    summary.proposals.push({ id, capability: r.capability, kind: r.kind, valid: true });
  }

  if (summary.attempted) {
    console.log(`donovan-gap-promoter: ${summary.attempted} cluster(s) tried, ${summary.proposed} proposed, ${summary.rejected} rejected, est. cost $${summary.costUsd.toFixed(4)} (model=${LEARN_MODEL}).`);
  }
  return summary;
}

// Re-exported for callers that already have a raw failure-row list rather than pre-clustered output
// (gapReport.js's own clusterFailures, kept as the single source of truth for how rows -> clusters).
export { clusterFailures };
