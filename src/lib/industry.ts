/**
 * Industry on the client (Build 2, stage 2A). This is the first thing in the
 * running app that reads src/domains/registry.ts, so the electrical, plumbing and
 * property schemas are now reachable from the bundle. Nothing here marks an
 * industry "live": that flag (isDomainLive) is unchanged and unused by screens.
 *
 * The server owns the choice (tenants.settings.industry, see
 * api/_lib/routes/industry.js); the bootstrap payload carries it down as
 * `industry`. When it is missing (an older API, a failed bootstrap) every helper
 * answers as HVAC, the historical default, so existing companies see no change.
 */
import { DOMAINS, DOMAINS_BY_ID } from '../domains/registry';

export type IndustryId = 'hvac' | 'electrical' | 'plumbing' | 'property';

export interface IndustryInfo {
  industry: IndustryId;
  label: string;
  unitNoun: string;
  packs: string[];
  features: string[];
  /** True once a company (or DeepWell staff) set the industry on purpose. */
  chosen?: boolean;
}

export const PENDING_INDUSTRY_KEY = 'deepwell.pendingIndustry';

/** The industries a new company can pick, in display order (HVAC first: it is the default). */
export const INDUSTRY_CHOICES: { id: IndustryId; label: string; blurb: string }[] = [
  { id: 'hvac', label: 'HVAC', blurb: 'Heating and cooling: equipment, warranties, service tickets.' },
  { id: 'electrical', label: 'Electrical', blurb: 'Permits, inspections, panel schedules, licenses, insurance, bonds.' },
  { id: 'plumbing', label: 'Plumbing', blurb: 'Backflow tests, water heaters, permits, service tickets.' },
  { id: 'property', label: 'Property management', blurb: 'Work orders, vendor insurance, leases, the rent roll, inspections.' },
];

export function isIndustryId(v: unknown): v is IndustryId {
  return typeof v === 'string' && INDUSTRY_CHOICES.some((c) => c.id === v);
}

/** The registered schema for an industry id; unknown or missing -> hvac. */
export function domainFor(id: string | null | undefined) {
  return (id && DOMAINS_BY_ID[id]) || DOMAINS_BY_ID.hvac || DOMAINS[0]!;
}

export function industryLabel(info: Pick<IndustryInfo, 'industry'> | null | undefined): string {
  return domainFor(info?.industry ?? 'hvac').label;
}

const HVAC_EXAMPLES = [
  'Is the unit at 2847 N 24th St still under warranty?',
  'What serial number is on the unit at 2847 N 24th St?',
  'Which warranties expire in the next 12 months?',
];

/** What to type in the Ask box, per trade ("an address, a serial number, or a customer name" is the HVAC original). */
export function lookupHintFor(id: string | null | undefined): string {
  switch (id) {
    case 'electrical':
    case 'plumbing':
      return 'an address, a permit number, or a customer name';
    case 'property':
      return 'a property, a unit, a tenant or a vendor';
    default:
      return 'an address, a serial number, or a customer name';
  }
}

/** Ask-screen "e.g." questions. HVAC returns the original strings unchanged. */
export function exampleQuestionsFor(id: string | null | undefined): string[] {
  switch (id) {
    case 'electrical':
      return ['Which permits are still open?', 'Did 2847 N 24th St pass rough-in?', 'Which licenses, insurance or bonds expire in the next 60 days?'];
    case 'plumbing':
      return ['Which backflow tests are due in the next 60 days?', 'When was the water heater at 2847 N 24th St installed?', 'Which permits are still open?'];
    case 'property':
      return ['Which vendor insurance certificates expire in the next 60 days?', 'When does the lease for unit 4B end?', 'Which work orders are still open?'];
    default:
      return HVAC_EXAMPLES;
  }
}

/** The pending pick is bound to the person and the moment it was made, so a stale one (abandoned onboarding, shared
 *  browser, another account) can never be applied to a different person's company or long after the fact. */
export const PENDING_INDUSTRY_MAX_AGE_MS = 30 * 60 * 1000;
export function encodePendingIndustry(id: IndustryId, userId: string, now = Date.now()): string {
  return `${id}|${userId}|${now}`;
}
export function decodePendingIndustry(raw: string | null, userId: string | null | undefined, now = Date.now()): IndustryId | null {
  if (!raw || !userId) return null;
  const [id, uid, ts] = raw.split('|');
  const age = now - Number(ts);
  if (!isIndustryId(id) || uid !== userId || !Number.isFinite(age) || age < 0 || age > PENDING_INDUSTRY_MAX_AGE_MS) return null;
  return id;
}
