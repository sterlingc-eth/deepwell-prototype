/**
 * AI finish, rev2 (2026-10-26): bind every answer to the printed LABEL of the field it fills.
 *
 * Rev1 kept a value whenever its quote was on the page and the value was inside the quote. That let a model store the wrong thing
 * with a real quote: "Warranty expires 03/04/2031" as the service date, "Date of birth 02/02/1980", a bare date out of
 * "Printed 03/04/2026", a footer date, a day/month swap, a vendor's "Remit payment to: ... 12 Oak Ln" as the service address.
 *
 * A value is kept here only when ALL of these hold (otherwise the field stays blank, which is always safe):
 *   1. the quote is found on the page and the value sits in it at a place we can locate;
 *   2. the text right before the value on its line (or, for a value on its own line, the whole line above) ends with a label from
 *      the shared vocabulary (fieldSynonyms.js, the table the deterministic readers use) that names THIS field. A bare value, an
 *      unknown label ("Printed", "Terms revised") or another field's label ("Warranty expires", "Date of birth") fails;
 *   3. a date is re-read from the page's own characters in the page's own locale and must equal the model's value. A numeric date
 *      whose day and month could be swapped (03/04/2026) is accepted only when the document itself shows its order (another date on
 *      it with a part above 12); otherwise it is ambiguous and dropped. No swapped reading is ever tried;
 *   4. the value passes a per-field type check (money, document number, serial, phone, e-mail, address with a street number ...);
 *   5. address / phone / e-mail values are not from the issuer's letterhead or footer (bodyNameLink.splitPartyZones, the zone
 *      splitter the strong-evidence link uses) and not on a "remit / pay to / mail to" line; a vendor is not a customer-zone name.
 *
 * Pure: no database, no model.
 */
import { labelSrc } from "./modelAvoidance/fieldSynonyms.js";
import { splitPartyZones } from "./bodyNameLink.js";

const SEP = String.raw`\s*[:#.=$\-–—]*\s*`;
const re = (src) => new RegExp(`(?:^|[^a-z0-9])(?:${src})${SEP}$`, "i");
const reLine = (src) => new RegExp(`^\\s*(?:${src})${SEP}$`, "i");

const SERIAL = "serial\\s*(?:number|no\\.?|num\\.?|#)?|s\\/n|ser\\.?\\s*(?:no\\.?|#)";
const MODEL = "model\\s*(?:number|no\\.?|num\\.?|#)?|m\\/n|mod\\.?\\s*(?:no\\.?|#)";
const PERMIT = "permit\\s*(?:number|no\\.?|num\\.?|#)|permit";
const ADDRESS = "service\\s+(?:address|location)|job\\s*(?:address|site|location)|site\\s+address|property\\s+address|install(?:ation)?\\s+address|work\\s+(?:address|location)|project\\s+address|address\\s+of\\s+(?:service|work|job)";
const PHONE = "phone(?:\\s*(?:number|no\\.?|#))?|tel(?:ephone)?(?:\\s*(?:number|no\\.?|#))?|mobile|cell(?:\\s*phone)?";
const EMAIL = "e-?mail(?:\\s*address)?";
const WARRANTY_END = "warranty\\s+(?:expires|expiration(?:\\s+date)?|expiry(?:\\s+date)?|end(?:s)?(?:\\s+date)?|through|until|valid\\s+(?:through|until)|term\\s+ends?)";

/** field -> the labels that name it (and only it). Keys without an entry are never accepted from the model. */
const SRC = {
  service_date: labelSrc("serviceDate"),
  cost: labelSrc("cost", "costPaid"),
  invoice_number: labelSrc("documentNumber"),
  vendor: labelSrc("vendor"),
  agreement_term: labelSrc("term"),
  service_address: ADDRESS,
  serial_number: SERIAL,
  model: MODEL,
  permit_number: PERMIT,
  customer_phone: PHONE,
  customer_email: EMAIL,
  warranty_expires: WARRANTY_END,
};
const LABEL = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, { tail: re(v), line: reLine(v) }]));

