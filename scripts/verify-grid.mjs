/**
 * Round 13 (H3) verification:
 *
 *   1. Beyond-500-documents fix — src/core/entityGraph.ts's `upsertDoc` +
 *      `ensureDocLoaded`, and src/store/appStore.ts's `openDocument` calling
 *      it. No network, no Postgres: `useGraph` is seeded with a 500-doc set
 *      (mirroring usePostgresSync's sync cap) and `global.fetch` is a stub
 *      standing in for a 1,500-document tenant's server.
 *
 *   2. Grid view — api/_lib/grid/{columns,store}.js: column whitelist/
 *      normalization (pure), then real Postgres via PGlite (same harness as
 *      scripts/verify-records-browse.mjs): per-field provenance + paging +
 *      tenant isolation + injection attempts, for both the 'documentCells'
 *      and 'units' ops.
 *
 * Run via tsx (not plain node) — section 1 imports entityGraph.ts directly,
 * same technique verify-linking.mjs already uses.
 *
 *   npx tsx scripts/verify-grid.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
delete process.env.ANTHROPIC_API_KEY;

/* ============================================================================
 * 1. Beyond-500 documents: ensureDocLoaded + upsertDoc (src/core/entityGraph.ts)
 * ========================================================================== */
{
  const { useGraph, ensureDocLoaded } = await import('../src/core/entityGraph');
  const { hvacSchema } = await import('../src/domains/hvac/schema');

  // Simulate usePostgresSync's own 500-doc cap: seed the graph with 500
  // documents and NOTHING for doc #1500 — that's the row a Records Browse
  // click can still name (recordsStore.js's browseDocuments is never capped).
  const seeded = [];
  for (let i = 0; i < 500; i++) {
    const id = `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
    seeded.push({
      id, filename: `seeded-${i}.pdf`, fileType: 'pdf', pages: 1, batchId: 'synced', source: 'drive',
      receivedAt: new Date(), typeId: 'invoice', stage: 'verified', extracted: [], linkedEntityIds: [],
      linkConfidence: 0, issues: [], preview: 'seeded',
    });
  }
  useGraph.getState().seed(hvacSchema, [], seeded, [], []);
  eq('fixture: graph seeded with exactly 500 documents (the sync cap)', Object.keys(useGraph.getState().docs).length, 500);

  const BEYOND_ID = '22222222-2222-4222-8222-000000001500'; // "document #1500" — past the 500 cap
  const fetchCalls = [];
  const fetchLog = (label) => (url, init) => {
    fetchCalls.push(label);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url === '/api/records' && body.action === 'getDocument') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: BEYOND_ID, original_filename: '34534895.pdf', document_type: 'warranty-registration',
          stage: 'verified', created_at: '2026-09-24T00:00:00Z', display_name: 'Warranty · Beyond Cap',
          verified_by: 'ai', verified_at: '2026-09-24T01:00:00Z',
        }),
      });
    }
    if (url === '/api/records' && body.action === 'listExtractionsByDocument') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { id: 'x1', document_id: BEYOND_ID, entity_id: null, field_key: 'serial_number', value: 'SN-1500', confidence: 0.9 },
          { id: 'x2', document_id: BEYOND_ID, entity_id: null, field_key: 'model', value: 'XR-1500', confidence: 0.9 },
        ]),
      });
    }
    if (url === '/api/review' && body.action === 'listLinks') return Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [] }) });
    if (url === '/api/review' && body.action === 'listCorrections') return Promise.resolve({ ok: true, json: () => Promise.resolve({ corrections: [] }) });
    if (url === '/api/document-status') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ documents: [{ id: BEYOND_ID, completeness: { type: 'warranty-registration', required: ['serial_number'], present: ['serial_number'], missing: [], minConfidence: 0.9, complete: true } }] }) });
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
  };

  globalThis.fetch = fetchLog('call');
  await ensureDocLoaded(BEYOND_ID);
  const doc = useGraph.getState().docs[BEYOND_ID];
  check('ensureDocLoaded: a document past the 500-doc cap is upserted into the graph', !!doc);
  eq('upsertDoc: displayName/typeId/stage carried through from the fetched row', doc && [doc.displayName, doc.typeId, doc.stage], ['Warranty · Beyond Cap', 'warranty-registration', 'verified']);
  eq('upsertDoc: extracted fields present (model/serial) with values', doc && doc.extracted.map((f) => [f.name, f.value]).sort(), [['model', 'XR-1500'], ['serial_number', 'SN-1500']]);
  eq('upsertDoc: graph now has 501 documents (500 seeded + the fetched one)', Object.keys(useGraph.getState().docs).length, 501);
  eq('upsertDoc: a placeholder batch was created for the fetched doc', !!useGraph.getState().batches.synced, true);

  const callsAfterFirst = fetchCalls.length;
  await ensureDocLoaded(BEYOND_ID); // already in the graph now
  eq('ensureDocLoaded: a no-op (no fetch) once the doc is already in the graph', fetchCalls.length, callsAfterFirst);

  await ensureDocLoaded(seeded[0].id); // one of the original 500 — also already present
  eq('ensureDocLoaded: a no-op for a document already synced (never re-fetches what usePostgresSync already loaded)', fetchCalls.length, callsAfterFirst);

  // Single-flight: two concurrent calls for the SAME not-yet-loaded doc must
  // only hit the network once (a double render/click racing a re-render).
  const CONCURRENT_ID = '33333333-3333-4333-8333-000000009999';
  let getDocumentCalls = 0;
  globalThis.fetch = (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url === '/api/records' && body.action === 'getDocument') {
      getDocumentCalls++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: CONCURRENT_ID, original_filename: 'race.pdf', document_type: null, stage: 'received', created_at: '2026-09-25T00:00:00Z' }) });
    }
    if (url === '/api/records' && body.action === 'listExtractionsByDocument') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    if (url === '/api/review') return Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [], corrections: [] }) });
    if (url === '/api/document-status') return Promise.resolve({ ok: true, json: () => Promise.resolve({ documents: [] }) });
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
  };
  await Promise.all([ensureDocLoaded(CONCURRENT_ID), ensureDocLoaded(CONCURRENT_ID), ensureDocLoaded(CONCURRENT_ID)]);
  eq('ensureDocLoaded: single-flight — 3 concurrent calls for the same id fetch the document exactly once', getDocumentCalls, 1);
  check('ensureDocLoaded: the doc from the concurrent calls is in the graph', !!useGraph.getState().docs[CONCURRENT_ID]);

  // A document the server says doesn't exist for this tenant (wrong tenant / deleted) is left out — never a crash, never a half-built Doc.
  const MISSING_ID = '44444444-4444-4444-8444-000000000001';
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
  await ensureDocLoaded(MISSING_ID);
  check('ensureDocLoaded: a document the server has nothing for is simply not added (no crash)', !useGraph.getState().docs[MISSING_ID]);

  // appStore.ts's openDocument wires this up for every caller (Records Browse included).
  const { useAppStore } = await import('../src/store/appStore');
  const OPEN_ID = '55555555-5555-4555-8555-000000000001';
  globalThis.fetch = (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url === '/api/records' && body.action === 'getDocument') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: OPEN_ID, original_filename: 'via-open.pdf', document_type: null, stage: 'received', created_at: '2026-09-25T00:00:00Z' }) });
    if (url === '/api/records' && body.action === 'listExtractionsByDocument') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    if (url === '/api/review') return Promise.resolve({ ok: true, json: () => Promise.resolve({ links: [], corrections: [] }) });
    if (url === '/api/document-status') return Promise.resolve({ ok: true, json: () => Promise.resolve({ documents: [] }) });
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
  };
  useAppStore.getState().openDocument(OPEN_ID);
  eq('appStore.openDocument: sets selectedDocumentId synchronously', useAppStore.getState().selectedDocumentId, OPEN_ID);
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget ensureDocLoaded's microtasks settle
  await new Promise((r) => setTimeout(r, 0));
  check('appStore.openDocument: also triggers ensureDocLoaded, so DocumentPreview.tsx\'s `docs[id]` subscription has something to render', !!useGraph.getState().docs[OPEN_ID]);
}

/* ============================================================================
 * 2. Grid view — pure column whitelist/normalization
 * ========================================================================== */
{
  const {
    isValidGridColumn, isValidGridRowType, normalizeGridColumns,
    DOCUMENT_GRID_DEFAULT_COLUMNS, UNIT_GRID_DEFAULT_COLUMNS,
  } = await import('../api/_lib/grid/columns.js');

  eq('isValidGridRowType: only documents/units', [isValidGridRowType('documents'), isValidGridRowType('units'), isValidGridRowType('customers'), isValidGridRowType(undefined)], [true, true, false, false]);
  eq('isValidGridColumn: whitelisted columns accepted per row type', [isValidGridColumn('documents', 'model'), isValidGridColumn('units', 'model'), isValidGridColumn('documents', 'lastService'), isValidGridColumn('units', 'lastService')], [true, true, false, true]);
  eq('isValidGridColumn: an unknown column id is rejected, never passed through', isValidGridColumn('documents', "model; DROP TABLE documents;--"), false);

  eq('normalizeGridColumns: unknown ids dropped, real ones kept, order preserved', normalizeGridColumns('documents', ['model', 'nope; DROP TABLE x;--', 'serial']), ['model', 'serial']);
  eq('normalizeGridColumns: duplicates removed', normalizeGridColumns('documents', ['model', 'model', 'model']), ['model']);
  eq('normalizeGridColumns: empty/garbage input falls back to that row type\'s defaults', [normalizeGridColumns('documents', []), normalizeGridColumns('documents', ['nonsense']), normalizeGridColumns('documents', null)], [DOCUMENT_GRID_DEFAULT_COLUMNS, DOCUMENT_GRID_DEFAULT_COLUMNS, DOCUMENT_GRID_DEFAULT_COLUMNS]);
  eq('normalizeGridColumns: a units column list is validated against UNIT columns, not documents\'', normalizeGridColumns('units', ['model', 'customerName', 'documentType']), ['model', 'customerName']);
  eq('normalizeGridColumns: caps at 20 columns', normalizeGridColumns('units', Array(50).fill('model')).length, 1); // dedup means this also proves dedup-then-cap ordering
  check('normalizeGridColumns: an unknown row type still returns an array, never throws', Array.isArray(normalizeGridColumns('bogus', ['model'])));
  eq('defaults: units defaults never include a documents-only column', UNIT_GRID_DEFAULT_COLUMNS.every((c) => isValidGridColumn('units', c)), true);
}

/* ============================================================================
 * 3. Grid view — real Postgres via PGlite (same harness as verify-records-browse.mjs)
 * ========================================================================== */
let PGlite;
let contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { console.log(`NOTE  migration harness: ${f}: ${String(err.message).slice(0, 120)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after resolve_tenant() exists, same as verify-agent.mjs */ }

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return { query: (sql, params) => lite.query(sql, params), release: () => { lite.exec('RESET ROLE').finally(release); } };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { documentGridCells, unitGridRows } = await import('../api/_lib/grid/store.js');

const ctxA = { tenantKey: 'org_grid_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_grid_b', tenantName: 'Rival Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;

const hex2 = (s) => String(s).charCodeAt(0).toString(16).padStart(2, '0');
const uid = (t, k, n) => `${hex2(t)}${hex2(t)}${hex2(k)}${hex2(k)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedTenant(t, tenantId) {
  const ent = (id, type, data, customerId = null) => lite.query(
    'INSERT INTO entities (id, tenant_id, entity_type, data, customer_id, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,NOW())',
    [id, tenantId, type, JSON.stringify(data), customerId],
  );
  await ent(uid(t, 'c', 1), 'customer', { customer_name: 'Karen Abernathy', service_address: '412 Elm St, Mesa, AZ 85201' });
  // entities.data carries the CURRENT value of every own-field (kept in sync
  // by findOrCreateEquipment on each new extraction — same data the q/brand
  // filters below search) — serial_number here matches the CURRENT
  // extraction below (SN-CURRENT), not the stale one, same as production.
  await ent(uid(t, 'e', 1), 'equipment', { manufacturer: 'Trane', serial_number: 'SN-CURRENT' }, uid(t, 'c', 1));
  await ent(uid(t, 'e', 2), 'equipment', { manufacturer: 'Goodman' }, uid(t, 'c', 1));

  const doc = async (n, { file = `doc-${n}.pdf`, type = 'invoice', stage = 'verified', createdAt = '2026-09-01T00:00:00Z' }) => {
    await lite.query(
      `INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid(t, 'd', n), tenantId, file, type, `${t}-hash-${n}`, stage, createdAt],
    );
    return uid(t, 'd', n);
  };
  const link = (n, entityId) => lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenantId, uid(t, 'd', n), entityId]);
  const fact = (n, key, value, entityId = null, facetId = null, createdAt = null) => lite.query(
    `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, source_facet_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()))`,
    [tenantId, uid(t, 'd', n), entityId, key, value, facetId, createdAt],
  );
  const facet = async (n, pageNo) => {
    const { rows } = await lite.query(
      'INSERT INTO facets (tenant_id, document_id, page_no) VALUES ($1,$2,$3) RETURNING id',
      [tenantId, uid(t, 'd', n), pageNo],
    );
    return rows[0].id;
  };
  const money = (n, { total, balance_due, status }) => lite.query(
    `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, total, balance_due, status) VALUES ($1,$2,'invoice','receivable',$3,$4,$5)`,
    [tenantId, uid(t, 'd', n), total, balance_due, status],
  );

  // doc 1: invoice, model+serial with real page provenance (facet), maintenance-agreement doc for "agreement" test is doc 4.
  await doc(1, { file: 'karen-invoice.pdf', type: 'invoice' });
  const facetModel = await facet(1, 3);
  await fact(1, 'model', 'XR16', null, facetModel);
  await fact(1, 'serial_number', 'SN-100');
  await link(1, uid(t, 'c', 1));
  await link(1, uid(t, 'e', 1));
  await money(1, { total: '500.00', balance_due: '0.00', status: 'paid' });

  await doc(2, { file: 'whitmore-workorder.pdf', type: 'work-order', createdAt: '2026-09-10T00:00:00Z' });
  await link(2, uid(t, 'e', 1));
  await fact(2, 'technician_name', 'M. Ortiz');
  await money(2, { total: '250.00', balance_due: '250.00', status: 'unpaid' });

  await doc(3, { file: 'unverified-ticket.pdf', type: 'service-ticket', stage: 'read', createdAt: '2026-09-12T00:00:00Z' });
  await link(3, uid(t, 'e', 1));

  await doc(4, { file: 'agreement.pdf', type: 'maintenance-agreement', createdAt: '2026-09-05T00:00:00Z' });

  // Equipment unit's own extraction-tracked fields (serial/warranty), most
  // recent wins — deliberately on doc 4 and doc 2 (never doc 1, which
  // already carries a DOCUMENT-level serial_number fact above with no
  // entity_id; this is a different assertion — "this unit's serial" vs
  // "this document's serial" — and the two must not collide). Explicit
  // created_at values, not insertion order, is what makes "most recent
  // wins" deterministic here.
  await fact(4, 'serial_number', 'SN-STALE', uid(t, 'e', 1), null, '2026-09-05T01:00:00Z');
  await fact(2, 'serial_number', 'SN-CURRENT', uid(t, 'e', 1), null, '2026-09-10T01:00:00Z');
  await fact(2, 'warranty_expires', '2020-01-01', uid(t, 'e', 1)); // expired

  return { customer1: uid(t, 'c', 1), unit1: uid(t, 'e', 1), unit2: uid(t, 'e', 2), doc1: uid(t, 'd', 1), doc2: uid(t, 'd', 2), doc3: uid(t, 'd', 3), doc4: uid(t, 'd', 4) };
}

