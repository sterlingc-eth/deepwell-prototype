#!/usr/bin/env node
/**
 * R35 BLIND sets — written and frozen BEFORE the R35 rules (owner decisions 2026-10-01: nicknames, serial lookups,
 * "still under warranty" intent). Same conventions as gen-blind-r32b.mjs: seeded, oracle SQL against the golden tenant,
 * graded with the production comparators by `scripts/run-exam-subset.mjs --no-base --blind <file>`. The nickname map
 * below is this generator's OWN small hand list for the golden first names (independent of the engine's table).
 *   node scripts/gen-blind-r35.mjs [family ...]     # nick | serial | warr  (default: all)
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
const unitsOf = new Map(); for (const u of equipment) { if (!unitsOf.has(u.customer_id)) unitsOf.set(u.customer_id, []); unitsOf.get(u.customer_id).push(u); }
const custById = new Map(customers.map((c) => [c.id, c]));
const person = customers.filter((c) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.customer_name));
const LEAD = ["", "", "", "", "hey, ", "quick one - ", "ok so ", "real quick: ", "alright, ", "sorry, one more - ", "hang on... "];
const TAIL = ["", "", "", "", " please", " thanks", " real quick", " for me"];
const dress = (s, p) => (p.pick(LEAD) + s + p.pick(TAIL)).replace(/\s+/g, " ").trim();
const ID = (fam, n) => `bl-r35-${fam}-${String(n).padStart(3, "0")}`;
const FAMILIES = {};
const TODAY_PARAM = "@today";

const CUST_ONE = (col) => `SELECT data->>'${col}' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
const CUST_REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
const UNIT_OF_CUST = (expr) => `SELECT ${expr} AS v FROM entities e JOIN entities c ON c.id = e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
const WSTATUS = (alias) => `(CASE WHEN (${alias}.data#>>'{warranty,expires}') IS NULL OR (${alias}.data#>>'{warranty,expires}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown' WHEN substr(${alias}.data#>>'{warranty,expires}',1,10)::date < $2::date THEN 'expired' WHEN substr(${alias}.data#>>'{warranty,expires}',1,10)::date - $2::date <= 365 THEN 'expiring' ELSE 'active' END)`;
const zero = (id, cat, text, shape, sql, params = []) => ({ id, text, category: cat, shape, cmp: "honest-zero", oracle: { sql, params } });

/* golden first name -> nicknames (this generator's own list) */
const NICK = {
  Thomas: ["Tom", "Tommy"], Robert: ["Bob", "Rob", "Bobby", "Robbie"], William: ["Bill", "Will", "Billy"], James: ["Jim", "Jimmy"],
  Michael: ["Mike"], Kathleen: ["Kathy"], David: ["Dave"], Daniel: ["Dan", "Danny"], Joseph: ["Joe", "Joey"], Patricia: ["Pat", "Patty", "Trish"],
  Richard: ["Rick", "Rich", "Dick"], Edward: ["Ed", "Eddie"], Steven: ["Steve"], Anthony: ["Tony"], Susan: ["Sue", "Susie"], Donald: ["Don", "Donnie"],
  Ronald: ["Ron", "Ronnie"], Kenneth: ["Ken", "Kenny"], Timothy: ["Tim", "Timmy"], Matthew: ["Matt"], Rebecca: ["Becky", "Becca"], Deborah: ["Deb", "Debbie"],
  Barbara: ["Barb"], Cynthia: ["Cindy"], Stephanie: ["Steph"], Sandra: ["Sandy"], Jessica: ["Jess", "Jessie"], Melissa: ["Missy"], Charles: ["Chuck", "Charlie"],
  Angela: ["Angie"], Amanda: ["Mandy"], Jennifer: ["Jen"], Elizabeth: ["Liz", "Beth"],
};
const FORMAL_OF_STORED_NICK = { Betty: "Elizabeth" }; // stored nickname, typed formal (reverse direction)

