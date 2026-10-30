/**
 * The provider interface. One adapter per provider, plain functions, no classes; adapters never touch the database.
 *
 *   descriptor      { id, label, authKind:'oauth'|'inbound', folderIdentity:'id'|'path', pushKind:'none'|'webhook'|'subscription', maxFileBytes }
 *   beginLink(ctx)                         -> { url }                                  ctx: { state, env }
 *   completeLink(ctx, params)              -> { accountRef, secrets }                  secrets: plain object, core encrypts it
 *   listFolders(conn, parentRef?)          -> [{ ref, name, hasChildren }]
 *   listChanges(conn, folder, cursor|null) -> { items:[Item], nextCursor, hasMore }   (cursor null = first full listing)
 *        Item = { ref, name, mime, size, modifiedAt, providerHash?, providerHashKind?, changeMarker, removed?, isFolder?, exportAs? }
 *   download(conn, item, maxBytes)         -> Buffer
 *   refreshSecrets(conn)                   -> { secrets }                              returns the FULL new secret set (rotating tokens)
 *   revoke(conn)                           -> void                                     best effort
 *   verifyPush(req, env) / parsePush(req)  -> boolean / [accountRef]                   optional wake-up only
 *
 * conn = { tenantId, accountRef, secrets (decrypted, in memory only), env, fetchImpl }.
 * Errors: throw AuthLostError (token revoked), RateLimitedError (retryAfterMs), TooLargeError; anything else is a transient error.
 */
import { createHash } from "node:crypto";

export class AuthLostError extends Error { constructor(m = "access lost") { super(m); this.name = "AuthLostError"; } }
export class RateLimitedError extends Error { constructor(m = "rate limited", retryAfterMs = 30_000) { super(m); this.name = "RateLimitedError"; this.retryAfterMs = retryAfterMs; } }
export class TooLargeError extends Error { constructor(m = "file is too large") { super(m); this.name = "TooLargeError"; } }

const REQUIRED = ["listFolders", "listChanges", "download", "refreshSecrets", "revoke"];
const DESC_KEYS = ["id", "label", "authKind", "folderIdentity", "pushKind", "maxFileBytes"];

/** Throws a readable error when an adapter does not satisfy the interface. Used by the conformance check and by the registry. */
export function assertAdapter(a) {
  if (!a || typeof a !== "object") throw new Error("adapter missing");
  for (const k of DESC_KEYS) if (a.descriptor?.[k] === undefined) throw new Error(`adapter ${a.descriptor?.id ?? "?"}: descriptor.${k} missing`);
  if (a.descriptor.authKind === "oauth") for (const k of ["beginLink", "completeLink"]) if (typeof a[k] !== "function") throw new Error(`adapter ${a.descriptor.id}: ${k} missing`);
  for (const k of REQUIRED) if (typeof a[k] !== "function") throw new Error(`adapter ${a.descriptor.id}: ${k} missing`);
  if (a.descriptor.pushKind !== "none") for (const k of ["verifyPush", "parsePush"]) if (typeof a[k] !== "function") throw new Error(`adapter ${a.descriptor.id}: ${k} missing`);
  return a;
}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Dropbox content_hash: SHA-256 of the concatenated SHA-256 digests of 4 MiB blocks. A skip-the-download pre-check only. */
export function dropboxContentHash(bytes) {
  const BLOCK = 4 * 1024 * 1024;
  const outer = createHash("sha256");
  for (let i = 0; i < bytes.length; i += BLOCK) outer.update(createHash("sha256").update(bytes.subarray(i, i + BLOCK)).digest());
  return outer.digest("hex");
}

/** Authenticated fetch with Retry-After handling. Adapters use this; tests inject fetchImpl. */
export async function httpJson(conn, url, init = {}, { attempts = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), kind = "json", maxBytes } = {}) {
  const f = conn.fetchImpl ?? ((...a) => fetch(...a));
  for (let i = 0; ; i++) {
    const r = await f(url, { ...init, headers: { ...(init.headers ?? {}), ...(conn.secrets?.accessToken ? { Authorization: `Bearer ${conn.secrets.accessToken}` } : {}) }, signal: AbortSignal.timeout(25_000) });
    if (r.status === 401) throw new AuthLostError();
    if (r.status === 429 || r.status === 503) {
      const ra = Number(r.headers?.get?.("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : Math.min(1000 * 2 ** i, 30_000);
      if (i + 1 >= attempts) throw new RateLimitedError("rate limited", wait);
      await sleep(wait);
      continue;
    }
    if (!r.ok) { const e = new Error(`provider http ${r.status}`); e.status = r.status; throw e; }
    if (kind === "bytes") {
      const declared = Number(r.headers?.get?.("content-length"));
      if (maxBytes && Number.isFinite(declared) && declared > maxBytes) throw new TooLargeError();
      const buf = Buffer.from(await r.arrayBuffer());
      if (maxBytes && buf.length > maxBytes) throw new TooLargeError();
      return buf;
    }
    return r.status === 204 ? {} : r.json();
  }
}

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic",
  txt: "text/plain", csv: "text/csv", rtf: "application/rtf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", eml: "message/rfc822" };
/** Content type from a file name, for providers that do not report one. Unknown extension -> application/octet-stream (the upload allow-list decides). */
export const mimeFromName = (name) => MIME[String(name ?? "").split(".").pop().toLowerCase()] ?? "application/octet-stream";

export const formBody = (o) => new URLSearchParams(o).toString();
