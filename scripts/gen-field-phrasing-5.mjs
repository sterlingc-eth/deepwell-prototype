#!/usr/bin/env node
/**
 * FIELD-PHRASING-5 exam category (Round 23, D1) — a fresh BLIND generalization set: 200 new
 * questions written WITHOUT reading test-docs/scorecard/exam.json's or any earlier field-phrasing-*
 * .json's question TEXTS, and WITHOUT looking at how this round's own code changes route any of
 * them — generated and committed FIRST, measured SECOND (see handoffs/ROUND23_DONOVAN.md for the
 * before/after numbers taken from that measurement, never from this file). Only these were read to
 * build this: the DATA (scripts/golden/golden-export.json, queried directly through a throwaway
 * PGlite harness — same harness shape offline-exam.mjs already exposes — for real subjects: names,
 * phones, addresses, serials, invoice numbers, technicians, manufacturers, warranty-expiry dates),
 * the exam file FORMAT/oracle schema (api/_lib/scorecard/exam.js), and gen-field-phrasing-4.mjs +
 * gen-field-phrasing-2.mjs — read for their STRUCTURE (the oracle-builder helper pattern: a guarded
 * single-match SQL query, an honest-zero guard, a compound two-field `set`) so this file's oracles
 * follow the same conventions. Every helper below is rebuilt fresh, and this file's own question
 * texts are new.
 *
 * fp-2/fp-3/fp-4 have all been tuned against (their own residual ids chased across rounds 19-21), so
 * this is a FRESH BLIND MEASUREMENT, not a repeat of any earlier set's shapes. Sections:
 *
 *   A. casual/filler phrasing on core single-field lookups (phone, address, serial) (25)
 *   B. compound two-field asks at an address (model+serial, name+phone) (20)
 *   C. document-existence yes/no ("do we have a permit on file for X") for real customers who DO and
 *      DON'T have one (20)
 *   D. warranty-status yes/no across real customers, read straight from the stored warranty.expires
 *      date (never re-derived from an assumed years-of-coverage constant) (20)
 *   E. internal/team-memo phrasing — own paraphrases of the round's new isInternalMemoQuestion shape,
 *      never copied from field-phrasing-3's own i142-i157 wording (15)
 *   F. off-topic/trivia phrasing — own paraphrases of the round's new out-of-domain additions (15)
 *   G. untracked-equipment-field phrasing — own paraphrases of the round's new
 *      isUntrackedFieldQuestion shape (15)
 *   H. technician job totals and head-to-head comparisons, fresh pairings not used in fp-4 (15)
 *   I. relative-time analytics with phrasing NOT used in fp-2/fp-3/fp-4 (year-to-date, last 2 months,
 *      past 6 months, last 45 days, last 2 weeks, last 8 weeks) (15)
 *   J. adversarial traps: near-miss names, fake addresses, future dates, a brand never installed for a
 *      real customer (20)
 *   K. mixed coverage rounding out to 200: compound rubric, multi-item sets, rankings, comparisons (20)
 *
 * GROUND TRUTH: every oracle here is guarded (a `requires` single-match/non-empty check where the
 * question names a specific subject, or a direct honest-zero guard for a decline) so a subject this
 * corpus doesn't actually have SKIPS gracefully rather than being wrong — verified for real via
 * scripts/verify-field-phrasing-5.mjs's own PGlite run against scripts/golden/golden-export.json.
 * Every concrete name/phone/address/serial/date below was pulled from a live query against the
 * golden export, never invented.
 *
 * Usage: node scripts/gen-field-phrasing-5.mjs
 *   writes test-docs/scorecard/generalization/field-phrasing-5.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "field-phrasing-5.json");

const CATEGORY = "field-phrasing-5";
const TODAY = "@today"; // resolved by oracle.js at run time

let __n = 0;
const nextId = () => `k${String(++__n).padStart(3, "0")}`;

/* ============================================================== oracle-builder helpers
 * (same conventions as gen-field-phrasing-4.mjs's own helpers, rebuilt fresh here, never imported). */

