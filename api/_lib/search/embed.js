/**
 * Embeddings for search-by-meaning: config, page-aware chunking, a Voyage AI
 * client over plain fetch (no SDK), and a cached, time-boxed query embedder.
 *
 * NOTHING HERE TOUCHES THE DATABASE. Storage and retrieval live in
 * ./store.js and ./hybrid.js; this file is pure enough to test with a fake
 * `fetch`.
 *
 * FEATURE FLAG: semantic search is ON only when VOYAGE_API_KEY is set (and
 * DONOVAN_SEMANTIC is not "0"). With no key every export here is inert and the
 * app behaves exactly as it did before this feature existed.
 *
 * VOYAGE FACTS (checked against docs.voyageai.com, 2026-09-23):
 *   - POST https://api.voyageai.com/v1/embeddings  { input: string[], model,
 *     input_type: "document" | "query" | null, truncation, output_dimension? }
 *     -> { data: [{ index, embedding }], usage: { total_tokens } }
 *   - voyage-3.5-lite: default 1024 dims (256/512/1024/2048 selectable via
 *     output_dimension), 1M tokens per request cap, max 1000 texts per request,
 *     $0.02 per 1M tokens. voyage-4-lite has the same price and dimensions.
 *   - POST /v1/rerank { query, documents, model, top_k } -> { data: [{ index,
 *     relevance_score }], usage: { total_tokens } }; rerank-2.5 $0.05/M,
 *     rerank-2.5-lite $0.02/M.
 * If Voyage changes a model name, set DONOVAN_EMBED_MODEL / DONOVAN_EMBED_DIM
 * rather than editing code. The migration's column is vector(1024).
 *
 * PRIVACY: page text and questions are sent to Voyage (a sub-processor).
 * Neither is ever logged here — only counts, token totals and status codes.
 */
import { createHash } from 'node:crypto';
import { documentTypeLabel } from '../documentTypes.js';

export const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';
export const DEFAULT_EMBED_MODEL = 'voyage-4-lite'; // same $0.02/M + 1024 dims as 3.5-lite, but 200M free tokens per account (3.5-lite has none)
export const DEFAULT_EMBED_DIM = 1024;
/** Texts per embeddings request. Voyage allows 1000; 96 keeps each call quick and each retry cheap. */
export const EMBED_BATCH_TEXTS = 96;

/* ------------------------------------------------------------------ config */

const posInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};

/**
 * Resolved fresh on every call (never cached at module scope) so tests, and an
 * owner adding the key in Vercel, take effect without a module reset.
 */
export function embedConfig(env = process.env) {
  const apiKey = String(env.VOYAGE_API_KEY ?? '').trim();
  const off = String(env.DONOVAN_SEMANTIC ?? '').trim() === '0';
  const explicitDim = Number(env.DONOVAN_EMBED_DIM);
  const dimExplicit = Number.isFinite(explicitDim) && explicitDim > 0;
  const rerankModel = String(env.DONOVAN_RERANK_MODEL ?? '').trim();
  return {
    enabled: Boolean(apiKey) && !off,
    apiKey,
    model: String(env.DONOVAN_EMBED_MODEL ?? '').trim() || DEFAULT_EMBED_MODEL,
    dim: dimExplicit ? Math.trunc(explicitDim) : DEFAULT_EMBED_DIM,
    // Only send output_dimension when the owner asked for one: older Voyage
    // models reject the parameter outright.
    sendDim: dimExplicit,
    queryTimeoutMs: posInt(env.DONOVAN_EMBED_QUERY_TIMEOUT_MS, 1500),
    minSimilarity: (() => {
      const n = Number(env.DONOVAN_SEMANTIC_MIN_SIM);
      return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.25;
    })(),
    // Rerank is off unless the owner sets BOTH a key and a model.
    rerankModel: apiKey && !off ? rerankModel : '',
    rerankTimeoutMs: posInt(env.DONOVAN_RERANK_TIMEOUT_MS, 1200),
    dailyTokens: posInt(env.DONOVAN_EMBED_DAILY_TOKENS, 5_000_000),
    // R10c: deterministic contextual chunk headers (see buildChunkContextHeader below), on by
    // default. A production escape hatch, same shape as DONOVAN_SEMANTIC=0 — never needed in the
    // ordinary case, but lets an owner turn this specific piece off without losing semantic search
    // entirely if a header ever turns out to hurt some tenant's retrieval.
    chunkContext: String(env.DONOVAN_CHUNK_CONTEXT ?? '1').trim() !== '0',
  };
}

