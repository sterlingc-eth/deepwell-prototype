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

import { authHeader } from './authToken';

export type IngestStatus = 'hashing' | 'uploading' | 'reading' | 'queued' | 'pending' | 'done' | 'error';

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
}

async function sha256Hex(file: File): Promise<string> {
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

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(describeFetchFailure(raw));
  }
  return res.json() as Promise<T>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Ingest one file. Resolves with a result rather than throwing, so one bad
 *  file in a batch of forty does not abandon the other thirty-nine.
 *
 *  `signal` cancels the in-flight request(s) — the caller aborting on
 *  unmount stops promptly instead of the upload or poll continuing to run
 *  (and to call onProgress) against a screen nobody is looking at. */
export async function ingestFile(
  file: File,
  onProgress?: (p: IngestProgress) => void,
  signal?: AbortSignal
): Promise<IngestResult> {
  const report = (status: IngestStatus, error?: string) =>
    onProgress?.({ filename: file.name, status, error });

  try {
    report('hashing');
    const sha256 = await sha256Hex(file);

    report('uploading');
    const { documentId, uploadUrl, alreadyUploaded } = await postJson<{
      documentId: string;
      uploadUrl: string | null;
      alreadyUploaded: boolean;
    }>('/api/upload-url', {
      filename: file.name,
      sha256,
      contentType: file.type || undefined,
      sizeBytes: file.size,
    }, signal);

    if (alreadyUploaded) {
      report('done');
      return { filename: file.name, documentId, duplicate: true };
    }

    if (uploadUrl) {
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: file.type ? { 'Content-Type': file.type } : undefined,
        signal,
      });
      if (!put.ok) throw new Error('Upload failed — check your connection and try again.');
    }

    report('reading');
    const read = await postJson<{ pages?: number; queued?: boolean; extract?: boolean }>(
      '/api/read-document',
      { documentId },
      signal
    );

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
    const error = err instanceof Error ? err.message : String(err);
    report('error', error);
    return { filename: file.name, error };
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

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      const file = files[i];
      if (!file) return;
      results[i] = await ingestFile(file, onProgress, signal);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  if (signal?.aborted) return results.filter(Boolean);
  return waitForIngest(results, onProgress, signal);
}
