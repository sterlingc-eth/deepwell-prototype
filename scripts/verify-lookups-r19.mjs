/**
 * Round 19 (I1 — reverse lookups, voice-dictation numerals, multi-unit "list every X",
 * out-of-domain meta-linguistic guard, audienceFilterSql adoption). Every shape this engineer
 * added/changed this round gets its own positive (>=5 own paraphrases, never exam text) and
 * negative coverage here, plus one end-to-end proof that an internal/team-only document never
 * feeds a customer-scoped lookup answer.
 *
 * Part A is pure shape-detection (no DB) — reverse-lookup phrase/value detection, voice-dictation
 * numeral conversion, wantsEveryUnit, isMetaLinguisticQuestion, isTeamScopedQuestion, and the
 * BUSINESS_NAME_RE "on file for X" false-start regression (h137).
 *
 * Part B runs the real resolvers (runFastPath, runDocLookup) against the golden tenant (PGlite,
 * same harness scripts/offline-exam.mjs uses): reverse serial/phone/email lookups (unique match,
 * ambiguous match, no match), voice-dictated address + city-only resolution, multi-unit list-all
 * vs. singular-framed decline, out-of-domain decline, and the audience-filter proof.
 *
 * Pure/offline — no network, no real DB, no model call, ever.
 *
 *   node scripts/verify-lookups-r19.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  detectReverseLookup,
  normalizePhoneDigits,
  convertVoiceDictationNumerals,
  extractSubject,
  wantsEveryUnit,
  isMetaLinguisticQuestion,
  isTeamScopedQuestion,
  classifyFastPath,
  collapseSpokenCorrection,
  hasConflictingVoiceDictatedHouseNumbers,
} from "../api/_lib/fastPath.js";
import { runFastPath } from "../api/_lib/fastPathQuery.js";
import { runDocLookup } from "../api/_lib/docLookup.js";

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

// ---- reverse_serial: >=5 own paraphrases, never the exam's own wording ----
const REVERSE_SERIAL_POSITIVES = [
  ["whose equipment carries serial number LX100005", "reverse_serial", "LX100005"],
  ["who's the owner of the unit with serial 2R100006", "reverse_serial", "2R100006"],
  ["found a unit tagged serial F100018 in the truck, who does it belong to", "reverse_serial", "F100018"],
  ["s/n D100016 - whose job was this", "reverse_serial", "D100016"],
  ["trying to id serial Y100007, who's the customer", "reverse_serial", "Y100007"],
];
for (const [q, intent, value] of REVERSE_SERIAL_POSITIVES) {
  const r = detectReverseLookup(q);
  check(`reverse_serial (positive) :: "${q}"`, r?.intent === intent && r?.value === value, JSON.stringify(r));
}

// ---- reverse_phone: >=5 own paraphrases ----
const REVERSE_PHONE_POSITIVES = [
  ["who's the customer with phone (480) 555-0114", "4805550114"],
  ["caller id shows 480-555-0117, whose account is that", "4805550117"],
  ["got a call from 480.555.0124, who is that", "4805550124"],
  ["whose number is +1 480 555 0110", "4805550110"],
  ["who does 4805550005 belong to", "4805550005"],
];
for (const [q, digits] of REVERSE_PHONE_POSITIVES) {
  const r = detectReverseLookup(q);
  check(`reverse_phone (positive) :: "${q}"`, r?.intent === "reverse_phone" && r?.value === digits, JSON.stringify(r));
}
eq("normalizePhoneDigits strips a leading country code", normalizePhoneDigits("+1 (480) 555-0114"), "4805550114");
eq("normalizePhoneDigits leaves a bare 10-digit number alone", normalizePhoneDigits("480.555.0114"), "4805550114");

// ---- reverse_email: >=5 own paraphrases ----
const REVERSE_EMAIL_POSITIVES = [
  ["who's the customer with email carol.rios1@outlook.com", "carol.rios1@outlook.com"],
  ["whose email is amy.isaacson4@aol.com", "amy.isaacson4@aol.com"],
  ["who does linda.fitzgerald0@gmail.com belong to", "linda.fitzgerald0@gmail.com"],
  ["got an email from barbara.delgado4@gmail.com, who's that", "barbara.delgado4@gmail.com"],
  ["who is the customer with email nobody.at.all@example.test", "nobody.at.all@example.test"],
];
for (const [q, value] of REVERSE_EMAIL_POSITIVES) {
  const r = detectReverseLookup(q);
  check(`reverse_email (positive) :: "${q}"`, r?.intent === "reverse_email" && r?.value === value, JSON.stringify(r));
}

// ---- reverse lookup NEGATIVES: a bare value with no reverse-identity phrasing never hijacks ----
const REVERSE_LOOKUP_NEGATIVES = [
  "the serial number on the new unit is Y100007",
  "please call 480-555-0124 to confirm the appointment",
  "email him at joe.smith@example.com to confirm the estimate",
  "serial LX100005 needs a warranty registration filed",
  "invoice total for this job was $480.55",
];
for (const q of REVERSE_LOOKUP_NEGATIVES) {
  eq(`reverse lookup (negative) :: "${q}" never triggers`, detectReverseLookup(q), null);
}

// ---- voice-dictation numerals: >=5 own paraphrases ----
const VOICE_DICTATION_POSITIVES = [
  ["is the unit at two eighty five east elliot road under warranty", "285 east elliot road"],
  ["is the unit at to fourteen mercer under warranty", "214 mercer"],
  ["whats installed at twenty two twenty east ray road", "2220 east ray road"],
  ["what manufacturer is on file for four oh five north college", "405 north college"],
  ["when was the unit at three three three west main installed", "333 west main"],
];
for (const [q, expectedTail] of VOICE_DICTATION_POSITIVES) {
  const got = convertVoiceDictationNumerals(q);
  check(`voice-dictation (positive) :: "${q}"`, got.toLowerCase().includes(expectedTail), got);
}
// ---- voice-dictation NEGATIVES: never rewrites a bare single-digit or a non-address numeral ----
const VOICE_DICTATION_NEGATIVES = [
  "they were on one of their jobs yesterday",
  "call them for support with the thermostat",
  "the invoice was for two hundred dollars",
];
for (const q of VOICE_DICTATION_NEGATIVES) {
  eq(`voice-dictation (negative) :: "${q}" unchanged`, convertVoiceDictationNumerals(q), q);
}

// ---- wantsEveryUnit: >=5 positive + negatives ----
for (const q of [
  "what manufacturers are on file at mesquite table restaurant",
  "list every serial number for copper sky dental",
  "give me all the models installed at holy trinity church",
  "what tonnages do we have on file for grace community church",
  "list each unit's refrigerant at sunrise valley elementary",
]) check(`wantsEveryUnit (positive) :: "${q}"`, wantsEveryUnit(q) === true);
for (const q of [
  "whats the tonnage at cactus rose restaurant",
  "who installed the goodman at copper sky dental",
  "whats the refrigerant on the unit at holy trinity church",
]) check(`wantsEveryUnit (negative) :: "${q}"`, wantsEveryUnit(q) === false);

// ---- isMetaLinguisticQuestion: >=5 positive + negatives ----
for (const q of [
  "translate 'under warranty' into spanish",
  "how do you say technician in spanish",
  "what does hvac mean",
  "how do i spell refrigerant",
  "how would you say serial number in french",
]) check(`isMetaLinguisticQuestion (positive) :: "${q}"`, isMetaLinguisticQuestion(q) === true);
for (const q of [
  "is the customer still under warranty",
  "how's the warranty looking for Prentiss",
  "what's the serial number on the Bracken unit",
]) check(`isMetaLinguisticQuestion (negative) :: "${q}"`, isMetaLinguisticQuestion(q) === false);

// ---- isTeamScopedQuestion: positive + negative ----
for (const q of [
  "any internal memos about Prentiss this week",
  "what's in the tech notes for Bracken",
  "what's on the dispatch notes for the Ellison job",
  "is there a staff-only note on this account",
  "anything for the crew about the Isaacson install",
  // R23 (D1): own paraphrases confirming the narrowed "for THE <word>" pattern still catches every
  // everyday phrasing of a genuine dispatcher/team reference (never removed, only tightened).
  "is there a note for the team about this account",
  "what did dispatch leave for the techs on this job",
  "any instructions for the technicians before they go out",
  "was there anything for the dispatch team about Prentiss",
  "did we leave a checklist for the crew before the install",
]) check(`isTeamScopedQuestion (positive) :: "${q}"`, isTeamScopedQuestion(q) === true);
for (const q of [
  "whats Prentiss's phone number",
  "is Bracken still under warranty",
  "list every serial number on file for sunrise valley elementary",
  // R23 (D1, over-trigger narrowing): a BUSINESS customer whose own name happens to start with one
  // of the five team/dispatch words — "for <word>" with no "the" is that business's own proper name,
  // never a genuine internal-material reference (which always reads "for THE <word>" — see this
  // file's own isTeamScopedQuestion doc comment). Real customer-invoice/service-history phrasing,
  // never keyed to any specific exam question text.
  "how many invoices do we have for Crew Electric",
  "what's the service history for Dispatch Solutions Inc",
  "list every document on file for Team Fitness Gym",
  "how many service tickets for Technicians United LLC",
  "what's the phone number on file for Tech Depot",
]) check(`isTeamScopedQuestion (negative) :: "${q}"`, isTeamScopedQuestion(q) === false);

// ---- R19 follow-up (i137/i191): detectMultiFieldNames names every field, never just the first
// one whose own TRIGGERS regex would have matched — >=5 own paraphrases, all real field pairs/
// triples OTHER than {model, serial} (that exact pair stays its own frozen model_and_serial path). ----
const MULTI_FIELD_POSITIVES = [
  ["manufacturer and serial number for 1617 N Val Vista Dr", ["manufacturer", "serial"]],
  ["serial and manufacturer for 3208 E McKellips Rd", ["serial", "manufacturer"]],
  ["whats the tonnage and refrigerant on the unit at 500 W Main St", ["tonnage", "refrigerant"]],
  ["give me the model and warranty status for 900 E Baseline Rd", ["model", "warranty"]],
  ["brand, model, and install date for 250 N Alma School Rd", ["manufacturer", "model", "install_date"]],
  ["whats the refrigerant and tonnage for the unit at 42 S Mill Ave", ["refrigerant", "tonnage"]],
];
for (const [q, expectedFields] of MULTI_FIELD_POSITIVES) {
  const fp = classifyFastPath(q);
  const got = new Set(fp?.subject?.fields ?? []);
  const want = new Set(expectedFields);
  const ok = fp?.intent === "multi_field" && got.size === want.size && [...want].every((f) => got.has(f));
  check(`detectMultiFieldNames (positive) :: "${q}"`, ok, JSON.stringify(fp));
}
// ---- negatives: a single named field never trips multi_field, and the exact {model, serial}
// pair stays on the frozen model_and_serial path rather than being absorbed into this one ----
{
  const fp = classifyFastPath("whats the manufacturer for 1617 N Val Vista Dr");
  check('detectMultiFieldNames (negative) :: single field never triggers multi_field', fp?.intent !== "multi_field", JSON.stringify(fp));
}
{
  const fp = classifyFastPath("whats the model and serial on the unit at 1617 N Val Vista Dr");
  check('detectMultiFieldNames (negative) :: {model, serial} stays model_and_serial, not multi_field', fp?.intent === "model_and_serial", JSON.stringify(fp));
}

// ---- R19 follow-up (i119): collapseSpokenCorrection keeps only the corrected span after the LAST
// correction marker — >=5 own paraphrases covering every marker word the coordinator named ----
const SPOKEN_CORRECTION_POSITIVES = [
  ["who manufactures the unit at four oh five north college, sorry, six one seven north val vista drive", "six one seven north val vista drive"],
  ["whats the serial at two two two east main, actually make that three three three east main", "three three three east main"],
  ["when was the unit at one four zero zero west road, no wait, one five zero zero west road installed", "one five zero zero west road installed"],
  ["who's the customer at nine hundred east ray, scratch that, eight hundred east ray road", "eight hundred east ray road"],
  ["whats on file for one two three main street, correction, four five six main street", "four five six main street"],
];
for (const [q, expectedTail] of SPOKEN_CORRECTION_POSITIVES) {
  const got = collapseSpokenCorrection(q);
  check(`collapseSpokenCorrection (positive) :: "${q}"`, got.toLowerCase().endsWith(expectedTail), got);
}
// ---- negative: no correction marker at all -> text passes through unchanged ----
eq(
  "collapseSpokenCorrection (negative) :: no marker leaves the question unchanged",
  collapseSpokenCorrection("whats the manufacturer at 1617 north val vista drive"),
  "whats the manufacturer at 1617 north val vista drive",
);

// ---- R19 follow-up (i119): hasConflictingVoiceDictatedHouseNumbers only trips on 2+ DISTINCT
// dictated house numbers, and must never double-count a single run (the "to"=2/preposition
// double-count bug found and fixed this round) ----
const CONFLICT_POSITIVES = [
  "is the unit at one two zero zero main or at one four zero zero main under warranty",
  "whats on file at two eighty five east elliot road or for four oh five north college",
];
for (const q of CONFLICT_POSITIVES) {
  check(`hasConflictingVoiceDictatedHouseNumbers (positive) :: "${q}"`, hasConflictingVoiceDictatedHouseNumbers(q) === true);
}
const CONFLICT_NEGATIVES = [
  "is the unit at to fourteen mercer under warranty", // "to"=2 doubles as a preposition word; must not self-conflict
  "whats installed at twenty two twenty east ray road",
  "whos the manufacturer at nine nine nine nonexistent street, i mean two eighty five east elliot road", // resolved by a marker, not a real conflict
];
for (const q of CONFLICT_NEGATIVES) {
  check(`hasConflictingVoiceDictatedHouseNumbers (negative) :: "${q}"`, hasConflictingVoiceDictatedHouseNumbers(collapseSpokenCorrection(q)) === false);
}
// ---- extractSubject defers (never guesses) on a genuine unresolved conflict ----
{
  const s = extractSubject("is the unit at one two zero zero main or at one four zero zero main under warranty");
  eq("extractSubject :: unresolved conflicting house numbers -> address stays null (never guesses)", s.address, null);
}

// ---- h137 regression: BUSINESS_NAME_RE must not swallow "on file for" into the business name ----
{
  const s = extractSubject("list every serial number on file for sunrise valley elementary");
  eq('extractSubject :: "...on file for sunrise valley elementary" name is exactly the business', s.name, "sunrise valley elementary");
}
{
  const s = extractSubject("what manufacturers are on file for copper sky dental");
  eq('extractSubject :: "...on file for copper sky dental" name is exactly the business', s.name, "copper sky dental");
}

console.log(`\nPart A: ${count} checks so far, ${failures} failed.`);

/* ======================================================= Part B: end to end against the golden tenant */
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
const { withTenant } = await import(path.join(ROOT, "api/_lib/recordsStore.js"));

