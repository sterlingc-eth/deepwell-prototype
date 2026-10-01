-- ============================================================================
-- 62-rate-limit-refund-and-owner-overrides.sql — R35. Idempotent; safe to re-run. Run AFTER 12 and 14.
--
-- 1. increment_rate_limit_window() now accepts NEGATIVE units (a refund), floored at 0. rateLimit.js gives back
--    the units of a request it DENIED, so a client retrying a 429 can no longer keep the whole shop's per-minute
--    bucket pinned. The code tolerates this migration being absent (the old function just ignores negatives).
--
-- 2. billing_apply() no longer wipes owner-set keys in tenants.limits. It replaces limits wholesale on every
--    subscription event, so a hand-set extraPagesPerMonth / maxModelCallsPerDay / per-bucket override /
--    testAccount vanished the next time Stripe sent anything. The keys below are carried over from the
--    existing row when the incoming patch does not itself set them.
-- ============================================================================

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
    SET units = GREATEST(w.units + p_units, 0)
  RETURNING units INTO v_units;

  RETURN v_units;
END;
$$;

CREATE OR REPLACE FUNCTION billing_apply(p_tenant_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE tenants SET
    stripe_customer_id     = COALESCE(p_patch->>'stripe_customer_id', stripe_customer_id),
    stripe_subscription_id = CASE WHEN p_patch ? 'stripe_subscription_id'
                                   THEN p_patch->>'stripe_subscription_id' ELSE stripe_subscription_id END,
    plan                   = COALESCE(p_patch->>'plan', plan),
    billing_status         = COALESCE(p_patch->>'billing_status', billing_status),
    trial_ends_at          = CASE WHEN p_patch ? 'trial_ends_at'
                                   THEN NULLIF(p_patch->>'trial_ends_at','')::timestamptz ELSE trial_ends_at END,
    current_period_end     = CASE WHEN p_patch ? 'current_period_end'
                                   THEN NULLIF(p_patch->>'current_period_end','')::timestamptz ELSE current_period_end END,
    cancel_at_period_end   = COALESCE((p_patch->>'cancel_at_period_end')::boolean, cancel_at_period_end),
    trial_used             = trial_used OR COALESCE((p_patch->>'trial_used')::boolean, false),
    -- R35: the plan's own keys replace the old ones, but owner-set override keys survive the replacement.
    limits                 = CASE WHEN p_patch ? 'limits'
                                  THEN COALESCE(p_patch->'limits', '{}'::jsonb)
                                       || COALESCE(
                                            (SELECT jsonb_object_agg(k, v)
                                               FROM jsonb_each(COALESCE(limits, '{}'::jsonb)) AS e(k, v)
                                              WHERE k IN ('extraPagesPerMonth', 'maxModelCallsPerDay', 'testAccount',
                                                          'ask', 'ingest', 'read', 'billing', 'support')
                                                AND NOT (COALESCE(p_patch->'limits', '{}'::jsonb) ? k)),
                                            '{}'::jsonb)
                                  ELSE limits END
  WHERE id = p_tenant_id;
$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION increment_rate_limit_window(uuid, text, timestamptz, integer) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION billing_apply(uuid, jsonb) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof ------------------------------------------------------------------
-- Expect: two rows, prosecdef = true.
SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('increment_rate_limit_window', 'billing_apply');
