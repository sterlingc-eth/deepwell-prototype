/**
 * Bulk import: thousands of files at once, from a dropped .zip (a
 * ServiceTitan/Jobber/Housecall Pro export, or a scanning vendor's delivery)
 * or from a plain multi-file selection, without the browser or a serverless
 * function choking.
 *
 * This sits ON TOP of the existing single-file pipeline in ingestClient.ts —
 * it does not reimplement hashing, presigning, uploading or reading. What it
 * adds:
 *
 *   1. `walkZip` — unzips client-side (jszip, dynamically imported so a
 *      plain multi-file drop never pays for it) and applies the same accept/
 *      skip rules a plain file list gets, so a folder full of junk (__MACOSX,
 *      dotfiles, zero-byte files, oversized scans, unsupported types) is
 *      reported with a reason instead of silently failing 1000 individual
 *      uploads later.
 *   2. `startBulkImport` — a bounded-concurrency uploader (default 4 in
 *      flight) that batches presign requests up to 50 at a time (cutting
 *      request count up to 50x versus one request per file), retries each
 *      file up to 3 times, and backs the whole run off (exponential + jitter)
 *      when the server starts returning 429/503, rather than hammering it
 *      harder. It stops outright — no more retries, no more files started —
 *      the moment the server's *daily* cap is hit (rateLimit.js `scope:
 *      'per-day'`), since retrying that is certain to fail until UTC
 *      midnight.
 *
 * Progress is kept in memory only (an array of `BulkFileState`), matching
 * ingestClient.ts's existing choice for single uploads: if the tab closes
 * mid-run, nothing here tries to resume it — IntakeScreen's existing
 * `fetchDocumentStatus` poll (by documentId) is what tells the user, on next
 * load, what did and didn't make it, exactly as it already does for a
 * single-file drop that outlives the tab.
 */

import {
  sha256Hex,
  requestUploadUrl,
  requestUploadUrlsBatch,
  putFile,
  readDocument,
  isAbortError,
  IngestHttpError,
  type PresignRequestItem,
  type PresignResultItem,
} from './ingestClient.ts';

// ------------------------------------------------------------- archive walk

export type SkipReason = 'macosx' | 'dotfile' | 'directory' | 'empty' | 'too-large' | 'unsupported-type';

export interface SkippedEntry {
  path: string;
  reason: SkipReason;
  detail: string;
}

/** filename extension (lowercased, no dot) -> content type. Also the accepted-extension allowlist. */
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  txt: 'text/plain',
  csv: 'text/csv',
};
export const SUPPORTED_EXTENSIONS = Object.keys(CONTENT_TYPES);

/**
 * Mirrors MAX_PDF_BYTES in api/_lib/readDocument.js. This is a client-side
 * pre-filter to avoid spending an upload on a file the server would reject
 * outright, not a security boundary — /api/upload-url enforces its own
 * (more precise, per-content-type) limits regardless, and remains the source
 * of truth.
 */
export const MAX_BULK_FILE_BYTES = 24 * 1024 * 1024;

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extOf(name)] ?? 'application/octet-stream';
}

export type ClassifyVerdict = { accept: true } | { accept: false; reason: SkipReason; detail: string };

/**
 * Pure accept/skip decision for one archive entry or dropped file. Used by
 * both `walkZip` (a real jszip entry) and `startBulkImport` (a plain `File`,
 * so a many-files drop with no zip involved gets identical skip reporting).
 */
export function classifyEntry(entry: { path: string; isDir: boolean; sizeBytes: number }): ClassifyVerdict {
  const { path, isDir, sizeBytes } = entry;
  if (isDir) return { accept: false, reason: 'directory', detail: 'Folder entry' };

  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? path;

  if (segments.includes('__MACOSX')) {
    return { accept: false, reason: 'macosx', detail: 'macOS archive metadata folder' };
  }
  if (base.startsWith('.')) {
    return { accept: false, reason: 'dotfile', detail: 'Hidden file' };
  }
  if (sizeBytes <= 0) {
    return { accept: false, reason: 'empty', detail: 'Zero-byte file' };
  }
  const ext = extOf(base);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return { accept: false, reason: 'unsupported-type', detail: ext ? `Unsupported file type .${ext}` : 'No file extension' };
  }
  if (sizeBytes > MAX_BULK_FILE_BYTES) {
    return { accept: false, reason: 'too-large', detail: `Larger than ${Math.round(MAX_BULK_FILE_BYTES / (1024 * 1024))} MB` };
  }
  return { accept: true };
}

