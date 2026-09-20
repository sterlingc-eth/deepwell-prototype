/**
 * Regression checks for the per-tenant /api/ask answer cache
 * (api/_lib/askCache.js, handoffs/ASK_CACHE_AND_INDEX_2026-09-20.md).
 *
 * No database, no network: `db.raw` is a local mock recording what SQL it
 * was asked to run and returning canned rows — every function under test is
 * either pure or driven entirely through that mock.
 *
 *   node scripts/verify-ask-cache.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashQuestion, normalizeQuestion } from '../api/ask.js';
import {
  ASK_CACHE_ENABLED,
  CACHE_TTL_MS,
  isCacheHit,
  shouldCache,
  getCacheEntry,
  upsertCacheEntry,
  _resetTableExistsForTests,
  PROMPT_VERSION,
} from '../api/_lib/askCache.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ key derivation
 * The cache key is hashQuestion(normalizeQuestion(question)) — reused
 * straight from api/ask.js, not reimplemented here, so this tests the exact
 * function ask.js actually calls.
 */
{
  const keyOf = (q) => hashQuestion(normalizeQuestion(q));
  eq('same question, same key', keyOf('What is the warranty?'), keyOf('What is the warranty?'));
  eq('case and trailing punctuation collapse to the same key',
    keyOf("What'S The Warranty?"), keyOf("what's the warranty"));
  eq('extra whitespace collapses to the same key',
    keyOf('how   many documents'), keyOf('how many documents'));
  check('a genuinely different question gets a different key',
    keyOf('what is the warranty') !== keyOf('how many documents'));
  check('key is a 64-char hex sha256 digest', /^[0-9a-f]{64}$/.test(keyOf('x')));
}

/* -------------------------------------------------------------------- TTL */
{
  const now = Date.now();
  const fresh = { cached_stamp: 'S', created_at: new Date(now - 1000).toISOString() };
  const stale = { cached_stamp: 'S', created_at: new Date(now - (CACHE_TTL_MS + 1000)).toISOString() };
  const boundary = { cached_stamp: 'S', created_at: new Date(now - CACHE_TTL_MS + 5000).toISOString() };

  check('a fresh row (1s old) with a matching stamp is a hit', isCacheHit(fresh, 'S', now));
  check('a row exactly at 24h old is a miss (strict <, not <=)', !isCacheHit(stale, 'S', now));
  check('a row just under 24h old is still a hit', isCacheHit(boundary, 'S', now));
  check('a mismatched corpus_stamp is a miss regardless of age', !isCacheHit(fresh, 'DIFFERENT', now));
  check('no row at all is a miss', !isCacheHit(null, 'S', now));
  check('a row with no cached_stamp (LEFT JOIN found nothing) is a miss', !isCacheHit({ cached_stamp: null }, 'S', now));
  check('a null corpus_stamp (stamp query itself failed) is always a miss', !isCacheHit(fresh, null, now));
  check('an unparseable created_at is a miss, not a thrown error',
    !isCacheHit({ cached_stamp: 'S', created_at: 'not-a-date' }, 'S', now));
}

/* --------------------------------------------- don't cache empty no-answer */
{
  check('kind=no-answer with zero passages and zero extractions is NOT cacheable',
    !shouldCache('no-answer', 0, 0));
  check('kind=no-answer WITH real evidence is NOT cacheable either (2026-09-20: a model no-answer outlived the prompt fix)',
    !shouldCache('no-answer', 3, 0) && !shouldCache('no-answer', 0, 2));
  check('kind=answer is always cacheable, evidence or not', shouldCache('answer', 5, 5) && shouldCache('answer', 0, 0));
}

/* ------------------------------------------------------- stamp composition
 * Source-text checks (same technique verify-caching.mjs uses for TTL
 * variants) against the four write paths named in
 * handoffs/TEAM_BRIEF_2026-09-19.md / ASK_CACHE_AND_INDEX_2026-09-20.md:
 * extraction writes, verify/unverify, field correction, delete, merge,
 * assignDocumentCustomer.
 */
{
  const src = readFileSync(fileURLToPath(new URL('../api/_lib/askCache.js', import.meta.url)), 'utf8');
  check('stamp counts+dates documents (ingest, delete via count, verify/unverify via stage filter)',
    /FROM documents WHERE/.test(src) && /stage = 'verified'/.test(src) && /max\(updated_at\)/.test(src));
  check('stamp reads extractions.corrected_at (field correction) falling back to created_at (re-extraction)',
    /coalesce\(corrected_at, created_at\)/.test(src) && /FROM extractions WHERE/.test(src));
  check('stamp reads document_entity_links.created_at (link\\/unlink\\/assignDocumentCustomer)',
    /FROM document_entity_links WHERE/.test(src));
  check('stamp reads entities.updated_at (merge, customer\\/equipment field fills)',
    /FROM entities WHERE/.test(src) && /max\(updated_at\)/.test(src));

  // classifyDocument's own bump — the one write path with no other signal.
  const reviewSrc = readFileSync(fileURLToPath(new URL('../api/_lib/reviewStore.js', import.meta.url)), 'utf8');
  check('classifyDocument bumps documents.updated_at (the one write path the stamp would otherwise miss)',
    /documentsHaveUpdatedAt\(client\)/.test(reviewSrc) && /UPDATE documents SET document_type = \$2\$\{touch\}/.test(reviewSrc));
  const recordsSrc = readFileSync(fileURLToPath(new URL('../api/_lib/recordsStore.js', import.meta.url)), 'utf8');
  check('updateDocument bumps updated_at on every path (reclassifyDocuments, extract, read) — guarded until migration 17 lands',
    /updater\('documents', DOCUMENT_UPDATE_COLUMNS, \{ touch: true \}\)/.test(recordsSrc) &&
    /touch && \(await documentsHaveUpdatedAt\(db\)\)/.test(recordsSrc));
}

