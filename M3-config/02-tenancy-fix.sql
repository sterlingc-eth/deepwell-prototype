-- ============================================================================
-- 02-tenancy-fix.sql — run AFTER 01-create-schema.sql
--
-- Fixes three things the schema got wrong, each verified against a real
-- Postgres 16 instance:
--
--   1. RLS was enabled but not FORCEd. Postgres exempts a table's OWNER from
--      non-forced RLS, and the Neon connection string authenticates as
--      neondb_owner — the owner of every table. Demonstrated: with tenant set
--      to Acme, the owner still saw Rival Corp's documents.
--   2. tenants had no RLS at all.
--   3. tenant_id is uuid, but Clerk ids are strings ("org_2abc…"). Casting one
--      to the other throws `invalid input syntax for type uuid`, so every
--      query would have failed. Tenants now carry their Clerk org id and the
--      app resolves it to the uuid.
-- ============================================================================

-- 1 + 2 — make RLS apply to everyone, including the owner.
ALTER TABLE documents        FORCE ROW LEVEL SECURITY;
ALTER TABLE facets           FORCE ROW LEVEL SECURITY;
ALTER TABLE extractions      FORCE ROW LEVEL SECURITY;
ALTER TABLE entities         FORCE ROW LEVEL SECURITY;
ALTER TABLE proposals        FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log        FORCE ROW LEVEL SECURITY;

-- 3 — map Clerk identity to the tenant uuid.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS clerk_org_id text UNIQUE;
CREATE INDEX IF NOT EXISTS tenants_clerk_org_id_idx ON tenants (clerk_org_id);

-- A tenant may only see itself.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_self ON tenants;
CREATE POLICY tenants_isolate_self ON tenants
  USING (id = (current_setting('app.tenant_id', true))::uuid);

-- Resolving a Clerk org to a tenant has to happen before app.tenant_id is set,
-- so it runs as SECURITY DEFINER, outside RLS, and returns only the uuid.
CREATE OR REPLACE FUNCTION resolve_tenant(p_clerk_org_id text, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_clerk_org_id IS NULL OR length(trim(p_clerk_org_id)) = 0 THEN
    RAISE EXCEPTION 'resolve_tenant: clerk_org_id is required';
  END IF;
  SELECT id INTO v_id FROM tenants WHERE clerk_org_id = p_clerk_org_id;
  IF v_id IS NULL THEN
    INSERT INTO tenants (name, slug, clerk_org_id)
    VALUES (COALESCE(p_name, p_clerk_org_id), p_clerk_org_id, p_clerk_org_id)
    ON CONFLICT (clerk_org_id) DO UPDATE SET clerk_org_id = EXCLUDED.clerk_org_id
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- 4 — a non-owner role for the application. Belt and braces: even if FORCE were
--     ever dropped, this role is not the owner and RLS still applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepwell_app') THEN
    CREATE ROLE deepwell_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO deepwell_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO deepwell_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO deepwell_app;
GRANT EXECUTE ON FUNCTION resolve_tenant(text, text) TO deepwell_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deepwell_app;
