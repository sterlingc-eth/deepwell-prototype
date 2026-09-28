#!/usr/bin/env node
/**
 * FIELD-PHRASING-2 exam category (Round 18, H2) — a BLIND generalization set: 200 new questions written
 * WITHOUT looking at test-docs/scorecard/exam.json's or field-phrasing.json's question TEXTS, and without
 * looking at any engine regex (api/_lib/fastPath*.js etc. were never opened while writing this file). Only
 * three things were read to build this: the DATA (scripts/golden/golden-export.json, queried directly for
 * real subjects — names, addresses, serials, phones, manufacturers, dates, financials), the exam file
 * FORMAT/oracle schema (api/_lib/scorecard/exam.js), and scripts/gen-field-phrasing.mjs — read for its
 * STRUCTURE (the oracle-builder helper pattern: a guarded single-match SQL query, an honest-decline guard,
 * an ambiguity-set "ask which one", a portfolio-wide count) so this file's oracles follow the same
 * conventions and the same PGlite-verification discipline, never for its question wording, which this file
 * does not reuse or paraphrase from.
 *
 * PERSONAS covered: field tech on a phone (typos, fragments, voice-dictation slips), dispatcher, office
 * manager, owner/portfolio-analytics.
 * SHAPES covered (13 required by the round contract, mapped onto ~23 concrete generator groups below):
 *   lookups by name/address/serial/phone, warranty, service history ("last time we were out at…"),
 *   counts/lists/rankings, time ranges ("this spring", "since january", "last 90 days"), multi-hop
 *   (manufacturer -> maintenance-agreement / repair-visit / city+warranty joins), comparisons,
 *   negation/exclusion, ambiguous names, unanswerable/not-on-file, out-of-domain, compound, and
 *   conversational follow-ups expressed standalone (no antecedent to resolve -> must ask, never guess).
 *
 * GROUND TRUTH: every oracle here is run for real against scripts/golden/golden-export.json through the
 * SAME PGlite harness gen-field-phrasing.mjs's own verify script uses (offline-exam.mjs's
 * createPGlite/loadExportIntoNewTenant + api/_lib/scorecard/oracle.js's runOracle) — see
 * scripts/verify-field-phrasing-2.mjs. Every subject (address/name/serial/phone) below was confirmed to
 * exist, with the guarded property claimed (single match / always-empty field / real ambiguity count),
 * via direct queries against the same golden export before being written in here — never invented.
 *
 * Usage: node scripts/gen-field-phrasing-2.mjs
 *   writes test-docs/scorecard/generalization/field-phrasing-2.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "field-phrasing-2.json");

const CATEGORY = "field-phrasing-2";
const TODAY = "@today"; // resolved by oracle.js at run time

/* ============================================================== oracle-builder helpers
 * (same shapes as gen-field-phrasing.mjs's own helpers, rebuilt here rather than imported so this
 * category's questions/oracles are fully self-contained and never drift if that file changes). */

/** Single point-value lookup at a service address, guarded to fire only when exactly one customer
 *  matches (never silently pick among several). */
function addressValue({ id, text, shape, addressPrefix, fieldCol, citationRequired = true }) {
  return {
    id, text, category: CATEGORY, shape, cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data->>'${fieldCol}' AS v FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)
  AND (SELECT count(*) FROM m) = 1 AND coalesce(e.data->>'${fieldCol}', '') <> ''`,
      params: [addressPrefix],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`, params: [addressPrefix] },
    },
    citationRequired,
  };
}

/** Point-value lookup by an exact (or bare-surname) customer_name pattern, guarded to a single match. */
function nameValue({ id, text, shape, namePattern, fieldCol, onCustomer = false, citationRequired = true }) {
  const sel = onCustomer ? `c.data->>'${fieldCol}'` : `e.data->>'${fieldCol}'`;
  const from = onCustomer
    ? `FROM entities c WHERE c.id IN (SELECT id FROM m)`
    : `FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)`;
  return {
    id, text, category: CATEGORY, shape, cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT ${sel} AS v ${from} AND (SELECT count(*) FROM m) = 1 AND coalesce(${sel}, '') <> ''`,
      params: [namePattern],
    },
    citationRequired,
  };
}

/** Reverse lookup: given an exact equipment serial number, the customer's name (guarded to one match —
 *  serials are unique in this corpus, verified directly, but the guard costs nothing and documents the
 *  assumption rather than relying on it silently). */
function serialToName({ id, text, serial }) {
  return {
    id, text, category: CATEGORY, shape: "lookup_serial", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT customer_id FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'serial_number' = $1)
SELECT c.data->>'customer_name' AS v FROM entities c WHERE c.id IN (SELECT customer_id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [serial],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'serial_number' = $1`, params: [serial] },
    },
    citationRequired: true,
  };
}

/** Reverse lookup: given a phone number (any punctuation), the customer's name — matched digits-only so
 *  the question's own formatting (spoken-aloud, dashes, dots, parens) never has to match the stored
 *  string's formatting exactly. Guarded to a single match. */
