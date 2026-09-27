#!/usr/bin/env node
/**
 * FIELD-PHRASING-3 exam category (Round 19, I3) — a fresh BLIND generalization set: 200 new questions
 * written WITHOUT looking at test-docs/scorecard/exam.json's, field-phrasing.json's or
 * field-phrasing-2.json's question TEXTS, and without opening any engine regex file (api/_lib/fastPath*.js
 * etc. were never opened while writing this file). Only three things were read to build this: the DATA
 * (scripts/golden/golden-export.json, queried directly through a throwaway PGlite harness for real
 * subjects — names, addresses, serials, phones, manufacturers, technicians, financials, document types),
 * the exam file FORMAT/oracle schema (api/_lib/scorecard/exam.js), and scripts/gen-field-phrasing-2.mjs —
 * read for its STRUCTURE (the oracle-builder helper pattern: a guarded single-match SQL query, an
 * honest-decline guard, an ambiguity-set "ask which one", a portfolio-wide count) so this file's oracles
 * follow the same conventions and the same PGlite-verification discipline. Every helper below is rebuilt
 * fresh rather than imported, and every concrete address/name/serial/phone used is a DIFFERENT subject
 * than field-phrasing-2 used (checked by hand against that file's own literal question texts) so this is
 * genuinely new coverage, not the same facts re-asked.
 *
 * PERSONAS this round's contract asked for, each its own section below:
 *   A. owner (business health — installs/revenue this year vs last, technician workload, spend by vendor,
 *      document-type coverage; "most callbacks" is a deliberate decline — see NEVER_CALLBACK)
 *   B. office manager (paperwork completeness — permit/PO on file or not, ambiguous-account traps)
 *   C. dispatch (reverse serial/phone lookups, "who was last there and what did they do", live-status
 *      declines — nothing about *right now* is ever tracked)
 *   D. warranty clerk (registration-window compliance, claims — never a tracked concept, maintenance
 *      agreement coverage)
 *   E. field tech dictating by voice (digits spelled out as words, run-on sentences with filler words,
 *      misheard manufacturer names — "train"/"trane", "carry her"/"carrier")
 *   F. team-scoped internal-document questions (20, required by the round contract) — almost all decline,
 *      since this corpus never marks any document `audience: 'internal'` nor has a "memo" doc type at all
 *      (verified directly against the export: documents.audience is NULL on all 604 rows) — a few contrast
 *      cases show that a SPECIFIC customer's own dispatch-note is still fair game, unlike a team-wide memo
 *   G. must-decline / must-ask-which traps (20, required) — out-of-domain, ambiguous name, no antecedent,
 *      never-on-file field
 *   H. mixed coverage (compound/negation/multi-hop/ranking/comparison) rounding out to 200
 *
 * GROUND TRUTH: every oracle here is guarded (a `requires` single-match/non-empty check, or an honest-zero
 * guard for a decline) so a subject this corpus doesn't actually have SKIPS gracefully rather than being
 * wrong — verified for real via scripts/verify-field-phrasing-3.mjs's own PGlite run against
 * scripts/golden/golden-export.json (same harness scripts/offline-exam.mjs/oracle.js use), never hand-typed
 * expected values.
 *
 * Usage: node scripts/gen-field-phrasing-3.mjs
 *   writes test-docs/scorecard/generalization/field-phrasing-3.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "test-docs", "scorecard", "generalization", "field-phrasing-3.json");

const CATEGORY = "field-phrasing-3";
const TODAY = "@today"; // resolved by oracle.js at run time

let __n = 0;
const nextId = () => `i${String(++__n).padStart(3, "0")}`;

/* ============================================================== oracle-builder helpers
 * (same conventions as gen-field-phrasing-2.mjs's own helpers, rebuilt here so this category's
 * questions/oracles are fully self-contained and never drift if that file changes). */

function addressValue({ text, shape, addressPrefix, fieldCol, citationRequired = true }) {
  return {
    id: nextId(), text, category: CATEGORY, shape, cmp: "value",
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

function serialToName({ text, serial }) {
  return {
    id: nextId(), text, category: CATEGORY, shape: "lookup_serial", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT customer_id FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'serial_number' = $1)
SELECT c.data->>'customer_name' AS v FROM entities c WHERE c.id IN (SELECT customer_id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [serial],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'serial_number' = $1`, params: [serial] },
    },
    citationRequired: true,
  };
}

function phoneToName({ text, phoneDigits }) {
  return {
    id: nextId(), text, category: CATEGORY, shape: "lookup_phone", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND regexp_replace(coalesce(data->>'phone',''), '\\D', '', 'g') = $1)
SELECT data->>'customer_name' AS v FROM entities WHERE id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [phoneDigits],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND regexp_replace(coalesce(data->>'phone',''), '\\D', '', 'g') = $1`, params: [phoneDigits] },
    },
    citationRequired: true,
  };
}

function decline({ text, shape, guardSql, guardParams = [], why }) {
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "honest-zero", oracle: { sql: guardSql, params: guardParams }, note: why };
}

function neverOnFieldDecline({ text, shape, fieldKeys, why }) {
  const list = fieldKeys.map((k) => `'${k}'`).join(", ");
  return decline({ text, shape, guardSql: `SELECT (SELECT count(*) FROM extractions WHERE field_key IN (${list})) AS n`, why });
}

function ambiguitySet({ text, shape, namePattern, why }) {
  return {
    id: nextId(), text, category: CATEGORY, shape, cmp: "set", note: why,
    oracle: { sql: `SELECT data->>'customer_name' AS item FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [namePattern] },
  };
}

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

function yesNoQ({ text, shape, sql, params = [], citationRequired = true }) {
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "yesno", oracle: { sql, params }, citationRequired };
}

function rubricQ({ text, shape, rubric }) {
  return { id: nextId(), text, category: CATEGORY, shape, cmp: "rubric", rubric, oracle: { sql: "SELECT NULL::text AS ref WHERE false" } };
}

function warrantyExpiresAtAddress(text, addressPrefix) {
  return valueQ({
    text, shape: "warranty",
    sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data#>>'{warranty,expires}' AS v FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1 AND e.data#>>'{warranty,expires}' IS NOT NULL`,
    params: [addressPrefix],
  });
}

