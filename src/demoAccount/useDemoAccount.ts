/**
 * Is the signed-in session the industry demo? True when the active organization is a demo company
 * ("Demo · <Industry> — <company>") or the signed-in email is the demo login. The server is the real boundary
 * (api/_lib/demo): this only decides what the screens show.
 */
import { useOrganization, useUser } from '@clerk/clerk-react';
import { DEMO_STARTERS, isDemoEmail, parseDemoOrgName } from './industries';

export interface DemoAccountState {
  /** The demo login (picker / restrictions apply), whatever organization is active. */
  isDemoLogin: boolean;
  /** The active organization is a demo company. */
  isDemoOrg: boolean;
  industry: string | null;
  company: string | null;
  tryAsking: string[];
}

export function useDemoAccount(): DemoAccountState {
  const { organization } = useOrganization();
  const { user } = useUser();
  const parsed = parseDemoOrgName(organization?.name ?? null);
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const isDemoOrg = parsed !== null;
  return {
    isDemoLogin: isDemoOrg || isDemoEmail(email),
    isDemoOrg,
    industry: parsed?.industry ?? null,
    company: parsed?.company ?? null,
    tryAsking: parsed ? DEMO_STARTERS[parsed.industry]?.tryAsking ?? [] : [],
  };
}
