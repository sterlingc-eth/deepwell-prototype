import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, CircleHelp, ExternalLink, UserRound, Wrench } from 'lucide-react';
import { fmtMoney, formatYmd } from '../../core/answer';
import { isRecordSource, type GridCell, type GridCellSource, type GridColumnDef, type GridRow, type GridSort } from './types';

const RECORD_LABEL: Record<'customer' | 'unit', string> = { customer: 'customer record', unit: 'unit record' };

const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 36;
const OVERSCAN = 8;
/** Rough max height of a CellPopover (a few source rows + padding) — used
 *  only to decide whether it opens above or below its trigger button; see
 *  the `openUpward` comment at its only call site. */
const POPOVER_EST = 160;

function formatCell(col: GridColumnDef, cell: GridCell | undefined): string {
  const v = cell?.value;
  if (v == null || v === '') return '—';
  switch (col.kind) {
    case 'money': return typeof v === 'number' ? fmtMoney(v) : String(v);
    case 'date': return formatYmd(String(v));
    default: return String(v);
  }
}

/** A cell's source(s), rendered via a portal into document.body and
 *  positioned with `fixed` from the trigger button's own on-screen rect
 *  (`anchor`, captured at open time — see openCell in GridTable) — NOT as an
 *  absolutely-positioned descendant of the table. The table's row/cell area
 *  sits inside an `overflow-y-auto` scroll container for virtualization, and
 *  any plain descendant popover gets silently clipped to invisible there
 *  whenever it would extend outside that container's own scrolled box (a
 *  short table, the first or last row, or a row near either edge of the
 *  current scroll position) — clipped while its DOM node, computed style
 *  and getBoundingClientRect all still look perfectly normal, so this was
 *  caught only by actually looking at scripts/verify-grid-ui.mjs's
 *  screenshots, not by the automated checks (which just look for text in
 *  the DOM, present either way). A portal escapes that ancestor entirely. */
