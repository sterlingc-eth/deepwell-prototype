/**
 * handoffLearning/overlay.js - the adopted learnings of ONE organization in the shape the parser reads. Pure.
 *
 *   overlay = { version, fillers: Set<string>, rewrites: [{from, to, re}] }
 *     fillers   words the parser may ignore (they carry no condition)
 *     rewrites  a wording the organization uses -> the words the parser already understands (word -> entity / kind of paper / dimension / operator; wording -> operator or noun phrase)
 *   applyRewrites(text, overlay, vocab)   whole-word, case-insensitive; never inside a name this organization has on file
 * parse.js reads `ctx.handoff ?? tenantVocab.handoff` and does nothing at all when there is none.
 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildOverlay(rows, { shared = [] } = {}) {
  const fillers = new Set(); const rewrites = []; const seen = new Set();
  const take = (r, origin) => {
    const phrase = String(r.phrase ?? '').toLowerCase().trim();
    if (!phrase || !/^[a-z][a-z' -]{0,40}$/.test(phrase)) return;
    if (r.kind === 'filler') { if (!phrase.includes(' ')) fillers.add(phrase); return; }
    const to = String(r.canonical ?? '').toLowerCase().trim();
    if (!to || !/^[a-z][a-z' -]{0,40}$/.test(to) || to === phrase) return;
    if (seen.has(phrase)) return; // the organization's own learning wins over a shared one
    seen.add(phrase);
    rewrites.push({ from: phrase, to, origin, re: new RegExp(`(?<![\\w'-])${esc(phrase).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'gi') });
  };
  for (const r of rows ?? []) take(r, 'own');
  for (const r of shared ?? []) take(r, 'shared');
  rewrites.sort((a, b) => b.from.length - a.from.length);
  return { fillers, rewrites, size: fillers.size + rewrites.length };
}
export const EMPTY_OVERLAY = Object.freeze({ fillers: new Set(), rewrites: [], size: 0 });

/** Words that name a person or place of this organization: a learned wording is never applied to them. */
const nameWordsCache = new WeakMap();
export function nameWordSet(vocab) {
  if (!vocab || typeof vocab !== 'object') return new Set();
  let s = nameWordsCache.get(vocab);
  if (s) return s;
  s = new Set();
  const add = (p) => { for (const w of String(p).toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 2) s.add(w); };
  for (const key of ['customers', 'technicians']) for (const p of vocab[key]?.phrases ?? []) add(p);
  for (const p of vocab.cities ?? []) add(p);
  for (const p of vocab.brands ?? []) add(p);
  for (const p of vocab.models ?? []) add(String(p).split(/\s+serial/i)[0]);
  for (const p of vocab.dql?.categorical?.vendor ?? []) add(p);
  for (const p of vocab.dql?.card?.staffNames ?? []) add(p);
  for (const vals of Object.values(vocab.dql?.categorical ?? {})) if (Array.isArray(vals)) for (const p of vals) add(p);
  nameWordsCache.set(vocab, s);
  return s;
}

export function applyRewrites(text, overlay, vocab = null) {
  if (!overlay?.rewrites?.length) return text;
  const names = vocab ? nameWordSet(vocab) : null;
  let t = String(text);
  for (const r of overlay.rewrites) {
    r.re.lastIndex = 0;
    if (names && r.from.split(' ').some((w) => names.has(w))) continue;
    t = t.replace(r.re, r.to);
  }
  return t;
}
