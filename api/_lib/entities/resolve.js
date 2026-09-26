/**
 * Entity-resolution clustering — db-facing orchestration on top of
 * similarity.js's pure blocking/scoring/clustering.
 *
 * WORKS WITHOUT M3-config/39-entity-resolution.sql: entityMergeTableExists
 * probes with the same to_regclass() idiom as graph/build.js's
 * kgEdgesTableExists / financials/store.js's financialsTableExists.
 * listMergeSuggestions computes clusters ON THE FLY when the table is absent
 * (no persistence — a "rejected" decision or an undo snapshot just doesn't
 * survive past this request); acceptMergeSuggestion still performs a real,
 * reversible-when-the-table-exists merge either way, because the merge
 * itself rides entirely on reviewStore.js's existing entities.merged_into
 * machinery, which needs no migration of its own.
 *
 * NEVER AUTO-MERGES: listMergeSuggestions only ever proposes; a human calls
 * acceptMergeSuggestion (or rejectMergeSuggestion) — see
 * api/_lib/routes/entity-merge.js.
 */
import { createHash } from 'node:crypto';
import { mergeCustomers } from '../reviewStore.js';
import { withTenant } from '../recordsStore.js';
import { possibleDuplicatePairKey } from '../integrity.js';
import { loadKeepSeparatePairs } from '../routes/customers.js';
import { generateCandidatePairs, evaluatePair, buildClusters, ENTITY_SUGGEST_THRESHOLD } from './similarity.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";

export class EntityMergeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'EntityMergeError';
    this.status = status;
  }
}

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ------------------------------------------------------------- table probe

let tableKnown = null; // memoized like financialsTableExists/kgEdgesTableExists
export function _resetEntityMergeTableProbe() { tableKnown = null; }

export async function entityMergeTableExists(db) {
  if (tableKnown != null) return tableKnown;
  try {
    const r = await db.raw("SELECT to_regclass('public.entity_merge_suggestions') IS NOT NULL AS ok", []);
    tableKnown = Boolean(r.rows[0]?.ok);
    return tableKnown;
  } catch {
    return false;
  }
}

/** Stable id for a cluster from its (sorted) entity ids — re-running the scan
 *  upserts the SAME row for the SAME set of entities rather than piling up
 *  duplicates. Exported for scripts/verify-entity-resolution.mjs. */
export function clusterId(entityIds) {
  const sorted = [...new Set(entityIds ?? [])].sort();
  return createHash('sha1').update(sorted.join(',')).digest('hex').slice(0, 24);
}

// ------------------------------------------------------------- data access

/** Every non-merged customer entity this tenant has, in the plain shape
 *  similarity.js's scoring wants. Kept to exactly the columns needed — this
 *  is a full-tenant scan, unlike routes/customers.js's paginated list. */
async function loadCustomerEntities(db) {
  const { rows } = await db.raw(
    `SELECT id, customer_number,
            data->>'customer_name' AS name, data->>'phone' AS phone,
            data->>'email' AS email, data->>'service_address' AS address
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}`,
    []
  );
  return rows;
}

/** Up to `limit` documents linked to any of `entityIds` — "evidence
 *  documents" a reviewer can open to see where the matching name/phone/
 *  email/address actually came from. Direct links only (document_entity_links)
 *  — the same primary evidence path routes/customers.js's own `via` union
 *  starts from; a customer profile's fuller equipment/name-match union is
 *  more than a quick admin card needs. */
async function loadEvidenceDocuments(db, entityIds, limitPerEntity = 3) {
  if (!entityIds?.length) return new Map();
  const { rows } = await db.raw(
    `SELECT l.entity_id, d.id, d.original_filename, d.document_type
       FROM document_entity_links l
       JOIN documents d ON d.id = l.document_id AND d.${TENANT}
      WHERE l.entity_id = ANY($1::uuid[]) AND l.${TENANT}
      ORDER BY l.entity_id, l.created_at DESC`,
    [entityIds]
  );
  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
    const list = byEntity.get(r.entity_id);
    if (list.length < limitPerEntity) list.push({ id: r.id, filename: r.original_filename, type: r.document_type });
  }
  return byEntity;
}

/** Persisted suggestion rows for this tenant, keyed by cluster_id — {} when
 *  the table doesn't exist (probed once by the caller). */
