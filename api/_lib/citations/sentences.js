/**
 * Donovan sentence-level citations (R13H1, build spec item 1 — Anthropic Citations / Perplexity /
 * NotebookLM pattern: every sentence of an answer shows which document supports it).
 *
 * Deterministic, no model call. Reuses the R11 claim-check split (api/_lib/claims/split.js) to break
 * the answer's `text` into sentences and atomic claims (money/count/date/status/name), then attributes
 * each SENTENCE-origin claim (a fact-origin claim already has its own source shown via the facts panel/
 * SourceChip — this module is only about the free-form `text`) to a source:
 *
 *   1. Cross-match against a FACT carrying the same kind+value: facts are usually the more specifically
 *      sourced restatement of the same figure ("Balance due: $420.00" with its own [inv1 p.1]), so a
 *      sentence claim that matches one borrows that fact's sources at high confidence (score 0.9).
 *   2. Otherwise fall back to whatever generic source list split.js gave the claim (score 0.5) — the
 *      whole answer's `sources`, since split.js does not know in advance which one specifically backs
 *      a given sentence.
 *   3. A sentence with NO claim at all (a connective, "Here is what I found") still gets a citation, at
 *      a low score (0.3), ONLY when the whole answer cites exactly one document — anything more and the
 *      attribution would be a guess, so it is left uncited instead (precision over recall, the same rule
 *      claims/check.js already applies).
 *
 * A sentence that matches nothing gets `citations: []` and `supported: false` — NEVER an invented
 * citation. `answer.sentences = [{text, citations, supported}]` is purely additive; nothing else on the
 * answer is read from or written to by this module.
 *
 * Quote: `citations[].quote` is only ever a byte-for-byte substring of real source text — never
 * fabricated from a fact's formatted value. Real source text requires a DB round trip
 * (`fetchSourceText`, the same `(documentId, location) => Promise<string|null>` shape verify.js/
 * claims/check.js already use), so there are two entry points:
 *
 *   attachSentenceCitationsSync(answer)          no I/O, <1ms — used by the hook below. Attribution
 *                                                 only (documentId/page/score); `quote` omitted.
 *   attachSentenceCitations(answer, {fetchSourceText})   async, batches ONE fetch per distinct
 *                                                 (documentId, page) via `.prefetch` — adds real quotes.
 *
 * ---------------------------------------------------------------------------------------------------
 * THE HOOK:
 *
 * 1. Deterministic path (every answer, agent-written or not) — already wired: api/ask.js's `send`
 *    calls `attachSentenceCitationsSync` right next to its existing `checkAnswerClaimsSync` call, so
 *    every response carries `sentences` with at least document/page attribution, at zero DB cost.
 *
 * 2. Agent path, for real quotes — NOT wired here (this module owns no call site in agent/loopV2.js,
 *    same rule R11_RULES.md gives claims/index.js). loopV2.js already awaits, right where its own claim
 *    check runs:
 *
 *      const { data, claimCheck } = await verifyAnswerClaims(shaped.data, { fetchSourceText: claimFetcher, today, agentWritten: true });
 *
 *    Adding, immediately after that line —
 *
 *      try { await attachSentenceCitations(data, { fetchSourceText: claimFetcher }); }
 *      catch (err) { console.error("attachSentenceCitations failed:", err?.message); }
 *
 *    — reuses the SAME `claimFetcher` (and its warm per-request cache from verifyAnswerClaims's own
 *    prefetch) for real, verbatim quotes on every model-written sentence. `attachSentenceCitations`
 *    itself checks `answer.sentences != null` first, so calling it after the sync hook already ran is
 *    always a safe, idempotent no-op upgrade, never a double-attach.
 * ---------------------------------------------------------------------------------------------------
 */
import { splitIntoClaims, STATUS_VALUE_PHRASES } from "../claims/split.js";
import { amountsEqual, namesMatch, nameSupportedIn } from "../claims/normalize.js";
import { datesEqual } from "../claims/dates.js";
import { UUIDISH } from "./records.js";