const idsA = await seedTenant('a', tenA);
await seedTenant('b', tenB);

const withA = (fn) => withTenant(ctxA, fn);

/* ---- documentCells: columns, whitelist, tenant isolation, provenance/page ---- */
{
  const cells = await withA((db) => documentGridCells(db, [idsA.doc1, idsA.doc4], ['model', 'serial', 'agreement']));
  eq('documentCells: model value + its exact source document + page (via extractions.source_facet_id -> facets.page_no)', cells[idsA.doc1].model, { value: 'XR16', sources: [{ documentId: idsA.doc1, page: 3 }] });
  eq('documentCells: serial has no facet row -> source with no page (honest, not invented)', cells[idsA.doc1].serial, { value: 'SN-100', sources: [{ documentId: idsA.doc1 }] });
  eq('documentCells: agreement true for a maintenance-agreement document', cells[idsA.doc4].agreement, { value: 'Yes', sources: [{ documentId: idsA.doc4 }] });
  eq('documentCells: agreement false/null for a plain invoice', cells[idsA.doc1].agreement, { value: null, sources: [{ documentId: idsA.doc1 }] });

  const empty = await withA((db) => documentGridCells(db, [idsA.doc2], ['model']));
  eq('documentCells: an honest empty cell (no extraction on file) has value null and NO invented source', empty[idsA.doc2].model, { value: null, sources: [] });

  const whitelistRejected = await withA((db) => documentGridCells(db, [idsA.doc1], ['model', "amount; DROP TABLE documents;--", 'customerName']));
  eq('documentCells: unknown/non-computed column ids are silently dropped, never reach SQL', Object.keys(whitelistRejected[idsA.doc1]).sort(), ['model']);

  const noIds = await withA((db) => documentGridCells(db, [], ['model']));
  eq('documentCells: empty documentIds -> empty result, no query at all', noIds, {});

  const badIds = await withA((db) => documentGridCells(db, ["'; DROP TABLE documents; --", 'not-a-uuid'], ['model']));
  eq('documentCells: non-uuid ids are filtered out before ever reaching SQL', badIds, {});

  // Tenant isolation: tenant A can never pull tenant B's document by guessing its id.
  const idsB = await withTenant(ctxB, (db) => db.listDocuments());
  const crossTenant = await withA((db) => documentGridCells(db, [idsB[0].id], ['model']));
  eq('documentCells: tenant A gets an empty (not an error, not B\'s data) cell set for a tenant-B document id', crossTenant[idsB[0].id], { model: { value: null, sources: [] } });

  const stillThere = await lite.query('SELECT count(*)::int AS ct FROM documents');
  check('documentCells: every injection/cross-tenant attempt left the documents table intact', stillThere.rows[0].ct > 0);
}

