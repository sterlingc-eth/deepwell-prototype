import { useEffect, useState } from 'react';
import { Copy, Download, Loader2, Sparkles } from 'lucide-react';
import { STAGE_LABEL } from './StagePill';
import { IntegrityPanel } from './IntegrityPanel';
import { useGraph } from '../core/entityGraph';
import { healthTiles, type HealthSummary } from '../core/healthTiles';
import { recordsStore } from '../services/recordsStoreClient';
import { PIPELINE_STAGES } from '../core/types';
import { useAppStore } from '../store/appStore';
import { loadGraphFromServer } from '../hooks/usePostgresSync';
import { downloadExportCsv } from '../services/exportClient';
import { useCanAdmin, ASK_ADMIN_TITLE } from '../hooks/useCanAdmin';
import { AskAdminNote } from './AskAdminNote';

/** Safety cap on reclassify rounds: `reclassify` caps its own model calls per
 *  request, so a stubborn batch (no page text, model keeps saying 'other')
 *  could otherwise loop forever chewing through requests for no gain. */
const MAX_RECLASSIFY_ROUNDS = 5;

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

/**
 * Dashboard's "Data health" strip — the one place that answers "is my data
 * OK." Carries what used to be the standalone Records screen's health tiles,
 * stage bar, and its bulk re-check button (folded in here per the IA:
 * a shop owner doesn't think of "health metrics" as its own destination).
 */
