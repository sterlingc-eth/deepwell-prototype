-- ============================================================================
-- 61-support-assistant.sql — run AFTER 12 (rate limit windows) and 03 (base grants). Idempotent; safe to re-run.
-- OPTIONAL: api/_lib/support/limits.js tolerates the table/function not existing (warns once, falls back to
-- an in-memory counter for the per-IP request limits, and REFUSES model calls because it cannot read the
-- shared spend caps — the free FAQ keeps answering). Same convention as 23 / 56 / 58.
--
-- Round 28 — DeepWell Support Assistant (website widget, unauthenticated visitors). These counters have NO
-- tenant (a website visitor has none), so they cannot live in rate_limit_windows (tenant_id NOT NULL FK).
-- support_public_windows holds only one-way hashes and integers:
--   key_hash    "ip:<hash>:m" / "ip:<hash>:d" / "iph:<hash>:d" (per-IP-hash minute / day / handoff-day windows,
--               the IP salted with the UTC day so it cannot be correlated across days), "pub:d" (public
--               pool spend, micro-USD, per UTC day), "plat:d" (platform-wide spend, micro-USD, per UTC day).
--   window_start  start of the minute or UTC day
--   units        request count, or micro-USD for the spend keys
-- No conversation text, no IP, no email, no tenant id is ever stored here.
--
-- Access: the table is ENABLE + FORCE ROW LEVEL SECURITY with one permissive policy, and NO table privileges
-- are granted to the app roles — the only way in is support_public_bump(), SECURITY DEFINER, so a compromised
-- request path can bump a counter but never read or rewrite the table. Nothing here touches customer data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS support_public_windows (
  key_hash     TEXT        NOT NULL CHECK (char_length(key_hash) <= 80),
  window_start TIMESTAMPTZ NOT NULL,
  units        BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_support_public_windows_start ON support_public_windows (window_start);

ALTER TABLE support_public_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_public_windows FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_public_windows_all ON support_public_windows;
CREATE POLICY support_public_windows_all ON support_public_windows
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION support_public_bump(
  p_key          text,
  p_window_start timestamptz,
  p_units        bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_units bigint;
BEGIN
  -- Opportunistic purge (windows older than 3 days are never read again); cheap thanks to the start index.
  IF random() < 0.02 THEN
    DELETE FROM support_public_windows WHERE window_start < NOW() - INTERVAL '3 days';
  END IF;

  INSERT INTO support_public_windows AS w (key_hash, window_start, units)
  VALUES (left(p_key, 80), p_window_start, GREATEST(p_units, 0))
  ON CONFLICT (key_hash, window_start) DO UPDATE
    SET units = w.units + GREATEST(EXCLUDED.units, 0)
  RETURNING units INTO v_units;

  RETURN v_units;
END;
$$;

REVOKE ALL ON support_public_windows FROM PUBLIC;
REVOKE ALL ON FUNCTION support_public_bump(text, timestamptz, bigint) FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION support_public_bump(text, timestamptz, bigint) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof ------------------------------------------------------------
-- Expect: rls=t, force=t, one policy.
SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = 'support_public_windows') AS policies
  FROM pg_class c WHERE c.relname = 'support_public_windows';

-- Expect: one row, SECURITY DEFINER = true.
SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'support_public_bump';

-- Expect: 1, then 2 (the counter increments through the function only).
SELECT support_public_bump('proof:test', date_trunc('minute', NOW()), 1);
SELECT support_public_bump('proof:test', date_trunc('minute', NOW()), 1);
DELETE FROM support_public_windows WHERE key_hash = 'proof:test';
