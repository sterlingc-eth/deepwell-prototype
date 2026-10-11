/**
 * dql/say.js - turns an executor result into the answer: one plain sentence, the facts, the cited records, and a BASIS line that names
 * every condition that was applied. Every sentence template in this file is listed in the round report for the owner to approve.
 *
 *   sayResult(result, plan, {snap, today}) -> {text, facts, records, basis, total, claimedCount}
 */
import { documentTypeLabel } from '../documentTypes.js';
import { ENTITIES } from './fields.js';
import { dimLabel, displayKey, monthName } from './exec.js';

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtMoney = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtNum = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(iso ?? '');
}

function pluralize(label) {
  return String(label).split(' / ').map((l) => {
    const w = l.toLowerCase();
    if (/(s|x|ch|sh)$/.test(w) && !/ss$/.test(w)) return w;
    if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
    return `${w}s`;
  }).join(' / ');
}
const UNCOUNTABLE = /correspondence$/i;
function singular(label) { return String(label).toLowerCase(); }

/** The thing being counted, in words ("service tickets", "documents", "customers", "units"). */
export function nounOf(plan, n = 2) {
  if (plan.entity === 'customer') return n === 1 ? 'customer' : 'customers';
  if (plan.entity === 'unit') return n === 1 ? 'unit' : 'units';
  if (plan.visit) return n === 1 ? 'service visit' : 'service visits';
  if (plan.docType && !Array.isArray(plan.docType)) {
    // the owner's own word for it, when it is a plain noun ("quotes", "work orders"); the type's label otherwise
    const w = plan.docWord;
    if (w && w.length >= 4 && !/^(?:pos?|wo|pm)$/.test(w) && /^[a-z -]+$/.test(w)) {
      if (UNCOUNTABLE.test(w)) return w;
      const base = /ss$/.test(w) ? w : w.replace(/s$/, '');
      return n === 1 ? base : pluralize(base);
    }
    const label = documentTypeLabel(plan.docType) ?? plan.docType.replace(/-/g, ' ');
    if (UNCOUNTABLE.test(label)) return singular(label);
    return n === 1 ? singular(label) : pluralize(label);
  }
  return n === 1 ? 'document' : 'documents';
}

const DATE_RULE = {
  date: 'the service date, else the invoice date, else the upload date',
  serviceDate: 'the service date',
  invoiceDate: 'the invoice date',
  createdAt: 'the upload date',
  installDate: 'the installation date',
  warrantyExpires: 'the warranty expiration date',
  registeredDate: 'the warranty registration date',
};

/** One condition as a phrase for the sentence ("for Linda Fitzgerald", "in Mesa", "over $5,000"). */
function condPhrase(f, plan) {
  switch (f.field) {
    case 'customer': case 'name': return `for ${f.value}`;
    case 'tech': return `with technician ${f.value}`;
    case 'vendor': return `from ${f.value}`;
    case 'city': return `in ${Array.isArray(f.value) ? f.value.join(' or ') : f.value}`;
    case 'brand': return `of the ${Array.isArray(f.value) ? f.value.join(' or ') : f.value} brand`;
    case 'refrigerant': return `using ${f.value}`;
    case 'tonnage': return f.label ? `at ${f.label}` : `at ${f.value} ton`;
    case 'status': return `with status ${f.value}`;
    case 'serviceType': return `with service type ${Array.isArray(f.value) ? f.value.join(' or ') : f.value}`;
    case 'model': return `model ${f.value}`;
    case 'docCount': case 'unitCount': case 'visitCount': case 'billed': case 'hasBrand': return f.label;
    case 'equipmentType': return `of type ${f.value}`;
    default: return f.label ?? `${f.field} ${f.op} ${f.value}`;
  }
}
const timePhrase = (t) => (t ? t.label : '');

