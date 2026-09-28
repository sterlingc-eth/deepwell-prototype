#!/usr/bin/env node
/**
 * ROUND 20 (J4, hook 5): wires scripts/run-dialogues.mjs (the multi-turn dialogue harness — real
 * /api/ask handler, PGlite golden tenant, models blocked) into verify:all as a REGRESSION GATE, the
 * same shape scripts/verify-golden.mjs already uses for the single-turn exam's KNOWN_WRONG_IDS: a
 * failing dialogue id already on the documented list is tolerated (this file is not the place that
 * fixes it — see each id's own comment below for its real root cause and owner); a dialogue that
 * fails and ISN'T on that list, or graded accuracy dropping below the measured floor, fails CI.
 *
 * Before this hook, run-dialogues.mjs was a standalone, un-gated script (no exit code discipline, no
 * pass/fail threshold) — a real dialogue regression could land silently forever. This never changes
 * grading logic (compareAnswer/runOracle, run-dialogues.mjs's own gradeTurn) — only whether a known
 * shape of failure is tolerated or not.
 *
 *   node scripts/verify-dialogues.mjs
 */
import os from "node:os";
import path from "node:path";

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

// Dialogue ids with at least one documented, still-open failing turn. Each entry names the exact
// turn, why it fails, and whose file would actually need to change — never guessed, never a text
// hard-code of the exam's own oracle values (only the id + root-cause pointer, same convention as
// verify-golden.mjs's own KNOWN_WRONG_IDS). This is a MEASURED FLOOR, not a target.
const KNOWN_FAILING_DIALOGUE_IDS = new Set([
  // d005 FIXED (coordinator follow-up (a), 2026-09-27): "and how many of those are past their
  // warranty?" now resolves the brand-aware follow-up (api/_lib/followup/**, R20/J4 hook 4) AND
  // recognizes "past (their/its/the)? warranty" as the 'expired' bucket (api/_lib/analytics.js's
  // WARRANTY_STATUS_WORD_RE/warrantyStatusFromQuestion — see verify-analytics.mjs's own
  // past-warranty block) — removed from this list; a regression here now fails CI.
  //
  // d012 FIXED (Round 21, L2): "what's Karen Abernathy's phone number" was ALWAYS answered
  // correctly by contactLookup.js (resolveContactCandidates' exact-ILIKE branch already matches a
  // full first+last name to exactly one customer before any surname-family fallback ever runs —
  // there is exactly one "Karen Abernathy" and one "Kevin Abernathy" on file, two different
  // people who merely share a surname) — the bug was in the TEST DATA: dialogues-1.json's own
  // d012 turn 1 still expected a Round-19-era "clarify" (a stale expectation from before the
  // exact-full-name-match path existed / was this precise). Corrected to the same "oracle"/value
  // shape d009's Ashley Vance/Kenneth Fenwick turns already use. Turn 2 ("the other Abernathy,
  // Kevin") is unaffected either way — it already needs-model (an anaphoric "the other X" carried
  // across turns with no prior ambiguity to resolve against), which this harness already treats
  // as skipped, not failing — see run-dialogues.mjs's own gradeTurn.
]);

