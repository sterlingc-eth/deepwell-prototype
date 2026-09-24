import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Loader2, Receipt } from 'lucide-react';
import { isAdminRole } from '../services/teamClient';
import { financialsClient, formatMoney, type BackfillStatus, type FinancialsSummary } from '../services/financialsClient';

/**
 * Dashboard "Money" summary (owner / admin only): invoiced this month and year to date, what is
 * open and overdue, and an aging split. Every number is computed in SQL from the captured invoices
 * (api/_lib/financials/answers.js); the card states what it could not count. Hidden until the
 * financials migration is applied. Admins can also start the (bounded, resumable) backfill.
 */
export function FinancialsCard() {
  const { orgId, orgRole } = useAuth();
  const allowed = !orgId || isAdminRole(orgRole ?? null);
  const [s, setS] = useState<FinancialsSummary | null>(null);
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    financialsClient.summary().then(setS).catch(() => setS(null));
    financialsClient.backfillStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  if (!allowed || !s?.enabled) return null;

  const runBackfill = async () => {
    setBusy(true);
    setMsg(null);
    try {
      let cursor: string | null | undefined = null;
      let written = 0;
      // A few bounded batches per click; the server caps model calls per invocation and never redoes finished documents.
      for (let i = 0; i < 5; i++) {
        const r = await financialsClient.backfill(cursor);
        written += r.written;
        cursor = r.nextCursor;
        if (!cursor || r.remaining === 0 || r.stoppedReason === 'daily_budget' || r.stoppedReason === 'cost_cap') break;
      }
      setMsg(`Read ${written} more document${written === 1 ? '' : 's'}.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not run that.');
    } finally {
      setBusy(false);
    }
  };

  const aging = s.aging;
  return (
    <div className="dw-card p-4 space-y-3">
      <h3 className="text-body font-medium text-ink flex items-center gap-2"><Receipt className="w-4 h-4" aria-hidden="true" /> Money</h3>
      <dl className="grid grid-cols-2 gap-3">
        <div><dt className="text-caption text-ink-3">Invoiced {s.month?.label}</dt><dd className="font-mono text-h4">{formatMoney(s.month?.total)}</dd><dd className="text-caption text-ink-3">{s.month?.invoices} invoices</dd></div>
        <div><dt className="text-caption text-ink-3">Invoiced {s.ytd?.label}</dt><dd className="font-mono text-h4">{formatMoney(s.ytd?.total)}</dd><dd className="text-caption text-ink-3">{s.ytd?.invoices} invoices</dd></div>
        <div><dt className="text-caption text-ink-3">Open</dt><dd className="font-mono text-h4">{formatMoney(s.open?.total)}</dd><dd className="text-caption text-ink-3">{s.open?.invoices} invoices</dd></div>
        <div><dt className="text-caption text-ink-3">Overdue</dt><dd className="font-mono text-h4">{formatMoney(s.overdue?.total)}</dd><dd className="text-caption text-ink-3">{s.overdue?.invoices} invoices</dd></div>
      </dl>
      {aging && (
        <p className="text-caption text-ink-3">
          Aging: not yet due {formatMoney(aging.current)} · 1-30 days {formatMoney(aging.d1_30)} · 31-60 {formatMoney(aging.d31_60)} · 61-90 {formatMoney(aging.d61_90)} · 90+ {formatMoney(aging.d90plus)}
        </p>
      )}
      <p className="text-caption text-ink-3">
        {s.excluded?.noTotal ? `${s.excluded.noTotal} invoice${s.excluded.noTotal === 1 ? '' : 's'} print no total and aren't counted. ` : ''}
        {s.excluded?.undated ? `${s.excluded.undated} ${s.excluded.undated === 1 ? 'has' : 'have'} no date. ` : ''}
        {s.needsReview ? `${s.needsReview} need a look in Review (the numbers don't add up).` : ''}
      </p>
      {status && status.remaining > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-ink-3">{status.remaining} of {status.eligible} invoices, quotes and agreements haven't been read for amounts yet.</span>
          <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" disabled={busy} onClick={() => void runBackfill()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Read amounts now'}
          </button>
        </div>
      )}
      {msg && <p role="status" className="text-caption text-ink-3">{msg}</p>}
    </div>
  );
}
