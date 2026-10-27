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

/* ------------------------------------------------------------------ AI finish (optional staff button; the nightly sweep does the same by itself)
 * PROPOSED wording, awaiting owner approval. Not one of these strings contains a price, a dollar sign or the word cost. */
export const FINISH_AI_LABEL = 'Finish with AI';
export const FINISH_AI_TITLE = 'Optional. DeepWell reads each open paper once more and fills in only what the page clearly states. It never replaces a value a person typed, and it never links a customer for you. This also runs by itself every night.';
export const FINISH_CHUNK = 20;
export const finishProgress = (done: number, total: number) => `Finishing ${done} of ${total}...`;

export interface FinishTotals { processed: number; facts: number; fieldSuggestions?: number; suggested: number; typed: number; failed: number; stopped: 'allowance' | 'off' | 'busy' | null }

export function finishBanner(t: FinishTotals, stillOpen: number): string {
  const left = stillOpen === 1 ? '1 paper still needs you.' : `${stillOpen} papers still need you.`;
  if (t.stopped === 'off') return `AI finishing is switched off for now. ${left}`;
  const parts: string[] = [`DeepWell filled in ${n(t.facts, 'more fact', 'more facts')}.`];
  if (t.fieldSuggestions) parts.push(t.fieldSuggestions === 1 ? 'Found 1 value for you to check.' : `Found ${t.fieldSuggestions} values for you to check.`);
  if (t.suggested) parts.push(`Suggested a customer for ${n(t.suggested, 'paper', 'papers')}: check each one, then link.`);
  if (t.typed) parts.push(`Set the type of ${t.typed}.`);
  parts.push(left);
  if (t.stopped === 'allowance') parts.push('Stopped for now: this account has used the AI help set for this period. What was done is saved, and the rest will be picked up when it renews.');
  if (t.stopped === 'busy') parts.push(`The AI service is busy. What was done is saved. Press "${FINISH_AI_LABEL}" again in a few minutes.`);
  if (t.failed) parts.push(`${n(t.failed, 'paper', 'papers')} could not be read this time and ${t.failed === 1 ? 'was' : 'were'} left as ${t.failed === 1 ? 'it was' : 'they were'}.`);
  return parts.join(' ');
}
export const FINISH_AI_ERROR = `We couldn't finish that just now. Anything already finished is saved. Press "${FINISH_AI_LABEL}" again in a minute to continue.`;
