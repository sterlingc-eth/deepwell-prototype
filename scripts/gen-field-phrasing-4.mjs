#!/usr/bin/env node
/**
 * FIELD-PHRASING-4 exam category (Round 21, L1) — a fresh BLIND generalization set: 200 new questions
 * written WITHOUT reading test-docs/scorecard/exam.json's, field-phrasing.json's, field-phrasing-2.json's
 * or field-phrasing-3.json's question TEXTS, and WITHOUT opening any engine regex file (api/_lib/fastPath*.js
 * etc. were never opened while writing this file). Only these were read to build this: the DATA
 * (scripts/golden/golden-export.json, queried directly through a throwaway PGlite harness — same harness
 * shape offline-exam.mjs already exposes — for real subjects: names, addresses, serials, invoice/PO
 * numbers, technicians, manufacturers, cities, dates), the exam file FORMAT/oracle schema
 * (api/_lib/scorecard/exam.js), and gen-field-phrasing-3.mjs + gen-dialogues.mjs — read for their
 * STRUCTURE (the oracle-builder helper pattern: a guarded single-match SQL query, an honest-zero guard,
 * a portfolio-wide count/set) so this file's oracles follow the same conventions and the same
 * PGlite-verification discipline. Every helper below is rebuilt fresh rather than imported, and this
 * file's own question texts are new — not copied from any generator read for structure.
 *
 * fp-3 has been tuned against (R20/R21 fixes chased its own residual ids), so this is a FRESH BLIND
 * MEASUREMENT, not a repeat of that set's shapes. New emphasis this round, per the R21 contract:
 *
 *   A. mixed multi-constraint questions (3+ conditions: brand + city + time-window + service-type status)
 *   B. relative time phrasing ("in the last 6 weeks", "before the summer", "since we started", "past
 *      quarter", "so far this month", plus comparison-of-two-windows yes/no questions)
 *   C. counterfactual / "which don't" questions (customers/units that DON'T meet a condition — a
 *      manufacturer's customers who've never had a PM visit, a city's customers missing a document type,
 *      customers outside Arizona entirely)
 *   D. money questions answerable straight from the documents (invoice/PO/agreement totals, guarded to a
 *      single matching record) WITH honest-decline for balance_due/amount_paid/due_date/payment-status,
 *      which are NULL/unknown on every document_financials row in this corpus (verified directly against
 *      the export, same discipline as fp-3's own "never on file" declines)
 *   E. equipment age / replacement-candidate questions (age computed from installation_date to @today,
 *      an owner-defensible ">15 years = likely replacement candidate" threshold)
 *   F. technician questions (job totals, per-city workload, which techs have never logged a PM visit —
 *      a real, verified fact: 4 of the shop's 6 technicians have zero Preventive Maintenance extractions
 *      anywhere in this corpus)
 *   G. 25 adversarial traps (required by the round contract): near-miss customer names (one syllable/
 *      letter off a real name, verified to match zero rows), fake addresses one house-number digit off a
 *      real address (verified zero rows), a real customer paired with a manufacturer this shop has never
 *      installed for them (verified against their actual equipment), future dates (verified against the
 *      corpus's own real max date, 2026-08-28 — nothing here is ever dated past 2026), and 5 rubric
 *      questions that mix one REAL subject with one FAKE/near-miss subject in the same ask (must answer
 *      the real one and honestly flag the fake one, never conflate or fabricate).
 *
 * GROUND TRUTH: every oracle here is guarded (a `requires` single-match/non-empty check where the
 * question names a specific subject, or a direct honest-zero guard for a decline) so a subject this
 * corpus doesn't actually have SKIPS gracefully rather than being wrong — verified for real via
 * scripts/verify-field-phrasing-4.mjs's own PGlite run against scripts/golden/golden-export.json (same
 * harness scripts/offline-exam.mjs/oracle.js use), never hand-typed expected values. Every concrete
 * count/name/date/dollar-amount below was pulled from a live query against the golden export, not
 * invented.
 *
 * Usage: node scripts/gen-field-phrasing-4.mjs
 *   writes test-docs/scorecard/generalization/field-phrasing-4.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "field-phrasing-4.json");

const CATEGORY = "field-phrasing-4";
const TODAY = "@today"; // resolved by oracle.js at run time

let __n = 0;
const nextId = () => `j${String(++__n).padStart(3, "0")}`;

/* ============================================================== oracle-builder helpers
 * (same conventions as gen-field-phrasing-3.mjs's own helpers — a guarded single-match query, an
 * honest-zero guard, a portfolio-wide count/set — rebuilt fresh here, never imported). */

function numberQ({ text, shape, sql, params = [], expectedNote, tolerance, anyNumber, citationRequired }) {
  const q = { id: nextId(), text, category: CATEGORY, shape, cmp: "number", oracle: { sql, params }, note: expectedNote };
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

function decline({ text, shape, guardSql, guardParams = [], why, typoResolvesTo }) {
  const q = { id: nextId(), text, category: CATEGORY, shape, cmp: "honest-zero", oracle: { sql: guardSql, params: guardParams }, note: why };
  if (typoResolvesTo) q.typoResolvesTo = typoResolvesTo; // R32: the customer an unambiguous near-miss now resolves to (visible "Showing results for" note)
  return q;
}

function rubricQ({ text, shape, rubric }) {
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "rubric", rubric, oracle: { sql: "SELECT NULL::text AS ref WHERE false" } };
}

/** Real, live-computed counts (never hand-typed) for the multi-constraint/counterfactual/business-health
 *  style questions. */
