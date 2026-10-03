/**
 * R3 paid lookup: "what did X pay / owe" -> X's invoiced total (cited) + plain note that paid-vs-unpaid is not recorded; a name not on file
 * says "not on file" (never a company total); vendor / company-wide / unrelated questions are not claimed. Golden tenant, PGlite, model blocked.
 *   npx tsx scripts/verify-r3-paid.mjs   (package.json: verify:r3-paid)
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
const invBy = new Map();
for (const f of exp.financials) {
  if (docType.get(f.document_id) !== "invoice") continue;
  if (!invBy.has(f.customer_name)) invBy.set(f.customer_name, []);
  invBy.get(f.customer_name).push(Number(f.total));
}
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (c) => invBy.get(c).reduce((a, b) => a + b, 0);
const C = [...invBy.keys()];
const pick = (i) => C[(i * 7 + 3) % C.length];
console.log = realLog;



const POS = [
  (c) => `what did ${c} pay`, (c) => `how much has ${c} paid us`, (c) => `what does ${c} owe`, (c) => `what has ${c} paid so far`,
  (c) => `how much did ${c} payed us`, (c) => `wat did ${c} pay`, (c) => `how much we get paid from ${c}`, (c) => `what did we get paid by ${c}`,
  (c) => `how much does ${c} owe us`, (c) => `has ${c} paid`, (c) => `how much did ${c} pay for the job`, (c) => `what's ${c} paid to date`,
  (c) => `hows much did ${c} pay us`, (c) => `what did ${c} pay us last time`,
];
const FIRST = [
  ["Thomas Mercer", "Tom Mercer"], ["William Quintana", "Bill Quintana"], ["Robert Salazar", "Bob Salazar"],
];
const ORG = [["Sunrise Valley Elementary School", "Sunrise Valley Elementary"], ["Sonoran Grill Restaurant", "Sonoran Grill"]];
const NOTON = ["Gerald Pinkerton", "Zelda Quackenbush", "Pinnacle Widgets LLC", "Harold Vandermeer", "Acme Roofing"];
const NEG = [
  "what did I pay vendor Baker Distributing", "how much did we pay Watsco Supply", "how much did we get paid", "what did customers pay this year",
  "how much do we owe vendors", "what did I pay for the furnace part", "who paid late", "how much did we pay the supplier last month",
];

const offline = await import(path.join(ROOT, "scripts/offline-exam.mjs"));
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
console.log = () => {};
await installPgHarness(); await installModelBlock();
const lite = await createPGlite(); await setActiveDatabase(lite);
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "offline:r3-paid", tenantName: "R3 Paid" });
const handler = (await import(path.join(ROOT, "api/ask.js"))).default;
const { askViaHandler } = await import(path.join(ROOT, "api/_lib/scorecard/askCall.js"));
console.log = realLog;
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
const ask = async (question) => { console.log = () => {}; try { const r = await askViaHandler({ handler, auth, question, today: "2026-09-25" }); return String(r.data?.answer ?? r.data?.text ?? JSON.stringify(r.data ?? r.error)); } finally { console.log = realLog; } };
const has$ = (t, n) => t.replace(/,/g, "").includes(money(n).replace(/,/g, ""));
const NOTREC = /(?:isn't|is not|aren't|not)\s+(?:recorded|shown|tracked)|no payment/i;
const allTotals = new Set(C.map(sum).map((n) => money(n)));

let i = 0;
for (const f of POS) {
  const c = pick(i++), t = await ask(f(c));
  check(`paid: "${f(c)}" -> $${money(sum(c))} + status note`, has$(t, sum(c)) && NOTREC.test(t) && /paid/i.test(t), t.slice(0, 220));
}
for (const [full, short] of [...FIRST, ...ORG]) {
  if (!invBy.has(full)) continue;
  for (const f of [POS[0], POS[1]]) {
    const t = await ask(f(short));
    check(`partial/nickname: "${f(short)}" -> $${money(sum(full))}`, has$(t, sum(full)) && NOTREC.test(t), t.slice(0, 220));
  }
}
for (const n of NOTON) {
  for (const f of [POS[0], POS[2]]) {
    const t = await ask(f(n));
    const leaked = [...allTotals].some((m) => t.replace(/,/g, "").includes(m.replace(/,/g, "")));
    check(`not on file: "${f(n)}"`, /not on file/i.test(t) && !leaked, t.slice(0, 220));
  }
}
for (const q of NEG) {
  const t = await ask(q);
  check(`negative not claimed: "${q}"`, !/payment status|no customer/i.test(t), t.slice(0, 220));
}
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
