/**
 * Regression checks for bulk import (src/services/bulkImport.ts): the
 * archive-walk accept/skip rules, the batch-presign request shaping, the
 * concurrency limiter, the retry/backoff schedule, and daily-cap detection.
 *
 * No DB, no network, no jszip archive involved — `walkZip` and the network
 * calls inside `startBulkImport` are the impure boundary and are exercised
 * manually against the deployed app instead; everything checked here is a
 * pure function reachable without either.
 *
 * Runs under plain Node (>=22.18, unflagged type-stripping) importing the
 * .ts source directly, the same way the rest of this suite imports .js
 * source directly — see HANDOFF-C.md for why bulkImport.ts's and
 * ingestClient.ts's own imports needed an explicit .ts extension for that
 * to resolve.
 *
 *   node scripts/verify-bulk.mjs
 */
import {
  classifyEntry,
  extOf,
  contentTypeFor,
  SUPPORTED_EXTENSIONS,
  MAX_BULK_FILE_BYTES,
  chunk,
  MAX_BATCH_PRESIGN_FILES,
  buildBatchPresignBody,
  computeBackoffMs,
  isRetryableStatus,
  isDailyCapError,
  runWithConcurrency,
  MAX_FILE_RETRIES,
  DEFAULT_BULK_CONCURRENCY,
} from '../src/services/bulkImport.ts';
import {
  IngestHttpError,
  isDailyCapIngestError,
  isRetryableIngestStatus,
  MAX_INGEST_RATE_LIMIT_RETRIES,
  IngestRateGate,
} from '../src/services/ingestClient.ts';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ classifyEntry */
{
  check('a plain pdf under the size cap is accepted', classifyEntry({ path: 'invoice.pdf', isDir: false, sizeBytes: 1024 }).accept);
  check('a plain photo is accepted', classifyEntry({ path: 'IMG_0001.JPG', isDir: false, sizeBytes: 1024 }).accept, 'extension check must be case-insensitive');
  for (const ext of SUPPORTED_EXTENSIONS) {
    check(`.${ext} is accepted`, classifyEntry({ path: `f.${ext}`, isDir: false, sizeBytes: 10 }).accept);
  }

  const dir = classifyEntry({ path: 'Invoices/', isDir: true, sizeBytes: 0 });
  eq('a folder entry is skipped as directory', [dir.accept, dir.reason], [false, 'directory']);

  const macMeta = classifyEntry({ path: '__MACOSX/._invoice.pdf', isDir: false, sizeBytes: 400 });
  eq('a __MACOSX metadata file is skipped', [macMeta.accept, macMeta.reason], [false, 'macosx']);
  const macNested = classifyEntry({ path: 'Export/__MACOSX/junk.pdf', isDir: false, sizeBytes: 400 });
  eq('__MACOSX is caught even nested partway through the path', [macNested.accept, macNested.reason], [false, 'macosx']);

  const dotfile = classifyEntry({ path: 'Export/.DS_Store', isDir: false, sizeBytes: 400 });
  eq('a dotfile is skipped', [dotfile.accept, dotfile.reason], [false, 'dotfile']);

  const empty = classifyEntry({ path: 'blank.pdf', isDir: false, sizeBytes: 0 });
  eq('a zero-byte file is skipped as empty', [empty.accept, empty.reason], [false, 'empty']);

  const unsupported = classifyEntry({ path: 'notes.docx', isDir: false, sizeBytes: 400 });
  eq('an unsupported extension is skipped', [unsupported.accept, unsupported.reason], [false, 'unsupported-type']);
  const noExt = classifyEntry({ path: 'README', isDir: false, sizeBytes: 400 });
  eq('no extension at all is skipped as unsupported, not crashes', [noExt.accept, noExt.reason], [false, 'unsupported-type']);

  const tooBig = classifyEntry({ path: 'scan.pdf', isDir: false, sizeBytes: MAX_BULK_FILE_BYTES + 1 });
  eq('a file over MAX_BULK_FILE_BYTES is skipped as too-large', [tooBig.accept, tooBig.reason], [false, 'too-large']);
  check('a file exactly at the cap is accepted (boundary)', classifyEntry({ path: 'scan.pdf', isDir: false, sizeBytes: MAX_BULK_FILE_BYTES }).accept);
  check('MAX_BULK_FILE_BYTES matches api/_lib/readDocument.js MAX_PDF_BYTES (24 MB)', MAX_BULK_FILE_BYTES === 24 * 1024 * 1024);

  // Precedence when a file could match more than one skip reason: a hidden,
  // empty, unsupported file inside __MACOSX is reported as __MACOSX — that is
  // the most useful single reason (the whole folder is junk) and matches the
  // order classifyEntry checks in.
  const worstCase = classifyEntry({ path: '__MACOSX/.hidden.docx', isDir: false, sizeBytes: 0 });
  eq('overlapping skip reasons report the most specific one (macosx wins)', worstCase.reason, 'macosx');

  eq('extOf lowercases and strips the dot', extOf('Invoice.PDF'), 'pdf');
  eq('extOf on a file with no extension is empty', extOf('README'), '');
  eq('contentTypeFor maps a known extension', contentTypeFor('a.pdf'), 'application/pdf');
  eq('contentTypeFor falls back for an unknown extension', contentTypeFor('a.docx'), 'application/octet-stream');
}

