/** synlex1.js - port of lib/synlex1.py (syn_lex_v1): release a clause-sentence answer when the question names a multi-word FIELD label of the company's schema. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './models.js';
import * as H3 from './hardv3.js';
import * as H4 from './hardv4.js';
import * as MP1 from './mainpair1.js';

let CFG = { on: false, rules: ['field_sentence'] }; let LAB = null;
export const configure = (d) => { CFG = { on: !!(d && d.on), rules: [...((d && d.rules && d.rules.length) ? d.rules : ['field_sentence'])] }; };
export const on = () => CFG.on;
function labels() {
  if (LAB === null) {
    try { const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'synlex1_labels.json'), 'utf8')); const skip = new Set(d.skip || []); LAB = d.labels.filter((l) => !skip.has(l)); } catch (e) { LAB = []; }
  }
  return LAB;
}
const LABRX = /^[A-Z][A-Za-z ]{2,28}:/;
const isSentence = (t) => t.slice(0, 400).includes('(page') && !LABRX.test(t) && !H4.ansType(t);
function fieldSentence(q, t) {
  if (!isSentence(t)) return false;
  q = MP1.stripDocname(q);
  const qt = H3.words(H3.stripTail(q)).filter((w) => w.length >= 3).map(H4.st);
  return labels().some((L) => H4.contig(L, qt));
}
const RULES = { field_sentence: fieldSentence };
export function check(q, c) {
  if (!on()) return null;
  const t = String(c.text || '');
  for (const name of CFG.rules) { const f = RULES[name]; try { if (f && f(q, t)) return name; } catch (e) { /* swallowed like the reference */ } }
  return null;
}
export function mark(q, res) { if (!on()) return; for (const [, c] of res) { const r = check(q, c); if (r) c._sl1 = r; } }
