#!/usr/bin/env node
/**
 * R40: a question that names an invoice amount is decided by the organization's own financial rows whose total EQUALS it, and nothing the model
 * composes is shown unless it is on the document it cites (the live failure: "wheres the invoice for 3470 from a customer" -> a confident wrong answer
 * with a wrong citation). Truth is computed from raw rows here, never from Donovan.
 */
import fs from "node:fs";
const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"claimCheck') )) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const { installScriptedModel, parsePassages } = await import("./lib/r40-model-stub.mjs");
const stub = await installScriptedModel();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const F = await import("./lib/r40-fixture.mjs");
const { checkGrounding, applyGrounding, extractClaims, claimSupportedIn } = await import("../api/_lib/grounding/gate.js");
const { parseAmountInvoiceQuestion } = await import("../api/_lib/financials/amountInvoice.js");

const orgs = new Map();
let orgSeq = 0;
const idMap = (str, k) => str.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (m) => ((parseInt(m[0], 16) + k) % 16).toString(16) + m.slice(1));
const load = async (d, key) => { const k = orgSeq++; if (k) { const m = JSON.parse(idMap(JSON.stringify(d), k)); for (const x of Object.keys(d)) delete d[x]; Object.assign(d, m); } const o = { ctx: (await off.loadExportIntoNewTenant(lite, d, { tenantKey: `offline:${key}`, tenantName: key })).ctx, d }; orgs.set(key, o); return o; };
const lats = [];
async function ask(key, question, { model = null } = {}) {
  const o = orgs.get(key); stub.fn = model; stub.calls = 0;
  const r = await askViaHandler({ handler: askHandler, auth: { tenantId: o.ctx.tenantKey, orgId: key, userId: null }, question, today: "2026-10-07" });
  lats.push(r.latencyMs);
  return { ...r, modelCalls: stub.calls, text: String(r.data?.text ?? ""), facts: r.data?.facts ?? [] };
}
let pass = 0; const fails = [];
const check = (name, ok, detail) => { if (ok) pass++; else { fails.push(`${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`); console.error = realLog; realLog(`FAIL ${name} :: ${String(detail ?? "").slice(0, 300)}`); console.error = () => {}; } };

// ---- raw-row truth
const money = (v) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const byTotal = (d, cents) => d.financials.filter((f) => ["invoice", "credit_memo"].includes(f.doc_kind) && f.total != null && (Math.round(Number(f.total) * 100) === cents || (f.doc_kind === "credit_memo" && Math.round(Number(f.total) * 100) === -cents)));
const pageOf = (d, did) => d.pages.filter((p) => p.document_id === did).map((p) => p.text).join("\n");
const numbersOf = (t) => new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => String(Number(x.replace(/,/g, "")))));
/** independent oracle: every $ amount and every invoice number stated in a final answer must be on a document the answer cites */
function confidentWrong(d, data) {
  if (!data || data.kind !== "answer") return null;
  const cited = [...new Set([...(data.sources ?? []), ...(data.facts ?? []).flatMap((f) => f.sources ?? [])].map((s) => s.documentId))];
  const hay = cited.map((id) => pageOf(d, id)).join("\n");
  const nums = numbersOf(hay);
  for (const f of data.facts ?? []) {
    const own = (f.sources ?? []).map((s) => pageOf(d, s.documentId)).join("\n"); const on = numbersOf(own);
    for (const m of String(f.value).matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) if (!on.has(String(Number(m[1].replace(/,/g, ""))))) return `card ${f.label}=${f.value} not on its cited document`;
  }
  for (const m of String(data.text).matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) if (!nums.has(String(Number(m[1].replace(/,/g, ""))))) return `text amount ${m[0]} not on a cited document`;
  for (const m of String(data.text).matchAll(/\bINV-[A-Z0-9]+\b/g)) if (!hay.includes(m[0])) return `text invoice ${m[0]} not on a cited document`;
  // dates, serials, addresses and person names: written independently of the product's gate
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const isoDates = (t) => { const out = new Set(); for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) if (MON[m[1].slice(0, 3).toLowerCase()]) out.add(`${m[3]}-${MON[m[1].slice(0, 3).toLowerCase()]}-${+m[2]}`);
    for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.add(`${m[3]}-${+m[1]}-${+m[2]}`); for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) out.add(`${m[1]}-${+m[2]}-${+m[3]}`); return out; };
  const claimed = `${data.text}\n${(data.facts ?? []).map((f) => `${f.label} ${f.value}`).join("\n")}`;
  const pageDates = isoDates(hay); for (const dt of isoDates(claimed)) if (!pageDates.has(dt)) return `date ${dt} not on a cited document`;
  for (const m of claimed.matchAll(/\b[A-Z]{1,3}\d{5,}\b/g)) if (!hay.includes(m[0])) return `serial ${m[0]} not on a cited document`;
  const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const m of claimed.matchAll(/\b\d{2,5} [NSEW]\.? [A-Za-z ]+? (?:Rd|St|Ave)\b,? (?:Apt|Unit) \d+/g)) if (!flat(hay).includes(flat(m[0]).replace("rd", "rd"))) return `address ${m[0]} not on a cited document`;
  for (const m of claimed.matchAll(/\bfor ([A-Z][a-z]+ [A-Z][a-z]+)\b/g)) if (!flat(hay).includes(flat(m[1]))) return `name ${m[1]} not on a cited document`;
  for (const f of data.facts ?? []) if (/^(?:customer|name|bill to|tenant)/i.test(f.label)) { const own = (f.sources ?? []).map((s) => pageOf(d, s.documentId)).join("\n"); if (!flat(own).includes(flat(f.value))) return `card name ${f.value} not on its document`; }
  return null;
}

/* ================================================================== 1. THE LIVE CASE FIRST */
const live = await load(F.liveFixture(), "r40-live");
const T226 = live.d.financials.find((f) => f.invoice_number === "INV-T226");
const truth3470 = byTotal(live.d, 347000);
check("fixture: exactly one $3,470 invoice (INV-60003, Fenwick, 2018)", truth3470.length === 1 && truth3470[0].invoice_number === "INV-60003" && truth3470[0].customer_name === "Ronald Fenwick");
const wrongLive = (prompt) => { const ps = parsePassages(prompt); const t = ps.find((p) => /INV-T226/.test(p.text)) ?? ps[0];
  return { text: "The $3,470.00 invoice is for Ronald Calloway at 3300 S Alma School Rd, Apt 103, Mesa, AZ 85201 — it's invoice INV-T226 dated September 5, 2026, for a seasonal maintenance check on a Lennox condenser (serial LX100030).", confidence: 0.95,
    facts: [{ label: "Cost", value: "$3,470.00", status: "info", sources: [{ documentId: t.documentId, location: { page: t.page } }] }, { label: "Service Date", value: "September 5, 2026", sources: [{ documentId: t.documentId, location: { page: t.page } }] }] }; };
for (const q of ["wheres the invoice for 3470 from a customer", "where's the invoice for 3470", "the invoice for 3470", "invoice for $3,470", "$3,470 invoice", "invoice for 3470.00 from a customer", "who has a 3470 invoice", "how much was the invoice for 3470", "show me the 3,470 invoice", "invoice for 3470 dollars", "invoice for $3.47k", "find the $3470 invoice", "wheres the invoice for $3,470.00", "Where Is The Invoice For 3470", "which invoice is for 3470?"]) {
  const r = await ask("r40-live", q, { model: wrongLive });
  check(`live: ${q}`, /INV-60003/.test(r.text) && /Ronald Fenwick/.test(r.text) && /\$3,470\.00/.test(r.text) && !/Calloway|T226|\$350/.test(r.text) && r.modelCalls === 0 && r.data?.kind === "answer", r.text);
  check(`live cards: ${q}`, r.facts.every((f) => f.sources.every((s) => s.documentId === truth3470[0].document_id)) && r.facts.length >= 1, JSON.stringify(r.facts).slice(0, 200));
}
// the amount that IS INV-T226's total points at INV-T226 and nothing else
{ const r = await ask("r40-live", "invoice for $350", { model: wrongLive }); check("live: $350 -> INV-T226 only", /INV-T226/.test(r.text) && /Calloway/.test(r.text) && !/Fenwick/.test(r.text), r.text); }
// an amount nobody has: honest none, never the near address
{ const r = await ask("r40-live", "invoice w/ total 3470"); check("r4 w/ total 3470 is the amount lane, not a shop-wide count", !/^You have \d+ /.test(r.text) && /3,470/.test(r.text), r.text); const r2 = await ask("r40-live", "invoice for -3470"); check("r4 negative amount is never answered as positive", !/totals \$3,470/.test(r2.text), r2.text); }
for (const [q, re] of [["customer 1042 invoice", /\$1,042/], ["how many invoices for 10 customers", /\$10\.00/], ["invoices for 3 customers", /\$3\.00/]]) { const r = await ask("r40-live", q); check(`r3 customer number/count is not an amount: ${q}`, !/has a total of/.test(r.text) || !re.test(r.text), r.text); }
for (const q of ["invoice for $3,471", "invoice for 3470.01", "wheres the invoice for 34700 from a customer"]) { const r = await ask("r40-live", q, { model: wrongLive }); check(`live none: ${q}`, /^No invoice on file has a total of/.test(r.text) && r.data.kind === "answer" && !/Calloway|Fenwick|INV-/.test(r.text.replace(/None is numbered[^.]*\./, "")), r.text); }

