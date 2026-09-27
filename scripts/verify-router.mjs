#!/usr/bin/env node
/**
 * Round 18 (H3) — precedence tests for api/_lib/router/classifyAll.js.
 *
 * Runs every exam + generalization question (test-docs/scorecard/exam.json,
 * test-docs/scorecard/generalization/*.json — 904 questions as of R18) through classifyAll and asserts:
 *
 *   1. SNAPSHOT PARITY: the chosen winner for every question exactly matches a checked-in snapshot
 *      (scripts/golden/router-precedence-snapshot.json), captured from today's behavior — verified
 *      identical to production by a full offline-exam diff (see this file's own header note below and
 *      the R18 commit message). Any future classifier change that moves a winner fails this test with a
 *      clear per-question diff, by design (r16_d1_pipeline.json D1 #1's whole point: a routing change
 *      should be a reviewed, visible diff, never a silent trial-order accident).
 *   2. MULTI-CLAIM TABLE: every question 2+ classifiers raw-claim is written to a checked-in table
 *      (scripts/golden/router-multi-claimed.json) with the winner and PRECEDENCE_TABLE's own documented
 *      reason for why that winner is correct for that shape — this IS the D1 audit's "314/904 conflict"
 *      finding, made permanent and reviewable instead of re-discovered by a future audit.
 *   3. MONEY SAFETY (D1 #4): every money+relations conflict (a financial-shaped question relations
 *      answers before the money gate ever sees it) is one of the accepted-exception families this file
 *      allowlists below (see handoffs/MONEY_SAFETY_EXCEPTIONS_2026-09-26.md) — a NEW relations family winning a money
 *      conflict fails loudly instead of silently shipping a possible fabricated-$-figure risk.
 *   4. Determinism: classifyAll is pure — calling it twice on the same question yields the same winner.
 *
 * No DB, no network, no model call — same "pure classifier" harness convention as verify-decompose.mjs/
 * verify-analytics.mjs. Snapshot parity is a SEPARATE, stronger guarantee than this script alone: the R18
 * commit diffed a full `node scripts/offline-exam.mjs scripts/golden/golden-export.json` run (real
 * PGlite, the actual /api/ask handler) from before this refactor against after — 904/904 questions
 * identical (status + answer), proving classifyAll reproduces production exactly, not just itself.
 *
 *   node scripts/verify-router.mjs           # check against the snapshot
 *   UPDATE_ROUTER_SNAPSHOT=1 node scripts/verify-router.mjs   # (re)write the snapshot + multi-claim table
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAll, PRECEDENCE_TABLE, TRIAL_ORDER, STAGE_BY_NAME } from "../api/_lib/router/classifyAll.js";
import { classifyMetaQuestion } from "../api/ask.js";
import { getPack } from "../api/_lib/industry/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UPDATE = process.env.UPDATE_ROUTER_SNAPSHOT === "1";

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

/* ============================================================== 1. load every corpus question */

function loadExamQuestions() {
  const exam = JSON.parse(fs.readFileSync(path.join(ROOT, "test-docs/scorecard/exam.json"), "utf8"));
  const out = exam.questions.map((q) => ({ id: q.id, text: q.text, category: q.category, source: "exam" }));
  const genDir = path.join(ROOT, "test-docs/scorecard/generalization");
  for (const f of fs.readdirSync(genDir).filter((f) => f.endsWith(".json"))) {
    const gen = JSON.parse(fs.readFileSync(path.join(genDir, f), "utf8"));
    for (const q of gen.questions) out.push({ id: q.id, text: q.text, category: q.category ?? gen.category, source: f });
  }
  return out;
}

const questions = loadExamQuestions();
check(`loaded corpus questions (exam + generalization)`, questions.length > 0, `got ${questions.length}`);
console.log(`      ${questions.length} questions total`);

/* ============================================================== 2. classify every question, once */

// HVAC pack: every question in this corpus is HVAC-shaped (test-docs/scorecard/exam.json's own document
// types) — same fixed pack verify-decompose.mjs/verify-relations.mjs already use for a pure classify pass.
const HVAC_PACK = getPack("hvac");

