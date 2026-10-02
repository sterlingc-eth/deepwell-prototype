#!/usr/bin/env node
/**
 * DeepWell staff import runner (R43).
 *
 * Loads a folder of one customer's files (any size, tens of thousands of files) into DeepWell through the SAME upload
 * path the browser uses: ask /api/upload-url for presigned uploads, PUT the bytes straight to storage, then ask
 * /api/read-document to read each file. Nothing about reading or Donovan changes. It exists because a browser tab cannot
 * reliably push that many files. For DeepWell staff only; see handoffs/IMPORT_RUNBOOK.md.
 *
 *   node scripts/import/deepwell-import.mjs --folder "/path/to/customer files" --dry-run
 *   DEEPWELL_IMPORT_KEY=... node scripts/import/deepwell-import.mjs --folder "/path/to/customer files"
 *
 * Zero dependencies, Node 18 or newer. The import key is read ONLY from the DEEPWELL_IMPORT_KEY environment variable or a
 * hidden prompt: never from a command-line argument, and it is never printed, logged, or written to any file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
export const DEFAULT_BASE_URL = 'https://deepwelltechnology.com';
const MB = 1024 * 1024;
// Pacing knobs. The environment overrides exist only so the automated tests do not wait real minutes.
const BACKOFF_BASE_MS = Math.max(1, Number(process.env.DEEPWELL_IMPORT_BACKOFF_MS) || 2000);
const POLL_MS = Math.max(50, Number(process.env.DEEPWELL_IMPORT_POLL_MS) || 30_000);

/** Mirrors api/upload-url.js: PDFs and photos under 24 MB, text/CSV under 20 MB, 100 MB absolute. */
export const LIMITS = Object.freeze({ model: 24 * MB, text: 20 * MB, absolute: 100 * MB });
/** What the reader can actually read (api/_lib/readDocument.js). TIFF/BMP/HEIC are NOT readable, so they are not here. */
export const SUPPORTED = Object.freeze({
  pdf: ['application/pdf', 'pdf'],
  jpg: ['image/jpeg', 'photo'],
  jpeg: ['image/jpeg', 'photo'],
  png: ['image/png', 'photo'],
  webp: ['image/webp', 'photo'],
  gif: ['image/gif', 'photo'],
  txt: ['text/plain', 'text'],
  csv: ['text/csv', 'text'],
});

const GOOGLE_STUBS = new Set(['gdoc', 'gsheet', 'gslides', 'gdraw', 'gform', 'gmap', 'gsite', 'gjam', 'gscript', 'gtable']);
const CONVERT_HINTS = {
  doc: 'Word', docx: 'Word', odt: 'OpenDocument text', rtf: 'rich text', xls: 'Excel', xlsx: 'Excel', ods: 'OpenDocument sheet',
  ppt: 'PowerPoint', pptx: 'PowerPoint', heic: 'iPhone photo (HEIC)', heif: 'iPhone photo (HEIC)', tif: 'TIFF image', tiff: 'TIFF image',
  bmp: 'BMP image', svg: 'SVG drawing', zip: 'zip archive', eml: 'email', msg: 'email', mp4: 'video', mov: 'video',
};
const HIDDEN_NAMES = new Set(['thumbs.db', 'ehthumbs.db', 'desktop.ini', 'icon\r', '$recycle.bin', 'system volume information', '__macosx', 'lost+found']);

// Planning figures from handoffs / claude/crew/ATLAS_ENGINEERING_PLAN.md (Brandy's per-page costs). ESTIMATES, not quotes.
export const PLANNING = Object.freeze({
  perPageDigital: 0.0015, perPageScan: 0.0142, perPageHeavy: 0.032,
  pagesPerDocLow: 1.5, pagesPerDocHigh: 5, bytesPerPdfPage: 204_800, charsPerTextPage: 6_000,
});

// ------------------------------------------------------------------------------------------------ small helpers

export class UsageError extends Error {}
class StopRun extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
export const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
const fmtUsd = (n) => (n >= 100 ? `$${fmtInt(n)}` : `$${n.toFixed(2)}`);
const fmtDur = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
};
const extOf = (name) => { const i = name.lastIndexOf('.'); return i <= 0 ? '' : name.slice(i + 1).toLowerCase(); };

/** Remove anything that looks like an import key (and any Bearer token) from a string. */
export function redactText(text, key) {
  let s = String(text ?? '');
  if (key && key.length >= 8) s = s.split(key).join('[key hidden]');
  return s.replace(/dw_live_[0-9a-fA-F]{6,}/g, 'dw_live_[hidden]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [hidden]');
}

// ------------------------------------------------------------------------------------------------ classification

/**
 * Pure: decide what to do with one file.
 * @returns {{ok: true, ext: string, contentType: string, kind: 'pdf'|'photo'|'text'} | {ok: false, reason: string, note: string}}
 */
export function classifyFile(name, sizeBytes) {
  const lower = name.toLowerCase();
  const ext = extOf(name);
  if (name.startsWith('.') || name.startsWith('~$') || HIDDEN_NAMES.has(lower) || name.endsWith('~') || ext === 'tmp' || ext === 'lnk') {
    return { ok: false, reason: 'hidden-or-system', note: 'Hidden, system or temporary file (for example .DS_Store, Thumbs.db, ~$ Office temp files).' };
  }
  if (GOOGLE_STUBS.has(ext)) {
    return { ok: false, reason: 'google-stub', note: `.${ext} is only a shortcut to a Google file, not the document. Export the real file to PDF in Google Drive first (File > Download > PDF), then add it to the folder.` };
  }
  if (sizeBytes === 0) return { ok: false, reason: 'empty', note: 'The file is empty (0 bytes), so there is nothing to upload.' };
  const supported = SUPPORTED[ext];
  if (!supported) {
    const what = CONVERT_HINTS[ext];
    return {
      ok: false, reason: 'unsupported-type',
      note: ext
        ? `.${ext}${what ? ` (${what})` : ''} files cannot be read. DeepWell reads PDF, JPEG, PNG, WebP, GIF, plain text and CSV. Convert the file to PDF or JPEG first.`
        : 'The file has no extension, so its type is unknown. Rename it with the right extension or convert it to PDF.',
    };
  }
  const [contentType, kind] = supported;
  if (sizeBytes > LIMITS.absolute) return { ok: false, reason: 'too-large', note: 'Larger than 100 MB. Split it into smaller files.' };
  if (kind === 'text' && sizeBytes > LIMITS.text) return { ok: false, reason: 'too-large', note: 'Text and CSV files must be under 20 MB. Split it into smaller files.' };
  if (kind !== 'text' && sizeBytes > LIMITS.model) return { ok: false, reason: 'too-large', note: 'PDFs and photos must be under 24 MB to be read. Split the file, or scan again at a lower resolution.' };
  return { ok: true, ext, contentType, kind };
}

