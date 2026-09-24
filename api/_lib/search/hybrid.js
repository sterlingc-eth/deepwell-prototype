/**
 * Hybrid retrieval: semantic (vector) + keyword results fused with Reciprocal
 * Rank Fusion, identifier matches pinned on top, optional rerank.
 *
 * Hooked into recordsStore.js's searchPassages with two small calls:
 *   const sem = startSemantic(question);            // kicks off the query embedding
 *   ... existing keyword passes run, concurrently with it ...
 *   return finishHybrid(db, sem, { ... });          // fuse, or fall back to keyword-only
 *
 * With semantic search off (no VOYAGE_API_KEY, table/extension missing, Voyage
 * slow or down, vector query failed) `finishHybrid` returns exactly the
 * keyword-only result searchPassages always returned, so the caller's
 * contract — same row shape {id, document_id, page_no, original_filename,
 * document_type, stage, excerpt, rank, matched_by} — never changes and
 * ask.js/answer.js grounding (buildAllowed page checks) keeps working: every
 * returned row is a real document_pages row.
 */
import {
  embedConfig, embedQuery, semanticBreakerOpen, tripSemanticBreaker,
} from './embed.js';
import { rerankDocuments } from './rerank.js';
import { nearestChunks, recordEmbeddingUsage, semanticSchemaReady } from './store.js';

/** How many keyword and vector candidates to fuse. */
export const SEM_CANDIDATES = 30;
/** RRF constant from the original paper; larger = flatter. */
export const RRF_K = 60;
const EXCERPT_CHARS = 420;

/**
 * Reciprocal Rank Fusion over ranked id lists. score(id) = sum over lists of
 * weight / (k + rank), rank starting at 1. Pure; exported for tests.
 * @param {{ids: string[], weight?: number}[]} lists
 * @returns {Map<string, number>} id -> fused score
 */
export function rrfScores(lists, k = RRF_K) {
  const scores = new Map();
  for (const { ids, weight = 1 } of lists) {
    ids.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + weight / (k + i + 1)));
  }
  return scores;
}

