/**
 * Industry demo account (demo@deepwelltechnology.com): the industry list, exactly as it is shown to prospects.
 *
 * Every industry is its own demo company (a Clerk organization named "Demo · <Industry> — <company>"), so the picker
 * simply switches the signed-in demo user's active organization. Only industries whose demo company exists (the demo
 * user is a member of it) are shown; the rest of the 44 appear as later waves are built.
 */
import starter from './starterQuestions.json';

export const DEMO_ORG_PREFIX = 'Demo · ';
export const DEMO_ACCOUNT_EMAIL = 'demo@deepwelltechnology.com';

export interface DemoCategory {
  title: string;
  industries: string[];
}

/** The 44 industries, grouped and labelled exactly as the brief lists them (customer-facing). */
export const DEMO_CATEGORIES: DemoCategory[] = [
  {
    title: 'Trades & Field Service',
    industries: ['HVAC', 'Plumbing', 'Electrical', 'General Contractors', 'Roofing', 'Landscaping', 'Pest Control', 'Pool & Spa Service', 'Solar Installation',
      'Fire Protection & Sprinklers', 'Security & Alarm Systems', 'Garage Doors', 'Appliance Repair', 'Cleaning & Janitorial', 'Painting', 'Flooring', 'Locksmiths'],
  },
  { title: 'Property & Facilities', industries: ['Real Estate', 'Property Management', 'HOAs & Community Associations', 'Commercial Facilities Management', 'Self-Storage'] },
  { title: 'Fleet, Auto & Equipment', industries: ['Fleet & Equipment Rental', 'Auto Repair', 'Trucking & Logistics', 'Towing', 'Heavy Equipment Dealers'] },
  {
    title: 'Professional Services & Offices',
    industries: ['Accounting & Bookkeeping', 'Law Offices', 'Insurance Agencies', 'Architecture & Engineering', 'Marketing Agencies', 'Staffing Agencies', 'IT Services', 'Consulting'],
  },
  { title: 'Community & Nonprofit', industries: ['Nonprofits', 'Churches & Faith Organizations', 'Schools & Childcare', 'Animal Shelters & Rescues'] },
  { title: 'Hospitality & Retail', industries: ['Coffee Shops & Cafés', 'Restaurants', 'Retail Stores', 'Hotels & Short-Term Rentals', 'Event Venues'] },
];

export interface DemoStarter {
  label: string;
  company: string;
  orgName: string;
  tryAsking: string[];
  all: string[];
}

/** Starter questions per built industry, keyed by industry label (QA-verified list; scripts/demo-acct). */
export const DEMO_STARTERS: Record<string, DemoStarter> = Object.fromEntries(
  Object.values(starter as Record<string, DemoStarter>).map((s) => [s.label, s]),
);

/** "Demo · HVAC — Coppervane Heating & Air" -> { industry: 'HVAC', company: 'Coppervane Heating & Air' } (null if not a demo name). */
export function parseDemoOrgName(name: string | null | undefined): { industry: string; company: string } | null {
  if (!name || !name.startsWith(DEMO_ORG_PREFIX)) return null;
  const rest = name.slice(DEMO_ORG_PREFIX.length);
  const i = rest.indexOf(' — ');
  if (i <= 0) return { industry: rest.trim(), company: '' };
  return { industry: rest.slice(0, i).trim(), company: rest.slice(i + 3).trim() };
}

export function isDemoOrgName(name: string | null | undefined): boolean {
  return parseDemoOrgName(name) !== null;
}

export function isDemoEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === DEMO_ACCOUNT_EMAIL;
}

/** Session flag: the presenter picked an industry in this tab (cleared by "Switch industry"). */
const PICKED_KEY = 'deepwell.demo.picked';
let pickedMemory: boolean | null = null;
const listeners = new Set<() => void>();
export function demoPicked(): boolean {
  if (pickedMemory !== null) return pickedMemory;
  try { return window.sessionStorage.getItem(PICKED_KEY) === '1'; } catch { return false; }
}
export function setDemoPicked(on: boolean): void {
  pickedMemory = on;
  try {
    if (on) window.sessionStorage.setItem(PICKED_KEY, '1');
    else window.sessionStorage.removeItem(PICKED_KEY);
  } catch { /* storage blocked: kept in memory for this page load */ }
  listeners.forEach((fn) => fn());
}
/** For useSyncExternalStore: re-render when the picked flag changes. */
export function subscribeDemoPicked(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
