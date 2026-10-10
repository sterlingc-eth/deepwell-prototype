/**
 * "Review duplicates" for admins — whole-tenant duplicate groups, one-click
 * "Merge all exact duplicates", and "This is us" (a customer record that is
 * really the company's own name). Reached only through
 * api/_lib/routes/entity-merge.js (admin-gated, tenant-scoped).
 *
 * Merging itself is NOT re-implemented here: every merge goes through
 * resolve.js's acceptMergeSuggestion -> reviewStore.js's mergeCustomers, which
 * moves every extraction, document link and equipment unit (customer_id) onto
 * the kept record, fills blanks, keeps other sites as `other_addresses`, and
 * keeps a snapshot so the existing "undo" restores it. Each bulk run also
 * writes an audit_log row, so there is a record even where the undo table is
 * not installed.
 *
 * "This is us" writes one audit_log row holding everything it changed, which
 * undoCompanyMark reads back.
 */
import { withTenant } from '../recordsStore.js';
import { groupDuplicateCustomers } from '../integrity.js';
import { COMPANY_FOLDER_FIELD_KEY } from '../companyFiles.js';
import { acceptMergeSuggestion, undoMergeSuggestion, EntityMergeError } from './resolve.js';

const TENANT = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_US = "COALESCE(e.data->>'is_company', '') <> 'true'";
/** The company-papers folder a "This is us" record's documents go to. */
export const COMPANY_PAPER_FOLDER = 'company-admin';

async function loadCustomerRecords(db) {
  const { rows } = await db.raw(
    `SELECT e.id, e.customer_number, e.data->>'customer_name' AS name, e.data->>'service_address' AS address,
            e.data->>'phone' AS phone, e.data->>'email' AS email,
            (SELECT COUNT(DISTINCT l.document_id)::int FROM document_entity_links l WHERE l.entity_id = e.id AND l.${TENANT}) AS doc_count,
            (SELECT COUNT(*)::int FROM document_entity_links l WHERE l.entity_id = e.id AND l.${TENANT}) AS link_count,
            (SELECT COUNT(*)::int FROM entities q WHERE q.entity_type = 'equipment' AND q.customer_id = e.id AND q.${TENANT}) AS equipment_count
       FROM entities e
      WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND ${NOT_US} AND e.${TENANT}
      ORDER BY e.customer_number NULLS LAST, e.id`,
    []
  );
  return rows.map((r) => ({
    id: r.id, customerNumber: r.customer_number, name: r.name ?? '', address: r.address ?? '', phone: r.phone ?? '', email: r.email ?? '',
    docCount: r.doc_count, linkCount: r.link_count, equipmentCount: r.equipment_count,
  }));
}

async function ownCompanyName(db) {
  const { rows } = await db.raw(`SELECT name FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid`, []);
  return rows[0]?.name ?? '';
}

/** A group is only safe to merge in bulk when each record shares a phone, email or address with another record in it. A matching name alone is not enough. */
const digits = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);
const addrKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function corroborated(members) {
  const keys = members.map((m) => {
    const k = new Set();
    if (digits(m.phone).length >= 7) k.add(`p:${digits(m.phone)}`);
    if (String(m.email ?? '').includes('@')) k.add(`e:${String(m.email).trim().toLowerCase()}`);
    if (addrKey(m.address).length >= 6) k.add(`a:${addrKey(m.address)}`);
    return k;
  });
  return keys.every((k, i) => [...k].some((x) => keys.some((o, j) => j !== i && o.has(x))));
}

const member = (r) => ({
  id: r.id, customerNumber: r.customerNumber, name: r.name, address: r.address, phone: r.phone, email: r.email,
  documents: r.docCount, links: r.linkCount, equipment: r.equipmentCount,
});

/**
 * Every duplicate group in the tenant (no 200-row cap), each with a suggested
 * main record and how many documents / links / units it touches.
 */
