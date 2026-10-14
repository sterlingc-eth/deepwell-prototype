/**
 * HTTP surface for Google sync:  /api/account?action=google-sync   (also reachable as /api/google-sync, see vercel.json)
 *
 *   POST { op: 'status' }                         -> connections, daily room, and whether Google is set up on this deployment
 *   POST { op: 'start', provider, scopeMode }      -> { url }  the Google consent page for the admin to open
 *   GET  ?op=callback&code&state                   -> Google redirects here; stores the encrypted token, then sends the admin back to the app
 *   POST { op: 'choices', provider, ... }          -> save folders/files (Drive) or labels/senders/look-back (Gmail)
 *   POST { op: 'folders', parentId? }              -> Drive folder list for the picker (full access mode only)
 *   POST { op: 'labels' }                          -> Gmail labels for the picker
 *   POST { op: 'picker-token' }                    -> short-lived token + keys for Google's own file picker (narrow mode)
 *   POST { op: 'pause' | 'resume' | 'disconnect' | 'sync-now', provider }
 *
 * Everything except the callback needs a signed-in company admin (a solo account is its own admin). With DEEPWELL_GOOGLE_SYNC off,
 * status answers {enabled:false} and every other operation answers 404; nothing else in this folder is even loaded.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { isGoogleSyncEnabled, scopesFor, limits as limitsFor, PROVIDERS, WORDING } from "./config.js";
import { encryptToken, decryptToken, signState, verifyState, looksEncrypted } from "./crypto.js";
import { createGoogleClient, GoogleAuthError, GoogleError } from "./googleApi.js";
import { normalizeSenders } from "./gmail.js";
import { syncConnection } from "./sync.js";
import * as S from "./store.js";

export const config = { api: { bodyParser: { sizeLimit: "32kb" } }, maxDuration: 300 };

const ID_RE = /^[A-Za-z0-9_\-.]{3,160}$/;
const ok = (body) => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });

const MESSAGES = Object.freeze({
  notAvailable: "Not available.",
  notSetUp: "Connecting Google is not available on this account yet.",
  adminOnly: WORDING.adminOnly,
  badProvider: "Choose Google Drive or Gmail.",
  notConnected: "Connect this source first.",
  connectFailed: "Google did not finish connecting. Please try again.",
  tooMany: "That is more choices than one connection can hold.",
});

const tenantCtx = (auth) => ({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId });
const dbTx = (auth, fn) => withTenant(tenantCtx(auth), fn);

function assertAdmin(auth) { if (hasShop(auth)) requireRole(auth, "admin"); }

async function sessionFor(auth, provider, deps) {
  const env = deps.env ?? process.env;
  const client = deps.google ?? createGoogleClient({ env });
  const { row, tenantId } = await dbTx(auth, async (db) => ({ row: await S.getConnection(db, provider), tenantId: db.tenantId }));
  if (!row || row.status === "disconnected" || !row.refresh_token_enc) return { error: fail(409, MESSAGES.notConnected) };
  const refresh = decryptToken(row.refresh_token_enc, tenantId, env);
  const getAccess = () => client.refreshAccessToken(refresh);
  return { client, row, session: client.session(await getAccess(), getAccess), accessToken: null, getAccess };
}

function cleanPicked(list, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (out.length >= max) break;
    if (!p || typeof p.id !== "string" || !ID_RE.test(p.id) || out.some((o) => o.id === p.id)) continue;
    out.push({ id: p.id, name: String(p.name ?? "").slice(0, 200), kind: p.kind === "folder" ? "folder" : "file" });
  }
  return out;
}

/** The testable core: auth already resolved. Returns { status, body, redirect? }. */
export async function handleOp(auth, body, deps = {}) {
  const env = deps.env ?? process.env;
  const op = typeof body?.op === "string" ? body.op : "";
  if (!isGoogleSyncEnabled(env)) return op === "status" ? ok({ enabled: false }) : fail(404, MESSAGES.notAvailable);
  assertAdmin(auth);
  const lim = limitsFor(env);
  const provider = body?.provider;
  const needProvider = () => (PROVIDERS.includes(provider) ? null : fail(400, MESSAGES.badProvider));

  if (op === "status") {
    const client = deps.google ?? createGoogleClient({ env });
    const data = await dbTx(auth, async (db) => {
      const conns = await S.listConnections(db);
      const out = [];
      for (const c of conns) {
        const counts = await S.itemCounts(db, c.id);
        out.push(S.publicConnection(c, counts, { problems: await S.recentProblems(db, c.id, 3), removed: await S.removedFiles(db, c.id, 10) }));
      }
      return { connections: out, usedToday: await S.importedToday(db) };
    });
    return ok({
      enabled: true,
      configured: client.isConfigured() && Boolean(env.GOOGLE_TOKEN_KEY),
      pickerReady: Boolean(env.GOOGLE_PICKER_API_KEY && env.GOOGLE_CLOUD_PROJECT_NUMBER),
      dailyLimit: lim.maxFilesPerDay,
      usedToday: data.usedToday,
      lookbackChoices: lim.gmailLookbackDays,
      connections: data.connections,
    });
  }

  if (op === "start") {
    const bad = needProvider(); if (bad) return bad;
    const client = deps.google ?? createGoogleClient({ env });
    if (!client.isConfigured() || !env.GOOGLE_TOKEN_KEY) return fail(503, MESSAGES.notSetUp);
    const mode = provider === "gmail" ? "full" : body.scopeMode === "full" ? "full" : "narrow";
    const state = signState({ t: auth.tenantId, tn: auth.orgId ?? auth.tenantId, u: auth.userId, p: provider, m: mode }, env);
    return ok({ url: client.authUrl({ scopes: scopesFor(provider, mode), state, loginHint: auth.email }) });
  }

  if (op === "choices") {
    const bad = needProvider(); if (bad) return bad;
    const conn = await dbTx(auth, (db) => S.getConnection(db, provider));
    if (!conn || conn.status === "disconnected") return fail(409, MESSAGES.notConnected);
    if (provider === "drive") {
      const picked = cleanPicked(body.picked, lim.maxPicked);
      if (Array.isArray(body.picked) && body.picked.length > lim.maxPicked) return fail(400, MESSAGES.tooMany);
      // new choices start the initial import again (files already brought in are recognised and skipped)
      await dbTx(auth, (db) => S.patchConnection(db, conn.id, { config: { ...(conn.config ?? {}), picked }, sync_state: { pageToken: null, startToken: null, initial: {} } }));
    } else {
      const senders = normalizeSenders(body.senders, lim.maxSenders);
      const labels = (Array.isArray(body.labels) ? body.labels : []).filter((l) => l && ID_RE.test(String(l.id))).slice(0, lim.maxLabels).map((l) => ({ id: String(l.id), name: String(l.name ?? "").slice(0, 100) }));
      const lookback = lim.gmailLookbackDays.includes(Number(body.lookbackDays)) ? Number(body.lookbackDays) : 30;
      await dbTx(auth, (db) => S.patchConnection(db, conn.id, {
        config: { labelIds: labels.map((l) => l.id), labelNames: labels.map((l) => l.name), senders, lookbackDays: lookback },
        sync_state: { cursorMs: null },
      }));
    }
    return ok({ saved: true });
  }

  if (op === "folders" || op === "labels" || op === "picker-token") {
    const p = op === "labels" ? "gmail" : "drive";
    const s = await sessionFor(auth, p, deps);
    if (s.error) return s.error;
    try {
      if (op === "labels") {
        const labels = await s.session.listLabels();
        return ok({ labels: labels.filter((l) => l.type === "user" || l.id === "INBOX").map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)) });
      }
      if (op === "folders") {
        if (s.row.scope_mode !== "full") return fail(409, "Use Choose folders and files to pick from Google Drive.");
        const parent = typeof body.parentId === "string" && ID_RE.test(body.parentId) ? body.parentId : "root";
        return ok({ folders: ((await s.session.listFolders(parent)).files ?? []).map((f) => ({ id: f.id, name: f.name })) });
      }
      if (!env.GOOGLE_PICKER_API_KEY || !env.GOOGLE_CLOUD_PROJECT_NUMBER) return fail(503, MESSAGES.notSetUp);
      return ok({ accessToken: await s.getAccess(), apiKey: env.GOOGLE_PICKER_API_KEY, appId: env.GOOGLE_CLOUD_PROJECT_NUMBER });
    } catch (err) {
      if (err instanceof GoogleAuthError) { await markNeedsReconnect(auth, s.row); return fail(409, WORDING.needsReconnect); }
      throw err;
    }
  }

  if (op === "pause" || op === "resume") {
    const bad = needProvider(); if (bad) return bad;
    const conn = await dbTx(auth, (db) => S.getConnection(db, provider));
    if (!conn || conn.status === "disconnected") return fail(409, MESSAGES.notConnected);
    if (conn.status === "needs-reconnect") return fail(409, WORDING.needsReconnect);
    await dbTx(auth, (db) => S.patchConnection(db, conn.id, { status: op === "pause" ? "paused" : "active", ...(op === "pause" ? { last_result: WORDING.paused } : {}) }));
    return ok({ status: op === "pause" ? "paused" : "active" });
  }

  if (op === "disconnect") {
    const bad = needProvider(); if (bad) return bad;
    const { row, tenantId } = await dbTx(auth, async (db) => ({ row: await S.getConnection(db, provider), tenantId: db.tenantId }));
    if (!row) return ok({ disconnected: true });
    // Tell Google to drop the grant first (best effort), then delete our copy of the token. Imported files stay.
    if (row.refresh_token_enc) {
      try {
        const client = deps.google ?? createGoogleClient({ env });
        await client.revoke(decryptToken(row.refresh_token_enc, tenantId, env));
      } catch { /* the token is deleted below either way */ }
    }
    await dbTx(auth, async (db) => {
      await S.patchConnection(db, row.id, { status: "disconnected", refresh_token_enc: null, config: {}, sync_state: {}, last_result: null, last_error: null });
      await db.logAction({ action: "google.disconnected", resource_type: "google_connection", resource_id: row.id, clerk_user_id: auth.userId, changes: { provider } });
    });
    return ok({ disconnected: true });
  }

  if (op === "sync-now") {
    const bad = needProvider(); if (bad) return bad;
    const r = await syncConnection(tenantCtx(auth), provider, { ...deps, env });
    if (r.skipped === "not-connected") return fail(409, MESSAGES.notConnected);
    if (r.skipped === "busy") return ok({ busy: true, result: WORDING.working });
    return ok({ ok: r.ok !== false, result: r.result ?? r.error ?? null, created: r.tally?.created ?? 0 });
  }

  return fail(400, "Unknown operation.");
}

