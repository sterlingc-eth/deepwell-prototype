/**
 * Needs-you list helpers (pure, no React): what a document still needs in plain
 * words, and how a filtered queue is split into small headed sections.
 * Kept out of ReviewScreen.tsx so the rules can be tested without rendering.
 */
import type { Doc } from '../core/types';
import { isRequirementMet } from '../core/entityGraph';
import { fieldLabel } from '../domains/hvac/schema';
import type { Filter } from './reviewFilters';

export interface NeedInfo {
  /** Full row text, e.g. "Needs: service address, cost" (null when nothing is outstanding). */
  text: string | null;
  /** Section the row belongs to when sections are by "what is needed". */
  groupKey: string;
  groupLabel: string;
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Plain-words reason a document is in the queue. `requiredFields` is the document type's requirement list. */
export function needInfo(doc: Doc, requiredFields: readonly string[]): NeedInfo {
  const present = new Set(doc.extracted.filter((f) => (f.correctedValue ?? f.value).trim()).map((f) => f.name));
  const missing = requiredFields.filter((r) => !isRequirementMet(present, r));
  if (missing.length > 0) {
    const labels = missing.map((r) => r.split('|').map((k) => lowerFirst(fieldLabel(k))).join(' or '));
    return { text: `Needs: ${labels.join(', ')}`, groupKey: `missing:${labels[0]}`, groupLabel: `Needs: ${labels[0]}` };
  }
  if (doc.issues.some((i) => i.kind === 'duplicate')) return { text: 'Duplicate', groupKey: 'duplicate', groupLabel: 'Duplicate' };
  if (doc.issues.some((i) => i.kind === 'conflict')) return { text: 'Conflict', groupKey: 'conflict', groupLabel: 'Conflict' };
  if (doc.issues.some((i) => i.kind === 'unlinked' || i.kind === 'ambiguous-name-link')) {
    return { text: 'Needs linking', groupKey: 'unlinked', groupLabel: 'Needs linking' };
  }
  if (!doc.typeId) return { text: 'Unclassified', groupKey: 'unclassified', groupLabel: 'Unclassified' };
  return { text: null, groupKey: 'other', groupLabel: 'Other' };
}

/** Filters whose sections are by "what is needed"; the rest are sectioned by document type. */
const BY_NEED: ReadonlySet<Filter> = new Set<Filter>(['attention', 'gaps']);

export interface Section<T> { key: string; label: string; items: T[] }

/**
 * Splits an already-sorted queue into sections (largest first, "Other" last).
 * Order inside a section is the queue's own order (newest first).
 */
export function sectionsFor<T extends { doc: Doc; need: NeedInfo; typeLabel: string }>(rows: T[], filter: Filter): Section<T>[] {
  const byNeed = BY_NEED.has(filter);
  const map = new Map<string, Section<T>>();
  for (const r of rows) {
    const key = byNeed ? r.need.groupKey : `type:${r.typeLabel}`;
    const label = byNeed ? r.need.groupLabel : r.typeLabel;
    let s = map.get(key);
    if (!s) { s = { key, label, items: [] }; map.set(key, s); }
    s.items.push(r);
  }
  const rank = (s: Section<T>) => (s.key === 'other' ? 1 : 0);
  return [...map.values()].sort((a, b) => rank(a) - rank(b) || b.items.length - a.items.length || a.label.localeCompare(b.label));
}

/** The id to select after `selectedId` leaves the list: the next row that is still there, else the previous one. */
export function neighbourAfterRemoval(prevIds: readonly string[], currentIds: ReadonlySet<string>, selectedId: string): string | null {
  const at = prevIds.indexOf(selectedId);
  if (at < 0) return null;
  for (let i = at + 1; i < prevIds.length; i++) if (currentIds.has(prevIds[i]!)) return prevIds[i]!;
  for (let i = at - 1; i >= 0; i--) if (currentIds.has(prevIds[i]!)) return prevIds[i]!;
  return null;
}