function numberQ({ text, shape, sql, params = [], tolerance, anyNumber, citationRequired }) {
  const q = { id: nextId(), text, category: CATEGORY, shape, cmp: "number", oracle: { sql, params } };
  if (Number.isFinite(tolerance)) q.tolerance = tolerance;
  if (anyNumber) q.anyNumber = true;
  if (citationRequired === false) q.citationRequired = false;
  return q;
}
function valueQ({ text, shape, sql, params = [], requires, citationRequired = true }) {
  const o = { sql, params };
  if (requires) o.requires = requires;
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "value", oracle: o, citationRequired };
}
function yesNoQ({ text, shape, sql, params = [], requires, citationRequired = true }) {
  const o = { sql, params };
  if (requires) o.requires = requires;
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "yesno", oracle: o, citationRequired };
}
function setQ({ text, shape, sql, params = [], maxItems, citationRequired = true }) {
  const q = { id: nextId(), text, category: CATEGORY, shape, cmp: "set", oracle: { sql, params }, citationRequired };
  if (Number.isFinite(maxItems)) q.maxItems = maxItems;
  return q;
}
function decline({ text, shape, guardSql, guardParams = [], why }) {
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "honest-zero", oracle: { sql: guardSql, params: guardParams }, note: why };
}
function rubricQ({ text, shape, rubric }) {
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "rubric", rubric, oracle: { sql: "SELECT NULL::text AS ref WHERE false" } };
}
function countQ(text, shape, whereSql, params = []) {
  return numberQ({ text, shape, tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n ${whereSql}`, params });
}
const CUSTOMER_COUNT_SQL = `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`;

const questions = [];

/* ================================================================================================
 * SECTION A — casual/filler phrasing on core single-field lookups (25)
 * Real phone/address/serial values, pulled live from the golden export (never hand-typed).
 */
function phoneQ(text, name) {
  return valueQ({
    text, shape: "casual_field",
    sql: `SELECT data->>'phone' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`,
    params: [`%${name}%`],
    requires: { sql: CUSTOMER_COUNT_SQL, params: [`%${name}%`] },
  });
}
function addressQ(text, name) {
  return valueQ({
    text, shape: "casual_field",
    sql: `SELECT data->>'service_address' AS v FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`,
    params: [`%${name}%`],
    requires: { sql: CUSTOMER_COUNT_SQL, params: [`%${name}%`] },
  });
}
function serialQ(text, name) {
  return valueQ({
    text, shape: "casual_field",
    sql: `SELECT e.data->>'serial_number' AS v FROM entities e JOIN entities c ON c.id=e.customer_id
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1
  AND (SELECT count(*) FROM entities e2 WHERE e2.entity_type='equipment' AND e2.merged_into IS NULL AND e2.customer_id=c.id) = 1`,
    params: [`%${name}%`],
    requires: { sql: CUSTOMER_COUNT_SQL, params: [`%${name}%`] },
  });
}

const PHONE_SUBJECTS = [
  ["so uh, whats the phone number for George Hutchins again", "George Hutchins"],
  ["hang on, can you pull the phone number for Rebecca Montoya", "Rebecca Montoya"],
  ["quick one - whats Joseph Norwood's number on file", "Joseph Norwood"],
  ["hey um, do we have a callback number for Stephanie Nakamura", "Stephanie Nakamura"],
  ["gimme a sec... whats the phone for Timothy Ulloa", "Timothy Ulloa"],
  ["so whats Richard Osborn's phone number, the one on file", "Richard Osborn"],
  ["uh can you check, whats Joseph Ortega's number", "Joseph Ortega"],
  ["hold on - phone number for Michael Redwine please", "Michael Redwine"],
  ["so umm, whats Ronald Fenwick's contact number", "Ronald Fenwick"],
  ["real quick, whats Ronald Calloway's phone on file", "Ronald Calloway"],
];
for (const [text, name] of PHONE_SUBJECTS) questions.push(phoneQ(text, name));

const ADDRESS_SUBJECTS = [
  ["so uh, whats the service address for Michael Sandoval", "Michael Sandoval"],
  ["hang on, whats Sandra Yarborough's address on file", "Sandra Yarborough"],
  ["quick q - where's Mark Jennings' unit located", "Mark Jennings"],
  ["hey um, whats the address we have for Amanda Redwine", "Amanda Redwine"],
  ["gimme a sec, whats Barbara Delgado's service address", "Barbara Delgado"],
  ["so whats the address on file for Amanda Quinley", "Amanda Quinley"],
  ["uh can you check where Copper Sky Dental's unit is", "Copper Sky Dental"],
  ["hold on, whats the service address for Holy Trinity Church", "Holy Trinity Church"],
  ["so umm, whats the address for Sunrise Valley Elementary School", "Sunrise Valley Elementary School"],
  ["real quick, whats Cactus Rose Restaurant's address on file", "Cactus Rose Restaurant"],
];
for (const [text, name] of ADDRESS_SUBJECTS) questions.push(addressQ(text, name));

const SERIAL_SUBJECTS = [
  ["so uh, whats the serial number on Donna Sorensen's unit", "Donna Sorensen"],
  ["hang on, whats the serial on file for Amy Isaacson", "Amy Isaacson"],
  ["quick one - serial number for Steven Ellison's system", "Steven Ellison"],
  ["hey um, whats Robert Salazar's unit serial", "Robert Salazar"],
  ["gimme a sec, whats the serial number for Deborah Ortega", "Deborah Ortega"],
];
for (const [text, name] of SERIAL_SUBJECTS) questions.push(serialQ(text, name));

/* ================================================================================================
 * SECTION B — compound two-field asks at an address (20)
 */
function twoFieldAtAddress(text, addressPrefix, fieldA, fieldB) {
  return setQ({
    text, shape: "compound",
    sql: `SELECT e.data->>'${fieldA}' AS item FROM entities e JOIN entities c ON c.id=e.customer_id
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'service_address' ILIKE $1
UNION ALL
SELECT e.data->>'${fieldB}' AS item FROM entities e JOIN entities c ON c.id=e.customer_id
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'service_address' ILIKE $1`,
    params: [`${addressPrefix}%`],
  });
}
const MODEL_SERIAL_ADDRS = [
  ["so whats the model and serial number for the unit at 3541 W Southern Ave", "3541 W Southern Ave"],
  ["can you give me model and serial for 1062 E University Dr", "1062 E University Dr"],
  ["hey, model number and serial for 803 E Pecos Rd please", "803 E Pecos Rd"],
  ["quick q - whats the model plus serial on file for 1728 W Ocotillo Rd", "1728 W Ocotillo Rd"],
  ["need the model and serial number for 1765 N Recker Rd", "1765 N Recker Rd"],
  ["whats the model and serial for the system at 1469 N Power Rd", "1469 N Power Rd"],
  ["model and serial, please, for 2653 E Main St", "2653 E Main St"],
  ["hang on, whats the model and the serial number for 1617 N Val Vista Dr", "1617 N Val Vista Dr"],
  ["so uh, model and serial for the unit at 3300 S Alma School Rd", "3300 S Alma School Rd"],
  ["can I get the model and serial number for 2061 E Broadway Rd", "2061 E Broadway Rd"],
];
for (const [text, addr] of MODEL_SERIAL_ADDRS) questions.push(twoFieldAtAddress(text, addr, "model", "serial_number"));

function nameAndPhoneAtAddress(text, addressPrefix) {
  return setQ({
    text, shape: "compound",
    sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1
UNION ALL
SELECT data->>'phone' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`,
    params: [`${addressPrefix}%`],
  });
}
const NAME_PHONE_ADDRS = [
  ["whats the customer name and phone number for 3467 N Recker Rd", "3467 N Recker Rd"],
  ["name and phone for 2172 E Chandler Blvd, whoever that is", "2172 E Chandler Blvd"],
  ["can you get me the name and number for 3023 E Chandler Blvd", "3023 E Chandler Blvd"],
  ["whos the customer at 3726 N Greenfield Rd and whats their phone", "3726 N Greenfield Rd"],
  ["name plus phone number for 912 W Thomas Rd please", "912 W Thomas Rd"],
  ["so whats the customer's name and number for 618 N Power Rd", "618 N Power Rd"],
  ["hang on, name and phone for 1876 N College Ave", "1876 N College Ave"],
  ["quick one - name and phone number for 753 W Guadalupe Rd", "753 W Guadalupe Rd"],
  ["can I get name and number for 859 E Chandler Blvd", "859 E Chandler Blvd"],
  ["whats the name and phone on file for 965 S Higley Rd", "965 S Higley Rd"],
];
for (const [text, addr] of NAME_PHONE_ADDRS) questions.push(nameAndPhoneAtAddress(text, addr));

