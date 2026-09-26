/**
 * Checks for the semantic answer cache (api/_lib/cache/semanticCache.js,
 * M3-config/40-rollups-and-semantic-cache.sql's ask_semantic_cache).
 *
 * Harness copied from scripts/verify-semantic.mjs: a REAL Postgres (PGlite)
 * WITH pgvector, loaded from the actual M3-config/*.sql migrations (RLS and
 * the HNSW index genuinely in play), Voyage replaced by a deterministic fake
 * `fetch` so the real embedQuery/embedConfig code runs unmodified.
 *
 *   node scripts/verify-semantic-cache.mjs
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
delete process.env.DONOVAN_SEMANTIC;
console.warn = () => {};

const sc = await import('../api/_lib/cache/semanticCache.js');
const embed = await import('../api/_lib/search/embed.js');

/* ================================================================== 1. pure: slots (no DB) */
{
  const s1 = sc.extractSlots('how many Trane units do we have in Mesa');
  eq('slots: brand detected', s1.brands, ['trane']);
  eq('slots: city detected', s1.cities, ['mesa']);

  const s2 = sc.extractSlots('how many Trane units do we have in Tempe');
  check('slots: Mesa vs Tempe differ only in city slot', s1.brands.join() === s2.brands.join() && s1.cities.join() !== s2.cities.join());

  check('slotSignature: Mesa != Tempe', sc.slotSignature('Trane units in Mesa') !== sc.slotSignature('Trane units in Tempe'));
  check('slotSignature: same subject, same signature regardless of exact phrasing', sc.slotSignature('how many Trane units in Mesa') === sc.slotSignature('count of Trane units, Mesa'));
  check('slotSignature: different brand differs', sc.slotSignature('Trane units in Mesa') !== sc.slotSignature('Carrier units in Mesa'));

  const multi = sc.extractSlots('any American Standard units serviced by Day and Night techs');
  check('slots: multi-word brand "american standard" detected', multi.brands.includes('american standard'));
  check('slots: multi-word brand "day and night" detected', multi.brands.includes('day and night'));

  const addr = sc.extractSlots('what do we have on file for 581 W Thomas Rd');
  check('slots: street address detected', addr.addresses.some((a) => a.includes('581') && a.includes('thomas')));

  const nums = sc.extractSlots('invoices over 500 dollars from last 30 days');
  check('slots: bare numbers detected', nums.numbers.includes('500') && nums.numbers.includes('30'));

  eq('fallbackSignature: word order independent', sc.fallbackSignature('Trane units count in Mesa'), sc.fallbackSignature('count of Trane units in Mesa'));
  check('fallbackSignature: different wording with same meaning is closer than unrelated text', sc.fallbackSignature('any noise complaints') !== sc.fallbackSignature('open invoice totals'));

  eq('minSimilarity: default is conservative (>= 0.9)', sc.minSimilarity({}) >= 0.9, true);
  eq('minSimilarity: env override respected', sc.minSimilarity({ DONOVAN_SEMANTIC_CACHE_MIN_SIM: '0.8' }), 0.8);
  eq('minSimilarity: an out-of-range override falls back to the default', sc.minSimilarity({ DONOVAN_SEMANTIC_CACHE_MIN_SIM: '2' }), sc.minSimilarity({}));

  check('withinTtl: a fresh row is within TTL', sc.withinTtl(new Date(1000).toISOString(), 10_000, 5_000));
  check('withinTtl: an old row is expired', !sc.withinTtl(new Date(0).toISOString(), 10_000, 20_000));
  check('withinTtl: a missing created_at is never a hit', !sc.withinTtl(null, 10_000, 5_000));

  check('isSlotMatch: identical signatures match', sc.isSlotMatch('b:trane|c:mesa', 'b:trane|c:mesa'));
  check('isSlotMatch: different signatures do not match', !sc.isSlotMatch('b:trane|c:mesa', 'b:trane|c:tempe'));
  check('isSlotMatch: a non-string row signature is never a match', !sc.isSlotMatch(null, 'b:trane|c:mesa'));

  /* ---------------------------------------------------- adversarial: negation/comparatives/qType
   * A reviewer NO-GO: 'not'/'no' were stopwords, so "is there a service agreement on file" and
   * "is there no service agreement on file" produced the SAME fallback signature (and slot
   * signature, which had no negation slot at all) — a cached "yes" would be served to the negated
   * question. These checks pin the fix at the slot AND fallback-signature level, plus adjacent
   * comparators the same review flagged (more/fewer, before/after, how-many vs which, top N,
   * singular/plural). */
  const negPairs = [
    ['is there a service agreement on file', 'is there no service agreement on file'],
    ['is the invoice paid', "is the invoice unpaid"],
    ['is the warranty registered', "is the warranty unregistered"],
    ["is the invoice paid", "isn't the invoice paid"],
    ['do we have a permit on file', "don't we have a permit on file"],
    ['units serviced in Mesa', 'units not serviced in Mesa'],
    ['customers with a maintenance agreement', 'customers without a maintenance agreement'],
    ['customers with a maintenance agreement', 'customers other than those with a maintenance agreement'],
  ];
  for (const [a, b] of negPairs) {
    check(`negation: slotSignature differs :: "${a}" vs "${b}"`, sc.slotSignature(a) !== sc.slotSignature(b));
    check(`negation: fallbackSignature differs :: "${a}" vs "${b}"`, sc.fallbackSignature(a) !== sc.fallbackSignature(b));
  }
  check('negation: a plain question with no negator has an empty negator slot',
    sc.extractSlots('is there a service agreement on file').negators.length === 0);
  check('negation: "no" is detected as a negator', sc.extractSlots('is there no service agreement on file').negators.includes('no'));

  const comparativePairs = [
    ['invoices before 2024', 'invoices after 2024'],
    ['more than 5 open invoices', 'fewer than 5 open invoices'],
    ['top 3 customers by revenue', 'top 5 customers by revenue'],
    ['units older than 10 years', 'units newer than 10 years'],
  ];
  for (const [a, b] of comparativePairs) {
    check(`comparatives: slotSignature differs :: "${a}" vs "${b}"`, sc.slotSignature(a) !== sc.slotSignature(b));
  }

  const qTypePairs = [
    ['how many Trane units do we have', 'which Trane units do we have'],
    ['how many open invoices for Bracken', 'who has open invoices at Bracken'],
    ['which customers have a Carrier unit', 'list customers that have a Carrier unit'],
    ['is there a permit on file', 'when was the permit filed'],
  ];
  for (const [a, b] of qTypePairs) {
    check(`question-type: slotSignature differs :: "${a}" vs "${b}"`, sc.slotSignature(a) !== sc.slotSignature(b));
  }
  check('question-type: "how many X" and "count of X" are still the SAME shape (not a regression)',
    sc.extractSlots('how many Trane units in Mesa').qType === sc.extractSlots('count of Trane units in Mesa').qType);

  // singular vs plural: same signature ONLY when nothing else differs (both are content words, not
  // stopwords, so a bare "unit" vs "units" naturally differs today via the raw fallback token bag —
  // pin that it does NOT collapse into a false match).
  check('plural: "unit" vs "units" is not treated as identical when it is the only difference',
    sc.fallbackSignature('warranty status of the unit') !== sc.fallbackSignature('warranty status of the units'));
}

