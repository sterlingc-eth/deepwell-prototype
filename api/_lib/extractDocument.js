import Anthropic from "@anthropic-ai/sdk";
import { withTenant, linkDocumentToCustomer, linkDocumentToEntity } from "./recordsStore.js";
import { getApiKey, MODEL_TIMEOUT_MS, withBackoff } from "./claude.js";
import {
  EXTRACT_TOOL, buildExtractPrompt, normalizeFields, selectPages,
  groupFieldsByUnit, collapseDuplicateValues,
} from "./extractFields.js";
import { IngestError, isValidDocumentId } from "./readDocument.js";
import { assertModelBudget } from "./rateLimit.js";
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
 * @param {{userId?: string, documentType?: string, modelAttempts?: number}} [opts]
 *   `modelAttempts` (H2, 2026-09-19 adversarial audit): withBackoff's own
 *   retry count for the Anthropic call below. Left undefined (withBackoff's
 *   default of 3) on the inline/sync path — a synchronous request has no
 *   other retry mechanism backing it up. The Inngest `extract-fields`
 *   function (queue.js) passes 1: under the queue, retrying the WHOLE step
 *   already re-runs this call, so nesting withBackoff's own 3 attempts inside
 *   that step's 3 Inngest retries could multiply one document's spend up to
 *   9x under a sustained 429/529 — bounded, but never checked against the
 *   daily budget below or against itself. One layer of retry should own a
 *   429, not two.
 * @returns {Promise<{documentId: string, entityId: string|null, customerId: string|null,
 *                    fields: object[], dropped: object[], truncated: boolean, model: string,
 *                    pagesRead: number, pagesTotal: number}>}
 */
