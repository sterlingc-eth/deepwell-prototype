/**
 * Pure filter/sort/search logic for the Customers tab (owner feedback
 * 2026-09-20: "the filters don't fully work as they should — seems like you
 * just threw those filters in and didn't logically set them up"). Every
 * function here is pure and fully covered in scripts/verify-ui.ts's
 * "customer filters" fixture (6 customers, one per branch) — no DOM, no
 * store, no network, so the semantics can never silently drift from what's
 * tested.
 *
 * The screen (CustomersScreen.tsx) does exactly this, in this order, over
 * whatever page of rows it has:
 *   1. matchesSearch   — the free-text box (name/number/address/phone/email)
 *   2. matchesCustomerFilters — the four dropdowns (AND together)
 *   3. sortCustomers   — a single "Sort by" select; NOT a filter, so it never
 *      changes which rows are shown, only their order.
 *
 * `alerts` (GET /api/v1/customers) is now a real per-tier breakdown
 * (api/_lib/routes/customers.js's tallyWarrantyAlerts, mirroring alertTier
 * per unit) — {expiring, expired} — not a fabricated split of one combined
 * count. "Expiring soon" includes both the 30- and 90-day alertTier tiers
 * (see that file's comment for why: a unit due in 9 days is at least as
 * urgent as one due in 80).
 */
import { normalize } from './answer';
import type { CustomerSummary } from '../services/customerClient';

export type AlertsFilter = 'any' | 'expiring' | 'expired' | 'attention' | 'none';
export type EquipmentFilter = 'any' | 'has' | 'none';
export type LastActivityFilter = 'any' | 30 | 90 | 365;

export interface CustomerFilters {
  alerts: AlertsFilter;
  equipment: EquipmentFilter;
  city: string | null;
  lastActivity: LastActivityFilter;
}

export const DEFAULT_CUSTOMER_FILTERS: CustomerFilters = {
  alerts: 'any',
  equipment: 'any',
  city: null,
  lastActivity: 'any',
};

export const ALERTS_OPTIONS: { id: AlertsFilter; label: string }[] = [
  { id: 'any', label: 'Any alert status' },
  { id: 'expiring', label: 'Expiring soon' },
  { id: 'expired', label: 'Expired' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'none', label: 'No alerts' },
];
export const ALERTS_LABEL: Record<AlertsFilter, string> = Object.fromEntries(ALERTS_OPTIONS.map((o) => [o.id, o.label])) as Record<AlertsFilter, string>;

export const EQUIPMENT_OPTIONS: { id: EquipmentFilter; label: string }[] = [
  { id: 'any', label: 'Any equipment' },
  { id: 'has', label: 'Has units' },
  { id: 'none', label: 'No units on file' },
];
export const EQUIPMENT_LABEL: Record<EquipmentFilter, string> = Object.fromEntries(EQUIPMENT_OPTIONS.map((o) => [o.id, o.label])) as Record<EquipmentFilter, string>;

export const ACTIVITY_OPTIONS: { id: LastActivityFilter; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 30, label: 'Last 30 days' },
  { id: 90, label: 'Last 90 days' },
  { id: 365, label: 'Last 365 days' },
];
export const ACTIVITY_LABEL: Record<string, string> = Object.fromEntries(ACTIVITY_OPTIONS.map((o) => [String(o.id), o.label]));

/** The four dropdowns, AND'd together — never OR'd, never a fifth hidden
 *  condition. `now` is injectable so tests never depend on the real clock. */
export function matchesCustomerFilters(c: CustomerSummary, f: CustomerFilters, now: Date = new Date()): boolean {
  const expiring = c.alerts.expiring > 0;
  const expired = c.alerts.expired > 0;
  if (f.alerts === 'expiring' && !expiring) return false;
  if (f.alerts === 'expired' && !expired) return false;
  if (f.alerts === 'attention' && !(expiring || expired)) return false;
  if (f.alerts === 'none' && (expiring || expired)) return false;

  if (f.equipment === 'has' && c.equipmentCount <= 0) return false;
  if (f.equipment === 'none' && c.equipmentCount > 0) return false;

  if (f.city && normalize(c.city ?? '') !== normalize(f.city)) return false;

  // Default ('any') never hides a customer for having no activity on file —
  // only picking an actual window does, and only then.
  if (f.lastActivity !== 'any') {
    if (!c.lastActivity) return false;
    const days = (now.getTime() - new Date(c.lastActivity).getTime()) / 86400000;
    if (days > f.lastActivity) return false;
  }

  return true;
}

