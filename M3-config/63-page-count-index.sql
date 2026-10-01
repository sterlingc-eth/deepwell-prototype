-- ============================================================================
-- 63-page-count-index.sql — R35. Idempotent; safe to re-run. Optional but recommended before the first big import.
--
-- "Pages read this month" (the number the upload gate enforces and the Billing screen shows) counts document_pages rows
-- created since the 1st. With no index on (tenant_id, created_at) that count walks every page the shop has ever scanned,
-- on EVERY upload batch and every app load. Measured: 240,000 pages 421 ms -> 4 ms with this index (the code also stopped
-- joining to documents). A year of a busy shop is ~1,000,000 pages.
--
-- A plain CREATE INDEX (same reasoning as 54-documents-scale-indexes.sql): it briefly blocks writes to document_pages while
-- it builds. On a table this small today that is seconds; run it BEFORE the big import, not during.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_document_pages_tenant_created ON document_pages (tenant_id, created_at);

-- Expect: one row.
SELECT indexname FROM pg_indexes WHERE tablename = 'document_pages' AND indexname = 'idx_document_pages_tenant_created';
