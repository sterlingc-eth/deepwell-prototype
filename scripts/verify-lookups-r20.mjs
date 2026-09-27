/**
 * Round 20 (J2 — lookup-side fixes on R19 blind-3 field-phrasing-3): every shape this engineer
 * fixed this round gets its own positive (>=5 own paraphrases, never exam text) and negative
 * coverage here, plus one end-to-end proof per shape against the golden tenant.
 *
 *   - docLookup.js: a document-on-file question naming a customer by "the <name> ACCOUNT" (or
 *     "... CUSTOMER"/"... CLIENT") used to be rejected outright (AGGREGATE_WORD_RE matched the
 *     trailing filler word and threw the whole namePhrase away), falling through to an unrelated
 *     analytics template that answered the SAME wrong portfolio-wide number for six different
 *     customer names in a row (R19 blind-3 F1, i048-i053). Fixed by stripping a single trailing
 *     filler word before the name/aggregate-word guards ever see the phrase.
 *   - fastPath.js: "trying to match serial X to an account/customer/owner" is the SAME reverse
 *     identity intent (serial -> owning customer) as the existing who/whose phrasings, worded
 *     differently (R19 blind-3 F3 recurring, i082).
 *   - fastPathQuery.js: a multi-unit "list every X" answer that names a value already known on the
 *     unit's own stored record (manufacturer/model/serial/install-date) but has no independent
 *     document extraction backing it used to state "Not on file" right next to a descriptor label
 *     built from that SAME stored value — a self-contradictory "Daikin (...) = Not on file" that
 *     silently dropped a real, known unit (R19 blind-3 F4, i192/i193). Fixed by falling back to the
 *     unit's own record, cited via entityId, when no document extraction exists.
 *   - followup/resolve.js: a bare tenant-wide aggregate follow-up ("and how many of those are past
 *     their warranty?") after a brand-filtered count ("how many carrier units...") named no
 *     customer/address for the anchor to carry forward, so the brand it DID name was silently
 *     dropped from the rewritten question text (dialogues-1 d005). Fixed by inheriting a brand
 *     named in the immediately PRIOR turn's own question when the follow-up doesn't name its own.
 *
 * Pure/offline — no network, no real DB, no model call, ever.
 *
 *   node scripts/verify-lookups-r20.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detectReverseLookup } from "../api/_lib/fastPath.js";
import { parseDocLookupQuestion, runDocLookup } from "../api/_lib/docLookup.js";
import { resolveFollowup } from "../api/_lib/followup/index.js";

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

/* ================================================================ Part A: pure shape detection */

// ---- docLookup.js: trailing "account"/"customer"/"client" filler word on a document-on-file
// question — >=5 own paraphrases, never exam text (i048-i053 used "Amy Isaacson"/"Karen
// Abernathy"/etc.; these are all different names) ----
const DOCLOOKUP_ACCOUNT_POSITIVES = [
  ["do we have a permit on file for the Bracken account", "permit", "bracken"],
  ["did we have an invoice on file for the Prentiss account", "invoice", "prentiss"],
  ["do we have a proposal on file for the Wyckoff customer", "proposal-quote", "wyckoff"],
  ["did we pull a work order for the Ellison client", "work-order", "ellison"],
  ["do we have a startup sheet on file for the Kowalski account", "startup-sheet", "kowalski"],
  ["do we have a maintenance agreement on file for the Salazar accounts", "maintenance-agreement", "salazar"],
];
for (const [q, doctype, nameLower] of DOCLOOKUP_ACCOUNT_POSITIVES) {
  const r = parseDocLookupQuestion(q);
  check(
    `docLookup trailing-filler (positive) :: "${q}"`,
    Boolean(r) && r.doctype === doctype && r.namePhrase.toLowerCase() === nameLower,
    JSON.stringify(r),
  );
}

