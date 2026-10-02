-- ============================================================================
-- I1-allow-staff-import.sql  (staff import, step 1 of 2: OPEN the import)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Lets DeepWell staff load a big folder of one customer's files with the staff import tool
-- (scripts/import/deepwell-import.mjs). It switches on, for THAT ONE COMPANY ONLY, and only for a limited time:
--   1. API keys: the company can create an API key (normally a Fleet-plan feature). The tool signs in with it.
--   2. A separate page allowance for the import, so the import does not use up the customer's normal monthly pages
--      and is not blocked by them. Pages read during the import are left out of the customer's monthly count.
--   3. Higher upload-speed and daily-AI-call limits for the import, and room for more stored documents.
-- It switches itself OFF at the end date below (never more than 60 days), and you switch it off sooner with
-- I2-end-staff-import.sql. The customer cannot turn any of this on themselves: only this paste can.
--
-- WHAT YOU NEED FIRST
--   * Migration 66-staff-import-override.sql pasted once (this file stops with a message if it was not).
--   * The company must be on a plan (trial or paid). This does not replace a missing or cancelled subscription.
--
-- HOW TO USE IT (about 1 minute)
--   1. Edit the ONE line marked  >>> EDIT THIS LINE <<<  below: put the company's name (as it shows in the app) or its
--      id. Leave every other line alone unless the runbook (handoffs/IMPORT_RUNBOOK.md) tells you to change it.
--   2. Paste the whole file into the Neon SQL Editor and press Run.
--   3. Read the result table at the bottom. The BEFORE row shows nothing switched on; the AFTER row shows the dates
--      and numbers now in force. If it stopped with an error, nothing was changed: read the message.
--   4. Wait 5 minutes (the app remembers each company's limits briefly), then create the import key.
--
-- SAFE TO RUN AGAIN? Yes. Running it again while the import is open keeps it open, moves the end date to a fresh 14 days
-- from now, and applies any new numbers. It never opens an import for more than one company.
-- AFTER YOU CLOSED IT (I2): pasting this file again does NOT quietly re-open it (an old tab or saved query would). It stops
-- with a message; to open it again on purpose, change  v_reopen := false  to  v_reopen := true  below.
-- The numbers are checked against the same hard ceilings the app enforces, so an extra zero cannot remove a limit.
-- ============================================================================

DO $import$
DECLARE
  -- >>> EDIT THIS LINE <<<   the company's name (exactly as in the app) or its id:
  v_company        text    := 'TYPE THE COMPANY NAME OR ID HERE';

  -- ---- leave these alone unless the runbook says otherwise ------------------------------------------------------
  v_days           int     := 14;       -- how long the import stays open (days). The app ignores anything over 60.
  v_pages          int     := 250000;   -- page allowance for the whole import (a safety cap on AI reading cost)
  v_extra_docs     int     := 100000;   -- how many MORE stored documents than the plan normally allows
  v_per_minute     int     := 600;      -- uploads per minute for this company during the import
  v_per_day        int     := 200000;   -- upload units per day (each file counts 2)
  v_model_calls    int     := 150000;   -- AI reading calls per day
  v_reopen         boolean := false;    -- set to true ONLY to open an import you already closed with I2
  -- ----------------------------------------------------------------------------------------------------------------

  v_id        uuid;
  v_count     int;
  v_plan      text;
  v_status    text;
  v_old       jsonb;
  v_from      timestamptz;
  v_until     timestamptz;
  v_now       timestamptz := now();
  v_fmt       text := 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
BEGIN
  IF v_company IS NULL OR btrim(v_company) = '' OR v_company LIKE 'TYPE THE COMPANY%' THEN
    RAISE EXCEPTION 'Nothing was changed. Edit the line marked ">>> EDIT THIS LINE <<<" and put the company name or id in it.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'billing_apply' AND pg_get_functiondef(p.oid) LIKE '%staff-import-authoritative-v2%') THEN
    RAISE EXCEPTION 'Nothing was changed. Paste M3-config/66-staff-import-override.sql first (it makes sure Stripe cannot switch the import off part-way, or undo I2), then run this again.';
  END IF;
  IF v_days < 1 OR v_days > 60 THEN
    RAISE EXCEPTION 'Nothing was changed. v_days must be between 1 and 60.';
  END IF;
  -- same ceilings as api/_lib/staffImport.js STAFF_IMPORT_CEILINGS (the app clamps to them anyway; this stops the typo early)
  IF v_pages NOT BETWEEN 1 AND 1000000 OR v_extra_docs NOT BETWEEN 0 AND 1000000 OR v_per_minute NOT BETWEEN 1 AND 2000
     OR v_per_day NOT BETWEEN 1 AND 1000000 OR v_model_calls NOT BETWEEN 1 AND 500000 THEN
    RAISE EXCEPTION 'Nothing was changed. A number is outside its hard ceiling: pages 1-1,000,000, extra documents 0-1,000,000, uploads per minute 1-2,000, upload units per day 1-1,000,000, AI calls per day 1-500,000.';
  END IF;

  SELECT count(*) INTO v_count FROM tenants
   WHERE id::text = btrim(v_company) OR clerk_org_id = btrim(v_company) OR lower(name) = lower(btrim(v_company));
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Nothing was changed. No company matches "%". Use the name exactly as it shows in the app, or the company id.', v_company;
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'Nothing was changed. % companies match "%". Use the company id instead (SELECT id, name FROM tenants WHERE lower(name) = lower(''%'');).', v_count, v_company, v_company;
  END IF;

  SELECT id, plan, billing_status, COALESCE(limits -> 'staffImport', 'null'::jsonb)
    INTO v_id, v_plan, v_status, v_old
    FROM tenants
   WHERE id::text = btrim(v_company) OR clerk_org_id = btrim(v_company) OR lower(name) = lower(btrim(v_company));

  IF v_old ? 'endedAt' AND NOT v_reopen THEN
    RAISE EXCEPTION 'Nothing was changed. The import for "%" was already CLOSED (at %). To open it again on purpose, change  v_reopen := false  to  v_reopen := true  and paste again.', v_company, v_old ->> 'endedAt';
  END IF;

  -- Remember the BEFORE row for the result table at the bottom (lives only for this paste).
  DROP TABLE IF EXISTS pg_temp.staff_import_before;
  CREATE TEMP TABLE staff_import_before AS
    SELECT 'BEFORE'::text AS "when", t.id, t.name, t.plan, t.billing_status, t.limits -> 'staffImport' AS staff_import
      FROM tenants t WHERE t.id = v_id;

  IF v_status IS NULL OR v_status NOT IN ('trialing', 'active', 'past_due') THEN
    RAISE WARNING 'This company has no active plan (status: %). The import is switched on, but uploads stay blocked until it has a trial or a plan.', COALESCE(v_status, 'none');
  END IF;

  -- Keep the original start time when an import was opened in the last 30 days, so the pages it read stay out of the
  -- monthly count without a gap; otherwise start now.
  v_from := v_now;
  IF v_old ? 'from' AND (v_old ->> 'from') ~ '^\d{4}-\d{2}-\d{2}T' THEN
    BEGIN
      IF (v_old ->> 'from')::timestamptz > v_now - interval '30 days' THEN v_from := (v_old ->> 'from')::timestamptz; END IF;
    EXCEPTION WHEN others THEN v_from := v_now;
    END;
  END IF;

  -- never more than 60 days after the (possibly kept) start, the same rule the app applies
  v_until := LEAST(v_now + make_interval(days => v_days), v_from + interval '60 days');

  UPDATE tenants
     SET limits = COALESCE(limits, '{}'::jsonb) || jsonb_build_object('staffImport', jsonb_build_object(
           'from',                to_char(v_from AT TIME ZONE 'UTC', v_fmt),
           'until',               to_char(v_until AT TIME ZONE 'UTC', v_fmt),
           'pages',               v_pages,
           'documents',           v_extra_docs,
           'ingestPerMinute',     v_per_minute,
           'ingestPerDay',        v_per_day,
           'maxModelCallsPerDay', v_model_calls))
   WHERE id = v_id;

  RAISE NOTICE 'Staff import OPEN for % (plan %, status %) until % UTC. Allowance: % pages. Wait 5 minutes before creating the import key.',
    v_company, COALESCE(v_plan, 'none'), COALESCE(v_status, 'none'), to_char(v_until AT TIME ZONE 'UTC', v_fmt), v_pages;
END
$import$;

-- RESULT: two rows. BEFORE = what was on the company's row when you pasted; AFTER = what is in force now.
-- AFTER must show a "staff_import" with an "until" date in the future.
SELECT * FROM pg_temp.staff_import_before
UNION ALL
SELECT 'AFTER', t.id, t.name, t.plan, t.billing_status, t.limits -> 'staffImport'
  FROM tenants t
 WHERE t.id = (SELECT id FROM pg_temp.staff_import_before);