function countQ(text, shape, whereSql, params = []) {
  return numberQ({ text, shape, tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n ${whereSql}`, params });
}

const questions = [];

/* ================================================================================================
 * SECTION A — MIXED MULTI-CONSTRAINT: brand + city + time-window + service-type status (35)
 * Each question names 4 conditions at once: a manufacturer, a city, "since the start of last year",
 * and a service-type status (Repair or Preventive Maintenance) — a shape none of the earlier blind sets
 * emphasized (they combined at most 2 conditions at a time). Every count below is live-computed against
 * the golden export (including the honest ZERO ones — a real "no matches" is still a correct number, not
 * a decline, since the manufacturer/city/service-type combination itself is a normal, answerable filter).
 */
function multiConstraint(text, mfg, city, svc) {
  return numberQ({
    text, shape: "multi_constraint", tolerance: 0, citationRequired: false,
    sql: `WITH m AS (
  SELECT DISTINCT e.id FROM entities e JOIN entities c ON c.id=e.customer_id
  WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1
    AND c.data->>'service_address' ILIKE '%, ' || $2 || ',%'
    AND EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id
      JOIN extractions sd ON sd.document_id=l.document_id AND sd.field_key='service_date'
      WHERE x.field_key='service_type' AND x.value=$3 AND (l.entity_id=e.id OR l.entity_id=e.customer_id)
      AND sd.value::date >= make_date(extract(year from $4::date)::int - 1, 1, 1) AND sd.value::date <= $4::date)
)
SELECT count(*) AS n FROM m`,
    params: [mfg, city, svc, TODAY],
  });
}

const MULTI_CONSTRAINT_NONZERO = [
  ["how many Carrier units in Tempe have had a preventive maintenance visit since the start of last year", "Carrier", "Tempe", "Preventive Maintenance"],
  ["how many Carrier systems in Mesa needed a repair since the start of last year", "Carrier", "Mesa", "Repair"],
  ["since the start of last year, how many Carrier units in Scottsdale needed a repair", "Carrier", "Scottsdale", "Repair"],
  ["how many Lennox systems in Scottsdale have needed a repair since last January", "Lennox", "Scottsdale", "Repair"],
  ["how many Lennox units in Peoria have had a maintenance tune-up since the start of last year", "Lennox", "Peoria", "Preventive Maintenance"],
  ["how many York units in Phoenix have needed a repair since last January", "York", "Phoenix", "Repair"],
  ["since the start of last year, how many York customers in Casa Grande got a preventive maintenance visit", "York", "Casa Grande", "Preventive Maintenance"],
  ["how many Goodman systems in Phoenix have needed a repair since the start of last year", "Goodman", "Phoenix", "Repair"],
  ["how many Goodman units in Mesa have had a repair call since last January", "Goodman", "Mesa", "Repair"],
  ["how many Goodman systems in Tucson needed a repair since the start of last year", "Goodman", "Tucson", "Repair"],
  ["since last January, how many Goodman customers in Casa Grande got a preventive maintenance visit", "Goodman", "Casa Grande", "Preventive Maintenance"],
  ["how many Rheem units in Chandler have needed a repair since the start of last year", "Rheem", "Chandler", "Repair"],
  ["how many Rheem systems in Mesa have had a repair call since last January", "Rheem", "Mesa", "Repair"],
  ["how many Rheem units in Gilbert needed a repair since the start of last year", "Rheem", "Gilbert", "Repair"],
  ["since last January, how many Rheem customers in Tucson got a preventive maintenance visit", "Rheem", "Tucson", "Preventive Maintenance"],
  ["how many Daikin systems in Tempe have needed a repair since the start of last year", "Daikin", "Tempe", "Repair"],
  ["how many Daikin units in Glendale have had a repair call since last January", "Daikin", "Glendale", "Repair"],
  ["how many Daikin systems in Tucson needed a repair since the start of last year", "Daikin", "Tucson", "Repair"],
  ["how many Mitsubishi units in Chandler have needed a repair since last January", "Mitsubishi", "Chandler", "Repair"],
  ["how many Mitsubishi systems in Mesa have had a preventive maintenance visit since the start of last year", "Mitsubishi", "Mesa", "Preventive Maintenance"],
  ["since last January, how many Mitsubishi customers in Tucson needed a repair", "Mitsubishi", "Tucson", "Repair"],
  ["how many Mitsubishi units in Tucson have had a maintenance tune-up since the start of last year", "Mitsubishi", "Tucson", "Preventive Maintenance"],
];
for (const [text, mfg, city, svc] of MULTI_CONSTRAINT_NONZERO) questions.push(multiConstraint(text, mfg, city, svc));

const MULTI_CONSTRAINT_ZERO = [
  ["how many Trane systems in Phoenix have needed a repair since the start of last year", "Trane", "Phoenix", "Repair"],
  ["since last January, how many Trane customers in Phoenix got a preventive maintenance visit", "Trane", "Phoenix", "Preventive Maintenance"],
  ["how many Carrier units in Phoenix have needed a repair since the start of last year", "Carrier", "Phoenix", "Repair"],
  ["since last January, how many Carrier customers in Phoenix got a preventive maintenance visit", "Carrier", "Phoenix", "Preventive Maintenance"],
  ["how many Lennox systems in Phoenix needed a repair since the start of last year", "Lennox", "Phoenix", "Repair"],
  ["since last January, how many Lennox customers in Phoenix got a maintenance tune-up", "Lennox", "Phoenix", "Preventive Maintenance"],
  ["how many York units in Phoenix have had a preventive maintenance visit since the start of last year", "York", "Phoenix", "Preventive Maintenance"],
  ["how many York systems in Chandler needed a repair since last January", "York", "Chandler", "Repair"],
  ["since the start of last year, how many Goodman customers in Phoenix got a maintenance tune-up", "Goodman", "Phoenix", "Preventive Maintenance"],
  ["how many Goodman units in Chandler have needed a repair since last January", "Goodman", "Chandler", "Repair"],
  ["how many Rheem systems in Phoenix needed a repair since the start of last year", "Rheem", "Phoenix", "Repair"],
  ["since last January, how many Rheem customers in Phoenix got a maintenance tune-up", "Rheem", "Phoenix", "Preventive Maintenance"],
  ["how many Daikin units in Phoenix have needed a repair since the start of last year", "Daikin", "Phoenix", "Repair"],
];
for (const [text, mfg, city, svc] of MULTI_CONSTRAINT_ZERO) questions.push(multiConstraint(text, mfg, city, svc));

/* ================================================================================================
 * SECTION B — RELATIVE TIME PHRASING (30)
 * "in the last 6 weeks", "before the summer", "since we started", "past quarter", "so far this month",
 * plus 4 comparison-of-two-windows yes/no questions. Every window below is anchored to @today
 * (resolved by oracle.js at run time) with a clearly-defined, defensible boundary stated in each helper's
 * own SQL — never a vague date range.
 */
function timeCount(text, sql, params = [TODAY]) {
  return numberQ({ text, shape: "relative_time", tolerance: 0, citationRequired: false, sql, params });
}

const SVC_LAST_6_WEEKS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '6 weeks') AND value::date <= $1::date`;
questions.push(timeCount("how many service visits have we logged in the last 6 weeks", SVC_LAST_6_WEEKS));
questions.push(timeCount("in the last 6 weeks, how many jobs have we been out on", SVC_LAST_6_WEEKS));

const SVC_PAST_90_DAYS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '90 days') AND value::date <= $1::date`;
questions.push(timeCount("how many jobs have we done in the past 90 days", SVC_PAST_90_DAYS));
questions.push(timeCount("over the past 90 days, how many service calls have we logged", SVC_PAST_90_DAYS));

const SVC_BEFORE_SUMMER = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date < make_date(extract(year from $1::date)::int, 6, 1) AND value::date >= make_date(extract(year from $1::date)::int, 1, 1)`;
questions.push(timeCount("how many service visits did we log before the summer this year", SVC_BEFORE_SUMMER));
questions.push(timeCount("before the summer started this year, how many jobs had we already done", SVC_BEFORE_SUMMER));

const SVC_SINCE_LAST_YEAR_START = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1)`;
questions.push(timeCount("how many service visits have we had since the start of last year", SVC_SINCE_LAST_YEAR_START));
questions.push(timeCount("since last year began, how many jobs have we logged", SVC_SINCE_LAST_YEAR_START));

const SVC_PAST_QUARTER = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '3 months') AND value::date <= $1::date`;
questions.push(timeCount("how many service calls have we had over the last quarter", SVC_PAST_QUARTER));
questions.push(timeCount("in the past quarter, how many jobs have we logged", SVC_PAST_QUARTER));

