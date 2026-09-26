/**
 * DeepWell Knowledge Graph v1 — deterministic edge derivation (M3-config/37-knowledge-graph.sql).
 *
 * NO MODEL CALLS ANYWHERE IN THIS FILE. Every edge is derived from data already on disk:
 * entities (customer/equipment), document_entity_links, extractions (technician), and
 * document_financials/job_key (M3-config/22 + 36) — the same tables relations/timeline.js and
 * financials/jobCosting.js already read for the "connect the dots" and job-costing features.
 *
 * NODE IDS are typed strings, never a new table per node type:
 *   customer:<uuid>       an entities row, entity_type = 'customer'
 *   unit:<uuid>            an entities row, entity_type = 'equipment' ("unit" in HVAC-domain
 *                          language, matching dossiers.entity_type's own 'unit' choice)
 *   document:<uuid>       a documents row
 *   tech:<normalized name> NOT an entities row — a technician is free text (extractions.value,
 *                          field_key='technician'); normalizeTechKey collapses whitespace/case so
 *                          "Mike R." and "mike r." land on the same node.
 *   site:<address key>    NOT an entities row either — a canonical address key (house number +
 *                          street words + unit + city), reusing financials/jobKey.js's own
 *                          normalizeJobKey so a site node and a job-costing job_key AGREE for the
 *                          same physical address (jobKey.js already solved "two addresses that
 *                          print differently are the same place" for job costing; the graph reuses
 *                          it rather than inventing a second address canonicalizer).
 *
 * EDGE TYPES this file produces (edge_type column):
 *   owns           customer -> unit            (entities.customer_id)
 *   located_at     customer -> site            (customer's own on-file address)
 *   has_unit       site -> unit                (unit's own on-file address, or its owning
 *                                              customer's when the unit has none of its own)
 *   has_document   customer|unit -> document   (document_entity_links; the structural "this
 *                                              record owns this document" edge, always present)
 *   billed         customer|unit -> document   (OVERLAY on has_document: this document also has a
 *                                              document_financials row with direction='receivable'
 *                                              — weight is its dollar total, page cites where the
 *                                              total was printed. This is the "document -> invoice
 *                                              /financials" link from the design: the document node
 *                                              IS the invoice, so its financial weight rides on the
 *                                              same edge that already connects it to its owner.)
 *   has_agreement  customer -> document         (OVERLAY: doc_kind = 'agreement')
 *   performed_by   document -> tech             (extractions.field_key = 'technician')
 *   same_job       document(po/bill) -> document(invoice)  (OVERLAY: both share a job_key at or
 *                                              above JOB_MATCH_CONFIDENCE — "invoice <-> PO via
 *                                              job_key"; stored one direction, traversable both ways
 *                                              via the (tenant,to_node) index)
 *
 * WORKS WITHOUT MIGRATION 37: expandNode() below computes one node's neighborhood on the fly, with
 * small tenant-scoped, indexed queries — the same "probe first, degrade gracefully" contract every
 * other optional layer in this codebase follows (financials/store.js's financialsTableExists).
 * query.js's getSubgraph() calls expandNode() in a BFS when kg_edges is absent, and reads kg_edges
 * directly (WITH RECURSIVE) when it is present. refreshGraphBatch() (below) is what MATERIALIZES
 * kg_edges: a bounded, resumable batch over documents, same "afterId cursor + deadline, no cost
 * cap because there is no model call" shape as financials/backfill.js's runJobKeyBackfill.
 */
import { TENANT_SQL } from '../scope.js';
import { normalizeJobKey, JOB_MATCH_CONFIDENCE } from '../financials/jobKey.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_RE = /^(customer|unit|document|tech|site):(.+)$/;

/* ------------------------------------------------------------------- ids */

export const nodeId = {
  customer: (id) => `customer:${String(id).toLowerCase()}`,
  unit: (id) => `unit:${String(id).toLowerCase()}`,
  document: (id) => `document:${String(id).toLowerCase()}`,
  tech: (name) => `tech:${normalizeTechKey(name)}`,
  site: (key) => `site:${key}`,
};

/** "Mike R." / "mike r." / "  Mike   R.  " all -> "mike r." (matches the oracle's own
 *  lower(btrim(value)) grouping in relations/timeline.js's technicianCountOnRecord). */
