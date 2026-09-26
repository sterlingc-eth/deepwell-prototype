import keys from "./_lib/routes/keys.js";
import tenantExport from "./_lib/routes/tenant-export.js";
import tenantDelete from "./_lib/routes/tenant-delete.js";
import cronSweep from "./_lib/routes/cron-sweep.js";
import mergeTenant from "./_lib/routes/merge-tenant.js";
import notifications from "./_lib/routes/notifications.js";
import outreach from "./_lib/routes/outreach.js";
import followups from "./_lib/routes/followups.js";
import expenses from "./_lib/routes/expenses.js";
import financials from "./_lib/routes/financials.js";
import graph from "./_lib/routes/graph.js";
import entityMerge from "./_lib/routes/entity-merge.js";
import naming from "./_lib/routes/naming.js";
import intake from "./_lib/routes/intake-resolve.js";
import grid from "./_lib/grid/route.js";

/**
 * Account-level operations, behind one function — see api/v1.js for why.
 *
 *   POST /api/keys            -> ?action=keys     (create / list / revoke API keys)
 *   POST /api/tenant-export   -> ?action=export   (everything, as JSON)
 *   POST /api/tenant-delete   -> ?action=delete   (everything, gone; needs confirm)
 *   GET  /api/cron-sweep      -> ?action=sweep    (find stuck documents; cron only)
 *   POST /api/merge-tenant    -> ?action=merge    (fold solo uploads into the shop)
 *   GET/POST notifications    -> ?action=notifications (bell icon list, mark read, digest toggle)
 *   POST outreach             -> ?action=outreach (warranty-upsell email drafts, settings, send)
 *   POST followups            -> ?action=followups (missing-info technician follow-ups, settings, run)
 *   POST expenses             -> ?action=expenses (DeepWell's own business expenses; platform-operator only)
 *   POST graph                -> ?action=graph   (Knowledge Graph v1: kg_edges backfill/refresh status; admin)
 *   POST entity-merge         -> ?action=entity-merge (duplicate-customer clusters: list/accept/reject/undo; admin)
 *   POST naming               -> ?action=naming   (document display names: status/backfill/assign
 *                                                   admin, rename any member — round 12)
 *   POST intake               -> ?action=intake   (clean exception queue: resolve/dismiss/snooze
 *                                                   one open question — any member — round 13)
 *   POST grid                 -> ?action=grid     (Grid view: documentCells/units — round 13)
 *
 * Each underlying handler does its own auth. Body limit and duration are the
 * maximum any member needs.
 *
 * maxDuration 300 (Vercel Pro, 2026-09-25): the cron sweep (?action=sweep) now also runs the T2 knowledge
 * layer's nightly dossier catch-up and async report-job sweep step (see cron-sweep.js) on top of its
 * existing per-tenant work — the same reasoning as ask.js's own 300s bump, just for the batch/cron side.
 * Every other action here still finishes in well under a second.
 */
export const config = { api: { bodyParser: { sizeLimit: "64kb" } }, maxDuration: 300 };

const ACTIONS = { keys, export: tenantExport, delete: tenantDelete, sweep: cronSweep, merge: mergeTenant, notifications, outreach, followups, expenses, financials, graph, "entity-merge": entityMerge, naming, intake, grid };

export default async function handler(req, res) {
  const action = String(req.query?.action ?? "");
  const target = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!target) return res.status(404).json({ error: "Unknown action", actions: Object.keys(ACTIONS) });
  return target(req, res);
}
