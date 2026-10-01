#!/usr/bin/env node
/**
 * R32 (Team A) BLIND sets — one FRESH set per coverage-loop family, written and frozen BEFORE the loop that targets it.
 * Same conventions as gen-blind-r31.mjs (seeded, oracle SQL against the golden tenant, graded with the production comparators by
 * scripts/run-exam-subset.mjs --no-base --blind <file>). Golden tenant is the oracle; nothing here is copied from exam.json wording.
 *   node scripts/gen-blind-r32.mjs [family ...]     # default: every family present in this file
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
const ID = (fam, n) => `bl-r32-${fam}-${String(n).padStart(3, "0")}`;
const FAMILIES = {};

/* ---------------------------------------------------------------- Loop 1: declines (off-domain / untracked field / dangling follow-up) + negative controls */
FAMILIES.decline = () => {
  const p = mk(3201); const out = []; let n = 0; const cat = "blind-r32-decline";
  const add = (text, shape, sql) => out.push(zeroConst(ID("decline", ++n), cat, dress(text, p), shape, sql));
  const offDomain = [
    "is it hot out today", "whats the temperature outside", "do i need an umbrella", "will it storm tonight", "how windy is it right now", "whats it looking like weather wise",
    "got any good jokes", "make me laugh", "tell me something funny", "do you know any riddles", "hum me a tune", "can you rap", "whats your favorite song",
    "where can i grab lunch", "any good taco spots around here", "best coffee near the shop", "find me a gas station", "where is the nearest hardware store", "whats a good place for breakfast", "is there a subway near me",
    "set an alarm for 7", "text my wife im running late", "call my brother", "add milk to my shopping list", "turn on the lights", "open spotify", "play the radio", "wake me up at six",
    "who was the first man on the moon", "how many states are in the us", "whats the square root of 144", "how many days until christmas", "why is the sky blue", "how does a rainbow form", "who is the best quarterback ever", "what year was the iphone released",
    "how are you today", "whats your name", "are you a person", "do you like your job", "who made you", "are you married",
    "what's the lottery number", "how do i change my wifi settings", "whats my horoscope", "should i buy a truck or a van", "who's going to win the election", "do you dream",
    "give me a riddle", "how do you say thank you in german",
  ];
  for (const q of offDomain) add(q, "blind_off_domain");
  const targets = [];
  for (const c of p.shuffle(person).slice(0, 40)) targets.push({ name: c.customer_name, addr: streetOf(c.service_address) });
  const untracked = [
    (t) => `what brand is the thermostat at ${t.name}'s place`, (t) => `whats the filter size on ${t.name}'s unit`, (t) => `where is the condenser sitting at ${t.addr}`, (t) => `what refrigerant line length does ${t.name}'s system have`,
    (t) => `duct static pressure for the unit at ${t.addr}`, (t) => `what gauge wire runs to ${t.name}'s condenser`, (t) => `what color is the unit at ${t.addr}`, (t) => `how loud is ${t.name}'s furnace`,
    (t) => `whats the blower motor hp on the unit at ${t.addr}`, (t) => `what is the seer on ${t.name}'s system`, (t) => `what's the btu output at ${t.addr}`, (t) => `who financed ${t.name}'s system`,
    (t) => `what size capacitor is in ${t.name}'s condenser`, (t) => `what is the coil type at ${t.addr}`, (t) => `what breaker feeds the unit at ${t.addr}`, (t) => `whats the thermostat model at ${t.addr}`,
  ];
  for (let i = 0; i < 36; i++) add(untracked[i % untracked.length](targets[i]), "blind_untracked_field");
  const dangling = [
    "and what was the serial number again", "same question but for last month", "what about the other one", "and her husbands account", "put me through to whoever handled it", "make that the other address instead",
    "and the phone number for that one", "what about the second one on the list", "and when was that", "same thing for the previous customer", "can you check the other unit too", "and whats the total for that",
    "how about the one before that", "who did that one again", "and what was it for", "now the same for last year", "does that one have a warranty", "what was the last one you showed me",
    "ok and the tech who went out there", "give me that same info for the next one", "and the address for him", "so who went out", "that same report but monthly", "what did she say about it",
    "and the model", "how much was it", "is it still under warranty", "and the email for that account", "when did they last call", "what about their other unit",
  ];
  for (const q of dangling) add(q, "blind_dangling_followup");
  // negative controls (must still be answered from records; graded on the real value)
  const ctl = p.shuffle(person).slice(0, 24);
  const ctlCores = [["whats the phone number for", "phone"], ["email on file for", "email"], ["service address for", "service_address"], ["give me the address for", "service_address"]];
  ctl.forEach((c, i) => { const [pre, col] = ctlCores[i % ctlCores.length]; out.push(valueQ(ID("decline", ++n), cat, dress(`${pre} ${c.customer_name}`, p), col, c.customer_name, "blind_decline_control")); });
  return out;
};

