// Mutable '@clerk/clerk-react' mock for the full-App QA harness. State: window.__QA_AUTH =
// { isSignedIn, isLoaded, orgId, orgRole, orgName, members }. Dev-only, never shipped.
import type { ReactNode } from 'react';

interface QaAuth {
  isSignedIn?: boolean;
  isLoaded?: boolean;
  orgId?: string | null;
  orgRole?: string | null;
  orgName?: string;
  userId?: string;
  /** Shops the person belongs to (mobile account sheet). Default: just the current one. */
  shops?: { id: string; name: string }[];
  /** Solo owner: a one-person shop (admin, no other members). */
  solo?: boolean;
}
interface QaCalls { setActive: unknown[]; signOut: unknown[] }
// Persisted in sessionStorage so a check can still read them after the page reloads itself (shop switch).
const calls = (): QaCalls => {
  let c: QaCalls = { setActive: [], signOut: [] };
  try { c = JSON.parse(sessionStorage.getItem('__QA_CALLS') ?? '') as QaCalls; } catch { /* first call */ }
  return new Proxy(c, {
    get(t, k) { const arr = (t as any)[k] as unknown[]; return { push: (v: unknown) => { arr.push(v); sessionStorage.setItem('__QA_CALLS', JSON.stringify(t)); } }; },
  }) as unknown as QaCalls;
};
const st = (): QaAuth => ((window as unknown as { __QA_AUTH?: QaAuth }).__QA_AUTH ?? {});

export function useAuth() {
  const a = st();
  return {
    isSignedIn: a.isSignedIn ?? true,
    isLoaded: a.isLoaded ?? true,
    userId: a.userId ?? 'user_qa',
    orgId: a.orgId === undefined ? 'org_qa' : a.orgId,
    orgRole: a.orgRole === undefined ? 'org:admin' : a.orgRole,
    getToken: async () => 'qa-token',
  } as any;
}
export function useOrganization(_o?: any) {
  const a = st();
  return {
    isLoaded: true,
    organization: a.orgId === null ? null : { id: a.orgId ?? 'org_qa', name: a.orgName ?? 'Sunrise HVAC', membersCount: a.solo ? 1 : 2, pendingInvitationsCount: a.solo ? 0 : 1 },
    memberships: {
      data: a.solo ? [
        { id: 'm1', role: 'org:admin', publicUserData: { userId: 'user_qa', firstName: 'Pat', lastName: 'Owner', identifier: 'pat@sunrisehvac.com' } },
      ] : [
        { id: 'm1', role: 'org:admin', publicUserData: { userId: 'user_qa', firstName: 'Pat', lastName: 'Owner', identifier: 'pat@sunrisehvac.com' } },
        { id: 'm2', role: 'org:member', publicUserData: { userId: 'user_alex', firstName: 'Alex', lastName: 'Tech', identifier: 'alex@sunrisehvac.com' } },
      ],
    },
  } as any;
}
export function useClerk() { return { signOut: async (o?: unknown) => { calls().signOut.push(o ?? null); } } as any; }
export function useOrganizationList(_o?: any) {
  const a = st();
  const shops = a.shops ?? [{ id: a.orgId ?? 'org_qa', name: a.orgName ?? 'Sunrise HVAC' }];
  return {
    isLoaded: true,
    setActive: async (o: unknown) => { calls().setActive.push(o); (window as unknown as { __QA_AUTH?: QaAuth }).__QA_AUTH = { ...a, orgId: (o as { organization: string }).organization }; },
    userMemberships: { data: shops.map((x) => ({ id: `mem_${x.id}`, organization: x })), revalidate: async () => {} },
  } as any;
}
export function useUser() { return { isLoaded: true, isSignedIn: true, user: { id: st().userId ?? 'user_qa', firstName: 'Pat', fullName: 'Pat Owner', primaryEmailAddress: { emailAddress: 'pat@sunrisehvac.com' } } } as any; }
export function OrganizationSwitcher(_p: any) {
  // Mirrors the real trigger's styling in AppShell.tsx (nowrap + truncated identifier), so a long shop name is exercised honestly.
  return <button type="button" className="text-forest-100 px-2 min-h-touch whitespace-nowrap inline-flex items-center gap-1" title="Org switcher (mock)"><span className="truncate max-w-[9rem] 2xl:max-w-[14rem]">{st().orgName ?? 'Sunrise HVAC'}</span> ▾</button>;
}
export function CreateOrganization(_p: any) { return <div data-testid="clerk-create-org">CreateOrganization (mock)</div>; }
export function OrganizationList(_p: any) { return <div data-testid="clerk-org-list">OrganizationList (mock)</div>; }
export function OrganizationProfile(_p: any) { return <div data-testid="clerk-org-profile" style={{ padding: 16 }}>OrganizationProfile (mock)</div>; }
export function SignIn(_p: any) { return <div data-testid="clerk-signin" style={{ padding: 16, color: '#333' }}>SignIn (mock)</div>; }
export function UserButton(_p: any) { return <button type="button" aria-label="User menu">U</button>; }
export function ClerkProvider({ children }: { children: ReactNode }) { return <>{children}</>; }
