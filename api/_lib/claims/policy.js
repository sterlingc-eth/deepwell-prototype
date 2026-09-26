/**
 * Donovan claim-check (R11, build spec item 3) — policy: what to DO with an unsupported claim.
 *
 *   model-written (agent) answers -> remove the claim: drop the sentence it came from out of `text`,
 *     or drop the fact it came from out of `facts` — the reader never sees an unconfirmed statement.
 *   deterministic answers        -> flag only (log/report), never rewritten: a deterministic answer's
 *     numbers are computed straight from SQL, so a "miss" here is a citation/lookup gap to fix upstream,
 *     not a hallucination to hide from the reader who is already looking at real records.
 *
 * Either way the answer gets one new field: `claimCheck` ({supported, unsupported[], rate, ...}) — never
 * a new UI surface; the existing facts/sources/records rendering already shows everything that survives.
 */

function summarize(r) {
  return { kind: r.claim.kind, claim: String(r.claim.raw).slice(0, 60), origin: r.claim.origin, reason: r.reason };
}

/**
 * @param {object} answer  the /api/ask-shaped answer split.js/check.js just ran over
 * @param {{claims:object[], sentences:string[]}} splitResult  from splitIntoClaims
 * @param {{claim:object, supported:boolean, reason:string}[]} results  from checkClaims
 * @param {{agentWritten?: boolean}} opts
 * @returns {{data: object, removedCount: number, claimCheck: object}}
 */
export function applyClaimPolicy(answer, splitResult, results, { agentWritten = false } = {}) {
  const { sentences } = splitResult;
  const unsupported = results.filter((r) => r.supported === false);
  const checked = results.length;
  const rate = checked ? Math.round((unsupported.length / checked) * 1000) / 1000 : 0;

  let data = answer;
  let removedSentences = 0;
  let removedFacts = 0;

  if (agentWritten && unsupported.length) {
    const dropSentenceIdx = new Set(
      unsupported.filter((r) => r.claim.origin !== "fact" && r.claim.sentenceIndex != null).map((r) => r.claim.sentenceIndex)
    );
    const dropFactIdx = new Set(
      unsupported.filter((r) => r.claim.origin === "fact" && r.claim.factIndex != null).map((r) => r.claim.factIndex)
    );

    if (dropSentenceIdx.size || dropFactIdx.size) {
      let nextText = answer.text;
      if (dropSentenceIdx.size) {
        const kept = sentences.filter((_, i) => !dropSentenceIdx.has(i));
        removedSentences = sentences.length - kept.length;
        nextText = kept.join(" ").trim();
      }
      let nextFacts = Array.isArray(answer.facts) ? answer.facts : [];
      if (dropFactIdx.size) {
        const kept = nextFacts.filter((_, i) => !dropFactIdx.has(i));
        removedFacts = nextFacts.length - kept.length;
        nextFacts = kept;
      }

      const hasContent = Boolean(nextText) || nextFacts.length > 0;
      if (!hasContent) {
        data = {
          ...answer, kind: "no-answer",
          text: "Nothing in your records could be confirmed for that.",
          facts: [], sources: [], confidence: 0, closest: answer.closest ?? [],
        };
      } else {
        const shown = nextText || "See the details below.";
        data = {
          ...answer,
          text: `${shown.replace(/[.\s]+$/, "")} (one or more claims could not be confirmed and were left out).`,
          facts: nextFacts,
          sources: nextFacts.flatMap((f) => (Array.isArray(f?.sources) ? f.sources : [])),
        };
      }
    }
  }

  const claimCheck = {
    policy: agentWritten ? "agent" : "deterministic",
    checked,
    supported: checked - unsupported.length,
    unsupported: unsupported.slice(0, 8).map(summarize),
    rate,
    removedSentences,
    removedFacts,
  };
  data.claimCheck = claimCheck;

  return { data, removedCount: removedSentences + removedFacts, claimCheck };
}
