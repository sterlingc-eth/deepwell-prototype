/**
 * Dropbox adapter (OAuth code flow, offline refresh token). Linked folder identity is the lower-cased PATH, because Dropbox's
 * deleted entries carry a path but no id; a rename therefore shows up as "removed" + a same-content file, and the provider
 * content_hash pre-check turns the new name into a duplicate without a download.
 * secrets = { accessToken, refreshToken, expiresAt }.  cursor = { cursor: '<list_folder cursor>' }.
 * Scopes: files.metadata.read, files.content.read.  Env var names: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REDIRECT_URI.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthLostError, httpJson, formBody, mimeFromName } from "../contract.js";

const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";
const post = (conn, url, body, opts) => httpJson(conn, url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, opts);

export function toItem(e) {
  if (e[".tag"] === "deleted") return { ref: e.path_lower, name: e.name ?? "", removed: true, changeMarker: "removed" };
  if (e[".tag"] === "folder") return { ref: e.path_lower, name: e.name, isFolder: true, changeMarker: "folder" };
  return {
    ref: e.path_lower, name: e.name, pathHint: e.path_display, mime: mimeFromName(e.name), size: e.size, modifiedAt: e.server_modified ?? null,
    providerHash: e.content_hash ?? null, providerHashKind: e.content_hash ? "dropbox_content_hash" : null, changeMarker: `rev:${e.rev}`,
  };
}

export function createDropboxAdapter() {
  const tokenCall = async (conn, params) => {
    const env = conn.env ?? process.env, f = conn.fetchImpl ?? ((...a) => fetch(...a));
    const r = await f(`${API}/oauth2/token`, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`).toString("base64")}` },
      body: formBody(params),
    });
    if (r.status === 400 || r.status === 401) throw new AuthLostError();
    if (!r.ok) throw new Error(`dropbox token http ${r.status}`);
    return r.json();
  };
  return {
    descriptor: { id: "dropbox", label: "Dropbox", authKind: "oauth", folderIdentity: "path", pushKind: "webhook", maxFileBytes: 100 * 1024 * 1024 },
    beginLink: ({ state, env }) => ({ url: `https://www.dropbox.com/oauth2/authorize?${formBody({ client_id: env.DROPBOX_APP_KEY, response_type: "code", token_access_type: "offline", redirect_uri: env.DROPBOX_REDIRECT_URI, state, scope: "files.metadata.read files.content.read" })}` }),
    async completeLink(ctx, { code }) {
      const t = await tokenCall({ env: ctx.env, fetchImpl: ctx.fetchImpl }, { code, grant_type: "authorization_code", redirect_uri: ctx.env.DROPBOX_REDIRECT_URI });
      return { accountRef: t.account_id, secrets: { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 14400) * 1000 } };
    },
    async listFolders(conn, parentRef) {
      const r = await post(conn, `${API}/2/files/list_folder`, { path: parentRef || "", recursive: false, limit: 200 });
      return (r.entries ?? []).filter((e) => e[".tag"] === "folder").map((e) => ({ ref: e.path_lower, name: e.name, hasChildren: true }));
    },
    async listChanges(conn, folder, cursor) {
      const r = cursor?.cursor
        ? await post(conn, `${API}/2/files/list_folder/continue`, { cursor: cursor.cursor })
        : await post(conn, `${API}/2/files/list_folder`, { path: folder.ref, recursive: true, include_deleted: true, limit: 500 });
      return { items: (r.entries ?? []).map(toItem), nextCursor: { cursor: r.cursor }, hasMore: !!r.has_more };
    },
    download: (conn, item, maxBytes) => httpJson(conn, `${CONTENT}/2/files/download`, { method: "POST", headers: { "Dropbox-API-Arg": JSON.stringify({ path: item.ref }) } }, { kind: "bytes", maxBytes }),
    async refreshSecrets(conn) {
      const t = await tokenCall(conn, { grant_type: "refresh_token", refresh_token: conn.secrets.refreshToken });
      return { secrets: { ...conn.secrets, accessToken: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 14400) * 1000 } };
    },
    async revoke(conn) { try { await post(conn, `${API}/2/auth/token/revoke`, null); } catch { /* best effort */ } },
    /** Webhook wake-up. Dropbox signs the raw body with HMAC-SHA256 (app secret) in X-Dropbox-Signature. */
    verifyPush(req, env = process.env) {
      const sig = String(req.headers?.["x-dropbox-signature"] ?? "");
      const want = createHmac("sha256", String(env.DROPBOX_APP_SECRET ?? "")).update(req.rawBody ?? "").digest("hex");
      return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    },
    parsePush(req) { try { return JSON.parse(req.rawBody ?? "{}").list_folder?.accounts ?? []; } catch { return []; } },
  };
}
