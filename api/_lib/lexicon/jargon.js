/**
 * J1: the jargon lexicon at question time. Pure: no DB, no model, no network.
 *
 * Two jobs, both driven by the curated data in jargon.generated.js (scripts/build-lexicon.mjs):
 *
 *  1. respellJargon(question)  -> { text, hits } | null
 *     People say the same thing in other words ("pay app", "packing list", "comfort club", "foreman", "prior month"). The question lanes
 *     only read one word for each ("invoice", "delivery ticket", "maintenance agreement", "technician", "last month"). This respells the
 *     SPELLING of a known jargon phrase to that word and never touches a name, a number, or a phrase the research marked ambiguous.
 *     The caller (router/classifyAll.js) adopts the respelled text only when a deterministic lane then claims it.
 *
 *  2. untrackedConcept(question) -> { id, phrase } | null
 *     Things DeepWell does not record at all (retainage, commissions, change orders, payroll...). The early decline answers these honestly,
 *     without a model call, instead of letting a nearby lane answer a different question.
 *
 * It maps a phrase to a word, never a question to an answer: the lanes still compute every answer from the records.
 * Tokenising and singularising must stay identical to scripts/build-lexicon.mjs (verify-jargon.ts checks that).
 */
import { RESPELL, CANON_PLURAL, UNTRACKED, AMBIGUOUS, DATE_CANON, PLURAL_ONLY, HOLD, HOLD_NEAR, GENERIC_KEYS } from "./jargon.generated.js";

const TOKEN_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g;
const MAX_WORDS = 6;

