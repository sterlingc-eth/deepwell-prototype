import { useId, useMemo, useState } from 'react';
import { ChevronDown, FileText, Receipt, Search, User, Wrench, X } from 'lucide-react';
import type { AnswerRecord, SourceRef } from '../core/types';
import { filterRecords, recordGroups, recordsHeading } from '../core/citations';

const ICON = { customer: User, unit: Wrench, document: FileText, invoice: Receipt } as const;
const TYPE_WORD = { customer: 'Customer', unit: 'Equipment', document: 'Document', invoice: 'Invoice' } as const;

interface RecordsPanelProps {
  records: AnswerRecord[];
  total: number;
  kind: 'basis' | 'searched';
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Breakdown filter, lifted to AnswerCard so a clicked breakdown row can drive it. */
  group: string | null;
  onGroupChange: (group: string | null) => void;
  onOpenRecord: (record: AnswerRecord) => void;
  /** A customer/unit record's own supporting document (e.g. a warranty registration) — records carry
   *  `documentId` when there is one to show. Optional: omitted, rows just carry no source affordance. */
  onOpenSource?: (ref: SourceRef) => void;
}

/**
 * "Based on 19 customers · view": the exact rows an aggregate answer was computed from. Collapsed by
 * default (one compact line); expands to a searchable list grouped by the breakdown key. A row opens
 * the customer profile, a unit's customer, or the document at the cited page. Fully keyboard operable:
 * the disclosure and every row are real buttons, Escape in the search box clears it.
 */
export function RecordsPanel({ records, total, kind, open, onToggle, group, onGroupChange, onOpenRecord, onOpenSource }: RecordsPanelProps) {
  const [query, setQuery] = useState('');
  const uid = useId();
  const panelId = `${uid}-records`;
  const groups = useMemo(() => recordGroups(records), [records]);
  const shown = useMemo(() => filterRecords(records, query, group), [records, query, group]);
  const heading = recordsHeading({ records, recordsTotal: total, recordsKind: kind });
  const capped = total > records.length;

  return (
    <section aria-label="Records behind this answer" data-testid="records-panel">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-1.5 min-h-[32px] text-body text-ink-2 hover:text-ink underline decoration-line-2 underline-offset-4 hover:decoration-forest-700 dark:hover:decoration-brass-300"
      >
        <span>{heading}</span>
        <span aria-hidden="true">·</span>
        <span>{open ? 'hide' : 'view'}</span>
        <ChevronDown className={['w-4 h-4 transition-transform duration-quick', open ? 'rotate-180' : ''].join(' ')} aria-hidden="true" />
      </button>

      {open && (
        <div id={panelId} className="mt-2 border border-line rounded-lg bg-surface">
          <div className="flex flex-wrap items-center gap-2 p-2 border-b border-line">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                placeholder="Search these records"
                aria-label="Search these records"
                className="dw-input !min-h-[36px] !py-1 !pl-8 text-body"
              />
            </div>
            {groups.length > 1 && (
              <label className="inline-flex items-center gap-1.5 text-caption text-ink-3">
                <span>Group</span>
                <select
                  value={group ?? ''}
                  onChange={(e) => onGroupChange(e.target.value === '' ? null : e.target.value)}
                  aria-label="Filter records by group"
                  className="dw-input !min-h-[36px] !py-1 !w-auto text-body"
                >
                  <option value="">All ({groups.length})</option>
                  {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>
            )}
            {group !== null && (
              <button type="button" onClick={() => onGroupChange(null)} className="inline-flex items-center gap-1 text-caption text-ink-2 hover:text-ink min-h-[32px]">
                <X className="w-3.5 h-3.5" aria-hidden="true" /> Clear filter
              </button>
            )}
          </div>

          <p className="px-3 pt-2 text-caption text-ink-3" aria-live="polite">
            {shown.length === records.length
              ? `${records.length} shown`
              : `${shown.length} of ${records.length} shown`}
            {capped ? ` · the list is capped at ${records.length} of ${total}` : ''}
          </p>

          {shown.length === 0 ? (
            <p className="px-3 py-3 text-body text-ink-3">No records match that.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-line">
              {shown.map((r, i) => {
                const Icon = ICON[r.type];
                // A customer/unit record's own supporting document (e.g. a warranty registration) —
                // owner report (2026-09-25): "SOURCES · 0" should never appear when a record like this
                // one actually has a document behind it; show it here instead.
                const hasOwnSource = (r.type === 'customer' || r.type === 'unit') && Boolean(r.documentId) && Boolean(onOpenSource);
                return (
                  <li key={`${r.type}-${r.id}-${r.group ?? ''}-${r.page ?? ''}-${i}`} className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => onOpenRecord(r)}
                      aria-label={`Open ${TYPE_WORD[r.type].toLowerCase()}: ${r.label}${r.page ? `, page ${r.page}` : ''}`}
                      className="flex-1 min-w-0 text-left flex items-start gap-2.5 px-3 py-2 min-h-[44px] hover:bg-surface-2 transition-colors duration-quick"
                    >
                      <Icon className="w-4 h-4 mt-1 shrink-0 text-ink-3" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body text-ink truncate">{r.label}</span>
                        {(r.sublabel || r.page) && (
                          <span className="block text-caption text-ink-3 truncate">
                            {[r.sublabel, r.page ? `p. ${r.page}` : null].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </span>
                      {r.group !== undefined && group === null && groups.length > 1 && (
                        <span className="dw-pill-muted shrink-0 max-w-[10rem] truncate">{r.group}</span>
                      )}
                    </button>
                    {hasOwnSource && (
                      <button
                        type="button"
                        onClick={() => onOpenSource?.({ documentId: r.documentId as string, location: r.page ? { page: r.page } : { field: 'document' } })}
                        aria-label={`Open the source document for ${r.label}`}
                        title="Open source document"
                        className="shrink-0 self-stretch px-3 grid place-items-center text-ink-3 hover:text-ink hover:bg-surface-2 border-l border-line transition-colors duration-quick"
                      >
                        <FileText className="w-4 h-4" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
