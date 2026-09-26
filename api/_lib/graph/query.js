/**
 * DeepWell Knowledge Graph v1 — read side (M3-config/37-knowledge-graph.sql, build.js).
 *
 * getSubgraph() is the ONE entry point both the HTTP route (v1-graph.js) and the agent tool
 * (graph_traverse in agent/tools.js) call. It takes a seed node and returns a bounded
 * neighborhood, provenance included on every edge, in the FIXED response shape:
 *
 *   { center, nodes:[{id,type,label,subtitle,degree}], edges:[{id,from,to,type,weight,
 *     source:{documentId,page}}], truncated }
 *
 * Two paths, same shape out:
 *   - kg_edges materialized (migration 37 pasted): one WITH RECURSIVE walk over the indexed
 *     table, capped by depth and limit.
 *   - not materialized: an iterative BFS driven by build.js's expandNode(), one hop at a time,
 *     each hop's queries individually bounded — see build.js's own header for why this is safe
 *     at this corpus size (same "query-time is fine; a materialized table is the scale-out path"
 *     reasoning as relations/timeline.js's fetchAllVisits).
 *
 * "unit -> warranty status" from the design is deliberately NOT an edge (warranty status is not
 * one of the five node types) — it is folded into the unit node's own `subtitle` instead, via the
 * SAME warrantyStatusOf() the rest of the product uses (analytics.js), so the graph view never
 * disagrees with the warranty page about what "expired"/"active" means for a given unit.
 */
import { TENANT_SQL } from '../scope.js';
import { warrantyStatusOf } from '../analytics.js';
import { nodeId, parseNodeId, expandNode, kgEdgesTableExists, searchGraphNodes, resolveMergedNodes } from './build.js';

export const MAX_DEPTH = 3;
export const MAX_LIMIT = 150;

function clampDepth(d) { return Math.max(0, Math.min(MAX_DEPTH, Math.trunc(Number(d)) || 0)); }
function clampLimit(n) { return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(n)) || MAX_LIMIT)); }

/* ------------------------------------------------------------------ hydration */

/** Node ids -> display info, batched per type (never one query per node). Unknown/deleted ids
 *  are simply left out of the result (never invented). */
async function hydrateNodes(db, ids, today) {
  const byType = { customer: [], unit: [], document: [], tech: [], site: [] };
  for (const id of ids) {
    const p = parseNodeId(id);
    if (p) byType[p.type]?.push(p.value);
  }
  const out = new Map();

  if (byType.customer.length) {
    const { rows } = await db.raw(
      `SELECT id, data->>'customer_name' AS name, customer_number, data->>'service_address' AS address
         FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
      [byType.customer]
    );
    for (const r of rows) out.set(nodeId.customer(r.id), { type: 'customer', label: r.name ?? r.customer_number ?? 'Customer', subtitle: r.address ?? null });
  }
  if (byType.unit.length) {
    const { rows } = await db.raw(
      `SELECT id, data->>'manufacturer' AS manufacturer, data->>'model' AS model, data->>'service_address' AS address, data->'warranty' AS warranty
         FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
      [byType.unit]
    );
    for (const r of rows) {
      const w = r.warranty && typeof r.warranty === 'object' ? r.warranty : null;
      const status = warrantyStatusOf(w, today);
      out.set(nodeId.unit(r.id), {
        type: 'unit',
        label: [r.manufacturer, r.model].filter(Boolean).join(' ') || 'Unit',
        subtitle: `warranty: ${status}${r.address ? ` · ${r.address}` : ''}`,
      });
    }
  }
  if (byType.document.length) {
    const { rows } = await db.raw(
      `SELECT id, original_filename, document_type, stage FROM documents WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`,
      [byType.document]
    );
    for (const r of rows) out.set(nodeId.document(r.id), { type: 'document', label: r.original_filename ?? r.document_type ?? 'Document', subtitle: r.document_type ?? null });
  }
  for (const key of byType.tech) out.set(nodeId.tech(key), { type: 'tech', label: key, subtitle: 'Technician' });
  for (const key of byType.site) out.set(nodeId.site(key), { type: 'site', label: key, subtitle: 'Site' });

  return out;
}

/** How many edges touch `id` at all (either direction) — used for the node's `degree`. When
 *  kg_edges is materialized this is an exact, indexed count; on the query-time path it counts
 *  only what THIS traversal happened to discover (a lower bound for a node sitting at the
 *  outer edge of the requested depth — documented on the response itself via `truncated`). */
