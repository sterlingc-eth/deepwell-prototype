#!/usr/bin/env node
/**
 * DIALOGUES-1 runner/grader (Round 19, I3) — replays test-docs/scorecard/generalization/dialogues-1.json
 * through the REAL /api/ask handler (api/ask.js's default export) against a PGlite tenant loaded from the
 * golden export (scripts/golden/golden-export.json), models blocked (same discipline as
 * scripts/offline-exam.mjs). Each dialogue's turns are asked in order, threading conversationContext
 * exactly as the client builds it: src/components/ask/conversationTurn.ts's turnFrom()/
 * resolvedEntitiesFrom()/answerAsksWhichOne() mirrored here in plain JS (that file is TypeScript and
 * cannot be imported directly from a .mjs script; the logic is reproduced verbatim, not reinvented — see
 * nextTurnFrom() below) and validated server-side exactly the way api/_lib/conversation.js's
 * validateConversationContext() already does for every production request.
 *
 * Grading per turn (see gen-dialogues.mjs's own header for the `expect` shapes):
 *   "oracle"           api/_lib/scorecard/oracle.js's runOracle() computes ground truth against the SAME
 *                      golden tenant; api/_lib/scorecard/compare.js's compareAnswer() grades the real
 *                      answer against it — the exact same two functions the main offline exam uses.
 *   "clarify"          the turn's own answer must itself read as a disambiguation prompt.
 *   "decline"          graded via compareHonestZero (through compareAnswer's honest-zero branch) — no
 *                      oracle needed, since that comparator never reads `expected`.
 *   "mustNotContain"   a negative check: none of the listed terms may appear in the answer text.
 *
 * Reports turn-level and dialogue-level accuracy (a dialogue counts as passed only if every one of its
 * turns passed).
 *
 * ROUND 21 (L1): accepts an optional dialogues FILE (a name under test-docs/scorecard/generalization/,
 * e.g. "dialogues-2.json", or an absolute/relative path to any {version, category, dialogues} file) so
 * scripts/verify-dialogues.mjs can gate a second dialogue set (dialogues-2) through this same harness
 * without duplicating any of the replay/grading logic below. Every existing caller that passes only an
 * out-path (or nothing) keeps replaying dialogues-1.json exactly as before - this is additive.
 *
 *   node scripts/run-dialogues.mjs [out.json] [dialogues-file]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIALOGUES_FILE = path.join(ROOT, "test-docs/scorecard/generalization/dialogues-1.json");
const GENERALIZATION_DIR = path.join(ROOT, "test-docs/scorecard/generalization");
const TODAY = "2026-09-26"; // same convention as verify-field-phrasing-2/3.mjs's own standalone runs

/** Resolves `opts.dialoguesFile`/the CLI's 2nd argv to an actual file path: a bare filename (or one with
 *  no path separators) is looked up under test-docs/scorecard/generalization/ first (so "dialogues-2.json"
 *  just works), otherwise it is treated as a path relative to ROOT (or absolute). Falls back to
 *  dialogues-1.json when nothing is given, so every pre-existing call is untouched. */
function resolveDialoguesFile(nameOrPath) {
  if (!nameOrPath) return DEFAULT_DIALOGUES_FILE;
  if (!nameOrPath.includes("/") && !nameOrPath.includes(path.sep)) {
    const underGen = path.join(GENERALIZATION_DIR, nameOrPath);
    if (fs.existsSync(underGen)) return underGen;
  }
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.resolve(ROOT, nameOrPath);
}

/** Mirrors src/components/ask/conversationTurn.ts's CLARIFICATION_RE exactly (that file's own doc
 *  comment: every current disambiguation answer uses this phrasing — a stable, cross-cutting UX marker,
 *  not exam question text). */
const CLARIFICATION_RE = /which\s+\w+\s+(?:do|did)\s+you\s+mean/i;