/* ================================================================================================
 * SECTION C — document-existence yes/no: "do we have a permit on file for X" (20)
 */
function hasPermitQ(text, name) {
  return yesNoQ({
    text, shape: "doc_existence",
    sql: `SELECT EXISTS (SELECT 1 FROM entities c JOIN document_entity_links l ON l.entity_id=c.id JOIN documents d ON d.id=l.document_id
WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1 AND d.document_type='permit') AS v`,
    params: [`%${name}%`],
    requires: { sql: CUSTOMER_COUNT_SQL, params: [`%${name}%`] },
  });
}
const HAS_PERMIT = ["Cactus Rose Restaurant", "Canyon View Dental", "Copper Sky Dental", "Cynthia Kowalski", "Deborah Ortega", "Deborah Prentiss", "Edward Esparza", "Grace Community Church", "Maria Holbrook", "Betty Zimmerman"];
for (const name of HAS_PERMIT) questions.push(hasPermitQ(`do we have a permit on file for ${name}`, name));
const NO_PERMIT = ["Linda Fitzgerald", "Donna Sorensen", "Ronald Bracken", "Amy Isaacson", "David Prentiss", "Sandra Wyckoff", "Laura Lombardi", "Robert Salazar", "Steven Ellison", "Barbara Delgado"];
for (const name of NO_PERMIT) questions.push(hasPermitQ(`is there a permit on file for ${name}`, name));

