/**
 * Database side of search-by-meaning: the schema probe, the per-tenant daily
 * embedding budget, embedding a document's pages (ingest hook), the resumable
 * backfill, and the nearest-chunk query.
 *
 * EVERYTHING HERE TOLERATES THE MIGRATION (M3-config/31-semantic-search.sql)
 * NOT HAVING BEEN RUN. Every entry point first asks `semanticSchemaReady()`;
 * if the extension or either table is missing it returns an inert result and
 * touches nothing. (A failed statement inside a Postgres transaction aborts the
 * whole transaction, so "try it and catch the error" is NOT safe here — the
 * probe runs first, and the one query that can still fail at runtime runs
 * inside a SAVEPOINT.)
 *
 * Embedding calls happen OUTSIDE any database transaction: a Voyage round trip
 * can take seconds and must not hold one of the pool's few connections.
 */
import { getPool, getTenantContext } from '../recordsStore.js';
import {
  chunkPages, embedConfig, estimateTokens, toVectorLiteral, voyageEmbed, EmbedError,
} from './embed.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * `withTenant`, but handing `fn` the raw pg client (this feature writes its
 * own tables). Same transaction + SET LOCAL app.tenant_id contract as
 * recordsStore.js's withTenant, so RLS is in force exactly as everywhere else.
 */
export async function withTenantRaw(ctx, fn) {
  const tenantId = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client, tenantId);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------- schema probe */

const PROBE_FALSE_TTL_MS = 5 * 60_000;
/** { ok: boolean, at: number } — `true` is remembered for the life of the instance; `false` is re-probed after 5 minutes so pasting the migration needs no redeploy. */
let probe = null;

export function _resetSemanticProbe() { probe = null; }

/**
 * Is pgvector installed AND are both tables present? `db` is any client already
 * inside a tenant transaction (the probe reads only the catalog).
 */
export async function semanticSchemaReady(db, now = Date.now()) {
  if (probe && (probe.ok || now - probe.at < PROBE_FALSE_TTL_MS)) return probe.ok;
  try {
    const r = await db.query(
      `SELECT to_regclass('public.page_chunks') IS NOT NULL AS chunks,
              to_regclass('public.embedding_usage') IS NOT NULL AS usage,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ext`
    );
    const row = r.rows[0] ?? {};
    probe = { ok: Boolean(row.chunks && row.usage && row.ext), at: now };
  } catch {
    return false; // don't memoize a transient failure
  }
  return probe.ok;
}

/* -------------------------------------------------------------------- budget */

const utcDay = () => new Date().toISOString().slice(0, 10);

/** Daily embedding-token cap for this tenant: tenants.limits.maxEmbedTokensPerDay, else DONOVAN_EMBED_DAILY_TOKENS, else 5,000,000 (~$0.10). */
export async function embeddingDailyCap(ctx, cfg = embedConfig()) {
  try {
    const t = await getTenantContext(ctx.tenantKey, ctx.tenantName);
    const o = Number(t?.limits?.maxEmbedTokensPerDay);
    if (Number.isFinite(o) && o > 0) return Math.trunc(o);
  } catch { /* fall through to the env default */ }
  return cfg.dailyTokens;
}

export async function tokensUsedToday(db) {
  const r = await db.query(`SELECT tokens FROM embedding_usage WHERE ${TENANT} AND day = $1::date`, [utcDay()]);
  return Number(r.rows[0]?.tokens ?? 0);
}

export async function recordEmbeddingUsage(db, tenantId, tokens, calls = 1) {
  if (!(tokens > 0)) return;
  await db.query(
    `INSERT INTO embedding_usage (tenant_id, day, tokens, calls) VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (tenant_id, day) DO UPDATE SET tokens = embedding_usage.tokens + EXCLUDED.tokens,
                                                calls  = embedding_usage.calls  + EXCLUDED.calls`,
    [tenantId, utcDay(), Math.trunc(tokens), calls]
  );
}

/* --------------------------------------------------------- embedding pages */

const INSERT_ROWS_PER_STATEMENT = 100;
/** The ingest hook embeds at most this many pages of one document inline; a longer document's remainder is left to the backfill. */
const HOOK_MAX_PAGES = 60;

