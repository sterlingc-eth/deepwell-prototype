-- ============================================================================
-- 14-billing.sql — run AFTER 13-entity-uniqueness.sql. Idempotent; safe to re-run.
--
-- Stripe billing: subscription state on `tenants`, an idempotency ledger for
-- webhook events, and two SECURITY DEFINER functions so the Stripe webhook
-- (no Clerk session, no app.tenant_id — it identifies a tenant by Stripe
-- customer id, not by a resolved tenant context) can write without bypassing
-- RLS wholesale. Same shape as resolve_tenant()/resolve_api_key(): a narrow
-- function that runs outside RLS and does exactly one job.
--
-- NEON PASTE — run this file's contents as-is in the Neon SQL editor (or
-- `node M3-config/run-migration-v2.js M3-config/14-billing.sql`), after
-- 13-entity-uniqueness.sql. Safe to paste twice.
-- ============================================================================

-- ---- 1. billing columns on tenants -------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS plan                   TEXT,
  ADD COLUMN IF NOT EXISTS billing_status         TEXT,
  ADD COLUMN IF NOT EXISTS trial_ends_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_used             BOOLEAN NOT NULL DEFAULT false;

-- ---- 2. billing_events — webhook idempotency ledger --------------------------
-- One row per Stripe event id. Stripe retries a webhook until it gets a 2xx,
-- so the same event.id can arrive more than once; billing_record_event()
-- below is the only writer and is a single INSERT ... ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS billing_events (
  id          TEXT PRIMARY KEY,             -- Stripe event id (evt_...)
  type        TEXT NOT NULL,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB
);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_billing_events ON billing_events;
CREATE POLICY tenants_isolate_billing_events ON billing_events
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid);
-- No WITH CHECK / no ordinary INSERT path: the only writer is
-- billing_record_event() (SECURITY DEFINER, below), called from the webhook
-- handler, which has no app.tenant_id set at all.

-- ---- 3. billing_tenant_by_customer() -----------------------------------------
-- The chicken-and-egg, same as resolve_api_key(): the webhook knows a Stripe
-- customer id, not a tenant. Runs outside RLS to answer only "what tenant
-- uuid owns this Stripe customer" — never a listing, never another
-- customer's row.
CREATE OR REPLACE FUNCTION billing_tenant_by_customer(p_customer text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM tenants WHERE stripe_customer_id = p_customer;
$$;

-- ---- 4. billing_apply() ------------------------------------------------------
-- Merge-patch a tenant's billing columns from a webhook event. Every field is
-- optional (present-key-wins via `?`, not NULL-wins) so a partial patch never
-- clobbers columns the triggering event didn't carry an opinion about.
-- `p_patch.limits`, when present, replaces tenants.limits wholesale (the
-- caller always computes the full PLAN_LIMITS object for the new plan, never
-- a partial one).
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
    limits                 = CASE WHEN p_patch ? 'limits' THEN p_patch->'limits' ELSE limits END
  WHERE id = p_tenant_id;
$$;

-- ---- 5. billing_record_event() -----------------------------------------------
-- Returns true the first time an event id is seen (caller should process it),
-- false on a replay (caller returns 200 immediately, does nothing else).
CREATE OR REPLACE FUNCTION billing_record_event(p_id text, p_type text, p_tenant_id uuid, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_inserted boolean;
BEGIN
  INSERT INTO billing_events (id, type, tenant_id, payload)
  VALUES (p_id, p_type, p_tenant_id, p_payload)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

-- ---- 6. grants ----------------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      -- SELECT only: the sole writer is billing_record_event() below, which
      -- runs SECURITY DEFINER (as the function owner) and needs no grant on
      -- the table itself to insert. Granting INSERT here too would let any
      -- caller with normal RLS context bypass billing_record_event's
      -- idempotency check entirely — exactly what "webhook writes go
      -- through the SECURITY DEFINER functions only" rules out.
      EXECUTE format('GRANT SELECT ON billing_events TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION billing_tenant_by_customer(text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION billing_apply(uuid, jsonb) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION billing_record_event(text, text, uuid, jsonb) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 7. proof -----------------------------------------------------------------
-- Expect: billing_events reports rls=t and force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'billing_events';

-- Expect: three rows, all prosecdef = true.
SELECT p.proname, p.prosecdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('billing_tenant_by_customer', 'billing_apply', 'billing_record_event');