/* ---------------------------------------------------------------- nicknames (>= 150) */
FAMILIES.nick = () => {
  const p = mk(3501); const out = []; let n = 0; const cat = "blind-r35-nick";
  const value = (text, col, name, shape) => out.push({ id: ID("nick", ++n), text: dress(text, p), category: cat, shape, cmp: "value", oracle: { sql: CUST_ONE(col), params: [name], requires: { sql: CUST_REQ, params: [name] } }, citationRequired: true });
  const unitValue = (text, expr, name, shape) => out.push({ id: ID("nick", ++n), text: dress(text, p), category: cat, shape, cmp: "value", oracle: { sql: UNIT_OF_CUST(expr), params: [name], requires: { sql: CUST_REQ, params: [name] } }, citationRequired: true });
  // positives: nickname + exact surname -> exactly one customer with the formal first name
  const pos = [];
  for (const c of person) {
    const [first, last] = c.customer_name.split(" ");
    for (const nick of NICK[first] ?? []) {
      const sameSurname = person.filter((o) => o.customer_name.split(" ")[1] === last);
      const matches = sameSurname.filter((o) => o.customer_name.split(" ")[0] === first);
      if (matches.length === 1 && !person.some((o) => o.customer_name === `${nick} ${last}`)) pos.push({ c, nick, last });
    }
  }
  const contact = [
    [(nm) => `phone for ${nm}`, "phone"], [(nm) => `whats ${nm}'s number`, "phone"], [(nm) => `${nm} phone number`, "phone"], [(nm) => `call ${nm} - what's the number`, "phone"],
    [(nm) => `email for ${nm}`, "email"], [(nm) => `what's the email on file for ${nm}`, "email"], [(nm) => `${nm}'s email`, "email"],
    [(nm) => `address for ${nm}`, "service_address"], [(nm) => `where does ${nm} live`, "service_address"], [(nm) => `service address on ${nm}`, "service_address"],
  ];
  const sh = p.shuffle(pos);
  sh.slice(0, 96).forEach(({ c, nick, last }, i) => {
    const [f, col] = contact[i % contact.length];
    const nm = i % 4 === 0 ? `${nick} ${last}`.toLowerCase() : `${nick} ${last}`;
    value(f(nm), col, c.customer_name, `nick_${col}`);
  });
  // unit fields for single-unit customers
  const unitQ = [
    [(nm) => `serial on ${nm}'s unit`, "e.data->>'serial_number'"], [(nm) => `what brand is ${nm}'s system`, "e.data->>'manufacturer'"],
    [(nm) => `model number for ${nm}`, "e.data->>'model'"], [(nm) => `when was ${nm}'s unit installed`, "e.data->>'installation_date'"],
    [(nm) => `is ${nm}'s unit still under warranty`, null],
  ];
  const single = sh.filter(({ c }) => (unitsOf.get(c.id) ?? []).length === 1);
  single.slice(0, 36).forEach(({ c, nick, last }, i) => {
    const [f, expr] = unitQ[i % unitQ.length];
    const nm = `${nick} ${last}`;
    if (expr) unitValue(f(nm), expr, c.customer_name, "nick_unit");
    else out.push({ id: ID("nick", ++n), text: dress(f(nm), p), category: cat, shape: "nick_warranty", cmp: "value", oracle: { sql: UNIT_OF_CUST(WSTATUS("e")).replace("AS v FROM", "AS v FROM"), params: [c.customer_name, TODAY_PARAM], requires: { sql: CUST_REQ, params: [c.customer_name] } }, citationRequired: true });
  });
  // reverse direction: formal typed, nickname stored (Elizabeth -> Betty)
  for (const c of person) {
    const [first, last] = c.customer_name.split(" ");
    const formal = FORMAL_OF_STORED_NICK[first];
    if (!formal) continue;
    value(`phone for ${formal} ${last}`, "phone", c.customer_name, "nick_reverse");
    value(`email for ${formal.toLowerCase()} ${last.toLowerCase()}`, "email", c.customer_name, "nick_reverse");
  }
  // nickname + surname typo (combined with the typo auto-resolve rules)
  const typo = (s) => s.slice(0, -2) + s.slice(-1); // drop the second-to-last letter
  sh.filter(({ last }) => last.length >= 7).slice(0, 6).forEach(({ c, nick, last }) => value(`phone for ${nick} ${typo(last)}`, "phone", c.customer_name, "nick_plus_typo"));
  // HARD NEGATIVES (must not answer for anyone): nickname + a real surname whose formal first name is not on file
  const NEG_SQL = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;
  const surnames = [...new Set(person.map((c) => c.customer_name.split(" ")[1]))];
  const negs = [];
  for (const last of surnames) {
    for (const [formal, nicks] of Object.entries(NICK)) {
      if (person.some((o) => o.customer_name === `${formal} ${last}`)) continue;
      negs.push({ formal, nick: nicks[0], last });
    }
  }
  const negQ = [(nm) => `phone for ${nm}`, (nm) => `email for ${nm}`, (nm) => `address for ${nm}`, (nm) => `serial on ${nm}'s unit`, (nm) => `when did we last service ${nm}`];
  p.shuffle(negs).slice(0, 18).forEach(({ formal, nick, last }, i) => out.push(zero(ID("nick", ++n), cat, dress(negQ[i % negQ.length](`${nick} ${last}`), p), "nick_neg_no_formal", NEG_SQL, [`${formal} ${last}`])));
  // Amy is a real first name, never a nickname of Amanda: "Amy Quinley" must not become Amanda Quinley
  out.push(zero(ID("nick", ++n), cat, "phone for Amy Quinley", "nick_neg_real_name", NEG_SQL, ["Amy Quinley"]));
  out.push(zero(ID("nick", ++n), cat, "email for amy redwine", "nick_neg_real_name", NEG_SQL, ["Amy Redwine"]));
  // technicians are not customers: a technician's (nick)name never resolves to a customer's contact details
  out.push(zero(ID("nick", ++n), cat, "phone for Dan Ochoa", "nick_neg_tech", NEG_SQL, ["%Ochoa"]));
  out.push(zero(ID("nick", ++n), cat, "email for Danny Ochoa", "nick_neg_tech", NEG_SQL, ["%Ochoa"]));
  out.push(zero(ID("nick", ++n), cat, "phone number for Ray Sutton", "nick_neg_tech", NEG_SQL, ["%Sutton"]));
  out.push(zero(ID("nick", ++n), cat, "address for Raymond Sutton", "nick_neg_tech", NEG_SQL, ["%Sutton"]));
  return out;
};

