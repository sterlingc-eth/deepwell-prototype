/**
 * learned/planmap.js - the written table that maps the question factory's plan vocabulary (rec.family / rec.plan, from
 * /home/claude/work/factory) onto DQL's plan vocabulary (parse.js plans: op / entity / measure / docType / groupBy), as HEAD LABELS.
 *
 *   factoryHeads(rec)  -> {op, measure, entity, doc, group}   label of a factory question (training targets)
 *   dqlHeads(plan)     -> {op, measure, entity, doc, group}   the same labels read off a DQL plan (runtime cross-check)
 *
 * Both sides use ONE label vocabulary (OPS / MEASURES / ENTITIES / DOCS / DIMS below), so a prediction of the model can be compared with the
 * plan the deterministic families built. Pure; no data; no model. scripts/verify-dql-learned.mjs tests the table.
 */

export const OPS = ['count', 'count_distinct', 'list', 'sum', 'avg', 'min', 'max', 'median', 'group', 'pivot', 'top', 'bottom', 'latest', 'first',
  'exists', 'share', 'per_entity', 'compare', 'series', 'since', 'between', 'inactive', 'expiry', 'age', 'dup', 'missing', 'text', 'line',
  'find', 'lookup', 'set_select', 'set_above', 'set_rank', 'set_ratio', 'decline', 'clarify', 'followup', 'other'];
export const MEASURES = ['none', 'money', 'date', 'ident', 'text', 'untracked'];
export const ENTITIES = ['document', 'customer', 'unit', 'other'];
export const DOCS = ['none', 'one', 'pair'];
export const DIMS = ['none', 'year', 'month', 'quarter', 'weekday', 'city', 'customer', 'tech', 'vendor', 'status', 'serviceType', 'brand', 'other', 'two'];

/** factory `family` -> op label (a function when the family needs the plan: min vs max, top vs bottom, first vs last ...). */
const FAMILY_OP = {
  doc_above_avg: 'set_above', cust_above_avg: 'set_above', age_of: 'age', avg: 'avg', median: 'median', sum: 'sum',
  minmax: (p) => (p.args?.fn === 'min' ? 'min' : 'max'),
  clarify: 'clarify', followup2: 'followup', followup3: 'followup',
  nearmiss: (p) => (p.op === 'agg' ? { sum: 'sum', avg: 'avg', min: 'min', max: 'max', median: 'median' }[p.args?.fn] ?? 'sum' : 'count'),
  count: 'count', docs_all: 'count', eq_count: 'count', count_range: 'count', cust_count: 'count', cust_total: 'count',
  count_distinct: 'count_distinct', cust_list: 'list', list_dim: 'list', list_numbers: 'list', eq_models: 'list',
  cust_never: 'set_select', cust_repeat: 'set_select',
  days_docs: 'between', days_span: 'between', untracked: 'decline', pay: 'decline', pay_owing: 'decline',
  dup_names: 'dup', dup_numbers: 'dup', exists: 'exists', expiring: 'expiry',
  extreme_num: 'find', find_date: 'find', find_total: 'find',
  extreme_cust: (p) => (p.args?.which === 'first' ? 'first' : 'latest'), extreme_date: (p) => (p.args?.which === 'first' ? 'first' : 'latest'),
  extreme_tech: (p) => (p.args?.which === 'first' ? 'first' : 'latest'), extreme_total: (p) => (p.args?.which === 'first' ? 'first' : 'latest'),
  group: 'group', trend: 'series', busiest: 'series', inactive: 'inactive', line_item: 'line', per_entity: 'per_entity', pivot: 'pivot',
  rank_of: 'set_rank', ratio: 'set_ratio', share: 'share', days_since: 'since', text: 'text', change_pct: 'compare',
  compare_diff: 'compare', compare_yes: 'compare', compare_which: 'compare', missing: 'missing',
  top: (p) => (p.args?.dir === 'bottom' ? 'bottom' : 'top'),
};
const fn = (f, p) => (typeof f === 'function' ? f(p) : f);

export function factoryOp(rec) {
  const p = rec.plan ?? {};
  const f = rec.family ?? '';
  if (/^lookup_/.test(f)) return p.op === 'lookup' && rec.expect?.kind === 'decline' ? 'decline' : 'lookup';
  if (f === 'untracked' || f === 'pay' || f === 'pay_owing') return 'decline';
  const m = FAMILY_OP[f];
  return m ? fn(m, p) : 'other';
}

