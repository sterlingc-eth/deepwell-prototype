/**
 * R41 scale queries: proves the faster Customers list and the faster Donovan page search give EXACTLY the answers the old
 * queries gave, with and without M3-config/65 pasted, and that the new database pieces cannot cross shops.
 * PGlite (in-process Postgres, $0) with every M3-config migration applied (65 included) and the app's RLS role; the seed is the
 * owner-pasted load-test file L1 (M3-config/loadtest) at a small size, plus hand-made edge cases. No network, no real
 * Neon / R2 / model / Stripe.
 *
 *   npx tsx scripts/verify-r41-scale-queries.mjs                      # about 1,500 documents, 30 fuzz rounds
 *   R41_DOCS=4000 R41_FUZZ_ROUNDS=80 npx tsx scripts/verify-r41-scale-queries.mjs
 *
 * Families
 *   customers  the ORIGINAL list SQL (copied below, verbatim) vs the store's list with 65 (summary) and without 65 (fallback):
 *              every sort, page, offset (past the end too) and search term; customers with no documents / no units, merged
 *              customers, ties in last activity and in name, a customer with no name; the counts the list shows
 *   fuzz       thousands of random writes through every write path the summary depends on (links, extractions, units,
 *              customers, merges, document deletes, date edits, bulk statements) with the summary compared to the original SQL
 *              after every round
 *   donovan    searchPassages with and without 65 across many questions, serial numbers, the plain-word fallback, scoped and
 *              empty document sets: same ranks, same pages above the tie line, same excerpts
 *   isolation  the new functions and tables called with app.tenant_id unset, set to shop A, set to shop B
 *   rollout    half-pasted / not pasted / pasted twice: the app falls back, never errors, never goes stale
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bootHarness } from './lib/r35Harness.mjs';
import { runFile, LOADTEST_TENANT as T } from './lib/loadtestSql.mjs';
import { makeRng } from './lib/rng.mjs';

const DOCS = Math.trunc(Number(process.env.R41_DOCS ?? 1500)) || 1500;
const FUZZ_ROUNDS = Math.trunc(Number(process.env.R41_FUZZ_ROUNDS ?? 30)) || 30;
const h = await bootHarness();
const { lite, RS, root } = h;

let failed = 0;
let family = 'misc';
const fam = {};
const check = (name, ok, detail = '') => {
  fam[family] ??= { pass: 0, fail: 0 };
  fam[family][ok ? 'pass' : 'fail']++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${family}] ${name}${ok ? '' : detail ? `  -> ${String(detail).slice(0, 600)}` : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const q = async (sql, params) => (await lite.query(sql, params)).rows;
const n1 = async (sql, params) => Number((await q(sql, params))[0].n);
const quiet = async (fn) => { const err = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = err; console.warn = warn; } };

// The harness applies the migrations BEFORE it creates the app role, so 65's grants found nobody to grant to. Do what pasting the
// file into a database that already has the role does.
const GRANT_FNS = `GRANT EXECUTE ON FUNCTION donovan_pages_by_text(text, int, uuid[]), donovan_pages_by_like(text, int, uuid[]),
  customer_activity_refresh(), customer_activity_rebuild() TO deepwell_rls`;
await lite.exec(GRANT_FNS);
const SQL65 = fs.readFileSync(path.join(root, 'M3-config', '65-scale-donovan-and-customers.sql'), 'utf8');
check('65 applied cleanly in the harness', !h.skipped.some((s) => s.startsWith('65-')), h.skipped.join(' | '));

/* ------------------------------------------------------------------------------------------------------------------ seed */
console.log(`\n-- seeding ${DOCS} documents (L1) and edge cases`);
const SHOP = 'org_r41_shop';
const OTHER = 'org_r41_other';
await runFile(lite, 'L1', { docs: DOCS });
await lite.query(`UPDATE tenants SET clerk_org_id = $1 WHERE id = $2`, [SHOP, T]);
const B = await h.newTenant(OTHER, 'shop');
const rng = makeRng(41);
const pick = (a) => a[Math.floor(rng() * a.length)];
const int = (n) => Math.floor(rng() * n);

// Edge cases in shop T
const EC = {
  noDocsNoUnits: '41000000-0000-4000-8000-000000000001', // customer with nothing at all
  nullName: '41000000-0000-4000-8000-000000000002',
  tieA: '41000000-0000-4000-8000-000000000003', // same name + same last activity as tieB
  tieB: '41000000-0000-4000-8000-000000000004',
  merged: '41000000-0000-4000-8000-000000000005',
  survivor: '41000000-0000-4000-8000-000000000006',
  equipOnly: '41000000-0000-4000-8000-000000000007', // documents reach it only through its unit's extracted fields
  unitTie1: '41000000-0000-4000-8000-0000000000a1',
  unitTie2: '41000000-0000-4000-8000-0000000000a2',
  unitOnly: '41000000-0000-4000-8000-0000000000a3',
  unitMerged: '41000000-0000-4000-8000-0000000000a4',
};
await lite.exec(`
  SELECT set_config('app.tenant_id', '${T}', false);
  INSERT INTO entities (id, tenant_id, entity_type, data, customer_number, created_at, updated_at) VALUES
    ('${EC.noDocsNoUnits}', '${T}', 'customer', '{"customer_name":"Zed Nothing Co","service_address":"1 Void Way, Mesa, AZ"}', 'C-90001', now(), now()),
    ('${EC.nullName}', '${T}', 'customer', '{"service_address":"2 Anon Ave, Mesa, AZ"}', 'C-90002', now(), now()),
    ('${EC.tieA}', '${T}', 'customer', '{"customer_name":"Twin Tie","service_address":"3 Twin Ct, Mesa, AZ"}', 'C-90003', now(), now()),
    ('${EC.tieB}', '${T}', 'customer', '{"customer_name":"Twin Tie","service_address":"4 Twin Ct, Mesa, AZ"}', 'C-90004', now(), now()),
    ('${EC.merged}', '${T}', 'customer', '{"customer_name":"Merged Away","service_address":"5 Gone St, Mesa, AZ"}', 'C-90005', now(), now()),
    ('${EC.survivor}', '${T}', 'customer', '{"customer_name":"Merged Survivor","service_address":"5 Gone St, Mesa, AZ"}', 'C-90006', now(), now()),
    ('${EC.equipOnly}', '${T}', 'customer', '{"customer_name":"Equip Only Inc","service_address":"7 Unit Ln, Mesa, AZ"}', 'C-90007', now(), now());
  UPDATE entities SET merged_into = '${EC.survivor}' WHERE id = '${EC.merged}';
  INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, created_at, updated_at) VALUES
    ('${EC.unitTie1}', '${T}', 'equipment', '{"manufacturer":"Trane","model":"TT1","serial_number":"ZZ41A000001","warranty":{"expires":"2030-01-01"}}', '${EC.tieA}', '2024-05-05T00:00:00Z', '2024-05-05T00:00:00Z'),
    ('${EC.unitTie2}', '${T}', 'equipment', '{"manufacturer":"Trane","model":"TT2","serial_number":"ZZ41A000002","warranty":{"expires":"2030-01-01"}}', '${EC.tieB}', '2024-05-05T00:00:00Z', '2024-05-05T00:00:00Z'),
    ('${EC.unitOnly}', '${T}', 'equipment', '{"manufacturer":"Lennox","model":"EO1","serial_number":"ZZ41A000003"}', '${EC.equipOnly}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
    ('${EC.unitMerged}', '${T}', 'equipment', '{"manufacturer":"Carrier","model":"MG1","serial_number":"ZZ41A000004","warranty":null}', '${EC.merged}', '2021-02-02T00:00:00Z', '2021-02-02T00:00:00Z');
  INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, display_name) VALUES
    ('41000000-0000-4000-8000-0000000000d1', '${T}', 'edge-1.pdf', 'service-ticket', md5('r41e1') || md5('r41e1b'), 'verified', '2031-01-01T00:00:00Z', 'Edge doc 1'),
    ('41000000-0000-4000-8000-0000000000d2', '${T}', 'edge-2.pdf', 'service-ticket', md5('r41e2') || md5('r41e2b'), 'verified', '2019-01-01T00:00:00Z', 'Edge doc 2');
  INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES
    ('${T}', '41000000-0000-4000-8000-0000000000d2', '${EC.unitOnly}', 'serial_number', 'ZZ41A000003', 0.9),
    ('${T}', '41000000-0000-4000-8000-0000000000d2', '${EC.unitOnly}', 'service_date', '2022-03-04', 0.9),
    ('${T}', '41000000-0000-4000-8000-0000000000d2', '${EC.unitOnly}', 'service_date', 'not a date', 0.4),
    ('${T}', '41000000-0000-4000-8000-0000000000d2', '${EC.unitMerged}', 'note', 'on the merged customer''s unit', 0.4);
  INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES
    ('${T}', '41000000-0000-4000-8000-0000000000d1', '${EC.survivor}'),
    ('${T}', '41000000-0000-4000-8000-0000000000d1', '${EC.merged}');
  SELECT set_config('app.tenant_id', '', false);
`);

