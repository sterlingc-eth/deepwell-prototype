/**
 * Pure state for the Customers-tab duplicates banner (owner request
 * 2026-09-20, item 2). A pair from GET /api/v1/customers's `duplicates` is
 * "handled" for this session once the person either merges it or says
 * "Not the same" — both just make it stop showing, so one Set<string> of
 * `keepId:dropId` keys covers both actions. No component/store state here:
 * ReviewScreen-style, kept pure so scripts/verify-ui.ts can check it with no
 * DOM.
 */

export interface DuplicatePairLike {
  keepId: string;
  dropId: string;
}

export type DuplicateActionType = 'dismiss' | 'merge';

export interface DuplicateAction extends DuplicatePairLike {
  type: DuplicateActionType;
}

export function pairKey(p: DuplicatePairLike): string {
  return `${p.keepId}:${p.dropId}`;
}

/** Reducer: both 'dismiss' (not the same) and 'merge' (done for real) remove
 *  the pair from the banner for the rest of this session. Never mutates the
 *  set passed in. */
export function reduceDuplicates(handled: ReadonlySet<string>, action: DuplicateAction): Set<string> {
  const next = new Set(handled);
  next.add(pairKey(action));
  return next;
}

/** Pairs still worth showing — everything not yet dismissed or merged. */
export function visibleDuplicates<T extends DuplicatePairLike>(pairs: T[], handled: ReadonlySet<string>): T[] {
  return pairs.filter((p) => !handled.has(pairKey(p)));
}

// ---------------------------------------------------------------------------
// Which-account-to-keep chooser (owner feedback 2026-09-20: "give me an
// option on which account to merge into the other; I wanted to keep the one
// with both their names ('Ray & Linda Castillo') instead of just the last
// name ('Castillo')"). Mirrors api/_lib/integrity.js's nameTokenCount /
// pickKeepDrop exactly (duplicated, not imported — src/ cannot import api/,
// same reason customerClient.ts hand-mirrors CUSTOMER_NUMBER_RE) so the
// nightly auto-merge default and this banner's default agree.
// ---------------------------------------------------------------------------

export interface NamedCustomerLike {
  id: string;
  name: string | null | undefined;
  customerNumber?: string | null;
}

/** How many "name tokens" a name carries — "Ray & Linda Castillo" -> 3,
 *  "Castillo" -> 1. */
export function nameTokenCount(raw: string | null | undefined): number {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** 'C-00003' -> 3; anything unparseable sorts last (never preferred as the
 *  tiebreak winner). */
function customerNumberOrdinal(customerNumber: string | null | undefined): number {
  const m = typeof customerNumber === 'string' && /^C-(\d+)$/.exec(customerNumber);
  return m ? Number(m[1]) : Infinity;
}

/** Pure default-keep rule for the duplicates chooser: the fuller name wins
 *  (more name tokens — "Ray & Linda Castillo" beats "Castillo"); a tie goes
 *  to the lower customer number. Returns the id of the record to keep. */
export function defaultKeepId(a: NamedCustomerLike, b: NamedCustomerLike): string {
  const ta = nameTokenCount(a.name);
  const tb = nameTokenCount(b.name);
  if (ta !== tb) return ta > tb ? a.id : b.id;
  return customerNumberOrdinal(a.customerNumber) <= customerNumberOrdinal(b.customerNumber) ? a.id : b.id;
}
