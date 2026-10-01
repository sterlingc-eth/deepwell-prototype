#!/usr/bin/env node
/**
 * R31 (Team A) BLIND generalization sets — written BEFORE the loop that targets each family and frozen.
 * Deterministic (seeded) generator over the golden tenant export; oracle SQL in the exact style of
 * test-docs/scorecard/exam.json so scripts/run-blind-r31.mjs can grade with the production comparators.
 * Stored under test-docs/scorecard/blind/ (NOT generalization/, so they never enter the canonical exam
 * count or the verify-golden known-wrong set).
 *
 *   node scripts/gen-blind-r31.mjs           # regenerates all four (identical output every run)
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
const cities = [...new Set(customers.map((c) => cityOf(c.service_address)))].filter(Boolean).sort();

const CUST_ONE = (col) => `SELECT data->>'${col}' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
const CUST_REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
const valueQ = (id, cat, text, col, name, shape) => ({ id, text, category: cat, shape, cmp: "value", oracle: { sql: CUST_ONE(col), params: [`%${name}%`], requires: { sql: CUST_REQ, params: [`%${name}%`] } }, citationRequired: true });
const ADDR_MATCH = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`;
const zeroAddr = (id, cat, text, addr, shape = "blind_fake_address") => ({ id, text, category: cat, shape, cmp: "honest-zero", oracle: { sql: ADDR_MATCH, params: [`${addr}%`] } });
const zeroConst = (id, cat, text, shape, sql = "SELECT 0 AS n") => ({ id, text, category: cat, shape, cmp: "honest-zero", oracle: { sql, params: [] } });


/* R32 (owner decision 2026-09-30): an UNAMBIGUOUS typo'd full name now resolves, with a visible "Showing results for <name>" note.
 * Independent re-statement of the policy for the oracle (no import from api/): exactly one customer within per-word
 * Damerau-Levenshtein <= 2 (<= 1 when a word is under 6 letters), total <= 2, full name <= 2, and no OTHER customer name within 3.
 * `typoTarget(t)` = that customer's name, or null (then the only correct answer is the honest "Did you mean" decline). */
function dl(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 0; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) { d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); } return d[a.length][b.length]; }
function typoTarget(t) {
  const tt = t.toLowerCase().split(/\s+/); if (tt.length < 2 || tt.length > 3) return null;
  const hits = [];
  for (const c of customers) {
    const ct = c.customer_name.toLowerCase().split(/\s+/); if (ct.length !== tt.length) continue;
    let total = 0, ok = true;
    for (let i = 0; i < tt.length; i++) { if (tt[i] === ct[i]) continue; const lim = Math.min(tt[i].length, ct[i].length) < 6 ? 1 : 2; if (tt[i].length <= 2 || ct[i].length <= 2) { ok = false; break; } const d = dl(tt[i], ct[i]); if (d > lim) { ok = false; break; } total += d; }
    if (ok && total >= 1 && total <= 2 && dl(t.toLowerCase(), c.customer_name.toLowerCase()) <= 2) hits.push(c.customer_name);
  }
  const uniqHits = [...new Set(hits)]; if (uniqHits.length !== 1) return null;
  const tgt = uniqHits[0].toLowerCase();
  if (customers.some((c) => c.customer_name.toLowerCase() !== tgt && dl(t.toLowerCase(), c.customer_name.toLowerCase()) <= 3)) return null;
  return uniqHits[0];
}

const LEAD = ["", "", "", "so uh, ", "hey, ", "quick one - ", "ok so ", "hmm, ", "yo ", "hold up, ", "one sec, ", "umm ", "real quick: ", "alright, ", "gimme a sec, ", "can you look up ", "could you tell me ", "quick q - ", "ok um, ", "hang on... ", "sorry, one more - ", "customer is on the line, ", "im in the truck, "];
const TAIL = ["", "", "", "", " again", " please", " thanks", " real quick", " for me", " asap", " right now", " if you have it", " when you get a sec"];
const dress = (s, p) => { const l = p.pick(LEAD); let t = p.pick(TAIL); return (l + s + t).replace(/\s+/g, " ").trim(); };
const ID = (fam, n) => `bl-r31-${fam}-${String(n).padStart(3, "0")}`;

