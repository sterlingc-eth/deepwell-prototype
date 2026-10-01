#!/usr/bin/env node
/**
 * R32b (Team A3) BLIND sets — one FRESH set per learning-loop family, written and frozen BEFORE the loop that targets it.
 * Same conventions as gen-blind-r31.mjs (seeded, oracle SQL against the golden tenant, graded with the production comparators by
 * scripts/run-exam-subset.mjs --no-base --blind <file>). Golden tenant is the oracle; nothing here is copied from exam.json wording.
 *   node scripts/gen-blind-r32b.mjs [family ...]     # default: every family present in this file
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
const byCust = new Map(); for (const u of equipment) { if (!byCust.has(u.customer_id)) byCust.set(u.customer_id, []); byCust.get(u.customer_id).push(u.data); }
const nameCount = new Map(); for (const c of customers) nameCount.set(c.customer_name, (nameCount.get(c.customer_name) ?? 0) + 1);
const uniq = customers.filter((c) => nameCount.get(c.customer_name) === 1 && c.service_address);
const person = uniq.filter((c) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.customer_name));
const streetOf = (a) => a.split(",")[0];
const cityOf = (a) => { const parts = a.split(",").map((x) => x.trim()); return parts.length >= 3 ? parts[parts.length - 2] : (parts[1] ?? ""); };
const techs = [...new Set(g.extractions.filter((e) => e.field_key === "technician").map((e) => e.value))].sort();
const surname = (c) => c.customer_name.split(" ").slice(-1)[0];
const CUST_ONE = (col) => `SELECT data->>'${col}' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
const CUST_REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
const valueQ = (id, cat, text, col, name, shape) => ({ id, text, category: cat, shape, cmp: "value", oracle: { sql: CUST_ONE(col), params: [`%${name}%`], requires: { sql: CUST_REQ, params: [`%${name}%`] } }, citationRequired: true });
const zeroConst = (id, cat, text, shape, sql = "SELECT 0 AS n") => ({ id, text, category: cat, shape, cmp: "honest-zero", oracle: { sql, params: [] } });
const LEAD = ["", "", "", "", "so uh, ", "hey, ", "quick one - ", "ok so ", "hmm, ", "real quick: ", "alright, ", "sorry, one more - ", "ok um, ", "hang on... "];
const TAIL = ["", "", "", "", " please", " thanks", " real quick", " for me", " when you get a sec"];
const dress = (s, p) => (p.pick(LEAD) + s + p.pick(TAIL)).replace(/\s+/g, " ").trim();
const ID = (fam, n) => `bl-r32b-${fam}-${String(n).padStart(3, "0")}`;
const FAMILIES = {};

const pageText = g.pages.map((pg) => String(pg.text ?? "").toLowerCase()).join("\n");
const entText = g.entities.map((e) => JSON.stringify(e.data ?? {}).toLowerCase()).join("\n");
const lev = (a, b) => { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; };
const custWords = new Set(customers.flatMap((c) => c.customer_name.toLowerCase().split(/\s+/)));
/** a made-up name token that appears nowhere in the tenant (no entity, no page text) and is > 3 edits from every customer word */
const absentTok = (w) => !pageText.includes(w) && !entText.includes(w) && [...custWords].every((cw) => lev(w, cw) > 3);

/* ---------------------------------------------------------------- Loop A: unextracted unit attributes (SEER / filter size) + unknown names + persona/support/announcement declines + controls */
FAMILIES.decl = () => {
  const p = mk(3301); const out = []; let n = 0; const cat = "blind-r32b-decl";
  const add = (text, shape, sql = "SELECT 0 AS n") => out.push(zeroConst(ID("decl", ++n), cat, dress(text, p), shape, sql));
  // A. SEER / filter size (never extracted, never printed with a value in this corpus) by street address, by customer name, by surname
  const addrs = p.shuffle(uniq).slice(0, 44);
  const seerA = [(a) => `what's the seer on the unit at ${a}`, (a) => `seer rating for ${a}`, (a) => `whats the efficiency rating of the system at ${a}`, (a) => `seer # at ${a}`, (a) => `how efficient is the unit at ${a}, whats the seer`, (a) => `seer2 rating on file for ${a}`];
  const filtA = [(a) => `filter size for the unit at ${a}`, (a) => `what size filter does ${a} take`, (a) => `whats the filter dimensions at ${a}`, (a) => `which filter size goes in the system at ${a}`];
  addrs.slice(0, 24).forEach((c, i) => add(seerA[i % seerA.length](streetOf(c.service_address)), "blind_seer_addr"));
  addrs.slice(24, 36).forEach((c, i) => add(filtA[i % filtA.length](streetOf(c.service_address)), "blind_filter_addr"));
  const seerN = [(nm) => `what's ${nm}'s seer rating`, (nm) => `seer on ${nm}'s system`, (nm) => `efficiency rating on the ${nm} unit`, (nm) => `what size filter does ${nm} use`, (nm) => `filter size on ${nm}'s furnace`, (nm) => `seer rating for ${nm}`];
  p.shuffle(person).slice(0, 20).forEach((c, i) => add(seerN[i % seerN.length](c.customer_name), "blind_seer_name"));
  // B. names that exist nowhere in the tenant (no entity, no page text, > 3 edits from every customer word): a field lookup is an honest decline
  const SUR = ["Hargrove", "Tillman", "Quintero", "Delacroix", "Bellweather", "Ostrander", "Pennington", "Valkenburg", "Throckmorton", "Zielinski", "Abernethy-Cole", "Montgomery", "Johansson", "Kowalczyk", "Fairbanks", "Lindqvist", "Rasmussen", "Underhill", "Whitcomb", "Yarborough", "Sorensen", "Prescott", "Galloway", "Ravenscroft", "Thibodeaux", "Mulvaney", "Castellano", "Brightwater", "Lockhart", "Stallworth"].filter((w) => absentTok(w.toLowerCase()));
  const FIRST = ["Gordon", "Priscilla", "Thaddeus", "Winifred", "Leopold", "Marguerite", "Cornelius", "Ophelia"].filter((w) => absentTok(w.toLowerCase()));
  const unkS = [(s) => `phone number for ${s}`, (s) => `email on file for ${s}`, (s) => `serial on the ${s} unit`, (s) => `when was ${s} last serviced`, (s) => `warranty status on ${s}'s system`, (s) => `whats the address for ${s}`, (s) => `what brand is the ${s} unit`, (s) => `any invoices for ${s}`, (s) => `who was the last tech at ${s}'s`, (s) => `tonnage on ${s}'s unit`];
  p.shuffle(SUR).slice(0, 26).forEach((s, i) => add(unkS[i % unkS.length](p.pick([s.toLowerCase(), s])), "blind_unknown_surname"));
  const unkF = [(f, s) => `phone number for ${f} ${s}`, (f, s) => `email for ${f} ${s}`, (f, s) => `what do we have on file for ${f} ${s}`, (f, s) => `when did we last service ${f} ${s}`, (f, s) => `pull up ${f} ${s}`];
  for (let i = 0; i < 16; i++) add(unkF[i % unkF.length](FIRST[i % FIRST.length], SUR[(i * 3 + 1) % SUR.length]), "blind_unknown_fullname");
  // C. persona / support / company-wide announcements (the records hold none of these)
  const persona = ["who's your favorite technician", "who is your favorite customer", "whos your favorite tech", "which customer is your favorite", "do you have a favorite account", "who's your favorite person in the shop", "what's your favorite unit brand", "who is your least favorite customer"];
  const support = ["how do I change my account password", "how can i reset my password", "how do i update my login email", "how do I change my password", "how do i add another user to my account", "where do i reset my account password", "how can i change my billing email"];
  const announce = ["what did the shop manager circulate to everyone yesterday", "what did the owner announce to the whole team last week", "what memo went out to all staff", "what did dispatch email everyone this morning", "what was the all-hands announcement", "what did the boss tell the entire crew yesterday", "which company-wide email went out on friday", "what did the office manager send to the whole shop"];
  for (const q of persona) add(q, "blind_persona");
  for (const q of support) add(q, "blind_support_howto");
  for (const q of announce) add(q, "blind_announcement");
  // D. negative controls (must still be answered from records / not swallowed by the new declines)
  const ctl = p.shuffle(person).slice(0, 26);
  const cores = [["whats the phone number for", "phone"], ["email on file for", "email"], ["service address for", "service_address"], ["phone for", "phone"], ["give me the email for", "email"]];
  ctl.forEach((c, i) => { const [pre, col] = cores[i % cores.length]; out.push(valueQ(ID("decl", ++n), cat, dress(`${pre} ${c.customer_name}`, p), col, c.customer_name, "blind_decl_control")); });
  return out;
};

