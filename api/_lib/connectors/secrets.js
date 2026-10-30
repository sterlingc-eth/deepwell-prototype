/**
 * Secret storage for connector tokens: the same AES-256-GCM + tenant-id AAD helper Google sync uses (googleSync/crypto.js).
 * Key env var: CONNECTORS_TOKEN_KEY (32 bytes, base64 or 64 hex); Google links fall back to GOOGLE_TOKEN_KEY so the existing key keeps working.
 * Secrets are a small JSON object, encrypted as one string; they are decrypted only in memory for one pass and never logged.
 */
import { encryptToken, decryptToken } from "../googleSync/crypto.js";

export const keyEnv = (provider, env) => ({ ...env, GOOGLE_TOKEN_KEY: String(env.CONNECTORS_TOKEN_KEY ?? "").trim() || (provider === "gdrive" ? env.GOOGLE_TOKEN_KEY : "") });

export const sealSecrets = (provider, tenantId, secrets, env = process.env) => encryptToken(JSON.stringify(secrets ?? {}), tenantId, keyEnv(provider, env));
export const openSecrets = (provider, tenantId, enc, env = process.env) => JSON.parse(decryptToken(enc, tenantId, keyEnv(provider, env)));
