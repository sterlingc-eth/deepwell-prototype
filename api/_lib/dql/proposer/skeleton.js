/**
 * dql/proposer/skeleton.js - the plan SKELETON: the part of a translator plan the proposer's model predicts (everything except the slot values).
 *
 *   skeletonOf(rec)         training label from a question-factory record (via the factory's plan vocabulary; "none" for what the proposer must not plan)
 *   parseSkeleton(label)    -> {op, entity, visit, measure, groupBy[], distinct, limit, ask} | null
 *
 * label = op|entity|m:<measure>|g:<dim+dim>|d:<distinct>|l:<1|n>|a:<ask>     e.g. "group_sum|document|m:total|g:month|d:-|l:-|a:-"; entity "visit" = document papers with a service date.
 */
const DIM = { technician: 'tech', tech: 'tech', manufacturer: 'brand', brand: 'brand', service_type: 'serviceType', customer: 'customer', customer_name: 'customer', city: 'city', year: 'year', month: 'month', quarter: 'quarter', weekday: 'weekday', vendor: 'vendor', status: 'status', doc_type: 'type', model: 'model' };
const FILTER_OK = new Set(['customer_name', 'technician', 'vendor', 'city', 'manufacturer', 'service_type', 'status', 'total']);
const MEAS = { total: 'total', hours: 'hours', tonnage: 'tonnage' };
const lab = (op, ent, { m = '-', g = '-', d = '-', l = '-', a = '-' } = {}) => `${op}|${ent}|m:${m}|g:${g}|d:${d}|l:${l}|a:${a}`;

export function skeletonOf(rec) {
  try {
    if (rec.prior) return 'none';
    const p = rec.plan ?? {}; const a = p.args ?? {};
    if (p.second || p.hop) return 'none';
    const ent = p.entity === 'doc' ? 'document' : p.entity === 'visit' ? 'visit' : p.entity === 'customer' ? 'customer' : p.entity === 'equipment' ? 'unit' : null;
    if (!ent) return 'none';
    for (const f of p.filters ?? []) { if (!FILTER_OK.has(f.field)) return 'none'; if (f.field === 'total' && !['gt', 'gte', 'lt', 'lte', 'between'].includes(f.op)) return 'none'; if (f.field !== 'total' && f.op !== 'eq') return 'none'; }
    if (ent === 'customer' && (p.filters ?? []).some((f) => f.field !== 'city')) return 'none';
    const dim = (d) => DIM[d] ?? null;
    switch (p.op) {
      case 'count': return lab('count', ent);
      case 'customers': return ent === 'customer' && a.ret === 'count' ? lab('count', 'customer') : ent === 'customer' && a.ret === 'list' ? lab('list', 'customer') : 'none';
      case 'exists': return lab('exists_yes_no', ent);
      case 'count_distinct': { const d = dim(p.measure); return d ? lab('count_distinct', ent, { d }) : 'none'; }
      case 'list': { const d = dim(p.measure); if (!d || p.measure === 'invoice_number') return 'none'; return lab('list', ent, { d }); }
      case 'agg': { const m = MEAS[p.measure]; const fn = a.fn; if (!m || !['sum', 'avg', 'min', 'max', 'median'].includes(fn)) return 'none'; return lab(fn, ent, { m }); }
      case 'group': { const d = dim(a.by ?? p.group_by?.[0]); if (!d) return 'none'; if (a.metric === 'sum') return lab('group_sum', ent, { m: 'total', g: d }); if (a.metric === 'avg') return lab('group_avg', ent, { m: 'total', g: d }); if (a.metric === 'count') return lab('group_count', ent, { g: d }); return 'none'; }
      case 'top': { const d = dim(a.by); if (!d || !['count', 'sum'].includes(a.metric)) return 'none'; return lab(a.dir === 'bottom' ? 'bottom_n' : 'top_n', ent, { m: a.metric === 'sum' ? 'total' : '-', g: d, l: a.n === 1 ? '1' : 'n' }); }
      case 'busiest': { const d = dim(a.dim); if (!d || a.metric !== 'count') return 'none'; return lab(a.dir === 'quietest' ? 'bottom_n' : 'top_n', ent, { g: d, l: '1' }); }
      case 'extreme': {
        const op = a.which === 'first' ? 'first_ever' : 'latest';
        const ask = { date: '-', customer_name: 'customer', technician: 'tech', total: 'amount' }[a.ret]; if (ask == null) return 'none';
        return lab(op, ent, { a: ask });
      }
      default: return 'none';
    }
  } catch { return 'none'; }
}

export function parseSkeleton(label) {
  if (!label || label === 'none') return null;
  const [op, ent, m, g, d, l, a] = label.split('|');
  const v = (x) => { const s = x.slice(2); return s === '-' ? null : s; };
  return { op, entity: ent === 'visit' ? 'document' : ent, visit: ent === 'visit', measure: v(m), groupBy: v(g) ? v(g).split('+') : [], distinct: v(d), limit: v(l), ask: v(a) };
}
