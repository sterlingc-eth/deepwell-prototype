import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { recordsStore, type ImportProgressSummary } from '../../services/recordsStoreClient';
import { loadGraphFromServer } from '../../hooks/usePostgresSync';
import { useGraph } from '../../core/entityGraph';
import { useAppStore } from '../../store/appStore';
import { fmtCount, formatTimeLeft, minutesLeft } from '../../core/importProgress';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';
/** While documents are being read: check every 5 seconds. Otherwise once a minute, to notice an import started elsewhere. */
const FAST_MS = 5_000;
const IDLE_MS = 60_000;
/** The pipeline tiles and Needs you come from the loaded records; reload them this often during an import, and once at the end. */
const GRAPH_REFRESH_MS = 3 * 60_000;

/**
 * Live import progress on the Inbox. Reads the shop-wide numbers from the server (POST /api/records importProgress),
 * so it is right on any device and keeps going after the upload page is closed, with no time limit. Shows nothing
 * when no import is running.
 */
export function ImportProgressPanel() {
  const [data, setData] = useState<ImportProgressSummary | null>(null);
  const [finished, setFinished] = useState(false);
  const lastGraphRefresh = useRef(Date.now());
  const wasRunning = useRef(false);
  const openInboxNeedsPerson = useAppStore((s) => s.openInboxNeedsPerson);
  const uploadingNow = useAppStore((s) => s.bulkRunning);

  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    let timer: number | null = null;

    const schedule = (ms: number) => {
      if (!cancelled) timer = window.setTimeout(tick, ms);
    };

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') return schedule(FAST_MS);
      let next: ImportProgressSummary;
      try {
        next = await recordsStore.importProgress();
      } catch {
        return schedule(IDLE_MS); // an older server without this action, or a dropped request: try again later
      }
      if (cancelled) return;
      setData(next);

      // Keep the shop-wide totals the rest of the Inbox reads in step with what the server just said.
      const g = useGraph.getState();
      if (g.serverCounts) {
        g.setServerCounts({ ...g.serverCounts, documents: next.total, verified: next.verified, needsReview: next.needsReview, byStage: next.byStage });
      }

      const running = next.pending > 0;

      if (running) {
        wasRunning.current = true;
        setFinished(false);
        if (Date.now() - lastGraphRefresh.current > GRAPH_REFRESH_MS) {
          lastGraphRefresh.current = Date.now();
          void loadGraphFromServer().catch(() => undefined);
        }
      } else if (wasRunning.current) {
        wasRunning.current = false;
        setFinished(true);
        lastGraphRefresh.current = Date.now();
        void loadGraphFromServer().catch(() => undefined);
      }
      schedule(running ? FAST_MS : IDLE_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  if (DEMO_MODE || !data) return null;

  if (finished && data.pending === 0) {
    return (
      <section aria-live="polite" className="dw-card p-5 flex flex-col lg:flex-row lg:items-center gap-6">
        <StageRing
          byStage={data.byStage}
          label={`All documents read. ${ringLabel(data.byStage)}`}
          center={<CheckCircle2 className="w-9 h-9 text-[#5E9E6E]" aria-hidden="true" />}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-h3">All your documents are read.</h2>
          {data.failedRecent > 0 && (
            <p className="text-body text-ink-2">{fmtCount(data.failedRecent)} couldn’t be read. You’ll find them under Needs you.</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className="dw-btn-primary" onClick={() => openInboxNeedsPerson()}>See what needs you</button>
            <button type="button" className="dw-btn-secondary" onClick={() => setFinished(false)}>Close</button>
          </div>
        </div>
      </section>
    );
  }

  if (data.pending === 0) return null;

  const left = minutesLeft(data.pending, data.readLast10m);

  return (
    <section aria-labelledby="import-progress-heading" className="dw-card p-5 flex flex-col lg:flex-row lg:items-center gap-6">
      <StageRing
        byStage={data.byStage}
        label={`${fmtCount(data.pending)} still to read. ${ringLabel(data.byStage)}`}
        center={
          <>
            <span className="font-display text-h2 leading-none">{fmtCount(data.pending)}</span>
            <span className="text-caption text-ink-2 mt-1">to go</span>
          </>
        }
      />
      <div className="min-w-0 flex-1 space-y-2">
        <h2 id="import-progress-heading" className="text-h3">Reading your documents</h2>
        <p className="text-body text-ink-2" aria-live="polite">
          {left === null
            ? 'Getting started. The time left will show once the first documents are read.'
            : `${fmtCount(data.readLast10m)} read in the last 10 minutes · ${formatTimeLeft(left)} left`}
        </p>
        {data.failedRecent > 0 && (
          <p className="text-body text-ink-2">{fmtCount(data.failedRecent)} couldn’t be read. You’ll find them under Needs you.</p>
        )}
        <p className="text-caption text-ink-3">
          {uploadingNow
            ? 'Keep this page open until the upload finishes. After that you can close it: reading carries on, and the bell will let you know when it’s done.'
            : 'You can close this page. Reading carries on, and the bell will let you know when it’s done.'}
        </p>
      </div>
    </section>
  );
}

/** The five pipeline stages in order, the same names the Inbox tiles use, each with its own colour. */
const RING_STAGES = [
  { key: 'received', label: 'Uploaded', color: '#8C9A92' },
  { key: 'read', label: 'Sorted', color: '#7FA0C6' },
  { key: 'mapped', label: 'Read', color: '#C99C5C' },
  { key: 'linked', label: 'Matched', color: '#5FA8A0' },
  { key: 'verified', label: 'Checked', color: '#5E9E6E' },
] as const;

type StageCounts = ImportProgressSummary['byStage'];

/**
 * One clean ring split into the five stages (Uploaded, Sorted, Read, Matched, Checked), each segment sized by how many
 * documents sit in that stage, with a key beside it. Segments ease to new sizes as documents move along (motion-safe).
 */
function StageRing({ byStage, center, label }: { byStage: StageCounts; center: ReactNode; label: string }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const total = RING_STAGES.reduce((n, s) => n + (byStage[s.key] ?? 0), 0);
  const gap = total > 0 ? 2 : 0;
  let start = 0;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-5 shrink-0">
      <div className="relative w-36 h-36" role="img" aria-label={label}>
        <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90" aria-hidden="true">
          <circle cx="60" cy="60" r={r} fill="none" className="stroke-surface-2" strokeWidth="10" />
          {total > 0 &&
            RING_STAGES.map((s) => {
              const n = byStage[s.key] ?? 0;
              const len = (n / total) * c;
              const seg = Math.max(0, len - (n > 0 && len > gap * 2 ? gap : 0));
              const el = (
                <circle
                  key={s.key}
                  cx="60"
                  cy="60"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="10"
                  strokeDasharray={`${seg} ${c - seg}`}
                  strokeDashoffset={-start}
                  className="motion-safe:transition-[stroke-dasharray,stroke-dashoffset] motion-safe:duration-700"
                />
              );
              start += len;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>
      </div>
      <ul className="grid grid-cols-5 sm:grid-cols-1 gap-x-3 gap-y-1.5 text-caption" aria-hidden="true">
        {RING_STAGES.map((s) => (
          <li key={s.key} className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 items-center">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
            <span className="text-ink-2">{s.label}</span>
            <span className="font-mono text-data text-ink tabular-nums sm:ml-auto">{fmtCount(byStage[s.key] ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ringLabel(byStage: StageCounts): string {
  return RING_STAGES.map((s) => `${s.label} ${fmtCount(byStage[s.key] ?? 0)}`).join(', ');
}
