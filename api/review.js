/**
 * POST /api/review — persistence for the review screen's six actions.
 *
 * A sibling of api/records.ts, not a case added to it: the build brief that
 * created this route (see HANDOFF.md) was explicit that review actions must
 * not join records.ts's generic { action, ...payload } -> store method
 * dispatch, because every one of them is a guarded state transition
 * (extractions.corrected_*, documents.verified_*, entities.merged_into,
 * document_entity_links) that a generic column-allowlist updater cannot
 * express safely — see api/_lib/reviewStore.js's module comment.
 *
 * Same two rules as api/records.ts:
 *   1. The store is imported from ./_lib/ so Vercel bundles it into this
 *      function.
 *   2. The tenant AND the acting user's Clerk id come only from the verified
 *      token, never the request body. reviewStore.js's `by` parameters
 *      (corrected_by, linked_by, verified_by) are a client-supplied DISPLAY
 *      label — plain text like "You" or a technician's name, no different
 *      from what ReviewScreen already showed before anything persisted — and
 *      are not a trust boundary; the audit_log actor (`actorClerkId` below)
 *      is a separate value this file derives from `auth.userId` and appends
 *      itself, exactly as api/records.ts appends `clerk_user_id`.
 */
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from './_lib/auth.js';
import * as reviewStore from './_lib/reviewStore.js';
import { deleteDocuments } from './_lib/routes/document-delete.js';
import { integrityScan, integrityFix } from './_lib/routes/integrity.js';
import { limit } from './_lib/rateLimit.js';
import { assertActiveBilling } from './_lib/plan.js';
// Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): owner/admin-only
// read of the ask_misses table missStore.js writes from api/ask.js.
import { missReport, exportMisses } from './_lib/missStore.js';
// Miss digest, Tier 1 of the self-learning loop (api/_lib/missDigest.js):
// platform-operator-only, cross-tenant — a normal tenant admin never sees this.
import { buildMissDigest, sendMissDigest, isPlatformOperator } from './_lib/missDigest.js';

// integrityScan/integrityFix aren't billed AI calls, but a scan walks up to
// 1000 documents and a fix can loop that same set doing writes — cheap per
// call, not cheap looped by a stuck client tab or a runaway effect. No
// bucket named "write" has its own DEFAULT_LIMITS entry; envLimits() falls
// back to DEFAULT_LIMITS.read (120/min, 5000/day) for an unrecognized
// bucket, which is what this gets — tracked under its own (tenantId,
// 'write') counters, not shared with the 'read' bucket's own traffic.
// missDigest joins this bucket too: it's not a billed model call, but it's a
// cross-tenant scan (list_ask_misses_window, capped at 5000 rows per window,
// run twice) that an operator's dashboard could otherwise poll without limit.
const INTEGRITY_RATE_LIMIT_ACTIONS = new Set(['integrityScan', 'integrityFix', 'missDigest']);

// HARD GATE (Reviewer NO-GO, 2026-09-21): which of this route's actions
// spend a real Anthropic-billed model call and so need the billing gate
// before running. 'aiVerify' (reviewStore.aiVerifyDocument) does NOT belong
// here — read its doc comment: it recomputes completeness from ALREADY-
// STORED extractions and never calls the model. 'reclassify'
// (reviewStore.reclassifyDocuments) does, as a Haiku fallback when its
// deterministic heuristic can't place a document — see RECLASSIFY_MODEL in
// reviewStore.js.
const MODEL_BILLED_ACTIONS = new Set(['reclassify']);

// Same admin gate as integrityFix (routes/integrity.js) — a merge irreversibly
// renumbers/retires customer or equipment records, so on a Clerk org tenant
// only an admin may trigger one. A solo tenant (no org) is its own admin.
function requireAdminForMerge(auth) {
  try {
    if (hasShop(auth)) requireRole(auth, 'admin');
  } catch (err) {
    if (err instanceof AuthError) throw new reviewStore.ReviewError(err.message, err.status);
    throw err;
  }
}

// Same gate, generic name — used by the miss-report/export actions below
// (owner/admin only; a solo tenant with no shop is its own admin, same as
// every other admin-gated action in this file).
const requireAdmin = requireAdminForMerge;

// STRICTEST gate in this file: not a tenant role at all, but a platform
// operator — the founder tenant or a Clerk user id on the DEEPWELL_OPERATOR_
// USER_IDS allowlist (see api/_lib/missDigest.js's isPlatformOperator). A
// tenant's own admin, even the founder shop's non-founder admins, gets 403.
function requireOperator(auth) {
  if (!isPlatformOperator(auth)) {
    throw new reviewStore.ReviewError('This action is restricted to DeepWell platform operators.', 403);
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '256kb' } },
  // reclassify can make up to 20 sequential model calls (see reviewStore.js's
  // RECLASSIFY_DEADLINE_MS); the platform default ceiling is shorter than
  // that could need.
  maxDuration: 60,
};

