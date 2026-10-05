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
import {
  EXT_KIND, EXT_CONTENT_TYPES, KIND_CAP_BYTES, MAX_ABSOLUTE_BYTES, MAX_MODEL_READ_BYTES, extensionOf, refusalForExtension,
} from '../../api/_lib/uploadTypes.js';
import { prepareImageForUpload } from './imageConvert.ts';

// ------------------------------------------------------------- archive walk

export type SkipReason =
  | 'macosx' | 'dotfile' | 'directory' | 'empty' | 'too-large' | 'unsupported-type'
  // Zip protection (walkZip): an entry whose name climbs out of the archive, a zip inside the zip, or a size/ratio that looks like a bomb.
  | 'unsafe-path' | 'nested-zip' | 'zip-bomb';

export interface SkippedEntry {
  path: string;
  reason: SkipReason;
  detail: string;
}

/**
 * The allow-list is the SERVER's (api/_lib/uploadTypes.js, imported here so the two can never drift): pdf, jpg, jpeg, png, gif,
 * webp, txt, md, csv, tsv, json, docx, xlsx. HEIC/HEIF are also let through here ONLY because the browser converts them to JPEG
 * before upload (imageConvert.ts); the server itself refuses them.
 */
const CONVERTED_EXTENSIONS = ['heic', 'heif'];
export const SUPPORTED_EXTENSIONS = [...Object.keys(EXT_KIND), ...CONVERTED_EXTENSIONS];

/**
 * Mirrors the 24 MB PDF/photo read cap (api/_lib/uploadTypes.js KIND_CAP_BYTES, which /api/upload-url enforces per kind). This is a
 * client-side pre-filter to avoid spending an upload on a file the server would reject outright, not a security boundary.
 */
export const MAX_BULK_FILE_BYTES = MAX_MODEL_READ_BYTES;

export function extOf(name: string): string {
  return extensionOf(name);
}

export function contentTypeFor(name: string): string {
  const ext = extOf(name);
  return EXT_CONTENT_TYPES[ext]?.[0] ?? (CONVERTED_EXTENSIONS.includes(ext) ? 'image/heic' : 'application/octet-stream');
}

export type ClassifyVerdict = { accept: true } | { accept: false; reason: SkipReason; detail: string };

