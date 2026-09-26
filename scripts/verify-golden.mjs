/**
 * R11: the golden-tenant regression gate.
 *
 * Three things this asserts, none of which any other verify script covers:
 *
 *   1. scripts/golden/build-golden-export.mjs is DETERMINISTIC (same corpus in -> byte-identical
 *      export out, apart from the run's own exportedAt/created_at timestamps) — a builder that
 *      silently depended on Math.random()/Date.now()/object-key iteration order for anything but
 *      a timestamp would make every downstream number in this file (and the committed
 *      scripts/golden/golden-export.json) unreproducible from one CI run to the next.
 *   2. the export CHECKED IN TO THE REPO (scripts/golden/golden-export.json) actually matches
 *      what the current builder produces right now — so a change to build-golden-export.mjs (or
 *      to the underlying test-docs/business corpus) that nobody re-ran the builder for is caught
 *      here instead of silently shipping a stale fixture.
 *   3. the golden tenant's own offline-exam score never regresses below a measured floor: wrong
 *      answers stay within the known, individually-named set (a NEW wrong answer fails this
 *      check; the exam.json/corpus mismatches and unowned-file gaps already identified do not),
 *      the financials category (deliverable #3, "money ≥97%") stays at 0 wrong, and no-model
 *      coverage doesn't quietly shrink.
 *
 * Known, individually-documented gaps this file deliberately does NOT fail on (see the final R11
 * report for the full reasoning on each):
 *   - lookups-0010-*, hvac-tech-0007-canonical, lookups-0084-canonical: need a fix in the UNOWNED
 *     api/_lib/scope.js's parseStreetAddress() (same city/zip-inclusion fix already applied twice
 *     in owned files) — cannot be fixed from inside this codebase slice.
 *   - breadth-content-019: the exam oracle's own "ice " (trailing space) pattern coincidentally
 *     substring-matches "invoice " in nearly every invoice; replicating that in production HVAC
 *     term synonyms would hurt real freeze-up detection, so deliberately not chased.
 *   - breadth-content-028: needs a standalone "filter change" phrase alternative with no verb-
 *     proximity requirement, structurally different from buildProximityPattern; deferred as too
 *     risky to bolt onto a shared, already-tuned function this late.
 *   - breadth-semantic-001/002/003: the corpus generator's current output contains zero
 *     noise-complaint vocabulary anywhere (confirmed via direct pdftotext scan of every PDF) while
 *     exam.json's frozen ground truth expects 8 specific customers to have it — a generator/exam
 *     version drift, not a bug in any owned module; cannot be fixed without editing the unowned
 *     generator or hard-coding exam customer names (both forbidden).
 *   - breadth-connect-119: needs the same "one fact per named item, not a single count fact on a
 *     zero-result set answer" fix already applied in relations/questions.js, but in the UNOWNED
 *     api/_lib/compose.js instead.
 *
 *   node scripts/verify-golden.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = "3000";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_ESCALATION;
delete process.env.DONOVAN_SONNET_DAILY_USD;

/** Deep-equal after stripping every field known to legitimately vary run-to-run (timestamps only). */
function stripVolatile(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  const VOLATILE_KEYS = new Set(["exportedAt", "created_at", "generatedAt"]);
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (VOLATILE_KEYS.has(k)) delete node[k];
        else walk(node[k]);
      }
    }
  };
  walk(clone);
  return clone;
}

/* ================================================================== 1. determinism */

const BUILDER = path.join(ROOT, "scripts", "golden", "build-golden-export.mjs");
const tmpA = path.join(ROOT, "scripts", "golden", ".verify-tmp-a.json");
const tmpB = path.join(ROOT, "scripts", "golden", ".verify-tmp-b.json");
const COMMITTED_PATH = path.join(ROOT, "scripts", "golden", "golden-export.json");

