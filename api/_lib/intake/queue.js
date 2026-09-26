/**
 * THE CLEAN EXCEPTION QUEUE — read-only listing over what Round 12's autofill engine
 * (api/_lib/intake/autofill.js) already wrote (Round 13, H2, research #2/#7: "uploads should fill
 * everything automatically, humans only when truly needed").
 *
 * Every question autofill.js raises is already a complete, precise thing (see its own header):
 * a plain-language `question`, and `candidates` that are either sourced values (a field conflict —
 * "Mike Rivera" from one document, "Miguel Rivera" from another, each with a document+page) or
 * entity picks (the ambiguous-unit / ambiguous-customer cases — "which ONE of these existing
 * records is this about"). This module's only job is to read that back out in the shape the Inbox
 * UI (src/components/intake/**, src/services/intakeClient.ts) and the Scan tab's post-upload
 * status want, plus enough surrounding context (a document's OTHER filled fields, with
 * provenance) that "Why are we asking?" and the confidence chips have something real to show.
 *
 * NO MODEL CALL ANYWHERE — every field here is a read against tables autofill.js/documentTypes.js
 * already populate. Tolerant of migration 43 (intake_field_inferences / intake_needs_info) and 45
 * (snoozed_until) not being pasted yet, same idiom as autofill.js itself.
 */
import { TENANT_SQL } from "../scope.js";
import { fieldLabel, documentTypeLabel, normalizeDocumentType, completenessFor } from "../documentTypes.js";
import { needsInfoTableExists, inferencesTableExists } from "./autofill.js";
import { documentsHaveDisplayName } from "../recordsStore.js";

/** Adapts the store's `db.raw(sql, params)` to the `{query}` shape documentsHaveDisplayName wants
 *  (that helper is shared with recordsStore.js's own internals, which call it with a raw pg
 *  client). Keeps this module's only dependency on recordsStore.js to the one cached probe. */
function asQueryable(db) {
  return { query: (sql, params) => db.raw(sql, params) };
}

let snoozedColumnKnown = null;
export function _resetIntakeQueueProbesForTests() {
  snoozedColumnKnown = null;
}
async function needsInfoHasSnooze(db) {
  if (snoozedColumnKnown != null) return snoozedColumnKnown;
  try {
    const r = await db.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='intake_needs_info' AND column_name='snoozed_until'`,
      []
    );
    snoozedColumnKnown = r.rowCount > 0;
  } catch {
    return false;
  }
  return snoozedColumnKnown;
}

/** Every distinct document_id referenced by a batch of needs-info rows' own JSONB `candidates`
 *  (field-conflict candidates carry `documentId`), batch-fetched once into a {id -> label} map so
 *  "which document said Mike Rivera" reads as a real name, not a bare uuid. */
async function fetchDocLabels(db, ids, haveDisplayName) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { rows } = await db.raw(
    `SELECT id, document_type, original_filename${haveDisplayName ? ', display_name' : ''}
       FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
    [unique]
  );
  const map = new Map();
  for (const r of rows) {
    const dn = haveDisplayName ? r.display_name : null;
    map.set(r.id, (dn && dn.trim()) || documentTypeLabel(normalizeDocumentType(r.document_type)) || r.original_filename || 'Document');
  }
  return map;
}

/** One candidate, normalized for the UI regardless of which of autofill.js's three question
 *  builders produced it — a sourced value (documentId+page, an "evidence" excerpt) or an entity
 *  pick (equipment unit / customer match, no document evidence, just what's on file for it). */
function normalizeCandidate(raw, docLabels, evidenceByKey) {
  const hasEntity = raw && typeof raw === 'object' && 'entityId' in raw;
  const documentId = raw?.documentId ?? null;
  const page = raw?.page ?? null;
  const evidence = documentId != null ? evidenceByKey.get(`${documentId}|${page}`) ?? null : null;
  return {
    kind: hasEntity ? 'entity' : 'value',
    label: raw?.value ?? raw?.label ?? '',
    value: raw?.value ?? null,
    entityId: raw?.entityId ?? null,
    address: raw?.address ?? null,
    documentId,
    page,
    sourceDocumentLabel: documentId ? (docLabels.get(documentId) ?? null) : null,
    evidence,
  };
}

