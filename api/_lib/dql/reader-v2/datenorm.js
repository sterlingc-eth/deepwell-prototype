/** datenorm.js - port of lib/datenorm.py (date parser + value normaliser). Pure, deterministic. */
import { D, PyValueError, isDate, dY, dM, dD, weekday, addDays, dcmp, iso, replace, eom, fdiv, pmod, isAlnum, isAlpha, fromIso } from './pyc.js';

export const OPEN_LO = '0000-01-01'; export const OPEN_HI = '9999-12-31';
const DEF = { on: false, apply_conf: 0.7, release_ambiguous: false, decline_unparsed: true, factory: false, tot_fallback: false, fiscal_start_month: null };
let CFG = { ...DEF };
export function configure(d) { CFG = { ...DEF, ...(d || {}) }; }
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = {}; MONTHS.forEach((m, i) => { MON[m] = i + 1; MON[m.slice(0, 3)] = i + 1; }); MON.sept = 9;
export const _MONRE = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, 'couple of': 2, few: 3, several: 4 };
const NUMRE = '(\\d{1,3}|a couple of|a couple|couple of|couple|a few|few|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const NUMCONF = { couple: 0.15, few: 0.25, several: 0.35 };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const _eom = eom;
function addMonths(d, n) { const y = dY(d) + fdiv(dM(d) - 1 + n, 12); const m = pmod(dM(d) - 1 + n, 12) + 1; return D(y, m, Math.min(dD(d), _eom(y, m))); }
const mrange = (y, m) => [D(y, m, 1), D(y, m, _eom(y, m))];
const qrange = (y, q) => [D(y, 3 * q - 2, 1), D(y, 3 * q, _eom(y, 3 * q))];
const qof = (d) => fdiv(dM(d) - 1, 3) + 1;
function count(tok) {
  tok = tok.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\p{Nd}+$/u.test(tok)) return [parseInt(tok, 10), 0.0];
  let base = (tok !== 'a' && tok !== 'an') ? tok.replace(/^an? /, '') : tok;
  base = base.replace(/ of$/, '');
  const k = has(NUMW, base) ? NUMW[base] : undefined;
  return k ? [k, has(NUMCONF, base) ? NUMCONF[base] : 0.0] : [null, 1.0];
}
export class Span {
  constructor(label, lo, hi, conf, kind = 'rel', alts = null, yearExplicit = false) {
    this.label = label; this.lo = lo; this.hi = hi; this.conf = conf; this.kind = kind; this.alts = alts || []; this.year_explicit = yearExplicit; this.start = -1; this.end = -1; this.soft = false;
  }
  iso() { return [isDate(this.lo) ? iso(this.lo) : this.lo, isDate(this.hi) ? iso(this.hi) : this.hi]; }
}
function yearTok(tok, t) {
  if (tok == null) return [null, false];
  tok = tok.trim();
  if (/^\d{4}$/.test(tok)) return [parseInt(tok, 10), true];
  if (['last year', 'previous year', 'prior year'].includes(tok)) return [dY(t) - 1, true];
  if (['this year', 'the current year', 'current year'].includes(tok)) return [dY(t), true];
  if (tok === 'next year') return [dY(t) + 1, true];
  return [null, false];
}
const YR = '(?:\\s*,?\\s*(?:of\\s+)?(\\d{4}|last year|previous year|prior year|this year|current year|next year))?';
function sub(lo, hi, which) {
  const nm = (dY(hi) - dY(lo)) * 12 + dM(hi) - dM(lo) + 1;
  if (nm === 1) { const [a, b] = { early: [1, 10], mid: [11, 20], late: [21, dD(hi)] }[which]; return [replace(lo, { day: a }), replace(lo, { day: b })]; }
  if (nm === 3 || nm === 12) {
    const k = fdiv(nm, 3); const i = { early: 0, mid: 1, late: 2 }[which];
    const a = addMonths(lo, i * k); const b = addDays(addMonths(lo, (i + 1) * k), -1); return [a, b];
  }
  const n = Math.round((hi.getTime() - lo.getTime()) / 86400000) + 1; const a = fdiv(n, 3);
  if (which === 'early') return [lo, addDays(lo, a - 1)];
  if (which === 'mid') return [addDays(lo, a), addDays(lo, 2 * a - 1)];
  return [addDays(lo, 2 * a), hi];
}
const MOD = { early: 'early', 'start of': 'early', 'beginning of': 'early', 'the start of': 'early', 'the beginning of': 'early', mid: 'mid', 'middle of': 'mid', 'the middle of': 'mid', late: 'late', 'end of': 'late', 'the end of': 'late' };
const MODRE = '(early|late|mid|(?:the\\s+)?end of|(?:the\\s+)?start of|(?:the\\s+)?beginning of|(?:the\\s+)?middle of)[-\\s]*';
const mod = (tok) => { const k = tok.toLowerCase().trim().replace(/\s+/g, ' '); if (!has(MOD, k)) throw new Error('KeyError'); return MOD[k]; };
function seasonStart(name, y) { return { spring: D(y, 3, 1), summer: D(y, 6, 1), fall: D(y, 9, 1), autumn: D(y, 9, 1), winter: D(y, 12, 1) }[name]; }
function seasonRange(name, y) {
  const lo = seasonStart(name, y);
  if (name === 'winter') return [lo, D(y + 1, 2, _eom(y + 1, 2))];
  const e = { spring: [5, 31], summer: [8, 31], fall: [11, 30], autumn: [11, 30] }[name];
  return [lo, D(y, e[0], e[1])];
}
const recentSeasonYear = (name, t) => (dcmp(t, seasonStart(name, dY(t))) >= 0 ? dY(t) : dY(t) - 1);
function periodRanges(unit, which, t) {
  if (unit === 'month') {
    if (which === 'this') return ['this month', replace(t, { day: 1 }), t];
    if (which === 'next') { const lo = addMonths(replace(t, { day: 1 }), 1); return ['next month', lo, replace(lo, { day: _eom(dY(lo), dM(lo)) })]; }
    const f = addDays(replace(t, { day: 1 }), -1); return ['last month', replace(f, { day: 1 }), f];
  }
  if (unit === 'year') {
    if (which === 'this') return ['this year', replace(t, { month: 1, day: 1 }), t];
    if (which === 'next') return ['next year', D(dY(t) + 1, 1, 1), D(dY(t) + 1, 12, 31)];
    return ['last year', D(dY(t) - 1, 1, 1), D(dY(t) - 1, 12, 31)];
  }
  if (unit === 'quarter') {
    const q0 = fdiv(dM(t) - 1, 3) * 3 + 1;
    if (which === 'this') return ['this quarter', replace(t, { month: q0, day: 1 }), t];
    if (which === 'next') { const lo = addMonths(replace(t, { month: q0, day: 1 }), 3); return ['next quarter', lo, addDays(addMonths(lo, 3), -1)]; }
    const e = addDays(replace(t, { month: q0, day: 1 }), -1); return ['last quarter', replace(e, { month: fdiv(dM(e) - 1, 3) * 3 + 1, day: 1 }), e];
  }
  if (unit === 'week') {
    const mon = addDays(t, -weekday(t));
    if (which === 'this') return ['this week', mon, t];
    if (which === 'next') return ['next week', addDays(mon, 7), addDays(mon, 13)];
    const s = addDays(mon, -7); return ['last week', s, addDays(s, 6)];
  }
  return null;
}
function fyRange(y, smon) { if (smon === 1) return [D(y, 1, 1), D(y, 12, 31)]; const lo = D(y - 1, smon, 1); return [lo, addDays(addMonths(lo, 12), -1)]; }
const g = (m, i) => (m[i] === undefined ? null : m[i]);

