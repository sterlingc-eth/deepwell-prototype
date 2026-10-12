/**
 * dql/families/time.js - the time family: questions about WHEN things happened, how often, how long ago, and what ends soon.
 *
 *   tm_series    "visits by year", "trend in quotes by year", "monthly work orders this year", "busiest month in 2025", "which weekday do most visits
 *                happen on", "PM tickets by month of year", "summer vs winter visits"          (a count or a total per period, a peak, a season split)
 *   tm_compare   "compare invoice revenue 2025 vs 2026", "percent change in revenue 2025 to 2026", "visits so far this year compared with last year"
 *   tm_rate      "how many invoices per year on average", "average gap between installs"
 *   tm_since     "days since the last visit for X", "how long since we last billed X", "last time anyone worked on X"
 *   tm_inactive  "customers we have not serviced in over a year", "who has not been invoiced since 2024"
 *   tm_expiry    "which warranties expire in the next 90 days", "agreements ending this year", "the next warranty to expire", "warranties that ran out in 2025"
 *   tm_between   "days between PO-9004 and PO-9010", "how many days until the agreement for X runs out", "days from install to registration"
 *   tm_age       "how old is the unit with serial X", "average age of our installed base"
 *
 * How it reads a question: parse.js hands this family the whole sentence (feat.text0) through `slots`, before its coverage check. The family lexes
 * the sentence into typed items (names, document types, brands, cities, serials, document numbers, periods) and matches it with its own grammar.
 * EVERY word must be explained; one unexplained word, an ambiguous reading ("last" with no way to tell, a month with no year, a measure that could
 * be visits or dollars) or a name on file twice releases the question. Payment status, balances and due dates are not tracked and are never answered.
 *
 * Definitions this family states in every answer it gives:
 *  - a service visit is any paper that carries a service date; invoices, quotes and other papers are dated by their own date;
 *  - an average per month or per year counts the periods with nothing in them;
 *  - only dates that are really on file are used (a unit's warranty end date, a maintenance agreement's term, an installation date).
 */
import { VISIT_ALT } from '../industryLex.js';
import { ynOf, ynText } from '../yn.js';
import { registerFamily } from '../registry.js';
import { FILLER } from '../lex.js';
import { normName } from '../vocab.js';
import { fmtDate, recordFor } from '../say.js';
import { editDistance } from '../text.js';
import { documentTypeLabel } from '../../documentTypes.js';
import { nthOf, nthWord } from '../ordinal.js';

export const TIME_OPS = ['tm_window', 'tm_series', 'tm_compare', 'tm_rate', 'tm_since', 'tm_inactive', 'tm_expiry', 'tm_between', 'tm_age'];

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtMoney = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtNum = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
/** A number to two decimals (no trailing zeros) and, when it differs, to one decimal: owners read either. */
const trimNum = (v, d) => Number(v).toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const dualNum = (v) => { const main = Number(v).toFixed(1); const two = trimNum(v, 2); return { main: Number(main).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), alt: Number(two) !== Number(main) ? Number(two).toLocaleString('en-US', { maximumFractionDigits: 2 }) : null }; };
const plainInt = (n) => String(Math.round(Number(n)));
/** "1,243 days (about 3.4 years)": long spans get a years hint. */
const dayText = (n) => { const d = Math.round(Number(n)); return `${fmtInt(d)} day${d === 1 ? '' : 's'}${d >= 365 ? ` (about ${fmtNum(d / 365.25, 1)} years)` : ''}`; };
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lc = (v) => (v == null ? null : String(v).toLowerCase().trim());
const listNames = (arr, cap = 40, sep = ', ') => (arr.length > cap ? `${arr.slice(0, cap).join(sep)}${sep.trim() === ';' ? ';' : ','} and ${fmtInt(arr.length - cap)} more` : arr.join(sep));

/* ====================================================================== dates */

const MS = 86400000;
const T = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((T(b) - T(a)) / MS);
const addDays = (iso, n) => isoOf(T(iso) + n * MS);
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n;
  const yy = Math.floor(t / 12); const mm = (t % 12) + 1;
  return `${yy}-${pad(mm)}-${pad(Math.min(d, lastDayOf(yy, mm)))}`;
}
const addYears = (iso, n) => addMonths(iso, n * 12);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTH_NAMES[Number(m) - 1]} ${y}`; };

const MONA = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const MONNUM = (w) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(w).slice(0, 3)) + 1;
const YEAR = '(?:19|20)\\d\\d';
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90 };
const NUM = `\\d+|${Object.keys(NUMW).join('|')}`;
const numOf = (w) => (/^\d+$/.test(w) ? Number(w) : NUMW[w] ?? null);

/* ====================================================================== the working string */

class Rest {
  constructor(s) { this.s = s; }
  take(re) { const m = re.exec(this.s); if (!m) return null; this.blank(m.index, m[0].length); return m; }
  takeAll(re) { const out = []; for (let m; (m = this.take(re));) out.push(m); return out; }
  blank(i, len) { this.s = this.s.slice(0, i) + ' '.repeat(len) + this.s.slice(i + len); }
  has(re) { return re.test(this.s); }
  words() { return this.s.split(/\s+/).filter(Boolean); }
  clone() { return new Rest(this.s); }
}
const EXTRA_FILLER = new Set('um uh hmm anyone anybody someone by out show tell give list display pull find us yet how serial name'.split(' '));
const isFiller = (w) => FILLER.has(w) || EXTRA_FILLER.has(w);
const rx = (src, flags = 'i') => new RegExp(`(?<![a-z0-9@$.-])(?:${src})(?![a-z0-9-])`, flags);

/* ====================================================================== periods */

/** Read every period in the sentence (left to right) and blank it. {periods:[{idx,...}], fail:true when a period is ambiguous}. */
function takePeriods(r, today) {
  const Y = Number(today.slice(0, 4));
  const found = [];
  const add = (m, p) => { r.blank(m.index, m[0].length); found.push({ idx: m.index, ...p }); };
  const yearP = (y, extra = {}) => ({ kind: 'year', y, from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), ...extra });
  const quarterP = (y, q, extra = {}) => ({ kind: 'quarter', y, q, from: `${y}-${pad((q - 1) * 3 + 1)}-01`, to: `${y}-${pad(q * 3)}-${pad(lastDayOf(y, q * 3))}`, label: `Q${q} ${y}`, ...extra });
  const monthP = (y, m, extra = {}) => ({ kind: 'month', y, m, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`, label: `${MONTH_NAMES[m - 1]} ${y}`, ...extra });
  const ORD = { first: 1, second: 2, third: 3, fourth: 4 };
  const DIR = '(?:(since|before|after|until|till|through|prior\\s+to|by)\\s+)?';
  const PREP = '(?:(?:in|during|for|of|from|within|over|between)\\s+)?(?:the\\s+)?';
  let m;
  // "the first quarter of 2026", "q3 2026", "2026 q3"
  while ((m = rx(`${PREP}(first|second|third|fourth)\\s+quarter\\s+(?:of\\s+)?(${YEAR})`).exec(r.s))) add(m, quarterP(Number(m[2]), ORD[m[1].toLowerCase()]));
  while ((m = rx(`${PREP}q([1-4])\\s+(?:of\\s+)?(${YEAR})`).exec(r.s))) add(m, quarterP(Number(m[2]), Number(m[1])));
  while ((m = rx(`${PREP}(${YEAR})\\s+q([1-4])`).exec(r.s))) add(m, quarterP(Number(m[1]), Number(m[2])));
  while ((m = rx('(this|last|previous|next)\\s+q([1-4])').exec(r.s))) { const k = m[1].toLowerCase(); const y = k === 'this' ? Y : k === 'next' ? Y + 1 : Y - 1; add(m, quarterP(y, Number(m[2]))); }
  // a month with its year
  while ((m = rx(`${DIR}${PREP}(${MONA})\\s+(${YEAR})`).exec(r.s))) {
    const mm = MONNUM(m[2].toLowerCase());
    add(m, { ...monthP(Number(m[3]), mm), dir: m[1] ? m[1].toLowerCase().replace(/\s+/g, ' ') : null });
  }
  // a rolling window and the equal one before it
  while ((m = rx(`(?:the\\s+)?(${NUM})\\s+(days?|weeks?|months?|years?)\\s+(?:before|prior)(?:\\s+(?:that|those|them))?`).exec(r.s))) add(m, { kind: 'prior', n: numOf(m[1].toLowerCase()), unit: m[2].toLowerCase().replace(/s$/, '') });
  while ((m = rx(`${PREP}(?:the\\s+)?next\\s+(${NUM})\\s+(days?|weeks?|months?|years?)`).exec(r.s))) {
    const n = numOf(m[1].toLowerCase()); const unit = m[2].toLowerCase().replace(/s$/, '');
    const to = unit === 'day' ? addDays(today, n) : unit === 'week' ? addDays(today, 7 * n) : unit === 'month' ? addMonths(today, n) : addYears(today, n);
    add(m, { kind: 'fwd', n, unit, from: today, to, label: `in the next ${n} ${unit}${n === 1 ? '' : 's'}` });
  }
  while ((m = rx(`(?:(in|within|over)\\s+)?(?:the\\s+)?(last|past|previous|prior)\\s+(${NUM})\\s+(days?|weeks?|months?|years?)`).exec(r.s))) {
    const n = numOf(m[3].toLowerCase()); const unit = m[4].toLowerCase().replace(/s$/, '');
    const from = unit === 'day' ? addDays(today, -n) : unit === 'week' ? addDays(today, -7 * n) : unit === 'month' ? addMonths(today, -n) : addYears(today, -n);
    add(m, { kind: 'roll', n, unit, from, to: today, label: `in the last ${n} ${unit}${n === 1 ? '' : 's'}` });
  }
  while ((m = rx(`(?:in|for|within)\\s+(${NUM})\\s+(days?|weeks?|months?|years?)`).exec(r.s))) {
    const n = numOf(m[1].toLowerCase()); const unit = m[2].toLowerCase().replace(/s$/, '');
    const from = unit === 'day' ? addDays(today, -n) : unit === 'week' ? addDays(today, -7 * n) : unit === 'month' ? addMonths(today, -n) : addYears(today, -n);
    add(m, { kind: 'rollx', n, unit, from, to: today, label: `in the last ${n} ${unit}${n === 1 ? '' : 's'}` });
  }
  while ((m = rx(`(?:in\\s+)?over\\s+(${NUM})\\s+(days?|weeks?|months?|years?)`).exec(r.s))) {
    const n = numOf(m[1].toLowerCase()); const unit = m[2].toLowerCase().replace(/s$/, '');
    const from = unit === 'day' ? addDays(today, -n) : unit === 'week' ? addDays(today, -7 * n) : unit === 'month' ? addMonths(today, -n) : addYears(today, -n);
    add(m, { kind: 'roll', n, unit, from, to: today, over: true, label: `over the last ${n} ${unit}${n === 1 ? '' : 's'}` });
  }
  while ((m = rx(`since\\s+the\\s+(?:start|beginning)\\s+of\\s+(${YEAR})`).exec(r.s))) add(m, { kind: 'range', from: `${m[1]}-01-01`, to: today, label: `since the start of ${m[1]}` });
  while ((m = rx(`(?:in\\s+)?(${NUM})\\s+(days?|weeks?|months?|years?)\\s+(?:ending|through|up\\s+to)(?:\\s+today)?`).exec(r.s))) {
    const n = numOf(m[1].toLowerCase()); const unit = m[2].toLowerCase().replace(/s$/, '');
    const from = unit === 'day' ? addDays(today, -n) : unit === 'week' ? addDays(today, -7 * n) : unit === 'month' ? addMonths(today, -n) : addYears(today, -n);
    add(m, { kind: 'roll', n, unit, from, to: today, label: `in the last ${n} ${unit}${n === 1 ? '' : 's'}` });
  }
  while ((m = rx('by\\s+the\\s+end\\s+of\\s+(?:the|this)\\s+year').exec(r.s))) add(m, { kind: 'range', from: today, to: `${Y}-12-31`, label: `by the end of ${Y}` });
  while ((m = rx('year\\s+to\\s+date|ytd|so\\s+far\\s+this\\s+year|this\\s+year\\s+so\\s+far|year\\s+so\\s+far').exec(r.s))) add(m, { kind: 'ytd', y: Y, from: `${Y}-01-01`, to: today, label: `${Y} so far` });
  while ((m = rx('(?:the\\s+)?year\\s+before\\s+last').exec(r.s))) add(m, yearP(Y - 2, { rel: 'yearBeforeLast' }));
  while ((m = rx('the\\s+year\\s+before(?:\\s+that)?(?!\\s+(?:last|\\d))').exec(r.s))) add(m, { kind: 'yearBefore' });
  while ((m = rx(`${PREP}next\\s+(year|quarter|month)`).exec(r.s))) {
    const u = m[1].toLowerCase();
    if (u === 'year') add(m, yearP(Y + 1, { rel: 'nextYear' }));
    else if (u === 'month') { const base = addMonths(`${today.slice(0, 7)}-01`, 1); add(m, monthP(Number(base.slice(0, 4)), Number(base.slice(5, 7)), { rel: 'nextMonth' })); } else { const cq = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1; let y = Y; let q = cq + 1; if (q === 5) { q = 1; y = Y + 1; } add(m, quarterP(y, q, { rel: 'nextQuarter' })); }
  }
  while ((m = rx(`${PREP}(this|current|last|previous|prior)\\s+(year|quarter|month|week)`).exec(r.s))) {
    const k = m[1].toLowerCase(); const u = m[2].toLowerCase(); const cur = k === 'this' || k === 'current';
    if (u === 'year') add(m, yearP(cur ? Y : Y - 1, { rel: cur ? 'thisYear' : 'lastYear', partial: cur }));
    else if (u === 'week') return { periods: [], fail: true };
    else if (u === 'month') { const base = cur ? today : addMonths(`${today.slice(0, 7)}-01`, -1); add(m, monthP(Number(base.slice(0, 4)), Number(base.slice(5, 7)), { rel: cur ? 'thisMonth' : 'lastMonth' })); }
    else { const cq = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1; let y = Y; let q = cur ? cq : cq - 1; if (q === 0) { q = 4; y = Y - 1; } add(m, quarterP(y, q, { rel: cur ? 'thisQuarter' : 'lastQuarter' })); }
  }
  // a span between two years, or from a year up to now: "between 2024 and now", "2024 to now", "from 2022 through 2024". The whole span counts, never its first year alone.
  while ((m = rx(`(?:(?:between|from)\\s+)?(${YEAR})\\s+(?:and|to|through|thru|until|till|up\\s+to)\\s+(now|today|present|date)`).exec(r.s))) {
    const y1 = Number(m[1]); const y2 = null;
    add(m, { kind: 'range', from: `${y1}-01-01`, to: y2 != null ? `${y2}-12-31` : today, label: y2 != null ? `from ${y1} to ${y2}` : `from ${y1} to today` });
  }
  // "to now" / "until today" left over after the year was read some other way: the end of a range nobody read
  if (rx('(?:to|until|till|through|thru|up\\s+to)\\s+(?:now|today|present|date)').test(r.s)) return { periods: [], fail: true };
  // a bare year (with an optional direction: since 2024, before 2015)
  while ((m = rx(`${DIR}${PREP}(${YEAR})`).exec(r.s))) add(m, { ...yearP(Number(m[2])), dir: m[1] ? m[1].toLowerCase().replace(/\s+/g, ' ') : null });
  // a month with no year, a bare quarter, a week or a day: not read here
  while ((m = rx(`q([1-4])`).exec(r.s))) add(m, { kind: 'quarter', y: null, q: Number(m[1]), label: `Q${m[1]}` });
  if (rx(`(?:${MONA})`).test(r.s) && !/\bmay\b/.test(r.s)) return { periods: [], fail: true };
  found.sort((a, b) => a.idx - b.idx);
  // "last year compared to the year before": the year before the one named just ahead of it
  for (let i = 0; i < found.length; i++) {
    if (found[i].kind !== 'yearBefore') continue;
    const prev = found[i - 1];
    if (!prev || prev.kind !== 'year' || prev.dir) return { periods: [], fail: true };
    Object.assign(found[i], yearP(prev.y - 1));
  }
  // a quarter without a year borrows the year next to it ("Q1 and Q2 2025", "Q3 billings vs Q2 this year")
  for (let i = 0; i < found.length; i++) {
    const p = found[i];
    if (p.kind !== 'quarter' || p.y != null) continue;
    const yp = found.find((x) => x !== p && x.kind === 'quarter' && x.y != null) ?? found.find((x) => x !== p && x.kind === 'year' && x.rel);
    if (!yp) continue;
    const y = yp.y;
    Object.assign(p, quarterP(y, p.q));
    if (yp.kind === 'year') found.splice(found.indexOf(yp), 1);
  }
  if (found.some((p) => p.kind === 'quarter' && p.y == null)) return { periods: [], fail: true };
  return { periods: found, fail: false };
}

