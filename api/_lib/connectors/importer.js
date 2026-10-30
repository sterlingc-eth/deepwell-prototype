/**
 * Hands one file to DeepWell's ONE ingestion pipeline by reusing the Google importer (googleSync/importer.js):
 * checkUploadFile -> assertUploadRoomInTx -> R2 put -> createDocument(stage 'received', sha256-keyed, identical bytes = one document)
 * -> enqueue (Inngest) or the existing sweep. No second pipeline. Loaded lazily; tests inject their own importer instead.
 */
import { withTenant } from "../recordsStore.js";
import { importBytes, precheck, defaultImportDeps } from "../googleSync/importer.js";

export async function createImporter() {
  const deps = await defaultImportDeps();
  return {
    precheck,
    async importOne(ctx, f) {
      const tctx = { tenantKey: ctx.tenantKey, tenantName: ctx.tenantName ?? ctx.tenantKey };
      const billingRow = await deps.loadBillingRow({ tenantId: tctx.tenantKey, orgId: tctx.tenantName });
      let r;
      try {
        r = await withTenant(tctx, async (db) => {
          const out = await importBytes(db, deps, { filename: f.filename, contentType: f.contentType, bytes: f.bytes, billingRow, source: f.source, externalId: f.externalId });
          if (out.outcome === "created") {
            await db.logAction({ action: "document.connector_import", resource_type: "document", resource_id: out.documentId, clerk_user_id: null,
              changes: { source: f.source, folderHint: f.folderHint ?? null, ...(f.meta ?? {}) } });
          }
          return out;
        });
      } catch (err) {
        if (err?.name === "UploadGateRefusal") return { outcome: "gate", note: String(err.message).slice(0, 300) };
        throw err;
      }
      if (r.outcome === "created") { try { await deps.enqueue(tctx, r.documentId); } catch (e) { console.error("connectors: enqueue failed (the sweep will pick the document up):", e?.message); } }
      return r;
    },
  };
}