/* ---------------------------------------------------------------- Loop A HOLD-OUT: decl2 - written AFTER loop A was implemented; different wording, different names; run once for the "unseen" number. */
FAMILIES.decl2 = () => {
  const p = mk(3302); const out = []; let n = 0; const cat = "blind-r32b-decl2";
  const add = (text, shape, sql = "SELECT 0 AS n") => out.push(zeroConst(ID("decl2", ++n), cat, dress(text, p), shape, sql));
  const addrs = p.shuffle(uniq).slice(0, 40);
  const seerA = [(a) => `how many seer is the unit at ${a}`, (a) => `what's the seer on file at ${a}`, (a) => `seer rating of the equipment at ${a}`, (a) => `unit efficiency at ${a}`, (a) => `what filter size does the system at ${a} need`, (a) => `filter dimensions at ${a}`, (a) => `which size filter for ${a}`, (a) => `seer value for the house at ${a}`];
  addrs.forEach((c, i) => add(seerA[i % seerA.length](streetOf(c.service_address)), "blind2_attr_addr"));
  const seerN = [(nm) => `how efficient is ${nm}'s system, what seer`, (nm) => `what seer does ${nm} have`, (nm) => `which filter does ${nm} use`, (nm) => `filter size for ${nm}`, (nm) => `${nm}'s filter size`, (nm) => `seer on the ${nm} account`];
  p.shuffle(person).slice(0, 18).forEach((c, i) => add(seerN[i % seerN.length](c.customer_name), "blind2_attr_name"));
  const SUR = ["Ellsworth", "Vanderbilt", "Kensington", "Okonkwo", "Papadopoulos", "Sundquist", "Fitzwilliam", "Hawthorne-Reyes", "Blackwood", "Tremaine", "Caldecott", "Dunleavy", "Nakagawa", "Petrovich", "Wolfenden", "Yamashita", "Beauregard", "Cavanaugh", "Eastwood", "Greystone", "Holloway", "Ironside", "Jankowski", "Kirkpatrick", "Langstrom", "Merriweather", "Northcutt", "Oppenheimer"].filter((w) => absentTok(w.toLowerCase()));
  const FIRST = ["Bertram", "Cordelia", "Desmond", "Evangeline", "Fitzgerald", "Hortense", "Ignatius", "Josephine"].filter((w) => absentTok(w.toLowerCase()));
  const unk = [(s) => `phone for ${s}`, (s) => `${s}'s phone number`, (s) => `can you pull the email for ${s}`, (s) => `what is the serial number on ${s}'s unit`, (s) => `last time we serviced ${s}`, (s) => `is the ${s} unit still under warranty`, (s) => `what's on file for ${s}`, (s) => `where does ${s} live`, (s) => `what model does ${s} have`, (s) => `when did we last visit ${s}`];
  p.shuffle(SUR).slice(0, 24).forEach((s, i) => add(unk[i % unk.length](p.pick([s, s.toLowerCase()])), "blind2_unknown_surname"));
  for (let i = 0; i < 12; i++) add(unk[(i * 3) % unk.length](`${FIRST[i % FIRST.length]} ${SUR[(i * 5 + 2) % SUR.length]}`), "blind2_unknown_fullname");
  const persona = ["whos ur favorite customer", "which tech is your favorite", "if you had to pick a favorite account which one", "who do you like best, the customers or the techs", "do you have favorite technicians", "which technician is your least favorite"];
  const support = ["how do i change the password on my account", "how can i update my account email", "what do i click to reset my password", "how do i invite a new user to my account", "how do i remove a user from my account", "can you tell me how to change my billing info", "how do i upgrade my plan"];
  const announce = ["what did management send to all staff", "which memo went to the entire team this week", "what did dispatch tell everyone this morning", "what did the owner email the whole crew", "what announcement went out company-wide", "what did the supervisor circulate to the team yesterday"];
  for (const q of persona) add(q, "blind2_persona");
  for (const q of support) add(q, "blind2_support_howto");
  for (const q of announce) add(q, "blind2_announcement");
  const ctl = p.shuffle(person).slice(0, 22);
  const cores = [["can you pull the phone for", "phone"], ["what email do we have for", "email"], ["where does", "service_address"], ["contact number for", "phone"]];
  ctl.forEach((c, i) => { const [pre, col] = cores[i % cores.length]; out.push(valueQ(ID("decl2", ++n), cat, dress(pre === "where does" ? `where does ${c.customer_name} live` : `${pre} ${c.customer_name}`, p), col, c.customer_name, "blind2_decl_control")); });
  return out;
};