export async function reviewDuplicates(db) {
  const [records, own] = await Promise.all([loadCustomerRecords(db), ownCompanyName(db)]);
  const byId = new Map(records.map((r) => [r.id, r]));
  const g = groupDuplicateCustomers(records, { ownNames: own ? [own] : [] });
  const shape = (x, extra) => {
    const ms = x.ids.map((id) => byId.get(id)).filter(Boolean).map(member);
    return {
      ...extra, ids: x.ids, mainId: x.mainId, members: ms,
      totals: { records: ms.length, documents: ms.reduce((n, m) => n + m.documents, 0), links: ms.reduce((n, m) => n + m.links, 0), equipment: ms.reduce((n, m) => n + m.equipment, 0) },
    };
  };
  const exact = g.exact.map((x) => {
    const grp = shape(x, { key: x.key, name: x.name, safe: x.safe, conflicts: x.conflicts });
    const nameOnly = x.safe && !corroborated(grp.members);
    return nameOnly ? { ...grp, safe: false, nameOnly: true } : grp;
  });
  const near = g.near.map((x, i) => shape(x, { key: `near-${i}-${x.mainId}`, name: x.name, reasons: x.reasons }));
  const self = g.self.map(member);
  return {
    companyName: own,
    exact, near, self,
    summary: {
      customers: records.length,
      exactGroups: exact.length, exactSafeGroups: exact.filter((x) => x.safe).length,
      extraRecordsInExactSafe: exact.filter((x) => x.safe).reduce((n, x) => n + x.ids.length - 1, 0),
      nearGroups: near.length, selfRecords: self.length,
    },
  };
}

export const RECENT_DAYS = 14;

/**
 * Recent bulk changes (merge-all runs and "This is us"), read back from the audit log so an Undo is still there
 * after a reload. `undoable` is how many pieces can still be put back.
 */
export async function recentChanges(db, { days = RECENT_DAYS } = {}) {
  const d = Math.min(Math.max(Number(days) || RECENT_DAYS, 1), 90);
  const { rows } = await db.raw(
    `SELECT id, action, changes, created_at FROM audit_log
      WHERE action IN ('customers.merge_all_exact', 'customers.this_is_us') AND ${TENANT}
        AND created_at > NOW() - make_interval(days => $1::int)
      ORDER BY created_at DESC LIMIT 50`, [d]
  );
  const undoneUs = new Set((await db.raw(`SELECT changes->>'logId' AS id FROM audit_log WHERE action = 'customers.this_is_us_undone' AND ${TENANT}`, [])).rows.map((r) => r.id));
  const out = [];
  for (const r of rows) {
    const c = r.changes ?? {};
    if (r.action === 'customers.this_is_us') {
      out.push({ id: r.id, kind: 'this-is-us', at: r.created_at, records: (c.entities ?? []).length, documents: (c.movedDocumentIds ?? []).length, undoable: undoneUs.has(r.id) ? 0 : 1 });
    } else {
      const ids = (c.groups ?? []).map((g) => g.suggestionId).filter((x) => typeof x === 'string' && UUID_RE.test(x));
      const live = ids.length ? (await db.raw(`SELECT id FROM entity_merge_suggestions WHERE id = ANY($1::uuid[]) AND status = 'accepted' AND ${TENANT}`, [ids])).rows.length : 0;
      out.push({ id: r.id, kind: 'merge-all', at: r.created_at, groups: (c.groups ?? []).length, records: (c.groups ?? []).reduce((n, g) => n + (g.droppedIds ?? []).length, 0), undoable: live });
    }
  }
  return { days: d, items: out };
}

/** Undo every still-merged group of one merge-all run (skips groups already undone). */
export async function undoMergeAll(ctx, { logId } = {}, actorClerkId) {
  if (typeof logId !== 'string' || !UUID_RE.test(logId)) throw new EntityMergeError('logId is required', 400);
  const row = (await withTenant(ctx, (db) => db.raw(`SELECT changes FROM audit_log WHERE id = $1 AND action = 'customers.merge_all_exact' AND ${TENANT}`, [logId]))).rows[0];
  if (!row) throw new EntityMergeError('Nothing to undo', 404);
  const ids = (row.changes?.groups ?? []).map((g) => g.suggestionId).filter((x) => typeof x === 'string' && UUID_RE.test(x));
  const live = new Set(ids.length ? (await withTenant(ctx, (db) => db.raw(`SELECT id FROM entity_merge_suggestions WHERE id = ANY($1::uuid[]) AND status = 'accepted' AND ${TENANT}`, [ids]))).rows.map((r) => r.id) : []);
  let restored = 0;
  for (const id of ids.filter((x) => live.has(x))) {
    await withTenant(ctx, (db) => undoMergeSuggestion(db, { suggestionId: id }, actorClerkId));
    restored += 1;
  }
  if (!restored) throw new EntityMergeError('This was already undone', 409);
  return { restoredGroups: restored };
}

