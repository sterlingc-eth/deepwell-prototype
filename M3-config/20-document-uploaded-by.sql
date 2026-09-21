-- ============================================================================
-- 20-document-uploaded-by.sql — run AFTER 19-extraction-unit-index.sql.
-- Idempotent; safe to re-run.
--
-- Per-technician work (owner brief 2026-09-21, TECH_FILTER_AND_OUTREACH_COPY):
-- "if a company has multiple techs, they'd get their own login... I'd want
-- their work to be specific to them, but then they'd have an option to
-- filter out work to see other people's work also." This column is the
-- attribution half of that: which Clerk user (documents.uploaded_by, a
-- clerk_user_id string, same identifier api/_lib/auth.js's `auth.userId`
-- returns) created a document, set once at presign time
-- (api/upload-url.js -> recordsStore.js's createDocument) and never
-- overwritten later.
--
-- The "My work / Everyone" filter itself (src/core/workFilter.ts) also
-- matches on a document's extracted `technician` field against the signed-in
-- user's own name — that needs no new column, since `extractions.value` is
-- already synced to the client for every document (usePostgresSync.ts).
--
-- Code guards this column's absence with recordsStore.js's
-- documentsHaveUploadedBy() (same memoized information_schema probe as
-- documentsHaveUpdatedAt/extractionsHaveUnitIndex), so a deploy that lands
-- before this migration is pasted keeps working — createDocument just
-- writes nothing for uploaded_by until the column exists.
-- ============================================================================

ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by TEXT;

CREATE INDEX IF NOT EXISTS documents_tenant_uploaded_by_idx
  ON documents (tenant_id, uploaded_by);
