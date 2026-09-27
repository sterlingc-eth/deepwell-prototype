#!/usr/bin/env node
/**
 * FIELD-PHRASING exam category (Round 16, E3) — generates
 * test-docs/scorecard/generalization/field-phrasing.json from the Round-15 auditor's 158 "tired field
 * tech" questions (../r15_generalization_questions.json, one directory above the repo root during that
 * round; a frozen copy of the ones actually used lives inline below so this generator has no dependency
 * on a path outside the repo).
 *
 * WHY A SEPARATE FILE INSTEAD OF exam.json: api/_lib/scorecard/exam.js (engine code, api/**) loads only
 * test-docs/scorecard/exam.json and has no multi-file merge support, and R11_RULES.md forbids editing
 * exam.json or engine code. scripts/offline-exam.mjs (a script, not engine code, and un-owned this round)
 * is instead taught to load every *.json under test-docs/scorecard/generalization/ and merge their
 * `questions` arrays onto exam.json's own — see loadExtraCategoryQuestions() there. This file is the
 * generator; the checked-in output is test-docs/scorecard/generalization/field-phrasing.json.
 *
 * GROUND TRUTH: every oracle below was verified against scripts/golden/golden-export.json via a PGlite
 * harness (reusing offline-exam.mjs's own createPGlite/loadExportIntoNewTenant) before being written here
 * — never against the auditor's own `expectSubstring`, which turned out to be WRONG for most of the
 * field_lookup_name questions (see FINDINGS below). Where no objective answer could be pinned down, the
 * question is either dropped or marked `cmp: "rubric"`.
 *
 * FINDINGS (the auditor's ground truth vs. this tenant's actual data):
 *   - Every surname in the golden tenant is deliberately shared by 2-3 customers (Prentiss, Ortega,
 *     Norwood, Montoya, Kowalski, Jarvis, Isaacson, Whitfield, Winslow, Ulloa, Quintana, Pruitt, Zamora,
 *     Chavez, Gallardo, Fenwick, Bracken, Hutchins, Whitfield, Dominguez, Esparza, Mercer, Sorenson/
 *     Sorensen, ...) - only Holbrook, Whitford and Thornton are unique. The auditor's expectSubstring for
 *     bare-surname field lookups (g019, g022, g024, g027, g029, g032) assumed a single match and is WRONG
 *     for 12 of the 14 field_lookup_name questions - those become must-ask-which (honest-zero) here.
 *   - No document in this corpus ever carries an "installer" field (extractions.field_key never has one) -
 *     every "who installed X" question (by address, by name, brand-qualified, negated, compound) has the
 *     SAME objectively correct answer: not on file. That covers g020, g025, g030, g049, g053, g071, g075,
 *     g149, g151, g153, g155, g157.
 *   - document_financials.status is 'unknown' for all 226 rows in this export, and balance_due is NULL for
 *     all of them - every payment-status/balance-due question (g058, g061, g064, g067, g068, g069, g081,
 *     g085) is honestly undecidable from the records, not a real "0".
 *   - po_number / permit_number / agreement_term only exist on a minority of customers (19-27 of 120); the
 *     specific subjects the auditor picked for g140-g147 (misc_field) happen to be customers who do NOT
 *     have that document type - all eight are genuinely "not on file", not a lookup miss.
 *   - For categorical (not per-record) facts - warranty active/expired, "still good" - when a bare-surname
 *     match is ambiguous BUT every matching customer's equipment agrees on the category (e.g. all 3
 *     Winslows are expired), the categorical answer is still objectively pinned down even though the
 *     customer's IDENTITY isn't; when they disagree (Ulloa, Quintana, Kowalski's serials, etc.) it is not.
 *
 * Usage: node scripts/gen-field-phrasing.mjs
 *   writes test-docs/scorecard/generalization/field-phrasing.json.
 *   Oracle verification against the golden tenant lives in scripts/verify-field-phrasing.mjs, which
 *   loads the `questions` export below directly (no need to re-run this generator first).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "field-phrasing.json");

/* ============================================================== oracle-builder helpers */

/** A single point-value lookup at a service address, guarded so it only fires when exactly one customer
 *  matches (never silently picks among several - the R16_CONTRACT owner decision's "several customers,
 *  no unit#" case). `addressPrefix` is the tenant's OWN address string (verified via PGlite), never the
 *  question's own typo'd/abbreviated text. */