function phoneToName({ id, text, phoneDigits }) {
  return {
    id, text, category: CATEGORY, shape: "lookup_phone", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND regexp_replace(coalesce(data->>'phone',''), '\\D', '', 'g') = $1)
SELECT data->>'customer_name' AS v FROM entities WHERE id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [phoneDigits],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND regexp_replace(coalesce(data->>'phone',''), '\\D', '', 'g') = $1`, params: [phoneDigits] },
    },
    citationRequired: true,
  };
}

/** Honest-decline oracle: guardSql computes n; n=0 means "still must decline under today's data" (never
 *  skipped — the normal case for a structurally-absent fact), n>0 means the premise no longer holds and
 *  the question gracefully SKIPs instead of being scored wrong forever. */
function decline({ id, text, shape, guardSql, guardParams = [], why }) {
  return { id, text, category: CATEGORY, shape, cmp: "honest-zero", oracle: { sql: guardSql, params: guardParams }, note: why };
}

/** A field_key that is NEVER extracted anywhere in this corpus (verified directly against the golden
 *  export's own extractions table) — every phrasing of a question asking for it shares this one guard. */
function neverOnFieldDecline({ id, text, shape, fieldKeys, why }) {
  const list = fieldKeys.map((k) => `'${k}'`).join(", ");
  return decline({ id, text, shape, guardSql: `SELECT (SELECT count(*) FROM extractions WHERE field_key IN (${list})) AS n`, why });
}

/** The R16_CONTRACT owner decision's "several matches, no disambiguator -> ask which one (list them)" —
 *  graded as a `set` of the matching customers' full names, so an uncommitted decline still fails
 *  (nothing to cite/name) and naming only one of several also fails (recall), but actually listing every
 *  candidate passes. */
function ambiguitySet({ id, text, shape, namePattern, why }) {
  return {
    id, text, category: CATEGORY, shape, cmp: "set", note: why,
    oracle: { sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [namePattern] },
  };
}

function numberQ({ id, text, shape, sql, params = [], expectedNote, tolerance, anyNumber, citationRequired }) {
  const q = { id, text, category: CATEGORY, shape, cmp: "number", oracle: { sql, params }, note: expectedNote };
  if (Number.isFinite(tolerance)) q.tolerance = tolerance;
  if (anyNumber) q.anyNumber = true;
  if (citationRequired === false) q.citationRequired = false;
  return q;
}

function valueQ({ id, text, shape, sql, params = [], requires, citationRequired = true }) {
  const o = { sql, params };
  if (requires) o.requires = requires;
  return { id, text, category: CATEGORY, shape, cmp: "value", oracle: o, citationRequired };
}

function yesNoQ({ id, text, shape, sql, params = [], citationRequired = true }) {
  return { id, text, category: CATEGORY, shape, cmp: "yesno", oracle: { sql, params }, citationRequired };
}

function rubricQ({ id, text, shape, rubric, keyFacts }) {
  // R21 (L4 rubric grader, review fix): `keyFacts` is optional and additive only (see
  // keyFactGrader.js's own doc comment) — appended last, after `oracle`, so every existing call
  // with no keyFacts (the overwhelming majority) produces byte-identical output to before, and
  // this stays in sync with test-docs/scorecard/generalization/field-phrasing-2.json's own
  // checked-in keyFacts for h138/h139/h163/h166/h167 (verify-field-phrasing-2.mjs's own "not
  // stale" check compares this generator's output against that file verbatim).
  const q = { id, text, category: CATEGORY, shape, cmp: "rubric", rubric, oracle: { sql: "SELECT NULL::text AS ref WHERE false" } };
  if (keyFacts) q.keyFacts = keyFacts;
  return q;
}

/** "last time we were at <address>" — most recent service_date across every document linked to the single
 *  customer at that address. */
function lastVisitAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: CATEGORY, shape: "history", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT x.value AS v FROM extractions x
WHERE x.field_key = 'service_date' AND x.value IS NOT NULL
  AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))
  AND (SELECT count(*) FROM m) = 1
ORDER BY x.value DESC LIMIT 1`,
      params: [addressPrefix],
    },
  };
}

/** "who was out at <address> last" — the technician on the most-recent-dated document for that address. */
function lastTechAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: CATEGORY, shape: "history", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1),
docs AS (SELECT x.document_id, x.value AS service_date FROM extractions x WHERE x.field_key='service_date' AND x.value IS NOT NULL
         AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m)))
SELECT t.value AS v FROM extractions t
WHERE t.field_key='technician' AND t.document_id = (SELECT document_id FROM docs ORDER BY service_date DESC LIMIT 1)
  AND (SELECT count(*) FROM m) = 1`,
      params: [addressPrefix],
    },
  };
}

/** "when did we last service <surname>" — max service_date across every customer matching the bare
 *  surname; objectively well-defined even when the surname itself is ambiguous (a time superlative
 *  aggregates cleanly, unlike a per-record field value). */
function lastVisitByName(id, text, namePattern) {
  return {
    id, text, category: CATEGORY, shape: "history", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT x.value AS v FROM extractions x
WHERE x.field_key = 'service_date' AND x.value IS NOT NULL
  AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))
ORDER BY x.value DESC LIMIT 1`,
      params: [namePattern],
    },
  };
}

/** Categorical warranty status ('active'/'expired'/'unknown') at a single-match address, as of `today`. */
function warrantyStatusAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: CATEGORY, shape: "warranty", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $2)
SELECT (CASE WHEN (e.data#>>'{warranty,expires}') IS NULL THEN 'unknown'
             WHEN (e.data#>>'{warranty,expires}')::date > $1::date THEN 'active' ELSE 'expired' END) AS v
FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [TODAY, addressPrefix],
    },
    citationRequired: true,
  };
}

/** Categorical warranty status by CITY substring (single-match), for the "colloquial place reference
 *  instead of a name/street" phrasing family. */
function warrantyStatusAtCity(id, text, cityPattern) {
  return {
    id, text, category: CATEGORY, shape: "warranty", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $2)
SELECT (CASE WHEN (e.data#>>'{warranty,expires}') IS NULL THEN 'unknown'
             WHEN (e.data#>>'{warranty,expires}')::date > $1::date THEN 'active' ELSE 'expired' END) AS v
FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [TODAY, cityPattern],
    },
    citationRequired: true,
  };
}

/** The exact warranty expiry date on file at a single-match address. */
function warrantyExpiresAtAddress(id, text, addressPrefix) {
  return valueQ({
    id, text, shape: "warranty",
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
    params: [addressPrefix],
  });
}

/** "is <full name> still under warranty" — yes/no by exact expiry-vs-today comparison. */
function warrantyYesNoByName(id, text, namePattern) {
  return yesNoQ({
    id, text, shape: "warranty",
    sql: `SELECT (e.data#>>'{warranty,expires}')::date > $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE $2 AND e.data#>>'{warranty,expires}' IS NOT NULL AND (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $2) = 1`,
    params: [TODAY, namePattern],
  });
}

/** Last invoice total at a single-match address (guarded via `requires` so an address with no invoice on
 *  file skips rather than being graded "$0"). */
function invoiceTotalAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: CATEGORY, shape: "money", cmp: "number", tolerance: 0.5, anyNumber: true,
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT df.total AS n FROM document_financials df
WHERE df.doc_kind='invoice' AND df.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))
  AND (SELECT count(*) FROM m) = 1
ORDER BY df.invoice_date DESC NULLS LAST LIMIT 1`,
      params: [addressPrefix],
      requires: {
        sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT count(*) AS n FROM document_financials df WHERE df.doc_kind='invoice' AND df.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))`,
        params: [addressPrefix],
      },
    },
  };
}