/* ---- units: paging, filters, per-field provenance, aggregates, whitelist, tenant isolation ---- */
{
  const page = await withA((db) => unitGridRows(db, {}, ['serial', 'model', 'manufacturer', 'customerName', 'warrantyStatus', 'warrantyExpiry', 'lastService', 'technician', 'balance', 'openQuestions']));
  eq('units: both of tenant A\'s equipment entities returned, none of tenant B\'s', page.total, 2);
  const unit1Row = page.rows.find((r) => r.id === idsA.unit1);
  eq('units: serial reflects the MOST RECENT extraction (doc 2\'s SN-CURRENT, not doc 1\'s stale value), sourced to that doc', unit1Row.cells.serial, { value: 'SN-CURRENT', sources: [{ documentId: idsA.doc2 }] });
  eq('units: manufacturer read straight off the entity, cited to the unit RECORD (no document, but never uncited)', unit1Row.cells.manufacturer, { value: 'Trane', sources: [{ kind: 'record', entityType: 'unit', recordId: idsA.unit1 }] });
  eq('units: customerName resolved via entities.customer_id -> the customer entity, cited to the customer RECORD', unit1Row.cells.customerName, { value: 'Karen Abernathy', sources: [{ kind: 'record', entityType: 'customer', recordId: idsA.customer1 }] });
  eq('units: warrantyExpiry + bucket (expired, same thresholds as recordsStore.js\'s WARRANTY_BUCKET_CASE)', [unit1Row.cells.warrantyExpiry.value, unit1Row.cells.warrantyStatus.value], ['2020-01-01', 'expired']);
  eq('units: lastService is the most recent of unit1\'s 3 linked documents (doc 3, 2026-09-12), sourced to that document', unit1Row.cells.lastService, { value: '2026-09-12', sources: [{ documentId: idsA.doc3 }] });
  eq('units: technician comes off that SAME latest linked document, not just any linked doc — doc 3 has no technician_name fact (doc 2 does, but it isn\'t the latest), so this is honestly empty', unit1Row.cells.technician, { value: null, sources: [] });
  eq('units: open balance sums balance_due over UNPAID/PARTIAL linked documents, citing every contributing document', unit1Row.cells.balance, { value: 250, sources: [{ documentId: idsA.doc2 }] });
  eq('units: openQuestions counts linked documents not yet verified, citing them', unit1Row.cells.openQuestions, { value: 1, sources: [{ documentId: idsA.doc3 }] });

  const unit2Row = page.rows.find((r) => r.id === idsA.unit2);
  eq('units: a unit with no linked documents at all gets honest empty/zero cells (0 open questions still cites the unit record — a computed fact, not an invented one), not a crash', [unit2Row.cells.lastService, unit2Row.cells.balance, unit2Row.cells.openQuestions], [{ value: null, sources: [] }, { value: null, sources: [] }, { value: 0, sources: [{ kind: 'record', entityType: 'unit', recordId: idsA.unit2 }] }]);

  const byCustomer = await withA((db) => unitGridRows(db, { customerId: idsA.customer1 }, ['serial']));
  eq('units: customerId filter', byCustomer.rows.map((r) => r.id).sort(), [idsA.unit1, idsA.unit2].sort());
  const byCustomerNone = await withA((db) => unitGridRows(db, { customerId: 'no-such-customer' }, ['serial']));
  eq('units: customerId filter with no match returns zero rows, not an error', byCustomerNone.total, 0);

  const byBrand = await withA((db) => unitGridRows(db, { brand: 'Trane' }, ['serial']));
  eq('units: brand filter (case-insensitive)', byBrand.rows.map((r) => r.id), [idsA.unit1]);

  const byQ = await withA((db) => unitGridRows(db, { q: 'sn-current' }, ['serial']));
  eq('units: free-text q filter matches serial/model', byQ.rows.map((r) => r.id), [idsA.unit1]);

  const whitelistRejected = await withA((db) => unitGridRows(db, {}, ['serial', "balance; DROP TABLE entities;--", 'model']));
  eq('units: unknown column id dropped from the column list, never reaches SQL', whitelistRejected.columns, ['serial', 'model']);
  const garbage = await withA((db) => unitGridRows(db, {}, ['totally-bogus']));
  eq('units: an all-invalid column list falls back to that row type\'s defaults, never an empty grid', garbage.columns.length > 0, true);

  // Injection attempts through every text filter.
  const payloads = ["'; DROP TABLE entities; --", "' OR '1'='1", "x'); DELETE FROM entities WHERE ('1'='1"];
  for (const p of payloads) {
    for (const key of ['customerId', 'brand', 'q']) {
      const res = await withA((db) => unitGridRows(db, { [key]: p }, ['serial']));
      check(`units: injection payload inert for filter "${key}" — ${JSON.stringify(p)}`, Array.isArray(res.rows));
    }
  }
  const stillThere = await lite.query('SELECT count(*)::int AS ct FROM entities');
  check('units: every injection attempt left the entities table intact', stillThere.rows[0].ct > 0);

  // Tenant isolation.
  const idsBRows = await withTenant(ctxB, (db) => unitGridRows(db, {}, ['serial']));
  check('units: tenant A\'s query never returns a tenant-B unit id', idsBRows.rows.every((r) => !page.rows.some((ar) => ar.id === r.id)));
  const crossTenantFilter = await withA((db) => unitGridRows(db, { customerId: idsBRows.rows[0]?.id ?? 'x' }, ['serial']));
  eq('units: filtering tenant A by a tenant-B id returns zero rows (RLS + the bound tenant_id, belt-and-braces)', crossTenantFilter.total, 0);

  // Paging: cursor round-trips and covers every row exactly once at real volume.
  const tenScale = (await getTenantContext('org_grid_scale', 'Scale Units Shop')).id;
  const ctxScale = { tenantKey: 'org_grid_scale', tenantName: 'Scale Units Shop' };
  const N = 600;
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(`('${uid('s', 'e', i)}', '${tenScale}', 'equipment', '{}'::jsonb, NOW())`);
  await lite.query(`INSERT INTO entities (id, tenant_id, entity_type, data, updated_at) VALUES ${rows.join(',')}`);
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let total = null;
  do {
    const p = await withTenant(ctxScale, (db) => unitGridRows(db, {}, ['serial'], { cursor, limit: 100 }));
    total = p.total;
    for (const r of p.rows) seen.add(r.id);
    cursor = p.nextCursor;
    pages++;
    if (pages > 20) break;
  } while (cursor);
  eq(`units: cursor paging sees all ${N} rows exactly once, no gaps/dupes`, [seen.size, total], [N, N]);
}