const DATE_KEYS = new Set(["service_date", "warranty_expires"]);
const ZONE_KEYS = new Set(["service_address", "vendor", "customer_phone", "customer_email"]);
const REMIT_LINE = /\b(?:remit(?:tance)?|pay(?:ment)?s?\s+(?:to|by)|pay\s+to|payable\s+to|make\s+checks?|mail\s+(?:to|payment)|send\s+payment|p\.?\s?o\.?\s*box|lockbox)/i;
/** Sensitive data is never stored OR suggested, whatever the field: date of birth, SSN / tax id, bank account / routing / card numbers, driver's licence / ID numbers. */
const SENSITIVE_LINE = /\b(?:date\s+of\s+birth|d\.?\s?o\.?\s?b\b\.?|birth\s*(?:date|day)|born|ssn|s\.s\.n|social\s+security|tax\s*(?:id|payer)|taxpayer|ein\b|routing|aba\b|account\s*(?:number|no\b|#)|acct\b|iban|swift|card\s*(?:number|no\b|#)|credit\s+card|debit\s+card|cvv|driver'?s?\s+licen[sc]e|dl\s*(?:number|no\b|#)|licen[sc]e\s*(?:number|no\b|#)|passport|id\s*(?:number|no\b|#)|identification)/i;
const SENSITIVE_VALUE = /\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]?){13,19}\b|(?<![\d.,])\d{9}(?![\d.,])/;
/** A footer / boilerplate line: a suggestion is never made from one. */
const FOOTER_LINE = /(?:\bcopyright\b|\u00a9|all\s+rights\s+reserved|\brev(?:ised|ision|\.)?\b|\bprinted\b|\bpage\s+\d+\s+of\s+\d+|\bterms\b|\bform\s+(?:no|#)|\bversion\b|last\s+updated|\bgenerated\b|powered\s+by)/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = "jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec";

const squash = (s) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find the quote's first occurrence in the page text, whitespace and smart quotes tolerant. Index and length are into the RAW text. */
function locate(text, quote) {
  const first = String(quote ?? "").split("…")[0].trim();
  if (first.length < 3) return null;
  const src = first.split(/\s+/).map((t) => escRe(t).replace(/['‘’]/g, "['‘’]").replace(/["“”]/g, '["“”]')).join("\\s+");
  const m = new RegExp(src, "i").exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

/** The order the document itself uses for numeric dates: "dmy", "mdy", "mixed" (contradicts itself) or null (no evidence). */
export function pageDateOrder(pages) {
  let dmy = false, mdy = false;
  for (const p of pages ?? []) {
    for (const m of String(p.text ?? "").matchAll(/(?<!\d)(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?!\d)/g)) {
      const a = +m[1], b = +m[2];
      if (a > 12 && b <= 12) dmy = true;
      if (b > 12 && a <= 12) mdy = true;
    }
  }
  return dmy && mdy ? "mixed" : dmy ? "dmy" : mdy ? "mdy" : null;
}

const iso = (y, m, d) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};

/** First date in `s`, read in the page's locale: {iso}, {ambiguous:true} or null. Two-digit years are never read; a swap is never tried. */
export function readDate(s, order) {
  const t = String(s ?? "");
  let m = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(t);
  if (m) { const v = iso(+m[1], +m[2], +m[3]); return v ? { iso: v } : null; }
  m = /(?<!\d)(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?!\d)/.exec(t);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    let v;
    if (a === b) v = iso(y, a, b);
    else if (a > 12 && b <= 12) v = iso(y, b, a);
    else if (b > 12 && a <= 12) v = iso(y, a, b);
    else if (a > 12 && b > 12) v = null;
    else if (order === "dmy") v = iso(y, b, a);
    else if (order === "mdy") v = iso(y, a, b);
    else return { ambiguous: true };
    return v ? { iso: v } : null;
  }
  m = new RegExp(`\\b(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i").exec(t);
  if (m) { const v = iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]); return v ? { iso: v } : null; }
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})[a-z]*\\.?,?\\s+(\\d{4})\\b`, "i").exec(t);
  if (m) { const v = iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]); return v ? { iso: v } : null; }
  return null;
}

const DATE_TOKEN = new RegExp(`(?<!\\d)\\d{4}-\\d{2}-\\d{2}(?!\\d)|(?<!\\d)\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}(?!\\d)|\\b(?:${MON})[a-z]*\\.?\\s+\\d{1,2}|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MON})`, "i");

/** Where does the value start inside the matched quote text? A date: the first date token. Otherwise the value text itself. */
function valueStart(key, f, rawQuote) {
  if (DATE_KEYS.has(key)) return DATE_TOKEN.exec(rawQuote)?.index ?? -1;
  const v = String(f.value ?? "").trim();
  if (!v) return -1;
  return new RegExp(v.split(/\s+/).map(escRe).join("\\s+"), "i").exec(rawQuote)?.index ?? -1;
}

/** The label context: the text on the value's line before the value; when that is empty, the whole previous non-empty line. */
function labelContext(text, abs) {
  const lineStart = text.lastIndexOf("\n", abs - 1) + 1;
  const left = text.slice(lineStart, abs);
  if (left.replace(/[\s:|\-–—.]/g, "") !== "") return { left, prevLine: false };
  let end = lineStart - 1;
  while (end > 0) {
    const s = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(s, end);
    if (line.trim()) return { left: line, prevLine: true };
    end = s - 1;
  }
  return { left: "", prevLine: false };
}

