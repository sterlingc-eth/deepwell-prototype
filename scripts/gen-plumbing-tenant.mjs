#!/usr/bin/env node
/**
 * R38: SECOND-TENANT generator. Builds a synthetic plumbing company ("Canyon State Plumbing", Tucson AZ,
 * ~300 customers, ~1.9k documents) as an export-format JSON (same shape as scripts/golden/golden-export.json)
 * plus an owner-voice held-out question set with oracle SQL. Deterministic (seeded). Never touches a database
 * or a model. Used to measure how Donovan behaves outside the HVAC golden tenant (industry packs).
 *
 *   node scripts/gen-plumbing-tenant.mjs   -> test-docs/tenants/plumbing/export.json
 *                                             test-docs/scorecard/blind/plumb-owner-1.json
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(38038);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const uuid = () => { const h = crypto.createHash("sha1").update(String(rnd()) + Math.random()).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
// uuid must be deterministic: replace Math.random usage with a counter-based hash
let uc = 0;
const duuid = () => { const h = crypto.createHash("sha1").update("plumb-" + uc++).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

const CO = "Canyon State Plumbing", CO_ADDR = "2210 N Stone Ave, Tucson, AZ 85705", CO_PHONE = "(520) 555-0142";
const FIRST = ["James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Karen","Charles","Sarah","Daniel","Lisa","Matthew","Nancy","Anthony","Betty","Mark","Sandra","Donald","Ashley","Steven","Kimberly","Paul","Emily","Andrew","Donna","Joshua","Michelle","Kenneth","Carol"];
const LAST = ["Alvarez","Bennett","Castillo","Dawson","Estrada","Fischer","Gutierrez","Hammond","Ibarra","Jenkins","Kowalski","Lindgren","Maldonado","Nguyen","Okafor","Pruitt","Quintero","Rasmussen","Soto","Tanaka","Underwood","Valdez","Whitaker","Yazzie","Zamora","Brennan","Cardenas","Delgado","Eriksen","Figueroa"];
const STREETS = ["E Speedway Blvd","N Campbell Ave","S Kolb Rd","W Ina Rd","N Oracle Rd","E Broadway Blvd","S Alvernon Way","W Orange Grove Rd","N Swan Rd","E Grant Rd","S Houghton Rd","N Silverbell Rd","W Valencia Rd","E Fort Lowell Rd","N La Cholla Blvd"];
const CITIES = [["Tucson","AZ",["85705","85710","85711","85712","85716","85718","85719"],0.5],["Oro Valley","AZ",["85737","85755"],0.15],["Marana","AZ",["85653","85658"],0.12],["Sahuarita","AZ",["85629"],0.1],["Green Valley","AZ",["85614"],0.07],["Vail","AZ",["85641"],0.06]];
const TECHS = ["Marcus Bell","Dana Whitfield","Luis Herrera","Priya Raman","Tom Kessler"];
const EQ = [
  { type: "water heater (tank)", w: 0.46, brands: [["Rheem", "XE50T06EC36U1", 6], ["A.O. Smith", "ENT-50", 6], ["Bradford White", "RE350S6-1NAL", 6]], gal: [40, 50, 50, 75] },
  { type: "water heater (tankless)", w: 0.16, brands: [["Navien", "NPE-240A2", 15], ["Rinnai", "RU199iN", 12]] },
  { type: "sump pump", w: 0.06, brands: [["Zoeller", "M53", 3], ["Wayne", "CDU800", 3]] },
  { type: "water softener", w: 0.1, brands: [["Kinetico", "Signature Series", 10], ["Culligan", "High Efficiency", 10]] },
  { type: "backflow preventer", w: 0.22, brands: [["Watts", "009M2-QT", null], ["Febco", "825Y", null], ["Wilkins", "375XL", null]] },
];
const pickEq = () => { let r = rnd(), a = 0; for (const e of EQ) { a += e.w; if (r < a) return e; } return EQ[0]; };
const iso = (d) => d.toISOString().slice(0, 10);
const us = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
const addYears = (s, n) => `${Number(s.slice(0, 4)) + n}${s.slice(4)}`;
const rdate = (y0, y1) => iso(new Date(Date.UTC(int(y0, y1), int(0, 11), int(1, 28))));
const MAXD = "2026-09-20";

const entities = [], documents = [], pages = [], extractions = [], links = [], financials = [], lines = [];
const customers = [];
const nameSeen = new Set();
let invN = 40000, tkN = 7000, pmN = 91000;

function mkDoc(type, date, text, c) {
  const id = duuid();
  documents.push({ id, batch_id: null, original_filename: `${String(documents.length + 1).padStart(4, "0")}-${type}-${c.key}.pdf`, document_type: type, sha256_hash: crypto.createHash("sha256").update(text).digest("hex"), file_size_bytes: text.length, stage: "linked", created_at: `${date}T12:00:00Z`, processed_at: `${date}T12:00:00Z` });
  pages.push({ id: duuid(), document_id: id, page_no: 1, text, created_at: `${date}T12:00:00Z` });
  links.push({ id: duuid(), document_id: id, entity_id: c.id, confidence: 0.9, linked_by: "golden-export", created_at: "2026-09-27T02:00:02.223Z" });
  return id;
}
const ex = (docId, entId, k, v, date) => { if (v != null && v !== "") extractions.push({ id: duuid(), document_id: docId, entity_id: entId, field_key: k, value: String(v), confidence: 0.92, source_facet_id: null, schema_version: 1, created_at: `${date}T12:00:00Z` }); };
const head = (title) => `${CO}\n${CO_ADDR}\n${CO_PHONE} | service@canyonstateplumbing.example\n${title}`;
const linkEq = (docId, eq) => links.push({ id: duuid(), document_id: docId, entity_id: eq.id, confidence: 0.85, linked_by: "golden-export", created_at: "2026-09-27T02:00:02.223Z" });

function fin(docId, kind, c, date, invoice, total, status, desc) {
  const fid = duuid();
  financials.push({ id: fid, document_id: docId, doc_kind: kind, direction: "receivable", currency: "USD", invoice_number: invoice, po_number: null, invoice_date: date, due_date: null, period_start: null, period_end: null, agreement_term: null, subtotal: null, tax: null, total: total.toFixed(2), amount_paid: status === "paid" ? total.toFixed(2) : null, balance_due: null, status, customer_name: c.name, vendor_name: null, confidence: 0.7, flags: [], evidence: { total: { page: 1, verbatim: `TOTAL DUE: $${total.toFixed(2)}`, confidence: 0.7 } }, corrections: {}, corrected_by: null, corrected_at: null, verified_by: null, verified_at: null, model: "golden-export", extracted_at: `${date}T12:00:00Z`, created_at: `${date}T12:00:00Z`, job_key: c.addr.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40), job_key_source: "extracted", job_confidence: 0, job_raw: c.addr });
  lines.push({ id: duuid(), financial_id: fid, document_id: docId, line_no: 1, description: desc, qty: null, unit_price: null, amount: total.toFixed(2), category_guess: null, page_no: 1 });
}

const N = 300;
for (let i = 0; i < N; i++) {
  let name; do { name = `${FIRST[(i * 7 + int(0, 39)) % 40]} ${LAST[int(0, 29)]}`; } while (nameSeen.has(name)); nameSeen.add(name);
  let r = rnd(), a = 0, city = CITIES[0]; for (const c of CITIES) { a += c[3]; if (r < a) { city = c; break; } }
  const zip = pick(city[2]);
  const addr = `${int(100, 9899)} ${pick(STREETS)}, ${city[0]}, ${city[1]} ${zip}`;
  const em = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}${i}@example.com`;
  const phone = `(520) 555-${String(int(100, 999)).padStart(4, "0")}`;
  const cid = duuid();
  const c = { id: cid, key: `c${i}`, name, addr, city: city[0], zip, phone, email: em, eq: [], docs: [] };
  entities.push({ id: cid, entity_type: "customer", merged_into: null, customer_number: `C-${String(i + 1).padStart(5, "0")}`, data: { customer_name: name, service_address: addr, phone, email: em }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  customers.push(c);
  const nEq = rnd() < 0.62 ? 1 : rnd() < 0.7 ? 2 : 3;
  const usedTypes = new Set();
  for (let k = 0; k < nEq; k++) {
    let def = pickEq(), tries = 0; while (usedTypes.has(def.type) && tries++ < 6) def = pickEq(); usedTypes.add(def.type);
    const [mfr, model, term] = pick(def.brands);
    const inst = rdate(2012, 2026); const installDate = inst > MAXD ? MAXD : inst;
    const serial = `${mfr.slice(0, 2).toUpperCase()}${int(1000000, 9999999)}`;
    const gal = def.gal ? pick(def.gal) : null;
    const regDate = term ? iso(new Date(Date.parse(installDate) + int(3, 40) * 864e5)) : null;
    const eq = { id: duuid(), type: def.type, mfr, model, serial, gal, installDate, regDate, term, expires: term ? addYears(installDate, term) : null };
    c.eq.push(eq);
    const data = { serial_number: serial, model, manufacturer: mfr, equipment_type: def.type, installation_date: installDate, service_address: addr };
    if (gal) data.gallons = `${gal} gallon`;
    if (regDate) data.warranty_registered_date = regDate;
    if (term) data.warranty = { brand: mfr.toLowerCase(), brandLabel: mfr, brandVerified: true, installDate, installDatePrecision: "day", registrationOnFile: regDate, expires: eq.expires, expiresBasis: "computed", expiresPrecision: "day", termYears: term, termConditional: false, notes: [] };
    entities.push({ id: eq.id, entity_type: "equipment", merged_into: null, customer_id: cid, data, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    // install invoice
    const tech = pick(TECHS), total = int(2, 120) * 25 + (def.type.includes("tankless") ? 1800 : def.type.includes("tank") ? 900 : 400);
    const inv = `INV-${invN++}`, work = `Install ${gal ? gal + " gallon " : ""}${mfr} ${def.type.replace(/ \(.*\)/, "")}${def.type.includes("tankless") ? " (tankless)" : ""}`;
    const status = installDate > "2026-08-15" ? "unpaid" : "paid";
    const t1 = `${head("INVOICE")}\nInvoice #: ${inv}\nDate: ${us(installDate)}\nBill To: ${name}\nService Address: ${addr}\nPhone: ${phone}\nEmail: ${em}\nEquipment: ${mfr} ${model}\nSerial: ${serial}\nDescription of work:\n${work}\nLabor: ${(int(2, 9) / 2).toFixed(1)} hrs\nTOTAL DUE: $${total.toFixed(2)}\nTechnician: ${tech}\nStatus: ${status === "paid" ? "Completed - Paid" : "Completed - Balance due"}`;
    const d1 = mkDoc("invoice", installDate, t1, c); linkEq(d1, eq); c.docs.push({ type: "invoice", date: installDate, tech, total, inv });
    for (const [kk, v] of [["invoice_number", inv], ["invoice_date", installDate], ["service_date", installDate], ["work_performed", work], ["installation_date", installDate], ["technician", tech], ["status", "Completed"], ["manufacturer", mfr], ["model", model], ["serial_number", serial], ["equipment_type", def.type], ["gallons", gal ? `${gal} gallon` : null]]) ex(d1, eq.id, kk, v, installDate);
    fin(d1, "invoice", c, installDate, inv, total, status, work);
    if (term) {
      const t2 = `${head("WARRANTY REGISTRATION")}\nCustomer: ${name}\nService Address: ${addr}\nManufacturer: ${mfr}\nModel: ${model}\nSerial: ${serial}\nInstall Date: ${us(installDate)}\nRegistration Date: ${us(regDate)}\nWarranty Term: ${term} years\nInstalled by: ${tech}`;
      const d2 = mkDoc("warranty-registration", regDate, t2, c); linkEq(d2, eq);
      for (const [kk, v] of [["manufacturer", mfr], ["model", model], ["serial_number", serial], ["warranty_registered_date", regDate], ["warranty_term", `${term} years`], ["installation_date", installDate]]) ex(d2, eq.id, kk, v, regDate);
    }
    if (def.type !== "sump pump" && def.type !== "water softener" && rnd() < 0.7) {
      const pm = `PM-${pmN++}`;
      const t3 = `City of ${city[0]} - PLUMBING PERMIT\nPermit #: ${pm}\nIssued: ${us(installDate)}\nSite Address: ${addr}\nOwner: ${name}\nWork: ${def.type.includes("backflow") ? "backflow assembly installation" : "water heater installation"}\nContractor: ${CO}`;
      const d3 = mkDoc("permit", installDate, t3, c); for (const [kk, v] of [["permit_number", pm], ["service_date", installDate]]) ex(d3, c.id, kk, v, installDate);
    }
    if (def.type === "backflow preventer") {
      const yrs = int(1, 4);
      for (let y = 1; y <= yrs; y++) {
        const dt = addYears(installDate, y); if (dt > MAXD) break;
        const pass = rnd() < 0.86 ? "PASSED" : "FAILED"; const tester = pick(TECHS);
        const t4 = `${head("BACKFLOW ASSEMBLY TEST REPORT")}\nDate of test: ${us(dt)}\nSite Address: ${addr}\nOwner: ${name}\nDevice: ${mfr} ${model} (SN ${serial})\nTest result: ${pass}\nCertified tester: ${tester}`;
        const d4 = mkDoc("backflow-test-certificate", dt, t4, c); linkEq(d4, eq);
        for (const [kk, v] of [["service_date", dt], ["backflow_test_result", pass], ["technician", tester], ["serial_number", serial]]) ex(d4, eq.id, kk, v, dt);
        c.docs.push({ type: "backflow", date: dt, result: pass, eqId: eq.id });
      }
    }
  }
  // service tickets
  for (let s = 0, n = int(0, 3); s < n; s++) {
    const dt = rdate(2015, 2026); const d = dt > MAXD ? MAXD : dt; const tech = pick(TECHS); const tk = `T-${tkN++}`;
    const prob = pick(["no hot water", "slow drain in kitchen", "leaking supply line", "low water pressure", "running toilet", "water heater pilot out", "hose bib dripping"]);
    const fix = pick(["replaced supply line", "cleared drain with cable", "replaced fill valve", "relit pilot and tested", "replaced hose bib", "adjusted pressure regulator"]);
    const t5 = `${head("SERVICE TICKET")}\nTicket #: ${tk}\nDate: ${us(d)}\nCustomer: ${name}\nService Address: ${addr}\nProblem reported: ${prob}\nWork performed: ${fix}\nTechnician: ${tech}`;
    const d5 = mkDoc("service-ticket", d, t5, c);
    for (const [kk, v] of [["service_date", d], ["work_performed", fix], ["technician", tech], ["service_type", prob]]) ex(d5, c.id, kk, v, d);
    c.docs.push({ type: "service-ticket", date: d, tech });
  }
  if (rnd() < 0.2) {
    const dt = rdate(2018, 2026); const d = dt > MAXD ? MAXD : dt;
    const t6 = `${head("MAINTENANCE AGREEMENT")}\nCustomer: ${name}\nService Address: ${addr}\nTerm: 12 months\nStart date: ${us(d)}\nAnnual fee: $${int(9, 25) * 10}.00\nCoverage: annual water heater flush and inspection`;
    const d6 = mkDoc("maintenance-agreement", d, t6, c); ex(d6, c.id, "agreement_term", "12 months", d); ex(d6, c.id, "service_date", d, d); c.docs.push({ type: "maintenance-agreement", date: d });
  }
  if (rnd() < 0.3) {
    const dt = rdate(2020, 2026); const d = dt > MAXD ? MAXD : dt; const tot = int(8, 90) * 50; const w = pick(["whole-house repipe (PEX)", "water softener install", "sewer line replacement", "tankless conversion"]);
    const t7 = `${head("PROPOSAL / ESTIMATE")}\nDate: ${us(d)}\nPrepared for: ${name}\nService Address: ${addr}\nProposed work: ${w}\nEstimate total: $${tot.toFixed(2)}`;
    const d7 = mkDoc("proposal-quote", d, t7, c); ex(d7, c.id, "work_performed", w, d); c.docs.push({ type: "proposal-quote", date: d });
  }
  if (rnd() < 0.15) {
    const dt = rdate(2019, 2026); const d = dt > MAXD ? MAXD : dt; const tech = pick(TECHS);
    const f = pick(["root intrusion at 40 ft", "belly in line near cleanout", "line clear, no defects", "offset joint at 22 ft"]);
    const t8 = `${head("SEWER LINE CAMERA INSPECTION")}\nDate: ${us(d)}\nCustomer: ${name}\nService Address: ${addr}\nFindings: ${f}\nTechnician: ${tech}`;
    const d8 = mkDoc("sewer-camera-report", d, t8, c); for (const [kk, v] of [["service_date", d], ["technician", tech], ["notes", f]]) ex(d8, c.id, kk, v, d); c.docs.push({ type: "sewer-camera-report", date: d });
  }
}

const exportData = { tenantKey: "plumbing-synth-r38", tenantName: CO, exportedAt: "2026-09-27T00:00:00Z", documents, pages, extractions, entities, document_entity_links: links, facets: [], audit_log: [], truncated: false, financials, financial_lines: lines };
fs.mkdirSync(path.join(ROOT, "test-docs/tenants/plumbing"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "test-docs/tenants/plumbing/export.json"), JSON.stringify(exportData));
console.log(`plumbing tenant: ${customers.length} customers, ${documents.length} docs, ${extractions.length} extractions, ${financials.length} financials`);

/* ------------------------------------------------------------ owner-voice questions (held out, written before any code change) */
const Q = [];
let qn = 0;
const add = (shape, text, cmp, sql, params = [], extra = {}) => Q.push({ id: `plumb-${String(++qn).padStart(3, "0")}`, text, category: "blind-r38-plumbing", shape, cmp, oracle: { sql, params }, citationRequired: true, ...extra });
const sample = (arr, n) => { const a = [...arr]; const out = []; while (a.length && out.length < n) out.push(a.splice(int(0, a.length - 1), 1)[0]); return out; };
const CUST = `entity_type='customer' AND merged_into IS NULL`;
const oneEq = customers.filter((c) => c.eq.length === 1);
const nameQ = `SELECT %COL% AS v FROM entities WHERE ${CUST} AND data->>'customer_name' ILIKE $1`;

