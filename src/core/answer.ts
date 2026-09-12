/**
 * Small helpers shared by every domain's answer logic.
 */
import type { Answer, Entity, Fact, FieldValue, SourceRef } from './types';

export const str = (e: Entity | undefined, key: string): string => {
  const v = e?.fields[key];
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
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

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return `$${n.toLocaleString('en-US')}`;
}
export function fmtValue(v: FieldValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
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
