/**
 * Real file ingestion: browser -> R2 -> Postgres.
 *
 * Until this existed, the intake screen took the dropped File, kept `f.name`,
 * and let the File itself be garbage-collected. Everything downstream — the
 * pipeline stages, the record counts, the answers — was therefore about
 * filenames, not documents. Nothing could be re-read, cited, or verified,
 * because nothing was kept.
 *
 * The flow, three calls per file:
 *   1. hash the bytes in the browser (so the server can dedupe without ever
 *      receiving a duplicate)
 *   2. POST /api/upload-url -> a document row + a short-lived presigned PUT
 *   3. PUT the bytes straight to object storage, then POST /api/read-document,
 *      which reads the file back out and writes its page text into Postgres
 *
 * The bytes never pass through a serverless function: a 30 MB scanned PDF
 * would exceed the request body limit, and paying compute to relay uploads
 * makes them slower and more expensive for no benefit.
 *
 * Step 3 has two shapes now. When the server has a queue configured it answers
 * 202 and does the reading out of band, so the browser stops holding a request
 * open for the length of a transcription and starts polling instead. When it
 * does not, it answers 200 with the page count exactly as before. The client
 * handles both because which one happens is a deployment detail, and a UI that
 * only worked against one of them would break the moment the other was
 * configured.
 */

import { authHeader } from './authToken.ts';
import { messageFromResponse, parseRetryAfterSeconds } from './httpError.ts';

export type IngestStatus = 'hashing' | 'uploading' | 'reading' | 'queued' | 'pending' | 'waiting' | 'done' | 'error';

export interface IngestResult {
  filename: string;
  documentId?: string;
  pages?: number;
  fields?: number;
  duplicate?: boolean;
  queued?: boolean;
  /** The server chained field extraction behind the read; wait for that too. */
  awaitingExtraction?: boolean;
  error?: string;
  /** Set alongside `error` only for a 402 (subscription required / free
   *  preview used up — see handoffs/BILLING_RULES.md) so the caller can offer
   *  a "See plans" button instead of just showing the message. */
  billingUrl?: string;
}

export interface IngestProgress {
  filename: string;
  status: IngestStatus;
  error?: string;
}

interface DocumentStatusRow {
  id: string;
  original_filename: string;
  stage: string;
  page_count: number | null;
  extracted_at: string | null;
  extract_error: string | null;
  field_count: string | number | null;
  verified_by?: string | null;
  /** Only present when the caller is api/document-status.js's own consumer
   *  (App.tsx's processing poll) — required-field completeness for the
   *  document's current type. Not requested by `waitForIngest` below. */
  completeness?: { complete: boolean };
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Plain-language fallback when the server gave no usable error message. Never a raw HTTP status line — nobody dropping off paperwork knows what a 502 means. */
export const NETWORK_ERROR_MESSAGE = "Couldn't reach DeepWell — check your connection and try again.";

/**
 * Turns a failed response's raw body into copy a contractor can act on: the
 * server's own message when it sent one as JSON, otherwise plain language.
 * Pure (just a string in, a string out) so it is unit-tested without a
 * network call — see scripts/verify-ui.ts.
 */
export function describeFetchFailure(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    /* not JSON — a 500 from Vercel is an HTML page */
  }
  return NETWORK_ERROR_MESSAGE;
}

/**
 * Thrown by `postJson` on a non-2xx response. `.message` is the same plain-
 * language text `ingestFile`'s catch has always reported (via
 * `describeFetchFailure`); `.status` and `.body` are the raw HTTP status and
 * parsed JSON body, which single-file ingest never needed but bulk import
 * does — to tell a 429 (retry it) from a 413 (don't), and a per-minute 429
 * from the daily-cap 429 the server flags with `body.scope === 'per-day'`
 * (see api/_lib/rateLimit.js). Exported so bulkImport.ts can inspect it.
 */
export class IngestHttpError extends Error {
  status: number;
  body: unknown;
  /** Seconds from the response's `Retry-After` header, when the server sent
   *  one on a 429 — see rateLimit.js's send429. Undefined for any other
   *  status, or a 429 with no such header. */
  retryAfterSeconds?: number;
  constructor(message: string, status: number, body: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = 'IngestHttpError';
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let parsedBody: unknown = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON — a 500 from Vercel is an HTML page */
    }
    const message = res.status === 429 ? messageFromResponse(res, parsedBody, describeFetchFailure(raw)) : describeFetchFailure(raw);
    const retryAfterSeconds = res.status === 429 ? parseRetryAfterSeconds(res.headers.get('Retry-After')) : undefined;
    throw new IngestHttpError(message, res.status, parsedBody, retryAfterSeconds);
  }
  return res.json() as Promise<T>;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** One entry of a batch presign request/response — see api/upload-url.js's BATCH MODE. */