/** Names that are never safe to take from an archive: absolute, drive-lettered, or climbing out with "..". Pure. */
export function isUnsafeArchivePath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return true;
  return p.split('/').some((seg) => seg === '..');
}

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
  if (ext === 'zip') {
    return { accept: false, reason: 'nested-zip', detail: 'A .zip inside a .zip is not opened. Unzip it yourself and add the files inside.' };
  }
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return { accept: false, reason: 'unsupported-type', detail: ext ? refusalForExtension(ext) : 'No file extension' };
  }
  const cap = CONVERTED_EXTENSIONS.includes(ext) ? MAX_ABSOLUTE_BYTES : (KIND_CAP_BYTES[EXT_KIND[ext] as string] ?? MAX_BULK_FILE_BYTES);
  if (sizeBytes > cap) {
    return { accept: false, reason: 'too-large', detail: `Larger than ${Math.round(cap / (1024 * 1024))} MB` };
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

// Zip-bomb protection. The numbers are generous for a real export (a field-service archive is thousands of small PDFs and photos)
// and tight for a hostile one. Declared sizes come from the archive's own directory; jszip checks every inflated entry against its
// declared size and CRC, so a lie surfaces as an error on that entry, never as more bytes than declared.
export const MAX_ZIP_FILE_BYTES = 2 * 1024 * 1024 * 1024; // the .zip itself (a browser cannot hold more in memory anyway)
export const MAX_ZIP_ENTRIES = 10_000; // directory entries + files
export const MAX_ZIP_TOTAL_DECLARED_BYTES = 6 * 1024 * 1024 * 1024; // all accepted entries after inflating
export const MAX_ZIP_RATIO = 200; // inflated / compressed, for any entry over 1 MiB (real PDFs/photos are ~1x, text up to ~20x)
const ZIP_RATIO_MIN_BYTES = 1024 * 1024;

export const ZIP_TOO_MANY_ENTRIES_MESSAGE = `This .zip holds more than ${MAX_ZIP_ENTRIES.toLocaleString('en-US')} items, which is more than DeepWell unzips at once. Split it into smaller zips and add them one at a time.`;
export const ZIP_TOO_BIG_MESSAGE = 'This .zip is larger than 2 GB. Split it into smaller zips and add them one at a time.';
export const ZIP_BOMB_MESSAGE = 'This .zip expands to far more data than it should (a "zip bomb" or a damaged file), so it was not opened. Make a new zip of the files and try again.';
export const ZIP_UNREADABLE_MESSAGE = "This .zip couldn't be opened (it may be damaged or password-protected). Make a new zip, or add the files without zipping them.";

export interface ZipEntryInfo {
  name: string;
  dir: boolean;
  /** Declared (directory) sizes; NaN/undefined when unknown. */
  compressedSize?: number;
  uncompressedSize?: number;
}

export interface ZipPlan {
  /** Whole-archive refusal; when set nothing from this archive is read. */
  refused: string | null;
  /** One verdict per input entry, same order. */
  verdicts: ClassifyVerdict[];
}

/**
 * Pure: classify every entry of an archive from its directory alone (names and declared sizes), applying the allow-list, the
 * path rules and the bomb limits. No bytes are inflated. Entries with unsafe names are skipped (never extracted under a name that
 * could climb out of a folder), nested archives are refused, and one entry with an absurd ratio or size is skipped on its own.
 */
export function planZipEntries(entries: ZipEntryInfo[]): ZipPlan {
  if (entries.length > MAX_ZIP_ENTRIES) return { refused: ZIP_TOO_MANY_ENTRIES_MESSAGE, verdicts: [] };
  let total = 0;
  const verdicts: ClassifyVerdict[] = entries.map((e) => {
    if (e.dir) return classifyEntry({ path: e.name, isDir: true, sizeBytes: 0 });
    if (isUnsafeArchivePath(e.name)) {
      return { accept: false, reason: 'unsafe-path', detail: 'The name points outside the folder (.. or an absolute path), so this entry was ignored' };
    }
    const size = Number.isFinite(e.uncompressedSize) ? (e.uncompressedSize as number) : 1;
    const comp = Number.isFinite(e.compressedSize) ? (e.compressedSize as number) : 0;
    const verdict = classifyEntry({ path: e.name, isDir: false, sizeBytes: size });
    if (!verdict.accept) return verdict;
    if (size > ZIP_RATIO_MIN_BYTES && size / Math.max(1, comp) > MAX_ZIP_RATIO) {
      return { accept: false, reason: 'zip-bomb', detail: `Expands ${Math.round(size / Math.max(1, comp))}x, far more than a real document does` };
    }
    total += size;
    return verdict;
  });
  if (total > MAX_ZIP_TOTAL_DECLARED_BYTES) return { refused: ZIP_BOMB_MESSAGE, verdicts: [] };
  return { refused: null, verdicts };
}

/** Pure: the entry count the end-of-central-directory record of an archive declares, read from its LAST bytes (no parsing of the entries); null when not found, Infinity when zip64 (count too large for the classic field). */
export function declaredZipEntryCount(tail: Uint8Array): number | null {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      const n = (tail[i + 10] as number) | ((tail[i + 11] as number) << 8);
      return n === 0xffff ? Infinity : n;
    }
  }
  return null;
}

