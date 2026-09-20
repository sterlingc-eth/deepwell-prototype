-- ============================================================================
-- 16-notifications.sql — run AFTER 14-billing.sql and 15-customer-profiles.sql.
-- Idempotent; safe to re-run.
--
-- Warranty-expiration notifications (handoffs/NOTIFICATIONS.md). Two tables:
--
--   notifications_sent — the dedupe ledger. One row per (tenant, unit, tier)
--     ever sent. A unit that moves expiring-90 -> expiring-30 -> expired gets
--     three rows (three different tier values) — each an intentional
--     re-notify on a genuine tier change. The SAME tier is never re-sent: the
--     unique constraint below is what api/_lib/notify.js's
--     record_warranty_notification() relies on (INSERT ... ON CONFLICT DO
--     NOTHING) instead of a SELECT-then-INSERT race.
--
--   notifications — the in-app record a signed-in user actually sees (bell
--     icon, NotificationsPanel). One row per notifications_sent row that was
--     newly inserted (see the function below) — never a bare duplicate.
--
-- CRON-PATH FUNCTIONS: the nightly sweep (api/_lib/routes/cron-sweep.js) has
-- no per-request Clerk session and iterates every eligible tenant in one
-- process, so it never has `app.tenant_id` set the way an ordinary
-- authenticated request does (see recordsStore.js's withTenant). Rather than
-- open a resolve_tenant()+SET LOCAL transaction per tenant just to insert two
-- rows, both cron-path writes and the cross-tenant tenant listing go through
-- small SECURITY DEFINER functions that take the tenant explicitly as an
-- argument (same idiom as 15-customer-profiles.sql's next_customer_number,
-- and the same cross-tenant-read problem opsStore.js's listTenantKeys()
-- already documents). The interactive notifications API
-- (GET/POST /api/account?action=notifications), by contrast, DOES have a
-- real Clerk session and uses the ordinary per-request tenant-scoped
-- connection like every other route — it never calls these functions.
-- ============================================================================

-- ---- 1. notifications_sent (dedupe ledger) ----------------------------------
CREATE TABLE IF NOT EXISTS notifications_sent (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT NOT NULL DEFAULT 'in-app',
  UNIQUE (tenant_id, unit_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_notifications_sent_tenant
  ON notifications_sent (tenant_id, sent_at DESC);

ALTER TABLE notifications_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_sent FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_notifications_sent ON notifications_sent;
CREATE POLICY tenants_isolate_notifications_sent ON notifications_sent
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. notifications (what the bell icon shows) ----------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
  ON notifications (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_unread
  ON notifications (tenant_id, read_at) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_notifications ON notifications;
CREATE POLICY tenants_isolate_notifications ON notifications
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 3. cross-tenant read: which tenants the nightly sweep should visit ----
-- Same NOBYPASSRLS problem opsStore.js's listTenantKeys() documents (the app
-- role cannot SELECT across tenants under FORCE RLS with no app.tenant_id
-- set) — SECURITY DEFINER is the fix here, scoped to read-only identifiers
-- plus the jsonb settings blob (for the emailDigest toggle), never document
-- content. Only tenants with an active or trialing plan are notification-
-- eligible — a canceled or never-subscribed tenant gets no digest email and
-- no cron-driven writes.
--
-- REVIEW FIX (2026-09-20): the whole cron sweep must fit inside
-- api/account.js's 60s maxDuration, so the notification step now stops
-- partway through a large tenant list when its shared deadline is close
-- (api/_lib/notify.js). A tenant skipped that way must not starve forever —
-- `last_notified_at` (settings.lastNotifiedAt, written by
-- mark_tenant_notified below every time a tenant is actually visited,
-- success or failure, NOT only when a digest email goes out) orders this
-- list oldest/never-visited first, so a skipped tenant leads the very next
-- run instead of being pushed to the back by tenants that keep getting
-- checked first.
CREATE OR REPLACE FUNCTION list_notification_eligible_tenants()
RETURNS TABLE(tenant_id uuid, tenant_key text, tenant_name text, settings jsonb, last_notified_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, clerk_org_id, name, COALESCE(settings, '{}'::jsonb),
         NULLIF(settings->>'lastNotifiedAt', '')::timestamptz
    FROM tenants
   WHERE clerk_org_id IS NOT NULL
     AND billing_status IN ('active', 'trialing')
   ORDER BY NULLIF(settings->>'lastNotifiedAt', '')::timestamptz ASC NULLS FIRST
   LIMIT 500;
$$;

-- ---- 3b. cron-path writer: "this tenant was visited" (fairness marker) ----
-- Written every time the sweep actually looks at a tenant, independent of
-- whether anything new was found or a digest was sent — mark_tenant_digest_
-- sent (below) is a DIFFERENT, narrower marker (only when an email actually
-- went out) and must not be reused for rotation fairness: a tenant with the
-- digest toggle off, or with nothing to report, would otherwise look
-- "never visited" forever and permanently hog the front of the queue.
CREATE OR REPLACE FUNCTION mark_tenant_notified(p_tenant_id uuid, p_at timestamptz)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE tenants
     SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('lastNotifiedAt', to_char(p_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   WHERE id = p_tenant_id;
$$;

-- ---- 4. cron-path writer: dedupe + in-app record, one atomic call ----------
-- Returns true only when this (tenant, unit, tier) had never been recorded
-- before — that return value is exactly "is this newly notified", which is
-- what the caller uses to decide whether to include the unit in today's
-- digest email. ON CONFLICT DO NOTHING makes two concurrent sweeps (or a
-- retried request) for the same (tenant, unit, tier) safe with no advisory
-- lock needed — a duplicate insert just does nothing and returns false.
CREATE OR REPLACE FUNCTION record_warranty_notification(
  p_tenant_id uuid,
  p_unit_id uuid,
  p_tier text,
  p_channel text,
  p_kind text,
  p_title text,
  p_body text,
  p_link text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO notifications_sent (tenant_id, unit_id, tier, channel)
  VALUES (p_tenant_id, p_unit_id, p_tier, COALESCE(p_channel, 'in-app'))
  ON CONFLICT (tenant_id, unit_id, tier) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO notifications (tenant_id, kind, title, body, link)
    VALUES (p_tenant_id, p_kind, p_title, p_body, p_link);
  END IF;

  RETURN v_count > 0;
END;
$$;

-- ---- 5. cron-path writer: the once-per-day digest-sent marker -------------
-- Stored in tenants.settings (jsonb, already exists — 01-create-schema.sql)
-- rather than a new column/table: it is a small per-tenant fact with no
-- query pattern of its own, same reasoning as the emailDigest toggle it
-- sits next to.
CREATE OR REPLACE FUNCTION mark_tenant_digest_sent(p_tenant_id uuid, p_sent_at timestamptz)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE tenants
     SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('lastDigestSentAt', to_char(p_sent_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   WHERE id = p_tenant_id;
$$;

-- ---- 6. grants ---------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_notification_eligible_tenants() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION record_warranty_notification(uuid,uuid,text,text,text,text,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION mark_tenant_digest_sent(uuid,timestamptz) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION mark_tenant_notified(uuid,timestamptz) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 7. proof -----------------------------------------------------------
-- Expect: two rows — both tables, relrowsecurity and relforcerowsecurity both true.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('notifications_sent', 'notifications');

-- Expect: one row — the (tenant, unit, tier) uniqueness constraint exists.
SELECT conname FROM pg_constraint
 WHERE conrelid = 'notifications_sent'::regclass AND contype = 'u';

-- Expect: four rows, prosecdef = true for each.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('list_notification_eligible_tenants', 'record_warranty_notification', 'mark_tenant_digest_sent', 'mark_tenant_notified');

-- Sanity count only (not a correctness proof — notifications carries no
-- unit_id/tier of its own to join back to notifications_sent by): a healthy
-- system has notifications.count <= notifications_sent.count, since
-- record_warranty_notification() inserts into notifications only on the
-- branch where it also just inserted into notifications_sent.
SELECT (SELECT COUNT(*) FROM notifications WHERE kind = 'warranty') AS warranty_notifications,
       (SELECT COUNT(*) FROM notifications_sent) AS sent_ledger_rows;
