-- ============================================================================
-- 30-donovan-scorecard.sql — run AFTER 29-donovan-recipes.sql. Idempotent; safe
-- to re-run.
-- OPTIONAL: every code path that uses it tolerates it being absent. Without it
-- the Donovan Scorecard still runs; it keeps its results in audit_log (a compact
-- summary per run) instead of these two tables, and the trend line only goes
-- back as far as that.
--
-- The Donovan Scorecard (api/_lib/scorecard/*): a golden exam of ~300 questions,
-- each with an independent SQL "oracle" over the shop's own tables, run through
-- the SAME answer pipeline production uses. One run = one row in
-- donovan_scorecard_runs (paged: a run is filled in a few questions per request
-- to stay inside the 60 s function limit); one row per question asked in
-- donovan_scorecard_results.
--
-- TENANT-scoped, like ask_misses / ask_miss_replays: a run only ever tests the
-- operator's OWN shop against its OWN data. Same RLS shape (ENABLE + FORCE, one
-- tenant-isolation policy with USING and WITH CHECK). Written by the ordinary
-- per-request app connection inside withTenant, so no SECURITY DEFINER function.
--
-- No question text beyond the exam's own generic wording is stored, no customer
-- contact data: `expected` / `got` hold short summaries of the answer (a number,
-- a handful of names) — the operator's own shop data, shown only to the operator.
-- ============================================================================

-- ---- 1. runs ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS donovan_scorecard_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'operator' CHECK (source IN ('operator', 'nightly', 'retry')),
  exam_version    TEXT,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'stopped')),
  stop_reason     TEXT,
  total_questions INTEGER NOT NULL DEFAULT 0,
  answered        INTEGER NOT NULL DEFAULT 0,
  passed          INTEGER NOT NULL DEFAULT 0,
  score           NUMERIC(5, 4),
  by_category     JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd        NUMERIC(8, 4) NOT NULL DEFAULT 0,
  models          JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_donovan_scorecard_runs_tenant ON donovan_scorecard_runs (tenant_id, started_at DESC);

-- ---- 2. per-question results ---------------------------------------------------
CREATE TABLE IF NOT EXISTS donovan_scorecard_results (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id       UUID NOT NULL REFERENCES donovan_scorecard_runs(id) ON DELETE CASCADE,
  question_id  TEXT NOT NULL,
  category     TEXT NOT NULL,
  comparison   TEXT NOT NULL,
  question     TEXT NOT NULL CHECK (char_length(question) <= 300),
  passed       BOOLEAN NOT NULL,
  score        NUMERIC(5, 4),
  expected     TEXT,
  got          TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  models       JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_usd     NUMERIC(8, 4) NOT NULL DEFAULT 0,
  latency_ms   INTEGER,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_donovan_scorecard_results_run ON donovan_scorecard_results (tenant_id, run_id);

-- ---- 3. row level security -------------------------------------------------------
ALTER TABLE donovan_scorecard_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_scorecard_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_donovan_scorecard_runs ON donovan_scorecard_runs;
CREATE POLICY tenants_isolate_donovan_scorecard_runs ON donovan_scorecard_runs
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

ALTER TABLE donovan_scorecard_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_scorecard_results FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_donovan_scorecard_results ON donovan_scorecard_results;
CREATE POLICY tenants_isolate_donovan_scorecard_results ON donovan_scorecard_results
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 4. grants -------------------------------------------------------------------
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON donovan_scorecard_runs TO %I', r);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON donovan_scorecard_results TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 5. proof ---------------------------------------------------------------------
-- Expect: two rows, rls=t force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('donovan_scorecard_runs', 'donovan_scorecard_results')
 ORDER BY 1;

-- Expect: two rows.
SELECT polname FROM pg_policy
 WHERE polname IN ('tenants_isolate_donovan_scorecard_runs', 'tenants_isolate_donovan_scorecard_results');
