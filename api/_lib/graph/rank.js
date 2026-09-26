/**
 * Personalized PageRank over the DeepWell Knowledge Graph (HippoRAG-2 style, literature review
 * #9) — api/_lib/graph/rank.js.
 *
 * Given one or more seed nodes, ranks every OTHER node in their bounded neighborhood by how
 * strongly a random walk that keeps teleporting back to the SEEDS (not the whole tenant graph)
 * reaches it — so a document three hops from two different seeds can outrank one one hop from an
 * unrelated corner of the same tenant's data, instead of graph_traverse's flat "everything within
 * N hops, unranked" list. Deterministic, no model call: pure arithmetic over a capped subgraph
 * (<=2000 edges), collected the same query-time way build.js's expandNode() already walks the
 * graph for query.js's live-BFS path (walkLive) — so this works identically whether or not
 * kg_edges (migration 37) is materialized, and never touches a larger subgraph than a plain
 * graph_traverse call at the same depth would.
 *
 * Exposed two ways:
 *   - rankRelatedNodes({withTenant, ctxArg, seeds, limit, alpha}) — the plain function, usable
 *     from anywhere server-side (a route, another tool).
 *   - GRAPH_RANK_TOOL_DEF / executeGraphRankTool — the agent-tool wrapper. tools.js (owned by a
 *     different engineer this round) wires these in with three lines — see the comment above
 *     executeGraphRankTool for the exact registration.
 */
import { expandNode, parseNodeId } from './build.js';
import { hydrateNodes } from './query.js';

const MAX_EDGES = 2000;
const MAX_NODES = 4000; // safety valve well above what 2000 edges can ever reach
const DEFAULT_LIMIT = 20;
const DEFAULT_ALPHA = 0.85; // probability of following an edge each step; (1 - alpha) teleports back to the seeds
const MAX_ITERS = 60;
const TOL = 1e-7;

/* ------------------------------------------------------------- neighborhood */

/**
 * BFS out from every seed, live (build.js's expandNode — works whether or not kg_edges is
 * materialized), capped at `maxEdges` distinct edges — the same bound query.js's walkLive uses
 * for its own no-kg_edges path, reused here so ranking never sees a different (or larger)
 * subgraph than a plain traversal from the same seeds would. Also records one shortest-path
 * parent pointer per newly-discovered node (first BFS layer that reaches it), for pathTo() below.
 * @returns {Promise<{edges: object[], parent: Map<string,{from:string, edge:object}>}>}
 */