/** " for X in Y dated Z" — the conditions after the noun. */
export function condText(plan) {
  const parts = (plan.filters ?? []).map((f) => condPhrase(f, plan));
  if (plan.time) parts.push(timePhrase(plan.time));
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function basisLine(verb, plan, res, snap, extra = '') {
  const conds = [];
  if (plan.docType && !Array.isArray(plan.docType)) conds.push(`${nounOf(plan, 2)} only`);
  if (plan.visit) conds.push('documents that carry a service date');
  for (const f of plan.filters ?? []) conds.push(condPhrase(f, plan));
  if (plan.time) conds.push(`${plan.time.label} (by ${DATE_RULE[plan.time.field] ?? plan.time.field})`);
  if (plan.measure?.field === 'total') conds.push('amounts as printed on each document');
  const scope = plan.entity === 'document' ? (plan.visit ? 'every document on file' : plan.docType && !Array.isArray(plan.docType) ? `every ${singular(documentTypeLabel(plan.docType) ?? plan.docType)} on file` : 'every document on file') : plan.entity === 'customer' ? 'every customer on file' : 'every unit on file';
  const tail = [];
  if (res.leftOut) tail.push(`${fmtInt(res.leftOut)} ${nounOf(plan, res.leftOut)} with no ${plan.time ? (DATE_RULE[plan.time.field] ?? 'date').replace(/^the /, '') : 'date'} on file were not counted`);
  if (res.unitless) tail.push(`${fmtInt(res.unitless)} ${nounOf(plan, res.unitless)} with no ${plan.measure?.label ?? 'amount'} on file were left out`);
  if (plan.entity === 'document') tail.push('internal-only papers and HR letters are left out');
  return `${verb} ${scope}${conds.length ? `: ${conds.join('; ')}` : ''}.${tail.length ? ` ${tail.map((t, i) => (i === 0 ? t[0].toUpperCase() + t.slice(1) : t)).join('; ')}.` : ''}${extra ? ` ${extra}` : ''}`;
}

/* ------------------------------------------------------------------ records */

export function recordFor(plan, row, snap) {
  const entity = plan.entity;
  if (entity === 'customer') return { type: 'customer', id: row.id, label: row.name ?? 'Unnamed customer', sublabel: row.address ?? undefined };
  if (entity === 'unit') return { type: 'unit', id: row.id, label: [row.brand, row.type].filter(Boolean).join(' ') || 'Equipment', sublabel: [row.model, row.serial ? `serial ${row.serial}` : null].filter(Boolean).join(' · '), customerId: row.custId ?? undefined };
  const label = row.filename ?? documentTypeLabel(row.type) ?? 'Document';
  return { type: row.type === 'invoice' ? 'invoice' : 'document', id: row.id, documentId: row.id, label, sublabel: [documentTypeLabel(row.type), row.date ? fmtDate(row.date) : null, row.custName].filter(Boolean).join(' · ') };
}
const recordsOf = (plan, rows, snap, max = 200) => rows.slice(0, max).map((r) => recordFor(plan, r, snap));

/** One row in a sentence. `detail` 0 = just its id, 1 = id and customer, 2 = id, customer, date and amount. */
function labelOf(plan, row, detail = 2, skipCustomer = false) {
  if (plan.entity === 'customer') return row.name ?? 'Unnamed customer';
  if (plan.entity === 'unit') {
    // serial, brand, model - the order the paperwork prints them
    const core = [row.serial, row.brand, row.model].filter(Boolean).join(' ') || 'unit';
    if (detail === 0) return row.serial ?? core;
    const bits = [!skipCustomer ? row.custName : null, detail >= 2 && row.installDate ? `installed ${fmtDate(row.installDate)}` : null].filter(Boolean);
    return bits.length ? `${core} (${bits.join(', ')})` : core;
  }
  const num = row.f?.invoice_number ?? row.f?.po_number ?? row.f?.permit_number ?? null;
  if (detail >= 2) {
    // a short list: the paper's own number or file name, then who it is for, when, and the amount
    const id = num ?? row.filename ?? documentTypeLabel(row.type);
    const bits = [num && row.filename ? row.filename : null, !skipCustomer ? row.custName : null, row.date ? fmtDate(row.date) : null, row.total != null ? fmtMoney(row.total) : null].filter(Boolean);
    return bits.length ? `${id} (${bits.join(', ')})` : id;
  }
  // a longer list has to stay readable: a numbered paper by its number, an unnumbered one (a quote, a ticket) by whose it is
  const id = num ?? (!skipCustomer && row.custName ? row.custName : null) ?? row.filename ?? documentTypeLabel(row.type);
  if (detail === 0 || !num || skipCustomer || !row.custName) return id;
  return `${id} (${row.custName})`;
}
const detailFor = (n) => (n <= 5 ? 2 : n <= 12 ? 1 : 0);
const hasCustFilter = (plan) => (plan.filters ?? []).some((f) => f.field === 'customer' || f.field === 'name');

const listNames = (arr, cap = 40, sep = ', ') => (arr.length > cap ? `${arr.slice(0, cap).join(sep)}${sep.trim() === ';' ? ';' : ','} and ${fmtInt(arr.length - cap)} more` : arr.join(sep));
const cap1 = (s) => s[0].toUpperCase() + s.slice(1);
const none = (plan, cond) => `No ${nounOf(plan, 2)}${cond} on file.`;

function valueText(plan, v) {
  const u = plan.measure?.unit;
  if (u === 'money') return fmtMoney(v);
  const r1 = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 1 });

  if (u === 'years') return `${r1(v)} year${v === 1 ? '' : 's'}`;
  if (u === 'hours' || u === 'tons') return `${fmtNum(v)} ${u === 'hours' ? 'hour' : 'ton'}${v === 1 ? '' : 's'}`;
  return fmtNum(v);
}

