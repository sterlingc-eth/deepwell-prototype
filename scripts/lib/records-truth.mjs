// RECORDS-R1 truth: what the stored rows say, computed from the RAW export rows (never from Donovan). Independent formatters on purpose.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const human = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}` : iso);
export const money = (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9$.,#/-]+/g, " ").replace(/\s+/g, " ").trim();

export function index(d) {
  const ex = new Map(), links = new Map(), fin = new Map(), lines = new Map(), pages = new Map(), docs = new Map();
  for (const x of d.documents) docs.set(x.id, x);
  for (const e of d.extractions) { if (!ex.has(e.document_id)) ex.set(e.document_id, []); ex.get(e.document_id).push(e); }
  for (const l of d.document_entity_links) { if (!links.has(l.entity_id)) links.set(l.entity_id, new Set()); links.get(l.entity_id).add(l.document_id); }
  for (const f of d.financials) fin.set(f.document_id, f);
  for (const l of d.financial_lines) { if (!lines.has(l.document_id)) lines.set(l.document_id, []); lines.get(l.document_id).push(l); }
  for (const p of d.pages) { if (!pages.has(p.document_id)) pages.set(p.document_id, []); pages.get(p.document_id).push(p); }
  const customers = d.entities.filter((e) => e.entity_type === "customer" && !e.merged_into);
  const units = d.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into);
  return { d, ex, links, fin, lines, pages, docs, customers, units };
}
export const fieldVals = (ix, docId, key) => [...new Set((ix.ex.get(docId) ?? []).filter((e) => e.field_key === key && e.value).map((e) => e.value.trim()))];
export function docDate(ix, docId) {
  const sd = fieldVals(ix, docId, "service_date")[0]; if (sd) return sd.slice(0, 10);
  const f = ix.fin.get(docId); if (f?.invoice_date) return String(f.invoice_date).slice(0, 10);
  const iv = fieldVals(ix, docId, "invoice_date")[0]; if (iv) return iv.slice(0, 10);
  return String(ix.docs.get(docId).created_at).slice(0, 10);
}
export const customerDocs = (ix, custId) => [...(ix.links.get(custId) ?? [])].sort((a, b) => docDate(ix, b).localeCompare(docDate(ix, a)) || String(ix.docs.get(b).created_at).localeCompare(String(ix.docs.get(a).created_at)));
export const customerUnits = (ix, custId) => ix.units.filter((u) => u.customer_id === custId);

/** expected DISPLAY strings (as a person reads them) of one document-level fact on one document; [] = not stored there */
export function docFactValues(ix, docId, factId) {
  const f = ix.fin.get(docId), lines = ix.lines.get(docId) ?? [];
  const ext = (k) => fieldVals(ix, docId, k);
  switch (factId) {
    case "work_performed": return ext("work_performed");
    case "technician": return ext("technician");
    case "service_date": return ext("service_date").map(human);
    case "service_type": return ext("service_type");
    case "labor_hours": return ext("labor_hours").map((v) => `${Number(v)} ${Number(v) === 1 ? "hour" : "hours"}`);
    case "notes": return ext("notes");
    case "job_status": return ext("status");
    case "permit_number": return ext("permit_number");
    case "agreement_term": return ext("agreement_term");
    case "invoice_number": return f?.invoice_number ? [f.invoice_number] : ext("invoice_number");
    case "invoice_date": return f?.invoice_date ? [human(String(f.invoice_date).slice(0, 10))] : ext("invoice_date").map(human);
    case "po_number": return f?.po_number ? [f.po_number] : ext("po_number");
    case "vendor_name": return f?.vendor_name ? [f.vendor_name] : ext("vendor_name");
    case "subtotal": return f?.subtotal != null ? [money(f.subtotal)] : [];
    case "tax": return f?.tax != null ? [money(f.tax)] : [];
    case "total": return f?.total != null ? [money(f.total)] : [];
    case "line_items": return lines.map((l) => l.description);
    case "labor_charge": { const p = lines.filter((l) => l.amount != null && (l.category_guess === "labor" || /\blabou?r\b/i.test(l.description ?? ""))); return p.length ? [money(p.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0) / 100)] : []; }
    case "parts_charge": { const p = lines.filter((l) => l.amount != null && l.category_guess === "parts"); return p.length ? [money(p.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0) / 100)] : []; }
    default: return null;
  }
}
export const DOC_FACTS = ["work_performed", "technician", "service_date", "service_type", "labor_hours", "notes", "job_status", "permit_number", "agreement_term", "invoice_number", "invoice_date", "po_number", "vendor_name", "subtotal", "tax", "total", "line_items", "labor_charge", "parts_charge"];

/** unit-level fact: [{unit, value}] per unit of the customer */
export function unitFactValues(ix, custId, factId) {
  const key = { manufacturer: "manufacturer", model: "model", serial_number: "serial_number", refrigerant: "refrigerant", tonnage: "tonnage", installation_date: "installation_date", warranty_registered_date: "warranty_registered_date" }[factId];
  return customerUnits(ix, custId).map((u) => ({ unit: u, value: u.data?.[key] ? (factId.endsWith("_date") ? human(u.data[key]) : String(u.data[key])) : null }));
}
export const UNIT_FACTS = ["manufacturer", "model", "serial_number", "refrigerant", "tonnage", "installation_date", "warranty_registered_date"];
export function customerFactValue(c, factId) {
  const v = { customer_address: c.data?.service_address, customer_phone: c.data?.phone, customer_email: c.data?.email, customer_number: c.customer_number }[factId];
  return v ? String(v) : null;
}
export const CUSTOMER_FACTS = ["customer_address", "customer_phone", "customer_email", "customer_number"];

/** an honest "not stored" / "no answer" reading of an answer's text */
export const NOT_STORED_RE = /\b(?:not stored|is not stored|are not stored|no [a-z ]+ (?:is|are) stored|not on file|isn'?t (?:stored|recorded|on file)|does not (?:record|have|carry)|do not carry|not recorded|none (?:is )?stored|nothing (?:is )?stored|no [a-z ]+ on file|doesn'?t (?:have|record))\b/i;
export const DECLINE_RE = /\b(?:i can'?t answer|i couldn'?t find|nothing in your records|don'?t see|no match|not sure|can'?t tell)\b/i;
