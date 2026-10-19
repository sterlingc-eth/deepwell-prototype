/**
 * Backup encryption: AES-256-GCM, one key per company derived from ONE master key.
 *
 *   master key   BACKUP_ENCRYPTION_KEY  (32 random bytes, base64 or 64 hex chars). Lives only in the owner's password
 *                manager and in Vercel's env. Without it a backup is unreadable noise - by design.
 *   company key  HKDF-SHA256(master, salt = "deepwell-backup-v1", info = tenant uuid). A single company's key can be
 *                handed to that company (or used on its own for a single-company restore) without exposing anyone else.
 *   object       "DWB1" | iv(12) | ciphertext | tag(16). The object's own name is bound in as AAD, so an encrypted object
 *                copied under a different name (or into another company's folder) fails to decrypt.
 *
 * Pure node:crypto, no dependencies. Never logs keys.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const MAGIC = Buffer.from('DWB1');
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = Buffer.from('deepwell-backup-v1');

export class BackupCryptoError extends Error {
  constructor(message) { super(message); this.name = 'BackupCryptoError'; }
}

/** Parse the master key from base64 or hex. Throws a config error (no key material in the message). */
export function parseMasterKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw Object.assign(new BackupCryptoError('BACKUP_ENCRYPTION_KEY is not set'), { isConfig: true });
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!buf || buf.length !== 32) {
    throw Object.assign(new BackupCryptoError('BACKUP_ENCRYPTION_KEY must be 32 random bytes (64 hex characters or 44 base64 characters)'), { isConfig: true });
  }
  return buf;
}

/** The company's own 32-byte key. */
export function deriveTenantKey(masterKey, tenantId) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new BackupCryptoError('master key must be 32 bytes');
  if (typeof tenantId !== 'string' || !tenantId) throw new BackupCryptoError('tenant id required');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, SALT, Buffer.from(`tenant:${tenantId}`), 32));
}

/** Key for the few objects that belong to no company (run status). */
export function deriveSystemKey(masterKey) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, SALT, Buffer.from('system'), 32));
}

/** @param {Buffer} key 32 bytes  @param {Buffer|string} plain  @param {string} aad the object's name */
export function encrypt(key, plain, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(aad)));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

export function decrypt(key, blob, aad) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + IV_LEN + TAG_LEN || !blob.subarray(0, 4).equals(MAGIC)) {
    throw new BackupCryptoError('not a DeepWell backup object');
  }
  const iv = blob.subarray(4, 4 + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(blob.subarray(4 + IV_LEN, blob.length - TAG_LEN)), d.final()]);
  } catch {
    throw new BackupCryptoError('could not decrypt: wrong key, wrong object name, or the object was changed');
  }
}

export const gzip = (buf) => zlib.gzipSync(buf, { level: 6 });
export const gunzip = (buf) => zlib.gunzipSync(buf);
export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
