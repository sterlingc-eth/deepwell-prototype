/**
 * R33 (2026-09-30): "a printed, clearly labelled field must never become missing".
 *
 * THE DEFECT: Sonoran Comfort Air's "118-service-ticket-c23.pdf" prints "Date of Service: 10/19/2028", yet the Inbox
 * said "Missing information — Service date". The validator (extractFields.js) dropped the date for being too far in
 * the future, and nothing ever looked at the page again. This module is the "look at the page again" step, used in
 * two places with the same pure planner:
 *   - at ingest (extractDocument.js), right after normalizeFields: any REQUIRED field the extraction left empty is
 *     looked up on the page by its label (method 'label-fill');
 *   - on stored documents (api/_lib/recheck.js): the nightly sweep and the Inbox's "Re-check" buttons re-run it over
 *     `document_pages.text` for documents already ingested with a gap (method 'recheck'), $0, no model.
 *
 * Every value it supplies goes through normalizeFields — the SAME validator as everything else — so a far-future date
 * lands as `service_date_unconfirmed` (flagged, shown, never fed to the warranty clock), not as a silent fact.
 *
 * Precision first: a field is filled only when every labelled candidate on the page agrees on ONE value
 * (textExtract.js's scanLabeledValues decides what a candidate is). Two different "Date of Service" values, two
 * technicians, two totals with no priority between them: left for a person, and reported in `ambiguous`.
 *
 * Pure. No clock (the caller passes `today`), no I/O.
 */
import { scanLabeledValues } from "./textExtract.js";
import { normalizeFields, isUnconfirmedKey, baseKeyOf, normalizeDate } from "../extractFields.js";
import { completenessFor, REQUIRED_FIELDS, normalizeDocumentType, isLabelValue } from "../documentTypes.js";
import { isOwnName, nameKey } from "./ownCompany.js";
import { scanProseFacts } from "./proseFacts.js";
import { verifyGrounded } from "./groundedFacts.js";
import { detectDateOrder } from "./textExtract.js";
const normalizeDateLoose = (v) => normalizeDate(String(v ?? "").trim(), { order: "mdy" });

// Inbox round (2026-10-21): 2 = new date / address labels ("Issued", "Date Reported", "Premises") and the file-name address;
// the bump lets the nightly sweep and "Re-check all missing fields" look at every open paper once more.
// Docread round (2026-10-22): 3 = facts stated in sentences / column blocks (proseFacts.js), period and licence facts, and every
// fill grounded (quote on the page, value from the quote) before it is written. The bump re-scans every open paper once.
export const LABEL_FILL_VERSION = 3;

/** Facts restored when absent on papers of these types although nothing requires them: the period a lease, policy or licence
 *  runs, its number. Read from labels or sentences only, grounded like everything else. */
export const PERIOD_KEYS_BY_TYPE = {
  "agreement": ["start_date", "end_date"],
  "maintenance-agreement": ["start_date", "end_date"],
  "insurance-certificate": ["policy_number", "start_date", "end_date"],
  "license-certification": ["license_number", "start_date", "end_date"],
  "permit": ["end_date"],
};

/** Date fields the planner also restores when absent even though the type does not REQUIRE them — a labelled install
 * date on an invoice is what the warranty clock runs on. Explicit labels only (never a bare "Date:"). */
export const OPTIONAL_DATE_KEYS = ["installation_date", "warranty_registered_date", "warranty_expires", "service_date"];

const FILL_CONFIDENCE = { explicit: 0.9, bare: 0.86, letterhead: 0.8 };

