/**
 * R3 date + document-type counts (blind set, Loop 2026-10-03b): "how many <doc type> on <date> and <date>", "<doc type> in 2026-09",
 * undated types (permits, dispatch notes, agreements) with a date window, and ambiguous numeric dates. Expected values are computed from
 * the golden export (scripts/golden/golden-export.json). Model blocked.   npx tsx scripts/verify-r3-datedocs.mjs   (verify:r3-datedocs)
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`); };
process.env.NEON_CONNECTION_STRING = "postgres://harness:harness@localhost:5432/harness"; delete process.env.ANTHROPIC_API_KEY;
const realLog = console.log; console.warn = () => {}; const realErr = console.error; console.error = () => {};
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); ex.get(x.document_id)[x.field_key] = x.value; }
const dtype = new Map(exp.documents.map((d) => [d.id, d.document_type]));
const datesOf = (type, field) => [...ex].filter(([id, f]) => dtype.get(id) === type && f[field]).map(([, f]) => f[field]);
const typeCount = (type) => exp.documents.filter((d) => d.document_type === type).length;
const inAny = (arr, wins) => arr.filter((d) => wins.some(([a, b]) => d >= a && d <= b)).length;
const day = (d) => [d, d]; const year = (y) => [`${y}-01-01`, `${y}-12-31`]; const month = (y, m) => [`${y}-${String(m).padStart(2, "0")}-01`, `${y}-${String(m).padStart(2, "0")}-31`];
const us = (d) => { const [y, m, dd] = d.split("-"); return `${+m}/${+dd}/${y}`; };
const dot = (d) => d.replace(/-/g, ".");
const TYPES = [
  ["service-ticket", "service_date", ["service tickets", "tickets"]], ["work-order", "service_date", ["work orders"]], ["startup-sheet", "service_date", ["startup sheets"]],
  ["inspection-report", "service_date", ["inspection reports"]], ["proposal-quote", "invoice_date", ["quotes", "proposals"]], ["purchase-order", "invoice_date", ["purchase orders"]],
  ["invoice", "invoice_date", ["invoices"]], ["warranty-registration", "warranty_registered_date", ["warranty registrations"]],
];
const CASES = []; // [question, expectedCount, totalOfType]
for (const [type, field, names] of TYPES) {
  const ds = [...new Set(datesOf(type, field))].sort(); if (ds.length < 3) continue;
  const total = type === "warranty-registration" ? 52 : typeCount(type);
  const [d1, d2, d3] = [ds[0], ds[Math.floor(ds.length / 2)], ds[ds.length - 1]];
  const nm = names[0];
  CASES.push([`how many ${nm} on ${d1} and ${d2}`, inAny(datesOf(type, field), [day(d1), day(d2)]), total]);
  CASES.push([`how many ${names[names.length - 1]} on ${us(d3)} and ${us(d1)}`, inAny(datesOf(type, field), [day(d3), day(d1)]), total]);
  CASES.push([`number of ${nm} on ${dot(d2)} and ${dot(d3)}`, inAny(datesOf(type, field), [day(d2), day(d3)]), total]);
  const y1 = +d1.slice(0, 4), y3 = +d3.slice(0, 4);
  CASES.push([`how many ${nm} in ${y1} and ${y3}`, inAny(datesOf(type, field), [year(y1), year(y3)]), total]);
  const [y2, m2] = [+d3.slice(0, 4), +d3.slice(5, 7)];
  CASES.push([`how many ${nm} in ${y2}-${String(m2).padStart(2, "0")}`, inAny(datesOf(type, field), [month(y2, m2)]), total]);
  CASES.push([`how many ${nm} in ${y1}`, inAny(datesOf(type, field), [year(y1)]), total]);
  CASES.push([`how many ${nm} since ${dot(d2)}`, inAny(datesOf(type, field), [[d2, "9999-12-31"]]), total]);
  CASES.push([`how many ${nm} between ${y1} and ${y3}`, inAny(datesOf(type, field), [[`${y1}-01-01`, `${y3}-12-31`]]), total]);
}
// service visits (every document with a service date) on two days
{ const sv = [...ex].filter(([, f]) => f.service_date).map(([, f]) => f.service_date); const d = [...new Set(sv)].sort();
  CASES.push([`how many service visits on ${d[3]} and ${d[10]}`, inAny(sv, [day(d[3]), day(d[10])]), sv.length]);
  CASES.push([`how many service calls on ${us(d[20])} and ${us(d[40])}`, inAny(sv, [day(d[20]), day(d[40])]), sv.length]); }
const UNDATED = [["permits", "permit"], ["dispatch notes", "dispatch-note"], ["maintenance agreements", "maintenance-agreement"]];
const undatedQs = []; for (const [nm, type] of UNDATED) for (const w of ["in 2026", "in 2012", "on 2026-09-21", "in 2026-09", "since 2025.01.01"]) undatedQs.push([`how many ${nm} ${w}`, typeCount(type), nm]);
const AMBIG = ["how many service calls on 3.4.2026", "how many invoices since 3.4.2026", "how many tickets on 5.6.2025", "how many work orders on 1.2.2024"];
const GUARD = [ // must keep answering as before
  ["how many invoices", 120], ["how many permits", 27], ["how many invoices over $5000 in september", null], ["how many customers", 120]];
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {}; await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-datedocs", tenantName: "R3 Datedocs" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t);
const lead = (t) => t.split(/[.;—-]\s/)[0];
for (const [q, want, total] of CASES) {
  const t = await ask(q);
  const ok = want === 0 ? (/\b(?:0|no|none|zero|nothing)\b/i.test(lead(t)) && !hasNum(lead(t), String(total))) : hasNum(lead(t), String(want)) && (want === total || !hasNum(lead(t), String(total)));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 220));
}
for (const [q, total, nm] of undatedQs) { const t = await ask(q); check(`undated "${q}"`, hasNum(t, String(total)) && /no dates?|not dated|undated|isn't dated|aren't dated|doesn't (?:have|carry|record)|don't (?:have|carry)|no date/i.test(t) && !/\b0 (?:documents|permits|dispatch|maintenance)/i.test(t), t.slice(0, 220)); }
for (const q of AMBIG) { const t = await ask(q); check(`ambiguous "${q}" asks`, /could be|which|either/i.test(t) && !hasNum(t, "317") && !hasNum(t, "120") && !/^\d+ /.test(t), t.slice(0, 200)); }
for (const [q, w] of GUARD) { const t = await ask(q); check(`guard "${q}"`, w === null ? /54|over/i.test(t) : hasNum(t, String(w)), t.slice(0, 160)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
