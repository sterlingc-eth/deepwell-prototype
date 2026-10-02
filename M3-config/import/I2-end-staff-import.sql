-- ============================================================================
-- I2-end-staff-import.sql  (staff import, step 2 of 2: CLOSE the import)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Closes the staff import that I1 opened, right now:
--   * the company's temporary page allowance, higher limits and API-key permission all stop;
--   * any API key the customer created since the import opened with "import" in its name is revoked (so a Fleet
--     customer's import key cannot outlive the job; other keys are left alone and are listed in the result);
--   * the dates of the import stay on file ONLY so its pages stay out of the customer's monthly count. Nothing is deleted.
--
-- RUN THIS ONLY AFTER the reading has finished (the import tool's --watch-reading says all documents are read, or the
-- app's Inbox shows nothing still "Reading"). Pages that finish being read AFTER you run this count against the
-- customer's monthly allowance.
--
-- HOW TO USE IT (about 1 minute)
--   1. Edit the ONE line marked  >>> EDIT THIS LINE <<<  (the same company name or id you used in I1).
--   2. Paste the whole file into the Neon SQL Editor and press Run.
--   3. Read the result table: AFTER must show an "endedAt" time. Then, in the app (Billing > API access), delete the
--      import key too, and delete the customer's files from the staff computer (see handoffs/IMPORT_RUNBOOK.md).
--
-- SAFE TO RUN AGAIN? Yes. If the import is already closed it changes nothing and says so.
-- ============================================================================

DO $end$
DECLARE
  -- >>> EDIT THIS LINE <<<   the company's name (exactly as in the app) or its id:
  v_company  text := 'TYPE THE COMPANY NAME OR ID HERE';

  v_id       uuid;
  v_count    int;
  v_old      jsonb;
  v_now      timestamptz := now();
  v_fmt      text := 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
  v_revoked  int := 0;
  v_from     timestamptz;
BEGIN
  IF v_company IS NULL OR btrim(v_company) = '' OR v_company LIKE 'TYPE THE COMPANY%' THEN
    RAISE EXCEPTION 'Nothing was changed. Edit the line marked ">>> EDIT THIS LINE <<<" and put the company name or id in it.';
  END IF;

  SELECT count(*) INTO v_count FROM tenants
   WHERE id::text = btrim(v_company) OR clerk_org_id = btrim(v_company) OR lower(name) = lower(btrim(v_company));
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Nothing was changed. No company matches "%". Use the name exactly as it shows in the app, or the company id.', v_company;
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'Nothing was changed. % companies match "%". Use the company id instead.', v_count, v_company;
  END IF;

  SELECT id, COALESCE(limits -> 'staffImport', 'null'::jsonb) INTO v_id, v_old
    FROM tenants
   WHERE id::text = btrim(v_company) OR clerk_org_id = btrim(v_company) OR lower(name) = lower(btrim(v_company));

  DROP TABLE IF EXISTS pg_temp.staff_import_before;
  CREATE TEMP TABLE staff_import_before AS
    SELECT 'BEFORE'::text AS "when", t.id, t.name, t.plan, t.billing_status, t.limits -> 'staffImport' AS staff_import
      FROM tenants t WHERE t.id = v_id;

  IF v_old = 'null'::jsonb THEN
    RAISE NOTICE 'No staff import is on file for this company. Nothing was changed.';
    RETURN;
  END IF;

  IF v_old ? 'endedAt' THEN
    RAISE NOTICE 'This import was already closed (%). Nothing was changed.', v_old ->> 'endedAt';
    RETURN;
  END IF;

  UPDATE tenants
     SET limits = jsonb_set(limits, '{staffImport,endedAt}', to_jsonb(to_char(v_now AT TIME ZONE 'UTC', v_fmt)))
   WHERE id = v_id;

  v_from := NULL;
  BEGIN
    v_from := (v_old ->> 'from')::timestamptz;
  EXCEPTION WHEN others THEN v_from := NULL;
  END;
  IF v_from IS NOT NULL THEN
    UPDATE api_keys SET revoked_at = v_now
     WHERE tenant_id = v_id AND revoked_at IS NULL AND created_at >= v_from AND name ILIKE '%import%';
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
  END IF;

  RAISE NOTICE 'Staff import CLOSED. % import key(s) revoked. Delete the key in the app too, and delete the customer files from the staff computer.', v_revoked;
END
$end$;

-- RESULT: BEFORE and AFTER rows for the company (AFTER must show "endedAt"), then any API keys still active for it.
SELECT * FROM pg_temp.staff_import_before
UNION ALL
SELECT 'AFTER', t.id, t.name, t.plan, t.billing_status, t.limits -> 'staffImport'
  FROM tenants t
 WHERE t.id = (SELECT id FROM pg_temp.staff_import_before);

-- Any key still active for this company (should be empty or only keys you recognise):
SELECT k.name, 'dw_live_' || k.key_prefix || '...' AS key, k.created_at, k.last_used_at
  FROM api_keys k
 WHERE k.tenant_id = (SELECT id FROM pg_temp.staff_import_before) AND k.revoked_at IS NULL;