/** Two field values at a single-match address, as a `set` (both must be named, neither silently dropped). */
function twoFieldAtAddress(id, text, addressPrefix, field1, field2) {
  return {
    id, text, category: CATEGORY, shape: "compound", cmp: "set",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data->>'${field1}' AS item FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1
UNION ALL
SELECT e.data->>'${field2}' AS item FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1`,
      params: [addressPrefix],
    },
  };
}

/** No antecedent named at all (a mid-conversation follow-up expressed standalone) — must always ask, never
 *  guess which prior subject is meant. */
function noAntecedentDecline({ id, text, shape }) {
  return decline({ id, text, shape, guardSql: "SELECT 0 AS n", why: "no subject named at all in a 120-customer tenant - a standalone follow-up with nothing to resolve against" });
}

const questions = [];

/* ================================================================== A. lookup_serial (h001-h008) */
const SERIAL_LOOKUPS = [
  ["h001", "whose unit has serial Y100007", "Y100007"],
  ["h002", "got a serial LX100005 here, who's that for", "LX100005"],
  ["h003", "who's serial number 2R100006 belong to", "2R100006"],
  ["h004", "customer for serial M100009", "M100009"],
  ["h005", "serial 2C100011 - whose account is this", "2C100011"],
  ["h006", "trying to id serial 2G100004, whose job is it", "2G100004"],
  ["h007", "who owns the unit serial F100018", "F100018"],
  ["h008", "serial D100016, who's the customer", "D100016"],
];
for (const [id, text, serial] of SERIAL_LOOKUPS) questions.push(serialToName({ id, text, serial }));

/* ================================================================== B. lookup_phone (h009-h016) */
const PHONE_LOOKUPS = [
  ["h009", "whos calling from 480 555 0112", "4805550112"],
  ["h010", "caller id says 480-555-0113, who is that", "4805550113"],
  ["h011", "who's number is (480) 555-0114", "4805550114"],
  ["h012", "got a call from 4805550119, whose account", "4805550119"],
  ["h013", "who is 480.555.0121", "4805550121"],
  ["h014", "customer with phone 480 555 0124", "4805550124"],
  ["h015", "whose phone number is 480-555-0129", "4805550129"],
  ["h016", "480.555.0132 - who's this", "4805550132"],
];
for (const [id, text, digits] of PHONE_LOOKUPS) questions.push(phoneToName({ id, text, phoneDigits: digits }));

/* ================================================================== C. lookup_name_ambiguous (h017-h028) */
const AMBIGUOUS_SURNAMES = [
  ["h017", "whats the address on file for vance", "%Vance%"],
  ["h018", "phone number for the alvarez account", "%Alvarez%"],
  ["h019", "serial on nakamura's unit", "%Nakamura%"],
  ["h020", "model number for zimmerman", "%Zimmerman%"],
  ["h021", "whats lombardi's service address", "%Lombardi%"],
  ["h022", "wyckoff account, whats their phone", "%Wyckoff%"],
  ["h023", "unit installed for villegas", "%Villegas%"],
  ["h024", "garrison job, whats the serial", "%Garrison%"],
  ["h025", "tovar account phone number", "%Tovar%"],
  ["h026", "whats on file for keller", "%Keller%"],
  ["h027", "address for the rios account", "%Rios%"],
  ["h028", "phone number for salazar", "%Salazar%"],
];
for (const [id, text, pat] of AMBIGUOUS_SURNAMES) {
  questions.push(ambiguitySet({ id, text, shape: "ambiguous_name", namePattern: pat, why: "bare surname matches 2+ distinct customers in this tenant - must ask which one, never silently pick" }));
}

/* ================================================================== D. lookup_address_variant (h029-h036) */
const VARIANT_ADDR = [
  ["h029", "whos the manufacturer on the unit at 581 West Thomas Road", "581 W Thomas Rd%", "manufacturer"],
  ["h030", "model # at 1062 e university dr, phoenix az", "1062 E University Dr%", "model"],
  ["h031", "serial for 1099 W Guadalupe Road, 85001", "1099 W Guadalupe Rd%", "serial_number"],
  ["h032", "whos the mfr at 1136 East Elliot Rd, Phoenix, AZ", "1136 E Elliot Rd%", "manufacturer"],
  ["h033", "model number on the unit at 1173 N Greenfield Road", "1173 N Greenfield Rd%", "model"],
  ["h034", "serial number for 1247 West Baseline Rd", "1247 W Baseline Rd%", "serial_number"],
  ["h035", "tonnage on the unit at 1358 N Dobson Road, Phoenix", "1358 N Dobson Rd%", "tonnage"],
  ["h036", "whats installed at 1469 North Power Rd", "1469 N Power Rd%", "manufacturer"],
];
for (const [id, text, addr, col] of VARIANT_ADDR) questions.push(addressValue({ id, text, shape: "field_lookup_variant_address", addressPrefix: addr, fieldCol: col }));

/* ================================================================== E. warranty_status (h037-h046) */
questions.push(warrantyExpiresAtAddress("h037", "when does the warranty run out at 1691 s ellsworth rd", "1691 S Ellsworth Rd%"));
questions.push(warrantyExpiresAtAddress("h038", "warranty expiration date for 2135 S Alma School Rd", "2135 S Alma School Rd%"));
questions.push(warrantyExpiresAtAddress("h039", "whens the warranty expire at 2172 e chandler blvd", "2172 E Chandler Blvd%"));
questions.push(warrantyExpiresAtAddress("h040", "warranty end date on file for 3282 W Camelback Rd", "3282 W Camelback Rd%"));
questions.push(warrantyYesNoByName("h041", "is Amy Isaacson still under warranty", "%Amy Isaacson%"));
questions.push(warrantyYesNoByName("h042", "is Rebecca Montoya's system still covered", "%Rebecca Montoya%"));
questions.push(warrantyYesNoByName("h043", "is Jessica Bennett still under warranty", "%Jessica Bennett%"));
questions.push(warrantyYesNoByName("h044", "is Steven Ellison still covered under warranty", "%Steven Ellison%"));
questions.push(ambiguitySet({ id: "h045", text: "warranty status on larkin", shape: "warranty", namePattern: "%Larkin%", why: "bare surname matches 2 distinct customers - must ask which one" }));
questions.push(ambiguitySet({ id: "h046", text: "is redwine still under warranty", shape: "warranty", namePattern: "%Redwine%", why: "bare surname matches 2 distinct customers - must ask which one" }));

/* ================================================================== F. warranty_time_range (h047-h054) */
questions.push(numberQ({
  id: "h047", text: "how many units had their warranty expire in the past year", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date <= $1::date AND (data#>>'{warranty,expires}')::date > ($1::date - interval '365 days')`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h048", text: "any warranties expiring in the next 90 days", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date >= $1::date AND (data#>>'{warranty,expires}')::date <= ($1::date + interval '90 days')`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h049", text: "how many warranties expire by the end of this calendar year", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date >= $1::date AND (data#>>'{warranty,expires}')::date <= date_trunc('year', $1::date) + interval '1 year' - interval '1 day'`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h050", text: "how many carrier units are still under warranty", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'carrier' AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date > $1::date`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h051", text: "how many units warranty has expired so far this year", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date >= date_trunc('year', $1::date) AND (data#>>'{warranty,expires}')::date <= $1::date`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h052", text: "how many units have no warranty registration on file", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,registrationState}' = 'unknown'`,
  params: [],
}));
questions.push(numberQ({
  id: "h053", text: "how many units are actually registered for warranty", shape: "warranty_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,registrationState}' = 'on_file'`,
  params: [],
}));
questions.push(valueQ({
  id: "h054", text: "whats the earliest warranty expiration we have on file", shape: "warranty_time_range",
  sql: `SELECT data#>>'{warranty,expires}' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,expires}' IS NOT NULL ORDER BY data#>>'{warranty,expires}' ASC LIMIT 1`,
  params: [],
}));

