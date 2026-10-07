/**
 * Property-management DATA-VARIANT generator (class fix pass). Pure: no database, no lane, no extractor.
 *
 * Each case is a small seeded set of raw records for TWO property-management companies of the SAME trade (A and B: the same vendor,
 * unit and property names, different data), one question, and the truth for each company. The truth is computed from the raw rows
 * by the rules at the top of this file (written from the lane's documented definitions, never by calling product code):
 *
 *   effective value   a human correction wins; an EMPTY correction means cleared; invisible / all Unicode whitespace is nothing; a
 *                     placeholder ("N/A", "-", "TBD") is nothing
 *   live record       customer-audience only; status not cancelled / void / superseded / draft / unsigned / terminated
 *   conflict          two different readings of one single-valued field of a record that matters -> the answer is a DECLINE
 *   near-miss names   two vendor names one or two letters apart (or one is the other plus words) -> a DECLINE for those vendors
 *   money             vendor bills only (a receivable invoice is not owed or spent); USD only; a partly paid invoice counts its balance;
 *                     a credit memo -> DECLINE; void invoices are not counted; cents are exact
 *
 * An expectation is { n } (the leading number), { money }, { has:[...] } (words that must all appear), { decline:true } (the lane
 * must NOT answer), plus { not:[...] } words that must not appear. A declined answer is always acceptable for n / money / has
 * (the runner counts those as "left to the model" and asserts a floor); a WRONG answer never is.
 */
import { TODAY, long, addDays } from './property-fixtures.mjs';

export { TODAY };

/* ------------------------------------------------------------------ seeded random */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const shuffle = (arr) => { const x = [...arr]; for (let i = x.length - 1; i > 0; i--) { const j = int(0, i); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  return { next, int, pick, shuffle };
}

/* ------------------------------------------------------------------ names (invented; no lane vocabulary inside them) */
const V_PRE = ['Zephyr', 'Kestrel', 'Marlow', 'Quillon', 'Tamarack', 'Brindle', 'Corvin', 'Halden', 'Ostrander', 'Pellam', 'Rushmore', 'Sablewood', 'Thistle', 'Vantage', 'Wexford', 'Yarrow', 'Ashgrove', 'Belmont', 'Calloway', 'Dunmore', 'Fenwick', 'Garrity', 'Holloway', 'Ironwood', 'Jessamy', 'Kingsley', 'Lockwood', 'Montrose', 'Nettleton', 'Pinecrest'];
const V_SUF = ['Plumbing', 'Roofing', 'Electric', 'Elevator', 'Landscaping', 'Pest Control', 'Cleaning', 'Paving', 'Glass', 'Fencing'];
const P_PRE = ['Saguaro Ridge', 'Cactus Flats', 'Pine Villas', 'Copper Mesa', 'Willow Bend', 'Juniper Court', 'Agave Terrace', 'Mesquite Park', 'Sunset Arbor', 'Coyote Run'];
const STREETS = ['Alder St', 'Birch Ave', 'Cedar Rd', 'Dogwood Ln', 'Elm Dr', 'Fir Way', 'Gum Blvd', 'Hazel Ct', 'Ivy Pl', 'Juniper Cir'];
const FIRST = ['Alma', 'Bruno', 'Carla', 'Dario', 'Esme', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kira', 'Leon', 'Mira', 'Nico', 'Olga', 'Pablo'];
const LAST = ['Arden', 'Bexley', 'Cortez', 'Dunbar', 'Ekman', 'Farrow', 'Gallo', 'Hartwell', 'Ibarra', 'Jarvis', 'Kessler', 'Lindqvist', 'Moreau', 'Navarro', 'Oakes', 'Pruitt'];
const SUFF = ['LLC', 'Inc', 'Co', 'Services'];

/* ------------------------------------------------------------------ record model */
/** a raw record: { type, f:[[key, value, correction?]], aud?, fin? }.  correction === '' means a human CLEARED the field. */
export const rec = (type, f, extra = {}) => ({ type, f, ...extra });

/* ------------------------------------------------------------------ truth rules (independent of product code) */
const INVIS = /[​-‍⁠᠎﻿]/g;
const PLACEHOLDER = /^(?:n\/?a|none|null|nil|tbd|tba|unknown|undefined|[-–—.?]+)$/i;
const tidy = (s) => String(s).replace(INVIS, '').replace(/[\s\u0085]+/g, ' ').trim();
/** every effective reading of a key on a record, after corrections / cleaning (empty ones removed) */
export const readings = (r, k) => r.f.filter((x) => x[0] === k).map((x) => (x[2] !== undefined ? x[2] : x[1])).map((v) => tidy(v ?? '')).filter((v) => v !== '' && !PLACEHOLDER.test(v));
export const monthDay = (s) => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s; };
const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s) ? monthDay(s) : null);
/** one single-valued reading: {ok, v} | {none} | {conflict} */
export const one = (r, k, map = (x) => x.toLowerCase()) => { const v = readings(r, k); const d = [...new Set(v.map(map))]; return d.length === 0 ? { none: true } : d.length === 1 ? { ok: true, v: v[0] } : { conflict: true }; };
export const live = (r) => (r.aud ?? 'customer') !== 'internal';
const DEADWORD = /\b(?:cancel+ed|canceled|void(?:ed)?|superseded|rescinded|revoked|withdrawn|replaced|draft|unsigned|terminated)\b/i;
export const dead = (r) => readings(r, 'status').some((s) => DEADWORD.test(s));
/** a vendor's identity: lower case, punctuation gone, legal suffixes and a trailing "services" dropped */
export const vkey = (name) => { const t = tidy(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !/^(?:llc|inc|corp|co|company|ltd|lp|llp)$/.test(w)); while (t.length > 1 && /^(?:service|services)$/.test(t[t.length - 1])) t.pop(); return t.join(' '); };
const ed = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
/** two different vendor keys that may be one company */
export const nearNames = (a, b) => a !== b && ((a.length >= 5 && b.length >= 5 && ed(a, b) <= (Math.min(a.length, b.length) >= 9 ? 2 : 1)) || (() => { const x = a.split(' '); const y = b.split(' '); const [s, l] = x.length <= y.length ? [x, y] : [y, x]; return s.length < l.length && s.every((t) => l.includes(t)); })());
const hasNear = (keys) => { const k = [...new Set(keys)]; for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (nearNames(k[i], k[j])) return true; return false; };
const addMonths = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, dim))).toISOString().slice(0, 10); };
void addMonths;

/** the vendor certificates of a company: per vendor the current expiry; or UNSURE */
export function coiTruth(rows) {
  const by = new Map();
  for (const r of rows.filter((x) => x.type === 'certificate_of_insurance' && live(x))) {
    const v = one(r, 'vendor', vkey); if (v.none) continue;
    if (v.conflict) return { unsure: 'vendor conflict' };
    const k = vkey(v.v); (by.get(k) ?? by.set(k, { name: v.v, docs: [] }).get(k)).docs.push(r);
  }
  if (hasNear([...by.keys()])) return { unsure: 'near names' };
  const out = new Map();
  for (const [k, g] of by) {
    let best = null; let bad = false;
    for (const r of g.docs) {
      if (dead(r)) bad = true;
      let e = one(r, 'coi_expires', (x) => iso(x) ?? x);
      if (e.conflict) bad = true;
      let d = e.ok ? iso(e.v) : null;
      if (!d && e.none) { const p = readings(r, 'policy_expiry').map(iso).filter(Boolean).sort(); if (p.length) d = p[0]; }
      if (d && (!best || d > best)) best = d;
    }
    if (bad) return { unsure: 'dead or conflicting certificate' };
    out.set(k, { name: g.name, exp: best });
  }
  return { vendors: out };
}