function warrantyYesNoByName(text, namePattern) {
  return yesNoQ({
    text, shape: "warranty",
    sql: `SELECT (e.data#>>'{warranty,expires}')::date > $1::date AS v FROM entities e JOIN entities c ON c.id=e.customer_id WHERE c.data->>'customer_name' ILIKE $2 AND e.data#>>'{warranty,expires}' IS NOT NULL AND (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $2) = 1`,
    params: [TODAY, namePattern],
  });
}

/** "who was last at <address> and what did they do" — most recent service_date's technician AND
 *  work_performed, as a `set` of both facts together (neither silently dropped). Guarded so an address
 *  with a TIE on its own most-recent date (2+ documents/technicians on the same day) skips rather than
 *  ever forcing a single confident pick among them. */
function lastVisitWorkAtAddress(text, addressPrefix) {
  return {
    id: nextId(), text, category: CATEGORY, shape: "dispatch_history", cmp: "set",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1),
docs AS (SELECT DISTINCT x.document_id, x.value AS sd FROM extractions x
         WHERE x.field_key='service_date' AND x.value IS NOT NULL
           AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m))),
maxdoc AS (SELECT document_id FROM docs WHERE sd = (SELECT max(sd) FROM docs))
SELECT t.value AS item FROM extractions t WHERE t.document_id IN (SELECT document_id FROM maxdoc) AND t.field_key='technician'
UNION ALL
SELECT w.value AS item FROM extractions w WHERE w.document_id IN (SELECT document_id FROM maxdoc) AND w.field_key='work_performed'`,
      params: [addressPrefix],
      requires: {
        sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1),
docs AS (SELECT DISTINCT x.document_id, x.value AS sd FROM extractions x
         WHERE x.field_key='service_date' AND x.value IS NOT NULL
           AND x.document_id IN (SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (SELECT id FROM m)))
SELECT (CASE WHEN (SELECT count(*) FROM docs WHERE sd = (SELECT max(sd) FROM docs)) = 1 THEN 1 ELSE 0 END) AS n`,
        params: [addressPrefix],
      },
    },
  };
}

function lastTechAtAddress(text, addressPrefix) {
  return {
    id: nextId(), text, category: CATEGORY, shape: "dispatch_history", cmp: "value",
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

function twoFieldAtAddress(text, addressPrefix, field1, field2) {
  return {
    id: nextId(), text, category: CATEGORY, shape: "compound", cmp: "set",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE $1)
SELECT e.data->>'${field1}' AS item FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1
UNION ALL
SELECT e.data->>'${field2}' AS item FROM entities e WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.customer_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m)=1`,
      params: [addressPrefix],
    },
  };
}

function noAntecedentDecline(text, shape = "conversational_followup") {
  return decline({ text, shape, guardSql: "SELECT 0 AS n", why: "no subject named at all in a 120-customer tenant - a standalone follow-up/live-status ask with nothing on file to resolve against" });
}

/** Real per-document-type or vendor/tech counts, always live-computed (never hand-typed), for the owner
 *  business-health persona. */
function countQ(text, shape, whereSql, params = []) {
  return numberQ({ text, shape, tolerance: 0, citationRequired: false, sql: `SELECT count(*) AS n ${whereSql}`, params });
}

/** Does a document of `docType` exist linked to the single customer matching `namePattern`? Guarded to a
 *  single customer match (an ambiguous surname skips rather than guessing which account). */
function docExistsForName(text, namePattern, docType) {
  return {
    id: nextId(), text, category: CATEGORY, shape: "paperwork", cmp: "yesno",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT EXISTS (
  SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id
  WHERE d.document_type='${docType}' AND l.entity_id IN (SELECT id FROM m)
) AS v FROM (SELECT 1) z WHERE (SELECT count(*) FROM m) = 1`,
      params: [namePattern],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [namePattern] },
    },
    citationRequired: false,
  };
}

const questions = [];

/* ================================================================================================
 * SECTION A — OWNER: business health, rankings, spend (30)
 * ================================================================================================ */

questions.push(countQ("how many units have we installed so far this year", "business_health",
  `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND extract(year from (data->>'installation_date')::date) = extract(year from $1::date)`, [TODAY]));
questions.push(countQ("how many units did we install last year", "business_health",
  `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND extract(year from (data->>'installation_date')::date) = extract(year from $1::date) - 1`, [TODAY]));
questions.push(yesNoQ({
  text: "did we install more units last year than we've done so far this year", shape: "business_health",
  sql: `SELECT
    (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND extract(year from (data->>'installation_date')::date) = extract(year from $1::date) - 1)
    >
    (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND extract(year from (data->>'installation_date')::date) = extract(year from $1::date))
  AS v`,
  params: [TODAY],
}));
questions.push(yesNoQ({
  text: "was our invoiced revenue higher in 2021 than in 2025", shape: "business_health",
  sql: `SELECT
    (SELECT coalesce(sum(total),0) FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND extract(year from invoice_date)=2021)
    >
    (SELECT coalesce(sum(total),0) FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND extract(year from invoice_date)=2025)
  AS v`,
  params: [],
}));
questions.push(valueQ({
  text: "which tech is racking up the most repair calls", shape: "business_health",
  sql: `SELECT t.value AS v FROM extractions t
JOIN extractions s ON s.document_id=t.document_id AND s.field_key='service_type' AND s.value='Repair'
WHERE t.field_key='technician' GROUP BY t.value ORDER BY count(*) DESC LIMIT 1`,
  params: [],
}));
questions.push(neverOnFieldDecline({
  text: "which tech has the most callbacks", shape: "business_health",
  fieldKeys: ["callback", "callback_reason", "return_visit_reason"],
  why: "'callback' is never a recorded concept in this corpus - only service_type Repair/Preventive Maintenance is on file, which is not the same claim",
}));
questions.push(countQ("how many customers are on the books total", "business_health", `FROM entities WHERE entity_type='customer' AND merged_into IS NULL`));
questions.push(numberQ({
  text: "how many maintenance agreements do we currently have that are still active", shape: "business_health", tolerance: 0, citationRequired: false,
  sql: `WITH terms AS (
  SELECT d.id, to_date(split_part(x.value, ' - ', 1), 'MM/DD/YYYY') AS start_d, to_date(split_part(x.value, ' - ', 2), 'MM/DD/YYYY') AS end_d
  FROM documents d JOIN extractions x ON x.document_id=d.id AND x.field_key='agreement_term'
  WHERE d.document_type='maintenance-agreement'
)
SELECT count(*) AS n FROM terms WHERE start_d <= $1::date AND end_d >= $1::date`,
  params: [TODAY],
}));
questions.push(countQ("how many warranty registrations are we still missing", "business_health", `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data#>>'{warranty,registrationState}' = 'unknown'`));
questions.push(countQ("how many trane systems have we sold company-wide", "business_health", `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'trane'`));
questions.push(countQ("how many properties do we have more than one unit installed at", "business_health",
  `FROM (SELECT customer_id FROM entities WHERE entity_type='equipment' AND merged_into IS NULL GROUP BY customer_id HAVING count(*) >= 2) t`));
