-- ============================================================================
-- 41-document-display-names.sql — run AFTER 08-review.sql (reads documents.verified_by).
-- Idempotent; safe to re-run. Owner ask (round 12 contract): "Could Donovan rename records
-- something simple, clear and legible once it confirms what it is? e.g. if it's the warranty it
-- should say Warranty instead of 34534895.pdf." Never destroys the original filename — that stays
-- in documents.original_filename for audit/download; this only ADDS a title.
--
-- What this adds:
--   documents.display_name             — the short human title (api/_lib/naming/engine.js's
--                                        computeDisplayName, e.g. "Warranty · Carol Rios ·
--                                        Trane XR16 · Jun 12, 2025"), NULL until the document's
--                                        type is confirmed (see api/_lib/naming/assign.js).
--   documents.display_name_source      — 'auto' (assignDisplayName / the backfill) or 'user' (a
--                                        person renamed it, api/_lib/naming/assign.js's
--                                        renameDocument) — 'auto' is silently overwritable by a
--                                        later, better assignment; 'user' never is.
--   documents.display_name_updated_at  — when either of the above last changed; NULL until then.
--
-- NOTHING BREAKS IF THIS IS NOT PASTED — same tableExists/columnExists-probe contract as every
-- other optional column in this repo (recordsStore.js's documentsHaveUpdatedAt /
-- documentsHaveUploadedBy): api/_lib/naming/store.js's `displayNameColumnsExist` probes once per
-- warm instance and every read/write here degrades to "no display name, no-op write" instead of a
-- bare 42703. `src/core/documentName.ts`'s `documentName()` already falls back to a client-derived
-- name (and finally the original filename) when `displayName` is absent from the payload, so the
-- UI is correct in EITHER state.
--
-- RLS: no new table, so no new policy — display_name/_source/_updated_at are plain columns on
-- `documents`, which already has ENABLE + FORCE ROW LEVEL SECURITY and a tenant-isolation policy
-- from 01-create-schema.sql/02 (unchanged by ALTER TABLE ADD COLUMN).
-- ============================================================================

-- ---- 1. columns -------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS display_name_source TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS display_name_updated_at TIMESTAMPTZ;

-- Guards the only two values api/_lib/naming/store.js's writeDisplayName ever writes. Named (not
-- inline) so it can be dropped/recreated without a table rewrite if a third source is ever added.
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so this drops-then-adds, same idiom
-- 18-outreach.sql and 29-donovan-recipes.sql already use for their own CHECK constraints.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_display_name_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_display_name_source_check
  CHECK (display_name_source IS NULL OR display_name_source IN ('auto', 'user'));

-- ---- 2. indexes ---------------------------------------------------------------
-- pg_trgm already required by 03-retrieval.sql; re-declared here so this file loads standalone
-- too (a fresh DB that jumps straight to 41), same belt-and-braces re-declare 40's own file 0
-- uses for pgvector.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Records-list search/filter by title (owner ask #2: "a long list of documents ... needs easy
-- sort/filter/find" — G2's records list reads this when the column exists). Partial (WHERE NOT
-- NULL): an un-named document contributes nothing to a title search anyway, and this keeps the
-- index small on a tenant with a large backlog still awaiting the backfill.
CREATE INDEX IF NOT EXISTS idx_documents_display_name_trgm
  ON documents USING GIN (display_name gin_trgm_ops)
  WHERE display_name IS NOT NULL;

-- The backfill's own candidate scan (api/_lib/naming/store.js's listBackfillCandidates:
-- "document_type IS NOT NULL AND display_name IS NULL", oldest id first) and namingCounts'
-- eligible/remaining tallies both filter on exactly this pair — tenant-first, like every other
-- per-tenant partial index in this migration set (38's own note explains why).
CREATE INDEX IF NOT EXISTS idx_documents_tenant_unnamed
  ON documents (tenant_id, id)
  WHERE document_type IS NOT NULL AND display_name IS NULL;

-- ---- 3. grants ----------------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have SELECT/INSERT/UPDATE/DELETE on
-- every table (02, 03), and these are plain ALTER TABLE ADD COLUMN on a table they already have
-- privileges on.

-- ---- 4. proof -------------------------------------------------------------
-- Expect: three rows — display_name (text), display_name_source (text), display_name_updated_at
-- (timestamptz), all nullable.
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'documents'
   AND column_name IN ('display_name', 'display_name_source', 'display_name_updated_at');

-- Expect: one row — the CHECK constraint.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'documents'::regclass AND conname = 'documents_display_name_source_check';

-- Expect: two rows — idx_documents_display_name_trgm, idx_documents_tenant_unnamed.
SELECT indexname FROM pg_indexes WHERE tablename = 'documents' AND indexname LIKE '%display_name%' OR indexname = 'idx_documents_tenant_unnamed';

-- Expect: relforcerowsecurity = true (unchanged by this migration — documents already forces RLS).
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'documents';
