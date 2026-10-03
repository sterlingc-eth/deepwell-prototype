/**
 * R3 quote-vs-invoice: a quote/estimate/proposal question is answered ONLY from quote-type documents (proposal-quote);
 * with none on file the answer says "No quote on file for X" (an invoice may be mentioned, labelled as an invoice) and
 * never presents an invoice total as the quote. Golden tenant, PGlite, model blocked.
 *   npx tsx scripts/verify-r3-quote-vs-invoice.mjs   (package.json: verify:r3-quote)
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
const quoteBy = new Map(), invBy = new Map();
for (const f of exp.financials) {
  const t = docType.get(f.document_id);
  const m = t === "proposal-quote" ? quoteBy : t === "invoice" ? invBy : null;
  if (m) { if (!m.has(f.customer_name)) m.set(f.customer_name, []); m.get(f.customer_name).push(Number(f.total)); }
}
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// customers with exactly one quote and (ideally) invoices; customers with invoices but no quote
const withQuote = [...quoteBy].filter(([c, v]) => v.length === 1 && invBy.has(c) && !invBy.get(c).includes(v[0])).map(([c, v]) => ({ c, q: v[0], inv: invBy.get(c) }));
const noQuote = [...invBy].filter(([c, v]) => !quoteBy.has(c) && v.length === 1).map(([c, v]) => ({ c, inv: v[0] }));
console.log = realLog;
console.log(`customers: ${withQuote.length} with quote+invoice, ${noQuote.length} invoice-only`);

const WQ = [
  (c) => `what was the quote for ${c}`, (c) => `quote for ${c}`, (c) => `estimate for ${c}`, (c) => `how much did we quote ${c}?`,
  (c) => `whats the proposal for ${c}`, (c) => `what did we estimate for ${c}`, (c) => `qoute for ${c}`, (c) => `how much was the estimate on ${c}'s job`,
  (c) => `${c} quote amount`, (c) => `what'd we bid ${c}? the quote i mean`, (c) => `ballpark we gave ${c} in the proposal`, (c) => `price quoted to ${c}`,
  (c) => `estmate for ${c}`, (c) => `what is the quoted price for ${c}`,
];
const NQ = [
  (c) => `what was the quote for ${c}`, (c) => `quote for ${c}`, (c) => `estimate for ${c}`, (c) => `how much did we quote ${c}?`,
  (c) => `whats the proposal for ${c}`, (c) => `qoute for ${c}`, (c) => `${c} estimate`, (c) => `what did we bid ${c} in the quote`,
  (c) => `how much was the estimate we gave ${c}`, (c) => `quoted price for ${c}`, (c) => `pull up the proposal for ${c}`, (c) => `estmate on ${c}`,
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

let i = 0;
for (const f of WQ) {
  const { c, q, inv } = withQuote[i++ % withQuote.length];
  const t = await ask(f(c));
  check(`with-quote: "${f(c)}" -> quote $${money(q)}`, has$(t, q) && !inv.some((v) => has$(t, v) && !/invoice/i.test(t)), t.slice(0, 200));
}
i = 0;
for (const f of NQ) {
  const { c, inv } = noQuote[i++ % noQuote.length];
  const t = await ask(f(c));
  const noQ = /no (?:quote|estimate|proposal)s?\b[^.]*\bon file/i.test(t);
  const invOk = !has$(t, inv) || /invoice/i.test(t);
  check(`no-quote: "${f(c)}" -> "No quote on file"`, noQ && invOk, t.slice(0, 200));
}
// non-quote questions must keep answering from the invoice
for (const { c, inv } of noQuote.slice(20, 25)) {
  const t = await ask(`how much was ${c}'s invoice`);
  check(`non-quote unchanged: "how much was ${c}'s invoice"`, has$(t, inv) && !/no quote on file/i.test(t), t.slice(0, 200));
}
console.error = realErr;
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
