/**
 * Inbox redesign (2026-10-26): pure helpers (no React) that sort the open papers by the ACTION a person has to take,
 * not by why the system flagged them. Five groups, easiest first:
 *   confirm  one click: the page points at exactly one customer, a person only has to say yes
 *   approve  one click: every check passed, a person only has to say yes
 *   missing  a fact the page did not show (look again on the page, or type it)
 *   pick     no clear customer: a person chooses one
 *   look     anything else that needs eyes (hard to read, disagreeing, not sorted, a value to check)
 * Kept out of ReviewScreen.tsx so the rules can be tested without rendering (scripts/verify-inbox-redesign.ts).
 * Nothing here changes a paper: it only reads, and decides what may be offered as a one-click or bulk action.
 */
import type { Doc, Entity } from '../../core/types';
import { isNothingRead, linkSuggestions, maxStageFor, strongLinkSuggestionIds, type GraphSnapshot } from '../../core/entityGraph';
import { str } from '../../core/answer';
import { unconfirmedDates } from '../../core/dateFlags';
import type { QueueRowData } from './NeedsYouList';
import type { Section } from '../../screens/reviewGrouping';

export type ActionGroupId = 'confirm' | 'approve' | 'missing' | 'pick' | 'look';

/** PROPOSED wording, awaiting owner approval (INBOX_REDESIGN_REPORT.md lists every string). */
export const GROUP_META: Record<ActionGroupId, { label: string; hint: string }> = {
  confirm: { label: 'Confirm customer', hint: 'One click each. The page points at one customer.' },
  approve: { label: 'Check and approve', hint: 'Passed every check. One click each.' },
  missing: { label: 'Add missing info', hint: 'A fact the page did not show.' },
  pick: { label: 'Choose a customer', hint: 'No clear match yet.' },
  look: { label: 'Take a look', hint: 'Hard to read, disagreeing, or not sorted.' },
};
export const GROUP_ORDER: ActionGroupId[] = ['confirm', 'approve', 'missing', 'pick', 'look'];

export interface TriageRow extends QueueRowData {
  group: ActionGroupId;
  /** Short reason chips (never more than three, never a sentence). */
  chips: string[];
  /** The one customer a "confirm" row would link to. `strong` = the page evidence meets the R6 rule (name AND street, or the exact name as a
   *  customer-label value); only strong suggestions may be linked in bulk, every other one is a one-at-a-time click. */
  suggestion: { id: string; name: string; strong: boolean } | null;
  /** True when "Approve" may be offered for this paper in one click and in bulk. */
  approvable: boolean;
}

const customerName = (e: Entity) => str(e, 'customer_name') || str(e, 'name') || 'Unnamed';
const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A paper may be approved in bulk only when every automatic check passed: all required facts read, linked (or no link
 *  needed), nothing in dispute, nothing read doubtfully, no date to confirm, no amount to check. */
export function isBulkApprovable(doc: Doc, g: Pick<GraphSnapshot, 'schema'>, moneyIds: ReadonlySet<string>): boolean {
  if (doc.stage !== 'linked' || doc.issues.length > 0) return false;
  if (isNothingRead(doc)) return false;
  if (moneyIds.has(doc.id)) return false;
  if (unconfirmedDates(doc).length > 0) return false;
  return maxStageFor(doc, g.schema) === 'verified';
}

