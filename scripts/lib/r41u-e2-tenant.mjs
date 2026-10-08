// E2 helper: load a (modified) golden-style export into its own PGlite tenant and ask the REAL /api/ask handler (model blocked, so every answer is deterministic).
import * as F from "./r40-fixture.mjs";
export async function loadTenant(off, data, { key, today = "2026-09-25" }) {
  const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
  const { askViaHandler } = await import("../../api/_lib/scorecard/askCall.js");
  const { default: askHandler } = await import("../../api/ask.js");
  const d = JSON.parse(JSON.stringify(data)); d.tenantKey = key; d.tenantName = key;
  const ctx = (await off.loadExportIntoNewTenant(lite, d, { tenantKey: `offline:${key}`, tenantName: key })).ctx;
  const ask = async (question, onToday = today) => {
    await off.setActiveDatabase(lite);
    const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: key, userId: null }, question, today: onToday });
    const facts = r.data?.facts ?? [];
    return { data: r.data, kind: r.data?.kind, text: String(r.data?.text ?? ""), facts, error: r.error, shown: `${r.data?.text ?? ""}\n${facts.map((f) => `${f.label} ${f.value}`).join("\n")}` };
  };
  return { ask, ctx, lite };
}
export const golden = () => F.loadGolden();
export const cityOf = (a) => (String(a ?? "").match(/,\s*([^,]+),\s*[A-Z]{2}\s*\d{5}/) || [])[1] ?? null;
/** truth from raw rows: units whose customer's service address is in `city`, and those customers */
export function rawUnitsIn(d, city) {
  const cust = d.entities.filter((e) => e.entity_type === "customer" && !e.merged_into);
  const ids = new Set(cust.filter((c) => cityOf(c.data.service_address) === city).map((c) => c.id));
  const eq = d.entities.filter((e) => e.entity_type === "equipment" && !e.merged_into && ids.has(e.customer_id));
  return { units: eq.length, customers: ids.size };
}
export const rawInvoiceDocs = (d) => d.documents.filter((x) => x.document_type === "invoice").length;
export function rawCustomersWithInvoice(d) {
  const inv = new Set(d.documents.filter((x) => x.document_type === "invoice").map((x) => x.id));
  const cust = new Set(d.entities.filter((e) => e.entity_type === "customer" && !e.merged_into).map((e) => e.id));
  return new Set(d.document_entity_links.filter((l) => inv.has(l.document_id) && cust.has(l.entity_id)).map((l) => l.entity_id)).size;
}