for (const c of sample(customers, 6)) add("lookup_phone", pick([`what's the phone number for ${c.name}`, `${c.name} phone?`, `got a number for ${c.name}?`]), "value", nameQ.replace("%COL%", "data->>'phone'"), [c.name]);
for (const c of sample(customers, 5)) add("lookup_address", pick([`where does ${c.name} live`, `what's ${c.name}'s address`, `address for ${c.name}`]), "value", nameQ.replace("%COL%", "data->>'service_address'"), [c.name]);
for (const c of sample(oneEq, 6)) add("lookup_brand", pick([`what brand does ${c.name} have`, `what make is the ${c.eq[0].type.replace(/ \(.*\)/, "")} at ${c.name}'s place`, `${c.name} - which manufacturer?`]), "value", `SELECT e.data->>'manufacturer' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`, [c.name]);
for (const c of sample(oneEq, 6)) add("lookup_install_date", pick([`when did we install ${c.name}'s unit`, `install date for ${c.name}`, `how long ago did we put in the ${c.eq[0].type.replace(/ \(.*\)/, "")} for ${c.name}`]), "value", `SELECT e.data->>'installation_date' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`, [c.name]);
for (const c of sample(oneEq, 5)) add("lookup_serial", pick([`serial number for ${c.name}'s ${c.eq[0].type.replace(/ \(.*\)/, "")}`, `what's the serial on the unit at ${c.addr.split(",")[0]}`]), "value", `SELECT e.data->>'serial_number' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'service_address' ILIKE $1`, [c.addr.split(",")[0] + "%"]);
for (const c of sample(oneEq.filter((c) => c.eq[0].gal), 5)) add("lookup_gallons", pick([`how many gallons is ${c.name}'s tank`, `what size water heater does ${c.name} have`]), "value", `SELECT e.data->>'gallons' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`, [c.name]);
for (const c of sample(customers.filter((c) => c.docs.filter((d) => d.type === "invoice").length === 1), 5)) add("lookup_installer", pick([`who installed ${c.name}'s unit`, `which plumber did the job for ${c.name}`, `who was the tech on ${c.name}'s install`]), "value", `SELECT x.value AS v FROM extractions x JOIN documents d ON d.id=x.document_id JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE x.field_key='technician' AND d.document_type='invoice' AND c.entity_type='customer' AND c.data->>'customer_name' ILIKE $1`, [c.name]);
for (const c of sample(customers.filter((c) => c.docs.some((d) => d.type === "backflow")), 5)) { const last = c.docs.filter((d) => d.type === "backflow").sort((a, b) => b.date.localeCompare(a.date))[0]; add("backflow_last_test", pick([`when was the backflow at ${c.name}'s last tested`, `last backflow test date for ${c.name}`]), "value", `SELECT max(x.value) AS v FROM extractions x JOIN documents d ON d.id=x.document_id JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE x.field_key='service_date' AND d.document_type='backflow-test-certificate' AND c.entity_type='customer' AND c.data->>'customer_name' ILIKE $1`, [c.name]); }
for (const c of sample(customers.filter((c) => c.docs.filter((d) => d.type === "backflow").length === 1), 4)) add("backflow_result", pick([`did ${c.name}'s backflow pass`, `backflow test result for ${c.name}`]), "value", `SELECT x.value AS v FROM extractions x JOIN documents d ON d.id=x.document_id JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE x.field_key='backflow_test_result' AND c.entity_type='customer' AND c.data->>'customer_name' ILIKE $1`, [c.name]);

