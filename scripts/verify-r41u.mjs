#!/usr/bin/env node
/**
 * R41U: Donovan hardening round, one file, one section per engineer task. Every section uses the shared check(); the last line is "R41U: N passed, M failed" (exit 1 on any fail).
 * Later sections are APPENDED below the "A8 grounding" section (do not reorder or edit another section's assertions).
 *
 * A8 grounding: the hostile review of the R40 grounding gate. Every defect (1-12) and over-block (O1-O6) is a stubbed-model case through the REAL pipeline (api/ask.js model path):
 * the stub returns a plausibly WRONG output (must never reach the user) and a CORRECT one (must be shown intact). Truth is computed from the raw fixture rows
 * (scripts/lib/r41u-fixture.mjs), not from Donovan. Agent mode (defect 1) is exercised at the gate with the same evidence, because the research agent cannot be scripted.
 */
const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"claimCheck'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const { makeHarness } = await import("./lib/r41u-harness.mjs");
const FX = await import("./lib/r41u-fixture.mjs");

let pass = 0; const fails = [];
export const check = (name, ok, detail) => { if (ok) pass++; else { fails.push(`${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`); realLog(`FAIL ${name} :: ${String(detail ?? "").slice(0, 300)}`); } };
const sections = []; const section = (name, fn) => { if (!process.env.R41U_ONLY || name.startsWith(process.env.R41U_ONLY)) sections.push([name, fn]); };

