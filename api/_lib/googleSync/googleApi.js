/**
 * The only file that talks to Google. Everything is injected (fetch, sleep, clock) so the tests run the whole sync against a mock
 * and make NO real Google call. Handles: OAuth URL / code exchange / refresh / revoke, Drive (folders, children, changes,
 * download, export), Gmail (labels, messages, attachments), and rate-limit backoff.
 *
 * Backoff: 429, 5xx and 403 with a rate-limit reason are retried up to MAX_ATTEMPTS with exponential delay plus jitter,
 * honouring Retry-After. A 401 refreshes the access token once and retries. `invalid_grant` (the admin revoked access, or the
 * token lapsed) throws GoogleAuthError so the connection is marked "needs-reconnect" instead of failing every pass.
 */
import { FOLDER_MIME } from "./config.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE = "https://www.googleapis.com/drive/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export const MAX_ATTEMPTS = 5;
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "dailyLimitExceeded", "backendError"]);

export class GoogleError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
    this.reason = reason;
  }
}
/** The refresh token no longer works (revoked, expired, client changed). Never retried. */
export class GoogleAuthError extends GoogleError {
  constructor(message) { super(message, 401, "invalid_grant"); this.name = "GoogleAuthError"; }
}
/** Retries ran out on a rate limit: the sync pass stops cleanly and tries again next time. */
export class GoogleRateLimitError extends GoogleError {
  constructor(message, status) { super(message, status, "rateLimitExceeded"); this.name = "GoogleRateLimitError"; }
}

export function backoffDelayMs(attempt, retryAfterHeader, rand = Math.random) {
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60_000);
  const base = Math.min(500 * 2 ** attempt, 30_000);
  return Math.round(base / 2 + rand() * (base / 2));
}

async function errorInfo(r) {
  let reason = "";
  let message = `${r.status}`;
  try {
    const j = await r.json();
    reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? (typeof j?.error === "string" ? j.error : "");
    message = j?.error?.message ?? j?.error_description ?? (typeof j?.error === "string" ? j.error : message);
  } catch { /* not JSON */ }
  return { reason, message };
}

/**
 * @param {{env?: object, fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, rand?: ()=>number}} deps
 */
