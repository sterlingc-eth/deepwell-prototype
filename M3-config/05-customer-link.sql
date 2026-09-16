-- ============================================================================
-- 05-customer-link.sql — run AFTER 04-cleanup.sql. Idempotent; safe to re-run.
--
-- Gives equipment a real link to a customer, so "pick a customer, see their
-- units and warranty state" is one indexed query instead of a text scan over
-- data->>'customer_name'.
--
-- entities.entity_type already allowed 'customer' (01-create-schema.sql) but
-- nothing created one and nothing pointed equipment at one — customer_name
-- has always been free text sitting inside equipment's OWN data jsonb, with no
-- link, no dedup, and no way to query "all equipment for this customer".
--
-- What this adds:
--   entities.customer_id  — equipment -> customer, nullable, ON DELETE SET NULL
--   a partial index        — the column is null on every non-equipment row and
--                            on unlinked equipment, so indexing only the rows
--                            that are actually linked keeps it small
--   a CHECK constraint      — customer_id only ever appears on an equipment row
--                            (single-row rule; a CHECK can express this)
--   a trigger               — customer_id only ever points at a customer row,
--                            and never at one in a different tenant (a cross-
--                            row lookup; a CHECK cannot express this)
--
-- ON DELETE SET NULL, not CASCADE: deleting a customer should not delete the
-- equipment they own. It becomes unlinked, visible again in an "unassigned
-- equipment" view rather than disappearing.
-- ============================================================================

-- ---- 1. the column ----------------------------------------------------------
ALTER TABLE entities ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES entities(id) ON DELETE SET NULL;

-- ---- 2. the index -------------------------------------------------------
-- Partial: most entity rows (every property, technician, customer, and
-- unlinked equipment row) have customer_id NULL, and an index over NULLs
-- helps nobody. listCustomerEquipment's WHERE customer_id = $1 is the only
-- query this index exists for.
CREATE INDEX IF NOT EXISTS idx_entities_customer_id ON entities (customer_id) WHERE customer_id IS NOT NULL;

-- ---- 3. the single-row rule: only equipment carries a customer_id ----------
-- Expressible as a CHECK because it only ever looks at the row being written,
-- never another one. Guarded by a catalog check first because Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints (unlike ADD COLUMN).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_customer_id_only_on_equipment'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_customer_id_only_on_equipment
      CHECK (customer_id IS NULL OR entity_type = 'equipment');
  END IF;
END $$;

-- ---- 4. the cross-row rule: customer_id must point at a customer, in the --
--         SAME tenant — this is what a CHECK constraint cannot do -----------
--
-- A CHECK sees only the row being written. Whether customer_id's TARGET is a
-- customer row, and which tenant that target belongs to, both require looking
-- up another row — that is what a trigger is for.
--
-- SECURITY DEFINER on purpose, matching resolve_tenant() in 02-tenancy-fix.sql:
-- this check must hold independently of RLS, not because of it. RLS (forced,
-- per 02/03) already means an ordinary query cannot SEE a row in another
-- tenant, which would make a plain-language cross-tenant link fail with "no
-- such row" long before this trigger runs. The trigger exists for the case RLS
-- does NOT cover: a role that bypasses it entirely (BYPASSRLS, or a future
-- FORCE dropped by mistake — exactly the failure 02 and 04 are about). Without
-- SECURITY DEFINER, this function would inherit that same bypass and the
-- second layer would be worth nothing.
CREATE OR REPLACE FUNCTION enforce_customer_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_type   text;
  target_tenant uuid;
