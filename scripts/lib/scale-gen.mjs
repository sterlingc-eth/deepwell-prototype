// R19: scale an export to ~N documents (whole copies of the company, ids re-keyed). Same as /home/claude/work/factory/scale/gen.mjs; used by verify-scale-r19.
const hex4 = (k) => k.toString(16).padStart(4, "0");
const nid = (id, k) => (id == null ? id : hex4(k) + String(id).slice(4));
const ALPHA = (k) => { let s = ""; let n = k; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
export function copiesFor(base, targetDocs) { return Math.max(1, Math.ceil(targetDocs / base.documents.length)); }
export function* scaleChunks(base, copies) {
  for (let k = 0; k < copies; k++) {
    const sfx = k === 0 ? "" : " " + ALPHA(k - 1);
    const out = {
      entities: base.entities.map((e) => ({ ...e, id: nid(e.id, k), customer_id: nid(e.customer_id, k), merged_into: nid(e.merged_into, k), customer_number: e.customer_number && k ? e.customer_number + "-" + hex4(k) : e.customer_number,
        data: k && e.data && e.data.customer_name ? { ...e.data, customer_name: e.data.customer_name + sfx } : e.data })),
      documents: base.documents.map((d) => ({ ...d, id: nid(d.id, k), sha256_hash: d.sha256_hash ? hex4(k) + d.sha256_hash.slice(4) : d.sha256_hash })),
      extractions: base.extractions.map((x) => ({ ...x, id: nid(x.id, k), document_id: nid(x.document_id, k), entity_id: nid(x.entity_id, k), source_facet_id: null })),
      pages: base.pages.map((p) => ({ ...p, id: nid(p.id, k), document_id: nid(p.document_id, k) })),
      document_entity_links: base.document_entity_links.map((l) => ({ ...l, id: nid(l.id, k), document_id: nid(l.document_id, k), entity_id: nid(l.entity_id, k) })),
      financials: base.financials.map((f) => ({ ...f, id: nid(f.id, k), document_id: nid(f.document_id, k) })),
      financial_lines: base.financial_lines.map((l) => ({ ...l, id: nid(l.id, k), financial_id: nid(l.financial_id, k), document_id: nid(l.document_id, k) })),
    };
    yield out;
  }
}
const TABLES = [["entities", "entities"], ["documents", "documents"], ["extractions", "extractions"], ["pages", "document_pages"], ["document_entity_links", "document_entity_links"], ["financials", "document_financials"], ["financial_lines", "document_financial_lines"]];
/** Load a scaled copy into a PGlite tenant, one copy at a time (bounded memory). `off` = scripts/offline-exam.mjs module of the repo. */
export async function loadScaled(off, lite, base, targetDocs, { tenantKey = "scale", tenantName = "scale", repo } = {}) {
  const copies = copiesFor(base, targetDocs);
  const { getTenantContext } = await import("../../api/_lib/recordsStore.js");
  const tenantId = (await getTenantContext("offline:" + tenantKey, tenantName)).id;
  const cols = {};
  for (const [, t] of TABLES) { const { rows } = await lite.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND COALESCE(is_generated,'NEVER')<>'ALWAYS'`, [t]); cols[t] = rows.map((r) => r.column_name); }
  const ins = async (t, rows) => { if (!rows.length) return; const cl = cols[t].map((c) => `"${c}"`).join(","); await lite.query(`INSERT INTO ${t} (${cl}) SELECT ${cl} FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb)`, [JSON.stringify(rows.map((r) => ({ ...r, tenant_id: tenantId })))]); };
  let docs = 0;
  for (const c of scaleChunks(base, copies)) {
    await ins("entities", c.entities.filter((e) => e.entity_type === "customer").map((e) => ({ ...e, customer_id: null, merged_into: null })));
    await ins("entities", c.entities.filter((e) => e.entity_type !== "customer").map((e) => ({ ...e, merged_into: null })));
    await ins("documents", c.documents);
    await ins("extractions", c.extractions);
    await ins("document_pages", c.pages);
    await ins("document_entity_links", c.document_entity_links);
    await ins("document_financials", c.financials);
    await ins("document_financial_lines", c.financial_lines);
    docs += c.documents.length;
  }
  await lite.exec("ANALYZE");
  return { tenantId, docs, copies, ctx: { tenantKey: "offline:" + tenantKey, tenantName } };
}
