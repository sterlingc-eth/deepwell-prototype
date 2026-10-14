/**
 * dql/reader-ml/fill.js - the deterministic slot filler (learned_reader/lrcore.py unskel), in JavaScript.
 * The model's nine predicted parts assemble into a plan SKELETON with placeholders (<ENT1>, <DT1>, <YEAR1> ...); the placeholders are filled from the
 * question's own mentions (anon.js). A value never comes from the model.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const iso = (d) => d.toISOString().slice(0, 10);
const pd = (s) => new Date(`${s}T00:00:00Z`);
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addMonths(d, n) { const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + n) / 12); const m = (((d.getUTCMonth() + n) % 12) + 12) % 12; return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim(y, m + 1)))); }
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** deterministic bounds of an absolute / today-relative span string; null when unknown */
export function spanBounds(s, today) {
  const T = pd(today); let m;
  if ((m = /^(\d{4})$/.exec(s))) return [`${m[1]}-01-01`, `${m[1]}-12-31`];
  if ((m = /^ytd (\d{4})$/.exec(s))) return [`${m[1]}-01-01`, iso(new Date(Date.UTC(+m[1], T.getUTCMonth(), T.getUTCDate())))];
  if ((m = /^Q([1-4]) (\d{4})$/.exec(s))) { const q = +m[1]; const y = +m[2]; return [iso(new Date(Date.UTC(y, 3 * q - 3, 1))), iso(new Date(Date.UTC(y, 3 * q - 1, dim(y, 3 * q))))]; }
  if ((m = /^(?:on )?(\d{4}-\d\d-\d\d)$/.exec(s))) return [m[1], m[1]];
  if ((m = /^(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)$/.exec(s))) return [m[1], m[2]];
  if ((m = /^(\d{4})-(\d{4})$/.exec(s))) return [`${m[1]}-01-01`, `${m[2]}-12-31`];
  if ((m = /^([A-Za-z]+) (\d{4})$/.exec(s)) && MONTHS.includes(m[1].toLowerCase())) { const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; const y = +m[2]; return [`${y}-${String(mo).padStart(2, '0')}-01`, `${y}-${String(mo).padStart(2, '0')}-${String(dim(y, mo)).padStart(2, '0')}`]; }
  if ((m = /^after (\d{4}-\d\d-\d\d)$/.exec(s))) return [iso(addDays(pd(m[1]), 1)), today];
  if ((m = /^since (\d{4}-\d\d-\d\d)$/.exec(s))) return [m[1], today];
  if ((m = /^since (\d{4})$/.exec(s))) return [`${m[1]}-01-01`, today];
  if ((m = /^before (\d{4})$/.exec(s))) return ['2000-01-01', iso(addDays(new Date(Date.UTC(+m[1], 0, 1)), -1))];
  if ((m = /^before (\d{4}-\d\d-\d\d)$/.exec(s))) return ['2000-01-01', iso(addDays(pd(m[1]), -1))];
  if ((m = /^through (\d{4}-\d\d-\d\d)$/.exec(s))) return ['2000-01-01', m[1]];
  if ((m = /^last (\d+) days$/.exec(s))) return [iso(addDays(T, -+m[1])), today];
  if ((m = /^last (\d+) months$/.exec(s))) return [iso(addMonths(T, -+m[1])), today];
  if ((m = /^next (\d+) days$/.exec(s))) return [today, iso(addDays(T, +m[1]))];
  if (s === 'already expired') return ['0000-01-01', iso(addDays(T, -1))];
  return null;
}

