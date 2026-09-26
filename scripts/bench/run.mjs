#!/usr/bin/env node
/**
 * Times the no-model answer paths (relations, analytics, financials,
 * contentCount, graph traverse, search) against a synthetic tenant produced
 * by scripts/bench/synth-tenant.mjs, with EXPLAIN plans and p50/p95 timings
 * per path, plus a missing-index scan (any Seq Scan touching a table above a
 * size threshold gets flagged).
 *
 * NO REAL DATABASE / PRODUCTION NETWORK (R11 hard rule): opens ONLY the
 * local, persisted PGlite directory synth-tenant.mjs wrote.
 *
 * Usage:
 *   node scripts/bench/run.mjs --dir scripts/bench/.data/tenant-30000 [--iterations 20] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

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
if (!args.dir) { console.error('usage: node scripts/bench/run.mjs --dir <synth-tenant output dir>'); process.exit(1); }
const DATA_DIR = path.resolve(ROOT, args.dir);
const ITERATIONS = Number(args.iterations) || 15;
const TODAY = args.today || '2026-09-25';

const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
console.log(`Bench tenant: ${manifest.docs} documents, ${manifest.customers} customers, ${manifest.equipment} equipment units (${DATA_DIR})`);

process.env.NEON_CONNECTION_STRING = 'postgres://harness:harness@localhost:5432/harness';
console.warn = () => {};

const { PGlite } = await import('@electric-sql/pglite');
const contrib = {};
for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
let vectorExt = null;
try { vectorExt = (await import('@electric-sql/pglite-pgvector')).vector; } catch { /* optional */ }
const lite = new PGlite(DATA_DIR, { extensions: vectorExt ? { ...contrib, vector: vectorExt } : contrib });
await lite.waitReady;

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

// Old manifests (generated before this file added clerk_org_id) still work:
// point the tenant's clerk_org_id at the key we're about to resolve with.
const tenantKey = manifest.tenantKey || `bench-${manifest.docs}-${manifest.seed}`;
await lite.query(`UPDATE tenants SET clerk_org_id = $1 WHERE id = $2 AND clerk_org_id IS NULL`, [tenantKey, manifest.tenantId]);

const { withTenant, getTenantContext } = await import(path.join(ROOT, 'api/_lib/recordsStore.js'));
const ctxArg = { tenantKey, tenantName: 'Bench Tenant' };
const resolvedId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
if (resolvedId !== manifest.tenantId) {
  console.error(`FATAL: resolved tenant id ${resolvedId} does not match manifest's ${manifest.tenantId} — is --dir pointing at a tenant produced by an OLDER synth-tenant.mjs with no clerk_org_id? Regenerate the corpus.`);
  process.exit(1);
}

const { executeAnalyticsPlan } = await import(path.join(ROOT, 'api/_lib/routes/analytics.js'));
const { parseMoneyIntent, runMoneyIntent } = await import(path.join(ROOT, 'api/_lib/financials/answers.js'));
const { parseContentCountQuestion, runContentCount } = await import(path.join(ROOT, 'api/_lib/contentCount.js'));
const { answerRelationsQuestion } = await import(path.join(ROOT, 'api/_lib/relations/questions.js'));
const { getSubgraph, getBacklinks } = await import(path.join(ROOT, 'api/_lib/graph/query.js'));
const rollups = await import(path.join(ROOT, 'api/_lib/rollups/index.js'));

/* ================================================================== helpers */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function stats(msList) {
  const sorted = [...msList].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length };
}

const SEQ_SCAN_SIZE_THRESHOLD = 500; // flag a Seq Scan only on a table with more than this many rows in this corpus
async function explainAndFindings(sql, params, label) {
  let plan = null;
  try {
    const { rows } = await lite.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    plan = rows[0]?.['QUERY PLAN']?.[0] ?? rows[0];
  } catch (err) {
    return { error: err.message };
  }
  const findings = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node['Node Type'] === 'Seq Scan' && (node['Actual Rows'] ?? 0) > SEQ_SCAN_SIZE_THRESHOLD) {
      findings.push(`Seq Scan on ${node['Relation Name']} (${node['Actual Rows']} rows) in ${label}`);
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan?.Plan ?? plan);
  return { totalMs: plan?.['Execution Time'] ?? plan?.Plan?.['Actual Total Time'] ?? null, findings };
}

