/**
 * People-forms round (round 2 of the ID-document work): a layout reader for CLEAN text people / compliance forms.
 *
 * THE DEFECT: government and HR forms print the label ABOVE its value in a grid ("DRIVER'S NAME   DRIVER'S LICENSE NO.   STATE" over
 * "Ulises A. Larkspur   D83475361   AZ"), put the person's name in labels the generic scan does not know ("Driver's name", "Employee
 * name", "Registered owner", "Named insured", first / last / middle in three cells), and name the issuer or the employer only in a title
 * line or a cell. The result was almost no fields on these papers, and a few WRONG ones (a label row read as a vendor).
 *
 * This module reads those forms. It first decides the FORM KIND from what the page prints (never from a guess): medical examiner's
 * certificate / examination report, CPR / forklift cards, vehicle registration, auto insurance ID card, I-9, W-4, AZ A-4, direct deposit,
 * background-check consent, new-hire sheet, volunteer application. An unknown kind reads NOTHING (so ACORD certificates, trade
 * licences and every other paper keep exactly their old behaviour). Then it pairs each label cell with the value cell beneath it
 * (same column), maps the label to a field, validates the value for that field, and keeps the lines it came from as the quote.
 *
 * Precision first: a value that does not validate is not a fact; two different values for one field are not a fact; a redacted or
 * blank cell is absent. Sensitive identifiers (SSN, bank routing / account, birth date, plate, VIN) are NEVER returned as facts here.
 * The licence / card number IS returned (the app stores it like any licence number); the answer layer shows only "on file" + last 4.
 *
 * Pure. No I/O, no clock.
 */
