/**
 * OneDrive / SharePoint adapter (Microsoft Graph, delegated Files.Read + offline_access; SharePoint libraries are drives under sites).
 * Linked folder ref is "<driveId>/<itemId>". Graph delta works from the drive root, so we filter to the linked subtree ourselves with an
 * id -> parent map (parentReference.path is not returned by delta). Refresh tokens ROTATE: refreshSecrets returns the full new set.
 * secrets = { accessToken, refreshToken, expiresAt }.
 * cursor  = { phase:'walk', deltaLink, pending:[{id, next}], folders:[ids] }  ->  { phase:'delta', deltaLink|next, folders:[ids] }
 * Env var names: MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_REDIRECT_URI.
 */
import { AuthLostError, httpJson, formBody, mimeFromName } from "../contract.js";

const G = "https://graph.microsoft.com/v1.0";
const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE = "Files.Read offline_access User.Read";
const SELECT = "id,name,size,file,folder,deleted,parentReference,cTag,eTag,lastModifiedDateTime";
const MAX_FOLDERS = 5000;

export function toItem(d) {
  if (d.deleted) return { ref: d.id, name: d.name ?? "", removed: true, changeMarker: "removed" };
  if (d.folder) return { ref: d.id, name: d.name, isFolder: true, changeMarker: "folder" };
  const h = d.file?.hashes ?? {};
  const kind = h.sha256Hash ? "sha256Hash" : h.sha1Hash ? "sha1Hash" : h.quickXorHash ? "quickXorHash" : null;
  return {
    ref: d.id, driveId: d.parentReference?.driveId, name: d.name, mime: d.file?.mimeType || mimeFromName(d.name), size: d.size, modifiedAt: d.lastModifiedDateTime ?? null,
    providerHash: kind ? h[kind] : null, providerHashKind: kind ? `ms_${kind}` : null, changeMarker: `c:${d.cTag ?? d.eTag ?? d.lastModifiedDateTime}`,
  };
}