export function semanticEnabled(env = process.env) {
  return embedConfig(env).enabled;
}

/* ---------------------------------------------------------------- chunking */

export const CHUNK_TARGET = 1000;
export const CHUNK_MAX = 1200;
export const CHUNK_OVERLAP = 150;

/** The break closest to `target` inside [lo, hi]: paragraph, else sentence, else whitespace. */
function bestBreak(t, lo, hi, target) {
  const win = t.slice(lo, hi);
  for (const re of [/\n\n/g, /[.!?]["')\]]?\s/g, /\s/g]) {
    let best = -1;
    let bestDist = Infinity;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(win)) !== null) {
      const at = lo + m.index + m[0].length;
      const d = Math.abs(at - target);
      if (d < bestDist) { bestDist = d; best = at; }
      if (m[0].length === 0) re.lastIndex++;
    }
    if (best > 0) return best;
  }
  return -1;
}

/**
 * Cut one page's text into ~1000-character chunks (never above ~1300), with a
 * 150-character overlap so a sentence straddling a cut is whole in at least one
 * chunk. A page shorter than CHUNK_MAX is one chunk. Pure.
 */
export function chunkPageText(text, { target = CHUNK_TARGET, max = CHUNK_MAX, overlap = CHUNK_OVERLAP } = {}) {
  const t = String(text ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + target, t.length);
    if (end < t.length) {
      const cut = bestBreak(t, start + Math.floor(target * 0.6), Math.min(start + max, t.length), start + target);
      end = cut > start ? cut : Math.min(start + target, t.length);
      // Don't leave a sliver as its own chunk: absorb a short tail.
      if (t.length - end < 100) end = t.length;
    }
    const piece = t.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= t.length) break;
    let next = end - overlap;
    // Begin the overlap on a word boundary, not mid-word.
    const ws = t.slice(next, end).search(/\s/);
    if (ws >= 0) next += ws + 1;
    start = Math.max(next, start + 1);
  }
  return out;
}

/**
 * Page-aware chunking: every chunk keeps the page it came from, so a semantic
 * hit can be cited as "document X, page N" exactly like a keyword hit.
 * @param {{page_no: number, text?: string|null}[]} pages
 * @returns {{page_no: number, chunk_no: number, text: string}[]}
 */
export function chunkPages(pages) {
  const out = [];
  for (const p of pages ?? []) {
    chunkPageText(p.text).forEach((text, chunk_no) => out.push({ page_no: p.page_no, chunk_no, text }));
  }
  return out;
}

/** Rough token estimate (for the pre-flight budget check only; the real count comes back from Voyage). */
export function estimateTokens(texts) {
  let chars = 0;
  for (const t of texts) chars += String(t).length;
  return Math.ceil(chars / 3);
}

/* ------------------------------------------------------- contextual chunk headers */

/**
 * CONTEXTUAL CHUNK HEADERS (evidence: Anthropic's "Contextual Retrieval" reports large drops in
 * retrieval failures from adding chunk context). A page chunked in isolation loses the facts that
 * make it findable: a page 2 that only says "replaced the run capacitor, checked refrigerant
 * levels" has no customer name, address or unit on it — those are on page 1. Prepending a short,
 * deterministic header (built from structured facts the extraction pipeline already produced — see
 * store.js's documentContextFacts) before embedding means every chunk of a document carries its own
 * "what is this page about" context, independent of what that specific page happens to mention.
 *
 * NO MODEL CALL: this is a plain string template over already-extracted fields, not a summary an
 * LLM writes. `facts` keys match the extraction field_keys documentContextFacts reads (plus
 * `documentType`, from documents.document_type) — see extractFields.js's FIELD_SPECS for their
 * canonical meaning. Pure; every field is optional, and a document with none of them yields ''
 * (no header at all, same as before this feature existed).
 *
 * @param {{documentType?, customer_name?, service_address?, manufacturer?, model?, serial_number?, service_date?, technician?, invoice_number?}} facts
 * @returns {string} e.g. "[Work order · Carol Rios · 581 W Thomas Rd, Casa Grande · Trane XR16 · 2025-06-12 · tech: M. Vega]", or '' when nothing is known yet.
 */
