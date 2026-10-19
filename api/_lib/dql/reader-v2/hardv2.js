/** hardv2.js - port of lib/hardv2.py (hard_v2): release rules for wrong-prone patterns (question text + candidate answer text). */
import { ratio } from './difflib.js';

const DEFAULT_RULES = ['field_qual', 'units_rank_money', 'delinq_total'];
let CFG = { on: false, rules: [...DEFAULT_RULES] };
export const configure = (d) => { CFG = { on: !!(d && d.on), rules: [...((d && d.rules && d.rules.length) ? d.rules : DEFAULT_RULES)] }; };
export const on = () => CFG.on;
const sim = (w, x) => w.length >= 4 && w !== 'emily' && ratio(w.split('-').join(''), x) >= 0.78;
export function contactField(q, t, intent) {
  if (intent !== 'contact') return false;
  const toks = q.toLowerCase().match(/[a-z@-]+/g) || []; const n = toks.length;
  let em = false, ph = false;
  for (let i = 0; i < n; i++) if (sim(toks[i], 'email') && i + 1 < n && ['address', 'addr', 'adress', 'addres'].includes(toks[i + 1])) { em = true; break; }
  for (let i = 0; i < n; i++) if (sim(toks[i], 'phone') && i > 0 && toks[i - 1] !== 'my' && i + 1 < n && ['number', 'nubmer', 'num', 'no', 'numbr'].includes(toks[i + 1])) { ph = true; break; }
  if (em && !ph && !t.includes('@')) return true;
  if (ph && !em && !/\d{3}[-. )]+\d{3,4}/.test(t)) return true;
  return false;
}
const STOPW = new Set(['this', 'that', 'with', 'from', 'have', 'year', 'dollars', 'under', 'than', 'what', 'were', 'does', 'many', 'there']);
export function filtIgnored(q, t, intent) {
  if (!['count', 'list', 'max', 'min', 'sum', 'latest', 'earliest', 'count_year'].includes(intent)) return false;
  const ql = q.toLowerCase();
  const m = /\b(and (?:that are|that is|that were|whose|with|where|marked|which are)|whose|and marked|marked)\s+([a-z' ]{3,40})/.exec(ql);
  if (!m) return false;
  const cond = (m[2].match(/[a-z]{4,}/g) || []).filter((w) => !STOPW.has(w));
  if (!cond.length) return false;
  const tl = t.toLowerCase();
  if (/^(0 |[^:]{0,80}has 0 )/.test(tl) || tl.slice(0, 60).includes(' 0 ')) return false;
  return !cond.some((w) => tl.includes(w.slice(0, 5)));
}
const resaleFee = (q, t) => t.startsWith('Resale certificate fee');
const fieldQual = (q, t) => (t.startsWith('Appraiser:') || t.startsWith('Inspector:')) && /\b(fees?|charges?|costs?|repairs?|requires?|requirements?)\b/.test(q.toLowerCase());
const unitsRankMoney = (q, t) => /^total units (lowest|highest)/i.test(t) && /\$|\bdollars?\b|\b\d+\s?k\b|\bthousand\b/.test(q.toLowerCase());
const delinqTotal = (q, t) => t.startsWith('Total:') && /\bdel\w*q\w*\b/.test(q.toLowerCase());
const RULES = { units_rank_money: unitsRankMoney, delinq_total: delinqTotal, field_qual: fieldQual, contact_field: contactField, filt_ignored: filtIgnored, resale_fee: resaleFee };
export function check(q, c) {
  if (!on()) return null;
  const t = String(c.text || ''); const it = c.intent;
  for (const name of CFG.rules) { const f = RULES[name]; try { if (f && f(q, t, it)) return name; } catch (e) { /* swallowed like the reference */ } }
  return null;
}
export function mark(q, res) { if (!on()) return; for (const [, c] of res) { const r = check(q, c); if (r) c._hv2 = r; } }