/* ---------------------------------------------------------------- Loop B: per-customer / per-vendor counts and named-pair comparisons (documents, jobs, invoices, POs, service types) */
const docsOf = (nameParam) => `(SELECT count(DISTINCT l.document_id) FROM document_entity_links l JOIN entities c ON c.id=l.entity_id AND c.entity_type='customer' WHERE c.merged_into IS NULL AND c.data->>'customer_name' = ${nameParam})`;
const invOf = (nameParam) => `(SELECT count(*) FROM document_financials df JOIN document_entity_links l ON l.document_id=df.document_id JOIN entities c ON c.id=l.entity_id AND c.entity_type='customer' WHERE c.merged_into IS NULL AND df.doc_kind='invoice' AND df.direction='receivable' AND c.data->>'customer_name' = ${nameParam})`;
const poOf = (vp) => `(SELECT count(*) FROM documents d JOIN extractions v ON v.document_id=d.id AND v.field_key='vendor_name' AND v.value=${vp} WHERE d.document_type='purchase-order')`;
FAMILIES.compare = () => {
  const p = mk(3303); const out = []; let n = 0; const cat = "blind-r32b-compare";
  const docN = new Map(); for (const l of g.document_entity_links) { if (!docN.has(l.entity_id)) docN.set(l.entity_id, new Set()); docN.get(l.entity_id).add(l.document_id); }
  const sizeOf = (c) => docN.get(c.id)?.size ?? 0;
  const pool = p.shuffle(uniq.filter((c) => sizeOf(c) > 0));
  const mkQ = (text, shape, cmp, sql, params = [], extra = {}) => out.push({ id: ID("compare", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params, ...(extra.requires ? { requires: extra.requires } : {}) }, citationRequired: true });
  // A. per-customer document / job counts (documents = distinct documents linked to the customer; jobs follow the exam's own convention)
  const cnt = [(nm) => `how many documents do we have on file for ${nm}`, (nm) => `how many docs does ${nm} have`, (nm) => `document count for ${nm}`, (nm) => `how many files are there for ${nm}`, (nm) => `how many jobs have we done for ${nm}`, (nm) => `how many jobs for ${nm}`];
  pool.slice(0, 30).forEach((c, i) => mkQ(cnt[i % cnt.length](c.customer_name), "blind_cust_doc_count", "number", `SELECT ${docsOf("$1")} AS n`, [c.customer_name]));
  // B. per-customer invoice counts (the money route used to ignore the customer and answer the shop-wide 120)
  const inv = [(nm) => `how many invoices for ${nm}`, (nm) => `how many invoices does ${nm} have`, (nm) => `how many invoices have we sent ${nm}`, (nm) => `number of invoices for ${nm}`];
  pool.slice(30, 54).forEach((c, i) => mkQ(inv[i % inv.length](c.customer_name), "blind_cust_invoice_count", "number", `SELECT ${invOf("$1")} AS n`, [c.customer_name]));
  // C. vendor purchase-order counts (used to answer the shop-wide 19 for either vendor)
  const vend = ["Baker Distributing", "Watsco Supply"];
  const vq = [(v) => `how many purchase orders from ${v}`, (v) => `how many POs do we have with ${v}`, (v) => `number of purchase orders for ${v}`, (v) => `how many purchase orders have we placed with ${v}`, (v) => `how many POs from ${v}`, (v) => `purchase order count for ${v}`];
  for (let i = 0; i < 12; i++) { const v = vend[i % 2]; mkQ(vq[i % vq.length](p.pick([v, v.toLowerCase()])), "blind_vendor_po_count", "number", `SELECT ${poOf("$1")} AS n`, [v]); }
  // D. named-pair comparisons of document counts: yes/no ("has A had more ... than B") and which-has-more
  const differing = []; const tied = [];
  for (let i = 0; i + 1 < pool.length && differing.length < 60; i += 2) { const a = pool[i], b = pool[(i + 7) % pool.length]; if (a.id === b.id) continue; (sizeOf(a) === sizeOf(b) ? tied : differing).push([a, b]); }
  const ynQ = [(a, b) => `has ${a} had more documents on file than ${b}`, (a, b) => `does ${a} have more documents than ${b}`, (a, b) => `has ${a} had more jobs than ${b}`, (a, b) => `does ${a} have fewer documents on file than ${b}`, (a, b) => `have we got more paperwork on ${a} than on ${b}`];
  differing.slice(0, 26).forEach(([a, b], i) => { const t = ynQ[i % ynQ.length]; const fewer = /fewer/.test(t("x", "y")); mkQ(t(a.customer_name, b.customer_name), "blind_cust_cmp_yesno", "yesno", `SELECT (${docsOf("$1")} ${fewer ? "<" : ">"} ${docsOf("$2")}) AS v`, [a.customer_name, b.customer_name]); });
  tied.slice(0, 6).forEach(([a, b], i) => mkQ(ynQ[i % 3](a.customer_name, b.customer_name), "blind_cust_cmp_tied", "yesno", `SELECT (${docsOf("$1")} > ${docsOf("$2")}) AS v`, [a.customer_name, b.customer_name]));
  const whichQ = [(a, b) => `who has more documents on file, ${a} or ${b}`, (a, b) => `which customer has more jobs, ${a} or ${b}`, (a, b) => `does ${a} or ${b} have more documents`, (a, b) => `between ${a} and ${b}, who has more files`];
  differing.slice(26, 46).forEach(([a, b], i) => mkQ(whichQ[i % whichQ.length](a.customer_name, b.customer_name), "blind_cust_cmp_which", "value", `SELECT CASE WHEN ${docsOf("$1")} > ${docsOf("$2")} THEN $1 ELSE $2 END AS v`, [a.customer_name, b.customer_name], { requires: { sql: `SELECT (${docsOf("$1")} <> ${docsOf("$2")})::int AS n`, params: [a.customer_name, b.customer_name] } }));
  // E. vendor and service-type comparisons
  const vcq = [(a, b) => `have we bought more from ${a} or ${b}`, (a, b) => `do we order more from ${a} or ${b}, by PO count`, (a, b) => `which vendor do we have more purchase orders with, ${a} or ${b}`, (a, b) => `more POs with ${a} than ${b}?`];
  for (let i = 0; i < 8; i++) { const [a, b] = i % 2 ? [vend[1], vend[0]] : [vend[0], vend[1]]; const w = i % 4 === 2; mkQ(vcq[i % vcq.length](a, b), "blind_vendor_cmp", i % 4 !== 3 ? "value" : "yesno", i % 4 !== 3 ? `SELECT CASE WHEN ${poOf("$1")} > ${poOf("$2")} THEN $1 ELSE $2 END AS v` : `SELECT (${poOf("$1")} > ${poOf("$2")}) AS v`, [a, b]); }
  const stq = [["do we do more repair work or more preventive maintenance", "Repair", "Preventive Maintenance"], ["are there more repair calls than preventive maintenance visits", "Repair", "Preventive Maintenance"], ["which is bigger for us, repairs or PM, by volume", "Repair", "Preventive Maintenance"], ["do we do more preventive maintenance than repairs", "Preventive Maintenance", "Repair"], ["have we done more PM visits than repair jobs", "Preventive Maintenance", "Repair"], ["are repairs or preventive maintenance more common for us", "Repair", "Preventive Maintenance"]];
  const stCount = (v) => `(SELECT count(*) FROM extractions WHERE field_key='service_type' AND value=${v})`;
  stq.forEach(([t, a, b], i) => { const which = /which is bigger|or preventive maintenance more common|more repair work or more/.test(t); mkQ(t, "blind_servicetype_cmp", which ? "value" : "yesno", which ? `SELECT CASE WHEN ${stCount("$1")} > ${stCount("$2")} THEN $1 ELSE $2 END AS v` : `SELECT (${stCount("$1")} > ${stCount("$2")}) AS v`, [a, b]); });
  // F. controls that must keep answering exactly as before (shop-wide counts, brand / doctype comparisons)
  mkQ("how many invoices do we have", "blind_compare_control", "number", `SELECT count(*) AS n FROM document_financials WHERE doc_kind='invoice' AND direction='receivable'`);
  mkQ("how many purchase orders do we have", "blind_compare_control", "number", `SELECT count(*) AS n FROM document_financials WHERE doc_kind='po'`);
  mkQ("do we have more Rheem or Carrier units", "blind_compare_control", "yesno", `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'rheem') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'carrier') AS v`);
  mkQ("do we have more Mitsubishi or Lennox units", "blind_compare_control", "yesno", `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'mitsubishi') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'lennox') AS v`);
  return out;
};