/** Pages (of one document, or of the whole tenant) with no chunks for the current model at the current text. */
async function pagesNeedingEmbedding(db, { model, documentId = null, limit }) {
  const r = await db.query(
    `SELECT p.document_id, p.page_no, p.text, md5(p.text) AS page_hash
       FROM document_pages p
      WHERE p.${TENANT}
        AND length(btrim(p.text)) > 0
        ${documentId ? 'AND p.document_id = $3' : ''}
        AND NOT EXISTS (
              SELECT 1 FROM page_chunks c
               WHERE c.tenant_id = p.tenant_id AND c.document_id = p.document_id
                 AND c.page_no = p.page_no AND c.model = $1 AND c.page_hash = md5(p.text))
      ORDER BY p.document_id, p.page_no
      LIMIT $2`,
    documentId ? [model, limit, documentId] : [model, limit]
  );
  return r.rows;
}

/**
 * Chunk, embed and store a set of pages. Idempotent: a page's old chunks (for
 * this model) are deleted and replaced in the same transaction, so re-running
 * converges on one set of rows.
 * @returns {{pages: number, chunks: number, tokens: number}}
 */
async function embedAndStore(ctx, tenantId, pages, cfg, net = {}) {
  const byDoc = new Map();
  for (const p of pages) {
    if (!byDoc.has(p.document_id)) byDoc.set(p.document_id, []);
    byDoc.get(p.document_id).push(p);
  }
  const chunks = []; // { document_id, page_no, chunk_no, text, page_hash }
  for (const [document_id, ps] of byDoc) {
    const hashOf = new Map(ps.map((p) => [p.page_no, p.page_hash]));
    for (const c of chunkPages(ps)) chunks.push({ document_id, ...c, page_hash: hashOf.get(c.page_no) });
  }
  if (!chunks.length) return { pages: 0, chunks: 0, tokens: 0 };

  const { vectors, tokens, calls } = await voyageEmbed(chunks.map((c) => c.text), { inputType: 'document', cfg, ...net });

  await withTenantRaw(ctx, async (db, tid) => {
    for (const [document_id, ps] of byDoc) {
      await db.query(
        `DELETE FROM page_chunks WHERE ${TENANT} AND document_id = $1 AND model = $2 AND page_no = ANY($3::int[])`,
        [document_id, cfg.model, ps.map((p) => p.page_no)]
      );
    }
    for (let i = 0; i < chunks.length; i += INSERT_ROWS_PER_STATEMENT) {
      const slice = chunks.slice(i, i + INSERT_ROWS_PER_STATEMENT);
      const vals = [];
      const tuples = slice.map((c, j) => {
        const b = j * 8;
        vals.push(tid, c.document_id, c.page_no, c.chunk_no, c.text, c.page_hash, toVectorLiteral(vectors[i + j]), cfg.model);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::vector,$${b + 8})`;
      });
      await db.query(
        `INSERT INTO page_chunks (tenant_id, document_id, page_no, chunk_no, text, page_hash, embedding, model)
         VALUES ${tuples.join(',')}
         ON CONFLICT (tenant_id, document_id, page_no, chunk_no, model)
         DO UPDATE SET text = EXCLUDED.text, page_hash = EXCLUDED.page_hash, embedding = EXCLUDED.embedding`,
        vals
      );
    }
    await recordEmbeddingUsage(db, tid, tokens, calls);
  });
  console.log(JSON.stringify({ route: 'semantic', t: 'embed_pages', pages: pages.length, chunks: chunks.length, tokens, model: cfg.model }));
  return { pages: pages.length, chunks: chunks.length, tokens };
}

/**
 * Ingest hook: embed one document's pages. NON-FATAL by contract — it never
 * throws, and the document is already stored and readable whatever happens
 * here (the backfill picks up anything missed).
 * @returns {Promise<{status: 'off'|'no-schema'|'budget'|'done'|'error', pages?: number, chunks?: number}>}
 */
export async function embedDocumentPages(ctx, documentId, { cfg = embedConfig() } = {}) {
  if (!cfg.enabled) return { status: 'off' };
  try {
    const cap = await embeddingDailyCap(ctx, cfg);
    const found = await withTenantRaw(ctx, async (db, tid) => {
      if (!(await semanticSchemaReady(db))) return null;
      const used = await tokensUsedToday(db);
      const pages = await pagesNeedingEmbedding(db, { model: cfg.model, documentId, limit: HOOK_MAX_PAGES });
      return { tid, used, pages };
    });
    if (!found) return { status: 'no-schema' };
    if (!found.pages.length) return { status: 'done', pages: 0, chunks: 0 };
    if (found.used + estimateTokens(found.pages.map((p) => p.text)) > cap) return { status: 'budget' };
    // Tight network limits: the ingest hook runs after the model read inside a 60 s function (worst case ~17 s here).
    const r = await embedAndStore(ctx, found.tid, found.pages, cfg, { timeoutMs: 8_000, maxRetries: 1 });
    return { status: 'done', pages: r.pages, chunks: r.chunks };
  } catch (err) {
    console.warn(`semantic: could not embed a document's pages (${err?.name ?? 'Error'}${err?.status ? ` ${err.status}` : ''}); the backfill will retry`);
    return { status: 'error' };
  }
}

/* ------------------------------------------------------------ status/backfill */

/** Progress numbers for the Team-screen card. Cheap: three counts and one sum. */
export async function semanticStatus(ctx, { cfg = embedConfig() } = {}) {
  const base = { configured: cfg.enabled, model: cfg.model, rerank: Boolean(cfg.rerankModel) };
  if (!cfg.enabled) return { ...base, ready: false, reason: 'not-configured' };
  const cap = await embeddingDailyCap(ctx, cfg);
  return withTenantRaw(ctx, async (db) => {
    if (!(await semanticSchemaReady(db))) return { ...base, ready: false, reason: 'migration-pending' };
    const r = await db.query(
      `SELECT (SELECT count(*) FROM document_pages p WHERE p.${TENANT} AND length(btrim(p.text)) > 0)::int AS total,
              (SELECT count(*) FROM document_pages p WHERE p.${TENANT} AND length(btrim(p.text)) > 0
                  AND EXISTS (SELECT 1 FROM page_chunks c WHERE c.tenant_id = p.tenant_id AND c.document_id = p.document_id
                                AND c.page_no = p.page_no AND c.model = $1 AND c.page_hash = md5(p.text)))::int AS embedded,
              (SELECT count(*) FROM page_chunks c WHERE c.${TENANT} AND c.model = $1)::int AS chunks`,
      [cfg.model]
    );
    const { total, embedded, chunks } = r.rows[0];
    const used = await tokensUsedToday(db);
    return { ...base, ready: true, pagesTotal: total, pagesEmbedded: embedded, pagesRemaining: Math.max(0, total - embedded), chunks, tokensToday: used, tokenBudget: cap };
  });
}

/**
 * Embed existing pages, in batches, inside a wall-clock budget. Idempotent and
 * resumable: "what still needs doing" is recomputed from the database on every
 * iteration, so a call that stops at the deadline (or one that never finishes)
 * loses nothing — the next call just carries on. The UI calls this in a loop
 * until `done`.
 * @returns {Promise<{stoppedBy: 'done'|'deadline'|'budget'|'off'|'no-schema'|'error', pagesDone: number, chunksDone: number, tokens: number, pagesRemaining: number|null}>}
 */
export async function runBackfill(ctx, { deadlineMs = 30_000, pagesPerBatch = 24, cfg = embedConfig(), now = Date.now } = {}) {
  const started = now();
  const out = { stoppedBy: 'done', pagesDone: 0, chunksDone: 0, tokens: 0, pagesRemaining: null };
  if (!cfg.enabled) return { ...out, stoppedBy: 'off' };
  const cap = await embeddingDailyCap(ctx, cfg);
  for (;;) {
    let batch;
    try {
      batch = await withTenantRaw(ctx, async (db, tid) => {
        if (!(await semanticSchemaReady(db))) return { schema: false };
        const used = await tokensUsedToday(db);
        const pages = await pagesNeedingEmbedding(db, { model: cfg.model, limit: pagesPerBatch });
        return { schema: true, tid, used, pages };
      });
    } catch {
      return { ...out, stoppedBy: 'error' };
    }
    if (!batch.schema) return { ...out, stoppedBy: 'no-schema' };
    if (!batch.pages.length) { out.pagesRemaining = 0; return out; }
    if (batch.used + estimateTokens(batch.pages.map((p) => p.text)) > cap) return { ...out, stoppedBy: 'budget' };
    try {
      // Tighter network limits than the ingest hook: this runs inside a 60 s function that must return.
      const r = await embedAndStore(ctx, batch.tid, batch.pages, cfg, { timeoutMs: 12_000, maxRetries: 1 });
      out.pagesDone += r.pages;
      out.chunksDone += r.chunks;
      out.tokens += r.tokens;
    } catch (err) {
      console.warn(`semantic: backfill batch failed (${err?.name ?? 'Error'}${err?.status ? ` ${err.status}` : ''})`);
      return { ...out, stoppedBy: 'error' };
    }
    if (now() - started > deadlineMs) return { ...out, stoppedBy: 'deadline' };
  }
}

/* ------------------------------------------------------------ nearest chunks */

/** Whether this pgvector supports iterative index scans (0.8+); learned on first failure. */
let iterativeScan = true;
export function _resetIterativeScan() { iterativeScan = true; }

/**
 * The K nearest chunks to `vector` for the CURRENT tenant (RLS, plus an
 * explicit predicate), optionally restricted to `documentIds`, best chunk per
 * page, similarity >= minSim. Runs inside a SAVEPOINT so a runtime failure
 * cannot poison the surrounding transaction. Throws on failure — the caller
 * (hybrid.js) turns that into keyword-only.
 *
 * Iterative scan matters: the HNSW index spans every tenant, so without it a
 * tenant whose vectors are outnumbered could get fewer than K rows back after
 * the tenant filter is applied.
 * @returns {Promise<{id: string, document_id: string, page_no: number, original_filename: string, document_type: string, stage: string, chunk_text: string, sim: number}[]>}
 */
export async function nearestChunks(db, { vector, model, k = 30, documentIds = null, minSim = 0.25 }) {
  const params = [toVectorLiteral(vector), model, k];
  let scope = '';
  if (documentIds) { params.push(documentIds); scope = ` AND c.document_id = ANY($${params.length}::uuid[])`; }
  const sql =
    `WITH nn AS MATERIALIZED (
       SELECT c.document_id, c.page_no, c.text AS chunk_text, (c.embedding <=> $1::vector) AS dist
         FROM page_chunks c
        WHERE c.${TENANT} AND c.model = $2${scope}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3)
     SELECT p.id, nn.document_id, nn.page_no, d.original_filename, d.document_type, d.stage, nn.chunk_text, (1 - nn.dist) AS sim
       FROM nn
       JOIN document_pages p ON p.document_id = nn.document_id AND p.page_no = nn.page_no AND p.${TENANT}
       JOIN documents d ON d.id = nn.document_id AND d.${TENANT}
      ORDER BY nn.dist`;

  const attempt = async (useIterative) => {
    await db.query('SAVEPOINT dw_sem');
    try {
      await db.query(
        useIterative
          ? "SELECT set_config('hnsw.ef_search', '100', true), set_config('hnsw.iterative_scan', 'relaxed_order', true)"
          : "SELECT set_config('hnsw.ef_search', '100', true)"
      );
      return (await db.query(sql, params)).rows;
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT dw_sem').catch(() => {});
      throw err;
    }
  };

  let rows;
  try {
    rows = await attempt(iterativeScan);
  } catch (err) {
    if (!iterativeScan || !/iterative_scan|unrecognized configuration parameter|invalid value for parameter/i.test(String(err?.message))) throw err;
    iterativeScan = false; // older pgvector: no hnsw.iterative_scan. Remember, retry once without it.
    rows = await attempt(false);
  }
  const best = new Map();
  for (const r of rows) {
    const sim = Number(r.sim);
    if (!(sim >= minSim)) continue;
    if (!best.has(r.id)) best.set(r.id, { ...r, sim }); // rows are already nearest-first
  }
  return [...best.values()];
}

export { EmbedError };
