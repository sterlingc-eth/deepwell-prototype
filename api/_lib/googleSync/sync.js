/**
 * The scheduled driver and the per-connection pass.
 *
 *   runGoogleSyncSweep()  : every organization with an active connection; called by the Inngest schedule (api/_lib/queue.js)
 *                           and by the nightly sweep (cron-sweep.js) as a safety net. Returns at once when the flag is off.
 *   syncConnection()      : one organization's Drive or Gmail pass (also what "Sync now" runs).
 *
 * A pass: take a lease on the connection (two passes never overlap) -> check the plan is active -> turn the stored refresh token
 * into a short-lived access token (never stored) -> Drive/Gmail walk -> record the result. Network calls never happen while a
 * database transaction is open; each file gets its own short transaction, so one bad file cannot undo the others.
 */
import { withTenant } from "../recordsStore.js";
import { isGoogleSyncEnabled, limits as limitsFor, WORDING } from "./config.js";
import { decryptToken } from "./crypto.js";
import { createGoogleClient, GoogleAuthError, GoogleRateLimitError, GoogleError } from "./googleApi.js";
import { defaultImportDeps, importBytes } from "./importer.js";
import { runDrivePass } from "./drive.js";
import { runGmailPass } from "./gmail.js";
import * as S from "./store.js";

export const RESULT = Object.freeze({
  upToDate: "Up to date.",
  waitingGoogle: "Google is limiting requests right now. DeepWell will try again shortly.",
  dailyLimit: WORDING.dailyLimit,
  planInactive: "Waiting for your DeepWell plan to be active.",
  totalLimit: "This connection has reached the number of files it can bring in.",
  signIn: WORDING.needsReconnect,
  generic: "DeepWell could not finish checking Google just now. It will try again.",
});

const brought = (n) => `Brought in ${n} new ${n === 1 ? "file" : "files"}.`;

function describe(t) {
  const parts = [];
  if (t.created > 0) parts.push(brought(t.created));
  if (t.removed > 0) parts.push(t.created > 0 ? `${t.removed} no longer in Google.` : `${t.removed} no longer in Google. DeepWell keeps its copy.`);
  if (t.note) parts.push(t.note);
  return parts.length ? parts.join(" ") : RESULT.upToDate;
}

function newTally() {
  return { created: 0, duplicate: 0, unchanged: 0, skipped: 0, error: 0, removed: 0, ignored: 0, deferred: 0, note: null };
}

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {'drive'|'gmail'} provider
 * @param {object} [deps] injected in tests: { google, importDeps, assertBilling, env, limits }
 */