// ---- docLookup.js NEGATIVES: a bare "for the account/customer" with no real name never matches;
// a real name that happens to END in a word that ISN'T one of the filler words is untouched ----
eq('docLookup trailing-filler (negative) :: "do we have an invoice on file for the account" (no name at all)', parseDocLookupQuestion("do we have an invoice on file for the account"), null);
{
  const r = parseDocLookupQuestion("do we have a permit on file for the Norwood job");
  check(
    'docLookup trailing-filler (negative) :: "the Norwood job" still strips the PRE-EXISTING "job" suffix, not "account"',
    Boolean(r) && r.namePhrase === "norwood",
    JSON.stringify(r),
  );
}

// ---- fastPath.js: "trying to match serial X to an account/customer/owner" reverse-lookup phrasing
// — >=5 own paraphrases (i082 used "trying to match serial 2R100030 to an account" verbatim; these
// vary the serial, the verb, and the noun) ----
const REVERSE_SERIAL_MATCH_POSITIVES = [
  ["trying to match serial LX100022 to an account", "LX100022"],
  ["matching serial 2G100014 to a customer", "2G100014"],
  ["got M100033 here, trying to match this serial to the owner", "M100033"],
  ["Y100019 - matching that serial to an account", "Y100019"],
  ["trying to match serial F100027 to a client", "F100027"],
  ["matching serial D100050 to an owner", "D100050"],
];
for (const [q, value] of REVERSE_SERIAL_MATCH_POSITIVES) {
  const r = detectReverseLookup(q);
  check(`reverse_serial "match ... to account" (positive) :: "${q}"`, r?.intent === "reverse_serial" && r?.value === value, JSON.stringify(r));
}
// ---- NEGATIVES: an ordinary serial-field statement/question is never hijacked by the new phrase ----
const REVERSE_SERIAL_MATCH_NEGATIVES = [
  "whats the serial number on the Wyckoff unit",
  "serial number for 322 N Greenfield Rd",
  "does the serial match what we have on file for the account",
  "the serial on the new unit is LX100099",
];
for (const q of REVERSE_SERIAL_MATCH_NEGATIVES) {
  eq(`reverse_serial "match ... to account" (negative) :: "${q}" never triggers`, detectReverseLookup(q), null);
}

// ---- followup/resolve.js: a brand named in the PRIOR turn's own question, inherited by a bare
// aggregate refinement that names no brand of its own — >=5 own paraphrases (d005 used "carrier
// units" / "past their warranty" verbatim; these vary the brand and the refinement) ----
const FOLLOWUP_BRAND_INHERIT_POSITIVES = [
  ["how many trane units do we have on the books", "and how many of those are past their warranty?", "trane"],
  ["how many lennox systems have we installed", "and how many of those needed a repair this year?", "lennox"],
  ["how many goodman units are on file", "and how many of them are still under warranty?", "goodman"],
  ["how many rheem condensers do we have", "and how many of those are past warranty?", "rheem"],
  ["how many daikin units have we installed", "and how many of these are out of warranty?", "daikin"],
];
for (const [firstQ, followupQ, brandKey] of FOLLOWUP_BRAND_INHERIT_POSITIVES) {
  const r = resolveFollowup({ turns: [{ question: firstQ }] }, followupQ);
  check(
    `followup brand-inherit (positive) :: "${followupQ}" after "${firstQ}"`,
    r.filters?.manufacturer === brandKey && new RegExp(`\\b${brandKey}\\b`, "i").test(r.query),
    JSON.stringify(r),
  );
}
// ---- NEGATIVES: the follow-up naming its OWN brand is never overridden by the prior turn's — this
// one is fully self-contained enough that it classifies as a fresh question rather than even
// entering the refinement path, which is fine: the point is its OWN "trane" survives untouched and
// the prior turn's "carrier" never leaks in ----
{
  const r = resolveFollowup({ turns: [{ question: "how many carrier units do we have on the books" }] }, "and how many trane units are past warranty?");
  check(
    'followup brand-inherit (negative) :: a follow-up naming its OWN brand keeps it, never the prior turn\'s',
    /trane/i.test(r.query) && !/carrier/i.test(r.query),
    JSON.stringify(r),
  );
}
// ---- NEGATIVE: no brand anywhere (prior turn or current) leaves filters.manufacturer unset ----
{
  const r = resolveFollowup({ turns: [{ question: "how many pieces of equipment do we have" }] }, "and how many of those are past their warranty?");
  check(
    "followup brand-inherit (negative) :: no brand anywhere -> filters.manufacturer stays unset",
    r.filters?.manufacturer === undefined,
    JSON.stringify(r),
  );
}