/** The measure label: what is aggregated / returned. */
const MONEY_METRIC = new Set(['sum', 'total']);
export function factoryMeasure(rec) {
  const p = rec.plan ?? {}; const a = p.args ?? {}; const m = p.measure ?? null; const f = rec.family ?? '';
  if (f === 'untracked' || f === 'pay' || f === 'pay_owing') return 'untracked';
  if (m === 'total' || MONEY_METRIC.has(a.metric) || MONEY_METRIC.has(a.numer) || (a.ret === 'sum') || f === 'minmax' || f === 'sum' || f === 'avg' || f === 'median') return 'money';
  if (m === 'date') return 'date';
  if (m === 'invoice_number' || m === 'number') return 'ident';
  if (m) return 'text';
  return 'none';
}

export function factoryEntity(rec) {
  const e = rec.plan?.entity;
  if (e === 'doc' || e === 'visit') return 'document';
  if (e === 'customer') return 'customer';
  if (e === 'equipment') return 'unit';
  return 'other';
}

export function factoryDoc(rec) {
  const p = rec.plan ?? {}; const a = p.args ?? {};
  if (a.a && a.b && typeof a.a === 'string' && typeof a.b === 'string') return 'pair';
  return p.doc_type || a.doc_type ? 'one' : 'none';
}

const DIM_MAP = { technician: 'tech', tech: 'tech', service_type: 'serviceType', manufacturer: 'brand', brand: 'brand', customer: 'customer', customer_name: 'customer', city: 'city', year: 'year', month: 'month', quarter: 'quarter', weekday: 'weekday', vendor: 'vendor', status: 'status' };
export function dimLabel(d) { return DIM_MAP[d] ?? 'other'; }
export function factoryGroup(rec) {
  const p = rec.plan ?? {}; const a = p.args ?? {};
  const f = rec.family ?? '';
  if (!['group', 'trend', 'busiest', 'top', 'pivot', 'count_distinct'].includes(f)) return 'none';
  if (f === 'pivot') return 'two';
  if (f === 'count_distinct') return 'none';
  const gb = Array.isArray(p.group_by) ? p.group_by : [];
  const by = a.by ?? a.dim ?? gb[0] ?? null;
  if (gb.length > 1) return 'two';
  return by ? dimLabel(by) : 'none';
}

export function factoryHeads(rec) {
  return { op: factoryOp(rec), measure: factoryMeasure(rec), entity: factoryEntity(rec), doc: factoryDoc(rec), group: factoryGroup(rec) };
}

/* ------------------------------------------------------------------------------------------------ DQL side */
const DQL_OP = {
  count: 'count', count_distinct: 'count_distinct', list: 'list', sum: 'sum', avg: 'avg', min: 'min', max: 'max', median: 'median',
  group_count: 'group', group_sum: 'group', group_avg: 'group', pivot_two_dims: 'pivot', top_n: 'top', bottom_n: 'bottom', latest: 'latest', first_ever: 'first',
  exists_yes_no: 'exists', share_pct: 'share', per_entity_avg: 'per_entity', compare_two_values: 'compare',
  tm_window: 'count', tm_series: 'series', tm_compare: 'compare', tm_rate: 'series', tm_since: 'since', tm_inactive: 'inactive', tm_expiry: 'expiry', tm_between: 'between', tm_age: 'age',
  set_select: 'set_select', set_above_avg: 'set_above', set_rank: 'set_rank', set_ratio: 'set_ratio', set_per_entity: 'per_entity', set_building: 'set_select',
  text_search: 'text', line_search: 'line', cost_breakdown: 'other', duplicates: 'dup', missing_field: 'missing', find_document: 'find', field_conflict: 'other',
  future_dates: 'other', completeness: 'other', field_text: 'lookup', reverse_lookup: 'lookup',
};
export function dqlOp(plan) { return DQL_OP[plan?.op] ?? 'other'; }
export function dqlMeasure(plan) {
  const m = plan?.measure; if (!m) return 'none';
  const f = String(m.field ?? '');
  if (m.unit === 'money' || /^(?:total|amount|price|cost|revenue)/i.test(f)) return 'money';
  if (/date|expires/i.test(f)) return 'date';
  if (/number|^id$|invoice_number|po_number/i.test(f)) return 'ident';
  if (!f) return 'none';
  return 'text';
}
export function dqlEntity(plan) { const e = plan?.entity ?? plan?.measure?.entity; return e === 'document' ? 'document' : e === 'customer' ? 'customer' : e === 'unit' ? 'unit' : 'other'; }
export function dqlDoc(plan) {
  const n = plan?.docTypes?.length ?? (plan?.docType || plan?.measure?.docType ? 1 : 0);
  if (plan?.op === 'set_ratio' || (plan?.a?.docType && plan?.b?.docType)) return 'pair';
  return n >= 2 ? 'pair' : n === 1 ? 'one' : 'none';
}
export function dqlGroup(plan) {
  const g = plan?.groupBy; if (!g || !g.length) return plan?.op === 'pivot_two_dims' ? 'two' : 'none';
  if (g.length > 1) return 'two';
  const by = typeof g[0] === 'string' ? g[0] : g[0]?.by ?? g[0]?.dim ?? g[0]?.field;
  return DIMS.includes(by) ? by : dimLabel(by);
}
export function dqlHeads(plan) { return { op: dqlOp(plan), measure: dqlMeasure(plan), entity: dqlEntity(plan), doc: dqlDoc(plan), group: dqlGroup(plan) }; }

