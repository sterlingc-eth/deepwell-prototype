import Anthropic from "@anthropic-ai/sdk";
import { withTenant } from "./recordsStore.js";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "./claude.js";
import { EXTRACT_TOOL, buildExtractPrompt, normalizeFields, selectPages } from "./extractFields.js";
import { IngestError } from "./readDocument.js";
import { deriveWarranty } from "./warrantyRules.js";
import { withCache, modelCallLogLine } from "./promptCache.js";
import { recordModelCall } from "./usage.js";
import {
  normalizeDocumentType,
  resolveDocumentType,
  isLegacyOrUnknownType,
  completenessFor,
  AI_VERIFY_MIN_CONFIDENCE,
} from "./documentTypes.js";

/**
 * buildExtractPrompt() (extractFields.js — not owned by this change, left
 * untouched) returns one flat string: a per-document intro sentence + the
 * page text, followed by a field guide + rules block that is IDENTICAL on
 * every single call, for every document, forever (until extractFields.js's
 * wording changes). That second part is the cacheable "extraction system
 * prompt" the caching task calls for; the first part (the actual document
 * text) obviously is not, since it's different on every document by design.
 *
 * Splitting on that fixed sentence — rather than copying the field guide and
 * rules text a second time into this file — keeps there from ever being two
 * copies of the same guidance to drift apart. If extractFields.js's wording
 * ever changes, the marker just stops matching and this falls back to
 * sending the whole prompt as one uncached user message (still correct,
 * exactly today's behavior — just not cached), never to two different
 * copies of the instructions reaching the model at once.
 */
const EXTRACT_STATIC_MARKER = "Read the pages and return every field the text actually states";

