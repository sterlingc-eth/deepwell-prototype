/**
 * R3 loop: three small honest-answer rules. Blind set written BEFORE the change. Golden tenant, PGlite, model blocked.
 *  1. "total of all invoices" (and spellings) -> the invoiced dollar total, not a document count / "customer named Total Of All"
 *  2. "how many <equipment type incl. rtu>" -> the equipment count carries a plain "type isn't recorded" note
 *  3. "list all customers' emails" (bulk contact dump) -> declined with a pointer; single-customer / count / missing questions untouched
 *   npx tsx scripts/verify-r3-invoice-total-type-bulk.mjs   (package.json: verify:r3-bulk)
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
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-paid", tenantName: "R3 Paid" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };

const has$ = (t, n) => t.replace(/,/g, "").includes(money(n).replace(/,/g, ""));
const docType = new Map(exp.documents.map((d) => [d.id, d.document_type]));
const exp2 = exp;
const total = exp2.financials.filter((f) => docType.get(f.document_id) === "invoice" && f.total != null).reduce((a, f) => a + Number(f.total), 0);
const TOT = ["total of all invoices", "what's the total of all the invoices", "sum of all invoices", "add up all the invoices", "grand total of invoices", "total value of all invoices we have", "whats the total on every invoice", "total invoiced", "total of all our invoices?", "tally up all invoices"];
for (const q of TOT) { const t = await ask(q); check(`invoice total: "${q}"`, has$(t, total) && /\$/.test(t), t.slice(0, 200)); }
const TYPE = ["how many rtu units", "how many rtus", "rtu count", "number of rtu units", "how many RTUs do we have", "count of split systems", "how many furnaces", "how many heat pumps", "how many package units"];
for (const q of TYPE) { const t = await ask(q); check(`type count noted: "${q}"`, /\b\d+\b/.test(t) && /isn'?t recorded|not recorded|not tracked/i.test(t), t.slice(0, 220)); }
const BULK = ["list all customers emails", "list all customer emails", "email addresses of all customers", "show all customers emails", "dump customer emails", "export every customer's email", "what are all the customer emails", "give me the phone numbers of all clients", "all customers phone numbers"];
for (const q of BULK) { const t = await ask(q); check(`bulk contact declined: "${q}"`, /can't|won't|not going to/i.test(t) && /specific customer|one customer/i.test(t) && !/@/.test(t), t.slice(0, 200)); }
const KEEP = [["how many customers", /\b\d+\b/, /won't|can't list/i], ["how many customers have an email on file", null, /won't dump|can't list/i], ["what is Thomas Mercer's email", null, /won't dump|can't list/i], ["which customers have no email", null, /won't dump|can't list/i], ["how many invoices", /120/, /won't dump/i], ["total invoices for Thomas Mercer", null, /rtu|isn't recorded/i], ["how many units are under warranty", /\b\d+\b/, /isn'?t recorded/i], ["how many customers named Tovar", null, /won't dump/i]];
for (const [q, must, mustNot] of KEEP) { const t = await ask(q); check(`unchanged: "${q}"`, (!must || must.test(t)) && !mustNot.test(t) && !(q.includes("invoices for") && has$(t, total)), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