/* ================================================================== G. history_last_visit (h055-h064) */
questions.push(lastVisitAtAddress("h055", "last time we were out at 3171 n power rd", "3171 N Power Rd%"));
questions.push(lastTechAtAddress("h056", "who went out to 3282 W Camelback Rd last", "3282 W Camelback Rd%"));
questions.push(lastVisitAtAddress("h057", "when were we last at 3393 s ellsworth rd", "3393 S Ellsworth Rd%"));
questions.push(lastTechAtAddress("h058", "who was the last tech out at 3467 N Recker Rd", "3467 N Recker Rd%"));
questions.push(lastVisitByName("h059", "when did we last go out for alvarez", "%Alvarez%"));
questions.push(lastVisitAtAddress("h060", "last time we serviced 3541 w southern ave", "3541 W Southern Ave%"));
questions.push(lastTechAtAddress("h061", "whos the last tech that went to 3689 E Elliot Rd", "3689 E Elliot Rd%"));
questions.push(lastVisitAtAddress("h062", "when was our last visit to 3763 e broadway rd", "3763 E Broadway Rd%"));
questions.push(neverOnFieldDecline({ id: "h063", text: "who installed the unit at 3800 w baseline rd", shape: "history", fieldKeys: ["installer"], why: "no document in this corpus ever carries an installer field" }));
questions.push(lastVisitByName("h064", "whens the last time we serviced someone named osborn", "%Osborn%"));

/* ================================================================== H. history_time_range (h065-h074) */
questions.push(numberQ({
  id: "h065", text: "how many jobs have we done since january 1st", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= date_trunc('year', $1::date) AND value::date <= $1::date`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h066", text: "any service calls in the last 90 days", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '90 days') AND value::date <= $1::date`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h067", text: "how many service visits did we log this past summer", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND extract(year from value::date) = extract(year from $1::date) AND extract(month from value::date) IN (6,7,8)`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  id: "h068", text: "did we do any work at 285 e elliot rd in the last 90 days", shape: "history_time_range",
  sql: `SELECT EXISTS (
    SELECT 1 FROM extractions x
    WHERE x.field_key='service_date' AND x.value IS NOT NULL AND x.value::date >= ($1::date - interval '90 days') AND x.value::date <= $1::date
      AND x.document_id IN (SELECT l.document_id FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.entity_type='customer' AND c.data->>'service_address' ILIKE '285 E Elliot Rd%')
  ) AS v`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h069", text: "how many jobs have we done this spring", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND extract(year from value::date) = extract(year from $1::date) AND extract(month from value::date) IN (3,4,5)`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  id: "h070", text: "have we had any repair calls in the past week", shape: "history_time_range",
  sql: `SELECT EXISTS (
    SELECT 1 FROM extractions x
    WHERE x.field_key='service_type' AND x.value='Repair'
      AND EXISTS (SELECT 1 FROM extractions s WHERE s.document_id = x.document_id AND s.field_key='service_date' AND s.value IS NOT NULL AND s.value::date >= ($1::date - interval '7 days') AND s.value::date <= $1::date)
  ) AS v`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h071", text: "how many maintenance agreements have we signed since 2020", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(DISTINCT d.id) AS n FROM documents d
WHERE d.document_type='maintenance-agreement' AND EXISTS (
  SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.field_key='service_date' AND x.value IS NOT NULL AND x.value::date >= '2020-01-01'::date
)`,
  params: [],
}));
questions.push(numberQ({
  id: "h072", text: "how many invoices did we send out last quarter", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL
AND invoice_date >= (date_trunc('quarter', $1::date) - interval '3 months') AND invoice_date < date_trunc('quarter', $1::date)`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  id: "h073", text: "has there been any activity at all this month", shape: "history_time_range",
  sql: `SELECT EXISTS (SELECT 1 FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND date_trunc('month', value::date) = date_trunc('month', $1::date)) AS v`,
  params: [TODAY],
}));
questions.push(numberQ({
  id: "h074", text: "how many different years do we have customers on file for", shape: "history_time_range", tolerance: 0, citationRequired: false,
  sql: `SELECT count(DISTINCT extract(year from value::date)) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL`,
  params: [],
}));

