/**
 * dql/reader-ml/map.js - the learned reader's filled plan (the question factory's plan shape) -> the translator's plan shape (translator/schema.js).
 * The translator validator (translator/validate.js) then reads the plan against the QUESTION and the company's records: every value must be anchored
 * to words of the question, every word of the question must be explained (the coverage rule), nothing may be invented. Plans of an op the
 * mapper does not know are released. Returns a list of candidate raw plans (the words of a period can be cut more than one way); the caller keeps
 * the first that validates AND whose period agrees with the filler's own dates.
 */
const FIELD = { customer_name: 'customer', city: 'city', technician: 'tech', vendor: 'vendor', status: 'status', service_type: 'serviceType', manufacturer: 'brand' };
const DIMS = { customer: 'customer', customer_name: 'customer', city: 'city', technician: 'tech', vendor: 'vendor', status: 'status', service_type: 'serviceType', manufacturer: 'brand', month: 'month', year: 'year', quarter: 'quarter', weekday: 'weekday' };
const PEOPLE_ROLE = new Set(['ENT', 'STAFF', 'CITY', 'VALUE']);
const CMP = /(?:more than|greater than|bigger than|larger than|higher than|over|above|exceeding|at least|no less than|not less than|under|below|less than|fewer than|smaller than|lower than|at most|no more than|not more than|up to|from|between|around|exactly|just)\s+$/i;
const KW = /(?:back in|in|during|for|of|since|before|after|through|until|till|from|by|as of|between|within|over|across|the)\s+$/i;

const lc = (s) => String(s).toLowerCase();
const sameVal = (a, b) => lc(a).replace(/\s+/g, ' ') === lc(b).replace(/\s+/g, ' ');

/** the question words that stated a value: the mention whose canon equals the plan's value */
function mentionFor(ms, value, roles) {
  return ms.find((m) => roles.has(m.role) && typeof m.canon === 'string' && sameVal(m.canon, value)) ?? null;
}
function numMention(ms, value) { return ms.find((m) => (m.role === 'MONEY' || m.role === 'NUM') && typeof m.canon === 'number' && m.canon === value) ?? null; }
function moneyCandidates(q, m) {
  const bare = q.slice(m.s, m.e); const pre = q.slice(0, m.s); const c = CMP.exec(pre);
  return c ? [pre.slice(c.index) + bare, bare] : [bare];
}

