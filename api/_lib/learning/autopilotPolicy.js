/**
 * TEAM H (2026-09-24): SAFE AUTO-PROMOTION / AUTO-DEMOTION policy for the
 * autonomous per-tenant learning loop. Pure — no DB, no model, no I/O —
 * extends learning/policy.js's existing decideRecipeStatus (never replaces
 * it: every existing rule it enforces — verification must pass, an
 * operator's approval always works, DONOVAN_AUTO_LEARN=off disables both
 * automatic routes — still applies unchanged here).
 */
import { decideRecipeStatus } from './policy.js';

/**
 * A recipe goes live automatically when EITHER of two independent pieces of
 * evidence confirms it:
 *   (a) the existing rule — the same normalized question produced the same
 *       result signature on two separate replays (`seen >= 2`), or a user's
 *       thumbs-up on top of one grounded run;
 *   (b) NEW — the replayed answer independently passed this tenant's own
 *       auto-generated-exam oracle for a matching template (`examMatch`).
 *       An oracle match is a SECOND, independently-computed answer agreeing
 *       with the agent's own SQL, which is at least as strong evidence as
 *       "the agent repeated itself twice" — so it is folded into the SAME
 *       `seen >= 2` bar rather than given a separate, weaker threshold.
 * Both routes still require: (i) verification passed (grounding/citations
 * present — decideRecipeStatus's own gate) and (ii) no thumbs-down is on
 * record for this question — a pending thumbs-down blocks auto-promotion
 * even when (a) or (b) would otherwise clear it; only an operator's explicit
 * approval can override a thumbs-down.
 * @param {{seen?: number, thumbsUp?: number, operatorApproved?: boolean, examMatch?: boolean, thumbsDown?: number}} evidence
 * @param {{ok: boolean, reasons?: string[]}} verification
 * @param {string|undefined} autoLearnRaw
 * @returns {{status: 'approved'|'auto_approved'|'auto_rejected'|'pending', reason: string|null}}
 */
export function decideAutopilotRecipeStatus({ seen = 0, thumbsUp = 0, operatorApproved = false, examMatch = false, thumbsDown = 0 } = {}, verification, autoLearnRaw) {
  if (thumbsDown > 0 && !operatorApproved) {
    return { status: 'pending', reason: 'a thumbs-down is on record for this question; a human must confirm it before it can go live again' };
  }
  const effectiveSeen = examMatch ? Math.max(seen, 2) : seen;
  return decideRecipeStatus({ seen: effectiveSeen, thumbsUp, operatorApproved }, verification, autoLearnRaw);
}

/**
 * Auto-DEMOTE: a LIVE recipe (or learned vocabulary item) is retired the
 * instant fresh evidence disagrees with it — never left live on stale
 * confidence. Pure: the caller (autopilot.js) does the actual
 * deactivateLearned()/tenant-overlay write when this returns a reason.
 * @param {{freshSignatureMatches?: boolean, oracleAgrees?: boolean, thumbsDown?: boolean}} evidence
 *   `freshSignatureMatches`/`oracleAgrees` are `undefined` when that check
 *   was not run this cycle (e.g. no matching exam template) — only an
 *   explicit `false` demotes; `undefined` is silently skipped.
 * @returns {string|null} the demotion reason, or null when nothing disagrees
 */
export function shouldAutoDemote({ freshSignatureMatches, oracleAgrees, thumbsDown } = {}) {
  if (thumbsDown) return 'thumbs-down';
  if (freshSignatureMatches === false) return 'a fresh agent run disagreed with the promoted answer';
  if (oracleAgrees === false) return 'the tenant auto-exam oracle now disagrees with this recipe';
  return null;
}

export const DEFAULT_MIN_VOCAB_COUNT = 3;
export const DEFAULT_MIN_VOCAB_DOCS = 2;

/**
 * Tenant-scoped vocabulary (synonym/abbreviation) auto-approval: verified
 * against the tenant's own pack + routing bank (`verification.ok`) AND seen
 * at least `minCount` times across at least `minDocs` distinct source
 * documents in this tenant's own corpus — the brief's "verified against the
 * routing bank + tenant corpus frequency threshold". Pure.
 * @param {{count?: number, docCount?: number}} evidence
 * @param {{ok: boolean, reasons?: string[]}} verification
 * @param {{minCount?: number, minDocs?: number}} [thresholds]
 * @returns {{status: 'active'|'pending'|'rejected', reason: string|null}}
 */
export function decideTenantVocabStatus({ count = 0, docCount = 0 } = {}, verification, { minCount = DEFAULT_MIN_VOCAB_COUNT, minDocs = DEFAULT_MIN_VOCAB_DOCS } = {}) {
  if (!verification || verification.ok !== true) {
    const reason = Array.isArray(verification?.reasons) && verification.reasons.length ? verification.reasons.join('; ') : 'verification failed';
    return { status: 'rejected', reason };
  }
  if (count >= minCount && docCount >= minDocs) return { status: 'active', reason: null };
  return { status: 'pending', reason: `needs ${minCount}+ occurrences across ${minDocs}+ documents (seen ${count} across ${docCount} so far)` };
}
