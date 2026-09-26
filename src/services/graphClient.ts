/**
 * Typed client for the Knowledge Graph API (GET /api/v1/graph), built
 * against the fixed contract the backend is implementing in parallel:
 *
 *   GET /api/v1/graph?node=<id>&depth=<1-3>
 *     -> { center, nodes: [{id, type, label, subtitle?, degree?}],
 *          edges: [{id, from, to, type, weight?, source?: {documentId?, page?}}],
 *          truncated }
 *   GET /api/v1/graph?q=<text>   (search to seed the view)
 *     -> { nodes: [{id, type, label, subtitle?}] }
 *
 * Same fetch + authHeader + error-message shape as the other *Client.ts
 * files (customerClient.ts, documentClient.ts) — a 500 from Vercel can come
 * back as an HTML page, so the body is read as text and parsed defensively
 * rather than trusting res.json().
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const GRAPH_URL = '/api/v1/graph';

/** Node id prefixes the backend contract defines. Not a closed enum on the
 *  wire (a future prefix is still just a string), so callers should treat
 *  `type` as "the known ones, plus possibly something new" rather than
 *  switch over every case. */
export type GraphNodeType =
  | 'customer'
  | 'unit'
  | 'document'
  | 'tech'
  | 'site'
  | 'visit'
  | 'invoice'
  | 'warranty'
  | 'agreement';

export interface GraphNode {
  id: string;
  type: GraphNodeType | string;
  label: string;
  subtitle?: string;
  /** Total edge count at the node's home depth, when the server sends it —
   *  used only to size the node a little; absence just means "unweighted". */
  degree?: number;
}

export interface GraphEdgeSource {
  documentId?: string;
  page?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  weight?: number;
  source?: GraphEdgeSource;
}

export interface GraphSubgraph {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface GraphSearchResult {
  nodes: GraphNode[];
}

/** One hop of a Personalized-PageRank result path (graph/rank.js) — same shape as GraphEdge's own
 *  `source`, just inlined per-hop since a path can cross several edges. */
export interface GraphRankPathStep {
  from: string;
  to: string;
  type: string;
  documentId?: string | null;
  page?: number | null;
}

export interface GraphRankedNode extends GraphNode {
  /** Personalized PageRank score relative to the given seeds — higher is more connected. Not
   *  comparable across different seed sets or depths. */
  score: number;
  /** Shortest hop-by-hop trail from the nearest seed to this node, provenance included on every
   *  hop — the "why this ranked here" a plain graphClient.get() neighborhood doesn't provide. */
  path: GraphRankPathStep[];
}

export interface GraphRankResult {
  seeds: string[];
  results: GraphRankedNode[];
  truncated: boolean;
}

export type GraphDepth = 1 | 2 | 3;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: { ...(await authHeader()) }, signal });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
      const parsed = body as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* a 500 (or a Vercel platform error) is an HTML page, not JSON — keep the status line */
    }
    if (res.status === 429) message = messageFromResponse(res, body, message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const graphClient = {
  /** One node and its neighborhood out to `depth` hops. Pass `signal` to
   *  cancel an in-flight request (a fast recenter click after a slow one). */
  get(node: string, depth: GraphDepth, signal?: AbortSignal): Promise<GraphSubgraph> {
    return getJson<GraphSubgraph>(`${GRAPH_URL}${buildQuery({ node, depth })}`, signal);
  },

  /** Free-text search to pick a start node for the standalone Graph view. */
  search(q: string, signal?: AbortSignal): Promise<GraphSearchResult> {
    return getJson<GraphSearchResult>(`${GRAPH_URL}${buildQuery({ q })}`, signal);
  },

  /** Personalized PageRank (R11, graph/rank.js): the records most strongly connected to one or
   *  more seeds, ranked, with the path that explains each one — not yet surfaced in
   *  KnowledgeGraph.tsx's own UI, but available for a future "most related" panel. */
  rank(seeds: string[], opts?: { limit?: number; alpha?: number }, signal?: AbortSignal): Promise<GraphRankResult> {
    return getJson<GraphRankResult>(`${GRAPH_URL}${buildQuery({ seeds: seeds.join(','), limit: opts?.limit, alpha: opts?.alpha })}`, signal);
  },
};
