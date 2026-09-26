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
  buildChunkContextHeader, withContextHeader, NO_CONTEXT_VERSION, CURRENT_CONTEXT_VERSION,
  estimateEmbedCostUsd,
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

export function _resetSemanticProbe() { probe = null; ctxColProbe = null; }

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

/** { ok, at } cache for the M3-config/38 `page_chunks.context_version` column, same TTL contract as
 *  `probe` above (semanticSchemaReady): `true` sticks, `false` is re-checked every few minutes so
 *  pasting the migration needs no redeploy. Independent of `probe` — a tenant can have the base
 *  semantic-search schema without this later, optional column. */
let ctxColProbe = null;
export function _resetContextVersionProbe() { ctxColProbe = null; }

/** Is page_chunks.context_version present (M3-config/38)? Without it, headers are still built and
 *  embedded (that needs no schema change), but there is no way to tell an old chunk from a new one,
 *  so the backfill just treats "no chunk yet" as the only thing needing embedding — exactly today's
 *  behavior. `db` is any client already inside a tenant transaction (this reads only the catalog). */
export async function contextVersionReady(db, now = Date.now()) {
  if (ctxColProbe && (ctxColProbe.ok || now - ctxColProbe.at < PROBE_FALSE_TTL_MS)) return ctxColProbe.ok;
  try {
    const r = await db.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'page_chunks' AND column_name = 'context_version') AS ok`
    );
    ctxColProbe = { ok: Boolean(r.rows[0]?.ok), at: now };
  } catch {
    return false;
  }
  return ctxColProbe.ok;
}

/* ------------------------------------------------------- contextual chunk headers */

/** extraction field_keys a chunk-context header is built from — see extractFields.js's FIELD_SPECS
 *  for what each canonically means, and embed.js's buildChunkContextHeader for how they're combined.
 *  Document-level, not per-unit: a multi-unit document's header uses whichever unit's fields were
 *  recorded first for the manufacturer/model/serial slots (DISTINCT ON below) — a header is a
 *  retrieval aid, not a citation of record, so this deliberate simplification costs nothing: the
 *  real per-unit facts still come from `extractions`/entities, unaffected by this. */
const CONTEXT_FIELD_KEYS = [
  'customer_name', 'service_address', 'manufacturer', 'model', 'serial_number',
  'service_date', 'technician', 'invoice_number',
];

/**
 * One best-effort read of the structured facts buildChunkContextHeader needs, for every document in
 * `documentIds`. Never throws itself (embedAndStore treats a failure here as "no header this round"
 * rather than blocking embedding) — but IS tenant-scoped like everything else here, so a caller that
 * wants that guarantee should catch around it, same as any other withTenantRaw call.
 * @returns {Promise<Map<string, {documentType: string|null, [field_key: string]: string}>>}
 */
export async function documentContextFacts(ctx, documentIds) {
  const ids = [...new Set(documentIds ?? [])];
  if (!ids.length) return new Map();
  return withTenantRaw(ctx, async (db) => {
    const docRows = (await db.query(
      `SELECT id, document_type FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT}`, [ids]
    )).rows;
    const out = new Map(ids.map((id) => [id, { documentType: null }]));
    for (const r of docRows) out.set(r.id, { documentType: r.document_type ?? null });
    const factRows = (await db.query(
      `SELECT DISTINCT ON (document_id, field_key) document_id, field_key, value
         FROM extractions
        WHERE document_id = ANY($1::uuid[]) AND field_key = ANY($2::text[]) AND ${TENANT}
          AND value IS NOT NULL AND btrim(value) <> ''
        ORDER BY document_id, field_key, created_at ASC NULLS LAST, id ASC`,
      [ids, CONTEXT_FIELD_KEYS]
    )).rows;
    for (const r of factRows) out.get(r.document_id)[r.field_key] = r.value;
    return out;
  });
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

/**
 * Pages (of one document, or of the whole tenant) with no UP TO DATE chunk for the current model.
 * "Up to date" means the page text hasn't changed since it was last chunked (page_hash, as always)
 * AND — when M3-config/38's column is present — its chunk's context_version is at least
 * `neededVersion`. That second clause is what lets the same query, and the same resumable/
 * cost-capped loop (runBackfill), also serve as the "re-embed chunks whose context_version is old"
 * backfill: a chunk embedded before this feature (or while DONOVAN_CHUNK_CONTEXT=0) is
 * context_version 0, which is "not up to date" the moment neededVersion is 1 or more.
 */
async function pagesNeedingEmbedding(db, { model, documentId = null, limit, neededVersion = NO_CONTEXT_VERSION }) {
  const versioned = await contextVersionReady(db);
  const upToDate = versioned
    ? `c.model = $1 AND c.page_hash = md5(p.text) AND c.context_version >= ${Math.trunc(neededVersion)}`
    : `c.model = $1 AND c.page_hash = md5(p.text)`;
  const r = await db.query(
    `SELECT p.document_id, p.page_no, p.text, md5(p.text) AS page_hash
       FROM document_pages p
      WHERE p.${TENANT}
        AND length(btrim(p.text)) > 0
        ${documentId ? 'AND p.document_id = $3' : ''}
        AND NOT EXISTS (
              SELECT 1 FROM page_chunks c
               WHERE c.tenant_id = p.tenant_id AND c.document_id = p.document_id
                 AND c.page_no = p.page_no AND ${upToDate})
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
 *
 * CONTEXTUAL HEADERS (see embed.js's buildChunkContextHeader): when
 * cfg.chunkContext is on (the default), every chunk of a document gets that
 * document's header prepended before embedding — one extra, best-effort read
 * (documentContextFacts) per call, never one per chunk. A facts-lookup
 * failure just means no header this round (embedding still happens), and a
 * document with no header-worthy facts yet (the common case for the ingest
 * hook, which runs BEFORE extraction — see readDocument.js) embeds exactly
 * the raw chunk text, same as before this feature existed; the later
 * semantic-backfill re-embed picks it up once extraction has run.
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

  const targetVersion = cfg.chunkContext ? CURRENT_CONTEXT_VERSION : NO_CONTEXT_VERSION;
  let headerByDoc = new Map();
  if (cfg.chunkContext) {
    headerByDoc = await documentContextFacts(ctx, [...byDoc.keys()])
      .then((factsByDoc) => new Map([...factsByDoc].map(([id, facts]) => [id, buildChunkContextHeader(facts)])))
      .catch((err) => {
        console.warn(`semantic: could not read chunk-context facts (${err?.name ?? 'Error'}); embedding without a header this round`);
        return new Map();
      });
  }
  const embedTexts = chunks.map((c) => withContextHeader(headerByDoc.get(c.document_id), c.text));

  const { vectors, tokens, calls } = await voyageEmbed(embedTexts, { inputType: 'document', cfg, ...net });

  await withTenantRaw(ctx, async (db, tid) => {
    const versioned = await contextVersionReady(db);
    for (const [document_id, ps] of byDoc) {
      await db.query(
        `DELETE FROM page_chunks WHERE ${TENANT} AND document_id = $1 AND model = $2 AND page_no = ANY($3::int[])`,
        [document_id, cfg.model, ps.map((p) => p.page_no)]
      );
    }
    for (let i = 0; i < chunks.length; i += INSERT_ROWS_PER_STATEMENT) {
      const slice = chunks.slice(i, i + INSERT_ROWS_PER_STATEMENT);
      const vals = [];
      const cols = versioned ? 9 : 8;
      const tuples = slice.map((c, j) => {
        const idx = i + j;
        const b = j * cols;
        vals.push(tid, c.document_id, c.page_no, c.chunk_no, embedTexts[idx], c.page_hash, toVectorLiteral(vectors[idx]), cfg.model);
        if (versioned) vals.push(targetVersion);
        const ph = [1, 2, 3, 4, 5, 6].map((n) => `$${b + n}`).join(',');
        return versioned
          ? `(${ph},$${b + 7}::vector,$${b + 8},$${b + 9})`
          : `(${ph},$${b + 7}::vector,$${b + 8})`;
      });
      await db.query(
        versioned
          ? `INSERT INTO page_chunks (tenant_id, document_id, page_no, chunk_no, text, page_hash, embedding, model, context_version)
             VALUES ${tuples.join(',')}
             ON CONFLICT (tenant_id, document_id, page_no, chunk_no, model)
             DO UPDATE SET text = EXCLUDED.text, page_hash = EXCLUDED.page_hash, embedding = EXCLUDED.embedding, context_version = EXCLUDED.context_version`
          : `INSERT INTO page_chunks (tenant_id, document_id, page_no, chunk_no, text, page_hash, embedding, model)
             VALUES ${tuples.join(',')}
             ON CONFLICT (tenant_id, document_id, page_no, chunk_no, model)
             DO UPDATE SET text = EXCLUDED.text, page_hash = EXCLUDED.page_hash, embedding = EXCLUDED.embedding`,
        vals
      );
    }
    await recordEmbeddingUsage(db, tid, tokens, calls);
  });
  console.log(JSON.stringify({ route: 'semantic', t: 'embed_pages', pages: pages.length, chunks: chunks.length, tokens, model: cfg.model, contextVersion: targetVersion }));
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
      const neededVersion = cfg.chunkContext ? CURRENT_CONTEXT_VERSION : NO_CONTEXT_VERSION;
      const pages = await pagesNeedingEmbedding(db, { model: cfg.model, documentId, limit: HOOK_MAX_PAGES, neededVersion });
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

/** Progress numbers for the Team-screen card. Cheap: three counts and one sum, plus (when
 *  M3-config/38 is present) how many already-embedded chunks are behind the current chunk-context
 *  header version and a rough $ estimate for re-embedding them — an operator's pre-flight number
 *  before they trigger semanticBackfill again; never computed automatically, never billed off of. */
export async function semanticStatus(ctx, { cfg = embedConfig() } = {}) {
  const base = { configured: cfg.enabled, model: cfg.model, rerank: Boolean(cfg.rerankModel), chunkContext: cfg.chunkContext, contextVersion: CURRENT_CONTEXT_VERSION };
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
    const out = { ...base, ready: true, pagesTotal: total, pagesEmbedded: embedded, pagesRemaining: Math.max(0, total - embedded), chunks, tokensToday: used, tokenBudget: cap };
    if (await contextVersionReady(db)) {
      const stale = Number((await db.query(
        `SELECT count(*)::int AS n FROM page_chunks c WHERE c.${TENANT} AND c.model = $1 AND c.context_version < $2`,
        [cfg.model, CURRENT_CONTEXT_VERSION]
      )).rows[0]?.n ?? 0);
      out.chunksNeedingContextUpdate = stale;
      out.estimatedReembedCostUsd = Number(estimateEmbedCostUsd(stale).toFixed(4));
    }
    out.estimatedCostUsdPer1kChunks = Number(estimateEmbedCostUsd(1000).toFixed(4));
    return out;
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
        const neededVersion = cfg.chunkContext ? CURRENT_CONTEXT_VERSION : NO_CONTEXT_VERSION;
        const pages = await pagesNeedingEmbedding(db, { model: cfg.model, limit: pagesPerBatch, neededVersion });
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

/* --------------------------------------------------- per-tenant ANN tuning (TEAM T2, 2026-09-25) */

/** ef_search bounds the HNSW candidate list BEFORE the tenant filter is applied — and the index spans
 *  EVERY tenant, so a tenant with a small slice of a huge shared index needs a wider candidate list to
 *  keep recall up than a tenant whose corpus is most of the index already. Pure; exported for tests. */
export function annEfSearchForScale(chunkCount) {
  const n = Number(chunkCount) || 0;
  if (n > 200_000) return 400;
  if (n > 20_000) return 200;
  return 100;
}

const annScaleCache = new Map(); // tenant_id -> { at, chunks }
const ANN_SCALE_CACHE_TTL_MS = 10 * 60_000;
export function _resetAnnScaleCache() { annScaleCache.clear(); }

/** Cached (10 min) count of the CURRENT tenant's own chunks, used to pick ef_search automatically
 *  when the caller doesn't pass one. One cheap indexed count per cold tenant per cache window, not
 *  per search. Never throws — falls back to the default scale on any error. */
async function tenantAnnEfSearch(db, now = Date.now()) {
  try {
    const tid = (await db.query("SELECT current_setting('app.tenant_id', true) AS tid")).rows[0]?.tid;
    if (!tid) return annEfSearchForScale(0);
    const hit = annScaleCache.get(tid);
    if (hit && now - hit.at < ANN_SCALE_CACHE_TTL_MS) return annEfSearchForScale(hit.chunks);
    const chunks = Number((await db.query(`SELECT count(*)::int AS n FROM page_chunks WHERE ${TENANT}`)).rows[0]?.n ?? 0);
    annScaleCache.set(tid, { at: now, chunks });
    return annEfSearchForScale(chunks);
  } catch {
    return annEfSearchForScale(0);
  }
}

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
 * @param {number} [efSearch]  explicit hnsw.ef_search override (tests only);
 *   omitted, it is chosen automatically from this tenant's own chunk count
 *   (annEfSearchForScale) — see the per-tenant ANN tuning note above.
 * @returns {Promise<{id: string, document_id: string, page_no: number, original_filename: string, document_type: string, stage: string, chunk_text: string, sim: number}[]>}
 */
export async function nearestChunks(db, { vector, model, k = 30, documentIds = null, minSim = 0.25, efSearch } = {}) {
  const ef = Math.max(10, Math.min(1000, Math.trunc(Number(efSearch)) || (await tenantAnnEfSearch(db))));
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
          ? `SELECT set_config('hnsw.ef_search', '${ef}', true), set_config('hnsw.iterative_scan', 'relaxed_order', true)`
          : `SELECT set_config('hnsw.ef_search', '${ef}', true)`
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