/* ------------------------------------------------------------------- chunk */
{
  eq('chunk splits evenly', chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  eq('chunk carries a remainder in the last group', chunk([1, 2, 3], 2), [[1, 2], [3]]);
  eq('chunk of an empty array is empty', chunk([], 5), []);
  eq('a chunk size larger than the input is one group', chunk([1, 2], 50), [[1, 2]]);
  let threw = false;
  try {
    chunk([1], 0);
  } catch {
    threw = true;
  }
  check('chunk rejects a non-positive size', threw);
}

/* -------------------------------------------------------- batch presign shaping */
{
  const files = [{ filename: 'a.pdf', sha256: 'x'.repeat(64), contentType: 'application/pdf', sizeBytes: 10 }];
  eq('buildBatchPresignBody wraps files verbatim under a "files" key', buildBatchPresignBody(files), { files });

  const tooMany = Array.from({ length: MAX_BATCH_PRESIGN_FILES + 1 }, (_, i) => ({ filename: `f${i}.pdf`, sha256: 'a'.repeat(64) }));
  let threw = false;
  try {
    buildBatchPresignBody(tooMany);
  } catch {
    threw = true;
  }
  check(`buildBatchPresignBody rejects more than ${MAX_BATCH_PRESIGN_FILES} files (must match MAX_BATCH_FILES in api/upload-url.js)`, threw);
  check('a batch of exactly the max is accepted', buildBatchPresignBody(tooMany.slice(0, MAX_BATCH_PRESIGN_FILES)).files.length === MAX_BATCH_PRESIGN_FILES);
}

/* --------------------------------------------------------- backoff / retry */
{
  const noJitter = { random: () => 0.5 }; // midpoint -> zero jitter offset
  eq('computeBackoffMs attempt 1 with no jitter is exactly baseMs', computeBackoffMs(1, { baseMs: 1000, ...noJitter }), 1000);
  eq('computeBackoffMs doubles per attempt with no jitter', computeBackoffMs(2, { baseMs: 1000, ...noJitter }), 2000);
  eq('computeBackoffMs doubles again', computeBackoffMs(3, { baseMs: 1000, ...noJitter }), 4000);
  eq('computeBackoffMs is capped at maxMs', computeBackoffMs(10, { baseMs: 1000, maxMs: 5000, ...noJitter }), 5000);

  const low = computeBackoffMs(3, { baseMs: 1000, jitterRatio: 0.25, random: () => 0 });
  const high = computeBackoffMs(3, { baseMs: 1000, jitterRatio: 0.25, random: () => 1 });
  check('jitter moves the delay down at random()=0', low < 4000, `got ${low}`);
  check('jitter moves the delay up at random()=1', high > 4000, `got ${high}`);
  check('jitter never produces a negative delay', computeBackoffMs(1, { baseMs: 10, jitterRatio: 1, random: () => 0 }) >= 0);

  check('429 is retryable', isRetryableStatus(429));
  check('503 is retryable', isRetryableStatus(503));
  check('502 and 504 are retryable (upstream/gateway hiccups)', isRetryableStatus(502) && isRetryableStatus(504));
  check('400 is not retryable', !isRetryableStatus(400));
  check('413 (too large) is not retryable — retrying a file that is too large cannot succeed', !isRetryableStatus(413));
  check('500 is not retryable (not one of the transient statuses)', !isRetryableStatus(500));
  check('undefined status (e.g. a thrown non-HTTP error) is not retryable', !isRetryableStatus(undefined));

  check('MAX_FILE_RETRIES is 3, per the brief', MAX_FILE_RETRIES === 3);
  check('DEFAULT_BULK_CONCURRENCY is 4, per the brief', DEFAULT_BULK_CONCURRENCY === 4);
}

/* -------------------------------------------------------------- daily cap */
{
  const capError = new IngestHttpError('Too many requests', 429, { scope: 'per-day', details: 'Daily limit of 300 ingest requests reached' });
  const minuteError = new IngestHttpError('Too many requests', 429, { scope: 'per-minute' });
  const validationError = new IngestHttpError('filename is required', 400, {});
  check('a 429 with scope "per-day" is recognized as the daily cap', isDailyCapError(capError));
  check('a 429 with scope "per-minute" is NOT the daily cap (that one should still retry)', !isDailyCapError(minuteError));
  check('a 400 is never the daily cap regardless of body', !isDailyCapError(validationError));
  check('a plain Error (not IngestHttpError) is never the daily cap', !isDailyCapError(new Error('boom')));
  check('a non-error value is never the daily cap', !isDailyCapError(undefined) && !isDailyCapError(null) && !isDailyCapError('429'));
}

/* --------------------------------------------------------- concurrency limiter */
{
  // Never more than `concurrency` callbacks running at once, and every item visited exactly once.
  await (async () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const seen = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency(
      items,
      async (item) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        seen.push(item);
        inFlight--;
      },
      4
    );
    eq('runWithConcurrency visits every item exactly once', [...seen].sort((a, b) => a - b), items);
    check('runWithConcurrency never exceeds the requested concurrency', maxInFlight <= 4, `saw ${maxInFlight} in flight`);
  })();

  await (async () => {
    // A concurrency higher than the item count must not start more workers than there is work for.
    let started = 0;
    await runWithConcurrency([1, 2], async () => {
      started++;
    }, 10);
    eq('runWithConcurrency never starts more workers than items', started, 2);
  })();

  await (async () => {
    // An already-aborted signal stops the runner from doing any work at all.
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await runWithConcurrency([1, 2, 3], async () => {
      ran = true;
    }, 4, controller.signal);
    check('runWithConcurrency does no work when the signal is already aborted', !ran);
  })();

  await (async () => {
    // Aborting partway through stops further items from starting.
    const controller = new AbortController();
    let started = 0;
    await runWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        started++;
        if (started === 3) controller.abort();
        await new Promise((r) => setTimeout(r, 1));
      },
      2,
      controller.signal
    );
    check('aborting mid-run stops later items from starting', started < 20, `${started} of 20 started`);
  })();
}