export function buildChunkContextHeader(facts = {}) {
  const parts = [];
  if (facts.documentType) {
    const label = documentTypeLabel(facts.documentType);
    if (label) parts.push(label);
  }
  if (facts.customer_name) parts.push(String(facts.customer_name).trim());
  if (facts.service_address) parts.push(String(facts.service_address).trim());
  const unit = [facts.manufacturer, facts.model].filter(Boolean).join(' ').trim();
  if (unit) parts.push(unit);
  if (facts.serial_number) parts.push(`S/N ${String(facts.serial_number).trim()}`);
  if (facts.service_date) parts.push(String(facts.service_date).trim());
  if (facts.technician) parts.push(`tech: ${String(facts.technician).trim()}`);
  if (facts.invoice_number) parts.push(`inv ${String(facts.invoice_number).trim()}`);
  return parts.length ? `[${parts.join(' · ')}]` : '';
}

/** Prepend `header` to `text` on its own line (never mid-sentence); `text` unchanged when there is no header. Pure. */
export function withContextHeader(header, text) {
  return header ? `${header}\n${text}` : text;
}

/**
 * Which header generation a chunk's embedding reflects: 0 = none (embedded before this feature
 * existed, or while DONOVAN_CHUNK_CONTEXT=0), CURRENT = the header buildChunkContextHeader produces
 * today. Bump CURRENT when the header's shape changes materially enough that old chunks should be
 * re-embedded; store.js's semantic backfill re-embeds anything below CURRENT (see M3-config/38).
 */
export const NO_CONTEXT_VERSION = 0;
export const CURRENT_CONTEXT_VERSION = 1;

/**
 * Voyage's list price for voyage-4-lite / voyage-3.5-lite (see this file's header comment) — used
 * ONLY to give an operator a rough $ estimate before they trigger a re-embed backfill, never to
 * gate, bill or throttle anything.
 */
export const VOYAGE_USD_PER_MILLION_TOKENS = 0.02;

/** Rough $ estimate for embedding `chunkCount` chunks at ~CHUNK_TARGET/3 tokens each (the same
 *  chars/3 heuristic estimateTokens uses). A pre-flight number, not a billing figure. Pure. */
export function estimateEmbedCostUsd(chunkCount, avgTokensPerChunk = Math.ceil(CHUNK_TARGET / 3)) {
  const n = Math.max(0, Number(chunkCount) || 0);
  return (n * avgTokensPerChunk * VOYAGE_USD_PER_MILLION_TOKENS) / 1_000_000;
}

/* -------------------------------------------------------------- HTTP client */

export class EmbedError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'EmbedError';
    this.status = status;
    this.retryable = retryable;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON POST to Voyage with a hard timeout and retry-with-backoff on 429,
 * 5xx and network errors/timeouts. 4xx other than 429 is the caller's fault
 * and is never retried. `fetch` is looked up at call time so tests can swap it.
 */
export async function voyagePost(path, body, { apiKey, timeoutMs = 20_000, maxRetries = 2, sleep = realSleep, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${VOYAGE_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.ok) return await res.json();
      const retryable = res.status === 429 || res.status >= 500;
      // Status only — the body of an error can echo the input text.
      lastErr = new EmbedError(`Voyage ${path} returned ${res.status}`, { status: res.status, retryable });
      if (!retryable) throw lastErr;
      const ra = Number(res.headers?.get?.('retry-after'));
      if (attempt < maxRetries) {
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 200);
        await sleep(wait);
      }
    } catch (err) {
      if (err instanceof EmbedError && !err.retryable) throw err;
      if (!(err instanceof EmbedError)) {
        const aborted = err?.name === 'AbortError';
        lastErr = new EmbedError(aborted ? `Voyage ${path} timed out` : `Voyage ${path} network error`, { retryable: true });
        if (attempt < maxRetries) await sleep(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 200));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new EmbedError(`Voyage ${path} failed`, { retryable: true });
}

/**
 * Embed `texts`, batching EMBED_BATCH_TEXTS per request, sequentially (a
 * serverless function has no business hammering a rate limit in parallel).
 * @returns {Promise<{vectors: number[][], tokens: number, calls: number}>}
 */
