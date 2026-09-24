/**
 * Pure helpers for the citation contract every /api/ask answer carries (api/_lib/citations/records.js):
 * validating the wire shape and the small view-logic behind the "Based on N records · view" panel.
 * No DOM, no store, no network: unit-tested in scripts/verify-citations.mjs.
 */
import type { Answer, AnswerRecord, AnswerRecordType } from './types';

const TYPES: ReadonlySet<string> = new Set<AnswerRecordType>(['customer', 'unit', 'document', 'invoice']);

/** Defends against a malformed response; the server is the trust boundary (tenant-scoped rows only). */
export function normalizeCitations(a: Partial<Answer>): Pick<Answer, 'records' | 'recordsTotal' | 'recordsKind' | 'basis'> {
  const out: Pick<Answer, 'records' | 'recordsTotal' | 'recordsKind' | 'basis'> = {};
  if (Array.isArray(a.records)) {
    const records: AnswerRecord[] = [];
    for (const r of a.records as unknown[]) {
      const x = r as Partial<AnswerRecord> | null;
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || typeof x.type !== 'string' || !TYPES.has(x.type)) continue;
      const rec: AnswerRecord = { type: x.type as AnswerRecordType, id: x.id, label: typeof x.label === 'string' && x.label ? x.label : x.type };
      if (typeof x.sublabel === 'string' && x.sublabel) rec.sublabel = x.sublabel;
      if (typeof x.documentId === 'string' && x.documentId) rec.documentId = x.documentId;
      if (typeof x.page === 'number' && Number.isFinite(x.page) && x.page > 0) rec.page = x.page;
      if (typeof x.customerId === 'string' && x.customerId) rec.customerId = x.customerId;
      if (typeof x.group === 'string') rec.group = x.group;
      records.push(rec);
    }
    out.records = records;
    out.recordsTotal = typeof a.recordsTotal === 'number' && Number.isFinite(a.recordsTotal) ? Math.max(a.recordsTotal, records.length) : records.length;
  }
  if (a.recordsKind === 'searched' || a.recordsKind === 'basis') out.recordsKind = a.recordsKind;
  if (typeof a.basis === 'string' && a.basis.trim()) out.basis = a.basis.trim();
  return out;
}

/** Distinct group keys, in first-seen order (the server orders groups largest first). */
export function recordGroups(records: readonly AnswerRecord[]): string[] {
  const seen: string[] = [];
  for (const r of records) if (r.group !== undefined && !seen.includes(r.group)) seen.push(r.group);
  return seen;
}

/** Records matching the free-text query and (optionally) one breakdown group. */
export function filterRecords(records: readonly AnswerRecord[], query: string, group: string | null): AnswerRecord[] {
  const q = query.trim().toLowerCase();
  return records.filter((r) => {
    if (group !== null && r.group !== group) return false;
    if (!q) return true;
    return `${r.label} ${r.sublabel ?? ''} ${r.group ?? ''}`.toLowerCase().includes(q);
  });
}

const NOUN: Record<AnswerRecordType, [string, string]> = {
  customer: ['customer', 'customers'],
  unit: ['piece of equipment', 'pieces of equipment'],
  document: ['document', 'documents'],
  invoice: ['invoice', 'invoices'],
};

/** "19 customers" / "6 documents" / "4 records" (mixed types). */
export function recordsNoun(records: readonly AnswerRecord[], total: number): string {
  const types = [...new Set(records.map((r) => r.type))];
  const only = types.length === 1 ? types[0] : undefined;
  const [one, many] = only ? NOUN[only] : ['record', 'records'];
  return `${total} ${total === 1 ? one : many}`;
}

/** The disclosure button's text: "Based on 19 customers · view" / "Searched 6 documents · view". */
export function recordsHeading(answer: Pick<Answer, 'records' | 'recordsTotal' | 'recordsKind'>): string {
  const records = answer.records ?? [];
  const total = answer.recordsTotal ?? records.length;
  return `${answer.recordsKind === 'searched' ? 'Searched' : 'Based on'} ${recordsNoun(records, total)}`;
}

/**
 * Whether the drill-down panel adds anything: hidden when every record is just a document the
 * Sources list below already shows and there is no breakdown to filter.
 */
export function showRecordsPanel(answer: Pick<Answer, 'records' | 'sources' | 'kind' | 'recordsKind'>): boolean {
  const records = answer.records ?? [];
  if (!records.length) return false;
  if (recordGroups(records).length) return true;
  if (answer.kind === 'no-answer' && answer.recordsKind !== 'searched') return false;
  const cited = new Set(answer.sources.map((s) => s.documentId));
  return !records.every((r) => (r.type === 'document' || r.type === 'invoice') && cited.has(r.documentId ?? r.id));
}

export type RecordTarget =
  | { kind: 'document'; documentId: string; page?: number }
  | { kind: 'customer'; ref: string }
  | { kind: 'entity'; id: string };

/** Where clicking a record goes: customer profile, a unit's customer, or the document at its cited page. */
export function recordTarget(r: AnswerRecord): RecordTarget {
  if (r.type === 'document' || r.type === 'invoice') {
    const documentId = r.documentId ?? r.id;
    return { kind: 'document', documentId, ...(r.page ? { page: r.page } : {}) };
  }
  if (r.type === 'customer') return { kind: 'customer', ref: r.id };
  return r.customerId ? { kind: 'customer', ref: r.customerId } : { kind: 'entity', id: r.id };
}
