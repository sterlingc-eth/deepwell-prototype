-- ============================================================================
-- D1-setup-demo-companies.sql  (industry demo, step 1 of 3: TURN THE SIX WAVE 1 ORGANIZATIONS INTO DEMO COMPANIES)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- For each of the six Wave 1 demo organizations (and ONLY those you list below) it:
--   1. checks the organization is a real demo organization (see SAFETY below; it never creates a company row);
--   2. puts it on the free Demo plan (plan = 'demo', billing_status = 'demo'): never billed, kept out of warranty
--      digests, outreach, follow-ups and Donovan's learning autopilot, and out of business metrics;
--   3. stores the company's own name and industry (so Donovan reads the paperwork with the right trade vocabulary
--      and never mistakes the company's own letterhead for a customer);
--   4. opens a 14-day sample-data loading window (the same "staff import" switch as M3-config/import/I1) so the
--      seeding tool can sign in with an import key and load the sample paperwork. D2 closes it.
-- SAFETY (fix round 2, 2026-10-22): it converts ONLY the organizations listed below, and for each one it first checks that the
-- organization is really a demo organization. It stops, changing nothing, unless ALL of these hold for EVERY listed id:
--   * the organization already exists in the app (the demo login has opened it at least once);
--   * its recorded name is the organization id or starts with "Demo · " (the names you gave the six Clerk organizations);
--   * it is OWNED BY THE DEMO ACCOUNT: the demo login (its Clerk user id, pasted below) is a member with the admin role, and
--     NOBODY ELSE is a member (the id is checked, not the email: the app may not have a real email on file for a login);
--   * it holds no documents yet (unless it is already a demo company being re-run);
--   * it has no plan, no billing status and no Stripe customer other than the demo ones; and it is not Sonoran Comfort Air.
-- A real company that merely has no plan yet (a trial, an unsubscribed shop) therefore can never be converted by a mistyped id.
-- To undo everything 73 / D1 / D2 did, run M3-config/demo/D9-rollback-demo.sql.
--
-- WHAT YOU NEED FIRST
--   * Migration 73-demo-accounts.sql pasted once (this file stops if it was not), and 66-staff-import-override.sql.
--   * The six Clerk organization ids (Clerk dashboard -> Organizations -> each "Demo · ..." organization -> ID, org_...).
--   * The demo login's Clerk user id (Clerk dashboard -> Users -> demo@deepwelltechnology.com -> User ID, user_...).
--   * The demo login must have opened each of the six organizations once (sign in at /app/ and switch to each one), so the
--     app has created the company and recorded the demo login as its admin. D1 checks this and tells you which one is missing.
--
-- HOW TO USE IT
--   1. Paste the six org ids into the six lines marked >>> EDIT <<< below (leave the names as they are).
--   2. Run it on the Neon STAGING branch first. Read the result table: six rows, plan demo, status demo, import open.
--   3. Wait 5 minutes (the app remembers plan details briefly), then create one import key per company (runbook).
-- SAFE TO RUN AGAIN? Yes. It re-applies the same values and moves the loading window to 14 days from now.
-- ============================================================================

DO $demo$
DECLARE
  -- slug | Clerk org id (>>> EDIT <<<) | industry label (customer-facing, exact) | fictional company name | reading pack ('' = the
  -- general default, used for trades the app has no dedicated pack for yet) | feature packs
  v_rows text[][] := ARRAY[
    ARRAY['realestate',  'org_PASTE_REAL_ESTATE_ORG_ID',        'Real Estate',         'Quailbrush Realty Group',           '',           '[]'],
    ARRAY['propmgmt',    'org_PASTE_PROPERTY_MANAGEMENT_ORG_ID', 'Property Management', 'Tallgrass Mesa Property Management', 'property',   '["property"]'],
    ARRAY['hvac',        'org_PASTE_HVAC_ORG_ID',               'HVAC',                'Coppervane Heating & Air',          'hvac',       '["hvac"]'],
    ARRAY['plumbing',    'org_PASTE_PLUMBING_ORG_ID',           'Plumbing',            'Bluegill Plumbing Co.',             'plumbing',   '["plumbing"]'],
    ARRAY['electrical',  'org_PASTE_ELECTRICAL_ORG_ID',         'Electrical',          'Kestrel Line Electric',             'electrical', '["electrical"]'],
    ARRAY['contractors', 'org_PASTE_GENERAL_CONTRACTORS_ORG_ID', 'General Contractors', 'Stonefield & Pike Builders',        '',           '[]']
  ];
  v_days        int := 14;
  v_fmt         text := 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
  v_sonoran     text := 'org_3JZNNONccwrYbVGY5wTekSRN6YZ';   -- Sterling's testing account: never touched
  v_demo_user   text := 'user_PASTE_DEMO_LOGIN_USER_ID';       -- >>> EDIT <<< Clerk user id of demo@deepwelltechnology.com: the ONLY member a demo company may have
  v_name        text;
  v_docs        int;
  r             text[];
  v_id          uuid;
  v_plan        text;
  v_status      text;
  v_stripe      text;
