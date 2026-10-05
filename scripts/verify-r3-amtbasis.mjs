/**
 * R3 person + amount invoice questions (blind set, Loop R3 amtbasis): "Linda Fitzgerald invoices over $500" must count THAT customer's invoices, not the company's.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-amtbasis.mjs
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
const Q = [
 ["how many invoices over $500", ">", 500], ["how many invoices over 500", ">", 500], ["how many invoices under $1000", "<", 1000], ["how many invoices under $1,000", "<", 1000],
 ["how many invoices at least $2000", ">=", 2000], ["how many invoices more than $3000", ">", 3000], ["how many invoices less than $750", "<", 750], ["how many invoices above $1500", ">", 1500],
 ["how many bills over $500", ">", 500], ["how many bills under $200", "<", 200], ["how many jobs billed over $1000", ">", 1000], ["how many jobs billed under $400", "<", 400],
 ["number of invoices over $250", ">", 250], ["count of invoices greater than $5000", ">", 5000], ["how many invoices are over $500?", ">", 500], ["how many invoces over $500", ">", 500],
 ["how many invoices ovr $800", ">", 800], ["how many invoices below $100", "<", 100], ["how many invoices at least 100 dollars", ">=", 100], ["how many invoices exceed $2500", ">", 2500],
 ["How many invoices over $600 do we have", ">", 600], ["how many invoices were over $900", ">", 900], ["how many invoices $4000 or more", ">=", 4000], ["how many invoices under $50", "<", 50],
];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-personamt", tenantName: "R3 Amtbasis" });
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
const tp = await ask("how many invoices over $500 for Linda Fitzgerald");
check("control: person answer has own wording", /Fitzgerald/.test(tp), tp.slice(0, 200));
const twin = await ask("how many invoices over $500 in 2012");
check("control: date window unchanged", /invoices dated in 2012|No invoices on file in 2012/.test(twin), twin.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