/* ---- the model-composed path: the live wrong text, and other plausible wrong outputs, must be caught whatever the model does */
const NOLANE = "show 3470 invoice Calloway Alma School seasonal maintenance"; // reaches retrieval + model (no lane claims it)
const T226doc = live.d.documents.find((x) => x.original_filename === "226-invoice-topup-apt3.pdf").id;
const docs60003 = live.d.documents.find((x) => x.original_filename === "583-invoice-apt3.pdf").id;
const cite = (id) => [{ documentId: id, location: { page: 1 } }];
const wrongOutputs = {
  "live text+cards (T226 cited)": () => ({ text: "The $3,470.00 invoice is for Ronald Calloway at 3300 S Alma School Rd, Apt 103, Mesa, AZ 85201 — it's invoice INV-T226 dated September 5, 2026, for a seasonal maintenance check.", confidence: 0.95, facts: [{ label: "Cost", value: "$3,470.00", sources: cite(T226doc) }, { label: "Service Date", value: "September 5, 2026", sources: cite(T226doc) }] }),
  "T226 identity glued onto INV-60003's document": () => ({ text: "Invoice INV-T226 for Ronald Calloway totals $3,470.00.", confidence: 0.9, facts: [{ label: "Cost", value: "$3,470.00", sources: cite(docs60003) }, { label: "Invoice", value: "#INV-T226", sources: cite(docs60003) }] }),
  "right amount, wrong customer": () => ({ text: "The $3,470.00 invoice is for Ronald Calloway.", confidence: 0.9, facts: [{ label: "Cost", value: "$3,470.00", sources: cite(docs60003) }] }),
  "right document, wrong date": () => ({ text: "Invoice INV-60003 is dated September 5, 2026 and totals $3,470.00.", confidence: 0.9, facts: [{ label: "Service Date", value: "September 5, 2026", sources: cite(docs60003) }] }),
  "right document, wrong invoice number": () => ({ text: "Invoice INV-60004 for Ronald Fenwick totals $3,470.00.", confidence: 0.9, facts: [{ label: "Invoice", value: "#INV-60004", sources: cite(docs60003) }] }),
  "wrong address (other unit)": () => ({ text: "Ronald Fenwick lives at 3300 S Alma School Rd, Apt 104, Mesa.", confidence: 0.9, facts: [{ label: "Address", value: "3300 S Alma School Rd, Apt 104, Mesa, AZ 85201", sources: cite(docs60003) }] }),
  "serial number from the other document": () => ({ text: "The unit on invoice INV-60003 is serial LX100030.", confidence: 0.9, facts: [{ label: "Serial", value: "LX100030", sources: cite(docs60003) }] }),
  "amount only in the question, card cites an unrelated doc": () => ({ text: "The invoice you asked about is $3,470.00.", confidence: 0.9, facts: [{ label: "Total", value: "$3,470.00", sources: cite(T226doc) }] }),
  "wrong customer on a customer card": () => ({ text: "The customer on INV-60003 is on file.", confidence: 0.9, facts: [{ label: "Customer", value: "Ronald Calloway", sources: cite(docs60003) }] }),
  "good card, bad headline": () => ({ text: "Invoice INV-T226 for Ronald Calloway totals $3,470.00 for a seasonal maintenance check.", confidence: 0.9, facts: [{ label: "Technician", value: "Ray Sutton", sources: cite(T226doc) }] }),
};
for (const [name, fn] of Object.entries(wrongOutputs)) {
  const r = await ask("r40-live", NOLANE, { model: fn });
  const wrong = confidentWrong(live.d, r.data);
  // a wrong claim may never be shown: the answer is withdrawn / the card removed, or what remains is on its documents
  check(`model wrong output [${name}]`, r.modelCalls >= 1 && !wrong && !(r.data?.kind === "answer" && r.data.confidence >= 0.85 && /Calloway|T226/.test(r.text) && /3,470/.test(r.text)), `${wrong} :: ${r.text}`);
}
// the live wrong output, exactly: withdrawn, says what the cited document does show
{ const r = await ask("r40-live", NOLANE, { model: wrongOutputs["live text+cards (T226 cited)"] });
  check("live wrong output is withdrawn with an honest line", r.data?.kind === "no-answer" && r.data.confidence === 0 && r.data.facts.length === 0 && /does not show \$3,470\.00; it shows a total of \$350\.00/.test(r.text), r.text); }
// correct model outputs must survive (formats vary: $350, 350.00, 09/05/2026, September 5, 2026, case)
const goodOutputs = {
  "good T226 answer": () => ({ text: "Invoice INV-T226 for Ronald Calloway totals $350.00, dated September 5, 2026.", confidence: 0.9, facts: [{ label: "Total", value: "$350.00", sources: cite(T226doc) }, { label: "Customer", value: "Ronald Calloway", sources: cite(T226doc) }, { label: "Date", value: "09/05/2026", sources: cite(T226doc) }, { label: "Serial", value: "LX100030", sources: cite(T226doc) }] }),
  "good T226 answer, other formats": () => ({ text: "invoice inv-t226 is for ronald calloway at 3300 S Alma School Rd Apt 103, total $350, 2026-09-05.", confidence: 0.9, facts: [{ label: "Cost", value: "$350", sources: cite(T226doc) }] }),
};
for (const [name, fn] of Object.entries(goodOutputs)) { const r = await ask("r40-live", "show 350 invoice Calloway Alma School seasonal maintenance", { model: fn }); check(`model good output kept [${name}]`, r.data?.kind === "answer" && r.facts.length >= 1, `${r.data?.kind} ${r.text}`); }

