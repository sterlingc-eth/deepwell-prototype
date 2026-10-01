#!/usr/bin/env node
/**
 * R35 learning-loop BLIND sets — each family written and frozen BEFORE its rule was implemented (loops 1-4 of R35).
 * Same conventions as gen-blind-r35.mjs / gen-blind-r32b.mjs: seeded, oracle SQL against the golden tenant, graded with the
 * production comparators (`scripts/run-exam-subset.mjs --no-base --blind <file>`, and scripts/verify-r35-donovan.mjs section 4).
 *   warr2   loop 1: warranty wording the R35 rule did not cover yet ("covered", "warrantied", "expiring soon", "no warranty on file")
 *   docnum  loop 2: document-number lookups (invoice / work order / PO / permit numbers), on file and not on file (r34 G5 family)
 *   advice  loop 3: advice / opinion / prediction / false-premise / unknown-person questions (r34 G3 / G4 / G5 families): honest-zero
 *   serial2 loop 4: partial serials (>= 5 characters, unique) and ambiguous partials (never one picked)
 *   short   loop 5: texting shorthand ("4" = for, "@" = at, ph#, addy, wrnty, s/n 4 ...)
 *   node scripts/gen-blind-r35b.mjs [family ...]   (default: all)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const g = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mk = (seed) => { const r = rng(seed); return { r, pick: (a) => a[Math.floor(r() * a.length)], shuffle: (a) => a.map((x) => [r(), x]).sort((x, y) => x[0] - y[0]).map((x) => x[1]) }; };
const customers = g.entities.filter((e) => e.entity_type === "customer" && !e.merged_into).map((e) => ({ id: e.id, ...e.data }));
const equipment = g.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into);
const person = customers.filter((c) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.customer_name));
const LEAD = ["", "", "", "", "hey, ", "quick one - ", "ok so ", "real quick: ", "alright, ", "sorry, one more - ", "hang on... "];
const TAIL = ["", "", "", "", " please", " thanks", " real quick", " for me"];
const dress = (s, p) => (p.pick(LEAD) + s + p.pick(TAIL)).replace(/\s+/g, " ").trim();
const ID = (fam, n) => `bl-r35b-${fam}-${String(n).padStart(3, "0")}`;
const TODAY = "@today";
const FAMILIES = {};
const zero = (out, fam, text, shape, p) => out.push({ id: ID(fam, out.length + 1), text: dress(text, p), category: `blind-r35b-${fam}`, shape, cmp: "honest-zero", oracle: { sql: "SELECT 0 AS n", params: [] } });

/* ------------------------------------------------------------------ loop 1: warranty wording */
FAMILIES.warr2 = () => {
  const p = mk(3511); const out = []; const fam = "warr2";
  const DATED = `data#>>'{warranty,expires}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`;
  const COUNT = (cond, brand = false) => `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL ${brand ? "AND lower(data->>'manufacturer') = lower($2)" : ""} AND ${cond}`;
  const NOT_EXPIRED = `${DATED} AND substr(data#>>'{warranty,expires}',1,10)::date >= $1::date`;
  const WITHIN = `${DATED} AND substr(data#>>'{warranty,expires}',1,10)::date >= $1::date AND substr(data#>>'{warranty,expires}',1,10)::date <= ($1::date + 365)`;
  const UNKNOWN = `NOT (COALESCE(data#>>'{warranty,expires}', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AND $1::date IS NOT NULL`;
  const num = (text, sql, params, shape) => out.push({ id: ID(fam, out.length + 1), text: dress(text, p), category: `blind-r35b-${fam}`, shape, cmp: "number", oracle: { sql, params }, citationRequired: true });
  ["how many units are covered", "how many units are covered right now", "how many systems are covered", "how many units are warrantied", "how many units are still warrantied",
    "how many warrantied units do we have", "how many units are currently warrantied", "how many pieces of equipment are covered", "how many units are in warranty",
    "how many units are in-warranty", "how many units are within warranty", "how many units are covered by a warranty", "how many units are still in coverage",
    "how many units are covered under a warranty right now", "how many of our systems are warrantied", "how many units are warrantied still"].forEach((t) => num(t, COUNT(NOT_EXPIRED), [TODAY], "w2_still"));
  ["how many units have warranties expiring soon", "how many warranties are expiring soon", "how many warranties expire soon", "how many units are about to come off warranty",
    "how many warranties are about to expire", "how many units have warranties running out soon", "how many units have a warranty that's expiring soon",
    "how many units' warranties run out in the next 12 months", "how many units come off warranty in the next year", "how many warranties are ending soon"].forEach((t) => num(t, COUNT(WITHIN), [TODAY], "w2_soon"));
  ["how many units have no warranty on file", "how many units have an unknown warranty", "how many units have no warranty end date on file", "how many units have no warranty info",
    "how many units are missing a warranty end date", "how many units have no warranty date", "how many units have unknown warranty status", "how many units don't have a warranty end date on file"].forEach((t) => num(t, COUNT(UNKNOWN), [TODAY], "w2_unknown"));
  const brands = [...new Set(equipment.map((u) => u.data.manufacturer).filter(Boolean))];
  const bForms = [(b) => `how many ${b} units are covered`, (b) => `how many ${b.toLowerCase()} units are warrantied`, (b) => `how many ${b} units are in warranty`, (b) => `how many ${b.toLowerCase()} systems are still covered`];
  brands.forEach((b, k) => num(bForms[k % bForms.length](b), COUNT(NOT_EXPIRED, true), [TODAY, b], "w2_brand"));
  // must-not-fire controls: "covered" in a non-warranty sense is not a warranty count (honest or other answer, never the 37)
  [["how many units are covered by a maintenance agreement", "w2_ctrl_agreement"]].forEach(([t, s]) => zero(out, fam, t, s, p));
  return out;
};