async function timePath(name, { sql, params, run, iterations }) {
  const explain = sql ? await explainAndFindings(sql, params ?? [], name) : { findings: [] };
  const n = iterations ?? ITERATIONS;
  const timings = [];
  let lastResult = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    lastResult = await run();
    timings.push(performance.now() - t0);
  }
  const s = stats(timings);
  console.log(`  ${name.padEnd(38)} p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  (n=${s.n})${explain.findings.length ? `  ** ${explain.findings.join('; ')}` : ''}`);
  return { name, ...s, explainFindings: explain.findings, explainMs: explain.totalMs, sample: summarize(lastResult) };
}
function summarize(r) {
  if (r == null) return null;
  if (Array.isArray(r)) return { kind: 'array', length: r.length };
  if (r?.rows) return { kind: 'rows', length: r.rows.length };
  if (r?.nodes) return { kind: 'graph', nodes: r.nodes.length, edges: r.edges?.length };
  if (typeof r === 'object') return { kind: 'object', keys: Object.keys(r).slice(0, 6) };
  return { kind: typeof r };
}

const results = [];

/* ================================================================== fixtures: pick a real customer/equipment id */
const oneCustomer = (await lite.query(`SELECT id, data->>'service_address' AS addr FROM entities WHERE entity_type = 'customer' LIMIT 1`)).rows[0];
const oneEquipment = (await lite.query(`SELECT id FROM entities WHERE entity_type = 'equipment' LIMIT 1`)).rows[0];

console.log(`\nRunning ${ITERATIONS} iterations per path ...\n`);

/* ================================================================== 1. relations (full-corpus scan) */
results.push(await timePath('relations: most common brand', {
  run: () => answerRelationsQuestion({ withTenant, ctxArg, question: "What's our most common brand?", today: TODAY }),
}));

/* ================================================================== 2. analytics: groupBy brand (live) */
{
  const plan = { entity: 'equipment', op: 'groupBy', groupBy: 'brand', filters: [] };
  results.push(await timePath('analytics: groupBy brand (live SQL)', {
    sql: `SELECT id, customer_id, data->>'model' AS model, data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'tonnage' AS tonnage, data->>'refrigerant' AS refrigerant, data->>'installation_date' AS installation_date, data->>'service_address' AS service_address, data->'warranty' AS warranty, updated_at FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND tenant_id = $1 ORDER BY updated_at DESC LIMIT 500`,
    params: [manifest.tenantId],
    run: () => withTenant(ctxArg, (db) => executeAnalyticsPlan(db, plan, { today: TODAY })),
  }));
  // 2b. the SAME question answered from the rollup instead (this PR's own read path) — the
  // point-of-comparison number: an O(1) indexed lookup vs. the MAX_LIMIT-capped live scan above,
  // which UNDER-COUNTS once a tenant's equipment exceeds 500 rows (analytics.js's own MAX_LIMIT).
  await withTenant(ctxArg, (db) => rollups.refreshMetric(db, 'equipment_brand', { today: TODAY })); // warm it once, outside the timed loop
  results.push(await timePath('rollup: brand counts (this PR)', {
    run: () => withTenant(ctxArg, (db) => rollups.getBrandCounts(db, { today: TODAY })),
  }));
}