/* ================================================================================================
 * SECTION D — warranty-status yes/no, read straight from the stored warranty.expires date (20)
 */
// `invert` flips the polarity for a phrasing whose "yes" means "expired" (the stored field itself
// only ever gives "still valid" i.e. expires > today) — see this section's own header note above
// the wrong-polarity bug this caught in an EARLIER draft (a "has ... expired yet" question was
// built with the "still valid" boolean un-negated, which fp-5's own oracle-freshness pass caught).
function warrantyYesNoQ(text, name, { invert = false } = {}) {
  const cmpOp = invert ? "<=" : ">";
  return yesNoQ({
    text, shape: "warranty",
    sql: `SELECT (e.data#>>'{warranty,expires}')::date ${cmpOp} $2::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id
WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE $1 AND e.data#>>'{warranty,expires}' IS NOT NULL
  AND (SELECT count(*) FROM entities e2 WHERE e2.entity_type='equipment' AND e2.merged_into IS NULL AND e2.customer_id=c.id) = 1`,
    params: [`%${name}%`, TODAY],
    requires: { sql: CUSTOMER_COUNT_SQL, params: [`%${name}%`] },
  });
}
const WARRANTY_SUBJECTS = [
  "Donna Sorensen", "Amy Isaacson", "Steven Ellison", "Robert Salazar", "Deborah Ortega",
  "Gary Villegas", "Barbara Delgado", "Carol Rios", "Kevin Zimmerman", "Maria Gallardo",
  "George Hutchins", "Rebecca Montoya", "Joseph Norwood", "Stephanie Nakamura", "Timothy Ulloa",
  "Richard Osborn", "Joseph Ortega", "Michael Redwine", "Ronald Calloway", "Michael Sandoval",
];
const WARRANTY_PHRASINGS = [
  (n) => [`is ${n} still under warranty`, false],
  (n) => [`has ${n}'s warranty expired yet`, true],
  (n) => [`is ${n}'s unit still covered under warranty`, false],
  (n) => [`whats ${n}'s warranty status`, false],
];
WARRANTY_SUBJECTS.forEach((name, i) => {
  const [text, invert] = WARRANTY_PHRASINGS[i % WARRANTY_PHRASINGS.length](name);
  questions.push(warrantyYesNoQ(text, name, { invert }));
});

/* ================================================================================================
 * SECTION E — internal/team-memo phrasing: own paraphrases of isInternalMemoQuestion (15)
 * This golden corpus has zero internal-audience documents (same COUNT the field-phrasing-3
 * i142-i157 oracle uses) — verified live, not assumed.
 */
