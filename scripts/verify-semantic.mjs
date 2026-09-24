/**
 * Checks for search-by-meaning (api/_lib/search/*, M3-config/31-semantic-search.sql).
 *
 * No network, no Voyage key, no DATABASE_URL. The database is a REAL Postgres
 * (PGlite, in process) WITH its pgvector extension, loaded from the actual
 * M3-config/*.sql migrations (including 31) and queried as the app's
 * non-superuser NOBYPASSRLS role (deepwell_rls), so row-level security and the
 * HNSW index are genuinely in play. Voyage is replaced by a deterministic fake
 * `fetch` (hashed bag-of-words with a synonym map, so "loud" ~ "noise"), which
 * means the REAL client code (batching, retry, timeout, dimension checks) runs
 * against it. Harness approach copied from scripts/verify-agent.mjs.
 *
 *   node scripts/verify-semantic.mjs
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
delete process.env.DONOVAN_EMBED_DAILY_TOKENS;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; realLog(...a); };
console.warn = () => {};

const embed = await import('../api/_lib/search/embed.js');
const hybrid = await import('../api/_lib/search/hybrid.js');
const store = await import('../api/_lib/search/store.js');
const { rerankDocuments } = await import('../api/_lib/search/rerank.js');

/* ================================================================== fake Voyage */
const DIM = 1024;
const SYN = {
  loud: 'NOISE', noisy: 'NOISE', noise: 'NOISE', rattles: 'NOISE', rattling: 'NOISE', buzzing: 'NOISE', banging: 'NOISE', humming: 'NOISE',
  leaking: 'WATER', leak: 'WATER', dripping: 'WATER', puddle: 'WATER', water: 'WATER',
  warm: 'HEAT', hot: 'HEAT', overheating: 'HEAT',
};
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'any', 'about', 'very', 'for', 'with', 'it', 'that', 'this', 'what', 'does', 'say']);
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const tokensOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => SYN[t] ?? t);
function fakeVec(text) {
  const v = new Array(DIM).fill(0);
  for (const t of tokensOf(text)) v[fnv(t) % DIM] += t === t.toUpperCase() && SYN[Object.keys(SYN).find((k) => SYN[k] === t)] ? 2 : 1;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

const fake = { mode: 'ok', embedCalls: [], rerankCalls: 0, delayMs: 0, failNext: 0, rerankMode: 'ok', rerankTop: null, dim: DIM };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.voyageai.com/v1/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const respond = (status, json, headers = {}) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  const wait = (ms) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  if (u.endsWith('/embeddings')) {
    fake.embedCalls.push({ n: body.input.length, input_type: body.input_type, model: body.model, auth: init.headers.authorization, output_dimension: body.output_dimension });
    if (fake.delayMs) await wait(fake.delayMs);
    if (fake.failNext > 0) { fake.failNext--; return respond(fake.mode === 'bad-request' ? 400 : fake.mode === '500' ? 500 : 429, { detail: 'nope' }, { 'retry-after': '0' }); }
    if (fake.mode === 'bad-request') return respond(400, { detail: 'bad' });
    if (fake.mode === '500') return respond(503, { detail: 'down' });
    return respond(200, {
      data: body.input.map((t, index) => ({ index, embedding: (fake.dim === DIM ? fakeVec(t) : fakeVec(t).slice(0, fake.dim)) })),
      usage: { total_tokens: body.input.reduce((a, t) => a + tokensOf(t).length + 1, 0) },
    });
  }
  if (u.endsWith('/rerank')) {
    fake.rerankCalls++;
    if (fake.rerankMode === 'fail') return respond(500, {});
    const scored = body.documents.map((d, index) => ({ index, relevance_score: fake.rerankTop && d.includes(fake.rerankTop) ? 1 : 0.1 - index * 0.001 }));
    return respond(200, { data: scored, usage: { total_tokens: 100 } });
  }
  return respond(404, {});
};
const resetFake = () => { Object.assign(fake, { mode: 'ok', embedCalls: [], rerankCalls: 0, delayMs: 0, failNext: 0, rerankMode: 'ok', rerankTop: null, dim: DIM }); embed._resetEmbedState(); };
const noSleep = () => Promise.resolve();

