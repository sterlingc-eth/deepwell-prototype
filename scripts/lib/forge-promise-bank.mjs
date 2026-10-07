// FORGE website-promise bank: realistic fake orgs with look-alike traps, 24 website questions x 5 phrasings, truth from the raw rows.
// Data only (no I/O). Org A = "Desert Ridge Services" (traps), org B = "Bell Road Property Co" (look-alikes with different figures; isolation).
let seq = 1;
const id = (n) => `f0e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const nid = () => id(seq++);
const SITE = ["Desert Ridge Services", "1200 E Southern Ave, Mesa, AZ 85204", "(480) 555-0142"];
const ISO_US = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

function newOrg(name) {
  return { tenantKey: `forge:${name}`, tenantName: name, exportedAt: "2026-10-07T00:00:00Z", documents: [], pages: [], extractions: [], entities: [], document_entity_links: [], facets: [], audit_log: [], truncated: false, financials: [], financial_lines: [] };
}
function customer(d, name, addr) {
  const eid = nid();
  d.entities.push({ id: eid, entity_type: "customer", merged_into: null, customer_number: `C-F${String(eid).slice(-4)}`, data: { customer_name: name, service_address: addr }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  return eid;
}
function equipment(d, cid, addr, { mfr, model, serial, install, expires, kind = "furnace" }) {
  const eid = nid();
  d.entities.push({ id: eid, entity_type: "equipment", merged_into: null, customer_id: cid, data: { serial_number: serial, model, manufacturer: mfr, equipment_type: kind, installation_date: install, warranty_registered_date: install, warranty: { brand: mfr.toLowerCase(), brandLabel: mfr, brandVerified: true, installDate: install, installDatePrecision: "day", registrationOnFile: install, registrationPrecision: "day", registrationState: "on_file", expires, expiresBasis: "computed", expiresPrecision: "day", termYears: 10, termConditional: false, notes: [], sources: { installDate: null, registrationOnFile: null, expires: null } }, service_address: addr }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  return eid;
}
/** one document + page + extractions + links (+ optional financial row). o: {type,file,date(iso),lines[],cids[],ex{},fin{}} */
function doc(d, o) {
  const did = nid(), iso = o.date;
  d.documents.push({ id: did, batch_id: null, original_filename: o.file, document_type: o.type, sha256_hash: String(did).replace(/\D/g, "").padEnd(64, "c").slice(0, 64), file_size_bytes: 1200, stage: "linked", created_at: `${iso}T12:00:00Z`, processed_at: `${iso}T12:00:00Z` });
  d.pages.push({ id: nid(), document_id: did, page_no: 1, text: [...SITE, o.title ?? o.type.toUpperCase(), ...o.lines].join("\n"), created_at: `${iso}T12:00:00Z` });
  for (const [k, v] of Object.entries(o.ex ?? {})) d.extractions.push({ id: nid(), document_id: did, entity_id: null, field_key: k, value: v, confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: `${iso}T12:00:00Z` });
  for (const cid of o.cids ?? []) d.document_entity_links.push({ id: nid(), document_id: did, entity_id: cid, confidence: 0.9, linked_by: "forge", created_at: `${iso}T12:00:00Z` });
  if (o.fin) {
    const f = o.fin, fid = nid(), total = f.total == null ? null : String(f.total);
    d.financials.push({ id: fid, document_id: did, doc_kind: f.kind ?? "invoice", direction: f.direction ?? "receivable", currency: "USD", invoice_number: f.num ?? null, po_number: null, invoice_date: iso, due_date: null, period_start: null, period_end: null, agreement_term: f.term ?? null, subtotal: null, tax: null, total, amount_paid: f.paid ?? null, balance_due: f.balance ?? null, status: f.status ?? "unknown", customer_name: f.customer ?? null, vendor_name: f.vendor ?? null, confidence: 0.9, flags: [], evidence: total ? { total: { page: 1, verbatim: `Total: $${total}`, confidence: 0.9 } } : {}, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: "forge", extracted_at: `${iso}T12:00:00Z`, created_at: `${iso}T12:00:00Z`, job_key: null, job_key_source: null, job_confidence: 0, job_raw: null });
    if (total) d.financial_lines.push({ id: nid(), financial_id: fid, document_id: did, line_no: 1, description: f.desc ?? "Services", qty: null, unit_price: null, amount: total, category_guess: null, page_no: 1 });
  }
  return did;
}
const inv = (d, { num, customer, cid, date, total, status = "unpaid", file }) =>
  doc(d, { type: "invoice", file: file ?? `${num}.pdf`, date, cids: cid ? [cid] : [], ex: { invoice_number: num, invoice_date: date },
    lines: [`Invoice #: ${num}`, `Date: ${ISO_US(date)}`, `Bill To: ${customer}`, `Total: $${total}`, `Status: ${status}`],
    fin: { num, customer, total, status, balance: status === "paid" ? "0.00" : String(total), paid: status === "paid" ? String(total) : null } });
