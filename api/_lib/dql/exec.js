/**
 * dql/exec.js - the generic executor: filter -> (the op's family computes) over the snapshot. Pure; no database, no model.
 *
 * Rules that hold for every op:
 *  - a filter that names a customer whose name is on file more than once abstains (the existing clarify path asks which one);
 *  - a row without the filtered/dated/measured value is NEVER counted as matching it and never guessed (it is reported as "left out");
 *  - ties are returned whole, never cut;
 *  - an empty selection is a real result ("none"), not an error.
 */
import { ENTITIES, brandKey, yearsBetween } from './fields.js';
import { familyForOp } from './registry.js';

const lc = (v) => (v == null ? null : String(v).toLowerCase().trim());

export function fieldDef(entity, id) { return ENTITIES[entity]?.fields?.[id] ?? null; }

export function valueOf(row, entity, id, snap, today) {
  const def = fieldDef(entity, id);
  if (!def) return undefined;
  return def.get(row, snap, today);
}

const cmpKey = (def, v) => (def?.key ? def.key(v) : lc(v));

/** Does `row` satisfy one filter? Unknown field or missing value => false (never a guess). */
export function matchFilter(row, f, entity, snap, today) {
  const def = fieldDef(entity, f.field);
  if (!def) return false;
  const v = def.get(row, snap, today, f);
  if (def.kind === 'bool') return f.op === 'eq' ? v === true : f.op === 'neq' ? v === false : false;
  if (f.op === 'missing') return v == null || v === '';
  if (f.op === 'present') return !(v == null || v === '');
  if (v == null || v === '') return f.op === 'neq' ? false : false;
  if (def.kind === 'num') {
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
    switch (f.op) {
      case 'eq': return Math.abs(n - Number(f.value)) < 1e-9;
      case 'neq': return Math.abs(n - Number(f.value)) >= 1e-9;
      case 'gt': return n > Number(f.value);
      case 'gte': return n >= Number(f.value);
      case 'lt': return n < Number(f.value);
      case 'lte': return n <= Number(f.value);
      case 'between': return n >= Number(f.value[0]) && n <= Number(f.value[1]);
      case 'outside': return n < Number(f.value[0]) || n > Number(f.value[1]);
      default: return false;
    }
  }
  if (def.kind === 'date') {
    const d = String(v).slice(0, 10);
    switch (f.op) {
      case 'eq': return d === f.value;
      case 'gt': return d > f.value;
      case 'gte': return d >= f.value;
      case 'lt': return d < f.value;
      case 'lte': return d <= f.value;
      case 'between': return d >= f.value[0] && d <= f.value[1];
      default: return false;
    }
  }
  const a = cmpKey(def, v);
  switch (f.op) {
    case 'eq': return a === cmpKey(def, f.value);
    case 'neq': return a !== cmpKey(def, f.value);
    case 'in': return f.value.some((x) => a === cmpKey(def, x));
    case 'notin': return !f.value.some((x) => a === cmpKey(def, x));
    default: return false;
  }
}

/** The rows of the plan's entity that satisfy docType / visit / filters / time. {rows, leftOut} or {abstain}. */
export function selectRows(plan, snap, today) {
  const entity = plan.entity;
  const E = ENTITIES[entity];
  if (!E) return { abstain: 'entity' };
  let rows = E.rows(snap);

  // ambiguous customer names on file => abstain (clarify path)
  for (const f of plan.filters ?? []) {
    if (f.field === 'customer' && f.op === 'eq') {
      const same = snap.customers.filter((c) => lc(c.name) === lc(f.value));
      if (same.length > 1) return { abstain: 'ambiguous-name', name: f.value };
      if (same.length === 0 && entity !== 'customer') { /* name not on file: an honest empty selection below */ }
    }
  }
  if (entity === 'document') {
    // a kind of paper this organization has never filed is not "zero": the question may be about something it does not keep at all
    // (a lease is the exception: a company with no lease papers has none, and the older lanes would read the word as a maintenance agreement)
    if (plan.docType && plan.docType !== 'lease-agreement' && plan.docType !== 'other' && ![].concat(plan.docType).some((t) => snap.documents.some((d) => d.type === t))) return { abstain: 'type-not-on-file' };
    if (plan.docType) {
      const set = new Set([].concat(plan.docType));
      rows = rows.filter((d) => set.has(d.type));
    }
    if (plan.visit) rows = rows.filter((d) => d.serviceDate != null);
  }
  for (const f of plan.filters ?? []) rows = rows.filter((r) => matchFilter(r, f, entity, snap, today));
  let leftOut = 0;
  if (plan.time) {
    const def = fieldDef(entity, plan.time.field);
    if (!def) return { abstain: 'time-field' };
    const keep = [];
    for (const r of rows) {
      const v = def.get(r, snap, today);
      if (v == null) { leftOut++; continue; }
      const d = String(v).slice(0, 10);
      if (d >= plan.time.from && d <= plan.time.to) keep.push(r);
    }
    rows = keep;
  }
  // a very recent window (today, yesterday, this/last week) with nothing in it is more often "the paperwork is not in yet" than "none": released
  if (plan.time && !rows.length && /^(?:today|yesterday|this week|last week)$/i.test(plan.time.label)) return { abstain: 'empty-recent-window' };
  return { rows, leftOut };
}

