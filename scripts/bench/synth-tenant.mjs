#!/usr/bin/env node
/**
 * Generates a synthetic single-tenant corpus straight into the DATABASE
 * (not PDFs — scripts/synth-business.mjs already does that, at a much
 * smaller scale, for exam scoring; this is a scale benchmark, not an
 * accuracy one) with realistic distributions: customers, sites/equipment,
 * documents by type, extractions (service visits), document_financials
 * (invoices/POs), document_pages + page_chunks (fake embeddings — no
 * Voyage/model call), and kg_edges.
 *
 * NO REAL DATABASE, NO PRODUCTION NETWORK (R11 hard rule): this writes ONLY
 * into a local, persisted PGlite instance (default:
 * scripts/bench/.data/<tenant>), never to a real Postgres/Neon connection.
 *
 * PGlite (single-threaded WASM Postgres) is too slow to comfortably reach
 * 300k documents with all their related rows in this environment, so the
 * DEFAULT is 30,000 documents — scripts/bench/run.mjs's own report clearly
 * labels every number measured at 30k and extrapolates to 300k (~10x) rather
 * than silently presenting a smaller run as "the 300k benchmark". Pass
 * --docs 300000 yourself against a real local Postgres (never this
 * environment's PGlite) if you want the genuine number.
 *
 * Usage:
 *   node scripts/bench/synth-tenant.mjs [--docs 30000] [--out scripts/bench/.data/tenant-30k] [--seed 1]
 *
 * Deterministic: same --docs/--seed always produces the same corpus (a
 * mulberry32 PRNG, same idiom as scripts/synth-business.mjs), so a bench run
 * is reproducible and a regression is a real regression, not RNG noise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const N_DOCS = Number(args.docs) || 30_000;
const SEED = Number(args.seed) || 1;
const OUT_DIR = args.out ? path.resolve(ROOT, args.out) : path.join(ROOT, 'scripts', 'bench', '.data', `tenant-${N_DOCS}`);
const BATCH = 500;

if (N_DOCS >= 100_000) {
  console.log(`NOTE: generating ${N_DOCS} documents with PGlite — this environment's hard rule (no real DB) means this stays local/in-process; expect this to take a while and consider Ctrl-C + --docs 30000 if it stalls.`);
}

/* ---------------------------------------------------------------- deterministic RNG */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (p) => rng() < p;

/* ---------------------------------------------------------------- fixed vocab */
const BRANDS = ['Trane', 'Carrier', 'Goodman', 'Lennox', 'Rheem', 'York', 'Daikin', 'Mitsubishi', 'American Standard', 'Bryant', 'Payne', 'Ruud'];
const CITIES = [
  ['Mesa', 'AZ', ['85201', '85202', '85203', '85204', '85205', '85206']],
  ['Tempe', 'AZ', ['85281', '85282', '85283']],
  ['Chandler', 'AZ', ['85224', '85225', '85226']],
  ['Gilbert', 'AZ', ['85233', '85234', '85295']],
  ['Scottsdale', 'AZ', ['85250', '85251', '85254']],
  ['Phoenix', 'AZ', ['85003', '85004', '85008', '85015']],
  ['Glendale', 'AZ', ['85301', '85302', '85306']],
  ['Tucson', 'AZ', ['85701', '85704', '85710']],
];
const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Cedar Ln', 'Elm Dr', 'Desert Vista Rd', 'Val Vista Dr', 'University Dr', 'Baseline Rd', 'McKellips Rd'];
const FIRST_NAMES = ['James', 'Maria', 'Robert', 'Linda', 'David', 'Karen', 'John', 'Susan', 'Michael', 'Patricia', 'William', 'Jennifer', 'Carlos', 'Elena', 'Ahmed', 'Priya'];
const LAST_NAMES = ['Bracken', 'Whitmore', 'Isaacson', 'Reyes', 'Nguyen', 'Alvarez', 'Chen', 'Patel', 'Osei', 'Fitzgerald', 'Delgado', 'Kowalski'];
// document_type distribution matches the real corpus's mix (work orders and
// invoices dominate, agreements/statements are rare) — see
// scripts/synth-business.mjs's own DOC_TYPE notes for the same shape at
// exam-corpus scale.
const DOC_TYPE_WEIGHTS = [
  ['work_order', 0.42], ['invoice', 0.22], ['estimate', 0.10], ['receipt', 0.06],
  ['maintenance_agreement', 0.04], ['po', 0.05], ['statement', 0.03], ['correspondence', 0.05], [null, 0.03],
];
function weightedPick(weights) {
  const r = rng();
  let acc = 0;
  for (const [v, w] of weights) { acc += w; if (r <= acc) return v; }
  return weights[weights.length - 1][0];
}
const TECHS = ['M. Vega', 'J. Ruiz', 'K. Alden', 'S. Ortiz', 'D. Park', 'R. Cole'];