/* -------------------------------------------- ingestClient.ts rate-limit backoff */
// Limit-test defect E (2026-09-20): the single-file "Add files" path had no
// 429/503 retry at all, unlike bulkImport.ts's dedicated uploader. These
// mirror the isRetryableStatus/isDailyCapError checks above, for
// ingestFile/ingestFiles' own error classifiers.
{
  const perMinute = new IngestHttpError('Too many requests', 429, { scope: 'per-minute' });
  const noScope = new IngestHttpError('Too many requests', 429, {});
  const perDay = new IngestHttpError('Too many requests', 429, { scope: 'per-day' });
  const unavailable = new IngestHttpError('Service unavailable', 503, {});
  const tooLarge = new IngestHttpError('File too large', 413, {});
  const billing = new IngestHttpError('Subscription required', 402, {});

  check('a per-minute 429 is retryable', isRetryableIngestStatus(perMinute));
  check('...and is NOT the daily cap', !isDailyCapIngestError(perMinute));
  check('a 429 with no scope at all is treated as retryable (per-minute-shaped)', isRetryableIngestStatus(noScope));
  check('a per-day 429 is recognized as the daily cap', isDailyCapIngestError(perDay));
  check('...and is NOT retried (retrying cannot succeed today)', !isRetryableIngestStatus(perDay));
  check('503 is retryable', isRetryableIngestStatus(unavailable));
  check('413 is never retryable', !isRetryableIngestStatus(tooLarge));
  check('402 is never retryable', !isRetryableIngestStatus(billing));
  check('a plain Error (not IngestHttpError) is never retryable or the daily cap', !isRetryableIngestStatus(new Error('boom')) && !isDailyCapIngestError(new Error('boom')));
  check('MAX_INGEST_RATE_LIMIT_RETRIES is 3 (15s/30s/60s tiers)', MAX_INGEST_RATE_LIMIT_RETRIES === 3);
}

