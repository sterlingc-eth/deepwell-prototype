/**
 * dql/reader-ml/anon.js - the anonymizer the learned reader was trained with (learned_reader/lrcore.py: mentions + anon_text), in JavaScript.
 * Company words in the question (customer, staff, city, stored value, kind of paper, date, year, amount, number, id, quoted text) become role tokens
 * (<ENT> <STAFF> <CITY> <VALUE> <DT> <DATE> <YEAR> <MONEY> <NUM> <ID> <TXT> <NICK> <MONYR>); the same spans later fill the plan's slots.
 * The company's vocabulary comes from its own records (the snapshot) plus the request's tenant vocabulary.
 */
const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const STOP = new Set('of the a an and or for to in on at by with from per last new old other record records form forms sheet report slip note notes order orders list log'.split(' '));
export function stem(w) {
  w = w.toLowerCase();
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mon = (s) => { const l = s.toLowerCase(); return l.slice(0, 4) === 'sept' ? 9 : MONTHS.findIndex((m) => m.startsWith(l.slice(0, 3))) + 1; };
const validDate = (y, m, d) => { if (m < 1 || m > 12 || d < 1) return null; const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

/** The company's vocabulary for the anonymizer. cust/staff/city/vals/docTypes are arrays of strings. */
export function buildAnonVocab({ cust = [], staff = [], city = [], vals = [], docTypes = [] }) {
  const V = { cust: new Set(cust.filter(Boolean)), staff: new Set(staff.filter(Boolean)), city: new Set(city.filter(Boolean)), val: new Set(vals.filter(Boolean)), dts: [...new Set(docTypes.filter(Boolean))].sort() };
  const names = [];
  for (const n of V.cust) names.push([n, 'ENT', n]);
  for (const n of V.staff) if (!V.cust.has(n)) names.push([n, 'STAFF', n]);
  for (const n of V.city) names.push([n, 'CITY', n]);
  for (const n of V.val) names.push([n, 'VALUE', n]);
  names.sort((a, b) => b[0].length - a[0].length);
  const seen = new Set(); const lst = [];
  for (const [s, r, c] of names) { const k = s.toLowerCase(); if (seen.has(k)) continue; seen.add(k); lst.push([k, r, c]); }
  V.lookup = new Map(lst.map(([k, r, c]) => [k.replace(/\s+/g, ' '), [r, c]]));
  V.rx = lst.length ? new RegExp(`(?<![a-z0-9])(?:${lst.map(([k]) => esc(k).replace(/\\? /g, '\\s+')).join('|')})(?:'s)?(?![a-z0-9])`, 'g') : null;
  const firsts = new Set(); const lasts = new Set(); const nickcanon = new Map();
  for (const n of new Set([...V.cust, ...V.staff])) {
    const p = n.split(/\s+/); if (p.length >= 2) { firsts.add(p[0].toLowerCase()); lasts.add(p[p.length - 1].toLowerCase()); if (!nickcanon.has(p[0].toLowerCase())) nickcanon.set(p[0].toLowerCase(), p[0]); if (!nickcanon.has(p[p.length - 1].toLowerCase())) nickcanon.set(p[p.length - 1].toLowerCase(), p[p.length - 1]); }
  }
  V.firsts = firsts; V.lasts = lasts; V.nickcanon = nickcanon;
  const tokc = new Map();
  for (const d of V.dts) for (const t of new Set(d.split('-').filter(Boolean).map(stem))) if (!STOP.has(t)) { if (!tokc.has(t)) tokc.set(t, new Set()); tokc.get(t).add(d); }
  V.tokc = tokc;
  return V;
}

const MONNAME = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const RX = {
  quote: /"([^"]{2,60})"|“([^”]{2,60})”/g,
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/g, ymd: /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/g, mdy: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, mdy2s: /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/g,
  mdy2: new RegExp(`\\b(${MONNAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'),
  dmy: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONNAME})\\.?,?\\s+(\\d{4})\\b`, 'gi'),
  id: /\b[A-Za-z]{1,3}-\d{3,5}\b|\b[A-Za-z0-9]{1,2}\d{6,}\b/g,
  money: /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[km]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|bucks|usd)\b/gi,
  monyr: new RegExp(`\\b(${MONNAME})\\.?,?\\s+((?:19|20)\\d{2})\\b`, 'gi'),
  year: /\b(?:19|20)\d{2}\b/g, num: /\b\d[\d,]*(?:\.\d+)?\b/g,
  numword: new RegExp(`\\b(?:${Object.keys(NUMW).sort((a, b) => b.length - a.length).join('|')})(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?\\b`, 'gi'),
};
const numword = (s) => s.toLowerCase().replace(/-/g, ' ').split(/\s+/).reduce((a, w) => a + (NUMW[w] ?? 0), 0);

