import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Link2, Loader2, Search, Undo2, X } from 'lucide-react';
import type { Section } from '../../screens/reviewGrouping';
import { GROUP_META, bulkApproveIds, bulkLinkPairs, singleLinkPair, summaryCounts, type ActionGroupId, type TriageRow } from './inboxPlan';
import { approveMany, linkMany, undo, type UndoAction } from './inboxBulk';
import { useGraph } from '../../core/entityGraph';
import { TRIAGE_TEXT } from './inboxText';
import { useFieldSuggestionsFor } from './fieldSuggestStore';
import { chipText } from './fieldSuggestText';

const BY = 'You';

const Chip = ({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'ok' }) => (
  <span className={['inline-flex items-center rounded-full px-2 py-0.5 text-caption leading-tight whitespace-nowrap', tone === 'warn' ? 'bg-warn-bg text-warn-ink dark:bg-forest-800 dark:text-brass-200' : tone === 'ok' ? 'bg-ok-bg text-ok-ink dark:bg-forest-800 dark:text-ok-bg' : 'bg-surface-2 text-ink-2 border border-line'].join(' ')}>{children}</span>
);

interface RowProps {
  row: TriageRow;
  active: boolean;
  focusable: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onQuick: (row: TriageRow) => void;
  /** The first open AI field suggestion for this paper, shown as a "Suggested: <value>" chip (a person accepts it in the paper's panel). */
  fieldSuggestion?: { value?: string; options?: string[] };
}

const TriageItem = memo(function TriageItem({ row, active, focusable, busy, onSelect, onQuick, fieldSuggestion }: RowProps) {
  const quick = row.group === 'confirm' && row.suggestion ? TRIAGE_TEXT.link : row.group === 'approve' && row.approvable ? TRIAGE_TEXT.approve : null;
  const [first, ...rest] = row.chips;
  return (
    <li className={['flex items-stretch border-l-4 transition-colors duration-quick', active ? 'bg-forest-50 dark:bg-forest-800 border-forest-700 dark:border-brass-300' : 'border-transparent hover:bg-surface-2'].join(' ')}>
      <button
        type="button"
        data-doc-id={row.doc.id}
        tabIndex={focusable ? 0 : -1}
        onClick={() => onSelect(row.doc.id)}
        aria-current={active ? 'true' : undefined}
        title={row.doc.filename}
        className="min-w-0 flex-1 text-left px-3 sm:px-4 py-2.5 min-h-touch flex flex-col justify-center gap-1"
      >
        <span className="block truncate text-body-lg font-medium text-ink">{row.name}</span>
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-caption text-ink-3">{first}</span>
          {row.group === 'confirm' && row.suggestion
            ? <Chip tone="ok">{TRIAGE_TEXT.customer(row.suggestion.name)}</Chip>
            : rest.map((c) => <Chip key={c} tone={row.group === 'approve' ? 'ok' : 'warn'}>{c}</Chip>)}
          {fieldSuggestion && row.group === 'missing' && <Chip tone="ok">{chipText(fieldSuggestion)}</Chip>}
          {row.assignee && row.assignee !== 'Teammate' && <span className="text-caption text-ink-3">· {row.assignee}</span>}
        </span>
      </button>
      {quick ? (
        <div className="flex items-center pr-2 sm:pr-3 shrink-0">
          <button type="button" disabled={busy} onClick={() => onQuick(row)} className="dw-btn-secondary !min-h-[44px] !py-1 !px-3 " aria-label={row.suggestion ? `${quick} to ${row.suggestion.name}: ${row.name}` : `${quick}: ${row.name}`}>
            {row.group === 'confirm' ? <Link2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <Check className="w-4 h-4 shrink-0" aria-hidden="true" />}
            <span className="truncate">{quick}</span>
          </button>
        </div>
      ) : (
        <span className="flex items-center pr-3 text-ink-3" aria-hidden="true"><ChevronRight className="w-4 h-4" /></span>
      )}
    </li>
  );
});