/** Fields a stored-text read may supply on a document that has NONE (the "nothing read" repair). */
export const ALL_SCAN_KEYS = ["customer_name", "vendor", "service_date", "cost", "invoice_number", "service_address", "agreement_term", "customer_phone", "customer_email"];
/** Docread round: OCR noise in a name - a token like "oF" (lower then upper), a dot glued between letters, or a trailing lone letter. */
export function letterheadTruncated(name, pages) {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (slug.length < 4) return false;
  const top = String((pages ?? [])[0]?.text ?? "").split(/\r?\n/).slice(0, 12).join(" ").toLowerCase();
  const doms = [...top.matchAll(/(?:www\.|@)([a-z0-9-]{4,})\./g)].map((m) => m[1].replace(/-/g, "").replace(/(?:example)?(?:com|net|org)?$/, ""));
  return doms.some((d) => d.startsWith(slug) && d.length - slug.length >= 5);
}
export function isHeaderRow(verbatim) {
  const segs = String(verbatim ?? "").split(/\s{2,}|\t|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  return segs.length >= 3 && segs.every((x) => !/\d/.test(x) && x.split(/\s+/).length <= 3 && !/[,.]$/.test(x) && !/\b(?:llc|inc|co|company|group|corp)\b/i.test(x));
}
export function looksGarbledName(v) {
  const toks = String(v ?? "").trim().split(/\s+/);
  if (toks.some((t) => /^[a-z][A-Z]/.test(t) || /[a-z]\.[A-Za-z]{2,}/.test(t) || /^[^A-Za-z0-9&]+$/.test(t))) return true;
  return toks.length > 1 && /^[A-Z]$/.test(toks[toks.length - 1]) && !/^[A-Z]\.?$/.test(toks[toks.length - 2] ?? "x");
}
const NO_EQUIPMENT_DATE_TYPES = new Set(["permit", "license-certification", "insurance-certificate", "hr-letter", "statement", "agreement", "receipt", "schedule", "price-list"]);
const PROSE_KEYS = new Set(["service_address", "serial_number", "model", "warranty_term", "service_date", "invoice_number", "permit_number", "customer_name", "vendor", "cost", "agreement_term", "start_date", "end_date", "license_number", "policy_number"]);
/** Fields restored when absent even though the type does not require them (explicit labels, or a non-own letterhead). */
export const OPTIONAL_PARTY_KEYS = ["vendor"];

/** Keys present on the document in any form (canonical, or parked as unconfirmed). */
function presentKeys(fields) {
  const have = new Set();
  for (const f of fields ?? []) {
    const k = f?.field_key ?? f?.key;
    if (typeof k !== "string") continue;
    const v = f?.corrected_value ?? f?.value;
    if (v == null || String(v).trim() === "") continue;
    have.add(isUnconfirmedKey(k) ? baseKeyOf(k) : k);
  }
  return have;
}

/**
 * Plan which missing fields can be filled from the page's own labels.
 * @param {{type: string|null, fields: {field_key:string, value:unknown, confidence?:number, corrected_value?:unknown}[],
 *          pages: {page_no:number, text:string}[], today?: string, method?: 'label-fill'|'recheck', pageCount?: number,
 *          optionalDates?: boolean}} input
 * @returns {{add: object[], ambiguous: {key:string, values:string[]}[], targets: string[], missingBefore: string[]}}
 *   `add` is normalizeFields output (field_key/value/confidence/page_no/verbatim/flags/method) ready to write.
 */
/**
 * Inbox round (2026-10-21): a street address in the FILE NAME ("Permit PLB26-72783 - 7442 W Palo Dr.pdf", "WO-4402 8254 Bluebonnet
 * Ct.pdf") that the page text also prints (same house number and the same first street word) is a service address read by two
 * independent sources. Returns the address as written in the file name, or null. Pure.
 */
const FILE_ADDR_RE = /(?:^|[\s_-])(\d{2,6})\s+((?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z']+(?:\s+[A-Za-z][A-Za-z']+){0,3}?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Way|Ct|Court|Pl|Place|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Row|Trl|Trail|Ter|Terrace|Loop)\b\.?(?:\s+(?:Unit|Apt|Suite|Ste)\.?\s*[A-Za-z0-9-]+)?)/i;
export function addressFromFilename(filename, pages) {
  const base = String(filename ?? "").replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/_/g, " ");
  const m = FILE_ADDR_RE.exec(base);
  if (!m) return null;
  const house = m[1];
  const firstWord = m[2].replace(/^[NSEW]\.?\s+/i, "").split(/\s+/)[0].toLowerCase();
  const text = (pages ?? []).map((p) => String(p?.text ?? "")).join("\n").toLowerCase();
  if (!new RegExp(`(?:^|[^0-9])${house}\\s+(?:[nsew]\\.?\\s+)?${firstWord.replace(/[^a-z']/g, "")}\\b`).test(text)) return null;
  return `${house} ${m[2]}`.replace(/\s+/g, " ").trim();
}

