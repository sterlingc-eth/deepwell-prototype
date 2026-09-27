/**
 * Proactive insights — data-gap detectors (R17 contract, item 5): gaps that
 * block Donovan from answering a question, each with a one-tap fix path into
 * the existing Inbox/intake queue.
 *
 *   a. open intake questions — reuses api/_lib/intake/queue.js's own
 *      listIntakeQueue (the exact same "clean exception queue" the Inbox
 *      screen reads), never re-derives which document needs what field.
 *   b. equipment missing a serial number or model — a plain completeness
 *      check with no existing engine of its own (nothing in this codebase
 *      already computes this as a summary); a direct, tenant-scoped SQL count
 *      + sample, same "one query, no re-derivation of anyone else's rule"
 *      spirit as rollups/refresh.js's own computeXxx functions.
 *
 * listIntakeQueue never opens its own withTenant — safe to call from inside
 * the insights route's own transaction.
 */
import { TENANT_SQL } from '../../scope.js';
import { listIntakeQueue } from '../../intake/queue.js';

const MAX_ITEMS = 8;

/** Item 5a: documents sitting on an open (unsnoozed) intake question — same
 *  population the Inbox's own queue card list shows, one-tap fix = open it. */
async function detectOpenIntakeQuestions(db) {
  let queue;
  try {
    queue = await listIntakeQueue(db, { limit: MAX_ITEMS });
  } catch {
    return null;
  }
  if (!queue?.tracked || !queue.openDocumentCount) return null;
  return {
    id: 'data-gaps-intake',
    kind: 'data-gap',
    severity: 'low',
    title: 'Documents need an answer',
    count: queue.openDocumentCount,
    items: queue.items.slice(0, MAX_ITEMS).map((item) => ({
      label: `${item.displayName || item.documentTypeLabel || item.filename} — ${item.question}`,
      entityId: item.entityId ?? null,
      documentIds: [item.documentId],
    })),
    action: { label: 'Open the Inbox', href: 'inbox' },
  };
}

/** Item 5b: equipment entities on file with no serial number and/or no model — a data gap that
 *  silently blocks any "which unit is X" / warranty lookup for that unit. */
async function detectUnitsMissingIdentifiers(db) {
  const { rows } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'customer_name' AS customer_name,
            e.data->>'service_address' AS service_address,
            (coalesce(nullif(trim(e.data->>'serial_number'), ''), '') = '') AS missing_serial,
            (coalesce(nullif(trim(e.data->>'model'), ''), '') = '') AS missing_model,
            COALESCE((SELECT array_agg(DISTINCT l.document_id) FROM document_entity_links l WHERE l.entity_id = e.id AND l.${TENANT_SQL}), ARRAY[]::uuid[]) AS document_ids
       FROM entities e
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
        AND (coalesce(nullif(trim(e.data->>'serial_number'), ''), '') = '' OR coalesce(nullif(trim(e.data->>'model'), ''), '') = '')
      ORDER BY e.created_at DESC
      LIMIT 200`,
    []
  );
  if (!rows.length) return null;
  return {
    id: 'data-gaps-units',
    kind: 'data-gap',
    severity: 'low',
    title: 'Units missing serial or model',
    count: rows.length,
    items: rows.slice(0, MAX_ITEMS).map((r) => {
      const missing = [r.missing_serial && 'serial number', r.missing_model && 'model'].filter(Boolean).join(' and ');
      const who = [r.manufacturer, r.customer_name, r.service_address].filter(Boolean).join(' · ') || 'Unknown unit';
      return { label: `${who} — missing ${missing}`, entityId: r.id, documentIds: r.document_ids ?? [] };
    }),
    action: { label: 'Ask about incomplete units', href: 'ask:Which units are missing a serial number or model?' },
  };
}

/** @returns {Promise<object[]>} zero to two insight objects; never throws. */
export async function detectDataGapInsights(db) {
  const results = await Promise.allSettled([detectOpenIntakeQuestions(db), detectUnitsMissingIdentifiers(db)]);
  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}
