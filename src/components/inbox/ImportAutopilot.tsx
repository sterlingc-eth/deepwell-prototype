import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Undo2 } from 'lucide-react';
import { reviewClient, type ImportDecision, type ImportListItem, type ImportPlan, type ImportSettings } from '../../services/reviewClient';
import { IMPORT_TEXT as T, typeName } from './importText';
import { runDecision } from './importApplyRun';

const BY = 'You';
const POLL_MS = 6000;
const SHOW_FIRST = 5; // decision cards shown before "Show more"

type Done = { runId: string; applied: number; skipped: number; undone?: { n: number; left: number } };
type Pending = { id: string; choice?: string } | null;

const errText = (e: unknown, fallback: string) => {
  const m = String((e as Error)?.message ?? '');
  return /only an owner|admin|403/i.test(m) ? T.settings.denied : /no longer|changed|409/i.test(m) ? T.gone : fallback;
};

const pct = (c: { total: number; filed: number }) => (c.total > 0 ? Math.round((c.filed / c.total) * 100) : 0);

/**
 * Bulk import autopilot, shown at the top of the Inbox when a big drop (20 or more papers) is being read or has decisions waiting.
 * The server groups the papers and re-checks every one at the moment of the press; this component only shows the groups and presses.
 */
export function ImportAutopilot({ onOpenList }: { onOpenList: () => void }) {
  const [imports, setImports] = useState<ImportListItem[] | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, Done>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const filing = useRef(false);

  const loadPlan = useCallback(async (id: string, fresh = false) => {
    try { setPlan(await reviewClient.importPlan(id, fresh)); } catch { /* keep what is on screen */ }
  }, []);

  useEffect(() => {
    let live = true;
    reviewClient.importList().then((r) => {
      if (!live) return;
      setImports(r.imports);
      setBatchId(r.imports[0]?.batchId ?? null);
    }).catch(() => { if (live) setImports([]); });
    return () => { live = false; };
  }, []);

  useEffect(() => { if (batchId) void loadPlan(batchId); }, [batchId, loadPlan]);

  // file what passes (no click) and keep the numbers moving while papers are still being read
  const inProgress = plan?.counts.inProgress ?? 0;
  useEffect(() => {
    if (!batchId || !plan) return;
    let live = true;
    const tick = async () => {
      if (plan.autoFileOn && plan.counts.eligible > 0 && !filing.current) {
        filing.current = true;
        try {
          for (let i = 0; i < 60 && live; i++) {
            const r = await reviewClient.importAutoFile(batchId);
            if (r.off || r.filed === 0 || r.remaining === 0) break;
          }
        } catch { /* the nightly sweep will pick it up */ } finally { filing.current = false; }
      }
      if (live) await loadPlan(batchId, true);
    };
    if (inProgress === 0 && !(plan.autoFileOn && plan.counts.eligible > 0)) return;
    const t = setTimeout(() => void tick(), plan.counts.eligible > 0 ? 50 : POLL_MS);
    return () => { live = false; clearTimeout(t); };
  }, [batchId, plan, inProgress, loadPlan]);

  if (!imports || !batchId || !plan) return null;
  const c = plan.counts;
  const nothingToShow = c.total === 0;
  if (nothingToShow) return null;
  const paused = imports.find((i) => i.batchId === batchId)?.paused ?? false;
  const open = plan.decisions.length > 0 || plan.lookAt.count > 0 || inProgress > 0;
  const running = inProgress > 0;

  const apply = async (d: ImportDecision, choice?: string) => {
    if (busy) return;
    setBusy(d.id); setMsg(null);
    try {
      const r = await runDecision((args) => reviewClient.importApply(args), batchId, d, choice, BY);
      if (r.runId && r.applied > 0) setDone((x) => ({ ...x, [d.id]: { runId: r.runId as string, applied: r.applied, skipped: r.skipped } }));
      if (r.partial) setMsg(T.stoppedPart(r.applied, r.total));
      else if (r.error) setMsg(errText(r.error, T.error));
      else if (r.applied === 0) setMsg(T.doneApplied(0, r.skipped));
    } catch (e) { setMsg(errText(e, T.error)); }
    finally { setBusy(null); setPending(null); await loadPlan(batchId, true); }
  };

  const undo = async (d: ImportDecision, dn: Done) => {
    if (busy) return;
    setBusy(d.id); setMsg(null);
    try {
      let n = 0; let left = 0;
      for (let i = 0; i < 40; i++) {
        const r = await reviewClient.importUndoDecision(batchId, dn.runId);
        n += r.undone; left = r.left;
        if (!r.more) break;
      }
      setDone((x) => ({ ...x, [d.id]: { ...dn, undone: { n, left } } }));
    } catch (e) { setMsg(errText(e, T.error)); }
    finally { setBusy(null); await loadPlan(batchId, true); }
  };

  const undoAll = async () => {
    if (busy) return;
    if (!window.confirm(T.settings.undoAllConfirm(c.filedAutomatically))) return;
    setBusy('undo-all'); setMsg(null);
    try {
      let n = 0;
      for (let i = 0; i < 60; i++) { const r = await reviewClient.importUndoAutoFile(batchId); n += r.undone; if (!r.more) break; }
      setMsg(T.settings.undoAllDone(n));
      setImports((l) => l && l.map((x) => (x.batchId === batchId ? { ...x, paused: true } : x)));
    } catch (e) { setMsg(errText(e, T.error)); }
    finally { setBusy(null); await loadPlan(batchId, true); }
  };

  const resume = async () => {
    setBusy('resume');
    try { await reviewClient.importResume(batchId); setImports((l) => l && l.map((x) => (x.batchId === batchId ? { ...x, paused: false } : x))); }
    catch (e) { setMsg(errText(e, T.error)); }
    finally { setBusy(null); await loadPlan(batchId, true); }
  };

  const setSetting = async (on: boolean) => {
    setBusy('setting'); setMsg(null);
    try { const s: ImportSettings = await reviewClient.importSettings({ autoFileImports: on }); setPlan((p) => (p ? { ...p, settings: s, autoFileOn: s.autoFileImports && !s.pausedBatches.includes(batchId) } : p)); setMsg(T.settings.save); }
    catch (e) { setMsg(errText(e, T.error)); }
    finally { setBusy(null); await loadPlan(batchId, true); }
  };

  return (
    <section aria-label={T.summaryTitle} className="dw-card p-4 sm:p-5 space-y-4" data-testid="import-autopilot">
      <div className="space-y-2">
        <h2 className="text-h3">{running ? T.progressTitle({ total: c.total, filed: c.filed, needYou: c.needYou, inProgress }) : T.summaryLine(plan.summary)}</h2>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(c)} aria-label={T.progressTitle({ total: c.total, filed: c.filed, needYou: c.needYou, inProgress })} className="h-2 rounded-full bg-surface-2 overflow-hidden">
          <div className="h-full bg-forest-700 dark:bg-brass-300 transition-all" style={{ width: `${pct(c)}%` }} />
        </div>
        {running ? (
          <p className="text-body text-ink-2 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{T.stillReading} <span className="text-ink-3">{T.summaryLine(plan.summary)}</span></p>
        ) : !open ? (
          <p className="text-body text-ink-2 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-forest-700 dark:text-brass-300" aria-hidden="true" />{T.allDone}</p>
        ) : null}
      </div>

      {msg && <p role="status" className="text-caption text-ink-2">{msg}</p>}

      {plan.decisions.length > 0 && (
        <div className="space-y-3">
          <div>
            <h3 className="text-h4">{T.decisionsHeading}</h3>
            <p className="text-caption text-ink-3">{T.decisionsHelp}</p>
          </div>
          <ul className="space-y-3">
            {(showAll ? plan.decisions : plan.decisions.slice(0, SHOW_FIRST)).map((d) => <DecisionCard key={d.id} d={d} busy={busy === d.id} locked={busy !== null} pending={pending?.id === d.id ? pending : null} onAsk={(choice) => setPending({ id: d.id, choice })} onCancel={() => setPending(null)} onApply={(choice) => void apply(d, choice)} />)}
          </ul>
          {plan.decisions.length > SHOW_FIRST && (
            <button type="button" className="dw-btn-secondary !min-h-[44px]" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? T.showFewer : T.showMore(plan.decisions.length - SHOW_FIRST)}</button>
          )}
        </div>
      )}

      {Object.entries(done).map(([id, dn]) => (
        <DoneRow key={id} id={id} dn={dn} busy={busy === id} locked={busy !== null} onUndo={() => void undo({ id, kind: id.split(':')[0] as ImportDecision['kind'], params: {}, count: dn.applied, samples: [], documentIds: [] }, dn)} />
      ))}

      {plan.lookAt.count > 0 && (
        <div className="space-y-2 border-t border-line pt-3">
          <h3 className="text-h4">{T.lookAtHeading} <span className="font-mono text-caption text-ink-3">{plan.lookAt.count.toLocaleString('en-US')}</span></h3>
          <p className="text-caption text-ink-3">{T.lookAtHelp}</p>
          <ul className="flex flex-wrap gap-1.5">
            {plan.lookAt.reasons.slice(0, 6).map((r) => (
              <li key={r.reason} className="rounded-full border border-line px-2.5 py-1 text-caption text-ink-2">{T.reason[r.reason] ?? T.reason.other} <span className="font-mono">{r.count.toLocaleString('en-US')}</span></li>
            ))}
          </ul>
          <button type="button" className="dw-btn-secondary !min-h-[44px]" onClick={onOpenList}>{T.lookAtOpen}</button>
        </div>
      )}

      <div className="border-t border-line pt-3 space-y-2">
        <button type="button" aria-expanded={showSettings} className="dw-btn-tertiary !min-h-[44px] !px-2" onClick={() => setShowSettings((v) => !v)}>{T.settings.label}: {plan.settings.autoFileImports ? T.toggleOn : T.toggleOff}</button>
        {showSettings && (
          <div className="space-y-2">
            <label className="flex items-start gap-3 min-h-[44px]">
              <input type="checkbox" className="mt-1 w-5 h-5" checked={plan.settings.autoFileImports} disabled={busy !== null} onChange={(e) => void setSetting(e.target.checked)} />
              <span><span className="block text-ink">{T.settings.label}</span><span className="block text-caption text-ink-3">{T.settings.help}</span></span>
            </label>
            {c.filedAutomatically > 0 && !paused && (
              <button type="button" className="dw-btn-secondary !min-h-[44px]" disabled={busy !== null} onClick={() => void undoAll()}><Undo2 className="w-4 h-4" aria-hidden="true" /> {T.settings.undoAll}</button>
            )}
            {paused && (
              <p className="text-caption text-ink-2">{T.settings.paused} <button type="button" className="underline min-h-[44px] px-1" disabled={busy !== null} onClick={() => void resume()}>{T.settings.resume}</button></p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function DoneRow({ id, dn, busy, locked, onUndo }: { id: string; dn: Done; busy: boolean; locked: boolean; onUndo: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2" data-testid={`decision-done-${id}`}>
      <CheckCircle2 className="w-4 h-4 text-forest-700 dark:text-brass-300" aria-hidden="true" />
      <p role="status" className="text-body text-ink flex-1 min-w-[12rem]">
        {dn.undone ? T.undone(dn.undone.n) + (dn.undone.left ? ' ' + T.undoneLeft(dn.undone.left) : '') : T.doneApplied(dn.applied, dn.skipped)}
      </p>
      {!dn.undone && <button type="button" className="dw-btn-secondary !min-h-[44px]" disabled={locked} onClick={onUndo}>{busy ? T.working : <><Undo2 className="w-4 h-4" aria-hidden="true" /> {T.undo}</>}</button>}
    </div>
  );
}

function DecisionCard({ d, busy, locked, pending, onAsk, onCancel, onApply }: { d: ImportDecision; busy: boolean; locked: boolean; pending: Pending; onAsk: (choice?: string) => void; onCancel: () => void; onApply: (choice?: string) => void }) {
  const k = T.kind[d.kind];
  const [a, b] = d.params.options ?? [];
  const title =
    d.kind === 'link-suggested' ? T.kind['link-suggested'].title(d.count, d.params.customerName ?? '')
    : d.kind === 'create-customer' ? T.kind['create-customer'].title(d.count, d.params.name ?? '')
    : d.kind === 'choose-type' ? T.kind['choose-type'].title(d.count, typeName(a), typeName(b))
    : d.kind === 'use-invoice-date' ? T.kind['use-invoice-date'].title(d.count)
    : d.kind === 'set-aside-copies' ? T.kind['set-aside-copies'].title(d.count)
    : T.kind['file-passed'].title(d.count);
  const buttons: { label: string; choice?: string }[] =
    d.kind === 'choose-type' ? [a, b].filter(Boolean).map((t) => ({ label: T.kind['choose-type'].button(d.count, typeName(t)), choice: t }))
    : [{ label: (k.button as (n: number) => string)(d.count) }];
  return (
    <li className="rounded-lg border border-line bg-surface p-3 sm:p-4 space-y-3" data-testid="import-decision">
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-caption text-ink-3">{k.why}</p>
      </div>
      <div>
        <p className="text-caption text-ink-3">{T.samplesLabel}</p>
        <ul className="mt-1 space-y-1">
          {d.samples.map((s) => (
            <li key={s.documentId} className="text-body text-ink-2 min-w-0">
              <span className="block truncate text-ink">{s.name}</span>
              <span className="block truncate text-caption text-ink-3">{d.kind === 'choose-type' ? `Saved as ${typeName(s.typeId)}` : s.note}</span>
            </li>
          ))}
          {d.count > d.samples.length && <li className="text-caption text-ink-3">{T.moreInGroup(d.count - d.samples.length)}</li>}
        </ul>
      </div>
      {pending ? (
        <div role="group" aria-label={T.confirmTitle(d.count)} className="rounded-md bg-surface-2 p-3 space-y-2">
          <p className="font-medium text-ink">{T.confirmTitle(d.count)}{pending.choice ? ` (${typeName(pending.choice)})` : ''}</p>
          <p className="text-caption text-ink-2">{T.confirmBody}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" autoFocus className="dw-btn-primary !min-h-[44px]" disabled={locked} onClick={() => onApply(pending.choice)}>{busy ? T.working : T.confirm}</button>
            <button type="button" className="dw-btn-secondary !min-h-[44px]" disabled={busy} onClick={onCancel}>{T.cancel}</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {buttons.map((bt) => <button key={bt.label} type="button" className="dw-btn-primary !min-h-[44px]" disabled={locked} onClick={() => onAsk(bt.choice)}>{bt.label}</button>)}
        </div>
      )}
    </li>
  );
}