/** Unzip an archive client-side and classify every entry. Never rejects on a bad entry — that entry is just skipped. A hostile or damaged archive as a whole comes back as one skipped "(archive)" row with the reason. */
export async function walkZip(zipFile: File | Blob): Promise<ZipWalkResult> {
  const refuseArchive = (reason: SkipReason, detail: string): ZipWalkResult => ({
    accepted: [],
    skipped: [{ path: (zipFile as File).name || '(archive)', reason, detail }],
  });
  if (zipFile.size > MAX_ZIP_FILE_BYTES) return refuseArchive('too-large', ZIP_TOO_BIG_MESSAGE);
  try {
    const tail = new Uint8Array(await zipFile.slice(Math.max(0, zipFile.size - 66_000)).arrayBuffer());
    const declared = declaredZipEntryCount(tail);
    if (declared !== null && declared > MAX_ZIP_ENTRIES) return refuseArchive('zip-bomb', ZIP_TOO_MANY_ENTRIES_MESSAGE);
  } catch {
    /* unreadable tail: let loadAsync report it */
  }
  const JSZip = await loadJSZip();
  let zip: any;
  try {
    zip = await JSZip.loadAsync(zipFile, { checkCRC32: true });
  } catch {
    return refuseArchive('unsupported-type', ZIP_UNREADABLE_MESSAGE);
  }
  const accepted: WalkedFile[] = [];
  const skipped: SkippedEntry[] = [];

  const all = Object.values(zip.files) as any[];
  const plan = planZipEntries(
    all.map((entry) => ({
      name: String(entry.name),
      dir: !!entry.dir,
      compressedSize: entry?._data?.compressedSize,
      uncompressedSize: entry?._data?.uncompressedSize,
    }))
  );
  if (plan.refused) return refuseArchive('zip-bomb', plan.refused);

  for (const [i, entry] of all.entries()) {
    const path: string = entry.name;
    const verdict = plan.verdicts[i] as ClassifyVerdict;
    if (!verdict.accept) {
      skipped.push({ path, reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    const name = path.split('/').filter(Boolean).pop() ?? path;
    const sizeBytes = typeof entry?._data?.uncompressedSize === 'number' ? entry._data.uncompressedSize : await sizeOfZipEntry(entry);
    if (typeof entry?._data?.uncompressedSize !== 'number') {
      // Size was not in the directory: it is only known after inflating, so apply the same size rule now.
      const real = classifyEntry({ path, isDir: false, sizeBytes });
      if (!real.accept) {
        skipped.push({ path, reason: real.reason, detail: real.detail });
        continue;
      }
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

/** R35: a whole-batch 402 - "choose a plan", the monthly page limit, or the stored-document limit. Like the daily cap,
 *  every further request in this run is guaranteed to get the same answer, so the run stops instead of falling back to
 *  one presign per file (thousands of failing calls). */
export function isPlanLimitError(err: unknown): boolean {
  return err instanceof IngestHttpError && err.status === 402;
}

function message402(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Plan limit reached';
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
  /** R35: fired once when a plan/billing limit (HTTP 402) stops the whole run; `message` is the server's own plain-English text. */
  onPlanLimitReached?: (message: string) => void;
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
    if (isDailyCapError(err) || isPlanLimitError(err)) throw err;
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
  const dailyCap = { hit: false, message: 'Daily upload limit reached' };

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

    for (let group of chunk(workIndexes, MAX_BATCH_PRESIGN_FILES)) {
      if (signal.aborted || dailyCap.hit) break;

      group.forEach((i) => {
        states[i] = { ...(states[i] as BulkFileState), status: 'hashing' };
      });
      emit();

      let prepared: { source: WalkedFile; file: File; sha256: string }[];
      try {
        const attempts = await Promise.all(
          group.map(async (i) => {
            const source = sources[i] as WalkedFile;
            let file = await source.toFile();
            // iPhone photos (HEIC/HEIF) are converted to JPEG here, per file: one that this browser cannot decode fails alone.
            const prep = await prepareImageForUpload(file);
            if (!prep.ok) return { i, error: prep.message };
            file = prep.file;
            // The converted copy is a different file: it is uploaded (and listed) under its new .jpg name.
            const upSource: WalkedFile = prep.converted
              ? { ...source, path: source.path.replace(/\.[A-Za-z0-9]+$/, '.jpg'), name: file.name, sizeBytes: file.size }
              : source;
            // A converted file is a new, different file: re-apply the size rule to the JPEG that will actually be uploaded.
            if (prep.converted && file.size > MAX_BULK_FILE_BYTES) return { i, error: 'This photo is larger than 24 MB even after conversion. Choose a smaller photo.' };
            const sha256 = await sha256Hex(file);
            return { i, value: { source: upSource, file, sha256 } };
          })
        );
        for (const a of attempts) {
          if ('error' in a && a.error) states[a.i] = { ...(states[a.i] as BulkFileState), status: 'failed', error: a.error };
        }
        const okAttempts = attempts.filter((a): a is { i: number; value: { source: WalkedFile; file: File; sha256: string } } => 'value' in a);
        group = okAttempts.map((a) => a.i);
        prepared = okAttempts.map((a) => a.value);
        emit();
        if (!group.length) continue;
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
        if (isDailyCapError(err) || isPlanLimitError(err)) {
          dailyCap.hit = true;
          if (isPlanLimitError(err)) {
            dailyCap.message = (err as Error).message || 'Plan limit reached';
            callbacks.onPlanLimitReached?.(dailyCap.message);
          } else {
            callbacks.onDailyCapReached?.(0);
          }
          group.forEach((i) => {
            states[i] = { ...(states[i] as BulkFileState), status: 'failed', error: dailyCap.message };
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
          states[i] = { ...s, status: 'failed', error: `${dailyCap.message} — not attempted` };
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
  dailyCap: { hit: boolean; message: string }
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
      set({ status: 'failed', error: dailyCap.message });
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
      // R35: a per-file 402 (the batch allowance ran out part-way, or a lone presign hit the cap) also ends the run.
      if (isPlanLimitError(err) || (err instanceof IngestHttpError && err.status === 402)) {
        dailyCap.hit = true;
        dailyCap.message = message402(err);
        set({ status: 'failed', error: dailyCap.message });
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
