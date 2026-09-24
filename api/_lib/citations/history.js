/**
 * TEAM C: citations for Team A's deterministic producers (deterministicRouter.js, comparison.js, maintenanceDue.js,
 * customerFile.js notes). Each helper takes the SAME rows the answer was computed from and returns contract fields
 * (records / recordsTotal / recordsKind / basis) via attachCitations. Pure except `citeSearched`, which labels a list
 * of already-tenant-scoped document ids.
 *
 * Time semantics (Team A, scope.js): every visit/date basis is stated in `basis` ("by service date" / "by upload
 * date"), and future-dated service records are NEVER listed as records - they are only mentioned.
 */
import { attachCitations, customerRecord, unitRecord, documentRecord } from './records.js';
import { documentRecordsFor, labelDocuments } from './enrich.js';
import { documentTypeLabel } from '../documentTypes.js';
import { humanDate, normalizeTypeId, dateBasisPhrase } from '../scope.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** " 2 future-dated service records (scheduled or mistyped dates) are not counted or cited." or "". */
export function futureClause(future) {
  const n = Array.isArray(future) ? new Set(future.map((v) => v.documentId ?? v)).size : 0;
  return n ? ` ${plural(n, 'future-dated service record')} (scheduled or mistyped dates) ${n === 1 ? 'is' : 'are'} not counted or cited.` : '';
}

/** One visit -> one document record ("Service ticket · file.pdf", "Sep 4, 2026 · tech D. Ramirez"). */
export function visitRecord(v, extra = {}) {
  const type = documentTypeLabel(normalizeTypeId(v.documentType));
  return documentRecord({ id: v.documentId, document_type: v.documentType }, {
    label: `${type} · ${v.filename ?? v.documentId}`,
    sublabel: [humanDate(v.date), v.technician ? `tech ${v.technician}` : null, v.customerName].filter(Boolean).join(' · '),
    ...extra,
  });
}

/** Distinct documents behind a visit list (a document with two service dates is one record). */
export const distinctVisitDocs = (visits) => new Set((visits ?? []).map((v) => v.documentId)).size;

/** Records for a scope's units (equipment entity rows: {id, customer_id, data}). */
export function scopeUnitRecords(units) {
  return (units ?? []).map((e) => unitRecord({
    id: e.id, manufacturer: e.data?.manufacturer, equipment_type: e.data?.equipment_type, model: e.data?.model,
    serial_number: e.data?.serial_number, customer_id: e.customer_id,
  }, { sublabel: [e.data?.model, e.data?.serial_number ? `serial ${e.data.serial_number}` : null, e.data?.installation_date ? `installed ${e.data.installation_date}` : null].filter(Boolean).join(' · ') }));
}

/** Visits behind an answer: records = the past (counted) visits only; future ones are mentioned in the basis. */
export function citeVisits(data, past, future, { basis, total, claimedCount } = {}) {
  const n = distinctVisitDocs(past);
  return attachCitations(data, {
    records: (past ?? []).map((v) => visitRecord(v)), total: total ?? n, claimedCount: claimedCount ?? null,
    basis: `${basis}${futureClause(future)}`,
  });
}

/** An honest zero: records = the documents that WERE searched (labelled from the tenant's own rows). */
export async function citeSearched(db, data, ids, { basis, future = [], fallbackRecords = [] } = {}) {
  const list = [...new Set(ids ?? [])];
  const records = list.length ? await documentRecordsFor(db, list) : fallbackRecords;
  return attachCitations(data, {
    records, total: list.length || fallbackRecords.length, kind: 'searched', basis: `${basis}${futureClause(future)}`,
  });
}

