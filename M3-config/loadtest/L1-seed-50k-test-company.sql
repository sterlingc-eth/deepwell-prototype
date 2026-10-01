-- ============================================================================
-- L1-seed-50k-test-company.sql  (load test, step 1 of 3)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Builds ONE clearly fake company, "Load Test Company (delete me)", and fills it with realistic made-up records the
-- size of a big customer: about 50,000 documents (service tickets, invoices, warranty certificates, permits,
-- inspection reports, purchase orders ... spread over the last 6 years), their page text, extracted fields
-- (technician, service date, serial number, amounts), about 6,000 customers and 9,000 pieces of equipment, and the
-- links between them. Step 2 (L2) then times the searches and lists the app runs against it.
--
-- PASTE THIS ON A NEON BRANCH, NOT ON main.
--   Create a branch in the Neon console first (a branch is a throwaway copy of the database), choose that branch in the
--   SQL Editor, and only then paste this file. Nothing on main is touched, and the branch can simply be deleted after.
--
-- IT COSTS NOTHING TO RUN: no AI is called, no files are put in storage, nothing is emailed, no job is queued.
-- Every made-up document is already marked finished, so no background job will try to "process" it.
-- The test company has no login (it is not tied to any customer account), so nobody can sign in to it.
--
-- Takes about 1 to 2 minutes (it took about 90 seconds even on a slow in-process test database; the page text and the
-- search indexes are the slow part). If your editor times out part-way, run L3 to clear the half-built company, then run
-- this file again (for a smaller test, change the one number marked below, for example 50000 to 20000).
--
-- SAFE TO RE-RUN? If the test company already exists this file STOPS with a clear message and changes nothing.
-- Run L3-remove-test-company.sql first if you want to start over.
--
-- WHAT YOU NEED FIRST: the normal migrations, up to and including 64-records-search-indexes.sql (63 and 64 matter for
-- speed; L2 tells you if they are missing). This file also leaves a few small helper functions named loadtest_*;
-- L3 removes them.
-- ============================================================================

SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);

