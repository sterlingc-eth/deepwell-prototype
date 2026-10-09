/**
 * "Your documents are ready": one bell notification when a bulk import finishes reading.
 *
 * Called by the queue (queue.js, extract-fields, inside its last step) after every document. It does nothing unless:
 *   - no document is still waiting to be read (same rule as importProgress in recordsStore.js), and
 *   - at least IMPORT_NOTIFY_MIN documents finished reading in the last IMPORT_WINDOW_HOURS (a bulk import, not a
 *     single upload, which already shows its own progress on screen), and
 *   - no such notification went out in the last IMPORT_NOTIFY_COOLDOWN_MIN minutes (the last few documents of an
 *     import finish at almost the same moment; this keeps it to one).
 * It never throws: a notification is a courtesy and must never fail or retry a document's extraction.
 */
import { withTenant } from "./recordsStore.js";

export const IMPORT_NOTIFY_MIN = 10;
export const IMPORT_WINDOW_HOURS = 6;
export const IMPORT_NOTIFY_COOLDOWN_MIN = 30;
export const IMPORT_NOTIFY_KIND = "import";

/** Pure: the notification text for `count` finished documents. Exported for scripts/verify-import-progress.ts. */
export function importDoneMessage(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  return {
    title: "Your documents are ready",
    body: `${n.toLocaleString("en-US")} documents were read and filed. Open the Inbox to see anything that needs you.`,
    link: "/app/?screen=ingest",
  };
}

/** Pure: should a notification go out, given the counts the query below returns. Exported for the test. */
export function shouldNotifyImportDone({ pending, readRecent, recentNotices }) {
  return pending === 0 && readRecent >= IMPORT_NOTIFY_MIN && recentNotices === 0;
}

export async function notifyIfImportDone(ctx) {
  try {
    await withTenant(ctx, async (store) => {
      const { rows } = await store.raw(
        `SELECT
           (SELECT count(*)::int FROM documents
             WHERE tenant_id = $1 AND extract_error IS NULL
               AND ((stage = 'received' AND created_at > NOW() - INTERVAL '3 days')
                 OR (stage = 'read' AND extracted_at > NOW() - INTERVAL '15 minutes'))) AS pending,
           (SELECT count(*)::int FROM documents
             WHERE tenant_id = $1 AND extracted_at > NOW() - ($2::int * INTERVAL '1 hour')) AS read_recent,
           (SELECT count(*)::int FROM notifications
             WHERE tenant_id = $1 AND kind = $3 AND created_at > NOW() - ($4::int * INTERVAL '1 minute')) AS recent_notices`,
        [store.tenantId, IMPORT_WINDOW_HOURS, IMPORT_NOTIFY_KIND, IMPORT_NOTIFY_COOLDOWN_MIN]
      );
      const r = rows?.[0] ?? {};
      if (!shouldNotifyImportDone({ pending: r.pending, readRecent: r.read_recent, recentNotices: r.recent_notices })) return;
      const msg = importDoneMessage(r.read_recent);
      await store.raw(
        `INSERT INTO notifications (tenant_id, kind, title, body, link) VALUES ($1, $2, $3, $4, $5)`,
        [store.tenantId, IMPORT_NOTIFY_KIND, msg.title, msg.body, msg.link]
      );
    });
  } catch (err) {
    console.error("importDone: could not check or record the import notification:", err?.message);
  }
}
