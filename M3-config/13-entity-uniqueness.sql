-- ============================================================================
-- 13-entity-uniqueness.sql — OPTIONAL belt-and-braces. Run AFTER 01-create-schema.sql.
--
-- Context (B2, 2026-09-19 adversarial audit, PROVEN against real Postgres):
-- findOrCreateEquipment (api/_lib/recordsStore.js) is a plain SELECT-then-
-- INSERT with no unique constraint behind it. Two concurrent extraction
-- transactions for the same tenant naming a brand-new serial number (an
-- install invoice split into two files, an install invoice + a same-day
-- filter-change ticket) could both see "nothing exists yet" and both insert,
-- producing two equipment rows for one physical unit with its history split
-- between them forever after.
--
-- The CODE fix for this (api/_lib/recordsStore.js, same date) is a
-- pg_advisory_xact_lock taken before the SELECT, serializing concurrent
-- creators of the same (tenant, serial) pair — that fix does not depend on
-- this index existing, and this index does not depend on that lock being
-- correct either; they are independent, redundant defenses against the same
-- race, on purpose ("belt AND braces"). This file is OPTIONAL: nothing in the
-- application code checks for this index, catches its violation, or uses
-- ON CONFLICT against it. Skipping this file changes nothing about whether
-- the app works — it only removes the second layer of defense.
--
-- RUN THIS FIRST, before applying the index below, and read its output:
--
--   SELECT tenant_id, lower(data->>'serial_number') AS serial, count(*), array_agg(id) AS entity_ids
--     FROM entities
--    WHERE entity_type = 'equipment' AND merged_into IS NULL
--      AND data->>'serial_number' IS NOT NULL AND data->>'serial_number' <> ''
--    GROUP BY tenant_id, lower(data->>'serial_number')
--   HAVING count(*) > 1
--    ORDER BY count(*) DESC;
--
-- If that returns any rows, CREATE UNIQUE INDEX below will fail outright
-- (Postgres refuses to build a unique index over data that already violates
-- it) — which is the point: it forces a human to merge those duplicates
-- (api/review.js's mergeEntities, already built for exactly this) before the
-- index can be applied, rather than the migration silently picking a winner
-- for you. Re-run the query above after merging until it returns zero rows,
-- then run the CREATE UNIQUE INDEX statement.
--
-- CONCURRENTLY: builds the index without holding a long lock on `entities` —
-- run this statement by itself, outside any transaction block (most psql/
-- migration runners already do this one statement at a time; CONCURRENTLY
-- cannot run inside BEGIN/COMMIT).
-- ============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS entities_equipment_serial_unique
  ON entities (tenant_id, lower(data->>'serial_number'))
  WHERE entity_type = 'equipment' AND merged_into IS NULL
    AND data->>'serial_number' IS NOT NULL AND data->>'serial_number' <> '';

-- ---- proof ------------------------------------------------------------
-- Expect: one row, for a unique, valid (not left invalid by a failed
-- CONCURRENTLY build) index.
SELECT indexname, indisunique, indisvalid
  FROM pg_indexes idx
  JOIN pg_class c ON c.relname = idx.indexname
  JOIN pg_index i ON i.indexrelid = c.oid
 WHERE idx.indexname = 'entities_equipment_serial_unique';
