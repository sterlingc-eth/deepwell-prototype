// RECORDS-R1 fixture: a multi-document organization built from raw rows (documents, pages, extractions, financials, lines, entities, links).
// Unlike the golden export (ONE invoice per customer) every customer here has several invoices, service tickets and units, two customers share a
// surname, a customer and a vendor have similar names, and a second organization (variant "B") holds the same names with different data.
// The page text is BUILT from the rows, and every expectation in the tests is computed from the raw rows (truth.js helpers), never from Donovan.
import fs from "node:fs";
import { makeRng } from "./rng.mjs";

export const GOLDEN = "scripts/golden/golden-export.json";
export const loadGolden = () => JSON.parse(fs.readFileSync(GOLDEN, "utf8"));

const FIRST = ["Alma", "Bruno", "Celia", "Dario", "Elsa", "Felix", "Greta", "Hector", "Irene", "Jonas", "Kira", "Leon", "Marta", "Nolan", "Opal", "Pablo", "Quinn", "Rosa", "Silas", "Tessa"];
const LAST = ["Abernathy", "Brandt", "Castellanos", "Dunmore", "Eastwood", "Farragut", "Galloway", "Hollis", "Ingram", "Jessup", "Kowalski", "Lindqvist", "Marlowe", "Nakamura", "Oyelaran", "Pennington", "Quigley", "Rutledge", "Sandoval", "Tillman"];
const STREETS = ["E Main St", "W Baseline Rd", "N Alma School Rd", "S Mesquite Ave", "E Ocotillo Dr", "W Palo Verde Ln", "N Yucca Way", "S Saguaro Ct"];
const CITIES = [["Mesa", "85201"], ["Tempe", "85281"], ["Chandler", "85224"], ["Phoenix", "85001"], ["Gilbert", "85233"]];
const TECHS = ["Danny Ochoa", "Kevin Pratt", "Ray Sutton", "Lena Voss", "Omar Haddad"];
const BRANDS = [["Trane", "4TTR4002L1000AA", "R-410A", "2 ton"], ["Carrier", "24ACC636A003", "R-410A", "3 ton"], ["Lennox", "ML14XC1-046-230", "R-410A", "4 ton"], ["Goodman", "GSX140361K", "R-22", "3 ton"], ["Rheem", "RA1448AJ1NA", "R-454B", "4 ton"]];
const WORK = ["Replaced capacitor and contactor", "Annual PM: cleaned coil, checked charge", "Flushed condensate line, replaced filter", "Diagnosed no-cooling call, replaced blower motor", "Installed new thermostat and tested", "Recharged system, repaired refrigerant leak at service valve", "Cleaned burners, checked heat exchanger"];
const NOTES = ["System operating normally after visit", "Customer asked about a maintenance plan", "Recommend replacing filter every 90 days", "Access through the side gate"];
const PARTS = [["Capacitor 45/5 MFD", 38.5], ["Contactor 30A", 27.25], ["Blower motor 1/2 HP", 312], ["Filter 20x25x1", 14.75], ["Thermostat programmable", 129], ["R-410A refrigerant (2 lb)", 96]];
const SERVICE_TYPES = ["Preventive Maintenance", "Repair", "Emergency", "Inspection"];

