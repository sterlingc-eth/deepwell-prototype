// Deterministic, no-model value reader: retrieval(+exact-ID boost) -> question typing -> label match (learned synonyms)
// -> typed candidates -> verification -> abstain unless exactly one verified candidate clearly wins. Generic.
import { norm, alnum, stem, words, STOP, ID_RE, DATE_RE, parseDate, valueType, moneyNum, MONTHS, CFG } from "./vr_text.js";
import { extractUnits } from "./vr_extract.js";
import { lineItemRead, tableLike } from "./vr_line.js";

export const idKeysOf = (text) => { const out = new Set(); for (const m of String(text).matchAll(ID_RE)) { const a = alnum(m[0]); if (a.length >= 3 && /\d/.test(a) && /[a-z]/.test(a) && !parseDate(m[0]) && !/^(fy|q[1-4]|h[12])\d{0,4}$/.test(a) && !/^(fy|q[1-4]|h[12])-?\d{2,4}$/i.test(m[0])) out.add(a); } for (const m of String(text).matchAll(/\b([A-Z]{2,5}) (\d{2,}(?:-\d+)*)\b/g)) out.add(alnum(m[1] + m[2])); return out; };
const confKey = (id) => String(id).toLowerCase().replace(/[il1]/g, "1").replace(/[o0]/g, "0");
export const valKey = (type, v) => type === "money" ? "m" + moneyNum(v) : type === "date" ? "d" + parseDate(v) : norm(v).replace(/[^a-z0-9 ]/g, "");

// ---------- corpus index (done once, e.g. at upload) ----------
// OCR name repair against the corpus: a person-like name read from an OCR page that is within a couple of characters of exactly one name seen on 2+ other pages is that name
const lev = (a, b) => { const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9; let p = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; };
const PERSON = /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/;
function snapNames(docs) {
  const cnt = new Map(); for (const d of docs) { const seen = new Set(); for (const u of d.units) for (const p of u.pairs) if (PERSON.test(p.value)) seen.add(p.value); if (d.ocr) continue; for (const v of seen) cnt.set(v, (cnt.get(v) ?? 0) + 1); }
  const known = [...cnt].filter(([, n]) => n >= 2).map(([v]) => v); const K = new Set(known);
  const ROLEL = /\b(technician|inspector|driver|manager|contact|representative|rep|salesperson|engineer|nurse|agent|supervisor|approver|approved|signed|prepared|assigned|requested|received|holder|owner|operator|pilot|doctor|provider)\b/i;
  let clean = null; if (CFG.ocrGuard) { clean = new Set(); for (const d of docs) if (!d.ocr) for (const w of d.toks) clean.add(w); }
  const dropOcr = (d, u, p) => { // a value read from an OCR page that cannot be checked against the clean documents is not stated
    if (!CFG.ocrGuard) return false;
    if (PERSON.test(p.value) && ROLEL.test(p.label) && !K.has(p.value)) return true;   // a staff / role name that no clean page spells the same way
    if ((p.type === "text" || p.type === "name") && !PERSON.test(p.value)) { const ws = p.value.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3); if (ws.length >= 3 && ws.filter((w) => clean.has(w)).length / ws.length < 0.6) return true; }   // OCR gibberish read as a text value
    if (p.type === "date" && /\b(due|deadline|payable|by|expir\w*|end)\b/i.test(p.label + " " + (p.line ?? "").slice(0, 60))) { const ds = (d.text.match(DATE_RE) ?? []).map(parseDate).filter(Boolean); const v = parseDate(p.value); if (v && ds.length && ds[0] !== v && v < ds[0]) return true; }   // a due date earlier than the first (document) date on its own page
    return false;
  };
  for (const d of docs) if (d.ocr) for (const u of d.units) u.pairs = u.pairs.filter((p) => !dropOcr(d, u, p));
  if (!known.length) return;
  for (const d of docs) if (d.ocr) for (const u of d.units) for (const p of u.pairs) {
    if (!PERSON.test(p.value) || K.has(p.value)) continue; const t = p.value.split(" "); const hits = known.filter((k) => { const kt = k.split(" "); if (kt.length !== t.length) return false; let tot = 0; for (let i = 0; i < t.length; i++) { const dd = lev(t[i], kt[i]); if (dd > (kt[i].length <= 4 ? 1 : 2)) return false; tot += dd; } return tot <= 3; });
    if (hits.length === 1) { p.raw = p.value; p.value = hits[0]; }
  }
}
export function buildCorpus(pages) {
  const docs = pages.map((p) => ({ ...p, norm: norm(p.text), idset: new Set(), toks: [] }));
  const df = new Map(); let totalLen = 0;
  for (const d of docs) {
    d.idset = idKeysOf(d.text + " " + (d.file ?? ""));
    const t = words(d.text + " " + (d.file ?? "").replace(/[_.]/g, " ")); d.toks = t; totalLen += t.length;
    for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
    d.tf = new Map(); for (const w of t) d.tf.set(w, (d.tf.get(w) ?? 0) + 1);
    d.units = extractUnits(d);
  }
  if (CFG.nameSnap) snapNames(docs);
  const allIds = new Set(); for (const d of docs) for (const i of d.idset) allIds.add(i);
  const corpus = { docs, df, avg: totalLen / Math.max(1, docs.length), N: docs.length, allIds };
  corpus.vocab = new Map(); for (const d of docs) for (const w of d.toks) { const st = stem(w); corpus.vocab.set(st, (corpus.vocab.get(st) ?? 0) + 1); }
  corpus.learned = learnLabels(corpus);
  corpus.confMap = new Map(); for (const i of allIds) { const k = confKey(i); (corpus.confMap.get(k) ?? corpus.confMap.set(k, new Set()).get(k)).add(i); }
  corpus.hasOcr = docs.some((d) => d.ocr);
  { const ent = new Set(); for (const d of docs) for (const u of d.units) for (const p of u.pairs) if (p.type === "name" && !/^\d/.test(p.value)) { const w = words(p.value); if (w.length >= 2 && w.length <= 6) ent.add(w.join(" ")); }
    corpus.supers = new Map(); for (const e of ent) { const w = e.split(" "); for (let k = 2; k < w.length; k++) for (const n of [w.slice(0, k).join(" "), w.slice(w.length - k).join(" ")]) if (ent.has(n)) (corpus.supers.get(n) ?? corpus.supers.set(n, []).get(n)).push(e); } }
  return corpus;
}