/** Which group a paper belongs to, its chips, and the one-click suggestion (if any). */
export function triageRow(row: QueueRowData, g: Pick<GraphSnapshot, 'schema' | 'entities'>, moneyIds: ReadonlySet<string>): TriageRow {
  const { doc, need } = row;
  const type = row.typeLabel;
  const base = { ...row, suggestion: null as TriageRow['suggestion'], approvable: false };
  const kinds = new Set(doc.issues.map((i) => i.kind));
  const look = (chip: string): TriageRow => ({ ...base, group: 'look', chips: [type, chip] });

  if (need.groupKey === 'choose-type') return look('Pick a type');
  if (need.groupKey === 'nothing-read' || kinds.has('nothing-read')) return look('Hard to read');
  if (need.groupKey.startsWith('company:')) return look(need.groupLabel);
  if (kinds.has('suspect-value')) return look('Check a value');
  if (kinds.has('conflict')) return look('Two papers disagree');
  if (kinds.has('duplicate')) return look('Duplicate');
  if (unconfirmedDates(doc).length > 0) return look('Check the date');
  if (moneyIds.has(doc.id)) return look('Check the amounts');

  const missing = doc.issues.flatMap((i) => (i.kind === 'missing-field' ? [i.field] : []));
  if (missing.length > 0) {
    const labels = need.text?.startsWith('Needs: ') ? need.text.slice(7).split(', ') : missing;
    const shown = labels.slice(0, 2).map((l) => `No ${lower(l)}`);
    if (labels.length > 2) shown.push(`+${labels.length - 2}`);
    return { ...base, group: 'missing', chips: [type, ...shown] };
  }

  if (kinds.has('ambiguous-name-link')) {
    const a = doc.issues.find((i) => i.kind === 'ambiguous-name-link');
    const sur = a && a.kind === 'ambiguous-name-link' ? a.surname.charAt(0).toUpperCase() + a.surname.slice(1) : '';
    return { ...base, group: 'pick', chips: [type, sur ? `Which ${sur}?` : 'Which customer?'] };
  }
  if (kinds.has('unlinked')) {
    const s = linkSuggestions(doc, g.entities as Record<string, Entity>);
    if (s.length === 1) return { ...base, group: 'confirm', chips: [type, 'Not linked yet'], suggestion: { id: s[0]!.id, name: customerName(s[0]!), strong: strongLinkSuggestionIds(doc).includes(s[0]!.id) } };
    return { ...base, group: 'pick', chips: [type, s.length > 1 ? `${s.length} possible customers` : 'No customer yet'] };
  }

  if (isBulkApprovable(doc, g, moneyIds)) return { ...base, group: 'approve', chips: [type, 'Passed checks'], approvable: true };
  if (!doc.typeId) return look('Not sorted yet');
  return look('Needs a look');
}

/** Splits a (sorted) queue into the five action groups, in display order, empty groups left out. */
export function triageSections(rows: QueueRowData[], g: Pick<GraphSnapshot, 'schema' | 'entities'>, moneyIds: ReadonlySet<string>): Section<TriageRow>[] {
  const by = new Map<ActionGroupId, TriageRow[]>();
  for (const r of rows) {
    const t = triageRow(r, g, moneyIds);
    const list = by.get(t.group);
    if (list) list.push(t); else by.set(t.group, [t]);
  }
  return GROUP_ORDER.filter((id) => by.has(id)).map((id) => ({ key: id, label: GROUP_META[id].label, hint: GROUP_META[id].hint, items: by.get(id)! }));
}

/** The group shown open: the one a person chose if it still exists, else the one holding the selected paper, else the first. */
export function openGroupKey(sections: Section<unknown>[], chosen: string | null, selectedDocId: string | undefined, idsOf: (s: Section<unknown>) => string[]): string | null {
  if (chosen && sections.some((s) => s.key === chosen)) return chosen;
  if (selectedDocId) {
    const hit = sections.find((s) => idsOf(s).includes(selectedDocId));
    if (hit) return hit.key;
  }
  return sections[0]?.key ?? null;
}

/** Bulk "Link all with a clear match": only the confirm group AND only STRONG evidence (R6: name and street, or the exact name as a customer-label
 *  value), each paper to its own single suggestion. A weak suggestion (a name or a street alone) is never in a bulk set: one click at a time. */
export function bulkLinkPairs(rows: TriageRow[]): { docId: string; entityId: string; customer: string }[] {
  return rows.filter((r) => r.group === 'confirm' && r.suggestion && r.suggestion.strong).map((r) => ({ docId: r.doc.id, entityId: r.suggestion!.id, customer: r.suggestion!.name }));
}
/** One-at-a-time "Link": a person's own click on ONE paper's single suggestion (weak or strong; the person is the check). */
export function singleLinkPair(row: TriageRow): { docId: string; entityId: string; customer: string }[] {
  return row.group === 'confirm' && row.suggestion ? [{ docId: row.doc.id, entityId: row.suggestion.id, customer: row.suggestion.name }] : [];
}
/** Bulk "Approve all that passed checks": only the approve group (every check already passed). */
export function bulkApproveIds(rows: TriageRow[]): string[] {
  return rows.filter((r) => r.group === 'approve' && r.approvable).map((r) => r.doc.id);
}

/** Papers still open for the summary line: "N need you" (attention) and "M ready to approve". */
export function summaryCounts(sections: Section<TriageRow>[]) {
  const n = (id: ActionGroupId) => sections.find((s) => s.key === id)?.items.length ?? 0;
  const total = sections.reduce((a, s) => a + s.items.length, 0);
  return { total, ready: n('approve'), needYou: total - n('approve') };
}
