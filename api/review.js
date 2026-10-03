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
import { armResponseDeadline } from './_lib/util/deadline.js';
import { requireAuth, denyAuth, hasShop, requireRole, AuthError } from './_lib/auth.js';
import * as reviewStore from './_lib/reviewStore.js';
import { deleteDocuments } from './_lib/routes/document-delete.js';
import { integrityScan, integrityFix } from './_lib/routes/integrity.js';
import { limit } from './_lib/rateLimit.js';
import { recheckDocument, recheckTenantMissing } from './_lib/recheck.js';
import { assertActiveBilling } from './_lib/plan.js';
// Miss loop (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): owner/admin-only
// read of the ask_misses table missStore.js writes from api/ask.js.
import { missReport, exportMisses } from './_lib/missStore.js';
// Miss digest, Tier 1 of the self-learning loop (api/_lib/missDigest.js):
// platform-operator-only, cross-tenant — a normal tenant admin never sees this.
import { buildMissDigest, sendMissDigest, isPlatformOperator } from './_lib/missDigest.js';
// Donovan self-learning, Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md):
// the operator-only proposal queue/decide/deactivate/run-now/export actions.
// Same platform-operator gate as missDigest above — a tenant's own admin,
// even the founder shop's non-founder admins, gets 403 on all five.
import * as learningStore from './_lib/learning/store.js';
import { verifyProposalLive } from './_lib/learning/verify.js';
import { normalizeGapTitle } from './_lib/learning/proposals.js';
import { runLearningNow } from './_lib/learning/sweep.js';
// Donovan learning loop (miss replay, recipes, thumbs feedback): api/_lib/learning/replay.js.
import { replayMisses, replayCapabilityGap, applyThumbsUp, applyThumbsDown, missKey } from './_lib/learning/replay.js';
import { listReplays, listOpenMisses } from './_lib/learning/replayStore.js';
import { verifyRecipe, RECIPE_KIND } from './_lib/learning/recipes.js';
import { invalidateActiveOverlayCache } from './_lib/learning/overlay.js';
// Donovan Scorecard (api/_lib/scorecard, routes/scorecard.js): the golden-exam runner + status, operator-only.
import { scorecardRunAction, scorecardStatusAction, scorecardBaselineAction } from './_lib/routes/scorecard.js';
// TEAM H (2026-09-24): the autonomous PER-TENANT learning loop's operator-only status + weekly gap
// report reads. The loop itself only ever runs from cron-sweep.js's nightly step; these two actions
// are read-only (learningAutopilotStatus also computes "who runs next" from the rotation, no DB write).
import { listEligibleTenants, isoWeekStart, listRecentAutopilotSummaries } from './_lib/learning/autopilot.js';
import { rotationForDate } from './_lib/learning/rotation.js';
import { buildGapReport, latestGapReport } from './_lib/learning/gapReport.js';
// Round 17 (G3): misses -> permanent exam questions (api/_lib/learning/examPromote.js) — same
// requireOperator gate as the rest of the Donovan learning card, tenant-scoped (a promoted test's
// oracle SQL names this tenant's own document/entity ids, so it can never be shared cross-tenant).
import { promoteMissToExamCandidate, insertPromotedTest, listPromotedTests, rowsToQuestions, buildPromotedExport } from './_lib/learning/examPromote.js';
// Search by meaning: status + resumable backfill of embeddings for existing pages (api/_lib/search/store.js).
import { semanticStatus, runBackfill } from './_lib/search/store.js';
// TEAM T2 (2026-09-25): dossiers — status + resumable, budget-aware backfill (api/_lib/search/dossier.js).
import { dossierStatus, runDossierBackfillPage } from './_lib/search/dossier.js';
// Round 22 (S2, privacy): time-boxed, revocable, logged staff access to a tenant's own content — see
// api/_lib/privacy/supportAccess.js's own module doc for the gap this closes and which operator
// actions below need it (gateSupportAccess) vs. are exempt (SUPPORT-ACCESS-EXEMPT comments).
import {
  requireSupportAccess, grantSupportAccess, revokeSupportAccess, getActiveGrant, listGrants, listAccessLog,
} from './_lib/privacy/supportAccess.js';

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
// learningRunNow joins this bucket too: unlike missDigest it's a REAL billed
// model call (up to DONOVAN_LEARN_MAX_CALLS Haiku calls per invocation, see
// api/_lib/learning/proposer.js) — all the more reason a runaway client tab
// must not be able to poll it without limit.
// learningReplay / askFeedback are billed model calls too (the Donovan agent re-runs a question), so they share it.
// learningAutopilotStatus/learningGapReport join this bucket too: both are cross-tenant reads
// (list_autopilot_summary_window / a live gap-report rebuild can scan list_ask_misses_window and
// list_scorecard_failures_window) an operator's dashboard could otherwise poll without limit — same
// reasoning as missDigest above, even though neither makes a billed model call.
const INTEGRITY_RATE_LIMIT_ACTIONS = new Set(['recheckDocument', 'recheckMissing', 'integrityScan', 'integrityFix', 'missDigest', 'learningRunNow', 'learningReplay', 'learningRejectAllGaps', 'askFeedback', 'scorecardRun', 'scorecardBaseline', 'semanticBackfill', 'dossierBackfill', 'learningAutopilotStatus', 'learningGapReport']);
const OPERATOR_ACTIONS = new Set(['missDigest', 'learningList', 'learningDecide', 'learningDeactivate', 'learningRunNow', 'learningExport', 'learningReplay', 'learningRejectAllGaps', 'scorecardRun', 'scorecardStatus', 'scorecardBaseline', 'learningAutopilotStatus', 'learningGapReport', 'examPromote', 'examList', 'examExport']);

