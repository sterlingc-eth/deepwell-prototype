-- ============================================================================
-- 53-unit-address-backfill.sql — run any time; idempotent, safe to re-run.
--
-- UNIT <-> SERVICE ADDRESS (Round 16, E2, owner decision 2026-09-26) —
-- api/_lib/intake/unitAddress.js (the shared rule), api/_lib/intake/autofill.js
-- (the per-document hook, going forward), api/_lib/backfill/unitAddress.js
-- (the one-time pass over existing data), api/_lib/routes/unit-address-backfill.js
-- (wired into POST /api/account?action=unit-address).
--
-- NO NEW TABLE, NO NEW COLUMN: entities.data is already JSONB
-- (M3-config/01-create-schema.sql) and customer entities already store their
-- own 'service_address' key in it — equipment entities can hold the exact
-- same key, no schema change required. This migration adds ONLY a partial
-- index so a large tenant's backfill (paged by id, ordered by id) can find
-- "equipment entities still missing an address" without a sequential scan
-- on every batch.
--
-- Code already works before this is pasted: api/_lib/backfill/unitAddress.js's
-- own scan query still runs correctly without this index, just as a seq scan
-- until it exists — this migration only makes that scan fast at scale.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_entities_equipment_missing_address
  ON entities (tenant_id, id)
  WHERE entity_type = 'equipment' AND merged_into IS NULL AND (data ->> 'service_address') IS NULL;

-- ---- proof -------------------------------------------------------------
-- Expect: one row, this index, on `entities`.
SELECT indexname FROM pg_indexes
 WHERE tablename = 'entities' AND indexname = 'idx_entities_equipment_missing_address';
