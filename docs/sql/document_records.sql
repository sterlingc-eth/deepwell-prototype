-- OPTIONAL, owner-run (nothing in the app requires it). docrecord stores records in facets (segment_id 'doc-record-v1') with NO migration.
-- Run this only if you later want a dedicated, indexable table (and then switch store.js to it). Paste into the Neon SQL editor.
CREATE TABLE IF NOT EXISTS document_records (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('verified','partial','empty')),
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_document_records_tenant ON document_records(tenant_id, status);
ALTER TABLE document_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_records_tenant ON document_records USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