function typeCheck(key, value, token) {
  const v = String(value ?? "").trim();
  switch (key) {
    case "cost": {
      const n = Number(v.replace(/[$,\s]/g, ""));
      const m = /\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(token);
      return Number.isFinite(n) && n > 0 && n < 10_000_000 && !!m && Math.abs(Number(m[1].replace(/,/g, "")) - n) < 0.005 ? null : "bad-money";
    }
    case "invoice_number": return /^[A-Za-z0-9][A-Za-z0-9\-\/]{1,24}$/.test(v) && /\d/.test(v) ? null : "bad-number";
    case "serial_number": return /^[A-Za-z0-9][A-Za-z0-9\-\/.]{3,29}$/.test(v) && /\d/.test(v) ? null : "bad-serial";
    case "model": return /^[A-Za-z0-9][A-Za-z0-9\-\/. ]{1,29}$/.test(v) && /\d/.test(v) ? null : "bad-model";
    case "permit_number": return /^[A-Za-z0-9][A-Za-z0-9\-\/]{3,24}$/.test(v) && /\d/.test(v) ? null : "bad-permit";
    case "customer_email": return /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/.test(v) ? null : "bad-email";
    case "customer_phone": { const d = v.replace(/\D/g, ""); return /^[\d\s().+\-x]+$/i.test(v) && d.length >= 7 && d.length <= 15 ? null : "bad-phone"; }
    case "service_address": return /\d/.test(v) && /[A-Za-z]{3}/.test(v) && v.length >= 8 && v.length <= 160 && !/^\s*p\.?\s?o\.?\s*box/i.test(v) ? null : "bad-address";
    case "vendor": return v.length >= 2 && v.length <= 90 && !/^\d/.test(v) && !/@|https?:|www\./i.test(v) ? null : "bad-vendor";
    case "agreement_term": return v.length >= 3 && v.length <= 120 ? null : "bad-term";
    default: return "no-label-vocabulary";
  }
}

const rank = (r) => (r.ok ? 3 : r.soft ? 2 : 1);

/**
 * Judge one grounded field (rev3: three outcomes).
 *   {ok:true, value}                      every check passed: the value may be stored as a fact.
 *   {ok:false, soft:true, value, options?, reason, quote}  the quote is real and the value is readable and type-correct, but it failed ONLY the
 *        label binding or the issuer-zone check (or a numeric date is ambiguous under its own correct label): never stored as a fact, offered to a
 *        person as "Suggested: <value>" (aiFinishSuggest.js). `options` lists the readings of an ambiguous date.
 *   {ok:false, reason}                    thrown away.
 * @param {{field_key:string, value:string, verbatim:string, page_no?:number}} f
 * @param {{page_no:number,text:string}[]} pages
 * @param {{zones?:object}} [opts]
 */
