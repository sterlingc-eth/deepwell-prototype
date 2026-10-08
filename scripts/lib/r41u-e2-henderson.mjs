// E2 A7 fixture: the golden export plus look-alike customers (three Hendersons, a Henderson-ish business, an unrelated unpaid invoice) with known unpaid money.
import * as F from "./r40-fixture.mjs";
export const HEND = {
  mark: { name: "Mark Henderson", addr: "21 W Palm Ln, Mesa, AZ 85201", inv: [["INV-H101", "2026-08-02", 1500], ["INV-H102", "2026-08-20", 640]] },
  paula: { name: "Paula Henderson", addr: "88 E Elm St, Gilbert, AZ 85234", inv: [["INV-H201", "2026-07-11", 3000]] },
  roof: { name: "Henderson Roofing LLC", addr: "400 N Main St, Mesa, AZ 85201", inv: [["INV-H301", "2026-09-01", 2000]] },
  other: { name: "Carla Ostrowski", addr: "9 S Oak Ave, Tempe, AZ 85281", inv: [["INV-H401", "2026-09-03", 750]] },
};
export function hendersonExport(key = "r41u-e2a7", { paidMark = null } = {}) {
  const d = F.loadGolden(); d.tenantKey = key; d.tenantName = key;
  for (const [k, o] of Object.entries(HEND)) {
    const cid = F.addCustomer(d, o.name, o.addr);
    for (const [num, iso, total] of o.inv) {
      const r = F.addInvoice(d, { num, customer: o.name, customerId: cid, dateIso: iso, dateUs: iso, addr: o.addr, desc: "service work", total, filename: `${num}.pdf` });
      const f = d.financials.find((x) => x.id === r.fid); f.status = "unpaid"; f.balance_due = String(total); f.amount_paid = "0";
      if (paidMark && k === "mark" && num === paidMark) { f.status = "paid"; f.balance_due = "0"; f.amount_paid = String(total); }
      f.customer_id = cid;
    }
  }
  return d;
}
export const openOf = (d, pred) => d.financials.filter((f) => f.status === "unpaid" && f.direction === "receivable" && pred(f)).reduce((a, f) => a + Number(f.balance_due ?? f.total ?? 0), 0);
export const fmt = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** E2 A7: lease documents (type lease-agreement) carrying lease_end_date / tenant_name extractions. ends: [[tenant, unit, endDate|null], ...] */
export function addLeases(d, ends) {
  const out = [];
  ends.forEach(([tenant, unit, end], i) => {
    const did = F.nid();
    d.documents.push({ id: did, batch_id: null, original_filename: `lease-${i + 1}.pdf`, document_type: "lease-agreement", sha256_hash: String(did).replace(/\D/g, "").padEnd(64, "c").slice(0, 64), file_size_bytes: 900, stage: "linked", created_at: "2026-01-05T12:00:00Z", processed_at: "2026-01-05T12:00:00Z" });
    d.pages.push({ id: F.nid(), document_id: did, page_no: 1, text: `Residential Lease\nTenant: ${tenant}\nUnit: ${unit}\n${end ? `Lease end: ${end}\n` : ""}`, created_at: "2026-01-05T12:00:00Z" });
    const ex = (k, v) => d.extractions.push({ id: F.nid(), document_id: did, entity_id: null, field_key: k, value: v, confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: "2026-01-05T12:00:00Z" });
    ex("tenant_name", tenant); ex("unit_number", unit); if (end) ex("lease_end_date", end);
    out.push(did);
  });
  return out;
}
