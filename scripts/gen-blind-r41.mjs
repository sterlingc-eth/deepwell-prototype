#!/usr/bin/env node
/** R41 nightly: fresh seeded blind sets for plumbing + property tenants (written BEFORE code changes). Reads the generated tenant exports. */
import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
const SEED = Number(process.env.BLIND_SEED || 41041);
let s = SEED >>> 0; const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1)); const pick = (a) => a[int(0, a.length - 1)];
const sample = (arr, n) => { const a = [...arr]; const o = []; while (a.length && o.length < n) o.push(a.splice(int(0, a.length - 1), 1)[0]); return o; };
const typo = (t) => { if (rnd() < 0.5) return t; const w = t.split(" "); const i = int(0, w.length - 1); if (w[i].length > 5) { const j = int(1, w[i].length - 3); w[i] = w[i].slice(0, j) + w[i][j + 1] + w[i][j] + w[i].slice(j + 2); } return w.join(" "); };
const load = (t) => JSON.parse(fs.readFileSync(path.join(ROOT, `test-docs/tenants/${t}/export.json`), "utf8"));
function mk(prefix, cat) { const Q = []; let n = 0; return { Q, add: (shape, text, cmp, sql, params = [], extra = {}) => Q.push({ id: `${prefix}-${String(++n).padStart(3, "0")}`, text: typo(text), category: cat, shape, cmp, oracle: { sql, params }, citationRequired: !["honest-zero"].includes(cmp) && !extra.nc, ...extra }) }; }
const CUST = `entity_type='customer' AND merged_into IS NULL`;
const EQ = `e.entity_type='equipment' AND e.merged_into IS NULL`;
const NC = { nc: true, citationRequired: false };
const ZERO = (sql = `SELECT 0 AS n`) => sql;
const out = (name, cat, Q) => { fs.writeFileSync(path.join(ROOT, `test-docs/scorecard/blind/${name}.json`), JSON.stringify({ version: `r41-${name}`, category: cat, source: `scripts/gen-blind-r41.mjs seed ${SEED} (written before r41 code changes)`, questions: Q }, null, 1)); console.log(name, Q.length); };