const bill = (d, { vendor, date, total, file }) =>
  doc(d, { type: "invoice", file, date, ex: { invoice_date: date }, lines: [`Vendor: ${vendor}`, `Bill date: ${ISO_US(date)}`, `Amount paid: $${total}`, "Status: paid"], title: "VENDOR BILL",
    fin: { kind: "invoice", direction: "payable", vendor, customer: null, total, status: "paid", paid: String(total), balance: "0.00" } });
const agreement = (d, { who, cid, start, end, file, vendor = false }) =>
  doc(d, { type: "maintenance-agreement", file, date: start, cids: cid ? [cid] : [], title: vendor ? "VENDOR AGREEMENT" : "SERVICE AGREEMENT", ex: { agreement_term: `${ISO_US(start)} - ${ISO_US(end)}` },
    lines: [vendor ? `Vendor: ${who}` : `Customer: ${who}`, `Agreement Period: ${ISO_US(start)} - ${ISO_US(end)}`, "Coverage: scheduled service visits"], fin: { kind: "agreement", customer: vendor ? null : who, vendor: vendor ? who : null, term: `${ISO_US(start)} - ${ISO_US(end)}`, total: null } });

/** Org A: every trap. Returns {data, T} where T is the truth (computed alongside the rows). */
export function buildOrgA() {
  seq = 1; const d = newOrg("forge-a"); const T = {};
  const mh = customer(d, "Mark Henderson", "410 W Palm Ln, Mesa, AZ 85201");
  const hr = customer(d, "Henderson Roofing LLC", "88 Industrial Way, Mesa, AZ 85210");
  const lh = customer(d, "Lisa Hendricks", "9 Oak Ct, Gilbert, AZ 85233");
  inv(d, { num: "INV-2101", customer: "Mark Henderson", cid: mh, date: "2026-07-10", total: "1400.00" });
  inv(d, { num: "INV-2102", customer: "Mark Henderson", cid: mh, date: "2026-08-12", total: "740.00" });
  inv(d, { num: "INV-2090", customer: "Mark Henderson", cid: mh, date: "2026-03-01", total: "900.00", status: "paid" });
  inv(d, { num: "INV-1888", customer: "Mark Henderson", cid: mh, date: "2025-06-20", total: "1100.00", status: "paid" });
  inv(d, { num: "INV-3301", customer: "Henderson Roofing LLC", cid: hr, date: "2026-06-01", total: "5000.00" });
  inv(d, { num: "INV-3350", customer: "Lisa Hendricks", cid: lh, date: "2026-09-01", total: "750.00" });
  T.henderson = { mark: "2,140.00", markInv: ["1,400.00", "740.00"], roofing: "5,000.00", lisa: "750.00", last2025: "1,100.00" };
  // vendors
  bill(d, { vendor: "Acme Supply", date: "2026-03-04", total: "1250.00", file: "acme-bill-0304.pdf" });
  bill(d, { vendor: "Acme Supply", date: "2026-03-18", total: "430.00", file: "acme-bill-0318.pdf" });
  bill(d, { vendor: "Acme Supply", date: "2026-02-10", total: "900.00", file: "acme-bill-0210.pdf" });
  bill(d, { vendor: "Acme Roofing Supply", date: "2026-03-09", total: "2000.00", file: "acme-roofing-bill-0309.pdf" });
  bill(d, { vendor: "Bluebird Janitorial", date: "2026-03-15", total: "640.00", file: "bluebird-bill-0315.pdf" });
  T.acme = { march: "1,680.00", parts: ["1,250.00", "430.00"], roofing: "2,000.00" }; T.bluebird = { march: "640.00" };
  // contracts
  const sm = customer(d, "Carl Smith", "22 Birch Rd, Tempe, AZ 85281"); const ss = customer(d, "Smithson Plumbing", "5 Pipe St, Tempe, AZ 85282");
  agreement(d, { who: "Carl Smith", cid: sm, start: "2026-04-01", end: "2027-03-31", file: "smith-agreement.pdf" });
  agreement(d, { who: "Smithson Plumbing", cid: ss, start: "2026-01-01", end: "2026-12-31", file: "smithson-agreement.pdf" });
  const ok = customer(d, "Chidi Okafor", "14 Willow Dr, Mesa, AZ 85203"); const od = customer(d, "Okafor Dental", "600 Dental Plz, Tempe, AZ 85283");
  agreement(d, { who: "Chidi Okafor", cid: ok, start: "2026-01-16", end: "2027-01-15", file: "okafor-agreement.pdf" });
  agreement(d, { who: "Okafor Dental", cid: od, start: "2025-12-01", end: "2026-11-30", file: "okafor-dental-agreement.pdf" });
  agreement(d, { who: "Bluebird Janitorial", start: "2026-01-01", end: "2026-12-31", file: "vendor-bluebird.pdf", vendor: true });
  agreement(d, { who: "Cactus Pest Control", start: "2026-03-01", end: "2027-02-28", file: "vendor-cactus.pdf", vendor: true });
  T.smith = { end: "03/31/2027", endIso: "2027-03-31", other: "12/31/2026" }; T.okafor = { end: "01/15/2027", endIso: "2027-01-15", other: "11/30/2026" };
  T.vendorAgr = { bluebird: "12/31/2026", cactus: "02/28/2027" };
  // permits
  const r12 = customer(d, "Rosa Delgado", "12 Main St, Mesa, AZ 85201"); const r112 = customer(d, "Tom Ng", "112 Main St, Mesa, AZ 85201");
  doc(d, { type: "permit", file: "permit-12-main.pdf", date: "2026-05-02", cids: [r12], title: "BUILDING PERMIT", ex: { permit_number: "BP-2026-1201", status: "Signed off" }, lines: ["Permit No: BP-2026-1201", "Site Address: 12 Main St, Mesa, AZ 85201", "Scope: water heater replacement", "Status: Signed off 05/02/2026 by inspector J. Ortiz"] });
  doc(d, { type: "permit", file: "permit-112-main.pdf", date: "2026-06-10", cids: [r112], title: "BUILDING PERMIT", ex: { permit_number: "BP-2026-1288", status: "Issued" }, lines: ["Permit No: BP-2026-1288", "Site Address: 112 Main St, Mesa, AZ 85201", "Scope: panel upgrade", "Status: Issued"] });
  T.permit12 = { file: "permit-12-main.pdf", no: "BP-2026-1201" };
  // 3247 Elm (3 customers) + warranties + services
  const elm = [["Lee Martinez", "3247 Elm St, Mesa, AZ 85201", "2026-11-20", "2016-11-20", "2026-08-14"], ["Dana Brooks", "3247 Elm St Unit B, Mesa, AZ 85201", "2029-03-01", "2019-03-01", "2026-06-02"], ["Pat Quinn", "3247 Elm St Unit C, Mesa, AZ 85201", "2024-05-05", "2014-05-05", "2025-11-20"]];
  T.elm = { docs: [], services: {}, expires: {} };
  elm.forEach(([nm, addr, exp, ins, svc], i) => {
    const c = customer(d, nm, addr); equipment(d, c, addr, { mfr: "Lennox", model: `ML180-${i}`, serial: `ELM${i}00`, install: ins, expires: exp });
    const f = `elm-service-${i}.pdf`; doc(d, { type: "service-ticket", file: f, date: svc, cids: [c], title: "SERVICE TICKET", lines: [`Customer: ${nm}`, `Service Address: ${addr}`, `Service date: ${ISO_US(svc)}`, "Work: furnace tune-up"], ex: { service_date: svc } });
    T.elm.docs.push(f); T.elm.services[nm] = ISO_US(svc); T.elm.expires[nm] = ISO_US(exp);
  });
  // units/warranties inside 90 days of 2026-10-07 (to 2027-01-05): Lee Martinez furnace 2026-11-20 (above) + Carl Smith condenser 2026-12-15; outside: Rosa 2027-02-01, expired Pat
  equipment(d, sm, "22 Birch Rd, Tempe, AZ 85281", { mfr: "Carrier", model: "24ACC6", serial: "SM100", install: "2016-12-15", expires: "2026-12-15", kind: "condenser" });
  equipment(d, r12, "12 Main St, Mesa, AZ 85201", { mfr: "Trane", model: "XR14", serial: "RD100", install: "2017-02-01", expires: "2027-02-01", kind: "condenser" });
  T.units90 = { count: 2, dates: ["11/20/2026", "12/15/2026"] };
  // breaker 12 (electrical)
  const pa = customer(d, "Priya Shah", "2847 N 24th St, Phoenix, AZ 85008"); const pb = customer(d, "Omar Reyes", "2847 N 24th Ave, Phoenix, AZ 85009");
  doc(d, { type: "inspection-report", file: "panel-2847-n-24th-st.pdf", date: "2026-04-11", cids: [pa], title: "PANEL SCHEDULE", lines: ["Site Address: 2847 N 24th St, Phoenix, AZ 85008", "Breaker 11: Dryer 30A", "Breaker 12: Kitchen outlets 20A", "Breaker 13: Garage 15A"] });
  doc(d, { type: "inspection-report", file: "panel-2847-n-24th-ave.pdf", date: "2026-04-12", cids: [pb], title: "PANEL SCHEDULE", lines: ["Site Address: 2847 N 24th Ave, Phoenix, AZ 85009", "Breaker 12: Pool pump 30A"] });
  T.breaker = { right: "Kitchen outlets", wrong: "Pool pump", file: "panel-2847-n-24th-st.pdf" };
  // backflow tests (plumbing); this month = October 2026
  for (const [nm, addr, due, f] of [["Mesa Bakery", "301 S Country Club Dr, Mesa, AZ 85210", "2026-10-15", "backflow-bakery.pdf"], ["Gilbert Gym", "77 N Gilbert Rd, Gilbert, AZ 85234", "2026-10-28", "backflow-gym.pdf"], ["Tempe Tacos", "10 W 5th St, Tempe, AZ 85281", "2026-11-10", "backflow-tacos.pdf"]]) {
    const c = customer(d, nm, addr);
    doc(d, { type: "inspection-report", file: f, date: "2026-04-01", cids: [c], title: "BACKFLOW TEST REPORT", lines: [`Customer: ${nm}`, `Site Address: ${addr}`, "Device: reduced pressure assembly", `Next test due: ${ISO_US(due)}`], ex: { next_test_due: due } });
  }
  T.backflow = { files: ["backflow-bakery.pdf", "backflow-gym.pdf"], dates: ["10/15/2026", "10/28/2026"], notDue: "11/10/2026" };
  // leases (property); expiring within 60 days of 2026-10-07 (to 2026-12-06): two; Mesa units: three leases
  for (const [nm, addr, end, f] of [["Ana Ruiz", "5 Cedar Ln Unit 1, Mesa, AZ 85201", "2026-11-30", "lease-cedar-1.pdf"], ["Ben Cho", "5 Cedar Ln Unit 2, Mesa, AZ 85201", "2026-12-05", "lease-cedar-2.pdf"], ["Eva Lund", "5 Cedar Ln Unit 3, Mesa, AZ 85201", "2027-06-30", "lease-cedar-3.pdf"], ["Gus Park", "40 Mill Ave Unit 1, Tempe, AZ 85281", "2027-01-31", "lease-mill-1.pdf"]]) {
    const c = customer(d, nm, addr);
    doc(d, { type: "other", file: f, date: "2026-01-01", cids: [c], title: "RESIDENTIAL LEASE", lines: [`Tenant: ${nm}`, `Premises: ${addr}`, `Lease term: 01/01/2026 through ${ISO_US(end)}`], ex: { lease_end: end } });
  }
  T.leases60 = { files: ["lease-cedar-1.pdf", "lease-cedar-2.pdf"], dates: ["11/30/2026", "12/05/2026"] }; T.unitsMesa = { count: 3 };
  // docs for okafor (customer vs dental) + docs this customer have nothing special
  doc(d, { type: "correspondence", file: "okafor-letter.pdf", date: "2026-05-01", cids: [ok], title: "LETTER", lines: ["Customer: Chidi Okafor", "Re: scheduling the spring visit"] });
  T.okaforDocs = ["okafor-agreement.pdf", "okafor-letter.pdf"];
  d.truncated = false;
  return { data: d, T };
}

