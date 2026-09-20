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
