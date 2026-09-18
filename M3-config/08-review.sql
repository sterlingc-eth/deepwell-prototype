-- ============================================================================
-- 08-review.sql — run AFTER 05-customer-link.sql. Idempotent; safe to re-run.
--
-- Gives the review screen somewhere real to write to. Before this, every
-- review action (correcting a field, linking a document to a record, marking
-- it verified) was a pure in-memory zustand setter — nothing server-side ever
-- recorded a correction, a manual link, or a verification, and no document
-- ever reached stage='verified' outside the demo fixture.
--
-- What this adds:
--   document_entity_links — a document can be linked to more than one entity
--                            (a service ticket often touches one unit AND one
--                            customer), and a link needs its own row: who made
--                            it and when, independent of any extraction.
--   extractions.corrected_value / corrected_by / corrected_at
--                          — a human correction to an extracted field, kept
--                            NEXT TO the original `value` rather than
--                            overwriting it. The original stays the record of
--                            what the document actually said; `corrected_*`
--                            is the record of what a person decided it means.
--   documents.verified_by / verified_at
--                          — who moved a document to 'verified' and when.
--                            `stage='verified'` already existed (01's CHECK
--                            constraint already allows it) but nothing ever
--                            wrote it or said who was responsible.
--   entities.merged_into  — when two entity rows turn out to be the same
--                            unit/customer, the duplicate is never deleted
--                            (every extraction and link that named it must
--                            keep resolving to something); it is repointed
--                            and flagged with merged_into instead.
--
-- Forward-only stage transitions (linked -> verified, verified -> linked on a
-- correction) are enforced in api/_lib/reviewStore.js's SQL, the same
-- `WHERE stage = '...'` idiom recordsStore.js already uses for
-- mapped -> linked and received/read -> mapped — never trusted from a value
-- the client sends. `stage` and `storage_key` remain OUT of
-- DOCUMENT_UPDATE_COLUMNS (recordsStore.js) on purpose; nothing here reopens
-- that hole; document_entity_links, corrected_*, verified_* and merged_into
-- are written by reviewStore.js's own guarded statements, never through the
-- generic updater.
-- ============================================================================

-- ---- 1. document_entity_links ----------------------------------------------
CREATE TABLE IF NOT EXISTS document_entity_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence NUMERIC(4,3),
  linked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, document_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_document_entity_links_tenant_doc
  ON document_entity_links (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idx_document_entity_links_tenant_entity
  ON document_entity_links (tenant_id, entity_id);

ALTER TABLE document_entity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_entity_links FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_document_entity_links ON document_entity_links;
CREATE POLICY tenants_isolate_document_entity_links ON document_entity_links
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 2. corrections live beside the original, never over it ---------------
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS corrected_value TEXT;
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS corrected_by    TEXT;
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS corrected_at    TIMESTAMPTZ;

-- ---- 3. who verified a document, and when ----------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS verified_by TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- ---- 4. duplicate entities are repointed, never deleted --------------------
ALTER TABLE entities ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES entities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities (merged_into) WHERE merged_into IS NOT NULL;

-- ---- 5. grants --------------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have
-- SELECT/INSERT/UPDATE/DELETE on every table in the schema (02, 03), and the
-- new columns above are plain ALTER TABLE ADD COLUMN on tables they already
-- have privileges on.

-- ---- 6. proof ---------------------------------------------------------------
-- Expected results for a human running these against a real database, the
-- same way 03/04/05 document theirs; nothing here executes automatically.

-- Expect: one row — the table exists with its unique constraint.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'document_entity_links'::regclass AND contype = 'u';

-- Expect: one row, tgenabled — n/a for RLS; check forcerowsecurity instead.
-- relforcerowsecurity = true confirms FORCE is set (owner-role bypass closed).
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname = 'document_entity_links';

-- Expect: one row — the tenant-isolation policy is present.
SELECT polname FROM pg_policy
 WHERE polrelid = 'document_entity_links'::regclass AND polname = 'tenants_isolate_document_entity_links';

-- Expect: three rows — corrected_value, corrected_by, corrected_at, all nullable.
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'extractions' AND column_name IN ('corrected_value','corrected_by','corrected_at');

-- Expect: two rows — verified_by, verified_at, both nullable.
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'documents' AND column_name IN ('verified_by','verified_at');

-- Expect: one row — merged_into, uuid, nullable.
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'entities' AND column_name = 'merged_into';

-- Expect: 0 rows, always. Any row here is a document verified without ever
-- having been linked to anything — exactly what verifyDocument's SQL guard
-- (WHERE stage = 'linked' AND EXISTS (... document_entity_links ...)) exists
-- to make impossible.
SELECT d.id FROM documents d
 WHERE d.stage = 'verified'
   AND NOT EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = d.id);

-- Expect: 0 rows, always. Any row here is a link crossing a tenant boundary —
-- run as the owner role (or another BYPASSRLS role); under deepwell_rls, RLS
-- itself would hide the row and this query would prove nothing.
SELECT l.id, l.tenant_id AS link_tenant, d.tenant_id AS doc_tenant, e.tenant_id AS entity_tenant
  FROM document_entity_links l
  JOIN documents d ON d.id = l.document_id
  JOIN entities  e ON e.id = l.entity_id
 WHERE l.tenant_id <> d.tenant_id OR l.tenant_id <> e.tenant_id;