export function normalizeTechKey(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A printed address -> its canonical site key, or null when it doesn't parse as a street
 *  address at all (never guessed — same "never invent" rule jobKey.js itself documents). */
export function siteKeyFromAddress(address) {
  if (!address || !String(address).trim()) return null;
  return normalizeJobKey(String(address));
}

/** 'customer:<uuid>' -> {type:'customer', value:'<uuid>'}, or null for a malformed id. */
export function parseNodeId(id) {
  const m = NODE_RE.exec(String(id ?? '').trim());
  if (!m) return null;
  const [, type, value] = m;
  if ((type === 'customer' || type === 'unit' || type === 'document') && !UUID_RE.test(value)) return null;
  // Client-supplied tech ids ('tech:Mike R.') must match the normalized key edges are built with.
  if (type === 'tech') {
    const key = normalizeTechKey(value);
    return key ? { type, value: key } : null;
  }
  return { type, value };
}

/** Deterministic synthetic id for a query-time (non-materialized) edge — stable across repeated
 *  BFS expansions of the same neighborhood, so callers can de-dupe by id. Not a security boundary
 *  (it is only ever used to key a JS Map), so a compact join is enough — no hashing needed. */
function edgeKey(fromNode, toNode, edgeType, documentId) {
  return `${edgeType}|${fromNode}|${toNode}|${documentId ?? ''}`;
}

/** @typedef {{id:string, from:string, to:string, type:string, weight:number|null,
 *             source:string, sourceId:string|null, documentId:string|null, page:number|null}} Edge */

/** @param {object} e */
function edge(e) {
  return {
    id: edgeKey(e.from, e.to, e.type, e.documentId ?? null),
    from: e.from, to: e.to, type: e.type,
    weight: e.weight != null && Number.isFinite(Number(e.weight)) ? Number(e.weight) : null,
    source: e.source, sourceId: e.sourceId ?? null,
    documentId: e.documentId ?? null, page: e.page ?? null,
  };
}

/* --------------------------------------------------------- financials overlay */

/** {page, total}|null for a document's own document_financials row (evidence.total.page, the
 *  effective total after any correction — same COALESCE rule financials/normalize.js's
 *  effectiveHeader applies everywhere else). Cheap, single-document lookup — used for the
 *  billed/has_agreement overlay, never a full-table scan. */
async function financialsOverlayForDoc(db, documentId) {
  const { rows } = await db.raw(
    `SELECT doc_kind, direction, total, corrections, evidence, job_key
       FROM document_financials WHERE document_id = $1 AND ${TENANT_SQL}`,
    [documentId]
  );
  const r = rows[0];
  if (!r) return null;
  const total = r.corrections?.total != null ? Number(r.corrections.total) : (r.total != null ? Number(r.total) : null);
  const page = r.evidence?.total?.page ?? null;
  return { docKind: r.doc_kind, direction: r.direction, total: Number.isFinite(total) ? total : null, page, jobKey: r.job_key ?? null };
}

/* ------------------------------------------------------- query-time expansion */

/**
 * One hop of the graph FROM (and TO) `id`: every edge incident on it, computed live. Bounded —
 * every internal query carries its own LIMIT — so a very well-connected node still returns
 * quickly; getSubgraph's own overall `limit` is what actually caps the traversal.
 * @param {object} db withTenant's store
 * @param {string} id a node id
 * @returns {Promise<Edge[]>}
 */
export async function expandNode(db, id) {
  const parsed = parseNodeId(id);
  if (!parsed) return [];
  if (parsed.type === 'customer') return expandCustomer(db, parsed.value);
  if (parsed.type === 'unit') return expandUnit(db, parsed.value);
  if (parsed.type === 'document') return expandDocument(db, parsed.value);
  if (parsed.type === 'tech') return expandTech(db, parsed.value);
  if (parsed.type === 'site') return expandSite(db, parsed.value);
  return [];
}

async function expandCustomer(db, custId) {
  const out = [];
  const { rows: cr } = await db.raw(
    `SELECT data->>'service_address' AS address FROM entities WHERE id = $1 AND entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`,
    [custId]
  );
  const c = cr[0];
  if (!c) return out;
  const cNode = nodeId.customer(custId);
  const key = siteKeyFromAddress(c.address);
  if (key) out.push(edge({ from: cNode, to: nodeId.site(key), type: 'located_at', source: 'entities', sourceId: custId }));

  const { rows: equip } = await db.raw(
    `SELECT id FROM entities WHERE customer_id = $1 AND entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 200`,
    [custId]
  );
  for (const u of equip) out.push(edge({ from: cNode, to: nodeId.unit(u.id), type: 'owns', source: 'entities', sourceId: u.id }));

  const { rows: links } = await db.raw(
    `SELECT DISTINCT l.document_id FROM document_entity_links l WHERE l.entity_id = $1 AND l.${TENANT_SQL} LIMIT 500`,
    [custId]
  );
  for (const l of links) out.push(...(await documentLinkEdges(db, cNode, l.document_id)));
  return out;
}

async function expandUnit(db, equipId) {
  const out = [];
  const { rows: er } = await db.raw(
    `SELECT customer_id, data->>'service_address' AS address FROM entities
      WHERE id = $1 AND entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`,
    [equipId]
  );
  const e = er[0];
  if (!e) return out;
  const uNode = nodeId.unit(equipId);
  let address = e.address;
  if (!address && e.customer_id) {
    const { rows: cr } = await db.raw(`SELECT data->>'service_address' AS address FROM entities WHERE id = $1 AND ${TENANT_SQL}`, [e.customer_id]);
    address = cr[0]?.address ?? null;
  }
  const key = siteKeyFromAddress(address);
  if (key) out.push(edge({ from: nodeId.site(key), to: uNode, type: 'has_unit', source: 'entities', sourceId: equipId }));
  if (e.customer_id) out.push(edge({ from: nodeId.customer(e.customer_id), to: uNode, type: 'owns', source: 'entities', sourceId: equipId }));

  const { rows: links } = await db.raw(
    `SELECT DISTINCT l.document_id FROM document_entity_links l WHERE l.entity_id = $1 AND l.${TENANT_SQL} LIMIT 500`,
    [equipId]
  );
  for (const l of links) out.push(...(await documentLinkEdges(db, uNode, l.document_id)));
  return out;
}

/** has_document (+ billed/has_agreement overlay) for one (ownerNode, documentId) link. Shared by
 *  expandCustomer/expandUnit (forward direction) and expandDocument (reverse direction, same edges). */
async function documentLinkEdges(db, ownerNode, documentId) {
  const out = [edge({ from: ownerNode, to: nodeId.document(documentId), type: 'has_document', source: 'document_entity_links', documentId })];
  const fin = await financialsOverlayForDoc(db, documentId);
  if (fin) {
    if (fin.docKind === 'agreement') {
      out.push(edge({ from: ownerNode, to: nodeId.document(documentId), type: 'has_agreement', source: 'document_financials', documentId, page: fin.page }));
    } else if (fin.direction === 'receivable' && fin.total != null) {
      out.push(edge({ from: ownerNode, to: nodeId.document(documentId), type: 'billed', weight: fin.total, source: 'document_financials', documentId, page: fin.page }));
    }
  }
  return out;
}

async function expandDocument(db, docId) {
  const out = [];
  const { rows: links } = await db.raw(
    `SELECT l.entity_id, e.entity_type FROM document_entity_links l
       JOIN entities e ON e.id = l.entity_id AND e.merged_into IS NULL AND e.${TENANT_SQL}
      WHERE l.document_id = $1 AND l.${TENANT_SQL} LIMIT 50`,
    [docId]
  );
  for (const l of links) {
    if (l.entity_type !== 'customer' && l.entity_type !== 'equipment') continue;
    const owner = l.entity_type === 'customer' ? nodeId.customer(l.entity_id) : nodeId.unit(l.entity_id);
    out.push(...(await documentLinkEdges(db, owner, docId)));
  }

  const { rows: techs } = await db.raw(
    `SELECT DISTINCT COALESCE(NULLIF(corrected_value,''), value) AS tech FROM extractions
      WHERE document_id = $1 AND field_key = 'technician' AND coalesce(value,'') <> '' AND ${TENANT_SQL} LIMIT 10`,
    [docId]
  );
  for (const t of techs) if (t.tech) out.push(edge({ from: nodeId.document(docId), to: nodeId.tech(t.tech), type: 'performed_by', source: 'extractions', documentId: docId }));

  const fin = await financialsOverlayForDoc(db, docId);
  if (fin?.jobKey) {
    const { rows: siblings } = await db.raw(
      `SELECT document_id, direction, job_confidence FROM document_financials
        WHERE job_key = $1 AND document_id <> $2 AND ${TENANT_SQL}
          AND (job_confidence IS NULL OR job_confidence >= $3) LIMIT 50`,
      [fin.jobKey, docId, JOB_MATCH_CONFIDENCE]
    );
    for (const s of siblings) {
      // PO/bill (payable) -> invoice (receivable), a deterministic direction; when both sides are
      // the same direction (two invoices for the same job, say), order by id so the edge is
      // reported exactly once regardless of which end the traversal started from.
      const [fromId, toId] = fin.direction === 'payable' ? [docId, s.document_id]
        : s.direction === 'payable' ? [s.document_id, docId]
        : docId < s.document_id ? [docId, s.document_id] : [s.document_id, docId];
      out.push(edge({ from: nodeId.document(fromId), to: nodeId.document(toId), type: 'same_job', source: 'job_key', documentId: docId }));
    }
  }
  return out;
}

async function expandTech(db, techKey) {
  const out = [];
  const { rows } = await db.raw(
    `SELECT DISTINCT document_id FROM extractions
      WHERE field_key = 'technician' AND coalesce(value,'') <> '' AND ${TENANT_SQL}
        AND lower(btrim(COALESCE(NULLIF(corrected_value,''), value))) = $1 LIMIT 300`,
    [techKey]
  );
  for (const r of rows) out.push(edge({ from: nodeId.document(r.document_id), to: nodeId.tech(techKey), type: 'performed_by', source: 'extractions', documentId: r.document_id }));
  return out;
}

async function expandSite(db, siteKey) {
  const out = [];
  const { rows: custs } = await db.raw(
    `SELECT id, data->>'service_address' AS address FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 5000`,
    []
  );
  for (const c of custs) if (siteKeyFromAddress(c.address) === siteKey) out.push(edge({ from: nodeId.customer(c.id), to: nodeId.site(siteKey), type: 'located_at', source: 'entities', sourceId: c.id }));

  const { rows: equip } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'service_address' AS address, c.data->>'service_address' AS customer_address
       FROM entities e LEFT JOIN entities c ON c.id = e.customer_id AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL} LIMIT 5000`,
    []
  );
  for (const u of equip) {
    const key = siteKeyFromAddress(u.address) ?? siteKeyFromAddress(u.customer_address);
    if (key === siteKey) out.push(edge({ from: nodeId.site(siteKey), to: nodeId.unit(u.id), type: 'has_unit', source: 'entities', sourceId: u.id }));
  }
  return out;
}

/**
 * Two entities row can turn out to be the same customer/unit (reviewStore.js's mergeCustomers /
 * mergeEntities): document_entity_links and extractions.entity_id are repointed onto the survivor
 * immediately, so a FRESH query-time expansion never sees the dropped id again — but a
 * MATERIALIZED kg_edges row written before the merge can still name it until the next refresh
 * batch reaches that document. This resolves every customer:/unit: node id in `ids` to its final
 * surviving id (following merged_into, bounded — a real merge chain from reviewStore.js always
 * points straight at the final survivor; the bound only guards against a data anomaly).
 * @returns {Promise<Map<string,string>>} stale node id -> canonical node id (identity for
 *          anything that was never merged, including document/tech/site ids, which have no
 *          merged_into concept at all).
 */
export async function resolveMergedNodes(db, ids) {
  const custIds = new Set();
  const unitIds = new Set();
  for (const id of ids) {
    const p = parseNodeId(id);
    if (!p) continue;
    if (p.type === 'customer') custIds.add(p.value);
    else if (p.type === 'unit') unitIds.add(p.value);
  }
  const allIds = [...custIds, ...unitIds];
  const map = new Map();
  if (!allIds.length) return map;

  let current = new Map(allIds.map((id) => [id, id]));
  for (let hop = 0; hop < 5; hop++) {
    const targets = [...new Set(current.values())];
    const { rows } = await db.raw(`SELECT id, merged_into FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`, [targets]);
    const advance = new Map(rows.map((r) => [r.id, r.merged_into ?? r.id]));
    let changed = false;
    for (const [orig, cur] of current) {
      const next = advance.get(cur) ?? cur;
      if (next !== cur) { current.set(orig, next); changed = true; }
    }
    if (!changed) break;
  }
  for (const id of custIds) map.set(nodeId.customer(id), nodeId.customer(current.get(id)));
  for (const id of unitIds) map.set(nodeId.unit(id), nodeId.unit(current.get(id)));
  return map;
}

/** Nodes matching free text `q` (customer name, equipment manufacturer/model/serial/address, or a
 *  technician name) — seeds for the graph view's search box. Deterministic ILIKE, no ranking model. */
export async function searchGraphNodes(db, q, limit = 20) {
  const cap = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
  const pattern = `%${String(q ?? '').trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (!pattern.replace(/[%\\]/g, '')) return [];
  const out = [];
  const { rows: custs } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND data->>'customer_name' ILIKE $1 LIMIT $2`,
    [pattern, cap]
  );
  for (const c of custs) out.push({ id: nodeId.customer(c.id), type: 'customer', label: c.name ?? 'Customer', subtitle: c.address ?? null });

  const { rows: equip } = await db.raw(
    `SELECT id, data->>'manufacturer' AS manufacturer, data->>'model' AS model, data->>'serial_number' AS serial, data->>'service_address' AS address
       FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}
         AND (data->>'manufacturer' ILIKE $1 OR data->>'model' ILIKE $1 OR data->>'serial_number' ILIKE $1 OR data->>'service_address' ILIKE $1)
       LIMIT $2`,
    [pattern, cap]
  );
  for (const u of equip) out.push({ id: nodeId.unit(u.id), type: 'unit', label: [u.manufacturer, u.model].filter(Boolean).join(' ') || 'Unit', subtitle: u.serial ?? u.address ?? null });

  const { rows: techs } = await db.raw(
    `SELECT DISTINCT COALESCE(NULLIF(corrected_value,''), value) AS tech FROM extractions
      WHERE field_key = 'technician' AND coalesce(value,'') <> '' AND ${TENANT_SQL} AND value ILIKE $1 LIMIT $2`,
    [pattern, cap]
  );
  for (const t of techs) if (t.tech) out.push({ id: nodeId.tech(t.tech), type: 'tech', label: String(t.tech).trim(), subtitle: 'Technician' });

  return out.slice(0, cap);
}

/* --------------------------------------------------------------- materialization */

let kgTableKnown = null; // memoized like financialsTableExists
export function _resetKgEdgesProbe() { kgTableKnown = null; }

export async function kgEdgesTableExists(db) {
  if (kgTableKnown != null) return kgTableKnown;
  try {
    const r = await db.raw("SELECT to_regclass('public.kg_edges') IS NOT NULL AS ok", []);
    kgTableKnown = Boolean(r.rows[0]?.ok);
    return kgTableKnown;
  } catch {
    return false;
  }
}

/**
 * One bounded, resumable batch of the kg_edges materialization/refresh — iterates DOCUMENTS
 * (oldest id first, same afterId-cursor shape as financials/backfill.js's runJobKeyBackfill), and
 * for each one deletes its previously-derived rows and reinserts fresh ones from expandDocument's
 * own edge derivation — so a document whose links changed since the last refresh never leaves a
 * stale edge behind. No model call, so (like runJobKeyBackfill) there is no cost cap, only a
 * wall-clock deadline.
 * @param {object} db withTenant's store
 * @param {{afterId?: string|null, limit?: number, deadlineMs?: number}} [opts]
 */
export async function refreshGraphBatch(db, opts = {}) {
  if (!(await kgEdgesTableExists(db))) return { enabled: false, processed: 0, edgesWritten: 0, remaining: 0, nextCursor: null, stoppedReason: 'table_missing' };
  const limit = Math.max(1, Math.min(2000, Math.trunc(Number(opts.limit)) || 500));
  const deadlineAt = Date.now() + (Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 45_000);
  const afterId = typeof opts.afterId === 'string' && UUID_RE.test(opts.afterId) ? opts.afterId : null;

  const { rows: docs } = await db.raw(
    `SELECT id FROM documents WHERE ${TENANT_SQL} ${afterId ? 'AND id > $2' : ''} ORDER BY id LIMIT $1`,
    afterId ? [limit, afterId] : [limit]
  );

  let processed = 0;
  let edgesWritten = 0;
  let cursor = afterId;
  let stoppedReason = null;
  for (const d of docs) {
    if (Date.now() > deadlineAt) { stoppedReason = 'deadline'; break; }
    const edges = await expandDocument(db, d.id);
    await db.raw(`DELETE FROM kg_edges WHERE document_id = $1 AND ${TENANT_SQL}`, [d.id]);
    for (const e of edges) {
      // same_job is symmetric — expandDocument computes the SAME directional edge whichever of
      // the two documents it is asked about. Writing it only from the "from" side's own batch
      // turn keeps kg_edges from carrying the identical edge twice (once per document_id).
      if (e.type === 'same_job' && e.from !== nodeId.document(d.id)) continue;
      await db.raw(
        `INSERT INTO kg_edges (tenant_id, from_node, to_node, edge_type, weight, source, source_id, document_id, page)
         VALUES ((current_setting('app.tenant_id'))::uuid, $1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.from, e.to, e.type, e.weight, e.source, e.sourceId, e.documentId, e.page]
      );
      edgesWritten++;
    }
    processed++;
    cursor = d.id;
  }

  // Entity-level edges (owns/located_at/has_unit) do not belong to any one document, so they are
  // refreshed alongside the FIRST batch only (afterId == null) — cheap (one pass over entities,
  // no model call, bounded by the same deadline) and idempotent (delete-then-reinsert by source).
  if (!afterId && Date.now() <= deadlineAt) {
    await db.raw(`DELETE FROM kg_edges WHERE document_id IS NULL AND ${TENANT_SQL}`, []);
    const { rows: custs } = await db.raw(`SELECT id FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 20000`, []);
    for (const c of custs) {
      if (Date.now() > deadlineAt) { stoppedReason = stoppedReason ?? 'deadline'; break; }
      const cEdges = (await expandCustomer(db, c.id)).filter((e) => e.type === 'located_at' || e.type === 'owns');
      for (const e of cEdges) {
        await db.raw(
          `INSERT INTO kg_edges (tenant_id, from_node, to_node, edge_type, weight, source, source_id, document_id, page)
           VALUES ((current_setting('app.tenant_id'))::uuid, $1,$2,$3,$4,$5,$6,NULL,NULL)`,
          [e.from, e.to, e.type, e.weight, e.source, e.sourceId]
        );
        edgesWritten++;
      }
    }
    const { rows: equip } = await db.raw(`SELECT id FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT 20000`, []);
    for (const u of equip) {
      if (Date.now() > deadlineAt) { stoppedReason = stoppedReason ?? 'deadline'; break; }
      const uEdges = (await expandUnit(db, u.id)).filter((e) => e.type === 'has_unit');
      for (const e of uEdges) {
        await db.raw(
          `INSERT INTO kg_edges (tenant_id, from_node, to_node, edge_type, weight, source, source_id, document_id, page)
           VALUES ((current_setting('app.tenant_id'))::uuid, $1,$2,$3,$4,$5,$6,NULL,NULL)`,
          [e.from, e.to, e.type, e.weight, e.source, e.sourceId]
        );
        edgesWritten++;
      }
    }
  }

  const { rows: remainingRows } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL} ${cursor ? 'AND id > $1' : ''}`, cursor ? [cursor] : []);
  if (!stoppedReason) stoppedReason = docs.length === 0 ? 'done' : 'batch_complete';
  return { enabled: true, processed, edgesWritten, remaining: remainingRows[0]?.n ?? 0, nextCursor: docs.length ? cursor : null, stoppedReason };
}

export async function graphRefreshStatus(db) {
  if (!(await kgEdgesTableExists(db))) return { enabled: false, totalDocuments: 0, edgeCount: 0 };
  const { rows: dr } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL}`, []);
  const { rows: er } = await db.raw(`SELECT count(*)::int AS n FROM kg_edges WHERE ${TENANT_SQL}`, []);
  return { enabled: true, totalDocuments: dr[0]?.n ?? 0, edgeCount: er[0]?.n ?? 0 };
}
