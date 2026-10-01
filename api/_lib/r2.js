/**
 * Minimal SigV4 presigner for Cloudflare R2.
 *
 * R2 speaks the S3 API, so the usual answer is @aws-sdk/client-s3 plus
 * @aws-sdk/s3-request-presigner. That is a lot of dependency to ship into every
 * serverless bundle for one thing: turning an object key into a URL the browser
 * can PUT or GET for a few minutes. This does that and nothing else.
 *
 * The signing below is verified against the official AWS SigV4 test suite
 * vector (get-vanilla) in scripts/verify-sigv4.mjs — run it if you touch this.
 *
 * Why presigned URLs at all: the file bytes go browser -> R2 directly, never
 * through a Vercel function. A 30 MB scanned PDF would blow the 4.5 MB request
 * body limit, and paying to stream every upload through compute is money spent
 * to make uploads slower.
 */
import crypto from 'node:crypto';

const SERVICE = 's3';
const REGION = 'auto'; // R2 ignores region but SigV4 requires one in the scope

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding. encodeURIComponent leaves !'()* alone; SigV4 does not. */
function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of Buffer.from(str, 'utf8').toString('binary')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const missing = Object.entries({ R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET_NAME: bucket })
    .filter(([, v]) => !v).map(([k]) => k);
  // isConfig: telemetry reports a server-config error once per cold start (kind=config), not once per request.
  if (missing.length) throw Object.assign(new Error(`R2 is not configured: missing ${missing.join(', ')}`), { isConfig: true });
  return { accountId, accessKeyId, secretAccessKey, bucket, host: `${accountId}.r2.cloudflarestorage.com` };
}

/**
 * @param {'PUT'|'GET'} method
 * @param {string} key      object key, e.g. "tenant-uuid/2026/invoice.pdf"
 * @param {number} expiresIn seconds, max 604800
 * @param {Record<string,string>} extraQuery
 * @param {Date} [now]
 * @param {{contentLength?: number|null}} [opts]  R30 M5: for a PUT, sign the exact Content-Length the client
 *   declared, so R2 refuses any body of a different size (an unsigned presigned PUT accepts up to 5 GB whatever
 *   the client said it would send). The browser's fetch() sets Content-Length itself from the Blob/File, so a
 *   client that sends what it declared needs no change.
 */
export function presign(method, key, expiresIn = 900, extraQuery = {}, now = new Date(), opts = {}) {
  const { accessKeyId, secretAccessKey, bucket, host } = config();

  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const canonicalUri = '/' + uriEncode(bucket, false) + '/' + uriEncode(key, false);

  const signLength = method === 'PUT' && Number.isInteger(opts?.contentLength) && opts.contentLength > 0;
  const signedHeaders = signLength ? 'content-length;host' : 'host';
  const canonicalHeaders = signLength ? `content-length:${opts.contentLength}\nhost:${host}\n` : `host:${host}\n`;

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(expiresIn, 604800)),
    'X-Amz-SignedHeaders': signedHeaders,
    ...extraQuery,
  };
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery,
    canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = crypto.createHmac(
    'sha256',
    hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), REGION), SERVICE), 'aws4_request')
  ).update(stringToSign).digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Exported for the test vector only. */
export const __internals = { uriEncode, sha256Hex, hmac };

/**
 * Thrown by getObject() below with a real `.status` attached — a plain Error
 * with the status only embedded in its message (what this used to throw)
 * looks, to both queue.js's fatal() and readDocument.js's isTransientError(),
 * exactly like a transient network blip: neither one parses a status code out
 * of message text. A permanently-missing (404, the object was deleted or the
 * key never existed) or forbidden (403) object then got the full retry
 * treatment before failing — wasted run attempts on something that could
 * never succeed no matter how many times it was retried. A genuine 5xx from
 * R2 itself is the one case that IS worth retrying, and isTransientError's
 * existing `status >= 500` check already covers that once `.status` is real.
 */
export class R2Error extends Error {
  constructor(message, status) {
    super(message);
    this.name = "R2Error";
    this.status = status;
  }
}

