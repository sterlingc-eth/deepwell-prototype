/**
 * Offline upload queue (src/mobile/offline/{queue,uploadQueue}.ts) — pure/unit
 * tests against an in-memory adapter (no fake-indexeddb dependency, no
 * browser; the real IndexedDB store is exercised by the Playwright harness
 * in scripts/verify-offline-queue-ui.mjs instead). `global.fetch` is a small
 * hand-written fake server so the exact server calls
 * (requestUploadUrl/putFile/readDocument, all from src/services/
 * ingestClient.ts, unmodified) run for real, just against fake responses.
 *
 * Covers: offline -> online transition, retry with exponential backoff,
 * duplicate suppression via the sha256 idempotency key, 401 (auth pause) and
 * 413 (permanent, no auto-retry) handling, tenant namespacing on one shared
 * store, deleting a queued item, and the backoff/classification pure
 * functions directly.
 *
 *   npx tsx scripts/verify-offline-queue.mjs
 */
import {
  attemptUploadOnce,
  backoffDelayMs,
  BASE_DELAY_MS,
  classifyUploadError,
  MAX_DELAY_MS,
  OfflineUploadQueue,
} from '../src/mobile/offline/uploadQueue.ts';
import { createMemoryStore, QueueQuotaError } from '../src/mobile/offline/queue.ts';
import { IngestHttpError } from '../src/services/ingestClient.ts';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================================================== *
 * A tiny fake server standing in for /api/upload-url, the presigned PUT, and /api/read-document.  *
 * `mode` controls how the NEXT presign call behaves; the PUT and read-document calls always       *
 * succeed once a document row exists, mirroring the real API (the gate is on NEW uploads).        *
 * ============================================================================================== */
function makeFakeServer() {
  const bySha = new Map(); // sha256 -> documentId
  let idSeq = 1;
  let mode = 'ok';
  let flakyRemaining = 0;

  function jsonRes(status, body, headers = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k] ?? null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }

  async function fetchImpl(url, init = {}) {
    const u = String(url);
    if (mode === 'offline') throw new TypeError('Failed to fetch'); // a real network failure, not an HTTP error

    if (u.includes('/api/upload-url')) {
      const body = JSON.parse(init.body);
      const existing = bySha.get(body.sha256);
      if (existing) return jsonRes(200, { documentId: existing, alreadyUploaded: true });
      if (mode === 'flaky-once' && flakyRemaining > 0) {
        flakyRemaining--;
        return jsonRes(503, { error: 'temporarily unavailable' });
      }
      if (mode === '429') return jsonRes(429, { error: 'slow down' }, { 'Retry-After': '0' });
      if (mode === '401') return jsonRes(401, { error: 'unauthenticated' });
      if (mode === '413') return jsonRes(413, { error: 'PDFs and photos have to be under 24 MB to be read.' });
      const documentId = `doc-${idSeq++}`;
      bySha.set(body.sha256, documentId);
      return jsonRes(200, { documentId, uploadUrl: `https://fake-upload.test/${documentId}`, alreadyUploaded: false });
    }
    if (u.startsWith('https://fake-upload.test/')) return { ok: true };
    if (u.includes('/api/read-document')) {
      const body = JSON.parse(init.body);
      return jsonRes(200, { documentId: body.documentId, pages: 1 });
    }
    throw new Error(`verify-offline-queue: unexpected fetch ${u}`);
  }

  return {
    fetchImpl,
    documentCount: () => bySha.size,
    setMode: (m, opts = {}) => {
      mode = m;
      flakyRemaining = opts.flakyRemaining ?? 0;
    },
  };
}

function makeFile(name = 'scan.jpg', content = 'bytes', type = 'image/jpeg') {
  return new File([content], name, { type });
}

