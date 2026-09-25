-- ============================================================================
-- 34-learning-exam-gate.sql — run AFTER 32-donovan-autopilot.sql. Idempotent;
-- safe to re-run. OPTIONAL: every code path that uses these (api/_lib/learning/
-- examGate.js, gapPromoter.js, autopilot.js, sweep.js) tolerates them being
-- absent — the exam gate still runs and still decides, it just cannot persist
-- WHY, and skips the audit row (same "warn once, degrade" convention every
-- other optional migration in this directory already uses).
--
-- Workstream A ("the learning loop doesn't make Donovan smarter"): today a
-- synonym/few_shot proposal sits 'pending' forever under the default
-- DONOVAN_AUTO_LEARN='vocab', a recipe needs seen>=2 or an operator, and
-- capability_gap is informational only. The EXAM GATE (examGate.js) is a
-- stronger promotion path: it runs the real golden exam (test-docs/scorecard/
-- exam.json) through the real /api/ask pipeline, once today and once with a
-- candidate overlaid, and only promotes a candidate that never lowers the
-- pass rate or any category's pass count. This migration is purely storage
-- for THAT decision's own paper trail:
--
--   1. donovan_proposals gets four new columns (exam_before/exam_after/
--      exam_sample/exam_run_id) recording the gate's own before/after result
--      for a proposal that went through it — written via a NEW SECURITY
--      DEFINER function (donovan_proposals carries ZERO direct-write
--      policies; see 26-donovan-learning.sql's own header for why), never a
--      direct UPDATE.
--
--   2. donovan_gap_promotions — an ordinary TENANT-scoped audit table (FORCE
--      RLS + one tenant-isolation policy, same shape as 32's own
--      donovan_learned_tenant), one row per proposal the gate actually
--      promoted, keyed to whichever tenant's own exam data validated it
--      (normally the founder/operator tenant — a cross-tenant gap cluster's
--      candidate has no single "owning" tenant of its own, so it borrows the
--      exam-runner's).
-- ============================================================================

-- ---- 1. donovan_proposals: exam-gate result columns -------------------------
ALTER TABLE donovan_proposals ADD COLUMN IF NOT EXISTS exam_before JSONB;
ALTER TABLE donovan_proposals ADD COLUMN IF NOT EXISTS exam_after  JSONB;
ALTER TABLE donovan_proposals ADD COLUMN IF NOT EXISTS exam_sample INTEGER;
ALTER TABLE donovan_proposals ADD COLUMN IF NOT EXISTS exam_run_id TEXT;

CREATE OR REPLACE FUNCTION learning_record_exam_result(
  p_id UUID, p_exam_before JSONB, p_exam_after JSONB, p_exam_sample INT, p_exam_run_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE donovan_proposals
     SET exam_before = p_exam_before, exam_after = p_exam_after, exam_sample = p_exam_sample, exam_run_id = p_exam_run_id
   WHERE id = p_id;
  RETURN FOUND;
END;
$$;

-- ---- 2. donovan_gap_promotions: tenant-scoped audit row ---------------------
CREATE TABLE IF NOT EXISTS donovan_gap_promotions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_id   UUID REFERENCES donovan_proposals(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,
  capability    TEXT,
  exam_before   JSONB NOT NULL DEFAULT '{}'::jsonb,
  exam_after    JSONB NOT NULL DEFAULT '{}'::jsonb,
  exam_sample   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_donovan_gap_promotions_tenant_created ON donovan_gap_promotions (tenant_id, created_at DESC);

ALTER TABLE donovan_gap_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_gap_promotions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_donovan_gap_promotions ON donovan_gap_promotions;
CREATE POLICY tenants_isolate_donovan_gap_promotions ON donovan_gap_promotions
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 3. grants ----------------------------------------------------------------
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_record_exam_result(uuid,jsonb,jsonb,int,text) TO %I', r);
      EXECUTE format('GRANT SELECT, INSERT ON donovan_gap_promotions TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 4. proof -----------------------------------------------------------------
-- Expect: four rows (exam_after, exam_before, exam_run_id, exam_sample).
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'donovan_proposals'
   AND column_name IN ('exam_before', 'exam_after', 'exam_sample', 'exam_run_id')
 ORDER BY 1;

-- Expect: rls=t, force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'donovan_gap_promotions';

-- Expect: one row.
SELECT polname FROM pg_policy
 WHERE polrelid = 'donovan_gap_promotions'::regclass AND polname = 'tenants_isolate_donovan_gap_promotions';

-- Expect: one row, prosecdef = true.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'learning_record_exam_result';