/** Pure: the pages the server's own gate expects one file to add (api/_lib/plan.js estimatePagesForUpload). */
export function gatePages(kind, sizeBytes) {
  if (kind === 'photo') return 1;
  const per = kind === 'pdf' ? PLANNING.bytesPerPdfPage : PLANNING.charsPerTextPage;
  return Math.max(1, Math.min(200, Math.ceil(sizeBytes / per)));
}

/** Pure: pages and reading cost for a set of supported files. Planning figures only. */
export function estimate(files) {
  let pdfDocs = 0, photos = 0, textPages = 0, bySize = 0;
  for (const f of files) {
    bySize += gatePages(f.kind, f.size);
    if (f.kind === 'pdf') pdfDocs++;
    else if (f.kind === 'photo') photos++;
    else textPages += gatePages(f.kind, f.size);
  }
  const pagesLow = Math.ceil(pdfDocs * PLANNING.pagesPerDocLow) + photos + textPages;
  const pagesHigh = Math.ceil(pdfDocs * PLANNING.pagesPerDocHigh) + photos + textPages;
  const pagesMid = Math.round((pagesLow + pagesHigh) / 2);
  const pdfPages = (n) => Math.max(0, n - photos - textPages);
  const scenario = (digitalShare) => {
    const perPdfPage = digitalShare * PLANNING.perPageDigital + (1 - digitalShare) * PLANNING.perPageScan;
    return pdfPages(pagesMid) * perPdfPage + photos * PLANNING.perPageScan; // text files cost nothing to read
  };
  return {
    docs: files.length, pdfDocs, photos, textFiles: files.length - pdfDocs - photos,
    pagesBySizeRule: bySize, pagesLow, pagesHigh, pagesMid,
    costLow: pdfPages(pagesLow) * PLANNING.perPageDigital + photos * PLANNING.perPageScan,
    costHigh: pdfPages(pagesHigh) * PLANNING.perPageHeavy + photos * PLANNING.perPageHeavy,
    scenarios: [
      { label: 'mostly digital PDFs (80% digital, 20% scans)', cost: scenario(0.8) },
      { label: 'mixed (50% digital, 50% scans)', cost: scenario(0.5) },
      { label: 'mostly scans (20% digital, 80% scans)', cost: scenario(0.2) },
    ],
    suggestedAllowance: Math.max(1000, Math.ceil((bySize * 1.1) / 1000) * 1000),
  };
}

// ------------------------------------------------------------------------------------------------ scanning

/**
 * Walk the folder. Never follows a symbolic link (a link could point outside the folder), never reads a hidden or system
 * folder. Returns every non-folder entry classified, in a stable (sorted) order.
 */
export function scanFolder(rootDir) {
  const root = fs.realpathSync(rootDir);
  const files = [];
  const skipped = [];
  const skippedFolders = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(root, relDir) : root;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      skippedFolders.push({ rel: relDir || '.', note: `could not read this folder (${err.code ?? 'error'})` });
      continue;
    }
    for (const e of entries) {
      const rel = (relDir ? `${relDir}/` : '') + e.name;
      const abs = path.join(absDir, e.name);
      if (e.isSymbolicLink()) {
        skipped.push({ rel, reason: 'link', note: 'A shortcut/symbolic link. The tool never follows links, so nothing outside the folder can be uploaded. Copy the real file into the folder if you need it.', size: 0 });
        continue;
      }
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (e.name.startsWith('.') || HIDDEN_NAMES.has(lower)) skippedFolders.push({ rel, note: 'hidden or system folder (contents not counted)' });
        else stack.push(rel);
        continue;
      }
      if (!e.isFile()) {
        skipped.push({ rel, reason: 'not-a-file', note: 'Not an ordinary file (device, socket or similar).', size: 0 });
        continue;
      }
      let st;
      try { st = fs.lstatSync(abs); } catch (err) {
        skipped.push({ rel, reason: 'unreadable', note: `Could not read the file's details (${err.code ?? 'error'}).`, size: 0 });
        continue;
      }
      const verdict = classifyFile(e.name, st.size);
      if (!verdict.ok) { skipped.push({ rel, reason: verdict.reason, note: verdict.note, size: st.size }); continue; }
      files.push({ rel, abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), ext: verdict.ext, contentType: verdict.contentType, kind: verdict.kind });
    }
  }
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  files.sort(byRel);
  skipped.sort(byRel);
  return { root, files, skipped, skippedFolders };
}

/** Pure: a spread-out sample for the test run: the largest few files plus an even stride over the rest. */
export function pickSample(pending, n) {
  if (!Number.isFinite(n) || n >= pending.length) return pending;
  if (n <= 0) return [];
  const bigCount = Math.min(20, Math.floor(n / 10));
  const big = new Set([...pending].sort((a, b) => b.size - a.size).slice(0, bigCount).map((f) => f.rel));
  const rest = pending.filter((f) => !big.has(f.rel));
  const need = n - big.size;
  const stride = rest.length / need;
  const picks = [];
  for (let i = 0; i < need; i++) picks.push(rest[Math.floor(i * stride)]);
  const chosen = new Set([...big, ...picks.map((f) => f.rel)]);
  return pending.filter((f) => chosen.has(f.rel));
}

// ------------------------------------------------------------------------------------------------ checkpoint (state) file

function loadState(file) {
  const map = new Map();
  let badLines = 0;
  if (!fs.existsSync(file)) return { map, badLines };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.t === 'file' && typeof rec.path === 'string') map.set(rec.path, rec);
    } catch { badLines++; } // a half-written last line after a crash is simply ignored
  }
  return { map, badLines };
}

function openState(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  return {
    append(rec) { fs.writeSync(fd, `${JSON.stringify(rec)}\n`); },
    close() { try { fs.closeSync(fd); } catch { /* already closed */ } },
  };
}

export function defaultStatePath(folder) {
  const abs = path.resolve(folder);
  const safe = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, '_') || 'folder';
  return path.join(path.dirname(abs), `.deepwell-import-${safe}.jsonl`);
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * True only if the file's folder, with every link resolved RIGHT NOW, is still inside the scanned root. The scan never follows
 * links, and reading refuses a link as the file itself (O_NOFOLLOW), but that alone does not stop a folder in the middle of
 * the path being swapped for a link to somewhere else after the scan; this closes that gap just before each read.
 */
export function fileStaysInside(root, abs) {
  try { return isInside(fs.realpathSync(path.dirname(abs)), root); } catch { return false; }
}

// ------------------------------------------------------------------------------------------------ command line

