-- M3-config/35-test-account-limits.sql  (2026-09-25)
-- TESTING ACCOUNT ONLY: Sonoran Comfort Air (Clerk org org_3JZNNONccwrYbVGY5wTekSRN6YZ).
-- 1) Resets today's AI-call counter to 0.
-- 2) Raises this account's daily caps so exams/benchmarks don't stop midway:
--    20,000 model calls/day (default 2,000) and 20,000 asks/day at 120/min (default 900/day, 20/min).
-- Paying customers are untouched. Safe to paste again any day to reset the counter.

DO $$
DECLARE v_id uuid;
BEGIN
  -- resolve_tenant (M3-config/02) is SECURITY DEFINER, so it can find the tenant before RLS is set.
  v_id := resolve_tenant('org_3JZNNONccwrYbVGY5wTekSRN6YZ', NULL);
  PERFORM set_config('app.tenant_id', v_id::text, true);

  UPDATE tenants
     SET limits = COALESCE(limits, '{}'::jsonb)
                  || '{"maxModelCallsPerDay": 20000, "ask": {"perDay": 20000, "perMinute": 120}, "testAccount": true}'::jsonb
   WHERE id = v_id;

  UPDATE usage_counters
     SET model_calls = 0, requests = 0
   WHERE tenant_id = v_id AND day = (now() AT TIME ZONE 'utc')::date;

  DELETE FROM rate_limit_windows WHERE tenant_id = v_id;

  RAISE NOTICE 'Test account % reset and limits raised.', v_id;
END $$;

-- Check: should show maxModelCallsPerDay 20000.
SELECT get_tenant_limits(resolve_tenant('org_3JZNNONccwrYbVGY5wTekSRN6YZ', NULL)) AS limits;
