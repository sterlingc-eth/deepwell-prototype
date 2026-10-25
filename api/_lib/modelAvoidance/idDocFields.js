/**
 * ID-document round: fields of person-owned papers (driver licence / CDL, DOT medical examiner's certificate, HR new-hire sheet).
 *
 * THE DEFECT: the labelled scan only read an inline "Label: value" and only the licence-number / start / end keys. Government
 * forms print the label ABOVE its value, with long prefixed labels ("Medical Examiner's Certificate Expiration Date"), and
 * nothing read a holder, a class, an examiner, or the HR sheet's employee / position / pay / manager.
 *
 * This reader handles, for the two person-owned types only:
 *   - "Label: value", "Label value" (no colon), "4b EXP 01/01/2030" (card field numbers);
 *   - a label alone on a line with its value on the next line;
 *   - a row of labels with the row of values under it (same number of cells);
 *   - long labels with up to a few words in front of the date word.
 * Every candidate carries the line(s) it came from as `verbatim`, so the grounding check (groundedFacts.js) still applies.
 * Precision first: a value must validate for its key; two different values for one key are left to a person (the caller
 * reports them as ambiguous). A redacted / blank value is "absent": no candidate is produced.
 *
 * Pure. No I/O, no clock.
 */
import { normalizeDate } from "../extractFields.js";
import { readPeopleForm } from "./peopleForms.js";
import { nameShape, titleLinesOf, formControlMask, hasNameEvidence } from "./peopleShape.js";