/**
 * Merge every SAFE exact-name group (nothing disagreeing on phone/email/city, and a phone, email or address matching)
 * into its main record. Time-boxed so one call stays inside the function
 * limit: call again while `remaining` > 0. Groups that fail are reported, not
 * retried in the same run.
 */
export async function mergeAllExact(ctx, actorClerkId, { budgetMs = 40000, maxGroups = 200 } = {}) {
  const started = Date.now();
  const review = await withTenant(ctx, (db) => reviewDuplicates(db));
  const todo = review.exact.filter((g) => g.safe);
  const merged = [];
  const failed = [];
  for (const g of todo) {
    if (merged.length + failed.length >= maxGroups || Date.now() - started > budgetMs) break;
    try {
      const r = await acceptMergeSuggestion(ctx, { entityIds: g.ids, keepId: g.mainId }, actorClerkId);
      merged.push({ name: g.name, keepId: r.keepId, droppedIds: r.droppedIds, suggestionId: r.id, documents: g.totals.documents, links: g.totals.links, equipment: g.totals.equipment });
    } catch (err) {
      failed.push({ name: g.name, reason: err?.message ?? 'failed' });
    }
  }
  if (merged.length || failed.length) {
    await withTenant(ctx, (db) => db.logAction({
      clerk_user_id: actorClerkId, action: 'customers.merge_all_exact', resource_type: 'tenant',
      changes: { groups: merged.map((m) => ({ name: m.name, keepId: m.keepId, droppedIds: m.droppedIds, suggestionId: m.suggestionId })), failed },
    }));
  }
  return {
    merged, failed,
    remaining: Math.max(0, todo.length - merged.length - failed.length),
    needsReview: review.exact.filter((g) => !g.safe).length,
  };
}

/**
 * "This is us": the listed customer records are the company's own name. In one
 * transaction: their documents become company papers (a saved folder choice,
 * unless the paper also belongs to a real customer), their links are removed,
 * equipment pointing at them is left without a customer, and each record is
 * flagged `is_company` so it leaves the customer list. A single audit_log row
 * holds the full previous state for undoCompanyMark.
 */
export async function markAsCompany(ctx, { entityIds } = {}, actorClerkId) {
  const ids = [...new Set((entityIds ?? []).filter((x) => typeof x === 'string' && UUID_RE.test(x)))].slice(0, 100);
  if (!ids.length) throw new EntityMergeError('entityIds is required', 400);
  return withTenant(ctx, async (db) => {
    const ents = (await db.raw(
      `SELECT id, data, customer_number FROM entities
        WHERE id = ANY($1::uuid[]) AND entity_type = 'customer' AND merged_into IS NULL AND ${TENANT}`, [ids]
    )).rows;
    if (ents.length !== ids.length) throw new EntityMergeError('One or more customers were not found (already merged, or in another tenant)', 404);

    const links = (await db.raw(
      `SELECT entity_id, document_id, confidence, linked_by, created_at FROM document_entity_links
        WHERE entity_id = ANY($1::uuid[]) AND ${TENANT}`, [ids]
    )).rows;
    const equipmentIds = (await db.raw(
      `SELECT id, customer_id FROM entities WHERE entity_type = 'equipment' AND customer_id = ANY($1::uuid[]) AND ${TENANT}`, [ids]
    )).rows;
    const docIds = [...new Set(links.map((l) => l.document_id))];

    // A paper that also names a real customer stays customer paper.
    const shared = docIds.length ? new Set((await db.raw(
      `SELECT DISTINCT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id AND e.${TENANT}
        WHERE l.document_id = ANY($1::uuid[]) AND l.entity_id <> ALL($2::uuid[]) AND e.entity_type = 'customer'
          AND e.merged_into IS NULL AND ${NOT_US} AND l.${TENANT}`, [docIds, ids]
    )).rows.map((r) => r.document_id)) : new Set();
    const movable = docIds.filter((d) => !shared.has(d));
    const previous = movable.length ? (await db.raw(
      `SELECT DISTINCT ON (document_id) document_id, value FROM extractions
        WHERE document_id = ANY($1::uuid[]) AND field_key = $2 AND ${TENANT} ORDER BY document_id, created_at DESC, id DESC`,
      [movable, COMPANY_FOLDER_FIELD_KEY]
    )).rows : [];
    const prevByDoc = new Map(previous.map((r) => [r.document_id, r.value]));
    // a folder the person already chose is kept; unset or "customer" becomes company papers
    const toWrite = movable.filter((d) => !prevByDoc.has(d) || prevByDoc.get(d) === 'customer');
    const replaced = toWrite.filter((d) => prevByDoc.has(d)).map((d) => ({ documentId: d, value: prevByDoc.get(d) }));
    for (const d of toWrite) {
      await db.raw(`DELETE FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT}`, [d, COMPANY_FOLDER_FIELD_KEY]);
      await db.raw(
        `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, 1, NOW())`,
        [d, COMPANY_FOLDER_FIELD_KEY, COMPANY_PAPER_FOLDER]
      );
    }
    await db.raw(`DELETE FROM document_entity_links WHERE entity_id = ANY($1::uuid[]) AND ${TENANT}`, [ids]);
    if (equipmentIds.length) {
      await db.raw(`UPDATE entities SET customer_id = NULL WHERE id = ANY($1::uuid[]) AND ${TENANT}`, [equipmentIds.map((e) => e.id)]);
    }
    await db.raw(
      `UPDATE entities SET data = COALESCE(data, '{}'::jsonb) || '{"is_company": true}'::jsonb, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND ${TENANT}`, [ids]
    );

    const state = {
      entities: ents.map((e) => ({ id: e.id, data: e.data, customerNumber: e.customer_number })),
      links, equipment: equipmentIds, movedDocumentIds: toWrite, replacedFolderChoices: replaced, keptAsCustomerPaper: [...shared],
    };
    const logged = await db.raw(
      `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, 'customers.this_is_us', 'entity', $1, $2::jsonb, NOW()) RETURNING id`,
      [ids[0], JSON.stringify({ actor: actorClerkId ?? null, ...state })]
    );
    return {
      logId: logged.rows[0]?.id ?? null, markedIds: ids,
      documentsMoved: toWrite.length, documentsKeptWithCustomers: shared.size, equipmentUnassigned: equipmentIds.length,
    };
  });
}

