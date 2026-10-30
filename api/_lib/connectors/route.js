/**
 * HTTP surface:  /api/account?action=connectors
 *   POST { op:'status' }                                        -> providers, links, email-in address status
 *   POST { op:'start', provider }                               -> { url }  provider consent page
 *   GET  ?op=callback&code&state                                -> finishes linking (paused until a folder is chosen), redirects back
 *   POST { op:'folders', linkId, parentRef? }                   -> folder list for the picker
 *   POST { op:'choose', linkId, folderRef, folderName }         -> links the folder and turns the link on
 *   POST { op:'mapping', linkId, mapping }                      -> per-tenant folder mapping
 *   POST { op:'pause'|'resume'|'disconnect'|'sync-now', linkId }
 *   POST { op:'email-setup' } | { op:'email-senders', senders } | { op:'email-toggle', enabled }
 *   POST (signed webhook) { op:'email-inbound' }                -> inbound mail from the email provider (no session; Svix signature)
 *   POST (signed webhook) { op:'push', provider }               -> provider change notification (acknowledged; the scheduled pass does the work)
 * Admin only (a solo account is its own admin). With DEEPWELL_CONNECTORS off: status answers {enabled:false}, everything else 404, and
 * nothing else in this folder loads. Customers never see costs: responses carry no dollar figure, token, cursor or ciphertext.
 */
import { isConnectorsEnabled, isProviderEnabled, enabledProviders, missingEnv, WORDING } from "./config.js";
import { normalizeMapping } from "./mapping.js";

export const config = { api: { bodyParser: { sizeLimit: "256kb" } }, maxDuration: 300 };

const ok = (body, extra = {}) => ({ status: 200, body, ...extra });
const fail = (status, error) => ({ status, body: { error } });
const FOLDER_PROVIDERS = ["gdrive", "dropbox", "onedrive"];
const REF_RE = /^[\w\-./:+=~ %@]{1,512}$/;

