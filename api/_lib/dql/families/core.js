/**
 * dql/families/core.js - the core family: count, count_distinct, list, sum, avg, min, max, median, group_count, group_sum, group_avg,
 * pivot_two_dims, top_n, bottom_n, latest, first_ever, exists_yes_no, share_pct, per_entity_avg, compare_two_values.
 *
 * detect(feat)  reads the slots parse.js collected and returns a plan or null (never a guess).
 * exec(plan, x) computes over the snapshot with the helpers in exec.js. say lives in ../say.js.
 */
import { registerFamily } from '../registry.js';
import { ENTITIES, yearsBetween } from '../fields.js';
import { sayResult } from '../say.js';

export const CORE_OPS = ['count', 'count_distinct', 'list', 'sum', 'avg', 'min', 'max', 'median', 'group_count', 'group_sum', 'group_avg', 'pivot_two_dims',
  'top_n', 'bottom_n', 'latest', 'first_ever', 'exists_yes_no', 'share_pct', 'per_entity_avg', 'compare_two_values'];

const MONEY_TYPES_HINT = new Set(['invoice', 'proposal-quote', 'purchase-order', 'maintenance-agreement', 'agreement', 'receipt', 'statement']);
/** Types whose own record carries a more meaningful date than the day the paper was written (term, install, expiry): a bare time span on them is ambiguous. */
const DATE_AMBIGUOUS = new Set(['maintenance-agreement', 'agreement', 'warranty-registration', 'insurance-certificate', 'permit', 'price-list', 'statement', 'schedule', 'equipment-record', 'nameplate-photo']);
const DISTINCT_UNIT_DIMS = new Set(['brand', 'refrigerant', 'tonnage', 'model', 'type']);
const DIM_FIELD = { tech: 'tech', city: 'city', brand: 'brand', customer: 'customer', vendor: 'vendor', status: 'status', serviceType: 'serviceType', refrigerant: 'refrigerant', tonnage: 'tonnage', model: 'model', type: 'type' };

const usd = (n) => `$${Number(n).toLocaleString('en-US')}`;
const addYears = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - n); return d.toISOString().slice(0, 10); };

/** Turn the parser's loose number filters ("over 5000", "older than 15 years", "4 ton") into real field filters for this entity; null = not supported. */
function resolveNumberFilters(f, entity, today) {
  const out = [];
  for (const x of f.filters) {
    if (x.field !== '?num') { out.push(x); continue; }
    const unit = x.unit;
    if (entity === 'customer') {
      // relations of a customer: how many documents / units / visits it has, what it was billed
      const cmpWord = { gt: 'more than', gte: 'at least', lt: 'fewer than', lte: 'at most', eq: 'exactly' }[x.op] ?? x.op;
      if (x.relDoc) { out.push({ field: 'docCount', op: x.op, value: x.value, docType: x.relDoc, label: `with ${cmpWord} ${x.value} ${x.relDoc.replace(/-/g, ' ')} document${x.value === 1 ? '' : 's'}` }); continue; }
      if (/^(document|doc)$/.test(unit)) { out.push({ field: 'docCount', op: x.op, value: x.value, label: `with ${cmpWord} ${x.value} document${x.value === 1 ? '' : 's'}` }); continue; }
      if (/^(unit|system)$/.test(unit)) { out.push({ field: 'unitCount', op: x.op, value: x.value, label: `with ${cmpWord} ${x.value} unit${x.value === 1 ? '' : 's'}` }); continue; }
      if (/^visit$/.test(unit)) { out.push({ field: 'visitCount', op: x.op, value: x.value, label: `with ${cmpWord} ${x.value} service visit${x.value === 1 ? '' : 's'}` }); continue; }
      if ((x.dollar || /^(dollar|buck)/.test(unit) || unit === '') && f.trig?.money?.length && (f.trig.moneyType ?? []).includes('invoice') && !Array.isArray(x.value)) { out.push({ field: 'billed', op: x.op, value: x.value, label: `billed ${cmpWord} ${usd(x.value)} on invoices`, moneyFilter: true }); continue; }
      return null;
    }
    if (x.older || /^year|^yr/.test(unit) || x.ago) {
      if (!/^year|^yr/.test(unit)) return null;
      if (entity === 'unit') { out.push({ field: 'age', op: x.op, value: x.value, label: `${x.older && x.op === 'gt' ? 'older than' : x.op === 'lt' ? 'newer than' : x.word} ${x.value} year${Number(x.value) === 1 ? '' : 's'}` }); continue; }
      if (entity === 'document' && !Array.isArray(x.value)) {
        // "older than N years" for a paper: its date is more than N years back
        const cut = addYears(today, x.value);
        const op = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte' }[x.op];
        if (!op) return null;
        out.push({ field: 'date', op, value: cut, label: `${x.op === 'gt' || x.op === 'gte' ? 'dated more than' : 'dated less than'} ${x.value} year${Number(x.value) === 1 ? '' : 's'} ago` });
        continue;
      }
      return null;
    }
    if (/^ton/.test(unit)) { out.push({ field: 'tonnage', op: x.op, value: x.value, label: `${x.word} ${Array.isArray(x.value) ? x.value.join(' and ') : x.value} tons` }); continue; }
    if (/^(hour|hr)/.test(unit)) { if (entity !== 'document') return null; out.push({ field: 'hours', op: x.op, value: x.value, label: `${x.word} ${x.value} labor hours` }); continue; }
    if (x.dollar || /^(dollar|buck)/.test(unit) || unit === '') {
      if (entity !== 'document') return null;
      if (unit === '' && !x.dollar && !(f.trig.money?.length || f.docTypes.some((d) => MONEY_TYPES_HINT.has(d)))) return null;
      out.push({ field: 'total', op: x.op, value: x.value, label: Array.isArray(x.value) ? `between ${usd(x.value[0])} and ${usd(x.value[1])}` : `${x.word} ${usd(x.value)}`, money: true });
      continue;
    }
    return null; // counts of related records ("more than 5 documents"), percentages, days: not this family
  }
  return out;
}

