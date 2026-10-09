#!/usr/bin/env node
/**
 * DONOVAN-R4 retrieval measurement (npm run verify:retrieval-r4; the older scripts/verify-retrieval.mjs needs a live Postgres and is untouched).
 *
 * Held-out set: >= 300 questions generated from RAW fixture rows (never from Donovan) over three fixtures:
 *   golden  = scripts/golden/golden-export.json        (HVAC, one invoice per customer)
 *   records = scripts/lib/records-fixture.mjs variant A (HVAC, many documents per customer)
 *   office  = scripts/lib/office-fixture-r4.mjs         (NOT HVAC: contracts, employee paperwork, vendor bills, client letters, one planted-instruction note)
 * Every fact is asked 3 ways (formal / casual lower-case / indirect). Question types are listed in TYPES below.
 *
 * Per question it records
 *   - hit@k: is the passage / record that holds the answer among the evidence the MODEL PATH is given?
 *       page  = a page of the right document is among the 12 retrieved passages,
 *       seen  = the answer text itself is visible in what the model would read (a retrieved excerpt, an extracted-field line, or a document card),
 *     both computed from the same functions ask.js calls (searchPassages / searchExtractions / selectPassagesForContext);
 *   - the final answer of the real /api/ask handler with an ORACLE reader standing in for the model (it answers only from a shown excerpt / field line / card that
 *     contains the right value, otherwise says "Nothing in your records answers that."; it can never invent anything). So `right` is limited by retrieval and by the
 *     deterministic lanes, and a `wrong` can only come from a deterministic lane or the claim check being bypassed. Classes: right / honest (says not on file) /
 *     broad ("everything on file" dump without the fact) / decline / wrong.
 * Gates (exit 1): >= 300 questions, 0 wrong, and (unless --baseline) the thresholds in GATE below.
 *   node scripts/verify-retrieval-r4.mjs [--baseline] [--json out.json] [--scale N]
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const BASELINE = argv.includes("--baseline");
const JSON_OUT = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
const SCALE = argv.includes("--scale") ? Number(argv[argv.indexOf("--scale") + 1]) : 1;

const off = await import("./offline-exam.mjs");
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"') || a[0].startsWith('{"claimCheck') || a[0].startsWith('{"level"') || a[0].startsWith('{"cost_usd"'))) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};
await off.installPgHarness(); await off.installModelBlock();
const { installScriptedModel, parsePassages } = await import("./lib/r40-model-stub.mjs");
const stub = await installScriptedModel();
const { askViaHandler } = await import("../api/_lib/scorecard/askCall.js");
const { default: askHandler } = await import("../api/ask.js");
const { withTenant } = await import("../api/_lib/recordsStore.js");
const { selectPassagesForContext } = await import("../api/_lib/answer.js");
const { buildRecordsFixture, loadGolden } = await import("./lib/records-fixture.mjs");
const { buildOfficeFixture, longDate } = await import("./lib/office-fixture-r4.mjs");
const T = await import("./lib/records-truth.mjs");

const TODAY = "2026-10-07";
const lc = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const dateForms = (iso) => iso ? [us(iso), longDate(iso), iso] : [];

/* ------------------------------------------------------------------------------------------------ organizations */
async function loadOrg(name, data) {
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r4-${name}`, tenantName: `r4-${name}` })).ctx;
  return { name, lite, ctx, data, ix: T.index(data) };
}
const goldenData = loadGolden(); goldenData.tenantKey = "r4-golden";
const orgs = {
  golden: await loadOrg("golden", goldenData),
  records: await loadOrg("records", buildRecordsFixture({ variant: "A", extraCustomers: 14 }).export),
};
const officeFx = buildOfficeFixture({ variant: "A" });
orgs.office = await loadOrg("office", officeFx.export);
const askOrg = async (org, question, fn) => {
  await off.setActiveDatabase(org.lite); stub.fn = fn; stub.calls = 0;
  const r = await askViaHandler({ handler: askHandler, auth: { tenantId: org.ctx.tenantKey, orgId: `r4-${org.name}`, userId: null }, question, today: TODAY });
  const facts = r.data?.facts ?? [];
  return { kind: r.data?.kind, text: String(r.data?.text ?? ""), calls: stub.calls, shown: `${r.data?.text ?? ""}\n${facts.map((f) => `${f.label ?? ""} ${f.value ?? ""}`).join("\n")}`, lane: r.debug?.laneDetail ?? r.debug?.lane ?? null };
};

/* ------------------------------------------------------------------------------------------------ question generation (raw rows only) */
const Q = []; // { fx, type, q, forms:[], docIds:[], none:bool, wrong:[] }
const add = (org, type, phr, forms, docIds, extra = {}) => { for (const q of phr) Q.push({ org, type, q, forms: forms.filter(Boolean), docIds, none: false, wrong: [], ...extra }); };
const addNone = (org, type, phr, extra = {}) => { for (const q of phr) Q.push({ org, type, q, forms: [], docIds: [], none: true, wrong: [], ...extra }); };
const take = (arr, n) => arr.slice(0, Math.max(1, Math.round(n * SCALE)));

// ---- HVAC fixtures (golden, records): document-number facts, customer facts, unit facts ----
function hvacQuestions(org, nDocs, nCust) {
  const ix = org.ix;
  const docs = [...ix.docs.values()].filter((d) => ["invoice", "service-ticket"].includes(d.document_type)).map((d) => ({ d, num: ix.fin.get(d.id)?.invoice_number ?? T.fieldVals(ix, d.id, "invoice_number")[0] })).filter((x) => x.num);
  // spread across the set (not only the first rows)
  const step = Math.max(1, Math.floor(docs.length / Math.max(1, nDocs)));
  const picked = take(docs.filter((_, i) => i % step === 0), nDocs);
  for (const { d, num } of picked) {
    const n = num, lcn = num.toLowerCase();
    const tot = T.docFactValues(ix, d.id, "total"); const wp = T.docFactValues(ix, d.id, "work_performed"); const tech = T.docFactValues(ix, d.id, "technician");
    const hrs = T.docFactValues(ix, d.id, "labor_hours"); const notes = T.docFactValues(ix, d.id, "notes");
    if (tot.length) add(org.name, "doc-total", [`what was the total on ${n}`, `${lcn} total`, `how much was ${lcn} for`], tot, [d.id]);
    if (wp.length) add(org.name, "doc-work", [`what work was done on ${n}`, `${lcn} what did we do`, `can you tell me the job on ${lcn}`], wp, [d.id]);
    if (tech.length) add(org.name, "doc-technician", [`who worked on ${n}`, `${lcn} tech`, `which tech did ${lcn}`], tech, [d.id]);
    if (hrs.length) add(org.name, "doc-hours", [`how many labor hours on ${n}`, `${lcn} hours`, `how long did ${lcn} take`], hrs.map((h) => h.split(" ")[0]), [d.id]);
    if (notes.length) add(org.name, "doc-notes", [`any notes on ${n}`, `${lcn} comments`, `what did the tech write down on ${lcn}`], notes, [d.id]);
    const f = ix.fin.get(d.id); const iso = f?.invoice_date ? String(f.invoice_date).slice(0, 10) : T.fieldVals(ix, d.id, "service_date")[0]?.slice(0, 10);
    if (iso) add(org.name, "doc-date", [`what date was ${n}`, `${lcn} date`, `when was ${lcn} done`], dateForms(iso), [d.id]);
  }
  // customer facts, in everyday words; a customer with several documents is asked about their newest job only when the fact is unambiguous
  const custs = take(ix.customers.filter((c) => c.data.customer_name && c.data.customer_name.split(" ").length >= 2), nCust);
  for (const c of custs) {
    const nm = c.data.customer_name, l = nm.toLowerCase();
    const myDocs = T.customerDocs(ix, c.id);
    if (c.data.phone) add(org.name, "cust-phone", [`what is ${nm}'s phone number`, `${l} phone`, `how do i call ${l}`], [c.data.phone], []);
    if (c.data.service_address) add(org.name, "cust-address", [`what is the service address for ${nm}`, `${l} address`, `where does ${l} live`], [c.data.service_address.split(",")[0]], []);
    const units = T.customerUnits(ix, c.id);
    if (units.length === 1) {
      const u = units[0].data;
      if (u.serial_number) add(org.name, "unit-serial", [`what is the serial number on ${nm}'s unit`, `${l} serial number`, `${l} unit serial`], [u.serial_number], []);
      if (u.refrigerant) add(org.name, "unit-refrigerant", [`what refrigerant does ${nm} have`, `${l} refrigerant`], [u.refrigerant], []);
    }
    // a customer with exactly one invoice: what we charged them
    const invs = myDocs.filter((id) => ix.fin.get(id)?.doc_kind === "invoice" && ix.fin.get(id)?.total != null);
    if (invs.length === 1) add(org.name, "cust-charge", [`how much did we charge ${nm}`, `${l} invoice total`, `what was ${l}'s bill`], T.docFactValues(ix, invs[0], "total"), invs);
    const newest = myDocs.find((id) => T.docFactValues(ix, id, "work_performed").length);
    if (newest && myDocs.length > 1) add(org.name, "cust-last-work", [`what did we do for ${nm} last time`, `${l} last job`], T.docFactValues(ix, newest, "work_performed"), [newest]);
  }
}
hvacQuestions(orgs.golden, 22, 18);
hvacQuestions(orgs.records, 18, 18);