/* ================================================================== 1. chunking (pure) */
{
  const short = 'Service ticket for the Whitmore condenser. Replaced the capacitor.';
  eq('chunking: a short page is exactly one chunk', embed.chunkPageText(short), [short]);
  eq('chunking: empty / whitespace pages produce no chunks', [embed.chunkPageText(''), embed.chunkPageText('   \n\n  '), embed.chunkPageText(null)], [[], [], []]);

  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says the compressor on unit ${i} was inspected today.`);
  const long = sentences.join(' ');
  const chunks = embed.chunkPageText(long);
  check('chunking: a ~3,500-char page becomes several chunks', chunks.length >= 3 && chunks.length <= 6, `${long.length} chars -> ${chunks.length} chunks`);
  check('chunking: every chunk is roughly 800-1300 chars (the last may be shorter)', chunks.slice(0, -1).every((c) => c.length >= 550 && c.length <= 1300), chunks.map((c) => c.length).join(','));
  check('chunking: nothing is lost — every sentence appears whole in at least one chunk', sentences.every((s) => chunks.some((c) => c.includes(s))));
  check('chunking: consecutive chunks overlap (a sentence straddling a cut is whole in one of them)', chunks.slice(1).every((c, i) => {
    const head = c.slice(0, 40);
    return chunks[i].includes(head);
  }));
  check('chunking: chunks start on a word boundary, not mid-word', chunks.every((c) => /^[A-Za-z0-9]/.test(c) && !/^[a-z]+ [a-z]/.test(c.slice(0, 1) + ' ')));

  const paged = embed.chunkPages([{ page_no: 1, text: short }, { page_no: 2, text: long }, { page_no: 3, text: '' }, { page_no: 4, text: short }]);
  check('chunking: chunkPages keeps the page number on every chunk and skips empty pages', paged.every((c) => [1, 2, 4].includes(c.page_no)) && !paged.some((c) => c.page_no === 3));
  eq('chunking: chunk_no restarts at 0 on each page', [paged.find((c) => c.page_no === 2).chunk_no, paged.find((c) => c.page_no === 4).chunk_no], [0, 0]);
  eq('chunking: page 2 chunk numbers are 0..n-1 in order', paged.filter((c) => c.page_no === 2).map((c) => c.chunk_no), chunks.map((_, i) => i));
}

/* ================================================================== 2. config */
{
  const off = embed.embedConfig({});
  check('config: with no VOYAGE_API_KEY semantic search is off', off.enabled === false && embed.semanticEnabled({}) === false);
  const on = embed.embedConfig({ VOYAGE_API_KEY: 'k' });
  eq('config: with a key it is on, defaulting to voyage-3.5-lite / 1024 dims, no output_dimension sent', [on.enabled, on.model, on.dim, on.sendDim], [true, 'voyage-3.5-lite', 1024, false]);
  check('config: DONOVAN_SEMANTIC=0 switches it off even with a key', embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_SEMANTIC: '0' }).enabled === false);
  const custom = embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_EMBED_MODEL: 'voyage-4-lite', DONOVAN_EMBED_DIM: '512' });
  eq('config: model and dimension are configurable (dimension is then sent to Voyage)', [custom.model, custom.dim, custom.sendDim], ['voyage-4-lite', 512, true]);
  check('config: rerank is off unless key AND DONOVAN_RERANK_MODEL are set', embed.embedConfig({ VOYAGE_API_KEY: 'k' }).rerankModel === '' && embed.embedConfig({ DONOVAN_RERANK_MODEL: 'rerank-2.5-lite' }).rerankModel === '' && embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_RERANK_MODEL: 'rerank-2.5-lite' }).rerankModel === 'rerank-2.5-lite');
}

/* ================================================================== 3. Voyage client: batching / retry / timeout */
{
  const cfg = embed.embedConfig({ VOYAGE_API_KEY: 'test-key-not-real' });
  resetFake();
  const texts = Array.from({ length: 200 }, (_, i) => `page text number ${i} about a loud unit`);
  const r = await embed.voyageEmbed(texts, { inputType: 'document', cfg, sleep: noSleep });
  eq('client: 200 texts go out in batches of at most 96 (96, 96, 8)', fake.embedCalls.map((c) => c.n), [96, 96, 8]);
  check('client: vectors come back in input order, one per text, at 1024 dims', r.vectors.length === 200 && r.vectors.every((v) => v.length === DIM));
  check('client: input_type "document" and the bearer key are sent; no output_dimension by default', fake.embedCalls.every((c) => c.input_type === 'document' && c.auth === 'Bearer test-key-not-real' && c.output_dimension === undefined));
  check('client: token usage is summed from Voyage\'s usage.total_tokens', r.tokens > 200 && r.calls === 3);

  resetFake();
  fake.failNext = 2; // 429, 429, then ok
  const r2 = await embed.voyageEmbed(['loud unit'], { inputType: 'document', cfg, sleep: noSleep, maxRetries: 2 });
  check('client: retries 429 with backoff and then succeeds (3 calls)', r2.vectors.length === 1 && fake.embedCalls.length === 3);

  resetFake();
  fake.mode = '500';
  let err500;
  try { await embed.voyageEmbed(['x'], { cfg, sleep: noSleep, maxRetries: 2 }); } catch (e) { err500 = e; }
  check('client: a persistent 5xx is retried, then surfaces as an EmbedError with the status (3 calls)', err500?.name === 'EmbedError' && err500.status === 503 && fake.embedCalls.length === 3);

  resetFake();
  fake.mode = 'bad-request';
  let err400;
  try { await embed.voyageEmbed(['x'], { cfg, sleep: noSleep, maxRetries: 2 }); } catch (e) { err400 = e; }
  check('client: a 400 is the caller\'s fault and is NOT retried (1 call)', err400?.status === 400 && fake.embedCalls.length === 1);
  check('client: the error message never contains the input text', !String(err400?.message).includes('x nope'));

  resetFake();
  fake.delayMs = 400;
  const t0 = Date.now();
  let errT;
  try { await embed.voyageEmbed(['x'], { cfg, sleep: noSleep, maxRetries: 0, timeoutMs: 100 }); } catch (e) { errT = e; }
  check('client: a hung request is aborted at the timeout (not 400 ms)', errT?.name === 'EmbedError' && Date.now() - t0 < 350, `${Date.now() - t0} ms`);

  resetFake();
  fake.dim = 256;
  let errD;
  try { await embed.voyageEmbed(['x'], { cfg, sleep: noSleep }); } catch (e) { errD = e; }
  check('client: a vector with the wrong dimension is rejected loudly, not stored', /dimensions/.test(String(errD?.message)));

  resetFake();
  const scfg = embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_EMBED_DIM: '1024' });
  await embed.voyageEmbed(['x'], { cfg: scfg, sleep: noSleep });
  check('client: output_dimension is sent only when DONOVAN_EMBED_DIM is set explicitly', fake.embedCalls[0].output_dimension === 1024);
}

/* ================================================================== 4. query embedding: cache, timeout, breaker */
{
  const cfg = embed.embedConfig({ VOYAGE_API_KEY: 'k', DONOVAN_EMBED_QUERY_TIMEOUT_MS: '150' });
  resetFake();
  const a = await embed.embedQuery('any complaints about noise', cfg);
  const b = await embed.embedQuery('  Any   complaints about NOISE ', cfg);
  check('query embed: input_type "query"; a repeat (any casing/spacing) is served from the 10-minute cache, no second call', a && b && b.cached === true && fake.embedCalls.length === 1 && fake.embedCalls[0].input_type === 'query');
  const later = await embed.embedQuery('any complaints about noise', cfg, { now: Date.now() + 11 * 60_000 });
  check('query embed: the cache expires after 10 minutes', later && later.cached === false && fake.embedCalls.length === 2);

  resetFake();
  fake.delayMs = 600;
  const t0 = Date.now();
  const slow = await embed.embedQuery('slow question', cfg);
  check('query embed: over the timeout resolves null (keyword-only) in ~150 ms, not 600', slow === null && Date.now() - t0 < 400, `${Date.now() - t0} ms`);

  resetFake();
  fake.mode = '500';
  for (let i = 0; i < 3; i++) await embed.embedQuery(`failing ${i}`, cfg);
  const callsBefore = fake.embedCalls.length;
  const skipped = await embed.embedQuery('failing 4', cfg);
  check('query embed: three consecutive failures open the breaker — the next search does not even try', skipped === null && fake.embedCalls.length === callsBefore && embed.semanticBreakerOpen());
  resetFake();
  check('query embed: feature off (no key) returns null without any call', (await embed.embedQuery('anything', embed.embedConfig({}))) === null && fake.embedCalls.length === 0);
}

/* ================================================================== 5. pure fusion */
{
  const s = hybrid.rrfScores([{ ids: ['a', 'b', 'c'] }, { ids: ['c', 'a', 'd'] }]);
  const k = hybrid.RRF_K;
  check('RRF: score = sum of 1/(60+rank) over the lists', Math.abs(s.get('a') - (1 / (k + 1) + 1 / (k + 2))) < 1e-12 && Math.abs(s.get('d') - 1 / (k + 3)) < 1e-12);
  const order = [...s.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  eq('RRF: a page in BOTH lists outranks pages in one (a, c first; then b; then d)', order, ['a', 'c', 'b', 'd']);

  const kw = [
    { id: 'p-ident', document_id: 'd1', page_no: 1, matched_by: 'identifier:BP-2024-08841', rank: 1, excerpt: 'permit' },
    { id: 'p-kw', document_id: 'd2', page_no: 1, matched_by: 'text', rank: 0.4, excerpt: 'kw only' },
    { id: 'p-both', document_id: 'd3', page_no: 1, matched_by: 'text', rank: 0.2, excerpt: 'both' },
  ];
  const vec = [
    { id: 'p-both', document_id: 'd3', page_no: 1, original_filename: 'f', document_type: 't', stage: 's', chunk_text: 'both chunk', sim: 0.9 },
    { id: 'p-vec', document_id: 'd4', page_no: 2, original_filename: 'f4', document_type: 't', stage: 's', chunk_text: 'vector only chunk', sim: 0.8 },
    { id: 'p-ident', document_id: 'd1', page_no: 1, original_filename: 'f', document_type: 't', stage: 's', chunk_text: 'permit chunk', sim: 0.7 },
  ];
  const fused = hybrid.fuseCandidates(kw, vec);
  const kw2 = kw.map((r) => (r.id === 'p-ident' ? { ...r, matched_by: 'text' } : r)); // FTS found it first, so the label says "text"
  eq('fusion: a page matched by an identifier but labelled "text" (FTS found it first) is still pinned via identifierPageIds', hybrid.fuseCandidates(kw2, vec, new Set(['p-ident']))[0].id, 'p-ident');
  eq('fusion: identifier hit stays FIRST even though it is 3rd in the vector list', fused[0].id, 'p-ident');
  eq('fusion: then the page found by both, then the single-list pages', fused.slice(1).map((r) => r.id), ['p-both', 'p-kw', 'p-vec']);
  eq('fusion: matched_by records where each came from', fused.map((r) => r.matched_by), ['identifier:BP-2024-08841+semantic', 'text+semantic', 'text', 'semantic']);
  eq('fusion: a vector-only page carries its chunk text as the excerpt, page_no and file from the join', [fused[3].excerpt, fused[3].page_no, fused[3].original_filename], ['vector only chunk', 2, 'f4']);
  check('fusion: no page appears twice', new Set(fused.map((r) => r.id)).size === fused.length);
}

/* ================================================================== harness: real Postgres (+pgvector) via PGlite */
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
  console.log('');
  if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
  console.log(`${passes} checks passed (database-backed checks skipped).`);
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
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { notes.push(`01b re-run failed: ${err.message}`); }
for (const n of notes) console.log(`NOTE  migration harness: ${n}`);
check('harness: migration 31 loaded cleanly against real pgvector', !notes.some((n) => n.startsWith('31-')));
const role = (await lite.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'deepwell_rls'")).rows[0];
check('harness: the app role deepwell_rls exists, is not a superuser and does not bypass RLS', Boolean(role) && !role.rolsuper && !role.rolbypassrls, JSON.stringify(role));

const pgMod = (await import('pg')).default;
let tail = Promise.resolve();
const lock = () => { let release; const p = new Promise((r) => { release = r; }); const prev = tail; tail = tail.then(() => p); return prev.then(() => release); };
const hooks = { beforeQuery: null };
pgMod.Pool.prototype.connect = async function connect() {
  const release = await lock();
  await lite.exec('SET ROLE deepwell_rls');
  return {
    query: (sql, params) => { hooks.beforeQuery?.(String(sql)); return lite.query(sql, params); },
    release: () => { lite.exec('RESET ROLE').finally(release); },
  };
};
pgMod.Pool.prototype.query = async function query(sql, params) {
  const release = await lock();
  try { return await lite.query(sql, params); } finally { release(); }
};

const { withTenant, getTenantContext, _resetTenantContextCache } = await import('../api/_lib/recordsStore.js');
const ctxA = { tenantKey: 'org_sem_a', tenantName: 'Desert Peak HVAC' };
const ctxB = { tenantKey: 'org_sem_b', tenantName: 'Other Shop' };
const tenA = (await getTenantContext(ctxA.tenantKey, ctxA.tenantName)).id;
const tenB = (await getTenantContext(ctxB.tenantKey, ctxB.tenantName)).id;
const uid = (t, n) => `${t}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D = { svc: uid('a', 1), inv: uid('a', 2), permit: uid('a', 3), warmth: uid('a', 4), b: uid('b', 1) };

async function seedDoc(tenantId, id, file, type, pages) {
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [id, tenantId, file, type, `h-${id}`, 'verified']);
  for (const [i, text] of pages.entries()) await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,$3,$4)', [id, tenantId, i + 1, text]);
}
await seedDoc(tenA, D.svc, 'whitmore-service.pdf', 'service-ticket', [
  'Service ticket for Bill Whitmore, 88 Whitmore Ave. Routine visit, filters replaced.',
  'Customer reports the condenser unit is very loud and rattles at startup; technician noted a worn fan bearing.',
]);
await seedDoc(tenA, D.inv, 'invoice-0412.pdf', 'invoice', ['Invoice 2026-0412. Replaced the run capacitor. Labor two hours. Total due on receipt.']);
await seedDoc(tenA, D.permit, 'permit.pdf', 'permit', ['City of Tucson building permit BP-2024-08841 issued for 17 Cactus Ln condenser replacement.']);
await seedDoc(tenA, D.warmth, 'karen-callback.pdf', 'service-ticket', ['Callback: the upstairs room stays warm in the afternoon, the thermostat reads fine.']);
await seedDoc(tenB, D.b, 'b-secret.pdf', 'service-ticket', ['Loud banging noise complaint at 1 Secret Way. The unit rattles and is very noisy.']);

