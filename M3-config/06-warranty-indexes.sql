-- 06-warranty-indexes.sql
--
-- listWarrantyAttention is the query behind the feature the whole warranty
-- effort exists for: which units need registering before their deadline, and
-- which coverage is about to lapse. It filters and sorts on two JSONB paths
-- inside entities.data, and until now nothing indexed either of them — the only
-- index on entities is (tenant_id, entity_type). Postgres could narrow to one
-- tenant's equipment and then had to open every row and extract JSON to decide.
-- Fine at a hundred units, not fine at a contractor's twenty years of installs.
--
-- Two separate partial indexes rather than one combined: the query is an OR
-- across two different expressions, and Postgres serves that with a BitmapOr of
-- two index scans. One index covering both would be used for neither.
--
-- Safe to re-run. CONCURRENTLY is deliberately NOT used so this can run inside
-- a migration transaction; both tables are small enough today that the brief
-- lock costs nothing. Revisit if that stops being true.

-- Coverage that is expiring: filtered and sorted by the expiry date.
CREATE INDEX IF NOT EXISTS idx_entities_warranty_expires
  ON entities (tenant_id, (data->'warranty'->>'expires'))
  WHERE entity_type = 'equipment';

-- Registration still owed: only rows with no registration on file can appear,
-- so that condition belongs in the index predicate rather than being re-checked
-- per row. This keeps the index to the handful of units that actually qualify.
CREATE INDEX IF NOT EXISTS idx_entities_warranty_registration_due
  ON entities (tenant_id, (data->'warranty'->>'registrationDeadline'))
  WHERE entity_type = 'equipment'
    AND (data->'warranty'->>'registrationOnFile') IS NULL;

-- Equipment is looked up by serial on every single extraction — once to find
-- the unit, and the lookup is case-insensitive, so the expression has to match.
CREATE INDEX IF NOT EXISTS idx_entities_equipment_serial
  ON entities (tenant_id, lower(data->>'serial_number'))
  WHERE entity_type = 'equipment';

ANALYZE entities;