/* ---------------------------------------------------------------- Loop 1 HOLD-OUT: decline2 — written AFTER loop 1 was implemented, different lexicon/wording, never tuned against. */
FAMILIES.decline2 = () => {
  const p = mk(3211); const out = []; let n = 0; const cat = "blind-r32-decline2";
  const add = (text, shape) => out.push(zeroConst(ID("decline2", ++n), cat, dress(text, p), shape));
  const off = ["is it raining", "any storms coming this week", "how cold does it get tonight", "whats 45 divided by 9", "translate hello to japanese", "who directed titanic", "give me a pickup line", "whats a good name for a boat", "any good bars nearby", "where can i get a burrito", "call my mom", "text my brother that im late", "set a timer for ten minutes", "remind me to pick up the kids", "play some jazz", "whats the tallest mountain in the world", "who is the ceo of apple", "whats the best laptop right now", "how many ounces in a cup", "how do i make guacamole", "wheres the nearest urgent care", "whats on tv tonight", "whos playing at the stadium this weekend", "tell me a fun story", "whats your favorite movie", "do you have feelings", "what do you eat", "are you smart", "whats the exchange rate for pesos", "how long is a marathon", "what are good gifts for a 5 year old", "where should i take my wife for dinner", "who won the game last night", "give me a joke about plumbers", "what should i name my puppy", "whats the phone number for pizza hut", "how many people are on earth", "when does the sun set today", "is the freeway backed up", "will it snow in flagstaff", "how many calories in a burrito", "sing happy birthday", "whats the meaning of your name", "do you get tired", "recommend me a show to watch", "how do i download an app on my phone", "who plays the joker", "write a limerick about ducks", "what day is halloween on", "any tips for a first date"];
  for (const q of off) add(q, "blind2_off_domain");
  const t = p.shuffle(person).slice(0, 36).map((c) => ({ name: c.customer_name, addr: streetOf(c.service_address) }));
  const unt = [(x) => `what brand of contactor is in the condenser at ${x.addr}`, (x) => `how many amps does ${x.name}'s compressor draw`, (x) => `whats the wire size feeding ${x.name}'s unit`, (x) => `what type of coil is in ${x.name}'s air handler`, (x) => `what voltage is the disconnect at ${x.addr}`, (x) => `how long is the lineset at ${x.addr}`, (x) => `whats the blower speed setting on ${x.name}'s furnace`, (x) => `what is the static pressure at ${x.addr}`, (x) => `does ${x.name}'s unit have a humidifier`, (x) => `what model is the thermostat on ${x.name}'s system`, (x) => `is there a surge protector on the unit at ${x.addr}`, (x) => `whats the condenser fan motor size at ${x.addr}`];
  t.forEach((x, i) => add(unt[i % unt.length](x), "blind2_untracked"));
  const dang = ["what about that customers other unit", "and what about last time", "same as before", "ok now do it for march", "can you tell me more about that", "whos that again", "and their number", "what was the name again", "give me the rest of that list", "show me more like that", "and the one after", "okay and how much did that cost", "wait which one was that", "and the second unit", "what was the date on it", "who signed off on it", "did they pay for it", "is she still a customer", "does he have anything open", "and the invoice for that job", "when was the last time we saw them", "ok and what did the tech say", "and how about the rest of them", "how old is it", "who handled that call", "was it a repair", "and the customer on that one"];
  for (const q of dang) add(q, "blind2_dangling");
  // controls: org-named customers (names contain lexicon-ish words) + tech counts + person contacts — must still be answered from records
  const orgs = customers.filter((c) => !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.customer_name));
  orgs.forEach((c, i) => { out.push(valueQ(ID("decline2", ++n), cat, dress(i % 2 ? `whats the phone number for ${c.customer_name}` : `what address do we have for ${c.customer_name}`, p), i % 2 ? "phone" : "service_address", c.customer_name, "blind2_control_org")); });
  techs.slice(0, 12).forEach((t2) => out.push({ id: ID("decline2", ++n), text: dress(`how many calls has ${t2} run`, p), category: cat, shape: "blind2_control_tech", cmp: "number", oracle: { sql: `SELECT count(*) AS n FROM extractions WHERE field_key='technician' AND value='${t2}'`, params: [] }, citationRequired: true }));
  p.shuffle(person).slice(0, 14).forEach((c, i) => out.push(valueQ(ID("decline2", ++n), cat, dress(i % 2 ? `phone for ${c.customer_name}` : `${c.customer_name} email`, p), i % 2 ? "phone" : "email", c.customer_name, "blind2_control_person")));
  return out;
};

