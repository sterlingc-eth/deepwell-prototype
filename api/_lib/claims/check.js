/**
 * Donovan claim-check (R11, build spec items 2 + 5) — is each atomic claim (split.js) actually
 * supported? Three independent, cheapest-first strategies, in priority order:
 *
 *   1. Counts/aggregates from a deterministic SQL path are supported by their OWN records set: a count
 *      claim is checked against `answer.recordsTotal` / `answer.records.length` / `answer.facts.length`
 *      (build spec item 5) — no DB round trip needed, since the answer already carries its own count.
 *   2. A status claim ("under warranty", "overdue") paired with an unambiguous expiry/due-date claim
 *      elsewhere in the SAME answer is derived and compared directly (also no round trip).
 *   3. Everything else is checked against its cited source's actual text via `fetchSourceText` (the
 *      exact same shape verify.js already defines: `(documentId, location) => Promise<string|null>`,
 *      with an optional `.prefetch(sources)` for one batched round trip — see index.js).
 *
 * Fails OPEN, same rule verify.js documents: a source that cannot be read (no fetchSourceText, a
 * transient DB error, an uncited claim) is "could not confirm", never "wrong" — a claim is only ever
 * marked unsupported when its own cited text was actually read and did not contain it. This is what the
 * build spec's "precision over recall" test asks for: never remove a claim we simply couldn't check.
 */
import { amountsEqual, amountTokenIn, wordTokenIn, nameSupportedIn } from "./normalize.js";
import { datesEqual, deriveStatus } from "./dates.js";
import { STATUS_VALUE_PHRASES } from "./split.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_CANDIDATE_RE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}/gi;

async function fetchAllTexts(sources, fetchSourceText) {
  if (typeof fetchSourceText !== "function" || !sources?.length) return [];
  const texts = [];
  for (const src of sources) {
    if (typeof src?.documentId !== "string" || !UUID_RE.test(src.documentId)) continue;
    if (src.location?.field === "document") continue; // whole-document citation: no one passage to check
    let t;
    // eslint-disable-next-line no-await-in-loop -- bounded by MAX_CLAIMS (index.js), and the fetcher's
    // own cache/.prefetch means repeat (documentId, location) pairs cost nothing extra.
    try { t = await fetchSourceText(src.documentId, src.location ?? {}); } catch { t = null; }
    if (t != null) texts.push(String(t));
  }
  return texts;
}

/** null = could not confirm either way (no text to check against). true/false = a real verdict. */
function checkAgainstTexts(claim, texts) {
  if (!texts.length) return null;
  const hay = texts.join("\n").toLowerCase();
  switch (claim.kind) {
    case "money":
    case "number":
    case "count":
      return amountTokenIn(hay, claim.raw);
    case "date": {
      const candidates = hay.match(DATE_CANDIDATE_RE) ?? [];
      if (!candidates.length) return null;
      return candidates.some((c) => datesEqual(c, claim.value ?? claim.raw));
    }
    case "name":
      return nameSupportedIn(hay, claim.raw);
    case "status": {
      // A source rarely repeats the exact claimed WORD ("active") — it says "under warranty" instead.
      // STATUS_VALUE_PHRASES maps the claimed value to every phrasing that means it; only when the value
      // isn't one of ours (a freeform status pulled straight off a fact's value, see split.js) do we fall
      // back to a bare word-boundary match on the value/raw text itself.
      const phrases = STATUS_VALUE_PHRASES[claim.value];
      if (phrases?.length) return phrases.some((re) => re.test(hay));
      return wordTokenIn(hay, String(claim.value)) || wordTokenIn(hay, String(claim.raw).toLowerCase());
    }
    default:
      return null;
  }
}

/** A status claim ("expired", "overdue") derived from an unambiguous date claim elsewhere in the same
 *  answer. Returns true/false when derivable, null when there is nothing (or too much ambiguity) to
 *  derive from — null falls through to the normal source-text check, it is never treated as "wrong". */
