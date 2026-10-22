import { armResponseDeadline } from "./_lib/util/deadline.js";
import healthHandler from "./_lib/health.js";
import keys from "./_lib/routes/keys.js";
import tenantExport from "./_lib/routes/tenant-export.js";
import accountExport from "./_lib/routes/account-export.js";
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
import demo from "./_lib/demo/route.js";
import { requireAuthOrKey } from "./_lib/apiKeyAuth.js";
import { isDemoAuth, demoAccountAllowed, sendDemoRestricted } from "./_lib/demo/index.js";

/**
 * Account-level operations, behind one function — see api/v1.js for why.
 *
 *   POST /api/keys            -> ?action=keys     (create / list / revoke API keys)
 *   GET  /api/account?action=health -> uptime check: { ok, db, time } only, NO auth (see _lib/health.js)
 *   POST /api/tenant-export   -> ?action=export   (everything, as JSON)
 *   POST export-files         -> ?action=export-files (every original file as zip parts + CSVs; background job; admin only)
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
 *   GET/POST demo             -> ?action=demo      (industry demo account: status, "Clear my scans", nightly reset (cron) -
 *                                                      see _lib/demo/route.js). Every other action below that a demo company
 *                                                      must not use (export, delete, outreach, edits ...) answers 403 for it.
 *
 *   GET/POST backup           -> ?action=backup    (nightly encrypted data backup + status; OFF unless DEEPWELL_BACKUP=1;
 *                                                      cron secret or platform operator only; lazy-imported)
 *   GET/POST google-sync      -> ?action=google-sync (Connected sources: Google Drive + Gmail attachments; OFF unless
 *                                                      DEEPWELL_GOOGLE_SYNC=1; admin only; lazy-imported)
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

const ACTIONS = { keys, export: tenantExport, "export-files": accountExport, delete: tenantDelete, sweep: cronSweep, merge: mergeTenant, notifications, outreach, followups, expenses, financials, graph, "entity-merge": entityMerge, naming, intake, grid, "ask-suggest": askSuggest, "unit-address": unitAddress, insights, audience, demo, support: (q, s) => import("./_lib/support/route.js").then((m) => m.default(q, s)),
  // Google Drive / Gmail sync: ships OFF. With DEEPWELL_GOOGLE_SYNC unset nothing from googleSync/ is even imported.
  // Data backup (nightly encrypted copy to a separate bucket): ships OFF. With DEEPWELL_BACKUP unset the handler answers
  // 404 / {enabled:false} and nothing else in backup/ is loaded. Cron-secret or platform operator only.
  backup: (q, s) => import("./_lib/backup/route.js").then((m) => m.default(q, s)),
  "google-sync": (q, s) => process.env.DEEPWELL_GOOGLE_SYNC === "1"
    ? import("./_lib/googleSync/route.js").then((m) => m.default(q, s))
    : s.status(q.method === "POST" && q.body?.op === "status" ? 200 : 404).json(q.method === "POST" && q.body?.op === "status" ? { enabled: false } : { error: "Not available." }) };

export default async function handler(req, res) {
  const action = String(req.query?.action ?? "");
  // The one unauthenticated action: reveals only {ok, db, time}. Answered before anything else.
  if (action === "health") return healthHandler(req, res);
  const target = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!target) return res.status(404).json({ error: "Unknown action", actions: Object.keys(ACTIONS) });
  // Industry demo (ALLOW-LIST): a demo company may only call the actions named in DEMO_ACCOUNT_ALLOW (_lib/demo/index.js);
  // everything else - including any action added later - is refused here, before the handler runs. Only for authenticated
  // callers that are demo companies; real companies, the cron secret and the public support widget are unaffected.
  if (!demoAccountAllowed(action, req.body?.op ?? req.query?.op, req.body)) {
    let auth = null;
    try { auth = await requireAuthOrKey(req); } catch { auth = null; }
    if (auth && (await isDemoAuth(auth, { failClosed: true }))) return sendDemoRestricted(res, req);
  }
  // maxDuration is 300s. The nightly sweep manages its own deadline and returns a partial summary, so it is excluded.
  // Export streams its own body with its own 240s budget + resume token; a 504 appended mid-stream would corrupt the file.
  if (action !== "sweep" && action !== "export" && action !== "demo") armResponseDeadline(res, 290_000);
  return target(req, res);
}