export function bindFieldToLabel(f, pages, opts = {}) {
  const key = String(f.field_key ?? "").replace(/_unconfirmed$/, "");
  const def = LABEL[key];
  if (!def) return { ok: false, reason: "no-label-vocabulary" };
  const quote = String(f.verbatim ?? "");
  const list = (pages ?? []).filter((p) => !f.page_no || Number(p.page_no) === Number(f.page_no));
  let best = null;
  const keep = (r) => { if (!best || rank(r) > rank(best)) best = r; };
  for (const p of list.length ? list : pages ?? []) {
    const text = String(p.text ?? "");
    const at = locate(text, quote);
    if (!at) continue;
    const rawQuote = text.slice(at.index, at.index + at.length);
    const vs = valueStart(key, f, rawQuote);
    if (vs < 0) { keep({ ok: false, reason: "value-not-in-quote" }); continue; }
    const abs = at.index + vs;
    const ctx = labelContext(text, abs);
    const labelOk = (ctx.prevLine ? def.line : def.tail).test(ctx.left);
    const lineStart = text.lastIndexOf("\n", abs - 1) + 1;
    let lineEnd = text.indexOf("\n", abs); if (lineEnd < 0) lineEnd = text.length;
    // Sensitive data: dropped outright (not even a suggestion), whichever field the model said it was.
    const lineTxt = text.slice(lineStart, lineEnd);
    if (SENSITIVE_LINE.test(lineTxt) || (ctx.prevLine && SENSITIVE_LINE.test(ctx.left)) || SENSITIVE_LINE.test(rawQuote) || (key !== "cost" && SENSITIVE_VALUE.test(rawQuote.slice(vs)) && !DATE_KEYS.has(key))) { keep({ ok: false, reason: "sensitive" }); continue; }
    // A footer / boilerplate line, or the last lines of the page, is never the source of a suggestion (a labelled fact may still sit there).
    const allLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const inFooter = FOOTER_LINE.test(lineTxt) || (allLines.length >= 8 && allLines.slice(-2).includes(lineTxt.trim()));
    const soft0 = (reason, extra = {}) => ({ ok: false, soft: true, reason, quote: rawQuote.trim(), page_no: p.page_no, value: String(f.value).trim(), ...extra });
    const soft = (reason, extra = {}) => (inFooter ? { ok: false, reason: "footer" } : soft0(reason, extra));
    if (!DATE_KEYS.has(key) && REMIT_LINE.test(text.slice(lineStart, lineEnd))) { keep({ ok: false, reason: "remit-or-payment-line" }); continue; }

    if (DATE_KEYS.has(key)) {
      const order = pageDateOrder(pages);
      const got = readDate(rawQuote.slice(vs), order);
      if (!got) { keep({ ok: false, reason: "date-unreadable" }); continue; }
      if (got.ambiguous) {
        // 03/04/2026 with no sign of the document's order: a person picks. Only under the field's own label, and only if the model read it as one of the two.
        const m = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/.exec(rawQuote.slice(vs));
        const mdy = iso(+m[3], +m[1], +m[2]), dmy = iso(+m[3], +m[2], +m[1]);
        const model = String(f.value ?? "").trim();
        if (labelOk && mdy && dmy && (model === mdy || model === dmy)) keep(soft("ambiguous-date-order", { options: [mdy, dmy], value: undefined }));
        else keep({ ok: false, reason: "ambiguous-date-order" });
        continue;
      }
      if (got.iso !== String(f.value ?? "").trim()) { keep({ ok: false, reason: "date-differs-from-page" }); continue; }
      keep(labelOk ? { ok: true, value: got.iso } : soft("no-matching-label", { value: got.iso }));
      continue;
    }

    const bad = typeCheck(key, f.value, rawQuote.slice(vs));
    if (bad) { keep({ ok: false, reason: bad }); continue; }
    let zoneBad = false;
    if (ZONE_KEYS.has(key)) {
      const zones = opts.zones ?? splitPartyZones(pages ?? []);
      const nv = squash(f.value);
      const inVendor = (zones.vendor ?? []).some((z) => squash(z).includes(nv));
      const inCustomer = (zones.customer ?? []).some((z) => squash(z).includes(nv));
      zoneBad = key === "vendor" ? inCustomer && !inVendor : inVendor;
    }
    if (zoneBad) keep(soft("issuer-zone"));
    else if (!labelOk) keep(soft("no-matching-label"));
    else keep({ ok: true, value: String(f.value).trim() });
  }
  return best ?? { ok: false, reason: "quote-not-located" };
}

/** Fields this pass can ever accept or suggest (the ones with a label vocabulary and a type check). Nothing else is worth a model call. */
export const BINDABLE_KEYS = new Set(Object.keys(LABEL));

const NO_COST_TYPES = new Set(["permit", "nameplate-photo", "warranty-registration", "equipment-record", "startup-sheet", "inspection-report", "hr-letter", "license-certification"]);
const CUES = {
  service_date: (t) => new RegExp(DATE_TOKEN.source, "i").test(t),
  warranty_expires: (t) => /warrant/i.test(t) && new RegExp(DATE_TOKEN.source, "i").test(t),
  cost: (t) => /\$\s?\d|\b\d{1,3}(?:,\d{3})*\.\d{2}\b/.test(t),
  invoice_number: (t) => /(?:#|\bno\.?|\bnumber)\s*[:.]?\s*[A-Za-z]{0,4}-?\d{2,}/i.test(t),
  service_address: (t) => /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:st|street|ave|avenue|rd|road|ln|lane|dr|drive|ct|court|blvd|boulevard|way|pl|place|cir|circle|hwy|highway|pkwy|parkway|ter|terrace|trl|trail)\b/i.test(t),
  serial_number: (t) => /serial|s\/n\b/i.test(t),
  model: (t) => /\bmodel|\bm\/n\b/i.test(t),
  permit_number: (t) => /permit/i.test(t) && /\d{3,}/.test(t),
  customer_phone: (t) => /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(t),
  customer_email: (t) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t),
  vendor: (t) => t.trim().length > 20,
  agreement_term: (t) => /\b(?:term|period|months?|years?)\b/i.test(t),
};

/**
 * COST GUARD (rev3): of the missing fields, keep only those this pass could ever accept (label vocabulary) AND whose cue is on the page at all
 * (no money figure on the page: no cost; no street-like text: no service address; cost on a permit: never). An empty answer means the paper is
 * not sent to the model for fields.
 * @returns {Set<string>}
 */
export function plausibleKeys(keys, { type = null, pages = [] } = {}) {
  const text = (pages ?? []).map((p) => String(p.text ?? "")).join("\n");
  const out = new Set();
  for (const k of keys ?? []) {
    if (!BINDABLE_KEYS.has(k) || !CUES[k]) continue;
    if (k === "cost" && NO_COST_TYPES.has(type)) continue;
    if (CUES[k](text)) out.add(k);
  }
  return out;
}