questions.push(decline({
  text: "how much are we still owed across every job that hasn't paid", shape: "business_health",
  guardSql: `SELECT (SELECT count(*) FROM document_financials WHERE balance_due IS NOT NULL) AS n`,
  why: "balance_due is NULL on every document_financials row in this tenant",
}));
questions.push(yesNoQ({
  text: "are we bringing in more revenue this year so far than we did all of last year", shape: "business_health",
  sql: `SELECT
    (SELECT coalesce(sum(total),0) FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND extract(year from invoice_date)=extract(year from $1::date))
    >
    (SELECT coalesce(sum(total),0) FROM document_financials WHERE doc_kind='invoice' AND invoice_date IS NOT NULL AND extract(year from invoice_date)=extract(year from $1::date)-1)
  AS v`,
  params: [TODAY],
}));
questions.push(countQ("how many jobs has Denise Ford closed out total", "business_health", `FROM extractions WHERE field_key='technician' AND value='Denise Ford'`));
questions.push(countQ("how many jobs has Wyatt Coburn closed out total", "business_health", `FROM extractions WHERE field_key='technician' AND value='Wyatt Coburn'`));
questions.push(yesNoQ({
  text: "is Denise Ford busier than Kevin Pratt", shape: "business_health",
  sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Denise Ford') > (SELECT count(*) FROM extractions WHERE field_key='technician' AND value='Kevin Pratt') AS v`,
  params: [],
}));
questions.push(countQ("how many preventive maintenance visits have we logged total", "business_health", `FROM extractions WHERE field_key='service_type' AND value='Preventive Maintenance'`));
questions.push(countQ("how many repair visits have we logged total", "business_health", `FROM extractions WHERE field_key='service_type' AND value='Repair'`));
questions.push(yesNoQ({
  text: "do we do more repair work or more preventive maintenance, by volume", shape: "business_health",
  sql: `SELECT (SELECT count(*) FROM extractions WHERE field_key='service_type' AND value='Repair') > (SELECT count(*) FROM extractions WHERE field_key='service_type' AND value='Preventive Maintenance') AS v`,
  params: [],
}));
questions.push(countQ("how many purchase orders have we cut to Baker Distributing", "business_health",
  `FROM documents d JOIN extractions v ON v.document_id=d.id AND v.field_key='vendor_name' AND v.value='Baker Distributing' WHERE d.document_type='purchase-order'`));
questions.push(countQ("how many purchase orders have we cut to Watsco Supply", "business_health",
  `FROM documents d JOIN extractions v ON v.document_id=d.id AND v.field_key='vendor_name' AND v.value='Watsco Supply' WHERE d.document_type='purchase-order'`));
questions.push(yesNoQ({
  text: "have we bought more from Baker Distributing or Watsco Supply, by PO count", shape: "business_health",
  sql: `SELECT
    (SELECT count(*) FROM documents d JOIN extractions v ON v.document_id=d.id AND v.field_key='vendor_name' AND v.value='Baker Distributing' WHERE d.document_type='purchase-order')
    >
    (SELECT count(*) FROM documents d JOIN extractions v ON v.document_id=d.id AND v.field_key='vendor_name' AND v.value='Watsco Supply' WHERE d.document_type='purchase-order')
  AS v`,
  params: [],
}));
questions.push(countQ("how many permits have we pulled total", "business_health", `FROM documents WHERE document_type='permit'`));
questions.push(countQ("how many inspection reports do we have on file", "business_health", `FROM documents WHERE document_type='inspection-report'`));
questions.push(countQ("how many startup sheets have we filed", "business_health", `FROM documents WHERE document_type='startup-sheet'`));
questions.push(countQ("how many pieces of correspondence do we have on file", "business_health", `FROM documents WHERE document_type='correspondence'`));
questions.push(countQ("how many work orders are on the books", "business_health", `FROM documents WHERE document_type='work-order'`));
questions.push(numberQ({
  text: "how many customers have both a maintenance agreement on file and a repair visit this year", shape: "business_health", tolerance: 0, citationRequired: false,
  sql: `SELECT count(DISTINCT c.id) AS n FROM entities c
WHERE c.entity_type='customer' AND c.merged_into IS NULL
  AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id=l.document_id WHERE d.document_type='maintenance-agreement' AND l.entity_id=c.id)
  AND EXISTS (SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id WHERE x.field_key='service_type' AND x.value='Repair' AND l.entity_id=c.id
              AND EXISTS (SELECT 1 FROM extractions s WHERE s.document_id=l.document_id AND s.field_key='service_date' AND extract(year from s.value::date) = extract(year from $1::date)))`,
  params: [TODAY],
}));
questions.push(countQ("how many customers have zero documents of any kind on file", "business_health",
  `FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM document_entity_links l WHERE l.entity_id=c.id)`));
