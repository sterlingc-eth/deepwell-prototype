-- ============================================================================
-- 56-donovan-promoted-tests.sql — run AFTER 48-donovan-provider-status.sql.
-- Idempotent; safe to re-run. OPTIONAL: api/_lib/learning/examPromote.js
-- tolerates this table not existing yet (warn once, empty results, never a
-- failed request) — same convention as ask_misses (23) / ask_miss_replays (29).
--
-- Round 17 (R16 D3 research item 3, "golden-set growth from production miss-
-- digest"): a resolved production miss (an ask_misses row Donovan now answers
-- correctly on replay, or one an operator manually confirms) can be "kept as
-- a test" — turned into a permanent regression-test question, so a fixed
-- mistake can never silently come back. Unlike donovan_proposals/donovan_
-- learned (26/29 — platform-level, no tenant_id, because a recipe's SQL is
-- deliberately data-literal-free), a promoted test is real production data
-- from ONE shop (its oracle SQL is scoped to that shop's own document/entity
-- ids), so it is TENANT-scoped, same RLS shape as ask_misses/ask_miss_replays:
-- ENABLE + FORCE row level security, one isolation policy, written by the
-- ordinary per-request app connection inside a withTenant transaction.
--
-- Columns:
--   question_normalized  the dedupe/lookup key (nlNormalize.js's output at
--                         promotion time) — UNIQUE per tenant so re-promoting
--                         the same miss is an upsert, never a duplicate row.
--   question              the exam question's text (redacted of email/phone
--                         the same way missDigest.js redacts everywhere else;
--                         otherwise verbatim — this tenant's own export
--                         already contains every fact the question could
--                         possibly name, so nothing here is MORE exposed than
--                         what that same tenant's own admin export carries).
--   category / shape      examPromote.js's classifyCapability/guessShape
--                         guess — informational grouping, not load-bearing.
--   cmp / oracle           the exam question's own comparison type and
--                         {sql, params, requires?} oracle object — same shape
--                         test-docs/scorecard/exam.json / generalization/*.json
--                         questions carry (api/_lib/scorecard/exam.js's
--                         validQuestions is the schema authority, not a CHECK
--                         here).
--   citation_required      whether the promoted question expects a citation.
--   oracle_kind             'structural-extraction' (re-derived from the
--                         cited extraction row — re-checkable against data,
--                         the preferred path) or 'operator-literal' (a human
--                         typed the expected value directly — the documented
--                         exception, never Donovan's own guess).
--   exam_id                 the deterministic question id this row was last
--                         exported under (promoted-<tenant-slug>-<hash>) —
--                         stored rather than recomputed at export time so a
--                         hashing-detail change in code can never silently
--                         re-mint ids for already-exported questions.
--   source_outcome           the ask_misses outcome the promotion came from
--                         (usually 'answered_now'; NULL for a pure
--                         operator-literal promotion with no matching replay).
--   active                   soft-delete flag (an operator can retire a
--                         promoted test without losing its history — no
--                         delete action ships this round, but the column
--                         costs nothing to add now).
-- ============================================================================

-- ---- 1. donovan_promoted_tests -----------------------------------------------
CREATE TABLE IF NOT EXISTS donovan_promoted_tests (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  exam_id              TEXT NOT NULL,
  question_normalized  TEXT NOT NULL CHECK (char_length(question_normalized) <= 300),
  question             TEXT NOT NULL CHECK (char_length(question) <= 300),
  category             TEXT NOT NULL,
  shape                TEXT NOT NULL,
  cmp                  TEXT NOT NULL,
  oracle               JSONB NOT NULL,
  citation_required    BOOLEAN NOT NULL DEFAULT FALSE,
  oracle_kind          TEXT NOT NULL CHECK (oracle_kind IN ('structural-extraction', 'operator-literal')),
  source_outcome       TEXT,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_donovan_promoted_tests_tenant_question
  ON donovan_promoted_tests (tenant_id, question_normalized);
CREATE INDEX IF NOT EXISTS idx_donovan_promoted_tests_tenant_active
  ON donovan_promoted_tests (tenant_id, active, created_at DESC);

ALTER TABLE donovan_promoted_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_promoted_tests FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_donovan_promoted_tests ON donovan_promoted_tests;
CREATE POLICY tenants_isolate_donovan_promoted_tests ON donovan_promoted_tests
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. grants ----------------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have
-- SELECT/INSERT/UPDATE/DELETE on every table in the schema (02, 03) — same
-- note every other table's own migration in this directory makes.

-- ---- 3. proof -----------------------------------------------------------------
-- Expect: rls=t, force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'donovan_promoted_tests';

-- Expect: one row — the tenant-isolation policy is present.
SELECT polname FROM pg_policy
 WHERE polrelid = 'donovan_promoted_tests'::regclass AND polname = 'tenants_isolate_donovan_promoted_tests';

-- Expect: 0 rows, always — two tests for the same tenant+question would
-- violate the unique index (the app upserts on conflict instead).
SELECT tenant_id, question_normalized, count(*) FROM donovan_promoted_tests
 GROUP BY tenant_id, question_normalized HAVING count(*) > 1;
