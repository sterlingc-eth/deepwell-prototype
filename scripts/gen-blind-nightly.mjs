#!/usr/bin/env node
/**
 * Nightly fresh blind sets (R43+): seeded, oracle SQL against each tenant's own export. Written BEFORE any code change.
 *   node scripts/gen-blind-nightly.mjs [YYYY-MM-DD]   -> test-docs/scorecard/blind/{hvac,plumb,prop}-<date>.json
 * Run: TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/run-tenant-exam.mjs <export> <set> <industry> --list
 */
import fs from "node:fs";
const DATE = process.argv[2] || "2026-10-12";
let seed = [...DATE].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pickN = (a, n) => { const c = [...a]; const o = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
const typo = (s) => { const w = s.split(" "); const i = w.findIndex((x) => x.length > 5 && /^[a-z]+$/.test(x)); if (i < 0) return s; const x = w[i]; const k = 2 + Math.floor(rnd() * (x.length - 4)); w[i] = x.slice(0, k) + x[k + 1] + x[k] + x.slice(k + 2); return w.join(" "); };
const cnt = (a, f) => { const m = {}; a.forEach((x) => { const k = f(x); m[k] = (m[k] || 0) + 1; }); return m; };

function build(name, exportPath, industryTag, spec) {
  const e = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  const ents = e.entities.filter((x) => !x.merged_into);
  const cust = ents.filter((x) => x.entity_type === "customer");
  const eq = ents.filter((x) => x.entity_type === "equipment");
  const city = (c) => (c.data.service_address || "").split(", ")[1];
  const allText = JSON.stringify([cust.map((c) => c.data.customer_name), e.extractions.filter((x) => ["technician", "tenant_name", "vendor"].includes(x.field_key)).map((x) => x.value)]).toLowerCase();
  const absent = (n) => !allText.includes(n.toLowerCase());
  const qs = [];
  const Q = (shape, text, cmp, sql, params = [], cite = true, t = false) => qs.push({ id: `${name}-${String(qs.length + 1).padStart(3, "0")}`, text: t ? typo(text) : text, category: `blind-${DATE}-${industryTag}`, shape, cmp, oracle: { sql, params }, citationRequired: cite });
  const brands = Object.keys(cnt(eq, (x) => x.data.manufacturer));
  const cities = Object.keys(cnt(cust, city)).filter((c) => /^[A-Z][a-z]/.test(c) && !/Suite|Apt/.test(c));
  const EQC = (extra = "", ps = []) => ({ sql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL${extra}`, ps });
  const ghosts = ["Gerald Pemberton", "Colleen Aldridge", "Harlan Voss", "Mireya Santangelo"].filter(absent);
  const ghostBrand = spec.ghostBrands.filter((b) => !brands.includes(b));
  const ghostCity = spec.ghostCities.filter((c) => !cities.includes(c));

  // two conditions: brand + city
  for (const [b, c] of pickN(brands, 4).map((b) => [b, pick(cities)])) Q("brand_city", pick([`how many ${b} units are in ${c}`, `${b} units in ${c}, how many`, `hw many ${b}s do we have over in ${c}`]), "number", EQC(" AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2").sql, [b, `%, ${c}, %`]);
  // brand only, casual
  for (const b of pickN(brands, 3)) Q("brand_count_casual", pick([`got any ${b}s? how many`, `number of ${b} equipment`, `total ${b} count`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [b], true, true);
  // dropped-condition probes: brand / city the org does not have
  for (const b of ghostBrand.slice(0, 3)) Q("ghost_brand", pick([`how many ${b} units do we have`, `any ${b} equipment on file? how many`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [b], false);
  for (const c of ghostCity.slice(0, 2)) Q("ghost_city", pick([`how many customers do we have in ${c}`, `customers in ${c}?`]), "number", `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`%, ${c}, %`], false);
  if (ghostBrand[0] && cities[0]) { const c = pick(cities); Q("ghost_brand_city", `how many ${ghostBrand[0]} units in ${c}`, "number", EQC(" AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2").sql, [ghostBrand[0], `%, ${c}, %`], false); }
  // honest not-on-file person lookups
  for (const g of ghosts.slice(0, 3)) Q("ghost_person_phone", pick([`what's ${g}'s phone number`, `got a number for ${g}?`, `where does ${g} live`]), "honest-zero", `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND data->>'customer_name' ILIKE $1`, [g], false);
  // lookups for real customers (casual / typo)
  for (const c of pickN(cust, 4)) { const f = pick(["phone", "email", "service_address"]); const w = { phone: "phone number", email: "email address", service_address: "address" }[f]; Q(`lookup_${f}`, pick([`${c.data.customer_name} ${w}`, `pull up ${c.data.customer_name}'s ${w}`]), "value", `SELECT data->>'${f}' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, [c.data.customer_name], true, true); }
  // per-city customers (list)
  { const c = pickN(cities.filter((x) => cnt(cust, city)[x] <= 12), 1)[0]; if (c) Q("list_city_customers", pick([`who are our customers in ${c}`, `list the ${c} customers`]), "set", `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`%, ${c}, %`]); }
  // customers with the most equipment (tie-free)
  { const m = cnt(eq, (x) => x.customer_id); const top = Object.entries(m).sort((a, b) => b[1] - a[1]); if (top[0][1] > (top[1]?.[1] ?? 0)) Q("top_customer_equipment", "which customer has the most equipment", "value", `SELECT c.data->>'customer_name' AS v FROM entities c JOIN entities e ON e.customer_id=c.id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.merged_into IS NULL GROUP BY c.id, c.data->>'customer_name' ORDER BY count(*) DESC, 1 LIMIT 1`, []); }
  spec.extra({ Q, e, ents, cust, eq, brands, cities, pick, pickN, cnt, absent, city });
  const out = { version: 1, category: `blind-${DATE}-${industryTag}`, source: `scripts/gen-blind-nightly.mjs ${DATE} (seeded)`, questions: qs };
  const file = `test-docs/scorecard/blind/${name}-${DATE}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(file, qs.length);
}

const docCount = (type, extra = "", ps = []) => ({ sql: `SELECT count(*) AS n FROM documents d WHERE d.document_type='${type}'${extra}`, ps });
const FIN = (extra) => `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind='invoice'${extra}`;

build("hvac", "scripts/golden/golden-export.json", "hvac", {
  ghostBrands: ["Navien", "Kinetico", "Fujitsu", "Bosch"], ghostCities: ["Reno", "Denver", "Yuma"],
  extra: ({ Q, e, pick, pickN }) => {
    const techs = [...new Set(e.extractions.filter((x) => x.field_key === "technician").map((x) => x.value))];
    for (const t of pickN(techs, 3)) Q("tech_invoices", pick([`how many invoices did ${t.split(" ")[0]} do`, `jobs ${t} has invoiced`]), "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='technician' AND d.document_type='invoice' AND x.value ILIKE $1`, [t]);
    Q("ghost_tech", "how many invoices did Dana Pemberton do", "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='technician' AND d.document_type='invoice' AND x.value ILIKE $1`, ["Dana Pemberton"], false);
    for (const y of ["2024", "2025", "2023"]) Q("year_docs", `how many service tickets in ${y}`, "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE d.document_type='service-ticket' AND x.field_key='service_date' AND x.value LIKE $1`, [`${y}-%`]);
    Q("type_count", "how many permits do we have on file", "number", docCount("permit").sql, []);
    Q("type_count", "number of maintenance agreements", "number", docCount("maintenance-agreement").sql, []);
    for (const t of ["3 ton", "5 ton"]) Q("tonnage_count", `how many ${t} systems are there`, "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'tonnage' ILIKE $1`, [t]);
    Q("refrigerant_count", "how many units run R-410A", "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'refrigerant' ILIKE $1`, ["R-410A"]);
    Q("honest_other", "what's the SEER rating on the Trane at Linda Fitzgerald's house", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(seer|efficiency)'`, [], false);
    Q("honest_other", "what is the square footage of Linda Fitzgerald's house", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(sqft|square)'`, [], false);
  },
});

build("plumb", "test-docs/tenants/plumbing/export.json", "plumbing", {
  ghostBrands: ["Carrier", "Trane", "Lennox", "Bosch"], ghostCities: ["Phoenix", "Mesa", "Yuma"],
  extra: ({ Q, e, cust, eq, pick, pickN, cnt }) => {
    const types = Object.keys(cnt(eq, (x) => x.data.equipment_type));
    for (const t of pickN([...new Set(types.map((x) => x.replace(/ \(.*\)/, "")))], 3)) Q("type_count", pick([`how many ${t}s do we have`, `total ${t} units`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'equipment_type' ILIKE $1`, [t + "%"], true, true);
    const techs = [...new Set(e.extractions.filter((x) => x.field_key === "technician").map((x) => x.value))];
    for (const t of pickN(techs, 2)) Q("tech_invoices", `how many invoices did ${t} do`, "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='technician' AND d.document_type='invoice' AND x.value ILIKE $1`, [t]);
    Q("ghost_tech", "how many jobs has Harlan Voss done", "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='technician' AND d.document_type='invoice' AND x.value ILIKE $1`, ["Harlan Voss"], false);
    Q("unpaid_count", "how many invoices are still unpaid", "number", FIN(" AND f.status='unpaid'"), []);
    Q("unpaid_total", "how much are customers still owing us", "number", `SELECT sum(f.total::numeric) AS n FROM document_financials f WHERE f.doc_kind='invoice' AND f.status='unpaid'`, []);
    for (const y of ["2023", "2024", "2025"]) Q("year_invoices", `how many invoices went out in ${y}`, "number", FIN(" AND f.invoice_date::text LIKE $1"), [`${y}-%`]);
    Q("range_invoices", "invoices between 2023 and 2024", "number", FIN(" AND f.invoice_date::date BETWEEN '2023-01-01' AND '2024-12-31'"), []);
    Q("neg_customers", "how many customers don't have a water softener", "number", `SELECT count(*) AS n FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.customer_id=c.id AND e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'equipment_type' ILIKE 'water softener')`, []);
    Q("failed_backflow_names", "which customers failed their backflow test", "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM extractions x JOIN documents d ON d.id=x.document_id JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE x.field_key='backflow_test_result' AND x.value ILIKE 'FAILED' AND c.entity_type='customer'`, []);
    Q("type_count", "how many sewer camera reports do we have", "number", docCount("sewer-camera-report").sql, []);
    Q("type_count", "how many permits did we pull", "number", docCount("permit").sql, []);
    Q("agreement_count", "how many customers are on a maintenance plan", "number", `SELECT count(DISTINCT l.entity_id) AS n FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE d.document_type='maintenance-agreement' AND c.entity_type='customer'`, []);
    // the customer chosen must have NO recorded text mentioning the asked-about word (an honest probe, never a trick)
    const linkOf = {}; e.document_entity_links.forEach((l) => { (linkOf[l.entity_id] ||= []).push(l.document_id); });
    const eqOf = {}; eq.forEach((x) => { (eqOf[x.customer_id] ||= []).push(x.id); });
    const textOf = {}; e.extractions.forEach((x) => { (textOf[x.document_id] ||= []).push(String(x.value).toLowerCase()); });
    const clean = (c, re) => ![c.id, ...(eqOf[c.id] || [])].flatMap((id) => linkOf[id] || []).flatMap((d) => textOf[d] || []).some((v) => re.test(v));
    const cP = cust.find((c) => clean(c, /pressure|psi/)), cF = cust.filter((c) => clean(c, /flush/))[3];
    Q("honest_other", `what's the water pressure at ${cP.data.customer_name}'s house`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(pressure|psi)'`, [], false);
    Q("honest_other", `what's the pipe material at ${cP.data.customer_name}'s place`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(pipe|material)' AND field_key<>'material'`, [], false);
    Q("honest_other", `when was the last time we flushed ${cF.data.customer_name}'s heater`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(flush)'`, [], false);
  },
});

build("prop", "test-docs/tenants/property/export.json", "property", {
  ghostBrands: ["Navien", "Carrier", "Trane", "Maytag"], ghostCities: ["Phoenix", "Mesa", "Yuma"],
  extra: ({ Q, e, cust, eq, ents, pick, pickN, cnt }) => {
    const ex = e.extractions;
    const leaseDocs = e.documents.filter((d) => d.document_type === "lease-agreement").map((d) => d.id);
    const byDoc = {}; ex.forEach((x) => { (byDoc[x.document_id] ||= {})[x.field_key] = x.value; });
    const leases = leaseDocs.map((id) => byDoc[id]).filter((l) => l?.tenant_name && l.rent_amount && l.lease_start_date);
    const tnCount = cnt(leases, (l) => l.tenant_name);
    const uniq = leases.filter((l) => tnCount[l.tenant_name] === 1);
    for (const l of pickN(uniq, 3)) Q("tenant_movein", pick([`when did ${l.tenant_name} move in`, `${l.tenant_name} lease start date`]), "value", `SELECT x.value AS v FROM extractions x JOIN extractions t ON t.document_id=x.document_id AND t.field_key='tenant_name' JOIN documents d ON d.id=x.document_id WHERE x.field_key='lease_start_date' AND d.document_type='lease-agreement' AND t.value ILIKE $1`, [l.tenant_name], true, true);
    for (const l of pickN(uniq, 2)) Q("tenant_unit", `what unit is ${l.tenant_name} in`, "value", `SELECT u.value AS v FROM extractions u JOIN extractions t ON t.document_id=u.document_id AND t.field_key='tenant_name' JOIN documents d ON d.id=u.document_id WHERE u.field_key='unit_number' AND d.document_type='lease-agreement' AND t.value ILIKE $1`, [l.tenant_name]);
    for (const l of pickN(uniq, 2)) Q("tenant_deposit", `how much deposit did ${l.tenant_name} put down`, "value", `SELECT x.value AS v FROM extractions x JOIN extractions t ON t.document_id=x.document_id AND t.field_key='tenant_name' JOIN documents d ON d.id=x.document_id WHERE x.field_key='security_deposit' AND d.document_type='lease-agreement' AND t.value ILIKE $1`, [l.tenant_name]);
    for (const n of [1300, 1600]) Q("rent_over", `how many tenants pay more than $${n} a month`, "number", `SELECT count(*) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE d.document_type='lease-agreement' AND x.field_key='rent_amount' AND x.value::numeric > $1`, [n]);
    Q("rent_max", "what's the highest rent we collect", "value", `SELECT max(x.value::numeric)::text AS v FROM extractions x JOIN documents d ON d.id=x.document_id WHERE d.document_type='lease-agreement' AND x.field_key='rent_amount'`, []);
    const vendors = [...new Set(ex.filter((x) => x.field_key === "vendor").map((x) => x.value))];
    for (const v of pickN(vendors.filter((x) => !/Desert|Rivera/.test(x) || true), 3)) Q("vendor_wo_count", pick([`how many work orders did ${v} handle`, `${v} work orders count`]), "number", `SELECT count(DISTINCT x.document_id) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='vendor' AND d.document_type='work-order' AND x.value ILIKE $1`, [v]);
    Q("ghost_vendor", "how many work orders did Apex Roofing handle", "number", `SELECT count(DISTINCT x.document_id) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='vendor' AND d.document_type='work-order' AND x.value ILIKE $1`, ["Apex Roofing"], false);
    Q("ghost_tenant", "when does Harlan Voss's lease end", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key='tenant_name' AND value ILIKE $1`, ["Harlan Voss"], false);
    Q("ghost_tenant", "how much rent does Colleen Aldridge pay", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key='tenant_name' AND value ILIKE $1`, ["Colleen Aldridge"], false);
    Q("unpaid_vendor_invoices", "how many vendor bills are still unpaid", "number", FIN(" AND f.status='unpaid'"), []);
    Q("unpaid_vendor_total", "how much do we still owe vendors", "number", `SELECT sum(f.total::numeric) AS n FROM document_financials f WHERE f.doc_kind='invoice' AND f.status='unpaid'`, []);
    Q("vendor_invoice_total", "total we've paid Tucson Pest Control", "number", `SELECT sum(f.total::numeric) AS n FROM document_financials f WHERE f.doc_kind='invoice' AND f.vendor_name ILIKE $1`, ["Tucson Pest Control"]);
    Q("leases_start_year", "how many leases started in 2024", "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key='lease_start_date' AND x.value LIKE $1`, ["2024-%"]);
    Q("moveouts_year", "how many move out inspections did we do in 2025", "number", `SELECT count(DISTINCT x.document_id) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE d.document_type='move-out-inspection' AND x.field_key='service_date' AND x.value LIKE $1`, ["2025-%"]);
    const types = Object.keys(cnt(eq, (x) => x.data.equipment_type));
    for (const t of pickN(types, 2)) Q("type_count", `how many ${t}s are in our units`, "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'equipment_type' ILIKE $1`, [t]);
    const units = ents.filter((x) => x.entity_type === "property");
    const uc = cnt(units, (u) => u.data.service_address);
    const bigAddr = Object.entries(uc).sort((a, b) => b[1] - a[1])[0];
    Q("units_at_address", `how many units are at ${bigAddr[0].split(",")[0]}`, "number", `SELECT count(*) AS n FROM entities p WHERE p.entity_type='property' AND p.merged_into IS NULL AND p.data->>'service_address' ILIKE $1`, [`${bigAddr[0].split(",")[0]}%`]);
    Q("coi_all", "which vendors have insurance on file", "set", `SELECT DISTINCT t.value AS item FROM extractions x JOIN extractions t ON t.document_id=x.document_id AND t.field_key='vendor' WHERE x.field_key='coi_expires'`, []);
    Q("honest_other", "which tenants have a pet", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(pet)'`, [], false);
    Q("honest_other", "is anyone behind on rent", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(rent_paid|late_fee|delinquen|balance)'`, [], false);
    Q("honest_other", "what's the square footage of unit 1A", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(sqft|square)'`, [], false);
  },
});
