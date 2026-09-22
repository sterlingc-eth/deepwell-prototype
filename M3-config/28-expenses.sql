-- ============================================================================
-- 28-expenses.sql — run AFTER 26-donovan-learning.sql. Idempotent; safe to
-- re-run.
--
-- OWNERS-ONLY EXPENSE TRACKER (handoffs/EXPENSES_2026-09-22.md): DeepWell's
-- OWN business expenses (software, AI/cloud, travel, ...) — never a tenant's
-- data, never visible to a customer. Code side: api/_lib/expensesStore.js
-- (the only writer/reader) and api/_lib/routes/expenses.js (the HTTP
-- surface, gated by isPlatformOperator — see api/_lib/missDigest.js). Both
-- are tolerant of this migration not having run yet, same convention as
-- M3-config/23-ask-misses.sql / M3-config/26-donovan-learning.sql: a missing
-- function comes back as a Postgres 42883 undefined_function, which
-- api/_lib/claude.js's handleError already turns into a clean 503
-- "needs a database update" instead of a raw 500.
--
-- PLATFORM-LEVEL, not tenant-scoped: this is DeepWell's own books, not any
-- shop's — no tenant_id column, same reasoning M3-config/26's own header
-- gives for donovan_proposals/donovan_learned.
--
-- RLS: identical "deny everything except through a SECURITY DEFINER
-- function" shape as 26-donovan-learning.sql — ENABLE + FORCE ROW LEVEL
-- SECURITY, ZERO policies. The five functions below (list/insert/update/
-- delete/totals) are the only door in, and every one of them is called only
-- from api/_lib/expensesStore.js, itself called only after
-- api/_lib/routes/expenses.js's isPlatformOperator gate has already passed.
-- ============================================================================

-- ---- 1. table -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_expenses (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  occurred_on       DATE NOT NULL,
  vendor            TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  category          TEXT NOT NULL CHECK (category IN (
                      'Software & Subscriptions', 'AI & Cloud Services', 'Office Equipment',
                      'Professional Services', 'Marketing', 'Vehicle & Transportation',
                      'Travel & Meals', 'Office & Operations', 'Insurance', 'Taxes & Fees', 'Other'
                    )),
  note              TEXT,
  receipt_key       TEXT,
  receipt_filename  TEXT,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'receipt')),
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_platform_expenses_occurred_on
  ON platform_expenses (occurred_on DESC) WHERE deleted_at IS NULL;

ALTER TABLE platform_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_expenses FORCE  ROW LEVEL SECURITY;
-- Deliberately no policies — see this file's header.

-- ---- 2. read: list ----------------------------------------------------------
-- NULL from/to means "no lower/upper bound" respectively, so a caller can
-- pass either end alone (e.g. "everything up to today").

CREATE OR REPLACE FUNCTION expenses_list(p_from DATE, p_to DATE)
RETURNS SETOF platform_expenses
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM platform_expenses
   WHERE deleted_at IS NULL
     AND (p_from IS NULL OR occurred_on >= p_from)
     AND (p_to IS NULL OR occurred_on <= p_to)
   ORDER BY occurred_on DESC, created_at DESC
   LIMIT 5000;
$$;

-- ---- 3. write: insert -------------------------------------------------------

CREATE OR REPLACE FUNCTION expenses_insert(
  p_occurred_on DATE, p_vendor TEXT, p_amount_cents INTEGER, p_currency TEXT, p_category TEXT,
  p_note TEXT, p_receipt_key TEXT, p_receipt_filename TEXT, p_source TEXT, p_created_by TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO platform_expenses
    (occurred_on, vendor, amount_cents, currency, category, note, receipt_key, receipt_filename, source, created_by)
  VALUES
    (p_occurred_on, p_vendor, p_amount_cents, COALESCE(p_currency, 'USD'), p_category,
     p_note, p_receipt_key, p_receipt_filename, COALESCE(p_source, 'manual'), p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---- 4. write: update (full-row replace of the editable columns) -----------

CREATE OR REPLACE FUNCTION expenses_update(
  p_id UUID, p_occurred_on DATE, p_vendor TEXT, p_amount_cents INTEGER, p_currency TEXT,
  p_category TEXT, p_note TEXT, p_receipt_key TEXT, p_receipt_filename TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE platform_expenses
     SET occurred_on = p_occurred_on,
         vendor = p_vendor,
         amount_cents = p_amount_cents,
         currency = COALESCE(p_currency, currency),
         category = p_category,
         note = p_note,
         receipt_key = p_receipt_key,
         receipt_filename = p_receipt_filename,
         updated_at = NOW()
   WHERE id = p_id AND deleted_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ---- 5. write: delete (soft) ------------------------------------------------

CREATE OR REPLACE FUNCTION expenses_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE platform_expenses SET deleted_at = NOW(), updated_at = NOW()
   WHERE id = p_id AND deleted_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ---- 6. read: totals, grouped by category and month ------------------------

CREATE OR REPLACE FUNCTION expenses_totals(p_from DATE, p_to DATE)
RETURNS TABLE (category TEXT, month TEXT, total_cents BIGINT, expense_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT category, to_char(occurred_on, 'YYYY-MM') AS month,
         SUM(amount_cents)::BIGINT AS total_cents, COUNT(*)::BIGINT AS expense_count
    FROM platform_expenses
   WHERE deleted_at IS NULL
     AND (p_from IS NULL OR occurred_on >= p_from)
     AND (p_to IS NULL OR occurred_on <= p_to)
   GROUP BY category, to_char(occurred_on, 'YYYY-MM')
   ORDER BY month, category;
$$;

-- ---- 7. grants ----------------------------------------------------------------

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION expenses_list(date,date) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION expenses_insert(date,text,integer,text,text,text,text,text,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION expenses_update(uuid,date,text,integer,text,text,text,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION expenses_delete(uuid) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION expenses_totals(date,date) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 8. proof -----------------------------------------------------------------
-- Expect: rls=t, force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'platform_expenses';

-- Expect: 0 rows — no policy exists (the functions are the only door in).
SELECT polname FROM pg_policy WHERE polrelid = 'platform_expenses'::regclass;

-- Expect: five rows, prosecdef = true for each.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('expenses_list', 'expenses_insert', 'expenses_update', 'expenses_delete', 'expenses_totals');