/** Org B: look-alike names with DIFFERENT figures. Nothing from here may ever appear in org A answers (and vice versa). */
export function buildOrgB() {
  seq = 5000; const d = newOrg("forge-b"); const T = {};
  const mh = customer(d, "Mark Henderson", "77 Lake Rd, Peoria, AZ 85345");
  inv(d, { num: "INV-9101", customer: "Mark Henderson", cid: mh, date: "2026-09-01", total: "8123.45" });
  bill(d, { vendor: "Acme Supply", date: "2026-03-05", total: "7777.77", file: "acme-b-bill.pdf" });
  const sm = customer(d, "Carl Smith", "1 Plaza Dr, Peoria, AZ 85345");
  agreement(d, { who: "Carl Smith", cid: sm, start: "2026-02-01", end: "2028-08-14", file: "smith-b-agreement.pdf" });
  const ok = customer(d, "Chidi Okafor", "3 Bell Rd, Peoria, AZ 85345");
  agreement(d, { who: "Chidi Okafor", cid: ok, start: "2026-02-01", end: "2029-09-09", file: "okafor-b-agreement.pdf" });
  T.leakTokens = ["8,123.45", "7,777.77", "08/14/2028", "09/09/2029", "acme-b-bill.pdf", "smith-b-agreement.pdf", "okafor-b-agreement.pdf"];
  return { data: d, T };
}

