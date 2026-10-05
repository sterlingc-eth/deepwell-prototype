/**
 * R3 person + amount invoice questions (blind set, Loop 2026-10-04): "Linda Fitzgerald invoices over $500" must count THAT customer's invoices, not the company's.
 * Expected values are computed from the golden export, not hard-coded. Model blocked.
 *   npx tsx scripts/verify-r3-personamt.mjs
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
const docs = new Map(exp.documents.map((d) => [d.id, d]));
const fin = new Map(exp.financials.map((f) => [f.document_id, f]));
const custs = exp.entities.filter((e) => e.entity_type === "customer" && !e.merged_into).map((e) => ({ id: e.id, name: e.data.customer_name }));
const invOf = (id) => { const s = new Map(); for (const l of exp.document_entity_links) if (l.entity_id === id) { const d = docs.get(l.document_id); const f = fin.get(l.document_id); if (d && f && f.total != null && String(d.document_type).replace(/_/g, "-") === "invoice") s.set(l.document_id, { t: Number(f.total), d: f.invoice_date }); } return [...s.values()]; };
const cmpf = { ">": (a, b) => a > b, "<": (a, b) => a < b };
const nFor = (id, op, amt, y) => invOf(id).filter((i) => cmpf[op](i.t, amt) && (!y || String(i.d ?? "").startsWith(y))).length;
const withInv = custs.filter((c) => invOf(c.id).length);
const pick = (i) => withInv[(i * 17 + 3) % withInv.length];
const CASES = []; // [question, expectedCount, [names that must appear]]
const T = [[">", 500, "over $500"], [">", 1500, "above 1500 dollars"], ["<", 1000, "under $1,000"], [">", 3000, "more than $3000"], ["<", 5000, "below 5k"]];
for (let i = 0; i < 10; i++) {
  const c = pick(i); const [op, amt, phrase] = T[i % T.length];
  const n = nFor(c.id, op, amt);
  const forms = [`${c.name} invoices ${phrase}`, `how many invoices ${phrase} for ${c.name}`, `invoices ${phrase} for ${c.name}`, `which invoices ${phrase} does ${c.name} have`, `${c.name.toLowerCase()} invoices ${phrase}`, `list ${c.name}'s invoices ${phrase}`];
  CASES.push([forms[i % forms.length], n, [c.name]]);
}
// year window kept together with the person
for (const i of [11, 12, 13]) { const c = pick(i); const y = String(invOf(c.id)[0].d).slice(0, 4); CASES.push([`${c.name} invoices over $200 in ${y}`, nFor(c.id, ">", 200, y), [c.name]]); }
// shared surname / partial name: every customer with the word is answered, combined count
const bySur = {}; for (const c of withInv) { const s = c.name.split(" ").pop().toLowerCase(); (bySur[s] ??= []).push(c); }
const shared = Object.entries(bySur).filter(([, v]) => v.length > 1 && !/dental|restaurant|church/.test(v[0].name.toLowerCase())).slice(0, 5);
for (const [s, v] of shared) CASES.push([`${s} over $500 invoices`, v.reduce((a, c) => a + nFor(c.id, ">", 500), 0), v.map((c) => c.name)]);
for (const [s, v] of shared.slice(0, 2)) CASES.push([`how many invoices under $2000 for ${s[0].toUpperCase() + s.slice(1)}`, v.reduce((a, c) => a + nFor(c.id, "<", 2000), 0), v.map((c) => c.name)]);
const uniqSur = Object.entries(bySur).filter(([, v]) => v.length === 1).slice(0, 3);
for (const [s, v] of uniqSur) CASES.push([`${s} invoices over $800`, nFor(v[0].id, ">", 800), [v[0].name]]);
const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-personamt", tenantName: "R3 Personamt" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const hasNum = (t, k) => new RegExp(`(?<![\\d,.$/#-])${k}(?![\\d,]|\\.\\d)`).test(t.replace(/\$[\d,]+(?:\.\d+)?/g, " ").replace(/#\S+/g, " ").replace(/\bof \d+\b/g, " "));
for (const [q, want, names] of CASES) {
  const t = await ask(q);
  const ok = names.every((n) => t.includes(n)) && (hasNum(t, String(want)) || (want === 0 && /\bno\b/i.test(t)));
  check(`"${q}" -> ${want}`, ok, t.slice(0, 220));
}
// negatives / controls
const tu = await ask("Zebulon Quackenbush invoices over $500");
check("unknown customer -> honest not on file", /(?:don't see|not on file|no customer)/i.test(tu) && /Quackenbush/.test(tu) && !/\b\d+ of \d+ invoices/.test(tu), tu.slice(0, 200));
const tu2 = await ask("how many invoices over $500 for Xavier Pemberton-Ruiz");
check("unknown hyphen name -> not a company-wide count", !/\b\d+ of \d+ invoices on file/.test(tu2), tu2.slice(0, 200));
const tall = await ask("how many invoices over $500");
check("control: no name stays company-wide", /\d+ (?:of \d+ )?invoices/.test(tall), tall.slice(0, 200));
const twin = await ask("how many invoices over $500 in 2012");
check("control: date window unchanged", /invoices dated in 2012|No invoices on file in 2012/.test(twin), twin.slice(0, 200));
const tst = await ask("unpaid invoices over $500");
check("control: status word is not a name", !/customer named|don't see a customer/i.test(tst), tst.slice(0, 200));
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
