/**
 * Token protection for the Google connections.
 *
 * AES-256-GCM, key from the GOOGLE_TOKEN_KEY environment variable (32 bytes, given as base64 or 64 hex characters). The tenant id
 * is bound in as additional authenticated data, so a ciphertext copied from one organization's row into another's fails to open.
 * The app had no encryption helper of its own (searched api/_lib), so this is the one place that does it.
 *
 * Stored form:  v1.<iv>.<tag>.<ciphertext>   (base64url parts)
 * Also signs the short-lived OAuth "state" value that carries the organization through Google's redirect.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

export class TokenKeyError extends Error {
  constructor(message) { super(message); this.name = "TokenKeyError"; }
}

export function loadKey(env = process.env) {
  const raw = String(env.GOOGLE_TOKEN_KEY ?? "").trim();
  if (!raw) throw new TokenKeyError("GOOGLE_TOKEN_KEY is not set");
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) key = b;
  }
  if (!key) throw new TokenKeyError("GOOGLE_TOKEN_KEY must be 32 bytes (64 hex characters or base64)");
  return key;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function encryptToken(plain, tenantId, env = process.env) {
  if (typeof plain !== "string" || !plain) throw new Error("nothing to encrypt");
  const key = loadKey(env);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(String(tenantId)));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}

export function decryptToken(stored, tenantId, env = process.env) {
  const parts = typeof stored === "string" ? stored.split(".") : [];
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("stored token is not in a known format");
  const key = loadKey(env);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
  d.setAAD(Buffer.from(String(tenantId)));
  d.setAuthTag(Buffer.from(parts[2], "base64url"));
  return Buffer.concat([d.update(Buffer.from(parts[3], "base64url")), d.final()]).toString("utf8");
}

/** Does the string look like something we encrypted (used by tests and by the "never in the clear" check). */
export function looksEncrypted(s) {
  return typeof s === "string" && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
}

function stateKey(env) {
  return createHash("sha256").update("google-sync-state:").update(loadKey(env)).digest();
}

/** Signed OAuth state: payload + HMAC. `ttlMs` default 15 minutes. */
export function signState(payload, env = process.env, now = Date.now(), ttlMs = 15 * 60_000) {
  const body = b64u(JSON.stringify({ ...payload, exp: now + ttlMs, n: b64u(randomBytes(9)) }));
  const sig = b64u(createHmac("sha256", stateKey(env)).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns the payload, or null for anything forged, tampered with or expired. */
export function verifyState(state, env = process.env, now = Date.now()) {
  try {
    const [body, sig] = String(state ?? "").split(".");
    if (!body || !sig) return null;
    const want = createHmac("sha256", stateKey(env)).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