/** The testable core. deps = { env, store, loadAdapter, syncLink, now, fetchImpl, tenantId, userId, signState, verifyState, sealSecrets, publicLink, emailTools } */
export async function handleOp(auth, body, deps) {
  const env = deps.env ?? process.env;
  const op = typeof body?.op === "string" ? body.op : "";
  if (!isConnectorsEnabled(env)) return op === "status" ? ok({ enabled: false }) : fail(404, WORDING.notAvailable);
  const { store } = deps;
  const provider = body?.provider;
  const needLink = async () => {
    const l = typeof body?.linkId === "string" ? await store.getLink(body.linkId) : null;
    return l && l.status !== "disconnected" ? l : null;
  };

  switch (op) {
    case "status": {
      const links = (await store.listLinks()).map(deps.publicLink);
      const em = await store.getEmail();
      return ok({
        enabled: true,
        providers: enabledProviders(env).map((id) => ({ id, setUp: missingEnv(id, env).length === 0 })),
        links,
        email: enabledProviders(env).includes("emailin") ? { setUp: !!em, hint: em?.token_hint ?? null, enabled: em?.enabled ?? false, senders: em?.allowed_senders ?? [], held: em?.quarantined_count ?? 0 } : null,
      });
    }
    case "start": {
      if (!FOLDER_PROVIDERS.includes(provider) || !isProviderEnabled(provider, env)) return fail(404, WORDING.notAvailable);
      if (missingEnv(provider, env).length) return fail(409, "Connecting this source is not available on this account yet.");
      const adapter = await deps.loadAdapter(provider);
      const state = deps.signState({ t: deps.tenantId, p: provider, u: deps.userId ?? null });
      return ok(adapter.beginLink({ state, env }));
    }
    case "callback": {
      const st = deps.verifyState(body?.state);
      if (!st || !FOLDER_PROVIDERS.includes(st.p) || st.t !== deps.tenantId || !isProviderEnabled(st.p, env)) return fail(400, "That link has expired. Please start again.");
      const adapter = await deps.loadAdapter(st.p);
      let done;
      try { done = await adapter.completeLink({ env, fetchImpl: deps.fetchImpl }, { code: String(body?.code ?? "") }); } catch { return fail(502, "The connection did not finish. Please try again."); }
      const link = await store.createLink({ provider: st.p, accountRef: done.accountRef, folderRef: `pending:${deps.nonce?.() ?? Date.now()}`, secretsEnc: deps.sealSecrets(st.p, done.secrets), userId: deps.userId });
      await store.setStatus(link.id, "paused");
      return ok({ linkId: link.id }, { redirect: "/?connected=1" });
    }
    case "folders": {
      const l = await needLink(); if (!l) return fail(404, WORDING.notAvailable);
      if (body.parentRef !== undefined && !REF_RE.test(String(body.parentRef))) return fail(400, "Invalid folder.");
      const adapter = await deps.loadAdapter(l.provider);
      const secrets = deps.openSecrets(l);
      return ok({ folders: await adapter.listFolders({ tenantId: deps.tenantId, accountRef: l.account_ref, secrets, env, fetchImpl: deps.fetchImpl }, body.parentRef || undefined) });
    }
    case "choose": {
      const l = await needLink(); if (!l) return fail(404, WORDING.notAvailable);
      if (!REF_RE.test(String(body.folderRef ?? ""))) return fail(400, "Choose a folder.");
      return ok({ link: deps.publicLink(await store.setFolder(l.id, { folderRef: String(body.folderRef), folderName: String(body.folderName ?? "").slice(0, 200) })) });
    }
    case "mapping": {
      const l = await needLink(); if (!l) return fail(404, WORDING.notAvailable);
      return ok({ link: deps.publicLink(await store.setMapping(l.id, normalizeMapping(body.mapping))) });
    }
    case "pause": case "resume": case "disconnect": {
      const l = await needLink(); if (!l) return fail(404, WORDING.notAvailable);
      if (op === "disconnect") { try { const a = await deps.loadAdapter(l.provider); await a.revoke({ tenantId: deps.tenantId, accountRef: l.account_ref, secrets: deps.openSecrets(l), env, fetchImpl: deps.fetchImpl }); } catch { /* best effort */ } }
      const row = await store.setStatus(l.id, op === "pause" ? "paused" : op === "resume" ? "active" : "disconnected");
      return ok({ link: deps.publicLink(row) });
    }
    case "sync-now": {
      const l = await needLink(); if (!l) return fail(404, WORDING.notAvailable);
      const r = await deps.syncLink(l);
      return ok({ result: { message: r.message ?? null, skipped: r.skipped ?? null, brought: r.tally?.created ?? 0 } });
    }
    case "email-setup": {
      if (!isProviderEnabled("emailin", env)) return fail(404, WORDING.notAvailable);
      if (missingEnv("emailin", env).length) return fail(409, "Email-in is not available on this account yet.");
      const t = deps.emailTools;
      const token = t.newToken();
      const row = await store.saveEmail({ tokenHash: t.tokenHash(token, env), tokenHint: token.slice(-4), allowedSenders: [] });
      return ok({ address: t.addressFor(token, env), hint: row.token_hint, note: "Copy this address now. It is shown once." });   // shown once; only a keyed hash is stored
    }
    case "email-senders": {
      if (!(await store.getEmail())) return fail(409, "Set up the email address first.");
      const senders = (Array.isArray(body.senders) ? body.senders : []).map((s) => String(s).trim().toLowerCase()).filter((s) => /^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(s)).slice(0, 100);
      return ok({ senders: (await store.setEmail({ allowedSenders: senders })).allowed_senders });
    }
    case "email-toggle": {
      if (!(await store.getEmail())) return fail(409, "Set up the email address first.");
      return ok({ enabled: (await store.setEmail({ enabled: body.enabled === true })).enabled });
    }
    default: return fail(400, "Unknown operation.");
  }
}

/** Unauthenticated inbound-mail webhook. Verifies the signature BEFORE parsing anything. */
export async function handleInboundWebhook(req, deps) {
  const env = deps.env ?? process.env;
  if (!isProviderEnabled("emailin", env)) return fail(404, WORDING.notAvailable);
  const t = deps.emailTools;
  if (!t.verifyWebhook(req.headers ?? {}, req.rawBody ?? "", env.EMAILIN_WEBHOOK_SECRET, deps.now?.())) return fail(401, "Invalid signature.");
  let payload; try { payload = JSON.parse(req.rawBody ?? "{}"); } catch { return fail(400, "Invalid body."); }
  if (payload.type && !/received/i.test(String(payload.type))) return ok({ ignored: true });
  const r = await t.handleInbound(t.normalizeInbound(payload), deps.inbound);
  return { status: r.status, body: { ok: r.status === 200 } };       // the outcome stays in our logs, not in the response
}

