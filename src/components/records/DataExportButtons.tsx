import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadExportCsv, type ExportKind } from '../../services/exportClient';

/**
 * R36: the three CSV exports (documents, customers, units) as buttons that work on their own, with no Records / Customers
 * screen behind them. A shop whose subscription ended is shown only Billing and Team (src/App.tsx), and the CSVs used to be
 * reachable only from the screens it can no longer open. The server never gated exports on billing (api/_lib/routes/
 * export-csv.js, tenant-export.js), so this is the one missing piece: the way to the files.
 */
const KINDS: { kind: ExportKind; label: string }[] = [
  { kind: 'documents', label: 'Documents (CSV)' },
  { kind: 'customers', label: 'Customers (CSV)' },
  { kind: 'equipment', label: 'Units (CSV)' },
];

export function DataExportButtons() {
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: ExportKind) => {
    setBusy(kind);
    setError(null);
    try {
      await downloadExportCsv(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download this export.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {KINDS.map(({ kind, label }) => (
          <button key={kind} type="button" className="dw-btn-secondary shrink-0" disabled={busy !== null} onClick={() => void run(kind)}>
            {busy === kind ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />} {label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-body text-warn-ink dark:text-brass-200">{error}</p>}
    </div>
  );
}
