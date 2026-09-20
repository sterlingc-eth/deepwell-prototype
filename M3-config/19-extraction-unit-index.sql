-- ============================================================================
-- 19-extraction-unit-index.sql — run AFTER 18-outreach.sql. Idempotent; safe
-- to re-run.
--
-- Persists the model's per-unit tag (extractFields.js's `unit_index`, already
-- used in-memory to group a multi-unit document's fields — see
-- extractFields.js's groupFieldsByUnit) onto `extractions` itself. Until this
-- lands, unit_index existed only for the duration of one extraction request;
-- nothing wrote it to a column, so a document's stored rows could not be
-- re-grouped by unit later without re-extracting (handoffs/
-- DATA_INTEGRITY_2026-09-20.md's `createMissingUnits` falls back to grouping
-- by distinct serial_number VALUES for exactly this reason, for any row
-- written before this migration is applied).
--
-- NULL = a document-scoped field (customer_name, service_address, cost, ...)
-- or a unit-scoped field from a single-unit document. 1..25 = which unit
-- (extractFields.js's MAX_UNITS_PER_DOCUMENT caps it there) a per-unit field
-- (serial_number, model, manufacturer, equipment_type, tonnage, refrigerant,
-- installation_date, equipment_id) belongs to on a multi-unit document.
--
-- api/_lib/recordsStore.js guards every read/write of this column behind a
-- memoized information_schema probe (extractionsHaveUnitIndex, same pattern
-- as documentsHaveUpdatedAt), so a deploy that lands before this file is
-- pasted degrades to "always NULL" instead of a 42703 undefined_column error.
-- ============================================================================

ALTER TABLE extractions ADD COLUMN IF NOT EXISTS unit_index SMALLINT;

CREATE INDEX IF NOT EXISTS idx_extractions_tenant_document_unit
  ON extractions (tenant_id, document_id, unit_index);