async function classifyOne(q) {
  const meta = classifyMetaQuestion(q.text);
  return classifyAll(q.text, { meta, pack: HVAC_PACK });
}

const results = [];
for (const q of questions) {
  let result;
  try {
    result = await classifyOne(q);
  } catch (err) {
    check(`classifyAll does not throw: ${q.id}`, false, err?.stack ?? String(err));
    continue;
  }
  results.push({ q, result });
}
check("classifyAll ran on every question with no exceptions", results.length === questions.length);

/* ============================================================== 3. determinism (pure, no DB/model) */

{
  const sample = questions.slice(0, 40);
  let stable = true;
  for (const q of sample) {
    const a = await classifyOne(q);
    const b = await classifyOne(q);
    if (a.winner?.name !== b.winner?.name) { stable = false; console.log(`      NOT STABLE: ${q.id} (${a.winner?.name} vs ${b.winner?.name})`); }
  }
  check("classifyAll is deterministic (same winner on repeat calls)", stable);
}

/* ============================================================== 4. multi-claim table (checked-in) */

const multiClaimed = results
  .filter(({ result }) => result.claimed.length > 1)
  .map(({ q, result }) => ({
    id: q.id,
    category: q.category,
    text: q.text,
    claimants: result.claimed,
    winner: result.winner?.name ?? null,
    reason: result.winner ? STAGE_BY_NAME.get(result.winner.name)?.reason : null,
  }));

console.log(`      ${multiClaimed.length}/${questions.length} questions are multi-claimed (2+ classifiers raw-claim the same shape)`);
{
  const byPair = new Map();
  for (const m of multiClaimed) {
    const key = [...m.claimants].sort().join("+");
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
  }
  console.log("      by claimant set:", JSON.stringify(Object.fromEntries([...byPair.entries()].sort((a, b) => b[1] - a[1]))));
}