export interface WalkedFile {
  /** Full relative path inside the archive, forward-slash separated — e.g. "2019 Cabinet/Invoices/inv-102.pdf". */
  path: string;
  /** Basename only. */
  name: string;
  sizeBytes: number;
  toFile: () => Promise<File>;
}

export interface ZipWalkResult {
  accepted: WalkedFile[];
  skipped: SkippedEntry[];
}

/**
 * jszip's CJS (`export =`) shape doesn't type-check cleanly as a static
 * import under this project's bundler-mode TS config, and importing it
 * eagerly would add real weight to the main bundle for a screen almost
 * nobody drops a zip on. Loaded dynamically and treated as `any` at this one
 * boundary — the surface used below (`loadAsync`, `.files`, `.dir`, `.name`,
 * `.async`) has been stable across jszip's 3.x line.
 */
async function loadJSZip(): Promise<any> {
  const mod: any = await import('jszip');
  return mod.default ?? mod;
}

/**
 * `_data.uncompressedSize` is JSZip's own undocumented-but-stable way to get
 * a file's size WITHOUT decompressing it — see the comment on this field in
 * jszip's own type definitions. Falling back to decompressing just to measure
 * a handful of files is fine; doing it for every one of a few thousand is
 * not, so the cheap path is tried first and is the common case.
 */
async function sizeOfZipEntry(entry: any): Promise<number> {
  const known = entry?._data?.uncompressedSize;
  if (typeof known === 'number') return known;
  const bytes: Uint8Array = await entry.async('uint8array');
  return bytes.byteLength;
}

/** Unzip an archive client-side and classify every entry. Never rejects on a bad entry — that entry is just skipped. */
export async function walkZip(zipFile: File | Blob): Promise<ZipWalkResult> {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(zipFile);
  const accepted: WalkedFile[] = [];
  const skipped: SkippedEntry[] = [];

  for (const entry of Object.values(zip.files) as any[]) {
    const path: string = entry.name;
    if (entry.dir) {
      skipped.push({ path, reason: 'directory', detail: 'Folder entry' });
      continue;
    }
    const name = path.split('/').filter(Boolean).pop() ?? path;

    // Name-only checks (macOS junk, dotfiles, unsupported extensions) first,
    // so those never pay to decompress. `sizeBytes: 1` is a placeholder that
    // can only trip the size checks, which are re-run for real below.
    const cheapVerdict = classifyEntry({ path, isDir: false, sizeBytes: 1 });
    if (!cheapVerdict.accept && cheapVerdict.reason !== 'empty' && cheapVerdict.reason !== 'too-large') {
      skipped.push({ path, reason: cheapVerdict.reason, detail: cheapVerdict.detail });
      continue;
    }

    const sizeBytes = await sizeOfZipEntry(entry);
    const verdict = classifyEntry({ path, isDir: false, sizeBytes });
    if (!verdict.accept) {
      skipped.push({ path, reason: verdict.reason, detail: verdict.detail });
      continue;
    }

    accepted.push({
      path,
      name,
      sizeBytes,
      toFile: async () => new File([await entry.async('blob')], name, { type: contentTypeFor(name) }),
    });
  }

  return { accepted, skipped };
}

// ------------------------------------------------------------- plain files

/**
 * Wrap a `File` from a plain multi-file `<input>` or drop (no zip) in the
 * same shape `walkZip` produces, so one uploader handles both sources.
 * `webkitRelativePath` is populated when the browser gave us a folder drop;
 * otherwise the path is just the filename.
 */