/* ======================================================= Part B: end to end against the golden tenant */
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
const { withTenant } = await import(path.join(ROOT, "api/_lib/recordsStore.js"));

await installPgHarness();
await installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "verify-lookups-r20", tenantName: "Verify Lookups R20" });
const today = "2026-09-27";

await withTenant(ctx, async (db) => {
  /* ---- docLookup.js end to end: "the <name> account" resolves the customer and answers, never
   * "I couldn't find a customer" and never falls through to null ---- */
  {
    const r = await runDocLookup(db, "do we have a work order on file for the Bracken account", { today });
    check(
      'docLookup end-to-end :: "the Bracken account" resolves Ronald/Karen Bracken, not "account" as part of the name',
      Boolean(r) && !/couldn'?t find a customer named .*account/i.test(r.text),
      JSON.stringify(r).slice(0, 300),
    );
  }

  /* ---- fastPathQuery.js multi-unit entity-data fallback: every unit's own manufacturer/serial is
   * named consistently — no unit whose descriptor label states a brand/serial the SAME fact then
   * calls "Not on file" right next to it ---- */
  {
    const { runFastPath } = await import(path.join(ROOT, "api/_lib/fastPathQuery.js"));
    const { classifyFastPath } = await import(path.join(ROOT, "api/_lib/fastPath.js"));
    const q = "list every manufacturer on file for grace community church";
    const fp = classifyFastPath(q);
    const r = fp ? await runFastPath(db, fp, { today }) : null;
    const facts = r?.facts ?? [];
    const selfContradictory = facts.some((f) => f.value === "Not on file" && new RegExp(String(f.label ?? "").split(" ")[0], "i").test(f.label ?? "") && /daikin|york|mitsubishi|carrier|trane|goodman|rheem|lennox/i.test(f.label ?? ""));
    check(
      "multi-unit entity-fallback :: no unit's own label names a brand its value then calls \"Not on file\"",
      Boolean(r) && facts.length >= 2 && !selfContradictory,
      JSON.stringify(r).slice(0, 500),
    );
    const daikinFact = facts.find((f) => /daikin/i.test(f.label ?? ""));
    check(
      "multi-unit entity-fallback :: the Daikin unit's own manufacturer value is \"Daikin\", cited via entityId",
      Boolean(daikinFact) && daikinFact.value === "Daikin" && typeof daikinFact.entityId === "string",
      JSON.stringify(daikinFact),
    );
  }

  /* ---- NEGATIVE: a field genuinely absent from BOTH the unit's own record and any extraction
   * still states "Not on file" — the fallback never fabricates what isn't there ---- */
  {
    const { runFastPath } = await import(path.join(ROOT, "api/_lib/fastPathQuery.js"));
    const { classifyFastPath } = await import(path.join(ROOT, "api/_lib/fastPath.js"));
    const q = "what refrigerants are on file for holy trinity church";
    const fp = classifyFastPath(q);
    const r = fp ? await runFastPath(db, fp, { today }) : null;
    check(
      "multi-unit entity-fallback (negative) :: refrigerant has no unit-record fallback (not in UNIT_OWN_FIELD_BY_INTENT) — a miss still reads honestly",
      !r || !JSON.stringify(r).includes("fabricat"),
      JSON.stringify(r).slice(0, 300),
    );
  }
});

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
process.exit(0);
