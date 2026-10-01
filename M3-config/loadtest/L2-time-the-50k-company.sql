-- ============================================================================
-- L2-time-the-50k-company.sql  (load test, step 2 of 3)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Times, one by one, the searches, lists and counts the app runs for a company with 50,000 documents, using the
-- fake company that L1 created. It returns ONE table: what was measured, how many milliseconds it took, the target,
-- and PASS or FAIL. Each measurement is run 3 times and the middle (median) time is shown.
--
-- PASTE THIS ON THE SAME BRANCH AS L1, AFTER L1 FINISHED. It reads data and writes nothing (it only adds a few small
-- helper functions named loadtest_*, which L3 removes). Costs nothing: no AI, no storage. Takes under a minute.
--
-- HOW TO READ THE TABLE
--   * step 0 is the overall verdict. Steps 1-9 are the setup facts (how much data is there, are migrations 63 and 64
--     pasted). The rest are the timed checks.
--   * "ms" is the median of 3 runs. These are the times INSIDE the database. In real use add roughly 20-80 ms for the trip
--     between the app and Neon.
--   * Targets: searches 300 ms, pages and counts 200 ms (filter chips 500 ms, they fill in after the page has loaded).
--   * "ran_as" says who ran the query. The app connects as a restricted role (deepwell_rls) that is subject to the
--     row-level security that keeps companies apart, which is slower than the all-powerful owner role. This file tries to
--     run as the app role; if Neon does not allow that it falls back to the owner and says so in this column. Owner
--     timings are optimistic: row-level security is skipped.
--   * If it had to switch to the app role it may run GRANT deepwell_rls TO <your role>. That only changes this branch.
--   * "64 not pasted - search will be slow" means migration 64-records-search-indexes.sql is missing on this branch.
-- ============================================================================

-- Fills the $1, $2 ... placeholders of a query with real values (this is what the database driver does for the app).
CREATE OR REPLACE FUNCTION loadtest_bind(p_sql text, p_binds text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  v_sql text := p_sql;
  i int;
  v_lit text;
BEGIN
  FOR i IN REVERSE coalesce(array_length(p_binds, 1), 0)..1 LOOP
    v_lit := CASE WHEN p_binds[i] IS NULL THEN 'NULL' ELSE replace(quote_literal(p_binds[i]), '\', '\\') END;
    v_sql := regexp_replace(v_sql, '\$' || i || '(?![0-9])', v_lit, 'g');
  END LOOP;
  RETURN v_sql;
END
$f$;

-- Runs one query to the end and returns its row count (or, when p_scalar, its first value: the count the query asked for).
CREATE OR REPLACE FUNCTION loadtest_exec(p_sql text, p_binds text[], p_scalar boolean DEFAULT false) RETURNS bigint
LANGUAGE plpgsql AS $f$
DECLARE
  v_n bigint;
BEGIN
  IF p_scalar THEN
    EXECUTE loadtest_bind(p_sql, p_binds) INTO v_n;
  ELSE
    EXECUTE loadtest_bind(p_sql, p_binds);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  RETURN coalesce(v_n, 0);
END
$f$;

-- The app's own queries (copied from api/_lib/recordsStore.js as the app sends them), each as one named step.
CREATE OR REPLACE FUNCTION loadtest_q(p_name text, p_arg text, p_fn boolean) RETURNS bigint
LANGUAGE plpgsql AS $f$
DECLARE
  v_today  text := current_date::text;
  v_plus90 text := (current_date + 90)::text;
  v_plus60 text := (current_date + 60)::text;
  v_like   text := '%' || p_arg || '%';
  v_n      bigint;
  v_total  bigint;
  v_ts     text := split_part(p_arg, '|', 1);
  v_id     text := split_part(p_arg, '|', 2);
  s_browse_first constant text := $s$
WITH noop AS (SELECT 1)
    SELECT d.id, d.original_filename,
             d.display_name,
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (COALESCE(d.audience, 'customer')) AS audience,
             df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,
             (
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END) AS stage_bucket,
             (
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END) AS warranty_bucket
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
               COALESCE(
                 MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
                 MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
               ) AS site_address,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
          FROM document_entity_links del
          JOIN entities e ON e.id = del.entity_id AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
         WHERE del.document_id = d.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
      ) linked ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
               MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
               NULL::text AS audience_fallback
          FROM (
            SELECT DISTINCT ON (field_key) field_key, value
              FROM extractions
             WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND document_id = d.id AND field_key IN ('service_date', 'technician')
             ORDER BY field_key, confidence DESC NULLS LAST, id
          ) best
      ) fields ON TRUE
      LEFT JOIN document_financials df ON df.document_id = d.id AND df.tenant_id = (current_setting('app.tenant_id', true))::uuid
     WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3
     ORDER BY d.created_at DESC, d.id DESC
     OFFSET 0 LIMIT 51
  $s$;
  s_browse_first_count constant text := $s$
SELECT count(*)::int AS n FROM documents d WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3
          AND $1::text IS NOT NULL AND $2::text IS NOT NULL
  $s$;
  s_browse_keyset constant text := $s$
