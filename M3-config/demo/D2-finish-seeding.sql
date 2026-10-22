-- ============================================================================
-- D2-finish-seeding.sql  (industry demo, step 2 of 3: LOCK IN THE SAMPLE PAPERWORK)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Run it once the seeding tool has loaded every demo company and every document shows as read (the tool's
-- --watch-reading output, or `node scripts/demo-acct/health-check.mjs`). For every demo company it:
--   1. records the documents it has now as its ORIGINAL sample paperwork (the "seed"). From then on, "Clear my scans"
--      and the nightly reset remove anything that is not in this list;
--   2. closes the sample-data loading window that D1 opened (the import key stops working right away) and revokes
--      the import keys created while it was open.
-- Nothing is deleted.
--
-- SAFE TO RUN AGAIN? Yes, but only right after a fresh seeding: whatever documents a demo company holds when you run
-- it become its seed. Do not run it after a meeting has left a prospect's scan in a demo company (run
-- "Clear my scans" or wait for the nightly reset first).
-- ============================================================================

DO $finish$
DECLARE
  t        record;
  v_n      int;
  v_fmt    text := 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
  v_keys   int;
BEGIN
  IF to_regprocedure('public.demo_mark_seed(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Nothing was changed. Paste M3-config/73-demo-accounts.sql first.';
  END IF;
  FOR t IN SELECT id, clerk_org_id, limits FROM tenants WHERE plan = 'demo' AND billing_status = 'demo' ORDER BY clerk_org_id LOOP
    v_n := demo_mark_seed(t.id);
    IF v_n = 0 THEN
      RAISE WARNING 'Demo company % has NO documents yet - seed it before running D2 (its seed list is empty).', t.clerk_org_id;
    END IF;
    UPDATE tenants
       SET limits = jsonb_set(limits, '{staffImport,endedAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', v_fmt)), true)
     WHERE id = t.id AND limits ? 'staffImport' AND NOT (limits -> 'staffImport' ? 'endedAt');
    UPDATE api_keys SET revoked_at = now() WHERE tenant_id = t.id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_keys = ROW_COUNT;
    RAISE NOTICE 'Demo company %: % seed documents recorded, loading window closed, % key(s) revoked.', t.clerk_org_id, v_n, v_keys;
  END LOOP;
END
$finish$;

-- RESULT: one row per demo company; seed_documents = documents, import_closed = true.
SELECT t.clerk_org_id, t.limits -> 'demo' ->> 'industry' AS industry,
       (SELECT count(*) FROM documents d WHERE d.tenant_id = t.id) AS documents,
       (SELECT count(*) FROM demo_seed_documents s WHERE s.tenant_id = t.id) AS seed_documents,
       (t.limits -> 'staffImport' ? 'endedAt') AS import_closed,
       t.limits -> 'demo' ->> 'seededAt' AS seeded_at
  FROM tenants t
 WHERE t.plan = 'demo'
 ORDER BY 2;
