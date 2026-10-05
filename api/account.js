import { armResponseDeadline } from "./_lib/util/deadline.js";
import healthHandler from "./_lib/health.js";
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
import askSuggest from "./_lib/routes/ask-suggest.js";
import unitAddress from "./_lib/routes/unit-address-backfill.js";
import insights from "./_lib/routes/insights.js";
import audience from "./_lib/audience/route.js";
import industry from "./_lib/routes/industry.js";

/**
 * Account-level operations, behind one function — see api/v1.js for why.
 *
 *   POST /api/keys            -> ?action=keys     (create / list / revoke API keys)
 *   GET  /api/account?action=health -> uptime check: { ok, db, time } only, NO auth (see _lib/health.js)
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
 *   POST ask-suggest          -> ?action=ask-suggest (Ask-box typeahead/sample-prompts/did-you-mean;
 *                                                      no model call, ever — any member — round 14)
 *   POST unit-address         -> ?action=unit-address (equipment<->service_address backfill:
 *                                                        status/backfill, admin — round 16)
 *   POST insights             -> ?action=insights   (proactive "needs attention" list: warranty,
 *                                                      money, repeat-failure, data-gap detectors;
 *                                                      no model call — any member — round 17)
 *   POST audience             -> ?action=audience   (customer/internal doc classification: get one
 *                                                      document's audience, one-tap override — any
 *                                                      member — round 18, owner ask (a))
 *
 *   POST industry             -> ?action=industry  (company industry: get / set (owner only, audit-logged); picks the
 *                                                      industry pack + capability layers — Build 2 stage 2A)
 *
 *   GET/POST support          -> ?action=support    (DeepWell Support Assistant, round 28: website widget (no auth,
 *                                                      surface=public) and in-app help (Clerk); lazy-imported so the
 *                                                      Anthropic SDK stays out of the cold-start graph)
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

const ACTIONS = { keys, export: tenantExport, delete: tenantDelete, sweep: cronSweep, merge: mergeTenant, notifications, outreach, followups, expenses, financials, graph, "entity-merge": entityMerge, naming, intake, grid, "ask-suggest": askSuggest, "unit-address": unitAddress, insights, audience, support: (q, s) => import("./_lib/support/route.js").then((m) => m.default(q, s)) , industry};

export default async function handler(req, res) {
  const action = String(req.query?.action ?? "");
  // The one unauthenticated action: reveals only {ok, db, time}. Answered before anything else.
  if (action === "health") return healthHandler(req, res);
  const target = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!target) return res.status(404).json({ error: "Unknown action", actions: Object.keys(ACTIONS) });
  // maxDuration is 300s. The nightly sweep manages its own deadline and returns a partial summary, so it is excluded.
  // Export streams its own body with its own 240s budget + resume token; a 504 appended mid-stream would corrupt the file.
  if (action !== "sweep" && action !== "export") armResponseDeadline(res, 290_000);
  return target(req, res);
}
