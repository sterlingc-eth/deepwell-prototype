/**
 * Round 16, F3 — verifies the field-phrasing generalization shapes this
 * engineer owns: possessive/bare-surname field lookups, misc addressed-scoped
 * fields, "what do we have on file for X" list-intent, compound (two-part)
 * questions, existence yes/no, and the out-of-domain decline. Every shape is
 * tested for its POSITIVE match (correct field/behavior) and its NEGATIVE
 * cases (must never hijack a real business/analytics question, must never
 * fabricate a value for an ambiguous name, must never trigger on HVAC words).
 *
 * Part A is pure shape-detection — no DB. Part B runs the real resolvers
 * against the golden tenant (PGlite, same harness scripts/offline-exam.mjs
 * and scripts/verify-field-phrasing.mjs use) to check end-to-end behavior:
 * ambiguity DECLINES for the new strict-oracle shapes, ambiguity LISTS for
 * the pre-existing lenient-oracle shapes, existence/out-of-domain answers,
 * and compound splitting (full answer vs. honest partial-defer).
 *
 * Pure/offline — no network, no real DB, no model call, ever.
 *
 *   node scripts/verify-lookups-r16.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseContactLookupQuestion,
  runContactLookup,
  buildOutOfDomainAnswer,
} from "../api/_lib/contactLookup.js";
import { parseDocLookupQuestion } from "../api/_lib/docLookup.js";
import { parseCompoundQuestion, runCompound } from "../api/_lib/lookups/compound.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let count = 0;
const check = (name, ok, detail = "") => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ============================================================ Part A: pure shape detection */

