import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Search } from 'lucide-react';
import { reviewClient, type SemanticStatus } from '../services/reviewClient';

/**
 * Admin-only "Search by meaning" card (Team screen). Shows how many document
 * pages Donovan can now find by meaning ("loud" finds "noise"), and a button
 * that prepares the pages uploaded before this feature existed. New uploads are
 * prepared automatically. The button is safe to press any time or twice: it
 * only does what is left, and picks up where it stopped.
 */
const MAX_ROUNDS = 40; // each round is ~30 s of server work; a safety stop for a stuck loop

const REASON: Record<string, string> = {
  'not-configured': 'Not switched on for this deployment yet.',
  'migration-pending': 'Waiting on a one-time database update.',
};

export function SemanticSearchCard() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () => {
    setError(null);
    reviewClient.semanticStatus().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : 'Could not load status.'));
  };

  useEffect(() => {
    if (open && status === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const r = await reviewClient.semanticBackfill();
        setStatus(r.status);
        if (r.stoppedBy === 'deadline') continue; // more to do: go again
        if (r.stoppedBy === 'budget') setNote("Stopped for today: the daily limit for this feature was reached. Press again tomorrow and it resumes where it left off.");
        else if (r.stoppedBy === 'error') setNote('Stopped on an error. Press again to resume where it left off.');
        else if (r.stoppedBy === 'done') setNote('All pages are ready.');
        break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare your documents.');
    } finally {
      setRunning(false);
    }
  };

  const total = status?.pagesTotal ?? 0;
  const done = status?.pagesEmbedded ?? 0;
  const remaining = status?.pagesRemaining ?? 0;

  return (
    <div className="dw-card p-4 space-y-3">
      <button type="button" className="w-full flex items-center justify-between text-left" onClick={() => setOpen((v) => !v)}>
        <span className="text-body font-medium text-ink flex items-center gap-2">
          <Search className="w-4 h-4" aria-hidden="true" />
          Search by meaning
          {status?.ready && <span className="dw-pill-muted">{done} of {total} pages</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          <p className="text-caption text-ink-3">
            Lets Donovan find a page by what it means, not only the exact words — so &ldquo;any complaints about noise&rdquo;
            finds a page that says &ldquo;the unit is loud&rdquo;. New uploads are prepared automatically; this prepares older ones.
          </p>

          {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}
          {!status && !error && (
            <p className="text-body text-ink-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</p>
          )}
          {status && !status.ready && <p className="text-body text-ink-3">{REASON[status.reason ?? ''] ?? 'Not available yet.'}</p>}

          {status?.ready && (
            <div className="space-y-2">
              <div className="h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
                <div className="h-full bg-brass-500" style={{ width: `${total ? Math.round((done / total) * 100) : 100}%` }} />
              </div>
              <p className="text-caption text-ink-2">
                {remaining === 0 ? 'All pages are ready.' : `${remaining} page${remaining === 1 ? '' : 's'} still to prepare.`}
              </p>
              {remaining > 0 && (
                <button type="button" className="dw-btn-secondary" disabled={running} onClick={() => void run()}>
                  {running ? (<><Loader2 className="w-4 h-4 animate-spin inline mr-1" aria-hidden="true" />Preparing…</>) : 'Prepare older documents'}
                </button>
              )}
              {note && <p className="text-caption text-ink-3">{note}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