/** [{s, e, role, canon}] sorted by start, non-overlapping */
export function mentions(text, V) {
  const low = text.toLowerCase(); const used = new Uint8Array(text.length); const out = [];
  const add = (s, e, role, canon) => { for (let i = s; i < e; i++) if (used[i]) return; for (let i = s; i < e; i++) used[i] = 1; out.push({ s, e, role, canon }); };
  const each = (rx, fn) => { rx.lastIndex = 0; let m; while ((m = rx.exec(text))) { fn(m); if (m[0] === '') rx.lastIndex++; } };
  each(RX.quote, (m) => add(m.index, m.index + m[0].length, 'TXT', m[1] ?? m[2]));
  if (V.rx) {
    V.rx.lastIndex = 0; let m;
    while ((m = V.rx.exec(low))) {
      let s = m.index; let e = s + m[0].length; let t = low.slice(s, e).replace(/\s+/g, ' ');
      if (t.endsWith("'s")) { t = t.slice(0, -2); e -= 2; }
      const hit = V.lookup.get(t); if (hit) add(s, e, hit[0], hit[1]);
    }
  }
  each(RX.iso, (m) => add(m.index, m.index + m[0].length, 'DATE', m[0]));
  each(RX.ymd, (m) => { const d = validDate(+m[1], +m[2], +m[3]); if (d) add(m.index, m.index + m[0].length, 'DATE', d); });
  each(RX.mdy, (m) => { const d = validDate(+m[3], +m[1], +m[2]); if (d) add(m.index, m.index + m[0].length, 'DATE', d); });
  each(RX.mdy2s, (m) => { const d = validDate(2000 + +m[3], +m[1], +m[2]); if (d) add(m.index, m.index + m[0].length, 'DATE', d); });
  each(RX.mdy2, (m) => { const d = validDate(+m[3], mon(m[1]), +m[2]); if (d) add(m.index, m.index + m[0].length, 'DATE', d); });
  each(RX.dmy, (m) => { const d = validDate(+m[3], mon(m[2]), +m[1]); if (d) add(m.index, m.index + m[0].length, 'DATE', d); });
  each(RX.id, (m) => add(m.index, m.index + m[0].length, 'ID', m[0].toUpperCase()));
  each(RX.money, (m) => {
    const t = m[0].toLowerCase(); const mult = /\dk\b|\d\s?k\b/.test(t) ? 1000 : /\dm\b/.test(t) ? 1000000 : 1;
    const v = parseFloat(t.replace(/k/g, '').replace(/m/g, '').replace(/[^\d.]/g, '')); if (Number.isFinite(v)) add(m.index, m.index + m[0].length, 'MONEY', v * mult);
  });
  each(RX.monyr, (m) => add(m.index, m.index + m[0].length, 'MONYR', `${String(mon(m[1])).padStart(2, '0')}/${m[2]}`));
  each(RX.year, (m) => add(m.index, m.index + m[0].length, 'YEAR', m[0]));
  each(RX.num, (m) => { const v = parseFloat(m[0].replace(/,/g, '')); if (Number.isFinite(v)) add(m.index, m.index + m[0].length, 'NUM', v); });
  each(RX.numword, (m) => { const v = numword(m[0]); if (v || m[0].toLowerCase() === 'zero') add(m.index, m.index + m[0].length, 'NUM', v); });
  // kinds of paper: runs of words that are heads of a stored paper kind
  const toks = []; { const rx = /[A-Za-z][A-Za-z-]*/g; let m; while ((m = rx.exec(text))) toks.push([m.index, m.index + m[0].length, stem(m[0])]); }
  const anyUsed = (s, e) => { for (let i = s; i < e; i++) if (used[i]) return true; return false; };
  let i = 0; const tc = V.tokc;
  while (i < toks.length) {
    const [s, , t] = toks[i];
    if (tc.has(t) && !anyUsed(s, toks[i][1])) {
      let j = i; let cand = new Set(tc.get(t));
      while (j + 1 < toks.length && tc.has(toks[j + 1][2]) && !anyUsed(toks[j + 1][0], toks[j + 1][1]) && /^\s+$/.test(text.slice(toks[j][1], toks[j + 1][0]))) {
        const nc = new Set([...cand].filter((x) => tc.get(toks[j + 1][2]).has(x))); if (!nc.size) break; cand = nc; j++;
      }
      add(s, toks[j][1], 'DT', cand.size === 1 ? [...cand][0] : null); i = j + 1;
    } else i++;
  }
  { const rx = /[A-Za-z]+/g; let m; while ((m = rx.exec(text))) { const w = m[0].toLowerCase(); if ((V.firsts.has(w) || V.lasts.has(w)) && !anyUsed(m.index, m.index + m[0].length) && w.length > 2) add(m.index, m.index + m[0].length, 'NICK', V.nickcanon.get(w) ?? m[0]); } }
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return out;
}

export function anonText(text, ms) {
  const parts = []; let p = 0;
  for (const m of ms) { parts.push(text.slice(p, m.s)); parts.push(` @${m.role}@ `); p = m.e; }
  parts.push(text.slice(p));
  let t = parts.join('').toLowerCase();
  t = t.replace(/[^a-z0-9@$%\s\-']/g, ' ');
  t = t.replace(/@(\w+)@/g, (_, r) => `<${r.toUpperCase()}>`);
  return t.replace(/\s+/g, ' ').trim();
}