WITH noop AS (SELECT 1)
    SELECT d.id, d.original_filename,
             d.display_name,
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (COALESCE(d.audience, 'customer')) AS audience,
             df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,
             (
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END) AS stage_bucket,
             (
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END) AS warranty_bucket
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
               COALESCE(
                 MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
                 MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
               ) AS site_address,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
          FROM document_entity_links del
          JOIN entities e ON e.id = del.entity_id AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
         WHERE del.document_id = d.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
      ) linked ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
               MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
               NULL::text AS audience_fallback
          FROM (
            SELECT DISTINCT ON (field_key) field_key, value
              FROM extractions
             WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND document_id = d.id AND field_key IN ('service_date', 'technician')
             ORDER BY field_key, confidence DESC NULLS LAST, id
          ) best
      ) fields ON TRUE
      LEFT JOIN document_financials df ON df.document_id = d.id AND df.tenant_id = (current_setting('app.tenant_id', true))::uuid
     WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3 AND (d.created_at, d.id) < ($4::timestamptz, $5::uuid)
     ORDER BY d.created_at DESC, d.id DESC
     OFFSET 0 LIMIT 51
  $s$;
  s_probe constant text := $s$
WITH noop AS (SELECT 1)
    SELECT d.id, d.original_filename,
             d.display_name,
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (COALESCE(d.audience, 'customer')) AS audience,
             df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,
             (
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END) AS stage_bucket,
             (
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END) AS warranty_bucket
      FROM (SELECT * FROM documents dw WHERE dw.tenant_id = (current_setting('app.tenant_id', true))::uuid  ORDER BY dw.created_at DESC, dw.id DESC LIMIT 1000) d
      LEFT JOIN LATERAL (
        SELECT MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
               COALESCE(
                 MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
                 MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
               ) AS site_address,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
          FROM document_entity_links del
          JOIN entities e ON e.id = del.entity_id AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
         WHERE del.document_id = d.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
      ) linked ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
               MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
               NULL::text AS audience_fallback
          FROM (
            SELECT DISTINCT ON (field_key) field_key, value
              FROM extractions
             WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND document_id = d.id AND field_key IN ('service_date', 'technician')
             ORDER BY field_key, confidence DESC NULLS LAST, id
          ) best
      ) fields ON TRUE
      LEFT JOIN document_financials df ON df.document_id = d.id AND df.tenant_id = (current_setting('app.tenant_id', true))::uuid
     WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3 AND (d.original_filename ILIKE $4 OR d.display_name ILIKE $5
        OR EXISTS (SELECT 1 FROM document_entity_links wl JOIN entities we ON we.id = wl.entity_id AND we.tenant_id = (current_setting('app.tenant_id', true))::uuid AND we.merged_into IS NULL
                    WHERE wl.document_id = d.id AND wl.tenant_id = (current_setting('app.tenant_id', true))::uuid
                      AND (we.data->>'customer_name' ILIKE $6 OR we.data->>'service_address' ILIKE $7 OR we.data->>'manufacturer' ILIKE $8))
        OR EXISTS (SELECT 1 FROM extractions wx WHERE wx.document_id = d.id AND wx.tenant_id = (current_setting('app.tenant_id', true))::uuid AND wx.field_key = 'technician' AND wx.value ILIKE $9)
        OR EXISTS (SELECT 1 FROM document_pages wp WHERE wp.document_id = d.id AND wp.tenant_id = (current_setting('app.tenant_id', true))::uuid AND wp.tsv @@ websearch_to_tsquery('english', $10)))
     ORDER BY d.created_at DESC, d.id DESC
     OFFSET 0 LIMIT 51
  $s$;
  s_cand_fn constant text := $s$
WITH cand AS MATERIALIZED (SELECT c.id FROM records_search_candidates($4, $5) AS c(id))
    SELECT d.id, d.original_filename,
             d.display_name,
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (COALESCE(d.audience, 'customer')) AS audience,
             df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,
             (
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END) AS stage_bucket,
             (
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END) AS warranty_bucket
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
               COALESCE(
                 MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
                 MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
               ) AS site_address,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
          FROM document_entity_links del
          JOIN entities e ON e.id = del.entity_id AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
         WHERE del.document_id = d.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
      ) linked ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
               MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
               NULL::text AS audience_fallback
          FROM (
            SELECT DISTINCT ON (field_key) field_key, value
              FROM extractions
             WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND document_id = d.id AND field_key IN ('service_date', 'technician')
             ORDER BY field_key, confidence DESC NULLS LAST, id
          ) best
      ) fields ON TRUE
      LEFT JOIN document_financials df ON df.document_id = d.id AND df.tenant_id = (current_setting('app.tenant_id', true))::uuid
     WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3 AND d.id IN (SELECT id FROM cand)
     ORDER BY d.created_at DESC, d.id DESC
     OFFSET 0 LIMIT 51
  $s$;
  s_count_fn constant text := $s$
WITH cand AS MATERIALIZED (SELECT c.id FROM records_search_candidates($4, $5) AS c(id))
       SELECT count(*)::int AS n FROM documents d WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3 AND d.id IN (SELECT id FROM cand)
          AND $1::text IS NOT NULL AND $2::text IS NOT NULL
  $s$;
  s_cand_inline constant text := $s$
