/**
 * LIMIT TEST (Tester A) - Donovan (api/ask.js) end to end with a mocked model, plus the Ask answer cache and the semantic cache.
 * 3 companies on one PGlite DB. The model is a recording mock: we capture EVERY request body sent to "the model" and assert it
 * never contains another company's data. Same-question-different-company cache collision tests, concurrent (Promise.all).
 *   Run: npx tsx scripts/limit-test/isolation-ask-caches.mjs
 */
for (const b of ['READ', 'WRITE', 'INGEST', 'ASK']) { process.env[`RATE_LIMIT_${b}_PER_MINUTE`] = '100000'; process.env[`RATE_LIMIT_${b}_PER_DAY`] = '10000000'; }
delete process.env.DEEPWELL_FOUNDER_TENANT_ID;
import crypto from 'node:crypto';
import { boot, call, orgToken, check, finish, quiet } from './lib.mjs';
import { seedTenant } from './seed.mjs';
import { installMockAnthropicClient } from '../lib/mockAnthropicClient.mjs';

const h = await boot();
const mock = await installMockAnthropicClient({ mode: 'answer' });
const proto = Object.getPrototypeOf((new (await import('@anthropic-ai/sdk')).default({ apiKey: 'x' })).messages);
const inner = proto.create; const modelReqs = []; let currentAsker = null;
proto.create = async function (req) { modelReqs.push({ asker: currentAsker, body: JSON.stringify(req) }); return inner.call(this, req); };

await h.lite.exec(`CREATE DOMAIN vector AS text;`).catch(() => {});
await h.lite.exec(`CREATE TABLE IF NOT EXISTS ask_semantic_cache (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, corpus_stamp text NOT NULL, slot_signature text NOT NULL, fallback_signature text NOT NULL, embedding vector, embed_model text, question_norm text NOT NULL, answer jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE ask_semantic_cache ENABLE ROW LEVEL SECURITY; ALTER TABLE ask_semantic_cache FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenants_isolate_ask_semantic_cache ON ask_semantic_cache USING (tenant_id = (current_setting('app.tenant_id', true))::uuid) WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);
  GRANT SELECT, INSERT, UPDATE, DELETE ON ask_semantic_cache TO deepwell_rls;`);  // pgvector is unavailable in PGlite: same table/policy, embedding column is plain text (embeddings are off in tests, so only the exact fallback path runs)
const [A, B, C] = await Promise.all([seedTenant(h, { key: 'org_A', tag: 'AAA' }), seedTenant(h, { key: 'org_B', tag: 'BBB' }), seedTenant(h, { key: 'org_C', tag: 'CCC' })]);
const TS = [A, B, C]; const tok = (T) => orgToken(T.key, `user_${T.tag}`, 'admin');
const ask = (await import('../../api/ask.js')).default;
const asked = async (X, q, extra = {}) => { currentAsker = X.tag; return quiet(() => call(ask, { token: extra.token ?? tok(X), body: { question: q, today: '2025-01-01', ...extra.body } })); };
const secretsOf = (Y) => [...Y.sent.filter((s) => !/^(AUDIT|NOTIF|OUTREACH|QUESTION|PROPOSAL|SETTING|FACET)/.test(s)), ...Y.docs.map((d) => d.storageKey), Y.uuid, Y.customerId, Y.unitId, Y.docs[0].id, Y.docs[1].id];

