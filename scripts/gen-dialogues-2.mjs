#!/usr/bin/env node
/**
 * DIALOGUES-2 (Round 21, L1) — 40 NEW BLIND multi-turn dialogues (3-5 turns each) against the REAL golden
 * tenant (scripts/golden/golden-export.json), replayed by scripts/run-dialogues.mjs (extended this round
 * to accept a dialogues-file argument) through the actual /api/ask handler with conversationContext
 * threaded exactly as the client builds it (src/components/ask/conversationTurn.ts / api/_lib/
 * conversation.js). Written blind: no exam.json/field-phrasing*.json/dialogues-1.json question or turn
 * text was read, and no engine regex file was opened while writing this — only gen-dialogues.mjs (read
 * for STRUCTURE: the turn-level oracle-builder helper pattern, the `expect` shapes, the
 * conversationContext threading convention) and a live PGlite query of scripts/golden/golden-export.json
 * for real, fresh subjects (every address/name/serial here is a DIFFERENT customer than dialogues-1 used,
 * checked by hand against that file's own header comment).
 *
 * Same turn `expect` shapes as dialogues-1 (see gen-dialogues.mjs's own header for the full contract):
 *   { kind: "oracle", cmp, oracle, tolerance?, anyNumber?, citationRequired? }
 *   { kind: "clarify" }            the turn's own answer must itself be a "which one/unit did you mean" prompt
 *   { kind: "decline" }            the turn must not fabricate a value (honest-zero, no oracle needed)
 *   { kind: "mustNotContain", terms: [...] }  a negative check for topic-change/stale-referent traps
 *
 * NEW shapes this round, per the R21 contract:
 *   A. topic switches (8) — resolve an entity, then TWO unrelated portfolio-wide questions in a row,
 *      then a bare follow-up ("is it still under warranty?") that must NOT resurface the earlier entity —
 *      a stronger version of dialogues-1's own single-intervening-turn negative check.
 *   B. corrections (8) — "no, I meant the <city> one" disambiguating a first-name-only reference among
 *      2-3 real customers who share that first name (verified live: exactly that many matches, and the
 *      named city uniquely resolves to one of them).
 *   C. refinements (8) — a portfolio-wide count narrowed twice in a row (city -> city+brand ->
 *      city+brand+"since the start of last year" repair/PM status), each count live-computed fresh.
 *   D. comparisons over prior results (8) — two independent counts asked back to back, then a yes/no
 *      asking which was bigger, graded against the SAME two live counts (never hand-typed).
 *   E. pronoun chains (8, 5 turns) — an address resolves a customer, then "it"/"its" chains through
 *      manufacturer, warranty status, expiry date and tonnage, all on the SAME real single-unit customer.
 *
 * Usage: node scripts/gen-dialogues-2.mjs
 *   writes test-docs/scorecard/generalization/dialogues-2.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "dialogues-2.json");

let __n = 0;
const nextId = () => `e${String(++__n).padStart(3, "0")}`;

/* ---------------------------------------------------------------- small oracle builders (turn-level)
 * (same conventions as gen-dialogues.mjs's own helpers - rebuilt fresh here, never imported). */

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
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' = $1)
SELECT ${sel} AS v ${from} AND (SELECT count(*) FROM m) = 1 AND coalesce(${sel}, '') <> ''`,
      params: [namePattern],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' = $1`, params: [namePattern] },
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

function cityCustomerCount(city) {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, ' || $1 || ',%'`, params: [city] } };
}

function cityMfgCount(city, mfg) {
  return {
    cmp: "number", tolerance: 0, citationRequired: false,
    oracle: {
      sql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'service_address' ILIKE '%, ' || $2 || ',%'`,
      params: [mfg, city],
    },
  };
}

/** brand + city + service-type-since-last-year, the same guarded 3-condition narrowing fp-4's own
 *  multi_constraint shape uses (this round's own new emphasis), reused here as a dialogue's 3rd turn. */
function cityMfgSvcSinceLastYearCount(city, mfg, svc) {
  return {
    cmp: "number", tolerance: 0, citationRequired: false,
    oracle: {
      sql: `WITH m AS (
  SELECT DISTINCT e.id FROM entities e JOIN entities c ON c.id=e.customer_id
  WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1
    AND c.data->>'service_address' ILIKE '%, ' || $2 || ',%'
    AND EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id
      JOIN extractions sd ON sd.document_id=l.document_id AND sd.field_key='service_date'
      WHERE x.field_key='service_type' AND x.value=$3 AND (l.entity_id=e.id OR l.entity_id=e.customer_id)
      AND sd.value::date >= make_date(extract(year from $4::date)::int - 1, 1, 1) AND sd.value::date <= $4::date)
) SELECT count(*) AS n FROM m`,
      params: [mfg, city, svc, "@today"],
    },
  };
}

function mfgTotal(mfg) {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE $1`, params: [mfg] } };
}

