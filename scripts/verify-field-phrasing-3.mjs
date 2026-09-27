#!/usr/bin/env node
/**
 * Round 19 (I3) — verifies the "field-phrasing-3" BLIND generalization exam category end to end:
 *
 *   1. Schema: every question in scripts/gen-field-phrasing-3.mjs's `questions` export passes
 *      api/_lib/scorecard/exam.js's own validQuestions() filter (same gate the real exam loader uses),
 *      covers exactly ids i001..i200 with no gaps or duplicates, and has a valid `cmp`.
 *   2. Checked-in file: test-docs/scorecard/generalization/field-phrasing-3.json matches what the
 *      generator currently produces (catches an edited-in-place drift from a re-run of gen-*.mjs).
 *   3. Oracle correctness: every oracle is run for real against scripts/golden/golden-export.json
 *      through a PGlite tenant (api/_lib/scorecard/oracle.js's runOracle(), the exact function the live
 *      grader calls) — zero oracle-invalid/oracle-error results allowed. This IS the "oracle freshness"
 *      check: an oracle that used to resolve but now errors (a guard subject that stopped existing, a
 *      SQL typo) fails here, not silently at grading time.
 *   4. Wiring: scripts/offline-exam.mjs's loadFullExam() picks up all 200 ids alongside the base
 *      exam.json and every earlier generalization category with no id collisions, and the merged exam's
 *      `category: "field-phrasing-3"` slice has exactly 200 questions.
 *
 * Pure/offline (PGlite, mocked models) — no network, no real DB, no model call, ever.
 *
 *   node scripts/verify-field-phrasing-3.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORY_FILE = path.join(ROOT, "test-docs/scorecard/generalization/field-phrasing-3.json");

let failures = 0;
let count = 0;
const check = (name, ok, detail = "") => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

/* ====================================================================== 1. schema + id coverage */
const { questions, out } = await import(path.join(ROOT, "scripts/gen-field-phrasing-3.mjs"));
const { validQuestions, VALID_CMP } = await import(path.join(ROOT, "api/_lib/scorecard/exam.js"));

check("gen-field-phrasing-3 :: exactly 200 questions built", questions.length === 200, `got ${questions.length}`);

const wantIds = new Set(Array.from({ length: 200 }, (_, i) => `i${String(i + 1).padStart(3, "0")}`));
const gotIds = new Set(questions.map((q) => q.id));
const missing = [...wantIds].filter((id) => !gotIds.has(id));
const extra = [...gotIds].filter((id) => !wantIds.has(id));
check("gen-field-phrasing-3 :: ids cover i001..i200 with no gaps", missing.length === 0 && extra.length === 0, `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);

const validated = validQuestions(questions);
check("gen-field-phrasing-3 :: every question passes exam.js's own validQuestions() gate", validated.length === questions.length, `${validated.length}/${questions.length} passed; dropped ids: ${JSON.stringify(questions.filter((q) => !validated.some((v) => v.id === q.id)).map((q) => q.id))}`);

const badCmp = questions.filter((q) => !VALID_CMP.has(q.cmp));
check("gen-field-phrasing-3 :: every cmp is a VALID_CMP value", badCmp.length === 0, JSON.stringify(badCmp.map((q) => ({ id: q.id, cmp: q.cmp }))));

check('gen-field-phrasing-3 :: category is "field-phrasing-3" on every question', questions.every((q) => q.category === "field-phrasing-3"), JSON.stringify(questions.filter((q) => q.category !== "field-phrasing-3").map((q) => q.id)));

const textCounts = {};
for (const q of questions) textCounts[q.text] = (textCounts[q.text] ?? 0) + 1;
const dupTexts = Object.entries(textCounts).filter(([, n]) => n > 1);
check("gen-field-phrasing-3 :: no duplicate question text within this file", dupTexts.length === 0, JSON.stringify(dupTexts));

/* ====================================================================== 2. checked-in file matches generator */
let checkedIn = null;
try {
  checkedIn = JSON.parse(fs.readFileSync(CATEGORY_FILE, "utf8"));
} catch (err) {
  check("checked-in file :: test-docs/scorecard/generalization/field-phrasing-3.json exists and parses", false, err?.message);
}
if (checkedIn) {
  check("checked-in file :: matches gen-field-phrasing-3.mjs's current output (not stale)", JSON.stringify(checkedIn) === JSON.stringify(out), "run `node scripts/gen-field-phrasing-3.mjs` to refresh it");
}

/* ====================================================================== 3. oracle correctness + freshness against the golden tenant */
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant, loadFullExam } = offline;
const { withTenant } = await import(path.join(ROOT, "api/_lib/recordsStore.js"));
const { runOracle } = await import(path.join(ROOT, "api/_lib/scorecard/oracle.js"));

await installPgHarness();
await installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "verify-field-phrasing-3", tenantName: "Verify Field Phrasing 3" });

const today = "2026-09-26";
let oracleErrors = 0;
let skipped = 0;
const errorRows = [];
for (const q of questions) {
  const r = await runOracle(withTenant, ctx, q, { today });
  if (!r.ok) {
    oracleErrors++;
    errorRows.push({ id: q.id, error: r.error });
  } else if (r.skip) {
    skipped++;
  }
}
check("oracles :: every oracle runs without error against the golden tenant (freshness)", oracleErrors === 0, JSON.stringify(errorRows));
console.log(`NOTE  oracle freshness: ${questions.length - oracleErrors} runnable, ${skipped} gracefully skipped (subject/data guard), ${oracleErrors} errored`);

/* ====================================================================== 4. offline-exam.mjs wiring */
const merged = await loadFullExam();
const fp3FromMerge = merged.questions.filter((q) => q.category === "field-phrasing-3");
check("offline-exam.mjs :: loadFullExam() merges in exactly 200 field-phrasing-3 questions", fp3FromMerge.length === 200, `got ${fp3FromMerge.length}`);

const fp2FromMerge = merged.questions.filter((q) => q.category === "field-phrasing-2");
check("offline-exam.mjs :: the earlier 200 field-phrasing-2 questions are still merged in alongside field-phrasing-3", fp2FromMerge.length === 200, `got ${fp2FromMerge.length}`);

const fpFromMerge = merged.questions.filter((q) => q.category === "field-phrasing");
check("offline-exam.mjs :: the original 158 field-phrasing questions are still merged in", fpFromMerge.length === 158, `got ${fpFromMerge.length}`);

const allIds = merged.questions.map((q) => q.id);
const dupIds = allIds.filter((id, i) => allIds.indexOf(id) !== i);
check("offline-exam.mjs :: merged exam has no duplicate question ids across exam.json + every generalization file", dupIds.length === 0, JSON.stringify([...new Set(dupIds)]));

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s).`);
  process.exit(1);
}
process.exit(0);
