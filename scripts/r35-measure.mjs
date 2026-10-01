/**
 * R35 large-tenant measurement (a tool, not a pass/fail gate - verify-r35-limits.mjs holds the regression checks).
 * Seeds ONE tenant at the owner's "year of paperwork" scale in an in-process Postgres (PGlite, $0, no network) and times
 * the queries the app runs on every screen: 50,000 documents, 10,000 customers, 20,000 units, 5,000 open Inbox
 * questions. Numbers are PGlite (single-threaded WASM Postgres): good for RELATIVE cost and for finding O(N) work per
 * request, NOT a prediction of Neon latency - a real Postgres is typically several times faster on the same plan.
 *
 *   npx tsx scripts/r35-measure.mjs [docs=50000] [customers=10000] [units=20000]
 */
import { bootHarness, measure } from './lib/r35Harness.mjs';

const DOCS = Number(process.argv[2] ?? 50000);
const CUSTOMERS = Number(process.argv[3] ?? 10000);
const UNITS = Number(process.argv[4] ?? 20000);
const NEEDS = Math.min(5000, DOCS);

import fs from 'node:fs';
const CACHE = process.env.R35_SEED_CACHE || null; // optional: reuse a seeded data dir between runs (seeding 50k docs takes ~2 min)
const h = await bootHarness({ loadFrom: CACHE });
const { lite, RS } = h;
const tenantId = await h.newTenant('org_big', 'crew');
const t0 = Date.now();
const seeded = CACHE && fs.existsSync(CACHE) && (await lite.query("SELECT count(*)::int AS n FROM documents")).rows[0].n >= DOCS;
if (!seeded) await lite.exec(`
  INSERT INTO entities (tenant_id, entity_type, data, customer_number, created_at, updated_at)
  SELECT '${tenantId}', 'customer',
         jsonb_build_object('customer_name', 'Customer ' || g || ' HVAC', 'service_address', g || ' Main St, Phoenix AZ', 'phone', '602-555-' || lpad((g % 10000)::text, 4, '0')),
         'C-' || lpad(g::text, 5, '0'), NOW() - (g || ' minutes')::interval, NOW() - (g || ' minutes')::interval
    FROM generate_series(1, ${CUSTOMERS}) g;
  INSERT INTO entities (tenant_id, entity_type, data, customer_id, created_at, updated_at)
  SELECT '${tenantId}', 'equipment',
         jsonb_build_object('serial_number', 'SN' || g, 'model', 'M-' || (g % 300), 'manufacturer', 'Carrier',
                            'warranty', jsonb_build_object('expires', (CURRENT_DATE + ((g % 900) - 300))::text)),
         (SELECT id FROM entities c WHERE c.tenant_id = '${tenantId}' AND c.customer_number = 'C-' || lpad(((g % ${CUSTOMERS}) + 1)::text, 5, '0')),
         NOW() - (g || ' minutes')::interval, NOW() - (g || ' minutes')::interval
    FROM generate_series(1, ${UNITS}) g;
  INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, storage_key, content_type, page_count, extracted_at, created_at, updated_at)
  SELECT '${tenantId}', 'scan-' || g || '.pdf', (ARRAY['work_order','invoice','service_ticket','warranty','startup_sheet'])[1 + g % 5],
         md5(g::text) || md5((g*7)::text), 200000, (ARRAY['verified','linked','mapped','read'])[1 + g % 4],
         '${tenantId}/' || md5(g::text) || '/scan-' || g || '.pdf', 'application/pdf', 1, NOW(), NOW() - (g || ' minutes')::interval, NOW() - (g || ' minutes')::interval
    FROM generate_series(1, ${DOCS}) g;
  INSERT INTO document_pages (tenant_id, document_id, page_no, r2_path, text)
  SELECT '${tenantId}', id, 1, storage_key, 'Service call for ' || original_filename || ' compressor capacitor replaced contactor 24V thermostat refrigerant R410A ' || repeat('lorem ipsum ', 40) FROM documents WHERE tenant_id = '${tenantId}';
  INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by)
  WITH n AS (SELECT id, row_number() OVER (ORDER BY created_at) AS rn FROM documents WHERE tenant_id = '${tenantId}')
  SELECT '${tenantId}', n.id, c.id, 0.9, 'ai'
    FROM n JOIN entities c ON c.tenant_id = '${tenantId}' AND c.customer_number = 'C-' || lpad(((n.rn % ${CUSTOMERS}) + 1)::text, 5, '0');
`);
if (!seeded) await lite.exec(`
  INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence)
  SELECT '${tenantId}', d.id, k.key, k.key || '-' || md5(d.id::text), 0.9
    FROM documents d CROSS JOIN (VALUES ('serial_number'), ('service_date')) k(key) WHERE d.tenant_id = '${tenantId}';
  INSERT INTO intake_needs_info (tenant_id, document_id, field_key, question, candidates, status)
  SELECT '${tenantId}', id, 'customer_name', 'Who is this for?', '[{"value":"A","documentId":null},{"value":"B"}]'::jsonb, 'open'
    FROM documents WHERE tenant_id = '${tenantId}' ORDER BY created_at LIMIT ${NEEDS};
  ANALYZE;
`);
if (CACHE && !seeded) fs.writeFileSync(CACHE, Buffer.from(await (await lite.dumpDataDir('none')).arrayBuffer()));
console.log(`${seeded ? 'loaded cached' : 'seeded'} ${DOCS} docs / ${CUSTOMERS} customers / ${UNITS} units / ${NEEDS} open questions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const ctx = { tenantKey: 'org_big', tenantName: 'org_big' };
const rows = [];
const run = async (label, fn) => {
  const r = await measure(h, label, () => RS.withTenant(ctx, fn));
  const size = r.value == null ? '' : `${Math.round(JSON.stringify(r.value).length / 1024)} KB`;
  rows.push({ label, ms: r.ms, queries: r.queries, payload: size });
  return r.value;
};

const sinceIso = new Date(Date.now() - 30 * 864e5).toISOString();
await run('countDocuments (every upload gate + bootstrap)', (db) => db.countDocuments());
await run('countPagesSince (every upload gate + bootstrap)', (db) => db.countPagesSince(sinceIso));
await run('estimatePendingPages (every upload gate)', (db) => db.estimatePendingPages());
await run('listDocuments (client graph load, LIMIT 500)', (db) => db.listDocuments({}));
await run('listEntities (client graph load, LIMIT 500)', (db) => db.listEntities());
await run('browseDocuments page 1 (Records tab)', (db) => db.browseDocuments({ limit: 50 }, {}));
await run('browseDocuments filtered by type', (db) => db.browseDocuments({ type: 'invoice', limit: 50 }, {}));
await run('browseDocuments search "Customer 777"', (db) => db.browseDocuments({ q: 'Customer 777', limit: 50 }, {}));
await run('listCustomersSummary page 1 (200, recent)', (db) => db.listCustomersSummary({ limit: 200 }));
await run('listCustomersSummary offset 9800 (last page)', (db) => db.listCustomersSummary({ limit: 200, offset: Math.max(0, CUSTOMERS - 200) }));
await run('listCustomersSummary search "Customer 77"', (db) => db.listCustomersSummary({ like: '%Customer 77%', limit: 200 }));
await run('countCustomersSummary', (db) => db.countCustomersSummary({}));
await run('Inbox queue page 1 (20 of the open set)', async (db) => (await import('../api/_lib/intake/queue.js')).listIntakeQueue(db, { limit: 20 }));
await run('Inbox queue deep page (cursor)', async (db) => {
  const q = await import('../api/_lib/intake/queue.js');
  const first = await q.listIntakeQueue(db, { limit: 100 });
  return q.listIntakeQueue(db, { limit: 20, cursor: first.nextCursor });
});
await run('listStuckDocuments-style scan (stage=received, 60m)', (db) => db.raw(`SELECT id FROM documents WHERE stage='received' AND extract_error IS NULL AND created_at < NOW() - interval '60 minutes' AND tenant_id = (current_setting('app.tenant_id', true))::uuid LIMIT 200`, []));
await run('searchPassages (Donovan retrieval, full-text)', (db) => db.searchPassages('capacitor replaced Customer 4000', 12));
await run('listExtractionsByDocuments (500 ids)', async (db) => { const d = await db.listDocuments({}); return db.listExtractionsByDocuments(d.map((x) => x.id)); });

// Customers CSV export path (api/_lib/routes/export-csv.js): how many rows does it actually return?
const exported = await run('listCustomersSummary({limit: 10000}) as export-csv now calls it', (db) => db.listCustomersSummary({ limit: 10000, cap: 10000 }));
console.log(`\nexport-csv customers: asked for 10000, got ${exported.length} of ${CUSTOMERS}`);

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('query', 62) + pad('ms', 10) + pad('sql', 6) + 'payload');
for (const r of rows) console.log(pad(r.label, 62) + pad(r.ms, 10) + pad(r.queries, 6) + r.payload);
console.log(`\npool: connects=${h.stats.connects} peakOut=${h.stats.peakOut} stillOut=${h.stats.out}`);
process.exit(0);