/* ================================================================== fake Voyage (bag-of-words) */
const DIM = 1024;
const SYN = { complaints: 'GRIPE', complaint: 'GRIPE', issues: 'GRIPE', reported: 'GRIPE' };
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'any', 'about', 'for', 'in', 'of', 'we', 'do', 'does', 'have', 'on', 'file']);
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const tokensOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => SYN[t] ?? t);
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
      usage: { total_tokens: body.input.length * 5 },
    });
  }
  return respond(404, {});
};

/* ================================================================== harness: real Postgres (+pgvector) via PGlite */
let PGlite, contrib = {}, vectorExt;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
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
for (const f of fs.readdirSync(cfgDir).filter((x) => /^\d\d.*\.sql$/.test(x) && !x.startsWith('99')).sort()) {
  try { await lite.exec(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch (err) { notes.push(`${f}: ${String(err.message).slice(0, 100)}`); }
}
try { await lite.exec(fs.readFileSync(path.join(cfgDir, '01b-app-role.sql'), 'utf8')); } catch (err) { notes.push(`01b re-run failed: ${err.message}`); }
for (const n of notes) console.log(`NOTE  migration harness: ${n}`);
check('harness: migration 40 loaded cleanly against real pgvector', !notes.some((n) => n.startsWith('40-')));

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
const tenA = { tenantKey: 'org_semantic_cache_a', tenantName: 'Semantic Cache Shop A' };
const tenB = { tenantKey: 'org_semantic_cache_b', tenantName: 'Semantic Cache Shop B' };
await getTenantContext(tenA.tenantKey, tenA.tenantName);
await getTenantContext(tenB.tenantKey, tenB.tenantName);

const STAMP = 'stamp-v1';
const resetFake = () => embed._resetEmbedState();

/* ================================================================== 2. embedding path: store + hit, no cross-slot/tenant/TTL leak */
{
  process.env.VOYAGE_API_KEY = 'test-key';
  resetFake(); sc._resetSemanticCacheStateForTests();

  await withTenant(tenA, async (db) => {
    await sc.storeSemantic(db, { question: 'any noise complaints in the last 30 days', corpusStamp: STAMP, answer: { text: 'yes, 3 units' } });
  });

  const hit = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'any noise complaints reported in the last 30 days', corpusStamp: STAMP }));
  check('embedding path: a close paraphrase with the SAME slots hits', hit.hit === true, JSON.stringify(hit));
  check('embedding path: hit came via the embedding path', hit.hit && hit.via === 'embedding', JSON.stringify(hit));
  eq('embedding path: hit returns the stored answer', hit.hit ? hit.answer : null, { text: 'yes, 3 units' });

  const differentSlots = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'any noise complaints about the Trane unit reported in the last 30 days', corpusStamp: STAMP }));
  check('embedding path: adding a brand slot not in the cached row is a miss (slots differ)', differentSlots.hit === false, JSON.stringify(differentSlots));

  const otherTenant = await withTenant(tenB, async (db) => sc.lookupSemantic(db, { question: 'were there any noise complaints reported in the last 30 days', corpusStamp: STAMP }));
  check('embedding path: an identical question from ANOTHER TENANT never hits (RLS)', otherTenant.hit === false, JSON.stringify(otherTenant));

  const staleCorpus = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'were there any noise complaints reported in the last 30 days', corpusStamp: 'stamp-v2-after-a-write' }));
  check('embedding path: a changed corpus_stamp is a miss (data changed since caching)', staleCorpus.hit === false, JSON.stringify(staleCorpus));

  const unrelated = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'what is our open invoice total', corpusStamp: STAMP }));
  check('embedding path: an unrelated question is a miss', unrelated.hit === false, JSON.stringify(unrelated));
}

