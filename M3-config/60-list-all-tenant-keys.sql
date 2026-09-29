-- ============================================================================
-- 60-list-all-tenant-keys.sql — run AFTER 01b-app-role.sql and 02-tenancy-fix.sql.
-- Idempotent; safe to re-run.
--
-- PRODUCTION GAP (client-readiness audit, item M8): the nightly cron sweep
-- (api/_lib/routes/cron-sweep.js) walks tenants with listTenantKeys() to recover
-- stuck / budget-deferred documents, run integrity repair, dossier catch-up and
-- the async knowledge-report jobs. `tenants` is FORCE ROW LEVEL SECURITY with the
-- policy `id = current_setting('app.tenant_id')::uuid`, and the app connects as
-- `deepwell_rls` (NOBYPASSRLS). A cross-tenant read has no app.tenant_id set, so
-- the policy matches ZERO rows and the sweep saw zero tenants in production.
--
-- FIX: one narrow SECURITY DEFINER function — the same pattern as
-- list_notification_eligible_tenants() (16-notifications.sql) — that returns ONLY
-- identifiers: the tenant's uuid and its Clerk key (which is what
-- resolve_tenant()/withTenant needs). No name, plan, billing state, settings,
-- Stripe ids, counts or any content. It runs as the function owner (the
-- migration role, which bypasses RLS on Neon), so FORCE RLS on `tenants` is
-- untouched for every ordinary query.
--
-- Until this is pasted the API falls back to the old (empty-in-production)
-- listing, so deploy order does not matter.
--
-- NEON PASTE — run this file as-is in the Neon SQL editor (or
-- `node M3-config/run-migration-v2.js M3-config/60-list-all-tenant-keys.sql`).
-- ============================================================================

CREATE OR REPLACE FUNCTION list_all_tenant_keys()
RETURNS TABLE(tenant_id uuid, tenant_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, clerk_org_id
    FROM tenants
   WHERE clerk_org_id IS NOT NULL
   ORDER BY created_at ASC, id ASC
   LIMIT 2000;
$$;

-- Not callable by arbitrary roles: only the application role(s).
REVOKE ALL ON FUNCTION list_all_tenant_keys() FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_all_tenant_keys() TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Proof (run after pasting):
--   1) prosecdef = true, and the return columns are exactly (tenant_id, tenant_key):
--        SELECT p.proname, p.prosecdef, pg_get_function_result(p.oid)
--          FROM pg_proc p WHERE p.proname = 'list_all_tenant_keys';
--   2) the function OWNER bypasses RLS (rolsuper or rolbypassrls = true); if this
--      returns false the function will list zero rows just like the old query:
--        SELECT r.rolname, r.rolsuper, r.rolbypassrls
--          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--         WHERE p.proname = 'list_all_tenant_keys';
--   3) as the app role, count > 0 once any shop exists:
--        SET ROLE deepwell_rls; SELECT count(*) FROM list_all_tenant_keys(); RESET ROLE;