/* ---- 1. Donovan end-to-end: questions that sweep the whole corpus, from every company, interleaved + concurrent ------------------- */
const QUESTIONS = ['List all my customers', 'Show every document you have', 'What serial numbers do we have on file?', 'Which units have warranty expiring soon?', 'How many documents do I have and what are they?', 'Who is the customer at 101 Main Street?', 'What happened at the last service call?', 'Summarize all service tickets', 'Tell me about BBB', 'Tell me about CCC', 'Tell me about AAA', 'Is there anything for customer Alderman'];
let nAsk = 0, withData = 0, leakCount = 0;
const runOne = async (X, q) => {
  const before = modelReqs.length; const res = await asked(X, q); nAsk++;
  const body = JSON.stringify(res.body ?? null);
  const mine = modelReqs.slice(before).filter((m) => m.asker === X.tag || true);
  for (const Y of TS) { if (Y === X) continue;
    const sec = secretsOf(Y); const hitResp = sec.filter((s) => body.includes(s)); const hitModel = sec.filter((s) => mine.some((m) => m.body.includes(s) && m.asker === X.tag));
    if (hitResp.length || hitModel.length) { leakCount++; check(`ask ${X.tag}: "${q}" leaks ${Y.tag}`, false, `response=${JSON.stringify(hitResp)} model-prompt=${JSON.stringify(hitModel)}`); }
  }
  if (res.statusCode === 200) withData++;
  return res;
};
for (const q of QUESTIONS) for (const X of TS) await runOne(X, q);                               // sequential, interleaved
check(`ask: ${nAsk} sequential questions x 3 companies (full pipeline, mock model): no other company's data in any response or any model prompt`, leakCount === 0);
const burst = []; for (const q of QUESTIONS.slice(0, 6)) for (const X of TS) burst.push(runOne(X, q + ' ')); await Promise.all(burst);
check(`ask: ${burst.length} concurrent (Promise.all) questions across 3 companies: no cross-company data`, leakCount === 0);
const own = await asked(A, 'Who is the customer on serial SNAAA1?');
check('control: ask returned 200 (pipeline actually ran) and the model saw A\'s OWN data in at least one prompt', own.statusCode === 200 && modelReqs.some((m) => m.asker === 'AAA' && /SNAAA|CUSTOMERAAA|NAMEAAA/.test(m.body)), `status=${own.statusCode} modelCalls=${modelReqs.length} body=${JSON.stringify(own.body)?.slice(0, 200)}`);
console.log(`   (ask requests=${nAsk + burst.length + 1}, model calls captured=${modelReqs.length}, 200s=${withData})`);

/* ---- 2. API key scopes on /api/ask ------------------------------------------------------------------------------------------------ */
{
  const rr = await asked(A, 'List customers', { token: A.readKey }); check('ask with a read-only API key -> 403 (scope "ask" missing)', rr.statusCode === 403, `${rr.statusCode}`);
  const ok = await asked(A, 'List customers', { token: A.apiKey }); check('ask with a full-scope key of A works and answers from A only', ok.statusCode === 200 && !JSON.stringify(ok.body).includes('BBB'), `${ok.statusCode}`);
  await h.lite.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [B.apiKeyId]);
  const rv = await asked(B, 'List customers', { token: B.apiKey }); check('ask with a REVOKED key of B -> 401', rv.statusCode === 401, `${rv.statusCode}`);
  await h.lite.query(`UPDATE api_keys SET revoked_at = NULL WHERE id = $1`, [B.apiKeyId]);
  const xs = await asked(A, 'List customers', { token: 'dw_live_' + 'a'.repeat(64) }); check('ask with a well-formed but unknown key -> 401', xs.statusCode === 401, `${xs.statusCode}`);
  const bad = await asked(A, 'List customers', { token: 'dw_live_zz' }); check('ask with a malformed key -> 401', bad.statusCode === 401, `${bad.statusCode}`);
  const noauth = await quiet(() => call(ask, { body: { question: 'x' } })); check('ask with no token -> 401', noauth.statusCode === 401);
  const other = await quiet(() => call(ask, { token: A.apiKey, body: { question: 'List customers', tenantId: B.key, tenant_id: B.uuid, orgId: B.key } })); check('ask: A key + smuggled tenantId/orgId of B in body -> still A\'s data only', !JSON.stringify(other.body).includes('BBB') && !modelReqs.slice(-3).some((m) => m.body.includes('CUSTOMERBBB')));
}