function rules(t) {
  const R = [];
  const add = (rx, fn) => R.push([new RegExp(rx, 'gi'), fn]);
  const h_md = (m) => {
    const mo = MON[m[1].toLowerCase().replace(/\.+$/, '')]; const dd = parseInt(m[2], 10);
    if (!(dd >= 1 && dd <= _eom(mo === 2 ? 2024 : dY(t), mo))) return null;
    let d; try { d = D(dY(t), mo, dd); } catch (e) { return null; }
    if (dcmp(d, t) > 0) d = D(dY(t) - 1, mo, Math.min(dd, _eom(dY(t) - 1, mo)));
    return new Span(iso(d), d, d, 0.8, 'abs', [[D(dY(d) - 1, mo, Math.min(dd, _eom(dY(d) - 1, mo))), D(dY(d) - 1, mo, Math.min(dd, _eom(dY(d) - 1, mo)))]]);
  };
  add('\\b(' + _MONRE + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*(?:19|20)\\d\\d)(?!\\s*[:/\\d])', h_md);
  const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: 4 };
  const h_q = (m, q, yt, md) => {
    let [y, ex] = yearTok(yt, t);
    if (y === null) y = dcmp(qrange(dY(t), q)[0], t) <= 0 ? dY(t) : dY(t) - 1;
    let [lo, hi] = qrange(y, q); let conf = ex ? 0.95 : 0.8; let lab = `Q${q} ${y}`;
    if (md) { [lo, hi] = sub(lo, hi, mod(md)); conf = Math.min(conf, 0.75); lab = `${mod(md)} ${lab}`; }
    return new Span(lab, lo, hi, conf, ex ? 'abs' : 'rel', null, ex);
  };
  add('\\b(?:' + MODRE + ')?(?:the\\s+)?q([1-4])\\b(?![-\\w])' + YR, (m) => h_q(m, parseInt(m[2], 10), g(m, 3), g(m, 1)));
  add('\\b(?:' + MODRE + ')?(?:the\\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)\\s+quarter\\b' + YR, (m) => h_q(m, ORD[m[2].toLowerCase()], g(m, 3), g(m, 1)));
  const h_half = (m, h, yt) => {
    let [y, ex] = yearTok(yt, t);
    if (y === null) y = dcmp(h === 1 ? D(dY(t), 1, 1) : D(dY(t), 7, 1), t) <= 0 ? dY(t) : dY(t) - 1;
    const [lo, hi] = h === 1 ? [D(y, 1, 1), D(y, 6, 30)] : [D(y, 7, 1), D(y, 12, 31)];
    return new Span(`H${h} ${y}`, lo, hi, ex ? 0.95 : 0.75, ex ? 'abs' : 'rel', null, ex);
  };
  add('\\bh([12])\\b' + YR, (m) => h_half(m, parseInt(m[1], 10), g(m, 2)));
  add('\\b(first|second|1st|2nd)\\s+half(?:\\s+of)?' + YR, (m) => h_half(m, ['first', '1st'].includes(m[1].toLowerCase()) ? 1 : 2, g(m, 2)));
  const h_fy = (m) => {
    const sm = CFG.fiscal_start_month || 1; const known = CFG.fiscal_start_month !== null && CFG.fiscal_start_month !== undefined;
    const yt = g(m, 1) || g(m, 2); let y;
    if (yt) y = yt.length === 4 ? parseInt(yt, 10) : 2000 + parseInt(yt, 10);
    else { const tok = (g(m, 3) || 'this').toLowerCase(); const y0 = dcmp(fyRange(dY(t), sm)[1], t) >= 0 ? dY(t) : dY(t) + 1; y = y0 - (['last', 'previous', 'prior'].includes(tok) ? 1 : 0); }
    const [lo, hi] = fyRange(y, sm);
    return new Span(`FY${y}`, lo, hi, known ? 0.9 : 0.55, 'abs', null, !!yt);
  };
  add('\\b(?:fy\\s?(\\d{4}|\\d{2})\\b|fiscal\\s+year\\s+(\\d{4})|(?:(this|last|previous|prior|current)\\s+)?fiscal\\s+year\\b)', h_fy);
  const h_month = (m, mname, ytok, which, md) => {
    const mo = MON[mname.toLowerCase().replace(/\.+$/, '')];
    let [y, ex] = yearTok(ytok, t); let conf = 0.95;
    if (y === null) {
      if (which === 'last') { y = mo < dM(t) ? dY(t) : dY(t) - 1; conf = 0.85; }
      else if (which === 'this') { y = dY(t); conf = 0.9; }
      else if (which === 'next') { y = mo > dM(t) ? dY(t) : dY(t) + 1; conf = 0.8; }
      else { y = mo <= dM(t) ? dY(t) : dY(t) - 1; conf = 0.7; }
    }
    let [lo, hi] = mrange(y, mo); let lab = `${y}-${String(mo).padStart(2, '0')}`;
    if (md) { [lo, hi] = sub(lo, hi, mod(md)); conf = Math.min(conf, 0.75); lab = `${mod(md)} ${lab}`; }
    const alts = (ex || which) ? [] : [mrange(y - 1, mo)];
    return new Span(lab, lo, hi, conf, (ex || ['last', 'this', 'next'].includes(which)) ? 'abs' : 'rel', alts, ex);
  };
  add('\\b(?:' + MODRE + ')?(?:(last|this|next)\\s+)?(' + _MONRE + ')' + '(?:\\s*,?\\s*(?:of\\s+)?(\\d{4}|last year|previous year|prior year|this year|current year|next year))\\b', (m) => h_month(m, m[3], g(m, 4), g(m, 2), g(m, 1)));
  add('\\b(?:' + MODRE + ')(' + _MONRE + ')\\b(?!\\s*\\d{4})', (m) => h_month(m, m[2], null, null, g(m, 1)));
  const h_lnm = (m) => {
    const w = m[1].toLowerCase(); const nm = m[2].toLowerCase().replace(/\.+$/, '');
    if (nm === 'may' && (w === 'this' || w === 'next')) return null;
    return h_month(m, m[2], null, (w === 'last' || w === 'previous') ? 'last' : w, null);
  };
  add('\\b(last|this|next|previous)\\s+(' + _MONRE + ')\\b(?!\\s*\\d)', h_lnm);
  add('(?:(?<=\\bin )|(?<=\\bduring )|(?<=\\bsince )|(?<=\\bthrough )|(?<=\\buntil )|(?<=\\bbefore )|(?<=\\bafter )|(?<=\\bby )|(?<=\\bfrom )|(?<=\\bto )|(?<=\\bfor )|(?<=\\bof )|(?<=\\bbetween )|(?<=\\band )|(?<=\\bthru )|(?<=\\bin the month of ))(' + _MONRE + ')\\b(?!\\s*,?\\s*(?:of\\s+)?\\d{4})(?!\\s+\\d)', (m) => h_month(m, m[1], null, null, null));
  const h_season = (m, pre, name, yr) => {
    name = name.toLowerCase(); pre = (pre || '').toLowerCase().trim(); let y, conf;
    if (yr) { y = parseInt(yr, 10); conf = name === 'winter' ? 0.5 : 0.65; }
    else if (['last', 'previous', 'past'].includes(pre)) { const y0 = recentSeasonYear(name, t); const [, hi0] = seasonRange(name, y0); y = dcmp(hi0, t) >= 0 ? y0 - 1 : y0; conf = 0.62; }
    else if (pre === 'this') { y = name !== 'winter' ? dY(t) : (dM(t) <= 2 ? dY(t) - 1 : dY(t)); conf = 0.62; }
    else { y = recentSeasonYear(name, t); conf = 0.55; }
    const [lo, hi] = seasonRange(name, y);
    return new Span(`${name} ${y}`, lo, hi, conf, yr ? 'abs' : 'rel', null, !!yr);
  };
  const h_season2 = (m) => {
    const pre = g(m, 1), name = m[2].toLowerCase(), yr = g(m, 3);
    if (name === 'fall' && !(pre || yr || /(?:in|during|since|of|the|through|until|before|after|by|this|last)\s+$/.test(m.input.slice(Math.max(0, m.index - 12), m.index)))) return null;
    return h_season(m, pre, name, yr);
  };
  add('\\b(?:(this|last|previous|past)\\s+)?(spring|summer|fall|autumn|winter)\\b(?:\\s+(?:of\\s+)?(\\d{4}))?', h_season2);
  const h_pos = (m) => {
    const w0 = { last: 'last', previous: 'last', prior: 'last', this: 'this', current: 'this' }[m[2].toLowerCase()];
    let [, lo, hi] = periodRanges(m[3].toLowerCase(), w0, t);
    if (['this', 'current'].includes(m[2].toLowerCase())) {
      if (m[3].toLowerCase() === 'month') hi = replace(t, { day: _eom(dY(t), dM(t)) });
      else if (m[3].toLowerCase() === 'quarter') { const q0 = fdiv(dM(t) - 1, 3) * 3 + 1; hi = addDays(addMonths(replace(t, { month: q0, day: 1 }), 3), -1); }
      else if (m[3].toLowerCase() === 'year') hi = D(dY(t), 12, 31);
    }
    const [a, b] = sub(lo, hi, mod(m[1]));
    return new Span(`${mod(m[1])} of ${m[2].toLowerCase()} ${m[3].toLowerCase()}`, a, b, 0.7, 'rel');
  };
  add('\\b' + MODRE + '(?:of\\s+)?(?:the\\s+)?(last|previous|prior|this|current)\\s+(month|quarter|year)\\b', h_pos);
  add('\\b(early|late|mid|end of|start of|beginning of|the end of|the start of|the beginning of)\\s+(?:the\\s+)?(?:of\\s+)?(year)\\b(?!\\s+\\d)', (m) => { const [a, b] = sub(D(dY(t), 1, 1), D(dY(t), 12, 31), mod(m[1])); return new Span(`${mod(m[1])} ${dY(t)}`, a, b, 0.6, 'rel'); });
  add('\\b(?:ytd|year[- ]to[- ]date|so far this year)\\b', () => new Span('this year', D(dY(t), 1, 1), t, 0.95));
  add('\\b(?:mtd|month[- ]to[- ]date|so far this month)\\b', () => new Span('this month', replace(t, { day: 1 }), t, 0.95));
  add('\\b(?:qtd|quarter[- ]to[- ]date|so far this quarter)\\b', () => new Span('this quarter', replace(t, { month: fdiv(dM(t) - 1, 3) * 3 + 1, day: 1 }), t, 0.95));
  const h_win = (m) => {
    const [n, pen] = count(m[2].toLowerCase().trim()); const u = m[3].toLowerCase(); if (n === null) return null;
    let lo;
    if (u === 'day') lo = addDays(t, -n); else if (u === 'week') lo = addDays(t, -7 * n); else if (u === 'month') lo = addMonths(t, -n); else if (u === 'quarter') lo = addMonths(t, -3 * n); else lo = addMonths(t, -12 * n);
    let conf = (/^\p{Nd}+$/u.test(m[2].trim()) ? 0.95 : 0.85) - pen;
    if (['trailing', 'rolling'].includes(m[1].toLowerCase())) conf = /^\p{Nd}+$/u.test(m[2].trim()) ? Math.max(conf, 0.9) : conf;
    return new Span(u === 'day' ? 'past n days' : `past ${n} ${u}s`, lo, t, conf, 'rel');
  };
  add('\\b(past|last|previous|prior|trailing|preceding|rolling)\\s+' + NUMRE + '\\s+(day|week|month|quarter|year)s?\\b', h_win);
  add('\\b(?:ttm|trailing twelve months)\\b', () => new Span('past 12 months', addMonths(t, -12), t, 0.9));
  const h_pastunit = (m, conf = 0.65) => {
    const u = m[1].toLowerCase(); const lo = { week: addDays(t, -7), month: addMonths(t, -1), year: addMonths(t, -12), quarter: addMonths(t, -3) }[u];
    return new Span(`past ${u}`, lo, t, conf, 'rel', [periodRanges(u, 'last', t).slice(1)]);
  };
  const h_lastunit = (m) => {
    const u = m[1].toLowerCase(); const r = periodRanges(u, 'last', t); const lo = { week: addDays(t, -7), month: addMonths(t, -1), quarter: addMonths(t, -3) }[u];
    return new Span(r[0], r[1], r[2], 0.85, 'rel', [[lo, t]]);
  };
  add('\\b(?:in|over|within|during|for)\\s+the\\s+last\\s+(week|month|quarter)\\b', h_lastunit);
  add('\\b(?:in|over|within|during|for)\\s+the\\s+past\\s+(week|month|quarter)\\b', (m) => h_pastunit(m));
  add('\\b(?:in|over|within|during|for)\\s+the\\s+(?:past|last)\\s+year\\b', () => new Span('last year', D(dY(t) - 1, 1, 1), D(dY(t) - 1, 12, 31), 0.8, 'rel', [[addMonths(t, -12), t]]));
  add('\\bpast\\s+(week|month|quarter|year)\\b', (m) => h_pastunit(m));
  const h_ago = (m) => {
    const w = m[1].toLowerCase().trim(); const [n, pen] = count(w); if (n === null) return null;
    const u = m[2].toLowerCase(); const conf = 0.8 - 2 * pen;
    if (u === 'day') { const d = addDays(t, -n); return new Span(`${n} days ago`, d, d, conf + 0.1, 'rel'); }
    if (u === 'week') { const d = addDays(t, -7 * n); const mon = addDays(d, -weekday(d)); return new Span(`${n} weeks ago`, mon, addDays(mon, 6), conf - 0.05, 'rel'); }
    if (u === 'month') { const d = addMonths(t, -n); const [lo, hi] = mrange(dY(d), dM(d)); return new Span(`${n} months ago`, lo, hi, conf - 0.05, 'rel', [[addMonths(t, -n - 1), addMonths(t, -n + 1)]]); }
    if (u === 'quarter') { const d = addMonths(t, -3 * n); const [lo, hi] = qrange(dY(d), qof(d)); return new Span(`${n} quarters ago`, lo, hi, conf - 0.05, 'rel'); }
    const y = dY(t) - n; return new Span(`${n} years ago`, D(y, 1, 1), D(y, 12, 31), conf - 0.05, 'rel');
  };
  add('\\b' + NUMRE + '\\s+(day|week|month|quarter|year)s?\\s+(?:ago|back|earlier|prior)\\b', h_ago);
  const h_unit = (m) => {
    let w = m[1].toLowerCase(); w = { previous: 'last', prior: 'last', current: 'this' }[w] || w;
    const r = periodRanges(m[2].toLowerCase(), w, t);
    const sp = new Span(r[0], r[1], r[2], w !== 'next' ? 1.0 : 0.85, 'rel');
    sp.soft = (w === 'next') || (w === 'this' && m[2].toLowerCase() === 'week');
    return sp;
  };
  add('\\b(this|last|previous|prior|current|next)\\s+(?:calendar\\s+)?(month|year|quarter|week)\\b', h_unit);
  add('\\b(?:in|during|from|for)\\s+the\\s+(previous|prior)\\s+(month|year|quarter|week)\\b', (m) => { const r = periodRanges(m[2].toLowerCase(), 'last', t); return new Span(r[0], r[1], r[2], 1.0); });
  add('\\b(?:in|during|for)\\s+the\\s+(current)\\s+(month|year|quarter|week)\\b', (m) => { const r = periodRanges(m[2].toLowerCase(), 'this', t); return new Span(r[0], r[1], r[2], 1.0); });
  return R;
}
const DIRRE = /(since|after|before|prior to|until|through|thru|up to|as of|by)\s+(?:the\s+(?:start|end|beginning)\s+of\s+|the\s+)?$/;
const overlapsAny = (taken, a, b) => taken.some(([x, y]) => !(b <= x || a >= y));
export function resolveDates(text, today) {
  const t = typeof today === 'string' ? fromIso(today) : today;
  const ql = text.toLowerCase().replace(/’/g, "'");
  const taken = []; let out = [];
  for (const [rx, fn] of rules(t)) {
    rx.lastIndex = 0;
    for (const m of ql.matchAll(rx)) {
      const a = m.index, b = m.index + m[0].length;
      if (overlapsAny(taken, a, b)) continue;
      let sp; try { sp = fn(m); } catch (e) { sp = null; }
      if (sp === null || sp === undefined) continue;
      sp.start = a; sp.end = b; taken.push([a, b]); out.push(sp);
    }
  }
  out = out.map((s, i) => [s, i]).sort((x, y) => x[0].start - y[0].start || x[1] - y[1]).map((z) => z[0]);
  const merged = []; let i = 0;
  while (i < out.length) {
    const s = out[i];
    if (i + 1 < out.length) {
      const n = out[i + 1]; const gap = ql.slice(s.end, n.start); const pre = ql.slice(Math.max(0, s.start - 9), s.start);
      if (/^\s*(?:and|to|through|thru|until|-|–)\s*$/.test(gap) && /(between|from)\s*$/.test(pre)) {
        let shifted = false;
        if (n.year_explicit && !s.year_explicit && isDate(s.lo)) {
          try { const slo = replace(s.lo, { year: dY(n.lo) }); const shi = replace(s.hi, { year: dY(n.hi) === dY(n.lo) ? dY(n.hi) : dY(n.lo) }); s.lo = slo; s.hi = shi; shifted = true; } catch (e) { if (!(e instanceof PyValueError)) throw e; }
        }
        const lo = dcmp(s.lo, n.lo) <= 0 ? s.lo : n.lo; const hi = dcmp(s.hi, n.hi) >= 0 ? s.hi : n.hi;
        const ms = new Span(`${s.label} to ${n.label}`, lo, hi, shifted ? n.conf * 0.95 : Math.min(s.conf, n.conf), 'abs', null, s.year_explicit && n.year_explicit);
        ms.start = s.start; ms.end = n.end; merged.push(ms); i += 2; continue;
      }
    }
    merged.push(s); i += 1;
  }
  const res = [];
  for (const s of merged) {
    const m = DIRRE.exec(ql.slice(Math.max(0, s.start - 24), s.start));
    if (m && s.kind !== 'open') {
      const w = m[1]; const lo = s.lo, hi = s.hi;
      if (w === 'since') { s.lo = lo; s.hi = OPEN_HI; }
      else if (w === 'after') { s.lo = isDate(hi) ? addDays(hi, 1) : hi; s.hi = OPEN_HI; }
      else if (w === 'before' || w === 'prior to') { s.lo = OPEN_LO; s.hi = isDate(lo) ? addDays(lo, -1) : lo; }
      else { s.lo = OPEN_LO; s.hi = hi; }
      s.label = `${w} ${s.label}`; s.kind = 'open';
      if (m.index + Math.max(0, s.start - 24) < s.start) s.start = Math.max(0, s.start - 24) + m.index;
    }
    res.push(s);
  }
  return res;
}
// ---------------------------------------------------------------- numbers / money
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MAG = { thousand: 1e3, million: 1e6, billion: 1e9 };
export function wordsToNumber(s) {
  s = s.toLowerCase().trim();
  const mh = /^half\s+an?\s+(thousand|million|billion)$/.exec(s);
  if (mh) return MAG[mh[1]] / 2;
  let total = 0, cur = 0, seen = false;
  for (const tk of s.split(/[\s-]+/)) {
    if (tk === '' || tk === 'and') continue;
    if (tk === 'a' || tk === 'an') cur += 1;
    else if (has(ONES, tk)) { cur += ONES[tk]; seen = true; }
    else if (has(TENS, tk)) { cur += TENS[tk]; seen = true; }
    else if (tk === 'hundred') { cur = Math.max(cur, 1) * 100; seen = true; }
    else if (has(MAG, tk)) { total += Math.max(cur, 1) * MAG[tk]; cur = 0; seen = true; }
    else return null;
  }
  return seen ? total + cur : null;
}
const WN = [...Object.keys(ONES), ...Object.keys(TENS), 'hundred', 'thousand', 'million', 'billion'].map((w, i) => [w, i]).sort((a, b) => b[0].length - a[0].length || a[1] - b[1]).map((z) => z[0]).join('|');
export const WORDNUM = '(?:half\\s+an?\\s+(?:thousand|million|billion)|(?:an?\\s+(?=hundred|thousand|million|billion))?\\b(?:' + WN + ')\\b(?:[\\s-]+(?:and[\\s-]+)?\\b(?:' + WN + ')\\b)*)';
const UNIT = { k: 1e3, thousand: 1e3, grand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, hundred: 1e2 };
const NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const AMT = new RegExp('(?<neg>\\(|-\\s?)?(?<cur>\\$\\s?|usd\\s?|us\\$\\s?)?(?<num>' + NUM + ')(?:(?<sp>\\s?)(?<unit>k|thousand|grand|mm|million|mil|billion|bn|m|b|hundred)(?![a-z]))?(?<dol>\\s?(?:dollars?|bucks|usd)\\b)?(?<close>\\))?', 'gi');
const WAMT = new RegExp('(?<cur>\\$\\s?)?(?<w>' + WORDNUM + ')(?<dol>\\s+(?:dollars?|bucks|usd)\\b)?', 'gi');
export class Amt { constructor(value, start, end, conf, raw, hasCur, hasUnit, unit = null) { this.value = value; this.start = start; this.end = end; this.conf = conf; this.raw = raw; this.has_cur = hasCur; this.has_unit = hasUnit; this.unit = unit; } }
export function findAmounts(text, loose = false) {
  const out = []; const taken = [];
  for (const m of text.matchAll(AMT)) {
    const G = m.groups; const raw = m[0]; const num = G.num; let unit = (G.unit || '').toLowerCase(); const cur = !!(G.cur || G.dol);
    if (['m', 'b', 'mm', 'bn'].includes(unit) && G.sp && !cur) unit = '';
    const a = m.index, b = m.index + raw.length;
    if (a > 0 && (isAlnum(text[a - 1]) && !G.cur && !G.neg)) continue;
    if (b < text.length && isAlpha(text.slice(b, b + 1)) && !unit) continue;
    if (/^\s?[-/]\d/.test(text.slice(b, b + 2)) && !cur) continue;
    if (!(cur || unit || loose)) continue;
    let v = parseFloat(num.replace(/,/g, '')); if (Number.isNaN(v)) continue;
    if (unit) v *= UNIT[unit];
    let neg = !!G.neg && (G.neg.trim() === '-' || G.close === ')');
    if (G.neg === '(' && !G.close) neg = false;
    if (neg) v = -v;
    if (G.neg && G.neg.trim() === '-' && a > 0 && !/\s/.test(text[a - 1]) && !'(:'.includes(text[a - 1])) { v = Math.abs(v); neg = false; }
    if (/^(?:19|20)\d\d$/.test(num) && !(cur || unit)) continue;
    const st = !(G.neg === '(' && !G.close) ? a : a + 1;
    out.push(new Amt(v, st, b, 1.0, raw.trim(), cur, !!unit, unit || null)); taken.push([a, b]);
  }
  for (const m of text.matchAll(WAMT)) {
    const a = m.index, b = m.index + m[0].length;
    if (overlapsAny(taken, a, b)) continue;
    const w = m.groups.w; const v = wordsToNumber(w); if (v === null) continue;
    const hasMag = /hundred|thousand|million|billion/.test(w.toLowerCase());
    if (!(hasMag || m.groups.cur || m.groups.dol) && !loose) continue;
    if (/^\s*(?:an?|one)\s*$/i.test(w) && !(m.groups.cur || m.groups.dol)) continue;
    out.push(new Amt(Number(v), a, b, 0.9, m[0].trim(), !!(m.groups.cur || m.groups.dol), hasMag, null));
  }
  return out.map((x, i) => [x, i]).sort((x, y) => x[0].start - y[0].start || x[1] - y[1]).map((z) => z[0]);
}
export function parseAmount(s, loose = true) {
  s = (s || '').trim(); if (!s) return null;
  const s2 = s.replace(/\s*(?:cr|dr)\.?$/i, '');
  const a = findAmounts(s2, loose); if (a.length !== 1) return null;
  const x = a[0]; const rest = strip((s2.slice(0, x.start) + s2.slice(x.end)), ' .:,');
  if (rest && !/^(?:total|amount|usd|dollars?|about|approx\.?|approximately|~)?$/i.test(rest)) return null;
  return x.value;
}
function strip(s, chars) { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); }
// ---------------------------------------------------------------- comparisons
const OPS = [
  ['ge', 'at\\s+least|no\\s+less\\s+than|not\\s+less\\s+than|(?:a\\s+)?minimum\\s+of|minimum|min\\.?|>=|≥|(?:greater|more|higher)\\s+than\\s+or\\s+equal\\s+to|equal\\s+to\\s+or\\s+(?:more|greater|higher)\\s+than'],
  ['le', 'at\\s+most|no\\s+more\\s+than|not\\s+more\\s+than|up\\s+to|(?:a\\s+)?maximum\\s+of|maximum|max\\.?|capped\\s+at|<=|≤|(?:less|lower|fewer)\\s+than\\s+or\\s+equal\\s+to|equal\\s+to\\s+or\\s+(?:less|lower|fewer)\\s+than|not\\s+(?:to\\s+)?exceed(?:ing)?'],
  ['gt', 'over|above|more\\s+than|greater\\s+than|exceeding|exceeds?|in\\s+excess\\s+of|north\\s+of|higher\\s+than|bigger\\s+than|larger\\s+than|beyond|>'],
  ['lt', 'under|below|less\\s+than|lower\\s+than|fewer\\s+than|smaller\\s+than|beneath|shy\\s+of|<'],
  ['about', 'around|about|roughly|approximately|approx\\.?|~|close\\s+to|circa|nearly|almost'],
  ['eq', 'exactly|equal\\s+to|equals?'],
];
const OPRE = new RegExp('(?<![\\w])(?<op>' + OPS.map(([k, v]) => `(?<${k}>${v})`).join('|') + ')(?![a-z])\\s*(?:of\\s+)?', 'gi');
export class Cmp {
  constructor(op, lo, hi, loIncl, hiIncl, conf, start, end, text = '') { this.op = op; this.lo = lo; this.hi = hi; this.lo_incl = loIncl; this.hi_incl = hiIncl; this.conf = conf; this.start = start; this.end = end; this.text = text; }
  ok(v) {
    if (v === null || v === undefined) return false;
    if (this.lo !== null && (v < this.lo || (v === this.lo && !this.lo_incl))) return false;
    if (this.hi !== null && (v > this.hi || (v === this.hi && !this.hi_incl))) return false;
    return true;
  }
  desc() {
    const f = (x) => (Math.abs(x - pyRoundInt(x)) < 1e-9 ? '$' + fmtNumD(x, 0) : '$' + fmtNumD(x, 2));
    if (this.lo !== null && this.hi !== null) return `between ${f(this.lo)} and ${f(this.hi)}`;
    if (this.lo !== null) return `${this.lo_incl ? 'at least' : 'over'} ${f(this.lo)}`;
    return `${this.hi_incl ? 'at most' : 'under'} ${f(this.hi)}`;
  }
}
import { fmtNum as fmtNumD, pyRound as pyRoundInt } from './pyc.js';
const AMTX = '(?:\\$\\s?|usd\\s?)?(?:' + NUM + '(?:\\s?(?:k|thousand|grand|mm|million|mil|billion|bn|m|b)(?![a-z]))?|' + WORDNUM + ')(?:\\s?(?:dollars?|bucks|usd)\\b)?';
const BETW_SRC = '(?:between|from)\\s+(?<a>' + AMTX + ')\\s*(?:and|to|through|thru|-|–|—)\\s*(?<b>' + AMTX + ')';
const BETW = new RegExp(BETW_SRC, 'gi'); const BETW_Y = new RegExp(BETW_SRC, 'iy');
const DASH = new RegExp('(?<![\\w$.,/-])(?<a>\\$?\\s?' + NUM + '(?:\\s?(?:k|m|mm|mil|million|thousand))?)\\s*(?:-|–|—|to)\\s*(?<b>\\$?\\s?' + NUM + '\\s?(?:k|m|mm|mil|million|thousand)(?![a-z])|\\$\\s?' + NUM + ')(?![\\w/-])', 'gi');
const one = (s) => { const a = findAmounts(s.trim(), true); return a.length >= 1 ? a[0] : null; };
function between(sa, sb) {
  let A = one(sa); const B = one(sb); if (A === null || B === null) return null;
  let conf = 1.0;
  if (!(A.has_cur || A.has_unit || B.has_cur || B.has_unit)) return null;
  if (!A.has_unit && B.has_unit && B.unit && A.value < B.value / UNIT[B.unit] && A.value >= 1) {
    A = new Amt(A.value * UNIT[B.unit], A.start, A.end, 0.9, A.raw, A.has_cur, true, B.unit); conf = !A.has_cur ? 0.9 : 0.85;
  }
  const [lo, hi] = [A.value, B.value].sort((x, y) => x - y);
  return [lo, hi, conf];
}
const POSTFIX = new RegExp('(?<a>' + AMTX + ')\\s*(?:(?<plus>\\+)|(?<more>or\\s+more|or\\s+greater|or\\s+higher|and\\s+(?:up|above|over))|(?<less>or\\s+less|or\\s+under|or\\s+lower|and\\s+(?:under|below)))', 'gi');
export function parseComparisons(text) {
  const ql = text.toLowerCase().replace(/’/g, "'"); const out = []; const taken = [];
  const free = (a, b) => !overlapsAny(taken, a, b);
  for (const m of ql.matchAll(BETW)) {
    const r = between(m.groups.a, m.groups.b); const a = m.index, b = m.index + m[0].length;
    if (r && free(a, b)) { out.push(new Cmp('between', r[0], r[1], true, true, r[2], a, b, m[0])); taken.push([a, b]); }
  }
  for (const m of ql.matchAll(DASH)) {
    const a = m.index, b = m.index + m[0].length;
    if (!free(a, b)) continue;
    const r = between(m.groups.a, m.groups.b);
    if (r) { out.push(new Cmp('between', r[0], r[1], true, true, r[2] * 0.95, a, b, m[0])); taken.push([a, b]); }
  }
  for (const m of ql.matchAll(OPRE)) {
    const a0 = m.index; const mend = m.index + m[0].length;
    const kind = OPS.find(([k]) => m.groups[k])[0];
    const rest = ql.slice(mend);
    const mm = /^(?:about|around|roughly|approximately)\s+/.exec(rest); const off = mm ? mm[0].length : 0;
    const pa = new RegExp('^(?:' + AMTX + ')', 'i').exec(rest.slice(off));
    if (!pa) continue;
    const A = one(pa[0]);
    if (A === null || !(A.has_cur || A.has_unit)) continue;
    const b0 = mend + off + pa[0].length;
    if (!free(a0, b0)) continue;
    if (/^\s*(?:and|to|-|–)\s*\$?\d/.test(ql.slice(b0)) && (kind === 'gt' || kind === 'ge')) { BETW_Y.lastIndex = a0 >= 8 ? a0 - 8 : 0; if (BETW_Y.exec(ql)) continue; }
    const v = A.value; const conf = A.conf; let c;
    if (kind === 'ge') c = new Cmp('ge', v, null, true, true, conf, a0, b0);
    else if (kind === 'gt') c = new Cmp('gt', v, null, false, true, conf, a0, b0);
    else if (kind === 'le') c = new Cmp('le', null, v, true, true, conf, a0, b0);
    else if (kind === 'lt') c = new Cmp('lt', null, v, true, false, conf, a0, b0);
    else if (kind === 'eq') c = new Cmp('eq', v, v, true, true, conf, a0, b0);
    else c = new Cmp('about', v * 0.9, v * 1.1, true, true, Math.min(conf, 0.5), a0, b0);
    c.text = ql.slice(a0, b0); out.push(c); taken.push([a0, b0]);
  }
  for (const m of ql.matchAll(POSTFIX)) {
    const a = m.index, b = m.index + m[0].length;
    if (!free(a, b)) continue;
    const A = one(m.groups.a);
    if (A === null || !(A.has_cur || A.has_unit)) continue;
    if (m.groups.less) out.push(new Cmp('le', null, A.value, true, true, A.conf, a, b, m[0]));
    else out.push(new Cmp('ge', A.value, null, true, true, A.conf, a, b, m[0]));
    taken.push([a, b]);
  }
  return out.map((c, i) => [c, i]).sort((x, y) => x[0].start - y[0].start || x[1] - y[1]).map((z) => z[0]);
}