/* ---------------------------------------------------------------- Loop C: warranty / date extrema, "not under warranty" counts, technicians who never did X, text-less documents, history-skew yes/no */
const MFRS = ["Trane", "Carrier", "Goodman", "Lennox", "Rheem", "York", "Daikin", "Mitsubishi"];
const WEXP = `data#>>'{warranty,expires}'`;
const EQ = `entity_type='equipment' AND merged_into IS NULL`;
FAMILIES.agg = () => {
  const p = mk(3304); const out = []; let n = 0; const cat = "blind-r32b-agg";
  const add = (text, shape, cmp, sql, params = [], cit = true) => out.push({ id: ID("agg", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params }, citationRequired: cit });
  // A. earliest / latest warranty expiration (overall and per brand) - value (date)
  const early = [(b) => `whats the earliest ${b}warranty expiration we have on file`, (b) => `when does the first ${b}warranty run out`, (b) => `earliest ${b}warranty expiry on file`, (b) => `which ${b}warranty expires first, what date`];
  const late = [(b) => `latest ${b}warranty expiration on file`, (b) => `when does the last ${b}warranty run out`, (b) => `what's the furthest out ${b}warranty end date`, (b) => `which ${b}warranty expires last, what date`];
  for (let i = 0; i < 18; i++) { const m = i < 4 ? "" : p.pick(MFRS); const b = m ? `${p.pick([m, m.toLowerCase()])} ` : ""; const mf = m ? `AND data->>'manufacturer' ILIKE $1` : ""; const prm = m ? [m] : []; const isEarly = i % 2 === 0;
    add((isEarly ? early : late)[(i >> 1) % 4](b), "blind_warranty_extreme", "value", `SELECT ${WEXP} AS v FROM entities WHERE ${EQ} AND ${WEXP} IS NOT NULL ${mf} ORDER BY ${WEXP} ${isEarly ? "ASC" : "DESC"} LIMIT 1`, prm); }
  // B. counts of units out of / under warranty (overall and per brand): expired = expires <= today; active = expires > today (units with no warranty date are in neither)
  const outQ = [(b) => `how many ${b}units are not currently under warranty`, (b) => `how many ${b}units are out of warranty`, (b) => `how many ${b}units have an expired warranty`, (b) => `number of ${b}systems no longer covered by warranty`];
  const inQ = [(b) => `how many ${b}units are still under warranty`, (b) => `how many ${b}units are in warranty right now`, (b) => `number of ${b}systems still covered by warranty`, (b) => `how many ${b}units have active warranty coverage`];
  for (let i = 0; i < 40; i++) { const m = i < 8 ? "" : p.pick(MFRS); const b = m ? `${p.pick([m, m.toLowerCase()])} ` : ""; const mf = m ? `AND data->>'manufacturer' ILIKE $2` : ""; const prm = m ? ["@today", m] : ["@today"]; const isOut = i % 2 === 0;
    // R35 (owner decision 2026-10-01): "still under warranty" = not expired, shop-wide and per brand (end date on or after today; expired = before today).
    // (R32b had frozen the shop-wide reading to the strict >365-day bucket; the 4 affected oracles were rewritten in place, ADJUDICATION.md "R35".)
    add((isOut ? outQ : inQ)[(i >> 1) % 4](b), "blind_warranty_count", "number", `SELECT count(*) AS n FROM entities WHERE ${EQ} AND ${WEXP} IS NOT NULL AND (${WEXP})::date ${isOut ? "<" : ">="} $1::date ${mf}`, prm); }
  // C. technicians who never logged a visit of a service type - set
  const never = (st) => `SELECT DISTINCT value AS item FROM extractions WHERE field_key='technician' EXCEPT SELECT DISTINCT t.value FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='${st}' WHERE t.field_key='technician'`;
  const nvPM = [`which technicians have never logged a preventive maintenance visit`, `which techs have never done a PM`, `who on the crew has never worked a preventive maintenance call`, `list the technicians with zero preventive maintenance visits`, `which technicians have no PM visits on file`, `any techs who've never done preventive maintenance, which ones`];
  const nvRep = [`which technicians have never logged a repair`, `which techs have never done a repair call`, `who on the crew has never worked a repair`, `list the technicians with zero repair visits`];
  nvPM.forEach((t) => add(t, "blind_tech_never_pm", "set", never("Preventive Maintenance")));
  nvRep.forEach((t) => add(t, "blind_tech_never_repair", "set", never("Repair")));
  // D. documents with no extracted text - number
  const noText = [`how many documents have no readable text extracted`, `how many documents came back with no extracted text`, `count of documents with no text on any page`, `how many files have no text we could read`];
  noText.forEach((t) => add(t, "blind_no_text_docs", "number", `SELECT count(*) AS n FROM documents d WHERE NOT EXISTS (SELECT 1 FROM document_pages pg WHERE pg.document_id = d.id AND coalesce(pg.text,'') <> '')`, [], false));
  // E. history skew: before last year vs since - yes/no
  const sdBefore = `((SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL) - (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1)))`;
  const sdSince = `(SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1))`;
  const skewB = [`has most of our service history happened before last year`, `is most of our service history older than last year`, `do most of our service visits predate last year`, `did the majority of our visits happen before last year, rather than since`, `is more than half of our service history from before last year`];
  const skewS = [`has most of our service history happened since the start of last year`, `is most of our service history from last year or later`, `do most of our service visits fall in the last two calendar years`, `did the majority of our visits happen since last year rather than before`];
  skewB.forEach((t) => add(t, "blind_history_skew", "yesno", `SELECT (${sdBefore} > ${sdSince}) AS v`, ["@today"]));
  skewS.forEach((t) => add(t, "blind_history_skew", "yesno", `SELECT (${sdSince} > ${sdBefore}) AS v`, ["@today"]));
  // F. date extrema: service visits, installs, invoices - value (date)
  const svc = (dir) => `SELECT value AS v FROM extractions WHERE field_key='service_date' AND value IS NOT NULL ORDER BY value::date ${dir} LIMIT 1`;
  const inst = (dir) => `SELECT data->>'installation_date' AS v FROM entities WHERE ${EQ} AND data->>'installation_date' IS NOT NULL ORDER BY (data->>'installation_date')::date ${dir} LIMIT 1`;
  const invd = (dir) => `SELECT invoice_date::text AS v FROM document_financials WHERE doc_kind='invoice' AND direction='receivable' AND invoice_date IS NOT NULL ORDER BY invoice_date ${dir} LIMIT 1`;
  const extr = [
    ["when was the first service visit on file", svc("ASC")], ["what's the earliest service date we have", svc("ASC")], ["date of our oldest service visit", svc("ASC")],
    ["when was the most recent service visit on file", svc("DESC")], ["what's the latest service date we have", svc("DESC")], ["date of the newest service visit", svc("DESC")],
    ["when was the oldest unit installed", inst("ASC")], ["what's the earliest installation date on file", inst("ASC")], ["when was the newest unit installed", inst("DESC")], ["what's the most recent install date we have", inst("DESC")],
    ["date of our earliest invoice", invd("ASC")], ["when is the oldest invoice we have dated", invd("ASC")], ["date of our most recent invoice", invd("DESC")], ["when was the latest invoice issued", invd("DESC")],
  ];
  extr.forEach(([t, sql]) => add(t, "blind_date_extreme", "value", sql));
  // G. open invoices in a period - honest zero (no invoice carries a payment status)
  const periods = ["last quarter", "this month", "last month", "this year", "last year", "in the last 90 days", "from this quarter", "last week"];
  periods.forEach((per, i) => add([`any invoices from ${per} that are still open`, `are there open invoices from ${per}`, `any unpaid invoices from ${per}`][i % 3], "blind_open_period", "honest-zero", `SELECT (SELECT count(*) FROM document_financials WHERE status IN ('unpaid','partial')) AS n`, [], false));
  // H. controls that must keep their exact answers
  add("how many units do we have", "blind_agg_control", "number", `SELECT count(*) AS n FROM entities WHERE ${EQ}`);
  add("how many technicians do we have on file", "blind_agg_control", "number", `SELECT count(DISTINCT value) AS n FROM extractions WHERE field_key='technician'`, [], false);
  add("how many service visits are on file", "blind_agg_control", "number", `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL`);
  return out;
};

