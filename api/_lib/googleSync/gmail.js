/**
 * Gmail pass: attachments only, from the labels and senders the admin chose.
 *
 *  - Only attachments are imported, and only of supported types (the same allow-list as a manual upload). The text of an email
 *    is never stored, indexed or sent anywhere: the message is fetched to find its attachment list, and the body is dropped.
 *  - Messages match when they carry an attachment AND (have any chosen label OR come from any chosen sender).
 *  - Duplicates: one row per message part (message id + part id), and identical bytes become one document (sha256).
 *  - Cursor: sync_state.cursorMs (time of the last complete pass; the next pass re-reads one extra day) plus a ring of recently
 *    handled message ids (sync_state.seen), so overlap costs a metadata read, not a download.
 */
import { precheck } from "./importer.js";
import { GoogleError, GoogleRateLimitError } from "./googleApi.js";
import * as S from "./store.js";

const DAY_MS = 86_400_000;
const SEEN_MAX = 1500;
const PER_PASS_NEW_MESSAGES = 300;
const MAX_LIST_PAGES = 15;

/** Sender addresses, trimmed, lowercased, deduplicated; anything that is not an email address is dropped. */
export function normalizeSenders(input, max = 25) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[,;\s]+/);
  const out = [];
  for (const raw of list) {
    const a = String(raw).trim().toLowerCase().replace(/^<|>$/g, "");
    if (/^[^\s@"'()<>]+@[^\s@"'()<>]+\.[^\s@"'()<>]+$/.test(a) && !out.includes(a)) out.push(a);
  }
  return out.slice(0, max);
}

/** The Gmail search for the senders part (labels use labelIds). */
export function senderQuery(senders, afterSec) {
  return `has:attachment after:${afterSec} from:(${senders.join(" OR ")})`;
}

/** Walk the MIME tree and return the attachment parts (never the bodies). */
export function attachmentParts(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body && (p.body.attachmentId || p.body.size > 0)) {
      const h = Object.fromEntries((p.headers ?? []).map((x) => [String(x.name).toLowerCase(), String(x.value ?? "")]));
      out.push({
        partId: p.partId ?? String(out.length),
        filename: p.filename,
        mimeType: p.mimeType,
        size: Number(p.body.size) || 0,
        attachmentId: p.body.attachmentId ?? null,
        inlineData: p.body.data ?? null,
        inline: /^\s*inline/i.test(h["content-disposition"] ?? "") || Boolean(h["content-id"]),
      });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}

export async function runGmailPass(run) {
  const { conn, tx } = run;
  const cfg = conn.config ?? {};
  const labelIds = cfg.labelIds ?? [];
  const senders = cfg.senders ?? [];
  if (!labelIds.length && !senders.length) { run.tally.note = "Choose labels or senders to bring attachments from."; return { more: false }; }

  const passStart = Date.now();
  let st = { ...(conn.sync_state ?? {}) };
  const lookbackDays = cfg.lookbackDays ?? 30;
  const cursorMs = Number.isFinite(st.cursorMs) ? st.cursorMs : passStart - lookbackDays * DAY_MS;
  const afterSec = Math.floor((cursorMs - DAY_MS) / 1000);
  const seen = new Set(Array.isArray(st.seen) ? st.seen : []);
  const seenOrder = [...seen];

  // 1. collect the messages to look at
  const queries = [
    ...labelIds.map((id) => ({ labelIds: [id], q: `has:attachment after:${afterSec}` })),
    ...(senders.length ? [{ q: senderQuery(senders, afterSec) }] : []),
  ];
  const todo = [];
  const queued = new Set();
  let exhausted = true;
  for (const query of queries) {
    let pageToken;
    for (let pages = 0; pages < MAX_LIST_PAGES; pages++) {
      const page = await run.google.listMessages({ ...query, pageToken });
      for (const m of page.messages ?? []) {
        if (seen.has(m.id) || queued.has(m.id)) continue;
        queued.add(m.id);
        todo.push(m.id);
      }
      pageToken = page.nextPageToken;
      if (!pageToken) break;
      if (todo.length >= PER_PASS_NEW_MESSAGES) { exhausted = false; break; }
      if (pages + 1 >= MAX_LIST_PAGES) exhausted = false;
    }
    if (todo.length >= PER_PASS_NEW_MESSAGES) { exhausted = false; break; }
  }

  // 2. oldest first (list order is newest first), so the backlog drains from the past forward
  todo.reverse();
  let complete = exhausted;
  for (const id of todo) {
    if (run.outOfBudget()) { complete = false; break; }
    let msg;
    try { msg = await run.google.getMessage(id); } catch (err) {
      if (err instanceof GoogleRateLimitError) throw err;
      if (err instanceof GoogleError && err.status === 404) { seenOrder.push(id); continue; }
      complete = false; continue;
    }
    let allDone = true;
    let hadError = false;
    for (const part of attachmentParts(msg.payload)) {
      const outcome = await processAttachment(run, id, part);
      run.count(outcome);
      if (outcome === "error") hadError = true;
      if (outcome === "deferred") { allDone = false; break; }
    }
    if (!allDone) { complete = false; break; }
    if (!hadError) seenOrder.push(id); // a message with a failed attachment is looked at again next pass
    if (run.stopped) { complete = false; break; }
  }

  const ring = [...new Set(seenOrder)].slice(-SEEN_MAX);
  const patch = { seen: ring };
  if (complete) patch.cursorMs = passStart;
  else if (!Number.isFinite(st.cursorMs)) patch.cursorMs = cursorMs; // pin the look-back start so it does not slide
  await tx((db) => S.patchConnection(db, conn.id, { sync_state: patch }));
  return { more: !complete };
}

async function processAttachment(run, messageId, part) {
  const { conn, tx } = run;
  const externalId = `${messageId}:${part.partId}`;
  const item = await tx((db) => S.getItem(db, conn.id, externalId));
  if (item && item.state !== "error") return "unchanged"; // attachments of a sent message never change; a failed one is retried

  const small = run.limits.gmailMinImageBytes;
  const isImage = /^image\//i.test(part.mimeType ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(part.filename);
  if (isImage && part.inline && part.size < small) {
    await tx((db) => S.upsertItem(db, { connectionId: conn.id, externalId, filename: part.filename, state: "skipped", note: "A small picture inside the email (such as a logo)." }));
    return "ignored";
  }
  const pre = precheck({ filename: part.filename, contentType: part.mimeType, sizeBytes: part.size || undefined });
  if (!pre.ok) {
    await tx((db) => S.upsertItem(db, { connectionId: conn.id, externalId, filename: part.filename, state: "skipped", note: pre.note }));
    return "skipped";
  }
  if (!run.reserve()) return "deferred";

  let bytes;
  try {
    bytes = part.attachmentId
      ? await run.google.getAttachment(messageId, part.attachmentId, run.limits.maxBytesPerFile)
      : Buffer.from(part.inlineData ?? "", "base64url");
  } catch (err) {
    run.release();
    if (err instanceof GoogleRateLimitError) throw err;
    const tooLarge = err instanceof GoogleError && err.reason === "tooLarge";
    await tx((db) => S.upsertItem(db, { connectionId: conn.id, externalId, filename: part.filename, state: tooLarge ? "skipped" : "error",
      note: tooLarge ? "This attachment is too large to bring in." : "Gmail would not let DeepWell read this attachment just now. DeepWell will try again." }));
    return tooLarge ? "skipped" : "error";
  }
  return run.storeFile({ externalId, filename: pre.filename, contentType: pre.contentType, bytes, marker: null, item: null, modifiedAt: null });
}