/* ================================================================== I. money (h075-h082) */
questions.push(invoiceTotalAtAddress("h075", "how much did the job at 803 e pecos rd come to", "803 E Pecos Rd%"));
questions.push(invoiceTotalAtAddress("h076", "last invoice total for 877 w ocotillo rd", "877 W Ocotillo Rd%"));
questions.push(invoiceTotalAtAddress("h077", "what did we bill at 914 n recker rd", "914 N Recker Rd%"));
questions.push(invoiceTotalAtAddress("h078", "how much was the job at 951 e main st", "951 E Main St%"));
questions.push(invoiceTotalAtAddress("h079", "invoice total for 618 n power rd", "618 N Power Rd%"));
questions.push(decline({ id: "h080", text: "hows the balance looking on accounts that havent paid", shape: "money", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE balance_due IS NOT NULL) AS n`, why: "balance_due is NULL on every document_financials row in this tenant" }));
questions.push(decline({ id: "h081", text: "whats still owed on the norwood account", shape: "money", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE balance_due IS NOT NULL) AS n`, why: "balance_due is NULL on every document_financials row in this tenant" }));
questions.push(decline({ id: "h082", text: "any invoices from last quarter thats still open", shape: "money", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE status IN ('unpaid','partial')) AS n`, why: "every invoice's status is 'unknown' - none is knowably 'open'" }));

/* ================================================================== J. multi_hop_mfg_maintenance (h083-h090) */
function mfgWithMaintenanceCount(id, text, mfg) {
  return numberQ({
    id, text, shape: "multi_hop", tolerance: 0, citationRequired: false,
    sql: `SELECT count(DISTINCT e.customer_id) AS n
FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE '${mfg}'
  AND EXISTS (
    SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id
    WHERE d.document_type = 'maintenance-agreement' AND (l.entity_id = e.customer_id OR l.entity_id = e.id)
  )`,
    params: [],
  });
}
questions.push(mfgWithMaintenanceCount("h083", "how many trane customers have a maintenance agreement on file", "trane"));
questions.push(mfgWithMaintenanceCount("h084", "how many carrier customers have a maintenance agreement on file", "carrier"));
questions.push(mfgWithMaintenanceCount("h085", "how many goodman customers have a maintenance agreement on file", "goodman"));
questions.push(mfgWithMaintenanceCount("h086", "how many lennox customers have a maintenance agreement on file", "lennox"));
questions.push(mfgWithMaintenanceCount("h087", "how many rheem customers have a maintenance agreement on file", "rheem"));
questions.push(mfgWithMaintenanceCount("h088", "how many york customers have a maintenance agreement on file", "york"));
questions.push(mfgWithMaintenanceCount("h089", "how many daikin customers have a maintenance agreement on file", "daikin"));
questions.push(mfgWithMaintenanceCount("h090", "how many mitsubishi customers have a maintenance agreement on file", "mitsubishi"));

/* ================================================================== K. multi_hop_warranty_city (h091-h098) */
function mfgCityActiveCount(id, text, city, mfg) {
  return numberQ({
    id, text, shape: "multi_hop", tolerance: 0, citationRequired: false,
    sql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id = e.customer_id
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE '${mfg}'
  AND c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE '%, ${city},%'
  AND (e.data#>>'{warranty,expires}') IS NOT NULL AND (e.data#>>'{warranty,expires}')::date > $1::date`,
    params: [TODAY],
  });
}
questions.push(mfgCityActiveCount("h091", "how many trane units in mesa are still under warranty", "Mesa", "trane"));
questions.push(mfgCityActiveCount("h092", "how many carrier units in chandler are still under warranty", "Chandler", "carrier"));
questions.push(mfgCityActiveCount("h093", "how many goodman units in gilbert are still under warranty", "Gilbert", "goodman"));
questions.push(mfgCityActiveCount("h094", "how many lennox units in tempe are still under warranty", "Tempe", "lennox"));
questions.push(mfgCityActiveCount("h095", "how many rheem units in tucson are still under warranty", "Tucson", "rheem"));
questions.push(mfgCityActiveCount("h096", "how many york units in scottsdale are still under warranty", "Scottsdale", "york"));
questions.push(mfgCityActiveCount("h097", "how many daikin units in casa grande are still under warranty", "Casa Grande", "daikin"));
questions.push(mfgCityActiveCount("h098", "how many mitsubishi units in maricopa are still under warranty", "Maricopa", "mitsubishi"));

/* ================================================================== L. multi_hop_repair_mfg (h099-h106) */
function mfgRepairCount(id, text, mfg) {
  return numberQ({
    id, text, shape: "multi_hop", tolerance: 0, citationRequired: false,
    sql: `SELECT count(DISTINCT e.customer_id) AS n
FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE '${mfg}'
  AND EXISTS (
    SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id = l.document_id
    WHERE x.field_key='service_type' AND x.value='Repair' AND (l.entity_id = e.customer_id OR l.entity_id = e.id)
  )`,
    params: [],
  });
}
questions.push(mfgRepairCount("h099", "how many trane customers needed a repair visit", "trane"));
questions.push(mfgRepairCount("h100", "how many carrier customers have had a repair call", "carrier"));
questions.push(mfgRepairCount("h101", "how many goodman customers needed a repair visit", "goodman"));
questions.push(mfgRepairCount("h102", "how many lennox customers have had a repair call", "lennox"));
questions.push(mfgRepairCount("h103", "how many rheem customers needed a repair visit", "rheem"));
questions.push(mfgRepairCount("h104", "how many york customers have had a repair call", "york"));
questions.push(mfgRepairCount("h105", "how many daikin customers needed a repair visit", "daikin"));
questions.push(neverOnFieldDecline({ id: "h106", text: "which trane customers had a callback", shape: "multi_hop", fieldKeys: ["callback", "callback_reason", "return_visit_reason"], why: "'callback' is never a recorded concept in this corpus (no such field key exists) - only service_type Repair/Preventive Maintenance is on file, which is not the same claim" }));