export async function voyageEmbed(texts, { inputType, cfg = embedConfig(), timeoutMs, maxRetries, sleep } = {}) {
  if (!cfg.enabled) throw new EmbedError('semantic search is not configured');
  const vectors = [];
  let tokens = 0;
  let calls = 0;
  for (let i = 0; i < texts.length; i += EMBED_BATCH_TEXTS) {
    const batch = texts.slice(i, i + EMBED_BATCH_TEXTS);
    const json = await voyagePost('/embeddings', {
      input: batch,
      model: cfg.model,
      input_type: inputType ?? null,
      truncation: true,
      ...(cfg.sendDim ? { output_dimension: cfg.dim } : {}),
    }, { apiKey: cfg.apiKey, timeoutMs, maxRetries, sleep });
    calls++;
    const data = Array.isArray(json?.data) ? [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
    if (data.length !== batch.length) throw new EmbedError('Voyage returned the wrong number of embeddings');
    for (const d of data) {
      if (!Array.isArray(d.embedding) || d.embedding.length !== cfg.dim) {
        throw new EmbedError(`Voyage embedding has ${d.embedding?.length ?? 0} dimensions, expected ${cfg.dim} (check DONOVAN_EMBED_MODEL / DONOVAN_EMBED_DIM)`);
      }
      vectors.push(d.embedding);
    }
    tokens += Number(json?.usage?.total_tokens) || estimateTokens(batch);
  }
  return { vectors, tokens, calls };
}

/* -------------------------------------------- query embedding: cache + breaker */

const QUERY_CACHE_TTL_MS = 10 * 60_000;
const QUERY_CACHE_MAX = 500;
/** key -> { at, vector }  (Map iteration order = insertion order, so the first key is the oldest.) */
const queryCache = new Map();
/** key -> in-flight promise, so two identical concurrent asks share one HTTP call. */
const inflight = new Map();

// Circuit breaker: after a few consecutive failures stop paying the timeout on
// every search for a minute. Semantic search is an enhancement, never a gate.
const BREAKER_FAILS = 3;
const BREAKER_OPEN_MS = 60_000;
let consecutiveFails = 0;
let breakerOpenUntil = 0;

export function _resetEmbedState() {
  queryCache.clear();
  inflight.clear();
  consecutiveFails = 0;
  breakerOpenUntil = 0;
}

export function semanticBreakerOpen(now = Date.now()) {
  return now < breakerOpenUntil;
}
/** Called by ./hybrid.js when the vector query itself fails. */
export function tripSemanticBreaker(now = Date.now()) {
  breakerOpenUntil = now + BREAKER_OPEN_MS;
}

export function questionKey(question, cfg) {
  const norm = String(question ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${cfg.model}|${cfg.dim}|${norm}`).digest('hex');
}

/**
 * Embed a question (input_type "query"), cached 10 minutes per question hash.
 * NEVER throws: returns null on timeout, error, breaker-open or feature-off,
 * and the caller falls back to keyword-only for that request.
 * @returns {Promise<{vector: number[], tokens: number, cached: boolean}|null>}
 */
export async function embedQuery(question, cfg = embedConfig(), { now = Date.now() } = {}) {
  try {
    const q = String(question ?? '').trim();
    if (!cfg.enabled || !q || semanticBreakerOpen(now)) return null;
    const key = questionKey(q, cfg);
    const hit = queryCache.get(key);
    if (hit && now - hit.at < QUERY_CACHE_TTL_MS) return { vector: hit.vector, tokens: 0, cached: true };

    let p = inflight.get(key);
    if (!p) {
      p = voyageEmbed([q.slice(0, 2000)], { inputType: 'query', cfg, timeoutMs: cfg.queryTimeoutMs, maxRetries: 0 })
        .then((r) => {
          consecutiveFails = 0;
          queryCache.set(key, { at: Date.now(), vector: r.vectors[0] });
          while (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
          return { vector: r.vectors[0], tokens: r.tokens, cached: false };
        })
        .catch((err) => {
          if (++consecutiveFails >= BREAKER_FAILS) {
            breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
            consecutiveFails = 0;
          }
          console.warn(`semantic: query embedding unavailable (${err?.name}${err?.status ? ` ${err.status}` : ''}); keyword-only for this request`);
          return null;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const r = await p;
    // A shared in-flight result is "not cached" only for the caller that paid.
    return r;
  } catch {
    return null;
  }
}

/** pgvector text literal: "[0.1,0.2,...]". */
export function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}
