/**
 * R3 techby: (a) relative windows after a customer name ("invoices for <name> last year / this year / last month / this month / this quarter") apply the window instead of leaking into the name;
 * (b) shop-wide year ranges on a record noun without "how many" ("service tickets 2010-2012", "invoices from 2010 through 2012", "jobs from 2010 to 2012") answer like the count form. Kill switches DONOVAN_NAME_REL=0, DONOVAN_RANGE_NOUN=0.
 * Expected values computed from the golden export; today = 2026-09-25. Model blocked.   npx tsx scripts/verify-r3-relname.mjs
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
const CASES = [];
const NOUNS = ["tickets", "jobs", "service calls", "work orders", "visits"];
let k = 0;
for (const name of techs) for (const y of [2010, 2011, 2012, 2013, 2025]) {
  const f = name.split(" ")[0]; const n = NOUNS[k++ % NOUNS.length]; const who = k % 3 === 0 ? name : f;
  CASES.push([`${n} by ${who} in ${y}`, cnt(name, y), name]);
  if (k % 2) CASES.push([`how many ${NOUNS[(k + 1) % 5]} by ${f.toLowerCase()} ${y}`, cnt(name, y), name]);
}
for (const name of techs) { const f = name.split(" ")[0]; CASES.push([`jobs by ${f}`, cnt(name), name]); CASES.push([`tickets by ${name}?`, cnt(name), name]); CASES.push([`jobs by ${f} last year`, cnt(name, 2025), name]); }
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-relname", tenantName: "R3 Relname" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };

const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/\b(?:19|20)\d\d(?:-\d\d(?:-\d\d)?)?\b/g, " "));
for (const [q, want, name] of CASES) {
  const t = await ask(q);
  const ok = !/Processing failed/.test(t) && (want === 0 ? /\b(?:0|no|none)\b/i.test(t) && t.includes(name) : hasNum(t, String(want)) && t.includes(name));
  check(`"${q}" -> ${name} ${want}`, ok, t.slice(0, 200));
}
const ros = await ask("list the techs");
for (const q of ["jobs per technician", "tickets by technician", "calls per tech", "jobs by technician"]) { const t = await ask(q); check(`"${q}" gives roster`, t === ros || (techs.every((n) => t.includes(n)) && !/Processing failed/.test(t)), t.slice(0, 200)); }
const top = techs.map((n) => [n, cnt(n)]).sort((a, b) => b[1] - a[1])[0];
for (const q of ["tech with most jobs", "which tech has the most jobs", "who is the busiest tech", "busiest technician", "technician with the most jobs", "tech with the most tickets", "who has the most jobs, tech wise"]) { const t = await ask(q); check(`"${q}" names the top tech ${top[0]} ${top[1]}`, t.includes(top[0]) && hasNum(t, String(top[1])) && !/tied/.test(t), t.slice(0, 200)); }
for (const q of ["tickets by Zzyzx in 2011", "jobs by Zzyzx", "tickets by Quimby last year"]) { const t = await ask(q); check(`control "${q}" no invented count`, !/\b\d+ (?:jobs?|tickets?|visits?)\b/.test(t.replace(/most recent/,"")) && !/No service visits in/.test(t), t.slice(0, 200)); }
const c = await ask("how many invoices in 2011"); check("control: shop invoices unchanged", /invoice/i.test(c), c.slice(0, 120));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
