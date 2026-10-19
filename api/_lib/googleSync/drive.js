/**
 * Google Drive pass: initial import, then incremental sync with the Drive changes feed (one page token per connection).
 *
 * State (google_connections.sync_state):
 *   startToken   changes token captured BEFORE the first listing, so anything edited during the import is seen afterwards
 *   pageToken    set when the initial import is complete; each pass reads changes from here and saves the next token
 *   initial      { pending: [{id, d, pt}] }  folders still to list (depth d, page cursor pt); {} when finished
 *
 * Scope modes (config in google_connections.config):
 *   narrow (drive.file)     config.picked = files and folders chosen in Google's picker. Drive only ever shows the app those.
 *   full   (drive.readonly) config.picked = folders (and files) the admin chose; a changed file counts only if it sits inside one.
 */
import { EXPORTS, FOLDER_MIME } from "./config.js";
import { precheck } from "./importer.js";
import { GoogleError, GoogleRateLimitError } from "./googleApi.js";
import * as S from "./store.js";

const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

export function driveFileName(meta) {
  const exp = EXPORTS[meta.mimeType];
  const name = String(meta.name ?? "").trim() || "Untitled";
  if (!exp) return name;
  return name.toLowerCase().endsWith(`.${exp[1]}`) ? name : `${name}.${exp[1]}`;
}

/** The marker that says "this file changed": the content checksum for real files, the modified time for Google Docs/Sheets. */
export function changeMarker(meta, pickerMode = false) {
  // Picker mode: the Drive file id (the item's key) plus its modifiedTime decide "has this changed". Identical bytes are still
  // recognised afterwards by their SHA-256, so a touched-but-unchanged file never becomes a second document.
  if (pickerMode) return `mod:${meta.modifiedTime ?? ""}`;
  return meta.md5Checksum ? `md5:${meta.md5Checksum}` : `mod:${meta.modifiedTime ?? ""}:${meta.version ?? ""}`;
}

/** Which folder ids are chosen (full mode filters changes by them). */
export function pickedFolderIds(cfg) {
  return (cfg.picked ?? []).filter((p) => p.kind === "folder").map((p) => p.id);
}

/** Is `meta` inside one of the chosen folders? Walks parents (cached in `cache`), bounded depth. */
export async function isInsideChosen(run, meta, chosen, cache) {
  if (!chosen.size) return false;
  const seen = new Set();
  let frontier = [...(meta.parents ?? [])];
  for (let depth = 0; depth < run.limits.maxFolderDepth && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      if (chosen.has(id)) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      if (cache.has(id)) { next.push(...cache.get(id)); continue; }
      let parents = [];
      try { parents = (await run.google.getFile(id)).parents ?? []; } catch (err) { if (err instanceof GoogleRateLimitError) throw err; }
      cache.set(id, parents);
      next.push(...parents);
    }
    frontier = next;
  }
  return false;
}