questions.push(numberQ({ text: "how many distinct document types do we actually track", shape: "business_health", tolerance: 0, citationRequired: false, sql: `SELECT count(DISTINCT document_type) AS n FROM documents`, params: [] }));
questions.push(countQ("how many goodman units are on our books", "business_health", `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'goodman'`));
questions.push(countQ("how many lennox units are on our books", "business_health", `FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'lennox'`));
questions.push(yesNoQ({
  text: "do we have more goodman units than lennox units on the books", shape: "business_health",
  sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'goodman') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'lennox') AS v`,
  params: [],
}));
/* ================================================================================================
 * SECTION B — OFFICE MANAGER: paperwork completeness, account gaps (30)
 * ================================================================================================ */

const PERMIT_CHECK_NAMES = [
  "Cactus Rose Restaurant", "Canyon View Dental", "Copper Sky Dental", "Grace Community Church", "Holy Trinity Church",
  "Amanda Quinley", "Amanda Redwine", "Amy Jarvis", "Ashley Vance", "Anthony Alvarez",
  "Linda Fitzgerald", "Kenneth Fenwick", "Michael Redwine", "Nancy Zamora",
];
for (const name of PERMIT_CHECK_NAMES) {
  questions.push(docExistsForName(`is there a permit on file for the ${name} job`, `%${name}%`, "permit"));
}

const PO_CHECK_NAMES = [
  "Amy Isaacson", "Karen Abernathy", "Daniel Keller", "Brian Chavez", "Rebecca Montoya", "Patricia Esparza",
  "Linda Fitzgerald", "Ashley Vance", "Nancy Zamora", "Kenneth Fenwick",
];
for (const name of PO_CHECK_NAMES) {
  questions.push(docExistsForName(`do we have a purchase order on file for the ${name} account`, `%${name}%`, "purchase-order"));
}

questions.push(rubricQ({
  text: "what paperwork is missing for the Amanda Quinley job", shape: "paperwork",
  rubric: "Amanda Quinley (1876 N College Ave, Glendale) has no permit document on file in this corpus, though equipment/service records exist - the honest answer names the permit gap specifically, never a vague 'nothing on file' or a fabricated checklist item that isn't actually tracked (like an inspection sign-off) unless it too is confirmed missing.",
}));
questions.push(rubricQ({
  text: "what paperwork is missing for the Ashley Vance job", shape: "paperwork",
  rubric: "Ashley Vance (1506 E McKellips Rd, Tempe) has no permit document on file in this corpus - the honest answer names the permit gap specifically, not a vague 'nothing on file'.",
}));
questions.push(rubricQ({
  text: "what paperwork is missing for the Kenneth Fenwick job", shape: "paperwork",
  rubric: "Kenneth Fenwick (1025 N College Ave, Chandler) has no permit document on file in this corpus - the honest answer names the permit gap specifically, not a vague 'nothing on file'.",
}));
questions.push(ambiguitySet({
  text: "what do we have on file for the hutchins account", shape: "ambiguous_name", namePattern: "%Hutchins%",
  why: "the bare surname Hutchins matches 4 distinct customers in this tenant - must ask which one, never silently pick",
}));
questions.push(ambiguitySet({
  text: "pull up whatever we've got for the fenwick account", shape: "ambiguous_name", namePattern: "%Fenwick%",
  why: "the bare surname Fenwick matches 3 distinct customers in this tenant - must ask which one, never silently pick",
}));

/* ================================================================================================
 * SECTION C — DISPATCH: reverse lookups, last-on-site, live-status declines (30)
 * ================================================================================================ */

const LAST_VISIT_WORK_ADDRS = [
  ["who was last out to 100 E Main St and what did they do there", "100 E Main St%"],
  ["whos the last one that went to 1210 E Broadway Rd, what was it for", "1210 E Broadway Rd%"],
  ["who was last at 1071 N Recker Rd, and what did they do", "1071 N Recker Rd%"],
  ["last tech out to 1124 N College Ave - what was the visit for", "1124 N College Ave%"],
  ["who was out at 1018 E Pecos Rd last, and what was done", "1018 E Pecos Rd%"],
  ["whos the last one out to 2986 S Alma School Rd and what did they do", "2986 S Alma School Rd%"],
  ["last tech at 3319 N Val Vista Dr - what did they work on", "3319 N Val Vista Dr%"],
  ["who was out to 3504 E Main St last and what was the job", "3504 E Main St%"],
  ["last visit to 3578 N College Ave - who went and what for", "3578 N College Ave%"],
  ["who was last out at 3652 W Guadalupe Rd, what did they do", "3652 W Guadalupe Rd%"],
];
for (const [text, addr] of LAST_VISIT_WORK_ADDRS) questions.push(lastVisitWorkAtAddress(text, addr));

const REVERSE_PHONE = [
  ["whos this calling from 480 555 0158", "4805550158"],
  ["caller id shows 480-555-0110, who's that", "4805550110"],
  ["got a call from (480) 555-0138, whose account", "4805550138"],
  ["whos number is 480.555.0143", "4805550143"],
  ["4805550151 just called in, who is that", "4805550151"],
];
for (const [text, digits] of REVERSE_PHONE) questions.push(phoneToName({ text, phoneDigits: digits }));

const REVERSE_SERIAL = [
  ["got serial F100002 on the truck radio, whose job is this", "F100002"],
  ["serial 2C100027 - who's the customer", "2C100027"],
  ["dispatch says serial M100033, whose account is that", "M100033"],
  ["whose unit is serial D100032", "D100032"],
  ["trying to match serial 2R100030 to an account", "2R100030"],
];
for (const [text, serial] of REVERSE_SERIAL) questions.push(serialToName({ text, serial }));

const LIVE_STATUS_DECLINES = [
  "who's out on a call right now",
  "is anybody free to roll on an emergency this second",
  "what's the truck status for this afternoon",
  "who's next up in the queue",
  "is a tech already on the way to that address",
];
for (const text of LIVE_STATUS_DECLINES) questions.push(noAntecedentDecline(text, "dispatch_live_status"));

const LAST_TECH_ONLY = [
  ["who's the last one we sent to 1284 S Alma School Rd", "1284 S Alma School Rd%"],
  ["who went out to 1321 E Chandler Blvd last", "1321 E Chandler Blvd%"],
  ["whos the last tech that hit 1395 E Ray Rd", "1395 E Ray Rd%"],
  ["who was the last one dispatched to 137 W Southern Ave", "137 W Southern Ave%"],
  ["who's the last tech we sent out to 1543 S Higley Rd", "1543 S Higley Rd%"],
];
for (const [text, addr] of LAST_TECH_ONLY) questions.push(lastTechAtAddress(text, addr));

/* ================================================================================================
 * SECTION D — WARRANTY CLERK: registration windows, claims, coverage (25)
 * ================================================================================================ */

questions.push(numberQ({
  text: "how many warranty registrations went in within 30 days of the install date", shape: "warranty_clerk", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities e JOIN document_entity_links l ON l.entity_id=e.id
JOIN extractions x ON x.document_id=l.document_id AND x.field_key='warranty_registered_date'
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
  AND (x.value::date - (e.data->>'installation_date')::date) <= 30`,
  params: [],
}));
questions.push(numberQ({
  text: "how many warranty registrations took longer than 30 days after install", shape: "warranty_clerk", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities e JOIN document_entity_links l ON l.entity_id=e.id
JOIN extractions x ON x.document_id=l.document_id AND x.field_key='warranty_registered_date'
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
  AND (x.value::date - (e.data->>'installation_date')::date) > 30`,
  params: [],
}));
questions.push(yesNoQ({
  text: "do most of our warranty registrations happen within 30 days of the install", shape: "warranty_clerk",
  sql: `WITH w AS (
  SELECT (x.value::date - (e.data->>'installation_date')::date) AS days
  FROM entities e JOIN document_entity_links l ON l.entity_id=e.id
  JOIN extractions x ON x.document_id=l.document_id AND x.field_key='warranty_registered_date'
  WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'installation_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
)
SELECT (SELECT count(*) FROM w WHERE days <= 30) > (SELECT count(*) FROM w WHERE days > 30) AS v`,
  params: [],
}));
questions.push(neverOnFieldDecline({
  text: "how many open warranty claims do we have right now", shape: "warranty_clerk",
  fieldKeys: ["claim_number", "claim_status", "warranty_claim"],
  why: "a warranty 'claim' as a distinct tracked concept never appears anywhere in this corpus - only registration and expiry are on file",
}));
questions.push(neverOnFieldDecline({
  text: "what's the claim number on file for the last warranty claim we filed", shape: "warranty_clerk",
  fieldKeys: ["claim_number"],
  why: "no claim_number field is ever extracted in this corpus",
}));
questions.push(neverOnFieldDecline({
  text: "have we sent a renewal reminder on any of the maintenance agreements", shape: "warranty_clerk",
  fieldKeys: ["renewal_notice_sent", "renewal_reminder"],
  why: "no renewal-reminder concept is ever tracked in this corpus",
}));

const WARRANTY_EXPIRES_ADDRS = [
  ["when's the warranty up at 1210 E Broadway Rd", "1210 E Broadway Rd%"],
  ["warranty expiration on file for 1321 E Chandler Blvd", "1321 E Chandler Blvd%"],
  ["when does coverage run out at 1506 E McKellips Rd", "1506 E McKellips Rd%"],
  ["warranty end date for 1580 W Camelback Rd", "1580 W Camelback Rd%"],
  ["whens the warranty expire at 1617 N Val Vista Dr", "1617 N Val Vista Dr%"],
  ["coverage expiration on file for 1654 E Pecos Rd", "1654 E Pecos Rd%"],
];
for (const [text, addr] of WARRANTY_EXPIRES_ADDRS) questions.push(warrantyExpiresAtAddress(text, addr));

const WARRANTY_YESNO_NAMES = [
  ["is Kevin Abernathy's system still under warranty", "%Kevin Abernathy%"],
  ["is Nancy Alvarez still covered", "%Nancy Alvarez%"],
  ["is Anthony Bennett's unit still under warranty", "%Anthony Bennett%"],
  ["is Ronald Bracken still covered under warranty", "%Ronald Bracken%"],
  ["is Susan Calloway's system still under warranty", "%Susan Calloway%"],
  ["is Brian Chavez still covered", "%Brian Chavez%"],
];
for (const [text, pat] of WARRANTY_YESNO_NAMES) questions.push(warrantyYesNoByName(text, pat));

const WARRANTY_AMBIGUOUS = [
  ["is dominguez still under warranty", "%Dominguez%", "3 distinct customers"],
  ["warranty status for esparza", "%Esparza%", "2 distinct customers"],
  ["is fenwick still covered", "%Fenwick%", "3 distinct customers"],
];
for (const [text, pat, why] of WARRANTY_AMBIGUOUS) {
  questions.push(ambiguitySet({ text, shape: "warranty", namePattern: pat, why: `the bare surname matches ${why} in this tenant - must ask which one, never silently pick` }));
}

questions.push(numberQ({
  text: "how many maintenance agreements do we have on the books, all in", shape: "warranty_clerk", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM documents WHERE document_type='maintenance-agreement'`, params: [],
}));
questions.push(valueQ({
  text: "what's the earliest warranty registration date we have on file", shape: "warranty_clerk",
  sql: `SELECT value AS v FROM extractions WHERE field_key='warranty_registered_date' AND value IS NOT NULL ORDER BY value ASC LIMIT 1`,
  params: [],
}));
questions.push(valueQ({
  text: "what's the most recent warranty registration date we've logged", shape: "warranty_clerk",
  sql: `SELECT value AS v FROM extractions WHERE field_key='warranty_registered_date' AND value IS NOT NULL ORDER BY value DESC LIMIT 1`,
  params: [],
}));

