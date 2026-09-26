import { isRecordSource, type GridColumnDef, type GridRow } from './types';

/** Leading =, +, -, @ (and a literal tab or CR) make Excel/Google Sheets
 *  read the cell as a formula when the CSV is opened elsewhere — a classic
 *  CSV/spreadsheet formula-injection vector for any value a customer typed
 *  (a name, an address). Prefixing with a single quote is the standard
 *  mitigation: every spreadsheet app treats a leading `'` as "force text"
 *  and never displays it, so a legitimate value like "-5 Elm St" still
 *  reads correctly once opened. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvField(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Client-side CSV of exactly the rows currently loaded/visible in the grid —
 * never a server export of the full filtered set (that's downloadExportCsv,
 * a different, already-shipped feature). Adds one "Sources" column per row:
 * every source document id the row's cells cite, deduped, `id[:page]`,
 * semicolon-joined — so the CSV stays an honest, checkable artifact even
 * once it has left the app.
 */
export function gridRowsToCsv(columns: GridColumnDef[], rows: GridRow[]): string {
  const header = [...columns.map((c) => c.label), 'Sources'].map(csvField).join(',');
  const lines = rows.map((r) => {
    const cells = columns.map((c) => csvField(r.cells[c.key]?.value ?? ''));
    const sourceIds = new Set<string>();
    for (const c of columns) {
      for (const s of r.cells[c.key]?.sources ?? []) {
        sourceIds.add(isRecordSource(s) ? `${s.entityType}:${s.recordId}` : (s.page != null ? `${s.documentId}:p${s.page}` : s.documentId));
      }
    }
    return [...cells, csvField([...sourceIds].join('; '))].join(',');
  });
  return [header, ...lines].join('\r\n');
}

/** Triggers a browser download of the CSV — no server round trip. */
export function downloadGridCsv(filenamePrefix: string, columns: GridColumnDef[], rows: GridRow[]): void {
  const csv = gridRowsToCsv(columns, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
