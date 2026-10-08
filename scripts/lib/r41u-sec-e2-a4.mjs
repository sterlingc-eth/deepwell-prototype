// E2 A4: count the entity the question names. "how many customer invoices" counts INVOICES, "how many customers have invoices" counts CUSTOMERS,
// "how many units do we manage in Mesa" counts UNITS (not the customers that own them). Truth is computed from the raw export rows.
export default async function ({ check, realLog, off }) {
  const T = await import("./r41u-e2-tenant.mjs");
  const { countSubject } = await import("../../api/_lib/understanding/understand.js");
  const base = T.golden();
  const t = await T.loadTenant(off, base, { key: "r41u-e2a4" });
  const invoices = T.rawInvoiceDocs(base), custWith = T.rawCustomersWithInvoice(base), mesa = T.rawUnitsIn(base, "Mesa"), gil = T.rawUnitsIn(base, "Gilbert");
  const has = (shown, n) => new RegExp(`(?<![\\d,.])${n}(?![\\d,])`).test(shown);
  const decor = (q) => [q, q.toUpperCase(), q.replace(/^how many/, "how many total"), `${q}?`, `hey donovan ${q}`, `can you tell me ${q}`, q.replace(/ do we have| do we manage/, "")];

  // invoices: ~10 ways, all say the invoice count and never "customers ... have at least one invoice"
  const invQs = ["how many customer invoices do we have", "how many client invoices do we have", "how many customer invoices are there", "how many customer invoices", "how many invoices do we have", "how many invoices do we have on file", "number of customer invoices", "how many cutomer invoices do we have", "HOW MANY CUSTOMER INVOICES DO WE HAVE?", "how many customer invoices have we got"];
  for (const q of invQs) {
    const r = await t.ask(q);
    check(`A4 invoice count [${q}]`, r.kind === "answer" && has(r.shown, invoices) && !/customers? \(of/.test(r.shown) && !/at least one invoice/.test(r.shown), r.shown.replace(/\n/g, " / "));
  }
  // customers who have invoices stay customers
  for (const q of ["how many customers have invoices", "how many customers have an invoice", "how many clients have invoices", "how many customers do we have with invoices"]) {
    const r = await t.ask(q);
    check(`A4 customers with invoices stays customers [${q}]`, r.kind === "answer" && has(r.shown, custWith) && /customer|client/.test(r.shown), r.shown.replace(/\n/g, " / "));
  }
  { const r = await t.ask("how many customers have at least one invoice"); check("A4 customers with at least one invoice is never an invoice count", r.kind !== "answer" || (has(r.shown, custWith) && /customer/.test(r.shown)), r.shown); }
  // units vs customers
  const unitQs = [`how many units do we manage in Mesa`, `how many units in Mesa`, `how many units are in Mesa`, `how many units do we have in Mesa`, `how many pieces of equipment in Mesa`, `how many systems in mesa`, `HOW MANY UNITS DO WE MANAGE IN MESA`, `how many units we manage in mesa?`, `how many units do we manage in Mesa AZ`, `how many units in the city of Mesa`];
  for (const q of unitQs) {
    const r = await t.ask(q);
    const ok = r.kind === "answer" && has(r.shown, mesa.units) && /unit|equipment/i.test(r.shown);
    check(`A4 units in Mesa counts units [${q}]`, ok || (r.kind !== "answer" || !has(r.shown, mesa.customers)) && r.kind !== "answer", r.shown.replace(/\n/g, " / "));
    check(`A4 units in Mesa is never the customer count presented as units [${q}]`, !(r.kind === "answer" && !has(r.shown, mesa.units) && has(r.shown, mesa.customers) && !/not (?:individual )?units|customers/i.test(r.shown)), r.shown.replace(/\n/g, " / "));
  }
  check("A4 units-in-Mesa truth differs from customers-in-Mesa (the test is meaningful)", mesa.units !== mesa.customers, `${mesa.units} vs ${mesa.customers}`);
  const g = await t.ask("how many units are in Gilbert"); check("A4 units in Gilbert", has(g.shown, gil.units), g.shown);
  const c = await t.ask("how many customers do we have in Mesa"); check("A4 customers in Mesa stays customers", has(c.shown, mesa.customers) && /customer/.test(c.shown), c.shown);
  const w = await t.ask("how many customers have units in Mesa"); check("A4 customers who have units in Mesa stays customers", w.kind !== "answer" || (has(w.shown, mesa.customers) && !/You have \d+ units/.test(w.shown)), w.shown);
  const none = await t.ask("how many units in Atlantis"); check("A4 unknown city never invents a unit count", none.kind !== "answer" || has(none.shown, 0) || /don't see|no /i.test(none.shown), none.shown);
  // a brand + city unit question must say it counted customers if it cannot count units
  const tr = await t.ask("how many Trane units in Mesa"); check("A4 Trane units in Mesa names what was counted (its sentence says customers, or it counts units)", tr.kind !== "answer" || /customers?\b/.test(tr.text.split(/[.(]/)[0]) || /units/.test(tr.shown), tr.shown);

  // second organization: its own numbers, never the first organization's
  const d2 = JSON.parse(JSON.stringify(base)); const cust2 = d2.entities.filter((e) => e.entity_type === "customer" && T.cityOf(e.data.service_address) === "Mesa");
  const drop = new Set(cust2.slice(1).map((e) => e.id)); d2.entities = d2.entities.filter((e) => !drop.has(e.id) && !drop.has(e.customer_id));
  d2.document_entity_links = d2.document_entity_links.filter((l) => !drop.has(l.entity_id));
  const t2 = await T.loadTenant(off, d2, { key: "r41u-e2a4b" }); const m2 = T.rawUnitsIn(d2, "Mesa");
  const r2 = await t2.ask("how many units do we manage in Mesa"); check("A4 second organization counts its own units", has(r2.shown, m2.units) && (m2.units === mesa.units || !has(r2.shown, mesa.units)), `${r2.shown} (truth ${m2.units})`);
  const r2b = await t.ask("how many units do we manage in Mesa"); check("A4 first organization unaffected by the second", has(r2b.shown, mesa.units), r2b.shown);
  // empty data
  const e = JSON.parse(JSON.stringify(base)); e.entities = []; e.document_entity_links = []; e.documents = []; e.pages = []; e.extractions = []; e.financials = []; e.financial_lines = [];
  const t3 = await T.loadTenant(off, e, { key: "r41u-e2a4c" });
  for (const q of ["how many customer invoices do we have", "how many units do we manage in Mesa"]) { const r = await t3.ask(q); check(`A4 empty organization [${q}] never invents a count`, !/[1-9]\d* (?:units|invoices|customers)/.test(r.shown), r.shown); }
  // the shared module itself
  const cs = (q) => countSubject(q)?.subject;
  check("A4 countSubject customer invoices -> invoice", cs("how many customer invoices do we have") === "invoice", cs("how many customer invoices do we have"));
  check("A4 countSubject customers have invoices -> customers", cs("how many customers have invoices") === "customers", "");
  check("A4 countSubject units in Mesa -> units", cs("how many units do we manage in Mesa") === "units", "");
  check("A4 countSubject non-count -> null", cs("show me the invoice for Smith") == null, "");
  realLog(`A4 count subject: ${invQs.length + 5 + unitQs.length} questions; truth invoices ${invoices}, customers with invoice ${custWith}, units in Mesa ${mesa.units} (customers ${mesa.customers})`);
}
