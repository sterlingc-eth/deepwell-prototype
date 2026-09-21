/**
 * Display name for a Clerk organization membership row. Shared by
 * TeamScreen's read-only member list and the "My work · Everyone" work
 * filter's uploader chips (src/hooks/useMemberDirectory.ts) so both name the
 * same person the same way, from the same source (Clerk's own org
 * membership list — never the server, which only ever knows a Clerk user id,
 * see api/_lib/auth.js's module header).
 */
export interface ClerkPublicUserData {
  firstName?: string | null;
  lastName?: string | null;
  identifier?: string;
  userId?: string;
}

export function memberDisplayName(m: { publicUserData?: ClerkPublicUserData | null }): string {
  const first = m.publicUserData?.firstName ?? '';
  const last = m.publicUserData?.lastName ?? '';
  const name = `${first} ${last}`.trim();
  return name || m.publicUserData?.identifier || 'Team member';
}