/* ---------------------------------------------------------------- Loop 1 UNSEEN: decline3 — written after decline2 was tuned; different wording again, run ONCE for the "unseen" number. */
FAMILIES.decline3 = () => {
  const p = mk(3221); const out = []; let n = 0; const cat = "blind-r32-decline3";
  const add = (text, shape) => out.push(zeroConst(ID("decline3", ++n), cat, dress(text, p), shape));
  const off = ["is it going to be windy tomorrow", "how hot is it in phoenix right now", "got a good dad joke", "what rhymes with orange", "who won the nba finals", "whats the best burger in town", "where is the closest taco truck", "i need a ride to the airport", "turn the music up", "whats the wifi password here", "who is the governor of arizona", "how many legs does a spider have", "whats the distance to the moon", "explain how airplanes fly", "why do cats purr", "whats the population of mesa", "what should i cook tonight", "is the mall open today", "what time does the bank close", "how do i get to the nearest hospital", "help me pick a birthday present for my dad", "what is a good workout for my back", "who is the fastest man alive", "whats 18 times 22", "read me the news", "tell me about yourself", "are you always this quiet", "whats your favorite food", "can you cook", "do you have a girlfriend", "what happened in the game last night", "should i bet on the fight", "whats the latest iphone", "how do i unlock my phone", "how do i cancel my netflix", "when is the next full moon", "who was the first president", "how big is texas", "what rhymes with cat", "tell me a scary story", "any decent podcasts about history", "which is better, ford or chevy", "recommend a hiking trail", "what is a good haircut for me", "how do i get a tan", "book me a table for four", "whats the best sushi place", "translate thank you into italian", "how do you spell necessary", "what does yolo mean"];
  for (const q of off) add(q, "blind3_off_domain");
  const t = p.shuffle(person).slice(0, 30).map((c) => ({ name: c.customer_name, addr: streetOf(c.service_address) }));
  const unt = [(x) => `what kind of thermostat does ${x.name} have`, (x) => `what horsepower is the blower motor at ${x.addr}`, (x) => `how many feet of line set at ${x.addr}`, (x) => `what size breaker is on ${x.name}'s condenser`, (x) => `what is the wire gauge to the unit at ${x.addr}`, (x) => `what kind of capacitor is in ${x.name}'s outdoor unit`, (x) => `what brand filter is in ${x.name}'s furnace`, (x) => `is there a humidifier on ${x.name}'s system`, (x) => `what is the static pressure reading on ${x.name}'s unit`, (x) => `what color is ${x.name}'s condenser`];
  t.forEach((x, i) => add(unt[i % unt.length](x), "blind3_untracked"));
  const dang = ["and how about their address", "what did he say about it", "ok and the one before that", "whos the tech on that", "and how old is that one", "is that one under warranty", "show me the invoice for it", "and the other customer", "what was the total on that", "so when did that happen", "and where is it", "and who else was there", "how many were there", "give me their details", "which one was the last one", "and who did the work", "how much did they pay", "repeat that", "go back to the previous one", "the same for him"];
  for (const q of dang) add(q, "blind3_dangling");
  p.shuffle(person).slice(0, 20).forEach((c, i) => out.push(valueQ(ID("decline3", ++n), cat, dress([`address for ${c.customer_name}`, `${c.customer_name} phone`, `email for ${c.customer_name}`, `where does ${c.customer_name} live`][i % 4], p), ["service_address", "phone", "email", "service_address"][i % 4], c.customer_name, "blind3_control")));
  return out;
};

