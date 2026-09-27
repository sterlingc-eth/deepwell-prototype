-- ============================================================================
-- 54-documents-scale-indexes.sql — Round 16 D2 #7/#8 (F4).
-- Idempotent; safe to re-run. No code depends on this landing (see contentCount.js's
-- own tsv-prefilter-with-fallback below) — this migration is a pure performance win,
-- never a correctness requirement.
--
-- The R16 D2 audit (../r16_d2_data.json) flagged two documents-table scans at scale:
--   #7: no (tenant_id, document_type) or (tenant_id, created_at) index — every
--       tenant-scoped "how many documents", document_type breakdown, or recency-
--       ordered document list (contentCount.js, financials, customerFile.js,
--       analytics.js) forces a Seq Scan across every tenant's rows once a tenant's
--       documents table reaches real scale.
--   #8: production content search (contentCount.js) issued a raw
--       `WHERE p.text ~* $1` regex sequential scan instead of first narrowing
--       through the existing document_pages tsv GIN index.
--
-- #8 is fixed IN CODE this round (api/_lib/contentCount.js's buildTsPrefilterQuery +
-- runContentCount: a `tsv @@ to_tsquery(...)` prefilter now runs first, inside its own
-- SAVEPOINT, falling back to the original plain-regex query untouched if the prefilter
-- throws for any reason — proven byte-for-byte identical on every golden content
-- question either way, migration 54 pasted or not) and needs no SQL here. It benefits
-- from document_pages_tenant_tsv_idx, already created by 17-ask-cache-and-search-
-- index.sql (`GIN (tenant_id, tsv)`) — nothing new to add for that side either.
--
-- #7's indexes THEMSELVES already exist in this repo's own migration history —
-- 40-rollups-and-semantic-cache.sql already defines idx_documents_tenant_created
-- (tenant_id, created_at DESC) and idx_documents_tenant_type (tenant_id,
-- document_type), and 42-records-browse.sql layers idx_documents_tenant_created_at
-- and idx_documents_tenant_type_stage on top. If 40 and 42 were already pasted into
-- this tenant's Neon instance, every statement below is a genuine no-op (IF NOT
-- EXISTS). This migration exists so the two indexes the audit named are guaranteed
-- to exist under this round's own number regardless of whether 40/42 ever landed —
-- paste 54 with no prerequisite, and it either confirms the same index already there
-- or creates it fresh.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_documents_tenant_type
  ON documents (tenant_id, document_type);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_created
  ON documents (tenant_id, created_at DESC);

-- ---- CONCURRENTLY note ------------------------------------------------------
-- SAFE NOW as a plain CREATE INDEX (same reasoning migrations 17/40 already give):
-- this repo's Neon SQL editor wraps a pasted migration in one implicit transaction,
-- and CREATE INDEX CONCURRENTLY cannot run inside a transaction block at all — so a
-- plain CREATE INDEX is the only form that can be pasted here as-is, and it is cheap
-- while a tenant's documents table is small.
--
-- ONCE A TENANT'S documents TABLE REACHES REAL SCALE (tens/hundreds of thousands of
-- rows) BEFORE THIS HAS BEEN PASTED, do NOT paste the two statements above directly —
-- a plain CREATE INDEX takes a table-wide lock (blocking every insert/update on
-- documents) for as long as the build takes, which is fine on a small table and NOT
-- fine on a live one under load. Instead, run each of these OUTSIDE a transaction,
-- one statement at a time (psql with autocommit, or Neon's own non-transactional
-- runner, never the SQL editor's default paste-and-run):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_tenant_type
--     ON documents (tenant_id, document_type);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_tenant_created
--     ON documents (tenant_id, created_at DESC);
-- CONCURRENTLY can fail partway through and leave an INVALID index behind (harmless,
-- but wastes space and is never used by the planner) — check afterward:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'documents' AND indexname IN
--     ('idx_documents_tenant_type', 'idx_documents_tenant_created')
--   AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--                     WHERE c.relname = pg_indexes.indexname AND NOT i.indisvalid);
-- and DROP INDEX + retry any invalid one found.

-- ---- verification ------------------------------------------------------------
-- Expect both index names below present (freshly created here, or already there
-- from migration 40):
SELECT indexname FROM pg_indexes
 WHERE tablename = 'documents'
   AND indexname IN ('idx_documents_tenant_type', 'idx_documents_tenant_created')
 ORDER BY indexname;