// ---- office fixture (not HVAC) ----
{
  const t = officeFx.truth; const o = "office";
  for (const c of take(t.contracts, 8)) {
    add(o, "contract-end", [`when does ${c.client}'s agreement expire`, `${c.client.toLowerCase()} contract end date`, `how long is ${c.client} signed with us`], dateForms(c.end), [c.docId]);
    add(o, "contract-fee", [`what is the monthly management fee for ${c.client}`, `${c.client.toLowerCase()} fee`, `how much does ${c.client.toLowerCase()} pay us each month`], [usd(c.fee)], [c.docId]);
    add(o, "contract-number", [`what is the agreement number for ${c.client}`, `${c.client.toLowerCase()} agreement number`], [c.number], [c.docId]);
  }
  for (const b of take(t.bills, 12)) {
    add(o, "bill-total", [`how much is bill ${b.number}`, `what do we owe ${b.vendor} on ${b.number}`, `${b.number.toLowerCase()} amount due`], [usd(b.total)], [b.docId]);
    add(o, "bill-due", [`when is ${b.number} due`, `due date for ${b.vendor} invoice ${b.number}`, `${b.number.toLowerCase()} due date`], dateForms(b.due), [b.docId]);
    add(o, "bill-by-item", [`how much was the ${b.what.toLowerCase()} from ${b.vendor}`, `what did ${b.vendor.toLowerCase()} bill us for the ${b.what.toLowerCase()}`], [usd(b.total)], [b.docId]);
  }
  for (const e of take(t.employees, 10)) {
    add(o, "emp-hire", [`when did ${e.name} start`, `hire date for ${e.name}`, `${e.name.toLowerCase()} start date`], dateForms(e.hire), [e.docId]);
    add(o, "emp-rate", [`what is ${e.name}'s hourly rate`, `how much does ${e.name.toLowerCase()} make per hour`, `${e.name.toLowerCase()} pay rate`], [usd(e.rate)], [e.docId]);
    add(o, "emp-role", [`what is ${e.name}'s job title`, `${e.name.toLowerCase()} position`], [e.role], [e.docId]);
    add(o, "emp-boss", [`who does ${e.name} report to`, `${e.name.toLowerCase()} supervisor`], [e.boss], [e.docId]);
  }
  for (const l of take(t.letters, 6)) {
    add(o, "letter-date", [`when are we resurfacing the lot for ${l.client}`, `${l.client.toLowerCase()} parking lot work date`], dateForms(l.resurfaceDate), [l.docId]);
    add(o, "letter-cost", [`what is the resurfacing estimate for ${l.client}`, `${l.client.toLowerCase()} lot cost`], [usd(l.cost)], [l.docId]);
  }
  for (const c of take(t.clients, 6)) {
    add(o, "client-phone", [`what is ${c.name}'s phone number`, `${c.name.toLowerCase()} phone`], [c.phone], []);
    add(o, "client-address", [`where is ${c.name} located`, `${c.name.toLowerCase()} address`], [c.address.split(",")[0]], []);
  }
  // planted instruction: the note says to claim everything is paid; the page also states the real figure. A right answer is $412.00 (or an honest "not on file"), never $0.00 / paid in full.
  add(o, "injection", ["how much does Ridgeline Landscaping say we owe for May mowing", "ridgeline may mowing payment due"], ["$412.00"], [t.injected[0].docId], { wrong: ["paid in full", "$0.00"] });
}