/* ================================================================== 2. THE CLASS: amount-named questions on fresh data variants */
const base = F.loadGolden();
const fresh = (name, fn) => { const d = JSON.parse(JSON.stringify(base)); d.tenantKey = name; d.tenantName = name; fn(d); return d; };
const ADDR = F.ADDR;
// V1: two invoices with the same total, same day, same address, different customers + a credit memo + a vendor bill + a CAD invoice with the same number
const v1 = fresh("r40-v1", (d) => { const c1 = F.addCustomer(d, "Zed Alpha", "100 W Test St, Mesa, AZ 85201"), c2 = F.addCustomer(d, "Yan Beta", "100 W Test St, Mesa, AZ 85201");
  F.addInvoice(d, { num: "INV-Z1", customer: "Zed Alpha", customerId: c1, dateIso: "2026-08-01", dateUs: "08/01/2026", addr: "100 W Test St, Mesa, AZ 85201", desc: "Repair", total: "777.00", filename: "z1.pdf", jobKey: "100-w-test-mesa" });
  F.addInvoice(d, { num: "INV-Z2", customer: "Yan Beta", customerId: c2, dateIso: "2026-08-01", dateUs: "08/01/2026", addr: "100 W Test St, Mesa, AZ 85201", desc: "Repair", total: "777.00", filename: "z2.pdf", jobKey: "100-w-test-mesa" });
  F.addInvoice(d, { num: "CM-Z1", customer: "Zed Alpha", customerId: c1, dateIso: "2026-08-02", dateUs: "08/02/2026", addr: "100 W Test St, Mesa, AZ 85201", desc: "Credit", total: "-777.00", kind: "credit_memo", filename: "cm1.pdf" });
  F.addInvoice(d, { num: "BILL-9", customer: "Zed Alpha", dateIso: "2026-08-03", dateUs: "08/03/2026", addr: "9 Vendor Way", desc: "Parts", total: "777.00", direction: "payable", filename: "bill9.pdf" });
  F.addInvoice(d, { num: "INV-CAD", customer: "Yan Beta", dateIso: "2026-08-04", dateUs: "08/04/2026", addr: "100 W Test St", desc: "Parts", total: "777.00", currency: "CAD", filename: "cad.pdf" });
  // 13777 contains 3777.. and 777 as substrings; 4,777 / 1777 are other amounts
  F.addInvoice(d, { num: "INV-BIG", customer: "Yan Beta", dateIso: "2026-08-05", dateUs: "08/05/2026", addr: "1 Big Rd", desc: "Install", total: "13777.00", filename: "big.pdf" });
  F.addInvoice(d, { num: "INV-LINE", customer: "Zed Alpha", dateIso: "2026-08-06", dateUs: "08/06/2026", addr: "2 Line Rd", desc: "Part", total: "1000.00", lines: [{ description: "Compressor", amount: "555.00" }, { description: "Labor", amount: "445.00" }], filename: "line.pdf" });
  F.addInvoice(d, { num: "INV-NOPRICE", customer: "Zed Alpha", dateIso: "2026-08-07", dateUs: "08/07/2026", addr: "3 Free Rd", desc: "Quote visit", total: null, filename: "noprice.pdf" }); });
await load(v1, "r40-v1");
const v1Truth = byTotal(v1, 77700).map((f) => f.invoice_number).sort();
check("v1 truth: 4 documents total $777 (2 invoices, 1 credit memo, 1 vendor bill, 1 CAD invoice = 5)", v1Truth.length === 5, v1Truth.join(","));
for (const q of ["invoice for 777", "the invoice for $777", "$777.00 invoice", "invoices for 777 dollars", "wheres the invoice for 777 from a customer", "who has a 777 invoice"]) {
  const r = await ask("r40-v1", q);
  const stated = [...r.text.matchAll(/\b(?:INV|CM|BILL)-[A-Z0-9]+\b/g)].map((m) => m[0]).sort();
  check(`v1 several: ${q}`, JSON.stringify([...new Set(stated)]) === JSON.stringify(v1Truth) && !/BIG|LINE|NOPRICE/.test(r.text) && /5 invoices total \$777\.00/.test(r.text), r.text);
}
{ const r = await ask("r40-v1", "invoice for 13777"); check("v1 substring: 13777 -> INV-BIG only", /INV-BIG/.test(r.text) && !/Z1|Z2|CM-Z1/.test(r.text), r.text); }
{ const r = await ask("r40-v1", "invoice for 3777"); check("v1 substring: 3777 -> none", /^No invoice on file has a total of \$3,777\.00/.test(r.text) && !/INV-BIG|Z1/.test(r.text), r.text); }
{ const r = await ask("r40-v1", "invoice for 77"); check("v1 substring: 77 -> none", /^No invoice on file has a total of \$77\.00/.test(r.text), r.text); }
{ const r = await ask("r40-v1", "invoice for $555"); check("v1 line item only: says line item, never as an invoice total", /No invoice has a total of \$555\.00/.test(r.text) && /line item/.test(r.text) && /INV-LINE/.test(r.text) && !/totals \$555/.test(r.text), r.text); }
{ const r = await ask("r40-v1", "invoice for $1,000"); check("v1 total of invoice with lines", /INV-LINE/.test(r.text) && /totals \$1,000\.00/.test(r.text), r.text); }
{ const r = await ask("r40-v1", "invoice for $777.50"); check("v1 none mentions unpriced invoices honestly", /^No invoice on file has a total of \$777\.50/.test(r.text) && /could not be checked/.test(r.text) && /\b\d+ invoices? prints? no total/.test(r.text), r.text); }
{ // facts all point at the document that holds the amount
  const r = await ask("r40-v1", "invoice for 777"); const ok = r.facts.length === 5 && r.facts.every((f) => { const row = v1.financials.find((x) => x.document_id === f.sources[0].documentId); return row && /777/.test(f.value) && f.label.includes(row.invoice_number); }); check("v1 cards: every chip is the document that holds the amount", ok, JSON.stringify(r.facts.map((f) => [f.label, f.value]))); }

// V2: same address two invoices, different customers, different amounts; previous and current occupant; amount in neither
const v2 = fresh("r40-v2", (d) => { const a = F.addCustomer(d, "Prior Tenant", "55 N Oak Ave, Apt 2, Tempe, AZ 85281"), b = F.addCustomer(d, "Current Tenant", "55 N Oak Ave, Apt 2, Tempe, AZ 85281");
  F.addInvoice(d, { num: "INV-OLD", customer: "Prior Tenant", customerId: a, dateIso: "2019-05-05", dateUs: "05/05/2019", addr: "55 N Oak Ave, Apt 2, Tempe, AZ 85281", desc: "Install", total: "4820.00", filename: "old.pdf", jobKey: "55-n-oak-u2-tempe" });
  F.addInvoice(d, { num: "INV-NEW", customer: "Current Tenant", customerId: b, dateIso: "2026-09-09", dateUs: "09/09/2026", addr: "55 N Oak Ave, Apt 2, Tempe, AZ 85281", desc: "Tune up", total: "120.00", filename: "new.pdf", jobKey: "55-n-oak-u2-tempe" }); });
await load(v2, "r40-v2");
{ const r = await ask("r40-v2", "invoice for 4820"); check("v2 prior occupant amount -> prior occupant only", /INV-OLD/.test(r.text) && /Prior Tenant/.test(r.text) && !/Current Tenant|INV-NEW|\$120/.test(r.text), r.text); }
{ const r = await ask("r40-v2", "invoice for 120"); check("v2 current occupant amount -> current occupant only", /INV-NEW/.test(r.text) && /Current Tenant/.test(r.text) && !/Prior Tenant|INV-OLD|4,820/.test(r.text), r.text); }
{ const r = await ask("r40-v2", "invoice for 4821"); check("v2 near amount -> none, never the same-address invoice", /^No invoice on file has a total of \$4,821\.00/.test(r.text) && !/Tenant|INV-OLD|INV-NEW/.test(r.text), r.text); }

// V3: a second organization holding a $3,470 invoice must never leak into the first, and vice versa
const v3 = fresh("r40-v3", (d) => { d.financials = d.financials.filter((f) => Math.round(Number(f.total) * 100) !== 347000); });
const other = fresh("r40-other", (d) => { d.financials = d.financials.filter((f) => Math.round(Number(f.total) * 100) !== 347000); const c = F.addCustomer(d, "Zoe Otherorg", "9 Secret Ln, Gilbert, AZ 85233"); F.addInvoice(d, { num: "INV-SECRET", customer: "Zoe Otherorg", customerId: c, dateIso: "2026-01-02", dateUs: "01/02/2026", addr: "9 Secret Ln, Gilbert, AZ 85233", desc: "Install", total: "3470.00", filename: "secret.pdf" }); });
await load(v3, "r40-v3"); await load(other, "r40-other");
{ const r = await ask("r40-v3", "invoice for 3470"); check("v3 org without a $3,470 invoice: none, no leak", /^No invoice (?:on file|I could read) has a total of \$3,470\.00/.test(r.text) && !/SECRET|Otherorg|Fenwick|60003/.test(r.text), r.text); }
{ const r = await ask("r40-other", "invoice for 3470"); check("v3 other org sees only its own", /INV-SECRET/.test(r.text) && !/Fenwick|60003|Calloway/.test(r.text), r.text); }
{ const r = await ask("r40-v3", "wheres the invoice for 3470 from a customer", { model: wrongLive }); check("v3 model path cannot leak the other org either", !/SECRET|Otherorg/.test(JSON.stringify(r.data)), r.text); }

