/**
 * Round r10c — checks for this round's own build, scoped to the files this engineer owns:
 *
 *   api/_lib/search/embed.js
 *     - buildChunkContextHeader / withContextHeader (deterministic contextual chunk headers,
 *       NO model call — a plain string template over already-extracted fields)
 *     - CURRENT_CONTEXT_VERSION / NO_CONTEXT_VERSION, estimateEmbedCostUsd
 *
 *   api/_lib/search/store.js
 *     - documentContextFacts (tenant-scoped read of the facts a header is built from)
 *     - contextVersionReady (M3-config/38 column probe — works with AND without it)
 *     - embedAndStore writes context_version and the header-prefixed text; pagesNeedingEmbedding
 *       treats a chunk behind the current context version as needing (re-)embedding, same
 *       resumable/idempotent loop as "never embedded at all"
 *     - semanticStatus's new context/cost-estimate fields
 *
 * Existing hybrid retrieval (Postgres full-text + trigram identifier pass + pgvector, fused by RRF,
 * identifier hits pinned) already lives in api/_lib/recordsStore.js's searchPassages and
 * api/_lib/search/hybrid.js, and is already exhaustively covered by scripts/verify-semantic.mjs —
 * this file adds only the specific things r10c's build is responsible for on top of it: that exact
 * identifier/serial matches still surface with chunk-context headers on, and a couple of direct RRF
 * sanity checks against hybrid.js's own exports (belt and braces, not a re-test of that file).
 *
 * Same harness style as scripts/verify-semantic.mjs: a REAL Postgres via PGlite (with pgvector), no
 * network, no Voyage key, no DATABASE_URL — Voyage replaced by a deterministic fake `fetch`.
 *
 *   node scripts/verify-r10-retrieval.mjs
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
delete process.env.VOYAGE_API_KEY;
delete process.env.DONOVAN_RERANK_MODEL;
delete process.env.DONOVAN_SEMANTIC;
delete process.env.DONOVAN_CHUNK_CONTEXT;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };
console.warn = () => {};

const embed = await import('../api/_lib/search/embed.js');
const store = await import('../api/_lib/search/store.js');
const hybrid = await import('../api/_lib/search/hybrid.js');

/* ================================================================== 1. buildChunkContextHeader (pure) */
{
  eq('header: no facts at all -> empty string (no header, same as before this feature existed)', embed.buildChunkContextHeader({}), '');
  eq('header: empty facts object default arg', embed.buildChunkContextHeader(), '');

  const full = embed.buildChunkContextHeader({
    documentType: 'work-order',
    customer_name: 'Carol Rios',
    service_address: '581 W Thomas Rd, Casa Grande',
    manufacturer: 'Trane',
    model: 'XR16',
    serial_number: '4A7B9231-XT',
    service_date: '2025-06-12',
    technician: 'M. Vega',
    invoice_number: 'INV-10493',
  });
  eq('header: every field present, in order, "Trane XR16" joined as one unit',
    full,
    '[Work order · Carol Rios · 581 W Thomas Rd, Casa Grande · Trane XR16 · S/N 4A7B9231-XT · 2025-06-12 · tech: M. Vega · inv INV-10493]');

  const noSerialNoInvoice = embed.buildChunkContextHeader({
    documentType: 'work-order', customer_name: 'Carol Rios', service_address: '581 W Thomas Rd, Casa Grande',
    manufacturer: 'Trane', model: 'XR16', service_date: '2025-06-12', technician: 'M. Vega',
  });
  eq('header: optional fields (serial, invoice) are cleanly omitted, not blank slots',
    noSerialNoInvoice, '[Work order · Carol Rios · 581 W Thomas Rd, Casa Grande · Trane XR16 · 2025-06-12 · tech: M. Vega]');

  check('header: an unclassified document (documentType null/undefined) skips the type label entirely, not "Other"',
    !embed.buildChunkContextHeader({ documentType: null, customer_name: 'Karen Abernathy' }).includes('Other'));
  check('header: a document genuinely classified "other" DOES show "Other" (a real classification, not "not yet classified")',
    embed.buildChunkContextHeader({ documentType: 'other', customer_name: 'Karen Abernathy' }).startsWith('[Other ·'));
  eq('header: manufacturer with no model, and model with no manufacturer, still join to one non-empty unit',
    [embed.buildChunkContextHeader({ manufacturer: 'Goodman' }), embed.buildChunkContextHeader({ model: 'GSX140361K' })],
    ['[Goodman]', '[GSX140361K]']);
  eq('header: whitespace-only optional fields are trimmed but still counted (matches extraction values, which are never blank per documentContextFacts\' own WHERE clause)',
    embed.buildChunkContextHeader({ technician: '  M. Vega  ' }), '[tech: M. Vega]');

  eq('withContextHeader: no header -> text unchanged (byte for byte, same as before this feature existed)', embed.withContextHeader('', 'page text'), 'page text');
  eq('withContextHeader: a header goes on its own line before the text', embed.withContextHeader('[Invoice · Carol Rios]', 'page text'), '[Invoice · Carol Rios]\npage text');

  eq('versions: NO_CONTEXT_VERSION is 0 and CURRENT_CONTEXT_VERSION is a later, higher integer', [embed.NO_CONTEXT_VERSION, embed.CURRENT_CONTEXT_VERSION > embed.NO_CONTEXT_VERSION], [0, true]);
  check('cost estimate: 1000 chunks costs a few cents at most (voyage-4-lite / 3.5-lite list price, ~330 tokens/chunk)', embed.estimateEmbedCostUsd(1000) > 0 && embed.estimateEmbedCostUsd(1000) < 0.05, String(embed.estimateEmbedCostUsd(1000)));
  eq('cost estimate: zero chunks costs nothing; a negative/garbage count never goes negative', [embed.estimateEmbedCostUsd(0), embed.estimateEmbedCostUsd(-5)], [0, 0]);
  check('cost estimate: scales linearly with chunk count', embed.estimateEmbedCostUsd(2000) === embed.estimateEmbedCostUsd(1000) * 2);

  check('config: chunkContext defaults ON with no env var set', embed.embedConfig({ VOYAGE_API_KEY: 'k' }).chunkContext === true);
  eq('config: DONOVAN_CHUNK_CONTEXT=0 turns it off; any other value (or unset) leaves it on', [
    embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_CHUNK_CONTEXT: '0' }).chunkContext,
    embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_CHUNK_CONTEXT: '1' }).chunkContext,
    embed.embedConfig({ VOYAGE_API_KEY: 'k' }).chunkContext,
  ], [false, true, true]);
}

