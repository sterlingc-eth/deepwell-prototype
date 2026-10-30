// valuereader5 / vr_ingest.js - reader-side extractors that exploit the better ingest text. All generic (no industry / vendor vocabulary):
//  1 multiPairs     several "label: value" / "label - value" pairs on one line (separated by 3+ spaces, tabs or " | ")
//  2 captionColumns small caption line above a value line, matched by x position (forms, boxes, caption-above-value columns)
//  3 proseFacts     sentence-level facts: "<noun phrase> is/of/at/by <typed value>", times, "N days/months", "technician, Name" role phrases
//  4 foreign        month names / currency spellings of it pt nl sv es de fr, and closed-class admin label words mapped to English (duplicate pair with the English label)
import { valueType, parseDate, norm, words, stem, MONEY_RE, MONEY_RE_BASE, DATE_RE, CFG, FX_DATE_RE } from "./vr_text.js";
const TYPED = new Set(["money", "date", "id", "phone", "email", "percent", "int", "number"]);
const isTyped = (v) => TYPED.has(valueType(v));
const LAB = /^[#\d. ]{0,3}([A-Za-z][A-Za-z0-9 .\/#&()'%]{1,38}?)\.?$/;
// ---------------------------------------------------------------- foreign admin words -> English
export const FX_WORDS = { fattura: "invoice", numero: "number", número: "number", data: "date", scadenza: "due date", vencimiento: "due date", vencimento: "due date", cliente: "customer", codice: "code", código: "code", imponibile: "subtotal", iva: "tax", impostos: "tax", imposto: "tax", totale: "total", pagare: "pay", pagar: "pay", importo: "amount", valor: "amount", descrizione: "description", "descrição": "description", fatura: "invoice", "emissão": "issue", emissione: "issue", emisión: "issue",
  factuur: "invoice", factuurnummer: "invoice number", factuurdatum: "invoice date", vervaldatum: "due date", klant: "customer", klantnummer: "customer number", subtotaal: "subtotal", btw: "tax", totaalbedrag: "total amount", bedrag: "amount", omschrijving: "description", datum: "date", nummer: "number",
  faktura: "invoice", fakturanummer: "invoice number", fakturadatum: "invoice date", "förfallodatum": "due date", kund: "customer", kundnummer: "customer number", delsumma: "subtotal", moms: "tax", belopp: "amount", beskrivning: "description", betala: "pay", att: "",
  fecha: "date", factura: "invoice", total: "total", cuenta: "account", cantidad: "quantity", rechnung: "invoice", kundennummer: "customer number", fällig: "due", betrag: "amount", gesamtbetrag: "total amount", facture: "invoice", échéance: "due date", montant: "amount", client: "customer" };
export function toEnglish(label) { const ws = String(label).toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean); let hit = false; const out = ws.map((w) => { if (FX_WORDS[w] !== undefined) { hit = true; return FX_WORDS[w]; } return w; }).filter(Boolean); return hit ? out.join(" ") : null; }
// ---------------------------------------------------------------- 1 several pairs on a line
const SEGSPLIT = /\s{3,}|\t+|\s\|\s/;
const PAIR = /^([A-Za-z#][A-Za-z0-9 .\/#&()'%]{0,40}?)\s*(?::\s*|\s[-–—]\s+)(\S.*)$/;
const COLONS = /(?:^|\s)([A-Z][A-Za-z#.\/']*(?: [A-Za-z#.\/']+){0,3}):\s+(?=\S)/g;
function colonPairs(line, mk, out) {   // "Subtotal: $279.00 Tax: $0.00 Freight: $35.00" (single-space separated; every value but the last must be typed)
  const ms = [...line.matchAll(COLONS)]; if (ms.length < 2) return false; const got = [];
  for (let i = 0; i < ms.length; i++) { const st = ms[i].index + ms[i][0].length, en = i + 1 < ms.length ? ms[i + 1].index : line.length; const v = line.slice(st, en).trim(), lab = ms[i][1].trim(); if (!v || v.length > 40) return false; if (i + 1 < ms.length && !isTyped(v)) return false; got.push([lab, v]); }
  let n = 0; for (const [l, v] of got) { const p = mk(l, v, "kv2", line); if (p) { out.push(p); n++; } } return n > 0;
}
export function multiPairs(line, mk, out) {
  if (!SEGSPLIT.test(line.trim()) && colonPairs(line, mk, out)) return true;
  const segs = line.trim().split(SEGSPLIT).map((s) => s.trim()).filter(Boolean); if (segs.length < 2) return false; let n = 0; const got = [];
  for (const seg of segs) { const m = seg.match(PAIR); if (!m) continue; const lab = m[1].trim(); if (lab.split(/\s+/).length > 6 || /^\d+$/.test(lab) || isTyped(lab)) continue; let v = m[2].trim(); if (/:\s/.test(v) && !/^\d{1,2}:\d{2}/.test(v)) continue; if (v.length > 70) continue; got.push([lab, v]); }
  if (got.length < 2) return false; for (const [l, v] of got) { const p = mk(l, v, "kv2", line); if (p) { out.push(p); n++; } } return n > 0;
}
// ---------------------------------------------------------------- 2 caption above value
const chunks = (l) => { const o = []; const re = /\S+(?: {1,2}\S+)*/g; let m; while ((m = re.exec(l))) o.push({ x: m.index, e: m.index + m[0].length, t: m[0] }); return o; };
const capLike = (t) => { const m = t.match(LAB); return !!m && t.split(/\s+/).length <= 5 && !isTyped(t) && !/[.!?]$/.test(t.replace(/\.$/, "")) && !new RegExp(FX_DATE_RE.source, "i").test(t) && !/\d{3,}/.test(t); };
export function captionColumns(lines0, mk, out) {
  const lines = CFG.capBlank ? lines0.filter((l) => l.trim()) : lines0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/\t/.test(lines[i]) || /\t/.test(lines[i + 1])) continue;   // tab-separated key/value listings are label->value rows, not caption/value rows
    const cap = chunks(lines[i]), val = chunks(lines[i + 1]); if (!cap.length || !val.length || !cap.every((c) => capLike(c.t))) continue;
    if (cap.length === 1 && /:$/.test(cap[0].t)) continue;
    if (cap.some((c) => /^[A-Z][a-z]+( [A-Z][a-z]+){2,}$/.test(c.t))) continue;   // 3+ capitalised words = a proper name, i.e. this line is a value
    if (cap.length >= 3) { let tab = false; for (let j = i + 2, seen = 0; j < lines.length && seen < 4 && !tab; j++) { if (!lines[j].trim()) continue; seen++; const nx = chunks(lines[j]); if (nx.length >= 2 && nx.every((n) => capLike(n.t))) break; const al = val.filter((v) => nx.some((n) => Math.abs(n.x - v.x) <= 3 || Math.abs(n.e - v.e) <= 3)).length; if (al >= 3 && al >= val.length - 1 && !nx.every((n) => capLike(n.t))) tab = true; } if (tab) continue; }   // header + rows of a column table, not caption/value
    const pairs = []; let ok = true;
    for (const v of val) { const near = cap.filter((c) => Math.abs(c.x - v.x) <= 4 || (Math.abs(c.e - v.e) <= 3 && v.e - v.x > 3) || (c.x <= v.x && v.x < c.e && v.x - c.x <= 8)); if (near.length !== 1) { ok = false; break; } pairs.push([near[0], v]); }
    if (!ok || !pairs.length) continue;
    const typedN = pairs.filter(([, v]) => isTyped(v.t) || /^[A-Z][A-Za-z.'-]+( [A-Za-z.'-]+){0,3}$/.test(v.t) || /\d/.test(v.t)).length; if (typedN < Math.ceil(pairs.length / 2)) continue;
    if (val.every((v) => capLike(v.t) && !/[A-Z][a-z]+ [A-Z][a-z]+/.test(v.t)) && val.every((v) => /^[A-Z #\/&.'()-]+$/.test(v.t))) continue;   // a second caption row, not values
    for (const [c, v] of pairs) { const lab = c.t.replace(/^[#\d. ]{1,3}(?=[A-Za-z])/, "").replace(/[.:]+$/, ""); const p = mk(lab, v.t, "cap", lines[i] + " / " + lines[i + 1]); if (p) out.push(p); }
    i++;
  }
}
// ---------------------------------------------------------------- 3 sentence facts
const ROLE = /\b(technician|inspector|driver|manager|contact|representative|rep|salesperson|engineer|nurse|agent|supervisor|approver|approved by|signed by|prepared by|assigned to|requested by|received by)\b[,:]?\s+((?:Dr\.|Mr\.|Ms\.|Mrs\.)?\s?[A-Z][a-z]+(?: [A-Z][a-z]+){1,2})\b/g;
const UNIT = /\b(\d{1,3})\s+(days?|months?|weeks?|hours?|years?)\b/gi;
const TIME = /\b(\d{1,2}:\d{2}(?:\s?[AaPp][Mm])?)\b/g;
export function proseFacts(text, mk, out) {
  const sents = text.split(/(?<=[.!?])\s+(?=[A-Z(])|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 5);
  for (const s of sents) {
    if (/^(from|sent|to|cc|bcc|date|received|printed|faxed|scanned|reply-to)\s*:/i.test(s)) continue;   // mail/fax header lines are not facts about the subject
    let m; ROLE.lastIndex = 0; while ((m = ROLE.exec(s))) { const p = mk(m[1], m[2], "prose", s); if (p) out.push(p); }
    UNIT.lastIndex = 0; while ((m = UNIT.exec(s))) { const pre = s.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-6).filter((w) => !/^(for|of|in|within|the|a|an|is|and|to|at|be|will|remains|good)$/i.test(w)); const unit = m[2].toLowerCase().replace(/s$/, ""); const lab = [...pre.slice(-2), unit + "s"].join(" "); const p = mk(lab, m[1], "prose", s); if (p) out.push(p); const p2 = mk(pre.slice(-3).join(" ") + " in " + unit + "s", m[1], "prose", s); if (p2) out.push(p2); }
    TIME.lastIndex = 0; while ((m = TIME.exec(s))) { const pre = s.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-6).filter((w) => !/^(at|by|around|from|on|the|a|an|is|and|to|be|will|between|arriving)$/i.test(w)); const p = mk(pre.slice(-3).join(" ") + " time", m[1], "prose", s); if (p) out.push(p); }
  }
}
// clause-level facts: every typed value in a sentence gets labels built from the content words of its own clause ("late fee of $35" -> late fee; "call on <date>" -> call date; "visit on <date> at 15:00" -> visit date / visit time; "requested by <date>" -> payment deadline, due date; "valid for 30 days" -> validity in days)
const FN = new Set("the a an of for on at by to is are was were be been will would that your our my you we i this these those which with in and it its as from has have had remains remain applies apply after before following confirm confirming writing am can may shall also then than so if but or not no per each any all more less new dear regards sincerely please note noted attached enclosed regarding re about over under into onto up out off per via".split(" "));
const VAL = new RegExp(`(${MONEY_RE_BASE.source})|(${DATE_RE.source})|(\\b\\d{1,2}:\\d{2}(?:\\s?[AaPp][Mm])?\\b)|(\\b\\d{1,3}\\s+(?:days?|months?|weeks?|hours?|years?)\\b)`, "gi");
export function clauseFacts(text, mk, out) {
  const sents = text.split(/(?<=[.!?])\s+(?=[A-Z(])|\n{2,}/).filter((x) => !/\t|\s{3,}|:\s/.test(x.trim().replace(/\n(?=\S)/g, " "))).map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.split(/\s+/).length >= 8); let moneyHead = null; const tmp = [];
  for (const s of sents) {
    if (/^(from|sent|to|cc|bcc|date|received|printed|faxed|scanned|subject)\s*:/i.test(s)) continue;
    const vals = []; VAL.lastIndex = 0; let m; while ((m = VAL.exec(s))) vals.push({ i: m.index, e: m.index + m[0].length, t: m[0], k: m[1] ? "money" : m[2] ? "date" : m[3] ? "time" : "unit" });
    if (!vals.length) continue; let prevEnd = 0, headPrev = null;
    for (const v of vals) {
      let pre = s.slice(prevEnd, v.i); const cut = Math.max(pre.lastIndexOf(";"), pre.lastIndexOf(" and "), pre.lastIndexOf(":")); if (cut >= 0) pre = pre.slice(cut + 1);
      const ws = pre.split(/[\s,]+/).filter(Boolean); const C = []; ws.forEach((w, j) => { const wl = w.replace(/[^A-Za-z-]/g, ""); if (!wl || FN.has(wl.toLowerCase()) || /^(date|time|amount|number|total|day|days)$/i.test(wl)) return; if (/^[A-Z]/.test(wl) && (prevEnd > 0 || j > 0)) return; if (wl.length < 3) return; C.push(wl.toLowerCase()); });
      const last = C.slice(-3), labs = new Set(); const by = /\b(by|before|until|due)\s*$/i.test(pre.trim()) || /\bdue\b/i.test(pre);
      const add = (l) => { if (l) labs.add(l.trim()); };
      if (v.k === "money") { for (let n = 1; n <= last.length; n++) add(last.slice(-n).join(" ")); if (C.length) add(C[0]); if (C.length > 1) add(C[0] + " " + C[C.length - 1]); if (C.length) moneyHead = C[0]; }
      else if (v.k === "date") { const h = C.length ? C : (headPrev ?? []); const mod = h.find((w) => /^(next|last|previous|prior|new|old|first|second|third|final|earlier|later|follow-up|followup|original|revised)$/.test(w)); for (const w of h.slice(-2)) { if (mod && w !== mod) { add(mod + " " + w + " date"); add(mod + " date"); continue; } add(w + " date"); add("date of the " + w); add("date of " + w); } if (by) { add("due date"); add("deadline"); for (const w of h.slice(0, 1)) { add(w + " deadline"); add(w + " due date"); } } headPrev = h; }
      else if (v.k === "time") { const h = C.length ? C : (headPrev ?? []); for (const w of h.slice(-2)) add(w + " time"); add("time"); }
      else { const un = v.t.match(/[a-z]+$/i)[0].toLowerCase().replace(/s$/, "") + "s"; add(un); add("validity in " + un); add("valid " + un); if (moneyHead) { add(moneyHead + " validity in " + un); add(moneyHead + " validity"); add(moneyHead + " valid " + un); } for (const w of last) add(w + " " + un); }
      const val = v.k === "unit" ? v.t.match(/\d+/)[0] : v.t;
      for (const l of labs) { if (v.k === "money" && /\b(date|time)\b/.test(l)) continue; const p = mk(l, val, "prose", s); if (p) { p.cl = true; tmp.push(p); } }
      prevEnd = v.e;
    }
  }
  const by = new Map(); for (const p of tmp) { const k = p.lab.join(" "); (by.get(k) ?? by.set(k, new Set()).get(k)).add(p.value); }
  for (const p of tmp) if (by.get(p.lab.join(" ")).size === 1) out.push(p);   // a label that names two different values in one text is not a fact
}
// ---------------------------------------------------------------- 4 foreign values and labels
export function foreignPairs(pairs, mk, out) {
  for (const p of pairs) { const en = toEnglish(p.label); if (en && en !== norm(p.label)) { const q = mk(en, p.value, p.src + "-en", p.line); if (q) out.push(q); } }
}
export function ingestPairs(rest, docPairs, mk, text) {
  const before = docPairs.length;
  if (CFG.ingMulti) for (const L of rest) { const n0 = docPairs.length; if (multiPairs(L, mk, docPairs)) { const Lt = L.trim(); for (let i = n0 - 1; i >= 0; i--) { const q = docPairs[i]; if ((q.src === "kv" || q.src === "near") && q.line && (q.line.trim() === Lt || (q.line.length > 12 && Lt.includes(q.line.trim())))) docPairs.splice(i, 1); } } }
  if (CFG.ingCap) captionColumns(rest, mk, docPairs);
  if (CFG.ingProse) proseFacts(text, mk, docPairs);
  if (CFG.ingClause) clauseFacts(text, mk, docPairs);
  if (CFG.fx) foreignPairs(docPairs.slice(0), mk, docPairs);
  return docPairs.length - before;
}
