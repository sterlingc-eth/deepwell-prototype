/**
 * STRAIGHT-THROUGH INTAKE — cross-document autofill + one-question review (Round 12, G4).
 *
 * Owner ask: "when an item is uploaded it should fill out all the information required
 * without human interaction unless it's truly incapable of doing so." Everything below is
 * deterministic and reads only what earlier pipeline steps already wrote to Postgres — NO
 * MODEL CALLS, so it works (or degrades to a no-op) with no Anthropic budget at all.
 *
 * Called once per document, right after extractDocument.js's own extraction/linking
 * transaction commits (see the DOSSIER-HOOK-style call there). Two jobs:
 *
 *   1. FILL missing REQUIRED fields (documentTypes.js's REQUIRED_FIELDS) from SIBLING
 *      documents — other documents already linked to the same equipment unit or the same
 *      customer (document_entity_links / extractions.entity_id). A field this document never
 *      printed but a linked install record, dispatch note or work order already established
 *      (installation date, technician, warranty term, ...) is filled in with full provenance
 *      (source document id + page + which rule) and a slightly discounted confidence — see
 *      intake_field_inferences (M3-config/43). Filling never touches `extractions`: that table
 *      is what Donovan's retrieval/citations read as "this document said this", and an inferred
 *      value does not belong there (see the migration's own header comment).
 *
 *   2. ASK exactly one precise question when a fill is genuinely ambiguous — two sibling
 *      documents state two different values for the same field with no strong reason to
 *      prefer either (documentTypes.js's own AI_VERIFY_MIN_CONFIDENCE margin below decides
 *      "strong reason") — or when a document names a customer whose name matches two or more
 *      existing customers and nothing (address, a prior link) disambiguates them. Recorded in
 *      intake_needs_info (M3-config/43), one open row per (document, field), never a blank
 *      form: every row carries its candidate answers.
 *
 * Idempotent and bounded: every run recomputes this document's own fills/questions fresh from
 * current DB state (a stale inference or a resolved question is simply overwritten), and a
 * fresh document also re-checks a small, capped batch of OPEN questions on its siblings (see
 * NEEDS_INFO_REEXAMINE_LIMIT) so a warranty registration that arrives after its install record
 * can resolve a question the install record left open, without a human ever prompting for it.
 *
 * Also wires the three post-ingest hooks Round 12's contract assigns to whoever owns
 * completion of the pipeline: G3's assignDisplayName (guarded dynamic import — not yet in this
 * worktree), the Knowledge Graph's refreshGraphForDocument (existing), and a cheap per-tenant
 * rollup refresh. All best-effort: nothing here may ever fail ingest.
 */
import { withTenant, findCustomerNameCandidates, normalizeMatchText } from "../recordsStore.js";
import { completenessFor, fieldLabel, documentTypeLabel, AI_VERIFY_MIN_CONFIDENCE } from "../documentTypes.js";
import { refreshGraphForDocument } from "../graph/build.js";
import { refreshAllRollups } from "../rollups/refresh.js";
import { TENANT_SQL } from "../scope.js";
import { assignDisplayName } from "../naming/assign.js";

/** A fill is accepted over a conflicting alternative only when it leads by at least this much
 *  confidence — the same "don't guess, be sure" margin documentTypes.js's AI_VERIFY_MIN_CONFIDENCE
 *  represents elsewhere in this pipeline for "good enough to auto-verify". Below this margin two
 *  candidates are treated as a real conflict and get ONE precise question instead of a silent pick. */
export const CONFLICT_MARGIN = 0.15;

/** At most this many of a sibling's OPEN needs-info rows are re-examined per document processed
 *  — bounded so one newly-arrived document can never turn into an unbounded fan-out scan across
 *  every question ever raised for its entity/customer. */
export const NEEDS_INFO_REEXAMINE_LIMIT = 20;

/* ------------------------------------------------------------- table-existence probes */
// Same tolerant idiom as graph/build.js's kgEdgesTableExists / recordsStore.js's
// extractionsHaveUnitIndex: a database this migration hasn't reached yet just turns the
// whole feature off rather than erroring ingest.