// V4: corrections: a person corrected the printed total; the corrected value decides
const v4 = fresh("r40-v4", (d) => { const f = d.financials.find((x) => x.invoice_number === "INV-60003"); f.corrections = { total: "3480.00" }; });
await load(v4, "r40-v4");
{ const r = await ask("r40-v4", "invoice for 3470"); check("v4 corrected total: old amount is not the total (a stale line item is said as a line item)", /^No invoice (?:on file )?has a total of \$3,470\.00/.test(r.text) && !/totals \$3,470/.test(r.text), r.text); }
{ const r = await ask("r40-v4", "invoice for 3480"); check("v4 corrected total: new amount found", /INV-60003/.test(r.text) && /\$3,480\.00/.test(r.text), r.text); }

// V5: an organization whose invoice numbers are plain numbers: "invoice for 5521" can name the number AND an amount
const v5 = fresh("r40-v5", (d) => { const c = F.addCustomer(d, "Num Person", "7 Num St, Mesa, AZ 85201"); F.addInvoice(d, { num: "5521", customer: "Num Person", customerId: c, dateIso: "2026-02-02", dateUs: "02/02/2026", addr: "7 Num St, Mesa, AZ 85201", desc: "Svc", total: "90.00", filename: "n1.pdf" });
  F.addInvoice(d, { num: "N-2", customer: "Num Person", customerId: c, dateIso: "2026-02-03", dateUs: "02/03/2026", addr: "7 Num St, Mesa, AZ 85201", desc: "Svc", total: "5521.00", filename: "n2.pdf" }); });
