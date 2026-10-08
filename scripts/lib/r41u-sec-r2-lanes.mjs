// R2 lanes: role words (tenant/donor/landlord/...) set direction and are never names; "how many credit memos / purchase orders"; "last bill for <vendor>"; question-word "my invoice";
// brand + city counts; short answers instead of dumps; tenant/donor with an amount. Fresh invented organisations (a property manager, a nonprofit); truth from the raw rows below;
// the stubbed model returns a WRONG answer that must never be shown, and exact lookups make 0 model calls.
export default async function ({ check, realLog, off, makeHarness }) {
  const usd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const doc = (num, party, iso, total, x = {}) => ({ num, customer: party, iso, total, file: `${num}.pdf`, text: `${x.direction === "payable" ? "BILL" : x.kind === "po" ? "PURCHASE ORDER" : x.kind === "credit_memo" ? "CREDIT MEMO" : "INVOICE"}\nNumber: ${num}\nDate: ${iso}\n${x.direction === "payable" ? "From" : "Bill To"}: ${party}\n${x.extra ?? ""}TOTAL DUE: ${total == null ? "" : usd(total)}`, ...x });
  const WRONG = { kind: "answer", text: "Invoice INV-1001 for Zebediah Crane totals $3,407.00 and was paid in full.", facts: [{ label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.95 };
  const noLeak = (s) => !/Zebediah|3,407\.00|INV-1001/.test(s);
  const prevHelp = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const PROBE = process.env.R2L_PROBE;
  let calls = 0; const model = () => { calls++; return WRONG; };
  const stubs = [];
  // every harness installs its own scripted model; the last one installed is the live one, so all of them get the same wrong-answer stub and calls are counted once here
  const mk = async (key, docs) => { const h = await makeHarness({ off, tenantKey: key, docs }); stubs.push(h.stub); return async (q) => { calls = 0; for (const st of stubs) st.fn = model; const r = await h.ask(q, model); return { r, s: h.shown(r), text: r.text, calls }; }; };
  const run = async (ask, label, qs, ok) => { for (const q of qs) { const a = await ask(q); if (PROBE) realLog(`[${label}] ${q}\n   -> ${a.r.kind ?? a.r.error}: ${a.s.slice(0, 380).replace(/\n/g, " | ")} (calls ${a.calls})`); check(`R2L ${label} [${q}]`, a.calls === 0 && noLeak(a.s) && ok(a.s, a), a.text.slice(0, 300)); } };

  // ---- property manager: tenants are billed rent, the landlord bills us; Trane units and a Mesa/Tempe split
  const pm = await mk("r2l-pm", {
    t1: doc("1234", "Ines Carver", "2026-08-01", 1200, { addr: "14 Palm Ct, Mesa, AZ 85201", extra: "Equipment: Trane XR14 unit\n" }),
    t2: doc("PM-2235", "Omar Fenn", "2026-08-02", 1350, { addr: "9 Elm Ave, Tempe, AZ 85281", extra: "Equipment: Trane XR16 unit\n" }),
    t3: doc("PM-2236", "Lia Moss", "2026-08-03", 950, { addr: "3 Pine Rd, Mesa, AZ 85203", extra: "Equipment: Lennox unit\n" }),
    t4: doc("PM-2237", "Pablo Quist", "2026-08-04", 1200, { addr: "77 Oak Ln, Gilbert, AZ 85234" }),
    l1: doc("1234", "Oakridge Holdings", "2026-07-01", 6400, { direction: "payable", vendorName: "Oakridge Holdings" }),
    l2: doc("LL-88", "Oakridge Holdings", "2026-09-01", 6400, { direction: "payable", vendorName: "Oakridge Holdings" }),
    v1: doc("BILL-31", "Brightline Plumbing", "2026-09-09", 480, { direction: "payable", vendorName: "Brightline Plumbing" }),
  });
  // ---- nonprofit: donors give gifts (receipts are receivable-side documents), one PO and one credit memo
  const np = await mk("r2l-np", {
    d1: doc("1234", "Maya Ortiz", "2026-05-01", 500), d2: doc("DN-2002", "Ravi Shah", "2026-05-02", 500), d3: doc("DN-2003", "Tess Bell", "2026-05-03", 75),
    d4: doc("DN-2004", "Gil Ames", "2026-05-04", 250),
    v1: doc("BILL-9", "Paperworks Printing", "2026-06-01", 310, { direction: "payable", vendorName: "Paperworks Printing" }),
  });
  const pmN = await mk("r2l-pm2", { t1: doc("PM-1", "Ines Carver", "2026-08-01", 1200, { addr: "14 Palm Ct, Mesa, AZ 85201" }), cm: doc("CM-7", "Ines Carver", "2026-08-05", -100, { kind: "credit_memo" }), cm2: doc("CM-8", "Omar Fenn", "2026-08-06", -50, { kind: "credit_memo" }), po: doc("PO-3", "Brightline Plumbing", "2026-08-07", 200, { kind: "po", docType: "purchase-order", direction: "payable", vendorName: "Brightline Plumbing" }) });
  const noDocs = await mk("r2l-none", { t1: doc("Z-1", "Una Pike", "2026-08-01", 80) });

  // 1. bare number + role word
  const q1 = (n, role, extra = "") => [`#${n} from a ${role}`, `invoice ${n} from a ${role}`, `#${n} from a ${role}${extra}`, `${n} from a ${role}`, `invoice #${n} from a ${role}`, `whats #${n} from a ${role}`, `wheres invoice ${n} from a ${role}`, `show me #${n} from a ${role}`, `invoice ${n} from the ${role}`, `#${n} from ${role}`];
  await run(np, "d1 donor", q1(1234, "donor"), (t) => /1234/.test(t) && /Maya Ortiz/.test(t) && !/not (?:a |an )?(?:donor|customer)|Ortiz.*Oakridge/i.test(t));
  await run(pm, "d1 landlord", q1(1234, "landlord"), (t) => /1234/.test(t) && /Oakridge/.test(t) && !/Ines Carver/.test(t));
  await run(pm, "d1 tenant", q1(1234, "tenant"), (t) => /1234/.test(t) && /Ines Carver/.test(t) && !/Oakridge/.test(t));

  // 2. count document kinds
  await run(pmN, "d2 credit memos", ["how many credit memos", "how many credit memos do we have", "how many credit memos are there", "number of credit memos", "how many credit memo", "how many creditmemos", "how many credit memos have we got", "how many credit memos on file", "count of credit memos", "how many credit memos?"], (t) => /\b2\b/.test(t) && /credit memo/i.test(t) && !/invoices/i.test(t.replace(/credit memos?/gi, "")));
  await run(pmN, "d2 purchase orders", ["how many purchase orders", "how many purchase orders do we have", "how many purchase orders are there", "number of purchase orders", "how many purchase order", "how many POs", "how many purchase orders have we got", "how many purchase orders on file", "count of purchase orders", "how many purchase orders?"], (t) => /\b1\b/.test(t) && /purchase order/i.test(t));
  await run(noDocs, "d2 zero credit memos", ["how many credit memos", "how many credit memos do we have", "number of credit memos", "how many credit memos?", "how many credit memo"], (t) => /\b(?:0|no|zero)\b/i.test(t) && /credit memo/i.test(t));
  await run(noDocs, "d2 zero purchase orders", ["how many purchase orders", "how many purchase orders do we have", "number of purchase orders", "how many purchase orders?", "how many purchase order"], (t) => /\b(?:0|no|zero)\b/i.test(t) && /purchase order/i.test(t));

  // 3. last bill for/from a vendor
  const lb = (v) => [`last bill for ${v}`, `latest bill for ${v}`, `last bill from ${v}`, `latest bill from ${v}`, `whats the last bill for ${v}`, `wheres the latest bill from ${v}`, `last bill for ${v.toLowerCase()}`, `latest bil for ${v}`, `most recent bill from ${v}`, `the last bill from ${v} please`];
  await run(pm, "d3 landlord vendor", lb("Oakridge Holdings"), (t) => /LL-88/.test(t) && /6,400\.00/.test(t) && !/not found|don.t see/i.test(t));
  await run(pm, "d3 plumbing", lb("Brightline Plumbing"), (t) => /BILL-31/.test(t) && /480\.00/.test(t));
  await run(np, "d3 printing", lb("Paperworks Printing"), (t) => /BILL-9/.test(t) && /310\.00/.test(t));

  // 4. question-word "my invoice"
  const qw = ["whats my invoice", "hows my invoice", "whos my invoice", "whats my invoice?", "what's my invoice", "hows my invoice?", "who's my invoice", "whos my invoice?", "whats our invoice", "hows our invoice"];
  await run(noDocs, "d4 single", qw, (t) => /Una Pike|Z-1/.test(t) || /\?/.test(t));
  await run(pm, "d4 many", qw, (t) => /\?/.test(t) && !/customer named|couldn.t|can.t help|don.t understand/i.test(t) && t.length < 400);

  // 6. landlord invoice list is short
  await run(pm, "d6 landlord list", ["show me the invoice from a landlord", "show me the invoices from a landlord", "whats the invoice from a landlord", "wheres the invoice from a landlord", "invoice from a landlord", "show me invoice from landlord", "show the invoice from a landlord", "invoices from a landlord", "wheres the invoice from the landlord", "give me the invoice from a landlord"], (t) => t.length < 700 && /\b3 bills\b/.test(t) && !/Ines Carver/.test(t));

  // 7. tenant / donor with an amount
  await run(pm, "d7 tenant 1200", ["who is the tenant billed 1200", "who is the tenant billed $1200", "which tenant was billed 1200", "whos the tenant billed 1200", "which tenant is billed $1,200", "tenant billed 1200", "who is the tenant that was billed 1200", "which tenant got billed 1200", "whos the tenant billed 1200?", "which tenant was charged 1200"], (t) => /Ines Carver/.test(t) && /Pablo Quist/.test(t) && !/Oakridge|Omar/.test(t));
  await run(np, "d7 donor 500", ["which donor gave 500", "which donor gave $500", "who is the donor that gave 500", "whos the donor that gave 500", "which donor gave 500?", "donor who gave 500", "which donors gave 500", "which donor donated 500", "who was the donor of 500", "which donor gave $500.00"], (t) => /Maya Ortiz/.test(t) && /Ravi Shah/.test(t) && !/Tess Bell|Gil Ames/.test(t));
  await run(np, "d7 donor none", ["which donor gave 9999", "which donor gave $9999", "who is the donor that gave 9999", "which donor gave 9999?", "which donors gave 9999"], (t) => /9,?999/.test(t) && /no|not|none|don.t|didn.t/i.test(t) && !/Maya|Ravi|Tess|Gil/.test(t));

  // 5. brand + city: counted as UNITS from the org's own equipment records (a golden-style HVAC export with one extra Mesa Trane unit so units differ from customers)
  {
    const T = await import("./r41u-e2-tenant.mjs");
    const base = T.golden();
    const cust = new Map(base.entities.filter((e) => e.entity_type === "customer").map((c) => [c.id, c]));
    const eqIn = (d, brand, city) => d.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into && /trane|carrier|lennox|rheem|goodman|york/i.test(e.data.manufacturer ?? "") && String(e.data.manufacturer).toLowerCase() === brand.toLowerCase() && cust.get(e.customer_id) && T.cityOf(cust.get(e.customer_id).data.service_address) === city);
    const dup = eqIn(base, "Trane", "Mesa")[0];
    const d2 = JSON.parse(JSON.stringify(base));
    d2.entities.push({ ...JSON.parse(JSON.stringify(dup)), id: "0c43e376-8984-4cf8-a7cf-00000000beef", data: { ...dup.data, serial_number: "F-R2L-DUP" } });
    const hv = await T.loadTenant(off, d2, { key: "r2l-hvac" });
    const hask = async (q) => { calls = 0; for (const st of stubs) st.fn = model; const r = await hv.ask(q); return { r, s: `${r.text}\n${r.facts.map((f) => `${f.label} ${f.value}`).join("\n")}`, text: r.text, calls }; };
    const truth = (brand, city) => { const eq = eqIn(d2, brand, city); return { units: eq.length, customers: new Set(eq.map((e) => e.customer_id)).size }; };
    const has = (t, n) => new RegExp(`(?<![\\d,.])${n}(?![\\d,])`).test(t);
    for (const [brand, city] of [["Trane", "Mesa"], ["Carrier", "Tempe"], ["Lennox", "Gilbert"]]) {
      const tr = truth(brand, city); const B = brand, b = brand.toLowerCase(), C = city, c = city.toLowerCase();
      const qs = [`how many ${B} units in ${C}`, `how many ${b} units in ${c}`, `how many ${B} units are in ${C}`, `how many ${B} units do we have in ${C}`, `how many ${b} in ${c}`, `count of ${B} units in ${C}`, `how many ${B} unit in ${C}`, `how many ${B} units in ${C}?`, `number of ${B} units in ${C}`, `how many ${B} systems in ${C}`];
      for (const q of qs) {
        const a = await hask(q); if (PROBE) realLog(`[d5 ${brand}/${city}] ${q} -> ${a.s.slice(0, 200).replace(/\n/g, " | ")} (truth ${JSON.stringify(tr)})`);
        // counts units (the unit figure, said as units), or declines honestly; never the customer figure presented as units
        const countsUnits = has(a.text, tr.units) && /unit|system/i.test(a.text) && !(tr.units !== tr.customers && has(a.text, tr.customers) && !has(a.text, tr.units));
        const declines = a.r.kind !== "answer" && !/\b\d+ customers?\b/i.test(a.text);
        const zeroOk = tr.units === 0 && /\b(?:no|0)\b/i.test(a.text) && !/\b[1-9]\d* (?:customers?|units?)\b/.test(a.text);
        check(`R2L d5 ${brand} units in ${city} [${q}]`, (a.calls === 0 || !/units?|systems?/i.test(q)) && noLeak(a.s) && (countsUnits || declines || zeroOk), a.s.slice(0, 250));
      }
    }
    check("R2L d5 truth differs for Trane/Mesa (meaningful)", truth("Trane", "Mesa").units !== truth("Trane", "Mesa").customers, JSON.stringify(truth("Trane", "Mesa")));
    // another organization never sees these units
    const other = await pm("how many Trane units in Mesa"); check("R2L d5 other org answers from its own records", other.calls === 0 && !has(other.text, truth("Trane", "Mesa").units + 5) && !/F-R2L|Trane XR/.test(other.text) || /\b0\b|no units|No units/.test(other.text), other.text);
  }

  // a zip code next to a role word is never an amount / invoice number
  for (const q of ["which tenants are in 85201", "how many tenants in 85201", "tenants in 85203", "which tenant lives in 85281"]) { const a = await pm(q); check(`R2L zip is not an amount [${q}]`, noLeak(a.s) && !/No (?:invoice|bill) (?:on file )?(?:has a total|numbered)|totals? \$85,/i.test(a.text), a.text.slice(0, 250)); }
  if (prevHelp === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prevHelp;
  realLog("R2 lanes: done");
}