export function planLabelFill({ type, fields, pages, today, method = "label-fill", pageCount, optionalDates = true, ownNames = [], allKeys = false, pack = null, filename = null }) {
  const docType = normalizeDocumentType(type);
  const completeness = completenessFor(docType, (fields ?? []).map((f) => ({ field_key: f.field_key ?? f.key, value: f.corrected_value ?? f.value, confidence: f.confidence ?? 1 })));
  const have = presentKeys(fields);
  const targets = [];
  for (const requirement of completeness.missing) for (const k of requirement.split("|")) if (!targets.includes(k)) targets.push(k);
  // Docread round: equipment dates (install, warranty registered / expires) are never read off company paper that has no equipment:
  // a licence's "Expires" is the licence period (end_date), not a warranty.
  const noEquipmentDates = NO_EQUIPMENT_DATE_TYPES.has(docType);
  if (optionalDates) for (const k of OPTIONAL_DATE_KEYS) if (!(noEquipmentDates && k !== "service_date") && !have.has(k) && !targets.includes(k)) targets.push(k);
  if (ownNames?.length) for (const k of OPTIONAL_PARTY_KEYS) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  if (allKeys) for (const k of ALL_SCAN_KEYS) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  for (const k of PERIOD_KEYS_BY_TYPE[docType] ?? []) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  if (!targets.length || !(pages ?? []).some((p) => String(p?.text ?? "").trim())) {
    return { add: [], ambiguous: [], targets, missingBefore: completeness.missing };
  }

  const { candidates } = scanLabeledValues(pages, { type: docType, keys: targets, ownNames });
  // Docread round: the second reader, for facts stated in sentences or column blocks. Used only where the labels gave nothing.
  let prose = { candidates: {}, ambiguous: [] };
  try {
    const order = detectDateOrder((pages ?? []).map((p) => String(p?.text ?? "")).join("\n"));
    prose = scanProseFacts(pages, { keys: targets.filter((k) => PROSE_KEYS.has(k)), type: docType, order: order === "dmy" ? "dmy" : "mdy" });
  } catch { prose = { candidates: {}, ambiguous: [] }; }
  const required = new Set((REQUIRED_FIELDS[docType] ?? []).flatMap((r) => r.split("|")));
  // A unit-scoped date on a document naming several units belongs to ONE of them — not ours to pick.
  const serials = new Set((fields ?? []).filter((f) => (f.field_key ?? f.key) === "serial_number").map((f) => String(f.corrected_value ?? f.value ?? "").trim().toLowerCase()).filter(Boolean));
  for (const c of candidates.serial_number ?? []) serials.add(c.value.toLowerCase());

  const raw = [];
  const ambiguous = [];
  const satisfied = new Set();
  for (const key of targets) {
    if (have.has(key)) continue;
    let list = candidates[key] ?? [];
    // Docread round: the same precision filters apply to every reader's candidates (labels and sentences / columns).
    const keepOnly = (input) => {
      let list = input;
      // Inbox round: a label read as a name ("DELIVERED TO" beside "BILL TO") is never a party.
      if (key === "customer_name" || key === "vendor") list = list.filter((c) => !isLabelValue(c.value));
      // Docread round: on a purchase order the "Buyer" / "Ordered by" is the issuer's own employee, never the customer.
      if (key === "customer_name" && docType === "purchase-order") list = list.filter((c) => !/buyer|ordered\s+by|requested\s+by|purchaser|placed\s+by/i.test(String(c.label ?? "")));
      // A negative amount ("Payment Received -526.00", "(655.00)") is a payment or credit line, never the paper's own total -
      // except on a credit or refund line itself.
      if (key === "cost") list = list.filter((c) => !/^\s*(?:-|\(|USD\s*-|\$\s*-)/i.test(String(c.value)) || /credit|refund/i.test(String(c.label ?? "")));
      // A name on a signature line ("Attorney: Marcus Marsh Date: ______") is the person signing, never the issuing business.
      if (key === "vendor") list = list.filter((c) => !/_{4,}|date:\s*_{2,}/i.test(String(c.verbatim ?? "")));
      // A one-word letterhead with no business word is a fragment of a name wrapped across lines ("Drain" of "... Plumbing & Drain").
      // Docread round: any one-word issuer name is too thin to trust on its own (a column title "Course", a wrapped "Drain").
      if (key === "vendor") list = list.filter((c) => /\s/.test(String(c.value).trim()));
      // A name read off a table's header row ("Unit | Tenant | Rent Charged | Collected") is a column title, not a party.
      if (key === "customer_name" || key === "vendor") list = list.filter((c) => !isHeaderRow(c.verbatim));
      // A letterhead cut off by the line wrap ("City of Scottsdale Building" / ... / "Safety Division") ends on a dangling word.
      if (key === "vendor") list = list.filter((c) => c.strength !== "letterhead" || !/\b(?:building|safety|of|and|&|the)$/i.test(String(c.value).trim()));
      // A letterhead whose own web / email domain carries more words than the name was cut off by the line wrap
      // ("Ironwood Legal" with www.ironwoodlegalresearchservice...).
      if (key === "vendor") list = list.filter((c) => c.strength !== "letterhead" || !letterheadTruncated(c.value, pages));
      // A name that reads like OCR noise ("MEMORANDUM oF U", "Beacori.Gegimunlty") is left for a person.
      if (key === "customer_name" || key === "vendor") list = list.filter((c) => !looksGarbledName(c.value));
      // A bare "Expires" is a warranty expiry only on a warranty paper (a quote, permit or licence "Expires" is not a warranty).
      if (key === "warranty_expires" && docType !== "warranty-registration") list = list.filter((c) => /warrant|coverage/i.test(String(c.label ?? "")));
      // On an agreement or a quote, a completion / due / expiry date is not the date the paper is about.
      if (key === "service_date" && ["agreement", "maintenance-agreement", "proposal-quote"].includes(docType)) list = list.filter((c) => !/complet|due|expir|valid|through|until|end/i.test(String(c.label ?? "")));
      // A zero amount (a paid-off balance) is not the paper's amount.
      if (key === "cost") list = list.filter((c) => Number(String(c.value).replace(/[^0-9.]/g, "")) !== 0);
      return list;
    };
    list = keepOnly(list);
    // Docread round: the document total is read by the totals reader (exact total labels, tiers, subtotal + tax check) when it
    // finds one; when it finds two different totals the amount is left for a person, whatever the labelled scan picked.
    if (key === "cost" && PROSE_KEYS.has(key)) {
      if (prose.ambiguous.some((a) => a.key === "cost")) { const pa = prose.ambiguous.find((a) => a.key === "cost"); ambiguous.push({ key, values: pa.values ?? [], reason: pa.reason }); continue; }
      const pc = keepOnly(prose.candidates.cost ?? []);
      if (pc.length === 1) list = pc;
    }
    if (!required.has(key) && !allKeys) list = list.filter((c) => c.strength === "explicit" || (key === "vendor" && c.strength === "letterhead"));
    if (key === "installation_date" && serials.size > 1) continue;
    if (!list.length && PROSE_KEYS.has(key)) {
      const pa = prose.ambiguous.find((a) => a.key === key);
      if (pa) { ambiguous.push({ key, values: pa.values ?? [], reason: pa.reason }); continue; }
      list = keepOnly((prose.candidates[key] ?? []).filter((c) => !((key === "customer_name" || key === "vendor") && isOwnName(c.value, ownNames))));
    }
    if (!list.length) continue;
    if (key === "work_performed") {
      const seen = new Set();
      for (const c of list) {
        const id = c.value.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        raw.push({ key, value: c.value, page_no: c.page_no, verbatim: c.verbatim, confidence: c.conf ?? FILL_CONFIDENCE[c.strength], method });
      }
      satisfied.add(key);
      continue;
    }
    const distinct = [...new Set(list.map((c) => c.value.trim().toLowerCase()))];
    if (distinct.length !== 1) {
      // Docread round: two labelled readings disagree, but the second reader (sentences / totals / columns) reads exactly one of
      // them: two independent readers agree on that value, so it is used (with the second reader's quote).
      const p1 = PROSE_KEYS.has(key) && !prose.ambiguous.some((a) => a.key === key) ? (prose.candidates[key] ?? []) : [];
      const agreed = p1.length === 1 && list.some((c) => sameValue(key, c.value, p1[0].value)) ? p1[0] : null;
      if (!agreed) { ambiguous.push({ key, values: [...new Set(list.map((c) => c.value))] }); continue; }
      list = [agreed];
    }
    // Alternatives ("customer_name|service_address") are satisfied by the first one found.
    const c = list[0];
    raw.push({ key, value: c.value, page_no: c.page_no, verbatim: c.verbatim, confidence: c.conf ?? FILL_CONFIDENCE[c.strength], method });
    satisfied.add(key);
  }
  // Inbox round: the service address printed in the file name AND on the page, when the labels gave none.
  if (filename && targets.includes("service_address") && !have.has("service_address") && !satisfied.has("service_address") && !ambiguous.some((a) => a.key === "service_address")) {
    const addr = addressFromFilename(filename, pages);
    if (addr) { raw.push({ key: "service_address", value: addr, page_no: 1, verbatim: addr, confidence: FILL_CONFIDENCE.explicit, method, fromFilename: true }); satisfied.add("service_address"); }
  }
  // Only keep an alternative fill when its requirement is still open (the first alternative found wins).
  const keep = [];
  const doneReq = new Set();
  for (const f of raw) {
    const req = completeness.missing.find((r) => r.split("|").includes(f.key));
    if (req && req.includes("|")) {
      // Inbox round: a full stored-text read (allKeys) keeps both halves of a "date or number" requirement (the number is
      // a fact of its own); every other alternative keeps only the first one found, as before.
      // Docread round: a permit number printed beside the inspection date is a fact of its own too.
      const keepAll = allKeys && (ALL_SCAN_KEYS.includes(f.key) || f.key === "permit_number") && req.split("|").some((k) => k === "invoice_number" || k === "permit_number");
      if (doneReq.has(req) && f.key !== "work_performed" && !keepAll) continue;
      doneReq.add(req);
    }
    keep.push(f);
  }
  // Docread round: nothing is written unless its quote is on its page and the value comes from that quote.
  const ungrounded = [];
  const grounded = keep.filter((f) => {
    if (f.fromFilename) return true; // the file-name address: checked against the page by addressFromFilename itself
    const g = verifyGrounded({ field_key: f.key, value: f.value, verbatim: f.verbatim, page_no: f.page_no }, pages);
    if (!g.ok) ungrounded.push({ key: f.key, value: f.value, reason: g.reason });
    return g.ok;
  }).map(({ fromFilename, ...f }) => f);
  const { fields: add } = normalizeFields(grounded, { pageCount, today, ...(pack ? { pack } : {}) });
  return { add, ambiguous, targets, missingBefore: completeness.missing, ungrounded };
}


/* ------------------------------------------------------------------ corroboration */
const MONEY_KEYS = new Set(["cost"]);
const centsOf = (v) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const tokenSet = (s) => new Set(nameKey(s).length ? String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !["inc", "llc", "ltd", "co", "the", "and", "corp", "company"].includes(w)) : []);
/** Fuzzy name equality: same letters after suffix removal, or the same word set ("Duarte, Martin" = "Martin Duarte"). */
export function namesAgree(a, b) {
  if (nameKey(a) && nameKey(a) === nameKey(b)) return true;
  const A = tokenSet(a), B = tokenSet(b);
  if (A.size < 2 || A.size !== B.size) return false;
  for (const w of A) if (!B.has(w)) return false;
  return true;
}
function sameValue(key, a, b) {
  if (MONEY_KEYS.has(key)) { const x = centsOf(a), y = centsOf(b); return x !== null && y !== null && Math.abs(x - y) <= 1; }
  if (key === "service_date") return String(a).slice(0, 10) === String(b).slice(0, 10);
  if (key === "customer_name" || key === "vendor") return namesAgree(a, b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
const CORROBORATE_KEYS = ["service_date", "cost", "customer_name", "vendor", "invoice_number"];

/**
 * Confidence by corroboration, never by a lower bar: when the label scan reads the SAME value the model gave (the same
 * normalized date, an amount within one cent, a fuzzy-equal name, the same document number), two independent readers agree
 * and that field's confidence becomes at least HIGH. A date or an amount is corroborated only when the page prints ONE such
 * value (two different totals on the page corroborate neither). Pure.
 * @returns {{fields: object[], corroborated: {field_key:string, from:number, to:number}[]}} `fields` is a copy; unchanged
 *          rows are returned as they were.
 */
export const CORROBORATED_CONFIDENCE = 0.9;
export function corroborateFields({ type, fields, pages, ownNames = [] }) {
  const rows = Array.isArray(fields) ? fields : [];
  if (!rows.length || !(pages ?? []).some((p) => String(p?.text ?? "").trim())) return { fields: rows, corroborated: [] };
  let cands;
  try { cands = scanLabeledValues(pages, { type: normalizeDocumentType(type), keys: CORROBORATE_KEYS, ownNames }).candidates; } catch { return { fields: rows, corroborated: [] }; }
  const corroborated = [];
  const out = rows.map((f) => {
    const key = f?.field_key;
    if (!CORROBORATE_KEYS.includes(key) || f.corrected_value != null) return f;
    const conf = Number(f.confidence);
    if (Number.isFinite(conf) && conf >= CORROBORATED_CONFIDENCE) return f;
    const list = cands[key] ?? [];
    if (!list.length) return f;
    const distinct = new Set(list.map((c) => (key === "customer_name" || key === "vendor" ? nameKey(c.value) : String(c.value).toLowerCase())));
    if ((MONEY_KEYS.has(key) || key === "service_date" || key === "invoice_number") && distinct.size !== 1) return f;
    if (!list.some((c) => sameValue(key, f.value, c.value))) return f;
    corroborated.push({ field_key: key, from: Number.isFinite(conf) ? conf : 0, to: CORROBORATED_CONFIDENCE });
    return { ...f, confidence: CORROBORATED_CONFIDENCE, corroborated: true };
  });
  return { fields: out, corroborated };
}

/* ------------------------------------------------------------------ cross-check (docread verify round, 2026-10-22) */
/**
 * The fast extractors (template / labelled, extractDocument's deterministic path) write facts without the totals reader's or
 * the period reader's checks. This runs those checks on what they wrote, before anything is stored:
 *   - cost: when the page's totals are inconsistent (subtotal + tax != total, two different totals, total vs amount due with
 *     nothing between them) or the totals reader reads a different amount, the cost is removed - a person decides;
 *   - agreement_term: when the page states the period's start / end under period labels or in a sentence and the term's dates
 *     are not those dates (a COI's Certificate Date taken as the policy start), the term is removed.
 * Pure. Returns the kept fields and what was removed (with the reason).
 */
export function crossCheckFields({ fields, pages }) {
  const rows = Array.isArray(fields) ? fields : [];
  if (!rows.length || !(pages ?? []).some((p) => String(p?.text ?? "").trim())) return { fields: rows, removed: [] };
  let pf;
  try {
    const order = detectDateOrder((pages ?? []).map((p) => String(p?.text ?? "")).join("\n"));
    pf = scanProseFacts(pages, { keys: ["cost", "start_date", "end_date"], order: order === "dmy" ? "dmy" : "mdy" });
  } catch { return { fields: rows, removed: [] }; }
  const removed = [];
  const out = rows.filter((f) => {
    if (f?.field_key === "cost" && f.corrected_value == null) {
      const amb = pf.ambiguous.find((a) => a.key === "cost" && a.reason !== "zero amount");
      if (amb) { removed.push({ field_key: "cost", value: f.value, reason: amb.reason }); return false; }
      const one = pf.candidates.cost?.[0];
      if (one && !sameValue("cost", f.value, one.value)) { removed.push({ field_key: "cost", value: f.value, reason: `the page's total is ${one.value}` }); return false; }
    }
    if (f?.field_key === "agreement_term" && f.corrected_value == null) {
      const iso = (v) => normalizeDateLoose(v);
      const dates = [...String(f.value).matchAll(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [A-Za-z]{3,9}\.? \d{4}/g)].map((m) => iso(m[0])).filter(Boolean);
      const s = pf.candidates.start_date?.[0] ? iso(pf.candidates.start_date[0].value) : null;
      const e = pf.candidates.end_date?.[0] ? iso(pf.candidates.end_date[0].value) : null;
      if (dates.length && ((s && !dates.includes(s)) || (e && !dates.includes(e)))) { removed.push({ field_key: "agreement_term", value: f.value, reason: `the page states the period ${s ?? "?"} - ${e ?? "?"}` }); return false; }
    }
    return true;
  });
  return { fields: out, removed };
}