export function woTruth(rows) {
  const OPEN = /^(?:open|opened|in progress|scheduled|on hold|pending|assigned|new|waiting|started|dispatched)$/i; const DONE = /^(?:completed?|closed|resolved|done|finished)$/i; const CANC = /^(?:cancel+ed|canceled|void|voided)$/i;
  const by = new Map();
  for (const r of rows.filter((x) => x.type === 'work_order' && live(x))) {
    const no = (readings(r, 'work_order_number')[0] ?? readings(r, 'invoice_number')[0] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const p = (readings(r, 'property_name')[0] ?? '').toLowerCase();
    const k = `${no}|${p}`; (by.get(k) ?? by.set(k, []).get(k)).push(r);
  }
  const wos = [];
  for (const list of by.values()) {
    const cl = (r) => { const s = readings(r, 'status')[0] ?? ''; return CANC.test(s) ? 'cancelled' : DONE.test(s) ? 'done' : OPEN.test(s) ? 'open' : 'other'; };
    const cs = new Set(list.map(cl)); if (cs.size > 1 || [...cs][0] === 'other') return { unsure: 'status' };
    if (list.some((r) => !one(r, 'status').ok && !one(r, 'status').none)) return { unsure: 'status conflict' };
    const last = list[list.length - 1];
    wos.push({ cls: cl(last), prop: (readings(last, 'property_name')[0] ?? '').toLowerCase(), sched: iso(readings(last, 'service_date')[0] ?? '') });
  }
  return { wos };
}

/** vendor bills: { invs:[{vendor, cls, owed, cost, due, receivable, cur}], unsure } */
export function invTruth(rows) {
  const by = new Map(); let unsure = null;
  for (const r of rows.filter((x) => x.type === 'invoice' && live(x))) {
    const no = (readings(r, 'invoice_number')[0] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const v = readings(r, 'vendor')[0] ?? '';
    const k = `${vkey(v)}|${no}`; (by.get(k) ?? by.set(k, []).get(k)).push(r);
  }
  const invs = [];
  for (const list of by.values()) {
    const sig = (r) => `${readings(r, 'cost')[0]}|${(readings(r, 'status')[0] ?? '').toLowerCase()}|${readings(r, 'invoice_due')[0]}`;
    if (new Set(list.map(sig)).size > 1) { unsure = 'copies disagree'; continue; }
    const r = list[list.length - 1];
    if (['cost', 'status', 'invoice_due'].some((k) => one(r, k).conflict)) { unsure = 'field conflict'; continue; }
    const st = (readings(r, 'status')[0] ?? '').toLowerCase(); const fin = r.fin ?? null;
    const costTxt = readings(r, 'cost')[0]; const cost = costTxt != null && /^\d+(?:\.\d+)?$/.test(costTxt.replace(/,/g, '')) ? Number(costTxt.replace(/,/g, '')) : (fin?.total ?? null);
    const due = iso(readings(r, 'invoice_due')[0] ?? '') ?? fin?.due ?? null;
    if (fin && fin.total != null && cost != null && Math.round(fin.total * 100) !== Math.round(cost * 100)) { unsure = 'finance disagrees'; continue; }
    const cls = /^(?:void|voided|cancel+ed|canceled)$/.test(st) ? 'void' : /^paid/.test(st) ? 'paid' : /partial/.test(st) || (fin?.paid > 0 && fin?.balance > 0) ? 'partial' : /unpaid|not paid|open|outstanding|overdue|past due|due|pending/.test(st) ? 'unpaid' : 'other';
    invs.push({ vendor: readings(r, 'vendor')[0], cls, cost, due, receivable: fin?.direction === 'receivable', cur: fin?.currency ?? 'USD', credit: fin?.kind === 'credit_memo' || (cost != null && cost < 0), balance: fin?.balance ?? null });
  }
  return { invs, unsure };
}
const fmtMoney = (n) => `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ------------------------------------------------------------------ expectations */
const within = (d, days) => d >= TODAY && d <= addDays(TODAY, days);

const coiExpiringN = (rows, days) => { const t = coiTruth(rows); if (t.unsure) return { decline: true }; return { n: [...t.vendors.values()].filter((v) => v.exp && within(v.exp, days)).length }; };
const coiExpiredN = (rows) => { const t = coiTruth(rows); if (t.unsure) return { decline: true }; return { n: [...t.vendors.values()].filter((v) => v.exp && v.exp < TODAY).length }; };
const woN = (rows, cls, prop) => { const t = woTruth(rows); if (t.unsure) return { decline: true }; return { n: t.wos.filter((w) => w.cls === cls && (!prop || w.prop === prop.toLowerCase())).length }; };
const unpaidTotal = (rows) => {
  const t = invTruth(rows); if (t.unsure) return { decline: true };
  const bills = t.invs.filter((i) => !i.receivable);
  if (bills.some((i) => i.cur !== 'USD' || i.credit || i.cls === 'other')) return { decline: true };
  const un = bills.filter((i) => i.cls === 'unpaid' || i.cls === 'partial');
  if (un.some((i) => (i.cls === 'partial' ? i.balance == null : i.cost == null))) return { decline: true };
  return { money: un.reduce((s, i) => s + Math.round((i.cls === 'partial' ? i.balance : i.cost) * 100), 0) / 100, has: [`across ${un.length} unpaid invoice`] };
};
const overdueN = (rows) => {
  const t = invTruth(rows); if (t.unsure) return { decline: true };
  const bills = t.invs.filter((i) => !i.receivable);
  if (bills.some((i) => i.credit || i.cls === 'other')) return { decline: true };
  return { n: bills.filter((i) => (i.cls === 'unpaid' || i.cls === 'partial') && i.due && i.due < TODAY).length };
};

/* ------------------------------------------------------------------ record builders */
let seq = 0;
const coi = (vendor, exp, extra = {}, more = []) => rec('certificate_of_insurance', [['vendor', vendor], ['coi_expires', exp], ['coverage_type', 'General Liability'], ...more], extra);
const wo = (no, status, prop, extra = {}, more = []) => rec('work_order', [['work_order_number', no], ['status', status], ['property_name', prop], ['service_date', addDays(TODAY, -3)], ...more], extra);
const inv = (vendor, no, cost, status, due, extra = {}, more = []) => rec('invoice', [['vendor', vendor], ['invoice_number', no], ['cost', cost], ['status', status], ['invoice_due', due], ...more], extra);
const lease = (unit, tenant, start, end, rent, prop, extra = {}, more = []) => rec('lease_agreement', [['unit_number', unit], ['tenant_name', tenant], ['lease_start_date', start], ['lease_end_date', end], ['rent_amount', rent], ['property_name', prop], ...more], extra);
void seq;

/* ------------------------------------------------------------------ the case families */
const WRAP = [(s) => s, (s) => ` ${s} `, (s) => `​${s}​`, (s) => `  ${s}\t`, (s) => ` ${s}`];
const vname = (R, used) => { for (;;) { const n = `${R.pick(V_PRE)} ${R.pick(V_SUF)}`; const k = vkey(n); if (![...used].some((u) => u === k || nearNames(u, k) || u.split(' ')[0] === k.split(' ')[0])) { used.add(k); return `${n} ${R.pick(SUFF)}`; } } };
const rel = (R, lo, hi) => addDays(TODAY, R.int(lo, hi));

/** Each family: (R, tag) -> { name, rowsA, rowsB, question, expect: (rows) => expectation, extraNotWords? } */
const FAMILIES = {
  /* human corrections, alias keys, whitespace, cancelled, conflicting, internal: one vendor's certificate date */
  coiWhen(R) {
    const used = new Set(); const names = [vname(R, used), vname(R, used), vname(R, used)];
    const variant = R.pick(['plain', 'corrected', 'cleared', 'alias', 'space', 'newer', 'internalNewer', 'cancelled', 'conflict', 'usformat']);
    const target = names[0]; const d1 = rel(R, -40, 120); const d2 = rel(R, -40, 120);
    const mk = (d, dd) => {
      const rows = [coi(names[1], addDays(TODAY, R.int(10, 200))), coi(names[2], addDays(TODAY, R.int(-60, 60)))];
      const wrap = variant === 'space' ? R.pick(WRAP.slice(1)) : (s) => s;
      if (variant === 'plain') rows.push(coi(target, d));
      if (variant === 'corrected') rows.push(rec('certificate_of_insurance', [['vendor', target], ['coi_expires', d, dd], ['coverage_type', 'General Liability']]));
      if (variant === 'cleared') rows.push(rec('certificate_of_insurance', [['vendor', target], ['coi_expires', d, ''], ['coverage_type', 'General Liability']]));
      if (variant === 'alias') rows.push(rec('certificate_of_insurance', [['vendor', target], ['policy_expiry', d], ['policy_expiry', addDays(d, 40)], ['coverage_type', 'General Liability']]));
      if (variant === 'space') rows.push(rec('certificate_of_insurance', [['vendor', wrap(target)], ['coi_expires', wrap(d)], ['coverage_type', 'General Liability']]));
      if (variant === 'newer') { rows.push(coi(target, d)); rows.push(coi(target, dd > d ? dd : addDays(d, -90))); }
      if (variant === 'internalNewer') { rows.push(coi(target, d)); rows.push(coi(target, addDays(d, 200), { aud: 'internal' })); }
      if (variant === 'cancelled') { rows.push(coi(target, d)); rows.push(coi(target, addDays(d, 100), {}, [['status', 'Cancelled']])); }
      if (variant === 'conflict') rows.push(rec('certificate_of_insurance', [['vendor', target], ['coi_expires', d], ['coi_expires', dd], ['coverage_type', 'General Liability']]));
      if (variant === 'usformat') { const [y, m, dy] = d.split('-'); rows.push(coi(target, `${Number(m)}/${Number(dy)}/${y}`)); }
      return rows;
    };
    const dA = d1; const ddA = d2; const dB = rel(R, -40, 120); const ddB = rel(R, -40, 120);
    const q = R.pick([`When does ${target}'s COI expire?`, `What is the expiration date on the ${target} certificate of insurance?`, `Is ${target} insured?`]);
    return { name: `coiWhen:${variant}`, rowsA: mk(dA, ddA), rowsB: mk(dB, ddB), question: q, expect: (rows) => {
      const t = coiTruth(rows); if (t.unsure) return { decline: true };
      const v = t.vendors.get(vkey(target)); if (!v) return { decline: true };
      if (!v.exp) return { decline: true };
      return { has: [long(v.exp)] };
    } };
  },

  coiWindow(R) {
    const used = new Set(); const n = R.int(4, 8); const names = Array.from({ length: n }, () => vname(R, used));
    const variant = R.pick(['plain', 'boundary', 'corrections', 'dupes', 'internal', 'near', 'dead', 'alias', 'expired']);
    const phr = R.pick(['count', 'count', 'which', 'any', 'list', 'soon', 'areThere']);
    const days = phr === 'soon' ? 60 : R.pick([7, 14, 30, 45, 60, 90]);
    const mk = () => {
      const rows = [];
      names.forEach((nm, i) => {
        let d = addDays(TODAY, R.int(-90, 150));
        if (variant === 'boundary') d = addDays(TODAY, [-1, 0, 1, days - 1, days, days + 1, days + 2, 0][i % 8]);
        if (variant === 'corrections' && i % 3 === 0) rows.push(rec('certificate_of_insurance', [['vendor', nm], ['coi_expires', addDays(TODAY, -200), d], ['coverage_type', 'General Liability']]));
        else if (variant === 'corrections' && i === 1) rows.push(rec('certificate_of_insurance', [['vendor', nm], ['coi_expires', d, ''], ['coverage_type', 'General Liability']]));
        else if (variant === 'alias' && i % 2 === 0) rows.push(rec('certificate_of_insurance', [['vendor', nm], ['policy_expiry', d], ['coverage_type', 'General Liability']]));
        else rows.push(coi(nm, d));
        if (variant === 'dupes' && i % 2 === 0) rows.push(coi(nm, addDays(d, -R.int(30, 300))));
        if (variant === 'internal' && i % 2 === 1) rows.push(coi(nm, addDays(TODAY, days - 3), { aud: 'internal' }));
      });
      if (variant === 'near') rows.push(coi(`${names[0].replace(/ (LLC|Inc|Co|Services)$/, '')}s ${R.pick(SUFF)}`.replace('  ', ' '), addDays(TODAY, 5)));
      if (variant === 'dead') rows.push(coi(names[1], addDays(TODAY, 7), {}, [['status', R.pick(['Cancelled', 'Void', 'Superseded'])]]));
      return rows;
    };
    const exp = variant === 'expired';
    const q = exp ? R.pick(['How many vendor COIs are expired?', 'Which vendor COIs have expired?', 'Are any vendor COIs expired?', 'List the expired vendor COIs']) : { count: `How many vendor COIs expire in the next ${days} days?`, which: `Which vendor COIs expire in the next ${days} days?`, any: `Any vendor COIs expiring in the next ${days} days?`, list: `List vendor COIs expiring within ${days} days`, soon: 'Which vendor COIs are expiring soon?', areThere: `Are there any vendor COIs expiring in the next ${days} days?` }[phr];
    return { name: `coiWindow:${variant}:${phr}`, rowsA: mk(), rowsB: mk(), question: q, expect: (rows) => (variant === 'near' ? { decline: true } : exp ? coiExpiredN(rows) : coiExpiringN(rows, days)), listForm: /^Which/.test(q) };
  },

  coiMissing(R) {
    const used = new Set(); const names = Array.from({ length: R.int(4, 7) }, () => vname(R, used));
    const variant = R.pick(['plain', 'internalCoi', 'near', 'dead', 'contractOnly']);
    const mk = () => {
      const rows = [];
      names.forEach((nm, i) => {
        rows.push(inv(nm, `I-${R.int(100, 999)}-${i}`, String(R.int(100, 900)), 'Paid', addDays(TODAY, -20)));
        if (R.next() < 0.6) rows.push(coi(nm, addDays(TODAY, R.int(5, 90)), variant === 'internalCoi' && i === 0 ? { aud: 'internal' } : {}));
      });
      if (variant === 'near') rows.push(inv(`${names[0].replace(/ (LLC|Inc|Co|Services)$/, '')}x ${R.pick(SUFF)}`, 'N-1', '100', 'Paid', addDays(TODAY, -10)));
      if (variant === 'dead') rows.push(coi(names[1], addDays(TODAY, 30), {}, [['status', 'Void']]));
      if (variant === 'contractOnly') rows.push(rec('vendor_contract', [['vendor', vname(R, used)], ['contract_start', addDays(TODAY, -300)], ['contract_end', addDays(TODAY, 60)], ['monthly_amount', '400']]));
      return rows;
    };
    return { name: `coiMissing:${variant}`, rowsA: mk(), rowsB: mk(), question: R.pick(['How many vendors have no COI on file?', 'Which vendors have no COI on file?']), expect: (rows) => {
      if (variant === 'near' || variant === 'dead') return { decline: true };
      const have = new Set(rows.filter((r) => r.type === 'certificate_of_insurance' && live(r)).map((r) => vkey(readings(r, 'vendor')[0] ?? '')));
      const all = new Set(rows.filter((r) => ['certificate_of_insurance', 'invoice', 'work_order', 'vendor_contract'].includes(r.type) && live(r) && readings(r, 'vendor')[0]).map((r) => vkey(readings(r, 'vendor')[0])));
      return { n: [...all].filter((k) => !have.has(k)).length };
    } };
  },

  woCount(R) {
    const props = R.shuffle(P_PRE).slice(0, 2); const variant = R.pick(['plain', 'cancelled', 'dupes', 'aliasNo', 'whitespace', 'conflict', 'internal']);
    const mode = R.pick(['open', 'done']);
    const mk = () => {
      const rows = []; const n = R.int(5, 12);
      for (let i = 0; i < n; i++) {
        const st = R.pick(['Open', 'In Progress', 'Scheduled', 'Completed', 'Closed', 'On Hold']); const p = R.pick(props);
        const no = String(1000 + i);
        if (variant === 'aliasNo' && i % 3 === 0) rows.push(rec('work_order', [['invoice_number', no], ['status', st], ['property_name', p], ['service_date', addDays(TODAY, -2)]]));
        else rows.push(wo(no, variant === 'whitespace' && i % 2 ? ` ${st} ​` : st, p));
        if (variant === 'cancelled' && i % 3 === 1) rows.push(wo(String(5000 + i), R.pick(['Cancelled', 'Canceled', 'Void']), p));
        if (variant === 'dupes' && i % 2 === 0) rows.push(wo(no, st, p));
        if (variant === 'internal' && i % 4 === 0) rows.push(wo(String(7000 + i), 'Open', p, { aud: 'internal' }));
      }
      if (variant === 'conflict') { rows.push(wo('1000', 'Open', props[0])); rows.push(wo('1000', 'Completed', props[0])); }
      return rows;
    };
    const scoped = R.next() < 0.5; const sp = props[0];
    const q = mode === 'open' ? (scoped ? R.pick([`How many open work orders are there at ${sp} Apartments?`, `Which work orders are open at ${sp}?`, `Are there any open work orders at ${sp} Apartments?`]) : R.pick(['How many work orders are open?', 'Which work orders are still open?', 'List the open work orders', 'Are there any open work orders?', 'How many open work orders do we have?'])) : (scoped ? `How many work orders at ${sp} Apartments are completed?` : 'How many work orders are completed?');
    return { name: `woCount:${variant}:${mode}${scoped ? ':scoped' : ''}`, rowsA: mk(), rowsB: mk(), question: q, props: scoped ? [sp] : [], propSuffix: ' Apartments', expect: (rows) => woN(rows, mode, scoped ? sp : null) };
  },

  invTotal(R) {
    const used = new Set(); const names = Array.from({ length: 3 }, () => vname(R, used));
    const variant = R.pick(['plain', 'receivable', 'nonUsd', 'credit', 'partial', 'void', 'resent', 'finDisagree', 'corrected', 'cents', 'finOnly']);
    const mk = () => {
      const rows = []; const n = R.int(4, 8);
      for (let i = 0; i < n; i++) {
        const nm = R.pick(names); const cost = (R.int(500, 90000) / 100).toFixed(2); const st = R.pick(['Unpaid', 'Paid', 'Unpaid', 'Overdue']); const no = `INV-${200 + i}`;
        const due = addDays(TODAY, R.int(-40, 30));
        const fin = (o = {}) => ({ kind: 'invoice', direction: 'payable', currency: 'USD', total: Number(cost), status: /paid/i.test(st) && !/unpaid/i.test(st) ? 'paid' : 'unpaid', due, ...o });
        if (variant === 'receivable' && i % 3 === 0) rows.push(inv(nm, no, cost, 'Unpaid', due, { fin: fin({ direction: 'receivable' }) }));
        else if (variant === 'nonUsd' && i === 0) rows.push(inv(nm, no, cost, 'Unpaid', due, { fin: fin({ currency: 'EUR' }) }));
        else if (variant === 'credit' && i === 0) rows.push(inv(nm, no, `-${cost}`, 'Unpaid', due, { fin: fin({ kind: 'credit_memo', total: -Number(cost) }) }));
        else if (variant === 'partial' && i % 2 === 0) { const bal = Math.round(Number(cost) * 40) / 100; rows.push(inv(nm, no, cost, 'Partial payment', due, { fin: fin({ status: 'partial', paid: Number(cost) - bal, balance: bal }) })); }
        else if (variant === 'void' && i % 3 === 0) rows.push(inv(nm, no, cost, 'Void', due));
        else if (variant === 'finDisagree' && i === 0) rows.push(inv(nm, no, cost, 'Unpaid', due, { fin: fin({ total: Number(cost) + 10, status: 'unpaid' }) }));
        else if (variant === 'corrected' && i % 2 === 0) rows.push(rec('invoice', [['vendor', nm], ['invoice_number', no], ['cost', '1.00', cost], ['status', 'Unpaid'], ['invoice_due', due]]));
        else if (variant === 'cents' && i < 6) rows.push(inv(nm, no, ['0.10', '0.20', '19.99', '0.07', '5.35', '0.01'][i], 'Unpaid', due));
        else if (variant === 'finOnly' && i % 2 === 0) rows.push(rec('invoice', [['vendor', nm], ['invoice_number', no], ['status', 'Unpaid'], ['invoice_due', due]], { fin: fin({ status: 'unpaid' }) }));
        else rows.push(inv(nm, no, cost, st, due));
        if (variant === 'resent' && i % 2 === 0) rows.push(inv(nm, no, cost, st, due));
      }
      return rows;
    };
    const q = R.pick(['What is the total of all unpaid invoices?', 'How much do we owe in unpaid invoices?']);
    return { name: `invTotal:${variant}`, rowsA: mk(), rowsB: mk(), question: q, expect: unpaidTotal };
  },

  invOverdue(R) {
    const used = new Set(); const names = Array.from({ length: 3 }, () => vname(R, used));
    const variant = R.pick(['plain', 'receivable', 'boundary', 'void', 'resent', 'paidLate']);
    const mk = () => {
      const rows = []; const n = R.int(5, 10);
      for (let i = 0; i < n; i++) {
        const nm = R.pick(names); const no = `B-${300 + i}`; const cost = String(R.int(50, 900));
        let due = addDays(TODAY, R.int(-60, 40)); if (variant === 'boundary') due = addDays(TODAY, [-1, 0, 1][i % 3]);
        const fin = (o = {}) => ({ kind: 'invoice', direction: 'payable', currency: 'USD', total: Number(cost), status: 'unpaid', due, ...o });
        if (variant === 'receivable' && i % 2 === 0) rows.push(inv(nm, no, cost, 'Unpaid', due, { fin: fin({ direction: 'receivable' }) }));
        else if (variant === 'void' && i % 3 === 0) rows.push(inv(nm, no, cost, 'Voided', due));
        else if (variant === 'paidLate' && i % 2 === 0) rows.push(inv(nm, no, cost, 'Paid', addDays(TODAY, -30)));
        else rows.push(inv(nm, no, cost, 'Unpaid', due));
        if (variant === 'resent' && i % 2 === 0) rows.push(inv(nm, no, cost, 'Unpaid', due));
      }
      return rows;
    };
    return { name: `invOverdue:${variant}`, rowsA: mk(), rowsB: mk(), question: R.pick(['How many invoices are overdue?', 'How many invoices are past due?', 'Which invoices are overdue?', 'Are there any overdue invoices?', 'List overdue invoices', 'Show me the past due invoices', 'Do we have any late invoices?', 'Any overdue invoices?']), expect: overdueN };
  },

  leaseWindow(R) {
    const props = R.shuffle(P_PRE).slice(0, 2); const variant = R.pick(['plain', 'boundary', 'corrected', 'cleared', 'superseded', 'internal', 'mtm']);
    const days = R.pick([30, 45, 60, 90]);
    const mk = () => {
      const rows = []; const n = R.int(4, 9);
      for (let i = 0; i < n; i++) {
        const unit = `${R.int(1, 40)}${R.pick(['A', 'B', 'C'])}`; const dedupe = rows.some((r) => readings(r, 'unit_number')[0] === unit); if (dedupe) continue;
        const tn = `${R.pick(FIRST)} ${R.pick(LAST)}`; const p = R.pick(props); let end = addDays(TODAY, R.int(-30, 200)); if (variant === 'boundary') end = addDays(TODAY, [-1, 0, 1, days - 1, days, days + 1][i % 6]);
        const start = addDays(end, -365);
        if (variant === 'corrected' && i % 2 === 0) rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', tn], ['lease_start_date', start], ['lease_end_date', addDays(TODAY, 400), end], ['rent_amount', '1200'], ['property_name', p]]));
        else if (variant === 'cleared' && i === 0) rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', tn], ['lease_start_date', start], ['lease_end_date', end, ''], ['rent_amount', '1200'], ['property_name', p]]));
        else if (variant === 'superseded' && i === 0) rows.push(lease(unit, tn, start, end, '1200', p, {}, [['status', 'Superseded']]));
        else if (variant === 'mtm' && i % 3 === 0) rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', tn], ['lease_start_date', start], ['status', 'Month-to-Month'], ['rent_amount', '1200'], ['property_name', p]]));
        else rows.push(lease(unit, tn, start, end, '1200', p));
        if (variant === 'internal' && i % 2 === 0) rows.push(lease(unit, 'Zed Intern', addDays(end, 1), addDays(end, 366), '9', p, { aud: 'internal' }));
      }
      return rows;
    };
    return { name: `leaseWindow:${variant}`, rowsA: mk(), rowsB: mk(), question: R.pick([`How many leases expire in the next ${days} days?`, `Which leases expire in the next ${days} days?`, `Any leases ending in the next ${days} days?`, `Are there any leases up for renewal in the next ${days} days?`, `List leases ending within ${days} days`, `How many leases end in the next ${days} days?`]), expect: (rows) => {
      const ls = rows.filter((r) => r.type === 'lease_agreement' && live(r));
      if (ls.some((r) => r.f.some((x) => x[0] !== 'status' && one(r, x[0], (z) => (iso(z) ?? z.toLowerCase())).conflict))) return { decline: true };
      // a lease whose status says superseded / cancelled: its unit is named in a "records disagree" note and left out of the number (which lease is live is not decided)
      const deadN = ls.filter(dead).length;
      const per = new Map(); for (const r of ls.filter((x) => !dead(x))) { const u = `${readings(r, 'property_name')[0]}|${readings(r, 'unit_number')[0]}`; const s = iso(readings(r, 'lease_start_date')[0] ?? '') ?? ''; if (!per.has(u) || s > per.get(u).s) per.set(u, { s, r }); }
      let n = 0; for (const { r } of per.values()) { if (readings(r, 'status').some((s) => /month/i.test(s))) continue; const e = iso(readings(r, 'lease_end_date')[0] ?? ''); if (e && within(e, days)) n++; }
      return deadN ? { n, has: ['disagree'] } : { n };
    } };
  },

  tenantOf(R) {
    const variant = R.pick(['plain', 'sharedFirst', 'reordered', 'cleared', 'corrected', 'terminated', 'whitespace']);
    const p = R.pick(P_PRE); const unit = `${R.int(1, 30)}${R.pick(['A', 'B'])}`; const first = R.pick(FIRST); const last = R.pick(LAST); const other = R.pick(LAST.filter((x) => x !== last));
    const mk = (tn) => {
      const start = addDays(TODAY, -200); const end = addDays(TODAY, 120);
      const rows = [];
      const roll = (name) => rec('rent_roll', [['rent_roll_row', `unit=${unit}; tenant=${name}; lease_start=${start}; lease_end=${end}; rent=1200.00; status=Occupied`], ['property_name', p]]);
      if (variant === 'plain') rows.push(lease(unit, tn, start, end, '1200', p));
      if (variant === 'sharedFirst') { rows.push(lease(unit, `${first} ${last}`, start, end, '1200', p)); rows.push(roll(`${first} ${other}`)); }
      if (variant === 'reordered') { rows.push(lease(unit, `${first} ${last}`, start, end, '1200', p)); rows.push(roll(`${last}, ${first}`)); }
      if (variant === 'cleared') rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', tn, ''], ['lease_start_date', start], ['lease_end_date', end], ['rent_amount', '1200'], ['property_name', p]]));
      if (variant === 'corrected') rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', 'Old Name', tn], ['lease_start_date', start], ['lease_end_date', end], ['rent_amount', '1200'], ['property_name', p]]));
      if (variant === 'terminated') rows.push(lease(unit, tn, start, end, '1200', p, {}, [['status', 'Terminated']]));
      if (variant === 'whitespace') rows.push(rec('lease_agreement', [['unit_number', ` ${unit} `], ['tenant_name', `​${tn} `], ['lease_start_date', start], ['lease_end_date', end], ['rent_amount', '1200'], ['property_name', p]]));
      return rows;
    };
    const tnA = `${R.pick(FIRST)} ${R.pick(LAST)}`; const tnB = `${R.pick(FIRST)} ${R.pick(LAST)}`;
    return { name: `tenantOf:${variant}`, rowsA: mk(tnA), rowsB: mk(tnB), question: R.pick([`Who lives in unit ${unit}?`, `Who is the tenant of unit ${unit}?`]), expect: (rows) => {
      if (variant === 'sharedFirst' || variant === 'cleared' || variant === 'terminated') return { decline: true };
      if (variant === 'reordered') return { has: [`${first} ${last}`] };
      const ten = readings(rows[0], 'tenant_name')[0]; return ten ? { has: [ten] } : { decline: true };
    } };
  },

  countType(R) {
    const props = R.shuffle(P_PRE).slice(0, 2); const variant = R.pick(['leases', 'leasesScoped', 'cois', 'coisDup', 'contracts', 'vendorsNoun', 'perProperty', 'invoices']);
    const used = new Set(); const names = Array.from({ length: 4 }, () => vname(R, used));
    const mk = () => {
      const rows = [];
      for (let i = 0; i < R.int(4, 9); i++) rows.push(lease(`${i + 1}A`, `${R.pick(FIRST)} ${R.pick(LAST)}`, addDays(TODAY, -300), addDays(TODAY, R.int(10, 300)), '1000', R.pick(props)));
      if (variant === 'leases' || variant === 'leasesScoped') rows.push(lease('1A', 'Prior Tenant', addDays(TODAY, -700), addDays(TODAY, -330), '900', props[0]));
      names.forEach((nm) => { rows.push(coi(nm, addDays(TODAY, R.int(10, 100)))); if (variant === 'coisDup') rows.push(coi(nm, addDays(TODAY, R.int(101, 200)))); });
      if (variant === 'invoices') for (let i = 0; i < R.int(3, 6); i++) { const f = i % 3 === 0 ? { fin: { kind: 'invoice', direction: 'receivable', currency: 'USD', total: 50, status: 'unpaid', due: addDays(TODAY, 3) } } : {}; rows.push(inv(names[i % 4], `CT-${i}`, '50', i % 3 === 1 ? 'Void' : 'Unpaid', addDays(TODAY, 3), f)); if (i % 2 === 0) rows.push(inv(names[i % 4], `CT-${i}`, '50', i % 3 === 1 ? 'Void' : 'Unpaid', addDays(TODAY, 3), f)); }
      for (let i = 0; i < 2; i++) rows.push(rec('vendor_contract', [['vendor', names[i]], ['contract_start', addDays(TODAY, -100)], ['contract_end', addDays(TODAY, 100)], ['monthly_amount', '300']]));
      if (variant === 'contracts') rows.push(rec('vendor_contract', [['vendor', names[0]], ['contract_start', addDays(TODAY, -400)], ['contract_end', addDays(TODAY, -30)], ['monthly_amount', '250']]));
      return rows;
    };
    const sp = props[0];
    const q = { leases: 'How many leases do we have on file?', leasesScoped: `How many leases are on file for ${sp} Apartments?`, cois: 'How many certificates of insurance do we have on file?', coisDup: 'How many certificates of insurance do we have on file?', contracts: 'How many vendor contracts do we have on file?', invoices: 'How many invoices do we have on file?', vendorsNoun: 'How many vendors do we have COIs on file for?', perProperty: 'How many leases do we have on file by property?' }[variant];
    return { name: `countType:${variant}`, rowsA: mk(), rowsB: mk(), question: q, props: variant === 'leasesScoped' ? [sp] : [], propSuffix: ' Apartments', expect: (rows) => {
      if (variant === 'vendorsNoun' || variant === 'perProperty') return { decline: true };
      const t = { leases: 'lease_agreement', leasesScoped: 'lease_agreement', cois: 'certificate_of_insurance', coisDup: 'certificate_of_insurance', contracts: 'vendor_contract', invoices: 'invoice' }[variant];
      let ds = rows.filter((r) => r.type === t && live(r));
      if (variant === 'leasesScoped') ds = ds.filter((r) => readings(r, 'property_name')[0]?.toLowerCase() === sp.toLowerCase());
      const out = { n: ds.length };
      if (t === 'invoice') { const dist = new Set(ds.map((r) => `${vkey(readings(r, 'vendor')[0] ?? '')}|${readings(r, 'invoice_number')[0]}`)).size; const words = []; if (dist !== ds.length) words.push(`${dist} distinct invoice`); const rv = new Set(ds.filter((r) => r.fin?.direction === 'receivable').map((r) => `${vkey(readings(r, 'vendor')[0] ?? '')}|${readings(r, 'invoice_number')[0]}`)).size; if (rv) words.push('issued by you'); out.has = words; }
      if (t === 'lease_agreement') { const us = new Set(ds.map((r) => `${readings(r, 'property_name')[0]}|${readings(r, 'unit_number')[0]}`)).size; if (us !== ds.length) out.has = [`cover ${us} unit`]; }
      if (t === 'certificate_of_insurance' || t === 'vendor_contract') { const vs = new Set(ds.map((r) => vkey(readings(r, 'vendor')[0] ?? ''))).size; if (vs !== ds.length) out.has = [`cover ${vs} vendor`]; }
      return out;
    } };
  },

  /* conditions the lane does not understand, names that are not this organization's, negations: must never be answered as if the condition were absent */
  declines(R) {
    const used = new Set(); const names = Array.from({ length: 3 }, () => vname(R, used)); const props = R.shuffle(P_PRE).slice(0, 2);
    const foreignVendor = vname(R, used); const foreignPerson = `${R.pick(FIRST)} ${R.pick(LAST)}`;
    const mk = () => [...names.map((nm) => coi(nm, addDays(TODAY, R.int(-30, 90)))), ...Array.from({ length: 5 }, (_, i) => lease(`${i + 1}B`, `${R.pick(FIRST)} ${R.pick(LAST)}`, addDays(TODAY, -300), addDays(TODAY, R.int(5, 80)), '1100', R.pick(props))), wo('9001', 'Open', props[0]), inv(names[0], 'D-1', '100', 'Unpaid', addDays(TODAY, -4))];
    const qs = [
      'Which vendor COIs are not expired?', 'How many vendor COIs do not expire in the next 60 days?', `Which vendor COIs expire in the next 60 days except ${names[0]}?`,
      'How many leases expire in the next 60 days in Tucson?', `How many leases expire in the next 60 days for ${foreignPerson}?`, `How many invoices are overdue from ${foreignVendor}?`,
      'How many vendors do we have COIs for?', 'How many leases expire in the next 60 days per property?', 'How many leases expire in the next 60 days by unit?',
      `How many leases expire in the next 60 days at ${props[0]} Apartments excluding unit 1B?`, `Is ${names[0]} insured and when does the ${names[1]} COI expire?`,
      'How many work orders are open for Hispanic tenants?', `What is the total of unpaid invoices from ${foreignVendor}?`, 'Which leases expire in the next 60 days with rent over 1500?',
    ];
    const q = R.pick(qs);
    return { name: `declines:${q.slice(0, 40)}`, rowsA: mk(), rowsB: mk(), question: q, expect: () => ({ decline: true }) };
  },

  /* a vendor or tenant name one or two letters off a real one: corrected-and-said or declined, never a zero or a total for something else */
  nearMissQuestion(R) {
    const used = new Set(); const names = [vname(R, used), vname(R, used)];
    const mk = () => [coi(names[0], addDays(TODAY, R.int(5, 90))), coi(names[1], addDays(TODAY, R.int(-40, -1))), inv(names[0], 'Q-1', '250', 'Unpaid', addDays(TODAY, -6)), inv(names[1], 'Q-2', '125', 'Unpaid', addDays(TODAY, 4))];
    const target = names[0]; const w = target.split(' '); const typo = [`${w[0].slice(0, -1)} ${w.slice(1).join(' ')}`, `${w[0]}x ${w.slice(1).join(' ')}`, `${w[0].slice(0, 2)}${w[0].slice(3)} ${w.slice(1).join(' ')}`][R.int(0, 2)];
    const q = R.pick([`When does ${typo}'s COI expire?`, `What is the total of invoices from ${typo}?`, `How many invoices are overdue from ${typo}?`, `Which of ${typo}'s invoices are unpaid?`]);
    return { name: 'nearMissQuestion', rowsA: mk(), rowsB: mk(), question: q, expect: () => ({ nearMiss: true, real: [target] }) };
  },
};