export function parseArgs(argv) {
  const opts = { folder: null, baseUrl: DEFAULT_BASE_URL, state: null, concurrency: 3, limit: null, dryRun: false, yes: false, watchReading: false, checkKey: false, help: false };
  const needValue = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (/^--(key|api-?key|token|secret|password|import-?key)$/i.test(flag) || /dw_live_/i.test(a)) {
      throw new UsageError('The import key must never be typed on the command line (it would be saved in your shell history and visible to other programs). Set the DEEPWELL_IMPORT_KEY environment variable, or leave it unset and the tool will ask for it with a hidden prompt.');
    }
    const val = (f) => (inline !== undefined ? inline : (i++, needValue(i - 1, f)));
    switch (flag) {
      case '--folder': opts.folder = val(flag); break;
      case '--base-url': opts.baseUrl = val(flag); break;
      case '--state': opts.state = val(flag); break;
      case '--concurrency': opts.concurrency = Number(val(flag)); break;
      case '--limit': opts.limit = Number(val(flag)); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--watch-reading': opts.watchReading = true; break;
      case '--check-key': opts.checkKey = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new UsageError(`Unknown option ${flag.slice(0, 40)}. Run with --help to see the options.`);
    }
  }
  if (opts.help) return opts;
  if (!opts.folder) throw new UsageError('--folder <path> is required (the folder of customer files to import).');
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 8) throw new UsageError('--concurrency must be a whole number from 1 to 8.');
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new UsageError('--limit must be a whole number of files, 1 or more.');
  let url;
  try { url = new URL(opts.baseUrl); } catch { throw new UsageError('--base-url is not a valid web address.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new UsageError('--base-url must start with https:// (the key would otherwise travel unencrypted).');
  }
  opts.baseUrl = url.origin;
  return opts;
}

const HELP = `DeepWell staff import runner ${VERSION}

Usage:
  node scripts/import/deepwell-import.mjs --folder <path> [options]

Options:
  --folder <path>      Folder of the customer's files (required). Searched recursively. Never modified.
  --dry-run            Count and classify the files and show an estimate. Uploads nothing, uses no network.
  --check-key          With --dry-run only: also test the import key with one harmless request.
  --limit <N>          Upload only a spread-out sample of N files (for the 500-file test run).
  --yes                Do not ask "Type YES to start".
  --concurrency <1-8>  How many groups of files are sent at once (default 3).
  --watch-reading      After uploading, watch how many documents have finished being read (needs a key with "read").
  --state <file>       Progress file (default: next to the folder, named .deepwell-import-<folder>.jsonl).
                       It must NOT be inside the customer folder. Running again resumes from it.
  --base-url <url>     Default ${DEFAULT_BASE_URL}

The import key comes from the DEEPWELL_IMPORT_KEY environment variable, or a hidden prompt. It is never accepted as an
argument and never printed or saved.

Exit codes: 0 all done, 1 some files failed, 2 could not start (bad options, folder, or key), 3 stopped early (limit
reached, key refused, Ctrl-C) - run it again after fixing the cause and it carries on.
`;

// ------------------------------------------------------------------------------------------------ the key

async function promptHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new UsageError('No import key found. Set the DEEPWELL_IMPORT_KEY environment variable (or run this in a terminal so it can ask for the key).');
  }
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = '';
    const finish = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); fn(v); };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') return finish(resolve, buf.trim());
        if (c === '\u0003') return finish(reject, new UsageError('Cancelled.'));
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export const KEY_SHAPE = /^dw_live_[0-9a-f]{64}$/;

// ------------------------------------------------------------------------------------------------ talking to DeepWell

function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 3600) * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.min(Math.max(0, d - Date.now()), 3_600_000) : null;
}

/** Shared slow-down window: when the server says "too busy", every worker waits, not just the one that was told. */
class Pacer {
  constructor(ctx) { this.ctx = ctx; this.resumeAt = 0; this.consecutive = 0; }
  note(retryAfterMs) {
    this.consecutive++;
    const exp = Math.min(BACKOFF_BASE_MS * 30, BACKOFF_BASE_MS * 2 ** Math.min(this.consecutive - 1, 6));
    const jitter = exp * 0.25 * (Math.random() * 2 - 1);
    const wait = retryAfterMs != null ? retryAfterMs + Math.random() * 500 : exp + jitter;
    this.resumeAt = Math.max(this.resumeAt, Date.now() + Math.max(0, wait));
    return wait;
  }
  ok() { this.consecutive = 0; }
  async wait() {
    for (;;) {
      if (this.ctx.stopping) throw new StopRun('stopping', 'stopping');
      const left = this.resumeAt - Date.now();
      if (left <= 0) return;
      await sleepRaw(Math.min(left, 250));
    }
  }
}

function makeClient(ctx) {
  const redact = (s) => redactText(s, ctx.key);
  async function request(method, urlStr, { body, headers = {}, auth = false, timeoutMs = 60_000 } = {}) {
    const h = { ...headers };
    if (auth) h.Authorization = `Bearer ${ctx.key}`;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; }
    let res;
    try {
      res = await fetch(urlStr, {
        method, headers: h, redirect: 'error',
        body: body === undefined ? undefined : (body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body)),
        signal: AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.abort.signal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (ctx.abort.signal.aborted) throw new StopRun('aborted', 'stopped');
      const e = new Error(redact(`network problem: ${err?.cause?.code ?? err?.name ?? 'error'}`));
      e.network = true;
      throw e;
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text: redact(text.slice(0, 500)) };
  }

  /** Calls to the DeepWell API: retry 429/502/503/504 and network problems with backoff, stop on repeated auth failure. */
  async function api(method, route, body, { maxAttempts = 8, timeoutMs = 60_000 } = {}) {
    let lastNote = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await ctx.pacer.wait();
      let r;
      try {
        r = await request(method, ctx.baseUrl + route, { body, auth: true, timeoutMs });
      } catch (err) {
        if (err instanceof StopRun) throw err;
        ctx.pacer.note(null);
        lastNote = err.message;
        ctx.counters.networkRetries++;
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        ctx.authFails++;
        const msg = authMessage(r);
        if (ctx.authFails >= 2) throw new StopRun('auth', msg);
        lastNote = msg;
        await sleepRaw(Math.min(1500, BACKOFF_BASE_MS));
        continue;
      }
      if (r.status === 429 && r.json?.scope === 'per-day') {
        throw new StopRun('daily-cap', `The daily upload limit for this company has been reached (${redact(r.json?.error ?? 'per-day limit')}). It resets at midnight UTC. Run the tool again after that, or raise the import's "upload units per day" (v_per_day in I1-allow-staff-import.sql) and wait 5 minutes.`);
      }
      if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
        const waited = ctx.pacer.note(parseRetryAfter(r.headers.get('retry-after')));
        ctx.counters.throttled++;
        lastNote = `the server asked us to slow down (${r.status}); waited ${fmtDur(waited / 1000)}`;
        continue;
      }
      ctx.authFails = 0;
      ctx.pacer.ok();
      return r;
    }
    const e = new Error(`gave up after ${maxAttempts} tries: ${lastNote}`);
    e.exhausted = true;
    throw e;
  }
  return { request, api };
}

