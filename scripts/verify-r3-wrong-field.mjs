/**
 * R3 wrong-field: the field asked must be the field returned. #6 'who installed X' -> installer (technician on the install record),
 * not the last service tech. #7 invoice number vs phone number. Golden tenant, PGlite, model blocked.
 *   npx tsx scripts/verify-r3-wrong-field.mjs   (package.json: verify:r3-fieldmatch)
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
const dtype = new Map(exp.documents.map((d) => [d.id, d.document_type]));
const ex = new Map(); for (const x of exp.extractions) { if (!ex.has(x.document_id)) ex.set(x.document_id, {}); ex.get(x.document_id)[x.field_key] = x.value; }
const cust = new Map(exp.entities.filter((e) => e.entity_type === "customer").map((e) => [e.data.customer_name, e.data]));
const invs = new Map(), installs = new Map(), svcTech = new Map();
for (const f of exp.financials) {
  if (dtype.get(f.document_id) !== "invoice") continue;
  const x = ex.get(f.document_id) ?? {};
  const c = f.customer_name; if (!invs.has(c)) invs.set(c, []); invs.get(c).push(f.invoice_number);
  if (/^install/i.test(x.work_performed ?? "") && x.technician) { if (!installs.has(c)) installs.set(c, []); installs.get(c).push({ tech: x.technician, date: x.installation_date ?? x.service_date }); }
}
for (const d of exp.documents) if (d.document_type === "service-ticket") { const x = ex.get(d.id) ?? {}; const e = exp.document_entity_links.filter((l) => l.document_id === d.id).map((l) => exp.entities.find((y) => y.id === l.entity_id)).find((y) => y?.entity_type === "customer"); if (e && x.technician) { if (!svcTech.has(e.data.customer_name)) svcTech.set(e.data.customer_name, new Set()); svcTech.get(e.data.customer_name).add(x.technician); } }
// customers with exactly one install record, one invoice, a phone, and a service tech different from the installer
const inst = [...installs].filter(([c, v]) => v.length === 1 && invs.get(c)?.length === 1 && cust.get(c)?.phone && [...(svcTech.get(c) ?? [])].some((t) => t !== v[0].tech)).map(([c, v]) => ({ c, ...v[0], other: [...svcTech.get(c)].filter((t) => t !== v[0].tech), inv: invs.get(c)[0], phone: cust.get(c).phone, addr: cust.get(c).service_address }));
console.log = realLog;
console.log(`customers usable: ${inst.length}`);

const INS = [
  (c) => `who installed ${c}'s AC`, (c) => `who put in the system for ${c}`, (c) => `installer for ${c}`, (c) => `who did the install at ${c}`,
  (c) => `which tech installed the unit for ${c}?`, (c) => `whos the guy that installed ${c} unit`, (c) => `who instaled ${c}'s system`, (c) => `${c} install tech`,
  (c) => `who set up ${c}'s new unit`, (c) => `who installd the ac for ${c}`, (c) => `installed by who for ${c}`, (c) => `what tech did the original install for ${c}`,
];
const INV = [
  (c) => `what is ${c}'s invoice number`, (c) => `invoice # for ${c}`, (c) => `invoice number for ${c}`, (c) => `inv no. ${c}`,
  (c) => `whats the invoice num on ${c}`, (c) => `invioce number for ${c}`, (c) => `bill number for ${c}`, (c) => `which invoice is ${c}'s`,
];
const PH = [
  (c) => `${c} phone number`, (c) => `what's ${c}'s phone`, (c) => `phone # for ${c}`, (c) => `how do i call ${c}`, (c) => `cell number for ${c}`, (c) => `${c} fone number`,
];
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
const has$ = (t, n) => t.replace(/,/g, "").includes(money(n).replace(/,/g, "")) || t.replace(/,/g, "").includes(`$${Math.round(n)}`) && Number.isInteger(n);


const digits = (t) => t.replace(/[^0-9]/g, "");
let i = 0;
for (const f of INS) {
  const r = inst[i++ % inst.length]; const t = await ask(f(r.c));
  check(`installer: "${f(r.c)}" -> ${r.tech} (${r.date})`, t.includes(r.tech) && !r.other.some((o) => t.includes(o)), t.slice(0, 200));
}
i = 3;
for (const f of INV) {
  const r = inst[i++ % inst.length]; const t = await ask(f(r.c));
  check(`invoice#: "${f(r.c)}" -> ${r.inv}`, t.includes(r.inv) && !digits(t).includes(digits(r.phone)), t.slice(0, 200));
}
i = 5;
for (const f of PH) {
  const r = inst[i++ % inst.length]; const t = await ask(f(r.c));
  check(`phone: "${f(r.c)}" -> ${r.phone}`, digits(t).includes(digits(r.phone)) && !t.includes(r.inv), t.slice(0, 200));
}
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
