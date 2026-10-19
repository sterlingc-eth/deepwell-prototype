import { useEffect, useState } from 'react';
import { DatabaseBackup, Loader2 } from 'lucide-react';
import { authHeader } from '../services/authToken';

/**
 * Operator-only: when the last good nightly data backup finished. Answers from /api/account?action=backup (platform operator only;
 * the server says "not turned on" while DEEPWELL_BACKUP is unset). Shows times and counts only, never any customer data.
 */
interface BackupStatus {
  enabled: boolean;
  lastSuccessAt?: string | null;
  ageHours?: number | null;
  stale?: boolean;
  today?: { complete: boolean; done: number; tenantsTotal: number; failed: number } | null;
}

export function BackupStatusCard() {
  const [data, setData] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/account?action=backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ op: 'status' }),
        });
        if (res.status === 404) { if (live) setData({ enabled: false }); return; }
        if (!res.ok) throw new Error('Could not load the backup status.');
        const json = (await res.json()) as BackupStatus;
        if (live) setData(json);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load the backup status.');
      }
    })();
    return () => { live = false; };
  }, []);

  const when = data?.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : null;
  return (
    <section className="dw-card p-4 sm:p-5" aria-labelledby="backup-status-h">
      <div className="flex items-center gap-3">
        <DatabaseBackup className="w-5 h-5 text-ink-2" aria-hidden="true" />
        <h3 id="backup-status-h" className="text-h3">Data backup</h3>
      </div>
      {error ? <p className="text-body text-ink-2 mt-3">{error}</p>
        : !data ? <p className="text-body text-ink-2 mt-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading</p>
        : !data.enabled ? <p className="text-body text-ink-2 mt-3">Nightly backups are not turned on yet.</p>
        : (
          <div className="mt-3 space-y-1 text-body">
            <p className={data.stale ? 'font-semibold text-warn-ink' : 'text-ink'}>
              {when ? `Last good backup: ${when} (${data.ageHours} hours ago)` : 'No good backup recorded yet.'}
              {data.stale ? ' - overdue' : ''}
            </p>
            {data.today ? <p className="text-ink-2">Tonight: {data.today.done} of {data.today.tenantsTotal} companies{data.today.failed ? `, ${data.today.failed} failed` : ''}{data.today.complete ? ' - complete' : ''}.</p> : null}
          </div>
        )}
    </section>
  );
}