/** Map the parser's role filters onto this entity's field ids; null when the entity cannot be asked that. */
function mapFilters(filters, entity) {
  const E = ENTITIES[entity];
  const out = [];
  for (const x of filters) {
    let field = x.field;
    if (x.role === 'customer') field = entity === 'customer' ? 'name' : 'customer';
    if (x.role === 'tech') field = 'tech';
    if (x.role === 'vendor') field = 'vendor';
    if (entity === 'customer' && field === 'brand') { if (x.op !== 'eq') return null; out.push({ ...x, field: 'hasBrand', op: 'eq', label: `with ${x.value} units` }); continue; }
    if (field === 'equipmentType' && entity === 'document') return null;
    if (!E.fields[field]) return null;
    out.push({ ...x, field });
  }
  return out;
}

function dimFor(dim, entity, timeField, f) {
  if (['year', 'month', 'quarter', 'monthOfYear'].includes(dim)) {
    const field = timeField ?? ENTITIES[entity].defaultDate;
    return field ? { by: dim, field } : null;
  }
  let by = DIM_FIELD[dim];
  if (!by) return null;
  if (dim === 'type' && entity === 'unit') by = 'equipmentType';
  if (dim === 'type' && entity === 'customer') return null;
  if (!ENTITIES[entity].fields[by]) return null;
  return { by };
}

function timeFieldFor(f, entity, visit) {
  const c = f.cue ?? {};
  if (entity === 'unit') {
    if (c.install) return 'installDate';
    if (c.expire) return 'warrantyExpires';
    if (c.register) return 'registeredDate';
    return null;
  }
  if (entity === 'document') {
    if (c.install || c.expire || c.register) return null;
    if (c.created) return 'createdAt';
    if (visit) return 'serviceDate';
    return 'date';
  }
  return null;
}

