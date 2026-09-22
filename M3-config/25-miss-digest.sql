-- ============================================================================
-- 25-miss-digest.sql — run AFTER 23-ask-misses.sql. Idempotent; safe to re-run.
--
-- Donovan self-learning loop, Tier 1 (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md,
-- api/_lib/missDigest.js): a DAILY MISS DIGEST for the DeepWell platform
-- owners (the operators of DeepWell itself, never a tenant) — every
-- ask_misses row across every tenant in the last 24h, grouped and summarized.
--
-- Three additions, all SECURITY DEFINER for the same reason every other
-- cross-tenant read/write in this schema is (opsStore.js's listTenantKeys,
-- M3-config/16-notifications.sql's list_notification_eligible_tenants /
-- record_warranty_notification): the app connects as deepwell_rls, which is
-- NOBYPASSRLS, and both `ask_misses` (23-ask-misses.sql) and `tenants`
-- (02-tenancy-fix.sql) carry FORCE ROW LEVEL SECURITY keyed on
-- app.tenant_id — a cross-tenant read/write with no single tenant set sees
-- (or touches) nothing under an ordinary connection.
--
-- 1. list_ask_misses_window(from, to) — cross-tenant, read-only. Returns
--    exactly the columns the digest needs and nothing else: tenant_id,
--    outcome, question_normalized (re-truncated to 160 chars — the digest is
--    a summary, not a full transcript), detected_conditions (the most
--    recent row's own array, in place of trying to merge JSONB arrays),
--    count, first_seen, last_seen. Grouped by (tenant_id, outcome,
--    question_normalized) — api/_lib/missDigest.js does the further
--    cross-tenant aggregation (same question asked by several tenants) in
--    JS, where it's easier to unit-test (scripts/verify-miss-digest.mjs).
--    No question TEXT beyond question_normalized ever leaves this function —
--    same "normalized only, not the raw ask" restriction the digest's own
--    redaction step (missDigest.js) assumes going in.
--
-- 2. claim_platform_daily_task(tenant_key, task_key, date) — generic
--    once-per-UTC-day claim, atomic (single UPDATE, no read-then-write
--    race): flips tenants.settings->>task_key to `date` and returns true
--    only when it actually changed something (i.e., this call is the first
--    to claim `date` for `task_key`). Used by the nightly cron step to make
--    sure a re-triggered sweep (or two overlapping invocations) sends the
--    digest at most once per day — same tenants.settings idiom
--    mark_tenant_digest_sent (16-notifications.sql) already uses for the
--    warranty digest, just generic on the key name so this migration adds
--    no new table. Resolves `tenant_key` via tenants.clerk_org_id, which
--    (see api/_lib/auth.js's deriveAuth / resolve_tenant in
--    02-tenancy-fix.sql) holds a real Clerk org id OR the solo `user_<id>`
--    fallback string — whichever DEEPWELL_FOUNDER_TENANT_ID is set to.
--    Returns false (never throws) if no tenant matches that key, so a typo'd
--    env var fails closed (skip sending) rather than silently claiming
--    nothing forever.
--
-- 3. insert_platform_notification(tenant_key, kind, title, body, link) —
--    writes one row directly to `notifications` (the bell-icon table) for a
--    named tenant, same clerk_org_id resolution as above. `notifications`
--    was warranty-only until now (unit_id NOT NULL, one row per notified
--    unit) — the ALTER below drops that NOT NULL so a platform-level
--    notification (no unit involved at all) can have unit_id NULL. This is
--    additive and backward compatible: every existing warranty notification
--    already has a real unit_id, GET /api/account?action=notifications
--    (api/_lib/routes/notifications.js) never selects unit_id, and the FK
--    itself (REFERENCES entities(id)) is untouched — NULL simply satisfies
--    any FK trivially. Running the ALTER again once the column is already
--    nullable is a no-op, not an error.
-- ============================================================================

-- ---- 1. notifications.unit_id becomes optional -------------------------------
ALTER TABLE notifications ALTER COLUMN unit_id DROP NOT NULL;

-- ---- 2. cross-tenant read: grouped ask_misses in a time window --------------
CREATE OR REPLACE FUNCTION list_ask_misses_window(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  tenant_id            UUID,
  outcome              TEXT,
  question_normalized  TEXT,
  detected_conditions  JSONB,
  count                BIGINT,
  first_seen           TIMESTAMPTZ,
  last_seen            TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.tenant_id,
    m.outcome,
    LEFT(COALESCE(m.question_normalized, m.question), 160) AS question_normalized,
    (ARRAY_AGG(m.detected_conditions ORDER BY m.created_at DESC))[1] AS detected_conditions,
    COUNT(*) AS count,
    MIN(m.created_at) AS first_seen,
    MAX(m.created_at) AS last_seen
  FROM ask_misses m
  WHERE m.created_at >= p_from AND m.created_at < p_to
  GROUP BY m.tenant_id, m.outcome, LEFT(COALESCE(m.question_normalized, m.question), 160)
  ORDER BY count DESC
  LIMIT 5000;
$$;

-- ---- 3. cron-path writer: generic once-per-UTC-day claim --------------------
CREATE OR REPLACE FUNCTION claim_platform_daily_task(p_tenant_key text, p_task_key text, p_date text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE tenants
     SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(p_task_key, p_date)
   WHERE clerk_org_id = p_tenant_key
     AND (settings ->> p_task_key) IS DISTINCT FROM p_date;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- ---- 4. cron-path writer: one in-app notification for a named tenant -------
CREATE OR REPLACE FUNCTION insert_platform_notification(
  p_tenant_key text,
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
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE clerk_org_id = p_tenant_key;
  IF v_tenant_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO notifications (tenant_id, kind, title, body, link)
  VALUES (v_tenant_id, p_kind, p_title, p_body, p_link);
  RETURN true;
END;
$$;

-- ---- 5. grants ----------------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_ask_misses_window(timestamptz,timestamptz) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION claim_platform_daily_task(text,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION insert_platform_notification(text,text,text,text,text) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 6. proof -----------------------------------------------------------------
-- Expect: not null (column is nullable now).
SELECT attnotnull AS unit_id_still_not_null
  FROM pg_attribute
 WHERE attrelid = 'notifications'::regclass AND attname = 'unit_id';

-- Expect: three rows, prosecdef = true for each.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('list_ask_misses_window', 'claim_platform_daily_task', 'insert_platform_notification');