const money = (n) => Number(n).toFixed(2);
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** Build one organization. variant "A" = main fixture, "B" = second organization (same names, different data + one canary-only customer). */
export function buildRecordsFixture({ variant = "A", seed = 7, extraCustomers = 14 } = {}) {
  const rng = makeRng(variant === "A" ? seed : seed + 1000);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const d = loadGolden();
  for (const k of ["documents", "pages", "extractions", "entities", "document_entity_links", "facets", "audit_log", "financials", "financial_lines"]) d[k] = [];
  d.tenantKey = `records-${variant}`; d.tenantName = `records-${variant}`;
  let seq = 1;
  const ID = () => `${variant === "A" ? "a1" : "b2"}ec0000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
  const truth = { customers: [], vendors: [], variant };
  const prefix = variant === "A" ? "" : "B";

  let invSeq = variant === "A" ? 20000 : 80000, woSeq = variant === "A" ? 40000 : 90000, poSeq = variant === "A" ? 9000 : 9500, permSeq = variant === "A" ? 10000 : 10500;

  function addCustomer(name, { addr, phone, email } = {}) {
    const id = ID();
    const [city, zip] = pick(CITIES);
    const address = addr ?? `${100 + Math.floor(rng() * 8800)} ${pick(STREETS)}, ${city}, AZ ${zip}`;
    const ph = phone === undefined ? `(480) 555-${String(1000 + Math.floor(rng() * 8999))}` : phone;
    const data = { customer_name: name, service_address: address };
    if (ph) data.phone = ph;
    const em = email === undefined ? `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com` : email;
    if (em) data.email = em;
    d.entities.push({ id, entity_type: "customer", merged_into: null, customer_number: `C-${prefix}${String(id.slice(-4))}`, data, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    const rec = { id, name, address, phone: ph, email: em, units: [], docs: [] };
    truth.customers.push(rec);
    return rec;
  }
  function addUnit(cust, brandIdx, { withWarranty = true, installIso } = {}) {
    const id = ID();
    const [mf, model, refrig, ton] = BRANDS[brandIdx % BRANDS.length];
    const serial = `${mf.slice(0, 2).toUpperCase()}${100000 + Math.floor(rng() * 899999)}`;
    const data = { serial_number: serial, model, manufacturer: mf, installation_date: installIso, tonnage: ton, refrigerant: refrig, service_address: cust.address };
    if (withWarranty) data.warranty_registered_date = installIso.replace(/-\d\d$/, "-15");
    d.entities.push({ id, entity_type: "equipment", merged_into: null, customer_id: cust.id, data, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    const u = { id, serial, model, manufacturer: mf, refrigerant: refrig, tonnage: ton, installation_date: installIso, warranty_registered_date: data.warranty_registered_date ?? null };
    cust.units.push(u);
    return u;
  }
  function addDoc(cust, unit, { type, iso, filename, pages }) {
    const did = ID();
    d.documents.push({ id: did, batch_id: null, original_filename: filename, document_type: type, sha256_hash: did.replace(/\D/g, "").padEnd(64, "c").slice(0, 64), file_size_bytes: 1500, stage: "linked", created_at: `${iso}T12:00:00Z`, processed_at: `${iso}T12:00:00Z` });
    pages.forEach((text, i) => d.pages.push({ id: ID(), document_id: did, page_no: i + 1, text, created_at: `${iso}T12:00:00Z` }));
    if (cust) d.document_entity_links.push({ id: ID(), document_id: did, entity_id: cust.id, confidence: 0.9, linked_by: "records-fixture", created_at: `${iso}T12:00:00Z` });
    if (unit) d.document_entity_links.push({ id: ID(), document_id: did, entity_id: unit.id, confidence: 0.85, linked_by: "records-fixture", created_at: `${iso}T12:00:00Z` });
    const rec = { id: did, type, iso, filename, customerId: cust?.id ?? null, unitId: unit?.id ?? null, fields: [], financial: null, lines: [], pages };
    (cust ?? truth).docs?.push(rec);
    return rec;
  }
  const ex = (doc, key, value, unit) => {
    if (value == null || value === "") return;
    d.extractions.push({ id: ID(), document_id: doc.id, entity_id: unit?.id ?? null, field_key: key, value: String(value), confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: `${doc.iso}T12:00:00Z` });
    doc.fields.push({ key, value: String(value) });
  };
  const fin = (doc, row, lines, cust) => {
    const fid = ID();
    const f = { id: fid, document_id: doc.id, doc_kind: "invoice", direction: "receivable", currency: "USD", invoice_number: null, po_number: null, invoice_date: doc.iso, due_date: null, period_start: null, period_end: null, agreement_term: null, subtotal: null, tax: null, total: null, amount_paid: null, balance_due: null, status: "unknown", customer_name: cust?.name ?? null, vendor_name: null, confidence: 0.8, flags: [], evidence: row.total != null ? { total: { page: row.totalPage ?? 1, verbatim: `TOTAL DUE: ${usd(row.total)}`, confidence: 0.8 } } : {}, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: "records-fixture", extracted_at: `${doc.iso}T12:00:00Z`, created_at: `${doc.iso}T12:00:00Z`, ...row };
    d.financials.push(f);
    lines.forEach((l, i) => d.financial_lines.push({ id: ID(), financial_id: fid, document_id: doc.id, line_no: i + 1, description: l.description, qty: l.qty ?? null, unit_price: l.unit_price ?? null, amount: l.amount != null ? money(l.amount) : null, category_guess: l.category_guess ?? null, page_no: l.page_no ?? 1 }));
    doc.financial = f; doc.lines = lines;
  };

  // ---- an invoice for one customer (detailed with labor + parts lines, or golden-style single line), with its page text built from the rows ----
  function invoice(cust, unit, iso, { detailed, status = "unknown", technician = true, laborHours = true, notes = false, twoPages = false, num } = {}) {
    const n = num ?? `INV-${++invSeq}`;
    const tech = technician ? pick(TECHS) : null;
    const work = pick(WORK);
    const hrs = laborHours ? pick(["1.0", "1.5", "2.0", "2.5", "3.0"]) : null;
    const lines = []; let subtotal = 0, tax = null, total;
    if (detailed) {
      const rate = 95; const h = Number(hrs ?? 1.5);
      lines.push({ description: `Labor (${h} hrs @ $${rate}.00/hr)`, qty: h, unit_price: rate, amount: h * rate, category_guess: "labor", page_no: 1 });
      const np = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < np; i++) { const [pn, pp] = pick(PARTS); lines.push({ description: pn, qty: 1, unit_price: pp, amount: pp, category_guess: "parts", page_no: twoPages ? 2 : 1 }); }
      subtotal = lines.reduce((a, l) => a + Math.round(l.amount * 100), 0) / 100;
      tax = Math.round(subtotal * 0.086 * 100) / 100; total = Math.round((subtotal + tax) * 100) / 100;
    } else {
      total = 150 + Math.floor(rng() * 5000);
      lines.push({ description: work, amount: total, page_no: 1 });
    }
    const p1 = ["Sonoran Comfort Air", "4410 E Baseline Rd, Mesa, AZ 85206", "INVOICE", `Invoice #: ${n}`, `Date: ${us(iso)}`, `Bill To: ${cust.name}`, `Service Address: ${cust.address}`,
      unit ? `Equipment: ${unit.manufacturer} ${unit.model}` : null, unit ? `Serial: ${unit.serial}` : null, "Description of work:", work, hrs ? `Labor: ${hrs} hrs` : null,
      ...(twoPages ? ["(continued on page 2)"] : lines.map((l) => `${l.description}  ${usd(l.amount)}`)),
      ...(twoPages ? [] : [subtotal && detailed ? `Subtotal: ${usd(subtotal)}` : null, tax != null ? `Tax: ${usd(tax)}` : null, `TOTAL DUE: ${usd(total)}`]),
      tech ? `Technician: ${tech}` : null, notes ? `Notes: ${pick(NOTES)}` : null].filter(Boolean).join("\n");
    const pages = [p1];
    if (twoPages) pages.push([`Invoice ${n} page 2`, ...lines.map((l) => `${l.description}  ${usd(l.amount)}`), `Subtotal: ${usd(subtotal)}`, `Tax: ${usd(tax)}`, `TOTAL DUE: ${usd(total)}`].join("\n"));
    const doc = addDoc(cust, unit, { type: "invoice", iso, filename: `${n.toLowerCase()}.pdf`, pages });
    const noteVal = notes ? p1.split("\n").find((l) => l.startsWith("Notes: "))?.slice(7) : null;
    ex(doc, "invoice_number", n, unit); ex(doc, "invoice_date", iso, unit); ex(doc, "work_performed", work, unit); ex(doc, "labor_hours", hrs, unit); ex(doc, "technician", tech, unit); ex(doc, "notes", noteVal, unit);
    if (unit) { ex(doc, "manufacturer", unit.manufacturer, unit); ex(doc, "model", unit.model, unit); ex(doc, "serial_number", unit.serial, unit); }
    const paid = status === "paid";
    fin(doc, { invoice_number: n, invoice_date: iso, subtotal: detailed ? money(subtotal) : null, tax: tax != null ? money(tax) : null, total: money(total), status, amount_paid: paid ? money(total) : null, balance_due: paid ? "0.00" : null, due_date: detailed ? iso.replace(/-(\d\d)$/, "-28") : null, totalPage: twoPages ? 2 : 1 }, lines, cust);
    doc.number = n;
    return doc;
  }
  function ticket(cust, unit, iso, { notes = true, tech = true } = {}) {
    const n = `WO-${++woSeq}`;
    const t = tech ? pick(TECHS) : null, work = pick(WORK), st = pick(SERVICE_TYPES), nt = notes ? pick(NOTES) : null, hrs = pick(["0.5", "1.0", "1.5", "2.0"]);
    const text = ["Sonoran Comfort Air", "SERVICE TICKET", `Ticket #: ${n}`, `Date of Service: ${us(iso)}`, `Customer: ${cust.name}`, `Service Address: ${cust.address}`, unit ? `Equipment: ${unit.manufacturer} ${unit.model} Serial: ${unit.serial}` : null,
      `Visit Type: ${st}`, "Work Performed:", `- ${work}`, `Labor: ${hrs} hrs`, nt ? `Notes: ${nt}` : null, t ? `Technician: ${t}` : null, "Status: Completed"].filter(Boolean).join("\n");
    const doc = addDoc(cust, unit, { type: "service-ticket", iso, filename: `${n.toLowerCase()}.pdf`, pages: [text] });
    ex(doc, "invoice_number", n, unit); ex(doc, "service_date", iso, unit); ex(doc, "service_type", st, unit); ex(doc, "work_performed", work, unit); ex(doc, "labor_hours", hrs, unit); ex(doc, "notes", nt, unit); ex(doc, "technician", t, unit); ex(doc, "status", "Completed", unit);
    doc.number = n;
    return doc;
  }
  function warranty(cust, unit) {
    const iso = unit.warranty_registered_date; if (!iso) return null;
    const text = ["WARRANTY REGISTRATION", `Customer: ${cust.name}`, `Manufacturer: ${unit.manufacturer}`, `Model: ${unit.model}`, `Serial: ${unit.serial}`, `Install Date: ${us(unit.installation_date)}`, `Registered: ${us(iso)}`, "Term: 10 year parts limited", `Refrigerant: ${unit.refrigerant}`, `Capacity: ${unit.tonnage}`].join("\n");
    const doc = addDoc(cust, unit, { type: "warranty-registration", iso, filename: `warranty-${unit.serial.toLowerCase()}.pdf`, pages: [text] });
    ex(doc, "warranty_registered_date", iso, unit); ex(doc, "warranty_term", "10 year parts limited", unit); ex(doc, "tonnage", unit.tonnage, unit); ex(doc, "refrigerant", unit.refrigerant, unit);
    ex(doc, "manufacturer", unit.manufacturer, unit); ex(doc, "model", unit.model, unit); ex(doc, "serial_number", unit.serial, unit); ex(doc, "installation_date", unit.installation_date, unit);
    return doc;
  }
  function permit(cust, unit, iso) {
    const n = `BP-2026-${++permSeq}`;
    const doc = addDoc(cust, unit, { type: "permit", iso, filename: `permit-${n.toLowerCase()}.pdf`, pages: [[`BUILDING PERMIT`, `Permit No: ${n}`, `Owner: ${cust.name}`, `Work: Residential AC change-out`, `Status: Issued`].join("\n")] });
    ex(doc, "permit_number", n, unit); ex(doc, "work_performed", "Residential AC change-out", unit); ex(doc, "status", "Issued", unit);
    doc.number = n; return doc;
  }
  function agreement(cust, iso) {
    const doc = addDoc(cust, null, { type: "maintenance-agreement", iso, filename: `agreement-${cust.id.slice(-4)}.pdf`, pages: [[`MAINTENANCE AGREEMENT`, `Customer: ${cust.name}`, `Term: 01/01/2026 - 12/31/2026`, `Annual fee: $360.00`].join("\n")] });
    ex(doc, "agreement_term", "01/01/2026 - 12/31/2026");
    fin(doc, { doc_kind: "agreement", agreement_term: "01/01/2026 - 12/31/2026", total: "360.00" }, [], cust);
    return doc;
  }
  // a QUOTE is a price proposed for work not yet done: it is never what a job cost (RECORDS-R2 cause 5)
  let quoSeq = variant === "A" ? 700 : 800;
  function quote(cust, iso, total) {
    const n = `EST-${++quoSeq}`;
    const doc = addDoc(cust, null, { type: "proposal-quote", iso, filename: `${n.toLowerCase()}.pdf`, pages: [["ESTIMATE / QUOTE", `Quote #: ${n}`, `Prepared for: ${cust.name}`, `Date: ${us(iso)}`, "Proposed work: replace outdoor unit", `QUOTED PRICE: ${usd(total)}`].join("\n")] });
    ex(doc, "invoice_number", n); ex(doc, "invoice_date", iso);
    fin(doc, { doc_kind: "estimate", invoice_number: n, total: money(total) }, [], cust);
    doc.number = n; return doc;
  }
  function purchaseOrder(vendorName, iso) {
    const n = `PO-${++poSeq}`;
    const total = 60 + Math.floor(rng() * 900);
    const doc = addDoc(null, null, { type: "purchase-order", iso, filename: `${n.toLowerCase()}.pdf`, pages: [[`PURCHASE ORDER`, `PO #: ${n}`, `Vendor: ${vendorName}`, `Date: ${us(iso)}`, `Total: ${usd(total)}`].join("\n")] });
    ex(doc, "po_number", n); ex(doc, "invoice_date", iso); ex(doc, "vendor_name", vendorName);
    fin(doc, { doc_kind: "po", direction: "payable", po_number: n, total: money(total), vendor_name: vendorName, customer_name: null }, [{ description: "Parts order", amount: total }], null);
    doc.number = n; truth.vendors.push({ name: vendorName, docs: [doc] });
    return doc;
  }

  // ---- named customers (the live-list names) ----
  const years = ["2023", "2024", "2025", "2026"];
  const dt = (y, m, dd) => `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  function standard(name, o = {}) {
    const c = addCustomer(name, o.cust);
    const nu = o.units ?? 1;
    for (let i = 0; i < nu; i++) addUnit(c, (o.brand ?? 0) + i, { installIso: dt(years[i % 2], 3 + i, 4 + i), withWarranty: o.noWarranty ? false : i === 0 });
    c.units.forEach((u, i) => { if (u.warranty_registered_date) warranty(c, u); });
    const ninv = o.invoices ?? 3;
    for (let i = 0; i < ninv; i++) invoice(c, c.units[i % c.units.length], dt(years[(i + 1) % 4], 2 + i * 2, 9 + i), { detailed: i % 2 === 0 ? !o.goldenStyle : false, status: i === 0 ? "paid" : "unknown", technician: !(o.noTech && i === 0), laborHours: !(o.noHours), notes: i === 1, twoPages: i === 2 && !o.goldenStyle });
    const ntk = o.tickets ?? 2;
    for (let i = 0; i < ntk; i++) ticket(c, c.units[i % c.units.length], dt(years[(i + 2) % 4], 5 + i, 14 + i), { notes: i === 0, tech: !(o.noTech && i === 1) });
    if (o.permit) permit(c, c.units[0], dt("2025", 6, 3));
    if (o.agreement) agreement(c, dt("2026", 1, 2));
    if (o.quote) quote(c, dt("2026", 8, 20), o.quote);
    return c;
  }
  standard("Carol Rios", { invoices: 3, tickets: 2, permit: true, quote: 8877 });
  standard("Barbara Delgado", { invoices: 2, tickets: 1, quote: 8421 });
  standard("Marcus Delgado", { invoices: 2, tickets: 2, agreement: true, quote: 9633 });          // shares a surname with Barbara Delgado
  standard("Brian Chavez", { invoices: 2, tickets: 1, goldenStyle: true });
  standard("Thomas Mercer", { invoices: 2, tickets: 2, units: 2, brand: 1 });          // two units
  standard("Kenneth Fenwick", { invoices: 2, tickets: 1, noWarranty: true });
  standard("Donna Thornton", { invoices: 2, tickets: 1 });
  standard("Donna Ulloa", { invoices: 1, tickets: 1, noTech: true, noHours: true });  // shares a first name; missing technician / hours
  standard("Sorensen", { invoices: 1, tickets: 0, cust: { phone: null, email: null } });  // stored as a single word, no phone/email
  standard("Baker Dolan", { invoices: 2, tickets: 1 });                                 // customer whose name resembles the vendor below
  standard("Linda Fitzgerald", { invoices: 3, tickets: 2, goldenStyle: true });
  standard("Mark Henderson", { invoices: 4, tickets: 2, units: 2 });
  standard("Kathleen Jennings", { invoices: 2, tickets: 2 });
  if (variant === "A") {
    purchaseOrder("Baker Distributing", "2026-04-02"); purchaseOrder("Baker Distributing", "2026-06-11"); purchaseOrder("Carrier Supply Co", "2026-05-20");
  } else {
    purchaseOrder("Baker Distributing", "2026-03-05");
    // canary-only customer: exists ONLY in organization B, with values nobody else has
    const z = addCustomer("Zelda Quillfeather", { addr: "9 Canary Ct, Mesa, AZ 85201", phone: "(480) 555-0777" });
    const zu = addUnit(z, 2, { installIso: "2025-05-05" });
    const zd = invoice(z, zu, "2026-08-08", { detailed: true, technician: true });
    zd.fields.find((f) => f.key === "technician").value = zd.fields.find((f) => f.key === "technician").value; // (value untouched; canary technician below)
    const ct = d.extractions.find((e) => e.document_id === zd.id && e.field_key === "technician"); ct.value = "Canary Zeta"; zd.fields.find((f) => f.key === "technician").value = "Canary Zeta";
    zd.pages[0] = zd.pages[0].replace(/Technician: .*/, "Technician: Canary Zeta"); d.pages.find((p) => p.document_id === zd.id).text = zd.pages[0];
  }
  // generated customers so the property test has plenty of entities (each with several documents and a unit)
  for (let i = 0; i < extraCustomers; i++) {
    const nm = `${FIRST[i % FIRST.length]} ${LAST[(i * 3 + 1) % LAST.length]}`;
    standard(nm, { invoices: 1 + (i % 4), tickets: i % 3, units: 1 + (i % 2), brand: i, goldenStyle: i % 5 === 0, noTech: i % 6 === 1, noHours: i % 4 === 2, permit: i % 7 === 3, agreement: i % 8 === 5, noWarranty: i % 9 === 4 });
  }
  return { export: d, truth };
}