/* ================================================================================================
 * SECTION E — VOICE-DICTATION TECH: numbers as words, misheard brands, run-ons (25)
 * ================================================================================================ */

// numbers as words (address house numbers spelled out; the oracle SQL always uses the digit form —
// only the QUESTION text spells them as a tech dictating aloud would).
questions.push(addressValue({ text: "uh whats the model at one zero zero east main street", shape: "voice_dictation", addressPrefix: "100 E Main St%", fieldCol: "model" }));
questions.push(addressValue({ text: "serial number for one seven two eight west ocotillo road", shape: "voice_dictation", addressPrefix: "1728 W Ocotillo Rd%", fieldCol: "serial_number" }));
questions.push(addressValue({ text: "whos the manufacturer at one two five zero six east pecos, uh, I mean one six five four east pecos road", shape: "voice_dictation", addressPrefix: "1654 E Pecos Rd%", fieldCol: "manufacturer" }));
questions.push(addressValue({ text: "install date on the unit at one seven four north college avenue", shape: "voice_dictation", addressPrefix: "174 N College Ave%", fieldCol: "installation_date" }));
questions.push(addressValue({ text: "model number, uh, at one three two one east chandler boulevard", shape: "voice_dictation", addressPrefix: "1321 E Chandler Blvd%", fieldCol: "model" }));
questions.push(addressValue({ text: "serial for one five four three south higley road", shape: "voice_dictation", addressPrefix: "1543 S Higley Rd%", fieldCol: "serial_number" }));

