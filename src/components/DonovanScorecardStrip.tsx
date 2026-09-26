import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Gauge, Loader2, Play, RefreshCw } from 'lucide-react';
import { reviewClient, runScorecardAll, type ScorecardStatus } from '../services/reviewClient';

/**
 * Donovan Scorecard strip (operator only) - lives on the "Donovan misses" card.
 *
 * The scorecard is a golden exam of ~600 questions, each with an independent SQL answer key over the shop's own
 * tables, asked through the real answer pipeline (api/_lib/scorecard). A question passes only when the value is right
 * AND the answer carries a citation. This strip shows the overall score, the value-only score and citation coverage
 * (separately), how they moved against the previous comparable run, a bar per category (weakest first), a "Run
 * scorecard" button with progress (the server does about 6 questions per call to stay inside the 60 s function limit)
 * and, expandable, the failing questions: what was asked, what the records say, what Donovan said, and whether the
 * value or only the citation was the problem. The adjudication note says why a failure here is Donovan's, not the exam's.
 */
const pct = (n: number | null | undefined) => (n == null ? '-' : `${Math.round(n * 100)}%`);

function barTone(score: number): string {
  if (score >= 0.9) return 'bg-ok';
  if (score >= 0.7) return 'bg-warn';
  return 'bg-bad';
}