async function exactDegree(db, id) {
  const { rows } = await db.raw(
    `SELECT count(*)::int AS n FROM kg_edges WHERE (from_node = $1 OR to_node = $1) AND ${TENANT_SQL}`,
    [id]
  );
  return rows[0]?.n ?? 0;
}

/* ------------------------------------------------------------------ subgraph */

/**
 * @param {{withTenant: Function, ctxArg: object, node: string, depth?: number,
 *          edgeTypes?: string[], limit?: number, today?: string}} opts
 * @returns {Promise<{center:string|null, nodes:object[], edges:object[], truncated:boolean}>}
 */
export async function getSubgraph({ withTenant, ctxArg, node, depth, edgeTypes, limit, today }) {
  const center = String(node ?? '').trim();
  const parsed = parseNodeId(center);
  const cappedDepth = clampDepth(depth ?? MAX_DEPTH);
  const cappedLimit = clampLimit(limit ?? MAX_LIMIT);
  const typeFilter = Array.isArray(edgeTypes) && edgeTypes.length ? new Set(edgeTypes.filter((t) => typeof t === 'string')) : null;
  if (!parsed) return { center: null, nodes: [], edges: [], truncated: false };

  return withTenant(ctxArg, async (db) => {
    const materialized = await kgEdgesTableExists(db);
    const { edges: rawEdges, truncated } = materialized
      ? await walkMaterialized(db, center, cappedDepth, typeFilter, cappedLimit)
      : await walkLive(db, center, cappedDepth, typeFilter, cappedLimit);

    // Merged/duplicate entities (reviewStore.js's mergeCustomers/mergeEntities) always resolve to
    // their surviving node, even when a materialized edge still names the dropped one — see
    // build.js's resolveMergedNodes for why this can lag behind a fresh query-time expansion.
    const rawIds = new Set([center]);
    for (const e of rawEdges) { rawIds.add(e.from); rawIds.add(e.to); }
    const remap = await resolveMergedNodes(db, rawIds);
    const canon = (id) => remap.get(id) ?? id;
    const dedup = new Map();
    for (const e of rawEdges) {
      const from = canon(e.from);
      const to = canon(e.to);
      if (from === to) continue; // a merge can collapse a stale self-referential edge
      const key = `${e.type}|${from}|${to}|${e.documentId ?? ''}`;
      if (!dedup.has(key)) dedup.set(key, { ...e, from, to, id: key });
    }
    const edges = [...dedup.values()];
    const centerCanon = canon(center);

    const nodeIds = new Set([centerCanon]);
    for (const e of edges) { nodeIds.add(e.from); nodeIds.add(e.to); }
    const info = await hydrateNodes(db, nodeIds, today);
    const nodes = [];
    for (const id of nodeIds) {
      const h = info.get(id);
      if (!h) continue; // a deleted/unresolvable row — never invented into a node
      const degree = materialized ? await exactDegree(db, id) : edges.filter((e) => e.from === id || e.to === id).length;
      nodes.push({ id, type: h.type, label: h.label, subtitle: h.subtitle, degree });
    }
    return {
      center: centerCanon,
      nodes,
      edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to, type: e.type, weight: e.weight, source: { documentId: e.documentId, page: e.page } })),
      truncated,
    };
  });
}

/**
 * Two steps: (1) a bounded-depth recursive walk over kg_edges (undirected — an edge can be
 * traversed either way, matching walkLive's own undirected expandNode semantics) collects the
 * set of REACHABLE node ids within `depth` hops; (2) every kg_edges row connecting two nodes in
 * that set is the returned subgraph — not just the tree edges the walk happened to use, so two
 * sibling nodes that are each within depth of the center but also directly connected to each
 * other still show that edge (an Obsidian-style graph view, not a spanning tree).
 */
