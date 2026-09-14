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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`R2 GET ${key} failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Object keys are tenant-prefixed. This is defence in depth, not the isolation
 * boundary — Postgres RLS is that — but it means a key leaked from one tenant
 * cannot be guessed into another, and it makes per-tenant lifecycle rules and
 * cost attribution possible later.
 */
export function objectKey(tenantId, sha256, filename) {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return `${tenantId}/${sha256.slice(0, 2)}/${sha256}-${safe}`;
}
