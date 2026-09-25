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
