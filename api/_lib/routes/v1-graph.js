import { handleCors, handleError } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit } from "../rateLimit.js";
import { getSubgraph, getBacklinks, searchNodes, MAX_DEPTH, MAX_LIMIT } from "../graph/query.js";
import { rankRelatedNodes } from "../graph/rank.js";
import { withTenant } from "../recordsStore.js";

/**
 * GET /api/v1/graph?node=<id>&depth=<n>&edgeTypes=<a,b>&limit=<n>       -> subgraph
 * GET /api/v1/graph?node=<id>&backlinks=1                              -> {node, backlinks}
 * GET /api/v1/graph?q=<text>                                           -> {matches:[...]}
 * GET /api/v1/graph?seeds=<id,id>&limit=<n>&alpha=<0-1>                -> ranked (Personalized
 *                                                                        PageRank, R11 — see
 *                                                                        graph/rank.js)
 *
 * Knowledge Graph v1 (handoffs/DEEPWELL_KNOWLEDGE_GRAPH_V1, M3-config/37-knowledge-graph.sql).
 * Same auth/tenant/billing gate every other v1 resource takes (api/v1.js's RESOURCES map) — a
 * read, so no billing gate, same as v1-warranty.js/v1-equipment.js. All the graph logic itself
 * lives in api/_lib/graph/{build,query,rank}.js; this is a thin HTTP wrapper, exactly like those.
 *
 * Exactly one of `node`, `q`, or `seeds` must be given.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuthOrKey(req);
    assertScope(auth, "read");
  } catch (err) {
    return denyAuth(res, err);
  }

  if (!(await limit(req, res, auth, "read"))) return; // 429 already written

  const query = req.query ?? {};
  const node = typeof query.node === "string" && query.node.trim() ? query.node.trim() : null;
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : null;
  const seeds = typeof query.seeds === "string" && query.seeds.trim()
    ? query.seeds.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const given = [node, q, seeds].filter(Boolean).length;
  if (given === 0) return res.status(400).json({ error: "Provide one of ?node=, ?q=, or ?seeds=" });
  if (given > 1) return res.status(400).json({ error: "Provide only one of ?node=, ?q=, or ?seeds=" });

  const ctxArg = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    if (q) {
      const matches = await searchNodes({ withTenant, ctxArg, q, limit: query.limit });
      return handleCors(res, req).status(200).json({ matches });
    }

    if (seeds) {
      // Personalized PageRank (R11, graph/rank.js) — ranked-by-connectivity alternative to a
      // plain subgraph walk; same tenant scope, no billing gate (a read, like the rest of this
      // route).
      const out = await rankRelatedNodes({ withTenant, ctxArg, seeds, limit: query.limit, alpha: query.alpha, today: typeof query.today === "string" ? query.today : undefined });
      return handleCors(res, req).status(200).json(out);
    }

    const today = typeof query.today === "string" ? query.today : undefined;
    if (String(query.backlinks ?? "") === "1" || query.backlinks === "true") {
      const out = await getBacklinks({ withTenant, ctxArg, node, limit: query.limit, today });
      if (out.node == null) return res.status(400).json({ error: `Not a valid node id (expected customer:/unit:/document:/tech:/site:<value>)` });
      return handleCors(res, req).status(200).json(out);
    }

    const edgeTypes = typeof query.edgeTypes === "string" && query.edgeTypes.trim()
      ? query.edgeTypes.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const out = await getSubgraph({ withTenant, ctxArg, node, depth: query.depth ?? MAX_DEPTH, edgeTypes, limit: query.limit ?? MAX_LIMIT, today });
    if (out.center == null) return res.status(400).json({ error: `Not a valid node id (expected customer:/unit:/document:/tech:/site:<value>)` });
    return handleCors(res, req).status(200).json(out);
  } catch (error) {
    return handleError(res, error, req);
  }
}