async function markNeedsReconnect(auth, row) {
  await dbTx(auth, (db) => S.patchConnection(db, row.id, { status: "needs-reconnect", last_error: WORDING.needsReconnect }));
}

/** Google's redirect back to us. No session here: the signed state says which company and which admin started it. */
export async function handleCallback(query, deps = {}) {
  const env = deps.env ?? process.env;
  const back = (flag) => `/app/?screen=team&google=${flag}`;
  if (!isGoogleSyncEnabled(env)) return { status: 404, body: { error: MESSAGES.notAvailable } };
  const st = verifyState(query?.state, env);
  if (!st || !st.t || !PROVIDERS.includes(st.p)) return { redirect: back("error") };
  if (query?.error || !query?.code) return { redirect: back(query?.error === "access_denied" ? "cancelled" : "error") };
  try {
    const client = deps.google ?? createGoogleClient({ env });
    const tok = await client.exchangeCode(String(query.code));
    const need = scopesFor(st.p, st.m).filter((s) => s.startsWith("https://"));
    const granted = new Set(tok.scope.split(/\s+/));
    if (!tok.refreshToken || !need.every((s) => granted.has(s))) return { redirect: back("error") };
    await withTenant({ tenantKey: st.t, tenantName: st.tn ?? st.t }, async (db) => {
      const row = await S.saveConnection(db, { provider: st.p, scopeMode: st.m, email: tok.email, tokenEnc: encryptToken(tok.refreshToken, db.tenantId, env), userId: st.u });
      await db.logAction({ action: "google.connected", resource_type: "google_connection", resource_id: row.id, clerk_user_id: st.u, changes: { provider: st.p, mode: st.m } });
    });
    return { redirect: back("connected") };
  } catch (err) {
    console.error("google sync: callback failed:", err instanceof GoogleError ? `${err.status} ${err.reason}` : err?.message);
    return { redirect: back("error") };
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  const env = process.env;
  if (!isGoogleSyncEnabled(env)) {
    // Off: nothing else runs. Status says so (the settings card stays hidden); anything else is simply not there.
    if (req.method === "POST" && req.body?.op === "status") {
      try { await requireAuth(req); } catch (err) { return denyAuth(res, err); }
      return handleCors(res, req).status(200).json({ enabled: false });
    }
    return res.status(404).json({ error: MESSAGES.notAvailable });
  }

  if (req.method === "GET" && String(req.query?.op ?? "") === "callback") {
    const r = await handleCallback(req.query ?? {});
    if (r.redirect) { res.setHeader("Location", r.redirect); res.setHeader("Cache-Control", "no-store"); return res.status(302).end(); }
    return res.status(r.status).json(r.body);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try { auth = await requireAuth(req); } catch (err) { return denyAuth(res, err); }
  if (!(await rateLimit(req, res, auth, "write"))) return;
  try {
    const r = await handleOp(auth, req.body ?? {});
    res.setHeader("Cache-Control", "no-store");
    return handleCors(res, req).status(r.status).json(r.body);
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}

export { looksEncrypted };
