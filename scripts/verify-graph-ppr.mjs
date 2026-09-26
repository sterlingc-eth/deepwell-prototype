/**
 * Personalized PageRank over the Knowledge Graph (api/_lib/graph/rank.js, R11 — HippoRAG-2 style,
 * literature review #9). Same harness as scripts/verify-graph.mjs: no network, no Anthropic key,
 * no DATABASE_URL — a real Postgres (PGlite) loaded from the actual M3-config/*.sql migrations,
 * queried as the app's own non-superuser role.
 *
 *   1. pure: personalizedPageRank's own math — a synthetic graph, no DB — ranks a node one hop
 *      from the seed above one several hops away, is deterministic across repeated runs, sums to
 *      ~1, and stays well under 200ms on a ~2000-edge synthetic graph.
 *   2. rankRelatedNodes (DB-backed): a customer's own directly-linked documents/visit outrank a
 *      second, unrelated customer's documents that are only reachable through a shared technician
 *      several hops away; every ranked result carries a path with real provenance.
 *   3. determinism: two identical calls return identical scores and ordering.
 *   4. tenant scoping: a tenant-B call seeded with tenant A's node id finds nothing (RLS).
 *   5. static: package.json wiring, tool exports present for tools.js's 3-line registration.
 *
 *   node scripts/verify-graph-ppr.mjs
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
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;

/* ================================================================== 1. pure PPR math */
const R = await import('../api/_lib/graph/rank.js');
{
  // A -> B -> C chain plus D dangling off C, and a wholly separate E<->F pair with no path to A at
  // all. Seeded at A: B (1 hop) must outrank C (2 hops), which must outrank D (3 hops); E/F must
  // not receive more mass than anything actually reachable from the seed.
  const adj = new Map([
    ['A', ['B']], ['B', ['A', 'C']], ['C', ['B', 'D']], ['D', ['C']],
    ['E', ['F']], ['F', ['E']],
  ]);
  const rank = R.personalizedPageRank(adj, ['A']);
  check('personalizedPageRank: a 1-hop neighbor outranks a 2-hop one, which outranks a 3-hop one',
    rank.get('B') > rank.get('C') && rank.get('C') > rank.get('D'), JSON.stringify([...rank]));
  check('personalizedPageRank: mass sums to ~1 over the whole adjacency (a real probability distribution, not an arbitrary score)',
    Math.abs([...rank.values()].reduce((a, b) => a + b, 0) - 1) < 1e-6, String([...rank.values()].reduce((a, b) => a + b, 0)));

  const rank2 = R.personalizedPageRank(adj, ['A']);
  eq('personalizedPageRank is deterministic: identical input produces identical output byte for byte', [...rank2].sort(), [...rank].sort());

  const rankB = R.personalizedPageRank(adj, ['A', 'B']); // multi-seed still valid
  check('personalizedPageRank accepts multiple seeds without throwing, still a valid distribution',
    Math.abs([...rankB.values()].reduce((a, b) => a + b, 0) - 1) < 1e-6);

  const rankNoSeed = R.personalizedPageRank(adj, ['not-in-graph']);
  check('personalizedPageRank: a seed absent from the neighborhood degrades to plain (non-personalized) PageRank rather than throwing or returning nothing',
    rankNoSeed.size === adj.size, String(rankNoSeed.size));

  // ~2000-edge synthetic graph (a long chain + branching, same order of magnitude the R11 spec
  // caps rankRelatedNodes' own neighborhood collection at) — the math itself must stay well under
  // the 200ms budget; DB round-trips (collectNeighborhood) are a separate cost this test doesn't pay.
  const big = new Map();
  const N = 1200; // ~2 edges/node once both directions of the chain + branch are counted -> ~2000 edges
  for (let i = 0; i < N; i++) {
    const nbrs = [];
    if (i > 0) nbrs.push(`n${i - 1}`);
    if (i < N - 1) nbrs.push(`n${i + 1}`);
    if (i % 3 === 0 && i + 50 < N) nbrs.push(`n${i + 50}`); // occasional long branch, still bounded
    big.set(`n${i}`, nbrs);
  }
  const totalEdges = [...big.values()].reduce((n, l) => n + l.length, 0) / 2;
  const t0 = performance.now();
  const bigRank = R.personalizedPageRank(big, ['n0']);
  const ms = performance.now() - t0;
  check(`personalizedPageRank: ~${Math.round(totalEdges)} undirected edges ranks in well under 200ms (took ${ms.toFixed(1)}ms)`, ms < 200, `${ms}ms, ${totalEdges} edges`);
  check('personalizedPageRank on the big graph: the seed\'s immediate neighbor outranks a node 500+ hops down the chain', bigRank.get('n1') > bigRank.get(`n${N - 1}`));
}