export interface PresignRequestItem {
  filename: string;
  sha256: string;
  contentType?: string;
  sizeBytes?: number;
}
export interface PresignResultItem {
  filename?: string;
  documentId?: string;
  storageKey?: string;
  alreadyUploaded?: boolean;
  uploadUrl?: string | null;
  error?: string;
  status?: number;
}

/** Presign one file. Thin wrapper so single-file and bulk-fallback paths share it. */
export async function requestUploadUrl(body: PresignRequestItem, signal?: AbortSignal): Promise<PresignResultItem> {
  return postJson<PresignResultItem>('/api/upload-url', body, signal);
}

/** Presign up to 50 files in one request — the batch path bulk import uses. */
export async function requestUploadUrlsBatch(files: PresignRequestItem[], signal?: AbortSignal): Promise<PresignResultItem[]> {
  const { results } = await postJson<{ results: PresignResultItem[] }>('/api/upload-url', { files }, signal);
  return results;
}

/** PUT a file's bytes straight to the presigned R2 URL. Never goes through a serverless function. */
export async function putFile(uploadUrl: string, file: File | Blob, signal?: AbortSignal): Promise<void> {
  const contentType = file instanceof File ? file.type : undefined;
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: contentType ? { 'Content-Type': contentType } : undefined,
    signal,
  });
  if (!put.ok) throw new Error('Upload failed — check your connection and try again.');
}

/** Kick off (or, when the queue is off, complete) the read step for an already-uploaded document. */
export async function readDocument(
  documentId: string,
  signal?: AbortSignal
): Promise<{ pages?: number; queued?: boolean; extract?: boolean }> {
  return postJson('/api/read-document', { documentId }, signal);
}

/**
 * "Add files" 429/503 backoff (2026-09-20 limit test, defect E): the
 * single-file path (`ingestFile`/`ingestFiles`) had no retry at all, unlike
 * bulkImport.ts's dedicated drop-zone uploader — a 40-file picker selection
 * at concurrency 3 could trip the per-minute ingest-unit limiter on roughly a
 * third of its files with no recovery. `isDailyCapIngestError` and
 * `isRetryableIngestStatus` mirror bulkImport.ts's own `isDailyCapError`/
 * `isRetryableStatus`: a 'per-day' 429 (or 402/413) can never succeed on
 * retry and is surfaced immediately; a 'per-minute' 429 (or a missing scope
 * — the daily model-spend budget's 429 carries no `scope` at all but is a
 * `/api/ask` shape ingestFiles never sees) or a 503 is a transient condition
 * worth waiting out.
 */
export function isDailyCapIngestError(err: unknown): boolean {
  if (!(err instanceof IngestHttpError) || err.status !== 429) return false;
  const body = err.body as { scope?: string } | null | undefined;
  return body?.scope === 'per-day';
}

export function isRetryableIngestStatus(err: unknown): boolean {
  if (!(err instanceof IngestHttpError)) return false;
  if (err.status === 503) return true;
  if (err.status !== 429) return false;
  return !isDailyCapIngestError(err);
}

/** Fixed backoff tiers for a rate-limited retry with no `Retry-After` header
 *  — 1-indexed by attempt (attempt 1 -> 15s, 2 -> 30s, 3 -> 60s). */
const INGEST_RATE_LIMIT_DELAYS_MS = [15_000, 30_000, 60_000];
export const MAX_INGEST_RATE_LIMIT_RETRIES = INGEST_RATE_LIMIT_DELAYS_MS.length;

function ingestRetryDelayMs(err: unknown, attempt: number): number {
  const retryAfter = err instanceof IngestHttpError ? err.retryAfterSeconds : undefined;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  const idx = Math.min(Math.max(attempt, 1), INGEST_RATE_LIMIT_DELAYS_MS.length) - 1;
  return INGEST_RATE_LIMIT_DELAYS_MS[idx] as number;
}

/**
 * One shared backoff window across every worker in an `ingestFiles()` run —
 * same idea as bulkImport.ts's `RateGate`: one worker hitting the per-minute
 * limit backs the WHOLE run off, rather than each of the 3 concurrent
 * workers independently retrying and collectively still hammering the
 * limiter at 3x the rate any one file's own retry intended.
 */
export class IngestRateGate {
  private resumeAt = 0;
  private signal?: AbortSignal;
  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }
  noteRateLimited(err: unknown, attempt: number): void {
    this.resumeAt = Math.max(this.resumeAt, Date.now() + ingestRetryDelayMs(err, attempt));
  }
  async wait(): Promise<void> {
    const remaining = this.resumeAt - Date.now();
    if (remaining > 0) await sleep(remaining, this.signal);
  }
}