function authMessage(r) {
  const msg = String(r.json?.error ?? '');
  if (r.status === 401) return 'The import key was refused (wrong, mistyped, or already deleted/revoked). Create a new key in the customer\'s account and run the tool again.';
  if (/Fleet plan/i.test(msg)) return 'API access is not switched on for this company right now. Paste I1-allow-staff-import.sql (or re-paste it if the import ended or expired), wait 5 minutes, then run the tool again.';
  if (/scope/i.test(msg)) return `The key does not have the permission this step needs (${msg}). Create a new key in the customer's account that includes "ingest" (and "read" for --watch-reading).`;
  return `The key was refused (${r.status}): ${msg || 'no reason given'}.`;
}

function stopFor402(r, redact) {
  const msg = redact(String(r.json?.error ?? 'Plan limit reached'));
  if (r.json?.code === 'import-allowance-exhausted') {
    return new StopRun('allowance', `IMPORT PAGE ALLOWANCE USED UP. Server says: "${msg}"\nTo continue: raise v_pages in M3-config/import/I1-allow-staff-import.sql, paste it again, wait 5 minutes, then run this tool again. It carries on where it stopped.`);
  }
  if (r.json?.code === 'import-documents-exhausted' || /plan stores up to/i.test(msg)) {
    return new StopRun('allowance', `THE COMPANY HAS REACHED ITS STORED-DOCUMENT LIMIT. Server says: "${msg}"\nTo continue: raise v_extra_docs in I1-allow-staff-import.sql and paste it again, or move the company to a larger plan; wait 5 minutes, then run this tool again.`);
  }
  if (/Monthly page limit/i.test(msg)) {
    return new StopRun('allowance', `THE MONTHLY PAGE LIMIT WAS HIT, which means the staff import allowance is NOT in force for this company (never pasted, expired, or ended). Server says: "${msg}"\nTo continue: paste I1-allow-staff-import.sql for this company, wait 5 minutes, then run this tool again.`);
  }
  if (/Choose a plan|Subscription required/i.test(msg)) {
    return new StopRun('allowance', `THE COMPANY HAS NO ACTIVE PLAN. Server says: "${msg}"\nThe import needs the company to have a trial or paid plan (any plan). Fix that, then run this tool again.`);
  }
  return new StopRun('allowance', `The server refused to take more files (402): "${msg}"\nFix what it says, wait 5 minutes if you changed limits, then run this tool again.`);
}

// ------------------------------------------------------------------------------------------------ hashing and reading files

const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;

/** Read a file WITHOUT following a symlink swapped in after the scan. Returns {buffer, size, mtimeMs}. */
function readFileSafe(abs) {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error('not an ordinary file any more'), { code: 'ENOTFILE' });
    const buffer = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buffer, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { buffer: off === st.size ? buffer : buffer.subarray(0, off), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } finally {
    fs.closeSync(fd);
  }
}