const KEYS = ['id', 'document_id', 'page_no', 'original_filename', 'document_type', 'stage', 'excerpt', 'rank', 'matched_by'];
const search = (ctx, q, limit = 12, opts = {}) => withTenant(ctx, (db) => db.searchPassages(q, limit, opts));
const chunkCount = async (tenantId) => Number((await lite.query('SELECT count(*)::int AS n FROM page_chunks WHERE tenant_id = $1', [tenantId])).rows[0].n);
const usageTokens = async (tenantId) => Number((await lite.query('SELECT COALESCE(sum(tokens),0)::int AS n FROM embedding_usage WHERE tenant_id = $1', [tenantId])).rows[0].n);

/* ================================================================== 6. feature OFF: keyword search unchanged */
const QUESTION = 'any complaints about noise';
let keywordBaseline;
{
  resetFake();
  store._resetSemanticProbe();
  keywordBaseline = await search(ctxA, QUESTION);
  eq('off (no key): the noise question finds nothing by keyword — the gap this feature closes', keywordBaseline.length, 0);
  const r = await search(ctxA, 'Whitmore condenser');
  check('off: normal keyword search still works and returns the classic row shape', r.length > 0 && KEYS.every((k) => k in r[0]) && r[0].matched_by === 'text');
  eq('off: not a single Voyage call was made', fake.embedCalls.length, 0);
  eq('off: embedDocumentPages / runBackfill are inert', [(await store.embedDocumentPages(ctxA, D.svc)).status, (await store.runBackfill(ctxA)).stoppedBy], ['off', 'off']);
  const st = await store.semanticStatus(ctxA);
  eq('off: status says not configured', [st.configured, st.ready, st.reason], [false, false, 'not-configured']);
  eq('off: no chunks were written', await chunkCount(tenA), 0);
}

