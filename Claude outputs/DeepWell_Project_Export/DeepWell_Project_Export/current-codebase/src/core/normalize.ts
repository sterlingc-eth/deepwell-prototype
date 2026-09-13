/**
 * Client-safe value normalizers for the open-schema ingestion pipeline.
 *
 * This is a deliberate duplicate of the single-value normalization logic
 * that lives server-side in `api/_lib/normalize.js` (extracted from
 * `api/_lib/validate.js`'s prose normalizers). Server code (`api/`) and
 * client code (`src/`) don't share a bundler target in this repo, so the
 * two are kept in sync by hand rather than imported across that boundary —
 * see docs/INGEST_API.md, "Shared normalizers".
 *
 * `api/_lib/validate.js` extracts *every* occurrence of a value type out of
 * free-form prose (for the answer validator). These functions instead
 * normalize a *single already-isolated* raw value (a facet's `valueRaw`) into
 * a canonical string, which is what the mapping pass and dedupe signatures need.
 */
import type { ValueTypeGuess } from './types';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

const pad = (n: number | string) => String(n).padStart(2, '0');
const iso = (y: string | number, m: string | number, d: string | number) => `${fullYear(String(y))}-${pad(m)}-${pad(d)}`;
const fullYear = (y: string) => (y.length === 2 ? `20${y}` : y);

/**
 * Normalize a single date-like string to `YYYY-MM-DD` (or `YYYY-MM` for a
 * month-only mention). Returns the trimmed input unchanged when no date
 * pattern is recognized.
 */
export function normalizeDate(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return s;

  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m && m[1] && m[2] && m[3]) return iso(m[1], m[2], m[3]);

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m && m[1] && m[2] && m[3]) return iso(fullYear(m[3]), m[1], m[2]);

  m = new RegExp(`^${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, 'i').exec(s);
  if (m && m[1] && m[2] && m[3]) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return iso(m[3], mo, m[2]);
  }

  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE},?\\s+(\\d{4})$`, 'i').exec(s);
  if (m && m[1] && m[2] && m[3]) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return iso(m[3], mo, m[1]);
  }

  m = new RegExp(`^${MONTH_RE}\\s+(\\d{4})$`, 'i').exec(s);
  if (m && m[1] && m[2]) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[2]}-${pad(mo)}`;
  }

  return s;
}

/** "$1,850.00" → "1850.00"; "1850" → "1850". Strips currency symbols/commas, keeps up to 2 decimal places. */
export function normalizeMoney(raw: string): string {
  const s = String(raw ?? '').trim();
  const m = /(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/.exec(s.replace(/\$/g, ''));
  if (!m || !m[1]) return s;
  const whole = m[1].replace(/,/g, '');
  return m[2] ? `${whole}.${m[2].padEnd(2, '0')}` : whole;
}

const CONFUSABLES: Record<string, string> = { O: '0', I: '1', S: '5', B: '8' };

/** Uppercase, strip non-alphanumerics, collapse OCR-confusable letters/digits — for matching, not display. */
export function normalizeSerialKey(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[OISB]/g, (c) => CONFUSABLES[c] ?? c);
}

/** Display-normalized serial/identifier: trimmed, collapsed whitespace, uppercased. */
export function normalizeSerial(raw: string): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Collapses whitespace and normalizes common street-suffix abbreviations for comparison. */
export function normalizeAddress(raw: string): string {
  const SUFFIXES: Record<string, string> = {
    street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', lane: 'ln', court: 'ct',
    place: 'pl', parkway: 'pkwy', highway: 'hwy', circle: 'cir', terrace: 'ter', trail: 'trl', road: 'rd',
  };
  const collapsed = String(raw ?? '').trim().replace(/\s+/g, ' ').replace(/,/g, '');
  return collapsed
    .toLowerCase()
    .split(' ')
    .map((w) => SUFFIXES[w] ?? w)
    .join(' ');
}

/** Title-cases a person/company name, collapsing whitespace. */
export function normalizeName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w.length ? w[0]?.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

const CHECKED = new Set(['true', 'x', 'yes', 'checked', 'y', '1', '✓', '☑', '☒']);
const UNCHECKED = new Set(['false', 'no', 'unchecked', 'n', '0', '☐', '']);

/** Normalizes checkbox-ish text to "true" / "false"; anything unrecognized passes through lowercased/trimmed. */
export function normalizeCheckbox(raw: string): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (CHECKED.has(s)) return 'true';
  if (UNCHECKED.has(s)) return 'false';
  return s;
}

/** Plain number string: strips thousands separators, trims trailing ".0". */
export function normalizeNumber(raw: string): string {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

/** Collapsed-whitespace text, trimmed. The fallback for every other value type. */
export function normalizeText(raw: string): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

/** Dispatches to the right normalizer for a facet's value-type guess. */
export function normalizeByType(kind: ValueTypeGuess, raw: string): string {
  switch (kind) {
    case 'date':
      return normalizeDate(raw);
    case 'money':
      return normalizeMoney(raw);
    case 'serial':
    case 'identifier':
      return normalizeSerial(raw);
    case 'address':
      return normalizeAddress(raw);
    case 'name':
      return normalizeName(raw);
    case 'checkbox':
      return normalizeCheckbox(raw);
    case 'number':
      return normalizeNumber(raw);
    case 'text':
      return normalizeText(raw);
    default:
      return normalizeText(raw);
  }
}