// The builder's own --skip-gen still needs the actual test-docs/business PDFs on disk (it runs
// pdftotext against every one — see build-golden-export.mjs's pagesForFile) even though it skips
// RE-generating them. Those PDFs are synthesized fixtures, not checked into the repo (regenerated
// on demand by scripts/synth-business.mjs), so a fresh clone or a slimmed-down CI checkout that
// never ran the generator legitimately won't have them yet. That's not a code problem this file
// should fail on — it's a missing-fixture SKIP, and the committed scripts/golden/golden-export.json
// (which IS checked in) is still checked below either way.
const corpusDir = path.join(ROOT, "test-docs", "business");
const hasCorpusPdfs = fs.existsSync(corpusDir) && fs.readdirSync(corpusDir).some((f) => f.endsWith(".pdf"));

let builtOk = false;
let exportA = null;
let exportB = null;

if (!hasCorpusPdfs) {
  console.log(`SKIP  build-golden-export.mjs (test-docs/business PDFs not present in this checkout) — checking the committed export only`);
} else {
  try {
    execFileSync("node", [BUILDER, "--skip-gen", "--out", tmpA], { cwd: ROOT, stdio: "pipe" });
    execFileSync("node", [BUILDER, "--skip-gen", "--out", tmpB], { cwd: ROOT, stdio: "pipe" });
    builtOk = true;
  } catch (err) {
    check("scripts/golden/build-golden-export.mjs runs cleanly (--skip-gen, twice)", false, err?.stderr?.toString?.() ?? String(err));
  }
}

if (builtOk) {
  check("build-golden-export.mjs runs cleanly (--skip-gen, twice)", true);
  exportA = JSON.parse(fs.readFileSync(tmpA, "utf8"));
  exportB = JSON.parse(fs.readFileSync(tmpB, "utf8"));
  check(
    "golden export is deterministic: two independent builds are byte-identical apart from timestamps",
    JSON.stringify(stripVolatile(exportA)) === JSON.stringify(stripVolatile(exportB)),
  );
  check("golden export: documents present (604 expected)", exportA.documents?.length === 604, String(exportA.documents?.length));
  check("golden export: entities present (252 expected)", exportA.entities?.length === 252, String(exportA.entities?.length));
  check("golden export: document_entity_links present (977 expected)", exportA.document_entity_links?.length === 977, String(exportA.document_entity_links?.length));
  check("golden export: financials present (226 expected)", exportA.financials?.length === 226, String(exportA.financials?.length));
}
for (const f of [tmpA, tmpB]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }

/* ================================================================== 2. checked-in fixture matches the builder */

let committed = null;
if (fs.existsSync(COMMITTED_PATH)) {
  committed = JSON.parse(fs.readFileSync(COMMITTED_PATH, "utf8"));
  if (builtOk) {
    check(
      "committed scripts/golden/golden-export.json matches what the current builder produces right now (not stale)",
      JSON.stringify(stripVolatile(committed)) === JSON.stringify(stripVolatile(exportA)),
    );
  } else {
    console.log(`NOTE  skipping the "not stale" comparison (no fresh build to compare against) — the offline-exam section below still runs against this committed file`);
  }
} else {
  check("committed scripts/golden/golden-export.json exists", false, COMMITTED_PATH);
}

// The offline-exam section (below) needs SOME export to load — the fresh build when we have one,
// otherwise the committed file (still a real, meaningful check: it's the artifact CI/a teammate
// would actually load).
const examExport = exportA ?? committed;

/* ================================================================== 3. offline exam floor */

// Individually-named, measured-and-documented gaps (see file header) — a NEW id appearing wrong
// fails this check; the exam shrinking below this set (a gap gets fixed later) also passes, since
// the check is "actual wrong ids subset of this list", not "equal to".
const KNOWN_WRONG_IDS = new Set([
  "lookups-0010-canonical", "lookups-0010-typo", "lookups-0010-abbreviated",
  "hvac-tech-0007-canonical", "lookups-0084-canonical",
  "breadth-content-019", "breadth-content-028",
  "breadth-semantic-001", "breadth-semantic-002", "breadth-semantic-003",
  "breadth-connect-119",
]);