function addr() {
  const [city, state, zips] = pick(CITIES);
  return { line: `${int(100, 9999)} ${pick(['N', 'S', 'E', 'W'])} ${pick(STREETS)}`, city, state, zip: pick(zips) };
}
function fakeVector1024() {
  // Deterministic pseudo-embedding: NOT a real Voyage call (see module doc
  // comment) — just enough structure (unit-normalized, seeded) for pgvector's
  // HNSW index and <-> operator to have real, non-degenerate vectors to walk
  // during the bench's search-path timings.
  const v = new Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = rng() * 2 - 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  for (let i = 0; i < 1024; i++) v[i] = v[i] / n;
  return `[${v.map((x) => x.toFixed(6)).join(',')}]`;
}

/* ---------------------------------------------------------------- PGlite setup */
fs.mkdirSync(OUT_DIR, { recursive: true });
const { PGlite } = await import('@electric-sql/pglite');
const contrib = {};
for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
let vectorExt = null;
try { vectorExt = (await import('@electric-sql/pglite-pgvector')).vector; } catch { /* optional */ }
const lite = new PGlite(OUT_DIR, { extensions: vectorExt ? { ...contrib, vector: vectorExt } : contrib });

const cfgDir = path.join(ROOT, 'M3-config');
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
console.log(`Loading ${migrations.length} migrations into ${OUT_DIR} ...`);
const notes = [];
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 120)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { notes.push(`01b re-run: ${err.message}`); }
for (const n of notes) console.log(`  NOTE: ${n}`);

// BENCH FINDING (see final report): building the HNSW index incrementally,
// one row at a time as data loads, is dramatically slower than bulk-loading
// with no index and building it once at the end — standard pgvector
// practice, and the difference was large enough here (a 1000-doc batch's
// insert time visibly climbing as page_chunks grew) that generation itself
// needed this fix to finish in reasonable time. Recreated after all data is
// loaded, below.
try { await lite.exec('DROP INDEX IF EXISTS idx_page_chunks_embedding_hnsw'); } catch { /* table may not exist (migration 31 not applied) */ }

const hasVector = Boolean((await lite.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).rows.length);
const hasFinancials = Boolean((await lite.query("SELECT to_regclass('public.document_financials') IS NOT NULL AS ok")).rows[0]?.ok);
console.log(`pgvector: ${hasVector ? 'yes' : 'no (page_chunks skipped)'}; document_financials: ${hasFinancials ? 'yes' : 'no (skipped)'}`);

/* ---------------------------------------------------------------- tenant */
const TENANT_ID = crypto.randomUUID();
const TENANT_KEY = `bench-${N_DOCS}-${SEED}`;
// clerk_org_id set explicitly so scripts/bench/run.mjs can open this same
// tenant later through the app's normal getTenantContext/resolve_tenant path
// (api/_lib/recordsStore.js) instead of a second, parallel tenant-resolution
// mechanism just for benchmarking.
await lite.query(`INSERT INTO tenants (id, name, slug, clerk_org_id) VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`, [TENANT_ID, 'Bench Tenant', TENANT_KEY]);

/* ---------------------------------------------------------------- batched insert helper */
async function batchInsert(table, columns, rows, { conflict = null } = {}) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map((row) => {
      const placeholders = row.map((v) => { params.push(v); return `$${params.length}`; });
      return `(${placeholders.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict ?? ''}`;
    await lite.query(sql, params);
  }
}

/* ---------------------------------------------------------------- 1. customers + equipment */
const N_CUSTOMERS = Math.max(1, Math.round(N_DOCS / 12));
const N_EQUIPMENT = Math.max(1, Math.round(N_CUSTOMERS * 1.4));
console.log(`Generating ${N_CUSTOMERS} customers, ${N_EQUIPMENT} equipment units ...`);

