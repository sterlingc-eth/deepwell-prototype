// R2 lanes 2 (hostile review loop 1): first-name / verb-like-name possessives (Bill's, Will's, Kenneths), "<Surname> bill" with several customers, glued / lower-case names,
// full-name-exact beats fuzzy, amount "for" phrasing, vendor-bill amount filters, customer-vs-vendor grouping, "what do we owe", lower-case consistency, and an empty reply never happening.
// Invented org A (customers Bill Paye / Will Owens / Grant Call / Rich Pay / Chris Adams (also a vendor) / Sue Hunter / Mark Rich, vendors Adams Supply / Mark Supply Co) + a golden-export HVAC tenant.
// Truth comes from the raw rows; the stubbed model returns a WRONG answer that must never be shown.
export default async function ({ check, realLog, off, makeHarness }) {
  const usd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const doc = (num, party, iso, total, x = {}) => ({ num, customer: party, iso, total, file: `${num}.pdf`, text: `${x.direction === "payable" ? "BILL" : "INVOICE"}\nNumber: ${num}\nDate: ${iso}\n${x.direction === "payable" ? "From" : "Bill To"}: ${party}\nTOTAL DUE: ${usd(total)}`, ...x });
  const docs = {
    a1: doc("A-101", "Bill Paye", "2026-03-01", 3470), a2: doc("A-102", "Will Owens", "2026-03-02", 1820.5), a3: doc("A-103", "Grant Call", "2026-03-03", 910), a4: doc("A-104", "Rich Pay", "2026-03-04", 640),
    a5: doc("A-105", "Chris Adams", "2026-03-05", 275), a6: doc("A-106", "Sue Hunter", "2026-03-06", 505), a7: doc("A-107", "Mark Rich", "2026-03-07", 330),
    v1: doc("B-1", "Adams Supply", "2026-04-01", 7300, { direction: "payable", vendorName: "Adams Supply" }), v2: doc("B-2", "Chris Adams", "2026-04-02", 2400, { direction: "payable", vendorName: "Chris Adams" }),
    v3: doc("B-3", "Mark Supply Co", "2026-04-03", 4000, { direction: "payable", vendorName: "Mark Supply Co" }),
  };
  const WRONG = { kind: "answer", text: "Invoice INV-1001 for Zebediah Crane totals $3,407.00 and was paid in full.", facts: [{ label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.95 };
  const noLeak = (s) => !/Zebediah|INV-1001/.test(s) && !/(?<![\d,])3,407\.00/.test(s.replace(/No invoice on file has a total of \$3,407\.00/g, ""));
  const prevHelp = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const PROBE = process.env.R2L_PROBE;
  let calls = 0; const model = () => { calls++; return WRONG; };
  const h = await makeHarness({ off, tenantKey: "r2l2-a", docs });
  const A = async (q) => { calls = 0; h.stub.fn = model; const r = await h.ask(q, model); return { r, s: h.shown(r), text: r.text, calls }; };
  const NOTFOUND = /don't see a (?:customer|vendor)|couldn't find a customer|do not have a customer|no such customer|don't have a customer/i;
  const run = async (ask, label, qs, ok, { zero = true } = {}) => { for (const q of qs) { const a = await ask(q); if (PROBE) realLog(`[${label}] ${q}\n   -> ${a.r.kind ?? a.r.error}: ${a.s.slice(0, 420).replace(/\n/g, " | ")} (calls ${a.calls})`); check(`R2L2 ${label} [${q}]`, a.text.length > 0 && (!zero || a.calls === 0) && noLeak(a.s) && ok(a.text, a), a.s.slice(0, 300)); } };

  // 1. first-name possessives, verb-like names
  const poss = (n) => [`${n}'s invoice`, `${n}s invoice`, `whats ${n}'s invoice`, `wheres ${n}s invoice`, `show me ${n}'s invoice`, `${n}'s invoice please`, `how much was ${n}'s invoice`, `whats ${n}s invoice?`, `find ${n}'s invoice`, `pull up ${n}s invoice`];
  await run(A, "d1 Bill", poss("Bill"), (t) => /A-101/.test(t) && !/Billl|Hills|Bills's/.test(t) && !NOTFOUND.test(t));
  await run(A, "d1 Will", poss("Will"), (t) => /A-102/.test(t) && !NOTFOUND.test(t));
  await run(A, "d1 Grant", poss("Grant"), (t) => /A-103/.test(t) && !NOTFOUND.test(t));
  await run(A, "d1 Rich", poss("Rich"), (t) => /A-104/.test(t) && !NOTFOUND.test(t));
  // 3. lower-case / glued / typo glued into the name
  await run(A, "d3 glued and lower", ["bill paye's invoice", "billpaye invoice", "Bill Paye invoicee", "bill paye invoice", "Bill Paye's invoice", "billpaye's invoice", "BILL PAYE INVOICE", "Bill Paye invoise", "bill paye's invoice please", "whats bill paye's invoice"], (t) => /A-101|Bill Paye/.test(t) && !/Hills|Billl|Rich Pay/.test(t) && !NOTFOUND.test(t), { zero: true });
  // 4. a full-name exact match beats fuzzy neighbours
  await run(A, "d4 exact beats fuzzy", ["Bill Paye's invoice", "invoice to Bill Paye", "how much did Bill Paye pay us", "Bill Paye invoice", "what did Bill Paye pay", "bill paye invoice", "BILL PAYE'S INVOICE", "invoice for Bill Paye", "wheres Bill Paye's invoice", "bill paye's invoice please"], (t) => /A-101|3,470\.00/.test(t) && !/Rich Pay|which one did you mean/i.test(t));
  await run(A, "d4 Bill Pay never mixes", ["Bill Pay invoice", "bill pay invoice", "Bill Pay's invoice"], (t) => !(/A-101/.test(t) && /A-104/.test(t)) && !/3,470\.00.*640\.00|640\.00.*3,470\.00/.test(t) && !/^Bill Paye's invoice is/.test(t));
  await run(A, "d4 Rich Pay stays Rich Pay", ["Rich Pay invoice", "Rich Pay's invoice", "rich pay invoice", "whats the invoice for rich pay"], (t) => /A-104/.test(t) && !/A-101/.test(t));
  // 5. amount "for" phrasing
  await run(A, "d5 what was it for", ["what was the 3,470.00 for", "what was 3470 for", "whats the $3,470.00 for", "what was the $3470 for", "what is 3470 for", "what was $3,470 for?", "whats 3470 for", "what was the 3470.00 for", "what was the 3,470 for", "whats the 3470 for"], (t) => /A-101/.test(t) && /Bill Paye/.test(t) && /3,470\.00/.test(t));
  await run(A, "d5 second amount", ["what was the $1,820.50 for", "what was 1820.50 for", "whats the 1,820.50 for", "what was the 1820.5 for"], (t) => /A-102/.test(t) && /Will Owens/.test(t));
  await run(A, "d5 around", ["any invoice around 3470", "any invoice around $3,470", "is there an invoice around 3470", "any invoices about 3470", "an invoice roughly 3470"], (t) => /A-101/.test(t) && /exact/i.test(t));
  await run(A, "d5 vendor with", ["who is the vendor with 7300", "who is the vendor with $7,300", "which vendor has 7300", "who is the supplier with 7300", "whos the vendor with 7300"], (t) => /Adams Supply/.test(t) && /B-1/.test(t) && !/Chris Adams/.test(t));
  await run(A, "d5 who paid none", ["who paid 3407", "who paid $3,407", "whos paid 3407", "who paid 3407?", "who paid $3407.00"], (t) => /3,407\.00/.test(t) && /No invoice/.test(t) && !/Bill Paye|A-101/.test(t));
  // 6. vendor bill amount filters
  await run(A, "d6 over", ["bills over 5000 from vendors", "vendor bills over 5000", "vendor bills over $5,000", "bills above 5000 from vendors", "which vendor bills are over 5000", "vendor bills more than 5000", "vendor bills over 5k", "bills over 5000 from suppliers", "vendor bill over 5000", "show vendor bills over 5000"], (t) => /1 vendor bill/.test(t) && /B-1/.test(t) && !/B-2|B-3/.test(t));
  await run(A, "d6 under", ["vendor bills under 5000", "bills under 5000 from vendors", "vendor bills below $5,000", "vendor bills less than 5000", "which vendor bills are under 5000", "vendor bill under 5000"], (t) => /2 vendor bills/.test(t) && /B-2/.test(t) && /B-3/.test(t) && !/B-1/.test(t));
  await run(A, "d6 between", ["vendor bills between 2000 and 5000", "vendor bills between $2,000 and $5,000", "bills between 2000 and 5000 from vendors", "vendor bills between 2000 to 5000", "vendor bills between 8000 and 9000"], (t, a) => (/8000|8,000/.test(a.r.text) ? /No vendor bill/.test(t) : /2 vendor bills/.test(t) && !/B-1/.test(t)));
  // 7. customer vs vendor sharing a word: each section only its own entity
  const sec = (t, name) => { const at = t.indexOf(`${name}:`); if (at < 0) return ""; const rest = t.slice(at + 1); const nx = rest.search(/(?:Chris Adams|Adams Supply|Mark Rich|Mark Supply Co): /); return nx < 0 ? t.slice(at) : t.slice(at, at + 1 + nx); };
  await run(A, "d7 Adams", ["Adams invoice", "Adams bill", "whats the Adams invoice", "wheres the Adams bill", "adams invoice", "adams bill", "show me the Adams invoice", "show me the Adams bill", "Adams invoices", "Adams bills"], (t) => {
    const ca = sec(t, "Chris Adams"), as = sec(t, "Adams Supply");
    return ca && as && !/B-1\b|7,300/.test(ca) && !/B-2\b|2,400|A-105|275\.00|Chris Adams/.test(as.replace(/^Adams Supply:/, "")) && (/B-1/.test(as));
  });
  await run(A, "d7 Mark", ["what did Mark bill us", "Mark bill", "Mark invoice", "whats the Mark bill", "wheres the Mark bill", "mark bill", "Mark bills", "show me the Mark bill"], (t) => {
    const mr = sec(t, "Mark Rich"), ms = sec(t, "Mark Supply Co");
    return mr && ms && !/B-3|4,000/.test(mr) && /B-3/.test(ms) && !/A-107|330\.00/.test(ms);
  });
  // 8. owing questions
  await run(A, "d8 owe vendors", ["what do we owe vendors", "what do we owe our vendors", "how much do we owe vendors", "what do we owe", "how much do we owe", "what do we owe suppliers", "whats owed to vendors", "what we owe vendors", "what do we still owe vendors", "how much do we owe our suppliers"], (t) => /3 vendor bills/.test(t) && /13,700\.00/.test(t) && /no payment status/.test(t) && !/No open bills/.test(t));
  await run(A, "d8 owed to vendor", ["total owed to Adams Supply", "what do we owe Adams Supply", "how much do we owe Adams Supply", "amount owed to Adams Supply", "whats owed to Adams Supply", "what do we owe adams supply", "total owed to Adams Supply?", "how much do we still owe Adams Supply"], (t) => /7,300\.00/.test(t) && /Adams Supply/.test(t) && /no payment status/.test(t) && !/invoices for Adams Supply|No open invoices/.test(t));
  await run(A, "d8 owe a customer", ["what do we owe Bill Paye", "how much do we owe Bill Paye", "what do we owe bill paye", "total owed to Bill Paye", "what do we owe Rich Pay", "how much do we owe Will Owens"], (t) => /customer, not a vendor/.test(t) && /no vendor bills/.test(t) && !/No open bills/.test(t));
  // 9. lower-case consistency
  await run(A, "d9 lower names", ["whats the invoice for will owens", "what's the invoice for bill paye", "whats the invoice for grant call", "whats the invoice for rich pay", "whats the invoice for sue hunter", "what's the invoice for will owens", "wheres the invoice for grant call", "show the invoice for rich pay", "invoice for will owens", "the invoice for bill paye"], (t) => /A-10[1-6]/.test(t) && !/can't answer that exactly|tap one/.test(t));
  // an empty reply is never returned, however many questions one tenant has been asked
  const empties = [];
  for (let i = 0; i < 120; i++) { const q = ["how much does Paye owe", "show Grant", "Rich", "Will", "Bill", "Call", "Pay", "Adams", "Mark", "Owens"][i % 10]; const a = await A(q); if (!(a.text.length > 0 || (a.r.facts ?? []).length)) empties.push(`${q}: ${a.r.error ?? "empty"}`); }
  check("R2L2 no empty reply across 120 asks on one tenant", empties.length === 0, empties.slice(0, 4).join(" | "));

  // golden tenant: several people share a first name / surname
  {
    const T = await import("./r41u-e2-tenant.mjs");
    const base = T.golden();
    const hv = await T.loadTenant(off, base, { key: "r2l2-hvac" });
    const G = async (q) => { calls = 0; const r = await hv.ask(q); return { r, s: r.shown, text: r.text, calls }; };
    const inv = (n) => base.financials.find((x) => x.customer_name === n && x.doc_kind === "invoice");
    const kf = inv("Kenneth Fenwick").invoice_number, rb = inv("Ronald Bracken").invoice_number, kb = inv("Karen Bracken").invoice_number;
    const cust = new Set(base.entities.filter((e) => e.entity_type === "customer").map((e) => e.data.customer_name));
    const fen = ["Kenneth Fenwick", "Patricia Fenwick", "Ronald Fenwick"].filter((n) => cust.has(n));
    await run(G, "d1 Kenneths (two Kenneths: ask or sections, never missing)", ["Kenneths invoice", "whats Kenneths invoice", "Kenneth's invoice", "wheres Kenneths invoice", "show me Kenneth's invoice", "whats Kenneth's invoice?", "Kenneths invoice please", "find Kenneths invoice"], (t) => !NOTFOUND.test(t) && (new RegExp(kf).test(t) || /which|Kenneth Fenwick|Kenneth Gallardo/i.test(t)));
    await run(G, "d2 Bracken bill (a real customer is never missing)", ["Bracken bill", "bracken bill", "whats the Bracken bill", "wheres the Bracken bill", "show me the Bracken bill", "Bracken bills", "the Bracken bill", "Bracken bill please"], (t) => !NOTFOUND.test(t) && new RegExp(rb).test(t) && new RegExp(kb).test(t) && /Ronald Bracken/.test(t) && /Karen Bracken/.test(t));
    await run(G, "d2 Fenwick bill", ["Fenwick bill", "fenwick bill", "whats the Fenwick bill", "wheres the Fenwick bill", "show me the Fenwick bill", "Fenwick bills"], (t) => !NOTFOUND.test(t) && fen.every((n) => t.includes(n)) && new RegExp(kf).test(t));
    await run(G, "d2 Bracken invoice", ["Bracken invoice", "whats the Bracken invoice", "wheres the Bracken invoice"], (t) => new RegExp(rb).test(t) && new RegExp(kb).test(t) && !NOTFOUND.test(t));
  }
  if (prevHelp === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prevHelp;
  realLog("R2 lanes2: done");
}