/* ---------------------------------------------------------------- serial lookups (>= 150) */
FAMILIES.serial = () => {
  const p = mk(3502); const out = []; let n = 0; const cat = "blind-r35-serial";
  const units = equipment.filter((u) => u.data?.serial_number);
  const SER = (expr) => `SELECT ${expr} AS v FROM entities e LEFT JOIN entities c ON c.id = e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND upper(e.data->>'serial_number') = upper($1)`;
  const REQ = `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND upper(data->>'serial_number') = upper($1)`;
  const q = (text, expr, serial, shape, extraParams = []) => out.push({ id: ID("serial", ++n), text: dress(text, p), category: cat, shape, cmp: "value", oracle: { sql: SER(expr), params: [serial, ...extraParams], requires: { sql: REQ, params: [serial] } }, citationRequired: true });
  // the ways a tech types a serial
  const variants = [
    (s) => s, (s) => s.toLowerCase(), (s) => s.replace(/^([A-Z0-9]*?[A-Z])(\d)/, "$1-$2"), (s) => s.replace(/^([A-Z0-9]*?[A-Z])(\d)/, "$1 $2"),
    (s) => s.replace(/0/g, "O"), (s) => s.replace(/1/g, "I"), (s) => s.toLowerCase().replace(/0/g, "o"), (s) => s,
  ];
  const ser = p.shuffle(units);
  const forms = [
    // [template, expr, shape]
    [(s) => `what unit is serial ${s}`, "e.data->>'model'", "unit"],
    [(s) => `model for serial ${s}`, "e.data->>'model'", "model"],
    [(s) => `what model is s/n ${s}`, "e.data->>'model'", "model"],
    [(s) => `who has serial ${s}`, "c.data->>'customer_name'", "who"],
    [(s) => `whose is sn ${s}`, "c.data->>'customer_name'", "who"],
    [(s) => `where's S/N ${s}`, "e.data->>'service_address'", "where"],
    [(s) => `where is serial number ${s} installed`, "e.data->>'service_address'", "where"],
    [(s) => `what brand is serial ${s}`, "e.data->>'manufacturer'", "brand"],
    [(s) => `serial# ${s} make?`, "e.data->>'manufacturer'", "brand"],
    [(s) => `sn ${s}`, "e.data->>'model'", "fragment"],
    [(s) => `serial ${s}?`, "c.data->>'customer_name'", "fragment"],
    [(s) => `look up serial ${s}`, "e.data->>'model'", "unit"],
    [(s) => `when was serial ${s} installed`, "e.data->>'installation_date'", "install"],
    [(s) => `install date on sn ${s}`, "e.data->>'installation_date'", "install"],
    [(s) => `ser no ${s} - whose unit`, "c.data->>'customer_name'", "who"],
    [(s) => `what's the address for serial ${s}`, "e.data->>'service_address'", "where"],
    [(s) => `customer for s/n ${s}`, "c.data->>'customer_name'", "who"],
    [(s) => `pull up serial number ${s}`, "e.data->>'model'", "unit"],
  ];
  let i = 0;
  for (const u of ser) {
    if (i >= 108) break;
    const s = u.data.serial_number;
    const [f, expr, shape] = forms[i % forms.length];
    const typed = variants[(i * 5 + 3) % variants.length](s);
    if (shape === "install" && !u.data.installation_date) { i++; continue; }
    if (expr.startsWith("c.") && !u.customer_id) { i++; continue; }
    q(f(typed), expr, s, `serial_${shape}`);
    i++;
  }
  // warranty status by serial (value: active/expiring/expired/unknown)
  const WS = `(CASE WHEN (e.data#>>'{warranty,expires}') IS NULL OR (e.data#>>'{warranty,expires}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown' WHEN substr(e.data#>>'{warranty,expires}',1,10)::date < $2::date THEN 'expired' WHEN substr(e.data#>>'{warranty,expires}',1,10)::date - $2::date <= 365 THEN 'expiring' ELSE 'active' END)`;
  const wForms = [(s) => `is serial ${s} still under warranty`, (s) => `warranty status on sn ${s}`, (s) => `is s/n ${s} covered`, (s) => `does serial ${s} have warranty left`];
  const live = units.filter((u) => u.data.warranty?.expires && u.data.warranty.expires >= "2026-09-25");
  const dead = units.filter((u) => u.data.warranty?.expires && u.data.warranty.expires < "2026-09-25");
  const none = units.filter((u) => !u.data.warranty?.expires);
  [...p.shuffle(live).slice(0, 8), ...p.shuffle(dead).slice(0, 8), ...p.shuffle(none).slice(0, 4)].forEach((u, k) => q(wForms[k % wForms.length](u.data.serial_number), WS, u.data.serial_number, "serial_warranty", [TODAY_PARAM]));
  // last service by serial: latest dated visit on a document tied to that unit (extraction entity or document link), on or before today;
  // non-visit document types are scope.js NON_VISIT_TYPES (the engine-wide visit convention)
  const LAST = `(SELECT max(substr(x.value,1,10)) FROM extractions x JOIN documents d ON d.id = x.document_id WHERE x.field_key='service_date' AND x.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND substr(x.value,1,10) <= $2 AND lower(replace(d.document_type,'_','-')) NOT IN ('maintenance-agreement','maintenance-plan','warranty-registration','warranty','proposal-quote','proposal','quote','purchase-order','permit','nameplate-photo','nameplate','correspondence','internal') AND x.document_id IN (SELECT document_id FROM extractions WHERE entity_id = e.id UNION SELECT document_id FROM document_entity_links WHERE entity_id = e.id))`;
  const lForms = [(s) => `when was serial ${s} last serviced`, (s) => `last service on sn ${s}`, (s) => `last time we worked on s/n ${s}`];
  p.shuffle(units).slice(0, 12).forEach((u, k) => q(lForms[k % lForms.length](u.data.serial_number), LAST, u.data.serial_number, "serial_last_service", [TODAY_PARAM]));
  // NEGATIVES: serials not on file (honest "no unit with serial X"), incl. one edit from a real serial, and a model number typed as a serial
  const all = new Set(units.map((u) => u.data.serial_number.toUpperCase()));
  const NO = `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND upper(regexp_replace(data->>'serial_number','[^A-Za-z0-9]','','g')) = upper(regexp_replace($1,'[^A-Za-z0-9]','','g'))`;
  const fake = ["4N2119-08772", "ZZ9900123", "K7731-55210", "QX100555", "B2299-0071", "WX-4471902", "7H330-221A9", "TT100999", "AB12345678", "R9-00213-77"];
  const nForms = [(s) => `what unit is serial ${s}`, (s) => `who has serial ${s}`, (s) => `sn ${s}`, (s) => `model for serial ${s}`, (s) => `where's s/n ${s}`];
  fake.forEach((s, k) => out.push(zero(ID("serial", ++n), cat, dress(nForms[k % nForms.length](s), p), "serial_not_on_file", NO, [s])));
  // one edit away from a real serial (not itself on file)
  const near = [];
  for (const u of p.shuffle(units)) {
    const s = u.data.serial_number; const alt = s.slice(0, -1) + String((Number(s.slice(-1)) + 5) % 10);
    if (!all.has(alt) && near.length < 8) near.push(alt);
  }
  near.forEach((s, k) => out.push(zero(ID("serial", ++n), cat, dress(nForms[k % nForms.length](s), p), "serial_near_miss", NO, [s])));
  // a model number typed after "serial"
  p.shuffle(units).slice(0, 4).forEach((u, k) => out.push(zero(ID("serial", ++n), cat, dress(nForms[k % nForms.length](u.data.model), p), "serial_is_model", NO, [u.data.model])));
  // CONTROLS: forward "what's the serial" questions (no serial typed) keep working
  const fwd = person.filter((c) => (unitsOf.get(c.id) ?? []).length === 1 && customers.filter((o) => o.customer_name === c.customer_name).length === 1);
  p.shuffle(fwd).slice(0, 8).forEach((c, k) => out.push({ id: ID("serial", ++n), text: dress([`serial number for ${c.customer_name}`, `what's the serial on ${c.customer_name}'s unit`][k % 2], p), category: cat, shape: "serial_forward_control", cmp: "value", oracle: { sql: UNIT_OF_CUST("e.data->>'serial_number'"), params: [c.customer_name], requires: { sql: CUST_REQ, params: [c.customer_name] } }, citationRequired: true }));
  return out;
};

