/**
 * Donovan's wording model: a small learned classifier that recognises a paraphrase of one of the catalogued question shapes
 * ("how many jobs did we do in 2024" -> "how many service tickets in 2024") and spells it the canonical way, so the deterministic lanes
 * (which read the canonical words) can answer it without a model call.
 *
 * Offline training (scripts/train-wording-model.py) writes model.json / slotwords.json / templates.json next to this file. This module:
 *   maskText()   slot masking, identical to the trainer (rules come from the shared maskspec.json)
 *   predict()    {template, prob} from the pruned linear model (word uni/bigrams + char 3-5 grams + slot-type bag)
 *   adapt()      predict + slot carry-over + the grammar/leftover guards on the ORIGINAL question -> a canonical question, or null
 * Nothing here calls the network or a model. Everything loads lazily on the first question that no deterministic lane claimed.
 * Kill switch: DONOVAN_WORDING_MODEL=0.
 */
import fs from "node:fs";
import { grammarSpans } from "../router/leftover.js";

export const wordingEnabled = () => process.env.DONOVAN_WORDING_MODEL !== "0";

let STATE = null;
const readUrl = (u) => JSON.parse(fs.readFileSync(u, "utf8")); // literal new URL(...) arguments so the serverless bundler ships the files

const TOKEN = /[A-Za-z0-9]+/g;
const PH = /^(zz[a-z]+)(\d+)$/;
const PLACEHOLDER_TYPES = new Set(["zzpo", "zzrefrig", "zzdoc", "zzton", "zzserial", "zzmoney", "zzperiod", "zzrel", "zzyear", "zznum", "zztech", "zzcust", "zzbrand", "zzcity"]);

function load() {
  if (STATE) return STATE;
  const spec = readUrl(new URL("./maskspec.json", import.meta.url));
  const model = readUrl(new URL("./model.json", import.meta.url));
  const slotwords = readUrl(new URL("./slotwords.json", import.meta.url));
  const templates = readUrl(new URL("./templates.json", import.meta.url));
  const rules = spec.rules.map((r) => ({ t: r.t, g: r.g, rx: new RegExp(r.re, "gid") }));
  const featIdx = new Map(Object.entries(model.feats));
  STATE = {
    spec, model, rules, featIdx, slotwords, templates,
    byId: new Map(templates.templates.map((t) => [t.id, t])),
    common: new Set(model.common),
    commonByLen: null,
    docRx: null,
    docMap: null,
    baseLex: null,
  };
  return STATE;
}

/** roster -> Map("w1 w2" -> type). Mirrors build_lex in the trainer. */
export function buildLex({ techs = [], customers = [], brands = [], cities = [] } = {}) {
  const S = load();
  const lex = new Map();
  const toks = (p) => (String(p).match(TOKEN) ?? []).map((t) => t.toLowerCase());
  const add = (phrase, typ) => { const k = toks(phrase).join(" "); if (k && !lex.has(k)) lex.set(k, typ); };
  const singles = new Map();
  for (const [typ, names, part] of [["zztech", techs, true], ["zzcust", customers, false]]) {
    for (const n of names) {
      const tk = toks(n);
      add(n, typ);
      if (tk.length >= 2) {
        const own = (w) => { if (!singles.has(w)) singles.set(w, new Map()); singles.get(w).set(tk.join(" "), typ); };
        own(tk[tk.length - 1]);
        if (part) own(tk[0]);
      }
    }
  }
  for (const [w, owners] of singles) if (w.length >= 4 && owners.size === 1 && !lex.has(w)) lex.set(w, [...owners.values()][0]);
  for (const b of [...S.spec.brands, ...brands]) add(b, "zzbrand");
  for (const c of [...S.spec.cities, ...cities]) add(c, "zzcity");
  return lex;
}