function techTotal(tech) {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM extractions WHERE field_key='technician' AND value = $1`, params: [tech] } };
}

function docTypeTotal(docType) {
  // anyNumber: a bare "<doc type> ... in total" question can be answered through the money gate for a
  // money-flavored doc type (purchase-order/invoice/agreement), whose own sentence states the dollar
  // total first and the document COUNT as a secondary number ("... across N purchase orders") rather
  // than as the answer's primary figure - verified live (the engine's own answer is correct, just not in
  // the primary-number slot the default comparator checks).
  return { cmp: "number", tolerance: 0, anyNumber: true, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM documents WHERE document_type = $1`, params: [docType] } };
}

function svcTypeTotal(svc) {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_type' AND value = $1`, params: [svc] } };
}

function ageThresholdCount(overYears, comparator) {
  return {
    cmp: "number", tolerance: 0, citationRequired: false,
    oracle: {
      sql: comparator === "over"
        ? `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date <= ($1::date - interval '${overYears} years')`
        : `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date > ($1::date - interval '${overYears} years')`,
      params: ["@today"],
    },
  };
}

function totalCustomerCount() {
  return { cmp: "number", tolerance: 0, citationRequired: false, oracle: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL`, params: [] } };
}

const oracleExpect = (built) => ({ kind: "oracle", ...built });
const clarify = () => ({ kind: "clarify" });
const mustNotContain = (terms) => ({ kind: "mustNotContain", terms });

const dialogues = [];
const dlg = (persona, turns) => dialogues.push({ id: nextId(), persona, turns });

/* ================================================================== A. TOPIC SWITCHES (8, 4 turns)
 * Resolve an entity, ask TWO unrelated portfolio-wide questions in a row, then a bare follow-up that
 * must not resurface the earlier entity - a stronger version of dialogues-1's single-intervening-turn
 * negative check (two intervening turns here, not one). */
dlg("dispatch", [
  { text: "who's the customer at 581 W Thomas Rd, Mesa", expect: oracleExpect(nameField("Gary Villegas", "customer_name")) },
  { text: "how many total customers do we have on file", expect: oracleExpect(totalCustomerCount()) },
  { text: "how many York units do we have company-wide", expect: oracleExpect(mfgTotal("york")) },
  { text: "is it still under warranty?", expect: mustNotContain(["581 W Thomas", "Gary Villegas"]) },
]);
dlg("office_manager", [
  { text: "who's the customer at 3911 N Dobson Rd, Los Angeles", expect: oracleExpect(nameField("Ronald Dominguez", "customer_name")) },
  { text: "how many preventive maintenance visits have we logged total", expect: oracleExpect(svcTypeTotal("Preventive Maintenance")) },
  { text: "how many purchase orders have we cut in total", expect: oracleExpect(docTypeTotal("purchase-order")) },
  { text: "is their unit still under warranty?", expect: mustNotContain(["3911 N Dobson", "Ronald Dominguez"]) },
]);
dlg("owner", [
  { text: "who's the customer at 1469 N Power Rd, Tempe", expect: oracleExpect(nameField("Richard Osborn", "customer_name")) },
  { text: "how many Mitsubishi units do we have company-wide", expect: oracleExpect(mfgTotal("mitsubishi")) },
  { text: "how many repair visits have we logged total", expect: oracleExpect(svcTypeTotal("Repair")) },
  { text: "is it still under warranty?", expect: mustNotContain(["1469 N Power", "Richard Osborn"]) },
]);
dlg("warranty_clerk", [
  { text: "who's the customer at 1765 N Recker Rd, Glendale", expect: oracleExpect(nameField("Timothy Ulloa", "customer_name")) },
  { text: "how many maintenance agreements do we have on the books", expect: oracleExpect(docTypeTotal("maintenance-agreement")) },
  { text: "how many Lennox units do we have company-wide", expect: oracleExpect(mfgTotal("lennox")) },
  { text: "when's the warranty up on it?", expect: mustNotContain(["1765 N Recker", "Timothy Ulloa"]) },
]);
dlg("dispatch", [
  { text: "who's the customer at 359 E Broadway Rd, Phoenix", expect: oracleExpect(nameField("Steven Ellison", "customer_name")) },
  { text: "how many Kevin Pratt jobs are on file", expect: oracleExpect(techTotal("Kevin Pratt")) },
  { text: "how many units total are over 15 years old", expect: oracleExpect(ageThresholdCount(15, "over")) },
  { text: "what's the manufacturer on it?", expect: mustNotContain(["359 E Broadway", "Steven Ellison"]) },
]);
dlg("office_manager", [
  { text: "who's the customer at 3541 W Southern Ave, Oro Valley", expect: oracleExpect(nameField("George Hutchins", "customer_name")) },
  { text: "how many inspection reports do we have on file", expect: oracleExpect(docTypeTotal("inspection-report")) },
  { text: "how many Daikin units do we have company-wide", expect: oracleExpect(mfgTotal("daikin")) },
  { text: "is theirs still under warranty?", expect: mustNotContain(["3541 W Southern", "George Hutchins"]) },
]);
dlg("owner", [
  { text: "who's the customer at 2357 E McKellips Rd, San Tan Valley", expect: oracleExpect(nameField("Donald Isaacson", "customer_name")) },
  { text: "how many startup sheets have we filed", expect: oracleExpect(docTypeTotal("startup-sheet")) },
  { text: "how many Rheem units do we have company-wide", expect: oracleExpect(mfgTotal("rheem")) },
  { text: "when does the warranty on it expire?", expect: mustNotContain(["2357 E McKellips", "Donald Isaacson"]) },
]);
dlg("dispatch", [
  { text: "who's the customer at 470 E Chandler Blvd, Mesa", expect: oracleExpect(nameField("Karen Abernathy", "customer_name")) },
  { text: "how many work orders are on the books", expect: oracleExpect(docTypeTotal("work-order")) },
  { text: "how many Trane units do we have company-wide", expect: oracleExpect(mfgTotal("trane")) },
  { text: "is it still covered?", expect: mustNotContain(["470 E Chandler", "Karen Abernathy"]) },
]);

/* ================================================================== B. CORRECTIONS ("no, I meant the
 * <city> one") - a first-name-only reference matching 2-3 real customers, then a city that uniquely
 * resolves one of them (verified live: exactly that many first-name matches, the named city unique). */
dlg("office_manager", [
  { text: "what's Linda's phone number", expect: clarify() },
  { text: "no, I meant the Glendale one", expect: oracleExpect(nameField("Linda Garrison", "phone")) },
]);
dlg("dispatch", [
  { text: "who serviced Steven's place last", expect: clarify() },
  { text: "sorry, the Mesa one", expect: oracleExpect(nameField("Steven Hutchins", "phone")) },
]);
dlg("office_manager", [
  { text: "what's Karen's account phone number", expect: clarify() },
  { text: "no, I meant the San Tan Valley one", expect: oracleExpect(nameField("Karen Bracken", "phone")) },
]);
dlg("warranty_clerk", [
  { text: "what's the manufacturer on Richard's unit", expect: clarify() },
  { text: "no, the Tucson one", expect: oracleExpect(nameField("Richard Pruitt", "manufacturer", false)) },
]);
dlg("dispatch", [
  { text: "what's Donald's phone number", expect: clarify() },
  { text: "I meant the Mesa one, not the other Donald", expect: oracleExpect(nameField("Donald Sorenson", "phone")) },
]);
dlg("warranty_clerk", [
  { text: "what's the manufacturer on Timothy's system", expect: clarify() },
  { text: "no, I meant the Oro Valley one", expect: oracleExpect(nameField("Timothy Vance", "manufacturer", false)) },
]);
dlg("warranty_clerk", [
  { text: "when's the warranty up on George's unit", expect: clarify() },
  { text: "sorry, the Scottsdale one", expect: oracleExpect(warrantyExpiresByAddress("1691 S Ellsworth Rd%")) },
]);
dlg("office_manager", [
  { text: "what's Charles's phone number", expect: clarify() },
  { text: "no, I meant the Tempe one", expect: oracleExpect(nameField("Charles Whitford", "phone")) },
]);

/* ================================================================== C. REFINEMENTS (8, 3 turns) - a
 * portfolio-wide count narrowed twice: city -> city+brand -> city+brand+"since the start of last year"
 * repair/PM status, every count live-computed fresh (never hand-typed, never reused from fp-4). */
dlg("owner", [
  { text: "how many customers do we have in Tempe", expect: oracleExpect(cityCustomerCount("Tempe")) },
  { text: "how many of those have a Carrier unit", expect: oracleExpect(cityMfgCount("Tempe", "carrier")) },
  { text: "and how many of those have had a preventive maintenance visit since the start of last year", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Tempe", "carrier", "Preventive Maintenance")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Mesa", expect: oracleExpect(cityCustomerCount("Mesa")) },
  { text: "how many of those have a Carrier unit", expect: oracleExpect(cityMfgCount("Mesa", "carrier")) },
  { text: "and how many of those needed a repair since the start of last year", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Mesa", "carrier", "Repair")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Scottsdale", expect: oracleExpect(cityCustomerCount("Scottsdale")) },
  { text: "how many of those have a Lennox unit", expect: oracleExpect(cityMfgCount("Scottsdale", "lennox")) },
  { text: "and how many of those needed a repair since last January", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Scottsdale", "lennox", "Repair")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Mesa", expect: oracleExpect(cityCustomerCount("Mesa")) },
  { text: "how many of those have a Goodman unit", expect: oracleExpect(cityMfgCount("Mesa", "goodman")) },
  { text: "and how many of those needed a repair since the start of last year", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Mesa", "goodman", "Repair")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Chandler", expect: oracleExpect(cityCustomerCount("Chandler")) },
  { text: "how many of those have a Rheem unit", expect: oracleExpect(cityMfgCount("Chandler", "rheem")) },
  { text: "and how many of those needed a repair since last January", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Chandler", "rheem", "Repair")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Gilbert", expect: oracleExpect(cityCustomerCount("Gilbert")) },
  { text: "how many of those have a Rheem unit", expect: oracleExpect(cityMfgCount("Gilbert", "rheem")) },
  { text: "and how many of those needed a repair since the start of last year", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Gilbert", "rheem", "Repair")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Tucson", expect: oracleExpect(cityCustomerCount("Tucson")) },
  { text: "how many of those have a Daikin unit", expect: oracleExpect(cityMfgCount("Tucson", "daikin")) },
  { text: "and how many of those needed a repair since last January", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Tucson", "daikin", "Repair")) },
]);
dlg("owner", [
  { text: "how many customers do we have in Chandler", expect: oracleExpect(cityCustomerCount("Chandler")) },
  { text: "how many of those have a Mitsubishi unit", expect: oracleExpect(cityMfgCount("Chandler", "mitsubishi")) },
  { text: "and how many of those needed a repair since the start of last year", expect: oracleExpect(cityMfgSvcSinceLastYearCount("Chandler", "mitsubishi", "Repair")) },
]);

/* ================================================================== D. COMPARISONS OVER PRIOR RESULTS
 * (8, 3 turns) - two independent counts asked back to back, then a yes/no naming which was bigger,
 * graded against the SAME two live counts (never hand-typed, never duplicated from dialogues-1). */
dlg("owner", [
  { text: "how many jobs has Kevin Pratt done total", expect: oracleExpect(techTotal("Kevin Pratt")) },
  { text: "how many has Ray Sutton done", expect: oracleExpect(techTotal("Ray Sutton")) },
  { text: "so who's done more, Kevin or Ray", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Kevin Pratt') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Ray Sutton') AS v`, params: [] } } },
]);
dlg("owner", [
  { text: "how many Mitsubishi units do we have", expect: oracleExpect(mfgTotal("mitsubishi")) },
  { text: "how many York units do we have", expect: oracleExpect(mfgTotal("york")) },
  { text: "do we have more Mitsubishi than York", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'mitsubishi') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'york') AS v`, params: [] } } },
]);
dlg("owner", [
  { text: "how many customers do we have in Mesa", expect: oracleExpect(cityCustomerCount("Mesa")) },
  { text: "how many do we have in Tucson", expect: oracleExpect(cityCustomerCount("Tucson")) },
  { text: "does Mesa have more customers than Tucson", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Mesa,%') > (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Tucson,%') AS v`, params: [] } } },
]);
dlg("owner", [
  { text: "how many preventive maintenance visits have we logged total", expect: oracleExpect(svcTypeTotal("Preventive Maintenance")) },
  { text: "how many repair visits have we logged total", expect: oracleExpect(svcTypeTotal("Repair")) },
  { text: "do we do more repair work than preventive maintenance, by volume", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='service_type' AND value='Repair') > (SELECT count(*) FROM extractions WHERE field_key='service_type' AND value='Preventive Maintenance') AS v`, params: [] } } },
]);
dlg("owner", [
  { text: "how many Trane units do we have", expect: oracleExpect(mfgTotal("trane")) },
  { text: "how many Mitsubishi units do we have", expect: oracleExpect(mfgTotal("mitsubishi")) },
  { text: "is Trane our biggest brand, bigger than Mitsubishi", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'trane') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'mitsubishi') AS v`, params: [] } } },
]);
dlg("owner", [
  { text: "how many jobs has Danny Ochoa done total", expect: oracleExpect(techTotal("Danny Ochoa")) },
  { text: "how many has Wyatt Coburn done", expect: oracleExpect(techTotal("Wyatt Coburn")) },
  { text: "has Danny done more jobs than Wyatt", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Danny Ochoa') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Wyatt Coburn') AS v`, params: [] } } },
]);
dlg("owner", [
  { text: "how many units total are over 15 years old", expect: oracleExpect(ageThresholdCount(15, "over")) },
  { text: "how many are under 5 years old", expect: oracleExpect(ageThresholdCount(5, "under")) },
  { text: "are more of our units old, 15-plus years, than new, under 5 years", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date <= ($1::date - interval '15 years')) > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date > ($1::date - interval '5 years')) AS v`, params: ["@today"] } } },
]);
dlg("owner", [
  { text: "how many maintenance agreements do we have on the books", expect: oracleExpect(docTypeTotal("maintenance-agreement")) },
  { text: "how many purchase orders do we have", expect: oracleExpect(docTypeTotal("purchase-order")) },
  { text: "do we have more maintenance agreements than purchase orders", expect: { kind: "oracle", cmp: "yesno", oracle: { sql: `SELECT (SELECT count(*) FROM documents WHERE document_type='maintenance-agreement') > (SELECT count(*) FROM documents WHERE document_type='purchase-order') AS v`, params: [] } } },
]);

