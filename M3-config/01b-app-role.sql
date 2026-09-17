-- 01b-app-role.sql
--
-- Creates the role the application actually connects as.
--
-- WHY THIS FILE EXISTS: it was missing, and its absence was invisible because
-- production already had the role. `deepwell_rls` is the role in
-- NEON_CONNECTION_STRING — it is what every query in recordsStore.js runs as.
-- But no migration ever created it. 02 creates `deepwell_app`, 04 drops that,
-- and 03's grant block only grants to `deepwell_rls` *if it already exists*,
-- silently skipping it otherwise.
--
-- So running 01 through 06 against an empty database produced a schema the
-- application could not connect to at all. That is not a day-to-day bug; it is
-- a disaster-recovery bug, and the kind you find out about on the worst
-- possible day. These files are the only written record of how the database is
-- configured, and until now that record was wrong.
--
-- ORDER: this is named 01b, not 07, ON PURPOSE. It has to run after 01 (tables
-- must exist to grant on them) and before 02/03/04, and the only thing anyone
-- actually follows is filename order. Numbered 07 it would have run last —
-- which means 04 drops deepwell_app while deepwell_rls does not yet exist, and
-- between those two steps the application has no working database role at all.
-- That is the exact outage this file was written to prevent. Re-running is safe.
--
-- VERIFY BEFORE TRUSTING: this reconstructs the role from what the application
-- requires and from how 02 creates deepwell_app. If the live role was created
-- with anything else — a connection limit, a password policy, extra grants —
-- this file does not know about it. Compare against production with:
--
--   SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolconnlimit
--     FROM pg_roles WHERE rolname = 'deepwell_rls';
--
-- Expect: rolsuper = f, rolbypassrls = f, rolcanlogin = t.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepwell_rls') THEN
    -- NOBYPASSRLS is the whole point of this role and is stated explicitly
    -- rather than left to the default. A role with BYPASSRLS reads every
    -- tenant's rows regardless of any policy, which would make every isolation
    -- test in this codebase pass against a connection that ignores the rules
    -- it is testing. NOSUPERUSER for the same reason: a superuser also bypasses
    -- RLS, and would additionally own anything it created.
    CREATE ROLE deepwell_rls LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Grants. Deliberately no DDL rights: this role reads and writes rows, and
-- must not be able to alter a table, drop a policy, or disable RLS on itself.
GRANT USAGE ON SCHEMA public TO deepwell_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO deepwell_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO deepwell_rls;

-- resolve_tenant is SECURITY DEFINER and has to run before app.tenant_id is
-- set, so the application role needs to be able to call it.
GRANT EXECUTE ON FUNCTION resolve_tenant(text, text) TO deepwell_rls;

-- Tables created by later migrations need the same grants without anyone
-- having to remember.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deepwell_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO deepwell_rls;

-- Proof. rolbypassrls MUST be false. If it is true, every tenant-isolation
-- guarantee in this application is decoration.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
  FROM pg_roles
 WHERE rolname IN ('deepwell_rls', 'deepwell_app', 'deepwell_probe')
 ORDER BY rolname;