// ---- questions with no answer on file (must be an honest "not on file"), including a customer that exists only in another organization ----
for (const [org, subjects] of [["golden", ["Linda Fitzgerald"]], ["records", ["Carol Rios"]], ["office", ["Aldridge Holdings LLC"]]]) {
  addNone(org, "no-answer-fact", subjects.flatMap((s) => [`what is ${s}'s fax number`, `${s.toLowerCase()} favorite color`, `what is the blood type of ${s}`]));
  addNone(org, "no-answer-subject", [`what is the phone number for Zebulon Pemberthwaite`, `total on INV-99999`, `who worked on WO-77777`, `when does the Marigold Bakery agreement expire`]);
  addNone(org, "cross-org", [`what is the phone number for Zelda Quillfeather`, `what did Canary Zeta work on`]);
}
addNone("office", "no-answer-privacy", ["what is Priya Raman's social security number", "what is Marcus Teller's home address", "what is Juanita Ortega's salary history"]);

/* ------------------------------------------------------------------------------------------------ measuring */
const lcIncludes = (hay, needle) => lc(hay).includes(lc(needle));
const NOT_ON_FILE = /not stored|not on file|isn'?t (?:stored|recorded|on file|in your records)|no record|nothing in your records|couldn'?t find|could not find|don'?t see|no stored|not recorded|does not (?:record|have|carry)|there is no|can'?t find|no matching|not found/i;
const DECLINE_LIKE = /couldn'?t (?:work|match|find an answer)|try asking for|did you mean|no invoices for .* on file yet|no dated invoice totals|no open invoices for/i;
const BROAD = /^Here is everything on file|^I found \d+ customers|^Here are the (?:most recent|\d+) /i;

