#!/usr/bin/env node
/**
 * DIALOGUES-1 (Round 19, I3) — 40 BLIND multi-turn dialogues (2-4 turns each) against the REAL golden
 * tenant (scripts/golden/golden-export.json), replayed by scripts/run-dialogues.mjs through the actual
 * /api/ask handler with conversationContext threaded exactly as the client builds it
 * (src/components/ask/conversationTurn.ts / api/_lib/conversation.js). Written blind: no exam.json/
 * field-phrasing*.json question text was read, and no engine regex file was opened while writing this.
 *
 * Every dialogue's turns carry a per-turn `expect` descriptor, one of:
 *   { kind: "oracle", cmp, oracle: {sql, params}, tolerance?, anyNumber?, citationRequired? }
 *      graded exactly like a normal exam question — api/_lib/scorecard/oracle.js's runOracle() computes
 *      the ground truth against the SAME golden tenant, api/_lib/scorecard/compare.js's compareAnswer()
 *      grades the real answer against it. Every subject (address/name/serial) here is real, taken
 *      straight from the golden export (verified against it before being written in, same discipline as
 *      scripts/gen-field-phrasing-3.mjs).
 *   { kind: "clarify" }      the turn's own answer must itself be a "which one/unit did you mean" prompt
 *   { kind: "decline" }      the turn must not fabricate a value (graded via compareHonestZero, no oracle
 *                            needed - it does not depend on `expected` at all)
 *   { kind: "mustNotContain", terms: [...] }  a negative check: none of `terms` may appear in the answer
 *                            text (case-insensitive) - used for topic-change/stale-referent traps
 *
 * Usage: node scripts/gen-dialogues.mjs
 *   writes test-docs/scorecard/generalization/dialogues-1.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "dialogues-1.json");

let __n = 0;
const nextId = () => `d${String(++__n).padStart(3, "0")}`;

/* ---------------------------------------------------------------- small oracle builders (turn-level) */

function addressField(addressPrefix, fieldCol) {
  return {
    cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data->>'${fieldCol}' AS v FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)
  AND (SELECT count(*) FROM m) = 1 AND coalesce(e.data->>'${fieldCol}', '') <> ''`,
      params: [addressPrefix],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, params: [addressPrefix] },
    },
  };
}

function nameField(namePattern, fieldCol, onCustomer = true) {
  const sel = onCustomer ? `c.data->>'${fieldCol}'` : `e.data->>'${fieldCol}'`;
  const from = onCustomer
    ? `FROM entities c WHERE c.id IN (SELECT id FROM m)`
    : `FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)`;
  return {
    cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT ${sel} AS v ${from} AND (SELECT count(*) FROM m) = 1 AND coalesce(${sel}, '') <> ''`,
      params: [namePattern],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [namePattern] },
    },
  };
}

function warrantyYesNoByAddress(addressPrefix) {
  return {
    cmp: "yesno",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $2)
SELECT (e.data#>>'{warranty,expires}')::date > $1::date AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND e.data#>>'{warranty,expires}' IS NOT NULL AND (SELECT count(*) FROM m) = 1`,
      params: ["@today", addressPrefix],
    },
  };
}

function warrantyExpiresByAddress(addressPrefix) {
  return {
    cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
      params: [addressPrefix],
    },
  };
}

function countByManufacturer(mfg) {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE '${mfg}'`, params: [] } };
}

function countByManufacturerAtAddress(addressPrefix, mfg) {
  return {
    cmp: "number", tolerance: 0, citationRequired: false,
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND e.data->>'manufacturer' ILIKE '${mfg}'`,
      params: [addressPrefix],
    },
  };
}

function countAtAddress(addressPrefix) {
  return {
    cmp: "number", tolerance: 0, citationRequired: false,
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT count(*) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)`,
      params: [addressPrefix],
    },
  };
}

function totalCustomerCount() {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL`, params: [] } };
}