-- ---- guard: refuse to run twice / on a database that is missing migrations ------------------------------------------
DO $guard$
DECLARE
  v_missing text;
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE id = '10ad7e57-0000-4000-8000-000000000050'::uuid
                                      OR slug = 'load-test-company-delete-me') THEN
    RAISE EXCEPTION 'The test company already exists in this database. Run L3-remove-test-company.sql first, then run this file again. Nothing was changed.';
  END IF;

  SELECT string_agg(v.t || '.' || v.c, ', ') INTO v_missing
    FROM (VALUES ('documents', 'display_name'), ('documents', 'audience'), ('documents', 'uploaded_by'),
                 ('documents', 'updated_at'), ('document_pages', 'tenant_id'), ('document_pages', 'tsv'),
                 ('entities', 'customer_number'), ('entities', 'customer_id'), ('entities', 'merged_into')) AS v(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns k
                      WHERE k.table_schema = 'public' AND k.table_name = v.t AND k.column_name = v.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'This database is missing migrations the test needs (no column: %). Paste the numbered M3-config files first, then run this again.', v_missing;
  END IF;
END
$guard$;

-- ---- helper functions (removed again by L3) --------------------------------------------------------------------------
-- A repeatable "random" number between 0 and 1 for a given seed: the same input always gives the same output, so the
-- data is identical every time and no random() is needed.
CREATE OR REPLACE FUNCTION loadtest_r(p_seed text, p_salt text) RETURNS float8
LANGUAGE sql IMMUTABLE AS $$
  SELECT (hashtext(p_salt || ':' || p_seed) & 2147483647)::float8 / 2147483648.0
$$;

-- Picks one entry of a named list using a 0..1 number.
CREATE OR REPLACE FUNCTION loadtest_pick(p_list text, p_x float8) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT s.a[1 + floor(p_x * array_length(s.a, 1))::int]
    FROM (SELECT CASE p_list
      WHEN 'first' THEN ARRAY['James','Maria','Robert','Linda','Michael','Patricia','David','Jennifer','Carlos','Susan','Daniel','Angela','Kevin','Rosa','Brian','Nicole','Jose','Karen','Eric','Teresa','Marcus','Heather','Anthony','Denise','Raymond','Yolanda','Gregory','Shannon','Victor','Tanya','Dennis','Monica','Walter','Brenda','Luis','Cheryl','Frank','Alicia','Roger','Priscilla','Hector','Lorraine','Dale','Imelda','Glenn','Beatrice','Travis','Rochelle','Armando','Felicia','Curtis','Gloria','Neil','Wendy','Omar','Sandra','Rick','Marlene','Tyrone','Paula']
      WHEN 'last' THEN ARRAY['Whitmore','Quintanilla','Castellanos','Okafor','Lindgren','Brewster','Alvarado','Nakamura','Hutchinson','Delgado','Pemberton','Ramirez','Kowalski','Sandoval','Fitzgerald','Montoya','Thibodeaux','Gallegos','Abernathy','Villanueva','Strickland','Ochoa','Hargrove','Espinoza','Blackwell','Zimmerman','Navarro','Cavanaugh','Mendoza','Lockhart','Ibarra','Pritchard','Salazar','Whitaker','Barajas','Ostrander','Coronado','Bellamy','Rivas','Dunleavy','Escobar','Prescott','Valdez','Hollis','Cisneros','Ledbetter','Maldonado','Carrington','Beltran','Thornton','Aguirre','Winslow','Montgomery','Reyes','Garrison','Tafoya','Mckinney','Duran','Sutherland','Pacheco','Langston','Ybarra','Hendricks','Nunez','Fairbanks','Corral','Bridges','Soto','Harlan','Contreras','Kessler','Orozco','Pickett','Trujillo','Haverty','Arellano','Stanton','Bustamante','Rowland']
      WHEN 'biz1' THEN ARRAY['Desert','Sunrise','Copper State','Saguaro','Canyon','Valley','Superstition','Red Mountain','Sonoran','Ironwood','Palo Verde','Mesa Grande']
      WHEN 'biz2' THEN ARRAY['Dental Group','Realty','Bakery','Auto Repair','Community Church','Elementary School','Apartments','Veterinary Clinic','Law Office','Fitness Center','Self Storage','Medical Plaza','Property Management','Credit Union']
      WHEN 'street' THEN ARRAY['Saguaro Vista','Whitmore','Main','Ocotillo','Brownstone','Mesquite','Baseline','Sossaman','Higley','Power','McKellips','Southern','Stapley','Alma School','Dobson','Country Club','Val Vista','Lindsay','Greenfield','Ellsworth','Desert Willow','Palo Brea','Agave','Cholla','Prickly Pear','Sunrise Canyon','Red Rock','Camelback','Thunderbird','Shea','Indian School','Arrowhead','Cactus','Bell','Peoria','Olive','Union Hills','Happy Valley','Pinnacle Peak','Dynamite']
      WHEN 'suffix' THEN ARRAY['St','Ave','Dr','Ln','Way','Blvd','Ct','Rd','Pl']
      WHEN 'city' THEN ARRAY['Mesa, AZ 85201','Mesa, AZ 85204','Mesa, AZ 85210','Gilbert, AZ 85233','Gilbert, AZ 85296','Chandler, AZ 85224','Chandler, AZ 85286','Tempe, AZ 85281','Tempe, AZ 85283','Scottsdale, AZ 85251','Scottsdale, AZ 85260','Phoenix, AZ 85016','Phoenix, AZ 85032','Queen Creek, AZ 85142','Apache Junction, AZ 85119','Glendale, AZ 85308']
      WHEN 'brand' THEN ARRAY['Carrier','Trane','Lennox','Rheem','Goodman','York','Daikin','American Standard','Bryant','Ruud']
      WHEN 'modelpfx' THEN ARRAY['24ACC6','4TTR4','XC21-','RA20','GSX14','YC2D','DX18','4A7A','113A','UA17']
      WHEN 'etype' THEN ARRAY['Condenser','Heat pump','Furnace','Air handler','Package unit','Mini split']
      WHEN 'refrig' THEN ARRAY['R-410A','R-410A','R-410A','R-22','R-32','R-454B']
      WHEN 'tons' THEN ARRAY['1.5','2','2.5','3','3.5','4','5']
      WHEN 'tech' THEN ARRAY['Marisol Quintanilla','Dewayne Pruitt','Rafael Okonkwo','Tamsin Beaumont','Gideon Vasquez','Priyanka Raghunathan','Luther Beckwith','Odalys Fontaine']
      WHEN 'complaint' THEN ARRAY['no cooling, unit running','refrigerant leak at evaporator coil','furnace short cycling','thermostat blank, no power','condenser fan not spinning','ice on suction line','water leak from air handler drain pan','loud rattling noise from outdoor unit','breaker tripping when compressor starts','weak airflow upstairs','annual maintenance and filter change','heat pump stuck in defrost','capacitor failure suspected','high head pressure alarm','no heat, ignition lockout','customer reports odd smell at startup']
      WHEN 'work' THEN ARRAY['replaced dual run capacitor and tested compressor amp draw','located and repaired refrigerant leak, evacuated and recharged system','cleaned condenser coil and checked superheat and subcooling','replaced contactor and inspected wiring','cleared condensate drain line and treated pan','replaced blower motor and wheel','replaced flame sensor and cleaned burners','installed new thermostat and verified staging','replaced condenser fan motor','flushed coil, replaced filter drier','performed full seasonal tune-up and filter change','replaced hot surface igniter','reset defrost board and replaced sensor','brazed leak at service valve, nitrogen pressure test','replaced TXV and recharged to nameplate','tightened electrical connections and replaced breaker']
      WHEN 'part' THEN ARRAY['run capacitor 45/5 MFD','contactor 30A 24V','condenser fan motor 1/4 HP','flame sensor','hot surface igniter','blower motor 1/2 HP','TXV valve','filter drier','R-410A refrigerant','programmable thermostat','defrost control board','condensate float switch','16x25x1 filters','service valve core','inducer motor','transformer 40VA']
      WHEN 'note' THEN ARRAY['Unit is operating normally after repair.','Recommended follow-up visit in 30 days.','Customer was home and approved the work before it started.','Access to the attic was tight; used the rear hatch.','System was last serviced over two years ago.','Noted corrosion on the condenser cabinet.','Filter was badly clogged on arrival.','Customer asked about a maintenance plan.','Drain line was partially blocked with algae.','Voltage at the disconnect checked and within range.']
      WHEN 'rec' THEN ARRAY['Replace the air filter every 60 days.','Consider a surge protector for the outdoor unit.','Schedule a spring tune-up before the cooling season.','Budget for replacement within two to three years.','Install a float switch on the secondary drain pan.','Seal and insulate the exposed supply duct.','Upgrade to a communicating thermostat.','No further action needed.','Add a hard-start kit if compressor stalls again.','Clean the evaporator coil at next visit.']
      WHEN 'terms' THEN ARRAY['Payment due net 30 days from invoice date.','Parts warranty 90 days, labor warranty 30 days unless the manufacturer states otherwise.','Past due balances are subject to a 1.5 percent monthly service charge.','Customer authorizes the work described above.','Manufacturer warranty requires registration within 60 days of installation.','Refrigerant is billed by the pound at the rate in effect on the date of service.','Equipment remains the property of the contractor until paid in full.','Estimates are valid for 30 days.']
      WHEN 'vendor' THEN ARRAY['Ferguson Supply','Johnstone Supply','Watsco','Grainger','Gensco','United Refrigeration']
      WHEN 'subject' THEN ARRAY['quote request','warranty question','invoice question','scheduling a visit','permit status','follow-up on repair']
    END AS a) s
$$;

-- ---- the fake company ------------------------------------------------------------------------------------------------
-- plan 'fleet' + testAccount: no document or page cap applies. clerk_org_id is NULL, so no login can reach it and the
-- nightly sweep (which lists companies by clerk_org_id) never visits it.
-- >>> The ONLY number to change if you want a smaller or bigger test is the 50000 on the SELECT line below. <<<
INSERT INTO tenants (id, name, slug, clerk_org_id, plan, billing_status, limits, settings)
SELECT '10ad7e57-0000-4000-8000-000000000050'::uuid, 'Load Test Company (delete me)', 'load-test-company-delete-me', NULL,
       'fleet', 'active', '{"testAccount": true, "maxModelCallsPerDay": 0}'::jsonb,
       jsonb_build_object('loadtest', true, 'docs', d.n, 'customers', d.n * 12 / 100, 'units', d.n * 18 / 100)
  FROM (SELECT 50000 AS n) d;

-- ---- customers (about 12 per 100 documents) ---------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);
INSERT INTO entities (id, tenant_id, entity_type, data, customer_number, created_at, updated_at)
SELECT md5('lt37-cust-' || s.c)::uuid, '10ad7e57-0000-4000-8000-000000000050'::uuid, 'customer',
       jsonb_build_object(
         'customer_name', s.cname,
         'service_address', s.addr,
         'phone', '(480) 555-' || lpad((1000 + floor(loadtest_r(s.c::text, 'ph') * 8999))::int::text, 4, '0'),
         'email', lower(regexp_replace(s.cname, '[^A-Za-z]+', '.', 'g')) || s.c || '@example.com'),
       'C-' || lpad(s.c::text, 5, '0'), s.ts, s.ts
  FROM (
    SELECT c,
           CASE WHEN loadtest_r(c::text, 'biz') < 0.18
                THEN loadtest_pick('biz1', loadtest_r(c::text, 'b1')) || ' ' || loadtest_pick('biz2', loadtest_r(c::text, 'b2'))
                ELSE loadtest_pick('first', loadtest_r(c::text, 'fn')) || ' ' || loadtest_pick('last', loadtest_r(c::text, 'ln')) END AS cname,
           (100 + floor(loadtest_r(c::text, 'hn') * 9800))::int || ' ' || loadtest_pick('street', loadtest_r(c::text, 'st')) || ' '
             || loadtest_pick('suffix', loadtest_r(c::text, 'sf')) || ', ' || loadtest_pick('city', loadtest_r(c::text, 'ct')) AS addr,
           now() - make_interval(mins => floor(power(loadtest_r(c::text, 'cts'), 1.3) * 6 * 365 * 1440)::int) AS ts
      FROM generate_series(1, (SELECT (settings->>'customers')::int FROM tenants WHERE id = '10ad7e57-0000-4000-8000-000000000050')) c
  ) s;