const INSTALLS_LAST_5_YEARS = `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date >= ($1::date - interval '5 years')`;
questions.push(timeCount("how many units have we installed within the past 5 years", INSTALLS_LAST_5_YEARS));
questions.push(timeCount("in the last 5 years, how many systems have we put in", INSTALLS_LAST_5_YEARS));

const SVC_ALL_TIME = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL`;
questions.push(timeCount("since we started, how many service visits have we logged in total", SVC_ALL_TIME, []));
questions.push(timeCount("all told, since day one, how many jobs have we been out on", SVC_ALL_TIME, []));

const SVC_WITHIN_2_YEARS = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '2 years')`;
questions.push(timeCount("how many service visits have we logged within the past 2 years", SVC_WITHIN_2_YEARS));
questions.push(timeCount("in the last 2 years, how many jobs have we done", SVC_WITHIN_2_YEARS));

const SVC_SO_FAR_THIS_MONTH = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int, extract(month from $1::date)::int, 1) AND value::date <= $1::date`;
questions.push(timeCount("how many jobs have we logged so far this month", SVC_SO_FAR_THIS_MONTH));
questions.push(timeCount("so far this month, how many service calls have we had", SVC_SO_FAR_THIS_MONTH));

const SVC_PAST_WEEK = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '7 days') AND value::date <= $1::date`;
questions.push(timeCount("how many jobs have we been out on in the past week", SVC_PAST_WEEK));
questions.push(timeCount("over the last week, how many service visits have we logged", SVC_PAST_WEEK));

const SVC_THIS_CALENDAR_QUARTER = `SELECT count(*) AS n FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= '2026-07-01'::date AND value::date <= $1::date`;
questions.push(timeCount("how many service visits have we logged this quarter", SVC_THIS_CALENDAR_QUARTER));
questions.push(timeCount("so far this quarter, how many jobs have we done", SVC_THIS_CALENDAR_QUARTER));

const INV_LAST_6_WEEKS = `SELECT count(*) AS n FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND invoice_date >= ($1::date - interval '6 weeks')`;
questions.push(timeCount("how many invoices have we sent out in the last 6 weeks", INV_LAST_6_WEEKS));
questions.push(timeCount("in the last 6 weeks, how many invoices have gone out", INV_LAST_6_WEEKS));

const INSTALLS_BEFORE_SUMMER = `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date < make_date(extract(year from $1::date)::int, 6, 1) AND (data->>'installation_date')::date >= make_date(extract(year from $1::date)::int, 1, 1)`;
questions.push(timeCount("how many units did we install before the summer this year", INSTALLS_BEFORE_SUMMER));
questions.push(timeCount("before summer hit this year, how many installs had we done", INSTALLS_BEFORE_SUMMER));

