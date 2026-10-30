// valuereader2 operators: record selection (latest/earliest/by month), multi-hop, compare, aggregate (sum/count). Generic; stricter-first.
// Every operator reads each fact through the single-fact reader (readSingle) so each number carries its own verification, then does the
// arithmetic / ordering in code. Any step that cannot be verified, or an incomplete record set, abstains.
import { readValue as readSingle, analyze, idKeysOf, nameIn } from "./vr_core.js";
import { norm, stem, words, STOP, parseDate, valueType, moneyNum, MONTHS, DATE_RE, CFG } from "./vr_text.js";

const DOC_MARK = /\b(supersede[sd]?|supersedes|replaces|replaced|revised|amended|amendment|restated)\b/i;
const titleToks = (d) => (d._ttk ??= new Set(words((d.file ?? "").replace(/[_.\-]/g, " ") + " " + d.text.split("\n").filter((l) => l.trim()).slice(0, 3).filter((l) => /^[A-Za-z][A-Za-z /&'-]{2,48}$/.test(l.trim().replace(/\s{2,}.*$/, "")) && l.trim().split(/\s{2,}/)[0].split(/\s+/).length <= 5).map((l) => l.trim().split(/\s{2,}/)[0]).join(" ")).map((w) => stem(w).replace(/e$/, ""))));
const defId = (d) => { const head = d.text.split("\n").filter((l) => l.trim()).slice(0, 8).join(" "); const h = idKeysOf(head); if (h.size) return [...h][0]; const f = idKeysOf((d.file ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-](?:revised|copy|reprint|customer|amendment\d*|amended|final|v\d+)(?:[_-].*)?$/i, "")); return f.size ? [...f][0] : null; };
const firstDate = (text) => { for (const m of String(text).matchAll(DATE_RE)) { const iso = parseDate(m[0]); if (iso) return iso; } return null; };
const monthYear = (q) => { const m = q.match(new RegExp(`\\b(?:in|during|for)\\s+(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]*\\.?(?:\\s+(\\d{4}))?`, "i")); if (!m) return null; return { mo: MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase())) + 1, yr: m[2] ? +m[2] : null }; };
const inMY = (iso, my) => iso && +iso.slice(5, 7) === my.mo && (!my.yr || +iso.slice(0, 4) === my.yr);
const fmtLike = (sample, cents) => {
  const m = String(sample).match(/^([^\d-]*)([\d.,]+)(.*)$/); const pre = m ? m[1] : "$", suf = m ? m[3] : ""; const eu = m && /,\d{2}$/.test(m[2]) && !/\.\d{2}$/.test(m[2]);
  let n = (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); if (eu) n = n.replace(/,/g, "X").replace(".", ",").replace(/X/g, "."); return (cents < 0 ? "-" : "") + pre + n + suf; };
const curOf = (v) => String(v).replace(/[\d.,\s]/g, "");
const src = (d) => ({ doc: d.file, page: d.page_no });


// ---- kind aliasing mined from the corpus (valuereader4): a question noun that names no document title ("invoice") is mapped to the title head noun of the
// billing-record class actually present (documents with a defining id, a date and >=3 money fields), only when that class is unique for the named party.
const printedTitle = (d) => { for (const l of d.text.split("\n").filter((x) => x.trim()).slice(0, 4)) { const t = l.trim().split(/\s{2,}/)[0]; if (/^[A-Z][A-Za-z &\/'-]{3,40}$/.test(t) && t.split(/\s+/).length <= 4) return t; } return null; };
const isBillingRec = (d) => (d._br ??= (() => { if (!defId(d) || !firstDate(d.text) || !printedTitle(d)) return false; const doc = d.units.find((u) => u.kind === "doc"); return !!doc && doc.pairs.filter((p) => p.type === "money").length >= 3; })());
function resolveKind(corpus, kindToks, name) {
  if (!CFG.kindSyn || !kindToks.length) return null;
  if (corpus.docs.some((d) => kindToks.every((t) => titleToks(d).has(t)))) return null; // the noun names a real title: no aliasing
  const pool = corpus.docs.filter((d) => isBillingRec(d) && (!name || nameIn(words(d.text).join(" "), name, corpus)));
  const heads = new Set(pool.map((d) => ks(words(printedTitle(d)).pop())));
  if (heads.size !== 1) return null; const h = [...heads][0]; return h ? [h] : null;
}

// ---- records: pages (grouped by defining id, newest copy marked) anchored by a name and a kind noun ----
function recordPages(corpus, name, kindToks) {
  const pages = corpus.docs.filter((d) => nameIn(words(d.text).join(" "), name, corpus) && kindToks.every((t) => titleToks(d).has(t)));
  const groups = new Map(); let i = 0;
  for (const d of pages) { const k = defId(d) ?? "#" + i++; (groups.get(k) ?? groups.set(k, []).get(k)).push(d); }
  return [...groups.entries()].map(([id, ds]) => {
    const mk = ds.filter((x) => DOC_MARK.test(x.text)); const use = mk.length && mk.length < ds.length ? mk : ds; // a copy that says it supersedes the others is the record
    const conflict = use.length > 1 && new Set(use.map((x) => norm(x.text))).size > 1 && !mk.length;
    return { id, pages: use, date: firstDate(use[use.length - 1].text), marked: mk.length > 0, conflict };
  });
}
const ks = (w) => stem(w).replace(/e$/, "");
const dropFiller = (qs, bad) => qs.filter((w) => !bad.has(w.toLowerCase()));

// ---------------- selector ----------------
function trySelect(corpus, q, opts) {
  let a = analyze(q, corpus); if (!CFG.selName && a.names.length !== 1) return null;
  let name = a.names[0];
  const sm = q.match(/\b(?:the\s+)?(latest|most recent|newest|earliest|oldest|first|last)\s+((?:[a-z-]+\s){0,2}?[a-z-]+?)\s+(?:for|of|from|to|at|with)\s/i);
  const my = monthYear(q);
  const km = !sm ? q.match(/\bthe\s+((?:[a-z-]+\s)?[a-z-]+)\s+(?:for|of|from|to|at)\s+/i) : null;
  if (!sm && !(my || a.dates.length) ) return null;
  if (CFG.selName) { const m0 = sm ?? km; const rest = m0 ? q.slice(m0.index + m0[0].length) : q; const rn = analyze(rest, corpus).names; if (rn.length === 1) name = rn[0]; else if (a.names.length === 1) name = a.names[0]; else return null; }
  if (sm && sm[1].toLowerCase() === "last" && !/\bfor\b/i.test(q)) return null;
  const kindStr = (sm ? sm[2] : km ? km[1] : ""); let kindToks = words(kindStr).filter((w) => !STOP.has(w)).map(ks); if (!kindToks.length) return null; { const k2 = resolveKind(corpus, kindToks, name); if (k2) kindToks = k2; }
  const recs = recordPages(corpus, name, kindToks); if (!recs.length) return { ans: null, why: "no-records" };
  let sel = recs;
  if (my) sel = sel.filter((r) => inMY(r.date, my));
  if (a.dates.length) sel = sel.filter((r) => a.dates.includes(r.date));
  if (sm) { if (sel.some((r) => !r.date)) return { ans: null, why: "undated-record" }; const mx = /latest|most recent|newest|last/i.test(sm[1]); const best = sel.reduce((b, r) => (b == null || (mx ? r.date > b : r.date < b) ? r.date : b), null); sel = sel.filter((r) => r.date === best); }
  if (sel.length !== 1) return { ans: null, why: sel.length ? "ambiguous-record" : "no-record-in-range" };
  const rec = sel[0]; if (rec.conflict) return { ans: null, why: "conflicting-copies" }; const only = new Set(rec.pages);
  const q2 = q.replace(/\b(latest|most recent|newest|earliest|oldest|first|last)\b\s*/ig, "").replace(/\s+issued\s+(?:in\s+)?[A-Za-z]+\.?(?:\s+\d{1,2},?)?(?:\s+\d{4})?(?=\?|$)/i, "").replace(new RegExp("\\s+(?:issued|dated|billed|sent|invoiced)(?:\\s+on)?\\s+(?:" + DATE_RE.source + ")(?=\\?|$)", "i"), "").replace(new RegExp("\\s+(?:for|in|during|of)\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,2}(?:ending|of|on|dated|starting|beginning)\\s+(?:" + DATE_RE.source + ")(?=\\?|$)", "i"), "").replace(/\s+/g, " ");
  const r = readSingle(corpus, q2, { ...opts, only, noOps: true }); if (r.ans == null) return { ...r, why: "selected-record:" + r.why };
  return { ...r, detail: `${sm ? sm[1].toLowerCase() : "matching"} ${kindStr} for ${name}: ${rec.id} (${rec.date})`, sources: rec.pages.map(src) };
}

// ---------------- compare ----------------
const HI = /\b(higher|larger|greater|bigger|more|later|newer|longer|latest)\b/i, LO = /\b(lower|smaller|less|earlier|sooner|older|shorter|earliest)\b/i;
function tryCompare(corpus, q, opts) {
  if (!/\b(which|who|between|compare)\b/i.test(q)) return null; const hi = HI.test(q), lo = LO.test(q); if (hi === lo) return null;
  const a = analyze(q.replace(/^\s*(between|compare)\s+/i, ""), corpus);
  const ids = [...new Set(a.idRaw)]; const names = [...new Set(a.names.filter((n) => !/^(Between|Compare|Which|Who)$/i.test(n)))];
  const anchors = ids.length === 2 ? ids : names.length === 2 && !ids.length ? names : null; if (!anchors) return null;
  const bad = new Set(["which", "who", "between", "compare", "has", "have", "is", "are", "was", "the", "than", "or", "and", "versus", "vs", "on", "for", "of", "a", "an", "their", "invoice", "one", "to", "customer", "what"]);
  const cmpW = /^(higher|larger|greater|bigger|more|later|newer|longer|lower|smaller|less|earlier|sooner|older|shorter)$/i;
  const anchorWords = new Set(anchors.flatMap((x) => words(x)));
  const sw = q.match(/\b(latest|most recent|newest|earliest|oldest)\b/i); const kindM = sw ? q.match(/\b(?:latest|most recent|newest|earliest|oldest)\s+((?:[a-z-]+\s)?[a-z-]+?)\s+(?:for|of)\b/i) : null;
  let attr = words(q).filter((w) => !bad.has(w) && !cmpW.test(w) && !anchorWords.has(w) && !/^(latest|most|recent|newest|earliest|oldest)$/.test(w) && !(kindM && words(kindM[1]).includes(w)));
  // keep "invoice" when it is part of the attribute phrase (e.g. "invoice total")
  if (/\binvoice (?:total|date|number)/i.test(q) || /\b\w+ (?:total|date)\b/i.test(q)) attr = words(q).filter((w) => !bad.has(w) || w === "invoice").filter((w) => !cmpW.test(w) && !anchorWords.has(w) && !/^(latest|most|recent|newest|earliest|oldest)$/.test(w));
  if (!attr.length) return { ans: null, why: "compare-no-attribute" };
  const vals = [];
  for (const an of anchors) {
    const isId = ids.length === 2; const where = isId ? `on ${an}` : (sw ? `on the ${sw[1].toLowerCase()} ${kindM ? kindM[1] : "invoice"} for ${an}` : `for ${an}`);
    const r = readSingle(corpus, `What is the ${[...new Set(attr)].join(" ")} ${where}?`, { ...opts, noOps: false }); if (r.ans == null) return { ans: null, why: "compare-side:" + r.why };
    vals.push(r);
  }
  const ty = vals.map((r) => valueType(r.ans)); if (ty[0] !== ty[1] || !["money", "date", "int", "number"].includes(ty[0])) return { ans: null, why: "compare-type" };
  const key = (r, t) => (t === "money" ? moneyNum(r.ans) : t === "date" ? parseDate(r.ans) : parseFloat(r.ans)); const k0 = key(vals[0], ty[0]), k1 = key(vals[1], ty[0]);
  if (k0 == null || k1 == null || k0 === k1) return { ans: null, why: "compare-tie" };
  const win = (hi ? k0 > k1 : k0 < k1) ? 0 : 1;
  return { ans: anchors[win], label: attr.join(" "), doc: vals[win].doc, page: vals[win].page, detail: `${anchors[0]}: ${vals[0].ans}; ${anchors[1]}: ${vals[1].ans}`, sources: vals.flatMap((r) => (r.sources ?? [{ doc: r.doc, page: r.page }])) };
}

// ---------------- aggregate ----------------
function tryAggregate(corpus, q, opts) {
  const isCount = /\bhow many\b/i.test(q), isSum = !isCount && /\b(all|every|each|across|combined|add up|altogether|in total|overall)\b/i.test(q) && /\b(total|sum|combined|add up|altogether|in total|how much|paid|balance|amount|owed|received)\b/i.test(q);
  if (!isCount && !isSum) return null; if (/\b(latest|most recent|newest|earliest|oldest)\b/i.test(q)) return null;
  const a = analyze(q, corpus); const name = a.names.length === 1 ? a.names[0] : null; if (a.names.length > 1 || a.ids.length) return null;
  if (!name && a.dates.length) return null; // "...held on <date>" is a lookup
  let noun = null;
  if (isCount) { const m = q.match(/\bhow many\s+((?:[a-z-]+\s){0,2}?[a-z-]+?)\s+(?:does|did|has|have|were|are|was|is|do|had|in|for|from)\b/i); noun = m && m[1]; }
  else { const m = q.match(/\b(?:all|every|each)\s+((?:[a-z-]+\s)?[a-z-]+?)(?:\s+(?:for|from|to|of|issued|received|by|in|made|billed|that)\b|[?.,]|$)/i) || q.match(/\b(?:of|on)\s+(?:all\s+)?([a-z-]+s)\s+(?:for|from|to)\b/i); noun = m && m[1]; }
  if (!noun) return null; let kindToks = words(noun).filter((w) => !STOP.has(w)).map(ks); if (!kindToks.length) return null;
  if (CFG.unitNoun && kindToks.length === 1 && !corpus.docs.some((d) => kindToks.every((t) => titleToks(d).has(t))) && corpus.docs.some((d) => new RegExp("\\b\\d+\\s+" + noun.replace(/[^a-z]/gi, "") + "\\b", "i").test(d.text))) return null; // a unit that follows numerals (12 months), not a record kind
  { const k2 = resolveKind(corpus, kindToks, name); if (k2) kindToks = k2; }
  const my = monthYear(q);
  let kindPages = corpus.docs.filter((d) => kindToks.every((t) => titleToks(d).has(t)));
  if (!kindPages.length && CFG.aggAll && kindToks.length > 1) for (const t of kindToks) { kindPages = corpus.docs.filter((d) => titleToks(d).has(t)); if (kindPages.length) { kindToks.splice(0, kindToks.length, t); break; } }
  if (!kindPages.length) return { ans: null, why: "agg-no-kind" };
  // record units
  const recs = [];
  const sheetPages = kindPages.filter((d) => d.units.some((u) => u.kind === "row" && !u.pdfTable));
  if (!name && CFG.aggAll && isCount && my && kindPages.every((d) => !sheetPages.includes(d))) { // "how many <docs> were issued in <month>": count document records of the kind (every page must carry a defining id and a date)
    if (kindPages.some((d) => !defId(d) || !firstDate(d.text))) return { ans: null, why: "unanchored-undated" };
    const ttl = (d) => { const l = d.text.split("\n").filter((x) => x.trim()).slice(0, 4).map((x) => x.trim().split(/\s{2,}/)[0]).find((x) => /^[A-Z][A-Z &\/'-]{3,40}$/.test(x)); return l ?? "?"; };
    if (new Set(kindPages.map(ttl)).size > 1) return { ans: null, why: "unanchored-mixed-kinds" }; // e.g. customer invoices and supplier invoices both called "invoice"
    const g = new Map(); for (const d of kindPages) (g.get(defId(d)) ?? g.set(defId(d), []).get(defId(d))).push(d);
    for (const ds of g.values()) { const mk = ds.filter((x) => DOC_MARK.test(x.text)); const use = mk.length ? mk : ds; if (new Set(use.map((x) => firstDate(x.text))).size > 1) return { ans: null, why: "conflicting-dates" }; }
    const hit = [...g.entries()].filter(([, ds]) => inMY(firstDate(ds[ds.length - 1].text), my));
    if (!hit.length) return { ans: null, why: "agg-no-records" };
    return { ans: String(hit.length), label: "count of " + noun, doc: hit[0][1][0].file, page: hit[0][1][0].page_no, detail: hit.map(([id]) => id).join(", "), sources: hit.map(([, ds]) => src(ds[0])) };
  }
  if (!name) { if (kindPages.some((d) => !sheetPages.includes(d))) return { ans: null, why: "unanchored-doc-aggregate" }; if (!my && !isCount) return null; }
  for (const d of kindPages) {
    if (sheetPages.includes(d)) { for (const u of d.units) if (u.kind === "row" && !u.pdfTable && (!name || nameIn(words(u.text).join(" "), name, corpus))) recs.push({ id: d.file + "#" + u.text.slice(0, 40), unit: u, page: d, date: firstDate(u.text) }); }
  }
  if (name) for (const r of recordPages(corpus, name, kindToks)) if (!sheetPages.includes(r.pages[0])) recs.push({ id: r.id, group: r, page: r.pages[r.pages.length - 1], date: r.date, marked: r.marked });
  if (recs.some((r) => r.group && r.group.conflict)) { const bad = recs.filter((r) => r.group && r.group.conflict); if (!my || bad.some((r) => inMY(r.date, my))) return { ans: null, why: "conflicting-copies" }; }
  let sel = recs; if (my) { if (sel.some((r) => !r.date)) return { ans: null, why: "undated-record" }; sel = sel.filter((r) => inMY(r.date, my)); }
  if (!sel.length) return { ans: null, why: "agg-no-records" };
  // completeness: other pages naming the party that carry ids of the same series as the counted records but are not among them
  if (name) {
    const incIds = new Set((CFG.aggAll ? recs : sel).filter((r) => r.group).map((r) => r.id)); const pre = new Set([...incIds].map((i) => String(i).replace(/\d.*$/, "")).filter((p) => p.length >= 2)); const inc = new Set((CFG.aggAll ? recs : sel).flatMap((r) => (r.group ? r.group.pages : [r.page])));
    for (const d of corpus.docs) {
      if (inc.has(d) || !nameIn(words(d.text).join(" "), name, corpus)) continue;
      const rel = d.units.some((u) => u.kind === "row" && !u.pdfTable) ? d.text.split("\n").filter((l) => nameIn(words(l).join(" "), name, corpus)).join(" ") : d.text;
      for (const i of idKeysOf(rel + " " + (d.units.some((u) => u.kind === "row") ? "" : (d.file ?? "")))) if (pre.has(i.replace(/\d.*$/, "")) && !incIds.has(i)) return { ans: null, why: "agg-incomplete" };
    }
  }
  if (isCount) return { ans: String(sel.length), label: "count of " + noun, doc: sel[0].page.file, page: sel[0].page.page_no, detail: sel.map((r) => r.id).join(", "), sources: sel.map((r) => src(r.page)) };
  // sum: attribute phrase
  const drop = new Set(["what", "is", "the", "of", "all", "every", "each", "across", "combined", "add", "up", "altogether", "in", "total", "overall", "how", "much", "has", "have", "for", "from", "to", "on", "and", "issued", "received", "made", "by", "that", "a", "an"]);
  const nameW = new Set(name ? words(name) : []); const kindW = new Set(words(noun).concat(words(noun).map(stem)));
  const my_w = my ? new Set([...MONTHS.map((m) => m.slice(0, 3)), ...MONTHS.map((m) => m), String(my.yr ?? "")]) : new Set();
  let attr = words(q).filter((w) => !drop.has(w) && !nameW.has(w) && !kindW.has(w) && !kindW.has(stem(w)) && !my_w.has(w) && !/^\d+$/.test(w));
  if (/\btotal\b/i.test(q) && !attr.length) attr = ["total"]; if (/\btotal\b/i.test(q) && /\b(invoice|bill)\s+total\b/i.test(q)) attr = ["total"].concat(attr.filter((w) => w !== "total"));
  if (!attr.length) return { ans: null, why: "agg-no-attribute" };
  const vals = []; let attrNow = attr; const alts = CFG.aggAll ? [attr, ...(/\btotal\b/i.test(q) && attr.length && !attr.includes("total") ? [[...attr, "total"]] : []), ["amount"]] : [attr];
  for (const r of sel) {
    let res;
    const rd = (at) => r.unit ? readSingle(corpus, `What is the ${at.join(" ")} for ${name ?? "the row"}?`, { ...opts, only: new Set([r.page]), onlyUnits: new Set([r.unit]), noOps: true }) : readSingle(corpus, `What is the ${at.join(" ")}?`, { ...opts, only: new Set(r.group.pages), noOps: true });
    res = rd(attrNow);
    if (!vals.length) for (const alt of alts) { if (alt === attrNow && res.ans != null && valueType(res.ans) === "money") break; const r2 = rd(alt); if (r2.ans != null && valueType(r2.ans) === "money") { attrNow = alt; res = r2; break; } }
    if (res.ans == null) return { ans: null, why: "agg-record:" + res.why, alt: res.alt, rec: r.id };
    if (valueType(res.ans) !== "money" || moneyNum(res.ans) == null) return { ans: null, why: "agg-non-money" };
    vals.push({ id: r.id, v: res.ans, c: Math.round(moneyNum(res.ans) * 100), page: r.page });
  }
  if (new Set(vals.map((x) => curOf(x.v).replace(/\s+/g, ""))).size > 1 && !vals.every((x) => /^(\$|usd|)$/i.test(curOf(x.v).trim()))) return { ans: null, why: "agg-mixed-currency" };
  const total = vals.reduce((s, x) => s + x.c, 0);
  return { ans: fmtLike(vals[0].v, total), label: `sum of ${attrNow.join(" ")}`, doc: vals[0].page.file, page: vals[0].page.page_no, detail: vals.map((x) => `${x.id}: ${x.v}`).join("; "), sources: vals.map((x) => src(x.page)) };
}


// pointer: the id of another document referenced by the page/row that carries `id` (e.g. a payment row naming the invoice it was applied to)
function pointer(corpus, id) {
  const anchor = id.toLowerCase().replace(/[^a-z0-9]/g, ""); const defs = new Set(); for (const d of corpus.docs) { const x = defId(d); if (x) defs.add(x); }
  const found = new Map();
  for (const d of corpus.docs) {
    if (!d.idset.has(anchor)) continue; const rows = d.units.filter((u) => u.kind === "row" && !u.pdfTable && idKeysOf(u.text).has(anchor)); const us = rows.length ? rows : d.units.filter((u) => u.kind === "doc");
    for (const u of us) for (const p of u.pairs) { if (p.src === "near") continue; const k = String(p.value).toLowerCase().replace(/[^a-z0-9]/g, ""); if (p.type === "id" && k !== anchor && defs.has(k)) found.set(k, { value: p.value, doc: d.file, page: d.page_no }); }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}
// ---------------- multi-hop ----------------
const PART = "(?:paid|applied|billed|listed|issued|referenced|recorded|named|shown)";
function tryHop(corpus, q, opts) {
  const a = analyze(q, corpus); if (a.ids.length !== 1 || a.idRaw.length !== 1) return null; const id = a.idRaw[0];
  const re = new RegExp(`^(.*?)(?:\\s+(of|for|at|on|from))?\\s+the\\s+([a-z][a-z-]*(?:\\s[a-z][a-z-]*)??)(?:\\s+${PART}(?:\\s+(?:on|in|under|by|to))?)?\\s+(?:on|in|under|from|for|by|of)\\s+(?:the\\s+)?(?:[a-z]+\\s+)?${id.replace(/[-#.]/g, "\\$&")}(?:\\s+(.*?))?\\s*\\?*$`, "i");
  const m = q.match(re);
  if (!m && CFG.ptrHop) { const m2 = q.match(new RegExp(`^(.*?)\\s+on\\s+the\\s+[a-z]+\\s+(?:that|which)\\s+(?:[a-z]+\\s+)?${id.replace(/[-#.]/g, "\\$&")}\\s+was\\s+[a-z]+(?:\\s+(?:to|against|for))?\\s*\\?*$`, "i")); if (m2 && /^(what|who|when|which|how|where|whom)/i.test(m2[1])) { const pv = pointer(corpus, id); if (!pv) return { ans: null, why: "hop-no-pointer" }; const r2 = readSingle(corpus, `${m2[1]} on ${pv.value}?`, { ...opts, noOps: true }); if (r2.ans == null) return { ans: null, why: "hop2:" + r2.why }; return { ...r2, detail: `${id} -> ${pv.value} (${pv.doc} p${pv.page}); then ${m2[1]} on ${pv.value} = ${r2.ans}`, sources: [{ doc: pv.doc, page: pv.page }, { doc: r2.doc, page: r2.page }] }; } }
  if (!m) return null;
  let [, A, prep, role, tail] = m; A = A.trim(); if (!A || !/^(what|who|when|which|how|where|whom|tell|give|find|show)/i.test(A)) return null;
  const FILL = new Set("what who whom when which how much many is are was were the tell me give find show do does did we have of a an our".split(" "));
  if (![...words(A), ...words(tail ?? "")].some((w) => !FILL.has(w))) return null; // "who is the X on ID" is a plain lookup, not a hop
  const roleToks = words(role); if (!roleToks.length || roleToks.every((w) => STOP.has(w))) return null;
  let r1 = null;
  if (CFG.ptrHop && /\b(phone|e-?mail|address|contact|fax)\b/i.test(A)) { const rw = readSingle(corpus, `Who is the ${role} on ${id}?`, { ...opts, noOps: true }); if (rw.ans != null) r1 = rw; }
  if (!r1) r1 = readSingle(corpus, `What is the ${role} on ${id}?`, { ...opts, noOps: true });
  if (r1.ans == null && CFG.ptrHop) { const pv = pointer(corpus, id); if (pv) r1 = { ans: pv.value, doc: pv.doc, page: pv.page }; }
  if (r1.ans == null) return { ans: null, why: "hop1:" + r1.why };
  const v = String(r1.ans).trim(); if (!v || valueType(v) === "money" || valueType(v) === "date") return { ans: null, why: "hop1-type" };
  const q2 = `${A}${prep ? " " + prep : ""} ${v}${tail ? " " + tail : ""}?`;
  const r2 = readSingle(corpus, q2, { ...opts, noOps: true }); if (r2.ans == null) return { ans: null, why: "hop2:" + r2.why };
  if (norm(r2.ans) === norm(v)) return { ans: null, why: "hop-echo" };
  return { ...r2, detail: `${role} on ${id} = ${v} (${r1.doc} p${r1.page}); then ${q2} = ${r2.ans} (${r2.doc} p${r2.page})`, sources: [{ doc: r1.doc, page: r1.page }, { doc: r2.doc, page: r2.page }] };
}


// ---------------- prose parties (valuereader4): "Who presided at the meeting held on <date>?" / "How many members were present at the meeting held on <date>?" ----------------
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function tryProse(corpus, q, opts) {
  const wm = q.match(/^\s*who\s+([a-z]+ed)\b/i), cm = q.match(/^\s*how many\s+([a-z-]+)\s+(?:were|was|are|is)\s+([a-z]+)\b/i); if (!wm && !cm) return null;
  const dates = [...q.matchAll(DATE_RE)].map((m) => parseDate(m[0])).filter(Boolean); if (dates.length !== 1) return null;
  const hits = [];
  for (const d of corpus.docs) for (const ln of d.text.split("\n")) {
    if (!firstDate(ln) && !DATE_RE.test(ln)) { DATE_RE.lastIndex = 0; continue; } DATE_RE.lastIndex = 0;
    const ds = [...ln.matchAll(DATE_RE)].map((m) => parseDate(m[0])); if (!ds.includes(dates[0]) || ds.length !== 1) continue;
    let v = null;
    if (wm) { const m = ln.match(new RegExp("([A-Z][\\w.'-]*(?: [A-Z][\\w.'-]*){0,3})\\s+" + wm[1].toLowerCase() + "\\b")); v = m && m[1]; }
    else { const m = ln.match(new RegExp("\\b(\\d+|" + Object.keys(NUMW).join("|") + ")\\s+" + cm[1].toLowerCase().replace(/s$/, "") + "s?\\s+(?:were|was|are|is)\\s+" + cm[2].toLowerCase() + "\\b", "i")); v = m && (NUMW[m[1].toLowerCase()] ? String(NUMW[m[1].toLowerCase()]) : m[1]); }
    if (v) hits.push({ v, d });
  }
  if (!hits.length) return null; if (new Set(hits.map((h) => h.v)).size !== 1 || new Set(hits.map((h) => h.d)).size !== 1) return { ans: null, why: "prose-ambiguous" };
  return { ans: hits[0].v, label: wm ? wm[1].toLowerCase() : cm[1] + " " + cm[2], score: 0.9, doc: hits[0].d.file, page: hits[0].d.page_no, detail: "prose line on " + dates[0], sources: [src(hits[0].d)] };
}

// question phrasing -> canonical "What is the X on ID?" (polite / imperative / lead-in / "ID: what's X" / it-pt-nl-sv question stems); the label X itself is left alone
const QID = "([A-Za-z]{2,6}-?[0-9][A-Za-z0-9-]*)";
export function normQuestion(q) {
  q = String(q).trim(); let m;
  if ((m = q.match(new RegExp("^(?:i need|i want|i'd like|give me|show me|get me|find me|find)\\s+(?:the\\s+)?(.+?)\\s+(?:from|for|of|on|in)\\s+" + QID + "[.?!]*$", "i")))) return `What is the ${m[1]} on ${m[2]}?`;
  if ((m = q.match(new RegExp("^(?:according to|per|in|from)\\s+" + QID + ",\\s*(what(?:'s| is| was)\\s+.+?)\\??$", "i")))) return `${m[2].replace(/\?$/, "")} on ${m[1]}?`.replace(/^what's/i, "What is");
  if ((m = q.match(new RegExp("^" + QID + ":\\s*what(?:'s| is)\\s+(?:the\\s+)?(.+?)\\??$", "i")))) return `What is the ${m[2]} on ${m[1]}?`;
  if ((m = q.match(new RegExp("^(?:qual (?:è|é|e) (?:il|lo|la|o|a)|wat is (?:het|de)|vad är|¿?cu[aá]l es (?:el|la))\\s+(.+?)\\s+(?:su|sul|sulla|em|na|no|op|på|en|de|di|in)\\s+" + QID + "\\??$", "i")))) return `What is the ${m[1]} on ${m[2]}?`;
  return q;
}
export function paraRewrite(q) {
  q = String(q);
  {
    q = q.replace(/\b(?:the\s+)?(?:amount|total|price|sum)\s+(?:before|excluding|net of|without|prior to)\s+(?:sales\s+)?(?:tax|vat|gst)\b/i, "subtotal").replace(/\bpre-?tax\s+(?:amount|total)\b/i, "subtotal")
      .replace(/\bsales\s+tax(?:\s+amount)?\b/i, "tax").replace(/\btax\s+amount\b/i, "tax")
      .replace(/\b(?:amount|balance|sum)\s+(?:to pay|payable|owed|outstanding|owing|to be paid)\b/i, "amount due").replace(/\b(?:contact|telephone)\s+number\b/i, "phone");
  }
  return q;
}
export function readValue(corpus, question, opts = {}) {
  if (CFG.normQ) question = normQuestion(question);
  const r0 = readValue0(corpus, question, opts); if (r0.ans != null || !CFG.paraQ || opts.noOps) return r0; const q2 = paraRewrite(question); return q2 !== question ? readValue0(corpus, q2, opts) : r0;
}
function readValue0(corpus, question, opts) {
  if (CFG.ops && !opts.noOps) {
    const steps = [[CFG.cmp, tryCompare], [CFG.agg, tryAggregate], [CFG.hop, tryHop], [CFG.sel, trySelect], [CFG.prose, tryProse]];
    for (const [on, fn] of steps) { if (!on) continue; let r = null; try { r = fn(corpus, question, opts); } catch (e) { r = { ans: null, why: "ops-error:" + e.message }; } if (r) return r; }
  }
  return readSingle(corpus, question, { ...opts, noOps: true });
}
