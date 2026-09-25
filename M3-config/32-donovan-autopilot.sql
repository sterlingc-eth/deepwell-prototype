-- ============================================================================
-- 32-donovan-autopilot.sql — run AFTER 30-donovan-scorecard.sql. Idempotent;
-- safe to re-run. OPTIONAL: every code path that uses these tables/functions
-- tolerates them being absent (warn once, behave exactly as before — same
-- convention every other optional migration in this directory uses).
--
-- TEAM H (2026-09-24): storage for the AUTONOMOUS PER-TENANT LEARNING LOOP
-- (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md's nightly loop, generalized
-- from "the founder tenant only" to every paying/active tenant):
--
--   1. donovan_learned_tenant — TENANT-scoped learned vocabulary (synonym/
--      abbreviation) mined from ONE shop's own documents (api/_lib/learning/
--      vocabMining.js). Deliberately a SEPARATE table from the existing
--      PLATFORM-level donovan_learned/donovan_proposals (26-donovan-
--      learning.sql) rather than a tenant_id column bolted onto them — see
--      that migration's own header for why those are platform-level by
--      design (a learned English/HVAC-vocabulary fact benefits every
--      tenant), and api/_lib/learning/tenantOverlay.js's own header for the
--      full reasoning. Ordinary per-tenant shape (FORCE RLS + one
--      tenant-isolation policy, written through the app's own withTenant
--      connection) — NOT the SECURITY-DEFINER-only, zero-policy shape 26/29
--      use, because this data genuinely IS scoped to one tenant's own
--      connection, exactly like ask_misses / donovan_scorecard_*.
--
--   2. list_scorecard_failures_window(from, to) — cross-tenant, read-only,
--      SECURITY DEFINER (same reasoning as 25-miss-digest.sql's own
--      list_ask_misses_window: the app connects as deepwell_rls, NOBYPASSRLS,
--      and donovan_scorecard_results carries FORCE ROW LEVEL SECURITY keyed
--      on app.tenant_id). Feeds api/_lib/learning/gapReport.js's weekly
--      cross-tenant clustering. No customer data ever leaves this function:
--      a scorecard question is always the golden exam's own generic wording
--      (donovan_scorecard_results' own table comment, 30-donovan-
--      scorecard.sql), never a customer's document text. References
--      donovan_scorecard_results, which is ITSELF optional (30 may not be
--      applied) — a `LANGUAGE sql` function body is not bound to the catalog
--      at CREATE time, so this still creates cleanly either way; a caller
--      only sees a failure (caught + tolerated, same "warn once" idiom) if
--      the table is actually missing when the function is CALLED.
--
--   3. donovan_gap_reports + gap_report_upsert/_latest/_list — the WEEKLY GAP
--      REPORT'S own storage: one row per ISO week (upserted, so re-running
--      the same week's report replaces it rather than accumulating
--      duplicates), platform-level (no tenant_id — a cross-tenant cluster
--      summary is inherently not one tenant's data), same SECURITY-DEFINER
--      + zero-policy shape as 26's own tables.
--
--   4. list_autopilot_summary_window(from, to) — cross-tenant, read-only,
--      SECURITY DEFINER read of audit_log for action = 'donovan.autopilot_run'
--      — the per-tenant nightly summary rows api/_lib/learning/autopilot.js
--      writes via the ordinary per-tenant db.logAction (audit_log already
--      carries FORCE ROW LEVEL SECURITY on tenant_id — same table every
--      other feature in this codebase already audits into). Feeds the
--      operator-only "Learning autopilot" UI card. `changes` holds only
--      counts and a cost figure — never question text (autopilot.js's own
--      "counts only" logging discipline, same as every other file in this
--      loop).
-- ============================================================================

-- ---- 1. tenant-scoped learned vocabulary --------------------------------------
CREATE TABLE IF NOT EXISTS donovan_learned_tenant (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('abbreviation', 'synonym')),
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_donovan_learned_tenant_active ON donovan_learned_tenant (tenant_id, status, created_at ASC);

ALTER TABLE donovan_learned_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_learned_tenant FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_donovan_learned_tenant ON donovan_learned_tenant;
CREATE POLICY tenants_isolate_donovan_learned_tenant ON donovan_learned_tenant
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. cross-tenant read: scorecard failures in a window ---------------------
CREATE OR REPLACE FUNCTION list_scorecard_failures_window(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (tenant_id UUID, category TEXT, question TEXT, count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.tenant_id, r.category, LEFT(r.question, 300) AS question, COUNT(*) AS count
    FROM donovan_scorecard_results r
   WHERE r.passed = false AND r.created_at >= p_from AND r.created_at < p_to
   GROUP BY r.tenant_id, r.category, LEFT(r.question, 300)
   ORDER BY count DESC
   LIMIT 5000;
$$;

-- ---- 3. weekly gap report storage (platform-level) -----------------------------
CREATE TABLE IF NOT EXISTS donovan_gap_reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_start    DATE NOT NULL UNIQUE,
  report        JSONB NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE donovan_gap_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_gap_reports FORCE  ROW LEVEL SECURITY;
-- Deliberately no policies — same "SECURITY DEFINER functions are the only door in" shape as
-- donovan_proposals/donovan_learned (26-donovan-learning.sql's own header explains why).

CREATE OR REPLACE FUNCTION gap_report_upsert(p_week_start DATE, p_report JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO donovan_gap_reports (week_start, report, generated_at)
  VALUES (p_week_start, p_report, NOW())
  ON CONFLICT (week_start) DO UPDATE SET report = EXCLUDED.report, generated_at = NOW()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION gap_report_latest()
RETURNS SETOF donovan_gap_reports
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM donovan_gap_reports ORDER BY week_start DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION gap_report_list(p_limit INT)
RETURNS SETOF donovan_gap_reports
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM donovan_gap_reports ORDER BY week_start DESC LIMIT LEAST(COALESCE(p_limit, 12), 52);
$$;

-- ---- 4. cross-tenant read: the autopilot's own per-tenant nightly summaries ----
CREATE OR REPLACE FUNCTION list_autopilot_summary_window(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (tenant_id UUID, changes JSONB, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.tenant_id, a.changes, a.created_at
    FROM audit_log a
   WHERE a.action = 'donovan.autopilot_run' AND a.created_at >= p_from AND a.created_at < p_to
   ORDER BY a.created_at DESC
   LIMIT 500;
$$;

-- ---- 5. grants ------------------------------------------------------------------
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON donovan_learned_tenant TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_scorecard_failures_window(timestamptz,timestamptz) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION gap_report_upsert(date,jsonb) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION gap_report_latest() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION gap_report_list(int) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_autopilot_summary_window(timestamptz,timestamptz) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 6. proof ---------------------------------------------------------------------
-- Expect: two rows (donovan_gap_reports, donovan_learned_tenant), rls=t force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('donovan_learned_tenant', 'donovan_gap_reports')
 ORDER BY 1;

-- Expect: one row (donovan_learned_tenant's tenant-isolation policy; donovan_gap_reports has none).
SELECT polname FROM pg_policy
 WHERE polrelid IN ('donovan_learned_tenant'::regclass, 'donovan_gap_reports'::regclass);

-- Expect: five rows, prosecdef = true for each.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('list_scorecard_failures_window', 'gap_report_upsert', 'gap_report_latest',
                      'gap_report_list', 'list_autopilot_summary_window');
