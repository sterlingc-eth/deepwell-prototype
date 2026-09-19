/**
 * Small helpers shared by every domain's answer logic.
 */
import type { Answer, Entity, Fact, FieldValue, SourceRef } from './types';

export const str = (e: Entity | undefined, key: string): string => {
  const v = e?.fields[key];
  if (v === null || v === undefined) return '';
  // Every Date-valued entity field in this domain (warrantyExpiry,
  // installDate, a service visit's `date`) is a bare calendar day, never a
  // real timestamp — formatYmd, not fmtDate, is what renders those without a
  // timezone-dependent off-by-one (see formatYmd's own comment below).
  if (v instanceof Date) return formatYmd(v);
  return String(v);
};
export const dateOf = (e: Entity | undefined, key: string): Date | null => {
  const v = e?.fields[key];
  return v instanceof Date ? v : null;
};
export const numOf = (e: Entity | undefined, key: string): number | null => {
  const v = e?.fields[key];
  return typeof v === 'number' ? v : null;
};

/** For a genuine timestamp (Doc.receivedAt/verifiedAt — a real instant, not a
 *  bare calendar day) — rendered in the viewer's own local time, which is
 *  correct for those. Never use this for an entity field's Date (warranty
 *  expiry, install date, a visit date): use `formatYmd` instead. */
export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const YMD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats a bare calendar date — a `YYYY-MM-DD` string, or a `Date` already
 * built from one (`toDateOrNull` in usePostgresSync.ts, `new Date(ymd)`
 * elsewhere) — without ever consulting the runtime's local timezone.
 *
 * `new Date('2024-03-14')` parses as UTC midnight. Formatting that Date with
 * `toLocaleDateString` under a negative UTC offset (e.g. America/Phoenix,
 * UTC-7) rolls it back to "Mar 13, 2024" — the stored value never changed,
 * only the display. Reading the same fields back with the UTC getters
 * (`getUTCFullYear`/`getUTCMonth`/`getUTCDate`, never the local ones) is what
 * keeps a stored "2024-03-14" showing as Mar 14 in every timezone; that's why
 * this builds the label by hand instead of calling `toLocaleDateString` at
 * all, which cannot be told to skip the runtime's own zone.
 *
 * Only for a value that IS a bare calendar day (warranty expiry, install
 * date, a visit date) — never for a real timestamp such as
 * Doc.receivedAt/verifiedAt, which has a true time-of-day and should render
 * in the viewer's own timezone (use `fmtDate` for those).
 */
export function formatYmd(value: string | Date | null | undefined): string {
  if (!value) return '';
  let year: number;
  let month: number; // 0-indexed
  let day: number;
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) {
      year = Number(m[1]);
      month = Number(m[2]) - 1;
      day = Number(m[3]);
    } else {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      year = d.getUTCFullYear();
      month = d.getUTCMonth();
      day = d.getUTCDate();
    }
  } else {
    if (Number.isNaN(value.getTime())) return '';
    year = value.getUTCFullYear();
    month = value.getUTCMonth();
    day = value.getUTCDate();
  }
  return `${YMD_MONTHS[month]} ${day}, ${year}`;
}

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return `$${n.toLocaleString('en-US')}`;
}
export function fmtValue(v: FieldValue): string {
  if (v === null || v === undefined) return '';
  // See str()'s comment above — every Date-valued entity field is a bare
  // calendar day, so this goes through formatYmd, not fmtDate.
  if (v instanceof Date) return formatYmd(v);
  if (typeof v === 'number') return fmtMoney(v);
  return v;
}

export function normalize(q: string): string {
  return q
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9#$.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeSources(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const r of refs) {
    const k = `${r.documentId}|${r.location.page ?? ''}|${r.location.field ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function distinctDocs(refs: SourceRef[]): string[] {
  return Array.from(new Set(refs.map((r) => r.documentId)));
}

/** Assemble the final Answer from facts. Facts without sources are dropped — no fact without a source. */
export function assemble(
  text: string,
  facts: Fact[],
  opts: { confidence: number; entityId?: string; unverifiedDocIds?: string[]; interpretation?: string; closest?: SourceRef[] },
): Answer {
  const kept = facts.filter((f) => f.sources.length > 0);
  const sources = dedupeSources(kept.flatMap((f) => f.sources));
  const verified = distinctDocs(sources);
  const unverified = (opts.unverifiedDocIds ?? []).filter((id) => !verified.includes(id));
  const a: Answer = {
    kind: kept.length ? 'answer' : 'no-answer',
    text,
    facts: kept,
    sources,
    confidence: kept.length ? opts.confidence : 0,
    verifiedCount: verified.length,
    unverifiedCount: unverified.length,
    closest: opts.closest ?? [],
  };
  if (opts.entityId) a.entityId = opts.entityId;
  if (opts.interpretation) a.interpretation = opts.interpretation;
  return a;
}

export function noAnswer(text: string, closest: SourceRef[], opts: { unverifiedDocIds?: string[]; interpretation?: string } = {}): Answer {
  const a: Answer = {
    kind: 'no-answer',
    text,
    facts: [],
    sources: [],
    confidence: 0,
    verifiedCount: 0,
    unverifiedCount: opts.unverifiedDocIds?.length ?? 0,
    closest,
  };
  if (opts.interpretation) a.interpretation = opts.interpretation;
  return a;
}
