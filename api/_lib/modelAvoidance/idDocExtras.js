/**
 * Real-docs round: layouts of licence / certificate / new-hire forms that the one-label-one-value scan (idDocFields.js) cannot pair.
 *
 *   1. ROWS: a row of several labels ("Medical Examiner's Telephone Number   Date Certificate Signed", "Driver's License Number
 *      Issuing State/Province") with the row of values under it or the pairs "Label: value  Label: value" on one line - also when the
 *      OCR printed the cells with single spaces. A signature cell is allowed to be empty.
 *   2. NAME PARTS: "Last Name: X  First Name: Y" on one line or on separate lines, and the numbered card lines "1 SAMPLE / 2 JORDAN Q".
 *   3. CHECKBOXES: a list of conditions ("Wearing corrective lenses") is read ONLY where the text itself says the box is checked
 *      ("checked", "[x]", a tick). A glyph a scanner makes of a circle or a box is not evidence of either state.
 *   4. CARD HEADER: the state named in the title of a driver licence card ("Virginia  COMMERCIAL DRIVER'S LICENSE").
 *   5. The state printed under "Issuing State" belongs to the examiner or to the driver by the label that stands before it.
 *
 * Pure. Every entry carries the line(s) it came from as `verbatim`.
 */
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const US = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AB BC MB NB NL NS ON PE QC SK".split(" ");
const STATE_CODES = new Set(US);
const STATE_NAMES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
const stateVal = (v) => {
  const s = collapse(v).replace(/[.,;|]+$/, "");
  if (/^[A-Z]{2}$/.test(s) && STATE_CODES.has(s)) return s;
  const hit = STATE_NAMES.find((n) => n.toLowerCase() === s.toLowerCase());
  return hit ? s : null;
};

/* ----------------------------------------------------------------------------------------------- 1. rows */
// id, pattern, key(s) it yields, skippable when its cell is empty (a signature)
const ROW_LABELS = [
  { id: "exlic", re: "medical\\s+examiner'?s?\\s+(?:state\\s+)?licen[cs]e,?\\s*(?:certificate,?\\s*)?(?:or\\s+)?(?:registration\\s+)?(?:no\\.?|number)", kind: "number" },
  { id: "natreg", re: "national\\s+registry\\s+(?:no\\.?|number|#)", kind: "number" },
  { id: "exphone", re: "medical\\s+examiner'?s?\\s+tele?phone(?:\\s+(?:no\\.?|number))?", kind: "phone" },
  { id: "exsig", re: "medical\\s+examiner'?s?\\s+signature", kind: "sig" },
  { id: "signed", re: "date\\s+(?:certificate\\s+)?signed|signature\\s+date", kind: "date" },
  { id: "drsig", re: "(?:driver|holder|employee|applicant)'?s?\\s+signature", kind: "sig" },
  { id: "dlno", re: "driver'?s?\\s+licen[cs]e\\s+(?:no\\.?|number)", kind: "number" },
  { id: "state", re: "issuing\\s+state(?:\\s*\\/\\s*province)?|state\\s+of\\s+issu(?:e|ance)", kind: "state" },
];
const ROW_RE = new RegExp(ROW_LABELS.map((l) => `(?<${l.id}>${l.re})`).join("|"), "gi");
const PHONE_SHAPE = /^(?:\(\d{3}\)\s?\d{3}[-.]\d{4}|\d{3}[-.]\d{3}[-.]\d{4}|1[-.]\d{3}[-.]\d{3}[-.]\d{4})$/;
const phoneStrict = (v) => { const x = collapse(v).replace(/[;,|]+$/, ""); return PHONE_SHAPE.test(x) ? x : null; };
const registryVal = (v) => { const x = collapse(v).replace(/[;,|]+$/, ""); return /^\d{10}$/.test(x) ? x : null; };
const exlicVal = (numberVal, rowHasRegistry) => (v) => { const x = numberVal(v); if (!x) return null; if (PHONE_SHAPE.test(x) || /^\d{10}$/.test(x.replace(/\s/g, "")) && rowHasRegistry) return null; if (/^\d{10,}$/.test(x)) return null; return x; };
const wholeDate = (dateOf) => (v) => { const x = collapse(v).replace(/[;,|.]+$/, ""); return /^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})$/.test(x) ? dateOf(x) : null; };
const GLYPH_JUNK = /^[^A-Za-z0-9]{0,3}$|^[A-Za-z]{1,2}$/;

