/**
 * "Download all my files": the whole-account file export for a customer who is leaving.
 *
 * What it builds, for ONE tenant, admin only:
 *   - a set of ZIP "parts" holding every original file, laid out as Customers/<name>/<type>/<file> and
 *     Company Files/<folder>/<file> (Other files/<type>/<file> for anything that is neither);
 *   - one small "index" ZIP with manifest.csv (every file: where it is in the zip, type, customer, date, size, sha256),
 *     the three existing CSV exports (documents, customers, units) and a README;
 *   - a bell notification when it is ready.
 *
 * WHY A BACKGROUND JOB IN PARTS (and not one big zip, nor a browser-side zip):
 *   - A Vercel function lives 60-300 s and a few GB of memory; a shop with thousands of PDFs is tens of GB. One zip built
 *     in one request cannot finish, and a zip streamed through a function costs compute for every byte.
 *   - Browser-side streaming (presign every file, zip in the tab) keeps working only while the admin keeps the tab open
 *     for hours, needs a client zip library in the bundle, and leaves no bell/link to come back to.
 *   - So the job walks the documents in order, cheaply and resumably: each STEP reads one bounded slice of files (<= ~100 MB
 *     / 400 files / 40 s), writes ONE self-contained zip part to R2 and records its progress in a small JSON state object.
 *     A step that dies is simply run again (its part key is deterministic, so a re-run overwrites). Unzipping all parts into
 *     one folder gives the full tree (paths are unique across parts).
 *   - The steps are driven by the Inngest queue when it is configured (queue.js `account-export`), and by the admin's open
 *     page (one /api/account?action=export-files {op:'step'} call after another) when it is not, so it works either way.
 *
 * STORAGE: no new table. Job state and parts live in R2 under `<tenant uuid>/exports/<job id>/`, the same tenant prefix every
 * original uses (r2.js keyBelongsToTenant). Nothing is public: the page asks the server for a fresh 1-hour presigned link
 * per part, the server checks the admin role and the tenant on every such request and writes an audit row for it. The whole
 * export is deleted after EXPORT_TTL_DAYS (the queue sleeps then removes it; a lookup after that date refuses and removes it).
 *
 * Pure helpers first (all unit-tested in scripts/verify-account-export.ts), then the database reads, then the engine.
 */
import crypto from 'node:crypto';
import { presign, getObject as r2Get, deleteObject as r2Delete, keyBelongsToTenant, R2Error } from './r2.js';
import { withTenant } from './recordsStore.js';
import { csvRow } from './integrity.js';
import { documentTypeLabel } from './documentTypes.js';
import {
  COMPANY_FOLDER_FIELD_KEY, EXPIRY_FIELD_KEYS, HR_FOLDER_ID, canSeeHr, canonType, companyFolderInfo, folderLabel,
} from './companyFiles.js';
import { hrGateSql, loadSettings } from './companyFilesStore.js';

/* ------------------------------------------------------------------------------------------------ limits */

/** One zip part: stop adding files at whichever limit is reached first. Sized so a part builds well inside one 60 s step. */
export const CHUNK_MAX_BYTES = 100 * 1024 * 1024;
export const CHUNK_MAX_FILES = 400;
/** A step stops starting new batches after this long (Inngest steps are 60 s; the rest is the zip + upload). */
export const CHUNK_TIME_BUDGET_MS = 40_000;
export const FETCH_CONCURRENCY = 6;
/** A file this big is listed in the manifest as "too large" instead of being read (r2.js MAX_OBJECT_BYTES is 25 MiB; uploads stop at 24). */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const EXPORT_TTL_DAYS = 7;
export const LINK_TTL_SECONDS = 3600;
/** A running job that has not moved for this long is treated as stuck, and a new one may be started. */
export const STALE_AFTER_MS = 30 * 60 * 1000;
export const ASSUMED_FILE_BYTES = 2 * 1024 * 1024; // a file with no recorded size is planned as this big
export const NOTIFY_KIND = 'export';
export const NOTIFY_LINK = '/app/?screen=team';
const MAX_SEGMENT = 80;
const MAX_PATH_NAME = 120;
const JOB_ID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/* ------------------------------------------------------------------------------------------------ pure helpers */