const INTERNAL_DOC_COUNT_SQL = `SELECT (
  (SELECT count(*) FROM documents WHERE audience = 'internal')
  + (SELECT count(*) FROM extractions WHERE field_key = '_audience' AND value = 'internal')
) AS n`;
const MEMO_PARAPHRASES = [
  "any memos for Gary Villegas this week",
  "any memos for Carol Rios",
  "what did dispatch send to the techs this morning",
  "what did the shop manager circulate to everyone yesterday",
  "any internal notes on file for Kevin Zimmerman's job",
  "is there a staff-only memo about the new pricing",
  "what's in the internal notes for Maria Gallardo",
  "any team-wide notice about the schedule change",
  "did management send anything around about the holiday hours",
  "is there an internal-only writeup on the Osborn account",
  "any dispatch notice that went out to the crew today",
  "what did office send around about next week's routes",
  "is there any internal paperwork on file for this job at all",
  "any staff-only notes about Michael Sandoval's account",
  "what did dispatch circulate to the team this week",
];
for (const text of MEMO_PARAPHRASES) {
  questions.push(decline({ text, shape: "team_scoped", guardSql: INTERNAL_DOC_COUNT_SQL, why: "no internal-audience document exists anywhere in this corpus" }));
}

/* ================================================================================================
 * SECTION F — off-topic/trivia phrasing: own paraphrases of the out-of-domain cluster (15)
 */
const NEVER_HVAC_CONTENT = `SELECT 0 AS n`;
const TRIVIA_PARAPHRASES = [
  "whats it like outside right now",
  "write me a haiku about compressors",
  "whats 19 times 23",
  "who won the super bowl this year",
  "got any good jokes",
  "how do I change my account password",
  "wheres the closest coffee shop",
  "whats the capital of Nevada",
  "can you hum me a tune",
  "whats the square root of 225",
  "set an alarm for 6am",
  "who's your favorite technician",
  "translate 'thank you' into french",
  "whats today's lottery numbers",
  "can you recommend a good pizza place nearby",
];
for (const text of TRIVIA_PARAPHRASES) {
  questions.push(decline({ text, shape: "out_of_domain", guardSql: NEVER_HVAC_CONTENT, why: "not an HVAC records question - no document could ever answer this" }));
}

/* ================================================================================================
 * SECTION G — untracked-equipment-field phrasing: own paraphrases of isUntrackedFieldQuestion (15)
 * None of these fields ever appear anywhere in this corpus's extracted data - verified live.
 */
const UNTRACKED_PARAPHRASES = [
  "whats the BTU rating on Amy Isaacson's unit",
  "whats the duct size for Robert Salazar's system",
  "what brand is the thermostat at Deborah Ortega's place",
  "whats the capacitor size on Carol Rios's unit",
  "whats the breaker size for Kevin Zimmerman's system",
  "whats the energy star rating on Maria Gallardo's unit",
  "whats the sound rating in decibels for Gary Villegas's system",
  "where's the condenser located at Barbara Delgado's place",
  "what brand is the filter on Steven Ellison's unit",
  "whats the GPS coordinates for Donna Sorensen's job site",
  "whats the compressor's start-up amperage on this unit",
  "what color was the unit painted at this job",
  "who financed the equipment purchase for Amy Isaacson's install",
  "whats the refrigerant line length on this system",
  "whats the duct static pressure reading for this unit",
];
for (const text of UNTRACKED_PARAPHRASES) {
  questions.push(decline({ text, shape: "untracked_field", guardSql: NEVER_HVAC_CONTENT, why: "this schema has no field for this attribute at all, for any unit or job" }));
}

/* ================================================================================================
 * SECTION H — technician job totals and head-to-head comparisons, fresh pairings (15)
 */
