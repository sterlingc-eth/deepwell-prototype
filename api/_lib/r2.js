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
  if (missing.length) throw new Error(`R2 is not configured: missing ${missing.join(', ')}`);
  return { accountId, accessKeyId, secretAccessKey, bucket, host: `${accountId}.r2.cloudflarestorage.com` };
}

/**
 * @param {'PUT'|'GET'} method
 * @param {string} key      object key, e.g. "tenant-uuid/2026/invoice.pdf"
 * @param {number} expiresIn seconds, max 604800
 * @param {Record<string,string>} extraQuery
 */
export function presign(method, key, expiresIn = 900, extraQuery = {}, now = new Date()) {
  const { accessKeyId, secretAccessKey, bucket, host } = config();

  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const canonicalUri = '/' + uriEncode(bucket, false) + '/' + uriEncode(key, false);

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(expiresIn, 604800)),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  };
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery,
    `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
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

/** Fetch an object's bytes. Used by extraction, which runs server-side. */
export async function getObject(key) {
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
    throw new Error(`R2 GET ${key} failed: ${r.status}`);
  }
  return Buffer.from(await r.arrayBuffer());
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
