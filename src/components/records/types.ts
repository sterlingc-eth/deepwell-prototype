/**
 * Records Browse (round 12 contract) — shared shapes between the desktop
 * workspace (RecordsBrowser.tsx), the mobile Docs tab, and the server
 * (api/_lib/recordsStore.js's browseDocuments — see that file's "RECORDS
 * BROWSE" doc comment for the SQL side of every field below).
 */

export type BrowseSort = 'service-date' | 'upload-date' | 'customer' | 'type' | 'amount';
export const BROWSE_SORT_OPTIONS: { id: BrowseSort; label: string }[] = [
  { id: 'upload-date', label: 'Newest upload' },
  { id: 'service-date', label: 'Newest service date' },
  { id: 'customer', label: 'Customer A–Z' },
  { id: 'type', label: 'Type' },
  { id: 'amount', label: 'Amount' },
];

export type StageBucket = 'verified' | 'needs-review' | 'missing-info';
export const STAGE_BUCKET_LABEL: Record<StageBucket, string> = {
  verified: 'Verified',
  'needs-review': 'Needs review',
  'missing-info': 'Missing info',
};

export type WarrantyBucket = 'expired' | 'expiring' | 'active' | 'unknown';
export const WARRANTY_BUCKET_LABEL: Record<WarrantyBucket, string> = {
  expired: 'Expired',
  expiring: 'Expiring (90 days)',
  active: 'Active',
  unknown: 'No warranty on file',
};

export type GroupBy = 'none' | 'customer' | 'type' | 'month' | 'site';
export type ViewMode = 'table' | 'cards';

/** Everything a browse request can carry. Every field optional/omittable —
 *  the server treats a missing/invalid value as "not filtered", never a
 *  crash (see recordsStore.js's normalizeBrowseFilters). */
export interface BrowseFilters {
  q?: string;
  documentType?: string;
  customerId?: string;
  site?: string;
  technician?: string;
  brand?: string;
  stageBucket?: StageBucket;
  warrantyBucket?: WarrantyBucket;
  hasMoney?: boolean;
  openBalance?: boolean;
  uploadedByMe?: boolean;
  serviceDateFrom?: string;
  serviceDateTo?: string;
  uploadDateFrom?: string;
  uploadDateTo?: string;
  sort?: BrowseSort;
  cursor?: string | null;
  limit?: number;
}

export interface BrowseRow {
  id: string;
  filename: string;
  displayName: string | null;
  documentType: string | null;
  stage: string;
  stageBucket: StageBucket;
  verifiedBy: string | null;
  uploadedBy: string | null;
  createdAt: string | null;
  serviceDate: string | null;
  customerId: string | null;
  customerName: string | null;
  siteAddress: string | null;
  technician: string | null;
  brand: string | null;
  warrantyExpiry: string | null;
  warrantyBucket: WarrantyBucket;
  amount: number | null;
  balanceDue: number | null;
  moneyStatus: string | null;
  hasMoney: boolean;
}

export interface FacetOption { value: string; label: string; count: number }
export type BrowseFacet =
  | { key: string; options: FacetOption[] }
  | { key: 'hasMoney' | 'openBalance' | 'uploadedByMe'; trueCount: number };

export interface BrowseResponse {
  rows: BrowseRow[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  facets: BrowseFacet[];
  sort: BrowseSort;
  limit: number;
}

/** A saved view: a name plus the filter/sort/group-by/view-mode state to
 *  restore. Stored per-user in localStorage (see useRecordsBrowse.ts) — never
 *  the server, so this is deliberately a small, JSON-serializable shape. */
export interface SavedView {
  id: string;
  name: string;
  filters: BrowseFilters;
  groupBy: GroupBy;
  viewMode: ViewMode;
}

export const BUILT_IN_VIEWS: Omit<SavedView, 'id'>[] = [
  { name: 'Needs review', filters: { stageBucket: 'needs-review', sort: 'upload-date' }, groupBy: 'none', viewMode: 'table' },
  { name: 'Warranties expiring 90 days', filters: { warrantyBucket: 'expiring', sort: 'service-date' }, groupBy: 'customer', viewMode: 'table' },
  { name: "This month's invoices", filters: { documentType: 'invoice', sort: 'upload-date' }, groupBy: 'month', viewMode: 'table' },
  { name: 'My uploads', filters: { uploadedByMe: true, sort: 'upload-date' }, groupBy: 'none', viewMode: 'table' },
];