// ---- field_lookup_name: possessive / bare-surname / typo field questions ----
const FIELD_LOOKUP_NAME_POSITIVES = [
  ["whats the serial on Prentiss's unit", "serial", "prentiss", true],
  ["whats the serial number on Norwood's unit", "serial", "norwood", true],
  ["model number for the Bracken job", "unitModel", "bracken", true],
  ["does Norwood have a warranty on file", "unitWarranty", "norwood", false],
  ["does Fitzgerald have a warranty", "unitWarranty", "fitzgerald", false],
];
for (const [q, field, namePhrase, declineOnAmbiguous] of FIELD_LOOKUP_NAME_POSITIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`field_lookup_name (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
  if (parsed) {
    eq(`field_lookup_name :: "${q}" field`, parsed.field, field);
    eq(`field_lookup_name :: "${q}" namePhrase`, parsed.namePhrase.toLowerCase(), namePhrase);
    eq(`field_lookup_name :: "${q}" declineOnAmbiguous`, Boolean(parsed.declineOnAmbiguous), declineOnAmbiguous);
  }
}
// "whats Montoya phone number" style — the greedy/lazy regex fix. Must split
// name from field correctly, never swallow the field word into the name.
{
  const parsed = parseContactLookupQuestion("whats Montoya phone number");
  check('field_lookup_name :: "whats Montoya phone number" detected', Boolean(parsed));
  if (parsed) {
    eq('field_lookup_name :: namePhrase excludes the field word', parsed.namePhrase.toLowerCase(), "montoya");
    eq('field_lookup_name :: field resolves to phone, not "montoya phone"', parsed.field, "phone");
  }
}

// Negative: must never hijack a real analytics/retrieval/doc question that
// merely shares a name-lookup-ish word.
const FIELD_LOOKUP_NAME_NEGATIVES = [
  "how many customers have a warranty",
  "whats our average job value",
  "list all customers with an expired warranty",
];
for (const q of FIELD_LOOKUP_NAME_NEGATIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`field_lookup_name (negative) :: "${q}" not hijacked`, parsed === null || parsed.field === undefined || !["unitSerial", "unitModel", "unitWarranty", "phone", "email"].includes(parsed.field), JSON.stringify(parsed));
}

// ---- misc_field: PO number / permit# / maintenance-agreement-expiry, address-scoped ----
const MISC_FIELD_POSITIVES = [
  "whats the po number for the job at 1395 e ray rd",
  "permit # for 1728 W Ocotillo Rd",
  "when does the maintenance agreement expire for Calloway",
];
for (const q of MISC_FIELD_POSITIVES) {
  const parsed = parseDocLookupQuestion(q);
  check(`misc_field (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
}
// Negative: a plain doc-count/analytics question must not be hijacked into a misc_field shape.
for (const q of ["how many permits did we pull this year", "show me all invoices"]) {
  const parsed = parseDocLookupQuestion(q);
  check(`misc_field (negative) :: "${q}" not hijacked as a field lookup`, !(parsed && parsed.field), JSON.stringify(parsed));
}

// ---- existence: yes/no ----
const EXISTENCE_POSITIVES = [
  ["do we have any records for 470 e chandler blvd", "existsAddress"],
  ["we ever work on a house on val vista dr", "existsStreet"],
  ["is there a customer named ortega", "existsName"],
];
for (const [q, field] of EXISTENCE_POSITIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`existence (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
  if (parsed) eq(`existence :: "${q}" field`, parsed.field, field);
}
// Negative: a normal "do we have X on file for Y" (a real field lookup, not a bare existence check) must not be misrouted.
{
  const parsed = parseContactLookupQuestion("do we have a warranty on file for Norwood");
  check('existence (negative) :: field question is not misread as bare existence', !parsed || parsed.field !== "existsName" && parsed.field !== "existsAddress" && parsed.field !== "existsStreet");
}

// ---- out_of_domain: fast, honest decline; must NEVER trigger on real business questions ----
const OUT_OF_DOMAIN_POSITIVES = [
  "whats the wifi password",
  "who won the game last night",
  "whats the model of my printer",
];
for (const q of OUT_OF_DOMAIN_POSITIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`out_of_domain (positive) :: "${q}" declines`, Boolean(parsed) && parsed.field === "outOfDomain", JSON.stringify(parsed));
}
const answer = buildOutOfDomainAnswer();
check("out_of_domain :: decline is a no-answer kind", answer.kind === "no-answer");
check("out_of_domain :: decline offers example questions it CAN answer", /phone|warranty|customer/i.test(answer.text) && answer.text.length > 20);

// Negative — the hard requirement: must never trigger on real HVAC/business
// words, even ones that share vocabulary with the out-of-domain examples
// ("model", "number", "unit", "game" plan, etc. never appear here, but these
// exercise the same surface area a careless keyword match would misfire on).
const OUT_OF_DOMAIN_NEGATIVES = [
  "whats the model number on the unit at 1580 W Camelback Rd",
  "does Norwood have a warranty on file",
  "whats the serial on Prentiss's unit",
  "what equipment do we have on file for Kowalski",
  "how many service calls this month",
  "whats the tonnage on the Bracken unit",
  "when was the last time we serviced the Mercer account",
];
for (const q of OUT_OF_DOMAIN_NEGATIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`out_of_domain (negative) :: "${q}" never declines as out-of-domain`, !(parsed && parsed.field === "outOfDomain"), JSON.stringify(parsed));
}

// ---- collision_risk: "mercer account, when was it last serviced" ----
{
  const parsed = parseContactLookupQuestion("mercer account, when was it last serviced");
  check('collision_risk :: "mercer account, when was it last serviced" detected', Boolean(parsed), JSON.stringify(parsed));
  if (parsed) {
    eq("collision_risk :: field", parsed.field, "lastVisit");
    check("collision_risk :: never silently picks one Mercer (per-candidate, not decline)", parsed.perCandidateOnly === true || !parsed.declineOnAmbiguous);
  }
}

// ---- compound: splitter shape detection ----
const COMPOUND_POSITIVES = [
  ["whats the model and serial on the unit at 1580 W Camelback Rd", "modelSerial"],
  ["whats the customers name and phone for 2246 E Ray Rd", "namePhone"],
  ["is Abernathy still under warranty and whos the tech that did it", "warrantyTech"],
  ["who installed it and when for 1913 E University Dr", "installerDate"],
  // Chatty prefix must not break the match (not anchored at start).
  ["hey quick one, whats the model and serial on the unit at 1580 W Camelback Rd", "modelSerial"],
];
for (const [q, kind] of COMPOUND_POSITIVES) {
  const parsed = parseCompoundQuestion(q);
  check(`compound (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
  if (parsed) eq(`compound :: "${q}" kind`, parsed.kind, kind);
}
// Negative: a single-part question sharing some of the same words must not
// be split (dropped condition — one half of the "and" is missing).
const COMPOUND_NEGATIVES = [
  "whats the model on the unit at 1580 W Camelback Rd", // no "and serial"
  "whats the customers name for 2246 E Ray Rd", // no "and phone"
  "is Abernathy still under warranty", // no "and whos the tech"
  "who installed it for 1913 E University Dr", // no "and when"
  "how many customers do we have and whats our revenue", // two REAL analytics halves, not this shape at all
];
for (const q of COMPOUND_NEGATIVES) {
  eq(`compound (negative) :: "${q}" not split`, parseCompoundQuestion(q), null);
}

console.log(`\nPart A: ${count} checks so far, ${failures} failed.`);

/* ============================================================ Part B: end to end against the golden tenant */
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
const { withTenant } = await import(path.join(ROOT, "api/_lib/recordsStore.js"));

await installPgHarness();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "verify-lookups-r16", tenantName: "Verify Lookups R16" });

