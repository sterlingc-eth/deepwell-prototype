/**
 * The Inbox "Needs you" filter chips — split out of ReviewScreen.tsx (round
 * 17 merge, InboxScreen.tsx) purely so this pure data can be imported by
 * both ReviewScreen.tsx and InboxScreen.tsx without either file mixing a
 * component export with a plain data export (oxlint's react/only-export-
 * components — Fast Refresh only works when a file exports only
 * components). No behavior change: same 9 filters, same labels, same order.
 */
export type Filter = 'attention' | 'gaps' | 'unlinked' | 'conflicts' | 'duplicates' | 'ready' | 'shop-records' | 'money' | 'all';

export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'attention', label: 'Needs a person' },
  { id: 'gaps', label: 'Missing info' },
  { id: 'unlinked', label: 'Needs linking' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'ready', label: 'Ready to verify' },
  // Round 4 (2026-09-21): shop-internal documents (parts counts, dispatch
  // notes, memos to all techs — api/_lib/documentTypes.js's 'internal' type)
  // are AI-verified on extraction (isShopInternalDocument) and so never show
  // under "Needs a person" (isAttention requires stage !== 'verified'). This
  // chip is the only place left to find them, rather than nowhere at all.
  { id: 'shop-records', label: 'Company files' },
  // Financials layer: invoices/quotes whose printed numbers don't add up (or were read with low confidence).
  { id: 'money', label: 'Money to check' },
  { id: 'all', label: 'All' },
];

export const FILTER_IDS = FILTERS.map((f) => f.id);
