/**
 * Model avoidance, widened (2026-10-09): the "validated Label: value" extractor.
 *
 * textExtract.js's template path accepts a document only when EVERY line is explained, which sends every receipt,
 * statement, purchase order, rent ledger or agreement (they carry prose, line-item tables, unknown labels) to the paid
 * model. This module is the second chance: it reads only CONFIDENTLY LABELLED lines, ignores everything else, and
 * accepts the document only when every field its type requires was found with high confidence. It keeps the same
 * contract as the template path: precision over recall. A refusal is free (the model runs exactly as before); a wrong
 * value is not.
 *
 * The rules, in one place:
 *   1. The document's type comes from a TITLE line (textExtract.classifyLines) and must be a type in GENERIC_TYPES that
 *      is valid for the tenant's industry pack. Field-service paperwork (work orders, service tickets, warranty
 *      registrations, equipment records, permits, inspections, start-up sheets, maintenance agreements) stays on the
 *      template path: its value is in the work and equipment detail this module deliberately does not read.
 *   2. A value is taken only from a label in the synonym table below, and only when it validates for its kind (a date
 *      parses, money is money, a name is a name and not an address or a sentence, an address ends in a ZIP). A
 *      recognised label whose value does NOT validate refuses the document (the model might read it; we must not
 *      silently skip it).
 *   3. Two different values for one field refuse the document. Dates are ranked (explicit service date > the type's
 *      own date label > a bare "Date:"); other date labels (due, ship, expiry, ...) are never read as the document date.
 *   4. Money: the document total is the "Total / Grand total / Amount due / Balance due" family. Two different totals
 *      refuse. A subtotal that does not reconcile with the total (subtotal + tax = total) refuses unless an adjustment
 *      line (shipping, discount, deposit, fee ...) is printed. Line items are never summed and never read as a total.
 *   5. Equipment signals (serial, model no., a brand name, warranty, refrigerant ...) or a labelled work block refuse:
 *      those are facts this module does not extract, and the model would.
 *   6. Required fields: REQUIRED_FIELDS (documentTypes.js) plus the pack's own `requires`, each satisfied only by a
 *      field at confidence >= HIGH_CONFIDENCE. Types that require nothing still need an identity (customer|vendor).
 *
 * Pure. No I/O, no clock.
 */
import { isFragmentName } from "../integrity.js";
import { REQUIRED_FIELDS, DOCUMENT_TYPE_IDS } from "../documentTypes.js";
import { FIELD_KEYS } from "../extractFields.js";
import { FIELD_SYNONYMS, labelSrc } from "./fieldSynonyms.js";
import { detectLetterhead, isOwnName, counterpartyFromParties } from "./ownCompany.js";

export const HIGH_CONFIDENCE = 0.9;

/** Types this path may accept. Everything field-service-shaped stays on the template path. */
export const GENERIC_TYPES = new Set([
  "invoice", "proposal-quote", "purchase-order", "receipt", "agreement", "delivery-ticket", "statement",
  "insurance-certificate", "hr-letter", "schedule", "price-list",
]);

/** Types whose REQUIRED_FIELDS is empty (or only a date) must still name someone. */
const EXTRA_REQUIRED = {
  "hr-letter": ["customer_name|vendor"],
  schedule: ["customer_name|vendor"],
  "price-list": ["customer_name|vendor"],
  statement: ["customer_name|vendor"],
  "insurance-certificate": ["customer_name|vendor"],
};

const collapse = (s) => s.replace(/\s+/g, " ").trim();
const clean = (v) => collapse(String(v ?? "")).replace(/[,;|]+$/g, "").trim();
const normKey = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "");