/** Handle one Drive file (already known to be in scope). Returns a short outcome word for the tally. */
export async function processDriveFile(run, meta) {
  const { tx, conn } = run;
  if (!meta?.id || meta.mimeType === FOLDER_MIME || meta.mimeType === SHORTCUT_MIME) return "ignored";
  if (meta.trashed) return handleRemoved(run, meta.id);

  const item = await tx((db) => S.getItem(db, conn.id, meta.id));
  const marker = changeMarker(meta, run.pickerMode);
  if (item && item.source_checksum === marker && item.state === "imported") return "unchanged";
  if (item && item.source_checksum === marker && item.state === "removed-in-source") {
    await tx((db) => S.markReturned(db, conn.id, meta.id));
    return "unchanged";
  }
  if (item && item.source_checksum === marker && item.state === "skipped") return "unchanged";

  const exp = EXPORTS[meta.mimeType];
  if (!exp && String(meta.mimeType).startsWith("application/vnd.google-apps.")) {
    await tx((db) => S.upsertItem(db, { connectionId: conn.id, externalId: meta.id, filename: meta.name, sourceChecksum: marker, state: "skipped", note: "Google forms, drawings and maps can't be read. Save a copy as a PDF in Drive to bring it in." }));
    return "skipped";
  }
  const filename = driveFileName(meta);
  const contentType = exp ? exp[0] : meta.mimeType;
  const pre = precheck({ filename, contentType, sizeBytes: exp ? undefined : Number(meta.size) || undefined });
  if (!pre.ok) {
    await tx((db) => S.upsertItem(db, { connectionId: conn.id, externalId: meta.id, filename, sourceChecksum: marker, state: "skipped", note: pre.note }));
    return "skipped";
  }
  if (!run.reserve()) return "deferred";

  let bytes;
  try {
    bytes = exp
      ? await run.google.exportFile(meta.id, exp[0], run.limits.maxBytesPerFile)
      : await run.google.download(meta.id, run.limits.maxBytesPerFile);
  } catch (err) {
    if (err instanceof GoogleRateLimitError) { run.release(); throw err; }
    run.release();
    const tooLarge = err instanceof GoogleError && err.reason === "tooLarge";
    await tx((db) => S.upsertItem(db, {
      connectionId: conn.id, externalId: meta.id, filename, sourceChecksum: marker, state: tooLarge ? "skipped" : "error",
      version: item?.version ?? 1, previousDocumentIds: item?.previous_document_ids ?? [], documentId: item?.document_id ?? null, contentSha256: item?.content_sha256 ?? null,
      note: tooLarge ? "This file is too large to bring in. Save a smaller copy and DeepWell will pick it up." : "Google would not let DeepWell read this file just now. DeepWell will try again.",
    }));
    return tooLarge ? "skipped" : "error";
  }
  return run.storeFile({ externalId: meta.id, filename, contentType: pre.contentType, bytes, marker, item, modifiedAt: meta.modifiedTime ?? null });
}

async function handleRemoved(run, fileId) {
  const row = await run.tx((db) => S.markRemoved(db, run.conn.id, fileId));
  return row ? "removed" : "ignored";
}

/**
 * Picker mode (drive.file). Only the files the admin picked are looked at, one by one, by id:
 *   - Google answers 404/403 when access to a file is gone (deleted, or the admin removed DeepWell's access to it): flagged
 *     "no longer in Google", DeepWell keeps its copy.
 *   - a trashed file is flagged the same way.
 *   - otherwise the file's modifiedTime is compared with the one recorded at the last import; a different time means re-import.
 * A cursor (sync_state.pickCursor) lets a long list continue across passes, so a pass that runs out of time or room resumes.
 * Folders are never expanded: with drive.file Google gives an app a picked folder itself, not what is inside it (see DRIVE_PICKER_REPORT).
 */
export async function runPickedPass(run) {
  const { conn, tx } = run;
  const files = (conn.config?.picked ?? []).filter((p) => p.kind !== "folder");
  if (!files.length) { run.tally.note = "Choose the files to bring in."; return { more: false }; }
  let cursor = Math.min(Number(conn.sync_state?.pickCursor) || 0, files.length);
  const save = async (n) => { run.conn = await tx((db) => S.patchConnection(db, conn.id, { sync_state: { pickCursor: n } })); };
  while (cursor < files.length) {
    if (run.outOfBudget()) { await save(cursor); return { more: true }; }
    const p = files[cursor];
    let meta = null;
    try {
      meta = await run.google.getFile(p.id);
    } catch (err) {
      if (err instanceof GoogleRateLimitError) { await save(cursor); throw err; }
      if (err instanceof GoogleError && (err.status === 404 || err.status === 403)) run.count(await handleRemoved(run, p.id));
      else { run.count("error"); }
      cursor++;
      continue;
    }
    const outcome = await processDriveFile(run, meta);
    if (outcome === "deferred" || run.stopped) { await save(cursor); run.count(outcome); return { more: true }; }
    run.count(outcome);
    cursor++;
  }
  await save(0);
  return { more: false };
}