/* ---------------- plumbing owner ---------------- */
{
  const e = load("plumbing"); const cust = e.entities.filter((x) => x.entity_type === "customer"); const eq = e.entities.filter((x) => x.entity_type === "equipment");
  const { Q, add } = mk("plumb3", "blind-r41-plumbing");
  const eqBy = new Map(); for (const q of eq) (eqBy.get(q.customer_id) ?? eqBy.set(q.customer_id, []).get(q.customer_id)).push(q);
  const nm = (c) => c.data.customer_name; const one = cust.filter((c) => (eqBy.get(c.id) || []).length === 1);
  const byName = `SELECT %C% AS v FROM entities WHERE ${CUST} AND data->>'customer_name' ILIKE $1`;
  for (const c of sample(cust, 4)) add("phone", pick([`${nm(c)}'s cell?`, `need to call ${nm(c)}, what's the number`, `phone # ${nm(c)}`]), "value", byName.replace("%C%", "data->>'phone'"), [nm(c)]);
  for (const c of sample(cust, 3)) add("email", pick([`email for ${nm(c)}`, `what email do we have for ${nm(c)}`]), "value", byName.replace("%C%", "data->>'email'"), [nm(c)]);
  for (const c of sample(cust, 3)) add("customer_number", `what's ${nm(c)}'s customer number`, "value", byName.replace("%C%", "customer_number"), [nm(c)]);
  for (const c of sample(one, 5)) add("model", pick([`model number on ${nm(c)}'s heater`, `what model is ${nm(c)}'s unit`]), "value", `SELECT e.data->>'model' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE ${EQ} AND c.data->>'customer_name' ILIKE $1`, [nm(c)]);
  for (const c of sample(one, 4)) add("equip_type", pick([`what kind of equipment does ${nm(c)} have`, `what do we have installed at ${nm(c)}'s`]), "value", `SELECT e.data->>'equipment_type' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE ${EQ} AND c.data->>'customer_name' ILIKE $1`, [nm(c)]);
  for (const t of ["sump pump", "water softener", "backflow preventer", "water heater (tankless)"]) { const lbl = t.includes("tankless") ? "tankless water heater" : t; add("list_type", pick([`who has a ${lbl}`, `which customers have a ${lbl}`, `list customers with ${lbl}s`]), "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE ${EQ} AND e.data->>'equipment_type'=$1`, [t]); add("count_type", `how many ${lbl}s do we have`, "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'equipment_type'=$1`, [t]); }
  for (const c of sample(one.filter((c) => c.eq?.length !== 0 && eqBy.get(c.id)[0].data.equipment_type.includes("water heater")), 6)) { const isT = eqBy.get(c.id)[0].data.equipment_type.includes("tankless"); add("yesno_tankless", pick([`does ${nm(c)} have a tankless`, `is ${nm(c)}'s heater tankless`]), "yesno", `SELECT EXISTS (SELECT 1 FROM entities e JOIN entities c ON c.id=e.customer_id WHERE ${EQ} AND c.data->>'customer_name' ILIKE $1 AND e.data->>'equipment_type'='water heater (tankless)') AS v`, [nm(c)]); }
  for (const b of ["Navien", "Rinnai", "Rheem", "Bradford White", "A.O. Smith", "Watts"]) add("count_brand", pick([`how many ${b}s have we put in`, `number of ${b} units`]), "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'manufacturer' ILIKE $1`, [b]);
  /* dropped-condition / unknown-entity probes: brand, city, person the org does not have -> must say none/not on file, never the total */
  for (const b of ["York", "Goodman", "American Standard", "Delta", "Pentair", "Little Giant"]) add("unk_brand", pick([`how many ${b} units do we have`, `how many customers have a ${b}`, `any ${b} equipment on file?`]), "number", ZERO());
  for (const ci of ["Sedona", "Prescott", "Gilbert", "Kingman"]) add("unk_city", pick([`how many customers do we have in ${ci}`, `any customers in ${ci}?`]), "number", ZERO());
  for (const p of ["Lucinda Farragut", "Barnaby Strongbow", "Ximena Oyelaran", "Dashiell Kowalczyk"]) { add("unk_person_phone", `what's ${p}'s phone number`, "honest-zero", `SELECT 0 AS n`, [], NC); add("unk_person_equip", pick([`what water heater does ${p} have`, `when did we install ${p}'s unit`]), "honest-zero", `SELECT 0 AS n`, [], NC); }
  for (const t of ["Ignatius Pell", "Rosalind Tremaine"]) add("unk_tech", `how many invoices did ${t} do`, "number", ZERO());
  for (const y of [2017, 2029]) add("unk_year", `how many invoices in ${y}`, "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key='invoice_date' AND x.value LIKE '${y}-%'`);
  for (const c of sample(cust, 2)) add("honest", pick([`is ${nm(c)} behind on payments`, `what does ${nm(c)} owe us`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(balance|owed|payment_status)'`, [], NC);
  for (const c of sample(cust, 2)) add("honest", `what's the water hardness at ${nm(c)}'s house`, "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'hardness'`, [], NC);
  /* big counts (500-row cap family) */
  add("count_big", "how many service tickets do we have", "number", `SELECT count(*) AS n FROM documents WHERE document_type='service-ticket'`);
  add("count_big", "total number of invoices on file", "number", `SELECT count(*) AS n FROM documents WHERE document_type='invoice'`);
  add("count_big", "how many documents do we have in total", "number", `SELECT count(*) AS n FROM documents`);
  add("count_big", "how many customers total", "number", `SELECT count(*) AS n FROM entities WHERE ${CUST}`);
  add("count_big", "how many pieces of equipment are we tracking", "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ}`);
  add("count_big", "how many warranty registrations are on file", "number", `SELECT count(*) AS n FROM documents WHERE document_type='warranty-registration'`);
  add("count_big", "how many proposals have we sent", "number", `SELECT count(*) AS n FROM documents WHERE document_type='proposal-quote'`);
  for (const t of ["water heater", "sump pump"]) add("count_type_phr", pick([`total ${t}s installed`, `how many ${t}s do we service`]), "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'equipment_type' ILIKE $1`, [t + "%"]);
  add("honest", "how many washers do we have", "honest-zero", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'equipment_type' ILIKE '%washer%'`, [], NC);
  out("plumb-r41", "blind-r41-plumbing", Q);
}
/* ---------------- property manager ---------------- */
{
  const e = load("property"); const own = e.entities.filter((x) => x.entity_type === "customer"); const vend = e.entities.filter((x) => x.entity_type === "technician");
  const tenants = [...new Set(e.extractions.filter((x) => x.field_key === "tenant_name").map((x) => x.value))];
  const { Q, add } = mk("prop3", "blind-r41-property");
  const tx = (k) => `SELECT x.value AS v FROM extractions x JOIN extractions t ON t.document_id=x.document_id AND t.field_key='tenant_name' WHERE x.field_key='${k}' AND t.value ILIKE $1`;
  for (const t of sample(tenants, 4)) add("rent", pick([`what does ${t} pay`, `${t} rent amount?`]), "value", tx("rent_amount"), [t]);
  for (const t of sample(tenants, 3)) add("unit_of", pick([`what unit is ${t} in`, `which apartment does ${t} have`]), "value", tx("unit_number"), [t]);
  for (const t of sample(tenants, 3)) add("addr_of", `where does ${t} live`, "value", tx("service_address"), [t]);
  for (const t of sample(tenants, 3)) add("yesno_move_out", `has ${t} moved out`, "yesno", `SELECT EXISTS (SELECT 1 FROM extractions t JOIN documents d ON d.id=t.document_id WHERE t.field_key='tenant_name' AND t.value ILIKE $1 AND d.document_type='move-out-inspection') AS v`, [t]);
  for (const o of sample(own, 4)) add("owner_phone", pick([`${o.data.customer_name}'s phone?`, `how do I reach owner ${o.data.customer_name}`]), "value", `SELECT data->>'phone' AS v FROM entities WHERE ${CUST} AND data->>'customer_name' ILIKE $1`, [o.data.customer_name]);
  for (const o of sample(own, 3)) add("owner_email", `email for ${o.data.customer_name}`, "value", `SELECT data->>'email' AS v FROM entities WHERE ${CUST} AND data->>'customer_name' ILIKE $1`, [o.data.customer_name]);
  for (const v of vend) add("vendor_trade", pick([`what does ${v.data.name} do`, `what trade is ${v.data.name}`]), "value", `SELECT data->>'trade' AS v FROM entities WHERE entity_type='technician' AND merged_into IS NULL AND data->>'name' ILIKE $1`, [v.data.name]);
  for (const v of sample(vend, 4)) add("coi", pick([`is ${v.data.name}'s insurance current`, `when does ${v.data.name} insurance run out`]), "value", `SELECT x.value AS v FROM extractions x JOIN extractions t ON t.document_id=x.document_id AND t.field_key='vendor' WHERE x.field_key='coi_expires' AND t.value ILIKE $1`, [v.data.name]);
  for (const v of sample(vend, 4)) add("vendor_unpaid", pick([`how many unpaid invoices from ${v.data.name}`, `unpaid bills ${v.data.name}`]), "number", `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN extractions a ON a.document_id=d.id AND a.field_key='vendor' AND a.value ILIKE $1 JOIN extractions s ON s.document_id=d.id AND s.field_key='status' AND s.value ILIKE 'unpaid' WHERE d.document_type='invoice'`, [v.data.name]);
  for (const v of sample(vend, 3)) add("vendor_wo", `jobs done by ${v.data.name}`, "number", `SELECT count(DISTINCT x.document_id) AS n FROM extractions x JOIN documents d ON d.id=x.document_id WHERE x.field_key='vendor' AND x.value ILIKE $1 AND d.document_type='work-order'`, [v.data.name]);
  for (const t of ["hvac", "plumbing", "electrical", "appliance"]) add("vendors_trade", pick([`how many ${t} vendors do we have`, `which ${t} vendors do we use`]), t === "hvac" || rnd() < 2 ? "number" : "set", `SELECT count(*) AS n FROM entities WHERE entity_type='technician' AND merged_into IS NULL AND data->>'trade' ILIKE $1`, [t]);
  for (const y of [2026, 2027, 2028]) add("coi_year", `how many vendor insurance certs expire in ${y}`, "number", `SELECT count(*) AS n FROM extractions x WHERE x.field_key='coi_expires' AND x.value LIKE '${y}-%'`);
  for (const b of ["Whirlpool", "Samsung", "LG", "GE", "Bosch"]) add("count_brand", pick([`how many ${b} appliances`, `${b} units we manage`]), "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'manufacturer' ILIKE $1`, [b]);
  for (const t of ["refrigerator", "dishwasher", "range", "washer", "water heater"]) add("count_equip_type", `how many ${t}s are in the portfolio`, "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'equipment_type' ILIKE $1`, [t]);
  for (const o of sample(own, 4)) add("owner_units", pick([`how many doors does ${o.data.customer_name} have with us`, `how many units does ${o.data.customer_name} have with us`]), "number", `SELECT count(*) AS n FROM entities p WHERE p.entity_type='property' AND p.merged_into IS NULL AND p.data->>'customer_name' ILIKE $1`, [o.data.customer_name]);
  /* unknown-entity guards */
  for (const b of ["Frigidaire", "Haier", "Electrolux"]) add("unk_brand", pick([`how many ${b} appliances do we have`, `any ${b} in our units?`]), "number", ZERO());
  for (const v of ["Desert Gutter Pros", "Apex Locksmith", "Lone Cactus Paving"]) add("unk_vendor", pick([`how many work orders did ${v} do`, `when does ${v}'s insurance expire`]), "number", ZERO());
  for (const t of ["Winifred Achterberg", "Tobias Nakamura-Reyes", "Cordelia Finch"]) { add("unk_tenant_rent", `how much does ${t} pay in rent`, "honest-zero", `SELECT 0 AS n`, [], NC); add("unk_tenant_lease", `when does ${t}'s lease end`, "honest-zero", `SELECT 0 AS n`, [], NC); }
  for (const o of ["Leopold Strand", "Imelda Quartermain"]) add("unk_owner_units", `how many units does ${o} own`, "honest-zero", `SELECT 0 AS n`, [], NC);
  for (const ci of ["Page", "Show Low", "Payson"]) add("unk_city", `how many owners do we have in ${ci}`, "number", ZERO());
  for (const t of sample(tenants, 2)) add("honest_late", pick([`is ${t} late on rent`, `did ${t} pay this month`]), "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ '(rent_paid|late|payment)'`, [], NC);
  add("honest", "which units are vacant right now", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'vacan'`, [], NC);
  add("honest", "do any tenants have pets", "honest-zero", `SELECT count(*) AS n FROM extractions WHERE field_key ~ 'pet'`, [], NC);
  /* big counts */
  add("count_big", "how many tenants have we had", "number", `SELECT count(DISTINCT lower(value)) AS n FROM extractions WHERE field_key='tenant_name'`);
  add("count_big", "how many vendor invoices are on file", "number", `SELECT count(*) AS n FROM documents WHERE document_type='invoice'`);
  add("count_big", "how many unpaid vendor invoices", "number", `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN extractions s ON s.document_id=d.id AND s.field_key='status' AND s.value ILIKE 'unpaid' WHERE d.document_type='invoice'`);
  add("count_big", "how many appliances do we track", "number", `SELECT count(*) AS n FROM entities e WHERE ${EQ}`);
  add("count_big", "how many documents total", "number", `SELECT count(*) AS n FROM documents`);
  add("count_big", "how many completed work orders", "number", `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN extractions s ON s.document_id=d.id AND s.field_key='status' AND s.value ILIKE 'completed' WHERE d.document_type='work-order'`);
  add("count_big", "how many past due invoices", "number", `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN extractions s ON s.document_id=d.id AND s.field_key='status' AND s.value ILIKE 'unpaid' WHERE d.document_type='invoice'`);
  add("count_big", "how many open work orders", "number", `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN extractions s ON s.document_id=d.id AND s.field_key='status' AND s.value ILIKE 'open' WHERE d.document_type='work-order'`);
  add("honest", "how many washers are in the portfolio", "honest-zero", `SELECT count(*) AS n FROM entities e WHERE ${EQ} AND e.data->>'equipment_type' ILIKE '%washer%'`, [], NC);
  out("prop-r41", "blind-r41-property", Q);
}