function singularToken(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|us|is|ous)$/.test(w)) return w;
  if (/(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}
const norm = (t) => t.toLowerCase().replace(/['’]/g, "");

let RESP = null;
let UNT = null;
let AMB = null;
let DATES = null;
let PLU = null;
let HOLDS = null;
let GEN = null;
function tables() {
  if (RESP) return;
  RESP = new Map();
  for (const [canon, keys] of Object.entries(RESPELL)) for (const k of keys) RESP.set(k, canon);
  UNT = new Map();
  for (const [id, keys] of Object.entries(UNTRACKED)) for (const k of keys) UNT.set(k, id);
  AMB = new Set(AMBIGUOUS);
  DATES = new Set(DATE_CANON);
  PLU = new Set(PLURAL_ONLY);
  GEN = new Set(GENERIC_KEYS);
  // "*tenant improvement": the starred word stays as typed. Stored as { pre, word, post } word lists (singular last token, like the keys).
  HOLDS = [];
  for (const h of HOLD) {
    const ws = h.toLowerCase().split(/\s+/).filter(Boolean);
    const at = ws.findIndex((w) => w.startsWith("*"));
    if (at < 0) continue;
    const sing = (w) => singularToken(w.replace(/^\*/, ""));
    HOLDS.push({ pre: ws.slice(0, at).map(sing), word: sing(ws[at]), post: ws.slice(at + 1).map(sing) });
  }
}

const NOT_NAME = new Set("january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday i deepwell donovan".split(" "));
/** Does the question type a name the respell would drop? A Capitalised word after the first, or the noun itself right after to/for/with/from/at with no article. A name the tenant knows is fine: the lane reads it. */
function typedAsName(src, toks, i, len) {
  const known = typedAsName.known ?? new Set();
  for (let j = 1; j < toks.length; j++) {
    const t = toks[j];
    if (!/^[A-Z][a-z]/.test(src.slice(t.s, t.e)) || NOT_NAME.has(t.w) || known.has(t.w) || /^(?:in|near|around|within|across|and|or)$/.test(toks[j - 1].w)) continue; // a place after "in" is a filter the lanes read
    return true;
  }
  const first = toks[i];
  if (i > 0 && /^(?:to|for|with|from|at)$/.test(toks[i - 1].w) && /^[\s]+$/.test(src.slice(toks[i - 1].e, first.s)) && !known.has(first.w)) return true;
  return false;
}

/** True when the word at token i is part of a phrase that means something else ("tenant improvement", "member id", "club member"). */
function held(toks, i) {
  const w = singularToken(toks[i].w);
  for (const h of HOLDS) {
    if (h.word !== w) continue;
    let ok = true;
    for (let k = 0; k < h.pre.length && ok; k++) { const t = toks[i - h.pre.length + k]; if (!t || singularToken(t.w) !== h.pre[k]) ok = false; }
    for (let k = 0; k < h.post.length && ok; k++) { const t = toks[i + 1 + k]; if (!t || singularToken(t.w) !== h.post[k]) ok = false; }
    if (ok) return true;
  }
  return false;
}

/** Tokens of a question with their character spans. */
function scan(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TOKEN_RE)) out.push({ w: norm(m[0]), s: m.index, e: m.index + m[0].length });
  return out;
}
const keyAt = (toks, i, len) => {
  const ws = toks.slice(i, i + len).map((t) => t.w);
  ws[ws.length - 1] = singularToken(ws[ws.length - 1]);
  return ws.join(" ");
};
const isPluralWord = (w) => /s$/.test(w) && !/(ss|us|is|ous)$/.test(w) && w.length > 3;

/** Words that are one of this tenant's customer or technician names: a jargon phrase made of them is a name, not jargon. */
function nameWords(tenantVocab) {
  const set = new Set();
  for (const g of [tenantVocab?.customers, tenantVocab?.technicians]) for (const w of g?.words ?? []) set.add(String(w).toLowerCase());
  return set;
}

/** True when `phrase` (a jargon term) is one the research marked ambiguous: it is never mapped automatically. */
export function isAmbiguousJargon(phrase) {
  tables();
  const toks = scan(phrase);
  return toks.length ? AMB.has(keyAt(toks, 0, toks.length)) : false;
}

/** The canonical word for a jargon phrase, or null. (Used by tests and the Donovan explain path.) */
export function canonicalFor(phrase) {
  tables();
  const toks = scan(phrase);
  return toks.length && toks.length <= MAX_WORDS ? (RESP.get(keyAt(toks, 0, toks.length)) ?? null) : null;
}

export const jargonEnabled = () => process.env.DONOVAN_JARGON !== "0";

/**
 * Respell known jargon phrases to the canonical word. Longest phrase first, left to right, non-overlapping.
 * @returns {{ text: string, hits: Array<{ from: string, to: string, date: boolean }> } | null}  null when nothing changed
 */
export function respellJargon(question, { tenantVocab } = {}) {
  tables();
  const src = String(question ?? "");
  if (!src.trim() || src.length > 300) return null;
  const toks = scan(src);
  if (!toks.length) return null;
  const names = nameWords(tenantVocab);
  typedAsName.known = names;
  const hits = [];
  let out = "";
  let cursor = 0;
  for (let i = 0; i < toks.length; ) {
    let hit = null;
    for (let len = Math.min(MAX_WORDS, toks.length - i); len >= 1 && !hit; len--) {
      const key = keyAt(toks, i, len);
      const canon = RESP.get(key);
      if (!canon) continue;
      const span = toks.slice(i, i + len);
      // a plural-only word ("billings" is revenue; "billing address" is not)
      if (PLU.has(key) && !isPluralWord(toks[i + len - 1].w)) continue;
      // a phrase that means something else in a business that keeps paperwork stays as typed
      if (span.some((_, j) => held(toks, i + j))) continue;
      // a word that is mapped only when no context word says it means something else ("retainer" near dental words)
      if (HOLD_NEAR[key] && toks.some((t) => HOLD_NEAR[key].includes(t.w))) continue;
      // a generic noun typed as a name ("lease anything to Donor", "show me Donor") is a name, not the noun
      if (GEN.has(key) && typedAsName(src, toks, i, len)) continue;
      // a phrase made of a customer's or technician's own name words is that name, not jargon
      if (span.some((t) => t.w.length >= 3 && names.has(t.w))) continue;
      // text between two tokens must be plain spaces/hyphens/dots: never glue across a comma, quote or other clause
      let clean = true;
      for (let j = i; j < i + len - 1; j++) if (!/^[\s\-./&#]*$/.test(src.slice(toks[j].e, toks[j + 1].s))) clean = false;
      if (!clean) continue;
      hit = { len, canon };
    }
    if (!hit) { i++; continue; }
    const first = toks[i], last = toks[i + hit.len - 1];
    const isDate = DATES.has(hit.canon);
    // "the prior month" -> "last month" (not "the last month"): a date phrase brings its own article
    const startAt = isDate && /^(this|today|yesterday)/.test(hit.canon) && i > 0 && toks[i - 1].w === "the" && toks[i - 1].s >= cursor && /^\s+$/.test(src.slice(toks[i - 1].e, first.s)) ? toks[i - 1].s : first.s;
    const plural = CANON_PLURAL[hit.canon];
    const repl = plural && isPluralWord(last.w) ? plural : hit.canon;
    const from = src.slice(startAt, last.e);
    out += src.slice(cursor, startAt) + repl;
    cursor = last.e;
    hits.push({ from, to: repl, date: isDate });
    i += hit.len;
  }
  if (!hits.length) return null;
  out += src.slice(cursor);
  // "the invoice invoice" after a respell next to the same word: collapse the repeat
  for (const to of new Set(hits.map((h) => h.to))) out = out.replace(new RegExp(`\\b(${to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+\\1\\b`, "gi"), "$1");
  out = out.replace(/\s+/g, " ").trim();
  return out === src.trim() ? null : { text: out, hits };
}

/** Is the untracked span [i, i+len) inside or crossing a LONGER respell phrase? */
function respelledOver(toks, i, len) {
  for (let a = Math.max(0, i - MAX_WORDS + 1); a < i + len; a++) {
    for (let l = Math.min(MAX_WORDS, toks.length - a); l > len; l--) {
      if (a + l <= i || a >= i + len) continue;
      if (RESP.has(keyAt(toks, a, l))) return true;
    }
  }
  return false;
}

/**
 * The first untracked concept the question names, or null. Whole-phrase match only (no fuzzy), longest first.
 * @returns {{ id: string, phrase: string } | null}
 */
export function untrackedConcept(question) {
  tables();
  const src = String(question ?? "");
  if (!src.trim() || src.length > 300) return null;
  const toks = scan(src);
  for (let i = 0; i < toks.length; i++) {
    for (let len = Math.min(MAX_WORDS, toks.length - i); len >= 1; len--) {
      const id = UNT.get(keyAt(toks, i, len));
      if (id) {
        // a longer phrase that IS a tracked paper wins ("donation receipt" is a receipt, not a donation)
        if (respelledOver(toks, i, len)) break;
        return { id, phrase: src.slice(toks[i].s, toks[i + len - 1].e) };
      }
    }
  }
  return null;
}

/** Every phrase of one untracked concept (for the tenant-trace check). */
export function untrackedPhrases(id) {
  return UNTRACKED[id] ?? [];
}