/* Loop C hold-out (agg2): DIFFERENT phrasings from agg, written after loop C's rules were tuned on agg, to catch overfitting. */
FAMILIES.agg2 = () => {
  const p = mk(3305); const out = []; let n = 0; const cat = "blind-r32b-agg2";
  const add = (text, shape, cmp, sql, params = [], cit = true) => out.push({ id: ID("agg2", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params }, citationRequired: cit });
  const wx = (dir, m) => `SELECT ${WEXP} AS v FROM entities WHERE ${EQ} AND ${WEXP} IS NOT NULL ${m ? "AND data->>'manufacturer' ILIKE $1" : ""} ORDER BY ${WEXP} ${dir} LIMIT 1`;
  for (const m of [null, null, "Trane", "Goodman", "Rheem", "Daikin", "York", "Lennox"]) {
    const b = m ? `${m} ` : ""; const prm = m ? [m] : [];
    add(`date the earliest ${b}warranty ends`, "blind2_warranty_extreme", "value", wx("ASC", m), prm);
    add(`what is the last ${b}warranty expiry date on record`, "blind2_warranty_extreme", "value", wx("DESC", m), prm);
    add(`earliest expiring ${b}warranty, what date is it`, "blind2_warranty_extreme", "value", wx("ASC", m), prm);
  }
  const cnt = (cmp, m) => `SELECT count(*) AS n FROM entities WHERE ${EQ} AND ${WEXP} IS NOT NULL AND (${WEXP})::date ${cmp} $1::date ${m ? "AND data->>'manufacturer' ILIKE $2" : ""}`;
  for (const m of [null, null, "Carrier", "Mitsubishi", "York", "Trane", "Lennox", "Goodman", "Rheem", "Daikin"]) {
    const b = m ? `${m} ` : ""; const prm = m ? ["@today", m] : ["@today"];
    add(`how many ${b}systems are out of warranty`, "blind2_warranty_count", "number", cnt("<=", m), prm);
    add(`count of ${b}units whose warranty has expired`, "blind2_warranty_count", "number", cnt("<=", m), prm);
    if (m) add(`how many ${b}units are still covered under warranty`, "blind2_warranty_count", "number", cnt(">", m), prm);
  }
  const never = (st) => `SELECT DISTINCT value AS item FROM extractions WHERE field_key='technician' EXCEPT SELECT DISTINCT t.value FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='${st}' WHERE t.field_key='technician'`;
  ["which tech has never done a PM visit", "any technician who's never done a preventive maintenance call, who", "who hasn't done any preventive maintenance", "which techs have no preventive maintenance on their record", "which of the guys never logged a PM"].forEach((t) => add(t, "blind2_tech_never", "set", never("Preventive Maintenance")));
  ["which tech has never done a repair visit", "any technician who's never done a repair call, who", "who hasn't done any repairs"].forEach((t) => add(t, "blind2_tech_never", "set", never("Repair")));
  const svc = (dir) => `SELECT value AS v FROM extractions WHERE field_key='service_date' AND value IS NOT NULL ORDER BY value::date ${dir} LIMIT 1`;
  const inst = (dir) => `SELECT data->>'installation_date' AS v FROM entities WHERE ${EQ} AND data->>'installation_date' IS NOT NULL ORDER BY (data->>'installation_date')::date ${dir} LIMIT 1`;
  const invd = (dir) => `SELECT invoice_date::text AS v FROM document_financials WHERE doc_kind='invoice' AND direction='receivable' AND invoice_date IS NOT NULL ORDER BY invoice_date ${dir} LIMIT 1`;
  [["when was our first ever service call", svc("ASC")], ["date of the last visit we logged", svc("DESC")], ["what is the date of the earliest service visit", svc("ASC")], ["when did the latest service call happen", svc("DESC")],
   ["oldest install date on file", inst("ASC")], ["newest install date on file", inst("DESC")], ["what's the date of the first invoice", invd("ASC")], ["most recent invoice date we have", invd("DESC")], ["when was the newest invoice dated", invd("DESC")], ["what is the earliest invoice date", invd("ASC")]]
    .forEach(([t, sql]) => add(t, "blind2_date_extreme", "value", sql));
  ["how many files have blank text", "number of docs with nothing extracted", "how many documents did OCR return no text for"].forEach((t) => add(t, "blind2_no_text", "number", `SELECT count(*) AS n FROM documents d WHERE NOT EXISTS (SELECT 1 FROM document_pages pg WHERE pg.document_id = d.id AND coalesce(pg.text,'') <> '')`, [], false));
  ["are any invoices from last month still outstanding", "any outstanding invoices from this quarter", "are there unpaid invoices from the last 30 days", "any open invoices from last year"].forEach((t) => add(t, "blind2_open_period", "honest-zero", `SELECT (SELECT count(*) FROM document_financials WHERE status IN ('unpaid','partial')) AS n`, [], false));
  const sdBefore = `((SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL) - (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1)))`;
  const sdSince = `(SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1))`;
  ["is the majority of our service visits from before last year", "do most of our service calls date from before last year", "is most of our service history more recent than last year", "are most of our visits from last year or this year"].forEach((t, i) => add(t, "blind2_history_skew", "yesno", `SELECT (${i < 2 ? sdBefore + " > " + sdSince : sdSince + " > " + sdBefore}) AS v`, ["@today"]));
  // controls
  add("how many units are not covered by warranty and have no warranty date", "blind2_control", "rubric", `SELECT NULL::text AS ref WHERE false`, [], false);
  return out;
};

