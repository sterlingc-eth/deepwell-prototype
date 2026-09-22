-- ============================================================================
-- 27-request-context.sql — run AFTER 24-tenant-limits-plan.sql. Idempotent;
-- safe to re-run. OPTIONAL — the application works without this file (see
-- api/_lib/recordsStore.js's fetchRequestContextRow, which falls back to the
-- three separate queries this collapses whenever get_request_context()
-- doesn't exist yet).
--
-- API_PERF_2026-09-22: every authenticated request that reaches withTenant()
-- was running THREE SECURITY DEFINER round trips before it did any of its own
-- work — resolve_tenant() (recordsStore.js), a plain `tenants` row SELECT for
-- billing fields (plan.js / upload-url.js), and get_tenant_limits()
-- (rateLimit.js) — each a separate network round trip to Postgres, each
-- roughly the same 50-150ms cost regardless of how little data it returns.
-- This folds all three into one function, so ONE round trip returns
-- everything a request needs to know about its tenant: the uuid (creating the
-- tenant on first sight, exactly as resolve_tenant() already does), its plan
-- and billing status, and its resolved limits jsonb.
--
-- Cached for 5 minutes per warm instance (see recordsStore.js's
-- getTenantContext) — this migration does not change that; it only makes the
-- occasional cache-miss query cheaper.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_request_context(p_tenant_key text, p_tenant_name text)
RETURNS TABLE(
  tenant_id          uuid,
  plan               text,
  billing_status     text,
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  limits             jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Same upsert-or-find behavior as resolve_tenant() — this IS resolve_tenant(),
  -- not a reimplementation of it, so the two can never disagree about a tenant's uuid.
  v_id := resolve_tenant(p_tenant_key, p_tenant_name);

  RETURN QUERY
    SELECT t.id, t.plan, t.billing_status, t.trial_ends_at, t.current_period_end, get_tenant_limits(t.id)
      FROM tenants t
     WHERE t.id = v_id;
END;
$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION get_request_context(text, text) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof --------------------------------------------------------------
-- Expect: one row, SECURITY DEFINER = true.
SELECT p.proname, p.prosecdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'get_request_context';
