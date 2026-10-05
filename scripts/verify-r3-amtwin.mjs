/**
 * R3 amount+date and technician+date (blind set, Loop 2026-10-03c): "invoices over $1000 in 2012" must apply the year; "how many calls did Danny do in 2012" must keep the person AND the year.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-amtwin.mjs
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

const invYears = [...new Set(invs.map((i) => i.d.slice(0, 4)))].sort();
const mid = invYears[Math.floor(invYears.length / 2)], first = invYears[0];
const CASES = [];
for (const y of [first, mid, "2012"]) {
  CASES.push([`how many invoices over $1000 in ${y}`, nInv(">", 1000, yr(y))]);
  CASES.push([`how many invoices over $3,000 in ${y}`, nInv(">", 3000, yr(y))]);
  CASES.push([`number of invoices under $2500 in ${y}`, nInv("<", 2500, yr(y))]);
  CASES.push([`how many invoices in ${y} are over $4000`, nInv(">", 4000, yr(y))]);
}
CASES.push(["how many invoices over $1000 since 2020-01-01", nInv(">", 1000, since("2020-01-01"))]);
CASES.push(["how many invoices above 5000 dollars after 2015", nInv(">", 5000, since("2016-01-01"))]);
CASES.push(["how many invoices over $1000 between 2010 and 2012", nInv(">", 1000, ["2010-01-01", "2012-12-31"])]);
CASES.push(["how many invoices under $3k in 2010", nInv("<", 3000, yr("2010"))]);
CASES.push(["how many invoices over three thousand dollars in 2012", nInv(">", 3000, yr("2012"))]);
const techs = [...new Set(jobs.map((j) => j.tech))];
const T = techs.includes("Danny Ochoa") ? "Danny Ochoa" : techs[0];
const tFirst = T.split(" ")[0];
const tYears = [...new Set(jobs.filter((j) => j.tech === T).map((j) => j.d.slice(0, 4)))].sort();
const tYr = tYears[0], tYr2 = tYears[Math.floor(tYears.length / 2)];
for (const y of [tYr, tYr2]) {
  CASES.push([`how many calls did ${T} do in ${y}`, nJob(T, yr(y))]);
  CASES.push([`how many jobs did ${tFirst} run in ${y}`, nJob(T, yr(y))]);
  CASES.push([`how many service visits has ${T} done in ${y}`, nJob(T, yr(y))]);
}
CASES.push([`how many calls did ${tFirst} do since 2020-01-01`, nJob(T, since("2020-01-01"))]);
CASES.push([`how many calls did ${T} do between ${tYr} and ${tYr2}`, nJob(T, [`${tYr}-01-01`, `${tYr2}-12-31`])]);
const nAll = exp.extractions.filter((x) => x.field_key === "technician" && (x.corrected_value || x.value) === T).length; // unwindowed = every technician entry (existing rule)
CASES.push([`how many calls did ${tFirst} do`, nAll]);
CASES.push([`how many calls did ${T} do`, nAll]);

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
// controls and must-not-claim: an unparseable date must never be answered as the all-time amount count
const all = nInv(">", 1000, allInv);
const tq = await ask("how many invoices over $1000 in Q3");
check("no all-time claim: invoices over $1000 in Q3", !hasNum(tq, String(all)) || all === 0, tq.slice(0, 200));
const tn = await ask(`how many invoices over $1000 for ${T}`);
check("no all-time claim: invoices over $1000 for a technician name", !hasNum(tn, String(all)) || all === 0, tn.slice(0, 200));
const ctl = await ask("how many invoices over $1000");
check(`control: undated amount count ${all}`, hasNum(ctl, String(all)), ctl.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