/* ---------------------------------------------------------------- Loop D: technician counts / pair comparisons / extremes ("job" = a technician row on a document, the r31-technician convention) */
const TN = (v) => `(SELECT count(*) FROM extractions WHERE field_key='technician' AND value=${v})`;
const TNT = (v, st) => `(SELECT count(*) FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='${st}' WHERE t.field_key='technician' AND t.value=${v})`;
FAMILIES.tech = () => {
  const p = mk(3306); const out = []; let n = 0; const cat = "blind-r32b-tech";
  const add = (text, shape, cmp, sql, params = [], cit = true) => out.push({ id: ID("tech", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params }, citationRequired: cit });
  const pairs = []; for (let i = 0; i < techs.length; i++) for (let j = 0; j < techs.length; j++) if (i !== j) pairs.push([techs[i], techs[j]]);
  const P = p.shuffle(pairs);
  // A. yes/no pair comparisons (counts differ for every pair except Denise Ford / Ray Sutton, which are tied at 55: those two are the tied controls)
  const yn = [[(a, b) => `is ${a} ahead of ${b}`, ">"], [(a, b) => `has ${a} done more jobs than ${b}`, ">"], [(a, b) => `does ${a} have more visits than ${b}`, ">"], [(a, b) => `has ${a} logged fewer calls than ${b}`, "<"], [(a, b) => `is ${a} behind ${b} on job count`, "<"], [(a, b) => `has ${a} been out on more jobs than ${b}`, ">"]];
  P.filter(([a, b]) => TN_COUNT(a) !== TN_COUNT(b)).slice(0, 36).forEach(([a, b], i) => { const [t, op] = yn[i % yn.length]; add(t(a, b), "blind_tech_cmp_yesno", "yesno", `SELECT (${TN("$1")} ${op} ${TN("$2")}) AS v`, [a, b]); });
  P.filter(([a, b]) => TN_COUNT(a) === TN_COUNT(b)).slice(0, 2).forEach(([a, b], i) => add(yn[i][0](a, b), "blind_tech_cmp_tied", "yesno", `SELECT (${TN("$1")} > ${TN("$2")}) AS v`, [a, b]));
  // B. which-has-more
  const wh = [(a, b) => `who has done more jobs, ${a} or ${b}`, (a, b) => `between ${a} and ${b}, who has more visits`, (a, b) => `which is busier, ${a} or ${b}`, (a, b) => `does ${a} or ${b} have more calls on file`];
  (() => { const f = P.filter(([a, b]) => TN_COUNT(a) > TN_COUNT(b)); return [...f, ...f.slice().reverse()].slice(0, 28); })().forEach(([a, b], i) => { const [x, y] = p.r() < 0.5 ? [a, b] : [b, a]; add(wh[i % wh.length](x, y), "blind_tech_cmp_which", "value", `SELECT CASE WHEN ${TN("$1")} > ${TN("$2")} THEN $1 ELSE $2 END AS v`, [a, b], true); });
  // C. per-technician counts (all rows; typed counts via the service type of the same document)
  const cnt = [(t) => `how many jobs has ${t} done`, (t) => `how many visits has ${t} logged`, (t) => `${t}'s job count`, (t) => `how many calls has ${t} been out on`, (t) => `how many jobs on file for tech ${t}`];
  techs.forEach((t, i) => { for (let k = 0; k < 5; k++) add(cnt[(i + k) % cnt.length](t), "blind_tech_count", "number", `SELECT ${TN("$1")} AS n`, [t]); });
  const typed = [(t) => `how many repairs has ${t} done`, (t) => `how many PM visits has ${t} done`, (t) => `how many preventive maintenance calls has ${t} logged`, (t) => `how many repair calls has ${t} been on`];
  techs.forEach((t, i) => { const rep = i % 2 === 0; add(typed[rep ? 0 : 1](t), "blind_tech_typed_count", "number", `SELECT ${TNT("$1", rep ? "Repair" : "Preventive Maintenance")} AS n`, [t], true); add(typed[rep ? 3 : 2](t), "blind_tech_typed_count", "number", `SELECT ${TNT("$1", rep ? "Repair" : "Preventive Maintenance")} AS n`, [t], true); add(rep ? `repair count for ${t}` : `PM count for ${t}`, "blind_tech_typed_count", "number", `SELECT ${TNT("$1", rep ? "Repair" : "Preventive Maintenance")} AS n`, [t], true); });
  // D. extremes over all rows (a tie is accepted by naming any tied winner - none for "most"; two tie for "fewest": Denise Ford / Ray Sutton)
  const top = `SELECT value AS v FROM extractions WHERE field_key='technician' GROUP BY value ORDER BY count(*) DESC LIMIT 1`;
  const low = `SELECT value AS v FROM extractions WHERE field_key='technician' GROUP BY value HAVING count(*) = (SELECT min(c) FROM (SELECT count(*) AS c FROM extractions WHERE field_key='technician' GROUP BY value) z)`;
  ["who has done the most jobs overall", "which technician has the most visits on file", "who's logged the most calls", "which tech has the highest job count"].forEach((t) => add(t, "blind_tech_most", "value", top));
  ["who has the fewest jobs on file", "which technician has logged the fewest visits", "who's done the least number of calls"].forEach((t) => add(t, "blind_tech_least", "value", low));
  // E. controls: counts/extremes the exam already answers
  add("how many technicians do we have on record", "blind_tech_control", "number", `SELECT count(DISTINCT value) AS n FROM extractions WHERE field_key='technician'`, [], false);
  add("who's our busiest technician this year", "blind_tech_control", "value", `SELECT value AS v FROM extractions t WHERE field_key='technician' AND EXISTS (SELECT 1 FROM extractions y WHERE y.document_id=t.document_id AND y.field_key='service_date' AND y.value::date >= make_date(extract(year from $1::date)::int,1,1) AND y.value::date <= $1::date) GROUP BY value ORDER BY count(DISTINCT document_id) DESC LIMIT 1`, ["@today"]);
  return out;
};
function TN_COUNT(name) { return g.extractions.filter((e) => e.field_key === "technician" && e.value === name).length; }