const DIM_NOUN = { tech: 'technician', city: 'city', brand: 'brand', customer: 'customer', vendor: 'vendor', status: 'status', serviceType: 'service type', refrigerant: 'refrigerant', tonnage: 'tonnage', model: 'model', type: 'document type', equipmentType: 'equipment type', year: 'year', month: 'month', quarter: 'quarter', monthOfYear: 'month of the year' };
const dimNoun = (d) => DIM_NOUN[d.by] ?? d.by;

function groupLines(plan, res, snap, today, cap = 40) {
  const parts = res.groups.map((g) => {
    const label = g.parts.map((p, i) => displayKey(plan, i, p, snap)).map((p, i) => (['year', 'month', 'quarter', 'monthOfYear'].includes(plan.groupBy[i].by) ? dimLabel(plan.groupBy[i].by, g.parts[i]) : p)).join(' / ');
    return `${label}: ${plan.measure ? valueText(plan, g.value) : fmtInt(g.value)}`;
  });
  return listNames(parts, cap, '; ');
}

/** The answer. `res.abstain` is handled by the caller (null). */
export function sayResult(res, plan, { snap, today }) {
  const E = ENTITIES[plan.entity];
  const cond = condText(plan);
  const n = res.n;
  const out = { text: '', facts: [], records: [], basis: '', total: n, claimedCount: null };
  const rowsAll = res.rows ?? [];
  const noun = (k) => nounOf(plan, k);

  switch (plan.op) {
    case 'count': {
      out.text = n === 0 ? none(plan, cond) : `${fmtInt(n)} ${noun(n)}${cond}.`;
      out.facts = [{ label: cap1(noun(2)), value: fmtInt(n) }];
      out.records = recordsOf(plan, rowsAll, snap); out.total = n; out.claimedCount = n;
      out.basis = basisLine('Counted', plan, res, snap);
      break;
    }
    case 'exists_yes_no': {
      out.text = res.yes ? `Yes, ${fmtInt(n)} ${noun(n)}${cond} ${n === 1 ? 'is' : 'are'} on file.` : `No. ${none(plan, cond)}`;
      out.facts = [{ label: cap1(noun(2)), value: fmtInt(n) }];
      out.records = recordsOf(plan, rowsAll, snap); out.total = n; out.claimedCount = n;
      out.basis = basisLine('Checked', plan, res, snap);
      break;
    }
    case 'list': {
      if (res.distinctItems) {
        const items = res.distinctItems;
        const dn = DIM_NOUN[plan.distinct] ?? plan.distinct;
        out.text = items.length === 0 ? `No ${dn}s${cond} are on file.` : `${fmtInt(items.length)} ${items.length === 1 ? dn : `${dn}s`}${cond}: ${listNames(items.map((i) => i.value))}.`;
        out.facts = items.length <= 7 ? items.map((i) => ({ label: cap1(dn), value: i.value })) : [{ label: `Different ${dn}s`, value: fmtInt(items.length) }];
        out.records = recordsOf(plan, items.flatMap((i) => i.rows), snap); out.total = out.records.length;
        out.basis = basisLine('Listed the different values of one field across', plan, res, snap);
        break;
      }
      const list = res.list;
      if (!list.length) { out.text = none(plan, cond); out.records = []; out.total = 0; out.basis = basisLine('Checked', plan, res, snap); break; }
      const names = list.map((r) => labelOf(plan, r, detailFor(list.length), hasCustFilter(plan)));
      out.text = plan.sort
        ? `The ${list.length === 1 ? '' : `${fmtInt(list.length)} `}${plan.sort.dir === 'desc' ? 'most recent' : 'oldest'} ${noun(list.length)}${cond}: ${listNames(names)}.`
        : `${fmtInt(n)} ${noun(n)}${cond}: ${listNames(names)}.`;
      out.facts = list.length <= 7 ? list.map((r) => ({ label: cap1(noun(1)), value: labelOf(plan, r, 1, hasCustFilter(plan)) })) : [{ label: cap1(noun(2)), value: fmtInt(plan.sort ? list.length : n) }];
      out.records = recordsOf(plan, list, snap); out.total = plan.sort ? list.length : n; out.claimedCount = plan.sort ? null : n;
      out.basis = basisLine('Listed', plan, res, snap);
      break;
    }
    case 'count_distinct': {
      const dn = DIM_NOUN[plan.distinct] ?? plan.distinct;
      const items = res.distinctItems;
      out.text = res.value === 0 ? `No ${dn} is recorded${cond}.` : `${fmtInt(res.value)} different ${res.value === 1 ? dn : `${dn}s`}${cond}${res.value <= 20 ? `: ${items.map((i) => i.value).sort().join(', ')}` : ''}.`;
      out.facts = [{ label: `Different ${dn}s`, value: fmtInt(res.value) }];
      out.records = recordsOf(plan, items.flatMap((i) => i.rows), snap); out.total = out.records.length;
      out.basis = basisLine('Counted the different values of one field across', plan, res, snap, res.missing ? `${fmtInt(res.missing)} ${noun(res.missing)} had no ${dn} on file.` : '');
      break;
    }
    case 'sum': {
      const what = plan.measure.field === 'total' ? `${cap1(noun(2))} total` : plan.measure.field === 'hours' ? 'Labor hours total' : 'Tonnage totals';
      out.text = res.value == null ? `${none(plan, cond)} The total is ${valueText(plan, 0)}.` : `${what} ${valueText(plan, res.value)}${cond} (${fmtInt(res.nUsed)} ${noun(res.nUsed)}).`;
      out.facts = [{ label: what, value: res.value == null ? valueText(plan, 0) : valueText(plan, res.value) }];
      out.records = recordsOf(plan, res.used ?? rowsAll, snap); out.total = (res.used ?? rowsAll).length;
      out.basis = basisLine('Added up', plan, res, snap);
      break;
    }
    case 'avg': case 'median': {
      const word = plan.op === 'avg' ? 'average' : 'median';
      if (res.value == null) { out.text = `${none(plan, cond)} There is no ${word} to give.`; out.records = []; out.total = 0; out.basis = basisLine('Checked', plan, res, snap); break; }
      out.text = `The ${word} ${plan.measure.field === 'total' ? `${noun(1)} total` : plan.measure.label} is ${valueText(plan, res.value)}${cond}, across ${fmtInt(res.nUsed)} ${noun(res.nUsed)} with ${plan.measure.field === 'total' ? 'an amount' : `${plan.measure.label} recorded`}.`;
      out.facts = [{ label: cap1(word), value: valueText(plan, res.value) }];
      out.records = recordsOf(plan, res.used ?? rowsAll, snap); out.total = (res.used ?? rowsAll).length;
      out.basis = basisLine(plan.op === 'avg' ? 'Averaged' : 'Took the middle value of', plan, res, snap);
      break;
    }
    case 'max': case 'min': {
      const tied = res.extreme;
      if (!tied.length) { out.text = `${none(plan, cond)}`; out.records = []; out.total = 0; out.basis = basisLine('Checked', plan, res, snap); break; }
      const word = plan.op === 'max' ? 'highest' : 'lowest';
      const names = tied.map((r) => labelOf(plan, r, detailFor(tied.length), hasCustFilter(plan)));
      out.text = tied.length === 1 ? `The ${word} ${plan.measure.field === 'total' ? `${noun(1)} total` : plan.measure.label}${cond} is ${valueText(plan, res.value)}: ${names[0]}.` : `The ${word} ${plan.measure.field === 'total' ? `${noun(1)} total` : plan.measure.label}${cond} is ${valueText(plan, res.value)}, shared by ${fmtInt(tied.length)} ${noun(tied.length)}: ${listNames(names, 15)}.`;
      out.facts = [{ label: cap1(word), value: valueText(plan, res.value) }];
      out.records = recordsOf(plan, tied, snap); out.total = tied.length; out.claimedCount = null;
      out.basis = basisLine(plan.op === 'max' ? 'Looked for the highest among' : 'Looked for the lowest among', plan, res, snap);
      break;
    }
    case 'latest': case 'first_ever': {
      const tied = res.extreme;
      const word = plan.op === 'latest' ? 'latest' : 'earliest';
      const fieldName = (DATE_RULE[plan.sortField] ?? 'date').replace(/^the /, '');
      if (!tied.length) { out.text = `${none(plan, cond)}`; out.records = []; out.total = 0; out.basis = basisLine('Checked', plan, res, snap); break; }
      const names = tied.map((r) => labelOf(plan, r, detailFor(tied.length), hasCustFilter(plan)));
      out.text = tied.length === 1 ? `The ${word} ${noun(1)}${cond} is ${names[0]}, dated ${fmtDate(res.value)}.` : `The ${word} date${cond} is ${fmtDate(res.value)}, shared by ${fmtInt(tied.length)} ${noun(tied.length)}: ${listNames(names, 15)}.`;
      out.facts = [{ label: cap1(word), value: fmtDate(res.value) }];
      out.records = recordsOf(plan, tied, snap); out.total = tied.length;
      out.basis = basisLine('Looked at the dates of', plan, res, snap, `Dated by ${DATE_RULE[plan.sortField] ?? 'its date'}.`);
      break;
    }
    case 'group_count': case 'group_sum': case 'group_avg': case 'pivot_two_dims': {
      const dims = plan.groupBy.map(dimNoun).join(' and ');
      const grand = plan.measure && plan.op !== 'group_avg' ? ` (${valueText(plan, res.groups.reduce((a, g) => a + g.value, 0))} in all)` : '';
      const head = plan.measure
        ? (plan.op === 'group_avg' ? `Average ${plan.measure.field === 'total' ? `${noun(1)} total` : `${plan.measure.label} per ${noun(1)}`}` : `${cap1(noun(2))} ${plan.measure.field === 'total' ? 'total' : plan.measure.label}`)
        : `${fmtInt(n - (res.groupLeftOut ?? 0))} ${noun(2)}`;
      if (!res.groups.length) { out.text = none(plan, cond); out.records = []; out.total = 0; out.basis = basisLine('Grouped', plan, res, snap); break; }
      out.text = `${head} by ${dims}${cond}${grand}: ${groupLines(plan, res, snap, today)}.`;
      out.facts = res.groups.length <= 7 ? res.groups.map((g) => ({ label: g.parts.join(' / '), value: plan.measure ? valueText(plan, g.value) : fmtInt(g.value) })) : [{ label: `${cap1(dims)} groups`, value: fmtInt(res.groups.length) }];
      out.records = recordsOf(plan, res.groups.flatMap((g) => g.rows), snap); out.total = res.groups.reduce((a, g) => a + g.rows.length, 0);
      out.basis = basisLine('Grouped', plan, { ...res, leftOut: (res.leftOut ?? 0) + (res.groupLeftOut ?? 0) }, snap);
      break;
    }
    case 'top_n': case 'bottom_n': {
      const word = plan.op === 'top_n' ? 'Top' : 'Bottom';
      if (plan.rank === 'rows') {
        const r = res.ranked;
        if (!r.length) { out.text = none(plan, cond); out.records = []; out.total = 0; out.basis = basisLine('Ranked', plan, res, snap); break; }
        const lines = r.map((o, i) => `${i + 1}. ${labelOf(plan, o.r, 1, hasCustFilter(plan))}: ${valueText(plan, o.v)}`);
        out.text = `The ${plan.op === 'top_n' ? 'highest' : 'lowest'} ${fmtInt(plan.limit)} ${noun(2)}${cond}: ${listNames(lines, 25, '; ')}.${res.tiesBeyond ? ` ${fmtInt(r.length)} are shown because of a tie at ${valueText(plan, res.cut)}.` : ''}`;
        out.facts = r.length <= 7 ? r.map((o) => ({ label: labelOf(plan, o.r, 1, hasCustFilter(plan)), value: valueText(plan, o.v) })) : [{ label: `${cap1(noun(2))} ranked`, value: fmtInt(r.length) }];
        out.records = recordsOf(plan, r.map((o) => o.r), snap); out.total = r.length;
        out.basis = basisLine('Ranked', plan, res, snap);
        break;
      }
      const r = res.ranked;
      if (!r.length) { out.text = none(plan, cond); out.records = []; out.total = 0; out.basis = basisLine('Ranked', plan, res, snap); break; }
      const dn = dimNoun(plan.groupBy[0]);
      const lines = r.map((g, i) => `${i + 1}. ${displayKey(plan, 0, g.parts[0], snap)}: ${plan.measure ? valueText(plan, g.value) : fmtInt(g.value)}`);
      const by = plan.measure ? (plan.measure.field === 'total' ? `${noun(1)} dollars` : plan.measure.label) : noun(2);
      out.text = plan.limit === 1 && r.length === 1
        ? `${displayKey(plan, 0, r[0].parts[0], snap)} (${plan.measure ? valueText(plan, r[0].value) : fmtInt(r[0].value)}) has the ${plan.dir === 'asc' ? 'fewest' : 'most'} ${by}${cond}.`
        : `${plan.limit === 1 ? `Tied for ${plan.dir === 'asc' ? 'fewest' : 'most'}` : `${word} ${fmtInt(plan.limit)}`} ${dn}s by ${by}${cond}: ${listNames(lines, 25, '; ')}.${r.length > plan.limit ? ` ${fmtInt(r.length)} are shown because of a tie at ${plan.measure ? valueText(plan, res.cut) : fmtInt(res.cut)}.` : ''}`;
      out.facts = r.length <= 7 ? r.map((g) => ({ label: displayKey(plan, 0, g.parts[0], snap), value: plan.measure ? valueText(plan, g.value) : fmtInt(g.value) })) : [{ label: `${cap1(dn)}s ranked`, value: fmtInt(r.length) }];
      out.records = recordsOf(plan, r.flatMap((g) => g.rows), snap); out.total = r.reduce((a, g) => a + g.rows.length, 0);
      out.basis = basisLine('Ranked', plan, { ...res, leftOut: (res.leftOut ?? 0) + (res.groupLeftOut ?? 0) }, snap);
      break;
    }
    case 'share_pct': {
      if (!res.den) { out.text = `No ${noun(2)} in that scope are on file, so there is no share to give.`; out.records = []; out.total = 0; out.basis = basisLine('Checked', plan, res, snap); break; }
      out.text = `${fmtInt(res.num)} of ${fmtInt(res.den)} ${noun(res.den)} (${res.pct}%)${cond}.`;
      out.facts = [{ label: 'Share', value: `${res.pct}%` }];
      out.records = recordsOf(plan, rowsAll, snap); out.total = res.num; out.claimedCount = null;
      out.basis = basisLine(`Divided the matching ${noun(2)} by`, plan, res, snap, `The base is all ${noun(2)} in the same scope${plan.time ? ' and period' : ''}, before the other conditions.`);
      break;
    }
    case 'per_entity_avg': {
      out.text = `About ${Number(res.value).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${noun(2)} per ${plan.perEntity} on average (${fmtInt(n)} ${noun(n)} across ${fmtInt(res.denom)} ${plan.perEntity}s).`;
      out.facts = [{ label: `${cap1(noun(2))} per ${plan.perEntity}`, value: fmtNum(res.value) }];
      out.records = recordsOf(plan, rowsAll, snap); out.total = n; out.claimedCount = n;
      out.basis = basisLine('Divided the count of', plan, res, snap, `by every ${plan.perEntity} on file, including those with none.`);
      break;
    }
    case 'compare_two_values': {
      const [a, b] = res.sides;
      const f = (s) => (plan.measure ? valueText(plan, s.value) : `${fmtInt(s.value)} ${noun(s.value)}`);
      const lead = a.value === b.value ? 'They are equal.' : `${a.value > b.value ? a.label : b.label} is higher by ${plan.measure ? valueText(plan, Math.abs(a.value - b.value)) : fmtInt(Math.abs(a.value - b.value))}.`;
      out.text = `${a.label} has ${f(a)} and ${b.label} has ${f(b)}${cond}. ${lead}`;
      out.facts = res.sides.map((s) => ({ label: s.label, value: f(s) }));
      out.records = recordsOf(plan, res.rows, snap); out.total = res.rows.length;
      out.basis = basisLine('Compared two values over', plan, res, snap);
      break;
    }
    default: return null;
  }
  return out;
}
