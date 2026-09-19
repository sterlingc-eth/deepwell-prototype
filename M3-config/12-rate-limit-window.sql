-- ============================================================================
-- 12-rate-limit-window.sql — run AFTER 10-api-keys.sql. Idempotent; safe to re-run.
--
-- Postgres-backed per-minute burst limiter, replacing rateLimit.js's old
-- in-memory sliding window. That window lived in a module-level Map, so it
-- was per-Vercel-INSTANCE: a burst spread across several warm instances (the
-- ordinary case under real concurrent traffic) never engaged it at all —
-- N instances effectively multiplied perMinute by N, unbounded.
--
-- usage_counters (10-api-keys.sql) is NOT reused for this: it is keyed by
-- (tenant_id, day) with no bucket dimension at all, so a second, bucket- and
-- minute-scoped table is unavoidable rather than a schema change to a table
-- three other files already depend on. Same mechanism as usage_counters
-- otherwise: FORCE RLS, tenant-scoped policy, one SECURITY DEFINER atomic
-- upsert per call.
--
-- One row per (tenant, bucket, minute) — window_start is the minute
-- TRUNCATED (computed in JS, passed in as a timestamptz), so this is a fixed
-- window, not a sliding one: coarser at the boundary than the old in-memory
-- version, but exact and shared across every instance, which is what
-- actually matters for a burst.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket       TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  units        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, bucket, window_start)
);

ALTER TABLE rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_windows FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_rate_limit_windows ON rate_limit_windows;
CREATE POLICY tenants_isolate_rate_limit_windows ON rate_limit_windows
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- Atomic upsert, one round trip, same shape as increment_usage_counters().
-- SECURITY DEFINER for the same reason as every other rateLimit.js helper in
-- 10-api-keys.sql: this runs on the auxiliary pool, before/outside any
-- withTenant() transaction, against a FORCE ROW LEVEL SECURITY table.
--
-- Also deletes this (tenant, bucket)'s stale windows first — scoped to the
-- indexed primary key prefix, so it only ever touches this tenant+bucket's
-- own handful of rows, never a table scan. A fixed-window counter only ever
-- needs the CURRENT window; anything older is dead weight this table would
-- otherwise keep forever. Runs before the upsert so it can never delete the
-- row this same call is about to write.
CREATE OR REPLACE FUNCTION increment_rate_limit_window(
  p_tenant_id    uuid,
  p_bucket       text,
  p_window_start timestamptz,
  p_units        integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_units integer;
BEGIN
  DELETE FROM rate_limit_windows
   WHERE tenant_id = p_tenant_id AND bucket = p_bucket AND window_start < p_window_start;

  INSERT INTO rate_limit_windows AS w (tenant_id, bucket, window_start, units)
  VALUES (p_tenant_id, p_bucket, p_window_start, GREATEST(p_units, 0))
  ON CONFLICT (tenant_id, bucket, window_start) DO UPDATE
    SET units = w.units + GREATEST(EXCLUDED.units, 0)
  RETURNING units INTO v_units;

  RETURN v_units;
END;
$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_windows TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION increment_rate_limit_window(uuid, text, timestamptz, integer) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof ------------------------------------------------------------
-- Expect: rls=t, force=t, exactly one policy.
SELECT c.relrowsecurity      AS rls,
       c.relforcerowsecurity AS force,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = 'rate_limit_windows') AS policies
  FROM pg_class c
 WHERE c.relname = 'rate_limit_windows';

-- Expect: one row, SECURITY DEFINER = true.
SELECT p.proname, p.prosecdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'increment_rate_limit_window';
