#!/usr/bin/env node
/** Limit-test runner: ask each question in a JSON file ([{id,text,context?}] or {questions:[...]}) through the real /api/ask handler, model blocked.
 *  node scripts/lt-run.mjs in.json out.json   (TZ=America/Phoenix EXAM_TODAY=2026-09-25) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const off = await import("./offline-exam.mjs");
const [inFile, outFile] = process.argv.slice(2);
const realLog = console.log;
console.log = () => {}; console.warn = () => {}; console.error = () => {};
await off.installPgHarness();
const modelCounter = await off.installModelBlock();
const lite = await off.createPGlite();
await off.setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const { ctx } = await off.loadExportIntoNewTenant(lite, exportData, { tenantKey: "offline:lt-donovan", tenantName: "LT" });
const today = process.env.EXAM_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXAM_TODAY) ? process.env.EXAM_TODAY : "2026-09-25";
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const j = JSON.parse(fs.readFileSync(inFile, "utf8"));
const qs = Array.isArray(j) ? j : j.questions;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const turnFrom = (question, data) => {
  const seen = new Set(); const re = [];
  for (const r of data?.records ?? []) { if ((r.type !== "customer" && r.type !== "unit") || seen.has(r.id)) continue; seen.add(r.id); re.push({ type: r.type, id: r.id, label: r.label, ...(r.sublabel ? { sublabel: r.sublabel } : {}) }); if (re.length >= 6) break; }
  return { question, askedAt: new Date().toISOString(), ...(re.length ? { resolvedEntities: re } : {}), ...(/which one did you mean|which one\?/i.test(data?.text ?? "") ? { pendingClarification: true } : {}) };
};
const askOne = async (text, context) => {
  modelCounter.n = 0;
  const t0 = Date.now();
  let r;
  try {
    r = await askViaHandler({ handler: context ? (req, res) => { req.body.conversationContext = context; return askHandler(req, res); } : askHandler, auth, question: text, today });
  } catch (e) { r = { status: 0, data: null, error: "threw:" + (e?.message ?? e) }; }
  return { needsModel: modelCounter.n > 0, status: r.status, error: r.error, ms: Date.now() - t0, data: r.data };
};
const out = [];
for (const q of qs) {
  let context = null;
  for (const prev of q.thread ?? []) { const pr = await askOne(prev, context); context = { turns: [...(context?.turns ?? []), turnFrom(prev, pr.data)] }; }
  const r = await askOne(q.text, context);
  out.push({ id: q.id, text: q.text, thread: q.thread, ...r });
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
realLog(`ran ${out.length} -> ${outFile}; needsModel ${out.filter((x) => x.needsModel).length}; errors ${out.filter((x) => x.error && !x.needsModel).length}`);
process.exit(0);
