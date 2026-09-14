-- ============================================================================
-- 03-retrieval.sql — run AFTER 02-tenancy-fix.sql. Idempotent; safe to re-run.
--
-- Adds the half of the system that answers questions.
--
-- The split Sterling described: R2 holds the file bytes, Postgres holds what
-- the files SAY plus a pointer back to the bytes. An answer is therefore always
-- traceable to a page of a real document, and the model never sees a fact that
-- isn't in a row here.
--
--   documents.storage_key  -> the R2 object key for the original file
--   document_pages.text    -> the text of one page, the unit we retrieve and cite
--   document_pages.tsv     -> generated full-text index over that text
--
-- document_pages also gets the tenancy it was missing: it had RLS ENABLEd in
-- 01 but no tenant_id column and no policy, which means the policy-less table
-- denied everything. It now carries tenant_id like every other table.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---- 1. pointer to the bytes ------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_key   TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_type  TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS page_count    INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extracted_at  TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extract_error TEXT;

-- ---- 2. what the pages say --------------------------------------------------
ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS text      TEXT;

-- Backfill tenant_id from the parent document for any rows written before this.
UPDATE document_pages p
   SET tenant_id = d.tenant_id
  FROM documents d
 WHERE p.document_id = d.id AND p.tenant_id IS NULL;

-- Generated, so the index can never drift from the text it indexes.
ALTER TABLE document_pages
  ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED;

CREATE INDEX IF NOT EXISTS document_pages_tsv_idx     ON document_pages USING GIN (tsv);
CREATE INDEX IF NOT EXISTS document_pages_trgm_idx    ON document_pages USING GIN (text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS document_pages_tenant_doc  ON document_pages (tenant_id, document_id, page_no);
CREATE UNIQUE INDEX IF NOT EXISTS document_pages_doc_page_uniq ON document_pages (document_id, page_no);

-- ---- 3. structured lookup (serials, model numbers, addresses) ---------------
-- A dispatcher asking "what's the warranty on serial 1234ABC" should hit an
-- index, not a table scan of every extraction the tenant owns.
CREATE INDEX IF NOT EXISTS extractions_tenant_field_idx ON extractions (tenant_id, field_key);
CREATE INDEX IF NOT EXISTS extractions_value_trgm_idx   ON extractions USING GIN (value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS facets_value_trgm_idx        ON facets      USING GIN (value_raw gin_trgm_ops);

-- ---- 4. tenancy on document_pages ------------------------------------------
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_pages_isolate ON document_pages;
CREATE POLICY document_pages_isolate ON document_pages
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 4b. two tables 02 missed ----------------------------------------------
-- `users` and `schema_versions` had RLS ENABLEd but never FORCEd, so the table
-- owner — which is exactly who the Neon connection string authenticates as —
-- read straight past their policies. Same defect 02 fixed for the other six.
ALTER TABLE users           FORCE ROW LEVEL SECURITY;
ALTER TABLE schema_versions FORCE ROW LEVEL SECURITY;

-- The original document_pages policy from 01 is now redundant, and it calls
-- current_setting() WITHOUT the missing_ok flag: with no tenant set it raises
-- instead of returning nothing, turning a scoping bug into a 500. Drop it so
-- the single tenant_id policy above is the only rule on the table.
DROP POLICY IF EXISTS tenants_isolate_document_pages ON document_pages;

-- ---- 5. grants for the application role ------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 6. proof ---------------------------------------------------------------
-- Expect: every table below reports rls=t and force=t, and document_pages has a
-- policy. If force is f anywhere, the owner still bypasses RLS and tenants leak.
SELECT c.relname                AS table,
       c.relrowsecurity         AS rls,
       c.relforcerowsecurity    AS force,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY 1;