export function sourceFromFile(file: File): WalkedFile {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  const path = relative && relative.length > 0 ? relative : file.name;
  return { path, name: file.name, sizeBytes: file.size, toFile: async () => file };
}

// -------------------------------------------------------------- chunking

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Must match MAX_BATCH_FILES in api/upload-url.js. */
export const MAX_BATCH_PRESIGN_FILES = 50;

export function buildBatchPresignBody(files: PresignRequestItem[]): { files: PresignRequestItem[] } {
  if (files.length > MAX_BATCH_PRESIGN_FILES) {
    throw new Error(`Batch presign is limited to ${MAX_BATCH_PRESIGN_FILES} files per request`);
  }
  return { files };
}

// -------------------------------------------------------------- retry / backoff

export const MAX_FILE_RETRIES = 3;
export const DEFAULT_BULK_CONCURRENCY = 4;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/** Exponential backoff with +/- jitter, capped. `attempt` is 1-based. */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30_000;
  const jitterRatio = opts.jitterRatio ?? 0.25;
  const random = opts.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** The server's daily hard cap (api/_lib/rateLimit.js, scope: 'per-day') — retrying before UTC midnight cannot succeed. */
export function isDailyCapError(err: unknown): boolean {
  if (!(err instanceof IngestHttpError)) return false;
  const body = err.body as { scope?: string } | null | undefined;
  return err.status === 429 && body?.scope === 'per-day';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Shared across every in-flight worker in one bulk run: when ANY worker sees
 * a 429/503-class response, every worker's next attempt (this file's own
 * retry, or the next file entirely) waits out a shared backoff window
 * instead of each worker backing off independently and the run collectively
 * still hammering the server at 4x the rate one file's own retry intended.
 * A clean success resets it — a rate limit is a current-conditions signal,
 * not a verdict on the whole run.
 */
class RateGate {
  private resumeAt = 0;
  private consecutive = 0;
  private readonly signal?: AbortSignal;
  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  noteFailure(): void {
    this.consecutive++;
    const ms = computeBackoffMs(this.consecutive, { baseMs: 2000, maxMs: 60_000 });
    this.resumeAt = Math.max(this.resumeAt, Date.now() + ms);
  }
  noteSuccess(): void {
    this.consecutive = 0;
  }
  async wait(): Promise<void> {
    const remaining = this.resumeAt - Date.now();
    if (remaining > 0) await sleep(remaining, this.signal);
  }
}

// -------------------------------------------------------------- concurrency runner

export async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency = DEFAULT_BULK_CONCURRENCY,
  signal?: AbortSignal
): Promise<void> {
  let next = 0;
  const runOne = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runOne));
}

// -------------------------------------------------------------- progress state

export type BulkFileStatus =
  | 'pending'
  | 'hashing'
  | 'uploading'
  | 'reading'
  | 'queued'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface BulkFileState {
  path: string;
  name: string;
  sizeBytes: number;
  status: BulkFileStatus;
  attempt: number;
  error?: string;
  skipReason?: SkipReason;
  documentId?: string;
}

export interface BulkProgressSummary {
  total: number;
  /** Bytes landed in storage and a read requested (includes files still queued server-side). */
  uploaded: number;
  /** Uploaded and awaiting the server-side read to finish. */
  queued: number;
  skipped: number;
  failed: number;
  /** Not yet in any terminal state. */
  pending: number;
}

export function summarizeProgress(states: BulkFileState[]): BulkProgressSummary {
  let uploaded = 0;
  let queued = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  for (const s of states) {
    if (s.status === 'done') uploaded++;
    else if (s.status === 'queued') {
      uploaded++;
      queued++;
    } else if (s.status === 'skipped') skipped++;
    else if (s.status === 'failed' || s.status === 'cancelled') failed++;
    else pending++;
  }
  return { total: states.length, uploaded, queued, skipped, failed, pending };
}

/** Cap a list for display: the UI never renders more than `max` rows, however many files are in the run. */
export function truncateForDisplay<T>(items: T[], max = 200): { shown: T[]; hiddenCount: number } {
  if (items.length <= max) return { shown: items, hiddenCount: 0 };
  return { shown: items.slice(0, max), hiddenCount: items.length - max };
}

