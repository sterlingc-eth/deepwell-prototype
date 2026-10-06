/**
 * R3 loop r38 (blind, written BEFORE the change): a bare doc-type count ("how many agreements/work orders/service tickets/inspection reports")
 * must name the type, not "documents" ("You have 27 documents."). Counts derived from the golden export. Model blocked.   npx tsx scripts/verify-r3-loop-doctypenoun.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };
process.env.NEON_CONNECTION_STRING = "postgres://harness:harness@localhost:5432/harness";
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log; console.warn = () => {}; const realErr = console.error; console.error = () => {};
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const n = (t) => exp.documents.filter((d) => d.document_type === t).length;
const CASES = [
  ["how many agreements", n("maintenance-agreement"), /agreement/i], ["how many permits", n("permit"), /permit/i], ["how many work orders", n("work-order"), /work order/i],
  ["how many service tickets", n("service-ticket"), /ticket/i], ["inspection reports count", n("inspection-report"), /inspection/i], ["startup sheets count", n("startup-sheet"), /startup/i],
  ["how many proposals", n("proposal-quote"), /proposal|quote/i], ["how many dispatch notes", n("dispatch-note"), /dispatch/i],
];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-doctypenoun", tenantName: "R3 DocNoun" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
for (const [q, want, re] of CASES) { const t = await ask(q); check(`"${q}" -> ${want} named`, !/Processing failed/.test(t) && t.includes(String(want)) && re.test(t) && !/\bdocuments\b/i.test(t), t.slice(0, 200)); }
for (const q of ["how many documents", "how many documents do we have"]) { const t = await ask(q); check(`control "${q}" still documents`, /documents/i.test(t) && /\b\d+ documents/.test(t), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
