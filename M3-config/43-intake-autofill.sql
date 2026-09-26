-- ============================================================================
-- 43-intake-autofill.sql — run any time (no ordering dependency on 41/42).
-- Idempotent; safe to re-run.
--
-- STRAIGHT-THROUGH INTAKE (owner ask, Round 12: "when an item is uploaded it
-- should fill out all the information required without human interaction
-- unless it's truly incapable of doing so") — api/_lib/intake/autofill.js.
--
-- Two tables, both deliberately OUTSIDE `extractions`:
--
--   intake_field_inferences — a value this document did not itself state but
--     that a SIBLING document (same equipment/customer) did, filled in with
--     full provenance (which document, which page, which rule). Kept in its
--     own table rather than written into `extractions` on purpose: `extractions`
--     feeds Donovan's retrieval, citations and financials paths, all of which
--     read "a row in extractions" as "this document said this" — an inferred
--     value living there would silently misattribute a fact to a document
--     that never printed it. completenessFor/verifyByAi read this table
--     ALONGSIDE extractions (see autofill.js's mergedFieldsForCompleteness)
--     so an inferred fill still counts toward auto-verification without ever
--     touching what a citation points at.
--
--   intake_needs_info — the ONE precise question a document is left with when
--     autofill genuinely cannot determine a required field (a real conflict
--     between two candidate values, or an ambiguous customer match) — never a
--     blank form. One open row per (document, field); resolved automatically
--     (status -> 'resolved') when a later document's own arrival breaks the
--     tie, or by a human answering it directly.
--
-- Code is tolerant of this migration not being pasted: every reader in
-- autofill.js probes for these tables first (tableExists, cached per
-- process) and the whole feature is simply off until they exist — same
-- tolerance pattern as document_financials (22) and kg_edges (37).
-- ============================================================================

-- ---- 1. intake_field_inferences --------------------------------------------
CREATE TABLE IF NOT EXISTS intake_field_inferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence NUMERIC(4,3),
  rule TEXT NOT NULL,
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  source_page INTEGER,
  candidates JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, document_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_intake_inferences_tenant_doc
  ON intake_field_inferences (tenant_id, document_id);

ALTER TABLE intake_field_inferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_field_inferences FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_intake_field_inferences ON intake_field_inferences;
CREATE POLICY tenants_isolate_intake_field_inferences ON intake_field_inferences
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 2. intake_needs_info ---------------------------------------------------
CREATE TABLE IF NOT EXISTS intake_needs_info (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  field_key TEXT NOT NULL,
  question TEXT NOT NULL,
  candidates JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_value TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, document_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_intake_needs_info_tenant_doc
  ON intake_needs_info (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idx_intake_needs_info_tenant_entity_open
  ON intake_needs_info (tenant_id, entity_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_intake_needs_info_tenant_status
  ON intake_needs_info (tenant_id, status);

ALTER TABLE intake_needs_info ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_needs_info FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_intake_needs_info ON intake_needs_info;
CREATE POLICY tenants_isolate_intake_needs_info ON intake_needs_info
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 3. grants --------------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have blanket
-- SELECT/INSERT/UPDATE/DELETE on every table in the schema (02, 03).

-- ---- 4. proof ---------------------------------------------------------------
-- Expect: two rows — both tables present with FORCE row security set.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('intake_field_inferences', 'intake_needs_info');

-- Expect: two rows — one tenant-isolation policy per table.
SELECT polname FROM pg_policy
 WHERE polrelid IN ('intake_field_inferences'::regclass, 'intake_needs_info'::regclass);

-- Expect: 0 rows, always. Any row here is an inference or question crossing a
-- tenant boundary — run as the owner role (or another BYPASSRLS role); under
-- deepwell_rls, RLS itself would hide the row and this query would prove
-- nothing.
SELECT i.id FROM intake_field_inferences i JOIN documents d ON d.id = i.document_id
 WHERE i.tenant_id <> d.tenant_id;
SELECT n.id FROM intake_needs_info n JOIN documents d ON d.id = n.document_id
 WHERE n.tenant_id <> d.tenant_id;
