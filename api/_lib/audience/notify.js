/**
 * Notification producer for tech-only documents (owner ask (a), round 18 part 2): once
 * classify.js/store.js decide a document is 'internal', this resolves which technician(s) its
 * text actually addresses against the tenant's real member roster, and writes an in-app bell
 * notification (the existing `notifications` table, M3-config/16-notifications.sql — same table
 * api/_lib/routes/outreach.js's `kind: 'outreach'` and api/_lib/followups.js's `kind: 'followup'`
 * already write to) for each one matched, or — nobody on the roster matched — a single "Internal
 * document needs an owner" notification for the admins.
 *
 * Roster matching reuses api/_lib/followups.js's exported `technicianNameMatches` (same
 * normalize-and-last-name-fallback rule this codebase already uses to match an extracted
 * technician name against a member's display name) — imported read-only, never edited; that file
 * belongs to a different owner this round.
 *
 * `members` (the roster) is normally passed in by the caller; when omitted and `orgId` is given,
 * this fetches it from Clerk itself — same small, per-file copy of the
 * getOrganizationMembershipList call api/_lib/routes/followups.js's own getOrgMembers and
 * api/_lib/notify.js's getOrgAdminEmails already keep independently (that split is deliberate in
 * this codebase — see followups.js's own header on why the frontend/backend name-shaping stays as
 * two small copies rather than one shared import). Passing `members` directly is what makes this
 * fully testable offline (scripts/verify-audience.mjs never calls Clerk).
 */
import { TENANT_SQL } from '../scope.js';
import { technicianNameMatches } from '../followups.js';
import { AUDIENCE_NOTIFIED_FIELD_KEY } from './sql.js';

const ADMIN_NEEDS_OWNER_TITLE = 'Internal document needs an owner';

/** Same shape followups.js's memberForDocument/groupDocsByTechnician expect:
 *  {userId, displayName, email, isAdmin}[]. Own small copy of the Clerk roster fetch — see the
 *  file header for why this isn't imported from routes/followups.js (a route file, not owned by
 *  this engineer this round, and its own copy of this function isn't exported anyway). */
async function fetchOrgMembers(orgId) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !orgId) return [];
  try {
    const { createClerkClient } = await import('@clerk/backend');
    const clerkClient = createClerkClient({ secretKey });
    const list = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: 100 });
    const memberships = Array.isArray(list) ? list : (list?.data ?? []);
    return memberships
      .map((m) => {
        const pud = m?.publicUserData ?? {};
        const name = `${pud.firstName ?? ''} ${pud.lastName ?? ''}`.trim();
        const identifier = typeof pud.identifier === 'string' ? pud.identifier : null;
        return {
          userId: pud.userId ?? null,
          displayName: name || identifier || null,
          email: identifier && identifier.includes('@') ? identifier : null,
          isAdmin: /^(org:)?admin$/i.test(String(m?.role ?? '')),
        };
      })
      .filter((m) => m.userId);
  } catch (err) {
    console.error('audience/notify: fetchOrgMembers failed:', err?.message);
    return [];
  }
}

/**
 * Which roster member(s) `techNames` (classify.js's extractMentionedNames output) actually
 * addresses. A name can plausibly match more than one member (two "Kevin"s); every match gets its
 * own notification rather than guessing which one — same "never silently pick" instinct
 * classify.js itself follows for audience.
 * @returns {object[]} matched members, deduped by userId
 */
export function resolveAddressedMembers(techNames, members) {
  const list = Array.isArray(members) ? members : [];
  const matched = new Map();
  for (const techName of techNames ?? []) {
    for (const m of list) {
      if (m?.userId && technicianNameMatches(techName, m.displayName)) matched.set(m.userId, m);
    }
  }
  return [...matched.values()];
}

/**
 * Dedupe guard: has this document already produced a notification? A synthetic extractions row
 * (same "not a real field" idiom as ./sql.js's AUDIENCE_FALLBACK_FIELD_KEY) written with an
 * INSERT ... WHERE NOT EXISTS so the check-and-write is one round trip, not a separate SELECT then
 * INSERT — genuinely race-safe once M3-config/57's optional unique index is pasted (a concurrent
 * second writer then hits a unique-violation instead of a silent double-insert, caught below and
 * treated as "already notified"); best-effort (a rare, harmless double notification) before that.
 * @returns {Promise<boolean>} true the FIRST time this document is marked notified
 */