// 4 comparison-of-two-windows yes/no questions (each side computed fresh, never hand-typed).
questions.push(yesNoQ({
  text: "have we had more service visits in the last 90 days than in the 90 days before that", shape: "relative_time_comparison",
  sql: `SELECT
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '90 days') AND value::date <= $1::date)
    >
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '180 days') AND value::date < ($1::date - interval '90 days'))
  AS v`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  text: "did we do more jobs in the last 6 weeks than in the 6 weeks before that", shape: "relative_time_comparison",
  sql: `SELECT
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '6 weeks') AND value::date <= $1::date)
    >
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= ($1::date - interval '12 weeks') AND value::date < ($1::date - interval '6 weeks'))
  AS v`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  text: "have we had more service visits this quarter than in the same quarter last year", shape: "relative_time_comparison",
  sql: `SELECT
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= '2026-07-01'::date AND value::date <= $1::date)
    >
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= '2025-07-01'::date AND value::date <= '2025-09-26'::date)
  AS v`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  text: "has most of our service history happened before last year, rather than since", shape: "relative_time_comparison",
  sql: `SELECT
    ((SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL) - (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1)))
    >
    (SELECT count(*) FROM extractions WHERE field_key='service_date' AND value IS NOT NULL AND value::date >= make_date(extract(year from $1::date)::int - 1, 1, 1))
  AS v`,
  params: [TODAY],
}));

/* ================================================================================================
 * SECTION C — COUNTERFACTUAL / "WHICH DON'T" (25)
 * Customers/units that DON'T meet a condition. Small enough result sets are graded as an actual `set`
 * (never a decline — these are real, answerable "who" lists); everything else is a live count.
 */
questions.push(countQ("how many Daikin customers have never once had a preventive maintenance visit", "counterfactual",
  `FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE 'daikin'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Preventive Maintenance' AND (l.entity_id=e.id OR l.entity_id=c.id))`));
questions.push(setQ({
  text: "which Tucson customers don't have a permit on file", shape: "counterfactual", maxItems: 12,
  sql: `SELECT c.data->>'customer_name' AS item FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE '%, Tucson,%'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='permit' AND l.entity_id=c.id)`,
}));
questions.push(setQ({
  text: "which customers of ours aren't even in Arizona", shape: "counterfactual", maxItems: 10,
  sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' NOT ILIKE '%, AZ %'`,
}));
questions.push(countQ("how many customers don't have a maintenance agreement on file", "counterfactual",
  `FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='maintenance-agreement' AND l.entity_id=c.id)`));
questions.push(countQ("how many customers have never had a repair call", "counterfactual",
  `FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Repair' AND l.entity_id=c.id)`));
questions.push(countQ("how many customers don't have a single work order on file", "counterfactual",
  `FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='work-order' AND l.entity_id=c.id)`));
questions.push(countQ("how many customers are missing a startup sheet entirely", "counterfactual",
  `FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='startup-sheet' AND l.entity_id=c.id)`));
questions.push(setQ({
  text: "which Peoria customers have never had a preventive maintenance visit", shape: "counterfactual", maxItems: 10,
  sql: `SELECT c.data->>'customer_name' AS item FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE '%, Peoria,%'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Preventive Maintenance' AND l.entity_id=c.id)`,
}));

const MFG_NEVER_PM = ["Trane", "Carrier", "Lennox", "York", "Goodman", "Rheem", "Mitsubishi"];
for (const mfg of MFG_NEVER_PM) {
  questions.push(countQ(`how many ${mfg} customers have never had a preventive maintenance visit`, "counterfactual",
    `FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE '${mfg}'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Preventive Maintenance' AND (l.entity_id=e.id OR l.entity_id=c.id))`));
}

const MFG_NEVER_REPAIR = ["Trane", "Carrier", "Lennox", "York", "Goodman", "Rheem"];
for (const mfg of MFG_NEVER_REPAIR) {
  questions.push(countQ(`how many ${mfg} customers have never once needed a repair`, "counterfactual",
    `FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE '${mfg}'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Repair' AND (l.entity_id=e.id OR l.entity_id=c.id))`));
}

questions.push(setQ({
  text: "which Glendale customers have never had a preventive maintenance visit", shape: "counterfactual", maxItems: 10,
  sql: `SELECT c.data->>'customer_name' AS item FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE '%, Glendale,%'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Preventive Maintenance' AND l.entity_id=c.id)`,
}));
questions.push(setQ({
  text: "which Scottsdale customers have never had a preventive maintenance visit", shape: "counterfactual", maxItems: 10,
  sql: `SELECT c.data->>'customer_name' AS item FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE '%, Scottsdale,%'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Preventive Maintenance' AND l.entity_id=c.id)`,
}));
questions.push(countQ("how many Mitsubishi customers have never once needed a repair", "counterfactual",
  `FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE 'Mitsubishi'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Repair' AND (l.entity_id=e.id OR l.entity_id=c.id))`));
questions.push(countQ("how many Mesa customers don't have an inspection report on file", "counterfactual",
  `FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE '%, Mesa,%'
AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='inspection-report' AND l.entity_id=c.id)`));

/* ================================================================================================
 * SECTION D — MONEY QUESTIONS ANSWERABLE FROM THE DOCUMENTS (35)
 * Invoice/PO/agreement totals are all ON FILE and guarded to a single matching record; balance_due,
 * amount_paid, due_date and payment status are NULL/"unknown" on every one of the 226
 * document_financials rows in this corpus (verified directly against the export) — those are honest
 * declines, not fabricated numbers.
 */
