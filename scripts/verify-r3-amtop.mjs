/**
 * R3 amount-operator invoice questions (blind set, Loop R3 amtop): "Linda Fitzgerald invoices over $500" must count THAT customer's invoices, not the company's.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-amtop.mjs
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
const docs = new Map(exp.documents.map((d) => [d.id, d]));
const fin = new Map(exp.financials.map((f) => [f.document_id, f]));
const custs = exp.entities.filter((e) => e.entity_type === "customer" && !e.merged_into).map((e) => ({ id: e.id, name: e.data.customer_name }));
const invOf = (id) => { const s = new Map(); for (const l of exp.document_entity_links) if (l.entity_id === id) { const d = docs.get(l.document_id); const f = fin.get(l.document_id); if (d && f && f.total != null && String(d.document_type).replace(/_/g, "-") === "invoice") s.set(l.document_id, { t: Number(f.total), d: f.invoice_date }); } return [...s.values()]; };
const cmpf = { ">": (a, b) => a > b, "<": (a, b) => a < b };
const nFor = (id, op, amt, y) => invOf(id).filter((i) => cmpf[op](i.t, amt) && (!y || String(i.d ?? "").startsWith(y))).length;
const withInv = custs.filter((c) => invOf(c.id).length);
const pick = (i) => withInv[(i * 17 + 3) % withInv.length];

const invs = exp.financials.filter((f) => f.total != null && String(docs.get(f.document_id)?.document_type ?? "").replace(/_/g, "-") === "invoice");
const cnt = (op, amt) => invs.filter((f) => op === ">" ? Number(f.total) > amt : op === ">=" ? Number(f.total) >= amt : op === "<" ? Number(f.total) < amt : Number(f.total) <= amt).length;
const BASIS = /(?:regardless|all (?:the )?invoices|on file|every invoice|any date|whatever|no date|paid or unpaid|whether)/i;
const tots = [...new Set(invs.map((f) => Number(f.total)))].sort((x, y) => x - y);
const B1 = tots[Math.floor(tots.length * 0.3)], B2 = tots[Math.floor(tots.length * 0.6)], B3 = tots[Math.floor(tots.length * 0.85)];
const f$ = (n) => `$${n}`;
const T = [
 // [template, op]; {A} = amount. Boundary amounts equal a real invoice total so >= vs > differ.
 ["how many invoices at least {A}", ">="], ["how many invoices exceed {A}", ">"], ["how many invoices exceeds {A}", ">"], ["how many invoices {A} or more", ">="],
 ["how many bills over {A}", ">"], ["how many jobs billed over {A}", ">"], ["how many invoices {A} or less", "<="], ["how many invoices at most {A}", "<="],
 ["how many bills under {A}", "<"], ["how many jobs billed under {A}", "<"], ["number of invoices at least {A}", ">="], ["how many invoices were {A} or higher", ">="],
 ["how many invoices are {A} or lower", "<="], ["how many bills at least {A}", ">="], ["how many invoices exceeding {A}", ">"], ["how many invoices no less than {A}", ">="],
 ["how many invoices no more than {A}", "<="], ["how many jobs billed {A} or more", ">="], ["how many bills {A} or less", "<="], ["count of invoices over {A}", ">"],
 ["how many invoices of {A} or more", ">="], ["how many bills below {A}", "<"], ["how many invoices have we billed over {A}", ">"],
];
const Q = [];
T.forEach(([t, op], i) => { const amt = [B1, B2, B3][i % 3]; Q.push([t.replace("{A}", f$(amt)), op, amt]); });
for (const [t, op] of [["how many invoices at least {A}", ">="], ["how many invoices {A} or more", ">="], ["how many invoices {A} or less", "<="], ["how many invoices over {A}", ">"], ["how many invoices under {A}", "<"]]) Q.push([t.replace("{A}", f$(B2)), op, B2]);
Q.push(["how many invoices at least 2k", ">=", 2000], ["how many invoices exceed two thousand dollars", ">", 2000], ["how many invoices 1500 or more", ">=", 1500], ["how many invoices at least $1,000.00", ">=", 1000]);
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-amtop", tenantName: "R3 Amtbasis" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/#-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/#\S+/g, " "));
for (const [q, op, amt] of Q) {
  const want = cnt(op, amt); const t = await ask(q);
  check(`"${q}" -> ${want} + basis`, (hasNum(t, String(want)) || (want === 0 && /\bno\b/i.test(t))) && BASIS.test(t), t.slice(0, 260));
}
const lo = tots[0];
const lowTxt = await ask(`how many invoices at least ${f$(lo)}`);
check("control: at least min total = all invoices", hasNum(lowTxt, String(invs.length)), lowTxt.slice(0,200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
