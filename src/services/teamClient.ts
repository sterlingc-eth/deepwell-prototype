/**
 * Pure helpers for the Team screen (src/screens/TeamScreen.tsx): role gating
 * and seat math. No network calls of its own — member count comes straight
 * off Clerk's own Organization resource (`organization.membersCount`, which
 * Clerk keeps accurate as people are invited/accepted/removed) and the seat
 * cap from billingClient's already-fetched BillingStatus.limits.technicians
 * (api/_lib/plan.js's PLAN_LIMITS.technicians, mirrored there the same way
 * documentTypes.ts mirrors api/_lib/documentTypes.js — src/ can't import
 * api/). See handoffs/ORG_INVITES_AUDIT.md for why no new server endpoint
 * was needed for the "N of M seats" display.
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
  label: string;
}

/**
 * `cap` is PLAN_LIMITS[plan].technicians — `null` on an uncapped plan (Fleet)
 * or before billing status has loaded, in which case seats are never
 * reported "at cap" (nothing to block against yet).
 */
export function seatStatus(count: number, cap: number | null | undefined): SeatStatus {
  const c = cap ?? null;
  return {
    count,
    cap: c,
    atCap: c != null && count >= c,
    label: c == null ? `${count} member${count === 1 ? '' : 's'}` : `${count} of ${c} seat${c === 1 ? '' : 's'}`,
  };
}