async function walkMaterialized(db, center, depth, typeFilter, limit) {
  if (depth === 0) return { edges: [], truncated: false };
  const typesArr = typeFilter ? [...typeFilter] : null;
  const { rows: nodeRows } = await db.raw(
    `WITH RECURSIVE reach(node_id, depth) AS (
       SELECT $1::text, 0
       UNION
       SELECT (CASE WHEN k.from_node = r.node_id THEN k.to_node ELSE k.from_node END), r.depth + 1
         FROM kg_edges k JOIN reach r ON (k.from_node = r.node_id OR k.to_node = r.node_id)
        WHERE r.depth < $2 AND k.${TENANT_SQL} AND ($3::text[] IS NULL OR k.edge_type = ANY($3::text[]))
     )
     SELECT DISTINCT node_id FROM reach LIMIT 2000`,
    [center, depth, typesArr]
  );
  const nodeSet = nodeRows.map((r) => r.node_id);
  if (!nodeSet.length) return { edges: [], truncated: false };
  // limit+1: fetch one extra row so `truncated` can tell "capped by limit" apart from "exactly
  // filled" — the same idiom renderRows (agent/tools.js) uses for its own truncation flag.
  const { rows } = await db.raw(
    `SELECT id, from_node, to_node, edge_type, weight, document_id, page FROM kg_edges
      WHERE from_node = ANY($1::text[]) AND to_node = ANY($1::text[]) AND ${TENANT_SQL}
        AND ($2::text[] IS NULL OR edge_type = ANY($2::text[]))
      LIMIT $3`,
    [nodeSet, typesArr, limit + 1]
  );
  const truncated = rows.length > limit;
  const shown = rows.slice(0, limit).map((r) => ({ id: r.id, from: r.from_node, to: r.to_node, type: r.edge_type, weight: r.weight != null ? Number(r.weight) : null, documentId: r.document_id, page: r.page }));
  return { edges: shown, truncated };
}

/** Same contract as walkMaterialized, computed live via build.js's expandNode(). */
async function walkLive(db, center, depth, typeFilter, limit) {
  if (depth === 0) return { edges: [], truncated: false };
  const seen = new Map(); // edge id -> edge
  const visitedNodes = new Set([center]);
  let frontier = [center];
  let truncated = false;
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next = [];
    for (const n of frontier) {
      if (seen.size >= limit) { truncated = true; break; }
      const found = await expandNode(db, n);
      for (const e of found) {
        if (typeFilter && !typeFilter.has(e.type)) continue;
        if (!seen.has(e.id)) {
          if (seen.size >= limit) { truncated = true; break; }
          seen.set(e.id, e);
        }
        const other = e.from === n ? e.to : e.from;
        if (!visitedNodes.has(other)) { visitedNodes.add(other); next.push(other); }
      }
      if (truncated) break;
    }
    frontier = next;
    if (truncated) break;
  }
  return { edges: [...seen.values()], truncated };
}

/** Everything pointing AT `node` (one hop, reverse direction only) — "what links here". */
export async function getBacklinks({ withTenant, ctxArg, node, limit, today }) {
  const center = String(node ?? '').trim();
  const parsed = parseNodeId(center);
  const cappedLimit = clampLimit(limit ?? MAX_LIMIT);
  if (!parsed) return { node: null, backlinks: [] };

  return withTenant(ctxArg, async (db) => {
    const materialized = await kgEdgesTableExists(db);
    let rows;
    if (materialized) {
      const r = await db.raw(
        `SELECT id, from_node, to_node, edge_type, weight, document_id, page FROM kg_edges
          WHERE to_node = $1 AND ${TENANT_SQL} LIMIT $2`,
        [center, cappedLimit]
      );
      rows = r.rows.map((x) => ({ id: x.id, from: x.from_node, to: x.to_node, type: x.edge_type, weight: x.weight != null ? Number(x.weight) : null, documentId: x.document_id, page: x.page }));
    } else {
      const found = await expandNode(db, center);
      rows = found.filter((e) => e.to === center).slice(0, cappedLimit);
    }
    const remap = await resolveMergedNodes(db, [center, ...rows.map((e) => e.from)]);
    const canon = (id) => remap.get(id) ?? id;
    const centerCanon = canon(center);
    const dedup = new Map();
    for (const e of rows) {
      const from = canon(e.from);
      if (from === centerCanon) continue; // a merge can collapse a stale self-referential edge
      const key = `${e.type}|${from}|${e.documentId ?? ''}`;
      if (!dedup.has(key)) dedup.set(key, { ...e, from });
    }
    const canonRows = [...dedup.values()];
    const info = await hydrateNodes(db, canonRows.map((e) => e.from), today);
    return {
      node: centerCanon,
      backlinks: canonRows.map((e) => ({
        edge: { id: e.id, from: e.from, to: centerCanon, type: e.type, weight: e.weight, source: { documentId: e.documentId, page: e.page } },
        from: info.get(e.from) ? { id: e.from, ...info.get(e.from) } : { id: e.from, type: parseNodeId(e.from)?.type ?? null, label: null, subtitle: null },
      })),
    };
  });
}

/** `?q=` search seed — see build.js's searchGraphNodes for what matches. */
export async function searchNodes({ withTenant, ctxArg, q, limit }) {
  const cappedLimit = clampLimit(limit ?? 20);
  return withTenant(ctxArg, (db) => searchGraphNodes(db, q, cappedLimit));
}