export const ID_DOC_TYPES = new Set(["license-certification", "hr-letter", "insurance-certificate"]);
/** Keys this reader may supply, by document type. */
export const ID_KEYS_BY_TYPE = {
  "license-certification": ["license_number", "holder_name", "license_class", "start_date", "end_date", "issued_by", "vendor"],
  "hr-letter": ["employee_name", "start_date", "position", "pay_rate", "manager", "vendor", "employee_phone", "employee_email", "signed_date"], // an employee is never a customer: no customer_* / service_* keys (peopleShape.dropPeopleIdFacts)
  "insurance-certificate": ["policy_number", "holder_name", "start_date", "end_date", "vendor"],
};
/** The people-form kinds (peopleForms.js) that belong to each document type. */
const KIND_TYPE = { mec: "license-certification", cpr: "license-certification", forklift: "license-certification", vehreg: "license-certification", i9: "hr-letter", a4: "hr-letter", w4: "hr-letter", dd: "hr-letter", bg: "hr-letter", newhire: "hr-letter", volunteer: "hr-letter", insurance: "insurance-certificate" };

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const WORD = "[a-z'’.]+";
const PLACEHOLDER = /^(?:n\/?a|none|tbd|unknown|redacted|x{3,}|\*{3,}|[-_.#█▇■□\s]+|\[?redacted\]?|signature|see\s+(?:above|below))$/i;

/* ----------------------------------------------------------------- value validators (return a value or null) */
/** A person's name by SHAPE (peopleShape.nameShape): token count, case pattern, no function / instruction words, not a place, address, organisation or title fragment. */
const nameVal = (v, { kind = "person", titleLines = [], maxCore = 4, fullText = null, onLabel = false } = {}) => {
  const r = nameShape(v, { kind, titleLines, maxCore });
  if (!r.ok) return null;
  // round 5: a name is believed only with positive evidence (a real given name, or printed twice); an examiner's credential / title also counts
  if (fullText != null && !hasNameEvidence(r.value, fullText, { onLabel: onLabel && kind === "person" }) && !(kind === "examiner" && /,\s*[A-Za-z.-]{2,6}$|^(?:Dr|Prof)\.?\s/.test(r.value))) return null;
  return r.value;
};
const numberVal = (v) => {
  const s = collapse(v).replace(/[,;|]+$/, "");
  if (!s || PLACEHOLDER.test(s) || /redact/i.test(s) || !/^[A-Za-z0-9][A-Za-z0-9 -]{3,23}$/.test(s) || !/\d/.test(s)) return null;
  if (/^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})$/.test(s)) return null;
  const solid = s.replace(/[\s-]/g, "");
  if (solid.length < 5 || (solid.match(/\d/g) ?? []).length < 3) return null; // OCR noise ("aa a 9 9") is not a number
  if (/\s/.test(s) && !/^\d+(?:\s\d+)+$/.test(s)) return null; // spaced groups must be all digits (OCR fragments like "AAA A123" are not a number)
  if (/^(.)\1+$/.test(solid)) return null; // 0000000 / XXXXXXX
  return s;
};
const classVal = (v) => { const m = /^(?:class\s+)?([A-D])(?![A-Za-z])/i.exec(collapse(v)); return m ? m[1].toUpperCase() : null; };
const issuerVal = (v) => {
  const s = collapse(v).replace(/[,;|]+$/, "");
  if (!s || PLACEHOLDER.test(s) || /\d/.test(s) || !/^[A-Za-z][A-Za-z .,'’&-]{1,60}$/.test(s) || s.length < 4) return null;
  if (/\b(?:signature|date|address|phone|number)\b/i.test(s) || !/[A-Za-z]{4,}/.test(s)) return null;
  return s;
};
const payVal = (v) => {
  const s = collapse(v).replace(/[,;|]+$/, "");
  return /^\$?\s?\d[\d,]*(?:\.\d{1,2})?\s*(?:k)?(?:\s*(?:\/|per|an?|each)?\s*(?:hr|hour|hourly|yr|year|annum|annually|month|monthly|week|weekly|day))?\.?$/i.test(s) && /\d/.test(s) ? s : null;
};
const posVal = (v) => {
  const s = collapse(v).replace(/[,;|]+$/, "");
  if (!s || PLACEHOLDER.test(s) || /\d/.test(s) || !/^[A-Za-z][A-Za-z &/,'’.-]{2,60}$/.test(s)) return null;
  return s;
};

/* ----------------------------------------------------------------- label table */
// prio: lower wins when several groups of one key find something.
const SPECS = [
  // ---- licence / certificate
  { key: "license_number", types: ["license-certification"], prio: 1, embed: true,  val: numberVal,
    label: "(?:driver'?s?\\s+|cdl\\s+|operator'?s?\\s+)?(?:licen[cs]e|lic\\.?|certificate|cert\\.?|card)\\s*(?:no\\.?|number|num\\.?|#)|dln|dl\\s*(?:no\\.?|number|#)|cdl\\s*(?:no\\.?|number|#)" },
  { key: "holder_name", types: ["license-certification"], prio: 1, embed: true,  val: (v, c) => nameVal(v, c),
    label: "(?:(?:driver|licensee|holder|cardholder|applicant|examinee|operator|certificate\\s+holder)(?:'s|’s)?\\s+(?:full\\s+|printed\\s+)?name|name\\s+of\\s+(?:the\\s+)?(?:driver|licensee|holder|applicant|examinee|operator)|licensee|full\\s+name|(?:certificate\\s+|licen[cs]e\\s+|card\\s+)?holder|issued\\s+to|awarded\\s+to|presented\\s+to)" },
  { key: "holder_name", types: ["license-certification"], prio: 2, val: (v, c) => nameVal(v, c), label: "(?:1\\s+)?name" },
  { key: "license_class", types: ["license-certification"], prio: 1, val: classVal,
    label: "(?:(?:cdl|licen[cs]e|driver'?s?)\\s+)?class(?:\\s+of\\s+(?:cdl|licen[cs]e))?" },
  { key: "end_date", types: ["license-certification"], prio: 1, embed: true,  date: true,
    label: `(?:${WORD}\\s+){0,5}?(?:expiration|expiry|expires?|exp)(?:\\s+date)?|valid\\s+(?:through|until|thru)` },
  { key: "start_date", types: ["license-certification"], prio: 1, embed: true,  date: true,
    label: `(?:${WORD}\\s+){0,3}?(?:issue(?:d)?(?:\\s+(?:date|on))?|date\\s+(?:of\\s+)?issu(?:ed|e|ance)|iss)|date\\s+(?:of\\s+)?(?:the\\s+)?(?:medical\\s+)?exam(?:ination)?|exam(?:ination)?\\s+date|date\\s+(?:certificate\\s+)?signed|signature\\s+date|effective\\s+date` },
  { key: "issued_by", types: ["license-certification"], prio: 1, embed: true,  val: (v, c) => nameVal(v, { ...c, kind: "examiner" }),
    label: "(?:(?:medical\\s+)?examiner'?s?\\s+(?:printed\\s+)?name|name\\s+of\\s+(?:the\\s+)?(?:medical\\s+)?examiner|printed\\s+name\\s+of\\s+(?:the\\s+)?(?:medical\\s+)?examiner)" },
  { key: "issued_by", types: ["license-certification"], prio: 1, val: (v, c) => nameVal(v, { ...c, kind: "examiner" }), label: "medical\\s+examiner" },
  { key: "issued_by", types: ["license-certification"], prio: 2, val: issuerVal,
    label: "(?:issued\\s+by|issuing\\s+(?:authority|agency|state|jurisdiction|body)|state\\s+of\\s+issu(?:ance|e)|licensing\\s+(?:authority|agency)|issuer)" },
  // ---- HR new-hire sheet
  { key: "employee_name", types: ["hr-letter"], prio: 1, val: (v, c) => nameVal(v, c),
    label: "(?:(?:new\\s+)?(?:hire|employee)(?:'s|’s)?\\s+(?:full\\s+)?name|name\\s+of\\s+(?:the\\s+)?(?:new\\s+)?(?:hire|employee)|new\\s+(?:hire|employee)|employee)" },
  { key: "employee_name", types: ["hr-letter"], prio: 2, val: (v, c) => nameVal(v, c), label: "name" },
  { key: "start_date", types: ["hr-letter"], prio: 1, date: true,
    label: "(?:start(?:ing)?|hire|hired|employment\\s+start|first\\s+day(?:\\s+of\\s+work)?|report(?:ing)?)\\s+(?:date|day)|date\\s+(?:of\\s+)?(?:hire|hired|start(?:ing)?)|first\\s+day(?:\\s+of\\s+work)?" },
  { key: "position", types: ["hr-letter"], prio: 1, val: posVal, label: "(?:job\\s+)?(?:position|title|role)(?:\\s+title)?|job\\s+title" },
  { key: "pay_rate", types: ["hr-letter"], prio: 1, val: payVal,
    label: "(?:rate\\s+of\\s+pay|pay\\s+rate|hourly\\s+(?:rate|wage)|starting\\s+(?:pay|wage|salary|rate)|annual\\s+salary|salary|wage|pay|compensation|rate)" },
  { key: "manager", types: ["hr-letter"], prio: 1, val: (v, c) => nameVal(v, c),
    label: "(?:(?:hiring|reporting|direct|site)\\s+)?(?:manager|supervisor)(?:'s|’s)?(?:\\s+name)?|reports?\\s+to|reporting\\s+to" },
];
const NAME_KEYS = new Set(["issued_by", "holder_name"]);
const NAME_LIKE_KEYS = new Set(["issued_by", "holder_name", "employee_name", "manager"]);
const PAREN = "(?:\\s*\\([^)]*\\))?";
const DATE_RE = /(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}[ -][A-Za-z]{3,9}\.?[ -]\d{2,4})/;
const COMPILED = SPECS.map((s) => ({
  ...s,
  inline: new RegExp(`^(?:\\d{1,2}[a-z]?[.)]?\\s+)?(?:${s.label})${PAREN}\\s*(?:[:#=\\-–]\\s*|\\s+)(.+)$`, "i"),
  only: new RegExp(`^(?:\\d{1,2}[a-z]?[.)]?\\s+)?(?:${s.label})${PAREN}\\s*[:#=\\-–]?$`, "i"),
  // a label sitting inside a longer label row ("... Number   Date Certificate Signed"), nothing valued after it
  midDate: s.date && s.embed ? new RegExp(`(?:^|[\\s|])(?:${s.label})(?![A-Za-z'’])${PAREN}\\s*[:=]\\s*(${DATE_RE.source})`, "i") : null,
  embedded: s.embed ? new RegExp(`(?:^|[\\s|])(?:${s.label})(?![A-Za-z'’])${PAREN}\\s*[:#=]?(${NAME_KEYS.has(s.key) ? ".*" : "[^\\d]*"})$`, "i") : null,
}));

const cellsOf = (t) => t.split(/\s{3,}|\t+|\s\|\s/).map((x) => collapse(x)).filter(Boolean);
const isLabelOnly = (cell, type) => COMPILED.some((s) => s.types.includes(type) && s.only.test(cell));
const startsLabelled = (cell, type) => COMPILED.some((s) => s.types.includes(type) && (s.only.test(cell) || s.inline.test(cell)));
const TRAILING_DATE_RE = new RegExp(`(?:^|[\\s|,;])(${DATE_RE.source})\\s*$`);
// a form prints a person's name followed by check boxes / credentials: the leading run of name-shaped words
const namePrefix = (line) => {
  const out = [];
  for (const w of collapse(line).split(" ")) { if (/^[A-Z][A-Za-z'’-]*\.?,?$/.test(w) || /^[A-Z]\.?$/.test(w)) out.push(w); else break; }
  return out.length >= 2 ? out.join(" ") : null;
};
/** Candidate raw values for a label whose value is on the next line, best first. */
function belowValues(s, nextLine, anyCell = false) {
  const cells = cellsOf(nextLine);
  const out = [];
  for (const cell of anyCell ? cells : cells.slice(0, 1)) {
    if (s.date) { out.push(cell); continue; }
    if (s.key === "license_number") { out.push(cell.split(" ")[0], cell); continue; }
    if (["holder_name", "issued_by", "employee_name", "manager"].includes(s.key)) { out.push(cell, namePrefix(cell) ?? ""); continue; }
    out.push(cell);
  }
  if (s.date) { const t = TRAILING_DATE_RE.exec(nextLine); out.push(t ? t[1] : ""); }
  return out;
}

/**
 * @param {{page_no:number,text:string}[]} pages
 * @param {{type: string, keys?: string[]|null, order?: 'mdy'|'dmy'}} opts
 * @returns {{candidates: Record<string, {value:string, page_no:number, verbatim:string, label:string, strength:'explicit'}[]>, ambiguous: {key:string, values:string[]}[]}}
 */
export function scanIdDocFacts(pages, { type, keys = null, order = "mdy" } = {}) {
  const none = { candidates: {}, ambiguous: [] };
  if (!ID_DOC_TYPES.has(type)) return none;
  const want = new Set((keys ?? ID_KEYS_BY_TYPE[type]).filter((k) => ID_KEYS_BY_TYPE[type].includes(k)));
  if (!want.size) return none;
  // People-forms round: a clean grid form (label above value) is read by the layout reader first; its facts win over the line scan.
  let grid = { facts: {}, conflicts: [] };
  try { const g = readPeopleForm(pages, { order }); if (g.kind && KIND_TYPE[g.kind] === type) grid = g; } catch { grid = { facts: {}, conflicts: [] }; }
  const specs = COMPILED.filter((s) => s.types.includes(type) && want.has(s.key));
  const lines = [];
  for (const p of pages ?? []) {
    const rawLines = String(p?.text ?? "").split(/\r?\n/).map((r) => r.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[ \u00a0]+$/g, "").replace(/^[ \u00a0]+/, ""));
    // the form's own control block (OMB number, form number, revision line, the "Expires" line that wraps after them) is never read
    const control = formControlMask(rawLines);
    let seen = 0;
    rawLines.forEach((t, k) => { if (t && !control[k]) lines.push({ t, page: Number(p.page_no) || 1, head: seen++ < 3 }); });
  }
  const ctx = { titleLines: titleLinesOf(pages), fullText: (pages ?? []).map((p) => String(p?.text ?? "")).join("\n") };
  const raw = []; // {key, prio, value, page, verbatim, label}
  const ambiguousKeys = new Set(); // keys whose date could be either of two printed dates: neither reader may pick one
  const take = (s, rawVal, verbatim, page, label, sameLine = false) => {
    let value;
    if (s.date) {
      const m = DATE_RE.exec(collapse(rawVal));
      if (!m) return;
      value = normalizeDate(m[0], { order });
      if (!value) return;
    } else {
      value = s.val(rawVal, sameLine ? { ...ctx, onLabel: true } : ctx);
      if (!value) return;
    }
    raw.push({ key: s.key, prio: s.prio, value, page_no: page, verbatim: collapse(verbatim).slice(0, 400), label: collapse(label).toLowerCase(), strength: "explicit" });
  };
  for (let i = 0; i < lines.length; i++) {
    const cells = cellsOf(lines[i].t);
    const next = lines[i + 1] ?? null;
    // a row of labels with the row of values beneath it
    if (cells.length >= 2 && next && cells.every((c) => isLabelOnly(c, type))) {
      const vals = cellsOf(next.t);
      if (vals.length === cells.length) {
        cells.forEach((c, j) => { for (const s of specs) if (s.only.test(c)) take(s, vals[j], `${lines[i].t} ${next.t}`, next.page, c); });
        i++;
        continue;
      }
    }
    // a long label split by a wide gap ("Certificate Exp      Date") is still one label: try the whole line first
    if (cells.length > 1) {
      const whole = collapse(lines[i].t);
      const ws = specs.filter((sp) => sp.only.test(whole));
      if (ws.length && next) {
        const v0 = cellsOf(next.t)[0] ?? "";
        if (v0 && !/:$/.test(v0) && !startsLabelled(v0, type)) for (const sp of ws) for (const cand of belowValues(sp, next.t)) { const n0 = raw.length; take(sp, cand, `${lines[i].t} ${next.t}`, next.page, whole); if (raw.length > n0) break; }
        continue;
      }
    }
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      for (const s of specs) {
        const last = j === cells.length - 1;
        let below = false;
        if (s.only.test(c)) {
          below = true;
          // label and value in neighbouring cells of ONE line ("License #   JP-860244   Owner   ..."): the next cell is the value
          if (!last) {
            const right = cells[j + 1];
            if (/\d/.test(right) || s.key === "holder_name" || s.key === "employee_name" || s.key === "manager" || s.key === "issued_by" || s.key === "position") {
              const n0 = raw.length;
              if (!startsLabelled(right, type)) take(s, right, lines[i].t, lines[i].page, c, true);
              if (raw.length > n0 || /\d/.test(right) && !NAME_KEYS.has(s.key)) continue;
            }
          }
        }
        else {
          const m = s.inline.exec(c);
          // no-colon "label rest-of-line" only when the rest is a value, not a longer label ("Name of Business", "Employee Information and Attestation")
          if (m && !c.slice(0, c.length - m[1].length).includes(":") && /^(?:of|and|type|status|number|no|information|attestation|for|the|name|date|title|id)\b/i.test(m[1])) continue;
          // a bare "new hire" / "employee" label with no colon and no "name" on a heading line is the page TITLE ("New Hire Orientation Agenda"), not a label
          if (m && lines[i].head && NAME_LIKE_KEYS.has(s.key) && !/:/.test(c) && !/\bname\b/i.test(c.slice(0, c.length - m[1].length))) continue;
          if (m) { take(s, m[1], lines[i].t, lines[i].page, c, true); continue; }
          // a dated label in the MIDDLE of a printed row ("Year / Make / Model: 2019 Trailer 14D  Date Issued: 6/18/26"): label, colon, then a date
          if (s.date && s.embed && c.length <= 160) { const mid = s.midDate.exec(c); if (mid) { take(s, mid[1], lines[i].t, lines[i].page, c); continue; } }
          const em = s.embedded && c.length <= 140 && !(s.key === "license_number" && /examiner/i.test(c)) ? s.embedded.exec(c) : null;
          below = !!em && em[1].trim().split(/\s+/).filter(Boolean).length <= (s.key === "issued_by" || s.key === "holder_name" ? 12 : 4);
        }
        // two dates under one label line (issued / expires printed side by side, or OCR splitting the label row): which date belongs to this label is a guess
        if (below && next && s.date) {
          const nDates = (next.t.match(new RegExp(DATE_RE.source, "g")) ?? []).length;
          if (nDates >= 2 && cells.length < nDates) { below = false; ambiguousKeys.add(s.key); }
        }
        if (below && next) {
          const v0 = cellsOf(next.t)[0] ?? "";
          if (v0 && !/:$/.test(v0) && !startsLabelled(v0, type)) for (const cand of belowValues(s, next.t, !last)) { const n0 = raw.length; take(s, cand, `${lines[i].t} ${next.t}`, next.page, c); if (raw.length > n0) break; }
        }
      }
    }
  }
  for (const [key, f] of Object.entries(grid.facts)) {
    if (!want.has(key) || grid.conflicts.includes(key)) continue;
    if (["holder_name", "employee_name", "manager"].includes(key) && !nameVal(f.value, ctx)) continue; // the grid reader's names obey the same shape rule
    raw.push({ key, prio: 0, value: f.value, page_no: f.page_no, verbatim: f.verbatim, label: "form-grid", strength: "explicit" });
  }
  // a licence, card or policy never expires on or before the day it starts: both readings are wrong or mixed up, so neither is a fact (and the
  // generic scan may not refill them: `blocked`). A grid-read pair is the layout reader's own and is not second-guessed here.
  const blocked = [];
  for (const k of ambiguousKeys) if (!raw.some((r) => r.key === k)) blocked.push(k);
  if (type !== "hr-letter") {
    const s0 = raw.filter((r) => r.key === "start_date" && r.label !== "form-grid"); const e0 = raw.filter((r) => r.key === "end_date" && r.label !== "form-grid");
    const gridHas = raw.some((r) => r.label === "form-grid" && (r.key === "start_date" || r.key === "end_date"));
    if (!gridHas && s0.length && e0.length && s0.some((a) => e0.some((b) => b.value <= a.value))) {
      for (let i = raw.length - 1; i >= 0; i--) if (raw[i].key === "start_date" || raw[i].key === "end_date") raw.splice(i, 1);
      blocked.push("start_date", "end_date");
    }
  }
  // lowest priority number wins per key; the same key from a lower-priority group is dropped
  const candidates = {};
  const ambiguous = [];
  for (const key of want) {
    const mine = raw.filter((r) => r.key === key);
    if (!mine.length) continue;
    const best = Math.min(...mine.map((r) => r.prio));
    const use = mine.filter((r) => r.prio === best);
    const seen = new Set();
    candidates[key] = use.filter((r) => { const id = r.value.toLowerCase(); if (seen.has(id)) return false; seen.add(id); return true; })
      .map(({ key: _k, prio: _p, ...c }) => c);
    // the same value found twice is one candidate; two different values stay two (the planner calls that ambiguous)
  }
  return { candidates, ambiguous, blocked };
}