/* ================================================================== 3. financials: open invoices (global) */
{
  const intent = parseMoneyIntent('what are our open invoices', { today: TODAY });
  // iterations:1 — NOT a data-scale accident: this path is O(financials_rows x doc_links_size),
  // see the "doc_links materialization" finding in scripts/bench/README / the R11 report. At
  // 30k docs a single run already takes minutes; looping ITERATIONS times here would make the
  // whole benchmark hang. One timed sample is enough to show the blowup exists.
  results.push(await timePath('financials: open invoices (live SQL)', {
    iterations: 1,
    run: () => withTenant(ctxArg, (db) => runMoneyIntent(db, intent, { today: TODAY })),
  }));
  await withTenant(ctxArg, (db) => rollups.refreshMetric(db, 'open_invoices', { today: TODAY }));
  results.push(await timePath('rollup: open invoice totals (this PR)', {
    run: () => withTenant(ctxArg, (db) => rollups.getOpenInvoiceTotals(db, { today: TODAY })),
  }));
}

/* ================================================================== 4. contentCount: full corpus text scan */
{
  const parsed = parseContentCountQuestion('how many jobs mention a capacitor');
  results.push(await timePath('contentCount: "mention a capacitor" (full scan)', {
    sql: `SELECT p.document_id FROM document_pages p WHERE p.tenant_id = $1 AND p.text ~* $2`,
    params: [manifest.tenantId, '(capacitor|cap\\b|dual run cap)'],
    run: () => withTenant(ctxArg, (db) => runContentCount(db, parsed)),
  }));
}

/* ================================================================== 5. graph traverse */
if (manifest.hasGraph && oneCustomer) {
  const node = `customer:${oneCustomer.id}`;
  results.push(await timePath('graph: getSubgraph depth=2', {
    run: () => getSubgraph({ withTenant, ctxArg, node, depth: 2, edgeTypes: null, limit: 50, today: TODAY }),
  }));
  if (oneEquipment) {
    results.push(await timePath('graph: getBacklinks (unit)', {
      run: () => getBacklinks({ withTenant, ctxArg, node: `unit:${oneEquipment.id}`, limit: 50, today: TODAY }),
    }));
  }
}

/* ================================================================== 6. search (keyword — no VOYAGE_API_KEY, so keyword-only path) */
results.push(await timePath('search: searchPassages (full text)', {
  sql: `SELECT d.id FROM document_pages p JOIN documents d ON d.id = p.document_id WHERE p.tenant_id = $1 AND p.tsv @@ websearch_to_tsquery('english', $2) LIMIT 12`,
  params: [manifest.tenantId, 'noise complaint capacitor'],
  run: () => withTenant(ctxArg, (db) => db.searchPassages('noise complaint capacitor', 12)),
}));
results.push(await timePath('search: searchExtractions (trigram)', {
  sql: `SELECT x.id FROM extractions x WHERE x.tenant_id = $1 AND x.value ILIKE $2 LIMIT 25`,
  params: [manifest.tenantId, '%capacitor%'],
  run: () => withTenant(ctxArg, (db) => db.searchExtractions('capacitor', 25)),
}));

/* ================================================================== documents: no-index headline check */
results.push(await timePath('documents: count by tenant (headline finding)', {
  sql: `SELECT count(*) FROM documents WHERE tenant_id = $1`,
  params: [manifest.tenantId],
  run: () => lite.query('SELECT count(*) FROM documents WHERE tenant_id = $1', [manifest.tenantId]),
}));
results.push(await timePath('documents: count by tenant + type', {
  sql: `SELECT count(*) FROM documents WHERE tenant_id = $1 AND document_type = $2`,
  params: [manifest.tenantId, 'invoice'],
  run: () => lite.query('SELECT count(*) FROM documents WHERE tenant_id = $1 AND document_type = $2', [manifest.tenantId, 'invoice']),
}));

/* ================================================================== report */
console.log('\n=== summary ===');
const allFindings = results.flatMap((r) => r.explainFindings ?? []);
console.log(`${results.length} paths timed, ${allFindings.length} Seq Scan finding(s) above ${SEQ_SCAN_SIZE_THRESHOLD} rows:`);
for (const f of new Set(allFindings)) console.log(`  - ${f}`);

if (args.json) {
  const outPath = path.resolve(ROOT, args.json);
  fs.writeFileSync(outPath, JSON.stringify({ manifest, iterations: ITERATIONS, results }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

await lite.close?.();