let DATA = null;
/** the trained-skeleton table, the closed literals and the reference table of relative spans (built for the day the training plans were dated) */
export function loadFillData(dir) {
  if (DATA && DATA.dir === dir) return DATA;
  const buf = fs.readFileSync(`${dir}/trsk.bin`); const n = buf.length / 8; const hi = new Uint32Array(n); const lo = new Uint32Array(n);
  for (let i = 0; i < n; i++) { lo[i] = buf.readUInt32LE(i * 8); hi[i] = buf.readUInt32LE(i * 8 + 4); } // little-endian u8: low word first
  const lit = new Set(JSON.parse(zlib.gunzipSync(fs.readFileSync(`${dir}/lit.json.gz`)).toString('utf8')));
  const rel = JSON.parse(fs.readFileSync(`${dir}/rel_table.json`, 'utf8'));
  DATA = { dir, hi, lo, n, lit, rel, refToday: '2026-10-07' };
  return DATA;
}
export function skeletonSeen(D, key32pair) { // binary search over the sorted (hi, lo) pairs
  const [h, l] = key32pair; let a = 0; let b = D.n - 1;
  while (a <= b) { const m = (a + b) >> 1; if (D.hi[m] < h || (D.hi[m] === h && D.lo[m] < l)) a = m + 1; else if (D.hi[m] === h && D.lo[m] === l) return true; else b = m - 1; }
  return false;
}

/** placeholders: [{name:'<ENT1>', role, canon}] in order of the mentions */
export function makeCtx(ms) {
  const cnt = {}; const ph = [];
  for (const m of ms) { cnt[m.role] = (cnt[m.role] ?? 0) + 1; ph.push({ name: `<${m.role}${cnt[m.role]}>`, role: m.role, canon: m.canon, m }); }
  return { ph };
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
function fillStr(s, ctx) {
  return s.replace(/<[A-Z]+[a-z]?\d+>/g, (name) => {
    const mm = /^<([A-Z]+)([a-z]?)(\d+)>$/.exec(name); if (!mm) return name;
    const pn = `<${mm[1]}${mm[3]}>`; const p = ctx.ph.find((x) => x.name === pn);
    if (!p) throw new Error(`missing ${name}`);
    const c = p.canon; if (c == null) throw new Error('unresolved');
    if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(c);
    return mm[2] === 'l' ? c.toLowerCase() : mm[2] === 'u' ? c.toUpperCase() : mm[2] === 'c' ? cap(c) : c;
  });
}
function fillVal(v, ctx) {
  if (typeof v !== 'string') return v;
  const mm = /^<([A-Z]+)(\d+)>$/.exec(v);
  if (mm && (mm[1] === 'NUM' || mm[1] === 'MONEY')) { const p = ctx.ph.find((x) => x.name === v); if (!p) throw new Error(`missing ${v}`); return p.canon; }
  return v.includes('<') ? fillStr(v, ctx) : v;
}
/** skeleton -> plan; throws when a placeholder has no mention or a time span is unreadable */
export function unskel(o, ctx, today, D) {
  if (Array.isArray(o)) return o.map((x) => unskel(x, ctx, today, D));
  if (o && typeof o === 'object') {
    if ('@time' in o) {
      let tpl = o['@time']; const tod = tpl.endsWith('|today'); if (tod) tpl = tpl.slice(0, -6);
      const span = tpl.includes('<') ? fillStr(tpl, ctx) : tpl;
      let b = null; const rel = o['@rel'];
      if (D.rel[span]) { if (today !== D.refToday) throw new Error('relative span of another day'); b = D.rel[span]; } else b = spanBounds(span, today);
      if (!b) throw new Error(`time ${span}`);
      const res = {}; for (const k of Object.keys(o)) if (!['@time', '@keys', '@rel'].includes(k)) res[k] = unskel(o[k], ctx, today, D);
      res.span = span; res.from = b[0]; res.to = tod ? today : b[1]; if (rel) res.relative = true;
      return res;
    }
    const r = {}; for (const [k, v] of Object.entries(o)) r[k] = unskel(v, ctx, today, D); return r;
  }
  return fillVal(o, ctx);
}

const LIT_KEYS = new Set(['doc_type', 'value', 'target', 'first', 'last', 'a', 'b', 'label', 'word', 'phrase', 'topic', 'serial', 'number']);
/** every literal in the skeleton is either a closed structural word seen at >=4 companies or one of this company's own words */
export function literalOk(skel, allowed, D) {
  let bad = false;
  const walk = (o, key) => {
    if (Array.isArray(o)) for (const v of o) walk(v, key);
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, k);
    else if (typeof o === 'string' && !/<[A-Z]+[a-z]?\d+>/.test(o) && LIT_KEYS.has(key)) { if (D.lit.has(o)) return; if (allowed.has(o.toLowerCase())) return; bad = true; }
  };
  walk(skel, ''); return !bad;
}
