/**
 * Citations for the analytics executor (api/_lib/routes/analytics.js): the records are the SAME
 * already-filtered rows the count / list / breakdown / sum was computed from - never a second
 * query. Pure: rows in, contract fields out.
 */
import { dateBasisPhrase } from '../scope.js';
import { customerRecord, unitRecord, documentRecord, attachCitations, makeRecord } from './records.js';

const NOUN = {
  customers: 'customers', equipment: 'pieces of equipment', documents: 'documents',
  serviceVisits: 'service visits', warranties: 'warranty units',
};
const GROUP_WORD = {
  city: 'city', county: 'county', state: 'state', zip: 'ZIP code', brand: 'brand', documentType: 'document type',
  month: 'month', technician: 'technician', warrantyStatus: 'warranty status',
};

const asArray = (v) => (Array.isArray(v) ? v : [v]);

function describeFilter(entity, f) {
  const v = Array.isArray(f.value) ? f.value.join(' or ') : f.value;
  const place = entity === 'customers' ? 'whose service address is' : 'located';
  switch (f.field) {
    case 'city': return `${place} in ${v}`;
    case 'state': return `${place} in ${String(v).toUpperCase().length <= 2 ? String(v).toUpperCase() : v}`;
    case 'county': return `${place} in ${v}${/county/i.test(String(v)) ? '' : ' County'}`;
    case 'zip': return `${place} in ZIP ${v}`;
    case 'brand': return f.op === 'neq' ? `that are not ${v}` : `of brand ${v}`;
    case 'model': return `with model ${v}`;
    case 'equipmentType': return `of type ${v}`;
    case 'tonnage': return `with tonnage ${f.op === 'eq' ? '' : `${f.op} `}${v}`.trim();
    case 'refrigerant': return `using ${v}`;
    case 'installYear': return `installed ${f.op === 'eq' ? 'in' : f.op} ${v}`;
    case 'warrantyStatus': return `with a ${v} warranty`;
    case 'documentType': return `of type ${v}`;
    case 'technician': return `serviced by ${v}`;
    case 'customerName': return `named like ${v}`;
    case 'hasEmail': return f.value ? 'with an email on file' : 'missing an email address';
    case 'hasPhone': return f.value ? 'with a phone number on file' : 'missing a phone number';
    case 'hasDocType': return `that have a ${v} on file`;
    case 'lacksDocType': return `that have no ${v} on file`;
    default: return `where ${f.field} ${f.op} ${v}`;
  }
}

const filterPhrase = (plan) => (plan.filters ?? []).map((f) => describeFilter(plan.entity, f)).join(' and ');

/** ONE short sentence: how the number/list was computed. Deterministic, from the validated plan. */
export function analyticsBasis(plan, { timeRangeLabel = null, monthLabel = null, futureVisitCount = 0 } = {}) {
  const noun = NOUN[plan.entity] ?? plan.entity;
  if (plan.sortBy) {
    return `Ranked customers by ${plan.sortBy === 'documentCount' ? 'how many documents are linked to them' : 'how many pieces of equipment they own'}.`;
  }
  const verb = plan.op === 'count' ? 'Counted' : plan.op === 'groupBy' ? 'Counted' : plan.op === 'sum' ? 'Summed the tonnage of' : 'Listed';
  const filters = (plan.filters ?? []).map((f) => describeFilter(plan.entity, f));
  const when = timeRangeLabel ? ` ${timeRangeLabel}` : monthLabel ? ` in ${monthLabel}` : '';
  // Team A date semantics: state which date the time window used ("by upload date" / "by service date").
  const dateBasis = plan.entity === 'documents' && (timeRangeLabel || monthLabel || plan.groupBy === 'month')
    ? `, ${dateBasisPhrase(plan.dateBasis ?? 'service')}${plan.dateBasis === 'uploaded' ? '' : ' (upload date when none was extracted)'}`
    : plan.entity === 'serviceVisits' ? ', by service date' : '';
  const future = futureVisitCount > 0
    ? ` ${futureVisitCount} future-dated service record${futureVisitCount === 1 ? '' : 's'} (scheduled or mistyped dates) ${futureVisitCount === 1 ? 'is' : 'are'} not counted or cited.` : '';
  const by = plan.op === 'groupBy' ? `, grouped by ${GROUP_WORD[plan.groupBy] ?? plan.groupBy}` : '';
  return `${verb} ${noun}${filters.length ? ` ${filters.join(' and ')}` : ''}${when}${by}${dateBasis}.${future}`.replace(/\s+/g, ' ');
}

