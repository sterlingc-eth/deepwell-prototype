/**
 * Google Drive adapter. Wraps the existing client (googleSync/googleApi.js), so it speaks to Google exactly the way the shipped sync does.
 * Needs the drive.readonly scope ("full" mode): with drive.file Google shows the app only the files an admin picked, never a folder's
 * contents, so a folder link cannot enumerate children there (the existing picker-mode sync keeps handling picked files).
 * secrets = { refreshToken }. A short-lived access token is fetched per call and never stored.
 * cursor  = { phase:'walk', startToken, pending:[{id,pt}] }  ->  { phase:'changes', pageToken }
 */
import { AuthLostError, RateLimitedError, TooLargeError } from "../contract.js";
import { createGoogleClient, GoogleAuthError, GoogleRateLimitError, GoogleError } from "../../googleSync/googleApi.js";
import { EXPORTS, FOLDER_MIME, scopesFor } from "../../googleSync/config.js";

const SHORTCUT = "application/vnd.google-apps.shortcut";

const wrap = async (fn) => {
  try { return await fn(); } catch (e) {
    if (e instanceof GoogleAuthError) throw new AuthLostError();
    if (e instanceof GoogleRateLimitError) throw new RateLimitedError("rate limited", 30_000);
    if (e instanceof GoogleError && e.reason === "tooLarge") throw new TooLargeError();
    throw e;
  }
};

export function toItem(meta) {
  const exp = EXPORTS[meta.mimeType];
  const base = String(meta.name ?? "").trim() || "Untitled";
  return {
    ref: meta.id, name: exp && !base.toLowerCase().endsWith(`.${exp[1]}`) ? `${base}.${exp[1]}` : base,
    mime: exp ? exp[0] : meta.mimeType, size: Number(meta.size) || undefined, modifiedAt: meta.modifiedTime ?? null,
    providerHash: meta.md5Checksum ?? null, providerHashKind: meta.md5Checksum ? "gdrive_md5" : null,
    changeMarker: meta.md5Checksum ? `md5:${meta.md5Checksum}` : `mod:${meta.modifiedTime ?? ""}:${meta.version ?? ""}`,
    isFolder: meta.mimeType === FOLDER_MIME || meta.mimeType === SHORTCUT, exportAs: exp ? exp[0] : undefined,
    removed: !!meta.trashed,
  };
}

export function createGdriveAdapter({ clientFactory = (conn) => createGoogleClient({ env: conn.env ?? process.env, fetchImpl: conn.fetchImpl ?? ((...a) => fetch(...a)) }) } = {}) {
  const open = async (conn) => {
    const client = clientFactory(conn);
    const refresh = () => client.refreshAccessToken(conn.secrets.refreshToken);
    return client.session(await wrap(refresh), refresh);
  };
  return {
    descriptor: { id: "gdrive", label: "Google Drive", authKind: "oauth", folderIdentity: "id", pushKind: "none", maxFileBytes: 100 * 1024 * 1024 },
    beginLink: ({ state, env }) => ({ url: createGoogleClient({ env }).authUrl({ scopes: scopesFor("drive", "full"), state }) }),
    async completeLink({ env, fetchImpl }, { code }) {
      const t = await createGoogleClient({ env, fetchImpl }).exchangeCode(code);
      if (!t.refreshToken) throw new AuthLostError("no refresh token");
      return { accountRef: t.email ?? "google", secrets: { refreshToken: t.refreshToken } };
    },
    async listFolders(conn, parentRef) { const s = await open(conn); return wrap(async () => ((await s.listFolders(parentRef)).files ?? []).map((f) => ({ ref: f.id, name: f.name, hasChildren: true }))); },
    async listChanges(conn, folder, cursor) {
      const s = await open(conn);
      return wrap(async () => {
        if (!cursor || cursor.phase === "walk") {
          const st = cursor ?? { phase: "walk", startToken: await s.startPageToken(), pending: [{ id: folder.ref, pt: null }] };
          const next = st.pending[0];
          if (!next) return { items: [], nextCursor: { phase: "changes", pageToken: st.startToken }, hasMore: false };
          const res = await s.listChildren(next.id, next.pt);
          const files = res.files ?? [];
          const pending = st.pending.slice(1);
          if (res.nextPageToken) pending.unshift({ id: next.id, pt: res.nextPageToken });
          for (const f of files) if (f.mimeType === FOLDER_MIME) pending.push({ id: f.id, pt: null });
          const done = pending.length === 0;
          return { items: files.map(toItem), nextCursor: done ? { phase: "changes", pageToken: st.startToken } : { ...st, pending }, hasMore: !done };
        }
        const res = await s.listChanges(cursor.pageToken);
        const cache = new Map([[folder.ref, true]]);
        const inside = async (meta, depth = 0) => {
          if (depth > 25) return false;
          for (const id of meta.parents ?? []) {
            if (cache.has(id)) { if (cache.get(id)) return true; continue; }
            cache.set(id, false);
            let p; try { p = await s.getFile(id); } catch { continue; }
            const r = await inside(p, depth + 1);
            cache.set(id, r);
            if (r) return true;
          }
          return false;
        };
        const items = [];
        for (const c of res.changes ?? []) {
          if (c.removed || !c.file) { items.push({ ref: c.fileId, removed: true, name: "", changeMarker: "removed" }); continue; }
          if (c.file.mimeType === FOLDER_MIME || c.file.trashed || await inside(c.file)) items.push(toItem(c.file));
        }
        return { items, nextCursor: { phase: "changes", pageToken: res.nextPageToken ?? res.newStartPageToken ?? cursor.pageToken }, hasMore: !!res.nextPageToken };
      });
    },
    async download(conn, item, maxBytes) {
      const s = await open(conn);
      return wrap(() => (item.exportAs ? s.exportFile(item.ref, item.exportAs, maxBytes) : s.download(item.ref, maxBytes)));
    },
    async refreshSecrets(conn) { await open(conn); return { secrets: { refreshToken: conn.secrets.refreshToken } }; },
    async revoke(conn) { try { const c = clientFactory(conn); await c.revoke(conn.secrets.refreshToken); } catch { /* best effort */ } },
  };
}