async function loadPersistedSuggestions(db) {
  const { rows } = await db.raw(
    `SELECT id, cluster_id, entity_ids, score, reasons, status, decided_by, decided_at, previous_state
       FROM entity_merge_suggestions WHERE ${TENANT}`,
    []
  );
  return new Map(rows.map((r) => [r.cluster_id, r]));
}

/** Same fuller-name/lower-number default as integrity.js's pickKeepDrop,
 *  folded across an entire cluster (not just a pair) — repeatedly picks the
 *  better of the running winner and the next candidate. */
function pickClusterKeep(entities) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ids = entities.map((e) => e.id);
  let keep = byId.get(ids[0]);
  for (let i = 1; i < ids.length; i++) {
    const candidate = byId.get(ids[i]);
    const ta = (keep.name ?? '').trim().split(/\s+/).filter(Boolean).length;
    const tb = (candidate.name ?? '').trim().split(/\s+/).filter(Boolean).length;
    if (tb > ta) { keep = candidate; continue; }
    if (tb < ta) continue;
    const na = Number(String(keep.customer_number ?? '').match(/^C-(\d+)$/)?.[1] ?? Infinity);
    const nb = Number(String(candidate.customer_number ?? '').match(/^C-(\d+)$/)?.[1] ?? Infinity);
    if (nb < na) keep = candidate;
  }
  return keep.id;
}

// ------------------------------------------------------------------ list

/**
 * Compute (and, when migration 39 is present, persist/refresh) this tenant's
 * duplicate-customer clusters. Returns
 * `{enabled, clusters: [{id, clusterId, entityIds, score, reasons, status,
 * suggestedKeepId, entities: [{id, name, customerNumber, phone, email,
 * address, documents}]}]}` — `status` is always 'pending' for a freshly
 * computed cluster that has no persisted row yet.
 *
 * `enabled` mirrors financials/graph's own convention — true whenever
 * customer data exists to scan, independent of whether migration 39 is
 * pasted (that only affects whether decisions/undo survive a refresh).
 */
export async function listMergeSuggestions(db) {
  const persisted = (await entityMergeTableExists(db)) ? await loadPersistedSuggestions(db) : new Map();

  const entities = await loadCustomerEntities(db);
  if (entities.length < 2) return { clusters: [] };

  const keepSeparatePairs = await loadKeepSeparatePairs(db);

  const byId = new Map(entities.map((e) => [e.id, e]));
  const candidatePairs = generateCandidatePairs(entities);
  const pairScores = [];
  for (const [a, b] of candidatePairs) {
    if (keepSeparatePairs.has(possibleDuplicatePairKey(a, b))) continue; // owner already said "not the same"
    const result = evaluatePair(byId.get(a), byId.get(b));
    if (result.score > 0) pairScores.push({ aId: a, bId: b, ...result });
  }

  const rawClusters = buildClusters(pairScores, { threshold: ENTITY_SUGGEST_THRESHOLD });

  const evidenceByEntity = await loadEvidenceDocuments(db, rawClusters.flatMap((c) => c.entityIds));

  const clusters = rawClusters.map((c) => {
    const cid = clusterId(c.entityIds);
    const persistedRow = persisted.get(cid);
    const clusterEntities = c.entityIds.map((id) => byId.get(id)).filter(Boolean);
    const reasons = [...new Set(c.pairs.flatMap((p) => p.reasons))];
    return {
      id: persistedRow?.id ?? null,
      clusterId: cid,
      entityIds: c.entityIds,
      score: c.score,
      reasons,
      status: persistedRow?.status ?? 'pending',
      decidedBy: persistedRow?.decided_by ?? null,
      decidedAt: persistedRow?.decided_at ?? null,
      suggestedKeepId: pickClusterKeep(clusterEntities),
      entities: clusterEntities.map((e) => ({
        id: e.id,
        name: e.name,
        customerNumber: e.customer_number,
        phone: e.phone,
        email: e.email,
        address: e.address,
        documents: evidenceByEntity.get(e.id) ?? [],
      })),
    };
  });

  if (await entityMergeTableExists(db)) {
    for (const c of clusters) {
      if (c.status !== 'pending' || c.id) continue; // never touch a row with a decision already recorded
      await db.raw(
        `INSERT INTO entity_merge_suggestions (tenant_id, cluster_id, entity_ids, score, reasons)
           SELECT (current_setting('app.tenant_id', true))::uuid, $1, $2::uuid[], $3, $4::jsonb
         ON CONFLICT (tenant_id, cluster_id) DO UPDATE
           SET entity_ids = EXCLUDED.entity_ids, score = EXCLUDED.score, reasons = EXCLUDED.reasons, updated_at = NOW()
           WHERE entity_merge_suggestions.status = 'pending'`,
        [c.clusterId, c.entityIds, c.score, JSON.stringify(c.reasons)]
      );
    }
    // Pick up the ids the inserts above just created.
    const refreshed = await loadPersistedSuggestions(db);
    for (const c of clusters) c.id = c.id ?? refreshed.get(c.clusterId)?.id ?? null;
  }

  // Rejected clusters stay out of the list entirely once decided — an admin
  // who dismissed a pair should not see it resurface on the next scan.
  return { clusters: clusters.filter((c) => c.status !== 'rejected') };
}