const today = "2026-09-26";
await withTenant(ctx, async (db) => {
  // ---- unique-match field lookups answer with a real value + citation ----
  {
    const r = await runContactLookup(db, "whats the serial on Thornton's unit", { today });
    check('unique match :: "whats the serial on Thornton\'s unit" answers with a value', Boolean(r) && r.kind !== "no-answer" && r.facts.length > 0, JSON.stringify(r));
    check("unique match :: carries a citation", Boolean(r?.sources?.length || r?.records?.length), JSON.stringify(r?.sources));
  }

  // ---- ambiguous surname + NEW strict shape (declineOnAmbiguous) -> DECLINE, never guess ----
  {
    const r = await runContactLookup(db, "whats the serial on Bracken's unit", { today }); // POSSESSIVE_UNIT_ATTR_RE
    check('ambiguous + new possessive shape :: "Bracken" (2 matches) DECLINES rather than picks one', Boolean(r) && r.facts.length === 0, JSON.stringify(r));
  }
  {
    const r = await runContactLookup(db, "model number for the Fitzgerald job", { today }); // MODEL_FOR_JOB_RE
    check('ambiguous + new model-for-job shape :: "Fitzgerald" (2 matches) DECLINES', Boolean(r) && r.facts.length === 0, JSON.stringify(r));
  }
  {
    const r = await runContactLookup(db, "whats Bracken phone number", { today });
    check('ambiguous + phone :: "Bracken" phone DECLINES (never dials a maybe-wrong number)', Boolean(r) && r.facts.length === 0, JSON.stringify(r));
  }

  // ---- ambiguous surname + PRE-EXISTING lenient shape -> LIST every match (unchanged base-exam behavior) ----
  {
    const r = await runContactLookup(db, "whats the serial on the Bracken unit", { today }); // ON_THE_NAME_UNIT_RE (old shape, no possessive)
    check('ambiguous + pre-existing "on the X unit" shape :: "Bracken" (2 matches) LISTS both, does not decline', Boolean(r) && r.facts.length >= 2, JSON.stringify(r));
  }
  {
    const r = await runContactLookup(db, "does Bracken have a warranty on file", { today });
    check('ambiguous + warranty status :: "Bracken" (2 matches) LISTS both (status is safe to show for everyone)', Boolean(r) && r.facts.length >= 2, JSON.stringify(r));
  }

  // ---- existence ----
  {
    const r = await runContactLookup(db, "is there a customer named ortega", { today });
    check('existence :: "ortega" answers yes/no honestly', Boolean(r) && /\b(yes|no)\b/i.test(r.text.slice(0, 10)), JSON.stringify(r));
  }
  {
    const r = await runContactLookup(db, "is there a customer named zzznonexistentzzz", { today });
    check('existence :: a name with zero matches answers "no", never fabricates', Boolean(r) && /\bno\b/i.test(r.text.slice(0, 10)), JSON.stringify(r));
  }

  // ---- collision_risk: g077-style ----
  {
    const r = await runContactLookup(db, "mercer account, when was it last serviced", { today });
    const haystack = (r?.text + " " + JSON.stringify(r?.facts)).toLowerCase();
    check('collision_risk :: "mercer" (2 matches) reports EVERY candidate, never just one', Boolean(r) && haystack.includes("thomas mercer") && haystack.includes("laura mercer"), JSON.stringify(r));
  }

  // ---- list_intent ----
  {
    const r = await runContactLookup(db, "show me everything on Thornton", { today });
    check('list_intent :: "show me everything on Thornton" returns a cited file summary', Boolean(r) && r.kind !== "no-answer" && r.facts.length > 0, JSON.stringify(r));
  }

  // ---- compound: full resolve when both halves are on file ----
  {
    const r = await runCompound(db, "is Fitzgerald still under warranty and whos the tech that did it", { today });
    check("compound warrantyTech :: answers both halves, every ambiguous match named", Boolean(r) && r.text.toLowerCase().includes("linda fitzgerald") && r.text.toLowerCase().includes("steven fitzgerald"), JSON.stringify(r));
  }

  // ---- compound: partial/unresolvable defers rather than guessing (dropped-condition negative) ----
  {
    const r = await runCompound(db, "whats the model and serial on the unit at 999 Nonexistent St", { today });
    eq("compound modelSerial :: unresolvable address defers to null (never a guessed partial)", r, null);
  }
});

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
process.exit(0);
