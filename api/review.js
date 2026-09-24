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
// Donovan self-learning, Tier 2 Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md):
// the operator-only proposal queue/decide/deactivate/run-now/export actions.
// Same platform-operator gate as missDigest above — a tenant's own admin,
// even the founder shop's non-founder admins, gets 403 on all five.
import * as learningStore from './_lib/learning/store.js';
import { verifyProposalLive } from './_lib/learning/verify.js';
import { runLearningNow } from './_lib/learning/sweep.js';
// Donovan learning loop (miss replay, recipes, thumbs feedback): api/_lib/learning/replay.js.
import { replayMisses, replayCapabilityGap, applyThumbsUp, applyThumbsDown, missKey } from './_lib/learning/replay.js';
import { listReplays, listOpenMisses } from './_lib/learning/replayStore.js';
import { verifyRecipe, RECIPE_KIND } from './_lib/learning/recipes.js';
import { invalidateActiveOverlayCache } from './_lib/learning/overlay.js';

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
const INTEGRITY_RATE_LIMIT_ACTIONS = new Set(['integrityScan', 'integrityFix', 'missDigest', 'learningRunNow', 'learningReplay', 'askFeedback']);
const OPERATOR_ACTIONS = new Set(['missDigest', 'learningList', 'learningDecide', 'learningDeactivate', 'learningRunNow', 'learningExport', 'learningReplay']);

// HARD GATE (Reviewer NO-GO, 2026-09-21): which of this route's actions
// spend a real Anthropic-billed model call and so need the billing gate
// before running. 'aiVerify' (reviewStore.aiVerifyDocument) does NOT belong
// here — read its doc comment: it recomputes completeness from ALREADY-
// STORED extractions and never calls the model. 'reclassify'
// (reviewStore.reclassifyDocuments) does, as a Haiku fallback when its
// deterministic heuristic can't place a document — see RECLASSIFY_MODEL in
// reviewStore.js.
const MODEL_BILLED_ACTIONS = new Set(['reclassify', 'extractReminders']);

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
  'askFeedback',
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
      case 'missDigest':
        requireOperator(auth);
        result = payload.send === true
          ? await sendMissDigest({ since: payload.since })
          : { digest: await buildMissDigest({ since: payload.since }) };
        break;
      case 'learningList': {
        requireOperator(auth);
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
        result = {
          items: items.map((p) => (p.kind === 'capability_gap' && p.payload?.example && gapReplays.has(missKey(p.payload.example))
            ? { ...p, replay: gapReplays.get(missKey(p.payload.example)) } : p)),
          activeLearned,
          summary: {
            recipesActive: activeLearned.filter((r) => r.kind === RECIPE_KIND).length,
            answeredNow: open.filter((m) => m.replay?.outcome === 'answered_now').length,
            stillFailing: open.filter((m) => m.replay?.outcome === 'still_failing').length,
            notReplayed: open.filter((m) => !m.replay).length,
          },
        };
        break;
      }
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
        if (proposal.kind === 'capability_gap') {
          result.replay = await replayCapabilityGap({ ctxArg: ctx, proposal, decidedBy: auth.userId });
        }
        break;
      }
      case 'learningDeactivate': {
        requireOperator(auth);
        if (!payload.learnedId) throw new reviewStore.ReviewError('learningDeactivate requires a learnedId.', 400);
        const ok = await learningStore.deactivateLearned(payload.learnedId);
        if (!ok) throw new reviewStore.ReviewError('Learned item not found.', 404);
        result = { ok: true };
        break;
      }
      case 'learningRunNow':
        requireOperator(auth);
        result = await runLearningNow();
        break;
      case 'learningReplay': {
        requireOperator(auth);
        const questions = Array.isArray(payload.questions)
          ? payload.questions.filter((q) => typeof q === 'string').slice(0, 15).map((q) => q.slice(0, 300))
          : undefined;
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