import { normalizeDate } from "../extractFields.js";
import { nameShape, formControlMask, hasNameEvidence } from "./peopleShape.js";

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const DATE_RE = /(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/;

/* ------------------------------------------------------------------------------------------ form kind */
const KIND_RULES = [
  ["mec", /medical\s+examiner'?s?\s+certificate|mcsa[-\s]?5876|medical\s+examination\s+report|mcsa[-\s]?5875/i, 30],
  ["i9", /employment\s+eligibility\s+verification|\bform\s+i-?9\b/i, 12],
  ["a4", /arizona\s+form\s+a-?4|employee'?s\s+arizona\s+withholding\s+election/i, 12],
  ["w4", /\bform\s+w-?4\b|employee'?s\s+withholding\s+certificate/i, 12],
  ["dd", /direct\s+deposit\s+authori[sz]ation/i, 12],
  ["bg", /(?:disclosure\s+and\s+authori[sz]ation\s+for\s+background\s+check|background\s+(?:check|investigation)\s+(?:consent|authori[sz]ation|disclosure))/i, 12],
  ["newhire", /new[-\s]hire\s+(?:information\s+)?(?:sheet|form|checklist|packet)/i, 8],
  ["volunteer", /volunteer\s+(?:application|registration)/i, 8],
  ["insurance", /(?:auto\s+)?insurance\s+identification\s+card|proof\s+of\s+(?:auto\s+)?insurance\s+card|insurance\s+id\s+card/i, 10],
  ["vehreg", /vehicle\s+registration/i, 6],
  ["cpr", /\bcpr\b[^\n]{0,40}(?:aed|first\s+aid)|certificate\s+of\s+completion[^\n]{0,20}\bcpr\b|\bbls\b[^\n]{0,30}(?:provider|card)/i, 6],
  ["forklift", /powered\s+industrial\s+truck|\bfork\s?lift\b/i, 6],
];
// papers that merely MENTION these words (a forklift repair invoice, a vehicle registration renewal bill) are not the people form itself
const NOT_A_FORM = /\b(?:invoice|quote|estimate|receipt for|work order|purchase order|statement of account|proposal|rental agreement|service ticket|bill of lading)\b/i;
/** @returns {string|null} the kind of people form these pages are, from the first lines of the first page */
export function formKind(pages) {
  const p0 = String((pages ?? [])[0]?.text ?? "");
  const lines = p0.split(/\r?\n/).map((l) => collapse(l)).filter(Boolean);
  for (const [kind, re, n] of KIND_RULES) {
    const head = lines.slice(0, n).join("\n");
    if (!re.test(head)) continue;
    if ((kind === "forklift" || kind === "cpr" || kind === "vehreg") && NOT_A_FORM.test(lines.slice(0, 12).join("\n"))) continue;
    if (kind === "mec") {
      // the certificate's own title, not a sentence in a memo or a line on a bill, and the form's labels beside it
      const tl = lines.slice(0, n).find((l) => re.test(l));
      const labels = [/\bdriver'?s?\s+(?:full\s+)?name\b/i, /\bexpiration\s+date\b|\bcertificate\s+exp/i, /\bdate\s+of\s+exam/i, /\bexaminer'?s?\s+(?:name|signature)/i, /\bdriver'?s?\s+licen[cs]e\s+(?:no|number)/i, /\bsigned\b/i, /\bclass\b/i].filter((r) => r.test(p0)).length;
      if (!tl || tl.length > 90 || /\b(?:must|shall|should|required?|carry|hold|bring|submit|issued|invoice|bill|charge|fee|total|please)\b|\$\s?\d/i.test(tl) || labels < 2) continue;
    }
    if (kind === "forklift" && !/operator|certificate|certification|training|card/i.test(head)) continue;
    return kind;
  }
  return null;
}
export const KIND_DOCUMENT_TYPE = { mec: "license-certification", cpr: "license-certification", forklift: "license-certification", vehreg: "license-certification", i9: "hr-letter", a4: "hr-letter", w4: "hr-letter", dd: "hr-letter", bg: "hr-letter", newhire: "hr-letter", volunteer: "hr-letter", insurance: "insurance-certificate" };

/* ------------------------------------------------------------------------------------------ labels */
const TAGS = [
  ["name", /^(?:driver'?s? name|driver name|employee name|employee'?s name|full name|name|applicant full name|applicant name|registered owner|named insured|licensee name|holder name|cardholder name)$/],
  ["last", /^last name(?: family name)?$/],
  ["first", /^first name(?: and middle initial)?(?: given name)?$/],
  ["mi", /^middle initial$/],
  ["dl_no", /^driver'?s? licen[cs]e (?:no\.?|number)$/],
  ["cert_no", /^(?:card ?\/ ?certificate (?:no\.?|number)|certificate (?:no\.?|number)|card (?:no\.?|number)|cert\.? (?:no\.?|number))$/],
  ["policy_no", /^policy (?:number|no\.?)$/],
  ["issued_by", /^issued by$/],
  ["examiner", /^(?:medical )?examiner'?s? name$/],
  ["natreg", /^national registry (?:no\.?|number)$/],
  ["exam_date", /^date of exam(?:ination)?$/],
  ["issue_date", /^(?:date issued|issue date|registration issued|date of issue|effective date)$/],
  ["exp_date", /^(?:expires|expiration date|expiry date|expiry|exp\.? date|registration expires|medical certificate (?:expiration date|expires)|valid through|expiration)$/],
  ["start", /^(?:start date|starting date|first day of employment|date of hire|hire date)$/],
  ["signed", /^(?:date|date signed|today'?s date|signature date)$/],
  ["employer", /^(?:employer|employer business or organization name|employer name)$/],
  ["employer_addr", /^employer'?s? name and address$/],
  ["position", /^(?:position|job title|title)$/],
  ["department", /^department$/],
  ["manager", /^(?:reports to ?\/ ?manager|reports to|manager|supervisor|reporting manager|hiring manager)$/],
  ["rate", /^(?:hourly rate|rate of pay|pay rate|salary)$/],
  ["phone", /^(?:phone|telephone|phone number|cell phone)$/],
  ["email", /^(?:email|e-mail|email address|employee'?s email address)$/],
  ["econtact", /^contact name$/],
  ["ephone", /^contact phone$/],
  ["role", /^volunteer role of interest$/],
  ["availability", /^availability$/],
  ["reference", /^reference name$/],
  ["bank", /^bank name$/],
  ["acct_type", /^account type$/],
  ["extra_wh", /extra withholding/],
  ["year", /^year$/], ["make", /^make$/], ["model", /^model$/],
  ["ignore", /^(?:state|date of birth|dob|address|home address|owner address|current address|city or town|city or town, state, and zip code|zip code|other last names used|social security number|u\.s\. social security number|aba routing number(?: \(9 digits\))?|routing number|account number|employee'?s? signature|employer'?s? signature|applicant signature|signature|examiner'?s? telephone|medical examiner license no\.? and state|examiner license no\.? ?\/ ?state|license plate|plate type|body|fee paid|vehicle identification number|naic|instructor|course|skills ?\/ ?certifications|reference phone|vin|employer identification number|employer identification number \(ein\)|last name, first name and title of employer representative|list a - document title|document number|certification period|employer'?s name and address|shirt size|vision right|vision left|hearing|blood pressure|pulse rate|urinalysis specific gravity|protein|blood ?\/ ?sugar|step 3: claim dependents - total amount|dependents)$/],
];
const stripLabel = (c) => collapse(c).toLowerCase().replace(/[’‘]/g, "'").replace(/\([^)]*\)/g, " ").replace(/^step \d\s*\w?\s*:\s*/i, "").replace(/^[a-z]\)\s*/, "").replace(/[:#]+$/, "").replace(/\s+/g, " ").trim();
const tagOf = (cell) => {
  const raw = collapse(cell);
  const variants = [stripLabel(raw)];
  // keep the parenthetical for labels like "FIRST NAME (GIVEN NAME)" that map by their stem; also try the unstripped lower form
  variants.push(raw.toLowerCase().replace(/[’‘]/g, "'").replace(/^\([a-z]\)\s*/, ""));
  for (const v of variants) for (const [tag, re] of TAGS) if (re.test(v)) return tag;
  return null;
};
const upperish = (c) => { const L = c.replace(/[^A-Za-z]/g, ""); return L.length >= 2 && L.replace(/[^A-Z]/g, "").length / L.length >= 0.85; };

/** cells of a layout line with their start columns */
function cellsWithCols(line) {
  const out = [];
  const s = String(line).replace(/\t/g, "    ");
  // cells are separated by two or more spaces
  const parts = s.split(/( {2,})/);
  let col = 0;
  for (const part of parts) {
    if (/^ {2,}$/.test(part)) { col += part.length; continue; }
    if (part.length) { const t = part.trim(); if (t) out.push({ t: collapse(t), col: col + (part.length - part.trimStart().length) }); }
    col += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ value validators */
const PLACEHOLDER = /^(?:n\/?a|none|tbd|unknown|redacted|x{3,}|\*{3,}|[-_.#█▇■□\s]+|\[?redacted\]?|signature)$/i;
const titleCase = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase()));
let FORM_TEXT = null; // the paper being read (set by readPeopleForm, synchronous): evidence for a name
function personVal(v, { allowDr = false, strong = true } = {}) {
  let s = collapse(v).replace(/[,;|]+$/, "");
  if (!s || PLACEHOLDER.test(s) || /redact/i.test(s) || /\d/.test(s)) return null;
  // "Last, First Middle" -> "First Middle Last"
  const cm = /^([A-Za-z'’ -]+),\s*([A-Za-z'’. -]+)$/.exec(s);
  if (cm && !/^(?:md|do|dc|pa|pa-c|np|dds|phd|jr|sr|ii|iii)\.?$/i.test(cm[2].trim())) s = `${cm[2].trim()} ${cm[1].trim()}`;
  if (!/^[A-Za-z][A-Za-z .'’-]{2,70}$/.test(s)) return null;
  if (/,\s*[A-Z]{2}\.?$/.test(collapse(v).replace(/[;|]+$/, "")) && !/,\s*(?:MD|DO|DC|PA|NP|DDS|PHD|JR|SR|II|III)\.?$/i.test(collapse(v))) return null; // "Mesa, AZ" is a place
  if (/^(?:of|and|the|for|type|status|information|attestation)\b/i.test(s)) return null;
  const toks = s.split(/\s+/);
  if (toks.length < 2 || toks.length > 6) return null;
  if (/\b(?:signature|date|name|address|phone|number|license|licence|certificate|redacted|checklist|department|employer|company|inc|llc|insurance|training|academy|information|sheet|form|application|card|hire|new|employee|n\/a)\b/i.test(s)) return null;
  if (!allowDr && /^(?:dr|mr|mrs|ms)\.?$/i.test(toks[0])) return null;
  if (!nameShape(collapse(v), { kind: allowDr ? "examiner" : "person", maxCore: 5 }).ok) return null; // structure, not a word list
  const out = titleCase(s);
  // round 5: positive evidence (a real given name, or the name printed twice); an examiner's title or credential also counts
  if (FORM_TEXT != null && !hasNameEvidence(out, FORM_TEXT, { onLabel: !allowDr, strong }) && !(allowDr && /,\s*[A-Za-z.-]{2,6}$|\s(?:M\.?D\.?|D\.?O\.?|D\.?C\.?|P\.?A\.?(?:-C)?|N\.?P\.?|APRN|DNP|DDS|DMD)$|^(?:Dr|Prof)\.?\s/.test(collapse(v)))) return null;
  return out;
}
const dateVal = (v, order) => { const m = DATE_RE.exec(collapse(v)); if (!m) return null; return normalizeDate(m[0], { order }) || null; };
const numberVal = (v) => {
  const s = collapse(v).replace(/[,;|]+$/, "");
  if (!s || PLACEHOLDER.test(s) || /redact/i.test(s) || !/^[A-Za-z0-9][A-Za-z0-9 -]{3,23}$/.test(s) || !/\d/.test(s)) return null;
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(s)) return null;
  const solid = s.replace(/[\s-]/g, "");
  if (solid.length < 5 || (solid.match(/\d/g) ?? []).length < 3 || /^(.)\1+$/.test(solid)) return null;
  if (/\s/.test(s) && !/^\d+(?:\s\d+)+$/.test(s)) return null;
  return s;
};
const orgVal = (v) => {
  const s = collapse(v).replace(/[;|]+$/, "").replace(/,\s*$/, "");
  if (!s || PLACEHOLDER.test(s) || /redact/i.test(s) || s.length < 3 || s.length > 70 || !/[A-Za-z]{3}/.test(s)) return null;
  if (/\d{4,}/.test(s) || /\b(?:signature|date of|address|phone|number)\b/i.test(s)) return null;
  return titleCase(s);
};
const textVal = (v, max = 60) => { const s = collapse(v).replace(/[;|]+$/, ""); return s && !PLACEHOLDER.test(s) && !/redact/i.test(s) && s.length <= max && /[A-Za-z]/.test(s) ? s : null; };
const phoneVal = (v) => { const s = collapse(v); const d = s.replace(/\D/g, ""); return /^[\d()\s.+-]{7,20}$/.test(s) && (d.length === 10 || d.length === 11 || d.length === 7) ? s : null; };
const emailVal = (v) => { const s = collapse(v); return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? s : null; };
const moneyVal = (v) => { const s = collapse(v); return /^\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:\/|per)\s*(?:hr|hour|yr|year))?$/i.test(s) ? s.replace(/\s+/g, "") : null; };

/* ------------------------------------------------------------------------------------------ the reader */
/**
 * @param {{page_no:number,text:string}[]} pages
 * @param {{order?: 'mdy'|'dmy'}} [opts]
 * @returns {{kind: string|null, facts: Record<string, {value:string, page_no:number, verbatim:string}>, extras: Record<string, {value:string, page_no:number, verbatim:string}>, conflicts: string[]}}
 */
export function readPeopleForm(pages, { order = "mdy" } = {}) {
  const none = { kind: null, facts: {}, extras: {}, conflicts: [] };
  const kind = formKind(pages);
  if (!kind) return none;
  FORM_TEXT = (pages ?? []).map((p) => String(p?.text ?? "")).join("\n");
  const facts = {}; const extras = {}; const conflicts = [];
  const seen = {}; // key -> Set(lowercased value)
  const put = (into, key, value, page, verbatim) => {
    if (value == null || value === "") return;
    const id = String(value).toLowerCase();
    seen[key] ??= new Set();
    if (!seen[key].size) { into[key] = { value, page_no: page, verbatim: collapse(verbatim).slice(0, 400) }; }
    else if (!seen[key].has(id)) { if (!conflicts.includes(key)) conflicts.push(key); }
    seen[key].add(id);
  };

  for (const p of pages ?? []) {
    const page = Number(p?.page_no) || 1;
    const allLines = String(p?.text ?? "").split(/\r?\n/).filter((l) => l.trim());
    const ctl = formControlMask(allLines);
    const lines = allLines.filter((_, k) => !ctl[k]); // the form's own control block (OMB / form number / Rev / Expires, wrapped or not) is never read
    const info = lines.map((l) => ({ raw: l, cells: cellsWithCols(l) }));
    const isLabelRow = (r) => r.cells.length >= 1 && r.cells.every((c) => upperish(c.t) || tagOf(c.t)) && r.cells.some((c) => tagOf(c.t));
    // ---- label rows with the value row beneath
    for (let i = 0; i < info.length - 1; i++) {
      const row = info[i];
      if (/\bOMB\b/i.test(row.raw)) continue;
      if (!isLabelRow(row)) continue;
      let vi = i + 1;
      if (isLabelRow(info[vi])) continue;
      const vrow = info[vi];
      const vcells = vrow.cells;
      const labels = row.cells.map((c) => ({ ...c, tag: tagOf(c.t) }));
      // pair each value cell with the label whose column is nearest (and within reach); equal counts pair in order
      const paired = new Map();
      if (vcells.length === labels.length) vcells.forEach((v, j) => paired.set(j, v));
      else {
        for (const v of vcells) {
          let best = null; let bd = 1e9;
          labels.forEach((l, j) => { if (paired.has(j)) return; const d = Math.abs(l.col - v.col); if (d < bd) { bd = d; best = j; } });
          if (best != null && bd <= 8) paired.set(best, v);
        }
      }
      const quote = `${row.raw.trim()} ${vrow.raw.trim()}`;
      const byTag = {};
      labels.forEach((l, j) => { const v = paired.get(j); if (l.tag && v) (byTag[l.tag] ??= []).push(v.t); });
      handle(kind, byTag, quote, page);
    }
    // ---- checkbox lines
    for (const r of info) {
      const m = /^\s*(?:X|\[x\]|☒|✓)\s+(.{3,80})$/.exec(r.raw);
      if (!m) continue;
      const txt = collapse(m[1]);
      if (kind === "a4") { const pm = /^(\d(?:\.\d)?%)\s+of\s+gross/i.exec(txt); if (pm) put(extras, "withholding_percentage", pm[1], page, r.raw); }
      if (kind === "w4" && /^(?:single|married|head of household)/i.test(txt)) put(extras, "filing_status", txt.replace(/\s*\(.*$/, ""), page, r.raw);
    }
  }
  // ---- header organisation: "Blue Agave Catering - New Hire Information Sheet"
  const first = (pages ?? []).find((p) => String(p?.text ?? "").trim());
  if (first) {
    const lines = String(first.text).split(/\r?\n/).map((l) => collapse(l)).filter(Boolean).slice(0, 4);
    for (const l of lines) {
      const m = /^(.{3,60}?)\s+[-–—]\s+(?:new[-\s]hire[^-]*|payroll department|human resources|volunteer (?:application|registration)|(?:auto )?insurance identification card|hr department)$/i.exec(l);
      if (m) { const o = orgVal(m[1]); if (o) put(facts, "vendor", o, Number(first.page_no) || 1, l); break; }
    }
    // the screening agency in the body of a background-check consent
    if (kind === "bg") {
      const body = collapse(String(first.text).replace(/\r?\n/g, " "));
      const am = /(?:report|reports)[^.]{0,120}?\bfrom\s+([A-Z][A-Za-z0-9&,' -]{3,60}?(?:\s(?:Inc|LLC|Co|Corp|Ltd)\.?)?)\.\s+(?:This|The|Under)\b/.exec(body);
      if (am) { const o = orgVal(am[1]); if (o) put(extras, "agency", o, Number(first.page_no) || 1, am[0].slice(0, 300)); }
    }
  }
  return { kind, facts, extras, conflicts };

  function handle(kind, t, quote, page) {
    const one = (tag) => (t[tag] && t[tag].length === 1 ? t[tag][0] : t[tag]?.[0]);
    const D = (tag) => dateVal(one(tag), order);
    const holder = (key) => {
      if (t.name) { const v = personVal(one("name")); if (v) put(facts, key, v, page, quote); }
      else if (t.first && t.last) {
        const f = collapse(one("first")); const mi = t.mi ? collapse(one("mi")) : "";
        const l = collapse(one("last"));
        const parts = [f, /^[A-Za-z]$/.test(mi) ? mi : "", l].filter(Boolean).join(" ");
        const v = personVal(parts); if (v) put(facts, key, v, page, quote);
      }
    };
    const isLic = ["mec", "cpr", "forklift", "vehreg"].includes(kind);
    if (isLic) holder("holder_name");
    else if (kind === "insurance") holder("holder_name");
    else holder("employee_name");
    if (t.dl_no && kind === "mec") put(facts, "license_number", numberVal(one("dl_no")), page, quote);
    if (t.cert_no) put(facts, "license_number", numberVal(one("cert_no")), page, quote);
    if (t.policy_no) put(facts, "policy_number", numberVal(one("policy_no")), page, quote);
    if (t.exam_date && kind === "mec") put(facts, "start_date", D("exam_date"), page, quote);
    if (t.issue_date && (isLic || kind === "insurance")) put(facts, "start_date", D("issue_date"), page, quote);
    if (t.exp_date && (isLic || kind === "insurance")) put(facts, "end_date", D("exp_date"), page, quote);
    if (t.examiner) { const v = personVal(one("examiner"), { allowDr: true }); put(facts, "issued_by", v, page, quote); }
    if (t.issued_by) { const o = orgVal(one("issued_by")); put(facts, "issued_by", o, page, quote); put(facts, "vendor", o, page, quote); }
    if (t.natreg) put(extras, "national_registry", numberVal(one("natreg")), page, quote);
    if (t.start) put(facts, "start_date", D("start"), page, quote);
    if (t.signed && !isLic && kind !== "insurance") put(facts, "signed_date", D("signed"), page, quote); // HR-scoped key (never service_date: an employee paper has no work order)
    if (t.employer && !isLic) put(facts, "vendor", orgVal(one("employer")), page, quote);
    if (t.employer_addr && !isLic) put(facts, "vendor", orgVal(collapse(one("employer_addr")).split(",")[0]), page, quote);
    if (t.position) put(facts, "position", textVal(one("position")), page, quote);
    if (t.manager) { const v = personVal(one("manager"), { strong: false }); put(facts, "manager", v, page, quote); }
    if (t.rate) put(facts, "pay_rate", moneyVal(one("rate")), page, quote);
    if (t.phone && !isLic) put(facts, "employee_phone", phoneVal(one("phone")), page, quote);
    if (t.email && !isLic) put(facts, "employee_email", emailVal(one("email")), page, quote);
    if (t.department) put(extras, "department", textVal(one("department")), page, quote);
    if (t.econtact) put(extras, "emergency_contact", personVal(one("econtact"), { strong: false }), page, quote);
    if (t.ephone) put(extras, "emergency_phone", phoneVal(one("ephone")), page, quote);
    if (t.role) put(extras, "role", textVal(one("role")), page, quote);
    if (t.availability) put(extras, "availability", textVal(one("availability")), page, quote);
    if (t.reference) put(extras, "reference", personVal(one("reference"), { strong: false }), page, quote);
    if (t.bank) put(extras, "bank", orgVal(one("bank")), page, quote);
    if (t.acct_type) { const a = /^(checking|savings)$/i.exec(collapse(one("acct_type"))); if (a) put(extras, "account_type", titleCase(a[1].toLowerCase()), page, quote); }
    if (t.extra_wh) put(extras, "extra_withholding", moneyVal(one("extra_wh")), page, quote);
    if (kind === "vehreg" && t.year && t.make && t.model) {
      const y = collapse(one("year")); const mk = collapse(one("make")); const md = collapse(one("model"));
      if (/^\d{4}$/.test(y) && mk && md) put(extras, "vehicle", `${y} ${mk} ${md}`, page, quote);
    }
  }
}