FAMILIES.contractWindow = function contractWindow(R) {
  const used = new Set(); const names = Array.from({ length: R.int(3, 6) }, () => vname(R, used));
  const variant = R.pick(['plain', 'boundary', 'corrected', 'cleared', 'dead', 'expired', 'dupes']);
  const days = R.pick([14, 30, 60, 90]);
  const mk = () => {
    const rows = [];
    names.forEach((nm, i) => {
      let end = addDays(TODAY, R.int(-60, 200)); if (variant === 'boundary') end = addDays(TODAY, [-1, 0, 1, days - 1, days, days + 1][i % 6]);
      const base = [['vendor', nm], ['contract_start', addDays(end, -365)], ['monthly_amount', String(R.int(100, 900))]];
      if (variant === 'corrected' && i % 2 === 0) rows.push(rec('vendor_contract', [...base, ['contract_end', addDays(TODAY, 500), end]]));
      else if (variant === 'cleared' && i === 0) rows.push(rec('vendor_contract', [...base, ['contract_end', end, '']]));
      else if (variant === 'dead' && i === 0) rows.push(rec('vendor_contract', [...base, ['contract_end', end], ['status', 'Terminated']]));
      else rows.push(rec('vendor_contract', [...base, ['contract_end', end]]));
      if (variant === 'dupes' && i % 2 === 0) rows.push(rec('vendor_contract', [...base, ['contract_end', end]]));
    });
    return rows;
  };
  const exp = variant === 'expired';
  return { name: `contractWindow:${variant}`, rowsA: mk(), rowsB: mk(), question: exp ? 'How many vendor contracts have expired?' : `How many vendor contracts end in the next ${days} days?`, expect: (rows) => {
    const cs = rows.filter((r) => r.type === 'vendor_contract' && live(r));
    if (cs.some(dead)) return { decline: true };
    const seen = new Map(); for (const r of cs) seen.set(`${vkey(readings(r, 'vendor')[0] ?? '')}|${readings(r, 'contract_start')[0]}|${readings(r, 'contract_end')[0]}`, r);
    let n = 0; for (const r of seen.values()) { const e = iso(readings(r, 'contract_end')[0] ?? ''); if (!e) continue; if (exp ? e < TODAY : within(e, days)) n++; }
    return { n };
  } };
};

