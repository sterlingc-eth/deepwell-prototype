-- ============================================================================
-- 04-cleanup.sql — run AFTER 03-retrieval.sql. Idempotent; safe to re-run.
--
-- Removes the scaffolding left over from getting tenancy working:
--   * deepwell_app    — an earlier application role, superseded by deepwell_rls
--   * deepwell_probe  — a throwaway used to prove RLS was actually forced
--   * playing_with_neon — Neon's sample table, created with the project
--
-- WHY IT MATTERS RATHER THAN BEING TIDINESS: roles created through the Neon
-- console carry neon_superuser, and neon_superuser carries BYPASSRLS. A role
-- with BYPASSRLS overrides FORCE ROW LEVEL SECURITY completely. Every tenancy
-- guarantee in 02 and 03 holds only for connections that are not using one of
-- these roles — so as long as they exist, the isolation model is one leaked or
-- mistakenly-pasted connection string away from being off.
--
-- RUN THIS AS THE NEON OWNER ROLE (neondb_owner), NOT as deepwell_rls, and not
-- as either role being dropped. A role cannot drop itself, and the script
-- refuses rather than half-completing.
-- ============================================================================

DO $$
BEGIN
  IF current_user IN ('deepwell_app', 'deepwell_probe') THEN
    RAISE EXCEPTION
      'Connected as %, which this script drops. Reconnect as the owner role first.',
      current_user;
  END IF;
END $$;

-- ---- 1. Neon's sample table -------------------------------------------------
-- Not referenced by anything, has no tenant_id, and has no RLS. It exists only
-- because Neon creates it with a new project.
DROP TABLE IF EXISTS playing_with_neon;

-- ---- 2. the superseded roles ------------------------------------------------
-- Order matters. A role cannot be dropped while it owns objects or holds
-- grants, and the error Postgres gives for that names a dependency rather than
-- the role, which is how this turns into a twenty-minute detour.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_app', 'deepwell_probe'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), r);
      -- Drops anything the role still owns and strips remaining privileges.
      -- DROP OWNED BY is database-local, which is all Neon exposes anyway.
      EXECUTE format('DROP OWNED BY %I', r);
      EXECUTE format('DROP ROLE %I', r);
      RAISE NOTICE 'dropped role %', r;
    ELSE
      RAISE NOTICE 'role % not present, nothing to do', r;
    END IF;
  END LOOP;
END $$;

-- ---- 3. proof ---------------------------------------------------------------
-- Expect: zero rows. Any row here is a role that can still read past RLS.
SELECT rolname, rolsuper, rolbypassrls
  FROM pg_roles
 WHERE rolname IN ('deepwell_app', 'deepwell_probe')
    OR (rolbypassrls AND rolcanlogin AND rolname NOT LIKE 'pg\_%');

-- Expect: exactly one row, deepwell_rls, with both flags false.
SELECT rolname, rolsuper, rolbypassrls
  FROM pg_roles
 WHERE rolname = 'deepwell_rls';

-- ---- 4. test tenants --------------------------------------------------------
-- NOT automated on purpose: which tenants are disposable is a judgement about
-- real customer data, and a DELETE here cascades through documents, pages,
-- facets and extractions. Look first:
--
--   SELECT t.id, t.name, t.clerk_org_id, t.created_at,
--          (SELECT count(*) FROM documents d WHERE d.tenant_id = t.id) AS docs
--     FROM tenants t ORDER BY t.created_at;
--
-- Then, for each one you are certain about:
--
--   DELETE FROM tenants WHERE id = '<uuid>';
--
-- Rows seeded by scripts/verify-retrieval.mjs and scripts/eval-retrieval.mjs
-- are recognisable by clerk_org_id starting 'org_verify_' or 'org_eval_'.
-- Those are always safe:
--
--   DELETE FROM tenants
--    WHERE clerk_org_id LIKE 'org_verify\_%' OR clerk_org_id LIKE 'org_eval\_%';
