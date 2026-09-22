/**
 * Donovan self-learning loop, Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md):
 * the decision policy — pure, no DB, no model, no I/O — that turns one
 * proposal's verification result plus its evidence counts into a lifecycle
 * status. Called from both api/_lib/learning/sweep.js (the nightly run) and
 * api/review.js's learningDecide (an operator's manual approve, which
 * re-verifies first — see that action's own doc comment) so the SAME rule
 * ("did verification pass, and does policy allow auto-approving this kind")
 * decides both cases identically.
 *
 * DONOVAN_AUTO_LEARN (env, values 'off' | 'vocab' | 'all', default 'vocab'):
 *   'off'   — verification can still auto-reject a bad proposal, but nothing
 *             is ever auto-approved; every kind that would otherwise qualify
 *             stays 'pending' for a human.
 *   'vocab' — typo/abbreviation may auto-approve (the two kinds a bad
 *             routing-bank regression would already have caught — see
 *             verify.js); synonym/few_shot/capability_gap always stay
 *             'pending' (a synonym adds a genuinely NEW word, and a few_shot
 *             teaches the planner a new pattern — both worth a human glance).
 *   'all'   — synonym/few_shot may also auto-approve. capability_gap is
 *             informational only and is NEVER auto-approved by any policy
 *             value (see proposals.js's own doc comment — it never becomes an
 *             overlay entry regardless).
 *
 * A proposal whose verification FAILED (ok:false) is always 'auto_rejected',
 * regardless of policy or kind — policy only ever decides among the
 * proposals verification already cleared.
 */

export const AUTO_LEARN_VALUES = ['off', 'vocab', 'all'];
export const DEFAULT_AUTO_LEARN = 'vocab';

/** Coerces any raw value (an env string, undefined, garbage) to one of the
 *  three recognized policy values, defaulting to 'vocab' — never throws, and
 *  an unrecognized value is treated exactly like "unset" rather than as an
 *  error, so a typo'd env var fails toward the SAFER (still human-reviewed
 *  for vocab, never auto for synonym/few_shot) default instead of failing
 *  open into 'all'. */
export function parseAutoLearnPolicy(raw) {
  return AUTO_LEARN_VALUES.includes(raw) ? raw : DEFAULT_AUTO_LEARN;
}

/** The minimum evidence bar a typo/abbreviation proposal needs before policy
 *  will even consider auto-approving it — seen by more than one shop (or the
 *  same shop more than once) is the brief's own bar for "this isn't a
 *  one-off fat-finger", not a judgement call this function invents. */
const MIN_TENANT_COUNT_FOR_AUTO = 1;
const MIN_COUNT_FOR_AUTO = 2;

/**
 * @param {{kind: string, tenantCount?: number, count?: number}} evidence
 * @param {{ok: boolean, reasons?: string[]}} verification  result of
 *        verifyProposal/verifyProposalLive against the CURRENT vocabulary —
 *        always re-run immediately before calling this, never a cached one.
 * @param {string|undefined} autoLearnRaw  raw DONOVAN_AUTO_LEARN value (or
 *        process.env.DONOVAN_AUTO_LEARN when the caller omits it)
 * @returns {{status: 'auto_rejected'|'auto_approved'|'pending', reason: string|null}}
 */
export function decidePolicyStatus({ kind, tenantCount = 0, count = 0 } = {}, verification, autoLearnRaw) {
  if (!verification || verification.ok !== true) {
    const reasons = Array.isArray(verification?.reasons) && verification.reasons.length
      ? verification.reasons.join('; ')
      : 'verification failed';
    return { status: 'auto_rejected', reason: reasons };
  }

  const policy = parseAutoLearnPolicy(autoLearnRaw !== undefined ? autoLearnRaw : process.env.DONOVAN_AUTO_LEARN);

  // Informational only, whatever the policy — see proposals.js's own doc
  // comment (rowsToOverlay ignores this kind even if a learned row existed).
  if (kind === 'capability_gap') return { status: 'pending', reason: null };

  if (kind === 'typo' || kind === 'abbreviation') {
    const meetsBar = tenantCount >= MIN_TENANT_COUNT_FOR_AUTO && count >= MIN_COUNT_FOR_AUTO;
    if (policy !== 'off' && meetsBar) return { status: 'auto_approved', reason: null };
    return { status: 'pending', reason: null };
  }

  if (kind === 'synonym' || kind === 'few_shot') {
    if (policy === 'all') return { status: 'auto_approved', reason: null };
    return { status: 'pending', reason: null };
  }

  // Unknown kind should never reach here (validateProposal already rejects
  // it upstream) — fail toward the safest option, a human decides.
  return { status: 'pending', reason: null };
}