/* ------------------------------------------------------------------ loop 2: document numbers */
FAMILIES.docnum = () => {
  const p = mk(3522); const out = []; const fam = "docnum";
  const WHO = `SELECT DISTINCT c.data->>'customer_name' AS v FROM extractions x JOIN document_entity_links l ON l.document_id = x.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE x.field_key = $2 AND x.value = $1`;
  const TOTAL = `SELECT total::numeric AS n FROM document_financials WHERE invoice_number = $1 AND total IS NOT NULL LIMIT 1`;
  const val = (text, params, shape) => out.push({ id: ID(fam, out.length + 1), text: dress(text, p), category: `blind-r35b-${fam}`, shape, cmp: "value", oracle: { sql: WHO, params }, citationRequired: true });
  const num = (text, params, shape) => out.push({ id: ID(fam, out.length + 1), text: dress(text, p), category: `blind-r35b-${fam}`, shape, cmp: "number", oracle: { sql: TOTAL, params }, citationRequired: true });
  const ex = (k) => g.extractions.filter((x) => x.field_key === k);
  const inv = p.shuffle(ex("invoice_number").filter((x) => /^INV-/.test(x.value)));
  const wo = p.shuffle(ex("invoice_number").filter((x) => /^WO-/.test(x.value)));
  const po = p.shuffle(ex("po_number"));
  const permit = p.shuffle(ex("permit_number"));
  const whoInv = [(n) => `who is invoice ${n} for`, (n) => `whose invoice is ${n}`, (n) => `customer on invoice ${n}`, (n) => `invoice ${n} - who's that`, (n) => `who did we bill on ${n}`, (n) => `what customer is ${n}`, (n) => `invoice # ${n}`, (n) => `pull up invoice ${n}`, (n) => `look up ${n}`, (n) => `${n}?`];
  inv.slice(0, 20).forEach((x, k) => val(whoInv[k % whoInv.length](x.value), [x.value, "invoice_number"], "dn_inv_who"));
  const totInv = [(n) => `how much was invoice ${n}`, (n) => `total on invoice ${n}`, (n) => `what did we charge on ${n}`, (n) => `amount for invoice ${n}`, (n) => `how much was ${n}`, (n) => `what was the total for ${n}`];
  inv.slice(20, 38).forEach((x, k) => num(totInv[k % totInv.length](x.value), [x.value], "dn_inv_total"));
  // digits only after the word "invoice"
  inv.slice(38, 44).forEach((x, k) => val([(n) => `invoice ${n.replace(/^INV-/, "")}`, (n) => `who is invoice number ${n.replace(/^INV-/, "")} for`, (n) => `invoice #${n.replace(/^INV-/, "")}`][k % 3](x.value), [x.value, "invoice_number"], "dn_inv_digits"));
  const woF = [(n) => `work order ${n}`, (n) => `who is work order ${n} for`, (n) => `whose job is ${n}`, (n) => `pull up WO ${n.replace(/^WO-/, "")}`];
  wo.slice(0, 10).forEach((x, k) => val(woF[k % woF.length](x.value), [x.value, "invoice_number"], "dn_wo"));
  const poF = [(n) => `purchase order ${n}`, (n) => `who is ${n} for`, (n) => `what customer is on ${n}`, (n) => `po ${n}`];
  po.slice(0, 10).forEach((x, k) => val(poF[k % poF.length](x.value), [x.value, "po_number"], "dn_po"));
  const pmF = [(n) => `permit ${n}`, (n) => `who is permit ${n} for`, (n) => `whose permit is ${n}`, (n) => `permit number ${n}`];
  permit.slice(0, 10).forEach((x, k) => val(pmF[k % pmF.length](x.value), [x.value, "permit_number"], "dn_permit"));
  // not on file
  const have = new Set([...ex("invoice_number"), ...ex("po_number"), ...ex("permit_number")].map((x) => x.value));
  const miss = (pre, lo, hi) => { let v; do { v = `${pre}${lo + Math.floor(p.r() * (hi - lo))}`; } while (have.has(v)); return v; };
  const missF = [(n) => `invoice ${n}`, (n) => `how much was invoice ${n}`, (n) => `who is invoice ${n} for`, (n) => `pull up ${n}`, (n) => `what was ${n} for`];
  for (let k = 0; k < 10; k++) zero(out, fam, missF[k % missF.length](miss("INV-", 30000, 99999)), "dn_miss_inv", p);
  for (let k = 0; k < 4; k++) zero(out, fam, [(n) => `work order ${n}`, (n) => `who is ${n} for`][k % 2](miss("WO-", 50000, 99999)), "dn_miss_wo", p);
  for (let k = 0; k < 4; k++) zero(out, fam, [(n) => `purchase order ${n}`, (n) => `po ${n}`][k % 2](miss("PO-", 9500, 9999)), "dn_miss_po", p);
  for (let k = 0; k < 4; k++) zero(out, fam, [(n) => `permit ${n}`, (n) => `who is permit ${n} for`][k % 2](miss("BP-2026-", 50000, 99999)), "dn_miss_permit", p);
  return out;
};