-- ---- equipment (about 18 per 100 documents), each owned by a customer ------------------------------------------------
SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);
INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, created_at, updated_at)
SELECT md5('lt37-unit-' || s.u)::uuid, '10ad7e57-0000-4000-8000-000000000050'::uuid, 'equipment',
       jsonb_build_object(
         'manufacturer', s.brand,
         'model', s.model,
         'serial_number', s.serial,
         'equipment_type', s.etype,
         'tonnage', s.tons,
         'refrigerant', s.refrig,
         'service_address', cu.data->>'service_address',
         'customer_name', cu.data->>'customer_name',
         'installation_date', to_char(s.inst, 'YYYY-MM-DD'),
         'warranty', jsonb_build_object(
            'registered', s.registered,
            'termYears', CASE WHEN s.registered THEN 10 ELSE 5 END,
            'expires', to_char(s.inst + make_interval(years => CASE WHEN s.registered THEN 10 ELSE 5 END), 'YYYY-MM-DD'),
            'expiresBasis', 'computed')),
       cu.id, s.inst::timestamptz, s.inst::timestamptz
  FROM (
    SELECT u,
           loadtest_pick('brand', loadtest_r(u::text, 'br')) AS brand,
           loadtest_pick('modelpfx', loadtest_r(u::text, 'br')) || lpad(floor(loadtest_r(u::text, 'md') * 999)::int::text, 3, '0')
             || chr(65 + floor(loadtest_r(u::text, 'ms') * 26)::int) || lpad(floor(loadtest_r(u::text, 'm2') * 99)::int::text, 3, '0') AS model,
           chr(65 + floor(loadtest_r(u::text, 's1') * 26)::int) || lpad(floor(loadtest_r(u::text, 'sy') * 15)::int::text, 2, '0')
             || chr(65 + floor(loadtest_r(u::text, 's2') * 26)::int) || lpad(u::text, 6, '0') AS serial,
           loadtest_pick('etype', loadtest_r(u::text, 'et')) AS etype,
           loadtest_pick('tons', loadtest_r(u::text, 'tn')) AS tons,
           loadtest_pick('refrig', loadtest_r(u::text, 'rf')) AS refrig,
           (current_date - floor(power(loadtest_r(u::text, 'inst'), 1.2) * 14 * 365)::int) AS inst,
           loadtest_r(u::text, 'reg') < 0.6 AS registered,
           md5('lt37-cust-' || (1 + floor(nc.n * power(loadtest_r(u::text, 'oc'), 1.4))::int))::uuid AS cust_id
      FROM (SELECT (settings->>'customers')::int AS n, (settings->>'units')::int AS nu
              FROM tenants WHERE id = '10ad7e57-0000-4000-8000-000000000050') nc,
           generate_series(1, nc.nu) u
  ) s
  JOIN entities cu ON cu.id = s.cust_id;