function deriveStatusSupport(statusClaim, allClaims, today) {
  if (!today) return null;
  const dateClaims = allClaims.filter((c) => c.kind === "date" && c !== statusClaim);
  if (!dateClaims.length) return null;
  const family = statusClaim.meta?.family === "invoice" ? "invoice" : "warranty";
  const matches = dateClaims
    .map((dc) => deriveStatus(family, dc.value, today))
    .filter((v) => v != null);
  if (!matches.length) return null;
  if (matches.some((v) => v === statusClaim.value)) return true;
  // Every candidate date disagrees with the claimed status, AND there is exactly one date in the whole
  // answer to be confused about — an unambiguous, checkable mismatch.
  if (dateClaims.length === 1) return false;
  return null; // several dates present: can't tell which one the status refers to (precision over recall)
}

/**
 * The "true count" figures a count/aggregate claim can be checked against (build spec item 5) — but
 * only ones the answer's producer actually SET, never an empty array's incidental zero: an answer with
 * no structured `facts` at all (a pure prose answer) must not make every stray number in its text look
 * like a "0 vs N" mismatch just because `facts.length === 0` happened to be a candidate.
 */
export function recordCountCandidates(answer) {
  const out = [];
  if (Number.isFinite(answer?.recordsTotal)) out.push(answer.recordsTotal);
  if (Array.isArray(answer?.records) && answer.records.length) out.push(answer.records.length);
  if (Array.isArray(answer?.facts) && answer.facts.length) out.push(answer.facts.length);
  return out;
}

/**
 * @param {object[]} claims  from split.js's splitIntoClaims
 * @param {object} answer  the /api/ask-shaped answer (for recordsTotal/records/facts.length)
 * @param {{fetchSourceText?: Function, today?: string}} opts
 * @returns {Promise<{claim:object, supported:boolean, reason:string}[]>}
 */
export async function checkClaims(claims, answer, { fetchSourceText, today } = {}) {
  const recordCandidates = recordCountCandidates(answer);

  const results = [];
  for (const claim of claims) {
    if (claim.kind === "yesno") {
      results.push({ claim, supported: null, reason: "pending-sibling" });
      continue;
    }

    if (claim.kind === "count" && recordCandidates.length) {
      const supported = recordCandidates.some((n) => n === claim.value);
      results.push({ claim, supported, reason: supported ? "records-match" : "records-mismatch" });
      continue;
    }

    if (claim.kind === "status") {
      const derived = deriveStatusSupport(claim, claims, today);
      if (derived != null) {
        results.push({ claim, supported: derived, reason: derived ? "derived-from-date" : "derived-mismatch" });
        continue;
      }
    }

    // eslint-disable-next-line no-await-in-loop -- sequential on purpose; see file header (bounded, cached).
    const texts = await fetchAllTexts(claim.sources, fetchSourceText);
    const checked = checkAgainstTexts(claim, texts);
    results.push(
      checked == null
        ? { claim, supported: true, reason: "could-not-confirm" }
        : { claim, supported: checked, reason: checked ? "source-match" : "source-mismatch" }
    );
  }

  // Resolve yes/no claims now that every sibling in the same sentence has a real verdict: a leading
  // "Yes"/"No" is only as trustworthy as whatever it is agreeing with.
  for (const r of results) {
    if (r.reason !== "pending-sibling") continue;
    const siblings = results.filter((o) => o.claim !== r.claim && o.claim.sentenceIndex === r.claim.sentenceIndex && o.claim.kind !== "yesno");
    r.supported = siblings.length ? siblings.every((o) => o.supported !== false) : true; // nothing to check -> fail open
    r.reason = siblings.length ? (r.supported ? "sibling-supported" : "sibling-unsupported") : "nothing-to-check";
  }

  return results;
}

export { amountsEqual, deriveStatusSupport };
