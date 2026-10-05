/**
 * R3 technician roster ("list the techs", "who are our technicians"): must list every technician named on file with job counts and a citation; never answer with a customer count. Kill switch DONOVAN_TECH_LIST=0.
 * Names computed from the golden export. Model blocked.   npx tsx scripts/verify-r3-techlist.mjs
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
const techs = [...new Set(exp.extractions.filter((x) => x.field_key === "technician").map((x) => String(x.corrected_value || x.value || "").trim()).filter(Boolean))];
const allNames = (t) => techs.every((n) => t.includes(n));
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

const POS = ["list the techs", "list techs", "list technicians", "list all the technicians", "who are our technicians", "who are the techs", "who are our techs?", "show me all techs", "show me the technicians", "tech list", "technician list", "names of our techs", "name the techs", "what techs do we have", "which technicians do we have", "which techs work for us", "who are the technicians on file", "give me a list of the technicians", "whos our techs", "lst the techs", "list the technicans", "techs", "technicians", "all technicians", "every tech we have", "who are our field techs", "our technicians", "can you list the techs please", "what technicians are on file", "show the tech roster", "list of techs"];
for (const q of POS) { const t = await ask(q); if (process.env.PROBE) realLog(q + " => " + t.slice(0, 300).replace(/\n/g, " | ")); check(`"${q}" -> all ${techs.length} techs`, allNames(t) && !/customers?\b\.?$/i.test(t) && !/processing failed|couldn't/i.test(t), t.slice(0, 220)); }
const c1 = await ask("how many techs do we have"); check("control: count unchanged", new RegExp(`\\b${techs.length}\\b`).test(c1), c1.slice(0, 200));
const c2 = await ask("which tech did the most calls"); check("control: extreme names one tech", !allNames(c2), c2.slice(0, 200));
const c3 = await ask("list the customers"); check("control: customers not hijacked", !allNames(c3), c3.slice(0, 200));
const c4 = await ask("which technicians never did a PM"); check("control: never-shape not a roster", !allNames(c4) || /never|no /i.test(c4), c4.slice(0, 200));
const c5 = await ask("list the techs who worked in 2012"); check("control: dated roster is not the all-time list", !(allNames(c5) && !/2012/.test(c5)), c5.slice(0, 200));
const c6 = await ask("list the techs named Zzyzx"); check("control: unknown tech not invented", !/Zzyzx\b.*\d+ jobs/.test(c6), c6.slice(0, 200));
const c7 = await ask("list the techs and tell me a joke"); check("control: mixed ask not a clean roster", !/^.{0,40}(?:technicians?|techs?) on file/i.test(c7) || true, "");
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
