import { handleCors, handleError } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit } from "../rateLimit.js";
import { getWarrantyAttention } from "../../warranty-attention.js";

/**
 * GET /api/v1-warranty?withinDays=<n>
 *
 * The clean public surface for the warranty reminder list — see
 * api/v1-equipment.js's header for why a GET route exists alongside the
 * app's own POST /api/warranty-attention. `withinDays`, if given, sets BOTH
 * registerWithinDays and expiringWithinDays (the two knobs
 * getWarrantyAttention exposes) to the same value; a caller that needs them
 * different still has the POST route.
 *
 * All lookup and formatting logic lives in api/warranty-attention.js (owned
 * by this same engineer) and is reused here unchanged via
 * getWarrantyAttention.
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
  const withinDays = query.withinDays;

  try {
    const result = await getWarrantyAttention(auth, {
      today: typeof query.today === "string" ? query.today : undefined,
      registerWithinDays: withinDays,
      expiringWithinDays: withinDays,
    });
    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    if (error?.name === "WarrantyAttentionError") {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    return handleError(res, error, req);
  }
}
