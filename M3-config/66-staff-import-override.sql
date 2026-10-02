-- ============================================================================
-- 66-staff-import-override.sql — R43. Idempotent; safe to re-run. Run AFTER 62.
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- DeepWell staff can open a temporary "staff import" for ONE company (paste I1-allow-staff-import.sql from
-- M3-config/import/). That switch is a small note stored on the company's row (tenants.limits -> staffImport).
-- The billing webhook REPLACES a company's limits every time Stripe sends anything about its subscription, and
-- migration 62 taught it to keep a short list of hand-set notes. This migration adds "staffImport" to that list, so a
-- Stripe event in the middle of a multi-day import cannot silently switch the import off. It also makes the database's own
-- copy of "staffImport" authoritative: a patch can never write, extend, re-open or undo an import (see the function comment).
--
-- You do NOT need this to run the app: until it is pasted, I1 refuses to open an import (with a message saying so),
-- and nothing else changes. Nothing here touches customer data.
-- ============================================================================

CREATE OR REPLACE FUNCTION billing_apply(p_tenant_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    -- R35 + R43: the plan's own keys replace the old ones, but owner-set override keys survive the replacement.
    -- [staff-import-authoritative-v2] 'staffImport' is special: the value ALREADY IN THE DATABASE always wins, and whatever a patch says about it is thrown
    -- away. So a Stripe event can neither switch an import off part-way, nor (if a webhook read the row a moment before I2
    -- ran) quietly undo I2 by writing back a stale copy, nor open one that DeepWell staff did not.
    limits                 = CASE WHEN p_patch ? 'limits'
                                  THEN (CASE WHEN jsonb_typeof(p_patch->'limits') = 'object' THEN p_patch->'limits' ELSE '{}'::jsonb END
                                        - 'staffImport')
                                       || COALESCE(
                                            (SELECT jsonb_object_agg(k, v)
                                               FROM jsonb_each(COALESCE(limits, '{}'::jsonb)) AS e(k, v)
                                              WHERE k = 'staffImport'
                                                 OR (k IN ('extraPagesPerMonth', 'maxModelCallsPerDay', 'testAccount',
                                                           'ask', 'ingest', 'read', 'billing', 'support')
                                                     AND NOT (CASE WHEN jsonb_typeof(p_patch->'limits') = 'object' THEN p_patch->'limits' ELSE '{}'::jsonb END ? k))),
                                            '{}'::jsonb)
                                  ELSE limits END
  WHERE id = p_tenant_id;
$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION billing_apply(uuid, jsonb) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof ------------------------------------------------------------------
-- Expect one row: prosecdef = true, keeps_staff_import = true.
SELECT p.proname, p.prosecdef, pg_get_functiondef(p.oid) LIKE '%staff-import-authoritative-v2%' AS keeps_staff_import
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'billing_apply';