// ROUND 20 (J4, hook 5): `opts.outPath` lets a caller (scripts/verify-dialogues.mjs) redirect the
// written JSON to a scratch location instead of the repo root, and `opts.silent` suppresses this
// script's own console.log summary/failed-turns dump when a caller wants to print its own gated
// report instead — both optional, so every existing CLI call (`node scripts/run-dialogues.mjs
// [out.json]`) behaves byte-identical to before either existed. `main` now RETURNS
// `{ summary, perDialogue, perTurn }` (previously void) so a caller can gate on the actual results
// without re-parsing the written file.
async function main(opts = {}) {
  const outArg = opts.outPath ?? process.argv[2];
  const outPath = outArg ? path.resolve(outArg) : path.join(ROOT, "dialogues-results.json");
  const dialoguesFile = resolveDialoguesFile(opts.dialoguesFile ?? process.argv[3]);

  process.env.NEON_CONNECTION_STRING ||= "postgres://harness:harness@localhost:5432/harness";
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_API_KEY ||= "sk-ant-r19i3-dialogues-disabled";

  const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
  const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
  const { withTenant } = await import(path.join(ROOT, "api/_lib/recordsStore.js"));
  const { runOracle } = await import(path.join(ROOT, "api/_lib/scorecard/oracle.js"));
  const { compareAnswer } = await import(path.join(ROOT, "api/_lib/scorecard/compare.js"));
  const { SCORECARD_CALL } = await import(path.join(ROOT, "api/_lib/scorecard/hook.js"));
  const { default: askHandler } = await import(path.join(ROOT, "api/ask.js"));

  await installPgHarness();
  const modelCounter = await installModelBlock();
  const lite = await createPGlite();
  await setActiveDatabase(lite);
  const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
  const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "run-dialogues", tenantName: "Run Dialogues" });
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };

  function makeRes() {
    const res = { statusCode: 200, headers: {}, headersSent: false, body: undefined };
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[String(k).toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; return res; };
    res.end = () => { res.headersSent = true; return res; };
    return res;
  }

  /** One /api/ask call through the REAL handler, in-process — same shape as
   *  api/_lib/scorecard/askCall.js's askViaHandler, duplicated here (not imported) because that module's
   *  signature has no conversationContext param and it is not this engineer's file to change (api/** is
   *  off-limits this round; askCall.js lives there). */
  async function askOnce(question, conversationContext) {
    const req = {
      method: "POST", headers: {}, query: {},
      body: { question, today: TODAY, ...(conversationContext ? { conversationContext } : {}) },
      [SCORECARD_CALL]: { auth },
    };
    const res = makeRes();
    modelCounter.n = 0;
    let thrown = null;
    try { await askHandler(req, res); } catch (err) { thrown = err; }
    const data = res.body?.success ? res.body.data ?? null : null;
    return { data, usedModel: modelCounter.n > 0, thrown, raw: res.body };
  }

  /** Builds the NEXT ConversationTurn from the CURRENT turn's own real answer — mirrors
   *  src/components/ask/conversationTurn.ts's turnFrom()/resolvedEntitiesFrom()/answerAsksWhichOne()
   *  verbatim (that file is TypeScript, not importable here) so this harness threads context exactly the
   *  way the real client does, not an approximation of it. */
  function nextTurnFrom(question, data) {
    const candidates = (data?.records ?? [])
      .filter((r) => r && (r.type === "customer" || r.type === "unit") && typeof r.id === "string")
      .slice(0, 20)
      .map((r) => ({ type: r.type, id: r.id, ...(r.label ? { label: String(r.label).slice(0, 200) } : {}), ...(r.sublabel ? { sublabel: String(r.sublabel).slice(0, 200) } : {}) }));
    const pendingClarification = CLARIFICATION_RE.test(data?.text ?? "");
    return {
      question,
      askedAt: new Date().toISOString(),
      ...(candidates.length ? { resolvedEntities: candidates } : {}),
      ...(pendingClarification ? { pendingClarification: true } : {}),
    };
  }

  /** Grades one turn's real answer against its `expect` descriptor. */
  async function gradeTurn(expect, data) {
    if (expect.kind === "clarify") {
      const ok = CLARIFICATION_RE.test(data?.text ?? "") || (Array.isArray(data?.records) && data.records.length >= 2 && /more than one|which one/i.test(data?.text ?? ""));
      return { passed: ok, why: ok ? "" : "expected a disambiguation prompt ('which ... do you mean')" };
    }
    if (expect.kind === "decline") {
      const r = compareAnswer({ cmp: "honest-zero" }, data ?? {});
      return { passed: r.passed, why: r.why };
    }
    if (expect.kind === "mustNotContain") {
      const hay = String(data?.text ?? "").toLowerCase();
      const hit = expect.terms.find((t) => hay.includes(String(t).toLowerCase()));
      return { passed: !hit, why: hit ? `answer still mentions stale referent "${hit}"` : "" };
    }
    if (expect.kind === "oracle") {
      const oracle = await runOracle(withTenant, ctx, { cmp: expect.cmp, oracle: expect.oracle }, { today: TODAY });
      if (!oracle.ok) return { passed: false, why: `oracle-error: ${oracle.error}` };
      if (oracle.skip) return { passed: null, why: `skipped: ${oracle.why}` }; // subject not in this export - not this harness's fault
      const graded = compareAnswer({ cmp: expect.cmp, expected: oracle.expected, citationRequired: expect.citationRequired, tolerance: expect.tolerance, anyNumber: expect.anyNumber }, data ?? {});
      return { passed: graded.passed, why: graded.why };
    }
    return { passed: false, why: `unknown expect.kind ${expect.kind}` };
  }

  const file = JSON.parse(fs.readFileSync(dialoguesFile, "utf8"));
  const dialogues = Array.isArray(file.dialogues) ? file.dialogues : [];

  const perTurn = [];
  const perDialogue = [];
  for (const d of dialogues) {
    const turns = [];
    let contextTurns = [];
    let dialoguePassed = true;
    let dialogueSkippedOnly = true;
    for (const t of d.turns) {
      const conversationContext = contextTurns.length ? { turns: contextTurns } : undefined;
      const { data, usedModel, thrown } = await askOnce(t.text, conversationContext);
      let verdict;
      if (thrown) verdict = { passed: false, why: `handler threw: ${thrown?.name ?? thrown}` };
      else if (usedModel) verdict = { passed: null, why: "needs-model (not graded - this harness proves the deterministic layer, not the agent)" };
      else verdict = await gradeTurn(t.expect, data);

      const graded = verdict.passed !== null;
      if (graded) dialogueSkippedOnly = false;
      if (graded && !verdict.passed) dialoguePassed = false;

      perTurn.push({ dialogueId: d.id, persona: d.persona, text: t.text, expectKind: t.expect.kind, status: verdict.passed === null ? "skipped" : verdict.passed ? "pass" : "fail", why: verdict.why });
      turns.push({ text: t.text, status: verdict.passed === null ? "skipped" : verdict.passed ? "pass" : "fail", why: verdict.why });

      contextTurns = [...contextTurns, nextTurnFrom(t.text, data)].slice(-4);
    }
    perDialogue.push({ id: d.id, persona: d.persona, status: dialogueSkippedOnly ? "skipped" : dialoguePassed ? "pass" : "fail", turns });
  }

  const gradedTurns = perTurn.filter((t) => t.status !== "skipped");
  const passedTurns = gradedTurns.filter((t) => t.status === "pass");
  const gradedDialogues = perDialogue.filter((d) => d.status !== "skipped");
  const passedDialogues = gradedDialogues.filter((d) => d.status === "pass");

  const summary = {
    generatedAt: new Date().toISOString(),
    turns: { total: perTurn.length, graded: gradedTurns.length, passed: passedTurns.length, skipped: perTurn.length - gradedTurns.length, accuracy: gradedTurns.length ? Math.round((passedTurns.length / gradedTurns.length) * 1000) / 1000 : null },
    dialogues: { total: perDialogue.length, graded: gradedDialogues.length, passed: passedDialogues.length, skipped: perDialogue.length - gradedDialogues.length, accuracy: gradedDialogues.length ? Math.round((passedDialogues.length / gradedDialogues.length) * 1000) / 1000 : null },
  };

  fs.writeFileSync(outPath, JSON.stringify({ summary, perDialogue, perTurn }, null, 2));
  if (!opts.silent) {
    console.log(`run-dialogues: ${JSON.stringify(summary)}`);
    console.log(`-> ${outPath}`);

    const failedTurns = perTurn.filter((t) => t.status === "fail");
    if (failedTurns.length) {
      console.log(`\nFailed turns (${failedTurns.length}):`);
      for (const t of failedTurns) console.log(`  [${t.dialogueId}] (${t.persona}) "${t.text}" — ${t.why}`);
    }
  }
  return { summary, perDialogue, perTurn };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });

export { main };