// ---------- learn label statistics + synonyms from the data itself ----------
function learnLabels(corpus) {
  const labels = new Map(), byValue = new Map(), tokDf = new Map();
  for (const d of corpus.docs) {
    const seenL = new Set();
    for (const u of d.units) for (const p of u.pairs) {
      if (p.src === "near") continue;
      const lk = p.lab.join(" "); if (!lk) continue;
      let L = labels.get(lk); if (!L) labels.set(lk, (L = { key: lk, lab: p.lab, label: p.label, n: 0, types: {} }));
      if (!seenL.has(lk)) { L.n++; seenL.add(lk); for (const t of new Set(p.lab)) tokDf.set(t, (tokDf.get(t) ?? 0) + 1); }
      L.types[p.type] = (L.types[p.type] ?? 0) + 1; (L.vals ??= new Set()).add(norm(p.value)); L.occ = (L.occ ?? 0) + 1;
      if (["money", "date", "id", "name", "phone"].includes(p.type)) { const k = valKey(p.type, p.value); if (!byValue.has(k)) byValue.set(k, new Map()); const m = byValue.get(k); m.set(lk, (m.get(lk) ?? new Set()).add(d.docId)); }
    }
  }
  for (const L of labels.values()) { L.card = L.vals.size / L.occ; const tot = Object.values(L.types).reduce((a, b) => a + b, 0); let best = null, bn = 0; for (const [t, n] of Object.entries(L.types)) if (n > bn) { best = t; bn = n; } L.dom = bn / tot >= 0.6 ? best : "mixed"; if (L.dom === "int" || L.dom === "number") L.dom = "num"; }
  // synonyms: labels that carry the same value in different documents
  const co = new Map(), cnt = new Map();
  for (const [k, m] of byValue) { const ls = [...m.keys()]; if (ls.length < 2 || ls.length > 6) continue; for (const l of ls) cnt.set(l, (cnt.get(l) ?? 0) + 1); for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) { const docsI = m.get(ls[i]), docsJ = m.get(ls[j]); if ([...docsI].every((x) => docsJ.has(x)) && docsI.size === docsJ.size && docsI.size === 1) continue; /* same-doc coincidence only */ const key = ls[i] < ls[j] ? ls[i] + "||" + ls[j] : ls[j] + "||" + ls[i]; co.set(key, (co.get(key) ?? 0) + 1); } }
  const syn = new Map();
  for (const [key, c] of co) { const [a, b] = key.split("||"); const j = c / (cnt.get(a) + cnt.get(b) - c); if (c >= 2 && j >= 0.34 && (labels.get(a).dom === labels.get(b).dom || labels.get(a).dom === "mixed" || labels.get(b).dom === "mixed")) { (syn.get(a) ?? syn.set(a, new Map()).get(a)).set(b, j); (syn.get(b) ?? syn.set(b, new Map()).get(b)).set(a, j); } }
  // generic-label prior per dominant type = doc frequency rank
  const byType = {}; for (const L of labels.values()) (byType[L.dom] ??= []).push(L);
  for (const arr of Object.values(byType)) { const mx = Math.max(...arr.map((x) => x.n)); for (const L of arr) L.prior = Math.sqrt(L.n / mx); }
  corpus.kindVocab = new Set(); // words that name the kind of a document / of an identifier: id-valued label words and title words
  for (const L of labels.values()) if (L.dom === "id") for (const t of L.lab) corpus.kindVocab.add(t);
  for (const d of corpus.docs) for (const t of words((d.file ?? "").replace(/[_.]/g, " ") + " " + d.text.split("\n").slice(0, 2).join(" "))) corpus.kindVocab.add(stem(t));
  return { labels, syn, tokDf, nLabelPages: corpus.docs.length };
}

// ---------- retrieval: BM25 over whole pages + exact-ID boost ----------
export function retrieve(corpus, qinfo, k = 5) {
  const qt = [...new Set(words(qinfo.q).filter((w) => !STOP.has(w)))];
  const scored = corpus.docs.map((d) => {
    let s = 0; const len = d.toks.length;
    for (const w of qt) { const f = d.tf.get(w); if (!f) continue; const idf = Math.log(1 + (corpus.N - (corpus.df.get(w) ?? 0) + 0.5) / ((corpus.df.get(w) ?? 0) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len / corpus.avg)); }
    let tier = 2;
    const idHit = qinfo.ids.length && qinfo.ids.every((i) => d.idset.has(i));
    const nameHit = qinfo.names.length && qinfo.names.every((n) => ` ${words(d.text).join(" ")} `.includes(` ${words(n).join(" ")} `));
    if (idHit && nameHit) tier = 0; else if (idHit) tier = 1; else if (nameHit && !qinfo.ids.length) tier = 1; else if (nameHit) tier = 2;
    return { d, s, tier };
  });
  scored.sort((a, b) => a.tier - b.tier || b.s - a.s);
  return scored.slice(0, k).map((x) => x.d);
}

