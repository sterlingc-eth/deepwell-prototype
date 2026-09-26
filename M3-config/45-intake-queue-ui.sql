-- ============================================================================
-- 45-intake-queue-ui.sql — run any time (no ordering dependency; 43 must exist
-- for this column to matter, but this file itself never fails if 43 hasn't
-- run — ALTER TABLE ... IF EXISTS ... ADD COLUMN IF NOT EXISTS is a no-op
-- against a table that isn't there yet). Idempotent; safe to re-run.
--
-- THE CLEAN EXCEPTION QUEUE (Round 13, H2) — api/_lib/intake/queue.js,
-- api/_lib/routes/intake-status.js, api/_lib/routes/intake-resolve.js.
--
-- One column: intake_needs_info.snoozed_until. "Come back to this later" is
-- NOT the same state as 'resolved' (no answer was actually given — a later
-- document's own arrival must still be able to resolve it, see autofill.js's
-- reexamineSiblingNeedsInfo) and NOT the same as 'dismissed' (a person who
-- says "doesn't apply" meant that permanently, not "ask me again Tuesday").
-- A snoozed row stays status='open' — every existing reader of 'open' rows
-- (reexamineSiblingNeedsInfo, intakeStatus's openQuestions count) keeps
-- seeing it exactly as before — and only listIntakeQueue's default listing
-- hides it while snoozed_until is in the future.
--
-- Code is tolerant of this migration not being pasted: intake/autofill.js's
-- snoozeNeedsInfo catches the undefined-column error and reports
-- `snoozed: false` rather than throwing; intake/queue.js's listing simply
-- never filters anything out by snooze until the column exists (same
-- tableExists/columnExists tolerance idiom as 41/42/43).
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.intake_needs_info') IS NOT NULL THEN
    ALTER TABLE intake_needs_info ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
  END IF;
END $$;

-- Keyset pagination for listIntakeQueue (created_at, id) over the open rows a
-- tenant's Inbox actually lists — the existing idx_intake_needs_info_tenant_entity_open
-- and _tenant_status indexes are keyed for other lookups (by entity, by status alone).
CREATE INDEX IF NOT EXISTS idx_intake_needs_info_tenant_open_created
  ON intake_needs_info (tenant_id, created_at, id) WHERE status = 'open';

-- ---- proof -------------------------------------------------------------------
-- Expect: one row, snoozed_until present as timestamptz (only if 43 has run first).
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'intake_needs_info' AND column_name = 'snoozed_until';

-- Expect: one row for the new index (only if 43 has run first).
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_intake_needs_info_tenant_open_created';