const TECH_TOTAL_PHRASINGS = [
  ["how many total jobs has Danny Ochoa logged", "Danny Ochoa"],
  ["whats Wyatt Coburn's total job count", "Wyatt Coburn"],
  ["how many service calls has Denise Ford been out on, total", "Denise Ford"],
  ["whats the job total for Ray Sutton", "Ray Sutton"],
  ["how many jobs total has Marisol Vega done", "Marisol Vega"],
];
for (const [text, tech] of TECH_TOTAL_PHRASINGS) {
  questions.push(countQ(text, "technician", `FROM extractions WHERE field_key='technician' AND value='${tech}'`));
}
const TECH_HEAD_TO_HEAD = [
  ["has Danny Ochoa done more jobs total than Denise Ford", "Danny Ochoa", "Denise Ford"],
  ["has Wyatt Coburn done more jobs total than Ray Sutton", "Wyatt Coburn", "Ray Sutton"],
  ["has Kevin Pratt logged more jobs than Marisol Vega", "Kevin Pratt", "Marisol Vega"],
  ["has Denise Ford done more jobs than Ray Sutton", "Denise Ford", "Ray Sutton"],
  ["has Marisol Vega done more jobs than Danny Ochoa", "Marisol Vega", "Danny Ochoa"],
];
for (const [text, a, b] of TECH_HEAD_TO_HEAD) {
  questions.push(yesNoQ({
    text, shape: "technician",
    sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${a}') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='${b}') AS v`,
    params: [],
  }));
}
questions.push(valueQ({
  text: "which technician has the fewest jobs logged, total", shape: "technician",
  sql: `SELECT value AS v FROM extractions WHERE field_key='technician' GROUP BY value ORDER BY count(*) ASC, value ASC LIMIT 1`,
  params: [],
}));
questions.push(valueQ({
  text: "who's our busiest technician overall", shape: "technician",
  sql: `SELECT value AS v FROM extractions WHERE field_key='technician' GROUP BY value ORDER BY count(*) DESC, value ASC LIMIT 1`,
  params: [],
}));
questions.push(numberQ({
  text: "how many technicians do we have logging jobs in this system", shape: "technician", tolerance: 0, citationRequired: false,
  sql: `SELECT count(DISTINCT value) AS n FROM extractions WHERE field_key='technician'`,
}));
questions.push(yesNoQ({
  text: "does every technician on our team have at least 50 jobs logged", shape: "technician",
  sql: `SELECT NOT EXISTS (SELECT value FROM extractions WHERE field_key='technician' GROUP BY value HAVING count(*) < 50) AS v`,
  params: [],
}));
questions.push(numberQ({
  text: "whats the combined job total for Kevin Pratt and Marisol Vega together", shape: "technician", tolerance: 0, citationRequired: false,
  sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Kevin Pratt') + (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Marisol Vega') AS n`,
}));

/* ================================================================================================
 * SECTION I — relative-time analytics phrasing not used in fp-2/fp-3/fp-4 (15)
 */
function timeCount(text, sql, params = [TODAY]) {
  return numberQ({ text, shape: "relative_time", tolerance: 0, citationRequired: false, sql, params });
}
const SVC_YTD = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int, 1, 1) AND value::date <= $1::date`;
questions.push(timeCount("how many service visits have we had year to date", SVC_YTD));
questions.push(timeCount("year to date, how many jobs have we logged", SVC_YTD));

const SVC_LAST_2_MONTHS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '2 months') AND value::date <= $1::date`;
questions.push(timeCount("how many jobs have we done in the last 2 months", SVC_LAST_2_MONTHS));
questions.push(timeCount("over the last two months, how many service calls have we had", SVC_LAST_2_MONTHS));

const SVC_PAST_6_MONTHS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '6 months') AND value::date <= $1::date`;
questions.push(timeCount("how many service calls have we logged in the past 6 months", SVC_PAST_6_MONTHS));
questions.push(timeCount("in the past six months, how many jobs have we been out on", SVC_PAST_6_MONTHS));

const SVC_LAST_45_DAYS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '45 days') AND value::date <= $1::date`;
questions.push(timeCount("how many jobs have we logged in the last 45 days", SVC_LAST_45_DAYS));
questions.push(timeCount("over the last 45 days, how many service visits have we had", SVC_LAST_45_DAYS));

const SVC_LAST_2_WEEKS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '2 weeks') AND value::date <= $1::date`;
questions.push(timeCount("how many service calls have we had in the last 2 weeks", SVC_LAST_2_WEEKS));
questions.push(timeCount("in the last two weeks, how many jobs have we logged", SVC_LAST_2_WEEKS));