/* ------------------------------------------------------------------ loop 3: advice / prediction / false premise / unknown person */
FAMILIES.advice = () => {
  const p = mk(3533); const out = []; const fam = "advice";
  const techs = [...new Set(g.extractions.filter((x) => x.field_key === "technician").map((x) => x.value))];
  const pageText = new Map();
  for (const pg of g.pages ?? []) pageText.set(pg.document_id, `${pageText.get(pg.document_id) ?? ""} ${pg.text ?? pg.content ?? ""}`);
  const docsOf = new Map();
  for (const l of g.document_entity_links) { if (!docsOf.has(l.entity_id)) docsOf.set(l.entity_id, []); docsOf.get(l.entity_id).push(l.document_id); }
  const mentions = (c, re) => (docsOf.get(c.id) ?? []).some((d) => re.test(pageText.get(d) ?? ""));
  const addrOf = (c) => String(c.service_address ?? "").split(",")[0];
  const cs = p.shuffle(person.filter((c) => c.service_address));
  const adv = [(c) => `should I replace the unit at ${addrOf(c)}`, (c) => `is it worth repairing ${c.customer_name}'s unit`, (c) => `should we fix or replace the system at ${addrOf(c)}`,
    (c) => `is ${c.customer_name} a good customer`, (c) => `should we keep ${c.customer_name} as a customer`, (c) => `would you recommend a new unit for ${c.customer_name}`];
  cs.slice(0, 12).forEach((c, k) => zero(out, fam, adv[k % adv.length](c), "adv_named", p));
  ["what is the best AC brand", "which brand should we stock", "what's the most reliable furnace brand", "should I raise my prices", "what should I charge for a capacitor",
    "what should I charge for a compressor swap", "how much should a tune-up cost", "is Trane better than Carrier", "should we buy another van", "should I hire another tech",
    "what's a fair price for a service call", "which brand should I recommend to customers"].forEach((t) => zero(out, fam, t, "adv_general", p));
  techs.slice(0, 4).forEach((t, k) => zero(out, fam, [`should we fire ${t}`, `is ${t} a good tech`, `should I give ${t} a raise`, `is ${t} worth keeping`][k % 4], "adv_tech", p));
  ["how many service calls will we have next month", "what will we invoice next quarter", "predict our revenue for next year", "which unit will fail next", "how busy will we be next summer", "forecast our sales for 2027"]
    .forEach((t) => zero(out, fam, t, "adv_predict", p));
  // false premise: an event no document at that customer mentions
  const clean = cs.filter((c) => !mentions(c, /compressor/i)).slice(0, 8);
  const fp = [(c, t) => `why did ${t} replace the compressor at ${addrOf(c)}`, (c) => `when did we replace the compressor for ${c.customer_name}`, (c, t) => `why did ${t} swap the compressor at ${addrOf(c)}`, (c) => `how much did the compressor replacement for ${c.customer_name} cost`];
  clean.forEach((c, k) => zero(out, fam, fp[k % fp.length](c, techs[k % techs.length] ?? "Danny Ochoa"), "adv_false_premise", p));
  // unknown person
  const first = ["Zaphod", "Jebediah", "Quentin", "Ophelia", "Bartholomew", "Thaddeus", "Philippa", "Ignatius"];
  const last = ["Beeblebrox", "Featherstone", "Wolcott", "Pendergast", "Huxley", "Abernethy-Smythe", "Ravensworth", "Quackenbush"];
  const names = new Set(customers.map((c) => c.customer_name.toLowerCase()));
  for (let k = 0; k < 10; k++) {
    const n = `${first[k % first.length]} ${last[(k * 3) % last.length]}`;
    if (names.has(n.toLowerCase())) continue;
    zero(out, fam, [`who is ${n}`, `tell me about ${n}`, `who's ${n}`, `what do we have on ${n}`, `is ${n} a customer`][k % 5], "adv_unknown_person", p);
  }
  return out;
};