/** Verbatim excerpts (facets.value_raw) for the (documentId, page) pairs a page of candidates
 *  actually references — best-effort: a document read before facets existed, or a candidate with
 *  no page at all, simply gets no excerpt, never an error. */
async function fetchEvidence(db, pairs) {
  const map = new Map();
  const docIds = [...new Set(pairs.map((p) => p.documentId).filter(Boolean))];
  if (!docIds.length) return map;
  const { rows } = await db.raw(
    `SELECT document_id, page_no, value_raw, label_raw, mapped_field_key
       FROM facets WHERE document_id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
    [docIds]
  );
  for (const { documentId, page, fieldKey } of pairs) {
    if (documentId == null || page == null) continue;
    const key = `${documentId}|${page}`;
    if (map.has(key)) continue;
    const hit = rows.find((r) => r.document_id === documentId && r.page_no === page && (!fieldKey || r.mapped_field_key === fieldKey))
      ?? rows.find((r) => r.document_id === documentId && r.page_no === page);
    if (hit?.value_raw) map.set(key, hit.value_raw);
  }
  return map;
}

/** A document's own filled fields (stated in `extractions`, or inferred by autofill.js into
 *  `intake_field_inferences`) as confidence chips: {fieldKey, label, value, confidence, source,
 *  provenance}. Stated always wins over inferred for the same field_key (should not overlap in
 *  practice — inferences only ever fill what completenessFor already called missing — but a
 *  correction landing between the inference being written and this read is exactly the kind of
 *  race this guards against). */
async function fetchFilledFields(db, documentId, { haveInferences, docLabels }) {
  const stated = await db.raw(
    `SELECT field_key, COALESCE(corrected_value, value) AS value, confidence, corrected_by
       FROM extractions
      WHERE document_id = $1 AND ${TENANT_SQL}
        AND COALESCE(corrected_value, value) IS NOT NULL AND btrim(COALESCE(corrected_value, value)) <> ''`,
    [documentId]
  );
  const byKey = new Map();
  for (const r of stated.rows) {
    byKey.set(r.field_key, {
      fieldKey: r.field_key, label: fieldLabel(r.field_key), value: r.value,
      confidence: r.corrected_by ? 1 : Number(r.confidence ?? 0),
      source: r.corrected_by ? 'corrected' : 'stated',
      correctedBy: r.corrected_by ?? null,
      provenance: null,
    });
  }
  if (haveInferences) {
    const inferred = await db.raw(
      `SELECT field_key, value, confidence, rule, source_document_id, source_page
         FROM intake_field_inferences WHERE document_id = $1 AND ${TENANT_SQL}`,
      [documentId]
    );
    for (const r of inferred.rows) {
      if (byKey.has(r.field_key)) continue; // a real, stated/corrected value always wins
      const srcLabel = r.source_document_id ? (docLabels.get(r.source_document_id) ?? 'another document') : 'a linked record';
      byKey.set(r.field_key, {
        fieldKey: r.field_key, label: fieldLabel(r.field_key), value: r.value,
        confidence: Number(r.confidence ?? 0), source: 'inferred', correctedBy: null,
        provenance: `Inferred from ${srcLabel}${r.source_page ? ` p.${r.source_page}` : ''}`,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

/** {name, value, correctedValue, location} tuples for the fields src/core/documentName.ts's
 *  deriveName reads (customer_name, service_address, manufacturer/model, cost, dates, ...) — just
 *  enough for the client's existing documentName(doc) to compute the same title it shows
 *  everywhere else, without this endpoint having to duplicate that naming logic server-side. Every
 *  filled field qualifies (both stated and inferred — an inferred customer name is still the name). */
function toExtractedShape(filledFields) {
  return filledFields.map((f) => ({ name: f.fieldKey, value: f.value, correctedValue: undefined, confidence: f.confidence, location: {} }));
}

/**
 * The Inbox queue: one card per document with an open (unsnoozed) question, oldest first.
 * @returns {Promise<{items: object[], nextCursor: string|null, openDocumentCount: number, tracked: boolean}>}
 */
export async function listIntakeQueue(db, { limit = 20, cursor = null } = {}) {
  const tracked = await needsInfoTableExists(db);
  if (!tracked) return { items: [], nextCursor: null, openDocumentCount: 0, tracked: false };

  const haveDisplayName = await documentsHaveDisplayName(asQueryable(db));
  const haveInferences = await inferencesTableExists(db);
  const haveSnooze = await needsInfoHasSnooze(db);
  const snoozeClause = haveSnooze ? "AND (n.snoozed_until IS NULL OR n.snoozed_until <= NOW())" : "";

  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));

  // One row per DOCUMENT (its earliest-raised open question — the "ONE question" a card shows),
  // via DISTINCT ON; a document with more than one open question gets a `moreQuestions` count
  // below rather than a second card, so resolving the shown one is what surfaces the next.
  const { rows: earliest } = await db.raw(
    `SELECT DISTINCT ON (n.document_id) n.id, n.document_id, n.entity_id, n.field_key, n.question, n.candidates, n.created_at
       FROM intake_needs_info n
      WHERE n.${TENANT_SQL} AND n.status = 'open' ${snoozeClause}
      ORDER BY n.document_id, n.created_at ASC, n.id ASC`,
    []
  );

  const [ts, afterId] = cursor ? String(cursor).split('|') : [null, null];
  let page = earliest.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : String(a.id).localeCompare(String(b.id))));
  if (ts) {
    page = page.filter((r) => {
      const t = new Date(r.created_at).toISOString();
      return t > ts || (t === ts && String(r.id) > String(afterId));
    });
  }
  const openDocumentCount = earliest.length;
  const hasMore = page.length > boundedLimit;
  page = page.slice(0, boundedLimit);
  if (!page.length) return { items: [], nextCursor: null, openDocumentCount, tracked: true };

  const docIds = page.map((r) => r.document_id);
  const { rows: docRows } = await db.raw(
    `SELECT id, document_type, stage, original_filename${haveDisplayName ? ', display_name' : ''}
       FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
    [docIds]
  );
  const docById = new Map(docRows.map((r) => [r.id, r]));

  // Additional open questions per document beyond the one shown (for a "+N more" note).
  const { rows: countRows } = await db.raw(
    `SELECT document_id, count(*)::int AS n FROM intake_needs_info n
      WHERE n.${TENANT_SQL} AND n.status = 'open' ${snoozeClause} AND n.document_id = ANY($1::uuid[])
      GROUP BY document_id`,
    [docIds]
  );
  const openCountByDoc = new Map(countRows.map((r) => [r.document_id, r.n]));

  // Candidate evidence: batch-collect (documentId, page) pairs across every candidate on this page.
  const candDocIds = [];
  const evidencePairs = [];
  for (const row of page) {
    for (const c of Array.isArray(row.candidates) ? row.candidates : []) {
      if (c?.documentId) {
        candDocIds.push(c.documentId);
        evidencePairs.push({ documentId: c.documentId, page: c.page ?? null, fieldKey: row.field_key });
      }
    }
  }
  const docLabels = await fetchDocLabels(db, candDocIds, haveDisplayName);
  const evidenceByKey = await fetchEvidence(db, evidencePairs);

  const items = [];
  for (const row of page) {
    const doc = docById.get(row.document_id);
    if (!doc) continue; // deleted between the two reads — skip rather than crash the whole page
    const filledFields = await fetchFilledFields(db, row.document_id, { haveInferences, docLabels });
    const type = normalizeDocumentType(doc.document_type);
    items.push({
      needsInfoId: row.id,
      documentId: row.document_id,
      entityId: row.entity_id,
      documentType: type,
      documentTypeLabel: documentTypeLabel(type),
      displayName: haveDisplayName ? (doc.display_name ?? null) : null,
      filename: doc.original_filename,
      stage: doc.stage,
      fieldKey: row.field_key,
      fieldLabel: fieldLabel(row.field_key),
      question: row.question,
      candidates: (Array.isArray(row.candidates) ? row.candidates : []).map((c) => normalizeCandidate(c, docLabels, evidenceByKey)),
      moreQuestions: Math.max(0, (openCountByDoc.get(row.document_id) ?? 1) - 1),
      filledFields,
      extracted: toExtractedShape(filledFields),
      createdAt: row.created_at,
    });
  }

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null;
  return { items, nextCursor, openDocumentCount, tracked: true };
}

