/**
 * Industry demo account (demo@deepwelltechnology.com): one demo company per industry, each an ordinary tenant with
 * plan 'demo' and billing_status 'demo' (set ONLY by M3-config/demo/D1 from the SQL editor - no API route can write it).
 *
 * What a demo company can do: read, browse, ask Donovan, upload and scan (the presenter's live scan), and "Clear my scans".
 * What it cannot do (refused here, server-side, whatever the browser shows): billing and plan changes, settings and
 * company changes, inviting or managing people, data export, deleting documents or the company, editing facts, and
 * anything that sends email or texts. Its questions are never logged as Donovan misses or handoffs, so nothing a prospect
 * types reaches Donovan's learning, training sets or the growth page.
 */
import { getCachedBillingRow, isDemoTenantRow } from '../plan.js';

export { isDemoTenantRow };

/** The customer-facing message for anything the demo turns off. Positive and factual. */
export const DEMO_RESTRICTED_MESSAGE = 'This is a demo company, so this part of DeepWell is turned off. Everything else works just like a real account.';

/** Organization names the demo uses: "Demo · <Industry> — <company>". */
export const DEMO_ORG_PREFIX = 'Demo · ';

/** True when the auth's company is an industry demo company. Fails CLOSED for the restriction checks (a lookup error
 *  is treated as "maybe demo" only where the caller asks for it), and never throws. */
export async function isDemoAuth(auth, { failClosed = false } = {}) {
  if (!auth?.tenantId) return false;
  try {
    return isDemoTenantRow(await getCachedBillingRow({ tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId }));
  } catch {
    return failClosed;
  }
}

/** Same, for a {tenantKey, tenantName} ctx (recorders that only have the ctx). */
export async function isDemoCtx(ctx) {
  if (!ctx?.tenantKey) return false;
  try { return isDemoTenantRow(await getCachedBillingRow(ctx)); } catch { return false; }
}

/** Send the standard 403 for a turned-off feature. */
export function sendDemoRestricted(res, req) {
  if (typeof res.setHeader === 'function') res.setHeader('X-DW-Demo', '1');
  return res.status(403).json({ error: DEMO_RESTRICTED_MESSAGE, demo: true, code: 'demo-restricted' });
}

/* ------------------------------------------------------------------ what is turned off, per endpoint */

/* ------------------------------------------------------------------ ALLOW-LISTS (fix round 2, 2026-10-22)
 * Every demo gate below is an ALLOW-LIST: a demo-plan login may only call the specific actions the demo needs (read, ask,
 * upload, scan, clear-scans, switch industry). Anything not named here - including any action or op added to the app later -
 * answers the friendly 403 until somebody consciously adds it. (Round 1 was a deny-list; a verifier found five routes it missed.)
 */

/** One entry per /api/account?action=...: `any` = every op (read-only routes), `ops` = only these body.op / query.op values,
 *  `when(body)` = custom rule for routes that do not use `op`. No entry = turned off. */
export const DEMO_ACCOUNT_ALLOW = Object.freeze({
  // the demo's own route: status (any member), clear-scans (demo companies only), reset-all (cron secret) - it enforces its own auth
  demo: { any: true },
  // read-only screens
  grid: { ops: ['units', 'documentCells'] },
  'ask-suggest': { ops: ['typeahead', 'samples', 'didyoumean'] },
  insights: { any: true },
  audience: { ops: ['get'] },
  naming: { ops: ['status'] },
  'unit-address': { ops: ['status'] },
  graph: { ops: ['status'] },
  financials: { ops: ['document', 'needsReview', 'summary', 'backfillStatus'] },
  'entity-merge': { ops: ['list', 'recent'] },
  // bell: reading and marking read only. Any body.settings (digest on/off, mute) or body.uiPrefs writes tenants.settings.
  notifications: { when: (b) => !(b && typeof b === 'object' && (b.settings != null || b.uiPrefs != null)) },
  // Support Assistant: asking the chat and the client error report only. handoff = sends an email; access-* = staff access; inquiry = email.
  support: { when: (b) => !(b && typeof b === 'object') || b.action == null || b.action === 'client-error' || b.action === 'access-status' },
});

/** True when a demo company may call /api/account?action=<action> (with this op/body). Everything not listed is refused. */
export function demoAccountAllowed(action, op, body) {
  const rule = Object.prototype.hasOwnProperty.call(DEMO_ACCOUNT_ALLOW, action) ? DEMO_ACCOUNT_ALLOW[action] : null;
  if (!rule) return false;
  if (rule.any) return true;
  if (rule.ops) return typeof op === 'string' && rule.ops.includes(op);
  if (rule.when) { try { return !!rule.when(body); } catch { return false; } }
  return false;
}

/** True when an account action (+ op) is turned off for a demo company. (Kept under its round-1 name; it is now just the inverse of the allow-list.) */
export function demoAccountBlocked(action, op, body) {
  return !demoAccountAllowed(action, op, body);
}

/** /api/billing?action=... - only the read-only status stays (it answers "demo"). Allow-list. */
export const DEMO_ALLOWED_BILLING_ACTIONS = new Set(['status']);

/** /api/review actions a demo company may call: reads, plus the automatic link repair a fresh upload uses. */
export const DEMO_ALLOWED_REVIEW_ACTIONS = new Set([
  'listLinks', 'listCorrections', 'remindersList', 'donovanSharing', 'semanticStatus', 'dossierStatus', 'supportAccessStatus', 'integrityFix',
]);
/** The only integrity fixes a demo company may run (non-destructive linking, same pair usePostgresSync runs on load). */
export const DEMO_ALLOWED_INTEGRITY_FIXES = new Set(['linkDocuments', 'linkEquipmentCustomers']);

/** True when a review action is allowed for a demo company with this payload. */
export function demoReviewAllowed(action, payload) {
  if (!DEMO_ALLOWED_REVIEW_ACTIONS.has(action)) return false;
  if (action === 'integrityFix') {
    const fixes = Array.isArray(payload?.apply) ? payload.apply : [];
    return fixes.length > 0 && fixes.every((f) => DEMO_ALLOWED_INTEGRITY_FIXES.has(f));
  }
  return true;
}
