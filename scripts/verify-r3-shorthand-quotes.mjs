/**
 * R4 loop: blind set written BEFORE the change. Golden tenant, PGlite, model blocked.
 *  1. quote-total shorthand ("total of all quotes", "sum quotes", "how much in quotes") -> the QUOTED dollar total, never the invoiced total / a customer lookup
 *  2. count shorthand ("num of invoices", "# of quotes", "rtu units?") -> counts (equipment type note for rtu)
 *  3. mini split / ductless / air handler counts -> equipment count with the "type isn't recorded" note
 *  4. superlative/status words ("biggest invoice", "overdue invoices") are never read as a customer name
 *   npx tsx scripts/verify-r3-shorthand-quotes.mjs   (package.json: verify:r3-shorthand)
 * Kill switches: DONOVAN_PHRASE_REWRITE_R4=0, DONOVAN_NAME_DESCRIPTOR_GUARD=0, DONOVAN_EQUIP_TYPE_SYNONYMS=0
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
const qt = exp.financials.filter((f) => docType.get(f.document_id) === "proposal-quote" && f.total != null).reduce((a, f) => a + Number(f.total), 0);
const inv = exp.financials.filter((f) => docType.get(f.document_id) === "invoice" && f.total != null).reduce((a, f) => a + Number(f.total), 0);
for (const q of ["total of all quotes", "total of all the quotes we sent", "sum quotes", "all quotes total", "total quotes", "how much in quotes", "how much are all the quotes worth", "quotes total", "tally up all quotes", "grand total of quotes"]) {
  const t = await ask(q); check(`quote total: "${q}"`, has$(t, qt) && !has$(t, inv) && !/couldn't find a customer/i.test(t), t.slice(0, 200));
}
for (const [q, n, w] of [["num of invoices", 120, "invoice"], ["# of quotes", 60, "quote"], ["number of quotes", 60, "quote"], ["invoice count", 120, "invoice"], ["quotes count", 60, "quote"], ["no. of invoices", 120, "invoice"], ["count of invoices", 120, "invoice"]]) {
  const t = await ask(q); check(`count: "${q}"`, new RegExp(`\\b${n}\\b`).test(t) && new RegExp(w, "i").test(t) && !/couldn't find a customer/i.test(t), t.slice(0, 200));
}
for (const q of ["rtu units?", "rtus?", "how many mini splits", "how many mini-splits", "how many ductless", "how many air handlers", "how many package units", "mini splits count", "number of mini splits"]) {
  const t = await ask(q); check(`type count noted: "${q}"`, /\b132\b/.test(t) && /isn'?t recorded|not recorded/i.test(t), t.slice(0, 220));
}
for (const q of ["biggest invoice", "largest invoice", "smallest invoice", "oldest invoice", "newest invoice", "overdue invoices", "accepted quotes", "expired quotes", "avg quote", "average invoice size", "num of techs", "whats the biggest invoice"]) {
  const t = await ask(q); check(`not a customer name: "${q}"`, !/couldn't find a customer|is not on file as a customer/i.test(t), t.slice(0, 200));
}
const KEEP = [["total of all invoices", (t) => has$(t, inv)], ["how many invoices", (t) => /\b120\b/.test(t)], ["how many quotes", (t) => /\b60\b/.test(t)], ["how many customers", (t) => /\b120\b/.test(t)], ["total value of our quotes", (t) => has$(t, qt)], ["what is Thomas Mercer's email", (t) => /mercer|@|email/i.test(t) && !/won't list/i.test(t)], ["total invoices for Thomas Mercer", (t) => /2,937|2937/.test(t)], ["email addresses of all customers", (t) => /won't list|can't|not going to/i.test(t) && !/@/.test(t)], ["how many heat pumps", (t) => /\b132\b/.test(t)], ["invoice 1001", (t) => /No invoice 1001/.test(t)]];
for (const [q, f] of KEEP) { const t = await ask(q); check(`unchanged: "${q}"`, f(t), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