/**
 * Post-upload status for the Scan tab (src/mobile/ScanTab.tsx): a handful of just-ingested
 * document ids -> "Reading… / Filled X of Y fields… / Needs N answer", each with enough to link
 * straight to the one open question if there is one. Deliberately NOT api/document-status.js
 * (owned by another file, not this feature) — this reads intake_field_inferences ALONGSIDE
 * extractions, so a document the autofill engine already completed (fields it never itself
 * printed, filled from a sibling) correctly shows as fully filled here, not "missing".
 */
export async function documentIntakeSummaries(db, documentIds) {
  const ids = [...new Set((documentIds ?? []).filter(Boolean))].slice(0, 50);
  if (!ids.length) return [];

  const tracked = await needsInfoTableExists(db);
  const haveInferences = await inferencesTableExists(db);
  const { rows: docRows } = await db.raw(
    `SELECT id, document_type, stage, extracted_at FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
    [ids]
  );

  const { rows: extRows } = await db.raw(
    `SELECT document_id, field_key, COALESCE(corrected_value, value) AS value, confidence
       FROM extractions WHERE document_id = ANY($1::uuid[]) AND ${TENANT_SQL}
        AND COALESCE(corrected_value, value) IS NOT NULL AND btrim(COALESCE(corrected_value, value)) <> ''`,
    [ids]
  );
  const fieldsByDoc = new Map();
  for (const r of extRows) {
    if (!fieldsByDoc.has(r.document_id)) fieldsByDoc.set(r.document_id, []);
    fieldsByDoc.get(r.document_id).push({ field_key: r.field_key, value: r.value, confidence: r.confidence });
  }
  if (haveInferences) {
    const { rows: infRows } = await db.raw(
      `SELECT document_id, field_key, value, confidence FROM intake_field_inferences WHERE document_id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
      [ids]
    );
    for (const r of infRows) {
      if (!fieldsByDoc.has(r.document_id)) fieldsByDoc.set(r.document_id, []);
      fieldsByDoc.get(r.document_id).push({ field_key: r.field_key, value: r.value, confidence: r.confidence });
    }
  }

  let openByDoc = new Map();
  if (tracked) {
    const { rows: niRows } = await db.raw(
      `SELECT DISTINCT ON (document_id) document_id, field_key, question
         FROM intake_needs_info WHERE document_id = ANY($1::uuid[]) AND ${TENANT_SQL} AND status = 'open'
        ORDER BY document_id, created_at ASC`,
      [ids]
    );
    openByDoc = new Map(niRows.map((r) => [r.document_id, { fieldKey: r.field_key, question: r.question }]));
  }

  return docRows.map((d) => {
    const type = normalizeDocumentType(d.document_type);
    const fields = fieldsByDoc.get(d.id) ?? [];
    const completeness = completenessFor(type, fields);
    const openQuestion = openByDoc.get(d.id) ?? null;
    return {
      documentId: d.id,
      stage: d.stage,
      read: Boolean(d.extracted_at),
      totalRequired: completeness.required.length,
      filledCount: completeness.present.length,
      verified: d.stage === 'verified',
      openQuestion,
    };
  });
}