async function collectNeighborhood(db, seedIds, maxEdges) {
  const edgesById = new Map();
  const parent = new Map();
  const visited = new Set(seedIds);
  let frontier = [...seedIds];
  while (frontier.length && edgesById.size < maxEdges && visited.size < MAX_NODES) {
    const next = [];
    for (const n of frontier) {
      if (edgesById.size >= maxEdges) break;
      let found;
      try { found = await expandNode(db, n); } catch { found = []; }
      for (const e of found) {
        if (edgesById.size >= maxEdges) break;
        if (!edgesById.has(e.id)) edgesById.set(e.id, e);
        const other = e.from === n ? e.to : e.from;
        if (!visited.has(other)) {
          visited.add(other);
          parent.set(other, { from: n, edge: e });
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return { edges: [...edgesById.values()], parent };
}

/** Undirected adjacency list (PageRank walks either direction — same as query.js's own undirected
 *  BFS/WITH-RECURSIVE walk). Always includes every seed, even one with zero discovered edges, so
 *  it still receives its own (self-only) rank mass instead of being silently dropped. */
function buildAdjacency(edges, seedIds) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const e of edges) { add(e.from, e.to); add(e.to, e.from); }
  for (const id of seedIds) if (!adj.has(id)) adj.set(id, []);
  return adj;
}

/** Shortest (fewest-hop) edge chain from the nearest seed to `targetId`, using the parent
 *  pointers collectNeighborhood recorded — empty for a seed itself or a node the BFS never
 *  reached. Each step cites the same {type, documentId, page} provenance the edge itself carries,
 *  so a ranked result's `path` is a real, checkable trail, not a similarity number alone. */
function pathTo(parent, targetId, seedIds) {
  const path = [];
  let cur = targetId;
  const guard = new Set();
  while (!seedIds.includes(cur) && parent.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const p = parent.get(cur);
    path.unshift({ from: p.from, to: cur, type: p.edge.type, documentId: p.edge.documentId ?? null, page: p.edge.page ?? null });
    cur = p.from;
  }
  return path;
}

/* ------------------------------------------------------------------ PPR math */

/**
 * Personalized PageRank via power iteration — pure, synchronous, deterministic (same input
 * always produces the same output; no randomness, no model). `adj` is an undirected adjacency
 * list (node id -> neighbor id[]); `seedIds` are the personalization/teleport set (a seed not
 * present in `adj` contributes no teleport mass — never invented into the walk).
 *
 * Standard random-surfer formulation: at each step, stay on the walk with probability `alpha`
 * (split evenly across the current node's neighbors, or — if it has none — redistributed as
 * "dangling" mass), and with probability `1 - alpha` teleport back to a uniformly-chosen seed.
 * Converges in well under `maxIters` at this size (<=2000 edges); each iteration is O(edges),
 * so the whole computation is comfortably sub-millisecond — the wall-clock cost of a
 * rankRelatedNodes call is the DB round-trips in collectNeighborhood, not this function.
 * @returns {Map<string, number>} node id -> PPR score (sums to ~1 over every node in `adj`)
 */
export function personalizedPageRank(adj, seedIds, alpha = DEFAULT_ALPHA, maxIters = MAX_ITERS, tol = TOL) {
  const nodes = [...adj.keys()];
  const n = nodes.length;
  if (!n) return new Map();
  const reachableSeeds = seedIds.filter((s) => adj.has(s));
  const teleport = reachableSeeds.length ? reachableSeeds : nodes; // no seed in the neighborhood -> plain PageRank
  const isTeleport = new Set(teleport);
  const teleportShare = 1 / teleport.length;

  let rank = new Map(nodes.map((id) => [id, 1 / n]));
  for (let iter = 0; iter < maxIters; iter++) {
    const next = new Map(nodes.map((id) => [id, 0]));
    let dangling = 0;
    for (const id of nodes) {
      const r = rank.get(id) ?? 0;
      const neighbors = adj.get(id) ?? [];
      if (!neighbors.length) { dangling += r; continue; }
      const share = r / neighbors.length;
      for (const nb of neighbors) next.set(nb, (next.get(nb) ?? 0) + share);
    }
    let diff = 0;
    for (const id of nodes) {
      const teleportIn = isTeleport.has(id) ? teleportShare : 0;
      const v = alpha * (next.get(id) + dangling * teleportIn) + (1 - alpha) * teleportIn;
      diff += Math.abs(v - (rank.get(id) ?? 0));
      next.set(id, v);
    }
    rank = next;
    if (diff < tol) break;
  }
  return rank;
}

/* -------------------------------------------------------------------- API */

/**
 * @param {{withTenant:Function, ctxArg:object, seeds:string[]|string, limit?:number,
 *          alpha?:number, today?:string}} opts
 * @returns {Promise<{seeds:string[], results:Array<{id,type,label,subtitle,score,path}>, truncated:boolean}>}
 */
export async function rankRelatedNodes({ withTenant, ctxArg, seeds, limit, alpha, today }) {
  const seedIds = (Array.isArray(seeds) ? seeds : [seeds])
    .map((s) => String(s ?? '').trim())
    .filter((s) => parseNodeId(s));
  const cappedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || DEFAULT_LIMIT));
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 && Number(alpha) < 1 ? Number(alpha) : DEFAULT_ALPHA;
  if (!seedIds.length) return { seeds: [], results: [], truncated: false };

  return withTenant(ctxArg, async (db) => {
    const { edges, parent } = await collectNeighborhood(db, seedIds, MAX_EDGES);
    const adj = buildAdjacency(edges, seedIds);
    const rank = personalizedPageRank(adj, seedIds, a);

    const ranked = [...rank.entries()]
      .filter(([id]) => !seedIds.includes(id))
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)) // score desc, then id — deterministic tie-break
      .slice(0, cappedLimit);

    const info = await hydrateNodes(db, ranked.map(([id]) => id), today);
    const results = [];
    for (const [id, score] of ranked) {
      const h = info.get(id);
      if (!h) continue; // a deleted/unresolvable row — never invented into a result
      results.push({
        id,
        type: h.type,
        label: h.label,
        subtitle: h.subtitle,
        score: Math.round(score * 1e6) / 1e6,
        path: pathTo(parent, id, seedIds),
      });
    }
    return { seeds: seedIds, results, truncated: edges.length >= MAX_EDGES };
  });
}