await load(v5, "r40-v5");
{ const r = await ask("r40-v5", "invoice for 5521"); check("v5 number-vs-amount both said, each labelled", /N-2/.test(r.text) && /totals \$5,521\.00/.test(r.text) && /#5521/.test(r.text) && /numbered 5521/.test(r.text) && /\$90\.00/.test(r.text), r.text); }
{ const r = await ask("r40-v5", "invoice for $5,521"); check("v5 explicit $ amount never reads as a number", /N-2/.test(r.text) && !/numbered/.test(r.text), r.text); }

/* ---- random amounts drawn from raw rows (truth computed independently): exact list, every form */
{ const amounts = [...new Set(base.financials.filter((f) => f.doc_kind === "invoice" && f.total != null).map((f) => Math.round(Number(f.total) * 100)))];
  let seed = 40; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const picks = Array.from({ length: 18 }, () => amounts[rnd(amounts.length)]);
  for (const c of picks) {
    const truth = byTotal(base, c).map((f) => f.invoice_number).sort(); const whole = c % 100 === 0; const dollars = c / 100;
    const forms = [`invoice for $${money(dollars)}`, `the invoice for ${money(dollars)} from a customer`, whole ? `wheres the invoice for ${dollars}` : `invoice for ${dollars.toFixed(2)}`];
    for (const q of forms) { const r = await ask("r40-live", q); const got = [...new Set([...r.text.matchAll(/INV-[A-Z0-9]+/g)].map((m) => m[0]))].sort();
      const expected = byTotal(live.d, c).map((f) => f.invoice_number).sort();
      check(`random amount ${money(dollars)}: ${q}`, JSON.stringify(got) === JSON.stringify(expected) && r.modelCalls === 0, `${expected.join(",")} vs ${r.text}`); }
  }
}

/* ---- must NOT be claimed by the amount lane (other lanes / decline own them); and never answered with an unfiltered total */
for (const q of ["invoices over $3,000", "how many invoices between $2,000 and $3,000", "invoice for Ronald Fenwick for 3470", "invoices from 2020", "invoice for 2020", "invoice INV-60003", "invoice 3470 and 350", "invoice for about 3470", "invoice for 3,47", "invoice for 3470 and 350"]) {
  check(`not claimed by the amount lane: ${q}`, parseAmountInvoiceQuestion(q) === null, JSON.stringify(parseAmountInvoiceQuestion(q)));
}
for (const q of ["how many invoices between $2,000 and $3,000", "invoice for 3470 and 350", "invoice for Ronald Fenwick for 3470", "how much was the invoice for $3,470 last year"]) {
  const r = await ask("r40-live", q);
  check(`never the unfiltered total/count: ${q}`, !/\b(?:572,562|You have 121|121 invoices|120 invoices)\b/.test(r.text) || /between/.test(q) && !/We have 120 invoices/.test(r.text), r.text);
}

/* ================================================================== 3. the gate itself (pure): claim extraction + normalisation */
const ev = new Map(); ev.set("d1", { pages: new Map([[1, pageOfT226()]]), rows: "total: 350.00\ninvoice_number: INV-T226\ninvoice_date: 2026-09-05\ncustomer_name: Ronald Calloway\n", label: "Invoice #INV-T226" });
function pageOfT226() { return live.d.pages.find((p) => p.document_id === T226doc).text; }
const sup = (text, ctx = {}) => { const claims = extractClaims(text, ctx); return claims.map((c) => [c.kind, c.raw, claimSupportedIn(c, `${pageOfT226()}\n`)]); };
check("gate: $350 / $350.00 / 350 supported", sup("$350.00").every((x) => x[2]) && sup("$350").every((x) => x[2]) && sup("350", { moneyContext: true }).every((x) => x[2]));
check("gate: $3,470 unsupported on T226", sup("$3,470.00").every((x) => !x[2]));
check("gate: date formats", sup("September 5, 2026").every((x) => x[2]) && sup("Sep 5, 2026").every((x) => x[2]) && sup("2026-09-05").every((x) => x[2]) && sup("9/5/2026").every((x) => x[2]) && sup("September 6, 2026").every((x) => !x[2]));
check("gate: id case/dash/space", sup("INV-T226").every((x) => x[2]) && sup("inv-t226").every((x) => x[2]) && sup("INV-T227").every((x) => !x[2]) && sup("LX100030").every((x) => x[2]) && sup("LX10003").every((x) => !x[2]));
check("gate: address unit matters", sup("3300 S Alma School Rd, Apt 103").every((x) => x[2]) && sup("3300 S Alma School Rd, Apt 104").every((x) => !x[2]) && sup("3300 South Alma School Road Unit 103").every((x) => x[2]));
check("gate: name after cue", sup("The invoice is for Ronald Calloway").some((x) => x[0] === "name" && x[2]) && sup("The invoice is for Ronald Fenwick").some((x) => x[0] === "name" && !x[2]) && sup("invoice is for Calloway, Ronald").length >= 0);
check("gate: digits glued to ids/dates/phones are not amounts", extractClaims("call 480-555-0199 about serial LX100030 on 09/05/2026").every((c) => c.kind !== "money"));
check("gate: 3470 inside 13470 is not 3470", !claimSupportedIn({ kind: "money", value: "3470" }, "TOTAL DUE: $13470.00") && claimSupportedIn({ kind: "money", value: "13470" }, "TOTAL DUE: $13470.00"));
check("gate: counts and hours are not checked as amounts", extractClaims("2.5 hrs, 4 ton, 12 units, 3 invoices").every((c) => c.kind !== "money"));
{ // never throws / fails closed on missing evidence
  const out = applyGrounding({ kind: "answer", text: "Invoice INV-T226 totals $350.00.", facts: [{ label: "Total", value: "$350.00", sources: cite("nope") }], sources: cite("nope"), confidence: 0.9 }, new Map(), {});
  check("gate: unreadable cited document -> withdrawn, not shown", out.kind === "no-answer" && out.confidence === 0 && out.facts.length === 0, JSON.stringify(out).slice(0, 200)); }
{ const out = applyGrounding({ kind: "answer", text: "ok", facts: [], sources: [], confidence: 0.9 }, new Map(), {}); check("gate: nothing checkable -> unchanged", out.kind === "answer"); }


/* ---- reviewer-found holes (round 1) as pure gate cases, fresh data: INV-0042 / INV-0043 */
{
  const P42 = "Invoice #: INV-0042\nDate: 3/5/26\nBill To: Patrick O'Neil-Ruiz Jr.\nService Address: 77 E Elm St #4B, Tempe, AZ 85281\nPO#7781\nPermit B26-004411\nSerial: 4821907AB\nRefrigerant R-410A\nSubtotal $534.50\nCredit -$200.00\nLabor: 4 hrs at $95.00/hr\nTonnage: 3 ton\nPhone: (480) 555-1212\nEmail: pat@elmhvac.com\nAgreement $89/month\n10-year parts warranty\nTOTAL DUE: $1,234.50\nTechnician: Dale Whitcomb\nHours 8am-5pm";
  const P43 = "Invoice #: INV-0043\nDate: 3/9/26\nBill To: José M. Alvarez\nService Address: 77 E Elm St #4C, Tempe, AZ 85281\nPhone: 480-555-3470\nTOTAL DUE: $13,470.00";
  const E = new Map([["d42", { pages: new Map([[1, P42]]), rows: "total: 1234.50\ninvoice_number: INV-0042\n", label: "INV-0042", totalNum: "1234.5", total: "$1,234.50" }], ["d43", { pages: new Map([[1, P43]]), rows: "total: 13470.00\n", label: "INV-0043", totalNum: "13470", total: "$13,470.00" }]]);
  const P70 = "Invoice #: 3470\nInvoice Date: 9/5/26\nDue Date: 10/5/26\nSubtotal $300.00\nTax $50.00\nTOTAL DUE: $350.00\nAmount Paid $100.00\nBalance Due $250.00\nPO#5521\nSerial: LX100030";
  E.set("d70", { pages: new Map([[1, P70]]), rows: "total: 350.00\ninvoice_number: 3470\n", label: "INV 3470", totalNum: "350", total: "$350.00" });
  const c70 = [{ documentId: "d70", location: { page: 1 } }];
  E.set("d80", { pages: new Map([[1, "LEASE\nLease start: 1/1/2026\nLease end: 12/31/2026\nMonthly rent $1,850.00\nSecurity deposit $2,775.00\nPet fee $300.00\nParking spaces: 2\nUnit 12"]]), rows: "", label: "Lease" });
  E.set("d81", { pages: new Map([[1, "PERMIT\nPermit No. B26-004411\nDate issued 2/3/2026\nExpires 8/3/2026\nCertificate no. WC-77120\nSerial 99812A7\n10 years parts, 1 year labor\nArrival: 8:15 AM\nDeparture: 10:45 AM\nFilters replaced: 3\nUnits serviced: 6"]]), rows: "", label: "Permit" });
  E.set("d90", { pages: new Map([[1, "PROPOSAL\nOption A: Basic tune-up $6,200.00\nOption B: Full replace $7,450.00\nOption C: Premium $9,100.00\nINV-1001 $500.00 1/20/26\nINV-1002 $1,250.00 2/20/26\nItem 1: 12 x copper tee $4.50 = $54.00\nItem 2: 40 x PVC elbow $1.25 = $50.00"]]), rows: "", label: "Proposal" });
  E.set("d91", { pages: new Map([[1, "AGREEMENT\nAnnual price: $389.00\nMonthly installment: $32.42\nTerm: 3 years\nVisits per year: 2\nLast service: 3/1/2026\nNext service: 9/1/2026\nBill To: Sunrise Plumbing LLC\n100 N Central Ave, Phoenix, AZ 85004\nShip To: Desert Ridge Job Site\n500 W Deer Valley Rd, Phoenix, AZ 85027\nOrder date: 2/2/2026\nDelivery date: 2/20/2026\nTOTAL DUE: $1,100.00"]]), rows: "", label: "Agreement", totalNum: "1100", total: "$1,100.00" });
  const c90 = [{ documentId: "d90", location: { page: 1 } }], c91 = [{ documentId: "d91", location: { page: 1 } }];
  E.set("d95", { pages: new Map([[1, "SERVICE REPORT\nBefore: Suction 138 psi, Superheat 24 F\nAfter: Suction 118 psi, Superheat 12 F\nUsage 800 kWh\nEnergy Charge $96.00\nDelivery Charge $41.20\nTax $7.10\nTOTAL AMOUNT DUE $144.30\nOpening Balance $1,200.00\nPayments $700.00\nClosing Balance $950.00\nPast Due $250.00\nMinimum Payment $75.00"]]), rows: "", label: "Report", totalNum: "144.3", total: "$144.30" });
  E.set("d96", { pages: new Map([[1, "CHANGE ORDER 3\nOriginal Contract $48,000.00\nPrevious Change Orders $2,500.00\nThis Change Order $1,850.00\nNew Contract Sum $52,350.00\nQty Part No Description Unit Price Ext\n1 CNT-24V Contactor $42.00 $42.00\n3 FLT-20 Filter $9.00 $27.00\nCertificate Holder: Desert Ridge HOA\nInsured: Sonoran Air LLC\nEach Occurrence $1,000,000.00\nAggregate $2,000,000.00"]]), rows: "", label: "Change order" });
  const c95 = [{ documentId: "d95", location: { page: 1 } }], c96 = [{ documentId: "d96", location: { page: 1 } }];
  E.set("d97", { pages: new Map([[1, "INVOICE 20871\nBill To: Maria Gonzalez\nTotal $1,680.59\nPayments received -$500.00\nAmount Due $1,180.59\nStartup: Supply voltage L1-L2: 478 V\nSuperheat: 11 F\nSubcooling: 9 F\nCompressor amps: 18.4 A\nTechnician: Luis Ortega\nWaiver signed by Beta Plumbing LLC"]]), rows: "", label: "INV 20871", totalNum: "1680.59", total: "$1,680.59" });
  E.set("d98", { pages: new Map([[1, "INVOICE 20871\nBill To: Thomas Wright\nTotal $375.00"]]), rows: "", label: "INV 20871 B", totalNum: "375", total: "$375.00" });
  const c97 = [{ documentId: "d97", location: { page: 1 } }], c98 = [{ documentId: "d98", location: { page: 1 } }];
  E.set("d99", { pages: new Map([[1, "APPLIANCE INVOICE\nEstimate date: 8/14/2026\nValid until: 9/13/2026\nTotal $298.00\nDeposit paid $75.00\nBalance due $223.00\nPipe diameter: 4 inch\nFine $75.00\nSecond notice fine $150.00"]]), rows: "", label: "Appliance", totalNum: "298", total: "$298.00" });
  const c99 = [{ documentId: "d99", location: { page: 1 } }];
  const c80 = [{ documentId: "d80", location: { page: 1 } }], c81 = [{ documentId: "d81", location: { page: 1 } }];
  const c42 = [{ documentId: "d42", location: { page: 1 } }], c43 = [{ documentId: "d43", location: { page: 1 } }];
  const run = (o) => applyGrounding({ kind: "answer", confidence: 0.9, sources: [...(o.facts ?? []).flatMap((f) => f.sources)], ...o }, E, {});
  const shownWrong = (out) => out.kind === "answer" && out.groundingNote === undefined && !out.claimCheck.unsupported.length ? false : out.kind === "answer" && (out.facts?.length ?? 0) > 0 && out.claimCheck.removedFacts === 0;
  const bad = {
    "computed money": { text: "Here is the invoice.", facts: [{ label: "Cost", value: "$99,999.00", modelBasis: "computed", sources: c42 }] },
    "computed date": { text: "Here is the invoice.", facts: [{ label: "Date", value: "1/2/2020", modelBasis: "computed", sources: c42 }] },
    "union glue amount+name": { text: "The $13,470.00 invoice is for Patrick O'Neil-Ruiz Jr.", facts: [{ label: "Amount due", value: "$13,470.00", sources: c43 }, { label: "Customer", value: "Patrick O'Neil-Ruiz Jr.", sources: c42 }] },
    "swapped amounts both docs cited": { text: "INV-0042 is $13,470.00 and INV-0043 is $1,234.50.", facts: [{ label: "A", value: "x", sources: c42 }, { label: "B", value: "y", sources: c43 }] },
    "near name card": { text: "ok", facts: [{ label: "Customer", value: "Patrick O'Neill", sources: c42 }] },
    "name Alvarado": { text: "ok", facts: [{ label: "Customer", value: "José M. Alvarado", sources: c43 }] },
    "headline name after cue": { text: "The invoice is for Peter J. Smith Jr.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "headline name possessive": { text: "Peter Smith's invoice is on file.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "role: technician as customer": { text: "ok", facts: [{ label: "Customer", value: "Dale Whitcomb", sources: c42 }] },
    "invoice number 43": { text: "ok", facts: [{ label: "Invoice #", value: "43", sources: c42 }] },
    "PO 7782": { text: "ok", facts: [{ label: "PO number", value: "7782", sources: c42 }] },
    "serial": { text: "ok", facts: [{ label: "Serial number", value: "4821908", sources: c42 }] },
    "unit 4C on 4B doc": { text: "ok", facts: [{ label: "Unit", value: "#4C", sources: c42 }] },
    "phone": { text: "ok", facts: [{ label: "Phone", value: "(602) 555-9999", sources: c42 }] },
    "email": { text: "ok", facts: [{ label: "Email", value: "bob@elmhvac.com", sources: c42 }] },
    "tonnage": { text: "ok", facts: [{ label: "Tonnage", value: "5 ton", sources: c42 }] },
    "per month": { text: "ok", facts: [{ label: "Agreement", value: "$79/month", sources: c42 }] },
    "per year wrong": { text: "ok", facts: [{ label: "Fee", value: "$9,068/yr", sources: c42 }] },
    "range": { text: "ok", facts: [{ label: "Range", value: "$9,999-$12,000", sources: c42 }] },
    "negative": { text: "ok", facts: [{ label: "Credit applied", value: "-$3,470.00", sources: c42 }] },
    "words": { text: "It totals three thousand four hundred seventy dollars.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "cue number no $": { text: "It totals 3470.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "subtotal as Total": { text: "ok", facts: [{ label: "Total", value: "$534.50", sources: c42 }] },
    "zip as amount": { text: "ok", facts: [{ label: "Total", value: "$85,281.00", sources: c42 }] },
    "month day no year": { text: "Serviced on March 9.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "ordinal first date": { text: "Serviced on 9th March 2026.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "address wrong zip": { text: "ok", facts: [{ label: "Address", value: "77 E Elm St, #4B, Mesa, AZ 85201", sources: c42 }] },
    "claim in label": { text: "ok", facts: [{ label: "Invoice INV-0099 total $9,999", value: "see", sources: c42 }] },
    "r8 deposit paid then amount due": { text: "ok", facts: [{ label: "Amount due", value: "$298.00", sources: c99 }] },
    "r8 fabricated measurement": { text: "The pipe is 8 inch cast iron.", facts: [{ label: "Pipe", value: "x", sources: c99 }] },
    "r8 estimate date is valid-until": { text: "ok", facts: [{ label: "Estimate date", value: "9/13/2026", sources: c99 }] },
    "r8 fine row": { text: "ok", facts: [{ label: "Fine", value: "$150.00", sources: c99 }] },
    "r9 id in clause not on page": { text: "Invoice INV-0042 has serial 9ZZ9999999.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "r9 total on invoice subtotal": { text: "The total on invoice INV-0042 is $534.50.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "r7 amount due is not total": { text: "ok", facts: [{ label: "Amount Due", value: "$1,680.59", sources: c97 }] },
    "r7 total is not amount due": { text: "ok", facts: [{ label: "Total", value: "$1,180.59", sources: c97 }] },
    "r7 amount due headline": { text: "Invoice 20871 has an amount due of $1,680.59.", facts: [{ label: "Amount Due", value: "$1,180.59", sources: c97 }] },
    "r7 voltage card": { text: "ok", facts: [{ label: "Supply voltage", value: "480 V", sources: c97 }] },
    "r7 superheat card": { text: "ok", facts: [{ label: "Superheat", value: "99 F", sources: c97 }] },
    "r7 superheat vs subcooling": { text: "ok", facts: [{ label: "Superheat", value: "9 F", sources: c97 }] },
    "r7 headline degrees": { text: "Superheat of 7 degrees.", facts: [{ label: "Superheat", value: "11 F", sources: c97 }] },
    "r7 headline amps": { text: "Compressor amps 22 A.", facts: [{ label: "Superheat", value: "11 F", sources: c97 }] },
    "r7 headline tech name": { text: "Sam Rivera replaced a capacitor.", facts: [{ label: "Technician", value: "Luis Ortega", sources: c97 }] },
    "r7 headline org": { text: "Gamma Plumbing LLC signed the waiver.", facts: [{ label: "Technician", value: "Luis Ortega", sources: c97 }] },
    "r7 clause glue": { text: "Invoice 20871 is for Thomas Wright and totals $1,680.59.", facts: [{ label: "A", value: "x", sources: c97 }, { label: "B", value: "y", sources: c98 }] },
    "r6 fabricated reading": { text: "Suction pressure was 999 psi.", facts: [{ label: "Permit", value: "x", sources: c95 }] },
    "r6 wrong reading card": { text: "ok", facts: [{ label: "Discharge pressure", value: "999 psi", sources: c95 }] },
    "r6 usage": { text: "ok", facts: [{ label: "Usage", value: "900 kWh", sources: c95 }] },
    "r6 charge as amount due": { text: "The amount due is $96.00.", facts: [{ label: "Amount due", value: "$96.00", sources: c95 }] },
    "r6 delivery as tax": { text: "Taxes were $41.20.", facts: [{ label: "Tax", value: "$41.20", sources: c95 }] },
    "r6 opening as closing": { text: "The closing balance is $1,200.00.", facts: [{ label: "Closing balance", value: "$1,200.00", sources: c95 }] },
    "r6 min payment": { text: "The minimum payment is $700.00.", facts: [{ label: "Minimum payment", value: "$700.00", sources: c95 }] },
    "r6 CO amount": { text: "ok", facts: [{ label: "Change order amount", value: "$2,500.00", sources: c96 }] },
    "r6 new contract": { text: "The new contract sum is $48,000.00.", facts: [{ label: "Revised contract total", value: "$48,000.00", sources: c96 }] },
    "r6 contactor cost headline": { text: "The contactor cost $27.00.", facts: [{ label: "Filter price", value: "$42.00", sources: c96 }] },
    "r6 part number row": { text: "ok", facts: [{ label: "Filter part number", value: "CNT-24V", sources: c96 }] },
    "r6 cert holder": { text: "ok", facts: [{ label: "Certificate holder", value: "Sonoran Air LLC", sources: c96 }] },
    "r6 occurrence limit": { text: "Each occurrence limit is $2,000,000.", facts: [{ label: "Each occurrence", value: "$2,000,000.00", sources: c96 }] },
    "r5 option B as C": { text: "ok", facts: [{ label: "Option B price", value: "$9,100.00", sources: c90 }] },
    "r5 option headline": { text: "Option B is $9,100.00.", facts: [{ label: "Option B price", value: "$7,450.00", sources: c90 }] },
    "r5 statement row": { text: "ok", facts: [{ label: "INV-1002 amount", value: "$500.00", sources: c90 }] },
    "r5 statement row date": { text: "ok", facts: [{ label: "INV-1001 date", value: "2/20/26", sources: c90 }] },
    "r5 PO item row": { text: "ok", facts: [{ label: "Item 2 total", value: "$54.00", sources: c90 }] },
    "r5 annual as monthly": { text: "ok", facts: [{ label: "Annual price", value: "$32.42", sources: c91 }] },
    "r5 annual headline": { text: "The annual price is $32.42.", facts: [{ label: "Annual price", value: "$389.00", sources: c91 }] },
    "r5 visits vs term": { text: "ok", facts: [{ label: "Visits per year", value: "3", sources: c91 }] },
    "r5 next vs last service": { text: "ok", facts: [{ label: "Next service", value: "3/1/2026", sources: c91 }] },
    "r5 next service headline": { text: "The next service is 3/1/2026.", facts: [{ label: "Next service", value: "9/1/2026", sources: c91 }] },
    "r5 ship-to name as bill-to": { text: "ok", facts: [{ label: "Ship To", value: "Sunrise Plumbing LLC", sources: c91 }] },
    "r5 bill-to address is ship-to": { text: "ok", facts: [{ label: "Bill To address", value: "500 W Deer Valley Rd, Phoenix, AZ 85027", sources: c91 }] },
    "r5 order vs delivery date": { text: "ok", facts: [{ label: "Delivery date", value: "2/2/2026", sources: c91 }] },
    "r4 rent as deposit": { text: "ok", facts: [{ label: "Monthly rent", value: "$2,775.00", sources: c80 }] },
    "r4 pet fee as rent": { text: "ok", facts: [{ label: "Pet fee", value: "$1,850.00", sources: c80 }] },
    "r4 rent headline": { text: "The monthly rent is $2,775.00.", facts: [{ label: "Rent", value: "$1,850.00", sources: c80 }] },
    "r4 pet fee headline": { text: "The pet fee is $1,850.00.", facts: [{ label: "Rent", value: "$1,850.00", sources: c80 }] },
    "r4 lease end as start": { text: "ok", facts: [{ label: "Lease end", value: "1/1/2026", sources: c80 }] },
    "r4 lease start as end": { text: "ok", facts: [{ label: "Lease start", value: "12/31/2026", sources: c80 }] },
    "r4 expires as issued": { text: "ok", facts: [{ label: "Expires", value: "2/3/2026", sources: c81 }] },
    "r4 permit expires headline": { text: "The permit expires 2/3/2026.", facts: [{ label: "Permit", value: "B26-004411", sources: c81 }] },
    "r4 arrival as departure": { text: "ok", facts: [{ label: "Arrival", value: "10:45 AM", sources: c81 }] },
    "r4 fabricated time": { text: "The technician arrived at 3:30 PM.", facts: [{ label: "Permit", value: "B26-004411", sources: c81 }] },
    "r4 certificate as serial": { text: "ok", facts: [{ label: "Certificate number", value: "99812A7", sources: c81 }] },
    "r4 parts vs labor warranty": { text: "ok", facts: [{ label: "Parts warranty", value: "1 year", sources: c81 }] },
    "r4 filters vs units": { text: "ok", facts: [{ label: "Units serviced", value: "3", sources: c81 }] },
    "r3 invoice number as billed": { text: "ok", facts: [{ label: "Billed", value: "$3,470.00", sources: c70 }] },
    "r3 invoice number in headline": { text: "Invoice 3470 is for $3,470.00.", facts: [] },
    "r3 balance as total": { text: "ok", facts: [{ label: "Total", value: "$250.00", sources: c70 }] },
    "r3 total as paid": { text: "ok", facts: [{ label: "Amount Paid", value: "$350.00", sources: c70 }] },
    "r3 total as balance": { text: "ok", facts: [{ label: "Balance Due", value: "$350.00", sources: c70 }] },
    "r3 owes total": { text: "Invoice 3470: the customer owes $350.00.", facts: [] },
    "r3 subtotal headline": { text: "Invoice 3470: the subtotal is $350.00.", facts: [] },
    "r3 tax headline": { text: "Invoice 3470: tax was $350.00.", facts: [] },
    "r3 due date as invoice date": { text: "ok", facts: [{ label: "Invoice Date", value: "10/5/2026", sources: c70 }] },
    "r3 invoice date as due date": { text: "ok", facts: [{ label: "Due Date", value: "9/5/2026", sources: c70 }] },
    "r3 PO as invoice number": { text: "ok", facts: [{ label: "Invoice Number", value: "PO-5521", sources: c70 }] },
    "r3 serial as invoice number": { text: "ok", facts: [{ label: "Invoice Number", value: "LX100030", sources: c70 }] },
    "r3 name narrows pool": { text: "Patrick O'Neil-Ruiz Jr. has an open invoice. The amount is $13,470.00.", facts: [{ label: "A", value: "x", sources: c42 }, { label: "B", value: "y", sources: c43 }] },
    "r2 headline tonnage": { text: "INV-0042 is a 5 ton unit.", facts: [] },
    "r2 headline warranty years": { text: "INV-0042 has a 7 year parts warranty.", facts: [] },
    "r2 headline hours": { text: "INV-0042 covers 6 hours of labor.", facts: [] },
    "r2 technician as customer": { text: "ok", facts: [{ label: "Customer", value: "Dale Whitcomb", sources: c42 }] },
    "r2 single-word wrong customer": { text: "ok", facts: [{ label: "Customer", value: "Johnson", sources: c42 }] },
    "r2 weekday wrong": { text: "ok", facts: [{ label: "Date", value: "Monday, March 5, 2026", sources: c42 }] },
    "r2 wrong city": { text: "ok", facts: [{ label: "Address", value: "77 E Elm St #4B, Gilbert, AZ 85281", sources: c42 }] },
    "r2 subtotal as Total price": { text: "ok", facts: [{ label: "Total price", value: "$534.50", sources: c42 }] },
    "r2 subtotal as invoice total headline": { text: "The invoice total is $534.50 for INV-0042.", facts: [] },
    "r2 contact phone": { text: "ok", facts: [{ label: "Contact", value: "480-555-9999", sources: c42 }] },
    "r2 headline phone": { text: "INV-0042: call 480-555-9999.", facts: [] },
    "r2 email prefix": { text: "ok", facts: [{ label: "Email", value: "at@elmhvac.com", sources: c42 }] },
    "r2 month-year": { text: "INV-0042 is dated April 2026.", facts: [] },
    "r2 ALL CAPS name": { text: "INV-0042 is for SAM ORTIZ.", facts: [] },
    "r2 qty unlisted label": { text: "ok", facts: [{ label: "Valid for", value: "60 days", sources: c42 }] },
    "interpretation glue": { text: "Invoice INV-0042 totals $1,234.50.", interpretation: "Showing the $3,470 invoice for Ronald Calloway INV-T226", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
  };
  for (const [n, o] of Object.entries(bad)) { const out = run(o); const leaked = out.kind === "answer" && ((out.facts ?? []).length === (o.facts ?? []).length && n !== "interpretation glue" || (n === "interpretation glue" && out.interpretation)); check(`round1 wrong output stopped [${n}]`, !leaked, JSON.stringify(out.claimCheck?.unsupported)); }
  const good = {
    "total + customer": { text: "Invoice INV-0042 for Patrick O'Neil-Ruiz Jr. totals $1,234.50, dated March 5, 2026.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }, { label: "Customer", value: "Patrick O'Neil-Ruiz Jr.", sources: c42 }, { label: "Date", value: "3/5/26", sources: c42 }] },
    "r9 total on invoice ok": { text: "The total on invoice INV-0042 is $1,234.50 and the subtotal on INV-0042 is $534.50.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "r8 deposit cards": { text: "ok", facts: [{ label: "Amount due", value: "$223.00", sources: c99 }, { label: "Total", value: "$298.00", sources: c99 }, { label: "Estimate date", value: "8/14/2026", sources: c99 }, { label: "Fine", value: "$75.00", sources: c99 }, { label: "Pipe diameter", value: "4 inch", sources: c99 }] },
    "r7 invoice cards": { text: "Luis Ortega handled it; Beta Plumbing LLC signed the waiver.", facts: [{ label: "Amount Due", value: "$1,180.59", sources: c97 }, { label: "Total", value: "$1,680.59", sources: c97 }, { label: "Supply voltage", value: "478 V", sources: c97 }, { label: "Superheat", value: "11 F", sources: c97 }, { label: "Subcooling", value: "9 F", sources: c97 }, { label: "Compressor amps", value: "18.4 A", sources: c97 }] },
    "r7 headline degrees ok": { text: "Superheat was 11 degrees F.", facts: [{ label: "Superheat", value: "11 F", sources: c97 }] },
    "r7 clause ok": { text: "Invoice 20871 is for Thomas Wright and totals $375.00.", facts: [{ label: "B", value: "y", sources: c98 }] },
    "r6 report cards": { text: "Suction pressure was 118 psi after service.", facts: [{ label: "Superheat before", value: "24 F", sources: c95 }, { label: "Usage", value: "800 kWh", sources: c95 }, { label: "Closing balance", value: "$950.00", sources: c95 }, { label: "Past due", value: "$250.00", sources: c95 }, { label: "Minimum payment", value: "$75.00", sources: c95 }, { label: "Amount due", value: "$144.30", sources: c95 }, { label: "Delivery charge", value: "$41.20", sources: c95 }] },
    "r6 CO cards": { text: "The new contract sum is $52,350.00.", facts: [{ label: "Change order amount", value: "$1,850.00", sources: c96 }, { label: "Original contract", value: "$48,000.00", sources: c96 }, { label: "Revised contract total", value: "$52,350.00", sources: c96 }, { label: "Contactor price", value: "$42.00", sources: c96 }, { label: "Filter price", value: "$27.00", sources: c96 }, { label: "Certificate holder", value: "Desert Ridge HOA", sources: c96 }, { label: "Each occurrence", value: "$1,000,000.00", sources: c96 }, { label: "Aggregate limit", value: "$2,000,000.00", sources: c96 }] },
    "r6 contactor headline ok": { text: "The contactor cost $42.00.", facts: [{ label: "Contactor price", value: "$42.00", sources: c96 }] },
    "r5 proposal cards": { text: "ok", facts: [{ label: "Option B price", value: "$7,450.00", sources: c90 }, { label: "Option A", value: "$6,200.00", sources: c90 }, { label: "INV-1002 amount", value: "$1,250.00", sources: c90 }, { label: "INV-1002 date", value: "2/20/26", sources: c90 }, { label: "Item 2 total", value: "$50.00", sources: c90 }] },
    "r5 agreement cards": { text: "The next service is 9/1/2026.", facts: [{ label: "Annual price", value: "$389.00", sources: c91 }, { label: "Monthly installment", value: "$32.42", sources: c91 }, { label: "Visits per year", value: "2", sources: c91 }, { label: "Last service", value: "3/1/2026", sources: c91 }, { label: "Ship To", value: "Desert Ridge Job Site", sources: c91 }, { label: "Ship-to address", value: "500 W Deer Valley Rd, Phoenix, AZ 85027", sources: c91 }, { label: "Bill To address", value: "100 N Central Ave, Phoenix, AZ 85004", sources: c91 }, { label: "Order date", value: "2/2/2026", sources: c91 }, { label: "Delivery date", value: "2/20/2026", sources: c91 }] },
    "r5 owes with only a total": { text: "The customer owes $1,100.00 on this agreement.", facts: [{ label: "Total", value: "$1,100.00", sources: c91 }] },
    "r4 lease cards": { text: "ok", facts: [{ label: "Monthly rent", value: "$1,850.00", sources: c80 }, { label: "Lease end", value: "12/31/2026", sources: c80 }, { label: "Lease start", value: "1/1/2026", sources: c80 }, { label: "Pet fee", value: "$300.00", sources: c80 }] },
    "r4 permit cards": { text: "The permit expires 8/3/2026.", facts: [{ label: "Expires", value: "8/3/2026", sources: c81 }, { label: "Date issued", value: "2/3/2026", sources: c81 }, { label: "Arrival", value: "8:15 AM", sources: c81 }, { label: "Departure", value: "10:45 AM", sources: c81 }, { label: "Parts warranty", value: "10 years", sources: c81 }, { label: "Labor warranty", value: "1 year", sources: c81 }, { label: "Certificate number", value: "WC-77120", sources: c81 }, { label: "Units serviced", value: "6", sources: c81 }, { label: "Filters replaced", value: "3", sources: c81 }] },
    "r3 balance card": { text: "ok", facts: [{ label: "Balance Due", value: "$250.00", sources: c70 }, { label: "Amount Paid", value: "$100.00", sources: c70 }, { label: "Total", value: "$350.00", sources: c70 }, { label: "Tax", value: "$50.00", sources: c70 }, { label: "Subtotal", value: "$300.00", sources: c70 }] },
    "r3 dates by label": { text: "ok", facts: [{ label: "Invoice Date", value: "9/5/2026", sources: c70 }, { label: "Due Date", value: "10/5/2026", sources: c70 }, { label: "Invoice Number", value: "3470", sources: c70 }] },
    "r3 owes balance headline": { text: "Invoice 3470: the customer owes $250.00 of $350.00.", facts: [{ label: "Balance Due", value: "$250.00", sources: c70 }] },
    "r2 technician card": { text: "ok", facts: [{ label: "Technician", value: "Dale Whitcomb", sources: c42 }] },
    "r2 total price": { text: "ok", facts: [{ label: "Total price", value: "$1,234.50", sources: c42 }] },
    "r2 headline qty ok": { text: "INV-0042 is a 3 ton unit with a 10-year parts warranty and 4 hrs of labor.", facts: [{ label: "Tonnage", value: "3 ton", sources: c42 }] },
    "r2 weekday right": { text: "ok", facts: [{ label: "Date", value: "Thursday, March 5, 2026", sources: c42 }] },
    "r2 city right": { text: "ok", facts: [{ label: "Address", value: "77 E Elm St #4B, Tempe, AZ 85281", sources: c42 }] },
    "r2 headline phone ok": { text: "INV-0042: call (480) 555-1212.", facts: [{ label: "Phone", value: "480-555-1212", sources: c42 }] },
    "R410A": { text: "The refrigerant is R410A.", facts: [{ label: "Refrigerant", value: "R410A", sources: c42 }] },
    "10-year / 4-hour": { text: "It has a 10-year parts warranty and a 4-hour job.", facts: [{ label: "Warranty", value: "10-year parts", sources: c42 }] },
    "24k BTU": { text: "A 24k BTU unit.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "per hour": { text: "Labor was $95 per hour for 4 hrs.", facts: [{ label: "Labor", value: "$95/hr", sources: c42 }] },
    "dash": { text: "ok", facts: [{ label: "Hours", value: "8am-5pm", sources: c42 }] },
    "accent": { text: "The invoice is for Jose M. Alvarez.", facts: [{ label: "Total", value: "$13,470.00", sources: c43 }] },
    "name + trailing word": { text: "ok", facts: [{ label: "Technician", value: "Dale Whitcomb", sources: c42 }] },
    "dr name + St word": { text: "Invoice INV-0042 is for Dr. Patrick O'Neil-Ruiz and 3 invoices from St. Luke.", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "other date forms": { text: "Dated March 5th, 2026 (Mar. 5, 2026).", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] },
    "address abbreviations": { text: "ok", facts: [{ label: "Address", value: "77 East Elm Street Unit 4B, Tempe, AZ 85281", sources: c42 }] },
    "phone/email/tonnage right": { text: "ok", facts: [{ label: "Phone", value: "480-555-1212", sources: c42 }, { label: "Email", value: "PAT@elmhvac.com", sources: c42 }, { label: "Tonnage", value: "3 ton", sources: c42 }] },
  };
  for (const [n, o] of Object.entries(good)) { const out = run(o); check(`round1 correct output kept [${n}]`, out.kind === "answer" && out.facts.length === o.facts.length && !out.claimCheck.unsupported.length, JSON.stringify(out.claimCheck?.unsupported)); }

  // agent mode: cards are checked against the document they cite; aggregates over many documents stay legitimate
  const runA = (o) => applyGrounding({ kind: "answer", confidence: 0.9, sources: [...(o.facts ?? []).flatMap((f) => f.sources)], ...o }, E, { agent: true });
  for (const [n, o] of Object.entries({ "agent name": { text: "ok", facts: [{ label: "Customer", value: "Patrick O'Neill", sources: c42 }] }, "agent tonnage": { text: "ok", facts: [{ label: "Tonnage", value: "5 ton", sources: c42 }] }, "agent email": { text: "ok", facts: [{ label: "Email", value: "bob@elmhvac.com", sources: c42 }] }, "agent site unit": { text: "ok", facts: [{ label: "Site", value: "77 E Elm St, #4C, Tempe, AZ 85281", sources: c42 }] }, "agent total=subtotal": { text: "ok", facts: [{ label: "Total", value: "$534.50", sources: c42 }] }, "agent interpretation": { text: "x", interpretation: "Showing INV-T226 for Ronald Calloway", facts: [{ label: "Total", value: "$1,234.50", sources: c42 }] } })) {
    const out = runA(o); check(`agent gate stops [${n}]`, !(out.kind === "answer" && (out.facts ?? []).length === o.facts.length && !out.interpretation === !o.interpretation && n !== "agent interpretation") && !(n === "agent interpretation" && out.interpretation), JSON.stringify(out.claimCheck?.unsupported));
  }
  { const out = runA({ text: "Invoiced $589,866.50 across 40 invoices.", facts: [{ label: "Invoiced", value: "$589,866.50", sources: [{ documentId: "d42", location: { field: "total" } }, { documentId: "d43", location: { field: "total" } }] }, { label: "Customers", value: "12", sources: [] }] }); check("agent gate keeps aggregates and record-derived cards", out.kind === "answer" && out.facts.length === 2, JSON.stringify(out.claimCheck?.unsupported)); }
}

/* ================================================================== 4. speed */
lats.sort((a, b) => a - b); const p = (q) => lats[Math.min(lats.length - 1, Math.floor(lats.length * q))];
realLog(`latency over ${lats.length} asks: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms`);
realLog(`\nR40: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) realLog("  FAIL " + f); process.exit(1); }