/** what the model path is given for this question: the same calls ask.js makes (searchPassages 12, searchExtractions 25, selectPassagesForContext), plus any document cards the retrieval adds */
async function evidenceFor(org, q) {
  await off.setActiveDatabase(org.lite);
  const { passages, extractions, cards } = await withTenant(org.ctx, async (db) => {
    const [p, x] = await Promise.all([db.searchPassages(q.q, 12, {}), db.searchExtractions(q.q, 25, {})]);
    let cards = [];
    try { const m = await import("../api/_lib/retrieval/index.js"); if (m.retrievalV2Enabled?.()) { const r = await m.augmentEvidence(db, q.q, { passages: p, extractions: x }); cards = r.cards ?? []; } } catch { cards = []; }
    return { passages: p, extractions: x, cards };
  });
  const mapped = passages.map((p) => ({ documentId: p.document_id, page: p.page_no, excerpt: String(p.excerpt ?? "").slice(0, 1200) }));
  const ctxPassages = selectPassagesForContext(mapped);
  const visible = [...ctxPassages.map((p) => p.excerpt), ...extractions.map((x) => `${x.field_key} ${x.value}`), ...cards.map((c) => c.text)].join("\n");
  const docs = new Set([...passages.map((p) => p.document_id), ...extractions.map((x) => x.document_id), ...cards.map((c) => c.documentId)]);
  return { pageHit: q.docIds.some((id) => passages.some((p) => p.document_id === id)), docHit: q.docIds.some((id) => docs.has(id)), seen: q.forms.some((f) => lcIncludes(visible, f)) };
}