/** One pass. Returns { more: boolean } (true = work is left for the next pass). */
export async function runDrivePass(run) {
  if (run.pickerMode) return runPickedPass(run);
  const { conn, tx } = run;
  const cfg = conn.config ?? {};
  let st = { ...(conn.sync_state ?? {}) };
  const save = async (patch) => { st = { ...st, ...patch }; run.conn = await tx((db) => S.patchConnection(db, conn.id, { sync_state: st })); };
  const nothingChosen = !(cfg.picked ?? []).length;
  if (nothingChosen) { run.tally.note = "Choose folders to bring in."; return { more: false }; }

  // ---- initial import
  if (!st.pageToken) {
    if (!st.startToken) await save({ startToken: await run.google.startPageToken() });
    if (!st.initial?.pending) {
      const pending = [];
      for (const p of cfg.picked) if (p.kind === "folder") pending.push({ id: p.id, d: 0, pt: null });
      await save({ initial: { pending, filesDone: false } });
    }
    if (!st.initial.filesDone) {
      for (const p of cfg.picked.filter((x) => x.kind !== "folder")) {
        if (run.outOfBudget()) return { more: true };
        let meta;
        try { meta = await run.google.getFile(p.id); } catch (err) { if (err instanceof GoogleRateLimitError) throw err; continue; }
        run.count(await processDriveFile(run, meta));
      }
      if (run.stopped) return { more: true };
      await save({ initial: { ...st.initial, filesDone: true } });
    }
    while (st.initial.pending.length) {
      if (run.outOfBudget()) return { more: true };
      const cur = st.initial.pending[0];
      const page = await run.google.listChildren(cur.id, cur.pt);
      for (const f of page.files ?? []) {
        if (f.mimeType === FOLDER_MIME) {
          if (cur.d + 1 <= run.limits.maxFolderDepth && !st.initial.pending.some((x) => x.id === f.id)) st.initial.pending.push({ id: f.id, d: cur.d + 1, pt: null });
          continue;
        }
        if (run.outOfBudget()) { await save({ initial: st.initial }); return { more: true }; }
        run.count(await processDriveFile(run, f));
      }
      // The page cursor only moves once every file on the page was handled; a stop re-lists this page next pass (handled files are "unchanged").
      if (run.stopped) { await save({ initial: st.initial }); return { more: true }; }
      if (page.nextPageToken) st.initial.pending[0] = { ...cur, pt: page.nextPageToken };
      else st.initial.pending.shift();
      await save({ initial: st.initial });
    }
    // A file that failed (Google or storage hiccup) must not be forgotten once we move on to the changes feed: list again, a few times.
    if (run.tally.error > 0 && (st.initial?.attempts ?? 0) < 3) {
      const again = [];
      for (const p of cfg.picked) if (p.kind === "folder") again.push({ id: p.id, d: 0, pt: null });
      await save({ initial: { pending: again, filesDone: true, attempts: (st.initial?.attempts ?? 0) + 1 } });
      return { more: true };
    }
    await save({ pageToken: st.startToken, initial: {} });
    // fall through: read the changes made while the import ran, in this same pass if there is time
  }

  // ---- incremental
  const chosen = new Set(pickedFolderIds(cfg));
  const pickedFiles = new Set((cfg.picked ?? []).filter((p) => p.kind !== "folder").map((p) => p.id));
  const cache = new Map();
  let token = st.pageToken;
  for (;;) {
    if (run.outOfBudget()) return { more: true };
    const errorsBefore = run.tally.error;
    const page = await run.google.listChanges(token);
    for (const ch of page.changes ?? []) {
      if (ch.removed || ch.file?.trashed) { run.count(await handleRemoved(run, ch.fileId)); continue; }
      const f = ch.file;
      if (!f || f.mimeType === FOLDER_MIME) continue;
      const inScope = conn.scope_mode === "narrow" || pickedFiles.has(f.id) || (await isInsideChosen(run, f, chosen, cache));
      if (!inScope) continue;
      run.count(await processDriveFile(run, f));
    }
    if (run.stopped) return { more: true }; // stay on this token; handled files are skipped as unchanged next pass
    // A file that failed on this page is tried again on the next pass (up to 3 times), then left flagged in the list of problems.
    if (run.tally.error > errorsBefore && (st.tokenRetries ?? 0) < 3) { await save({ tokenRetries: (st.tokenRetries ?? 0) + 1 }); return { more: true }; }
    if (st.tokenRetries) await save({ tokenRetries: 0 });
    if (page.nextPageToken) { token = page.nextPageToken; await save({ pageToken: token }); continue; }
    await save({ pageToken: page.newStartPageToken ?? token });
    return { more: false };
  }
}