async function sha(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ============================================================================================== *
 * Part 1 — pure functions: backoff and error classification.                                       *
 * ============================================================================================== */

check('backoffDelayMs: grows with attempt count', backoffDelayMs(3) > backoffDelayMs(1), `${backoffDelayMs(1)} vs ${backoffDelayMs(3)}`);
check('backoffDelayMs: attempt 1 is roughly BASE_DELAY_MS', Math.abs(backoffDelayMs(1) - BASE_DELAY_MS) <= BASE_DELAY_MS * 0.2);
check('backoffDelayMs: never exceeds MAX_DELAY_MS even for a huge attempt count', backoffDelayMs(50) <= MAX_DELAY_MS);
check('backoffDelayMs: never negative or zero', backoffDelayMs(1) > 0 && backoffDelayMs(20) > 0);

eq('classifyUploadError: 413 is too-large (never auto-retried — the bytes will never get smaller)', classifyUploadError(new IngestHttpError('x', 413, null)), 'too-large');
eq('classifyUploadError: 429 is transient', classifyUploadError(new IngestHttpError('x', 429, null)), 'transient');
eq('classifyUploadError: 503 is transient', classifyUploadError(new IngestHttpError('x', 503, null)), 'transient');
eq('classifyUploadError: 500 is transient', classifyUploadError(new IngestHttpError('x', 500, null)), 'transient');
eq('classifyUploadError: 400 is permanent (retrying identical bytes changes nothing)', classifyUploadError(new IngestHttpError('x', 400, null)), 'permanent');
eq('classifyUploadError: a thrown network error (offline) is transient', classifyUploadError(new TypeError('Failed to fetch')), 'transient');

/* ============================================================================================== *
 * Part 2 — attemptUploadOnce + duplicate suppression via the sha256 idempotency key.               *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  const file = makeFile();
  const digest = await sha(file);

  const first = await attemptUploadOnce(file, digest);
  check('attemptUploadOnce: first call creates a document', !!first.documentId && !first.duplicate, JSON.stringify(first));

  const second = await attemptUploadOnce(file, digest);
  check('attemptUploadOnce: a second call with the SAME sha256 is recognized as a duplicate, not a new document', second.duplicate === true && second.documentId === first.documentId, JSON.stringify(second));
  check('attemptUploadOnce: exactly one document exists server-side after both calls', server.documentCount() === 1, `count=${server.documentCount()}`);
}

/* ============================================================================================== *
 * Part 3 — offline -> online: enqueue while offline, drain fails and backs off, then succeeds      *
 * once "connectivity" (the fake server) is healthy again, with no duplicate created even though    *
 * the queue retried the SAME bytes.                                                                *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  server.setMode('offline');
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const file = makeFile('workorder.pdf', 'wo-bytes', 'application/pdf');
  const digest = await sha(file);

  const item = await manager.enqueue(tenant, file, digest);
  check('enqueue: item is stored immediately, before any network attempt', (await manager.list(tenant)).length === 1);
  eq('enqueue: starts life as status "queued"', item.status, 'queued');

  await manager.drain(tenant);
  let after = await manager.list(tenant);
  check('drain while offline: item is kept (not lost, not silently dropped)', after.length === 1, JSON.stringify(after));
  check('drain while offline: item is marked errored/transient with a backoff scheduled', after[0].status === 'error' && after[0].errorClass === 'transient' && after[0].nextAttemptAt > Date.now(), JSON.stringify(after[0]));
  check('drain while offline: exactly one attempt recorded', after[0].attempts === 1);

  // "Back online" — but the item's backoff window hasn't elapsed yet, so a
  // drain right now must NOT hammer the network again.
  server.setMode('ok');
  await manager.drain(tenant);
  after = await manager.list(tenant);
  check('drain still respects backoff even once the network is back (no server call is made before nextAttemptAt)', server.documentCount() === 0 && after.length === 1);

  // Time (the backoff window) has passed — the self-scheduled retry (or the
  // next online/visibility/app-open trigger) fires and this time it lands.
  await store.update(item.id, { nextAttemptAt: Date.now() - 1 });
  let uploadedOutcome = null;
  await manager.drain(tenant, { onUploaded: (_it, outcome) => (uploadedOutcome = outcome) });
  after = await manager.list(tenant);
  check('drain once online and past backoff: the item is removed from the queue', after.length === 0);
  check('drain once online: onUploaded fires with the server outcome', !!uploadedOutcome?.documentId);
  check('drain once online: exactly one document was ever created for these bytes (idempotency held across the whole offline/retry cycle)', server.documentCount() === 1);
}

/* ============================================================================================== *
 * Part 4 — duplicate suppression when the SAME bytes were already fully uploaded (e.g. by another  *
 * device, or a prior attempt that actually landed server-side before the client saw the response). *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const file = makeFile('invoice.jpg');
  const digest = await sha(file);

  // Someone/something else already landed these exact bytes.
  await attemptUploadOnce(file, digest);
  check('setup: one document exists before the queue ever runs', server.documentCount() === 1);

  await manager.enqueue(tenant, file, digest);
  let removed = false;
  await manager.drain(tenant, { onUploaded: () => (removed = true) });
  check('drain: a queued item whose bytes already exist server-side is treated as a success, not an error', removed === true);
  check('drain: still exactly one document — the retry never created a second', server.documentCount() === 1);
  eq('drain: the item is gone from the queue', (await manager.list(tenant)).length, 0);
}

/* ============================================================================================== *
 * Part 5 — retry with exponential backoff across several transient failures before success.        *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  server.setMode('flaky-once', { flakyRemaining: 2 });
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const file = makeFile('flaky.jpg');
  const digest = await sha(file);
  const item = await manager.enqueue(tenant, file, digest);

  await manager.drain(tenant);
  let row = await store.get(item.id);
  check('retry 1/3: first transient failure -> attempts=1, still queued (not deleted, not permanent)', row?.attempts === 1 && row?.status === 'error' && row?.errorClass === 'transient');
  const firstDelay = (row?.nextAttemptAt ?? 0) - Date.now();

  await store.update(item.id, { nextAttemptAt: Date.now() - 1 });
  await manager.drain(tenant);
  row = await store.get(item.id);
  check('retry 2/3: second transient failure -> attempts=2, backoff grows', row?.attempts === 2 && (row?.nextAttemptAt ?? 0) - Date.now() > firstDelay - 1000);

  await store.update(item.id, { nextAttemptAt: Date.now() - 1 });
  await manager.drain(tenant);
  check('retry 3/3: server recovered -> the item finally lands and is removed', (await manager.list(tenant)).length === 0);
  check('retry 3/3: exactly one document, despite three attempts on the same bytes', server.documentCount() === 1);
}

/* ============================================================================================== *
 * Part 6 — 401: paused for the whole tenant (not retried forever) and kept, not deleted, until      *
 * the tech re-authenticates.                                                                       *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  server.setMode('401');
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const fileA = makeFile('a.jpg', 'a-bytes');
  const fileB = makeFile('b.jpg', 'b-bytes');
  await manager.enqueue(tenant, fileA, await sha(fileA));
  await manager.drain(tenant);

  let items = await manager.list(tenant);
  check('401: the item is KEPT (not deleted) with an auth-error status', items.length === 1 && items[0].status === 'auth-error', JSON.stringify(items));
  check('401: the tenant is now paused', manager.isAuthBlocked(tenant) === true);

  // A second item queued while blocked must not even be attempted — a shop
  // with an expired session shouldn't burn through everyone's backoff.
  await manager.enqueue(tenant, fileB, await sha(fileB));
  await manager.drain(tenant);
  items = await manager.list(tenant);
  const second = items.find((it) => it.filename === 'b.jpg');
  check('401: a second item queued while auth-blocked is left untouched (still "queued", zero attempts)', second?.status === 'queued' && second?.attempts === 0, JSON.stringify(second));

  // The tech signs back in; the server is healthy again.
  server.setMode('ok');
  manager.retryAuthNow(tenant);
  await sleep(30);
  items = await manager.list(tenant);
  check('401 recovery: retryAuthNow unblocks and both items go out', items.length === 0, JSON.stringify(items));
  check('401 recovery: the tenant is no longer paused', manager.isAuthBlocked(tenant) === false);
}

/* ============================================================================================== *
 * Part 7 — 413: never auto-retried (the bytes will never get smaller), but kept and visible so the  *
 * tech can delete it — never silently vanishes.                                                    *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  server.setMode('413');
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const file = makeFile('huge.pdf', 'x'.repeat(10), 'application/pdf');
  await manager.enqueue(tenant, file, await sha(file));

  await manager.drain(tenant);
  let items = await manager.list(tenant);
  check('413: kept, marked permanent/too-large, with the server\'s message', items.length === 1 && items[0].errorClass === 'too-large' && !!items[0].error, JSON.stringify(items));

  // A later drain (online event, app open, ...) must not keep retrying it.
  const before = items[0].attempts;
  await manager.drain(tenant);
  items = await manager.list(tenant);
  check('413: never auto-retried on a later drain', items[0].attempts === before);

  // The tech deletes it.
  await manager.remove(tenant, items[0].id);
  eq('413: the tech can delete the queued item', (await manager.list(tenant)).length, 0);
}

/* ============================================================================================== *
 * Part 8 — tenant namespace: one shared store, two tenants, never cross-drained or cross-listed.   *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  server.setMode('offline');
  const store = createMemoryStore(); // ONE store — as if two techs share one phone
  const manager = new OfflineUploadQueue(store);
  const fileA = makeFile('shop-a-doc.jpg');
  const fileB = makeFile('shop-b-doc.jpg');
  await manager.enqueue('shop-a', fileA, await sha(fileA));
  await manager.enqueue('shop-b', fileB, await sha(fileB));

  eq('tenant namespace: shop-a only ever sees its own item', (await manager.list('shop-a')).map((i) => i.filename), ['shop-a-doc.jpg']);
  eq('tenant namespace: shop-b only ever sees its own item', (await manager.list('shop-b')).map((i) => i.filename), ['shop-b-doc.jpg']);

  server.setMode('401');
  await manager.drain('shop-a');
  check('tenant namespace: shop-a going auth-blocked does not block shop-b', manager.isAuthBlocked('shop-a') === true && manager.isAuthBlocked('shop-b') === false);

  server.setMode('ok');
  await manager.drain('shop-b');
  eq('tenant namespace: draining shop-b uploads only shop-b\'s item', (await manager.list('shop-b')).length, 0);
  eq('tenant namespace: shop-a\'s item is untouched by shop-b\'s drain', (await manager.list('shop-a')).length, 1);
}

/* ============================================================================================== *
 * Part 9 — client-side dedupe: re-scanning the same paper twice while still offline queues ONE     *
 * item, not two (no network round trip needed to know they're the same bytes).                    *
 * ============================================================================================== */
{
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const file = makeFile('same-paper.jpg', 'identical-bytes');
  const digest = await sha(file);
  const first = await manager.enqueue(tenant, file, digest);
  const second = await manager.enqueue(tenant, makeFile('same-paper (2).jpg', 'identical-bytes'), digest);
  eq('client-side dedupe: enqueueing the same sha256 twice returns the SAME queued item', second.id, first.id);
  eq('client-side dedupe: only one row is stored', (await manager.list(tenant)).length, 1);
}

/* ============================================================================================== *
 * Part 10 — quota error: a store that reports the device is full surfaces QueueQuotaError, not a   *
 * silently-dropped scan (a real IndexedDB store does this same translation — see queue.ts).        *
 * ============================================================================================== */
{
  /** @type {QueueStore} */
  const fullStore = {
    async add() {
      throw new QueueQuotaError(new DOMException('quota exceeded', 'QuotaExceededError'));
    },
    async all() {
      return [];
    },
    async get() {
      return undefined;
    },
    async update() {},
    async remove() {},
  };
  const manager = new OfflineUploadQueue(fullStore);
  const file = makeFile('one-more.jpg');
  let threw = null;
  try {
    await manager.enqueue('shop-a', file, await sha(file));
  } catch (err) {
    threw = err;
  }
  check('quota error: enqueue surfaces QueueQuotaError instead of throwing something opaque', threw instanceof QueueQuotaError, String(threw));
  check('quota error: the message is plain language, not a raw DOMException string', /storage|space/i.test(threw?.message ?? ''), threw?.message);
}

/* ============================================================================================== *
 * Part 11 — subscribe/notify: a listener sees the queue change without polling.                    *
 * ============================================================================================== */
{
  const server = makeFakeServer();
  globalThis.fetch = server.fetchImpl;
  const store = createMemoryStore();
  const manager = new OfflineUploadQueue(store);
  const tenant = 'shop-a';
  const seen = [];
  const unsubscribe = manager.subscribe(tenant, (items) => seen.push(items.length));
  await sleep(5); // the initial subscribe() call itself notifies asynchronously
  const file = makeFile('watched.jpg');
  await manager.enqueue(tenant, file, await sha(file));
  check('subscribe: fires with the item count after an enqueue', seen.includes(1), JSON.stringify(seen));
  unsubscribe();
  await manager.enqueue(tenant, makeFile('after-unsubscribe.jpg'), await sha(makeFile('after-unsubscribe.jpg')));
  const countAfterUnsub = seen.length;
  await sleep(5);
  check('subscribe: an unsubscribed listener gets no further calls', seen.length === countAfterUnsub);
}

console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