// ---------- question analysis ----------
const QW = new Set("what who whom when where which how is are was were does did do list tell show give find has have can could will would".split(" "));
function edits1(w) { const L = "abcdefghijklmnopqrstuvwxyz"; const out = new Set(); for (let i = 0; i <= w.length; i++) { if (i < w.length) { out.add(w.slice(0, i) + w.slice(i + 1)); for (const c of L) out.add(w.slice(0, i) + c + w.slice(i + 1)); } for (const c of L) out.add(w.slice(0, i) + c + w.slice(i)); if (i < w.length - 1) out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); } return out; }
// a question word that is not in the corpus vocabulary is repaired to the unique most frequent corpus word one edit away
function repair(t, corpus) { if (t.length < (CFG.numFix ? 5 : 4) || corpus.vocab.has(t) || corpus.learned.tokDf.has(t)) return t; let best = null, bc = 0, tie = false; for (const e of edits1(t)) { const c = corpus.vocab.get(e) ?? 0; if (c > bc) { best = e; bc = c; tie = false; } else if (c === bc && c > 0) tie = true; } return best && !tie ? best : t; }
export function analyze(q, corpus) {
  const idKeys = [...idKeysOf(q)];
  const dates = []; for (const m of q.matchAll(DATE_RE)) { const iso = parseDate(m[0]); if (iso) dates.push(iso); }
  const md = []; for (const m of q.matchAll(new RegExp(`\\b(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]* (\\d{1,2})\\b(?!,? \\d{4})`, "gi"))) md.push([MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase())) + 1, +m[2]]);
  // name anchors: runs of capitalised tokens
  const names = []; const toks = q.replace(/[?]/g, "").replace(/['’]s\b/g, "").split(/\s+/);
  let run = [];
  const flush = () => { while (run.length && (QW.has(run[0].toLowerCase()) || ["The", "A", "An", "Our", "My", "Is", "Are", ...(CFG.aggAll ? ["Add", "Sum", "List", "Show", "Tell", "Give", "Find", "Count", "Calculate", "Compute", "Total", "Combine"] : [])].includes(run[0]))) run.shift(); while (run.length && ["&", "and", "of"].includes(run[run.length - 1])) run.pop(); if (run.length) names.push(run.join(" ").replace(/[,.]+$/, "")); run = []; };
  for (const t of toks) { const c = t.replace(/[,:;]+$/, ""); if (/^[A-Z][\w.'&-]*$/.test(c) && !ID_RE.test(c) && !/\d/.test(c)) { run.push(c); if (/[,:;]$/.test(t)) flush(); } else if (run.length && ["&", "of", "and"].includes(c) && false) run.push(c); else if (run.length && c === "&") run.push(c); else flush(); ID_RE.lastIndex = 0; }
  flush();
  const nameClean = names.map((n) => n.replace(/^(Mr|Ms|Mrs|Dr)\.? /, "")).filter((n) => !/^(Net|Inc|LLC)$/.test(n) && !QW.has(n.toLowerCase()) && !(CFG.numFix && words(n).every((w) => MONTHS.includes(w) || MONTHS.some((m) => m.slice(0, 3) === w))));
  if (CFG.nameLab && corpus?.learned?.labels) for (let i = nameClean.length - 1; i >= 0; i--) { const k = words(nameClean[i]).map(stem).join(" "); const LL = corpus.learned.labels.get(k); if (LL && LL.n >= 2 && ["money", "date", "num", "n", "number", "int"].includes(LL.dom)) nameClean.splice(i, 1); }   // a capitalised run that is a known column / label ("Residential Premium") is a label, not a party name
  const anchorWords = new Set([...idKeys.flatMap((i) => [i]), ...nameClean.flatMap((n) => words(n)), ...dates.flatMap((d) => words(d))]);
  for (const t of toks) if (ID_RE.test(t)) { for (const w of words(t)) anchorWords.add(w); } ID_RE.lastIndex = 0;
  const kind = new Set(); { const ws = q.replace(/[?,]/g, "").split(/\s+/).map((w) => (corpus && !ID_RE.test(w) && /^[A-Za-z]+$/.test(w) ? repair(stem(w.toLowerCase()), corpus) : w)); ID_RE.lastIndex = 0; ws.forEach((w, i) => { if (ID_RE.test(w) && /\d/.test(w)) { for (let j = i - 1; j >= Math.max(0, i - 2); j--) { const x = ws[j].toLowerCase(); if (STOP.has(x) || QW.has(x)) break; if (!corpus || corpus.kindVocab.has(stem(x))) kind.add(stem(x)); } } ID_RE.lastIndex = 0; }); }
  const ql = words(q).filter((w) => !STOP.has(w) && !QW.has(w) && !anchorWords.has(w) && !MONTHS.includes(w) && !/^\d+$/.test(w)).map(stem).filter((t) => !(CFG.numFix && ["still", "currently", "already", "use", "used", "using", "made", "charg"].includes(t))).map((t) => corpus ? repair(t, corpus) : t).filter((t) => !kind.has(t));
  let ql2 = [...new Set(ql)];
  if (CFG.numFix && ql2.length > 1) ql2 = ql2.filter((t) => t !== "number" && t !== "no" && t !== "person");
  if (CFG.numFix && /\be-?mail\b/i.test(q) && ql2.length > 1) ql2 = ql2.filter((t) => t !== "address");
  const qlAll = CFG.kindLab ? [...new Set(words(q).filter((w) => !STOP.has(w) && !QW.has(w) && !anchorWords.has(w) && !MONTHS.includes(w) && !/^\d+$/.test(w)).map(stem).map((t) => corpus ? repair(t, corpus) : t))] : ql2;
  const t = norm(q); let target = "attr";
  if (/\bhow many\b/.test(t) || (CFG.numFix ? /(?<!\b(?:phone|serial|account|invoice|license|licence|reference|tax|member|policy|case|order|ticket|bill|fax|statement|receipt|record|document|cell|mobile|telephone|unit|part|po|id)) number of\b(?! (?:the )?[a-z]* ?(?:id|#))/ : /\bnumber of\b(?! (?:the )?[a-z]* ?(?:id|#))/).test(t)) target = "count";
  else if (CFG.numFix && /\b(?:phone|telephone|mobile|cell)\b/.test(t)) target = "phone";
  else if (CFG.numFix && /\be-?mail\b/.test(t)) target = "email";
  else if (/\bwhen\b|\bwhat date\b|\bwhat day\b|\bdue date\b|\bexpir|\bdeadline\b|\bwhat (?:is|was) the (?:\w+ ){0,2}date\b/.test(t) || /\b(?:date|dated)\b/.test(t) && !/\bhow much\b/.test(t)) target = "date";
  else if (/\bwho\b|\bwhom\b|\bwhich (customer|client|vendor|company|tenant|donor|contractor|subcontractor|person|employee|owner|architect|supplier|party|bidder|technician|manager)\b|\bcontact\b|\bbilled to\b|\bapproved by\b/.test(t)) target = "party";
  else if (/\bhow much\b|\btotal\b|\bamount\b|\bprice\b|\bcost\b|\bfee\b|\brate\b|\brent\b|\bdeposit\b|\bbalance\b|\bowe[ds]?\b|\bpaid\b|\bpayments? (?:received|made)\b|\bowing\b|\bsalary\b|\bbudget\b|\bbid\b|\bcharge\b|\bretainage\b|\bpremium\b|\bworth\b|\bvalue\b|\bsum\b/.test(t) && !/\bwhich\b|\bwhat (?:is|was) the (?:\w+ ){0,2}(?:number|id)\b/.test(t)) target = "amount";
  else if (/\b(number|no\.|serial|license|reference|id|code)\b/.test(t) && /\bwhat\b|\bwhich\b/.test(t)) target = "identifier";
  if (CFG.numFix) { ql2 = ql2.filter((t) => !["still", "currently", "already", "use", "used", "using", "made", "charg"].includes(t)); if (ql2.includes("due") && ql2.length > 1) ql2 = ql2.filter((t) => t !== "payment"); }
  if (CFG.numFix && target === "date" && ql2.length > 1) ql2 = ql2.filter((t) => t !== "date");
  const years = [...String(q).matchAll(/\b(20\d{2}|19\d{2})\b/g)].map((m) => m[1]).filter((y) => !dates.some((d) => d.startsWith(y)));
  const periods = [...String(q).matchAll(/\b((?:FY|Q[1-4]|H[12])[\s-]?\d{2,4})\b/gi)].map((m) => alnum(m[1]));
  const nums = [...String(q).matchAll(/\b([A-Za-z]{3,})\s+#?(\d{1,3})\b(?![\/.-]\d)/g)].filter((m) => !STOP.has(m[1].toLowerCase()) && !QW.has(m[1].toLowerCase()) && !MONTHS.includes(m[1].toLowerCase()) && !/^(fy|top|page|rows?)$/i.test(m[1])).map((m) => new RegExp(m[1].slice(0, 3).toLowerCase() + "[a-z]*\\W+(?:\\w+\\W+){0,2}0*" + m[2] + "\\b", "i"));
  const qst = new Set(words(q).map(stem)); const rowOk = (u) => { const k = (u._rk ??= words(u.rowKey ?? "").filter((w) => !STOP.has(w)).map(stem)); return k.length > 0 && k.every((t) => qst.has(t) || [...qst].some((x) => x.length > 3 && t.length > 3 && edits1(x).has(t))); };
  return { q, corpus, rowOk, kind, years, periods, nums, qlAll, ids: idKeys, idRaw: [...String(q).matchAll(ID_RE)].map((m) => m[0]), dates, md, names: nameClean, ql: ql2, target };
}


// ---- valuereader2: generic qualifier groups (closed-class admin words; no industry vocabulary) ----
const GROUPS = { next: ["next", "upcoming", "following", "subsequent"], prev: ["last", "previous", "prior", "preceding", "earlier"], due: ["due", "deadline", "remit", "payable", "pay"], issue: ["issued", "issue", "invoiced"],
  paid: ["paid", "deposited", "credited", "applied", "received"], bal: ["balance", "outstanding", "owed", "owe", "owing", "remaining", "unpaid", "open"], sched: ["scheduled", "schedule", "booked", "appointment"], done: ["completed", "complete", "finished", "performed", "serviced", "closed", "done"],
  eff: ["effective", "commence", "commencement", "begin", "begins", "opened", "start", "starts"], end: ["end", "ends", "expire", "expires", "expiration", "expiry", "terminate", "terminates", "through", "until"], orig: ["original", "initial", "first"], rev: ["revised", "amended", "updated", "new"] };
const ADMIN_G = {follow: ["follow", "followup"], cost: ["cost", "charge", "charges", "fee", "fees", "price"], parts: ["parts", "materials", "material", "supplies"], ship: ["shipping", "freight", "postage", "shipped"], quote: ["quote", "quoted", "estimate", "estimated", "quotation"]};
if (CFG.grpAdmin) Object.assign(GROUPS, ADMIN_G);
const GROUP = new Map(); for (const [g, ws] of Object.entries(GROUPS)) for (const w of ws) { GROUP.set(w, g); GROUP.set(stem(w), g); }
const grp = (t) => GROUP.get(t);
const OPP = [["next", "prev"], ["eff", "end"], ["sched", "done"], ["issue", "due"], ["orig", "rev"], ["paid", "bal"]];
const TYPEW = new Set(["amount", "date", "number", "value", "sum", "figure", "time"]);

// a document's own date label ("Invoice date" on an invoice) answers "issued"; a bare "Amount" on a payments sheet answers "received/paid"
const PAYW = new Set(["payment", "receipt", "remittance", "deposit", "paid"]);
function docQual(qTok, p, titleToks) {
  const gs = new Set(qTok.map(grp)); if (gs.size !== 1 || qTok.some((t) => !grp(t))) return false; const core = p.lab.filter((t) => !STOP.has(t) && !TYPEW.has(t));
  if (gs.has("issue") && p.type === "date") return core.length > 0 && core.every((t) => titleToks.has(t));
  if (gs.has("paid") && p.type === "money") return core.length === 0 && [...titleToks].some((t) => PAYW.has(t));
  return false;
}
function qualOk(qTok, labToks, type) {
  const qg = new Set(qTok.map(grp).filter(Boolean)), lg = new Set(labToks.map(grp).filter(Boolean));
  for (const g of qg) if (!lg.has(g)) return false;
  for (const cls of OPP) { if (cls[0] === "issue" && type !== "date") continue; if (cls.some((g) => lg.has(g)) && !cls.some((g) => qg.has(g))) return false; }
  return true;
}


// number of distinct values of a type on a page (labelled pairs plus raw dates); used by the bare "date/amount" rules
export function distinctTyped(d, ty) { d._dt ??= {}; if (d._dt[ty]) return d._dt[ty]; const vals = new Set(); for (const u of d.units) for (const p of u.pairs) if (p.type === ty) vals.add(valKey(ty, p.value)); if (ty === "date") for (const m of d.text.matchAll(DATE_RE)) { const iso = parseDate(m[0]); if (iso) vals.add("d" + iso); } return (d._dt[ty] = vals.size); }
const onlyOne = (d, ty) => distinctTyped(d, ty) === 1;
// ---------- matching ----------
export function nameIn(textWords, name, corpus) {
  const nw = ` ${words(name).join(" ")} `; let t = ` ${textWords} `; if (!t.includes(nw)) return false;
  const sup = CFG.nameExact && corpus?.supers?.get(words(name).join(" ")); if (!sup) return true;
  for (const e of sup) t = t.split(` ${e} `).join(" # "); return t.includes(nw); // an occurrence inside a longer known name ("Acme Dental" in "Acme Dental Group") is not this party
}
function anchorMatch(a, unit) {
  const tw = unit._tw ??= words(unit.text).join(" ");
  const cw = unit._cw ??= words(unit.ctx + " " + (unit.page.file ?? "")).join(" ");
  const pw = unit.page._tw ??= words(unit.page.text + " " + (unit.page.file ?? "")).join(" ");
  if (unit.pageAnchored) { // table row of a page: anchors live on the page; the row's own key words must be named in the question
    if (!a.rowOk(unit)) return null;
    let hard = 0; for (const i of a.ids) { if (unit.page.idset.has(i)) hard++; else return null; } for (const n of a.names) { if (nameIn(pw, n, a.corpus)) hard++; else return null; }
    for (const iso of a.dates) if (![...unit.page.text.matchAll(DATE_RE)].some((m) => parseDate(m[0]) === iso)) return null;
    for (const y of a.years) if (!unit.page.text.includes(y)) return null;
    if (hard === 0) return null; return { soft: 0 };
  }
  const full = unit.kind === "row" ? tw : pw; const isRow = unit.kind === "row";
  const rowText = isRow ? unit.text + " " + unit.ctx : unit.page.text;
  let soft = 0, hard = 0;
  for (const i of a.ids) { if (isRow ? idKeysOf(unit.text).has(i) : unit.page.idset.has(i)) hard++; else if (isRow && idKeysOf(unit.ctx).has(i)) soft++; else return null; }
  for (const n of a.names) { if (nameIn(full, n, a.corpus)) { hard++; continue; } if (isRow && nameIn(cw, n, a.corpus)) { soft++; continue; } return null; }
  for (const iso of a.dates) if (![...rowText.matchAll(DATE_RE)].some((m) => parseDate(m[0]) === iso)) return null;
  for (const y of a.years) if (!rowText.includes(y)) return null;
  for (const re of a.nums) if (!re.test(rowText)) return null;
  for (const p of a.periods) if (!alnum(rowText).includes(p)) return null;
  for (const [mo, dd] of a.md) if (![...rowText.matchAll(DATE_RE)].some((m) => { const p = parseDate(m[0]); return p && +p.slice(5, 7) === mo && +p.slice(8) === dd; })) return null;
  if (isRow && (a.ids.length + a.names.length) > 0 && hard === 0) return null; // a row must carry at least one anchor itself
  return { soft };
}

function compat(pair, target, L) {
  let t = pair.type; if ((t === "int" || t === "number" || t === "text") && L?.dom === "money" && /^[\d,]+(\.\d+)?$/.test(pair.value)) t = "money";
  const v = pair.value;
  switch (target) {
    case "amount": return t === "money";
    case "date": return t === "date";
    case "count": return t === "int" || (CFG.numFix && /^\d+(?:\.\d+)?\s?[a-z]{1,6}$/i.test(v));
    case "party": { if (!(t === "name" || (t === "text" && /^[A-Z]/.test(v) && !/^\d/.test(v) && v.length <= 80 && !/@/.test(v))) || /\b(pm|am)\b/i.test(v)) return false; const w = v.split(/[\s,]+/).filter((x) => /[A-Za-z]/.test(x)); return w.length > 0 && w.filter((x) => /^[A-Z&(]/.test(x) || /^(of|and|the|de|van|von)$/i.test(x)).length / w.length >= 0.7 && !/^(qty|amount|description|total|unit|item)\b/i.test(v); }
    case "phone": return t === "phone" && (!CFG.phoneBal || ((v.match(/\(/g) ?? []).length === (v.match(/\)/g) ?? []).length));
    case "email": return t === "email";
    case "identifier": return t === "id" || ((t === "int" || t === "text" || t === "number") && /\d/.test(v) && v.length <= 40);
    default: return v.length <= 70 && t !== "empty";
  }
}
function cleanParty(v) { const m = v.match(/^(.*?)(?:,\s*(?=\d|[A-Z][a-z]+ (?:St|Rd|Ave|Blvd|Way|Dr|Ln|Ct|Pl)\b)|\s+\(|\s+[-–]\s)/); let r = (m ? m[1] : v).trim(); r = r.replace(/,\s*$/, ""); return r; }

const canon = (t) => t.replace(/e$/, "").replace(/(ers|ors|er|or|ee|ing|ed|ion|ation|at|al)$/, "");
// exact stem match, or a verb form in the question against an agent-noun label (drive/driver, donate/donor)
function tokMatch(t, l) { if (t === l) return 1; if (CFG.gsyn && grp(t) && grp(t) === grp(l)) return 0.9; if (/(er|or|ee)$/.test(l) && !/(er|or|ee)$/.test(t) && t.length >= 4) { const a = canon(t), b = canon(l); if (a.length >= 3 && a === b) return 0.9; } return 0; }
const verbish = (t) => /(ed|ing)$/.test(t) && t.length > 4;
function lexScore(ql, qlSkip, qfull, lab0, learned, wt, present) {
  const q = ql.filter((t) => !qlSkip.has(t)); if (!q.length) return null;
  const best = (labAll) => {
    const lab = labAll.filter((t) => !STOP.has(t)); const labToks = lab.length ? lab : labAll;
    let num = 0, den = 0; for (const t of q) { let m = 0; for (const l of labToks) m = Math.max(m, tokMatch(t, l)); let w = wt(t) * (verbish(t) ? 0.5 : 1); if (!m && !present(t) && !verbish(t)) w = Math.max(w, 1.6); den += w; num += w * m; }
    if (!num) return 0;
    let cn = 0, cd = 0; for (const l of labToks) { const w = wt(l); cd += w; let m = 0; for (const t of qfull) m = Math.max(m, tokMatch(t, l)); cn += w * m; }
    lexScore.r = num / den; return 0.75 * (num / den) + 0.25 * (cn / cd);
  };
  let s = best(lab0), rr = lexScore.r;
  const syn = learned.syn.get(lab0.join(" ")); if (syn) for (const [l2, j] of syn) { const L2 = learned.labels.get(l2); if (L2) { const v = best(L2.lab) * (0.7 + 0.2 * j); if (v > s) { s = v; rr = lexScore.r; } } }
  lexScore.r = rr; return s;
}
const definesDate = (d, iso) => { const head = d.text.split("\n").filter((l) => l.trim()).slice(0, 3).join(" "); return [...head.matchAll(DATE_RE)].some((m) => parseDate(m[0]) === iso) || (d.file ?? "").includes(iso) || (d.file ?? "").includes(iso.replace(/-/g, "")); };
const DOC_MARK = /\b(supersede[sd]?|supersedes|replaces|replaced|revised|amended|amendment|restated)\b/i;
const definesId = (d, ids) => { const head = idKeysOf((d.file ?? "") + " " + (CFG.defNB ? d.text.split("\n").filter((l) => l.trim()).slice(0, 5) : d.text.split("\n").slice(0, 3)).join(" ")); return ids.length && ids.every((i) => head.has(i)); };

const definesId8 = (d, ids) => { const head = idKeysOf((d.file ?? "") + " " + d.text.split("\n").slice(0, 8).join(" ")); return ids.length && ids.every((i) => head.has(i)); };
const pageStems = (d) => d._st ??= new Set(d.toks.map(stem));
// ---------- the reader ----------
export function readValue(corpus, question, opts = {}) {
  const k = opts.k ?? 5; const a = analyze(question, corpus);
  const out = (o) => ({ ...o, target: a.target });
  if (CFG.ocr) a.ids = a.ids.map((i) => { if (corpus.allIds.has(i)) return i; const cm = corpus.confMap.get(confKey(i)); return cm && cm.size === 1 ? [...cm][0] : i; }); // OCR confusables (I/l/1, O/0) in a printed id
  for (const i of a.ids) if (!corpus.allIds.has(i)) return out({ ans: null, why: "unknown-id" });
  const top = opts.only ? corpus.docs.filter((d) => opts.only.has(d)) : retrieve(corpus, a, k); const learned = corpus.learned;
  if (CFG.line) { const lr = lineItemRead(a, top, opts, question); if (lr) return out(lr); }
  const maxIdf = Math.log(2 + learned.nLabelPages);
  const wt = (t) => learned.tokDf.has(t) ? 1.0 + 0.5 * Math.log(2 + learned.nLabelPages / (1 + learned.tokDf.get(t))) / maxIdf : 0.6;
  const qfull = new Set(words(question).map(stem));
  const cands = []; const poison = new Set();
  const hasAnchor = a.ids.length + a.names.length > 0;
  const rowLines = new Set(); if (CFG.rowPref) for (const d of top) for (const u of d.units) if (u.pageAnchored && a.rowOk(u)) rowLines.add(words(u.text).join(" "));
  for (const d of top) for (const u of d.units) {
    if (opts.onlyUnits && !opts.onlyUnits.has(u)) continue;
    const am = anchorMatch(a, u); if (!am) continue;
    if (hasAnchor && u.kind === "doc" && !(CFG.capDoc && u.pairs.some((p0) => (p0.src === "cap" || p0.src === "kv2") && a.ids.includes(alnum(p0.value)))) && d.units.some((x) => x.kind === "row" && !x.pageAnchored && anchorMatch(a, x))) continue; // the anchor lives in a table row of this page: read the row, not the page
    const lines = d._lines ??= d.text.split("\n").map((l) => words(l).join(" "));
    const nameLns = []; if (u.kind === "doc" && a.names.length) lines.forEach((l, i) => { if (a.names.some((n) => ` ${l} `.includes(` ${words(n).join(" ")} `))) nameLns.push(i); });
    const titleToks = (u._tt ??= new Set(words(u.title + " " + (u.rowKey ?? "")).map(stem)));
    const descr = new Set(); for (const p of u.pairs) { const vn = ` ${words(p.value).join(" ")} `; const va = alnum(p.value); if (a.names.some((n) => vn.includes(` ${words(n).join(" ")} `)) || a.ids.some((i) => va.includes(i))) for (const t of p.lab) descr.add(t); }
    for (const p of u.pairs) {
      const L = learned.labels.get(p.lab.join(" "));
      if (!compat(p, a.target, L)) continue;
      if (CFG.howQ && (p.type === "money" || p.type === "date") && /^\s*how\s+(?:was|were|is|are|did|does|do)\b/i.test(question)) continue;   // "how was X made" asks for a method, not an amount or a date
      if (CFG.qdom && (p.type === "text" || p.type === "name" || p.type === "int" || p.type === "number")) { const qd = (a._qdom ??= (() => { const t = a.ql.filter((x) => !STOP.has(x)); if (!t.length) return null; const agg = {}; let n = 0; for (const L2 of learned.labels.values()) { if (L2.n < 3 || !t.every((x) => L2.lab.includes(x))) continue; n += L2.occ; for (const [ty, c] of Object.entries(L2.types)) agg[ty] = (agg[ty] ?? 0) + c; } if (n < 5) return null; for (const ty of ["money", "date"]) if ((agg[ty] ?? 0) / n >= 0.9) return ty; return null; })()); if (qd && (qd === "date" || p.type !== "int" && p.type !== "number" || qd === "money" && !/^\d{1,2}$/.test(p.value))) continue; }   // the asked label is money/date everywhere else; a prose or caption value cannot be it
      if (CFG.labelVal && p.type !== "money" && p.type !== "date" && (() => { const vw = words(p.value); if (vw.length < 5 || /\d/.test(p.value)) return false; const key = vw.join(" "); const bp = (corpus._bp ??= new Map()); if (!bp.has(key)) { let n = 0; for (const dd of corpus.docs) { const ll = (dd._wl ??= " " + words(dd.text).join(" ") + " "); if (ll.includes(" " + key + " ")) n++; } bp.set(key, n); } return bp.get(key) >= 3; })()) { poison.add(d); continue; } // boilerplate caption (printed on 3+ pages) read as a value
      if (CFG.labelVal && p.type !== "money" && p.type !== "date" && p.type !== "count" && alnum(p.value).length < 3 && !(CFG.ing && (p.src === "cap" || p.src === "kv2") && (p.type === "number" || p.type === "int"))) continue; // fragment, not a value
      if (p.src === "near" && !["amount", "date", "count"].includes(a.target)) continue;
      if (CFG.echoVal && (p.type === "text" || p.type === "name")) { const vw = words(p.value).filter((w) => w.length >= 3); if (vw.length && vw.length <= 3) { const qs = (a._qs ??= new Set(words(question).map(stem))); if (vw.every((w) => qs.has(stem(w)))) continue; } }   // the "value" is just a word of the question (a caption split off its label)
      if (CFG.rowPref && p.src === "near" && p.line && rowLines.has(words(p.line).join(" "))) continue; // that line is a table row read as a row
      if (CFG.rowPref && u.pageAnchored && a.target === "amount" && p !== u.pairs[u.pairs.length - 1] && !a.ql.some((t) => p.lab.includes(t))) { const lastM = [...u.pairs].reverse().find((x) => x.type === "money"); if (lastM && p !== lastM && !a.qlAll.some((t) => p.lab.includes(t)) && !(CFG.rateKeep && (a._qs ??= new Set(words(question).map(stem))).size && p.lab.some((t) => a._qs.has(t) && !STOP.has(t) && !TYPEW.has(t)))) continue; }
      const QL = CFG.kindLab && a.qlAll.some((t) => p.lab.includes(t) && !a.ql.includes(t)) ? a.qlAll : a.ql;
      const skip = new Set(QL.filter((t) => (titleToks.has(t) || descr.has(t)) && !p.lab.includes(t) && !(CFG.headKeep && !TYPEW.has(t) && u.pairs.some((q2) => q2 !== p && q2.src !== "near" && q2.lab.includes(t) && q2.type === "money"))));
      let lex = lexScore(QL, skip, qfull, p.lab, learned, wt, (t) => pageStems(d).has(t));
      if (CFG.qual) {
        const qRest0 = QL.filter((t) => !skip.has(t)); const syn0 = learned.syn.get(p.lab.join(" ")); let labT = [...p.lab]; if (syn0) for (const l2 of syn0.keys()) labT.push(...l2.split(" "));
        if (!qualOk(qRest0, p.lab, p.type) && !qualOk(qRest0, labT, p.type) && !(CFG.qualDoc && docQual(qRest0, p, titleToks))) continue;
        if (qRest0.length && qRest0.every((t) => TYPEW.has(t)) && !(CFG.bareOne && (a.target === "amount" || a.target === "date") && (!CFG.bareDef || !a.ids.length || definesId8(d, a.ids)) && onlyOne(d, a.target === "date" ? "date" : "money")) && p.lab.some((t) => !STOP.has(t) && !TYPEW.has(t) && !qfull.has(t) && !titleToks.has(t))) continue; // a bare "amount"/"date" needs an exact label
      }
      const lexR = lexScore.r; const qRest = QL.filter((t) => !skip.has(t)); if (lex === 0 && qRest.length && qRest.every(verbish)) lex = null; // only an event verb left: type + anchors decide
      const prior = L?.prior ?? 0.1;
      let score;
      if (lex === null) { if (!a.ids.length && !(a.names.length && u.kind === "row")) continue; if (CFG.rowPref && u.pageAnchored && a.target === "amount") score = 0.7; else if (["amount", "date"].includes(a.target)) score = 0.3 + 0.5 * prior; else if (a.target === "party" && L && L.card >= 0.5 && L.occ >= 3) score = 0.66; else continue; }
      else { if ((lexR ?? 0) < (opts.minR ?? 0.5)) continue; score = 0.85 * lex + 0.15 * prior; }
      if (p.src === "near") score *= 0.9; if (CFG.proseDown && p.src === "prose" && p.cl) score *= 0.88; if (u.kind === "row" && am.soft) score *= 0.9;
      if (u.kind === "doc" && a.names.length && !a.ids.length && nameLns.length && p.line) { const li = lines.indexOf(words(p.line).join(" ")); if (li >= 0 && !nameLns.some((n) => n <= 11 || Math.abs(n - li) <= 3)) continue; }
      if (a.names.length && u.kind === "doc" && p.line) { const ln = ` ${words(p.line).join(" ")} `; if (a.names.every((n) => ln.includes(` ${words(n).join(" ")} `))) score += 0.2; }
      let value = p.value, type = p.type; if ((type === "int" || type === "number" || type === "text") && L?.dom === "money" && /^[\d,]+(\.\d+)?$/.test(value) && a.target === "amount") type = "money";
      if (a.target === "party") { value = cleanParty(value); type = "name"; }
      if (a.target === "date") { if (!parseDate(value)) continue; }
      { const vk = alnum(value); if (a.ids.includes(vk) || a.names.some((n) => alnum(n) === vk) || idKeysOf(value).size && [...idKeysOf(value)].every((x) => a.ids.includes(x))) continue; }
      if (!norm(d.text).includes(norm(value).replace(/ +/g, " ")) && !norm(u.text).includes(norm(value))) continue; // verbatim check
      const labCore = p.lab.filter((t) => !STOP.has(t) && !TYPEW.has(t)).sort().join(" "), qCore = qRest.filter((t) => !TYPEW.has(t)).sort().join(" ");
      cands.push({ exact: !!qCore && labCore === qCore, value, type, label: p.label, lab: p.lab, score, lex, doc: d, unit: u, key: valKey(type, value), src: p.src, line: p.line });
    }
  }
  if (poison.size) for (let i = cands.length - 1; i >= 0; i--) if (poison.has(cands[i].doc)) cands.splice(i, 1); // a caption sat where the value should be: that page is not read
  if (!cands.length) return out({ ans: null, why: "no-candidate" });
  if (CFG.bareMulti && a.ql.length && a.ql.every((t) => TYPEW.has(t)) && (a.target === "date" || a.target === "amount")) { // a bare "date/amount on <ID>": abstain when the page holds several distinct values of that type and none is labelled by the bare word alone
    const ty = a.target === "date" ? "date" : "money";
    for (const d of new Set(cands.map((c) => c.doc))) {
      const vals = { size: distinctTyped(d, ty) };
      const generic = cands.some((c) => c.doc === d && c.type === ty && c.lab.every((t) => STOP.has(t) || TYPEW.has(t)));
      if (vals.size >= 2 && !generic) return out({ ans: null, why: "bare-multi-value" });
    }
  }
  if (CFG.dateDef && a.dates.length) { const df = cands.filter((c) => a.dates.some((iso) => definesDate(c.doc, iso))); if (df.length) { cands.length = 0; cands.push(...df); } }
  if (CFG.bareAmb && a.ids.length && a.ql.length && a.ql.every((t) => TYPEW.has(t))) { const dset = new Set(corpus.docs.filter((x) => a.ids.every((i) => x.idset.has(i))).map((x) => x.file)); const fnames = new Set(cands.map((c) => c.doc.file)); if (dset.size > 1 || [...dset].some((f) => !fnames.has(f))) { if (dset.size > 1) return out({ ans: null, why: "bare-ambiguous" }); } }
  // supersession: a document that says it supersedes/amends and carries a matching candidate overrides older copies sharing the anchors
  const best0 = Math.max(...cands.map((c) => c.score));
  let pool = cands.filter((c) => c.score >= best0 - 0.2);
  if (new Set(pool.map((c) => c.key)).size > 1) {
    const mp = pool.filter((c) => DOC_MARK.test(c.doc.text) && definesId(c.doc, a.ids)); const kk = new Set(mp.map((c) => c.key));
    if (a.ids.length && kk.size === 1 && mp.length < pool.length) {
      if ((/\b(current|latest|now|revised|updated|new|newest|amended|after|today)\b/i.test(question) || (CFG.sup && !/\b(original|previous|prior|old|earlier|first|before|superseded)\b/i.test(question))) && opts.supersede !== false) pool = mp; // newest copy asked for (or the question is plain and the newer copy says it supersedes)
      else return out({ ans: null, why: "superseded-ambiguous" }); // an older copy exists; do not state either unasked
    }
  }
  { const c0 = pool[0]; const MARK2 = /\b(supersede\w*|replace[sd]?|revis\w+|amend\w*|correct(?:ed|ion)|void(?:ed)?|cancel+ed|restated|reissue\w*)\b/i;
    if (!a.ids.length && a.names.length && opts.nameGuard === true) for (const d of corpus.docs) { if (pool.some((c) => c.doc === d)) continue; if (a.names.every((n) => nameIn(words(d.text).join(" "), n)) && MARK2.test(d.text) && !pool.every((c) => MARK2.test(c.doc.text))) return out({ ans: null, why: "newer-version-exists", doc: d.file }); }
    if (a.ids.length && opts.newerGuard !== false) for (const d of corpus.docs) { if (pool.some((c) => c.doc === d)) continue; if ((CFG.id8 ? definesId8 : definesId)(d, a.ids) && MARK2.test(d.text) && !pool.every((c) => MARK2.test(c.doc.text))) return out({ ans: null, why: "newer-version-exists", doc: d.file }); } }
  const groups = new Map(); for (const c of pool) { const g = groups.get(c.key) ?? { key: c.key, best: c, n: 0 }; g.n++; if (c.score > g.best.score) g.best = c; groups.set(c.key, g); }
  { const t0 = [...groups.values()].sort((x, y) => y.best.score - x.best.score)[0].best;
    const rival = cands.find((c) => c.doc !== t0.doc && c.key !== t0.key && (c.lex ?? 0) >= (opts.rivalLex ?? 0.4) && (c.lab.some((x) => t0.lab.includes(x) && !STOP.has(x)) || c.label === t0.label) && c.unit.kind === t0.unit.kind && !(DOC_MARK.test(c.doc.text) || DOC_MARK.test(t0.doc.text)));
    if (rival && opts.rival !== false) return out({ ans: null, why: "cross-document-conflict", alt: [t0.value, rival.value] }); }
  const gs = [...groups.values()].sort((x, y) => y.best.score - x.best.score);
  let top1 = gs[0];
  const MINS = opts.minScore ?? 0.62;
  if (top1.best.score < MINS) return out({ ans: null, why: "low-score", score: top1.best.score, alt: [top1.best.label + "=" + top1.best.value + " lex=" + (top1.best.lex ?? "null")?.toString().slice(0,4)] });
  if (CFG.exactTie && gs.length > 1 && gs[1].best.score > top1.best.score - (opts.margin ?? 0.15)) { const near = gs.filter((g) => g.best.score > top1.best.score - (opts.margin ?? 0.15)); const ex = near.filter((g) => pool.some((c) => c.key === g.key && c.exact && c.doc === g.best.doc)); if (ex.length === 1 && near.length - ex.length >= 1 && near.every((g) => g === ex[0] || !pool.some((c) => c.key === g.key && c.exact))) { gs.splice(0, gs.length, ex[0]); top1 = ex[0]; } }
  if (gs.length > 1 && gs[1].best.score > top1.best.score - (opts.margin ?? 0.15)) return out({ ans: null, why: "ambiguous", score: top1.best.score, alt: gs.slice(0, 3).map((g) => g.best.value) });
  const c = top1.best;
  // verification: totals reconcile with line items
  if (a.target === "amount" && c.type === "money") { const r = reconcile(c, corpus); if (r === "fail") return out({ ans: null, why: "reconcile-fail" }); c.reconcile = r; }
  if (CFG.rowGuard && c.src === "near" && c.line && tableLike(c.line)) return out({ ans: null, why: "near-in-table-row" });
  if (CFG.ocr && c.doc.ocr && c.type === "money" && ocrCheck(c.doc) !== "pass" && !(CFG.ocrVer && c.doc.ver?.includes(c.value))) return out({ ans: null, why: "ocr-unverified" });
  return out({ ans: c.value, label: c.label, score: c.score, doc: c.doc.file, page: c.doc.page_no, reconcile: c.reconcile });
}

function reconcile(c, corpus) {
  if (CFG.rowRecon && c.unit?.kind === "row" && c.unit.pdfTable) {   // a table row is checked on its own arithmetic: units x rate = amount (when it carries both); other rows are not held to the page total
    const ps = c.unit.pairs, nums = ps.filter((p) => p.type === "int" || p.type === "number").map((p) => Number(String(p.value).replace(/,/g, ""))), ms = ps.filter((p) => p.type === "money").map((p) => moneyNum(p.value));
    if (nums.length === 1 && ms.length >= 2) { const q = nums[0], v = moneyNum(c.value); const amt = ms[ms.length - 1], rate = ms[0]; if (Math.abs(q * rate - amt) < 0.011 || Math.abs(q * rate - amt) / Math.max(1, amt) < 0.0001) return "pass"; return "fail"; }
    return "n/a";
  }
  const d = c.doc; if (!/total|due|amount/i.test(c.label) || /sub/i.test(c.label)) return "n/a";
  const rows = d.units.filter((u) => u.pdfTable); if (rows.length < 2) return "n/a";
  const amts = rows.map((u) => { const ms = u.pairs.filter((p) => p.type === "money"); return ms.length ? moneyNum(ms[ms.length - 1].value) : null; });
  if (amts.some((x) => x === null)) return "n/a";
  const S = Math.round(amts.reduce((x, y) => x + y, 0) * 100) / 100; const v = moneyNum(c.value);
  const kvm = (re) => d.units.find((u) => u.kind === "doc")?.pairs.filter((p) => p.type === "money" && re.test(p.label) && (!CFG.recon || ((p.src === "kv" || p.src === "kv2") && p.label.split(/\s+/).length <= 3))).map((p) => moneyNum(p.value)) ?? [];
  const adds = kvm(/tax|fee|shipping|freight|surcharge/i); const disc = kvm(/discount|credit/i);
  const cand = new Set([S]); const subs = (arr) => { const out = [0]; for (const x of arr.slice(0, 5)) for (const y of [...out]) out.push(Math.round((y + x) * 100) / 100); return out; };
  for (const a1 of subs(adds)) for (const d1 of subs(disc)) cand.add(Math.round((S + a1 - d1) * 100) / 100);
  if (CFG.tbl) { const monies = d.units.find((u) => u.kind === "doc")?.pairs.filter((p) => p.type === "money").map((p) => moneyNum(p.value)) ?? []; for (const x of [...cand]) for (const m of monies) cand.add(Math.round((x - m) * 100) / 100); } // balance after a payment printed on the page
  for (const x of cand) if (Math.abs(x - v) < 0.011) return "pass";
  return "fail";
}

// OCR text: a money value is only stated when the page's own arithmetic holds (lines -> subtotal -> +tax -> total; total - paid -> balance).
function ocrCheck(d) {
  const kv = d.units.find((u) => u.kind === "doc")?.pairs.filter((p) => p.type === "money" && (p.src === "kv" || p.src === "kv2")) ?? [];
  const get = (re, not) => { const x = kv.filter((p) => re.test(p.label) && !(not && not.test(p.label))); return x.length ? moneyNum(x[0].value) : null; };
  const sub = get(/sub|parts|merchandise|charges|net|fees and costs|services/i), tax = get(/tax|gst/i), tot = get(/total|billed|amount billed|invoice amount|gross|charges$/i, /sub|paid/i), paid = get(/paid|payments|deposits|applied|trust|less/i), bal = get(/balance|outstanding|owing|owed|net due|open|remaining|due$/i);
  const rows = d.units.filter((u) => u.pdfTable).map((u) => { const m = u.pairs.filter((p) => p.type === "money"); return m.length ? moneyNum(m[m.length - 1].value) : null; }); let pass = 0;
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
  if (rows.length >= 2 && !rows.includes(null) && sub != null) { if (eq(rows.reduce((x, y) => x + y, 0), sub)) pass++; else return "fail"; }
  if (sub != null && tax != null && tot != null) { if (eq(sub + tax, tot)) pass++; else return "fail"; }
  if (tot != null && paid != null && bal != null) { if (eq(tot - paid, bal)) pass++; else return "fail"; }
  return pass ? "pass" : "none";
}