export interface InboxTriageProps {
  sections: Section<TriageRow>[];
  openKey: string | null;
  onOpenKey: (key: string) => void;
  activeId: string | undefined;
  fallbackFocusId: string | undefined;
  onSelect: (id: string) => void;
  /** Rows drawn so far in the open group, and how many each "Show more" adds (kept by ReviewBody so keyboard moves can widen it). */
  cap: number;
  step: number;
  onShowMore: () => void;
  /** "Look again on the page" for a whole group (the existing free re-read); omitted when not allowed (not an admin, demo). */
  lookAgain?: { busy: boolean; run: (ids: string[]) => void };
}

/** One calm list: counts at the top, five action groups (one open at a time), safe bulk actions with a confirm and an Undo. */
export function InboxTriage({ sections, openKey, onOpenKey, activeId, fallbackFocusId, onSelect, cap, step, onShowMore, lookAgain }: InboxTriageProps) {
  const counts = summaryCounts(sections);
  const [confirm, setConfirm] = useState<null | { kind: 'link' | 'approve'; rows: TriageRow[] }>(null);
  const [working, setWorking] = useState<null | { done: number; total: number }>(null);
  const [last, setLast] = useState<null | { text: string; action: UndoAction | null }>(null);
  const busyRef = useRef(false);
  const graphDocs = useGraph((s) => s.docs);
  const suggestionsFor = useFieldSuggestionsFor(sections.find((s) => s.key === 'missing' && s.key === openKey)?.items.slice(0, cap).map((r) => r.doc.id) ?? []);

  const run = async (kind: 'link' | 'approve', rows: TriageRow[], single = false) => {
    if (busyRef.current || rows.length === 0) return;
    busyRef.current = true;
    setLast(null);
    setWorking({ done: 0, total: rows.length });
    try {
      const onProgress = (done: number) => setWorking({ done, total: rows.length });
      if (kind === 'link') {
        const pairs = single ? rows.flatMap(singleLinkPair) : bulkLinkPairs(rows);
        const r = await linkMany(pairs, BY, '', onProgress);
        const n = r.action.kind === 'link' ? r.action.items.length : 0;
        setLast({ text: r.failed ? TRIAGE_TEXT.partial(n, r.failed) : n === 1 ? TRIAGE_TEXT.linkedOne(pairs.find((p) => p.docId === (r.action.kind === 'link' ? r.action.items[0]?.docId : ''))?.customer ?? '') : TRIAGE_TEXT.linkedMany(n), action: n > 0 ? r.action : null });
      } else {
        const ids = bulkApproveIds(rows);
        const r = await approveMany(ids, BY, '', onProgress);
        const n = r.action.kind === 'approve' ? r.action.docIds.length : 0;
        setLast({ text: r.failed ? TRIAGE_TEXT.partial(n, r.failed) : n === 1 ? TRIAGE_TEXT.approvedOne : TRIAGE_TEXT.approvedMany(n), action: n > 0 ? r.action : null });
      }
    } finally {
      busyRef.current = false;
      setWorking(null);
    }
  };

  const doUndo = async () => {
    const a = last?.action;
    if (!a || busyRef.current) return;
    busyRef.current = true;
    setWorking({ done: 0, total: a.kind === 'link' ? a.items.length : a.docIds.length });
    try {
      const r = await undo(a, (done) => setWorking({ done, total: a.kind === 'link' ? a.items.length : a.docIds.length }));
      setLast({ text: TRIAGE_TEXT.undone(r.restored, r.leftAlone, r.failed), action: null });
    } finally {
      busyRef.current = false;
      setWorking(null);
    }
  };

  const quick = (row: TriageRow) => void run(row.group === 'confirm' ? 'link' : 'approve', [row], true);

  // Keyboard: "a" does the one-click action on the selected paper, "u" undoes the last one. (j / k / Enter live in ReviewBody.)
  const kb = useRef({ sections, openKey, activeId, quick, doUndo, canUndo: !!last?.action });
  useEffect(() => { kb.current = { sections, openKey, activeId, quick, doUndo, canUndo: !!last?.action }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      const c = kb.current;
      if (e.key === 'u' && c.canUndo) { e.preventDefault(); void c.doUndo(); return; }
      if (e.key === 'a' && c.activeId) {
        const row = c.sections.find((s) => s.key === c.openKey)?.items.find((r) => r.doc.id === c.activeId);
        if (row && (row.group === 'confirm' || row.approvable)) { e.preventDefault(); c.quick(row); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const busy = !!working;
  return (
    <div data-testid="inbox-triage">
      <div className="sticky top-0 z-10 bg-surface border-b border-line">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 sm:px-4 py-2.5">
          <p className="flex flex-wrap items-baseline gap-x-3" data-testid="triage-summary">
            <span className="font-sans text-h4 font-semibold text-ink">{TRIAGE_TEXT.summary(counts.total)}</span>
            {counts.total > 0 && counts.ready > 0 && counts.needYou > 0 && <span className="text-body text-ink-3">{TRIAGE_TEXT.summarySplit(counts.needYou, counts.ready)}</span>}
          </p>
          <p className="hidden lg:block text-caption text-ink-3">{TRIAGE_TEXT.shortcuts}</p>
        </div>
        {(working || last) && (
          <div role="status" className="flex items-center justify-between gap-2 px-3 sm:px-4 py-1.5 bg-surface-2 border-t border-line">
            <span className="flex items-center gap-2 text-body text-ink-2 min-w-0">
              {working ? <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" /> : <Check className="w-4 h-4 shrink-0 text-ok" aria-hidden="true" />}
              <span className="truncate">{working ? TRIAGE_TEXT.working(working.done, working.total) : last?.text}</span>
            </span>
            {!working && last && (
              <span className="flex items-center gap-1 shrink-0">
                {last.action && (
                  <button type="button" className="dw-btn-tertiary !min-h-[44px] !py-1" onClick={() => void doUndo()}><Undo2 className="w-4 h-4" aria-hidden="true" /> {TRIAGE_TEXT.undo}</button>
                )}
                <button type="button" aria-label="Dismiss" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-ink-3 hover:text-ink" onClick={() => setLast(null)}><X className="w-4 h-4" aria-hidden="true" /></button>
              </span>
            )}
          </div>
        )}
      </div>

      {sections.length === 0 && <p className="px-4 py-8 text-center text-ink-2">{TRIAGE_TEXT.empty}</p>}

      <ul aria-label="Groups to clear" className="divide-y divide-line">
        {sections.map((s) => {
          const open = s.key === openKey;
          const id = s.key as ActionGroupId;
          const shown = open ? s.items.slice(0, cap) : [];
          const bulkLink = id === 'confirm' ? bulkLinkPairs(s.items) : [];
          const bulkApprove = id === 'approve' ? bulkApproveIds(s.items) : [];
          return (
            <li key={s.key}>
              <h3 className="m-0">
                <button type="button" aria-expanded={open} aria-controls={`triage-${s.key}`} onClick={() => onOpenKey(s.key)} className="w-full flex items-center gap-2 px-3 sm:px-4 py-3 min-h-touch text-left hover:bg-surface-2">
                  {open ? <ChevronDown className="w-4 h-4 shrink-0 text-ink-3" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 shrink-0 text-ink-3" aria-hidden="true" />}
                  <span className="flex-1 min-w-0">
                    <span className="block font-sans text-body-lg font-semibold text-ink truncate">{GROUP_META[id].label}</span>
                    {open && <span className="block font-sans text-caption text-ink-3 font-normal">{GROUP_META[id].hint}</span>}
                  </span>
                  <span className="font-mono text-body text-ink-2 shrink-0">{s.items.length}</span>
                </button>
              </h3>
              {open && (
                <div id={`triage-${s.key}`}>
                  {(bulkLink.length > 1 || bulkApprove.length > 1 || (id === 'missing' && lookAgain && s.items.length > 0)) && (
                    <div className="flex flex-wrap gap-2 px-3 sm:px-4 pb-2">
                      {bulkLink.length > 1 && (
                        <button type="button" className="dw-btn-primary !min-h-[44px]" disabled={busy} onClick={() => setConfirm({ kind: 'link', rows: s.items })}><Link2 className="w-4 h-4" aria-hidden="true" /> {TRIAGE_TEXT.linkAll(bulkLink.length)}</button>
                      )}
                      {bulkApprove.length > 1 && (
                        <button type="button" className="dw-btn-primary !min-h-[44px]" disabled={busy} onClick={() => setConfirm({ kind: 'approve', rows: s.items })}><Check className="w-4 h-4" aria-hidden="true" /> {TRIAGE_TEXT.approveAll(bulkApprove.length)}</button>
                      )}
                      {id === 'missing' && lookAgain && (
                        <button type="button" className="dw-btn-secondary !min-h-[44px]" disabled={lookAgain.busy || busy} onClick={() => lookAgain.run(s.items.map((r) => r.doc.id))}>
                          {lookAgain.busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Search className="w-4 h-4" aria-hidden="true" />} {`Look again on the page for ${s.items.length === 1 ? 'this one' : `all ${s.items.length}`}`}
                        </button>
                      )}
                    </div>
                  )}
                  <ul className="divide-y divide-line border-t border-line">
                    {shown.map((r) => (
                      <TriageItem key={r.doc.id} row={r} active={r.doc.id === activeId} focusable={activeId ? r.doc.id === activeId : r.doc.id === fallbackFocusId} busy={busy} onSelect={onSelect} onQuick={quick} fieldSuggestion={id === 'missing' ? suggestionsFor(r.doc.id)[0] : undefined} />
                    ))}
                  </ul>
                  {s.items.length > cap && (
                    <div className="p-3 border-t border-line">
                      <button type="button" className="dw-btn-secondary !min-h-[44px]" onClick={onShowMore}>{TRIAGE_TEXT.showMore(Math.min(step, s.items.length - cap))}</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {confirm && createPortal(
        <div role="dialog" aria-modal="true" aria-label={confirm.kind === 'link' ? 'Link suggested' : 'Approve all'} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setConfirm(null)}>
          <div className="dw-card w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const n = confirm.kind === 'link' ? bulkLinkPairs(confirm.rows).length : bulkApproveIds(confirm.rows).length;
              const sample = confirm.kind === 'link' ? bulkLinkPairs(confirm.rows).slice(0, 4) : [];
              return (
                <>
                  <h2 className="text-h3">{confirm.kind === 'link' ? TRIAGE_TEXT.confirmLinkTitle(n) : TRIAGE_TEXT.confirmApproveTitle(n)}</h2>
                  <p className="text-body text-ink-2">{confirm.kind === 'link' ? TRIAGE_TEXT.confirmLinkBody : TRIAGE_TEXT.confirmApproveBody}</p>
                  {sample.length > 0 && (
                    <ul className="text-caption text-ink-3 space-y-0.5">
                      {sample.map((p) => <li key={p.docId} className="truncate">{graphDocs[p.docId] ? graphDocs[p.docId]!.displayName || graphDocs[p.docId]!.filename : p.docId} <span aria-hidden="true">→</span> {p.customer}</li>)}
                      {n > sample.length && <li>{TRIAGE_TEXT.more(n - sample.length)}</li>}
                    </ul>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="dw-btn-secondary !min-h-[44px]" onClick={() => setConfirm(null)}>{TRIAGE_TEXT.cancel}</button>
                    <button type="button" autoFocus className="dw-btn-primary !min-h-[44px]" onClick={() => { const c = confirm; setConfirm(null); void run(c.kind, c.rows); }}>{confirm.kind === 'link' ? `Link ${n}` : `Approve ${n}`}</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