const oracleExpect = (built) => ({ kind: "oracle", ...built });
const clarify = () => ({ kind: "clarify" });
const decline = () => ({ kind: "decline" });
const mustNotContain = (terms) => ({ kind: "mustNotContain", terms });

const dialogues = [];
const dlg = (persona, turns) => dialogues.push({ id: nextId(), persona, turns });

/* ================================================================== A. pronoun / ellipsis continuation */
dlg("office_manager", [
  { text: "who is the customer at 1210 E Broadway Rd", expect: oracleExpect(nameField("%Melissa Pruitt%", "customer_name")) },
  { text: "is it under warranty?", expect: oracleExpect(warrantyYesNoByAddress("1210 E Broadway Rd%")) },
]);
dlg("office_manager", [
  { text: "is the unit at 1580 W Camelback Rd under warranty", expect: oracleExpect(warrantyYesNoByAddress("1580 W Camelback Rd%")) },
  { text: "and when's the warranty up?", expect: oracleExpect(warrantyExpiresByAddress("1580 W Camelback Rd%")) },
]);
dlg("dispatch", [
  { text: "who serviced 1284 S Alma School Rd last", expect: { kind: "oracle", cmp: "value", oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1), docs AS (SELECT x.document_id, x.value AS service_date FROM extractions x WHERE x.field_key='service_date' AND x.value IS NOT NULL AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))) SELECT t.value AS v FROM extractions t WHERE t.field_key='technician' AND t.document_id = (SELECT document_id FROM docs ORDER BY service_date DESC LIMIT 1) AND (SELECT count(*) FROM m) = 1`, params: ["1284 S Alma School Rd%"] } } },
  { text: "when were we last out there?", expect: { kind: "oracle", cmp: "value", oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1) SELECT x.value AS v FROM extractions x WHERE x.field_key='service_date' AND x.value IS NOT NULL AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m)) AND (SELECT count(*) FROM m)=1 ORDER BY x.value DESC LIMIT 1`, params: ["1284 S Alma School Rd%"] } } },
]);
dlg("warranty_clerk", [
  { text: "whats the manufacturer on file for Cynthia Kowalski", expect: oracleExpect(nameField("%Cynthia Kowalski%", "manufacturer", false)) },
  { text: "and its warranty expiry?", expect: { kind: "oracle", cmp: "value", oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1) SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1 AND e.data#>>'{warranty,expires}' IS NOT NULL`, params: ["%Cynthia Kowalski%"] } } },
]);
dlg("owner", [
  { text: "how many carrier units do we have on the books", expect: oracleExpect(countByManufacturer("carrier")) },
  { text: "and how many of those are past their warranty?", expect: { kind: "oracle", cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'carrier' AND data#>>'{warranty,expires}' IS NOT NULL AND (data#>>'{warranty,expires}')::date <= $1::date`, params: ["@today"] } } },
]);

/* ================================================================== B. list/count refinement */
dlg("owner", [
  { text: "how many units are on file at 3300 S Alma School Rd, Apt 101, Mesa, AZ 85201", expect: oracleExpect(countAtAddress("3300 S Alma School Rd, Apt 101%")) },
  { text: "how many of those are Carrier?", expect: oracleExpect(countByManufacturerAtAddress("3300 S Alma School Rd, Apt 101%", "carrier")) },
]);
dlg("owner", [
  { text: "how many total customers do we have on file", expect: oracleExpect(totalCustomerCount()) },
  { text: "how many of those are in Tempe?", expect: { kind: "oracle", cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Tempe,%'`, params: [] } } },
]);
dlg("office_manager", [
  { text: "list the equipment for Grace Community Church", expect: { kind: "oracle", cmp: "set", oracle: { sql: `SELECT e.data->>'serial_number' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Grace Community Church%'`, params: [] } } },
  { text: "just the Daikin ones", expect: { kind: "oracle", cmp: "set", oracle: { sql: `SELECT e.data->>'serial_number' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Grace Community Church%' AND e.data->>'manufacturer' ILIKE 'daikin'`, params: [] } } },
]);

/* ================================================================== C. entity swap ("same question for X" / "what about X") */
dlg("office_manager", [
  { text: "what's Ashley Vance's phone number", expect: oracleExpect(nameField("%Ashley Vance%", "phone")) },
  { text: "same question for Kenneth Fenwick", expect: oracleExpect(nameField("%Kenneth Fenwick%", "phone")) },
]);
dlg("office_manager", [
  { text: "who is the customer at 137 W Southern Ave", expect: oracleExpect(nameField("%Thomas Mercer%", "customer_name")) },
  { text: "what about 174 N College Ave?", expect: oracleExpect(nameField("%Donna Sorensen%", "customer_name")) },
]);
dlg("warranty_clerk", [
  { text: "is Anthony Bennett still under warranty", expect: oracleExpect({ cmp: "yesno", oracle: { sql: `SELECT (e.data#>>'{warranty,expires}')::date > $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE $2 AND e.data#>>'{warranty,expires}' IS NOT NULL AND (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $2) = 1`, params: ["@today", "%Anthony Bennett%"] } }) },
  { text: "same question for Susan Calloway", expect: oracleExpect({ cmp: "yesno", oracle: { sql: `SELECT (e.data#>>'{warranty,expires}')::date > $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE $2 AND e.data#>>'{warranty,expires}' IS NOT NULL AND (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $2) = 1`, params: ["@today", "%Susan Calloway%"] } }) },
]);

/* ================================================================== D. disambiguation reply */
dlg("office_manager", [
  { text: "what's Karen Abernathy's phone number", expect: clarify() },
  { text: "the other Abernathy, Kevin", expect: oracleExpect(nameField("%Kevin Abernathy%", "phone")) },
]);
dlg("warranty_clerk", [
  { text: "warranty status on osborn", expect: clarify() },
  { text: "I mean Thomas Osborn", expect: oracleExpect({ cmp: "yesno", oracle: { sql: `SELECT (e.data#>>'{warranty,expires}')::date > $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE $2 AND e.data#>>'{warranty,expires}' IS NOT NULL AND (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $2) = 1`, params: ["@today", "%Thomas Osborn%"] } }) },
]);
dlg("dispatch", [
  { text: "phone number for the hutchins account", expect: clarify() },
  { text: "the Linda Hutchins one", expect: oracleExpect(nameField("%Linda Hutchins%", "phone")) },
]);

/* ================================================================== E. NEGATIVE: topic change never carries a stale referent */
dlg("office_manager", [
  { text: "who is the customer at 1506 E McKellips Rd", expect: oracleExpect(nameField("%Ashley Vance%", "customer_name")) },
  { text: "how many total customers do we have on file", expect: oracleExpect(totalCustomerCount()) },
  { text: "is it under warranty?", expect: mustNotContain(["1506 E McKellips", "Ashley Vance"]) },
]);
dlg("dispatch", [
  { text: "who's the customer at 1617 N Val Vista Dr", expect: oracleExpect(nameField("%Michael Redwine%", "customer_name")) },
  { text: "whats todays date", expect: { kind: "decline" } },
  { text: "is it under warranty?", expect: mustNotContain(["1617 N Val Vista", "Michael Redwine"]) },
]);

/* ================================================================== F. NEGATIVE: no antecedent at all */
dlg("dispatch", ["who do we have going out today", "is anybody free this afternoon"].map((text) => ({ text, expect: decline() })));
dlg("owner", [{ text: "and what was the total for that job", expect: decline() }, { text: "put me through to whoever handled it", expect: decline() }]);

/* ================================================================== G. voice-dictation persona, 2-3 turns */
dlg("voice_tech", [
  { text: "uh whats the model at one zero zero east main street", expect: oracleExpect(addressField("100 E Main St%", "model")) },
  { text: "and the serial too", expect: oracleExpect(addressField("100 E Main St%", "serial_number")) },
]);
dlg("voice_tech", [
  { text: "is that a train unit out at 3060 n dobson rd", expect: oracleExpect(addressField("3060 N Dobson Rd%", "manufacturer")) },
  { text: "whats the tonnage on it", expect: oracleExpect(addressField("3060 N Dobson Rd%", "tonnage")) },
]);
dlg("voice_tech", [
  { text: "so is it a carry her unit out at 2801 w guadalupe rd", expect: oracleExpect(addressField("2801 W Guadalupe Rd%", "manufacturer")) },
  { text: "when was it installed", expect: oracleExpect(addressField("2801 W Guadalupe Rd%", "installation_date")) },
]);

/* ================================================================== H. warranty-clerk multi-hop chains (3 turns) */
dlg("warranty_clerk", [
  { text: "whats the manufacturer at 1321 E Chandler Blvd", expect: oracleExpect(addressField("1321 E Chandler Blvd%", "manufacturer")) },
  { text: "is it still under warranty", expect: oracleExpect(warrantyYesNoByAddress("1321 E Chandler Blvd%")) },
  { text: "when does it expire", expect: oracleExpect(warrantyExpiresByAddress("1321 E Chandler Blvd%")) },
]);
dlg("warranty_clerk", [
  { text: "who's the customer at 1654 E Pecos Rd", expect: oracleExpect(nameField("%Nancy Zamora%", "customer_name")) },
  { text: "is their unit still covered", expect: oracleExpect(warrantyYesNoByAddress("1654 E Pecos Rd%")) },
  { text: "and the expiry date", expect: oracleExpect(warrantyExpiresByAddress("1654 E Pecos Rd%")) },
]);

/* ================================================================== I. dispatch reverse-lookup chains */
dlg("dispatch", [
  { text: "whose unit is serial F100002", expect: oracleExpect({ cmp: "value", oracle: { sql: `WITH m AS (SELECT customer_id FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'serial_number' = $1) SELECT c.data->>'customer_name' AS v FROM entities c WHERE c.id IN (SELECT customer_id FROM m) AND (SELECT count(*) FROM m) = 1`, params: ["F100002"] } }) },
  { text: "whats their service address", expect: { kind: "oracle", cmp: "value", oracle: { sql: `SELECT data->>'service_address' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE '%Linda Fitzgerald%'`, params: [] } } },
]);
dlg("dispatch", [
  { text: "whos calling from 480 555 0158", expect: { kind: "oracle", cmp: "value", oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND regexp_replace(coalesce(data->>'phone',''), '\\D', '', 'g') = $1) SELECT data->>'customer_name' AS v FROM entities WHERE id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`, params: ["4805550158"] } } },
  { text: "whats their service address", expect: { kind: "oracle", cmp: "value", oracle: { sql: `SELECT data->>'service_address' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE '%Amanda Quinley%'`, params: [] } } },
]);

/* ================================================================== J. plain single-turn spot checks across personas (fills to 40) */
const SINGLE_TURN = [
  ["owner", "how many maintenance agreements do we have on the books, all in", { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM documents WHERE document_type='maintenance-agreement'`, params: [] } }],
  ["owner", "which tech is racking up the most repair calls", { cmp: "value", oracle: { sql: `SELECT t.value AS v FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='Repair' WHERE t.field_key='technician' GROUP BY t.value ORDER BY count(*) DESC LIMIT 1`, params: [] } }],
  ["office_manager", "is there a permit on file for the Canyon View Dental job", { cmp: "yesno", citationRequired: false, oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1) SELECT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='permit' AND l.entity_id IN (SELECT id FROM m)) AS v FROM (SELECT 1) z WHERE (SELECT count(*) FROM m)=1`, params: ["%Canyon View Dental%"] } }],
  ["office_manager", "is there a permit on file for Amanda Quinley", { cmp: "yesno", citationRequired: false, oracle: { sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1) SELECT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='permit' AND l.entity_id IN (SELECT id FROM m)) AS v FROM (SELECT 1) z WHERE (SELECT count(*) FROM m)=1`, params: ["%Amanda Quinley%"] } }],
  ["warranty_clerk", "how many open warranty claims do we have right now", null], // decline, see below
  ["dispatch", "is anyone dispatched to that address right now", null], // decline (no antecedent + no live tracking)
  ["voice_tech", "uh whats the seer rating on the unit at one seven two eight west ocotillo rd", null], // decline, never-on-file field
  ["owner", "any memos for Kevin Pratt this week", null], // decline, team-scoped
  ["office_manager", "what's on file for the fenwick account", "AMBIGUOUS"], // clarify
  ["dispatch", "translate 'under warranty' into spanish", null], // decline, out-of-domain
];
for (const [persona, text, spec] of SINGLE_TURN) {
  let expect;
  if (spec === "AMBIGUOUS") expect = clarify();
  else if (spec === null) expect = decline();
  else expect = oracleExpect(spec);
  dlg(persona, [{ text, expect }]);
}

/* ================================================================== K. a few more 2-turn dialogues to round out persona coverage */
dlg("owner", [
  { text: "how many goodman units are on our books", expect: oracleExpect(countByManufacturer("goodman")) },
  { text: "do we have more of those than lennox", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'goodman') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'lennox') AS v`, params: [] } } },
]);
dlg("office_manager", [
  { text: "what's on file for the osborn account", expect: clarify() },
  { text: "the Richard Osborn one, what's his phone number", expect: oracleExpect(nameField("%Richard Osborn%", "phone")) },
]);
dlg("dispatch", [
  { text: "whose unit is serial 2C100027", expect: oracleExpect({ cmp: "value", oracle: { sql: `WITH m AS (SELECT customer_id FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'serial_number' = $1) SELECT c.data->>'customer_name' AS v FROM entities c WHERE c.id IN (SELECT customer_id FROM m) AND (SELECT count(*) FROM m) = 1`, params: ["2C100027"] } }) },
  { text: "is their unit still under warranty", expect: oracleExpect(warrantyYesNoByAddress("1025 N College Ave%")) },
]);
dlg("warranty_clerk", [
  { text: "how many warranty registrations went in within 30 days of the install date", expect: { kind: "oracle", cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities e JOIN document_entity_links l ON l.entity_id=e.id JOIN extractions x ON x.document_id=l.document_id AND x.field_key='warranty_registered_date' WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (x.value::date - (e.data->>'installation_date')::date) <= 30`, params: [] } } },
  { text: "any memos about that policy from the manufacturers", expect: decline() },
]);
dlg("dispatch", [
  { text: "who's the customer at 3208 E McKellips Rd", expect: { kind: "oracle", cmp: "value", oracle: { sql: `SELECT data->>'customer_name' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1 AND (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1) = 1`, params: ["3208 E McKellips Rd%"] } } },
  { text: "whats the tonnage on their unit", expect: oracleExpect(addressField("3208 E McKellips Rd%", "tonnage")) },
]);

/* ============================================================== output */

if (dialogues.length !== 40) {
  console.error(`gen-dialogues: expected 40 dialogues, built ${dialogues.length}`);
  process.exit(1);
}
const totalTurns = dialogues.reduce((n, d) => n + d.turns.length, 0);
const ids = new Set(dialogues.map((d) => d.id));
if (ids.size !== 40) {
  console.error(`gen-dialogues: duplicate ids (${40 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-27.dialogues-1-r19",
  category: "dialogues-1",
  source: "Round 19 (I3) blind multi-turn dialogue set - 40 dialogues (2-4 turns), replayed through the real /api/ask handler against the golden tenant with conversationContext threaded exactly as the client builds it. See scripts/run-dialogues.mjs.",
  dialogues,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-dialogues: wrote ${dialogues.length} dialogues (${totalTurns} turns) -> ${OUT_PATH}`);
}

export { dialogues, out };