/* ====================================================================== lexing */

const SERIAL_RE = /^(?:[a-z]{1,2}|\d[a-z])\d{6}$/;
const DOCNO_RE = /^[a-z]{1,5}-\d{3,}$/;

function docRegex(vocab) {
  if (!vocab.timeDocRe) {
    const phr = [...vocab.docPhrases.keys()].filter((p) => p.length >= 2).sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    vocab.timeDocRe = new RegExp(`(?<![a-z0-9@$.-])(?:${phr.join('|')})(?![a-z0-9-])`, 'i');
  }
  return vocab.timeDocRe;
}

/** The sentence -> {r, names, docs, brands, cities, serials, docNos, periods}; null when something in it cannot be read safely. */
function lex(text0, vocab, today) {
  const toks = String(text0).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const q = { names: [], docs: [], brands: [], cities: [], serials: [], docNos: [], periods: [], vocab };
  // names, longest first
  const used = new Array(toks.length).fill(false);
  const repl = toks.slice();
  for (let n = Math.min(vocab.maxNameWords, 6); n >= 1; n--) {
    for (let a = 0; a + n <= toks.length; a++) {
      if (used.slice(a, a + n).some(Boolean)) continue;
      const key = normName(toks.slice(a, a + n).join(' '));
      const hit = vocab.names.get(key);
      if (!hit) continue;
      if (n === 1 && key.length < 5) continue;
      const roles = [hit.customer && 'customer', hit.tech && 'tech', hit.vendor && 'vendor'].filter(Boolean);
      if (roles.length !== 1) return null;
      q.names.push({ role: roles[0], value: hit.display });
      repl[a] = `@n${q.names.length - 1}`;
      for (let k = a; k < a + n; k++) { used[k] = true; if (k > a) repl[k] = ''; }
    }
  }
  for (let i = 0; i < repl.length; i++) {
    const w = repl[i];
    if (!w || w.startsWith('@')) continue;
    if (SERIAL_RE.test(w)) { q.serials.push(w); repl[i] = `@s${q.serials.length - 1}`; } else if (DOCNO_RE.test(w)) { q.docNos.push(w); repl[i] = `@r${q.docNos.length - 1}`; }
  }
  const r = new Rest(` ${repl.filter(Boolean).join(' ')} `);
  // document types
  const dre = docRegex(vocab);
  for (let m; (m = r.take(dre));) {
    const id = vocab.docPhrases.get(m[0].trim().replace(/\s+/g, ' ').toLowerCase());
    if (!id) return null;
    q.docs.push({ id, word: m[0].trim().replace(/\s+/g, ' ').toLowerCase() });
    // keep a marker so word order survives
    r.s = `${r.s.slice(0, m.index)} @d${q.docs.length - 1} ${r.s.slice(m.index + m[0].length)}`;
  }
  // brands and cities
  const alt = (keys) => keys.sort((a, b) => b.length - a.length).map((k) => `${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}s?`).join('|');
  const bk = [...vocab.brands.keys()];
  if (bk.length) for (let m; (m = rx(alt(bk)).exec(r.s));) { const v = vocab.brands.get(m[0].trim().toLowerCase()) ?? vocab.brands.get(m[0].trim().toLowerCase().replace(/s$/, '')); if (!v) break; q.brands.push(v); r.s = `${r.s.slice(0, m.index)} @b${q.brands.length - 1} ${r.s.slice(m.index + m[0].length)}`; }
  const ck = [...vocab.cities.keys()];
  if (ck.length) for (let m; (m = rx(ck.sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')).exec(r.s));) { const v = vocab.cities.get(m[0].trim().toLowerCase().replace(/\s+/g, ' ')); if (!v) break; q.cities.push(v); r.s = `${r.s.slice(0, m.index)} @c${q.cities.length - 1} ${r.s.slice(m.index + m[0].length)}`; }
  // a kind of service ("repair", "PM", "preventive maintenance"): the service type on a ticket
  q.serviceTypes = [];
  {
    const map = vocab.cat?.serviceType;
    if (map && map.size) {
      r.s = r.s.replace(/(?<![a-z0-9$.\/-])(?:pms?|preventative maintenance)(?![a-z0-9-])/g, ' preventive maintenance ');
      const keys = [...map.keys()].filter((k) => k.length >= 3).sort((a, b) => b.length - a.length).map((k) => `${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}s?`);
      if (keys.length) for (let m; (m = rx(keys.join('|')).exec(r.s));) { const k = m[0].trim().replace(/\s+/g, ' ').toLowerCase(); const v = map.get(k) ?? map.get(k.replace(/s$/, '')); if (!v) break; q.serviceTypes.push(v); r.s = `${r.s.slice(0, m.index)} @t${q.serviceTypes.length - 1} ${r.s.slice(m.index + m[0].length)}`; }
    }
  }
  q.text0 = r.s;
  // periods
  const pp = takePeriods(r, today);
  if (pp.fail) return null;
  q.periods = pp.periods;
  q.r = r;
  q.howMuch = /\bhow\s+much\b/.test(r.s);
  return q;
}

/* ====================================================================== measures */

/** The owner's own word for a kind of paper, as a plural and a singular ("quotes", "quote"; "pos" -> "purchase orders"). */
function nounsOf(d) {
  const label = (documentTypeLabel(d.id) ?? d.id).toLowerCase();
  const w = d.word;
  const plainWord = /^[a-z][a-z ]{3,}$/.test(w) && !/^(?:pos?|wo|pm)$/.test(w);
  const base = plainWord ? w.replace(/s$/, '') : label.replace(/\s*\/.*$/, '');
  const one = /ss$/.test(w) ? w : base;
  const plural = /(?:s|x|ch|sh)$/.test(base) && !/ss$/.test(base) ? base : `${base}s`;
  return { noun: plural, one };
}

/**
 * What is counted or added up. {entity, docType, visit, dateField, agg:'count'|'sum'|'avg', valueField, noun, label}
 * Consumes its words from `r`; null when nothing (or more than one thing) names it.
 */
function takeMeasure(r, q) {
  const cands = [];
  const probe = (name, re, build) => { const c = r.clone(); const m = c.take(re); if (m) cands.push({ name, re, build, m }); };
  probe('visit', rx(`service\\s+calls?|site\\s+visits?|service\\s+visits?|visits?|calls?|callouts?|crews?|${VISIT_ALT}`), () => ({ entity: 'document', docType: null, visit: true, dateField: 'serviceDate', noun: 'service visits', one: 'service visit' }));
  probe('money', rx('revenue|billings?|billed|invoiced|sales|income|bill'), () => ({ entity: 'document', docType: 'invoice', visit: false, dateField: 'date', valueField: 'total', agg: 'sum', noun: 'invoiced', money: true }));
  probe('hours', rx('labor\\s+hours?|hours?|hrs?'), () => ({ entity: 'document', docType: null, visit: true, dateField: 'serviceDate', valueField: 'hours', agg: 'sum', noun: 'labor hours', hours: true }));
  probe('install', rx('installs?|installed|installation|installations'), () => ({ entity: 'unit', dateField: 'installDate', noun: 'installations', one: 'installation' }));
  probe('doc', rx('documents?|docs?|paperwork|papers?'), () => ({ entity: 'document', docType: null, visit: false, dateField: 'date', noun: 'documents', one: 'document' }));
  const dts = q.docs.map((d, i) => ({ d, i })).filter((x) => r.s.includes(`@d${x.i}`));
  for (const x of dts) cands.push({ name: 'type', build: () => ({ entity: 'document', docType: x.d.id, visit: false, dateField: 'date', ...nounsOf(x.d), word: x.d.word }), idx: x.i });
  if (!cands.length) return null;
  const names = new Set(cands.map((c) => c.name));
  // "invoice revenue", "invoice totals": the money words and the invoice type say the same thing
  let pick = null;
  if (names.has('money') && names.has('type') && cands.filter((c) => c.name === 'type').length === 1 && q.docs.some((d) => d.id === 'invoice')) pick = cands.find((c) => c.name === 'money');
  else if (names.has('hours') && names.has('visit')) pick = cands.find((c) => c.name === 'hours');
  else if (cands.length === 1) pick = cands[0];
  else if (cands.length === 2 && names.has('visit') && names.has('type') && q.docs[0] && ['service-ticket'].includes(q.docs[0].id)) pick = cands.find((c) => c.name === 'type');
  if (!pick) return null;
  // "which year did we invoice the most": invoice used as a verb, which is dollars or a count: only "how much" settles it
  if (pick.name === 'type' && q.docs[pick.idx].id === 'invoice' && !/s$/.test(q.docs[pick.idx].word) && new RegExp(`\\b(?:we|did|do|to)\\s+@d${pick.idx}\\b`).test(q.r.s)) {
    if (!q.howMuch) return false;
    r.s = r.s.replace(`@d${pick.idx}`, ' ');
    return { agg: 'sum', docType: 'invoice', entity: 'document', visit: false, dateField: 'date', valueField: 'total', noun: 'invoiced', money: true };
  }
  let meas = { agg: 'count', ...pick.build() };
  if (pick.name === 'type' && meas.docType === 'invoice' && r.has(rx('totals?|amounts?|dollars?'))) { r.takeAll(rx('totals?|amounts?|dollars?')); meas = { agg: 'sum', docType: 'invoice', entity: 'document', visit: false, dateField: 'date', valueField: 'total', noun: 'invoiced', money: true }; }
  // take the words
  if (pick.name === 'type') {
    const i = pick.idx; r.s = r.s.replace(`@d${i}`, ' ');
    // the other consumed words of a "type + revenue" pair
    if (names.has('money')) r.take(rx('revenue|billings?|billed|invoiced|sales|income|bill'));
    if (names.has('visit')) { /* "service tickets" words stay with the type */ }
  } else {
    r.take(pick.re);
    if (pick.name === 'money') { for (const x of dts) if (q.docs[x.i].id === 'invoice') r.s = r.s.replace(`@d${x.i}`, ' '); }
    if (pick.name === 'hours') r.take(rx(`visits?|calls?|jobs?|${VISIT_ALT}`));
  }
  return meas;
}

/** Filters named in the sentence (customer, technician, brand, city) that apply to the measure's rows. */
/** Kinds of paper that carry a technician's name. */
const TECH_TYPES = new Set(['invoice', 'service-ticket', 'work-order', 'startup-sheet', 'dispatch-note', 'inspection-report']);

function filtersOf(q, meas) {
  const out = [];
  for (const n of q.names) {
    if (n.role === 'vendor') return null;
    if (n.role === 'tech' && (meas.entity === 'unit' || (!meas.visit && !TECH_TYPES.has(meas.docType)))) return null;
    out.push({ field: n.role === 'tech' ? 'tech' : 'customer', op: 'eq', value: n.value });
  }
  for (const b of q.brands) out.push({ field: 'brand', op: 'eq', value: b });
  for (const c of q.cities) out.push({ field: 'city', op: 'eq', value: c });
  for (const t of q.serviceTypes ?? []) { if (meas.entity !== 'document') return null; out.push({ field: 'serviceType', op: 'eq', value: t }); }
  if (out.filter((f) => f.field === 'brand').length > 1 || out.filter((f) => f.field === 'city').length > 1) return null;
  return out;
}

/* ====================================================================== grammar */

/** Did the person TYPE a word like one of these (typos allowed)? Guards against a word the jargon layer rewrote into ours ("leases" -> "maintenance agreements"). */
function rawLike(raw, targets) {
  const words = String(raw ?? '').toLowerCase().replace(/[’']/g, '').match(/[a-z]+/g) ?? [];
  return words.some((w) => w.length >= 5 && targets.some((t) => editDistance(w, t, 2) <= 2));
}

/** A clean-up pass: every word left must be filler. */
function clean(r) {
  for (const w of r.words()) if (!isFiller(w) && !/^@[nbct]\d+$/.test(w)) return false;
  return true;
}

function parseOps(q, feat) {
  const claims = [];
  for (const fn of [parseSeries, parseCompare, parseRate, parseWindow, parseSince, parseInactive, parseExpiry, parseBetween, parseAge]) {
    if ((q.serviceTypes ?? []).length && ![parseSeries, parseCompare, parseRate, parseWindow].includes(fn)) continue;
    let p = null;
    try { p = fn(q, feat); } catch (e) { if (process.env.DQL_DEBUG) console.error('time parse error', fn.name, e); p = null; }
    if (p) claims.push(p);
  }
  return claims.length === 1 ? claims[0] : null;
}

/* ---------------------------------------------------------------- series, peaks, seasons */

const SEASONS = { summer: { label: 'summer (June to August)', months: [6, 7, 8] }, winter: { label: 'winter (December to February)', months: [12, 1, 2] }, spring: { label: 'spring (March to May)', months: [3, 4, 5] }, fall: { label: 'fall (September to November)', months: [9, 10, 11] } };

function parseSeries(q, feat) {
  const r = q.r.clone();
  const seasonHits = r.takeAll(rx('summer|winter|spring|fall|autumn'));
  const seasonsAsked = [...new Set(seasonHits.map((m) => (/autumn/i.test(m[0]) ? 'fall' : m[0].trim().toLowerCase())))];
  if (seasonsAsked.length && seasonsAsked.length !== 2) return null;
  const weekday = r.take(rx('(?:day|days)\\s+of\\s+(?:the\\s+)?week|weekdays?|week\\s*days?'));
  const moy = r.take(rx('(?:month|months)\\s+of\\s+(?:the\\s+)?year|time\\s+of\\s+(?:the\\s+)?year'));
  const allYears = r.take(rx('over\\s+all\\s+years|across\\s+(?:all\\s+)?years|all\\s+years|of\\s+all\\s+time|all\\s+time|ever|on\\s+record'));
  const busiestOld = r.take(rx('busiest|peak'));
  const busiestNew = busiestOld ? null : r.take(rx('heaviest|most\\s+active|largest|biggest|highest|strongest'));
  const busiest = busiestOld ?? busiestNew;
  // the new top words need the measure said ("by number of ...", "total ... amount"): "which month was highest" and "biggest invoice month" stay released
  if (busiestNew && !/\b(?:number|count|how\s+many|total|totals|amount|amounts|dollars|revenue|billed|invoiced|sales|income|hours)\b/.test(q.r.s)) return null; // round 11: the top direction only ("largest month by total invoice dollars"); the low direction stays with the older lanes
  const mostW = r.take(rx('the\\s+most|most'));
  if (busiest || mostW) r.take(rx('active'));
  const seasonal = r.take(rx('seasonal(?:ity)?|seasons?|busy\\s+season|pattern'));
  const trendAll = r.takeAll(rx('trends?|trending|going\\s+up\\s+or\\s+down|up\\s+or\\s+down|growing\\s+or\\s+shrinking|month\\s+by\\s+month|year\\s+by\\s+year|over\\s+the\\s+years'));
  const trendW = trendAll[0] ?? null;
  const cmpW = r.take(rx('vs|versus|compared\\s+(?:to|with)|compare|than'));
  const slowW = r.take(rx('slowest|quietest|fewest|least|lowest|worst|biggest|best|highest|largest'));
  r.takeAll(rx('how\\s+many|number\\s+of|how\\s+much|which|what|do|does|did|we|are|is|there|has|have|with|for|our|us|a|an|in|of|the|by|per|each|every|single|was|were|ever|happen|happens|happened|occur|occurs|on'));
  const grainNoun = r.takeAll(rx('years?|months?|quarters?|mo|mnth'));
  if (slowW || cmpW && !seasonsAsked.length) return null;
  if ((weekday || moy) && grainNoun.length) return null; // two groupings ("by month and by day of the week"): not a single series
  // "up or down from last year" is a comparison with last year, not a series
  if (trendW && /up\s+or\s+down/.test(trendW[0]) && !q.periods.some((p) => p.kind === 'roll' && p.unit === 'year')) return null;
  const hasPeriodWord = r.has(rx('week|weeks'));
  if (hasPeriodWord) return null;
  const gtxt = grainNoun.map((m) => m[0].trim().toLowerCase()).join(' ');
  let grain = null;
  if (weekday) grain = 'weekday';
  else if (moy) grain = 'moy';
  else if (/quarter/.test(gtxt)) grain = 'quarter';
  else if (/month|^mo$|mnth/.test(gtxt)) grain = 'month';
  else if (/year/.test(gtxt)) grain = 'year';
  if (/month\s+by\s+month/.test(q.r.s)) grain = 'month';
  if (/year\s+by\s+year|over\s+the\s+years/.test(q.r.s)) grain = grain ?? 'year';
  if (grain === 'month' && /\b(?:what|which)\s+month\s+(?:do|does)\s+(?:we|our)\b/.test(q.r.s) && !q.periods.length) grain = 'moy';
  // the measure
  const measure = takeMeasure(r, q);
  if (measure === false) return null;
  if (seasonsAsked.length === 2) {
    if (!measure || grain || busiest || trendW || q.periods.length) return null;
    if (!clean(r) && !r.words().every((w) => isFiller(w) || w === 'more')) return null;
    const filters = filtersOf(q, measure); if (!filters) return null;
    if (q.docs.length > (measure.docType ? 1 : 0) + (measure.money && q.docs.some((d) => d.id === 'invoice') ? 1 : 0)) return null;
    return { op: 'tm_series', mode: 'seasons', measure, filters, seasons: seasonsAsked, range: null };
  }
  if (seasonsAsked.length) return null;
  let mode = null;
  if (busiest || mostW) mode = 'peak';
  else if (trendW || seasonal || ((weekday || moy) && !mostW)) mode = 'list';
  if (!mode) return null;
  // "most visits per month" is a rate or a breakdown, not a peak
  if (mode === 'peak' && !busiest && /\b(?:per|by|each|every)\s+(?:year|month|quarter)\b/.test(q.r.s)) return null;
  if (seasonal && !grain) grain = 'moy';
  if (seasonal && grain === 'month') grain = 'moy';
  let meas = measure;
  if (!meas && busiest) meas = { agg: 'count', entity: 'document', docType: null, visit: true, dateField: 'serviceDate', noun: 'service visits', one: 'service visit', assumed: true };
  if (!meas) return null;
  if (mode === 'peak' && !busiest && !meas.money && meas.assumed) return null;
  if (!grain && trendW) grain = 'year';
  if (!grain) return null;
  if (mode === 'peak' && trendW) return null;
  if (q.docs.length > (meas.docType ? 1 : 0) + (meas.money && q.docs.some((d) => d.id === 'invoice') ? 1 : 0)) return null;
  const filters = filtersOf(q, meas); if (!filters) return null;
  if (!clean(r)) return null;
  let range = null; let lastN = null;
  for (const p of q.periods) {
    if (p.kind === 'roll' && p.unit === 'year' && !p.over && grain === 'year' && mode === 'list') { lastN = p.n; continue; }
    if (['year', 'quarter', 'month', 'ytd', 'range'].includes(p.kind) && !range) { range = p; continue; }
    return null;
  }
  if (range && lastN) return null;
  if (allYears && range) return null;
  if (range && range.dir && !['before', 'since', 'after'].includes(range.dir)) return null;
  if (mode === 'peak' && (grain === 'moy' || grain === 'weekday') && range) return null;
  const rangeOut = range ? { from: range.dir === 'before' ? null : range.dir === 'after' ? addDays(range.to, 1) : range.from, to: range.dir === 'before' ? addDays(range.from, -1) : range.dir === 'since' || range.dir === 'after' ? null : range.to, label: range.dir ? `${range.dir} ${range.label}` : range.label, kind: range.kind } : null;
  return { op: 'tm_series', mode, grain, measure: meas, filters, range: rangeOut, lastN, allYears: Boolean(allYears) };
}

/* ---------------------------------------------------------------- compare and change */

function parseCompare(q, feat) {
  const r = q.r.clone();
  const pctW = r.takeAll(rx('percent|percentage|growth|grow|grew|increase|decrease|change|changed|up\\s+or\\s+down|up|down'))[0] ?? null;
  const cmpW = r.take(rx('compare|compared|comparison|versus|vs|than|against'));
  const fromW = r.take(rx('from'));
  r.takeAll(rx('and|to|with|more|less|much|did|do'));
  r.take(rx('how\\s+many|how\\s+much|number\\s+of'));
  const sameTime = r.take(rx('same\\s+(?:time|period|point|date)(?:\\s+(?:in|of))?|whole\\s+of|all\\s+of'));
  const yoy = r.take(rx('year\\s+over\\s+year|yoy|quarter\\s+over\\s+quarter|qoq|month\\s+over\\s+month|mom'));
  const soFar = r.take(rx('so\\s+far'));
  const measure = takeMeasure(r, q);
  if (!measure) return null;
  let ps = q.periods.slice();
  let baseHint = null;
  // "grow last year": one period and the one before it
  if (ps.length === 1 && ps[0].kind === 'year' && ps[0].rel === 'lastYear' && pctW && !cmpW && !/\bfrom\s+last\s+year\b/.test(q.text0)) {
    const y = ps[0].y; ps = [{ kind: 'year', y: y - 1, from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1) }, ps[0]];
  }
  // "is revenue up or down from last year": this year against last year, measured from last year
  if (ps.length === 1 && ps[0].kind === 'year' && ps[0].rel === 'lastYear' && /\bfrom\s+last\s+year\b/.test(q.text0) && pctW && /\b(?:up|down)\b/.test(q.text0) && !/\bthan\b/.test(q.text0)) {
    const y = ps[0].y + 1; ps = [ps[0], { kind: 'year', y, from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), rel: 'thisYear' }]; baseHint = 0;
  }
  // "this year vs last", "this year so far vs last year" with a bare second "last"
  if (ps.length === 1 && ps[0].kind === 'year' && ps[0].rel === 'thisYear' && /\b(?:vs|versus|compared)\b/.test(q.text0)) {
    const y = ps[0].y; ps = [ps[0], { kind: 'year', y: y - 1, from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1), rel: 'lastYear' }];
    r.take(rx('last'));
  }
  // "ytd vs same time last year"
  if (ps.length === 2 && ps[0].kind === 'ytd' && ps[1].kind === 'year' && ps[1].rel === 'lastYear' && sameTime) {
    const y = ps[1].y; ps[1] = { kind: 'ytd', y, from: `${y}-01-01`, to: addYears(ps[0].to, -1), label: `${y} through ${fmtDate(addYears(ps[0].to, -1))}`, matched: true };
    sameTime.length = 0;
  }
  // "this year compared with last year": the year in progress is set against the SAME stretch of last year (a part year against a whole one would always look smaller); "the whole of last year" keeps it whole
  if (ps.length === 2 && !sameTime && baseHint == null && feat?.today && !/\b(?:whole|full|entire)\b/.test(q.text0)) {
    const cur = ps.find((p) => p.kind === 'year' && p.rel === 'thisYear'); const prev = ps.find((p) => p.kind === 'year' && p.rel === 'lastYear');
    if (cur && prev && cur.y === prev.y + 1 && cur.to > feat.today && cur.from <= feat.today) {
      const e = addYears(feat.today, -1);
      ps = ps.map((p) => (p === cur ? { ...cur, kind: 'ytd', to: feat.today, label: `${cur.y} so far` } : { kind: 'ytd', y: prev.y, from: prev.from, to: e, label: `${prev.y} through ${fmtDate(e)}`, matched: true }));
    }
  }
  // a rolling window and "the N days before"
  if (ps.length === 2 && ps[0].kind === 'roll' && ps[1].kind === 'prior') {
    const a = ps[0]; const b = ps[1];
    if (a.n !== b.n || a.unit !== b.unit) return null;
    const e = addDays(a.from, -1);
    const f = a.unit === 'day' ? addDays(a.from, -a.n) : a.unit === 'week' ? addDays(a.from, -7 * a.n) : a.unit === 'month' ? addMonths(a.from, -a.n) : addYears(a.from, -a.n);
    ps = [a, { kind: 'range', from: f, to: e, label: `the ${a.n} ${a.unit}${a.n === 1 ? '' : 's'} before`, short: 'prior' }];
  }
  if (ps.some((p) => p.dir || p.kind === 'prior' || p.over)) return null;
  if (ps.length !== 2) return null;
  if (ps.some((p) => !['year', 'quarter', 'month', 'ytd', 'roll', 'range'].includes(p.kind))) return null;
  if (!['year', 'ytd', 'roll', 'range'].includes(ps[0].kind) && ps[0].kind !== ps[1].kind) return null;
  if (!clean(r)) return null;
  if (!cmpW && !pctW) return null;
  const filters = filtersOf(q, measure); if (!filters) return null;
  if (q.docs.length > (measure.docType ? 1 : 0) + (measure.money && q.docs.some((d) => d.id === 'invoice') ? 1 : 0)) return null;
  // which one is the base of a percentage
  const t0 = q.text0;
  const fromTo = /\bfrom\b.*\bto\b/.test(t0);
  let baseIdx = baseHint ?? 0;
  if (baseHint == null) {
    if (/\bthan\b/.test(t0)) { if (/\bfrom\b/.test(t0)) return null; baseIdx = 1; } else if (!fromTo && /\b(?:up|down)\s+from\b/.test(t0)) baseIdx = 1; else if (!/\bfrom\b/.test(t0) && ps[0].from > ps[1].from) baseIdx = 1; // chronological when nothing says otherwise
  }
  const wantsPct = Boolean(pctW) && !/\bup\s+or\s+down\b/.test(q.r.s) ? true : Boolean(pctW);
  return { op: 'tm_compare', ...ynOf(feat?.raw), measure, filters, periods: ps.map(({ from, to, label, kind, matched, short }) => ({ from, to, label, kind, matched: matched ?? false, short: short ?? null })), baseIdx, wantsPct, soFar: Boolean(soFar), sameTime: Boolean(sameTime), asIs: Boolean(yoy) };
}

/* ---------------------------------------------------------------- one period */

const WINDOW_VERBS = 'cut|ran|run|handled|wrote|raised|booked|had|got|get|were|are|there|did|do|we|so\\s+far|total';
function parseWindow(q, feat) {
  const r = q.r.clone();
  r.takeAll(rx(`how\\s+many|number\\s+of|count\\s+of|count|${WINDOW_VERBS}`));
  const measure = takeMeasure(r, q);
  if (!measure) return null;
  const filters = filtersOf(q, measure); if (!filters) return null;
  if (q.docs.length > (measure.docType ? 1 : 0) + (measure.money && q.docs.some((d) => d.id === 'invoice') ? 1 : 0)) return null;
  if (q.periods.length !== 1) return null;
  const p = q.periods[0];
  if (p.dir || p.over || !['year', 'quarter', 'month', 'ytd', 'roll', 'range'].includes(p.kind)) return null;
  if (p.kind === 'range' && !/^(?:since the start|from )/.test(p.label)) return null;
  if (!clean(r)) return null;
  return { op: 'tm_window', measure, filters, period: { from: p.from, to: p.to, label: p.label, kind: p.kind }, ...(feat?.flags?.explicitList && !measure.money && !measure.hours ? { list: true } : {}) };
}

/* ---------------------------------------------------------------- rates */

function parseRate(q) {
  const r = q.r.clone();
  const avgW = r.take(rx('average|avg|mean|on\\s+average|typical'));
  const acrossC = r.take(rx('across\\s+all\\s+customers|across\\s+customers|for\\s+all\\s+customers|per\\s+customer|for\\s+each\\s+customer|for\\s+every\\s+customer|all\\s+customers'));
  const per = r.take(rx('(?:per|a|each|every)\\s+(year|month)'));
  const gap = r.take(rx('(?:gap|time|days|distance)\\s+between|between'));
  r.takeAll(rx('how\\s+many|number\\s+of|days|day|what|whats|is|the|of|many|are'));
  const measure = takeMeasure(r, q);
  if (!measure) return null;
  const filters = filtersOf(q, measure); if (!filters) return null;
  if (q.docs.length > (measure.docType ? 1 : 0) + (measure.money && q.docs.some((d) => d.id === 'invoice') ? 1 : 0)) return null;
  const ps = q.periods;
  if (ps.some((p) => p.dir || p.over || !['year', 'quarter', 'month', 'ytd'].includes(p.kind))) return null;
  if (ps.length > 1) return null;
  if (!clean(r)) return null;
  if (measure.agg !== 'count') return null;
  if (gap && !per) {
    if (!avgW || ps.length) return null;
    if (acrossC && filters.some((f) => f.field === 'customer')) return null;
    if (filters.some((f) => f.field !== 'customer')) return null;
    if (acrossC && measure.entity !== 'document') return null;
    // a gap is read one way only: between installs across the whole business, or between a customer's own visits pooled across customers
    // (a business-wide gap between papers, or one customer's papers, can be read several ways: released)
    if (acrossC ? !measure.visit : !(measure.entity === 'unit' && !filters.length)) return null;
    return { op: 'tm_rate', mode: 'gap', scope: acrossC ? 'customers' : 'all', measure, filters };
  }
  if (!per || !avgW || acrossC) return null;
  const unit = per[1].toLowerCase();
  return { op: 'tm_rate', mode: 'per', unit, measure, filters, range: ps[0] ? { from: ps[0].from, to: ps[0].to, label: ps[0].label, kind: ps[0].kind } : null };
}

/* ---------------------------------------------------------------- since the last ... */

function subjectOf(q, r) {
  // what "the last ___" is: a visit, a paper of one kind, an installation, a bill, any paper that came in
  const subj = [];
  if (r.take(rx(`service\\s+calls?|site\\s+visits?|service\\s+visits?|visits?|visited|serviced|service|worked\\s+on|work|out\\s+to|were\\s+out|calls?|${VISIT_ALT}`))) subj.push('visit');
  if (r.take(rx('billed|invoiced|bill|billing'))) subj.push('bill');
  if (r.take(rx('install(?:s|ed|ation|ations)?'))) subj.push('install');
  const docIdx = q.docs.map((d, i) => i).filter((i) => r.s.includes(`@d${i}`));
  for (const i of docIdx) { r.s = r.s.replace(`@d${i}`, ' '); subj.push(`doc:${q.docs[i].id}`); }
  const anyDoc = r.take(rx('documents?|docs?|paperwork|papers?'));
  if (anyDoc) subj.push('anydoc');
  return subj;
}

function parseSince(q) {
  const r = q.r.clone();
  const CUES = [
    '(?:how\\s+many\\s+)?(?:days?|weeks?|months?|years?)\\s+(?:has\\s+it\\s+been\\s+)?since',
    'how\\s+long\\s+(?:has\\s+it\\s+been\\s+)?since',
    'time\\s+since',
    '(?:how\\s+many\\s+)?(?:(?:days?|weeks?|months?|years?)|how\\s+long)\\s+ago\\s+(?:was|were|did)',
    'last\\s+time',
    'when\\s+(?:was|were|did)',
    '(?:what|whats)\\s+(?:is\\s+)?(?:the\\s+)?date\\s+of\\s+(?:the|our)',
    'date\\s+of\\s+(?:the|our)',
    'date\\s+(?:for|on|of)',
  ];
  const cues = [];
  for (const c of CUES) { const m = r.take(rx(c)); if (m) cues.push(m[0].replace(/\s+/g, ' ').trim()); }
  if (!cues.length) return null;
  // round 11: "how long since X had an invoice - in days", "when was X's last letter, in days ago", "it's been how many days since X's latest ...": the unit is asked for at the end
  const inDays = r.take(rx('(?:it\\s+s\\s+been\\s+)?in\\s+days?(?:\\s+ago)?|days?\\s+ago')) ? 'days' : null;
  r.takeAll(rx('latest|most\\s+recent'));
  const cueText = cues.join(' | ');
  const mode = inDays ? 'days' : /last time|when|date/.test(cueText) ? 'date' : 'days';
  const unitAsked = (/\b(weeks?|months?|years?)\b/.exec(cues.find((c) => /since|ago/.test(c)) ?? '') ?? [null, 'day'])[1].replace(/s$/, '');
  const lastW = r.takeAll(rx('last'));
  const lastCount = lastW.length + cues.filter((c) => /\blast\b/.test(c)).length;
  // "how long since we serviced X" means since the last time we did
  const sinceVerb = /\b(?:since|ago)\b/.test(cueText) && /\b(?:serviced|visited|invoiced|billed|installed|quoted|had|got|received)\b/.test(q.r.s);
  if (lastCount > 1 || (lastCount === 0 && !sinceVerb)) return null;
  if (r.has(rx('previous|prior|second|before\\s+last|first|next|ever'))) return null;
  const cameIn = r.take(rx('came\\s+in|uploaded|added|scanned|received|entered'));
  r.takeAll(rx('sent|had|got|we|did|do|ran'));
  const subj = subjectOf(q, r);
  if (subj.length !== 1 && !(subj.length === 2 && subj.includes('visit') && subj.includes('doc:service-ticket'))) return null;
  const s0 = subj[0];
  if (q.serials.length === 1) r.s = r.s.replace('@s0', ' ');
  if (!clean(r)) return null;
  if (q.periods.length) return null;
  const filters = [];
  for (const n of q.names) { if (n.role === 'vendor') return null; filters.push({ field: n.role === 'tech' ? 'tech' : 'customer', op: 'eq', value: n.value }); }
  if (filters.some((f) => f.field === 'tech') && !(s0 === 'visit' || s0 === 'bill' || (s0.startsWith('doc:') && TECH_TYPES.has(s0.slice(4))))) return null;
  for (const b of q.brands) filters.push({ field: 'brand', op: 'eq', value: b });
  for (const c of q.cities) filters.push({ field: 'city', op: 'eq', value: c });
  let measure;
  if (s0 === 'visit') measure = { entity: 'document', docType: null, visit: true, dateField: 'serviceDate', noun: 'service visit' };
  else if (s0 === 'bill') measure = { entity: 'document', docType: 'invoice', visit: false, dateField: 'date', noun: 'invoice' };
  else if (s0 === 'install') measure = { entity: 'unit', dateField: 'installDate', noun: 'installation' };
  else if (s0 === 'anydoc') measure = { entity: 'document', docType: null, visit: false, dateField: cameIn ? 'createdAt' : 'date', noun: 'document' };
  else { const id = s0.slice(4); const dd = q.docs.find((d) => d.id === id); measure = { entity: 'document', docType: id, visit: false, dateField: cameIn ? 'createdAt' : 'date', noun: nounsOf(dd).one }; }
  if (cameIn && !['anydoc'].includes(s0) && !s0.startsWith('doc:')) return null;
  if (q.serials.length) {
    if (mode !== 'date' || s0 !== 'visit' || q.serials.length !== 1 || filters.length) return null;
    return { op: 'tm_since', mode, unitAsked, measure, filters: [], serial: q.serials[0] };
  }
  if (measure.entity === 'unit' && filters.some((f) => f.field === 'customer' || f.field === 'tech')) return null;
  if (measure.entity === 'document' && (q.brands.length || q.cities.length) && s0 !== 'visit') return null;
  if (q.docNos.length) return null;
  return { op: 'tm_since', mode, unitAsked, measure, filters };
}

/* ---------------------------------------------------------------- customers with no activity */

function parseInactive(q, feat) {
  const r = q.r.clone();
  const cust = r.take(rx('customers?|clients?|accounts?'));
  const who = r.take(rx('who|whom'));
  if (!cust && !who) return null;
  if (q.names.length) return null;
  const neg = r.take(rx('havent|hasnt|have\\s+not|has\\s+not|didnt|did\\s+not|not|no|without'));
  if (!neg) return null;
  const how = r.take(rx('how\\s+many|number\\s+of|count'));
  r.take(rx('count'));
  r.takeAll(rx('been|had|have|has|a|any|new'));
  let activity = null;
  if (r.take(rx(`serviced|visited|visit|service\\s+call|service\\s+calls|service\\s+visit|out\\s+to|call|seen|${VISIT_ALT}`))) activity = 'visit';
  else if (r.take(rx('invoiced|billed|invoice'))) activity = 'invoice';
  else if (r.take(rx('installed|install|installation'))) { activity = 'install'; r.takeAll(rx('unit|units|system|systems|equipment')); }
  if (!activity) {
    const docIdx = q.docs.map((d, i) => i).filter((i) => r.s.includes(`@d${i}`));
    if (docIdx.length === 1 && q.docs[docIdx[0]].id === 'invoice') { r.s = r.s.replace(`@d${docIdx[0]}`, ' '); activity = 'invoice'; }
  }
  if (!activity) return null;
  r.takeAll(rx('in|for|during|over|within|at\\s+all'));
  r.take(rx('this\\s+year'));
  const ps = q.periods;
  if (ps.length !== 1) return null;
  const p = ps[0];
  let cutoff = null; let label = null;
  if (p.kind === 'roll' || p.kind === 'rollx') { cutoff = p.from; label = `in ${p.over ? 'over' : 'the last'} ${p.n} ${p.unit}${p.n === 1 ? '' : 's'}`; }
  else if (p.kind === 'year' && p.dir === 'since') { cutoff = p.from; label = `since ${p.label}`; }
  else if (p.kind === 'month' && p.dir === 'since') { cutoff = p.from; label = `since ${p.label}`; }
  else if (p.kind === 'year' && p.rel === 'thisYear') { cutoff = p.from; label = 'this year'; }
  else return null;
  if (!clean(r)) return null;
  const mode = how ? 'count' : 'list';
  return { op: 'tm_inactive', activity, cutoff, label, mode };
}

/* ---------------------------------------------------------------- warranties and agreements that end */

function expiryNouns(q, subj, docType = 'maintenance-agreement') {
  if (subj === 'warranty') return { noun: 'warranties', nounOne: 'warranty' };
  const d = q.docs.find((x) => x.id === docType);
  const w = d?.word ?? 'maintenance agreements';
  const pl = /s$/.test(w) ? w : /^(\w+) of (.+)$/.test(w) ? w.replace(/^(\w+) of /, '$1s of ') : `${w}s`;
  return { noun: pl, nounOne: /^(\w+)s of /.test(pl) ? pl.replace(/^(\w+)s of /, '$1 of ') : pl.replace(/s$/, ''), docType };
}

function parseExpiry(q, feat) {
  const r = q.r.clone();
  const termM = r.take(rx('(\\d+)\\s*-?\\s*(?:years?|yrs?)(?=\\s+(?:parts\\s+)?warrant)'));
  const termYears = termM ? Number(/\d+/.exec(termM[0])[0]) : null;
  const warr = r.take(rx('warrant(?:y|ies)|warrenty|warrenties'));
  const agrDocIdx = q.docs.map((d, i) => i).filter((i) => r.s.includes(`@d${i}`) && EXPIRING_TYPES.has(q.docs[i].id));
  const expType = agrDocIdx.length === 1 ? q.docs[agrDocIdx[0]].id : 'maintenance-agreement';
  let subj = null;
  if (warr && !agrDocIdx.length) subj = 'warranty';
  else if (agrDocIdx.length === 1 && !warr) { subj = 'agreement'; r.s = r.s.replace(`@d${agrDocIdx[0]}`, ' '); }
  if (!subj) return null;
  // an organization that keeps no maintenance agreements is not asked when they end
  if (subj === 'agreement' && !q.vocab.docTypesInUse?.has(expType)) return null;
  if ((subj === 'warranty' || expType === 'maintenance-agreement') && !rawLike(feat.raw, subj === 'warranty' ? ['warranty', 'warranties', 'warrenty'] : ['agreement', 'agreements', 'maintenance', 'contract', 'contracts'])) return null;
  if (q.docs.length > (subj === 'agreement' ? 1 : 0)) return null;
  const nextW = r.take(rx('next\\s+(?:warranty\\s+)?to\\s+(?:expire|end)|next\\s+(?:one\\s+)?(?:to\\s+)?(?:expires?|expiring|ends?|ending)'));
  const verb = r.take(rx('expires?|expiring|expire|expiration|ends?|ending|run\\s+out|runs\\s+out|running\\s+out|lapses?|lapsing'));
  const pastVerb = r.take(rx('expired|ended|ran\\s+out|lapsed'));
  if (!verb && !pastVerb && !nextW) return null;
  const how = r.take(rx('how\\s+many|number\\s+of|count'));
  const anyW = r.take(rx('any'));
  r.takeAll(rx('units?|which|what|that|whose|do|does|did|will|are|is|any|all|show|list|there|have|has|us|we|asset|assets|every'));
  const today = feat.today;
  // how long until the warranty on ONE unit runs out
  if (termYears == null && q.serials.length === 1 && subj === 'warranty' && /\b(?:until|till|left|remaining)\b/.test(q.text0) && /\b(?:how\s+long|how\s+many\s+days|days|time)\b/.test(q.text0) && !q.names.length && !q.brands.length && !q.cities.length && !q.docNos.length && !q.periods.length) {
    r.s = r.s.replace('@s0', ' ');
    r.takeAll(rx('how\\s+long|how\\s+many|how\\s+much|days?|time|until|till|left|remaining|on|for|of|does|will|is|the|warranty|unit|serial|when|run|runs|out'));
    if (!clean(r)) return null;
    return { op: 'tm_expiry', subject: 'warranty', mode: 'unit', serial: q.serials[0] };
  }
  if (q.names.length || q.serials.length || q.brands.length || q.cities.length || q.docNos.length) return null;
  const ps = q.periods;
  if (ps.length > 1) return null;
  let from = null; let to = null; let label = null; let mode = how ? 'count' : anyW ? 'any' : 'list';
  const p = ps[0];
  if (nextW) {
    r.takeAll(rx('days?|until|till|how\\s+many|how\\s+long|when|is|will|whats'));
    if (p) return null;
    if (!clean(r)) return null;
    if (termYears != null) return null;
    return { op: 'tm_expiry', subject: subj, mode: 'next', ...expiryNouns(q, subj, expType) };
  }
  if (!p) {
    // "certificates that expire after today": everything still in force after today (an open end)
    if (verb && !pastVerb && /\b(?:after|since|from)\s+(?:today|now)\b|\bgoing\s+forward\b/i.test(feat.raw) && (r.takeAll(rx('after|since|from|today|now|on|onwards?|going\\s+forward|here')), true)) {
      if (!clean(r)) return null;
      return { op: 'tm_expiry', subject: subj, mode, from: addDays(today, 1), to: null, label: 'after today', past: false, term: termYears, ...expiryNouns(q, subj, expType) };
    }
    // "agreements that already ended": everything whose end date is before today
    if (pastVerb && /\balready\b/.test(q.text0) && subj === 'agreement') { r.takeAll(rx('already')); if (!clean(r)) return null; return { op: 'tm_expiry', subject: subj, mode, from: null, to: addDays(today, -1), label: 'before today', past: true, ...expiryNouns(q, subj, expType) }; }
    return null;
  }
  if ((p.kind === 'month' || p.kind === 'quarter') && !p.dir) { from = p.from; to = p.to; label = `in ${p.label}`; }
  else if (p.kind === 'fwd') { from = p.from; to = p.to; label = p.label; if (pastVerb) return null; }
  else if (p.kind === 'range') { from = p.from; to = p.to; label = p.label; }
  else if (p.kind === 'year' && p.dir === 'since' && pastVerb) { from = p.from; to = today; label = `since ${p.label}`; }
  else if (p.kind === 'year' && !p.dir) { from = p.from; to = p.to; label = `in ${p.label}`; if (p.rel === 'lastYear' && !pastVerb && verb && /expir|end/.test(verb[0]) && false) return null; }
  else if (p.kind === 'year' && p.dir === 'before') { if (pastVerb) { from = null; to = addDays(p.from, -1); label = `before ${p.label}`; } else { from = today; to = addDays(p.from, -1); label = `from today up to the end of ${Number(p.label) - 1}`; if (p.from <= today) return null; } }
  else if (p.kind === 'roll' && !p.over && pastVerb) { from = p.from; to = p.to; label = p.label; }
  else if (p.kind === 'roll' && !p.over && verb && /ran out/.test(verb[0])) { from = p.from; to = p.to; label = p.label; }
  else return null;
  if (!clean(r)) return null;
  if (pastVerb && from && from > today) return null;
  if (termYears != null && subj !== 'warranty') return null;
  return { op: 'tm_expiry', subject: subj, mode, from, to, label, past: Boolean(pastVerb), term: termYears, ...expiryNouns(q, subj, expType) };
}

/* ---------------------------------------------------------------- days between two dates */

function parseBetween(q, feat) {
  const r = q.r.clone();
  const days = r.take(rx('(?:how\\s+many\\s+)?days?(?:\\s+(?:are\\s+there|apart))?'));
  const btw = r.take(rx('between'));
  const until = r.take(rx('until|till|before'));
  // days from the installation to the warranty registration
  const regDocIdx = q.docs.findIndex((d) => d.id === 'warranty-registration');
  const regW = r.take(rx('regist(?:er|ered|ering|ration|rations)')) ?? (regDocIdx >= 0 && r.s.includes(`@d${regDocIdx}`) ? [true] : null);
  const instW = r.take(rx('install(?:ed|ation|s)?'));
  if (regW && !until) {
    const avg = r.take(rx('average|on\\s+average|avg|mean'));
    r.takeAll(rx('across\\s+all\\s+units|all\\s+units|across\\s+units'));
    r.takeAll(rx('how\\s+many|how\\s+long|did|take|does|do|long|from|to|and|the|after|we|get|got|it|warranty|equipment|unit|units|on|for|between|a|of|is|what|whats'));
    const wdocIdx = q.docs.map((d, i) => i).filter((i) => r.s.includes(`@d${i}`));
    for (const i of wdocIdx) { if (q.docs[i].id !== 'warranty-registration') return null; r.s = r.s.replace(`@d${i}`, ' '); }
    if (q.periods.length || q.docNos.length || q.brands.length || q.cities.length) return null;
    if (q.names.some((n) => n.role !== 'customer') || q.names.length > 1 || q.serials.length > 1) return null;
    if (q.serials.length) { r.s = r.s.replace('@s0', ' '); }
    if (q.serials.length && q.names.length) return null;
    const scope = q.serials.length ? 'serial' : q.names.length ? 'customer' : avg ? 'all' : null;
    if (!scope) return null;
    if (!instW && !(scope === 'serial' && /\btake\b/.test(q.r.s))) return null;
    if (!clean(r)) return null;
    return { op: 'tm_between', mode: 'register', scope, serial: q.serials[0] ?? null, filters: q.names.map((n) => ({ field: 'customer', op: 'eq', value: n.value })) };
  }
  r.takeAll(rx('how\\s+many|how\\s+long|did|take|does|do|long'));
  // R15: "the span in days of Kim Lee's invoices, first to last", "days from Kim Lee's earliest invoice to the last": the days between the first and the last dated paper of one kind for one customer
  {
    const spanW = /\b(?:span|from|between)\b/i.test(q.text0) && /\b(?:first|earliest|oldest)\b/i.test(q.text0) && /\b(?:last|latest|newest|final)\b/i.test(q.text0);
    const dIdx = q.docs.map((d, i) => i).filter((i) => r.s.includes(`@d${i}`));
    if (process.env.SPAN_DEBUG) process.stderr.write('SPAN ' + JSON.stringify({ days: !!days, spanW, dIdx, docs: q.docs.map((d) => d.id), names: q.names, nos: q.docNos, rs: r.s, t0: q.text0 }) + '\n');
    if (days && spanW && !q.docNos.length && !q.periods.length && !q.serials.length && !q.brands.length && !q.cities.length && dIdx.length === 1 && q.docs.length === 1 && q.names.length === 1 && q.names[0].role === 'customer') {
      const rr = r.clone();
      rr.s = rr.s.replace(`@d${dIdx[0]}`, ' ');
      rr.takeAll(rx('span|in|of|the|first|last|earliest|latest|oldest|newest|final|to|from|and|s|apart|for|his|her|their'));
      rr.s = rr.s.replace(/@n\d+/g, ' ');
      if (process.env.SPAN_DEBUG) process.stderr.write('SPAN-left ' + JSON.stringify(rr.s) + '\n');
      if (!clean(rr)) return null;
      return { op: 'tm_between', mode: 'span', docType: q.docs[dIdx[0]].id, docWord: q.docs[dIdx[0]].word ?? null, filters: [{ field: 'customer', op: 'eq', value: q.names[0].value }] };
    }
  }
  // two numbered papers
  if ((btw || /\bapart\b/i.test(q.text0)) && q.docNos.length === 2) {
    r.s = r.s.replace('@r0', ' ').replace('@r1', ' ');
    for (let i = 0; i < q.docs.length; i++) r.s = r.s.replace(`@d${i}`, ' ');
    r.takeAll(rx('file|files|record|records|paper|papers|document|documents|are|is|there'));
    r.take(rx('and'));
    if (!days || !clean(r) || q.names.length || q.periods.length) return null;
    return { op: 'tm_between', mode: 'docs', numbers: q.docNos.slice() };
  }
  // days until an agreement runs out
  const agrIdx = q.docs.map((d, i) => i).filter((i) => q.docs[i].id === 'maintenance-agreement' && r.s.includes(`@d${i}`));
  if (until && agrIdx.length === 1 && days && !btw) {
    if (!q.vocab.docTypesInUse?.has('maintenance-agreement')) return null;
    if (!rawLike(feat.raw, ['agreement', 'agreements', 'maintenance'])) return null;
    r.s = r.s.replace(`@d${agrIdx[0]}`, ' ');
    r.takeAll(rx('run|runs|out|expire|expires|end|ends|ending|expiring|for|the|all'));
    if (q.names.filter((n) => n.role === 'customer').length > 1 || q.names.some((n) => n.role !== 'customer')) return null;
    if (q.docs.length > 1 || q.periods.length || q.serials.length) return null;
    if (!clean(r)) return null;
    return { op: 'tm_between', mode: 'agreement', filters: q.names.map((n) => ({ field: 'customer', op: 'eq', value: n.value })) };
  }
  return null;
}

/* ---------------------------------------------------------------- age of a unit */

function parseAge(q) {
  const r = q.r.clone();
  const old = r.take(rx('how\\s+old|age|ages'));
  if (!old) return null;
  r.takeAll(rx('what|whats|is|of|the|are|average|avg|mean|typical|our|installed\\s+base|unit|units|equipment|ac|system|systems|with|at|place|how|many'));
  const avg = /average|avg|mean|typical/.test(q.r.s);
  const hasBase = /installed\s+base/.test(q.r.s);
  if (q.periods.length || q.docs.length || q.docNos.length || q.brands.length > 1 || q.cities.length) return null;
  const filters = [];
  if (q.serials.length > 1) return null;
  if (q.names.length > 1) return null;
  for (const n of q.names) { if (n.role !== 'customer') return null; filters.push({ field: 'customer', op: 'eq', value: n.value }); }
  for (const b of q.brands) filters.push({ field: 'brand', op: 'eq', value: b });
  const left = r.words().filter((w) => !isFiller(w) && !/^@(?:n|s|b)\d$/.test(w));
  if (left.length) return null;
  if (avg) { if (!hasBase || q.serials.length || q.names.length) return null; return { op: 'tm_age', mode: 'avg', filters }; }
  if (q.serials.length === 1 && !q.names.length && !q.brands.length) return { op: 'tm_age', mode: 'serial', serial: q.serials[0], filters: [] };
  if (!q.serials.length && q.names.length === 1) return { op: 'tm_age', mode: 'customer', filters };
  return null;
}

/* ====================================================================== hook + detect */

function slots(w, feat, vocab) {
  if (!feat.text0 || feat.sets) return;
  { const off = process.env.DONOVAN_DQL_TIME_OFF; if (off && off.split(',').map((x) => x.trim()).includes('all')) return; }
  let plan = null;
  try {
    const q = lex(feat.text0, vocab, feat.today);
    plan = q ? parseOps(q, feat) : null;
  } catch (e) { if (process.env.DQL_DEBUG) console.error('time slots error', e); plan = null; }
  if (process.env.DQL_DEBUG) console.error('time:', String(feat.text0).trim(), '=>', plan ? JSON.stringify(plan).slice(0, 300) : 'no parse');
  if (!plan) return;
  // operational knob: DONOVAN_DQL_TIME_OFF=tm_rate,tm_series:peak,tm_series:peak:month (or "all") turns off those kinds of question; the core family and the router are untouched
  { const kind = [plan.op, plan.mode, plan.grain ?? plan.unit].filter(Boolean).join(':'); const off = process.env.DONOVAN_DQL_TIME_OFF; if (off && off.split(',').map((x) => x.trim()).filter(Boolean).some((x) => kind === x || kind.startsWith(`${x}:`))) return; }
  // a plain count in one period is the core family's own question: this family takes it only when the core cannot read every word
  if (plan.op === 'tm_window') {
    const unexplained = w.left().filter((x) => !FILLER.has(x));
    if (!unexplained.length) return;
  }
  feat.timeq = plan;
  feat.text0 = ''; // the sets family reads this string too: a question this family reads is not read twice
  w.s = ' '.repeat(w.s.length);
}

function detect(feat) { return feat.timeq ?? null; }

/* ====================================================================== exec */

const rowsOf = (meas, filters, snap, today, h) => {
  const plan = { entity: meas.entity, docType: meas.docType ?? null, visit: Boolean(meas.visit), filters, time: null };
  return h.selectRows(plan, snap, today);
};
const dateOfRow = (row, meas) => {
  const v = meas.entity === 'unit' ? row[meas.dateField] : row[meas.dateField];
  return v ? String(v).slice(0, 10) : null;
};
const valueOfRow = (row, meas) => {
  if (!meas.valueField) return 1;
  const v = row[meas.valueField];
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
};
const fmtVal = (meas, v) => (meas.money ? fmtMoney(v) : meas.hours ? `${fmtNum(v, 1)} hours` : fmtInt(v));
const thing = (meas, n = 2) => (meas.money ? 'invoiced' : meas.hours ? 'labor hours' : (n === 1 ? meas.one ?? meas.noun : meas.noun));

function bucketKey(d, grain) {
  if (grain === 'year') return d.slice(0, 4);
  if (grain === 'month') return d.slice(0, 7);
  if (grain === 'quarter') return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  if (grain === 'moy') return d.slice(5, 7);
  if (grain === 'weekday') return String(new Date(`${d}T00:00:00Z`).getUTCDay());
  return d;
}
function bucketLabel(k, grain) {
  if (grain === 'month') return monthLabel(k);
  if (grain === 'moy') return MONTH_NAMES[Number(k) - 1];
  if (grain === 'quarter') return k.replace(/^(\d{4})-(Q\d)$/, '$2 $1');
  if (grain === 'weekday') return WEEKDAYS[Number(k)];
  return k;
}
function allBuckets(grain, first, last) {
  const out = [];
  if (grain === 'year') for (let y = Number(first); y <= Number(last); y++) out.push(String(y));
  else if (grain === 'month') { let [y, m] = first.split('-').map(Number); const [ly, lm] = last.split('-').map(Number); while (y < ly || (y === ly && m <= lm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } } } else if (grain === 'quarter') { let [y, q] = [Number(first.slice(0, 4)), Number(first.slice(-1))]; const [ly, lq] = [Number(last.slice(0, 4)), Number(last.slice(-1))]; while (y < ly || (y === ly && q <= lq)) { out.push(`${y}-Q${q}`); q++; if (q > 4) { q = 1; y++; } } }
  return out;
}

function inRange(d, range) { return (!range?.from || d >= range.from) && (!range?.to || d <= range.to); }

function execSeries(plan, x) {
  const { snap, today, h } = x;
  const sel = rowsOf(plan.measure, plan.filters, snap, today, h);
  if (sel.abstain) return { abstain: sel.abstain };
  const meas = plan.measure;
  let range = plan.range;
  const res = { rows: [], leftOut: 0, noValue: 0 };
  let lastNStart = null;
  const thisYear = Number(today.slice(0, 4));
  if (plan.lastN) lastNStart = thisYear - plan.lastN;
  const buckets = new Map(); const rowsBy = new Map();
  for (const row of sel.rows) {
    const d = dateOfRow(row, meas);
    if (!d) { res.leftOut++; continue; }
    if (range && !inRange(d, range)) continue;
    if (lastNStart != null && Number(d.slice(0, 4)) < lastNStart) continue;
    const v = valueOfRow(row, meas);
    if (v == null) { res.noValue++; continue; }
    res.rows.push(row);
    const k = bucketKey(d, plan.grain ?? 'year');
    buckets.set(k, (buckets.get(k) ?? 0) + v);
    if (!rowsBy.has(k)) rowsBy.set(k, []);
    rowsBy.get(k).push(row);
  }
  res.buckets = buckets; res.rowsBy = rowsBy;
  return res;
}

function execCompareValue(meas, filters, period, x) {
  const { snap, today, h } = x;
  const sel = rowsOf(meas, filters, snap, today, h);
  if (sel.abstain) return { abstain: sel.abstain };
  let value = 0; const rows = []; let leftOut = 0;
  for (const row of sel.rows) {
    const d = dateOfRow(row, meas);
    if (!d) { leftOut++; continue; }
    if (d < period.from || d > period.to) continue;
    const v = valueOfRow(row, meas);
    if (v == null) { leftOut++; continue; }
    value += v; rows.push(row);
  }
  return { value, rows, leftOut };
}


const exec = (plan, x) => {
  switch (plan.op) {
    case 'tm_window': return execWindow(plan, x);
    case 'tm_series': return plan.mode === 'seasons' ? execSeasons(plan, x) : execSeries(plan, x);
    case 'tm_compare': return execCompare(plan, x);
    case 'tm_rate': return execRate(plan, x);
    case 'tm_since': return execSince(plan, x);
    case 'tm_inactive': return execInactive(plan, x);
    case 'tm_expiry': return execExpiry(plan, x);
    case 'tm_between': return execBetween(plan, x);
    case 'tm_age': return execAge(plan, x);
    default: return { abstain: 'op' };
  }
};

function execSeasons(plan, x) {
  const { snap, today, h } = x;
  const sel = rowsOf(plan.measure, plan.filters, snap, today, h);
  if (sel.abstain) return { abstain: sel.abstain };
  const meas = plan.measure;
  const out = plan.seasons.map((s) => ({ season: s, value: 0, rows: [] }));
  let noDate = 0;
  for (const row of sel.rows) {
    const d = dateOfRow(row, meas);
    if (!d) { noDate++; continue; }
    const m = Number(d.slice(5, 7));
    const v = valueOfRow(row, meas);
    if (v == null) continue;
    for (const o of out) if (SEASONS[o.season].months.includes(m)) { o.value += v; o.rows.push(row); }
  }
  return { sides: out, noDate };
}

function execCompare(plan, x) {
  const sides = [];
  for (const p of plan.periods) {
    const v = execCompareValue(plan.measure, plan.filters, p, x);
    if (v.abstain) return v;
    sides.push({ ...p, ...v });
  }
  const sel0 = rowsOf(plan.measure, plan.filters, x.snap, x.today, x.h);
  if (sel0.abstain) return { abstain: sel0.abstain };
  // like-for-like value for a year-to-date question
  let matched = null;
  const ytd = sides.find((s) => s.kind === 'ytd');
  const other = sides.find((s) => s !== ytd && s.kind === 'year');
  if (ytd && other && !plan.sameTime) {
    const e = addYears(ytd.to, -1);
    matched = { ...execCompareValue(plan.measure, plan.filters, { from: `${other.from.slice(0, 4)}-01-01`, to: e }, x), to: e, year: other.from.slice(0, 4) };
  }
  return { sides, matched };
}

function execWindow(plan, x) {
  const v = execCompareValue(plan.measure, plan.filters, plan.period, x);
  if (v.abstain) return v;
  return { ...v, period: plan.period };
}

function execRate(plan, x) {
  const { snap, today, h } = x;
  const sel = rowsOf(plan.measure, plan.filters, snap, today, h);
  if (sel.abstain) return { abstain: sel.abstain };
  const meas = plan.measure;
  const dated = sel.rows.map((row) => ({ row, d: dateOfRow(row, meas) })).filter((o) => o.d);
  if (plan.mode === 'gap') {
    const gaps = [];
    if (plan.scope === 'customers') {
      const by = new Map();
      for (const o of dated) { const c = o.row.custId; if (!c) continue; if (!by.has(c)) by.set(c, []); by.get(c).push(o.d); }
      let nc = 0;
      for (const ds of by.values()) { const sorted = ds.sort(); if (sorted.length > 1) nc++; for (let i = 1; i < sorted.length; i++) gaps.push(diffDays(sorted[i - 1], sorted[i])); }
      if (!gaps.length) return { few: 0 };
      return { avg: gaps.reduce((a, b) => a + b, 0) / gaps.length, n: gaps.length, customers: nc, rows: dated.map((o) => o.row), scope: 'customers' };
    }
    const sorted = dated.map((o) => o.d).sort();
    if (sorted.length < 2) return { few: sorted.length };
    for (let i = 1; i < sorted.length; i++) gaps.push(diffDays(sorted[i - 1], sorted[i]));
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return { avg, n: sorted.length, first: sorted[0], last: sorted[sorted.length - 1], rows: dated.map((o) => o.row), scope: 'all' };
  }
  let rows = dated;
  let periods; let note = null;
  if (plan.range) {
    rows = dated.filter((o) => o.d >= plan.range.from && o.d <= plan.range.to);
    const whole = plan.range.to <= today;
    if (plan.unit === 'month') {
      periods = whole ? (plan.range.kind === 'year' ? 12 : plan.range.kind === 'quarter' ? 3 : plan.range.kind === 'month' ? 1 : null) : (diffDays(plan.range.from, today) + 1) / 30.4375;
      if (periods == null) return { abstain: 'range' };
      note = whole ? null : `${plan.range.label} is not over yet, so this runs from ${fmtDate(plan.range.from)} to ${fmtDate(today)}`;
    } else {
      if (!(plan.range.kind === 'year' && whole)) return { abstain: 'range' };
      periods = 1;
    }
  } else {
    if (!dated.length) return { abstain: 'none' };
    const first = dated.map((o) => o.d).sort()[0]; const last = dated.map((o) => o.d).sort().slice(-1)[0];
    if (plan.unit === 'year') periods = Number(last.slice(0, 4)) - Number(first.slice(0, 4)) + 1;
    else periods = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
    note = `${periods} calendar ${plan.unit}s from ${plan.unit === 'year' ? first.slice(0, 4) : monthLabel(first.slice(0, 7))} to ${plan.unit === 'year' ? last.slice(0, 4) : monthLabel(last.slice(0, 7))}, counting ${plan.unit}s with nothing in them${last.slice(0, 4) === today.slice(0, 4) && plan.unit === 'year' ? ` (${today.slice(0, 4)} is not over, and counts as a whole year)` : ''}`;
  }
  const n = rows.length;
  return { n, periods, avg: n / periods, note, rows: rows.map((o) => o.row) };
}

function execSince(plan, x) {
  const { snap, today, h } = x;
  const meas = plan.measure;
  let rows;
  if (plan.serial) {
    const unit = snap.units.find((u) => lc(u.serial) === lc(plan.serial));
    if (!unit) return { notFound: plan.serial };
    rows = snap.documents.filter((d) => d.unitId === unit.id && d.serviceDate);
    const dates = rows.map((d) => d.serviceDate).sort();
    if (!dates.length) return { none: true, unit };
    const last = dates[dates.length - 1];
    return { last, days: diffDays(last, today), tied: rows.filter((d) => d.serviceDate === last), unit, rowsAll: rows };
  }
  const sel = rowsOf(meas, plan.filters, snap, today, h);
  if (sel.abstain) return { abstain: sel.abstain };
  const dated = sel.rows.map((row) => ({ row, d: dateOfRow(row, meas) })).filter((o) => o.d);
  const past = dated.filter((o) => o.d <= today);
  if (!past.length) return { none: true, total: sel.rows.length };
  const last = past.map((o) => o.d).sort().slice(-1)[0];
  const tied = past.filter((o) => o.d === last).map((o) => o.row);
  return { last, days: diffDays(last, today), tied, future: dated.length - past.length, count: past.length, rowsAll: past.map((o) => o.row) };
}

function lastBy(snap, activity) {
  const m = new Map();
  if (activity === 'install') {
    for (const u of snap.units) { if (!u.custId || !u.installDate) continue; if (!m.has(u.custId) || u.installDate > m.get(u.custId)) m.set(u.custId, u.installDate); }
    return m;
  }
  for (const d of snap.documents) {
    if (!d.custId) continue;
    const v = activity === 'visit' ? d.serviceDate : d.type === 'invoice' ? d.invoiceDate ?? d.date : null;
    if (!v) continue;
    if (!m.has(d.custId) || v > m.get(d.custId)) m.set(d.custId, v);
  }
  return m;
}

function execInactive(plan, x) {
  const { snap } = x;
  // a customer name on file twice would be counted as two customers: that is correct here (each is its own record)
  const last = lastBy(snap, plan.activity);
  const inactive = []; let never = 0;
  for (const c of snap.customers) {
    if (!c.name) continue;
    const l = last.get(c.id);
    if (!l) { never++; continue; }
    if (l < plan.cutoff) inactive.push({ c, last: l });
  }
  inactive.sort((a, b) => (a.c.name ?? '').localeCompare(b.c.name ?? ''));
  return { inactive, never, total: snap.customers.length };
}

/** "01/01/2025 - 12/31/2026" -> {start, end} */
const isoOf2 = (v) => { const t = String(v ?? '').trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); return m ? `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}` : null; };
/** The day a paper stops being in force: the end of its term, a lease end date, the day an insurance certificate runs out. */
function endOf(d) { return agreementTerm(d)?.end ?? isoOf2(d.f?.lease_end_date) ?? isoOf2(d.f?.coi_expires) ?? isoOf2(d.f?.expiration_date) ?? isoOf2(d.f?.expires) ?? null; }
const EXPIRING_TYPES = new Set(['maintenance-agreement', 'agreement', 'lease-agreement', 'certificate-of-insurance', 'insurance-certificate']);
function agreementTerm(d) {
  const t = String(d.f?.agreement_term ?? '');
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|to|through|–)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/i.exec(t);
  if (!m) return null;
  const iso = (mo, da, y) => `${y}-${pad(Number(mo))}-${pad(Number(da))}`;
  const s = iso(m[1], m[2], m[3]); const e = iso(m[4], m[5], m[6]);
  return { start: s, end: e };
}