if (examExport) {
  const offline = await import("./offline-exam.mjs");
  const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant, runOfflineExam } = offline;
  const { loadExam } = await import("../api/_lib/scorecard/exam.js");

  const realLog = console.log;
  console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
  const realWarn = console.warn; console.warn = () => {};
  // The offline exam deliberately provokes a mocked "model calls are disabled" error on every
  // question that would otherwise need the agent (that's the whole point of the harness) — this
  // is expected, not a real failure, so it's silenced here exactly as verify-offline-exam.mjs
  // already does for its own run of the same harness.
  const realErr = console.error; console.error = () => {};

  await installPgHarness();
  const modelCounter = await installModelBlock();
  const lite = await createPGlite();
  await setActiveDatabase(lite);

  const exam = loadExam();
  check("test-docs/scorecard/exam.json is present and non-empty", exam.questions.length > 0, String(exam.questions.length));

  if (exam.questions.length) {
    const { ctx } = await loadExportIntoNewTenant(lite, examExport, { tenantKey: "offline:golden-verify", tenantName: "Golden Verify" });
    const today = "2026-09-25";
    const started = Date.now();
    const { perQuestion, overall, byCategory } = await runOfflineExam({ ctx, questions: exam.questions, today, modelCounter });
    const durationMs = Date.now() - started;

    console.log = realLog;
    console.warn = realWarn;
    console.error = realErr;

    const wrong = perQuestion.filter((r) => r.status === "wrong");
    const wrongIds = wrong.map((r) => r.id);
    const newWrong = wrongIds.filter((id) => !KNOWN_WRONG_IDS.has(id));

    check(
      `golden tenant: no NEW wrong instant answers (${wrongIds.length} wrong total, all within the documented set)`,
      newWrong.length === 0,
      `unexpected wrong ids: ${JSON.stringify(newWrong)}`,
    );
    check(
      `golden tenant: overall wrong count has not regressed above the measured floor (got ${overall.wrong}, floor ${KNOWN_WRONG_IDS.size})`,
      overall.wrong <= KNOWN_WRONG_IDS.size,
      JSON.stringify(overall),
    );

    // Deliverable #3: money ≥97%. Zero wrong is the primary bar; the ratio guards against a future
    // change quietly pushing financials answers from "correct" into "needs-model"/"skipped" instead
    // of outright wrong (still a regression in no-model money coverage).
    const fin = byCategory.financials ?? { total: 0, correct: 0, wrong: 0 };
    const finDecidable = fin.correct + fin.wrong;
    check(`financials: 0 wrong (got ${fin.wrong} of ${fin.total})`, fin.wrong === 0, JSON.stringify(fin));
    check(
      `financials: ≥97% correct of decidable-without-model questions (got ${finDecidable ? (fin.correct / finDecidable).toFixed(3) : "n/a"})`,
      finDecidable === 0 || fin.correct / finDecidable >= 0.97,
      JSON.stringify(fin),
    );

    // Coverage floor (deliverable #2) — regressions in no-model coverage fail CI; the floor sits a
    // little below the measured value so ordinary noise doesn't flake this. Round 14 (K3): raised
    // from 300/260 to 520/460 after the deterministic analytics planner (api/_lib/analytics/detPlan.js)
    // moved counts-geo/brand/age/warranty/docs, coverage, data-hygiene, existence, lists, technician
    // and most of time/data-quality off the model entirely (measured 532/474 at the time of this
    // change). Combined with K4 relations/decompose work at integration: measured 582/521 → floor 565/505.
    check(`no-model coverage floor: answeredWithoutModel ≥ 565 (got ${overall.answeredWithoutModel})`, overall.answeredWithoutModel >= 565, JSON.stringify(overall));
    check(`no-model coverage floor: correct ≥ 505 (got ${overall.correct})`, overall.correct >= 505, JSON.stringify(overall));
    check(`fast: full ${exam.questions.length}-question exam finished in under 3 minutes (took ${Math.round(durationMs / 1000)}s)`, durationMs < 180_000, `${durationMs}ms`);

    realLog(`NOTE  golden offline exam: ${JSON.stringify(overall)}`);
  }
} else {
  console.log("SKIP  offline-exam floor checks (no export available: neither a fresh build nor a committed scripts/golden/golden-export.json)");
}

/* ================================================================== static checks */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check("package.json: verify:golden runs this script", pkg.scripts["verify:golden"] === "node scripts/verify-golden.mjs");
  check("package.json: verify:golden is wired into verify:all", /verify:golden\b/.test(pkg.scripts["verify:all"] ?? ""));
}

console.log("");
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
