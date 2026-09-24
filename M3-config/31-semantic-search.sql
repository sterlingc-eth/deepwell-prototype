-- ============================================================================
-- 31-semantic-search.sql — run AFTER 29-donovan-recipes.sql. Idempotent; safe
-- to re-run.
--
-- SEARCH BY MEANING. Today retrieval
-- is keyword-only (Postgres full-text + ILIKE), so "any complaints about
-- noise" misses a page that says "unit is loud". This adds:
--
--   page_chunks     — ~1000-character, page-aware slices of each document
--                     page, each with an embedding vector. Retrieval finds the
--                     nearest chunks by cosine distance, maps each back to its
--                     (document, page), and fuses that with the keyword results
--                     (api/_lib/search/hybrid.js). Every hit still cites a
--                     real page.
--   embedding_usage — per-tenant, per-day count of embedding tokens spent, so
--                     the code can enforce a daily embedding budget.
--
-- NOTHING BREAKS IF THIS IS NOT PASTED (or if pgvector is unavailable): the
-- code probes for the table and the extension, and with either missing the
-- feature is silently off and keyword search is exactly what it is today. The
-- probe is re-run every few minutes, so pasting this turns the feature on
-- without a redeploy (it still needs VOYAGE_API_KEY in Vercel).
--
-- DIMENSION: vector(1024) matches Voyage's default output for voyage-3.5-lite
-- (and voyage-4-lite). If you ever switch to a model/dimension that differs,
-- add a NEW column or table — do not ALTER this one in place — and set
-- DONOVAN_EMBED_DIM to match. Rows are keyed by `model`, so old and new model
-- rows can coexist while a backfill runs; queries only read the current model.
--
-- RLS: identical tenant policy to 08-review.sql — ENABLE + FORCE, one policy.
-- Grants: none needed; 01b's ALTER DEFAULT PRIVILEGES already covers new
-- tables for deepwell_rls.
-- ============================================================================

-- ---- 1. pgvector (Neon supports it; no superuser step needed) --------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---- 2. page_chunks ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_chunks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  chunk_no    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  -- md5 of the page text this chunk was cut from: lets the ingest hook and the
  -- backfill skip pages that are already embedded and re-embed a page that was
  -- re-read with different text.
  page_hash   TEXT,
  embedding   vector(1024) NOT NULL,
  model       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, document_id, page_no, chunk_no, model)
);

CREATE INDEX IF NOT EXISTS idx_page_chunks_tenant_doc
  ON page_chunks (tenant_id, document_id, page_no);

-- Approximate nearest-neighbour index. Cosine, to match how Voyage vectors are
-- compared. (Built empty here, so this is instant; it fills as rows arrive.)
CREATE INDEX IF NOT EXISTS idx_page_chunks_embedding_hnsw
  ON page_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE page_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_chunks FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_page_chunks ON page_chunks;
CREATE POLICY tenants_isolate_page_chunks ON page_chunks
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 3. embedding_usage (daily budget counter) -----------------------------
CREATE TABLE IF NOT EXISTS embedding_usage (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  tokens    BIGINT NOT NULL DEFAULT 0,
  calls     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE embedding_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_usage FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_embedding_usage ON embedding_usage;
CREATE POLICY tenants_isolate_embedding_usage ON embedding_usage
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 4. proof ---------------------------------------------------------------
-- Expect: one row, extname = 'vector'.
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- Expect: two rows, both relrowsecurity = true and relforcerowsecurity = true.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('page_chunks', 'embedding_usage') ORDER BY relname;

-- Expect: the hnsw index is listed.
SELECT indexname FROM pg_indexes WHERE tablename = 'page_chunks' ORDER BY indexname;
