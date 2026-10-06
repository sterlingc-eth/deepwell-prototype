#!/usr/bin/env node
/**
 * R39: (1) a count/list question that names a thing the asking organization does not have must NEVER come back as the unfiltered total;
 *      (2) counts must be exact for organizations with more than 500 records (no silent 500 cap).
 * Truth is computed from the raw export rows here, never from Donovan. A "confident wrong" answer is one that states a number that is not the truth.
 * Declining (model/clarify path, no number) is acceptable for questions marked `okDecline`; it is never acceptable for a plain no-condition count.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");

const ensure = (p, gen) => { if (!fs.existsSync(p)) execFileSync("node", [gen], { stdio: "ignore" }); return JSON.parse(fs.readFileSync(p, "utf8")); };
const hvacData = JSON.parse(fs.readFileSync("scripts/golden/golden-export.json", "utf8"));
const plumbData = ensure("test-docs/tenants/plumbing/export.json", "scripts/gen-plumbing-tenant.mjs");

// ---- a deterministic organization with more than 500 of each kind of record (1,250 customers, 1,250 units, 1,250 invoices)
const BIG = 1250;
function bigExport() {
  const brands = ["Rheem", "Bosch", "AO Smith", "Bradford White"], cities = ["Tucson", "Marana", "Vail"], types = ["water heater (tank)", "sump pump"];
  const entities = [], documents = [], links = [];
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const id = (k, i) => `${k}-0000-4000-8000-${String(i).padStart(12, "0")}`;
  for (let i = 0; i < BIG; i++) {
    const cid = id("c0000001", i), city = cities[rnd(3)];
    entities.push({ id: cid, entity_type: "customer", merged_into: null, customer_number: `C-${i}`, data: { customer_name: `Casey Person${i}`, service_address: `${i} W Main St, ${city}, AZ 857${String(i % 90 + 10)}` }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    entities.push({ id: id("e0000001", i), entity_type: "equipment", merged_into: null, customer_id: cid, data: { serial_number: `SN${i}`, manufacturer: brands[rnd(4)], equipment_type: types[rnd(2)], installation_date: "2022-03-26" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    const did = id("d0000001", i);
    documents.push({ id: did, batch_id: null, original_filename: `inv-${i}.pdf`, document_type: "invoice", sha256_hash: `${i}`.padStart(64, "a"), file_size_bytes: 100, stage: "linked", created_at: "2026-03-01T12:00:00Z", processed_at: "2026-03-01T12:00:00Z" });
    links.push({ id: id("f0000001", i), document_id: did, entity_id: cid, confidence: 0.9, linked_by: "r39", created_at: "2026-03-01T12:00:00Z" });
  }
  return { tenantKey: "r39-big", tenantName: "r39-big", exportedAt: "2026-09-25T00:00:00Z", documents, pages: [], extractions: [], entities, document_entity_links: links, facets: [], audit_log: [] };
}
const bigData = bigExport();
function uniExport() {
  const rows = [["Ana Muñoz", "Cañon City"], ["Zoë Café", "Saint-Étienne"], ["Étienne Dubois", "Cañon City"], ["Pat Lee", "Tucson"], ["Sam Roe", "Tucson"]];
  const entities = [], documents = [], links = [];
  rows.forEach(([n, city], i) => {
    const cid = `c0000002-0000-4000-8000-${String(i).padStart(12, "0")}`;
    entities.push({ id: cid, entity_type: "customer", merged_into: null, customer_number: `U-${i}`, data: { customer_name: n, service_address: `${i} W Main St, ${city}, AZ 85701` }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    entities.push({ id: `e0000002-0000-4000-8000-${String(i).padStart(12, "0")}`, entity_type: "equipment", merged_into: null, customer_id: cid, data: { serial_number: `US${i}`, manufacturer: i % 2 ? "Rheem" : "Bosch", equipment_type: "water heater (tank)", installation_date: "2022-03-26" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  });
  entities.push({ id: "e0000002-0000-4000-8000-0000000000ff", entity_type: "equipment", merged_into: null, customer_id: null, data: { serial_number: "ORPHAN", manufacturer: "Rheem", equipment_type: "water heater (tank)" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
  return { tenantKey: "r39-uni", tenantName: "r39-uni", exportedAt: "2026-09-25T00:00:00Z", documents, pages: [], extractions: [], entities, document_entity_links: links, facets: [], audit_log: [] };
}
const uniData = uniExport();
// an HVAC variant whose invoices carry due date / PO / subtotal / balance / amount paid in the financials table (some invoices have them, some do not)
function hvacbExport() {
  const d = JSON.parse(JSON.stringify(hvacData));
  d.financials.filter((x) => x.doc_kind === "invoice").forEach((x, i) => {
    if (i % 3 === 0) x.due_date = `2026-${String(1 + (i % 12)).padStart(2, "0")}-15`;
    if (i % 5 === 0) { x.subtotal = String((+x.total - 37.5).toFixed(2)); x.tax = "37.50"; }
    if (i % 7 === 0) { x.balance_due = String((+x.total / 2).toFixed(2)); x.amount_paid = String((+x.total / 2).toFixed(2)); x.status = "partial"; }
    if (i % 4 === 0) x.po_number = `PO-${1000 + i}`;
    if (i % 11 === 0) x.total = null;
  });
  d.tenantKey = "r39-hvacb"; d.tenantName = "r39-hvacb";
  return JSON.parse(JSON.stringify(d).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (m) => ((parseInt(m[0], 16) + 8) % 16).toString(16) + m.slice(1)));
}
const hvacbData = hvacbExport();
// ---- round 4: invoice-field organizations. Each starts from the golden (or plumbing) export; the cases mirror how a field can really be stored:
// the financials column, a person's correction on it ('' = cleared, null = cleared), an extraction row (value, blank, whitespace, only a correction), or an unrelated look-alike key.
const idMap = (s, k) => s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (m) => ((parseInt(m[0], 16) + k) % 16).toString(16) + m.slice(1));
let xSeq = 0; const xId = () => `ffff0a04-0000-4000-8000-${String(xSeq++).padStart(12, "0")}`;
const addX = (d, f, key, value, extra = {}) => d.extractions.push({ id: xId(), document_id: f.document_id, entity_id: null, field_key: key, value, confidence: 0.9, source_facet_id: null, schema_version: 1, created_at: "2026-01-01T00:00:00Z", ...extra });
const variant = (src, name, k, fn) => { const d = JSON.parse(JSON.stringify(src)); d.tenantKey = name; d.tenantName = name; fn(d, d.financials.filter((x) => x.doc_kind === "invoice")); return JSON.parse(idMap(JSON.stringify(d), k)); };
const CYC = { due_date: { key: "due_date", decoy: ["balance_due", "10.00"], sh: 0, val: "2026-03-01" }, po_number: { key: "po_number", decoy: ["po_box", "PO Box 4"], sh: 3, val: "PO-77" },
  subtotal: { key: "subtotal", decoy: ["subtotal_note", "n/a"], sh: 5, val: "100.00" }, tax: { key: "tax", decoy: ["tax_id", "12-345"], sh: 7, val: "8.25" },
  balance_due: { key: "balance_due", decoy: ["previous_balance", "5.00"], sh: 2, val: "50.00" }, amount_paid: { key: "amount_paid", decoy: ["payment_method", "check"], sh: 9, val: "25.00" } };
function cycle(d, invs) {
  invs.forEach((x, i) => Object.entries(CYC).forEach(([col, F]) => {
    x[col] = null; x.corrections = x.corrections || {};
    switch ((i + F.sh) % 10) {
      case 0: x[col] = F.val; break;
      case 1: x.corrections[col] = F.val; break;
      case 2: x[col] = F.val; x.corrections[col] = ""; break;
      case 3: x[col] = F.val; x.corrections[col] = null; break;
      case 4: addX(d, x, F.key, F.val); break;
      case 5: addX(d, x, F.key, ""); break;
      case 6: addX(d, x, F.key, "   "); break;
      case 7: addX(d, x, F.decoy[0], F.decoy[1]); break;
      default: break;
    }
  }));
}
const hvaccData = variant(hvacData, "r39-hvacc", 3, (d, inv) => cycle(d, inv));
const plumbcData = variant(plumbData, "r39-plumbc", 3, (d, inv) => cycle(d, inv));
const hvaceData = variant(hvacData, "r39-hvace", 4, (d, inv) => inv.slice(0, 30).forEach((f, i) => { f.due_date = "2026-03-01"; if (i < 10) f.corrections = { due_date: "" }; }));
const hvacfData = variant(hvacData, "r39-hvacf", 5, (d, inv) => inv.slice(0, 10).forEach((f) => addX(d, f, "balance_due", "55.00")));
const hvacgData = variant(hvacData, "r39-hvacg", 6, (d, inv) => inv.slice(0, 30).forEach((f, i) => { if (i < 10) { f.tax = "0.00"; f.balance_due = "0.00"; f.status = "paid"; } else if (i < 20) f.tax = "8.25"; else { f.balance_due = "100.00"; f.status = "unpaid"; } }));
const hvachData = variant(hvacData, "r39-hvach", 7, (d, inv) => inv.slice(0, 10).forEach((f) => { addX(d, f, "payment_terms", "Net 30"); addX(d, f, "tax_id", "12-3456"); addX(d, f, "po_box", "PO Box 4"); }));
const hvacrData = variant(hvacData, "r39-hvacr", 12, (d, inv) => inv.slice(0, 10).forEach((f) => addX(d, f, "po_number", null, { corrected_value: "PO-555", corrected_by: "owner", corrected_at: "2026-09-01T00:00:00Z", confidence: null })));
// round 5: a shop whose financials table lacks 8 invoices the documents table has (documents 120 vs financials 112): the plain count says 120, so a field-absence answer over 112 must decline
const hvacpData = variant(hvacData, "r39-hvacp", 2, (d, inv) => { inv.slice(0, 40).forEach((f, i) => { if (i >= 8) f.due_date = "2026-03-01"; }); const drop = new Set(inv.slice(0, 8).map((f) => f.id)); d.financials = d.financials.filter((f) => !drop.has(f.id)); });
// all-payable and all-CAD shops: the receivable-USD population is empty although invoices exist, so amount questions must decline instead of 0
const hvacyData = variant(hvacData, "r39-hvacy", 9, (d, inv) => inv.forEach((f) => { f.direction = "payable"; }));
const hvaczData = variant(hvacData, "r39-hvacz", 10, (d, inv) => inv.forEach((f) => { f.currency = "CAD"; }));
// whitespace-only values (tab, newline, no-break space, em space, ideographic space) are blank: in a correction, an extraction row, or a text column (due_date is a DATE column, so only its correction and extraction can hold one)
const WSV = ["\t", "\n", "\u00a0", " \t\n\u00a0 ", "\u2003", "\u3000"];
const hvacwData = variant(hvacData, "r39-hvacw", 11, (d, inv) => inv.slice(0, 60).forEach((f, i) => {
  const k = i % 6, w = WSV[(i >> 1) % WSV.length];
  if (k === 0) { f.due_date = null; f.corrections = { ...(f.corrections || {}), due_date: w }; } else if (k === 1) { f.due_date = "2026-03-01"; f.corrections = { ...(f.corrections || {}), due_date: w }; } else if (k === 2) addX(d, f, "due_date", w); else if (k === 3) f.due_date = "2026-03-01";
  const m = i % 4; if (m === 0) f.po_number = w; else if (m === 1) addX(d, f, "po_number", w); else if (m === 2) f.po_number = "PO-9";
}));


const load = async (d, key) => (await off.loadExportIntoNewTenant(lite, d, { tenantKey: `offline:${key}`, tenantName: key })).ctx;
const orgs = { hvac: { ctx: await load(hvacData, "r39-hvac"), d: hvacData }, plumb: { ctx: await load(plumbData, "r39-plumb"), d: plumbData }, big: { ctx: await load(bigData, "r39-big"), d: bigData }, uni: { ctx: await load(uniData, "r39-uni"), d: uniData }, hvacb: { ctx: await load(hvacbData, "r39-hvacb"), d: hvacbData }, hvacc: { ctx: await load(hvaccData, "r39-hvacc"), d: hvaccData }, plumbc: { ctx: await load(plumbcData, "r39-plumbc"), d: plumbcData }, hvace: { ctx: await load(hvaceData, "r39-hvace"), d: hvaceData }, hvacf: { ctx: await load(hvacfData, "r39-hvacf"), d: hvacfData }, hvacg: { ctx: await load(hvacgData, "r39-hvacg"), d: hvacgData }, hvach: { ctx: await load(hvachData, "r39-hvach"), d: hvachData }, hvacr: { ctx: await load(hvacrData, "r39-hvacr"), d: hvacrData }, hvacp: { ctx: await load(hvacpData, "r39-hvacp"), d: hvacpData }, hvacy: { ctx: await load(hvacyData, "r39-hvacy"), d: hvacyData }, hvacz: { ctx: await load(hvaczData, "r39-hvacz"), d: hvaczData }, hvacw: { ctx: await load(hvacwData, "r39-hvacw"), d: hvacwData } };

// ---- truth, straight from the raw rows
const live = (d, t) => d.entities.filter((e) => e.entity_type === t && !e.merged_into);
const cityOf = (c) => { const p = String(c.data.service_address ?? "").split(",").map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2].toLowerCase() : ""; };
const T = {
  units: (d) => live(d, "equipment").length,
  customers: (d) => live(d, "customer").length,
  invoices: (d) => d.documents.filter((x) => x.document_type === "invoice").length,
  brand: (d, b) => live(d, "equipment").filter((u) => String(u.data.manufacturer ?? "").toLowerCase() === b.toLowerCase()).length,
  city: (d, c) => live(d, "customer").filter((x) => cityOf(x) === c.toLowerCase()).length,
  etype: (d, re) => live(d, "equipment").filter((u) => re.test(String(u.data.equipment_type ?? ""))).length,
  surname: (d, s) => live(d, "customer").filter((x) => String(x.data.customer_name ?? "").toLowerCase().split(/\s+/).includes(s.toLowerCase())).length,
};

// ---- questions: { org, q, expect, okDecline }.  expect: {zeroOf: M} -> "0 of M" ; {n, of} -> "n of M" ; {total: n} -> the number n appears as the answer ; {noNumberUnless: n} -> declining is fine, any other number is wrong
const Q = [];
const add = (org, q, expect, okDecline = true) => Q.push({ org, q, expect, okDecline });
const H = hvacData, P = plumbData;
const hu = T.units(H), pu = T.units(P);
// unknown brand
for (const b of ["Navien", "Rinnai", "Bradford White", "Takagi", "Zanussi"]) if (!T.brand(H, b)) add("hvac", `how many ${b} units`, { zeroOf: hu });
for (const b of ["Trane", "Mitsubishi", "Bryant", "Fujitsu"]) if (!T.brand(P, b)) add("plumb", `how many ${b} units do we have`, { zeroOf: pu });
add("hvac", "do we have any Navien units", { zeroOf: hu });
add("hvac", "how many units are Navien", { zeroOf: hu });
// unknown city / customers
for (const c of ["Narnia", "Phoenix", "Flagstaff"]) { if (!T.city(H, c)) add("hvac", `how many customers in ${c}`, { zeroOf: T.customers(H) }); }
add("plumb", "how many customers do we have in Mesa", { zeroOf: T.customers(P) });
// unknown technician / customer
add("hvac", "how many invoices did Dana Whitfield do", { noNumberUnless: 0 });
add("hvac", "how many invoices did Priya Natarajan do", { noNumberUnless: 0 });
add("plumb", "how many invoices did Kevin Pratt do", { noNumberUnless: 0 });
add("hvac", "how many customers named Smythe", { zeroOf: T.customers(H) });
add("plumb", "how many customers named Pratt", { noNumberUnless: T.surname(P, "Pratt") });
// isolation: names that exist in the OTHER org only
add("hvac", "how many Rinnai units", { zeroOf: hu });
add("hvac", "how many customers in Oro Valley", { noNumberUnless: T.city(H, "oro valley") });
add("hvac", "how many Navien tankless units", { noNumberUnless: 0 });
add("plumb", "how many Carrier units", { zeroOf: pu });
add("plumb", "how many Daikin units", { zeroOf: pu });
add("plumb", "how many invoices did Wyatt Coburn do", { noNumberUnless: 0 });
add("plumb", "how many invoices did Marisol Vega do", { noNumberUnless: 0 });
// known (right "N of M")
for (const b of ["Carrier", "Trane", "Lennox", "Goodman"]) add("hvac", `how many ${b} units`, { n: T.brand(H, b), of: hu });
add("hvac", "how many carrier units do we have", { n: T.brand(H, "Carrier"), of: hu });
add("hvac", "how many CARRIER units", { n: T.brand(H, "Carrier"), of: hu });
add("hvac", "how many Carier units", { n: T.brand(H, "Carrier"), of: hu }); // misspelling of a known brand: answered for the known brand or declined, never the total
add("hvac", "how many customers in Mesa", { n: T.city(H, "Mesa"), of: T.customers(H) });
add("hvac", "how many customers in Tucson", { n: T.city(H, "Tucson"), of: T.customers(H) });
add("hvac", "how many customers named Whitfield", { n: T.surname(H, "Whitfield"), of: T.customers(H) });
for (const b of ["Rinnai", "Rheem", "Navien"]) if (T.brand(P, b)) add("plumb", `how many ${b} units`, { n: T.brand(P, b), of: pu });
add("plumb", "how many sump pumps do we have on file", { n: T.etype(P, /sump/i), of: pu });
add("plumb", "how many backflow preventers are we tracking", { n: T.etype(P, /backflow/i), of: pu });
add("plumb", "how many tankless water heaters have we installed", { n: T.etype(P, /tankless/i), of: pu });
add("plumb", "how many customers in Tucson", { n: T.city(P, "Tucson"), of: T.customers(P) });
add("plumb", "how many customers in Marana", { n: T.city(P, "Marana"), of: T.customers(P) });
// substrings / multi-word of known names
add("hvac", "how many Carr units", { noNumberUnless: 0 });
add("hvac", "how many Mitsu units", { noNumberUnless: 0 });
add("plumb", "how many invoices did Dana do", { noNumberUnless: 0 });
// generic no-condition counts: unchanged, never declined
add("hvac", "how many units do we have", { total: hu }, false);
add("hvac", "how many customers do we have", { total: T.customers(H) }, false);
add("hvac", "how many customers", { total: T.customers(H) }, false);
add("hvac", "how many equipment do we have", { total: hu }, false);
add("plumb", "how many units do we have", { total: pu }, false);
add("plumb", "how many customers do we have", { total: T.customers(P) }, false);
add("plumb", "how many customers", { total: T.customers(P) }, false);
// more than 500 records
add("big", "how many customers do we have", { total: BIG }, false);
add("big", "how many customers", { total: BIG }, false);
add("big", "how many units do we have", { total: BIG }, false);
add("big", "how many equipment do we have", { total: BIG }, false);
add("big", "how many invoices do we have", { total: BIG }, false);
add("big", "how many Rheem units", { n: T.brand(bigData, "Rheem"), of: BIG });
add("big", "how many Bosch units", { n: T.brand(bigData, "Bosch"), of: BIG });
add("big", "how many Navien units", { zeroOf: BIG });
add("big", "how many customers in Tucson", { n: T.city(bigData, "Tucson"), of: BIG });
add("big", "how many customers in Marana", { n: T.city(bigData, "Marana"), of: BIG });
add("big", "how many customers in Mesa", { zeroOf: BIG });
add("big", "how many sump pumps do we have", { n: T.etype(bigData, /sump/i), of: BIG });

// ---- round 2: names that must never become a zero or a total. expect {safe:[totals]}: declining is fine; a zero-style answer or a bare total is wrong. {n,of} / {zeroOf} as above (okDecline).
const HC = T.customers(H), PC = T.customers(P);
const safe = (org, q, ...totals) => add(org, q, { safe: totals.length ? totals : [org === "hvac" ? hu : pu, org === "hvac" ? HC : PC] });
for (const org of ["hvac", "plumb"]) {
  for (const q of ["how many units installed in 2020", "how many units installed in 2022", "how many units made in 2020", "how many customers from 2019", "how many customers in Q3", "how many units installed in Q2 2021", "how many units installed in the 2010s", "how many units installed on Tuesday", "how many units installed on 2022-03-26", "how many units in 2009",
    "how many Active units", "how many Expired units", "how many Old units", "how many Residential customers", "how many Commercial customers", "how many Missing units", "how many Chiller units", "how many Thermostat units", "how many Compressor units", "how many 16 SEER units", "how many units in Zone 3", "how many units on Floor 2", "how many units installed by Danny Ochoa", "How Many Units Are In Good Standing",
    "how many AO units", "how many AOS units", "how many BW units", "how many GV units", "how many OV units", "how many QC units", "how many STV units", "how many KP units", "how many MV units", "how many DF units", "how many RS units", "how many WC units",
    "how many units on Maple Street", "how many customers on Elm Street", "how many customers on Main Street", "how many customers on Oak Avenue", "how many units in Oak Avenue", "how many units between $100 and $500", "how many invoices on Tuesday", "how many invoices have been voided", "Navien. how many units", "how many customers named Mercer"])
    safe(org, q);
}
safe("hvac", "how many Navien units in Flagstaff"); safe("hvac", "how many Rheem units in Narnia"); safe("hvac", "how many Trane units with Navien"); safe("plumb", "how many Rinnai tankless units in Flagstaff");
safe("plumb", "how many non-Carrier units"); safe("hvac", "how many non-Carrier units");
add("hvac", "how many HVAC units", { total: hu }, false); safe("hvac", "how many customers in North Phoenix"); safe("hvac", "how many customers in Southern Arizona");
safe("hvac", "how many jobs did Acme do"); safe("plumb", "how many jobs did Team A do");
// customers who own a type: distinct customers, truth from rows
const custWith = (d, re) => new Set(live(d, "equipment").filter((u) => re.test(String(u.data.equipment_type ?? ""))).map((u) => u.customer_id)).size;
add("plumb", "how many customers have a tankless water heater", { safe: [pu, PC, T.etype(P, /tankless/i)] });
add("plumb", "how many customers have a sump pump", { safe: [pu, PC, T.etype(P, /sump/i)] });
add("plumb", "how many customers have a sump pump", { n: custWith(P, /sump/i), of: PC });
add("plumb", "how many tankless units do we have", { n: T.etype(P, /tankless/i), of: pu });
// unicode names (small org: 5 customers)
add("uni", "how many customers named Muñoz", { n: 1, of: 5 });
add("uni", "how many customers in Cañon City", { n: 2, of: 5 });
add("uni", "how many customers in Saint-Étienne", { n: 1, of: 5 });
add("uni", "how many customers named Café", { n: 1, of: 5 });
add("uni", "how many customers named Nuñez", { zeroOf: 5 });
add("uni", "how many customers in Zürich", { zeroOf: 5 });
add("uni", "how many Rinnai units", { zeroOf: 6 });
add("uni", "how many customers", { total: 5 }, false);
// 1,250-record org: exact, never capped, never a total for an unknown or number-like name
add("big", "how many units installed in 2020", { safe: [BIG] });
add("big", "how many AO units", { safe: [BIG] });
add("big", "how many customers have more than 1 unit", { safe: [BIG] });
add("big", "how many Bradford White units", { n: T.brand(bigData, "Bradford White"), of: BIG });
add("big", "how many AO Smith units", { n: T.brand(bigData, "AO Smith"), of: BIG });
add("big", "how many customers in Vail", { n: T.city(bigData, "Vail"), of: BIG });
add("big", "how many units", { total: BIG }, false);

// ---- round 3: every expectation is exact-or-decline unless marked mustDecline; truth is computed from the raw rows
const fin = (d) => d.financials.filter((f) => f.doc_kind === "invoice" && f.direction === "receivable" && f.currency === "USD");
const totals = (d) => fin(d).filter((f) => f.total != null).map((f) => Number(f.total));
const nOver = (d, x) => totals(d).filter((v) => v > x).length, nUnder = (d, x) => totals(d).filter((v) => v < x).length;
const nMissing = (d, col) => fin(d).filter((f) => f[col] == null).length;
const exact = (re, why) => ({ ok: (t) => re.test(t), why });
const mustDecline = () => ({ mustDecline: true });
const known = () => ({ known: true });
const R = { hvac: hvacData, plumb: plumbData, hvacb: hvacbData, hvacc: hvaccData, plumbc: plumbcData, hvace: hvaceData, hvacf: hvacfData, hvacg: hvacgData, hvach: hvachData, hvacr: hvacrData, hvacw: hvacwData };
const money = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// no <field>: the five invoice fields that live in the financials table, plus fields that are not on the closed list (must decline)
// effective value, written independently of the product: a correction (when present on the field) replaces the original; blank / whitespace / null = absent; either storage place counts
const blank = (v) => v == null || String(v).trim() === "";
const finHas = (f, col) => (f.corrections && Object.prototype.hasOwnProperty.call(f.corrections, col) ? !blank(f.corrections[col]) : !blank(f[col]));
const xHas = (d, f, key) => d.extractions.some((x) => x.document_id === f.document_id && x.field_key === key && !blank(x.corrected_value != null ? x.corrected_value : x.value));
const nAbsent = (d, col, key) => fin(d).filter((f) => !finHas(f, col) && !xHas(d, f, key)).length;
const ABS_ORGS = ["hvac", "plumb", "hvacb", "hvacc", "plumbc", "hvace", "hvacf", "hvacg", "hvach", "hvacr", "hvacw"];
const FORMS = (f) => [`how many invoices have no ${f}`, `how many invoices are missing a ${f}`, `how many invoices without a ${f}`, `how many invoices lack a ${f}`, `how many invoices don't have a ${f}`, `how many invoices have a blank ${f}`, `how many invoices have an empty ${f}`];
for (const org of ABS_ORGS) {
  const d = R[org], N = fin(d).length;
  for (const [label, col, key] of [["due date", "due_date", "due_date"], ["PO number", "po_number", "po_number"]]) {
    const n = nAbsent(d, col, key);
    for (const q of FORMS(label).slice(0, org === "hvac" || org === "hvacc" ? 7 : 2)) add(org, q, exact(new RegExp(`^${n} of ${N} invoices have no ${label}`), `${n} of ${N}`));
  }
  // ambiguous: a missing field versus a printed zero / nothing paid; and fields that are not on the lane's list
  for (const f of ["subtotal", "tax", "balance due", "balance", "amount paid", "payment terms", "notes", "vendor", "currency", "billing period", "PO box", "tax id"]) add(org, `how many invoices have no ${f}`, mustDecline());
}
add("hvac", "how many invoices have no due dates", exact(new RegExp(`^${nAbsent(hvacData, "due_date", "due_date")} of ${fin(hvacData).length} invoices have no due date`)));
// single-bound amounts are counted from the SQL, never a LIMITed list (no between-range lane exists: see the parity block below)
for (const org of ["hvac", "plumb", "hvacb", "hvacc"]) {
  const d = R[org];
  for (const x of [100, 500, 2000, 5000]) add(org, `how many invoices over $${x.toLocaleString("en-US")}`, exact(new RegExp(`^${nOver(d, x)} invoices? (?:is|are) over `)));
  for (const x of [500, 1000, 5000]) add(org, `how many invoices under $${x.toLocaleString("en-US")}`, exact(new RegExp(`^${nUnder(d, x)} invoices? (?:is|are) under `)));
}
// between-shapes. There is NO amount-range lane. Pairs that carry a currency marker ($, k, grand, dollars, usd, bucks) must DECLINE (base gave the whole-shop count or a false zero);
// pairs without a marker stay exactly what the base ff5ce37 answered (the text below was produced by running base), or a decline.
const BTW = (n) => ["$100 and $500", "$500 and $1,000", "$1,000 and $2,000", "$2,000 and $3,000", "$3,000 and $5,000", "$100 and $5,000", "$1 and $10,000", "$1,000 and $7,000", "$1,000 and $2,500", "$3,000 and $4,000", "$0 and $100,000", "$2,000 and $2,005", "$2000 and $2005",
  "3 and 4k", "2,000 and 3,000 usd", "$2k and $3k", "3,000 and 2,000 dollars", "1000 and 2000 dollars", "3000 and 4000 usd", "$3000 and $4000", "5 and 10 grand", "2,000 and 3,000 bucks"].slice(0, n);
for (const org of ["hvac", "plumb", "hvacb", "hvacc"]) for (const r of BTW(99)) add(org, `how many invoices between ${r}`, mustDecline());
// bare pairs: base answers (constants from base ff5ce37 on the golden / plumbing exports) or a decline; never a new number
const SORRY = "I can't total invoice amounts yet \u2014 that's coming with the Financials update. I can count invoices and find a specific one if that helps.";
const BASE_BARE = { hvac: { "2020 and 2025": "40 invoices from 2020 through 2025.", "2000 and 2500": "We have 120 invoices on file in 2000 through 2500.", "3000 and 4000": SORRY, "2500 and 3000": SORRY, "1500 and 1800": SORRY, "1000 and 2000": SORRY, "100 and 500": "We have 120 invoices on file.", "1 and 10": "We have 120 invoices on file." },
  plumb: { "2020 and 2025": "182 invoices from 2020 through 2025.", "2000 and 2500": "We have 438 invoices on file in 2000 through 2500.", "3000 and 4000": SORRY, "2500 and 3000": SORRY, "1500 and 1800": SORRY, "1000 and 2000": SORRY, "100 and 500": "We have 438 invoices on file.", "1 and 10": "We have 438 invoices on file." } };
for (const [org, m] of Object.entries(BASE_BARE)) for (const [pair, t] of Object.entries(m)) add(org, `how many invoices between ${pair}`, { ok: (x) => x === t, why: "exactly the base answer (or a decline)" });
add("hvac", "how many invoices between 2020 and 2025", exact(/^40 invoices from 2020 through 2025\.$/));
add("hvac", "how many units between $100 and $500", mustDecline());
for (const org of ["hvac", "plumb", "hvacb"]) for (const q of [
  "how many invoices between $2,000 and $3,000 by Trane units", "how many invoices between $1,000 and $2,000 per customer", "how many invoices between $2,000 and $3,000 and over $1,000",
  "how many invoices between $2,000 and $3,000 so far", "how many invoices between $2,000 and $3,000 total", "how many invoices between $2,000 and $3,000 with tax", "how many invoices between $2,000 and $3,000 at Smith",
  "how many invoices have a subtotal between $2,000 and $3,000", "how many invoices have a balance between $100 and $500", "how many invoices from 2000 to 3000 dollars",
  "how many invoices over $2,000 and under $3,000", "how many invoices more than $2,000 but less than $3,000"]) add(org, q, mustDecline());
// F6: population parity. hvacp has 120 invoice documents but 112 financials rows: "how many invoices do we have" says 120, so no field-absence number over 112 may appear
add("hvacp", "how many invoices do we have", exact(/^You have 120 invoices/));
for (const f of ["due date", "PO number"]) for (const q of FORMS(f).slice(0, 3)) add("hvacp", q, mustDecline());
// F1: an org with invoices but none receivable-USD never gets 0 or a whole-shop number from an amount question
for (const org of ["hvacy", "hvacz"]) for (const q of ["how many invoices over $3,000", "how many invoices under $1,000", "how many invoices over $0", "how many invoices under $9,999,999", "how many invoices between $3,000 and $4,000", "how many invoices between $0 and $100,000", "how many invoices between $1 and $9,999,999", "how many invoices between $2000 and $2005", "how many invoices between 3 and 4k"]) add(org, q, mustDecline());
// F4: a misspelled manufacturer is announced only on an answer that applied the manufacturer filter; answers that ignored it are exactly the base answers, with no note
add("hvac", "how many Carier units have invoices over $3,000", { ok: (t) => t === "106 invoices are over $3,000.00. That counts every invoice on file, any date, paid or unpaid.", why: "exactly the base answer, no typo note" });
add("hvac", "how many Carier units are in Mesa and under warranty", { ok: (t) => t === "5 customers still have a warranty on file that hasn't expired and have a service address in Mesa.", why: "exactly the base answer, no typo note" });
add("hvac", "how many units made by Carier", exact(new RegExp(`^Reading "Carier" as Carrier\\. ${T.brand(H, "Carrier")} of ${hu} units are Carrier`)));
// round 6: misspellings of a REAL brand / city / surname, one to three edits away (dropped letters, a swap), generated from each organization's own rows. The truthful
// zero is only for names that are not near anything on file; a typo of a real name is answered (corrected, with the note) or declined, never "0 of N" and never the total.
const WORDS = (d) => new Set(JSON.stringify([d.entities.map((e) => e.data), d.extractions.map((x) => x.value)]).toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2));
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const typos = (w, known) => {
  const a = w.toLowerCase(), cands = [a.slice(0, 1) + a.slice(2), a.slice(0, 2) + a.slice(3), a.slice(0, 1) + a[2] + a[1] + a.slice(3), a.slice(0, 1) + a.slice(2, -2) + a.slice(-1), a.slice(0, 1) + a.slice(3), a.slice(0, 2) + a.slice(3, -1)];
  return [...new Set(cands)].filter((v) => v.length >= 3 && v !== a && !known.has(v)).slice(0, 3).map(cap);
};
for (const [org, d] of [["hvac", H], ["plumb", P]]) {
  const known = WORDS(d), tot = [T.units(d), T.customers(d), T.invoices(d)];
  const counts = (f) => { const m = new Map(); for (const x of f) if (x) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((e) => e[0]); };
  const brands = counts(live(d, "equipment").map((u) => String(u.data.manufacturer ?? "").trim())).filter((b) => /^[A-Za-z]{4,}$/.test(b)).slice(0, 3);
  const cities = counts(live(d, "customer").map((c) => cityOf(c))).filter((c) => /^[a-z]{5,}$/.test(c)).slice(0, 3);
  const surn = counts(live(d, "customer").map((c) => String(c.data.customer_name ?? "").trim().split(/\s+/).pop().toLowerCase())).filter((n) => /^[a-z]{5,}$/.test(n)).slice(0, 3);
  for (const b of brands) for (const v of typos(b, known)) add(org, `how many ${v} units`, { safe: tot });
  for (const c of cities) for (const v of typos(c, known)) add(org, `how many customers in ${v}`, { safe: tot });
  for (const n of surn) for (const v of typos(n, known).slice(0, 2)) add(org, `how many customers named ${v}`, { safe: tot });
}
add("hvac", "how many Cariar units", { safe: [hu, T.customers(H), T.invoices(H)] });
add("hvac", "how many Trn units", { safe: [hu, T.customers(H), T.invoices(H)] });
add("hvac", "how many customers in Cadler", { safe: [hu, T.customers(H), T.invoices(H)] });
add("hvac", "how many customers named Mrer", { safe: [hu, T.customers(H), T.invoices(H)] });
add("plumb", "how many Carrier units", { zeroOf: pu });
add("hvac", "how many Navien units", { zeroOf: hu });
// "at least N units": only the plain shape is answered; any other qualifier declines
const perCust = (d) => { const m = new Map(); for (const u of live(d, "equipment")) m.set(u.customer_id, (m.get(u.customer_id) ?? 0) + 1); return m; };
const atLeast = (d, n) => [...perCust(d)].filter(([c, k]) => c && k >= n).length;
for (const org of ["hvac", "plumb", "hvacb"]) {
  for (const n of [2, 3]) add(org, `how many customers have at least ${n} units`, exact(new RegExp(`^${atLeast(R[org], n)} customers? (?:have|has) at least ${n} units`)));
  add(org, "customers with 2 or more units", exact(new RegExp(`^${atLeast(R[org], 2)} customers? (?:have|has) at least 2 units`)));
  for (const q of ["how many customers have at least 2 units installed in 2020", "how many customers have at least 2 units in service", "how many customers have at least 2 units this year", "how many customers have at least 2 units at different addresses",
    "how many customers have at least 2 unit types", "how many units do customers with at least 2 units have", "how many customers in Tucson have at least 2 units", "how many customers have at least 2 Rheem units",
    "how many customers have fewer than 10000 units", "how many customers have fewer than 3 units", "how many customers have not more than 1 unit", "how many customers have at most 2 units", "how many customers have exactly 1 unit"]) add(org, q, mustDecline());
}
// a place-shaped word, a state code the records do not carry, an HVAC question to an org with no HVAC equipment: never the total, never a zero
for (const org of ["hvac", "plumb"]) for (const q of ["how many customers in bend az", "how many customers in tombstone az", "how many invoices for customers in CO", "how many units in tx", "how many customers near bend", "how many customers from tombstone"]) safe(org, q);
// a state the records do not carry: declining is right; a zero is allowed only as the honest "0 customers match that ... your customers are in AZ" and only when no address in the rows has that state
const stateOf = (c) => (String(c.data.service_address ?? "").match(/,\s*([A-Z]{2})\s+\d{5}/) ?? [])[1];
for (const org of ["hvac", "plumb"]) for (const st of ["TX", "tx", "CO", "NV", "FL", "NM"]) {
  const cnt = live(R[org], "customer").filter((c) => stateOf(c) === st.toUpperCase()).length;
  add(org, `how many customers in ${st}`, { ok: (t) => (cnt === 0 ? /^0 customers match that/.test(t) : new RegExp(`^You have ${cnt} customers?\\b`).test(t)), why: "decline, an honest zero listing where the customers are, or the exact count" });
}
add("plumb", "how many HVAC units", mustDecline());
add("big", "how many HVAC units", mustDecline());
add("hvac", "how many HVAC units", { total: hu }, false);
// typo correction is announced; brand customer counts never count a unit that has no customer
add("hvac", "how many Trnae units", exact(/^Reading "Trnae" as Trane\./));
add("hvac", "how many Carier units", exact(/^Reading "Carier" as Carrier\./));
add("uni", "how many Boshc units", { ok: (t) => /\b3 of 6 units are Bosch\b/.test(t) && !/Boshc.*I don't see/.test(t), why: "the corrected name's exact filtered count, or a decline (never the total, never a zero for the typo)" });
add("hvac", "how many customers named Carrie", { ok: (t) => !/^Reading/.test(t) && !/^You have \d+ customers?\b/.test(t), why: "no manufacturer note on a customer name" });
add("uni", "how many customers have a Rheem unit", exact(/^(?:2 customers|You have 2 customers)/), true);
// a technician / customer name nobody has: a truthful zero is allowed only when the rows really hold nothing near it
const hasName = (d, re) => JSON.stringify([d.entities.map((e) => e.data), d.extractions.map((x) => x.value)]).match(re);
add("plumb", "how many invoices did Linda Fitzgerald do", { ok: (t) => !hasName(plumbData, /Fitzgerald/i) && /^0 invoices list Linda Fitzgerald as the technician/.test(t), why: "truthful zero for a name with nothing near it" });
// reviewer reproductions that are wrong on the base too and are NOT fixed here (recorded, not graded)
for (const [org, q] of [["hvac", "Do we have any Active units"], ["plumb", "how many customers live on n oracle rd"], ["hvac", "how many units installed in 2020 or 2021"], ["hvac", "how many units installed in 2020 in Tucson"], ["hvac", "how many units in Mesa"], ["hvacb", "list invoices with no due date"]]) add(org, q, known());
add("plumb", "how many invoices over $500", exact(new RegExp(`^${nOver(plumbData, 500)} invoices? (?:is|are) over `)));
add("hvacb", "how many invoices have no total", { known: true });

// ---- grade
const nums = (t) => [...String(t).replace(/,/g, "").matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
let wrong = 0, ok = 0, declined = 0, badDecline = 0, knownN = 0; const lines = [];
for (const x of Q) {
  modelCounter.n = 0;
  const a = await askViaHandler({ handler: askHandler, auth: { tenantId: orgs[x.org].ctx.tenantKey, orgId: orgs[x.org].ctx.tenantName, userId: null }, question: x.q, today: "2026-09-25" });
  const text = String(a.data?.text ?? a.error ?? ""), e = x.expect;
  const declinedIt = modelCounter.n > 0 || !!a.data?.clarify || !nums(text).length;
  let verdict;
  const zeroStyle = /^(?:No, )?0 of \d+|\bI don't see\b|^0 customers match|^you have 0 |\bhave 0\b/i.test(text);
  if (e.known || e.mustDecline || e.ok) {
    if (e.known) verdict = "known";
    else if (declinedIt) verdict = e.mustDecline || x.okDecline ? "decline" : "BAD-DECLINE";
    else if (e.mustDecline) verdict = "WRONG";
    else verdict = e.ok(text) ? "ok" : "WRONG";
  } else if (e.match) verdict = declinedIt ? "decline" : (e.match.test(text) ? "ok" : "WRONG");
  else if (e.safe) {
    verdict = declinedIt ? "decline" : (zeroStyle ? "WRONG" : (nums(text).length && e.safe.includes(nums(text)[0]) && !/\bof \d+\b/.test(text) ? "WRONG" : "ok"));
  } else if (e.noNumberUnless !== undefined) {
    // a number is only acceptable if it states the true count for this (or 0 of M); a bare total from the whole org is the bug
    verdict = declinedIt ? "decline" : (nums(text)[0] === e.noNumberUnless ? "ok" : "WRONG");
  } else if (declinedIt) verdict = x.okDecline ? "decline" : "BAD-DECLINE";
  else if (e.zeroOf !== undefined) verdict = (new RegExp(`^(?:No, )?0 of ${e.zeroOf}\\b`).test(text) || /^0 customers match that\b/.test(text) || new RegExp(`^(?:No, )?you have 0 .*\\(of ${e.zeroOf} total\\)`, "i").test(text)) ? "ok" : "WRONG";
  else if (e.total !== undefined) verdict = nums(text).includes(e.total) ? "ok" : "WRONG";
  else verdict = new RegExp(`\\b${e.n} of ${e.of}\\b`).test(text) ? "ok" : "WRONG";
  if (verdict === "ok") ok++; else if (verdict === "known") knownN++; else if (verdict === "decline") declined++; else if (verdict === "BAD-DECLINE") badDecline++; else wrong++;
  lines.push(`${verdict.padEnd(11)} [${x.org}] ${x.q}  -> ${text.slice(0, 110)}`);
}
for (const l of lines) realLog(l);
realLog(`\n${Q.length} questions: ${ok} exact, ${declined} declined, ${knownN} known-unfixed, ${badDecline} bad declines, ${wrong} CONFIDENT WRONG`);
if (Q.length < 150) { realLog("fewer than 150 questions"); process.exit(1); }
process.exit(wrong || badDecline ? 1 : 0);
