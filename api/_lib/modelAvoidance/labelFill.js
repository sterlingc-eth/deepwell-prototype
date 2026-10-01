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

export const LABEL_FILL_VERSION = 1;

/** Date fields the planner also restores when absent even though the type does not REQUIRE them — a labelled install
 * date on an invoice is what the warranty clock runs on. Explicit labels only (never a bare "Date:"). */
export const OPTIONAL_DATE_KEYS = ["installation_date", "warranty_registered_date", "warranty_expires", "service_date"];

const FILL_CONFIDENCE = { explicit: 0.9, bare: 0.86 };

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
export function planLabelFill({ type, fields, pages, today, method = "label-fill", pageCount, optionalDates = true }) {
  const docType = normalizeDocumentType(type);
  const completeness = completenessFor(docType, (fields ?? []).map((f) => ({ field_key: f.field_key ?? f.key, value: f.corrected_value ?? f.value, confidence: f.confidence ?? 1 })));
  const have = presentKeys(fields);
  const targets = [];
  for (const requirement of completeness.missing) for (const k of requirement.split("|")) if (!targets.includes(k)) targets.push(k);
  if (optionalDates) for (const k of OPTIONAL_DATE_KEYS) if (!have.has(k) && !targets.includes(k)) targets.push(k);
  if (!targets.length || !(pages ?? []).some((p) => String(p?.text ?? "").trim())) {
    return { add: [], ambiguous: [], targets, missingBefore: completeness.missing };
  }

  const { candidates } = scanLabeledValues(pages, { type: docType, keys: targets });
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
    if (!required.has(key)) list = list.filter((c) => c.strength === "explicit");
    if (key === "installation_date" && serials.size > 1) continue;
    if (!list.length) continue;
    if (key === "work_performed") {
      const seen = new Set();
      for (const c of list) {
        const id = c.value.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        raw.push({ key, value: c.value, page_no: c.page_no, verbatim: c.verbatim, confidence: FILL_CONFIDENCE[c.strength], method });
      }
      satisfied.add(key);
      continue;
    }
    const distinct = [...new Set(list.map((c) => c.value.trim().toLowerCase()))];
    if (distinct.length !== 1) { ambiguous.push({ key, values: [...new Set(list.map((c) => c.value))] }); continue; }
    // Alternatives ("customer_name|service_address") are satisfied by the first one found.
    const c = list[0];
    raw.push({ key, value: c.value, page_no: c.page_no, verbatim: c.verbatim, confidence: FILL_CONFIDENCE[c.strength], method });
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
  const { fields: add } = normalizeFields(keep, { pageCount, today });
  return { add, ambiguous, targets, missingBefore: completeness.missing };
}
