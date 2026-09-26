/**
 * Startup performance measurement (handoffs/STARTUP_PERF_R13.md).
 *
 * A stand-in for '@clerk/clerk-react', aliased in at BUILD time by
 * vite.perf.config.mjs — never shipped in the real app bundle. The real
 * Clerk SDK does its own network round trip + session bootstrap before
 * `useAuth()` reports `isLoaded: true`; scripts/perf/startup.mjs's own
 * fixture measured that at ~0.85s warm. This mock reproduces exactly that
 * ONE observable fact (isLoaded flips true after a fixed delay, then
 * isSignedIn/org are already resolved) without touching any real Clerk
 * network, so App.tsx's actual, unmodified gating logic (the whole point of
 * this measurement) runs against a realistic "Clerk just finished loading"
 * moment instead of a real auth provider this offline test cannot reach.
 *
 * The delay is configurable via `window.__PERF_CLERK_INIT_MS` (set by the
 * Playwright script with `page.addInitScript`) so the same built bundle can
 * be measured under different assumptions without a rebuild.
 */
// This is build-time test infra swapped in only for scripts/perf's harness
// build (never shipped, never a Vite dev server HMR target), so it
// intentionally mixes component and hook/non-component exports the way the
// real '@clerk/clerk-react' package it stands in for does.
/* eslint-disable react/only-export-components */
import { useEffect, useState, type ReactNode } from 'react';

declare global {
  interface Window {
    __PERF_CLERK_INIT_MS?: number;
  }
}

export function ClerkProvider({ children }: { children: ReactNode; [key: string]: unknown }) {
  return <>{children}</>;
}

export function useAuth() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const ms = typeof window !== 'undefined' ? (window.__PERF_CLERK_INIT_MS ?? 850) : 850;
    const t = window.setTimeout(() => setLoaded(true), ms);
    return () => window.clearTimeout(t);
  }, []);
  return {
    isLoaded: loaded,
    isSignedIn: loaded,
    userId: loaded ? 'perf-user' : undefined,
    orgId: loaded ? 'perf-org' : undefined,
    orgRole: 'admin',
    getToken: async () => 'perf-fake-token',
  };
}

export function useOrganization() {
  return { organization: { name: 'Perf Shop' } };
}

export function useUser() {
  return { user: { id: 'perf-user', fullName: 'Perf User' }, isLoaded: true };
}

export function useClerk() {
  return { signOut: async () => {}, openUserProfile: () => {} };
}

// Below: never actually rendered in this measurement (it stays on the Ask
// screen the whole run) — these exist only so screens statically imported
// or code-split by App.tsx (LoginScreen, TeamScreen, OnboardingScreen,
// OutreachScreen, the mobile/expenses entries) resolve at build time.
export function OrganizationSwitcher() {
  return null;
}
export function SignIn() {
  return null;
}
export function CreateOrganization() {
  return null;
}
export function OrganizationList() {
  return null;
}
export function OrganizationProfile() {
  return null;
}
export function UserButton() {
  return null;
}
