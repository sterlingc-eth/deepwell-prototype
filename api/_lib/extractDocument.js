import Anthropic from "@anthropic-ai/sdk";
import { withTenant } from "./recordsStore.js";
import { getApiKey } from "./claude.js";
import { EXTRACT_TOOL, buildExtractPrompt, normalizeFields, selectPages } from "./extractFields.js";
import { IngestError } from "./readDocument.js";
import { deriveWarranty } from "./warrantyRules.js";

/**
 * Structured extraction with no HTTP in it, for the same reason as
 * readDocument.js: the route and the queue worker must run the same code.
 *
 * Reads STORED page text, not the original file. read-document already paid for
 * OCR; this is a cheap second pass over its output, which is why the default
 * model is Haiku.
 */

export const EXTRACT_MODEL = process.env.EXTRACT_MODEL || "claude-haiku-4-5";

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @returns {Promise<{documentId: string, entityId: string|null, customerId: string|null,
 *                    fields: object[], dropped: object[], truncated: boolean, model: string,
 *                    pagesRead: number, pagesTotal: number}>}
 */
export async function extractDocumentFields(ctx, documentId, { userId, documentType } = {}) {
  // Short transaction: the model call below must not hold a pool connection.
  const loaded = await withTenant(ctx, async (db) => {
    const doc = await db.getDocument(documentId);
    if (!doc) return null;
    return { doc, pages: await db.listPages(documentId) };
  });

  if (!loaded) throw new IngestError("Document not found", 404);

  const { doc, pages } = loaded;
  if (!pages.length || !pages.some((p) => (p.text ?? "").trim())) {
    // Not an error the user caused — the document just has not been read yet.
    throw new IngestError("This document has no page text yet. Run /api/read-document first.", 409);
  }

  const { pages: selected, truncated } = selectPages(pages);
  const client = new Anthropic({ apiKey: getApiKey() });
  const response = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 4000,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [
      { role: "user", content: buildExtractPrompt(selected, documentType || doc.document_type) },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const highestPage = pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
  const { fields, dropped } = normalizeFields(toolUse?.input?.fields, { pageCount: highestPage });

  // A document that states nothing extractable is a real answer, not a failure.
  // The write still happens, so an empty result replaces stale rows from an
  // earlier run rather than leaving them there to look current.
  const facts = Object.fromEntries(fields.map((f) => [f.field_key, f.value]));

  let warranty = null;

  const written = await withTenant(ctx, async (db) => {
    const entity = await db.findOrCreateEquipment(facts);

    // Derived from the ENTITY's accumulated facts, not this document's alone.
    //
    // A unit's manufacturer and install date are stated once, on the install
    // invoice. Every later document about that same serial — a service ticket,
    // a filter change, a callback — says neither. Deriving from `facts` by
    // itself therefore produced an empty warranty for those documents, and
    // setEquipmentWarranty's jsonb merge replaces the whole `warranty` key, so
    // the second document silently erased the correct deadline computed from
    // the first. The unit then vanished from the expiring-warranty list with
    // nothing recorded as wrong, and which answer you got depended on which
    // document happened to be extracted last.
    //
    // The entity's own values win over this document's: the entity merge is
    // fill-only, so what is on the row is the first — and by convention the
    // most authoritative — reading of that field.
    const known = { ...facts, ...(entity?.data ?? {}) };

    // Still derived WITHOUT a clock: only the stable parts — the registration
    // deadline, the term, the expiry, and whether that expiry was printed or
    // calculated — get stored. Day counts are computed when the list is read,
    // because "19 days left" is true for exactly one day.
    warranty = deriveWarranty(known);
    if (entity?.id) await db.setEquipmentWarranty(entity.id, warranty);

    // Customer resolution never blocks equipment/warranty writes above: a
    // document with no readable customer name (facts.customer_name empty)
    // still gets its equipment and warranty recorded, it just isn't linked to
    // anyone yet. findOrCreateCustomer returns null rather than a fabricated
    // customer in that case — see its doc comment in recordsStore.js for the
    // matching key and its known limitations.
    const customer = entity?.id ? await db.findOrCreateCustomer(facts) : null;
    const linked = customer?.id && entity?.id
      ? await db.setEquipmentCustomer(entity.id, customer.id)
      : 0;

    const counts = await db.replaceDocumentFields(documentId, fields, {
      entityId: entity?.id ?? null,
    });

    // Record what this document turned out to be. Nothing wrote document_type
    // before, so it was null on every row forever — and the review screen gates
    // its whole extracted-fields section on that column being set, which meant a
    // document that HAD been fully extracted rendered as a blank slate and a
    // technician was invited to key it all in again.
    const resolvedType = documentType || doc.document_type || inferDocumentType(facts);
    if (resolvedType && resolvedType !== doc.document_type) {
      await db.updateDocument(documentId, { document_type: resolvedType });
    }
    await db.logAction({
      action: "document.fields_extracted",
      resource_type: "document",
      resource_id: documentId,
      clerk_user_id: userId,
      changes: {
        fields: counts.extractions,
        replaced: counts.replaced,
        dropped: dropped.length,
        truncated,
        model: EXTRACT_MODEL,
        entity_id: entity?.id ?? null,
        entity_created: entity?.created ?? false,
        warranty_basis: warranty.expiresBasis,
        registration_deadline: warranty.registrationDeadline,
        customer_id: customer?.id ?? null,
        customer_created: customer?.created ?? false,
        // False when the equipment was already linked to a DIFFERENT customer
        // (setEquipmentCustomer's fill-only guard) as much as when there was
        // no customer to link — the two are distinguishable via customer_id
        // above being non-null with customer_linked false.
        customer_linked: linked > 0,
      },
    });
    return {
      counts,
      documentType: resolvedType ?? null,
      entityId: entity?.id ?? null,
      customerId: customer?.id ?? null,
    };
  });

  return {
    documentId,
    documentType: written.documentType,
    entityId: written.entityId,
    customerId: written.customerId,
    fields,
    dropped,
    truncated,
    model: EXTRACT_MODEL,
    pagesRead: selected.length,
    pagesTotal: pages.length,
    warranty,
  };
}

/**
 * What kind of document this is, from the fields that came out of it. Only ever
 * a fallback: an explicit documentType from the caller, or one already on the
 * row, wins. The point is that the column stops being null, not that the label
 * is subtle — a human reclassifies it in review.
 */
function inferDocumentType(facts) {
  if (facts.warranty_registered_date || facts.warranty_expires || facts.warranty_term) return "warranty";
  if (facts.invoice_number || facts.cost) return "invoice";
  if (facts.service_date || facts.technician || facts.work_performed) return "service_ticket";
  if (facts.installation_date) return "install_record";
  if (facts.serial_number || facts.model) return "equipment_record";
  return "document";
}
