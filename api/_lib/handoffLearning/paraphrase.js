/**
 * handoffLearning/paraphrase.js - automatic paraphrases of a handed-off question, made without any model: neutral wrappers (greeting, polite lead-in, thanks) and slot swaps (another
 * customer of the same organization, another year). The learning is tested on each of them against the SAME paraphrase written in words the engine already knows. Pure + seeded.
 */
const LEAD = ['', 'can you tell me ', 'please tell me ', 'quick question: ', 'i need to know ', 'could you check ', 'hey, '];
const TAIL = ['', ' please', ' thanks', ' for me'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rnd(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const hash = (str) => { let h = 2166136261; for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
const lc1 = (q) => (/^[A-Z][a-z]/.test(q) ? q[0].toLowerCase() + q.slice(1) : q);

/** @returns {string[]} paraphrases of `question` (without the question itself) */
export function paraphrases(question, { customers = [], years = [], max = 10 } = {}) {
  const q0 = String(question).trim().replace(/[?.!]+$/, '');
  const r = rnd(hash(q0));
  const out = new Set();
  const wrap = (q) => { const l = LEAD[Math.floor(r() * LEAD.length)]; const t = TAIL[Math.floor(r() * TAIL.length)]; return `${l}${l ? lc1(q) : q}${t}`.trim(); };
  for (let i = 0; i < 4; i++) out.add(wrap(q0));
  // slot swaps: another customer name, another year
  const names = customers.filter((n) => n.length >= 5).sort((a, b) => b.length - a.length);
  const here = names.find((n) => new RegExp(`\\b${esc(n)}\\b`, 'i').test(q0));
  if (here) for (let k = 0; k < 3; k++) { const other = names[Math.floor(r() * names.length)]; if (other && other.toLowerCase() !== here.toLowerCase()) out.add(wrap(q0.replace(new RegExp(`\\b${esc(here)}\\b`, 'i'), other))); }
  const ym = q0.match(/\b(20\d\d)\b/);
  if (ym && years.length) for (let k = 0; k < 3; k++) { const y = String(years[Math.floor(r() * years.length)]); if (y !== ym[1]) out.add(wrap(q0.replace(ym[1], y))); }
  out.delete(q0);
  return [...out].slice(0, max);
}
export function removeWord(text, word) { return String(text).replace(new RegExp(`(?<![\\w'-])${esc(word)}(?![\\w-])\\s*`, 'gi'), '').replace(/\s+/g, ' ').trim(); }