// shop B: its own small shop, same names as some of A's customers on purpose
await lite.exec(`
  SELECT set_config('app.tenant_id', '${B}', false);
  INSERT INTO entities (id, tenant_id, entity_type, data, customer_number, created_at, updated_at)
    SELECT md5('r41-b-c-' || g)::uuid, '${B}', 'customer', jsonb_build_object('customer_name', 'Twin Tie ' || g, 'service_address', g || ' Elm St'), 'C-' || lpad(g::text, 5, '0'), now(), now() FROM generate_series(1, 25) g;
  INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, created_at, updated_at)
    SELECT md5('r41-b-u-' || g)::uuid, '${B}', 'equipment', jsonb_build_object('manufacturer', 'Goodman', 'model', 'B' || g, 'serial_number', 'BB' || g, 'warranty', jsonb_build_object('expires', '2029-01-01')), md5('r41-b-c-' || (1 + g % 25))::uuid, now() - (g || ' days')::interval, now() - (g || ' days')::interval FROM generate_series(1, 40) g;
  INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, display_name)
    SELECT md5('r41-b-d-' || g)::uuid, '${B}', 'b-' || g || '.pdf', 'invoice', md5('r41b' || g) || md5('r41bb' || g), 'verified', now() - (g || ' hours')::interval, 'B doc ' || g FROM generate_series(1, 60) g;
  INSERT INTO document_pages (document_id, page_no, tenant_id, text)
    SELECT md5('r41-b-d-' || g)::uuid, 1, '${B}', 'Shop B compressor capacitor replaced at the Whitmore property serial BB' || g FROM generate_series(1, 60) g;
  INSERT INTO document_entity_links (tenant_id, document_id, entity_id)
    SELECT '${B}', md5('r41-b-d-' || g)::uuid, md5('r41-b-c-' || (1 + g % 25))::uuid FROM generate_series(1, 60) g;
  INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence)
    SELECT '${B}', md5('r41-b-d-' || g)::uuid, md5('r41-b-u-' || (1 + g % 40))::uuid, 'service_date', to_char(current_date - g, 'YYYY-MM-DD'), 0.9 FROM generate_series(1, 60) g;
  SELECT set_config('app.tenant_id', '', false);
`);
// Pages with strictly different ranks (the load-test text is repetitive, so most of its pages tie): 'zephyrcoil' appears k times
// on page k, and every page also carries 'quasar' once. Questions about these words have an unambiguous best-first order.
await lite.exec(`
  SELECT set_config('app.tenant_id', '${T}', false);
  INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, display_name)
    SELECT md5('r41-z-d-' || g)::uuid, '${T}', 'zephyr-' || g || '.pdf', 'service-ticket', md5('r41z' || g) || md5('r41zz' || g), 'verified', now() - (g || ' hours')::interval, 'Zephyr doc ' || g FROM generate_series(1, 30) g;
  INSERT INTO document_pages (document_id, page_no, tenant_id, text)
    SELECT md5('r41-z-d-' || g)::uuid, 1, '${T}', 'quasar log: ' || repeat('zephyrcoil ', g) || 'filler words about nothing in particular number ' || g FROM generate_series(1, 30) g;
  SELECT set_config('app.tenant_id', '', false);
`);
await lite.exec('ANALYZE');

const sizes = {
  customers: await n1(`SELECT count(*)::int n FROM entities WHERE tenant_id=$1 AND entity_type='customer'`, [T]),
  units: await n1(`SELECT count(*)::int n FROM entities WHERE tenant_id=$1 AND entity_type='equipment'`, [T]),
};
console.log(`   shop A: ${sizes.customers} customers, ${sizes.units} units; shop B: 25 customers`);