/**
 * The most bytes any reader will pull out of R2 into memory (R30 M5). The upload limits are 24 MB for a PDF or
 * photo and 20 MB for text; 25 MiB leaves a little slack. An object bigger than this can only have been PUT past
 * the declared size (or before size signing existed), and reading it whole would be an out-of-memory / cost hole.
 */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * Object keys must sit under the caller's own tenant prefix `<tenantId>/`. Postgres RLS scopes the documents ROW,
 * but the storage_key it holds was, until R30, writable by the client (api/records.ts createDocument), and
 * getObject/presign/deleteObject take a bare key — so a foreign key was a cross-tenant read/delete. Pure.
 * @param {unknown} key
 * @param {unknown} tenantId  the tenant's internal uuid (db.tenantId / documents.tenant_id)
 * @returns {boolean}
 */
export function keyBelongsToTenant(key, tenantId) {
  if (typeof key !== 'string' || typeof tenantId !== 'string' || !tenantId) return false;
  if (!key.startsWith(`${tenantId}/`) || key.length <= tenantId.length + 1) return false;
  const rest = key.slice(tenantId.length + 1);
  // No traversal / empty segments / control characters / backslashes.
  if (rest.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return !/[\\\u0000-\u001f\u007f]/.test(rest);
}

/** Throws R2Error(403) unless the key is under `tenantId`'s prefix. Call before any getObject/presign/deleteObject on a key that came from a row. */
export function assertKeyInTenant(key, tenantId) {
  if (!keyBelongsToTenant(key, tenantId)) {
    throw new R2Error('storage key is not in this tenant', 403);
  }
  return key;
}

/**
 * Fetch an object's bytes. Used by extraction, which runs server-side.
 * @param {string} key
 * @param {{maxBytes?: number}} [opts]  hard cap on the body (default MAX_OBJECT_BYTES). Checked against the
 *   Content-Length header first and again while streaming, so a body with no/lying length header is still cut off.
 */
export async function getObject(key, { maxBytes = MAX_OBJECT_BYTES } = {}) {
  const url = presign('GET', key, 120);
  // A hang here burns the whole function budget and is then hard-killed by the
  // platform, which means no catch block runs and the document is left looking
  // like it is still processing. A timeout turns that into a normal error.
  // 10 seconds, not 20: this runs BEFORE the model call in the same request, and
  // the two together have to fit inside the 60-second platform ceiling with room
  // to spare. See the note on MODEL_TIMEOUT_MS in claude.js. Fetching bytes we
  // already own from object storage should take a second, not ten — if it is
  // slow enough to hit this, the request was not going to finish anyway.
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    // Cancel rather than abandon: an unconsumed body holds its connection open
    // until garbage collection.
    await r.body?.cancel().catch(() => {});
    throw new R2Error(`R2 GET ${key} failed: ${r.status}`, r.status);
  }
  const declared = Number(r.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await r.body?.cancel().catch(() => {});
    throw new R2Error(`R2 object is ${declared} bytes, over the ${maxBytes}-byte read limit`, 413);
  }
  if (!r.body || typeof r.body.getReader !== 'function') {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new R2Error(`R2 object is over the ${maxBytes}-byte read limit`, 413);
    return buf;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new R2Error(`R2 object is over the ${maxBytes}-byte read limit`, 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

/**
 * Delete an object. Used by tenant-delete.js, AFTER the Postgres transaction
 * that removed the rows pointing at it has already committed — see the call
 * site for why that order matters.
 *
 * `presign()` already signs whatever method it's given (the canonical
 * request below is built from the `method` argument, not hardcoded to GET/PUT
 * anywhere in it), so this needed no change to the signer itself — only a
 * caller that asks for DELETE instead of GET.
 *
 * Treats 404 as success: the object is already gone, which is exactly the
 * end state a delete is trying to reach, and R2 returning 404 on a second
 * delete attempt (a retried sweep, an already-cleaned-up object) must not be
 * reported as a failure.
 */
export async function deleteObject(key) {
  const url = presign('DELETE', key, 60);
  const r = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
  await r.body?.cancel().catch(() => {});
  if (!r.ok && r.status !== 404) {
    throw new Error(`R2 DELETE ${key} failed: ${r.status}`);
  }
}

/**
 * Object keys are tenant-prefixed. This is defence in depth, not the isolation
 * boundary — Postgres RLS is that — but it means a key leaked from one tenant
 * cannot be guessed into another, and it makes per-tenant lifecycle rules and
 * cost attribution possible later.
 */
export function objectKey(tenantId, sha256, filename) {
  // The FILENAME IS NOT IN THE KEY, deliberately, and this is a correctness
  // matter rather than tidiness.
  //
  // Documents are deduplicated on (tenant_id, sha256_hash). The same invoice
  // arriving twice under two names — "PO_4471.pdf" and "PO_4471 (1).pdf", which
  // is exactly what happens when a PO comes by email and again in a folder —
  // hits that unique constraint and takes the ON CONFLICT path, which updates
  // storage_key to the newly computed one. With the filename folded in, that
  // new key was DIFFERENT, and because the upload was recognized as a duplicate
  // no bytes were ever written to it. The row then pointed at an object that
  // does not exist, and nothing noticed until something re-read the document
  // months later and got a 404 recorded as a permanent failure.
  //
  // Keyed by content hash alone, the same bytes always resolve to the same key,
  // so a rename cannot orphan a document. The original filename is still kept —
  // on the documents row, where it belongs.
  void filename;
  return `${tenantId}/${sha256.slice(0, 2)}/${sha256}`;
}

/* --------------------------------------------------------------------------------------------- R34 upload hygiene */

/** Pure: "Application/PDF; charset=binary" -> "application/pdf". Anything that is not a type/subtype shape -> null. */
export function normalizeContentType(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : null;
}

const FILENAME_JUNK = /[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/g;
/** The most characters (bytes of a path, really) a stored original filename keeps. Bulk import sends a relative folder path, hence not 100. */
export const MAX_FILENAME_CHARS = 255;

/**
 * Pure: the filename as it is STORED. Removes NUL and other control characters (a NUL is a raw Postgres error - one such name
 * 500s a single presign and aborts a whole 50-file batch), Unicode directional overrides (a name that displays as
 * "invoice_exe.pdf" while really ending ".exe"), and traversal / empty path segments ("../../etc/x.pdf" -> "etc/x.pdf"), then
 * bounds the length keeping the END (name + extension). The name is never used to build the storage key or a filesystem path
 * (objectKey is tenant/hash only); this is about what lands in the database, the Inbox and a Content-Disposition header.
 * @returns {string|null} null when nothing usable is left
 */
export function sanitizeUploadFilename(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.replace(FILENAME_JUNK, '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..');
  let s = parts.join('/');
  if (!s) return null;
  if (s.length > MAX_FILENAME_CHARS) s = s.slice(-MAX_FILENAME_CHARS);
  return s;
}

/**
 * Pure: how long a presigned PUT stays valid. 15 minutes was fixed for every size, so a 24 MB scan on a weak cellular link
 * (~25 KB/s) could never finish before the URL expired: the PUT failed, the offline queue retried from byte zero, and so on
 * forever. Assume a 16 KB/s floor on top of the 15 minutes, capped at one hour. A URL is bound to one key and (when sized) one
 * exact Content-Length, so a longer window widens nothing.
 */
export function uploadExpirySeconds(sizeBytes) {
  const base = 900;
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return base;
  return Math.min(3600, base + Math.ceil(sizeBytes / (16 * 1024)));
}

const SAFE_INLINE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'text/plain', 'text/csv']);
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv' };

/**
 * Pure: how a presigned GET of a stored original is served. R2 serves an object with whatever Content-Type the uploader's PUT
 * carried (client-controlled), so an uploaded HTML or SVG file would open inline as a live page on the storage domain.
 * Instead the response type is forced (`response-content-type`): a known document/photo type is shown inline, anything else is
 * an opaque download. The filename is made header-safe (no quotes, CR/LF, `;`, backslashes, control characters) with an
 * RFC 5987 UTF-8 form for non-ASCII names.
 * @returns {{contentType: string, disposition: string}}
 */
export function originalServing(filename, declaredType) {
  const name = String(filename ?? 'document').split('/').pop() ?? 'document';
  const clean = name.replace(FILENAME_JUNK, '').replace(/["\\;]/g, '_').trim().slice(0, 200) || 'document';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const ext = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  const declared = normalizeContentType(declaredType);
  const type = declared && SAFE_INLINE_TYPES.has(declared) ? declared : (!declared && EXT_TYPES[ext]) || null;
  return {
    contentType: type ?? 'application/octet-stream',
    disposition: `${type ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`,
  };
}
