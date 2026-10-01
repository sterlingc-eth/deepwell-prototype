-- ============================================================================
-- 65-scale-donovan-and-customers.sql — R41. Idempotent; safe to re-run. Paste AFTER 64 (it also needs 05, 08 and 17 pasted).
--
-- WHAT IT DOES, IN PLAIN ENGLISH
-- A 50,000-document test shop showed two screens slower than the targets:
--   * the Customers list (about 340 ms for a page; target 200) - it added up every customer's documents and equipment
--     before showing 50 of them, and it does that again for every page;
--   * Donovan finding the pages that could answer a question (about 430 ms; target 300).
-- This file adds the database pieces that make both fast. Nothing the user sees changes: same customers in the same order with
-- the same counts, same pages found for Donovan. The app notices whether this file has been pasted and, until it is, keeps
-- running the slower queries it ran before - so pasting it is never urgent and never breaks anything.
--
-- PART A - Donovan page finder (two small functions)
--   donovan_pages_by_text(question, how_many, only_these_documents)  the best-matching pages for a question, best first
--   donovan_pages_by_like(pattern, how_many, only_these_documents)   pages containing an exact piece of text (a serial number)
-- WHY FUNCTIONS: the app connects as deepwell_rls, which is subject to row-level security. Under it Postgres will not use
-- an index for the text search (@@) or for ILIKE, because neither is "leakproof" (see the header of 64). Each function runs as
-- its OWNER (the migration role, which bypasses row-level security on Neon - same pattern as 64's records_search_candidates()
-- and 60's list_all_tenant_keys()) with an EXPLICIT tenant test on every table read, reads the shop from app.tenant_id exactly
-- as the policies do, and returns NOTHING when that is unset. They return page ids (and the rank) only: the page text, the
-- document row and the highlighted excerpt are read afterwards by the app's own query, still under row-level security.
-- EXECUTE is granted only to the application roles; search_path is pinned.
-- No new index is needed: they use document_pages_tsv_idx (03) and document_pages_trgm_idx (03), which already exist.
--
-- PART B - Customers: a small "last activity" table that the database keeps up to date by itself
--   customer_activity        one row per customer: last_activity and doc_count (the two numbers the Customers list sorts by)
--   customer_activity_dirty  a to-do list: "this customer's numbers need recomputing" - filled by the triggers below
--   customer_activity_refresh()   recomputes the customers on the to-do list for the current shop (the app calls it first)
-- HOW IT STAYS CORRECT: triggers (one per kind of change, on document_entity_links, extractions, entities and documents) do
-- nothing but add the affected customers to the to-do list - they never compute anything, so saving a document is not slowed
-- down in any way you would notice and they cannot fail a save for a data reason. The app recomputes the listed customers just
-- before it reads the list, inside the same request, using the SAME rules the Customers screen has always used (a customer's
-- documents = documents linked to the customer, linked to one of their units, or holding an extracted field of one of their
-- units; last activity = the newest of those documents' dates, a unit's extracted service date, and a unit's own last edit).
-- A customer with no row yet is picked up automatically (the refresh compares the two counts and adds the missing ones), so
-- nothing has to be backfilled and the first Customers screen after pasting does the one-time work for that shop.
-- If something ever looked wrong, SELECT customer_activity_rebuild(); (as the app role, for the current shop) marks every
-- customer of the shop for recomputing at the next list load.
--
-- NO CODE DEPENDS ON THIS FILE. Without it the app runs the queries it ran before (slower at 50,000 documents, same answers).
-- The app only uses Part B when the table, the function and ALL TEN triggers are present, so a half-pasted file is ignored.
--
-- LOCKS: CREATE TRIGGER briefly blocks writes to the table it is added to (milliseconds). Run it at a quiet moment; it does not
-- need to be run before an import. The new tables start empty. Everything below runs as one transaction: if any statement
-- fails, none of it is applied - fix the error and paste the whole file again.
-- ============================================================================

BEGIN;

-- ---- PART A: Donovan page finder -----------------------------------------------------------------------------------------

-- Best pages for a question. The question is turned into an OR query of its words (the same expression the app used inline),
-- pages are ranked with ts_rank_cd, best first. plpgsql + a per-call plan (plan_cache_mode) so the planner sees the real words
-- and picks the text-search index when the words are rare and a table scan when they are everywhere. Ties in rank are broken
-- by page id so the answer is repeatable.
CREATE OR REPLACE FUNCTION donovan_pages_by_text(p_question text, p_limit int, p_doc_ids uuid[] DEFAULT NULL)
RETURNS TABLE (id uuid, rank real)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_tsq tsquery;
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;
  v_tsq := NULLIF(array_to_string(tsvector_to_array(to_tsvector('english', p_question)), ' | '), '')::tsquery;
  IF v_tsq IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT p.id, ts_rank_cd(p.tsv, v_tsq)
      FROM document_pages p
     WHERE p.tenant_id = v_tenant AND p.tsv @@ v_tsq
       AND (p_doc_ids IS NULL OR p.document_id = ANY (p_doc_ids))
     ORDER BY 2 DESC, p.id
     LIMIT p_limit;
END
$$;

-- Pages whose text contains an exact piece of text (p_like is an ILIKE pattern such as '%T08F000525%'): the serial-number /
-- model-number pass. First matches in table order, like the query it replaces.
CREATE OR REPLACE FUNCTION donovan_pages_by_like(p_like text, p_limit int, p_doc_ids uuid[] DEFAULT NULL)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
  IF v_tenant IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT p.id FROM document_pages p
     WHERE p.tenant_id = v_tenant AND p.text ILIKE p_like
       AND (p_doc_ids IS NULL OR p.document_id = ANY (p_doc_ids))
     LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION donovan_pages_by_text(text, int, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION donovan_pages_by_like(text, int, uuid[]) FROM PUBLIC;

-- ---- PART B: Customers' last activity ------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_activity (
  customer_id   uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_activity timestamptz,
  doc_count     int NOT NULL DEFAULT 0,
  refreshed_at  timestamptz NOT NULL DEFAULT now()
);
-- The two orders the Customers list offers that need these numbers: newest activity first, most documents first (the customer
-- id is the tie-break, as in the list itself).
CREATE INDEX IF NOT EXISTS customer_activity_recent_idx ON customer_activity (tenant_id, last_activity DESC NULLS LAST, customer_id);
CREATE INDEX IF NOT EXISTS customer_activity_docs_idx   ON customer_activity (tenant_id, doc_count DESC, customer_id);

CREATE TABLE IF NOT EXISTS customer_activity_dirty (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  marked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_activity_dirty_idx ON customer_activity_dirty (tenant_id, customer_id);

-- Row-level security, the same rule as every other tenant table. ENABLE (not FORCE): the function owner that the triggers run
-- as owns these tables, so the triggers can write to them for any shop, while the application role only ever sees its own.
ALTER TABLE customer_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_customer_activity ON customer_activity;
CREATE POLICY tenants_isolate_customer_activity ON customer_activity
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

ALTER TABLE customer_activity_dirty ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_customer_activity_dirty ON customer_activity_dirty;
CREATE POLICY tenants_isolate_customer_activity_dirty ON customer_activity_dirty
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON customer_activity, customer_activity_dirty TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Add customers to the to-do list. Takes entity ids (customers or units); a unit counts for its customer. Skips a customer who
-- is already on the list. SECURITY DEFINER: the triggers run for whoever is saving, and the list is written for any shop.
CREATE OR REPLACE FUNCTION customer_activity_mark(p_entity_ids uuid[])
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO customer_activity_dirty (tenant_id, customer_id)
  SELECT s.tenant_id, s.customer_id
    FROM (
      SELECT DISTINCT e.tenant_id, CASE WHEN e.entity_type = 'customer' THEN e.id ELSE e.customer_id END AS customer_id
        FROM unnest(p_entity_ids) AS u(id)
        JOIN entities e ON e.id = u.id
       WHERE e.entity_type = 'customer' OR (e.entity_type = 'equipment' AND e.customer_id IS NOT NULL)
    ) s
   WHERE NOT EXISTS (SELECT 1 FROM customer_activity_dirty z WHERE z.tenant_id = s.tenant_id AND z.customer_id = s.customer_id)
$$;
REVOKE ALL ON FUNCTION customer_activity_mark(uuid[]) FROM PUBLIC;

-- Trigger function for document_entity_links: a link added / removed / re-pointed changes the customer's documents.
CREATE OR REPLACE FUNCTION customer_activity_trg_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM customer_activity_mark((SELECT array_agg(DISTINCT entity_id) FROM new_rows));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM customer_activity_mark((SELECT array_agg(DISTINCT entity_id) FROM old_rows));
  ELSE
    PERFORM customer_activity_mark((
      SELECT array_agg(DISTINCT x.eid) FROM (
        SELECT o.entity_id AS eid FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE (o.entity_id, o.document_id) IS DISTINCT FROM (n.entity_id, n.document_id)
        UNION
        SELECT n.entity_id FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE (o.entity_id, o.document_id) IS DISTINCT FROM (n.entity_id, n.document_id)
      ) x));
  END IF;
  RETURN NULL;
END
$$;

-- Trigger function for extractions: only a field that belongs to a unit (entity_id set) matters.
CREATE OR REPLACE FUNCTION customer_activity_trg_extractions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM customer_activity_mark((SELECT array_agg(DISTINCT entity_id) FROM new_rows WHERE entity_id IS NOT NULL));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM customer_activity_mark((SELECT array_agg(DISTINCT entity_id) FROM old_rows WHERE entity_id IS NOT NULL));
  ELSE
    PERFORM customer_activity_mark((
      SELECT array_agg(DISTINCT x.eid) FROM (
        SELECT o.entity_id AS eid FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.entity_id IS NOT NULL
           AND (o.entity_id, o.document_id, o.field_key, o.value) IS DISTINCT FROM (n.entity_id, n.document_id, n.field_key, n.value)
        UNION
        SELECT n.entity_id FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE n.entity_id IS NOT NULL
           AND (o.entity_id, o.document_id, o.field_key, o.value) IS DISTINCT FROM (n.entity_id, n.document_id, n.field_key, n.value)
      ) x));
  END IF;
  RETURN NULL;
END
$$;

-- Trigger function for entities: a new customer, a new / moved / edited unit, a deleted unit. (The customer's own name and
-- address are read live by the list, so editing them needs nothing here.) It reads the rows as they were / are in the
-- statement's transition tables, because a deleted unit no longer exists to be looked up.
CREATE OR REPLACE FUNCTION customer_activity_trg_entities() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO customer_activity_dirty (tenant_id, customer_id)
    SELECT s.tenant_id, s.customer_id FROM (
      SELECT DISTINCT r.tenant_id, CASE WHEN r.entity_type = 'customer' THEN r.id ELSE r.customer_id END AS customer_id
        FROM new_rows r
       WHERE r.entity_type = 'customer' OR (r.entity_type = 'equipment' AND r.customer_id IS NOT NULL)) s
     WHERE NOT EXISTS (SELECT 1 FROM customer_activity_dirty z WHERE z.tenant_id = s.tenant_id AND z.customer_id = s.customer_id);
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO customer_activity_dirty (tenant_id, customer_id)
    SELECT s.tenant_id, s.customer_id FROM (
      SELECT DISTINCT r.tenant_id, r.customer_id
        FROM old_rows r
       WHERE r.entity_type = 'equipment' AND r.customer_id IS NOT NULL) s
     WHERE NOT EXISTS (SELECT 1 FROM customer_activity_dirty z WHERE z.tenant_id = s.tenant_id AND z.customer_id = s.customer_id);
  ELSE
    -- only rows where something the numbers depend on changed: type, owner, last edit, merged state; both the old and the new
    -- owner of a unit are affected
    INSERT INTO customer_activity_dirty (tenant_id, customer_id)
    SELECT s.tenant_id, s.customer_id FROM (
      SELECT DISTINCT r.tenant_id, CASE WHEN r.entity_type = 'customer' THEN r.id ELSE r.customer_id END AS customer_id
        FROM (
          SELECT o.tenant_id, o.entity_type, o.id, o.customer_id FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE (o.entity_type, o.customer_id, o.updated_at, o.merged_into) IS DISTINCT FROM (n.entity_type, n.customer_id, n.updated_at, n.merged_into)
          UNION ALL
          SELECT n.tenant_id, n.entity_type, n.id, n.customer_id FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE (o.entity_type, o.customer_id, o.updated_at, o.merged_into) IS DISTINCT FROM (n.entity_type, n.customer_id, n.updated_at, n.merged_into)
        ) r
       WHERE r.entity_type = 'customer' OR (r.entity_type = 'equipment' AND r.customer_id IS NOT NULL)) s
     WHERE s.customer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM customer_activity_dirty z WHERE z.tenant_id = s.tenant_id AND z.customer_id = s.customer_id);
  END IF;
  RETURN NULL;
END
$$;

-- Trigger function for documents: only a changed created_at matters (a deleted document removes its links / extractions, whose
-- own triggers fire).
CREATE OR REPLACE FUNCTION customer_activity_trg_documents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM customer_activity_mark((
    SELECT array_agg(DISTINCT x.eid) FROM (
      SELECT l.entity_id AS eid
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        JOIN document_entity_links l ON l.document_id = n.id AND l.tenant_id = n.tenant_id
       WHERE o.created_at IS DISTINCT FROM n.created_at
      UNION
      SELECT x2.entity_id
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        JOIN extractions x2 ON x2.document_id = n.id AND x2.tenant_id = n.tenant_id AND x2.entity_id IS NOT NULL
       WHERE o.created_at IS DISTINCT FROM n.created_at
    ) x));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION customer_activity_trg_links() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_activity_trg_extractions() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_activity_trg_entities() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_activity_trg_documents() FROM PUBLIC;

-- Ten triggers (statement-level: one tiny insert per save statement, not per row).
DROP TRIGGER IF EXISTS customer_activity_links_ins ON document_entity_links;
CREATE TRIGGER customer_activity_links_ins AFTER INSERT ON document_entity_links
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_links();
DROP TRIGGER IF EXISTS customer_activity_links_upd ON document_entity_links;
CREATE TRIGGER customer_activity_links_upd AFTER UPDATE ON document_entity_links
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_links();
DROP TRIGGER IF EXISTS customer_activity_links_del ON document_entity_links;
CREATE TRIGGER customer_activity_links_del AFTER DELETE ON document_entity_links
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_links();

DROP TRIGGER IF EXISTS customer_activity_extractions_ins ON extractions;
CREATE TRIGGER customer_activity_extractions_ins AFTER INSERT ON extractions
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_extractions();
DROP TRIGGER IF EXISTS customer_activity_extractions_upd ON extractions;
CREATE TRIGGER customer_activity_extractions_upd AFTER UPDATE ON extractions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_extractions();
DROP TRIGGER IF EXISTS customer_activity_extractions_del ON extractions;
CREATE TRIGGER customer_activity_extractions_del AFTER DELETE ON extractions
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_extractions();

DROP TRIGGER IF EXISTS customer_activity_entities_ins ON entities;
CREATE TRIGGER customer_activity_entities_ins AFTER INSERT ON entities
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_entities();
DROP TRIGGER IF EXISTS customer_activity_entities_upd ON entities;
CREATE TRIGGER customer_activity_entities_upd AFTER UPDATE ON entities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_entities();
DROP TRIGGER IF EXISTS customer_activity_entities_del ON entities;
CREATE TRIGGER customer_activity_entities_del AFTER DELETE ON entities
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_entities();

DROP TRIGGER IF EXISTS customer_activity_documents_upd ON documents;
CREATE TRIGGER customer_activity_documents_upd AFTER UPDATE ON documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION customer_activity_trg_documents();

-- Recompute the customers on the current shop's to-do list (and any customer with no row yet). Runs as the CALLER (the app
-- role), so row-level security applies to everything it reads and writes: it can only ever touch the current shop. Returns how
-- many customers it recomputed (0 when nothing was waiting, which is the usual case and costs one index lookup).
-- The rules below are the Customers list's own: see the comment on listCustomersSummary in api/_lib/recordsStore.js.
CREATE OR REPLACE FUNCTION customer_activity_refresh() RETURNS int
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_n int := 0;
BEGIN
  IF v_tenant IS NULL THEN RETURN 0; END IF;
  -- A customer with no row yet (the shop's first visit after this file was pasted, or a customer created while the
  -- triggers were off) goes on the list. Two cheap index counts decide whether to look.
  IF (SELECT count(*) FROM entities WHERE tenant_id = v_tenant AND entity_type = 'customer')
     <> (SELECT count(*) FROM customer_activity WHERE tenant_id = v_tenant) THEN
    INSERT INTO customer_activity_dirty (tenant_id, customer_id)
    SELECT v_tenant, e.id FROM entities e
     WHERE e.tenant_id = v_tenant AND e.entity_type = 'customer'
       AND NOT EXISTS (SELECT 1 FROM customer_activity a WHERE a.customer_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM customer_activity_dirty z WHERE z.tenant_id = v_tenant AND z.customer_id = e.id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_activity_dirty WHERE tenant_id = v_tenant) THEN RETURN 0; END IF;

  WITH d AS (DELETE FROM customer_activity_dirty WHERE tenant_id = v_tenant RETURNING customer_id),
  c AS MATERIALIZED (
    SELECT e.id FROM entities e
     WHERE e.entity_type = 'customer' AND e.tenant_id = v_tenant AND e.id IN (SELECT customer_id FROM d)
  ),
  eq AS MATERIALIZED (
    SELECT e.id, e.customer_id, e.updated_at FROM entities e
     WHERE e.entity_type = 'equipment' AND e.tenant_id = v_tenant AND e.customer_id IN (SELECT id FROM c)
  ),
  pairs AS (
    SELECT l.document_id, c.id AS customer_id
      FROM document_entity_links l JOIN c ON c.id = l.entity_id WHERE l.tenant_id = v_tenant
    UNION
    SELECT l.document_id, eq.customer_id
      FROM document_entity_links l JOIN eq ON eq.id = l.entity_id WHERE l.tenant_id = v_tenant
    UNION
    SELECT x.document_id, eq.customer_id
      FROM extractions x JOIN eq ON eq.id = x.entity_id WHERE x.tenant_id = v_tenant
  ),
  doc_agg AS (
    SELECT p.customer_id, COUNT(*) AS doc_count, MAX(dd.created_at) AS last_doc
      FROM pairs p JOIN documents dd ON dd.id = p.document_id AND dd.tenant_id = v_tenant
     GROUP BY p.customer_id
  ),
  service_agg AS (
    SELECT eq.customer_id,
           MAX(CASE WHEN x.value ~ '^\d{4}-\d{2}-\d{2}$' THEN x.value::date END) AS last_service
      FROM extractions x JOIN eq ON eq.id = x.entity_id
     WHERE x.field_key = 'service_date' AND x.tenant_id = v_tenant
     GROUP BY eq.customer_id
  ),
  equip_agg AS (SELECT customer_id, MAX(updated_at) AS last_equip_update FROM eq GROUP BY customer_id)
  INSERT INTO customer_activity AS ca (customer_id, tenant_id, last_activity, doc_count, refreshed_at)
  SELECT c.id, v_tenant,
         GREATEST(da.last_doc, sa.last_service::timestamptz, ea.last_equip_update),
         COALESCE(da.doc_count, 0)::int, now()
    FROM c
    LEFT JOIN doc_agg da ON da.customer_id = c.id
    LEFT JOIN service_agg sa ON sa.customer_id = c.id
    LEFT JOIN equip_agg ea ON ea.customer_id = c.id
  ON CONFLICT (customer_id) DO UPDATE
     SET last_activity = EXCLUDED.last_activity, doc_count = EXCLUDED.doc_count, refreshed_at = EXCLUDED.refreshed_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- Mark every customer of the current shop for recomputing (a manual "start over" for this shop; harmless).
CREATE OR REPLACE FUNCTION customer_activity_rebuild() RETURNS int
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_n int := 0;
BEGIN
  IF v_tenant IS NULL THEN RETURN 0; END IF;
  INSERT INTO customer_activity_dirty (tenant_id, customer_id)
  SELECT v_tenant, e.id FROM entities e
   WHERE e.tenant_id = v_tenant AND e.entity_type = 'customer'
     AND NOT EXISTS (SELECT 1 FROM customer_activity_dirty z WHERE z.tenant_id = v_tenant AND z.customer_id = e.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

REVOKE ALL ON FUNCTION customer_activity_refresh() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_activity_rebuild() FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION donovan_pages_by_text(text, int, uuid[]) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION donovan_pages_by_like(text, int, uuid[]) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION customer_activity_refresh() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION customer_activity_rebuild() TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

ANALYZE customer_activity;

-- ---- proof ----------------------------------------------------------------------------------------------------------------
-- 1. Expect: 4 rows (the two Donovan functions and the two customer functions the app calls), prosecdef = true for the two
--    donovan_* rows and false for the two customer_activity_* rows.
SELECT p.proname, p.prosecdef FROM pg_proc p
 WHERE p.proname IN ('donovan_pages_by_text', 'donovan_pages_by_like', 'customer_activity_refresh', 'customer_activity_rebuild')
 ORDER BY p.proname;
-- 2. Expect: 10 rows, one per trigger.
SELECT tgrelid::regclass AS on_table, tgname FROM pg_trigger WHERE tgname LIKE 'customer_activity\_%' AND NOT tgisinternal ORDER BY 1, 2;
-- 3. Expect: the owner of the Donovan functions bypasses row-level security (rolsuper or rolbypassrls = true), or they see no rows:
--      SELECT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'donovan_pages_by_text';
-- 4. After the first Customers screen has been opened for a shop, every customer of that shop has a row (the two numbers are
--    equal). Replace the id with the shop's:
--      SELECT (SELECT count(*) FROM entities WHERE tenant_id = '<shop id>' AND entity_type = 'customer') AS customers,
--             (SELECT count(*) FROM customer_activity WHERE tenant_id = '<shop id>') AS summarised;
--    (The app's own check, scripts/verify-r41-scale-queries.mjs, proves the stored numbers equal a from-scratch computation
--    after thousands of random edits.)
