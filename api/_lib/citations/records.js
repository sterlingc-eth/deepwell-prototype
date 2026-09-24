/**
 * The citation contract for EVERY /api/ask response (kind 'answer' | 'no-answer').
 *
 * Existing fields are untouched (`sources`, `facts[].sources`). This adds:
 *
 *   records       drill-down list of the exact rows an aggregate was computed from:
 *                 {type:'customer'|'unit'|'document'|'invoice', id, label, sublabel?,
 *                  documentId?, page?, customerId?, group?}
 *                 Capped at MAX_RECORDS. `group` carries the breakdown key so the UI can filter.
 *   recordsTotal  the TRUE number of rows behind the answer (>= records.length when capped).
 *   recordsKind   'basis' (rows the answer is computed from) | 'searched' (rows that were
 *                 searched and did not contain the answer: an honest zero).
 *   basis         ONE short sentence saying how the answer was computed.
 *
 * Honesty rule: a producer that states a count passes `claimedCount`; when it disagrees with the
 * rows actually found (`total`) the disagreement is counted (citationStats), logged as a bare
 * counter (never question text) and SAID in `basis` - the listed rows are authoritative.
 *
 * Pure module: no db, no model, no logging of content.
 */

export const MAX_RECORDS = 200;
export const RECORD_TYPES = Object.freeze(['customer', 'unit', 'document', 'invoice']);

/** In-process counters (tests read them; the log line is the production signal). */
export const citationStats = { countMismatch: 0, derived: 0, defaulted: 0, capped: 0 };

const clip = (v, n) => {
  if (v == null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined;
};

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One normalised record, or null when it has no usable type/id. */
export function makeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const type = RECORD_TYPES.includes(r.type) ? r.type : null;
  const id = r.id == null ? null : String(r.id);
  if (!type || !id) return null;
  const label = clip(r.label, 140) ?? (type === 'customer' ? 'Customer' : type === 'unit' ? 'Equipment' : type === 'invoice' ? 'Invoice' : 'Document');
  const out = { type, id, label };
  const sub = clip(r.sublabel, 200);
  if (sub) out.sublabel = sub;
  const documentId = r.documentId ?? (type === 'document' || type === 'invoice' ? id : undefined);
  if (documentId) out.documentId = String(documentId);
  if (Number.isFinite(Number(r.page)) && r.page != null && Number(r.page) > 0) out.page = Math.trunc(Number(r.page));
  if (r.customerId) out.customerId = String(r.customerId);
  const group = clip(r.group, 120);
  if (group !== undefined) out.group = group;
  return out;
}

export function customerRecord(row, extra = {}) {
  const id = row?.id ?? row?.customer_id ?? row?.entityId;
  const name = row?.customer_name ?? row?.name ?? row?.label ?? row?.customerName;
  return makeRecord({
    type: 'customer', id, label: name || 'Unnamed customer',
    sublabel: extra.sublabel ?? row?.service_address ?? row?.address ?? row?.value,
    group: extra.group,
  });
}

export function unitRecord(row, extra = {}) {
  const id = row?.id ?? row?.equipment_id;
  const label = extra.label ?? ([row?.manufacturer, row?.equipment_type].filter(Boolean).join(' ') || 'Equipment');
  const sub = extra.sublabel ?? [row?.model, row?.serial_number ? `serial ${row.serial_number}` : null].filter(Boolean).join(' · ');
  return makeRecord({ type: 'unit', id, label, sublabel: sub, customerId: extra.customerId ?? row?.customer_id, group: extra.group });
}

export function documentRecord(row, extra = {}) {
  const id = row?.id ?? row?.document_id ?? row?.documentId;
  const isInvoice = extra.type === 'invoice' || row?.document_type === 'invoice' || row?.doc_kind === 'invoice';
  return makeRecord({
    type: isInvoice ? 'invoice' : 'document', id,
    label: extra.label ?? row?.label ?? row?.original_filename ?? row?.filename ?? 'Document',
    sublabel: extra.sublabel, documentId: id, page: extra.page, group: extra.group,
  });
}

/** Cap to `max`; with group keys, round-robin so every group survives the cut. */
export function capRecords(records, max = MAX_RECORDS) {
  if (records.length <= max) return records;
  citationStats.capped++;
  const grouped = records.some((r) => r.group !== undefined);
  if (!grouped) return records.slice(0, max);
  const buckets = new Map();
  for (const r of records) {
    const k = r.group ?? '';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const lists = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < max; i++) {
    let any = false;
    for (const l of lists) { if (i < l.length && out.length < max) { out.push(l[i]); any = true; } }
    if (!any) break;
  }
  return out;
}

