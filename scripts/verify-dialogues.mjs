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
  // d012 ("what's Karen Abernathy's phone number", expects a disambiguation prompt): pre-existing,
  // unrelated to this round's hooks — not investigated here (out of scope for hook 5, which wires
  // the GATE itself, not every dialogue's own root cause).
  "d012",
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
  // (accuracy 0.97); dialogues 40 total / 24 graded / 23 passed (accuracy 0.958) — floor RAISED a
  // little below measured, same margin convention as verify-golden.mjs's own floors, so ordinary
  // corpus/harness noise doesn't flap CI while a genuine regression (a previously-passing dialogue
  // starting to fail, dragging accuracy down) still fails it.
  check(
    `dialogues: graded turn accuracy has not regressed below the measured floor (got ${summary.turns.accuracy}, floor 0.95)`,
    (summary.turns.accuracy ?? 0) >= 0.95,
    JSON.stringify(summary.turns),
  );
  check(
    `dialogues: graded dialogue accuracy has not regressed below the measured floor (got ${summary.dialogues.accuracy}, floor 0.94)`,
    (summary.dialogues.accuracy ?? 0) >= 0.94,
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

  console.log("");
  console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