function recordFor(plan, row, group) {
  if (plan.entity === 'customers') {
    return customerRecord({ id: row.entityId ?? row.id, customer_name: row.customerName ?? row.label, address: row.value }, { group });
  }
  if (plan.entity === 'equipment' || plan.entity === 'warranties') {
    return unitRecord({ id: row.id, manufacturer: row.brand, equipment_type: row.equipmentType, model: row.model }, {
      label: row.label, sublabel: [row.model, [row.city, row.state].filter(Boolean).join(', '), row.warrantyStatus && plan.entity === 'warranties' ? `warranty ${row.warrantyStatus}` : null].filter(Boolean).join(' · '),
      customerId: row.entityId && row.entityId !== row.id ? row.entityId : undefined, group,
    });
  }
  // documents + serviceVisits: rows are documents.
  return documentRecord({ id: row.id, document_type: row.documentType }, {
    label: row.label, sublabel: [row.value, row.date && row.date !== row.value ? row.date : null].filter(Boolean).join(' · '), group,
  });
}

/**
 * Contract fields for one executed plan.
 * @param plan       the validated plan
 * @param o.rows     the FILTERED rows the answer was computed from
 * @param o.total    rows.length (asserted against the number the answer states)
 * @param o.keyOf    routes/analytics.js's keyOf(groupBy) for op 'groupBy'
 * @param o.groups   groupRows() output (its counts are asserted against the records per group)
 * @param o.unfilteredRows  every row of the entity before filters (for an honest zero: what was searched)
 */
export function analyticsCitations(plan, { rows = [], total = rows.length, keyOf = null, groups = [], unfilteredRows = null, timeRangeLabel = null, monthLabel = null, futureVisitCount = 0, claimedCount = total } = {}) {
  const basis = analyticsBasis(plan, { timeRangeLabel, monthLabel, futureVisitCount });
  if (total === 0 && unfilteredRows && unfilteredRows.length) {
    return {
      records: unfilteredRows.map((r) => recordFor(plan, r)), total: unfilteredRows.length, kind: 'searched',
      basis: `Searched all ${unfilteredRows.length} ${NOUN[plan.entity] ?? plan.entity} on file${filterPhrase(plan) ? ` for ones ${filterPhrase(plan)}` : ''}; none found.`,
    };
  }
  const grouped = plan.op === 'groupBy' && typeof keyOf === 'function';
  const records = rows.map((r) => recordFor(plan, r, grouped ? keyOf(r) : undefined));
  // Per-group assertion: the group counts the breakdown states must equal the rows carrying that key.
  let claimed = claimedCount;
  if (grouped && groups.length) {
    const byKey = new Map();
    for (const r of records) byKey.set(r.group, (byKey.get(r.group) ?? 0) + 1);
    const ok = groups.every((g) => (byKey.get(String(g.key)) ?? 0) === g.count);
    if (!ok) claimed = -1; // forces an honest mismatch note
  }
  return { records, total, basis, claimedCount: claimed, kind: 'basis' };
}

/** Apply analyticsCitations() to an answer and return it. */
export function withAnalyticsCitations(data, plan, opts) {
  if (!data || typeof data !== 'object') return data;
  return attachCitations(data, analyticsCitations(plan, opts));
}

export { makeRecord, asArray };