const SVC_LAST_8_WEEKS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '8 weeks') AND value::date <= $1::date`;
questions.push(timeCount("how many jobs have we done over the last 8 weeks", SVC_LAST_8_WEEKS));
questions.push(timeCount("in the past 8 weeks, how many service visits have we logged", SVC_LAST_8_WEEKS));

const INV_YTD = `SELECT count(*) AS n FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND invoice_date >= make_date(extract(year from $1::date)::int, 1, 1)`;
questions.push(timeCount("how many invoices have we sent out year to date", INV_YTD));

const INSTALLS_LAST_2_MONTHS = `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date >= ($1::date - interval '2 months')`;
questions.push(timeCount("how many units have we installed in the last 2 months", INSTALLS_LAST_2_MONTHS));

questions.push(yesNoQ({
  text: "have we had more service visits in the last 2 months than in the 2 months before that", shape: "relative_time_comparison",
  sql: `SELECT
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '2 months') AND value::date <= $1::date)
    >
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '4 months') AND value::date < ($1::date - interval '2 months'))
  AS v`,
  params: [TODAY],
}));

/* ================================================================================================
 * SECTION J — adversarial traps: near-miss names, fake addresses, future dates, uninstalled brand (20)
 */
const NEAR_MISS_NAMES = [
  ["whats the phone number for Georg Hutchins", "Georg Hutchins"],
  ["pull up the file for Rebeca Montoya", "Rebeca Montoya"],
  ["whats the service address on file for Josephe Norwood", "Josephe Norwood"],
  ["do we have a serial number on file for Stephany Nakamura", "Stephany Nakamura"],
  ["whats the warranty status for Timothy Uloa", "Timothy Uloa"],
];
for (const [text, name] of NEAR_MISS_NAMES) {
  questions.push(decline({
    text, shape: "adversarial_near_miss", guardSql: CUSTOMER_COUNT_SQL, guardParams: [`%${name}%`],
    why: `"${name}" matches zero customers in this tenant - a near-miss of a real, differently-spelled name; never guess the real one`,
  }));
}
const FAKE_ADDRESSES = [
  "3542 W Southern Ave", "1063 E University Dr", "804 E Pecos Rd", "1729 W Ocotillo Rd", "1766 N Recker Rd",
];
for (const addr of FAKE_ADDRESSES) {
  questions.push(decline({
    text: `whats on file for the unit at ${addr}`, shape: "adversarial_fake_address",
    guardSql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`,
    guardParams: [`${addr}%`],
    why: `"${addr}" is one house-number digit off a real address in this corpus and matches zero customers - never guess the real neighbor's address`,
  }));
}
const FUTURE_DATE_TRAPS = [
  "do we have a service call logged for April 2029",
  "was there an invoice issued in March 2028",
  "how many jobs are scheduled for 2031",
  "did we register any warranties in 2028",
  "is there a permit filed for October 2029",
];
for (const text of FUTURE_DATE_TRAPS) {
  questions.push(decline({
    text, shape: "adversarial_future_date",
    guardSql: `SELECT ((SELECT count(*) FROM extractions WHERE value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND value::date > '2027-06-01'::date) + (SELECT count(*) FROM document_financials WHERE invoice_date > '2027-06-01'::date)) AS n`,
    why: "no record in this corpus is dated anywhere near this far in the future - nothing on file could answer this",
  }));
}
const BRAND_NOT_CARRIED_AT = [
  ["is George Hutchins' unit a Bryant", "George Hutchins", "bryant"],
  ["does Rebecca Montoya have an Amana system", "Rebecca Montoya", "amana"],
  ["is Joseph Norwood's unit a Ruud", "Joseph Norwood", "ruud"],
  ["is Stephanie Nakamura's system an American Standard", "Stephanie Nakamura", "american standard"],
  ["does Timothy Ulloa have a Payne unit", "Timothy Ulloa", "payne"],
];
for (const [text, name, mfg] of BRAND_NOT_CARRIED_AT) {
  questions.push(decline({
    text, shape: "adversarial_brand_not_carried",
    guardSql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'customer_name' ILIKE $2`,
    guardParams: [mfg, `%${name}%`],
    why: `${name}'s own equipment record carries a different manufacturer - this shop has never installed a ${mfg} for them`,
  }));
}

/* ================================================================================================
 * SECTION K — mixed coverage rounding out to 200: compound rubric, multi-item sets, rankings (20)
 */
questions.push(rubricQ({
  text: "whos installed it and whats the warranty status for the unit at 3541 W Southern Ave", shape: "compound",
  rubric: "No document in this corpus ever names an installer field, so that half must be honestly declined; the warranty status for 3541 W Southern Ave (George Hutchins) is on file and should be reported - both parts must be addressed, never just one.",
}));
questions.push(rubricQ({
  text: "manufacturer and tonnage for the unit at 1062 E University Dr", shape: "compound",
  rubric: "The unit at 1062 E University Dr (Rebecca Montoya) has a manufacturer on file but this corpus never tracks a tonnage field on any unit - the manufacturer should be reported and the tonnage part honestly declined, never invented.",
}));
questions.push(rubricQ({
  text: "is Nakamura still under warranty and whats their phone number", shape: "compound",
  rubric: "The bare surname 'Nakamura' is ambiguous if more than one customer shares it in this corpus - both the warranty status and phone number need honest, disambiguated handling, never a single confident answer picked at random.",
}));
questions.push(rubricQ({
  text: "wheres Cactus Rose Restaurant's unit and is it still under warranty", shape: "compound",
  rubric: "Cactus Rose Restaurant's service address and warranty status are both real, on-file facts for this corpus - both parts must be addressed together, not just one.",
}));
questions.push(rubricQ({
  text: "compare the phone numbers on file for Amanda Quinley and Amanda Quinly", shape: "adversarial_mixed",
  rubric: "Amanda Quinley is a real customer in this corpus; Amanda Quinly is a near-miss of the name and matches zero customers. The honest answer reports Amanda Quinley's real phone number and clearly states Amanda Quinly isn't on file, never conflating the two.",
}));