/* ---------------------------------------------------------------- F1: conversational contact / compound */
function f1() {
  const p = mk(3101); const out = []; let n = 0; const cat = "blind-r31-contact";
  const phoneCores = [(x) => `whats ${x}'s phone number`, (x) => `phone number for ${x}`, (x) => `${x} phone number`, (x) => `number for ${x}`, (x) => `whats the number for ${x}`, (x) => `what number do we have for ${x}`, (x) => `${x}'s cell`, (x) => `contact number for ${x}`, (x) => `gimme ${x}'s number`, (x) => `whats the phone on file for ${x}`, (x) => `what's ${x}'s contact number`, (x) => `how do I reach ${x}`];
  const emailCores = [(x) => `whats ${x}'s email`, (x) => `email for ${x}`, (x) => `${x} email address`, (x) => `what email do we have for ${x}`, (x) => `${x}'s email address on file`];
  const addrCores = [(x) => `whats the address for ${x}`, (x) => `service address for ${x}`, (x) => `${x}'s address`, (x) => `where is ${x}'s unit`, (x) => `whats ${x}'s service address`, (x) => `wheres ${x}'s unit located`, (x) => `what address do we have for ${x}`, (x) => `address on file for ${x}`];
  const people = p.shuffle(uniq);
  for (let i = 0; i < 44; i++) { const c = people[i % people.length]; out.push(valueQ(ID("contact", ++n), cat, dress(p.pick(phoneCores)(c.customer_name), p), "phone", c.customer_name, "blind_phone")); }
  for (let i = 0; i < 22; i++) { const c = people[(i + 40) % people.length]; out.push(valueQ(ID("contact", ++n), cat, dress(p.pick(emailCores)(c.customer_name), p), "email", c.customer_name, "blind_email")); }
  for (let i = 0; i < 34; i++) { const c = people[(i + 70) % people.length]; out.push(valueQ(ID("contact", ++n), cat, dress(p.pick(addrCores)(c.customer_name), p), "service_address", c.customer_name, "blind_address")); }
  // serial/model by name (single-unit customers only)
  const single = p.shuffle(uniq.filter((c) => (byCust.get(c.id) ?? []).length === 1));
  const EQ = (col) => `SELECT e.data->>'${col}' AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
  const serialCores = [(x) => `serial number for ${x}'s unit`, (x) => `whats the serial on ${x}'s system`, (x) => `${x} unit serial`, (x) => `serial on file for ${x}`];
  const modelCores = [(x) => `model number for ${x}'s unit`, (x) => `whats the model on ${x}'s system`, (x) => `${x} unit model`, (x) => `what model does ${x} have`];
  for (let i = 0; i < 14; i++) { const c = single[i]; const isS = i % 2 === 0; out.push({ id: ID("contact", ++n), text: dress((isS ? p.pick(serialCores) : p.pick(modelCores))(c.customer_name), p), category: cat, shape: isS ? "blind_serial" : "blind_model", cmp: "value", oracle: { sql: EQ(isS ? "serial_number" : "model"), params: [`%${c.customer_name}%`], requires: { sql: CUST_REQ, params: [`%${c.customer_name}%`] } }, citationRequired: true }); }
  // name + phone by address (compound) — addresses with exactly one customer
  const addrCount = new Map(); for (const c of customers) addrCount.set(streetOf(c.service_address), (addrCount.get(streetOf(c.service_address)) ?? 0) + 1);
  const oneAddr = p.shuffle(uniq.filter((c) => addrCount.get(streetOf(c.service_address)) === 1));
  const NP = `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1\nUNION ALL\nSELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`;
  const npCores = [(a) => `name and phone for ${a}`, (a) => `customer name and number for ${a}`, (a) => `whos at ${a} and whats their phone`, (a) => `the customers name and phone number at ${a}`, (a) => `name plus number for ${a}`, (a) => `who lives at ${a}, and their number`, (a) => `whats the contact name and phone for ${a}`];
  for (let i = 0; i < 16; i++) { const c = oneAddr[i]; out.push({ id: ID("contact", ++n), text: dress(p.pick(npCores)(streetOf(c.service_address)), p), category: cat, shape: "blind_name_phone_addr", cmp: "set", oracle: { sql: NP, params: [`${streetOf(c.service_address)}%`] }, citationRequired: true }); }
  return out;
}

/* ---------------------------------------------------------------- F2: address-anchored (existing + not-on-file) */
function f2() {
  const p = mk(3102); const out = []; let n = 0; const cat = "blind-r31-address";
  const real = new Set(customers.map((c) => streetOf(c.service_address).toLowerCase()));
  const fake = [];
  for (const c of p.shuffle(customers)) { const s = streetOf(c.service_address); const m = s.match(/^(\d+)(.*)$/); if (!m) continue; for (const d of [1, -1, 3, 7, 11]) { const num = Number(m[1]) + d; const cand = `${num}${m[2]}`; if (num > 0 && !real.has(cand.toLowerCase()) && !fake.includes(cand)) { fake.push(cand); break; } } if (fake.length >= 125) break; }
  const cores = [(a) => `whats the model number for the unit at ${a}`, (a) => `serial number for ${a}`, (a) => `whos the customer at ${a}`, (a) => `whats on file for ${a}`, (a) => `who installed the unit at ${a}`, (a) => `warranty status for the unit at ${a}`, (a) => `whats the phone number for ${a}`, (a) => `when was the system at ${a} installed`, (a) => `who was the last tech out to ${a}`, (a) => `tonnage of the unit at ${a}`, (a) => `is the unit at ${a} still under warranty`, (a) => `what brand is the unit at ${a}`, (a) => `when is the next maintenance due at ${a}`, (a) => `who owns the place at ${a}`, (a) => `refrigerant type at ${a}`, (a) => `last service date for ${a}`, (a) => `name on the account at ${a}`, (a) => `pull up ${a}`, (a) => `any documents for ${a}`, (a) => `how old is the unit at ${a}`];
  for (let i = 0; i < 118 && i < fake.length; i++) { const a = fake[i]; out.push(zeroAddr(ID("address", ++n), cat, dress(p.pick(cores)(a), p), a)); }
  // existing single-customer addresses: who is the customer / phone / model / manufacturer
  const addrCount = new Map(); for (const c of customers) addrCount.set(streetOf(c.service_address), (addrCount.get(streetOf(c.service_address)) ?? 0) + 1);
  const oneAddr = p.shuffle(uniq.filter((c) => addrCount.get(streetOf(c.service_address)) === 1 && (byCust.get(c.id) ?? []).length === 1));
  const CTE = (col) => `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)\nSELECT e.data->>'${col}' AS v FROM entities e\nWHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)\n  AND (SELECT count(*) FROM m) = 1 AND coalesce(e.data->>'${col}', '') <> ''`;
  const REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`;
  for (let i = 0; i < 12; i++) { const c = oneAddr[i]; const a = streetOf(c.service_address); const k = i % 4; const spec = [["whos the customer at", "customer_name", true], ["phone number for", "phone", true], ["what brand is the unit at", "manufacturer", false], ["model number for the unit at", "model", false]][k]; out.push({ id: ID("address", ++n), text: dress(`${spec[0]} ${a}`, p), category: cat, shape: "blind_addr_existing", cmp: "value", oracle: { sql: spec[2] ? `SELECT data->>'${spec[1]}' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1` : CTE(spec[1]), params: [`${a}%`], requires: { sql: REQ, params: [`${a}%`] } }, citationRequired: true }); }
  // comparison of two addresses / near-miss must NOT be claimed as honest-zero when one exists -> excluded (needs model)
  return out;
}