FAMILIES.woOverdue = function woOverdue(R) {
  const props = R.shuffle(P_PRE).slice(0, 2); const variant = R.pick(['plain', 'boundary', 'cancelled', 'dupes', 'noDate']);
  const mk = () => {
    const rows = []; const n = R.int(5, 10);
    for (let i = 0; i < n; i++) {
      const no = String(2000 + i); let off = R.int(-30, 10); if (variant === 'boundary') off = [-1, 0, 1][i % 3];
      const st = variant === 'cancelled' && i % 2 === 0 ? 'Cancelled' : R.pick(['Open', 'Scheduled', 'In Progress', 'Completed', 'Open']);
      const f = [['work_order_number', no], ['status', st], ['property_name', R.pick(props)], ['opened_date', addDays(TODAY, -60)]];
      if (!(variant === 'noDate' && i % 3 === 0)) f.push(['service_date', addDays(TODAY, off)]);
      rows.push(rec('work_order', f));
      if (variant === 'dupes' && i % 2 === 0) rows.push(rec('work_order', f));
    }
    return rows;
  };
  return { name: `woOverdue:${variant}`, rowsA: mk(), rowsB: mk(), question: R.pick(['How many work orders are overdue?', 'How many work orders are late?']), expect: (rows) => {
    const t = woTruth(rows); if (t.unsure) return { decline: true };
    return { n: t.wos.filter((w) => w.cls === 'open' && w.sched && w.sched < TODAY).length };
  } };
};