/* ------------------------------------------------------------------ loop 4: partial serials */
FAMILIES.serial2 = () => {
  const p = mk(3544); const out = []; const fam = "serial2";
  const units = p.shuffle(equipment.filter((u) => u.data.serial_number && u.customer_id));
  const canon = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
  const all = equipment.map((u) => canon(u.data.serial_number ?? ""));
  const unique = (frag) => all.filter((s) => s.includes(canon(frag))).length === 1;
  const WHO = `SELECT c.data->>'customer_name' AS v FROM entities e JOIN entities c ON c.id = e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'serial_number' = $1`;
  const forms = [(f) => `who has serial ${f}`, (f) => `serial ending in ${f}`, (f) => `whose unit has serial ${f}`, (f) => `sn ${f} - whose unit`, (f) => `customer for s/n ${f}`, (f) => `who has the unit with serial ending ${f}`, (f) => `serial ${f}, whose is it`, (f) => `which customer has serial ${f}`];
  let k = 0;
  for (const u of units) {
    if (out.length >= 30) break;
    const s = u.data.serial_number;
    const frag = s.slice(-6);
    if (frag.length < 5 || !unique(frag) || canon(frag) === canon(s)) continue;
    out.push({ id: ID(fam, out.length + 1), text: dress(forms[k++ % forms.length](frag), p), category: `blind-r35b-${fam}`, shape: "s2_partial_unique", cmp: "value", oracle: { sql: WHO, params: [s] }, citationRequired: true });
  }
  // ambiguous partials: more than one serial contains it -> never one picked (honest decline / list)
  ["10001", "10002", "10003", "10010", "10011", "10012", "10005", "10009"].forEach((f, i) => { if (!unique(f)) zero(out, fam, [`who has serial ${f}`, `serial ending in ${f}`, `sn ${f} whose unit`, `customer for s/n ${f}`][i % 4], "s2_partial_ambiguous", p); });
  return out;
};