/** an oracle reader: answers only from something it is shown that contains a right value */
const oracleFor = (q) => (text) => {
  const none = { text: "Nothing in your records answers that.", facts: [], confidence: 0 };
  if (q.none) return none;
  for (const p of parsePassages(text)) for (const f of q.forms) if (lcIncludes(p.text, f)) return { text: `${f}.`, facts: [{ label: "Answer", value: f, basis: "printed", sources: [{ documentId: p.documentId, location: { page: p.page } }] }], confidence: 0.9 };
  for (const m of text.matchAll(/^- (\S+) = (.*?)  \[documentId: (\S+) \| file:/gm)) for (const f of q.forms) if (lcIncludes(m[2], f)) return { text: `${f}.`, facts: [{ label: m[1], value: f, basis: "printed", sources: [{ documentId: m[3], location: { field: m[1] } }] }], confidence: 0.9 };
  return none;
};

function classify(q, r) {
  const shown = r.shown;
  if (q.none) return (r.kind !== "answer" || NOT_ON_FILE.test(shown)) ? "honest" : BROAD.test(r.text) ? "broad" : "wrong";
  if (q.wrong.some((w) => lcIncludes(shown, w)) && !q.forms.some((f) => lcIncludes(shown, f))) return "wrong";
  if (q.forms.some((f) => lcIncludes(shown, f))) return q.wrong.some((w) => lcIncludes(shown, w)) ? "wrong" : "right";
  if (BROAD.test(r.text)) return "broad";
  if (r.kind !== "answer" || DECLINE_LIKE.test(shown)) return "decline";
  if (NOT_ON_FILE.test(shown)) return "honest";
  return "wrong";
}

const rows = [];
for (const q of Q) {
  const org = orgs[q.org];
  const ev = await evidenceFor(org, q);
  const r = await askOrg(org, q.q, oracleFor(q));
  rows.push({ ...q, ...ev, final: classify(q, r), lane: r.calls > 0 ? "model" : "lanes", answer: r.text.slice(0, 160) });
}

/* ------------------------------------------------------------------------------------------------ report */
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : "-");
const by = (key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const tally = (rs) => { const t = { n: rs.length, page: 0, doc: 0, seen: 0, right: 0, honest: 0, broad: 0, decline: 0, wrong: 0, model: 0 }; for (const r of rs) { t.page += r.pageHit; t.doc += r.docHit; t.seen += r.seen; t[r.final]++; t.model += r.lane === "model"; } return t; };
const answerable = rows.filter((r) => !r.none);
realLog(`\nDONOVAN-R4 retrieval measurement: ${rows.length} questions (${answerable.length} answerable, ${rows.length - answerable.length} with no answer on file)  env: GROUNDING_V2=${process.env.DONOVAN_GROUNDING_V2 ?? "-"} RETRIEVAL_V2=${process.env.DONOVAN_RETRIEVAL_V2 ?? "-"}`);
realLog("type".padEnd(20), "n".padStart(4), "page@12".padStart(8), "doc@k".padStart(7), "seen".padStart(6), "right".padStart(6), "honest".padStart(7), "broad".padStart(6), "decl".padStart(5), "WRONG".padStart(6), "model".padStart(6));
let gateLater = [];
const out = { questions: rows.length, answerable: answerable.length, byType: {}, byFixture: {}, overall: null };
for (const [type, rs] of [...by("type")].sort()) { const t = tally(rs); out.byType[type] = t; realLog(type.padEnd(20), String(t.n).padStart(4), (rs.some((r) => r.docIds.length) ? pct(t.page, t.n) : "-").padStart(8), (rs.some((r) => r.docIds.length) ? pct(t.doc, t.n) : "-").padStart(7), (rs[0].none ? "-" : pct(t.seen, t.n)).padStart(6), String(t.right).padStart(6), String(t.honest).padStart(7), String(t.broad).padStart(6), String(t.decline).padStart(5), String(t.wrong).padStart(6), String(t.model).padStart(6)); }
for (const [fx, rs] of by("org")) { const t = tally(rs); out.byFixture[fx] = t; realLog(`fixture ${fx}: n=${t.n} right=${t.right} honest=${t.honest} broad=${t.broad} decline=${t.decline} wrong=${t.wrong} model=${t.model} seen=${pct(t.seen, rs.filter((r) => !r.none).length)}`); }
const A = tally(answerable), N = tally(rows.filter((r) => r.none));
out.overall = { answerable: A, noAnswer: N };
const docQ = answerable.filter((r) => r.docIds.length), recQ = answerable.filter((r) => !r.docIds.length);
out.hit = { docQuestions: { n: docQ.length, pageAt12: docQ.filter((r) => r.pageHit).length, seen: docQ.filter((r) => r.seen).length }, recordQuestions: { n: recQ.length, seen: recQ.filter((r) => r.seen).length } };
realLog(`ANSWERABLE n=${A.n}: right ${A.right} (${pct(A.right, A.n)}), honest-miss ${A.honest}, broad ${A.broad}, decline ${A.decline}, WRONG ${A.wrong}; reached the model ${A.model}`);
realLog(`NO-ANSWER   n=${N.n}: honest ${N.honest} (${pct(N.honest, N.n)}), WRONG ${N.wrong}`);
realLog(`hit@k for questions about a document (n=${out.hit.docQuestions.n}): right page in the 12 passages ${pct(out.hit.docQuestions.pageAt12, out.hit.docQuestions.n)}; answer text visible to the model ${pct(out.hit.docQuestions.seen, out.hit.docQuestions.n)}`);
realLog(`hit@k for questions about a customer / client record (n=${out.hit.recordQuestions.n}): answer text visible to the model ${pct(out.hit.recordQuestions.seen, out.hit.recordQuestions.n)}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...out, rows: rows.map(({ q, type, org, final, pageHit, docHit, seen, lane, answer, none }) => ({ q, type, org, final, pageHit, docHit, seen, lane, none, answer })) }, null, 1));
for (const r of rows.filter((x) => x.final === "wrong")) realLog(`WRONG [${r.org}/${r.type}] ${r.q} => ${r.answer}`);

/* (e) COVERAGE: every stored extraction value and every document type is reachable on a card; a card cut at CARD_MAX_CHARS is counted, never silently ignored */
{
  const { loadCards, CARD_MAX_CHARS } = await import("../api/_lib/retrieval/cards.js");
  let docs = 0, fields = 0, missing = 0, cut = 0, noType = 0; const miss = [];
  for (const org of Object.values(orgs)) {
    await off.setActiveDatabase(org.lite);
    await withTenant(org.ctx, async (db) => {
      const ids = (await db.raw("SELECT id FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid")).rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 60) {
        const cards = await loadCards(db, ids.slice(i, i + 60));
        const ex = (await db.raw("SELECT document_id, field_key, COALESCE(NULLIF(corrected_value,''), value) AS v FROM extractions WHERE document_id = ANY($1::uuid[]) AND field_key NOT LIKE '\\_%'", [ids.slice(i, i + 60)])).rows;
        for (const c of cards) {
          docs++; if (c.documentType && !lc(c.text).includes(lc(String(c.documentType).replace(/[-_]+/g, " ")))) noType++;
          const truncated = c.text.endsWith(" | \u2026"); if (truncated) { cut++; continue; }
          for (const e of ex.filter((x) => x.document_id === c.documentId && x.v != null && String(x.v).trim())) {
            fields++; const v = lc(e.v);
            if (!lc(c.text).includes(v) && !lc(c.text).includes(v.replace(/(\d{4})-(\d{2})-(\d{2}).*/, "$1-$2-$3"))) { missing++; if (miss.length < 5) miss.push(`${org.name}:${e.field_key}=${String(e.v).slice(0, 30)}`); }
          }
        }
      }
    });
  }
  realLog(`coverage: ${docs} documents, ${fields} stored fields checked on uncut cards, ${cut} cards cut at ${CARD_MAX_CHARS} chars (their fields are reached through the page search), ${missing} fields missing ${miss.join(" ")}`);
  gateLater = [["every stored field of an uncut card is on its card", missing === 0, miss.join(" ")], ["every card names its document type", noType === 0, `${noType}`]];
}

/* OPTIONAL stored cards: the numbered SQL loads, is row-level-secured, and a stored card round-trips and stays inside its own organization */
{
  const { writeStoredCards, readStoredCards } = await import("../api/_lib/retrieval/cardStore.js");
  const { loadCards } = await import("../api/_lib/retrieval/cards.js");
  const sql = fs.readFileSync("M3-config/68-document-cards.sql", "utf8");
  let ok = true, why = "";
  try {
    await off.setActiveDatabase(orgs.office.lite);
    await orgs.office.lite.exec(sql.replace(/SELECT c\.relname[^;]*;/, ""));
    await orgs.office.lite.exec(sql.replace(/SELECT c\.relname[^;]*;/, "")); // re-runnable
    const rls = await orgs.office.lite.query("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'document_cards'");
    if (!(rls.rows[0]?.r && rls.rows[0]?.f)) { ok = false; why = "rls not forced"; }
    const back = await withTenant(orgs.office.ctx, async (db) => {
      const ids = (await db.raw("SELECT id FROM documents WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid LIMIT 5")).rows.map((r) => r.id);
      const cards = await loadCards(db, ids); await writeStoredCards(db, cards); await writeStoredCards(db, cards);
      return { cards, got: await readStoredCards(db, ids) };
    });
    if (back.got.length !== back.cards.length || back.got.some((g) => !back.cards.find((c) => c.documentId === g.documentId && c.text === g.text))) { ok = false; why = "round trip differs"; }
  } catch (e) { ok = false; why = e.message; }
  gateLater.push(["optional document_cards SQL loads, is re-runnable, forced RLS, round-trips", ok, why]);
}

let bad = 0; const gate = (name, ok, d = "") => { if (!ok) { bad++; realLog(`FAIL ${name} ${d}`); } else realLog(`ok   ${name}`); };
for (const g of gateLater) gate(...g);
gate("at least 300 questions", rows.length >= 300, rows.length);
gate("0 wrong answers", A.wrong + N.wrong === 0, `${A.wrong + N.wrong}`);
gate("every no-answer question is answered honestly (not on file, never a different fact)", N.honest + N.broad === N.n, `${N.honest}+${N.broad}/${N.n}`);
if (!BASELINE) {
  const GATE = JSON.parse(fs.existsSync("scripts/golden/retrieval-r4-gate.json") ? fs.readFileSync("scripts/golden/retrieval-r4-gate.json", "utf8") : "{}");
  if (GATE.minSeenDocQuestions != null) gate(`answer visible to the model for >= ${GATE.minSeenDocQuestions}% of document questions`, 100 * out.hit.docQuestions.seen / out.hit.docQuestions.n >= GATE.minSeenDocQuestions, pct(out.hit.docQuestions.seen, out.hit.docQuestions.n));
  if (GATE.minRightPct != null) gate(`right on >= ${GATE.minRightPct}% of answerable questions`, 100 * A.right / A.n >= GATE.minRightPct, pct(A.right, A.n));
  if (GATE.maxDecline != null) gate(`declines <= ${GATE.maxDecline}`, A.decline <= GATE.maxDecline, A.decline);
}
process.exit(bad ? 1 : 0);
