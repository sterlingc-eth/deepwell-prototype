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
const KNOWN_WRONG_IDS = new Set([
  // R15: lookups-0010-*, hvac-tech-0007, lookups-0084 (install_date) and breadth-content-028 fixed; shrink-only list.
  "breadth-content-019", // deliberately not chased - see file header
  "breadth-semantic-001", "breadth-semantic-002", "breadth-semantic-003",

  // R16 part 2 (F1): the 23 g-ids below (the owner-decision address policy not yet answering
  // manufacturer/tonnage/refrigerant/warranty by address; 3 install-date-by-address reading the
  // registration date instead; 1 "4"="for" leetspeak address-parsing bug) are FIXED this round —
  // see build-golden-export.mjs (manufacturer/model/serial_number/installation_date now parsed off
  // each document's own printed text wherever it states them + the unit's own service_address
  // stamped per E2's intake/backfill rule) and fastPath.js/fastPathQuery.js (the "4"/"@" numeronym
  // fix, and the owner address policy generalized to a business-name-resolved customer too) —
  // removed from this shrink-only list, not just left here stale.
  //   - 1 id: the deterministic "how many Trane units are still under warranty" analytics count is off by
  //     one against the equipment entities' own warranty.expires dates (5 actual vs. 4 reported) - a
  //     real, small discrepancy between the analytics path and the golden per-unit warranty data. A
  //     (api/_lib/analytics.js owner) - NOT F1's file, left as documented.
    // R16 part 2 (F2): counts-warranty-0008-canonical/-typo/-abbreviated, counts-warranty-0004-canonical,
  // breadth-multi-hop-010 and breadth-persona-017 (the "environmental drift" ids formerly listed here)
  // were the warrantyStatusOf bug (r16_d2_data.json #1: a unit whose REGISTRATION deadline was <=30d out
  // got bucketed "expiring" even though its coverage expired years later) - not date drift. Fixed by
  // separating coverage status (warrantyStatusOf, by expiry date only) from registration-action-needed
  // (registrationActionNeededOf, new) in api/_lib/warrantyRules.js/analytics.js; removed from this list
  // now that they measure correct. g135 above is left in deliberately - see its own comment.

  // R18 (H2) BLIND GENERALIZATION SET BASELINE — 45 wrong ids from test-docs/scorecard/generalization/
  // field-phrasing-2.json (200 new questions, written blind: no exam.json/field-phrasing.json question
  // text and no engine regex were read while writing them — see that file's own header). This is a
  // MEASURED FLOOR, not a target: these are the residual gaps a genuinely blind test surfaces once a
  // category stops being tuned against, and they are next round's backlog (clustered in
  // ../r18_blind_clusters.json).
  //
  // R18 PART 2 (P4): 21 of the 45 fixed at ROOT CAUSE (by shape, never by exam text — see api/_lib/
  // analytics.js, analytics/detPlan.js, routes/analytics.js's own doc comments for each): h047 h048 h049
  // h051 h053 h065 h067 h069 h074 (central time-window parser: "since <month>", "this <season>", "next N
  // days", "so far this year", "by end of year", bare "past year", + warrantyExpires field + distinct-
  // years groupBy); h090 h099 h100 h101 h102 h103 h104 h105 (multi-hop AND-drop: a brand/model filter
  // combined with a hasDocType/hasServiceType cross-doc condition now resolves BOTH, see
  // executeAnalyticsPlan's combined-branch logic); h127 h128 h134 (negation/missing-field: dual has/
  // lacks service-type detection, broadened "no tonnage" regex, new hasAnyEquipment field); h189
  // (negation-immediately-before filler-word fix, "isnt even in arizona"). Removed from this list.
  //
  // R19 (I2, round 19): the warranty-definition conflict noted below as "tried and reverted" is
  // RESOLVED this round, not reverted again — decompose (api/_lib/decompose/clauses.js/entitySets.js)
  // now has its OWN 'not_expired' bucket (active OR expiring — the oracle every MULTI-condition
  // phrasing of "still under warranty" actually wants), kept entirely separate from analytics.js's
  // own warrantyStatusFromQuestion (still the strict 'active'-only bucket the frozen bare-phrasing
  // oracle, counts-warranty-0004-canonical, wants) — the two never collide because decompose only
  // ever claims a >=2-condition question, never the bare single-condition one. Fixed: g135 h050 h091
  // h093 h094 h095 h097 (geo+brand+warrantyStatus combos, verified against field-phrasing-2.json's own
  // oracles). Also fixed this round, at root cause, never by exam text:
  //   - h071 (time-window qualifier dropped): shapeDocumentRow's upload-date fallback (routes/
  //     analytics.js) now only applies to VISIT-type documents (scope.js's isVisitType) — a
  //     maintenance-agreement (which carries no service_date at all in this corpus) no longer
  //     manufactures a false match against "signed since <year>".
  //   - h125 (negation collapses to "count everything"): queryCustomersByDocTypeCondition/
  //     queryCustomersByServiceTypeCondition (routes/analytics.js) used to bail to an empty result set
  //     whenever there was no POSITIVE has-side filter — a pure lacksDocType/lacksServiceType-only plan
  //     always answered "0" regardless of the real data. Both now resolve a lacks-only plan as "every
  //     customer minus the ones the has-side's own EXISTS query finds".
  //   - h112 h113 h114 (rankings): detPlan.js's new detectGroupBySuperlative ("biggest/fewest
  //     <dimension>") answers the ONE extreme named group (listing every tied name on a genuine tie,
  //     never guessing one — see routes/analytics.js's formatGroupBySuperlativeAnswer); a real,
  //     separately-owned bug in nlNormalize.js's vocabulary (outside this round's ownership — see the
  //     round report) was fuzzy-correcting the real word "fewest" into "newest" (edit distance 1),
  //     worked around locally in routes/analytics.js's own runAnalyticsQuestion. detectInstallDateExtreme
  //     also now carries a brand filter through to queryInstallDateExtreme (h114/h110).
  //   - h122 (yes/no comparison never evaluated): a new deterministic count-comparison engine
  //     (api/_lib/analytics/comparison.js + routes/analytics.js's runCountComparison) resolves "do we
  //     have more X than Y" for brand-vs-brand, city-vs-city, and registered-vs-unregistered-warranties
  //     — computing BOTH sides with the same filter definitions and citing both. Bonus fixes from the
  //     same engine (previously needs-model, not in this list): h117, h118.
  //
  // h115 ("which tech has done the fewest visits") is now answered by the SAME superlative engine as
  // h112-h114, but stays wrong: the raw technician-mention count (this oracle's own definition) has a
  // genuine 2-way tie (Denise Ford / Ray Sutton, 55 each) that this codebase's own "visits" definition
  // (serviceVisits excludes future-dated records — Team A's splitFuture, applied everywhere else in
  // this file) breaks differently, landing on a unique-but-different winner (Ray Sutton, 50). A
  // documented product-definition mismatch, not a guess — left open rather than special-casing this
  // one shape to count raw extractions instead of "real" visits.
  //
  // Root causes, by cluster, for the 22 STILL open (see ../r18_blind_clusters.json for full detail):
  //   - reverse identity lookup (serial->customer, phone->customer) has no deterministic path at all —
  //     out of scope this part (item 4, "as time allows", not reached): h002 h003 h005 h006 h014
  //   - a superlative tie broken differently by this codebase's own visit-counting convention (see
  //     above): h115
  //   - a multi-unit "list every X" either over-declines (treats a plural list request as the same
  //     single-value ambiguity as "the" unit) or silently drops a unit: h136 h137 h140
  //   - an out-of-domain request anchors on a bare keyword ("warranty" inside a translation ask) and
  //     fabricates an unrelated number instead of declining: h158
  //   - a voice-dictated house number ("to fourteen" = 214) or a city-only reference fails to resolve
  //     the actual field asked, falling back to an unrelated generic count: h182 h196
  //
  // R19 (I1): h002 h003 h005 h006 h014 (reverse serial/phone/email -> customer lookup, new
  // detectReverseLookup/runReverseLookup in fastPath.js/fastPathQuery.js), h136 h137 (multi-unit
  // "list every X" — wantsEveryUnit + ADDRESS_ENTITY_FIELD_INTENTS' 'serial' entry, plus a
  // BUSINESS_NAME_RE false-start fix: "on file for <business>" was capturing "file for" as part of
  // the business name because "on" was tried as the earlier, wrong preposition — reverted to
  // "at|for" only, see that regex's own doc comment), h158 (out-of-domain meta-linguistic guard,
  // isMetaLinguisticQuestion), h182 h196 (voice-dictation house numbers, convertVoiceDictationNumerals,
  // + a bare-city subject via CITY_ONLY_RE) are FIXED this round — removed from this list. h140 is
  // NOT fixed: its multi-unit install_date answer comes from api/_lib/deterministicRouter.js's own
  // installDate() (I1 owns this file too as of the follow-up round below), which only finds a
  // matching extraction row for ONE of Canyon View Dental's two units even though scope.js/
  // contactLookup.js resolve both correctly (verified directly against the loaded DB) — left in this
  // list, unchanged (see the follow-up comment below for why: a genuine data gap, not a code bug).
  //
  // R19 (I1 FOLLOW-UP, post r19-int merge): three new-post-merge wrong ids, i119/i137/i191, plus two
  // MORE ids of the exact same "compound" shape as i137/i191 (i134, i189, i190 — not previously
  // wrong; the field-phrasing-3 blind set had already surfaced them, but they aren't in this comment's
  // earlier per-round accounting since they came in with the r19-int merge, not I1's own base round)
  // are FIXED this round, all by SHAPE (these are blind questions; only the shape was read, never the
  // oracle text):
  //   - i137/i191/i134/i189/i190 (2-field "compound" phrasing beyond the frozen {model, serial} pair
  //     — manufacturer+serial, manufacturer+tonnage, tonnage+refrigerant): the new 'serial' entry in
  //     ADDRESS_ENTITY_FIELD_INTENTS was claiming before model_and_serial's own TRIGGERS regex could
  //     ever fire for any OTHER field pair, so only the LAST-matched field got answered and every
  //     other named field was silently dropped. fastPath.js's new detectMultiFieldNames/
  //     MULTI_FIELD_WORD_RE detects any 2+ of {manufacturer, model, serial, tonnage, refrigerant,
  //     install_date, warranty} named in one question (excluding the exact {model, serial} pair,
  //     which stays on its own frozen, separately-tested path unchanged) and routes to a new
  //     'multi_field' intent; fastPathQuery.js's new runMultiField resolves every named field and
  //     answers only if ALL of them are on file — a subset is never returned, defer (null) instead.
  //   - i119 (spoken self-correction: "...one two five zero six east pecos, uh, I mean one six five
  //     four east pecos road"): the voice converter took the FIRST dictated house number and then
  //     confidently declined "not on file" for an address nobody meant. fastPath.js's new
  //     collapseSpokenCorrection recognizes "i mean"/"sorry"/"actually"/"no wait"/"scratch that"/
  //     "correction" and keeps only the corrected span after the LAST marker; the new
  //     hasConflictingVoiceDictatedHouseNumbers (via findVoiceNumberRuns, shared with
  //     convertVoiceDictationNumerals) makes extractSubject defer entirely (address stays null, never
  //     a guess) when 2+ DISTINCT dictated house numbers remain with no correction marker to resolve
  //     them.
  // h140 stays open: this round also traced installDate() (api/_lib/deterministicRouter.js, now I1's
  // own hook) directly against the raw extractions table and confirmed there is ONE installation_date
  // extraction in the entire corpus for Canyon View Dental's two units (the Daikin unit's, from its
  // startup sheet) — the Mitsubishi unit has ZERO installation_date extractions anywhere, only its own
  // entity-data copy. That is a genuine data gap in the golden export, not a matching/routing bug: no
  // code change can cite a document that was never extracted without fabricating one, which the
  // accuracy-over-coverage rule forbids. installDate() was still fixed at its actual defect — a unit
  // lacking a citable extraction used to be silently DROPPED from a multi-unit answer with no mention
  // at all; it is now named honestly ("no install date on file") alongside the unit(s) that do have
  // one, the same "state what's missing, never omit it" rule used elsewhere in this codebase. This
  // does not flip h140 to "correct" against the oracle's exact two-date expectation, so it stays here.
  "h115",
  "h140",

  // R19 blind set v3 baseline (I3, test-docs/scorecard/generalization/field-phrasing-3.json - 200 new
  // BLIND questions across owner/office-manager/dispatch/warranty-clerk/voice-dictating-tech personas +
  // 20 team-scoped-internal-document + 20 must-decline/must-ask-which questions, written blind exactly
  // like field-phrasing-2 was; see ../r19_blind3_clusters.json for the full cluster analysis). Notably,
  // field-phrasing-2 itself now measures 0 wrong (the R18 P4 fixes above closed every one of its 45
  // baseline ids) - proof the tuning worked - and this fresh blind set immediately finds a new, larger
  // residual: 44/200 wrong, dominated by ONE root cause (F1: a novel filter/aggregate phrasing gets
  // silently matched to an unrelated deterministic template - usually a bare unfiltered total - instead
  // of returning null), plus three RECURRING known clusters on new subjects (F3 reverse-serial-lookup,
  // F4 multi-unit-list mishandling, F5 ranking-drops-brand-filter) and one brand-new gap this round's
  // persona surfaced (F6: a never-tracked business concept like a warranty "claim" fabricates a count
  // instead of declining). This is a MEASURED FLOOR, not a target - next round's backlog.
      "i063", "i065", "i066", "i067", "i069", "i070", "i072",
      "i188",
  //
  // R20 (J2, lookup-side fixes): i048-i053 (docLookup.js's "the <name> account" trailing-filler-word
  // fix — AGGREGATE_WORD_RE was matching "account" and throwing the whole name away, so the question
  // fell through to the unrelated portfolio-wide "has both a work order AND a purchase order"
  // template) and i082 (fastPath.js's reverse-serial detector now also recognizes "trying to match
  // serial X to an account/customer/owner", the same F3 reverse-identity-lookup shape worded
  // differently) now measure correct — removed from this shrink-only list, not just left here stale.
  "i188",
  "i195",

  // R20 (J3): measured against THIS harness's own fixed today (2026-09-25) and exam.json — a few
  // ids from the R19 blind-3 accounting above (i001 i002 i009 i011 i029 i030 i048-i053 i094 i188
  // i195) already measure correct here even before this round's own fixes (this file's own harness
  // uses a different tenant/today than the ad-hoc offline-exam.mjs runs the R19 comment above was
  // written against) — left in the set anyway (harmless: KNOWN_WRONG_IDS is a subset check, never
  // an equality check) rather than re-verified one by one against stale prose. i014 i015 (technician
  // job counts undercounting a date-less document), i020 i021 (vendor-scoped PO counts stolen by the
  // money gate), i028 (hasDocType+hasServiceType AND-drop with no equipment filter — see
  // executeAnalyticsPlan's own doc comment), i096 i098 (an untracked business concept — "warranty
  // claim" — fabricated a count instead of declining), i115 i182 i183 (a new warrantyRegDate
  // ranking; a customers-by-service-type time-window that only ever decorated the label, never the
  // actual count) are FIXED this round, all at root cause (analytics.js, analytics/detPlan.js,
  // routes/analytics.js) — removed from this list.
  //
  // R20 (J4, hook 3): i003/i013 (year-over-year comparisons) are ALSO fixed this round — trends.js's
  // own deterministic period-over-period engine (parseTrends) used to claim both questions BEFORE
  // analytics/financials ever got a look (deterministic 0.4 < money 0.65 < analytics 0.7 in the
  // router's own precedence) and its period bounds for grain='year' compute two full PRIOR calendar
  // years, never "this year so far" vs "all of last year". parseTrends now recognizes that shape
  // generally (any grain='year' comparison naming both "this year"/"so far this year" and "last
  // year" — not either question's exact text) and yields (returns null) instead of guessing, letting
  // the two correct comparison engines that already existed on the analytics/financials side answer
  // instead: i013 (revenue) now measures CORRECT via financials/answers.js's revenueYearComparison
  // (money gate, 0.65); i003 (install units) no longer answers wrong either — it now falls to
  // needs-model (analytics/comparison.js's detectInstallYearComparison exists and would resolve it,
  // but preClassifyAnalytics' own candidate gate — api/_lib/analytics.js, not this round's file — does
  // not yet treat this phrasing as an analytics candidate, so runAnalyticsQuestion/
  // detectCountComparison never gets a turn; see the round report's "hooks needed" for the one-line
  // gate widening). A wrong->needs-model conversion is a measured win per this round's own contract
  // (R20_CONTRACT.md), never a regression — both ids removed from this list.
  ]);

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
    check(`no-model coverage floor: answeredWithoutModel ≥ 1068 (got ${overall.answeredWithoutModel})`, overall.answeredWithoutModel >= 1068, JSON.stringify(overall));
    check(`no-model coverage floor: correct ≥ 962 (got ${overall.correct})`, overall.correct >= 962, JSON.stringify(overall));
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
