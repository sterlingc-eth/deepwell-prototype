/**
 * Optional cross-encoder rerank (Voyage /v1/rerank) over the fused candidates.
 *
 * OFF unless BOTH VOYAGE_API_KEY and DONOVAN_RERANK_MODEL (e.g. "rerank-3-lite": $0.02/M with 200M free tokens)
 * are set. Time-boxed and best-effort: on timeout or any error the caller keeps
 * its reciprocal-rank-fusion order. Never throws.
 */
import { embedConfig, voyagePost } from './embed.js';

const DOC_CHARS = 1500;

/**
 * @param {string} question
 * @param {string[]} documents  candidate texts, in the caller's current order
 * @returns {Promise<{order: number[], tokens: number}|null>}  indexes into
 *   `documents`, best first — or null when rerank is off/failed.
 */
export async function rerankDocuments(question, documents, cfg = embedConfig()) {
  try {
    if (!cfg.rerankModel || !documents.length) return null;
    const json = await voyagePost('/rerank', {
      query: String(question).slice(0, 2000),
      documents: documents.map((d) => String(d).slice(0, DOC_CHARS)),
      model: cfg.rerankModel,
      top_k: documents.length,
      truncation: true,
    }, { apiKey: cfg.apiKey, timeoutMs: cfg.rerankTimeoutMs, maxRetries: 0 });
    const data = Array.isArray(json?.data) ? json.data : [];
    const order = data
      .filter((d) => Number.isInteger(d.index) && d.index >= 0 && d.index < documents.length)
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
      .map((d) => d.index);
    if (!order.length) return null;
    return { order, tokens: Number(json?.usage?.total_tokens) || 0 };
  } catch (err) {
    console.warn(`semantic: rerank unavailable (${err?.name}${err?.status ? ` ${err.status}` : ''}); keeping fused order`);
    return null;
  }
}