export async function syncConnection(ctx, provider, deps = {}) {
  const env = deps.env ?? process.env;
  if (!isGoogleSyncEnabled(env)) return { skipped: "off" };
  const lim = { ...limitsFor(env), ...(deps.limits ?? {}) };
  const tx = (fn) => withTenant({ tenantKey: ctx.tenantKey, tenantName: ctx.tenantName ?? ctx.tenantKey }, fn);

  const claim = await tx(async (db) => ({ ...(await S.claimConnection(db, provider, lim.runBudgetMs + 60_000)), tenantId: db.tenantId, today: await S.importedToday(db) }));
  if (claim.none) return { skipped: "not-connected" };
  if (claim.inactive) return { skipped: claim.inactive };
  if (claim.busy) return { skipped: "busy" };

  let conn = claim.row;
  const tally = newTally();
  const release = async (patch = {}, opts) => { conn = await tx((db) => S.patchConnection(db, conn.id, { ...patch, sync_state: { lease: null } }, opts)); return conn; };
  let result = null;
  let error = null;
  let status;

  try {
    const billing = deps.assertBilling ? await deps.assertBilling(ctx) : await (await import("../plan.js")).assertActiveBilling(ctx);
    if (!billing.allowed) {
      await release({ last_sync_at: new Date().toISOString(), last_result: RESULT.planInactive, last_error: null });
      return { skipped: "billing" };
    }

    // Quota reached: say so without touching Google at all.
    const dailyRoom = lim.maxFilesPerDay - claim.today;
    const totalRoom = lim.maxFilesPerConnection - (Number(conn.files_imported) || 0);
    if (dailyRoom <= 0 || totalRoom <= 0) {
      result = dailyRoom <= 0 ? RESULT.dailyLimit : RESULT.totalLimit;
      await release({ last_sync_at: new Date().toISOString(), last_result: result, last_error: null });
      return { ok: true, tally, result };
    }

    const importDeps = deps.importDeps ?? (await defaultImportDeps());
    const googleClient = deps.google ?? createGoogleClient({ env });
    const refresh = decryptToken(conn.refresh_token_enc, claim.tenantId, env);
    const getAccess = () => googleClient.refreshAccessToken(refresh);
    const session = googleClient.session(await getAccess(), getAccess);
    const billingRow = await importDeps.loadBillingRow({ tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey });

    const deadlineAt = Date.now() + lim.runBudgetMs;
    let filesLeft = lim.maxFilesPerRun;
    let dailyLeft = lim.maxFilesPerDay - claim.today;
    let totalLeft = lim.maxFilesPerConnection - (Number(conn.files_imported) || 0);
    let stopReason = null;

    const run = {
      ctx, conn, tx, google: session, limits: lim, tally, stopped: false,
      outOfBudget: () => run.stopped || Date.now() > deadlineAt,
      count: (o) => { if (o in tally) tally[o]++; },
      reserve: () => {
        if (filesLeft <= 0) { run.stopped = true; stopReason = "run"; return false; }
        if (dailyLeft <= 0) { run.stopped = true; stopReason = "daily"; return false; }
        if (totalLeft <= 0) { run.stopped = true; stopReason = "total"; return false; }
        filesLeft--; dailyLeft--; totalLeft--;
        return true;
      },
      release: () => { filesLeft++; dailyLeft++; totalLeft++; },
      async storeFile({ externalId, filename, contentType, bytes, marker, item, modifiedAt }) {
        try {
          const out = await tx(async (db) => {
            const r = await importBytes(db, importDeps, { filename, contentType, bytes, billingRow });
            if (r.outcome === "refused") {
              await S.upsertItem(db, { connectionId: conn.id, externalId, filename, sourceChecksum: marker, state: "skipped", note: r.note });
              return r;
            }
            let version = item?.version ?? 1;
            let previous = item?.previous_document_ids ?? [];
            if (item?.document_id && item.document_id !== r.documentId) { version = (item.version ?? 1) + 1; previous = [...previous, item.document_id]; }
            await S.upsertItem(db, {
              connectionId: conn.id, externalId, filename: r.filename, sourceChecksum: marker, contentSha256: r.sha256, documentId: r.documentId,
              version, previousDocumentIds: previous, state: "imported", sourceModifiedAt: modifiedAt,
              importedAt: r.outcome === "created" ? new Date().toISOString() : null,
            });
            return r;
          });
          if (out.outcome === "created") {
            created++;
            try { await importDeps.enqueue(ctx, out.documentId); } catch (err) { console.error("google sync: enqueue failed (the sweep will pick the document up):", err?.message); }
            return "created";
          }
          run.release(); // a duplicate or a refused file costs no room
          return out.outcome === "duplicate" ? "duplicate" : "skipped";
        } catch (err) {
          run.release();
          if (err?.name === "UploadGateRefusal") { run.stopped = true; stopReason = "plan"; tally.note = String(err.message).slice(0, 300); return "deferred"; }
          console.error("google sync: could not store a file:", err?.message);
          await tx((db) => S.upsertItem(db, { connectionId: conn.id, externalId, filename, sourceChecksum: null, state: "error", note: "DeepWell could not store this file just now. It will try again." })).catch(() => {});
          return "error";
        }
      },
    };
    let created = 0;

    await (provider === "gmail" ? runGmailPass(run) : runDrivePass(run));
    if (stopReason === "daily") tally.note = RESULT.dailyLimit;
    else if (stopReason === "total") tally.note = RESULT.totalLimit;
    result = describe(tally);
    await release({ last_sync_at: new Date().toISOString(), last_result: result, last_error: null }, { addImported: created });
    return { ok: true, tally, result };
  } catch (err) {
    if (err instanceof GoogleAuthError || err?.name === "GoogleAuthError") {
      status = "needs-reconnect"; error = RESULT.signIn;
    } else if (err instanceof GoogleRateLimitError) {
      error = RESULT.waitingGoogle;
    } else if (err?.name === "TokenKeyError") {
      error = RESULT.generic;
      console.error("google sync: token key problem:", err.message);
    } else {
      error = RESULT.generic;
      console.error("google sync: pass failed:", err instanceof GoogleError ? `${err.status} ${err.reason}` : err?.message);
    }
    try {
      await release({ ...(status ? { status } : {}), last_sync_at: new Date().toISOString(), last_result: error, last_error: error });
    } catch (e2) { console.error("google sync: could not record the failure:", e2?.message); }
    return { ok: false, error, tally };
  }
}

/** One organization: every active connection, Drive then Gmail. */
export async function syncTenant(ctx, deps = {}, deadlineAt = Infinity) {
  const env = deps.env ?? process.env;
  if (!isGoogleSyncEnabled(env)) return { skipped: "off" };
  const conns = await withTenant({ tenantKey: ctx.tenantKey, tenantName: ctx.tenantName ?? ctx.tenantKey }, (db) => S.listConnections(db));
  const out = [];
  for (const c of conns) {
    if (c.status !== "active") continue;
    if (Date.now() > deadlineAt) { out.push({ provider: c.provider, skipped: "time" }); continue; }
    out.push({ provider: c.provider, ...(await syncConnection(ctx, c.provider, deps)) });
  }
  return { connections: out };
}

/** The scheduled entry point. With the flag off: returns before opening a database connection or importing anything else. */
export async function runGoogleSyncSweep({ deadlineAt = Date.now() + 240_000, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  if (!isGoogleSyncEnabled(env)) return { skipped: "off" };
  const tenants = deps.tenants ?? (await S.listSyncTenants());
  const summary = { tenants: tenants.length, created: 0, errors: 0, left: 0 };
  for (const t of tenants) {
    if (Date.now() > deadlineAt) { summary.left++; continue; }
    try {
      const r = await syncTenant({ tenantKey: t.tenant_key, tenantName: t.tenant_name ?? t.tenant_key }, deps, deadlineAt);
      for (const c of r.connections ?? []) { summary.created += c.tally?.created ?? 0; if (c.ok === false) summary.errors++; }
    } catch (err) {
      summary.errors++;
      console.error("google sync: tenant failed:", err?.message);
    }
  }
  return summary;
}