/** The Vercel handler: resolves auth, builds real deps, calls the cores. Everything heavy is imported here, after the flag check. */
export default async function handler(req, res) {
  const env = process.env;
  const op = String(req.body?.op ?? req.query?.op ?? "");
  const send = (r) => { if (r.redirect) return res.redirect(302, r.redirect); return res.status(r.status).json(r.body); };
  if (!isConnectorsEnabled(env)) return res.status(op === "status" ? 200 : 404).json(op === "status" ? { enabled: false } : { error: WORDING.notAvailable });
  const { handleCors, handleError } = await import("../claude.js");
  if (handleCors(req, res)) return;
  try {
    const emailTools = await import("./emailIn.js");
    const { withTenant } = await import("../recordsStore.js");
    if (op === "email-inbound") {
      const { createStore, emailLookup } = await import("./store.js");
      const { importsAllowed } = await import("./allowance.js");
      const { getPool } = await import("../recordsStore.js");
      const { createImporter } = await import("./importer.js");
      const importer = await createImporter();
      const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body ?? {});
      return send(await handleInboundWebhook({ headers: req.headers, rawBody }, { env, emailTools, inbound: {
        env, importer,
        lookup: async (h) => { const c = await getPool().connect(); try { const r = await emailLookup(c, h); return r ? { tenantKey: r.tenant_key, allowedSenders: r.allowed_senders } : null; } finally { c.release(); } },
        storeFor: (tenantKey) => createStore((fn) => withTenant({ tenantKey, tenantName: tenantKey }, fn)),
        allowance: (tenantKey) => importsAllowed(withTenant, { tenantKey, tenantName: tenantKey }, env),
        fetchAttachment: async (msg, att) => fetchResendAttachment(msg, att, env),
      } }));
    }
    if (op === "push") return res.status(200).json({ ok: true });   // acknowledged; the scheduled pass picks up changes (see report)
    const { requireAuth, hasShop, requireRole } = await import("../auth.js");
    const { limit: rateLimit } = await import("../rateLimit.js");
    const auth = await requireAuth(req);
    if (hasShop(auth)) requireRole(auth, "admin");
    const tctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
    const { createStore, publicLink } = await import("./store.js");
    const { loadAdapter } = await import("./adapters/index.js");
    const { signState, verifyState } = await import("../googleSync/crypto.js");
    const { sealSecrets, openSecrets, keyEnv } = await import("./secrets.js");
    const { syncLink } = await import("./sweep.js");
    const tenantId = await withTenant(tctx, async (db) => db.tenantId);
    const store = createStore((fn) => withTenant(tctx, fn));
    const body = req.method === "GET" ? { op, code: req.query?.code, state: req.query?.state } : req.body;
    const deps = { env, store, loadAdapter, tenantId, userId: auth.userId, publicLink, emailTools,
      signState: (p) => signState(p, keyEnv(p.p, env)), verifyState: (s) => verifyState(s, keyEnv("dropbox", env)) ?? verifyState(s, keyEnv("gdrive", env)),
      sealSecrets: (p, s) => sealSecrets(p, tenantId, s, env), openSecrets: (l) => openSecrets(l.provider, tenantId, l.secrets_enc, env),
      syncLink: (l) => syncLink({ tenantKey: tctx.tenantKey, tenantName: tctx.tenantName }, l, { env }) };
    return send(await handleOp(auth, body, deps));
  } catch (err) {
    return handleError(res, err);
  }
}

/** Fetch an inbound attachment's bytes from Resend. Endpoint shape to be confirmed against Resend's inbound docs (owner step E3). */
async function fetchResendAttachment(msg, att, env) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(msg.emailId)}/attachments/${encodeURIComponent(att.id)}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`attachment fetch ${r.status}`);
  const j = await r.json();
  if (j.content) return Buffer.from(j.content, "base64");
  const d = await fetch(j.download_url, { signal: AbortSignal.timeout(30_000) });
  if (!d.ok) throw new Error(`attachment download ${d.status}`);
  return Buffer.from(await d.arrayBuffer());
}
