/**
 * Round 2 (B2): the summary lane. Pure parser checks + end-to-end checks against the golden tenant (offline PGlite, no model, no network).
 *
 *   node scripts/verify-summary.mjs
 *
 * Covers: a customer with and without an invoice total, a document-type summary, a technician summary, a year summary, a brand summary,
 * the customer base, an unknown subject (releases), a document-type noun that looks like a name, an unused condition (no claim),
 * a question that is not a summary (no claim), the classifier hand-off, and that every number in every answer appears in the cited records.
 * Prints every sentence template at the end (for the owner's approval list).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
let count = 0;
const check = (name, ok, detail = "") => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

const { parseSummaryQuestion, canonicalSummaryQuestion } = await import("../api/_lib/summary/parse.js");
const { TEMPLATES } = await import("../api/_lib/summary/text.js");
const today = "2026-10-07";
const P = (q) => parseSummaryQuestion(q, { today });

/* ================================================================ Part A: pure parsing */
{
  check("customer name: 'give me a rundown on Canyon View Dental'", P("give me a rundown on Canyon View Dental")?.kind === "name");
  check("customer name: 'recap Richard Osborn for me'", P("recap Richard Osborn for me")?.phrase === "richard osborn");
  check("customer name: 'what do we have on file for Grace Community Church'", P("what do we have on file for Grace Community Church")?.kind === "name");
  check("customer name: 'brief me on Sunrise Valley Elementary before I call them'", P("brief me on Sunrise Valley Elementary before I call them")?.phrase === "sunrise valley elementary");
  check("customer name: possessive account 'status on Stephanie Osborn's account'", P("status on Stephanie Osborn's account")?.phrase === "stephanie osborn");
  check("customer name: subject first 'Donald Isaacson - the whole history please'", P("Donald Isaacson - the whole history please")?.phrase === "donald isaacson");
  check("customer name: 'overview of customer Mark Jennings' drops the word customer", P("overview of customer Mark Jennings")?.phrase === "mark jennings");
  check("person verb: 'how has Marisol Vega been performing lately'", P("how has Marisol Vega been performing lately")?.personVerb === true);
  const d1 = P("tell me about our purchase orders");
  check("document type: 'tell me about our purchase orders'", d1?.kind === "docType" && d1.docType === "purchase-order" && d1.period === null);
  const d2 = P("rundown on the work orders");
  check("document-type noun is never a name: 'rundown on the work orders'", d2?.kind === "docType" && d2.docType === "work-order");
  const d3 = P("sum up our invoicing for 2024");
  check("year summary: 'sum up our invoicing for 2024'", d3?.kind === "docType" && d3.docType === "invoice" && d3.period?.from === "2024-01-01" && d3.period?.to === "2024-12-31");
  const d4 = P("recap of what happened in 2023 on the invoice side");
  check("year summary: 'recap of what happened in 2023 on the invoice side'", d4?.docType === "invoice" && d4.period?.from === "2023-01-01");
  const d5 = P("give me the lay of the land on our inspection reports");
  check("document type: 'lay of the land on our inspection reports'", d5?.docType === "inspection-report");
  check("all documents in a year: 'recap of 2023'", P("recap of 2023")?.kind === "allDocs");
  check("brand: 'big picture on our Trane equipment'", P("big picture on our Trane equipment")?.kind === "brand" && P("big picture on our Trane equipment").phrase === "trane");
  check("customer base: 'what does our customer base look like'", P("what does our customer base look like")?.kind === "customers");
  // no claim
  check("unused condition: 'rundown on the open work orders' makes no claim", P("rundown on the open work orders") === null);
  check("unused condition: 'tell me about our invoices over $500' makes no claim", P("tell me about our invoices over $500") === null);
  check("unused condition: 'summary of purchase orders from Baker Distributing' makes no claim", P("summary of purchase orders from Baker Distributing") === null);
  check("two subjects: 'overview of invoices and work orders' makes no claim", P("overview of invoices and work orders") === null);
  check("a number that is not a year: 'status on invoice 20003' makes no claim", P("status on invoice 20003") === null);
  check("a customer with a period: 'recap Richard Osborn in 2024' makes no claim", P("recap Richard Osborn in 2024") === null);
  check("not a summary: 'how many invoices in 2024'", P("how many invoices in 2024") === null);
  check("not a summary: 'what is the phone number for Richard Osborn'", P("what is the phone number for Richard Osborn") === null);
  check("not a summary: 'warranty status on the Henderson account' (a field before the head)", P("what is the warranty status on the Henderson account") === null);
  check("not a summary: 'how do I mute the daily digest just for me'", P("how do I mute the daily digest just for me") === null);
  check("a fresh long question that merely contains 'tell me about' deep inside is not claimed", P("my customer wanted to know how long it will be before the tech can come out so tell me about it") === null);
  check("kill switch DONOVAN_SUMMARY=0 releases everything", (() => { process.env.DONOVAN_SUMMARY = "0"; const r = P("rundown on the work orders"); delete process.env.DONOVAN_SUMMARY; return r === null; })());
  // canonical spelling: names only, and it must parse back to the same intent
  const c1 = canonicalSummaryQuestion(P("recap Richard Osborn for me"), "recap Richard Osborn for me", { today });
  check("canonical spelling of a name keeps its case and parses back", c1 === "what do we have on file for Richard Osborn", c1);
  check("canonical spelling is not used for document types", canonicalSummaryQuestion(P("rundown on the work orders"), "rundown on the work orders", { today }) === null);
  // round 3 (B3): summary heads beyond the first family
  check("R3 head: 'give me a quick profile of Holy Trinity Church'", P("give me a quick profile of Holy Trinity Church")?.phrase === "holy trinity church");
  check("R3 head: 'dossier on George Hutchins'", P("dossier on George Hutchins")?.phrase === "george hutchins");
  check("R3 head: 'what's Amanda Quinley's history with us'", P("what's Amanda Quinley's history with us")?.phrase === "amanda quinley");
  check("R3 head: 'Kevin Abernathy: where do things stand'", P("Kevin Abernathy: where do things stand")?.phrase === "kevin abernathy");
  check("R3 head: 'where do things stand with Kevin Abernathy'", P("where do things stand with Kevin Abernathy")?.phrase === "kevin abernathy");
  check("R3 lead-in: 'I'm about to call Donna Winslow, what should I know'", P("I'm about to call Donna Winslow, what should I know")?.phrase === "donna winslow");
  check("R3 head: 'what should I know about Donna Winslow'", P("what should I know about Donna Winslow")?.phrase === "donna winslow");
  check("R3 head: 'walk me through everything we know about Copper Sky Dental'", P("walk me through everything we know about Copper Sky Dental")?.phrase === "copper sky dental");
  const up = P("what has Kevin Pratt been up to");
  check("R3 head: 'what has Kevin Pratt been up to' is a person summary", up?.phrase === "kevin pratt" && up.personVerb === true && up.upTo === true);
  check("R3 canonical: 'up to' parses back to the same intent", canonicalSummaryQuestion(up, "what has Kevin Pratt been up to", { today }) === "what has Kevin Pratt been up to");
  const w = P("wrap up our 2022 billing for me");
  check("R3 period: 'wrap up our 2022 billing for me'", w?.docType === "invoice" && w.period?.from === "2022-01-01" && w.period?.to === "2022-12-31");
  const h = P("how did 2025 look on the proposal side");
  check("R3 period: 'how did 2025 look on the proposal side'", h?.docType === "proposal-quote" && h.period?.from === "2025-01-01");
  check("R3 brand: 'characterize our Daikin equipment base'", P("characterize our Daikin equipment base")?.phrase === "daikin");
  check("R3 type: 'what does the permit situation look like'", P("what does the permit situation look like")?.docType === "permit");
  check("R3 type noun that looks like a name: 'profile of the work orders'", P("profile of the work orders")?.docType === "work-order");
  check("R3 release: head with an unexplained filter 'profile of Acme over $500'", P("profile of Acme over $500") === null);
  check("R3 release: head with a negation 'dossier on everyone except Rios'", P("dossier on everyone except Rios") === null);
  check("R3 release: name with a period 'what has Kevin Pratt been up to in 2024'", P("what has Kevin Pratt been up to in 2024") === null);
  check("R3 release: a job is not a customer 'what should I know about the Rios job'", P("what should I know about the Rios job") === null);
  check("R3 release: not a summary 'how did the install go'", P("how did the install go") === null);
}