/* ------------------------------------------------------------------------------------------------------------ the old SQL */
// The Customers list query exactly as it was before R41 (api/_lib/recordsStore.js listCustomersSummary at R40), copied verbatim
// so this file keeps proving equivalence to it after the store changes.
const TENANT = `tenant_id = (current_setting('app.tenant_id', true))::uuid`;
const OLD_ORDER = { name: "c.data->>'customer_name' ASC NULLS LAST, c.id", docs: 'doc_count DESC NULLS LAST, c.id', recent: 'last_activity DESC NULLS LAST, c.id' };
const oldSql = (sort) => `WITH c AS (
           SELECT id, customer_number, data, updated_at
             FROM entities
            WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}
              AND ($1::text IS NULL OR data->>'customer_name' ILIKE $1
                                    OR data->>'service_address' ILIKE $1
                                    OR customer_number ILIKE $1)
         ),
         equip AS (
           SELECT id, customer_id, data->'warranty' AS warranty, updated_at
             FROM entities WHERE entity_type = 'equipment' AND customer_id IS NOT NULL AND ${TENANT}
         ),
         doc_union AS (
           SELECT l.document_id, c.id AS customer_id
             FROM document_entity_links l JOIN c ON c.id = l.entity_id
            WHERE ${TENANT.replace('tenant_id', 'l.tenant_id')}
           UNION
           SELECT l.document_id, eq.customer_id
             FROM document_entity_links l JOIN equip eq ON eq.id = l.entity_id
            WHERE ${TENANT.replace('tenant_id', 'l.tenant_id')}
           UNION
           SELECT x.document_id, eq.customer_id
             FROM extractions x JOIN equip eq ON eq.id = x.entity_id
            WHERE ${TENANT.replace('tenant_id', 'x.tenant_id')}
         ),
         doc_agg AS (
           SELECT du.customer_id, COUNT(DISTINCT du.document_id) AS doc_count, MAX(d.created_at) AS last_doc
             FROM doc_union du JOIN documents d ON d.id = du.document_id
            GROUP BY du.customer_id
         ),
         service_agg AS (
           SELECT eq.customer_id, MAX(x.value::date) AS last_service
             FROM extractions x JOIN equip eq ON eq.id = x.entity_id
            WHERE x.field_key = 'service_date' AND x.value ~ '^\\d{4}-\\d{2}-\\d{2}$'
              AND ${TENANT.replace('tenant_id', 'x.tenant_id')}
            GROUP BY eq.customer_id
         ),
         equip_agg AS (
           SELECT customer_id, COUNT(*) AS n, MAX(updated_at) AS last_equip_update FROM equip GROUP BY customer_id
         ),
         warranty_agg AS (
           SELECT customer_id, jsonb_agg(jsonb_build_object('id', id) || warranty) AS warranties
             FROM equip WHERE warranty IS NOT NULL GROUP BY customer_id
         )
         SELECT c.id, c.customer_number, c.data,
                COALESCE(da.doc_count, 0)::int AS doc_count,
                COALESCE(ea.n, 0)::int         AS equipment_count,
                GREATEST(da.last_doc, sa.last_service::timestamptz, ea.last_equip_update) AS last_activity,
                COALESCE(wa.warranties, '[]'::jsonb) AS warranties
           FROM c
           LEFT JOIN warranty_agg wa ON wa.customer_id = c.id
           LEFT JOIN doc_agg da ON da.customer_id = c.id
           LEFT JOIN service_agg sa ON sa.customer_id = c.id
           LEFT JOIN equip_agg ea ON ea.customer_id = c.id
          ORDER BY ${OLD_ORDER[sort]}
          LIMIT $2 OFFSET $3`;

// The shape the app turns a row into: the route reads id, number, name/address/phone/email, counts, lastActivity and the
// warranties (its alert tally does not depend on their order, so they are compared as a sorted list).
const norm = (r) => JSON.stringify({
  id: r.id, number: r.customer_number, data: r.data, docs: r.doc_count, equip: r.equipment_count,
  last: r.last_activity ? new Date(r.last_activity).toISOString() : null,
  warranties: (r.warranties ?? []).map((w) => JSON.stringify(w)).sort(),
});
const SHOPS = { A: SHOP, B: OTHER };
const inShop = (key, fn) => RS.withTenant({ tenantKey: key, tenantName: key }, fn);
const setMode = async (mode) => { // 'summary' = 65 pasted; 'fallback' = not pasted
  if (mode === 'fallback') await lite.exec('REVOKE EXECUTE ON FUNCTION customer_activity_refresh() FROM deepwell_rls');
  else await lite.exec('GRANT EXECUTE ON FUNCTION customer_activity_refresh() TO deepwell_rls');
  RS._resetCustomerSummaryProbe();
};
const listOld = (key, p) => inShop(key, async (db) => (await db.raw(oldSql(p.sort), [p.like, p.limit, p.offset])).rows.map(norm));
const listNew = (key, p) => inShop(key, async (db) => (await db.listCustomersSummary(p)).map(norm));
const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `row ${i}: old ${a[i]} | new ${b[i]}`; return ''; };

/* ============================================================================================================== CUSTOMERS */
family = 'customers';
// the list is the same whether or not 65 is pasted
const likes = [null, '%Sunrise%', '%a%', '%e%', '%C-0001%', '%C-9000%', '%Twin Tie%', '%Saguaro%', '%zzzznomatch%', '%Elm St%', '%mesa%', '%5 Gone%', '%Whitmore%'];
const pages = [[200, 0], [50, 0], [50, 50], [7, 3], [1, 0], [1, 1], [200, 100], [3, 20000], [50, 5]];
for (const mode of ['summary', 'fallback']) {
  await setMode(mode);
  let cases = 0; let bad = '';
  const seen = new Set();
  for (const shop of ['A', 'B']) for (const sort of ['recent', 'name', 'docs']) for (const like of likes) for (const [limit, offset] of pages) {
    const p = { like, sort, limit, offset };
    const o = await listOld(SHOPS[shop], p);
    const nw = await listNew(SHOPS[shop], p);
    cases++;
    seen.add(o.length > 0 ? 'nonempty' : 'empty');
    if (JSON.stringify(o) !== JSON.stringify(nw)) { bad = `${shop} ${JSON.stringify(p)}: ${firstDiff(o, nw)}`; break; }
  }
  check(`list == original SQL (${mode}): ${cases} sort/page/offset/search cases over two shops`, !bad, bad);
  check(`...and the cases covered both non-empty and empty pages`, seen.has('nonempty') && seen.has('empty'));
}

// each kind of edge customer, by name, in the summary list
await setMode('summary');
const allA = await inShop(SHOP, (db) => db.listCustomersSummary({ sort: 'recent', limit: 20000, cap: 20000 }));
const byId = new Map(allA.map((r) => [r.id, r]));
eq('every non-merged customer is listed once (the merged one is not)', allA.length, sizes.customers - 1);
check('a customer with no documents and no units: 0 documents, 0 units, no last activity, last in the recent order', byId.get(EC.noDocsNoUnits)?.doc_count === 0 && byId.get(EC.noDocsNoUnits)?.equipment_count === 0 && byId.get(EC.noDocsNoUnits)?.last_activity === null);
check('...and a customer with no name is listed too', byId.has(EC.nullName));
check('the merged customer is not listed; the survivor shows the document linked to both', !byId.has(EC.merged) && byId.get(EC.survivor)?.doc_count === 1 && new Date(byId.get(EC.survivor).last_activity).toISOString() === '2031-01-01T00:00:00.000Z');
check('a customer reached only through its unit\'s extracted fields still counts the document and the service date', byId.get(EC.equipOnly)?.doc_count === 1 && byId.get(EC.equipOnly)?.equipment_count === 1);
{
  const a = byId.get(EC.tieA); const b = byId.get(EC.tieB);
  check('two customers with the same name and the same last activity are tied (and ordered by id)', a && b && String(a.last_activity) === String(b.last_activity) && a.id < b.id && allA.indexOf(a) < allA.indexOf(b) && allA.indexOf(b) === allA.indexOf(a) + 1);
}
eq('the counts the list shows (countCustomersSummary) are unchanged: all, a search, none', await inShop(SHOP, async (db) => [await db.countCustomersSummary({}), await db.countCustomersSummary({ like: '%Twin Tie%' }), await db.countCustomersSummary({ like: '%zzzznomatch%' })]), [sizes.customers - 1, 2, 0]);
{
  // every summary row equals what the original query computes for that customer
  const oldAll = await listOld(SHOP, { like: null, sort: 'recent', limit: 20000, offset: 0 });
  const stored = await q(`SELECT customer_id, last_activity, doc_count FROM customer_activity WHERE tenant_id = $1`, [T]);
  eq('the stored summary has one row per customer of the shop (merged one included)', stored.length, sizes.customers);
  const oldById = new Map(oldAll.map((s) => [JSON.parse(s).id, JSON.parse(s)]));
  const wrong = stored.filter((r) => oldById.has(r.customer_id) && (oldById.get(r.customer_id).docs !== r.doc_count || oldById.get(r.customer_id).last !== (r.last_activity ? new Date(r.last_activity).toISOString() : null)));
  eq('...and every stored last_activity and doc_count equals the original query\'s', wrong.length, 0);
}
{
  eq('after a list nothing is waiting to be recomputed', await n1(`SELECT count(*)::int n FROM customer_activity_dirty WHERE tenant_id = $1`, [T]), 0);
  const again = await inShop(SHOP, (db) => db.raw('SELECT customer_activity_refresh() AS n'));
  eq('a refresh with nothing waiting does no work and returns 0', again.rows[0].n, 0);
}