-- ---- documents, their links to customers / equipment, extracted fields and page text -------------------------------
-- Done in slices of 5,000 documents so no single step has to hold everything in memory. Within a slice one statement
-- creates every document together with its links, fields and pages. Rows get ids derived from the document number
-- (md5), which is what lets the pieces point at each other without a lookup.
SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);
DO $docs$
DECLARE
  c_tenant constant uuid := '10ad7e57-0000-4000-8000-000000000050';
  c_slice constant int := 5000;
  v_total int;
  v_lo int := 1;
  v_hi int;
  v_done bigint;
BEGIN
  PERFORM set_config('app.tenant_id', c_tenant::text, false);
  SELECT (settings->>'docs')::int INTO v_total FROM tenants WHERE id = c_tenant;
  WHILE v_lo <= v_total LOOP
    v_hi := least(v_lo + c_slice - 1, v_total);
    WITH cfg AS (
      SELECT (settings->>'customers')::int AS nc, (settings->>'units')::int AS nu
        FROM tenants WHERE id = c_tenant
    ),
    q AS (
      -- one row per document: what kind it is, when it was scanned, and which equipment / customer it is about
      SELECT g, md5('lt37-doc-' || g)::uuid AS doc_id,
             t.dtype,
             now() - make_interval(mins => floor(power(loadtest_r(g::text, 'ts'), 1.25) * 6 * 365 * 1440)::int) AS created_at,
             CASE WHEN loadtest_r(g::text, 'stg') < 0.72 THEN 'verified' WHEN loadtest_r(g::text, 'stg') < 0.84 THEN 'linked'
                  WHEN loadtest_r(g::text, 'stg') < 0.93 THEN 'mapped' ELSE 'read' END AS stage,
             CASE WHEN t.wants_unit THEN md5('lt37-unit-' || (1 + floor(cfg.nu * power(loadtest_r(g::text, 'un'), 1.5))::int))::uuid END AS u_ref,
             CASE WHEN t.wants_cust THEN md5('lt37-cust-' || (1 + floor(cfg.nc * power(loadtest_r(g::text, 'cu'), 1.5))::int))::uuid END AS c_ref,
             CASE WHEN loadtest_r(g::text, 'pg') < 0.15 THEN 3 WHEN loadtest_r(g::text, 'pg') < 0.45 THEN 2 ELSE 1 END AS page_count
        FROM cfg, generate_series(v_lo, v_hi) g
        CROSS JOIN LATERAL (
          SELECT x.dtype,
                 (x.dtype IN ('service-ticket','work-order','warranty-registration','startup-sheet','nameplate-photo','dispatch-note','inspection-report')
                  OR (x.dtype = 'invoice' AND loadtest_r(g::text, 'iu') < 0.55)
                  OR (x.dtype = 'maintenance-agreement' AND loadtest_r(g::text, 'au') < 0.5)
                  OR (x.dtype = 'proposal-quote' AND loadtest_r(g::text, 'qu') < 0.3)
                  OR (x.dtype = 'permit' AND loadtest_r(g::text, 'pu') < 0.2)) AS wants_unit,
                 (x.dtype IN ('service-ticket','work-order','warranty-registration','startup-sheet','nameplate-photo','dispatch-note','inspection-report',
                              'invoice','maintenance-agreement','proposal-quote','permit')
                  OR (x.dtype = 'correspondence' AND loadtest_r(g::text, 'cc') < 0.7)) AS wants_cust
            FROM (SELECT CASE
                    WHEN loadtest_r(g::text, 'ty') < 0.26 THEN 'service-ticket'
                    WHEN loadtest_r(g::text, 'ty') < 0.44 THEN 'invoice'
                    WHEN loadtest_r(g::text, 'ty') < 0.54 THEN 'work-order'
                    WHEN loadtest_r(g::text, 'ty') < 0.60 THEN 'warranty-registration'
                    WHEN loadtest_r(g::text, 'ty') < 0.64 THEN 'permit'
                    WHEN loadtest_r(g::text, 'ty') < 0.71 THEN 'inspection-report'
                    WHEN loadtest_r(g::text, 'ty') < 0.77 THEN 'purchase-order'
                    WHEN loadtest_r(g::text, 'ty') < 0.81 THEN 'startup-sheet'
                    WHEN loadtest_r(g::text, 'ty') < 0.86 THEN 'proposal-quote'
                    WHEN loadtest_r(g::text, 'ty') < 0.89 THEN 'maintenance-agreement'
                    WHEN loadtest_r(g::text, 'ty') < 0.92 THEN 'dispatch-note'
                    WHEN loadtest_r(g::text, 'ty') < 0.94 THEN 'nameplate-photo'
                    WHEN loadtest_r(g::text, 'ty') < 0.97 THEN 'correspondence'
                    WHEN loadtest_r(g::text, 'ty') < 0.99 THEN 'internal'
                    ELSE 'other' END AS dtype) x
        ) t
    ),
    pl AS MATERIALIZED (
      -- the same rows with the linked equipment and customer filled in, and every text value the documents need
      SELECT q.*, ue.id AS u_id, ce.id AS c_id,
             ce.data->>'customer_name' AS cname, ce.data->>'service_address' AS caddr,
             ue.data->>'manufacturer' AS brand, ue.data->>'model' AS model, ue.data->>'serial_number' AS serial,
             ue.data->>'equipment_type' AS etype, ue.data->>'tonnage' AS tons, ue.data->>'refrigerant' AS refrig,
             ue.data->>'installation_date' AS inst,
             CASE WHEN q.dtype IN ('service-ticket','work-order','dispatch-note','startup-sheet','inspection-report','invoice','maintenance-agreement')
                       AND loadtest_r(q.g::text, 'tc') < 0.85
                  THEN loadtest_pick('tech', loadtest_r(q.g::text, 'tech')) END AS tech,
             to_char(q.created_at::date - floor(loadtest_r(q.g::text, 'sd') * 6)::int, 'YYYY-MM-DD') AS sdate,
             CASE WHEN q.dtype IN ('invoice','proposal-quote','purchase-order','maintenance-agreement')
                  THEN round((150 + power(loadtest_r(q.g::text, 'amt'), 3) * 9000)::numeric, 2) END AS amount,
             loadtest_r(q.g::text, 'gen') < 0.18 AS generic_name
        FROM q
        LEFT JOIN entities ue ON ue.id = q.u_ref
        LEFT JOIN entities ce ON ce.id = COALESCE(ue.customer_id, q.c_ref)
    ),
    pn AS MATERIALIZED (
      -- file name, display name and number printed on each document
      SELECT pl.*,
             CASE pl.dtype WHEN 'service-ticket' THEN 'ST-' || (10000 + g) WHEN 'work-order' THEN 'WO-' || (30000 + g)
                           WHEN 'invoice' THEN 'INV-' || (20000 + g) WHEN 'purchase-order' THEN 'PO-' || (7000 + g)
                           WHEN 'permit' THEN 'PRM-' || to_char(created_at, 'YY') || '-' || lpad(g::text, 6, '0')
                           WHEN 'proposal-quote' THEN 'Q-' || (5000 + g) WHEN 'maintenance-agreement' THEN 'MA-' || (800 + g)
                           WHEN 'dispatch-note' THEN 'DSP-' || (60000 + g) ELSE 'DOC-' || g END AS docno,
             COALESCE(regexp_replace(cname, '^\S+\s+', ''), 'Unassigned') AS cshort
        FROM pl
    ),
    dn AS MATERIALIZED (
      SELECT pn.*,
             CASE WHEN generic_name THEN
                    CASE g % 3 WHEN 0 THEN 'scan' || lpad(g::text, 5, '0') || '.pdf'
                               WHEN 1 THEN 'IMG_' || (1000 + g % 9000) || '.jpg'
                               ELSE 'Scan ' || to_char(created_at, 'YYYY-MM-DD') || ' ' || lpad((g % 2400)::text, 4, '0') || '.pdf' END
                  ELSE CASE dtype
                    WHEN 'service-ticket' THEN 'Service Ticket ' || docno || ' - ' || cshort || '.pdf'
                    WHEN 'work-order' THEN 'Work Order ' || docno || ' ' || cshort || '.pdf'
                    WHEN 'invoice' THEN docno || ' ' || cshort || '.pdf'
                    WHEN 'warranty-registration' THEN 'Warranty Certificate - ' || COALESCE(brand || ' ' || serial, cshort) || '.pdf'
                    WHEN 'permit' THEN 'Permit ' || docno || ' ' || loadtest_pick('street', loadtest_r(g::text, 'pst')) || '.pdf'
                    WHEN 'inspection-report' THEN 'Inspection Report ' || to_char(created_at, 'YYYY-MM') || ' ' || cshort || '.pdf'
                    WHEN 'purchase-order' THEN docno || ' ' || loadtest_pick('vendor', loadtest_r(g::text, 'vn')) || '.pdf'
                    WHEN 'startup-sheet' THEN 'Startup Sheet ' || COALESCE(brand, 'unit') || ' ' || cshort || '.pdf'
                    WHEN 'proposal-quote' THEN 'Proposal ' || docno || ' ' || cshort || '.pdf'
                    WHEN 'maintenance-agreement' THEN 'Maintenance Agreement ' || cshort || ' ' || to_char(created_at, 'YYYY') || '.pdf'
                    WHEN 'dispatch-note' THEN 'Dispatch ' || docno || ' ' || to_char(created_at, 'MM-DD') || '.pdf'
                    WHEN 'nameplate-photo' THEN 'Nameplate ' || COALESCE(brand, 'unit') || ' ' || (g % 900) || '.jpg'
                    WHEN 'correspondence' THEN 'Email - ' || cshort || ' re ' || loadtest_pick('subject', loadtest_r(g::text, 'sj')) || '.pdf'
                    WHEN 'internal' THEN 'Shop note ' || to_char(created_at, 'YYYY-MM-DD') || '.pdf'
                    ELSE 'Document ' || g || '.pdf' END END AS fname
        FROM pn
    ),
    d AS (
      INSERT INTO documents (id, tenant_id, batch_id, original_filename, document_type, sha256_hash, file_size_bytes, stage,
                             created_at, processed_at, storage_key, content_type, page_count, extracted_at, verified_by,
                             verified_at, updated_at, uploaded_by, display_name, display_name_source, display_name_updated_at,
                             audience, assigned_tech_name)
      SELECT doc_id, '10ad7e57-0000-4000-8000-000000000050'::uuid,
             CASE WHEN loadtest_r(g::text, 'bt') < 0.35 THEN md5('lt37-batch-' || (g / 25))::uuid END,
             fname, dtype, md5('lt37-sha-' || g) || md5('lt37-sha2-' || g),
             (60000 + floor(loadtest_r(g::text, 'sz') * 2400000))::int, stage,
             created_at, created_at + interval '2 minutes',
             '10ad7e57-0000-4000-8000-000000000050/loadtest/' || g || CASE WHEN fname ~ '\.jpe?g$' THEN '.jpg' ELSE '.pdf' END,
             CASE WHEN fname ~ '\.jpe?g$' THEN 'image/jpeg' ELSE 'application/pdf' END,
             page_count, created_at + interval '1 minute',
             CASE WHEN stage = 'verified' THEN 'loadtest' END, CASE WHEN stage = 'verified' THEN created_at + interval '1 day' END,
             created_at + interval '1 day',
             'user_loadtest_' || (1 + g % 5),
             CASE WHEN loadtest_r(g::text, 'dn') < 0.75
                  THEN initcap(replace(dtype, '-', ' ')) || ' - ' || cshort || ' - ' || to_char(sdate::date, 'Mon FMDD, YYYY') END,
             CASE WHEN loadtest_r(g::text, 'dn') < 0.70 THEN 'auto' WHEN loadtest_r(g::text, 'dn') < 0.75 THEN 'user' END,
             CASE WHEN loadtest_r(g::text, 'dn') < 0.75 THEN created_at + interval '1 day' END,
             CASE WHEN dtype = 'internal' THEN 'internal' ELSE 'customer' END,
             tech
        FROM dn
      RETURNING 1
    ),
    lnk AS (
      INSERT INTO document_entity_links (id, tenant_id, document_id, entity_id, confidence, linked_by, created_at)
      SELECT md5('lt37-lnk-' || g || '-' || k.kind)::uuid, '10ad7e57-0000-4000-8000-000000000050'::uuid, doc_id, k.eid,
             round((0.80 + loadtest_r(g::text, 'lc') * 0.19)::numeric, 3), CASE WHEN stage = 'verified' THEN 'human' ELSE 'ai' END, created_at
        FROM dn CROSS JOIN LATERAL (VALUES ('c', c_id), ('u', u_id)) k(kind, eid)
       WHERE k.eid IS NOT NULL
      RETURNING 1
    ),
    ext AS (
      INSERT INTO extractions (id, tenant_id, document_id, entity_id, field_key, value, confidence, created_at)
      SELECT md5('lt37-ext-' || g || '-' || k.fk)::uuid, '10ad7e57-0000-4000-8000-000000000050'::uuid, doc_id, k.eid, k.fk, k.val,
             round((0.70 + loadtest_r(g::text || k.fk, 'xc') * 0.29)::numeric, 3), created_at
        FROM dn CROSS JOIN LATERAL (VALUES
               ('technician', tech, NULL::uuid),
               ('service_date', CASE WHEN dtype IN ('service-ticket','work-order','dispatch-note','startup-sheet','inspection-report','invoice') THEN sdate END, u_id),
               ('serial_number', serial, u_id),
               ('customer_name', cname, NULL::uuid),
               ('total_amount', amount::text, NULL::uuid)) k(fk, val, eid)
       WHERE k.val IS NOT NULL
      RETURNING 1
    ),
    pg AS (
      INSERT INTO document_pages (id, document_id, page_no, r2_path, tenant_id, text, created_at)
      SELECT md5('lt37-page-' || g || '-' || n.n)::uuid, doc_id, n.n, 'loadtest/' || g || '/page-' || n.n || '.png',
             '10ad7e57-0000-4000-8000-000000000050'::uuid,
             CASE n.n
               WHEN 1 THEN concat_ws(E'\n',
                 'Ironwood Comfort Service Co. - Heating, Cooling and Refrigeration - Mesa, Arizona',
                 upper(replace(dtype, '-', ' ')) || ' ' || docno,
                 'Customer: ' || cname,
                 'Service address: ' || caddr,
                 CASE WHEN serial IS NOT NULL THEN 'Equipment: ' || etype || ', ' || brand || ' model ' || model || ', serial number ' || serial || ', ' || tons || ' ton, ' || refrig END,
                 CASE dtype
                   WHEN 'service-ticket' THEN concat_ws(E'\n', 'Date of service: ' || sdate, 'Technician: ' || tech,
                        'Reported problem: ' || loadtest_pick('complaint', loadtest_r(g::text, 'cmp')),
                        'Work performed: ' || loadtest_pick('work', loadtest_r(g::text, 'wrk')),
                        'Parts used: ' || loadtest_pick('part', loadtest_r(g::text, 'prt')))
                   WHEN 'work-order' THEN concat_ws(E'\n', 'Scheduled for: ' || sdate, 'Assigned technician: ' || tech,
                        'Scope: ' || loadtest_pick('complaint', loadtest_r(g::text, 'cmp')),
                        'Authorized work: ' || loadtest_pick('work', loadtest_r(g::text, 'wrk')))
                   WHEN 'dispatch-note' THEN concat_ws(E'\n', 'Dispatched: ' || sdate, 'Technician: ' || tech,
                        'Call reason: ' || loadtest_pick('complaint', loadtest_r(g::text, 'cmp')), 'Priority: ' || CASE WHEN loadtest_r(g::text, 'pri') < 0.2 THEN 'emergency no cooling' ELSE 'routine' END)
                   WHEN 'invoice' THEN concat_ws(E'\n', 'Invoice date: ' || sdate, 'Technician: ' || tech,
                        'Description: ' || loadtest_pick('work', loadtest_r(g::text, 'wrk')),
                        'Parts: ' || loadtest_pick('part', loadtest_r(g::text, 'prt')),
                        'Labor: $' || round(amount * 0.45, 2), 'Parts and materials: $' || round(amount * 0.55, 2), 'Total due: $' || amount,
                        'Terms: net 30')
                   WHEN 'warranty-registration' THEN concat_ws(E'\n', 'WARRANTY CERTIFICATE', 'Installation date: ' || inst,
                        'Registered owner: ' || cname, 'Parts warranty: 10 years when registered within 60 days, otherwise 5 years',
                        'Labor warranty: 1 year', 'Registration confirmation: WR-' || lpad(g::text, 7, '0'))
                   WHEN 'permit' THEN concat_ws(E'\n', 'City of Mesa Development Services - Mechanical permit', 'Permit number: ' || docno,
                        'Scope: replace ' || lower(COALESCE(etype, 'condenser and air handler')) || ' and verify duct sizing', 'Valuation: $' || round((2500 + loadtest_r(g::text, 'val') * 14000)::numeric, 0),
                        'Final inspection required before the system is put in service.')
                   WHEN 'inspection-report' THEN concat_ws(E'\n', 'Annual HVAC inspection', 'Inspection date: ' || sdate, 'Inspector: ' || tech,
                        'Finding: ' || loadtest_pick('note', loadtest_r(g::text, 'nt')),
                        'Refrigerant pressures within range: ' || CASE WHEN loadtest_r(g::text, 'rp') < 0.9 THEN 'yes' ELSE 'no, refrigerant leak suspected' END,
                        'Overall condition: ' || CASE WHEN loadtest_r(g::text, 'oc2') < 0.6 THEN 'good' WHEN loadtest_r(g::text, 'oc2') < 0.9 THEN 'fair' ELSE 'poor' END)
                   WHEN 'purchase-order' THEN concat_ws(E'\n', 'Vendor: ' || loadtest_pick('vendor', loadtest_r(g::text, 'vn')),
                        'Ship to: Ironwood Comfort Service Co. warehouse', 'Item: ' || loadtest_pick('part', loadtest_r(g::text, 'prt')) || ' x ' || (1 + floor(loadtest_r(g::text, 'qty') * 20))::int,
                        'Order total: $' || amount, 'Requested by: ' || loadtest_pick('tech', loadtest_r(g::text, 'tech')))
                   WHEN 'startup-sheet' THEN concat_ws(E'\n', 'NEW SYSTEM STARTUP CHECKLIST', 'Startup date: ' || sdate, 'Technician: ' || tech,
                        'Suction pressure: ' || (105 + floor(loadtest_r(g::text, 'sp') * 20))::int || ' psig', 'Superheat: ' || (6 + floor(loadtest_r(g::text, 'sh') * 8))::int || ' F',
                        'Subcooling: ' || (8 + floor(loadtest_r(g::text, 'sc') * 6))::int || ' F', 'Delta T across coil: ' || (16 + floor(loadtest_r(g::text, 'dt') * 6))::int || ' F')
                   WHEN 'proposal-quote' THEN concat_ws(E'\n', 'Option: replace system with new high efficiency equipment, includes permit, labor and 10 year parts warranty',
                        'Quoted price: $' || amount, 'Financing available. This quote is valid for 30 days.')
                   WHEN 'maintenance-agreement' THEN concat_ws(E'\n', 'Two service visits per year, spring cooling check and fall heating check',
                        'Term: 12 months from ' || sdate, 'Annual price: $' || amount, 'Includes priority scheduling and a discount on repairs.')
                   WHEN 'nameplate-photo' THEN concat_ws(E'\n', 'NAMEPLATE', 'MODEL NO. ' || model, 'SERIAL NO. ' || serial, 'REFRIGERANT ' || refrig, 'FACTORY CHARGE ' || (60 + floor(loadtest_r(g::text, 'chg') * 140))::int || ' OZ', 'VOLTS 208/230 PH 1 HZ 60')
                   WHEN 'correspondence' THEN concat_ws(E'\n', 'From: ' || cname, 'Subject: ' || loadtest_pick('subject', loadtest_r(g::text, 'sj')),
                        'Hello, I am writing about the service at ' || caddr || '. ' || loadtest_pick('complaint', loadtest_r(g::text, 'cmp')) || '. Please call me back this week.')
                   WHEN 'internal' THEN concat_ws(E'\n', 'SHOP NOTE', 'Reminder for the office: ' || loadtest_pick('rec', loadtest_r(g::text, 'rec')), 'Posted by ' || loadtest_pick('tech', loadtest_r(g::text, 'tech')))
                   ELSE concat_ws(E'\n', 'Miscellaneous paperwork', loadtest_pick('note', loadtest_r(g::text, 'nt')))
                 END)
               WHEN 2 THEN concat_ws(E'\n',
                 'Page 2 of ' || page_count || ' - ' || docno,
                 'Customer: ' || cname,
                 'Notes: ' || loadtest_pick('note', loadtest_r(g::text, 'nt')),
                 'Recommendation: ' || loadtest_pick('rec', loadtest_r(g::text, 'rec')),
                 CASE WHEN serial IS NOT NULL THEN 'Unit ' || serial || ' last serviced ' || sdate END,
                 CASE WHEN amount IS NOT NULL THEN 'Subtotal: $' || round(amount * 0.93, 2) || '  Tax: $' || round(amount * 0.07, 2) || '  Total: $' || amount END,
                 'Technician: ' || tech)
               ELSE concat_ws(E'\n',
                 'Page 3 of ' || page_count || ' - ' || docno,
                 loadtest_pick('terms', loadtest_r(g::text, 'tm')),
                 'Customer signature on file: ' || cname || ', ' || sdate,
                 'Thank you for choosing Ironwood Comfort Service Co.')
             END,
             created_at
        FROM dn CROSS JOIN LATERAL generate_series(1, dn.page_count) n(n)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM d) INTO v_done;
    v_lo := v_hi + 1;
  END LOOP;