function expiryRows(subject, snap, term = null, docType = 'maintenance-agreement') {
  if (subject === 'warranty') {
    const have = snap.units.filter((u) => u.warrantyExpires && (term == null || u.warrantyTermYears === term));
    return { rows: have.map((u) => ({ row: u, d: u.warrantyExpires })), unknown: snap.units.filter((u) => !u.warrantyExpires).length };
  }
  const ag = snap.documents.filter((d) => d.type === docType);
  const out = []; let unknown = 0;
  for (const d of ag) { const e = endOf(d); if (e) out.push({ row: d, d: e }); else unknown++; }
  return { rows: out, unknown };
}

function execExpiry(plan, x) {
  const { snap, today } = x;
  if (plan.mode === 'unit') {
    const u = snap.units.find((v) => lc(v.serial) === lc(plan.serial));
    if (!u) return { notFound: plan.serial };
    return { unit: u };
  }
  const { rows, unknown } = expiryRows(plan.subject, snap, plan.term ?? null, plan.docType ?? 'maintenance-agreement');
  if (!rows.length && plan.subject !== 'warranty' && plan.docType && plan.docType !== 'maintenance-agreement') return { abstain: 'no-end-dates' }; // this kind of paper carries no end date here
  if (plan.mode === 'next') {
    const fut = rows.filter((o) => o.d >= today).sort((a, b) => a.d.localeCompare(b.d));
    if (!fut.length) return { none: true, unknown };
    const d0 = fut[0].d;
    return { next: fut.filter((o) => o.d === d0), date: d0, unknown, later: fut.length };
  }
  const sel = rows.filter((o) => (!plan.from || o.d >= plan.from) && (!plan.to || o.d <= plan.to)).sort((a, b) => a.d.localeCompare(b.d));
  return { sel, unknown, total: rows.length };
}

