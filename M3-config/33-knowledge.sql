-- ============================================================================
-- 33-knowledge.sql — run AFTER 31-semantic-search.sql. Idempotent; safe to
-- re-run. OPTIONAL: nothing in api/_lib/search/dossier.js or mapReduce.js
-- throws if this has not been pasted — they probe for these tables first
-- (dossierSchemaReady()) and degrade to "no dossier yet" / "compute fresh"
-- exactly like 31's own probe pattern.
--
-- TEAM T2 (2026-09-25): retrieval + knowledge at enterprise scale.
--
--   dossiers         — one rolling, precomputed summary per (customer|unit),
--                       rebuilt incrementally as new/changed documents come
--                       in. Every sentence in `sentences` carries its own
--                       citations (doc + page), so a dossier is fast context
--                       for a broad question ("everything we've done for
--                       Plaza Dental") without re-reading every document on
--                       every ask. `source_hash` is a digest of the document
--                       ids + their content hashes the summary was built
--                       from, so "does this need a rebuild" is one column
--                       compare, not a recomputation.
--   knowledge_reports — async "full report" jobs: when a synthesis question
--                       spans more documents than a single request's time/
--                       cost budget allows, mapReduceAnswer queues one of
--                       these instead of answering inline, and a cron step
--                       (runKnowledgeReportSweepStep) works through pending
--                       rows in budgeted batches.
--
-- RLS: identical tenant policy to 31-semantic-search.sql — ENABLE + FORCE,
-- one policy each. Grants: none needed; 01b's ALTER DEFAULT PRIVILEGES
-- already covers new tables for deepwell_rls.
-- ============================================================================

-- ---- 1. dossiers -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dossiers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'customer' or 'unit' (a unit is an entities row with entity_type='equipment';
  -- named "unit" here to match the HVAC domain language the rest of the product uses).
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('customer', 'unit')),
  entity_id           UUID NOT NULL,
  -- Plain-text rollup (for a quick read) plus the sentence-level structure
  -- that carries citations. Both are kept in sync by dossier.js.
  summary             TEXT NOT NULL DEFAULT '',
  sentences           JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{text, citations:[{documentId,page}]}]
  source_document_ids JSONB NOT NULL DEFAULT '[]'::JSONB, -- documents this summary was built from
  source_hash         TEXT,                               -- md5 of source_document_ids + each doc's content signature
  model               TEXT,
  built_at            TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_dossiers_tenant_entity ON dossiers (tenant_id, entity_type, entity_id);

ALTER TABLE dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dossiers FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_dossiers ON dossiers;
CREATE POLICY tenants_isolate_dossiers ON dossiers
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 2. knowledge_reports (async map-reduce "full report" jobs) -------------
CREATE TABLE IF NOT EXISTS knowledge_reports (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by   TEXT,                 -- Clerk user id, best-effort, never a trust boundary
  question       TEXT NOT NULL,
  filters        JSONB NOT NULL DEFAULT '{}'::JSONB,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  document_count INTEGER,
  coverage       JSONB,               -- {consideredDocs, mappedDocs, skipped, note}
  result         TEXT,                -- the Sonnet-reduced, cited answer
  error          TEXT,
  notify_email   TEXT,
  cost_usd       NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_knowledge_reports_pending
  ON knowledge_reports (tenant_id, status, created_at);

ALTER TABLE knowledge_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_reports FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_knowledge_reports ON knowledge_reports;
CREATE POLICY tenants_isolate_knowledge_reports ON knowledge_reports
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- 3. proof -----------------------------------------------------------------
-- Expect: two rows, both relrowsecurity = true and relforcerowsecurity = true.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('dossiers', 'knowledge_reports') ORDER BY relname;