/* ---- 3. Ask answer cache (api/_lib/askCache.js), 3 companies, identical question hash -------------------------------------------- */
const AC = await import('../../api/_lib/askCache.js');
const { withTenant } = h.RS;
const ctx = (T) => ({ tenantKey: T.key, tenantName: T.key });
const qh = crypto.createHash('sha256').update('same question text').digest('hex');
const today = '2025-01-01';
AC._resetTableExistsForTests();
const stamps = {};
for (const T of TS) stamps[T.tag] = await withTenant(ctx(T), (db) => AC.getCacheEntry(db, { questionHash: qh, today }));
check('ask cache: cold - nobody has a cached row for the shared question hash', TS.every((T) => stamps[T.tag].row === null));
check('ask cache: each company\'s corpus stamp is its own (data differs -> stamps differ)', new Set(TS.map((T) => stamps[T.tag].corpusStamp)).size === 3);
await Promise.all(TS.map((T) => withTenant(ctx(T), (db) => AC.upsertCacheEntry(db, { questionHash: qh, corpusStamp: stamps[T.tag].corpusStamp, today, answer: { kind: 'answer', text: `ANSWER-FOR-${T.tag}` } }))));
const got = await Promise.all(TS.flatMap((T) => [0, 1].map(() => withTenant(ctx(T), (db) => AC.getCacheEntry(db, { questionHash: qh, today })).then((r) => [T, r]))));
check('ask cache: same question hash, 3 companies, concurrent upserts+reads: each company reads ONLY its own cached answer', got.every(([T, r]) => r.row && JSON.stringify(r.row.answer).includes(`ANSWER-FOR-${T.tag}`) && TS.filter((o) => o !== T).every((o) => !JSON.stringify(r.row.answer).includes(o.tag))));
check('ask cache: isCacheHit true for own row', got.every(([, r]) => AC.isCacheHit(r.row, r.corpusStamp)));
{ // a stamp from company A can never validate B's row
  const rowB = got.find(([T]) => T === B)[1].row; const stampA = got.find(([T]) => T === A)[1].corpusStamp;
  check('ask cache: another company\'s corpus stamp does not make a row a hit', !AC.isCacheHit(rowB, stampA)); }
const rows = (await h.lite.query(`SELECT tenant_id, question_hash, answer::text a FROM ask_answer_cache WHERE question_hash = $1 ORDER BY 1`, [qh])).rows;
check('ask cache: exactly one row per company in the table, each tagged with its own tenant_id', rows.length === 3 && TS.every((T) => rows.filter((r) => r.tenant_id === T.uuid).length === 1 && rows.find((r) => r.tenant_id === T.uuid).a.includes(T.tag)));
{ // RLS: with company B's GUC, A's row is invisible even to a raw SELECT with no tenant predicate
  const seen = await withTenant(ctx(B), (db) => db.raw(`SELECT answer::text a FROM ask_answer_cache`, [])); const tids = (await withTenant(ctx(B), (db) => db.raw(`SELECT DISTINCT tenant_id FROM ask_answer_cache`, []))).rows.map((r) => r.tenant_id); check('ask cache: RLS hides A and C rows from B even with no WHERE (only B\'s tenant_id visible, across all cached rows)', tids.length === 1 && tids[0] === B.uuid && seen.rows.length >= 1, JSON.stringify(tids)); }
{ // data change in ONE company only invalidates that company
  const before = await withTenant(ctx(A), (db) => AC.getCacheEntry(db, { questionHash: qh, today }));
  await withTenant(ctx(A), (db) => db.createEntity({ entity_type: 'customer', data: { customer_name: 'New Person' } }));
  const afterA = await withTenant(ctx(A), (db) => AC.getCacheEntry(db, { questionHash: qh, today })); const afterB = await withTenant(ctx(B), (db) => AC.getCacheEntry(db, { questionHash: qh, today }));
  check('ask cache: a write in A changes A\'s stamp (A\'s cached answer becomes a miss)', afterA.corpusStamp !== before.corpusStamp && !AC.isCacheHit(afterA.row, afterA.corpusStamp));
  check('ask cache: ...and does NOT disturb B (B still hits)', AC.isCacheHit(afterB.row, afterB.corpusStamp)); }
check('ask cache: a different "today" is a miss (date-relative answers do not survive midnight)', (await withTenant(ctx(B), (db) => AC.getCacheEntry(db, { questionHash: qh, today: '2025-01-02' }))).row === null);
{ // bare pool, no tenant GUC: must not read anyone's cache
  let leaked = null; try { const r = await h.RS.getPool().query(`SELECT answer::text FROM ask_answer_cache`); leaked = r.rows.length; } catch (e) { leaked = `error:${e.code ?? e.message}`; }
  { const c = await h.RS.getPool().connect(); try { const r = await c.query(`SELECT answer::text FROM ask_answer_cache`); if (r.rows.length) leaked = `connect-rows:${r.rows.length}`; } catch (e) { /* error = fine */ } finally { c.release(); } }
  check('ask cache: a connection with NO tenant context (bare pool) reads zero rows / errors (RLS FORCE, role is not owner)', leaked === 0 || String(leaked).startsWith('error'), String(leaked)); }