const EQC = (cond) => `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND ${cond}`;
add("count_type", "how many tankless water heaters have we installed", "number", EQC(`e.data->>'equipment_type'='water heater (tankless)'`));
add("count_type", "how many sump pumps do we have on file", "number", EQC(`e.data->>'equipment_type'='sump pump'`));
add("count_type", "how many backflow preventers are we tracking", "number", EQC(`e.data->>'equipment_type'='backflow preventer'`));
add("count_type", "number of water softeners we've put in", "number", EQC(`e.data->>'equipment_type'='water softener'`));
add("count_type", "how many tank water heaters", "number", EQC(`e.data->>'equipment_type'='water heater (tank)'`));
for (const b of ["Rheem", "Navien", "Rinnai", "Watts", "A.O. Smith", "Bradford White"]) { add("count_brand_units", `how many ${b} units do we have`, "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [b]);
  add("count_brand_customers", `how many customers have a ${b}`, "number", `SELECT count(DISTINCT e.customer_id) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [b]); }
for (const ci of ["Oro Valley", "Marana", "Sahuarita", "Green Valley", "Vail"]) add("count_city", pick([`how many customers do we have in ${ci}`, `how many of our customers are in ${ci}`]), "number", `SELECT count(*) AS n FROM entities WHERE ${CUST} AND data->>'service_address' ILIKE $1`, [`%, ${ci}, %`]);
for (const y of [2023, 2024, 2025]) add("count_invoices_year", pick([`how many invoices did we write in ${y}`, `how many invoices in ${y}`]), "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='invoice_date' AND d.document_type='invoice' AND x.value LIKE $1`, [`${y}-%`]);
for (const t of TECHS.slice(0, 4)) add("count_tech_invoices", pick([`how many jobs has ${t.split(" ")[0]} invoiced`, `how many invoices did ${t} do`]), "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='technician' AND d.document_type='invoice' AND x.value ILIKE $1`, [t]);
add("count_backflow_failed", "how many backflow tests failed", "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key='backflow_test_result' AND x.value ILIKE 'fail%'`);
add("count_backflow_tests", "how many backflow tests have we done", "number", `SELECT count(*) AS n FROM documents d WHERE d.document_type='backflow-test-certificate'`);
add("count_docs_type", "how many sewer camera reports do we have", "number", `SELECT count(*) AS n FROM documents d WHERE d.document_type='sewer-camera-report'`);
add("count_docs_type", "how many maintenance agreements are on file", "number", `SELECT count(*) AS n FROM documents d WHERE d.document_type='maintenance-agreement'`);
add("count_docs_type", "how many permits do we have", "number", `SELECT count(*) AS n FROM documents d WHERE d.document_type='permit'`);
add("count_gal", "how many 75 gallon water heaters do we have", "number", EQC(`e.data->>'gallons'='75 gallon'`));
for (const y of [2026, 2027, 2028]) add("warranty_expiring_year", pick([`how many warranties expire in ${y}`, `whose water heater warranty runs out in ${y}`.replace("whose", "how many customers have a water heater warranty that runs out in")]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->'warranty'->>'expires' LIKE $1`, [`${y}-%`]);
add("warranty_expired", "how many units are out of warranty", "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->'warranty'->>'expires' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND (e.data->'warranty'->>'expires')::date < $1::date`, ["@today"]);

const SETSQL = (cond, p) => [`SELECT DISTINCT c.data->>'customer_name' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND ${cond}`, p];
for (const b of ["Navien", "Rinnai"]) { const [s, p] = SETSQL(`e.data->>'manufacturer' ILIKE $1`, [b]); add("list_brand", pick([`which customers have a ${b}`, `list everyone with a ${b}`]), "set", s, p); }
{ const [s, p] = SETSQL(`e.data->>'equipment_type'='sump pump'`, []); add("list_type", "who has a sump pump", "set", s, p); }
add("list_failed_backflow", "which customers failed their backflow test", "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM extractions x JOIN document_entity_links l ON l.document_id=x.document_id JOIN entities c ON c.id=l.entity_id WHERE x.field_key='backflow_test_result' AND x.value ILIKE 'fail%' AND c.entity_type='customer'`);
add("list_docs_type", "who has a sewer camera report", "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE d.document_type='sewer-camera-report' AND c.entity_type='customer'`);
add("list_docs_type", "which customers have a maintenance agreement", "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE d.document_type='maintenance-agreement' AND c.entity_type='customer'`);

for (const c of sample(customers, 4)) add("yesno_agreement", pick([`does ${c.name} have a maintenance agreement`, `is ${c.name} on a maintenance plan`]), "yesno", `SELECT EXISTS (SELECT 1 FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE d.document_type='maintenance-agreement' AND c.entity_type='customer' AND c.data->>'customer_name' ILIKE $1) AS v`, [c.name], { citationRequired: false });
for (const ci of ["Sahuarita", "Phoenix", "Vail"]) add("yesno_city", `do we have any customers in ${ci}`, "yesno", `SELECT EXISTS (SELECT 1 FROM entities WHERE ${CUST} AND data->>'service_address' ILIKE $1) AS v`, [`%, ${ci}, %`], { citationRequired: false });
for (const c of sample(oneEq.filter((c) => c.eq[0].type.includes("water heater")), 3)) add("yesno_tankless", `does ${c.name} have a tankless water heater`, "yesno", `SELECT EXISTS (SELECT 1 FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.data->>'equipment_type'='water heater (tankless)' AND c.data->>'customer_name' ILIKE $1) AS v`, [c.name], { citationRequired: false });

for (const c of sample(customers, 3)) add("honest_pipe", pick([`what pipe material does ${c.name} have`, `is ${c.name}'s house PEX or copper`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key='pipe_material'`, [], { citationRequired: false });
for (const c of sample(customers, 2)) add("honest_pressure", `what's the water pressure at ${c.name}'s house`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'pressure'`, [], { citationRequired: false });
add("honest_other", "what's the weather in Tucson today", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'weather'`, [], { citationRequired: false });

fs.writeFileSync(path.join(ROOT, "test-docs/scorecard/blind/plumb-owner-1.json"), JSON.stringify({ version: "r38-plumb-1", category: "blind-r38-plumbing", source: "scripts/gen-plumbing-tenant.mjs (seeded; questions written before any plumbing-pack code change)", questions: Q }, null, 1));
console.log(`questions: ${Q.length}`);
