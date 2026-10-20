// Entity-safety fixture: synthetic tenants seeded with NEAR-DUPLICATE customers (same names with different middle initials / suffixes,
// identical names at different addresses, same street with different units, same street in different cities, business punctuation variants).
// Every customer has values no other customer shares (phone, email, invoice number, invoice total, a full address string), so a response can be
// checked for "whose data is this". Output is an export object loadable with loadExportIntoNewTenant (same shape as scripts/fixtures/reader-v2/companies).
import crypto from "node:crypto";
import { mulberry } from "./handoff-rng.mjs";

const uuid = (r) => { const b = Array.from({ length: 16 }, () => Math.floor(r() * 256)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = Buffer.from(b).toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const CITIES = [["Mesa", "AZ", "85201"], ["Tempe", "AZ", "85281"], ["Gilbert", "AZ", "85234"], ["Chandler", "AZ", "85224"], ["Phoenix", "AZ", "85004"], ["Scottsdale", "AZ", "85251"]];

/** The near-duplicate groups. Each customer: {name, street, unit?, city index}. `kind` says what the group tests. */
function groups(v) {
  // v = variant (0 for tenant A, 1 for tenant B, 2 for tenant C): different first names / streets, same structure
  const F = [["John", "Smith"], ["Maria", "Lopez"], ["Robert", "Nguyen"], ["Linda", "Castillo"]][v % 4];
  const F2 = [["Sandra", "Wyckoff"], ["Daniel", "Okafor"], ["Teresa", "Brandt"], ["Marcus", "Whitfield"]][v % 4];
  const st = [["Main St", "Oak Ave", "Palm Ln", "Elm Dr"], ["Cedar Ct", "Pine Rd", "Maple Way", "Birch Blvd"], ["Sunset Dr", "Ridge Rd", "Lake St", "Hill Ct"], ["Canal Dr", "Mesa Dr", "Vista Ln", "Rose St"]][v % 4];
  const biz = [["ABC Plumbing", "A.B.C. Plumbing LLC", "ABC Plumbing & Heating"], ["Desert Ridge Dental", "Desert Ridge Dental LLC", "Desert Ridge Dentistry"], ["Sun Valley Auto", "Sun Valley Auto, Inc.", "Sun-Valley Automotive"], ["Copper State Roofing", "Copper State Roofing LLC", "Copper State Roofers"]][v % 4];
  const n = (x) => 100 + v * 211 + x;
  return [
    { kind: "suffix-initial", rows: [
      { name: `${F[0]} ${F[1]}`, num: n(12), street: st[2], c: 0 },
      { name: `${F[0]} ${F[1]} Jr.`, num: n(48), street: st[3], c: 0 },
      { name: `${F[0]} ${F[1]} Sr.`, num: n(77), street: st[0], c: 2 },
      { name: `${F[0]} A. ${F[1]}`, num: n(305), street: st[1], c: 1 },
      { name: `${F[0]} B. ${F[1]}`, num: n(306), street: st[1], c: 3 },
      { name: `${F[0].slice(0, -1)} ${F[1]}`, num: n(912), street: st[2], c: 4 },
    ] },
    { kind: "same-name-diff-address", rows: [
      { name: `${F2[0]} ${F2[1]}`, num: n(1001), street: st[0], c: 0 },
      { name: `${F2[0]} ${F2[1]}`, num: n(2210), street: st[1], c: 5 },
    ] },
    { kind: "same-address-diff-unit", rows: [
      { name: "Aaron Cole", num: n(500), street: st[0], unit: "Apt 2", c: 0 },
      { name: "Beth Dunn", num: n(500), street: st[0], unit: "Apt 3", c: 0 },
      { name: "Cara Webb", num: n(500), street: st[0], unit: "Unit 5", c: 0 },
      { name: "Dale Ngo", num: n(500), street: st[0], unit: "Suite 12", c: 0 },
      { name: "Elena Vargas", num: n(500), street: st[0], c: 0 },
    ] },
    { kind: "same-street-diff-city", rows: [
      { name: "Frank Ortiz", num: n(740), street: st[1], c: 0 },
      { name: "Gwen Hale", num: n(740), street: st[1], c: 1 },
      { name: "Hugo Lang", num: n(740), street: st[1], c: 2 },
    ] },
    { kind: "business-variants", rows: [
      { name: biz[0], num: n(60), street: st[2], c: 0 },
      { name: biz[1], num: n(61), street: st[3], c: 1 },
      { name: biz[2], num: n(62), street: st[1], c: 3 },
    ] },
    { kind: "typo-pair", rows: [
      { name: "Kathryn Pemberton", num: n(15), street: st[2], c: 0 },
      { name: "Katharine Pemberton", num: n(16), street: st[3], c: 1 },
    ] },
    { kind: "unique", rows: [
      { name: "Zelda Quillfeather", num: n(25), street: st[0], c: 0 },
      { name: "Oberon Ashgrove", num: n(26), street: st[1], c: 1 },
      { name: "Priya Venkataraman", num: n(27), street: st[2], c: 2 },
      { name: "Quentin Vandersloot", num: n(28), street: st[3], c: 3 },
    ] },
  ];
}

export function buildEntityTenant({ seed = 1, variant = 0, key = "es_a" } = {}) {
  const r = mulberry(seed * 7919 + variant);
  const entities = [], documents = [], pages = [], extractions = [], links = [], financials = [];
  const customers = [];
  let seq = 0;
  const phoneUsed = new Set();
  for (const g of groups(variant)) {
    for (const row of g.rows) {
      seq += 1;
      const city = CITIES[row.c];
      const street = `${row.num} ${row.street}`;
      const addrStreet = row.unit ? `${street} ${row.unit}` : street;
      const address = `${addrStreet}, ${city[0]}, ${city[1]} ${city[2]}`;
      let last4; do { last4 = String(1000 + Math.floor(r() * 8999)); } while (phoneUsed.has(last4)); phoneUsed.add(last4);
      const phone = `(480) 555-${last4}`;
      const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14);
      const email = `${slug}${seq}@example${variant}.com`;
      const id = uuid(r);
      entities.push({ id, entity_type: "customer", merged_into: null, customer_number: `C-${String(seq).padStart(5, "0")}`, data: { customer_name: row.name, service_address: address, phone, email }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      const invoices = [];
      const nInv = 2;
      for (let i = 0; i < nInv; i++) {
        const did = uuid(r);
        const no = `INV-${variant + 1}${String(seq).padStart(3, "0")}${i + 1}`;
        const total = (1000 + (variant * 60 + seq) * 31 + i * 3000 + 0.35).toFixed(2);
        const date = `2026-0${1 + ((seq + i * 3) % 8)}-${String(3 + ((seq * 5 + i * 11) % 24)).padStart(2, "0")}`;
        documents.push({ id: did, batch_id: null, original_filename: `${no}.pdf`, document_type: "invoice", sha256_hash: crypto.createHash("sha256").update(did).digest("hex"), file_size_bytes: 2000, stage: "linked", created_at: `${date}T12:00:00Z`, processed_at: `${date}T12:00:00Z` });
        pages.push({ id: uuid(r), document_id: did, page_no: 1, text: `Copper Valley Service Co\nINVOICE\nCustomer: ${row.name}\nService address: ${address}\nInvoice number: ${no}\nDate: ${date}\nTOTAL: $${total}`, created_at: `${date}T12:00:00Z` });
        for (const [fk, val] of [["customer_name", row.name], ["service_address", address], ["invoice_number", no], ["service_date", date], ["cost", total]]) extractions.push({ id: uuid(r), document_id: did, entity_id: null, field_key: fk, value: val, confidence: 0.95, source_facet_id: null, schema_version: 1, created_at: `${date}T12:00:00Z` });
        links.push({ id: uuid(r), document_id: did, entity_id: id, confidence: 0.95, linked_by: "factory", created_at: `${date}T12:00:00Z` });
        financials.push({ id: uuid(r), document_id: did, doc_kind: "invoice", direction: "receivable", currency: "USD", invoice_number: no, po_number: null, invoice_date: date, due_date: null, period_start: null, period_end: null, agreement_term: null, subtotal: null, tax: null, total, amount_paid: null, balance_due: null, status: "unknown", customer_name: row.name, vendor_name: null, confidence: 0.95, flags: [], evidence: {}, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: "factory", extracted_at: `${date}T12:00:00Z`, created_at: `${date}T12:00:00Z`, job_key: null, job_key_source: null, job_confidence: 0, job_raw: null });
        invoices.push({ no, total, date });
      }
      invoices.sort((a, b) => (a.date < b.date ? 1 : -1));
      customers.push({ id, group: g.kind, name: row.name, street: addrStreet, city: city[0], address, phone, last4, email, invoices, lastDate: invoices[0].date });
    }
  }
  return { export: { industry: "hvac", tenantKey: key, tenantName: key, exportedAt: "2026-10-07T12:00:00Z", documents, pages, extractions, entities, document_entity_links: links, facets: [], audit_log: [], truncated: false, financials, financial_lines: [] }, customers };
}
