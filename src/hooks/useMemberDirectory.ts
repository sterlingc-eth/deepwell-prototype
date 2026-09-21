import { useMemo } from 'react';
import { useAuth, useOrganization } from '@clerk/clerk-react';
import { isAdminRole } from '../services/teamClient';
import { memberDisplayName } from '../core/memberNames';

export interface MemberDirectory {
  userId: string | null;
  /** This user's own display name, from the org membership list below —
   *  null until Clerk's memberships have loaded, or for a solo tenant. */
  displayName: string | null;
  isAdmin: boolean;
  /** False for a solo (no-org) tenant — see api/_lib/auth.js's `hasShop`. */
  hasShop: boolean;
  nameByUserId: Map<string, string>;
}

/**
 * One shared read of "who is in this shop" for anything that needs to
 * attribute or filter by teammate — the Inbox/Records "My work · Everyone"
 * control (src/hooks/useWorkFilter.ts) and its uploader chips. Names come
 * from Clerk's own organization membership list, capped at 100 (a shop with
 * more technicians than that is not a case this prototype optimizes for
 * yet) — never from the server, which only ever knows a Clerk user id and
 * must not be trusted with a caller-supplied display name (spoofable).
 */
export function useMemberDirectory(): MemberDirectory {
  const { userId, orgId, orgRole } = useAuth();
  const { memberships } = useOrganization(orgId ? { memberships: { pageSize: 100 } } : undefined);

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of memberships?.data ?? []) {
      const id = m.publicUserData?.userId;
      if (id) map.set(id, memberDisplayName(m));
    }
    return map;
  }, [memberships?.data]);

  const displayName = userId ? (nameByUserId.get(userId) ?? null) : null;

  return {
    userId: userId ?? null,
    displayName,
    isAdmin: isAdminRole(orgRole ?? null),
    hasShop: !!orgId,
    nameByUserId,
  };
}
