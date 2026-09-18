import keys from "./_lib/routes/keys.js";
import tenantExport from "./_lib/routes/tenant-export.js";
import tenantDelete from "./_lib/routes/tenant-delete.js";
import cronSweep from "./_lib/routes/cron-sweep.js";
import mergeTenant from "./_lib/routes/merge-tenant.js";

/**
 * Account-level operations, behind one function — see api/v1.js for why.
 *
 *   POST /api/keys            -> ?action=keys     (create / list / revoke API keys)
 *   POST /api/tenant-export   -> ?action=export   (everything, as JSON)
 *   POST /api/tenant-delete   -> ?action=delete   (everything, gone; needs confirm)
 *   GET  /api/cron-sweep      -> ?action=sweep    (find stuck documents; cron only)
 *   POST /api/merge-tenant    -> ?action=merge    (fold solo uploads into the shop)
 *
 * Each underlying handler does its own auth. Body limit and duration are the
 * maximum any member needs.
 */
export const config = { api: { bodyParser: { sizeLimit: "64kb" } }, maxDuration: 60 };

const ACTIONS = { keys, export: tenantExport, delete: tenantDelete, sweep: cronSweep, merge: mergeTenant };

export default async function handler(req, res) {
  const action = String(req.query?.action ?? "");
  const target = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!target) return res.status(404).json({ error: "Unknown action", actions: Object.keys(ACTIONS) });
  return target(req, res);
}
