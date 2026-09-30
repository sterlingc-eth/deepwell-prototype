/**
 * R31 Loop 3c: role-aware answers. A tech in the truck wants the unit (model, serial, refrigerant, last service);
 * the office wants the money and the customer (balance, invoices, agreement, contact). This only ORDERS what the
 * answer already carries - it never drops or rewrites a fact, and a role with no matching label changes nothing.
 * Kill switch: VITE_ROLE_AWARE=0. Role: ?role=tech|office (remembered in localStorage 'dw.role'); the phone app
 * defaults to 'tech', the desktop app to neutral (no reordering) until a role is chosen.
 */
import type { Answer, Fact } from './types';

export type Role = 'tech' | 'office';

const TECH_RE = /\b(model|serial|refrigerant|tonnage|install|installed|warranty|last service|service date|technician|filter|part|equipment|unit|capacity|voltage|error|fault|repair|maintenance)\b/i;
const OFFICE_RE = /\b(balance|invoice|invoices|total|paid|unpaid|owed|due|cost|price|amount|payment|contract|agreement|customer|phone|email|address|bill|revenue|quote)\b/i;

export function roleAwareOn(): boolean {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ROLE_AWARE !== '0';
  } catch {
    return true;
  }
}

export function resolveRole(opts: { search?: string; stored?: string | null; mobile?: boolean }): Role | null {
  const q = new URLSearchParams(opts.search ?? '').get('role');
  for (const v of [q, opts.stored]) if (v === 'tech' || v === 'office') return v;
  return opts.mobile ? 'tech' : null;
}

export function currentRole(mobile: boolean): Role | null {
  if (!roleAwareOn() || typeof window === 'undefined') return null;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem('dw.role');
    const q = new URLSearchParams(window.location.search).get('role');
    if (q === 'tech' || q === 'office') window.localStorage.setItem('dw.role', q);
  } catch {
    /* storage is best-effort */
  }
  return resolveRole({ search: window.location.search, stored, mobile });
}

/** Stable reorder: facts this role cares about first, the other role's facts last, everything else in place. */
export function orderFactsForRole(facts: Fact[], role: Role | null): Fact[] {
  if (!role || facts.length < 2) return facts;
  const mine = role === 'tech' ? TECH_RE : OFFICE_RE;
  const theirs = role === 'tech' ? OFFICE_RE : TECH_RE;
  const rank = (f: Fact) => (mine.test(f.label) && !theirs.test(f.label) ? 0 : theirs.test(f.label) && !mine.test(f.label) ? 2 : 1);
  const ranked = facts.map((f, i) => ({ f, i, r: rank(f) }));
  if (ranked.every((x) => x.r === 1)) return facts;
  return ranked.sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
}

export function applyRole(answer: Answer, role: Role | null): Answer {
  if (!role || answer.kind !== 'answer') return answer;
  const facts = orderFactsForRole(answer.facts ?? [], role);
  return facts === answer.facts ? answer : { ...answer, facts };
}

const ROLE_CHIPS: Record<Role, Record<string, string[]>> = {
  tech: {
    money: ['Which unit was this for?', 'What work was done?', 'Payment history'],
    status: ['Model and serial?', 'Last service?', 'Open work orders?'],
    'single-fact': ['Model and serial?', 'Warranty status?', 'When was it installed?'],
  },
  office: {
    status: ['Any open balance?', 'Agreement status?', 'Last service?'],
    'single-fact': ['Any open balance?', 'Warranty status?'],
  },
};

/** Role-leading chips first (deduped, capped); falls back to the generic chips when the role has none for this layout. */
export function roleChips(kind: string, role: Role | null, generic: string[], max = 3): string[] {
  const own = role ? ROLE_CHIPS[role][kind] : undefined;
  if (!own) return generic;
  const seen = new Set<string>();
  return [...own, ...generic].filter((c) => (seen.has(c) ? false : (seen.add(c), true))).slice(0, max);
}
