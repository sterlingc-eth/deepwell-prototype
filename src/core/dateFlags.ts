/**
 * R33 (2026-09-30): how the Inbox talks about a printed date that is in the future.
 *
 * The Sonoran Comfort Air defect: a service ticket printing "Date of Service: 10/19/2028" showed
 * "Missing information — Service date". The server now keeps such a date as `service_date_unconfirmed`
 * (api/_lib/extractFields.js UNCONFIRMED_SUFFIX) instead of dropping it; this module turns that into the
 * wording a person sees — "Service date 10/19/2028 is in the future — check the year" — and finds which
 * dates on a document still need that one-click confirm. Pure, no React.
 */
import type { Doc } from './types';
import { fieldLabel } from '../domains/hvac/documentTypes';

/** Mirrors api/_lib/extractFields.js UNCONFIRMED_SUFFIX and entityGraph.ts's copy (kept local so this stays light). */
export const UNCONFIRMED_SUFFIX = '_unconfirmed';

/** Date fields that record something that already happened (mirror of extractFields.js BACKWARD_LOOKING_FIELDS). */
export const BACKWARD_DATE_FIELDS = new Set(['service_date', 'installation_date', 'warranty_registered_date']);

export function isUnconfirmedField(name: string): boolean {
  return name.endsWith(UNCONFIRMED_SUFFIX);
}
export function baseFieldOf(name: string): string {
  return isUnconfirmedField(name) ? name.slice(0, -UNCONFIRMED_SUFFIX.length) : name;
}

/** "2028-10-19" -> "10/19/2028" (as a US form prints it); "2028-10" -> "10/2028"; anything else unchanged. */
export function formatUsDate(value: string): string {
  const v = String(value ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) return `${m[2]}/${m[1]}`;
  return v;
}

export function todayYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** True when an ISO date (or YYYY-MM) is after `today` (YYYY-MM-DD). */
export function isFutureYmd(value: string, today: string): boolean {
  const v = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(v)) return false;
  return v.length === 7 ? v > today.slice(0, 7) : v > today;
}

/** "Service date 10/19/2028 is in the future — check the year", or null when the value is not a future date. */
export function futureDateNote(fieldKey: string, value: string, today: string): string | null {
  const base = baseFieldOf(fieldKey);
  if (!BACKWARD_DATE_FIELDS.has(base)) return null;
  if (!isUnconfirmedField(fieldKey) && !isFutureYmd(value, today)) return null;
  return `${fieldLabel(base)} ${formatUsDate(value)} is in the future — check the year`;
}

export interface UnconfirmedDate {
  /** The canonical field a confirm writes (service_date). */
  fieldKey: string;
  value: string;
  note: string;
}

/**
 * Printed far-future dates on this document still waiting for a person: an `<key>_unconfirmed` row whose canonical
 * key has no value yet (a confirmed/corrected canonical value settles it, even before the server drops the row).
 */
export function unconfirmedDates(doc: Pick<Doc, 'extracted'>, today: string = todayYmd()): UnconfirmedDate[] {
  const canonical = new Set(
    doc.extracted.filter((f) => !isUnconfirmedField(f.name) && (f.correctedValue ?? f.value).trim()).map((f) => f.name),
  );
  const out: UnconfirmedDate[] = [];
  for (const f of doc.extracted) {
    if (!isUnconfirmedField(f.name)) continue;
    const base = baseFieldOf(f.name);
    const value = (f.correctedValue ?? f.value).trim();
    if (!value || canonical.has(base)) continue;
    out.push({ fieldKey: base, value, note: futureDateNote(f.name, value, today) ?? `${fieldLabel(base)} ${formatUsDate(value)} — please confirm` });
  }
  return out;
}

/** Extracted rows to SHOW: an unconfirmed twin is hidden once its canonical field has a value. */
export function visibleExtracted<T extends { name: string; value: string; correctedValue?: string }>(rows: T[]): T[] {
  const canonical = new Set(rows.filter((f) => !isUnconfirmedField(f.name) && (f.correctedValue ?? f.value).trim()).map((f) => f.name));
  return rows.filter((f) => !isUnconfirmedField(f.name) || !canonical.has(baseFieldOf(f.name)));
}
