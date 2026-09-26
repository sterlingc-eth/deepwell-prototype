-- ============================================================================
-- 36-job-costing.sql — run AFTER 22-document-financials.sql (job linkage lives
-- on document_financials; nothing here depends on 23-35). Idempotent; safe to
-- re-run.
--
-- JOB COST & MARGIN (handoffs/JOB_COSTING_2026-09-26.md pattern, same shape as
-- the financials layer it extends): links each money document to the JOB it
-- belongs to — the property/service address a customer invoice was billed at,
-- or the "For job at: <address>" line a purchase order prints — so Donovan can
-- group revenue (invoices, credit memos) against cost (purchase orders,
-- payable/vendor invoices) by job and answer margin questions in SQL.
--
-- What this adds to document_financials:
--   job_key         — canonical key derived from the printed job/service
--                     address (house number + significant street words, same
--                     normalization api/_lib/scope.js already uses to resolve
--                     "the unit at <address>" questions) so an invoice and the
--                     PO for the same job always land in the same group.
--   job_key_source   — how job_key was found: 'extracted' (the financials
--                      extraction call read it off the document itself),
--                      'customer_address' (derived from the linked customer's
--                      own on-file service address — no address printed on
--                      THIS document), 'page_text' (a backfill regex read of
--                      stored page text), or NULL (not yet resolved).
--   job_confidence   — 0..1; api/_lib/financials/jobCosting.js never groups a
--                      document into a job below JOB_MATCH_CONFIDENCE (0.5) —
--                      it lists the document as unmatched instead of guessing.
--   job_raw          — the printed text job_key was derived from (address or
--                      "For job at" line), kept for citations/debugging; never
--                      shown as if it were a corrected/verified value.
--
-- CODE IS TOLERANT OF THIS MIGRATION NOT BEING PASTED: jobCosting.js's
-- jobCostingColumnsExist() probes information_schema.columns first (same
-- to_regclass-style probe store.js's financialsTableExists uses) and computes
-- job_key ON THE FLY from the customer's on-file service address or a live
-- regex read of stored page text when the columns are absent — at a lower
-- confidence, same job-cost math either way. Nothing here creates a new
-- table, so no new RLS policy is needed: document_financials already has
-- ENABLE + FORCE ROW LEVEL SECURITY and a tenant-isolation policy from
-- migration 22, and a Postgres policy is row-scoped, not column-scoped — it
-- already covers every column added here.
-- ============================================================================

-- ---- 1. columns -----------------------------------------------------------
ALTER TABLE document_financials ADD COLUMN IF NOT EXISTS job_key        TEXT;
ALTER TABLE document_financials ADD COLUMN IF NOT EXISTS job_key_source TEXT;
ALTER TABLE document_financials ADD COLUMN IF NOT EXISTS job_confidence NUMERIC(4,3);
ALTER TABLE document_financials ADD COLUMN IF NOT EXISTS job_raw        TEXT;

-- CHECK constraints have no "ADD CONSTRAINT IF NOT EXISTS" in Postgres, so this
-- guards idempotency itself (same pattern as 26-donovan-learning.sql's own
-- constraint guards).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_financials_job_key_source_check'
  ) THEN
    ALTER TABLE document_financials
      ADD CONSTRAINT document_financials_job_key_source_check
      CHECK (job_key_source IS NULL OR job_key_source IN ('extracted', 'customer_address', 'page_text'));
  END IF;
END $$;

-- ---- 2. index ---------------------------------------------------------------
-- Partial (only rows with a resolved key) — a tenant with no job-costing data
-- yet pays nothing for this index; job_costs grouping filters on tenant+key.
CREATE INDEX IF NOT EXISTS idx_docfin_job_key ON document_financials (tenant_id, job_key) WHERE job_key IS NOT NULL;

-- ---- 3. proof -----------------------------------------------------------------
-- Expect: 4 rows (job_key, job_key_source, job_confidence, job_raw).
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'document_financials'
   AND column_name IN ('job_key', 'job_key_source', 'job_confidence', 'job_raw')
 ORDER BY 1;

-- Expect: rls = t and force = t (unchanged from migration 22 — proof this
-- migration added no new table and needs no new policy).
SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'document_financials';