// ---------------------------------------------------------------- reject

export async function rejectMergeSuggestion(db, { clusterIdValue, entityIds }, actorClerkId) {
  if (!(await entityMergeTableExists(db))) {
    throw new EntityMergeError('Rejecting a suggestion needs the entity-resolution database update (M3-config/39) — ask an admin to run it.', 503);
  }
  const cid = clusterIdValue ?? clusterId(entityIds ?? []);
  const { rows } = await db.raw(
    `INSERT INTO entity_merge_suggestions (tenant_id, cluster_id, entity_ids, status, decided_by, decided_at)
       SELECT (current_setting('app.tenant_id', true))::uuid, $1, $2::uuid[], 'rejected', $3, NOW()
     ON CONFLICT (tenant_id, cluster_id) DO UPDATE
       SET status = 'rejected', decided_by = $3, decided_at = NOW(), updated_at = NOW()
       RETURNING id`,
    [cid, entityIds ?? [], actorClerkId ?? null]
  );
  return { id: rows[0]?.id ?? null, clusterId: cid, status: 'rejected' };
}

// ---------------------------------------------------------------- accept

/** Every row currently pointing AT `entityId` — extraction ids, document-link
 *  keys, and equipment ids whose customer_id names it — captured BEFORE any
 *  merge runs, so undoEntityMerge can put each one back exactly where it was
 *  rather than merely flipping merged_into back to NULL. */
async function snapshotEntity(db, entityId) {
  const entity = (await db.raw(
    `SELECT id, data, customer_number, merged_into FROM entities WHERE id = $1 AND ${TENANT}`, [entityId]
  )).rows[0];
  if (!entity) throw new EntityMergeError(`Entity ${entityId} not found in this tenant`, 404);
  const extractionIds = (await db.raw(
    `SELECT id FROM extractions WHERE entity_id = $1 AND ${TENANT}`, [entityId]
  )).rows.map((r) => r.id);
  const links = (await db.raw(
    `SELECT document_id, confidence, linked_by, created_at FROM document_entity_links WHERE entity_id = $1 AND ${TENANT}`,
    [entityId]
  )).rows;
  const equipmentIds = (await db.raw(
    `SELECT id FROM entities WHERE entity_type = 'equipment' AND customer_id = $1 AND ${TENANT}`, [entityId]
  )).rows.map((r) => r.id);
  return {
    id: entity.id, data: entity.data, customerNumber: entity.customer_number, mergedInto: entity.merged_into,
    extractionIds, links, equipmentIds,
  };
}

