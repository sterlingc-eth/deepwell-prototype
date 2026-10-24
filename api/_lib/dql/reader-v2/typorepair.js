/** typorepair.js - port of lib/typorepair.py (typo_repair_v1): the same answer from the spelling-repaired question is an extra candidate. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './models.js';
import { dataPath } from './unified1.js';
import { norm } from './reader2.js';

const DEF = { on: false, min_len: 5, max_changes: 3, skip_clause: true, intents: null, collect: false, agree: true, max_parts: 1 };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const enabled = () => !!(CFG.on || CFG.collect);
const W = /[A-Za-z]+/g;
function d1(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1 || a === b) return false;
  if (la === lb) {
    let i = 0; while (a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  if (la > lb) { const t = a; a = b; b = t; }
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i) === b.slice(i + 1);
}
let STATIC = null;
function staticWords() {
  if (!STATIC) STATIC = new Set(JSON.parse(fs.readFileSync(dataPath(DATA_DIR, 'typo_static.json'), 'utf8')));
  return STATIC;
}
const words = (s) => (String(s).toLowerCase().match(W) || []);
const VC = new WeakMap();
function vocab(ix) {
  let r = VC.get(ix); if (r) return r;
  const N = new Set();
  for (const e of ix.c.cust.values()) for (const f of ['customer_name', 'service_address', 'email', 'phone', 'city', 'contact_email']) for (const w of words(((e.data || {})[f]) || '')) N.add(w);
  let V = new Set(staticWords());
  for (const ph of ix.tphr.values()) for (const p of ph) for (const w of words(p)) V.add(w);
  for (const h of ix.fields.values()) for (const w of words(h)) V.add(w);
  for (const L of ix.lines.values()) for (const it of L) for (const w of words(it.length > 1 ? it[1] : '')) V.add(w);
  V = new Set([...V].filter((w) => w.length >= 3 && !N.has(w)));
  const by = new Map(); for (const w of V) { const l = by.get(w.length); if (l) l.push(w); else by.set(w.length, [w]); }
  r = [V, N, by]; VC.set(ix, r); return r;
}
export function repair(q, ix) {
  const [V, N, by] = vocab(ix); const ml = Number(CFG.min_len); let ch = 0; const out = []; let pos = 0;
  for (const m of q.matchAll(W)) {
    const t = m[0]; const tl = t.toLowerCase(); let nw = null;
    if (tl.length >= ml && !V.has(tl) && !N.has(tl) && !(t[0] >= 'A' && t[0] <= 'Z') && !(tl.endsWith('s') && (V.has(tl.slice(0, -1)) || N.has(tl.slice(0, -1))))) {
      const nb = []; for (const L of [by.get(tl.length - 1) || [], by.get(tl.length) || [], by.get(tl.length + 1) || []]) for (const w of L) if (d1(tl, w)) nb.push(w);
      if (nb.length === 1 && !N.has(nb[0])) nw = nb[0];
    }
    out.push(q.slice(pos, m.index)); out.push(nw || t); pos = m.index + t.length; if (nw) ch++;
  }
  out.push(q.slice(pos));
  return [out.join(''), ch];
}
const VETO = ['_wp2_veto', '_wp_veto', '_mp_veto', '_mp2_veto', '_pv1_veto', '_mr2_veto', '_hv2', '_hv3', '_hv4', '_sl1', '_rp_veto', '_hp_veto'];
const CL = /\.\s*\(page/;
const ZERO = /(^|\s)0 [A-Za-z]|\bhas 0\b|: \$0(\.00)?\b/;
const FP = /\(([^()]*)\)\.?\s*$/;
function risky(text) {
  const t = String(text || '');
  if (ZERO.test(t)) return true;
  const m = FP.exec(t);
  return !!(m && m[1].split(',').length > Number(CFG.max_parts ?? 1));
}
const sameSet = (a, b) => { const x = new Set(a || []), y = new Set(b || []); if (x.size !== y.size) return false; for (const v of x) if (!y.has(v)) return false; return true; };
export async function rerun(ix, q, M, res, out, base) {
  const c = CFG; const o = res.filter((z) => z[0] === 2);
  if (c.agree && !o.length) return null;
  const c0 = o.length ? o[0][1] : null;
  if (c0 !== null) {
    if (VETO.some((k) => c0[k])) return null;
    if (c.skip_clause && CL.test(String(c0.text || ''))) return null;
    if (risky(c0.text)) return null;
  }
  if (c.intents && !c.intents.includes(out.intent)) return null;
  const [q2, ch] = repair(q, ix);
  if (ch === 0 || ch > Number(c.max_changes)) return null;
  const [res2, out2] = await base(ix, q2, M, null);
  for (const [s2, c2, v2] of res2) {
    if (s2 !== 2) continue;
    if (c.agree) {
      if (norm(c2.text) !== norm(c0.text)) continue;
      if (!sameSet(c2.docs, c0.docs)) continue;
      if (out2.intent !== out.intent) continue;
    } else if (c.skip_clause && CL.test(String(c2.text || ''))) continue;
    if (risky(c2.text)) continue;
    if (VETO.some((k) => c2[k])) continue;
    c2._trp = ch;
    return [[...res, [2, c2, v2]], out];
  }
  return null;
}
