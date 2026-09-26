import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Sparkles } from 'lucide-react';
import { DocumentPreview } from '../DocumentPreview';
import type { SourceRef } from '../../core/types';
import {
  dismissIntakeQuestion,
  fetchIntakeQueue,
  resolveIntakeQuestion,
  snoozeIntakeQuestion,
  type IntakeCandidate,
  type IntakeQueueItem,
} from '../../services/intakeClient';
import { IntakeQueueCard } from './IntakeQueueCard';

const CURRENT_USER = 'You'; // matches ReviewScreen.tsx's own CURRENT_USER constant

function candidateArgs(c: IntakeCandidate): { value?: string; entityId?: string } {
  return c.kind === 'entity'
    ? { entityId: c.entityId ?? undefined, value: c.value ?? undefined }
    : { value: c.value ?? undefined };
}

/**
 * "Needs a decision" — the Inbox's third tab (Round 13, H2, research #2/#7). Everything here is
 * a real exception autofill.js could not resolve on its own: the header says how rarely that
 * happens (the straight-through-processing rate), and the queue below is every document still
 * waiting on the ONE precise question it was left with. Resolving a card removes it immediately
 * (optimistic — the server write already ran); the count and rate refresh on the next load.
 */
export function IntakeQueuePanel() {
  const [items, setItems] = useState<IntakeQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openDocumentCount, setOpenDocumentCount] = useState(0);
  const [stpRate, setStpRate] = useState<number | null>(null);
  const [totalDocs, setTotalDocs] = useState(0);
  const [tracked, setTracked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fieldBusy, setFieldBusy] = useState<{ id: string; key: string } | null>(null);
  const [preview, setPreview] = useState<SourceRef | null>(null);

  const load = useCallback(async (opts?: { cursor?: string | null; append?: boolean }) => {
    if (opts?.append) setLoadingMore(true);
    else setLoading(true);
    setErr(null);
    try {
      const res = await fetchIntakeQueue({ limit: 20, cursor: opts?.cursor ?? undefined });
      setStpRate(res.straightThroughRate);
      setTotalDocs(res.total);
      setTracked(res.needsInfoTracked && res.queue.tracked);
      setOpenDocumentCount(res.queue.openDocumentCount);
      setNextCursor(res.queue.nextCursor);
      setItems((prev) => (opts?.append ? [...prev, ...res.queue.items] : res.queue.items));
      setActiveId((cur) => {
        if (opts?.append) return cur;
        return res.queue.items[0]?.needsInfoId ?? null;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the queue.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeItem = (id: string) => {
    setItems((prev) => {
      const next = prev.filter((x) => x.needsInfoId !== id);
      setActiveId((cur) => (cur === id ? next[0]?.needsInfoId ?? null : cur));
      return next;
    });
    setOpenDocumentCount((n) => Math.max(0, n - 1));
  };

  const runResolve = async (item: IntakeQueueItem, args: { value?: string; entityId?: string }) => {
    if (busyId) return;
    setBusyId(item.needsInfoId);
    setErr(null);
    try {
      await resolveIntakeQuestion({ documentId: item.documentId, fieldKey: item.fieldKey, by: CURRENT_USER, ...args });
      removeItem(item.needsInfoId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That answer didn't save.");
    } finally {
      setBusyId(null);
    }
  };

  const runDismiss = async (item: IntakeQueueItem) => {
    if (busyId) return;
    setBusyId(item.needsInfoId);
    setErr(null);
    try {
      await dismissIntakeQuestion({ documentId: item.documentId, fieldKey: item.fieldKey, by: CURRENT_USER });
      removeItem(item.needsInfoId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not dismiss that question.");
    } finally {
      setBusyId(null);
    }
  };

  const runSnooze = async (item: IntakeQueueItem) => {
    if (busyId) return;
    setBusyId(item.needsInfoId);
    setErr(null);
    try {
      await snoozeIntakeQuestion({ documentId: item.documentId, fieldKey: item.fieldKey, by: CURRENT_USER });
      removeItem(item.needsInfoId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not snooze that question.");
    } finally {
      setBusyId(null);
    }
  };

  const runField = async (item: IntakeQueueItem, fieldKey: string, value: string) => {
    setFieldBusy({ id: item.needsInfoId, key: fieldKey });
    setErr(null);
    try {
      await resolveIntakeQuestion({ documentId: item.documentId, fieldKey, value, by: CURRENT_USER });
      await load(); // simplest correct refresh: this document's chip row and provenance may have changed
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That correction didn't save.");
    } finally {
      setFieldBusy(null);
    }
  };

  // Keyboard shortcuts (desktop): 1-9 picks the active card's Nth option, S snoozes it. Suspended
  // while typing in any text field so this never hijacks "Type it instead" or a field-fix input —
  // Enter there is handled locally by IntakeQueueCard/FieldConfidenceChips, not here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const active = items.find((i) => i.needsInfoId === activeId);
      if (!active || busyId) return;
      if (/^[1-9]$/.test(e.key)) {
        const c = active.candidates[Number(e.key) - 1];
        if (c) {
          e.preventDefault();
          void runResolve(active, candidateArgs(c));
        }
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void runSnooze(active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, activeId, busyId]);

  const pct = stpRate != null ? Math.round(stpRate * 100) : null;

  return (
    <div className="space-y-4">
      <header className="dw-card p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {loading ? (
          <span className="flex items-center gap-2 text-ink-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</span>
        ) : tracked ? (
          <>
            <span className="flex items-center gap-2 text-body-lg">
              <Sparkles className="w-4 h-4 text-ok-ink dark:text-ok-bg" aria-hidden="true" />
              {pct != null ? (
                <span><span className="font-semibold">{pct}%</span> of uploads needed no help{totalDocs ? <span className="text-ink-3"> · {totalDocs} processed</span> : null}</span>
              ) : (
                <span className="text-ink-3">No documents processed yet.</span>
              )}
            </span>
            <span className="text-body text-ink-2">
              <span className="font-semibold">{openDocumentCount}</span> document{openDocumentCount === 1 ? '' : 's'} need{openDocumentCount === 1 ? 's' : ''} a decision
            </span>
          </>
        ) : (
          <span className="text-ink-3">The exception queue isn't set up on this account yet.</span>
        )}
      </header>

      {err && (
        <div role="alert" className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warn-ink dark:text-brass-200" aria-hidden="true" />
          <p className="text-body text-warn-ink dark:text-brass-200 flex-1">{err}</p>
          <button type="button" onClick={() => setErr(null)} className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2 shrink-0">Dismiss</button>
        </div>
      )}

      {!loading && tracked && items.length === 0 && (
        <div className="dw-card p-8 text-center">
          <Check className="w-6 h-6 text-ok mx-auto" aria-hidden="true" />
          <p className="mt-2 text-ink-2">Nothing needs a decision right now. New uploads will show up here only if they truly need one.</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <>
          <p className="hidden sm:block text-caption text-ink-3">Shortcuts: 1–9 pick an option · S ask again later</p>
          <ul className="space-y-3" aria-label="Documents needing a decision">
            {items.map((item, i) => (
              <IntakeQueueCard
                key={item.needsInfoId}
                item={item}
                active={item.needsInfoId === activeId}
                shortcutIndex={i}
                busy={busyId === item.needsInfoId}
                fieldBusyKey={fieldBusy?.id === item.needsInfoId ? fieldBusy.key : null}
                onActivate={() => setActiveId(item.needsInfoId)}
                onPickCandidate={(c) => void runResolve(item, candidateArgs(c))}
                onTypeValue={(value) => void runResolve(item, { value })}
                onDismiss={() => void runDismiss(item)}
                onSnooze={() => void runSnooze(item)}
                onConfirmField={(fieldKey, value) => void runField(item, fieldKey, value)}
                onFixField={(fieldKey, value) => void runField(item, fieldKey, value)}
                onPreview={(documentId, page) => setPreview({ documentId, location: { page: page ?? 1 } })}
              />
            ))}
          </ul>
          {nextCursor && (
            <div className="text-center">
              <button type="button" className="dw-btn-secondary" disabled={loadingMore} onClick={() => void load({ cursor: nextCursor, append: true })}>
                {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
    </div>
  );
}
