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
 */

import { authHeader } from './authToken';

export type IngestStatus = 'hashing' | 'uploading' | 'reading' | 'done' | 'error';

export interface IngestResult {
  filename: string;
  documentId?: string;
  pages?: number;
  duplicate?: boolean;
  error?: string;
}

export interface IngestProgress {
  filename: string;
  status: IngestStatus;
  error?: string;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // A 500 from Vercel is an HTML page, so .json() would throw a SyntaxError
    // and hide the real status. Read as text and try to parse.
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — keep the status */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** Ingest one file. Resolves with a result rather than throwing, so one bad
 *  file in a batch of forty does not abandon the other thirty-nine. */
export async function ingestFile(
  file: File,
  onProgress?: (p: IngestProgress) => void
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
    });

    if (alreadyUploaded) {
      report('done');
      return { filename: file.name, documentId, duplicate: true };
    }

    if (uploadUrl) {
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: file.type ? { 'Content-Type': file.type } : undefined,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    }

    report('reading');
    const { pages } = await postJson<{ pages: number }>('/api/read-document', { documentId });

    report('done');
    return { filename: file.name, documentId, pages };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    report('error', error);
    return { filename: file.name, error };
  }
}

/**
 * Ingest a batch. Bounded concurrency on purpose: extraction is the slow,
 * expensive step, and firing forty of them at once would hit rate limits and
 * make every single file slower than doing a few at a time.
 */
export async function ingestFiles(
  files: File[],
  onProgress?: (p: IngestProgress) => void,
  concurrency = 3
): Promise<IngestResult[]> {
  const results: IngestResult[] = new Array(files.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      const file = files[i];
      if (!file) return;
      results[i] = await ingestFile(file, onProgress);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}