/* ------------------------------------------------------------------------------------------------ HVAC dev set (work/deep/dev): same labels, other field names */
const HVAC_OP = {
  count: 'count', count_distinct: 'count_distinct', list: 'list', sum: 'sum', avg: 'avg', min: 'min', max: 'max', median: 'median', group_count: 'group', group_sum: 'group', group_avg: 'group',
  pivot_two_dims: 'pivot', top_n: 'top', bottom_n: 'bottom', latest: 'latest', first_ever: 'first', exists_yes_no: 'exists', share_pct: 'share', per_entity_avg: 'per_entity',
  compare_two_values: 'compare', compare_periods: 'compare', change_pct: 'compare', busiest_period: 'series', trend_over_time: 'series', seasonality: 'series',
  time_since_last: 'since', days_between: 'between', inactive_since: 'inactive', expiring_soon: 'expiry', upcoming_due: 'expiry', age_of: 'age', duplicates: 'dup',
  missing_field: 'missing', data_quality_count: 'missing', text_contains: 'text', line_item_search: 'line', find_document: 'find', lookup_field: 'lookup',
  never_had: 'set_select', repeat_entities: 'set_select', set_difference: 'set_select', set_intersection: 'set_select', above_average: 'set_above', rank_of: 'set_rank', ratio: 'set_ratio',
  decline_untracked: 'decline', clarify_needed: 'clarify', followup_refine: 'followup', followup_slot_swap: 'followup',
};
export function hvacDim(d) {
  const s = String(d ?? '').toLowerCase();
  if (/^(?:year|month|quarter|weekday)/.test(s) || /\b(?:year|month|quarter|weekday)/.test(s)) return /month/.test(s) ? 'month' : /quarter/.test(s) ? 'quarter' : /weekday|dow/.test(s) ? 'weekday' : 'year';
  if (/customer/.test(s)) return 'customer';
  if (/manufacturer|brand/.test(s)) return 'brand';
  if (/technician|tech/.test(s)) return 'tech';
  if (/city/.test(s)) return 'city';
  if (/vendor/.test(s)) return 'vendor';
  if (/status/.test(s)) return 'status';
  if (/service_type/.test(s)) return 'serviceType';
  return 'other';
}
export function hvacHeads(rec) {
  const p = rec.plan ?? {};
  const pat = rec.pattern;
  let op = rec.answerable === 'untracked' ? 'decline' : rec.answerable === 'ambiguous' ? 'clarify' : (HVAC_OP[pat] ?? (pat === 'oldest_newest' ? (p.sort === 'asc' ? 'first' : 'latest') : 'other'));
  if (/^followup/.test(pat)) op = 'followup';
  const e = p.entity;
  const entity = /customer/.test(e ?? '') ? 'customer' : /equipment|unit/.test(e ?? '') ? 'unit' : e ? 'document' : 'other';
  const m = p.measure;
  const measure = op === 'decline' ? 'untracked' : m === 'total' || m === 'amount' ? 'money' : !m || m === 'count' ? 'none' : /date|expires/.test(m) ? 'date' : /number|id$/.test(m) ? 'ident' : 'text';
  const gb = Array.isArray(p.group_by) ? p.group_by : [];
  const group = pat === 'pivot_two_dims' || gb.length > 1 ? 'two' : gb.length ? hvacDim(gb[0]) : 'none';
  return { op, measure, entity, doc: p.doc_type ? 'one' : 'none', group };
}
