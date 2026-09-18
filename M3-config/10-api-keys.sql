-- ============================================================================
-- 10-api-keys.sql — run AFTER 06-warranty-indexes.sql. Idempotent; safe to re-run.
--
-- API-key authentication, rate limiting and per-tenant spend caps.
--
-- Auth is Clerk-session-only today, which blocks every integration surface
-- that is not a browser holding a Clerk session (a Chrome extension, an MMS
-- intake worker, an MCP server, a partner API). This adds a second, tenant-
-- scoped credential a caller can present with `Authorization: Bearer dw_live_…`
-- instead of a Clerk JWT.
--
-- THE CHICKEN-AND-EGG, same shape as resolve_tenant() in 02-tenancy-fix.sql:
-- api.js has no tenant yet at the moment it needs to look a key up — that is
-- exactly what the key lookup is FOR — so it cannot go through withTenant()
-- (which requires a tenant to SET LOCAL app.tenant_id before it can run a
-- query at all), and api_keys is RLS-protected like every other table here.
-- resolve_api_key() is the same answer 02 already chose for this exact
-- problem: a narrow SECURITY DEFINER function that runs outside RLS, takes
-- only a hash, and returns only what a caller with that hash is entitled to
-- learn (never the key itself, never another tenant's rows). No policy on
-- api_keys is ever relaxed to make lookup-before-tenant work.
-- ============================================================================

-- ---- 1. api_keys ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  key_prefix     TEXT NOT NULL,           -- first 8 chars after "dw_live_", for display only
  key_hash       TEXT NOT NULL UNIQUE,    -- sha256 hex digest of the full key; the key itself is never stored
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  created_by     TEXT,                    -- Clerk user id of whoever minted it (not a FK: users is tenant-scoped and this is an admin action)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id) WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_api_keys ON api_keys;
CREATE POLICY tenants_isolate_api_keys ON api_keys
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. usage_counters -------------------------------------------------------
-- One row per tenant per day. The hard spend cap (rateLimit.js's daily check)
-- reads and increments this; the in-memory sliding window is the soft,
-- per-instance burst limit on top of it. See api/_lib/rateLimit.js.
CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day                 DATE NOT NULL,
  requests            INTEGER NOT NULL DEFAULT 0,
  model_calls         INTEGER NOT NULL DEFAULT 0,
  model_input_tokens  BIGINT  NOT NULL DEFAULT 0,
  model_output_tokens BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_usage_counters ON usage_counters;
CREATE POLICY tenants_isolate_usage_counters ON usage_counters
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 3. per-tenant overridable limits ----------------------------------------
-- rateLimit.js's defaults apply when this is '{}' or a key is absent; a tenant
-- that needs a higher (or lower) daily cap gets one written here, e.g.
--   {"ask": {"perDay": 2000}, "ingest": {"perDay": 1000}}
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---- 4. resolve_api_key() ----------------------------------------------------
-- Runs BEFORE app.tenant_id is known, so it must not depend on it and must not
-- run under ordinary RLS. Takes a hash (never the raw key — the caller
-- computed sha256 before this is called) and returns the tenant, scopes and
-- key id if, and only if, an unrevoked key with that hash exists. Touching
-- last_used_at happens in the SAME function/transaction so a lookup and its
-- bookkeeping cannot race or be skipped by a caller that forgets to record it.
--
-- Also returns tenant_key (tenants.clerk_org_id): every route in this codebase
-- reaches Postgres through recordsStore.js's withTenant({tenantKey, ...}),
-- which resolves a CLERK org id to the tenant uuid via resolve_tenant() — it
-- has no path that takes a uuid directly. Handing back the uuid alone would
-- force every api-key-authenticated route to either duplicate withTenant here
-- (recordsStore.js is owned by another engineer and not edited by this
-- migration) or call resolve_tenant with a uuid string, which would not match
-- any existing clerk_org_id and would silently INSERT a second, spurious
-- tenant row. Returning the real clerk_org_id lets api key auth hand
-- withTenant EXACTLY what a Clerk session would have: resolve_tenant finds
-- the SAME tenant by its real key and the existing code path is unchanged.
CREATE OR REPLACE FUNCTION resolve_api_key(p_key_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, scopes text[], tenant_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_key_hash IS NULL OR length(p_key_hash) <> 64 THEN
    RETURN; -- not a well-formed sha256 hex digest; zero rows, not an error
  END IF;

  RETURN QUERY
    UPDATE api_keys k
       SET last_used_at = NOW()
      FROM tenants t
     WHERE k.key_hash = p_key_hash
       AND k.revoked_at IS NULL
       AND t.id = k.tenant_id
    RETURNING k.id, k.tenant_id, k.scopes, t.clerk_org_id;
END;
$$;

-- ---- 5. usage/limit helpers, all SECURITY DEFINER, same reasoning as above --
-- rateLimit.js and usage.js run on api/_lib/apiKeyAuth.js's small auxiliary
-- pool (see that file), which never sets app.tenant_id — it exists precisely
-- for the moments before or outside an ordinary withTenant() transaction.
-- tenants and usage_counters are both FORCE ROW LEVEL SECURITY, so without
-- these, every query below would silently see or write zero rows. Each
-- function is narrow: it takes a tenant uuid the caller already resolved
-- (never a caller-supplied tenant KEY, and never returns another tenant's
-- data alongside it) and does exactly one job.

-- The per-tenant override for rateLimit.js's daily caps, e.g.
-- {"ask": {"perDay": 2000}}. Empty jsonb, not an error, when nothing is set.
CREATE OR REPLACE FUNCTION get_tenant_limits(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(limits, '{}'::jsonb) FROM tenants WHERE id = p_tenant_id;
$$;

-- Atomically bump today's counters and hand back the resulting row, so
-- rateLimit.js's daily-cap check reads the number it just wrote rather than
-- racing a second SELECT against it.
CREATE OR REPLACE FUNCTION increment_usage_counters(
  p_tenant_id     uuid,
  p_day           date,
  p_requests      integer DEFAULT 0,
  p_model_calls   integer DEFAULT 0,
  p_input_tokens  bigint  DEFAULT 0,
  p_output_tokens bigint  DEFAULT 0
)
RETURNS TABLE (requests integer, model_calls integer, model_input_tokens bigint, model_output_tokens bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    INSERT INTO usage_counters AS u (tenant_id, day, requests, model_calls, model_input_tokens, model_output_tokens)
    VALUES (p_tenant_id, p_day, GREATEST(p_requests, 0), GREATEST(p_model_calls, 0),
            GREATEST(p_input_tokens, 0), GREATEST(p_output_tokens, 0))
    ON CONFLICT (tenant_id, day) DO UPDATE
      SET requests            = u.requests            + GREATEST(EXCLUDED.requests, 0),
          model_calls         = u.model_calls         + GREATEST(EXCLUDED.model_calls, 0),
          model_input_tokens  = u.model_input_tokens  + GREATEST(EXCLUDED.model_input_tokens, 0),
          model_output_tokens = u.model_output_tokens + GREATEST(EXCLUDED.model_output_tokens, 0)
    RETURNING u.requests, u.model_calls, u.model_input_tokens, u.model_output_tokens;
END;
$$;

-- Read-only history for a future usage dashboard (usage.js's getUsage()).
-- Capped at 366 days so a bad `days` argument cannot turn into a full scan.
CREATE OR REPLACE FUNCTION get_usage_counters(p_tenant_id uuid, p_days integer DEFAULT 30)
RETURNS TABLE (day date, requests integer, model_calls integer, model_input_tokens bigint, model_output_tokens bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT day, requests, model_calls, model_input_tokens, model_output_tokens
    FROM usage_counters
   WHERE tenant_id = p_tenant_id
     AND day >= CURRENT_DATE - LEAST(GREATEST(COALESCE(p_days, 30), 1), 366)
   ORDER BY day DESC;
$$;

-- One grant block for every role and every function this migration adds.
-- deepwell_app is normally DROPPED by 04-cleanup.sql in production, so an
-- unconditional GRANT ... TO deepwell_app (the mistake 02 made, before 03
-- and 04 existed) would fail this whole migration on a database that has
-- already been cleaned up. Same EXISTS guard 03 and this file's earlier
-- section already use.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys, usage_counters TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION get_tenant_limits(uuid) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION increment_usage_counters(uuid, date, integer, integer, bigint, bigint) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION get_usage_counters(uuid, integer) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 6. proof -----------------------------------------------------------
-- Expect: both tables report rls=t and force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('api_keys', 'usage_counters')
 ORDER BY 1;

-- Expect: one row, SECURITY DEFINER = true.
SELECT p.proname, p.prosecdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'resolve_api_key';

-- Expect: one row — the new column on tenants.
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'tenants' AND column_name = 'limits';