/* --------------------------------------------------------------- agent tool */

export const GRAPH_RANK_TOOL_NAME = 'graph_rank';
export const GRAPH_RANK_TOOL_DEF = {
  name: GRAPH_RANK_TOOL_NAME,
  description:
    "Rank the records most strongly connected to one or more seed nodes (a typed id from graph_traverse or another tool, e.g. 'customer:<id>', 'unit:<id>', 'document:<id>', 'tech:mike r.', 'site:<key>', 'visit:<id>') using Personalized PageRank over the bounded knowledge graph neighborhood — deterministic, no model call. Returns nodes/documents ordered by a connectivity score, each with the shortest path that explains why it ranked there (every hop citing its document/page). Use this instead of graph_traverse when the question is 'what's MOST related to X' or 'rank what connects these two records' rather than 'show me everything within N hops'.",
  input_schema: {
    type: 'object',
    properties: {
      seeds: {
        type: 'array',
        items: { type: 'string' },
        description: "One or more already-typed node ids ('customer:<id>', 'unit:<id>', 'document:<id>', 'tech:<name>', 'site:<key>', 'visit:<id>', 'warranty:<id>').",
      },
      limit: { type: 'integer', description: 'Max ranked results (default 20, max 100).' },
      alpha: { type: 'number', description: 'Damping factor in (0,1), default 0.85 — higher follows edges further before teleporting back to the seeds.' },
    },
    required: ['seeds'],
  },
};

/**
 * Same {ok, content, rowCount, inputSummary, empty} shape every executor in agent/tools.js
 * returns, so registering this tool there is exactly:
 *
 *   1. import { GRAPH_RANK_TOOL_NAME, GRAPH_RANK_TOOL_DEF, executeGraphRankTool } from "../graph/rank.js";
 *   2. add GRAPH_RANK_TOOL_DEF next to GRAPH_TRAVERSE_TOOL_DEF in TOOL_DEFS_V2's array literal
 *   3. in execute()'s if/else if chain, add:
 *        else if (name === GRAPH_RANK_TOOL_NAME) {
 *          r = await executeGraphRankTool(input ?? {}, { withTenant, ctxArg, today });
 *          if (r.ok) { ledger.addShown(r.content); for (const m of r.content.match(UUID_G) ?? []) ledger.ids.add(m.toLowerCase()); }
 *        }
 *      (identical bookkeeping to graphTraverseTool's own body just above it in that file).
 */
export async function executeGraphRankTool(input, { withTenant, ctxArg, today }) {
  const seeds = Array.isArray(input?.seeds) ? input.seeds.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!seeds.length) return { ok: false, content: 'ERROR: seeds (a non-empty array of node ids) is required', rowCount: 0, inputSummary: 'graph_rank' };
  let out;
  try {
    out = await rankRelatedNodes({ withTenant, ctxArg, seeds, limit: input?.limit, alpha: input?.alpha, today });
  } catch (err) {
    return { ok: false, content: `ERROR: ${String(err?.message ?? err).slice(0, 300)}`, rowCount: 0, inputSummary: 'graph_rank' };
  }
  const content = JSON.stringify(out);
  return { ok: true, content, rowCount: out.results.length, inputSummary: `graph_rank:${seeds.join(',')}`, empty: out.results.length === 0 };
}
