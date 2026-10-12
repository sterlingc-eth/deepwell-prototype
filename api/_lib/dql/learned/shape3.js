/**
 * learned/shape3.js - Donovan's learned planner, version 3: the SHAPE of a question, read over words the company-specific nouns have been masked out of.
 *
 * Version 2 (index.js) reads the words the parser left over. Version 3 reads the whole question after SLOT-MASKING: every word that belongs to this
 * company's own vocabulary card (kinds of paper, field names, staff noun, category and person values, customer names) and is not a generic word the
 * model knows (model.generic: words that name something in many companies, "invoice", "customer", "total") becomes a placeholder, numbers and dates
 * become <n>. The heads therefore learn the shape ("how many <k> for <p> in <n>") and carry over to companies whose words they never saw.
 *
 *   maskLexicon(card, names)  -> {words:Set}         the company's own words (pure; the trainer and the runtime use this same function)
 *   maskText(raw, lex, generic) -> string[]          masked tokens
 *   shapeHeads(raw, card, names) -> {pat, multi, fu, meas} | null     calibrated head readings: {label, prob} each (null when model-v3.json is absent)
 *   shapeVeto(raw, card, names, plan) -> string | null   a reason when the model is SURE the plan the families built has the wrong shape (multi-part, follow-up
 *                                                          intent), null otherwise. It can only RELEASE a question to the model, never open anything.
 * Kill switch: DONOVAN_DQL_SHAPE3=0. No network, no model API.
 */
import fs from 'node:fs';
import { crc32 } from './features.js';
const MASK21 = (1 << 21) - 1; // model-v3 hashes to 21 bits
import { classify2 } from './linear.js';

const lc = (s) => String(s ?? '').toLowerCase();
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const splitWords = (s) => lc(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));

/** the company's own words, from its vocabulary card (dql/card.js) and the customer names on file */
export function maskLexicon(card, names = []) {
  const words = new Set();
  const add = (s) => { for (const w of splitWords(s)) words.add(stem(w)); };
  for (const [id, k] of Object.entries(card?.kinds ?? {})) { add(id); add(k.label); add(k.plural); for (const h of k.heads ?? []) add(h); }
  for (const [key, f] of Object.entries(card?.fields ?? {})) {
    add(key);
    if (f.shape === 'category' || f.shape === 'person') for (const v of f.values ?? []) add(v);
  }
  for (const n of card?.staffNouns ?? []) add(n);
  for (const n of names) add(n);
  return { words };
}

export function maskText(raw, lex, generic) {
  const toks = lc(raw).replace(/[$]/g, ' $ ').split(/[^a-z0-9$]+/).filter(Boolean);
  const out = [];
  for (const t of toks) {
    if (/\d/.test(t)) { out.push('<n>'); continue; }
    const s = stem(t);
    if (lex?.words.has(s) && !generic?.has(s)) out.push('<k>'); else out.push(t);
  }
  // collapse runs of placeholders ("<k> <k>" is one name)
  return out.filter((t, i) => !(t[0] === '<' && out[i - 1] === t));
}

/** hashed features of a masked token sequence (mirrored by scripts/train-dql-shape3.py) */
export function shapeFeats(v) {
  const seq = ['^', ...v, '$'];
  const f = new Set();
  for (const t of seq) f.add(`w:${t}`);
  for (let i = 0; i < seq.length - 1; i++) f.add(`b:${seq[i]} ${seq[i + 1]}`);
  for (let i = 0; i < seq.length - 2; i++) f.add(`t:${seq[i]} ${seq[i + 1]} ${seq[i + 2]}`);
  for (let i = 0; i < seq.length - 2; i++) f.add(`sk:${seq[i]}_${seq[i + 2]}`);
  for (const t of v) if (t.length >= 4 && t[0] !== '<') { const s = ` ${t} `; for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= s.length; i++) f.add(`hc:${s.slice(i, i + n)}`); }
  f.add(`len:${Math.min(v.length, 16)}`);
  const ids = new Set(); for (const s of f) ids.add(crc32(s) & MASK21);
  return ids;
}

let STATE = null;
function load() {
  if (STATE !== null) return STATE || null;
  try {
    const model = JSON.parse(fs.readFileSync(new URL('./model-v3.json', import.meta.url), 'utf8'));
    STATE = { model, generic: new Set(model.generic) };
  } catch { STATE = false; }
  return STATE || null;
}
export const shapeEnabled = () => process.env.DONOVAN_DQL_SHAPE3 !== '0';

const LEX = new WeakMap();
/** the lexicon of one company, built once per card object (names = the customer names on file, an iterable) */
function lexicon(card, names) {
  if (!card || typeof card !== 'object') return maskLexicon(null, names ? [...names] : []);
  let l = LEX.get(card);
  if (!l) { l = maskLexicon(card, names ? [...names] : []); LEX.set(card, l); }
  return l;
}

export function shapeHeads(raw, card, names = []) {
  if (!shapeEnabled()) return null;
  const S = load();
  if (!S) return null;
  const v = maskText(raw, lexicon(card, names), S.generic);
  const ids = shapeFeats(v);
  const out = {};
  for (const h of Object.keys(S.model.heads)) { const r = classify2(S.model.heads[h], ids); out[h] = { label: r.label, prob: r.prob }; }
  return out;
}

const SIMPLE = new Set(['count', 'sum', 'avg', 'min', 'max', 'median', 'list', 'latest', 'first_ever', 'exists_yes_no', 'count_distinct']);
/** Only ever a RELEASE: the model reads the question's shape with a strict, calibrated confidence and the plan the families built contradicts it. */
export function shapeVeto(raw, card, names, plan) {
  const S = load();
  if (!S || !shapeEnabled()) return null;
  const h = shapeHeads(raw, card, names);
  if (!h) return null;
  const th = S.model.thresholds ?? {};
  const isMulti = plan?.op === 'multi' || Array.isArray(plan?.parts);
  if (!SIMPLE.has(plan?.op)) return null; // comparisons, series, groupings and sets are several-things-at-once by nature: only a plain single-answer plan is checked
  if (h.multi.label === 'multi' && h.multi.prob >= (th.multi ?? 0.99) && !isMulti) return `shape3:multi:${h.multi.prob.toFixed(3)}`;
  return null;
}