/** A path segment safe on Windows, macOS and Linux unzippers: no separators, control chars or reserved characters. */
export function safeSegment(raw, fallback = 'Unnamed', max = MAX_SEGMENT) {
  let s = String(raw ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}_`;
  return s || fallback;
}

/** A file name: like safeSegment but keeps the extension when it has to shorten a long name. */
export function safeFileName(raw, fallback = 'file') {
  const name = safeSegment(String(raw ?? '').replace(/^.*[\\/]/, ''), fallback, 1000);
  if (name.length <= MAX_PATH_NAME) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return name.slice(0, MAX_PATH_NAME - ext.length).trim() + ext;
}

/**
 * Where a file goes in the zip, as path segments (without the file name).
 *   a company paper      -> Company Files / <folder label>      (People and HR only when canHr)
 *   a customer's paper   -> Customers / <customer> / <type>
 *   anything else        -> Other files / <type>
 * @returns {string[]|null} null = this file must not be exported (an HR paper for a caller without HR access)
 */
export function folderPathFor(entry, { canHr }) {
  const typeLabel = safeSegment(entry.typeLabel || documentTypeLabel(entry.type) || 'Other', 'Other');
  if (entry.companyFolder) {
    if (entry.companyFolder === HR_FOLDER_ID && !canHr) return null;
    return ['Company Files', safeSegment(folderLabel(entry.companyFolder) || entry.companyFolder, 'Company')];
  }
  if (entry.customerName && String(entry.customerName).trim()) {
    return ['Customers', safeSegment(entry.customerName, 'Customer'), typeLabel];
  }
  return ['Other files', typeLabel];
}

/** Short stable fingerprint of a path (case-insensitive: Windows and macOS treat Report.pdf and report.PDF as one file). */
export function pathKey(path) {
  return crypto.createHash('sha1').update(String(path).toLowerCase()).digest('hex').slice(0, 10);
}

/**
 * A zip path that has not been used yet. `used` is a Set of pathKey()s that the CALLER keeps across parts, so two files that
 * share a folder and a name get "name (2).ext" even when they land in different parts. Mutates `used`.
 */
export function uniqueZipPath(segments, fileName, used) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const dir = segments.join('/');
  for (let n = 1; ; n++) {
    const candidate = `${dir}/${n === 1 ? fileName : `${base} (${n})${ext}`}`;
    const k = pathKey(candidate);
    if (!used.has(k)) { used.add(k); return candidate; }
  }
}

/** Known size of an entry for planning (a file with no recorded size is planned at ASSUMED_FILE_BYTES). */
const sizeOf = (e) => (Number.isFinite(Number(e.sizeBytes)) && Number(e.sizeBytes) > 0 ? Number(e.sizeBytes) : ASSUMED_FILE_BYTES);

/**
 * Split an ordered list into the first zip part and the rest: the longest prefix that fits maxBytes and maxFiles. Always takes
 * at least one entry (a file bigger than the whole budget gets a part of its own), so the job always moves forward.
 */
export function planChunk(entries, { maxBytes = CHUNK_MAX_BYTES, maxFiles = CHUNK_MAX_FILES } = {}) {
  const take = [];
  let bytes = 0;
  for (const e of entries) {
    if (take.length >= maxFiles) break;
    const s = sizeOf(e);
    if (take.length && bytes + s > maxBytes) break;
    take.push(e);
    bytes += s;
  }
  return { take, rest: entries.slice(take.length), plannedBytes: bytes };
}

/** How many parts a job of this size will make, at most (an estimate for the screen; never promises more than it knows). */
export function estimateParts(files, bytes, { maxBytes = CHUNK_MAX_BYTES, maxFiles = CHUNK_MAX_FILES } = {}) {
  if (!(files > 0)) return 0;
  return Math.max(Math.ceil(files / maxFiles), Math.ceil(Math.max(0, bytes) / maxBytes), 1);
}

export const MANIFEST_COLUMNS = [
  'path_in_zip', 'part', 'original_filename', 'document_type', 'customer_number', 'customer_name', 'company_folder',
  'document_date', 'uploaded_at', 'size_bytes', 'sha256', 'document_id', 'status',
];

/** One manifest row. status: included | missing (file no longer in storage) | too-large | not-exportable. */
export function manifestRow(entry, { path, part, status }) {
  return [
    path ?? '', part ?? '', entry.filename ?? '', entry.typeLabel ?? entry.type ?? '', entry.customerNumber ?? '', entry.customerName ?? '',
    entry.companyFolder ? (folderLabel(entry.companyFolder) || entry.companyFolder) : '', entry.documentDate ?? '',
    entry.createdAt ? new Date(entry.createdAt).toISOString() : '', entry.sizeBytes ?? '', entry.sha256 ?? '', entry.id ?? '', status,
  ];
}

export function manifestCsv(rows) {
  let out = '﻿' + csvRow(MANIFEST_COLUMNS);
  for (const r of rows) out += csvRow(r);
  return out;
}

export function partFileName(n) {
  return `deepwell-files-part-${String(n).padStart(3, '0')}.zip`;
}
export const INDEX_FILE_NAME = 'deepwell-index-and-spreadsheets.zip';

/** The README that rides in the index zip. Plain words; no internals. */
export function readmeText({ company, files, parts, included, missing, createdAt, expiresAt }) {
  const when = (d) => new Date(d).toISOString().slice(0, 10);
  return [
    `Your files from DeepWell${company ? ` - ${company}` : ''}`,
    `Prepared ${when(createdAt)}. These download links stop working on ${when(expiresAt)}.`,
    '',
    `What is here`,
    `  - ${included} of ${files} files, in ${parts} zip file${parts === 1 ? '' : 's'} named deepwell-files-part-001.zip and so on.`,
    `  - manifest.csv: one line for every file - where it is, what kind of paper it is, the customer, the date, its size.`,
    `  - documents.csv, customers.csv and units.csv: the same spreadsheets you can download from Settings.`,
    '',
    `How to put it together`,
    `  Unzip every part into the SAME folder. You will get:`,
    `    Customers/<customer name>/<kind of paper>/...   papers that belong to a customer`,
    `    Company Files/<folder>/...                      your own company papers (insurance, receipts, vendors, people and HR)`,
    `    Other files/<kind of paper>/...                 anything not tied to a customer or a company folder`,
    '',
    missing > 0
      ? `${missing} file${missing === 1 ? ' is' : 's are'} listed in manifest.csv with the status "missing" or "too-large" because the stored copy could not be included.`
      : `Every file is included.`,
    '',
  ].join('\r\n');
}

/** Job ids are 32 hex characters we mint; anything else from a client is rejected before it can reach a storage key. */
export const isJobId = (v) => typeof v === 'string' && JOB_ID_RE.test(v);
export const newJobId = () => crypto.randomBytes(16).toString('hex');

/** All R2 keys for one job. `tenantId` is the tenant's internal uuid (never taken from a request). */
export function jobKeys(tenantId, jobId) {
  if (!UUID_RE.test(String(tenantId)) || !isJobId(jobId)) throw new Error('bad export key parts');
  const base = `${tenantId}/exports/${jobId}`;
  return {
    state: `${base}/state.json`,
    paths: `${base}/paths.json`,
    index: `${base}/${INDEX_FILE_NAME}`,
    part: (n) => `${base}/${partFileName(n)}`,
    manifest: (n) => `${base}/manifest-${String(n).padStart(3, '0')}.json`,
    latest: `${tenantId}/exports/latest.json`,
  };
}

export const isExpired = (state, now = Date.now()) => !state || !state.expiresAt || now >= new Date(state.expiresAt).getTime();
export const isStale = (state, now = Date.now()) =>
  ['queued', 'running'].includes(state?.status) && now - new Date(state.updatedAt ?? state.createdAt).getTime() > STALE_AFTER_MS;
export const isActive = (state, now = Date.now()) => ['queued', 'running'].includes(state?.status) && !isStale(state, now) && !isExpired(state, now);

/** What the screen may see of a job: never storage keys, tenant ids or user ids. */
export function publicJob(state, now = Date.now()) {
  if (!state) return null;
  const expired = isExpired(state, now);
  const status = expired && state.status === 'done' ? 'expired' : isStale(state, now) ? 'stuck' : state.status;
  return {
    jobId: state.jobId,
    status,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    totalFiles: state.totalFiles,
    totalBytes: state.totalBytes,
    filesDone: state.filesDone,
    includedFiles: state.includedFiles,
    skippedFiles: state.skippedFiles,
    estimatedParts: state.estimatedParts,
    includesHr: !!state.canHr,
    parts: (state.parts ?? []).map((p) => ({ n: p.n, name: p.name, files: p.files, bytes: p.bytes })),
    index: state.indexReady ? { name: INDEX_FILE_NAME } : null,
    error: state.status === 'failed' ? state.error ?? 'Something went wrong while preparing your files.' : null,
  };
}

/** The state machine: what the next step does. */
export function nextAction(state) {
  if (!state || state.status === 'failed' || state.status === 'done') return 'none';
  return state.phase === 'index' ? 'index' : 'files';
}

/** Bell text when the export is ready (the screen shows the same words). Exported for the wording list and the test. */
export function readyNotice({ parts, files, expiresAt }) {
  const days = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
  return {
    title: 'Your files are ready to download',
    body: `${Number(files).toLocaleString('en-US')} files are packed into ${parts} zip file${parts === 1 ? '' : 's'}. Open Team and Settings to download them. They stay available for ${days} days.`,
    link: NOTIFY_LINK,
  };
}

/* ------------------------------------------------------------------------------------------------ storage (R2 JSON + objects) */

/** Real storage. Tests pass their own `deps` (an in-memory bucket) so nothing here needs R2 credentials to be checked. */
export const realStorage = {
  async get(key, opts) { return r2Get(key, opts); },
  async put(key, body, contentType = 'application/octet-stream') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const url = presign('PUT', key, 600, {}, new Date(), { contentLength: buf.length });
    const r = await fetch(url, { method: 'PUT', body: buf, headers: { 'content-type': contentType }, signal: AbortSignal.timeout(50_000) });
    await r.body?.cancel().catch(() => {});
    if (!r.ok) throw new R2Error(`R2 PUT ${key} failed: ${r.status}`, r.status);
  },
  async del(key) { return r2Delete(key); },
  link(key, filename, ttl = LINK_TTL_SECONDS) {
    return presign('GET', key, ttl, {
      'response-content-disposition': `attachment; filename="${filename}"`,
      'response-content-type': 'application/zip',
    });
  },
};

async function readJson(storage, key) {
  try {
    return JSON.parse((await storage.get(key, { maxBytes: 8 * 1024 * 1024 })).toString('utf8'));
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}
const writeJson = (storage, key, obj) => storage.put(key, JSON.stringify(obj), 'application/json');

/* ------------------------------------------------------------------------------------------------ database reads */

/** Tenant uuid for a ctx (the ONLY source of the storage prefix: the verified token's tenant, never a request field). */
export async function tenantIdOf(ctx) {
  return withTenant(ctx, async (db) => db.tenantId);
}

/** Whether this caller may open People and HR (admin and solo tenant: yes). One small read. */
export async function canHrFor(ctx, auth) {
  return withTenant(ctx, async (db) => {
    const { settings } = await loadSettings((sql, p) => db.raw(sql, p));
    return canSeeHr(auth, settings);
  });
}

/** How many original files this export would hold, and their size. HR papers are left out of the count unless canHr. */
export async function countExportable(ctx, { canHr }) {
  return withTenant(ctx, async (db) => {
    const r = await db.raw(
      `SELECT count(*)::int AS files, COALESCE(sum(d.file_size_bytes), 0)::bigint AS bytes
         FROM documents d
        WHERE d.${TENANT} AND d.storage_key IS NOT NULL${canHr ? '' : ` AND ${hrGateSql('d')}`}`,
      []
    );
    const row = r.rows?.[0] ?? {};
    return { files: Number(row.files) || 0, bytes: Number(row.bytes) || 0 };
  });
}

const FIELD_KEYS = ['vendor', 'customer_name', 'service_address', 'job_number', 'job_key', 'work_order_number', 'invoice_number', 'service_date', 'shop_address', ...EXPIRY_FIELD_KEYS, COMPANY_FOLDER_FIELD_KEY];

/**
 * The next page of exportable originals after `after` ({c, id}), oldest first, each with its customer and company folder.
 * Every statement carries the tenant predicate as well as RLS. Papers in People and HR are left out in SQL unless canHr.
 */
export async function fetchEntryPage(ctx, { canHr, after = null, limit = CHUNK_MAX_FILES }) {
  const size = Math.max(1, Math.min(Number(limit) || CHUNK_MAX_FILES, 1000));
  return withTenant(ctx, async (db) => {
    const { settings, companyName } = await loadSettings((sql, p) => db.raw(sql, p));
    const docs = await db.raw(
      `SELECT d.id, d.original_filename, d.document_type, d.content_type, d.file_size_bytes, d.sha256_hash, d.storage_key,
              d.created_at::text AS created_raw, d.created_at,
              EXISTS (SELECT 1 FROM document_entity_links del JOIN entities e ON e.id = del.entity_id AND e.tenant_id = d.tenant_id AND e.merged_into IS NULL
                       AND e.entity_type IN ('customer', 'property', 'equipment')
                      WHERE del.document_id = d.id AND del.tenant_id = d.tenant_id) AS linked_customer
         FROM documents d
        WHERE d.${TENANT} AND d.storage_key IS NOT NULL
          AND ($1::timestamptz IS NULL OR d.created_at > $1::timestamptz OR (d.created_at = $1::timestamptz AND d.id > $2::uuid))
          ${canHr ? '' : `AND ${hrGateSql('d')}`}
        ORDER BY d.created_at, d.id
        LIMIT $3`,
      [after?.c ?? null, after?.id ?? '00000000-0000-0000-0000-000000000000', size]
    );
    const rows = docs.rows ?? [];
    if (!rows.length) return { entries: [], hadRows: 0 };
    const ids = rows.map((r) => r.id);

    const fr = await db.raw(
      `SELECT DISTINCT ON (x.document_id, x.field_key) x.document_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value
         FROM extractions x
        WHERE x.${TENANT} AND x.document_id = ANY($1::uuid[]) AND x.field_key = ANY($2::text[])
        ORDER BY x.document_id, x.field_key, x.confidence DESC NULLS LAST, x.id`,
      [ids, FIELD_KEYS]
    );
    const fields = new Map();
    for (const r of fr.rows ?? []) {
      if (!fields.has(r.document_id)) fields.set(r.document_id, {});
      fields.get(r.document_id)[r.field_key] = r.value;
    }

    // The customer a paper belongs to: directly linked, or through a linked unit (same rules as the documents CSV).
    const cr = await db.raw(
      `WITH cust AS (
         SELECT l.document_id, c.customer_number, c.data->>'customer_name' AS customer_name
           FROM document_entity_links l JOIN entities c ON c.id = l.entity_id
          WHERE c.entity_type = 'customer' AND l.${TENANT} AND l.document_id = ANY($1::uuid[])
          UNION
         SELECT l.document_id, cc.customer_number, cc.data->>'customer_name'
           FROM document_entity_links l
           JOIN entities eq ON eq.id = l.entity_id AND eq.entity_type = 'equipment' AND eq.customer_id IS NOT NULL
           JOIN entities cc ON cc.id = eq.customer_id
          WHERE l.${TENANT} AND l.document_id = ANY($1::uuid[])
       )
       SELECT DISTINCT ON (document_id) document_id, customer_number, customer_name
         FROM cust ORDER BY document_id, customer_number NULLS LAST`,
      [ids]
    );
    const cust = new Map((cr.rows ?? []).map((r) => [r.document_id, r]));

    const opts = { vendorRules: settings.vendorRules, companyNames: companyName ? [companyName] : [] };
    const entries = rows.map((r) => {
      const all = fields.get(r.id) ?? {};
      const override = all[COMPANY_FOLDER_FIELD_KEY] ?? null;
      const f = { ...all };
      delete f[COMPANY_FOLDER_FIELD_KEY];
      const info = companyFolderInfo({ type: r.document_type, fields: f, title: r.original_filename || '', linkedCustomer: !!r.linked_customer, override }, opts);
      const c = cust.get(r.id);
      const type = canonType(r.document_type) || 'other';
      return {
        id: r.id,
        filename: r.original_filename || r.id,
        type,
        typeLabel: documentTypeLabel(type),
        companyFolder: info.folder,
        customerName: c?.customer_name || (!info.folder && f.customer_name ? String(f.customer_name).trim() : null) || null,
        customerNumber: c?.customer_number ?? null,
        documentDate: /^\d{4}-\d{2}-\d{2}/.test(String(f.service_date ?? '')) ? String(f.service_date).slice(0, 10) : '',
        createdAt: r.created_at,
        createdRaw: r.created_raw,
        sizeBytes: r.file_size_bytes != null ? Number(r.file_size_bytes) : null,
        sha256: r.sha256_hash ?? null,
        storageKey: r.storage_key,
      };
    });
    return { entries, hadRows: rows.length, tenantId: db.tenantId };
  });
}

async function audit(ctx, userId, action, changes) {
  // An audit write must never block the customer's own export.
  await withTenant(ctx, (db) => db.logAction({ action, resource_type: 'tenant', clerk_user_id: userId ?? null, changes })).catch((err) => console.error(`audit ${action} failed:`, err?.message));
}

async function notifyReady(ctx, msg) {
  await withTenant(ctx, (db) => db.raw(`INSERT INTO notifications (tenant_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5)`, [db.tenantId, NOTIFY_KIND, msg.title, msg.body, msg.link]))
    .catch((err) => console.error('account export: could not add the bell notification:', err?.message));
}

/* ------------------------------------------------------------------------------------------------ the engine */

/**
 * Admin gate in one place, pure: inside a shop only the admin role; a solo tenant (no org) is its own admin.
 * Throws a 403 error with a customer-safe message.
 */
export function assertAdmin(auth) {
  const isSolo = !auth?.orgId;
  if (!auth || (!isSolo && auth.orgRole !== 'admin')) {
    throw Object.assign(new Error("This action requires the 'admin' role in your company."), { status: 403, expose: true });
  }
}

/** Latest job state for this tenant, or null. */
export async function latestJob(ctx, { storage = realStorage } = {}) {
  const tenantId = await tenantIdOf(ctx);
  const ptr = await readJson(storage, jobKeys(tenantId, '0'.repeat(32)).latest);
  if (!ptr || !isJobId(ptr.jobId)) return null;
  const state = await readJson(storage, jobKeys(tenantId, ptr.jobId).state);
  if (!state || state.tenantId !== tenantId) return null; // a state object from another tenant is never honoured
  return state;
}

async function loadState(ctx, jobId, storage) {
  if (!isJobId(jobId)) throw Object.assign(new Error('That download was not found.'), { status: 404, expose: true });
  const tenantId = await tenantIdOf(ctx);
  const state = await readJson(storage, jobKeys(tenantId, jobId).state);
  if (!state || state.tenantId !== tenantId) throw Object.assign(new Error('That download was not found.'), { status: 404, expose: true });
  return { state, tenantId };
}

async function saveState(storage, tenantId, state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(storage, jobKeys(tenantId, state.jobId).state, state);
}

/**
 * Begin an export. Admin only (assertAdmin by the route AND again here). Returns the job (an already-running one is returned
 * instead of starting a second, so a double click never doubles the work).
 */
export async function startExport(ctx, auth, { storage = realStorage, now = Date.now() } = {}) {
  assertAdmin(auth);
  const tenantId = await tenantIdOf(ctx);
  const existing = await latestJob(ctx, { storage });
  if (existing && isActive(existing, now)) return { state: existing, reused: true };
  if (existing && !isExpired(existing, now) && existing.status === 'done' && now - new Date(existing.createdAt).getTime() < 10 * 60 * 1000) return { state: existing, reused: true };
  if (existing && isExpired(existing, now)) await removeJob(ctx, existing.jobId, { storage }).catch(() => {});

  const canHr = await canHrFor(ctx, auth);
  const totals = await countExportable(ctx, { canHr });
  const jobId = newJobId();
  const created = new Date(now);
  const state = {
    v: 1, jobId, tenantId, createdBy: auth.userId ?? null, canHr,
    status: 'queued', phase: 'files',
    createdAt: created.toISOString(), updatedAt: created.toISOString(),
    expiresAt: new Date(now + EXPORT_TTL_DAYS * 86_400_000).toISOString(),
    totalFiles: totals.files, totalBytes: totals.bytes, estimatedParts: estimateParts(totals.files, totals.bytes),
    cursor: null, filesDone: 0, includedFiles: 0, skippedFiles: 0, parts: [], manifestParts: 0, indexReady: false, company: '',
  };
  await saveState(storage, tenantId, state);
  await writeJson(storage, jobKeys(tenantId, jobId).latest, { jobId });
  await audit(ctx, auth.userId, 'account.files_export.requested', { jobId, files: totals.files, bytes: totals.bytes, includesHr: canHr });
  return { state, reused: false };
}

async function fetchOne(storage, entry, tenantId) {
  if (!keyBelongsToTenant(entry.storageKey, tenantId)) return { status: 'not-exportable' };
  if (entry.sizeBytes != null && entry.sizeBytes > FILE_MAX_BYTES) return { status: 'too-large' };
  try {
    return { status: 'included', body: await storage.get(entry.storageKey, { maxBytes: FILE_MAX_BYTES }) };
  } catch (err) {
    if (err?.status === 404) return { status: 'missing' };
    if (err?.status === 413) return { status: 'too-large' };
    throw err; // a real storage fault: the step is retried, nothing was committed
  }
}

/** One slice of files -> one zip part. Commits (state write) only after the part and its manifest rows are stored. */
async function buildFilesStep(ctx, state, tenantId, { storage, now }) {
  const page = await fetchEntryPage(ctx, { canHr: state.canHr, after: state.cursor, limit: CHUNK_MAX_FILES });
  if (!page.hadRows) {
    state.phase = 'index';
    return state;
  }
  const { take } = planChunk(page.entries);
  const keys = jobKeys(tenantId, state.jobId);
  const used = new Set((await readJson(storage, keys.paths)) ?? []);
  const partNo = state.parts.length + 1;
  const { default: JSZip } = await import('jszip'); // loaded only when an export actually runs
  const zip = new JSZip();
  const rows = [];
  const deadline = Date.now() + CHUNK_TIME_BUDGET_MS;
  let processed = 0;
  let bytes = 0;
  let files = 0;

  for (let i = 0; i < take.length; i += FETCH_CONCURRENCY) {
    if (i > 0 && Date.now() > deadline) break; // out of time for this part: the rest goes in the next one
    const batch = take.slice(i, i + FETCH_CONCURRENCY);
    const got = await Promise.all(batch.map((e) => fetchOne(storage, e, tenantId)));
    batch.forEach((entry, j) => {
      const res = got[j];
      const segs = folderPathFor(entry, { canHr: state.canHr });
      if (!segs) { rows.push(manifestRow(entry, { status: 'not-exportable' })); return; }
      if (res.status !== 'included') { rows.push(manifestRow(entry, { path: '', part: '', status: res.status })); return; }
      const path = uniqueZipPath(segs, safeFileName(entry.filename), used);
      zip.file(path, res.body, { date: entry.createdAt ? new Date(entry.createdAt) : new Date(now), compression: 'STORE', createFolders: false });
      rows.push(manifestRow(entry, { path, part: partFileName(partNo), status: 'included' }));
      bytes += res.body.length;
      files += 1;
    });
    processed += batch.length;
  }

  const last = take[processed - 1];
  if (files > 0) {
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', streamFiles: true });
    await storage.put(keys.part(partNo), buf, 'application/zip');
    state.parts.push({ n: partNo, name: partFileName(partNo), files, bytes: buf.length });
  }
  await writeJson(storage, keys.manifest(state.manifestParts + 1), rows);
  await writeJson(storage, keys.paths, [...used]);
  state.manifestParts += 1;
  state.cursor = { c: last.createdRaw, id: last.id };
  state.filesDone += processed;
  state.includedFiles += files;
  state.skippedFiles += processed - files;
  return state;
}

/** The index zip: README, manifest.csv (all rows) and the three CSV exports. */
async function buildIndexStep(ctx, state, tenantId, { storage }) {
  const keys = jobKeys(tenantId, state.jobId);
  const rows = [];
  for (let n = 1; n <= state.manifestParts; n++) rows.push(...((await readJson(storage, keys.manifest(n))) ?? []));
  // Late import: the CSV loaders live with the existing CSV export route; importing it at module load would pull its whole graph in for every caller.
  const csv = await import('./routes/export-csv.js');
  const sheets = await withTenant(ctx, async (db) => ({
    documents: await csv.loadDocumentsCsv(db, ALL_ROWS),
    customers: await csv.loadCustomersCsv(db, ALL_ROWS),
    units: await csv.loadEquipmentCsv(db, ALL_ROWS),
  }));
  const { companyName } = await withTenant(ctx, (db) => loadSettings((sql, p) => db.raw(sql, p)));
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('README.txt', readmeText({
    company: companyName, files: state.totalFiles, parts: state.parts.length, included: state.includedFiles,
    missing: state.skippedFiles, createdAt: state.createdAt, expiresAt: state.expiresAt,
  }));
  zip.file('manifest.csv', manifestCsv(rows));
  zip.file('documents.csv', sheets.documents);
  zip.file('customers.csv', sheets.customers);
  zip.file('units.csv', sheets.units);
  await storage.put(keys.index, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'application/zip');
  state.indexReady = true;
  state.company = companyName ?? '';
  state.status = 'done';
  state.phase = 'done';
  state.completedAt = new Date().toISOString();
  return state;
}
export const ALL_ROWS = 500_000;

/**
 * Run ONE step of a job (a zip part, or the final index). Safe to call again after a crash or a duplicate delivery.
 * Returns the public job; `justFinished` is true exactly once, on the call that completed it.
 */
export async function runExportStep(ctx, jobId, { storage = realStorage, now = Date.now(), notify = true } = {}) {
  const { state, tenantId } = await loadState(ctx, jobId, storage);
  if (isExpired(state, now)) return { job: publicJob({ ...state, status: 'expired' }, now), justFinished: false };
  const action = nextAction(state);
  if (action === 'none') return { job: publicJob(state, now), justFinished: false };
  if (state.status === 'queued') state.status = 'running';
  // A storage or database fault throws out of here with nothing committed; the caller retries the step (queue) or the page
  // asks again (no queue). After the last retry the queue calls failExport() so the screen stops waiting.
  if (action === 'files') await buildFilesStep(ctx, state, tenantId, { storage, now });
  else await buildIndexStep(ctx, state, tenantId, { storage });
  await saveState(storage, tenantId, state);
  const justFinished = state.status === 'done';
  if (justFinished) {
    await audit(ctx, state.createdBy, 'account.files_export.completed', { jobId, files: state.includedFiles, skipped: state.skippedFiles, parts: state.parts.length });
    if (notify) await notifyReady(ctx, readyNotice({ parts: state.parts.length + 1, files: state.includedFiles, expiresAt: state.expiresAt }));
  }
  return { job: publicJob(state, now), justFinished };
}

/** Mark a job failed (the queue calls this after its last retry) so the screen stops waiting. */
export async function failExport(ctx, jobId, { storage = realStorage } = {}) {
  const { state, tenantId } = await loadState(ctx, jobId, storage);
  if (state.status === 'done') return;
  state.status = 'failed';
  state.error = 'We could not finish preparing your files. Please try again.';
  await saveState(storage, tenantId, state);
}

/** Job for the screen: a given id, or the latest. */
export async function jobStatus(ctx, jobId = null, { storage = realStorage, now = Date.now() } = {}) {
  const state = jobId ? (await loadState(ctx, jobId, storage)).state : await latestJob(ctx, { storage });
  return publicJob(state, now);
}

/**
 * A fresh 1-hour download link for one file of a finished job. Admin only; the tenant comes from the token; the job must be
 * this tenant's, finished and unexpired. `part` is a part number, or 'index'. Writes an audit row for each link issued.
 */
export async function downloadLink(ctx, auth, jobId, part, { storage = realStorage, now = Date.now() } = {}) {
  assertAdmin(auth);
  const { state, tenantId } = await loadState(ctx, jobId, storage);
  if (state.status !== 'done') throw Object.assign(new Error('Your files are not ready yet.'), { status: 409, expose: true });
  if (isExpired(state, now)) {
    await removeJob(ctx, jobId, { storage }).catch(() => {});
    throw Object.assign(new Error('This download has expired. Start a new one.'), { status: 410, expose: true });
  }
  const keys = jobKeys(tenantId, jobId);
  let key;
  let name;
  if (part === 'index') { key = keys.index; name = INDEX_FILE_NAME; }
  else {
    const n = Number(part);
    const p = Number.isInteger(n) ? state.parts.find((x) => x.n === n) : null;
    if (!p) throw Object.assign(new Error('That file was not found.'), { status: 404, expose: true });
    key = keys.part(p.n); name = p.name;
  }
  if (!keyBelongsToTenant(key, tenantId)) throw Object.assign(new Error('That file was not found.'), { status: 404, expose: true });
  const url = storage.link(key, name, LINK_TTL_SECONDS);
  await audit(ctx, auth.userId, 'account.files_export.link', { jobId, file: name });
  return { url, name, expiresInSeconds: LINK_TTL_SECONDS };
}

/** Delete every stored object of a job (after its expiry, or when a new job replaces an expired one). */
export async function removeJob(ctx, jobId, { storage = realStorage } = {}) {
  const { state, tenantId } = await loadState(ctx, jobId, storage);
  const keys = jobKeys(tenantId, jobId);
  const all = [keys.index, keys.paths, ...state.parts.map((p) => keys.part(p.n)), ...Array.from({ length: state.manifestParts }, (_, i) => keys.manifest(i + 1)), keys.state];
  for (const k of all) if (keyBelongsToTenant(k, tenantId)) await storage.del(k).catch(() => {});
  return all.length;
}

/** Remove a job only if it has expired (the queue's last step). */
export async function removeIfExpired(ctx, jobId, opts = {}) {
  const { state } = await loadState(ctx, jobId, opts.storage ?? realStorage);
  return isExpired(state, opts.now ?? Date.now()) ? removeJob(ctx, jobId, opts) : 0;
}