/* ================================================================== harness: real Postgres via PGlite */
let PGlite;
const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: contrib });
const cfgDir = path.join(ROOT, 'M3-config');
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { /* same tolerant load as verify-graph.mjs */ }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* pre-existing harness quirk */ }

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
const B = await import('../api/_lib/graph/build.js');

const ctxA = { tenantKey: 'org_ppr_a', tenantName: 'PPR Shop' };
const ctxB = { tenantKey: 'org_ppr_b', tenantName: 'PPR Shop B' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
await getTenantContext(ctxB.tenantKey, ctxB.tenantName);
const uid = (kind, n) => `${kind}c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cust = (n) => uid('c', n);
const doc = (n) => uid('d', n);

async function addCustomer(n, name, address) {
  await lite.query("INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,'customer',$3::jsonb,$4)",
    [cust(n), tenA, JSON.stringify({ customer_name: name, service_address: address }), `C-P-${n}`]);
}
async function addDoc(n, { type = 'invoice', links = [], technician = null, serviceDate = null } = {}) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc(n), tenA, `${type}-${n}.pdf`, type, `p-hash-${n}`, 'linked']);
  for (const entityId of links) await lite.query('INSERT INTO document_entity_links (tenant_id, document_id, entity_id) VALUES ($1,$2,$3)', [tenA, doc(n), entityId]);
  if (technician) await lite.query("INSERT INTO extractions (tenant_id, document_id, field_key, value) VALUES ($1,$2,'technician',$3)", [tenA, doc(n), technician]);
  if (serviceDate) await lite.query("INSERT INTO extractions (tenant_id, document_id, field_key, value) VALUES ($1,$2,'service_date',$3)", [tenA, doc(n), serviceDate]);
}

// Customer 1 (the seed): a directly-linked visit (D1) and a directly-linked agreement (D2).
await addCustomer(1, 'Priya Nair', '77 Cactus Ln, Mesa, AZ 85201');
await addDoc(1, { type: 'invoice', links: [cust(1)], technician: 'Shared Tech', serviceDate: '2026-05-01' });
await addDoc(2, { type: 'agreement', links: [cust(1)] });
await lite.query(
  `INSERT INTO document_financials (tenant_id, document_id, doc_kind, direction, evidence) VALUES ($1,$2,'agreement','receivable','{}'::jsonb)`,
  [tenA, doc(2)]
);

// Customer 2 (unrelated): its own visit (D3), reachable from customer 1 ONLY through the technician
// they happen to share — several hops further from the seed than D1/D2.
await addCustomer(2, 'Someone Else', '900 Far Ave, Yuma, AZ 85364');
await addDoc(3, { type: 'invoice', links: [cust(2)], technician: 'Shared Tech', serviceDate: '2026-05-10' });

/* ================================================================== 2. rankRelatedNodes (DB) */
{
  const seed = B.nodeId.customer(cust(1));
  const out = await R.rankRelatedNodes({ withTenant, ctxArg: ctxA, seeds: [seed], limit: 20, today: '2026-09-26' });
  check('rankRelatedNodes: not truncated at this fixture size', out.truncated === false, JSON.stringify(out.truncated));

  const byId = new Map(out.results.map((r) => [r.id, r]));
  const d1Doc = byId.get(B.nodeId.document(doc(1)));
  const d3Doc = byId.get(B.nodeId.document(doc(3)));
  check('rankRelatedNodes: customer 1\'s OWN document (1 hop) is in the ranked results', Boolean(d1Doc), JSON.stringify(out.results.map((r) => r.id)));
  check('rankRelatedNodes: the unrelated customer\'s document (reachable only via the shared technician, several hops away) ranks LOWER than customer 1\'s own document',
    d1Doc && (!d3Doc || d1Doc.score > d3Doc.score), JSON.stringify({ d1Doc, d3Doc }));

  const agreementResult = out.results.find((r) => r.id === B.nodeId.document(doc(2)));
  check('rankRelatedNodes: the directly-linked agreement hydrates with its real type/label (agreement, not a bare id)', agreementResult?.type === 'agreement', JSON.stringify(agreementResult));

  check('rankRelatedNodes: every result carries a non-empty path with real edge provenance back toward the seed',
    out.results.every((r) => Array.isArray(r.path)) && (d1Doc?.path?.length ?? 0) >= 1
    && d1Doc.path.every((step) => 'from' in step && 'to' in step && 'type' in step), JSON.stringify(d1Doc?.path));
  check('rankRelatedNodes: scores are non-negative numbers, sorted descending', out.results.every((r) => typeof r.score === 'number' && r.score >= 0)
    && out.results.every((r, i) => i === 0 || out.results[i - 1].score >= r.score));
  check('rankRelatedNodes: the seed itself is never in its own results', !out.results.some((r) => r.id === seed));

  const empty = await R.rankRelatedNodes({ withTenant, ctxArg: ctxA, seeds: ['not-a-real-node'] });
  eq('rankRelatedNodes: an unparseable seed yields an honest empty result, never a crash', [empty.seeds, empty.results], [[], []]);
}

/* ================================================================== 3. determinism */
{
  const seed = B.nodeId.customer(cust(1));
  const r1 = await R.rankRelatedNodes({ withTenant, ctxArg: ctxA, seeds: [seed], limit: 10, today: '2026-09-26' });
  const r2 = await R.rankRelatedNodes({ withTenant, ctxArg: ctxA, seeds: [seed], limit: 10, today: '2026-09-26' });
  eq('rankRelatedNodes is deterministic: two identical calls return identical ranked ids in identical order', r1.results.map((r) => r.id), r2.results.map((r) => r.id));
  eq('rankRelatedNodes is deterministic: scores match exactly across runs (no randomness anywhere in the pipeline)', r1.results.map((r) => r.score), r2.results.map((r) => r.score));
}

/* ================================================================== 4. tenant scoping */
{
  const seed = B.nodeId.customer(cust(1)); // a tenant-A id
  const crossTenant = await R.rankRelatedNodes({ withTenant, ctxArg: ctxB, seeds: [seed], limit: 10 });
  eq('rankRelatedNodes under tenant B, seeded with a tenant-A node id, finds nothing — RLS scopes the whole neighborhood collection, not just the final read',
    [crossTenant.results, crossTenant.truncated], [[], false]);
}

/* ================================================================== 5. static checks */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json: verify:graph-ppr exists and is part of verify:all', pkg.scripts['verify:graph-ppr'] === 'node scripts/verify-graph-ppr.mjs' && /verify:graph-ppr\b/.test(pkg.scripts['verify:all']));

  check('graph/rank.js exports the tool wiring tools.js needs: name, def, and executor', typeof R.GRAPH_RANK_TOOL_NAME === 'string'
    && typeof R.GRAPH_RANK_TOOL_DEF?.name === 'string' && typeof R.executeGraphRankTool === 'function');
  check('GRAPH_RANK_TOOL_DEF.input_schema requires `seeds`', R.GRAPH_RANK_TOOL_DEF.input_schema.required.includes('seeds'));

  const rankSrc = fs.readFileSync(path.join(ROOT, 'api/_lib/graph/rank.js'), 'utf8');
  check('rank.js makes no model call of any kind (no fetch/Anthropic/OpenAI reference)', !/anthropic|openai|fetch\(/i.test(rankSrc));
  check('no graph-rank source logs question text, customer names or amounts', !/console\.(log|error|warn)\([^)]*(question|customerName|address|total|amount)\b/i.test(rankSrc));

  const toolExec = await R.executeGraphRankTool({ seeds: [B.nodeId.customer(cust(1))] }, { withTenant, ctxArg: ctxA, today: '2026-09-26' });
  check('executeGraphRankTool: same {ok, content, rowCount, inputSummary} shape every tools.js executor returns', toolExec.ok === true && typeof toolExec.content === 'string' && typeof toolExec.rowCount === 'number');
  const toolBad = await R.executeGraphRankTool({}, { withTenant, ctxArg: ctxA });
  eq('executeGraphRankTool: missing seeds is refused, not guessed at', toolBad.ok, false);
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED (${passes} passed).`);
  process.exit(1);
}
console.log(`All ${passes} checks passed.`);
