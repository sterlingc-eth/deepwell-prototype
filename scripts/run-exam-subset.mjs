#!/usr/bin/env node
/**
 * R32: fast subset runner. Grades a slice of the full exam (exam.json + generalization/*.json) and/or any blind file(s)
 * through the production /api/ask handler with every model call blocked (same harness as offline-exam.mjs).
 *
 *   TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/run-exam-subset.mjs [--ids <regex>] [--cat <regex>] [--blind <file.json> ...] [--status wrong,needs-model] [--json out.json]
 * Prints one line per non-correct row (or every row with --all) and the totals.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const off = await import("./offline-exam.mjs");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const multi = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const idRe = opt("--ids") ? new RegExp(opt("--ids")) : null;
const catRe = opt("--cat") ? new RegExp(opt("--cat")) : null;
const blindFiles = multi("--blind");
const jsonOut = opt("--json");
const showAll = args.includes("--all");
const skipBase = args.includes("--no-base");

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness();
const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${exportData.tenantKey ?? "subset"}`, tenantName: "Subset" });
const today = process.env.EXAM_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXAM_TODAY) ? process.env.EXAM_TODAY : "2026-09-25";
const { validQuestions } = await import("../api/_lib/scorecard/exam.js");
let qs = [];
if (!skipBase) {
  qs = (await off.loadFullExam(exportData.tenantKey ?? null)).questions;
  if (idRe) qs = qs.filter((q) => idRe.test(q.id));
  if (catRe) qs = qs.filter((q) => catRe.test(q.category ?? ""));
}
for (const f of blindFiles) {
  const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
  let bq = validQuestions(JSON.parse(fs.readFileSync(p, "utf8")).questions);
  if (idRe) bq = bq.filter((q) => idRe.test(q.id));
  qs = qs.concat(bq);
}
const { perQuestion, overall } = await off.runOfflineExam({ ctx, questions: qs, today, modelCounter });
const statuses = opt("--status") ? new Set(opt("--status").split(",")) : null;
for (const r of perQuestion) {
  if (!showAll && r.status === "correct") continue;
  if (statuses && !statuses.has(r.status)) continue;
  realLog(`${r.status.padEnd(12)} ${r.id} | ${r.question}${r.status === "wrong" ? `  => ${String(r.got).slice(0, 160)}  [want ${String(r.expected).slice(0, 80)}]` : ""}${showAll && r.status === "correct" ? `  => ${String(r.got).slice(0, 120)}` : ""}`);
}
realLog(`TOTAL ${qs.length} q | no-model ${overall.answeredWithoutModel} | correct ${overall.correct} | wrong ${overall.wrong} | needs-model ${overall.needsModel} | clarified ${overall.clarified ?? 0} | skipped ${perQuestion.filter((r) => r.status === "skipped").length} | p95 ${overall.latencyMsP95}ms`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ overall, perQuestion }, null, 1));
process.exit(0);