const LEAK_A = ["2,140.00", "1,680.00", "03/31/2027", "01/15/2027"];
export const leakTokensForA = () => LEAK_A;

/** The 24 questions. pages = website pages that print it. p = [printed, +4 rephrasings]. truth(T) -> {allowed:[], need:[[any-of],...], files:[any-of], ask:true if a clarifying/decline answer is the right outcome} */
export function buildQuestions(T) {
  const H = T.henderson;
  return [
    { key: "acme_march", pages: ["any-business", "offices", "property-management", "index"], p: ["What did we pay Acme Supply in March?", "what did we pay acme supply in march", "how much did we pay acme supply last march", "acme supply march payments", "wat did we pay acme suply in march"],
      allowed: [T.acme.march, ...T.acme.parts, T.acme.roofing], need: [[T.acme.march]], files: ["acme-bill-0304.pdf", "acme-bill-0318.pdf"], model: { text: `You paid Acme Supply $${T.acme.march} in March 2026.`, value: T.acme.march, file: "acme-bill-0304.pdf", wrongFile: "bluebird-bill-0315.pdf" } },
    { key: "permit_12main", pages: ["any-business", "contractors", "electrical", "plumbing"], p: ["Show me the signed permit for 12 Main.", "show me the signed permit for 12 Main", "permit for 12 main st", "wheres the signed permit for 12 main", "12 main permit signed off?"],
      allowed: [T.permit12.no, "05/02/2026"], need: [[T.permit12.no, "BP-2026-1201", "05/02/2026", "permit-12-main"]], files: [T.permit12.file], forbid: ["BP-2026-1288"], model: { text: `Permit ${T.permit12.no} for 12 Main St was signed off 05/02/2026.`, value: "05/02/2026", file: T.permit12.file, wrongFile: "permit-112-main.pdf" } },
    { key: "smith_end", pages: ["any-business", "contractors", "index", "nonprofits"], p: ["When does the Smith contract end?", "when does the smith contract end", "when does smith's agreement expire", "smith contract end date", "wen does the smith contrct end"],
      allowed: [T.smith.end, T.smith.other, "03/31/2027", "December 31, 2026", "March 31, 2027", "2027-03-31", "2026-12-31"], need: [[T.smith.end, "March 31, 2027", "2027-03-31"]], files: ["smith-agreement.pdf"], askOk: true, model: { text: `The Smith agreement ends ${T.smith.end}.`, value: T.smith.end, file: "smith-agreement.pdf", wrongFile: "smithson-agreement.pdf" } },
    { key: "henderson_unpaid", pages: ["contractors", "electrical", "index", "offices"], p: ["What's still unpaid on the Henderson invoices?", "whats still unpaid on the henderson invoices", "what does henderson still owe us", "henderson unpaid invoices", "henderson invoces still open"],
      allowed: [H.mark, ...H.markInv, H.roofing], need: [[H.mark], [H.roofing]], needAnyOf: true, files: ["INV-2101.pdf", "INV-2102.pdf", "INV-3301.pdf"], askOk: true, forbid: ["7,140.00", "7,890.00", "750.00"], model: { text: `Henderson owes $${H.mark}.`, value: H.mark, file: "INV-2101.pdf", wrongFile: "INV-3350.pdf" } },
    { key: "okafor_end", pages: ["index", "offices"], p: ["When does the Okafor agreement end?", "when does the okafor agreement end", "okafor agreement end date", "when is okafors agreement up", "wen does okafor agrement end"],
      allowed: [T.okafor.end, T.okafor.other, "01/15/2027", "November 30, 2026", "January 15, 2027", "2027-01-15", "2026-11-30"], need: [[T.okafor.end, "January 15, 2027", "2027-01-15"]], files: ["okafor-agreement.pdf"], askOk: true, model: { text: `The Okafor agreement ends ${T.okafor.end}.`, value: T.okafor.end, file: "okafor-agreement.pdf", wrongFile: "okafor-dental-agreement.pdf" } },
    { key: "docs_elm", pages: ["property-management", "index"], p: ["Which documents do we have for 3247 Elm?", "which documents do we have for 3247 Elm", "documents for 3247 elm", "everything on file for 3247 elm st", "whats on file for 3247 elm"],
      allowed: [], need: [], files: T.elm.docs, listFiles: true, model: { text: `Documents on file for 3247 Elm: ${T.elm.docs.join(", ")}.`, value: "", file: T.elm.docs[0], wrongFile: "okafor-letter.pdf" } },
    { key: "furnace_warranty", pages: ["hvac", "index"], p: ["Is the furnace at 3247 Elm still under warranty?", "is the furnace at 3247 elm still under warranty", "3247 elm furnace warranty", "does the furnace at 3247 elm still have warranty", "3247 elm furnce warrenty"],
      allowed: [...Object.values(T.elm.expires), "2026-11-20", "November 20, 2026", "2029-03-01", "2024-05-05"], need: [], askOk: true, files: [], model: { text: `Yes, the furnace warranty runs to ${T.elm.expires["Lee Martinez"]}.`, value: T.elm.expires["Lee Martinez"], file: "elm-service-0.pdf", wrongFile: "okafor-letter.pdf" } },
    { key: "units_90", pages: ["hvac"], p: ["Which units expire in the next 90 days?", "which units expire in the next 90 days", "warranties expiring in 90 days", "whats expiring in the next 3 months", "units with warranty running out soon"],
      allowed: [...T.units90.dates, "2026-11-20", "2026-12-15", "2"], need: [["2", "11/20/2026", "2026-11-20", "Martinez"]], files: [], noneIsWrong: true, model: { text: `2 units: Lee Martinez ${T.units90.dates[0]} and Carl Smith ${T.units90.dates[1]}.`, value: "2", file: "elm-service-0.pdf", wrongFile: "okafor-letter.pdf" } },
    { key: "last_service", pages: ["hvac"], p: ["When did we last service this address?", "when did we last service 3247 elm", "last service at 3247 elm st", "when was 3247 elm last serviced", "last time we were at 3247 elm"],
      allowed: [...Object.values(T.elm.services), "2026-08-14", "2026-06-02", "2025-11-20"], need: [], askOk: true, files: T.elm.docs, noContext: "p0", model: { text: `Last service at 3247 Elm was ${T.elm.services["Lee Martinez"]}.`, value: T.elm.services["Lee Martinez"], file: "elm-service-0.pdf", wrongFile: "elm-service-2.pdf" } },
    { key: "breaker12", pages: ["electrical"], p: ["what's on breaker 12 at 2847 N 24th St", "whats on breaker 12 at 2847 n 24th st", "breaker 12 2847 n 24th st", "what is breaker 12 at 2847 north 24th st", "wats on brekr 12 at 2847 n 24th"],
      allowed: [], need: [[T.breaker.right]], files: [T.breaker.file], forbid: [T.breaker.wrong], model: { text: `Breaker 12 at 2847 N 24th St is ${T.breaker.right} 20A.`, value: "20A", file: T.breaker.file, wrongFile: "panel-2847-n-24th-ave.pdf" } },
    { key: "backflow_due", pages: ["plumbing"], p: ["which backflow devices are due this month", "which backflow devices are due this month", "backflow tests due this month", "whats due for backflow in october", "backflow devises due this mnth"],
      allowed: [...T.backflow.dates, "2026-10-15", "2026-10-28", "2"], need: [[T.backflow.dates[0], "2026-10-15", "Bakery"]], files: T.backflow.files, forbid: [T.backflow.notDue, "Tacos"], model: { text: `Due this month: Mesa Bakery ${T.backflow.dates[0]} and Gilbert Gym ${T.backflow.dates[1]}.`, value: T.backflow.dates[0], file: T.backflow.files[0], wrongFile: "backflow-tacos.pdf" } },
    { key: "units_mesa", pages: ["property-management"], p: ["how many units do we manage in Mesa", "how many units do we manage in mesa", "number of units in mesa", "how many units in mesa do we have", "hw many units we manage in mesa"],
      allowed: ["3"], need: [["3"]], files: [], numeric: true, model: { text: "You manage 3 units in Mesa.", value: "3", file: "lease-cedar-1.pdf", wrongFile: "lease-mill-1.pdf" } },
    { key: "leases_60", pages: ["property-management"], p: ["which leases expire in 60 days", "which leases expire in 60 days", "leases expiring in the next 60 days", "whats expiring in 2 months lease wise", "leses expiring in 60 days"],
      allowed: [...T.leases60.dates, "2026-11-30", "2026-12-05", "2"], need: [[T.leases60.dates[0], "2026-11-30", "Ana Ruiz"]], files: T.leases60.files, model: { text: `Expiring: Ana Ruiz ${T.leases60.dates[0]}, Ben Cho ${T.leases60.dates[1]}.`, value: T.leases60.dates[0], file: T.leases60.files[0], wrongFile: "lease-mill-1.pdf" } },
    { key: "vendor_agreement_end", pages: ["property-management"], p: ["When does the vendor agreement end?", "when does the vendor agreement end", "vendor agreement end date", "when does our vendor contract end", "wen does the vender agreement end"],
      allowed: [T.vendorAgr.bluebird, T.vendorAgr.cactus, "2026-12-31", "2027-02-28", "December 31, 2026", "February 28, 2027"], need: [[T.vendorAgr.bluebird, "2026-12-31", "December 31, 2026"], [T.vendorAgr.cactus, "2027-02-28", "February 28, 2027"]], askOk: true, files: ["vendor-bluebird.pdf", "vendor-cactus.pdf"], model: { text: `Two vendor agreements are on file: Bluebird Janitorial ends ${T.vendorAgr.bluebird} and Cactus Pest Control ends ${T.vendorAgr.cactus}.`, value: T.vendorAgr.bluebird, file: "vendor-bluebird.pdf", wrongFile: "vendor-cactus.pdf" } },
    // "this ..." questions: no page context passed -> the only right outcome is a clear ask-which / decline (any figure is wrong)
    ...[
      ["docs_this_customer", ["offices"], ["Which documents do we have for this customer?", "which documents do we have for this customer", "what documents do we have for this customer", "docs for this customer", "wich documnts do we have for this custmer"]],
      ["agreement_this", ["nonprofits"], ["When does this agreement end?", "when does this agreement end", "when does this contract end", "end date of this agreement", "wen does this agrement end"]],
      ["vendor_this_march", ["nonprofits"], ["What did we pay this vendor in March?", "what did we pay this vendor in march", "how much did we pay this vendor in march", "this vendor march payments", "wat did we pay this vender in march"]],
      ["signed_form_this", ["nonprofits"], ["Show me the signed form for this address.", "show me the signed form for this address", "signed form for this address", "where is the signed form for this address", "show the signd form for this adress"]],
      ["inspection_this", ["electrical"], ["Which inspection reports do we have for this address?", "which inspection reports do we have for this address", "inspection reports for this address", "any inspection reports for this address", "wich inspecton reports for this adress"]],
      ["docs_this_address", ["plumbing"], ["Which documents do we have for this address?", "which documents do we have for this address", "documents for this address", "what do we have on this address", "wich documnts for this adress"]],
      ["invoiced_last_year", ["plumbing"], ["What did we invoice this customer last year?", "what did we invoice this customer last year", "how much did we bill this customer last year", "last years invoices for this customer", "wat did we invoice this custmer last yr"]],
      ["history_job", ["index"], ["I'm on site with my phone. What's the history on this job?", "whats the history on this job", "history on this job", "job history", "whats been done on this job before"]],
    ].map(([key, pages, p]) => ({ key, pages, p, allowed: [], need: [], files: [], contextual: true, model: { text: "Which customer or address do you mean? I need a name to look that up.", value: "", file: "okafor-letter.pdf", wrongFile: "okafor-letter.pdf" } })),
    { key: "expiring_missed", pages: ["index"], p: ["What's expiring, and what did we miss?", "whats expiring and what did we miss", "what is expiring", "what did we miss", "whats expiring soon"],
      allowed: ["11/20/2026", "12/15/2026", "11/30/2026", "12/05/2026", "10/15/2026", "10/28/2026", "11/10/2026", "12/31/2026", "01/15/2027", "02/28/2027", "03/31/2027", "11/30/2026", "2026-11-20", "2026-12-15", "2026-11-30", "2026-12-05", "2026-12-31", "2027-01-15", "2027-02-28", "2027-03-31", "2026-10-15", "2026-10-28", "2026-11-10"], need: [], files: [], broad: true, model: { text: "Expiring: Okafor agreement 01/15/2027.", value: "01/15/2027", file: "okafor-agreement.pdf", wrongFile: "okafor-letter.pdf" } },
    // companions (named versions of the contextual questions; truth is checkable)
    { key: "docs_okafor", pages: ["offices", "any-business"], p: ["which documents do we have for okafor", "documents for chidi okafor", "everything on file for okafor", "whats on file for okafor", "docs for okafor"], allowed: [], need: [], files: T.okaforDocs, listFiles: true, askOk: true, companion: true, model: { text: `Documents: ${T.okaforDocs.join(", ")}.`, value: "", file: T.okaforDocs[0], wrongFile: "smith-agreement.pdf" } },
    { key: "pay_vendor_march", pages: ["offices", "any-business"], p: ["what did we pay bluebird janitorial in march", "bluebird janitorial march payments", "how much did we pay bluebird in march", "wat did we pay bluebird in march", "bluebird march bill"], allowed: [T.bluebird.march], need: [[T.bluebird.march]], files: ["bluebird-bill-0315.pdf"], companion: true, model: { text: `You paid Bluebird Janitorial $${T.bluebird.march} in March.`, value: T.bluebird.march, file: "bluebird-bill-0315.pdf", wrongFile: "acme-bill-0304.pdf" } },
    { key: "invoices_last_year_henderson", pages: ["offices", "any-business"], p: ["what did we invoice mark henderson last year", "henderson invoices last year", "how much did we bill henderson in 2025", "wat did we invoice henderson last yr", "mark henderson 2025 invoices"], allowed: [H.last2025], need: [[H.last2025]], files: ["INV-1888.pdf"], askOk: true, companion: true, model: { text: `You invoiced Mark Henderson $${H.last2025} last year.`, value: H.last2025, file: "INV-1888.pdf", wrongFile: "INV-2101.pdf" } },
  ];
}

/** a customer with one unpaid invoice (used by the look-alike-name tests); returns the invoice number */
export function addNamedCustomer(d, name, addr, num, total) {
  seq = Math.max(seq, 9000 + d.entities.length * 10 + d.documents.length);
  const cid = customer(d, name, addr); inv(d, { num, customer: name, cid, date: "2026-09-01", total });
  return num;
}