FAMILIES.attention = function attention(R) {
  const used = new Set(); const names = Array.from({ length: 5 }, () => vname(R, used)); const variant = R.pick(['plain', 'corrected', 'internal', 'receivable', 'boundary', 'invConflict']);
  const mk = () => {
    const rows = [];
    names.forEach((nm, i) => {
      let e = addDays(TODAY, R.int(-100, 150)); if (variant === 'boundary') e = addDays(TODAY, [59, 60, 61, -1, 0][i % 5]);
      if (variant === 'corrected' && i % 2 === 0) rows.push(rec('certificate_of_insurance', [['vendor', nm], ['coi_expires', addDays(TODAY, 400), e], ['coverage_type', 'General Liability']]));
      else rows.push(coi(nm, e));
      if (variant === 'internal' && i === 0) rows.push(coi(nm, addDays(TODAY, -5), { aud: 'internal' }));
      let ce = addDays(TODAY, R.int(-90, 120)); if (variant === 'boundary') ce = addDays(TODAY, [59, 60, 61, -59, -60][i % 5]);
      rows.push(rec('vendor_contract', [['vendor', `${nm.split(' ')[0]} Contracting Co`], ['contract_start', addDays(ce, -365)], ['contract_end', ce], ['monthly_amount', '200']]));
      const due = addDays(TODAY, R.int(-30, 20)); const fin = variant === 'receivable' && i % 2 === 0 ? { kind: 'invoice', direction: 'receivable', currency: 'USD', total: 100, status: 'unpaid', due } : undefined;
      rows.push(inv(nm, `AT-${i}`, '100', 'Unpaid', due, fin ? { fin } : {}));
      if (variant === 'invConflict' && i === 0) rows.push(inv(nm, `AT-${i}`, '175', 'Unpaid', due));
      rows.push(rec('work_order', [['work_order_number', String(3000 + i)], ['status', R.pick(['Open', 'Completed'])], ['property_name', P_PRE[0]], ['opened_date', addDays(TODAY, -90)], ['service_date', addDays(TODAY, R.int(-20, 10))]]));
    });
    return rows;
  };
  return { name: `attention:${variant}`, rowsA: mk(), rowsB: mk(), question: 'What needs attention?', expect: (rows) => {
    let n = 0;
    const t = coiTruth(rows); if (t.unsure) return { decline: true };
    for (const v of t.vendors.values()) if (v.exp && Math.round((Date.parse(v.exp) - Date.parse(TODAY)) / 86400000) <= 60) n++;
    for (const r of rows.filter((x) => x.type === 'vendor_contract' && live(x))) { const e = iso(readings(r, 'contract_end')[0] ?? ''); if (e && Math.abs(Math.round((Date.parse(e) - Date.parse(TODAY)) / 86400000)) <= 60) n++; }
    const it = invTruth(rows); // copies of one invoice that disagree are left out of the list and said so
    n += it.invs.filter((i) => !i.receivable && (i.cls === 'unpaid' || i.cls === 'partial') && i.due && i.due < TODAY).length;
    const w = woTruth(rows); if (w.unsure) return { decline: true };
    n += w.wos.filter((x) => x.cls === 'open' && x.sched && x.sched < TODAY).length;
    return it.unsure ? { n, has: ['disagree'] } : { n };
  } };
};