/* --------------------------------------------------------------------- value validators */
const PHONE_RE = /^(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?$/i;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ADDR_RE = /^\d{1,6}\s+[A-Za-z0-9 .'#-]+?,?\s+[A-Za-z .'-]+,?\s+[A-Z]{2}\.?\s+\d{5}(?:-\d{4})?$/;
const ADDR_LOOSE_RE = /^\d{1,6}\s+\S.*\b[A-Z]{2}\b\s+\d{5}/;
const CITY_ZIP_RE = /^[A-Za-z .'-]+,?\s+[A-Z]{2}\.?\s+\d{5}(?:-\d{4})?$/;
const isAddress = (v) => ADDR_RE.test(v) || (ADDR_LOOSE_RE.test(v) && /\b\d{5}(?:-\d{4})?\.?$/.test(v));
const PLACEHOLDER_RE = /^(?:n\/?a|none|tbd|tba|unassigned|not\s+assigned|pending|unknown|see\s+(?:above|below|attached)|same|on\s+file|signature\s+on\s+file|walk[-\s]?in|cash|cash\s+sale|guest|customer|-+|_+|\?+)\.?$/i;
const STREET_WORD_RE = /\b(?:suite|ste|apt|unit|po\s+box|p\.o\.\s*box)\b/i;
const NAME_CONNECTORS = new Set(["&", "and", "of", "the", "de", "la", "van", "von", "dba", "c/o", "for", "at", "del", "y", "&amp;"]);

/** Money -> signed plain decimal ("1234.56", "-45.00"), or null. Cents are required unless a $ sign is printed. */
export function parseMoney(raw) {
  let s = String(raw ?? "").trim().replace(/\s*(?:USD|usd)\.?$/, "").trim();
  let neg = 0;
  if (/^\(.*\)$/.test(s)) { neg++; s = s.slice(1, -1).trim(); }
  const m = /^(-)?\s*(\$)?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s*(-)?$/.exec(s);
  if (!m) return null;
  neg += (m[1] ? 1 : 0) + (m[3] ? 1 : 0) + (m[6] ? 1 : 0);
  if (neg > 1) return null;
  if (!m[5] && !m[2]) return null; // "1234": a count, a year or a part number as easily as money
  const digits = m[4].replace(/,/g, "");
  if (digits.length > 7) return null;
  return `${neg ? "-" : ""}${digits}${m[5] ? `.${m[5]}` : ""}`;
}
const toCents = (v) => Math.round(Number(v) * 100);

function validName(raw) {
  let v = clean(raw);
  if (/\.$/.test(v) && !/\b(?:inc|co|corp|ltd|llc|llp|lp|jr|sr|l\.l\.c|pllc|p\.c|dr|mr|mrs|ms)\.$/i.test(v)) v = v.replace(/\.+$/, "");
  if (!v) return { skip: true };
  if (PLACEHOLDER_RE.test(v)) return { skip: true };
  if (!/^[A-Za-z][A-Za-z0-9 .,'&\/()+-]{1,70}$/.test(v)) return { bad: true };
  if (/@|:/.test(v) || /\d{3,}/.test(v) || ADDR_LOOSE_RE.test(v) || STREET_WORD_RE.test(v) || PHONE_RE.test(v)) return { bad: true };
  if ((v.match(/[A-Za-z]/g) ?? []).length < 3 || isFragmentName(v)) return { bad: true };
  const toks = v.split(" ");
  if (toks.length > 7) return { bad: true };
  // a name is capitalised words; a lowercase word ("called", "to", "regarding") means this is a sentence, not a name
  if (toks.some((w) => /^[a-z]/.test(w) && !NAME_CONNECTORS.has(w.toLowerCase()))) return { bad: true };
  return { value: v };
}
function validPerson(raw) {
  const r = validName(raw);
  if (r.value && (/\d/.test(r.value) || /\s(?:and|&)\s|[,/]/.test(r.value))) return { bad: true };
  return r;
}
function validId(raw) {
  const v = clean(raw);
  if (!v) return { skip: true };
  return /^[A-Za-z0-9][A-Za-z0-9\-_/.#]{0,29}$/.test(v) && /\d/.test(v) ? { value: v.replace(/^#/, "") } : { bad: true };
}

/* --------------------------------------------------------------------- label synonym table */
const NUM = "(?:\\s*(?:#|no\\.?|number|num\\.?|id))";
const NUMOPT = `${NUM}?`;
// kind: name | person | date | money | id | address | phone | email | term
const L = (field, kind, src, extra = {}) => ({ field, kind, re: new RegExp(`^(?:${src})\\s*:\\s*`, "i"), bare: new RegExp(`^(?:${src})$`, "i"), src, ...extra });

const SERVICE_DATE_SRC = "date\\s+of\\s+service|service\\s+date|date\\s+serviced|date\\s+performed|serviced\\s+on|visit\\s+date|completion\\s+date|date\\s+completed|job\\s+date|svc\\.?\\s*date|d\\.?o\\.?s\\.?";
// Document-date labels. rank: 3 explicit service date, 2 the type's own date label, 1 a generic document date, 0 not a document date here.
const DATE_DEFS = [
  { src: SERVICE_DATE_SRC, rank: () => 3 },
  { src: labelSrc("invoiceDate"), rank: (t) => (t === "invoice" ? 2 : 1) },
  { src: labelSrc("receiptDate"), rank: (t) => (t === "receipt" ? 2 : 1) },
  { src: "p\\.?o\\.?\\s+date|order\\s+date|purchase\\s+order\\s+date|date\\s+ordered", rank: (t) => (t === "purchase-order" ? 2 : 0) },
  { src: labelSrc("statementDate"), rank: (t) => (t === "statement" ? 2 : 1) },
  { src: labelSrc("deliveryDate", "shipDate"), rank: (t) => (t === "delivery-ticket" ? 2 : 0) },
  { src: labelSrc("agreementDate"), rank: (t) => (["agreement", "hr-letter", "price-list"].includes(t) ? 2 : 0) },
  { src: labelSrc("quoteDate"), rank: (t) => (t === "proposal-quote" ? 2 : 1) },
  { src: labelSrc("letterDate"), rank: (t) => (t === "hr-letter" ? 2 : 0) },
  { src: labelSrc("certificateDate"), rank: (t) => (t === "insurance-certificate" ? 2 : 0) },
  { src: "date|dated", rank: () => 1 },
];

const ID_FAMILIES = [
  ["credit", `credit\\s+(?:memo|note)${NUMOPT}`],
  ["invoice", `(?:tax\\s+)?invoice${NUM}|inv${NUM}`],
  ["invoice-bare", "invoice"],
  ["receipt", `receipt${NUMOPT}|${labelSrc(["receipt #", "receipt number", "receipt no"])}`],
  ["transaction", `(?:transaction|trans\\.?|confirmation)${NUM}|${labelSrc(["reference #", "ref #", "reference number", "order #", "order number", "check #", "check number"])}`],
  ["po", `p\\.?o\\.?${NUMOPT}|purchase\\s+order${NUMOPT}`],
  ["statement", `statement${NUM}`],
  ["delivery", `(?:delivery|pick[-\\s]?up|pickup)\\s+(?:ticket|slip|note)?${NUM}|(?:packing\\s+slip|ticket|slip|bol|bill\\s+of\\s+lading)${NUM}`],
  ["quote", `(?:quote|estimate|proposal)${NUM}`],
  ["agreement", `(?:agreement|contract|lease)${NUM}`],
];
const ID_PREFERENCE = {
  invoice: ["invoice", "invoice-bare"], receipt: ["receipt", "transaction", "invoice"], "purchase-order": ["po"],
  statement: ["statement"], "delivery-ticket": ["delivery"], "proposal-quote": ["quote"], agreement: ["agreement"],
};

// money families: T = the document total, B = a bare "balance", S = subtotal, X = tax
const TOTAL_SRC = `${labelSrc("cost")}|total\\s+(?:amount\\s+due|amount|due|owed|payable|charges?|invoice|paid|payment)|amount\\s+(?:due|owed)`;
const PAID_SRC = labelSrc("costPaid");
const BALANCE_SRC = "(?:ending|closing|new|current)\\s+balance|balance";
const SUBTOTAL_SRC = "sub[-\\s]?total";
const TAX_SRC = "(?:(?:sales|state|county|city|local|use)\\s+)?tax(?:es)?(?:\\s*\\(?\\s*\\d+(?:\\.\\d+)?\\s*%\\s*\\)?)?|vat|gst";

const LABELS = [
  L("customer_name", "name", labelSrc("customer"), { tier: 1 }),
  L("customer_name", "name", labelSrc("customerDelivery"), { tier: 2, onlyTypes: ["delivery-ticket"] }),
  L("vendor", "name", labelSrc("vendor", "vendorWeak")),
  L("vendor", "name", labelSrc("insured"), { onlyTypes: ["insurance-certificate"] }),
  L("service_address", "address", "service\\s+(?:address|location)|job\\s+(?:address|site|location)|site\\s+address|property\\s+address|install(?:ation)?\\s+address|work\\s+(?:address|location)|project\\s+address"),
  L("service_address", "address", "property|premises", { lenient: true }),
  L("technician", "person", "technician|tech|serviced\\s+by|performed\\s+by|installer"),
  L("phone", "phone", "customer\\s+phone|phone(?:\\s*(?:#|no\\.?|number))?|tel(?:ephone)?|cell|mobile"),
  L("email", "email", "customer\\s+email|e-?mail(?:\\s+address)?"),
  L("agreement_term", "term", labelSrc("term"), { onlyTypes: ["agreement", "insurance-certificate"] }),
  L("term_end", "termend", labelSrc("termEnd"), { onlyTypes: ["agreement", "insurance-certificate"] }),
  L("money:T", "money", TOTAL_SRC),
  L("money:B", "money", BALANCE_SRC),
  L("money:P", "money", PAID_SRC),
  L("money:S", "money", SUBTOTAL_SRC),
  L("money:X", "money", TAX_SRC, { lenient: true }),
  ...DATE_DEFS.map((d) => L("date", "date", d.src, { rankFn: d.rank })),
  ...ID_FAMILIES.map(([fam, src]) => L("id", "id", src, { family: fam })),
];

// F1: role labels that are safe without a colon (each names exactly one role; the value must still validate).
const NOCOLON_CUSTOMER = ["received from", "payment received from", "paid by", "remitted by", "sold to", "billed to", "bill to", "invoice to"];
const NOCOLON_VENDOR = ["issued by", "sold by", "payable to", "pay to", "remit to", "remittance to", "billed by"];
const NOCOLON_NAME_RE = new RegExp(`^(${labelSrc(NOCOLON_CUSTOMER, NOCOLON_VENDOR)})\\s+(?=[A-Za-z])(.+)$`, "i");
const NOCOLON_VENDOR_RE = new RegExp(`^(?:${labelSrc(NOCOLON_VENDOR)})$`, "i");
const NOCOLON_DATE_RE = new RegExp(`^(${labelSrc("invoiceDate", "receiptDate", "statementDate", "deliveryDate", "agreementDate", "quoteDate", "letterDate", "certificateDate")})\\s+(?=\\S)(.+)$`, "i");
const MONEY_LABELS = LABELS.filter((l) => l.kind === "money");
const ANY_LABEL_AFTER = new RegExp(`(?<=\\s)(?:${LABELS.map((l) => l.src).join("|")})\\s*:`, "gi");

/** Longest label match at the start of `text`: {def, len} or null. */
function matchLabel(text, type) {
  let best = null;
  for (const def of LABELS) {
    if (def.onlyTypes && !def.onlyTypes.includes(type)) continue;
    const m = def.re.exec(text);
    if (m && (!best || m[0].length > best.len)) best = { def, len: m[0].length };
  }
  return best;
}
function matchBareMoneyLabel(text) {
  const t = text.replace(/[:\s]+$/, "");
  let best = null;
  for (const def of MONEY_LABELS) if (def.bare.test(t) && (!best || def.src.length > best.src.length)) best = def;
  return best;
}
const BARE_MONEY_TAIL_RE = new RegExp(`^(${MONEY_LABELS.map((l) => `(?:${l.src})`).join("|")})\\s*[:\\-]?\\s*(\\(?-?\\s?\\$?\\s?-?[\\d,]+(?:\\.\\d{2})?-?\\)?)(?:\\s*USD)?$`, "i");

const WORK_BLOCK_RE = /^(?:work\s+performed|description\s+of\s+work|work\s+(?:description|completed|done)|scope\s+of\s+work|services?\s+performed|repairs?\s+performed|parts\s+(?:used|replaced)|findings|technician\s+notes)\s*:/i;
// An adjustment line: one of these labels immediately followed by an amount ("Shipping: $6.00", "Discount -4.00"). Prose that merely
// starts with the word ("Payment is due within 30 days") is not one.
const ADJUSTMENT_RE = /^(?:shipping(?:\s*(?:&|and)\s*handling)?|freight|delivery(?:\s+fee)?|handling|discounts?|credits?|deposits?|payments?(?:\s+received)?|amount\s+paid|fees?|[A-Za-z]+\s+fees?|surcharge|tip|gratuity|rounding|retainage|balance\s+forward|previous\s+balance|late\s+charges?|adjustments?|prepaid|refunds?|retention)(?:\s*\([^)]*\))?\s*[:\-]?\s*[-(]?\$?\s?\d/i;
const EQUIP_SIGNAL_RE = /\b(?:serial\s*(?:#|no\.?|number)?|s\/n|model\s*(?:#|no\.?|number)|mfr|mfg|manufacturer|nameplate|data\s+plate|refrigerant|tonnage|btuh?|seer2?|warrant(?:y|ies|ed)|permit\s*(?:#|no\.?|number)|r-?(?:410a|22|454b|32))\b/i;

const segmentsOf = (t) => t.split(/\s{3,}|\t+|\s\|\s/).map((x) => x.trim()).filter(Boolean);

/**
 * @param {{lines: {t:string,page:number}[], cls: {type:string,confidence:number,evidence:string}, pack?: object|null,
 *          parseDate: (v:string)=>string|null, brandRe: RegExp, skipInstallGuard?: boolean, pageCount: number}} ctx
 * @returns {{accepted:true, type:string, toolInput:object, coverage:object, docDate:string|null, workItems:string[], variant:string|null}
 *          |{accepted:false, reason:string, type:string|null}}
 */
export function extractLabelled(ctx) {
  const { lines, cls, pack, parseDate, brandRe } = ctx;
  const ownNames = Array.isArray(ctx.ownNames) ? ctx.ownNames : [];
  const type = cls.type;
  const reject = (reason) => ({ accepted: false, reason: `generic:${reason}`, type });

  if (!GENERIC_TYPES.has(type)) return reject("type-not-generic");
  const trade = !!pack && pack.id !== "hvac";
  const validTypes = trade ? new Set((pack.documentTypes ?? []).map((t) => t.id)) : DOCUMENT_TYPE_IDS;
  if (!validTypes.has(type)) return reject("type-not-in-pack");
  const allowedKeys = trade ? new Set((pack.fields ?? []).map((f) => f.key)) : new Set(FIELD_KEYS);
  if (lines.length > 400) return reject("too-many-lines");
  if (lines.reduce((n, l) => n + l.t.length, 0) > 30000) return reject("too-long");

  const full = lines.map((l) => l.t).join("\n");
  // A second document of the same type in the same file (a bundle): values could belong to either.
  const evid = collapse(cls.evidence ?? "").replace(/[:.]+$/, "").toLowerCase();
  const titleHits = lines.filter((l) => l.t.length <= 60 && collapse(l.t).replace(/[:.]+$/, "").toLowerCase() === evid).length;
  if (titleHits > Math.max(1, ctx.pageCount)) return reject("multiple-documents");
  if (EQUIP_SIGNAL_RE.test(full) || brandRe.test(full)) return reject("equipment-signal");
  if (["invoice", "proposal-quote", "purchase-order"].includes(type) && lines.some((l) => WORK_BLOCK_RE.test(l.t))) return reject("work-block");
  if (!ctx.skipInstallGuard && ["invoice", "proposal-quote"].includes(type) && /\binstall(?:ed|ation|ing)?\b/i.test(full)) return reject("install-needs-judgement");

  const cand = new Map(); // key -> [{value, conf, line, ...}]
  const push = (key, c) => { (cand.get(key) ?? cand.set(key, []).get(key)).push(c); };
  let invalid = null;
  const bad = (key) => { invalid ??= key; };
  let firstCustomerLine = Infinity;
  const termEnds = [];
  const adjustments = lines.some((l) => ADJUSTMENT_RE.test(l.t));

  const take = (def, rawValue, line, i, conf, nextLineUsed = false) => {
    const v = clean(rawValue);
    switch (def.kind) {
      case "name": case "person": {
        const r = def.kind === "name" ? validName(v) : validPerson(v);
        if (r.bad) { bad(def.field); return; }
        if (r.value) {
          if (def.field === "customer_name") firstCustomerLine = Math.min(firstCustomerLine, i);
          push(def.field, { value: r.value, conf: def.tier === 2 ? Math.min(conf, 0.9) : conf, line, tier: def.tier ?? 1 });
        }
        return;
      }
      case "date": {
        if (!v) return;
        const rank = def.rankFn(type);
        if (rank <= 0) return;
        const d = parseDate(v);
        if (!d || d.length !== 10) { bad("service_date"); return; }
        push("service_date", { value: d, conf, line, rank });
        return;
      }
      case "money": {
        if (!v) return;
        const m = parseMoney(v);
        if (m === null) { if (!(def.lenient && /^(?:exempt|n\/?a|none|-+|incl(?:uded)?\.?|included)$/i.test(v))) bad(def.field); return; }
        push(def.field, { value: m, conf, line });
        return;
      }
      case "id": {
        const r = validId(v);
        if (r.bad) { if (def.family !== "invoice-bare") bad("invoice_number"); return; }
        if (r.value) push("invoice_number", { value: r.value, conf, line, family: def.family });
        return;
      }
      case "address": {
        let a = v;
        if (!a) return;
        if (!isAddress(a) && !nextLineUsed && i + 1 < lines.length && CITY_ZIP_RE.test(lines[i + 1].t) && /^\d{1,6}\s/.test(a)) a = `${a}, ${clean(lines[i + 1].t)}`;
        if (!isAddress(a)) { if (!def.lenient) bad("service_address"); return; }
        push("service_address", { value: a.replace(/[,;]+$/, ""), conf, line });
        return;
      }
      case "phone": if (!v) return; if (!PHONE_RE.test(v)) { bad("customer_phone"); return; } push("customer_phone", { value: v, conf: 0.9, line, idx: i }); return;
      case "email": if (!v) return; if (!EMAIL_RE.test(v)) { bad("customer_email"); return; } push("customer_email", { value: v, conf: 0.9, line, idx: i }); return;
      case "termend": {
        if (!v) return;
        const de = parseDate(v);
        if (de && de.length === 10) termEnds.push({ raw: v, iso: de, line });
        return;
      }
      case "term": {
        if (!v) return;
        if (v.length > 90 || !/\d/.test(v)) { bad("agreement_term"); return; }
        push("agreement_term", { value: v, conf, line });
        return;
      }
      default:
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const segs = segmentsOf(line.t);
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      // 1) "Total $110.00" / "Subtotal: $100.00" in one segment
      const bm = BARE_MONEY_TAIL_RE.exec(seg);
      if (bm) {
        const def = matchBareMoneyLabel(bm[1]);
        const m = def ? parseMoney(bm[2]) : null;
        if (def && m !== null) { push(def.field, { value: m, conf: 0.95, line }); continue; }
      }
      const lm = matchLabel(seg, type);
      // 2) "Total" and "$110.00" as two cells
      if (!lm && s + 1 < segs.length) {
        const def = matchBareMoneyLabel(seg);
        const m = def ? parseMoney(segs[s + 1]) : null;
        if (def && m !== null) { push(def.field, { value: m, conf: 0.95, line }); s++; continue; }
      }
      if (!lm) {
        // F1: a role label printed WITHOUT a colon: "RECEIVED FROM Martin Duarte", "Date Received Aug 29, 2025". Only phrases that
        // name one role, and only when what follows validates; anything else is simply not read (never a rejection).
        const nc = NOCOLON_NAME_RE.exec(seg);
        if (nc) {
          const r = validName(nc[2]);
          if (r.value) {
            const isVendor = NOCOLON_VENDOR_RE.test(nc[1]);
            push(isVendor ? "vendor" : "customer_name", { value: r.value, conf: 0.9, line, tier: 1 });
            if (!isVendor) firstCustomerLine = Math.min(firstCustomerLine, i);
          }
          continue;
        }
        const nd = NOCOLON_DATE_RE.exec(seg);
        if (nd) {
          const def = DATE_DEFS.find((d) => new RegExp(`^(?:${d.src})$`, "i").test(nd[1]));
          const rank = def ? def.rank(type) : 0;
          const d = rank > 0 ? parseDate(clean(nd[2])) : null;
          if (d && d.length === 10) push("service_date", { value: d, conf: 0.9, line, rank });
        }
        continue;
      }
      // PO: the bill-to / ship-to on a purchase order is the company itself, never a customer.
      const skipCustomer = type === "purchase-order" && lm.def.field === "customer_name" && !/^(?:customer|client)/i.test(seg);
      let value = seg.slice(lm.len);
      // cut at a second label sharing the segment ("Invoice #: 12 Date: 10/02/2026")
      ANY_LABEL_AFTER.lastIndex = 0;
      for (let am; (am = ANY_LABEL_AFTER.exec(value)); ) {
        const head = value.slice(0, am.index).trim();
        const k = lm.def.kind;
        const probe = head && (k === "money" ? parseMoney(head) !== null : k === "date" ? !!parseDate(head) : k === "id" ? !validId(head).bad : k === "name" ? !!validName(head).value : k === "address" ? isAddress(head) : false);
        if (probe) { segs.splice(s + 1, 0, value.slice(am.index).trim()); value = head; break; }
      }
      let conf = 0.95;
      if (!clean(value)) {
        if (s + 1 < segs.length) {
          const nxt = segs[s + 1];
          if (matchLabel(nxt, type) || matchBareMoneyLabel(nxt)) {
            if (lm.def.kind === "name") bad(lm.def.field); // two empty label cells side by side: columns we cannot pair safely
            continue;
          }
          value = nxt; s++;
        } else if (["name", "address", "date", "person"].includes(lm.def.kind) && i + 1 < lines.length && !matchLabel(lines[i + 1].t, type) && !matchBareMoneyLabel(lines[i + 1].t)) {
          // label on one line, value on the next (a "Bill To:" block): only the first line of the block is the value
          conf = 0.9;
          if (skipCustomer) continue;
          take(lm.def, lines[i + 1].t, lines[i + 1], i + 1, conf, lm.def.kind === "address" ? false : true);
          continue;
        } else continue; // blank form field: nothing printed, nothing to read
      }
      if (skipCustomer) continue;
      take(lm.def, value, line, i, conf);
    }
  }
  if (invalid) return reject(`bad-value:${invalid}`);

  // F1: our own company. A bill / receipt addressed TO us does not make us the customer, and we are not the vendor of it.
  let addressedToUs = false;
  if (ownNames.length) {
    for (const k of ["customer_name", "vendor"]) {
      const list = cand.get(k);
      if (!list) continue;
      const rest = list.filter((c) => !isOwnName(c.value, ownNames));
      if (k === "customer_name" && rest.length < list.length) addressedToUs = true;
      if (rest.length) cand.set(k, rest); else cand.delete(k);
    }
    // "Parties: A and B" / "Between A and B": when exactly one of the two is us, the other is the counterparty.
    if (!cand.has("customer_name") && ["agreement", "hr-letter"].includes(type)) {
      for (let i = 0; i < lines.length; i++) {
        const other = counterpartyFromParties(lines[i].t, ownNames);
        const r = other ? validName(other) : null;
        if (r?.value) { push("customer_name", { value: r.value, conf: 0.9, line: lines[i], tier: 1 }); break; }
      }
    }
    // The business at the top of the page is the ISSUER (the vendor) when it is not us and no other party is named. When a
    // customer IS named, that letterhead is almost always our own paperwork under a name variant we cannot know: not used.
    if (!cand.has("vendor") && !cand.has("customer_name") && type !== "purchase-order") {
      const lh = detectLetterhead(lines.map((l) => l.t), {
        ownNames,
        isTitleLine: (t) => collapse(t).replace(/[:.]+$/, "").toLowerCase() === evid,
        isLabelLine: (t) => !!matchLabel(t, type) || !!matchBareMoneyLabel(t),
      });
      if (lh && !lh.own) push("vendor", { value: lh.name, conf: lh.conf, line: lines[lh.index], tier: 1 });
    }
  }

  /* ----------------------------------------------------------------- resolve each field to ONE value */
  const out = [];
  const addOut = (key, value, c, conf = c.conf) => { if (allowedKeys.has(key)) out.push({ key, value, line: c.line, conf }); };
  const single = (list, eq = (a, b) => a === b) => (list.every((c) => eq(c.value, list[0].value)) ? list[0] : null);
  const nameEq = (a, b) => normKey(a) === normKey(b);

  for (const key of ["customer_name", "vendor", "technician"]) {
    const list = cand.get(key);
    if (!list?.length) continue;
    const top = Math.min(...list.map((c) => c.tier ?? 1));
    const one = single(list.filter((c) => (c.tier ?? 1) === top), nameEq);
    if (!one) return reject(`conflict:${key}`);
    addOut(key, one.value, one);
  }
  if (cand.has("service_address")) {
    const one = single(cand.get("service_address"), nameEq);
    if (!one) return reject("conflict:service_address");
    addOut("service_address", one.value, one);
  }
  let docDate = null;
  if (cand.has("service_date")) {
    const list = cand.get("service_date");
    const top = Math.max(...list.map((c) => c.rank));
    const one = single(list.filter((c) => c.rank === top));
    if (!one) return reject("conflict:service_date");
    addOut("service_date", one.value, one, top >= 2 ? 0.95 : 0.9);
    docDate = one.value;
  }
  if (cand.has("invoice_number")) {
    const pref = type === "invoice" && /credit/i.test(cls.evidence ?? "") ? ["credit", ...ID_PREFERENCE.invoice] : (ID_PREFERENCE[type] ?? []);
    const fam = pref.find((f) => cand.get("invoice_number").some((c) => c.family === f));
    if (fam) {
      const one = single(cand.get("invoice_number").filter((c) => c.family === fam), (a, b) => a.toLowerCase() === b.toLowerCase());
      if (!one) return reject("conflict:invoice_number");
      addOut("invoice_number", one.value, one);
    }
  }
  // a number printed in the title itself ("Purchase Order No. 5521", "Invoice #4410") when no number label was read
  if (!cand.has("invoice_number")) {
    const tm = /(?:#|\bno\.?|\bnumber)\s*([A-Za-z0-9][A-Za-z0-9\-_/.]{0,29})$/i.exec(clean(cls.evidence ?? ""));
    if (tm && /\d/.test(tm[1])) addOut("invoice_number", tm[1], { line: lines.find((l) => l.t.includes(cls.evidence)) ?? lines[0] }, 0.9);
  }
  for (const k of ["customer_phone", "customer_email"]) {
    const list = cand.get(k);
    if (!list?.length) continue;
    const one = single(list, (a, b) => a.toLowerCase() === b.toLowerCase());
    if (!one) return reject(`conflict:${k}`);
    if (list[0].idx > firstCustomerLine) addOut(k, one.value, one, 0.9);
  }
  if (!cand.has("agreement_term") && termEnds.length && (type === "agreement" || type === "insurance-certificate")) {
    // "Effective Date: X" + "End Date / Expiration Date: Y" = the period X - Y
    const sD = (cand.get("service_date") ?? []).filter((c) => c.rank >= 2);
    const eU = [...new Set(termEnds.map((x) => x.iso))];
    if (sD.length && new Set(sD.map((c) => c.value)).size === 1 && eU.length === 1) {
      const sLine = sD[0].line, eLine = termEnds[0].line;
      const sRaw = (sLine.t.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/) ?? [])[1];
      const eRaw = termEnds[0].raw;
      if (sRaw) cand.set("agreement_term", [{ value: `${sRaw} - ${eRaw}`, conf: 0.9, line: eLine }]);
    }
  }
  if (cand.has("agreement_term")) {
    const one = single(cand.get("agreement_term"), nameEq);
    if (!one) return reject("conflict:agreement_term");
    addOut("agreement_term", one.value, one);
  }

  // money
  const T = cand.get("money:T") ?? [];
  const B = cand.get("money:B") ?? [];
  const P = cand.get("money:P") ?? [];
  const S = cand.get("money:S") ?? [];
  const X = cand.get("money:X") ?? [];
  let total = null;
  if (T.length) {
    total = single(T);
    if (!total) return reject("ambiguous-total");
  } else if (P.length) {
    // no total printed: the amount paid / received / donated IS the document's amount (a donation or rent receipt)
    total = single(P);
    if (!total) return reject("ambiguous-paid");
    if (S.length || X.length) return reject("paid-without-total");
    total = { ...total, conf: 0.9 };
  } else if (B.length) {
    total = single(B);
    if (!total) return reject("ambiguous-balance");
    total = { ...total, conf: 0.9 };
  } else if (S.length || X.length) {
    return reject("subtotal-without-total");
  }
  if (total) {
    let conf = Math.min(total.conf, 0.95);
    if (S.length) {
      const sub = single(S);
      if (!sub) return reject("ambiguous-subtotal");
      const tax = X.reduce((n, c) => n + toCents(c.value), 0);
      if (toCents(sub.value) + tax === toCents(total.value)) conf = Math.min(conf, 0.95);
      else if (adjustments) conf = Math.min(conf, 0.9);
      else return reject("total-does-not-reconcile");
    }
    addOut("cost", total.value, total, conf);
  }

  /* ----------------------------------------------------------------- acceptance */
  const emitted = new Map();
  for (const f of out) emitted.set(f.key, Math.max(emitted.get(f.key) ?? 0, f.conf));
  const requirements = new Set([...(REQUIRED_FIELDS[type] ?? []), ...(EXTRA_REQUIRED[type] ?? [])]);
  if (trade) for (const r of pack.documentTypes.find((t) => t.id === type)?.requires ?? []) requirements.add(r);
  const missing = [...requirements].filter((r) => !r.split("|").some((k) => (emitted.get(k) ?? 0) >= HIGH_CONFIDENCE));
  if (missing.length) return reject(`missing-required:${missing.join(",")}`);
  if (![...emitted.values()].some((c) => c >= HIGH_CONFIDENCE)) return reject("nothing-confident");

  const fields = out.map((f) => ({ key: f.key, value: f.value, page_no: f.line.page, verbatim: f.line.t.slice(0, 200), confidence: f.conf }));
  return {
    accepted: true,
    type,
    toolInput: { document_type: type, document_type_confidence: cls.confidence, fields },
    coverage: { lines: lines.length, fields: fields.length, path: "labelled" },
    docDate: type === "invoice" ? docDate : null,
    workItems: [],
    variant: type === "invoice" && /credit/i.test(cls.evidence ?? "") ? "credit_memo" : null,
  };
}