/**
 * Accept a cluster: merges every entity into one survivor via
 * reviewStore.js's existing mergeCustomers (repoints extractions/document
 * links/equipment, then flags merged_into — see that function's own doc
 * comment).
 *
 * THREE SEPARATE `withTenant` calls, deliberately, not one enclosing
 * transaction: mergeCustomers (reviewStore.js) opens its own connection from
 * the same pool for every merge it performs, and a caller that held its OWN
 * connection open around that call (one `withTenant` wrapping the whole
 * accept) would deadlock the moment the pool is small — the outer connection
 * waiting on its callback to return, the callback waiting on a second
 * connection the pool cannot hand out yet. Splitting into "snapshot" (one
 * transaction) / "merge each drop" (mergeCustomers' own transactions,
 * sequential) / "persist the decision" (one more transaction) is the same
 * "several small transactions, not one big one" shape mergeCustomers itself
 * already uses for its own number-housekeeping follow-up — a failure partway
 * through still leaves every entity merged so far in a fully valid, already-
 * durable state (never a half-written row), and the snapshot needed for undo
 * was already taken before anything moved.
 *
 * `keepId`, optional: which entity survives (must be one of `entityIds`);
 * defaults to the same fuller-name/lower-number pick the UI already shows
 * (pickClusterKeep). Without migration 39, the merge itself still happens
 * exactly the same way — it just cannot later be undone (nowhere to persist
 * previous_state).
 */
export async function acceptMergeSuggestion(ctx, { suggestionId, clusterIdValue, entityIds, keepId } = {}, actorClerkId) {
  const ids = [...new Set(entityIds ?? [])].filter(isUuid);
  if (ids.length < 2) throw new EntityMergeError('entityIds must name at least two customers', 400);

  const { chosenKeep, dropIds, previousState } = await withTenant(ctx, async (db) => {
    const entities = (await db.raw(
      `SELECT id, customer_number, data->>'customer_name' AS name FROM entities
        WHERE id = ANY($1::uuid[]) AND entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}`,
      [ids]
    )).rows;
    if (entities.length !== ids.length) throw new EntityMergeError('One or more customers were not found (already merged, or in another tenant)', 404);

    const keep = keepId && ids.includes(keepId) ? keepId : pickClusterKeep(entities);
    const drops = ids.filter((id) => id !== keep);
    const state = { keep: await snapshotEntity(db, keep), drops: [] };
    for (const dropId of drops) state.drops.push(await snapshotEntity(db, dropId));
    return { chosenKeep: keep, dropIds: drops, previousState: state };
  });

  for (const dropId of dropIds) {
    await mergeCustomers(ctx, { keepId: chosenKeep, dropId }, actorClerkId);
  }

  const cid = clusterIdValue ?? clusterId(ids);
  const persistedId = await withTenant(ctx, async (db) => {
    if (!(await entityMergeTableExists(db))) return suggestionId ?? null;
    const { rows } = await db.raw(
      `INSERT INTO entity_merge_suggestions (tenant_id, cluster_id, entity_ids, status, decided_by, decided_at, previous_state)
         SELECT (current_setting('app.tenant_id', true))::uuid, $1, $2::uuid[], 'accepted', $3, NOW(), $4::jsonb
       ON CONFLICT (tenant_id, cluster_id) DO UPDATE
         SET status = 'accepted', decided_by = $3, decided_at = NOW(), previous_state = $4::jsonb,
             entity_ids = EXCLUDED.entity_ids, updated_at = NOW()
         RETURNING id`,
      [cid, ids, actorClerkId ?? null, JSON.stringify(previousState)]
    );
    return rows[0]?.id ?? suggestionId ?? null;
  });

  return { id: persistedId, clusterId: cid, keepId: chosenKeep, droppedIds: dropIds, mergedCount: dropIds.length };
}

// ------------------------------------------------------------------ undo

/**
 * Undo an accepted merge: restores every merged entity's pre-merge data/
 * customer_number/merged_into AND re-points the exact extraction/document-
 * link/equipment rows previousState captured — a targeted restore of only
 * what THIS merge moved, so an unrelated edit made since (a new document
 * linked to the survivor, say) is left untouched. Requires migration 39 (the
 * previous_state snapshot lives only there); without it there is nothing to
 * undo from, so this refuses cleanly rather than guessing.
 *
 * Sets the suggestion back to 'pending' (not a new enum value — undo is "the
 * decision didn't stick", which is exactly what pending already means) so it
 * can be reviewed again; previous_state is left in place (harmless — a later
 * accept overwrites it with a fresh snapshot).
 */