/* ------------------------------------------------------------------ measures and groups */

export function measureValue(row, plan, snap, today) {
  const m = plan.measure;
  if (!m) return null;
  const v = valueOf(row, plan.entity, m.field, snap, today);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function aggregate(values, agg) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  if (!xs.length) return null;
  switch (agg) {
    case 'sum': return xs.reduce((a, b) => a + b, 0);
    case 'avg': return xs.reduce((a, b) => a + b, 0) / xs.length;
    case 'min': return Math.min(...xs);
    case 'max': return Math.max(...xs);
    case 'median': { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    default: return null;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTHS[m - 1];

/** The group key of a row for one dimension {by, field?}; null when the row has no value for it (those rows are reported as left out). */
export function dimKey(row, dim, plan, snap, today) {
  const E = ENTITIES[plan.entity];
  const by = dim.by;
  if (['year', 'month', 'quarter', 'monthOfYear', 'weekday'].includes(by)) {
    const field = dim.field ?? plan.time?.field ?? E.defaultDate;
    const v = field ? valueOf(row, plan.entity, field, snap, today) : null;
    const d = v ? String(v).slice(0, 10) : null;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    if (by === 'year') return d.slice(0, 4);
    if (by === 'month') return d.slice(0, 7);
    if (by === 'monthOfYear') return d.slice(5, 7);
    if (by === 'weekday') return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${d}T00:00:00Z`).getUTCDay()];
    return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  }
  const def = fieldDef(plan.entity, by);
  if (!def) return null;
  const v = def.get(row, snap, today);
  if (v == null || v === '') return null;
  if (def.key) {
    // brand: group under the canonical label, never the raw spelling
    return String(def.key(v) ?? v);
  }
  return String(v);
}

export function dimLabel(by, key) {
  if (by === 'monthOfYear') return monthName(Number(key));
  if (by === 'month') { const [y, m] = key.split('-'); return `${monthName(Number(m))} ${y}`; }
  return key;
}

/** rows -> Map(key -> rows[]) over one or two dimensions (keys joined with ' | '); {groups, leftOut}. */
export function groupRows(rows, plan, snap, today) {
  const dims = plan.groupBy ?? [];
  const groups = new Map();
  let leftOut = 0;
  for (const r of rows) {
    const parts = dims.map((d) => dimKey(r, d, plan, snap, today));
    if (parts.some((p) => p == null)) { leftOut++; continue; }
    const k = parts.join(' | ');
    if (!groups.has(k)) groups.set(k, { parts, rows: [] });
    groups.get(k).rows.push(r);
  }
  return { groups, leftOut };
}

/** Display text for a dimension key: canonical brand labels keep their casing from the data. */
export function displayKey(plan, dimIdx, key, snap) {
  const dim = plan.groupBy[dimIdx];
  if (dim.by === 'brand') {
    const row = (plan.entity === 'unit' ? snap.units : snap.documents).find((r) => brandKey(r.brand) === key);
    return row ? row.brand : key;
  }
  if (dim.by === 'type') return key;
  if (['tech', 'city', 'customer', 'vendor', 'status', 'serviceType', 'refrigerant', 'model', 'equipmentType'].includes(dim.by)) {
    const E = ENTITIES[plan.entity];
    const def = E.fields[dim.by];
    // original casing: first row whose value lower-cases to the key
    const row = E.rows(snap).find((r) => { const v = def?.get(r, snap, snap.today); return v != null && String(v).toLowerCase() === String(key).toLowerCase(); });
    const v = row ? def.get(row, snap, snap.today) : null;
    return v ?? key;
  }
  return dimLabel(dim.by, key);
}

export { yearsBetween };

/** Execute a plan over a snapshot. Returns the family's result, or {abstain: why}. */
export function execute(plan, snap, { today } = {}) {
  const fam = familyForOp(plan?.op);
  if (!fam) return { abstain: 'op' };
  const t = today ?? snap.today;
  const helpers = { selectRows, measureValue, aggregate, groupRows, dimKey, displayKey, valueOf, fieldDef, matchFilter };
  return fam.exec(plan, { snap, today: t, h: helpers });
}