const MAX_SENTENCE_CLAIMS = 60; // same order as claims/index.js's MAX_CLAIMS — an independent bound.
const MAX_QUOTE_LEN = 200;

function isCheckableAnswer(answer) {
  return Boolean(answer) && typeof answer === "object" && answer.kind === "answer"
    && (Boolean(answer.text) || (Array.isArray(answer.facts) && answer.facts.length));
}

/** Does this fact restate the same value a sentence claim asserts? Kind-specific, format-tolerant
 *  (money/date already normalize across formats via normalize.js/dates.js). */
function factMatchesClaim(fact, claim) {
  if (!fact || typeof fact !== "object") return false;
  const value = fact.value;
  switch (claim.kind) {
    case "money":
    case "number":
      return amountsEqual(String(value ?? ""), claim.raw);
    case "count":
      return Number(value) === claim.value;
    case "date":
      return datesEqual(String(value ?? ""), claim.value ?? claim.raw);
    case "status": {
      const v = String(value ?? "").toLowerCase();
      const phrases = STATUS_VALUE_PHRASES[claim.value];
      if (phrases?.length && phrases.some((re) => re.test(v))) return true;
      return v.includes(String(claim.value ?? "").toLowerCase());
    }
    case "name":
      return namesMatch(String(claim.value ?? claim.raw), String(value ?? ""));
    default:
      return false;
  }
}

// (R13H2 reviewer fix) Two facts about DIFFERENT entities/documents can share the same value ("$100.00"
// balance due for two different customers; "Active" warranty status for two different units) — picking
// the FIRST match regardless of whose fact it is would silently borrow the wrong customer's document.
// A fact's "identity" is its entityId when it has one, else the set of documents its own sources cite.
const IDENTITY_LABEL_RE = /customer|contact|owner|name|address|invoice|serial|model|unit|property/i;

function factGroupKey(fact) {
  if (fact?.entityId) return `e:${fact.entityId}`;
  const docIds = [...new Set((Array.isArray(fact?.sources) ? fact.sources : []).map((s) => s?.documentId).filter(Boolean))].sort();
  return `d:${docIds.join(",")}`;
}

/** Every OTHER fact sharing this same identity (same entityId, or the same document set) whose label
 *  looks like something a sentence would actually name — a customer, an address, an invoice/serial/
 *  model number — collected as literal strings to search for in the sentence itself. */
function identityTokensForGroup(groupKey, facts) {
  const tokens = new Set();
  for (const f of facts) {
    if (!f || typeof f !== "object" || factGroupKey(f) !== groupKey) continue;
    if (IDENTITY_LABEL_RE.test(String(f.label ?? "")) && typeof f.value === "string" && f.value.trim()) {
      tokens.add(f.value.trim());
    }
  }
  return [...tokens];
}

/** Which group(s) does `hay` name, by fuzzy/word match against each group's own identity tokens?
 *  May return 0 (named nothing), 1 (resolved), or 2+ (named more than one — still ambiguous). */
function namedGroups(groups, facts, hay) {
  const lower = String(hay ?? "").toLowerCase();
  const winners = [];
  for (const key of groups.keys()) {
    const tokens = identityTokensForGroup(key, facts);
    if (tokens.some((t) => lower.includes(t.toLowerCase()) || nameSupportedIn(hay, t))) winners.push(key);
  }
  return winners;
}

/**
 * {sources, specific}: `specific: true` when these sources came from a cross-matched fact (higher
 * confidence a specific source backs this specific sentence) rather than the answer's generic pool.
 *
 * Gathers EVERY fact matching the claim's value, groups them by which entity/document they actually
 * belong to (factGroupKey), and only borrows a fact's sources when that attribution is unambiguous:
 * either every match belongs to the SAME group, or the sentence itself — or, failing that, the one
 * right before it (a pronoun-continuation case: "...under warranty. It was serviced last week.") —
 * names something that identifies exactly one candidate group. Two or more groups left standing (or
 * zero named at all) is a real ambiguity, not a guess to paper over: the claim gets NO fact-sourced
 * match, and (since its generic source pool is checked separately by the caller) ends up with no
 * citation at all rather than an invented one.
 */