/* ================================================================== E. PRONOUN CHAINS (8, 5 turns) - an
 * address resolves a customer, then it/its chains through manufacturer, warranty status, expiry and
 * tonnage, all on the SAME real single-unit customer (never split across two different subjects). */
function pronounChain(persona, address) {
  dlg(persona, [
    { text: `who's the customer at ${address}`, expect: oracleExpect(addressField(`${address}%`, "customer_name")) },
    { text: "what's the manufacturer on it", expect: oracleExpect(addressField(`${address}%`, "manufacturer")) },
    { text: "is it still under warranty", expect: oracleExpect(warrantyYesNoByAddress(`${address}%`)) },
    { text: "when's it up", expect: oracleExpect(warrantyExpiresByAddress(`${address}%`)) },
    { text: "and the tonnage on it", expect: oracleExpect(addressField(`${address}%`, "tonnage")) },
  ]);
}
pronounChain("dispatch", "2764 E University Dr, Maricopa");
pronounChain("warranty_clerk", "1913 E University Dr, Glendale");
pronounChain("office_manager", "766 N Val Vista Dr, Gilbert");
pronounChain("warranty_clerk", "988 W Southern Ave, Chandler");
pronounChain("dispatch", "1321 E Chandler Blvd, Tempe");
pronounChain("warranty_clerk", "507 N Dobson Rd, Mesa");
pronounChain("office_manager", "2320 N Power Rd, San Tan Valley");
pronounChain("warranty_clerk", "1950 W Guadalupe Rd, Glendale");

/* ============================================================== output */

if (dialogues.length !== 40) {
  console.error(`gen-dialogues-2: expected 40 dialogues, built ${dialogues.length}`);
  process.exit(1);
}
const totalTurns = dialogues.reduce((n, d) => n + d.turns.length, 0);
const ids = new Set(dialogues.map((d) => d.id));
if (ids.size !== 40) {
  console.error(`gen-dialogues-2: duplicate ids (${40 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-27.dialogues-2-r21",
  category: "dialogues-2",
  source: "Round 21 (L1) blind multi-turn dialogue set - 40 NEW dialogues (3-5 turns), replayed through the real /api/ask handler against the golden tenant with conversationContext threaded exactly as the client builds it. New shapes this round: topic switches with two intervening unrelated turns, corrections (\"no, I meant the <city> one\" disambiguating a shared first name), refinements (a count narrowed twice: city -> city+brand -> city+brand+time-window+status), comparisons over prior results, and 5-turn pronoun chains. See scripts/run-dialogues.mjs (extended this round to accept a dialogues-file argument).",
  dialogues,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-dialogues-2: wrote ${dialogues.length} dialogues (${totalTurns} turns) -> ${OUT_PATH}`);
}

export { dialogues, out };