/** -> {tokens: string[], found: {type, raw}[]}  (found is in text order) */
export function maskText(text, lex, commonOverride) {
  const S = load();
  const common = commonOverride ?? S.common;
  let s = String(text).replace(/[’‘]/g, "'").replace(/[^\x00-\x7f]/g, " ");
  const raws = [];
  for (const r of S.rules) {
    let out = "";
    let last = 0;
    for (const m of s.matchAll(r.rx)) {
      const ix = m.indices[r.g];
      if (!ix) continue;
      const [a, b] = ix;
      if (a === b) continue;
      raws.push(s.slice(a, b));
      out += s.slice(last, a) + ` ${r.t}${raws.length - 1} `;
      last = b;
    }
    s = out + s.slice(last);
  }
  const toks = s.match(TOKEN) ?? [];
  const res = [];
  const found = [];
  const n = toks.length;
  const capWord = (t) => t.length >= 3 && t[0] >= "A" && t[0] <= "Z" && /[a-z]/.test(t.slice(1)) && !/[A-Z]/.test(t.slice(1));
  let i = 0;
  while (i < n) {
    const t = toks[i];
    const low = t.toLowerCase();
    const m = PH.exec(low);
    if (m) { res.push(m[1]); found.push({ type: m[1], raw: raws[Number(m[2])] }); i++; continue; }
    let hit = null;
    for (const L of [6, 5, 4, 3, 2, 1]) {
      if (i + L <= n) {
        const ks = toks.slice(i, i + L).map((x) => x.toLowerCase());
        if (ks.some((x) => PH.test(x))) continue;
        const typ = lex.get(ks.join(" "));
        if (typ) { hit = [L, typ]; break; }
      }
    }
    if (hit) { res.push(hit[1]); found.push({ type: hit[1], raw: toks.slice(i, i + hit[0]).join(" ") }); i += hit[0]; continue; }
    if (capWord(t) && !common.has(low)) {
      let j = i + 1;
      while (j < n && capWord(toks[j]) && !common.has(toks[j].toLowerCase()) && !PH.test(toks[j].toLowerCase())) j++;
      res.push("zzcust"); found.push({ type: "zzcust", raw: toks.slice(i, j).join(" ") }); i = j; continue;
    }
    res.push(low); i++;
  }
  return { tokens: res, found };
}

export function featurize(tokens) {
  const f = new Set();
  const seq = ["^", ...tokens, "$"];
  for (const t of seq) f.add("w:" + t);
  for (let i = 0; i < seq.length - 1; i++) f.add("b:" + seq[i] + " " + seq[i + 1]);
  const cnt = new Map();
  for (const t of tokens) {
    if (PLACEHOLDER_TYPES.has(t)) { cnt.set(t, (cnt.get(t) ?? 0) + 1); continue; }
    const w = ` ${t} `;
    for (const n of [3, 4, 5]) for (let i = 0; i + n <= w.length; i++) f.add("c:" + w.slice(i, i + n));
  }
  for (const [k, v] of cnt) f.add(`g:${k}:${Math.min(v, 3)}`);
  return f;
}

/** -> {k, prob, p[]}.  Same arithmetic as the trainer's score(). */
export function scoreTokens(tokens) {
  const S = load();
  const fs_ = [];
  for (const x of featurize(tokens)) if (S.featIdx.has(x)) fs_.push(x);
  const sc = Float64Array.from(S.model.b);
  const n = fs_.length;
  if (n) {
    const inv = 1 / Math.sqrt(n);
    for (const x of fs_) { const e = S.featIdx.get(x); for (let j = 0; j < e.length; j += 2) sc[e[j]] += e[j + 1] * inv; }
  }
  let mx = -Infinity;
  for (const v of sc) if (v > mx) mx = v;
  let z = 0;
  const p = new Float64Array(sc.length);
  for (let i = 0; i < sc.length; i++) { p[i] = Math.exp(sc[i] - mx); z += p[i]; }
  let k = 0;
  for (let i = 0; i < p.length; i++) { p[i] /= z; if (p[i] > p[k]) k = i; }
  return { k, prob: p[k], p };
}

function rosterLex(tenantVocab) {
  return buildLex({
    techs: tenantVocab?.technicians?.phrases ?? [],
    customers: tenantVocab?.customers?.phrases ?? [],
    brands: (tenantVocab?.brands ?? []).map(String),
    cities: (tenantVocab?.cities ?? []).map(String),
  });
}

/** predict(question) -> {template, prob, tokens, found}.  `lex` defaults to the tenant roster (if tenantVocab is given). */
export function predict(question, { tenantVocab, lex } = {}) {
  const S = load();
  const m = maskText(question, lex ?? rosterLex(tenantVocab));
  const r = scoreTokens(m.tokens);
  return { template: S.model.classes[r.k], prob: r.prob, tokens: m.tokens, found: m.found, slots: m.found };
}

