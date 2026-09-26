/**
 * Donovan Scorecard - CITATION PRECISION (TEAM T3, 2026-09-25): does a cited page/document actually
 * contain the claim it is cited for? A deliberately dumb, cheap, deterministic TEXT match - no model call -
 * so it catches the concrete failure mode "cited the wrong document" or "the cited page says nothing like
 * this", the same way a person skimming the source would notice. It is NOT a semantic/entailment check: a
 * citation that is technically present but subtly irrelevant can still pass.
 *
 * `unsupported-claim rate` (build item 3) is simply 1 - this precision, reported by compare.js's
 * scoreResults from the same numbers this module stores per question.
 */

const STOP = new Set([
  "that", "this", "with", "have", "from", "were", "been", "what", "when", "which", "where", "does", "doesn",
  "didn", "their", "there", "about", "would", "could", "should", "customer", "customers", "document",
  "documents", "unit", "units", "many", "these", "those", "since", "into", "than", "still", "also",
]);

/** Pure: the concrete, checkable content of a short claim - numbers verbatim, words of 4+ letters, no stopwords. */
export function significantTokens(s) {
  const text = String(s ?? "");
  const nums = [...text.matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0].replace(/,/g, ""));
  const words = (text.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STOP.has(w));
  return [...new Set([...nums, ...words])];
}

/**
 * Pure: does `text` support `claim`? True when there is nothing concrete to check (e.g. "Yes.") or when
 * most (>= 60%) of the claim's significant tokens appear in the text.
 */
export function claimSupportedByText(claim, text) {
  const tokens = significantTokens(claim);
  if (!tokens.length) return true;
  const hay = String(text ?? "").toLowerCase();
  const hits = tokens.filter((t) => hay.includes(String(t).toLowerCase()));
  return hits.length / tokens.length >= 0.6;
}

/**
 * Pure: precision over one answer's own facts against the text of whatever it cited.
 * @param {object} data  an /api/ask-shaped answer ({text, facts[], sources[]/records[]})
 * @param {Map<string,string>} pageTextByDocId  documentId -> that document's own concatenated page text
 * @returns {{citedCount: number, supportedCount: number, precision: number|null, unsupportedClaims: string[]}}
 */
export function citationPrecision(data, pageTextByDocId) {
  const facts = Array.isArray(data?.facts) ? data.facts.filter((f) => f && typeof f === "object") : [];
  const citedIds = new Set([
    ...(Array.isArray(data?.sources) ? data.sources.map((s) => s?.documentId).filter(Boolean) : []),
    ...(Array.isArray(data?.records) ? data.records.map((r) => r?.documentId).filter(Boolean) : []),
    ...facts.flatMap((f) => (f?.documentId ? [f.documentId] : [])),
  ]);
  if (!citedIds.size || !facts.length) return { citedCount: 0, supportedCount: 0, precision: null, unsupportedClaims: [] };
  const allCitedText = [...citedIds].map((id) => pageTextByDocId?.get?.(id) ?? "").join("\n");
  const unsupportedClaims = [];
  let supported = 0;
  for (const f of facts) {
    const text = f.documentId && pageTextByDocId?.has?.(f.documentId) ? pageTextByDocId.get(f.documentId) : allCitedText;
    const claim = `${f.label ?? ""} ${f.value ?? ""}`;
    if (claimSupportedByText(claim, text)) supported += 1;
    else unsupportedClaims.push(`${f.label ?? ""}: ${f.value ?? ""}`.trim().slice(0, 80));
  }
  return { citedCount: facts.length, supportedCount: supported, precision: Math.round((supported / facts.length) * 1000) / 1000, unsupportedClaims: unsupportedClaims.slice(0, 5) };
}

/**
 * DB-touching wrapper: fetches the full text of every document this answer cited (one query, tenant-scoped)
 * and runs `citationPrecision` over it. Never throws - a lookup failure just means the metric is skipped
 * for this question (precision: null), never that the question fails.
 */
export async function checkCitationPrecision(withTenant, ctxArg, data) {
  const ids = [...new Set([
    ...(Array.isArray(data?.sources) ? data.sources.map((s) => s?.documentId) : []),
    ...(Array.isArray(data?.records) ? data.records.map((r) => r?.documentId) : []),
    ...(Array.isArray(data?.facts) ? data.facts.map((f) => f?.documentId) : []),
  ].filter((id) => typeof id === "string" && id))];
  if (!ids.length) return { citedCount: 0, supportedCount: 0, precision: null, unsupportedClaims: [] };
  try {
    const map = await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `SELECT document_id, string_agg(text, ' ') AS text FROM document_pages WHERE document_id = ANY($1::uuid[]) GROUP BY document_id`,
        [ids]);
      return new Map(rows.map((r) => [r.document_id, r.text ?? ""]));
    });
    return citationPrecision(data, map);
  } catch {
    return { citedCount: 0, supportedCount: 0, precision: null, unsupportedClaims: [] };
  }
}

