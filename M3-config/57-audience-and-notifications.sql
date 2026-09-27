-- ============================================================================
-- 57-audience-and-notifications.sql — Round 18, part 2, owner ask (a): "some of the
-- correspondence and service tickets are specifically for the techs and have nothing to do with
-- the customer" — keep those out of customer records/answers and route them to the relevant
-- technicians' notifications instead. Idempotent; safe to re-run; safe to skip.
--
-- Code (api/_lib/audience/**) works BEFORE this file is pasted: every reader/writer probes for
-- these columns first (api/_lib/audience/store.js's documentsHaveAudience/
-- documentsHaveAssignedTech, memoized per warm instance, same "detect once, cache, fall back"
-- contract as recordsStore.js's documentsHaveUpdatedAt/documentsHaveUploadedBy) and falls back to
-- a synthetic extractions row (field_key '_audience') — a table that has existed since
-- 01-create-schema.sql and needs no migration. Once this IS pasted, every reader/writer switches
-- to the real column on its very next probe (a fresh cold start, or a test's _reset*ProbeForTests
-- helper) with no code change and no backfill required — a document classified before this
-- migration landed simply keeps its fallback-row value until it's reclassified or overridden,
-- exactly like every other "detect column, fall back" feature in this codebase already behaves
-- (see documentsHaveDisplayName's own header for the same guarantee).
-- ============================================================================

-- ---- 1. documents.audience — 'customer' (default) | 'internal' ------------------------------
-- NULLABLE, on purpose, even though every writer this round always supplies an explicit value:
-- several existing bulk-insert paths elsewhere in this codebase (test/corpus loaders, exports)
-- build a `documents` row via `jsonb_populate_recordset(NULL::documents, ...)` from JSON that
-- names nothing about audience — Postgres fills every column that JSON doesn't mention with SQL
-- NULL for that call, NOT the column's DEFAULT (defaults only apply to a plain INSERT that omits
-- the column entirely). A NOT NULL constraint here made every one of those pre-existing loaders
-- fail with "null value in column audience violates not-null constraint" the moment this migration
-- landed — a real regression, caught during this round's own verify:all run, not this round's to
-- fix in every unrelated loader. Every reader already treats a NULL exactly like 'customer'
-- (COALESCE(d.audience, 'customer') — see api/_lib/audience/sql.js's audienceFilterSql and
-- api/_lib/recordsStore.js's AUDIENCE_EXPR), so a NULL row here is simply an ordinary, unclassified
-- customer document — the same safe default the column's own DEFAULT expresses for a plain INSERT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'audience') THEN
    ALTER TABLE documents ADD COLUMN audience TEXT DEFAULT 'customer';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_audience_check CHECK (audience IS NULL OR audience IN ('customer', 'internal'));
  END IF;
END $$;

-- ---- 2. optional assignment (who an internal document is for) ------------------------------
-- assigned_member: the tenant's `users.clerk_user_id` the technician was matched to (nullable —
-- an internal document with nobody matched on the roster stays unassigned; the admin notification
-- api/_lib/audience/notify.js sends is how that gets a person's attention regardless).
-- assigned_tech_name: the plain display name, kept alongside the id so a document still shows
-- "for Kevin Pratt" even if that member later leaves the org (same "don't lose the label when the
-- id goes stale" reasoning documents.uploaded_by's own display path already relies on elsewhere).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'assigned_member') THEN
    ALTER TABLE documents ADD COLUMN assigned_member TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'assigned_tech_name') THEN
    ALTER TABLE documents ADD COLUMN assigned_tech_name TEXT;
  END IF;
END $$;

-- ---- 3. index — every audience-scoped query (records browse filter, retrieval scoping) filters
-- by (tenant_id, audience) first, same shape as 42-records-browse.sql's own tenant+dimension
-- indexes.
CREATE INDEX IF NOT EXISTS idx_documents_tenant_audience ON documents (tenant_id, audience);

-- ---- 4. hardens the pre-migration fallback's notification dedupe (api/_lib/audience/notify.js's
-- markNotifiedOnce) from best-effort to a real constraint: a genuine concurrent double-write now
-- hits a unique violation (caught and treated as "already notified") instead of silently inserting
-- twice. Safe alongside the column above regardless of migration order — this indexes
-- `extractions`, not `documents`, and works whether or not `documents.audience` exists yet.
CREATE UNIQUE INDEX IF NOT EXISTS uq_extractions_audience_notified
  ON extractions (tenant_id, document_id) WHERE field_key = '_audience_notified';

-- ---- 5. proof ---------------------------------------------------------------------------------
-- Expect: three rows — audience, assigned_member, assigned_tech_name.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'documents' AND column_name IN ('audience', 'assigned_member', 'assigned_tech_name')
 ORDER BY 1;

-- Expect: one row — the CHECK constraint exists.
SELECT conname FROM pg_constraint WHERE conname = 'documents_audience_check';

-- Expect: two rows — both indexes present.
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('idx_documents_tenant_audience', 'uq_extractions_audience_notified')
 ORDER BY 1;

-- Informational only (NOT an error condition — see the column comment above): any row here is a
-- document a bulk loader inserted without going through this round's own write path
-- (setDocumentAudience/classifyDocumentAudience); every reader treats it exactly like 'customer'.
SELECT count(*) AS documents_with_null_audience FROM documents WHERE audience IS NULL;