export function DonovanScorecardStrip() {
  const [status, setStatus] = useState<ScorecardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ offset: number; total: number; spentUsd: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFailing, setShowFailing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    reviewClient
      .scorecardStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the scorecard.'))
      .finally(() => setLoading(false));
  }, []);

  // First load: state is only set from the async callbacks (loading starts true), never synchronously in the effect.
  useEffect(() => {
    let alive = true;
    reviewClient
      .scorecardStatus()
      .then((s) => { if (alive) setStatus(s); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the scorecard.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const run = async (opts: { retryOfRunId?: string } = {}) => {
    setRunning(true);
    setError(null);
    setNote(null);
    setProgress({ offset: 0, total: status?.exam.questions ?? 0, spentUsd: 0 });
    try {
      const last = await runScorecardAll(opts, setProgress);
      const stop = last.stopped === 'budget' ? ` Stopped at the $${status?.budgetUsd ?? 5} spend limit.`
        : last.stopped === 'model-budget' ? ' Stopped: daily AI budget reached.'
        : last.stopped === 'model-credits' ? ' Paused: the AI provider is out of credits.'
        : last.stopped === 'deadline' ? ' Stopped early (time).' : '';
      setNote(`Finished: ${last.run?.passed ?? 0} of ${last.run?.answered ?? 0} right, $${last.spentUsd.toFixed(2)} spent.${stop}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The scorecard run failed.');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const run0 = status?.run ?? null;
  const delta = run0?.score != null && status?.previous ? run0.score - status.previous.score : null;
  const cats = Object.entries(run0?.byCategory ?? {}).sort((a, b) => a[1].score - b[1].score || a[0].localeCompare(b[0]));
  const failing = status?.failing ?? [];
  const cite = run0?.citation ?? null;
  const prevValue = status?.previous?.valueScore ?? null;
  const prevCite = status?.previous?.citationCoverage ?? null;
  const valueDelta = run0?.valueScore != null && prevValue != null ? run0.valueScore - prevValue : null;
  const citeDelta = cite?.coverage != null && prevCite != null ? cite.coverage - prevCite : null;
  const arrow = (d: number | null) => (d == null || Math.abs(d) < 0.005 ? '' : `${d > 0 ? ' ▲' : ' ▼'}${Math.abs(Math.round(d * 100))}`);
  const noExam = status != null && status.exam.questions === 0;
  // ROUND 14 (owner: "live scorecard shows 36%" — really "4 of 11 right" because every question that
  // needed the model was skipped mid-run when the AI provider ran out of credits): a run that stopped
  // for that reason gets its own honest banner instead of a percentage over a near-empty sample.
  const paused = run0?.status === 'stopped' && run0.stopReason === 'model-credits';
  const providerDown = Boolean(status?.providerStatus);

  return (
    <div className="rounded-lg border border-line bg-surface-2/40 p-3 space-y-2" data-testid="scorecard-strip">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <Gauge className="w-4 h-4" aria-hidden="true" />
          Donovan scorecard
          {run0?.score != null && <span className="font-display text-h3">{pct(run0.score)}</span>}
          {delta != null && Math.abs(delta) >= 0.005 && (
            <span className={delta > 0 ? 'dw-pill-ok' : 'dw-pill-warn'} title="Versus the previous comparable run">
              {delta > 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 100))} pts
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={() => void run()} disabled={running || noExam} className="dw-btn-tertiary !min-h-[32px] !py-0.5">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
            {running ? 'Running…' : 'Run scorecard'}
          </button>
          <button type="button" onClick={load} disabled={loading || running} aria-label="Refresh scorecard" className="dw-btn-tertiary !min-h-[32px] !py-0.5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </span>
      </div>

      {running && progress && (
        <div className="space-y-1" role="status">
          <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div className="h-full bg-forest-600 transition-all" style={{ width: `${progress.total ? Math.min(100, (progress.offset / progress.total) * 100) : 0}%` }} />
          </div>
          <p className="text-caption text-ink-3">Asked {progress.offset} of {progress.total || '…'} questions · ${progress.spentUsd.toFixed(2)} spent</p>
        </div>
      )}
      {note && <p className="text-caption text-ink-2">{note}</p>}
      {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}
      {noExam && <p className="text-caption text-ink-3">The exam file is not deployed with this build.</p>}

      {(paused || providerDown) && run0 && (
        <p role="status" className="text-caption dw-pill-warn !inline-block" data-testid="scorecard-paused">
          Paused — AI provider credits are exhausted; {run0.answered} question{run0.answered === 1 ? '' : 's'} answered
          without AI: {pct(run0.score)} correct.
        </p>
      )}

      {run0 && (
        <div className="grid grid-cols-3 gap-2" aria-label="Scorecard headline numbers">
          <div className="rounded-md bg-surface-2/60 px-2 py-1" data-testid="scorecard-overall">
            <p className="text-caption text-ink-3">Passing</p>
            <p className="font-display text-h3 tabular-nums">{pct(run0.score)}</p>
            <p className="text-caption text-ink-3">value right and cited</p>
          </div>
          <div className="rounded-md bg-surface-2/60 px-2 py-1" data-testid="scorecard-value">
            <p className="text-caption text-ink-3">Value accuracy</p>
            <p className="font-display text-h3 tabular-nums">{pct(run0.valueScore)}<span className="text-caption text-ink-3">{arrow(valueDelta)}</span></p>
            <p className="text-caption text-ink-3">citations aside</p>
          </div>
          <div className="rounded-md bg-surface-2/60 px-2 py-1" data-testid="scorecard-citation">
            <p className="text-caption text-ink-3">Citation coverage</p>
            <p className="font-display text-h3 tabular-nums">{pct(cite?.coverage)}<span className="text-caption text-ink-3">{arrow(citeDelta)}</span></p>
            <p className="text-caption text-ink-3">{cite ? `${cite.cited} of ${cite.required} answers` : '-'}</p>
          </div>
        </div>
      )}

      {run0 && (
        <p className="text-caption text-ink-3">
          {run0.passed} of {run0.answered} right{run0.status === 'stopped' ? ` (stopped: ${run0.stopReason ?? 'early'})` : run0.status === 'running' ? ' (in progress)' : ''}
          {' · '}{run0.source === 'nightly' ? 'nightly slice' : run0.source === 'retry' ? 're-run of failures' : 'full run'}
          {' · '}{run0.startedAt ? new Date(run0.startedAt).toLocaleDateString() : ''}
          {status?.previous ? ` · previous ${pct(status.previous.score)}` : ''}
        </p>
      )}
      {!run0 && !loading && !noExam && <p className="text-caption text-ink-3">No scorecard run yet. Run it to see how Donovan does on {status?.exam.questions ?? 300} known-answer questions.</p>}

      {cats.length > 0 && (
        <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2" aria-label="Score by category">
          {cats.map(([name, c]) => (
            <li key={name} className="text-caption">
              <div className="flex justify-between gap-2 text-ink-2">
                <span className="truncate" title={name}>{name}</span>
                <span className="tabular-nums" title={c.citationCoverage != null ? `Value ${pct(c.valueScore)} · cited ${pct(c.citationCoverage)}` : undefined}>{c.passed}/{c.total}{c.citationCoverage != null ? ` · cited ${pct(c.citationCoverage)}` : ''}</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div className={`h-full ${barTone(c.score)}`} style={{ width: `${Math.round(c.score * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {status?.adjudicationNote && (
        <p className="text-caption text-ink-3" data-testid="scorecard-adjudication">
          <span className="text-ink-2">Adjudicated:</span> {status.adjudicationNote}
        </p>
      )}

      {failing.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" className="text-caption text-ink-2 flex items-center gap-1 underline" onClick={() => setShowFailing((v) => !v)} aria-expanded={showFailing}>
              {showFailing ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
              {failing.length} failing question{failing.length === 1 ? '' : 's'}
            </button>
            {run0 && !running && (
              <button type="button" className="text-caption text-ink-2 underline" onClick={() => void run({ retryOfRunId: run0.id })}>
                Re-run failures
              </button>
            )}
          </div>
          {showFailing && (
            <ul className="divide-y divide-line max-h-80 overflow-y-auto">
              {failing.map((f) => (
                <li key={f.questionId} className="py-1.5 text-caption space-y-0.5">
                  <p className="text-ink">
                    <span className="dw-pill-muted mr-1">{f.category}</span>
                    {f.persona && <span className="dw-pill-muted mr-1">{f.persona}</span>}
                    {f.valueOk && f.citationRequired && !f.cited && <span className="dw-pill-warn mr-1">right, but no citation</span>}
                    "{f.question}"
                  </p>
                  <p className="text-ink-3"><span className="text-ink-2">Expected:</span> {f.expected ?? '-'}</p>
                  <p className="text-warn-ink dark:text-brass-200"><span className="text-ink-2">Donovan said:</span> {f.got ?? f.error ?? '-'}</p>
                  {f.retry && <p className="text-ink-3">Retry on {f.retry.model}: {f.retry.passed ? 'right' : 'still wrong'}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