/* ================================================================================================================== FUZZ */
family = 'fuzz';
await setMode('summary');
const ids = {
  docs: async () => (await q(`SELECT id FROM documents WHERE tenant_id = $1`, [T])).map((r) => r.id),
  cust: async () => (await q(`SELECT id FROM entities WHERE tenant_id = $1 AND entity_type='customer'`, [T])).map((r) => r.id),
  unit: async () => (await q(`SELECT id FROM entities WHERE tenant_id = $1 AND entity_type='equipment'`, [T])).map((r) => r.id),
};
let ok = 0; let skipped = 0; let seq = 0;
const run = async (sql, params) => { try { await lite.query(sql, params); ok++; } catch (e) { skipped++; if (!/duplicate key|violates|invalid input/.test(String(e.message))) throw e; } };
const asShop = async (fn) => { await lite.query(`SELECT set_config('app.tenant_id', $1, false)`, [T]); try { await fn(); } finally { await lite.query(`SELECT set_config('app.tenant_id', '', false)`); } };
const dateStr = () => `${2018 + int(9)}-${String(1 + int(12)).padStart(2, '0')}-${String(1 + int(28)).padStart(2, '0')}`;
const OPS = {
  async linkAdd(c) { await run(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [T, pick(c.docs), pick(rng() < 0.5 ? c.cust : c.unit)]); },
  async linkAddBulk(c) { await run(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) SELECT $1, d, e FROM unnest($2::uuid[]) d, unnest($3::uuid[]) e ON CONFLICT DO NOTHING`, [T, [pick(c.docs), pick(c.docs), pick(c.docs)], [pick(c.cust), pick(c.unit)]]); },
  async linkDel() { await run(`DELETE FROM document_entity_links WHERE id IN (SELECT id FROM document_entity_links WHERE tenant_id = $1 ORDER BY random() LIMIT $2)`, [T, 1 + int(4)]); },
  async linkRepoint(c) { await run(`UPDATE document_entity_links SET entity_id = $2 WHERE id = (SELECT id FROM document_entity_links WHERE tenant_id = $1 ORDER BY random() LIMIT 1)`, [T, pick(c.cust)]); },
  async linkRedoc(c) { await run(`UPDATE document_entity_links SET document_id = $2 WHERE id = (SELECT id FROM document_entity_links WHERE tenant_id = $1 ORDER BY random() LIMIT 1)`, [T, pick(c.docs)]); },
  async extAdd(c) { const k = pick(['service_date', 'service_date', 'serial_number', 'note', 'total_amount']); await run(`INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,$5,0.8)`, [T, pick(c.docs), pick(c.unit), k, k === 'service_date' ? (rng() < 0.15 ? 'unknown' : dateStr()) : `v${++seq}`]); },
  async extAddNoEntity(c) { await run(`INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,'technician',$3,0.8)`, [T, pick(c.docs), `Tech ${++seq}`]); },
  async extDel() { await run(`DELETE FROM extractions WHERE id IN (SELECT id FROM extractions WHERE tenant_id = $1 AND entity_id IS NOT NULL ORDER BY random() LIMIT $2)`, [T, 1 + int(5)]); },
  async extDate() { await run(`UPDATE extractions SET value = $2 WHERE id = (SELECT id FROM extractions WHERE tenant_id = $1 AND field_key = 'service_date' AND entity_id IS NOT NULL ORDER BY random() LIMIT 1)`, [T, dateStr()]); },
  async extRepoint(c) { await run(`UPDATE extractions SET entity_id = $2 WHERE id = (SELECT id FROM extractions WHERE tenant_id = $1 AND entity_id IS NOT NULL ORDER BY random() LIMIT 1)`, [T, pick(c.unit)]); },
  async extRekey() { await run(`UPDATE extractions SET field_key = $2 WHERE id = (SELECT id FROM extractions WHERE tenant_id = $1 AND entity_id IS NOT NULL ORDER BY random() LIMIT 1)`, [T, pick(['service_date', 'note'])]); },
  async extRedoc(c) { await run(`UPDATE extractions SET document_id = $2 WHERE id = (SELECT id FROM extractions WHERE tenant_id = $1 AND entity_id IS NOT NULL ORDER BY random() LIMIT 1)`, [T, pick(c.docs)]); },
  async extUnrelated() { await run(`UPDATE extractions SET confidence = 0.5 WHERE id = (SELECT id FROM extractions WHERE tenant_id = $1 ORDER BY random() LIMIT 1)`, [T]); },
  async unitTouch() { await run(`UPDATE entities SET updated_at = now() + ($2 || ' minutes')::interval WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T, String(int(500))]); },
  async unitBackdate() { await run(`UPDATE entities SET updated_at = '2000-01-01' WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T]); },
  async unitWarranty() { await run(`UPDATE entities SET data = jsonb_set(data, '{warranty}', '{"expires":"2031-02-03"}'::jsonb) WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T]); },
  async unitMove(c) { await run(`UPDATE entities SET customer_id = $2, updated_at = now() WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T, pick(c.cust)]); },
  async unitMoveQuiet(c) { await run(`UPDATE entities SET customer_id = $2 WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T, pick(c.cust)]); },
  async unitOrphan() { await run(`UPDATE entities SET customer_id = NULL WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T]); },
  async unitAdd(c) { const id = crypto.randomUUID(); await run(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, created_at, updated_at) VALUES ($1,$2,'equipment',$3,$4,now(),now() + ($5 || ' minutes')::interval)`, [id, T, JSON.stringify({ manufacturer: 'Fuzz', model: `F${++seq}`, serial_number: `FZ${seq}`, warranty: rng() < 0.5 ? { expires: dateStr() } : undefined }), pick(c.cust), String(int(900))]); },
  async unitDel() { await run(`DELETE FROM entities WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [T]); },
  async custAdd() { await run(`INSERT INTO entities (id, tenant_id, entity_type, data, customer_number, created_at, updated_at) VALUES ($1,$2,'customer',$3,$4,now(),now())`, [crypto.randomUUID(), T, JSON.stringify({ customer_name: `Fuzz Customer ${++seq}`, service_address: `${seq} Fuzz Rd, Mesa, AZ` }), `C-8${String(seq).padStart(4, '0')}`]); },
  async custDel() { await run(`DELETE FROM entities WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'customer' ORDER BY random() LIMIT 1)`, [T]); },
  async custMerge(c) { const [a, b] = [pick(c.cust), pick(c.cust)]; if (a === b) return; await run(`WITH m AS (UPDATE entities SET merged_into = $3 WHERE id = $2 AND tenant_id = $1 RETURNING id) UPDATE entities SET customer_id = $3 WHERE customer_id IN (SELECT id FROM m) AND tenant_id = $1`, [T, a, b]); },
  async custUnmerge() { await run(`UPDATE entities SET merged_into = NULL WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'customer' AND merged_into IS NOT NULL ORDER BY random() LIMIT 1)`, [T]); },
  async custRename() { await run(`UPDATE entities SET data = jsonb_set(data, '{customer_name}', to_jsonb($2::text)) WHERE id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'customer' ORDER BY random() LIMIT 1)`, [T, `Renamed ${int(30)}`]); },
  async docAdd(c) { const id = crypto.randomUUID(); await run(`INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at, display_name) VALUES ($1,$2,$3,'invoice',$4,'verified',now() - ($5 || ' days')::interval,$3)`, [id, T, `fuzz-${++seq}.pdf`, `${id.replace(/-/g, '')}${id.replace(/-/g, '')}`, String(int(2000))]); await run(`INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [T, id, pick(c.cust)]); },
  async docDel() { await run(`DELETE FROM documents WHERE id IN (SELECT id FROM documents WHERE tenant_id = $1 ORDER BY random() LIMIT $2)`, [T, 1 + int(3)]); },
  async docDate() { await run(`UPDATE documents SET created_at = now() - ($2 || ' days')::interval WHERE id = (SELECT id FROM documents WHERE tenant_id = $1 ORDER BY random() LIMIT 1)`, [T, String(int(4000))]); },
  async docOther() { await run(`UPDATE documents SET stage = 'verified', display_name = display_name || 'x' WHERE id = (SELECT id FROM documents WHERE tenant_id = $1 ORDER BY random() LIMIT 1)`, [T]); },
  async otherShop() { await run(`UPDATE entities SET updated_at = now() WHERE tenant_id = $1 AND entity_type = 'equipment' AND id = (SELECT id FROM entities WHERE tenant_id = $1 AND entity_type = 'equipment' ORDER BY random() LIMIT 1)`, [B]); },
  async txnBatch(c) { try { await lite.exec('BEGIN'); await OPS.linkAdd(c); await OPS.extAdd(c); await OPS.unitTouch(c); await OPS.linkDel(c); await lite.exec(rng() < 0.3 ? 'ROLLBACK' : 'COMMIT'); } catch (e) { await lite.exec('ROLLBACK').catch(() => {}); } },
};
const opNames = Object.keys(OPS);
let failedRound = '';
const sorts = ['recent', 'docs', 'name'];
for (let round = 1; round <= FUZZ_ROUNDS && !failedRound; round++) {
  const c = { docs: await ids.docs(), cust: await ids.cust(), unit: await ids.unit() };
  const done = [];
  await asShop(async () => {
    for (let i = 0; i < 25; i++) { const name = round <= opNames.length ? opNames[(round + i) % opNames.length] : pick(opNames); done.push(name); await OPS[name](c); }
  });
  for (const sort of sorts) {
    const p = { like: null, sort, limit: 20000, offset: 0 };
    const o = await listOld(SHOP, p); const n = await listNew(SHOP, p);
    if (JSON.stringify(o) !== JSON.stringify(n)) { failedRound = `round ${round} sort ${sort} after ${done.join(',')}: ${firstDiff(o, n)}`; break; }
  }
  if (!failedRound && round % 5 === 0) { // pages and searches too, as the screen asks for them
    for (const p of [{ like: '%Fuzz%', sort: 'recent', limit: 50, offset: 0 }, { like: null, sort: 'recent', limit: 50, offset: 50 }, { like: '%a%', sort: 'docs', limit: 7, offset: 3 }, { like: null, sort: 'name', limit: 30, offset: 10 }]) {
      const o = await listOld(SHOP, p); const n = await listNew(SHOP, p);
      if (JSON.stringify(o) !== JSON.stringify(n)) { failedRound = `round ${round} page ${JSON.stringify(p)}: ${firstDiff(o, n)}`; break; }
    }
  }
}
check(`summary == original SQL after every one of ${FUZZ_ROUNDS} rounds of 25 random writes (${ok} applied, ${skipped} refused by constraints, ${opNames.length} write kinds)`, !failedRound, failedRound);
{
  // the to-do list stays small: many single-row saves for the same customers add each customer at most once
  await asShop(async () => {
    const c = { docs: await ids.docs(), cust: (await ids.cust()).slice(0, 5), unit: await ids.unit() };
    for (let i = 0; i < 120; i++) await OPS.linkAdd({ ...c, unit: [], cust: c.cust });
  });
  const waiting = await n1(`SELECT count(*)::int n FROM customer_activity_dirty WHERE tenant_id = $1`, [T]);
  check('120 separate saves touching 5 customers leave at most 5 entries waiting (no pile-up for a shop that never opens Customers)', waiting <= 5, String(waiting));
  await listNew(SHOP, { like: null, sort: 'recent', limit: 5, offset: 0 });
  eq('...and the next list clears them', await n1(`SELECT count(*)::int n FROM customer_activity_dirty WHERE tenant_id = $1`, [T]), 0);
}
// everything the fuzz did must also leave shop B's summary right
{
  const o = await listOld(OTHER, { like: null, sort: 'recent', limit: 200, offset: 0 });
  const n = await listNew(OTHER, { like: null, sort: 'recent', limit: 200, offset: 0 });
  check('shop B (touched by the fuzz\'s cross-shop writes) still equals the original SQL', JSON.stringify(o) === JSON.stringify(n), firstDiff(o, n));
}
// refresh recomputes from scratch: forcing everything dirty changes nothing
{
  const before = JSON.stringify(await listNew(SHOP, { like: null, sort: 'recent', limit: 20000, offset: 0 }));
  await inShop(SHOP, (db) => db.raw('SELECT customer_activity_rebuild() AS n'));
  const after = JSON.stringify(await listNew(SHOP, { like: null, sort: 'recent', limit: 20000, offset: 0 }));
  check('customer_activity_rebuild() then a list gives the identical list', before === after);
  await lite.exec(`DELETE FROM customer_activity WHERE tenant_id = '${T}' AND customer_id IN (SELECT customer_id FROM customer_activity WHERE tenant_id = '${T}' LIMIT 10)`);
  const healed = JSON.stringify(await listNew(SHOP, { like: null, sort: 'recent', limit: 20000, offset: 0 }));
  check('a customer whose summary row went missing (triggers off, restore, manual delete) is found and recomputed by the next list', healed === before);
}