/* ---------------------------------------------------------------- F3: technician job counts */
function f3() {
  const p = mk(3103); const out = []; let n = 0; const cat = "blind-r31-technician";
  const TC = (t) => `SELECT count(*) AS n FROM extractions WHERE field_key='technician' AND value='${t}'`;
  const totalCores = [(t) => `how many jobs has ${t} done`, (t) => `${t}'s total jobs`, (t) => `job count for ${t}`, (t) => `how many calls has ${t} run`, (t) => `how many visits has ${t} logged in total`, (t) => `number of jobs ${t} has done overall`, (t) => `whats ${t}'s job total`, (t) => `how many service calls has ${t} been on`];
  for (let i = 0; i < 42; i++) { const t = techs[i % techs.length]; out.push({ id: ID("technician", ++n), text: dress(p.pick(totalCores)(t), p), category: cat, shape: "blind_tech_total", cmp: "number", oracle: { sql: TC(t), params: [] }, citationRequired: true }); }
  const cityCores = [(t, c) => `how many jobs has ${t} done in ${c}`, (t, c) => `${t}'s jobs in ${c}`, (t, c) => `how many calls did ${t} run in ${c}`, (t, c) => `count of ${t} visits in ${c}`, (t, c) => `number of ${c} jobs for ${t}`];
  for (let i = 0; i < 48; i++) { const t = techs[i % techs.length]; const c = cities[(i * 5 + 1) % cities.length]; out.push({ id: ID("technician", ++n), text: dress(p.pick(cityCores)(t, c), p), category: cat, shape: "blind_tech_city", cmp: "number", oracle: { sql: `SELECT count(*) AS n FROM extractions t JOIN documents d ON d.id=t.document_id JOIN document_entity_links l ON l.document_id=d.id\nJOIN entities c ON c.id=l.entity_id AND c.entity_type='customer'\nWHERE t.field_key='technician' AND t.value='${t}' AND c.data->>'service_address' ILIKE '%, ${c},%'`, params: [] }, citationRequired: true }); }
  const EX = (t, ty) => `SELECT EXISTS (SELECT 1 FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='${ty}' WHERE t.field_key='technician' AND t.value='${t}') AS v`;
  const everCores = [(t, w) => `has ${t} ever done a ${w} visit`, (t, w) => `did ${t} ever do ${w} work`, (t, w) => `has ${t} logged any ${w} calls`, (t, w) => `is there a ${w} visit by ${t}`];
  for (let i = 0; i < 16; i++) { const t = techs[i % techs.length]; const rep = i % 2 === 0; out.push({ id: ID("technician", ++n), text: dress(p.pick(everCores)(t, rep ? "repair" : "preventive maintenance"), p), category: cat, shape: "blind_tech_ever", cmp: "yesno", oracle: { sql: EX(t, rep ? "Repair" : "Preventive Maintenance"), params: [] }, citationRequired: true }); }
  const CMP = (a, b) => `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${a}') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${b}') AS v`;
  const cmpCores = [(a, b) => `has ${a} done more jobs than ${b}`, (a, b) => `does ${a} have more calls than ${b}`, (a, b) => `is ${a} busier than ${b}`, (a, b) => `has ${a} logged more visits than ${b}`];
  for (let i = 0; i < 16; i++) { const a = techs[i % techs.length]; const b = techs[(i + 2) % techs.length]; out.push({ id: ID("technician", ++n), text: dress(p.pick(cmpCores)(a, b), p), category: cat, shape: "blind_tech_compare", cmp: "yesno", oracle: { sql: CMP(a, b), params: [] }, citationRequired: true }); }
  const sumCores = [(x, y) => `combined job total for ${x} and ${y}`, (x, y) => `how many jobs have ${x} and ${y} done together`, (x, y) => `${x} plus ${y}, total jobs`];
  for (let i = 0; i < 12; i++) {
    const a = techs[i % techs.length]; const b = techs[(i + 1 + (i % 3)) % techs.length]; if (a === b) continue;
    out.push({ id: ID("technician", ++n), text: dress(p.pick(sumCores)(a, b), p), category: cat, shape: "blind_tech_sum", cmp: "number", oracle: { sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${a}') + (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${b}') AS n`, params: [] }, citationRequired: true });
  }
  const thrCores = [(k) => `does every tech have at least ${k} jobs logged`, (k) => `has each technician done ${k}+ jobs`, (k) => `is every technician at or above ${k} jobs`];
  for (const thr of [40, 50, 55, 56, 58, 60, 45, 57]) {
    out.push({ id: ID("technician", ++n), text: dress(p.pick(thrCores)(thr), p), category: cat, shape: "blind_tech_threshold", cmp: "yesno", oracle: { sql: `SELECT NOT EXISTS (SELECT value FROM extractions WHERE field_key='technician' GROUP BY value HAVING count(*) < ${thr}) AS v`, params: [] }, citationRequired: true });
  }
  return out;
}

/* ---------------------------------------------------------------- F4: future dates, off-topic, near-miss names */
function f4() {
  const p = mk(3104); const out = []; let n = 0; const cat = "blind-r31-honest";
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const FUT = (y) => `SELECT ((SELECT count(*) FROM extractions WHERE value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND value::date > '${y}-01-01'::date) + (SELECT count(*) FROM document_financials WHERE invoice_date > '${y}-01-01'::date)) AS n`;
  const nouns = ["an invoice issued", "a permit filed", "a warranty registered", "a service call logged", "a work order dated", "an install completed", "a maintenance visit done", "a quote sent", "a purchase order placed", "a startup sheet filed"];
  for (let i = 0; i < 52; i++) { const y = 2028 + (i % 6); const m = months[(i * 5) % 12]; const noun = nouns[i % nouns.length]; const forms = [`was there ${noun} in ${m} ${y}`, `do we have ${noun} for ${m} ${y}`, `anything on file from ${m} ${y}`, `what work did we do in ${m} ${y}`, `how many jobs did we finish in ${y}`, `any paperwork dated ${m} ${1 + (i % 27)}, ${y}`]; out.push(zeroConst(ID("honest", ++n), cat, dress(p.pick(forms), p), "blind_future_date", FUT(2027))); }
  const off = ["whats the weather going to be like tomorrow", "who won the world series last year", "tell me a joke", "write me a poem about air filters", "whats the capital of France", "how tall is mount everest", "can you book me a flight to denver", "whats a good recipe for chili", "who is the president", "translate good morning to spanish", "what time is it in tokyo", "how do i reset my email password", "whats the best pizza in mesa", "play some music", "how many ounces in a pound", "remind me to call my mom", "what is the meaning of life", "tell me about the roman empire", "whats bitcoin trading at", "who is taylor swift dating", "what should i have for lunch", "can you order me a coffee", "how do i lose ten pounds", "sing me a song", "whats the score of the suns game", "what movies are out this weekend", "is it going to rain today", "how far is the moon", "what is 15 percent of 240", "give me a fun fact about dolphins", "write a haiku about summer", "whats your favorite color", "are you a robot", "how do i tie a tie", "recommend a good book"];
  for (const q of off.slice(0, 32)) out.push(zeroConst(ID("honest", ++n), cat, dress(q, p), "blind_off_topic"));
  const typoOf = (nm) => { const [f, l] = nm.split(" "); const opts = [`${f.slice(0, -1)} ${l}`, `${f} ${l.slice(0, 2)}${l.slice(3)}`, `${f[0]}${f[1] === f[1] ? f[1] : ""}${f.slice(1)} ${l}`, `${f} ${l}s`, `${f.slice(0, 1)}${f.slice(2)} ${l}`]; return p.pick(opts); };
  const typoCores = [(x) => `whats the phone number for ${x}`, (x) => `pull up the file for ${x}`, (x) => `${x} email`, (x) => `whats the address for ${x}`, (x) => `is ${x} still under warranty`, (x) => `serial number for ${x}'s unit`];
  const nameSet = new Set(customers.map((c) => c.customer_name.toLowerCase()));
  let made = 0; for (const c of p.shuffle(person)) { if (made >= 36) break; const t = typoOf(c.customer_name); if (nameSet.has(t.toLowerCase()) || t.toLowerCase() === c.customer_name.toLowerCase()) continue; const sameSur = customers.filter((x) => x.customer_name.split(" ")[1] === c.customer_name.split(" ")[1]).length; if (customers.some((x) => x.customer_name.toLowerCase().includes(t.toLowerCase()))) continue; made++; out.push({ id: ID("honest", ++n), text: dress(p.pick(typoCores)(t), p), category: cat, shape: "blind_near_miss_name", cmp: "honest-zero", ...(typoTarget(t) ? { typoResolvesTo: typoTarget(t) } : {}), oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [`%${t}%`] } }); }
  return out;
}


/* ---------------------------------------------------------------- F1b: FRESH contact set (v2), independent lexicon, seed 4101.
 * Written AFTER loop 1 was implemented against set 1, from a deliberately different frame/core vocabulary, to measure real
 * generalization (set 1's failures were looked at while tuning; nothing here was seen before it was frozen). */
function f1b() {
  const p = mk(4101); const out = []; let n = 0; const cat = "blind-r31-contact2";
  const LEAD2 = ["", "", "ah right, ", "sorry to bug you, ", "question - ", "so like, ", "okay so ", "thing is, ", "wait, ", "actually, ", "any chance you can tell me ", "i forgot, ", "ok last one: ", "dispatch wants to know ", "boss asked me, ", "erm ", "right, ", "mm ", "hi there, ", "good morning, "];
  const TAIL2 = ["", "", "", " thx", " pls", " ok?", " if thats ok", " cheers", " whenever", " lol", " today", " for the file", " sir", " buddy"];
  const dr = (s) => (p.pick(LEAD2) + s + p.pick(TAIL2)).replace(/\s+/g, " ").trim();
  const phone = [(x) => `whats the best number for ${x}`, (x) => `phone # for ${x}`, (x) => `ph number ${x}`, (x) => `${x}'s mobile`, (x) => `${x} - phone?`, (x) => `what number should I call for ${x}`, (x) => `${x}'s telephone number`, (x) => `give me ${x}'s phone number`, (x) => `${x} contact phone`, (x) => `${x} cell number`];
  const email = [(x) => `email ${x}`, (x) => `${x} - email?`, (x) => `mail address for ${x}`, (x) => `${x}'s e-mail`, (x) => `what email address do we have for ${x}`, (x) => `give me ${x}'s email`];
  const addr = [(x) => `where does ${x}'s system sit`, (x) => `which address is ${x} at`, (x) => `${x} location`, (x) => `what is ${x}'s service address`, (x) => `${x} - address?`, (x) => `where is the ${x} job`, (x) => `give me the address for ${x}`, (x) => `where do we go for ${x}`];
  const people = p.shuffle(uniq);
  for (let i = 0; i < 44; i++) { const c = people[i % people.length]; out.push(valueQ(ID("contact2", ++n), cat, dr(p.pick(phone)(c.customer_name)), "phone", c.customer_name, "blind2_phone")); }
  for (let i = 0; i < 26; i++) { const c = people[(i + 30) % people.length]; out.push(valueQ(ID("contact2", ++n), cat, dr(p.pick(email)(c.customer_name)), "email", c.customer_name, "blind2_email")); }
  for (let i = 0; i < 40; i++) { const c = people[(i + 60) % people.length]; out.push(valueQ(ID("contact2", ++n), cat, dr(p.pick(addr)(c.customer_name)), "service_address", c.customer_name, "blind2_address")); }
  const addrCount = new Map(); for (const c of customers) addrCount.set(streetOf(c.service_address), (addrCount.get(streetOf(c.service_address)) ?? 0) + 1);
  const oneAddr = p.shuffle(uniq.filter((c) => addrCount.get(streetOf(c.service_address)) === 1));
  const NP = `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1\nUNION ALL\nSELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`;
  const np = [(a) => `who is the customer at ${a} and what is their phone number`, (a) => `customer + phone for ${a}`, (a) => `who do I ask for at ${a}, and their number`, (a) => `name and telephone for ${a}`, (a) => `whose place is ${a} and how do I reach them`, (a) => `the account at ${a}: name and phone`];
  for (let i = 0; i < 14; i++) { const c = oneAddr[i]; out.push({ id: ID("contact2", ++n), text: dr(p.pick(np)(streetOf(c.service_address))), category: cat, shape: "blind2_name_phone_addr", cmp: "set", oracle: { sql: NP, params: [`${streetOf(c.service_address)}%`] }, citationRequired: true }); }
  return out;
}

/* ---------------------------------------------------------------- F3b: technician job counts, FRESH wordings (seed 3203; written after loop 3 was tuned on set 1) */
function f3b() {
  const p = mk(3203); const out = []; let n = 0; const cat = "blind-r31-technician2";
  const T = (t) => `(SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${t}')`;
  const add = (text, shape, cmp, sql) => out.push({ id: ID("technician2", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params: [] }, citationRequired: true });
  const totalCores = [(t) => `tally of jobs for ${t}`, (t) => `${t} - jobs completed so far`, (t) => `what is ${t}'s call count`, (t) => `total number of visits ${t} has made`, (t) => `how many jobs is ${t} at`, (t) => `${t} jobs total`, (t) => `give me ${t}'s number of service calls`, (t) => `how many jobs on file for ${t}`];
  for (let i = 0; i < 32; i++) { const t = techs[(i * 5) % techs.length]; add(p.pick(totalCores)(t), "blind2_tech_total", "number", `SELECT ${T(t)} AS n`); }
  const cityCores = [(t, c) => `${t}'s job count in ${c}`, (t, c) => `how many of ${t}'s jobs were in ${c}`, (t, c) => `${t} visits in ${c} only`, (t, c) => `jobs ${t} did in ${c}`, (t, c) => `${c} service calls handled by ${t}`, (t, c) => `what is the number of jobs for ${t} in ${c}`];
  for (let i = 0; i < 36; i++) { const t = techs[(i * 3 + 1) % techs.length]; const c = cities[(i * 7 + 2) % cities.length]; add(p.pick(cityCores)(t, c), "blind2_tech_city", "number", `SELECT count(*) AS n FROM extractions t JOIN documents d ON d.id=t.document_id JOIN document_entity_links l ON l.document_id=d.id\nJOIN entities c ON c.id=l.entity_id AND c.entity_type='customer'\nWHERE t.field_key='technician' AND t.value='${t}' AND c.data->>'service_address' ILIKE '%, ${c},%'`); }
  const EX = (t, ty) => `SELECT EXISTS (SELECT 1 FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='${ty}' WHERE t.field_key='technician' AND t.value='${t}') AS v`;
  const everCores = [(t, w) => `has ${t} handled any ${w} jobs`, (t, w) => `${t} done any ${w} visits`, (t, w) => `does ${t} have a ${w} call on record`, (t, w) => `did ${t} ever log ${w} work`];
  for (let i = 0; i < 18; i++) { const t = techs[(i * 5 + 2) % techs.length]; const rep = i % 3 !== 0; add(p.pick(everCores)(t, rep ? "repair" : "preventive maintenance"), "blind2_tech_ever", "yesno", EX(t, rep ? "Repair" : "Preventive Maintenance")); }
  const cmpCores = [(a, b) => [`does ${b} have fewer jobs than ${a}`, `SELECT ${T(b)} < ${T(a)} AS v`], (a, b) => [`is ${a} ahead of ${b} in job count`, `SELECT ${T(a)} > ${T(b)} AS v`], (a, b) => [`has ${b} logged fewer calls than ${a}`, `SELECT ${T(b)} < ${T(a)} AS v`], (a, b) => [`does ${a} have a higher job count than ${b}`, `SELECT ${T(a)} > ${T(b)} AS v`], (a, b) => [`has ${a} done less work than ${b}`, `SELECT ${T(a)} < ${T(b)} AS v`]];
  for (let i = 0; i < 20; i++) { const a = techs[i % techs.length]; const b = techs[(i + 3) % techs.length]; const [q, sql] = p.pick(cmpCores)(a, b); add(q, "blind2_tech_compare", "yesno", sql); }
  const sumCores = [(x, y) => `${x} and ${y}, how many jobs combined`, (x, y) => `total of ${x}'s and ${y}'s jobs`, (x, y) => `${x} plus ${y} together, how many calls`];
  for (let i = 0; i < 14; i++) { const a = techs[i % techs.length]; const b = techs[(i + 2) % techs.length]; add(p.pick(sumCores)(a, b), "blind2_tech_sum", "number", `SELECT ${T(a)} + ${T(b)} AS n`); }
  const thrCores = [(k) => `does every technician have ${k} or more jobs`, (k) => `has every tech logged at least ${k} calls`, (k) => `are all technicians above ${k}+ jobs`];
  for (const thr of [30, 52, 55, 56, 59, 20, 54, 58]) add(p.pick(thrCores)(thr), "blind2_tech_threshold", "yesno", `SELECT NOT EXISTS (SELECT value FROM extractions WHERE field_key='technician' GROUP BY value HAVING count(*) < ${thr}) AS v`);
  // unsupported-by-design shapes: must never be WRONG (null -> model is fine)
  const anyBelow = [(k) => `is any technician under ${k} jobs`, (k) => `does anyone have fewer than ${k} jobs`];
  for (const thr of [50, 56, 58]) add(p.pick(anyBelow)(thr), "blind2_tech_anybelow", "yesno", `SELECT EXISTS (SELECT value FROM extractions WHERE field_key='technician' GROUP BY value HAVING count(*) < ${thr}) AS v`);
  return out;
}

/* ---------------------------------------------------------------- F4b: honest / off-topic / near-miss, FRESH wordings (seed 3204; written after loop 4 was tuned on set 1) */
function f4b() {
  const p = mk(3204); const out = []; let n = 0; const cat = "blind-r31-honest2";
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const FUT = `SELECT ((SELECT count(*) FROM extractions WHERE value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND value::date > '2027-01-01'::date) + (SELECT count(*) FROM document_financials WHERE invoice_date > '2027-01-01'::date)) AS n`;
  const fut = [(m, y, d) => `did we do any jobs in ${m} ${y}`, (m, y) => `show me the invoices from ${y}`, (m, y) => `were any permits pulled in ${m} ${y}`, (m, y) => `how many service calls were completed in ${y}`, (m, y, d) => `list work orders dated ${m} ${d}, ${y}`, (m, y) => `what got installed in ${y}`, (m, y) => `any startup sheets for ${m} ${y}`, (m, y) => `what maintenance visits happened in ${m} ${y}`, (m, y) => `which quotes went out in ${y}`];
  for (let i = 0; i < 40; i++) { const y = 2028 + ((i * 7) % 8); out.push(zeroConst(ID("honest2", ++n), cat, dress(p.pick(fut)(months[(i * 7 + 3) % 12], y, 1 + (i % 27)), p), "blind2_future_date", FUT)); }
  const off = ["whats the tallest building in dubai", "how do i change a tire", "who invented the telephone", "whats the exchange rate for euros", "recommend a good podcast", "how many calories in an apple", "what is the speed of light", "when is thanksgiving this year", "how do i make pancakes", "who wrote hamlet", "explain photosynthesis to me", "give me a workout plan", "how deep is the ocean", "whats the best phone to buy", "what year did the titanic sink", "how many people live in china", "whats a good name for a dog", "tell me a bedtime story", "who painted the mona lisa", "what is the boiling point of water in kelvin", "can you help me write a cover letter", "how do i tie a tie", "whats the largest planet", "what is the population of texas", "how do i get red wine out of carpet", "who is the richest person in the world", "how long do cats live", "what language do they speak in brazil", "how many miles in a marathon", "whats the tip on a 60 dollar dinner"];
  for (const q of off) out.push(zeroConst(ID("honest2", ++n), cat, dress(q, p), "blind2_off_topic"));
  const typoOf = (nm) => { const [f, l] = nm.split(" "); const opts = [`${f} ${l.slice(0, -1)}`, `${f.slice(0, 2)}${f.slice(3)} ${l}`, `${f} ${l[0]}${l[0]}${l.slice(1)}`, `${f}${f.slice(-1)} ${l}`, `${f} ${l.slice(0, 1)}${l.slice(2)}`]; return p.pick(opts); };
  const typoCores = [(x) => `show the file on ${x}`, (x) => `what do we have on file for ${x}`, (x) => `serial number for ${x}'s furnace`, (x) => `who is ${x}`, (x) => `${x} - address?`, (x) => `pull up ${x}`, (x) => `brand of the unit for ${x}`, (x) => `${x}'s phone`];
  const nameSet = new Set(customers.map((c) => c.customer_name.toLowerCase()));
  let made = 0; for (const c of p.shuffle(person)) { if (made >= 30) break; const t = typoOf(c.customer_name); if (nameSet.has(t.toLowerCase()) || t.toLowerCase() === c.customer_name.toLowerCase()) continue; if (customers.some((x) => x.customer_name.toLowerCase().includes(t.toLowerCase()))) continue; made++; out.push({ id: ID("honest2", ++n), text: dress(p.pick(typoCores)(t), p), category: cat, shape: "blind2_near_miss_name", cmp: "honest-zero", ...(typoTarget(t) ? { typoResolvesTo: typoTarget(t) } : {}), oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [`%${t}%`] } }); }
  return out;
}

/* ---------------------------------------------------------------- F5: FRESH mixed set (seed 3305) — written AFTER all five loops, NEVER tuned against; the "unseen" report */
function f5() {
  const p = mk(3305); const out = []; let n = 0; const cat = "blind-r31-fresh";
  const people = p.shuffle(uniq);
  const dr = (t) => dress(t, p);
  const phone = [(x) => `${x} - best callback number?`, (x) => `need to ring ${x}, what number`, (x) => `${x}: phone on the account?`, (x) => `which number do I dial for ${x}`, (x) => `${x}'s mobile please`, (x) => `what phone is listed under ${x}`];
  const email = [(x) => `where do I email ${x}`, (x) => `${x} - email on the account?`, (x) => `which email is listed for ${x}`, (x) => `${x}'s e-mail`];
  const addr = [(x) => `where does ${x} live`, (x) => `${x} - street address?`, (x) => `which address is ${x} at`, (x) => `job site address for ${x}`, (x) => `where's the ${x} place`];
  for (let i = 0; i < 30; i++) { const c = people[i]; out.push(valueQ(ID("fresh", ++n), cat, dr(p.pick(phone)(c.customer_name)), "phone", c.customer_name, "fresh_phone")); }
  for (let i = 0; i < 16; i++) { const c = people[30 + i]; out.push(valueQ(ID("fresh", ++n), cat, dr(p.pick(email)(c.customer_name)), "email", c.customer_name, "fresh_email")); }
  for (let i = 0; i < 24; i++) { const c = people[46 + i]; out.push(valueQ(ID("fresh", ++n), cat, dr(p.pick(addr)(c.customer_name)), "service_address", c.customer_name, "fresh_address")); }
  // technician (fresh wording)
  const T = (t) => `(SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${t}')`;
  const tot = [(t) => `${t} - how many jobs so far`, (t) => `how busy has ${t} been, in jobs`, (t) => `number of calls handled by ${t}`, (t) => `count ${t}'s visits`];
  for (let i = 0; i < 14; i++) { const t = techs[(i * 5 + 1) % techs.length]; out.push({ id: ID("fresh", ++n), text: dr(p.pick(tot)(t)), category: cat, shape: "fresh_tech_total", cmp: "number", oracle: { sql: `SELECT ${T(t)} AS n`, params: [] }, citationRequired: true }); }
  const cmp = [(a, b) => [`is ${a} ahead of ${b}`, `SELECT ${T(a)} > ${T(b)} AS v`], (a, b) => [`does ${b} trail ${a} in jobs`, `SELECT ${T(b)} < ${T(a)} AS v`]];
  for (let i = 0; i < 6; i++) { const a = techs[i % techs.length]; const b = techs[(i + 1) % techs.length]; const [q, sql] = p.pick(cmp)(a, b); out.push({ id: ID("fresh", ++n), text: dr(q), category: cat, shape: "fresh_tech_cmp", cmp: "yesno", oracle: { sql, params: [] }, citationRequired: true }); }
  // address anchored: real (one customer) + not on file
  const real = new Set(customers.map((c) => streetOf(c.service_address).toLowerCase()));
  const fake = [];
  for (const c of p.shuffle(customers)) { const m = streetOf(c.service_address).match(/^(\d+)(.*)$/); if (!m) continue; for (const d of [2, -2, 5, 9]) { const cand = `${Number(m[1]) + d}${m[2]}`; if (Number(m[1]) + d > 0 && !real.has(cand.toLowerCase()) && !fake.includes(cand)) { fake.push(cand); break; } } if (fake.length >= 20) break; }
  const fc = [(a) => `anything known about ${a}`, (a) => `who's the owner at ${a}`, (a) => `unit brand at ${a}`, (a) => `tonnage at ${a}?`];
  for (let i = 0; i < 16 && i < fake.length; i++) out.push(zeroAddr(ID("fresh", ++n), cat, dr(p.pick(fc)(fake[i])), fake[i], "fresh_fake_address"));
  // honest: future dates, off-topic, live status
  const FUT = `SELECT ((SELECT count(*) FROM extractions WHERE value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND value::date > '2027-01-01'::date) + (SELECT count(*) FROM document_financials WHERE invoice_date > '2027-01-01'::date)) AS n`;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const fut = [(m, y) => `were there any service tickets filed in ${m} ${y}`, (m, y) => `total jobs completed during ${y}`, (m, y) => `pull the paperwork dated ${m} ${y}`, (m, y) => `did anything get invoiced in ${m} ${y}`];
  for (let i = 0; i < 10; i++) out.push(zeroConst(ID("fresh", ++n), cat, dr(p.pick(fut)(months[(i * 5) % 12], 2028 + (i % 6))), "fresh_future", FUT));
  const off = ["whats the meaning of the word ubiquitous", "how do I center a div in css", "whats a good gift for my wife", "convert 50 fahrenheit to celsius", "who sang bohemian rhapsody", "how many teaspoons in a tablespoon", "what is the tallest tree species", "any good movies on tonight"];
  for (const q of off) out.push(zeroConst(ID("fresh", ++n), cat, dr(q), "fresh_offtopic"));
  const live = ["which of our guys is closest to Mesa right now", "who can cover the 3pm slot", "anyone able to take a walk-in today", "who's covering nights this week"];
  for (const q of live) out.push(zeroConst(ID("fresh", ++n), cat, dr(q), "fresh_live"));
  // typo'd names (must Did-you-mean, never auto-resolve to a value)
  const nameSet = new Set(customers.map((c) => c.customer_name.toLowerCase()));
  const typoOf = (nm) => { const [f, l] = nm.split(" "); return p.pick([`${f} ${l.slice(0, 1)}${l.slice(2)}`, `${f.slice(0, 2)}${f.slice(3)} ${l}`, `${f} ${l}${l.slice(-1)}`, `${f.slice(0, -1)} ${l}`]); };
  let made = 0; for (const c of p.shuffle(person)) { if (made >= 12) break; const t = typoOf(c.customer_name); if (nameSet.has(t.toLowerCase()) || customers.some((x) => x.customer_name.toLowerCase().includes(t.toLowerCase()))) continue; made++; out.push({ id: ID("fresh", ++n), text: dr(p.pick([(x) => `email for ${x}`, (x) => `${x} - what's the address`, (x) => `show me everything on ${x}`])(t)), category: cat, shape: "fresh_near_miss", cmp: "honest-zero", ...(typoTarget(t) ? { typoResolvesTo: typoTarget(t) } : {}), oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [`%${t}%`] } }); }
  return out;
}

const OUT = path.join(ROOT, "test-docs/scorecard/blind");
fs.mkdirSync(OUT, { recursive: true });
for (const [name, fn] of [["contact", f1], ["contact2", f1b], ["address", f2], ["technician", f3], ["technician2", f3b], ["honest", f4], ["honest2", f4b], ["fresh", f5]]) {
  const qs = fn();
  fs.writeFileSync(path.join(OUT, `r31-${name}.json`), JSON.stringify({ version: "r31-blind-1", category: `blind-r31-${name}`, source: "scripts/gen-blind-r31.mjs (seeded, frozen before the loop that targets it)", questions: qs }, null, 1));
  console.log(name, qs.length);
}