function addressValue({ id, text, shape, addressPrefix, fieldCol, citationRequired = true }) {
  return {
    id, text, category: "field-phrasing", shape, cmp: "value",
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

/** Point-value lookup by bare surname/customer-name pattern, guarded to a single match - returns 0 rows
 *  (honest decline) the moment 2+ customers share the name, which is the norm in this tenant. */
function nameValue({ id, text, shape, namePattern, fieldCol, onCustomer = false, citationRequired = true }) {
  const sel = onCustomer ? `c.data->>'${fieldCol}'` : `e.data->>'${fieldCol}'`;
  const from = onCustomer
    ? `FROM entities c WHERE c.id IN (SELECT id FROM m)`
    : `FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)`;
  return {
    id, text, category: "field-phrasing", shape, cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT ${sel} AS v ${from} AND (SELECT count(*) FROM m) = 1 AND coalesce(${sel}, '') <> ''`,
      params: [namePattern],
    },
    citationRequired,
  };
}

/** Honest-decline oracle: `guardSql` computes n; n=0 means "still must decline under today's data" (never
 *  skipped), n>0 means the premise no longer holds and the question gracefully SKIPs rather than being
 *  scored wrong forever. Every guard here was checked against the golden export directly. */
function decline({ id, text, shape, guardSql, guardParams = [], why }) {
  return { id, text, category: "field-phrasing", shape, cmp: "honest-zero", oracle: { sql: guardSql, params: guardParams }, note: why };
}

/** Never-on-file structural fact: no document in this schema ever carries an "installer" field
 *  (extractions.field_key never has one) - every "who installed X" question, however phrased, shares
 *  this one guard. */
const INSTALLER_NEVER_ON_FILE = `SELECT (SELECT count(*) FROM extractions WHERE field_key = 'installer') AS n`;
function installerDecline({ id, text, shape }) {
  return decline({ id, text, shape, guardSql: INSTALLER_NEVER_ON_FILE, why: "no document in this corpus ever carries an installer field" });
}

/** The R16_CONTRACT owner decision's "several matches, no disambiguator -> ask which one (list them)" is
 *  the fully-credited behavior for a bare-surname/business-name collision, not just a bare decline - and
 *  it is what this codebase's own disambiguation path already does (see g076/g079's actual answers:
 *  "I found more than one match for X: A, B. Which one did you mean?"). Graded as a `set` of the matching
 *  customers' names so a plain, uncommitted decline still fails (nothing to cite/name) but naming the
 *  wrong single person also fails (fails recall on the other match(es)) - only actually listing every
 *  candidate passes. */
function ambiguitySet({ id, text, shape, namePattern, why }) {
  return {
    id, text, category: "field-phrasing", shape, cmp: "set", note: why,
    oracle: { sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [namePattern] },
  };
}

function numberQ({ id, text, shape, sql, params = [], expectedNote, tolerance, anyNumber, citationRequired }) {
  const q = { id, text, category: "field-phrasing", shape, cmp: "number", oracle: { sql, params }, note: expectedNote };
  if (Number.isFinite(tolerance)) q.tolerance = tolerance;
  if (anyNumber) q.anyNumber = true;
  if (citationRequired === false) q.citationRequired = false;
  return q;
}

function valueQ({ id, text, shape, sql, params = [], requires, citationRequired = true }) {
  const o = { sql, params };
  if (requires) o.requires = requires;
  return { id, text, category: "field-phrasing", shape, cmp: "value", oracle: o, citationRequired };
}

function yesNoQ({ id, text, shape, sql, params = [], citationRequired = true }) {
  return { id, text, category: "field-phrasing", shape, cmp: "yesno", oracle: { sql, params }, citationRequired };
}

function rubricQ({ id, text, shape, rubric }) {
  return { id, text, category: "field-phrasing", shape, cmp: "rubric", rubric, oracle: { sql: "SELECT NULL::text AS ref WHERE false" } };
}

/* ============================================================== the 158 questions */

const TODAY = "@today"; // resolved by oracle.js at run time

const questions = [];

/* ---- field_lookup_address (g001-g018): 18 single-customer, single-unit street addresses ------------- */
const ADDR_FIELD = [
  ["g001", "whats the model on the unit at 100 e main st", "100 E Main St, Phoenix, AZ 85001", "model"],
  ["g002", "serail number for 322 N Greenfield Rd", "322 N Greenfield Rd, Phoenix, AZ 85001", "serial_number"],
  ["g003", "who makes the unit at 544 E Ray Rd", "544 E Ray Rd, Mesa, AZ 85201", "manufacturer"],
  ["g004", "what tonnage is installed at 766 n val vista dr", "766 N Val Vista Dr, Gilbert, AZ 85234", "tonnage"],
  ["g005", "whats the refrigerant type at 988 W Southern Ave", "988 W Southern Ave, Chandler, AZ 85224", "refrigerant"],
  ["g006", "when was the unit at 1210 E Broadway Rd instaled", "1210 E Broadway Rd, Chandler, AZ 85224", "installation_date"],
  ["g007", "whats the model on the unit at 1432 w thomas rd", "1432 W Thomas Rd, Tempe, AZ 85281", "model"],
  ["g008", "serail number for 1654 E Pecos Rd", "1654 E Pecos Rd, Scottsdale, AZ 85251", "serial_number"],
  ["g009", "who makes the unit at 1876 N College Ave", "1876 N College Ave, Glendale, AZ 85301", "manufacturer"],
  ["g010", "what tonnage is installed at 2098 w baseline rd", "2098 W Baseline Rd, Peoria, AZ 85345", "tonnage"],
  ["g011", "whats the refrigerant type at 2320 N Power Rd", "2320 N Power Rd, San Tan Valley, AZ 85140", "refrigerant"],
  ["g012", "when was the unit at 2542 S Ellsworth Rd instaled", "2542 S Ellsworth Rd, Casa Grande, AZ 85122", "installation_date"],
  ["g013", "whats the model on the unit at 2764 e university dr", "2764 E University Dr, Maricopa, AZ 85138", "model"],
  ["g014", "serail number for 2986 S Alma School Rd", "2986 S Alma School Rd, Florence, AZ 85132", "serial_number"],
  ["g015", "who makes the unit at 3208 E McKellips Rd", "3208 E McKellips Rd, Tucson, AZ 85701", "manufacturer"],
  ["g016", "what tonnage is installed at 3430 w ocotillo rd", "3430 W Ocotillo Rd, Tucson, AZ 85701", "tonnage"],
  ["g017", "whats the refrigerant type at 3652 W Guadalupe Rd", "3652 W Guadalupe Rd, Oro Valley, AZ 85737", "refrigerant"],
  ["g018", "when was the unit at 3874 E Chandler Blvd instaled", "3874 E Chandler Blvd, Albuquerque, NM 87101", "installation_date"],
];
for (const [id, text, addr, col] of ADDR_FIELD) {
  questions.push(addressValue({ id, text, shape: "field_lookup_address", addressPrefix: `${addr.split(",")[0]}%`, fieldCol: col }));
}

/* ---- field_lookup_variant_address (g110-g121): same shape, address written with suffix/city/state ---- */
const VARIANT_ADDR_FIELD = [
  ["g110", "who makes on the unit at 1025 N College Avenue, Chandler, AZ 85224", "1025 N College Ave, Chandler, AZ 85224", "manufacturer"],
  ["g111", "model # on the unit at 1284 S Alma School Rd", "1284 S Alma School Rd, Tempe, AZ 85281", "model"],
  ["g112", "serial on the unit at 1543 S Higley Rd, Scottsdale, 85251", "1543 S Higley Rd, Scottsdale, AZ 85251", "serial_number"],
  ["g113", "who makes on the unit at 1802 e main st, glendale, az 85301", "1802 E Main St, Glendale, AZ 85301", "manufacturer"],
  ["g114", "model # on the unit at 2061 E Broadway Road, Peoria, AZ 85345", "2061 E Broadway Rd, Peoria, AZ 85345", "model"],
  ["g115", "serial on the unit at 2320 N Power Rd", "2320 N Power Rd, San Tan Valley, AZ 85140", "serial_number"],
  ["g116", "who makes on the unit at 2579 W Ocotillo Rd, Casa Grande, 85122", "2579 W Ocotillo Rd, Casa Grande, AZ 85122", "manufacturer"],
  ["g117", "model # on the unit at 2838 e elliot rd, maricopa, az 85138", "2838 E Elliot Rd, Maricopa, AZ 85138", "model"],
  ["g118", "serial on the unit at 3097 E Ray Road, Florence, AZ 85132", "3097 E Ray Rd, Florence, AZ 85132", "serial_number"],
  ["g119", "who makes on the unit at 3356 E Pecos Rd", "3356 E Pecos Rd, Tucson, AZ 85701", "manufacturer"],
  ["g120", "model # on the unit at 3615 E University Dr, Oro Valley, 85737", "3615 E University Dr, Oro Valley, AZ 85737", "model"],
  ["g121", "serial on the unit at 3874 e chandler blvd, albuquerque, nm 87101", "3874 E Chandler Blvd, Albuquerque, NM 87101", "serial_number"],
];
for (const [id, text, addr, col] of VARIANT_ADDR_FIELD) {
  questions.push(addressValue({ id, text, shape: "field_lookup_variant_address", addressPrefix: `${addr.split(",")[0]}%`, fieldCol: col }));
}

/* ---- field_lookup_name (g019-g032): bare surname - ambiguous for 12 of 14 (see FINDINGS) -------------- */
questions.push(nameValue({ id: "g019", text: "whats the serial on Prentiss's unit", shape: "field_lookup_name", namePattern: "%Prentiss%", fieldCol: "serial_number" }));
questions.push(installerDecline({ id: "g020", text: "who installed the Ortega account's equipment", shape: "field_lookup_name" }));
questions.push(ambiguitySet({ id: "g021", text: "does Norwood have a warranty on file", shape: "field_lookup_name", namePattern: "%Norwood%", why: "Rebecca Norwood is registered (on_file), Joseph Norwood is not - bare surname can't say which" }));
questions.push(nameValue({ id: "g022", text: "whats Montoya phone number", shape: "field_lookup_name", namePattern: "%Montoya%", fieldCol: "phone", onCustomer: true }));
questions.push(nameValue({ id: "g023", text: "model number for the Whitford job", shape: "field_lookup_name", namePattern: "%Whitford%", fieldCol: "model" }));
questions.push(nameValue({ id: "g024", text: "whats the serial on Kowalski's unit", shape: "field_lookup_name", namePattern: "%Kowalski%", fieldCol: "serial_number" }));
questions.push(installerDecline({ id: "g025", text: "who installed the Jarvis account's equipment", shape: "field_lookup_name" }));
questions.push(ambiguitySet({ id: "g026", text: "does Jarvis have a warranty on file", shape: "field_lookup_name", namePattern: "%Jarvis%", why: "Amy Jarvis is registered (on_file), Paul Jarvis is not" }));
questions.push(nameValue({ id: "g027", text: "whats Isaacson phone number", shape: "field_lookup_name", namePattern: "%Isaacson%", fieldCol: "phone", onCustomer: true }));
questions.push(nameValue({ id: "g028", text: "model number for the Holbrook job", shape: "field_lookup_name", namePattern: "%Holbrook%", fieldCol: "model" }));
questions.push(nameValue({ id: "g029", text: "whats the serial on Gallardo's unit", shape: "field_lookup_name", namePattern: "%Gallardo%", fieldCol: "serial_number" }));
questions.push(installerDecline({ id: "g030", text: "who installed the Fenwick account's equipment", shape: "field_lookup_name" }));
questions.push(ambiguitySet({ id: "g031", text: "does Esparza have a warranty on file", shape: "field_lookup_name", namePattern: "%Esparza%", why: "Patricia Esparza is registered (on_file), Edward Esparza is not" }));
questions.push(nameValue({ id: "g032", text: "whats Dominguez phone number", shape: "field_lookup_name", namePattern: "%Dominguez%", fieldCol: "phone", onCustomer: true }));

/* ---- warranty (g033-g046) ------------------------------------------------------------------------------ */
function warrantyStatusAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: "field-phrasing", shape: "warranty", cmp: "value",
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
questions.push(warrantyStatusAtAddress("g033", "is the unit at 470 e chandler blvd still under warranty", "470 E Chandler Blvd%"));
questions.push({
  id: "g034", text: "whens the warranty up at 729 W Camelback Rd", category: "field-phrasing", shape: "warranty", cmp: "value", citationRequired: true,
  oracle: {
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
    params: ["729 W Camelback Rd%"],
  },
});
questions.push(ambiguitySet({ id: "g035", text: "warranty status on Winslow", shape: "warranty", namePattern: "%Winslow%", why: "3 Winslows match, but resolved separately: kept as decline for consistency with the rest of the bare-surname family even though all 3 happen to be expired" }));
questions.push(yesNoQ({
  id: "g036", text: "is Matthew Whitfield out of warranty yet", shape: "warranty",
  sql: `SELECT (e.data#>>'{warranty,expires}')::date <= $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE '%Matthew Whitfield%' AND e.data#>>'{warranty,expires}' IS NOT NULL`,
  params: [TODAY],
}));
questions.push(warrantyStatusAtAddress("g037", "is the unit at 1506 e mckellips rd still under warranty", "1506 E McKellips Rd%"));
questions.push({
  id: "g038", text: "whens the warranty up at 1765 N Recker Rd", category: "field-phrasing", shape: "warranty", cmp: "value", citationRequired: true,
  oracle: {
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
    params: ["1765 N Recker Rd%"],
  },
});
questions.push(ambiguitySet({ id: "g039", text: "warranty status on Ulloa", shape: "warranty", namePattern: "%Ulloa%", why: "Timothy Ulloa has no warranty data at all; Donna Ulloa's is expired - the two disagree in category, not just identity" }));
questions.push(yesNoQ({
  id: "g040", text: "is Robert Thornton out of warranty yet", shape: "warranty",
  sql: `SELECT (e.data#>>'{warranty,expires}')::date <= $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE '%Robert Thornton%' AND e.data#>>'{warranty,expires}' IS NOT NULL`,
  params: [TODAY],
}));
questions.push(warrantyStatusAtAddress("g041", "is the unit at 2542 s ellsworth rd still under warranty", "2542 S Ellsworth Rd%"));
questions.push({
  id: "g042", text: "whens the warranty up at 2801 W Guadalupe Rd", category: "field-phrasing", shape: "warranty", cmp: "value", citationRequired: true,
  oracle: {
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
    params: ["2801 W Guadalupe Rd%"],
  },
});
questions.push(ambiguitySet({ id: "g043", text: "warranty status on Quintana", shape: "warranty", namePattern: "%Quintana%", why: "Thomas/William Quintana are still active, Melissa Quintana is expired - disagree in category" }));
questions.push(yesNoQ({
  id: "g044", text: "is Richard Pruitt out of warranty yet", shape: "warranty",
  sql: `SELECT (e.data#>>'{warranty,expires}')::date <= $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE '%Richard Pruitt%' AND e.data#>>'{warranty,expires}' IS NOT NULL`,
  params: [TODAY],
}));
questions.push(warrantyStatusAtAddress("g045", "is the unit at 3578 n college ave still under warranty", "3578 N College Ave%"));
questions.push({
  id: "g046", text: "whens the warranty up at 3837 S Alma School Rd", category: "field-phrasing", shape: "warranty", cmp: "value", citationRequired: true,
  oracle: {
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
    params: ["3837 S Alma School Rd%"],
  },
});
// g046's address (3837 S Alma School Rd) is actually "Thomas Osborn, Las Vegas NV" per the golden data
// (a data-entry oddity in the corpus, not this generator's concern) with expires=NULL -> this question
// will legitimately grade as honest-zero-shaped (0 rows -> compareValue falls back to compareHonestZero).

/* ---- history (g047-g056) ------------------------------------------------------------------------------- */
function lastVisitAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: "field-phrasing", shape: "history", cmp: "value",
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
function lastVisitByName(id, text, namePattern) {
  // "last time we serviced X" aggregates the max service_date across every customer matching the name -
  // objectively well-defined even though the surname itself may match more than one customer (unlike a
  // per-record field value, "the most recent date across everyone named X" has exactly one right answer).
  return {
    id, text, category: "field-phrasing", shape: "history", cmp: "value",
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
function lastTechAtAddress(id, text, addressPrefix) {
  return {
    id, text, category: "field-phrasing", shape: "history", cmp: "value",
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
questions.push(lastVisitAtAddress("g047", "last time we were at 655 e mckellips rd", "655 E McKellips Rd%"));
questions.push(lastTechAtAddress("g048", "who was out at 988 W Southern Ave last", "988 W Southern Ave%"));
questions.push(installerDecline({ id: "g049", text: "who installed the trane at 1321 E Chandler Blvd", shape: "history" }));
questions.push(lastVisitByName("g050", "when did we last service Zamora", "%Zamora%"));
questions.push(lastVisitAtAddress("g051", "last time we were at 1987 e elliot rd", "1987 E Elliot Rd%"));
questions.push(lastTechAtAddress("g052", "who was out at 2320 N Power Rd last", "2320 N Power Rd%"));
questions.push(installerDecline({ id: "g053", text: "who installed the trane at 2653 E Main St", shape: "history" }));
questions.push(lastVisitByName("g054", "when did we last service Chavez", "%Chavez%"));
questions.push(lastVisitAtAddress("g055", "last time we were at 3319 n val vista dr", "3319 N Val Vista Dr%"));
questions.push(lastTechAtAddress("g056", "who was out at 3652 W Guadalupe Rd last", "3652 W Guadalupe Rd%"));

/* ---- money (g057-g069) --------------------------------------------------------------------------------- */
function invoiceTotalAtAddress(id, text, addressPrefix) {
  return numberQ({
    id, text, shape: "money", tolerance: 0.5, anyNumber: true,
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT df.total AS n FROM document_financials df
WHERE df.doc_kind='invoice' AND df.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))
  AND (SELECT count(*) FROM m) = 1
ORDER BY df.invoice_date DESC NULLS LAST LIMIT 1`,
    params: [addressPrefix],
  });
}
const NO_KNOWN_BALANCE = `SELECT (SELECT count(*) FROM document_financials WHERE balance_due IS NOT NULL) AS n`;
questions.push(invoiceTotalAtAddress("g057", "how much did the job at 840 s ellsworth rd come to", "840 S Ellsworth Rd%"));
questions.push(decline({ id: "g058", text: "whats owed on Ibarra's account", shape: "money", guardSql: NO_KNOWN_BALANCE, why: "balance_due is NULL on every document_financials row in this tenant" }));
questions.push(invoiceTotalAtAddress("g059", "last invoice total for 1506 E McKellips Rd", "1506 E McKellips Rd%"));
questions.push(invoiceTotalAtAddress("g060", "how much did the job at 1839 w southern ave come to", "1839 W Southern Ave%"));
questions.push(decline({ id: "g061", text: "whats owed on Yarborough's account", shape: "money", guardSql: NO_KNOWN_BALANCE, why: "balance_due is NULL on every document_financials row in this tenant" }));
questions.push(invoiceTotalAtAddress("g062", "last invoice total for 2505 E Pecos Rd", "2505 E Pecos Rd%"));
questions.push(invoiceTotalAtAddress("g063", "how much did the job at 2838 e elliot rd come to", "2838 E Elliot Rd%"));
questions.push(decline({ id: "g064", text: "whats owed on Montoya's account", shape: "money", guardSql: NO_KNOWN_BALANCE, why: "balance_due is NULL on every document_financials row in this tenant" }));
questions.push(invoiceTotalAtAddress("g065", "last invoice total for 3504 E Main St", "3504 E Main St%"));
questions.push(invoiceTotalAtAddress("g066", "how much did the job at 3837 s alma school rd come to", "3837 S Alma School Rd%"));
questions.push(decline({ id: "g067", text: "open invoices over 5k", shape: "money", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE status IN ('unpaid','partial')) AS n`, guardParams: [], why: "every invoice's status is 'unknown' - none is knowably 'open'" }));
questions.push(decline({ id: "g068", text: "who owes us the most right now", shape: "money", guardSql: NO_KNOWN_BALANCE, why: "no balance_due on file to rank by" }));
questions.push(decline({ id: "g069", text: "any unpaid invoices from last month", shape: "money", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE status IN ('unpaid','partial')) AS n`, why: "every invoice's status is 'unknown', never 'unpaid'/'partial'" }));

/* ---- ambiguous_multiunit (g070-g075) -------------------------------------------------------------------- */
function multiUnitCountGuard(namePatternOrAddr, byAddress) {
  const where = byAddress ? `data->>'service_address' ILIKE $1` : `data->>'customer_name' ILIKE $1`;
  return { guardSql: `SELECT (CASE WHEN (SELECT count(*) FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.${where}) = 1 THEN 1 ELSE 0 END) AS n`, guardParams: [namePatternOrAddr] };
}
questions.push(decline({ id: "g070", text: "whats the warranty on the unit at 3300 s alma school rd", shape: "ambiguous_multiunit", ...multiUnitCountGuard("3300 S Alma School Rd%", true) }));
questions.push(installerDecline({ id: "g071", text: "who installed the trane at 3300 s alma school rd", shape: "ambiguous_multiunit" }));
questions.push(addressValue({ id: "g072", text: "serial number for 3300 s alma school rd apt 104", shape: "ambiguous_multiunit", addressPrefix: "3300 S Alma School Rd, Apt 104%", fieldCol: "serial_number" }));
questions.push(decline({ id: "g073", text: "what unit is installed at copper sky dental", shape: "ambiguous_multiunit", ...multiUnitCountGuard("%copper sky dental%", false) }));
questions.push(decline({ id: "g074", text: "whats the tonnage at sunrise valley elementary", shape: "ambiguous_multiunit", ...multiUnitCountGuard("%sunrise valley elementary%", false) }));
questions.push(installerDecline({ id: "g075", text: "who installed the goodman at sonoran grill restaurant", shape: "ambiguous_multiunit" }));

/* ---- collision_risk (g076-g080) ------------------------------------------------------------------------ */
questions.push(valueQ({
  id: "g076", text: "whats on file for sorenson", shape: "collision_risk",
  sql: `SELECT data->>'customer_name' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE '%Sorenson%'`,
  params: [],
}));
questions.push(ambiguitySet({ id: "g077", text: "mercer account, when was it last serviced", shape: "collision_risk", namePattern: "%Mercer%", why: "Thomas Mercer and Laura Mercer are two distinct customers - bare surname must not silently pick one" }));
questions.push(decline({ id: "g078", text: "last time we were at 214 mercer", shape: "collision_risk", guardSql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '214%') AS n`, why: "no address starting with house number 214 exists in this tenant" }));
questions.push(ambiguitySet({ id: "g079", text: "whats the address on file for whitfield", shape: "collision_risk", namePattern: "%Whitfield%", why: "Emily, Matthew and Ashley Whitfield are three distinct customers" }));
questions.push(numberQ({
  id: "g080", text: "137 w southern ave — what unit do they have, the phoenix one", shape: "collision_risk", tolerance: 0,
  sql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'service_address' ILIKE '137 W Southern Ave, Phoenix%'`,
  params: [],
}));

/* ---- negation (g081-g085) ------------------------------------------------------------------------------ */
questions.push(rubricQ({ id: "g081", text: "which customers are NOT still under warranty", shape: "negation", rubric: "A portfolio-wide list of every customer with no currently-active warranty coverage; must not invert into an 'under warranty' list and must not silently drop customers with mixed-status equipment." }));
questions.push(numberQ({
  id: "g082", text: "show me units without a Trane system", shape: "negation", tolerance: 0,
  sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL) - (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'trane') AS n`,
  params: [],
}));
questions.push(rubricQ({ id: "g083", text: "everyone except the Fitzgeralds who had service this year", shape: "negation", rubric: "Every customer serviced this year, excluding both Fitzgerald customers by name; must apply both the time filter and the exclusion." }));
questions.push(decline({ id: "g084", text: "whats the warranty status if it's not registered", shape: "negation", guardSql: `SELECT 0 AS n`, why: "no subject (address/name) is named at all - nothing to resolve, ever" }));
questions.push(decline({ id: "g085", text: "who hasn't paid their invoice", shape: "negation", guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE status = 'unpaid') AS n`, why: "no invoice is ever marked 'unpaid' in this tenant's status field - all 226 are 'unknown'" }));

/* ---- slang_fragment (g086-g093) ------------------------------------------------------------------------ */
questions.push(decline({ id: "g086", text: "seriel # on the smith unit", shape: "slang_fragment", guardSql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE '%smith%') AS n`, why: "no customer named Smith exists in this tenant" }));
const NO_SEER_OR_FILTER_FIELD = `SELECT (SELECT count(*) FROM extractions WHERE field_key IN ('seer_rating', 'filter_size')) AS n`;
questions.push(decline({ id: "g087", text: "whats the seer rating on the unit at 100 e main phx", shape: "slang_fragment", guardSql: NO_SEER_OR_FILTER_FIELD, why: "SEER is never an extracted field in this corpus" }));
questions.push(decline({ id: "g088", text: "filter size for the unit at 100 main st", shape: "slang_fragment", guardSql: NO_SEER_OR_FILTER_FIELD, why: "filter size is never an extracted field in this corpus" }));
questions.push(rubricQ({ id: "g089", text: "hows the mesquite table restaurant unit looking, still good?", shape: "slang_fragment", rubric: "Vague colloquial status check across 2 units at Mesquite Table Restaurant with no field named - must not silently report on only one." }));
questions.push(decline({ id: "g090", text: "wuts the modle # at 251 w guadalupe rd", shape: "slang_fragment", guardSql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '251%guadalupe%') AS n`, why: "251 W Guadalupe Rd does not exist (248 does) - must not fuzzy-match to a different house number" }));
questions.push(warrantyStatusAtAddress("g091", "need the warranty info 4 the unit @ 322 n greenfield", "322 N Greenfield Rd%"));
questions.push(decline({ id: "g092", text: "hows warranty look on that unit we did last week", shape: "slang_fragment", guardSql: `SELECT 0 AS n`, why: "no address/name subject named at all in a 120-customer tenant" }));
questions.push(addressValue({ id: "g093", text: "wats the tonnage 4 396 w baseline rd", shape: "slang_fragment", addressPrefix: "396 W Baseline Rd%", fieldCol: "tonnage" }));

/* ---- out_of_domain (g094-g098) ------------------------------------------------------------------------- */
const NEVER_HVAC_CONTENT = `SELECT 0 AS n`;
questions.push(decline({ id: "g094", text: "whats the wifi password", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "no HVAC records could ever answer this" }));
questions.push(decline({ id: "g095", text: "who won the game last night", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "no anchor, no HVAC content" }));
questions.push(decline({ id: "g096", text: "whats the model of my printer", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "must not anchor on the bare word 'model'" }));
questions.push(decline({ id: "g097", text: "serial killer documentary recommendations", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "must not trigger the 'serial' intent" }));
questions.push(decline({ id: "g098", text: "who installed the app on this phone", shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "must not trigger the 'installer' intent" }));

/* ---- content (g099-g103) ------------------------------------------------------------------------------- */
questions.push(rubricQ({ id: "g099", text: "what was found on the job at 100 e main st", shape: "content", rubric: "A summary of what the technician found/did on the job at 100 E Main St (Linda Fitzgerald), drawn from that job's work_performed/notes text." }));
questions.push(rubricQ({ id: "g100", text: "any notes on the install at 137 w southern ave", shape: "content", rubric: "Thomas Mercer's install (invoice) document itself carries no 'notes' field - the answer must not borrow a note from an unrelated later visit (a service-ticket says 'System operating normally after visit', dated 2017, well after the install) and present it as being about the install." }));
questions.push(rubricQ({ id: "g101", text: "whats the work order say for 174 n college ave", shape: "content", rubric: "The work_performed text from whatever job document covers 174 N College Ave (Donna Sorensen)." }));
questions.push(numberQ({ id: "g102", text: "how many jobs have we done for copper sky dental", shape: "content", tolerance: 0, sql: `SELECT count(DISTINCT l.document_id) AS n FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.entity_type='customer' AND c.data->>'customer_name' ILIKE '%copper sky dental%'`, params: [] }));
questions.push(numberQ({ id: "g103", text: "how many trane jobs have we done total", shape: "content", tolerance: 0, sql: `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities e ON e.id=l.entity_id WHERE e.entity_type='equipment' AND e.data->>'manufacturer' ILIKE 'trane'`, params: [] }));

/* ---- two_value (g104-g106) — rubric: no single mechanically-checkable string covers "list every value,
 *      note what's missing, never silently pick one" for a 2-3-unit site. ------------------------------- */
questions.push(rubricQ({ id: "g104", text: "whats the refrigerant at holy trinity church", shape: "two_value", rubric: "3 units at Holy Trinity Church (Goodman/Rheem/Lennox) - only the Goodman has a refrigerant on file (R-410A); must not silently report just one unit as if it were the only one." }));
questions.push(rubricQ({ id: "g105", text: "when was the unit installed at grace community church", shape: "two_value", rubric: "3 units at Grace Community Church installed 2016-06-22/25/28 - must not silently pick a single date." }));
questions.push(rubricQ({ id: "g106", text: "tonnage on the unit at cactus rose restaurant", shape: "two_value", rubric: "2 units at Cactus Rose Restaurant (Rheem/Lennox) - only the Lennox has a tonnage on file (4 ton); must not silently report just one unit as if it were the only one." }));

/* ---- existence (g107-g109) ----------------------------------------------------------------------------- */
questions.push(yesNoQ({ id: "g107", text: "do we have any records for 470 e chandler blvd", shape: "existence", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '470 E Chandler Blvd%') > 0 AS v`, params: [] }));
questions.push(yesNoQ({ id: "g108", text: "we ever work on a house on val vista dr", shape: "existence", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%val vista dr%') > 0 AS v`, params: [] }));
questions.push(yesNoQ({ id: "g109", text: "is there a customer named ortega", shape: "existence", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE '%ortega%') > 0 AS v`, params: [] }));

/* ---- list_intent (g122-g129) --------------------------------------------------------------------------- */
function equipCountAtAddress(id, text, addressPrefix) {
  return numberQ({ id, text, shape: "list_intent", tolerance: 0, sql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'service_address' ILIKE $1`, params: [addressPrefix] });
}
function docCountAtAddress(id, text, addressPrefix) {
  return numberQ({ id, text, shape: "list_intent", tolerance: 0, sql: `SELECT count(DISTINCT l.document_id) AS n FROM document_entity_links l JOIN entities c ON c.id=l.entity_id WHERE c.entity_type='customer' AND c.data->>'service_address' ILIKE $1`, params: [addressPrefix] });
}
questions.push(equipCountAtAddress("g122", "whats installed at 1210 e broadway rd", "1210 E Broadway Rd%"));
// g123/g125/g127: unlike the history category's "last serviced" (a time superlative, coherent to compute
// across every match), "what do THEY have on file" implies one specific customer's possessions - bare
// surname ambiguity here means a merged/summed count would quietly conflate two different customers'
// records, exactly what collision_risk warns against. Decline (ask-which) rather than sum.
questions.push(ambiguitySet({ id: "g123", text: "what equipment do we have on file for Kowalski", shape: "list_intent", namePattern: "%Kowalski%", why: "Cynthia Kowalski and Paul Kowalski are two distinct customers - must not merge their equipment into one answer" }));
questions.push(docCountAtAddress("g124", "what documents do we have for 1950 W Guadalupe Rd", "1950 W Guadalupe Rd%"));
questions.push(ambiguitySet({ id: "g125", text: "show me everything on Bracken", shape: "list_intent", namePattern: "%Bracken%", why: "Karen Bracken and Ronald Bracken are two distinct customers - must not merge their documents into one answer" }));
questions.push(equipCountAtAddress("g126", "whats installed at 2690 w southern ave", "2690 W Southern Ave%"));
questions.push(ambiguitySet({ id: "g127", text: "what equipment do we have on file for Quintana", shape: "list_intent", namePattern: "%Quintana%", why: "Thomas, William and Melissa Quintana are three distinct customers - must not merge their equipment into one answer" }));
questions.push(docCountAtAddress("g128", "what documents do we have for 3430 W Ocotillo Rd", "3430 W Ocotillo Rd%"));
questions.push(ambiguitySet({ id: "g129", text: "show me everything on Hutchins", shape: "list_intent", namePattern: "%Hutchins%", why: "Steven Hutchins has 3 documents while Angela/Linda/George Hutchins each have 5 - the count genuinely disagrees" }));

/* ---- analytics (g130-g139) ----------------------------------------------------------------------------- */
questions.push(numberQ({ id: "g130", text: "how many customers do we have in gilbert", shape: "analytics", tolerance: 0, sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%gilbert%'`, params: [], citationRequired: false }));
questions.push(numberQ({ id: "g131", text: "list customers in 85224", shape: "analytics", tolerance: 0, sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%85224%'`, params: [], citationRequired: false }));
questions.push(numberQ({ id: "g132", text: "which customers have lennox units", shape: "analytics", tolerance: 0, sql: `SELECT count(DISTINCT e.customer_id) AS n FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE 'lennox'`, params: [], citationRequired: false }));
questions.push(valueQ({ id: "g133", text: "whats the oldest unit we have on file", shape: "analytics", sql: `SELECT data->>'installation_date' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' IS NOT NULL ORDER BY data->>'installation_date' ASC LIMIT 1`, params: [] }));
questions.push(numberQ({ id: "g134", text: "how many different zip codes do we cover", shape: "analytics", tolerance: 0, sql: `SELECT count(DISTINCT substring(data->>'service_address' from '\\d{5}$')) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL`, params: [], citationRequired: false }));
questions.push(numberQ({ id: "g135", text: "how many trane units are still under warranty", shape: "analytics", tolerance: 0, sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'trane' AND (data#>>'{warranty,expires}') IS NOT NULL AND (data#>>'{warranty,expires}')::date > $1::date`, params: [TODAY], citationRequired: false }));
questions.push(numberQ({ id: "g136", text: "which units had service this month", shape: "analytics", tolerance: 0, sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND date_trunc('month', value::date) = date_trunc('month', $1::date)`, params: [TODAY], citationRequired: false }));
questions.push(numberQ({ id: "g137", text: "how many customers total", shape: "analytics", tolerance: 0, sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL`, params: [], citationRequired: false }));
questions.push(valueQ({ id: "g138", text: "whats our newest install", shape: "analytics", sql: `SELECT data->>'installation_date' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' IS NOT NULL ORDER BY data->>'installation_date' DESC LIMIT 1`, params: [] }));
questions.push(numberQ({ id: "g139", text: "how many jobs this quarter", shape: "analytics", tolerance: 0, sql: `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND date_trunc('quarter', value::date) = date_trunc('quarter', $1::date)`, params: [TODAY], citationRequired: false }));

/* ---- misc_field (g140-g147): all 8 are genuinely "not on file" for the specific subject asked ---------- */
function docTypeAbsentAtAddress(id, text, addressPrefix, docType, why) {
  return decline({ id, text, shape: "misc_field", guardSql: `SELECT (SELECT count(*) FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE c.entity_type='customer' AND c.data->>'service_address' ILIKE $1 AND d.document_type = $2) AS n`, guardParams: [addressPrefix, docType], why });
}
function docTypeAbsentForName(id, text, namePattern, docType, why) {
  return decline({ id, text, shape: "misc_field", guardSql: `SELECT (SELECT count(*) FROM documents d JOIN document_entity_links l ON l.document_id=d.id JOIN entities c ON c.id=l.entity_id WHERE c.entity_type='customer' AND c.data->>'customer_name' ILIKE $1 AND d.document_type = $2) AS n`, guardParams: [namePattern, docType], why });
}
questions.push(docTypeAbsentAtAddress("g140", "whats the po number for the job at 1395 e ray rd", "1395 E Ray Rd%", "purchase-order", "no purchase-order document for this customer"));
questions.push(docTypeAbsentAtAddress("g141", "permit # for 1728 W Ocotillo Rd", "1728 W Ocotillo Rd%", "permit", "no permit document for this customer"));
questions.push(docTypeAbsentForName("g142", "when does the maintenance agreement expire for Calloway", "%Calloway%", "maintenance-agreement", "neither Calloway customer has a maintenance-agreement document"));
questions.push(docTypeAbsentAtAddress("g143", "hows the service contract looking on 2394 S Higley Rd", "2394 S Higley Rd%", "maintenance-agreement", "no maintenance-agreement document for this customer"));
questions.push(docTypeAbsentAtAddress("g144", "whats the po number for the job at 2727 n college ave", "2727 N College Ave%", "purchase-order", "no purchase-order document for this customer"));
questions.push(docTypeAbsentAtAddress("g145", "permit # for 3060 N Dobson Rd", "3060 N Dobson Rd%", "permit", "no permit document for this customer"));
questions.push(docTypeAbsentForName("g146", "when does the maintenance agreement expire for Esparza", "%Esparza%", "maintenance-agreement", "neither Esparza customer has a maintenance-agreement document"));
questions.push(docTypeAbsentAtAddress("g147", "hows the service contract looking on 3726 N Greenfield Rd", "3726 N Greenfield Rd%", "maintenance-agreement", "no maintenance-agreement document for this customer"));

/* ---- compound (g148-g155) ------------------------------------------------------------------------------ */
function twoFieldAtAddress(id, text, addressPrefix, field1, field2) {
  return {
    id, text, category: "field-phrasing", shape: "compound", cmp: "set",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data->>'${field1}' AS item FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1
UNION ALL
SELECT e.data->>'${field2}' AS item FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1`,
      params: [addressPrefix],
    },
  };
}
questions.push(twoFieldAtAddress("g148", "hey quick one — whats the model and serial on the unit at 1580 w camelback rd", "1580 W Camelback Rd%", "model", "serial_number"));
questions.push(rubricQ({ id: "g149", text: "can u tell me who installed it and when for 1913 E University Dr", shape: "compound", rubric: "Installer (not on file - no document ever carries one) AND the install date for 1913 E University Dr (Jason Yarborough); both parts must be addressed, not just the date." }));
questions.push({
  id: "g150", text: "whats the customers name and phone for 2246 E Ray Rd", category: "field-phrasing", shape: "compound", cmp: "set",
  oracle: {
    sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '2246 E Ray Rd%'
UNION ALL SELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '2246 E Ray Rd%'`,
    params: [],
  },
});
questions.push(rubricQ({ id: "g151", text: "quick q, is Abernathy still under warranty and whos the tech that did it", shape: "compound", rubric: "Warranty status AND installer for 'Abernathy' - the bare surname is ambiguous (Karen and Kevin Abernathy) and installer is never on file; both parts need honest handling, not a single confident answer." }));
questions.push(twoFieldAtAddress("g152", "hey quick one — whats the model and serial on the unit at 2912 e broadway rd", "2912 E Broadway Rd%", "model", "serial_number"));
questions.push(rubricQ({ id: "g153", text: "can u tell me who installed it and when for 3245 S Higley Rd", shape: "compound", rubric: "Installer (not on file) AND the install date for 3245 S Higley Rd (Anthony Bennett); both parts must be addressed." }));
questions.push({
  id: "g154", text: "whats the customers name and phone for 3578 N College Ave", category: "field-phrasing", shape: "compound", cmp: "set",
  oracle: {
    sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '3578 N College Ave%'
UNION ALL SELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '3578 N College Ave%'`,
    params: [],
  },
});
questions.push(rubricQ({ id: "g155", text: "quick q, is Dominguez still under warranty and whos the tech that did it", shape: "compound", rubric: "Warranty status AND installer for 'Dominguez' - 3 distinct Dominguez customers and installer never on file; both parts need honest handling." }));

/* ---- dropped_condition (g156-g158) — all rubric: each needs a multi-part or exclusion answer that a
 *      single mechanical comparator can't safely verify. ------------------------------------------------- */
questions.push(rubricQ({ id: "g156", text: "whats the warranty on the unit at 137 w southern ave phoenix vs the one in chandler", shape: "dropped_condition", rubric: "Two conditions (Phoenix AND an under-specified 'Chandler' one) - must address both or clearly ask, never silently answer only the Phoenix one." }));
questions.push(installerDecline({ id: "g157", text: "who installed the carrier unit that ISNT at copper sky dental", shape: "dropped_condition" }));
questions.push(rubricQ({ id: "g158", text: "wheres the trane unit installed in 2017, not the 2009 one", shape: "dropped_condition", rubric: "3 different Trane units were installed in 2017 (not just 1), so 'the 2017 one' is itself ambiguous even after excluding the 2009 install - must not silently pick one of the three." }));

/* ============================================================== output */

if (questions.length !== 158) {
  console.error(`gen-field-phrasing: expected 158 questions, built ${questions.length}`);
  process.exit(1);
}
const ids = new Set(questions.map((q) => q.id));
if (ids.size !== 158) {
  console.error(`gen-field-phrasing: duplicate ids (${158 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-26.field-phrasing-r16",
  category: "field-phrasing",
  source: "../r15_generalization_questions.json (Round 15 auditor, 158 tired-field-tech questions)",
  questions,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-field-phrasing: wrote ${questions.length} questions -> ${OUT_PATH}`);
  const byCmp = {};
  for (const q of questions) byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1;
  console.log("by cmp:", JSON.stringify(byCmp));
}

export { questions, out };
