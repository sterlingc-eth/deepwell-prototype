import { useAuth } from '@clerk/clerk-react';
import { isAdminRole } from '../services/teamClient';

/**
 * True when this person may do shop-admin actions (export, delete, merge, billing, API keys, ...).
 * Mirrors the server gate exactly (api/_lib/auth.js: `if (hasShop(auth)) requireRole(auth, 'admin')`):
 * a signed-in user with NO active shop is a solo tenant and is its own admin; inside a shop only the
 * `admin` role counts. The server checks stay in place (defense in depth) - this only decides which
 * controls a person is shown, so a member never clicks into a 403.
 */
export function useCanAdmin(): boolean {
  const { orgId, orgRole } = useAuth();
  return !orgId || isAdminRole(orgRole ?? null);
}

/** Short text used next to (or on) a control a member can see but not use. */
export const ASK_ADMIN = 'Ask an admin';
export const ASK_ADMIN_TITLE = 'Only a shop admin can do this. Ask an admin.';
