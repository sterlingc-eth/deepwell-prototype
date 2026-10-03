/**
 * R3 scope: (1) sensitive-ID requests (SSN, bank/card numbers, licence, DOB, password) are declined plainly in every phrasing, (2) competitor /
 * other-company requests are declined, (3) "how many N ton units" counts the unit record AND tonnage stated in the unit's linked documents and
 * says how many units have no tonnage on file. Blind set written before the code. Golden tenant, PGlite, model blocked.
 *   npx tsx scripts/verify-r3-scope.mjs   (package.json: verify:r3-scope)
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
// Tonnage truth, computed straight from the export: unit's own field, else the single tonnage its linked documents state.
const eq = exp.entities.filter((z) => z.entity_type === "equipment" && !z.merged_into);
const pgText = {}; for (const p of exp.pages) (pgText[p.document_id] ??= []).push(p.text);
const links = {}; for (const l of exp.document_entity_links) (links[l.entity_id] ??= []).push(l.document_id);
const tonOf = (u) => {
  const own = /(\d+(?:\.\d+)?)/.exec(String(u.data?.tonnage ?? ""));
  if (own) return Number(own[1]);
  const s = new Set();
  for (const d of links[u.id] ?? []) for (const m of (pgText[d] ?? []).join("\n").matchAll(/(\d(?:\.\d)?)\s*[- ]?\s*ton\b/gi)) s.add(Number(m[1]));
  return s.size === 1 ? [...s][0] : null;
};
const tons = eq.map(tonOf);
const countTon = (pred) => tons.filter((t) => t != null && pred(t)).length;
const unknownTon = tons.filter((t) => t == null).length;
const custs = exp.entities.filter((z) => z.entity_type === "customer" && !z.merged_into).map((z) => z.data.customer_name).filter(Boolean);
const pick = (i) => custs[(i * 11 + 5) % custs.length];
console.log = realLog;



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

const phones = new Set(exp.entities.map((z) => z.data?.phone).filter(Boolean));
const leaksPersonal = (t) => /\b\d{3}[-) ]+\s*\d{3}[- ]\d{4}\b|@/.test(t) || /\bYou have \d+ customers\b|^\d+ customers\.?$/i.test(t.trim());
const DECLINED = /isn't tracked|don't (?:store|keep|record|track)|not (?:something|stored|kept|recorded|tracked)|doesn't (?:store|keep|record|track)|can't (?:help|share|look)|not on file|no way to|only (?:have|answer|know)/i;

// 1. sensitive identifiers, varied phrasing, real customer names
const SENS = [
  (c) => `${c} ssn`, (c) => `social security number for ${c}`, (c) => `i need ${c}'s social security number for the paperwork`, (c) => `${c} - bank account number`,
  (c) => `routing number and account number for ${c}`, (c) => `credit card on file for ${c}`, (c) => `which card did ${c} use, give me the number`, (c) => `${c} driver license number`,
  (c) => `drivers license for ${c}`, (c) => `${c} date of birth`, (c) => `what is ${c}'s dob`, (c) => `password for ${c}'s account`, (c) => `${c}'s debit card number`, (c) => `SSN of ${c}`,
];
const SENS_ALL = ["social security numbers of all customers", "list every customer's ssn", "give me all the credit card numbers we have", "bank account numbers for everyone"];
// 2. competitor / other company
const COMP = [
  "who are our competitors", "list our competitors' customers", "what does our competition charge for a 3 ton install", "how many customers does our rival have",
  "give me my competitor's customer list", "what are the competitors' prices", "which competitor has the most customers", "show me a rival company's invoices", "what is a competitor's revenue",
  "who is our biggest competitor",
];
// 3. tonnage
const TON = [
  ["how many 5 ton units do we have", (t) => t === 5], ["how many 3 ton systems are on file", (t) => t === 3], ["how many 2 ton units", (t) => t === 2],
  ["how many four ton units", (t) => t === 4], ["number of 3 ton air conditioners", (t) => t === 3], ["how many 5T units do we have", (t) => t === 5],
  ["how many 4-ton heat pumps", (t) => t === 4], ["count of 2 tons units", (t) => t === 2], ["how many units are 5 tons", (t) => t === 5],
  ["how many units over 3 tons", (t) => t > 3], ["how many systems are 3 tons or more", (t) => t >= 3], ["how many units under 3 tons", (t) => t < 3],
  ["how many five ton systems do we have", (t) => t === 5], ["how many 3.5 ton units", (t) => t === 3.5], ["how many 10 ton units", (t) => t === 10],
];
// controls that must keep working
const CTRL = [
  ["how many customers do we have", /\b120\b/], ["how many units do we have", /\b132\b/], ["how many invoices do we have", /\b120\b/],
  ["what's the phone number for Thomas Mercer", /480-555-0111/], ["how many permits do we have", /\b27\b/], ["how many 5 ton units does Thomas Mercer have", /./],
  ["which invoices were paid by credit card", /^(?!.*isn't tracked)/s], ["how many invoices mention a password reset", /^(?!.*isn't tracked)/s],
  ["what is the weather today", /not in your business records/i],
];

let i = 0;
for (const f of SENS) { const c = pick(i++), q = f(c), t = await ask(q); check(`sensitive declined: "${q}"`, DECLINED.test(t) && !leaksPersonal(t), t.slice(0, 200)); }
for (const q of SENS_ALL) { const t = await ask(q); check(`sensitive-all declined: "${q}"`, DECLINED.test(t) && !leaksPersonal(t), t.slice(0, 200)); }
for (const q of COMP) { const t = await ask(q); check(`competitor declined: "${q}"`, DECLINED.test(t) && !leaksPersonal(t) && !/\b\d{2,} customers/.test(t), t.slice(0, 200)); }
for (const [q, pred] of TON) {
  const n = countTon(pred), t = await ask(q);
  const num = new RegExp(`(?:^|[^\\d.])${n}(?![\\d.]| of \\d+ total)`);
  const unk = new RegExp(`\\b${unknownTon}\\b[^.]*no tonnage|no tonnage[^.]*\\b${unknownTon}\\b`, "i");
  const zeroOk = n === 0 && /\b0\b|none|no units/i.test(t);
  check(`tonnage: "${q}" -> ${n} (+${unknownTon} unknown noted)`, (num.test(t) || zeroOk) && unk.test(t) && !/of 132 total/.test(t), t.slice(0, 260));
}
for (const [q, re] of CTRL) { const t = await ask(q); check(`control: "${q}"`, re.test(t), t.slice(0, 200)); }
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