/* names that collide: a property named like a vendor, vendors whose names contain the lane's own words ("Open Door", "Paid Express") */
FAMILIES.nameClash = function nameClash(R) {
  const stem = R.pick(V_PRE); const prop = `${stem} Court`; const vendor = `${stem} Plumbing LLC`;
  const odd = R.pick(['Open Door Locksmith LLC', 'Paid Express Delivery Inc', 'Overdue Pest Control Co', 'Current Electric LLC', 'Late Night Locksmith Inc']);
  const variant = R.pick(['vendorCoi', 'propWo', 'oddInvoices', 'oddCoi']);
  const mk = () => {
    const rows = [coi(vendor, addDays(TODAY, R.int(5, 120))), coi(odd, addDays(TODAY, R.int(-30, 90)))];
    for (let i = 0; i < R.int(3, 7); i++) rows.push(wo(String(4000 + i), R.pick(['Open', 'Completed', 'Open']), prop));
    for (let i = 0; i < R.int(2, 5); i++) rows.push(wo(String(4500 + i), 'Open', P_PRE[1]));
    for (let i = 0; i < R.int(3, 6); i++) rows.push(inv(odd, `OD-${i}`, String(R.int(50, 400)), R.pick(['Unpaid', 'Paid', 'Unpaid']), addDays(TODAY, R.int(-20, 20))));
    rows.push(inv(vendor, 'V-1', '90', 'Unpaid', addDays(TODAY, -3)));
    return rows;
  };
  const q = { vendorCoi: `When does ${vendor.replace(/ LLC$/, '')}'s COI expire?`, propWo: `How many open work orders are there at ${prop}?`, oddInvoices: `How many invoices from ${odd} are unpaid?`, oddCoi: `When does the ${odd} COI expire?` }[variant];
  return { name: `nameClash:${variant}`, rowsA: mk(), rowsB: mk(), question: q, expect: (rows) => {
    if (variant === 'vendorCoi') { const t = coiTruth(rows); const v = t.vendors?.get(vkey(vendor)); return v?.exp ? { has: [long(v.exp)] } : { decline: true }; }
    if (variant === 'oddCoi') { const t = coiTruth(rows); const v = t.vendors?.get(vkey(odd)); return v?.exp ? { has: [long(v.exp)] } : { decline: true }; }
    if (variant === 'propWo') return woN(rows, 'open', prop);
    const t = invTruth(rows); if (t.unsure) return { decline: true };
    return { n: t.invs.filter((i) => vkey(i.vendor) === vkey(odd) && (i.cls === 'unpaid' || i.cls === 'partial')).length };
  } };
};
void FAMILIES;