// misheard "train" for Trane
const TRAIN_ADDRS = [
  ["is that a train unit out at three zero six zero north dobson road", "3060 N Dobson Rd%"],
  ["whats installed at three three five six east pecos rd, is it a train", "3356 E Pecos Rd%"],
  ["manufacturer at three six five two west guadalupe rd - train or something else", "3652 W Guadalupe Rd%"],
  ["is the unit at 1580 w camelback rd a train system", "1580 W Camelback Rd%"],
  ["whats on file for 1284 s alma school rd, train unit maybe", "1284 S Alma School Rd%"],
];
for (const [text, addr] of TRAIN_ADDRS) questions.push(addressValue({ text, shape: "voice_dictation", addressPrefix: addr, fieldCol: "manufacturer" }));

// misheard "carry her" for Carrier
const CARRYHER_ADDRS = [
  ["so is it a carry her unit out at 2801 w guadalupe rd", "2801 W Guadalupe Rd%"],
  ["whats the manufacturer at 1025 n college ave, carry her maybe", "1025 N College Ave%"],
  ["manufacturer on file for 1321 e chandler blvd - carry her system?", "1321 E Chandler Blvd%"],
  ["whos the mfr at 3097 e ray rd, carry her or something", "3097 E Ray Rd%"],
  ["is 1617 n val vista dr a carry her unit", "1617 N Val Vista Dr%"],
];
for (const [text, addr] of CARRYHER_ADDRS) questions.push(addressValue({ text, shape: "voice_dictation", addressPrefix: addr, fieldCol: "manufacturer" }));

// run-on sentences with filler words (compound two-field asks, phrased the way a tech dictates on the drive)
questions.push(twoFieldAtAddress("uh yeah so i need the model and, uh, the serial for one two one zero east broadway rd", "1210 E Broadway Rd%", "model", "serial_number"));
questions.push(twoFieldAtAddress("ok so quick question the manufacturer and, uh, tonnage on the unit at one three two one east chandler blvd", "1321 E Chandler Blvd%", "manufacturer", "tonnage"));
questions.push(twoFieldAtAddress("hey uh can you get me the model and serial both for one five zero six east mckellips rd", "1506 E McKellips Rd%", "model", "serial_number"));
questions.push(twoFieldAtAddress("so im out here at, uh, one three nine five east ray rd, need the manufacturer and the model, uh, both", "1395 E Ray Rd%", "manufacturer", "model"));
questions.push(twoFieldAtAddress("uh give me a sec, ok so manufacturer and serial number for one six one seven north val vista drive", "1617 N Val Vista Dr%", "manufacturer", "serial_number"));

// voice-dictation declines (garbled phrasing over a never-on-file field)
questions.push(neverOnFieldDecline({ text: "uh whats the, um, btu rating on the unit out at one zero zero east main st", shape: "voice_dictation", fieldKeys: ["btu_rating", "btu"], why: "BTU rating is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ text: "so uh duct size, whats that on the one at one two one zero east broadway rd", shape: "voice_dictation", fieldKeys: ["duct_size"], why: "duct size is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ text: "hey uh capacitor size on, uh, one five four three south higley rd", shape: "voice_dictation", fieldKeys: ["capacitor_size"], why: "capacitor size is never an extracted field in this corpus" }));
questions.push(neverOnFieldDecline({ text: "uh whats the seer rating on the, uh, unit at one seven two eight west ocotillo rd", shape: "voice_dictation", fieldKeys: ["seer_rating"], why: "SEER rating is never an extracted field in this corpus" }));

/* ================================================================================================
 * SECTION F — TEAM-SCOPED INTERNAL-DOCUMENT questions (20, required by the round contract)
 * ================================================================================================ */

// This corpus never marks a document `audience: 'internal'` (verified directly against the golden
// export: documents.audience is NULL on all 604 rows, and the pre-migration fallback field_key
// '_audience' never appears in extractions either) and there is no "memo" document type at all — the
// closest concept, a dispatch-note, is always tied to ONE customer's own job, never a team-wide
// broadcast. Every question below about a team-wide internal artifact must therefore honestly decline;
// the guard checks BOTH representations audienceFilterSql (api/_lib/audience/sql.js, adopted by I1/I2
// this round) understands, so this stays correct even after M3-config/57 is pasted and a future corpus
// legitimately has internal documents.
const NO_TEAM_SCOPED_GUARD = `SELECT (
  (SELECT count(*) FROM documents WHERE audience = 'internal')
  + (SELECT count(*) FROM extractions WHERE field_key = '_audience' AND value = 'internal')
) AS n`;