function sourcesForClaim(claim, facts, sentences) {
  const matches = facts.filter((f) => Array.isArray(f?.sources) && f.sources.length && factMatchesClaim(f, claim));
  if (!matches.length) return { sources: Array.isArray(claim.sources) ? claim.sources : [], specific: false };

  const groups = new Map(); // groupKey -> sources[]
  for (const f of matches) {
    const key = factGroupKey(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...f.sources);
  }
  if (groups.size === 1) return { sources: [...groups.values()][0], specific: true };

  const currentText = claim.sentenceText ?? "";
  let winners = namedGroups(groups, facts, currentText);
  if (winners.length !== 1 && claim.sentenceIndex > 0) {
    const prevText = sentences?.[claim.sentenceIndex - 1];
    if (prevText) winners = namedGroups(groups, facts, `${prevText} ${currentText}`);
  }
  if (winners.length === 1) return { sources: groups.get(winners[0]), specific: true };

  return { sources: [], specific: false }; // still ambiguous — never guess which document this is
}

const MONEY_CAND_RE = /[$#]?[\d][\d,]*(?:\.\d+)?/g;
const DATE_CAND_RE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[a-zA-Z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-zA-Z]{3,9}\.?,?\s+\d{4}/g;

/** Find where (if anywhere) `claim` is actually said in `text`. Returns [start, end) into `text` itself
 *  — never a normalized/reformatted copy — so a quote sliced from these bounds is guaranteed verbatim. */
function locateClaimInText(text, claim) {
  switch (claim.kind) {
    case "money":
    case "number":
    case "count": {
      for (const m of text.matchAll(MONEY_CAND_RE)) {
        if (amountsEqual(m[0], claim.raw)) return [m.index, m.index + m[0].length];
      }
      return null;
    }
    case "date": {
      for (const m of text.matchAll(DATE_CAND_RE)) {
        if (datesEqual(m[0], claim.value ?? claim.raw)) return [m.index, m.index + m[0].length];
      }
      return null;
    }
    case "status": {
      const phrases = STATUS_VALUE_PHRASES[claim.value];
      if (phrases?.length) {
        for (const re of phrases) {
          const m = re.exec(text);
          if (m) return [m.index, m.index + m[0].length];
        }
      }
      const idx = text.toLowerCase().indexOf(String(claim.value ?? claim.raw).toLowerCase());
      return idx >= 0 ? [idx, idx + String(claim.value ?? claim.raw).length] : null;
    }
    case "name": {
      const full = String(claim.value ?? claim.raw);
      let idx = text.toLowerCase().indexOf(full.toLowerCase());
      if (idx >= 0) return [idx, idx + full.length];
      for (const part of full.match(/[a-zA-Z']{3,}/g) ?? []) {
        idx = text.toLowerCase().indexOf(part.toLowerCase());
        if (idx >= 0) return [idx, idx + part.length];
      }
      return null;
    }
    default:
      return null;
  }
}

/** A verbatim substring of `text` (word-boundary trimmed, capped to MAX_QUOTE_LEN, ellipsized when
 *  clipped at either end) centered on wherever `claim` was located — or undefined when it wasn't found
 *  in this particular source text at all (never a fabricated quote). */
function extractQuote(text, claim, maxLen = MAX_QUOTE_LEN) {
  const loc = locateClaimInText(text, claim);
  if (!loc) return undefined;
  const [start, end] = loc;
  const radius = Math.max(20, Math.floor((maxLen - (end - start)) / 2));
  let qs = Math.max(0, start - radius);
  let qe = Math.min(text.length, end + radius);
  while (qs > 0 && /\w/.test(text[qs - 1]) && /\w/.test(text[qs])) qs--; // don't cut a word in half
  while (qe < text.length && /\w/.test(text[qe - 1]) && /\w/.test(text[qe])) qe++;
  let snippet = text.slice(qs, qe).trim();
  if (!snippet) return undefined;
  if (snippet.length > maxLen) snippet = snippet.slice(0, maxLen).trim();
  const prefixed = qs > 0 ? `…${snippet}` : snippet;
  return qe < text.length ? `${prefixed}…` : prefixed;
}

/**
 * Pure, no I/O: per-sentence {documentId, page, score, claim} candidates, before any quote is added.
 * @returns {{buckets: Map[], sentences: string[]}}
 */
function buildSentenceBuckets(answer) {
  const { claims: allClaims, sentences } = splitIntoClaims(answer);
  const claims = allClaims.length > MAX_SENTENCE_CLAIMS ? allClaims.slice(0, MAX_SENTENCE_CLAIMS) : allClaims;
  const facts = Array.isArray(answer.facts) ? answer.facts : [];
  const buckets = sentences.map(() => new Map());

  for (const claim of claims) {
    if (claim.origin === "fact" || claim.sentenceIndex == null) continue; // facts cite themselves elsewhere
    const bucket = buckets[claim.sentenceIndex];
    if (!bucket) continue;
    const { sources, specific } = sourcesForClaim(claim, facts, sentences);
    // A generic (non-cross-matched) source list is the WHOLE answer's sources, not something specific
    // to this claim — attaching all of them is only honest when there is exactly one candidate document
    // to begin with; more than one and it would be a guess which one actually backs this particular
    // sentence, so skip rather than over-cite (same precision-over-recall rule as the fallback below).
    if (!specific && new Set(sources.map((s) => s?.documentId)).size > 1) continue;
    const score = specific ? 0.9 : 0.5;
    for (const s of sources) {
      if (!s || typeof s.documentId !== "string" || !UUIDISH.test(s.documentId)) continue;
      const pageNum = Number(s.location?.page);
      const page = Number.isFinite(pageNum) && pageNum > 0 ? Math.trunc(pageNum) : undefined;
      const key = `${s.documentId}:${page ?? ""}`;
      const cur = bucket.get(key);
      if (!cur || score > cur.score) bucket.set(key, { documentId: s.documentId, page, score, claim });
    }
  }

  // Connective sentences with no claim of their own: attach the answer's one-and-only cited document,
  // at low confidence, but ONLY when there is exactly one — any more and this would be a guess.
  const allRefs = [...(Array.isArray(answer.sources) ? answer.sources : []), ...facts.flatMap((f) => (Array.isArray(f?.sources) ? f.sources : []))];
  const distinctDocs = new Set(allRefs.filter((s) => s && typeof s.documentId === "string" && UUIDISH.test(s.documentId)).map((s) => s.documentId));
  if (distinctDocs.size === 1) {
    const [onlyDocId] = distinctDocs;
    const ref = allRefs.find((s) => s?.documentId === onlyDocId);
    const pageNum = Number(ref?.location?.page);
    const page = Number.isFinite(pageNum) && pageNum > 0 ? Math.trunc(pageNum) : undefined;
    sentences.forEach((text, i) => {
      if (buckets[i].size) return;
      if (String(text ?? "").trim().split(/\s+/).filter(Boolean).length < 4) return; // too short to attribute
      buckets[i].set(`${onlyDocId}:${page ?? ""}`, { documentId: onlyDocId, page, score: 0.3, claim: null });
    });
  }

  return { buckets, sentences };
}

/** Turns buckets into the public `sentences` shape. `sourceTextFor?: (documentId, location) => string|null`
 *  — a SYNC lookup (already-resolved text); omit it to get attribution-only citations (no `quote`). */
function finalizeSentences(buckets, sentences, { sourceTextFor } = {}) {
  return sentences.map((text, i) => {
    const citations = [...buckets[i].values()]
      .sort((a, b) => b.score - a.score)
      .map(({ documentId, page, score, claim }) => {
        const out = { documentId, score: Math.round(score * 100) / 100 };
        if (page != null) out.page = page;
        if (claim && typeof sourceTextFor === "function") {
          let srcText = null;
          try { srcText = sourceTextFor(documentId, page != null ? { page } : {}); } catch { srcText = null; }
          if (srcText) {
            const quote = extractQuote(String(srcText), claim);
            if (quote) out.quote = quote;
          }
        }
        return out;
      });
    return { text, citations, supported: citations.length > 0 };
  });
}

/** Pure core, exposed for tests: same shape either entry point below produces. */
export function computeSentenceCitations(answer, { sourceTextFor } = {}) {
  const { buckets, sentences } = buildSentenceBuckets(answer);
  return finalizeSentences(buckets, sentences, { sourceTextFor });
}

/**
 * Sync, no DB — safe to call from a hot, non-async path (api/ask.js's `send`). Idempotent: a no-op if
 * `answer.sentences` is already set. Attribution only; `quote` is never present.
 * @param {object} answer
 * @returns {object} the same `answer`, with `.sentences` attached when checkable
 */
export function attachSentenceCitationsSync(answer) {
  if (!isCheckableAnswer(answer) || answer.sentences != null) return answer;
  try {
    answer.sentences = computeSentenceCitations(answer);
  } catch (err) {
    console.error("attachSentenceCitationsSync failed:", err?.message);
  }
  return answer;
}

/**
 * Async, with real source text — batches exactly one fetch per distinct (documentId, page) any sentence
 * needs (via `fetchSourceText.prefetch`, same shape claims/check.js and verify.js use), so this never
 * costs more than ONE additional round trip regardless of how many sentences/citations there are.
 * Idempotent (see attachSentenceCitationsSync); falls back to the sync, quote-less path when no
 * `fetchSourceText` is given, so this is always safe to call.
 * @param {object} answer
 * @param {{fetchSourceText?: Function}} [opts]
 * @returns {Promise<object>} the same `answer`, with `.sentences` attached when checkable
 */
export async function attachSentenceCitations(answer, { fetchSourceText } = {}) {
  if (!isCheckableAnswer(answer) || answer.sentences != null) return answer;
  if (typeof fetchSourceText !== "function") return attachSentenceCitationsSync(answer);

  const { buckets, sentences } = buildSentenceBuckets(answer);
  const needed = [];
  const seen = new Set();
  for (const bucket of buckets) {
    for (const { documentId, page } of bucket.values()) {
      const key = `${documentId}:${page ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      needed.push({ documentId, location: page != null ? { page } : {}, key });
    }
  }

  if (typeof fetchSourceText.prefetch === "function") {
    try { await fetchSourceText.prefetch(needed.map(({ documentId, location }) => ({ documentId, location }))); }
    catch { /* prefetch is an optimization only */ }
  }

  const textCache = new Map();
  for (const { documentId, location, key } of needed) {
    // eslint-disable-next-line no-await-in-loop -- bounded by distinct (documentId,page) pairs, and a
    // warm prefetch/cache (see file header) means a repeat pair here costs nothing further.
    let t = null;
    try { t = await fetchSourceText(documentId, location); } catch { t = null; }
    textCache.set(key, t);
  }
  const sourceTextFor = (documentId, location) => textCache.get(`${documentId}:${location?.page ?? ""}`) ?? null;

  try {
    answer.sentences = finalizeSentences(buckets, sentences, { sourceTextFor });
  } catch (err) {
    console.error("attachSentenceCitations failed, falling back to attribution-only:", err?.message);
    answer.sentences = finalizeSentences(buckets, sentences, {});
  }
  return answer;
}

export { extractQuote, locateClaimInText, factMatchesClaim };