{
  // IngestRateGate: a shared backoff window, honoring Retry-After when the
  // server sent one — proven here with small (millisecond-scale)
  // retryAfterSeconds values so the test runs fast rather than waiting out
  // the real 15s/30s/60s tiers.
  await (async () => {
    const gate = new IngestRateGate();
    const t0 = Date.now();
    gate.noteRateLimited(new IngestHttpError('rate limited', 429, {}, 0.02), 1); // 20ms
    await gate.wait();
    const elapsed = Date.now() - t0;
    check('wait() honors a small Retry-After delay (waits at least ~15ms)', elapsed >= 15, `elapsed ${elapsed}ms`);
    check('wait() does not wildly overshoot the requested delay', elapsed < 500, `elapsed ${elapsed}ms`);
  })();

  await (async () => {
    // A shared window: a SECOND, shorter-delay notification must not shrink
    // an already-longer wait already in effect (Math.max semantics) — this
    // is what keeps 3 concurrent workers from each independently resetting
    // the window to their own (possibly shorter) retry.
    const gate = new IngestRateGate();
    const t0 = Date.now();
    gate.noteRateLimited(new IngestHttpError('rate limited', 429, {}, 0.06), 1); // 60ms — the longer one
    gate.noteRateLimited(new IngestHttpError('rate limited', 429, {}, 0.01), 1); // 10ms — must not shorten it
    await gate.wait();
    const elapsed = Date.now() - t0;
    check('a shorter second notification does not shrink the shared window', elapsed >= 45, `elapsed ${elapsed}ms`);
  })();

  await (async () => {
    // No Retry-After header -> falls back to the fixed attempt-1 tier
    // (15s) — too slow to actually wait out in a unit test, so this just
    // confirms wait() respects an abort instead of hanging the whole suite.
    const controller = new AbortController();
    const gate = new IngestRateGate(controller.signal);
    gate.noteRateLimited(new IngestHttpError('rate limited', 429, {}), 1); // no retryAfterSeconds -> 15s tier
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 20);
    await gate.wait();
    const elapsed = Date.now() - t0;
    check('an aborted signal cuts the fixed-tier wait short instead of blocking ~15s', elapsed < 500, `elapsed ${elapsed}ms`);
  })();
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
