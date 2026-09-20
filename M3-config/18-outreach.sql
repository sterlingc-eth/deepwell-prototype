-- ============================================================================
-- 18-outreach.sql — run AFTER 16-notifications.sql. Idempotent; safe to re-run.
--
-- Customer outreach (handoffs/OUTREACH_2026-09-20.md): automated email to
-- customers whose equipment is close to (or past) the end of its warranty,
-- pitching an extended warranty / maintenance agreement. Two tables:
--
--   tenant_outreach_settings — one row per tenant, created on first
--     "Save settings". Sending is OFF by default (enabled=false) — nothing
--     goes out until an admin opts in.
--
--   outreach_messages — one row per (equipment, tier) draft ever generated.
--     UNIQUE (tenant_id, equipment_id, tier) is the dedupe rule
--     api/_lib/routes/outreach.js's `generate` relies on (INSERT ... ON
--     CONFLICT DO NOTHING), same idiom as 16-notifications.sql's
--     notifications_sent. A unit that moves expiring-90 -> expiring-30 ->
--     expired gets three rows (three different tier values) — an
--     intentional re-draft on a genuine tier change, never a re-send of the
--     same tier.
--
-- CRON-PATH FUNCTION: the nightly sweep (api/_lib/routes/cron-sweep.js) has
-- no per-request Clerk session and visits many tenants in one process, so
-- listing which tenants have outreach enabled goes through a small
-- SECURITY DEFINER function (same cross-tenant-read problem
-- opsStore.js's listTenantKeys() and 16-notifications.sql's
-- list_notification_eligible_tenants() already document). Once it has a
-- tenant's key/name, the sweep uses the ordinary per-tenant
-- resolve_tenant()/SET LOCAL transaction (recordsStore.js's withTenant) to
-- actually generate/send — no other SECURITY DEFINER function is needed.
-- The interactive API (POST /api/account?action=outreach), by contrast, has
-- a real Clerk session and never calls list_outreach_enabled_tenants() or
-- mark_outreach_swept().
-- ============================================================================

-- ---- 1. tenant_outreach_settings --------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_outreach_settings (
  tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT false,
  mode       TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('review', 'auto')),
  lead_days  INTEGER NOT NULL DEFAULT 90,
  from_name  TEXT,
  reply_to   TEXT,
  offer_text TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_outreach_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_outreach_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_outreach_settings ON tenant_outreach_settings;
CREATE POLICY tenants_isolate_outreach_settings ON tenant_outreach_settings
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. outreach_messages ----------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  equipment_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL CHECK (tier IN ('expiring-90', 'expiring-30', 'expired')),
  to_email     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  -- 'sending' (REVIEW FIX 2026-09-20): flipped on immediately after
  -- sendApproved's FOR UPDATE SKIP LOCKED select, before the Resend call, so
  -- a double-click (or an overlapping request) can never send the same row
  -- twice — see api/_lib/routes/outreach.js's sendApprovedBatch.
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'skipped', 'failed', 'bounced')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  provider_id  TEXT,
  error        TEXT,
  UNIQUE (tenant_id, equipment_id, tier)
);

-- Re-run safety: a database where this table already exists from BEFORE the
-- 'sending' status was added gets the wider constraint here too, so this
-- migration file stays the single source of truth no matter which version
-- of it was pasted first.
DO $$
BEGIN
  ALTER TABLE outreach_messages DROP CONSTRAINT IF EXISTS outreach_messages_status_check;
  ALTER TABLE outreach_messages ADD CONSTRAINT outreach_messages_status_check
    CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'skipped', 'failed', 'bounced'));
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_messages_tenant_status
  ON outreach_messages (tenant_id, status, created_at DESC);

ALTER TABLE outreach_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_messages FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_outreach_messages ON outreach_messages;
CREATE POLICY tenants_isolate_outreach_messages ON outreach_messages
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 3. cross-tenant read: which tenants the nightly sweep should visit ----
-- Only tenants that opted in (enabled=true) on an active/trialing plan.
-- `mode` is returned so the sweep can branch: 'auto' generates AND sends,
-- 'review' only generates + notifies. Ordered by this table's own
-- updated_at (bumped by mark_outreach_swept below every time the sweep
-- visits, same fairness idea as 16-notifications.sql's
-- list_notification_eligible_tenants — the population here is opt-in and
-- expected to be small, so a simple ascending order is enough).
CREATE OR REPLACE FUNCTION list_outreach_enabled_tenants()
RETURNS TABLE(tenant_id uuid, tenant_key text, tenant_name text, mode text, lead_days int,
              from_name text, reply_to text, offer_text text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.clerk_org_id, t.name, s.mode, s.lead_days, s.from_name, s.reply_to, s.offer_text
    FROM tenant_outreach_settings s
    JOIN tenants t ON t.id = s.tenant_id
   WHERE s.enabled = true
     AND t.clerk_org_id IS NOT NULL
     AND t.billing_status IN ('active', 'trialing')
   ORDER BY s.updated_at ASC NULLS FIRST
   LIMIT 500;
$$;

-- ---- 3b. cron-path writer: "this tenant's outreach was swept" -------------
CREATE OR REPLACE FUNCTION mark_outreach_swept(p_tenant_id uuid, p_at timestamptz)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE tenant_outreach_settings SET updated_at = p_at WHERE tenant_id = p_tenant_id;
$$;

-- ---- 4. grants ---------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_outreach_enabled_tenants() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION mark_outreach_swept(uuid,timestamptz) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 5. proof -----------------------------------------------------------
-- Expect: two rows — both tables, relrowsecurity and relforcerowsecurity both true.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('tenant_outreach_settings', 'outreach_messages');

-- Expect: one row — the (tenant, equipment, tier) uniqueness constraint exists.
SELECT conname FROM pg_constraint
 WHERE conrelid = 'outreach_messages'::regclass AND contype = 'u';

-- Expect: two rows, prosecdef = true for each.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('list_outreach_enabled_tenants', 'mark_outreach_swept');