export function DataHealthStrip() {
  const graph = useGraph();
  const openInboxNeedsPerson = useAppStore((s) => s.openInboxNeedsPerson);
  const canAdmin = useCanAdmin();
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const reclassifyDocs = useGraph((s) => s.reclassifyDocs);
  const aiVerifyDoc = useGraph((s) => s.aiVerifyDoc);

  // One source per tile: the shop-wide total, checked count, AI count and stage bar come from the server's summary
  // (re-fetched whenever the sync refreshes its counts); the "needs attention" tiles come from the graph, unverified only.
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    recordsStore.reviewSummary().then((r) => { if (!cancelled) setSummary(r); }).catch(() => { /* the sync's own counts stand in */ });
    return () => { cancelled = true; };
  }, [graph.serverCounts]);
  const t = healthTiles(graph, summary);
  const total = t.total;
  const counts = t.stages;
  const aiVerified = t.aiVerified;

  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const runExport = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      await downloadExportCsv('documents');
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'Could not download that export.');
    } finally {
      setExporting(false);
    }
  };

  // "Re-check all documents with AI": cleans up every synced document's type
  // (reviewStore.js's reclassifyDocuments touches legacy/null/'other' types
  // and may make a few cheap model calls for ones its heuristic can't place —
  // safe to re-run), then an AI-verify attempt on whatever still isn't
  // verified. Sequential on purpose — this is an occasional maintenance
  // action, not something to hammer the API with.
  const runReclassifyAndVerifyAll = async () => {
    setBulkRunning(true);
    setBulkProgress('Re-checking…');
    let ids = Object.keys(useGraph.getState().docs);
    let totalChanged = 0;
    for (let round = 0; round < MAX_RECLASSIFY_ROUNDS && ids.length > 0; round++) {
      let remaining = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { changed, remaining: r } = await reclassifyDocs(batch);
        totalChanged += changed;
        remaining += r;
        setBulkProgress(`Re-checking… round ${round + 1}, ${Math.min(i + batch.length, ids.length)}/${ids.length}`);
      }
      if (remaining === 0) break;
      ids = Object.values(useGraph.getState().docs).filter((d) => d.typeId === 'other').map((d) => d.id);
    }

    const toVerify = Object.values(useGraph.getState().docs).filter((d) => d.stage !== 'verified');
    let verified = 0;
    for (const doc of toVerify) {
      const ok = await aiVerifyDoc(doc.id);
      if (ok) verified += 1;
      setBulkProgress(`Verifying with AI… ${toVerify.indexOf(doc) + 1}/${toVerify.length}`);
    }

    // Re-sync from the server rather than trusting our own optimistic patches:
    // reclassify/aiVerify only ever set typeId/verifiedBy locally, never the
    // real backend `stage` those changes may have unlocked.
    setBulkProgress('Refreshing…');
    try {
      await loadGraphFromServer();
    } catch {
      /* best effort — the optimistic local state above still reflects the run */
    }

    const stillNeedAPerson = Object.values(useGraph.getState().docs).filter((d) => d.stage !== 'verified').length;
    setBulkProgress(`Re-checked ${totalChanged} · AI-verified ${verified} · Still need a person ${stillNeedAPerson}`);
    setBulkRunning(false);
  };

  const Stat = ({ label, value, sub, tone = 'default', onClick }: { label: string; value: string | number; sub?: string; tone?: 'default' | 'warn' | 'ok'; onClick?: () => void }) => {
    const inner = (
      <>
        <p className="text-caption text-ink-3">{label}</p>
        <p className={['font-display text-h1 mt-1', tone === 'warn' ? 'text-warn-ink dark:text-brass-200' : tone === 'ok' ? 'text-ok-ink dark:text-ok-bg' : ''].join(' ')}>{value}</p>
        {sub && <p className="text-body text-ink-3 mt-1">{sub}</p>}
      </>
    );
    return onClick ? (
      <button type="button" onClick={onClick} className="dw-card p-4 text-left hover:shadow-lift transition-shadow duration-quick">{inner}</button>
    ) : (
      <div className="dw-card p-4">{inner}</div>
    );
  };

  return (
    <section aria-labelledby="health-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="health-heading" className="dw-label">Data health</h2>
        <div className="flex flex-wrap items-center gap-2">
          {!DEMO_MODE && total > 0 && (
            <button type="button" className="dw-btn-secondary !min-h-[36px] !py-1.5" disabled={bulkRunning} onClick={() => void runReclassifyAndVerifyAll()}>
              <Sparkles className="w-4 h-4" aria-hidden="true" /> {bulkRunning ? 'Working…' : 'Re-check all documents with AI'}
            </button>
          )}
          {!DEMO_MODE && total > 0 && (
            <span className="inline-flex items-center gap-2">
              <button
                type="button"
                className="dw-btn-secondary !min-h-[36px] !py-1.5"
                disabled={!canAdmin || exporting}
                title={canAdmin ? undefined : ASK_ADMIN_TITLE}
                aria-describedby={canAdmin ? undefined : 'health-export-admin-note'}
                onClick={() => void runExport()}
              >
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} Export CSV
              </button>
              {!canAdmin && <AskAdminNote id="health-export-admin-note" />}
            </span>
          )}
          {bulkProgress && <span className="text-caption text-ink-3">{bulkProgress}</span>}
        </div>
      </div>
      {exportErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{exportErr}</p>}

      {!DEMO_MODE && <IntegrityPanel onApplied={() => void loadGraphFromServer()} />}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Documents" value={total} sub={`${t.checked} checked · ${t.checkedPct}%`} onClick={() => setCurrentScreen('browse')} />
        <Stat label="AI verified" value={aiVerified} sub={t.checked ? `${t.aiPctOfChecked}% of checked` : 'None yet'} tone={aiVerified ? 'ok' : 'default'} onClick={() => openInboxNeedsPerson()} />
        <Stat label="Needs linking" value={t.unlinked.text} sub={t.unlinked.value ? 'Target is zero' : t.partial ? 'None found so far' : 'Clear'} tone={t.unlinked.value ? 'warn' : 'ok'} onClick={() => openInboxNeedsPerson('unlinked')} />
        <Stat label="Missing info" value={t.gaps.text} sub={t.gaps.value ? 'Needs a person' : t.partial ? 'None found so far' : 'Clear'} tone={t.gaps.value ? 'warn' : 'ok'} onClick={() => openInboxNeedsPerson('gaps')} />
        <Stat label="Conflicts" value={t.conflicts.text} sub={t.conflicts.value ? 'Need a decision' : t.partial ? 'None found so far' : 'Clear'} tone={t.conflicts.value ? 'warn' : 'ok'} onClick={() => openInboxNeedsPerson('conflicts')} />
      </div>
      {t.duplicates.value > 0 && (
        <p className="flex items-center gap-2 text-body text-ink-2"><Copy className="w-4 h-4" aria-hidden="true" /> {t.duplicates.text} duplicate{t.duplicates.value === 1 ? '' : 's'} detected and held out of every count. <button type="button" className="underline underline-offset-4" onClick={() => openInboxNeedsPerson('duplicates')}>Merge</button></p>
      )}

      <div className="dw-card p-4">
        <div className="h-3 rounded-full overflow-hidden flex bg-surface-2" role="img" aria-label={PIPELINE_STAGES.map((s) => `${STAGE_LABEL[s]} ${counts[s]}`).join(', ')}>
          <span style={{ width: `${(counts.verified / Math.max(total, 1)) * 100}%` }} className="bg-ok" />
          <span style={{ width: `${(counts.linked / Math.max(total, 1)) * 100}%` }} className="bg-warn" />
          <span style={{ width: `${(counts.extracted / Math.max(total, 1)) * 100}%` }} className="bg-info" />
          <span style={{ width: `${((counts.classified + counts.received) / Math.max(total, 1)) * 100}%` }} className="bg-stone-300" />
        </div>
        <dl className="mt-3 grid grid-cols-5 gap-2 text-center">
          {PIPELINE_STAGES.map((s) => (
            <div key={s}>
              <dt className="text-caption text-ink-3">{STAGE_LABEL[s]}</dt>
              <dd className="font-display text-h3">{counts[s]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-caption text-ink-3 mt-2">A document must be Matched before Ask can use it (company files don’t need matching), and Checked before it counts as accurate.</p>
      </div>
    </section>
  );
}
