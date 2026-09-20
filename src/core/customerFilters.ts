/**
 * Pure filter predicate for the Customers tab (owner request 2026-09-20,
 * item 1). Combines with the existing search box: the screen narrows by
 * `q` server-side, then applies this client-side over whatever page came
 * back, same as it already does for `sort`.
 *
 * Alerts: GET /api/v1/customers's `warrantyAlerts` is a single combined
 * count (api/_lib/routes/customers.js's countWarrantyAlerts folds 'expired'
 * and 'expiring-90' together) — there is no per-row tier breakdown to filter
 * on yet. `expiredCount`/`expiringCount` are declared as optional on
 * CustomerSummary so this degrades honestly: with no breakdown, 'expiring'
 * and 'expired' both fall back to "has any alert" (warrantyAlerts > 0)
 * rather than inventing a distinction the data doesn't support. See
 * handoffs/REQUESTS_frontend.md for the backend ask to split it for real.
 */
import { normalize } from './answer';
import type { CustomerSummary } from '../services/customerClient';

export type AlertsFilter = 'any' | 'expiring' | 'expired' | 'none';
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

export function matchesCustomerFilters(c: CustomerSummary, f: CustomerFilters, now: Date = new Date()): boolean {
  if (f.alerts === 'none' && c.warrantyAlerts > 0) return false;
  if (f.alerts === 'expiring' && !((c.expiringCount ?? c.warrantyAlerts) > 0)) return false;
  if (f.alerts === 'expired' && !((c.expiredCount ?? c.warrantyAlerts) > 0)) return false;

  if (f.equipment === 'has' && c.equipmentCount <= 0) return false;
  if (f.equipment === 'none' && c.equipmentCount > 0) return false;

  if (f.city && normalize(c.city ?? '') !== normalize(f.city)) return false;

  if (f.lastActivity !== 'any') {
    if (!c.lastActivity) return false;
    const days = (now.getTime() - new Date(c.lastActivity).getTime()) / 86400000;
    if (days > f.lastActivity) return false;
  }

  return true;
}