// HARD GATE (Reviewer NO-GO, 2026-09-21): which of this route's actions
// spend a real Anthropic-billed model call and so need the billing gate
// before running. 'aiVerify' (reviewStore.aiVerifyDocument) does NOT belong
// here — read its doc comment: it recomputes completeness from ALREADY-
// STORED extractions and never calls the model. 'reclassify'
// (reviewStore.reclassifyDocuments) does, as a Haiku fallback when its
// deterministic heuristic can't place a document — see RECLASSIFY_MODEL in
// reviewStore.js.
const MODEL_BILLED_ACTIONS = new Set(['reclassify', 'extractReminders', 'semanticBackfill', 'dossierBackfill']);

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

// Round 22 (S2, privacy): the SECOND gate an operator action needs, beyond requireOperator above —
// requireOperator only proves the caller IS DeepWell staff; it says nothing about whether THIS
// tenant (ctx.tenantKey — whichever org the caller's own JWT happens to belong to, see auth.js's
// deriveAuth) has actually agreed to let staff look at its content right now. See
// api/_lib/privacy/supportAccess.js's module doc for the full reasoning and the founder-tenant
// exemption. `payload.emergencyReason` is the documented "break-glass" escape hatch — a non-empty
// string proceeds with no grant, but is logged with is_emergency=true and surfaced in that tenant's
// own Access log (Settings), never silently.
async function gateSupportAccess(auth, ctx, action, payload, recordCount) {
  const decision = await requireSupportAccess(ctx, {
    staffUserId: auth.userId,
    action,
    recordCount,
    emergencyReason: payload?.emergencyReason,
  });
  if (!decision.allowed && decision.reason === 'access-log-unavailable') {
    throw new reviewStore.ReviewError('The support-access log could not be written, so this access was refused. Try again in a moment.', 503);
  }
  if (!decision.allowed) {
    throw new reviewStore.ReviewError(
      'This tenant has not granted DeepWell staff support access. Ask the tenant\'s admin to grant time-boxed access in Settings, or resubmit with an emergencyReason for a logged break-glass access.',
      403
    );
  }
  return decision;
}

export const config = {
  api: { bodyParser: { sizeLimit: '256kb' } },
  // 300 (Vercel Pro, 2026-09-25): reclassify can make up to 20 sequential model calls (see reviewStore.js's
  // RECLASSIFY_DEADLINE_MS), and this route now also carries the scorecard exam run + T3's Claude-baseline
  // (scorecardRun/scorecardBaseline — dozens of graded questions, each its own model call) and T2's
  // resumable dossier/semantic backfills (semanticBackfill/dossierBackfill) — all considerably longer than
  // the old 60s platform default could reliably finish within.
  maxDuration: 300,
};

