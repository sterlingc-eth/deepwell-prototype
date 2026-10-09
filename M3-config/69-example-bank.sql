-- DONOVAN step 3 (OPTIONAL, owner runs later; Donovan works without it): the per-organization EXAMPLE BANK, verified question -> reading pairs used (when
-- DONOVAN_EXAMPLE_BANK=1) as examples for the menu pick (api/_lib/records/exampleBank.js). Without this table the code keeps the same data in memory.
-- A row holds the question text and the menu-pick structure (fact ids, subject kind/text, order, window); never a stored record value. Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS donovan_examples (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_norm TEXT NOT NULL,
  question_text TEXT NOT NULL,
  reading JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'verified',
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_donovan_examples_tenant_live ON donovan_examples (tenant_id, question_norm) WHERE superseded_at IS NULL;

ALTER TABLE donovan_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_examples FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_donovan_examples ON donovan_examples;
CREATE POLICY tenants_isolate_donovan_examples ON donovan_examples
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON donovan_examples TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- proof: expect one row, rls = t and force = t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'donovan_examples';