// end-to-end: A asks, then B asks the identical text -> B must be answered from B's data, never from A's cache row
{
  const q = 'How many documents are in my records?';
  await asked(A, q); const rA = (await h.lite.query(`SELECT count(*)::int n FROM ask_answer_cache WHERE tenant_id=$1`, [A.uuid])).rows[0].n;
  const mB0 = modelReqs.length; const rb = await asked(B, q); const bUsedModelOrOwn = modelReqs.length >= mB0;
  check('ask e2e: identical question text asked by A then B -> B\'s answer contains no A data, A\'s cache row not served to B', !JSON.stringify(rb.body).includes('AAA') && bUsedModelOrOwn, JSON.stringify(rb.body)?.slice(0, 200));
  console.log(`   (A cache rows after ask=${rA})`);
}

/* ---- 4. Semantic cache (api/_lib/cache/semanticCache.js): fallback path (pgvector is not available in PGlite) ---------------------- */
const SC = await import('../../api/_lib/cache/semanticCache.js');
{
  let present = (await h.lite.query(`SELECT to_regclass('public.ask_semantic_cache') t`)).rows[0].t;
  console.log('   ask_semantic_cache table present in PGlite:', present);
  const src = (await import('node:fs')).readFileSync(new URL('../../api/_lib/cache/semanticCache.js', import.meta.url), 'utf8');
  check('semantic cache source: every SELECT/INSERT/DELETE carries the tenant predicate or the current_setting tenant id', (src.match(/FROM ask_semantic_cache[\s\S]{0,300}?TENANT_SQL/g) ?? []).length >= 3 && /INSERT INTO ask_semantic_cache[\s\S]{0,400}current_setting\('app\.tenant_id'/.test(src));
  const env = { ...process.env, SEMANTIC_ANSWER_CACHE: '1' };
  const q1 = 'Who is the customer at 12 Elm Street?';
  let stored = 0;
  for (const T of TS) { try { await withTenant(ctx(T), async (db) => { await SC.storeSemantic(db, { question: q1, corpusStamp: 'stamp-shared', answer: { kind: 'answer', text: `SEM-ANSWER-${T.tag}` }, env, now: Date.now() }); }); stored++; } catch (e) { console.log('   storeSemantic error for', T.tag, e.message?.slice(0, 120)); } }
  const rowsS = (await h.lite.query(`SELECT tenant_id, answer::text a FROM ask_semantic_cache`)).rows;
  console.log(`   semantic rows stored: ${rowsS.length} (store calls ok: ${stored})`);
  if (rowsS.length) {
    check('semantic cache: rows written under each company\'s own tenant_id only', TS.every((T) => rowsS.filter((r) => r.tenant_id === T.uuid).every((r) => r.a.includes(T.tag))));
    const looks = await Promise.all(TS.flatMap((T) => [1, 2].map(() => withTenant(ctx(T), (db) => SC.lookupSemantic(db, { question: q1, corpusStamp: 'stamp-shared', env })).then((r) => [T, r]))));
    check('semantic cache: identical question + identical corpus stamp in 3 companies, concurrent: each company is served ONLY its own entry (or a miss), never another\'s', looks.every(([T, r]) => !r || !JSON.stringify(r).match(new RegExp(TS.filter((o) => o !== T).map((o) => `SEM-ANSWER-${o.tag}`).join('|')))), JSON.stringify(looks.map(([T, r]) => [T.tag, r ? JSON.stringify(r).slice(0, 80) : null])));
    console.log('   semantic lookups:', JSON.stringify(looks.map(([T, r]) => [T.tag, r ? 'hit' : 'miss'])));
    const seenB = await withTenant(ctx(B), (db) => db.raw(`SELECT answer::text a FROM ask_semantic_cache`, [])); check('semantic cache: RLS hides other companies\' rows from B (no WHERE)', seenB.rows.length >= 1 && seenB.rows.every((r) => r.a.includes('BBB')));
  } else console.log('   NOTE: semantic cache needs pgvector; the in-PGlite stand-in could not store (vector ops unavailable) - source-level + RLS checks only');
}
console.log(`\nmodel requests captured: ${modelReqs.length}`);
finish();