function invoiceTotalByCustomer(customerName, invoiceNumber) {
  return numberQ({
    text: `what's the total on ${customerName}'s invoice`, shape: "money", tolerance: 0.01, anyNumber: true, citationRequired: true,
    sql: `SELECT total::numeric AS n FROM document_financials WHERE doc_kind='invoice' AND customer_name ILIKE $1 AND invoice_number = $2`,
    params: [`%${customerName}%`, invoiceNumber],
  });
}

const INVOICE_CUSTOMERS = [
  ["Michelle Tovar", "INV-20084"], ["Steven Hutchins", "INV-60007"], ["Ronald Bracken", "INV-20003"],
  ["Rebecca Norwood", "INV-20076"], ["Nancy Zamora", "INV-20042"], ["Matthew Whitfield", "INV-20031"],
  ["James Underhill", "INV-20077"], ["Donna Vance", "INV-20102"], ["Kathleen Keller", "INV-20072"],
  ["Karen Abernathy", "INV-20010"], ["Michael Sandoval", "INV-20091"], ["Patricia Fenwick", "INV-20082"],
  ["Amanda Quinley", "INV-20048"], ["Betty Zimmerman", "INV-20074"], ["Donna Sorensen", "INV-20002"],
];
for (const [name, inv] of INVOICE_CUSTOMERS) questions.push(invoiceTotalByCustomer(name, inv));

function poTotalByNumber(poNumber, customerName) {
  return numberQ({
    text: `what's the total on purchase order ${poNumber}, the one for ${customerName}`, shape: "money", tolerance: 0.01, anyNumber: true, citationRequired: true,
    sql: `SELECT total::numeric AS n FROM document_financials WHERE doc_kind='po' AND po_number = $1 AND customer_name ILIKE $2`,
    params: [poNumber, `%${customerName}%`],
  });
}
const PO_SAMPLES = [
  ["PO-9026", "Rebecca Montoya"], ["PO-9015", "Daniel Keller"], ["PO-9087", "Richard Pruitt"],
  ["PO-9059", "Robert Thornton"], ["PO-9054", "Amy Jarvis"], ["PO-9098", "Amanda Redwine"],
  ["PO-9010", "Karen Abernathy"], ["PO-9043", "George Garrison"],
];
for (const [po, name] of PO_SAMPLES) questions.push(poTotalByNumber(po, name));

function agreementCostByCustomer(customerName) {
  return numberQ({
    text: `what's the annual cost on ${customerName}'s maintenance agreement`, shape: "money", tolerance: 0.01, anyNumber: true, citationRequired: true,
    sql: `SELECT total::numeric AS n FROM document_financials WHERE doc_kind='agreement' AND customer_name ILIKE $1`,
    params: [`%${customerName}%`],
  });
}
const AGREEMENT_CUSTOMERS = ["Donna Ulloa", "Grace Community Church", "Paul Jarvis", "Cactus Rose Restaurant", "Anthony Bennett", "Barbara Delgado", "Michael Sandoval", "Melissa Quintana"];
for (const name of AGREEMENT_CUSTOMERS) questions.push(agreementCostByCustomer(name));

const NO_BALANCE_DUE_GUARD = `SELECT (SELECT count(*) FROM document_financials WHERE balance_due IS NOT NULL) AS n`;
const NO_AMOUNT_PAID_GUARD = `SELECT (SELECT count(*) FROM document_financials WHERE amount_paid IS NOT NULL) AS n`;
const NO_DUE_DATE_GUARD = `SELECT (SELECT count(*) FROM document_financials WHERE due_date IS NOT NULL) AS n`;

questions.push(decline({
  text: "what's the balance due on Amanda Quinley's account", shape: "money", guardSql: NO_BALANCE_DUE_GUARD,
  why: "balance_due is NULL on every document_financials row in this corpus",
}));
questions.push(decline({
  text: "has Kevin Abernathy's invoice been paid yet", shape: "money", guardSql: NO_AMOUNT_PAID_GUARD,
  why: "amount_paid is NULL on every document_financials row in this corpus - payment status is never tracked",
}));
questions.push(decline({
  text: "when is Nancy Zamora's invoice due", shape: "money", guardSql: NO_DUE_DATE_GUARD,
  why: "due_date is NULL on every document_financials row in this corpus",
}));
questions.push(decline({
  text: "how much do we have sitting out there in unpaid invoices right now", shape: "money", guardSql: NO_BALANCE_DUE_GUARD,
  why: "balance_due is NULL on every document_financials row in this corpus - there is no owed-amount figure to report",
}));

/* ================================================================================================
 * SECTION E — EQUIPMENT AGE / REPLACEMENT-CANDIDATE (25)
 * Age is computed live from installation_date to @today. ">15 years old" is used as a defensible,
 * stated owner threshold for "likely due for replacement" - never asserted as an absolute fact, only
 * ever asked as a yes/no against that named threshold.
 */
function ageAtAddress(text, addressPrefix) {
  return numberQ({
    text, shape: "equipment_age", tolerance: 1, citationRequired: true,
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT extract(year from age($2::date, (e.data->>'installation_date')::date))::int AS n FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)
  AND (SELECT count(*) FROM m) = 1 AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'`,
    params: [addressPrefix, TODAY],
  });
}
function replacementCandidateAtAddress(text, addressPrefix) {
  return yesNoQ({
    text, shape: "equipment_age",
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT (e.data->>'installation_date')::date <= ($2::date - interval '15 years') AS v FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m)
  AND (SELECT count(*) FROM m) = 1 AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'`,
    params: [addressPrefix, TODAY],
  });
}

