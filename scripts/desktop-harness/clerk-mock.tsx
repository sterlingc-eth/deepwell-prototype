// Mock of '@clerk/clerk-react' surface used by App.tsx/AppShell/TeamScreen/BillingScreen, so the
// real screens can render without a live Clerk session. Dev-only harness for
// scripts/verify-desktop-ux.mjs (adapted from the U2 desktop UX audit's read-only scratch
// harness) — never part of any production build entry (vite.config.ts's rollupOptions.input
// never lists scripts/desktop-harness/index.html), so it never ships.
import type { ReactNode } from 'react';

export function useAuth() {
  return {
    isSignedIn: true,
    isLoaded: true,
    userId: 'user_demo',
    orgId: 'org_demo',
    orgRole: 'org:admin',
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