async function sha256File(abs) {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
  const st = fs.fstatSync(fd);
  if (!st.isFile()) { fs.closeSync(fd); throw Object.assign(new Error('not an ordinary file any more'), { code: 'ENOTFILE' }); }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(null, { fd, autoClose: true, highWaterMark: 1024 * 1024 });
    s.on('data', (d) => hash.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return { sha256: hash.digest('hex'), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

// ------------------------------------------------------------------------------------------------ the dry run

function skipSummary(skipped, skippedFolders) {
  const by = new Map();
  for (const s of skipped) {
    const g = by.get(s.reason) ?? { reason: s.reason, count: 0, bytes: 0, note: s.note, exts: new Map() };
    g.count++; g.bytes += s.size;
    const e = extOf(s.rel.split('/').pop()) || 'no extension';
    g.exts.set(e, (g.exts.get(e) ?? 0) + 1);
    by.set(s.reason, g);
  }
  return { groups: [...by.values()].sort((a, b) => b.count - a.count), folders: skippedFolders.length };
}

const REASON_TITLES = {
  'hidden-or-system': 'Hidden, system or temporary files',
  'google-stub': 'Google Docs/Sheets shortcuts (not real documents)',
  empty: 'Empty files (0 bytes)',
  'unsupported-type': 'Types DeepWell cannot read',
  'too-large': 'Too large to read',
  link: 'Shortcuts / symbolic links (never followed)',
  'not-a-file': 'Not ordinary files',
  unreadable: 'Could not be examined',
};

export function describeScan(scan) {
  const lines = [];
  const kinds = { pdf: [0, 0], photo: [0, 0], text: [0, 0] };
  let totalBytes = 0;
  for (const f of scan.files) { kinds[f.kind][0]++; kinds[f.kind][1] += f.size; totalBytes += f.size; }
  const sk = skipSummary(scan.skipped, scan.skippedFolders);
  const found = scan.files.length + scan.skipped.length;
  lines.push(`Files found: ${fmtInt(found)}`);
  lines.push(`  Will be uploaded: ${fmtInt(scan.files.length)} files, ${fmtBytes(totalBytes)}`);
  lines.push(`    PDFs: ${fmtInt(kinds.pdf[0])} (${fmtBytes(kinds.pdf[1])})   Photos: ${fmtInt(kinds.photo[0])} (${fmtBytes(kinds.photo[1])})   Text/CSV: ${fmtInt(kinds.text[0])} (${fmtBytes(kinds.text[1])})`);
  lines.push(`  Will be skipped: ${fmtInt(scan.skipped.length)}`);
  for (const g of sk.groups) {
    const exts = [...g.exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, n]) => `${e === 'no extension' ? e : `.${e}`} x${fmtInt(n)}`).join(', ');
    lines.push(`    ${REASON_TITLES[g.reason] ?? g.reason}: ${fmtInt(g.count)}${g.bytes ? ` (${fmtBytes(g.bytes)})` : ''} [${exts}]`);
    lines.push(`      Why / what to do: ${g.note}`);
  }
  if (sk.folders) lines.push(`  Hidden/system or unreadable folders skipped: ${fmtInt(sk.folders)} (their contents are not counted)`);
  const biggest = [...scan.files].sort((a, b) => b.size - a.size).slice(0, 3);
  if (biggest.length) lines.push(`  Largest files to upload: ${biggest.map((f) => `${fmtBytes(f.size)}`).join(', ')}`);
  return lines;
}

export function describeEstimate(est) {
  const l = [];
  l.push('ESTIMATES (planning figures from the Atlas plan; real numbers come from the 500-file test run):');
  l.push(`  Pages: roughly ${fmtInt(est.pagesLow)} to ${fmtInt(est.pagesHigh)} (about ${PLANNING.pagesPerDocLow} to ${PLANNING.pagesPerDocHigh} pages per PDF, 1 per photo).`);
  l.push(`  The app's own planning rule (1 page per 200 KB of PDF) gives ${fmtInt(est.pagesBySizeRule)} pages; digital PDFs usually have fewer.`);
  l.push(`  Reading cost (Anthropic): about ${fmtUsd(est.costLow)} if nearly everything is a digital PDF, up to about ${fmtUsd(est.costHigh)} if it is all heavy scans or handwriting.`);
  for (const s of est.scenarios) l.push(`    ${s.label}: about ${fmtUsd(s.cost)}`);
  l.push('  Text files and PDFs with a real text layer cost almost nothing to read; scans and photos are the cost. These are estimates, not a quote.');
  l.push(`  Suggested import page allowance for I1 (v_pages): about ${fmtInt(est.suggestedAllowance)} (the default 250,000 is fine if this is lower).`);
  return l;
}

// ------------------------------------------------------------------------------------------------ the upload run

function newCounters() {
  return { uploaded: 0, uploadedEarlier: 0, present: 0, presentEarlier: 0, sameContent: 0, rejected: 0, failed: 0, throttled: 0, networkRetries: 0, bytes: 0, changedReuploaded: 0 };
}

async function uploadRun(ctx, scan, state, writer, pendingFiles) {
  const { client } = ctx;
  const C = ctx.counters;
  const shaToDoc = ctx.shaToDoc; // sha -> {path, documentId} for content already handled
  const claimed = new Map(); // sha -> rel of the file that is (being) uploaded for it in this run
  const deferred = []; // identical copies met while their twin is still in flight
  const attempts = new Map();
  const redact = (s) => redactText(s, ctx.key);

  /** Write one checkpoint line and update the counters. 'uploaded' is an intermediate step (bytes stored, read not yet asked). */
  const record = (f, status, extra = {}) => {
    const prev = state.get(f.rel);
    const rec = {
      t: 'file', path: f.rel, size: f.size, mtimeMs: f.mtimeMs, sha256: extra.sha256 ?? prev?.sha256 ?? null, status,
      documentId: extra.documentId ?? null, attempts: attempts.get(f.rel) ?? (prev?.attempts ?? 0) + 1, at: new Date().toISOString(),
      ...(extra.note ? { note: redact(extra.note).slice(0, 300) } : {}),
    };
    writer.append(rec);
    state.set(f.rel, rec);
    if (status === 'uploaded') return;
    ctx.finished++;
    if (status === 'done') { C.uploaded++; C.bytes += f.size; }
    else if (status === 'present') C.present++;
    else if (status === 'same-content') C.sameContent++;
    else if (status === 'rejected') C.rejected++;
    else C.failed++;
  };

  async function readStep(documentId) {
    const r = await client.api('POST', '/api/read-document', { documentId });
    if (r.status === 402) throw stopFor402(r, redact);
    if (r.ok) return null;
    if (r.status >= 400 && r.status < 500) return { permanent: true, note: `reading was refused (${r.status}): ${r.json?.error ?? r.text}` };
    return { permanent: false, note: `reading could not be started (${r.status})` };
  }

  async function putStep(f, sha256, uploadUrl) {
    let u;
    try { u = new URL(uploadUrl); } catch { return { ok: false, note: 'the server sent an unusable upload link' }; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return { ok: false, note: 'the server sent a non-https upload link, so it was refused' };
    let file;
    if (!fileStaysInside(scan.root, f.abs)) return { ok: false, note: 'a folder on the way to this file is now a link that leads outside the import folder, so it was not uploaded' };
    try { file = readFileSafe(f.abs); } catch (err) { return { ok: false, note: `could not read the file (${err.code ?? 'error'})` }; }
    if (file.size !== f.size || crypto.createHash('sha256').update(file.buffer).digest('hex') !== sha256) {
      return { ok: false, note: 'the file changed while it was being uploaded; run the tool again to pick up the new version' };
    }
    let lastNote = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      await ctx.pacer.wait();
      try {
        const r = await client.request('PUT', uploadUrl, { body: file.buffer, headers: { 'Content-Type': f.contentType }, timeoutMs: 60_000 + Math.ceil(f.size / 50_000) * 1000 });
        if (r.ok) { ctx.pacer.ok(); return { ok: true }; }
        lastNote = `storage refused the upload (${r.status})`;
        if (r.status === 403) return { ok: false, note: `${lastNote}: the upload link may have expired; run the tool again` };
        if (r.status === 429 || r.status >= 500) { ctx.pacer.note(parseRetryAfter(r.headers.get('retry-after'))); C.throttled++; continue; }
        return { ok: false, note: lastNote };
      } catch (err) {
        if (err instanceof StopRun) throw err;
        lastNote = err.message;
        ctx.pacer.note(null);
        C.networkRetries++;
      }
    }
    return { ok: false, note: `upload failed after 4 tries: ${lastNote}` };
  }

  async function processGroup(group) {
    // 1. fingerprint each file
    const prepared = [];
    for (const f of group) {
      if (ctx.stopping) throw new StopRun('stopping', 'stopping');
      const prev = state.get(f.rel);
      attempts.set(f.rel, (prev?.attempts ?? 0) + 1);
      if (!fileStaysInside(scan.root, f.abs)) { record(f, 'failed', { note: 'a folder on the way to this file is now a link that leads outside the import folder, so it was not read' }); continue; }
      let sha;
      try {
        const h = await sha256File(f.abs);
        if (h.size !== f.size) { record(f, 'failed', { note: 'the file changed while the tool was reading it; run the tool again' }); continue; }
        sha = h.sha256;
      } catch (err) {
        record(f, 'failed', { note: `could not read the file (${err.code ?? 'error'})` });
        continue;
      }
      if (prev && prev.status === 'done' && prev.sha256 !== sha) C.changedReuploaded++;
      const twin = shaToDoc.get(sha);
      if (twin && twin.path !== f.rel) { record(f, 'same-content', { sha256: sha, documentId: twin.documentId, note: `identical to ${twin.path}` }); continue; }
      const inFlight = claimed.get(sha);
      if (inFlight && inFlight !== f.rel) { deferred.push({ f, sha }); continue; }
      claimed.set(sha, f.rel);
      // Bytes already reached storage in an earlier run (status 'uploaded'): only ask for the read.
      if (prev && prev.status === 'uploaded' && prev.sha256 === sha && prev.documentId && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
        const problem = await readStep(prev.documentId);
        if (problem) { record(f, problem.permanent ? 'rejected' : 'failed', { sha256: sha, documentId: prev.documentId, note: problem.note }); continue; }
        record(f, 'done', { sha256: sha, documentId: prev.documentId });
        shaToDoc.set(sha, { path: f.rel, documentId: prev.documentId });
        continue;
      }
      prepared.push({ f, sha });
    }
    if (!prepared.length) return;

    // 2. ask for presigned uploads (the same request the browser sends)
    let r;
    try {
      r = await client.api('POST', '/api/upload-url', { files: prepared.map(({ f, sha }) => ({ filename: f.rel, sha256: sha, contentType: f.contentType, sizeBytes: f.size })) });
    } catch (err) {
      if (err instanceof StopRun) throw err;
      ctx.batchFailures++;
      for (const { f, sha } of prepared) record(f, 'failed', { sha256: sha, note: err.message });
      if (ctx.batchFailures >= 3) throw new StopRun('busy', 'The server has been too busy or unreachable for too long (three groups of files in a row failed after many tries). Nothing is lost. Try again later; the tool carries on where it stopped.');
      return;
    }
    if (r.status === 402) throw stopFor402(r, redact);
    if (!r.ok || !Array.isArray(r.json?.results)) {
      const note = `the server rejected the request (${r.status}): ${r.json?.error ?? r.text}`;
      for (const { f, sha } of prepared) record(f, r.status >= 400 && r.status < 500 ? 'rejected' : 'failed', { sha256: sha, note });
      return;
    }
    ctx.batchFailures = 0;

    // 3. upload each file, then ask for it to be read
    for (let i = 0; i < prepared.length; i++) {
      if (ctx.stopping) throw new StopRun('stopping', 'stopping');
      const { f, sha } = prepared[i];
      const item = r.json.results[i] ?? {};
      if (item.status === 402) throw stopFor402({ json: item }, redact);
      if (item.error || item.status >= 400) {
        record(f, item.status === 400 || item.status === 413 ? 'rejected' : 'failed', { sha256: sha, note: item.error ?? `server status ${item.status}` });
        continue;
      }
      if (!item.documentId) { record(f, 'failed', { sha256: sha, note: 'the server did not return a document id' }); continue; }
      if (item.alreadyUploaded) {
        record(f, 'present', { sha256: sha, documentId: item.documentId });
        shaToDoc.set(sha, { path: f.rel, documentId: item.documentId });
        continue;
      }
      if (!item.uploadUrl) { record(f, 'failed', { sha256: sha, note: 'the server did not return an upload link' }); continue; }
      const put = await putStep(f, sha, item.uploadUrl);
      if (!put.ok) { record(f, 'failed', { sha256: sha, documentId: item.documentId, note: put.note }); continue; }
      record(f, 'uploaded', { sha256: sha, documentId: item.documentId });
      let problem;
      try { problem = await readStep(item.documentId); } catch (err) {
        if (err instanceof StopRun) throw err;
        problem = { permanent: false, note: `uploaded, but reading could not be requested (${err.message}); run the tool again and it will only ask for the read` };
      }
      if (problem) {
        // keep 'uploaded' as the resume point: the next run asks for the read and does not upload again
        const keep = { ...state.get(f.rel), status: problem.permanent ? 'rejected' : 'uploaded', note: redact(problem.note).slice(0, 300), at: new Date().toISOString() };
        writer.append(keep);
        state.set(f.rel, keep);
        ctx.finished++;
        problem.permanent ? C.rejected++ : C.failed++;
        ctx.readFailed.set(f.rel, problem.note);
        continue;
      }
      record(f, 'done', { sha256: sha, documentId: item.documentId });
      shaToDoc.set(sha, { path: f.rel, documentId: item.documentId });
    }
  }

  const GROUP = 20;
  const groups = [];
  for (let i = 0; i < pendingFiles.length; i += GROUP) groups.push(pendingFiles.slice(i, i + GROUP));
  let next = 0;
  const worker = async () => {
    while (!ctx.stopping && !ctx.stopReason) {
      const i = next++;
      if (i >= groups.length) return;
      try { await processGroup(groups[i]); } catch (err) {
        if (err instanceof StopRun) { if (err.code !== 'stopping' && err.code !== 'aborted' && !ctx.stopReason) ctx.stopReason = { code: err.code, message: err.message }; return; }
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ctx.opts.concurrency, groups.length || 1) }, worker));
  // identical copies that were waiting on their twin
  for (const { f, sha } of deferred) {
    const twin = shaToDoc.get(sha);
    if (twin) record(f, 'same-content', { sha256: sha, documentId: twin.documentId, note: `identical to ${twin.path}` });
  }
}

