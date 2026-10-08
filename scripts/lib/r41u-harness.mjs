// R41U shared harness: a real-pipeline (api/ask.js model path) tenant loaded from fresh fixture documents, with the model replaced by a scripted stub.
// Truth is computed from the raw fixture rows (r41u-fixture.mjs), never from Donovan.
import * as F from "./r40-fixture.mjs";
import { installScriptedModel } from "./r40-model-stub.mjs";

export async function makeHarness({ off, tenantKey, docs, today = "2026-10-07" }) {
  const stub = await installScriptedModel();
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const gate = await import("../../api/_lib/grounding/gate.js");
  const base = F.loadGolden();
  const d = JSON.parse(JSON.stringify(base)); d.tenantKey = tenantKey; d.tenantName = tenantKey;
  d.financials = []; d.financial_lines = []; d.documents = []; d.pages = []; d.extractions = []; d.document_entity_links = []; d.entities = [];
  const ids = {};
  for (const [k, o] of Object.entries(docs)) {
    const cid = o.customer ? F.addCustomer(d, o.customer, o.addr || "1 Test St, Mesa, AZ 85201") : null;
    const r = F.addInvoice(d, { num: o.num, customer: o.customer, customerId: cid, dateIso: o.iso, dateUs: o.iso, addr: o.addr || "n/a", desc: "work", total: o.total ?? null, text: o.text, kind: o.kind, filename: o.file });
    ids[k] = r.did;
    if (o.docType) { const dr = d.documents.find((x) => x.id === r.did); if (dr) dr.document_type = o.docType; } // optional: a document typed as something other than an invoice (a purchase order is uploaded as a purchase-order)
    if (o.direction || o.vendorName) { const fr = d.financials.find((x) => x.document_id === r.did); if (o.direction) fr.direction = o.direction; if (o.vendorName) fr.vendor_name = o.vendorName; }
  }
  const ctx = (await off.loadExportIntoNewTenant(lite, d, { tenantKey: `offline:${tenantKey}`, tenantName: tenantKey })).ctx;
  const lats = [];
  async function ask(question, fn) {
    await off.setActiveDatabase(lite); // several harnesses (one database each) can live in one run
    stub.fn = fn; stub.calls = 0;
    const t = Date.now();
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: tenantKey, userId: null }, question, today });
    lats.push(Date.now() - t);
    return { error: r.error, data: r.data, kind: r.data?.kind, text: String(r.data?.text ?? ""), facts: r.data?.facts ?? [], calls: stub.calls };
  }
  /** everything a user would read out of an answer (text, every card incl. any extra field, interpretation) */
  const shown = (r) => `${r.text}\n${r.facts.map((f) => Object.entries(f).filter(([k]) => k !== "sources" && k !== "basis" && k !== "modelBasis").map(([, v]) => (typeof v === "string" ? v : "")).join(" | ")).join("\n")}\n${r.data?.interpretation ?? ""}`;
  /** evidence map (as loadGroundingEvidence builds it) straight from the fixture, for gate-level (agent-mode) cases */
  const evidence = () => { const ev = new Map(); for (const [k, o] of Object.entries(docs)) ev.set(ids[k], { pages: new Map([[1, o.text]]), rows: `invoice_number: ${o.num}\n${o.customer ? `customer_name: ${o.customer}\n` : ""}${o.total != null ? `total: ${o.total}\n` : ""}`, label: o.file, ...(o.total != null ? { totalNum: String(Number(o.total)) } : {}) }); return ev; };
  return { ask, shown, ids, gate, lats, evidence, stub };
}