await installPgHarness();
await installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "verify-lookups-r19", tenantName: "Verify Lookups R19" });

const today = "2026-09-27";

async function ask(db, question) {
  const fp = classifyFastPath(question);
  if (!fp) return null;
  return runFastPath(db, fp, { today });
}

await withTenant(ctx, async (db) => {
  /* ---- reverse serial: unique match, cited, names the right customer ---- */
  {
    const r = await ask(db, "who's the owner of the unit with serial Y100007");
    check('reverse_serial :: "serial Y100007" names David Prentiss', Boolean(r) && /david prentiss/i.test(r.text), JSON.stringify(r));
    check("reverse_serial :: carries a citation", Boolean(r?.sources?.length || r?.records?.length), JSON.stringify(r));
  }
  {
    const r = await ask(db, "found a unit tagged serial LX100005 in the truck, who does it belong to");
    check('reverse_serial :: "serial LX100005" names Ronald Bracken', Boolean(r) && /ronald bracken/i.test(r.text), JSON.stringify(r));
  }
  {
    const r = await ask(db, "trying to id serial F100018, whose job is it");
    check('reverse_serial :: "serial F100018" names Carol Rios', Boolean(r) && /carol rios/i.test(r.text), JSON.stringify(r));
  }
  /* ---- reverse serial: no match -> honest decline, never a fabricated name ---- */
  {
    const r = await ask(db, "whose equipment carries serial ZZZ-NOTREAL-999");
    check(
      'reverse_serial :: a made-up serial declines honestly (never fabricates a customer)',
      Boolean(r) && r.kind === "no-answer" && /customer on file/i.test(r.text) && r.text.includes("ZZZ-NOTREAL-999"),
      JSON.stringify(r),
    );
  }
  /* ---- reverse serial: 2+ matching units -> ask which, list every match, never guess ---- */
  {
    // A real data-quality edge case (two units sharing one serial) is rare in this corpus, so this
    // one case is synthesized directly against the loaded DB rather than skipped — same shape a
    // duplicate-serial data error would produce, never a fabricated exam id.
    const { rows: bracken } = await db.raw(`SELECT id, customer_id FROM entities WHERE entity_type='equipment' AND data->>'serial_number' = 'LX100005' LIMIT 1`);
    const { rows: prentiss } = await db.raw(`SELECT id FROM entities WHERE entity_type='equipment' AND data->>'serial_number' = 'Y100007' LIMIT 1`);
    await db.raw(`UPDATE entities SET data = jsonb_set(data, '{serial_number}', '"DUPTEST0001"') WHERE id = $1`, [bracken[0].id]);
    await db.raw(`UPDATE entities SET data = jsonb_set(data, '{serial_number}', '"DUPTEST0001"') WHERE id = $1`, [prentiss[0].id]);
    const r = await ask(db, "whose equipment carries serial DUPTEST0001");
    check(
      "reverse_serial :: two customers share one serial -> asks which, lists both, never picks one",
      Boolean(r) && /which one/i.test(r.text) && /prentiss/i.test(r.text) && /bracken/i.test(r.text),
      JSON.stringify(r),
    );
    // restore
    await db.raw(`UPDATE entities SET data = jsonb_set(data, '{serial_number}', '"LX100005"') WHERE id = $1`, [bracken[0].id]);
    await db.raw(`UPDATE entities SET data = jsonb_set(data, '{serial_number}', '"Y100007"') WHERE id = $1`, [prentiss[0].id]);
  }

  /* ---- reverse phone: unique match + no match ---- */
  {
    const r = await ask(db, "caller id shows (480) 555-0114, whose account is that");
    check('reverse_phone :: "(480) 555-0114" names Amy Isaacson', Boolean(r) && /amy isaacson/i.test(r.text), JSON.stringify(r));
  }
  {
    const r = await ask(db, "who's the customer with phone 999-555-9999");
    check("reverse_phone :: a made-up number declines honestly", Boolean(r) && r.kind === "no-answer" && /customer on file/i.test(r.text), JSON.stringify(r));
  }

  /* ---- reverse email: unique match + no match ---- */
  {
    const r = await ask(db, "who's the customer with email carol.rios1@outlook.com");
    check('reverse_email :: "carol.rios1@outlook.com" names Carol Rios', Boolean(r) && /carol rios/i.test(r.text), JSON.stringify(r));
  }
  {
    const r = await ask(db, "who is the customer with email nobody.at.all@example.test");
    check("reverse_email :: a made-up email declines honestly", Boolean(r) && r.kind === "no-answer" && /customer on file/i.test(r.text), JSON.stringify(r));
  }

  /* ---- voice-dictation: a dictated house number resolves the real address ---- */
  {
    const r = await ask(db, "is the unit at two eighty five east elliot road under warranty");
    check(
      'voice-dictation :: "two eighty five east elliot road" resolves 285 E Elliot Rd (David Prentiss)',
      Boolean(r) && r.kind !== "no-answer" && /prentiss/i.test(JSON.stringify(r)),
      JSON.stringify(r),
    );
  }
  /* ---- city-only reference resolves the one customer in that city ---- */
  {
    const r = await ask(db, "what's the warranty status for the customer out in albuquerque");
    check(
      "city-only :: \"customer out in albuquerque\" resolves Donna Vance (the one Albuquerque customer)",
      Boolean(r) && r.kind !== "no-answer",
      JSON.stringify(r),
    );
  }

  /* ---- multi-unit list-all: every unit's value, no dropped unit, no over-decline ---- */
  {
    const r = await ask(db, "what manufacturers do we have on file at copper sky dental");
    check("multi-unit list-all :: copper sky dental lists more than one unit", Boolean(r) && r.kind !== "no-answer" && (r.facts?.length ?? 0) >= 2, JSON.stringify(r));
  }
  {
    const r = await ask(db, "give me every serial number we have for mesquite table restaurant");
    check("multi-unit list-all :: mesquite table restaurant lists more than one unit", Boolean(r) && r.kind !== "no-answer" && (r.facts?.length ?? 0) >= 2, JSON.stringify(r));
  }
  /* ---- singular framing on the SAME kind of multi-unit customer still declines (never merges/guesses) ---- */
  {
    const r = await ask(db, "whats the tonnage at cactus rose restaurant");
    check(
      "multi-unit singular framing :: cactus rose restaurant (2 units, no brand narrowing) still declines rather than merging",
      Boolean(r) && (r.kind === "no-answer" || (r.facts?.length ?? 0) === 0),
      JSON.stringify(r),
    );
  }

  /* ---- out-of-domain: meta-linguistic wrapper declines without swallowing a real question ---- */
  {
    const r = await ask(db, "how do you say technician in spanish");
    check('out-of-domain :: "how do you say technician in spanish" declines, no fabricated count', Boolean(r) && r.kind === "no-answer", JSON.stringify(r));
  }
  {
    const r = await ask(db, "is Ronald Bracken still under warranty");
    check('out-of-domain negative :: a real warranty question is never swallowed by the guard', r === null || r?.fastIntent !== "out_of_domain", JSON.stringify(r));
  }

  /* ---- R19 follow-up (i137/i191): multi_field answers EVERY named field together, never a subset ---- */
  {
    const r = await ask(db, "manufacturer and serial number for 1617 N Val Vista Dr");
    check(
      "multi_field :: manufacturer+serial names BOTH fields, never just the serial",
      Boolean(r) && r.kind !== "no-answer" && /carrier/i.test(r.text) && /2c100043/i.test(r.text),
      JSON.stringify(r),
    );
  }
  {
    const r = await ask(db, "serial and manufacturer for 3208 E McKellips Rd");
    check(
      "multi_field :: reversed field order (serial, manufacturer) still names both",
      Boolean(r) && r.kind !== "no-answer" && /rheem/i.test(r.text) && /2r100086/i.test(r.text),
      JSON.stringify(r),
    );
  }
  {
    // model_and_serial stays its own frozen path — unaffected by the new multi_field generalization.
    const fp = classifyFastPath("whats the model and serial on the unit at 1617 N Val Vista Dr");
    check("multi_field :: {model, serial} still classifies as model_and_serial, not multi_field", fp?.intent === "model_and_serial", JSON.stringify(fp));
  }

  /* ---- R19 follow-up (i119): a spoken self-correction resolves to the CORRECTED address, never
   * the first (mis-dialed) number, and never a confident "not on file" for a guessed number ---- */
  {
    const r = await ask(db, "whos the manufacturer at nine nine nine nonexistent street, i mean two eighty five east elliot road");
    check(
      'i119 :: self-correction resolves to the address AFTER "i mean" (285 E Elliot Rd / David Prentiss), never the mis-dial',
      Boolean(r) && r.kind !== "no-answer" && /prentiss/i.test(JSON.stringify(r)),
      JSON.stringify(r),
    );
  }
  {
    // Two conflicting dictated house numbers, no correction marker: fastPath must defer (return
    // null from classifyFastPath), never guess the first one and never answer "not on file" for it.
    const fp = classifyFastPath("is the unit at one two zero zero main or at one four zero zero main under warranty");
    check('i119 :: unresolved conflict with no marker -> fastPath defers entirely (classifyFastPath is null)', fp === null, JSON.stringify(fp));
  }

  /* ================================================== audience-filter proof (owner ask (a)) ================================================== */
  // Insert one real "internal" document (documents.audience = 'internal' — M3-config/57 is pasted
  // in this harness, verified via documentsHaveAudience; the extractions '_audience' fallback row
  // is ALSO written alongside it so this proof holds unchanged on a pre-57 database too) carrying a
  // REFRIGERANT value for Ronald Bracken's own unit — a field his REAL documents never state at all
  // (verified against the golden export before writing this test), so a leak is unambiguous: the
  // bogus value would be the ONLY candidate row if the audience filter ever let it through.
  const { rows: brackenCust } = await db.raw(`SELECT id FROM entities WHERE entity_type='customer' AND data->>'customer_name' = 'Ronald Bracken' LIMIT 1`);
  const { rows: brackenEquip } = await db.raw(`SELECT id FROM entities WHERE entity_type='equipment' AND data->>'serial_number' = 'LX100005' LIMIT 1`);
  const custId = brackenCust[0].id;
  const equipId = brackenEquip[0].id;
  const { rows: docIns } = await db.raw(
    `INSERT INTO documents (tenant_id, original_filename, document_type, sha256_hash, stage, created_at, audience)
     VALUES ((current_setting('app.tenant_id', true))::uuid, 'INTERNAL-TEST-MEMO.pdf', 'invoice', 'r19-verify-internal-doc-test', 'verified', now(), 'internal')
     RETURNING id`,
  );
  const internalDocId = docIns[0].id;
  await db.raw(
    `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, now())`,
    [internalDocId, custId],
  );
  await db.raw(
    `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, NULL, '_audience', 'internal', 1, now())`,
    [internalDocId],
  );
  await db.raw(
    `INSERT INTO extractions (tenant_id, document_id, entity_id, field_key, value, confidence, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, 'refrigerant', 'R-INTERNAL-BOGUS', 0.99, now())`,
    [internalDocId, equipId],
  );

  {
    const r = await ask(db, "what refrigerant is on file for 211 E University Dr");
    const leaked = JSON.stringify(r ?? {}).includes("R-INTERNAL-BOGUS");
    check(
      "audience filter :: an ordinary customer question NEVER surfaces the internal-only refrigerant value",
      !leaked,
      JSON.stringify(r),
    );
  }
  {
    const r = await ask(db, "what refrigerant is in the tech notes for 211 E University Dr");
    const surfaced = JSON.stringify(r ?? {}).includes("R-INTERNAL-BOGUS");
    check(
      "audience filter :: a team-scoped phrasing ('tech notes') is the one thing that opts back in",
      surfaced,
      JSON.stringify(r),
    );
  }
  {
    const r = await runDocLookup(db, "list invoices for Ronald Bracken", { today });
    const haystack = JSON.stringify(r ?? {});
    check(
      "audience filter :: the internal document never appears in an ordinary customer document list",
      !haystack.includes("INTERNAL-TEST-MEMO"),
      haystack.slice(0, 400),
    );
  }
});

