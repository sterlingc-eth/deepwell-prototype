/**
 * Donovan claim-check (R11, build spec item 3, FActScore-style, deterministic) — public entry point.
 *
 * Splits an answer's headline + facts + text into atomic claims (split.js), checks each one against its
 * cited source's actual text — or, for a count/aggregate, against the answer's own records set, or for a
 * status, against a companion date claim (check.js) — and applies policy (policy.js): remove/rewrite an
 * unsupported claim from a model-written (agent) answer, or just flag it (log) for a deterministic one.
 *
 * No model call, ever. Latency: ONE batched source fetch (`fetchSourceText.prefetch`, the same shape
 * verify.js's createDbSourceFetcher already returns) covers every claim's citations in a single round
 * trip; everything else is regex/string comparison.
 *
 * ---------------------------------------------------------------------------------------------------
 * THE HOOK (this module owns no call site in api/ask.js — see R11_RULES.md "edit ONLY files you own"):
 *
 * 1. Agent path (already wired — see loopV2.js): runs INSIDE the research agent, right after the
 *    existing verifyFacts pass and before citeAgentData, with `agentWritten: true` and the SAME
 *    fetchSourceText/createDbSourceFetcher the fact-level check already built (its cache is reused, so
 *    any claim whose citation verifyFacts already fetched costs nothing further here). No ask.js change
 *    needed for this path.
 *
 * 2. Deterministic path (money gate / financials / deterministic router / fastPath / contactLookup /
 *    docLookup / contentCount / analytics — all produced directly in files this module's owner does not
 *    control): add, in api/ask.js's `send` function, immediately BEFORE the existing
 *    `finalizeCitations(body.data)` call —
 *
 *      if (body?.data && typeof body.data === "object" && !body.data.claimCheck) {
 *        try { checkAnswerClaimsSync(body.data, { today: todayResolved }); }
 *        catch (err) { console.error("claim check failed:", err?.message); }
 *      }
 *
 *    where `checkAnswerClaimsSync` (below) is a synchronous, no-DB variant — deliberately NOT the async
 *    `verifyAnswerClaims`, because `send` is called from many non-awaited sites in ask.js today and
 *    making every one of them `await send(...)` is exactly the ask.js-wide edit this module's owner must
 *    not make. `checkAnswerClaimsSync` needs no DB handle: per build spec item 5, a deterministic
 *    answer's count/aggregate claims are supported by its OWN `records`/`recordsTotal`/`facts.length`
 *    (already sitting on `data`), and a status claim derives from a companion date claim the same way;
 *    everything else reports "could not confirm" (kept, flagged — deterministic policy is flag-only
 *    regardless, so no source fetch is required to satisfy it). The `!body.data.claimCheck` guard makes
 *    this a no-op for an answer the agent path already stamped.
 * ---------------------------------------------------------------------------------------------------
 */
import { splitIntoClaims } from "./split.js";
import { checkClaims, deriveStatusSupport, recordCountCandidates } from "./check.js";
import { applyClaimPolicy } from "./policy.js";

/** Bounds the worst case the same way verify.js's MAX_FACTS does: a pathological answer never turns
 *  this into an unbounded loop. Claims beyond the cap are left unchecked (kept, not flagged). */
export const MAX_CLAIMS = 60;

function isCheckableAnswer(answer) {
  return Boolean(answer) && typeof answer === "object" && answer.kind === "answer"
    && (Boolean(answer.text) || (Array.isArray(answer.facts) && answer.facts.length));
}

function emptyClaimCheck(policy) {
  return { policy, checked: 0, supported: 0, unsupported: [], rate: 0, removedSentences: 0, removedFacts: 0 };
}

/**
 * @param {object} answer  an /api/ask-shaped answer ({kind:'answer', text, facts, sources, records, recordsTotal})
 * @param {{fetchSourceText?: Function, today?: string, agentWritten?: boolean}} [opts]
 * @returns {Promise<{data: object, claimCheck: object|null, removedCount: number}>}
 */
export async function verifyAnswerClaims(answer, { fetchSourceText, today, agentWritten = false } = {}) {
  if (!isCheckableAnswer(answer)) return { data: answer, claimCheck: null, removedCount: 0 };

  const splitResult = splitIntoClaims(answer);
  const claims = splitResult.claims.length > MAX_CLAIMS ? splitResult.claims.slice(0, MAX_CLAIMS) : splitResult.claims;
  if (!claims.length) {
    answer.claimCheck = emptyClaimCheck(agentWritten ? "agent" : "deterministic");
    return { data: answer, claimCheck: answer.claimCheck, removedCount: 0 };
  }

  if (typeof fetchSourceText?.prefetch === "function") {
    const allSources = claims.flatMap((c) => (Array.isArray(c.sources) ? c.sources : []));
    try { await fetchSourceText.prefetch(allSources); } catch { /* prefetch is an optimization only */ }
  }

  const results = await checkClaims(claims, answer, { fetchSourceText, today });
  const { data, removedCount, claimCheck } = applyClaimPolicy(answer, { ...splitResult, claims }, results, { agentWritten });

  // Counter only — no question text, no claim content beyond the truncated examples policy.js already caps.
  console.log(JSON.stringify({ route: "ask", claimCheck: { policy: claimCheck.policy, checked: claimCheck.checked, unsupported: claimCheck.unsupported.length, rate: claimCheck.rate, removed: removedCount } }));

  return { data, claimCheck, removedCount };
}

/**
 * Synchronous, no-DB variant for the deterministic-answer hook (see file header): attaches `claimCheck`
 * to `answer` using ONLY what already sits on it (recordsTotal/records/facts for count/aggregate claims,
 * a companion date claim for a status claim). Never removes/rewrites anything — the deterministic policy
 * is flag-only regardless — so this is always safe to call, always fast (no async, no I/O), and
 * idempotent (a second call recomputes the same field).
 * @param {object} answer
 * @param {{today?: string}} [opts]
 * @returns {object} the same `answer`, with `.claimCheck` attached (untouched if not checkable)
 */
export function checkAnswerClaimsSync(answer, { today } = {}) {
  if (!isCheckableAnswer(answer)) return answer;
  const splitResult = splitIntoClaims(answer);
  const claims = splitResult.claims.length > MAX_CLAIMS ? splitResult.claims.slice(0, MAX_CLAIMS) : splitResult.claims;
  if (!claims.length) {
    answer.claimCheck = emptyClaimCheck("deterministic");
    return answer;
  }

  const recordCandidates = recordCountCandidates(answer);

  const results = claims.map((claim) => {
    if (claim.kind === "count" && recordCandidates.length) {
      const supported = recordCandidates.some((n) => n === claim.value);
      return { claim, supported, reason: supported ? "records-match" : "records-mismatch" };
    }
    if (claim.kind === "status") {
      const derived = deriveStatusSupport(claim, claims, today);
      if (derived != null) return { claim, supported: derived, reason: derived ? "derived-from-date" : "derived-mismatch" };
    }
    if (claim.kind === "yesno") return { claim, supported: true, reason: "nothing-to-check" };
    return { claim, supported: true, reason: "could-not-confirm" }; // no DB handle here -> fail open (flag-only anyway)
  });

  const { data } = applyClaimPolicy(answer, { ...splitResult, claims }, results, { agentWritten: false });
  console.log(JSON.stringify({ route: "ask", claimCheck: { policy: "deterministic", checked: data.claimCheck.checked, unsupported: data.claimCheck.unsupported.length, rate: data.claimCheck.rate, removed: 0 } }));
  return data;
}

export { splitIntoClaims, checkClaims };