/** candidate phrases for the period, cut from the question */
export function timeWords(q, ms, span) {
  const out = [];
  const tm = ms.filter((m) => ['DATE', 'YEAR', 'MONYR'].includes(m.role));
  const withKw = (s, e) => { const pre = q.slice(0, s); const k = KW.exec(pre); const kw2 = /(?:back in|as of)\s+$/i.exec(pre); const list = []; if (k) list.push(pre.slice(k.index) + q.slice(s, e)); if (kw2) list.push(pre.slice(kw2.index) + q.slice(s, e)); list.push(q.slice(s, e)); return list; };
  for (let i = 0; i < tm.length; i++) {
    for (const w of withKw(tm[i].s, tm[i].e)) out.push(w);
    if (i + 1 < tm.length) for (const w of withKw(tm[i].s, tm[i + 1].e)) out.push(w);
    if (i + 1 < tm.length) { const pre = q.slice(0, tm[i].s); const b = /(?:between|from)\s+$/i.exec(pre); if (b) out.unshift(pre.slice(b.index) + q.slice(tm[i].s, tm[i + 1].e)); }
  }
  const rel = /(?:(?:in|over|during|within|for)\s+)?(?:the\s+)?(?:last|past|previous|next|coming)\s+(?:\d+|[a-z]+)\s+(?:days?|weeks?|months?|years?)\b|\b(?:this|last|previous|prior)\s+(?:year|month|quarter|week)\b|\byear to date\b|\bytd\b|\byesterday\b|\btoday\b/gi;
  let m; while ((m = rel.exec(q))) { out.push(m[0]); out.push(m[0].replace(/^(?:in|over|during|within|for)\s+/i, '')); }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

/**
 * @param {object} plan filled plan (op, entity, doc_type, filters, time, measure, group_by, args ...)
 * @returns {{raws: object[]} | {none: string}}
 */
export function toRaws(plan, ms, q) {
  if (!plan || typeof plan !== 'object') return { none: 'shape' };
  if (plan.second || plan.hop) return { none: 'second-or-hop' };
  const base = {};
  if (plan.entity === 'doc') { base.entity = 'document'; if (plan.doc_type) { if (!/^[a-z0-9-]+$/.test(plan.doc_type)) return { none: 'doc_type' }; base.docType = plan.doc_type; } }
  else if (plan.entity === 'visit') { base.entity = 'document'; base.visit = true; if (plan.doc_type) return { none: 'visit-with-doctype' }; }
  else return { none: `entity:${plan.entity}` };
  // filters: equality on a known field (a person / place / stored value named in the question) and money bounds
  const filters = []; const money = [];
  for (const f of plan.filters ?? []) {
    if (!f || typeof f !== 'object') return { none: 'filter' };
    if (f.field === 'total') { if (!['gt', 'gte', 'lt', 'lte', 'eq'].includes(f.op) || typeof f.value !== 'number') return { none: 'money-filter' }; money.push(f); continue; }
    if (!FIELD[f.field] || f.op !== 'eq' || typeof f.value !== 'string') return { none: `filter:${f.field}:${f.op}` };
    const m = mentionFor(ms, f.value, PEOPLE_ROLE); if (!m) return { none: 'filter-value-not-a-mention' };
    filters.push({ field: FIELD[f.field], op: 'eq', value: f.value, words: q.slice(m.s, m.e) });
  }
  const moneyOpts = []; // each: array of alternatives for one raw filter
  if (money.length === 2 && money.some((x) => x.op === 'gte') && money.some((x) => x.op === 'lte')) {
    const lo = money.find((x) => x.op === 'gte'); const hi = money.find((x) => x.op === 'lte'); const a = numMention(ms, lo.value); const b = numMention(ms, hi.value);
    if (!a || !b || a === b) return { none: 'money-between' }; const [x, y] = a.s < b.s ? [a, b] : [b, a];
    const pre = q.slice(0, x.s); const c = /(?:between|from)\s+$/i.exec(pre);
    moneyOpts.push([{ field: 'total', op: 'between', value: [lo.value, hi.value], words: (c ? pre.slice(c.index) : '') + q.slice(x.s, y.e) }, { field: 'total', op: 'between', value: [lo.value, hi.value], words: q.slice(x.s, y.e) }]);
  } else if (money.length === 1) {
    const m = numMention(ms, money[0].value); if (!m) return { none: 'money-not-a-mention' };
    moneyOpts.push(moneyCandidates(q, m).map((w) => ({ field: 'total', op: money[0].op, value: money[0].value, words: w })));
  } else if (money.length) return { none: 'money-count' };
  // op
  const a = plan.args ?? {}; const op = plan.op; const tops = {};
  const dimOf = (x) => DIMS[x] ?? null;
  switch (op) {
    case 'count': tops.op = 'count'; break;
    case 'exists': tops.op = 'exists_yes_no'; break;
    case 'agg': { if (plan.measure !== 'total' || !['sum', 'avg', 'median', 'min', 'max'].includes(a.fn)) return { none: 'agg' }; tops.op = a.fn; tops.measure = { field: 'total' }; break; }
    case 'count_distinct': { const d = dimOf(plan.measure); if (!d || ['month', 'year', 'quarter', 'weekday'].includes(d)) return { none: 'distinct' }; tops.op = 'count_distinct'; tops.distinct = d; break; }
    case 'group': {
      const d = dimOf(a.by); if (!d || JSON.stringify(plan.group_by) !== JSON.stringify([a.by])) return { none: 'group' }; tops.groupBy = [d];
      if (a.metric === 'count') tops.op = 'group_count'; else if (a.metric === 'sum') { tops.op = 'group_sum'; tops.measure = { field: 'total' }; } else return { none: 'group-metric' };
      break;
    }
    case 'top': {
      const d = dimOf(a.by); if (!d || ['month', 'year', 'quarter', 'weekday'].includes(d) || !Number.isInteger(a.n) || a.n < 1) return { none: 'top' };
      if (a.dir !== 'top') return { none: 'top-dir' };
      tops.op = 'top_n'; tops.groupBy = [d]; tops.limit = a.n;
      if (a.metric === 'sum') tops.measure = { field: 'total', agg: 'sum' }; else if (a.metric !== 'count') return { none: 'top-metric' };
      break;
    }
    default: return { none: `op:${op}` };
  }
  // period
  let timeOpts = [null];
  if (plan.time) {
    const f = plan.time.field; if (!(plan.entity === 'visit' ? f === 'service_date' : f === 'doc_date')) return { none: 'time-field' };
    const ws = timeWords(q, ms, plan.time.span); if (!ws.length) return { none: 'time-words' };
    timeOpts = ws.map((w) => ({ words: w }));
  }
  // cartesian product of the alternatives (small)
  const raws = [];
  const monies = moneyOpts.length ? moneyOpts[0] : [null];
  for (const t of timeOpts) for (const mo of monies) {
    const r = { ...base, ...tops, filters: [...filters, ...(mo ? [mo] : [])] };
    if (t) r.time = t;
    raws.push(r);
  }
  return { raws: raws.slice(0, 40) };
}