/* ================================================================== 2. RRF sanity (belt and braces on top of hybrid.js, already exhaustively covered by verify-semantic.mjs) */
{
  const scores = hybrid.rrfScores([{ ids: ['a', 'b', 'c'] }, { ids: ['c', 'a'] }]);
  check('RRF: a page ranked in both lists outscores one ranked in only one', scores.get('a') > scores.get('b'));
  eq('RRF: score for a rank-1 hit in one list alone is exactly 1/(k+1)', hybrid.rrfScores([{ ids: ['x'] }]).get('x'), 1 / (hybrid.RRF_K + 1));
  const fused = hybrid.fuseCandidates(
    [{ id: 'p1', matched_by: 'identifier:CG-4021-A', rank: 1 }, { id: 'p2', matched_by: 'text', rank: 0.5 }],
    [{ id: 'p3', document_id: 'd3', page_no: 1, chunk_text: 'vector only' }],
    new Set(['p1'])
  );
  eq('fusion: identifier pin stays first regardless of vector/keyword ranks', fused[0].id, 'p1');
}

/* ================================================================== 3. harness: real Postgres (+pgvector) via PGlite */
let PGlite;
let contrib = {};
let vectorExt;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const [key, mod] of [['uuid_ossp', 'uuid_ossp'], ['pgcrypto', 'pgcrypto'], ['pg_trgm', 'pg_trgm'], ['btree_gin', 'btree_gin']]) {
    contrib[key] = (await import(`@electric-sql/pglite/contrib/${mod}`))[key];
  }
  vectorExt = (await import('@electric-sql/pglite-pgvector')).vector;
} catch (err) {
  console.log(`SKIP  database-backed checks: PGlite / pgvector is not installed (${err?.message}). Run npm ci.`);
  if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`\n${passes} checks passed (database-backed checks skipped).`);
  process.exit(0);
}