/** Pure. @returns {{dynamic: string, stable: string}} */
export function splitExtractPrompt(fullPrompt) {
  const text = String(fullPrompt ?? "");
  const idx = text.indexOf(EXTRACT_STATIC_MARKER);
  if (idx === -1) return { dynamic: text, stable: "" };
  return { dynamic: text.slice(0, idx).trimEnd(), stable: text.slice(idx).trimEnd() };
}

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
  const client = new Anthropic({ apiKey: getApiKey(), timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });

  // See splitExtractPrompt()'s doc comment above for why this is split
  // rather than sent as the one flat string it used to be. withCache()
  // (api/_lib/promptCache.js) only attaches cache_control when `stable` is
  // actually long enough to be cached (Haiku: 2048 tokens, ~8192 chars) — as
  // measured, today's field guide + rules text is well under that (~600
  // tokens), so in practice this does NOT get a cache breakpoint yet. See
  // handoffs/HANDOFF-B.md; this is the documented, intentional "skip rather
  // than pad" case the task called for, not a bug.
  const fullPrompt = buildExtractPrompt(selected, documentType || doc.document_type);
  const { dynamic: dynamicPrompt, stable: stablePrompt } = splitExtractPrompt(fullPrompt);

  const startedAt = Date.now();
  const deadlineAt = startedAt + MODEL_TIMEOUT_MS;
  const response = await withBackoff(() => client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 4000,
    ...(stablePrompt ? { system: [withCache({ type: "text", text: stablePrompt }, EXTRACT_MODEL)] } : {}),
    tools: [withCache(EXTRACT_TOOL, EXTRACT_MODEL)],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{ role: "user", content: dynamicPrompt }],
  }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt });
  const latencyMs = Date.now() - startedAt;

  // One structured line per call, no PII (page text/field values never
  // appear here) — so Vercel logs show cache hit rates.
  console.log(
    JSON.stringify(
      modelCallLogLine({
        route: "extract",
        model: EXTRACT_MODEL,
        inputTokens: response.usage?.input_tokens,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
        outputTokens: response.usage?.output_tokens,
        latencyMs,
      })
    )
  );

  // Cost accounting, best-effort — see api/ask.js's identical comment.
  // recordModelCall already swallows its own errors (usage.js), and this is
  // wrapped again so a change there can never turn a successful extraction
  // into a 500.
  try {
    await recordModelCall(ctx, {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
    });
  } catch (err) {
    console.error("Failed to record extract usage:", err?.message);
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const highestPage = pages.reduce((n, p) => Math.max(n, Number(p.page_no) || 0), 0);
  const { fields, dropped } = normalizeFields(toolUse?.input?.fields, { pageCount: highestPage });

  // A document that states nothing extractable is a real answer, not a failure.
  // The write still happens, so an empty result replaces stale rows from an
  // earlier run rather than leaving them there to look current.
  const facts = Object.fromEntries(fields.map((f) => [f.field_key, f.value]));

  // Which technician installed a unit is exactly the kind of fact
  // findOrCreateEquipment's fill-once merge exists for (the first install
  // document to state it wins; a later service ticket cannot overwrite it) —
  // it is simply missing from that function's own field list today. See
  // HANDOFF.md for the one-line addition recordsStore.js still needs
  // ('installed_by' alongside 'serial_number', 'model', etc.); until that
  // lands, findOrCreateEquipment silently drops this key from `incoming` the
  // same way it already drops any key not on its list, so passing it early
  // is inert rather than wrong, and starts working the moment that list grows.
  const classification = documentType
    ? { documentType: normalizeDocumentType(documentType, facts), confidence: 1, source: 'explicit' }
    : resolveDocumentType(toolUse?.input, facts, doc.original_filename);

  // A human (via review.classifyDocument) or an earlier pass already decided
  // this document's type; a routine re-extraction must not quietly relabel
  // it. An explicit `documentType` argument is the one thing allowed to
  // override that decision.
  const existingIsDecided = classification.source !== 'explicit'
    && doc.document_type && !isLegacyOrUnknownType(doc.document_type);
  const resolvedType = existingIsDecided ? doc.document_type : classification.documentType;

  const isInstallShaped = resolvedType === 'startup-sheet'
    || (resolvedType === 'invoice' && !!facts.installation_date);
  const equipmentFacts = isInstallShaped && facts.technician
    ? { ...facts, installed_by: facts.technician }
    : facts;

  let warranty = null;

  const written = await withTenant(ctx, async (db) => {
    const entity = await db.findOrCreateEquipment(equipmentFacts);

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
    // resolvedType is computed above, before the transaction, from the same
    // classification/override precedence equipmentFacts already used.
    if (resolvedType && resolvedType !== doc.document_type) {
      await db.updateDocument(documentId, { document_type: resolvedType });
    }

    // This extraction succeeded, so any error left over from a previous attempt
    // is now a lie. Nothing cleared it before: extract_error was set by a failed
    // extraction but only ever cleared by a successful READ, so a document that
    // failed once and then extracted perfectly on retry stayed marked failed
    // forever — and the browser treats extract_error as terminal, so the user
    // was told to give up on a row that held all of its data.
    await db.clearExtractError(documentId);

    // The pipeline just attached this document to an entity. Say so in the
    // stage, so the client's "is this document linked" question has an honest
    // answer without a human having to click anything.
    if (entity?.id) await db.markLinked(documentId);

    // AI self-verification: every required field for this type is present at
    // AI_VERIFY_MIN_CONFIDENCE or better, and the document is actually linked
    // to a record. verifyByAi (recordsStore.js) re-checks the link itself in
    // SQL, forward-only — this is a cheap pre-check, not the source of truth.
    const completeness = completenessFor(resolvedType, fields);
    let aiVerified = false;
    if (completeness.complete && completeness.minConfidence >= AI_VERIFY_MIN_CONFIDENCE) {
      aiVerified = (await db.verifyByAi(documentId)) > 0;
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
        document_type: resolvedType,
        document_type_confidence: classification.confidence,
        document_type_source: classification.source,
        completeness_missing: completeness.missing,
        ai_verified: aiVerified,
      },
    });
    return {
      counts,
      documentType: resolvedType ?? null,
      entityId: entity?.id ?? null,
      customerId: customer?.id ?? null,
      completeness,
      aiVerified,
    };
  });

  return {
    documentId,
    documentType: written.documentType,
    entityId: written.entityId,
    customerId: written.customerId,
    completeness: written.completeness,
    aiVerified: written.aiVerified,
    fields,
    dropped,
    truncated,
    model: EXTRACT_MODEL,
    pagesRead: selected.length,
    pagesTotal: pages.length,
    warranty,
  };
}