const TEAM_SCOPED_DECLINES = [
  "any memos for Kevin Pratt this week",
  "what did dispatch send out to the techs yesterday",
  "any internal notes from the shop manager this week",
  "what did the office send around to everybody last week",
  "any memos for Marisol Vega",
  "is there a team-wide notice about anything this month",
  "what's in the internal notes for Danny Ochoa",
  "any staff-only paperwork on file for this week",
  "what did dispatch broadcast to the crew this morning",
  "any memos for Wyatt Coburn this week",
  "is there an internal-only writeup on the Rios job",
  "what did management send the techs about scheduling this week",
  "any internal-only documents in the system at all",
  "what's the internal note on Denise Ford's last job",
  "any team memo about the new pricing",
  "what did dispatch circulate to everyone yesterday",
];
for (const text of TEAM_SCOPED_DECLINES) questions.push(decline({ text, shape: "team_scoped", guardSql: NO_TEAM_SCOPED_GUARD, why: "documents.audience is NULL on every row in this corpus and no '_audience'='internal' extraction ever appears - there is no team-wide internal artifact on file to answer from" }));

// Contrast cases: a SPECIFIC customer's own dispatch-note IS fair game (customer-scoped, not team-wide).
const DISPATCH_NOTE_FOR_NAME = [
  ["what did the dispatch note say about the Thomas Mercer call", "%Thomas Mercer%"],
  ["whats on the dispatch note for the Sandra Wyckoff job", "%Sandra Wyckoff%"],
  ["what did dispatch write up for the Deborah Ortega account", "%Deborah Ortega%"],
  ["dispatch note details for the Jessica Bennett job", "%Jessica Bennett%"],
];
for (const [text, pat] of DISPATCH_NOTE_FOR_NAME) {
  questions.push({
    id: nextId(), text, category: CATEGORY, shape: "team_scoped_contrast", cmp: "value",
    oracle: {
      sql: `WITH m AS (SELECT id FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1)
SELECT x.value AS v FROM documents d JOIN document_entity_links l ON l.document_id=d.id
JOIN extractions x ON x.document_id=d.id AND x.field_key='notes'
WHERE d.document_type='dispatch-note' AND l.entity_id IN (SELECT id FROM m) AND (SELECT count(*) FROM m) = 1`,
      params: [pat],
      requires: { sql: `SELECT count(*) AS n FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ILIKE $1`, params: [pat] },
    },
    citationRequired: true,
  });
}

/* ================================================================================================
 * SECTION G — MUST-DECLINE / MUST-ASK-WHICH traps (20, required by the round contract)
 * ================================================================================================ */

const NEVER_HVAC = `SELECT 0 AS n`;
const OUT_OF_DOMAIN = [
  ["whats the capital of arizona", "not a records question at all"],
  ["can you sing me a song about ac units", "not a records question at all"],
  ["whats 8 times 14", "arithmetic, not a records lookup"],
  ["who's your favorite customer", "not a records question, an opinion prompt"],
  ["set a timer for ten minutes", "not a records question at all"],
  ["whats the square root of 144", "arithmetic, not a records lookup"],
];
for (const [text, why] of OUT_OF_DOMAIN) questions.push(decline({ text, shape: "out_of_domain", guardSql: NEVER_HVAC, why }));

const AMBIGUOUS_TRAPS = [
  ["is there anything scheduled for the ibarra account", "%Ibarra%", "2 distinct customers"],
  ["whats the phone number for jarvis", "%Jarvis%", "2 distinct customers"],
  ["pull the file on osborn", "%Osborn%", "3 distinct customers"],
  ["whats the address on file for hutchins", "%Hutchins%", "4 distinct customers"],
];
for (const [text, pat, why] of AMBIGUOUS_TRAPS) {
  questions.push(ambiguitySet({ text, shape: "ambiguous_name", namePattern: pat, why: `the bare surname matches ${why} in this tenant - must ask which one, never silently pick` }));
}

const NO_ANTECEDENT = [
  "and what was the address again",
  "same thing but for the other one",
  "put me through to the tech that handled it",
  "whats the total for that job",
  "and when was that",
  "what about the second one",
];
for (const text of NO_ANTECEDENT) questions.push(noAntecedentDecline(text));

const NEVER_ON_FILE = [
  ["what color was the unit painted", ["unit_color", "color"]],
  ["whats the compressor's start-up amperage", ["startup_amperage", "amperage"]],
  ["who financed the equipment purchase for this job", ["financing_company", "finance_provider"]],
  ["whats the wifi password for the smart thermostat", ["wifi_password", "thermostat_wifi"]],
];
for (const [text, keys] of NEVER_ON_FILE) questions.push(neverOnFieldDecline({ text, shape: "unanswerable", fieldKeys: keys, why: `${keys[0]} is never an extracted field in this corpus` }));

/* ================================================================================================
 * SECTION H — mixed coverage: compound / negation / multi-hop / ranking / comparison (20)
 * ================================================================================================ */

function mfgWithRepairThisYear(text, mfg) {
  return numberQ({
    text, shape: "multi_hop", tolerance: 0, citationRequired: false,
    sql: `SELECT count(DISTINCT e.customer_id) AS n
FROM entities e
WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND e.data->>'manufacturer' ILIKE '${mfg}'
  AND EXISTS (
    SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id
    WHERE x.field_key='service_type' AND x.value='Repair' AND (l.entity_id=e.customer_id OR l.entity_id=e.id)
      AND EXISTS (SELECT 1 FROM extractions s WHERE s.document_id=l.document_id AND s.field_key='service_date' AND extract(year from s.value::date) = extract(year from $1::date))
  )`,
    params: [TODAY],
  });
}
questions.push(mfgWithRepairThisYear("how many rheem customers needed a repair this year", "rheem"));
questions.push(mfgWithRepairThisYear("how many daikin customers needed a repair this year", "daikin"));