function execBetween(plan, x) {
  const { snap, today } = x;
  if (plan.mode === 'docs') {
    const find = (num) => snap.documents.filter((d) => [d.f?.invoice_number, d.f?.po_number, d.f?.permit_number].some((v) => lc(v) === num));
    const a = find(plan.numbers[0]); const b = find(plan.numbers[1]);
    if (a.length !== 1 || b.length !== 1) return { abstain: 'doc-number' };
    const da = a[0].date; const db = b[0].date;
    if (!da || !db) return { abstain: 'no-date' };
    return { a: a[0], b: b[0], da, db, days: Math.abs(diffDays(da, db)) };
  }
  if (plan.mode === 'span') {
    const nm = plan.filters[0].value;
    if (snap.customers.filter((c) => lc(c.name) === lc(nm)).length > 1) return { abstain: 'ambiguous-name' };
    const rows = snap.documents.filter((d) => d.type === plan.docType && lc(d.custName) === lc(nm));
    const dated = rows.filter((d) => d.date).sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length !== dated.length) return { abstain: 'no-date' }; // a paper without a date would change the first or the last
    if (dated.length < 2) return { abstain: 'span-needs-two' };
    const a = dated[0]; const b = dated[dated.length - 1];
    return { a, b, n: dated.length, rows: dated, days: diffDays(a.date, b.date) };
  }
  if (plan.mode === 'register') {
    let us;
    if (plan.scope === 'serial') { const u = snap.units.find((v) => lc(v.serial) === lc(plan.serial)); if (!u) return { notFound: plan.serial }; us = [u]; }
    else if (plan.scope === 'customer') {
      const nm = plan.filters[0].value;
      if (snap.customers.filter((c) => lc(c.name) === lc(nm)).length > 1) return { abstain: 'ambiguous-name' };
      us = snap.units.filter((u) => lc(u.custName) === lc(nm));
      if (!us.length) return { noUnits: nm };
    } else us = snap.units;
    const both = us.filter((u) => u.installDate && u.registeredDate);
    return { us, both, gaps: both.map((u) => diffDays(u.installDate, u.registeredDate)) };
  }
  // agreements
  const ag = snap.documents.filter((d) => d.type === 'maintenance-agreement');
  let rows = ag.map((d) => ({ d, t: agreementTerm(d) })).filter((o) => o.t);
  const nameF = plan.filters.find((f) => f.field === 'customer');
  if (nameF) {
    const same = snap.customers.filter((c) => lc(c.name) === lc(nameF.value));
    if (same.length > 1) return { abstain: 'ambiguous-name' };
    rows = rows.filter((o) => lc(o.d.custName) === lc(nameF.value));
    if (!rows.length) return { none: true };
  }
  const fut = rows.filter((o) => o.t.end >= today).sort((a, b) => a.t.end.localeCompare(b.t.end));
  if (!fut.length) return { allEnded: rows };
  return { fut, rows };
}

