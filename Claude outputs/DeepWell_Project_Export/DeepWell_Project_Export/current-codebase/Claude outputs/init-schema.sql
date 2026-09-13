-- DeepWell Postgres Schema Initialization
-- Run this once in Neon to create all tables

-- Tenants (organizations)
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now(),
  settings jsonb DEFAULT '{}'
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clerk_user_id text UNIQUE NOT NULL,
  email text NOT NULL,
  role text DEFAULT 'user' CHECK (role IN ('admin', 'user', 'owner')),
  created_at timestamptz DEFAULT now()
);

-- Documents (uploaded files)
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id uuid,
  original_filename text NOT NULL,
  document_type text,
  sha256_hash text,
  file_size_bytes int,
  stage text DEFAULT 'received' CHECK (stage IN ('received', 'read', 'mapped', 'linked', 'verified')),
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

-- Document pages (OCR breakdown)
CREATE TABLE IF NOT EXISTS document_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no int NOT NULL,
  r2_path text,
  page_width int,
  page_height int
);

-- Facets (raw OCR extractions)
CREATE TABLE IF NOT EXISTS facets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no int,
  segment_id text,
  label_raw text NOT NULL,
  value_raw text NOT NULL,
  value_type_guess text,
  bbox jsonb,
  confidence numeric(4, 3),
  mapped_entity_type text,
  mapped_field_key text,
  mapping_confidence numeric(4, 3),
  mapping_method text CHECK (mapping_method IN ('registry', 'synonym', 'learned', 'human')),
  proposal_id uuid,
  created_at timestamptz DEFAULT now()
);

-- Extractions (mapped field data)
CREATE TABLE IF NOT EXISTS extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id uuid,
  field_key text NOT NULL,
  value text,
  confidence numeric(4, 3),
  source_facet_id uuid REFERENCES facets(id),
  schema_version int,
  created_at timestamptz DEFAULT now()
);

-- Entities (properties, equipment, customers, technicians)
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('property', 'equipment', 'customer', 'technician')),
  data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Proposals (schema growth tracking)
CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('field', 'synonym', 'document_type', 'entity_type')),
  label text NOT NULL,
  target_entity_type text,
  target_field_key text,
  evidence jsonb,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id)
);

-- Audit log (every mutation)
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  resource_type text,
  resource_id uuid,
  changes jsonb,
  created_at timestamptz DEFAULT now()
);

-- Schema versions (migration tracking)
CREATE TABLE IF NOT EXISTS schema_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version int NOT NULL,
  change_kind text,
  description text,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE(tenant_id, version)
);

-- Row-Level Security Policies
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant_isolate ON documents
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

ALTER TABLE facets ENABLE ROW LEVEL SECURITY;
CREATE POLICY facets_tenant_isolate ON facets
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY extractions_tenant_isolate ON extractions
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY entities_tenant_isolate ON entities
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposals_tenant_isolate ON proposals
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolate ON audit_log
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolate ON users
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- Indexes for performance
CREATE INDEX idx_documents_tenant_stage ON documents(tenant_id, stage);
CREATE INDEX idx_facets_document ON facets(document_id);
CREATE INDEX idx_facets_tenant_doc ON facets(tenant_id, document_id);
CREATE INDEX idx_extractions_document ON extractions(document_id);
CREATE INDEX idx_extractions_entity ON extractions(entity_id);
CREATE INDEX idx_entities_tenant_type ON entities(tenant_id, entity_type);
CREATE INDEX idx_audit_tenant_date ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- Create default tenant
INSERT INTO tenants (slug, name) VALUES ('default', 'Default Organization')
ON CONFLICT (slug) DO NOTHING;