questions.push(numberQ({
  text: "how many customers have never once had a preventive maintenance visit logged", shape: "negation", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND NOT EXISTS (
  SELECT 1 FROM document_entity_links l JOIN extractions x ON x.document_id=l.document_id
  WHERE x.field_key='service_type' AND x.value='Preventive Maintenance'
    AND (l.entity_id=c.id OR l.entity_id IN (SELECT id FROM entities e WHERE e.entity_type='equipment' AND e.customer_id=c.id))
)`, params: [] }));
questions.push(yesNoQ({ text: "have we ever installed an amana system", shape: "negation", sql: `SELECT EXISTS (SELECT 1 FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'amana') AS v`, params: [] }));
questions.push(numberQ({
  text: "how many units are missing a tonnage on file", shape: "negation", tolerance: 0, citationRequired: false,
  sql: `SELECT count(*) AS n FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND coalesce(data->>'tonnage','')=''`, params: [],
}));

questions.push(twoFieldAtAddress("model and serial, both, for 1395 E Ray Rd please", "1395 E Ray Rd%", "model", "serial_number"));
questions.push(twoFieldAtAddress("manufacturer and install date for 1580 W Camelback Rd", "1580 W Camelback Rd%", "manufacturer", "installation_date"));
questions.push(twoFieldAtAddress("tonnage and refrigerant for the unit at 2838 E Elliot Rd", "2838 E Elliot Rd%", "tonnage", "refrigerant"));
questions.push(twoFieldAtAddress("tonnage and refrigerant on file for 2912 E Broadway Rd", "2912 E Broadway Rd%", "tonnage", "refrigerant"));
questions.push(twoFieldAtAddress("serial and manufacturer for 3208 E McKellips Rd", "3208 E McKellips Rd%", "serial_number", "manufacturer"));

questions.push({
  id: nextId(), text: "what manufacturers are on file at Grace Community Church", category: CATEGORY, shape: "ambiguous_multiunit", cmp: "set",
  oracle: { sql: `SELECT DISTINCT e.data->>'manufacturer' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Grace Community Church%'`, params: [] },
});
questions.push({
  id: nextId(), text: "list every serial number on file for Holy Trinity Church", category: CATEGORY, shape: "ambiguous_multiunit", cmp: "set",
  oracle: { sql: `SELECT e.data->>'serial_number' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Holy Trinity Church%'`, params: [] },
});
questions.push(rubricQ({
  text: "whats the refrigerant situation at Cactus Rose Restaurant", shape: "ambiguous_multiunit",
  rubric: "Cactus Rose Restaurant has 2 units on file - both parts of the answer must be addressed (whichever has a refrigerant on file and whichever doesn't), never silently reporting on just one unit as if it were the only one.",
}));
questions.push({
  id: nextId(), text: "when were the units at Sonoran Grill Restaurant installed", category: CATEGORY, shape: "ambiguous_multiunit", cmp: "set",
  oracle: { sql: `SELECT e.data->>'installation_date' AS item FROM entities e JOIN entities c ON c.id=e.customer_id WHERE e.entity_type='equipment' AND e.merged_into IS NULL AND c.data->>'customer_name' ILIKE '%Sonoran Grill Restaurant%'`, params: [] },
});

questions.push(valueQ({ text: "whats the newest daikin install we have on file", shape: "ranking", sql: `SELECT data->>'installation_date' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'daikin' AND data->>'installation_date' IS NOT NULL ORDER BY data->>'installation_date' DESC LIMIT 1`, params: [] }));
questions.push(valueQ({ text: "whats the oldest rheem install we have on file", shape: "ranking", sql: `SELECT data->>'installation_date' AS v FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'rheem' AND data->>'installation_date' IS NOT NULL ORDER BY data->>'installation_date' ASC LIMIT 1`, params: [] }));
questions.push(numberQ({ text: "how many distinct technicians have we ever dispatched", shape: "ranking", tolerance: 0, citationRequired: false, sql: `SELECT count(DISTINCT value) AS n FROM extractions WHERE field_key='technician' AND value IS NOT NULL`, params: [] }));

questions.push(yesNoQ({ text: "do we have more mitsubishi units than york units on file", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'mitsubishi') > (SELECT count(*) FROM entities WHERE entity_type='equipment' AND merged_into IS NULL AND data->>'manufacturer' ILIKE 'york') AS v`, params: [] }));
questions.push(yesNoQ({ text: "does Chandler have more customers on the books than Tempe", shape: "comparison", sql: `SELECT (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Chandler,%') > (SELECT count(*) FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'service_address' ILIKE '%, Tempe,%') AS v`, params: [] }));

/* ============================================================== output */

if (questions.length !== 200) {
  console.error(`gen-field-phrasing-3: expected 200 questions, built ${questions.length}`);
  process.exit(1);
}
const ids = new Set(questions.map((q) => q.id));
if (ids.size !== 200) {
  console.error(`gen-field-phrasing-3: duplicate ids (${200 - ids.size} collisions)`);
  process.exit(1);
}

const out = {
  version: "2026-09-27.field-phrasing-3-r19",
  category: CATEGORY,
  source: "Round 19 (I3) blind generalization set - 200 new questions, written without reading exam.json/field-phrasing.json/field-phrasing-2.json question texts or engine regexes; grounded only in scripts/golden/golden-export.json + the exam file format. Personas: owner (business health), office manager (paperwork completeness), dispatch (reverse lookups, last-on-site, live-status declines), warranty clerk (registration windows, claims), voice-dictating field tech (numbers as words, misheard brand names, run-ons/filler), team-scoped internal-document questions (20), must-decline/must-ask-which traps (20).",
  questions,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`gen-field-phrasing-3: wrote ${questions.length} questions -> ${OUT_PATH}`);
  const byCmp = {};
  const byShape = {};
  for (const q of questions) { byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1; byShape[q.shape] = (byShape[q.shape] ?? 0) + 1; }
  console.log("by cmp:", JSON.stringify(byCmp));
  console.log("by shape:", JSON.stringify(byShape));
}

export { questions, out };