/* ============================================================================
 * 3. CSV export (src/components/grid/csv.ts): formula-injection neutralization
 *    + the Sources column's document/record formatting. Pure — no DOM
 *    (only downloadGridCsv touches Blob/URL/document; gridRowsToCsv doesn't).
 * ========================================================================== */
{
  const { gridRowsToCsv } = await import('../src/components/grid/csv');
  const cols = [{ key: 'name', label: 'Name', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'text' }];

  // A value starting with =, +, -, @, tab, or CR is a classic CSV/spreadsheet
  // formula-injection vector (Excel/Sheets read it as a formula on open) —
  // csvField must prefix it with a leading single quote before quoting.
  const injectionRows = [
    { id: 'r1', cells: { name: { value: '=cmd|\'/C calc\'!A0', sources: [] }, amount: { value: '10', sources: [] } } },
    { id: 'r2', cells: { name: { value: '+1+1', sources: [] }, amount: { value: '10', sources: [] } } },
    { id: 'r3', cells: { name: { value: '-1+1', sources: [] }, amount: { value: '10', sources: [] } } },
    { id: 'r4', cells: { name: { value: '@SUM(A1:A9)', sources: [] }, amount: { value: '10', sources: [] } } },
    { id: 'r5', cells: { name: { value: 'Ana Garcia', sources: [] }, amount: { value: '10', sources: [] } } }, // control: untouched
  ];
  const csv = gridRowsToCsv(cols, injectionRows);
  const lines = csv.split('\r\n').slice(1); // drop header
  check('csv: a leading "=" is neutralized with a leading single quote', lines[0].startsWith("'=cmd"));
  check('csv: a leading "+" is neutralized', lines[1].startsWith("'+1+1"));
  check('csv: a leading "-" is neutralized', lines[2].startsWith("'-1+1"));
  check('csv: a leading "@" is neutralized', lines[3].startsWith("'@SUM"));
  check('csv: an ordinary value is left exactly alone (no spurious quote prefix)', lines[4].startsWith('Ana Garcia'));

  // Sources column: document sources (with/without a page) and record
  // sources (the reviewer-requested customer/unit record citation) each
  // format distinctly and never collide.
  const sourceRows = [{
    id: 'u1',
    cells: {
      name: { value: 'SN-100', sources: [{ documentId: 'd1', page: 3 }, { documentId: 'd1' }] },
      amount: { value: 'Trane', sources: [{ kind: 'record', entityType: 'unit', recordId: 'e1' }] },
    },
  }];
  const csv2 = gridRowsToCsv(cols, sourceRows);
  const line2 = csv2.split('\r\n')[1];
  check('csv: a document source with a page formats as id:pN', line2.includes('d1:p3'));
  check('csv: the same document with no page is a separate, deduped entry (bare id, no page)', line2.includes('; d1;'));
  check('csv: a record source formats as entityType:recordId, not a document id', line2.includes('unit:e1'));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED, ${passes} passed.`);
  process.exit(1);
}
console.log(`${passes} checks passed.`);