let inferencesKnown = null;
let needsInfoKnown = null;
export function _resetIntakeTableProbesForTests() {
  inferencesKnown = null;
  needsInfoKnown = null;
}

async function inferencesTableExists(db) {
  if (inferencesKnown != null) return inferencesKnown;
  try {
    const r = await db.raw("SELECT to_regclass('public.intake_field_inferences') IS NOT NULL AS ok", []);
    inferencesKnown = Boolean(r.rows[0]?.ok);
  } catch {
    return false;
  }
  return inferencesKnown;
}

async function needsInfoTableExists(db) {
  if (needsInfoKnown != null) return needsInfoKnown;
  try {
    const r = await db.raw("SELECT to_regclass('public.intake_needs_info') IS NOT NULL AS ok", []);
    needsInfoKnown = Boolean(r.rows[0]?.ok);
  } catch {
    return false;
  }
  return needsInfoKnown;
}

/* ------------------------------------------------------------------------- pure helpers */

/** Loose equality for deciding "is this the same value another document stated" — case/space
 *  insensitive only; never reformats dates or numbers (a genuinely different-looking date IS a
 *  different candidate, which is exactly when a needs-info question is the right outcome). Pure. */
export function normalizeCompareValue(v) {
  return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 'a|b' -> ['a', 'b']; a bare key -> [key]. Pure, mirrors documentTypes.js's own completenessFor. */
export function splitAltKeys(requirement) {
  return String(requirement ?? "").split("|").map((k) => k.trim()).filter(Boolean);
}

/**
 * Group candidate {value, confidence, documentId, page} rows by normalized value, each group
 * keeping its own max confidence and earliest-seen provenance. Pure; exported for direct testing.
 * @returns {{value: string, confidence: number, documentId: string, page: number|null}[]}
 *   sorted by confidence descending.
 */
export function groupCandidatesByValue(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = normalizeCompareValue(r.value);
    if (!key) continue;
    const conf = Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0;
    const prev = byKey.get(key);
    if (!prev || conf > prev.confidence) {
      byKey.set(key, { value: r.value, confidence: conf, documentId: r.documentId, page: r.page ?? null });
    }
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * Decide what one missing field's sibling candidates resolve to.
 *   - no candidates            -> { outcome: 'unknown' }             (nothing to infer; leave for a human)
 *   - exactly one distinct value, or the top candidate leads the runner-up by >= CONFLICT_MARGIN
 *                               -> { outcome: 'fill', value, confidence, documentId, page, alternates }
 *   - two+ distinct values with no clear leader
 *                               -> { outcome: 'conflict', candidates }
 * Pure; exported for direct testing.
 */
export function resolveFieldCandidates(rows) {
  const groups = groupCandidatesByValue(rows);
  if (!groups.length) return { outcome: "unknown" };
  if (groups.length === 1) {
    const [only] = groups;
    return { outcome: "fill", ...only, alternates: [] };
  }
  const [top, second] = groups;
  if (top.confidence - second.confidence >= CONFLICT_MARGIN) {
    return { outcome: "fill", ...top, alternates: groups.slice(1) };
  }
  return { outcome: "conflict", candidates: groups };
}

/** One precise, human-readable question for a genuinely ambiguous field — never a blank form. */
export function buildFieldConflictQuestion({ fieldKey, docLabel, candidates, pack }) {
  const label = fieldLabel(fieldKey, pack);
  const options = candidates.map((c) => `"${c.value}"`).join(" or ");
  return `Which ${label.toLowerCase()} is correct for this ${docLabel}: ${options}?`;
}

/** The owner's own example shape: "Which customer is 581 W Thomas Rd: Carol Rios or Carlos Rios?" */
export function buildCustomerAmbiguityQuestion({ address, candidateNames }) {
  const where = address ? address : "this document";
  return `Which customer is ${where}: ${candidateNames.join(" or ")}?`;
}

/* ------------------------------------------------------------------------ field scoping */

/**
 * Reviewer blocking bug (Round 12 integration): a customer with two units had Unit B's model
 * filled into Unit A's document, auto-verified, because every missing field used the SAME
 * sibling pool — "any document linked to this CUSTOMER" — regardless of whether the field
 * actually describes the customer or one specific piece of equipment. A serial number, model,
 * manufacturer, tonnage, install date or warranty date is a fact about ONE unit; two units
 * belonging to the same customer can legitimately disagree on every one of them, so borrowing
 * across units is a wrong fill, not a conflict a confidence margin can adjudicate away.
 *
 * Everything in this set is resolved through resolveEquipmentScope below (same equipment entity,
 * or the same stated serial number, or — only when the customer has exactly one unit on file —
 * that one unambiguous unit); everything else keeps using the broader customer/entity sibling
 * pool this module already had (customer_name/service_address only ever needed to agree with the
 * CUSTOMER, and technician/service_date/cost are already covered by the ordinary conflict ->
 * needs-info path when two visits genuinely disagree).
 */
const EQUIPMENT_SCOPED_FIELDS = new Set([
  "serial_number", "model", "manufacturer", "equipment_type", "tonnage", "refrigerant",
  "installation_date", "warranty_expires", "warranty_term", "warranty_registered_date",
  "agreement_term", "permit_number", "part_number",
]);

function fieldScope(fieldKey) {
  return EQUIPMENT_SCOPED_FIELDS.has(fieldKey) ? "equipment" : "other";
}

/** Every OTHER document naming this exact serial number, tenant-scoped — the strongest possible
 *  equipment identifier, and one that works even before `documentId` has an entity_id of its own
 *  (findOrCreateEquipment runs before this hook, so in practice it usually does, but this stays
 *  correct either way). */
async function docsBySerial(db, { documentId, serial }) {
  if (!serial) return [];
  const { rows } = await db.raw(
    `SELECT DISTINCT x.document_id FROM extractions x
      WHERE x.${TENANT_SQL} AND x.document_id <> $1 AND x.field_key = 'serial_number'
        AND lower(btrim(COALESCE(x.corrected_value, x.value))) = $2
      LIMIT 200`,
    [documentId, serial]
  );
  return rows.map((r) => r.document_id);
}

/** Every equipment unit on file for this customer — entities.customer_id is the same fill-only
 *  link setEquipmentCustomer writes (recordsStore.js), so this is exactly "this customer's
 *  units" as the rest of the app already understands that phrase. */
async function customerEquipmentUnits(db, { customerId }) {
  const { rows } = await db.raw(
    `SELECT id, data->>'serial_number' AS serial_number, data->>'model' AS model
       FROM entities WHERE ${TENANT_SQL} AND entity_type = 'equipment' AND customer_id = $1 AND merged_into IS NULL
       ORDER BY created_at LIMIT 50`,
    [customerId]
  );
  return rows.map((r) => ({ entityId: r.id, serialNumber: r.serial_number, model: r.model }));
}

/**
 * Which documents may answer an EQUIPMENT-scoped missing field for `documentId`.
 *   - entityId resolved     -> siblings linked to that SAME entity, plus any document (anywhere
 *                               for this tenant) stating the same serial number — belt and
 *                               braces, since the two signals can each catch what the other misses.
 *   - no entityId, but this document's own facts state a serial number that matches exactly the
 *     other documents naming it -> those documents (the exact "same serial across documents"
 *     case, resolved without ever needing entityId at all).
 *   - no entityId, no matching serial, but the customer has exactly ONE unit on file -> that one
 *     unit's siblings (unambiguous even though this document itself never named it directly).
 *   - the customer has 2+ units and nothing above disambiguates which one this document is about
 *     -> 'ambiguous', so the caller raises ONE precise question naming the candidate units
 *     instead of guessing.
 *   - nothing at all to go on -> 'none' (leave the field missing; precision first).
 */
async function resolveEquipmentScope(db, { documentId, entityId, customerId, facts }) {
  const serial = facts?.serial_number ? normalizeCompareValue(facts.serial_number) : "";

  if (entityId) {
    const bySameEntity = await findSiblingDocumentIds(db, { documentId, entityId, customerId: null });
    const bySerial = serial ? await docsBySerial(db, { documentId, serial }) : [];
    return { mode: "siblings", siblingIds: [...new Set([...bySameEntity, ...bySerial])] };
  }

  if (serial) {
    const bySerial = await docsBySerial(db, { documentId, serial });
    if (bySerial.length) return { mode: "siblings", siblingIds: bySerial };
  }

  if (!customerId) return { mode: "none" };
  const units = await customerEquipmentUnits(db, { customerId });
  if (!units.length) return { mode: "none" };
  if (units.length === 1) {
    const siblingIds = await findSiblingDocumentIds(db, { documentId, entityId: units[0].entityId, customerId: null });
    return { mode: "siblings", siblingIds };
  }
  return {
    mode: "ambiguous",
    candidates: units.map((u) => ({ entityId: u.entityId, label: u.serialNumber || u.model || u.entityId })),
  };
}

/** The needs-info question raised when a document's own unit cannot be determined at all — never
 *  guessed at by silently picking the customer's first unit. */
export function buildEquipmentAmbiguityQuestion({ candidates }) {
  const options = candidates.map((c) => `"${c.label}"`).join(" or ");
  return `Which unit is this document for: ${options}?`;
}

/**
 * The sibling pool for ONE missing requirement's field, scope-appropriate: equipment-scoped
 * fields resolve through resolveEquipmentScope above; everything else (customer_name,
 * service_address, technician, service_date, cost, ...) keeps this module's original, broader
 * customer/entity sibling pool — unchanged, since that pool was never the reported bug.
 * @returns {Promise<{siblingIds: string[]} | {ambiguous: true, candidates: object[]}>}
 */
async function siblingIdsForField(db, { fieldKey, entityId, customerId, facts, documentId }) {
  if (fieldScope(fieldKey) !== "equipment") {
    return { siblingIds: await findSiblingDocumentIds(db, { documentId, entityId, customerId }) };
  }
  const scope = await resolveEquipmentScope(db, { documentId, entityId, customerId, facts });
  if (scope.mode === "ambiguous") return { ambiguous: true, candidates: scope.candidates };
  return { siblingIds: scope.mode === "siblings" ? scope.siblingIds : [] };
}

/* -------------------------------------------------------------------- sibling gathering */

/**
 * Every OTHER document already linked to the same equipment unit or the same customer as
 * `documentId` — via document_entity_links (either entity) or extractions.entity_id (the
 * equipment's primary link). This is "the same job's paperwork": an install record, a warranty
 * registration, a dispatch note or work order for the same unit/customer.
 */
async function findSiblingDocumentIds(db, { documentId, entityId, customerId }) {
  const targets = [entityId, customerId].filter(Boolean);
  if (!targets.length) return [];
  const { rows } = await db.raw(
    `SELECT DISTINCT d.id FROM documents d
      WHERE d.${TENANT_SQL}
        AND d.id <> $1
        AND (
              EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = d.id AND l.entity_id = ANY($2::uuid[]))
           OR EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.entity_id = ANY($2::uuid[]))
        )
      LIMIT 200`,
    [documentId, targets]
  );
  return rows.map((r) => r.id);
}

/** Every candidate value for `altKeys` stated by any of `siblingIds`, earliest first, with page
 *  provenance pulled from the originating facet when one exists. */
async function siblingFieldCandidateRows(db, { siblingIds, altKeys }) {
  if (!siblingIds.length || !altKeys.length) return [];
  const { rows } = await db.raw(
    `SELECT x.document_id, x.field_key, COALESCE(x.corrected_value, x.value) AS value,
            x.confidence, f.page_no AS page
       FROM extractions x
       LEFT JOIN facets f ON f.id = x.source_facet_id
      WHERE x.${TENANT_SQL}
        AND x.document_id = ANY($1::uuid[])
        AND x.field_key = ANY($2::text[])
        AND COALESCE(x.corrected_value, x.value) IS NOT NULL
        AND btrim(COALESCE(x.corrected_value, x.value)) <> ''
      ORDER BY x.created_at ASC`,
    [siblingIds, altKeys]
  );
  return rows.map((r) => ({ documentId: r.document_id, value: r.value, confidence: r.confidence, page: r.page }));
}

/* ---------------------------------------------------------------- provenance write helpers */

async function upsertInference(db, { documentId, fieldKey, value, confidence, rule, sourceDocumentId, sourcePage, candidates }) {
  await db.raw(
    `INSERT INTO intake_field_inferences
        (tenant_id, document_id, field_key, value, confidence, rule, source_document_id, source_page, candidates, created_at, updated_at)
     VALUES ((current_setting('app.tenant_id'))::uuid, $1,$2,$3,$4,$5,$6,$7,$8::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, document_id, field_key) DO UPDATE SET
        value = EXCLUDED.value, confidence = EXCLUDED.confidence, rule = EXCLUDED.rule,
        source_document_id = EXCLUDED.source_document_id, source_page = EXCLUDED.source_page,
        candidates = EXCLUDED.candidates, updated_at = NOW()`,
    [documentId, fieldKey, value, confidence, rule, sourceDocumentId ?? null, sourcePage ?? null, JSON.stringify(candidates ?? [])]
  );
}

async function upsertNeedsInfo(db, { documentId, entityId, fieldKey, question, candidates }) {
  await db.raw(
    `INSERT INTO intake_needs_info
        (tenant_id, document_id, entity_id, field_key, question, candidates, status, created_at, updated_at)
     VALUES ((current_setting('app.tenant_id'))::uuid, $1,$2,$3,$4,$5::jsonb,'open', NOW(), NOW())
     ON CONFLICT (tenant_id, document_id, field_key) DO UPDATE SET
        question = EXCLUDED.question, candidates = EXCLUDED.candidates, entity_id = EXCLUDED.entity_id,
        -- Re-raising an already-open question is a no-op beyond refreshing its candidates; a
        -- question a human (or a later auto-resolve) already closed is never silently reopened.
        status = CASE WHEN intake_needs_info.status = 'open' THEN 'open' ELSE intake_needs_info.status END,
        updated_at = NOW()`,
    [documentId, entityId ?? null, fieldKey, question, JSON.stringify(candidates ?? [])]
  );
}

async function resolveNeedsInfo(db, { documentId, fieldKey, value, resolvedBy }) {
  await db.raw(
    `UPDATE intake_needs_info SET status = 'resolved', resolved_value = $3, resolved_by = $4, resolved_at = NOW(), updated_at = NOW()
      WHERE ${TENANT_SQL} AND document_id = $1 AND field_key = $2 AND status = 'open'`,
    [documentId, fieldKey, value, resolvedBy]
  );
}

/* --------------------------------------------------------------- ambiguous-customer detection */

/**
 * The owner's own example: a document names a customer but the name matches two or more
 * existing customers and nothing disambiguates them (findOrCreateCustomer, upstream, already
 * declined to guess and left the document unlinked). Read-only against recordsStore's existing
 * matching helpers — never re-implements name matching, never creates or links anything itself.
 */
async function detectAmbiguousCustomer(db, { customerName, address }) {
  if (!normalizeMatchText(customerName)) return null;
  const candidates = await findCustomerNameCandidates(db, customerName);
  if (candidates.length < 2) return null;
  return {
    question: buildCustomerAmbiguityQuestion({
      address,
      candidateNames: candidates.map((c) => c.customer_name).filter(Boolean),
    }),
    candidates: candidates.map((c) => ({
      value: c.customer_name, entityId: c.id, address: c.service_address ?? null,
    })),
  };
}

/* ------------------------------------------------------------------------------- main entry */

/**
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {string} documentId
 * @param {{facts?: object, resolvedType?: string, pack?: object, entityId?: string|null,
 *          customerId?: string|null, documentCustomerLinked?: boolean}} [info]
 *   Context extractDocument.js's own extraction pass already computed — passed straight through
 *   so this hook does not re-derive facts/pack/classification a second time. Every field is
 *   optional and re-derived from the database when omitted (e.g. a caller re-running this for a
 *   sibling document that just changed).
 * @returns {Promise<{ok: boolean, filled: string[], questions: string[], verified: boolean}>}
 *   Never throws — every failure degrades to {ok: false}, exactly like the other best-effort
 *   post-extraction hooks in extractDocument.js (integrityFixDocument, applyBodyNameLinks, ...).
 */
export async function runIntakeAutofill(ctx, documentId, info = {}) {
  try {
    return await withTenant(ctx, (db) => runIntakeAutofillTx(db, documentId, info));
  } catch (err) {
    console.error("intake-autofill: best-effort failure", err?.message);
    return { ok: false, filled: [], questions: [], verified: false };
  }
}

async function loadDocumentContext(db, documentId) {
  const doc = await db.raw(`SELECT id, document_type FROM documents WHERE id = $1 AND ${TENANT_SQL}`, [documentId]);
  const row = doc.rows[0];
  if (!row) return null;
  const fieldsRes = await db.raw(
    `SELECT field_key, COALESCE(corrected_value, value) AS value, confidence
       FROM extractions WHERE document_id = $1 AND ${TENANT_SQL}`,
    [documentId]
  );
  const entityRes = await db.raw(
    `SELECT entity_id FROM extractions WHERE document_id = $1 AND ${TENANT_SQL} AND entity_id IS NOT NULL LIMIT 1`,
    [documentId]
  );
  const custRes = await db.raw(
    `SELECT e.id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.document_id = $1 AND l.${TENANT_SQL} AND e.entity_type = 'customer' LIMIT 1`,
    [documentId]
  );
  return {
    resolvedType: row.document_type,
    fields: fieldsRes.rows.map((r) => ({ field_key: r.field_key, value: r.value, confidence: r.confidence })),
    entityId: entityRes.rows[0]?.entity_id ?? null,
    customerId: custRes.rows[0]?.id ?? null,
  };
}

/**
 * Forward-only 'verified', set by the AI once completenessFor says every required field is in
 * and confident — the exact same rule and SQL guard as recordsStore.js's own verifyByAi (see its
 * doc comment), duplicated here rather than imported because this module runs OUTSIDE
 * extractDocument.js's own transaction and, in reexamineSiblingNeedsInfo's case, for a document
 * that is not the one currently being extracted at all — recordsStore.js's curated store object
 * is scoped to one withTenant callback, not reachable from a second document's own recheck.
 */
async function verifyIfComplete(db, { documentId, resolvedType, pack, fields }) {
  const completeness = completenessFor(resolvedType, fields, pack);
  if (!completeness.complete || completeness.minConfidence < AI_VERIFY_MIN_CONFIDENCE) return false;
  const r = await db.raw(
    `UPDATE documents SET stage = 'verified', verified_by = 'ai', verified_at = NOW()
      WHERE id = $1 AND ${TENANT_SQL} AND stage IN ('read','mapped','linked')
        AND (
              EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = documents.id AND x.entity_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = documents.id)
        )`,
    [documentId]
  );
  return r.rowCount > 0;
}

async function runIntakeAutofillTx(db, documentId, info) {
  const haveInferences = await inferencesTableExists(db);
  const haveNeedsInfo = await needsInfoTableExists(db);
  const result = { ok: true, filled: [], questions: [], verified: false };
  if (!haveInferences && !haveNeedsInfo) return result;

  const loaded = await loadDocumentContext(db, documentId);
  if (!loaded) return result;

  const resolvedType = info.resolvedType ?? loaded.resolvedType;
  const pack = info.pack ?? null;
  const entityId = info.entityId ?? loaded.entityId;
  const customerId = info.customerId ?? loaded.customerId;
  const facts = info.facts ?? Object.fromEntries(loaded.fields.map((f) => [f.field_key, f.value]));
  const extractedFields = loaded.fields;

  const completeness = completenessFor(resolvedType, extractedFields, pack);

  // ---- 1. fill missing required fields from siblings, one requirement at a time ----
  const acceptedFills = [];
  if (haveInferences || haveNeedsInfo) {
    for (const requirement of completeness.missing) {
      const altKeys = splitAltKeys(requirement);
      const fieldKey = altKeys[0];

      // Equipment-scoped fields (model, serial, manufacturer, install/warranty dates, tonnage...)
      // never borrow from a customer's OTHER unit — see siblingIdsForField/resolveEquipmentScope.
      const scoped = await siblingIdsForField(db, { fieldKey, entityId, customerId, facts, documentId });
      if (scoped.ambiguous) {
        if (haveNeedsInfo) {
          await upsertNeedsInfo(db, {
            documentId, entityId: null, fieldKey: "equipment_unit",
            question: buildEquipmentAmbiguityQuestion({ candidates: scoped.candidates }),
            candidates: scoped.candidates,
          });
          if (!result.questions.includes("equipment_unit")) result.questions.push("equipment_unit");
        }
        continue; // which unit this document is about is unknown — do not guess at ANY of its fields
      }

      const rows = await siblingFieldCandidateRows(db, { siblingIds: scoped.siblingIds, altKeys });
      const decision = resolveFieldCandidates(rows);

      if (decision.outcome === "fill" && haveInferences) {
        const confidence = Math.min(0.9, decision.confidence * 0.9);
        await upsertInference(db, {
          documentId, fieldKey, value: decision.value, confidence,
          rule: decision.alternates.length ? "sibling-fill-by-strength" : "sibling-fill",
          sourceDocumentId: decision.documentId, sourcePage: decision.page,
          candidates: [decision, ...decision.alternates],
        });
        acceptedFills.push({ field_key: fieldKey, value: decision.value, confidence });
        result.filled.push(fieldKey);
        if (haveNeedsInfo) await resolveNeedsInfo(db, { documentId, fieldKey, value: decision.value, resolvedBy: "ai:autofill" });
      } else if (decision.outcome === "conflict" && haveNeedsInfo) {
        const docLabel = documentTypeLabel(resolvedType, pack).toLowerCase();
        await upsertNeedsInfo(db, {
          documentId, entityId, fieldKey,
          question: buildFieldConflictQuestion({ fieldKey, docLabel, candidates: decision.candidates, pack }),
          candidates: decision.candidates,
        });
        result.questions.push(fieldKey);
      }
    }
  }

  // ---- 2. the ambiguous-customer case (owner's own worked example) ----
  if (haveNeedsInfo && !customerId && facts.customer_name) {
    const ambiguous = await detectAmbiguousCustomer(db, { customerName: facts.customer_name, address: facts.service_address });
    if (ambiguous) {
      await upsertNeedsInfo(db, {
        documentId, entityId: null, fieldKey: "customer_name",
        question: ambiguous.question, candidates: ambiguous.candidates,
      });
      result.questions.push("customer_name");
    }
  }

  // ---- 3. re-verify with the fills applied, if that now clears the bar ----
  if (acceptedFills.length) {
    result.verified = await verifyIfComplete(db, { documentId, resolvedType, pack, fields: [...extractedFields, ...acceptedFills] });
  }

  // ---- 4. bounded re-examination of siblings' own open questions ----
  if (haveNeedsInfo && (entityId || customerId)) {
    await reexamineSiblingNeedsInfo(db, { documentId, entityId, customerId, haveInferences });
  }

  return result;
}

/**
 * A document just finished ingestion; some sibling of it may have an OPEN needs-info row that
 * this new document's own facts can now settle (rule 3: "a warranty registration arrives after
 * the install record" — the install record's own open question about, say, installation_date
 * resolves the moment the registration states it too, or ceases to conflict). Bounded to
 * NEEDS_INFO_REEXAMINE_LIMIT rows so this can never grow into an unbounded scan.
 */
async function reexamineSiblingNeedsInfo(db, { documentId, entityId, customerId, haveInferences }) {
  const targets = [entityId, customerId].filter(Boolean);
  if (!targets.length) return;
  const { rows: open } = await db.raw(
    `SELECT n.id, n.document_id, n.field_key
       FROM intake_needs_info n
      WHERE n.${TENANT_SQL}
        AND n.status = 'open'
        AND n.document_id <> $1
        AND (
              n.entity_id = ANY($2::uuid[])
           OR EXISTS (SELECT 1 FROM document_entity_links l WHERE l.document_id = n.document_id AND l.entity_id = ANY($2::uuid[]))
           OR EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = n.document_id AND x.entity_id = ANY($2::uuid[]))
        )
      ORDER BY n.created_at ASC
      LIMIT $3`,
    [documentId, targets, NEEDS_INFO_REEXAMINE_LIMIT]
  );

  const touchedDocumentIds = new Set();
  for (const row of open) {
    // 'equipment_unit' (buildEquipmentAmbiguityQuestion) isn't a real extraction field — it asks
    // WHICH unit, not what a field's value is — and is only ever re-settled by that document's
    // OWN next extraction pass re-deriving its entityId fresh (loadDocumentContext, top of
    // runIntakeAutofillTx), never by this loop.
    if (row.field_key === "equipment_unit") continue;

    const altKeys = splitAltKeys(row.field_key);
    // Scoped by the SIBLING document's own entity/customer/facts, not the arriving document's —
    // the two need not (and for an equipment-scoped field, must not) share a unit just because
    // they share a customer. See siblingIdsForField/resolveEquipmentScope above.
    const rowCtx = await loadDocumentContext(db, row.document_id);
    if (!rowCtx) continue;
    const rowFacts = Object.fromEntries(rowCtx.fields.map((f) => [f.field_key, f.value]));
    const scoped = await siblingIdsForField(db, {
      fieldKey: row.field_key, entityId: rowCtx.entityId, customerId: rowCtx.customerId,
      facts: rowFacts, documentId: row.document_id,
    });
    if (scoped.ambiguous) continue; // still ambiguous — leave the open question as-is

    const rows = await siblingFieldCandidateRows(db, { siblingIds: scoped.siblingIds, altKeys });
    const decision = resolveFieldCandidates(rows);
    if (decision.outcome !== "fill") continue; // still unresolved or still a real conflict — leave the question open

    const confidence = Math.min(0.9, decision.confidence * 0.9);
    if (haveInferences) {
      await upsertInference(db, {
        documentId: row.document_id, fieldKey: row.field_key, value: decision.value, confidence,
        rule: "sibling-fill-late-arrival", sourceDocumentId: decision.documentId, sourcePage: decision.page,
        candidates: [decision, ...decision.alternates],
      });
    }
    await resolveNeedsInfo(db, { documentId: row.document_id, fieldKey: row.field_key, value: decision.value, resolvedBy: "ai:autofill" });
    touchedDocumentIds.add(row.document_id);
  }

  // A resolved question can be the LAST missing piece — re-check completeness for every
  // document this pass actually changed, so straight-through processing does not need a human
  // to notice the question resolved and re-open the document by hand.
  for (const docId of touchedDocumentIds) {
    const ctxDoc = await loadDocumentContext(db, docId);
    if (!ctxDoc) continue;
    const inferred = await db.raw(
      `SELECT field_key, value, confidence FROM intake_field_inferences
        WHERE document_id = $1 AND ${TENANT_SQL}`,
      [docId]
    );
    const merged = [...ctxDoc.fields, ...inferred.rows.map((r) => ({ field_key: r.field_key, value: r.value, confidence: r.confidence }))];
    await verifyIfComplete(db, { documentId: docId, resolvedType: ctxDoc.resolvedType, pack: null, fields: merged });
  }
}

/* --------------------------------------------------------------------- post-ingest hooks */

/**
 * assignDisplayName (G3, api/_lib/naming/) — guarded dynamic import because it may not exist yet
 * in this worktree (Round 12 contract: G3 owns document naming). A missing module, or a module
 * present but not yet exporting the function, is silently a no-op; nothing here ever throws.
 */
async function callAssignDisplayNameIfPresent(ctx, documentId) {
  try {
    await assignDisplayName({ withTenant, ctxArg: ctx, documentId });
  } catch (err) {
    console.error("intake-autofill: assignDisplayName hook failed (best-effort)", err?.message);
  }
}

/**
 * The three post-ingest hooks Round 12's contract assigns to whoever completes the ingest
 * pipeline, plus the autofill/needs-info engine above — one call for extractDocument.js to make.
 * Every step is independently best-effort: one failing must never block another, let alone fail
 * ingest, which has already fully succeeded by the time this runs.
 */
export async function completeIntake(ctx, documentId, info = {}) {
  const autofill = await runIntakeAutofill(ctx, documentId, info);
  await callAssignDisplayNameIfPresent(ctx, documentId);
  await refreshGraphForDocument({ withTenant, ctxArg: ctx, documentId }).catch(() => {});
  await withTenant(ctx, (db) => refreshAllRollups(db, {})).catch(() => {});
  return autofill;
}
