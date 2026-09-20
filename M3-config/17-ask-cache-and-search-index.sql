-- ============================================================================
-- 17-ask-cache-and-search-index.sql — run AFTER 16-notifications.sql.
-- Idempotent; safe to re-run. Two independent pieces:
--
--   1. documents.updated_at + ask_answer_cache — the per-tenant answer cache
--      for POST /api/ask (api/_lib/askCache.js). Paste this whole file once;
--      /api/ask already runs, and degrades to "always a miss" gracefully,
--      before this migration is applied (see askCache.js's `tableExists`).
--
--   2. Tenant-first composite GIN indexes for the retrieval queries in
--      api/_lib/recordsStore.js (searchPassages / searchExtractions).
--
-- See handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md for the full writeup.
-- ============================================================================

-- ---- 1a. documents.updated_at ----------------------------------------------
-- Every other answer-changing write already bumps a timestamp
-- api/_lib/askCache.js's corpus_stamp can see: extractions.corrected_at/
-- created_at (correction / re-extraction), document_entity_links.created_at
-- (link/unlink/assignDocumentCustomer — always a delete+insert, never an
-- in-place update), entities.updated_at (merge, customer/equipment field
-- fills), and documents' own count(*) FILTER (WHERE stage='verified') for
-- verify/unverify. The one gap: reviewStore.js's classifyDocument changes
-- document_type — which changes the label on every answer citing this
-- document — and touches nothing else. This column gives it a timestamp to
-- bump (see that function's one-line diff) instead of folding document_type
-- itself into the stamp as an O(n) string_agg. Backfilled from created_at so
-- MAX() is never NULL for a tenant that has never reclassified anything.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE documents SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL;

-- ---- 1b. ask_answer_cache ---------------------------------------------------
-- One row per (tenant, question_hash) — a re-ask overwrites it (ON CONFLICT
-- DO UPDATE in askCache.js's upsertCacheEntry), it does not accumulate rows.
-- A row is only ever REUSED when corpus_stamp AND today both still match
-- (api/_lib/askCache.js's isCacheHit + COMBINED_SQL's `today` predicate) and
-- it is under 24h old (checked in JS, so the TTL rule stays pure/testable —
-- see scripts/verify-ask-cache.mjs). Same RLS shape as every other
-- per-tenant table (12-rate-limit-window.sql, 16-notifications.sql).
CREATE TABLE IF NOT EXISTS ask_answer_cache (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_hash TEXT NOT NULL,
  corpus_stamp  TEXT NOT NULL,
  today         DATE NOT NULL,
  answer        JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, question_hash)
);

ALTER TABLE ask_answer_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_answer_cache FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_ask_answer_cache ON ask_answer_cache;
CREATE POLICY tenants_isolate_ask_answer_cache ON ask_answer_cache
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ask_answer_cache TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 2. tenant-first composite search indexes ------------------------------
-- searchPassages/searchExtractions (api/_lib/recordsStore.js) already filter
-- with an EXPLICIT `tenant_id = (current_setting('app.tenant_id', true))::uuid`
-- predicate in application SQL (belt-and-braces alongside RLS — see that
-- file's own header comment), not just RLS's USING clause. That means the
-- planner sees this qual as an ordinary WHERE-clause condition either way —
-- RLS predicates are pushed into the plan as normal quals too, Postgres does
-- not hide them from index selection — so a composite index leading with
-- tenant_id is usable for both paths and NO CODE CHANGE is needed for the
-- planner to prefer it over the single-column indexes.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- document_pages: searchPassages' full-text pass filters on tenant_id AND
-- `p.tsv @@ q.tsq`. The existing document_pages_tsv_idx (tsv alone, from
-- 03-retrieval.sql / 11-fix-tsv.sql) makes Postgres either intersect two
-- separate scans or walk every tenant's matching rows before filtering by
-- tenant; this lets one Bitmap Index Scan do both at once.
CREATE INDEX IF NOT EXISTS document_pages_tenant_tsv_idx
  ON document_pages USING GIN (tenant_id, tsv);

-- extractions: searchExtractions filters on tenant_id AND
-- `x.value ILIKE ANY(...)` (trigram). Same reasoning; extractions_value_
-- trgm_idx (value alone) is kept — this is additive, not a replacement.
CREATE INDEX IF NOT EXISTS extractions_tenant_value_trgm_idx
  ON extractions USING GIN (tenant_id, value gin_trgm_ops);

-- Nothing here searches `facets` directly (searchPassages/searchExtractions
-- only ever read document_pages and extractions), so no composite index is
-- added for facets_value_trgm_idx — it would be speculative, not additive.

-- Old single-column indexes are NOT dropped: document_pages_tsv_idx,
-- document_pages_trgm_idx, extractions_value_trgm_idx (03-retrieval.sql) all
-- stay — an unscoped or cross-tenant query, if one is ever added, still
-- needs them.

-- SAFE NOW, plain CREATE INDEX (no CONCURRENTLY): both tables are small (a
-- handful of documents per tenant today) and this runs inside whatever
-- transaction the Neon SQL editor wraps pasted statements in — CONCURRENTLY
-- cannot run inside a transaction block at all. If either table grows into
-- the tens of thousands of rows for one tenant, rebuild these later with
-- CREATE INDEX CONCURRENTLY instead, run OUTSIDE a transaction (psql with
-- autocommit — not the SQL editor's paste-and-run), one statement at a time.

-- Confirm the planner actually uses it — run by hand (not part of this
-- migration; needs a real session with app.tenant_id already set the way an
-- authenticated request sets it):
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT p.id FROM document_pages p
--    WHERE p.tenant_id = (current_setting('app.tenant_id', true))::uuid
--      AND p.tsv @@ websearch_to_tsquery('english', 'warranty furnace');
-- Expect a line reading "Bitmap Index Scan on document_pages_tenant_tsv_idx"
-- (not document_pages_tsv_idx alone, and not a Seq Scan).

-- ---- proof -------------------------------------------------------------
-- Expect: one row, rls=t, force=t.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ask_answer_cache';
-- Expect: one row — the (tenant_id, question_hash) primary key.
SELECT conname FROM pg_constraint WHERE conrelid = 'ask_answer_cache'::regclass AND contype = 'p';
-- Expect: two rows — document_pages_tenant_tsv_idx, extractions_tenant_value_trgm_idx.
SELECT indexname FROM pg_indexes WHERE tablename IN ('document_pages','extractions') AND indexname LIKE '%tenant%';
-- Expect: one row — documents.updated_at, timestamptz, no NULLs remaining.
SELECT count(*) AS total, count(*) FILTER (WHERE updated_at IS NULL) AS still_null FROM documents;