/* ---------------------------------------------------------------- warranty intent (>= 100) */
FAMILIES.warr = () => {
  const p = mk(3503); const out = []; let n = 0; const cat = "blind-r35-warr";
  const COUNT = (cond, brand = false) => `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,expires}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' ${brand ? "AND lower(data->>'manufacturer') = lower($2)" : ""} AND ${cond}`;
  const NOT_EXPIRED = `substr(data#>>'{warranty,expires}',1,10)::date >= $1::date`;
  const OVER_YEAR = `substr(data#>>'{warranty,expires}',1,10)::date > ($1::date + 365)`;
  const WITHIN_YEAR = `substr(data#>>'{warranty,expires}',1,10)::date >= $1::date AND substr(data#>>'{warranty,expires}',1,10)::date <= ($1::date + 365)`;
  const EXPIRED = `substr(data#>>'{warranty,expires}',1,10)::date < $1::date`;
  const num = (text, sql, params, shape) => out.push({ id: ID("warr", ++n), text: dress(text, p), category: cat, shape, cmp: "number", oracle: { sql, params }, citationRequired: true });
  // A. shop-wide "still under warranty" = not expired (owner decision 2026-10-01)
  const live = [
    "how many units are still under warranty", "how many units are under warranty", "how many systems are still covered", "number of units still under warranty",
    "how many units still have warranty", "how many units are in warranty right now", "count of units still under warranty", "how many units have an active warranty",
    "how many units have warranty coverage right now", "how many pieces of equipment are still under warranty", "how many of our units are still under warranty",
    "how many units are currently under warranty", "how many units are still covered by warranty", "how many units are covered under warranty", "how many units have a valid warranty",
    "how many systems are under warranty", "how many units do we have under warranty", "how many units are still in warranty", "how many units still covered",
    "how many units have current warranties", "how many units are under a warranty", "how many of the units are still under warranty", "units still under warranty - how many",
    "total units still under warranty", "how many units are not expired on warranty", "how many units have warranties that haven't expired", "how many units have unexpired warranties",
    "how many systems still have warranty coverage", "how many equipment records are still under warranty", "how many units are under warranty today",
    "how many active warranties do we have", "how many warranties are still active", "how many warranties haven't expired yet", "how many warranties are still good",
    "how many warranties are still valid", "how many active warranties are on file", "how many warranties are still in effect", "how many warranties have not run out yet",
  ];
  live.forEach((t) => num(t, COUNT(NOT_EXPIRED), [TODAY_PARAM], "warr_still_shopwide"));
  // B. explicit strict bucket: more than a year left
  const strict = [
    "how many units have more than a year left on warranty", "how many units have over 12 months of warranty left", "how many warranties have more than a year left",
    "how many units are under warranty for more than another year", "how many units have over a year of warranty remaining", "how many units have more than 12 months left on their warranty",
    "how many units have more than 365 days of warranty left", "how many units still have over a year of coverage", "number of units with more than a year of warranty left",
    "how many units have warranties that run more than a year from now", "how many systems have more than a year left on warranty", "how many units are covered for more than a year yet",
  ];
  strict.forEach((t) => num(t, COUNT(OVER_YEAR), [TODAY_PARAM], "warr_over_year"));
  // C. expiring within a year (the qualifier's own number)
  const soon = ["how many warranties expire within a year", "how many units have warranties expiring in the next 12 months", "how many warranties run out in the next year",
    "how many unit warranties expire within the next year", "how many warranties are expiring within 12 months", "how many units come off warranty in the next year"];
  soon.forEach((t) => num(t, COUNT(WITHIN_YEAR), [TODAY_PARAM], "warr_within_year"));
  // D. brand-scoped still under warranty (not expired) and out of warranty
  const brands = [...new Set(equipment.map((u) => u.data.manufacturer).filter(Boolean))];
  const bForms = [(b) => `how many ${b} units are still under warranty`, (b) => `number of ${b.toLowerCase()} systems still covered`, (b) => `how many ${b} units have an active warranty`, (b) => `how many ${b.toLowerCase()} units are under warranty right now`];
  brands.forEach((b, k) => { num(bForms[k % bForms.length](b), COUNT(NOT_EXPIRED, true), [TODAY_PARAM, b], "warr_still_brand"); num(bForms[(k + 2) % bForms.length](b), COUNT(NOT_EXPIRED, true), [TODAY_PARAM, b], "warr_still_brand"); });
  const eForms = [(b) => `how many ${b} units are out of warranty`, (b) => `how many ${b.toLowerCase()} units are no longer under warranty`];
  brands.forEach((b, k) => num(eForms[k % 2](b), COUNT(EXPIRED, true), [TODAY_PARAM, b], "warr_expired_brand"));
  // E. shop-wide expired controls
  ["how many units are out of warranty", "how many units are no longer under warranty", "how many units have an expired warranty", "how many units are not under warranty anymore"].forEach((t) => num(t, COUNT(EXPIRED), [TODAY_PARAM], "warr_expired_shopwide"));
  // F. specific unit / customer: that unit's status (value: active/expiring = still covered, expired, unknown)
  const W1 = `SELECT (CASE WHEN (e.data#>>'{warranty,expires}') IS NULL OR (e.data#>>'{warranty,expires}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown' WHEN substr(e.data#>>'{warranty,expires}',1,10)::date < $2::date THEN 'expired' WHEN substr(e.data#>>'{warranty,expires}',1,10)::date - $2::date <= 365 THEN 'expiring' ELSE 'active' END) AS v FROM entities e JOIN entities c ON c.id = e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1`;
  const single = person.filter((c) => (unitsOf.get(c.id) ?? []).length === 1 && customers.filter((o) => o.customer_name === c.customer_name).length === 1);
  const cForms = [(nm) => `is ${nm}'s unit still under warranty`, (nm) => `is ${nm} still covered`, (nm) => `does ${nm} still have warranty`, (nm) => `${nm} warranty still good?`];
  const sel = [...p.shuffle(single.filter((c) => (unitsOf.get(c.id)[0].data.warranty?.expires ?? "") >= "2026-09-25")).slice(0, 8), ...p.shuffle(single.filter((c) => { const x = unitsOf.get(c.id)[0].data.warranty?.expires; return x && x < "2026-09-25"; })).slice(0, 8)];
  sel.forEach((c, k) => out.push({ id: ID("warr", ++n), text: dress(cForms[k % cForms.length](c.customer_name), p), category: cat, shape: "warr_customer", cmp: "value", oracle: { sql: W1, params: [c.customer_name, TODAY_PARAM], requires: { sql: CUST_REQ, params: [c.customer_name] } }, citationRequired: true }));
  // G. customers with a not-expired unit (count)
  const CUSTCOUNT = `SELECT count(DISTINCT c.id) AS n FROM entities c JOIN entities e ON e.customer_id = c.id WHERE c.entity_type='customer' AND c.merged_into IS NULL AND e.entity_type='equipment' AND e.merged_into IS NULL AND e.data#>>'{warranty,expires}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND substr(e.data#>>'{warranty,expires}',1,10)::date >= $1::date`;
  ["how many customers have a unit still under warranty", "how many customers are still under warranty", "how many customers have an active warranty", "number of customers with equipment still under warranty"].forEach((t) => num(t, CUSTCOUNT, [TODAY_PARAM], "warr_customers"));
  return out;
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FAMILIES);
for (const fam of want) {
  const qs = FAMILIES[fam]();
  const file = path.join(ROOT, `test-docs/scorecard/blind/r35-${fam}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: "r35-blind-1", category: `blind-r35-${fam}`, source: "scripts/gen-blind-r35.mjs (seeded, frozen before the R35 rules)", questions: qs }, null, 1) + "\n");
  console.log(`${fam}: ${qs.length} questions -> ${path.relative(ROOT, file)}`);
}
