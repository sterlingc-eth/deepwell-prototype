#!/usr/bin/env node
/**
 * R32: ask ad-hoc questions against the golden tenant through the production /api/ask handler, model blocked.
 *   TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/ask-probe.mjs "question one" "question two" [--file qs.txt] [--full]
 * Prints status (answer / no-answer / MODEL) + text (+ chips-relevant fields with --full).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const off = await import("./offline-exam.mjs");
const args = process.argv.slice(2);
const full = args.includes("--full");
const fi = args.indexOf("--file");
let qs = args.filter((a, i) => !a.startsWith("--") && (fi < 0 || i !== fi + 1));
if (fi >= 0) qs = qs.concat(fs.readFileSync(args[fi + 1], "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
if (!process.env.DEBUG) { console.warn = () => {}; console.error = () => {}; }
await off.installPgHarness();
const counter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: `offline:${exportData.tenantKey ?? "probe"}`, tenantName: "Probe" });
const today = process.env.EXAM_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXAM_TODAY) ? process.env.EXAM_TODAY : "2026-09-25";
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: handler } = await import("../api/ask.js");
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null };
for (const q of qs) {
  counter.n = 0;
  const t0 = Date.now();
  const r = await askViaHandler({ handler, auth, question: q, today });
  const d = r.data;
  const tag = counter.n > 0 ? "MODEL" : d?.kind ?? "error";
  realLog(`[${tag}] ${q}\n    -> ${String(d?.text ?? r.error ?? "").slice(0, full ? 600 : 220)}  (${Date.now() - t0}ms)`);
  if (full && d) realLog("    ", JSON.stringify({ kind: d.kind, facts: d.facts?.length, records: d.records?.length, interpretation: d.interpretation, typo: d.typoResolution, clarify: d.clarify }));
}
process.exit(0);
