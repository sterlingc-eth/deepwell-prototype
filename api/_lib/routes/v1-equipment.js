import { handleCors, handleError } from "../claude.js";
import { denyAuth } from "../auth.js";
import { requireAuthOrKey, assertScope } from "../apiKeyAuth.js";
import { limit } from "../rateLimit.js";
import { getCustomerEquipment, getEquipmentBySerial } from "./customer-equipment.js";

/**
 * GET /api/v1-equipment?serial=<serial>
 * GET /api/v1-equipment?customerId=<uuid>
 *
 * The clean public surface: a partner API, a Chrome extension, an MMS intake
 * worker or an MCP server calling with `Authorization: Bearer dw_live_…` and
 * the 'read' scope, none of which post JSON bodies the way the app's own UI
 * does. A GET with query params is the natural shape for an external caller
 * and for an MCP tool's schema; the POST /api/customer-equipment route stays
 * exactly as it is for the app.
 *
 * This is a thin wrapper: all the actual lookup and warranty-formatting logic
 * lives in api/customer-equipment.js (owned by this same engineer) and is
 * reused here unchanged via getCustomerEquipment / getEquipmentBySerial.
 *
 * Exactly one of `serial` or `customerId` must be given.
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
  const serial = typeof query.serial === "string" ? query.serial : null;
  const customerId = typeof query.customerId === "string" ? query.customerId : null;

  if (!serial && !customerId) {
    return res.status(400).json({ error: "Provide either ?serial= or ?customerId=" });
  }
  if (serial && customerId) {
    return res.status(400).json({ error: "Provide only one of ?serial= or ?customerId=" });
  }

  const params = {
    today: typeof query.today === "string" ? query.today : undefined,
    expiringWithinDays: query.expiringWithinDays,
  };

  try {
    const result = customerId
      ? await getCustomerEquipment(auth, { ...params, customerId })
      : await getEquipmentBySerial(auth, { ...params, serial });
    return handleCors(res, req).status(200).json(result);
  } catch (error) {
    if (error?.status && error?.name?.endsWith("Error")) {
      return handleCors(res, req).status(error.status).json({ error: error.message });
    }
    return handleError(res, error, req);
  }
}