// -------------------------------------------------------------- the uploader

export interface BulkImportCallbacks {
  onState?: (states: BulkFileState[]) => void;
  /** Fired once, the moment the server's daily cap stops the whole run. `remaining` is always 0 — the cap is already spent. */
  onDailyCapReached?: (remaining: number) => void;
}

export interface BulkImportOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

export interface BulkImportHandle {
  /** Resolves with the final state of every file once the run stops (finished, cancelled, or daily-capped). */
  result: Promise<BulkFileState[]>;
  cancel: () => void;
}

/**
 * Try presigning a whole group in one batched call; fall back to `null`
 * (per-file presign, inside `uploadOne`) on a whole-call failure so one bad
 * batch response never fails files that would have presigned fine alone.
 * A daily-cap error is NOT swallowed here — it propagates so the caller can
 * stop the run outright instead of quietly falling back to 50 per-file
 * calls that are all guaranteed to hit the same cap.
 */
async function presignGroup(
  group: { source: WalkedFile; file: File; sha256: string }[],
  signal: AbortSignal
): Promise<PresignResultItem[] | null> {
  try {
    return await requestUploadUrlsBatch(
      group.map((g) => ({ filename: g.source.path, sha256: g.sha256, contentType: g.file.type || undefined, sizeBytes: g.file.size })),
      signal
    );
  } catch (err) {
    if (isDailyCapError(err)) throw err;
    return null;
  }
}

/**
 * Start a bulk import. Returns immediately with a handle; progress streams
 * through `callbacks.onState` as it happens, and `result` resolves once the
 * whole run has stopped one way or another.
 *
 * Files that don't pass `classifyEntry` are marked 'skipped' up front and
 * never touch the network — `walkZip` already applies this for archive
 * entries, but a plain multi-file `<input>` selection reaches this function
 * un-filtered, so it's re-applied here for either source.
 */
export function startBulkImport(
  sources: WalkedFile[],
  opts: BulkImportOptions = {},
  callbacks: BulkImportCallbacks = {}
): BulkImportHandle {
  const controller = new AbortController();
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const signal = controller.signal;
  const concurrency = opts.concurrency ?? DEFAULT_BULK_CONCURRENCY;

  const states: BulkFileState[] = sources.map((s) => ({ path: s.path, name: s.name, sizeBytes: s.sizeBytes, status: 'pending', attempt: 0 }));
  const emit = () => callbacks.onState?.(states.slice());
  const gate = new RateGate(signal);
  const dailyCap = { hit: false };

  const result = (async (): Promise<BulkFileState[]> => {
    const workIndexes: number[] = [];
    sources.forEach((s, i) => {
      const verdict = classifyEntry({ path: s.path, isDir: false, sizeBytes: s.sizeBytes });
      if (verdict.accept) {
        workIndexes.push(i);
      } else {
        states[i] = { ...(states[i] as BulkFileState), status: 'skipped', skipReason: verdict.reason, error: verdict.detail };
      }
    });
    emit();

    for (const group of chunk(workIndexes, MAX_BATCH_PRESIGN_FILES)) {
      if (signal.aborted || dailyCap.hit) break;

      group.forEach((i) => {
        states[i] = { ...(states[i] as BulkFileState), status: 'hashing' };
      });
      emit();

      let prepared: { source: WalkedFile; file: File; sha256: string }[];
      try {
        prepared = await Promise.all(
          group.map(async (i) => {
            const source = sources[i] as WalkedFile;
            const file = await source.toFile();
            const sha256 = await sha256Hex(file);
            return { source, file, sha256 };
          })
        );
      } catch (err) {
        group.forEach((i) => {
          states[i] = { ...(states[i] as BulkFileState), status: 'failed', error: err instanceof Error ? err.message : String(err) };
        });
        emit();
        continue;
      }

      let presignResults: PresignResultItem[] | null;
      try {
        presignResults = await presignGroup(prepared, signal);
      } catch (err) {
        if (isDailyCapError(err)) {
          dailyCap.hit = true;
          callbacks.onDailyCapReached?.(0);
          group.forEach((i) => {
            states[i] = { ...(states[i] as BulkFileState), status: 'failed', error: 'Daily upload limit reached' };
          });
          emit();
          break;
        }
        presignResults = null;
      }

      // uploadOne re-hashes/re-reads the file lazily only on RETRY (attempt >
      // 1) or when no batch presign result exists for it — the first attempt
      // reuses the hash and File already computed above via a one-off source
      // wrapper so the work done for the batch presign isn't repeated.
      await runWithConcurrency(
        group,
        async (i, groupPos) => {
          const p = prepared[groupPos] as { source: WalkedFile; file: File; sha256: string };
          const firstResult = presignResults?.[groupPos] ?? null;
          await uploadPresigned(p.source, p.file, p.sha256, firstResult, states, i, emit, gate, signal, dailyCap);
        },
        concurrency,
        signal
      );

      if (dailyCap.hit) break;
    }

    if (signal.aborted) {
      states.forEach((s, i) => {
        if (s.status !== 'done' && s.status !== 'queued' && s.status !== 'skipped' && s.status !== 'failed') {
          states[i] = { ...s, status: 'cancelled' };
        }
      });
    } else if (dailyCap.hit) {
      states.forEach((s, i) => {
        if (s.status !== 'done' && s.status !== 'queued' && s.status !== 'skipped' && s.status !== 'failed') {
          states[i] = { ...s, status: 'failed', error: 'Daily upload limit reached — not attempted' };
        }
      });
    }
    emit();
    return states;
  })();

  return { result, cancel: () => controller.abort() };
}

