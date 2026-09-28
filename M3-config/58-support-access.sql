-- ============================================================================
-- 58-support-access.sql — run AFTER 03 (tenants + base grants). Idempotent;
-- safe to re-run. OPTIONAL: api/_lib/privacy/supportAccess.js tolerates
-- either table not existing yet (warn once, empty/false results, never a
-- failed request) — same convention as ask_misses (23) / donovan_promoted_
-- tests (56).
--
-- Round 22 (S2, privacy — owner ask: "when companies ask if we can see their
-- data once stored, how do we defend it and ensure privacy?"): today, a
-- DeepWell staff account that is a Clerk MEMBER of a customer's org (added
-- for support, or on the DEEPWELL_OPERATOR_USER_IDS allowlist) can call every
-- api/review.js operator action (learningReplay, examPromote/List/Export,
-- learningList, scorecardRun/Baseline) against THAT CUSTOMER'S real
-- documents/misses/learning data forever, with no time limit, no revocation,
-- and nothing the customer can see. These two tables close that: a tenant's
-- own admin must explicitly GRANT time-boxed, revocable access before any of
-- those actions will run against their tenant (api/review.js's
-- gateSupportAccess), and every access — granted or "break-glass" emergency —
-- is appended to staff_access_log, which the SAME tenant admin can read back
-- in Settings ("Access log"). Neither table is used for a tenant's OWN admin
-- acting on their OWN tenant's ordinary features (correctField, verifyDocument,
-- etc.) or for the founder tenant's own dogfooding data — see
-- supportAccess.js's requireSupportAccess for the founder-tenant exemption,
-- and docs/SECURITY.md for the customer-facing explanation.
--
-- Columns (support_access_grants):
--   granted_by     the tenant admin's own Clerk user id (from the verified
--                  token, never the request body — same rule as everywhere
--                  else in this codebase).
--   reason          free text the admin gives for the grant (e.g. "helping
--                  debug a missing invoice") — shown back to them in the
--                  Access log, not enforced/validated beyond a length cap.
--   expires_at      when this grant stops being active. No default: the
--                  caller (api/_lib/privacy/supportAccess.js's
--                  grantSupportAccess) always computes it from an hours
--                  value, capped at 168h (7 days) — see that file's
--                  MAX_GRANT_HOURS.
--   revoked_at/by   set the moment a tenant admin revokes early; a revoked
--                  grant is never active again even if expires_at is still
--                  in the future.
--
-- Columns (staff_access_log):
--   staff_user_id   the ACTING staff member's own Clerk user id (from the
--                  verified token) — who, not what they claimed to be.
--   action          the api/review.js action name (e.g. "learningReplay") —
--                  what was done, never the question/answer/document content
--                  itself.
--   record_count    how many rows the action touched/returned — a number,
--                  never the rows.
--   is_emergency /
--   emergency_reason  the "break-glass" path: access proceeded with NO
--                  active grant because the caller supplied a reason. Always
--                  TRUE-flagged and visible in the tenant's own Access log —
--                  never a silent override.
--   grant_id        which grant covered this access, if any (NULL for an
--                  emergency access, or once the grant itself is deleted —
--                  ON DELETE SET NULL keeps the log row, which is the whole
--                  point of an audit log, even if the grant row is later
--                  cleaned up).
-- ============================================================================

-- ---- 1. support_access_grants --------------------------------------------------
CREATE TABLE IF NOT EXISTS support_access_grants (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_by   TEXT NOT NULL,
  reason       TEXT CHECK (char_length(reason) <= 500),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  revoked_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_access_grants_tenant_active
  ON support_access_grants (tenant_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_support_access_grants ON support_access_grants;
CREATE POLICY tenants_isolate_support_access_grants ON support_access_grants
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. staff_access_log -------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_access_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id     TEXT,
  action            TEXT NOT NULL CHECK (char_length(action) <= 120),
  record_count      INTEGER,
  is_emergency      BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_reason  TEXT CHECK (char_length(emergency_reason) <= 500),
  grant_id          UUID REFERENCES support_access_grants(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_access_log_tenant_created
  ON staff_access_log (tenant_id, created_at DESC);

ALTER TABLE staff_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_access_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_staff_access_log ON staff_access_log;
CREATE POLICY tenants_isolate_staff_access_log ON staff_access_log
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 3. grants ------------------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have
-- SELECT/INSERT/UPDATE/DELETE on every table in the schema (02, 03) — same
-- note every other table's own migration in this directory makes.

-- ---- 4. proof ---------------------------------------------------------------
-- Expect: rls=t, force=t for both tables.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('support_access_grants', 'staff_access_log');

-- Expect: one row per table — the tenant-isolation policy is present.
SELECT polname FROM pg_policy
 WHERE polrelid = 'support_access_grants'::regclass AND polname = 'tenants_isolate_support_access_grants'
 UNION ALL
SELECT polname FROM pg_policy
 WHERE polrelid = 'staff_access_log'::regclass AND polname = 'tenants_isolate_staff_access_log';