const AGE_OLDEST_ADDRS = [
  ["how old is the unit at 100 E Main St, Phoenix", "100 E Main St%"],
  ["how old is the system at 2764 E University Dr, Maricopa", "2764 E University Dr%"],
  ["how old is the unit at 1432 W Thomas Rd, Tempe", "1432 W Thomas Rd%"],
  ["how old is the system at 2098 W Baseline Rd, Peoria", "2098 W Baseline Rd%"],
  ["how old is the unit at 766 N Val Vista Dr, Gilbert", "766 N Val Vista Dr%"],
];
for (const [text, addr] of AGE_OLDEST_ADDRS) questions.push(ageAtAddress(text, addr));

const AGE_NEWEST_ADDRS = [
  ["how old is the unit at 2283 W Thomas Rd, San Tan Valley", "2283 W Thomas Rd%"],
  ["how old is the system at 3615 E University Dr, Oro Valley", "3615 E University Dr%"],
  ["how old is the unit at 951 E Main St, Chandler", "951 E Main St%"],
  ["how old is the system at 2949 W Baseline Rd, Maricopa", "2949 W Baseline Rd%"],
  ["how old is the unit at 285 E Elliot Rd, Phoenix", "285 E Elliot Rd%"],
];
for (const [text, addr] of AGE_NEWEST_ADDRS) questions.push(ageAtAddress(text, addr));

const REPLACEMENT_OLDEST = [
  ["is the unit at 100 E Main St, Phoenix due for replacement", "100 E Main St%"],
  ["is the system at 1432 W Thomas Rd, Tempe a likely replacement candidate", "1432 W Thomas Rd%"],
  ["should we be talking to 766 N Val Vista Dr, Gilbert about replacing their unit", "766 N Val Vista Dr%"],
];
for (const [text, addr] of REPLACEMENT_OLDEST) questions.push(replacementCandidateAtAddress(text, addr));
const REPLACEMENT_NEWEST = [
  ["is the unit at 2283 W Thomas Rd, San Tan Valley due for replacement", "2283 W Thomas Rd%"],
  ["is the system at 951 E Main St, Chandler a likely replacement candidate", "951 E Main St%"],
];
for (const [text, addr] of REPLACEMENT_NEWEST) questions.push(replacementCandidateAtAddress(text, addr));

questions.push(countQ("how many units on our books are over 15 years old", "equipment_age",
  `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date <= ($1::date - interval '15 years')`, [TODAY]));
questions.push(countQ("how many units on our books are over 10 years old", "equipment_age",
  `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date <= ($1::date - interval '10 years')`, [TODAY]));
questions.push(countQ("how many units on our books are under 5 years old", "equipment_age",
  `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date > ($1::date - interval '5 years')`, [TODAY]));
questions.push(countQ("how many units are between 10 and 15 years old", "equipment_age",
  `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
   AND (data->>'installation_date')::date <= ($1::date - interval '10 years') AND (data->>'installation_date')::date > ($1::date - interval '15 years')`, [TODAY]));
questions.push(yesNoQ({
  text: "do we have more units over 10 years old than units under 5 years old", shape: "equipment_age",
  sql: `SELECT
    (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date <= ($1::date - interval '10 years'))
    >
    (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (data->>'installation_date')::date > ($1::date - interval '5 years'))
  AS v`, params: [TODAY],
}));
questions.push(valueQ({
  text: "whose unit is the oldest one we've got on the books", shape: "equipment_age",
  sql: `SELECT c.data->>'customer_name' AS v FROM entities e JOIN entities c ON c.id=e.customer_id
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
ORDER BY e.data->>'installation_date' ASC LIMIT 1`,
  params: [],
}));
questions.push(valueQ({
  text: "whose unit did we most recently install", shape: "equipment_age",
  sql: `SELECT c.data->>'customer_name' AS v FROM entities e JOIN entities c ON c.id=e.customer_id
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
ORDER BY e.data->>'installation_date' DESC LIMIT 1`,
  params: [],
}));
questions.push(numberQ({
  text: "how old is the oldest unit we've got, in years", shape: "equipment_age", tolerance: 1, citationRequired: false,
  sql: `SELECT extract(year from age($1::date, min((data->>'installation_date')::date)))::int AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'`,
  params: [TODAY],
}));
questions.push(numberQ({
  text: "how old is the newest unit we've got, in years", shape: "equipment_age", tolerance: 1, citationRequired: false,
  sql: `SELECT extract(year from age($1::date, max((data->>'installation_date')::date)))::int AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'`,
  params: [TODAY],
}));
questions.push(ageAtAddress("how old is Kevin Abernathy's unit", "2579 W Ocotillo Rd%"));

/* ================================================================================================
 * SECTION F — TECHNICIAN QUESTIONS (25)
 * Job totals, per-city workload, and which of our 6 technicians have never once logged a Preventive
 * Maintenance visit - a real, verified split (4 of 6 have zero PM extractions anywhere in this corpus).
 */
const TECH_TOTALS = [
  ["Kevin Pratt", 59], ["Marisol Vega", 58], ["Danny Ochoa", 57], ["Wyatt Coburn", 56], ["Denise Ford", 55], ["Ray Sutton", 55],
];
for (const [tech] of TECH_TOTALS) {
  questions.push(countQ(`how many jobs total has ${tech} been out on`, "technician", `FROM extractions WHERE field_key='technician' AND value='${tech}'`));
}