/** Ingest one file. Resolves with a result rather than throwing, so one bad
 *  file in a batch of forty does not abandon the other thirty-nine.
 *
 *  `signal` cancels the in-flight request(s) — the caller aborting on
 *  unmount stops promptly instead of the upload or poll continuing to run
 *  (and to call onProgress) against a screen nobody is looking at.
 *
 *  `gate`, when passed, retries a per-minute 429 or a 503 up to
 *  MAX_INGEST_RATE_LIMIT_RETRIES times, waiting on the SHARED window above
 *  before each retry — see the module comment just above. A 'per-day' 429,
 *  a 402, or a 413 is never retried, whether or not a gate was passed. */
export async function ingestFile(
  file: File,
  onProgress?: (p: IngestProgress) => void,
  signal?: AbortSignal,
  gate?: IngestRateGate
): Promise<IngestResult> {
  const report = (status: IngestStatus, error?: string) =>
    onProgress?.({ filename: file.name, status, error });

  for (let attempt = 1; ; attempt++) {
    try {
      await gate?.wait();
      report('hashing');
      const sha256 = await sha256Hex(file);

      report('uploading');
      const { documentId, uploadUrl, alreadyUploaded } = await requestUploadUrl(
        { filename: file.name, sha256, contentType: file.type || undefined, sizeBytes: file.size },
        signal
      );

      if (alreadyUploaded) {
        report('done');
        return { filename: file.name, documentId, duplicate: true };
      }

      if (uploadUrl) {
        await putFile(uploadUrl, file, signal);
      }

      report('reading');
      const read = await readDocument(documentId as string, signal);

      if (read.queued) {
        report('queued');
        return {
          filename: file.name,
          documentId,
          queued: true,
          awaitingExtraction: read.extract !== false,
        };
      }

      report('done');
      return { filename: file.name, documentId, pages: read.pages };
    } catch (err) {
      if (isAbortError(err)) {
        // Deliberately cancelled (screen unmounted) — not a failure, and
        // nobody is watching this progress anymore, so stay quiet.
        return { filename: file.name, error: 'Cancelled' };
      }
      if (gate && isRetryableIngestStatus(err) && attempt <= MAX_INGEST_RATE_LIMIT_RETRIES) {
        gate.noteRateLimited(err, attempt);
        report('waiting', "Waiting for the server's rate limit…");
        await gate.wait();
        continue;
      }
      const error = err instanceof Error ? err.message : String(err);
      const billingUrl = err instanceof IngestHttpError && err.status === 402 ? (err.body as { url?: string } | null)?.url : undefined;
      report('error', error);
      return { filename: file.name, error, billingUrl };
    }
  }
}

/** One poll of the server's view of a set of documents. */
export async function fetchDocumentStatus(documentIds: string[], signal?: AbortSignal): Promise<DocumentStatusRow[]> {
  if (!documentIds.length) return [];
  const { documents } = await postJson<{ documents: DocumentStatusRow[] }>(
    '/api/document-status',
    { documentIds },
    signal
  );
  return documents;
}

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** Resolves after `ms`, or as soon as `signal` aborts — whichever is first. Never rejects: an abort just ends the wait early so the caller's own loop-top check can exit promptly. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** Pipeline stages in order. Anything at or past 'mapped' has had fields extracted. */
const STAGES = ['received', 'read', 'mapped', 'linked', 'verified'];

/**
 * Has this document reached the end of the work that was queued for it?
 *
 * `extracted_at` alone is not the finish line when extraction was chained
 * behind the read: the read step sets it, so a poll landing between the two
 * steps would call the document done and report zero fields on a document whose
 * extraction had not started. When extraction is coming, wait for the stage to
 * advance to 'mapped' instead.
 */
function isFinished(row: DocumentStatusRow, result: IngestResult): boolean {
  if (!row.extracted_at) return false;
  if (!result.awaitingExtraction) return true;
  return STAGES.indexOf(row.stage) >= STAGES.indexOf('mapped');
}

/** Shown for documents still processing when the poll gives up — a status, not a failure. Rendered in a neutral pill, never the warn pill an actual error gets. */
export const STILL_PROCESSING_MESSAGE = 'Still processing — check Records in a few minutes';

/**
 * Terminal condition for the App-level "Processing N of M…" tracker (see
 * store/appStore.ts's trackProcessingDocs and App.tsx's poll loop). Broader
 * than `isFinished` above, which only covers the read/extract step: this
 * covers the whole pipeline through classify/link/AI-verify, since the
 * client-side upload+read can finish in seconds while the server keeps
 * working for minutes after that.
 */
