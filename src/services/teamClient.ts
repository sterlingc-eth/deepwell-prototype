/**
 * Pure helpers for the Team screen (src/screens/TeamScreen.tsx): role gating
 * and login math. No network calls of its own. The login COUNT comes from the
 * server (GET /api/billing?action=seats, api/_lib/seats.js) because the one
 * owner account must be excluded and Clerk's frontend org object does not
 * expose who created the org; the cap is PLAN_LIMITS.logins from
 * billingClient's already-fetched BillingStatus.limits (mirrored from
 * api/_lib/plan.js the same way documentTypes.ts mirrors
 * api/_lib/documentTypes.js — src/ can't import api/).
 */

/**
 * Collapses a Clerk org role claim to a plain admin/not-admin boolean.
 * Mirrors api/_lib/auth.js's normalizeOrgRole exactly: only a role that is
 * literally "admin" (after stripping an optional "org:" prefix, case-
 * insensitive) counts as admin. Any custom role — or no role at all —
 * collapses to non-admin, the least-privileged bucket, same as the server.
 */
export function isAdminRole(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw.replace(/^org:/, '').trim().toLowerCase() === 'admin';
}

export interface SeatStatus {
  count: number;
  cap: number | null;
  atCap: boolean;
  overCap: boolean;
  label: string;
}

/**
 * Round 26: logins are really capped (Solo 2 / Shop 5 / Crew 10 / Fleet 11+). `count` is the number of
 * logins USED — every member except the ONE owner account, plus pending invitations (the server computes
 * it: api/_lib/seats.js). `cap` is the plan's login cap — `null` on Fleet (no DeepWell cap) or before
 * billing status has loaded, in which case nothing is ever "at cap". Label mirrors api/_lib/seats.js's
 * seatLabel exactly: "3 of 5 logins used (owner not counted)".
 */
export function seatStatus(count: number, cap: number | null | undefined): SeatStatus {
  const c = cap ?? null;
  return {
    count,
    cap: c,
    atCap: c != null && count >= c,
    overCap: c != null && count > c,
    label:
      c == null
        ? `${count} login${count === 1 ? '' : 's'} used (owner not counted)`
        : `${count} of ${c} login${c === 1 ? '' : 's'} used (owner not counted)`,
  };
}