/* ================================================================== A8 grounding */
section("A8 grounding", async () => {
  const { R, DOCS, ASK, SAFE, money } = FX;
  const h = await makeHarness({ off, tenantKey: "r41u-a8", docs: DOCS });
  const fw = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  const ai = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const zw = (s) => s.split("").join("​");
  const safe = (d) => [{ label: SAFE[d][0], value: SAFE[d][1] }];
  const card = (label, value, extra = {}) => [{ label, value, ...extra }];
  const swapDigits = (n) => { const [i, f] = Number(n).toFixed(2).split("."); return `${i.slice(0, -2)}${i.slice(-1)}${i.slice(-2, -1)}.${f}`; };
  const inv = R.inv; const wrongTotal = money(Number(swapDigits(inv.total)));
  const cases = [];
  const wrong = (def, name, doc, text, marker, cards = null, extra = {}) => cases.push({ def, name, doc, kind: "bad", text, marker, cards: cards ?? safe(doc), ...extra });
  const right = (def, name, doc, text, cards = null, extra = {}) => cases.push({ def, name, doc, kind: "good", text, cards: cards ?? safe(doc), ...extra });

  // 2 sign / credit vs charge / direction
  wrong(2, "credit memo shown as an invoice owed", "C", `${R.cm.num} is an invoice for ${money(R.cm.credit)} owed by ${inv.customer}.`, /owed by/);
  wrong(2, "credit memo card Total positive", "C", "Here is the memo.", /Total \| \$318\.60/, card("Total", money(R.cm.credit)));
  wrong(2, "credit memo card Amount due", "C", "Here is the memo.", /Amount due \| \$318\.60/, card("Amount due", money(R.cm.credit)));
  wrong(2, "customer owes the credit", "C", `${inv.customer} owes ${money(R.cm.credit)}.`, /owes/);
  wrong(2, "customer was charged the credit", "C", `The customer was charged ${money(R.cm.credit)}.`, /was charged/);
  wrong(2, "invoice total shown as refunded", "A", `${inv.customer} was refunded ${money(inv.total)}.`, /refunded/);
  wrong(2, "invoice refund card", "A", "Here is the invoice.", /Refund \| \$2,527\.20/, card("Refund", money(inv.total)));
  right(2, "credit memo credits the customer", "C", `${R.cm.num} credits ${inv.customer} ${money(R.cm.credit)} for returned parts.`);
  right(2, "credit card signed", "C", "Here is the memo.", card("Credit", money(-R.cm.credit)));
  right(2, "credit card unsigned under Credit", "C", "Here is the memo.", card("Credit amount", money(R.cm.credit)));
  right(2, "a $ credit sentence", "C", `It is a ${money(R.cm.credit)} credit dated April 20, 2026.`);
  // 3 "Last, First" customer cards
  wrong(3, "Last, First of another customer", "A", "Here is the invoice.", /Pettigrew-Hale, Ambrose/, card("Customer", "Pettigrew-Hale, Ambrose"));
  wrong(3, "Last, First not on any document", "A", "Here is the invoice.", /Smith, John/, card("Bill to", "Smith, John"));
  wrong(3, "Last, First with wrong first name", "A", "Here is the invoice.", /Wainwright, Thomas/, card("Customer", "Wainwright, Thomas"));
  right(3, "Last, First of this customer", "A", "Here is the invoice.", card("Customer", "Wainwright, Thaddeus"));
  // 4 person names without cue words, possessives, lowercase, Mr. X
  wrong(4, "on behalf of", "A", "The work was ordered on behalf of Gideon Parrish.", /Gideon/);
  wrong(4, "per Name", "A", "Per Gideon Parrish, the unit failed.", /Gideon/);
  wrong(4, "parenthesised name", "A", "The job (Gideon Parrish) is done.", /Gideon/);
  wrong(4, "interpretation names someone else", "A", "Here is the invoice.", /Gideon/, null, { interpretation: "I took you to mean Gideon Parrish." });
  wrong(4, "lowercase name", "A", "the customer is ambrose pettigrew-hale", /ambrose/i);
  wrong(4, "another customer's first name, possessive", "A", "This is Ambrose's job.", /Ambrose/);
  wrong(4, "Mr. surname of another customer", "A", "Mr. Pettigrew approved it.", /Pettigrew/);
  wrong(4, "lowercase title and name", "A", "ask for mrs. gideon parrish about it", /parrish/i);
  right(4, "possessive first name of this customer", "A", "Thaddeus's job was a tankless water heater swap.");
  right(4, "Ms. surname of this customer", "A", "Ms. Wainwright was billed.");
  right(4, "lowercase name of this customer", "A", "the customer is thaddeus wainwright.");
  // 5 role swaps in prose
  wrong(5, "technician named as the customer", "A", `The customer is ${inv.tech}.`, /customer is Marisol/);
  wrong(5, "customer named as the technician", "A", `The technician was ${inv.customer}.`, /technician was Thaddeus/);
  right(5, "technician is the technician", "A", `The technician was ${inv.tech}.`);
  right(5, "customer is the customer", "A", `The customer is ${inv.customer}.`);
  // 6 company / brand / surname matching
  wrong(6, "same name, other trade", "A", "Cedar Flats Heating did the work.", /Heating/);
  wrong(6, "extra surname", "A", `The customer is ${inv.customer} Bellamy.`, /Bellamy/);
  wrong(6, "invented middle name", "A", "Thaddeus Marcus Wainwright is the customer.", /Marcus/);
  wrong(6, "hyphenated surname extended", "W", `Contact ${R.war.contact}-Hart.`, /Lisowski-Hart/);
  wrong(6, "hyphenated surname truncated", "L", "The tenant is Oriel Nakamura.", /Nakamura\b(?!-)/);
  wrong(6, "company with a different suffix", "L", "The landlord is Sundial Property Partners.", /Partners/);
  wrong(6, "another document's company", "A", "Hollis Drain Works did the work.", /Hollis/);
  wrong(6, "company on no document", "A", "Valley Pros did the work.", /Valley Pros/);
  wrong(6, "wrong brand with the right model", "A", "The unit is a Rinnai NPE-240A tankless heater.", /Rinnai/);
  wrong(6, "bare brand", "A", "The heater is a Rinnai.", /Rinnai/);
  wrong(6, "brand card", "A", "Here is the invoice.", /Rinnai/, card("Equipment", "Rinnai NPE-240A"));
  right(6, "company exact", "A", `${inv.vendor} did the work.`);
  right(6, "brand and model", "A", `The unit is a ${inv.brand} ${inv.model}.`);
  right(6, "hyphenated surname exact", "L", `The tenant is ${R.lease.tenant}.`);
  // 7 spelled-out and unit-less quantities
  wrong(7, "spelled hours", "A", "Labor took five hours.", /five hours/);
  wrong(7, "spelled parts warranty", "A", "It has a ten-year parts warranty.", /ten-year/);
  wrong(7, "spelled warranty, no hyphen", "A", "It has a five year parts warranty.", /five year/);
  wrong(7, "spelled gallons", "A", "It replaced a fifty gallon tank.", /fifty gallon/);
  wrong(7, "digit visits", "M", "The agreement covers 3 visits per year.", /3 visits/);
  wrong(7, "spelled visits", "M", "The agreement includes six visits per year.", /six visits/);
  wrong(7, "spelled term", "M", "It is a three-year term.", /three-year/);
  wrong(7, "parking spaces", "L", "The lease includes 3 parking spaces.", /3 parking/);
  wrong(7, "spelled parking spaces", "L", "The lease includes three parking spaces.", /three parking/);
  wrong(7, "bedrooms", "L", "It is a 3 bedroom unit.", /3 bedroom/);
  wrong(7, "filters", "A", "The tech replaced 3 filters.", /3 filters/);
  wrong(7, "units serviced, spelled", "A", "The crew serviced two units.", /two units/);
  wrong(7, "card parts warranty spelled", "W", "Here is the warranty.", /twelve years/, card("Parts warranty", "twelve years"));
  wrong(7, "card labor warranty spelled", "W", "Here is the warranty.", /five years/, card("Labor warranty", "five years"));
  wrong(7, "card parking unit-less", "L", "Here is the lease.", /Parking spaces \| 3/, card("Parking spaces", "3"));
  wrong(7, "card bedrooms unit-less", "L", "Here is the lease.", /Bedrooms \| 3/, card("Bedrooms", "3"));
  wrong(7, "card filters unit-less", "A", "Here is the invoice.", /Filters replaced \| 9/, card("Filters replaced", "9"));
  right(7, "spelled half hours", "A", "Labor was four and a half hours.");
  right(7, "spelled parts warranty", "A", "It has a seven-year parts warranty.");
  right(7, "spelled labor warranty", "A", "Labor is covered for two years.");
  right(7, "digit visits", "M", `The agreement includes ${R.agr.visits} visits per year.`);
  right(7, "spelled term", "M", "It is a two-year term.");
  right(7, "card parking unit-less", "L", "Here is the lease.", card("Parking spaces", String(R.lease.parking)));
  right(7, "card labor warranty", "W", "Here is the warranty.", card("Labor warranty", "1 year"));
  // 8 odd date shapes
  wrong(8, "ordinal of month", "A", "It was done on the 21st of April 2026.", /21st/);
  wrong(8, "ordinal of month, comma", "A", "It was done on the 12th of April, 2026.", /12th/);
  wrong(8, "month the Nth", "A", "It was done on April the 12th.", /12th/);
  wrong(8, "spelled ordinal", "A", "It was done on April twelfth.", /twelfth/);
  wrong(8, "day-first slash, day > 12", "A", "It was done on 15/04/2026.", /15\/04/);
  wrong(8, "day-first slash, day > 12 (2)", "A", "It was done on 13/04/2026.", /13\/04/);
  wrong(8, "day month without a year", "A", "It was done on 12 April.", /12 April/);
  wrong(8, "year with slashes", "A", "It was done on 2026/04/12.", /2026\/04\/12/);
  wrong(8, "bare year (expiry)", "W", "The warranty runs through 2040.", /2040/);
  wrong(8, "bare year (install)", "W", "It was installed in 2019.", /2019/);
  right(8, "ordinal of month", "A", "It was done on the 11th of April 2026.");
  right(8, "month the Nth", "A", "It was done on April the 11th.");
  right(8, "day month year", "A", "It was done on 11 April 2026.");
  right(8, "bare year", "W", "The warranty runs through 2036.");
  // 9 number forms
  wrong(9, "fullwidth amount", "A", `The total was ${fw("$3,470.00")}.`, /３|3,470/);
  wrong(9, "Arabic-Indic digits", "A", `Total due: ${ai("3470")} dollars.`, /٣٤٧٠/);
  wrong(9, "zero-width inside the digits", "A", `The total is ${zw("$1,378.15")}.`, /1.{0,2},.{0,2}3.{0,2}7.{0,2}8/);
  wrong(9, "European grouping", "A", "The total is $3.470,00.", /3\.470,00/);
  wrong(9, "card $1.2M", "A", "Here is the invoice.", /1\.2M/, card("Total", "$1.2M"));
  wrong(9, "1.2MM", "A", "The job came to $1.2MM.", /1\.2MM/);
  wrong(9, "12K", "A", "The job total was 12K.", /12K/);
  wrong(9, "3 grand", "A", "It came to 3 grand.", /3 grand/);
  wrong(9, "USD code", "A", "The total was USD 3470.", /USD 3470/);
  wrong(9, "euro sign", "A", "The total was €3,470.", /3,470/);
  wrong(9, "euro on a dollar invoice", "A", `The total was €${inv.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}.`, /€/);
  wrong(9, "negative after the dollar sign", "A", "The total is $-3,470.00.", /3,470/);
  wrong(9, "bare after 'came to'", "A", "The invoice came to 3470.", /3470/);
  wrong(9, "bare after 'comes out to'", "A", "It comes out to 3470.", /3470/);
  wrong(9, "bare after 'the sum of'", "A", "The sum of 3470 was billed.", /3470/);
  wrong(9, "bare before 'is owed'", "A", "3470 is owed.", /3470/);
  wrong(9, "percent in words", "A", "Tax was twelve percent.", /twelve percent/);
  wrong(9, "card Details bare number", "A", "Here is the invoice.", /Details \| 2572\.20/, card("Details", swapDigits(inv.total)));
  wrong(9, "card Notes with a total", "A", "Here is the invoice.", /1,978\.15/, card("Notes", "Total due $1,978.15 per invoice"));
  wrong(9, "transposed total", "A", `The total on ${inv.num} is ${wrongTotal}.`, /2,572\.20/);
  right(9, "fullwidth of the true total", "A", `The total was ${fw(money(inv.total))}.`);
  right(9, "zero-width inside the true total", "A", `The total is ${zw(money(inv.total))}.`);
  right(9, "USD code, true total", "A", `The total was USD ${inv.total.toFixed(2)}.`);
  right(9, "dollars word, true total", "A", `The total was ${inv.total.toLocaleString("en-US", { minimumFractionDigits: 2 })} dollars.`);
  right(9, "came to, true total", "A", `The job came to ${money(inv.total)}.`);
  // 10 zip / city bound to the address
  wrong(10, "vendor's zip glued to the job address", "A", `Service address: ${inv.svcStreet}, ${inv.svcCity}, AZ 85224.`, /85224/);
  wrong(10, "wrong city, right zip", "A", `The job was at ${inv.svcStreet}, Chandler, AZ ${inv.svcZip}.`, /Chandler/);
  wrong(10, "bare wrong zip", "A", "The zip is 85299.", /85299/);
  wrong(10, "city on no line of the page", "A", "The job is in Phoenix.", /Phoenix/);
  wrong(10, "street with the wrong city", "A", "The job was on Sagebrush Ct in Phoenix.", /Phoenix/);
  wrong(10, "card address with the vendor's zip", "A", "Here is the invoice.", /85224/, card("Service address", `${inv.svcStreet}, ${inv.svcCity}, AZ 85224`));
  right(10, "full address", "A", `The job was at ${inv.svcStreet}, ${inv.svcCity}, AZ ${inv.svcZip}.`);
  right(10, "bare zip of the job", "A", `The zip is ${inv.svcZip}.`);
  right(10, "city of the job", "A", `The job is in ${inv.svcCity}.`);
  // 11 identifiers with other cue words / short / phone / url
  wrong(11, "Account", "A", "Account 99812 is current.", /99812/);
  wrong(11, "Customer number", "A", "Customer number 1042 is on file.", /1042/);
  wrong(11, "Order", "A", "Order 5521 was placed.", /5521/);
  wrong(11, "Suite", "A", "The job was in Suite 410.", /410/);
  wrong(11, "Room", "A", "It was in Room 3304.", /3304/);
  wrong(11, "Unit # (short)", "A", "It is Unit #7.", /Unit #7/);
  wrong(11, "unit 5D (short)", "A", "It is unit 5D.", /5D/);
  wrong(11, "800 number", "A", "Call 1-800-555-0100 for service.", /0100/);
  wrong(11, "7-digit phone", "A", "Call 555-0100.", /555-0100/);
  wrong(11, "URL", "A", "See www.cedarflats.com.", /cedarflats\.com/);
  wrong(11, "another email", "W", "Email evander@pinecrestclimate.com.", /evander@/);
  right(11, "Account of this invoice", "A", `Account ${inv.account} is current.`);
  right(11, "unit of this invoice", "A", "It is unit 7C.");
  right(11, "phone of this invoice", "A", `Call ${inv.phone}.`);
  // 12 extra card fields
  wrong(12, "detail with a wrong total", "A", "Here is the invoice.", /3,470/, [{ label: "Document", value: inv.num, detail: "Total $3,470.00" }]);
  wrong(12, "note naming another customer", "A", "Here is the invoice.", /Gideon/, [{ label: "Document", value: inv.num, note: "Customer Gideon Parrish" }]);
  right(12, "extra field that is true (kept out or kept, never wrong)", "A", "Here is the invoice.", [{ label: "Document", value: inv.num, detail: `Total due ${money(inv.total)}` }]);
  // O1-O6 over-block
  right("O1", "subtotal plus tax comes to total", "A", `${money(inv.subtotal)} plus ${money(inv.tax)} tax comes to ${money(inv.total)}.`);
  right("O1", "subtotal + tax = total", "A", `Subtotal ${money(inv.subtotal)} + tax ${money(inv.tax)} = total ${money(inv.total)}.`);
  right("O2", "card Service date", "A", "Here is the invoice.", card("Service date", inv.longDate));
  right("O2", "card Date of service", "A", "Here is the invoice.", card("Date of service", inv.mdy));
  right("O3", "lease from X through Y", "L", `The lease runs from ${R.lease.start} through ${R.lease.end}.`);
  right("O3", "agreement term range", "M", `Coverage is ${R.agr.start} through ${R.agr.end}.`);
  right("O3", "card Term with a range", "M", "Here is the agreement.", card("Term", "2 years (Mar 1, 2026 - Feb 28, 2028)"));
  right("O4", "rent with a deposit in one sentence", "L", `Rent is ${money(R.lease.rent)} a month with a ${money(R.lease.deposit)} security deposit.`);
  right("O5", "Call Name at phone", "W", `Call ${R.war.contact} at 520-555-0188.`);
  right("O5", "Email Name at address", "W", `Email ${R.war.contact} at ${R.war.email}.`);
  right("O6", "card Total (incl. tax)", "A", "Here is the invoice.", card("Total (incl. tax)", money(inv.total)));
  right("O6", "card Equipment with a size", "A", "Here is the invoice.", card("Equipment", `${inv.brand} ${inv.model}, ${inv.gallons} gallon`));

  let reached = 0;
  for (const c of cases) {
    const model = () => ({ text: c.text, confidence: 0.92, ...(c.interpretation ? { interpretation: c.interpretation } : {}), facts: c.cards.map((f) => ({ ...f, sources: [{ documentId: h.ids[c.doc], location: { page: 1 } }] })) });
    const r = await h.ask(ASK[c.doc], model);
    const tag = `A8 d${c.def} ${c.kind === "bad" ? "stops" : "keeps"} [${c.name}]`;
    if (!r.calls) { check(`${tag} (model path reached)`, false, r.text); continue; }
    reached++;
    const s = h.shown(r);
    if (c.kind === "bad") check(tag, !(r.kind === "answer" && c.marker.test(s)), s.replace(/\n/g, " / "));
    else check(tag, r.kind === "answer" && !r.data?.groundingWithdrawn && !r.data?.groundingNote && r.facts.length === c.cards.length && r.text.startsWith(c.text.slice(0, 20)), `${r.kind} ${r.data?.groundingNote ?? ""} ${JSON.stringify(r.data?.claimCheck?.unsupported ?? [])}`);
  }
  check("A8: every case reached the model path", reached === cases.length, `${reached}/${cases.length}`);

  // 1. agent mode with several documents cited: each claim is bound to the document its own id / name / card cites; sums are subset sums
  const ev = h.evidence(); const cs = (...ks) => ks.map((k) => ({ documentId: h.ids[k], location: { page: 1 } }));
  const both = [{ label: "Invoice", value: R.inv.num, sources: cs("A") }, { label: "Invoice", value: R.inv2.num, sources: cs("B") }];
  const runAgent = (o) => h.gate.applyGrounding({ kind: "answer", confidence: 0.9, sources: [...(o.facts ?? []).flatMap((f) => f.sources)], ...o }, ev, { agent: true });
  const sum = R.inv.total + R.inv2.total;
  const agentWrong = {
    "id of A with the amount of B": { text: `${R.inv.num} totals ${money(R.inv2.total)}.`, facts: both, marker: /totals \$640/ },
    "customer of A owes the amount of B": { text: `${R.inv.customer} owes ${money(R.inv2.total)}.`, facts: both, marker: /owes \$640/ },
    "card Total of B citing A and B": { text: "ok", facts: [{ label: "Total", value: money(R.inv2.total), sources: cs("A", "B") }], marker: /640/ },
    "wrong warranty years on A": { text: `${R.inv.num} has a 9-year parts warranty.`, facts: both, marker: /9-year/ },
    "card Labor hours that is neither doc nor their sum": { text: "ok", facts: [{ label: "Labor hours", value: "9", sources: cs("A", "B") }], marker: /\b9\b/ },
    "card Date of B citing A and B": { text: "ok", facts: [{ label: "Date", value: "February 19, 2026", sources: cs("A", "B") }], marker: /February 19/ },
    "date of B glued to the id of A": { text: `${R.inv.num} is dated February 19, 2026.`, facts: both, marker: /is dated February 19/ },
    "wrong sum of both": { text: `Both together total ${money(sum + 0.01)}.`, facts: both, marker: new RegExp(money(sum + 0.01).replace(/[$.]/g, "\\$&")) },
    "card sum that is not a sum": { text: "ok", facts: [{ label: "Total", value: money(sum + 100), sources: cs("A", "B") }], marker: /3,267/ },
  };
  for (const [n, o] of Object.entries(agentWrong)) { const { marker, ...rest } = o; const out = runAgent(rest); const s = `${out.text}\n${(out.facts ?? []).map((f) => `${f.label} | ${f.value}`).join("\n")}`; check(`A8 d1 agent stops [${n}]`, !(out.kind === "answer" && marker.test(s)), s.replace(/\n/g, " / ")); }
  const agentRight = {
    "both amounts, each on its own id": { text: `${R.inv.num} totals ${money(R.inv.total)} and ${R.inv2.num} totals ${money(R.inv2.total)}.`, facts: both },
    "sum of both": { text: `Both together total ${money(sum)}.`, facts: both },
    "card sum of both": { text: "ok", facts: [{ label: "Total", value: money(sum), sources: cs("A", "B") }] },
    "name with its own amount": { text: `${R.inv.customer} owes ${money(R.inv.total)}.`, facts: both },
    "aggregate over more records than cited": { text: `Invoiced $589,866.50 across 40 invoices.`, facts: [{ label: "Invoiced", value: "$589,866.50", sources: cs("A", "B") }] },
  };
  for (const [n, o] of Object.entries(agentRight)) { const out = runAgent(o); check(`A8 d1 agent keeps [${n}]`, out.kind === "answer" && (out.facts ?? []).length === o.facts.length && !out.groundingNote, JSON.stringify(out.claimCheck?.unsupported)); }

  // gate latency on a typical answer stays small
  const t = process.hrtime.bigint(); for (let i = 0; i < 50; i++) h.gate.applyGrounding({ kind: "answer", confidence: 0.9, text: `${R.inv.num} totals ${money(R.inv.total)} for ${R.inv.customer} at ${R.inv.svcStreet}, ${R.inv.svcCity}, AZ ${R.inv.svcZip} on ${R.inv.longDate}.`, facts: [{ label: "Total", value: money(R.inv.total), sources: cs("A") }, { label: "Customer", value: R.inv.customer, sources: cs("A") }], sources: cs("A") }, ev);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 50;
  check("A8: gate adds < 20 ms on a typical answer", ms < 20, `${ms.toFixed(2)} ms`);
  realLog(`A8 grounding: ${cases.length} pipeline cases + ${Object.keys(agentWrong).length + Object.keys(agentRight).length} agent cases; model-path ask p50 ${[...h.lats].sort((a, b) => a - b)[Math.floor(h.lats.length / 2)]} ms; gate ${ms.toFixed(2)} ms`);
});

section("B understanding + A1/A2/A3/A5/A6", async () => (await import("./lib/r41u-sec-b-a1-a6.mjs")).default({ check, realLog, off, makeHarness }));
section("E2 A9 no transaction held during the model call", async () => (await import("./lib/r41u-sec-e2-a9.mjs")).default({ check, realLog, off, makeHarness }));

section("E2 A4 count the thing named", async () => (await import("./lib/r41u-sec-e2-a4.mjs")).default({ check, realLog, off, makeHarness }));

section("E2 A7 look-alikes, dropped filters, dates, expiry windows", async () => (await import("./lib/r41u-sec-e2-a7.mjs")).default({ check, realLog, off, makeHarness }));

section("E3 gate2: units, identifiers, roles, status, currency, homoglyphs, caps", async () => (await import("./lib/r41u-sec-e3-gate2.mjs")).default({ check, realLog, off, makeHarness }));

section("E4 lanes: look-alikes, near miss, direction, future, bill, amounts, years, question words, counts", async () => (await import("./lib/r41u-sec-e4-lanes.mjs")).default({ check, realLog, off, makeHarness }));

section("E5 lookups by bare number, gate suffixes / PO Box / installments / nicknames / titles", async () => (await import("./lib/r41u-sec-e5.mjs")).default({ check, realLog, off, makeHarness }));

section("R2 names: a customer that exists is never missing (bill/invoice, possessives, glued verbs, amounts, vendor-bill counts)", async () => (await import("./lib/r41u-sec-r2-names.mjs")).default({ check, realLog, off, makeHarness }));
section("R3 denial rule: no denial for an existing customer (property over every golden customer)", async () => (await import("./lib/r41u-sec-r3-denial.mjs")).default({ check, realLog, off, makeHarness }));
section("R3 isolation: each organization only sees its own names; a decline never repeats the model", async () => (await import("./lib/r41u-sec-r3-isolation.mjs")).default({ check, realLog, off, makeHarness }));
section("R3 loop 1 regressions", async () => (await import("./lib/r41u-sec-r3-loop1.mjs")).default({ check, realLog, off, makeHarness }));

section("R2 gate: suffixes, roles, label-bound figures, units, markers, references, qualifiers", async () => (await import("./lib/r41u-sec-r2-gate.mjs")).default({ check, realLog, off, makeHarness }));

section("R2 lanes: role-word bare numbers, credit memo / PO counts, last bill for a vendor, question-word invoice, brand+city counts, short lists, tenant/donor amounts", async () => (await import("./lib/r41u-sec-r2-lanes.mjs")).default({ check, realLog, off, makeHarness }));

section("R2 lanes2: first-name possessives, surname bill, glued names, exact beats fuzzy, amount-for, vendor-bill filters, customer vs vendor grouping, what do we owe, no empty reply", async () => (await import("./lib/r41u-sec-r2-lanes2.mjs")).default({ check, realLog, off, makeHarness }));

/* ================================================================== (later sections are appended here) */

for (const [name, fn] of sections) { try { await fn(); } catch (e) { check(`${name}: section ran without throwing`, false, e?.stack ?? e); } }
realLog(`\nR41U: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) realLog("  FAIL " + f); process.exit(1); }