export function isProcessingTerminal(row: Pick<DocumentStatusRow, 'stage' | 'extract_error' | 'completeness'>): boolean {
  if (row.extract_error) return true;
  if (row.stage === 'verified') return true;
  if ((row.stage === 'mapped' || row.stage === 'linked') && row.completeness?.complete) return true;
  return false;
}

/** Must match MAX_IDS in api/document-status.js — a request over this limit
 *  is rejected outright, so a bulk import tracking more than 100 documents
 *  has to split its poll into chunks this size or smaller. */
export const MAX_STATUS_IDS = 100;

/** Splits ids into ≤`size` groups, preserving order (a local copy of
 *  bulkImport.ts's `chunk` — not imported from there, since that module
 *  imports FROM this one and importing it back would be circular). */
export function chunkIds(ids: string[], size = MAX_STATUS_IDS): string[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Polls document status for however many ids are pending, chunked to
 * MAX_STATUS_IDS per request. Chunks run with `Promise.allSettled`, not
 * `Promise.all`: a dropped request for one chunk must not stop the others
 * from reporting the documents that DID answer — otherwise one flaky
 * request among several would stall an entire bulk import's "Processing N of
 * M…" indicator from ever advancing. `fetcher` is injected so this is
 * testable without a real network call (see scripts/verify-ui.ts).
 */
export async function pollDocumentStatusChunked(
  ids: string[],
  fetcher: (chunk: string[], signal?: AbortSignal) => Promise<DocumentStatusRow[]>,
  signal?: AbortSignal
): Promise<DocumentStatusRow[]> {
  const chunks = chunkIds(ids);
  const settled = await Promise.allSettled(chunks.map((c) => fetcher(c, signal)));
  const rows: DocumentStatusRow[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') rows.push(...r.value);
  }
  return rows;
}

/**
 * Wait for queued documents to finish reading.
 *
 * Finished means `extracted_at` is set or `extract_error` is — the document is
 * done either way, and a failed one must not hold the batch open. Polling stops
 * at fifteen minutes so a run that never lands cannot pin a tab open forever;
 * the documents keep processing server-side regardless, which is the whole
 * reason the work was moved off the request in the first place. A timeout is
 * not a failure — the extraction is still happening — so it reports status
 * 'pending', not 'error', and never sets `result.error`.
 *
 * `signal` lets the caller stop polling immediately (e.g. IntakeScreen
 * unmounting) rather than waiting out the full interval or the whole
 * fifteen minutes.
 */
export async function waitForIngest(
  results: IngestResult[],
  onProgress?: (p: IngestProgress) => void,
  signal?: AbortSignal
): Promise<IngestResult[]> {
  const pending = new Map(
    results.filter((r) => r.queued && r.documentId).map((r) => [r.documentId as string, r])
  );
  if (!pending.size) return results;

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (pending.size && Date.now() < deadline) {
    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS, signal);
    if (signal?.aborted) break;

    let rows: DocumentStatusRow[];
    try {
      rows = await fetchDocumentStatus([...pending.keys()], signal);
    } catch {
      continue; // a dropped poll is not a failed ingest; try again (or exit above, if that was an abort)
    }

    for (const row of rows) {
      const result = pending.get(row.id);
      if (!result) continue;
      if (row.extract_error) {
        result.error = row.extract_error;
        result.queued = false;
        pending.delete(row.id);
        onProgress?.({ filename: result.filename, status: 'error', error: row.extract_error });
      } else if (isFinished(row, result)) {
        result.pages = row.page_count ?? undefined;
        result.fields = Number(row.field_count ?? 0);
        result.queued = false;
        pending.delete(row.id);
        onProgress?.({ filename: result.filename, status: 'done' });
      }
    }
  }

  if (!signal?.aborted) {
    for (const result of pending.values()) {
      result.queued = false;
      onProgress?.({ filename: result.filename, status: 'pending' });
    }
  }

  return results;
}

/**
 * Ingest a batch. Bounded concurrency on purpose: extraction is the slow,
 * expensive step, and firing forty of them at once would hit rate limits and
 * make every single file slower than doing a few at a time.
 *
 * When the server queues, the uploads still go up a few at a time — that limit
 * is about the browser's own bandwidth — but the reading is no longer serialised
 * behind them, so `waitForIngest` is what the caller waits on.
 */
export async function ingestFiles(
  files: File[],
  onProgress?: (p: IngestProgress) => void,
  concurrency = 3,
  signal?: AbortSignal
): Promise<IngestResult[]> {
  const results: IngestResult[] = new Array(files.length);
  let next = 0;
  const gate = new IngestRateGate(signal);

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      const file = files[i];
      if (!file) return;
      results[i] = await ingestFile(file, onProgress, signal, gate);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  if (signal?.aborted) return results.filter(Boolean);
  return waitForIngest(results, onProgress, signal);
}
