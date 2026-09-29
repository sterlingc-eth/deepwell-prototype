-- ============================================================================
-- 59-billing-record-event-fix.sql — run AFTER 14-billing.sql. Idempotent; safe
-- to re-run.
--
-- PRODUCTION BUG (Vercel logs 2026-09-21/24): every Stripe webhook that got
-- past signature + customer lookup died in billing_record_event() with
--   "operator does not exist: boolean > integer"
-- because 14-billing.sql declared `v_inserted boolean`, ran
-- `GET DIAGNOSTICS v_inserted = ROW_COUNT` and then `RETURN v_inserted > 0`.
-- ROW_COUNT is a count, not a boolean. Result: the webhook returned 500 and NO
-- subscription state (trial / active / past_due / canceled) was ever applied.
--
-- NEON PASTE — run this file as-is in the Neon SQL editor (or
-- `node M3-config/run-migration-v2.js M3-config/59-billing-record-event-fix.sql`).
-- The API also tolerates the OLD function (api/billing.js falls back to
-- applying without the idempotency ledger), so deploy order does not matter;
-- but paste this to restore duplicate-event protection.
-- ============================================================================

CREATE OR REPLACE FUNCTION billing_record_event(p_id text, p_type text, p_tenant_id uuid, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows integer;
BEGIN
  INSERT INTO billing_events (id, type, tenant_id, payload)
  VALUES (p_id, p_type, p_tenant_id, p_payload)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION billing_record_event(text, text, uuid, jsonb) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Proof: expect true (first call) then false (replay). Uses a throwaway id;
-- delete it afterwards:  DELETE FROM billing_events WHERE id = 'evt_migration_probe';
--   SELECT billing_record_event('evt_migration_probe', 'probe', NULL, '{}'::jsonb);
--   SELECT billing_record_event('evt_migration_probe', 'probe', NULL, '{}'::jsonb);