function execAge(plan, x) {
  const { snap, today } = x;
  const yrs = (u) => (u.installDate ? diffDays(u.installDate, today) / 365.25 : null);
  if (plan.mode === 'serial') {
    const u = snap.units.find((v) => lc(v.serial) === lc(plan.serial));
    if (!u) return { notFound: plan.serial };
    return { units: [u], ages: [yrs(u)] };
  }
  if (plan.mode === 'customer') {
    const nm = plan.filters.find((f) => f.field === 'customer').value;
    if (snap.customers.filter((c) => lc(c.name) === lc(nm)).length > 1) return { abstain: 'ambiguous-name' };
    const us = snap.units.filter((u) => lc(u.custName) === lc(nm));
    if (!us.length) return { noUnits: nm };
    return { units: us, ages: us.map(yrs) };
  }
  const us = snap.units.filter((u) => u.installDate && (!plan.filters.length || plan.filters.every((f) => lc(f.field === 'brand' ? u.brand : null) === lc(f.value))));
  if (!us.length) return { abstain: 'none' };
  const ages = us.map(yrs);
  return { units: us, ages, avg: ages.reduce((a, b) => a + b, 0) / ages.length, noDate: snap.units.length - us.length };
}

/* ====================================================================== say */

const recUnit = (u, snap) => recordFor({ entity: 'unit' }, u, snap);
const recDoc = (d, snap) => recordFor({ entity: 'document' }, d, snap);
const recCust = (c, snap) => recordFor({ entity: 'customer' }, c, snap);
const agrRec = (d, snap) => (snap.custById.get(d.custId) ? recCust(snap.custById.get(d.custId), snap) : recDoc(d, snap));
const recordsCap = (arr, fn, n = 200) => arr.slice(0, n).map(fn);

