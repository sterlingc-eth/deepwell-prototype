/**
 * Customer reminders (build 2026-09-22): a memo, dispatch note or piece of
 * correspondence naming a forward-looking instruction for a customer's next
 * visit — see the owner's own example, doc 054-other-c10.pdf: "INTERNAL
 * MEMO … Reminder logged for Karen Abernathy's account: confirm filter size
 * on next visit."
 *
 * No DDL, per the build brief: "open" state is simply a document carrying a
 * `reminder_text` extraction; "done" is recorded as an ordinary audit_log row
 * (action 'reminder.done', resource_id = the document id) — the same
 * everything-lives-in-existing-tables pattern api/_lib/missStore.js and
 * api/_lib/learning/store.js already use for their own append-only state.
 *
 * `db` throughout is anything exposing an async `.raw(sql, params) ->
 * {rows}` — the shape both recordsStore.js's store object and a plain
 * `{ raw: (sql, params) => client.query(sql, params) }` adapter around
 * reviewStore.js's raw pg client already provide, so this file works from
 * either caller with no coupling to which one it is.
 */
const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

/**
 * Document types a reminder is ever kept on — see extractFields.js's
 * reminder_text/reminder_customer_name/reminder_trigger and
 * extractDocument.js's own gate, which drops reminder facts extracted off
 * any OTHER type before they're ever written. Exported so both files (and
 * reviewStore.js's extractReminders backfill) share exactly one list.
 */
export const REMINDER_ELIGIBLE_DOCUMENT_TYPES = new Set(['correspondence', 'dispatch-note', 'other', 'internal']);

/**
 * Pure: turn one raw SQL row (see listOpenReminders' own query) into the
 * shape callers (the customer profile screen, Donovan's reminder answers)
 * actually want. Exported so the shape is pinned with no database.
 */
export function shapeReminderRow(row) {
  return {
    documentId: row.document_id,
    reminderText: row.reminder_text ?? null,
    reminderTrigger: row.reminder_trigger ?? null,
    reminderCustomerName: row.reminder_customer_name ?? null,
    createdAt: row.created_at ?? null,
    filename: row.original_filename ?? null,
    documentType: row.document_type ?? null,
    customerId: row.customer_id ?? null,
    customerName: row.customer_name ?? null,
  };
}

/**
 * Pure: drop any reminder whose document already has a 'reminder.done'
 * audit_log row. Split out from listOpenReminders below so this rule — the
 * entire "open" definition — is checkable against plain arrays, no database,
 * no mock. `doneDocumentIds` may contain ids for documents not present in
 * `reminderRows` at all; those are simply never matched, not an error.
 */
export function resolveOpenReminders(reminderRows, doneDocumentIds) {
  const done = new Set((doneDocumentIds ?? []).filter(Boolean));
  return (reminderRows ?? []).filter((r) => r && r.documentId && !done.has(r.documentId));
}

/**
 * Every open reminder this tenant has on file, optionally scoped to one
 * customer. Two reads (candidate reminders, then done document ids) rather
 * than one NOT EXISTS query, specifically so resolveOpenReminders' filtering
 * rule stays a plain, independently-testable function rather than logic only
 * ever expressed in SQL.
 *
 * A document can carry at most one `reminder_text` (extractDocument.js and
 * reviewStore.js's extractReminders both write it once, never twice), so no
 * de-duplication beyond DISTINCT ON is needed here.
 */
export async function listOpenReminders(db, { customerId, limit } = {}) {
  const cappedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;

  const params = [];
  let customerFilter = '';
  if (customerId) {
    params.push(customerId);
    customerFilter = `AND l.entity_id = $${params.length}`;
  }

  const { rows } = await db.raw(
    `SELECT DISTINCT ON (d.id)
            d.id AS document_id, d.original_filename, d.document_type, d.created_at,
            rt.value AS reminder_text,
            (SELECT value FROM extractions x2
              WHERE x2.document_id = d.id AND x2.field_key = 'reminder_trigger' AND x2.${TENANT}
              ORDER BY x2.created_at DESC LIMIT 1) AS reminder_trigger,
            (SELECT value FROM extractions x3
              WHERE x3.document_id = d.id AND x3.field_key = 'reminder_customer_name' AND x3.${TENANT}
              ORDER BY x3.created_at DESC LIMIT 1) AS reminder_customer_name,
            l.entity_id AS customer_id, ce.data->>'customer_name' AS customer_name
       FROM extractions rt
       JOIN documents d ON d.id = rt.document_id AND d.${TENANT}
       LEFT JOIN document_entity_links l ON l.document_id = d.id AND l.${TENANT}
            AND l.entity_id IN (SELECT id FROM entities WHERE entity_type = 'customer' AND ${TENANT})
       LEFT JOIN entities ce ON ce.id = l.entity_id
      WHERE rt.field_key = 'reminder_text' AND rt.${TENANT}
        ${customerFilter}
      ORDER BY d.id, rt.created_at DESC`,
    params
  );

  const { rows: doneRows } = await db.raw(
    `SELECT DISTINCT resource_id FROM audit_log WHERE action = 'reminder.done' AND ${TENANT}`,
    []
  );

  const open = resolveOpenReminders(rows.map(shapeReminderRow), doneRows.map((r) => r.resource_id));
  return open
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, cappedLimit);
}
