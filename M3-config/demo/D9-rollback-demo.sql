-- ============================================================================
-- D9-rollback-demo.sql  -  UNDO EVERYTHING 73-demo-accounts.sql, D1 and D2 added.   (fix round 2, 2026-10-22)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Takes the industry demo out of the database again. In ONE transaction (all or nothing) it:
--   1. turns every demo company back into an ordinary, plan-less company (plan and billing status empty - exactly like a
--      company that has never subscribed) and removes what D1 stored on it: the demo marker, the staff-import loading window,
--      and the company name / industry / reading-pack settings D1 wrote (only for companies whose plan AND status are 'demo');
--   2. revokes every API key those companies hold (the seeding keys);
--   3. empties and DROPS the two seed tables (demo_seed_documents, demo_seed_snapshot) and the three functions
--      (list_demo_tenants, demo_mark_seed, demo_snapshot_tables).
-- It does NOT delete any company, user, document or file: the sample paperwork stays where it is (delete a demo organization
-- in Clerk, or use the app's own delete, to remove its paperwork). It does not touch any company whose plan is not 'demo'.
--
-- ORDER MATTERS: remove the code first (or just stop the nightly reset - delete the cron in vercel.json), because the app's
-- nightly reset calls list_demo_tenants(); with the function gone it answers {"ok": false, "error": "list_demo_tenants
-- unavailable"} and changes nothing, which is harmless.
--
-- SAFETY SWITCH: nothing runs until you change 'NO' to 'ROLLBACK DEMO' on the line marked >>> EDIT <<<.
-- SAFE TO RUN AGAIN? Yes (nothing left to undo -> nothing happens).
-- ============================================================================

DO $rollback$
DECLARE
  v_confirm text := 'NO';   -- >>> EDIT <<< change to 'ROLLBACK DEMO' to run
  t         record;
  v_keys    int;
  v_n       int := 0;
BEGIN
  IF v_confirm IS DISTINCT FROM 'ROLLBACK DEMO' THEN
    RAISE EXCEPTION 'Nothing was changed. Edit the line marked >>> EDIT <<< to ''ROLLBACK DEMO'' to run this rollback.';
  END IF;

  FOR t IN SELECT id, clerk_org_id FROM tenants WHERE plan = 'demo' AND billing_status = 'demo' ORDER BY clerk_org_id LOOP
    UPDATE api_keys SET revoked_at = now() WHERE tenant_id = t.id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_keys = ROW_COUNT;
    UPDATE tenants
       SET plan = NULL,
           billing_status = NULL,
           limits = COALESCE(limits, '{}'::jsonb) - 'demo' - 'staffImport',
           settings = COALESCE(settings, '{}'::jsonb) - 'industry' - 'packs' - 'company_name' - 'business_name'
                      - 'emailDigest' - 'digestMuted' - 'uiPrefs'
     WHERE id = t.id;
    v_n := v_n + 1;
    RAISE NOTICE 'Reverted demo company % (% key(s) revoked).', t.clerk_org_id, v_keys;
  END LOOP;

  IF to_regclass('public.demo_seed_snapshot') IS NOT NULL THEN
    DROP TABLE demo_seed_snapshot;
  END IF;
  IF to_regclass('public.demo_seed_documents') IS NOT NULL THEN
    DROP TABLE demo_seed_documents;
  END IF;
  DROP FUNCTION IF EXISTS list_demo_tenants();
  DROP FUNCTION IF EXISTS demo_mark_seed(uuid);
  DROP FUNCTION IF EXISTS demo_snapshot_tables();
  RAISE NOTICE 'Demo rollback finished: % demo company(ies) reverted, seed tables and functions dropped.', v_n;
END
$rollback$;

-- PROOF (read-only): all four lists must be empty / zero.
SELECT count(*) AS demo_companies_left FROM tenants WHERE plan = 'demo' OR billing_status = 'demo';
SELECT count(*) AS demo_objects_left FROM (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('demo_seed_documents', 'demo_seed_snapshot')
  UNION ALL
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('list_demo_tenants', 'demo_mark_seed', 'demo_snapshot_tables')
) x;
