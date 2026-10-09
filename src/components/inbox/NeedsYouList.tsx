import { memo } from 'react';
import { Bell } from 'lucide-react';
import { StagePill } from '../StagePill';
import type { Doc } from '../../core/types';
import type { NeedInfo, Section } from '../../screens/reviewGrouping';

export interface QueueRowData {
  doc: Doc;
  name: string;
  /** Second line: document type plus the original file name. */
  sub: string;
  typeLabel: string;
  need: NeedInfo;
  assignee: string | null;
  hasReminder: boolean;
  technician: string | null;
}

interface RowProps {
  row: QueueRowData;
  active: boolean;
  /** Roving tab stop: exactly one row is reachable with Tab. */
  focusable: boolean;
  onSelect: (id: string) => void;
}

const QueueRow = memo(function QueueRow({ row, active, focusable, onSelect }: RowProps) {
  const { doc } = row;
  return (
    <li>
      <button
        type="button"
        data-doc-id={doc.id}
        tabIndex={focusable ? 0 : -1}
        onClick={() => onSelect(doc.id)}
        aria-current={active ? 'true' : undefined}
        className={[
          'w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch transition-colors duration-quick border-l-4',
          active ? 'bg-forest-50 dark:bg-forest-800 border-forest-700 dark:border-brass-300' : 'border-transparent hover:bg-surface-2',
        ].join(' ')}
      >
        <StagePill stage={doc.stage} compact />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-data text-ink truncate">{row.name}</span>
          <span className="block text-body text-ink-3 truncate">{row.sub}</span>
          {row.need.text && <span className="block text-body text-warn-ink dark:text-brass-200 truncate">{row.need.text}</span>}
        </span>
        {row.assignee && <span className="dw-pill-muted shrink-0 text-caption">{row.assignee}</span>}
        {row.hasReminder && (
          <span className="dw-pill-muted shrink-0 text-caption flex items-center gap-1" title="Has a reminder">
            <Bell className="w-3 h-3" aria-hidden="true" />
          </span>
        )}
        {row.technician && <span className="dw-pill-muted shrink-0 text-caption">{row.technician}</span>}
      </button>
    </li>
  );
});

interface ListProps {
  sections: Section<QueueRowData>[];
  /** Rows rendered so far across all sections (the rest wait behind "Show more"). */
  cap: number;
  total: number;
  activeId: string | undefined;
  /** First rendered row id, used as the Tab stop when the selected row is not in this list. */
  fallbackFocusId: string | undefined;
  onSelect: (id: string) => void;
  onShowMore: () => void;
  step: number;
}

/** Sectioned, capped list. Sections carry small sticky headers with their full counts. */
export function NeedsYouList({ sections, cap, total, activeId, fallbackFocusId, onSelect, onShowMore, step }: ListProps) {
  let left = cap;
  const shown: { section: Section<QueueRowData>; rows: QueueRowData[] }[] = [];
  for (const s of sections) {
    if (left <= 0) break;
    const rows = s.items.length <= left ? s.items : s.items.slice(0, left);
    left -= rows.length;
    shown.push({ section: s, rows });
  }
  const rendered = cap < total ? cap : total;
  return (
    <>
      <ul aria-label="Documents in queue" className="min-w-0">
        {shown.map(({ section, rows }) => (
          <li key={section.key}>
            <h3 className="sticky top-0 z-10 flex items-baseline justify-between gap-2 px-4 py-2 bg-surface-2 border-b border-line first:border-t-0">
              <span className="truncate text-body font-semibold text-ink">{section.label}</span>
              <span className="font-mono text-caption text-ink-3 shrink-0">{section.items.length}</span>
            </h3>
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <QueueRow key={r.doc.id} row={r} active={r.doc.id === activeId} focusable={activeId ? r.doc.id === activeId : r.doc.id === fallbackFocusId} onSelect={onSelect} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {total > rendered && (
        <div className="p-3 border-t border-line flex flex-wrap items-center justify-between gap-2">
          <span className="text-caption text-ink-3">Showing {rendered} of {total}</span>
          <button type="button" className="dw-btn-secondary !min-h-[44px]" onClick={onShowMore}>
            Show more ({Math.min(step, total - rendered)})
          </button>
        </div>
      )}
    </>
  );
}