async function markNotifiedOnce(db, documentId) {
  try {
    const r = await db.query(
      `INSERT INTO extractions (tenant_id, document_id, field_key, value, confidence, created_at)
       SELECT (current_setting('app.tenant_id', true))::uuid, $1, $2, '1', 1, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM extractions WHERE document_id = $1 AND field_key = $2 AND ${TENANT_SQL}
        )
       RETURNING id`,
      [documentId, AUDIENCE_NOTIFIED_FIELD_KEY]
    );
    return r.rowCount > 0;
  } catch (err) {
    if (err?.code === '23505') return false; // unique_violation (M3-config/57's index): a concurrent writer won
    throw err;
  }
}

/** Same tenant-wide bell-icon shape every other producer writes (notifications has no per-user
 *  target column — see M3-config/16-notifications.sql's own header — so, like
 *  api/_lib/routes/followups.js's `kind: 'followup'`, the addressed technician's name goes in the
 *  title so it reads as theirs even though everyone in the tenant can see it in their own bell). */
async function insertNotification(db, { kind, title, body, link }) {
  await db.query(
    `INSERT INTO notifications (tenant_id, kind, title, body, link)
     VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4)`,
    [kind, title, body, link]
  );
}

/** Deep link back into this document's own audience/team-only records view — reuses the Records
 *  browser's own `?screen=records&audience=internal` URL state (src/components/records/
 *  useRecordsBrowse.ts's URL sync, extended for this round) rather than a `?doc=` link, which
 *  NotificationsPanel.tsx's click handler doesn't currently act on (see the final report). */
const RECORDS_INTERNAL_LINK = '/app/?screen=records&audience=internal';

/**
 * Resolve + notify for ONE internal document. Idempotent (markNotifiedOnce above) — safe to call
 * again for the same document (a re-classification, an override) without duplicating bell items.
 * @param {object} db  tenant-scoped (SET LOCAL app.tenant_id already applied by the caller)
 * @param {string} documentId
 * @param {{techNames?: string[], orgId?: string|null, members?: object[]}} opts
 * @returns {Promise<{assignedMemberId: string|null, assignedTechName: string|null, notified: boolean}>}
 */
export async function notifyForInternalDocument(db, documentId, { techNames = [], orgId = null, members } = {}) {
  const roster = Array.isArray(members) ? members : await fetchOrgMembers(orgId);
  const matched = resolveAddressedMembers(techNames, roster);

  const firstTime = await markNotifiedOnce(db, documentId);
  if (!firstTime) {
    // Already notified once — still report who WOULD be assigned (setDocumentAudience's caller
    // wants this for documents.assigned_member/assigned_tech_name even on a re-classify), just
    // don't write a second bell item.
    const primary = matched[0] ?? null;
    return { assignedMemberId: primary?.userId ?? null, assignedTechName: primary?.displayName ?? null, notified: false };
  }

  if (matched.length) {
    for (const m of matched) {
      await insertNotification(db, {
        kind: 'internal-doc',
        title: `Internal document for ${m.displayName ?? 'you'}`,
        body: 'A company-only record was uploaded — not a customer document.',
        link: RECORDS_INTERNAL_LINK,
      });
    }
    const primary = matched[0];
    return { assignedMemberId: primary.userId, assignedTechName: primary.displayName ?? null, notified: true };
  }

  await insertNotification(db, {
    kind: 'internal-doc',
    title: ADMIN_NEEDS_OWNER_TITLE,
    body: 'An internal document arrived with no technician we could match on the roster.',
    link: RECORDS_INTERNAL_LINK,
  });
  return { assignedMemberId: null, assignedTechName: null, notified: true };
}

export { ADMIN_NEEDS_OWNER_TITLE, RECORDS_INTERNAL_LINK };