// ---------------------------------------------------------------- slot values
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
void NUMW;
const SLOT_TYPES = {
  year: ["zzyear"], period: ["zzperiod", "zzyear", "zzrel"], relperiod: ["zzrel"], N: ["zznum"], amount: ["zzmoney"], tonnage: ["zzton"],
  refrigerant: ["zzrefrig"], city: ["zzcity"], brand: ["zzbrand"], technician: ["zztech"], customer: ["zzcust"], customer_person: ["zzcust"],
  customer_org: ["zzcust"], invoice: ["zzdoc"], po: ["zzpo"], serial: ["zzserial"],
};

const singular = (w) => w.replace(/ies$/, "y").replace(/(ss|us)$/, "$1").replace(/([^s])s$/, "$1");

function docIndex() {
  const S = load();
  if (S.docMap) return S;
  const map = new Map(); // surface (lower) -> canonical plural value
  for (const v of S.templates.docvalues) { map.set(v, v); map.set(singular(v), v); }
  for (const [w, v] of Object.entries(S.slotwords.doctype ?? {})) map.set(w, v);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  S.docMap = map;
  S.docRx = new RegExp(`\\b(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:s|es)?\\b`, "gi");
  const tmap = new Map([["repair", "repair"], ["repairs", "repair"], ["pm", "PM"], ["pms", "PM"], ["preventive maintenance", "PM"], ["preventative maintenance", "PM"], ["maintenance visits", "PM"]]);
  for (const [w, v] of Object.entries(S.slotwords.tickettype ?? {})) tmap.set(w, v.toLowerCase() === "pm" ? "PM" : v);
  const tkeys = [...tmap.keys()].sort((a, b) => b.length - a.length);
  S.tickMap = tmap;
  S.tickRx = new RegExp(`\\b(${tkeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
  return S;
}

function docMentions(text) {
  const S = docIndex();
  const low = text.toLowerCase();
  const out = [];
  const taken = [];
  for (const m of low.matchAll(S.docRx)) {
    const surf = m[1].toLowerCase();
    const v = S.docMap.get(surf) ?? S.docMap.get(singular(surf));
    if (!v) continue;
    // "invoice INV-20033", "purchase order PO-9004": the word labels a document number, it is not a second thing being asked about
    if (/^\s*(?:#|no\.?|number|num)?\s*[a-z]{2,3}-?\d{3,}/i.test(low.slice(m.index + m[0].length))) continue;
    out.push({ value: v, at: m.index, raw: m[0] });
    taken.push([m.index, m.index + m[0].length]);
  }
  // a misspelled single document word ("invooices", "propsolas"): within one edit of exactly one known word
  if (!S.docSingles) S.docSingles = [...S.docMap.keys()].filter((k) => !k.includes(" ") && k.length >= 6);
  for (const m of low.matchAll(/[a-z]+/g)) {
    const w = m[0];
    if (w.length < 6 || taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    if (S.common.has(w)) continue;
    const hits = new Set();
    for (const k of S.docSingles) for (const form of [k, k + "s"]) if (lev(w, form, 1) <= 1) hits.add(S.docMap.get(k));
    if (hits.size === 1) out.push({ value: [...hits][0], at: m.index, raw: w });
  }
  return out.sort((a, b) => a.at - b.at);
}
function tickMentions(text) {
  const S = docIndex();
  const out = [];
  for (const m of text.toLowerCase().matchAll(S.tickRx)) {
    const v = S.tickMap.get(m[1].toLowerCase());
    if (v) out.push({ value: v, at: m.index, raw: m[0] });
  }
  return out;
}

const canonRef = (v) => String(v).replace(/\s+/g, " ").trim();
function fmt(type, raw) {
  if (type === "zzdoc" || type === "zzserial") return raw.replace(/\s+/g, "").toUpperCase();
  if (type === "zzpo") { const d = raw.replace(/[^0-9]/g, ""); return `PO-${d}`; }
  if (type === "zzrefrig") { const t = raw.replace(/[^a-z0-9]/gi, "").toUpperCase(); return `R-${t.slice(1)}`; }
  if (type === "zzmoney") return /^[\d,.]+$/.test(raw) ? `$${raw.replace(/,/g, "")}` : canonRef(raw);
  return canonRef(raw);
}

/**
 * Fill every {slot} of the template from the question. Returns {values, unusedFound, extraDocs} or null when a slot cannot be filled
 * from the user's own words (names, periods and numbers are carried over verbatim; doctype / ticket type come from a literal or a learned word).
 */
export function fillSlots(tpl, question, found, roster) {
  const slotNames = [...tpl.canonical.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const used = new Array(found.length).fill(false);
  const values = {};
  // literal numbers in the canonical ("through 2026") must be said by the user too
  for (const lit of tpl.canonical.replace(/\{\w+\}/g, " ").match(/\b(?:19|20)\d{2}\b/g) ?? []) {
    const ix = found.findIndex((f, i) => !used[i] && f.type === "zzyear" && f.raw === lit);
    if (ix < 0) return null;
    used[ix] = true;
  }
  const docs = docMentions(question);
  const ticks = tickMentions(question);
  const docVals = [];
  for (const d of docs) if (!docVals.includes(d.value)) docVals.push(d.value);
  let docOrd = 0;
  let tickOrd = 0;
  const tickVals = [];
  for (const d of ticks) if (!tickVals.includes(d.value)) tickVals.push(d.value);
  let docSlots = 0;
  for (const name of slotNames) {
    const base = name.replace(/\d+$/, "");
    if (base.startsWith("doctype")) {
      docSlots++;
      const v = docVals[docOrd++];
      if (!v) return null;
      values[name] = base === "doctype_cust" ? singular(v) : v;
    } else if (base === "tickettype") {
      const v = tickVals[tickOrd++];
      if (!v) return null;
      values[name] = v;
    } else if (base === "N" && /\bpast \{N\} days?\b/.test(tpl.canonical)) {
      // "in the past {N} days": the mask reads "past 10 days" as one rolling window; the count is what the slot carries
      const ix = found.findIndex((f, i) => !used[i] && f.type === "zzrel" && /^(?:the\s+)?(?:last|past|previous)\s+\S+\s+days?$/i.test(f.raw));
      if (ix < 0) return null;
      const num = found[ix].raw.match(/(?:last|past|previous)\s+(\S+)/i)[1];
      used[ix] = true;
      values[name] = num;
    } else {
      const accept = SLOT_TYPES[base];
      if (!accept) return null;
      let ix = found.findIndex((f, i) => !used[i] && accept.includes(f.type));
      if (ix < 0 && base === "technician" && roster?.techs?.length) {
        // a one-letter slip in a technician's name ("Daanny Ochoa") is spelled as the roster has it
        ix = found.findIndex((f, i) => !used[i] && f.type === "zzcust" && roster.techs.some((t) => lev(f.raw.toLowerCase(), t.toLowerCase(), 2) <= 2));
        if (ix >= 0) { used[ix] = true; values[name] = roster.techs.find((t) => lev(found[ix].raw.toLowerCase(), t.toLowerCase(), 2) <= 2); continue; }
      }
      if (ix < 0) return null;
      used[ix] = true;
      values[name] = fmt(found[ix].type, found[ix].raw);
    }
  }
  // doc / ticket-type words the template does not read: fine when the template's own skeleton says them, otherwise unexplained
  const skeleton = tpl.canonical.replace(/\{\w+\}/g, " ").toLowerCase();
  const skelWords = new Set((skeleton.match(/[a-z]+/g) ?? []).map(singular));
  const stem = (w) => (w.length >= 6 ? w.slice(0, 6) : w);
  const skelStems = new Set([...skelWords].map(stem));
  const inSkel = (v) => (v.match(/[a-z]+/g) ?? []).some((w) => skelStems.has(stem(singular(w))));
  const extraDocs = docVals.slice(docOrd).filter((v) => !inSkel(v));
  const extraTicks = tickVals.slice(tickOrd).filter((v) => !skeleton.includes(v.toLowerCase()));
  const unused = found.filter((_, i) => !used[i]);
  return { values, unused, extraDocs, extraTicks };
}

function buildCanonical(tpl, values) {
  return tpl.canonical.replace(/\{(\w+)\}/g, (_, n) => values[n]);
}

// ---------------------------------------------------------------- guards on the ORIGINAL question
const NEG_WORD = /\b(?:not|no|never|without|except|excluding|exclude|besides|other than|aside from|apart from|non|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|hasn't|haven't|hadn't|won't|can't|cannot|neither|nor|none|nobody|nothing|outside|but)\b|n't\b/i;
const NEG_ANY = new RegExp(NEG_WORD.source + "|\\b(?:out of|missing|lacking|lack|minus|off)\\b", "i");
const COUNT_WORD = /\b(?:how many|number of|what number|count|counts|counted|tally|quantity|qty|headcount|many|how much)\b|#/i;
const FAMILIES_WITH_SECOND = new Set(["compare", "multi", "twoyear"]);

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(c);
      if (c < rowMin) rowMin = c;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The words this template knows: its own skeleton, its paraphrases in training, words shared by 2+ templates of its family, generic filler, learned slot words. */
function allowedWords(tpl) {
  const S = load();
  if (tpl.allowed) return tpl.allowed;
  if (!S.genericSet) {
    S.genericSet = new Set(S.model.generic.map((i) => S.model.common[i]));
    S.slotWordSet = new Set(Object.values(S.slotwords).flatMap((m) => Object.keys(m).flatMap((k) => k.split(" "))));
  }
  const set = new Set([...S.genericSet, ...S.slotWordSet, ...tpl.words]);
  for (const i of S.model.tw[tpl.id] ?? []) set.add(S.model.common[i]);
  for (const i of S.model.fw[tpl.family] ?? []) set.add(S.model.common[i]);
  tpl.allowed = set;
  tpl.allowedByLen = new Map();
  for (const c of set) { const l = c.length; if (!tpl.allowedByLen.has(l)) tpl.allowedByLen.set(l, []); tpl.allowedByLen.get(l).push(c); }
  return set;
}

function isKnownWord(w, tpl) {
  if (/^\d+$/.test(w) || w === "s" || w.length <= 2) return true;
  if (allowedWords(tpl).has(w)) return true;
  const max = w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0;
  if (!max) return false;
  for (let l = w.length - max; l <= w.length + max; l++) for (const c of tpl.allowedByLen.get(l) ?? []) if (lev(w, c, max) <= max) return true;
  return false;
}


// ---------------------------------------------------------------- word-class guards (polarity, noun/measure, modality, scope)
const POL = { fewest: "L", least: "L", lowest: "L", smallest: "L", oldest: "L", first: "L", earliest: "L", minimum: "L", min: "L", cheapest: "L", most: "H", highest: "H", biggest: "H", largest: "H", newest: "H", last: "H", latest: "H", recent: "H", maximum: "H", max: "H", top: "H", busiest: "H" };
function polarity(text) {
  const w = text.toLowerCase().replace(/\{\w+\}/g, " ").match(/[a-z]+/g) ?? [];
  const out = new Set();
  for (let i = 0; i < w.length; i++) {
    if (w[i] === "recent") { out.add(w[i - 1] === "least" ? "L" : "H"); continue; }
    if (POL[w[i]] && w[i] !== "recent") out.add(POL[w[i]]);
  }
  return out;
}
const NOUN_STEMS_RAW = (["ticket", "payment", "call", "visit", "job", "invoice", "quote", "proposal", "estimate", "bid", "order", "permit", "agreement", "warranty", "customer", "client", "unit", "system", "technician", "tech", "document", "appointment", "bill", "contract", "plan", "equipment", "address", "phone", "email", "model", "brand", "serial", "labor", "vendor", "install", "repair", "maintenance", "startup", "dispatch", "inspection", "registration", "purchase", "proposed", "paid", "owed", "unpaid", "overdue", "expired", "lost", "won", "cancelled", "declined", "rejected", "accepted", "approved", "completed", "pending", "closed", "open"]);
const NOUN_STEMS = new Set(NOUN_STEMS_RAW.map((w) => w.replace(/ies$/, "y").replace(/([^s])s$/, "$1").replace(/(?:ed|d)$/, (m, i, str) => (str.length > 6 ? "" : m)).slice(0, 6)));
const MEASURE = { avg: /\b(?:average|avg|mean|typical)\b/i, pct: /\b(?:percent|percentage|share|proportion|%)\b/i, total: /\b(?:total|sum|aggregate|combined)\b/i, count: /\b(?:count|number|how many|tally)\b/i };
const MODAL = /\b(?:want|wants|wanted|need|needs|needed|should|could|would|if|plan|plans|planning|going to|gonna|will|wish|hope|might|may|can|whether)\b/i;
const SCOPE = /\b(?:per|each|every|near|nearby|around|within|covered|under warranty|out of warranty|in warranty|by (?:month|year|tech|technician|customer|city|brand|quarter|week))\b/gi;
const stemN = (w) => w.replace(/ies$/, "y").replace(/([^s])s$/, "$1").replace(/(?:ed|d)$/, (m, i, str) => (str.length > 6 ? "" : m)).slice(0, 6);

function lexicalConflict(question, tpl, canonical) {
  const S = load();
  const q = question.toLowerCase();
  const c = canonical.toLowerCase();
  const cw = new Set((c.match(/[a-z]+/g) ?? []).map(stemN));
  // 1. polarity: fewest vs most, first vs last, oldest vs newest
  const pq = [...polarity(q)].sort().join(""), pc = [...polarity(c)].sort().join("");
  if (pq !== pc) return "polarity";
  // 2. a noun or measure the template does not say (and no learned word maps it there)
  // a document type the original names must be the one the template names ("work order" is not "purchase order")
  for (const d of docMentions(question)) {
    const v = d.value;
    if (!c.includes(v) && !c.includes(singular(v)) && !tpl.canonical.includes("{doctype")) return `doctype:${v}`;
    if (tpl.canonical.includes("{doctype")) continue;
  }
  const learned = new Map(Object.entries(S.slotwords.doctype ?? {}).map(([k, v]) => [k, v]));
  for (const w of q.match(/[a-z]+/g) ?? []) {
    const st = stemN(w);
    if (!NOUN_STEMS.has(st) || cw.has(st)) continue;
    const mapped = learned.get(w) ?? learned.get(st) ?? learned.get(st + "s");
    if (mapped && (mapped.match(/[a-z]+/g) ?? []).some((x) => cw.has(stemN(x)))) continue;
    // placeholders of the same noun class in the original are fine when the template's slot already carries them
    return `noun:${w}`;
  }
  for (const [g, rx] of Object.entries(MEASURE)) {
    if (g === "count") continue;
    if (rx.test(q) && !rx.test(c)) return `measure:${g}`;
    if ((g === "avg" || g === "pct") && rx.test(c.replace(/\{\w+\}/g, " ")) && !rx.test(q)) return `measure:${g}`;
  }
  // 3. desire / modality / future the template does not carry
  const mm = q.match(MODAL);
  if (mm && !new RegExp(`\\b${mm[0].replace(/\s+/g, "\\s+")}\\b`, "i").test(tpl.canonical)) return `modality:${mm[0]}`;
  // 3b. future time ("next year", "upcoming", "in the coming months"): the templates read past records only
  if (/\b(?:next|upcoming|coming|future|tomorrow|forecast|projected|expected)\b/i.test(q) && !/\b(?:next|upcoming|coming)\b/i.test(tpl.canonical)) return "future";
  // 4. scope words that would be dropped
  for (const m of q.matchAll(SCOPE)) {
    const w = m[0];
    const grp = /^(?:per|each|every|by )/.test(w) ? /\b(?:per|each|every|by)\b/i : new RegExp(`\\b${w.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (!grp.test(tpl.canonical)) return `scope:${w}`;
  }
  return null;
}

/** Why a candidate must NOT be adopted, or null. */
export function guardReason(question, tpl, tokens, fill, canonical) {
  const lexWhy = lexicalConflict(question, tpl, canonical ?? buildCanonical(tpl, fill.values));
  if (lexWhy) return lexWhy;
  if (fill.unused.length) return `unused-${fill.unused[0].type}`;
  if (fill.extraDocs.length) return "unused-doctype";
  if (fill.extraTicks.length) return "unused-tickettype";
  const neg = tpl.id.startsWith("neg_");
  const fam = tpl.family;
  const skelWords = tpl.words;
  if (!neg && NEG_WORD.test(question)) {
    const m = question.toLowerCase().match(NEG_WORD);
    const w = m[0].toLowerCase();
    if (!skelWords.has(w) && !/^(?:but)$/.test(w)) return "unused-negation";
    if (/^(?:but)$/.test(w)) return "unused-negation";
  }
  // a negated template needs a negation in what the user said ("customers that have a phone number" is not "customers with no phone number")
  if (neg && !NEG_ANY.test(question)) return "negation-missing";
  // asking HOW MANY is not asking WHICH: the count words must agree between what was said and what the template answers
  const cw = (x) => COUNT_WORD.test(x.replace(/\{\w+\}/g, " ").replace(/\b(?:phone|cell|mobile|serial|permit|invoice|po|account|model|fax)\s*(?:number|num|no|#)\b|\b(?:number|num|nmber|numbr|nbr)s?\b(?=\s+(?:and|or|\&)\s+(?:email|e-mail|address))|\b(?:number|num|nmber|numbr|nbr)\b(?=\s*(?:\?|$))/gi, " "));
  const qCount = cw(question);
  const tCount = cw(tpl.canonical);
  if (qCount !== tCount && !["summary", "followup"].includes(fam)) return "count-vs-list";
  let spans = [];
  try { spans = grammarSpans(question); } catch { spans = []; }
  for (const sp of spans) {
    if (sp.kind === "negation" && !neg) return "grammar-negation";
    if (["second-head", "second-measure", "pair-extreme"].includes(sp.kind) && !FAMILIES_WITH_SECOND.has(fam)) return "second-clause";
    if (sp.kind === "rank-scope") return "grammar-rank-scope";
  }
  if (!FAMILIES_WITH_SECOND.has(fam) && /\b(?:and|also|plus|then|as well as)\s+(?:by\s+whom|how|what|whats|which|who|whom|when|where|why|the\s+total|show|give|list|tell)\b/i.test(question)) return "second-clause";
  if (!FAMILIES_WITH_SECOND.has(fam) && /\?\s*\S/.test(question)) return "second-clause";
  // any content word the model has never seen and the template does not say: an unexplained concept
  for (const t of tokens) {
    if (PLACEHOLDER_TYPES.has(t)) continue;
    if (!isKnownWord(t, tpl)) return `unknown-word:${t}`;
  }
  return null;
}

function tplInfo(id) {
  const S = load();
  const t = S.byId.get(id);
  if (!t) return null;
  if (!t.words) t.words = new Set((t.canonical.replace(/\{\w+\}/g, " ").toLowerCase().match(/[a-z']+/g) ?? []));
  return t;
}

/**
 * The whole step: question -> {canonical, template, prob, family} or {skip: reason}.
 * Follow-up templates (fup_*) and decline templates (decl_*) are never adopted here (a follow-up is already folded into a full question
 * by the conversation engine before classification; a decline is the early-decline lane's job).
 */
export function adapt(question, { tenantVocab, lex, threshold, roster } = {}) {
  if (!wordingEnabled()) return { skip: "off" };
  const S = load();
  const q = String(question ?? "").trim();
  if (!q || q.length > 400) return { skip: "length" };
  const p = predict(q, { tenantVocab, lex });
  const th = threshold ?? (Number(process.env.DONOVAN_WORDING_TH) || S.model.threshold);
  const out = { template: p.template, prob: p.prob };
  if (p.template === "none") return { ...out, skip: "none" };
  if (p.prob < th) return { ...out, skip: "low-confidence" };
  if (p.template.startsWith("fup_")) return { ...out, skip: "followup" };
  if (p.template.startsWith("decl_")) return { ...out, skip: "decline-template" };
  const tpl = tplInfo(p.template);
  if (!tpl) return { ...out, skip: "no-template" };
  const fill = fillSlots(tpl, q, p.found, { techs: tenantVocab?.technicians?.phrases ?? roster?.techs ?? [] });
  if (!fill) return { ...out, skip: "slots-unfilled" };
  const why = guardReason(q, tpl, p.tokens, fill, buildCanonical(tpl, fill.values));
  if (why) return { ...out, skip: why };
  return { ...out, family: tpl.family, canonical: buildCanonical(tpl, fill.values), values: fill.values };
}

export const _internals = { load, rosterLex, docMentions };