function condOf(plan) {
  const parts = (plan.filters ?? []).map((f) => (f.field === 'customer' ? `for ${f.value}` : f.field === 'tech' ? `for technician ${f.value}` : f.field === 'brand' ? `(${f.value})` : f.field === 'serviceType' ? `of type ${String(f.value).toLowerCase()}` : `in ${f.value}`));
  return parts.length ? ` ${parts.join(' ')}` : '';
}
const DATE_RULE = { serviceDate: 'the service date', date: 'the date on the paper', createdAt: 'the upload date', installDate: 'the installation date' };
function basisFor(plan, extra = '') {
  const m = plan.measure;
  const what = m.entity === 'unit' ? 'installations (by installation date)' : m.visit ? 'service visits (every paper that carries a service date)' : m.docType ? `${thing(m)} (by ${DATE_RULE[m.dateField] ?? 'its date'})` : `documents (by ${DATE_RULE[m.dateField] ?? 'their date'})`;
  return `Counted ${what}${m.money ? ' and added up the invoice totals as printed' : ''}; internal-only papers and HR letters are left out.${extra ? ` ${extra}` : ''}`;
}
const partialNote = (range, today) => (range && range.to > today ? ` (${range.label} is not over yet; counted through ${fmtDate(today)})` : '');

function sayResult(res, plan, x) {
  const { snap, today } = x;
  switch (plan.op) {
    case 'tm_window': return sayWindow(res, plan, x);
    case 'tm_series': return plan.mode === 'seasons' ? saySeasons(res, plan, x) : saySeries(res, plan, x);
    case 'tm_compare': return sayCompare(res, plan, x);
    case 'tm_rate': return sayRate(res, plan, x);
    case 'tm_since': return saySince(res, plan, x);
    case 'tm_inactive': return sayInactive(res, plan, x);
    case 'tm_expiry': return sayExpiry(res, plan, x);
    case 'tm_between': return sayBetween(res, plan, x);
    case 'tm_age': return sayAge(res, plan, x);
    default: return null;
  }
}

function sayWindow(res, plan, x) {
  const { snap, today } = x;
  const meas = plan.measure; const p = res.period;
  const typeWord = (plan.filters ?? []).filter((f) => f.field === 'serviceType').map((f) => String(f.value).toLowerCase()).join(' ');
  const rest = { ...plan, filters: (plan.filters ?? []).filter((f) => f.field !== 'serviceType') };
  const cond = condOf(rest);
  const when = p.kind === 'ytd' ? `so far in ${p.label.replace(' so far', '')} (through ${fmtDate(today)})` : ['year', 'quarter', 'month'].includes(p.kind) ? `in ${p.label}` : p.label;
  const noun = (typeWord ? `${typeWord} ` : '') + (meas.money ? 'invoice dollars' : meas.hours ? 'labor hours' : meas.noun);
  const val = meas.money ? fmtMoney(res.value) : meas.hours ? fmtNum(res.value, 1) : fmtInt(res.value);
  let text = res.value === 0 && !meas.money && !meas.hours ? `0 ${noun}${cond} ${when}.` : `${val} ${noun}${cond} ${when}.`;
  if (p.to > today && p.kind !== 'ytd' && p.kind !== 'roll' && p.kind !== 'range') text += ` ${cap1(p.label)} is not over yet (counted through ${fmtDate(today)}).`;
  const recs = res.rows ?? [];
  // "list the permits in July": the papers themselves, with their own numbers
  if (plan.list && recs.length && recs.length <= 40 && meas.entity !== 'unit') {
    const lab = (d) => { const num = d.f?.invoice_number ?? d.f?.po_number ?? d.f?.permit_number; return `${num ?? d.filename ?? 'a paper'}${d.custName ? ` (${d.custName}, ${fmtDate(d.date)})` : ` (${fmtDate(d.date)})`}`; };
    text += ` ${recs.map(lab).join('; ')}.`;
  }
  return { text, facts: [{ label: cap1(noun), value: val }], records: recordsCap(recs, (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap))), total: recs.length, claimedCount: meas.money || meas.hours ? null : res.value, basis: basisFor(plan, res.leftOut ? `${fmtInt(res.leftOut)} with no date on file were not counted.` : '') };
}

