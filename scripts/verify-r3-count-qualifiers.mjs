/**
 * R3 count qualifiers: count questions with a qualifier (invoice amount in words / 3k, out-of-state customers, commercial vs
 * residential permits) must apply it. Expected values are computed from the golden export, not from Donovan. Golden tenant,
 * PGlite, model blocked.   npx tsx scripts/verify-r3-count-qualifiers.mjs   (package.json: verify:r3-qualifiers)
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
const invTotals = exp.financials.filter((f) => docType.get(f.document_id) === "invoice" && f.total != null).map((f) => Number(f.total));
const nInv = invTotals.length;
const cnt = (fn) => invTotals.filter(fn).length;
const custs = exp.entities.filter((e) => e.entity_type === "customer" && !e.merged_into);
const st = (a) => (/,\s*([A-Z]{2})\s+\d{5}/.exec(a ?? "") ?? [])[1];
const tally = {}; custs.forEach((c) => { const s = st(c.data.service_address); if (s) tally[s] = (tally[s] || 0) + 1; });
const home = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
const nOut = custs.filter((c) => { const s = st(c.data.service_address); return s && s !== home; }).length;
const permitIds = new Set(exp.documents.filter((d) => d.document_type === "permit").map((d) => d.id));
const scope = (id) => { const t = exp.pages.filter((p) => p.document_id === id).map((p) => p.text).join("\n"); const m = /Scope of Work:\s*([^\n]*)/i.exec(t); return m ? (/commercial/i.test(m[1]) ? "commercial" : /residential/i.test(m[1]) ? "residential" : "other") : "unknown"; };
const pc = { commercial: 0, residential: 0 }; for (const id of permitIds) { const s = scope(id); if (s in pc) pc[s]++; }
console.log = realLog;
console.log(`invoices ${nInv}, customers ${custs.length}, out-of-state ${nOut} (home ${home}), permits ${JSON.stringify(pc)}`);

// [question, expected count, must also mention]
const T = [];
const amt = [["three thousand", 3000], ["two thousand", 2000], ["five thousand", 5000], ["four thousand five hundred", 4500], ["twenty five hundred", 2500], ["one thousand", 1000], ["3k", 3000], ["2.5k", 2500], ["a thousand", 1000], ["six thousand", 6000]];
const opw = [["over", (t, a) => t > a], ["under", (t, a) => t < a], ["above", (t, a) => t > a], ["more than", (t, a) => t > a], ["less than", (t, a) => t < a], ["below", (t, a) => t < a], ["at least", (t, a) => t >= a]];
let k = 0;
for (const [w, a] of amt) { const [o, f] = opw[k++ % opw.length]; T.push([`how many invoices ${o} ${w} dollars`, cnt((t) => f(t, a))]); }
T.push(["How many invoices are over three thousand dollars?", cnt((t) => t > 3000)]);
T.push(["number of invoices above two thousand five hundred dollars", cnt((t) => t > 2500)]);
T.push(["how many invoices do we have under one thousand five hundred", cnt((t) => t < 1500)]);
T.push(["how many invoices over $3,000", cnt((t) => t > 3000)]); // digits: unchanged path must stay right
T.push(["how many invoices over 3000 dollars", cnt((t) => t > 3000)]);
for (const q of ["how many customers are out of state", "how many out-of-state customers do we have", "number of customers outside of state", "how many customers are outside the state", "count of customers from another state", "how many customers out of the state"]) T.push([q, nOut]);
for (const q of ["how many commercial permits do we have", "how many commercial permits", "number of commercial permits on file", "how many commercial mechanical permits do we have"]) T.push([q, pc.commercial]);
for (const q of ["how many residential permits do we have", "how many residential permits", "count of residential permits"]) T.push([q, pc.residential]);
T.push(["how many permits do we have", permitIds.size]); // control: unqualified
T.push(["how many customers do we have", custs.length]); // control

const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-quote", tenantName: "R3 Quote" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };

for (const [q, n] of T) {
  const t = await ask(q);
  const first = t.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+/)?.[0];
  check(`"${q}" -> ${n}`, String(first) === String(n), t.slice(0, 220));
}
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed (${T.length} questions)`);
process.exit(failures ? 1 : 0);
