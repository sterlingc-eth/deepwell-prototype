-- ============================================================================
-- L3-remove-test-company.sql  (load test, step 3 of 3 - cleanup)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Removes the fake "Load Test Company (delete me)" and everything that belongs to it, then removes the small
-- loadtest_* helper functions L1 and L2 added. It shows a table at the end: every row count for the test company
-- should be 0.
--
-- It only ever touches rows that carry the test company's id (10ad7e57-0000-4000-8000-000000000050). Every delete
-- below is filtered by that id, so no other company's data is read or changed. It also refuses to delete anything
-- unless that company is marked as a load-test company in its own settings.
--
-- You do NOT have to run this if you used a Neon branch: deleting the branch in the Neon console throws everything away,
-- including the helper functions. Run this file when you want to repeat the test on the same branch, or if you ever
-- ran L1 somewhere you did not mean to.
-- Costs nothing. Takes under a minute at 50,000 documents.
-- ============================================================================

SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);

DO $remove$
DECLARE
  c_tenant constant uuid := '10ad7e57-0000-4000-8000-000000000050';
  v_is_test boolean;
  t text;
  v_n bigint;
BEGIN
  PERFORM set_config('app.tenant_id', c_tenant::text, false);
  SELECT coalesce((settings->>'loadtest')::boolean, false) INTO v_is_test FROM tenants WHERE id = c_tenant;

  IF v_is_test IS NULL THEN
    RAISE NOTICE 'The test company is not in this database, so there is no company data to remove.';
  ELSIF NOT v_is_test THEN
    RAISE EXCEPTION 'The company with the test id is not marked as a load-test company. Refusing to delete it. Nothing was changed.';
  ELSE
    -- children first (each filtered by the test company id)
    FOREACH t IN ARRAY ARRAY['document_financial_lines', 'document_financials', 'document_entity_links', 'extractions', 'document_pages', 'facets'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', t) USING c_tenant;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RAISE NOTICE 'removed % rows from %', v_n, t;
      END IF;
    END LOOP;

    -- any other table that has a tenant_id column (nothing else is seeded, but this makes sure nothing is left behind)
    FOR t IN
      SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
         AND c.table_name NOT IN ('documents', 'entities', 'tenants', 'document_financial_lines', 'document_financials',
                                  'document_entity_links', 'extractions', 'document_pages', 'facets')
       ORDER BY c.table_name
    LOOP
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', t) USING c_tenant;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN RAISE NOTICE 'removed % rows from %', v_n, t; END IF;
    END LOOP;

    DELETE FROM entities WHERE tenant_id = c_tenant;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'removed % rows from entities', v_n;
    DELETE FROM documents WHERE tenant_id = c_tenant;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'removed % rows from documents', v_n;
    DELETE FROM tenants WHERE id = c_tenant;
    RAISE NOTICE 'removed the test company itself';
  END IF;

  -- the helper functions from L1 and L2
  FOR t IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'loadtest\_%' LOOP
    EXECUTE 'DROP FUNCTION ' || t;
  END LOOP;
END
$remove$;

-- ---- result: everything for the test company should be 0 -------------------------------------------------------------
SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);
-- (the list of tables is fixed first, as its own step, so the counting below only ever runs against tables that have a tenant_id column)
WITH t AS MATERIALIZED (
  SELECT c.table_name::text AS table_name
    FROM information_schema.columns c
    JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
),
cnt AS MATERIALIZED (
  SELECT t.table_name,
         (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I WHERE tenant_id = %L', t.table_name, '10ad7e57-0000-4000-8000-000000000050'), false, true, '')))[1]::text::bigint AS n
    FROM t
)
SELECT r.what, r.rows_left, CASE WHEN r.rows_left = 0 THEN 'PASS (gone)' ELSE 'FAIL (still there)' END AS result
  FROM (
    SELECT 'the test company itself' AS what, (SELECT count(*) FROM tenants WHERE id = '10ad7e57-0000-4000-8000-000000000050') AS rows_left
    UNION ALL
    SELECT cnt.table_name, cnt.n FROM cnt
     WHERE cnt.table_name IN ('documents', 'document_pages', 'extractions', 'entities', 'document_entity_links', 'document_financials') OR cnt.n > 0
    UNION ALL
    SELECT 'helper functions left (loadtest_*)', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'loadtest\_%')
  ) r
 ORDER BY (r.rows_left = 0), r.what;