/** Labels of a row line, in order, with their span; null unless the line is (almost) nothing but labels. */
function rowLabelsOf(text, minLabels = 1) {
  const found = [];
  let rest = "";
  let last = 0;
  for (const m of text.matchAll(ROW_RE)) {
    const id = Object.keys(m.groups).find((k) => m.groups[k] != null);
    rest += ` ${text.slice(last, m.index)} `;
    found.push({ id, start: m.index, end: m.index + m[0].length, def: ROW_LABELS.find((l) => l.id === id) });
    last = m.index + m[0].length;
  }
  if (found.length < minLabels) return null;
  return { found, between: rest, tail: text.slice(last) };
}

function tokensForRow(line, n) {
  const cells = String(line).split(/\s{3,}|\t+|\s\|\s/).map(collapse).filter(Boolean);
  if (cells.length === n) return cells;
  return collapse(line).split(" ").filter(Boolean);
}

export function scanRows(lines, type, { numberVal, phoneVal, dateOf }) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const L = rowLabelsOf(lines[i].t, 2);
    if (!L) continue;
    // nothing but glyph junk may stand between the labels
    const junk = collapse(L.between).split(" ").filter(Boolean);
    if (junk.some((w) => !GLYPH_JUNK.test(w))) continue;
    const labels = L.found;
    const hasEx = labels.some((l) => l.id === "exlic" || l.id === "natreg" || l.id === "exphone");
    const hasDr = L.found.some((l) => l.id === "dlno");
    const stateKey = hasEx ? "examiner_license_state" : "license_state";
    const stateAmbiguous = hasEx && hasDr;
    const keysOf = (id) => ({ exlic: ["examiner_license_number"], natreg: ["national_registry_number"], exphone: ["examiner_phone"], signed: ["signed_date"], dlno: ["license_number"], state: stateAmbiguous ? [] : [stateKey] }[id] ?? []);
    const check = (id, v) => {
      const def = ROW_LABELS.find((l) => l.id === id);
      if (id === "natreg") return registryVal(v);
      if (id === "exlic") return exlicVal(numberVal, labels.some((x) => x.id === "natreg"))(v);
      if (def.kind === "number") return numberVal(v);
      if (def.kind === "phone") return phoneStrict(v);
      if (def.kind === "state") return stateVal(v);
      if (def.kind === "date") return wholeDate(dateOf)(v);
      return null;
    };
    const emit = (l, v, verbatim, page) => {
      const val = check(l.id, v);
      if (!val) return;
      for (const key of keysOf(l.id)) out.push({ key, prio: 1, value: val, page_no: page, verbatim: collapse(verbatim).slice(0, 400), label: l.def.id, strength: "explicit" });
    };
    // (a) "Label: value  Label: value" on one line
    const segs = labels.map((l, k) => ({ l, seg: collapse((L.found[k + 1] ? lines[i].t.slice(l.end, L.found[k + 1].start) : lines[i].t.slice(l.end)).replace(/^\s*[:#=]\s*/, "")) }));
    if (segs.every((x) => x.seg) && lines[i].t.slice(labels[0].end).match(/^\s*[:#=]/)) { segs.forEach((x) => { if (x.l.def.kind !== "sig") emit(x.l, x.seg, lines[i].t, lines[i].page); }); continue; }
    if (L.tail && collapse(L.tail).replace(/^[:#=\s]+/, "") && !/^[\s\W]*$/.test(L.tail)) { if (!lines[i + 1]) continue; }
    // (b) the row of values beneath
    const nxt = lines[i + 1];
    if (!nxt || rowLabelsOf(nxt.t, 1)) continue;
    // exactly one token per label, in order: when the count differs a cell is empty or merged and no value may be taken from a neighbour
    const toks = tokensForRow(nxt.t, labels.length);
    if (toks.length !== labels.length) continue;
    labels.forEach((l, k) => { if (l.def.kind !== "sig") emit(l, toks[k], `${lines[i].t} ${nxt.t}`, nxt.page); });
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------- 5. state under a lone "Issuing State" label */
const cellsOf2 = (t) => String(t).split(/\s{3,}|\t+|\s\|\s/).map(collapse).filter(Boolean).length;
const STATE_LABEL = /^(?:(?:driver'?s?\s+licen[cs]e\s+|licen[cs]e\s+)?issuing\s+state(?:\s*\/\s*province)?|state\s+of\s+issu(?:e|ance))\s*(?:[:#=-]\s*|\s+)?(.*)$/i;
export function scanStateLines(lines, type) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = STATE_LABEL.exec(lines[i].t);
    if (!m || rowLabelsOf(lines[i].t, 2)) continue;
    let raw = collapse(m[1]);
    let verbatim = lines[i].t; let page = lines[i].page;
    if (!raw && lines[i + 1] && !rowLabelsOf(lines[i + 1].t, 1)) { raw = collapse(lines[i + 1].t); verbatim = `${lines[i].t} ${lines[i + 1].t}`; page = lines[i + 1].page; }
    const v = stateVal(raw);
    if (!v) continue;
    if (!m[1] && lines[i + 1] && cellsOf2(lines[i + 1].t) !== 1) continue;
    // which state: "/Province" or an explicit licence wording is the driver's; a bare "Issuing State" is the examiner's only when the lines right above are the examiner's and none is the driver's
    const lab = lines[i].t;
    let key = null;
    if (/province|licen[cs]e|driver/i.test(lab)) key = "license_state";
    else {
      const above = lines.slice(Math.max(0, i - 2), i).map((x) => x.t).join("\n");
      const ex = /medical\s+examiner|registration\s+(?:no|number)|national\s+registry/i.test(above); const dr = /driver'?s?\s+licen[cs]e|driver'?s?\s+signature/i.test(above);
      if (ex && !dr) key = "examiner_license_state"; else if (dr && !ex) key = "license_state";
    }
    if (!key) continue;
    out.push({ key, prio: 1, value: v, page_no: page, verbatim: collapse(verbatim).slice(0, 400), label: "issuing-state", strength: "explicit" });
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------- 2. name parts */
const PART_RE = /\b(last\s*name|family\s*name|surname|first\s*name|given\s*name|middle\s*(?:name|initial)|m\.i\.|LN|FN)\s*(?:\([^)]*\))?\s*[:#=]?/gi;
const NAME_WORD = "(?:[A-Z][A-Za-z'’-]*\\.?|[IVX]{1,4}\\b)";
const LEAD_NAME = new RegExp(`^(${NAME_WORD}(?:\\s+${NAME_WORD}){0,3})`);
const partKind = (s) => (/^(?:last|family|sur|ln$)/i.test(s) ? "last" : /^(?:first|given|fn$)/i.test(s) ? "first" : "mid");
const leadName = (seg) => {
  const t = collapse(seg).replace(/^[:#=\s]+/, "");
  const m = LEAD_NAME.exec(t); if (!m) return "";
  const rest = t.slice(m[0].length).trim();
  if (rest && /^[A-Z]/.test(rest)) return ""; // a capitalised word right after the name: more name, or the next label: not a clean cell
  return m[1].replace(/\.$/, "");
};
const titleCase = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, (x) => x.toUpperCase()));

/** @returns {{value:string, page_no:number, verbatim:string}|null} the holder's full name from first / last parts, when exactly one reading exists */
export function scanNameParts(lines, nameVal) {
  const parts = []; // {kind, value, i}
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].t;
    const ms = [...t.matchAll(PART_RE)];
    ms.forEach((m, k) => {
      const end = m.index + m[0].length;
      const seg = t.slice(end, ms[k + 1] ? ms[k + 1].index : undefined);
      let v = leadName(seg);
      let line = i;
      // label alone (or last on its line) with its value on the next line
      if (!v && k === ms.length - 1 && !collapse(seg) && lines[i + 1] && !new RegExp(PART_RE.source, "i").test(lines[i + 1].t)) { v = leadName(lines[i + 1].t.split(/\s{3,}/)[0]); line = i + 1; }
      // a part whose cell holds a redaction-like gap (bar glyphs, "|" runs, blocks) is no clean cell
      if (v && /[|█▇■□_\[\]]/.test(seg.slice(0, Math.max(0, seg.indexOf(v))))) v = "";
      // a surname (or any part) of two letters or fewer in its own cell is far more often the remnant of a redaction bar than a name: it needs a second print elsewhere
      if (v && v.replace(/[^A-Za-z]/g, "").length <= 2) { const re = new RegExp(`(?:^|[^A-Za-z])${v.replace(/[^A-Za-z]/g, "")}(?![A-Za-z])`, "gi"); const n = lines.reduce((c, ln) => c + ((ln.t.replace(/\b(?:last|first)\s*name\b/gi, " ").match(re) ?? []).length), 0); if (n < 2) v = ""; }
      if (v && !/redact/i.test(v)) parts.push({ kind: partKind(m[1]), value: v, i, line });
    });
    // numbered card lines: "1 SAMPLE" then "2 JORDAN Q"
    const c1 = /^1\s+([A-Z][A-Za-z'’ -]{1,30})$/.exec(t);
    const c2 = lines[i + 1] && /^2\s+([A-Z][A-Za-z'’. -]{1,30})$/.exec(lines[i + 1].t);
    if (c1 && c2) { parts.push({ kind: "last", value: collapse(c1[1]), i, line: i }, { kind: "first", value: collapse(c2[1]), i, line: i + 1 }); }
    // "1,2 Name" (or "1/2 Name:") with the surname on the next line and the given names under it
    const cm = /^(?:1\s*[,/]\s*2\s+)(?:name\s*[:#]?\s*)?(.*)$/i.exec(t);
    if (cm) {
      const rest = collapse(cm[1]);
      const a = rest ? rest : collapse(lines[i + 1]?.t ?? "");
      const b = rest ? collapse(lines[i + 1]?.t ?? "") : collapse(lines[i + 2]?.t ?? "");
      const sur = leadName(a); const giv = leadName(b);
      if (sur && giv && !/:/.test(a + b) && !/^\d/.test(b)) parts.push({ kind: "last", value: sur, i, line: rest ? i : i + 1 }, { kind: "first", value: giv, i, line: rest ? i + 1 : i + 2 });
    }
  }
  const firsts = parts.filter((p) => p.kind === "first"); const lasts = parts.filter((p) => p.kind === "last");
  if (!firsts.length || !lasts.length) return null;
  const readings = new Set(); const found = [];
  for (const f of firsts) for (const l of lasts) {
    if (Math.abs(f.i - l.i) > 3) continue;
    const mid = parts.find((p) => p.kind === "mid" && Math.abs(p.i - f.i) <= 3);
    const full = [f.value, mid && /^[A-Za-z]$/.test(mid.value) ? mid.value : "", l.value].filter(Boolean).join(" ");
    const name = nameVal(titleCase(full));
    if (!name) continue;
    const key = name.toLowerCase();
    if (!readings.has(key)) { readings.add(key); found.push({ name, f, l }); }
  }
  if (found.length !== 1) return null;
  const { name, f, l } = found[0];
  const idx = [...new Set([f.line, l.line])].sort((a, b) => a - b);
  return { value: name, page_no: lines[idx[idx.length - 1]].page, verbatim: collapse(idx.map((k) => lines[k].t).join(" … ")).slice(0, 400) };
}

/* ----------------------------------------------------------------------------------------------- 3. checked conditions */
const OPTION_RES = [
  /wearing\s+corrective\s+lenses/i, /wearing\s+hearing\s+aid/i, /accompanied\s+by\s+a\s+waiver\s*\/?\s*exemption/i,
  /accompanied\s+by\s+a\s+skill\s+performance\s+evaluation(?:\s*\(SPE\))?(?:\s+certificate)?/i, /driving\s+within\s+an?\s+exempt\s+intracity\s+zone/i,
  /grandfathered\s+from\s+state\s+requirements/i,
];
const OPTION_ALL = new RegExp(OPTION_RES.map((r) => `(?:${r.source})`).join("|"), "gi");
const BOX_ON = /(?:\[\s*[xX✓✔]\s*\]|\(\s*[xX✓✔]\s*\)|[☒☑✓✔✅])\s?$/;
const BOX_ANY = /(?:\[\s*[xX✓✔]?\s*\]|\(\s*[xX✓✔]?\s*\)|[☐☒☑✓✔✅□■])\s?$/;
/** An option counts as ticked only with an unambiguous mark placed directly on it: a box glyph right BEFORE it (every option of the line has its own box), or "Option: checked" alone in its cell. Anything else is left empty. */
export function scanChecked(lines) {
  const hits = []; const quotes = [];
  for (const ln of lines) {
    const t = ln.t;
    const ms = [...t.matchAll(OPTION_ALL)];
    if (!ms.length) continue;
    const verdicts = [];
    let ok = true;
    ms.forEach((m, k) => {
      const segStart = ms[k - 1] ? ms[k - 1].index + ms[k - 1][0].length : 0;
      const before = t.slice(segStart, m.index);
      const segEnd = ms[k + 1] ? ms[k + 1].index : t.length;
      // the box that belongs to the NEXT option stands at the end of this option's tail
      const after = t.slice(m.index + m[0].length, segEnd).replace(/(?:\[\s*[xX✓✔]?\s*\]|\(\s*[xX✓✔]?\s*\)|[☐☒☑✓✔✅□■])\s*$/, "");
      const aw = /^\s*:\s*(checked|unchecked)\s*$/i.exec(after);
      if (aw && !before.trim()) { verdicts.push(/^checked$/i.test(aw[1])); return; }
      if (BOX_ANY.test(before) && !after.trim()) { verdicts.push(BOX_ON.test(before)); return; }
      ok = false;
    });
    if (!ok) continue;
    ms.forEach((m, k) => { if (verdicts[k]) { hits.push({ text: collapse(m[0]), page: ln.page }); if (!quotes.includes(t)) quotes.push(t); } });
  }
  if (!hits.length) return null;
  const seen = new Set(); const vals = [];
  for (const h of hits) { const id = h.text.toLowerCase(); if (!seen.has(id)) { seen.add(id); vals.push(h.text); } }
  return { value: vals.join("; "), page_no: hits[0].page, verbatim: collapse(quotes.join(" … ")).slice(0, 400) };
}

export { stateVal, STATE_CODES };