/** Which of the four dropdowns are off their default, as removable-chip
 *  {key, label} pairs, in a stable display order. Purely descriptive — the
 *  screen wires each chip's "x" to resetting that one key. */
export function describeActiveFilters(f: CustomerFilters): { key: keyof CustomerFilters; label: string }[] {
  const out: { key: keyof CustomerFilters; label: string }[] = [];
  if (f.alerts !== 'any') out.push({ key: 'alerts', label: ALERTS_LABEL[f.alerts] });
  if (f.equipment !== 'any') out.push({ key: 'equipment', label: EQUIPMENT_LABEL[f.equipment] });
  if (f.city) out.push({ key: 'city', label: `City: ${f.city}` });
  if (f.lastActivity !== 'any') out.push({ key: 'lastActivity', label: ACTIVITY_LABEL[String(f.lastActivity)] ?? `Last ${f.lastActivity} days` });
  return out;
}

/** City options for the dropdown: distinct non-null cities from the CURRENT
 *  (already search/filtered-by-everything-else) list, sorted A-Z, each
 *  carrying how many rows have it. The screen hides the whole control when
 *  this returns fewer than 2 — a single city is nothing to filter by. */
export interface CityOption { city: string; count: number }
export function cityOptions(rows: CustomerSummary[]): CityOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.city) counts.set(r.city, (counts.get(r.city) ?? 0) + 1);
  }
  return [...counts.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => a.city.localeCompare(b.city));
}

/** A name that reads as a company rather than a person — company names sort
 *  by their full text; a person's name sorts by surname (owner: "Name A-Z").
 *  Conservative: only names with an unambiguous business marker are treated
 *  as companies, so an ordinary "First Last" always falls through to the
 *  surname rule. */
const COMPANY_HINT_RE = /\b(llc|l\.l\.c\.?|inc|inc\.?|incorporated|corp|corporation|co\.|company|group|hoa|association|assoc|properties|management|mgmt|plumbing|hvac|heating|cooling|mechanical|services|holdings|partners|church|school|district)\b/i;

/** The key `sortCustomers`'s 'name' mode compares: the surname (last
 *  whitespace-separated token) for a person, the full name for a company,
 *  case-insensitively. Exported so the fixture tests can pin it directly. */
export function customerSortName(name: string | null): string {
  const n = (name ?? '').trim();
  if (!n) return '';
  if (COMPANY_HINT_RE.test(n)) return n.toLowerCase();
  const tokens = n.split(/\s+/).filter(Boolean);
  return (tokens[tokens.length - 1] ?? n).toLowerCase();
}

export type CustomerSortBy = 'recent' | 'name' | 'address' | 'docs' | 'equipment' | 'alerts';
export const CUSTOMER_SORT_OPTIONS: { id: CustomerSortBy; label: string }[] = [
  { id: 'recent', label: 'Recent activity' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'address', label: 'Address A–Z' },
  { id: 'docs', label: 'Most documents' },
  { id: 'equipment', label: 'Most equipment' },
  { id: 'alerts', label: 'Alerts first' },
];

export type CustomerSortDirection = 'asc' | 'desc';

/** Each mode's own natural reading order — a name/address column reads A-Z,
 *  a count column reads highest-first — so a caller (or a fixture test) that
 *  omits `direction` keeps getting exactly the order it always has. Column
 *  headers use this to pick the starting direction the first time a header
 *  is clicked. */
const DEFAULT_SORT_DIRECTION: Record<CustomerSortBy, CustomerSortDirection> = {
  recent: 'desc',
  name: 'asc',
  address: 'asc',
  docs: 'desc',
  equipment: 'desc',
  alerts: 'desc',
};
export function defaultSortDirection(by: CustomerSortBy): CustomerSortDirection {
  return DEFAULT_SORT_DIRECTION[by];
}

