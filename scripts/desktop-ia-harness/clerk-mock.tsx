// Mock of '@clerk/clerk-react' surface used by App.tsx/AppShell/TeamScreen/
// CustomersScreen/BillingScreen, so the real screens can render without a
// live Clerk session — adapted from ../ux17-harness/clerk-mock.tsx (the U2
// auditor's own scratch harness) with one addition: the org role is
// mutable at runtime (window.__dwSetAdmin), so this same harness can assert
// BOTH "admin sees Donovan/Team" and "non-admin doesn't" without a second
// build. Read-only harness — never part of the repo, lives in scratch only.
import type { ReactNode } from 'react';

export const roleState = { role: 'org:admin' as string };

export function useAuth() {
  return {
    isSignedIn: true,
    isLoaded: true,
    userId: 'user_demo',
    orgId: 'org_demo',
    orgRole: roleState.role,
    getToken: async () => 'demo-token',
  } as any;
}

export function useOrganization(_opts?: any) {
  return {
    isLoaded: true,
    organization: {
      id: 'org_demo',
      name: 'Sunrise HVAC',
      membersCount: 3,
      pendingInvitationsCount: 1,
    },
    memberships: {
      data: [
        { id: 'm1', role: 'org:admin', publicUserData: { firstName: 'Pat', lastName: 'Owner', identifier: 'pat@sunrisehvac.com' } },
        { id: 'm2', role: 'org:member', publicUserData: { firstName: 'Alex', lastName: 'Tech', identifier: 'alex@sunrisehvac.com' } },
      ],
    },
  } as any;
}

export function useClerk() {
  return { signOut: async () => {} } as any;
}

export function OrganizationSwitcher(_props: any) {
  return (
    <button type="button" className="text-forest-100 px-2" title="Org switcher (mock)">
      Sunrise HVAC ▾
    </button>
  );
}

export function CreateOrganization(_props: any) {
  return <div>CreateOrganization (mock)</div>;
}

export function OrganizationProfile(_props: any) {
  return (
    <div style={{ padding: 16 }}>
      <p className="text-ink-2">Clerk &lt;OrganizationProfile /&gt; embed (mocked for this harness) — real invite/manage UI renders here.</p>
    </div>
  );
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
