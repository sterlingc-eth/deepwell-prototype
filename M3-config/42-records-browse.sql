-- ============================================================================
-- 42-records-browse.sql — Round 12, G2 (records list/search). Idempotent;
-- safe to re-run; safe to skip (api/_lib/recordsStore.js's browseDocuments
-- works without these — they only make it fast at real volume).
--
-- Indexes only: no new tables, no RLS changes. Backs the filters/sort/facets
-- browseDocuments (api/_lib/recordsStore.js) runs for the records browser:
--   - documents:    upload-date sort, type/stage facets, "my uploads" filter
--   - extractions:  service_date lookup (field_key = 'service_date')
--   - entities:     entity_type facet joins (customer/property/technician/
--                   equipment linked via document_entity_links), plus
--                   trigram search on customer name / service address so
--                   free-text search doesn't need a sequential scan.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---- documents ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_tenant_created_at
  ON documents (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_type_stage
  ON documents (tenant_id, document_type, stage);
CREATE INDEX IF NOT EXISTS idx_documents_filename_trgm
  ON documents USING GIN (original_filename gin_trgm_ops);

-- uploaded_by (M3-config/20) may not exist yet on an older database — same
-- "detect, don't assume" contract as documentsHaveUploadedBy() in
-- recordsStore.js. Guarded so this migration never fails on a database that
-- hasn't pasted 20 yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'uploaded_by') THEN
    CREATE INDEX IF NOT EXISTS idx_documents_tenant_uploaded_by ON documents (tenant_id, uploaded_by) WHERE uploaded_by IS NOT NULL;
  END IF;
  -- display_name (M3-config/41, owned by G3) — same guard; index it for
  -- search the moment it exists, whether 41 landed before or after this file.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'display_name') THEN
    CREATE INDEX IF NOT EXISTS idx_documents_display_name_trgm ON documents USING GIN (display_name gin_trgm_ops);
  END IF;
END $$;

-- ---- extractions: service_date is looked up by field_key for every browse row
CREATE INDEX IF NOT EXISTS idx_extractions_tenant_fieldkey_doc
  ON extractions (tenant_id, field_key, document_id);

-- ---- entities: facet joins (document_entity_links -> entities by type) and
-- free-text search on the two fields the browser searches by name.
CREATE INDEX IF NOT EXISTS idx_entities_tenant_type_active
  ON entities (tenant_id, entity_type) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_customer_name_trgm
  ON entities USING GIN ((data->>'customer_name') gin_trgm_ops) WHERE entity_type = 'customer';
CREATE INDEX IF NOT EXISTS idx_entities_service_address_trgm
  ON entities USING GIN ((data->>'service_address') gin_trgm_ops) WHERE entity_type = 'property';
CREATE INDEX IF NOT EXISTS idx_entities_technician_name_trgm
  ON entities USING GIN ((data->>'name') gin_trgm_ops) WHERE entity_type = 'technician';

-- ---- proof ---------------------------------------------------------------------
-- Expect: every index above present.
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
  'idx_documents_tenant_created_at', 'idx_documents_tenant_type_stage', 'idx_documents_filename_trgm',
  'idx_extractions_tenant_fieldkey_doc', 'idx_entities_tenant_type_active',
  'idx_entities_customer_name_trgm', 'idx_entities_service_address_trgm', 'idx_entities_technician_name_trgm'
) ORDER BY 1;
