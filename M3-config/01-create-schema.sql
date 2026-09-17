-- M3 Postgres Schema
-- Created: September 13, 2026
-- Purpose: Core tables for multi-tenant DeepWell platform

-- Enable RLS and required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tenants (organizations)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  settings JSONB DEFAULT '{}'::JSONB
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clerk_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, clerk_user_id)
);

-- Documents (uploaded files)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id UUID,
  original_filename TEXT NOT NULL,
  document_type TEXT,
  sha256_hash TEXT NOT NULL,
  file_size_bytes INTEGER,
  stage TEXT NOT NULL DEFAULT 'received' CHECK (stage IN ('received', 'read', 'mapped', 'linked', 'verified')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(tenant_id, sha256_hash)
);

-- Document pages (per-document breakdown)
CREATE TABLE IF NOT EXISTS document_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  r2_path TEXT,
  page_width INTEGER,
  page_height INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Facets (M2: raw OCR extractions, mappable or not)
CREATE TABLE IF NOT EXISTS facets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INTEGER,
  segment_id TEXT,
  label_raw TEXT,
  value_raw TEXT,
  value_type_guess TEXT,
  bbox JSONB,
  confidence NUMERIC(4,3),
  mapped_entity_type TEXT,
  mapped_field_key TEXT,
  mapping_confidence NUMERIC(4,3),
  mapping_method TEXT CHECK (mapping_method IN ('registry','synonym','learned','human')),
  proposal_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_facets_tenant_doc ON facets(tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idx_facets_proposal ON facets(proposal_id);

-- Proposals (M2: schema growth, human-confirmed)
CREATE TABLE IF NOT EXISTS proposals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('field', 'synonym', 'document_type', 'entity_type')),
  label TEXT NOT NULL,
  target_entity_type TEXT,
  target_field_key TEXT,
  evidence JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Schema versions (audit trail of registry changes)
CREATE TABLE IF NOT EXISTS schema_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  change_kind TEXT,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(tenant_id, version)
);

-- Extractions (M2 output: facets → mapped field)
CREATE TABLE IF NOT EXISTS extractions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id UUID,
  field_key TEXT NOT NULL,
  value TEXT,
  confidence NUMERIC(4,3),
  source_facet_id UUID REFERENCES facets(id) ON DELETE SET NULL,
  schema_version INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_extractions_tenant_doc ON extractions(tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idx_extractions_entity ON extractions(tenant_id, entity_id);

-- Entities (properties, equipment, customers, technicians)
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('property', 'equipment', 'customer', 'technician')),
  data JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_tenant_type ON entities(tenant_id, entity_type);

-- Audit log (every mutation, every staff access)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id UUID,
  changes JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_date ON audit_log(tenant_id, created_at DESC);

-- Row-level security
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE facets ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- RLS Policies (tenant isolation)
-- Every policy below is dropped first because Postgres has no
-- CREATE POLICY IF NOT EXISTS. Without these guards this file could only ever
-- be run once: a second run failed on the first policy and left everything
-- after it unapplied. 02, 03 and 05 all guard theirs; this file did not, which
-- made the very first migration the only non-idempotent one in the set.
DROP POLICY IF EXISTS tenants_isolate_documents ON documents;
CREATE POLICY tenants_isolate_documents ON documents
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_document_pages ON document_pages;
CREATE POLICY tenants_isolate_document_pages ON document_pages
  USING (document_id IN (SELECT id FROM documents WHERE tenant_id = (current_setting('app.tenant_id'))::uuid))
  WITH CHECK (document_id IN (SELECT id FROM documents WHERE tenant_id = (current_setting('app.tenant_id'))::uuid));

DROP POLICY IF EXISTS tenants_isolate_facets ON facets;
CREATE POLICY tenants_isolate_facets ON facets
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_proposals ON proposals;
CREATE POLICY tenants_isolate_proposals ON proposals
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_schema_versions ON schema_versions;
CREATE POLICY tenants_isolate_schema_versions ON schema_versions
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_extractions ON extractions;
CREATE POLICY tenants_isolate_extractions ON extractions
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_entities ON entities;
CREATE POLICY tenants_isolate_entities ON entities
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_audit_log ON audit_log;
CREATE POLICY tenants_isolate_audit_log ON audit_log
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

DROP POLICY IF EXISTS tenants_isolate_users ON users;
CREATE POLICY tenants_isolate_users ON users
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- Schema is now ready for M3
