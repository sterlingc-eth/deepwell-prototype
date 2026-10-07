#!/usr/bin/env node
/**
 * FORGE: (8) "this customer / this address / this agreement / this vendor" without page context must decline in one short sentence asking which one
 * (never pick silently, never answer with a total); with a conversation/page context passed it must NOT be pre-empted. (7) rephrase normalizer unit tests.
 */
import assert from "node:assert/strict";
const { classifyEarlyDecline, buildEarlyDeclineAnswer, thisNoun } = await import("../api/_lib/router/earlyDecline.js");
const { normalizeRephrase, typoFixes, applyTypoFixes } = await import("../api/_lib/router/rephrase.js");
const fixTypos = (q) => { const f = typoFixes(q); return f.length ? applyTypoFixes(q, f) : null; };
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("FAIL", name, "-", e.message.split("\n")[0]); } };
const nouns = [["customer", "customer"], ["address", "address"], ["agreement", "agreement"], ["vendor", "vendor"], ["contract", "contract"], ["job", "job"], ["property", "property"], ["lease", "lease"], ["tenant", "tenant"], ["account", "account"]];
const frames = [(n) => `What did we invoice this ${n} last year?`, (n) => `which documents do we have for this ${n}`, (n) => `docs for this ${n}`, (n) => `when does this ${n} end`, (n) => `show me the signed form for this ${n}`, (n) => `what do we have on this ${n}`, (n) => `what did we pay this ${n} in March?`, (n) => `how much do we owe this ${n}`, (n) => `THIS ${n.toUpperCase()} - ANY UNPAID BILLS?`];
for (const [n, expect] of nouns) for (const f of frames) {
  const q = f(n);
  t(`ask-which: ${q}`, () => { const e = classifyEarlyDecline(q, { hasConversation: false }); assert.ok(e && e.kind === "dangling", "not declined"); const a = buildEarlyDeclineAnswer(e.kind, e); assert.equal(a.kind, "no-answer"); assert.ok(!/\$\d/.test(a.text) && a.text.length < 120 && /which|earlier question/i.test(a.text), a.text); });
  t(`context passed, not pre-empted: ${q}`, () => { const e = classifyEarlyDecline(q, { hasConversation: true, contextHasEntity: true }); assert.ok(!(e && e.noun), "pre-empted with a conversation"); });
}
// typos on the noun
for (const q of ["wich documnts do we have for this custmer", "show the signd form for this adress", "wat did we pay this vender in march", "when does this agrement end", "end date of this agreemnt"]) t(`typo: ${q}`, () => assert.ok(classifyEarlyDecline(q)?.noun, "typo not recognised"));
// the noun is carried into the sentence
t("noun in sentence", () => assert.match(buildEarlyDeclineAnswer("dangling", { noun: "vendor" }).text, /Which vendor/));
// false positives: these name the record, are about a time span, or are how-to questions -> never pre-empted
for (const q of ["How many customers did we add this month?", "what did we invoice this year", "unpaid invoices this week", "what is Mark Henderson's address", "documents for 3247 Elm St", "this year's invoices for Mark Henderson", "when does the Smith agreement end", "what did we pay Acme Supply this March", "how do I delete this customer", "how many jobs this month", "who is this customer? Mark Henderson", "which customers are in Mesa", "show the contract for 12 Main St", "this quarter's vendor payments"]) t(`not declined: ${q}`, () => assert.equal(thisNoun(q, q), null));
// rephrase normalizer
const same = (q) => t(`unchanged: ${q}`, () => assert.equal(normalizeRephrase(q), null));
const to = (q, r) => t(`rewrite: ${q}`, () => assert.equal(normalizeRephrase(q), r));
to("total of invoices INV-3301", "total of invoice INV-3301"); to("who is invoices inv-2102 for", "who is invoice inv-2102 for"); to("when is permits BP-2026-1201 signed", "when is permit BP-2026-1201 signed");
to("how much do customers owe", "how much is owed to us"); to("How much do our clients still owe us?", "how much is owed to us");
t("no double in", () => assert.equal(normalizeRephrase("what did we invoice in total"), null)); to("what did we invoice mark henderson altogether", "what did we bill mark henderson in total"); to("What did we invoice Mark Henderson in total?", "What did we bill Mark Henderson in total");
const fx = (q, r) => t(`typo: ${q}`, () => assert.equal(fixTypos(q), r)); const nofx = (q) => fx(q, null);
fx("how many unpiad invoices", "how many unpaid invoices"); fx("how many unts do we have", "how many units do we have"); fx("show me the adress for mark henderson", "show me the address for mark henderson");
for (const n of ["Verdue Plumbing", "Unpad Co", "Adress Group", "Uints Ltd", "Addess Inc", "Waranty LLC"]) { nofx(`how much does ${n} owe us`); nofx(`what is ${n}'s address`); nofx(`${n} unpaid invoices`); }
to("what did we invoice in total", null);
for (const q of ["How many invoices do we have?", "invoices 2012", "invoices from March", "what do we owe our vendors", "how much do vendors owe us", "how many customers do we have", "list customers that owe us", "what is the warranty on the unit at 12 Main", "invoices for Mark Henderson", "overdue invoices", "the unit at 3247 Elm", "tickets 3 and 4"]) same(q);
// (2) years/dates do not veto; ids/street numbers/amounts do
for (const q of ["how much did this customer pay in 2026", "end date of this agreement in 2027", "what did we pay this vendor in March 2026", "this customer's invoices since 01/05/2026"]) t(`year is not a handle: ${q}`, () => assert.ok(thisNoun(q, q)));
for (const q of ["this customer owes INV-2101 how much", "what is this address 3247 Elm St", "does this customer owe $500"]) t(`id/amount is a handle: ${q}`, () => assert.equal(thisNoun(q, q), null));
// (2b) a context that resolved no entity still asks which; one that did is left alone
t("context without entity asks", () => assert.ok(classifyEarlyDecline("how much did this customer pay in 2026", { hasConversation: true, contextHasEntity: false })?.noun));
t("context with entity not pre-empted", () => assert.ok(!classifyEarlyDecline("how much did this customer pay in 2026", { hasConversation: true, contextHasEntity: true })?.noun));
// (4) lower-case names, help phrasings, bare demonstratives
for (const q of ["this customer smith owes how much", "this customer jane doe", "can I delete this job", "is this form required for permits", "this site is slow", "what is this account type in the app"]) t(`not declined: ${q}`, () => assert.equal(thisNoun(q, q), null));
for (const q of ["show this", "who is this?", "why is this overdue", "total jobs this year this customer", "what is this"]) t(`asks which: ${q}`, () => assert.ok(classifyEarlyDecline(q, { hasConversation: false })?.noun));
// (3) empty conversation turns count as no conversation (checked in the handler section below)
// ---- handler level (real /api/ask, model blocked): look-alike customer names, empty conversation, "this X in 2026" ----
const off = await import("./offline-exam.mjs"); const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && /^\{"(route|event|timestamp|level)"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); const mc = await off.installModelBlock(); const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { SCORECARD_CALL } = await import("../api/_lib/scorecard/hook.js"); const { default: askHandler } = await import("../api/ask.js");
const { buildOrgA, addNamedCustomer } = await import("./lib/forge-promise-bank.mjs");
const A = buildOrgA(); const NAMES = [["Verdue Plumbing", "5001.00"], ["Unpad Co", "5002.00"], ["Adress Group", "5003.00"], ["Npaid", "5004.00"], ["Uints", "5005.00"], ["Addess", "5006.00"], ["Waranty", "5007.00"], ["Nits", "5008.00"]];
NAMES.forEach(([n, amt], i) => addNamedCustomer(A.data, n, `${900 + i} Test Way, Mesa, AZ 85201`, `INV-77${i}`, amt));
const ctx = (await off.loadExportIntoNewTenant(lite, A.data, { tenantKey: "forge:ctx", tenantName: "forge-ctx" })).ctx;
async function ask(question, extra = {}) {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { res.headers[k] = v; return res; }, getHeader() {}, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; }, end() { return res; } };
  mc.n = 0; await askHandler({ method: "POST", headers: {}, query: {}, body: { question, today: "2026-10-07", ...extra }, [SCORECARD_CALL]: { auth: { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null } } }, res);
  const d = res.body?.data; return { text: [d?.text, ...(d?.facts ?? []).map((f) => `${f.label} ${f.value}`)].join(" "), kind: d?.kind, models: mc.n };
}
const fmt = (a) => "$" + Number(a).toLocaleString("en-US", { minimumFractionDigits: 2 });
for (const [n, amt] of NAMES) for (const f of [(x) => `how much does ${x} owe us`, (x) => `how much is ${x}'s invoice`, (x) => `${x} invoice total`]) {
  const q = f(n); const r = await ask(q);
  t(`org name stays a name (${q})`, () => { assert.ok(r.text.includes(fmt(amt)) || /which|more than one|couldn't|can't|not sure|tap one/i.test(r.text), r.text.slice(0, 120)); assert.ok(!r.text.includes("7,890"), "company total"); });
  const lo = await ask(q.toLowerCase());
  t(`org name lower-case (${q.toLowerCase()})`, () => { assert.ok(lo.text.includes(fmt(amt)) || /which|more than one|couldn't|can't|not sure|tap one/i.test(lo.text), lo.text.slice(0, 120)); assert.ok(!lo.text.includes("7,890"), "company total"); });
}
for (const q of ["how much did this customer pay in 2026", "end date of this agreement in 2027", "show this", "who is this?", "why is this overdue", "total jobs this year this customer"]) { const r = await ask(q); t(`handler asks which: ${q}`, () => { assert.ok(/which/i.test(r.text) && !/\$\d/.test(r.text) && !/Processing failed/.test(r.text), r.text.slice(0, 100)); assert.equal(r.models, 0); }); }
for (const ctxv of [{ turns: [] }, { turns: [{ question: "" }] }, { turns: "x" }]) { const r = await ask("how much did this customer pay in 2026", { conversationContext: ctxv }); t(`empty conversation = none (${JSON.stringify(ctxv)})`, () => assert.ok(/which/i.test(r.text) && !/\$\d/.test(r.text), r.text.slice(0, 100))); }
{ const r = await ask("how much did this customer pay in 2026", { conversationContext: { turns: [{ question: "hello" }] } }); t("context without an entity asks which", () => assert.ok(/which/i.test(r.text) && !/\$\d/.test(r.text), r.text.slice(0, 100))); }
console.log = realLog;
console.log(`forge-context: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
