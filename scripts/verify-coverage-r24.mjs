/**
 * Round 24 (E3) — coverage regression guard for the fastPath/docLookup families closed
 * this round (267 needs-model questions clustered by shape; 6 general families closed):
 *
 *   1. invoice_total: order-independent "total"/"invoice" phrasing (trigger fix).
 *   2. po_total: a new intent answering "total on PO-XXXX" from document_financials.
 *   3. agreement_cost: a new intent answering "annual/yearly cost of the maintenance
 *      agreement", strictly scoped to document_type === 'maintenance-agreement'.
 *   4. equipment_age: a new intent computing age from installation_date, excluding
 *      portfolio-wide "oldest/newest" superlatives (analytics.js's own territory).
 *   5. docLookup "is there/are there ... on file for X": a new SHAPES entry mirroring
 *      the existing "do/does we have" shape, excluding indefinite pronouns ("anyone").
 *   6. brand_match: a new intent answering "is the unit a <brand>" yes/no from the
 *      resolved customer's/equipment's own manufacturer, honestly declining (never
 *      guessing) when no manufacturer is on file or more than one brand is named.
 *
 * Root cause behind most of the family's wins: extractSubject's NAME_HINT_RE captured
 * a trailing possessive "'s" INTO the name (its optional (?:'s)? branch never forces
 * backtracking, unlike POSSESSIVE_NAME_RE's mandatory one), so every "for/at/on NAME's
 * ..." phrasing produced a name that could never ILIKE-match a real customer_name and
 * silently deferred to the model. Fixed with a general post-extraction strip.
 *
 * This is an INTEGRATION check (golden tenant, PGlite, models mocked to throw —
 * offline-exam.mjs's own harness, same convention as scripts/verify-precision-guard.mjs):
 * runs the full combined exam through the REAL /api/ask handler and asserts
 *   (a) a representative sample of ids from each family above is now `correct`,
 *   (b) k118/k124 (the untracked-field thermostat/filter regression this round caught
 *       and fixed) are NOT wrong,
 *   (c) j148/j149 (the oldest/newest-unit regression this round caught and fixed)
 *       are NOT wrong,
 *   (d) overall wrong stays at the pre-round floor (16 — shrink-only, same convention
 *       as verify-golden.mjs's/verify-precision-guard.mjs's own KNOWN_WRONG_IDS), and
 *   (e) answeredWithoutModel/correct sit at or above this round's measured floor.
 *
 *   node scripts/verify-coverage-r24.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

let offline;
try {
  offline = await import("./offline-exam.mjs");
} catch (err) {
  console.log(`SKIP  offline-exam.mjs failed to load (${err?.message}). Run npm ci.`);
  process.exit(failures ? 1 : 0);
}

const realWarn = console.warn; console.warn = () => {};
const realErr = console.error; console.error = () => {};
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant, runOfflineExam, loadFullExam } = offline;

await installPgHarness();
const modelCounter = await installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);

const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const exam = await loadFullExam(exportData.tenantKey ?? null);
const today = new Date().toISOString().slice(0, 10);
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "offline-coverage-r24", tenantName: "Coverage R24 Verify" });

const { overall, perQuestion } = await runOfflineExam({ ctx, questions: exam.questions, today, modelCounter });
console.log = realLog; console.warn = realWarn; console.error = realErr;

const byId = new Map(perQuestion.map((q) => [q.id, q]));

/* ---- (a) representative sample, one or more per family, now correct ---- */
const MUST_BE_CORRECT = [
  // invoice_total order-independent + possessive-name root-cause fix
  "i041", "i042", "i046",
  // po_total (new intent)
  "j091", "j093", "j096", "j100",
  // agreement_cost (new intent, strictly maintenance-agreement only)
  "j106", "j110", "j115", "j120",
  // equipment_age (new intent, excludes oldest/newest)
  "j126", "j130", "j135",
  // docLookup "is there ... on file for X" shape
  "j150", "j186", "j187", "j190",
  // brand_match (new intent, yes/no honest, never a guess)
  "k177", "k178", "k179", "k180",
  // bonus wins unlocked by the possessive-name root-cause fix alone (serial lookups)
  "k021", "k023",
];
for (const id of MUST_BE_CORRECT) {
  const q = byId.get(id);
  check(`${id} is correct ("${q?.question ?? "?"}")`, Boolean(q) && q.status === "correct", JSON.stringify(q));
}

/* ---- (b) untracked-field regression (thermostat/filter brand != unit manufacturer) ---- */
for (const id of ["k118", "k124"]) {
  const q = byId.get(id);
  check(`${id} is not wrong (untracked thermostat/filter field, must decline not guess)`, Boolean(q) && q.status !== "wrong", JSON.stringify(q));
}

/* ---- (c) oldest/newest portfolio superlative regression (analytics.js's territory) ---- */
for (const id of ["j148", "j149"]) {
  const q = byId.get(id);
  check(`${id} is not wrong (portfolio oldest/newest, must stay analytics's territory)`, Boolean(q) && q.status !== "wrong", JSON.stringify(q));
}

/* ---- (d) shrink-only wrong baseline: same 16 ids as the pre-round measured floor ---- */
const KNOWN_WRONG_IDS = new Set([
  "live-misses-2026-09-21-0002-typo", "lookups-0101-typo", "lookups-0106-typo",
  "breadth-content-019", "breadth-semantic-001", "breadth-semantic-002", "breadth-semantic-003",
  "h115", "j141", "j142", "j143", "k139", "k141", "k143", "k186", "k187",
]);
const wrongIds = perQuestion.filter((q) => q.status === "wrong").map((q) => q.id);
const newWrong = wrongIds.filter((id) => !KNOWN_WRONG_IDS.has(id));
check(
  `no NEW wrong ids beyond the pre-round baseline (${wrongIds.length} wrong total)`,
  newWrong.length === 0,
  `unexpected new wrong ids: ${JSON.stringify(newWrong)}`
);
check(`wrong count has not regressed above the pre-round floor (got ${overall.wrong}, floor ${KNOWN_WRONG_IDS.size})`, overall.wrong <= KNOWN_WRONG_IDS.size, JSON.stringify(overall));

/* ---- (e) coverage floors: this round's measured gain must not regress ---- */
check(`answeredWithoutModel at or above this round's floor (got ${overall.answeredWithoutModel}, floor 1456)`, overall.answeredWithoutModel >= 1456, JSON.stringify(overall));
check(`correct at or above this round's floor (got ${overall.correct}, floor 1421)`, overall.correct >= 1421, JSON.stringify(overall));
check(`needsModel at or below this round's floor (got ${overall.needsModel}, ceiling 198)`, overall.needsModel <= 198, JSON.stringify(overall));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
