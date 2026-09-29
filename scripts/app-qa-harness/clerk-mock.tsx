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
}
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
    organization: a.orgId === null ? null : { id: a.orgId ?? 'org_qa', name: a.orgName ?? 'Sunrise HVAC', membersCount: 2, pendingInvitationsCount: 1 },
    memberships: {
      data: [
        { id: 'm1', role: 'org:admin', publicUserData: { userId: 'user_qa', firstName: 'Pat', lastName: 'Owner', identifier: 'pat@sunrisehvac.com' } },
        { id: 'm2', role: 'org:member', publicUserData: { userId: 'user_alex', firstName: 'Alex', lastName: 'Tech', identifier: 'alex@sunrisehvac.com' } },
      ],
    },
  } as any;
}
export function useClerk() { return { signOut: async () => {} } as any; }
export function useUser() { return { isLoaded: true, isSignedIn: true, user: { id: 'user_qa', firstName: 'Pat' } } as any; }
export function OrganizationSwitcher(_p: any) {
  return <button type="button" className="text-forest-100 px-2" title="Org switcher (mock)">{st().orgName ?? 'Sunrise HVAC'} ▾</button>;
}
export function CreateOrganization(_p: any) { return <div data-testid="clerk-create-org">CreateOrganization (mock)</div>; }
export function OrganizationList(_p: any) { return <div data-testid="clerk-org-list">OrganizationList (mock)</div>; }
export function OrganizationProfile(_p: any) { return <div data-testid="clerk-org-profile" style={{ padding: 16 }}>OrganizationProfile (mock)</div>; }
export function SignIn(_p: any) { return <div data-testid="clerk-signin" style={{ padding: 16, color: '#333' }}>SignIn (mock)</div>; }
export function UserButton(_p: any) { return <button type="button" aria-label="User menu">U</button>; }
export function ClerkProvider({ children }: { children: ReactNode }) { return <>{children}</>; }
