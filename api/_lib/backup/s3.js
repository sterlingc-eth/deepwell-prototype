/**
 * Backup storage: any S3-compatible bucket (Cloudflare R2 preferred), in a SEPARATE account from production.
 *
 *   BACKUP_S3_ENDPOINT           https://<account id>.r2.cloudflarestorage.com   (for AWS S3: https://s3.<region>.amazonaws.com)
 *   BACKUP_S3_BUCKET             bucket name
 *   BACKUP_S3_ACCESS_KEY_ID      object read/write key for THAT bucket only
 *   BACKUP_S3_SECRET_ACCESS_KEY
 *   BACKUP_S3_REGION             optional, default "auto" (R2). AWS S3 needs the real region.
 *
 * Same dependency-free SigV4 presigning approach as api/_lib/r2.js (verified there against the AWS test vector), generalised to
 * another endpoint, credentials and the list call. Every method has the same shape as the in-memory storage the tests use:
 *   put(key, Buffer) / get(key) -> Buffer|null / head(key) -> {size}|null / del(key) / list(prefix, {delimiter}) -> {keys, prefixes}
 */
import crypto from 'node:crypto';

const sha256Hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of Buffer.from(str, 'utf8').toString('binary')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function storageConfigFromEnv(env = process.env) {
  const cfg = {
    endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    region: env.BACKUP_S3_REGION || 'auto',
  };
  const missing = [['BACKUP_S3_ENDPOINT', cfg.endpoint], ['BACKUP_S3_BUCKET', cfg.bucket], ['BACKUP_S3_ACCESS_KEY_ID', cfg.accessKeyId], ['BACKUP_S3_SECRET_ACCESS_KEY', cfg.secretAccessKey]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw Object.assign(new Error(`Backup storage is not configured: missing ${missing.join(', ')}`), { isConfig: true });
  // The backup bucket must not be the production bucket: one account problem must not take out both.
  if (env.R2_BUCKET_NAME && env.R2_ACCOUNT_ID && cfg.bucket === env.R2_BUCKET_NAME && String(cfg.endpoint).includes(env.R2_ACCOUNT_ID)) {
    throw Object.assign(new Error('BACKUP_S3_* points at the production bucket; use a separate account and bucket'), { isConfig: true });
  }
  return cfg;
}

/** Presigned URL (query-string SigV4, path-style). `query` carries list parameters. */
export function presignUrl(cfg, method, key, { expiresIn = 300, query = {}, now = new Date() } = {}) {
  const u = new URL(cfg.endpoint);
  const host = u.host;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const canonicalUri = '/' + uriEncode(cfg.bucket, false) + (key ? '/' + uriEncode(key, false) : '');
  const q = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`, 'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn), 'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${uriEncode(k)}=${uriEncode(String(q[k]))}`).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + cfg.secretAccessKey, dateStamp);
  const sig = crypto.createHmac('sha256', hmac(hmac(hmac(kDate, cfg.region), 's3'), 'aws4_request')).update(toSign).digest('hex');
  return `${u.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

class StorageError extends Error {
  constructor(message, status) { super(message); this.name = 'BackupStorageError'; this.status = status; }
}

export function createS3Storage(cfg = storageConfigFromEnv(), { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const call = (method, key, opts = {}) => fetchImpl(presignUrl(cfg, method, key, opts), { method, body: opts.body, signal: AbortSignal.timeout(timeoutMs) });
  return {
    async put(key, body) {
      const r = await call('PUT', key, { body });
      await r.body?.cancel?.().catch(() => {});
      if (!r.ok) throw new StorageError(`backup PUT failed: ${r.status}`, r.status);
    },
    async get(key) {
      const r = await call('GET', key);
      if (r.status === 404) { await r.body?.cancel?.().catch(() => {}); return null; }
      if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new StorageError(`backup GET failed: ${r.status}`, r.status); }
      return Buffer.from(await r.arrayBuffer());
    },
    async head(key) {
      const r = await call('HEAD', key);
      await r.body?.cancel?.().catch(() => {});
      if (r.status === 404) return null;
      if (!r.ok) throw new StorageError(`backup HEAD failed: ${r.status}`, r.status);
      return { size: Number(r.headers.get('content-length') ?? 0) };
    },
    async del(key) {
      const r = await call('DELETE', key);
      await r.body?.cancel?.().catch(() => {});
      if (!r.ok && r.status !== 404) throw new StorageError(`backup DELETE failed: ${r.status}`, r.status);
    },
    /** All keys under a prefix (pages through ListObjectsV2). With `delimiter`, also the "folders" directly below it. */
    async list(prefix, { delimiter = null } = {}) {
      const keys = []; const prefixes = [];
      let token = null;
      for (;;) {
        const query = { 'list-type': '2', prefix, ...(delimiter ? { delimiter } : {}), ...(token ? { 'continuation-token': token } : {}) };
        const r = await call('GET', '', { query });
        if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new StorageError(`backup LIST failed: ${r.status}`, r.status); }
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]));
        for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) prefixes.push(decodeXml(m[1]));
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
        if (/<IsTruncated>true<\/IsTruncated>/.test(xml) && next) token = decodeXml(next[1]); else break;
      }
      return { keys, prefixes };
    },
  };
}
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** In-memory storage with the same surface (tests, and the restore script's dry runs). */
export function createMemoryStorage() {
  const m = new Map();
  const s = {
    map: m, puts: 0, gets: 0, failPut: null,
    async put(key, body) { if (s.failPut && s.failPut(key)) throw new StorageError('simulated storage failure', 503); s.puts++; m.set(key, Buffer.from(body)); },
    async get(key) { s.gets++; return m.has(key) ? Buffer.from(m.get(key)) : null; },
    async head(key) { return m.has(key) ? { size: m.get(key).length } : null; },
    async del(key) { m.delete(key); },
    async list(prefix, { delimiter = null } = {}) {
      const keys = []; const prefixes = new Set();
      for (const k of [...m.keys()].sort()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const i = delimiter ? rest.indexOf(delimiter) : -1;
        if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1)); else keys.push(k);
      }
      return { keys, prefixes: [...prefixes] };
    },
  };
  return s;
}