const ACTIONS = new Set([
  'correctField',
  'setUnitInstallDate',
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
  // R33: $0 re-read of a stored document's own page text for a missing required field (api/_lib/recheck.js).
  'recheckDocument',
  'recheckMissing',
  'reclassify',
  'createCustomer',
  'updateCustomer',
  'assignDocumentCustomer',
  'mergeCustomers',
  'keepCustomersSeparate',
  'dismissAlert',
  'remindersList',
  'reminderDone',
  'createCustomerAndAttachReminder',
  'extractReminders',
  'integrityScan',
  'integrityFix',
  'missReport',
  'exportMisses',
  'missDigest',
  'learningList',
  'learningDecide',
  'learningDeactivate',
  'learningRunNow',
  'learningExport',
  'learningReplay',
  'learningRejectAllGaps',
  'askFeedback',
  'scorecardRun',
  'scorecardStatus',
  'scorecardBaseline',
  'semanticStatus',
  'semanticBackfill',
  'dossierStatus',
  'dossierBackfill',
  'learningAutopilotStatus',
  'learningGapReport',
  'examPromote',
  'examList',
  'examExport',
  // Round 22 (S2, privacy): tenant-admin-managed, NOT operator-gated — a tenant's own admin grants/
  // revokes/reads access to their OWN tenant (requireAdmin below), same as billing or the data export
  // in AccountSettingsCard already are.
  'supportAccessGrant',
  'supportAccessRevoke',
  'supportAccessStatus',
  'supportAccessLog',
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

  // maxDuration is 300s: answer 504 (honest message) at 290s instead of being hard-killed with no response.
  armResponseDeadline(res, 290_000);

  // Operator-only actions are gated BEFORE the rate limiter so a forged
  // non-operator request never causes a resolve_tenant / counter write on its
  // way to the 403 (reviewer, Tier 2 round, 2026-09-22).
  if (OPERATOR_ACTIONS.has(action) && !isPlatformOperator(auth)) {
    return res.status(403).json({ error: 'This action is restricted to DeepWell platform operators.' });
  }

  if (INTEGRITY_RATE_LIMIT_ACTIONS.has(action)) {
    if (!(await limit(req, res, auth, 'write'))) return; // 429 already written
  }

  // A thumbs-down re-runs the question through the agent (a real model call), so it takes the same
  // billing gate; a thumbs-up costs nothing.
  if (MODEL_BILLED_ACTIONS.has(action) || (action === 'askFeedback' && payload.rating === 'down')) {
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
      case 'setUnitInstallDate':
        result = await reviewStore.setUnitInstallDate(ctx, payload, auth.userId);
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
      // R33: "Re-check this document" (Inbox missing-field banner). Fill-only from the page's own printed labels, no
      // model call, so it is a member action like aiVerify (which runs the same re-check first).
      case 'recheckDocument':
        try {
          result = await recheckDocument(ctx, payload.documentId, { actorClerkId: auth.userId, source: 'inbox' });
        } catch (err) {
          if (err?.status === 400) throw new reviewStore.ReviewError(err.message, 400);
          throw err;
        }
        break;
      // R33: "Re-check all missing fields" (Inbox bulk). Admin: it writes across many documents at once. Bounded
      // (<=100 per call; the caller loops on `leftForNextRun`), idempotent, $0.
      case 'recheckMissing':
        requireAdmin(auth);
        result = await recheckTenantMissing(ctx, {
          limit: Math.min(100, Number(payload.limit) || 50),
          documentIds: Array.isArray(payload.documentIds) ? payload.documentIds : null,
          force: payload.force === true,
          actorClerkId: auth.userId,
          source: 'inbox-bulk',
          deadlineAt: Date.now() + 240_000,
        });
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
      case 'keepCustomersSeparate':
        result = await reviewStore.keepCustomersSeparate(ctx, payload, auth.userId);
        break;
      case 'dismissAlert':
        result = await reviewStore.dismissAlert(ctx, payload, auth.userId);
        break;
      case 'remindersList':
        result = await reviewStore.remindersList(ctx, payload);
        break;
      case 'reminderDone':
        result = await reviewStore.reminderDone(ctx, payload, auth.userId);
        break;
      case 'createCustomerAndAttachReminder':
        result = await reviewStore.createCustomerAndAttachReminder(ctx, payload, auth.userId);
        break;
      case 'extractReminders':
        result = await reviewStore.extractReminders(ctx, payload, auth.userId);
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
        // Honest status per miss: what happened when Donovan re-ran it (learning/replay.js). Tenant-scoped.
        {
          const keys = result.groups.flatMap((g) => g.topQuestions.map((q) => q.text));
          const replays = await listReplays(ctx, keys);
          let answeredNow = 0;
          let stillFailing = 0;
          for (const g of result.groups) {
            for (const q of g.topQuestions) {
              const r = replays.get(q.text);
              if (r) {
                q.replay = r;
                if (r.outcome === 'answered_now') answeredNow++; else stillFailing++;
              }
            }
          }
          const distinct = new Set(keys).size;
          result.replaySummary = { answeredNow, stillFailing, notReplayed: Math.max(0, distinct - answeredNow - stillFailing) };
        }
        break;
      case 'exportMisses':
        requireAdmin(auth);
        result = await exportMisses(ctx);
        break;
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): cross-tenant AGGREGATE, no single tenant's content —
      // buildMissDigest merges every tenant's ask_misses together and reports only tenantCount (never
      // which tenants), with email/phone already redacted out of the question text it groups on (see
      // api/_lib/missDigest.js's own redactPII). Matches the R22 contract's "platform-wide aggregate
      // metrics with no tenant content" exception; docs/SECURITY.md names this explicitly.
      case 'missDigest':
        requireOperator(auth);
        result = payload.send === true
          ? await sendMissDigest({ since: payload.since })
          : { digest: await buildMissDigest({ since: payload.since }) };
        break;
      case 'learningList': {
        requireOperator(auth);
        // SUPPORT-ACCESS (Round 22, S2): reads THIS tenant's own open misses, replays, and promoted
        // tests (listOpenMisses/listReplays/listPromotedTests below all run against ctx.tenantKey) —
        // exactly the "misses/learning data" the R22 contract requires a grant for.
        await gateSupportAccess(auth, ctx, action, payload);
        // Both the proposal queue AND the currently-active learned items in
        // one round trip — the DonovanLearningCard UI needs both (pending
        // proposals to decide, active items to deactivate) and there is no
        // separate action for the latter (see api/_lib/learning/store.js's
        // listActiveLearned).
        const [items, activeLearned] = await Promise.all([
          learningStore.listProposals({ status: payload.status ?? null, limit: payload.limit }),
          learningStore.listActiveLearned(),
        ]);
        const open = await listOpenMisses(ctx, { limit: 200 });
        const gapKeys = items.filter((p) => p.kind === 'capability_gap' && p.payload?.example).map((p) => missKey(p.payload.example));
        const gapReplays = await listReplays(ctx, gapKeys);
        const withReplay = items.map((p) => (p.kind === 'capability_gap' && p.payload?.example && gapReplays.has(missKey(p.payload.example))
          ? { ...p, replay: gapReplays.get(missKey(p.payload.example)) } : p));
        // ROUND 14 (brief item 4, "dedupe gaps by normalized title"): the same missing capability gets
        // proposed once per differently-worded example question, which is what turned "a handful of
        // real gaps" into "71 pending". Folded here (display time), not at proposal time — each
        // underlying proposal keeps its own id/example/evidence for "Reject all" to act on, listed in
        // `groupIds`; only the representative (the most recent — items is already newest-first) is
        // returned, carrying `groupCount`.
        const nonGap = withReplay.filter((p) => p.kind !== 'capability_gap');
        const gapGroups = new Map();
        for (const p of withReplay) {
          if (p.kind !== 'capability_gap') continue;
          const key = normalizeGapTitle(p.payload?.title);
          const g = gapGroups.get(key);
          if (g) g.ids.push(p.id); else gapGroups.set(key, { rep: p, ids: [p.id] });
        }
        const dedupedGaps = [...gapGroups.values()].map(({ rep, ids }) => (
          ids.length > 1 ? { ...rep, groupCount: ids.length, groupIds: ids } : rep
        ));
        // Round 17 (G3, misses -> permanent exam): every answered-now miss the card can offer a
        // "Keep as test" button for, plus this tenant's own already-promoted count — reuses `open`
        // (already fetched above) rather than a second listOpenMisses round trip.
        const promotedRows = await listPromotedTests(ctx, { limit: 2000 });
        const promotedKeys = new Set(promotedRows.map((r) => r.question_normalized));
        const answeredNowMisses = open
          .filter((m) => m.replay?.outcome === 'answered_now')
          .map((m) => ({ question: m.question, normalized: m.normalized, answer: m.replay.answer, alreadyPromoted: promotedKeys.has(m.normalized) }));
        result = {
          items: [...nonGap, ...dedupedGaps],
          activeLearned,
          answeredNowMisses,
          promotedCount: promotedRows.length,
          summary: {
            recipesActive: activeLearned.filter((r) => r.kind === RECIPE_KIND).length,
            answeredNow: open.filter((m) => m.replay?.outcome === 'answered_now').length,
            stillFailing: open.filter((m) => m.replay?.outcome === 'still_failing').length,
            notReplayed: open.filter((m) => !m.replay).length,
          },
        };
        break;
      }
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): donovan_proposals/donovan_learned are PLATFORM-level
      // tables with no tenant_id column at all (see M3-config/26's own doc comment) — Donovan's own
      // routing-rule bank, not any one tenant's customer/document content. learningDecide/Deactivate/
      // RunNow/Export/RejectAllGaps below all read or write only those two tables.
      case 'learningDecide': {
        requireOperator(auth);
        const id = payload.id;
        const decision = payload.decision;
        if (!id || (decision !== 'approved' && decision !== 'rejected')) {
          throw new reviewStore.ReviewError('learningDecide requires an id and decision of "approved" or "rejected".', 400);
        }
        const proposal = await learningStore.getProposal(id);
        if (!proposal) throw new reviewStore.ReviewError('Proposal not found.', 404);

        if (decision === 'rejected') {
          const ok = await learningStore.decideProposal(id, 'rejected', auth.userId);
          if (!ok) throw new reviewStore.ReviewError('Could not reject this proposal.', 409);
          result = { ok: true, status: 'rejected' };
          break;
        }

        // Approve: RE-VERIFY against the CURRENT routing bank/vocabulary
        // first — a proposal can go stale between being proposed and an
        // operator clicking Approve (see learning/policy.js's own doc
        // comment) — so a proposal that verified clean last night but would
        // no longer pass today is refused rather than silently applied.
        const verification = proposal.kind === RECIPE_KIND
          ? verifyRecipe(proposal.payload)
          : verifyProposalLive(
            { kind: proposal.kind, payload: proposal.payload },
            { missQuestions: proposal.evidence?.questions ?? [] }
          );
        if (!verification.ok) {
          throw new reviewStore.ReviewError(
            `This proposal no longer verifies cleanly and cannot be approved: ${verification.reasons.join('; ')}`,
            409
          );
        }
        const ok = await learningStore.decideProposal(id, 'approved', auth.userId);
        if (!ok) throw new reviewStore.ReviewError('Could not approve this proposal.', 409);
        if (proposal.kind === RECIPE_KIND) invalidateActiveOverlayCache();
        result = { ok: true, status: 'approved', verification };
        // Approving a "Can't do yet" note must DO something: replay its example question now and, on a
        // grounded answer, create + activate its recipe. The outcome comes back for the card to show.
        // SUPPORT-ACCESS (Round 22, S2): unlike the rest of learningDecide (see the exemption comment
        // above), THIS branch runs the example question through the agent against ctx's real
        // documents (replayCapabilityGap -> replayMisses) — the exemption does not cover it.
        if (proposal.kind === 'capability_gap') {
          await gateSupportAccess(auth, ctx, 'learningDecide.replay', payload, 1);
          result.replay = await replayCapabilityGap({ ctxArg: ctx, proposal, decidedBy: auth.userId });
        }
        break;
      }
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): donovan_learned is the same platform-level, no-tenant_id
      // table the learningDecide exemption comment above explains.
      case 'learningDeactivate': {
        requireOperator(auth);
        if (!payload.learnedId) throw new reviewStore.ReviewError('learningDeactivate requires a learnedId.', 400);
        const ok = await learningStore.deactivateLearned(payload.learnedId);
        if (!ok) throw new reviewStore.ReviewError('Learned item not found.', 404);
        result = { ok: true };
        break;
      }
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): triggers the nightly proposer sweep, which reads
      // cross-tenant ask_misses aggregates and writes only to the platform-level donovan_proposals
      // table — same shape as the exemptions above.
      case 'learningRunNow':
        requireOperator(auth);
        result = await runLearningNow();
        break;
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): bulk-decides platform-level donovan_proposals rows
      // (same table the learningDecide exemption above explains), never a tenant's own content.
      case 'learningRejectAllGaps': {
        // ROUND 14 (brief item 4): bulk-reject "Can't do yet" (capability_gap) notes — the whole
        // pending queue when no `ids` are given (the card's own "Reject all feature requests"), or
        // just one dedupe group's ids (a group's own "Reject all" — see review.js's learningList,
        // which folds duplicate-titled capability_gap proposals into one row with `groupIds`).
        requireOperator(auth);
        const ids = Array.isArray(payload.ids)
          ? payload.ids.filter((id) => typeof id === 'string' && id).slice(0, 500)
          : (await learningStore.listProposals({ status: 'pending', limit: 1000 })).filter((p) => p.kind === 'capability_gap').map((p) => p.id);
        let rejected = 0;
        for (const id of ids) {
          if (await learningStore.decideProposal(id, 'rejected', auth.userId)) rejected++;
        }
        result = { rejected };
        break;
      }
      case 'learningReplay': {
        requireOperator(auth);
        // SUPPORT-ACCESS (Round 22, S2): re-runs this tenant's own open misses through the Donovan
        // agent against ITS OWN real documents (replayMisses) — a "replay ... against a tenant" in
        // the R22 contract's own words.
        const questions = Array.isArray(payload.questions)
          ? payload.questions.filter((q) => typeof q === 'string').slice(0, 15).map((q) => q.slice(0, 300))
          : undefined;
        await gateSupportAccess(auth, ctx, action, payload, questions?.length);
        result = await replayMisses({ ctxArg: ctx, questions, force: payload.force === true, source: 'operator' });
        break;
      }
      case 'askFeedback': {
        const question = typeof payload.question === 'string' ? payload.question.trim().slice(0, 300) : '';
        if (!question || (payload.rating !== 'up' && payload.rating !== 'down')) {
          throw new reviewStore.ReviewError('askFeedback requires a question and a rating of "up" or "down".', 400);
        }
        if (payload.rating === 'up') {
          result = { ok: true, ...(await applyThumbsUp({ ctxArg: ctx, question, isOperator: isPlatformOperator(auth), decidedBy: auth.userId })) };
        } else {
          const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 300) : '';
          result = { ok: true, ...(await applyThumbsDown({ ctxArg: ctx, question, note })) };
        }
        break;
      }
      // SUPPORT-ACCESS (Round 22, S2): "everything runs against the CALLING operator's own tenant"
      // (see api/_lib/routes/scorecard.js's own module doc) — normally the founder tenant (exempt),
      // but nothing stops an operator's JWT from belonging to some OTHER tenant instead (exactly the
      // Clerk-membership gap this file closes), and scorecardRun/Baseline ask real questions of, and
      // scorecardStatus reads real run results (including answer text) from, THAT tenant's own data.
      case 'scorecardRun':
        requireOperator(auth);
        await gateSupportAccess(auth, ctx, action, payload);
        result = await scorecardRunAction(ctx, auth, payload);
        break;
      case 'scorecardStatus':
        requireOperator(auth);
        await gateSupportAccess(auth, ctx, action, payload);
        result = await scorecardStatusAction(ctx, payload);
        break;
      case 'scorecardBaseline':
        requireOperator(auth);
        await gateSupportAccess(auth, ctx, action, payload);
        result = await scorecardBaselineAction(ctx, auth, payload);
        break;
      // TEAM H (2026-09-24): the autonomous per-tenant learning loop's own operator summary — last
      // night's per-tenant counts (audit_log, no question text), spend vs. the daily caps, and which
      // tenant runs next in tonight's fair rotation. Read-only; the loop itself only ever runs from
      // cron-sweep.js's nightly step.
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): platform-wide aggregate — per-tenant COUNTS and dollar
      // spend across every tenant in one response, no single tenant singled out, no question/answer
      // content. Matches the R22 contract's aggregate-metrics exception.
      case 'learningAutopilotStatus': {
        requireOperator(auth);
        const [summaries, eligible, gapReport] = await Promise.all([
          listRecentAutopilotSummaries(24),
          listEligibleTenants(),
          latestGapReport(),
        ]);
        const today = new Date().toISOString().slice(0, 10);
        const order = rotationForDate(eligible, today);
        const alreadyRan = new Set(summaries.map((s) => s.tenantKey));
        const nextUp = order.find((t) => !alreadyRan.has(t.tenantKey)) ?? order[0] ?? null;
        result = {
          tenantsEligible: eligible.length,
          perTenant: summaries,
          platformSpentUsd: Math.round(summaries.reduce((n, s) => n + (Number(s.costUsd) || 0), 0) * 10000) / 10000,
          nextTenant: nextUp ? { tenantKey: nextUp.tenantKey, tenantName: nextUp.tenantName } : null,
          gapReportWeekStart: gapReport?.weekStart ?? null,
        };
        break;
      }
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): cross-tenant aggregate clustering — buildGapReport
      // groups scorecard/miss failures by CAPABILITY across every tenant, and "never carry raw
      // question text: ask_misses only ever exposes its own already-redacted question_normalized"
      // (see gapReport.js's own module doc); tenantCount only, never which tenants.
      case 'learningGapReport': {
        requireOperator(auth);
        // A live rebuild (cross-tenant scan) on demand, or the last one the nightly step stored —
        // an operator can always see a report without waiting for the weekly cron claim to fire.
        result = payload.rebuild === true ? await buildGapReport({}) : (await latestGapReport()) ?? { weekStart: isoWeekStart(new Date().toISOString().slice(0, 10)), clusters: [], totalFailures: 0 };
        break;
      }
      // Search by meaning. Owner/admin only; backfill is billing-gated + rate-limited above and capped by
      // the tenant's daily embedding budget. Each call embeds what it can in ~30 s and reports progress; the
      // Team-screen card calls it again until stoppedBy is 'done' (idempotent + resumable).
      case 'semanticStatus':
        requireAdmin(auth);
        result = await semanticStatus(ctx);
        break;
      case 'semanticBackfill': {
        requireAdmin(auth);
        const run = await runBackfill(ctx);
        result = { ...run, status: await semanticStatus(ctx) };
        break;
      }
      // Dossiers (TEAM T2, 2026-09-25): same owner/admin-gated, billed, rate-limited shape as
      // semanticStatus/semanticBackfill above — the Team screen calls dossierBackfill in a loop
      // until stoppedBy is 'done' (idempotent + resumable, see dossier.js's runDossierBackfillPage).
      case 'dossierStatus':
        requireAdmin(auth);
        result = await dossierStatus(ctx);
        break;
      case 'dossierBackfill': {
        requireAdmin(auth);
        const run = await runDossierBackfillPage(ctx);
        result = { ...run, status: await dossierStatus(ctx) };
        break;
      }
      // SUPPORT-ACCESS-EXEMPT (Round 22, S2): donovan_proposals is the same platform-level, no-
      // tenant_id table the learningDecide exemption comment above explains.
      case 'learningExport':
        requireOperator(auth);
        {
          const rows = await learningStore.listProposals({ limit: 1000 });
          result = {
            items: rows
              .filter((r) => r.status === 'approved' || r.status === 'auto_approved')
              .map((r) => ({
                id: r.id, kind: r.kind, payload: r.payload, status: r.status,
                decidedAt: r.decided_at, decidedBy: r.decided_by, createdAt: r.created_at,
              })),
          };
        }
        break;
      // Round 17 (G3, R16 D3 research item 3): turn one resolved miss into a permanent exam
      // question. Tenant-scoped (ctx is already this request's own tenant) — see
      // api/_lib/learning/examPromote.js's module doc for why a promoted test can never be shared
      // cross-tenant. `normalized` should be the exact key a prior `learningList` response gave for
      // this miss (its `answeredNowMisses[].normalized`); a caller with only `question` falls back to
      // using it as its own key (still correct, just not overlay-normalized).
      // SUPPORT-ACCESS (Round 22, S2): examPromote/List/Export below all read/write THIS tenant's own
      // donovan_promoted_tests — real production questions and (for examPromote) a real extraction
      // value from this tenant's own documents (see examPromote.js's own oracleKind doc).
      case 'examPromote': {
        requireOperator(auth);
        await gateSupportAccess(auth, ctx, action, payload, 1);
        const question = typeof payload.question === 'string' ? payload.question.trim().slice(0, 300) : '';
        const normalized = typeof payload.normalized === 'string' && payload.normalized ? payload.normalized.slice(0, 300) : question;
        if (!question) throw new reviewStore.ReviewError('examPromote requires a question.', 400);
        const operatorLiteral = typeof payload.operatorLiteral === 'string' ? payload.operatorLiteral : undefined;
        const operatorCmp = typeof payload.operatorCmp === 'string' ? payload.operatorCmp : undefined;
        let answer = null;
        if (!operatorLiteral) {
          const replays = await listReplays(ctx, [normalized]);
          const replay = replays.get(normalized);
          if (!replay || replay.outcome !== 'answered_now') {
            throw new reviewStore.ReviewError('This miss has not been replayed to an answer yet — replay it first, or supply the expected answer yourself.', 400);
          }
          answer = replay.answer;
        }
        const candidate = promoteMissToExamCandidate({
          question, questionNormalized: normalized, outcome: 'answered_now', answer, tenantKey: ctx.tenantKey, operatorLiteral, operatorCmp,
        });
        if (!candidate.ok) throw new reviewStore.ReviewError(candidate.reason, 422);
        const row = await insertPromotedTest(ctx, {
          examId: candidate.question.id, questionNormalized: normalized, question: candidate.question.text,
          category: candidate.question.category, shape: candidate.question.shape, cmp: candidate.question.cmp,
          oracle: candidate.question.oracle, citationRequired: candidate.question.citationRequired === true,
          oracleKind: candidate.oracleKind, sourceOutcome: 'answered_now', createdBy: auth.userId,
        });
        if (!row) throw new reviewStore.ReviewError('Could not save this promoted test (migration 56 may not be applied yet).', 503);
        result = { ok: true, id: candidate.question.id, question: candidate.question, oracleKind: candidate.oracleKind };
        break;
      }
      case 'examList': {
        requireOperator(auth);
        await gateSupportAccess(auth, ctx, action, payload);
        const rows = await listPromotedTests(ctx, { limit: payload.limit ?? 500 });
        result = { items: rowsToQuestions(rows) };
        break;
      }
      // Returns this tenant's promoted set in the exact JSON shape
      // test-docs/scorecard/generalization/*.json files use (plus `tenantKey`) — an operator saves it
      // as test-docs/scorecard/promoted/<tenant-slug>.json (see that directory's README) the same
      // weekly-repo-sync way learningExport's output gets folded into nlNormalize.js.
      case 'examExport': {
        requireOperator(auth);
        await gateSupportAccess(auth, ctx, action, payload);
        const rows = await listPromotedTests(ctx, { limit: 2000 });
        result = buildPromotedExport(ctx.tenantKey, rowsToQuestions(rows));
        break;
      }
      // Round 22 (S2, privacy): a tenant's own admin managing SUPPORT ACCESS to their OWN tenant —
      // requireAdmin (same gate as merge/data-export), never requireOperator: this is the tenant
      // deciding who may look at ITS data, not DeepWell staff acting on someone else's.
      case 'supportAccessGrant': {
        requireAdmin(auth);
        const grant = await grantSupportAccess(ctx, { hours: payload.hours, reason: payload.reason }, auth.userId);
        if (!grant) throw new reviewStore.ReviewError('Could not create a support-access grant (migration 58 may not be applied yet).', 503);
        result = { ok: true, grant };
        break;
      }
      case 'supportAccessRevoke': {
        requireAdmin(auth);
        if (!payload.grantId) throw new reviewStore.ReviewError('supportAccessRevoke requires a grantId.', 400);
        const ok = await revokeSupportAccess(ctx, payload.grantId, auth.userId);
        if (!ok) throw new reviewStore.ReviewError('Grant not found, or already revoked/expired.', 404);
        result = { ok: true };
        break;
      }
      case 'supportAccessStatus': {
        requireAdmin(auth);
        const [active, history] = await Promise.all([getActiveGrant(ctx), listGrants(ctx, { limit: 10 })]);
        result = { active, history };
        break;
      }
      case 'supportAccessLog': {
        requireAdmin(auth);
        result = { items: await listAccessLog(ctx, { limit: payload.limit ?? 200 }) };
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    return res.json(result ?? null);
  } catch (err) {
    if (err instanceof reviewStore.ReviewError) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    // Log the detail, return none of it — same reasoning as api/records.ts.
    console.error('review API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
