-- ============================================================================
-- 40-rollups-and-semantic-cache.sql — run AFTER 38-chunk-context.sql. Idempotent;
-- safe to re-run. Three independent pieces (R11, literature #7 + #9 + #10):
--
--   1. ask_semantic_cache — a SECOND, fuzzier answer cache layered AFTER the
--      existing exact-match cache (api/_lib/askCache.js / ask_answer_cache,
--      migration 17). A question that paraphrases one already answered
--      ("any noise complaints" vs "were there complaints about noise") can
--      hit this even though its normalized-question hash differs. Read/write
--      helpers: api/_lib/cache/semanticCache.js (lookupSemantic/storeSemantic).
--      NOTHING BREAKS IF THIS IS NOT PASTED — same tableExists-probe idiom as
--      askCache.js/store.js; the feature is silently off until applied.
--
--   2. tenant_rollups — precomputed hot aggregates (equipment brand counts,
--      document-type counts, warranty-status counts, open-invoice totals) so
--      a large tenant's "how many X by Y" doesn't re-scan its whole corpus on
--      every ask. Read/write helpers: api/_lib/rollups/*.js. Also safe to
--      skip: read helpers fall back to the live SQL analytics already runs
--      when this table is empty/stale/missing (see freshness check there).
--
--   3. Missing-index fixes found by the 300k-document scale benchmark
--      (scripts/bench/synth-tenant.mjs, scripts/bench/run.mjs) — see the
--      comment above each CREATE INDEX below for the specific query it helps
--      and the EXPLAIN evidence.
--
-- RLS: identical tenant policy to every other per-tenant table in this repo
-- (08-review.sql, 17, 31, ...). Grants: none needed for the two new tables —
-- 01b's ALTER DEFAULT PRIVILEGES already covers new tables for deepwell_rls;
-- the explicit GRANT block below is belt-and-braces only, same as 17's.
-- ============================================================================

-- ---- 0. pgvector (already required by migration 31; re-declared here so
-- this file loads standalone too, e.g. a fresh DB that skipped 31) ----------
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 1. ask_semantic_cache
-- ============================================================================
-- Unlike ask_answer_cache (one row per tenant+question_hash, upserted), this
-- table ACCUMULATES rows — a semantic hit is a nearest-neighbour search, not
-- an exact key lookup, so there is no natural single key to upsert onto.
-- Bounded by the TTL (checked in app code, same as ask_answer_cache's 24h)
-- plus best-effort pruning from storeSemantic (see that file's doc comment).
--
-- slot_signature: a stable, order-independent string built from the EXACT
-- entity names/numbers/dates/addresses/brands api/_lib/cache/semanticCache.js
-- extracted from the question — "Trane units in Mesa" and "Trane units in
-- Tempe" get DIFFERENT slot_signatures and can never hit each other's row,
-- regardless of how close their embeddings are. Checked in application code
-- (exact string equality) alongside the similarity threshold, not delegated
-- to SQL, so the invariant is testable with no database (scripts/verify-
-- semantic-cache.mjs).
--
-- fallback_signature: a deterministic normalized-token signature (sorted,
-- de-stopworded token bag) used for lookup WHEN NO EMBEDDING IS AVAILABLE
-- (VOYAGE_API_KEY unset, DONOVAN_SEMANTIC=0, or embedQuery returned null for
-- this request) — an exact match on this column is still a real, if coarser,
-- semantic-ish hit (word-order-independent), never a similarity search.
--
-- embedding is NULLABLE: a row stored while embeddings were unavailable has
-- no vector at all and is only ever found via fallback_signature.
CREATE TABLE IF NOT EXISTS ask_semantic_cache (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  corpus_stamp        TEXT NOT NULL,
  slot_signature      TEXT NOT NULL,
  fallback_signature  TEXT NOT NULL,
  embedding           vector(1024),
  embed_model         TEXT,
  question_norm       TEXT NOT NULL,
  answer              JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fallback (no-embedding) lookup path: exact match on (tenant, slots, corpus, fallback sig).
CREATE INDEX IF NOT EXISTS idx_ask_semantic_cache_fallback
  ON ask_semantic_cache (tenant_id, slot_signature, corpus_stamp, fallback_signature);

-- Embedding lookup path: nearest-neighbour, narrowed by tenant first (same
-- reasoning as migration 31's page_chunks HNSW index — a plain vector index
-- has no way to push tenant_id into the ANN search itself, so the candidate
-- set is still narrowed by the tenant/slot/stamp WHERE clause and this index
-- only speeds the ORDER BY <-> LIMIT k once that's done).
CREATE INDEX IF NOT EXISTS idx_ask_semantic_cache_embedding_hnsw
  ON ask_semantic_cache USING hnsw (embedding vector_cosine_ops);

-- Pruning (best-effort, from storeSemantic) and TTL housekeeping.
CREATE INDEX IF NOT EXISTS idx_ask_semantic_cache_tenant_created
  ON ask_semantic_cache (tenant_id, created_at);

ALTER TABLE ask_semantic_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_semantic_cache FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_ask_semantic_cache ON ask_semantic_cache;
CREATE POLICY tenants_isolate_ask_semantic_cache ON ask_semantic_cache
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ============================================================================
-- 2. tenant_rollups
-- ============================================================================
-- One row per (tenant, metric, bucket): a metric is a family of hot
-- aggregates ('equipment_brand', 'document_type', 'warranty_status',
-- 'customer_city', 'open_invoices'); bucket is the group key within it (a
-- brand name, a document_type string, a warranty status, a city, or the
-- literal 'total' for the single-row open_invoices metric). `count` and
-- `sum_cents` cover every metric this file's read helpers know about today
-- (sum_cents is NULL for pure counts). `corpus_stamp` reuses the EXACT same
-- expression api/_lib/askCache.js already computes (STAMP_EXPR, imported by
-- api/_lib/rollups/refresh.js, not re-derived) so "is this rollup stale"
-- never disagrees with "is the exact-match answer cache stale" — one
-- invalidation signal for both features.
CREATE TABLE IF NOT EXISTS tenant_rollups (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  count         BIGINT NOT NULL DEFAULT 0,
  sum_cents     BIGINT,
  corpus_stamp  TEXT NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, metric, bucket)
);

ALTER TABLE tenant_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_rollups FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_tenant_rollups ON tenant_rollups;
CREATE POLICY tenants_isolate_tenant_rollups ON tenant_rollups
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ask_semantic_cache TO %I', r);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_rollups TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 3. Missing-index fixes (scripts/bench/run.mjs, 300k/30k synthetic tenant)
-- ============================================================================

-- HEADLINE FINDING: `documents` (M3-config/01-create-schema.sql) has NEVER
-- had an index touching tenant_id — not even a plain one. Every query that
-- reads it (RLS's own USING clause included, plus every explicit
-- `WHERE tenant_id = ... AND document_type = ...` in analytics.js/
-- contentCount.js/financials, every "how many documents" count, every
-- customerFile.js "documents by type" breakdown) forces a Seq Scan of the
-- ENTIRE cross-tenant documents table, not just the asking tenant's rows.
-- At a synthetic 300k-document single tenant this benchmarked as the single
-- worst path in the corpus (see bench output pasted in the round's handoff /
-- final report) — confirmed with EXPLAIN (ANALYZE, BUFFERS) showing
-- "Seq Scan on documents" before this index, "Index Scan using
-- idx_documents_tenant_created" (or _tenant_type) after.
CREATE INDEX IF NOT EXISTS idx_documents_tenant_created
  ON documents (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_type
  ON documents (tenant_id, document_type);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_stage
  ON documents (tenant_id, stage);

-- entities: idx_entities_tenant_type (01-create-schema.sql) already covers
-- entity_type grouping, but every read also filters `merged_into IS NULL`
-- (a merge marks the losing row rather than deleting it — see 08-review.sql)
-- and that predicate is never in the index, so the planner still visits
-- every merged-away row. A partial index drops them from the index entirely
-- (smaller, and merged rows never need to be found this way again).
CREATE INDEX IF NOT EXISTS idx_entities_tenant_type_active
  ON entities (tenant_id, entity_type)
  WHERE merged_into IS NULL;

-- document_financials itself is already well-indexed (22-document-
-- financials.sql: idx_docfin_tenant_kind, idx_docfin_tenant_date,
-- idx_docfin_open_due WHERE status IN ('unpaid','partial')) — the bench
-- found no missing index there. NOTE: `open_balance`/`days_past_due` seen in
-- api/_lib/financials/answers.js are CASE expressions computed by the
-- `financials` CTE (api/_lib/agent/financeViews.js), not real columns on
-- document_financials, so no partial index can reference them directly; a
-- rollup (open_invoices, below) is the right fix for that path at scale, not
-- an index. Left alone here (that CTE belongs to the financials-view owner).

-- ---- CONCURRENTLY note ------------------------------------------------------
-- SAFE NOW, plain CREATE INDEX, same reasoning as migration 17: this repo's
-- Neon SQL editor wraps a pasted migration in one transaction, and
-- CONCURRENTLY cannot run inside a transaction block. These are all cheap
-- while the corpus is small. ONCE A TENANT'S `documents` OR `entities` TABLE
-- IS IN THE TENS/HUNDREDS OF THOUSANDS OF ROWS (the scale this bench
-- targets), rebuild idx_documents_tenant_created/idx_documents_tenant_type/
-- idx_documents_tenant_stage/idx_entities_tenant_type_active with
-- CREATE INDEX CONCURRENTLY instead, run OUTSIDE a transaction (psql with
-- autocommit, one statement at a time, DROP INDEX then CREATE INDEX
-- CONCURRENTLY under a new temporary name and swap) — otherwise the plain
-- CREATE INDEX above takes a table-wide lock for however long the build
-- takes, which is fine on an empty/small table and NOT fine on a live
-- 300k-row one.

-- ---- proof -------------------------------------------------------------
-- Expect: two rows, both rls=t and force=t.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('ask_semantic_cache', 'tenant_rollups') ORDER BY relname;
-- Expect: the hnsw index is listed.
SELECT indexname FROM pg_indexes WHERE tablename = 'ask_semantic_cache' ORDER BY indexname;
-- Expect: three rows — the new documents indexes.
SELECT indexname FROM pg_indexes WHERE tablename = 'documents' AND indexname LIKE 'idx_documents_tenant%' ORDER BY indexname;