// ------------------------------------------------------------------------------------------------ reporting

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let a file name act as a spreadsheet formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildReport(ctx, scan, stateMap, sessionFileSet) {
  const C = ctx.counters;
  const skippedByReason = new Map();
  for (const s of scan.skipped) skippedByReason.set(s.reason, (skippedByReason.get(s.reason) ?? 0) + 1);
  const found = scan.files.length + scan.skipped.length;

  // classify every supported file by its final checkpoint status
  let uploadedNow = 0, uploadedEarlier = 0, presentNow = 0, presentEarlier = 0, sameNow = 0, sameEarlier = 0, failed = 0, notAttempted = 0;
  const failures = [];
  for (const f of scan.files) {
    const rec = stateMap.get(f.rel);
    const current = rec && rec.size === f.size && rec.mtimeMs === f.mtimeMs;
    const thisRun = sessionFileSet.has(f.rel);
    if (rec && current && (rec.status === 'done' || rec.status === 'present' || rec.status === 'same-content')) {
      if (rec.status === 'done') thisRun ? uploadedNow++ : uploadedEarlier++;
      else if (rec.status === 'present') thisRun ? presentNow++ : presentEarlier++;
      else thisRun ? sameNow++ : sameEarlier++;
    } else if (rec && current && (rec.status === 'failed' || rec.status === 'rejected' || (rec.status === 'uploaded' && ctx.readFailed.has(f.rel)))) {
      failed++;
      failures.push({ f, rec: rec.status === 'uploaded' ? { ...rec, note: ctx.readFailed.get(f.rel) } : rec });
    } else notAttempted++;
  }
  const alreadyPresent = presentNow + presentEarlier + sameNow + sameEarlier;
  const uploaded = uploadedNow + uploadedEarlier;
  const skipped = scan.skipped.length;
  const sum = uploaded + alreadyPresent + skipped + failed + notAttempted;

  const L = [];
  L.push('DEEPWELL STAFF IMPORT - RECONCILIATION REPORT');
  L.push(`Made: ${new Date().toISOString()}   Tool version ${VERSION}   Server: ${ctx.baseUrl}`);
  L.push(`Folder: ${scan.root}`);
  L.push('');
  L.push(`Files found in the folder ........ ${fmtInt(found)}`);
  L.push(`  Uploaded and sent to be read ... ${fmtInt(uploaded)}   (${fmtInt(uploadedNow)} this run, ${fmtInt(uploadedEarlier)} in earlier runs)`);
  L.push(`  Already in DeepWell ............ ${fmtInt(alreadyPresent)}   (${fmtInt(presentNow + presentEarlier)} DeepWell already had them; ${fmtInt(sameNow + sameEarlier)} identical copies of another file in this folder)`);
  L.push(`  Skipped by the tool ............ ${fmtInt(skipped)}`);
  for (const [reason, n] of [...skippedByReason.entries()].sort((a, b) => b[1] - a[1])) L.push(`      ${REASON_TITLES[reason] ?? reason}: ${fmtInt(n)}`);
  L.push(`  Failed (see the errors file) ... ${fmtInt(failed)}`);
  L.push(`  Not attempted yet .............. ${fmtInt(notAttempted)}${ctx.opts.limit ? '   (the --limit test run only takes a sample)' : ''}`);
  L.push(`  Check: ${fmtInt(uploaded)} + ${fmtInt(alreadyPresent)} + ${fmtInt(skipped)} + ${fmtInt(failed)} + ${fmtInt(notAttempted)} = ${fmtInt(sum)}  ${sum === found ? '(matches files found)' : '(DOES NOT MATCH - do not trust this report)'}`);
  L.push('');
  if (ctx.stopReason) { L.push(`STOPPED EARLY: ${ctx.stopReason.message}`); L.push(''); }
  if (failed) {
    const by = new Map();
    for (const { rec } of failures) { const k = String(rec.note ?? 'unknown').replace(/\d+/g, 'N').slice(0, 90); by.set(k, (by.get(k) ?? 0) + 1); }
    L.push('Why files failed (most common first):');
    for (const [k, n] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) L.push(`  ${fmtInt(n)} x ${k}`);
    L.push('Files that failed for a temporary reason are retried automatically the next time you run the tool. Files the server refused (too large, empty, damaged) will not be retried until they change.');
    L.push('');
  }
  L.push(`Data uploaded this run: ${fmtBytes(C.bytes)}. Waited out ${fmtInt(C.throttled)} "slow down" replies and ${fmtInt(C.networkRetries)} network hiccups.`);
  L.push('"Uploaded and sent to be read" means DeepWell has the file and has been told to read it; reading finishes in the background. Check the app\'s Inbox (or run again with --watch-reading) before closing the import.');
  return { text: L.join('\n') + '\n', counts: { found, uploaded, uploadedNow, uploadedEarlier, alreadyPresent, skipped, failed, notAttempted, sum }, failures };
}

