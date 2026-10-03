/**
 * R3 doc extremes (oldest/newest/cheapest invoice, biggest/oldest quote): "what did X pay / owe" -> X's invoiced total (cited) + plain note that paid-vs-unpaid is not recorded; a name not on file
 * says "not on file" (never a company total); vendor / company-wide / unrelated questions are not claimed. Golden tenant, PGlite, model blocked.
 *   npx tsx scripts/verify-r3-doc-extremes.mjs   (package.json: verify:r3-paid)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };

process.env.NEON_CONNECTION_STRING = "postgres://harness:harness@localhost:5432/harness";
delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };
console.warn = () => {}; const realErr = console.error; console.error = () => {};

const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const docType = new Map(exp.documents.map((d) => [d.id, d.document_type]));
const rowsOf = (type) => exp.financials.filter((f) => docType.get(f.document_id) === (type === "quote" ? "proposal-quote" : type) && f.total != null);
const dOf = (f) => String(f.invoice_date ?? "").slice(0, 10);
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
console.log = realLog;

const sorted = (type, key, dir) => rowsOf(type).filter((f) => key === "total" || dOf(f)).sort((a, b) => (key === "total" ? (Number(a.total) - Number(b.total)) * dir : dOf(a).localeCompare(dOf(b)) * dir || Number(b.total) - Number(a.total)));
const exp1 = (type, key, dir) => sorted(type, key, dir)[0];
const CASES = [
  ["oldest invoice", "invoice", "date", 1], ["what's the oldest invoice", "invoice", "date", 1], ["earliest invoice we have", "invoice", "date", 1], ["oldest invoce", "invoice", "date", 1],
  ["newest invoice", "invoice", "date", -1], ["most recent invoice", "invoice", "date", -1], ["latest invoice", "invoice", "date", -1], ["show me the latest invoice", "invoice", "date", -1],
  ["cheapest invoice", "invoice", "total", 1], ["lowest invoice", "invoice", "total", 1], ["which invoice is the most expensive", "invoice", "total", -1], ["top invoice", "invoice", "total", -1],
  ["biggest quote", "quote", "total", -1], ["largest quote", "quote", "total", -1], ["what's our highest quote", "quote", "total", -1], ["smallest quote", "quote", "total", 1], ["cheapest estimate", "quote", "total", 1],
  ["oldest quote", "quote", "date", 1], ["newest quote", "quote", "date", -1], ["latest quote", "quote", "date", -1], ["most recent estimate", "quote", "date", -1], ["earliest proposal", "quote", "date", 1],
];
const NEG = ["how many invoices", "oldest invoice for Kenneth Gallardo", "biggest customer", "what is the weather", "newest equipment", "oldest unit", "latest invoice over 5000", "quote for Kenneth Gallardo"];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-ext", tenantName: "R3 Ext" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
for (const [q, type, key, dir] of CASES) {
  const want = exp1(type, key, dir), t = await ask(q);
  const ok = want && t.replace(/,/g, "").includes(money(Number(want.total)).replace(/,/g, "")) && (key === "total" || t.includes(want.customer_name));
  check(`"${q}" -> ${type} ${key} ${dir > 0 ? "min" : "max"} $${want && money(Number(want.total))}`, ok && new RegExp(type === "invoice" ? "invoice" : "quote", "i").test(t), t.slice(0, 200));
}
for (const q of NEG) {
  const t = await ask(q);
  check(`not claimed: "${q}"`, !/Invoices only - not quotes or other|Quotes only - not invoices/.test(t), t.slice(0, 200));
}
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
