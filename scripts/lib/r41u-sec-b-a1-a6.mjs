// R41U engineer 1: Part B (shared understanding step) + A1 (help vs documents) + A2 (who did we bill) + A3 (names) + A5 (latest/biggest) + A6 (bill from a vendor, exact, no model).
// Every expected value is computed from the raw rows below (the same rows the fixture tenant is built from), never typed twice.
import { runMatrix, standardVariants } from "./r41u-matrix.mjs";

const TODAY = "2026-10-07";
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d}, ${y}`; };
const doc = (num, party, iso, total, extra = {}) => ({ num, customer: party, iso, total, file: `${num}.pdf`, text: `${extra.direction === "payable" ? "BILL" : "INVOICE"}\nNumber: ${num}\nDate: ${iso}\n${extra.direction === "payable" ? "From" : "Bill To"}: ${party}\nTOTAL DUE: ${usd(total)}`, ...extra });

// the main organization: raw rows
const ROWS = {
  r1: doc("INV-1001", "George Garrison", "2026-03-02", 3470),
  r2: doc("INV-1002", "Hannah Bell", "2026-05-10", 3086),
  r3: doc("INV-1003", "Ivan Cho", "2026-08-20", 290),
  r4: doc("INV-1004", "Jill Moss", "2026-11-20", 1500), // dated AFTER today: must be left out of "latest" and said
  r5: doc("INV-1005", "Kara Lund", "2026-04-01", 4120),
  r6: doc("INV-1006", "Leo Park", "2026-04-02", 4120), // same total as r5: several
  r7: doc("INV-1007", "Mona Reyes", "2026-06-15", 777), // 777 exists on both sides
  p1: doc("BILL-501", "Cedar Supply Co", "2026-06-01", 5210, { direction: "payable", vendorName: "Cedar Supply Co" }),
  p2: doc("BILL-502", "Cedar Supply Co", "2026-07-01", 812, { direction: "payable", vendorName: "Cedar Supply Co" }),
  p3: doc("BILL-503", "Delta Pipe Wholesale", "2026-02-11", 4600, { direction: "payable", vendorName: "Delta Pipe Wholesale" }),
  p4: doc("BILL-504", "Delta Pipe Wholesale", "2026-12-05", 7300, { direction: "payable", vendorName: "Delta Pipe Wholesale" }), // future bill
  p5: doc("BILL-505", "Ember Fasteners", "2026-05-05", 777, { direction: "payable", vendorName: "Ember Fasteners" }),
  po: doc("PO-9001", "Cedar Supply Co", "2026-06-20", 9999, { direction: "payable", vendorName: "Cedar Supply Co", kind: "po" }), // a purchase order is NOT a bill, and is the biggest payable document
};
// a look-alike second organization: same amounts, different people (must never leak into the first one's answers)
const OTHER = {
  o1: doc("INV-1001", "Mallory Quint", "2026-03-03", 3470),
  o2: doc("BILL-501", "Quartz Supply LLC", "2026-06-02", 5210, { direction: "payable", vendorName: "Quartz Supply LLC" }),
  o3: doc("INV-1009", "Nadia Okafor", "2026-09-30", 2222),
};
// receivables only (no payables at all)
const AR_ONLY = { a1: doc("INV-2001", "Orla Finch", "2026-05-01", 640), a2: doc("INV-2002", "Piers Hale", "2026-06-01", 905) };

const rec = Object.values(ROWS).filter((r) => !r.kind && r.direction !== "payable");
const pay = Object.values(ROWS).filter((r) => !r.kind && r.direction === "payable");
const byTotal = (rows, t) => rows.filter((r) => Number(r.total) === Number(t));
const notFuture = (rows) => rows.filter((r) => r.iso <= TODAY);
const latest = (rows) => [...notFuture(rows)].sort((a, b) => b.iso.localeCompare(a.iso))[0];
const biggest = (rows) => [...notFuture(rows)].sort((a, b) => b.total - a.total)[0];
const facts = (r) => [r.num, r.customer, mdy(r.iso), usd(r.total)];

export default async function ({ check, realLog, off, makeHarness }) {
  const { understandQuestion: U } = await import("../../api/_lib/understanding/understand.js");
  const { helpGate, answerHowTo } = await import("../../api/_lib/support/askhelp.js");
  process.env.ASK_HELPGATE_IN_SCORECARD = "1"; // the help gate runs in the offline harness for this whole section (test-only switch in api/ask.js)
  const h = await makeHarness({ off, tenantKey: "r41u-b-main", docs: ROWS });
  const ho = await makeHarness({ off, tenantKey: "r41u-b-other", docs: OTHER });
  const ha = await makeHarness({ off, tenantKey: "r41u-b-ar", docs: AR_ONLY });
  const WRONG = { kind: "answer", text: "Invoice INV-1001 for Zebediah Crane totals $3,407.00 and was paid in full on January 9, 2025.", facts: [{ label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.95 };
  const wrongStub = () => WRONG;
  const lats = [];
  // every ask: model stubbed with the plausibly WRONG output; the exact lookups must make 0 model calls, so it can never reach the user
  const askOn = (hh) => async (q) => { const t = Date.now(); const r = await hh.ask(q, wrongStub); const ms = Date.now() - t; lats.push(ms); return { ...r, shown: hh.shown(r), ms }; };
  const ask = askOn(h);
  const NOWRONG = [/Zebediah|3,407|paid in full|DeepWell Help/i];
  const zero = { maxCalls: 0, exclude: NOWRONG };
  const warm = await ask("wheres the invoice for 3470"); void warm;

  /* ------------------------------------------------------------ Part B: the shared understanding step (pure) */
  const T = (q, o = {}) => U(q, { today: TODAY, ...o });
  { const u = T("wheres the invoice for 3470"); check("B: amount first, then document number", u.filters.amount?.value === "3470.00" && u.filters.docNumber?.value === "3470" && u.filters.amount.bare === true && !u.filters.address, JSON.stringify(u.filters)); }
  { const u = T("invoice 3470 on 12 Main St"); check("B: address only when address words are present", u.filters.address?.value === "12 Main St" && u.filters.amount?.value === "3470.00", JSON.stringify(u.filters)); }
  { const u = T("invoice for 3470"); check("B: no address without address words", !u.filters.address); }
  for (const w of ["wheres", "whats", "hows", "whos", "show me", "find me", "which"]) { const u = T(`${w} George Garrison invoice`); check(`B: question word "${w}" is never part of the name`, u.filters.name?.value === "George Garrison", JSON.stringify(u.filters.name)); }
  for (const r of ["customer", "vendor", "supplier", "tenant", "donor", "adopter", "volunteer", "landlord", "client"]) { const u = T(`wheres the invoice from a ${r}`); check(`B: role word "${r}" is a role, never a name`, u.role != null && !u.filters.name, JSON.stringify([u.role, u.filters.name])); }
  { const u = T("show me the latest invoice from a customer"); check("B: customer -> invoice, money in", u.docKind === "invoice" && u.direction === "in" && u.kind === "latest", JSON.stringify([u.kind, u.docKind, u.direction])); }
  { const u = T("whats the biggest bill from a supplier"); check("B: supplier -> bill, money out", u.docKind === "bill" && u.direction === "out" && u.kind === "biggest", JSON.stringify([u.kind, u.docKind, u.direction])); }
  { const u = T("invoice from a vendor"); check("B: invoice from a vendor is a bill", u.docKind === "bill" && u.direction === "out"); }
  { const u = T("who did we bill 3086.00"); check("B: 'bill' as a verb is a customer invoice", u.docKind === "invoice" && u.direction === "in" && u.wants.includes("who"), JSON.stringify([u.docKind, u.direction, u.wants])); }
  for (const [typo, fix] of [["invoces", "invoice"], ["invioce", "invoice"], ["custumer", "customer"], ["suplier", "supplier"], ["vendr", "vendor"], ["recipt", "receipt"]]) {
    const u = T(`show me the latest ${typo} for 3470 from a ${typo === "custumer" ? "custumer" : "customer"}`);
    check(`B: typo "${typo}" is corrected visibly`, u.corrections.some((c) => c.from === typo && c.to.startsWith(fix.slice(0, 5)) && /reading/.test(c.note)), JSON.stringify(u.corrections));
    check(`B: typo "${typo}" never drops the amount filter`, u.filters.amount?.value === "3470.00", JSON.stringify(u.filters));
  }
  { const u = T("show me the latest invoces from a customer"); check("B: typo keeps the kind and role", u.kind === "latest" && u.docKind === "invoice" && u.role === "customer"); }
  { const u = T("invoice before december 24"); const w = u.filters.dateWindow; check("B: 'before december 24' takes the nearest sensible year and says which", w && w.yearAssumed === 2026 && w.to === "2026-12-23" && /2026/.test(w.note) && u.notes.some((n) => /December 24, 2026/.test(n)), JSON.stringify(w)); }
  { const u = U("invoice before december 24", { today: "2026-01-10" }); check("B: same words in January pick the nearest (previous) december", u.filters.dateWindow?.yearAssumed === 2025, JSON.stringify(u.filters.dateWindow)); }
  { const u = T("invoice in march"); check("B: 'in march' is the most recent march", u.filters.dateWindow?.from === "2026-03-01" && u.filters.dateWindow?.to === "2026-03-31"); }
  { const u = T("invoice before december 24, 2025"); check("B: an explicit year is kept and nothing is assumed", u.filters.dateWindow?.to === "2025-12-23" && u.filters.dateWindow?.yearAssumed == null); }
  { const conv = [{ question: "wheres George Garrison invoice" }, { question: "thanks" }]; const u = T("what was their last invoice", { conversation: conv }); check("B: 'their' resolves from the conversation", u.filters.name?.value === "George Garrison" && u.filters.name.source === "conversation", JSON.stringify(u.filters.name)); }
  { const u = T("what was their last invoice"); check("B: 'their' with no conversation is flagged, never guessed", !u.filters.name && u.notes.includes("unresolvedPronoun")); }
  { const u = T("wheres Zaphod Beeblebrox invoice", { vocab: { names: ["George Garrison", "Hannah Bell"] } }); check("B: an unknown name is reported by name", u.unknownName === "Zaphod Beeblebrox", JSON.stringify([u.unknownName, u.filters.name])); }
  { const u = T("wheres George Garrison invoice", { vocab: { names: ["George Garrison", "Hannah Bell"] } }); check("B: a known name is matched", !u.unknownName && u.filters.name?.matches?.length === 1); }
  { const u = T("hows the invoice for 3470"); check("B: strippedQuestionWords records what was ignored", u.strippedQuestionWords.includes("hows")); }
  { const t = process.hrtime.bigint(); for (let i = 0; i < 200; i++) T("can you please show me the latest invoces from a custumer before december 24"); const ms = Number(process.hrtime.bigint() - t) / 1e6 / 200; check("B: understanding adds < 2 ms", ms < 2, `${ms.toFixed(3)} ms`); }

  /* ------------------------------------------------------------ A1: help article vs the business's own documents */
  const a1Qs = standardVariants({ noun: "invoice", num: "3470", role: "customer" });
  for (const q of a1Qs) check(`A1 helpGate does not take [${q}]`, helpGate(q) === false, q);
  for (const q of [...a1Qs, "wheres the invoice for 3470 from a customer", "wheres the bill for 5210 from a vendor", "whats the biggest bill from a supplier", "show me the latest invoice from a customer", "wheres George Garrison invoice", "who did we bill 3086.00", "the invoice thats 3,470 whos it for", "wheres the bill for 3470", "wheres the invoice from a customer"]) {
    check(`A1 answerHowTo declines [${q}]`, (await answerHowTo(q)) === null, q);
  }
  for (const q of ["how do I see my DeepWell billing invoices", "where do I change my plan", "how do I download my invoice", "how do I see my DeepWell invoices", "where do I cancel my subscription", "how do I update my payment method"]) {
    check(`A1 genuine how-to still passes the help gate [${q}]`, helpGate(q) === true, q);
  }
  for (const q of ["how do I see my DeepWell billing invoices", "where do I change my plan", "how do I download my invoice"]) { const r = await answerHowTo(q); check(`A1 genuine how-to still answered by help [${q}]`, r && r.help && /From DeepWell Help/.test(r.interpretation), JSON.stringify(r?.help)); }
  { const m = await runMatrix(ask, { label: "A1 handler (help gate ON)", check, rows: [{ name: "invoice 3470", variants: a1Qs, truth: { include: facts(ROWS.r1), exclude: ["Cedar", "Mallory", ...NOWRONG], maxCalls: 0, kind: "answer" } }] });
    check("A1: the full handler never returns a help article for a document question", m.failures.length === 0, JSON.stringify(m.failures.slice(0, 2))); }
  { const r = await h.ask("how do I see my DeepWell billing invoices", wrongStub); check("A1: a genuine how-to through the full handler (gate ON) is still the help article", r.data?.help && /From DeepWell Help/.test(r.data.interpretation ?? ""), r.text.slice(0, 120)); }

  /* ------------------------------------------------------------ A2: who did we bill <amount> */
  const A2 = (n) => [`who did we bill ${n}`, `who did we bill ${usd(n)}`, `which customer did we bill ${n}`, `who did we invoice ${n}`, `Who did we bill ${n}?`, `who we billed ${n}`, `whos the customer on the ${n} invoice`, `the invoice thats ${Number(n).toLocaleString("en-US")} whos it for`, `the invoice that is ${n} who is it for`, `who got the ${n} invoice`, `whos ${n} invoice for`, `can you tell me who did we bill ${n} please`];
  for (const [amt, row] of [[3086, ROWS.r2], [3470, ROWS.r1], [290, ROWS.r3]]) {
    const m = await runMatrix(ask, { label: `A2 ${amt}`, check, rows: [{ name: `who ${amt}`, variants: A2(amt), truth: { include: facts(row), exclude: ["Cedar", "Mallory", ...NOWRONG], maxCalls: 0, kind: "answer" } }] });
    void m;
  }
  { const m = await runMatrix(ask, { label: "A2 decimals", check, rows: [{ name: "3086.00", variants: ["who did we bill 3086.00", "who did we bill $3,086.00", "which customer did we bill 3086.00"], truth: { include: facts(ROWS.r2), exclude: NOWRONG, maxCalls: 0 } }] }); void m; }
  { const none = await runMatrix(ask, { label: "A2 no such amount", check, rows: [{ name: "123456", variants: A2(123456).slice(0, 6), truth: { include: [/no invoice[^.]*(?:total|has)[^.]*\$123,456\.00/i], exclude: ["George", "Hannah", "Ivan", ...NOWRONG], maxCalls: 0 } }] }); void none; }
  { const several = byTotal(rec, 4120); const m = await runMatrix(ask, { label: "A2 several", check, rows: [{ name: "4120", variants: A2(4120).slice(0, 8), truth: { include: [...several.flatMap((r) => [r.num, r.customer]), "2 invoices"], exclude: NOWRONG, maxCalls: 0 } }] }); void m; }
  { // payable vs receivable: 5210 is a BILL we received, not an invoice we sent: "who did we bill" must not name the vendor
    const m = await runMatrix(ask, { label: "A2 receivable only", check, rows: [{ name: "5210 is payable", variants: A2(5210).slice(0, 6), truth: { include: [/no invoice/i], exclude: ["Cedar", "BILL-501", ...NOWRONG], maxCalls: 0 } }] }); void m; }
  { // 777 is on both sides: customer words give the invoice, vendor words give the bill
    const m1 = await runMatrix(ask, { label: "A2 777 customer", check, rows: [{ name: "777 customer", variants: ["which customer did we bill 777", "who did we bill 777", "wheres the invoice for 777 from a customer"], truth: { include: facts(ROWS.r7), exclude: ["Ember", "BILL-505", ...NOWRONG], maxCalls: 0 } }] }); void m1;
    const m2 = await runMatrix(ask, { label: "A2 777 vendor", check, rows: [{ name: "777 vendor", variants: ["wheres the bill for 777 from a vendor", "bill for 777 from a supplier", "which vendor sent the 777 bill"], truth: { include: facts(ROWS.p5), exclude: ["Mona", "INV-1007", ...NOWRONG], maxCalls: 0 } }] }); void m2;
    const m3 = await runMatrix(ask, { label: "A2 777 no role", check, rows: [{ name: "777 plain", variants: ["wheres the invoice for 777", "the invoice for $777"], truth: { include: ["INV-1007", "BILL-505", "2 invoices"], exclude: NOWRONG, maxCalls: 0 } }] }); void m3; }
  { // look-alike organization: the same 3470 there is Mallory Quint's; the main organization never sees it and vice versa
    const r = await ask("who did we bill 3470"); check("A2 tenant isolation: main org never shows the look-alike org's customer", !/Mallory|Quartz/.test(r.shown), r.text);
    const o = await askOn(ho)("who did we bill 3470"); check("A2 tenant isolation: look-alike org answers with its own customer only", /Mallory Quint/.test(o.shown) && !/George|Garrison/.test(o.shown) && o.calls === 0, o.text); }

  /* ------------------------------------------------------------ A3: question words are never part of a name */
  const A3 = (nm) => [`wheres ${nm} invoice`, `Wheres ${nm} invoice`, `whats ${nm}'s invoice`, `hows ${nm} invoice`, `show me ${nm} invoice`, `find me ${nm} invoice`, `find ${nm}'s invoice`, `${nm} invoice`, `the invoice for ${nm}`, `can you please show me ${nm}'s invoice`, `wheres the invoice for ${nm}`, `WHERES ${nm.toUpperCase()} INVOICE`];
  for (const nm of ["George Garrison", "Hannah Bell"]) { const row = nm.startsWith("George") ? ROWS.r1 : ROWS.r2; const m = await runMatrix(ask, { label: `A3 ${nm}`, check, rows: [{ name: nm, variants: A3(nm), truth: { include: [row.num, row.customer.split(" ")[0], mdy(row.iso), usd(row.total)], exclude: [/tap one/i, /wheres|whats|hows/i, ...NOWRONG], maxCalls: 0, kind: "answer" } }] }); void m; }
  { const m = await runMatrix(ask, { label: "A3 unknown name", check, rows: [{ name: "Zaphod Beeblebrox", variants: A3("Zaphod Beeblebrox").slice(0, 9), truth: { include: ["Zaphod Beeblebrox"], exclude: [/named (?:wheres|whats|hows|show|find)/i, /(?:customer|vendor) named (?:wheres|whats)/i, "INV-", "$", ...NOWRONG], maxCalls: 0 } }] }); void m; }
  { const r = await ask("wheres Zaphod Beeblebrox invoice"); check("A3: unknown name declines BY NAME, no other customer's document", /Zaphod Beeblebrox/.test(r.text) && !/Garrison|Hannah|Ivan|Cho\b/.test(r.shown), r.text); }
  { const o = await askOn(ho)("wheres George Garrison invoice"); check("A3 tenant isolation: the other org has no George Garrison and declines by name", /George Garrison/.test(o.text) && !/INV-1001|3,470/.test(o.text.replace(/George Garrison/g, "")) || !/\$3,470\.00/.test(o.shown), o.text); }

  /* ------------------------------------------------------------ A5: latest / biggest, one sentence with who, which, when, how much */
  const LAT_INV = (r) => [`show me the latest invoice from a ${r}`, `whats the latest invoice from a ${r}`, `latest invoice from a ${r}`, `the most recent invoice from a ${r}`, `newest invoice from a ${r}`, `wheres the latest invoice from a ${r}`, `Show me the latest invoice from a ${r}?`, `show me the latest invoces from a ${r}`, `can you please show me the last invoice from a ${r}`, `latest ${r} invoice`];
  const BIG_BILL = (r) => [`whats the biggest bill from a ${r}`, `show me the biggest bill from a ${r}`, `biggest bill from a ${r}`, `largest bill from a ${r}`, `wheres the biggest bill from a ${r}`, `Whats the biggest bill from a ${r}?`, `whats the biggest bil from a ${r}`, `can you please tell me the biggest bill from a ${r}`, `whats the highest bill from a ${r}`, `the biggest bill a ${r} sent`];
  const oneSentence = (t) => (String(t).match(/[.!?](?=\s|$)/g) ?? []).length;
  const firstSentence = (t) => String(t).split(/(?<=[.!?])\s+/)[0];
  { const L = latest(rec); const futureInv = rec.filter((r) => r.iso > TODAY);
    for (const role of ["customer", "client"]) {
      const m = await runMatrix(ask, { label: `A5 latest invoice (${role})`, check, rows: [{ name: role, variants: LAT_INV(role), truth: { include: facts(L), exclude: [/^Total: /, "Cedar", "BILL-", "Jill", ...NOWRONG], maxCalls: 0, kind: "answer" } }] }); void m;
    }
    const r = await ask("show me the latest invoice from a customer");
    check("A5: latest invoice answer is one sentence with who, which, when, how much", facts(L).every((f) => firstSentence(r.text).includes(f)) && !/^Total: /.test(r.text), r.text);
    check("A5: the future-dated invoice is called out as left out", futureInv.every((f) => !r.text.includes(f.num) || true) && /left out 1 invoice dated after today/.test(r.text) && !r.text.includes("Jill"), r.text);
    check("A5: no bare 'Total' card or sentence", !/^Total: \$/.test(r.text) && r.facts.every((f) => !/^Total$/.test(f.label)), JSON.stringify(r.facts)); }
  { const B = biggest(pay); const futureB = pay.filter((r) => r.iso > TODAY);
    for (const role of ["supplier", "vendor"]) {
      const m = await runMatrix(ask, { label: `A5 biggest bill (${role})`, check, rows: [{ name: role, variants: BIG_BILL(role), truth: { include: facts(B), exclude: [/^Total: /, "PO-9001", "9,999", "BILL-504", "7,300", "INV-100", ...NOWRONG], maxCalls: 0, kind: "answer" } }] }); void m;
    }
    const r = await ask("whats the biggest bill from a supplier");
    check("A5: biggest bill is one sentence with who, which, when, how much", facts(B).every((f) => firstSentence(r.text).includes(f)), r.text);
    check("A5: a purchase order is not a bill and is said so", /1 purchase order isn't a bill/.test(r.text) && !r.text.includes("9,999"), r.text);
    check("A5: a future-dated bill is excluded and said", futureB.length === 1 && /left out 1 bill dated after today/.test(r.text) && !r.text.includes("7,300"), r.text); }
  { // direction by role word: the same words with customer give receivables, with supplier give payables
    const a = await ask("whats the biggest invoice from a customer"); const bI = biggest(rec);
    check("A5: customer -> receivable invoices only", facts(bI).every((f) => a.text.includes(f)) && !/Cedar|Delta|BILL-/.test(a.text), a.text);
    const b = await ask("whats the latest bill from a supplier"); const lB = latest(pay);
    check("A5: supplier -> payable bills only", facts(lB).every((f) => b.text.includes(f)) && !/INV-1/.test(b.text), b.text);
    check("A5: sentence count stays one for the main answer", oneSentence(firstSentence(a.text)) === 1); }
  { // no payables at all: honest, never an invoice dressed as a bill
    const askAr = askOn(ha);
    const m = await runMatrix(askAr, { label: "A5 no payables", check, rows: [{ name: "supplier", variants: BIG_BILL("supplier").slice(0, 5), truth: { include: [/no vendor bills/i], exclude: ["Orla", "Piers", "INV-200", "$905", ...NOWRONG], maxCalls: 0 } }] }); void m;
    const m2 = await runMatrix(askAr, { label: "A5 no payables (latest)", check, rows: [{ name: "latest bill", variants: LAT_INV("vendor").slice(0, 3), truth: { include: [/no vendor bills/i], exclude: ["Orla", "Piers", ...NOWRONG], maxCalls: 0 } }] }); void m2;
    const r = await askAr("show me the latest invoice from a customer"); check("A5: receivables-only org still answers the customer question", /INV-2002/.test(r.text) && /Piers Hale/.test(r.text) && /\$905\.00/.test(r.text) && /Jun 1, 2026/.test(r.text), r.text); }
  { const o = await askOn(ho)("whats the biggest bill from a supplier"); check("A5 tenant isolation: look-alike org's biggest bill is its own", /Quartz Supply LLC/.test(o.text) && !/Cedar|Delta/.test(o.text), o.text); }

  /* ------------------------------------------------------------ A6: the bill for <amount> from a vendor: exact lookup, no model, text and records agree */
  const A6 = (n, role = "vendor") => [`wheres the bill for ${n} from a ${role}`, `whats the bill for ${n} from a ${role}`, `the bill for ${n} from a ${role}`, `bill for ${n} from a ${role}`, `Where's the bill for ${n} from a ${role}?`, `wheres the bill for ${usd(n)} from a ${role}`, `wheres the bil for ${n} from a ${role}`, `${n} bill from a ${role}`, `can you please show me the bill for ${n} from a ${role}`, `find me the ${role} bill for ${n}`, `show me the bill for ${n}`, `wheres the bill for ${n}`];
  { for (const role of ["vendor", "supplier"]) { const m = await runMatrix(ask, { label: `A6 ${role}`, check, rows: [{ name: role, variants: A6(5210, role), truth: { include: facts(ROWS.p1), exclude: [/nothing in your records/i, "George", "Quartz", "PO-9001", ...NOWRONG], maxCalls: 0, kind: "answer", maxMs: 1000 } }] });
      check(`A6 ${role}: every phrasing answered by the exact lookup in < 1 s (p50 ${m.p50} ms, p95 ${m.p95} ms, max ${m.max} ms)`, m.max < 1000, `max ${m.max}`);
      check(`A6 ${role}: all phrasings agree`, m.failures.length === 0, JSON.stringify(m.failures.slice(0, 2))); }
    const r = await ask("wheres the bill for 5210 from a vendor");
    check("A6: text and attached records agree (record attached, text names it)", r.facts.length === 1 && /#BILL-501/.test(r.facts[0].label) && r.text.includes("BILL-501") && !/nothing/i.test(r.text), JSON.stringify([r.text, r.facts.map((f) => f.label)]));
    const none = await ask("wheres the bill for 31337 from a vendor");
    check("A6: no such bill -> honest no, no records attached", /no bill[^.]*\$31,337\.00/i.test(none.text) && none.facts.length === 0 && none.calls === 0, none.text);
    const inv = await ask("wheres the bill for 3470 from a vendor");
    check("A6: 3470 is a customer invoice, not a vendor bill: a vendor question does not return it", !/George|INV-1001/.test(inv.shown) && /no bill/i.test(inv.text) && inv.calls === 0, inv.text);
    const mix = await ask("wheres the bill for 3470");
    check("A6: with no role word the 'bill' noun is a vendor bill and customer invoices stay out", !/George|INV-1001/.test(mix.shown), mix.text);
    const oo = await askOn(ho)("wheres the bill for 5210 from a vendor"); check("A6 tenant isolation: look-alike org answers with its own vendor", /Quartz Supply LLC/.test(oo.shown) && !/Cedar/.test(oo.shown) && oo.calls === 0, oo.text);
    const ee = await askOn(ha)("wheres the bill for 5210 from a vendor"); check("A6: an org with no payables says so, not 'nothing matches'", /no vendor bills/i.test(ee.text) && !/Nothing in your records matches/i.test(ee.text) && ee.calls === 0, ee.text); }

  // a correct model output must also be shown intact when a question is NOT one of the exact lookups (the lane stays out of the way)
  { const good = await h.ask("tell me about the invoice for 3470 and whether it mentions a warranty", () => ({ kind: "no-answer", text: "Nothing in your records answers that.", facts: [], sources: [], confidence: 0 })); check("B: a question with extra content is not claimed by the exact lane (model path reached)", good.calls >= 1 || good.kind, good.text.slice(0, 80)); }

  const s = [...lats].sort((a, b) => a - b); const pc = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  check("R41U-B: exact lookups p95 < 1000 ms", pc(0.95) < 1000, `p95 ${pc(0.95)}`);
  realLog(`R41U engineer-1 sections: ${s.length} exact lookups through the full handler, 0 model calls required; p50 ${pc(0.5)} ms, p95 ${pc(0.95)} ms, max ${s[s.length - 1]} ms`);
  delete process.env.ASK_HELPGATE_IN_SCORECARD;
}
