-- ============================================================================
-- 73-demo-accounts.sql — run AFTER 72-handoff-learning.sql. Idempotent; safe to re-run.
--
-- WHAT THIS IS FOR
-- The free in-app industry demo (demo@deepwelltechnology.com): one demo company per industry. A demo company is an
-- ordinary tenant with plan = 'demo' and billing_status = 'demo'. The app treats 'demo' like an active plan for
-- reading and asking (api/_lib/plan.js), never bills it, and keeps it out of every cross-tenant job that filters on
-- billing_status IN ('active','trialing') (warranty digests, outreach, follow-ups, the learning autopilot).
--
-- This file adds only the storage the demo needs; it does NOT turn any company into a demo company. That is
-- M3-config/demo/D1-setup-demo-companies.sql, run by hand for the demo organizations only.
--
--   1. demo_seed_documents   the documents that make up a demo company's original sample paperwork (its "seed").
--                            The nightly reset and "Clear my scans" remove every document NOT in this list.
--                            Row-level security like every other table; the app can READ it but cannot write it
--                            (only demo_mark_seed below, run from the SQL editor, writes it).
--   2. demo_mark_seed(id)    records a demo company's current documents as its seed. SQL-editor only (not granted to
--                            the app role). Refuses for any company that is not a demo company.
--   3. demo_seed_snapshot    the seed STATE of the tables a demo day can change (facts, links, customers, derived caches);
--                            the reset puts these rows back exactly. Read-only for the app.
--   4. list_demo_tenants()   identifiers of demo companies only, for the nightly reset (SECURITY DEFINER, same
--                            narrow pattern as list_all_tenant_keys() in 60-list-all-tenant-keys.sql).
--
-- NEON PASTE — run this file as-is in the Neon SQL editor on the STAGING branch first.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS demo_seed_documents (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sha256_hash TEXT,
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, document_id)
);

ALTER TABLE demo_seed_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed_documents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_demo_seed_documents ON demo_seed_documents;
CREATE POLICY tenants_isolate_demo_seed_documents ON demo_seed_documents
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- Read-only for the application: the seed list is written only by demo_mark_seed() from the SQL editor.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON demo_seed_documents FROM %I', r);
      EXECUTE format('GRANT SELECT ON demo_seed_documents TO %I', r);
    END IF;
  END LOOP;
END $$;

-- The seed STATE of the tables a demo day can change (facts, links, customers, caches built from them), one row per
-- table per demo company, as written by demo_mark_seed(). The nightly reset and "Clear my scans" put these rows back
-- exactly (api/_lib/demo/reset.js). Read-only for the app, like demo_seed_documents.
CREATE TABLE IF NOT EXISTS demo_seed_snapshot (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,
  row_count   INTEGER NOT NULL,
  rows        JSONB NOT NULL,
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, table_name)
);
ALTER TABLE demo_seed_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed_snapshot FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_demo_seed_snapshot ON demo_seed_snapshot;
CREATE POLICY tenants_isolate_demo_seed_snapshot ON demo_seed_snapshot
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON demo_seed_snapshot FROM %I', r);
      EXECUTE format('GRANT SELECT ON demo_seed_snapshot TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Keep this list identical to SNAPSHOT_TABLES in api/_lib/demo/reset.js (scripts/demo-acct/verify-demo-account.mjs checks it).
CREATE OR REPLACE FUNCTION demo_snapshot_tables()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['documents', 'entities', 'facets', 'extractions', 'document_entity_links', 'document_financials', 'document_financial_lines',
               'document_cards', 'intake_field_inferences', 'intake_needs_info', 'kg_edges', 'dossiers', 'customer_activity',
               'customer_activity_dirty', 'entity_merge_suggestions', 'tenant_insights_cache', 'tenant_rollups', 'knowledge_reports']::text[];
$$;

CREATE OR REPLACE FUNCTION demo_mark_seed(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_plan text; v_status text; v_n integer; v_table text;
BEGIN
  SELECT plan, billing_status INTO v_plan, v_status FROM tenants WHERE id = p_tenant_id;
  IF v_plan IS DISTINCT FROM 'demo' OR v_status IS DISTINCT FROM 'demo' THEN
    RAISE EXCEPTION 'demo_mark_seed: % is not a demo company (plan %, status %). Nothing was changed.', p_tenant_id, v_plan, v_status;
  END IF;
  DELETE FROM demo_seed_documents WHERE tenant_id = p_tenant_id;
  INSERT INTO demo_seed_documents (tenant_id, document_id, sha256_hash)
    SELECT tenant_id, id, sha256_hash FROM documents WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- the seed state of every table a demo day can change (tables that do not exist on this database are skipped)
  DELETE FROM demo_seed_snapshot WHERE tenant_id = p_tenant_id;
  -- the seed copy of the company's settings (notification digest, mutes, screen prefs): the reset puts tenants.settings back
  INSERT INTO demo_seed_snapshot (tenant_id, table_name, row_count, rows)
    SELECT id, 'tenant_settings', 1, jsonb_build_array(jsonb_build_object('settings', COALESCE(settings, '{}'::jsonb)))
      FROM tenants WHERE id = p_tenant_id;
  FOREACH v_table IN ARRAY demo_snapshot_tables() LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('INSERT INTO demo_seed_snapshot (tenant_id, table_name, row_count, rows)
                      SELECT $1, %L, count(*), COALESCE(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) FROM %I t WHERE t.tenant_id = $1', v_table, v_table)
        USING p_tenant_id;
    END IF;
  END LOOP;
  UPDATE tenants
     SET limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{demo,seededAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), true)
   WHERE id = p_tenant_id;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION demo_mark_seed(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION list_demo_tenants()
RETURNS TABLE(tenant_id uuid, tenant_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, clerk_org_id
    FROM tenants
   WHERE plan = 'demo' AND billing_status = 'demo' AND clerk_org_id IS NOT NULL
   ORDER BY created_at ASC, id ASC
   LIMIT 100;
$$;
REVOKE ALL ON FUNCTION list_demo_tenants() FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_demo_tenants() TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Proof (read-only): rls = t, force = t; both functions are SECURITY DEFINER; demo_mark_seed is NOT executable by the app.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'demo_seed_documents';
SELECT p.proname, p.prosecdef FROM pg_proc p WHERE p.proname IN ('demo_mark_seed', 'list_demo_tenants');
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'demo_seed_snapshot';