export async function extractDocumentFields(ctx, documentId, { userId, documentType, modelAttempts } = {}) {
  // Every documents.id is a uuid; a malformed value survives a bare
  // typeof/truthiness check and only fails once bound against that column,
  // as "invalid input syntax for type uuid" — a raw 500, not a clean 400.
  // Guarded here (not just at the HTTP route) so the Inngest queue worker,
  // which calls this directly with no route in front of it, is covered too.
  if (!isValidDocumentId(documentId)) {
    throw new IngestError("documentId must be a uuid", 400);
  }

  // B1 (2026-09-19 adversarial audit): the daily model-spend cap used to be
  // enforced at exactly one of four billed call sites (the Inngest read
  // step) — this is a second one. Checked before the (cheap) document load
  // below so an exhausted tenant never even pays for that query, let alone
  // the Anthropic call. Covers BOTH callers of this function: the Inngest
  // extract-fields worker (queue.js) and /api/extract's stored-document path
  // — one check, both paths, rather than two call sites that could drift.
  await assertModelBudget(ctx);

  // Short transaction: the model call below must not hold a pool connection.
  const loaded = await withTenant(ctx, async (db) => {
    const doc = await db.getDocument(documentId);
    if (!doc) return null;
    return { doc, pages: await db.listPages(documentId) };
  });

  if (!loaded) throw new IngestError("Document not found", 404);

  const { doc, pages } = loaded;
  if (!pages.length || !pages.some((p) => (p.text ?? "").trim())) {
    // Two different situations, not one: a document read carries its own
    // extract_error (see readDocument.js's hasReadableText/NO_READABLE_TEXT_MESSAGE)
    // when the read genuinely ran and found nothing — surface THAT message
    // rather than telling someone to go run a step that already ran. Only a
    // document that has never had extract_error set at all gets the "not
    // read yet" 409.
    if (doc.extract_error) throw new IngestError(doc.extract_error, 422);
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
  }, { timeout: Math.max(1000, deadlineAt - Date.now()) }), { deadlineAt, attempts: modelAttempts });
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
  // Same technician-attribution overlay, applied per unit for a multi-unit
  // document — a startup sheet's "installed_by" applies to every unit it
  // installed, not only the one whose facts happen to include a serial first.
  const withInstalledBy = (unitFacts) =>
    isInstallShaped && facts.technician ? { ...unitFacts, installed_by: facts.technician } : unitFacts;

  // Multi-unit documents (2026-09-19 live finding): a maintenance agreement
  // or install invoice can cover more than one physical unit, each with its
  // own serial/model/install date under a shared customer_name/service_address/
  // warranty_term. groupFieldsByUnit() (extractFields.js) has already sorted
  // that out from unit_index tags the model attached, if any.
  //
  // Gated on >=2 DISTINCT serial numbers, not merely units.length > 1: a
  // model that tags unit_index on some fields but only ever names one real
  // serial is not a multi-unit document, and treating it as one would create
  // a second, serial-less equipment entity findOrCreateEquipment would
  // immediately reject anyway (it returns null with no serial) — this check
  // just skips the pointless extra work and log noise for that case.
  const { units } = groupFieldsByUnit(fields);
  const distinctSerials = new Set(
    fields
      .filter((f) => f.field_key === 'serial_number' && f.value)
      .map((f) => f.value.trim().toLowerCase())
  );
  const isMultiUnit = distinctSerials.size >= 2 && units.length >= 2;

  let warranty = null;

  const written = await withTenant(ctx, async (db) => {
    // `entity`/`warranty` end up holding the FIRST unit's — extractions.entity_id
    // stays single-valued for backward compatibility with everything that
    // reads "the" entity off a document. Every unit still gets its own
    // findOrCreateEquipment (so none of the fill-once merge or the B2
    // advisory-lock race protection is skipped) and its own derived
    // warranty; units after the first get an additional document_entity_links
    // row below instead of the primary entity_id.
    let entity;
    const unitResults = [];
    if (isMultiUnit) {
      for (const unit of units) {
        const unitEquipmentFacts = withInstalledBy(unit.facts);
        const unitEntity = await db.findOrCreateEquipment(unitEquipmentFacts);
        // Same fill-only-merge-then-derive as the single-unit path below,
        // just scoped to this unit's own facts + its own entity row.
        const unitKnown = { ...unit.facts, ...(unitEntity?.data ?? {}) };
        const unitWarranty = deriveWarranty(unitKnown);
        if (unitEntity?.id) await db.setEquipmentWarranty(unitEntity.id, unitWarranty);
        unitResults.push({ index: unit.index, entity: unitEntity, warranty: unitWarranty });
      }
      entity = unitResults[0]?.entity ?? null;
      warranty = unitResults[0]?.warranty ?? null;
    } else {
      entity = await db.findOrCreateEquipment(equipmentFacts);

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
    }

    // Customer resolution runs regardless of whether an equipment entity was
    // found: a document with no serial (a dispatch note, a proposal, a
    // letter) still names a customer, and that customer is how such a
    // document reaches stage 'linked' below. findOrCreateCustomer returns
    // null rather than a fabricated customer when the document names nobody
    // — see its doc comment in recordsStore.js for the matching key and its
    // known limitations.
    const customer = await db.findOrCreateCustomer(facts);
    const linked = customer?.id && entity?.id
      ? await db.setEquipmentCustomer(entity.id, customer.id)
      : 0;

    // Two units sharing an identical printed value (the same model number on
    // RTU-1 and RTU-2, most often) is a real, legitimate case that
    // groupFieldsByUnit() above needs to see as two rows — but
    // replaceDocumentFields throws on an exact (field_key, value) duplicate,
    // since its write CTE joins each new extraction back to its facet on
    // that pair. Collapsed only for this write; `fields` itself (returned to
    // the caller, and what groupFieldsByUnit already read) keeps every row.
    const fieldsForWrite = collapseDuplicateValues(fields);
    const counts = await db.replaceDocumentFields(documentId, fieldsForWrite, {
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
    // answer without a human having to click anything. A document with no
    // equipment entity (no serial) but a resolved customer links straight to
    // that customer instead — see linkDocumentToCustomer's doc comment.
    let documentCustomerLinked = false;
    if (entity?.id) {
      await db.markLinked(documentId);
      // Units after the first don't get extractions.entity_id (that stays
      // single-valued, see the multi-unit comment above) but the document
      // still covers their equipment, so each gets its own
      // document_entity_links row — otherwise RTU-2's own entity screen
      // would never show this document at all.
      if (isMultiUnit) {
        for (const ur of unitResults.slice(1)) {
          if (ur.entity?.id) {
            await linkDocumentToEntity(db, { documentId, entityId: ur.entity.id, confidence: 0.6 });
          }
        }
      }
    } else if (customer?.id) {
      const customerFields = fields.filter((f) => f.field_key === 'customer_name' || f.field_key === 'service_address');
      const customerConfidence = customerFields.length ? Math.max(...customerFields.map((f) => f.confidence)) : 0.6;
      documentCustomerLinked = await linkDocumentToCustomer(db, {
        documentId, entityId: null, customerId: customer.id, confidence: customerConfidence,
      });
    }

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
        unit_count: isMultiUnit ? unitResults.length : 1,
        additional_entity_ids: isMultiUnit
          ? unitResults.slice(1).map((u) => u.entity?.id).filter(Boolean)
          : [],
        customer_id: customer?.id ?? null,
        customer_created: customer?.created ?? false,
        // False when the equipment was already linked to a DIFFERENT customer
        // (setEquipmentCustomer's fill-only guard) as much as when there was
        // no customer to link — the two are distinguishable via customer_id
        // above being non-null with customer_linked false.
        customer_linked: linked > 0,
        document_customer_linked: documentCustomerLinked,
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
