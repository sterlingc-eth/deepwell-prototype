#!/usr/bin/env node
// R32 debug: run a question through routes/analytics.js only (plan -> execute) against the golden tenant; prints the plan and answer.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const off = await import("./offline-exam.mjs");
const realLog = console.log; console.log = () => {}; console.warn = () => {};
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: "offline:probe", tenantName: "Probe" });
const { withTenant } = await import("../api/_lib/recordsStore.js");
const A = await import("../api/_lib/routes/analytics.js");
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: ctx.tenantName };
for (const q of process.argv.slice(2)) {
  let plan = null, ans = null, err = null;
  try { plan = await A.planAnalyticsQuestion(q, { today: "2026-09-25", withTenant, ctxArg }); } catch (e) { err = "plan:" + e.message; }
  try { ans = await A.runAnalyticsQuestion({ withTenant, ctxArg, question: q, today: "2026-09-25", noCache: true }); } catch (e) { err = "run:" + e.message; }
  realLog(q, "\n  plan:", JSON.stringify(plan), "\n  ans:", ans ? JSON.stringify({ kind: ans.kind, text: ans.text }) : null, err ? "\n  err: " + err : "");
}
process.exit(0);
