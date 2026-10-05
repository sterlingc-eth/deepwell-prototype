-- ============================================================================
-- 67-page-usage-counter.sql — monthly page meter that deletes cannot reset. Idempotent; safe to re-run. Run AFTER 66.
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Until now "pages used this month" was a live COUNT of the rows in document_pages. So an admin who deleted documents got the
-- pages back, although those pages had already been read (and paid for in model calls). This adds a small monthly tally per
-- company (page_usage_monthly) that only ever goes UP: every page row that is really inserted adds 1 to the tally for the
-- UTC month it was created in. Deleting documents, pages, customers or merging companies never lowers it. Deleting the whole
-- company (the tenants row) deletes it through the foreign key; "delete all my data" keeps it (no customer content in it).
--
-- The app shows and enforces GREATEST(this month's tally, this month's live count). So:
--   * before this file is pasted, nothing changes (the app notices the missing table and counts live rows as today);
--   * pasting it can never make anyone's number drop or jump: the tally starts at today's live count (below);
--   * pages written between this paste and the new app code arriving are still counted by the live-count side.
--
-- WHAT IT CHANGES
--   new table     page_usage_monthly (tenant_id, month, pages)          row level security, same form as usage_counters
--   new trigger   document_pages_usage_count  (statement level, AFTER INSERT, transition table) — counts EVERY writer
--   new functions page_counter_parse_iso, page_counter_import_window, page_usage_count_insert, page_usage_current_month, page_usage_months
--   NOTHING existing is altered or deleted. A brief lock (page writes wait a few seconds, reads continue) while the tally is built; gives up after 5 s if it cannot get it (just run again).
--
-- A staff import (tenants.limits.staffImport, M3-config/66 + api/_lib/staffImport.js) keeps its pages OUT of the monthly
-- tally, exactly as the live count leaves them out: page_counter_import_window() below is the same rule as staffImportFor().
--
-- If a tally problem ever occurs the trigger raises a WARNING and carries on: counting can never block reading a page.
-- ============================================================================

BEGIN;
-- Never queue behind a slow query for long: give up cleanly (nothing is changed) instead of blocking the app. Just run it again.
SET LOCAL lock_timeout = '5s';
-- Blocks page INSERT/UPDATE/DELETE (reads continue) until COMMIT, so the backfill and the trigger have no gap between them.
-- (Outside a transaction block this statement errors harmlessly; every statement below is idempotent on its own.)
LOCK TABLE document_pages IN SHARE ROW EXCLUSIVE MODE;