function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const k = `${r.type}:${r.id}:${r.group ?? ''}:${r.page ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function logCounter(name, kind) {
  // Counter only: no question text, no row values.
  console.log(JSON.stringify({ route: 'ask', citations: name, kind: String(kind ?? 'answer') }));
}

/**
 * Attach the contract to `data` (mutates and returns it).
 * @param {object} data
 * @param {{records?: object[], total?: number, basis?: string, claimedCount?: number|null,
 *          kind?: 'basis'|'searched'}} opts
 */
export function attachCitations(data, { records = [], total, basis, claimedCount = null, kind = 'basis' } = {}) {
  if (!data || typeof data !== 'object') return data;
  const normalised = dedupe(records.map((r) => makeRecord(r)).filter(Boolean));
  let trueTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : normalised.length;
  if (trueTotal < normalised.length) trueTotal = normalised.length; // a producer can never list more than exist
  const capped = capRecords(normalised, MAX_RECORDS);
  let sentence = clip(basis, 320) ?? '';
  if (Number.isFinite(claimedCount) && kind === 'basis' && claimedCount !== trueTotal) {
    citationStats.countMismatch++;
    logCounter('count_mismatch', data.kind);
    sentence = `${sentence ? `${sentence.replace(/[.\s]+$/, '')}. ` : ''}Note: the figure stated is ${claimedCount} but ${trueTotal} matching record${trueTotal === 1 ? '' : 's'} could be listed; treat the listed records as authoritative.`;
  }
  data.records = capped;
  data.recordsTotal = trueTotal;
  data.recordsKind = kind;
  if (sentence) data.basis = sentence;
  return data;
}

/* ------------------------------------------------------------------ derivation + defaults */

const NOUN = {
  customer: ['customer', 'customers'],
  unit: ['piece of equipment', 'pieces of equipment'],
  document: ['document', 'documents'],
  invoice: ['invoice', 'invoices'],
};

function nounFor(records, total) {
  const types = [...new Set(records.map((r) => r.type))];
  const t = types.length === 1 ? types[0] : null;
  if (!t) return total === 1 ? 'record' : 'records';
  return NOUN[t][total === 1 ? 0 : 1];
}

/** Records derivable from what an answer already carries: fact.entityId + every source. */
export function deriveRecords(data) {
  const out = [];
  const facts = Array.isArray(data.facts) ? data.facts : [];
  const seenEntity = new Set();
  for (const f of facts) {
    if (f && typeof f.entityId === 'string' && f.entityId && !seenEntity.has(f.entityId)) {
      seenEntity.add(f.entityId);
      // Type is unknown until enrich.js resolves it against the tenant's own rows.
      out.push({ type: 'customer', id: f.entityId, label: '', sublabel: undefined, _derived: true });
    }
  }
  const refs = [...(Array.isArray(data.sources) ? data.sources : []), ...facts.flatMap((f) => (Array.isArray(f?.sources) ? f.sources : []))];
  const seenDoc = new Set();
  for (const s of refs) {
    if (!s || typeof s.documentId !== 'string' || !s.documentId) continue;
    const page = Number(s.location?.page);
    const key = `${s.documentId}:${Number.isFinite(page) ? page : ''}`;
    if (seenDoc.has(key)) continue;
    seenDoc.add(key);
    out.push({
      type: 'document', id: s.documentId, documentId: s.documentId,
      page: Number.isFinite(page) && page > 0 ? page : undefined,
      label: s.filename || '', sublabel: s.location?.field && s.location.field !== 'document' ? String(s.location.field).replace(/_/g, ' ') : undefined,
      _derived: !s.filename,
    });
  }
  return out;
}

/**
 * Default one-sentence basis when a producer did not state one. Deterministic, from the shape of
 * the answer only (never model text).
 */
export function defaultBasis(data, records, total) {
  const nDocs = new Set(records.filter((r) => r.documentId).map((r) => r.documentId)).size;
  if (data.kind === 'no-answer') return 'Searched your records; nothing matched, so there is nothing to cite.';
  if (records.length === 0) return 'Answered by Donovan directly; no individual records were involved.';
  if (records.every((r) => r.type === 'customer') && total === 1) {
    return `Read from the customer record on file for ${records[0].label || 'this customer'}.`;
  }
  if (records.every((r) => r.type === 'customer')) return `Based on ${total} customer record${total === 1 ? '' : 's'} matching your question.`;
  if (nDocs && nDocs === records.length) return `Cited from ${nDocs} document${nDocs === 1 ? '' : 's'} on file; open one to see the page.`;
  return `Based on ${total} ${nounFor(records, total)} in your records.`;
}

const isRecordArray = (v) => Array.isArray(v) && v.every((r) => r && typeof r === 'object' && typeof r.id === 'string');

/**
 * Last-resort, synchronous guarantee that a response carries the contract. Idempotent. Anything a
 * producer (or enrich.js) already attached is kept; only what is missing is derived or defaulted.
 * Called from api/ask.js's `send` for every response body that has a `data` object.
 */
export function finalizeCitations(data) {
  if (!data || typeof data !== 'object' || (data.kind !== 'answer' && data.kind !== 'no-answer')) return data;
  if (!isRecordArray(data.records)) {
    citationStats.derived++;
    const derived = deriveRecords(data).map((r) => makeRecord({ ...r, label: r.label || (r.type === 'customer' ? 'Customer record' : 'Document') })).filter(Boolean);
    data.records = capRecords(dedupe(derived), MAX_RECORDS);
    data.recordsTotal = data.records.length;
    data.recordsKind = 'basis';
  } else {
    if (!Number.isFinite(data.recordsTotal) || data.recordsTotal < data.records.length) data.recordsTotal = data.records.length;
    if (data.recordsKind !== 'searched') data.recordsKind = 'basis';
    if (data.records.length > MAX_RECORDS) data.records = capRecords(data.records, MAX_RECORDS);
  }
  if (typeof data.basis !== 'string' || !data.basis.trim()) {
    citationStats.defaulted++;
    data.basis = defaultBasis(data, data.records, data.recordsTotal);
  }
  return data;
}

export { UUIDISH };
