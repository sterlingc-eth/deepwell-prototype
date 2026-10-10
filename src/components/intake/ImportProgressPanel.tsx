import { useEffect, useRef, useState, type ReactNode } from 'react';
import { recordsStore, type ImportProgressSummary } from '../../services/recordsStoreClient';
import { loadGraphFromServer } from '../../hooks/usePostgresSync';
import { docCountsByStage, documentTotalFor, companyFileNeedsLook, isCompanyFileDoc, useGraph } from '../../core/entityGraph';
import { hvacSchema } from '../../domains/hvac/schema';
import { useAppStore } from '../../store/appStore';
import { fmtCount, formatTimeLeft, minutesLeft } from '../../core/importProgress';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';
/** While documents are being read: check every 5 seconds. Otherwise once a minute, to notice an import started elsewhere. */
const FAST_MS = 5_000;
const IDLE_MS = 60_000;
/** The pipeline tiles and Needs you come from the loaded records; reload them this often during an import, and once at the end. */
const GRAPH_REFRESH_MS = 3 * 60_000;

type StageCounts = ImportProgressSummary['byStage'];

/**
 * The Inbox pipeline ring card: ONE card, always there once the company has a document. A ring split into
 * Uploaded, Sorted, Read, Matched, Checked, a key with the five counts, and (merged in) the live import progress.
 *
 * STAGE MAPPING (decision): the ring is drawn from the server's shop-wide raw `documents.stage` counts
 * (received, read, mapped, linked, verified -> Uploaded, Sorted, Read, Matched, Checked), from POST /api/records
 * importProgress (tenant-scoped, exact for 1,000+ documents). The old tiles used the client's derived stages
 * (docCountsByStage), where 'classified' and 'extracted' are worked out from required fields and links. That cannot be
 * reproduced exactly in SQL, so the two never matched; the tiles are gone and this ring is the only per-stage set.
 * Before the first server answer (and in demo mode) it falls back to serverCounts.byStage, then to the graph's own
 * counts mapped one to one (classified -> Sorted, extracted -> Read).
 * The one-line summary under the card keeps using the graph (docCountsByStage / documentTotalFor, which already add
 * the server's shop-wide verified count): "answerable" is a claim about what the app will actually answer from, which
 * needs the client's field checks. The server's 'linked' can include documents missing required fields, so using it
 * there would overstate. Checked/verified is identical in both.
 *
 * Live numbers come from the server (right on any device, keeps going after the upload page is closed, no time
 * limit); polled every 5 s while reading, once a minute otherwise.
 */