/* ---------------------------------------------------------------- Loop 2: unit attributes by address (synonyms, spoken numbers, phonetic brands, multi-tenant addresses) */
const DW = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const spoken = (a) => a.replace(/^(\d+)/, (m) => m.split("").map((d) => DW[+d]).join(" "));
const DIRW = { N: "north", S: "south", E: "east", W: "west" };
const longDir = (a) => a.replace(/^(\S+) ([NSEW]) /, (m, n, d) => `${n} ${DIRW[d]} `).replace(/\bRd\b/, "road").replace(/\bSt\b/, "street").replace(/\bDr\b/, "drive").replace(/\bBlvd\b/, "boulevard").replace(/\bAve\b/, "avenue");
FAMILIES.unit = () => {
  const p = mk(3202); const out = []; let n = 0; const cat = "blind-r32-unit";
  const addrCount = new Map(); for (const c of customers) addrCount.set(streetOf(c.service_address), (addrCount.get(streetOf(c.service_address)) ?? 0) + 1);
  const singles = p.shuffle(uniq.filter((c) => addrCount.get(streetOf(c.service_address)) === 1 && (byCust.get(c.id) ?? []).length === 1));
  const CTE = (expr) => `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)\nSELECT ${expr} AS v FROM entities e\nWHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)\n  AND (SELECT count(*) FROM m) = 1 AND ${expr} IS NOT NULL AND ${expr} <> ''`;
  const REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`;
  const unitU = (c) => byCust.get(c.id)[0];
  const add = (c, text, shape, expr, addrForm) => { const a = streetOf(c.service_address); out.push({ id: ID("unit", ++n), text: dress(text, p), category: cat, shape, cmp: "value", oracle: { sql: CTE(expr), params: [`${a}%`], requires: { sql: REQ, params: [`${a}%`] } }, citationRequired: true }); };
  const mfr = [(a) => `whos the mfr at ${a}`, (a) => `what make is the system at ${a}`, (a) => `who manufactured the unit at ${a}`, (a) => `unit maker at ${a}`, (a) => `mfr on file for ${a}`, (a) => `which company made the equipment at ${a}`];
  const model = [(a) => `what model is at ${a}`, (a) => `model number of the system at ${a}`, (a) => `model # for ${a}`, (a) => `whats the model on the unit at ${a}`];
  const serial = [(a) => `serial for the unit at ${a}`, (a) => `whats the s/n at ${a}`, (a) => `serial number on file for ${a}`, (a) => `get me the serial at ${a}`];
  const tons = [(a) => `what size is the system at ${a}`, (a) => `how many tons is the unit at ${a}`, (a) => `tonnage for ${a}`, (a) => `whats the capacity of the unit at ${a}`, (a) => `what size unit do they have at ${a}`];
  const cov = [(a) => `when does coverage run out at ${a}`, (a) => `warranty end date for ${a}`, (a) => `when does the warranty lapse at ${a}`, (a) => `coverage expiration on file for ${a}`, (a) => `when is coverage up at ${a}`, (a) => `when does the unit at ${a} stop being covered`, (a) => `whens the warranty over at ${a}`];
  const ins = [(a) => `install date for the unit at ${a}`, (a) => `when was the system at ${a} put in`, (a) => `date the unit at ${a} was installed`];
  const specs = [["mfr", mfr, "e.data->>'manufacturer'"], ["model", model, "e.data->>'model'"], ["serial", serial, "e.data->>'serial_number'"], ["tons", tons, "e.data->>'tonnage'"], ["cov", cov, "e.data#>>'{warranty,expires}'"], ["ins", ins, "e.data->>'installation_date'"]];
  let k = 0;
  for (const c of singles.slice(0, 66)) { const [nm, arr, expr] = specs[k++ % specs.length]; if (nm === "tons" && !unitU(c).tonnage) { k++; continue; } if (nm === "cov" && !unitU(c).warranty?.expires) { k++; continue; } add(c, p.pick(arr)(streetOf(c.service_address)), `blind_unit_${nm}`, expr); }
  // spoken-number addresses with plain field asks
  const sp = [(a) => `im at ${a}, whats the manufacturer`, (a) => `need the serial for the unit at ${a}`, (a) => `whats the model at ${a}`, (a) => `tonnage of the system at ${a}`];
  singles.slice(66, 92).forEach((c, i) => { const a = spoken(longDir(streetOf(c.service_address))); const [t, expr] = [["manufacturer", "e.data->>'manufacturer'"], ["serial", "e.data->>'serial_number'"], ["model", "e.data->>'model'"], ["tonnage", "e.data->>'tonnage'"]][i % 4]; if (t === "tonnage" && !unitU(c).tonnage) return; add(c, sp[i % 4](a), `blind_unit_spoken_${t}`, expr); });
  // phonetic brand yes/no with spoken or plain address
  const phon = { Trane: ["train", "trane"], Carrier: ["carry her", "carrier"], Rheem: ["room", "rheem"], Lennox: ["lenox", "lennox"] };
  singles.slice(92, 130).forEach((c, i) => {
    const u = unitU(c); const a = streetOf(c.service_address); const brands = Object.keys(phon); const b = brands[i % brands.length]; const say = phon[b][i % 2]; const useSpoken = i % 3 === 0;
    const addr = useSpoken ? spoken(longDir(a)) : a;
    const text = [`is that a ${say} unit out at ${addr}`, `is the system at ${addr} a ${say}`, `so is it a ${say} at ${addr}`][i % 3];
    out.push({ id: ID("unit", ++n), text: dress(text, p), category: cat, shape: "blind_unit_brand_yesno", cmp: "yesno", oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)\nSELECT (e.data->>'manufacturer' ILIKE '${b}') AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1`, params: [`${a}%`], requires: { sql: REQ, params: [`${a}%`] } }, citationRequired: true });
  });
  // shared address (apartment complex): several customers/units -> no single value exists -> honest, never a guess
  const shared = customers.map((c) => streetOf(c.service_address)).filter((a, i, arr) => arr.filter((x) => x === a).length > 1);
  const sharedAddr = [...new Set(shared)];
  const SHARE = `SELECT (CASE WHEN (SELECT count(*) FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE $1) = 1 THEN 1 ELSE 0 END) AS n`;
  const shCores = [(a) => `whats the model on the unit at ${a}`, (a) => `who makes the system at ${a}`, (a) => `serial for ${a}`, (a) => `when does coverage run out at ${a}`, (a) => `what size is the unit at ${a}`, (a) => `is the unit at ${a} still under warranty`, (a) => `warranty status for ${a}`, (a) => `manufacturer at ${a}`];
  for (let i = 0; i < 16; i++) { const a = sharedAddr[i % sharedAddr.length]; out.push({ id: ID("unit", ++n), text: dress(shCores[i % shCores.length](a), p), category: cat, shape: "blind_unit_shared_address", cmp: "honest-zero", oracle: { sql: SHARE, params: [`${a}%`] } }); }
  // not on file: synonym-worded asks at addresses no customer has
  const real = new Set(customers.map((c) => streetOf(c.service_address).toLowerCase()));
  const fake = []; for (const c of p.shuffle(customers)) { const m = streetOf(c.service_address).match(/^(\d+)(.*)$/); if (!m) continue; const cand = `${Number(m[1]) + 13}${m[2]}`; if (!real.has(cand.toLowerCase()) && !fake.includes(cand)) fake.push(cand); if (fake.length >= 16) break; }
  const fk = [(a) => `whos the mfr at ${a}`, (a) => `when does coverage run out at ${a}`, (a) => `what size is the system at ${a}`, (a) => `is that a train unit out at ${a}`];
  fake.forEach((a, i) => out.push({ id: ID("unit", ++n), text: dress(fk[i % fk.length](a), p), category: cat, shape: "blind_unit_fake_address", cmp: "honest-zero", oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, params: [`${a}%`] } }));
  return out;
};

/* ---------------------------------------------------------------- Loop 2 UNSEEN: unit2 — different wordings, written after loop 2 was tuned; run once for the unseen number. */
FAMILIES.unit2 = () => {
  const p = mk(3212); const out = []; let n = 0; const cat = "blind-r32-unit2";
  const addrCount = new Map(); for (const c of customers) addrCount.set(streetOf(c.service_address), (addrCount.get(streetOf(c.service_address)) ?? 0) + 1);
  const singles = p.shuffle(uniq.filter((c) => addrCount.get(streetOf(c.service_address)) === 1 && (byCust.get(c.id) ?? []).length === 1));
  const CTE = (expr) => `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)\nSELECT ${expr} AS v FROM entities e\nWHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)\n  AND (SELECT count(*) FROM m) = 1 AND ${expr} IS NOT NULL AND ${expr} <> ''`;
  const REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`;
  const unitU = (c) => byCust.get(c.id)[0];
  const spec = {
    mfr: [["who built the equipment at", "who is the mfg at", "brand name on the outdoor unit at", "who is the maker of the system at", "what company manufactures the unit at"], "e.data->>'manufacturer'"],
    tons: [["how big is the system at", "what capacity is the unit at", "unit size at", "how many tons of cooling at"], "e.data->>'tonnage'"],
    cov: [["when does the warranty finish at", "is coverage expiring at", "warranty runs until when at", "end of coverage for", "date the warranty ends at"], "e.data#>>'{warranty,expires}'"],
    ins: [["when did they put the system in at", "when was the equipment set at", "what date was the unit installed at"], "e.data->>'installation_date'"],
    ser: [["serial no. for the unit at", "what is the serial tag at", "unit serial at"], "e.data->>'serial_number'"],
    mod: [["model no. for the unit at", "which model is the system at", "unit model at"], "e.data->>'model'"],
  };
  const keys = Object.keys(spec); let k = 0;
  for (const c of singles.slice(0, 72)) {
    const key = keys[k++ % keys.length]; const u = unitU(c);
    if ((key === "tons" && !u.tonnage) || (key === "cov" && !u.warranty?.expires)) continue;
    const a = streetOf(c.service_address); const phr = p.pick(spec[key][0]); const long = k % 5 === 0; const addr = long ? spoken(longDir(a)) : a;
    out.push({ id: ID("unit2", ++n), text: dress(`${phr} ${addr}`, p), category: cat, shape: `blind2_unit_${key}`, cmp: "value", oracle: { sql: CTE(spec[key][1]), params: [`${a}%`], requires: { sql: REQ, params: [`${a}%`] } }, citationRequired: true });
  }
  const phon = { Trane: ["trayne", "trane"], Carrier: ["carrier", "carriers"], Goodman: ["good man", "goodman"], Daikin: ["dykin", "daikin"] };
  singles.slice(72, 100).forEach((c, i) => {
    const a = streetOf(c.service_address); const bs = Object.keys(phon); const b = bs[i % bs.length]; const say = phon[b][i % 2];
    out.push({ id: ID("unit2", ++n), text: dress([`is the equipment at ${a} a ${say}`, `${a} - is that a ${say} system`, `would that be a ${say} unit at ${a}`][i % 3], p), category: cat, shape: "blind2_unit_brand_yesno", cmp: "yesno", oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)\nSELECT (e.data->>'manufacturer' ILIKE '${b}') AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1`, params: [`${a}%`], requires: { sql: REQ, params: [`${a}%`] } }, citationRequired: true });
  });
  const real = new Set(customers.map((c) => streetOf(c.service_address).toLowerCase()));
  const fake = []; for (const c of p.shuffle(customers)) { const m = streetOf(c.service_address).match(/^(\d+)(.*)$/); if (!m) continue; const cand = `${Number(m[1]) + 17}${m[2]}`; if (!real.has(cand.toLowerCase()) && !fake.includes(cand)) fake.push(cand); if (fake.length >= 14) break; }
  fake.forEach((a, i) => out.push({ id: ID("unit2", ++n), text: dress([`who built the equipment at ${a}`, `end of coverage for ${a}`, `how big is the system at ${a}`, `is the equipment at ${a} a trayne`][i % 4], p), category: cat, shape: "blind2_unit_fake", cmp: "honest-zero", oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, params: [`${a}%`] } }));
  return out;
};

/* ---------------------------------------------------------------- Loop 3: windowed activity / existence / totals / comparisons */
FAMILIES.window = () => {
  const p = mk(3203); const out = []; let n = 0; const cat = "blind-r32-window";
  const T = "@today";
  const SD = "x.field_key='service_date' AND x.value IS NOT NULL AND x.value ~ '^\\d{4}-\\d{2}-\\d{2}'";
  const wins = [
    { id: "d30", phr: ["in the last 30 days", "over the past 30 days", "in the past month"], cond: `x.value::date >= ($1::date - interval '30 days') AND x.value::date <= $1::date` },
    { id: "d60", phr: ["in the last 60 days", "over the past 60 days", "in the last two months"], cond: `x.value::date >= ($1::date - interval '60 days') AND x.value::date <= $1::date` },
    { id: "d90", phr: ["in the last 90 days", "over the past 90 days", "in the last three months"], cond: `x.value::date >= ($1::date - interval '90 days') AND x.value::date <= $1::date` },
    { id: "d7", phr: ["in the past week", "over the last 7 days", "in the last week"], cond: `x.value::date >= ($1::date - interval '7 days') AND x.value::date <= $1::date` },
    { id: "d180", phr: ["in the last 180 days", "over the past six months", "in the last half year"], cond: `x.value::date >= ($1::date - interval '180 days') AND x.value::date <= $1::date` },
    { id: "m0", phr: ["this month", "so far this month"], cond: `date_trunc('month', x.value::date) = date_trunc('month', $1::date)` },
    { id: "m1", phr: ["last month"], cond: `date_trunc('month', x.value::date) = date_trunc('month', $1::date - interval '1 month')` },
    { id: "y0", phr: ["this year", "so far this year", "year to date"], cond: `extract(year from x.value::date) = extract(year from $1::date)` },
    { id: "y1", phr: ["last year"], cond: `extract(year from x.value::date) = extract(year from $1::date) - 1` },
  ];
  const noun = ["service calls", "service visits", "jobs", "visits", "service calls", "service visits"]; // "tickets"/"work orders" are DOCUMENT types in this engine (adjudicated), not visits
  const typeNoun = { Repair: ["repair calls", "repair visits", "repair jobs"], "Preventive Maintenance": ["maintenance visits", "PM visits", "preventive maintenance calls"] };
  const cntSql = (w, ty) => `SELECT count(*) AS n FROM extractions x WHERE ${SD} AND ${w.cond}${ty ? ` AND EXISTS (SELECT 1 FROM extractions t WHERE t.document_id=x.document_id AND t.field_key='service_type' AND t.value='${ty}')` : ""}`;
  const exSql = (w, ty, addr) => `SELECT EXISTS (SELECT 1 FROM extractions x WHERE ${SD} AND ${w.cond}${ty ? ` AND EXISTS (SELECT 1 FROM extractions t WHERE t.document_id=x.document_id AND t.field_key='service_type' AND t.value='${ty}')` : ""}${addr ? ` AND x.document_id IN (SELECT l.document_id FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.entity_type='customer' AND c.data->>'service_address' ILIKE '${addr}%')` : ""}) AS v`;
  const add = (text, shape, cmp, sql, params) => out.push({ id: ID("window", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params }, citationRequired: true });
  // A. counts
  wins.forEach((w, i) => { for (let r = 0; r < 2; r++) { const nn = noun[(i * 2 + r) % noun.length]; const ph = p.pick(w.phr); add(p.pick([`how many ${nn} ${ph}`, `count of ${nn} ${ph}`, `number of ${nn} ${ph}`, `${nn} ${ph}, how many`]), "blind_window_count", "number", cntSql(w), [T]); } });
  // A2. typed counts
  for (const [ty, arr] of Object.entries(typeNoun)) wins.slice(0, 6).forEach((w) => { const ph = p.pick(w.phr); add(`how many ${p.pick(arr)} ${ph}`, "blind_window_count_typed", "number", cntSql(w, ty), [T]); });
  // B. existence (yes/no; no address)
  wins.forEach((w, i) => { for (let r = 0; r < 3; r++) { const nn = noun[(i + r) % noun.length]; const ph = p.pick(w.phr); add(p.pick([`any ${nn} ${ph}`, `did we do any ${nn} ${ph}`, `have we had any ${nn} ${ph}`, `has there been any work ${ph}`, `was there any activity ${ph}`]), "blind_window_exists", "yesno", exSql(w), [T]); } });
  for (const [ty, arr] of Object.entries(typeNoun)) wins.slice(0, 5).forEach((w) => { const ph = p.pick(w.phr); add(p.pick([`have we had any ${p.pick(arr)} ${ph}`, `any ${p.pick(arr)} ${ph}`, `did we do any ${p.pick(arr)} ${ph}`]), "blind_window_exists_typed", "yesno", exSql(w, ty), [T]); });
  // B2. existence at an address (single-customer addresses)
  const addrCount = new Map(); for (const c of customers) addrCount.set(streetOf(c.service_address), (addrCount.get(streetOf(c.service_address)) ?? 0) + 1);
  p.shuffle(uniq.filter((c) => addrCount.get(streetOf(c.service_address)) === 1)).slice(0, 16).forEach((c, i) => { const w = wins[[2, 4, 7, 8][i % 4]]; const a = streetOf(c.service_address); add(p.pick([`did we do any work at ${a} ${p.pick(w.phr)}`, `any service calls at ${a} ${p.pick(w.phr)}`, `have we been out to ${a} ${p.pick(w.phr)}`]), "blind_window_exists_addr", "yesno", exSql(w, null, a), [T]); });
  // C. totals by type
  const tot = (ty) => `SELECT count(*) AS n FROM extractions WHERE field_key='service_type' AND value='${ty}'`;
  for (let i = 0; i < 16; i++) { const ty = i % 2 ? "Repair" : "Preventive Maintenance"; const pick = ty === "Repair" ? [`how many repair visits are on file`, `total repair calls we have logged`, `repair visit count`, `how many repairs have we done overall`, `number of repair jobs on record`] : [`how many maintenance visits are on file`, `total PM visits we have logged`, `preventive maintenance visit count`, `how many PMs have we done overall`, `number of preventive maintenance jobs on record`]; add(p.pick(pick), "blind_window_type_total", "number", tot(ty), []); }
  // D. comparisons
  const cmpQ = [["do we do more repairs than preventive maintenance", "Repair", "Preventive Maintenance"], ["are repair visits more common than PM visits", "Repair", "Preventive Maintenance"], ["do we have fewer PM visits than repair visits", "Preventive Maintenance", "Repair", "<"], ["is preventive maintenance a bigger share of our work than repair", "Preventive Maintenance", "Repair"], ["have we logged more repair calls than maintenance calls", "Repair", "Preventive Maintenance"], ["is repair work bigger than maintenance work for us", "Repair", "Preventive Maintenance"]];
  cmpQ.forEach(([q, a, b, op]) => add(q, "blind_window_type_compare", "yesno", `SELECT (SELECT count(*) FROM extractions WHERE field_key='service_type' AND value='${a}') ${op ?? ">"} (SELECT count(*) FROM extractions WHERE field_key='service_type' AND value='${b}') AS v`, []));
  // E. technician totals (number)
  const tc = (t) => `SELECT count(*) AS n FROM extractions WHERE field_key='technician' AND value='${t}'`; // record-count convention (field-phrasing k133); the "in total" phrasing is the dated-document count (breadth-tech-performance)
  const techQ = [(t) => `how many service calls has ${t} been out on, total`, (t) => `how many visits has ${t} been on altogether`, (t) => `total number of calls ${t} has gone out on`, (t) => `how many times has ${t} been dispatched in all`, (t) => `${t} - lifetime service calls`];
  techs.slice(0, 15).forEach((t, i) => add(techQ[i % techQ.length](t), "blind_window_tech_total", "number", tc(t), []));
  // G. units per customer (orgs + people)
  const uc = (nm) => `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%${nm}%'`;
  const unitQ = [(nm) => `how many units total does ${nm} have`, (nm) => `how many pieces of equipment are on file for ${nm}`, (nm) => `unit count for ${nm}`, (nm) => `how many systems does ${nm} have on file`];
  customers.filter((c) => !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.customer_name)).forEach((c, i) => add(unitQ[i % unitQ.length](c.customer_name), "blind_window_units_customer", "number", uc(c.customer_name), []));
  p.shuffle(uniq).slice(0, 8).forEach((c, i) => add(unitQ[i % unitQ.length](c.customer_name), "blind_window_units_customer", "number", uc(c.customer_name), []));
  // H. warranty counts
  const wSql = (op) => `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date ${op} $1::date`;
  ["how many units are out of warranty right now", "count of units whose warranty has expired", "how many units are past their warranty", "number of units not currently covered by warranty"].forEach((q) => add(q, "blind_window_warranty_count", "number", wSql("<="), [T]));
  // (the future-side "still under warranty" count is NOT asserted: counts-warranty-0004 freezes "still/under warranty" to the strict >365-day 'active' bucket)
  // I. top zip / city
  const ZIPQ = `SELECT substring(data->>'service_address' from '(\\d{5})$') AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`;
  ["which zip code do we have the most customers in", "what zip has the most customers", "top zip code by number of customers", "most common zip code among our customers"].forEach((q) => add(q, "blind_window_top_zip", "value", ZIPQ, []));
  // K. year revenue comparisons
  const rev = (y) => `(SELECT coalesce(sum(total),0) FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND extract(year from invoice_date)=${y})`;
  [[2021, 2025], [2019, 2023], [2024, 2022], [2018, 2020], [2025, 2024], [2011, 2016]].forEach(([a, b], i) => add([`was our invoiced revenue higher in ${a} than in ${b}`, `did we invoice more in ${a} than ${b}`, `is ${a} invoiced revenue bigger than ${b}`][i % 3], "blind_window_year_compare", "yesno", `SELECT ${rev(a)} > ${rev(b)} AS v`, []));
  return out;
};

/* ---------------------------------------------------------------- Loop 4: account / name lookups (bare-surname ambiguity, techs at a place, last visit at an address) */
FAMILIES.acct = () => {
  const p = mk(3204); const out = []; let n = 0; const cat = "blind-r32-acct";
  const push = (text, shape, cmp, sql, params = [], extra = {}) => out.push({ id: ID("acct", ++n), text: dress(text, p), category: cat, shape, cmp, oracle: { sql, params }, citationRequired: true, ...extra });
  // A. bare surname shared by 2+ customers -> the honest "which one?" list must name every candidate
  const bySur = new Map();
  for (const c of person) { const s = surname(c); if (!bySur.has(s)) bySur.set(s, []); bySur.get(s).push(c.customer_name); }
  const shared = [...bySur.entries()].filter(([, a]) => a.length >= 2).map(([s]) => s).sort();
  const NAMES = `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ~* ('\\m' || $1 || '$')`;
  const amb = [(s) => `serial on ${s}'s unit`, (s) => `what do we have on file for the ${s} account`, (s) => `pull the file on ${s}`, (s) => `anything scheduled for the ${s} account`,
    (s) => `what brand is the ${s} unit`, (s) => `who normally handles the ${s} account`, (s) => `whens the ${s} warranty up`, (s) => `whats the model on ${s}'s system`, (s) => `show me everything for ${s}`, (s) => `does ${s} have a maintenance agreement`];
  p.shuffle(shared).slice(0, 34).forEach((s, i) => push(amb[i % amb.length](s.toLowerCase()), "blind_ambiguous_surname", "set", NAMES, [s]));
  // B. which techs have been out to a named customer's place (set of technicians on their dated service documents)
  const TECHS = `SELECT DISTINCT t.value AS item FROM extractions t JOIN document_entity_links l ON l.document_id=t.document_id JOIN entities c ON c.id=l.entity_id AND c.entity_type='customer' JOIN extractions y ON y.document_id=t.document_id AND y.field_key='service_date' WHERE t.field_key='technician' AND c.data->>'customer_name' = $1`;
  const techQ = [(nm) => `who's been out to ${nm}'s place`, (nm) => `which techs have been to ${nm}`, (nm) => `who has serviced ${nm}'s equipment`, (nm) => `list the technicians who visited ${nm}`, (nm) => `what techs have worked on ${nm}'s account`];
  const withTech = p.shuffle(person).filter((c) => g.extractions.some((e) => e.field_key === "technician")).slice(0, 60);
  let added = 0;
  for (const c of withTech) { if (added >= 34) break; push(techQ[added % techQ.length](c.customer_name), "blind_techs_at_customer", "set", TECHS, [c.customer_name]); added++; }
  // C. last visit at a street address: who / what for (unique-address customers)
  const LAST = (col) => `SELECT t.value AS v FROM extractions y JOIN extractions t ON t.document_id=y.document_id AND t.field_key='${col}' JOIN document_entity_links l ON l.document_id=y.document_id JOIN entities c ON c.id=l.entity_id AND c.entity_type='customer' WHERE y.field_key='service_date' AND c.data->>'service_address' ILIKE $1 ORDER BY y.value DESC LIMIT 1`;
  const addrOnce = uniq.filter((c) => uniq.filter((d) => streetOf(d.service_address) === streetOf(c.service_address)).length === 1);
  const lastWho = [(a) => `who was the last tech at ${a}`, (a) => `who went out to ${a} most recently`, (a) => `last technician to visit ${a}`, (a) => `who did the most recent visit at ${a}`];
  const lastWhat = [(a) => `what was the last visit at ${a} for`, (a) => `what type of service was the latest call at ${a}`, (a) => `last service type at ${a}`];
  p.shuffle(addrOnce).slice(0, 18).forEach((c, i) => push(lastWho[i % lastWho.length](streetOf(c.service_address)), "blind_last_tech_addr", "value", LAST("technician"), [`${streetOf(c.service_address)}%`]));
  p.shuffle(addrOnce).slice(18, 34).forEach((c, i) => push(lastWhat[i % lastWhat.length](streetOf(c.service_address)), "blind_last_type_addr", "value", LAST("service_type"), [`${streetOf(c.service_address)}%`]));
  return out;
};

const OUT = path.join(ROOT, "test-docs/scorecard/blind");
fs.mkdirSync(OUT, { recursive: true });
const want = process.argv.slice(2);
for (const name of Object.keys(FAMILIES)) {
  if (want.length && !want.includes(name)) continue;
  const qs = FAMILIES[name]();
  fs.writeFileSync(path.join(OUT, `r32-${name}.json`), JSON.stringify({ version: "r32-blind-1", category: `blind-r32-${name}`, source: "scripts/gen-blind-r32.mjs (seeded, frozen before the loop that targets it)", questions: qs }, null, 1));
  console.log(name, qs.length);
}