-- ---- 1. the tally -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_usage_monthly (
  tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month      DATE        NOT NULL,                 -- first day of the UTC calendar month
  pages      BIGINT      NOT NULL DEFAULT 0 CHECK (pages >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);

ALTER TABLE page_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_usage_monthly FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolate_page_usage_monthly ON page_usage_monthly;
CREATE POLICY tenants_isolate_page_usage_monthly ON page_usage_monthly
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 2. the staff-import window, in SQL ------------------------------------------
-- Port of api/_lib/staffImport.js staffImportFor()/staffImportWindowFor(). First the date reader: JS isoDate() accepts
-- ISO-8601 WITH a zone (Z or +hh:mm) and lets Date() roll an impossible day (Feb 30 -> Mar 2) or "24:00:00" forward; Postgres
-- would refuse those, so they are done by hand here to keep both sides on the same instants. NULL = unreadable.
CREATE OR REPLACE FUNCTION page_counter_parse_iso(p text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  m    text[];
  y    int; mo int; d int; hh int; mi int; ss int; ms int;
  tzh  int := 0; tzm int := 0; sgn int := 1;
  ts   timestamp;
BEGIN
  m := regexp_match(p, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?(Z|[+-][0-9]{2}:[0-9]{2})$');
  IF m IS NULL THEN RETURN NULL; END IF;
  y := m[1]::int; mo := m[2]::int; d := m[3]::int; hh := m[4]::int; mi := m[5]::int;
  ss := COALESCE(m[6], '0')::int;
  ms := COALESCE(NULLIF(rpad(COALESCE(m[7], ''), 3, '0'), ''), '0')::int;
  IF mo < 1 OR mo > 12 OR d < 1 OR d > 31 OR hh > 24 OR mi > 59 OR ss > 59 THEN RETURN NULL; END IF;
  IF hh = 24 AND (mi <> 0 OR ss <> 0 OR ms <> 0) THEN RETURN NULL; END IF;
  IF m[8] <> 'Z' THEN
    tzh := substr(m[8], 2, 2)::int; tzm := substr(m[8], 5, 2)::int;
    IF tzh > 23 OR tzm > 59 THEN RETURN NULL; END IF;
    sgn := CASE WHEN left(m[8], 1) = '-' THEN -1 ELSE 1 END;
  END IF;
  ts := make_timestamp(y, mo, 1, 0, 0, 0) + (d - 1) * interval '1 day'
        + make_interval(hours => hh, mins => mi, secs => ss + ms / 1000.0);
  RETURN (ts - sgn * make_interval(hours => tzh, mins => tzm)) AT TIME ZONE 'UTC';
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- The window itself: [from, end) where end is the earliest of `until`, `endedAt` and from + 60 days. Anything malformed (not an
-- object; `from`/`until` unreadable; `pages` not a whole positive number) means NO window, so those pages count. A window that
-- is empty (end <= from) excludes nothing, so it is also reported as NULL.
CREATE OR REPLACE FUNCTION page_counter_import_window(p_limits jsonb)
RETURNS tstzrange
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  raw     jsonb;
  pg      jsonb;
  v_from  timestamptz;
  v_until timestamptz;
  v_end   timestamptz;
  v_ended timestamptz;
BEGIN
  IF jsonb_typeof(p_limits) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  raw := p_limits -> 'staffImport';
  IF jsonb_typeof(raw) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;

  pg := raw -> 'pages';
  IF jsonb_typeof(pg) = 'number' THEN
    IF NOT ((pg #>> '{}')::numeric = trunc((pg #>> '{}')::numeric)
            AND (pg #>> '{}')::numeric > 0
            AND (pg #>> '{}')::numeric < 1.7976931348623157e308) THEN RETURN NULL; END IF;
  ELSIF jsonb_typeof(pg) = 'string' THEN
    IF NOT ((pg #>> '{}') ~ '^[0-9]{1,12}$') THEN RETURN NULL; END IF;
    IF (pg #>> '{}')::bigint <= 0 THEN RETURN NULL; END IF;
  ELSE
    RETURN NULL;
  END IF;

  IF jsonb_typeof(raw -> 'from') IS DISTINCT FROM 'string' OR jsonb_typeof(raw -> 'until') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  v_from  := page_counter_parse_iso(raw ->> 'from');
  v_until := page_counter_parse_iso(raw ->> 'until');
  IF v_from IS NULL OR v_until IS NULL THEN RETURN NULL; END IF;

  v_end := LEAST(v_until, v_from + make_interval(secs => 5184000));   -- 60 days, absolute (not DST dependent)

  -- endedAt: present and not null. Readable -> may only shorten the window. Unreadable -> ignored (the grant is closed
  -- elsewhere; the window itself is kept, only so its pages stay out of the monthly count).
  IF jsonb_typeof(raw -> 'endedAt') = 'string' THEN
    v_ended := page_counter_parse_iso(raw ->> 'endedAt');
    IF v_ended IS NOT NULL AND v_ended < v_end THEN v_end := v_ended; END IF;
  END IF;

  IF v_end <= v_from THEN RETURN NULL; END IF;
  RETURN tstzrange(v_from, v_end, '[)');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- ---- 3. the counting trigger -------------------------------------------------------
-- Statement level with a transition table: ONE tally update per INSERT statement (a 40-page insert bumps by 40), and only rows
-- that were really inserted are in it (an upsert that hits ON CONFLICT DO UPDATE is not an insert, so a re-read adds 0).
-- Month = the UTC month of the row's own created_at. Rows inside the company's staff-import window are skipped.
-- Nothing ever decrements. Any failure is a WARNING, never an error: page ingestion must not depend on the tally.
CREATE OR REPLACE FUNCTION page_usage_count_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO page_usage_monthly AS p (tenant_id, month, pages, updated_at)
  SELECT n.tenant_id, date_trunc('month', n.created_at AT TIME ZONE 'UTC')::date AS m, count(*), now()
    FROM new_rows n
    LEFT JOIN tenants t ON t.id = n.tenant_id
   WHERE n.tenant_id IS NOT NULL AND n.created_at IS NOT NULL
     AND NOT COALESCE(page_counter_import_window(t.limits) @> n.created_at, false)
   GROUP BY n.tenant_id, date_trunc('month', n.created_at AT TIME ZONE 'UTC')::date
   ORDER BY n.tenant_id, m
  ON CONFLICT (tenant_id, month) DO UPDATE
    SET pages = p.pages + EXCLUDED.pages, updated_at = now();
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'page_usage_count_insert: tally not updated (%): %', SQLSTATE, SQLERRM;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION page_usage_count_insert() FROM PUBLIC;

-- CREATE OR REPLACE (not DROP + CREATE): DROP TRIGGER takes an ACCESS EXCLUSIVE lock that would block page READS too.
CREATE OR REPLACE TRIGGER document_pages_usage_count
  AFTER INSERT ON document_pages
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION page_usage_count_insert();

-- ---- 4. read helpers (SECURITY INVOKER: row level security applies as the caller) ----
-- The app calls these instead of naming the table, so a table that was dropped behind a warm cache returns 0 here instead of
-- aborting the caller's transaction.
CREATE OR REPLACE FUNCTION page_usage_current_month()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN COALESCE((SELECT p.pages FROM page_usage_monthly p
                    WHERE p.tenant_id = (current_setting('app.tenant_id', true))::uuid
                      AND p.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date), 0);
EXCEPTION WHEN undefined_table THEN
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION page_usage_months(p_from date, p_to date)
RETURNS TABLE (month date, pages bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY SELECT p.month, p.pages FROM page_usage_monthly p
                WHERE p.tenant_id = (current_setting('app.tenant_id', true))::uuid
                  AND p.month >= p_from AND p.month < p_to;
EXCEPTION WHEN undefined_table THEN
  RETURN;
END;
$$;

-- ---- 5. backfill: the current UTC month, from the pages that exist now ----------------
-- GREATEST so that re-running can neither double count nor lower a tally that has already grown past the live rows
-- (deleted documents). Same rule as the live count: this month, minus pages inside the company's staff-import window.
INSERT INTO page_usage_monthly AS p (tenant_id, month, pages, updated_at)
SELECT dp.tenant_id, date_trunc('month', now() AT TIME ZONE 'UTC')::date, count(*), now()
  FROM document_pages dp
  JOIN tenants t ON t.id = dp.tenant_id
 WHERE dp.created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
   AND dp.created_at <  ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
   AND NOT COALESCE(page_counter_import_window(t.limits) @> dp.created_at, false)
 GROUP BY dp.tenant_id
 ORDER BY dp.tenant_id
ON CONFLICT (tenant_id, month) DO UPDATE
  SET pages = GREATEST(p.pages, EXCLUDED.pages), updated_at = now();

-- ---- 6. who may touch what (same guard as the neighbouring migrations: only if the role exists) ----
-- The app only READS the tally (the trigger, running as the table owner, is the only writer), and deletes it when a company's
-- data is erased. It gets no INSERT/UPDATE: a bug or injected statement in the app cannot raise or lower a tally.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, DELETE ON page_usage_monthly TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION page_usage_current_month() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION page_usage_months(date, date) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION page_counter_import_window(jsonb) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION page_counter_parse_iso(text) TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ---- proof ------------------------------------------------------------------
-- Expect one row: counting_trigger = 1, tally_rows >= 0, rls_forced = true.
SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'document_pages'::regclass AND tgname = 'document_pages_usage_count') AS counting_trigger,
       (SELECT count(*) FROM page_usage_monthly) AS tally_rows,
       (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'page_usage_monthly'::regclass) AS rls_forced;