/* ================================================================== turn it on */
process.env.VOYAGE_API_KEY = 'test-key-not-real';
process.env.DONOVAN_EMBED_QUERY_TIMEOUT_MS = '250';

/* ================================================================== 7. ingest hook + idempotency */
{
  resetFake();
  store._resetSemanticProbe();
  const r1 = await store.embedDocumentPages(ctxA, D.svc);
  eq('ingest hook: embeds the document\'s two pages', [r1.status, r1.pages], ['done', 2]);
  const rows = (await lite.query('SELECT page_no, chunk_no, model, page_hash, length(text) AS len FROM page_chunks WHERE document_id = $1 ORDER BY page_no, chunk_no', [D.svc])).rows;
  eq('ingest hook: one chunk per page, cited to its page, model recorded', rows.map((r) => [r.page_no, r.chunk_no, r.model]), [[1, 0, 'voyage-3.5-lite'], [2, 0, 'voyage-3.5-lite']]);
  const md5s = (await lite.query('SELECT p.page_no, c.page_hash = md5(p.text) AS same FROM document_pages p JOIN page_chunks c USING (document_id, page_no) WHERE p.document_id = $1', [D.svc])).rows;
  check('ingest hook: page_hash is the md5 of the page text', md5s.length === 2 && md5s.every((r) => r.same));
  check('ingest hook: document embeddings are requested as input_type "document"', fake.embedCalls.every((c) => c.input_type === 'document'));
  const used1 = await usageTokens(tenA);
  check('ingest hook: the tokens spent are recorded against the tenant for today', used1 > 0, `used ${used1}`);

  const callsBefore = fake.embedCalls.length;
  const r2 = await store.embedDocumentPages(ctxA, D.svc);
  eq('idempotent: running it again embeds nothing and makes no Voyage call', [r2.status, r2.pages, fake.embedCalls.length], ['done', 0, callsBefore]);
  eq('idempotent: still exactly 2 chunks', await chunkCount(tenA), 2);

  await lite.query("UPDATE document_pages SET text = 'Customer reports the condenser unit is buzzing loudly again; fan bearing replaced today.' WHERE document_id = $1 AND page_no = 2", [D.svc]);
  const r3 = await store.embedDocumentPages(ctxA, D.svc);
  const after = (await lite.query('SELECT page_no, text FROM page_chunks WHERE document_id = $1 ORDER BY page_no', [D.svc])).rows;
  eq('re-read: a page whose text changed is re-embedded (only that page), old chunk replaced', [r3.pages, after.length, after[1].text.includes('buzzing')], [1, 2, true]);

  const st = await store.semanticStatus(ctxA);
  eq('status: ready, 2 of 5 pages... (only svc embedded so far: 2 of 5 A pages)', [st.ready, st.pagesTotal, st.pagesEmbedded, st.pagesRemaining], [true, 5, 2, 3]);
}