// ROUND 21 (L1): the same shrink-only gate as KNOWN_FAILING_DIALOGUE_IDS above, for
// test-docs/scorecard/generalization/dialogues-2.json (40 NEW blind dialogues — topic switches,
// corrections, refinements, comparisons over prior results, pronoun chains — written blind exactly
// like dialogues-1 was: no exam.json/existing dialogue text and no engine regex read while writing
// them; see scripts/gen-dialogues-2.mjs's own header for the disclosed contamination note carried
// over from this round's field-phrasing-4 work). Measured: turns 136 total / 74 graded / 63 passed
// (accuracy 0.851); dialogues 40 total / 35 graded / 25 passed (accuracy 0.714) — this IS the floor,
// not a target; see ../r21_blind4_clusters.json for the full cluster analysis.
const KNOWN_FAILING_DIALOGUE_IDS_2 = new Set([
  // e005 ("how many Kevin Pratt jobs are on file", expected 59): the noun-phrase "<Full Name> jobs"
  // isn't parsed as a technician-name filter (only recognized in other phrasings elsewhere) and falls
  // back to the company-wide visit total (340). Same root cause as field-phrasing-4's j151-j156.
  // Owner: M1/L2 (fastPath.js/lookups — not this file's follow-up engine).
  "e005",
  // e017-e024 turn 2 ("how many of those have a <brand> unit" after a city-scoped count) FIXED
  // (Round 21 part 2, M3, 2026-09-27): api/_lib/followup/subject.js's subjectFromEntities now derives
  // a `listScope` when a prior turn's resolvedEntities is a MULTI-entity list sharing one grouping
  // value (every candidate customer's own sublabel is the SAME city — exactly what a city-filtered
  // list's own citations already carry, routes/analytics.js's shapeCustomerRow/recordFor) — resolve.js's
  // findAnchor now accepts that as a real anchor (previously only address/name/candidateUnits
  // qualified), and pronounReplacement folds it into the rewritten question ("those" -> "the customers
  // in Tempe") instead of the bare, unscoped "the units" it produced before. e017/e019/e022 (whose
  // turn 3 is answerable without a relative-time phrase) now pass ALL THREE turns and are removed
  // below entirely.
  //
  // e018/e020/e021/e023/e024 stay on this list — turn 2 (the city+brand narrowing this hook fixes)
  // now passes for every one of them too, but turn 3 ("...since the start of last year" / "...since
  // last January") still needs-model: the relative-time phrase parser doesn't recognize that wording
  // yet (field-phrasing-4's cluster C2 — analytics.js/trends.js's time-window vocabulary, M2's
  // territory this round, not the follow-up coordinator). Kept here for that reason only.
  // (e018, e020, e021, e023, e024 removed at R21 integration — they pass once M2's time resolver and M3's list scope are merged.)
  // e031 ("how many units total are over 15 years old", expected 20): a wholly new equipment-age-
  // threshold shape with no correct deterministic support — same root cause as field-phrasing-4's
  // j141-j144. Owner: M2/L3 (analytics aggregates).
  "e031",
  // R21 integration (M2 + M3 merged): e018/e020/e021/e023/e024 now pass all turns — removed.
]);

