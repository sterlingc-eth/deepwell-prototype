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
 *   - breadth-content-028: FIXED in Round 15 (contentCount.js's REPLACE_STANDALONE_PHRASES) - a
 *     verified, term-scoped "filter change" alternative OR'd in alongside the shared
 *     buildProximityPattern, never changing what any other replaceVerb question matches.
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
// R32 (Team A): the known-wrong set is now EMPTY. Every id that used to live here is either fixed or was an oracle disagreement resolved by an
// owner decision (see test-docs/scorecard/ADJUDICATION.md "R32"): h115/k141 (distinct dated visits), j141-j143 + 21 sibling age oracles (exact-date age),
// the near-miss typo ids (auto-resolve with a visible note, typoResolvesTo). The wrong-count floor is therefore 0: any wrong answer fails.
const KNOWN_WRONG_IDS = new Set([]);

if (examExport) {
  const offline = await import("./offline-exam.mjs");
  const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant, runOfflineExam, loadFullExam } = offline;

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

  const exam = await loadFullExam();
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
    //
    // R21 (L4): breadth-financials-051 (a `rubric` question, category `financials`) was always
    // wrong — it mis-routes to a raw document count instead of quoted/invoiced totals — but was
    // `needs-grader` before this round and so never counted here. It is now graded (keyFacts) and
    // in KNOWN_WRONG_IDS (see that Set's own R21 comment). This bar stays "0 NEW financials wrong"
    // rather than accepting a documented baseline of 1, so any FUTURE financials regression still
    // fails loudly; the one pre-existing, now-visible bug does not.
    const fin = byCategory.financials ?? { total: 0, correct: 0, wrong: 0 };
    const finDecidable = fin.correct + fin.wrong;
    const finNewWrong = wrong.filter((r) => r.category === "financials" && !KNOWN_WRONG_IDS.has(r.id));
    check(`financials: 0 NEW wrong (got ${finNewWrong.length} new of ${fin.wrong} total, ${fin.total})`, finNewWrong.length === 0, JSON.stringify({ finNewWrong: finNewWrong.map((r) => r.id), fin }));
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
    // Round 15 (Team D, content family): new HVAC vocabulary (txv/heat exchanger) and the deterministic
    // job-summary shape (content/jobSummary.js) moved 8 more content questions off needs-model (2 newly
    // correct, 6 to needs-grader) — measured 590/523 → floor raised to 585/520.
    // Round 16 (E1, owner product decision 2026-09-26, see test-docs/scorecard/ADJUDICATION.md): a rare
    // DOWNWARD adjustment, and a deliberate one — not a code regression. 24 exam ids (warranty/
    // manufacturer/tonnage/refrigerant "is the unit at <address> ..." questions) were previously scored
    // "correct" only because their oracle wrongly encoded "always not on file" for an address-resolved
    // unit; the owner's new policy says these SHOULD resolve (single customer+unit -> answer). Measured
    // 664/586 (was 687/609) → floor LOWERED to 660/580 at the time — this corpus's extraction pipeline had
    // no citable manufacturer/tonnage/refrigerant/installation_date row for ANY unit at all yet.
    //
    // Round 16 part 2 (F1): that citation gap is what this round closes. build-golden-export.mjs now parses
    // manufacturer/model/serial_number/installation_date off each document's own printed text wherever it
    // states them (warranty-registration/equipment-record/nameplate-photo's clean labeled lines, invoice/
    // startup-sheet/service-ticket's combined "Equipment: <brand> <model>" line, and an invoice whose own
    // work description literally starts "Install ..." for its own printed date) and stamps each equipment
    // entity's own service_address the same way E2's intake/backfill rule would (customer-single-address) —
    // so a genuine citation now exists for most of those 24 ids (verified: wrong id set unchanged, still
    // only the F2/F4-owned ids documented above, none newly wrong). Measured 778/693 (today=2026-09-25,
    // this file's own fixed date) → floor RAISED to 770/685 (a little below measured, same margin
    // convention as every floor above).
    // R16 integration (F1+F2+F3+F4 + ask.js install-date-extreme hook): measured 817/727, wrong 5 → floor 800/710.
    // R18 (H1): 13 of the 39 needsModel rows converted to deterministic, cited handlers (9 warranty-
    // phrasing shapes — warranty_out/unknown-expiry/ambiguous-name-with-set-listing — in fastPath.js/
    // fastPathQuery.js; 3 financials TIME_STOP fixes in financials/answers.js; 1 analytics
    // missingConditions hasZip/zip fix) plus 4 more (the duplicate-customer/address/serial self-join
    // family — isDuplicateName/sharesAddress/isDuplicateSerial — in analytics.js/detPlan.js/
    // routes/analytics.js), wrong unchanged at 5. Measured 834/744 → floor raised to 820/730 (same
    // margin convention as every floor above).
    //
    // R18 (H2): test-docs/scorecard/generalization/field-phrasing-2.json adds 200 BLIND questions (see
    // KNOWN_WRONG_IDS's own R18 comment above) on top of that base. This is a coverage-widening addition,
    // not a code change to the base categories, so the floor is raised by exactly what the new category
    // itself measures (never by re-deriving the whole number from today's total, which would silently let
    // a REAL base-category regression hide behind the new category's own gain): base 800/710 + this
    // category's own measured 108 answered-without-model / 58 correct (out of 200) → 908/768, a few points
    // below the measured 925/785 combined total, same margin convention as every floor above.
    // R18 integration (H1 + H2 merged): measured 943/803 on 1104 q (wrong 50 = 5 base + 45 blind baseline) → floor 930/790.
    // R18 PART 2 (P4, generalization fixes by shape — see KNOWN_WRONG_IDS's own comment above for what
    // moved and what didn't): measured 942/823, wrong 29 (down from 50, zero new wrong ids anywhere,
    // including the base exam) → floor RAISED to 938/818 (a little below measured, same margin
    // convention as every floor above).
    // R19 (I1: reverse lookups, voice-dictation numerals, multi-unit "list every X", out-of-domain
    // meta-linguistic guard, + audienceFilterSql adopted in fastPath*.js/docLookup.js/scope.js so
    // internal/team-only documents never feed a customer-scoped answer): measured 953/844, wrong 19
    // (down from 29, zero new wrong ids anywhere — see KNOWN_WRONG_IDS's own comment above for exactly
    // which ids moved and the one, h140, that didn't) → floor RAISED to 948/838 (a little below
    // measured, same margin convention as every floor above).
    // R19 (I2, round 19): rankings (h112-h114), yes/no count comparisons (h122, +h117/h118 bonus),
    // g135/h050/h091/h093/h094/h095/h097 (warranty not_expired split), h071 (date-basis fix), h125
    // (negation fix) all newly correct — measured 944/838 (wrong 29 -> 16) → floor raised to 940/834.
    // R19 (I3): test-docs/scorecard/generalization/field-phrasing-3.json adds 200 MORE blind questions
    // (see KNOWN_WRONG_IDS's own R19 comment above) on top of the R18 base. Same convention as every
    // floor raise above: base 938/818 + this category's own measured 92 answered-without-model / 47
    // correct (out of 200) -> 1030/865, a little below the measured 1034/870 combined total (base 746 +
    // field-phrasing 158 + field-phrasing-2 200 + field-phrasing-3 200 = 1304 q), so ordinary noise
    // doesn't flake this - never re-derived from today's raw total, which would silently let a REAL
    // base-category regression hide behind field-phrasing-3's own gain.
    // R19 integration (I1+I2+I3 merged): measured 1068/930 on 1304 q; fixed-by-I1/I2 ids removed from KNOWN_WRONG_IDS → floor 1055/915.
    // R19 (I1 FOLLOW-UP): i119/i137/i191 (new post-merge wrong ids) plus i134/i189/i190 (same
    // "compound" root cause, fixed as the same generalization) all newly correct — measured 1068/936,
    // wrong 47 -> 41 (zero new wrong ids anywhere; h140 stays open, a documented data gap — see
    // KNOWN_WRONG_IDS's own comment above) → floor RAISED to 1063/930 (a little below measured, same
    // margin convention as every floor above).
    //
    // R20 (J3, blind-3 F1/F5 cluster + ask.js gate-miss + nlNormalize): fixed i014 i015 i020 i021
    // i028 i096 i098 i115 i182 i183 at root cause (year-relative install filter, vendor-scoped PO
    // count, hasDocType+hasServiceType AND-drop with no equipment filter, an untracked-concept deny
    // list, and a new warranty-registration-date ranking — see analytics/detPlan.js, routes/
    // analytics.js, analytics.js's own doc comments) — measured 1060/951, wrong 41 -> 18 (zero new
    // wrong ids anywhere). answeredWithoutModel DROPS a little (1068 -> 1060): i096/i098's own fix is
    // exactly the "never guess" rule this file's header describes — a question this codebase has no
    // real data for now correctly falls through to needs-model instead of confidently fabricating a
    // count, so a lower answeredWithoutModel with a lower wrong count and a higher correct count is
    // the intended trade, not a regression. Floor LOWERED on answeredWithoutModel (to a little below
    // this measured 1060) and RAISED on correct (to a little below this measured 951), same margin
    // convention as every floor above.
    // R20 (J2 lookup fixes): i048-i053 + i082 all newly correct (see KNOWN_WRONG_IDS's own R20 comment
    // above) — measured 1068/943, wrong 41 -> 34 (zero new wrong ids anywhere; answeredWithoutModel
    // unchanged since these were already answered without a model, just wrongly) → floor RAISED to
    // 1063/937 (a little below measured, same margin convention as every floor above).
    // INTEGRATION measured 1072/964 on 1304 q (wrong 17) → floor 1064/958.
    // R20 (J4, hook 3, trends.js yields the "this year so far vs all of last year" shape to the
    // engines that already answer it correctly — see KNOWN_WRONG_IDS's own R20 comment above): i013
    // now measures correct (still no-model — the money gate answers it); i003 converts wrong ->
    // needs-model (a measured win per this round's own contract, not a regression) — measured
    // 1071/965, wrong 17 -> 15 → floor RAISED to 1068/962 (a little below measured, same margin
    // convention as every floor above).
    //
    // R21 (L4, rubric grader baseline — see KNOWN_WRONG_IDS's own R21 comment above): 91 previously
    // `needs-grader` rubric questions are now graded (77 via keyFacts, 66 correct / 11 wrong), so
    // `correct` rises by exactly the newly-correct count; `answeredWithoutModel` is unchanged in
    // principle (a needs-grader question already counted toward it) but moves with normal date-
    // dependent variance same as every prior round. Measured 1072/1032, wrong 26 (15 known + 11 new,
    // both added to KNOWN_WRONG_IDS above) → floor RAISED to 1069/1029 (a little below measured, same
    // margin convention as every floor above).
    // R21 (L1): test-docs/scorecard/generalization/field-phrasing-4.json adds 200 MORE blind
    // questions (see KNOWN_WRONG_IDS's own R21 comment above) on top of the R20 base. Same
    // convention as every floor raise above: base 1068/962 + this category's own measured 117
    // answered-without-model / 58 correct (out of 200) -> 1185/1020, a little below the measured
    // 1189/1024 combined total (1504 q total) -- never re-derived from today's raw total, which
    // would silently let a REAL base-category regression hide behind field-phrasing-4's own count.
    // R21 (L2): precision-guard false positive fixed (i002 "how many units did we install last
    // year" — bare "last year" was mis-tagged a superlative, see router/guard/constraints.js's own
    // TIME_WINDOW_PHRASE_RE doc comment) plus a needs-model lookup cluster converted at root cause —
    // fastPath.js's IS_NAME_WARRANTY_RE/DOES_NAME_HAVE_RE lazy-quantifier fix (a filler adverb like
    // "still" between a full name and the trigger phrase was swallowed into the name capture,
    // failing customer resolution) and new contactLookup.js shapes for bare-surname warranty-status/
    // last-visit-by-address-or-surname/"<name> account or job" phrasing — all newly correct
    // (h018/h022/h024/h025/h027/h041/h043/h045/h046/h055/h059/h060/h064/h191/i002/i111/i112/i113;
    // zero new wrong ids anywhere) — measured 1090/984.
    // R21 (L2, same round, fixing a regression the ACCOUNT_JOB_CONNECTOR_RE fallback above surfaced):
    // FIELD_RE.phone's bare-`\bnumber\b` alternative already excluded "serial number" via a negative
    // lookbehind but never excluded "model number" — harmless before this round (the only caller,
    // Shape 1's CONNECTOR_NAME_RE, required its name capture to be the literal end of the string, so
    // "model number for the Bracken job" always failed there and fell through to MODEL_FOR_JOB_RE's
    // own correct handling further down); ACCOUNT_JOB_CONNECTOR_RE has no such end-of-string
    // restriction and started returning early with the wrong field. Closed by excluding "model
    // number" too (verify-lookups-r16.mjs's own "model number for the Bracken job" case). Side
    // effect on this exam: h020 ("model number for zimmerman", an ambiguous-surname `cmp:"set"` row)
    // was previously marked "correct" only because the old, wrongly-detected "phone" field is
    // decline-on-ambiguous, and its honest 2-Zimmerman decline happened to name both customers,
    // satisfying the oracle for the wrong reason; unitModel isn't decline-on-ambiguous and has no
    // bare "model number for <name>" (no "job") shape at all, so this now honestly falls to
    // needs-model instead of accidentally-right — never a wrong id, and the true no-model/correct
    // coverage this fix leaves is 1089/983 → floor RAISED to 1085/980 (a little below the lower of
    // the two measurements this round, same margin convention as every floor above).
    // R21 (L3): serviceVisits entity's ENTITY_SUPPORTED_FIELDS whitelist (routes/analytics.js) was
    // missing 'hasServiceType', so a plan naming a per-visit service_type filter (detectAnalyticsPlan
    // already built it correctly) was always silently dropped by filtersSupported and fell through to
    // the model — added the field's SQL column (buildAnalyticsSQL's serviceVisits branch, analytics.js)
    // and widened the whitelist; i005 ("which tech is racking up the most repair calls") newly
    // correct, no-model — measured 1073/967, wrong unchanged at 15 -> floor RAISED to 1071/965.
    // INTEGRATION measured 1209/1111 on 1504 q (wrong 83) → floor 1201/1105.
    // R21 M2 (round 21 part 2): C1 (22-id multi-constraint AND-drop), 16 of C2's relative-time ids +
    // j064 (quarter comparison) + j072 (bonus), j144/j148/j149 (equipment-age, non-conflicting shapes),
    // i093/i095 (warranty-registration within/majority), h106/i006 (untracked callback), j192/j195
    // (future dates), breadth-financials-051 (quote-vs-invoice mis-route), g103 (already fixed
    // pre-session) all newly correct — measured 1220/1173, wrong 83 -> 32 (zero new wrong ids; j141/
    // j142/j143 stay open, see KNOWN_WRONG_IDS's own R21 M2 comment for why) → floor RAISED to
    // 1215/1165 (a little below measured, same margin convention as every floor above).
    // R21 part-2 integration (M1+M2+M3 + ask.js runDocLookup today hook): pinned-date measured 1220/1183, wrong 22 → floor 1215/1177.
    // R23 (D1): 11 of the 22 known-wrong ids fixed at root cause this round (h140/i195/i188 —
    // formatDateHumanWithIso, compareSet's own ISO-token requirement; the i063/i065/i066/i067/i069/
    // i070/i072 dispatch_history compound-answer gap — LAST_TECH_WHAT_RE + every work_performed row,
    // deterministicRouter.js; j055 — "over the last week" rolling-window reading, analytics.js) —
    // measured 1220/1194, wrong 22 -> 11 (zero new wrong ids; the remaining 11 are documented,
    // deliberate non-fixes — two conflicting-oracle cases (h115, j141-j143) and two oracle-regex-bug
    // cases (breadth-content-019, breadth-semantic-001/002/003) — see KNOWN_WRONG_IDS's own comments)
    // → floor RAISED to 1189 (a little below measured, same margin convention as every floor above).
    // R23 (D1, item 3 cluster C1): "any memos for <name>/<this week>", "what did dispatch
    // broadcast/circulate to the crew/techs", "any internal-only documents at all" — this golden
    // corpus has zero internal-audience documents (same COUNT the field-phrasing-3 i142-i157
    // oracle uses), so these all get one honest, deterministic decline now instead of needing the
    // model — see docLookup.js's isInternalMemoQuestion/countInternalDocuments for the guards
    // against a business's own name colliding with the bare "memo(s)" noun. Measured 1264/1238,
    // wrong unchanged at 11 (zero new wrong ids) → floor RAISED to 1255/1228.
    // R23 (D1, item 4): field-phrasing-5.json (200 new blind questions, +200 to `total`) added 5
    // ids to KNOWN_WRONG_IDS (see that set's own R23 comment) and fixed 3 real bugs it caught along
    // the way, all at root cause: fastPath.js's model_and_serial trigger didn't accept "plus" as a
    // conjunction (k029); "has <name>'s warranty expired yet" matched the DATE-only warranty_expires
    // trigger instead of the yes/no warranty_out one (k067/071/075/079/083); analytics.js's relative-
    // time resolver required digits, so a spelled-out small number ("in the past six months", "in the
    // last two weeks") fell through with NO time filter at all instead of either the intended window
    // or a graceful defer-to-model (k151/k155). Measured 1387/1352, wrong 11 -> 16 (5 new, documented,
    // pre-existing gaps — see KNOWN_WRONG_IDS) → floor RAISED to 1380/1345.
    // R24: distinct-count/list + head-to-head metrics (analytics) and six new no-model families
    // (fastPath/docLookup: possessive-name fix, invoice/PO totals, agreement cost, equipment age,
    // "is there X on file", brand yes/no). Measured 1457/1426, wrong 16 -> 12 → floor RAISED to 1450/1420.
    // R31 (Team A): conversational frame + entity-first slot filling + technician job counts + future-year / off-topic /
    // near-miss honesty + the breadth-content-019/semantic oracle-regex fix. Measured 1524/1496 (incl. live-status declines), wrong 12 -> 8 (zero new wrong
    // ids, zero lost-correct) → floor RAISED to 1515/1488 (a little below measured, same margin convention as above).
    // R35 (owner decisions 2026-10-01 + learning loops: nicknames, serial lookups, "still under warranty" = not expired, document numbers,
    // judgment / false-premise declines, texting shorthand): measured 1596 answered / 1576 correct / 0 wrong / 12 needs-model / 45 clarified
    // (from 1594/1574/0/14) -> floors RAISED to 1594/1574 and needs-model LOWERED to <= 13.
    check(`no-model coverage floor: correct ≥ 1574 (got ${overall.correct})`, overall.correct >= 1574, JSON.stringify(overall));
    check(`no-model coverage floor: answeredWithoutModel ≥ 1594 (got ${overall.answeredWithoutModel})`, overall.answeredWithoutModel >= 1594, JSON.stringify(overall));
    // R32 floors: measured 1572 answered / 1552 correct / 0 wrong / 33 needs-model / 49 clarified (a clarify reply is never counted as correct).
    // R32b (Team A3, loops A-E: page attributes + unknown names + off-domain, per-customer/vendor counts + named comparisons, warranty/date aggregates +
    // tech-never sets, technician pair comparisons, dangling/trivia declines): measured 1594 answered / 1574 correct / 0 wrong / 14 needs-model / 45 clarified
    // (was 1572/1552/0/33 -> 35 in this repo) -> floors RAISED to 1590/1570 and needs-model LOWERED to <= 16.
    check(`R35: needs-model has not risen above 13 (got ${overall.needsModel})`, overall.needsModel <= 13, JSON.stringify(overall));
    check(`R32: wrong stays 0 (got ${overall.wrong})`, overall.wrong === 0, JSON.stringify(overall));
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
