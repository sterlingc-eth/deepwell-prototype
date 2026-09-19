-- 11-fix-tsv.sql — rebuild document_pages.tsv as a GENERATED column.
--
-- Symptom in production: questions containing a serial number answered fine
-- (they use ILIKE on page text) but plain-word questions returned "nothing in
-- your records" even though the words were on the page. The full-text index
-- column existed but was empty: an earlier version of 03-retrieval.sql created
-- `tsv` as a plain column, and the current 03's ADD COLUMN IF NOT EXISTS then
-- skipped it, so nothing ever populated it. Dropping and recreating it as
-- GENERATED ALWAYS makes Postgres compute it for every existing row and keep
-- it current on every write. Safe to run repeatedly.
ALTER TABLE document_pages DROP COLUMN IF EXISTS tsv;
ALTER TABLE document_pages
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED;
CREATE INDEX IF NOT EXISTS document_pages_tsv_idx ON document_pages USING GIN (tsv);
-- Expect: every page with text now has a non-empty tsv (empty_pages = 0).
SELECT count(*) AS pages, count(*) FILTER (WHERE length(text) > 0 AND tsv = ''::tsvector) AS empty_pages FROM document_pages;