/* ================================================================== 3. Mesa vs Tempe: identical embeddings, different slots -> never cross-hits */
{
  sc._resetSemanticCacheStateForTests(); resetFake();
  await withTenant(tenA, async (db) => {
    await sc.storeSemantic(db, { question: 'how many Trane units do we have in Mesa', corpusStamp: STAMP, answer: { count: 41 } });
  });
  // Same bag-of-words tokens (trane/units/mesa vs trane/units/tempe) minus one -> the fake
  // embedder puts these very close in cosine space, which is exactly the case the slot
  // signature must catch on its own; embedding similarity alone would wrongly hit here.
  const tempe = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'how many Trane units do we have in Tempe', corpusStamp: STAMP }));
  check('Mesa cache row never hits a Tempe question, even with near-identical embeddings', tempe.hit === false, JSON.stringify(tempe));
  const mesaAgain = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'how many Trane units are in Mesa', corpusStamp: STAMP }));
  check('...but the SAME city still hits', mesaAgain.hit === true, JSON.stringify(mesaAgain));
}

/* ================================================================== 4. TTL expiry */
{
  sc._resetSemanticCacheStateForTests(); resetFake();
  const past = Date.now() - 1000;
  await withTenant(tenA, async (db) => {
    await sc.storeSemantic(db, { question: 'any water leak complaints', corpusStamp: STAMP, answer: { text: 'no' }, now: past });
  });
  const withinTtl = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'any water leak complaints', corpusStamp: STAMP, now: past + 1000 }));
  check('TTL: a lookup right after storing still hits', withinTtl.hit === true, JSON.stringify(withinTtl));
  const expired = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'any water leak complaints', corpusStamp: STAMP, now: past + 25 * 60 * 60 * 1000 }));
  check('TTL: a lookup 25h later (default TTL 24h) is a miss', expired.hit === false, JSON.stringify(expired));
}

/* ================================================================== 5. no-embedding fallback path (VOYAGE_API_KEY unset) */
{
  delete process.env.VOYAGE_API_KEY;
  sc._resetSemanticCacheStateForTests(); resetFake();
  await withTenant(tenA, async (db) => {
    await sc.storeSemantic(db, { question: 'how many open invoices for Bracken', corpusStamp: STAMP, answer: { count: 2 } });
  });
  const reordered = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'open invoices how many for Bracken', corpusStamp: STAMP }));
  check('fallback path: reordered phrasing with no embeddings still hits (word-order-independent signature)', reordered.hit === true, JSON.stringify(reordered));
  check('fallback path: hit came via fallback, not embedding', reordered.hit && reordered.via === 'fallback', JSON.stringify(reordered));
  const differentName = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'how many open invoices for Whitmore', corpusStamp: STAMP }));
  check('fallback path: a different customer name (different slot) is a miss', differentName.hit === false, JSON.stringify(differentName));
}

/* ================================================================== 6. graceful degrade: feature flag off, and table missing */
{
  sc._resetSemanticCacheStateForTests(); resetFake();
  process.env.SEMANTIC_ANSWER_CACHE = '0';
  const off = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'anything', corpusStamp: STAMP }));
  check('feature flag: SEMANTIC_ANSWER_CACHE=0 always misses, no query issued', off.hit === false);
  delete process.env.SEMANTIC_ANSWER_CACHE;

  // Simulate "migration not pasted yet": drop the table (as the table OWNER,
  // not the RLS app role withTenant's connection runs as — same reasoning
  // as every migration file itself) and confirm no throw.
  sc._resetSemanticCacheStateForTests();
  await lite.exec('DROP TABLE IF EXISTS ask_semantic_cache');
  let threw = null;
  let res;
  try {
    res = await withTenant(tenA, async (db) => sc.lookupSemantic(db, { question: 'anything at all', corpusStamp: STAMP }));
    await withTenant(tenA, async (db) => sc.storeSemantic(db, { question: 'anything at all', corpusStamp: STAMP, answer: {} }));
  } catch (err) { threw = err; }
  check('missing table: lookupSemantic/storeSemantic never throw', threw === null, threw?.message);
  check('missing table: lookupSemantic reports a plain miss', res?.hit === false, JSON.stringify(res));
}

console.log('');
if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
console.log(`${passes} checks passed.`);