function detect(f) {
  if (f.sets || f.timeq) return null; // a set / rank / group-average question taken by the sets family
  const t = f.trig ?? {};
  const SEM = ['negation', 'missing', 'distinct', 'howMany', 'howMuch', 'share', 'versus', 'median', 'avg', 'exists', 'total', 'max', 'min', 'latest', 'earliest', 'any', 'hours', 'tonnageWord', 'ageWord', 'topN', 'argmax'];
  const need = new Set(SEM.filter((k) => t[k]));
  if (t.money?.length) need.add('money');
  for (const k of ['install', 'expire', 'register', 'created']) if (f.cue?.[k]) need.add(`cue:${k}`);
  if (f.recentN) need.add('recentN');
  if (f.flags.each) need.add('each');
  if (f.dims.length) need.add('dims');
  if (f.distinctDim) need.add('distinctDim');
  const fin = (plan, ...used) => { for (const u of used) need.delete(u); if (need.size) f.unusedTriggers = [...need]; return need.size ? null : plan; };
  // "do we have", "have we got" next to a count, a list verb or an aggregate is just how the question is asked, not an existence check
  if (t.exists && (t.howMany || f.flags.listVerb || t.avg || t.median || t.total || t.howMuch || t.max || t.min || t.share || t.versus || t.latest || t.earliest || f.dims.length || f.distinctDim || t.topN || t.argmax)) need.delete('exists');
  if (t.any && (t.howMany || t.avg || t.total || t.howMuch)) need.delete('any');

  if (t.negation || t.missing) return null;
  if (f.docTypes.includes('hr-letter')) return null;
  if (f.docTypes.length > 1) return null;
  if ((f.times?.length ?? 0) > 1 && !t.versus) return null;

  // ---------------------------------------------------------------- entity
  if (f.nouns.install) { f.nouns.unit = true; f.cue = { ...(f.cue ?? {}), install: true }; }
  // "customers with an agreement", "customers with more than 5 documents": a customer reading, filtered by what it has
  const custRel = Boolean(f.flags.custRel);
  if (custRel && f.nouns.customer && f.nouns.unit && f.filters.some((x) => x.field === 'brand') && !f.nouns.visit && !f.nouns.document && !f.docTypes.length) f.nouns.unit = false; // "customers with Carrier units"
  if (custRel && !(f.nouns.customer && !f.nouns.unit && !f.nouns.visit && !f.nouns.document && f.docTypes.length <= 1)) return null;
  // "revenue from Tucson clients", "what has client X been billed": the customer is a modifier of the invoices, not the thing counted
  const moneyOnCust = !custRel && f.nouns.customer && !f.docTypes.length && !f.nouns.unit && !f.nouns.visit && !f.nouns.document && (t.money?.length || t.howMuch) && !f.filters.some((x) => x.field === '?num') && (t.moneyType ?? []).length === 1;
  if (moneyOnCust) f.docTypes = [...t.moneyType];
  let docType = f.docTypes[0] ?? null;
  const docEntity = !custRel && (f.docTypes.length > 0 || f.nouns.visit || f.nouns.document);
  let entity = null; let visit = false;
  const argDim = t.argmax?.dim ?? null;
  const wantsRank = Boolean(t.topN || t.argmax);
  let rankDim = f.dims[0] ?? argDim ?? null;

  if (f.nouns.unit && docEntity) return null;
  if (f.nouns.visit) visit = true;
  if (docEntity) {
    entity = 'document';
    if (f.nouns.visit && f.docTypes.length) return null; // "visits" and a document type together: ambiguous
    if (f.nouns.customer) {
      if (wantsRank && !rankDim) rankDim = 'customer';
      else if (!(f.dims.length || t.argmax || t.money?.length || t.howMuch)) return null;
    }
    if (f.nouns.tech) {
      if (wantsRank && !rankDim) rankDim = 'tech';
      else if (!(f.dims.length || t.argmax)) return null;
    }
  } else if (f.nouns.unit) {
    entity = 'unit';
    if (f.nouns.customer && !(f.dims.length || t.argmax || wantsRank)) return null;
    if (f.nouns.customer && wantsRank && !rankDim) rankDim = 'customer';
    if (f.nouns.tech) return null;
  } else if (f.nouns.customer) {
    entity = 'customer';
    if (f.nouns.tech) return null;
    if (custRel && f.docTypes.length === 1) { f.filters = [...f.filters, { field: 'docCount', op: 'gte', value: 1, docType: f.docTypes[0], label: `with ${f.docTypes[0].replace(/-/g, ' ')} on file`, relPresence: true }]; f.docTypes = []; docType = null; }
  } else if (f.nouns.tech || f.distinctDim) {
    entity = 'document';
  } else if (t.money?.length || t.howMuch || t.hours) {
    entity = 'document';
  }
  // "oldest York", "Rheem 3 ton R-454B": attributes only a unit has, with no other thing named, are about units
  if (!entity && !f.docTypes.length && f.filters.some((x) => ['brand', 'refrigerant', 'tonnage', 'model'].includes(x.field))) entity = 'unit';
  if (!entity) return null;

  // ---------------------------------------------------------------- measure
  let measure = null;
  const custMoney = entity === 'customer' && Boolean(t.money?.length) && (t.moneyType ?? []).includes('invoice') && !(t.moneyType ?? []).includes('purchase-order');
  if (custMoney) for (const k of ['money', 'howMuch', 'total']) need.delete(k);
  const moneyIntent = !custMoney && (Boolean(t.money?.length) || t.howMuch || (t.total && !t.tonnageWord && !t.hours));
  if (t.hours) { if (entity !== 'document') return null; measure = { field: 'hours', label: 'labor hours', unit: 'hours' }; need.delete('hours'); }
  else if (t.tonnageWord) { if (entity !== 'unit') return null; measure = { field: 'tonnage', label: 'tonnage', unit: 'tons' }; need.delete('tonnageWord'); }
  else if (t.ageWord && entity === 'unit') { measure = { field: 'age', label: 'age', unit: 'years' }; need.delete('ageWord'); }
  else if (moneyIntent) {
    if (entity !== 'document') return null;
    measure = { field: 'total', label: 'total', unit: 'money' };
    need.delete('money'); need.delete('howMuch'); need.delete('total');
    if (!docType) {
      const mt = t.moneyType ?? [];
      if (mt.length === 1) docType = mt[0]; else return null;
    }
  } else if ((t.avg || t.median || t.max || t.min) && entity === 'document' && docType && !visit) {
    // "average invoice", "largest estimate": the amount of that kind of paper
    measure = { field: 'total', label: 'total', unit: 'money' };
  }
  if (t.ageWord && !measure) return null;
  if (entity === 'document' && visit && measure?.field === 'total') return null;
  if (t.hours) need.delete('hours');

  // ---------------------------------------------------------------- filters / time
  let filters = resolveNumberFilters(f, entity, f.today);
  if (!filters) return null;
  filters = mapFilters(filters, entity);
  if (!filters) return null;
  if (entity === 'customer' && filters.some((x) => !['name', 'city', 'docCount', 'unitCount', 'visitCount', 'billed', 'hasBrand'].includes(x.field))) return null;
  // two different values of a one-valued field in the same question ("Kevin Pratt ... Denise Ford") cannot both hold: a swap of subject, not a filter
  {
    const seen = new Map();
    for (const x of filters) {
      if (!['eq', 'in'].includes(x.op)) continue;
      const k = `${x.field}:${x.docType ?? ''}`;
      if (seen.has(k) && !['brand', 'docCount'].includes(x.field)) return null;
      seen.set(k, true);
    }
  }

  let time = null;
  const timeField = timeFieldFor(f, entity, visit);
  if (f.time) {
    if (!timeField) return null;
    if (entity === 'document' && timeField === 'date' && docType && DATE_AMBIGUOUS.has(docType)) return null;
    time = { field: timeField, from: f.time.from, to: f.time.to, label: f.time.label };
    for (const k of ['install', 'expire', 'register', 'created']) need.delete(`cue:${k}`);
  }
  if (!f.time && entity === 'unit') need.delete('cue:install'); // "total tonnage installed": every unit, installed or not stated
  if (!f.time && need.size && [...need].some((k) => k.startsWith('cue:'))) return null; // a date cue with no span
  if (entity === 'customer' && time) return null;

  const base = { v: 1, entity, docType, visit, filters, time, measure: null, groupBy: [], limit: null, dir: 'desc', docWord: f.docTypes.length === 1 ? f.docWord ?? null : null };
  const agg = t.median ? 'median' : t.avg ? 'avg' : t.max && measure ? 'max' : t.min && measure ? 'min' : (measure && (t.total || t.howMuch || t.money?.length)) ? 'sum' : null;
  const aggKeys = ['median', 'avg', 'max', 'min', 'total', 'howMuch', 'money'];
  if ((t.max || t.min) && !measure && !t.latest && !t.earliest) return null;
  if (t.avg && !measure && !(f.dims.length === 1 && ['customer', 'tech', 'unit'].includes(f.dims[0]))) return null;

  // ---------------------------------------------------------------- share
  if (t.share) {
    if (t.howMany || agg || wantsRank || f.dims.length || t.versus) return null;
    if (entity === 'customer') return null; // the base of "customers" (all on file, or only those with activity) is a judgment call: left to the model
    if (filters.length !== 1) return null; // which conditions define the group and which the share of it is only clear with exactly one
    return fin({ ...base, op: 'share_pct', measure }, 'share');
  }

  // ---------------------------------------------------------------- compare two values
  if (t.versus) {
    const inF = filters.filter((x) => x.op === 'in' && x.value.length === 2);
    const twoTimes = (f.times?.length ?? 0) === 2;
    const cm = measure ? { ...measure, agg: agg ?? 'sum' } : null;
    if (inF.length === 1 && !twoTimes && filters.filter((x) => x.op === 'in').length === 1) {
      return fin({ ...base, op: 'compare_two_values', measure: cm, compare: { field: inF[0].field, values: inF[0].value }, filters: filters.filter((x) => x !== inF[0]) }, 'versus', 'howMany', ...aggKeys);
    }
    if (twoTimes && !inF.length && timeField) {
      return fin({ ...base, op: 'compare_two_values', time: null, measure: cm, compare: { time: f.times.map((s) => ({ field: timeField, from: s.from, to: s.to, label: s.label })) } }, 'versus', 'howMany', ...aggKeys);
    }
    return null;
  }
  if ((f.times?.length ?? 0) > 1) return null;
  if (filters.some((x) => x.op === 'in' && !Array.isArray(x.value))) return null;

  // ---------------------------------------------------------------- per-entity average ("docs per customer on average")
  if (t.avg && !measure && f.dims.length === 1 && ['customer', 'unit'].includes(f.dims[0]) && !visit) {
    if (entity === 'customer') return null;
    if (f.dims[0] === 'unit' && entity === 'unit') return null;
    return fin({ ...base, op: 'per_entity_avg', perEntity: f.dims[0] }, 'avg', 'howMany', 'dims', 'each');
  }
  if (t.avg && measure && (f.flags.perDim || f.dims.some((d) => d === 'customer' || d === 'tech'))) return null; // "average billed per customer": more than one reading

  // ---------------------------------------------------------------- dimensions
  if (f.flags.perCustomer && !measure) return null; // "units per customer": an average or a breakdown of 129 lines - two readings
  const dimIds = [...f.dims];
  const groupBy = [];
  for (const d of dimIds) {
    const g = dimFor(d, entity, time?.field ?? timeFieldFor(f, entity, visit), f);
    if (!g) return null;
    groupBy.push(g);
  }

  // ---------------------------------------------------------------- ranking
  if (wantsRank) {
    if (groupBy.length > 1) return null;
    const dimId = rankDim ?? dimIds[0];
    if (dimId) {
      const g = groupBy[0] ?? dimFor(dimId, entity, time?.field, f);
      if (!g) return null;
      const dir = t.topN ? t.topN.dir : t.argmax.dir;
      const n = t.topN ? t.topN.n : 1;
      const m = measure ? { ...measure, agg: agg === 'avg' ? 'avg' : 'sum' } : null;
      if (!m && entity === 'customer') return null;
      if (!m && !docType && !visit && !f.nouns.document && !f.nouns.unit) return null;
      return fin({ ...base, op: dir === 'asc' ? 'bottom_n' : 'top_n', groupBy: [g], measure: m, limit: n, dir, rank: 'groups' }, 'topN', 'argmax', 'dims', 'howMany', 'max', 'min', 'total', 'money', 'howMuch', 'avg');
    }
    // "the 5 biggest invoices": the rows themselves, ranked by an amount
    if (t.topN && measure && entity === 'document' && !f.dims.length) {
      return fin({ ...base, op: t.topN.dir === 'asc' ? 'bottom_n' : 'top_n', measure: { ...measure, agg: 'row' }, limit: t.topN.n, dir: t.topN.dir, rank: 'rows' }, 'topN', 'max', 'min', 'money');
    }
    return null;
  }

  // ---------------------------------------------------------------- grouping
  if (groupBy.length) {
    if (t.exists || t.latest || t.earliest) return null;
    if (groupBy.length > 2) return null;
    if (measure && (agg === 'median' || agg === 'max' || agg === 'min')) return null;
    if (!measure && (t.avg || agg)) return null;
    const op = groupBy.length === 2 ? 'pivot_two_dims' : (measure ? (agg === 'avg' ? 'group_avg' : 'group_sum') : 'group_count');
    return fin({ ...base, op, groupBy, measure: measure ? { ...measure, agg: agg === 'avg' ? 'avg' : 'sum' } : null }, 'dims', 'each', 'howMany', ...aggKeys);
  }
  if (f.flags.each) return null;

  // ---------------------------------------------------------------- scalar aggregates
  if (agg && measure) {
    if (t.howMany || t.exists) return null;
    return fin({ ...base, op: agg, measure: { ...measure, agg } }, ...aggKeys);
  }
  if (measure && !agg) return null;

  // ---------------------------------------------------------------- latest / earliest
  if (t.latest || t.earliest) {
    if (t.latest && t.earliest) return null;
    if (t.howMany || t.exists) return null;
    const field = entity === 'unit' ? (f.cue?.expire ? 'warrantyExpires' : f.cue?.register ? 'registeredDate' : 'installDate') : entity === 'document' ? (visit ? 'serviceDate' : time?.field ?? 'date') : null;
    if (!field) return null;
    if (f.recentN) return fin({ ...base, op: 'list', sort: { field, dir: t.latest ? 'desc' : 'asc' }, limit: f.recentN }, 'latest', 'earliest', 'recentN');
    return fin({ ...base, op: t.latest ? 'latest' : 'first_ever', sortField: field }, 'latest', 'earliest');
  }
  if (f.recentN) return null;

  // ---------------------------------------------------------------- existence
  if ((need.has('exists') || need.has('any')) && !t.howMany) {
    if (f.flags.listVerb && !t.exists) return null;
    return fin({ ...base, op: 'exists_yes_no' }, 'exists', 'any');
  }

  // ---------------------------------------------------------------- distinct counts / lists
  if (f.distinctDim) {
    const dim = f.distinctDim;
    let en = entity;
    if (!f.docTypes.length && !f.nouns.visit && !f.nouns.document && !f.nouns.unit && !f.nouns.customer) {
      en = DISTINCT_UNIT_DIMS.has(dim) && dim !== 'type' ? 'unit' : dim === 'city' ? 'customer' : 'document';
    }
    const g = dimFor(dim, en, null, f);
    if (!g || ['year', 'month', 'quarter', 'monthOfYear'].includes(dim)) return null;
    const fl = en === entity ? filters : mapFilters(resolveNumberFilters(f, en, f.today) ?? [], en);
    if (!fl) return null;
    const asList = !t.howMany;
    return fin({ ...base, entity: en, filters: fl, op: asList ? 'list' : 'count_distinct', distinct: g.by, time: en === entity ? time : null }, 'distinctDim', 'howMany', 'distinct');
  }
  if (t.howMany) {
    if (t.distinct && entity === 'document') {
      // "how many different customers have invoices": distinct customers among those documents
      if (f.nouns.customer && !f.nouns.tech && !f.dims.length) return fin({ ...base, op: 'count_distinct', distinct: 'customer' }, 'howMany', 'distinct');
      return null;
    }
    return fin({ ...base, op: 'count' }, 'howMany', 'distinct');
  }
  if (t.distinct) return null;

  // ---------------------------------------------------------------- list (a bare noun phrase is a list)
  if (t.howMuch || t.total) return null;
  // a list of a whole kind of record needs the plural noun and a reason to list it (a verb, a condition or a period); "invoices" or
  // "the customer" alone is a fragment of an earlier question, not a query
  const conditioned = filters.length > 0 || Boolean(time) || visit;
  if (!f.flags.plural) return null;
  if (!conditioned && !f.flags.explicitList) return null; // "who are the customers" can be the tail of an earlier question; "list all customers" cannot
  // "who ..." asks for people
  if (f.flags.who && entity !== 'customer') return null;
  // "documents in 2026" listed without saying which kind: a count is clear, a list of everything of every kind is not what anyone wants read out
  if (entity === 'document' && !docType && !visit && time) return null;
  // the visits of one named customer are a history (dates, kinds of visit, who came): that is the timeline family's question, not a plain list
  if (visit && filters.some((x) => x.field === 'customer')) return null;
  return fin({ ...base, op: 'list' });
}