/* ---------------------------------------------------------------- Loop E: off-domain chatter / general knowledge / dangling follow-ups with no conversation, plus record-question controls that must still answer */
FAMILIES.off = () => {
  const p = mk(3307); const out = []; let n = 0; const cat = "blind-r32b-off";
  const add = (text, shape) => out.push(zeroConst(ID("off", ++n), cat, dress(text, p), shape));
  const trivia = ["whats the capital of australia", "who won the world series in 2016", "how tall is mount everest", "who wrote pride and prejudice", "what year did the titanic sink", "how many ounces in a pound", "who is the president of france", "what's the speed of light", "how far is the moon from earth", "what's the largest ocean", "who painted the mona lisa", "when did world war 2 end", "what is the boiling point of water in fahrenheit", "who invented the telephone", "what's the longest river in africa", "how many continents are there", "what's the population of tokyo", "who discovered penicillin", "what is the square root of 144", "how many days in a leap year", "what is the tallest mountain in north america", "who invented the lightbulb", "what is the capital of canada", "who wrote romeo and juliet", "what year did man land on the moon", "how many feet in a mile", "who painted the starry night", "what is the freezing point of water in celsius"];
  const shop = ["which laptop should i buy for school", "whats a good gift for my dad", "best pizza place near me", "recommend a good movie for tonight", "which car is more reliable, a camry or an accord", "what should i cook for dinner", "any good podcasts about history", "best way to learn guitar", "where should i go on vacation this summer", "what's a good book to read"];
  const chat = ["tell me a joke", "write me a poem about the ocean", "sing me a song", "what's your favorite color", "are you a robot", "who made you", "can you be my friend", "do you ever get tired", "how are you feeling today", "tell me something interesting", "translate good morning into spanish", "what's 15 percent of 240", "convert 5 miles to kilometers", "spell necessary for me", "give me a riddle"];
  const device = ["how do i reset my iphone", "my wifi keeps dropping what do i do", "how do i take a screenshot on a mac", "why is my laptop so slow", "how do i factory reset my android", "how do i clear my browser cache"];
  const health = ["what should i take for a headache", "how many calories in a banana", "is it ok to run every day", "how do i lose ten pounds", "why do i get hiccups"];
  const weather = ["will it rain tomorrow", "whats the weather like this weekend", "what's the temperature in new york right now"];
  [...trivia, ...shop, ...chat, ...device, ...health, ...weather].forEach((t, i) => add(t, i < trivia.length ? "blind_off_trivia" : i < trivia.length + shop.length ? "blind_off_shop" : "blind_off_chat"));
  // dangling follow-ups: no conversation, no named record -> nothing to resolve
  const dang = ["what about the one in chandler instead", "and what about the other one", "how about the second one", "same thing for the one in mesa", "ok and the warranty on that one", "what about last week instead", "and who installed it", "and what's the serial on that", "what about that one", "how about the previous one", "ok now the same for the newer unit", "and their phone number", "what about the one before that", "and for the other customer", "ok what about the second unit", "now do the one in gilbert", "same for the other one please", "and when was it last serviced", "what about the one we did yesterday", "and what's the tonnage on it"];
  dang.forEach((t) => add(t, "blind_dangling"));
  // controls: real record questions in the same conversational dress (must keep answering)
  const ctl = (text, sql, cmp, params = []) => out.push({ id: ID("off", ++n), text: dress(text, p), category: cat, shape: "blind_off_control", cmp, oracle: { sql, params }, citationRequired: true });
  for (const b of ["Trane", "Carrier", "Goodman", "Lennox", "Rheem", "York", "Daikin", "Mitsubishi"]) ctl(`how many ${b} units do we have`, `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE $1`, "number", [b]);
  for (const c of p.shuffle(person).slice(0, 8)) ctl(`what's the phone number for ${c.customer_name}`, CUST_ONE("phone"), "value", [`%${c.customer_name}%`]);
  return out;
};

