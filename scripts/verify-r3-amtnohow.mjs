/**
 * R3 amount questions without how-many + invoice dollar totals (blind set, Loop 2026-10-03d): "invoices over $1000 in 2012" must apply the year; "how many calls did Danny do in 2012" must keep the person AND the year.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-amtnohow.mjs
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
const invs = exp.financials.filter((f) => f.doc_kind === "invoice" && f.total != null && f.invoice_date).map((f) => ({ d: f.invoice_date, t: Number(f.total) }));
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); const o = ex.get(x.document_id); if (!(x.field_key in o)) o[x.field_key] = x.corrected_value || x.value; }
const jobs = [...ex.values()].filter((f) => f.technician && f.service_date).map((f) => ({ tech: f.technician, d: f.service_date.slice(0, 10) }));
const inW = (d, [a, b]) => d >= a && d <= b;
const yr = (y) => [`${y}-01-01`, `${y}-12-31`];
const since = (d) => [d, "9999-12-31"];
const nInv = (op, amt, w) => invs.filter((i) => inW(i.d, w) && (op === ">" ? i.t > amt : i.t < amt)).length;
const allInv = [ "0000", "9999-12-31" ];
const nJob = (tech, w) => jobs.filter((j) => j.tech === tech && inW(j.d, w)).length;

const sumInv = (w) => invs.filter((i) => inW(i.d, w)).reduce((s, i) => s + i.t, 0);
const nIn = (w) => invs.filter((i) => inW(i.d, w)).length;
const CASES = [];
const ys = ["2010", "2013", "2018"];
for (const y of ys) {
  CASES.push([`invoices over $500 in ${y}`, nInv(">", 500, yr(y))]);
  CASES.push([`invoices above 2000 dollars in ${y}`, nInv(">", 2000, yr(y))]);
  CASES.push([`invoices under $1,500 in ${y}`, nInv("<", 1500, yr(y))]);
  CASES.push([`which invoices are over $3000 in ${y}`, nInv(">", 3000, yr(y))]);
}
CASES.push(["invoices over $1000 since 2020-01-01", nInv(">", 1000, since("2020-01-01"))]);
CASES.push(["list invoices over $2,000 between 2010 and 2012", nInv(">", 2000, ["2010-01-01", "2012-12-31"])]);
CASES.push(["invoices more than 800 dollars in 2012", nInv(">", 800, yr("2012"))]);
CASES.push(["show me invoices below $4k in 2015", nInv("<", 4000, yr("2015"))]);
const SUMS = [];
for (const y of ["2012", "2009", "2019"]) {
  SUMS.push([`total of invoices in ${y}`, sumInv(yr(y)), nIn(yr(y))]);
  SUMS.push([`what is the total of invoices in ${y}`, sumInv(yr(y)), nIn(yr(y))]);
}
SUMS.push(["total value of invoices in 2014", sumInv(yr("2014")), nIn(yr("2014"))]);
SUMS.push(["total of all invoices in 2021", sumInv(yr("2021")), nIn(yr("2021"))]);
SUMS.push(["total invoiced in 2016", sumInv(yr("2016")), nIn(yr("2016"))]);
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-amtwin", tenantName: "R3 Amtwin" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " "));

for (const [q, want] of CASES) {
  const t = await ask(q);
  const ok = want === 0 ? /\b(?:0|no|none|zero|nothing)\b/i.test(t) : hasNum(t, String(want));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 200));
}
const money = (n) => { const f = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return [f, f.replace(/\.00$/, ""), Math.round(n).toLocaleString("en-US")]; };
for (const [q, want, n] of SUMS) {
  const t = await ask(q);
  check(`"${q}" -> $${want.toFixed(2)} (${n} invoices)`, money(want).some((m) => t.includes("$" + m)), t.slice(0, 200));
}
// controls / must-not-claim
const tq = await ask("invoices over $1000 in Q3");
check("no all-time claim: invoices over $1000 in Q3 (unreadable date)", !hasNum(tq, String(nInv(">", 1000, allInv))) || nInv(">", 1000, allInv) === 0, tq.slice(0, 200));
const tn = await ask("invoices over $1000 for Danny Ochoa in 2012");
check("name qualifier is not dropped", !hasNum(tn, String(nInv(">", 1000, yr("2012")))) || nInv(">", 1000, yr("2012")) === 0 || /danny|ochoa/i.test(tn), tn.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