function CellPopover({
  col, cell, anchor, onOpen, onClose,
}: { col: GridColumnDef; cell: GridCell; anchor: DOMRect; onOpen: (s: GridCellSource) => void; onClose: () => void }) {
  const openUpward = anchor.bottom + POPOVER_EST > window.innerHeight;
  const style: CSSProperties = {
    position: 'fixed',
    left: Math.min(anchor.left, window.innerWidth - 256 - 8),
    ...(openUpward ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
  };
  return createPortal(
    <div
      role="dialog"
      aria-label={`Sources for ${col.label}`}
      className="fixed z-20 w-64 dw-card p-2 space-y-1 shadow-lg"
      style={style}
      onMouseLeave={onClose}
    >
      <p className="text-caption font-medium text-ink-3 uppercase tracking-wide">{col.label} — source{cell.sources.length === 1 ? '' : 's'}</p>
      {cell.sources.length === 0 && <p className="text-caption text-ink-3">Nothing on file for this cell.</p>}
      <ul className="space-y-0.5 max-h-48 overflow-y-auto">
        {cell.sources.map((s, i) => (
          <li key={isRecordSource(s) ? `${s.entityType}-${s.recordId}-${i}` : `${s.documentId}-${i}`}>
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-body text-left hover:bg-surface-2 text-ink-2"
              onClick={() => onOpen(s)}
            >
              {isRecordSource(s) ? (
                <span className="truncate text-caption flex items-center gap-1">
                  {s.entityType === 'customer' ? <UserRound className="w-3 h-3 shrink-0" aria-hidden="true" /> : <Wrench className="w-3 h-3 shrink-0" aria-hidden="true" />}
                  From {RECORD_LABEL[s.entityType]}
                </span>
              ) : (
                <span className="truncate font-mono text-caption">{s.documentId.slice(0, 8)}…{s.page != null ? ` p.${s.page}` : ''}</span>
              )}
              <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}

export function GridTable({
  columns, rows, sort, onSort, onOpenSource,
}: {
  columns: GridColumnDef[];
  rows: GridRow[];
  sort: GridSort | null;
  onSort: (column: string) => void;
  onOpenSource: (source: GridCellSource) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const [openCell, setOpenCell] = useState<{ row: number; col: string; anchor: DOMRect } | null>(null);

  const totalHeight = rows.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = useMemo(() => rows.slice(startIndex, endIndex), [rows, startIndex, endIndex]);

  return (
    // NOTE: no `overflow-hidden` on this outer wrapper (rounding is applied
    // to the header/body pieces individually instead) — belt-and-suspenders
    // with CellPopover's portal: nothing here should ever again depend on a
    // clipping ancestor sized just right for whatever happens to render
    // inside it.
    <div className="border border-line rounded-lg bg-surface">
      <div className="overflow-x-auto rounded-lg">
        <div className="min-w-max">
          {/* Sticky header — its own row, outside the virtualized/scrolling body so it never scrolls with the data. */}
          <div className="flex border-b border-line bg-surface-2 sticky top-0 z-10 rounded-t-lg" style={{ height: HEADER_HEIGHT }} role="row">
            {columns.map((c) => {
              const active = sort?.column === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="columnheader"
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => onSort(c.key)}
                  className="flex items-center gap-1 px-3 text-caption font-medium text-ink-3 uppercase tracking-wide shrink-0 w-40 hover:text-ink-2 text-left"
                >
                  <span className="truncate">{c.label}</span>
                  {active && (sort?.dir === 'asc' ? <ArrowUp className="w-3 h-3 shrink-0" aria-hidden="true" /> : <ArrowDown className="w-3 h-3 shrink-0" aria-hidden="true" />)}
                </button>
              );
            })}
          </div>

          {/* Virtualized body: only rows in [startIndex, endIndex) are ever in the DOM — the spacer
              divs above/below keep the scrollbar the size of the FULL row count (up to 5,000). */}
          <div
            ref={(el) => { scrollRef.current = el; if (el) setViewportH(el.clientHeight); }}
            className="overflow-y-auto rounded-b-lg"
            style={{ maxHeight: 480 }}
            onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); setOpenCell(null); }}
          >
            <div style={{ height: totalHeight, position: 'relative' }}>
              {visible.map((r, i) => {
                const rowIndex = startIndex + i;
                return (
                  <div
                    key={r.id}
                    role="row"
                    className="flex border-b border-line hover:bg-surface-2 absolute left-0 right-0"
                    style={{ top: rowIndex * ROW_HEIGHT, height: ROW_HEIGHT }}
                  >
                    {columns.map((c) => {
                      const cell = r.cells[c.key];
                      const hasSources = (cell?.sources.length ?? 0) > 0;
                      // A non-null value with no source is never left looking
                      // like a cited one (indistinguishable = misleading) —
                      // every grid.js cell path attaches a document or record
                      // source whenever it has a value, but this stays as a
                      // visible, honest fallback for any path that doesn't.
                      const isUncited = cell?.value != null && !hasSources;
                      const isOpen = openCell?.row === rowIndex && openCell.col === c.key;
                      return (
                        <div key={c.key} className="relative px-3 flex items-center shrink-0 w-40 text-body text-ink-2 truncate">
                          {c.kind === 'badge' && cell?.value ? (
                            <span className="dw-pill-muted truncate">{formatCell(c, cell)}</span>
                          ) : (
                            <span className="truncate" title={formatCell(c, cell)}>{formatCell(c, cell)}</span>
                          )}
                          {hasSources && (
                            <button
                              type="button"
                              aria-label={`Show source for ${c.label}, row ${rowIndex + 1}`}
                              aria-expanded={isOpen}
                              className="ml-1 text-ink-3 hover:text-ink shrink-0"
                              onClick={(e) => setOpenCell(isOpen ? null : { row: rowIndex, col: c.key, anchor: e.currentTarget.getBoundingClientRect() })}
                            >
                              <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            </button>
                          )}
                          {isUncited && (
                            <span
                              aria-label={`${c.label}, row ${rowIndex + 1}: not tied to a document or record`}
                              title="Not tied to a document or record"
                              className="ml-1 text-ink-3/60 shrink-0"
                            >
                              <CircleHelp className="w-3 h-3" aria-hidden="true" />
                            </span>
                          )}
                          {isOpen && cell && (
                            <CellPopover
                              col={c}
                              cell={cell}
                              anchor={openCell.anchor}
                              onClose={() => setOpenCell(null)}
                              onOpen={(s) => { setOpenCell(null); onOpenSource(s); }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