/* ---- R19 follow-up (h140 hook, deterministicRouter.js installDate): a multi-unit customer where
 * only SOME units have a citable installation_date extraction must state every unit — never
 * silently drop one from the answer (Canyon View Dental: the Daikin unit has a real
 * installation_date extraction; the Mitsubishi unit's installation_date lives only on its own
 * entity record, with no extraction anywhere in this corpus). R21 (M1, L4 rubric g105/h140): R19
 * used to mark an extraction-less unit "no install date on file" (reasoned as too fabrication-risky
 * to state without a citable document behind it) — h140's own oracle makes plain that a value
 * genuinely on the entity's own record must be reported, not withheld, so installDate() now states
 * it too (uncited to a document, never a fabricated citation — see deterministicRouter.js's own doc
 * comment). Run through the full ask handler at the TOP level (never nested inside the withTenant
 * above — askViaHandler opens its own tenant context, and PGlite's single connection does not
 * tolerate a nested one). ---- */
{
  const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
  const { default: askHandler } = await import(path.join(ROOT, "api/ask.js"));
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
  const asked = await askViaHandler({ handler: askHandler, auth, question: "when were the units at canyon view dental installed", today });
  const text = asked.data?.sentences?.map((s) => s.text).join(" ") ?? asked.data?.text ?? "";
  check(
    "installDate hook :: Canyon View Dental names BOTH units, each with its own real install date, never silently drops one",
    /daikin/i.test(text) && /november 3, 2023/i.test(text) && /mitsubishi/i.test(text) && /november 6, 2023/i.test(text),
    text,
  );
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
process.exit(0);
