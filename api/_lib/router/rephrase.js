/**
 * FORGE rephrase normalizer: the SAME question in different wording must reach the same answer (or the same decline).
 * Pure, regex-only, runs once on the typed text before any router. Every rule is anchored to a whole shape and only rewrites
 * wording, never a name, number or date; anything that does not match is returned unchanged (null). Kill switch: DONOVAN_REPHRASE=0.
 *   1. plural noun directly before ONE identifier ("invoices INV-2101", "permits BP-2026-1201") -> singular
 *   2. role words are never names: "how much do customers owe us" -> "how much is owed to us"
 *   3. "what did we invoice <x> in total/altogether/overall" -> "what did we bill <x> in total"
 *   4. (typoFixes/applyTypoFixes, guarded by the org's own words) a transposed/dropped/doubled letter in a small closed set of words (unpaid, overdue, outstanding, units, address, warranty) -> the word
 * (Typos in "invoice"/"invoices" themselves are handled elsewhere; this file never touches them.)
 */
const ID = String.raw`(?:inv|po|bp|wo|est|quote|qt|permit)[-#\s]?\d[\w-]*|#\s?[\w-]*\d[\w-]*`;
const PLURAL_BEFORE_ID = new RegExp(String.raw`\b(invoices|quotes|estimates|permits|purchase orders|work orders|tickets)\s+(?=(?:no\.?\s*|number\s*|#\s*)?(?:${ID}))`, "i");
const SINGULAR = { invoices: "invoice", quotes: "quote", estimates: "estimate", permits: "permit", "purchase orders": "purchase order", "work orders": "work order", tickets: "ticket" };
const ROLE_OWE = /^(?:so\s+|ok\s+|hey\s+)?(?:how\s+much|what)\s+(?:do|does|are|is)\s+(?:all\s+)?(?:our\s+|my\s+|the\s+)?(?:customers|clients)\s+(?:still\s+|currently\s+|all\s+)?(?:owe|owing)(?:\s+(?:us|me|the\s+company))?(?:\s+(?:right\s+now|today|in\s+total|altogether|overall))?\s*[?.!]*$/i;
const INVOICE_TOTAL = /^(?:(?:can\s+you\s+)?(?:tell|show)\s+me\s+|please\s+|hey\s+)?(what|how\s+much)\s+(?:did|have)\s+(we|i)\s+(?:invoice|invoiced|invoices)\s+(?!in\b|for\b|us\b)(.+?)\s+(?:in\s+)?(?:total|toal|totl|altogether|overall|all\s+together|all\s+told)(?:\s+please)?\s*[?.!]*$/i;
const STATUS_WORDS = ["unpaid", "overdue", "outstanding", "units", "address", "warranty"];
const REAL_WORDS = ["unit", "warrant", "outstand", "unpaid", "overdue"]; // forms of the words above that are themselves words: never rewritten
const TYPO_MAP = (() => {
  const m = new Map(), bad = new Set([...STATUS_WORDS, ...REAL_WORDS]);
  for (const w of STATUS_WORDS) {
    const vs = new Set();
    for (let i = 0; i < w.length - 1; i++) { vs.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); } // transposition
    for (let i = 0; i < w.length; i++) { vs.add(w.slice(0, i) + w.slice(i + 1)); vs.add(w.slice(0, i) + w[i] + w.slice(i)); } // dropped / doubled
    for (const v of vs) { if (v === w || v.length < 4) continue; if (m.has(v) || bad.has(v)) { bad.add(v); m.delete(v); continue; } m.set(v, w); }
  }
  return m;
})();
export function rephraseEnabled() { return process.env.DONOVAN_REPHRASE !== "0"; }
/** @returns {string|null} the rewritten question, or null when nothing applied */
export function normalizeRephrase(question) {
  let q = String(question ?? ""), changed = false;
  const set = (n) => { if (n !== q) { q = n; changed = true; } };
  set(q.replace(PLURAL_BEFORE_ID, (_m, p) => SINGULAR[p.toLowerCase()] + " "));
  if (ROLE_OWE.test(q.trim())) set("how much is owed to us");
  const m = INVOICE_TOTAL.exec(q.trim());
  if (m) set(`${m[1]} did ${m[2]} bill ${m[3]} in total`);
  return changed ? q : null;
}
/**
 * Word typos (rule 4) are only SAFE when the word is not part of a name, so they are two steps: this returns the candidate fixes
 * [{from, to}] (never a capitalized token that is not the first word, never a token touching a capitalized token, i.e. a name-shaped phrase),
 * and the caller applies them with applyTypoFixes ONLY after confirming the organization's own data does not contain the token
 * (a customer called "Verdue Plumbing" or "Npaid"). If that check cannot run, skip the rewrite.
 */
export function typoFixes(question) {
  const toks = [...String(question ?? "").matchAll(/[A-Za-z]+/g)]; const out = [];
  toks.forEach((m, i) => {
    const w = m[0]; if (w.length < 4) return; const to = TYPO_MAP.get(w.toLowerCase()); if (!to) return;
    const cap = (t) => t && /^[A-Z]/.test(t[0]) && !(t.index === 0 && t[0].length < 2);
    if (/^[A-Z]/.test(w) && (i > 0 || toks.length > 1 && /^[A-Z]/.test(toks[1][0]))) return; // capitalized mid-sentence or leading a capitalized phrase
    if (cap(toks[i - 1]) && i - 1 > 0) return; // right after a capitalized (non-first) word
    if (i === 1 && /^[A-Z]/.test(toks[0][0]) && toks[0][0].length > 1 && !/^(?:how|what|who|when|where|why|which|show|list|tell|is|are|do|does|did|can)$/i.test(toks[0][0])) return;
    out.push({ from: w, to });
  });
  return out;
}
export function applyTypoFixes(question, fixes) {
  let q = String(question ?? "");
  for (const f of fixes) q = q.replace(new RegExp(`\\b${f.from}\\b`), f.to);
  return q;
}
