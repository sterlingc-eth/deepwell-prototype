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
import { normalizeFields, isUnconfirmedKey, baseKeyOf } from "../extractFields.js";
import { completenessFor, REQUIRED_FIELDS, normalizeDocumentType } from "../documentTypes.js";
import { isOwnName, nameKey } from "./ownCompany.js";

export const LABEL_FILL_VERSION = 1;

/** Date fields the planner also restores when absent even though the type does not REQUIRE them — a labelled install
 * date on an invoice is what the warranty clock runs on. Explicit labels only (never a bare "Date:"). */
export const OPTIONAL_DATE_KEYS = ["installation_date", "warranty_registered_date", "warranty_expires", "service_date"];

const FILL_CONFIDENCE = { explicit: 0.9, bare: 0.86, letterhead: 0.8 };

/** Fields a stored-text read may supply on a document that has NONE (the "nothing read" repair). */
export const ALL_SCAN_KEYS = ["customer_name", "vendor", "service_date", "cost", "invoice_number", "service_address", "agreement_term", "customer_phone", "customer_email"];
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
export function planLabelFill({ type, fields, pages, today, method = "label-fill", pageCount, optionalDates = true, ownNames = [], allKeys = false, pack = null }) {
  const docType = normalizeDocumentType(type);
  const completeness = completenessFor(docType, (fields ?? []).map((f) => ({ field_key: f.field_key ?? f.key, value: f.corrected_value ?? f.value, confidence: f.confidence ?? 1 })));
  const have = presentKeys(fields);
  const targets = [];
  for (const requirement of completeness.missing) for (const k of requirement.split("|")) if (!targets.includes(k)) targets.push(k);
  if (optionalDates) for (const k of OPTIONAL_DATE_KEYS) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  if (ownNames?.length) for (const k of OPTIONAL_PARTY_KEYS) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  if (allKeys) for (const k of ALL_SCAN_KEYS) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  if (!targets.length || !(pages ?? []).some((p) => String(p?.text ?? "").trim())) {
    return { add: [], ambiguous: [], targets, missingBefore: completeness.missing };
  }

  const { candidates } = scanLabeledValues(pages, { type: docType, keys: targets, ownNames });
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
    if (!required.has(key) && !allKeys) list = list.filter((c) => c.strength === "explicit" || (key === "vendor" && c.strength === "letterhead"));
    if (key === "installation_date" && serials.size > 1) continue;
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
    if (distinct.length !== 1) { ambiguous.push({ key, values: [...new Set(list.map((c) => c.value))] }); continue; }
    // Alternatives ("customer_name|service_address") are satisfied by the first one found.
    const c = list[0];
    raw.push({ key, value: c.value, page_no: c.page_no, verbatim: c.verbatim, confidence: c.conf ?? FILL_CONFIDENCE[c.strength], method });
    satisfied.add(key);
  }
  // Only keep an alternative fill when its requirement is still open (the first alternative found wins).
  const keep = [];
  const doneReq = new Set();
  for (const f of raw) {
    const req = completeness.missing.find((r) => r.split("|").includes(f.key));
    if (req && req.includes("|")) {
      if (doneReq.has(req) && f.key !== "work_performed") continue;
      doneReq.add(req);
    }
    keep.push(f);
  }
  const { fields: add } = normalizeFields(keep, { pageCount, today, ...(pack ? { pack } : {}) });
  return { add, ambiguous, targets, missingBefore: completeness.missing };
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