function saySeries(res, plan, x) {
  const { snap, today } = x;
  const meas = plan.measure; const grain = plan.grain;
  const cond = condOf(plan);
  const keys = [...res.buckets.keys()].sort();
  if (!keys.length) return { text: `No ${thing(meas)}${cond} fall in that period on file.`, facts: [], records: [], total: 0, basis: basisFor(plan) };
  const GN = { year: 'year', month: 'month', quarter: 'quarter', moy: 'month of the year', weekday: 'day of the week' }[grain];
  const fv = (k) => fmtVal(meas, res.buckets.get(k));
  const rangeNote = plan.range ? ` ${plan.range.label}` : '';
  const thisYear = today.slice(0, 4);
  let text;
  if (plan.mode === 'peak' && plan.nth) {
    // "the second busiest month": place N of the periods ranked by the measure (a tie before place N, or one reaching back to it, is released)
    const ranked = keys.map((k) => ({ k, v: res.buckets.get(k) })).sort((a, b) => b.v - a.v || (a.k < b.k ? -1 : 1));
    const nt = nthOf(ranked.map((o) => o.v), plan.nth);
    if (nt.status === 'ambiguous') return null;
    const periodWord = { year: 'year', month: 'month', quarter: 'quarter', moy: 'month of the year', weekday: 'weekday' }[grain];
    const inRange = plan.range ? (/^(?:before|after|since)/.test(plan.range.label) ? ` ${plan.range.label}` : ` in ${plan.range.label}`) : '';
    const every = grain === 'moy' || grain === 'weekday' ? ' across all years' : '';
    const amountOf = (v) => (meas.money ? fmtMoney(v) : meas.hours ? `${fmtNum(v, 1)} labor hours` : `${fmtInt(v)} ${meas.noun}`);
    if (nt.status === 'short') return { text: `Only ${fmtInt(ranked.length)} ${periodWord}${ranked.length === 1 ? '' : 's'}${inRange}${cond} have anything on file, so there is no ${nthWord(plan.nth)} busiest ${periodWord}.`, facts: [], records: [], total: 0, basis: basisFor(plan) };
    const at = ranked.slice(nt.from, nt.to);
    const names = at.map((o) => bucketLabel(o.k, grain));
    const nameLine = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    text = at.length === 1 ? `The ${nthWord(plan.nth)} busiest ${periodWord}${inRange}${cond} was ${nameLine}, with ${amountOf(at[0].v)}${every}.` : `The ${nthWord(plan.nth)} busiest ${periodWord}${inRange}${cond} is a tie between ${nameLine}, each with ${amountOf(at[0].v)}${every}.`;
    text += ` The busiest was ${bucketLabel(ranked[0].k, grain)}, with ${amountOf(ranked[0].v)}.`;
    const live = at.filter((o) => (grain === 'year' && o.k === thisYear) || (grain === 'month' && o.k === today.slice(0, 7)));
    if (live.length) text += ` Note that ${live[0].k === thisYear ? thisYear : monthLabel(live[0].k)} is not over yet (counted through ${fmtDate(today)}).`;
    if (meas.assumed) text += ' Busiest is measured by service visits.';
    const recs = res.rowsBy ? at.flatMap((o) => res.rowsBy.get(o.k)) : [];
    return { text, facts: at.map((o) => ({ label: bucketLabel(o.k, grain), value: fmtVal(meas, o.v) })), records: recordsCap(recs, (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap))), total: recs.length, basis: basisFor(plan, res.leftOut ? `${fmtInt(res.leftOut)} with no date on file were not counted.` : '') };
  }
  if (plan.mode === 'peak') {
    const max = Math.max(...keys.map((k) => res.buckets.get(k)));
    const top = keys.filter((k) => res.buckets.get(k) === max);
    const periodWord = { year: 'year', month: 'month', quarter: 'quarter', moy: 'month of the year', weekday: 'weekday' }[grain];
    const inRange = plan.range ? (/^(?:before|after|since)/.test(plan.range.label) ? ` ${plan.range.label}` : ` in ${plan.range.label}`) : '';
    const every = grain === 'moy' || grain === 'weekday' ? ' across all years' : '';
    const amount = meas.money ? fmtMoney(max) : meas.hours ? `${fmtNum(max, 1)} labor hours` : `${fmtInt(max)} ${meas.noun}`;
    const names = top.map((k) => bucketLabel(k, grain));
    const nameLine = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    text = top.length === 1
      ? `The busiest ${periodWord}${inRange}${cond} was ${nameLine}, with ${amount}${every}.`
      : `The busiest ${periodWord}${inRange}${cond} is a tie between ${nameLine}, each with ${amount}${every}.`;
    const live = top.filter((k) => (grain === 'year' && k === thisYear) || (grain === 'month' && k === today.slice(0, 7)));
    if (live.length) text += ` Note that ${live[0] === thisYear ? thisYear : monthLabel(live[0])} is not over yet (counted through ${fmtDate(today)}).`;
    if (meas.assumed) text += ' Busiest is measured by service visits.';
    if (!meas.money && !meas.hours) { const tot = keys.reduce((a, k) => a + res.buckets.get(k), 0); text += ` Counted over ${fmtInt(tot)} ${meas.noun} that have ${/visit/.test(meas.noun) ? 'a service date' : /invoice/.test(meas.noun) ? 'an invoice date' : 'a date'}.`; }
    const recs = res.rowsBy ? top.flatMap((k) => res.rowsBy.get(k)) : [];
    return { text, facts: top.slice(0, 7).map((k) => ({ label: bucketLabel(k, grain), value: fv(k) })), records: recordsCap(recs, (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap))), total: recs.length, basis: basisFor(plan, res.leftOut ? `${fmtInt(res.leftOut)} with no date on file were not counted.` : '') };
  }
  // a list over the grain
  let seq = keys;
  if (grain === 'year' || grain === 'month' || grain === 'quarter') seq = allBuckets(grain, keys[0], keys[keys.length - 1]);
  if (grain === 'moy') seq = Array.from({ length: 12 }, (_, i) => pad(i + 1));
  if (grain === 'weekday') seq = [1, 2, 3, 4, 5, 6, 0].map(String);
  // the most recent years, then the one that is not over yet
  let items = seq.map((k) => `${bucketLabel(k, grain)}: ${meas.money ? fmtMoney(res.buckets.get(k) ?? 0) : meas.hours ? `${fmtNum(res.buckets.get(k) ?? 0, 1)} hours` : fmtInt(res.buckets.get(k) ?? 0)}`);
  let tail = '';
  if (plan.lastN && grain === 'year') {
    const done = seq.filter((k) => k < thisYear); const cur = seq.filter((k) => k === thisYear);
    items = done.map((k) => `${k}: ${meas.money ? fmtMoney(res.buckets.get(k) ?? 0) : meas.hours ? `${fmtNum(res.buckets.get(k) ?? 0, 1)} hours` : fmtInt(res.buckets.get(k) ?? 0)}`);
    if (cur.length) tail = ` ${thisYear} so far (through ${fmtDate(today)}) is ${fmtVal(meas, res.buckets.get(thisYear) ?? 0)}; the year is not over.`;
  } else if (grain === 'year' && seq.includes(thisYear)) tail = ` ${thisYear} is not over yet (counted through ${fmtDate(today)}).`;
  else if (grain === 'month' && seq.includes(today.slice(0, 7))) tail = ` ${monthLabel(today.slice(0, 7))} is not over yet.`;
  const per = { year: 'per year', month: 'per month', quarter: 'per quarter', moy: 'by month of the year (all years together)', weekday: 'by day of the week (all years together)' }[grain];
  const what = meas.money ? 'Invoiced' : meas.hours ? 'Labor hours' : cap1(meas.noun);
  text = `${what}${cond} ${per}${rangeNote}: ${listNames(items, 60, '; ')}.${tail}`;
  const recs = [...res.rowsBy.values()].flat();
  return { text, facts: items.length <= 7 ? seq.map((k) => ({ label: bucketLabel(k, grain), value: fmtVal(meas, res.buckets.get(k) ?? 0) })) : [{ label: `${cap1(GN)}s shown`, value: fmtInt(seq.length) }], records: recordsCap(recs, (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap))), total: recs.length, basis: basisFor(plan, res.leftOut ? `${fmtInt(res.leftOut)} with no date on file were not counted.` : '') };
}

function saySeasons(res, plan, x) {
  const { snap } = x;
  const meas = plan.measure;
  const cond = condOf(plan);
  const [a, b] = res.sides;
  const f = (s) => `${s.season} had ${meas.money ? fmtMoney(s.value) : meas.hours ? `${fmtNum(s.value, 1)} hours` : fmtInt(s.value)}`;
  const lead = a.value === b.value ? 'They are equal.' : `${cap1(a.value > b.value ? a.season : b.season)} is higher by ${meas.money ? fmtMoney(Math.abs(a.value - b.value)) : fmtNum(Math.abs(a.value - b.value), 1)}.`;
  const text = `${cap1(meas.money ? 'invoiced' : meas.noun)}${cond}, every year together: ${f(a)} and ${f(b)}. ${lead} Summer means ${SEASONS.summer.months.length ? 'June to August' : ''}, winter means December to February.`.replace('Summer means June to August, winter means December to February.', [a, b].map((s, i) => `${i ? s.season : cap1(s.season)} means ${SEASONS[s.season].label.replace(/^[a-z]+ \(|\)$/g, '')}`).join(', ') + '.');
  const recs = [...a.rows, ...b.rows];
  return { text, facts: res.sides.map((s) => ({ label: cap1(s.season), value: fmtVal(meas, s.value) })), records: recordsCap(recs, (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap))), total: recs.length, basis: basisFor(plan, 'Seasons are read as calendar months in every year on file.') };
}

function sayCompare(res, plan, x) {
  const { snap, today } = x;
  const meas = plan.measure;
  const cond = condOf(plan);
  const [a, b] = res.sides;
  const lab = (s) => (s.kind === 'ytd' ? (s.matched ? s.label : `${s.label.replace(' so far', '')} so far (through ${fmtDate(today)})`) : s.label);
  const val = (s) => fmtVal(meas, s.value);
  const word = meas.money ? 'invoiced' : meas.hours ? 'labor hours' : meas.noun;
  let text = `${cap1(word)}${cond}: ${lab(a)} had ${val(a)} and ${lab(b)} had ${val(b)}.`;
  if (plan.yn) text = ynText(plan.yn, { label: lab(a), value: a.value }, { label: lab(b), value: b.value }, text);
  const notes = [];
  for (const s of res.sides) if (s.to > today && s.kind !== 'ytd' && s.kind !== 'roll') notes.push(`${s.label} is not over yet (counted through ${fmtDate(today)})`);
  const base = res.sides[plan.baseIdx]; const neu = res.sides[1 - plan.baseIdx];
  if (a.value !== b.value) {
    const diff = Math.abs(a.value - b.value);
    const hi = a.value > b.value ? a : b;
    text += ` ${cap1(lab(hi))} is higher by ${meas.money ? fmtMoney(diff) : meas.hours ? `${fmtNum(diff, 1)} hours` : fmtInt(diff)}.`;
  } else text += ' They are equal.';
  if (plan.wantsPct) {
    if (base.value === 0) text += ` There is no percentage change from ${lab(base)}, because it had none.`;
    else {
      const pct = ((neu.value - base.value) / base.value) * 100;
      const sign = pct > 0 ? '+' : '';
      const d = dualNum(Math.abs(pct));
      const neg = pct < 0 ? '-' : sign;
      text += ` From ${lab(base)} to ${lab(neu)} that is a change of ${neg}${d.main.replace(/\.0$/, '')}%.`;
    }
  }
  if (res.matched && res.matched.value != null) text += ` For a like-for-like look, ${res.matched.year} through ${fmtDate(res.matched.to)} was ${fmtVal(meas, res.matched.value)}.`;
  if (notes.length) text += ` Note: ${notes.join('; ')}.`;
  const recs = [...a.rows, ...b.rows];
  return { text, facts: res.sides.map((s) => ({ label: lab(s), value: val(s) })), records: recordsCap(recs, (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap))), total: recs.length, basis: basisFor(plan, 'A percentage change is measured from the earlier (or the "from") period.') };
}

function sayRate(res, plan, x) {
  const { snap } = x;
  const meas = plan.measure;
  const rec = (r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap));
  if (plan.mode === 'gap') {
    const cond = condOf(plan);
    if (res.few != null) return { text: `There ${res.few === 1 ? 'is' : 'are'} only ${fmtInt(res.few)} ${res.few === 1 ? (meas.one ?? meas.noun) : meas.noun}${cond} on file, so there is no gap between one and the next to average.`, facts: [], records: [], total: 0, basis: 'A gap needs at least two dated papers.' };
    const text = res.scope === 'customers'
      ? `Across customers, on average ${plainInt(res.avg)} days pass between one ${meas.one ?? meas.noun} and the next at the same customer (${fmtInt(res.n)} gaps between neighbouring ${meas.noun} of ${fmtInt(res.customers)} customers who have more than one).`
      : `On average, about ${dualNum(res.avg).main.replace(/\.0$/, '')} days pass between one ${meas.one ?? meas.noun}${cond} and the next (${fmtInt(res.n)} ${meas.noun}${cond} from ${fmtDate(res.first)} to ${fmtDate(res.last)}).`;
    const basis = res.scope === 'customers'
      ? `Took each customer's ${meas.noun} in date order and averaged all the days between neighbours (customers with one are left out).`
      : `Took the dates of every ${meas.one ?? meas.noun}${cond} in order and averaged the days between neighbours (first date to last, divided by one less than the count; the same day counts as a gap of 0).`;
    return { text, facts: [{ label: 'Average gap (days)', value: fmtNum(res.avg, 1) }], records: recordsCap(res.rows, rec), total: res.rows.length, basis };
  }
  const dv = dualNum(res.avg);
  const text = `About ${dv.main.replace(/\.0$/, '')} ${meas.noun}${condOf(plan)} per ${plan.unit} on average: ${fmtInt(res.n)} ${meas.noun} over ${plan.range ? `${fmtNum(res.periods, 1)} ${plan.unit}s${res.note ? ` (${res.note})` : ''}` : res.note}.`;
  return { text, facts: [{ label: `${cap1(meas.noun)} per ${plan.unit}`, value: fmtNum(res.avg, 2) }], records: recordsCap(res.rows, rec), total: res.rows.length, basis: `${basisFor(plan)} Periods with nothing in them are counted in the average.` };
}

