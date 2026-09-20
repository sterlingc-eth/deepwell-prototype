/**
 * CSV export (handoffs/DATA_INTEGRITY_2026-09-20.md): GET /api/v1/export?kind=
 * documents|customers|equipment streams text/csv with a Content-Disposition
 * filename. Fetched with the Clerk token (it's not a plain <a href> link —
 * the endpoint needs auth), turned into a blob, then downloaded via a
 * throwaway a[download] element, exactly per the brief's contract.
 */
import { authHeader } from './authToken';

const EXPORT_URL = '/api/v1/export';

export type ExportKind = 'documents' | 'customers' | 'equipment';

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="?([^"; ]+)"?/i.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

export async function downloadExportCsv(kind: ExportKind): Promise<void> {
  const res = await fetch(`${EXPORT_URL}?kind=${kind}`, { headers: { ...(await authHeader()) } });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* a 500/HTML error page — keep the status line */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const filename = filenameFrom(res.headers.get('Content-Disposition'), `${kind}.csv`);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