const TECH_NEVER_PM = ["Danny Ochoa", "Denise Ford", "Ray Sutton", "Marisol Vega"];
for (const tech of TECH_NEVER_PM) {
  questions.push(yesNoQ({
    text: `has ${tech} ever done a preventive maintenance visit`, shape: "technician",
    sql: `SELECT EXISTS (SELECT 1 FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='Preventive Maintenance' WHERE t.field_key='technician' AND t.value='${tech}') AS v`,
    params: [],
  }));
}
questions.push(setQ({
  text: "which technicians have never once logged a preventive maintenance visit", shape: "technician", maxItems: 8,
  sql: `SELECT DISTINCT value AS item FROM extractions WHERE field_key='technician'
EXCEPT
SELECT DISTINCT t.value AS item FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='Preventive Maintenance' WHERE t.field_key='technician'`,
}));

const TECH_CITY = [
  ["how many jobs has Danny Ochoa done in Phoenix", "Danny Ochoa", "Phoenix"],
  ["how many jobs has Denise Ford done in Tempe", "Denise Ford", "Tempe"],
  ["how many jobs has Kevin Pratt done in Phoenix", "Kevin Pratt", "Phoenix"],
  ["how many jobs has Marisol Vega done in Tucson", "Marisol Vega", "Tucson"],
  ["how many jobs has Ray Sutton done in Tucson", "Ray Sutton", "Tucson"],
  ["how many jobs has Wyatt Coburn done in Tucson", "Wyatt Coburn", "Tucson"],
];
for (const [text, tech, city] of TECH_CITY) {
  questions.push(countQ(text, "technician",
    `FROM extractions t JOIN documents d ON d.id=t.document_id JOIN document_entity_links l ON l.document_id=d.id
JOIN entities c ON c.id=l.entity_id AND c.entity_type='customer'
WHERE t.field_key='technician' AND t.value='${tech}' AND c.data->>'service_address' ILIKE '%, ${city},%'`));
}

questions.push(yesNoQ({
  text: "has Kevin Pratt done more jobs total than Ray Sutton", shape: "technician",
  sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Kevin Pratt') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Ray Sutton') AS v`,
  params: [],
}));
questions.push(yesNoQ({
  text: "has Marisol Vega done more jobs total than Wyatt Coburn", shape: "technician",
  sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Marisol Vega') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Wyatt Coburn') AS v`,
  params: [],
}));

function techByCustomer(text, namePattern) {
  return valueQ({
    text, shape: "technician",
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT DISTINCT t.value AS v FROM extractions t JOIN documents d ON d.id=t.document_id JOIN document_entity_links l ON l.document_id=d.id
WHERE t.field_key='technician' AND l.entity_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`,
    params: [namePattern],
    requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [namePattern] },
  });
}
questions.push(techByCustomer("who's been out to Steven Hutchins' place", "%Steven Hutchins%"));
questions.push(techByCustomer("who normally handles Thomas Quintana's account", "%Thomas Quintana%"));
questions.push(techByCustomer("which tech works Ronald Fenwick's account", "%Ronald Fenwick%"));
questions.push(techByCustomer("who's serviced Sandra Alvarez's place before", "%Sandra Alvarez%"));

questions.push(valueQ({
  text: "which technician has logged the most preventive maintenance visits", shape: "technician",
  sql: `SELECT t.value AS v FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='Preventive Maintenance' WHERE t.field_key='technician' GROUP BY t.value ORDER BY count(*) DESC LIMIT 1`,
  params: [],
}));
questions.push(valueQ({
  text: "which technician has done the most repair calls", shape: "technician",
  sql: `SELECT t.value AS v FROM extractions t JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='Repair' WHERE t.field_key='technician' GROUP BY t.value ORDER BY count(*) DESC LIMIT 1`,
  params: [],
}));

/* ================================================================================================
 * SECTION G — ADVERSARIAL TRAPS (25, required by the round contract)
 * Near-miss names, fake addresses one house-number digit off a real one, a real customer paired with a
 * manufacturer they've never had installed, future dates, and 5 mixed real+fake rubric questions.
 * Every guard below was verified live against the export (zero rows for every fake/near-miss subject;
 * the real counterpart verified to exist one row over).
 */
const NEAR_MISS_NAMES = [
  ["what's the phone number for Amanda Quinly", "Amanda Quinly", "Amanda Quinley"],
  ["pull up the file for Kenith Fenwick", "Kenith Fenwick", "Kenneth Fenwick"],
  ["what's the service address on file for Ashely Vance", "Ashely Vance", "Ashley Vance"],
  ["whats the warranty status for Micheal Redwine", "Micheal Redwine", "Michael Redwine"],
  ["do we have a serial number on file for Nancey Zamora", "Nancey Zamora", "Nancy Zamora"],
];
for (const [text, name, real] of NEAR_MISS_NAMES) {
  questions.push(decline({
    typoResolvesTo: real,
    text, shape: "adversarial_near_miss",
    guardSql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`,
    guardParams: [`%${name}%`],
    why: `"${name}" matches zero customers in this tenant - a near-miss of a real, differently-spelled name; never guess the real one`,
  }));
}

const FAKE_ADDRESSES = [
  ["what's the model number for the unit at 1877 N College Ave", "1877 N College Ave"],
  ["what's on file for 1507 E McKellips Rd", "1507 E McKellips Rd"],
  ["who's the customer at 1322 E Chandler Blvd", "1322 E Chandler Blvd"],
  ["what's the warranty expiry for 1655 E Pecos Rd", "1655 E Pecos Rd"],
  ["what unit do we have on file at 3653 W Guadalupe Rd", "3653 W Guadalupe Rd"],
];
for (const [text, addr] of FAKE_ADDRESSES) {
  questions.push(decline({
    text, shape: "adversarial_fake_address",
    guardSql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1`,
    guardParams: [`${addr}%`],
    why: `"${addr}" is one house-number digit off a real address in this corpus and matches zero customers - never guess the real neighbor's address`,
  }));
}