/* ============================================================================================
 * ADDITIVE (R11, build spec item 4): atomic-claim precision / unsupported-claim rate, from the new
 * FActScore-style claim-check module (api/_lib/claims/**). Reported ALONGSIDE `citationPrecision` above,
 * never replacing it or changing its numbers — this is a finer-grained, claim-TYPE-aware metric (dates
 * format-normalized, names fuzzy-but-bounded, statuses derived from a companion date, counts checked
 * against the answer's own records set) where `citationPrecision` is a blunter token-overlap check over
 * facts only. Nothing above this line was modified.
 * ============================================================================================ */
import { splitIntoClaims } from "../claims/split.js";
import { checkClaims } from "../claims/check.js";

/** Adapter: `checkClaims` wants a `(documentId, location) => Promise<string|null>` fetcher; the map this
 *  file already builds (one query, whole-document text, same granularity `citationPrecision` uses) is
 *  keyed by documentId alone — location is ignored on purpose, matching `citationPrecision`'s own
 *  whole-document granularity above, not verify.js's page-exact one. */
function fetcherFromDocTextMap(pageTextByDocId) {
  const fn = async (documentId) => pageTextByDocId?.get?.(documentId) ?? null;
  fn.prefetch = async () => {}; // the map is already fully populated by the caller; nothing to batch
  return fn;
}

/**
 * Pure given `pageTextByDocId` (reuses whatever map the caller already fetched — no new query of its
 * own). `unsupported-claim rate` = 1 - this precision, the same relationship `citationPrecision`'s own
 * header comment already states for its metric.
 * @param {object} data  an /api/ask-shaped answer
 * @param {Map<string,string>} pageTextByDocId
 * @param {{today?: string}} [opts]
 * @returns {Promise<{checked:number, unsupportedCount:number, precision:number|null, unsupportedClaims:string[]}>}
 */
export async function claimPrecision(data, pageTextByDocId, { today } = {}) {
  if (!data || data.kind !== "answer") return { checked: 0, unsupportedCount: 0, precision: null, unsupportedClaims: [] };
  const { claims } = splitIntoClaims(data);
  if (!claims.length) return { checked: 0, unsupportedCount: 0, precision: null, unsupportedClaims: [] };
  const results = await checkClaims(claims, data, { fetchSourceText: fetcherFromDocTextMap(pageTextByDocId), today });
  const unsupported = results.filter((r) => r.supported === false);
  return {
    checked: results.length,
    unsupportedCount: unsupported.length,
    precision: Math.round(((results.length - unsupported.length) / results.length) * 1000) / 1000,
    unsupportedClaims: unsupported.slice(0, 5).map((r) => `${r.claim.kind}: ${String(r.claim.raw).slice(0, 60)}`),
  };
}

/**
 * DB-touching convenience wrapper with the SAME call signature as `checkCitationPrecision` above, for a
 * caller (runner.js) that has not already fetched the doc-text map itself — a drop-in second call right
 * beside the existing one. Runs its own query (never reuses/mutates `checkCitationPrecision`'s), so
 * calling both simply reports two metrics; it never changes what the first one returns.
 */
export async function checkClaimPrecision(withTenant, ctxArg, data, { today } = {}) {
  const ids = [...new Set([
    ...(Array.isArray(data?.sources) ? data.sources.map((s) => s?.documentId) : []),
    ...(Array.isArray(data?.records) ? data.records.map((r) => r?.documentId) : []),
    ...(Array.isArray(data?.facts) ? data.facts.map((f) => f?.documentId) : []),
  ].filter((id) => typeof id === "string" && id))];
  if (!ids.length) return { checked: 0, unsupportedCount: 0, precision: null, unsupportedClaims: [] };
  try {
    const map = await withTenant(ctxArg, async (db) => {
      const { rows } = await db.raw(
        `SELECT document_id, string_agg(text, ' ') AS text FROM document_pages WHERE document_id = ANY($1::uuid[]) GROUP BY document_id`,
        [ids]);
      return new Map(rows.map((r) => [r.document_id, r.text ?? ""]));
    });
    return await claimPrecision(data, map, { today });
  } catch {
    return { checked: 0, unsupportedCount: 0, precision: null, unsupportedClaims: [] };
  }
}
