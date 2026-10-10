#!/usr/bin/env node
/**
 * R41n BLIND held-out sets for three tenants, written and frozen BEFORE any engine change.
 *   test-docs/scorecard/blind/hvac-2026-10-08.json   (scripts/golden/golden-export.json)
 *   test-docs/scorecard/blind/plumb-2026-10-08.json  (test-docs/tenants/plumbing/export.json)
 *   test-docs/scorecard/blind/prop-2026-10-08.json   (test-docs/tenants/property/export.json)
 * Seeded (fixed PRNG), values drawn from each tenant's own export, oracle SQL written per shape. Texts that already
 * appear in any other blind set are dropped. Per set: new shapes, >= 15 dropped-condition probes (a name the org does
 * NOT have + a second real condition; expected = honest zero / "not on file", never the shop total) and ~10 honest
 * not-on-file probes (field the data truly lacks; honest-zero guarded by a count of that field = 0).
 *   node scripts/gen-blind-r41n.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLIND = path.join(ROOT, "test-docs/scorecard/blind");
const SEED = 20261008;

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mk = (seed) => { const r = rng(seed); return { r, pick: (a) => a[Math.floor(r() * a.length)], shuffle: (a) => a.map((x) => [r(), x]).sort((x, y) => x[0] - y[0]).map((x) => x[1]) }; };

// existing texts across every other blind set (dedupe)
const EXISTING = new Set();
for (const f of fs.readdirSync(BLIND)) {
  if (/-2026-10-08\.json$/.test(f) && /^(hvac|plumb|prop)-/.test(f)) continue;
  try { for (const q of JSON.parse(fs.readFileSync(path.join(BLIND, f), "utf8")).questions ?? []) EXISTING.add(norm(q.text)); } catch {}
}
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }

const LEAD = ["", "", "", "", "hey, ", "quick one - ", "ok so ", "real quick: ", "alright, ", "sorry, one more - ", "hang on... ", "yo ", "um "];
const TAIL = ["", "", "", "", " please", " thanks", " real quick", " for me", " lol", " ?"];
function typo(p, s) { // transpose two inner letters of one lowercase word >= 6 chars (never a Capitalised name)
  if (p.r() > 0.22) return s;
  const w = s.split(" "); const idx = w.map((x, i) => (/^[a-z]{6,}$/.test(x) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return s;
  const i = p.pick(idx); const x = w[i]; const k = 1 + Math.floor(p.r() * (x.length - 3));
  w[i] = x.slice(0, k) + x[k + 1] + x[k] + x.slice(k + 2); return w.join(" ");
}
const dress = (s, p) => (p.pick(LEAD) + typo(p, s) + p.pick(TAIL)).replace(/\s+/g, " ").trim();
const poss = (n) => `${n}'s`;

function build(tenant, exportPath, outFile, prefix, cat, seed, fill) {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, exportPath), "utf8"));
  const p = mk(seed);
  const ix = indexes(g);
  const out = []; const seen = new Set();
  const counts = {};
  const add = (shape, rawText, cmp, sql, params, extra = {}, plain = false) => {
    const text = plain ? rawText : dress(rawText, p);
    const key = norm(text);
    if (EXISTING.has(key) || seen.has(key) || text.length > 300) return false;
    seen.add(key); counts[shape] = (counts[shape] || 0) + 1;
    const q = { id: `${prefix}-${String(out.length + 1).padStart(3, "0")}`, text, category: cat, shape, cmp, oracle: { sql, params } };
    if (cmp !== "honest-zero") q.citationRequired = true;
    Object.assign(q, extra);
    out.push(q); return true;
  };
  fill({ g, p, ix, add, pick: p.pick, shuffle: p.shuffle });
  const shapes = {}; for (const q of out) shapes[q.shape] = (shapes[q.shape] || 0) + 1;
  const doc = { version: "r41n-" + tenant, category: cat, source: `scripts/gen-blind-r41n.mjs (seeded ${SEED}; written before any engine change)`, questions: out };
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify(doc, null, 1) + "\n");
  console.log(outFile, out.length, JSON.stringify(shapes));
}

function indexes(g) {
  const ent = Object.fromEntries(g.entities.map((e) => [e.id, e]));
  const ex = {}; // docId -> field -> [values]
  for (const x of g.extractions) ((ex[x.document_id] ??= {})[x.field_key] ??= []).push(x.value);
  const doc = Object.fromEntries(g.documents.map((d) => [d.id, d]));
  const linksByDoc = {}; for (const l of g.document_entity_links) (linksByDoc[l.document_id] ??= []).push(l.entity_id);
  const customers = g.entities.filter((e) => e.entity_type === "customer" && !e.merged_into);
  const equipment = g.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into);
  const docsOf = {}; // customer name -> docs
  for (const d of g.documents) for (const id of linksByDoc[d.id] ?? []) { const e = ent[id]; if (e?.entity_type === "customer" && !e.merged_into) (docsOf[e.data.customer_name] ??= []).push(d); }
  const nameCount = {}; for (const c of customers) nameCount[c.data.customer_name] = (nameCount[c.data.customer_name] || 0) + 1;
  const firstCount = {}; for (const c of customers) { const f = c.data.customer_name.split(" ")[0]; firstCount[f] = (firstCount[f] || 0) + 1; }
  const uniq = customers.filter((c) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.data.customer_name) && nameCount[c.data.customer_name] === 1);
  const cityOf = (addr) => (String(addr).split(", ")[1] ?? "");
  const realCity = (c) => /^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(c) && !/^(Suite|Apt)/.test(c);
  const pagesText = g.pages.map((x) => x.text).join("\n").toLowerCase();
  const fieldKeys = new Set(g.extractions.map((x) => x.field_key));
  return { ent, ex, doc, linksByDoc, customers, equipment, docsOf, uniq, firstCount, cityOf, realCity, pagesText, fieldKeys, g };
}

// ---------------------------------------------------------------- SQL fragments (shared)
const J_CUST = `FROM documents d JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id`;
// E1 adjudication (ADJUDICATION.md 'visits = dated visits'): a VISIT is a distinct completed service date on a service-type document (same closed list as relations/timeline.js VISIT_DOC_TYPES),
// dated on or before today. Wordings that say "tickets" stay a document count; "times we've been out/to", "visits", "service calls" are visit counts.
const VISIT_TYPES_SQL = "('service-ticket','service-report','work-order','dispatch-note','inspection-report','startup-sheet','invoice')";
const VISIT_COUNT_SQL = `SELECT count(DISTINCT s.value) AS n FROM documents d JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id JOIN extractions s ON s.document_id = d.id AND s.field_key = 'service_date' WHERE d.document_type IN ${VISIT_TYPES_SQL} AND s.value <= $2 AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
const W_CUST = `c.entity_type = 'customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
const EQ_CUST = `FROM entities e JOIN entities c ON c.id = e.customer_id WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND c.merged_into IS NULL`;
const zeroQ = (add, shape, text, guardRegex) => add(shape, text, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '${guardRegex}'`, []);
function notOnFile(ctx, items) { // items: [text, guardRegex, keywordRegexForPages]
  const { ix, add } = ctx; let n = 0;
  for (const [text, key, kw] of items) {
    const hit = [...ix.fieldKeys].some((k) => new RegExp(key).test(k));
    const inPages = new RegExp(kw ?? key, "i").test(ix.pagesText);
    if (hit || inPages) { console.warn("skip not-on-file (data has it):", text); continue; }
    if (zeroQ(add, "r41_not_on_file", text, key)) n++;
  }
  return n;
}
const money = { anyNumber: true };

// ================================================================= HVAC
function hvac({ g, p, ix, add, pick, shuffle }) {
  const { uniq, ex, doc, docsOf, equipment, ent, cityOf, realCity } = ix;
  const custs = shuffle(uniq);
  const tickets = (name) => (docsOf[name] ?? []).filter((d) => d.document_type === "service-ticket");
  const dateOf = (d) => ex[d.id]?.service_date?.[0];

  // last tech out (unique latest date)
  let n = 0;
  for (const c of custs) { if (n >= 9) break; const nm = c.data.customer_name; const t = tickets(nm).filter((d) => dateOf(d) && ex[d.id].technician); if (t.length < 1) continue;
    t.sort((a, b) => dateOf(b).localeCompare(dateOf(a))); if (t[1] && dateOf(t[0]) === dateOf(t[1])) continue;
    if (add("r41_hv_last_tech", pick([`who was the last tech out at ${nm}'s`, `which tech went to ${nm}'s most recently`, `who did the latest visit for ${nm}`, `last guy we sent to ${nm}?`]), "value",
      `SELECT x.value AS v FROM extractions x JOIN extractions s ON s.document_id = x.document_id AND s.field_key = 'service_date' JOIN documents d ON d.id = x.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = 'technician' AND d.document_type = 'service-ticket' AND ${W_CUST} ORDER BY s.value DESC LIMIT 1`, [nm])) n++; }
  // ticket count per customer
  n = 0;
  for (const c of custs) { if (n >= 8) break; const nm = c.data.customer_name; if (!tickets(nm).length) continue;
    const tx = pick([`how many service tickets does ${nm} have`, `how many times have we been out to ${nm}'s`, `number of visits for ${nm}`, `count of service calls at ${nm}'s place`]); const vis = !/ticket/i.test(tx);
    if (add("r41_hv_ticket_count_cust", tx, "number",
      vis ? VISIT_COUNT_SQL : `SELECT count(DISTINCT d.id) AS n ${J_CUST} WHERE d.document_type = 'service-ticket' AND ${W_CUST}`, vis ? [nm, "@today"] : [nm])) n++; }
  // lifetime billed (invoices)
  n = 0;
  for (const c of shuffle(uniq)) { if (n >= 8) break; const nm = c.data.customer_name; if (!g.financials.some((f) => f.doc_kind === "invoice" && f.customer_name === nm)) continue;
    if (add("r41_hv_billed_total", pick([`how much have we billed ${nm} altogether`, `total invoiced to ${nm}`, `what's ${nm} been charged in total`, `all-time billing for ${nm}?`]), "number",
      `SELECT coalesce(sum(f.total::numeric), 0) AS n FROM document_financials f WHERE f.doc_kind = 'invoice' AND f.customer_name ILIKE $1`, [nm], money)) n++; }
  // quote amount / agreement cost (single doc)
  for (const [kind, shape, qs] of [["estimate", "r41_hv_quote_amount", (nm) => pick([`how much was the quote for ${nm}`, `what did we quote ${nm}`, `${nm} estimate amount?`])], ["agreement", "r41_hv_agreement_cost", (nm) => pick([`what does ${nm} pay for the maintenance agreement`, `annual cost of ${nm}'s service plan`, `how much is ${nm}'s maintenance plan a year`])]]) {
    n = 0; for (const c of shuffle(uniq)) { if (n >= 6) break; const nm = c.data.customer_name; const fs_ = g.financials.filter((f) => f.doc_kind === kind && f.customer_name === nm); if (fs_.length !== 1) continue;
      if (add(shape, qs(nm), "number", `SELECT sum(f.total::numeric) AS n FROM document_financials f WHERE f.doc_kind = '${kind}' AND f.customer_name ILIKE $1`, [nm], money)) n++; } }
  // supplier PO spend / count
  const vendors = [...new Set(g.financials.filter((f) => f.doc_kind === "po" && f.vendor_name).map((f) => f.vendor_name))];
  for (const v of vendors) {
    add("r41_hv_po_vendor_total", pick([`how much have we spent with ${v}`, `total POs to ${v}`, `what do our purchase orders with ${v} add up to`]), "number", `SELECT coalesce(sum(f.total::numeric), 0) AS n FROM document_financials f WHERE f.doc_kind = 'po' AND f.vendor_name ILIKE $1`, [v], money);
    add("r41_hv_po_vendor_count", pick([`how many POs went to ${v}`, `how many orders have we placed with ${v}`, `${v} purchase orders count`]), "number", `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind = 'po' AND f.vendor_name ILIKE $1`, [v]);
  }
  // brand x city counts and sets
  const eqCity = (e) => cityOf(ent[e.customer_id]?.data?.service_address);
  const combos = {}; for (const e of equipment) { const c = eqCity(e); if (!realCity(c)) continue; const k = e.data.manufacturer + "|" + c; combos[k] = (combos[k] || 0) + 1; }
  const ck = shuffle(Object.keys(combos));
  n = 0; for (const k of ck) { if (n >= 8) break; const [b, c] = k.split("|");
    if (add("r41_hv_brand_city_count", pick([`how many ${b} units do we have in ${c}`, `${b}s in ${c} - how many`, `count of ${b} systems out in ${c}`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [b, `%, ${c}, %`])) n++; }
  n = 0; for (const k of ck.filter((x) => combos[x] <= 4 && combos[x] >= 1).reverse()) { if (n >= 6) break; const [b, c] = k.split("|");
    if (add("r41_hv_who_brand_city", pick([`who in ${c} has a ${b}`, `which customers in ${c} are running ${b}`, `list the ${c} folks with a ${b}`]), "set", `SELECT DISTINCT c.data->>'customer_name' AS item ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [b, `%, ${c}, %`])) n++; }
  // tonnage x brand, refrigerant x city, install year x brand
  const tb = {}; for (const e of equipment) if (e.data.tonnage) { const k = e.data.tonnage + "|" + e.data.manufacturer; tb[k] = (tb[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(tb))) { if (n >= 6) break; const [t, b] = k.split("|");
    if (add("r41_hv_ton_brand_count", pick([`how many ${t} ${b}s do we have`, `${b} units that are ${t}, how many`, `count the ${t} ${b} systems`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'tonnage' = $1 AND e.data->>'manufacturer' ILIKE $2`, [t, b])) n++; }
  const rc = {}; for (const e of equipment) if (e.data.refrigerant) { const c = eqCity(e); if (!realCity(c)) continue; const k = e.data.refrigerant + "|" + c; rc[k] = (rc[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(rc))) { if (n >= 5) break; const [r, c] = k.split("|");
    if (add("r41_hv_refrig_city_count", pick([`how many ${r} systems are in ${c}`, `${c} units on ${r}, how many`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'refrigerant' = $1 AND c.data->>'service_address' ILIKE $2`, [r, `%, ${c}, %`])) n++; }
  const yb = {}; for (const e of equipment) if (e.data.installation_date) { const k = e.data.installation_date.slice(0, 4) + "|" + e.data.manufacturer; yb[k] = (yb[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(yb))) { if (n >= 6) break; const [y, b] = k.split("|");
    if (add("r41_hv_brand_install_year", pick([`how many ${b}s did we put in during ${y}`, `${b} installs in ${y}?`, `number of ${b} systems installed ${y}`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1 AND e.data->>'installation_date' LIKE $2`, [b, `${y}-%`])) n++; }
  // tech x service type x year
  const tyc = {}; for (const d of g.documents) if (d.document_type === "service-ticket") { const e = ex[d.id]; if (!e?.technician || !e.service_type || !e.service_date) continue; const k = e.technician[0] + "|" + e.service_type[0] + "|" + e.service_date[0].slice(0, 4); tyc[k] = (tyc[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(tyc))) { if (n >= 8) break; const [t, s, y] = k.split("|"); const f = t.split(" ")[0];
    const what = s === "Repair" ? pick(["repair calls", "repairs"]) : pick(["PM visits", "maintenance visits", "tune-ups"]);
    if (add("r41_hv_tech_type_year", pick([`how many ${what} did ${t} do in ${y}`, `${f}'s ${what} in ${y}`, `how many ${what} for ${f} in ${y}`]), "number",
      `SELECT count(*) AS n FROM extractions a JOIN extractions b ON b.document_id = a.document_id AND b.field_key = 'service_type' JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'service_date' WHERE a.field_key = 'technician' AND a.value ILIKE $1 AND b.value = $2 AND s.value LIKE $3`, [t, s, `${y}-%`])) n++; }
  // first-name-only lookups
  n = 0; for (const c of shuffle(custs)) { if (n >= 9) break; const [f] = c.data.customer_name.split(" "); if (ix.firstCount[f] !== 1) continue;
    const kind = n % 3; const col = ["phone", "service_address", "email"][kind]; if (!c.data[col]) continue;
    const t = [[`${f}'s phone number?`, `number for ${f}`], [`where does ${f} live`, `${f}'s address`], [`${f}'s email`, `email for ${f}`]][kind];
    if (add("r41_hv_first_name_lookup", pick(t), "value", `SELECT data->>'${col}' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, [`${f} %`])) n++; }
  // last / first service date, newest install
  n = 0; for (const c of shuffle(custs)) { if (n >= 5) break; const nm = c.data.customer_name; const t = tickets(nm).filter(dateOf); if (!t.length) continue;
    if (add("r41_hv_last_service_date", pick([`when did we last service ${nm}`, `last time we were at ${nm}'s?`, `most recent service date for ${nm}`]), "value",
      `SELECT max(s.value) AS v FROM extractions s JOIN documents d ON d.id = s.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE s.field_key = 'service_date' AND d.document_type IN ${VISIT_TYPES_SQL} AND s.value <= $2 AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`, [nm, "@today"])) n++; }
  // address -> customer
  n = 0; for (const c of shuffle(custs)) { if (n >= 5) break; const a = c.data.service_address; if (!/^\d+ [A-Z]/.test(a) || customers_at(ix, a) !== 1) continue;
    if (add("r41_hv_who_at_address", pick([`who's the customer at ${a.split(",")[0]}`, `whose place is ${a.split(",")[0]}`, `who lives at ${a.split(",")[0]}`]), "value", `SELECT data->>'customer_name' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`${a.split(",")[0]},%`])) n++; }
  // yes/no
  n = 0; for (const c of shuffle(custs)) { if (n >= 5) break; const nm = c.data.customer_name; const has = (docsOf[nm] ?? []).some((d) => d.document_type === "maintenance-agreement");
    if (add("r41_hv_yesno_agreement", pick([`does ${nm} have a service plan with us`, `is ${nm} on a maintenance agreement`, `${nm} got a maintenance contract?`]), "yesno", `SELECT EXISTS (SELECT 1 ${J_CUST} WHERE d.document_type = 'maintenance-agreement' AND ${W_CUST}) AS v`, [nm])) n++; if (has && n >= 5) break; }
  n = 0; for (const c of shuffle(custs)) { if (n >= 5) break; const nm = c.data.customer_name; const techs = [...new Set(tickets(nm).map((d) => ex[d.id]?.technician?.[0]).filter(Boolean))]; if (!techs.length) continue;
    const all = ["Danny Ochoa", "Kevin Pratt", "Marisol Vega", "Denise Ford", "Ray Sutton", "Wyatt Coburn"]; const t = pick(all); const f = t.split(" ")[0];
    if (add("r41_hv_yesno_tech_cust", pick([`has ${f} ever been out to ${nm}'s`, `did ${f} work on ${nm}'s system before`, `was ${t} ever at ${nm}'s place`]), "yesno",
      `SELECT EXISTS (SELECT 1 FROM extractions x JOIN documents d ON d.id = x.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = 'technician' AND x.value ILIKE $2 AND ${W_CUST}) AS v`, [nm, t])) n++; }
  // zip count
  const zips = {}; for (const c of ix.customers) { const z = (c.data.service_address.match(/AZ (\d{5})$/) ?? [])[1]; if (z && realCity(cityOf(c.data.service_address))) zips[z] = (zips[z] || 0) + 1; }
  n = 0; for (const z of shuffle(Object.keys(zips))) { if (n >= 4) break;
    if (add("r41_hv_zip_count", pick([`how many customers are in ${z}`, `customers with a ${z} zip`, `any customers in ${z}? how many`]), "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`% ${z}`])) n++; }
  // refrigerant of a customer's system (single unit w/ refrigerant)
  n = 0; for (const c of shuffle(custs)) { if (n >= 5) break; const eqs = equipment.filter((e) => e.customer_id === c.id); if (eqs.length !== 1 || !eqs[0].data.refrigerant) continue; const nm = c.data.customer_name;
    if (add("r41_hv_refrigerant_cust", pick([`what refrigerant is in ${nm}'s unit`, `does ${nm}'s system run R-410A or something else`, `${nm} refrigerant type?`]), "value", `${"SELECT e.data->>'refrigerant' AS v"} ${EQ_CUST} AND c.data->>'customer_name' ILIKE $1`, [nm])) n++; }

  // ---------------- dropped-condition probes (absent name + a real second condition)
  const ABS_BRANDS = ["Bryant", "Amana", "Ruud", "Fujitsu", "Payne"]; const ABS_CITIES = ["Yuma", "Flagstaff", "Prescott", "Sedona"]; const ABS_TECH = ["Terrance Bell", "Gary Lund", "Priya Raman", "Paul Hendricks"];
  const realBrands = ["Trane", "Carrier", "Goodman", "Lennox", "Rheem"]; const realCities = ["Tucson", "Mesa", "Tempe", "Chandler", "Gilbert"]; const realTechs = ["Danny Ochoa", "Kevin Pratt", "Marisol Vega"];
  for (let i = 0; i < 3; i++) add("r41_drop_brand_city", pick([`how many ${ABS_BRANDS[i]} units in ${realCities[i]}`, `${ABS_BRANDS[i]} customers in ${realCities[i + 1]}, how many`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [ABS_BRANDS[i], `%, ${realCities[i]}, %`]);
  for (let i = 0, txy; i < 3; i++) add("r41_drop_brand_year", txy = pick([`how many ${ABS_BRANDS[i + 2]}s did we install in ${2012 + i}`, `${ABS_BRANDS[i + 2]} installs ${2015 + i}?`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1 AND e.data->>'installation_date' LIKE $2`, [ABS_BRANDS[i + 2], `${txy.match(/\d{4}/)[0]}-%`]);
  for (let i = 0; i < 3; i++) add("r41_drop_city_brand", pick([`how many ${realBrands[i]} customers do we have in ${ABS_CITIES[i]}`, `${ABS_CITIES[i]} ${realBrands[i + 1]} units?`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [realBrands[i], `%, ${ABS_CITIES[i]}, %`]);
  for (let i = 0; i < 4; i++) add("r41_drop_tech_year", pick([`how many repairs did ${ABS_TECH[i]} do in ${2019 + i}`, `${ABS_TECH[i].split(" ")[0]}'s tickets in ${2019 + i}`]), "number", `SELECT count(*) AS n FROM extractions a JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'service_date' WHERE a.field_key = 'technician' AND a.value ILIKE $1 AND s.value LIKE $2`, [ABS_TECH[i], `${2019 + i}-%`]);
  const named = shuffle(uniq).slice(0, 12).map((c) => c.data.customer_name);
  for (let i = 0; i < 3; i++) add("r41_drop_tech_cust", pick([`when did ${ABS_TECH[i]} last service ${named[i]}`, `did ${ABS_TECH[i]} do ${named[i]}'s last repair`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key = 'technician' AND value ILIKE '${ABS_TECH[i]}'`, []);
  for (let i = 0; i < 3; i++) add("r41_drop_brand_cust", pick([`what tonnage is the ${ABS_BRANDS[i]} at ${named[i + 3]}'s`, `${named[i + 3]}'s ${ABS_BRANDS[i + 1]} - what model`]), "honest-zero", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.data->>'manufacturer' ILIKE '${ABS_BRANDS[i]}' OR e.data->>'manufacturer' ILIKE '${ABS_BRANDS[i + 1]}'`, []);
  add("r41_drop_vendor_year", `how much did we spend with Ferguson Supply in 2024`, "number", `SELECT coalesce(sum(f.total::numeric), 0) AS n FROM document_financials f WHERE f.doc_kind = 'po' AND f.vendor_name ILIKE 'Ferguson Supply'`, [], money);
  add("r41_drop_vendor_count", `how many POs to Johnstone Supply last year`, "number", `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind = 'po' AND f.vendor_name ILIKE 'Johnstone Supply'`, []);
  add("r41_drop_vendor_cust", `did ${named[6]} get anything from Grainger`, "honest-zero", `SELECT count(*) AS n FROM document_financials WHERE vendor_name ILIKE 'Grainger'`, []);
  add("r41_drop_tech_brand", `how many Trane jobs did Terrance do`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key = 'technician' AND value ILIKE 'Terrance%'`, []);

  // ---------------- honest not-on-file probes
  const nm0 = (i) => named[7 + (i % 5)];
  notOnFile({ ix, add }, [
    [`what brand thermostat does ${nm0(0)} have`, "thermostat"], [`how many square feet is ${nm0(1)}'s house`, "(sq_?f|square_f|sqft)", "square f|sq ?ft"],
    [`is ${nm0(2)}'s furnace gas or electric`, "(fuel|gas_type|furnace)", "furnace|natural gas"], [`what's Danny's hourly rate`, "(hourly|wage|pay_rate)", "hourly"],
    [`how does ${nm0(3)} usually pay us, cash or check`, "(payment_method|paid_by|pay_type)", "payment method|paid by|check number"], [`does ${nm0(4)} have a dog we should know about`, "(pet|dog)", "\\bdog\\b|\\bpet\\b"],
    [`what's the SEER on ${nm0(0)}'s unit`, "seer", "seer"], [`what size ductwork does ${nm0(1)} have`, "duct", "duct"], [`what's the CFM on ${nm0(2)}'s air handler`, "(cfm|airflow_rate)", "\\bcfm\\b"],
    [`when is ${nm0(3)}'s birthday`, "(birthday|dob)", "birthday"], [`how many employees do we have`, "(employee|headcount)", "employee"], [`what's our truck mileage this month`, "(mileage|odometer)", "mileage"],
  ]);
}
function customers_at(ix, a) { const s = a.split(",")[0]; return ix.customers.filter((c) => c.data.service_address.startsWith(s + ",")).length; }

// ================================================================= PLUMBING
function plumb({ g, p, ix, add, pick, shuffle }) {
  const { uniq, ex, docsOf, equipment, ent, cityOf, realCity } = ix;
  const custs = shuffle(uniq);
  const dtype = (nm, t) => (docsOf[nm] ?? []).filter((d) => d.document_type === t);
  let n = 0;
  // last tech on a service ticket
  for (const c of custs) { if (n >= 8) break; const nm = c.data.customer_name; const t = dtype(nm, "service-ticket").filter((d) => ex[d.id]?.service_date && ex[d.id].technician); if (t.length < 2) continue;
    t.sort((a, b) => ex[b.id].service_date[0].localeCompare(ex[a.id].service_date[0])); if (ex[t[0].id].service_date[0] === ex[t[1].id].service_date[0]) continue;
    if (add("r41_pl_last_tech", pick([`who was the last plumber out at ${nm}'s`, `which of our guys last went to ${nm}'s house`, `latest service call for ${nm} - who took it`]), "value",
      `SELECT x.value AS v FROM extractions x JOIN extractions s ON s.document_id = x.document_id AND s.field_key = 'service_date' JOIN documents d ON d.id = x.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = 'technician' AND d.document_type = 'service-ticket' AND ${W_CUST} ORDER BY s.value DESC LIMIT 1`, [nm])) n++; }
  n = 0; for (const c of custs) { if (n >= 8) break; const nm = c.data.customer_name; if (!dtype(nm, "service-ticket").length) continue;
    const tx = pick([`how many service calls has ${nm} had`, `how many times have we been to ${nm}'s`, `${nm} - number of tickets`]); const vis = !/ticket/i.test(tx);
    if (add("r41_pl_ticket_count_cust", tx, "number", vis ? VISIT_COUNT_SQL : `SELECT count(DISTINCT d.id) AS n ${J_CUST} WHERE d.document_type = 'service-ticket' AND ${W_CUST}`, vis ? [nm, "@today"] : [nm])) n++; }
  n = 0; for (const c of custs) { if (n >= 8) break; const nm = c.data.customer_name; if (!g.financials.some((f) => f.doc_kind === "invoice" && f.customer_name === nm)) continue;
    if (add("r41_pl_billed_total", pick([`how much have we billed ${nm} in total`, `total of all invoices for ${nm}`, `what has ${nm} paid us all time`]), "number", `SELECT coalesce(sum(f.total::numeric), 0) AS n FROM document_financials f WHERE f.doc_kind = 'invoice' AND f.customer_name ILIKE $1`, [nm], money)) n++; }
  // problem x year
  const py = {}; for (const d of g.documents) if (d.document_type === "service-ticket") { const e = ex[d.id]; if (!e?.service_type || !e.service_date) continue; const k = e.service_type[0] + "|" + e.service_date[0].slice(0, 4); py[k] = (py[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(py))) { if (n >= 8) break; const [s, y] = k.split("|");
    if (add("r41_pl_problem_year", pick([`how many "${s}" calls did we get in ${y}`, `${s} tickets in ${y}, how many`, `how many ${s} jobs in ${y}`]), "number",
      `SELECT count(*) AS n FROM extractions a JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'service_date' WHERE a.field_key = 'service_type' AND a.value = $1 AND s.value LIKE $2`, [s, `${y}-%`])) n++; }
  // problem x city (ticket -> customer address)
  const pc = {}; for (const d of g.documents) if (d.document_type === "service-ticket") { const e = ex[d.id]; for (const id of ix.linksByDoc[d.id] ?? []) { const c = ent[id]; if (c?.entity_type !== "customer" || !e?.service_type) continue; const k = e.service_type[0] + "|" + cityOf(c.data.service_address); pc[k] = (pc[k] || 0) + 1; } }
  n = 0; for (const k of shuffle(Object.keys(pc))) { if (n >= 6) break; const [s, c] = k.split("|");
    if (add("r41_pl_problem_city", pick([`how many ${s} calls came from ${c}`, `${c} - how many ${s} tickets`]), "number", `SELECT count(DISTINCT d.id) AS n ${J_CUST.replace("JOIN entities c ON c.id = l.entity_id", "JOIN entities c ON c.id = l.entity_id JOIN extractions a ON a.document_id = d.id AND a.field_key = 'service_type'")} WHERE c.entity_type = 'customer' AND d.document_type = 'service-ticket' AND a.value = $1 AND c.data->>'service_address' ILIKE $2`, [s, `%, ${c}, %`])) n++; }
  // backflow
  n = 0; for (const c of custs) { if (n >= 6) break; const nm = c.data.customer_name; const b = dtype(nm, "backflow-test-certificate"); if (b.length !== 1 || !ex[b[0].id]?.technician) continue;
    if (add("r41_pl_backflow_tester", pick([`who tested ${nm}'s backflow`, `which tester did ${nm}'s backflow certificate`, `backflow tech for ${nm}?`]), "value", `SELECT x.value AS v FROM extractions x JOIN documents d ON d.id = x.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = 'technician' AND d.document_type = 'backflow-test-certificate' AND ${W_CUST}`, [nm])) n++; }
  const by = {}; for (const d of g.documents) if (d.document_type === "backflow-test-certificate") { const e = ex[d.id]; if (!e?.service_date) continue; const y = e.service_date[0].slice(0, 4); by[y] = (by[y] || 0) + 1; }
  n = 0; for (const y of shuffle(Object.keys(by))) { if (n >= 5) break;
    if (add("r41_pl_backflow_year", pick([`how many backflow tests did we do in ${y}`, `backflow certs from ${y}?`]), "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key = 'service_date' AND x.value LIKE $1 AND EXISTS (SELECT 1 FROM documents d WHERE d.id = x.document_id AND d.document_type = 'backflow-test-certificate')`, [`${y}-%`])) n++; }
  n = 0; for (const t of shuffle(["Tom Kessler", "Priya Raman", "Marcus Bell", "Luis Herrera", "Dana Whitfield"])) { if (n >= 4) break;
    if (add("r41_pl_backflow_fail_tech", pick([`how many backflow tests did ${t.split(" ")[0]} fail`, `how many failed backflows has ${t} run`]), "number", `SELECT count(*) AS n FROM extractions a JOIN extractions b ON b.document_id = a.document_id AND b.field_key = 'backflow_test_result' WHERE a.field_key = 'technician' AND a.value ILIKE $1 AND b.value ILIKE 'fail%'`, [t])) n++; }
  // sewer camera
  const notes = ["offset joint at 22 ft", "root intrusion at 40 ft", "line clear, no defects", "belly in line near cleanout"];
  const nlabel = { "offset joint at 22 ft": ["an offset joint", "offset joints"], "root intrusion at 40 ft": ["root intrusion", "root problems"], "line clear, no defects": ["a clear line", "clean sewer lines"], "belly in line near cleanout": ["a belly in the line", "bellies near the cleanout"] };
  for (const nt of notes) { add("r41_pl_sewer_finding_count", pick([`how many sewer camera jobs found ${nlabel[nt][1]}`, `sewer scopes with ${nlabel[nt][0]} - how many`]), "number", `SELECT count(*) AS n FROM extractions WHERE field_key = 'notes' AND value = $1`, [nt]);
    add("r41_pl_sewer_finding_who", pick([`which customers had ${nlabel[nt][0]} on the camera`, `who got ${nlabel[nt][0]} on the sewer scope`]), "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM extractions x JOIN document_entity_links l ON l.document_id = x.document_id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = 'notes' AND x.value = $1 AND c.entity_type = 'customer'`, [nt]); }
  n = 0; for (const c of custs) { if (n >= 6) break; const nm = c.data.customer_name; const s = dtype(nm, "sewer-camera-report"); if (s.length !== 1 || !ex[s[0].id]?.notes) continue;
    if (add("r41_pl_sewer_finding_cust", pick([`what did the camera find in ${nm}'s sewer line`, `sewer scope result for ${nm}?`, `what was wrong with ${nm}'s sewer`]), "value", `SELECT x.value AS v FROM extractions x JOIN documents d ON d.id = x.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = 'notes' AND d.document_type = 'sewer-camera-report' AND ${W_CUST}`, [nm])) n++; }
  // warranty term & permit number per customer (single doc)
  for (const [t, f, shape, mkq] of [["warranty-registration", "warranty_term", "r41_pl_warranty_term", (nm) => pick([`how long is ${nm}'s warranty`, `what's the warranty term on ${nm}'s heater`, `${nm} warranty length?`])], ["permit", "permit_number", "r41_pl_permit_number", (nm) => pick([`permit number for ${nm}'s job`, `what permit did we pull for ${nm}`, `${nm} permit #?`])]]) {
    n = 0; for (const c of custs) { if (n >= 6) break; const nm = c.data.customer_name; const d = dtype(nm, t); if (d.length !== 1 || !ex[d[0].id]?.[f]) continue;
      if (add(shape, mkq(nm), "value", `SELECT x.value AS v FROM extractions x JOIN documents d ON d.id = x.document_id JOIN document_entity_links l ON l.document_id = d.id JOIN entities c ON c.id = l.entity_id WHERE x.field_key = '${f}' AND d.document_type = '${t}' AND ${W_CUST}`, [nm])) n++; } }
  // brand x city, type x city, gallons x brand, install year x brand
  const eqCity = (e) => cityOf(ent[e.customer_id]?.data?.service_address);
  const bc = {}; for (const e of equipment) { const k = e.data.manufacturer + "|" + eqCity(e); bc[k] = (bc[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(bc))) { if (n >= 8) break; const [b, c] = k.split("|");
    if (add("r41_pl_brand_city_count", pick([`how many ${b} units are in ${c}`, `${b}s out in ${c}, how many`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [b, `%, ${c}, %`])) n++; }
  const tc = {}; for (const e of equipment) { const k = e.data.equipment_type + "|" + eqCity(e); tc[k] = (tc[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(tc))) { if (n >= 5) break; const [t, c] = k.split("|"); if (tc[k] > 8) continue;
    if (add("r41_pl_who_type_city", pick([`who in ${c} has a ${t}`, `which ${c} customers have a ${t}`]), "set", `SELECT DISTINCT c.data->>'customer_name' AS item ${EQ_CUST} AND e.data->>'equipment_type' = $1 AND c.data->>'service_address' ILIKE $2`, [t, `%, ${c}, %`])) n++; }
  const gb = {}; for (const e of equipment) if (e.data.gallons) { const k = e.data.gallons + "|" + e.data.manufacturer; gb[k] = (gb[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(gb))) { if (n >= 5) break; const [gl, b] = k.split("|");
    if (add("r41_pl_gal_brand_count", pick([`how many ${gl} ${b} heaters do we have`, `${b} ${gl}ers - count`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'gallons' = $1 AND e.data->>'manufacturer' ILIKE $2`, [gl, b])) n++; }
  const yb = {}; for (const e of equipment) if (e.data.installation_date) { const k = e.data.equipment_type + "|" + e.data.installation_date.slice(0, 4); yb[k] = (yb[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(yb))) { if (n >= 6) break; const [t, y] = k.split("|");
    if (add("r41_pl_type_install_year", pick([`how many ${t}s did we install in ${y}`, `${t} installs ${y}?`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'equipment_type' = $1 AND e.data->>'installation_date' LIKE $2`, [t, `${y}-%`])) n++; }
  // tech x year invoices (first name only)
  const ty = {}; for (const d of g.documents) if (d.document_type === "invoice") { const e = ex[d.id]; if (!e?.technician || !e.invoice_date) continue; const k = e.technician[0] + "|" + e.invoice_date[0].slice(0, 4); ty[k] = (ty[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(ty))) { if (n >= 8) break; const [t, y] = k.split("|"); const f = t.split(" ")[0];
    if (add("r41_pl_tech_invoices_year", pick([`how many jobs did ${f} invoice in ${y}`, `${f}'s invoiced jobs ${y}`, `how many invoices went out under ${t} in ${y}`]), "number", `SELECT count(*) AS n FROM extractions a JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'invoice_date' WHERE a.field_key = 'technician' AND a.value ILIKE $1 AND s.value LIKE $2 AND EXISTS (SELECT 1 FROM documents d WHERE d.id = a.document_id AND d.document_type = 'invoice')`, [t, `${y}-%`])) n++; }
  // first-name lookups
  n = 0; for (const c of custs) { if (n >= 8) break; const [f] = c.data.customer_name.split(" "); if (ix.firstCount[f] !== 1) continue; const kind = n % 2; const col = ["phone", "service_address"][kind];
    const t = [[`${f}'s phone number?`, `what's ${f}'s number`], [`where's ${f}'s house`, `${f}'s address?`]][kind];
    if (add("r41_pl_first_name_lookup", pick(t), "value", `SELECT data->>'${col}' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, [`${f} %`])) n++; }
  // equipment count per customer, yesno
  n = 0; for (const c of custs) { if (n >= 6) break; const nm = c.data.customer_name; if (!equipment.some((e) => e.customer_id === c.id)) continue;
    if (add("r41_pl_equipment_count_cust", pick([`how many units do we have on file for ${nm}`, `how many fixtures/appliances is ${nm} tied to`, `count of equipment at ${nm}'s`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND c.data->>'customer_name' ILIKE $1`, [nm])) n++; }
  n = 0; for (const c of custs) { if (n >= 6) break; const nm = c.data.customer_name; const t = pick(["sump pump", "water softener", "backflow preventer"]);
    if (add("r41_pl_yesno_type", pick([`does ${nm} have a ${t}`, `is there a ${t} at ${nm}'s`, `${nm} got a ${t}?`]), "yesno", `SELECT EXISTS (SELECT 1 ${EQ_CUST} AND e.data->>'equipment_type' = $2 AND c.data->>'customer_name' ILIKE $1) AS v`, [nm, t])) n++; }
  n = 0; for (const c of custs) { if (n >= 4) break; const nm = c.data.customer_name; const z = (c.data.service_address.match(/AZ (\d{5})$/) ?? [])[1];
    if (add("r41_pl_zip_count", pick([`how many customers are in ${z}`, `customers in zip ${z}?`]), "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`% ${z}`])) n++; }

  // ---------------- dropped-condition probes
  const AB = ["Noritz", "Bosch", "Moen", "Eemax", "Takagi"]; const AC = ["Nogales", "Benson", "Casas Adobes", "Oracle"]; const AT = ["Carlos Mendez", "Rick Dunlap", "Sam Ortega", "Tina Marsh"];
  const RB = ["Rheem", "Navien", "A.O. Smith", "Watts", "Rinnai"]; const RC = ["Tucson", "Marana", "Vail", "Sahuarita", "Oro Valley"];
  for (let i = 0; i < 3; i++) add("r41_drop_brand_city", pick([`how many ${AB[i]} units in ${RC[i]}`, `${AB[i]}s in ${RC[i + 1]}, how many`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [AB[i], `%, ${RC[i]}, %`]);
  for (let i = 0, txy; i < 3; i++) add("r41_drop_brand_year", txy = pick([`how many ${AB[i + 2]} heaters did we install in ${2018 + i}`, `${AB[i + 2]} installs ${2020 + i}?`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1 AND e.data->>'installation_date' LIKE $2`, [AB[i + 2], `${txy.match(/\d{4}/)[0]}-%`]);
  for (let i = 0; i < 4; i++) add("r41_drop_city_brand", pick([`how many ${RB[i]} water heaters do we have in ${AC[i]}`, `${AC[i]} customers with a ${RB[i + 1]}`]), "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE $2`, [RB[i], `%, ${AC[i]}, %`]);
  for (let i = 0; i < 4; i++) add("r41_drop_tech_year", pick([`how many jobs did ${AT[i]} invoice in ${2021 + i}`, `${AT[i].split(" ")[0]}'s tickets in ${2021 + i}`]), "number", `SELECT count(*) AS n FROM extractions a JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'service_date' WHERE a.field_key = 'technician' AND a.value ILIKE $1 AND s.value LIKE $2`, [AT[i], `${2021 + i}-%`]);
  const named = shuffle(uniq).slice(0, 14).map((c) => c.data.customer_name);
  for (let i = 0; i < 3; i++) add("r41_drop_tech_cust", pick([`when did ${AT[i]} last go to ${named[i]}'s`, `did ${AT[i]} do ${named[i]}'s last repair`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key = 'technician' AND value ILIKE '${AT[i]}'`, []);
  for (let i = 0; i < 3; i++) add("r41_drop_brand_cust", pick([`what size is the ${AB[i]} at ${named[i + 3]}'s`, `${named[i + 3]}'s ${AB[i]} - what model`]), "honest-zero", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.data->>'manufacturer' ILIKE '${AB[i]}'`, []);
  add("r41_drop_type", `how many boiler installs in Tucson`, "number", `SELECT count(*) AS n ${EQ_CUST} AND e.data->>'equipment_type' ILIKE '%boiler%' AND c.data->>'service_address' ILIKE '%, Tucson, %'`, []);
  add("r41_drop_type", `who in Marana has a grease trap`, "honest-zero", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.data->>'equipment_type' ILIKE '%grease%'`, []);

  // ---------------- honest not-on-file
  notOnFile({ ix, add }, [
    [`how hard is the water at ${named[7]}'s`, "(hardness|grains)", "hardness|grains per"], [`where's the main shutoff at ${named[8]}'s house`, "(shutoff|shut_off)", "shut-?off"], [`how many bathrooms does ${named[9]} have`, "(bath|bedroom)", "bathroom|bedroom"],
    [`how many square feet is ${named[10]}'s home`, "(sq_?f|square_f|sqft)", "square f|sq ?ft"], [`what's ${named[11]}'s insurance carrier`, "(insurance|carrier)", "insurance"], [`what's Tom's cell number`, "(tech.*phone|cell)", "cell"],
    [`how old is the piping at ${named[12]}'s`, "(pipe_age|pipe_material|piping)", "pipe material|piping"], [`what's our hourly rate`, "(hourly|labor_rate|rate)", "hourly|per hour"], [`does ${named[13]} have a dog`, "(pet|dog)", "\\bdog\\b|\\bpet\\b"],
    [`what's the video link for ${named[7]}'s camera inspection`, "(video|footage|url)", "video|footage|http"], [`what's the PSI at ${named[8]}'s house`, "(psi|pressure_reading)", "\\bpsi\\b"], [`how many trucks do we have`, "(truck|vehicle|fleet)", "truck|vehicle"],
  ]);
}

// ================================================================= PROPERTY
function prop({ g, p, ix, add, pick, shuffle }) {
  const { ex, doc, ent, cityOf } = ix;
  const leases = g.documents.filter((d) => d.document_type === "lease-agreement").map((d) => ({ d, e: ex[d.id] ?? {} }));
  const wos = g.documents.filter((d) => d.document_type === "work-order").map((d) => ({ d, e: ex[d.id] ?? {} }));
  const owners = ix.customers.filter((c) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.data.customer_name));
  const units = g.entities.filter((e) => e.entity_type === "property" && !e.merged_into);
  const byTenant = {}; for (const l of leases) if (l.e.tenant_name) (byTenant[l.e.tenant_name[0]] ??= []).push(l);
  const singleTenants = shuffle(Object.keys(byTenant).filter((t) => byTenant[t].length === 1 && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(t)));
  const J_LEASE = `FROM extractions x JOIN extractions t ON t.document_id = x.document_id AND t.field_key = 'tenant_name' JOIN documents d ON d.id = x.document_id`;
  let n = 0;
  // tenant -> unit, owner, address
  for (const [col, shape, qs] of [["unit_number", "r41_pr_tenant_unit", (t) => pick([`which unit is ${t} in`, `what unit does ${t} rent`, `${t} - unit number?`])], ["customer_name", "r41_pr_tenant_owner", (t) => pick([`who owns the place ${t} is renting`, `which owner is ${t}'s landlord`, `who's the owner on ${t}'s lease`])], ["service_address", "r41_pr_tenant_property", (t) => pick([`what building is ${t} in`, `what's the address where ${t} lives`, `where does ${t} rent`])]]) {
    n = 0; for (const t of singleTenants) { if (n >= 6) break; if (!byTenant[t][0].e[col]) continue;
      if (add(shape, qs(t), "value", `SELECT x.value AS v ${J_LEASE} WHERE x.field_key = '${col}' AND d.document_type = 'lease-agreement' AND t.value ILIKE $1`, [t])) n++; } }
  // move-in inspection condition
  n = 0; for (const t of singleTenants) { if (n >= 5) break; const mi = g.documents.filter((d) => d.document_type === "move-in-inspection" && (ex[d.id]?.tenant_name ?? [])[0] === t);
    if (mi.length !== 1) continue; /* condition is text-only: value from page is not an extraction; use existence of the inspection */
    if (add("r41_pr_yesno_movein", pick([`did we do a move-in inspection for ${t}`, `is there a move in walkthrough on file for ${t}`, `${t} move-in inspection done?`]), "yesno", `SELECT EXISTS (SELECT 1 ${J_LEASE} WHERE d.document_type = 'move-in-inspection' AND t.field_key = 'tenant_name' AND t.value ILIKE $1 AND x.field_key = 'tenant_name') AS v`, [t])) n++; }
  // vendor x year work-order counts, vendor x work type
  const vy = {}; for (const w of wos) { if (!w.e.vendor || !w.e.service_date) continue; const k = w.e.vendor[0] + "|" + w.e.service_date[0].slice(0, 4); vy[k] = (vy[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(vy))) { if (n >= 9) break; const [v, y] = k.split("|");
    if (add("r41_pr_vendor_year_wo", pick([`how many jobs did ${v} do for us in ${y}`, `${v} work orders in ${y}?`, `how many times did we use ${v} in ${y}`]), "number", `SELECT count(DISTINCT v.document_id) AS n FROM extractions v JOIN extractions s ON s.document_id = v.document_id AND s.field_key = 'service_date' JOIN documents d ON d.id = v.document_id WHERE v.field_key = 'vendor' AND d.document_type = 'work-order' AND v.value ILIKE $1 AND s.value LIKE $2`, [v, `${y}-%`])) n++; }
  const vw = {}; for (const w of wos) { if (!w.e.vendor || !w.e.work_performed) continue; const k = w.e.vendor[0] + "|" + w.e.work_performed[0]; vw[k] = (vw[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(vw))) { if (n >= 6) break; const [v, w] = k.split("|");
    if (add("r41_pr_vendor_worktype", pick([`how many times has ${v} done "${w}"`, `count of "${w}" jobs by ${v}`]), "number", `SELECT count(DISTINCT v.document_id) AS n FROM extractions v JOIN extractions w ON w.document_id = v.document_id AND w.field_key = 'work_performed' JOIN documents d ON d.id = v.document_id WHERE v.field_key = 'vendor' AND d.document_type = 'work-order' AND v.value ILIKE $1 AND w.value = $2`, [v, w])) n++; }
  // work type x year
  const wy = {}; for (const w of wos) { if (!w.e.work_performed || !w.e.service_date) continue; const k = w.e.work_performed[0] + "|" + w.e.service_date[0].slice(0, 4); wy[k] = (wy[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(wy))) { if (n >= 6) break; const [w, y] = k.split("|");
    if (add("r41_pr_worktype_year", pick([`how many work orders for "${w}" in ${y}`, `"${w}" jobs in ${y}, how many`]), "number", `SELECT count(*) AS n FROM extractions a JOIN extractions s ON s.document_id = a.document_id AND s.field_key = 'service_date' JOIN documents d ON d.id = a.document_id WHERE a.field_key = 'work_performed' AND d.document_type = 'work-order' AND a.value = $1 AND s.value LIKE $2`, [w, `${y}-%`])) n++; }
  // vendor invoice spend (money) and biggest invoice
  const vendors = [...new Set(g.financials.map((f) => f.vendor_name).filter(Boolean))];
  for (const v of shuffle(vendors).slice(0, 6)) {
    add("r41_pr_vendor_spend", pick([`how much have we paid ${v} in total`, `total billed by ${v}`, `what do ${v}'s invoices add up to`]), "number", `SELECT coalesce(sum(f.total::numeric), 0) AS n FROM document_financials f WHERE f.vendor_name ILIKE $1`, [v], money);
  }
  for (const v of shuffle(vendors).slice(0, 4)) add("r41_pr_vendor_biggest", pick([`biggest invoice from ${v}`, `what's the most ${v} ever charged us on one invoice`]), "number", `SELECT max(f.total::numeric) AS n FROM document_financials f WHERE f.vendor_name ILIKE $1`, [v], money);
  // invoices over threshold, cost of cheapest
  for (const th of [500, 750, 1000]) add("r41_pr_invoices_over", pick([`how many vendor invoices are over $${th}`, `invoices above $${th}, how many`]), "number", `SELECT count(*) AS n FROM document_financials f WHERE f.total::numeric > ${th}`, []);
  // rent thresholds & month
  for (const th of [1500, 1800, 2000]) add("r41_pr_rent_over", pick([`how many leases have rent over $${th}`, `leases renting above $${th}?`]), "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key = 'rent_amount' AND x.value::numeric > ${th}`, []);
  const months = {}; for (const l of leases) if (l.e.lease_end_date) { const k = l.e.lease_end_date[0].slice(0, 7); months[k] = (months[k] || 0) + 1; }
  n = 0; for (const k of shuffle(Object.keys(months).filter((x) => x >= "2026-10"))) { if (n >= 5) break; const [y, m] = k.split("-"); const mn = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][+m - 1];
    if (add("r41_pr_leases_end_month", pick([`how many leases end in ${mn} ${y}`, `leases expiring ${mn} ${y}?`]), "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key = 'lease_end_date' AND x.value LIKE $1`, [`${k}-%`])) n++; }
  // owner stats: work orders at owner's address, units, rent roll
  n = 0; for (const o of shuffle(owners)) { if (n >= 6) break; const nm = o.data.customer_name; if (ix.customers.filter((c) => c.data.customer_name === nm).length !== 1) continue;
    if (add("r41_pr_owner_wo_count", pick([`how many work orders on ${nm}'s properties`, `work orders for ${nm}'s buildings?`, `how many repair jobs have we done for ${nm}`]), "number", `SELECT count(DISTINCT d.id) ${J_CUST} WHERE d.document_type = 'work-order' AND ${W_CUST}`.replace("count(DISTINCT d.id)", "count(DISTINCT d.id) AS n"), [nm])) n++; }
  n = 0; for (const o of shuffle(owners)) { if (n >= 5) break; const nm = o.data.customer_name; const f = nm.split(" ")[0]; if (ix.firstCount[f] !== 1) continue; const col = n % 2 ? "phone" : "email"; if (!o.data[col]) continue;
    if (add("r41_pr_owner_first_name", pick([`${f}'s ${col === "phone" ? "phone number" : "email"}?`, `${col === "phone" ? "number" : "email"} for owner ${f}`]), "value", `SELECT data->>'${col}' AS v FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, [`${f} %`])) n++; }
  // units by city / appliances in unit
  const uc = {}; for (const u of units) { const c = cityOf(u.data.service_address); uc[c] = (uc[c] || 0) + 1; }
  for (const c of Object.keys(uc)) add("r41_pr_units_city", pick([`how many units do we have in ${c}`, `${c} doors - how many`]), "number", `SELECT count(*) AS n FROM entities WHERE entity_type = 'property' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`%, ${c}, %`]);
  const unitAppl = []; for (const u of units) { const es = ix.equipment.filter((e) => e.data.unit_number === u.data.unit_number && e.data.service_address === u.data.service_address); for (const t of ["refrigerator", "range", "dishwasher", "water heater"]) { const m = es.filter((e) => e.data.equipment_type === t); if (m.length === 1 && customers_at_prop(units, u) === 1) unitAppl.push([u, t, m[0]]); } }
  n = 0; for (const [u, t, e] of shuffle(unitAppl)) { if (n >= 8) break; const a = u.data.service_address.split(",")[0]; const col = n % 2 ? "manufacturer" : "installation_date";
    const what = col === "manufacturer" ? pick([`what brand is the ${t} in unit ${u.data.unit_number} at ${a}`, `unit ${u.data.unit_number} ${a} ${t} make?`]) : pick([`when was the ${t} in unit ${u.data.unit_number} at ${a} installed`, `${t} install date, ${a} #${u.data.unit_number}`]);
    if (add("r41_pr_unit_appliance", what, "value", `SELECT e.data->>'${col}' AS v FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'equipment_type' = $1 AND e.data->>'unit_number' ILIKE $2 AND e.data->>'service_address' ILIKE $3`, [t, u.data.unit_number, `${a},%`])) n++; }
  // last vendor in unit (unique)
  const wByUnit = {}; for (const w of wos) { if (!w.e.unit_number || !w.e.service_address || !w.e.service_date || !w.e.vendor) continue; const k = w.e.service_address[0] + "|" + w.e.unit_number[0]; (wByUnit[k] ??= []).push(w); }
  n = 0; for (const k of shuffle(Object.keys(wByUnit))) { if (n >= 6) break; const ws = wByUnit[k].sort((a, b) => b.e.service_date[0].localeCompare(a.e.service_date[0])); if (ws.length < 2 || ws[0].e.service_date[0] === ws[1].e.service_date[0]) continue; const [a, un] = k.split("|");
    if (add("r41_pr_last_vendor_unit", pick([`who was the last vendor in unit ${un} at ${a.split(",")[0]}`, `last contractor at ${a.split(",")[0]} unit ${un}?`]), "value", `SELECT v.value AS v FROM extractions v JOIN extractions s ON s.document_id = v.document_id AND s.field_key = 'service_date' JOIN extractions u ON u.document_id = v.document_id AND u.field_key = 'unit_number' JOIN extractions a ON a.document_id = v.document_id AND a.field_key = 'service_address' JOIN documents d ON d.id = v.document_id WHERE v.field_key = 'vendor' AND d.document_type = 'work-order' AND u.value ILIKE $1 AND a.value ILIKE $2 ORDER BY s.value DESC LIMIT 1`, [un, `${a.split(",")[0]},%`])) n++; }
  n = 0; for (const k of shuffle(Object.keys(wByUnit))) { if (n >= 4) break; const [a, un] = k.split("|"); const cnt = wByUnit[k].length;
    if (add("r41_pr_unit_wo_count", pick([`how many work orders on unit ${un} at ${a.split(",")[0]}`, `repairs in ${a.split(",")[0]} #${un}, how many`]), "number", `SELECT count(*) AS n FROM extractions u JOIN extractions a ON a.document_id = u.document_id AND a.field_key = 'service_address' JOIN documents d ON d.id = u.document_id WHERE u.field_key = 'unit_number' AND d.document_type = 'work-order' AND u.value ILIKE $1 AND a.value ILIKE $2`, [un, `${a.split(",")[0]},%`])) n++; void cnt; }
  // which vendors worked a building (set)
  const wByAddr = {}; for (const w of wos) if (w.e.service_address && w.e.vendor) (wByAddr[w.e.service_address[0]] ??= new Set()).add(w.e.vendor[0]);
  n = 0; for (const a of shuffle(Object.keys(wByAddr))) { if (n >= 4) break; if (wByAddr[a].size > 8 || wByAddr[a].size < 2) continue;
    if (add("r41_pr_vendors_at_building", pick([`which vendors have worked on ${a.split(",")[0]}`, `who's done work at ${a.split(",")[0]}?`]), "set", `SELECT DISTINCT v.value AS item FROM extractions v JOIN extractions a ON a.document_id = v.document_id AND a.field_key = 'service_address' JOIN documents d ON d.id = v.document_id WHERE v.field_key = 'vendor' AND d.document_type = 'work-order' AND a.value ILIKE $1`, [`${a.split(",")[0]},%`])) n++; }
  // tenants per building (distinct)
  const tAt = {}; for (const l of leases) if (l.e.service_address && l.e.tenant_name) (tAt[l.e.service_address[0]] ??= new Set()).add(l.e.tenant_name[0]);
  n = 0; for (const a of shuffle(Object.keys(tAt))) { if (n >= 4) break; if (tAt[a].size > 12) continue;
    if (add("r41_pr_tenants_at_building", pick([`how many different tenants have rented at ${a.split(",")[0]}`, `tenants at ${a.split(",")[0]} over the years, how many`]), "number", `SELECT count(DISTINCT t.value) AS n FROM extractions t JOIN extractions a ON a.document_id = t.document_id AND a.field_key = 'service_address' JOIN documents d ON d.id = t.document_id WHERE t.field_key = 'tenant_name' AND d.document_type = 'lease-agreement' AND a.value ILIKE $1`, [`${a.split(",")[0]},%`])) n++; }
  // vendor yesno at unit; invoice number lookups
  n = 0; for (const k of shuffle(Object.keys(wByUnit))) { if (n >= 4) break; const [a, un] = k.split("|"); const v = pick(["Desert Air Mechanical", "Rivera Plumbing", "Fresh Start Cleaning", "Tucson Pest Control"]);
    if (add("r41_pr_yesno_vendor_unit", pick([`has ${v} ever worked on unit ${un} at ${a.split(",")[0]}`, `did ${v} go to ${a.split(",")[0]} #${un} before`]), "yesno", `SELECT EXISTS (SELECT 1 FROM extractions v JOIN extractions u ON u.document_id = v.document_id AND u.field_key = 'unit_number' JOIN extractions a ON a.document_id = v.document_id AND a.field_key = 'service_address' JOIN documents d ON d.id = v.document_id WHERE v.field_key = 'vendor' AND d.document_type = 'work-order' AND v.value ILIKE $1 AND u.value ILIKE $2 AND a.value ILIKE $3) AS v`, [v, un, `${a.split(",")[0]},%`])) n++; }
  n = 0; for (const f of shuffle(g.financials.filter((f) => f.invoice_number && f.vendor_name))) { if (n >= 6) break; const kind = n % 2;
    if (add("r41_pr_invoice_lookup", kind ? pick([`how much was ${f.invoice_number}`, `amount on invoice ${f.invoice_number}?`]) : pick([`which vendor sent ${f.invoice_number}`, `who billed us on ${f.invoice_number}`]), kind ? "number" : "value",
      kind ? `SELECT f.total::numeric AS n FROM document_financials f WHERE f.invoice_number = $1` : `SELECT f.vendor_name AS v FROM document_financials f WHERE f.invoice_number = $1`, [f.invoice_number], kind ? money : {})) n++; }
  // tenants' rent min/max
  add("r41_pr_rent_max", `what's the highest rent we have on a lease`, "number", `SELECT max(x.value::numeric) AS n FROM extractions x WHERE x.field_key = 'rent_amount'`, [], money);
  add("r41_pr_rent_min", `lowest monthly rent across all leases?`, "number", `SELECT min(x.value::numeric) AS n FROM extractions x WHERE x.field_key = 'rent_amount'`, [], money);

  // ---------------- dropped-condition probes
  const AV = ["Ace Roofing", "Southwest Gas Plumbers", "Pima Pool Service", "AllStar Locksmith", "Sonoran Garage Doors"]; const RV = ["Desert Air Mechanical", "Rivera Plumbing", "Tucson Pest Control", "Fresh Start Cleaning", "Handy Hands Maintenance"];
  const AC = ["Nogales", "Green Valley", "Vail", "Casas Adobes"]; const AB = ["Maytag", "Kenmore", "Electrolux", "Hotpoint"]; const RB = ["Whirlpool", "GE", "Bosch", "LG", "Samsung"];
  for (let i = 0; i < 4; i++) add("r41_drop_vendor_year", pick([`how many jobs did ${AV[i]} do in ${2023 + (i % 3)}`, `${AV[i]} work orders ${2022 + i}?`]), "number", `SELECT count(*) AS n FROM extractions WHERE field_key = 'vendor' AND value ILIKE $1`, [AV[i]]);
  for (let i = 0; i < 3; i++) add("r41_drop_vendor_spend", pick([`how much have we paid ${AV[i + 1]} for ${["plumbing", "AC", "cleaning"][i]}`, `total invoices from ${AV[i + 1]}`]), "number", `SELECT coalesce(sum(f.total::numeric), 0) AS n FROM document_financials f WHERE f.vendor_name ILIKE $1`, [AV[i + 1]], money);
  for (let i = 0; i < 3; i++) add("r41_drop_city_owner", pick([`how many owners do we have in ${AC[i]}`, `how many units do we manage in ${AC[i]}`]), "number", `SELECT count(*) AS n FROM entities WHERE entity_type IN ('customer','property') AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, [`%, ${AC[i]}, %`]);
  for (let i = 0; i < 4; i++) add("r41_drop_brand_appliance", pick([`how many ${AB[i]} ${["fridges", "ranges", "dishwashers", "water heaters"][i]} do we have`, `${AB[i]} units in our buildings - how many`]), "number", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1`, [AB[i]]);
  const named = shuffle(owners).slice(0, 10).map((c) => c.data.customer_name); const addrs = shuffle(units).slice(0, 8);
  for (let i = 0; i < 3; i++) { const u = addrs[i]; const a = u.data.service_address.split(",")[0]; add("r41_drop_unit_building", pick([`who lives in unit 9${"ZYX"[i]} at ${a}`, `what's the rent on unit 9${"ZYX"[i]} at ${a}`]), "honest-zero", `SELECT count(*) AS n FROM entities WHERE entity_type = 'property' AND data->>'unit_number' = '9${"ZYX"[i]}'`, []); }
  for (let i = 0; i < 3; i++) add("r41_drop_vendor_unit", pick([`when did ${AV[i]} last work on ${named[i]}'s building`, `did ${AV[i + 1]} fix anything for ${named[i + 3]}`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key = 'vendor' AND (value ILIKE '${AV[i]}' OR value ILIKE '${AV[i + 1]}')`, []);
  for (let i = 0; i < 2; i++) add("r41_drop_brand_unit", pick([`what year is the ${AB[i]} fridge in unit ${addrs[i + 3].data.unit_number} at ${addrs[i + 3].data.service_address.split(",")[0]}`, `${AB[i + 2]} range in unit ${addrs[i + 3].data.unit_number} at ${addrs[i + 3].data.service_address.split(",")[0]} - install date`]), "honest-zero", `SELECT count(*) AS n FROM entities e WHERE e.entity_type = 'equipment' AND (e.data->>'manufacturer' ILIKE '${AB[i]}' OR e.data->>'manufacturer' ILIKE '${AB[i + 2]}')`, []);
  add("r41_drop_tenant", `what's Zelda Quimby's rent`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key = 'tenant_name' AND value ILIKE 'Zelda Quimby'`, []);
  add("r41_drop_tenant", `when does Mortimer Gaines' lease end at ${addrs[5].data.service_address.split(",")[0]}`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key = 'tenant_name' AND value ILIKE 'Mortimer Gaines'`, []);

  // ---------------- honest not-on-file
  notOnFile({ ix, add }, [
    [`does ${singleTenants[0]} have a parking spot`, "(parking|garage_space)", "parking"], [`what's ${singleTenants[1]}'s phone number`, "(tenant.*phone|tenant.*email)", "tenant phone|tenant email"], [`what's ${singleTenants[2]}'s credit score`, "(credit|score)", "credit score"],
    [`how many people live in unit ${units[3].data.unit_number} at ${units[3].data.service_address.split(",")[0]}`, "(occupant|resident_count)", "occupants"], [`is ${singleTenants[3]} a smoker`, "(smok)", "smok"], [`what are the HOA fees on ${named[0]}'s building`, "(hoa|assoc)", "\\bhoa\\b"],
    [`what's the property tax on ${named[1]}'s building`, "(property_tax|tax)", "property tax"], [`does ${singleTenants[4]} have a renewal option`, "(renewal|option)", "renewal"], [`what's the mortgage on ${named[2]}'s property`, "(mortgage|loan)", "mortgage"],
    [`what's the square footage of unit ${units[4].data.unit_number} at ${units[4].data.service_address.split(",")[0]}`, "(sq_?f|square_f|sqft)", "square f|sq ?ft"], [`how many bedrooms is unit ${units[5].data.unit_number} at ${units[5].data.service_address.split(",")[0]}`, "(bed|bath)", "bedroom"], [`what's our occupancy percentage`, "(occupan|vacan)", "occupancy"],
  ]);
}
function customers_at_prop(units, u) { return units.filter((x) => x.data.unit_number === u.data.unit_number && x.data.service_address === u.data.service_address).length; }

build("hvac", "scripts/golden/golden-export.json", "test-docs/scorecard/blind/hvac-2026-10-08.json", "hv41", "blind-r41n-hvac", SEED + 1, hvac);
build("plumb", "test-docs/tenants/plumbing/export.json", "test-docs/scorecard/blind/plumb-2026-10-08.json", "pl41", "blind-r41n-plumb", SEED + 2, plumb);
build("prop", "test-docs/tenants/property/export.json", "test-docs/scorecard/blind/prop-2026-10-08.json", "pr41", "blind-r41n-prop", SEED + 3, prop);