/**
 * Upload one file whose first presign attempt MAY already be in hand (from a
 * batch call). Falls through to `uploadOne`'s own per-file presign for every
 * retry, and whenever no batch result was available at all.
 */
async function uploadPresigned(
  source: WalkedFile,
  file: File,
  sha256: string,
  firstPresign: PresignResultItem | null,
  states: BulkFileState[],
  index: number,
  emit: () => void,
  gate: RateGate,
  signal: AbortSignal,
  dailyCap: { hit: boolean }
): Promise<void> {
  const set = (patch: Partial<BulkFileState>) => {
    states[index] = { ...(states[index] as BulkFileState), ...patch };
    emit();
  };

  for (let attempt = 1; attempt <= MAX_FILE_RETRIES; attempt++) {
    if (signal.aborted) {
      set({ status: 'cancelled' });
      return;
    }
    if (dailyCap.hit) {
      set({ status: 'failed', error: 'Daily upload limit reached' });
      return;
    }
    await gate.wait();
    set({ status: 'uploading', attempt });

    try {
      const presign: PresignResultItem =
        attempt === 1 && firstPresign
          ? firstPresign
          : await requestUploadUrl({ filename: source.path, sha256, contentType: file.type || undefined, sizeBytes: file.size }, signal);
      if (presign.error) throw new IngestHttpError(presign.error, presign.status ?? 500, presign);

      if (!presign.alreadyUploaded && presign.uploadUrl) {
        await putFile(presign.uploadUrl, file, signal);
      }

      set({ status: 'reading', documentId: presign.documentId });
      const read = await readDocument(presign.documentId as string, signal);
      gate.noteSuccess();
      set({ status: read.queued ? 'queued' : 'done', error: undefined });
      return;
    } catch (err) {
      if (isAbortError(err)) {
        set({ status: 'cancelled' });
        return;
      }
      if (isDailyCapError(err)) {
        dailyCap.hit = true;
        set({ status: 'failed', error: 'Daily upload limit reached' });
        return;
      }
      const status = err instanceof IngestHttpError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (isRetryableStatus(status)) gate.noteFailure();

      const canRetry = isRetryableStatus(status) && attempt < MAX_FILE_RETRIES;
      if (!canRetry) {
        set({ status: 'failed', error: message });
        return;
      }
      set({ error: `${message} — retrying` });
      await sleep(computeBackoffMs(attempt), signal);
    }
  }
}