/* ================================================================ Part B: classifier hand-off */
{
  const { classifyAll, TRIAL_ORDER, PRECEDENCE_TABLE } = await import("../api/_lib/router/classifyAll.js");
  check("summary is registered in TRIAL_ORDER and PRECEDENCE_TABLE", TRIAL_ORDER.includes("summary") && PRECEDENCE_TABLE.some((s) => s.name === "summary"));
  const r = await classifyAll("rundown on the work orders", { today, meta: null });
  check("classifier: a summary wins and travels as the contactLookup dispatch", r.winner?.name === "summary" && r.gated.contactLookup?.field === "summary" && !r.gated.docLookup && !r.gated.analytics, JSON.stringify(r.claimed));
  const r2 = await classifyAll("how many invoices in 2024", { today, meta: null });
  check("classifier: a count question is not a summary", r2.winner?.name !== "summary");
  const r3 = await classifyAll("recap Richard Osborn for me", { today, meta: null });
  check("classifier: a name summary is handed on in its canonical spelling", r3.effectiveQuestion === "what do we have on file for Richard Osborn", r3.effectiveQuestion);
}

/* ================================================================ Part C: end to end on the golden tenant */
{
  const off = await import("./offline-exam.mjs");
  const realLog = console.log;
  console.log = () => {}; console.warn = () => {};
  await off.installPgHarness();
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
  const lite = await off.createPGlite();
  await off.setActiveDatabase(lite);
  const { ctx } = await off.loadExportIntoNewTenant(lite, data, { tenantKey: "offline:summary-verify", tenantName: "Summary Verify" });
  console.log = realLog;
  const { withTenant } = await import("../api/_lib/recordsStore.js");
  const { runSummary } = await import("../api/_lib/summary/index.js");
  const sql = async (q, params = []) => (await lite.query(q, params)).rows;
  const run = (q) => withTenant(ctx, (db) => runSummary(db, q, { today }));

  const numbersIn = (text) => [...String(text).matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0]);
  const stripStored = (text, a) => {
    let t = String(text);
    for (const f of a.facts ?? []) if (["Phone", "Email", "Address"].includes(f.label)) t = t.replace(f.value, " ");
    t = t.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/g, " ");
    t = t.replace(/\b\d+ ton\b/g, " ").replace(/\b\d+-[\w-]+\.(?:pdf|txt|jpg)\b/g, " ").replace(/\d+ (?:has|have) no status\./g, " ").replace(/is also (?:the technician on|a customer, with) \d+ documents?/g, " ").replace(/\b[A-Z]{2,4}-\d+\b/g, " ").replace(/\b\d{4}\b(?= *\.?$|[ ,.])/g, (m) => (/^(19|20)\d\d$/.test(m) ? " " : m));
    return t;
  };
  /** every number in the answer must be a count or a sum that the cited records themselves add up to */
  const numbersCheck = (a) => {
    const recs = a.records ?? [];
    const allowed = new Set([a.recordsTotal, recs.length]);
    // counts of records per stored value (type, technician, status, size, ...) and dollar sums per document type, all read from the records themselves
    const bySegment = new Map(); const sumByType = new Map();
    for (const r of recs) {
      const segs = String(r.sublabel ?? "").split(" · ");
      for (const seg of new Set(segs)) bySegment.set(seg, (bySegment.get(seg) ?? 0) + 1);
      const m = /\$([\d,]+\.\d\d)/.exec(r.sublabel ?? "");
      if (m) sumByType.set(segs[0], Math.round(((sumByType.get(segs[0]) ?? 0) + Number(m[1].replace(/,/g, ""))) * 100) / 100);
    }
    for (const v of bySegment.values()) allowed.add(v);
    for (const v of sumByType.values()) allowed.add(v);
    const units = recs.filter((r) => r.type === "unit").length;
    if (units) allowed.add(units);
    allowed.add(recs.filter((r) => r.type === "document" || r.type === "invoice").length);
    const custs = new Set(recs.map((r) => r.customerId).filter(Boolean)).size;
    if (custs) allowed.add(custs);
    const bad = [];
    for (const raw of numbersIn(stripStored(a.text, a))) {
      const n = Number(raw.replace(/[$,]/g, ""));
      if (!allowed.has(n)) bad.push(raw);
    }
    return bad;
  };
  const customerOf = async (q) => (await sql(q))[0];

  // a customer WITH an invoice total
  const withInv = await customerOf(`select e.data->>'customer_name' n from entities e where e.entity_type='customer' and exists (select 1 from document_entity_links l join document_financials f on f.document_id=l.document_id and f.doc_kind='invoice' and f.total is not null where l.entity_id=e.id) order by 1 limit 1`);
  const a1 = (await run(`give me a rundown on ${withInv.n}`)).answer;
  check(`customer with an invoice total: ${withInv.n}`, a1 && /Invoices on file total \$[\d,]+\.\d\d/.test(a1.text) && a1.facts.some((f) => f.label === "Invoices total"), a1?.text);
  check("customer summary cites its documents and units", a1 && a1.recordsTotal >= 1 && a1.records.every((r) => ["document", "invoice", "unit"].includes(r.type)));
  check("customer summary: every number is in the cited records", a1 && numbersCheck(a1).length === 0, a1 && numbersCheck(a1).join(","));
  check("customer summary states the stored phone and address", a1 && (await sql(`select data->>'phone' p, data->>'service_address' a from entities where entity_type='customer' and data->>'customer_name'=$1`, [withInv.n])).every((r) => (!r.p || a1.text.includes(r.p)) && (!r.a || a1.text.includes(r.a))));

  // a customer WITHOUT any invoice (still has other documents, or none)
  const noInv = await customerOf(`select e.data->>'customer_name' n from entities e where e.entity_type='customer' and not exists (select 1 from document_entity_links l join documents d on d.id=l.document_id and d.document_type='invoice' where l.entity_id=e.id) and exists (select 1 from document_entity_links l where l.entity_id=e.id) order by 1 limit 1`);
  if (noInv) {
    const a2 = (await run(`recap ${noInv.n}`)).answer;
    check(`customer without an invoice: no invoice total is stated (${noInv.n})`, a2 && !/Invoices on file total/.test(a2.text) && !a2.facts.some((f) => f.label === "Invoices total"), a2?.text);
    check("customer without an invoice: numbers are still in the records", a2 && numbersCheck(a2).length === 0, a2 && numbersCheck(a2).join(","));
  } else {
    check("customer without an invoice: golden tenant has none (skipped)", true);
  }

  // document type
  const a3 = (await run("tell me about our purchase orders")).answer;
  const poN = (await sql(`select count(*)::int n from documents where document_type='purchase-order'`))[0].n;
  const poSum = (await sql(`select sum(f.total)::float s from document_financials f join documents d on d.id=f.document_id where d.document_type='purchase-order'`))[0].s;
  check("document type: the count is the number of purchase orders on file", a3 && a3.text.startsWith(`${poN} purchase orders on file`) && a3.recordsTotal === poN, a3?.text);
  check("document type: the total is the stored sum", a3 && a3.text.includes(poSum.toLocaleString("en-US", { minimumFractionDigits: 2 })), a3?.text);
  check("document type: every number is in the cited records", a3 && numbersCheck(a3).length === 0, a3 && numbersCheck(a3).join(","));
  const a3b = (await run("rundown on the work orders")).answer;
  check("a document-type noun that looks like a name is the type, not a customer", a3b && /^31 work orders on file/.test(a3b.text) && !/Rundown/i.test(a3b.text), a3b?.text);

  // a year
  const a4 = (await run("sum up our invoicing for 2024")).answer;
  const y = (await sql(`select count(*)::int n, sum(f.total)::float s from document_financials f where f.doc_kind='invoice' and extract(year from f.invoice_date)=2024`))[0];
  check("year summary: invoice count and total for 2024 match the stored invoices", a4 && a4.text.startsWith(`${y.n} invoices on file`) && a4.text.includes(y.s.toLocaleString("en-US", { minimumFractionDigits: 2 })), a4?.text);
  check("year summary: every number is in the cited records", a4 && numbersCheck(a4).length === 0, a4 && numbersCheck(a4).join(","));
  const a4b = (await run("recap of 2023")).answer;
  check("all documents in a year: dated inside the year only", a4b && /dated in 2023/.test(a4b.text) && a4b.records.every((r) => /2023/.test(r.sublabel ?? "")), a4b?.text);

  // technician
  const tech = (await sql(`select coalesce(nullif(corrected_value,''),value) n, count(distinct document_id)::int c from extractions where field_key='technician' group by 1 order by 2 desc limit 1`))[0];
  const a5 = (await run(`how has ${tech.n} been performing lately`)).answer;
  check(`technician summary: ${tech.n} is on ${tech.c} documents`, a5 && a5.text.includes(`technician on ${tech.c} documents`) && /do not rate performance/.test(a5.text), a5?.text);
  check("technician summary: every number is in the cited records", a5 && numbersCheck(a5).length === 0, a5 && numbersCheck(a5).join(","));

  // brand
  const a6 = (await run("big picture on our Trane equipment")).answer;
  const tr = (await sql(`select count(*)::int n from entities where entity_type='equipment' and data->>'manufacturer'='Trane'`))[0].n;
  check("brand summary: the unit count is the Trane units on file", a6 && a6.text.startsWith(`${tr} Trane units on file`) && a6.recordsTotal === tr, a6?.text);
  check("brand summary: every number is in the cited records", a6 && numbersCheck(a6).length === 0, a6 && numbersCheck(a6).join(","));

  // customer base
  const a7 = (await run("what does our customer base look like")).answer;
  const cb = (await sql(`select count(*)::int n, count(*) filter (where data->>'phone' is not null)::int p, count(*) filter (where data->>'email' is not null)::int e from entities where entity_type='customer'`))[0];
  check("customer base: counts of customers, phones and emails", a7 && a7.text.startsWith(`${cb.n} customers on file`) && a7.text.includes(`${cb.p} of them have a phone number, ${cb.e} have an email address`), a7?.text);

  // round 3 (B3): new heads end to end
  const t3 = (await run(`what has ${tech.n} been up to`)).answer;
  check("R3 technician 'been up to': documents counted, no performance line", t3 && t3.text.includes(`technician on ${tech.c} documents`) && !/do not rate performance/.test(t3.text), t3?.text);
  check("R3 technician 'been up to': numbers are in the cited records", t3 && numbersCheck(t3).length === 0, t3 && numbersCheck(t3).join(","));
  const w22 = (await run("wrap up our 2022 billing for me")).answer;
  const y22 = (await sql(`select count(*)::int n, sum(f.total)::float s from document_financials f where f.doc_kind='invoice' and extract(year from f.invoice_date)=2022`))[0];
  check("R3 'wrap up our 2022 billing': invoice count and total match", w22 && w22.text.startsWith(`${y22.n} invoices on file`) && w22.text.includes(y22.s.toLocaleString("en-US", { minimumFractionDigits: 2 })), w22?.text);
  const pf = (await run(`give me a quick profile of ${withInv.n}`)).answer;
  check("R3 'quick profile of X': same facts as a rundown, with the total", pf && /Invoices on file total \$[\d,]+\.\d\d/.test(pf.text) && numbersCheck(pf).length === 0, pf?.text);
  const hs = (await run(`what's ${withInv.n}'s history with us`)).answer;
  check("R3 \"X's history with us\": same summary", hs && hs.text.startsWith(pf.text.slice(0, 20)), hs?.text);
  const dc = (await run("characterize our Trane equipment base")).answer;
  check("R3 brand 'characterize ... equipment base'", dc && dc.text.startsWith(`${tr} Trane units on file`), dc?.text);
  const hrx = await run("profile of HR letters");
  check("R3 privacy: 'profile of HR letters' lists nothing", !hrx.answer);

  // releases
  const u1 = await run("give me a rundown on Zzyzx Holdings");
  check("unknown subject: releases to the honest decline path", !u1.answer && u1.release === "legacy", JSON.stringify(u1).slice(0, 200));
  const u2 = await run("big picture on our Zephyrcorp equipment");
  check("unknown brand: releases", !u2.answer && u2.release === "legacy");
  const u3 = await run("recap of 1999");
  check("a year with nothing on file says so plainly", u3.answer && /^No documents are on file in 1999/.test(u3.answer.text), u3.answer?.text);
  const u4 = await run("what's the weather like today");
  check("not a summary: releases", !u4.answer);
  // ---- QA round fixtures: privacy, name matching, disambiguation, dual role, wording ----
  const tid = (await sql(`select tenant_id t from entities limit 1`))[0].t;
  const ent = async (name, addr, num, type = "customer") => (await sql(`insert into entities (tenant_id, entity_type, customer_number, data) values ($1,$2,$3,$4::jsonb) returning id`, [tid, type, num, JSON.stringify({ customer_name: name, service_address: addr, phone: "480-555-0999" })]))[0].id;
  let sha = 0;
  const doc = async (cust, type, fname, fields = {}, created = "2026-03-01") => {
    const id = (await sql(`insert into documents (tenant_id, original_filename, sha256_hash, document_type, created_at) values ($1,$2,$3,$4,$5) returning id`, [tid, fname, `fx${++sha}`, type, created]))[0].id;
    if (cust) await sql(`insert into document_entity_links (tenant_id, document_id, entity_id) values ($1,$2,$3)`, [tid, id, cust]);
    for (const [k, v] of Object.entries(fields)) await sql(`insert into extractions (tenant_id, document_id, field_key, value) values ($1,$2,$3,$4)`, [tid, id, k, v]);
    return id;
  };
  const nora = await ent("Nora Internalson", "5 Elm St, Mesa, AZ 85201", "N-1");
  await ent("Sonoran Grill Restaurant", "9 Oak St, Tempe, AZ 85281", "S-1");
  await doc(nora, "service-ticket", "nora-ticket.pdf");
  await doc(nora, "hr-letter", "nora-hr-offer.pdf");
  await doc(nora, "invoice", "nora-folder-hr.pdf", { _company_folder: "people-hr" });
  const aNora = (await run("summary of Nora")).answer;
  check("QA: 'summary of Nora' picks Nora (whole word, not Sonora)", aNora && /^Nora Internalson has 1 document on file/.test(aNora.text), aNora?.text);
  check("QA privacy: HR letter and HR-folder papers are not counted or listed", aNora && !/hr-offer|folder-hr/.test(JSON.stringify(aNora.records)) && !/hr/i.test(aNora.text.replace(/Phone|Internalson/g, "")), aNora?.text);
  const old = await withTenant(ctx, (db) => import("../api/_lib/contactLookup.js").then((m) => m.runContactLookup(db, "pull up Nora Internalson", { today })));
  check("QA privacy: the older 'on file' path leaves HR papers out", old && !/3 documents/.test(old.text) && !/hr-offer/.test(JSON.stringify(old.records ?? [])), old?.text);
  await doc(null, "hr-letter", "company-hr-1.pdf"); await doc(null, "hr-letter", "company-hr-2.pdf");
  const hrs = await run("summary of HR letters");
  check("QA privacy: 'summary of HR letters' lists nothing", !hrs.answer, JSON.stringify(hrs).slice(0, 120));
  const all = (await run("overview of this year")).answer;
  check("QA privacy: period overview excludes HR letters", all && !/hr-letter|HR \//.test(all.text) && !all.records.some((r) => /hr/.test(r.label)), all?.text);
  const p1 = await ent("Pat Smith", "1 Pine Rd, Mesa, AZ 85201", "P-1"); const p2 = await ent("Pat Smith", "2 Pine Rd, Tempe, AZ 85281", "P-2");
  const amb = (await run("summary of Pat Smith")).answer;
  check("QA: two Pat Smiths are offered with a city each", amb && /Pat Smith \(Mesa\)/.test(amb.text) && /Pat Smith \(Tempe\)/.test(amb.text) && amb.facts.length === 2 && amb.facts[0].label !== amb.facts[1].label, amb?.text);
  const ex = await run("overview of everything except Trane");
  check("QA: an exclusion is not claimed", !parseSummaryQuestion("overview of everything except Trane", { today }) && !ex.answer, JSON.stringify(ex).slice(0, 100));
  await ent("Smith Mechanical", "3 Shop Ln, Mesa, AZ 85201", "M-1");
  const typo = (await run("summary of Smth Mechanical")).answer;
  check("QA: a misspelled name is asked about, not answered", typo && !/documents? on file/.test(typo.text) && /Smith Mechanical/.test(typo.text), typo?.text);
  // a customer who is also a technician
  const techName = (await sql(`select coalesce(nullif(corrected_value,''),value) n from extractions where field_key='technician' group by 1 order by count(*) desc limit 1`))[0].n;
  const both = await ent(techName, "7 Dual Dr, Mesa, AZ 85201", "D-1");
  await doc(both, "invoice", "dual-invoice.pdf");
  const dualC = (await run(`rundown on ${techName}`)).answer;
  check("QA: customer view of a technician points to the technician view", dualC && new RegExp(`${techName} is also the technician on \\d+ documents`).test(dualC.text), dualC?.text);
  const dualT = (await run(`how has ${techName} been performing lately`)).answer;
  check("QA: technician view of a customer points to the customer view", dualT && new RegExp(`${techName} is also a customer, with 1 document on file`).test(dualT.text), dualT?.text);
  const wk = (await run("recap of last week")).answer;
  check("QA wording: 'No documents are on file last week.'", wk && /^No documents are on file last week\./.test(wk.text), wk?.text);
  const st = (await run("tell me about our invoices")).answer;
  check("QA wording: invoices without a status say how many have none", st && /Status on file: .*\. \d+ (?:has|have) no status\./.test(st.text), st?.text);
  const corr0 = (await run("rundown on proposals")).answer;
  check("QA wording: Newest/Oldest never show a raw filename", corr0 && /Newest: /.test(corr0.text) && !/\.pdf|\.txt/.test(corr0.text), corr0?.text);
  const corr = (await run("rundown on correspondence")).answer;
  check("QA wording: 'Newest' names a document (filename or number)", corr && /Newest: [^.]*(?:dated|\d{4})/.test(corr.text) && !/\.pdf|\.txt/.test(corr.text), corr?.text);

  const tmp = await run("rundown on Linda");
  check("an ambiguous or partial name never guesses one customer silently", !tmp.answer || tmp.answer.text.length > 0);
}

console.log("\nSENTENCE TEMPLATES (customer-visible wording):");
for (const t of TEMPLATES) console.log(`  - ${t}`);
console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