WITH cand AS MATERIALIZED (SELECT x.id FROM documents x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (x.original_filename ILIKE $4 OR x.display_name ILIKE $5)
        UNION
        SELECT del.document_id AS id FROM entities e JOIN document_entity_links del ON del.entity_id = e.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
        WHERE e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
          AND (e.data->>'customer_name' ILIKE $6 OR e.data->>'service_address' ILIKE $7 OR e.data->>'manufacturer' ILIKE $8)
        UNION
        SELECT x.document_id AS id FROM extractions x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND x.field_key = 'technician' AND x.value ILIKE $9
        UNION
        SELECT x.document_id AS id FROM document_pages x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND x.tsv @@ websearch_to_tsquery('english', $10))
    SELECT d.id, d.original_filename,
             d.display_name,
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (COALESCE(d.audience, 'customer')) AS audience,
             df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,
             (
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END) AS stage_bucket,
             (
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END) AS warranty_bucket
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
               COALESCE(
                 MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
                 MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
               ) AS site_address,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
          FROM document_entity_links del
          JOIN entities e ON e.id = del.entity_id AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
         WHERE del.document_id = d.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
      ) linked ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
               MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
               NULL::text AS audience_fallback
          FROM (
            SELECT DISTINCT ON (field_key) field_key, value
              FROM extractions
             WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND document_id = d.id AND field_key IN ('service_date', 'technician')
             ORDER BY field_key, confidence DESC NULLS LAST, id
          ) best
      ) fields ON TRUE
      LEFT JOIN document_financials df ON df.document_id = d.id AND df.tenant_id = (current_setting('app.tenant_id', true))::uuid
     WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3 AND d.id IN (SELECT id FROM cand)
     ORDER BY d.created_at DESC, d.id DESC
     OFFSET 0 LIMIT 51
  $s$;
  s_count_inline constant text := $s$
WITH cand AS MATERIALIZED (SELECT x.id FROM documents x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (x.original_filename ILIKE $4 OR x.display_name ILIKE $5)
        UNION
        SELECT del.document_id AS id FROM entities e JOIN document_entity_links del ON del.entity_id = e.id AND del.tenant_id = (current_setting('app.tenant_id', true))::uuid
        WHERE e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
          AND (e.data->>'customer_name' ILIKE $6 OR e.data->>'service_address' ILIKE $7 OR e.data->>'manufacturer' ILIKE $8)
        UNION
        SELECT x.document_id AS id FROM extractions x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND x.field_key = 'technician' AND x.value ILIKE $9
        UNION
        SELECT x.document_id AS id FROM document_pages x WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid AND x.tsv @@ websearch_to_tsquery('english', $10))
       SELECT count(*)::int AS n FROM documents d WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND (COALESCE(d.audience, 'customer')) = $3 AND d.id IN (SELECT id FROM cand)
          AND $1::text IS NOT NULL AND $2::text IS NOT NULL
  $s$;
  s_facets constant text := $s$
WITH
    linked AS (
      SELECT del.document_id,
             MAX(CASE WHEN e.entity_type = 'customer' THEN e.id::text END) AS customer_id,
             MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'customer_name' END) AS customer_name,
             COALESCE(
               MAX(CASE WHEN e.entity_type = 'customer' THEN e.data->>'service_address' END),
               MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'service_address' END)
             ) AS site_address,
             MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->>'manufacturer' END) AS brand,
             MAX(CASE WHEN e.entity_type = 'equipment' THEN e.data->'warranty'->>'expires' END) AS warranty_expiry
        FROM document_entity_links del
        JOIN entities e ON e.id = del.entity_id AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid AND e.merged_into IS NULL
       WHERE del.tenant_id = (current_setting('app.tenant_id', true))::uuid
       GROUP BY del.document_id
    ),
    fields AS (
      SELECT document_id,
             MAX(value) FILTER (WHERE field_key = 'service_date') AS service_date,
             MAX(value) FILTER (WHERE field_key = 'technician') AS technician_name,
             NULL::text AS audience_fallback
        FROM (
          SELECT DISTINCT ON (document_id, field_key) document_id, field_key, value
            FROM extractions
           WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND field_key IN ('service_date', 'technician')
           ORDER BY document_id, field_key, confidence DESC NULLS LAST, id
        ) best
       GROUP BY document_id
    ),
    base AS MATERIALIZED (
      SELECT d.id, d.original_filename,
             d.display_name,
             d.document_type, d.stage, d.created_at, d.created_at::text AS created_at_raw, d.verified_by, d.uploaded_by,
             linked.customer_id, linked.customer_name, linked.site_address, linked.brand, linked.warranty_expiry,
             fields.service_date, fields.technician_name,
             (COALESCE(d.audience, 'customer')) AS audience,
             df.total AS amount, df.balance_due, df.status AS money_status, (df.id IS NOT NULL) AS has_money,
             (
  CASE
    WHEN d.stage = 'verified' THEN 'verified'
    WHEN d.stage = 'received' OR d.document_type IS NULL THEN 'missing-info'
    ELSE 'needs-review'
  END) AS stage_bucket,
             (
  CASE
    WHEN linked.warranty_expiry IS NULL THEN 'unknown'
    WHEN linked.warranty_expiry < $1 THEN 'expired'
    WHEN linked.warranty_expiry <= $2 THEN 'expiring'
    ELSE 'active'
  END) AS warranty_bucket, ((COALESCE(d.audience, 'customer')) = $3) AS ok_0
        FROM documents d
        LEFT JOIN linked ON linked.document_id = d.id
        LEFT JOIN fields ON fields.document_id = d.id
        LEFT JOIN document_financials df ON df.document_id = d.id AND df.tenant_id = (current_setting('app.tenant_id', true))::uuid
       WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid AND TRUE
    )
    (SELECT 'documentType'::text AS dim, document_type::text AS value, document_type::text AS label, count(*)::int AS n FROM base
       WHERE ok_0 AND document_type IS NOT NULL GROUP BY document_type, document_type ORDER BY n DESC, label ASC LIMIT 30)
    UNION ALL
    (SELECT 'stageBucket'::text AS dim, stage_bucket::text AS value, stage_bucket::text AS label, count(*)::int AS n FROM base
       WHERE ok_0 AND TRUE GROUP BY stage_bucket, stage_bucket ORDER BY n DESC, label ASC LIMIT 10)
    UNION ALL
    (SELECT 'warrantyBucket'::text AS dim, warranty_bucket::text AS value, warranty_bucket::text AS label, count(*)::int AS n FROM base
       WHERE ok_0 AND TRUE GROUP BY warranty_bucket, warranty_bucket ORDER BY n DESC, label ASC LIMIT 10)
    UNION ALL
    (SELECT 'audience'::text AS dim, audience::text AS value, audience::text AS label, count(*)::int AS n FROM base
       WHERE TRUE AND TRUE GROUP BY audience, audience ORDER BY n DESC, label ASC LIMIT 2)
    UNION ALL
    (SELECT 'site'::text AS dim, site_address::text AS value, site_address::text AS label, count(*)::int AS n FROM base
       WHERE ok_0 AND site_address IS NOT NULL GROUP BY site_address, site_address ORDER BY n DESC, label ASC LIMIT 20)
    UNION ALL
    (SELECT 'technician'::text AS dim, technician_name::text AS value, technician_name::text AS label, count(*)::int AS n FROM base
       WHERE ok_0 AND technician_name IS NOT NULL GROUP BY technician_name, technician_name ORDER BY n DESC, label ASC LIMIT 20)
    UNION ALL
    (SELECT 'brand'::text AS dim, brand::text AS value, brand::text AS label, count(*)::int AS n FROM base
       WHERE ok_0 AND brand IS NOT NULL GROUP BY brand, brand ORDER BY n DESC, label ASC LIMIT 20)
    UNION ALL
    (SELECT 'customerId'::text, customer_id::text, customer_name::text, count(*)::int AS n FROM base
       WHERE ok_0 AND customer_id IS NOT NULL GROUP BY customer_id, customer_name ORDER BY n DESC, customer_name ASC LIMIT 20)
    UNION ALL
    (SELECT 'hasMoney'::text, NULL::text, NULL::text, count(*) FILTER (WHERE has_money)::int FROM base WHERE ok_0)
    UNION ALL
    (SELECT 'openBalance'::text, NULL::text, NULL::text, count(*) FILTER (WHERE (COALESCE(balance_due, 0) > 0))::int FROM base WHERE ok_0)
  $s$;
  s_review constant text := $s$
