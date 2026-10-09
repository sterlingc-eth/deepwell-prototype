#!/usr/bin/env node
/**
 * R5 exam runner (offline). Loads the organization's export into an in-memory PGlite database, asks every dev + sealed question (and paraphrase variants) through the
 * REAL /api/ask handler with the model blocked, and writes an answers file [{question, answer_text, facts, kind}] for `exam-build.mjs score|diff`.
 * Prints counts only (never a question). Run it before and after a code change, with different --answers files, then `exam-build.mjs diff`.
 *   node scripts/exam-run-offline.mjs --export <export.json> --out exam-out/<org> --answers exam-out/<org>/answers-base.json [--no-variants] [--today 2026-10-07]
 */
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2); const arg = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const exportPath = arg("--export"), outDir = arg("--out"), answersPath = arg("--answers"), TODAY = arg("--today", "2026-10-07");
if (!exportPath || !outDir || !answersPath) { console.error("usage: exam-run-offline.mjs --export F --out DIR --answers F [--no-variants]"); process.exit(2); }
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};
const off = await import("./offline-exam.mjs");
await off.installPgHarness(); await off.installModelBlock();
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));
// --pick-stub correct|none|<liar kind>: turn the R5 organization-driven pick ON with a scripted stand-in for the model (NOT a real model; real-model accuracy stays unmeasured)
const pickStub = arg("--pick-stub");
if (pickStub) {
  process.env.DONOVAN_MENU_PICK = "1";
  const { setOrgPickTransport } = await import("../api/_lib/records/orgPickCall.js");
  const stubs = await import("./lib/orgpick-stubs.mjs");
  const { pageLabelLines, valueKind } = await import("../api/_lib/records/orgMenu.js");
  const names = new Set();
  for (const e of data.entities ?? []) if (e.entity_type === "customer" && e.data?.customer_name) names.add(e.data.customer_name);
  for (const f of data.financials ?? []) { if (f.vendor_name) names.add(f.vendor_name); if (f.customer_name) names.add(f.customer_name); }
  for (const pg of data.pages ?? []) for (const l of pageLabelLines(pg.text)) if (valueKind(l.value) === "name") names.add(l.value);
  setOrgPickTransport(pickStub === "correct" ? stubs.correctStub({ names: [...names] }) : stubs.liar(pickStub));
}
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: "offline:exam", tenantName: "exam" })).ctx;
const qs = new Set();
for (const side of ["dev", "sealed"]) { const p = path.join(outDir, `${side}.json`); if (!fs.existsSync(p)) continue; for (const it of JSON.parse(fs.readFileSync(p, "utf8")).items) { qs.add(it.question); if (!argv.includes("--no-variants")) for (const v of it.variants ?? []) qs.add(v.question); } }
const answers = []; let errors = 0;
for (const q of qs) {
  try {
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: "exam", userId: null }, question: q, today: TODAY });
    answers.push({ question: q, answer_text: String(r.data?.text ?? ""), facts: (r.data?.facts ?? []).map((f) => ({ label: f.label ?? "", value: f.value ?? "" })), kind: r.data?.kind ?? null });
  } catch (e) { errors++; answers.push({ question: q, answer_text: "", facts: [], kind: "error" }); }
}
fs.writeFileSync(answersPath, JSON.stringify(answers, null, 1));
realLog(`asked ${answers.length} questions (${errors} errors) -> ${answersPath}`);
process.exit(0);