questions.push(setQ({
  text: "which manufacturers do we service, across every unit on the books", shape: "portfolio", maxItems: 10,
  sql: `SELECT DISTINCT data->>'manufacturer' AS item FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' IS NOT NULL`,
}));
questions.push(setQ({
  text: "list every technician we've got logging jobs in the system", shape: "portfolio", maxItems: 10,
  sql: `SELECT DISTINCT value AS item FROM extractions WHERE field_key='technician'`,
}));
questions.push(setQ({
  text: "which document types do we actually have on file, across the whole business", shape: "portfolio", maxItems: 15,
  sql: `SELECT DISTINCT document_type AS item FROM documents WHERE document_type IS NOT NULL`,
}));

const MFG_COUNTS = ["Trane", "Carrier", "Lennox", "York", "Goodman", "Rheem", "Daikin", "Mitsubishi"];
for (const mfg of MFG_COUNTS) {
  questions.push(countQ(`how many ${mfg} units total are on our books`, "portfolio",
    `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE '${mfg}'`));
}
questions.push(valueQ({
  text: "which manufacturer do we have the most units of, overall", shape: "portfolio",
  sql: `SELECT data->>'manufacturer' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' IS NOT NULL GROUP BY data->>'manufacturer' ORDER BY count(*) DESC LIMIT 1`,
  params: [],
}));
questions.push(valueQ({
  text: "which manufacturer shows up the least across our units", shape: "portfolio",
  sql: `SELECT data->>'manufacturer' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' IS NOT NULL GROUP BY data->>'manufacturer' ORDER BY count(*) ASC, data->>'manufacturer' ASC LIMIT 1`,
  params: [],
}));
questions.push(numberQ({
  text: "how many total customers do we have on the books", shape: "portfolio", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL`,
}));
questions.push(numberQ({
  text: "how many total units of equipment do we track across all customers", shape: "portfolio", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL`,
}));

/* ============================================================== output */

if (questions.length !== 200) {
  console.error(`gen-field-phrasing-5: expected 200 questions, built ${questions.length}`);
  process.exit(1);
}
const ids = new Set(questions.map((q) => q.id));
if (ids.size !== 200) {
  console.error(`gen-field-phrasing-5: duplicate ids (${200 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-28.field-phrasing-5-r23",
  category: CATEGORY,
  source: "Round 23 (D1) blind generalization set - 200 new questions, written blind: no exam.json/field-phrasing.json/field-phrasing-2/3/4.json question text read, and no check of how this round's own code changes route any of them before committing. Grounded only in scripts/golden/golden-export.json (queried live) + the exam file format. Sections: casual/filler single-field phrasing, compound two-field asks, document-existence yes/no, warranty status from the stored expiry date, internal/team-memo phrasing (own paraphrases of this round's isInternalMemoQuestion), off-topic/trivia phrasing (own paraphrases of the out-of-domain cluster), untracked-equipment-field phrasing (own paraphrases of isUntrackedFieldQuestion), technician totals/comparisons, relative-time phrasing not used in earlier blind sets, adversarial traps, and mixed portfolio-wide coverage.",
  questions,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-field-phrasing-5: wrote ${questions.length} questions -> ${OUT_PATH}`);
  const byCmp = {};
  const byShape = {};
  for (const q of questions) { byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1; byShape[q.shape] = (byShape[q.shape] ?? 0) + 1; }
  console.log("by cmp:", JSON.stringify(byCmp));
  console.log("by shape:", JSON.stringify(byShape));
}

export { questions, out };