SELECT count(*)::int AS total,
                count(*) FILTER (WHERE stage = 'received')::int AS received,
                count(*) FILTER (WHERE stage = 'read')::int AS read,
                count(*) FILTER (WHERE stage = 'mapped')::int AS mapped,
                count(*) FILTER (WHERE stage = 'linked')::int AS linked,
                count(*) FILTER (WHERE stage = 'verified')::int AS verified
           FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
  $s$;
  s_unv_first constant text := $s$
SELECT *, created_at::text AS _created_at_raw FROM documents
          WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND stage <> 'verified'
          ORDER BY created_at DESC, id DESC LIMIT 201
  $s$;
  s_unv_count constant text := $s$
SELECT count(*)::int AS n FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND stage <> 'verified'
  $s$;
  s_unv_keyset constant text := $s$
SELECT *, created_at::text AS _created_at_raw FROM documents
          WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND stage <> 'verified' AND (created_at, id) < ($1::timestamptz, $2::uuid)
          ORDER BY created_at DESC, id DESC LIMIT 201
  $s$;
  s_count_docs constant text := $s$
SELECT count(*)::int AS n FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
  $s$;
  s_pages_month constant text := $s$
SELECT count(*)::int AS n FROM document_pages dp
          WHERE dp.tenant_id = (current_setting('app.tenant_id', true))::uuid
            AND dp.created_at >= GREATEST($1::timestamptz, date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  $s$;
  s_pending constant text := $s$
SELECT COALESCE(SUM(CASE
                  WHEN d.content_type ILIKE 'image/%' THEN 1
                  WHEN d.content_type ILIKE 'application/pdf' THEN GREATEST(1, LEAST(200, CEIL(COALESCE(d.file_size_bytes, 0) / 204800.0)))
                  ELSE GREATEST(1, LEAST(200, CEIL(COALESCE(d.file_size_bytes, 0) / 6000.0)))
                END), 0)::int AS n
           FROM documents d
          WHERE d.tenant_id = (current_setting('app.tenant_id', true))::uuid
            AND d.stage = 'received' AND d.extract_error IS NULL
            AND d.created_at >= NOW() - INTERVAL '24 hours'
            AND NOT EXISTS (SELECT 1 FROM document_pages dp WHERE dp.document_id = d.id)
  $s$;
  s_cust_page constant text := $s$
WITH c AS (
           SELECT id, customer_number, data, updated_at
             FROM entities
            WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid
              AND ($1::text IS NULL OR data->>'customer_name' ILIKE $1
                                    OR data->>'service_address' ILIKE $1
                                    OR customer_number ILIKE $1)
         ),
         equip AS (
           SELECT id, customer_id, data->'warranty' AS warranty, updated_at
             FROM entities WHERE entity_type = 'equipment' AND customer_id IS NOT NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid
         ),
         doc_union AS (
           SELECT l.document_id, c.id AS customer_id
             FROM document_entity_links l JOIN c ON c.id = l.entity_id
            WHERE l.tenant_id = (current_setting('app.tenant_id', true))::uuid
           UNION
           SELECT l.document_id, eq.customer_id
             FROM document_entity_links l JOIN equip eq ON eq.id = l.entity_id
            WHERE l.tenant_id = (current_setting('app.tenant_id', true))::uuid
           UNION
           SELECT x.document_id, eq.customer_id
             FROM extractions x JOIN equip eq ON eq.id = x.entity_id
            WHERE x.tenant_id = (current_setting('app.tenant_id', true))::uuid
         ),
         doc_agg AS (
           SELECT du.customer_id, COUNT(DISTINCT du.document_id) AS doc_count, MAX(d.created_at) AS last_doc
             FROM doc_union du JOIN documents d ON d.id = du.document_id
            GROUP BY du.customer_id
         ),
         service_agg AS (
           SELECT eq.customer_id, MAX(x.value::date) AS last_service
             FROM extractions x JOIN equip eq ON eq.id = x.entity_id
            WHERE x.field_key = 'service_date' AND x.value ~ '^\d{4}-\d{2}-\d{2}$'
              AND x.tenant_id = (current_setting('app.tenant_id', true))::uuid
            GROUP BY eq.customer_id
         ),
         equip_agg AS (
           SELECT customer_id, COUNT(*) AS n, MAX(updated_at) AS last_equip_update FROM equip GROUP BY customer_id
         ),
         -- R35: this used to be a correlated subquery in the SELECT list ("SELECT jsonb_agg(...) FROM equip eq WHERE
         -- eq.customer_id = c.id"), which scans EVERY unit once per customer row the sort has to look at: customers x
         -- units. At 10,000 customers x 20,000 units the last page of the Customers list took ~19 s (page one ~0.6 s
         -- only because LIMIT stopped it early). One grouped pass, joined, is the same answer in a single scan.
         warranty_agg AS (
           SELECT customer_id, jsonb_agg(jsonb_build_object('id', id) || warranty) AS warranties
             FROM equip WHERE warranty IS NOT NULL GROUP BY customer_id
         )
         SELECT c.id, c.customer_number, c.data,
                COALESCE(da.doc_count, 0)::int AS doc_count,
                COALESCE(ea.n, 0)::int         AS equipment_count,
                GREATEST(da.last_doc, sa.last_service::timestamptz, ea.last_equip_update) AS last_activity,
                -- 'id' merged onto each warranty object (owner defect report 2026-09-22, item 2a) so a dismissal can be
                -- keyed per unit, not just per tier — see routes/customers.js's tallyWarrantyAlerts/dismissedAlertKey.
                COALESCE(wa.warranties, '[]'::jsonb) AS warranties
           FROM c
           LEFT JOIN warranty_agg wa ON wa.customer_id = c.id
           LEFT JOIN doc_agg da ON da.customer_id = c.id
           LEFT JOIN service_agg sa ON sa.customer_id = c.id
           LEFT JOIN equip_agg ea ON ea.customer_id = c.id
          ORDER BY last_activity DESC NULLS LAST, c.id
          LIMIT $2 OFFSET $3
  $s$;
  s_cust_count constant text := $s$
SELECT COUNT(*)::int AS n FROM entities
          WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid
            AND ($1::text IS NULL OR data->>'customer_name' ILIKE $1
                                  OR data->>'service_address' ILIKE $1
                                  OR customer_number ILIKE $1)
  $s$;
  s_warranty constant text := $s$
SELECT e.id,
              e.data->'warranty'            AS warranty,
              e.data->>'serial_number'      AS serial_number,
              e.data->>'model'              AS model,
              e.data->>'manufacturer'       AS manufacturer,
              e.data->>'service_address'    AS service_address,
              e.data->>'customer_name'      AS customer_name,
              e.data->'warranty'->>'registrationDeadline' AS registration_deadline,
              e.data->'warranty'->>'expires'              AS expires
         FROM entities e
        WHERE e.entity_type = 'equipment' AND e.tenant_id = (current_setting('app.tenant_id', true))::uuid
          AND (
                (    e.data->'warranty'->>'registrationOnFile' IS NULL
                 AND e.data->'warranty'->>'registrationDeadline' BETWEEN $1 AND $2 )
             OR (    e.data->'warranty'->>'expires' BETWEEN $3 AND $4 )
          )
        ORDER BY COALESCE(
                   e.data->'warranty'->>'registrationDeadline',
                   e.data->'warranty'->>'expires'
                 )
        LIMIT $5
  $s$;
  s_passages_fts constant text := $s$
WITH q AS (
          SELECT NULLIF(array_to_string(
                   tsvector_to_array(to_tsvector('english', $1)), ' | '
                 ), '')::tsquery AS tsq
        )
        SELECT p.id, p.document_id, p.page_no,
               d.original_filename, d.document_type, d.stage,
               ts_headline('english', p.text, q.tsq,
                 'MaxFragments=2, MaxWords=55, MinWords=20, FragmentDelimiter=" … ", StartSel="", StopSel=""') AS excerpt,
               ts_rank_cd(p.tsv, q.tsq) AS rank
          FROM document_pages p
          JOIN documents d ON d.id = p.document_id
          CROSS JOIN q
         WHERE p.tenant_id = (current_setting('app.tenant_id', true))::uuid AND q.tsq IS NOT NULL AND p.tsv @@ q.tsq
         ORDER BY rank DESC
         LIMIT $2
  $s$;
  s_passages_ident constant text := $s$
SELECT p.id, p.document_id, p.page_no,
                  d.original_filename, d.document_type, d.stage,
                  substring(p.text from greatest(1, position($2 in p.text) - 120) for 320) AS excerpt,
                  1.0 AS rank
             FROM document_pages p
             JOIN documents d ON d.id = p.document_id
            WHERE p.tenant_id = (current_setting('app.tenant_id', true))::uuid AND p.text ILIKE $1
            LIMIT 5
  $s$;
BEGIN
  CASE p_name
    -- Records list, newest first: the first page (50 rows) and the count the app shows next to it
    WHEN 'browse_first' THEN
      v_n := loadtest_exec(s_browse_first, ARRAY[v_today, v_plus90, 'customer']);
      PERFORM loadtest_exec(s_browse_first_count, ARRAY[v_today, v_plus90, 'customer'], true);
      RETURN v_n;
    -- "Load more": the next page, continuing from where the last one ended (p_arg = 'created_at|id' of the last row shown)
    WHEN 'browse_keyset' THEN
      RETURN loadtest_exec(s_browse_keyset, ARRAY[v_today, v_plus90, 'customer', v_ts, v_id]);
    -- Records search box: first try the newest 1,000 documents (a common word fills the page there and that is the answer);
    -- if the page did not fill, use the indexed candidate set, then count the matches if there are more than one page.
    WHEN 'search' THEN
      v_n := loadtest_exec(s_probe, ARRAY[v_today, v_plus90, 'customer', v_like, v_like, v_like, v_like, v_like, v_like, p_arg]);
      IF v_n > 50 THEN
        IF p_fn THEN v_total := loadtest_exec(s_count_fn, ARRAY[v_today, v_plus90, 'customer', v_like, p_arg], true);
        ELSE v_total := loadtest_exec(s_count_inline, ARRAY[v_today, v_plus90, 'customer', v_like, v_like, v_like, v_like, v_like, v_like, p_arg], true); END IF;
        RETURN v_total;
      END IF;
      IF p_fn THEN v_n := loadtest_exec(s_cand_fn, ARRAY[v_today, v_plus90, 'customer', v_like, p_arg]);
      ELSE v_n := loadtest_exec(s_cand_inline, ARRAY[v_today, v_plus90, 'customer', v_like, v_like, v_like, v_like, v_like, v_like, p_arg]); END IF;
      IF v_n > 50 THEN
        IF p_fn THEN v_total := loadtest_exec(s_count_fn, ARRAY[v_today, v_plus90, 'customer', v_like, p_arg], true);
        ELSE v_total := loadtest_exec(s_count_inline, ARRAY[v_today, v_plus90, 'customer', v_like, v_like, v_like, v_like, v_like, v_like, p_arg], true); END IF;
        RETURN v_total;
      END IF;
      RETURN v_n;
    WHEN 'facets' THEN RETURN loadtest_exec(s_facets, ARRAY[v_today, v_plus90, 'customer']);
    WHEN 'review' THEN RETURN loadtest_exec(s_review, ARRAY[]::text[], true);
    WHEN 'unv_first' THEN
      v_n := loadtest_exec(s_unv_first, ARRAY[]::text[]);
      PERFORM loadtest_exec(s_unv_count, ARRAY[]::text[], true);
      RETURN v_n;
    WHEN 'unv_keyset' THEN RETURN loadtest_exec(s_unv_keyset, ARRAY[v_ts, v_id]);
    WHEN 'count_docs' THEN RETURN loadtest_exec(s_count_docs, ARRAY[]::text[], true);
    WHEN 'pages_month' THEN RETURN loadtest_exec(s_pages_month, ARRAY[(now() - interval '30 days')::text], true);
    WHEN 'pending' THEN RETURN loadtest_exec(s_pending, ARRAY[]::text[], true);
    -- Customers tab (p_arg = the offset into the list; 'recent' is the default order)
    WHEN 'cust_page' THEN RETURN loadtest_exec(s_cust_page, ARRAY[NULL, '50', p_arg]);
    WHEN 'cust_search' THEN RETURN loadtest_exec(s_cust_page, ARRAY[v_like, '50', '0']);
    WHEN 'cust_count' THEN RETURN loadtest_exec(s_cust_count, ARRAY[NULL], true);
    WHEN 'warranty' THEN RETURN loadtest_exec(s_warranty, ARRAY[v_today, v_plus60, v_today, v_plus90, '200']);
    -- Donovan ("Ask"): finding the pages that could answer a question. A serial number also triggers the exact-text pass.
    WHEN 'passages' THEN
      v_n := loadtest_exec(s_passages_fts, ARRAY[p_arg, '12']);
      IF p_arg ~ '[A-Za-z0-9][A-Za-z0-9/-]{3,}' AND p_arg ~ '[0-9]' THEN
        v_n := v_n + loadtest_exec(s_passages_ident, ARRAY['%' || substring(p_arg from '[A-Z][0-9]{2}[A-Z][0-9]{6}') || '%', substring(p_arg from '[A-Z][0-9]{2}[A-Z][0-9]{6}')]);
      END IF;
      RETURN v_n;
    ELSE RAISE EXCEPTION 'unknown step %', p_name;
  END CASE;
END
$f$;

-- The measuring run. Returns the result table.
CREATE OR REPLACE FUNCTION loadtest_run()
RETURNS TABLE (step int, check_name text, ms numeric, target_ms int, result text, ran_as text, result_size bigint, note text)
LANGUAGE plpgsql AS $f$
DECLARE
  c_tenant constant uuid := '10ad7e57-0000-4000-8000-000000000050';
  v_docs bigint; v_pages bigint; v_fields bigint; v_cust bigint; v_units bigint; v_links bigint; v_money bigint;
  v_serial text; v_custname text; v_deep_at bigint;
  v_ts1 text; v_id1 text; v_ts2 text; v_id2 text; v_ts3 text; v_id3 text;
  v_fn_installed boolean; v_fn boolean; v_idx64 int; v_idx63 int;
  v_ran text := 'owner'; v_role_note text := NULL;
  v_orig_user text := current_user;
  rec record;
  times numeric[]; t0 timestamptz; i int; v_size bigint; v_med numeric;
  v_pass int := 0; v_fail int := 0;
  v_pgq text := 'Donovan passage search: ';
BEGIN
  PERFORM set_config('app.tenant_id', c_tenant::text, true);
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = c_tenant) THEN
    RAISE EXCEPTION 'The test company is not in this database. Paste L1-seed-50k-test-company.sql first (on this same branch).';
  END IF;

  -- what is there, and a real example of each kind of search term (looked up now so every search finds something)
  SELECT count(*) INTO v_docs FROM documents WHERE tenant_id = c_tenant;
  SELECT count(*) INTO v_pages FROM document_pages WHERE tenant_id = c_tenant;
  SELECT count(*) INTO v_fields FROM extractions WHERE tenant_id = c_tenant;
  SELECT count(*) INTO v_cust FROM entities WHERE tenant_id = c_tenant AND entity_type = 'customer';
  SELECT count(*) INTO v_units FROM entities WHERE tenant_id = c_tenant AND entity_type = 'equipment';
  SELECT count(*) INTO v_links FROM document_entity_links WHERE tenant_id = c_tenant;
  IF to_regclass('public.document_financials') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM document_financials WHERE tenant_id = $1' INTO v_money USING c_tenant;
  END IF;
  SELECT x.value INTO v_serial FROM extractions x WHERE x.tenant_id = c_tenant AND x.field_key = 'serial_number'
   ORDER BY x.id OFFSET least(2000, v_docs / 3) LIMIT 1;
  SELECT e.data->>'customer_name' INTO v_custname FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
   WHERE l.tenant_id = c_tenant AND e.entity_type = 'customer' ORDER BY l.id OFFSET v_docs / 5 LIMIT 1;
  v_deep_at := greatest(0, (v_docs * 4 / 10) - 1);
  SELECT d.created_at::text, d.id::text INTO v_ts1, v_id1 FROM documents d WHERE d.tenant_id = c_tenant
   ORDER BY d.created_at DESC, d.id DESC OFFSET least(49, greatest(v_docs - 1, 0)) LIMIT 1;
  SELECT d.created_at::text, d.id::text INTO v_ts2, v_id2 FROM documents d WHERE d.tenant_id = c_tenant
   ORDER BY d.created_at DESC, d.id DESC OFFSET v_deep_at LIMIT 1;
  SELECT d.created_at::text, d.id::text INTO v_ts3, v_id3 FROM documents d WHERE d.tenant_id = c_tenant AND d.stage <> 'verified'
   ORDER BY d.created_at DESC, d.id DESC OFFSET 199 LIMIT 1;
  v_ts3 := coalesce(v_ts3, v_ts1); v_id3 := coalesce(v_id3, v_id1);

  -- migrations 63 and 64 present?
  SELECT count(*) INTO v_idx64 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
   WHERE i.indisvalid AND c.relname IN ('idx_entities_tenant_cust_name_trgm', 'idx_entities_tenant_address_trgm',
                                       'idx_entities_tenant_manufacturer_trgm', 'idx_documents_tenant_created_id');
  SELECT count(*) INTO v_idx63 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
   WHERE i.indisvalid AND c.relname = 'idx_document_pages_tenant_created';
  v_fn_installed := to_regprocedure('records_search_candidates(text,text)') IS NOT NULL;

  -- from here on, behave like the app: its restricted role, subject to row-level security
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepwell_rls') THEN
    BEGIN
      SET LOCAL ROLE deepwell_rls;
      v_ran := 'app role (deepwell_rls)';
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        BEGIN
          EXECUTE format('GRANT deepwell_rls TO %I WITH INHERIT FALSE, SET TRUE', v_orig_user);
        EXCEPTION WHEN OTHERS THEN
          EXECUTE format('GRANT deepwell_rls TO %I', v_orig_user);
        END;
        SET LOCAL ROLE deepwell_rls;
        v_ran := 'app role (deepwell_rls)';
      EXCEPTION WHEN OTHERS THEN
        v_ran := 'ran as owner';
        v_role_note := 'could not switch to the app role (' || SQLERRM || '); owner timings skip row-level security, so they are optimistic';
      END;
    END;
  ELSE
    v_ran := 'ran as owner';
    v_role_note := 'the app role deepwell_rls does not exist on this branch';
  END IF;
  -- does the app role get to use records_search_candidates()? (the app checks this the same way)
  v_fn := v_fn_installed AND (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deepwell_rls')
                              OR has_function_privilege('deepwell_rls', 'records_search_candidates(text,text)', 'EXECUTE'));

  -- ---- setup facts ----
  step := 1; check_name := 'Seeded: documents'; ms := NULL; target_ms := NULL; result := 'INFO'; ran_as := NULL; result_size := v_docs; note := NULL; RETURN NEXT;
  step := 2; check_name := 'Seeded: pages of text'; result_size := v_pages; RETURN NEXT;
  step := 3; check_name := 'Seeded: extracted fields (technician, dates, serials, amounts)'; result_size := v_fields; RETURN NEXT;
  step := 4; check_name := 'Seeded: customers'; result_size := v_cust; RETURN NEXT;
  step := 5; check_name := 'Seeded: equipment units'; result_size := v_units; RETURN NEXT;
  step := 6; check_name := 'Seeded: document links'; result_size := v_links; RETURN NEXT;
  step := 7; check_name := 'Seeded: invoice / quote / PO money rows'; result_size := v_money; RETURN NEXT;
  step := 8; check_name := 'Migration 64 (search indexes + fast search function)'; result_size := v_idx64;
  IF v_fn_installed AND v_idx64 = 4 AND v_fn THEN result := 'PASS'; note := 'all 4 indexes and records_search_candidates() present and usable by the app role';
  ELSE result := 'FAIL'; note := '64 not pasted - search will be slow' || CASE WHEN v_fn_installed AND NOT v_fn THEN ' (function exists but the app role may not run it)' ELSE '' END; END IF;
  RETURN NEXT;
  step := 9; check_name := 'Migration 63 (pages-per-month index)'; result_size := v_idx63;
  IF v_idx63 = 1 THEN result := 'PASS'; note := 'index present'; ELSE result := 'FAIL'; note := '63 not pasted - the monthly page count will be slow'; END IF;
  RETURN NEXT;
  note := v_role_note;

  -- ---- the timed checks: step, name, what to run, argument, target in ms ----
  FOR rec IN SELECT * FROM (VALUES
    (10, 'Records list: first page (newest 50 documents)',                         'browse_first',  NULL::text,                  200),
    (11, 'Records list: "Load more" (page 2)',                                     'browse_keyset', v_ts1 || '|' || v_id1,       200),
    (12, 'Records list: "Load more" deep in the list (after ~40% of all documents)','browse_keyset', v_ts2 || '|' || v_id2,       200),
    (20, 'Records search: common word "service"',                                  'search',        'service',                   300),
    (21, 'Records search: phrase "refrigerant leak"',                              'search',        'refrigerant leak',          300),
    (22, 'Records search: rare serial number ' || coalesce(v_serial, '(none)'),    'search',        coalesce(v_serial, 'none'),  300),
    (23, 'Records search: customer name ' || coalesce(v_custname, '(none)'),       'search',        coalesce(v_custname, 'none'),300),
    (24, 'Records search: technician "Priyanka Raghunathan"',                      'search',        'Priyanka Raghunathan',      300),
    (25, 'Records search: street name "Saguaro Vista"',                            'search',        'Saguaro Vista',             300),
    (26, 'Records search: a term with no matches ("zzqxv")',                       'search',        'zzqxv',                     300),
    (30, 'Records filter chips (counts for each filter; loads in the background)', 'facets',        NULL,                        500),
    (40, 'Inbox / dashboard: headline counts (review summary)',                    'review',        NULL,                        200),
    (41, 'Inbox: needs-review list, first 200',                                    'unv_first',     NULL,                        200),
    (42, 'Inbox: needs-review list, "load more"',                                  'unv_keyset',    v_ts3 || '|' || v_id3,       200),
    (43, 'Billing: total documents stored',                                        'count_docs',    NULL,                        200),
    (44, 'Billing / upload gate: pages read this month',                           'pages_month',   NULL,                        200),
    (45, 'Upload gate: pages waiting to be read',                                  'pending',       NULL,                        200),
    (50, 'Customers list: first page (50 most recently active)',                   'cust_page',     '0',                         200),
    (51, 'Customers list: last page',                                              'cust_page',     greatest(v_cust - 50, 0)::text, 200),
    (52, 'Customers list: search by name ' || coalesce(v_custname, '(none)'),      'cust_search',   coalesce(v_custname, 'none'),200),
    (53, 'Customers list: total count',                                            'cust_count',    NULL,                        200),
    (54, 'Dashboard: warranty attention list (next 90 days)',                      'warranty',      NULL,                        200),
    (60, 'Donovan passage search: a normal question',                              'passages',      'when was the compressor capacitor replaced at the Whitmore property', 300),
    (61, 'Donovan passage search: a question with a serial number',                'passages',      'what is the warranty on serial ' || coalesce(v_serial, 'X00X000000'), 300)
  ) AS t(st, nm, q, arg, tgt) ORDER BY st LOOP
    step := rec.st; check_name := rec.nm; target_ms := rec.tgt; ran_as := v_ran; ms := NULL; result_size := NULL;
    BEGIN
      times := ARRAY[]::numeric[];
      FOR i IN 1..3 LOOP
        t0 := clock_timestamp();
        v_size := loadtest_q(rec.q, rec.arg, v_fn);
        times := times || (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric;
      END LOOP;
      SELECT x INTO v_med FROM unnest(times) x ORDER BY x OFFSET 1 LIMIT 1;
      ms := round(v_med, 1); result_size := v_size;
      IF v_med <= rec.tgt THEN result := 'PASS'; v_pass := v_pass + 1; ELSE result := 'FAIL'; v_fail := v_fail + 1; END IF;
      note := CASE WHEN rec.q = 'search' AND NOT v_fn THEN '64 not pasted - search will be slow' ELSE v_role_note END;
    EXCEPTION WHEN OTHERS THEN
      result := 'ERROR'; ms := NULL; v_fail := v_fail + 1; note := left(SQLERRM, 200);
    END;
    RETURN NEXT;
  END LOOP;

  RESET ROLE;
  step := 0; check_name := 'OVERALL: ' || v_pass || ' of ' || (v_pass + v_fail) || ' timed checks within target'; ms := NULL; target_ms := NULL;
  result := CASE WHEN v_fail = 0 THEN 'PASS' ELSE 'FAIL' END; ran_as := v_ran; result_size := v_docs;
  note := CASE WHEN v_fail = 0 THEN 'Search and lists stay fast at ' || v_docs || ' documents.'
               ELSE v_fail || ' check(s) over target or erroring - see the rows marked FAIL / ERROR.' END || coalesce(' ' || v_role_note, '');
  RETURN NEXT;
END
$f$;

SELECT step, check_name, ms, target_ms, result, ran_as, result_size, note
  FROM loadtest_run()
 ORDER BY step;
