#!/usr/bin/env node
/**
 * R38: run a held-out question set against a SECOND tenant export, with a chosen industry pack, models blocked.
 *   TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/run-tenant-exam.mjs <export.json> <questions.json> <industry|none> [--list] [--json out.json]
 */
import fs from "node:fs";
import path from "node:path";
const off = await import("./offline-exam.mjs");
const args = process.argv.slice(2);
const [exportPath, qPath, industry] = args;
const list = args.includes("--list");
const ji = args.indexOf("--json");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness();
const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.resolve(exportPath), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${exportData.tenantKey}`, tenantName: exportData.tenantName });
if (industry && industry !== "none") {
  const _u = await lite.query(`UPDATE tenants SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{industry}', to_jsonb($1::text))`, [industry]);
  realLog("industry rows updated:", _u.affectedRows ?? _u.rowCount, "ctx keys:", Object.keys(ctx).join(","));
  try { const m = await import("../api/_lib/industry/index.js"); m.invalidateTenantIndustryCache?.(); } catch {}
}
const today = process.env.EXAM_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXAM_TODAY) ? process.env.EXAM_TODAY : "2026-09-25";
const { validQuestions } = await import("../api/_lib/scorecard/exam.js");
const qs = validQuestions(JSON.parse(fs.readFileSync(qPath, "utf8")).questions);
const { perQuestion, overall } = await off.runOfflineExam({ ctx, questions: qs, today, modelCounter });
realLog(`${path.basename(qPath)} [industry=${industry}]: ${qs.length} q | no-model ${overall.answeredWithoutModel} | correct ${overall.correct} | wrong ${overall.wrong} | needs-model ${overall.needsModel} | p95 ${overall.latencyMsP95}ms`);
if (list) for (const r of perQuestion) if (r.status !== "correct") realLog(`  ${r.status.padEnd(12)} ${r.id} | ${r.question}${r.status === "wrong" ? `  => ${String(r.got).slice(0, 110)}` : ""}`);
if (ji >= 0) fs.writeFileSync(args[ji + 1], JSON.stringify(perQuestion, null, 1));
process.exit(0);