/** Put a "This is us" action back exactly as it was. */
export async function undoCompanyMark(ctx, { logId } = {}, actorClerkId) {
  if (typeof logId !== 'string' || !UUID_RE.test(logId)) throw new EntityMergeError('logId is required', 400);
  return withTenant(ctx, async (db) => {
    const row = (await db.raw(`SELECT id, changes FROM audit_log WHERE id = $1 AND action = 'customers.this_is_us' AND ${TENANT}`, [logId])).rows[0];
    if (!row) throw new EntityMergeError('Nothing to undo', 404);
    const done = (await db.raw(`SELECT 1 FROM audit_log WHERE action = 'customers.this_is_us_undone' AND changes->>'logId' = $1 AND ${TENANT}`, [logId])).rows[0];
    if (done) throw new EntityMergeError('This was already undone', 409);
    const st = row.changes;
    for (const e of st.entities ?? []) {
      await db.raw(`UPDATE entities SET data = $2::jsonb, updated_at = NOW() WHERE id = $1 AND ${TENANT}`, [e.id, e.data]);
    }
    for (const l of st.links ?? []) {
      await db.raw(
        `INSERT INTO document_entity_links (tenant_id, document_id, entity_id, confidence, linked_by, created_at)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, document_id, entity_id) DO NOTHING`,
        [l.document_id, l.entity_id, l.confidence, l.linked_by, l.created_at]
      );
    }
    for (const q of st.equipment ?? []) {
      await db.raw(`UPDATE entities SET customer_id = $2 WHERE id = $1 AND customer_id IS NULL AND ${TENANT}`, [q.id, q.customer_id]);
    }
    for (const d of st.movedDocumentIds ?? []) {
      await db.raw(`DELETE FROM extractions WHERE document_id = $1 AND field_key = $2 AND value = $3 AND ${TENANT}`, [d, COMPANY_FOLDER_FIELD_KEY, COMPANY_PAPER_FOLDER]);
    }
    for (const r of st.replacedFolderChoices ?? []) {
      await db.raw(
        `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
         VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, 1, NOW())`,
        [r.documentId, COMPANY_FOLDER_FIELD_KEY, r.value]
      );
    }
    await db.raw(
      `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, changes, created_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, 'customers.this_is_us_undone', 'entity', $1, $2::jsonb, NOW())`,
      [(st.entities ?? [])[0]?.id ?? null, JSON.stringify({ logId, actor: actorClerkId ?? null })]
    );
    return { restoredIds: (st.entities ?? []).map((e) => e.id) };
  });
}