function buildErrorsCsv(scan, report) {
  const rows = [['kind', 'path', 'reason', 'what_to_do', 'size_bytes']];
  for (const { f, rec } of report.failures) rows.push(['failed', f.rel, rec.note ?? '', rec.status === 'rejected' ? 'The server refused this file. Fix or replace it, then run the tool again.' : 'Run the tool again; it retries this file.', f.size]);
  for (const s of scan.skipped) rows.push(['skipped', s.rel, REASON_TITLES[s.reason] ?? s.reason, s.note, s.size]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

// ------------------------------------------------------------------------------------------------ watch reading

async function watchReading(ctx, expectedNew, baselineTotal, say) {
  if (baselineTotal == null) { say('Skipping --watch-reading: could not read the account\'s reading counts before the upload started (the key may lack the "read" permission).'); return; }
  say(`Watching reading progress (Ctrl-C to stop watching; reading continues in the background). New documents to be read: ${fmtInt(expectedNew)}.`);
  let lastFinished = -1, lastChange = Date.now();
  while (!ctx.stopping) {
    let r;
    try { r = await ctx.client.api('GET', '/api/v1/intake-status', undefined, { maxAttempts: 3 }); } catch (err) { if (err instanceof StopRun) return; say(`Could not check reading progress right now (${err.message}).`); await sleepInterruptible(ctx, POLL_MS); continue; }
    if (!r.ok || typeof r.json?.total !== 'number') { say(`Reading progress is not available from the server (${r.status}); open the app's Inbox to check.`); return; }
    const finished = Math.max(0, r.json.total - baselineTotal);
    say(`Reading: about ${fmtInt(Math.min(finished, expectedNew))} of ${fmtInt(expectedNew)} documents finished${r.json.openQuestions != null ? ` (${fmtInt(r.json.openQuestions)} questions waiting for a person)` : ''}.`);
    if (finished >= expectedNew) { say('All documents from this run have been read. Failed ones show in the app\'s Inbox.'); return; }
    if (finished !== lastFinished) { lastFinished = finished; lastChange = Date.now(); }
    if (Date.now() - lastChange > 30 * 60_000) { say('No change in 30 minutes. Stopped watching. Check the Inngest dashboard and the app\'s Inbox.'); return; }
    await sleepInterruptible(ctx, POLL_MS);
  }
}
const sleepInterruptible = async (ctx, ms) => { const end = Date.now() + ms; while (Date.now() < end && !ctx.stopping) await sleepRaw(200); };

// ------------------------------------------------------------------------------------------------ main

export async function main(argv = process.argv.slice(2), env = process.env) {
  const out = (s) => process.stdout.write(`${redactText(s, ctx.key)}\n`);
  const errOut = (s) => process.stderr.write(`${redactText(s, ctx.key)}\n`);
  const ctx = { key: null, baseUrl: DEFAULT_BASE_URL, stopping: false, stopReason: null, authFails: 0, batchFailures: 0, finished: 0, opts: null, counters: newCounters(), shaToDoc: new Map(), readFailed: new Map(), abort: new AbortController() };
  ctx.pacer = new Pacer(ctx);
  ctx.client = makeClient(ctx);
  let writer = null;
  try {
    const opts = parseArgs(argv);
    if (opts.help) { process.stdout.write(HELP); return 0; }
    ctx.opts = opts;
    ctx.baseUrl = opts.baseUrl;

    let folderStat;
    try { folderStat = fs.statSync(opts.folder); } catch { throw new UsageError(`The folder "${opts.folder}" does not exist or cannot be opened.`); }
    if (!folderStat.isDirectory()) throw new UsageError(`"${opts.folder}" is not a folder.`);
    const rootReal = fs.realpathSync(opts.folder);
    const statePath = path.resolve(opts.state ?? defaultStatePath(rootReal));
    if (isInside(statePath, rootReal) || isInside(fs.existsSync(path.dirname(statePath)) ? path.join(fs.realpathSync(path.dirname(statePath)), path.basename(statePath)) : statePath, rootReal)) {
      throw new UsageError('The progress file (--state) must not be inside the customer folder. Choose a place outside it.');
    }

    out(`DeepWell staff import ${VERSION}${opts.dryRun ? ' - DRY RUN (nothing is uploaded)' : ''}`);
    out(`Scanning "${rootReal}" ...`);
    const scan = scanFolder(rootReal);
    describeScan(scan).forEach(out);
    const est = estimate(scan.files);
    describeEstimate(est).forEach(out);

    if (opts.dryRun) {
      if (opts.checkKey) {
        ctx.key = (env.DEEPWELL_IMPORT_KEY ?? '').trim() || null;
        if (!ctx.key) ctx.key = await promptHidden('Import key (typing is hidden): ');
        if (!KEY_SHAPE.test(ctx.key)) throw new UsageError('That does not look like an import key (it starts with dw_live_ and is 72 characters long).');
        const r = await ctx.client.request('POST', `${ctx.baseUrl}/api/upload-url`, { body: { files: [] }, auth: true }).catch((e) => ({ status: 0, text: e.message }));
        if (r.status === 400) out('Key check: OK - the key works and uploads are allowed for this company right now.');
        else if (r.status === 401 || r.status === 403) out(`Key check: FAILED - ${authMessage(r)}`);
        else if (r.status === 402) out(`Key check: the key works, but uploads are blocked: ${redactText(r.json?.error ?? '', ctx.key)}`);
        else out(`Key check: unexpected answer (${r.status}). ${r.text ?? ''}`);
      }
      out('Dry run finished. Nothing was uploaded and nothing was changed.');
      return 0;
    }

    ctx.key = (env.DEEPWELL_IMPORT_KEY ?? '').trim() || null;
    if (!ctx.key) ctx.key = await promptHidden('Import key (typing is hidden): ');
    if (!KEY_SHAPE.test(ctx.key)) throw new UsageError('That does not look like an import key (it starts with dw_live_ and is 72 characters long). Create a key in the customer\'s account.');

    // checkpoint: what a previous run already did
    const { map: state, badLines } = loadState(statePath);
    const unchanged = (f) => { const r = state.get(f.rel); return r && r.size === f.size && r.mtimeMs === f.mtimeMs; };
    const isFinal = (r) => r.status === 'done' || r.status === 'present' || r.status === 'same-content' || r.status === 'rejected';
    let pending = scan.files.filter((f) => !(unchanged(f) && isFinal(state.get(f.rel))));
    for (const f of scan.files) { const r = state.get(f.rel); if (r && r.sha256 && (r.status === 'done' || r.status === 'present')) ctx.shaToDoc.set(r.sha256, { path: f.rel, documentId: r.documentId }); }
    const resumed = scan.files.length - pending.length;
    if (opts.limit) pending = pickSample(pending, opts.limit);
    out('');
    out(`Progress file: ${statePath}${badLines ? ` (ignored ${badLines} damaged line(s))` : ''}`);
    out(resumed ? `Resuming: ${fmtInt(resumed)} files were already handled in earlier runs and will not be touched.` : 'Starting fresh.');
    out(`This run will send ${fmtInt(pending.length)} files${opts.limit ? ` (a spread-out sample, because of --limit ${opts.limit})` : ''}. Server: ${ctx.baseUrl}`);
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new UsageError('Not started: add --yes to run without being asked (this terminal cannot ask).');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise((res) => rl.question('Type YES to start: ', res));
      rl.close();
      if (String(answer).trim() !== 'YES') { out('Not started.'); return 2; }
    }

    // baseline for --watch-reading (best effort)
    let baselineTotal = null;
    if (opts.watchReading) {
      const b = await ctx.client.request('GET', `${ctx.baseUrl}/api/v1/intake-status`, { auth: true }).catch(() => null);
      if (b?.ok && typeof b.json?.total === 'number') baselineTotal = b.json.total;
    }

    writer = openState(statePath);
    if (!fs.existsSync(statePath) || fs.statSync(statePath).size === 0) writer.append({ t: 'run', version: VERSION, startedAt: new Date().toISOString(), baseUrl: ctx.baseUrl });
    const sessionSet = new Set(pending.map((f) => f.rel));

    // Ctrl-C: first press stops cleanly after the files in flight; second press quits at once. The progress file stays valid either way.
    let sigCount = 0;
    const onSig = () => {
      sigCount++;
      if (sigCount === 1) { ctx.stopping = true; ctx.stopReason ??= { code: 'user', message: 'Stopped by you (Ctrl-C). Run the same command again to carry on.' }; errOut('\nStopping after the files in progress... (press Ctrl-C again to quit immediately; nothing is lost either way)'); }
      else { ctx.abort.abort(); writer?.close(); process.exit(130); }
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    // live progress
    const t0 = Date.now();
    const total = pending.length;
    const tty = process.stdout.isTTY;
    let lastPrint = 0;
    const line = () => {
      const done = ctx.finished;
      const secs = (Date.now() - t0) / 1000;
      const rate = secs > 1 ? done / (secs / 60) : 0;
      const eta = rate > 0 ? ((total - done) / rate) * 60 : NaN;
      const C = ctx.counters;
      return `Progress: ${fmtInt(done)}/${fmtInt(total)} files | ${rate ? `${fmtInt(rate)}/min` : '...'} | ETA ${fmtDur(eta)} | failed ${fmtInt(C.failed + C.rejected)} | slow-downs ${fmtInt(C.throttled)}`;
    };
    const ticker = setInterval(() => {
      const now = Date.now();
      if (tty) process.stdout.write(`\r${redactText(line(), ctx.key)}   `);
      else if (now - lastPrint > 15_000) { lastPrint = now; out(line()); }
    }, 500);

    try {
      await uploadRun(ctx, scan, state, writer, pending);
    } finally {
      clearInterval(ticker);
      if (tty) process.stdout.write('\n');
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
    }
    if (!ctx.stopReason && !ctx.stopping) out(line());

    const report = buildReport(ctx, scan, state, sessionSet);
    fs.writeFileSync(`${statePath}.report.txt`, redactText(report.text, ctx.key), { mode: 0o600 });
    fs.writeFileSync(`${statePath}.errors.csv`, redactText(buildErrorsCsv(scan, report), ctx.key), { mode: 0o600 });
    out('');
    report.text.trimEnd().split('\n').forEach(out);
    out(`Report: ${statePath}.report.txt`);
    out(`Details of failures and skipped files: ${statePath}.errors.csv`);

    if (opts.watchReading && !ctx.stopReason && !report.counts.failed) {
      await watchReading(ctx, report.counts.uploadedNow, baselineTotal, out);
    } else if (opts.watchReading) {
      out('Not watching reading because the upload did not finish cleanly. Fix that and run again.');
    }

    if (ctx.stopReason) return ctx.stopReason.code === 'user' ? 3 : 3;
    if (report.counts.failed || report.counts.notAttempted && !opts.limit) return 1;
    return 0;
  } catch (err) {
    if (err instanceof UsageError) { errOut(`Cannot start: ${err.message}`); return 2; }
    errOut(`Unexpected problem: ${redactText(err?.stack ?? err?.message ?? String(err), ctx.key)}`);
    return 1;
  } finally {
    writer?.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const code = await main();
  // The stop reason (allowance, auth, daily cap) is the last thing printed so staff see what to do.
  process.exitCode = code;
}
