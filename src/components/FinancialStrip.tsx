import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil } from 'lucide-react';
import {
  financialsClient, formatMoney, FLAG_LABEL,
  type DocumentFinancials, type FinancialFieldKey,
} from '../services/financialsClient';

/**
 * Money fields on the document detail screen (financials layer). Shows what was read from the
 * document with its page, lets a person correct any field (the correction is stored BESIDE the
 * original, which stays visible), and flags numbers that do not add up. Renders nothing when the
 * document has no financial data or the migration is not applied.
 */
const ROWS: { key: FinancialFieldKey; label: string; money?: boolean }[] = [
  { key: 'invoice_number', label: 'Number' },
  { key: 'invoice_date', label: 'Date' },
  { key: 'due_date', label: 'Due' },
  { key: 'subtotal', label: 'Subtotal', money: true },
  { key: 'tax', label: 'Tax', money: true },
  { key: 'total', label: 'Total', money: true },
  { key: 'amount_paid', label: 'Paid', money: true },
  { key: 'balance_due', label: 'Balance due', money: true },
  { key: 'status', label: 'Status' },
];

export function FinancialStrip({ documentId, by }: { documentId: string; by: string }) {
  const [res, setRes] = useState<{ id: string; data: DocumentFinancials | null } | null>(null);
  const data = res?.id === documentId ? res.data : null;
  const setData = (d: DocumentFinancials | null) => setRes({ id: documentId, data: d });
  const [editing, setEditing] = useState<FinancialFieldKey | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    financialsClient.document(documentId)
      .then((r) => { if (live) setRes({ id: documentId, data: r.enabled ? r.financials : null }); })
      .catch(() => { if (live) setRes({ id: documentId, data: null }); });
    return () => { live = false; };
  }, [documentId]);

  if (!data) return null;

  const run = async (fn: () => Promise<{ financials: DocumentFinancials | null }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.financials) setData(r.financials);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const shown = ROWS.filter((r) => data.fields[r.key]?.value != null || data.fields[r.key]?.original != null || r.key === 'total');
  return (
    <section className="p-5 space-y-3" aria-label="Money on this document">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-h4">Money</h3>
        <span className="dw-pill-muted">{data.docKind.replace('_', ' ')}{data.direction === 'payable' ? ' · we owe' : ''}</span>
        {data.verifiedBy ? <span className="dw-pill-ok inline-flex items-center gap-1"><Check className="w-3 h-3" aria-hidden="true" /> Verified by {data.verifiedBy}</span> : null}
      </div>
      {data.flags.filter((f) => FLAG_LABEL[f]).length > 0 && (
        <ul className="rounded-lg border border-warn/40 bg-warn-bg p-3 space-y-1 text-body text-warn-ink">
          {data.flags.filter((f) => FLAG_LABEL[f]).map((f) => (
            <li key={f} className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />{FLAG_LABEL[f]}</li>
          ))}
        </ul>
      )}
      <ul className="divide-y divide-line">
        {shown.map(({ key, label, money }) => {
          const f = data.fields[key];
          const value = f?.value ?? null;
          const isEditing = editing === key;
          return (
            <li key={key} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-28 text-ink-3">{label}</span>
              {isEditing ? (
                <span className="flex flex-wrap items-center gap-2">
                  <input aria-label={`New ${label}`} className="dw-input !min-h-[40px] font-mono" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5" disabled={busy} onClick={() => void run(() => financialsClient.correct(documentId, key, draft, by))}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Save'}
                  </button>
                  <button type="button" className="dw-btn-tertiary !min-h-[40px] !py-1.5" onClick={() => setEditing(null)}>Cancel</button>
                </span>
              ) : (
                <>
                  <span className="font-mono text-data">{money ? formatMoney(value) : value ?? '—'}</span>
                  {f?.corrected && (
                    <span className="text-caption text-ink-3">corrected · originally <span className="font-mono">{money ? formatMoney(f.original) : f.original ?? 'blank'}</span></span>
                  )}
                  {f?.evidence?.page != null && !f.corrected && (
                    <span className="text-caption text-ink-3" title={f.evidence.verbatim ?? undefined}>page {f.evidence.page}</span>
                  )}
                  <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-0.5 ml-auto" aria-label={`Correct ${label}`} onClick={() => { setDraft(value ?? ''); setEditing(key); }}>
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {data.lines.length > 0 && (
        <details>
          <summary className="cursor-pointer text-body text-ink-2">{data.lines.length} line item{data.lines.length === 1 ? '' : 's'}</summary>
          <ul className="mt-2 divide-y divide-line text-body">
            {data.lines.map((l) => (
              <li key={l.lineNo} className="py-1.5 flex justify-between gap-3">
                <span className="min-w-0 truncate">{l.description ?? 'Line'}{l.qty ? ` × ${l.qty}` : ''}</span>
                <span className="font-mono shrink-0">{formatMoney(l.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="text-caption text-bad-ink">{error}</p>}
      {!data.verifiedBy && (
        <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" disabled={busy} onClick={() => void run(() => financialsClient.verify(documentId, by))}>
          <Check className="w-4 h-4" aria-hidden="true" /> These numbers are right
        </button>
      )}
    </section>
  );
}
