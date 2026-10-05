/**
 * Applies the industry a person picked on the onboarding screen to the company
 * they just created (Build 2, stage 2A). Onboarding runs BEFORE the company
 * exists, so the pick waits in localStorage across Clerk's redirect; this runs
 * once the company is active, posts it to /api/account?action=industry (owner /
 * admin only, audit-logged on the server) and clears the pick. A failure leaves
 * the pick in place for the next load; the company is HVAC (the default) until
 * it lands, and the owner can change it later.
 */
import { useEffect } from 'react';
import { authHeader } from '../services/authToken';
import { PENDING_INDUSTRY_KEY, decodePendingIndustry, type IndustryInfo } from '../lib/industry';
import { useAppStore } from '../store/appStore';

export function usePendingIndustry(enabled: boolean, orgId: string | null | undefined, isAdmin: boolean, userId: string | null | undefined): void {
  const setIndustry = useAppStore((s) => s.setIndustry);
  useEffect(() => {
    if (!enabled || !orgId || !isAdmin) return;
    let pick: string | null = null;
    try {
      pick = window.localStorage.getItem(PENDING_INDUSTRY_KEY);
    } catch {
      return;
    }
    const chosenIndustry = decodePendingIndustry(pick, userId);
    if (!chosenIndustry) {
      // Not this person's, or too old: it must never be applied, so drop it.
      if (pick) { try { window.localStorage.removeItem(PENDING_INDUSTRY_KEY); } catch { /* */ } }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/account?action=industry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ op: 'set', industry: chosenIndustry, ifUnset: true }),
        });
        // A refusal (not an admin, bad value) will never succeed on retry: drop the pick instead of retrying forever.
        if (res.status === 400 || res.status === 403 || res.status === 404) {
          try { window.localStorage.removeItem(PENDING_INDUSTRY_KEY); } catch { /* */ }
        }
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as IndustryInfo;
        setIndustry(data);
        try {
          window.localStorage.removeItem(PENDING_INDUSTRY_KEY);
        } catch {
          /* best effort */
        }
      } catch {
        /* leave the pick for the next load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, orgId, isAdmin, userId, setIndustry]);
}