export async function undoMergeSuggestion(db, { suggestionId }, actorClerkId) {
  if (!(await entityMergeTableExists(db))) {
    throw new EntityMergeError('Undo needs the entity-resolution database update (M3-config/39) — ask an admin to run it.', 503);
  }
  const row = (await db.raw(
    `SELECT id, entity_ids, status, previous_state FROM entity_merge_suggestions WHERE id = $1 AND ${TENANT}`,
    [suggestionId]
  )).rows[0];
  if (!row) throw new EntityMergeError('Suggestion not found', 404);
  if (row.status !== 'accepted' || !row.previous_state) {
    throw new EntityMergeError('Only an accepted merge with a recorded previous state can be undone', 409);
  }

  const { keep, drops } = row.previous_state;

  // Reviewer NO-GO fix: mergeCustomers' copy of a drop's link onto keep is
  // ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING — so when keep
  // ALREADY had its own link to a document a drop also linked to (same
  // document_id, any confidence/linked_by — the conflict target ignores
  // those columns), the copy is a no-op and keep's original row is left
  // completely untouched by the merge. Undo must therefore never delete
  // keep's row for a document_id that appears in keep's OWN pre-merge
  // snapshot (`keepPreMergeDocIds`, captured before ANY of this accept's
  // merges ran) — doing so would delete a link the merge never touched and
  // hand it to the resurrected drop, corrupting a record nothing here
  // actually moved. When the document_id is NOT in that snapshot, the copy
  // DID land on keep (nothing was there to conflict with) and is safe to
  // remove. Either way, the drop's own original row is always restored
  // exactly, since the merge unconditionally deleted it regardless of
  // whether its copy onto keep succeeded or was skipped.
  const keepPreMergeDocIds = new Set((keep.links ?? []).map((l) => l.document_id));

  for (const drop of drops) {
    // Bring the dropped entity back to life first — extractions/links below
    // reference it, and entities has no FK ordering issue either way, but
    // doing this first means every subsequent statement finds a live row.
    await db.raw(
      `UPDATE entities SET data = $2::jsonb, customer_number = $3, merged_into = NULL, updated_at = NOW()
        WHERE id = $1 AND ${TENANT}`,
      [drop.id, drop.data, drop.customerNumber]
    );
    // extractions/equipment have no such conflict: both are plain per-row
    // repoints (extractions has no uniqueness on entity_id; customer_id is an
    // ordinary foreign key, not unique), so moving back the EXACT ids this
    // merge captured can never disturb a row that belongs to keep.
    if (drop.extractionIds?.length) {
      await db.raw(`UPDATE extractions SET entity_id = $2 WHERE id = ANY($1::uuid[]) AND ${TENANT}`, [drop.extractionIds, drop.id]);
    }
    for (const link of drop.links ?? []) {
      if (!keepPreMergeDocIds.has(link.document_id)) {
        await db.raw(
          `DELETE FROM document_entity_links
            WHERE document_id = $1 AND entity_id = $2 AND confidence IS NOT DISTINCT FROM $3
              AND linked_by IS NOT DISTINCT FROM $4 AND ${TENANT}`,
          [link.document_id, keep.id, link.confidence, link.linked_by]
        );
      }
      await db.raw(
        `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
           SELECT (current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5
         ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
        [link.document_id, drop.id, link.confidence, link.linked_by, link.created_at]
      );
    }
    if (drop.equipmentIds?.length) {
      await db.raw(
        `UPDATE entities SET customer_id = $2 WHERE id = ANY($1::uuid[]) AND customer_id = $3 AND ${TENANT}`,
        [drop.equipmentIds, drop.id, keep.id]
      );
    }
  }

  // The survivor's own data/customer_number were coalesced/renumbered during
  // accept — put them back to what they were immediately before this merge.
  await db.raw(
    `UPDATE entities SET data = $2::jsonb, customer_number = $3, updated_at = NOW() WHERE id = $1 AND ${TENANT}`,
    [keep.id, keep.data, keep.customerNumber]
  );

  await db.raw(
    `UPDATE entity_merge_suggestions SET status = 'pending', decided_by = $2, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND ${TENANT}`,
    [suggestionId, actorClerkId ?? null]
  );
  await db.raw(
    `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at)
     VALUES ((current_setting('app.tenant_id', true))::uuid, 'review.entity_merge_undone', 'entity', $1, $2::jsonb, NOW())`,
    [keep.id, JSON.stringify({ suggestionId, restoredEntityIds: [keep.id, ...drops.map((d) => d.id)] })]
  );

  return { id: suggestionId, keepId: keep.id, restoredIds: drops.map((d) => d.id) };
}
