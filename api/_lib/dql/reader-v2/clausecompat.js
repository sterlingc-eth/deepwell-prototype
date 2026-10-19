/** clausecompat.js - port of lib/clausecompat.py (clause_retrain_v2): selective veto - release when another shortlist sentence fits the question's unit class clearly better than the chosen one. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './models.js';

let CFG = {};
export const configure = (d) => { CFG = { ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const STOP = new Set('the a an of in on for to is are what whats does do how it its it\'s my me i this that and or from with about say says per there any have has under when which who'.split(' '));
function toks(q) {
  const ws = (q.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6));
  const s = new Set(ws); for (let i = 0; i + 1 < ws.length; i++) s.add(ws[i] + '_' + ws[i + 1]);
  return s;
}
function pf(p) {
  const t = p.split(' | ').pop(); const s = [];
  if (t.includes('%')) s.push('P');
  if (/\bdays?\b/.test(t)) s.push('D');
  if (t.includes('$')) s.push('$');
  if (/\bmonths?\b/.test(t)) s.push('M');
  if (/\byears?\b/.test(t)) s.push('Y');
  if (/\d/.test(t)) s.push('N');
  if (!s.length) s.push('0');
  if (/^[A-Za-z ]+:/.test(t)) s.push('F');
  return s;
}
let MODEL = null;
function model() { if (!MODEL) { const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'clausecompat_model.json'), 'utf8')); MODEL = { w: new Map(Object.entries(d.w)), b: d.b }; } return MODEL; }
export function scores(q, ps) {
  const m = model(); const w = m.w; const qt = [...toks(q)]; const out = [];
  for (const p of ps) {
    let z = m.b; const pc = pf(p);
    for (const c of pc) { z += w.get('_|' + c) ?? 0.0; for (const t of qt) z += w.get(t + '|' + c) ?? 0.0; }
    out.push(z);
  }
  return out;
}
export function veto(q, ps, chosen) {
  if (!ps || !ps.length || chosen === null || chosen === undefined || !(chosen >= 0 && chosen < ps.length)) return false;
  const s = scores(q, ps); return (Math.max(...s) - s[chosen]) > Number(CFG.T ?? 3.0);
}