export function createGoogleClient({ env = process.env, fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand = Math.random } = {}) {
  const stats = { calls: 0, retries: 0 };

  async function send(url, init, { accessToken, refreshAccess } = {}) {
    let token = accessToken;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      stats.calls++;
      const headers = { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      let r;
      try {
        r = await fetchImpl(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(25_000) });
      } catch (err) {
        if (attempt + 1 >= MAX_ATTEMPTS) throw new GoogleError(`network error: ${err?.message}`, 0, "network");
        stats.retries++;
        await sleep(backoffDelayMs(attempt, null, rand));
        continue;
      }
      if (r.ok) return r;
      if (r.status === 401 && refreshAccess && !refreshed) {
        refreshed = true;
        await r.body?.cancel?.().catch?.(() => {});
        token = await refreshAccess();
        continue;
      }
      const retryAfter = r.headers?.get?.("retry-after");
      const { reason, message } = await errorInfo(r);
      const rateLimited = r.status === 429 || (r.status === 403 && RATE_REASONS.has(reason));
      const transient = r.status >= 500 && r.status <= 599;
      if ((rateLimited || transient) && attempt + 1 < MAX_ATTEMPTS) {
        stats.retries++;
        await sleep(backoffDelayMs(attempt, retryAfter, rand));
        continue;
      }
      if (rateLimited) throw new GoogleRateLimitError(message, r.status);
      if (reason === "invalid_grant" || (r.status === 401 && refreshed)) throw new GoogleAuthError(message);
      throw new GoogleError(message, r.status, reason);
    }
  }

  const cfg = () => ({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  });

  return {
    stats,

    isConfigured() {
      const c = cfg();
      return Boolean(c.clientId && c.clientSecret && c.redirectUri);
    },

    authUrl({ scopes, state, loginHint }) {
      const c = cfg();
      const p = new URLSearchParams({
        client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: scopes.join(" "),
        access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
      });
      if (loginHint) p.set("login_hint", loginHint);
      return `${AUTH_URL}?${p.toString()}`;
    },

    async exchangeCode(code) {
      const c = cfg();
      const r = await send(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code" }).toString(),
      });
      const j = await r.json();
      let email = null;
      try { email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString("utf8")).email ?? null; } catch { /* no id_token */ }
      return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, scope: String(j.scope ?? ""), expiresIn: Number(j.expires_in) || 3600, email };
    },

    /** A fresh access token from a refresh token. Throws GoogleAuthError when Google says the grant is gone. */
    async refreshAccessToken(refreshToken) {
      const c = cfg();
      let r;
      try {
        r = await send(TOKEN_URL, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }).toString(),
        });
      } catch (err) {
        if (err instanceof GoogleError && (err.status === 400 || err.status === 401)) throw new GoogleAuthError(err.message);
        throw err;
      }
      const j = await r.json();
      return j.access_token;
    },

    async revoke(token) {
      try {
        const r = await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
        return r.ok;
      } catch { return false; }
    },

    /** Bind an access token (and the way to refresh it) to the calls below. */
    session(accessToken, refreshAccess) {
      const o = { accessToken, refreshAccess };
      const j = async (url) => (await send(url, { method: "GET" }, o)).json();
      const bytes = async (url, maxBytes) => {
        const r = await send(url, { method: "GET" }, o);
        const declared = Number(r.headers?.get?.("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) { await r.body?.cancel?.().catch?.(() => {}); throw new GoogleError("file is too large", 413, "tooLarge"); }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > maxBytes) throw new GoogleError("file is too large", 413, "tooLarge");
        return buf;
      };
      const FILE_FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,size,trashed,parents,version,shortcutDetails";
      return {
        // ---- Drive
        async startPageToken() { return (await j(`${DRIVE}/changes/startPageToken?supportsAllDrives=false`)).startPageToken; },
        async getFile(id) { return j(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}&supportsAllDrives=false`); },
        async listChildren(folderId, pageToken) {
          const q = encodeURIComponent(`'${String(folderId).replace(/'/g, "\\'")}' in parents and trashed = false`);
          const pt = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
          return j(`${DRIVE}/files?q=${q}&pageSize=100&fields=nextPageToken,files(${FILE_FIELDS})&orderBy=modifiedTime${pt}`);
        },
        async listFolders(parentId) {
          const parent = parentId || "root";
          const q = encodeURIComponent(`'${String(parent).replace(/'/g, "\\'")}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`);
          return j(`${DRIVE}/files?q=${q}&pageSize=100&fields=nextPageToken,files(id,name)&orderBy=name`);
        },
        async listChanges(pageToken) {
          const fields = `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`;
          return j(`${DRIVE}/changes?pageToken=${encodeURIComponent(pageToken)}&pageSize=100&includeRemoved=true&restrictToMyDrive=true&fields=${encodeURIComponent(fields)}`);
        },
        download(id, maxBytes) { return bytes(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`, maxBytes); },
        exportFile(id, mime, maxBytes) { return bytes(`${DRIVE}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`, maxBytes); },
        // ---- Gmail
        async listLabels() { return (await j(`${GMAIL}/labels`)).labels ?? []; },
        async listMessages({ q, labelIds, pageToken }) {
          const p = new URLSearchParams({ maxResults: "100" });
          if (q) p.set("q", q);
          for (const l of labelIds ?? []) p.append("labelIds", l);
          if (pageToken) p.set("pageToken", pageToken);
          return j(`${GMAIL}/messages?${p.toString()}`);
        },
        // format=full carries the part list (names, sizes, attachment ids) and also the body, which this code never reads or keeps.
        getMessage(id) { return j(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`); },
        async getAttachment(messageId, attachmentId, maxBytes) {
          const o2 = await j(`${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
          const buf = Buffer.from(String(o2.data ?? ""), "base64url");
          if (buf.length > maxBytes) throw new GoogleError("file is too large", 413, "tooLarge");
          return buf;
        },
      };
    },
  };
}