export function ImportProgressPanel() {
  const graph = useGraph();
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
      if (g.serverCounts && Number.isFinite(next.total) && next.byStage && Number.isFinite(next.verified)) {
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

  const fallback: StageCounts | null = graph.serverCounts?.byStage ?? null;
  const c = docCountsByStage(graph);
  const graphStages: StageCounts = { received: c.received, read: c.classified, mapped: c.extracted, linked: c.linked, verified: c.verified };
  // A server body without a finite total and a full byStage is ignored (never render NaN): use the fallback counts.
  const good = !!data && Number.isFinite(data.total) && !!data.byStage && RING_STAGES.every((s) => Number.isFinite(data.byStage[s.key]));
  const ok = good ? data : null;
  const byStage = ok?.byStage ?? fallback ?? graphStages;
  const total = ok ? ok.total : documentTotalFor(graph);
  if (total <= 0) return null;

  const pending = Number.isFinite(ok?.pending) ? ok!.pending : 0;
  const failed = Number.isFinite(ok?.failedRecent) ? ok!.failedRecent : 0;
  const done = finished && pending === 0;
  const left = ok ? minutesLeft(pending, Number.isFinite(ok.readLast10m) ? ok.readLast10m : 0) : null;
  const label = pending > 0 ? `${fmtCount(pending)} still to read. ${ringLabel(byStage)}` : `${fmtCount(total)} documents. ${ringLabel(byStage)}`;
  // Company files are not matched, and the server counts don't know about them, so the ring is left as the server
  // reports it. A small honest line under the key counts the ones filed with nothing to check, only when every
  // document is held in this browser (otherwise the number would be a partial count).
  const allHeld = Object.keys(graph.docs).length >= total;
  const filedCompany = allHeld ? Object.values(graph.docs).filter((d) => isCompanyFileDoc(d, hvacSchema) && !companyFileNeedsLook(d, hvacSchema)).length : 0;
  const failedLine = failed > 0 && (
    <p className="text-body text-ink-2">{fmtCount(failed)} couldn’t be read. You’ll find them under Needs you.</p>
  );

  return (
    <section aria-labelledby="pipeline-ring-heading" data-testid="pipeline-ring-card" className="dw-card p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center gap-6 lg:gap-10">
      <StageRing
        byStage={byStage}
        label={label}
        footer={filedCompany > 0 ? <p className="text-caption text-ink-3" data-testid="company-files-filed">{fmtCount(filedCompany)} company file{filedCompany === 1 ? '' : 's'} filed</p> : undefined}
        center={
          <>
            <span className="font-display text-h2 leading-none tabular-nums">{fmtCount(pending > 0 ? pending : total)}</span>
            <span className="text-caption text-ink-2 mt-1">{pending > 0 ? 'to go' : 'documents'}</span>
          </>
        }
      />
      <div className="min-w-0 flex-1 space-y-2" aria-live="polite">
        {pending > 0 ? (
          <>
            <h2 id="pipeline-ring-heading" className="text-h3">Reading your documents</h2>
            <p className="text-body text-ink-2">
              {left === null
                ? 'Getting started. The time left will show once the first documents are read.'
                : `${fmtCount(ok?.readLast10m ?? 0)} read in the last 10 minutes · ${formatTimeLeft(left)} left`}
            </p>
            {failedLine}
            <p className="text-caption text-ink-3">
              {uploadingNow
                ? 'Keep this page open until the upload finishes. After that you can close it: reading carries on, and the bell will let you know when it’s done.'
                : 'You can close this page. Reading carries on, and the bell will let you know when it’s done.'}
            </p>
          </>
        ) : done ? (
          <>
            <h2 id="pipeline-ring-heading" className="text-h3">All your documents are read.</h2>
            {failedLine}
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" className="dw-btn-primary" onClick={() => openInboxNeedsPerson()}>See what needs you</button>
              <button type="button" className="dw-btn-secondary" onClick={() => setFinished(false)}>Close</button>
            </div>
          </>
        ) : (
          <>
            <h2 id="pipeline-ring-heading" className="text-h3">Pipeline</h2>
            {failedLine}
          </>
        )}
      </div>
    </section>
  );
}

/** The five pipeline stages in order, the same names the Inbox has always used, each with its own colour. */
const RING_STAGES = [
  { key: 'received', label: 'Uploaded', color: '#83918A' },
  { key: 'read', label: 'Sorted', color: '#6C91BD' },
  { key: 'mapped', label: 'Read', color: '#C99C5C' },
  { key: 'linked', label: 'Matched', color: '#5FA8A0' },
  { key: 'verified', label: 'Checked', color: '#5E9E6E' },
] as const;

/**
 * One thin ring split into the five stages, each segment sized by how many documents sit in that stage, with a key
 * beside it (colour dot, name, right-aligned count). Segments ease to new sizes as documents move along (motion-safe).
 */
function StageRing({ byStage, center, label, footer }: { byStage: StageCounts; center: ReactNode; label: string; footer?: ReactNode }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const total = RING_STAGES.reduce((n, s) => n + (byStage[s.key] ?? 0), 0);
  const gap = 3;
  let start = 0;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-8 shrink-0">
      <div className="relative w-40 h-40 shrink-0" role="img" aria-label={label}>
        <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90" aria-hidden="true">
          <circle cx="60" cy="60" r={r} fill="none" className="stroke-surface-2" strokeWidth="7" />
          {total > 0 &&
            RING_STAGES.map((s) => {
              const n = byStage[s.key] ?? 0;
              const len = (n / total) * c;
              const seg = n > 0 ? Math.max(Math.min(len, 1.5), len - gap) : 0;
              const el = (
                <circle
                  key={s.key}
                  cx="60"
                  cy="60"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="7"
                  strokeDasharray={`${seg} ${c - seg}`}
                  strokeDashoffset={-(start + gap / 2)}
                  className="motion-safe:transition-[stroke-dasharray,stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out"
                />
              );
              start += len;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>
      </div>
      <div className="w-full sm:w-52 space-y-2">
      <ul className="space-y-2 text-body" aria-hidden="true">
        {RING_STAGES.map((s) => (
          <li key={s.key} className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
            <span className="text-ink-2">{s.label}</span>
            <span className="ml-auto font-mono text-data text-ink tabular-nums">{fmtCount(byStage[s.key] ?? 0)}</span>
          </li>
        ))}
      </ul>
      {footer}
      </div>
    </div>
  );
}

function ringLabel(byStage: StageCounts): string {
  return RING_STAGES.map((s) => `${s.label} ${fmtCount(byStage[s.key] ?? 0)}`).join(', ');
}
