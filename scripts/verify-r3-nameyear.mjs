/**
 * R3 trailing year after a name/tech (Loop 2026-10-03d): "invoices for Linda Fitzgerald in 2009" must apply the year, not look for a customer named "... In 2009"; "tickets for tech Danny in 2011"; "which tech did the most calls in 2012". Kill switch DONOVAN_NAME_YEAR=0.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-nameyear.mjs
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
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); const o = ex.get(x.document_id); if (!(x.field_key in o)) o[x.field_key] = x.corrected_value || x.value; }
const fin = new Map(exp.financials.map((f) => [f.document_id, f]));
const custs = exp.entities.filter((e) => e.entity_type === "customer" && !e.merged_into && e.data?.customer_name);
const docDate = (d) => (ex.get(d.id)?.service_date || fin.get(d.id)?.invoice_date || "").slice(0, 10);
const docsOf = (c) => { const ents = new Set(exp.entities.filter((x) => x.id === c.id || x.customer_id === c.id).map((x) => x.id)); const ids = new Set(exp.document_entity_links.filter((l) => ents.has(l.entity_id)).map((l) => l.document_id)); return exp.documents.filter((d) => ids.has(d.id)); };
const nameCount = new Map(); for (const c of custs) nameCount.set(c.data.customer_name, (nameCount.get(c.data.customer_name) || 0) + 1);
const uniq = custs.filter((c) => nameCount.get(c.data.customer_name) === 1 && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(c.data.customer_name));
const cnt = (c, type, y) => docsOf(c).filter((d) => d.document_type === type && docDate(d).startsWith(y)).length;
const CASES = [];
const TYPES = [["invoice", ["invoices", "invoice"]], ["service-ticket", ["tickets", "service tickets"]], ["work-order", ["work orders"]], ["startup-sheet", ["startup sheets"]]];
const picked = [];
for (const c of uniq) { const ds = docsOf(c).filter((d) => d.document_type === "invoice" && docDate(d)); if (ds.length >= 1 && picked.length < 5 && !picked.some((p) => p.c.data.customer_name === c.data.customer_name)) picked.push({ c, y: docDate(ds[0]).slice(0, 4) }); }
const lc = picked.find((p) => p.c.data.customer_name === "Linda Fitzgerald") ?? picked[0];
let k = 0;
for (const { c, y } of picked) {
  const n = c.data.customer_name;
  for (const [type, words] of TYPES) { const w = words[k++ % words.length]; CASES.push([`${w} for ${n} in ${y}`, cnt(c, type, y)]); }
  CASES.push([`invoices for ${n} in 1999`, 0]); // honest zero
  CASES.push([`invioces for ${n} during ${y}`, cnt(c, "invoice", y)]); // typo
}
CASES.push([`show me invoices for ${lc.c.data.customer_name} in the year ${lc.y}`, cnt(lc.c, "invoice", lc.y)]);
CASES.push([`work orders for ${lc.c.data.customer_name} in ${lc.y}?`, cnt(lc.c, "work-order", lc.y)]);
// whole-shop typed windows with no customer
const typeYr = (type, y) => exp.documents.filter((d) => d.document_type === type && docDate(d).startsWith(y)).length;
const yrsOf = (type) => [...new Set(exp.documents.filter((d) => d.document_type === type && docDate(d)).map((d) => docDate(d).slice(0, 4)))].sort();
const poY = yrsOf("purchase-order").pop() ?? "2026", inY = yrsOf("inspection-report").pop() ?? "2026";
CASES.push([`inspection reports for ${inY}`, typeYr("inspection-report", inY)]);
CASES.push([`purchase orders for ${poY}`, typeYr("purchase-order", poY)]);
// technician + year
const tkt = exp.documents.filter((d) => d.document_type === "service-ticket" && ex.get(d.id)?.technician && docDate(d));
const techs = {}; for (const d of tkt) { const t = ex.get(d.id).technician; (techs[t] ??= []).push(docDate(d).slice(0, 4)); }
const T = techs["Danny Ochoa"] ? "Danny Ochoa" : Object.keys(techs)[0];
const tY = techs[T][0];
const calls = (t, y) => exp.documents.filter((d) => ex.get(d.id)?.technician === t && docDate(d).startsWith(y)).length;
const tFirst = T.split(" ")[0];
const TECH = [
  [`tickets for tech ${tFirst} in ${tY}`, calls(T, tY)],
  [`service tickets for technician ${T} in ${tY}`, calls(T, tY)], // answered as that technician's jobs in the year (every record naming them)
];
// busiest tech in a year (by technician extractions on dated docs)
const byYear = {}; for (const d of exp.documents) { const t = ex.get(d.id)?.technician, dd = docDate(d); if (t && dd) { byYear[dd.slice(0, 4)] ??= {}; byYear[dd.slice(0, 4)][t] = (byYear[dd.slice(0, 4)][t] || 0) + 1; } }
const topFor = (y) => { const e = Object.entries(byYear[y] ?? {}).sort((a, b) => b[1] - a[1]); return e.length && e[0][1] !== e[1]?.[1] ? e[0] : null; };
const TOP = [...new Set([...Object.keys(byYear)])].map((y) => [y, topFor(y)]).filter((x) => x[1]).slice(0, 3);
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-nameyear", tenantName: "R3 Nameyear" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/\b(?:19|20)\d\d(?:-\d\d(?:-\d\d)?)?\b/g, " "));
const badName = (t) => /couldn't find a customer named[^.]*\b(?:in|during|for)\b/i.test(t) || /customer named[^.]*\b(?:19|20)\d\d\b/.test(t);

for (const [q, want] of [...CASES, ...TECH]) {
  const t = await ask(q);
  const ok = !badName(t) && (want === 0 ? /\b(?:0|no|none|zero|nothing)\b/i.test(t) : hasNum(t, String(want)));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 200));
}
for (const [y, [t, n]] of TOP) {
  const a = await ask(`which tech did the most calls in ${y}`);
  check(`"which tech did the most calls in ${y}" -> ${t} (${n})`, a.includes(t) && !a.includes("ignores") , a.slice(0, 200));
}
// negative controls: these must NOT change
const allInv = docsOf(lc.c).filter((d) => d.document_type === "invoice").length;
const c1 = await ask(`invoices for ${lc.c.data.customer_name}`);
check(`control: undated "invoices for ${lc.c.data.customer_name}" lists all ${allInv}`, hasNum(c1, String(allInv)), c1.slice(0, 200));
const c2 = await ask("invoices for Zzyzx Quimby in 2009");
check("control: unknown name + year still says no such customer, year not in the name", /couldn't find a customer named Zzyzx Quimby\b(?! In)/i.test(c2) && !/Quimby In 2009/i.test(c2), c2.slice(0, 200));
const c3 = await ask(`how many invoices in ${lc.y}`);
check(`control: shop-wide "how many invoices in ${lc.y}" unchanged`, hasNum(c3, String(typeYr("invoice", lc.y))), c3.slice(0, 200));
const c4 = await ask("invoices for 4410 E Baseline Rd");
check("control: address with digits is not treated as a year", !badName(c4), c4.slice(0, 200));
const c5 = await ask("invoices for Zzyzx Quimby in Q3");
check("control: unreadable date after unknown name never claims a count", !/\b\d+ invoices on file\b/.test(c5), c5.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
