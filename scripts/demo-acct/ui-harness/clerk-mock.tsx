// Dev-only: a stand-in for '@clerk/clerk-react' so the REAL demo screens render with the demo login and its six demo
// companies, without a live Clerk session. Used only by scripts/demo-acct/shoot-ipad.mjs; never part of a build.
import { useSyncExternalStore, type ReactNode } from 'react';

const ORGS = [
  { id: 'org_d_re', name: 'Demo · Real Estate — Quailbrush Realty Group' },
  { id: 'org_d_pm', name: 'Demo · Property Management — Tallgrass Mesa Property Management' },
  { id: 'org_d_hvac', name: 'Demo · HVAC — Coppervane Heating & Air' },
  { id: 'org_d_pl', name: 'Demo · Plumbing — Bluegill Plumbing Co.' },
  { id: 'org_d_el', name: 'Demo · Electrical — Kestrel Line Electric' },
  { id: 'org_d_gc', name: 'Demo · General Contractors — Stonefield & Pike Builders' },
];
let active: string | null = (window as any).__demoActiveOrg ?? null;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function __setActive(id: string | null) { active = id; subs.forEach((f) => f()); }
(window as any).__setActiveOrg = __setActive;
const useActive = () => useSyncExternalStore(subscribe, () => active);

export function useAuth() {
  const orgId = useActive();
  return { isSignedIn: true, isLoaded: true, userId: 'user_demo', orgId, orgRole: 'org:admin', getToken: async () => 'demo-token' } as any;
}
export function useOrganization(_o?: any) {
  const id = useActive();
  return { isLoaded: true, organization: ORGS.find((o) => o.id === id) ?? null } as any;
}
export function useOrganizationList(_o?: any) {
  return { isLoaded: true, setActive: async ({ organization }: any) => __setActive(organization), userMemberships: { data: ORGS.map((o) => ({ organization: o })) } } as any;
}
export function useUser() {
  return { isLoaded: true, user: { primaryEmailAddress: { emailAddress: 'demo@deepwelltechnology.com' }, fullName: 'DeepWell Demo' } } as any;
}
export function useClerk() { return { signOut: async () => {}, user: { primaryEmailAddress: { emailAddress: 'demo@deepwelltechnology.com' }, fullName: 'DeepWell Demo' } } as any; }
export function OrganizationSwitcher() { return <span>switcher</span>; }
export function CreateOrganization() { return <div />; }
export function OrganizationProfile() { return <div />; }
export function OrganizationList() { return <div />; }
export function SignIn() { return <div />; }
export function SignUp() { return <div />; }
export function UserButton() { return <div />; }
export function ClerkProvider({ children }: { children: ReactNode }) { return <>{children}</>; }
