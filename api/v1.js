import equipment from "./_lib/routes/v1-equipment.js";
import warranty from "./_lib/routes/v1-warranty.js";
import ingest from "./_lib/routes/v1-ingest.js";

/**
 * The public API surface, behind one function.
 *
 * Vercel's Hobby plan caps a deployment at twelve serverless functions, and
 * every file directly under api/ is one. The three v1 resources were three
 * files; this is one. vercel.json rewrites /api/v1/:resource here with the
 * resource name in the query, so callers still see clean paths:
 *
 *   GET  /api/v1/equipment?serial=…
 *   GET  /api/v1/warranty?withinDays=…
 *   POST /api/v1/ingest
 *
 * The handlers themselves live in api/_lib/routes/, where Vercel does not
 * count them.
 */
export const config = { api: { bodyParser: { sizeLimit: "16kb" } }, maxDuration: 60 };

const RESOURCES = { equipment, warranty, ingest };

export default async function handler(req, res) {
  const resource = String(req.query?.resource ?? "");
  const target = Object.prototype.hasOwnProperty.call(RESOURCES, resource) ? RESOURCES[resource] : null;
  if (!target) return res.status(404).json({ error: "Unknown resource", resources: Object.keys(RESOURCES) });
  return target(req, res);
}
