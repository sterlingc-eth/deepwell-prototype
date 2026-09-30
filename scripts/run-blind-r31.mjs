#!/usr/bin/env node
/**
 * R31 (Team A): grade the frozen blind generalization sets (test-docs/scorecard/blind/r31-*.json, made by
 * scripts/gen-blind-r31.mjs) through the production /api/ask handler with every model call blocked — the same
 * harness/comparators as scripts/offline-exam.mjs. Report per file: answered-without-model / correct / wrong /
 * needs-model, plus the ids. Nothing here calls a model or the network.
 *
 *   TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/run-blind-r31.mjs [contact|address|technician|honest ...] [--json out.json] [--list]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const off = await import("./offline-exam.mjs");
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const list = args.includes("--list");
const names = args.filter((a, i) => !a.startsWith("--") && (jsonIdx < 0 || i !== jsonIdx + 1));
const files = (names.length ? names : ["contact", "address", "technician", "honest"]).map((n) => path.join(ROOT, "test-docs/scorecard/blind", `r31-${n}.json`));

const realLog = console.log; const realWarn = console.warn; const realErr = console.error;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness();
const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: "offline:blind-r31", tenantName: "Blind R31" });
const today = process.env.EXAM_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXAM_TODAY) ? process.env.EXAM_TODAY : "2026-09-25";
const { validQuestions } = await import("../api/_lib/scorecard/exam.js");
const all = {};
for (const f of files) {
  const qs = validQuestions(JSON.parse(fs.readFileSync(f, "utf8")).questions);
  const { perQuestion, overall } = await off.runOfflineExam({ ctx, questions: qs, today, modelCounter });
  const name = path.basename(f, ".json");
  all[name] = { overall, perQuestion };
  const c = (s) => perQuestion.filter((r) => r.status === s).length;
  realLog(`${name}: ${qs.length} q | no-model ${overall.answeredWithoutModel} | correct ${overall.correct} | wrong ${overall.wrong} | needs-model ${overall.needsModel} | skipped ${c("skipped")} | p95 ${overall.latencyMsP95}ms`);
  if (list) for (const r of perQuestion) if (r.status !== "correct") realLog(`   ${r.status.padEnd(12)} ${r.id} | ${r.question}${r.status === "wrong" ? `  => ${String(r.got).slice(0, 110)}` : ""}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(all, null, 1));
process.exit(0);
