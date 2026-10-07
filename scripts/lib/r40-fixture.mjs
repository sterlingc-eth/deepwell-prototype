// R40 fixture: golden export + INV-T226 mirroring the live document (same address / job key as INV-60003, different customer, $350.00).
import fs from "node:fs";
export const GOLDEN = "scripts/golden/golden-export.json";
const ID = (n) => `a40a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 1;
export const nid = () => ID(seq++);
export function loadGolden() { return JSON.parse(fs.readFileSync(GOLDEN, "utf8")); }
export function pageText({ num, date, bill, addr, equip, serial, desc, labor, total, tech, totalLabel = "TOTAL DUE:" }) {
  return ["Sonoran Comfort Air", "4410 E Baseline Rd, Mesa, AZ 85206", "(480) 555-0199 | info@sonorancomfortair.com", "INVOICE",
    `Invoice #: ${num}`, `Date: ${date}`, `Bill To: ${bill}`, `Service Address: ${addr}`, `Equipment: ${equip}`, `Serial: ${serial}`, "Description of work:", desc, `Labor: ${labor}`, `${totalLabel} ${total}`, `Technician: ${tech}`].join("\n");
}
/** add one invoice document (document, page, financial row + line, extractions, optional customer link). Returns ids. */
export function addInvoice(d, o) {
  const did = o.docId ?? nid(), fid = nid();
  const iso = o.dateIso;
  d.documents.push({ id: did, batch_id: null, original_filename: o.filename, document_type: "invoice", sha256_hash: String(did).replace(/\D/g, "").padEnd(64, "b").slice(0, 64), file_size_bytes: 1200, stage: "linked", created_at: `${iso}T12:00:00Z`, processed_at: `${iso}T12:00:00Z` });
  d.pages.push({ id: nid(), document_id: did, page_no: 1, text: o.text ?? pageText({ num: o.num, date: o.dateUs, bill: o.customer, addr: o.addr, equip: o.equip ?? "Lennox ML14XC1-046-230", serial: o.serial ?? "LX100030", desc: o.desc, labor: o.labor ?? "2.5 hrs", total: o.totalText ?? `$${o.total}`, tech: o.tech ?? "Ray Sutton" }), created_at: `${iso}T12:00:00Z` });
  const amt = o.total == null ? null : String(o.total).replace(/[$,]/g, "");
  d.financials.push({ id: fid, document_id: did, doc_kind: o.kind ?? "invoice", direction: o.direction ?? "receivable", currency: o.currency ?? "USD", invoice_number: o.num, po_number: null, invoice_date: iso, due_date: null, period_start: null, period_end: null, agreement_term: null, subtotal: null, tax: null, total: amt, amount_paid: null, balance_due: null, status: "unknown", customer_name: o.customer, vendor_name: null, confidence: 0.9, flags: [], evidence: amt ? { total: { page: 1, verbatim: `TOTAL DUE: $${amt}`, confidence: 0.9 } } : {}, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: "r40", extracted_at: `${iso}T12:00:00Z`, created_at: `${iso}T12:00:00Z`, job_key: o.jobKey ?? null, job_key_source: o.jobKey ? "extracted" : null, job_confidence: 0, job_raw: o.addr });
  (o.lines ?? [{ description: o.desc, amount: amt }]).forEach((l, i) => d.financial_lines.push({ id: nid(), financial_id: fid, document_id: did, line_no: i + 1, description: l.description, qty: null, unit_price: null, amount: l.amount, category_guess: null, page_no: 1 }));
  const ex = (k, v, eid) => d.extractions.push({ id: nid(), document_id: did, entity_id: eid ?? null, field_key: k, value: v, confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: `${iso}T12:00:00Z` });
  ex("invoice_number", o.num, o.entityId); ex("invoice_date", iso, o.entityId); if (o.desc) ex("work_performed", o.desc, o.entityId);
  if (o.customerId) d.document_entity_links.push({ id: nid(), document_id: did, entity_id: o.customerId, confidence: 0.9, linked_by: "r40", created_at: `${iso}T12:00:00Z` });
  return { did, fid };
}
export function addCustomer(d, name, addr) {
  const id = nid();
  d.entities.push({ id, entity_type: "customer", merged_into: null, customer_number: `C-R40${id.slice(-4)}`, data: { customer_name: name, service_address: addr }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  return id;
}
export const ADDR = "3300 S Alma School Rd, Apt 103, Mesa, AZ 85201";
/** the live failure fixture */
export function liveFixture() {
  const d = loadGolden(); d.tenantKey = "r40-live"; d.tenantName = "r40-live";
  const cid = addCustomer(d, "Ronald Calloway", ADDR);
  addInvoice(d, { num: "INV-T226", customer: "Ronald Calloway", customerId: cid, dateIso: "2026-09-05", dateUs: "09/05/2026", addr: ADDR, equip: "undefined ML14XC1-046-230", serial: "LX100030", desc: "Seasonal maintenance check", total: "350.00", totalText: "$350.00", filename: "226-invoice-topup-apt3.pdf", jobKey: "3300-alma-school-u103-mesa" });
  return d;
}
