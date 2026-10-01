-- ============================================================================
-- 64-records-search-indexes.sql — R36. Idempotent; safe to re-run. Paste AFTER 62 and 63. Optional but recommended
-- BEFORE the first big import (a search over a 50,000-document shop is the slow path it fixes).
--
-- WHAT IT DOES
-- The Records search box (browseDocuments' `q`) is now answered from a candidate set of document ids built from four
-- index-friendly arms, each scoped to the shop, and only then joined to the page it returns:
--   1. file name / display name          -> idx_documents_filename_trgm (42), idx_documents_display_name_trgm (41)   (exist)
--   2. a linked customer's name / address, a linked unit's address / manufacturer
--                                         -> THREE NEW trigram expression indexes on entities (below)
--   3. the technician read off a document -> extractions_tenant_value_trgm_idx (17)                                   (exists)
--   4. words in the page text            -> document_pages_tenant_tsv_idx, GIN (tenant_id, tsv) on the generated tsvector (17)
-- plus one ordered index so the newest-first page + keyset "load more" walks documents in index order and stops at the page.
--
-- WHY A FUNCTION, NOT JUST INDEXES: the app connects as deepwell_rls, which is subject to row-level security. Under a
-- row-security policy Postgres will only push an operator into an index scan if it is "leakproof", and ILIKE (~~*) and the
-- tsvector match (@@) are not (pg_proc.proleakproof = false): with the indexes below in place, the same SQL still ran as
-- sequential scans of documents, entities and document_pages (measured at 50,000 documents: about 300 ms, vs 14 ms as the
-- table owner). records_search_candidates() runs the four arms as the function OWNER (the migration role, which bypasses
-- RLS on Neon - the same pattern as list_all_tenant_keys() in 60 and billing_record_event() in 59) with an EXPLICIT tenant
-- predicate on every table, so the indexes are used. It reads the shop from app.tenant_id exactly as the policies do and
-- returns nothing when that is unset; it returns document ids only, and the page query that calls it is still run as the
-- RLS role, so every other filter, the audience rule and the row data stay behind row-level security.
--
-- NO CODE DEPENDS ON THIS FILE. Without it the search runs the same arms inline (sequential scans, a few hundred ms at
-- 50,000 documents) and a common word is answered by walking the newest documents instead. Paste order does not matter
-- for correctness; this file needs 41 (documents.display_name) and 17 (document_pages.tsv) to have been pasted.
--
-- LIVE TABLE: plain CREATE INDEX blocks writes to the table while it builds. entities and documents are small today
-- (seconds); run this BEFORE the big import, not during it. If you ever need to add these to a table that is taking
-- writes, run each statement ONE AT A TIME with CONCURRENTLY, outside a transaction block (the Neon SQL editor runs a
-- single statement that way):
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_tenant_cust_name_trgm
--       ON entities USING GIN (tenant_id, (data->>'customer_name') gin_trgm_ops);   -- etc.
-- A failed CONCURRENTLY build leaves an INVALID index behind: DROP INDEX it and run it again (the proof query below shows validity).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Customer name, service address (customers and units), manufacturer: ILIKE '%text%' lookups, tenant first.
CREATE INDEX IF NOT EXISTS idx_entities_tenant_cust_name_trgm
  ON entities USING GIN (tenant_id, (data->>'customer_name') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_tenant_address_trgm
  ON entities USING GIN (tenant_id, (data->>'service_address') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_tenant_manufacturer_trgm
  ON entities USING GIN (tenant_id, (data->>'manufacturer') gin_trgm_ops);

-- Newest-first page with a stable tie-break: ORDER BY created_at DESC, id DESC, keyset (created_at, id) < (...).
CREATE INDEX IF NOT EXISTS idx_documents_tenant_created_id
  ON documents (tenant_id, created_at DESC, id DESC);

-- The search arms as one tenant-scoped set of document ids. p_like is the ILIKE pattern ('%text%'), p_q the raw text for the
-- full-text arm. SECURITY DEFINER + a pinned search_path; callable only by the application role(s).
CREATE OR REPLACE FUNCTION records_search_candidates(p_like text, p_q text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.id FROM documents x
   WHERE x.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
     AND (x.original_filename ILIKE p_like OR x.display_name ILIKE p_like)
  UNION
  SELECT del.document_id FROM entities e
    JOIN document_entity_links del ON del.entity_id = e.id AND del.tenant_id = e.tenant_id
   WHERE e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
     AND e.merged_into IS NULL
     AND (e.data->>'customer_name' ILIKE p_like OR e.data->>'service_address' ILIKE p_like OR e.data->>'manufacturer' ILIKE p_like)
  UNION
  SELECT x.document_id FROM extractions x
   WHERE x.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
     AND x.field_key = 'technician' AND x.value ILIKE p_like
  UNION
  SELECT x.document_id FROM document_pages x
   WHERE x.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
     AND x.tsv @@ websearch_to_tsquery('english', p_q);
$$;

REVOKE ALL ON FUNCTION records_search_candidates(text, text) FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION records_search_candidates(text, text) TO %I', r);
    END IF;
  END LOOP;
END $$;

ANALYZE entities;
ANALYZE documents;

-- ---- proof ------------------------------------------------------------------
-- Expect: four rows, indisvalid = true. Then one more row from the second query: prosecdef = true.
SELECT c.relname AS index_name, i.indisvalid
  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
 WHERE c.relname IN ('idx_entities_tenant_cust_name_trgm', 'idx_entities_tenant_address_trgm',
                     'idx_entities_tenant_manufacturer_trgm', 'idx_documents_tenant_created_id')
 ORDER BY c.relname;
SELECT p.proname, p.prosecdef FROM pg_proc p WHERE p.proname = 'records_search_candidates';
-- The function owner must bypass RLS (rolsuper or rolbypassrls = true), or the function sees no rows:
--   SELECT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'records_search_candidates';