const ACTIONS = new Set([
  'correctField',
  'classifyDocument',
  'linkDocument',
  'unlinkDocument',
  'verifyDocument',
  'unverifyDocument',
  'mergeEntities',
  'listLinks',
  'listCorrections',
  'deleteDocuments',
  'aiVerify',
  'reclassify',
  'createCustomer',
  'updateCustomer',
  'assignDocumentCustomer',
  'mergeCustomers',
  'integrityScan',
  'integrityFix',
  'missReport',
  'exportMisses',
  'missDigest',
]);

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }

  const { action, ...rest } = req.body ?? {};
  if (!action || !ACTIONS.has(action)) {
    return res.status(400).json({ error: `Unknown action: ${action ?? ''}` });
  }

  // Same stripping as api/records.ts: whatever the client thinks the tenant
  // or the acting user's Clerk id is, drop it before it reaches the store.
  const payload = { ...rest };
  for (const k of ['tenantId', 'tenant_id', 'tenantID', 'TenantId', 'actorClerkId', 'clerk_user_id']) {
    delete payload[k];
  }

  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  if (INTEGRITY_RATE_LIMIT_ACTIONS.has(action)) {
    if (!(await limit(req, res, auth, 'write'))) return; // 429 already written
  }

  if (MODEL_BILLED_ACTIONS.has(action)) {
    // Fails CLOSED — see assertActiveBilling's own doc comment.
    const billingGate = await assertActiveBilling(ctx);
    if (!billingGate.allowed) {
      return res.status(billingGate.status).json({ error: billingGate.error, ...(billingGate.url ? { url: billingGate.url } : {}) });
    }
  }

  try {
    let result;
    switch (action) {
      case 'correctField':
        result = await reviewStore.correctField(ctx, payload, auth.userId);
        break;
      case 'classifyDocument':
        result = await reviewStore.classifyDocument(ctx, payload, auth.userId);
        break;
      case 'linkDocument':
        result = await reviewStore.linkDocument(ctx, payload, auth.userId);
        break;
      case 'unlinkDocument':
        result = await reviewStore.unlinkDocument(ctx, payload, auth.userId);
        break;
      case 'verifyDocument':
        result = await reviewStore.verifyDocument(ctx, payload, auth.userId);
        break;
      case 'unverifyDocument':
        result = await reviewStore.unverifyDocument(ctx, payload, auth.userId);
        break;
      case 'mergeEntities':
        requireAdminForMerge(auth);
        result = await reviewStore.mergeEntities(ctx, payload, auth.userId);
        break;
      case 'listLinks':
        result = await reviewStore.listLinks(ctx, payload);
        break;
      case 'listCorrections':
        result = await reviewStore.listCorrections(ctx, payload);
        break;
      case 'deleteDocuments':
        result = await deleteDocuments(ctx, payload, auth);
        break;
      case 'aiVerify':
        result = await reviewStore.aiVerifyDocument(ctx, payload, auth.userId);
        break;
      case 'reclassify':
        result = await reviewStore.reclassifyDocuments(ctx, payload, auth.userId);
        break;
      case 'createCustomer':
        result = await reviewStore.createCustomer(ctx, payload, auth.userId);
        break;
      case 'updateCustomer':
        result = await reviewStore.updateCustomer(ctx, payload, auth.userId);
        break;
      case 'assignDocumentCustomer':
        result = await reviewStore.assignDocumentCustomer(ctx, payload, auth.userId);
        break;
      case 'mergeCustomers':
        requireAdminForMerge(auth);
        result = await reviewStore.mergeCustomers(ctx, payload, auth.userId);
        break;
      case 'integrityScan':
        result = await integrityScan(ctx);
        break;
      case 'integrityFix':
        result = await integrityFix(ctx, payload, auth);
        break;
      case 'missReport':
        requireAdmin(auth);
        // `isOperator` tells the client (DonovanMissesCard) whether to show
        // the "Send digest now" button — the client never hardcodes ids, it
        // just trusts what the server already knows about this caller.
        result = { ...(await missReport(ctx, { days: payload.days })), isOperator: isPlatformOperator(auth) };
        break;
      case 'exportMisses':
        requireAdmin(auth);
        result = await exportMisses(ctx);
        break;
      case 'missDigest':
        requireOperator(auth);
        result = payload.send === true
          ? await sendMissDigest({ since: payload.since })
          : { digest: await buildMissDigest({ since: payload.since }) };
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    return res.json(result ?? null);
  } catch (err) {
    if (err instanceof reviewStore.ReviewError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Log the detail, return none of it — same reasoning as api/records.ts.
    console.error('review API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
