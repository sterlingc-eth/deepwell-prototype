/**
 * Provider-agnostic sync pass. One folder link, one adapter, one pass:
 *
 *   lease -> allowance gate -> open secrets -> adapter.listChanges (pages) -> per item:
 *     removed? flag it (DeepWell keeps its copy) | unchanged marker? skip | unsupported type? skip with a reason |
 *     provider hash already imported? record as duplicate, no download | else download -> SHA-256 -> importer (dedupe by bytes)
 *   -> cursor saved only for pages that finished cleanly -> result written back.
 *
 * Everything with side effects is injected (deps), so the same code runs against the real database or the in-memory test store.
 * deps = { store, importer:{ precheck(), importOne() }, adapter, limits, env, now(), openSecrets(), sealSecrets(), allowance() }
 */
import { sha256Hex, AuthLostError, RateLimitedError, TooLargeError } from "./contract.js";
import { targetFolder } from "./mapping.js";
import { WORDING } from "./config.js";

const newTally = () => ({ created: 0, duplicate: 0, unchanged: 0, skipped: 0, error: 0, removed: 0, deferred: 0 });
const describe = (t) => {
  const parts = [];
  if (t.created) parts.push(`Brought in ${t.created} new ${t.created === 1 ? "file" : "files"}.`);
  if (t.removed) parts.push(`${t.removed} no longer in the source. DeepWell keeps its copy.`);
  if (t.deferred) parts.push("More files are waiting and will come in on the next check.");
  return parts.join(" ") || WORDING.upToDate;
};

export async function runSync(ctx, link, deps) {
  const { store, adapter, env } = deps;
  const lim = deps.limits;
  const now = deps.now ?? (() => Date.now());
  if (link.status !== "active") return { skipped: link.status };
  const claim = await store.claim(link.id, lim.leaseMs, now());
  if (!claim) return { skipped: "busy" };

  const tally = newTally();
  let status = "active", message = null, cursor = link.cursor && Object.keys(link.cursor).length ? link.cursor : null, retryAfterMs = null;
  try {
    const gate = await deps.allowance();
    if (!gate.allowed) { await store.finish(link.id, { status, message: WORDING.waitingAllowance, cursor, tally, now: now() }); return { skipped: "allowance", tally }; }

    let secrets = deps.openSecrets(link);
    const conn = () => ({ tenantId: ctx.tenantId, accountRef: link.account_ref, secrets, env, fetchImpl: deps.fetchImpl });
    const guarded = async (fn) => {
      try { return await fn(conn()); }
      catch (e) {
        if (!(e instanceof AuthLostError)) throw e;
        const fresh = await adapter.refreshSecrets(conn());       // may throw AuthLostError again -> access lost
        secrets = fresh.secrets;
        await store.saveSecrets(link.id, deps.sealSecrets(secrets));   // new rotating token stored BEFORE it is used
        return fn(conn());
      }
    };

    let pages = 0, filesSeen = 0, stop = false;
    const folder = { ref: link.folder_ref, name: link.folder_name };
    while (!stop && pages < lim.maxPagesPerPass) {
      const page = await guarded((c) => adapter.listChanges(c, folder, cursor));
      pages++;
      const before = { error: tally.error, deferred: tally.deferred };
      for (const item of page.items ?? []) {
        if (item.isFolder) continue;
        filesSeen++;
        const out = await processItem(ctx, link, item, { ...deps, guarded, tally, budget: () => filesSeen <= lim.maxFilesPerPass });
        tally[out] = (tally[out] ?? 0) + 1;
      }
      const clean = tally.error === before.error && tally.deferred === before.deferred;
      if (clean) cursor = page.nextCursor ?? cursor;
      else stop = true;
      if (!page.hasMore) break;
    }
    message = describe(tally);
  } catch (e) {
    if (e instanceof AuthLostError) { status = "access-lost"; message = WORDING.accessLost; }
    else if (e instanceof RateLimitedError) { retryAfterMs = e.retryAfterMs; message = "The source is limiting requests right now. DeepWell will try again shortly."; }
    else message = "DeepWell could not finish checking this folder just now. It will try again.";
  }
  await store.finish(link.id, { status, message, cursor, tally, now: now(), retryAfterMs });
  return { status, message, tally, cursor };
}

async function processItem(ctx, link, item, deps) {
  const { store, importer, adapter, guarded, limits: lim } = deps;
  if (item.removed) return (await store.markRemoved(link.id, item.ref)) ? "removed" : "unchanged";
  const prior = await store.getItem(link.id, item.ref);
  if (prior && prior.change_marker === item.changeMarker) {
    if (prior.state === "removed-in-source") await store.markReturned(link.id, item.ref);
    if (["imported", "skipped", "removed-in-source"].includes(prior.state)) return "unchanged";
  }
  const folder = targetFolder(link.mapping, item);
  const base = { linkId: link.id, ref: item.ref, filename: item.name, marker: item.changeMarker, providerHash: item.providerHash ?? null, providerHashKind: item.providerHashKind ?? null, targetFolder: folder };

  const pre = importer.precheck({ filename: item.name, contentType: item.mime, sizeBytes: item.exportAs ? undefined : item.size });
  if (!pre.ok) { await store.upsertItem({ ...base, state: "skipped", note: pre.note }); return "skipped"; }

  // Provider hash seen before on an imported item: same bytes, no download.
  if (item.providerHash && item.providerHashKind) {
    const twin = await store.itemByProviderHash(item.providerHashKind, item.providerHash);
    if (twin?.document_id && twin.ref !== item.ref) {
      await store.upsertItem({ ...base, state: "imported", documentId: twin.document_id, contentSha256: twin.content_sha256, note: "Same content as a file already in DeepWell.", importedAt: deps.now?.() ?? Date.now() });
      return "duplicate";
    }
  }
  if (!deps.budget()) return "deferred";

  let bytes;
  try { bytes = await guarded((c) => adapter.download(c, item, lim.maxBytesPerFile)); }
  catch (e) {
    if (e instanceof RateLimitedError || e instanceof AuthLostError) throw e;
    if (e instanceof TooLargeError) { await store.upsertItem({ ...base, state: "skipped", note: "This file is too large to bring in. Save a smaller copy and DeepWell will pick it up." }); return "skipped"; }
    await store.upsertItem({ ...base, state: "error", note: "DeepWell could not read this file just now. It will try again.", marker: null });
    return "error";
  }
  const sha = sha256Hex(bytes);
  const r = await importer.importOne(ctx, { filename: pre.filename, contentType: pre.contentType, bytes, source: `connector_${link.provider}`, externalId: item.ref, folderHint: folder });
  if (r.outcome === "refused") { await store.upsertItem({ ...base, state: "skipped", note: r.note, contentSha256: sha }); return "skipped"; }
  if (r.outcome === "gate") { return "deferred"; }
  await store.upsertItem({ ...base, state: "imported", documentId: r.documentId, contentSha256: sha, importedAt: deps.now?.() ?? Date.now(), previousDocumentId: prior?.document_id && prior.document_id !== r.documentId ? prior.document_id : null });
  return r.outcome === "created" ? "created" : "duplicate";
}