/* =============================================================================================================== DONOVAN */
family = 'donovan';
const PASS_OLD_FTS = `WITH q AS (
          SELECT NULLIF(array_to_string(
                   tsvector_to_array(to_tsvector('english', $1)), ' | '
                 ), '')::tsquery AS tsq
        )
        SELECT p.id, ts_rank_cd(p.tsv, q.tsq) AS rank
          FROM document_pages p
          CROSS JOIN q
         WHERE p.${TENANT} AND q.tsq IS NOT NULL AND p.tsv @@ q.tsq
         ORDER BY rank DESC`;
const setPassageMode = async (mode) => {
  if (mode === 'fallback') await lite.exec('REVOKE EXECUTE ON FUNCTION donovan_pages_by_text(text, int, uuid[]), donovan_pages_by_like(text, int, uuid[]) FROM deepwell_rls');
  else await lite.exec('GRANT EXECUTE ON FUNCTION donovan_pages_by_text(text, int, uuid[]), donovan_pages_by_like(text, int, uuid[]) TO deepwell_rls');
  RS._resetPassageFnProbe();
};
const search = (key, question, limit, opts) => inShop(key, (db) => db.searchPassages(question, limit, opts));
const fullRank = (key, question) => inShop(key, async (db) => new Map((await db.raw(PASS_OLD_FTS, [question])).rows.map((r) => [r.id, r.rank])));
const serial = (await q(`SELECT value FROM extractions WHERE tenant_id=$1 AND field_key='serial_number' AND value IS NOT NULL LIMIT 1`, [T]))[0].value;
const someDocs = (await q(`SELECT id FROM documents WHERE tenant_id=$1 ORDER BY id LIMIT 40`, [T])).map((r) => r.id);
const otherShopDoc = (await q(`SELECT id FROM documents WHERE tenant_id=$1 LIMIT 1`, [B]))[0].id;
const VOCAB = ['compressor', 'capacitor', 'replaced', 'Whitmore', 'property', 'refrigerant', 'leak', 'furnace', 'thermostat', 'warranty', 'condenser', 'coil', 'filter', 'tune-up', 'heat', 'pump', 'defrost', 'breaker', 'Nakamura', 'Okafor', 'Lindgren', 'drain', 'pan', 'blower', 'motor', 'igniter', 'invoice', 'when', 'was', 'the', 'at', 'is', 'serial', 'last', 'serviced', 'Saguaro', 'Vista', 'unit', 'model', 'recommended', 'surge'];
const QUESTIONS = [
  'when was the compressor capacitor replaced at the Whitmore property',
  `what is the warranty on serial ${serial}`,
  `${serial}`, 'refrigerant leak at evaporator coil', 'furnace short cycling', 'the of and', 'qwertyuiop', 'compress', 'condens', 'a b c', '2019 invoice', 'model TT1 serial ZZ41A000003',
  'zephyrcoil', 'zephyrcoil quasar', 'quasar zephyrcoil filler', 'where is zephyrcoil number 7',
  'C-00012 compressor', 'Nakamura heat pump defrost', 'notes findings observations recommended recommendation condition issue',
  `serial ${serial} and serial ${serial.slice(0, 5)}`, "O'Brien; DROP TABLE documents; --", '%_%', 'Edge doc 2',
  ...Array.from({ length: 22 }, () => Array.from({ length: 2 + int(5) }, () => pick(VOCAB)).join(' ')),
];
// The old query had no tie-break: pages with the SAME rank came back in whatever order the plan produced, and which of them made
// it into the top `limit` was arbitrary. The new function breaks ties by page id. So: when the cut-off falls inside a run of
// equal ranks the result is "ambiguous" and only what is defined is compared (the pages strictly above the tie are the same,
// every page at the tie is a real match of that rank); otherwise the two results must be IDENTICAL, row for row, including
// order, excerpt and label. Both kinds are counted below so the strict comparison is known not to be vacuous.
const tally = { strict: 0, ambiguous: 0 };
const same = async (key, question, limit, opts) => {
  await setPassageMode('fallback'); const o = await search(key, question, limit, opts);
  await setPassageMode('pasted'); const n = await search(key, question, limit, opts);
  const full = await fullRank(key, question); // every FTS match of the shop and its rank
  const scoped = opts?.documentIds ? new Set((await q(`SELECT id FROM document_pages WHERE document_id = ANY($1::uuid[])`, [opts.documentIds])).map((r) => r.id)) : null;
  const ranks = [...full.entries()].filter(([id]) => !scoped || scoped.has(id)).map(([, r]) => r).sort((a, b) => b - a);
  const cut = ranks[limit - 1]; // rank at the cut-off (undefined when fewer matches than the limit)
  const ambiguous = cut !== undefined && ranks.filter((r) => r === cut).length > ranks.slice(0, limit).filter((r) => r === cut).length;
  const sig = (r) => JSON.stringify([r.id, r.document_id, r.page_no, r.original_filename, r.document_type, r.stage, r.excerpt, r.matched_by, String(r.rank)]);
  if (!ambiguous) {
    tally.strict++;
    // equal ranks inside the result are still unordered in the old query: compare run by run
    const runs = (rows) => { const out = []; for (const r of rows) { const k = `${r.rank}|${String(r.matched_by).split(':')[0]}`; if (out.length && out[out.length - 1].k === k) out[out.length - 1].rows.push(sig(r)); else out.push({ k, rows: [sig(r)] }); } return out.map((x) => JSON.stringify([x.k, x.rows.sort()])); };
    return JSON.stringify(runs(o)) === JSON.stringify(runs(n)) ? '' : `old ${JSON.stringify(o.map((r) => [r.id.slice(0, 6), r.rank, r.matched_by]))} vs new ${JSON.stringify(n.map((r) => [r.id.slice(0, 6), r.rank, r.matched_by]))}`;
  }
  tally.ambiguous++;
  const fts = (rows) => rows.filter((r) => r.matched_by === 'text');
  const above = (rows) => fts(rows).filter((r) => r.rank > cut).map(sig).sort();
  const why = [];
  if (JSON.stringify(above(o)) !== JSON.stringify(above(n))) why.push('pages above the tie differ');
  for (const r of fts(n).filter((x) => x.rank === cut)) if (!full.has(r.id) || full.get(r.id) !== r.rank) why.push(`${r.id} is not a match of rank ${cut}`);
  if (n.length > limit) why.push('more than the limit');
  return why.join('; ');
};
{
  let bad = ''; let cases = 0; let nonEmpty = 0;
  for (const question of QUESTIONS) for (const limit of [12, 4, 40]) {
    const d = await same(SHOP, question, limit, {});
    cases++;
    if (d) { bad = `${JSON.stringify(question)} limit ${limit}: ${d}`; break; }
    nonEmpty += (await search(SHOP, question, limit, {})).length > 0 ? 1 : 0;
  }
  check(`searchPassages with 65 == without 65: ${cases} question/limit cases (ranks, pages above the tie line, excerpts, labels)`, !bad, bad);
  check('...and most of them found pages, and the strict (tie-free) comparison ran for a good share of them', nonEmpty >= cases / 2 && tally.strict >= 30, `${nonEmpty}/${cases} non-empty; ${tally.strict} strict, ${tally.ambiguous} ambiguous`);
}
{
  let bad = '';
  for (const question of QUESTIONS.slice(0, 12)) for (const opts of [{ documentIds: someDocs }, { documentIds: [] }, { documentIds: [someDocs[0]] }, { documentIds: [...someDocs.slice(0, 5), otherShopDoc] }]) {
    const d = await same(SHOP, question, 12, opts);
    if (d) { bad = `${JSON.stringify(question)} ${opts.documentIds.length} docs: ${d}`; break; }
  }
  check('scoped to a set of documents (some, one, none, one that belongs to another shop): same as without 65', !bad, bad);
  await setPassageMode('pasted');
  eq('an empty document set returns nothing', (await search(SHOP, 'compressor', 12, { documentIds: [] })).length, 0);
  const leaked = (await search(SHOP, 'compressor capacitor', 12, { documentIds: [otherShopDoc] })).length;
  eq('a document id from another shop in the scope returns nothing', leaked, 0);
}
{
  // the ranking really is the same function of the same pages: every ranked page the new function returns has the old rank
  await setPassageMode('pasted');
  const r = await inShop(SHOP, (db) => db.raw(`SELECT id, rank FROM donovan_pages_by_text($1, 100000, NULL)`, ['when was the compressor capacitor replaced at the Whitmore property']));
  const full = await fullRank(SHOP, 'when was the compressor capacitor replaced at the Whitmore property');
  eq('donovan_pages_by_text returns every matching page once with the old rank (and nothing else)', [r.rows.length, r.rows.every((x) => full.get(x.id) === x.rank)], [full.size, true]);
  check('...best first', r.rows.every((x, i) => i === 0 || r.rows[i - 1].rank >= x.rank));
  const lk = await inShop(SHOP, (db) => db.raw(`SELECT t.id FROM donovan_pages_by_like($1, 100000, NULL) AS t(id)`, [`%${serial}%`]));
  const direct = await inShop(SHOP, (db) => db.raw(`SELECT id FROM document_pages p WHERE p.${TENANT} AND p.text ILIKE $1`, [`%${serial}%`]));
  eq('donovan_pages_by_like returns exactly the pages an ILIKE finds', lk.rows.map((x) => x.id).sort(), direct.rows.map((x) => x.id).sort());
}