FAMILIES.vacancy = function vacancy(R) {
  const props = R.shuffle(P_PRE).slice(0, 3); const variant = R.pick(['plain', 'twoRolls', 'internalRoll', 'leaseVsRoll', 'unread', 'cleared', 'whitespace']);
  const row = (u, tn, st) => `unit=${u}; ${tn ? `tenant=${tn}; ` : ''}lease_start=${addDays(TODAY, -200)}; lease_end=${addDays(TODAY, 100)}; rent=1100.00; status=${st}`;
  const mk = () => {
    const rows = [];
    props.slice(0, 2).forEach((p, pi) => {
      const f = [['property_name', p]]; const n = R.int(3, 7);
      for (let i = 1; i <= n; i++) { const vac = R.next() < 0.4; const st = vac ? 'Vacant' : 'Occupied'; f.push(['rent_roll_row', variant === 'whitespace' && i % 2 ? ` ${row(`${i}A`, vac ? '' : 'Alma Arden', st)} ​` : row(`${i}A`, vac ? '' : 'Alma Arden', st), variant === 'cleared' && i === 1 ? '' : undefined].filter((x) => x !== undefined)); }
      if (variant === 'unread' && pi === 0) f.push(['rent_roll_unread', '2']);
      rows.push(rec('rent_roll', f, variant === 'internalRoll' && pi === 1 ? { aud: 'internal' } : {}));
      if (variant === 'twoRolls' && pi === 0) rows.push(rec('rent_roll', f));
    });
    if (variant === 'leaseVsRoll') rows.push(lease('1A', 'Bruno Cortez', addDays(TODAY, -100), addDays(TODAY, 200), '1000', props[0]));
    return rows;
  };
  return { name: `vacancy:${variant}`, rowsA: mk(), rowsB: mk(), question: R.pick(['How many units are vacant?', 'How many vacant units are there?']), expect: (rows) => {
    if (variant === 'twoRolls' || variant === 'unread') return { decline: true };
    const rolls = rows.filter((r) => r.type === 'rent_roll' && live(r));
    const vacant = new Set(); const leased = rows.filter((r) => r.type === 'lease_agreement' && live(r)).map((r) => `${readings(r, 'property_name')[0]}|${readings(r, 'unit_number')[0]}`);
    let n = 0;
    for (const r of rolls) for (const x of r.f.filter((y) => y[0] === 'rent_roll_row')) {
      const txt = x[2] !== undefined ? x[2] : x[1]; const t = tidy(txt); if (!t) continue;
      const u = t.match(/unit=([^;]+)/)?.[1]; const st = t.match(/status=([^;]+)/)?.[1];
      if (/vacant/i.test(st ?? '')) { if (leased.includes(`${readings(r, 'property_name')[0]}|${u}`)) return { decline: true }; n++; vacant.add(u); }
    }
    return { n };
  } };
};

FAMILIES.inspection = function inspection(R) {
  const props = R.shuffle(P_PRE).slice(0, 2); const variant = R.pick(['plain', 'superseded', 'sameDay', 'corrected', 'cleared', 'internal']);
  const ins = (p, u, d, res, extra = {}, more = []) => rec('inspection_report', [['property_name', p], ['unit_number', u], ['service_date', d], ['inspection_type', 'Fire'], ['inspection_result', res, ...more]], extra);
  const mk = () => {
    const rows = [];
    for (let i = 1; i <= R.int(3, 7); i++) {
      const p = R.pick(props); const u = `${i}C`; const d = addDays(TODAY, -R.int(20, 200)); const res = R.pick(['Passed', 'Failed', 'Failed', 'Passed']);
      if (variant === 'superseded' && i % 2 === 0) { rows.push(ins(p, u, d, 'Failed')); rows.push(ins(p, u, addDays(d, 30), 'Passed')); }
      else if (variant === 'sameDay' && i === 1) { rows.push(ins(p, u, d, 'Failed')); rows.push(ins(p, u, d, 'Passed')); }
      else if (variant === 'corrected' && i % 2 === 0) rows.push(rec('inspection_report', [['property_name', p], ['unit_number', u], ['service_date', d], ['inspection_type', 'Fire'], ['inspection_result', 'Failed', 'Passed']]));
      else if (variant === 'cleared' && i === 1) rows.push(rec('inspection_report', [['property_name', p], ['unit_number', u], ['service_date', d], ['inspection_type', 'Fire'], ['inspection_result', 'Failed', '']]));
      else rows.push(ins(p, u, d, res));
      if (variant === 'internal' && i % 2 === 1) rows.push(ins(p, u, addDays(d, 10), 'Passed', { aud: 'internal' }));
    }
    return rows;
  };
  return { name: `inspection:${variant}`, rowsA: mk(), rowsB: mk(), question: R.pick(['How many fire inspections failed?', 'How many inspections failed?']), expect: (rows) => {
    const all = rows.filter((r) => r.type === 'inspection_report' && live(r));
    const g = new Map(); for (const r of all) { const k = `${readings(r, 'property_name')[0]}|${readings(r, 'unit_number')[0]}`; (g.get(k) ?? g.set(k, []).get(k)).push(r); }
    let n = 0;
    for (const list of g.values()) {
      const lastD = list.map((r) => readings(r, 'service_date')[0]).sort().pop(); const latest = list.filter((r) => readings(r, 'service_date')[0] === lastD);
      const fails = new Set(latest.map((r) => /fail/i.test(readings(r, 'inspection_result')[0] ?? '')));
      if (fails.size > 1) return { decline: true };
      if (list.some((r) => !readings(r, 'inspection_result').length) && list.length > 1) return { decline: true };
      if ([...fails][0]) n++;
    }
    return { n };
  } };
};

