import type { Doc, Entity, EntityId } from './types';

/**
 * The customer entity (if any) a document belongs to. Single source of truth
 * for BrowseScreen, ReviewScreen, DocumentPreview and CustomerProfileScreen —
 * they used to each derive this independently and drifted: ReviewScreen only
 * checked a direct link, so a document linked to its equipment (but not yet
 * to the customer directly — the exact "Margaret Henderson" production
 * defect, handoffs/LINKING_ROOT_CAUSE_2026-09-20.md) showed "Not linked to a
 * customer yet" there while BrowseScreen already showed the right name for
 * the same row via its own (better) fallback.
 *
 * Order: 1) a direct document_entity_links row to a customer entity —
 * doc.linkedEntityIds already includes these (usePostgresSync.ts); 2) the
 * customer of a linked UNIT (equipment.customer_id, surfaced as
 * fields.customerId by usePostgresSync's toEntity) — a document linked only
 * to its equipment still names an owner once that equipment has one; 3) null.
 */
export function customerForDocument(doc: Doc, entities: Record<EntityId, Entity>): Entity | null {
  for (const id of doc.linkedEntityIds) {
    const e = entities[id];
    if (e?.type === 'customer') return e;
  }
  for (const id of doc.linkedEntityIds) {
    const e = entities[id];
    const cid = e?.fields?.customerId;
    if (e?.type === 'equipment' && typeof cid === 'string' && entities[cid]?.type === 'customer') return entities[cid];
  }
  return null;
}

/** The customer-scope predicate the Inbox's "Customer: X ×" chip applies
 *  (owner defect report 2026-09-22, item 3): a document is in scope when no
 *  scope is set, or `customerForDocument` resolves it to that customer.
 *  Kept alongside customerForDocument (not in ReviewScreen.tsx, a component
 *  file — oxlint's react/only-export-components would flag it there) so
 *  it's a plain, independently-testable function. */
export function matchesCustomerScope(doc: Doc, entities: Record<EntityId, Entity>, scopeCustomerId: string | null): boolean {
  return !scopeCustomerId || customerForDocument(doc, entities)?.id === scopeCustomerId;
}
