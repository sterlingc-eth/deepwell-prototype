-- ============================================================================
-- 46-grid-view.sql — Round 13, H3 (Grid view). Idempotent; safe to re-run;
-- safe to skip (api/_lib/grid/store.js works without these — every query it
-- runs is already covered by an existing index from 01/08/22/42; this file
-- only makes the 'units' row type fast at real volume, same "index-only,
-- no new tables" shape as 42-records-browse.sql).
--
-- What each index backs, in api/_lib/grid/store.js's unitGridRows:
--   - entities:     the units page itself (entity_type='equipment', ordered
--                   by updated_at) and its q/brand filters. 42 already
--                   indexed (tenant_id, entity_type) — this adds updated_at
--                   to that so ORDER BY doesn't need a separate sort step,
--                   plus trigram search on model/serial (q filter) and an
--                   equality index on manufacturer (brand filter).
--   - extractions:  per-(entity, field) provenance lookup (DISTINCT ON ...
--                   ORDER BY created_at DESC) — idx_extractions_entity
--                   (01-create-schema.sql) covers entity_id alone; this adds
--                   field_key + created_at so that DISTINCT ON doesn't have
--                   to sort every extraction row for a busy unit.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_entities_equipment_updated_at
  ON entities (tenant_id, entity_type, updated_at DESC)
  WHERE entity_type = 'equipment' AND merged_into IS NULL;

CREATE INDEX IF NOT EXISTS idx_entities_manufacturer
  ON entities (tenant_id, (data->>'manufacturer'))
  WHERE entity_type = 'equipment';

CREATE INDEX IF NOT EXISTS idx_entities_model_serial_trgm
  ON entities USING GIN ((coalesce(data->>'model', '') || ' ' || coalesce(data->>'serial_number', '')) gin_trgm_ops)
  WHERE entity_type = 'equipment';

CREATE INDEX IF NOT EXISTS idx_extractions_entity_field_created
  ON extractions (tenant_id, entity_id, field_key, created_at DESC)
  WHERE entity_id IS NOT NULL;

-- ---- proof ---------------------------------------------------------------------
-- Expect: every index above present.
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
  'idx_entities_equipment_updated_at', 'idx_entities_manufacturer',
  'idx_entities_model_serial_trgm', 'idx_extractions_entity_field_created'
);