async function main() {
  const { main: runDialogues } = await import("./run-dialogues.mjs");
  const outPath = path.join(os.tmpdir(), `dialogues-results-${process.pid}.json`);
  const { summary, perDialogue, perTurn } = await runDialogues({ outPath, silent: true });

  console.log(`NOTE  run-dialogues summary: ${JSON.stringify(summary)}`);

  const failingIds = perDialogue.filter((d) => d.status === "fail").map((d) => d.id);
  const newFailing = failingIds.filter((id) => !KNOWN_FAILING_DIALOGUE_IDS.has(id));
  check(
    `dialogues: no NEW failing dialogues (${failingIds.length} failing total, all within the documented set)`,
    newFailing.length === 0,
    `unexpected failing dialogue ids: ${JSON.stringify(newFailing)}`,
  );

  // Every KNOWN id must actually still exist in this run (a stale entry naming a dialogue id that was
  // removed/renamed from dialogues-1.json would silently pass this gate for the wrong reason).
  const seenIds = new Set(perDialogue.map((d) => d.id));
  const staleKnownIds = [...KNOWN_FAILING_DIALOGUE_IDS].filter((id) => !seenIds.has(id));
  check(
    "dialogues: every KNOWN_FAILING_DIALOGUE_IDS entry still refers to a real dialogue",
    staleKnownIds.length === 0,
    `stale ids (no longer in dialogues-1.json): ${JSON.stringify(staleKnownIds)}`,
  );

  // Measured (R20, after hooks 1-4): turns 74 total / 33 graded / 31 passed (accuracy 0.939); dialogues
  // Measured (coordinator follow-up (a), d005 fixed): turns 74 total / 33 graded / 32 passed
  // (accuracy 0.97); dialogues 40 total / 24 graded / 23 passed (accuracy 0.958).
  // Measured (Round 21, L2, d012 fixed): turns 74 total / 33 graded / 33 passed (accuracy 1.0);
  // dialogues 40 total / 24 graded / 24 passed (accuracy 1.0).
  // Measured (Round 21, L2, needs-model lookup clusters converted — fastPath.js's IS_NAME_WARRANTY_RE/
  // DOES_NAME_HAVE_RE lazy-quantifier fix + contactLookup.js's new bare-surname warranty-status/
  // last-visit/account-connector shapes — more turns now resolve deterministically instead of
  // needs-model, including d013 turn 1, whose own "clarify" expectation was the same kind of stale
  // pre-existing-behavior assumption d012's was: exam.json's own h045/h046/i111-i113 (identical
  // "warranty status on <bare surname>" shape) already grade a LISTING answer as correct via
  // cmp:"set", never a decline, so d013 turn 1 is corrected to the same oracle/set shape here):
  // turns 74 total / 36 graded / 36 passed (accuracy 1.0); dialogues 40 total / 26 graded / 26
  // passed (accuracy 1.0) — floor RAISED a little below measured, same margin convention as
  // verify-golden.mjs's own floors, so ordinary corpus/harness noise doesn't flap CI while a
  // genuine regression (a previously-passing dialogue starting to fail, dragging accuracy down)
  // still fails it.
  check(
    `dialogues: graded turn accuracy has not regressed below the measured floor (got ${summary.turns.accuracy}, floor 0.98)`,
    (summary.turns.accuracy ?? 0) >= 0.98,
    JSON.stringify(summary.turns),
  );
  check(
    `dialogues: graded dialogue accuracy has not regressed below the measured floor (got ${summary.dialogues.accuracy}, floor 0.97)`,
    (summary.dialogues.accuracy ?? 0) >= 0.97,
    JSON.stringify(summary.dialogues),
  );

  // A NEW failing turn on a dialogue id we've never seen fail before is exactly what the id-level
  // check above already catches; this also names every failing turn's own text for a fast diagnosis
  // straight from CI output, without needing to dig into the (scratch, not committed) results file.
  const failedTurns = perTurn.filter((t) => t.status === "fail");
  if (failedTurns.length) {
    console.log(`\nFailing turns (${failedTurns.length}):`);
    for (const t of failedTurns) console.log(`  [${t.dialogueId}] (${t.persona}) "${t.text}" — ${t.why}`);
  }

  // ROUND 21 (L1): the same gate, run a second time against dialogues-2.json. A completely separate
  // run-dialogues.mjs call/outPath/summary — dialogues-1's own gate above is untouched either way.
  const outPath2 = path.join(os.tmpdir(), `dialogues-2-results-${process.pid}.json`);
  const { summary: summary2, perDialogue: perDialogue2, perTurn: perTurn2 } = await runDialogues({
    outPath: outPath2,
    silent: true,
    dialoguesFile: "dialogues-2.json",
  });

  console.log(`NOTE  run-dialogues (dialogues-2) summary: ${JSON.stringify(summary2)}`);

  const failingIds2 = perDialogue2.filter((d) => d.status === "fail").map((d) => d.id);
  const newFailing2 = failingIds2.filter((id) => !KNOWN_FAILING_DIALOGUE_IDS_2.has(id));
  check(
    `dialogues-2: no NEW failing dialogues (${failingIds2.length} failing total, all within the documented set)`,
    newFailing2.length === 0,
    `unexpected failing dialogue ids: ${JSON.stringify(newFailing2)}`,
  );

  const seenIds2 = new Set(perDialogue2.map((d) => d.id));
  const staleKnownIds2 = [...KNOWN_FAILING_DIALOGUE_IDS_2].filter((id) => !seenIds2.has(id));
  check(
    "dialogues-2: every KNOWN_FAILING_DIALOGUE_IDS_2 entry still refers to a real dialogue",
    staleKnownIds2.length === 0,
    `stale ids (no longer in dialogues-2.json): ${JSON.stringify(staleKnownIds2)}`,
  );

  // Measured (R21 part 1, L1 blind baseline): turns 136 total / 74 graded / 63 passed (accuracy
  // 0.851); dialogues 40 total / 35 graded / 25 passed (accuracy 0.714).
  // Measured (R21 part 2, M3, multi-entity list follow-up fix — e017/e019/e022 fully fixed,
  // e018/e020/e021/e023/e024's turn 2 fixed (turn 3 still needs-model, M2's relative-time cluster)):
  // turns 136 total / 82 graded / 74 passed (accuracy 0.902); dialogues 40 total / 35 graded / 28
  // passed (accuracy 0.8) — floors RAISED (still a little below measured, same margin convention as
  // dialogues-1's own floors and verify-golden.mjs's).
  check(
    `dialogues-2: graded turn accuracy has not regressed below the measured floor (got ${summary2.turns.accuracy}, floor 0.96)`,
    (summary2.turns.accuracy ?? 0) >= 0.96,
    JSON.stringify(summary2.turns),
  );
  check(
    `dialogues-2: graded dialogue accuracy has not regressed below the measured floor (got ${summary2.dialogues.accuracy}, floor 0.93)`,
    (summary2.dialogues.accuracy ?? 0) >= 0.93,
    JSON.stringify(summary2.dialogues),
  );

  const failedTurns2 = perTurn2.filter((t) => t.status === "fail");
  if (failedTurns2.length) {
    console.log(`\nFailing turns (dialogues-2) (${failedTurns2.length}):`);
    for (const t of failedTurns2) console.log(`  [${t.dialogueId}] (${t.persona}) "${t.text}" — ${t.why}`);
  }

  console.log("");
  console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