/* ====================================================================== exec */

function rowsOf(plan, x) {
  const sel = x.h.selectRows(plan, x.snap, x.today);
  return sel;
}

const roundMoney = (n) => Math.round(n * 100) / 100;

function execCore(plan, x) {
  const { snap, today, h } = x;
  const sel = rowsOf(plan, x);
  if (sel.abstain) return { abstain: sel.abstain, name: sel.name };
  let rows = sel.rows;
  const res = { op: plan.op, n: rows.length, rows, leftOut: sel.leftOut ?? 0 };

  // a measure with no value anywhere in the selection cannot be answered (never zero-filled)
  const mvals = () => rows.map((r) => h.measureValue(r, plan, snap, today));
  if (plan.measure && !['compare_two_values'].includes(plan.op)) {
    if (rows.length && !mvals().some((v) => v != null)) return { abstain: 'measure-missing' };
  }

  switch (plan.op) {
    case 'count': return { ...res, value: rows.length };
    case 'exists_yes_no': return { ...res, yes: rows.length > 0, value: rows.length };
    case 'list': {
      if (plan.distinct) {
        const seen = new Map();
        for (const r of rows) {
          const v = h.valueOf(r, plan.entity, plan.distinct, snap, today);
          if (v == null || v === '') continue;
          const k = String(v).toLowerCase();
          if (!seen.has(k)) seen.set(k, { value: String(v), rows: [] });
          seen.get(k).rows.push(r);
        }
        const items = [...seen.values()].sort((a, b) => a.value.localeCompare(b.value));
        return { ...res, distinctItems: items, value: items.length };
      }
      let list = rows.slice();
      const s = plan.sort;
      if (s) {
        const def = h.fieldDef(plan.entity, s.field);
        list = list.filter((r) => def.get(r, snap, today) != null);
        list.sort((a, b) => { const A = def.get(a, snap, today); const B = def.get(b, snap, today); return s.dir === 'desc' ? (A < B ? 1 : A > B ? -1 : 0) : (A < B ? -1 : A > B ? 1 : 0); });
        list = list.slice(0, plan.limit ?? 10);
        return { ...res, list, value: list.length };
      }
      list.sort((a, b) => sortKey(plan.entity, a).localeCompare(sortKey(plan.entity, b)));
      return { ...res, list, value: list.length };
    }
    case 'count_distinct': {
      const set = new Map();
      let missing = 0;
      for (const r of rows) {
        const v = h.valueOf(r, plan.entity, plan.distinct, snap, today);
        if (v == null || v === '') { missing++; continue; }
        const def = h.fieldDef(plan.entity, plan.distinct);
        const k = def?.key ? def.key(v) : String(v).toLowerCase();
        if (!set.has(k)) set.set(k, { value: String(v), rows: [] });
        set.get(k).rows.push(r);
      }
      return { ...res, value: set.size, distinctItems: [...set.values()], missing };
    }
    case 'sum': case 'avg': case 'median': {
      const vals = mvals().filter((v) => v != null);
      const v = h.aggregate(vals, plan.op);
      const used = rows.filter((r) => h.measureValue(r, plan, snap, today) != null);
      return { ...res, value: v == null ? null : plan.measure.unit === 'money' ? roundMoney(v) : Math.round(v * 100) / 100, used, nUsed: vals.length, unitless: rows.length - vals.length, total: plan.op === 'avg' ? roundMoney(vals.reduce((a, b) => a + b, 0)) : null };
    }
    case 'max': case 'min': {
      const withV = rows.map((r) => ({ r, v: h.measureValue(r, plan, snap, today) })).filter((o) => o.v != null);
      if (!withV.length) return { ...res, value: null, extreme: [] };
      const best = plan.op === 'max' ? Math.max(...withV.map((o) => o.v)) : Math.min(...withV.map((o) => o.v));
      const tied = withV.filter((o) => Math.abs(o.v - best) < 1e-9).map((o) => o.r);
      return { ...res, value: best, extreme: tied, nUsed: withV.length };
    }
    case 'latest': case 'first_ever': {
      const def = h.fieldDef(plan.entity, plan.sortField);
      const withV = rows.map((r) => ({ r, v: def.get(r, snap, today) })).filter((o) => o.v != null).map((o) => ({ r: o.r, v: String(o.v).slice(0, 10) }));
      if (!withV.length) return { ...res, value: null, extreme: [] };
      const best = plan.op === 'latest' ? withV.reduce((a, b) => (b.v > a.v ? b : a)).v : withV.reduce((a, b) => (b.v < a.v ? b : a)).v;
      return { ...res, value: best, extreme: withV.filter((o) => o.v === best).map((o) => o.r), dated: withV.length };
    }
    case 'group_count': case 'group_sum': case 'group_avg': case 'pivot_two_dims': {
      const { groups, leftOut } = h.groupRows(rows, plan, snap, today);
      const out = [];
      for (const [k, g] of groups) {
        let value;
        if (!plan.measure) value = g.rows.length;
        else {
          const vals = g.rows.map((r) => h.measureValue(r, plan, snap, today)).filter((v) => v != null);
          value = h.aggregate(vals, plan.measure.agg === 'avg' ? 'avg' : 'sum');
          if (value == null) continue;
          value = plan.measure.unit === 'money' ? roundMoney(value) : Math.round(value * 100) / 100;
        }
        out.push({ key: k, parts: g.parts, value, n: g.rows.length, rows: g.rows });
      }
      sortGroups(out, plan);
      return { ...res, groups: out, groupLeftOut: leftOut, value: out.length };
    }
    case 'top_n': case 'bottom_n': {
      if (plan.rank === 'rows') {
        const withV = rows.map((r) => ({ r, v: h.measureValue(r, plan, snap, today) })).filter((o) => o.v != null);
        withV.sort((a, b) => (plan.dir === 'asc' ? a.v - b.v : b.v - a.v));
        if (!withV.length) return { ...res, ranked: [] };
        const cut = withV[Math.min(plan.limit, withV.length) - 1].v;
        const ranked = withV.filter((o) => (plan.dir === 'asc' ? o.v <= cut : o.v >= cut));
        return { ...res, ranked, nUsed: withV.length, cut, tiesBeyond: ranked.length > plan.limit };
      }
      const { groups, leftOut } = h.groupRows(rows, plan, snap, today);
      const out = [];
      for (const [k, g] of groups) {
        let value;
        if (!plan.measure) value = g.rows.length;
        else {
          const vals = g.rows.map((r) => h.measureValue(r, plan, snap, today)).filter((v) => v != null);
          value = h.aggregate(vals, plan.measure.agg === 'avg' ? 'avg' : 'sum');
          if (value == null) continue;
          value = plan.measure.unit === 'money' ? roundMoney(value) : Math.round(value * 100) / 100;
        }
        out.push({ key: k, parts: g.parts, value, n: g.rows.length, rows: g.rows });
      }
      out.sort((a, b) => (plan.dir === 'asc' ? a.value - b.value : b.value - a.value) || a.key.localeCompare(b.key));
      if (!out.length) return { ...res, ranked: [], groupLeftOut: leftOut };
      const cut = out[Math.min(plan.limit, out.length) - 1].value;
      const ranked = out.filter((g) => (plan.dir === 'asc' ? g.value <= cut : g.value >= cut));
      return { ...res, ranked, cut, groupLeftOut: leftOut, totalGroups: out.length };
    }
    case 'share_pct': {
      // denominator: same entity, same document type / visit scope and time span, none of the other conditions
      const denomPlan = { ...plan, filters: [] };
      const d = h.selectRows(denomPlan, snap, today);
      if (d.abstain) return { abstain: d.abstain };
      const den = d.rows.length;
      if (!den) return { ...res, num: 0, den: 0, pct: null };
      return { ...res, num: rows.length, den, pct: Math.round((rows.length / den) * 1000) / 10, denRows: d.rows };
    }
    case 'per_entity_avg': {
      let denom;
      if (plan.perEntity === 'customer') denom = snap.customers.length;
      else if (plan.perEntity === 'unit') denom = snap.units.length;
      else { const set = new Set(snap.documents.map((d) => d.tech).filter(Boolean)); denom = set.size; }
      if (!denom) return { abstain: 'no-denominator' };
      return { ...res, value: Math.round((rows.length / denom) * 10) / 10, denom };
    }
    case 'compare_two_values': {
      const sides = [];
      const mk = (label, p) => {
        const s = h.selectRows(p, snap, today);
        if (s.abstain) return null;
        let value;
        if (!plan.measure) value = s.rows.length;
        else {
          const vals = s.rows.map((r) => h.measureValue(r, p, snap, today)).filter((v) => v != null);
          if (s.rows.length && !vals.length) return null; // rows without the measured value on them: not a zero
          value = vals.length ? h.aggregate(vals, plan.measure.agg === 'avg' ? 'avg' : 'sum') : 0;
          value = plan.measure.unit === 'money' ? roundMoney(value) : Math.round(value * 100) / 100;
        }
        return { label, value, n: s.rows.length, rows: s.rows };
      };
      if (plan.compare.field) {
        for (const v of plan.compare.values) {
          const side = mk(v, { ...plan, filters: [...plan.filters, { field: plan.compare.field, op: 'eq', value: v, label: v }] });
          if (!side) return { abstain: 'compare' };
          sides.push(side);
        }
      } else {
        for (const tm of plan.compare.time) {
          const side = mk(tm.label, { ...plan, time: tm });
          if (!side) return { abstain: 'compare' };
          sides.push(side);
        }
      }
      return { ...res, sides, rows: sides.flatMap((s) => s.rows) };
    }
    default: return { abstain: 'op' };
  }
}

function sortKey(entity, r) {
  if (entity === 'customer') return String(r.name ?? '');
  if (entity === 'unit') return `${r.brand ?? ''} ${r.serial ?? ''}`;
  return `${r.date ?? ''} ${r.filename ?? ''}`;
}

function sortGroups(out, plan) {
  const first = plan.groupBy[0]?.by;
  const chrono = ['year', 'month', 'quarter', 'monthOfYear'].includes(first);
  if (chrono) out.sort((a, b) => a.key.localeCompare(b.key));
  else out.sort((a, b) => (b.value - a.value) || a.key.localeCompare(b.key));
}

registerFamily({ id: 'core', ops: CORE_OPS, detect, exec: execCore, say: sayResult });
export { detect as detectCore, execCore };