/** The key the 'address' sort mode compares: city first, then street —
 *  case/punctuation-insensitive (via `normalize`), blanks sort first.
 *  Exported so the header click handler and fixture tests can pin it
 *  directly, same as `customerSortName`. */
export function customerSortAddress(c: CustomerSummary): [string, string] {
  return [normalize(c.city ?? ''), normalize(c.serviceAddress ?? '')];
}

/** Sort is never a filter: it reorders, it never hides a row. A stable sort
 *  (ties broken by original position) so re-sorting the same list twice
 *  never visibly shuffles rows that compare equal. `direction` defaults to
 *  each mode's own natural order (see `defaultSortDirection`) so existing
 *  call sites that only ever passed `by` keep behaving exactly as before. */
export function sortCustomers(rows: CustomerSummary[], by: CustomerSortBy, direction?: CustomerSortDirection): CustomerSummary[] {
  const dir = direction ?? DEFAULT_SORT_DIRECTION[by];
  const totalAlerts = (c: CustomerSummary) => c.alerts.expiring + c.alerts.expired;
  const cmp = (a: CustomerSummary, b: CustomerSummary): number => {
    switch (by) {
      case 'name': {
        const c = customerSortName(a.name).localeCompare(customerSortName(b.name));
        return dir === 'desc' ? -c : c;
      }
      case 'address': {
        const [ac, aStreet] = customerSortAddress(a);
        const [bc, bStreet] = customerSortAddress(b);
        const c = ac.localeCompare(bc) || aStreet.localeCompare(bStreet);
        return dir === 'desc' ? -c : c;
      }
      case 'docs': {
        const c = a.documentCount - b.documentCount;
        return dir === 'desc' ? -c : c;
      }
      case 'equipment': {
        const c = a.equipmentCount - b.equipmentCount;
        return dir === 'desc' ? -c : c;
      }
      case 'alerts': {
        const c = totalAlerts(a) - totalAlerts(b);
        return dir === 'desc' ? -c : c;
      }
      case 'recent':
      default:
        // No activity on file always sorts last, regardless of direction —
        // only which end the dated rows start from flips.
        if (!a.lastActivity && !b.lastActivity) return 0;
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return dir === 'desc' ? b.lastActivity.localeCompare(a.lastActivity) : a.lastActivity.localeCompare(b.lastActivity);
    }
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => cmp(x.r, y.r) || x.i - y.i)
    .map((x) => x.r);
}

/** The alert pill's hover/focus tooltip text, built entirely from the
 *  summary row's own per-tier counts (no per-row API call). Singular forms
 *  where the count is 1; expired reported before expiring, since it is
 *  always the more urgent of the two. Null when there's nothing to say. */
export function alertsTooltip(alerts: { expiring: number; expired: number }): string | null {
  const parts: string[] = [];
  if (alerts.expired > 0) parts.push(`${alerts.expired} warrant${alerts.expired === 1 ? 'y' : 'ies'} expired`);
  if (alerts.expiring > 0) parts.push(`${alerts.expiring} expiring within 90 days`);
  return parts.length ? parts.join(' · ') : null;
}

/** The search box: name, customer number, address, phone, email — combined,
 *  case/punctuation-insensitive (via `normalize`, shared with Ask's matcher).
 *  A query shaped like a customer-number fragment ("C-3") also matches the
 *  padded real number ("C-00003") by comparing digit runs numerically, so a
 *  person typing the number they can see on a printed slip doesn't have to
 *  know it's zero-padded to 5 digits. */
export function matchesSearch(c: CustomerSummary, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;

  const fields = [c.name, c.customerNumber, c.serviceAddress, c.phone, c.email]
    .filter((v): v is string => !!v)
    .map((v) => normalize(v));
  if (fields.some((f) => f.includes(q))) return true;

  const m = query.trim().match(/^c-?\s*(\d{1,5})$/i);
  if (m && c.customerNumber) {
    const cm = c.customerNumber.match(/^c-?(\d+)$/i);
    if (cm && Number(cm[1]) === Number(m[1])) return true;
  }
  return false;
}
