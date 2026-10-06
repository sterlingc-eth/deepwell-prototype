#!/usr/bin/env node
/**
 * R38: THIRD-TENANT generator — a synthetic property-management company ("Saguaro Ridge Property Management", Tucson AZ):
 * ~60 owners (customer), ~330 rental units (property entity + appliance equipment), ~25 vendors (technician entity), ~1.8k documents
 * (leases, move-in/out inspections, work orders, vendor invoices, certificates of insurance). Deterministic, no DB/model.
 *   node scripts/gen-property-tenant.mjs -> test-docs/tenants/property/export.json + test-docs/scorecard/blind/prop-owner-1.json
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(3838);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
let uc = 0;
const duuid = () => { const h = crypto.createHash("sha1").update("prop-" + uc++).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const CO = "Saguaro Ridge Property Management", CO_ADDR = "980 E Grant Rd, Tucson, AZ 85719", CO_PHONE = "(520) 555-0177";
const FIRST = ["Aaron","Bianca","Carlos","Diana","Ethan","Fiona","Gabriel","Hannah","Isaiah","Julia","Kevin","Laura","Miguel","Nora","Omar","Paula","Quinn","Rosa","Samuel","Tessa","Victor","Wendy","Xavier","Yolanda","Zachary"];
const LAST = ["Abbott","Barrera","Coleman","Duarte","Ellison","Franco","Griffin","Holloway","Iglesias","Jimenez","Keller","Lopez","Mendoza","Navarro","Ortega","Perez","Ramirez","Salazar","Trujillo","Vargas"];
const STREETS = ["E Speedway Blvd","N Campbell Ave","S Kolb Rd","W Ina Rd","N Oracle Rd","E Broadway Blvd","S Alvernon Way","E Fort Lowell Rd","N Swan Rd","W Grant Rd"];
const CITIES = [["Tucson", ["85705","85710","85711","85719"], 0.6], ["Oro Valley", ["85737"], 0.15], ["Marana", ["85653"], 0.15], ["Sahuarita", ["85629"], 0.1]];
const APPL = [["refrigerator", ["Whirlpool","GE","Samsung","LG"]], ["range", ["GE","Frigidaire","Whirlpool"]], ["dishwasher", ["Bosch","Whirlpool","GE"]], ["water heater", ["Rheem","A.O. Smith"]]];
const VENDORS = [["Desert Air Mechanical", "hvac"], ["Rivera Plumbing", "plumbing"], ["Bright Spark Electric", "electrical"], ["Clearview Glass", "glass"], ["GreenEdge Landscaping", "landscape"], ["Tucson Pest Control", "pest"], ["Handy Hands Maintenance", "general"], ["Fresh Start Cleaning", "cleaning"]];
const iso = (d) => d.toISOString().slice(0, 10);
const us = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
const addMonths = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const rdate = (y0, y1) => iso(new Date(Date.UTC(int(y0, y1), int(0, 11), int(1, 28))));
const MAXD = "2026-09-20";
const entities = [], documents = [], pages = [], extractions = [], links = [], financials = [], lines = [];
const head = (t) => `${CO}\n${CO_ADDR}\n${CO_PHONE}\n${t}`;
const link = (docId, entId, conf = 0.9) => links.push({ id: duuid(), document_id: docId, entity_id: entId, confidence: conf, linked_by: "golden-export", created_at: "2026-09-27T02:00:02.223Z" });
const ex = (d, e, k, v, date) => { if (v != null && v !== "") extractions.push({ id: duuid(), document_id: d, entity_id: e, field_key: k, value: String(v), confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: `${date}T12:00:00Z` }); };
let dn = 0;
const mkDoc = (type, date, text, ents) => { const id = duuid(); documents.push({ id, batch_id: null, original_filename: `${String(++dn).padStart(4, "0")}-${type}.pdf`, document_type: type, sha256_hash: crypto.createHash("sha256").update(text).digest("hex"), file_size_bytes: text.length, stage: "linked", created_at: `${date}T12:00:00Z`, processed_at: `${date}T12:00:00Z` }); pages.push({ id: duuid(), document_id: id, page_no: 1, text, created_at: `${date}T12:00:00Z` }); for (const e of ents) link(id, e); return id; };
const ent = (type, data, extra = {}) => { const id = duuid(); entities.push({ id, entity_type: type, merged_into: null, ...extra, data, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }); return id; };
function fin(d, c, date, inv, total, status, desc, vendor) { const f = duuid(); financials.push({ id: f, document_id: d, doc_kind: "invoice", direction: "payable", currency: "USD", invoice_number: inv, po_number: null, invoice_date: date, due_date: null, period_start: null, period_end: null, agreement_term: null, subtotal: null, tax: null, total: total.toFixed(2), amount_paid: status === "paid" ? total.toFixed(2) : null, balance_due: null, status, customer_name: c, vendor_name: vendor, confidence: 0.7, flags: [], evidence: { total: { page: 1, verbatim: `TOTAL DUE: $${total.toFixed(2)}`, confidence: 0.7 } }, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: "golden-export", extracted_at: `${date}T12:00:00Z`, created_at: `${date}T12:00:00Z`, job_key: null, job_key_source: "extracted", job_confidence: 0, job_raw: null }); lines.push({ id: duuid(), financial_id: f, document_id: d, line_no: 1, description: desc, qty: null, unit_price: null, amount: total.toFixed(2), category_guess: null, page_no: 1 }); }

const vendors = VENDORS.map(([name, trade], i) => { const id = ent("technician", { technician_name: name, name, trade }); return { id, name, trade }; });
// certificates of insurance (vendor-level)
const coiRows = [];
for (const v of vendors) { const exp = rdate(2026, 2027); const d = rdate(2025, 2026); const date = d > MAXD ? MAXD : d; const t = `${head("CERTIFICATE OF INSURANCE")}\nVendor: ${v.name}\nPolicy period ends: ${us(exp)}\nCoverage: general liability $1,000,000`; const id = mkDoc("certificate-of-insurance", date, t, [v.id]); ex(id, v.id, "vendor", v.name, date); ex(id, v.id, "coi_expires", exp, date); coiRows.push({ v: v.name, exp }); }
const owners = [], units = [], leases = [], wos = [], invoices = [];
const nameSeen = new Set(); let n = 0;
const uniq = (pool1, pool2) => { let nm, t = 0; do { nm = `${pick(pool1)} ${t > 20 ? String.fromCharCode(65 + int(0, 25)) + ". " : ""}${pick(pool2)}`; t++; } while (nameSeen.has(nm)); nameSeen.add(nm); return nm; };
let invN = 52000, woN = 8800;
for (let o = 0; o < 60; o++) {
  const name = uniq(FIRST, LAST) ; let r = rnd(), a = 0, city = CITIES[0]; for (const c of CITIES) { a += c[2]; if (r < a) { city = c; break; } }
  const addr = `${int(100, 9899)} ${pick(STREETS)}, ${city[0]}, AZ ${pick(city[1])}`;
  const oid = ent("customer", { customer_name: name, service_address: addr, phone: `(520) 555-${int(1000, 9999)}`, email: `${name.toLowerCase().replace(/ /g, ".")}${o}@example.com` }, { customer_number: `O-${String(o + 1).padStart(4, "0")}` });
  const ow = { id: oid, name, addr, city: city[0], units: [] }; owners.push(ow);
  const nU = int(3, 8);
  for (let u = 0; u < nU; u++) {
    const unitNo = `${int(1, 3)}${"ABCD"[u % 4]}${u > 3 ? u : ""}`;
    const pid = ent("property", { unit_number: unitNo, service_address: addr , customer_name: name });
    const un = { id: pid, no: unitNo, owner: ow, appl: [] }; ow.units.push(un); units.push(un);
    for (const [type, brands] of APPL.filter(() => rnd() < 0.7)) { const mfr = pick(brands); const serial = `${mfr.slice(0, 2).toUpperCase()}${int(1000000, 9999999)}`; const eid = ent("equipment", { equipment_type: type, manufacturer: mfr, model: `${mfr.slice(0, 3).toUpperCase()}-${int(100, 999)}`, serial_number: serial, unit_number: unitNo, service_address: addr, installation_date: rdate(2015, 2025) }, { customer_id: oid }); un.appl.push({ id: eid, type, mfr, serial }); }
    // leases: 1-2 per unit, last is current
    const nL = rnd() < 0.35 ? 2 : 1; let start = rdate(2022, 2025);
    for (let l = 0; l < nL; l++) {
      const st = nL === 2 && l === 0 ? rdate(2021, 2022) : start; const mtm = rnd() < 0.08; const end = mtm ? null : addMonths(st, 12); const rent = int(9, 28) * 50 + 400; const dep = rent; const tenant = uniq(FIRST, LAST);
      const t = `${head("RESIDENTIAL LEASE AGREEMENT")}\nProperty: ${addr}, Unit ${unitNo}\nOwner: ${name}\nTenant: ${tenant}\nLease start: ${us(st)}\n${end ? `Lease end: ${us(end)}\n` : "Term: month-to-month\n"}Monthly rent: $${rent}.00\nSecurity deposit: $${dep}.00`;
      const id = mkDoc("lease-agreement", st, t, [oid, pid]);
      for (const [k, v] of [["tenant_name", tenant], ["unit_number", unitNo], ["service_address", addr], ["lease_start_date", st], ["lease_end_date", end], ["rent_amount", `${rent}.00`], ["security_deposit", `${dep}.00`], ["customer_name", name]]) ex(id, pid, k, v, st);
      leases.push({ tenant, unitNo, addr, owner: name, st, end, rent, dep, last: l === nL - 1, city: city[0] });
      const mi = `${head("MOVE-IN INSPECTION")}\nProperty: ${addr}, Unit ${unitNo}\nTenant: ${tenant}\nDate: ${us(st)}\nCondition: ${pick(["good", "fair, minor wall scuffs", "excellent"])}`;
      const mid = mkDoc("move-in-inspection", st, mi, [oid, pid]); ex(mid, pid, "tenant_name", tenant, st); ex(mid, pid, "service_date", st, st); ex(mid, pid, "unit_number", unitNo, st);
      if (l < nL - 1 || (end && end < MAXD && rnd() < 0.5)) { const mo = end ?? MAXD; const mot = `${head("MOVE-OUT INSPECTION")}\nProperty: ${addr}, Unit ${unitNo}\nTenant: ${tenant}\nDate: ${us(mo)}\nDeposit returned: $${int(0, dep)}.00`; const moid = mkDoc("move-out-inspection", mo, mot, [oid, pid]); ex(moid, pid, "tenant_name", tenant, mo); ex(moid, pid, "service_date", mo, mo); ex(moid, pid, "unit_number", unitNo, mo); }
      start = addMonths(st, 13);
    }
    for (let w = 0, k = int(0, 3); w < k; w++) {
      const v = pick(vendors); const d0 = rdate(2022, 2026); const d = d0 > MAXD ? MAXD : d0; const work = pick(["replaced dishwasher pump", "unclogged kitchen drain", "serviced AC unit", "repaired range igniter", "replaced water heater element", "fixed leaking faucet", "turned unit: paint and clean"]); const wo = `WO-${woN++}`;
      const t = `${head("WORK ORDER")}\nWork order #: ${wo}\nDate: ${us(d)}\nProperty: ${addr}, Unit ${unitNo}\nVendor: ${v.name}\nWork performed: ${work}\nStatus: Completed`;
      const id = mkDoc("work-order", d, t, [oid, pid, v.id]); for (const [kk, vv] of [["invoice_number", wo], ["service_date", d], ["vendor", v.name], ["work_performed", work], ["unit_number", unitNo], ["service_address", addr], ["status", "Completed"]]) ex(id, pid, kk, vv, d);
      wos.push({ v: v.name, d, unitNo, addr, work });
      if (rnd() < 0.7) { const total = int(3, 60) * 10; const inv = `INV-${invN++}`; const status = d > "2026-08-15" ? "unpaid" : "paid"; const it = `${head("VENDOR INVOICE")}\nInvoice #: ${inv}\nDate: ${us(d)}\nVendor: ${v.name}\nProperty: ${addr}, Unit ${unitNo}\nWork: ${work}\nTOTAL DUE: $${total}.00`; const iid = mkDoc("invoice", d, it, [oid, pid, v.id]); for (const [kk, vv] of [["invoice_number", inv], ["invoice_date", d], ["vendor", v.name], ["work_performed", work], ["unit_number", unitNo], ["cost", `${total}.00`]]) ex(iid, pid, kk, vv, d); fin(iid, name, d, inv, total, status, work, v.name); invoices.push({ v: v.name, d, total, inv }); }
    }
  }
}
const exportData = { tenantKey: "property-synth-r38", tenantName: CO, exportedAt: "2026-09-27T00:00:00Z", documents, pages, extractions, entities, document_entity_links: links, facets: [], audit_log: [], truncated: false, financials, financial_lines: lines };
fs.mkdirSync(path.join(ROOT, "test-docs/tenants/property"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "test-docs/tenants/property/export.json"), JSON.stringify(exportData));
console.log(`property tenant: ${owners.length} owners, ${units.length} units, ${leases.length} leases, ${documents.length} docs, ${extractions.length} extractions`);

/* owner-voice (property manager) questions, written before any property-pack code change */
const Q = []; let qn = 0;
const add = (shape, text, cmp, sql, params = [], extra = {}) => Q.push({ id: `prop-${String(++qn).padStart(3, "0")}`, text, category: "blind-r38-property", shape, cmp, oracle: { sql, params }, citationRequired: true, ...extra });
const sample = (arr, k) => { const a = [...arr]; const o = []; while (a.length && o.length < k) o.push(a.splice(int(0, a.length - 1), 1)[0]); return o; };
const byTenant = (col) => `SELECT x.value AS v FROM extractions x JOIN extractions t ON t.document_id = x.document_id AND t.field_key = 'tenant_name' WHERE x.field_key = '${col}' AND t.value ILIKE $1`;
const uniqLease = leases.filter((l) => l.end);
for (const l of sample(uniqLease, 6)) add("lease_end", pick([`when does ${l.tenant}'s lease end`, `${l.tenant} lease expiration?`, `when is ${l.tenant} up for renewal`]), "value", byTenant("lease_end_date"), [l.tenant]);
for (const l of sample(leases, 6)) add("rent", pick([`how much is ${l.tenant} paying in rent`, `what's ${l.tenant}'s rent`, `monthly rent for ${l.tenant}`]), "value", byTenant("rent_amount"), [l.tenant]);
for (const l of sample(leases, 4)) add("deposit", pick([`what's the security deposit for ${l.tenant}`, `how much deposit does ${l.tenant} have on file`]), "value", byTenant("security_deposit"), [l.tenant]);
for (const l of sample(leases, 4)) add("lease_start", pick([`when did ${l.tenant} move in`, `${l.tenant} lease start date`]), "value", byTenant("lease_start_date"), [l.tenant]);
const oneLeaseUnits = leases.filter((l) => leases.filter((m) => m.unitNo === l.unitNo && m.addr === l.addr).length === 1);
for (const l of sample(oneLeaseUnits, 6)) add("who_lives", pick([`who lives in unit ${l.unitNo} at ${l.addr.split(",")[0]}`, `who's the tenant in ${l.unitNo} at ${l.addr.split(",")[0]}`]), "value", `SELECT t.value AS v FROM extractions u JOIN extractions a ON a.document_id = u.document_id AND a.field_key = 'service_address' JOIN extractions t ON t.document_id = u.document_id AND t.field_key = 'tenant_name' JOIN documents d ON d.id = u.document_id WHERE u.field_key = 'unit_number' AND u.value ILIKE $1 AND a.value ILIKE $2 AND d.document_type = 'lease-agreement'`, [l.unitNo, l.addr.split(",")[0] + "%"]);
for (const y of [2026, 2027]) add("count_leases_end_year", pick([`how many leases end in ${y}`, `how many leases expire in ${y}`]), "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key = 'lease_end_date' AND x.value LIKE $1`, [`${y}-%`]);
add("count_leases", "how many leases do we have on file", "number", `SELECT count(*) AS n FROM documents WHERE document_type = 'lease-agreement'`);
add("count_mtm", "how many leases are month to month", "number", `SELECT count(*) AS n FROM documents d WHERE d.document_type = 'lease-agreement' AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'lease_end_date')`);
add("count_moveouts", "how many move-out inspections do we have", "number", `SELECT count(*) AS n FROM documents WHERE document_type = 'move-out-inspection'`);
add("count_movein", "how many move-ins have we done", "number", `SELECT count(*) AS n FROM documents WHERE document_type = 'move-in-inspection'`);
add("count_work_orders", "how many work orders are on file", "number", `SELECT count(*) AS n FROM documents WHERE document_type = 'work-order'`);
add("count_vendors", "how many vendors do we use", "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'technician' AND merged_into IS NULL`);
add("count_owners", "how many owners do we manage for", "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL`);
add("count_units", "how many units do we manage", "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'property' AND merged_into IS NULL`);
for (const v of sample(vendors, 4)) add("count_vendor_wo", pick([`how many work orders did ${v.name} do`, `how many jobs has ${v.name} done for us`]), "number", `SELECT count(DISTINCT x.document_id) AS n FROM extractions x JOIN documents d ON d.id = x.document_id WHERE x.field_key = 'vendor' AND d.document_type = 'work-order' AND x.value ILIKE $1`, [v.name]);
for (const c of ["Oro Valley", "Marana", "Sahuarita"]) add("count_owners_city", `how many owners do we have in ${c}`, "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`%, ${c}, %`]);
for (const b of ["Whirlpool", "Samsung", "Bosch"]) add("count_appl_brand", pick([`how many ${b} appliances do we have`, `how many ${b} units are in our properties`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [b]);
add("count_refrigerators", "how many refrigerators do we have", "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'equipment_type' = 'refrigerator'`);
add("coi_expiring_year", "how many vendor insurance certificates expire in 2027", "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key = 'coi_expires' AND x.value LIKE '2027-%'`);
for (const v of sample(vendors, 4)) add("coi_vendor", pick([`when does ${v.name}'s insurance expire`, `${v.name} certificate of insurance expiration`]), "value", `SELECT x.value AS v FROM extractions x JOIN extractions t ON t.document_id = x.document_id AND t.field_key = 'vendor' WHERE x.field_key = 'coi_expires' AND t.value ILIKE $1`, [v.name]);
for (const v of sample(vendors, 3)) add("vendor_invoice_count", `how many invoices has ${v.name} sent us`, "number", `SELECT count(DISTINCT x.document_id) AS n FROM extractions x JOIN documents d ON d.id = x.document_id WHERE x.field_key = 'vendor' AND d.document_type = 'invoice' AND x.value ILIKE $1`, [v.name]);
for (const o of sample(owners, 4)) add("owner_units", pick([`how many units does ${o.name} own`, `how many units do we manage for ${o.name}`]), "number", `SELECT count(*) AS n FROM entities p WHERE p.entity_type = 'property' AND p.merged_into IS NULL AND p.data->>'customer_name' ILIKE $1`, [o.name]);
for (const o of sample(owners, 3)) add("owner_address", pick([`what's the address of ${o.name}'s property`, `where is ${o.name}'s building`]), "value", `SELECT data->>'service_address' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, [o.name]);
for (const l of sample(leases, 3)) add("yesno_leased", `does ${l.tenant} have a lease on file`, "yesno", `SELECT EXISTS (SELECT 1 FROM extractions t JOIN documents d ON d.id = t.document_id WHERE t.field_key = 'tenant_name' AND t.value ILIKE $1 AND d.document_type = 'lease-agreement') AS v`, [l.tenant], { citationRequired: false });
const NH = { citationRequired: false };
for (const l of sample(leases, 2)) add("honest_late", pick([`is ${l.tenant} behind on rent`, `has ${l.tenant} paid this month`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(rent_paid|payment|late_fee)'`, [], NH);
add("honest_vacancy", "what's our vacancy rate", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'vacan'`, [], NH);
add("honest_other", "what's the weather in Tucson today", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'weather'`, [], NH);
for (const l of sample(leases, 2)) add("honest_pets", `does ${l.tenant} have a dog`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(pet|dog)'`, [], NH);
fs.writeFileSync(path.join(ROOT, "test-docs/scorecard/blind/prop-owner-1.json"), JSON.stringify({ version: "r38-prop-1", category: "blind-r38-property", source: "scripts/gen-property-tenant.mjs (seeded; written before any property-pack code change)", questions: Q }, null, 1));
console.log(`questions: ${Q.length}`);