FAMILIES.invFact = function invFact(R) {
  const used = new Set(); const names = [vname(R, used), vname(R, used)]; const variant = R.pick(['amount', 'amountCorrected', 'eur', 'sameNumber', 'status', 'void', 'dueCleared']);
  const no = `FX-${R.int(100, 999)}`; const cost = (R.int(1000, 99999) / 100).toFixed(2); const due = addDays(TODAY, R.int(-20, 30));
  const mk = () => {
    const rows = [];
    if (variant === 'amount') rows.push(inv(names[0], no, cost, 'Unpaid', due));
    if (variant === 'amountCorrected') rows.push(rec('invoice', [['vendor', names[0]], ['invoice_number', no], ['cost', '1.00', cost], ['status', 'Unpaid'], ['invoice_due', due]]));
    if (variant === 'eur') rows.push(inv(names[0], no, cost, 'Unpaid', due, { fin: { kind: 'invoice', direction: 'payable', currency: 'EUR', total: Number(cost), status: 'unpaid', due } }));
    if (variant === 'sameNumber') { rows.push(inv(names[0], no, cost, 'Unpaid', due)); rows.push(inv(names[1], no, '9.99', 'Paid', due)); }
    if (variant === 'status') rows.push(inv(names[0], no, cost, R.pick(['Paid', 'Unpaid']), due));
    if (variant === 'void') rows.push(inv(names[0], no, cost, 'Void', due));
    if (variant === 'dueCleared') rows.push(rec('invoice', [['vendor', names[0]], ['invoice_number', no], ['cost', cost], ['status', 'Unpaid'], ['invoice_due', due, '']]));
    rows.push(inv(names[1], 'OTHER-1', '10', 'Paid', due));
    return rows;
  };
  const q = { amount: `What is the total on invoice ${no}?`, amountCorrected: `What is the total on invoice ${no}?`, eur: `What is the total on invoice ${no}?`, sameNumber: `What is the total on invoice ${no}?`, status: `What is the status of invoice ${no}?`, void: `What is the status of invoice ${no}?`, dueCleared: `When is invoice ${no} due?` }[variant];
  return { name: `invFact:${variant}`, rowsA: mk(), rowsB: mk(), question: q, expect: (rows) => {
    if (variant === 'sameNumber') return { decline: true };
    const r = rows.find((x) => x.type === 'invoice' && readings(x, 'invoice_number')[0] === no); const c = readings(r, 'cost')[0];
    if (variant === 'eur') return { has: [c.replace(/^(\d+)(\.\d+)?$/, (m) => Number(m).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), 'EUR'], not: ['$'] };
    if (variant === 'status' || variant === 'void') return { has: [readings(r, 'status')[0]] };
    if (variant === 'dueCleared') return { decline: true };
    return { has: [`$${Number(c).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`] };
  } };
};

FAMILIES.rentOf = function rentOf(R) {
  const p = R.pick(P_PRE); const unit = `${R.int(1, 30)}${R.pick(['A', 'B'])}`; const variant = R.pick(['plain', 'corrected', 'cleared', 'rollConflict', 'whitespace', 'weirdFormat']);
  const rentA = String(R.int(800, 2400)) + R.pick(['', '.50', '.00']);
  const mk = (rent) => {
    const start = addDays(TODAY, -100); const end = addDays(TODAY, 200); const rows = [];
    if (variant === 'plain') rows.push(lease(unit, 'Alma Arden', start, end, rent, p));
    if (variant === 'corrected') rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', 'Alma Arden'], ['lease_start_date', start], ['lease_end_date', end], ['rent_amount', '1', rent], ['property_name', p]]));
    if (variant === 'cleared') rows.push(rec('lease_agreement', [['unit_number', unit], ['tenant_name', 'Alma Arden'], ['lease_start_date', start], ['lease_end_date', end], ['rent_amount', rent, ''], ['property_name', p]]));
    if (variant === 'rollConflict') { rows.push(lease(unit, 'Alma Arden', start, end, rent, p)); rows.push(rec('rent_roll', [['property_name', p], ['rent_roll_row', `unit=${unit}; tenant=Alma Arden; lease_start=${start}; lease_end=${end}; rent=${(Number(rent) + 75).toFixed(2)}; status=Occupied`]])); }
    if (variant === 'whitespace') rows.push(lease(unit, 'Alma Arden', start, end, ` ${rent} ​`, p));
    if (variant === 'weirdFormat') rows.push(lease(unit, 'Alma Arden', start, end, R.pick(['1e3', '0x10', '1.200,00', '12 USD', '$ 900 weekly']), p));
    return rows;
  };
  const rentB = String(R.int(800, 2400));
  return { name: `rentOf:${variant}`, rowsA: mk(rentA), rowsB: mk(rentB), question: `What is the rent for unit ${unit}?`, expect: (rows) => {
    if (variant === 'cleared' || variant === 'rollConflict' || variant === 'weirdFormat') return { decline: true };
    const v = rows[0].f.find((x) => x[0] === 'rent_amount'); const eff = tidy(v[2] !== undefined ? v[2] : v[1]);
    return { has: [`$${Number(eff).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`] };
  } };
};

/** the large corpora: counts are made in SQL over every row, never over a limited list */
export function bigCase(R, size) {
  const used = new Set(); const names = Array.from({ length: 6 }, () => vname(R, used));
  const mk = () => {
    const rows = [];
    for (let i = 0; i < size; i++) { const nm = names[i % names.length]; const open = i % 3 !== 0; rows.push(inv(nm, `BIG-${i}`, String(10 + (i % 90)), open ? 'Unpaid' : 'Paid', addDays(TODAY, (i % 7) - 5))); }
    return rows;
  };
  return { name: `big:${size}`, rowsA: mk(), rowsB: mk().slice(0, Math.floor(size / 2)), question: 'How many invoices are overdue?', expect: overdueN };
}

export const FAMILY_NAMES = Object.keys(FAMILIES);

/** a deterministic list of cases: `per` cases per family */
export function buildCases(seed = 20261006, per = 24) {
  const out = [];
  for (const fam of FAMILY_NAMES) for (let i = 0; i < per; i++) {
    const R = rng(seed + fam.length * 1009 + i * 7919 + [...fam].reduce((a, c) => a + c.charCodeAt(0), 0));
    const c = FAMILIES[fam](R); out.push({ family: fam, i, ...c });
  }
  return out;
}

/* ------------------------------------------------------------------ grading */
export const leadNumber = (text) => { const t = String(text ?? '').trim(); if (/^none\b/i.test(t)) return 0; const m = t.match(/^\$?\s*(-?[\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, '')) : null; };
/** -> 'correct' | 'model' (declined where an answer was possible) | 'wrong' */
export function grade(exp, r) {
  const text = r ? `${r.text ?? ''}` : '';
  const answered = !!r && !r.decline && !r.clarify && text.trim() !== '';
  if (exp.nearMiss) {
    if (!answered) return { cls: 'model' };
    // an answer to a near-miss name must name the real vendor (a correction said out loud), never a zero / a total for nothing
    return exp.real.every((n) => text.includes(n)) ? { cls: 'correct' } : { cls: 'wrong', why: `near-miss answered without naming the real vendor: ${text}` };
  }
  if (exp.decline) return answered ? { cls: 'wrong', why: `should have declined but answered: ${text}` } : { cls: 'model' };
  if (!answered) return { cls: 'model' };
  if (exp.n != null) { const n = leadNumber(text); if (n !== exp.n) return { cls: 'wrong', why: `leading number ${n} != ${exp.n}: ${text}` }; }
  if (exp.money != null) { const n = leadNumber(text); if (n == null || Math.round(n * 100) !== Math.round(exp.money * 100)) return { cls: 'wrong', why: `leading amount ${n} != ${fmtMoney(exp.money)}: ${text}` }; }
  const hay = `${text} ${(r.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
  for (const w of exp.has ?? []) if (!hay.includes(w)) return { cls: 'wrong', why: `missing "${w}": ${text}` };
  for (const w of exp.not ?? []) if (hay.includes(w)) return { cls: 'wrong', why: `contains "${w}": ${text}` };
  return { cls: 'correct' };
}