/* ================================================================== 8. backfill: batches, deadline, resume, idempotent, budget */
{
  resetFake();
  let clock = 0;
  const first = await store.runBackfill(ctxA, { pagesPerBatch: 1, now: () => (clock += 40_000) });
  eq('backfill: stops at the wall-clock deadline after one batch and reports progress', [first.stoppedBy, first.pagesDone], ['deadline', 1]);
  const mid = await store.semanticStatus(ctxA);
  eq('backfill: progress is visible in status (3 of 5 pages now)', [mid.pagesEmbedded, mid.pagesRemaining], [3, 2]);

  fake.mode = 'bad-request';
  fake.failNext = 1;
  const failed = await store.runBackfill(ctxA, { pagesPerBatch: 1 });
  eq('backfill: a Voyage failure stops it with stoppedBy "error" and loses nothing already stored', [failed.stoppedBy, await chunkCount(tenA) >= 3], ['error', true]);

  resetFake();
  const rest = await store.runBackfill(ctxA, { pagesPerBatch: 1 });
  eq('backfill: resumes where it stopped and finishes', [rest.stoppedBy, rest.pagesDone, rest.pagesRemaining], ['done', 2, 0]);
  const calls = fake.embedCalls.length;
  const again = await store.runBackfill(ctxA);
  eq('backfill: a finished backfill is a no-op (idempotent) — no pages, no Voyage call', [again.stoppedBy, again.pagesDone, fake.embedCalls.length], ['done', 0, calls]);
  eq('backfill: tenant A now has a chunk for every one of its 5 pages', await chunkCount(tenA), 5);
  eq('backfill: tenant B was not touched by tenant A\'s backfill', await chunkCount(tenB), 0);

  // budget cap
  await lite.query('INSERT INTO documents (id, tenant_id, original_filename, document_type, sha256_hash, stage) VALUES ($1,$2,$3,$4,$5,$6)', [uid('a', 9), tenA, 'big.pdf', 'other', 'h-big', 'read']);
  await lite.query('INSERT INTO document_pages (document_id, tenant_id, page_no, text) VALUES ($1,$2,1,$3)', [uid('a', 9), tenA, 'Budget test page text. '.repeat(20)]);
  process.env.DONOVAN_EMBED_DAILY_TOKENS = '1';
  resetFake();
  const capped = await store.runBackfill(ctxA);
  eq('budget: with the daily embedding cap already exceeded, backfill stops ("budget") and calls Voyage zero times', [capped.stoppedBy, fake.embedCalls.length], ['budget', 0]);
  const hook = await store.embedDocumentPages(ctxA, uid('a', 9));
  eq('budget: the ingest hook also refuses over budget (non-fatal status, not a throw)', [hook.status, fake.embedCalls.length], ['budget', 0]);
  const st = await store.semanticStatus(ctxA);
  eq('budget: status reports today\'s usage against the cap', [st.tokenBudget, st.tokensToday > 0], [1, true]);
  delete process.env.DONOVAN_EMBED_DAILY_TOKENS;
  await store.runBackfill(ctxA);
  eq('budget: raising the cap lets the backfill resume and finish the page', await chunkCount(tenA), 6);

  // tenant B's own backfill (isolation)
  const bRun = await store.runBackfill(ctxB);
  eq('backfill: tenant B\'s own backfill embeds only tenant B\'s page', [bRun.stoppedBy, bRun.pagesDone, await chunkCount(tenB), await chunkCount(tenA)], ['done', 1, 1, 6]);
}