BEGIN
  IF to_regclass('public.demo_seed_documents') IS NULL THEN
    RAISE EXCEPTION 'Nothing was changed. Paste M3-config/73-demo-accounts.sql first.';
  END IF;
  IF v_demo_user LIKE 'user_PASTE_%' OR v_demo_user !~ '^user_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Nothing was changed. Paste the demo login''s Clerk user id (it starts with user_) on the line marked >>> EDIT <<<.';
  END IF;
  FOREACH r SLICE 1 IN ARRAY v_rows LOOP
    IF r[2] LIKE 'org_PASTE_%' OR r[2] !~ '^org_[A-Za-z0-9]+$' THEN
      RAISE EXCEPTION 'Nothing was changed. Paste the Clerk organization id for "%" (it starts with org_).', r[3];
    END IF;
    IF r[2] = v_sonoran THEN
      RAISE EXCEPTION 'Nothing was changed. % is Sonoran Comfort Air (the testing account) and can never be a demo company.', r[2];
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x) FROM unnest(ARRAY[v_rows[1][2], v_rows[2][2], v_rows[3][2], v_rows[4][2], v_rows[5][2], v_rows[6][2]]) x) <> 6 THEN
    RAISE EXCEPTION 'Nothing was changed. Each industry needs its OWN organization (two lines have the same org id).';
  END IF;

  FOREACH r SLICE 1 IN ARRAY v_rows LOOP
    -- no resolve_tenant() here on purpose: D1 never CREATES a company, it only converts one the demo login already opened
    SELECT id, name, plan, billing_status, stripe_customer_id INTO v_id, v_name, v_plan, v_status, v_stripe FROM tenants WHERE clerk_org_id = r[2];
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Nothing was changed. Organization % (%) has not been opened in the app yet. Sign in as the demo login and open it once, then run this again.', r[2], r[3];
    END IF;
    IF v_stripe IS NOT NULL OR (v_plan IS NOT NULL AND v_plan <> 'demo') OR (v_status IS NOT NULL AND v_status <> 'demo') THEN
      RAISE EXCEPTION 'Nothing was changed. Organization % already has a real plan (%) or a Stripe customer; a paying company can never become a demo company.', r[2], v_plan;
    END IF;
    IF v_name IS DISTINCT FROM r[2] AND v_name NOT LIKE 'Demo · %' THEN
      RAISE EXCEPTION 'Nothing was changed. Organization % is recorded as "%", which is not a demo organization (its name must start with "Demo · ").', r[2], v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = v_id AND u.clerk_user_id = v_demo_user AND u.role = 'admin') THEN
      RAISE EXCEPTION 'Nothing was changed. Organization % (%) is not owned by the demo account: the demo login is not its admin.', r[2], r[3];
    END IF;
    IF EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = v_id AND u.clerk_user_id <> v_demo_user) THEN
      RAISE EXCEPTION 'Nothing was changed. Organization % (%) has members other than the demo login, so it is not a demo organization.', r[2], r[3];
    END IF;
    IF v_plan IS DISTINCT FROM 'demo' THEN
      SELECT count(*) INTO v_docs FROM documents d WHERE d.tenant_id = v_id;
      IF v_docs > 0 THEN
        RAISE EXCEPTION 'Nothing was changed. Organization % (%) already holds % document(s) and is not a demo company yet; a real company can never be converted (the nightly reset would delete its paperwork).', r[2], r[3], v_docs;
      END IF;
    END IF;
  END LOOP;

  -- Every listed organization passed every check above: only now is anything changed.
  FOREACH r SLICE 1 IN ARRAY v_rows LOOP
    SELECT id INTO v_id FROM tenants WHERE clerk_org_id = r[2];
    UPDATE tenants
       SET plan = 'demo',
           billing_status = 'demo',
           settings = COALESCE(settings, '{}'::jsonb)
                      || jsonb_build_object('industry', NULLIF(r[5], ''), 'packs', r[6]::jsonb, 'company_name', r[4], 'business_name', r[4]),
           limits = COALESCE(limits, '{}'::jsonb)
                    || jsonb_build_object('demo', COALESCE(limits -> 'demo', '{}'::jsonb)
                                                   || jsonb_build_object('slug', r[1], 'industry', r[3], 'company', r[4], 'wave', 1))
                    || jsonb_build_object('staffImport', jsonb_build_object(
                         'from', to_char(now() AT TIME ZONE 'UTC', v_fmt),
                         'until', to_char((now() + make_interval(days => v_days)) AT TIME ZONE 'UTC', v_fmt),
                         'pages', 5000, 'documents', 500, 'ingestPerMinute', 120, 'ingestPerDay', 5000, 'maxModelCallsPerDay', 5000))
     WHERE id = v_id;
    RAISE NOTICE 'Demo company ready: % (%) -> %', r[3], r[4], r[2];
  END LOOP;
END
$demo$;

-- RESULT: six rows, plan = demo, status = demo, import_open_until in the future.
SELECT t.clerk_org_id, t.limits -> 'demo' ->> 'industry' AS industry, t.settings ->> 'company_name' AS company,
       t.plan, t.billing_status, t.limits -> 'staffImport' ->> 'until' AS import_open_until,
       (SELECT count(*) FROM documents d WHERE d.tenant_id = t.id) AS documents
  FROM tenants t
 WHERE t.plan = 'demo'
 ORDER BY 2;