/* Loop E hold-out (off2): fresh off-domain / dangling phrasings written after loop E's rules were tuned on `off`. */
FAMILIES.off2 = () => {
  const p = mk(3308); const out = []; let n = 0; const cat = "blind-r32b-off2";
  const add = (text, shape) => out.push(zeroConst(ID("off2", ++n), cat, dress(text, p), shape));
  ["what's the deepest lake in the world", "who composed the four seasons", "what year did the berlin wall fall", "how many inches in a yard", "who invented the airplane", "what is 25 percent of 80", "what's the capital of brazil", "who painted the last supper", "how many minutes in a day", "who wrote the great gatsby", "convert 10 pounds to kilograms", "what is the square root of 81", "how tall is the eiffel tower", "what's the currency of japan", "who discovered america", "when did the civil war end"].forEach((t) => add(t, "blind2_off_trivia"));
  ["which phone should i buy this year", "which truck is better, a silverado or an f-150", "where should we go for our anniversary", "what's a good show to binge", "what's a good gift for my wife", "best way to study for an exam", "tell me something funny", "write a haiku about summer", "give me a fun fact", "can you write me a story about a dragon"].forEach((t) => add(t, "blind2_off_advice"));
  ["how do i factory reset my ipad", "why is my internet so slow", "my printer is not working", "how do i clear my cookies", "my laptop won't turn on", "how do i restart my router"].forEach((t) => add(t, "blind2_off_device"));
  ["how many calories in an avocado", "what should i take for a cold", "is it healthy to skip breakfast", "why do i get headaches in the afternoon"].forEach((t) => add(t, "blind2_off_health"));
  ["what's the weather in denver tomorrow", "temperature in los angeles today", "weather for chicago this weekend"].forEach((t) => add(t, "blind2_off_weather"));
  ["what about the one in tempe", "and what about the older unit", "now the same for the one in scottsdale", "how about the third one", "ok what about next month instead", "and the tonnage on that", "what about the first one again", "ok now the one in gilbert", "same for the other customer", "and the phone for them", "what about the unit in mesa", "ok and when was that one serviced", "how about the other account", "and who was the tech on it", "what about the newer one"].forEach((t) => add(t, "blind2_dangling"));
  const ctl = (text, sql, cmp, params = []) => out.push({ id: ID("off2", ++n), text: dress(text, p), category: cat, shape: "blind2_off_control", cmp, oracle: { sql, params }, citationRequired: true });
  for (const b of ["Trane", "Carrier", "Goodman", "Lennox", "Rheem", "York", "Daikin", "Mitsubishi"]) ctl(`how many ${b} systems are on file`, `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE $1`, "number", [b]);
  for (const c of p.shuffle(person).slice(0, 6)) ctl(`email for ${c.customer_name}`, CUST_ONE("email"), "value", [`%${c.customer_name}%`]);
  return out;
};

const OUT = path.join(ROOT, "test-docs/scorecard/blind");
fs.mkdirSync(OUT, { recursive: true });
const want = process.argv.slice(2);
for (const name of Object.keys(FAMILIES)) {
  if (want.length && !want.includes(name)) continue;
  const qs = FAMILIES[name]();
  fs.writeFileSync(path.join(OUT, `r32b-${name}.json`), JSON.stringify({ version: "r32b-blind-1", category: `blind-r32b-${name}`, source: "scripts/gen-blind-r32b.mjs (seeded, frozen before the loop that targets it)", questions: qs }, null, 1));
  console.log(name, qs.length);
}