/* ============================================================================================================== ISOLATION */
family = 'isolation';
const asApp = async (tenant, fn) => {
  await lite.exec('SET ROLE deepwell_rls');
  await lite.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant ?? '']);
  try { return await fn(); } finally { await lite.query(`SELECT set_config('app.tenant_id', '', false)`); await lite.exec('RESET ROLE'); }
};
await setPassageMode('pasted'); await setMode('summary');
const PAGE_Q = 'when was the compressor capacitor replaced at the Whitmore property';
const tenantOfPages = async (rows) => (await q(`SELECT DISTINCT tenant_id FROM document_pages WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)])).map((r) => r.tenant_id);
{
  const unsetT = await asApp(null, async () => (await q(`SELECT count(*)::int n FROM donovan_pages_by_text($1, 50, NULL)`, [PAGE_Q]))[0].n);
  const unsetL = await asApp(null, async () => (await q(`SELECT count(*)::int n FROM donovan_pages_by_like($1, 50, NULL)`, ['%compressor%']))[0].n);
  eq('app.tenant_id unset: both page finders return nothing', [unsetT, unsetL], [0, 0]);
  const asA = await asApp(T, async () => ({ t: await q(`SELECT * FROM donovan_pages_by_text($1, 50, NULL)`, [PAGE_Q]), l: await q(`SELECT * FROM donovan_pages_by_like($1, 50, NULL)`, ['%compressor%']) }));
  const asB = await asApp(B, async () => ({ t: await q(`SELECT * FROM donovan_pages_by_text($1, 50, NULL)`, [PAGE_Q]), l: await q(`SELECT * FROM donovan_pages_by_like($1, 50, NULL)`, ['%compressor%']) }));
  check('as shop A: only shop A\'s pages come back', asA.t.length > 0 && asA.l.length > 0 && (await tenantOfPages(asA.t)).join() === T && (await tenantOfPages(asA.l.map((r) => ({ id: r.donovan_pages_by_like })))).join() === T);
  check('as shop B: only shop B\'s pages come back', asB.t.length > 0 && asB.l.length > 0 && (await tenantOfPages(asB.t)).join() === B && (await tenantOfPages(asB.l.map((r) => ({ id: r.donovan_pages_by_like })))).join() === B);
  const aDocs = (await q(`SELECT id FROM documents WHERE tenant_id=$1 LIMIT 50`, [T])).map((r) => r.id);
  const asBwithA = await asApp(B, async () => ({ t: (await q(`SELECT count(*)::int n FROM donovan_pages_by_text($1, 50, $2::uuid[])`, [PAGE_Q, aDocs]))[0].n, l: (await q(`SELECT count(*)::int n FROM donovan_pages_by_like($1, 50, $2::uuid[])`, ['%compressor%', aDocs]))[0].n }));
  eq('as shop B, naming shop A\'s documents in the scope still returns nothing', asBwithA, { t: 0, l: 0 });
  check('the app role cannot call the internal helpers the triggers use, nor read the old page scan as another shop',
    await asApp(B, async () => { let denied = 0; for (const sql of [`SELECT customer_activity_mark(ARRAY[gen_random_uuid()])`, `SELECT customer_activity_trg_links()`]) { try { await q(sql); } catch (e) { if (/permission denied|trigger functions can only/.test(String(e.message))) denied++; } } return denied === 2; }));
  // the summary tables: row-level security
  const rows = async (t) => asApp(t, async () => ({ a: (await q(`SELECT count(*)::int n FROM customer_activity`))[0].n, d: (await q(`SELECT count(*)::int n FROM customer_activity_dirty`))[0].n }));
  const ra = await rows(T); const rb = await rows(B);
  const ru = await rows(null).catch(() => ({ a: 0, d: 0 })); // with the setting empty the policy itself refuses (fails closed), as on every other table
  check('customer_activity: shop A sees its own rows, shop B its own, nobody (unset) none', ra.a === sizes.customers && rb.a === 25 && ru.a === 0 && ru.d === 0, JSON.stringify({ ra, rb, ru }));
  // dirty entries of A: B cannot see, delete or refresh them; unset refresh does nothing
  await lite.exec(`INSERT INTO customer_activity_dirty (tenant_id, customer_id) SELECT '${T}', id FROM entities WHERE tenant_id = '${T}' AND entity_type='customer' LIMIT 3`);
  const bDel = await asApp(B, async () => ({ seen: (await q(`SELECT count(*)::int n FROM customer_activity_dirty`))[0].n, del: (await lite.query(`DELETE FROM customer_activity_dirty`)).affectedRows ?? 0, refreshed: (await q(`SELECT customer_activity_refresh() AS n`))[0].n }));
  const unsetRefresh = await asApp(null, async () => (await q(`SELECT customer_activity_refresh() AS n`))[0].n);
  eq('shop B sees none of shop A\'s waiting entries, cannot delete them, and a refresh as B does nothing for A; unset does nothing', [bDel.seen, bDel.del, bDel.refreshed, unsetRefresh, await n1(`SELECT count(*)::int n FROM customer_activity_dirty WHERE tenant_id = $1`, [T])], [0, 0, 0, 0, 3]);
  const wrongTenantWrite = await asApp(B, async () => { try { await q(`INSERT INTO customer_activity (customer_id, tenant_id, last_activity, doc_count) SELECT id, $1, now(), 99 FROM entities LIMIT 1`, [T]); return 'allowed'; } catch (e) { return /row-level security|violates|permission/.test(String(e.message)) ? 'refused' : String(e.message); } });
  eq('as shop B, writing a summary row labelled with shop A is refused', wrongTenantWrite, 'refused');
  await asApp(T, async () => { await q(`SELECT customer_activity_refresh()`); });
  eq('as shop A its waiting entries are processed', await n1(`SELECT count(*)::int n FROM customer_activity_dirty WHERE tenant_id = $1`, [T]), 0);
  const fnOwner = (await q(`SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.proname IN ('donovan_pages_by_text','donovan_pages_by_like','customer_activity_mark','customer_activity_trg_links','customer_activity_trg_extractions','customer_activity_trg_entities','customer_activity_trg_documents') ORDER BY 1`));
  check('every SECURITY DEFINER function pins its search_path', fnOwner.length === 7 && fnOwner.every((f) => f.prosecdef && (f.proconfig ?? []).some((c) => /^search_path=/.test(c))), JSON.stringify(fnOwner));
  const exec = (await q(`SELECT p.proname, has_function_privilege('deepwell_rls', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS pub FROM pg_proc p WHERE p.proname LIKE 'donovan\\_pages\\_by\\_%' OR p.proname LIKE 'customer\\_activity\\_%' ORDER BY 1`));
  check('EXECUTE: only the four functions the app calls are granted to the app role, none to PUBLIC', exec.every((f) => !f.pub) && exec.filter((f) => f.app).map((f) => f.proname).join() === 'customer_activity_rebuild,customer_activity_refresh,donovan_pages_by_like,donovan_pages_by_text', JSON.stringify(exec));
}

/* =============================================================================================================== ROLLOUT */
family = 'rollout';
const real = (log) => log.filter((l) => !/has_function_privilege|has_table_privilege/.test(l.sql)); // the app's own "is 65 there?" probes are not use of 65
{
  // not pasted: the app does not even look for the summary tables after the probe says no, and gives the same list
  await setMode('fallback');
  const log = [];
  h.stats.capture = log;
  const p = { like: null, sort: 'recent', limit: 50, offset: 0 };
  const o = await listOld(SHOP, p); const n = await listNew(SHOP, p);
  h.stats.capture = null;
  check('65 not pasted: the list equals the original and never touches customer_activity', JSON.stringify(o) === JSON.stringify(n) && !real(log).some((l) => /customer_activity_refresh|FROM customer_activity /.test(l.sql)), firstDiff(o, n));
  // half pasted: one trigger missing -> the summary is NOT trusted
  await setMode('summary');
  await lite.exec('DROP TRIGGER customer_activity_extractions_upd ON extractions');
  RS._resetCustomerSummaryProbe();
  const log2 = []; h.stats.capture = log2;
  const n2 = await listNew(SHOP, p);
  h.stats.capture = null;
  check('65 half pasted (a trigger missing): the app ignores the summary and still answers correctly', JSON.stringify(o) === JSON.stringify(n2) && !real(log2).some((l) => /customer_activity_refresh|FROM customer_activity /.test(l.sql)));
  // pasting the whole file (again, over the half-pasted state) repairs it, and pasting twice is harmless
  await lite.exec(SQL65); await lite.exec(GRANT_FNS); await lite.exec(SQL65); await lite.exec(GRANT_FNS);
  RS._resetCustomerSummaryProbe();
  eq('65 pasted twice: still ten triggers', await n1(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'customer\\_activity\\_%' AND NOT tgisinternal`), 10);
  const log3 = []; h.stats.capture = log3;
  const n3 = await listNew(SHOP, p);
  h.stats.capture = null;
  check('...and the app uses the summary again with the same answers', JSON.stringify(o) === JSON.stringify(n3) && real(log3).some((l) => /customer_activity_refresh/.test(l.sql)), firstDiff(o, n3));
  // the old customers also keep working with no rows at all in the summary (first visit after pasting)
  await lite.exec(`DELETE FROM customer_activity; DELETE FROM customer_activity_dirty`);
  const first = await listNew(SHOP, { like: null, sort: 'recent', limit: 20000, offset: 0 });
  const wantAll = await listOld(SHOP, { like: null, sort: 'recent', limit: 20000, offset: 0 });
  check('first visit after pasting (empty summary): the list is complete and correct (the one-time fill happens inside that request)', JSON.stringify(first.length) === JSON.stringify(wantAll.length) && JSON.stringify(first) === JSON.stringify(wantAll));
  // Donovan: not pasted -> inline queries; the revoked state is the not-pasted state
  await setPassageMode('fallback');
  const log4 = []; h.stats.capture = log4;
  await search(SHOP, PAGE_Q, 12, {});
  h.stats.capture = null;
  check('65 not pasted: Donovan runs the inline queries (no donovan_pages_by_* call)', real(log4).length > 0 && !real(log4).some((l) => /donovan_pages_by_/.test(l.sql)));
  await setPassageMode('pasted');
  const log5 = []; h.stats.capture = log5;
  await search(SHOP, `warranty serial ${serial}`, 12, {});
  h.stats.capture = null;
  check('65 pasted: Donovan calls donovan_pages_by_text and donovan_pages_by_like', real(log5).some((l) => /donovan_pages_by_text/.test(l.sql)) && real(log5).some((l) => /donovan_pages_by_like/.test(l.sql)));
  // every statement in 65 is guarded for re-runs
  check('65 is written to be re-run: every CREATE has IF NOT EXISTS / OR REPLACE / a DROP before it', !/CREATE (TABLE|INDEX|TRIGGER|POLICY|FUNCTION)(?! IF NOT EXISTS)(?! OR REPLACE)/.test(SQL65.replace(/^\s*--.*$/gm, '').replace(/DROP (TRIGGER|POLICY) IF EXISTS[^;]*;\s*CREATE (TRIGGER|POLICY)/g, 'DROPPED')), 'a CREATE is not re-runnable');
}

console.log('\nBy family:');
for (const [f, v] of Object.entries(fam)) console.log(`  ${f.padEnd(10)} ${v.pass} passed, ${v.fail} failed`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll R41 scale-query checks passed');
process.exit(failed ? 1 : 0);
