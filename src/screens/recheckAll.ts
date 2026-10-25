/**
 * Inbox "Re-check all open papers" helpers (pure, no React): which papers the button sends, and the plain-words result banner.
 * Kept out of ReviewScreen.tsx so the counting can be tested without rendering.
 */
import type { Doc } from '../core/types';
import { countsAsOpen, requiredFieldsForDoc, type GraphSnapshot } from '../core/entityGraph';
import { needInfo } from './reviewGrouping';

/** Approved wording (Inbox round) + PROPOSED wording below, awaiting owner approval. */
export const RECHECK_ALL_LABEL = 'Re-check all open papers';
export const RECHECK_CHUNK = 100;

/** Every paper that is still open: missing info, needs linking, ready to verify, needs a person. Never a verified or set-aside paper. */
export function openPaperIds(g: GraphSnapshot): string[] {
  return Object.values(g.docs).filter((d) => countsAsOpen(d, g)).map((d) => d.id);
}

/** Of the papers the button sent, how many are still open, and the most common plain-words reasons (largest first). */
export function stillOpenSummary(g: GraphSnapshot, sentIds: Iterable<string>, topN = 3): { count: number; top: { label: string; count: number }[] } {
  const typeById = new Map(g.schema.documentTypes.map((t) => [t.id, t]));
  const byLabel = new Map<string, number>();
  let count = 0;
  for (const id of sentIds) {
    const d: Doc | undefined = g.docs[id];
    if (!d || !countsAsOpen(d, g)) continue;
    count++;
    const info = needInfo(d, requiredFieldsForDoc(d, d.typeId ? typeById.get(d.typeId) : undefined));
    // "Needs: service address" and "Needs: cost" are one reason to the reader: a fact the page did not show.
    const label = info.groupKey.startsWith('missing:') ? 'Fact not on the page' : info.groupKey === 'other' ? 'Ready for a person to check' : info.groupLabel;
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  }
  const top = [...byLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([label, n]) => ({ label, count: n }));
  return { count, top };
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

export interface RecheckTotals { checked: number; fields: number; linked: number; verified: number; retyped: number; errors?: number }

/** PROPOSED wording, awaiting owner approval. */
export const recheckProgress = (done: number, total: number) => `Re-checking ${done} of ${total}...`;
export function recheckBanner(t: RecheckTotals, still: { count: number; top: { label: string; count: number }[] }): string {
  const typed = t.retyped ? ` Corrected the type of ${t.retyped}.` : '';
  const why = still.count > 0 && still.top.length ? ` Main reasons: ${still.top.map((x) => `${x.label} (${x.count})`).join(', ')}.` : '';
  const left = still.count === 1 ? '1 still needs a person.' : `${still.count} still need a person.`;
  const err = t.errors ? ` ${n(t.errors, 'paper', 'papers')} could not be checked this time and ${t.errors === 1 ? 'was' : 'were'} left as ${t.errors === 1 ? 'it was' : 'they were'}. Press "${RECHECK_ALL_LABEL}" again to try ${t.errors === 1 ? 'it' : 'them'} once more.` : '';
  return `Re-checked ${n(t.checked, 'paper', 'papers')}. Filled in ${n(t.fields, 'fact', 'facts')}, linked ${t.linked} to customers, checked ${t.verified} automatically.${typed} ${left}${why}${err}`;
}