const customerIds = Array.from({ length: N_CUSTOMERS }, () => crypto.randomUUID());
const customerAddr = [];
{
  const rows = [];
  for (let i = 0; i < N_CUSTOMERS; i++) {
    const a = addr();
    customerAddr.push(a);
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    rows.push([
      customerIds[i], TENANT_ID, 'customer',
      JSON.stringify({ customer_name: name, service_address: `${a.line}, ${a.city}, ${a.state} ${a.zip}`, phone: `480-555-${String(int(1000, 9999))}`, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com` }),
    ]);
  }
  await batchInsert('entities', ['id', 'tenant_id', 'entity_type', 'data'], rows.map((r) => [r[0], r[1], r[2], r[3]]));
}

const equipmentIds = Array.from({ length: N_EQUIPMENT }, () => crypto.randomUUID());
const equipmentCustomer = [];
const equipmentByCustomer = new Map(); // custIdx -> equipment idx[] (built once, O(N_EQUIPMENT) total — was an O(N_DOCS*N_EQUIPMENT) reduce-per-document before this fix)
{
  const rows = [];
  for (let i = 0; i < N_EQUIPMENT; i++) {
    const custIdx = int(0, N_CUSTOMERS - 1);
    equipmentCustomer.push(custIdx);
    if (!equipmentByCustomer.has(custIdx)) equipmentByCustomer.set(custIdx, []);
    equipmentByCustomer.get(custIdx).push(i);
    const brand = pick(BRANDS);
    const expiresYear = int(2019, 2032); // spread across expired/expiring/active
    rows.push([
      equipmentIds[i], TENANT_ID, 'equipment', customerIds[custIdx],
      JSON.stringify({
        manufacturer: brand, model: `${brand.slice(0, 2).toUpperCase()}${int(100, 999)}`,
        equipment_type: pick(['split system', 'package unit', 'heat pump']),
        tonnage: pick(['2', '2.5', '3', '3.5', '4', '5']),
        service_address: `${customerAddr[custIdx].line}, ${customerAddr[custIdx].city}, ${customerAddr[custIdx].state} ${customerAddr[custIdx].zip}`,
        warranty: chance(0.1) ? null : { expires: `${expiresYear}-${String(int(1, 12)).padStart(2, '0')}-01` },
      }),
    ]);
  }
  await batchInsert('entities', ['id', 'tenant_id', 'entity_type', 'customer_id', 'data'], rows);
}

/* ---------------------------------------------------------------- 2. documents (+ pages, chunks, extractions, financials, links) */
console.log(`Generating ${N_DOCS} documents ...`);
let pageRows = [], chunkRows = [], extractionRows = [], finRows = [], linkRows = [], docRows = [];
let docsWritten = 0;
const genStart = Date.now();
async function flush() {
  if (docRows.length) await batchInsert('documents', ['id', 'tenant_id', 'original_filename', 'document_type', 'sha256_hash', 'stage', 'created_at'], docRows);
  if (pageRows.length) await batchInsert('document_pages', ['id', 'document_id', 'tenant_id', 'page_no', 'text'], pageRows);
  if (hasVector && chunkRows.length) await batchInsert('page_chunks', ['id', 'tenant_id', 'document_id', 'page_no', 'chunk_no', 'text', 'embedding', 'model'], chunkRows);
  if (extractionRows.length) await batchInsert('extractions', ['id', 'tenant_id', 'document_id', 'entity_id', 'field_key', 'value'], extractionRows);
  if (hasFinancials && finRows.length) await batchInsert('document_financials', ['tenant_id', 'document_id', 'doc_kind', 'direction', 'currency', 'total', 'amount_paid', 'balance_due', 'invoice_date', 'due_date', 'status'], finRows);
  if (linkRows.length) await batchInsert('document_entity_links', ['tenant_id', 'document_id', 'entity_id'], linkRows);
  docsWritten += docRows.length;
  docRows = []; pageRows = []; chunkRows = []; extractionRows = []; finRows = []; linkRows = [];
  const everyLog = N_DOCS > 20000 ? 5000 : 1000;
  if (docsWritten % everyLog === 0 || docsWritten === N_DOCS) console.log(`  ${docsWritten}/${N_DOCS} documents written (${((Date.now() - genStart) / 1000).toFixed(1)}s elapsed)`);
}

const PAGE_TEXT_TEMPLATES = [
  'Service ticket for the {brand} condenser at {addr}. Replaced the run capacitor and checked refrigerant levels. No noise complaints reported. Technician {tech}.',
  'Invoice #{inv} for work performed at {addr}. Diagnosed compressor issue on {brand} unit, replaced contactor. Customer reported a rattling noise before service.',
  'Maintenance visit at {addr}: cleaned coils, checked airflow, topped off refrigerant on {brand} heat pump. Unit is running normally, no leaks detected.',
  'Estimate for replacement {brand} system at {addr}. Existing unit is beyond economical repair; recommends full system replacement with a new {brand} package unit.',
  'Purchase order for parts: one run capacitor, one contactor, refrigerant R-410A, for job at {addr}.',
];

for (let i = 0; i < N_DOCS; i++) {
  const docId = crypto.randomUUID();
  const custIdx = int(0, N_CUSTOMERS - 1);
  const linkedEquipment = (equipmentByCustomer.get(custIdx) ?? []).slice(0, 3);
  const eqIdx = linkedEquipment.length ? pick(linkedEquipment) : int(0, N_EQUIPMENT - 1);
  const brand = pick(BRANDS);
  const a = customerAddr[custIdx];
  const docType = weightedPick(DOC_TYPE_WEIGHTS);
  const createdAt = new Date(Date.UTC(2024, 0, 1) + int(0, 640) * 86400000).toISOString();
  const isJob = docType === 'work_order' || docType === 'receipt' || docType === 'maintenance_agreement';

  docRows.push([docId, TENANT_ID, `${docType ?? 'doc'}-${i}.pdf`, docType, crypto.createHash('sha256').update(`${docId}`).digest('hex'), 'verified', createdAt]);

  const text = pick(PAGE_TEXT_TEMPLATES)
    .replace('{brand}', brand).replace('{addr}', `${a.line}, ${a.city}`)
    .replace('{tech}', pick(TECHS)).replace('{inv}', String(100000 + i));
  const pageId = crypto.randomUUID();
  pageRows.push([pageId, docId, TENANT_ID, 1, text]);
  if (hasVector) chunkRows.push([crypto.randomUUID(), TENANT_ID, docId, 1, 0, text, fakeVector1024(), 'bench-fake']);

  if (isJob || chance(0.5)) {
    const serviceDate = createdAt.slice(0, 10);
    extractionRows.push([crypto.randomUUID(), TENANT_ID, docId, null, 'service_date', serviceDate]);
    extractionRows.push([crypto.randomUUID(), TENANT_ID, docId, null, 'technician', pick(TECHS)]);
    extractionRows.push([crypto.randomUUID(), TENANT_ID, docId, equipmentIds[eqIdx], 'model', `${brand.slice(0, 2).toUpperCase()}${int(100, 999)}`]);
  }

  if (hasFinancials && (docType === 'invoice' || docType === 'estimate' || docType === 'po')) {
    const total = int(80, 4500);
    const paidFrac = pick([0, 0, 0.5, 1, 1, 1]);
    const paid = Math.round(total * paidFrac * 100) / 100;
    const status = paid === 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial';
    const invDate = createdAt.slice(0, 10);
    const dueDate = new Date(new Date(invDate).getTime() + int(-10, 45) * 86400000).toISOString().slice(0, 10);
    finRows.push([
      TENANT_ID, docId, docType === 'po' ? 'po' : docType, docType === 'po' ? 'payable' : 'receivable', 'USD',
      total, paid, Math.round((total - paid) * 100) / 100, invDate, dueDate, status,
    ]);
  }

  linkRows.push([TENANT_ID, docId, customerIds[custIdx]]);
  if (linkedEquipment.length) linkRows.push([TENANT_ID, docId, equipmentIds[eqIdx]]);

  if (docRows.length >= BATCH) await flush();
}
await flush();

/* ---------------------------------------------------------------- 3. kg_edges (customer -> equipment 'owns') */
const hasGraph = Boolean((await lite.query("SELECT to_regclass('public.kg_edges') IS NOT NULL AS ok")).rows[0]?.ok);
if (hasGraph) {
  console.log(`Generating ${N_EQUIPMENT} kg_edges (customer -> unit) ...`);
  const rows = equipmentCustomer.map((custIdx, i) => [
    TENANT_ID, `customer:${customerIds[custIdx]}`, `unit:${equipmentIds[i]}`, 'has_unit', null, 'entities', equipmentIds[i], null, null,
  ]);
  await batchInsert('kg_edges', ['tenant_id', 'from_node', 'to_node', 'edge_type', 'weight', 'source', 'source_id', 'document_id', 'page'], rows);
}

if (hasVector) {
  console.log('Rebuilding page_chunks HNSW index after bulk load ...');
  const t0 = Date.now();
  await lite.exec('CREATE INDEX IF NOT EXISTS idx_page_chunks_embedding_hnsw ON page_chunks USING hnsw (embedding vector_cosine_ops)');
  console.log(`  HNSW index built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const manifest = {
  seed: SEED, docs: N_DOCS, customers: N_CUSTOMERS, equipment: N_EQUIPMENT,
  tenantId: TENANT_ID, tenantKey: TENANT_KEY, hasVector, hasFinancials, hasGraph, generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Done. Manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
console.log(JSON.stringify(manifest, null, 2));
await lite.close?.();