export function createOnedriveAdapter() {
  const split = (ref) => { const i = String(ref).indexOf("/"); return { drive: ref.slice(0, i), item: ref.slice(i + 1) }; };
  const tokenCall = async (conn, params) => {
    const env = conn.env ?? process.env, f = conn.fetchImpl ?? ((...a) => fetch(...a));
    const r = await f(`${AUTH}/token`, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ client_id: env.MS_GRAPH_CLIENT_ID, client_secret: env.MS_GRAPH_CLIENT_SECRET, scope: SCOPE, ...params }) });
    if (r.status === 400 || r.status === 401) throw new AuthLostError();
    if (!r.ok) throw new Error(`graph token http ${r.status}`);
    return r.json();
  };
  const secretsFrom = (t, prev = {}) => ({ accessToken: t.access_token, refreshToken: t.refresh_token ?? prev.refreshToken, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 });

  return {
    descriptor: { id: "onedrive", label: "OneDrive / SharePoint", authKind: "oauth", folderIdentity: "id", pushKind: "subscription", maxFileBytes: 100 * 1024 * 1024 },
    beginLink: ({ state, env }) => ({ url: `${AUTH}/authorize?${formBody({ client_id: env.MS_GRAPH_CLIENT_ID, response_type: "code", redirect_uri: env.MS_GRAPH_REDIRECT_URI, response_mode: "query", scope: SCOPE, state })}` }),
    async completeLink(ctx, { code }) {
      const t = await tokenCall({ env: ctx.env, fetchImpl: ctx.fetchImpl }, { code, grant_type: "authorization_code", redirect_uri: ctx.env.MS_GRAPH_REDIRECT_URI });
      const me = await httpJson({ secrets: { accessToken: t.access_token }, fetchImpl: ctx.fetchImpl }, `${G}/me?$select=id`);
      return { accountRef: me.id, secrets: secretsFrom(t) };
    },
    async listFolders(conn, parentRef) {
      const url = parentRef ? `${G}/drives/${split(parentRef).drive}/items/${split(parentRef).item}/children?$select=id,name,folder&$top=200` : `${G}/me/drive/root/children?$select=id,name,folder,parentReference&$top=200`;
      const r = await httpJson(conn, url);
      return (r.value ?? []).filter((d) => d.folder).map((d) => ({ ref: `${d.parentReference?.driveId ?? split(parentRef).drive}/${d.id}`, name: d.name, hasChildren: (d.folder.childCount ?? 1) > 0 }));
    },
    async listChanges(conn, folder, cursor) {
      const { drive, item } = split(folder.ref);
      if (!cursor) {
        // Capture the delta position BEFORE listing so anything edited during the first walk is seen afterwards.
        const start = await httpJson(conn, `${G}/drives/${drive}/root/delta?token=latest`);
        cursor = { phase: "walk", deltaLink: start["@odata.deltaLink"], pending: [{ id: item, next: null }], folders: [item] };
      }
      if (cursor.phase === "walk") {
        const cur = cursor.pending[0];
        if (!cur) return { items: [], nextCursor: { phase: "delta", deltaLink: cursor.deltaLink, folders: cursor.folders }, hasMore: false };
        const r = await httpJson(conn, cur.next ?? `${G}/drives/${drive}/items/${cur.id}/children?$select=${SELECT}&$top=200`);
        const pending = cursor.pending.slice(1), folders = [...cursor.folders];
        if (r["@odata.nextLink"]) pending.unshift({ id: cur.id, next: r["@odata.nextLink"] });
        for (const d of r.value ?? []) if (d.folder) { pending.push({ id: d.id, next: null }); if (folders.length < MAX_FOLDERS) folders.push(d.id); }
        const done = pending.length === 0;
        return { items: (r.value ?? []).map(toItem), nextCursor: done ? { phase: "delta", deltaLink: cursor.deltaLink, folders } : { ...cursor, pending, folders }, hasMore: !done };
      }
      // delta phase
      const r = await httpJson(conn, cursor.deltaLink);
      const known = new Set(cursor.folders);
      const memo = new Map();
      const inside = async (d, depth = 0) => {
        const pid = d.parentReference?.id;
        if (!pid || depth > 25) return false;
        if (known.has(pid)) return true;
        if (memo.has(pid)) return memo.get(pid);
        memo.set(pid, false);
        let p; try { p = await httpJson(conn, `${G}/drives/${drive}/items/${pid}?$select=id,parentReference`); } catch { return false; }
        const res = await inside(p, depth + 1);
        memo.set(pid, res);
        return res;
      };
      const items = [];
      for (const d of r.value ?? []) {
        if (d.deleted) { items.push(toItem(d)); known.delete(d.id); continue; }
        if (d.id === item || !(await inside(d))) continue;
        if (d.folder && known.size < MAX_FOLDERS) known.add(d.id);
        items.push(toItem(d));
      }
      const next = r["@odata.nextLink"] ?? r["@odata.deltaLink"] ?? cursor.deltaLink;
      return { items, nextCursor: { phase: "delta", deltaLink: next, folders: [...known] }, hasMore: !!r["@odata.nextLink"] };
    },
    download: (conn, item, maxBytes) => httpJson(conn, `${G}/drives/${item.driveId}/items/${item.ref}/content`, {}, { kind: "bytes", maxBytes }),
    async refreshSecrets(conn) { const t = await tokenCall(conn, { grant_type: "refresh_token", refresh_token: conn.secrets.refreshToken }); return { secrets: secretsFrom(t, conn.secrets) }; },
    async revoke() { /* Microsoft has no per-app revoke call; the customer removes the app at myapps.microsoft.com. Nothing to do here. */ },
    /** Graph change notification: echo the validation token (handled by the route); the body only names subscriptions, so it is a wake-up. */
    verifyPush(req, env = process.env) { return !!env.MS_GRAPH_CLIENT_STATE && (req.body?.value ?? []).every((n) => n.clientState === env.MS_GRAPH_CLIENT_STATE); },
    parsePush(req) { return [...new Set((req.body?.value ?? []).map((n) => n.subscriptionId).filter(Boolean))]; },
  };
}
