// R2 names: a customer that exists is never "missing", whatever the phrasing (bill/invoice, possessive without apostrophe, verbs glued after the name, "did we ever invoice X").
// Real golden-export customers (truth from the raw export rows), a model stub that always answers with a WRONG customer/total, help gate ON.
import * as F from "./r40-fixture.mjs";
import { installScriptedModel } from "./r40-model-stub.mjs";
export default async function ({ check, realLog, off }) {
  const stub = await installScriptedModel();
  const prev = process.env.ASK_HELPGATE_IN_SCORECARD; process.env.ASK_HELPGATE_IN_SCORECARD = "1";
  const d = F.liveFixture(); d.tenantKey = "r41u-r2"; d.tenantName = "r41u-r2";
  const invOf = (name) => d.financials.filter((x) => x.doc_kind === "invoice" && x.direction === "receivable" && x.customer_name === name);
  // a customer with several invoices (added to a real one) and look-alike surnames
  const gary = d.entities.find((e) => e.entity_type === "customer" && e.data.customer_name === "Gary Villegas");
  F.addInvoice(d, { num: "INV-R2-9", customer: "Gary Villegas", customerId: gary.id, dateIso: "2026-08-01", dateUs: "08/01/2026", addr: gary.data.service_address, desc: "Extra visit", total: "1111.11", filename: "r2-9.pdf" });
  const names = (process.env.R2_NAMES ? process.env.R2_NAMES.split(",") : null) ?? ["Michelle Sandoval", "George Garrison", "Jason Zamora", "David Prentiss", "Kathleen Jennings", "Angela Hutchins", "Michelle Tovar", "Ronald Calloway", "Gary Villegas", "Carol Rios"];
  const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 });
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const ctx = (await off.loadExportIntoNewTenant(lite, d, { tenantKey: "offline:r41u-r2", tenantName: "r41u-r2" })).ctx;
  const WRONG = { kind: "answer", text: "Zebediah Crane owes $3,407.00.", facts: [{ label: "Customer", value: "Zebediah Crane", sources: [] }, { label: "Total", value: "$3,407.00", sources: [] }], sources: [], confidence: 0.9 };
  const ask = async (question) => {
    await off.setActiveDatabase(lite); stub.fn = () => WRONG; stub.calls = 0;
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: "r41u-r2", userId: null }, question, today: "2026-10-07" });
    const facts = r.data?.facts ?? [];
    return { kind: r.data?.kind, text: String(r.data?.text ?? ""), calls: stub.calls, shown: `${r.data?.text ?? ""}\n${facts.map((f) => `${f.label} ${f.value}`).join("\n")}\n${r.data?.interpretation ?? ""}` };
  };
  const MISSING = /don't see a (customer|vendor)|no such customer|not in your records|can't find an? (bill|invoice) for them/i;
  const STUB = /zebediah|crane|3,407/i;
  const nameQs = (X) => [`how much was ${X}'s bill`, `how much was ${X} bill`, `did ${X} pay their invoice`, `did ${X} pay`, `show ${X.toLowerCase()}'s invoice please`, `show ${X.toLowerCase()}s invoice please`, `wheres ${X} invoice`, `whats ${X} invoice`,
    `did we ever invoice ${X}`, `what did ${X} get charged`, `is ${X}'s invoice paid`, `what does ${X} owe`, `${X} invoice`, `${X}'s invoice`, `latest invoice for ${X}`, `how much did we bill ${X}`, `what did we bill ${X}`, `give me ${X}'s bill`, `${X} bill`, `how much did ${X} pay`,
    `did ${X} owe us anything`, `has ${X} paid`, `what is ${X}s bill`, `how much does ${X} have due`, `did we bill ${X}`];
  const amtQs = (a, dollars) => [`who did we bill ${a}`, `which customer did we bill ${dollars}`, `the invoice thats ${dollars} whos it for`, `wheres the invoice for ${dollars}`, `who was invoiced ${a}`, `whose invoice is ${dollars}`, `whos the ${dollars} invoice for`, `which invoice was for ${a}`, `find the invoice for ${dollars}`, `whats the ${dollars} invoice`, `who is the ${a} invoice for`, `invoice for ${dollars} who`];
  let n = 0;
  for (const X of names) {
    const rows = invOf(X); if (!rows.length) { check(`R2 fixture has ${X}`, false, "missing in export"); continue; }
    const nums = rows.map((r) => r.invoice_number);
    const first = X.split(" ")[0];
    const mustHave = (s) => nums.some((x) => s.includes(x)) || rows.some((r) => s.includes(money(r.total)));
    for (const q of nameQs(X)) {
      n++; const r = await ask(q);
      const ok = !MISSING.test(r.shown) && !STUB.test(r.shown) && r.calls === 0 && (mustHave(r.shown) || (r.kind !== "answer" && new RegExp(X, "i").test(r.shown) && !MISSING.test(r.shown)) );
      check(`R2 name [${q}]`, ok, `${r.calls} calls :: ${r.shown.replace(/\n/g, " / ").slice(0, 260)}`);
      if (/pay|paid|owe/.test(q) && /did .* pay|paid|owe/.test(q) && !/owe us anything/.test(q)) check(`R2 payment [${q}] does not invent a paid status`, !/\b(is|was|has been|were|are) paid\b|paid in full|yes, .* paid|\$0\.00 (due|owed)/i.test(r.text.replace(/payment status isn't recorded[^.]*\./gi, "").replace(/payment (status )?(is )?not recorded[^.]*\./gi, "")), r.text);
    }
    const t = rows[0].total; const dollars = `$${Number(t).toLocaleString("en-US", { minimumFractionDigits: 2 })}`.replace(/\.00$/, ""); const plain = String(Number(t).toFixed(2));
    const sameTotal = d.financials.filter((x) => x.doc_kind === "invoice" && Number(x.total) === Number(t)).map((x) => x.customer_name);
    for (const q of amtQs(plain, dollars)) {
      n++; const r = await ask(q);
      const ok = !STUB.test(r.shown) && r.calls === 0 && !/don't see a (customer|vendor)/i.test(r.shown) && sameTotal.every((c) => r.shown.includes(c.split(" ").pop())) ;
      check(`R2 amount [${first} ${q}]`, ok, `${r.calls} calls :: ${r.shown.replace(/\n/g, " / ").slice(0, 260)}`);
    }
  }
  // look-alike first name only must not pick wrongly: ambiguous is allowed to clarify, never to deny
  for (const q of ["did Michelle pay their invoice", "Michelle's invoice"]) { const r = await ask(q); check(`R2 first name only [${q}] never invents`, !STUB.test(r.shown) && r.calls === 0, r.shown.slice(0, 200)); }
  // controls: names that do not exist decline by name, amounts that match nothing say none
  for (const X of ["Quentin Vandersloot", "Mildred Okonkwo-Brandt"]) for (const q of [`how much was ${X}'s bill`, `did ${X} pay their invoice`, `show ${X.toLowerCase()}s invoice please`, `did we ever invoice ${X}`, `is ${X}'s invoice paid`]) {
    const r = await ask(q); check(`R2 control missing name [${q}]`, !STUB.test(r.shown) && (r.calls === 0 || /nothing in your records/i.test(r.shown)) && !/INV-\d/.test(r.shown) && (new RegExp(X.split(" ")[0], "i").test(r.shown) || /nothing in your records/i.test(r.shown)), `${r.calls} :: ${r.shown.slice(0, 200)}`);
  }
  for (const q of ["who did we bill 99999.99", "which customer did we bill 98765", "the invoice thats 88,888 whos it for", "wheres the invoice for 77777"]) {
    const r = await ask(q); check(`R2 control no such amount [${q}]`, !STUB.test(r.shown) && r.calls === 0 && !/INV-\d/.test(r.shown) && /no |none|n't|not/i.test(r.shown), `${r.calls} :: ${r.shown.slice(0, 200)}`);
  }
  // defect 6/7: vendor bills (this tenant has purchase orders but no vendor bills)
  const poOnly = d.financials.filter((x) => x.doc_kind === "bill" || (x.direction === "payable" && x.doc_kind !== "po")).length === 0;
  for (const q of ["how many vendor bills do we have", "how many bills do we have from vendors", "number of vendor bills", "how many vendor bills are there"]) {
    const r = await ask(q); check(`R2 d6 [${q}] answered from rows, 0 model calls, no stub figure`, r.calls === 0 && !STUB.test(r.shown) && (!poOnly || /no vendor bills|0 vendor bills|zero vendor bills|don't have any vendor bills|no bills/i.test(r.shown)), `${r.calls} :: ${r.shown.slice(0, 200)}`);
  }
  for (const q of ["what do we owe our vendors", "what do we owe vendors", "how much do we owe our vendors"]) {
    const r = await ask(q); check(`R2 d7 [${q}] says there are no vendor bills on file`, r.calls === 0 && !STUB.test(r.shown) && !/^no open bills\.?$/i.test(r.text.trim()) && /no vendor bills|no bills on file|no vendor bills on file/i.test(r.shown), `${r.calls} :: ${r.shown.slice(0, 200)}`);
  }
  // generic decline rule: a model-supplied figure/name is never repeated in a decline
  for (const q of ["how many widgets did the moon order last tuesday", "what is the airspeed of a laden swallow"]) {
    const r = await ask(q); check(`R2 decline never repeats the model's figure/name [${q}]`, !(r.kind !== "answer" && STUB.test(r.shown)) && !STUB.test(r.shown), r.shown.slice(0, 200));
  }
  realLog(`R2 names: ${n} name/amount asks over ${names.length} customers`);
  if (prev === undefined) delete process.env.ASK_HELPGATE_IN_SCORECARD; else process.env.ASK_HELPGATE_IN_SCORECARD = prev;
}