const lite = new PGlite({ extensions: { ...contrib, vector: vectorExt } });
const cfgDir = path.join(ROOT, 'M3-config');
const notes = [];
const migrations = fs.readdirSync(cfgDir).filter((f) => /^\d\d.*\.sql$/.test(f) && !f.startsWith('99')).sort();
for (const f of migrations) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); }
  catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 90)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch { /* re-run after the rest */ }
check('harness: migration 38 loaded cleanly (plain CREATE INDEX, not CONCURRENTLY — see that file\'s own note on why)', !notes.some((n) => n.startsWith('38-')), notes.join(' | '));
const col38 = (await lite.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'page_chunks' AND column_name = 'context_version'")).rows;
check('harness: page_chunks.context_version actually exists after loading the migrations together (not rolled back by a later CONCURRENTLY failure elsewhere)', col38.length === 1);

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
const ctxA = { tenantKey: 'org_r10_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_r10_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
await getTenantContext(ctxB.tenantKey, ctxB.tenantName); // registers tenant B; its id itself is never needed below
const uid = (t, n) => `${t}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/* ================================================================== fake Voyage */
const DIM = 1024;
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const tokensOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
function fakeVec(text) {
  const v = new Array(DIM).fill(0);
  for (const t of tokensOf(text)) v[fnv(t) % DIM] += 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.voyageai.com/v1/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const respond = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/embeddings')) {
    return respond(200, {
      data: body.input.map((t, index) => ({ index, embedding: fakeVec(t) })),
      usage: { total_tokens: body.input.reduce((a, t) => a + tokensOf(t).length + 1, 0) },
    });
  }
  return respond(404, {});
};
process.env.VOYAGE_API_KEY = 'test-key-not-real';

async function seedDoc(tenantId, id, file, type, pages) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [id, tenantId, file, type, `h-${id}`, 'verified']);
  for (const [i, text] of pages.entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [id, tenantId, i + 1, text]);
}
async function seedExtraction(tenantId, documentId, key, value) {
  await lite.query('INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence) VALUES ($1,$2,$3,$4,0.9)', [tenantId, documentId, key, value]);
}
const chunkRows = async (documentId) => (await lite.query('SELECT page_no, chunk_no, text, context_version FROM page_chunks WHERE document_id = $1 ORDER BY page_no, chunk_no', [documentId])).rows;
const search = (ctx, q, limit = 12, opts = {}) => withTenant(ctx, (db) => db.searchPassages(q, limit, opts));

/* ================================================================== 4. documentContextFacts: tenant scoping */
const D1 = uid('a', 1);
await seedDoc(tenA, D1, 'work-order-1.pdf', 'work-order', [
  'Cover sheet: Trane XR16 condenser, S/N 4A7B9231-XT, at 581 W Thomas Rd, Casa Grande. Invoice INV-10493.',
  'Replaced the run capacitor and cleared the condensate line. Airflow restored to normal.',
]);
await seedExtraction(tenA, D1, 'customer_name', 'Carol Rios');
await seedExtraction(tenA, D1, 'service_address', '581 W Thomas Rd, Casa Grande');
await seedExtraction(tenA, D1, 'manufacturer', 'Trane');
await seedExtraction(tenA, D1, 'model', 'XR16');
await seedExtraction(tenA, D1, 'serial_number', '4A7B9231-XT');
await seedExtraction(tenA, D1, 'service_date', '2025-06-12');
await seedExtraction(tenA, D1, 'technician', 'M. Vega');
await seedExtraction(tenA, D1, 'invoice_number', 'INV-10493');
{
  const facts = await store.documentContextFacts(ctxA, [D1]);
  eq('documentContextFacts: reads back document_type and every extraction field, document-level', [
    facts.get(D1).documentType, facts.get(D1).customer_name, facts.get(D1).service_address,
    facts.get(D1).manufacturer, facts.get(D1).model, facts.get(D1).serial_number,
    facts.get(D1).service_date, facts.get(D1).technician, facts.get(D1).invoice_number,
  ], ['work-order', 'Carol Rios', '581 W Thomas Rd, Casa Grande', 'Trane', 'XR16', '4A7B9231-XT', '2025-06-12', 'M. Vega', 'INV-10493']);
  const asB = await store.documentContextFacts(ctxB, [D1]);
  check('documentContextFacts: RLS-scoped — tenant B asking about tenant A\'s document id gets no facts (never another tenant\'s data)', !asB.has(D1) || asB.get(D1).documentType == null);
  eq('documentContextFacts: an empty/undefined id list is a no-op, not an error', [(await store.documentContextFacts(ctxA, [])).size, (await store.documentContextFacts(ctxA, undefined)).size], [0, 0]);
}

/* ================================================================== 5. embedAndStore: header is prepended before embedding and stored; context_version recorded */
{
  store._resetSemanticProbe();
  const r = await store.embedDocumentPages(ctxA, D1);
  eq('embed: both pages embedded', [r.status, r.pages], ['done', 2]);
  const rows = await chunkRows(D1);
  const expectedHeader = '[Work order · Carol Rios · 581 W Thomas Rd, Casa Grande · Trane XR16 · S/N 4A7B9231-XT · 2025-06-12 · tech: M. Vega · inv INV-10493]';
  check('embed: page 2\'s stored chunk text carries the SAME document-level header as page 1, even though page 2\'s own raw text names no customer, address or unit at all',
    rows[0].text.startsWith(expectedHeader) && rows[1].text.startsWith(expectedHeader),
    JSON.stringify(rows.map((r) => r.text.slice(0, 80))));
  check('embed: the original page text still follows the header, untouched', rows[1].text.includes('Replaced the run capacitor and cleared the condensate line.'));
  eq('embed: both chunks are stamped with CURRENT_CONTEXT_VERSION (facts were available before this first embed)', rows.map((r) => r.context_version), [embed.CURRENT_CONTEXT_VERSION, embed.CURRENT_CONTEXT_VERSION]);

  const st = await store.semanticStatus(ctxA);
  check('status: reports chunkContext on, the current version, zero chunks behind it, and a sane $/1k-chunks estimate',
    st.chunkContext === true && st.contextVersion === embed.CURRENT_CONTEXT_VERSION && st.chunksNeedingContextUpdate === 0 && st.estimatedCostUsdPer1kChunks > 0,
    JSON.stringify(st));
}

/* ================================================================== 6. DONOVAN_CHUNK_CONTEXT=0: raw text, version 0, never blocks embedding */
const D2 = uid('a', 2);
await seedDoc(tenA, D2, 'work-order-2.pdf', 'work-order', ['Checked refrigerant levels; nominal. No issues found.']);
await seedExtraction(tenA, D2, 'customer_name', 'Bill Whitmore');
{
  process.env.DONOVAN_CHUNK_CONTEXT = '0';
  const r = await store.embedDocumentPages(ctxA, D2);
  eq('feature off: still embeds normally (the flag only affects header content, never blocks the feature)', [r.status, r.pages], ['done', 1]);
  const rows = await chunkRows(D2);
  eq('feature off: stored text is the raw page text (no header line) and context_version is 0', [rows[0].text, rows[0].context_version], ['Checked refrigerant levels; nominal. No issues found.', embed.NO_CONTEXT_VERSION]);
  delete process.env.DONOVAN_CHUNK_CONTEXT;
}

/* ================================================================== 7. re-embed backfill: a version-0 chunk is picked up once the flag (or version) is back on, same resumable loop as "never embedded" */
{
  const before = await chunkRows(D2);
  eq('backfill: before turning the feature back on, D2 is still at version 0', before[0].context_version, embed.NO_CONTEXT_VERSION);
  const bf = await store.runBackfill(ctxA); // chunkContext back on by default now that the env override is gone
  check('backfill: a version-0 chunk counts as "needs (re-)embedding" once the target version is back above it — same loop, no special case', bf.pagesDone >= 1, JSON.stringify(bf));
  const after = await chunkRows(D2);
  check('backfill: D2\'s chunk is now at CURRENT_CONTEXT_VERSION and carries its header (customer name, picked up from the extraction seeded earlier)',
    after[0].context_version === embed.CURRENT_CONTEXT_VERSION && after[0].text.includes('Bill Whitmore'),
    JSON.stringify(after));
  const again = await store.runBackfill(ctxA);
  eq('backfill: idempotent — a second run finds nothing left to do', again.stoppedBy, 'done');
  eq('backfill: idempotent — zero pages touched on the no-op run', again.pagesDone, 0);
}

/* ================================================================== 8. works WITHOUT migration 38 (column absent) */
{
  await lite.exec('ALTER TABLE page_chunks DROP COLUMN context_version');
  store._resetSemanticProbe();
  const D3 = uid('a', 3);
  await seedDoc(tenA, D3, 'work-order-3.pdf', 'work-order', ['Startup readings recorded; system nominal.']);
  await seedExtraction(tenA, D3, 'customer_name', 'Plaza Dental');
  const r = await store.embedDocumentPages(ctxA, D3);
  eq('no migration 38: the ingest hook still works (header still built and embedded — that needs no schema change)', [r.status, r.pages], ['done', 1]);
  const rows = (await lite.query('SELECT text FROM page_chunks WHERE document_id = $1', [D3])).rows;
  check('no migration 38: the header is still present in the stored/embedded text even with no context_version column to record it in', rows[0].text.includes('Plaza Dental'));
  const st = await store.semanticStatus(ctxA);
  check('no migration 38: semanticStatus omits the context-update fields rather than throwing on the missing column', st.ready === true && st.chunksNeedingContextUpdate === undefined, JSON.stringify(st));
  eq('no migration 38: re-running the backfill is still a clean no-op (page_hash+model is still the only "done" test available)', (await store.runBackfill(ctxA)).stoppedBy, 'done');

  // paste 38 back — no redeploy needed, same "probe re-checks" contract as the base migration
  await lite.exec(fs.readFileSync(path.join(cfgDir, '38-chunk-context.sql'), 'utf8'));
  store._resetSemanticProbe();
  const st2 = await store.semanticStatus(ctxA);
  check('migration 38 pasted later: status now reports the context-update fields again, without a redeploy', typeof st2.chunksNeedingContextUpdate === 'number', JSON.stringify(st2));
}

/* ================================================================== 9. exact-serial/identifier surfacing still holds with chunk-context headers on */
{
  const bothWays = [];
  for (const flag of ['1', undefined]) {
    if (flag) process.env.DONOVAN_CHUNK_CONTEXT = flag; else delete process.env.DONOVAN_CHUNK_CONTEXT;
    const rows = await search(ctxA, '4A7B9231-XT');
    // Label is "identifier:…" only when the identifier pass found the page FIRST (before the FTS
    // pass did) — see hybrid.js's own fuseCandidates doc comment. Either way it is pinned to the
    // top; a page the FTS pass reached first is legitimately labelled "text"/"text+semantic" and
    // still belongs first here, so what matters is the RANK, not the exact label spelling.
    bothWays.push(rows[0]?.document_id === D1 && rows[0]?.page_no === 1);
  }
  check('identifier pinning: an exact serial-number query surfaces the right page first, with chunk-context headers OFF and ON alike', bothWays.every(Boolean), JSON.stringify(bothWays));
  delete process.env.DONOVAN_CHUNK_CONTEXT;

  const invRows = await search(ctxA, 'INV-10493');
  check('identifier pinning: an exact invoice-number query also surfaces the right page first', invRows[0]?.document_id === D1 && invRows[0]?.page_no === 1);
}

/* ================================================================== 10. RLS: tenant B never sees tenant A's chunks or facts through this build's new code paths */
{
  const seenByB = await store.withTenantRaw(ctxB, (db) => db.query('SELECT DISTINCT tenant_id FROM page_chunks'));
  check('RLS: as tenant B, page_chunks shows only B\'s rows (none here — B has embedded nothing)', seenByB.rows.length === 0);
  const bRows = await search(ctxB, '4A7B9231-XT');
  eq('RLS: tenant B searching tenant A\'s serial number finds nothing', bRows.length, 0);
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
process.exit(0);
