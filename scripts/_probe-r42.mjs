// R42 probe: node scripts/_probe-r42.mjs <export.json> <industry> "q1" "q2" ... ; prints route lines + answer
import fs from "node:fs"; import path from "node:path";
const off = await import("./offline-exam.mjs");
const [exportPath, industry, ...qs] = process.argv.slice(2);
const realLog = console.log; const lines = [];
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"route"')) lines.push(a[0]); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); const modelCounter = await off.installModelBlock(); const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.resolve(exportPath), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${exportData.tenantKey}`, tenantName: exportData.tenantName });
await lite.query(`UPDATE tenants SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{industry}', to_jsonb($1::text))`, [industry]);
try { const m = await import("../api/_lib/industry/index.js"); m.invalidateTenantIndustryCache?.(); } catch {}
const questions = qs.map((t, i) => ({ id: `p${i}`, text: t, category: "probe", cmp: "honest-zero", oracle: { sql: "SELECT 0 AS n", params: [] } }));
const { perQuestion } = await off.runOfflineExam({ ctx, questions, today: "2026-09-25", modelCounter });
for (const r of perQuestion) { realLog("Q:", r.question, "->", r.status, "|", String(r.got ?? "").slice(0, 200)); }
realLog(lines.join("\n"));
process.exit(0);