BEGIN
  -- Redundant with the CHECK constraint above by design: this function must
  -- not assume a caller went through the CHECK first (a constraint could be
  -- dropped without this trigger being touched), and its own message says
  -- what's wrong instead of a constraint-violation name to decode.
  IF NEW.entity_type <> 'equipment' THEN
    RAISE EXCEPTION 'customer_id may only be set on an equipment row (got entity_type=%)', NEW.entity_type;
  END IF;

  SELECT entity_type, tenant_id INTO target_type, target_tenant
    FROM entities WHERE id = NEW.customer_id;

  IF target_type IS NULL THEN
    RAISE EXCEPTION 'customer_id % does not reference an existing entity', NEW.customer_id;
  END IF;

  IF target_type <> 'customer' THEN
    RAISE EXCEPTION 'customer_id % must reference a customer entity (found %)', NEW.customer_id, target_type;
  END IF;

  IF target_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'customer_id % belongs to a different tenant', NEW.customer_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Fires on INSERT always (an inserted row's customer_id can only be set one
-- way: as part of the row values, so "OF columns" does not apply there), and
-- on UPDATE only when the statement actually assigns to one of the three
-- columns this check depends on. That, plus the WHEN clause, means a bulk
-- UPDATE that never touches customer_id — e.g. updateEntity()'s `data`-only
-- writes, or setEquipmentWarranty's — never even calls this function: no
-- per-row cost is added to the writes this migration is not about.
--
-- BULK UPDATE: a statement that DOES set customer_id on many rows at once
-- fires this once per row, each doing one indexed lookup by primary key
-- (entities.id, the primary key). That is O(rows), not O(rows^2) or worse —
-- there is no join, no scan, nothing that gets more expensive as the table
-- grows beyond that one lookup. The application never does this today
-- (setEquipmentCustomer links one row at a time); if a future bulk-assignment
-- feature needs better than O(rows) here, that is a STATEMENT-level trigger
-- with a transition table, which is a bigger change than this migration.
--
-- DEADLOCK: this function's only read is a plain SELECT (read-committed,
-- no FOR UPDATE, no explicit LOCK), so it takes no row lock of its own on the
-- customer row it looks up — it simply reads the latest committed value.
-- Two transactions that each insert/update an equipment row pointing at the
-- SAME customer therefore never wait on each other here: neither one's
-- trigger blocks on anything the other holds. The separate FOREIGN KEY on
-- customer_id (REFERENCES entities(id), added in step 1) does take a
-- lightweight share lock on the referenced customer row, exactly as any
-- foreign key would — that is standard Postgres FK behavior, not something
-- this trigger adds, and it cannot deadlock against this trigger's own
-- lock-free SELECT.
DROP TRIGGER IF EXISTS entities_enforce_customer_link ON entities;
CREATE TRIGGER entities_enforce_customer_link
  BEFORE INSERT OR UPDATE OF customer_id, entity_type, tenant_id ON entities
  FOR EACH ROW
  WHEN (NEW.customer_id IS NOT NULL)
  EXECUTE FUNCTION enforce_customer_link();

-- ---- 5. grants ---------------------------------------------------------
-- No new grant needed: deepwell_rls / deepwell_app already have
-- SELECT/INSERT/UPDATE/DELETE on every table in the schema (02, 03), and a
-- trigger function runs under the privileges of the role invoking the
-- statement that fired it (mitigated for the RLS-independence case above by
-- SECURITY DEFINER on the function itself, not by any grant).

-- ---- 6. proof -----------------------------------------------------------
-- These describe expected results for a human running them against a real
-- database, the same way 03 and 04 do; nothing here executes automatically.

-- Expect: one row — customer_id, uuid, nullable.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'entities' AND column_name = 'customer_id';

-- Expect: one row — the partial index exists.
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename = 'entities' AND indexname = 'idx_entities_customer_id';

-- Expect: one row — the single-row CHECK is present.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'entities'::regclass AND conname = 'entities_customer_id_only_on_equipment';

-- Expect: one row, tgenabled = 'O' (fires normally) — the enforcement trigger
-- is attached.
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid = 'entities'::regclass AND tgname = 'entities_enforce_customer_link';

-- Expect: 0 rows, always. Any row here is customer_id set on a non-equipment
-- entity — the CHECK constraint should make this impossible to write from
-- here on; a row appearing would mean data written before this migration, and
-- there cannot be any, because customer_id is new in this migration.
SELECT id, entity_type FROM entities WHERE customer_id IS NOT NULL AND entity_type <> 'equipment';

-- Expect: 0 rows, always. Any row here is customer_id pointing at something
-- that is not a customer entity.
SELECT e.id, e.customer_id, c.entity_type
  FROM entities e JOIN entities c ON c.id = e.customer_id
 WHERE e.customer_id IS NOT NULL AND c.entity_type <> 'customer';

-- Expect: 0 rows, always. Any row here is a link that crosses a tenant
-- boundary — exactly what the trigger exists to prevent. Run this as the
-- owner role (or another role with BYPASSRLS); run as deepwell_rls, RLS
-- itself would hide the cross-tenant row and this query would prove nothing.
SELECT e.id AS equipment_id, e.tenant_id AS equipment_tenant,
       c.id AS customer_id,  c.tenant_id AS customer_tenant
  FROM entities e JOIN entities c ON c.id = e.customer_id
 WHERE e.customer_id IS NOT NULL AND c.tenant_id <> e.tenant_id;
