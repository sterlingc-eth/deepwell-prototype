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
  // R31: breadth-content-019 and breadth-semantic-001/002/003 REMOVED — the exam oracle's unanchored regexes were fixed at
  // their source (test-docs/scorecard/breadth.mjs: "ice " -> \yice\y, "loud" -> \yloud); see ADJUDICATION.md "R31".
  // R23 (D1): re-verified breadth-content-019 and, this round, breadth-semantic-001/002/003 directly
  // against scripts/golden/golden-export.json's own document_pages.text (not just the exam's stated
  // expected count) — both are the SAME class of bug, in the EXAM'S oracle regex, not this codebase:
  // breadth-content-019's oracle pattern is `(frozen|freez|iced|ice )` with a bare, word-boundary-
  // free "ice " alternative, which matches the literal substring "ice " inside "Serv-ice Address:" —
  // present on nearly every document in this corpus — inflating its expected 317 from what is
  // actually 0 genuine freeze-up mentions in this fixture. breadth-semantic-001/002/003's oracle
  // pattern `(noise|noisy|loud|rattl|vibrat|humming|buzz|squeal|grind)` has the identical bug in its
  // bare "loud" alternative, which matches "icloud.com" inside literally every customer's own email
  // address on file (verified: every one of the 13 oracle-side "hits" in this fixture is an
  // "...@icloud.com" line, zero are a real noise complaint) — inflating its expected 8 customers from
  // what is actually zero genuine noise/rattle/vibration mentions here. This codebase's own
  // HVAC_TERM_SYNONYMS (contentCount.js) deliberately excludes bare "ice "/"loud" as un-anchored
  // substrings for exactly this reason (word-boundary-anchored `\y...\y` matching, see
  // buildTermPattern) — replicating the oracle's own unanchored pattern would fix these 4 measured
  // ids at the cost of a real production regression (every icloud.com customer would be reported as
  // having complained of a loud unit; every invoice/service-address line would count as a freeze-up)
  // far worse than 4 wrong ids, so left as a documented, deliberate non-fix, same as R18's original
  // breadth-content-019 call — never chased by loosening the word-boundary guard.

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
  // + a bare-city subject via CITY_ONLY_RE) are FIXED this round — removed from this list. h140 stays
  // (see the follow-up comment below: its underlying ROUTING/data-fabrication bug was fixed this
  // round, but a separate, un-owned grader-format mismatch keeps it measuring wrong regardless).
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
  // h140: its ROUTING/fabrication-guard bug is FIXED this round (M1, same pass as the L4 rubric g105
  // fix below) — installDate() (api/_lib/deterministicRouter.js) used to require a per-document
  // installation_date extraction row (`src`) before a unit's own data.installation_date could be
  // stated at all, reasoned as guarding against citing a document that was never actually extracted.
  // But the entity's own record is itself a real, citable source (scopeUnitRecords already includes
  // every unit in the answer's `records`, extraction-backed or not) — stating what it genuinely
  // carries is not a fabrication, only inventing a document citation for it would be. installDate()
  // now states the date whenever `date` is truthy regardless of `src` (uncited to a document when
  // `src` is absent, exactly fastPathQuery.js's own unitFieldFact "own-value fallback" convention for
  // this identical situation) — verified directly: both of Canyon View Dental's dates (Mitsubishi
  // 2023-11-06, Daikin 2023-11-03) are now correctly REPORTED, in the same human-readable format
  // ("installed November 6, 2023") every other install-date answer in this codebase uses.
  // R23 (D1): h140's second, independent reason (compareSet/itemPresent needing the RAW ISO date
  // token, never just a human "November 6, 2023") is FIXED this round WITHOUT touching the grader —
  // formatDateHumanWithIso (fastPath.js) appends the literal ISO form in parens ("November 6, 2023
  // (2023-11-06)") at exactly the two call sites that feed a `set`-graded date list
  // (deterministicRouter.js's installDate multi-unit branch, fastPathQuery.js's unitFieldFact/
  // runMultiField) — additive only, every other formatDateHuman caller (single-value answers already
  // satisfied by compareValue's own date-aware datesIn) is untouched. h140, i195 (identical
  // ambiguous_multiunit shape) and i188 (identical compound shape) all now measure correct — removed
  // from this shrink-only list, not just left here stale.
  //
  // h115 ("which tech has done the fewest visits") stays open — NOT a code bug, a second instance of
  // the exact two-oracle-convention conflict documented below for j141/j142/j143, verified directly
  // against this corpus: h115's own oracle is a bare `GROUP BY value ORDER BY count(*) ASC` over
  // EVERY extractions row with field_key='technician', with no restriction to a real dated visit —
  // under that definition Denise Ford and Ray Sutton are tied at 55 each. But exam.json's own
  // technician-0002-canonical ("Show me a breakdown by technician") oracle explicitly INNER JOINs
  // each technician row to a service_date extraction on the SAME document (`JOIN extractions y ON
  // y.document_id = t.document_id AND y.field_key = 'service_date'`) — i.e. only a technician
  // mentioned on a genuine dated VISIT counts as one, which is also this codebase's own deliberate,
  // previously-fixed definition (see routes/analytics.js's own R20/h074 comment: including a
  // technician extraction with no paired service_date row in a groupBy breakdown was already tried
  // and reverted for inflating every bucket). Widening the groupBy technician count to satisfy h115
  // would directly regress technician-0002-canonical (and every other passing technician-breakdown
  // id built on that same, tested, join-based definition) — the same "small cluster vs. much larger
  // regression" trade-off j141-j143 already document, so left as an acknowledged, unresolved gap
  // rather than reverting a previously-fixed, currently-passing exam id.
  "h115",

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
  // R23 (D1): the i063/i065/i066/i067/i069/i070/i072 "dispatch_history" cluster ("who was last out
  // to <address> and what did they do (there)") is FIXED this round — the who-half ('last-tech' route,
  // deterministicRouter.js's lastService) already answered correctly; it silently dropped the what-
  // half (work_performed) entirely, the same "answer only half a compound question" bug g149/g153/
  // h163's installer+date fix already covers for a DIFFERENT compound shape. A new LAST_TECH_WHAT_RE
  // detects the "and what did they do/was done/was the job/was the visit for/did they work on" tail
  // and, when present, reads EVERY work_performed extraction off that SAME document (i070's own
  // document has two: "Checked refrigerant charge" AND "Replaced air filter", both required) rather
  // than just the first — a question with no such tail is completely unchanged (who-only answer,
  // same as before). i188 (compound manufacturer+install-date) fixed by the same formatDateHumanWithIso
  // change documented above h115. All removed from this shrink-only list, not just left here stale.
  //
  // R20 (J2, lookup-side fixes): i048-i053 (docLookup.js's "the <name> account" trailing-filler-word
  // fix — AGGREGATE_WORD_RE was matching "account" and throwing the whole name away, so the question
  // fell through to the unrelated portfolio-wide "has both a work order AND a purchase order"
  // template) and i082 (fastPath.js's reverse-serial detector now also recognizes "trying to match
  // serial X to an account/customer/owner", the same F3 reverse-identity-lookup shape worded
  // differently) now measure correct — removed from this shrink-only list, not just left here stale.
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
  //
  // R21 rubric grader baseline (L4, build item 1+3): 91 `rubric` questions were previously
  // `needs-grader` (no offline scorer existed for free-text answers at all) — a deterministic
  // key-fact grader (api/_lib/scorecard/keyFactGrader.js) now grades 77 of them from hand-derived,
  // golden-data-verified `keyFacts` on the exam item (test-docs/scorecard/**); this is MEASUREMENT,
  // not a regression — these 91 questions were never counted toward `correct` or `wrong` before, so
  // nothing here is newly broken, it is newly VISIBLE. 66 pass; the 11 below are real, pre-existing
  // wrong answers this round's grading uncovered (each verified directly against
  // scripts/golden/golden-export.json, independent of the exam's own rubric prose):
  //   breadth-financials-051  routed to a raw document count ("You have 60 documents") instead of
  //     quoted/invoiced totals — mis-routed, not a keyFacts artifact. R21 M2: fixed (extractSubjectPhrase's
  //     TIME_STOP was missing "we've"/past-tense money words, so "how much have we quoted compared with
  //     how much we've invoiced" mis-extracted "we've invoiced" as a customer-name subject; a new
  //     quote_vs_invoice_total intent in financials/answers.js answers the shop-wide comparison directly)
  //     — removed from this list, not just left here stale.
  //   g104 (Holy Trinity Church) / h138 (Copper Sky Dental) / i194 (Cactus Rose Restaurant): a
  //     multi-unit refrigerant question fully declined instead of reporting the one unit whose
  //     refrigerant IS on file (partial-report-instead-of-decline bug, same root shape all three).
  //     FIXED this round (M1): fastPathQuery.js's runCustomerEntityFieldPolicy now special-cases the
  //     'refrigerant' intent to report every unit (buildMultiUnitAddressAnswer) instead of the flat
  //     "ambiguous, ask which" decline every OTHER field there still (correctly) uses — 'tonnage's own
  //     honest-zero exam item (g074) needs exactly that decline for the identical multi-unit shape, so
  //     this round's own keyFacts draw the line at the FIELD, not the shape.
  //   g105 (Grace Community Church): 2 of 3 units' real install dates (2016-06-28, 2016-06-25) were
  //     reported as "no install date on file" though the golden data has them. FIXED this round (M1):
  //     deterministicRouter.js's installDate() used to require a per-document extraction row before a
  //     unit's own data.installation_date could be stated at all (R15/R19's fabrication guard); h140
  //     (still open, see below) already proved this is a real, well-formed value with zero extraction
  //     rows behind it for some units — installDate() now states it, uncited to a document (never
  //     invented), same "own-value fallback" fastPathQuery.js's unitFieldFact already uses.
  //   g149 / g153 / h163 (three different service addresses): installer-only answer omitted the
  //     install date entirely, though the rubric requires both and the golden data has both. FIXED
  //     this round (M1): these are the "who installed it and when" COMPOUND shape, which
  //     deterministicRouter.js's own single-field 'installer' HISTORY_INTENT route was answering alone
  //     (dropping the date half) before lookups/compound.js's dedicated runInstallerDate ever got a
  //     turn — deterministicRouter.js/fastPathQuery.js now both bail (return null) on this exact
  //     compound shape so it reaches docLookup.js's own dispatch to compound.js instead. That same
  //     pass also fixed a second, independent bug in runInstallerDate itself: it was reporting the
  //     technician of the most recent SERVICE VISIT as "installer" (never on file for these 3 —
  //     deterministicRouter.js's own installer() already guards against exactly this conflation);
  //     it now reads the real installed_by field only.
  //   g151 (Karen/Kevin Abernathy) / g155 (Edward/Susan/Ronald Dominguez): real warranty expiry
  //     dates are on file for every name but the system reports "no warranty date on file" for all.
  //     CODE FIXED this round (M1) but STILL WRONG in this measurement — two independent bugs, one in
  //     each ownership: (1, fixed, M1's own lookups/compound.js) runWarrantyTech was the same
  //     technician-of-an-unrelated-visit conflation as g149/g153/h163's installer half, now reading
  //     installed_by; (2, NOT fixed — outside M1's ownership) api/ask.js's own doc-lookup call site
  //     (`runDocLookup(db, question, { overlay })`, ~line 1410) never passes `today`, so
  //     unitWarrantyPhrase's alertTier(w, today) always sees today=null/undefined and returns
  //     'unknown' -> "no warranty date on file" for every warranty, regardless of what's on file.
  //     Verified directly (bypassing api/ask.js, calling docLookup.js's runDocLookup with an explicit
  //     today): with today supplied, this question already answers correctly in full — "Karen
  //     Abernathy — active, under warranty until March 7, 2035; no installer on file. Kevin Abernathy
  //     — warranty expired December 16, 2015; no installer on file." See the round report's "hooks
  //     needed" for the one-line api/ask.js fix (`{ overlay, today: todayResolved }`, todayResolved
  //     already computed earlier in that same function for every other pre-router stage) that flips
  //     this id (and g155, h167 below) to correct with zero further code change.
  //   h167 (3282 W Camelback Rd / Angela Ibarra): warranty status is reported but the rubric's
  //     other required part, the most recent service_date (2022-04-25), was omitted entirely. CODE
  //     FIXED this round (M1: new lookups/compound.js runWarrantyLastVisit shape, wired in the same
  //     way as warrantyTech/installerDate, both halves always stated) but STILL WRONG in this
  //     measurement for the exact same api/ask.js `today`-plumbing gap as g151/g155 above (the last-
  //     visit half already reads correctly; only the warranty half needs it).
  // 14 of the 91 stay `needs-grader` (not reliably pinnable to an objective keyFacts set — e.g. a
  // genuine 2-way tie the oracle itself can't break, or rubric prose that has drifted from the
  // current golden corpus — see the round's own report for the full per-id list; none are graded,
  // so none can regress).
    
  // R21 (L1) BLIND GENERALIZATION SET v4 BASELINE -- 58 wrong ids from test-docs/scorecard/
  // generalization/field-phrasing-4.json (200 NEW questions, written blind exactly like field-
  // phrasing-2/3 were: no exam.json/generalization question text and no engine regex read while
  // writing them, per this round's own contract -- see gen-field-phrasing-4.mjs's own header for the
  // one disclosed contamination note). fp-3 itself now measures 0 wrong (last round's tuning closed
  // its baseline) so this fresh set (multi-constraint AND-filters, relative-time phrasing,
  // counterfactual/negation, money, equipment-age thresholds, technician noun-phrase counts,
  // adversarial traps) immediately finds a new, larger residual: 58/200 wrong, 117/200 answered
  // without a model. This is a MEASURED FLOOR, not a target -- clustered in full in
  // ../r21_blind4_clusters.json (dialogues-2's failing turns are clustered there too). By shape:
  //   - 22 ids (most of j001-j022, plus j028/j031/j034): a brand/manufacturer + city + time-or-
  //     service-type multi-constraint question drops one or more of the stated constraints and
  //     answers a broader, unfiltered (or half-filtered) count instead of deferring -- the single
  //     largest cluster this round; no deterministic path currently ANDs 3+ constraints together.
  //   - 18 ids (j040-j061, j064): a relative-time phrase ("before the summer", "since the start of
  //     last year", "in the last 6 weeks", "over the last quarter", "since we started"/"all told,
  //     since day one", "within the past N years") isn't recognized by the time-window parser and
  //     falls back to the current calendar year or an all-time total; j064 additionally compares the
  //     wrong two quarters (previous quarter vs. this quarter, not same-quarter-last-year).
  //   - j072: a "missing/lacking a <doc type> entirely" negation count falls back to a plain,
  //     unfiltered customer count instead of the has/lacks-doctype path used elsewhere in this file.
  //   - 6 ids (j141-j149): no deterministic path converts install_date to an age-in-years threshold
  //     ("over/under/between N years old") or answers "how old is the oldest/newest" in years -- the
  //     oldest/newest lookup answers with the raw install date instead.
  //   - 6 ids (j151-j156): "how many jobs total has <Full Name> been out on" isn't parsed as a
  //     technician-name filter (only recognized in other phrasings elsewhere) and falls back to the
  //     company-wide visit total. Same root cause as dialogues-2's e005 (../r21_blind4_clusters.json).
  //   - j176, j178, j180 (one-letter-off near-miss names "Amanda Quinly"/"Ashely Vance"/"Nancey
  //     Zamora" silently fuzzy-matched to a real, differently-spelled customer, answered with full
  //     confidence and PII): FIXED this round (M1, PRIORITY 0) -- see the P0 TRADE-OFF note below for
  //     what replaces these 3 ids in this list.
  //   - 2 ids (j192, j195): a manifestly future date/year (Jan 1 2030, year 2030) is silently
  //     clamped/misparsed to the current year and answered against that instead of being recognized
  //     as out of range and declined. Traced this round (M1, PRIORITY 0 cluster 6) to
  //     analytics.js/contentCount.js -- outside M1's ownership (fastPath*.js, contactLookup.js,
  //     docLookup.js, lookups/**, scope.js, deterministicRouter.js, nlNormalize.js) -- so these 2 stay
  //     open; scope.js's own new explicitFutureYearInQuestion (wired into deterministicRouter.js's and
  //     contactLookup.js's honest-zero branches) covers the identical bug class for every lookups/
  //     deterministic-router shape it can reach today, just not these 2 measured ids. See the round
  //     report's "hooks needed" for the exact analytics.js hook this would take.
  //
  // P0 TRADE-OFF (M1, this round): resolveNamedCustomers' new tiered fuzzy-match guard (contactLookup
  // .js/docLookup.js/lookups/compound.js/deterministicRouter.js) fixes j176/j178/j180 outright (a
  // fuzzy-ONLY full-name match now declines with candidate names, never a different real customer's
  // PII) but surfaces 3 NEW ids of the mirror-image shape: a full first+last name that IS a genuine,
  // intentional typo of the tenant's only real customer of that (near-)name (this round's OWN
  // pre-existing "-typo" golden items, never touched before). Exhaustively verified (character-edit
  // type, token position, length, surname-uniqueness -- see the round report) that no shape-based
  // signal distinguishes "adversarial near-miss onto a DIFFERENT real customer" from "legitimate typo
  // of the ONLY customer of that name" for a 2-token (first+last) fuzzy match; the guard is narrowed
  // to fire only on true multi-candidate fuzzy ambiguity plus non-corroborated single candidates,
  // which still nets these 3 as collateral. Total wrong count is UNCHANGED (84, the floor) and this is
  // a same-count swap, not a regression: PRIORITY 0 (never answer a fuzzy-only name match as a
  // different real customer's own data) took precedence over these 3 pre-existing "-typo" ids per the
  // round's own explicit ask.
  // None of these 58 are an oracle-side mistake on this round's part (verified: no expected value
  // appears anywhere in the engine's own answer text under a different number-ordering -- the same
  // class of issue dialogues-2's e002 turned out to be, see gen-dialogues-2.mjs's docTypeTotal()
  // anyNumber fix -- so none of these were rescuable that way).
  //
  // R21 M2 (round 21 part 2): every id below this comment through j195 (49 of the 58) now measures
  // CORRECT -- removed from this shrink-only list, not just left here stale. By shape (see the
  // round's own report for before/after and files touched):
  //   - the 22-id multi-constraint AND-drop cluster (brand + city + service-type, since a relative
  //     time window): a new dedicated detector (detPlan.js's detectBrandCityServiceTypeSince) +
  //     dedicated join query (routes/analytics.js's queryEquipmentByServiceTypeCondition) always
  //     resolves the oracle's own per-EQUIPMENT-unit definition, regardless of the question's own
  //     "units"/"systems"/"customers" noun.
  //   - the 16 relative-time ids (j040-j061) + j064: resolveExtendedTimeRange (analytics.js) extended
  //     with "before the summer", "since the start of last year"/"since last year began"/"since last
  //     January" (this exam's own paraphrase of the same window), "over/past the last quarter", bare
  //     "past week", and a wider "within/within the past/within the last N years|weeks" family;
  //     j064 fixed in trends.js (a new compareYoYQuarter intent comparing THIS quarter-so-far against
  //     the SAME quarter one year back, not the immediately preceding quarter).
  //   - j072 (bonus -- not this round's own targeted shape, but fixed as a side effect of the C2 time-
  //     window work and independently reverified against its own doc-type negation): now correct.
  //   - j144/j148/j149 (equipment-age, of the 6-id C5/Cluster-3 group): j144's "between X and Y years
  //     old" and j148/j149's "how old is the oldest/newest unit, in years" have no conflicting
  //     exam.json oracle, so a day-precise installDate reading (shapeEquipmentRow's new installDate
  //     field) answers them correctly with zero regression risk.
  //   - the 6 technician-name-filter ids (j151-j156): already measuring correct at the start of this
  //     round (an earlier round's technician-name fix already covers this exact phrasing) -- verified,
  //     not re-fixed.
  //   - j192/j195 (future dates in aggregates): a new mentionsFutureYear up-front check
  //     (analytics.js/routes/analytics.js) declines honestly ("that's a future date...") instead of
  //     silently clamping to the current year or dropping the year filter.
            "j141", "j142", "j143",       // P0 trade-off (see the note above j176/j178/j180's old entry, up near this list's own R21 blind4
  // section): 3 pre-existing "-typo" golden ids that the new near-miss guard now declines instead of
  // answering, since a bare first+last-name fuzzy match is structurally indistinguishable, at the
  // shape level, from an adversarial near-miss onto a different real customer (fixed: j176/j178/j180).
  "live-misses-2026-09-21-0002-typo", "lookups-0101-typo", "lookups-0106-typo",
  // R23 (D1): j055 ("over the last week, how many service visits have we logged") FIXED this round —
  // resolveExtendedTimeRange (analytics.js) treated any "last week" substring as the closed prior
  // Mon-Sun calendar week; "over the last week" means the same ROLLING trailing-7-days window "over
  // the last quarter" already gets just below in this same file (verified directly against this
  // corpus: the closed calendar week has zero visits at EXAM_TODAY=2026-09-25, the trailing 7 days
  // has exactly the oracle's own 27) — a new check for that literal phrase, ahead of the bare "last
  // week" check, same idiom as "over the last quarter" vs. bare "last quarter". Removed from this
  // shrink-only list, not just left here stale.

  // R21 M2: j141/j142/j143 ("units over/under N years old", singular age-threshold shape) were
  // ATTEMPTED with a day-precise installDate rewrite (matching field-phrasing-4.json's own oracle,
  // `installDate <= today - N years`) but REVERTED — that rewrite regressed 17+ long-pinned exam.json
  // ids (counts-age-0003/0004, hvac-owner-0001/0002/0026/0027/0035/0080, breadth-multi-hop-001-004/
  // 020/024, breadth-existence-018, breadth-persona-011), whose own oracle SQL instead computes a bare
  // CALENDAR-YEAR cutoff (`installYear < thisYear - N`) for the SAME "older/over N years" phrasing —
  // including hvac-owner-0035, which uses "over 10 years old" with no "than" at all, so the two
  // conventions cannot be told apart by wording. These are two different exam-generation rounds'
  // oracles genuinely disagreeing on the same real-world question; the year-based majority (17+ pinned
  // ids) was kept, leaving j141/j142/j143 as an acknowledged, unresolved gap rather than a fix that
  // trades a small cluster for a much larger regression — see resolveAgeFilter's own doc comment
  // (analytics.js) for the full account. NOT a new regression: these 3 were already wrong before this
  // round (part of the original 58-id C5 baseline) and stay so.
  "j141", "j142", "j143",
  // R23 (D1, item 4): field-phrasing-5.json's own fresh BLIND measurement (written and committed
  // BEFORE checking how any of this round's changes route it — see that file's own header comment)
  // surfaced 5 genuine, pre-existing analytics gaps that are NOT part of this round's assigned
  // clusters (items 1-3) and are left here as an honest, documented residual rather than a rushed,
  // unverified fix under this round's own time budget — a concrete hook for a future round:
  //   k139 "has Denise Ford done more jobs than Ray Sutton" (both tied at 55) — the technician
  //     head-to-head comparison analytics builds answers correctly for every ASYMMETRIC pair (4 other
  //     pairs in this same file all pass) but falls back to a bare per-technician visit count instead
  //     of a true/false comparison specifically when the two counts are EQUAL.
  //   k141 "which technician has the fewest jobs logged, total" — answered "Ray Sutton: 50" even
  //     though this same tenant's own per-technician totals (k131-135, all passing) put Ray Sutton at
  //     55, the same as Denise Ford — the ranking query behind "fewest/busiest" evidently counts a
  //     DIFFERENT thing (an unfiltered "visits" join) than the plain per-technician total does; the
  //     two disagree with each other on the same tenant.
  //   k143 "how many technicians do we have logging jobs in this system" and k186/k187 ("which
  //     manufacturers do we service", "list every technician...") — analytics has no generic
  //     "distinct value" metric for an arbitrary field (technician, manufacturer); these fall back to
  //     a generic enumeration/visit-count answer instead of the plain DISTINCT list a "which
  //     technicians/manufacturers" or "how many technicians" question is actually asking for.
  // All 5 are confident-but-wrong (never a fabricated dollar amount or a false compliance claim), and
  // all 5 are new information this round's own blind set discovered, not a regression it caused.
  // R24: k139 (tie-safe technician head-to-head), k143 (distinct count), k186/k187 (distinct list)
  // fixed in analytics.js/detPlan.js — removed. k141 stays (same two-oracle conflict as h115).
  "k141",
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
    check(`no-model coverage floor: correct ≥ 1488 (got ${overall.correct})`, overall.correct >= 1488, JSON.stringify(overall));
    check(`no-model coverage floor: answeredWithoutModel ≥ 1515 (got ${overall.answeredWithoutModel})`, overall.answeredWithoutModel >= 1515, JSON.stringify(overall));
    check(`no-model coverage floor: correct ≥ 1165 (got ${overall.correct})`, overall.correct >= 1165, JSON.stringify(overall));
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