/** Notes answer (customerFile.js buildNotesAnswer): the documents behind every note / work item / excerpt / reminder. */
export async function citeNotes(db, data, label, nd) {
  const refs = [];
  const add = (documentId, what, page) => { if (documentId) refs.push({ documentId, what, page }); };
  for (const n of nd.notes ?? []) add(n.documentId, 'notes');
  for (const w of nd.work ?? []) add(w.documentId, 'work performed');
  for (const p of nd.passages ?? []) add(p.documentId, 'excerpt', p.page);
  for (const r of nd.reminders ?? []) add(r.documentId, 'open reminder');
  let labels = new Map();
  try { labels = await labelDocuments(db, [...new Set(refs.map((r) => r.documentId))]); } catch { labels = new Map(); }
  const records = refs.map((r) => {
    const d = labels.get(String(r.documentId).toLowerCase());
    const raw = d?.service_date ?? d?.created_at;
    const date = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? '').slice(0, 10);
    return documentRecord(d ?? { id: r.documentId }, {
      label: d ? `${documentTypeLabel(normalizeTypeId(d.document_type))} · ${d.original_filename ?? r.documentId}` : 'Document',
      sublabel: [r.what, /^\d{4}-\d{2}-\d{2}$/.test(date) ? humanDate(date) : null].filter(Boolean).join(' · '), page: r.page,
    });
  });
  const distinct = new Set(refs.map((r) => r.documentId)).size;
  const searched = (nd.ids ?? []).length;
  // Honest zero: cite the documents that WERE searched.
  const searchedRecords = records.length || !searched ? [] : await documentRecordsFor(db, nd.ids);
  return attachCitations(data, {
    records: records.length ? records : searchedRecords, total: records.length || searched, kind: records.length ? 'basis' : 'searched',
    basis: records.length
      ? `Read the notes, work performed and open reminders recorded in ${plural(distinct, 'document')} for ${label} (of ${plural(searched, 'document')} searched); dated by service date where the document has one, else upload date.`
      : `Searched ${plural(searched, 'document')} for ${label}; no notes or findings recorded.`,
  });
}

/** Maintenance-due answer: one customer record per listed customer, grouped by overdue / coming due. */
export function maintenanceCitations(res, listed) {
  const rec = (e, group) => customerRecord({ id: e.customerId, customer_name: e.name, service_address: e.address }, {
    group,
    sublabel: [e.lastVisit ? `last ${e.lastIsPm ? 'maintenance' : 'service'} ${humanDate(e.lastVisit.date)}` : 'no visit on file', e.nextDue && res.mode === 'cadence' ? `due ${humanDate(e.nextDue)}` : null].filter(Boolean).join(' · '),
  });
  const basis = res.mode === 'window'
    ? `Compared the last service visit on or before today (${dateBasisPhrase('service')}) of each of the ${res.considered} customers with a maintenance agreement or visit on file against the cut-off${res.cutoff ? ` ${humanDate(res.cutoff)}` : ''}.`
    : `Compared the last visit on or before today (${dateBasisPhrase('service')}) plus the agreement cadence for each of the ${res.considered} customers on a maintenance agreement or with maintenance history.`;
  const future = futureClause(res.futureVisits);
  if (listed.length) {
    return {
      records: [...res.overdue.map((e) => rec(e, 'overdue')), ...res.comingDue.map((e) => rec(e, 'due soon'))],
      total: listed.length, claimedCount: listed.length, basis: `${basis}${future}`, kind: 'basis',
    };
  }
  // None overdue: cite the customers that were checked.
  return { records: (res.checked ?? []).map((e) => rec(e, 'on schedule')), total: res.considered, kind: 'searched', basis: `${basis}${future}` };
}

/**
 * Comparison answer. `side` rows are {a: [...], b: [...]} record lists (already labelled, grouped by side label);
 * counts are the stated numbers. Comparisons are over all records on file (no date filter).
 */
export function comparisonCitations(intent, counts) {
  const noun = { doctype: 'documents', brand: 'equipment units', city: 'customers', entity: 'records' }[intent.kind] ?? 'records';
  const total = (counts.a ?? 0) + (counts.b ?? 0);
  return {
    records: counts.records ?? [], total, claimedCount: total, kind: 'basis',
    basis: `Counted ${intent.a.label} (${counts.a}) and ${intent.b.label} (${counts.b}) across all ${noun} on file, with no date filter; every counted record is listed.`,
  };
}
