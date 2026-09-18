-- ============================================================================
-- 09-ops.sql — run AFTER 06-warranty-indexes.sql. Idempotent; safe to re-run.
--
-- Adds `tenant_deletions`: the one row a tenant-data deletion is allowed to
-- leave behind.
--
-- WHY IT HAS TO BE A SEPARATE TABLE: opsStore.deleteTenantData() deletes every
-- row belonging to a tenant, INCLUDING audit_log (see DELETE_ORDER in
-- api/_lib/opsStore.js). So the confirmation that "tenant X's data was
-- deleted, N documents, M objects, K of them failed" cannot be written to
-- audit_log — by the time you'd write it, the row you're about to log would
-- be deleted along with everything else in the same breath. It needs a table
-- deleteTenantData() never touches.
--
-- RLS: FORCEd and tenant-scoped exactly like every other table (see 02, 03),
-- using the same current_setting('app.tenant_id') policy — this table gets no
-- special exemption from the isolation model just because it's new. The
-- INSERT in tenant-delete.js runs inside the SAME withTenant() transaction
-- that just deleted the tenant's other rows, so app.tenant_id is already set
-- to that tenant for the whole transaction and the WITH CHECK below is
-- satisfied without any special-casing.
--
-- tenant_id is ON DELETE SET NULL rather than CASCADE, on purpose: if the
-- `tenants` row itself is ever removed later (a real account deprovisioning,
-- which this migration does not implement — see the comment on DELETE_ORDER),
-- a CASCADE here would delete the one row whose entire purpose is to prove a
-- deletion happened. tenant_key (the Clerk org id, plain text) is kept
-- alongside it for exactly that reason: it survives even if tenant_id is
-- later nulled out.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_deletions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_key TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  documents INTEGER NOT NULL DEFAULT 0,
  objects INTEGER NOT NULL DEFAULT 0,
  failed_objects JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_tenant_deletions_tenant_key ON tenant_deletions (tenant_key);

ALTER TABLE tenant_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_deletions_isolate ON tenant_deletions;
CREATE POLICY tenant_deletions_isolate ON tenant_deletions
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- Same pattern as 03-retrieval.sql's grant block: grant to whichever
-- application role(s) actually exist, rather than assuming one name.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT ON tenant_deletions TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof ------------------------------------------------------------
-- Expect: rls=t, force=t, exactly one policy.
SELECT c.relrowsecurity      AS rls,
       c.relforcerowsecurity AS force,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = 'tenant_deletions') AS policies
  FROM pg_class c
 WHERE c.relname = 'tenant_deletions';