/* ================================================================== M. ranking (h107-h116) */
questions.push(valueQ({ id: "h107", text: "which manufacturer do we have the most units of", shape: "ranking", sql: `SELECT data->>'manufacturer' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL GROUP BY data->>'manufacturer' ORDER BY count(*) DESC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h108", text: "which city do we have the most customers in", shape: "ranking", sql: `SELECT substring(data->>'service_address' from ', ([A-Za-z ]+), [A-Z]{2} ') AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h109", text: "whos our busiest technician", shape: "ranking", sql: `SELECT value AS v FROM extractions WHERE field_key='technician' AND value IS NOT NULL GROUP BY value ORDER BY count(*) DESC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h110", text: "whats the oldest trane unit we have on file", shape: "ranking", sql: `SELECT data->>'installation_date' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'trane' AND data->>'installation_date' IS NOT NULL ORDER BY data->>'installation_date' ASC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h111", text: "which zip code do we have the most customers in", shape: "ranking", sql: `SELECT substring(data->>'service_address' from '(\\d{5})$') AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`, params: [] }));
questions.push(numberQ({ id: "h112", text: "how many customers are in our single biggest city", shape: "ranking", tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n FROM (SELECT substring(data->>'service_address' from ', ([A-Za-z ]+), [A-Z]{2} ') AS city FROM entities WHERE entity_type='customer' AND merged_into IS NULL) t GROUP BY city ORDER BY count(*) DESC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h113", text: "which manufacturer do we have the fewest units of", shape: "ranking", sql: `SELECT data->>'manufacturer' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL GROUP BY data->>'manufacturer' ORDER BY count(*) ASC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h114", text: "whats our newest mitsubishi install", shape: "ranking", sql: `SELECT data->>'installation_date' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'mitsubishi' AND data->>'installation_date' IS NOT NULL ORDER BY data->>'installation_date' DESC LIMIT 1`, params: [] }));
questions.push(valueQ({ id: "h115", text: "which tech has done the fewest visits", shape: "ranking", sql: `SELECT value AS v FROM extractions WHERE field_key='technician' AND value IS NOT NULL GROUP BY value ORDER BY count(*) ASC LIMIT 1`, params: [] }));
questions.push(numberQ({ id: "h116", text: "how many different technicians do we have on file", shape: "ranking", tolerance: 0, citationRequired: false, sql: `SELECT count(DISTINCT value) AS n FROM extractions WHERE field_key='technician' AND value IS NOT NULL`, params: [] }));

/* ================================================================== N. comparison (h117-h124) */
questions.push(yesNoQ({ id: "h117", text: "do we have more customers in mesa than in tucson", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Mesa,%') > (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Tucson,%') AS v`, params: [] }));
questions.push(yesNoQ({ id: "h118", text: "do we have more mitsubishi units installed than trane", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'mitsubishi') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'trane') AS v`, params: [] }));
questions.push(yesNoQ({ id: "h119", text: "does tempe have more customers than peoria", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Tempe,%') > (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Peoria,%') AS v`, params: [] }));
questions.push(yesNoQ({
  id: "h120", text: "has Rebecca Montoya had more documents on file than Charles Montoya", shape: "comparison",
  sql: `SELECT (SELECT count(DISTINCT l.document_id) FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.data->>'customer_name' ILIKE '%Rebecca Montoya%')
      > (SELECT count(DISTINCT l.document_id) FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.data->>'customer_name' ILIKE '%Charles Montoya%') AS v`,
  params: [],
}));
questions.push(yesNoQ({
  id: "h121", text: "was the job at 803 e pecos rd bigger than the job at 877 w ocotillo rd", shape: "comparison",
  sql: `SELECT (
    (SELECT df.total FROM document_financials df JOIN document_entity_links l ON l.document_id=df.document_id JOIN entities c ON c.id=l.entity_id WHERE df.doc_kind='invoice' AND c.data->>'service_address' ILIKE '803 E Pecos Rd%' ORDER BY df.invoice_date DESC NULLS LAST LIMIT 1)
    >
    (SELECT df.total FROM document_financials df JOIN document_entity_links l ON l.document_id=df.document_id JOIN entities c ON c.id=l.entity_id WHERE df.doc_kind='invoice' AND c.data->>'service_address' ILIKE '877 W Ocotillo Rd%' ORDER BY df.invoice_date DESC NULLS LAST LIMIT 1)
  ) AS v`,
  params: [],
}));
questions.push(yesNoQ({ id: "h122", text: "do we have more registered warranties than unregistered ones", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,registrationState}'='on_file') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,registrationState}'='unknown') AS v`, params: [] }));
questions.push(yesNoQ({
  id: "h123", text: "has copper sky dental had more jobs than canyon view dental", shape: "comparison",
  sql: `SELECT (SELECT count(DISTINCT l.document_id) FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.data->>'customer_name' ILIKE '%Copper Sky Dental%')
      > (SELECT count(DISTINCT l.document_id) FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.data->>'customer_name' ILIKE '%Canyon View Dental%') AS v`,
  params: [],
}));
questions.push(yesNoQ({ id: "h124", text: "is daikin more common than goodman in our records", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'daikin') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'goodman') AS v`, params: [] }));

/* ================================================================== O. negation_exclusion (h125-h134) */
questions.push(numberQ({ id: "h125", text: "how many customers have never had a preventive maintenance visit", shape: "negation", tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (
  SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id = l.document_id
  WHERE x.field_key='service_type' AND x.value='Preventive Maintenance'
    AND (l.entity_id = c.id OR l.entity_id IN (SELECT id FROM entities e WHERE e.entity_type='equipment' AND e.customer_id=c.id))
)`, params: [] }));
questions.push(yesNoQ({ id: "h126", text: "have we ever installed a bryant system", shape: "negation", sql: `SELECT EXISTS (SELECT 1 FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'bryant') AS v`, params: [] }));
questions.push(numberQ({ id: "h127", text: "how many customers have had only preventive maintenance, never a repair", shape: "negation", tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL
  AND EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Preventive Maintenance' AND (l.entity_id=c.id OR l.entity_id IN (SELECT id FROM entities e WHERE e.entity_type='equipment' AND e.customer_id=c.id)))
  AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Repair' AND (l.entity_id=c.id OR l.entity_id IN (SELECT id FROM entities e WHERE e.entity_type='equipment' AND e.customer_id=c.id)))`, params: [] }));
questions.push(numberQ({ id: "h128", text: "how many units have no tonnage listed", shape: "negation", tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND coalesce(data->>'tonnage','')=''`, params: [] }));
questions.push(valueQ({ id: "h129", text: "which manufacturer has the most units with no warranty registration on file", shape: "negation", sql: `SELECT data->>'manufacturer' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,registrationState}'='unknown' GROUP BY data->>'manufacturer' ORDER BY count(*) DESC LIMIT 1`, params: [] }));
questions.push(decline({ id: "h130", text: "who hasnt paid their invoice yet", shape: "negation", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE status = 'unpaid') AS n`, why: "no invoice is ever marked 'unpaid' in this tenant's status field - all are 'unknown'" }));
questions.push(rubricQ({ id: "h131", text: "everyone except the hutchins family who had a repair done this year", shape: "negation", rubric: "Every customer with a Repair-type service visit in the current calendar year, excluding every Hutchins customer by name; must apply both the time filter and the exclusion, not just one." }));
questions.push(numberQ({ id: "h132", text: "how many units are not currently under warranty", shape: "negation", tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date <= $1::date`, params: [TODAY] }));
questions.push(yesNoQ({ id: "h133", text: "do we have any amana equipment in this tenant", shape: "negation", sql: `SELECT EXISTS (SELECT 1 FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'amana') AS v`, params: [] }));
questions.push(numberQ({ id: "h134", text: "how many customers have zero equipment on file", shape: "negation", tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id=c.id)`, params: [] }));

/* ================================================================== P. ambiguous_multiunit_new (h135-h140) */
questions.push(numberQ({ id: "h135", text: "how many units total does canyon view dental have", shape: "ambiguous_multiunit", tolerance: 0, sql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Canyon View Dental%'`, params: [] }));
questions.push({
  id: "h136", text: "what manufacturers are on file at mesquite table restaurant", category: CATEGORY, shape: "ambiguous_multiunit", cmp: "set",
  oracle: { sql: `SELECT DISTINCT e.data->>'manufacturer' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Mesquite Table Restaurant%'`, params: [] },
});
questions.push({
  id: "h137", text: "list every serial number on file for sunrise valley elementary", category: CATEGORY, shape: "ambiguous_multiunit", cmp: "set",
  oracle: { sql: `SELECT e.data->>'serial_number' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Sunrise Valley Elementary%'`, params: [] },
});
questions.push(rubricQ({ id: "h138", text: "whats the refrigerant situation at copper sky dental", shape: "ambiguous_multiunit", rubric: "2 units at Copper Sky Dental (Trane/Carrier) - only the Trane has a refrigerant on file (R-410A); must not silently report just one unit as if it were the only one, and must not invent a value for the Carrier.", keyFacts: { required: [{ type: "text", value: "Trane" }, { type: "text", value: "R-410A" }, { type: "text", value: "Carrier" }, { type: "text", value: ["not on file", "no refrigerant"] }] } }));
questions.push(rubricQ({ id: "h139", text: "tonnage on the units at sonoran grill restaurant", shape: "ambiguous_multiunit", rubric: "2 units at Sonoran Grill Restaurant (Carrier/Goodman) - only the Carrier has a tonnage on file (3 ton); must not silently report just one unit as if it were the only one.", keyFacts: { required: [{ type: "text", value: "Carrier" }, { type: "text", value: "Goodman" }, { type: "text", value: "3 ton" }, { type: "text", value: ["not on file", "no tonnage"] }] } }));
questions.push({
  id: "h140", text: "when were the units at canyon view dental installed", category: CATEGORY, shape: "ambiguous_multiunit", cmp: "set",
  oracle: { sql: `SELECT e.data->>'installation_date' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Canyon View Dental%'`, params: [] },
});

/* ================================================================== Q. unanswerable_never_on_file (h141-h150) */
questions.push(neverOnFieldDecline({ id: "h141", text: "whats the btu rating on the unit at 803 e pecos rd", shape: "unanswerable", fieldKeys: ["btu_rating", "btu"], why: "BTU rating is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h142", text: "duct size for the unit at 877 w ocotillo rd", shape: "unanswerable", fieldKeys: ["duct_size"], why: "duct size is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h143", text: "whats the thermostat brand at 914 n recker rd", shape: "unanswerable", fieldKeys: ["thermostat_brand", "thermostat_model"], why: "thermostat brand/model is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h144", text: "capacitor size on the unit at 951 e main st", shape: "unanswerable", fieldKeys: ["capacitor_size"], why: "capacitor size is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h145", text: "whats the breaker size for 618 n power rd", shape: "unanswerable", fieldKeys: ["breaker_size"], why: "breaker size is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h146", text: "energy star rating on the unit at 692 s higley rd", shape: "unanswerable", fieldKeys: ["energy_star_rating"], why: "energy star rating is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h147", text: "sound rating in decibels for 507 n dobson rd", shape: "unanswerable", fieldKeys: ["sound_rating", "sound_rating_db"], why: "sound rating is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h148", text: "condenser location for the unit at 433 s alma school rd", shape: "unanswerable", fieldKeys: ["condenser_location"], why: "condenser location is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h149", text: "whats the filter brand on the unit at 581 w thomas rd", shape: "unanswerable", fieldKeys: ["filter_brand"], why: "filter brand is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ id: "h150", text: "gps coordinates for the job at 359 e broadway rd", shape: "unanswerable", fieldKeys: ["gps_coordinates", "latitude", "longitude"], why: "gps coordinates are never an extracted field in this corpus" }));

/* ================================================================== R. out_of_domain (h151-h158) */
const NEVER_HVAC_CONTENT = `SELECT 0 AS n`;
questions.push(decline({ id: "h151", text: "whats the weather like today", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "no HVAC record could ever answer this" }));
questions.push(decline({ id: "h152", text: "can you write me a poem about air conditioning", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "not a records question at all" }));
questions.push(decline({ id: "h153", text: "whats 47 times 12", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "arithmetic, not a records lookup" }));
questions.push(decline({ id: "h154", text: "who won the world series last year", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "no HVAC content, no anchor" }));
questions.push(decline({ id: "h155", text: "tell me a joke", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "not a records question" }));
questions.push(decline({ id: "h156", text: "how do i reset my email password", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "not an HVAC records question, must not fish for a 'reset'-adjacent field" }));
questions.push(decline({ id: "h157", text: "wheres the nearest gas station", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "not a records question - must not confuse for a service-address lookup" }));
questions.push(decline({ id: "h158", text: "translate 'under warranty' into spanish", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "must not trigger the warranty intent on the word 'warranty' appearing in a translation request" }));

/* ================================================================== S. compound (h159-h168) */
questions.push(twoFieldAtAddress("h159", "quick one, whats the model and serial at 803 e pecos rd", "803 E Pecos Rd%", "model", "serial_number"));
questions.push(twoFieldAtAddress("h160", "model and serial for 951 e main st please", "951 E Main St%", "model", "serial_number"));
questions.push({
  id: "h161", text: "whats the customer name and phone for 618 n power rd", category: CATEGORY, shape: "compound", cmp: "set",
  oracle: {
    sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '618 N Power Rd%'
UNION ALL SELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '618 N Power Rd%'`,
    params: [],
  },
});
questions.push({
  id: "h162", text: "name and phone number for 692 s higley rd", category: CATEGORY, shape: "compound", cmp: "set",
  oracle: {
    sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '692 S Higley Rd%'
UNION ALL SELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '692 S Higley Rd%'`,
    params: [],
  },
});
questions.push(rubricQ({ id: "h163", text: "can you tell me who installed it and when for 803 e pecos rd", shape: "compound", rubric: "Installer (not on file - no document ever carries one) AND the install date for 803 E Pecos Rd (Joseph Norwood); both parts must be addressed, not just the date.", keyFacts: { required: [{ type: "text", value: ["not on file", "no installer"] }, { type: "date", value: "2016-12-04" }] } }));
questions.push(rubricQ({ id: "h164", text: "quick q, is nakamura still under warranty and whos the tech that did the install", shape: "compound", rubric: "Warranty status AND installer for 'Nakamura' - the bare surname is ambiguous (3 distinct Nakamura customers) and installer is never on file; both parts need honest handling, not a single confident answer." }));
questions.push(rubricQ({ id: "h165", text: "hows the mesquite table restaurant units looking, both of them still good?", shape: "compound", rubric: "Vague colloquial status check across 2 units at Mesquite Table Restaurant with no field named - must not silently report on only one." }));
questions.push({
  id: "h166", text: "manufacturer and tonnage for the unit at 692 s higley rd", category: CATEGORY, shape: "compound", cmp: "rubric",
  rubric: "The unit at 692 S Higley Rd (Carol Rios, Trane) has a manufacturer on file (Trane) but no tonnage on file - both parts must be addressed, must not invent a tonnage.",
  oracle: { sql: "SELECT NULL::text AS ref WHERE false" },
  keyFacts: { required: [{ type: "text", value: "Trane" }, { type: "text", value: "3 ton" }] },
});
questions.push(rubricQ({ id: "h167", text: "quick one - warranty status and last visit date for 3282 w camelback rd", shape: "compound", rubric: "Warranty status (expired - registered 2022, expires 2022-11-19) AND the most recent service_date for 3282 W Camelback Rd (Angela Ibarra); both parts must be addressed.", keyFacts: { required: [{ type: "date", value: "2022-11-19" }, { type: "text", value: "expired" }, { type: "date", value: "2022-04-25" }] } }));
questions.push(rubricQ({ id: "h168", text: "wheres the trane unit installed in 2017, not the copper sky dental one", shape: "compound", rubric: "More than one Trane unit was installed in 2017 in this tenant besides Copper Sky Dental's, so 'the 2017 one' is itself still ambiguous even after that one exclusion - must not silently pick a single remaining unit without checking." }));

/* ================================================================== T. conversational_followup_standalone (h169-h178) */
const FOLLOWUPS = [
  ["h169", "and what was the serial number again"],
  ["h170", "ok what about the one in chandler instead"],
  ["h171", "same question but for last quarter"],
  ["h172", "and her husband's account, same thing"],
  ["h173", "what about the one before that"],
  ["h174", "can you check the other unit too"],
  ["h175", "and whats the total for that one"],
  ["h176", "put me through to whoever handled it"],
  ["h177", "make that the other address instead"],
  ["h178", "what about the second one on the list"],
];
for (const [id, text] of FOLLOWUPS) questions.push(noAntecedentDecline({ id, text, shape: "conversational_followup" }));

/* ================================================================== U. voice_dictation_typo (h179-h188) */
questions.push(addressValue({ id: "h179", text: "wuts teh moddel number four 803 e pecos rd", shape: "voice_dictation", addressPrefix: "803 E Pecos Rd%", fieldCol: "model" }));
questions.push(addressValue({ id: "h180", text: "serial num fore 951 e main st", shape: "voice_dictation", addressPrefix: "951 E Main St%", fieldCol: "serial_number" }));
questions.push(decline({ id: "h181", text: "hoo makes the unit at seven fifty three w guadalupe rd", shape: "voice_dictation", guardSql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '753%guadalupe%') AS n`, why: "753 W Guadalupe Rd is Copper Sky Dental, a multi-unit site - 'the unit' is ambiguous between 2 units, must not silently pick one" }));
questions.push(warrantyStatusAtAddress("h182", "is the unit at to fourteen mercer under warranty", "214 Mercer%"));
// 214 Mercer does not exist as a house number in this tenant - "to fourteen" (voice-dictation error for
// "214") -> the address guard finds 0 matches -> honest-zero via requires guard (compareValue falls back
// automatically since 0 rows means no v), same convention as the field-phrasing category's g090.
questions.push(decline({ id: "h183", text: "wats teh tonnage @ 618 n power rd", shape: "voice_dictation", guardSql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '618 N Power Rd%') AS n`, why: "618 N Power Rd (Barbara Delgado, Daikin) has no tonnage on file - genuinely not on file, not a lookup miss" }));
questions.push(addressValue({ id: "h184", text: "who's the manufaturer on the unit @ 951 main st", shape: "voice_dictation", addressPrefix: "951 E Main St%", fieldCol: "manufacturer" }));
questions.push(decline({ id: "h185", text: "seriel numbr on the smith account", shape: "voice_dictation", guardSql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE '%smith%') AS n`, why: "no customer named Smith exists in this tenant" }));
questions.push(decline({ id: "h186", text: "wuts the seer raiting on 692 s higley", shape: "voice_dictation", guardSql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='seer_rating') AS n`, why: "SEER is never an extracted field in this corpus" }));
questions.push(addressValue({ id: "h187", text: "installd date on the unit at 877 w ocotilo rd", shape: "voice_dictation", addressPrefix: "877 W Ocotillo Rd%", fieldCol: "installation_date" }));
questions.push(decline({ id: "h188", text: "hows warranty look on the one we did too days ago", shape: "voice_dictation", guardSql: NEVER_HVAC_CONTENT, why: "no address/name subject named at all in a 120-customer tenant" }));

/* ================================================================== V. data_quality (h189-h196) */
questions.push({
  id: "h189", text: "list every customer whose service address isnt even in arizona", category: CATEGORY, shape: "data_quality", cmp: "set",
  oracle: { sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' !~ ', AZ \\d{5}$'`, params: [] },
});
questions.push(nameValue({ id: "h190", text: "whats the phone number on file for ronald dominguez", shape: "data_quality", namePattern: "%Ronald Dominguez%", fieldCol: "phone", onCustomer: true }));
questions.push(warrantyYesNoByName("h191", "is thomas osborn's unit still under warranty", "%Thomas Osborn%"));
questions.push(nameValue({ id: "h192", text: "whats the service address on file for donna vance", shape: "data_quality", namePattern: "%Donna Vance%", fieldCol: "service_address", onCustomer: true }));
questions.push(nameValue({ id: "h193", text: "phone number on file for linda hutchins", shape: "data_quality", namePattern: "%Linda Hutchins%", fieldCol: "phone", onCustomer: true }));
questions.push(addressValue({ id: "h194", text: "whats the serial number on the unit at 3837 s alma school rd", shape: "data_quality", addressPrefix: "3837 S Alma School Rd%", fieldCol: "serial_number" }));
questions.push(nameValue({ id: "h195", text: "what city is the customer at 3911 n dobson rd actually in, per our records", shape: "data_quality", namePattern: "%Ronald Dominguez%", fieldCol: "service_address", onCustomer: true }));
questions.push(warrantyStatusAtCity("h196", "hows the warranty looking for our customer over in albuquerque", "%Albuquerque%"));

/* ================================================================== W. persona_dispatcher_schedule (h197-h200) */
questions.push(noAntecedentDecline({ id: "h197", text: "who do we have going out today", shape: "dispatcher_schedule" }));
questions.push(noAntecedentDecline({ id: "h198", text: "whats on the schedule for tomorrow", shape: "dispatcher_schedule" }));
questions.push(noAntecedentDecline({ id: "h199", text: "is anybody free this afternoon", shape: "dispatcher_schedule" }));
questions.push(noAntecedentDecline({ id: "h200", text: "who's out on calls right now", shape: "dispatcher_schedule" }));

/* ============================================================== output */

if (questions.length !== 200) {
  console.error(`gen-field-phrasing-2: expected 200 questions, built ${questions.length}`);
  process.exit(1);
}
const ids = new Set(questions.map((q) => q.id));
if (ids.size !== 200) {
  console.error(`gen-field-phrasing-2: duplicate ids (${200 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-26.field-phrasing-2-r18",
  category: CATEGORY,
  source: "Round 18 (H2) blind generalization set - 200 new questions, written without reading exam.json/field-phrasing.json question texts or engine regexes; grounded only in scripts/golden/golden-export.json + the exam file format",
  questions,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-field-phrasing-2: wrote ${questions.length} questions -> ${OUT_PATH}`);
  const byCmp = {};
  const byShape = {};
  for (const q of questions) { byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1; byShape[q.shape] = (byShape[q.shape] ?? 0) + 1; }
  console.log("by cmp:", JSON.stringify(byCmp));
  console.log("by shape:", JSON.stringify(byShape));
}

export { questions, out };