/* ------------------------------------------------------------------ loop 5: texting shorthand (exam g091 "warranty info 4 the unit @ 322 n greenfield") */
FAMILIES.short = () => {
  const p = mk(3555); const out = []; const fam = "short";
  const cs = p.shuffle(person.filter((c) => c.service_address && c.phone && customers.filter((o) => o.customer_name === c.customer_name).length === 1));
  const single = cs.filter((c) => equipment.filter((u) => u.customer_id === c.id).length === 1 && customers.filter((o) => String(o.service_address).split(",")[0] === String(c.service_address).split(",")[0]).length === 1);
  const street = (c) => String(c.service_address).split(",")[0];
  const W = `SELECT (CASE WHEN (e.data#>>'{warranty,expires}') IS NULL OR (e.data#>>'{warranty,expires}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown' WHEN substr(e.data#>>'{warranty,expires}',1,10)::date < $2::date THEN 'expired' WHEN substr(e.data#>>'{warranty,expires}',1,10)::date - $2::date <= 365 THEN 'expiring' ELSE 'active' END) AS v FROM entities e JOIN entities c ON c.id = e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
  const PH = `SELECT data->>'phone' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
  const AD = `SELECT data->>'service_address' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
  const SN = `SELECT e.data->>'serial_number' AS v FROM entities e JOIN entities c ON c.id = e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
  const push = (text, sql, params, shape) => out.push({ id: ID(fam, out.length + 1), text: dress(text, p), category: `blind-r35b-${fam}`, shape, cmp: "value", oracle: { sql, params }, citationRequired: true });
  const wF = [(a) => `need the warranty info 4 the unit @ ${a.toLowerCase()}`, (a) => `wrnty status 4 unit @ ${a}`, (a) => `warranty on the unit @ ${a} pls`, (a) => `is the unit @ ${a} still under wrnty`, (a) => `warr status @ ${a}`, (a) => `whats the warranty look like 4 ${a}`];
  single.slice(0, 18).forEach((c, k) => push(wF[k % wF.length](street(c)), W, [c.customer_name, TODAY], "sh_warranty_addr"));
  const pF = [(n) => `ph# 4 ${n}`, (n) => `ph # for ${n}`, (n) => `need ${n}'s #`, (n) => `phone # 4 ${n} pls`, (n) => `whats the # 4 ${n}`, (n) => `gimme the ph for ${n}`];
  cs.slice(0, 12).forEach((c, k) => push(pF[k % pF.length](c.customer_name), PH, [c.customer_name], "sh_phone"));
  const aF = [(n) => `addy 4 ${n}`, (n) => `whats ${n}'s addy`, (n) => `addr 4 ${n} pls`, (n) => `where does ${n} live @`];
  cs.slice(12, 20).forEach((c, k) => push(aF[k % aF.length](c.customer_name), AD, [c.customer_name], "sh_address"));
  const sF = [(n) => `s/n 4 ${n}'s unit`, (n) => `serial # 4 ${n}`, (n) => `sn on ${n}'s system pls`];
  single.slice(18, 27).forEach((c, k) => push(sF[k % sF.length](c.customer_name), SN, [c.customer_name], "sh_serial"));
  return out;
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FAMILIES);
for (const fam of want) {
  const qs = FAMILIES[fam]();
  const file = path.join(ROOT, `test-docs/scorecard/blind/r35-${fam}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: "r35b-blind-1", category: `blind-r35b-${fam}`, source: "scripts/gen-blind-r35b.mjs (seeded, frozen before the loop's rule)", questions: qs }, null, 1) + "\n");
  console.log(`${fam}: ${qs.length} questions -> ${path.relative(ROOT, file)}`);
}
