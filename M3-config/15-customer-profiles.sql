-- ============================================================================
-- 15-customer-profiles.sql — run AFTER 08-review.sql. Idempotent; safe to re-run.
--
-- Gives every customer entity a stable, human-facing id ("C-00001", ...) so a
-- dispatcher can say "pull up C-00012" instead of hunting a uuid, and so the
-- customer profile screen has one number to search, print and cite. Nothing
-- else about `entities` changes here — phone/email/notes/billing_address live
-- in the existing `data` jsonb (see handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md
-- section A), which needs no DDL at all.
--
-- What this adds:
--   entities.customer_number  — TEXT, nullable, 'C-00001' style
--   a partial UNIQUE index    — (tenant_id, customer_number) WHERE
--                               entity_type = 'customer', so two customers in
--                               the same tenant can never collide; other
--                               entity types (and NULLs, pre-backfill) never
--                               touch this index at all
--   next_customer_number(uuid) — SECURITY DEFINER, advisory-locked per tenant
--                               so two concurrent customer creations can never
--                               both compute the same next number (same race,
--                               same fix, as findOrCreateEquipment/
--                               findOrCreateCustomer's pg_advisory_xact_lock
--                               in api/_lib/recordsStore.js)
--   a backfill                — every existing customer row gets a number,
--                               ordered oldest-first, touching only rows where
--                               customer_number IS NULL so a re-run is a no-op
--
-- No sequence object: a real Postgres SEQUENCE is global and gapless-ish
-- across concurrent transactions in a way that leaks information across
-- tenants sharing one sequence, or needs one sequence PER TENANT (unbounded
-- object growth as tenants sign up). Deriving the next number from
-- MAX(existing) instead keeps the counter entirely inside `entities`, at the
-- cost of one extra query per customer creation — a cost this product's
-- write volume (a human or an extraction creating a customer) never notices.
-- ============================================================================

-- ---- 1. the column ----------------------------------------------------------
ALTER TABLE entities ADD COLUMN IF NOT EXISTS customer_number TEXT;

-- ---- 2. the per-tenant uniqueness rule --------------------------------------
-- Partial: only customer rows carry a number at all, and Postgres unique
-- indexes already treat NULL as "no value to compare" (any number of NULLs
-- coexist), so pre-backfill rows and non-customer rows never collide here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_customer_number
  ON entities (tenant_id, customer_number)
  WHERE entity_type = 'customer';

-- ---- 3. next_customer_number(tenant) ----------------------------------------
-- SECURITY DEFINER so it can be called mid-transaction, before/independent of
-- the caller's own RLS-scoped view (matches resolve_tenant() in
-- 02-tenancy-fix.sql and enforce_customer_link() in 05-customer-link.sql) —
-- though the WHERE clause below is already fully tenant-scoped by the
-- explicit p_tenant_id argument regardless of who calls it.
--
-- pg_advisory_xact_lock, not pg_advisory_lock: transaction-scoped, releases
-- automatically on COMMIT/ROLLBACK, exactly the idiom recordsStore.js already
-- uses twice (findOrCreateEquipment, findOrCreateCustomer) for the identical
-- "two concurrent creators must not both see the same 'next' value" race.
-- Locked on tenant + a fixed suffix so this never collides with either of
-- those two lock keys (different hashtext input) or with each other.
CREATE OR REPLACE FUNCTION next_customer_number(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':custno'));

  SELECT COALESCE(MAX(substring(customer_number FROM 3)::int), 0) + 1
    INTO v_next
    FROM entities
   WHERE tenant_id = p_tenant_id
     AND entity_type = 'customer'
     AND customer_number ~ '^C-\d+$';

  RETURN 'C-' || lpad(v_next::text, 5, '0');
END;
$$;

-- ---- 4. backfill existing customers, oldest first, idempotent --------------
-- Only touches customer_number IS NULL rows, so a second run of this file
-- (or a run after some customers already have numbers from step 3 running
-- live) sees an empty `to_number` and updates nothing.
WITH existing_max AS (
  SELECT tenant_id, COALESCE(MAX(substring(customer_number FROM 3)::int), 0) AS max_n
    FROM entities
   WHERE entity_type = 'customer' AND customer_number ~ '^C-\d+$'
   GROUP BY tenant_id
),
to_number AS (
  SELECT e.id, e.tenant_id,
         ROW_NUMBER() OVER (PARTITION BY e.tenant_id ORDER BY e.created_at, e.id) AS rn
    FROM entities e
   WHERE e.entity_type = 'customer' AND e.customer_number IS NULL
)
UPDATE entities e
   SET customer_number = 'C-' || lpad((COALESCE(em.max_n, 0) + tn.rn)::text, 5, '0')
  FROM to_number tn
  LEFT JOIN existing_max em ON em.tenant_id = tn.tenant_id
 WHERE e.id = tn.id;

-- ---- 5. grants ---------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION next_customer_number(uuid) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 6. proof -----------------------------------------------------------
-- Expect: one row — customer_number, text, nullable.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'entities' AND column_name = 'customer_number';

-- Expect: one row — the partial unique index exists.
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename = 'entities' AND indexname = 'idx_entities_customer_number';

-- Expect: one row, prosecdef = true.
SELECT p.proname, p.prosecdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'next_customer_number';

-- Expect: 0 rows, always. Any row here is a customer with no number after
-- the backfill above — should be impossible once this migration has run.
SELECT id FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND customer_number IS NULL;

-- Expect: 0 rows, always. Any row here is a duplicate number within one
-- tenant — the unique index above should already make this impossible.
SELECT tenant_id, customer_number, COUNT(*) FROM entities
 WHERE entity_type = 'customer' AND customer_number IS NOT NULL
 GROUP BY tenant_id, customer_number HAVING COUNT(*) > 1;
