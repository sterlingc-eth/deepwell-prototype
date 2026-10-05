/**
 * R3 techwindow (blind set): technician + date window in open phrasings ("what did <tech> do in march 2024", "service visits for tech <tech> this month", "work done by <tech> in 2011",
 * "tickets <tech> worked on in 2012"). Names/dates/counts all derived from the golden export; today = 2026-09-25. Kill switch DONOVAN_TECH_WINDOW=0. Model blocked.   npx tsx scripts/verify-r3-techwindow.mjs
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
const inr = (c, type, a, b) => docsOf(c).filter((d) => d.document_type === type && docDate(d) && docDate(d) >= a && docDate(d) <= b).length;

const techOf = new Map(); for (const d of exp.documents) { const t = ex.get(d.id)?.technician; if (t) techOf.set(d.id, t); }
const techs = [...new Set(techOf.values())];
const firsts = techs.map((n) => n.split(" ")[0]);
const cnt = (name, y) => exp.documents.filter((d) => techOf.get(d.id) === name && (y == null || docDate(d).startsWith(String(y)))).length;
const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const cntM = (name, y, m) => exp.documents.filter((d) => techOf.get(d.id) === name && docDate(d).startsWith(`${y}-${String(m).padStart(2, "0")}`)).length;
const CASES = [];
for (const name of techs) {
  const f = name.split(" ")[0];
  const ym = new Map(); for (const d of exp.documents) if (techOf.get(d.id) === name && docDate(d)) { const k = docDate(d).slice(0, 7); ym.set(k, (ym.get(k) || 0) + 1); }
  const keys = [...ym.keys()].sort(); const pick = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]].filter(Boolean);
  for (const k of pick) { const [y, m] = k.split("-").map(Number); const c = cntM(name, y, m); const mn = MON[m - 1];
    CASES.push([`what did ${f} do in ${mn.toLowerCase()} ${y}`, c, name]);
    CASES.push([`tickets ${f} worked on in ${mn} ${y}`, c, name]);
    CASES.push([`work done by ${name} in ${mn} ${y}`, c, name]); }
  CASES.push([`service visits for tech ${f} this month`, cntM(name, 2026, 9), name]);
  CASES.push([`jobs for technician ${name} last year`, cnt(name, 2025), name]);
  CASES.push([`what did ${f} do last year`, cnt(name, 2025), name]);
  CASES.push([`work done by ${f} in 2011`, cnt(name, 2011), name]);
  CASES.push([`which tickets did ${f} work on in 2012`, cnt(name, 2012), name]);
}
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-techwindow", tenantName: "R3 Relname" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };


const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/\b(?:19|20)\d\d(?:-\d\d(?:-\d\d)?)?\b/g, " "));
for (const [q, want, name] of CASES) {
  const t = await ask(q);
  const ok = !/Processing failed/.test(t) && t.includes(name) && (want === 0 ? /\b(?:0|no|none)\b/i.test(t) : hasNum(t, String(want)));
  check(`"${q}" -> ${name} ${want}`, ok, t.slice(0, 200));
}
for (const q of ["what did Zzyzx do in march 2024", "service visits for tech Zzyzx this month", "work done by Quimby in 2011"]) { const t = await ask(q); check(`control "${q}" no invented count`, !/\b\d+ (?:jobs?|tickets?|visits?)\b/.test(t) && !/Processing failed/.test(t) || !/\b[1-9]\d* (?:jobs?|tickets?|visits?)\b/.test(t), t.slice(0, 200)); }
const top = techs.map((n) => [n, cnt(n)]).sort((a, b) => b[1] - a[1])[0];
for (const q of ["tech with most jobs", "jobs per technician"]) { const t = await ask(q); check(`"${q}" still answers`, !/Processing failed/.test(t) && (q.startsWith("tech") ? t.includes(top[0]) : techs.every((n) => t.includes(n))), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
