-- ============================================================================
-- 22-document-financials.sql — run AFTER 21-outreach-shop-fields.sql (any time
-- before or after 29; nothing here depends on the later files). Idempotent;
-- safe to re-run.
--
-- FINANCIALS LAYER (handoffs/FINANCIALS_2026-09-23.md, design in
-- handoffs/FINANCIALS_DESIGN_2026-09-21.md): one header row per money-kind
-- document (invoice, proposal-quote, purchase-order, maintenance-agreement)
-- plus its line items, so Donovan can total invoices in SQL instead of
-- refusing every money question.
--
-- What this adds:
--   document_financials       — header: numbers as NUMERIC(12,2) (cents exact,
--                               never text), dates as DATE, direction
--                               receivable/payable, status, arithmetic flags,
--                               per-field page + verbatim evidence for
--                               citations.
--   document_financial_lines  — line items (description / qty / unit price /
--                               amount), one row per printed line.
--
-- Corrections live BESIDE the original, never over it (same rule as
-- extractions.corrected_value in 08-review.sql): `corrections` is a JSONB map
-- {field: "123.45"} written only by the review action; the agent view and
-- every total apply COALESCE(correction, original). The extracted value stays
-- the record of what the document said.
--
-- The customer is NOT stored here: it is derived live from the document's
-- links (document_entity_links / extractions.entity_id), so a merge or a
-- manual re-link in Review moves the invoice with it.
--
-- Code is tolerant of this migration not being pasted: every reader probes
-- for the table first, so until it exists the feature is simply off and money
-- questions keep today's honest "can't total yet" answer.
-- ============================================================================

-- ---- 1. document_financials --------------------------------------------------
CREATE TABLE IF NOT EXISTS document_financials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_kind TEXT NOT NULL CHECK (doc_kind IN
    ('invoice','estimate','statement','receipt','po','change_order','pay_app','credit_memo','agreement')),
  direction TEXT NOT NULL CHECK (direction IN ('receivable','payable')),
  currency TEXT NOT NULL DEFAULT 'USD',
  invoice_number TEXT,
  po_number TEXT,
  invoice_date DATE,
  due_date DATE,
  period_start DATE,
  period_end DATE,
  agreement_term TEXT,
  subtotal NUMERIC(12,2),
  tax NUMERIC(12,2),
  total NUMERIC(12,2),
  amount_paid NUMERIC(12,2),
  balance_due NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('paid','unpaid','partial','unknown')),
  customer_name TEXT,
  vendor_name TEXT,
  confidence NUMERIC(4,3),
  flags TEXT[] NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  corrections JSONB NOT NULL DEFAULT '{}'::jsonb,
  corrected_by TEXT,
  corrected_at TIMESTAMPTZ,
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  model TEXT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_docfin_tenant_kind ON document_financials (tenant_id, doc_kind, direction);
CREATE INDEX IF NOT EXISTS idx_docfin_tenant_date ON document_financials (tenant_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_docfin_open_due ON document_financials (tenant_id, due_date) WHERE status IN ('unpaid','partial');
CREATE INDEX IF NOT EXISTS idx_docfin_review ON document_financials (tenant_id) WHERE verified_by IS NULL;

ALTER TABLE document_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_financials FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_document_financials ON document_financials;
CREATE POLICY tenants_isolate_document_financials ON document_financials
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. document_financial_lines ---------------------------------------------
CREATE TABLE IF NOT EXISTS document_financial_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  financial_id UUID NOT NULL REFERENCES document_financials(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description TEXT,
  qty NUMERIC(12,3),
  unit_price NUMERIC(12,4),
  amount NUMERIC(12,2),
  category_guess TEXT,
  page_no INT
);

CREATE INDEX IF NOT EXISTS idx_docfinlines_financial ON document_financial_lines (financial_id);
CREATE INDEX IF NOT EXISTS idx_docfinlines_document ON document_financial_lines (tenant_id, document_id);

ALTER TABLE document_financial_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_financial_lines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_document_financial_lines ON document_financial_lines;
CREATE POLICY tenants_isolate_document_financial_lines ON document_financial_lines
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 3. grants ------------------------------------------------------------------
-- 01b's ALTER DEFAULT PRIVILEGES normally covers new tables; this makes it
-- explicit and idempotent for a database where that default was never applied.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON document_financials, document_financial_lines TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 4. proof -------------------------------------------------------------------
-- Expect: two rows, rls = t and force = t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('document_financials', 'document_financial_lines') ORDER BY 1;

-- Expect: two rows — one tenant-isolation policy per table.
SELECT polrelid::regclass AS table, polname FROM pg_policy
 WHERE polrelid IN ('document_financials'::regclass, 'document_financial_lines'::regclass) ORDER BY 1;