/** A chunk's text as a citation excerpt: whitespace collapsed, clipped on a word. */
function clip(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= EXCERPT_CHARS) return t;
  const cut = t.slice(0, EXCERPT_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), EXCERPT_CHARS - 40))} …`;
}

/**
 * Begin embedding the question. Returns null (and does nothing) when semantic
 * search is off. The returned promise never rejects.
 */
export function startSemantic(question, cfg = embedConfig()) {
  if (!cfg.enabled || semanticBreakerOpen()) return null;
  return { cfg, embedding: embedQuery(question, cfg), startedAt: Date.now() };
}

/** How many keyword candidates the keyword passes should fetch. */
export function keywordCandidateLimit(limit, sem) {
  return sem ? Math.max(limit, SEM_CANDIDATES) : limit;
}

/**
 * Pure fusion step (no I/O): pin identifier hits, RRF-fuse the rest, attach
 * vector-only pages. Exported for tests.
 * @param {object[]} keywordRows  keyword results, best first (searchPassages' own order)
 * @param {object[]} vectorRows   nearestChunks() rows, nearest first
 * @param {Set<string>} [identifierPageIds]  pages an identifier/serial token matched. searchPassages labels a page
 *   "identifier:…" only when the identifier pass found it FIRST; a page the full-text pass had already found is
 *   labelled "text", so the set — not the label — is what decides who is pinned.
 * @returns {object[]} candidates, best first, unsliced, each with matched_by + rank
 */
export function fuseCandidates(keywordRows, vectorRows, identifierPageIds = new Set()) {
  const isIdentifierHit = (r) => identifierPageIds.has(r.id) || String(r.matched_by ?? '').startsWith('identifier:');
  const pinned = keywordRows.filter(isIdentifierHit);
  const kwRest = keywordRows.filter((r) => !isIdentifierHit(r));
  const pinnedIds = new Set(pinned.map((r) => r.id));
  const vecRest = vectorRows.filter((r) => !pinnedIds.has(r.id));

  const scores = rrfScores([
    { ids: kwRest.map((r) => r.id) },
    { ids: vecRest.map((r) => r.id) },
  ]);
  const byId = new Map();
  for (const r of kwRest) byId.set(r.id, { ...r });
  for (const v of vecRest) {
    const existing = byId.get(v.id);
    if (existing) {
      existing.matched_by = `${existing.matched_by}+semantic`;
    } else {
      byId.set(v.id, {
        id: v.id,
        document_id: v.document_id,
        page_no: v.page_no,
        original_filename: v.original_filename,
        document_type: v.document_type,
        stage: v.stage,
        excerpt: clip(v.chunk_text),
        rank: 0,
        matched_by: 'semantic',
      });
    }
  }
  // A page can also be an identifier hit AND a vector hit: mark it, keep it pinned.
  for (const v of vectorRows) {
    if (pinnedIds.has(v.id)) {
      const p = pinned.find((r) => r.id === v.id);
      if (p && !p.matched_by.includes('+semantic')) p.matched_by = `${p.matched_by}+semantic`;
    }
  }
  const fused = [...byId.values()]
    .map((r) => ({ ...r, rank: scores.get(r.id) ?? 0 }))
    .sort((a, b) => b.rank - a.rank);
  return [...pinned, ...fused];
}

/** Rewrite `rank` so it is strictly decreasing in the final order (identifier pins stay above everything). */
function finalize(rows) {
  return rows.map((r, i) => ({ ...r, rank: Number((1 - i / (rows.length + 1)).toFixed(4)) }));
}

/**
 * The tail of searchPassages. `keywordRows` is the keyword-only result, already
 * sorted best-first (NOT yet sliced to `limit`). Never throws.
 * @param {*} db  the tenant-scoped pg client searchPassages is already using
 * @param {ReturnType<typeof startSemantic>} sem
 */
export async function finishHybrid(db, sem, { tenantId, question, limit, documentIds, keywordRows, identifierPageIds = new Set() }) {
  const isPinned = (r) => identifierPageIds.has(r.id) || String(r.matched_by ?? '').startsWith('identifier:');
  const keywordOnly = () => keywordRows.slice(0, limit);
  if (!sem) return keywordOnly();
  try {
    const q = await sem.embedding; // bounded by cfg.queryTimeoutMs; resolves null on any failure
    if (!q?.vector) return keywordOnly();
    if (!(await semanticSchemaReady(db))) return keywordOnly();

    let vectorRows;
    try {
      vectorRows = await nearestChunks(db, {
        vector: q.vector, model: sem.cfg.model, k: SEM_CANDIDATES, documentIds, minSim: sem.cfg.minSimilarity,
      });
    } catch (err) {
      tripSemanticBreaker();
      console.warn(`semantic: vector query failed (${err?.code ?? err?.name ?? 'error'}); keyword-only for now`);
      return keywordOnly();
    }
    // Query embeddings are ~20 tokens; count them so the daily total is honest. Best-effort.
    if (q.tokens > 0) await recordEmbeddingUsage(db, tenantId, q.tokens, 1).catch(() => {});

    let candidates = fuseCandidates(keywordRows, vectorRows, identifierPageIds);

    // Optional rerank of the non-pinned candidates (off unless configured).
    if (sem.cfg.rerankModel) {
      const pinnedCount = candidates.filter(isPinned).length;
      const rest = candidates.slice(pinnedCount, pinnedCount + Math.max(limit * 2, 20));
      if (rest.length > 1) {
        const rr = await rerankDocuments(question, rest.map((r) => r.excerpt ?? ''), sem.cfg);
        if (rr) {
          const seen = new Set(rr.order);
          const reordered = [...rr.order.map((i) => rest[i]), ...rest.filter((_, i) => !seen.has(i))];
          candidates = [...candidates.slice(0, pinnedCount), ...reordered, ...candidates.slice(pinnedCount + rest.length)];
        }
      }
    }
    return finalize(candidates.slice(0, limit));
  } catch (err) {
    console.warn(`semantic: hybrid step failed (${err?.name ?? 'Error'}); keyword-only`);
    return keywordOnly();
  }
}