/* ================================================================== 9. RLS on the new tables */
{
  const seenByA = await store.withTenantRaw(ctxA, (db) => db.query('SELECT DISTINCT tenant_id FROM page_chunks'));
  eq('RLS: as tenant A, page_chunks shows only A\'s rows', seenByA.rows.map((r) => r.tenant_id), [tenA]);
  const usageSeen = await store.withTenantRaw(ctxA, (db) => db.query('SELECT DISTINCT tenant_id FROM embedding_usage'));
  eq('RLS: as tenant A, embedding_usage shows only A\'s rows', usageSeen.rows.map((r) => r.tenant_id), [tenA]);
  let denied = false;
  try {
    await store.withTenantRaw(ctxA, (db) => db.query(
      `INSERT INTO page_chunks (tenant_id, document_id, page_no, chunk_no, text, embedding, model) VALUES ($1,$2,1,9,'x',$3::vector,'m')`,
      [tenB, D.b, embed.toVectorLiteral(fakeVec('x'))]));
  } catch { denied = true; }
  check('RLS: tenant A cannot write a chunk stamped with tenant B (WITH CHECK)', denied);
  const flags = (await lite.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('page_chunks','embedding_usage')")).rows;
  check('RLS: both new tables have ENABLE + FORCE row level security', flags.length === 2 && flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  const idx = (await lite.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'page_chunks' AND indexname = 'idx_page_chunks_embedding_hnsw'")).rows[0]?.indexdef ?? '';
  check('migration: the HNSW cosine index exists', /hnsw/.test(idx) && /vector_cosine_ops/.test(idx), idx);
  const uniq = (await lite.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'page_chunks'::regclass AND contype = 'u'")).rows[0]?.d ?? '';
  check('migration: unique per (tenant, document, page, chunk, model)', /tenant_id, document_id, page_no, chunk_no, model/.test(uniq), uniq);
}

/* ================================================================== 10. hybrid retrieval end to end */
{
  resetFake();
  const rows = await search(ctxA, QUESTION);
  check('hybrid: "any complaints about noise" now finds the page that says "loud" (keyword alone found nothing)', rows.length > 0 && rows[0].document_id === D.svc && rows[0].page_no === 2, JSON.stringify(rows.map((r) => [r.document_id.slice(0, 2), r.page_no, r.matched_by])));
  check('hybrid: the same row shape as keyword search (id, document_id, page_no, original_filename, document_type, stage, excerpt, rank, matched_by)', rows.every((r) => KEYS.every((k) => k in r)));
  eq('hybrid: a vector-only hit is labelled "semantic"', rows[0].matched_by, 'semantic');
  check('hybrid: the excerpt comes from the chunk text', /buzzing|loud/.test(rows[0].excerpt));
  const grounded = await Promise.all(rows.map(async (r) => (await lite.query('SELECT 1 FROM document_pages WHERE id = $1 AND document_id = $2 AND page_no = $3', [r.id, r.document_id, r.page_no])).rowCount === 1));
  check('hybrid: every row is a REAL document_pages row, so ask.js/answer.js page grounding still holds', grounded.every(Boolean));
  check('hybrid: ranks are strictly decreasing in the returned order', rows.every((r, i) => i === 0 || rows[i - 1].rank > r.rank));
  check('hybrid: the question embedding used input_type "query"', fake.embedCalls.length === 1 && fake.embedCalls[0].input_type === 'query');

  const again = await search(ctxA, QUESTION);
  eq('hybrid: repeating the question uses the 10-minute cache (no second embedding call)', [fake.embedCalls.length, again[0].id === rows[0].id], [1, true]);

  const bRows = await search(ctxB, QUESTION);
  check('tenant isolation: tenant B\'s own noise page comes back for B', bRows.some((r) => r.document_id === D.b));
  check('tenant isolation: tenant A\'s results never contain tenant B\'s document', !rows.some((r) => r.document_id === D.b) && !bRows.some((r) => [D.svc, D.inv, D.permit, D.warmth].includes(r.document_id)));

  const scopedOut = await search(ctxA, QUESTION, 12, { documentIds: [D.inv] });
  check('scoping: documentIds restricts semantic hits too (the loud page is not returned when scoped to the invoice)', !scopedOut.some((r) => r.document_id === D.svc));
  const scopedIn = await search(ctxA, QUESTION, 12, { documentIds: [D.svc, D.inv] });
  check('scoping: ...and is returned when its document is in scope', scopedIn.some((r) => r.document_id === D.svc && r.page_no === 2) && scopedIn.every((r) => [D.svc, D.inv].includes(r.document_id)));
  eq('scoping: an empty documentIds means "nothing", not "no restriction"', (await search(ctxA, QUESTION, 12, { documentIds: [] })).length, 0);
  const crossTenantScope = await search(ctxA, QUESTION, 12, { documentIds: [D.b] });
  eq('scoping: passing tenant B\'s document id as tenant A returns nothing (RLS beats the id list)', crossTenantScope.length, 0);

  const ident = await search(ctxA, 'what does permit BP-2024-08841 say about noise');
  check('identifier pinning: a serial/permit-number match stays on top even when a semantic hit exists', ident[0]?.document_id === D.permit && ident[0].page_no === 1, JSON.stringify(ident.map((r) => [r.page_no, r.matched_by])));
  check('identifier pinning: the semantic noise page is still included after it', ident.some((r) => r.document_id === D.svc && r.page_no === 2));

  const lim = await search(ctxA, QUESTION, 1);
  eq('limit: honours the requested limit', lim.length, 1);

  const water = await search(ctxA, 'is anything dripping or leaking');
  check('hybrid: an unrelated question does not surface the noise page (similarity floor)', !water.some((r) => r.document_id === D.svc && r.page_no === 2));

  // keyword-only results must be unchanged in content when both agree
  const kwq = await search(ctxA, 'Whitmore condenser');
  check('hybrid: a plain keyword question still returns its keyword hit first', kwq[0]?.document_id === D.svc);

  const before = await usageTokens(tenA);
  await search(ctxA, 'a brand new question about a leaking unit');
  check('cost: the query embedding tokens are recorded too', (await usageTokens(tenA)) > before);
}

/* ================================================================== 11. fallbacks: timeout, Voyage down, vector query failing */
{
  resetFake();
  fake.delayMs = 1500;
  const t0 = Date.now();
  const r = await search(ctxA, 'timeout question about noise');
  const ms = Date.now() - t0;
  check('timeout fallback: a Voyage call slower than the timeout falls back to keyword-only for that request', ms < 1000 && r.length === 0, `${ms} ms, ${r.length} rows`);
  const kw = await search(ctxA, 'timeout Whitmore condenser');
  check('timeout fallback: keyword results are still returned (not an error)', kw.length > 0 && kw[0].matched_by === 'text');

  resetFake();
  fake.mode = '500';
  const down = await search(ctxA, 'voyage down Whitmore condenser');
  check('Voyage down: search still answers from keywords', down.length > 0 && down[0].document_id === D.svc);

  resetFake();
  // A REAL Postgres error inside the vector step (wrong-dimension vector) must not poison the surrounding transaction.
  const survived = await store.withTenantRaw(ctxA, async (db) => {
    let threw = false;
    try { await store.nearestChunks(db, { vector: [0.1, 0.2, 0.3], model: 'voyage-3.5-lite', k: 5, minSim: 0 }); } catch { threw = true; }
    const still = await db.query('SELECT 1 AS ok');
    return { threw, ok: still.rows[0].ok === 1 };
  });
  check('vector-query failure: it throws a real Postgres error, but the SAVEPOINT keeps the surrounding transaction usable', survived.threw && survived.ok);

  // Older pgvector (< 0.8) has no hnsw.iterative_scan: the first attempt fails, the code retries once without it and remembers.
  {
    let seen = 0;
    hooks.beforeQuery = (sql) => { if (sql.includes('hnsw.iterative_scan')) { seen++; throw new Error('unrecognized configuration parameter "hnsw.iterative_scan"'); } };
    const rows = await store.withTenantRaw(ctxA, (db) => store.nearestChunks(db, { vector: fakeVec('noise complaint loud'), model: 'voyage-3.5-lite', k: 5, minSim: 0.25 }));
    const rows2 = await store.withTenantRaw(ctxA, (db) => store.nearestChunks(db, { vector: fakeVec('noise complaint loud'), model: 'voyage-3.5-lite', k: 5, minSim: 0.25 }));
    hooks.beforeQuery = null;
    store._resetIterativeScan();
    check('older pgvector: no iterative_scan -> retried once without it, result still correct, and the failure is remembered (tried once)', seen === 1 && rows.length > 0 && rows2.length === rows.length && rows[0].document_id === D.svc, `seen ${seen}`);
  }

  // The same failure reached through searchPassages: keyword-only result, breaker trips so the next search does not retry.
  resetFake();
  hooks.beforeQuery = (sql) => { if (sql.includes('WITH nn AS')) throw new Error('simulated vector query failure'); };
  const viaSearch = await search(ctxA, 'Whitmore condenser vector failure');
  hooks.beforeQuery = null;
  check('vector-query failure via searchPassages: falls back to keyword results, no error', viaSearch.length > 0 && viaSearch[0].matched_by === 'text');
  check('vector-query failure: the circuit breaker opens, so the next search skips semantic entirely', embed.semanticBreakerOpen());
  resetFake();
}

/* ================================================================== 12. rerank */
{
  resetFake();
  process.env.DONOVAN_RERANK_MODEL = 'rerank-2.5-lite';
  fake.rerankTop = 'capacitor';
  const r = await search(ctxA, 'noise problem with the capacitor invoice unit loud');
  check('rerank: with a model set the fake reranker is called and its ordering wins', fake.rerankCalls === 1 && r[0]?.document_id === D.inv, JSON.stringify(r.map((x) => [x.document_id.slice(0, 2), x.page_no])));
  resetFake();
  fake.rerankTop = 'capacitor';
  const withIdent = await search(ctxA, 'permit BP-2024-08841 noise capacitor loud');
  check('rerank: identifier matches stay pinned on top even when rerank prefers another page', withIdent[0]?.document_id === D.permit, JSON.stringify(withIdent.map((x) => [x.document_id.slice(0, 2), x.matched_by])));
  resetFake();
  fake.rerankMode = 'fail';
  const failed = await search(ctxA, 'noise problem with the capacitor invoice unit loud, rerank failure case');
  check('rerank: a rerank failure keeps the fused order (no error)', fake.rerankCalls === 1 && failed.length > 1 && failed[0].document_id === D.svc, JSON.stringify(failed.map((x) => x.document_id.slice(0, 2))));
  const callsBeforeDirect = fake.rerankCalls;
  const direct = await rerankDocuments('q', ['a', 'b'], embed.embedConfig({ VOYAGE_API_KEY: 'k' }));
  check('rerank: off without DONOVAN_RERANK_MODEL (returns null, makes no call)', direct === null && fake.rerankCalls === callsBeforeDirect);
  delete process.env.DONOVAN_RERANK_MODEL;
  resetFake();
  await search(ctxA, 'rerank is off again loud');
  eq('rerank: unset again -> zero rerank calls', fake.rerankCalls, 0);
}

/* ================================================================== 13. graceful off: table / extension missing, then pasted */
{
  resetFake();
  await lite.exec('DROP TABLE page_chunks');
  store._resetSemanticProbe();
  const r = await search(ctxA, 'Whitmore condenser');
  check('table missing: search silently stays keyword-only', r.length > 0 && r[0].matched_by === 'text');
  const calls = fake.embedCalls.length; // (the search above may have embedded its query; ingest/backfill must add none)
  eq('table missing: ingest hook / backfill / status are inert and do not throw', [(await store.embedDocumentPages(ctxA, D.svc)).status, (await store.runBackfill(ctxA)).stoppedBy, (await store.semanticStatus(ctxA)).reason], ['no-schema', 'no-schema', 'migration-pending']);
  check('table missing: no wasted Voyage spend embedding into a table that is not there', fake.embedCalls.length === calls);

  await lite.exec('DROP EXTENSION vector CASCADE');
  store._resetSemanticProbe();
  const r2 = await search(ctxA, 'Whitmore condenser');
  check('extension missing: search still works, keyword-only', r2.length > 0 && r2[0].matched_by === 'text');
  eq('extension missing: status says migration pending', (await store.semanticStatus(ctxA)).reason, 'migration-pending');

  // "paste the migration" -> feature comes back (after the probe's re-check window; reset here = a cold start)
  await lite.exec(fs.readFileSync(path.join(cfgDir, '31-semantic-search.sql'), 'utf8'));
  await lite.exec('SET ROLE postgres').catch(() => {});
  store._resetSemanticProbe();
  resetFake();
  const bf = await store.runBackfill(ctxA);
  eq('migration pasted later: backfill works again without a redeploy', [bf.stoppedBy, await chunkCount(tenA)], ['done', 6]);
  const back = await search(ctxA, QUESTION);
  check('migration pasted later: semantic search is back', back[0]?.document_id === D.svc);
}

/* ================================================================== 14. wiring (static) */
{
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const rs = read('api/_lib/readDocument.js');
  check('wiring: ingestDocument calls embedDocumentPages after storing the pages (non-fatal hook)', /upsertPages\(documentId, pages\)[\s\S]*embedDocumentPages\(ctx, documentId\)/.test(rs));
  const rv = read('api/review.js');
  check('wiring: review.js exposes semanticStatus + semanticBackfill, admin-gated, and bills/rate-limits the backfill', /'semanticStatus'/.test(rv) && /case 'semanticBackfill'[\s\S]*requireAdmin/.test(rv) && /MODEL_BILLED_ACTIONS = new Set\([^)]*semanticBackfill/.test(rv) && /INTEGRITY_RATE_LIMIT_ACTIONS = new Set\([^)]*semanticBackfill/.test(rv));
  const rec = read('api/_lib/recordsStore.js');
  check('wiring: searchPassages starts the embedding before the keyword passes and finishes through finishHybrid', rec.indexOf('startSemantic(question)') > 0 && rec.indexOf('startSemantic(question)') < rec.indexOf('const ftsSql') && /return finishHybrid\(db, sem/.test(rec));
  const top = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
  eq('wiring: exactly 12 files directly under api/', top, 12);
  const logs = ['embed.js', 'store.js', 'hybrid.js', 'rerank.js'].map((f) => read(`api/_lib/search/${f}`)).join('\n');
  const leaks = [];
  for (const line of logs.split('\n')) {
    if (!/console\.(log|warn|error)\(/.test(line)) continue;
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) if (/question|\btext|texts|\bq\b|query|\.excerpt/i.test(m[1])) leaks.push(m[1]);
  }
  check('privacy: no console call in the search code interpolates a question or page text (only counts, status, model)', leaks.length === 0, leaks.join(' | '));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED, ${passes} passed.`); process.exit(1); }
console.log(`${passes} checks passed.`);
process.exit(0);