const multiClaimedPath = path.join(ROOT, "scripts/golden/router-multi-claimed.json");
if (UPDATE) {
  fs.writeFileSync(multiClaimedPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: multiClaimed.length, questions: multiClaimed }, null, 2)}\n`);
  console.log(`      wrote ${multiClaimedPath}`);
} else if (fs.existsSync(multiClaimedPath)) {
  const checkedIn = JSON.parse(fs.readFileSync(multiClaimedPath, "utf8"));
  check(
    "multi-claimed table matches the checked-in one (winner + reason, per question)",
    JSON.stringify(checkedIn.questions) === JSON.stringify(multiClaimed),
    "run with UPDATE_ROUTER_SNAPSHOT=1 to refresh after an intentional routing change"
  );
} else {
  check("checked-in multi-claimed table exists", false, `missing ${multiClaimedPath} — run with UPDATE_ROUTER_SNAPSHOT=1 first`);
}

/* ============================================================== 5. snapshot parity (winner per question) */

const snapshotPath = path.join(ROOT, "scripts/golden/router-precedence-snapshot.json");
const snapshot = Object.fromEntries(results.map(({ q, result }) => [q.id, result.winner?.name ?? null]));

if (UPDATE) {
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`      wrote ${snapshotPath}`);
} else if (fs.existsSync(snapshotPath)) {
  const checkedIn = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const diffs = [];
  for (const id of Object.keys(snapshot)) {
    if (checkedIn[id] !== snapshot[id]) diffs.push({ id, before: checkedIn[id], after: snapshot[id] });
  }
  for (const id of Object.keys(checkedIn)) {
    if (!(id in snapshot)) diffs.push({ id, before: checkedIn[id], after: "(question removed)" });
  }
  check(
    `winner matches the checked-in snapshot for all ${Object.keys(snapshot).length} questions`,
    diffs.length === 0,
    diffs.length ? `${diffs.length} winner change(s), e.g. ${JSON.stringify(diffs.slice(0, 5))}` : ""
  );
} else {
  check("checked-in router-precedence snapshot exists", false, `missing ${snapshotPath} — run with UPDATE_ROUTER_SNAPSHOT=1 first`);
}

/* ============================================================== 6. money safety (D1 #3/#4) ------- */

// handoffs/MONEY_SAFETY_EXCEPTIONS_2026-09-26.md: financial-shaped questions relations answers BEFORE the money gate ever
// sees them (money+relations conflicts) — each is a document/customer COUNT, a Yes/No, or a comparison
// derived from real document_financials rows (tenantHasFinancialRows-gated, never a raw $ figure in the
// answer text), so relations answering first is strictly better than the money gate's "not built yet"
// refusal, not a safety regression. Allowlisted by relations family name; a family NOT on this list
// winning a money conflict fails here rather than shipping silently — see relations/questions.js's own
// family names (FAMILIES array) for what each one answers.
const MONEY_SAFE_RELATIONS_FAMILIES = new Set([
  "docTypeDocumentCount", // "how many invoices do we have on file" — a plain document-type count, no $ at all
  "docTypeCustomersSet", "docTypeCustomersCount", // "which/how many customers have an invoice on file"
  "invoiceQuoteMismatchSet", "invoiceQuoteMismatchCount", "invoiceQuoteMismatchYesNo", // Yes/No or a count; totals compared internally, never stated
  "quotedNoInvoiceSet", "quotedNoInvoiceCount", "quotedNoInvoiceYesNo",
  "openInvoiceSet", "openInvoiceCount", // "more than one open invoice" — a count, gated on tenantHasFinancialRows
  "quotedReplacementSet", "quotedReplacementCount", // "quoted a replacement but never got one" — doc-type presence, no $ at all
  "docTypeNoRecentVisit", // "have an invoice but no visit in N months" — doc-type + visit-date presence, no $
  "hasNeverHadDocType", // "invoiced but never signed a <doc type>" — doc-type presence/absence, no $
]);

const moneyRelationsConflicts = results.filter(
  ({ result }) => result.claimed.includes("money") && result.claimed.includes("relations") && result.winner?.name === "relations"
);
console.log(`      ${moneyRelationsConflicts.length} money+relations conflict(s), relations wins every time (0.35 < 0.65)`);
{
  const unexpected = moneyRelationsConflicts.filter(({ result }) => !MONEY_SAFE_RELATIONS_FAMILIES.has(result.raw.relations?.family));
  check(
    "every money+relations conflict's relations family is an accepted, allowlisted money-safety exception",
    unexpected.length === 0,
    unexpected.length
      ? `unrecognized famil${unexpected.length === 1 ? "y" : "ies"}: ${JSON.stringify(unexpected.map(({ q, result }) => ({ id: q.id, family: result.raw.relations?.family })))}`
      : ""
  );
}

// A money+deterministic or money+fastPath conflict is the SAME shape of exception (deterministic/fastPath
// answer with a real, cited value — never a fabricated $ figure) but out of scope for H3 this round (H1
// owns fastPath.js/financials — see ../R18_CONTRACT.md); recorded here for visibility only, never failed.
{
  const other = results.filter(
    ({ result }) => result.claimed.includes("money") && result.winner?.name && result.winner.name !== "money" && result.winner.name !== "relations"
  );
  const byWinner = new Map();
  for (const { result } of other) byWinner.set(result.winner.name, (byWinner.get(result.winner.name) ?? 0) + 1);
  if (byWinner.size) console.log(`      (other money conflicts, out of H3 scope this round: ${JSON.stringify(Object.fromEntries(byWinner))})`);
}

/* ============================================================== 7. PRECEDENCE_TABLE sanity -------- */

check("PRECEDENCE_TABLE has one entry per TRIAL_ORDER stage, in the same order", JSON.stringify(PRECEDENCE_TABLE.map((s) => s.name)) === JSON.stringify(TRIAL_ORDER));
check("every PRECEDENCE_TABLE entry documents a non-empty reason", PRECEDENCE_TABLE.every((s) => typeof s.reason === "string" && s.reason.length > 20));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
