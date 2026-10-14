-- ============================================================================
-- 71-google-sync.sql  (OWNER RUNS THIS; nothing in the app needs it until DEEPWELL_GOOGLE_SYNC=1)
-- Google Drive + Gmail attachment sync: two tenant tables and one cross-tenant listing function.
-- Idempotent; safe to re-run. Run after 01b-app-role.sql. Adds NO columns to existing tables.
--
--   google_connections : one row per organization per source ('drive' | 'gmail'). The Google refresh token is stored
--                        ENCRYPTED (AES-256-GCM, key in the GOOGLE_TOKEN_KEY env variable); the database never holds it in the clear.
--   google_sync_items  : one row per Drive file / Gmail attachment seen. Holds the Drive file id (or message:attachment id),
--                        the content checksum, the DeepWell document it became, its version number, and whether it was
--                        later removed in Google (flagged here; the DeepWell copy is kept).
--   list_google_sync_tenants() : SECURITY DEFINER, returns ONLY the tenant keys that have an active connection, so the
--                        scheduled job does not have to open every organization (same pattern as list_all_tenant_keys()).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS google_connections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('drive', 'gmail')),
  scope_mode       TEXT NOT NULL DEFAULT 'narrow' CHECK (scope_mode IN ('narrow', 'full')),
  google_email     TEXT,
  refresh_token_enc TEXT,                       -- 'v1.<iv>.<tag>.<ciphertext>' (base64url); NULL after disconnect
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'needs-reconnect', 'disconnected')),
  config           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- Drive: folders/files chosen. Gmail: labels, sender addresses, look-back
  sync_state       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- Drive: changes page token + initial-import queue. Gmail: time cursor
  connected_by     TEXT,
  last_sync_at     TIMESTAMPTZ,
  last_result      TEXT,
  last_error       TEXT,
  files_imported   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS google_sync_items (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id    UUID NOT NULL REFERENCES google_connections(id) ON DELETE CASCADE,
  external_id      TEXT NOT NULL,               -- Drive file id, or '<gmail message id>:<attachment id>'
  filename         TEXT,
  source_checksum  TEXT,                        -- Drive md5Checksum / modifiedTime marker (cheap "did it change" test)
  content_sha256   TEXT,                        -- sha256 of the bytes DeepWell stored
  document_id      UUID REFERENCES documents(id) ON DELETE SET NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  previous_document_ids UUID[] NOT NULL DEFAULT '{}',
  state            TEXT NOT NULL DEFAULT 'imported' CHECK (state IN ('imported', 'removed-in-source', 'skipped', 'error')),
  note             TEXT,
  source_modified_at TIMESTAMPTZ,
  imported_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, connection_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_google_sync_items_conn_state ON google_sync_items (tenant_id, connection_id, state);
CREATE INDEX IF NOT EXISTS idx_google_sync_items_imported_at ON google_sync_items (tenant_id, imported_at);
CREATE INDEX IF NOT EXISTS idx_google_sync_items_document ON google_sync_items (document_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_connections', 'google_sync_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenants_isolate_%I ON %I', t, t);
    EXECUTE format($p$CREATE POLICY tenants_isolate_%I ON %I
      USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
      WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid)$p$, t, t);
  END LOOP;
END $$;

DO $$
DECLARE r TEXT; t TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['google_connections', 'google_sync_items'] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Cross-tenant listing for the scheduled job: identifiers only, and only organizations with a connection that is switched on.
CREATE OR REPLACE FUNCTION list_google_sync_tenants()
RETURNS TABLE(tenant_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT t.clerk_org_id
    FROM google_connections c
    JOIN tenants t ON t.id = c.tenant_id
   WHERE c.status = 'active' AND t.clerk_org_id IS NOT NULL
   LIMIT 2000;
$$;

REVOKE ALL ON FUNCTION list_google_sync_tenants() FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_google_sync_tenants() TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- proof: two rows, rls = t and force = t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('google_connections', 'google_sync_items') ORDER BY 1;