END
$docs$;

-- ---- let Postgres learn the table sizes (a real database does this on its own after a big import; without it the next
--      step can pick a very slow plan) ----------------------------------------------------------------------------------
DO $stats$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'document_pages', 'entities', 'extractions', 'document_entity_links', 'document_financials'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN EXECUTE format('ANALYZE %I', t); END IF;
  END LOOP;
END
$stats$;

-- ---- money rows for invoices / quotes / POs / agreements (skipped if migration 22 was never pasted) ---------------------
SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);
DO $fin$
BEGIN
  IF to_regclass('public.document_financials') IS NULL THEN
    RAISE NOTICE 'document_financials does not exist here (migration 22 not pasted): skipping money rows.';
    RETURN;
  END IF;
  INSERT INTO document_financials (id, tenant_id, document_id, doc_kind, direction, invoice_number, po_number, invoice_date, due_date,
                                   subtotal, tax, total, amount_paid, balance_due, status, customer_name, vendor_name, confidence,
                                   verified_by, verified_at, extracted_at, created_at)
  SELECT md5('lt37-fin-' || d.id)::uuid, d.tenant_id, d.id,
         CASE d.document_type WHEN 'invoice' THEN 'invoice' WHEN 'proposal-quote' THEN 'estimate' WHEN 'purchase-order' THEN 'po' ELSE 'agreement' END,
         CASE WHEN d.document_type = 'purchase-order' THEN 'payable' ELSE 'receivable' END,
         CASE WHEN d.document_type = 'invoice' THEN 'INV-' || (20000 + (regexp_replace(d.storage_key, '^.*/loadtest/(\d+)\..*$', '\1'))::int) END,
         CASE WHEN d.document_type = 'purchase-order' THEN 'PO-' || substr(md5(d.id::text), 1, 6) END,
         d.created_at::date, d.created_at::date + 30,
         t.sub, t.tax, t.sub + t.tax,
         CASE s.st WHEN 'paid' THEN t.sub + t.tax WHEN 'partial' THEN round((t.sub + t.tax) / 2, 2) ELSE 0 END,
         CASE s.st WHEN 'paid' THEN 0 WHEN 'partial' THEN (t.sub + t.tax) - round((t.sub + t.tax) / 2, 2) ELSE t.sub + t.tax END,
         s.st,
         (SELECT e.value FROM extractions e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id AND e.field_key = 'customer_name' LIMIT 1),
         CASE WHEN d.document_type = 'purchase-order' THEN loadtest_pick('vendor', loadtest_r(d.id::text, 'vn')) END,
         0.95, d.verified_by, d.verified_at, d.created_at, d.created_at
    FROM documents d
    CROSS JOIN LATERAL (SELECT round((150 + power(loadtest_r(d.id::text, 'amt'), 3) * 9000)::numeric * 0.93, 2) AS sub) b
    CROSS JOIN LATERAL (SELECT b.sub, round(b.sub * 0.07, 2) AS tax) t
    CROSS JOIN LATERAL (SELECT CASE WHEN loadtest_r(d.id::text, 'pd') < 0.6 THEN 'paid' WHEN loadtest_r(d.id::text, 'pd') < 0.9 THEN 'unpaid' ELSE 'partial' END AS st) s
   WHERE d.tenant_id = '10ad7e57-0000-4000-8000-000000000050'::uuid
     AND d.document_type IN ('invoice', 'proposal-quote', 'purchase-order', 'maintenance-agreement');
  EXECUTE 'ANALYZE document_financials';
END
$fin$;

-- ---- result: what was created ----------------------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '10ad7e57-0000-4000-8000-000000000050', false);
SELECT 'documents' AS what, count(*) AS rows_created FROM documents WHERE tenant_id = '10ad7e57-0000-4000-8000-000000000050'
UNION ALL SELECT 'pages of text', count(*) FROM document_pages WHERE tenant_id = '10ad7e57-0000-4000-8000-000000000050'
UNION ALL SELECT 'extracted fields', count(*) FROM extractions WHERE tenant_id = '10ad7e57-0000-4000-8000-000000000050'
UNION ALL SELECT 'customers', count(*) FROM entities WHERE tenant_id = '10ad7e57-0000-4000-8000-000000000050' AND entity_type = 'customer'
UNION ALL SELECT 'equipment units', count(*) FROM entities WHERE tenant_id = '10ad7e57-0000-4000-8000-000000000050' AND entity_type = 'equipment'
UNION ALL SELECT 'document links', count(*) FROM document_entity_links WHERE tenant_id = '10ad7e57-0000-4000-8000-000000000050';
-- Done. Next: paste L2-time-the-50k-company.sql.