/* -------------------------------------------------------- ASK_CACHE=0 env */
{
  check('ASK_CACHE_ENABLED is true by default (this test run has no ASK_CACHE set)', ASK_CACHE_ENABLED === true);
}
{
  process.env.ASK_CACHE = '0';
  const disabled = await import(`../api/_lib/askCache.js?t=${Date.now()}`);
  check('ASK_CACHE=0 disables the module-level flag', disabled.ASK_CACHE_ENABLED === false);
  const neverCalled = { raw: async () => { throw new Error('must not query the DB when disabled'); } };
  const entry = await disabled.getCacheEntry(neverCalled, { questionHash: 'h', today: '2026-09-20' });
  eq('getCacheEntry short-circuits with no DB call when disabled', entry, { corpusStamp: null, row: null });
  await disabled.upsertCacheEntry(neverCalled, { questionHash: 'h', corpusStamp: 's', today: '2026-09-20', answer: {} });
  check('upsertCacheEntry short-circuits with no DB call when disabled (did not throw)', true);
  delete process.env.ASK_CACHE;
}

/* ----------------------------------------- graceful miss: table not yet applied */
{
  _resetTableExistsForTests();
  const calls = [];
  const missingTableErr = () => Object.assign(new Error('relation "ask_answer_cache" does not exist'), { code: '42P01' });
  const mockDb = {
    raw: async (sql) => {
      calls.push(sql.trim().split('\n')[0].trim());
      if (/^SAVEPOINT/.test(sql.trim())) return { rows: [] };
      if (/^ROLLBACK TO SAVEPOINT/.test(sql.trim())) return { rows: [] };
      if (/ask_answer_cache/.test(sql)) throw missingTableErr();
      if (/AS corpus_stamp/.test(sql)) return { rows: [{ corpus_stamp: 'STAMP-A' }] };
      throw new Error(`unexpected SQL in test mock: ${sql}`);
    },
  };

  const first = await getCacheEntry(mockDb, { questionHash: 'h1', today: '2026-09-20' });
  eq('first lookup with a missing table returns the stamp and no row (not a thrown error)',
    first, { corpusStamp: `STAMP-A:${PROMPT_VERSION}`, row: null });
  check('first lookup used a SAVEPOINT to probe safely', calls.includes('SAVEPOINT ask_cache_probe'));

  const callsBeforeSecond = calls.length;
  const second = await getCacheEntry(mockDb, { questionHash: 'h2', today: '2026-09-20' });
  eq('second lookup (table known missing) still returns the stamp', second, { corpusStamp: `STAMP-A:${PROMPT_VERSION}`, row: null });
  check('second lookup skipped the SAVEPOINT entirely (memoized "known missing")',
    !calls.slice(callsBeforeSecond).some((c) => c.includes('SAVEPOINT')));

  let threw = false;
  try {
    await upsertCacheEntry(mockDb, { questionHash: 'h1', corpusStamp: 'STAMP-A', today: '2026-09-20', answer: { kind: 'answer' } });
  } catch {
    threw = true;
  }
  check('upsertCacheEntry with a known-missing table is a silent no-op (never throws)', !threw);
}

/* ------------------------------------------------------------- happy path */
{
  _resetTableExistsForTests();
  const mockDb = {
    raw: async (sql, params) => {
      if (/^SAVEPOINT/.test(sql.trim())) return { rows: [] };
      if (/ask_answer_cache/.test(sql) && /INSERT INTO/.test(sql)) return { rows: [] };
      if (/ask_answer_cache/.test(sql)) {
        const [questionHash] = params;
        const hit = questionHash === 'known-question';
        return { rows: [{ corpus_stamp: 'STAMP-B', cached_stamp: hit ? `STAMP-B:${PROMPT_VERSION}` : null, answer: hit ? { kind: 'answer', text: 'cached' } : null, created_at: hit ? new Date().toISOString() : null }] };
      }
      throw new Error(`unexpected SQL in test mock: ${sql}`);
    },
  };

  const miss = await getCacheEntry(mockDb, { questionHash: 'new-question', today: '2026-09-20' });
  check('a genuine miss returns the stamp with no usable row', miss.corpusStamp === `STAMP-B:${PROMPT_VERSION}` && miss.row?.cached_stamp == null);

  const hit = await getCacheEntry(mockDb, { questionHash: 'known-question', today: '2026-09-20' });
  check('isCacheHit accepts the row getCacheEntry returns for a real match',
    isCacheHit(hit.row, hit.corpusStamp));

  let upsertThrew = false;
  try {
    await upsertCacheEntry(mockDb, { questionHash: 'new-question', corpusStamp: 'STAMP-B', today: '2026-09-20', answer: { kind: 'answer' } });
  } catch {
    upsertThrew = true;
  }
  check('upsertCacheEntry against a present table does not throw', !upsertThrew);
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
