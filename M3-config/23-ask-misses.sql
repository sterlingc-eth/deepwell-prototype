-- ============================================================================
-- 23-ask-misses.sql — run AFTER 21-outreach-shop-fields.sql. Idempotent; safe
-- to re-run.
--
-- Donovan training-plan Day 2 "miss loop" (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md):
-- every /api/ask outcome that is honest rather than a real answer — a
-- no-answer, a money/maintenance/"can't filter by X yet" fallback, a
-- contact-lookup that matched zero or more than one customer, or an
-- analytics plan the executor rejected and fell through to retrieval — is
-- worth a look in the weekly review, so it gets its own row here instead of
-- disappearing into Vercel logs. api/_lib/missStore.js is the only writer and
-- the only reader; it is written to TOLERATE this table not existing yet (a
-- catch + one console.warn, never a failed ask) so this migration can lag a
-- deploy without breaking anything — see that file's own doc comment.
--
-- Same RLS shape as 08-review.sql / 14-billing.sql / 16-notifications.sql:
-- ENABLE + FORCE row level security, one tenant-isolation policy with both
-- USING and WITH CHECK (this table is written by the ordinary per-request
-- app connection inside a withTenant transaction, same as notifications_sent
-- in 16 — never a cross-tenant SECURITY DEFINER function, unlike 14's
-- webhook-only billing_events).
--
-- Columns, per the training plan brief:
--   question              the dispatcher's original text, truncated to 300
--                          chars in code (missStore.js) and backstopped by
--                          the CHECK below — never PII beyond what a
--                          dispatcher already typed into the Ask box, and
--                          this table is reviewed by the tenant's own owner,
--                          never cross-tenant (see hashQuestion's doc
--                          comment in api/ask.js for why the MAIN ask log
--                          only ever stores a hash instead — this table is a
--                          deliberate, narrower exception, scoped to misses
--                          only, so the owner can actually read what was
--                          asked and add it to the question bank).
--   question_normalized   the nlNormalize.js output — what the classifier
--                          and planner actually saw, deduped on for the
--                          miss-review report and the question-bank export.
--   outcome                a short code (see missStore.js's MISS_OUTCOMES):
--                          'no-answer', 'money-fallback',
--                          'maintenance-fallback', 'unsupported-condition',
--                          'contact-lookup-zero', 'contact-lookup-ambiguous',
--                          'analytics-fallthrough'. Never a 402/429 gate hit
--                          — those are blocked before an answer is even
--                          attempted and are not misses (missStore.js never
--                          writes one for them).
--   detected_conditions    analytics.js's detectedConditions() output, as a
--                          JSON array of strings ('email','phone','brand',
--                          'county','month','money','maintenance') — empty
--                          array when not applicable (e.g. a plain no-answer).
--   plan_summary           {entity, op, groupBy, filters:[{field,op}]} for an
--                          analytics-shaped miss, NULL otherwise — filter
--                          VALUES are deliberately left out (a filter value
--                          is often a customer's own city/name; the shape
--                          alone is what the weekly review needs).
-- ============================================================================

-- ---- 1. ask_misses -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ask_misses (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question             TEXT NOT NULL CHECK (char_length(question) <= 300),
  question_normalized  TEXT,
  outcome              TEXT NOT NULL,
  detected_conditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  plan_summary         JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ask_misses_tenant_created
  ON ask_misses (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ask_misses_tenant_outcome
  ON ask_misses (tenant_id, outcome, created_at DESC);

ALTER TABLE ask_misses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_misses FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_ask_misses ON ask_misses;
CREATE POLICY tenants_isolate_ask_misses ON ask_misses
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. grants ----------------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have
-- SELECT/INSERT/UPDATE/DELETE on every table in the schema (02, 03) — same
-- note 08-review.sql's own grants section makes for its new table.

-- ---- 3. proof -----------------------------------------------------------------
-- Expect: rls=t, force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'ask_misses';

-- Expect: one row — the tenant-isolation policy is present.
SELECT polname FROM pg_policy
 WHERE polrelid = 'ask_misses'::regclass AND polname = 'tenants_isolate_ask_misses';

-- Expect: 0 rows, always — a question longer than 300 chars was ever
-- inserted (missStore.js truncates before the INSERT; this CHECK is the
-- backstop).
SELECT id FROM ask_misses WHERE char_length(question) > 300;
