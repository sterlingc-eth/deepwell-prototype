/**
 * Customers tab paging helpers (R31 QA) — pure, CSS-free, unit-tested by scripts/verify-r31-qa.mjs.
 *
 * The tab used to fetch the first 200 customers and run search/filters over only that slice, so in a shop with
 * more than 200 customers the rest could not be found at all (the footer just said "(first 200)"). It now pages
 * through GET /api/v1/customers (limit + cursor), keeps the rows it has, and says plainly how many exist.
 */
import type { CustomerDuplicatePair, CustomerSummary } from '../services/customerClient';

/** The API's page size (its hard maximum). */
export const CUSTOMER_PAGE_SIZE = 200;
/** Stop auto-loading past this many rows (25 requests); search then falls back to the server for the rest. */
export const CUSTOMER_AUTOLOAD_MAX = 5000;

/** Append `incoming` to `existing`, first occurrence wins, order preserved (a page fetched twice never doubles a row). */
export function mergeCustomerPages(existing: CustomerSummary[], incoming: CustomerSummary[]): CustomerSummary[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((c) => c.id));
  const out = existing.slice();
  for (const c of incoming) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Duplicate pairs are computed per page by the server; across pages keep each pair once. */
export function mergeDuplicatePairs(existing: CustomerDuplicatePair[], incoming: CustomerDuplicatePair[]): CustomerDuplicatePair[] {
  if (incoming.length === 0) return existing;
  const key = (p: CustomerDuplicatePair) => [p.keepId, p.dropId].sort().join('|');
  const seen = new Set(existing.map(key));
  const out = existing.slice();
  for (const p of incoming) {
    if (seen.has(key(p))) continue;
    seen.add(key(p));
    out.push(p);
  }
  return out;
}

export interface CountLabelInput {
  /** Rows after search + filters. */
  shown: number;
  /** Rows fetched so far (plus any server search hits). */
  loaded: number;
  /** Customers in the whole shop, when the server said. */
  total: number | null;
  activeCount: number;
  loadingMore: boolean;
  moreError?: string | null;
}

const n = (v: number) => v.toLocaleString('en-US');
const plural = (v: number, one: string, many: string) => (v === 1 ? one : many);

/** The line under the table. Never claims a complete list it does not have. */
export function customerCountLabel({ shown, loaded, total, activeCount, loadingMore, moreError }: CountLabelInput): string {
  const incomplete = total != null && loaded < total;
  const filters = activeCount > 0 ? ` · ${activeCount} ${plural(activeCount, 'filter', 'filters')}` : '';
  if (!incomplete) {
    return activeCount > 0 ? `${n(shown)} of ${n(loaded)} ${plural(loaded, 'customer', 'customers')}${filters}` : `${n(loaded)} ${plural(loaded, 'customer', 'customers')}`;
  }
  const head = activeCount > 0 ? `${n(shown)} of the ${n(loaded)} loaded (${n(total)} in your shop)${filters}` : `Showing ${n(loaded)} of ${n(total)} customers`;
  if (loadingMore) return `${head} · loading the rest…`;
  if (moreError) return `${head} · ${moreError}`;
  return `${head} · search looks through all ${n(total)}`;
}
