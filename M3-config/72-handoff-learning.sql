-- DONOVAN round 24 (OPTIONAL, owner runs later; Donovan works without it): "learn from every handoff", per organization (api/_lib/handoffLearning/, switch DONOVAN_HANDOFF_LEARNING, default OFF).
--   donovan_handoffs         questions Claude answered from the records (grounded), kept per organization. The raw question text is blanked as soon as the learning job has read it
--                            (and after 14 days at the latest); only the masked form (names, numbers and dates replaced) and a value-free reading stay. Never an answer text.
--   donovan_handoff_learned  what Donovan adopted for ONE organization after its own engine re-derived the same answer: a filler word, a word for something the organization keeps, a wording.
--                            Retired (not deleted) when a thumbs-down or a mismatch follows; expires after 90 days unless the job re-confirms it.
--   donovan_handoff_shared   a generic learning (no company data at all) that three or more organizations confirmed independently with no conflict. Readable by every organization, written by the job's owner role only.
-- Re-runnable. Run as the owner role.
BEGIN;

CREATE TABLE IF NOT EXISTS donovan_handoffs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_text TEXT,
  question_masked TEXT NOT NULL DEFAULT '',
  reading JSONB NOT NULL DEFAULT '{}'::jsonb,
  answer_sig JSONB NOT NULL DEFAULT '{}'::jsonb,
  grounded_n INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'used', 'dropped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_donovan_handoffs_tenant_new ON donovan_handoffs (tenant_id, id) WHERE status = 'new';

CREATE TABLE IF NOT EXISTS donovan_handoff_learned (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('filler', 'word', 'wording')),
  phrase TEXT NOT NULL,
  target_kind TEXT,
  target_value TEXT,
  canonical TEXT NOT NULL DEFAULT '',
  support INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retire_reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  UNIQUE (tenant_id, kind, phrase)
);
CREATE INDEX IF NOT EXISTS idx_donovan_handoff_learned_active ON donovan_handoff_learned (tenant_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS donovan_handoff_shared (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('filler', 'word', 'wording')),
  phrase TEXT NOT NULL,
  canonical TEXT NOT NULL DEFAULT '',
  n_companies INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, phrase)
);

ALTER TABLE donovan_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_donovan_handoffs ON donovan_handoffs;
CREATE POLICY tenants_isolate_donovan_handoffs ON donovan_handoffs
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

ALTER TABLE donovan_handoff_learned ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_handoff_learned FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_donovan_handoff_learned ON donovan_handoff_learned;
CREATE POLICY tenants_isolate_donovan_handoff_learned ON donovan_handoff_learned
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- shared: every organization may read, nobody but the owner role (which bypasses RLS) may write
ALTER TABLE donovan_handoff_shared ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_handoff_shared FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS donovan_handoff_shared_read ON donovan_handoff_shared;
CREATE POLICY donovan_handoff_shared_read ON donovan_handoff_shared FOR SELECT USING (true);

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON donovan_handoffs, donovan_handoff_learned TO %I', r);
      EXECUTE format('GRANT SELECT ON donovan_handoff_shared TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- proof: expect three rows, rls = t and force = t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('donovan_handoffs', 'donovan_handoff_learned', 'donovan_handoff_shared') ORDER BY 1;