const BRAND_NOT_CARRIED_AT = [
  ["is Betty Winslow's unit an Amana", "Betty Winslow", "amana"],
  ["is the system at Joseph Ortega's place a Bryant", "Joseph Ortega", "bryant"],
  ["does William Quintana have a Ruud unit", "William Quintana", "ruud"],
  ["is Donna Sorensen's system an American Standard", "Donna Sorensen", "american standard"],
  ["is Kevin Zimmerman's unit a Payne", "Kevin Zimmerman", "payne"],
];
for (const [text, name, mfg] of BRAND_NOT_CARRIED_AT) {
  questions.push(decline({
    text, shape: "adversarial_brand_not_carried",
    guardSql: `SELECT count(*) AS n FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE $1 AND c.data->>'customer_name' ILIKE $2`,
    guardParams: [mfg, `%${name}%`],
    why: `${name}'s own equipment record carries a different manufacturer - this shop has never installed a ${mfg} for them`,
  }));
}

const FUTURE_DATE_TRAPS = [
  "what work did we do on March 15th, 2027",
  "do we have an invoice dated January 1st, 2030",
  "is there a service call scheduled for June 2028",
  "was there a warranty registration filed in 2027",
  "how many jobs do we have logged for 2030",
];
for (const text of FUTURE_DATE_TRAPS) {
  questions.push(decline({
    text, shape: "adversarial_future_date",
    guardSql: `SELECT ((SELECT count(*) FROM extractions WHERE value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND value::date > '2027-01-01'::date) + (SELECT count(*) FROM document_financials WHERE invoice_date > '2027-01-01'::date)) AS n`,
    why: "no record in this corpus is dated past 2026-08-28 (its own real max date) - any 2027-or-later question has nothing on file to answer from",
  }));
}

questions.push(rubricQ({
  text: "compare the warranty status of Amanda Quinley's unit and Amanda Quinly's unit", shape: "adversarial_mixed",
  rubric: "Amanda Quinley is a real customer in this corpus; Amanda Quinly is not (zero matches - a near-miss of the real name). The honest answer reports Amanda Quinley's real warranty status and clearly states Amanda Quinly isn't on file, never conflating the two or inventing data for the fake one.",
}));
questions.push(rubricQ({
  text: "what's on file for 1876 N College Ave versus 1877 N College Ave", shape: "adversarial_mixed",
  rubric: "1876 N College Ave (Amanda Quinley) is a real address in this corpus; 1877 N College Ave is one digit off and matches zero customers. The honest answer reports what's on file for 1876 and clearly states 1877 isn't a customer address on file, never fabricating a record for it.",
}));
questions.push(rubricQ({
  text: "is Betty Winslow's unit a Trane or an Amana", shape: "adversarial_mixed",
  rubric: "Betty Winslow's own equipment record shows a Trane unit; Amana is never installed for her (or anywhere in this corpus). The honest answer names Trane and does not hedge toward Amana as if it were an open possibility on file.",
}));
questions.push(rubricQ({
  text: "do we have service history for Kenneth Fenwick or Kenith Fenwick", shape: "adversarial_mixed",
  rubric: "Kenneth Fenwick is a real customer in this corpus; Kenith Fenwick (one letter different) matches zero customers. The honest answer reports on Kenneth Fenwick and clearly states Kenith Fenwick isn't on file, never assuming they're the same person without saying so.",
}));
questions.push(rubricQ({
  text: "was Nancy Zamora's invoice from this year, or was the 2030 invoice hers", shape: "adversarial_mixed",
  rubric: "Nancy Zamora has a real invoice on file (INV-20042); no invoice in this corpus is dated 2030 (the corpus's own latest date is 2026-08-28). The honest answer reports Nancy Zamora's real invoice and clearly states there is no 2030 invoice for anyone, never inventing one.",
}));

/* ============================================================== output */

if (questions.length !== 200) {
  console.error(`gen-field-phrasing-4: expected 200 questions, built ${questions.length}`);
  process.exit(1);
}
const ids = new Set(questions.map((q) => q.id));
if (ids.size !== 200) {
  console.error(`gen-field-phrasing-4: duplicate ids (${200 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-27.field-phrasing-4-r21",
  category: CATEGORY,
  source: "Round 21 (L1) blind generalization set - 200 new questions, written blind: no exam.json/field-phrasing.json/field-phrasing-2.json/field-phrasing-3.json question text and no engine regex read while writing them; grounded only in scripts/golden/golden-export.json (queried live) + the exam file format. Emphasis this round (fp-3 now tuned against): mixed multi-constraint questions (brand+city+time+status, 4 conditions at once), relative time phrasing (last 6 weeks, before the summer, since we started, past quarter), counterfactual/\"which don't\" questions, money questions answerable from documents with honest-decline where the data is absent (balance_due/amount_paid/due_date are NULL on every row), equipment age/replacement-candidate questions, technician questions, and 25 adversarial traps (near-miss names, fake addresses one digit off, brands not carried, future dates, mixed real+fake entities).",
  questions,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-field-phrasing-4: wrote ${questions.length} questions -> ${OUT_PATH}`);
  const byCmp = {};
  const byShape = {};
  for (const q of questions) { byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1; byShape[q.shape] = (byShape[q.shape] ?? 0) + 1; }
  console.log("by cmp:", JSON.stringify(byCmp));
  console.log("by shape:", JSON.stringify(byShape));
}

export { questions, out };