function saySince(res, plan, x) {
  const { snap, today } = x;
  const meas = plan.measure;
  const cond = condOf(plan);
  const plural = meas.visit || meas.noun === 'service visit' ? 'visits' : `${meas.noun}s`;
  if (res.notFound) return { text: `Not found: no unit with serial ${res.notFound.toUpperCase()} is on file.`, facts: [], records: [], total: 0, basis: 'Looked for the serial number among the units on file.' };
  if (res.none) return { text: `No ${plural} on file${cond ? ` ${cond.trim()}` : ''}${res.unit ? ` for unit ${res.unit.serial}` : ''}, so there is no last one to count from.`, facts: [], records: [], total: 0, basis: `Looked at every ${meas.noun} on file.` };
  const ago = res.days === 0 ? 'today' : `${fmtInt(plainInt(res.days))} day${res.days === 1 ? '' : 's'} ago${res.days >= 365 ? `, about ${fmtNum(res.days / 365.25, 1)} years` : ''}`;
  const approx = plan.unitAsked === 'week' ? `about ${fmtNum(res.days / 7, 1)} weeks` : plan.unitAsked === 'month' ? `about ${fmtNum(res.days / 30.4375, 1)} months` : plan.unitAsked === 'year' ? `about ${fmtNum(res.days / 365.25, 1)} years` : res.days >= 365 ? `about ${fmtNum(res.days / 365.25, 1)} years` : res.days >= 90 ? `about ${fmtNum(res.days / 30.4375, 1)} months` : '';
  const many = res.tied.length > 1 ? ` ${fmtInt(res.tied.length)} ${plural} share that date.` : '';
  const whatLast = res.unit && plan.serial ? `service visit for unit ${res.unit.serial}` : `${meas.noun}${cond}`;
  const text = plan.mode === 'date'
    ? `The last ${whatLast} was ${fmtDate(res.last)} (${ago}).${many}`
    : `${fmtInt(plainInt(res.days))} day${res.days === 1 ? '' : 's'} since the last ${whatLast}: it was dated ${fmtDate(res.last)}${approx ? `, ${approx}` : ''}.${many}`;
  const recs = (res.tied ?? []).map((r) => (meas.entity === 'unit' ? recUnit(r, snap) : recDoc(r, snap)));
  return { text: text + (res.future ? ` ${fmtInt(res.future)} dated after today were not counted.` : ''), facts: [{ label: 'Last', value: fmtDate(res.last) }, { label: 'Days since', value: plainInt(res.days) }], records: recs.slice(0, 50), total: recs.length, basis: `Took the latest date of ${meas.entity === 'unit' ? 'installations' : meas.noun + 's'} (by ${DATE_RULE[meas.dateField] ?? 'its date'}) and counted the days from it to ${fmtDate(today)}.` };
}

function sayInactive(res, plan, x) {
  const { snap } = x;
  const actW = { visit: 'service visit', invoice: 'invoice', install: 'unit installed' }[plan.activity];
  const n = res.inactive.length;
  const seen = new Map(); for (const c of snap.customers) seen.set(lc(c.name), (seen.get(lc(c.name)) ?? 0) + 1);
  const names = res.inactive.map((o) => (seen.get(lc(o.c.name)) > 1 && o.c.address ? `${o.c.name} (${o.c.address})` : o.c.name));
  const neverNote = res.never ? ` ${fmtInt(res.never)} more customer${res.never === 1 ? ' has' : 's have'} no ${plan.activity === 'install' ? 'unit' : actW} on file at all, and ${res.never === 1 ? 'is' : 'are'} not in that count.` : '';
  const verbPhrase = `had no ${actW} ${plan.label}`;
  const cut = `(their latest one is dated before ${fmtDate(plan.cutoff)})`;
  const head = plan.mode === 'count'
    ? `${fmtInt(n)} customer${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} ${verbPhrase} ${cut}.`
    : n === 0 ? `Every customer with a ${actW} on file has had one ${plan.label} (since ${fmtDate(plan.cutoff)}).` : `${fmtInt(n)} customer${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} ${verbPhrase} ${cut}: ${listNames(names, 120)}.`;
  const recs = res.inactive.map((o) => recCust(o.c, snap));
  const what = plan.activity === 'visit' ? 'service visit (any paper with a service date)' : plan.activity === 'invoice' ? 'invoice date' : 'unit installation date';
  return { text: head + neverNote, facts: [{ label: 'Customers', value: fmtInt(n) }], records: recs.slice(0, 200), total: n, claimedCount: n, basis: `Took each customer's latest ${what} and kept those whose latest one is before ${fmtDate(plan.cutoff)}.` };
}

function sayExpiry(res, plan, x) {
  const { snap, today } = x;
  const isW = plan.subject === 'warranty';
  const termW = plan.term != null ? `${plan.term}-year ` : '';
  const nounPl = termW + (plan.noun ?? (isW ? 'warranties' : 'maintenance agreements'));
  const nounOne = termW + (plan.nounOne ?? (isW ? 'warranty' : 'maintenance agreement'));
  const dateName = isW ? 'warranty end date' : 'agreement end date';
  const lab = (o) => (isW ? `${o.row.serial ?? 'unit'}${[o.row.brand, o.row.custName].filter(Boolean).length ? ` (${[o.row.brand, o.row.custName].filter(Boolean).join(', ')})` : ''} on ${fmtDate(o.d)}` : `${o.row.custName ?? o.row.vendor ?? 'agreement'} on ${fmtDate(o.d)}`);
  const rec = (o) => (isW ? recUnit(o.row, snap) : (snap.custById.get(o.row.custId) ? recCust(snap.custById.get(o.row.custId), snap) : recDoc(o.row, snap)));
  const unk = res.unknown ? (isW ? ` ${fmtInt(res.unknown)} unit${res.unknown === 1 ? ' has' : 's have'} no warranty end date on file and ${res.unknown === 1 ? 'is' : 'are'} not counted.` : ` ${fmtInt(res.unknown)} agreement${res.unknown === 1 ? ' has' : 's have'} no readable term and ${res.unknown === 1 ? 'is' : 'are'} not counted.`) : '';
  const basis = isW ? 'Used each unit\'s warranty end date (the installation date plus the brand\'s term; five years is assumed when no registration is on file); claims and payments are not tracked.' : 'Used the end of each maintenance agreement\'s term; nothing about renewals or payments is tracked.';
  if (plan.mode === 'unit') {
    if (res.notFound) return { text: `Not found: no unit with serial ${res.notFound.toUpperCase()} is on file.`, facts: [], records: [], total: 0, basis: 'Looked for the serial number among the units on file.' };
    const u = res.unit; const rec1 = [recUnit(u, snap)];
    if (!u.warrantyExpires) return { text: `${u.serial} has no warranty end date on file, so there is nothing to count down to.`, facts: [], records: rec1, total: 1, basis };
    const d = diffDays(today, u.warrantyExpires);
    return { text: d >= 0 ? `The warranty on ${u.serial} ends ${fmtDate(u.warrantyExpires)}, ${plainInt(d)} day${d === 1 ? '' : 's'} from today.` : `The warranty on ${u.serial} ended ${fmtDate(u.warrantyExpires)}, ${plainInt(-d)} day${d === -1 ? '' : 's'} ago.`, facts: [{ label: 'Warranty end', value: fmtDate(u.warrantyExpires) }], records: rec1, total: 1, basis };
  }
  if (plan.mode === 'next') {
    if (res.none) return { text: `None. No ${nounOne} on file ends after today.${unk}`, facts: [], records: [], total: 0, basis };
    const d = res.date; const days = diffDays(today, d);
    const items = res.next.map(lab);
    return { text: `The next ${nounOne} to end is ${listNames(items, 20)}, on ${fmtDate(d)}: ${plainInt(days)} day${days === 1 ? '' : 's'} from today.${unk}`, facts: [{ label: 'Next end date', value: fmtDate(d) }], records: res.next.map(rec).slice(0, 100), total: res.next.length, basis };
  }
  const n = res.sel.length;
  const when = `${plan.label}${plan.from && !plan.past && plan.label !== 'before today' ? (plan.to ? ` (${fmtDate(plan.from)} to ${fmtDate(plan.to)})` : ` (from ${fmtDate(plan.from)} on)`) : ''}`;
  const verb = plan.past ? 'ended' : 'end';
  const noun = n === 1 ? nounOne : nounPl;
  let text;
  if (!n) text = plan.mode === 'any' ? `No. 0 ${nounPl} ${verb} ${when}.` : `None. 0 ${nounPl} ${verb} ${when}.`;
  else if (plan.mode === 'any') text = `Yes. ${fmtInt(n)} ${noun} ${verb} ${when}: ${listNames(res.sel.map(lab), 30)}.`;
  else if (plan.mode === 'count') text = `${fmtInt(n)} ${noun} ${n === 1 ? (plan.past ? 'ended' : 'ends') : verb} ${when}.`;
  else text = `${fmtInt(n)} ${noun} ${n === 1 ? (plan.past ? 'ended' : 'ends') : verb} ${when}: ${listNames(res.sel.map(lab), 40)}.`;
  return { text: text + unk, facts: [{ label: cap1(noun), value: fmtInt(n) }], records: res.sel.map(rec).slice(0, 200), total: n, claimedCount: n, basis };
}

function sayBetween(res, plan, x) {
  const { snap, today } = x;
  if (plan.mode === 'docs') {
    const lab = (d, n) => `${n.toUpperCase()} (${documentTypeLabel(d.type)?.toLowerCase() ?? 'document'}, ${fmtDate(d.date)})`;
    const [na, nb] = plan.numbers;
    return { text: `${dayText(res.days)} between ${lab(res.a, na)} and ${lab(res.b, nb)}.`, facts: [{ label: 'Days apart', value: fmtInt(res.days) }], records: [recDoc(res.a, snap), recDoc(res.b, snap)], total: 2, basis: 'Counted the days from the date of one paper to the date of the other (not counting both end days).' };
  }
  if (plan.mode === 'span') {
    const kind = documentTypeLabel(plan.docType)?.toLowerCase() ?? 'document';
    return { text: `${dayText(res.days)} from the first to the last of ${plan.filters[0].value}'s ${res.n} ${kind} papers (${fmtDate(res.a.date)} to ${fmtDate(res.b.date)}).`, facts: [{ label: 'Days from first to last', value: fmtInt(res.days) }], records: res.rows.slice(0, 100).map((d) => recDoc(d, snap)), total: res.rows.length, basis: `Counted the days from the earliest to the latest date among ${plan.filters[0].value}'s ${kind} papers on file.` };
  }
  if (plan.mode === 'register') {
    const bs = 'Counted the days from the installation date to the warranty registration date on file.';
    if (res.notFound) return { text: `Not found: no unit with serial ${res.notFound.toUpperCase()} is on file.`, facts: [], records: [], total: 0, basis: 'Looked for the serial number among the units on file.' };
    if (res.noUnits) return { text: `No unit is on file for ${res.noUnits}.`, facts: [], records: [], total: 0, basis: 'Looked for units linked to that customer.' };
    const line = (u) => { if (!u.installDate) return `${u.serial} has no installation date on file`; if (!u.registeredDate) return `${u.serial} (installed ${fmtDate(u.installDate)}) is not registered: no warranty registration is on file, so there is no gap to count`; const g = diffDays(u.installDate, u.registeredDate); return `${u.serial} was registered ${fmtInt(Math.abs(g))} day${Math.abs(g) === 1 ? '' : 's'} ${g >= 0 ? 'after' : 'before'} it was installed (installed ${fmtDate(u.installDate)}, registered ${fmtDate(u.registeredDate)})`; };
    if (plan.scope === 'all') {
      const avg = res.gaps.reduce((a, b) => a + b, 0) / res.gaps.length;
      const nr = res.us.length - res.both.length;
      return { text: `On average, about ${dualNum(avg).main.replace(/\.0$/, '')} days pass from installation to warranty registration, across ${fmtInt(res.both.length)} units that have both dates (shortest ${fmtInt(Math.min(...res.gaps))}, longest ${fmtInt(Math.max(...res.gaps))}).${nr ? ` ${fmtInt(nr)} units have no registration date on file and are left out.` : ''}`, facts: [{ label: 'Average days', value: dualNum(avg).alt ?? dualNum(avg).main }], records: res.both.slice(0, 200).map((u) => recUnit(u, snap)), total: res.both.length, basis: bs };
    }
    return { text: `${res.us.map(line).join('; ')}.`, facts: [], records: res.us.slice(0, 100).map((u) => recUnit(u, snap)), total: res.us.length, basis: bs };
  }
  const basis = 'Used the end of each maintenance agreement\'s term; nothing about renewals is tracked.';
  if (res.none) return { text: 'No maintenance agreement is on file for that customer.', facts: [], records: [], total: 0, basis };
  if (res.allEnded) return { text: `Every maintenance agreement on file for ${res.allEnded[0].d.custName ?? 'that customer'} has already ended (the latest ended ${fmtDate(res.allEnded.map((o) => o.t.end).sort().slice(-1)[0])}).`, facts: [], records: res.allEnded.map((o) => agrRec(o.d, snap)), total: res.allEnded.length, basis };
  const first = res.fut[0]; const days = diffDays(today, first.t.end);
  const sameDay = res.fut.filter((o) => o.t.end === first.t.end);
  const who = plan.filters.length ? ` for ${first.d.custName}` : '';
  let text = plan.filters.length
    ? `The agreement${who} ends ${fmtDate(first.t.end)}, ${fmtInt(days)} day${days === 1 ? '' : 's'} from today.`
    : `The soonest agreement end is ${fmtDate(first.t.end)}, ${fmtInt(days)} day${days === 1 ? '' : 's'} from today (${fmtInt(sameDay.length)} agreement${sameDay.length === 1 ? '' : 's'} end${sameDay.length === 1 ? 's' : ''} that day${res.fut.length > sameDay.length ? `; ${fmtInt(res.fut.length - sameDay.length)} more end later` : ''}).`;
  if (plan.filters.length && res.fut.length > 1) text += ` Its other agreement${res.fut.length > 2 ? 's end' : ' ends'}: ${res.fut.slice(1).map((o) => fmtDate(o.t.end)).join(', ')}.`;
  return { text, facts: [{ label: 'Days until', value: fmtInt(days) }], records: res.fut.map((o) => agrRec(o.d, snap)).slice(0, 100), total: res.fut.length, basis };
}

function sayAge(res, plan, x) {
  const { snap, today } = x;
  if (res.notFound) return { text: `Not found: no unit with serial ${res.notFound.toUpperCase()} is on file.`, facts: [], records: [], total: 0, basis: 'Looked for the serial number among the units on file.' };
  if (res.noUnits) return { text: `No unit is on file for ${res.noUnits}.`, facts: [], records: [], total: 0, basis: 'Looked for units linked to that customer.' };
  const basis = 'Age is the time from the installation date on file to today.';
  const yrs = (a) => { const d = dualNum(a); const m = d.main.replace(/\.0$/, ''); return { text: `${m} years`, alt: '' }; };
  const one = (u, a) => (a == null ? `${u.serial ?? 'unit'} has no installation date on file` : `${u.serial ?? 'unit'} is about ${yrs(a).text} old (installed ${fmtDate(u.installDate)})`);
  if (plan.mode === 'avg') return { text: `The average age of the ${fmtInt(res.units.length)} units with an installation date is about ${yrs(res.avg).text}.${res.noDate ? ` ${fmtInt(res.noDate)} units have no installation date and are left out.` : ''}`, facts: [{ label: 'Average age (years)', value: dualNum(res.avg).alt ?? dualNum(res.avg).main }], records: res.units.slice(0, 200).map((u) => recUnit(u, snap)), total: res.units.length, basis };
  if (res.units.length === 1) return { text: `${one(res.units[0], res.ages[0])}.`, facts: [{ label: 'Age (years)', value: res.ages[0] == null ? '-' : (dualNum(res.ages[0]).alt ?? dualNum(res.ages[0]).main) }], records: [recUnit(res.units[0], snap)], total: 1, basis };
  return { text: `${fmtInt(res.units.length)} units: ${res.units.map((u, i) => one(u, res.ages[i])).join('; ')}.`, facts: [], records: res.units.slice(0, 200).map((u) => recUnit(u, snap)), total: res.units.length, basis };
}

function say(res, plan, x) {
  const out = sayResult(res, plan, x);
  if (!out) return null;
  return { claimedCount: null, ...out };
}

registerFamily({ id: 'time', ops: TIME_OPS, slots, detect, exec, say });
export { slots as timeSlots };
