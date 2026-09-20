/**
 * Typed client for the customer-profile API (handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md
 * sections B/C): reads go straight to GET /api/v1/customers and
 * GET /api/v1/customer (Clerk-session, tenant-scoped, same as v1-equipment.js
 * / v1-warranty.js); writes go through POST /api/review's four new actions
 * (createCustomer/updateCustomer/assignDocumentCustomer/mergeCustomers),
 * exactly like reviewClient.ts's existing six. Kept as one file (not split
 * read/write) because the brief lists exactly this shape:
 * "customerClient.ts (list, get, create, update, assign, merge)".
 */

import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const CUSTOMERS_URL = '/api/v1/customers';
const CUSTOMER_URL = '/api/v1/customer';
const REVIEW_URL = '/api/review';

/** 'C-00001' style, mirroring api/_lib/routes/customers.js's CUSTOMER_NUMBER_RE
 *  exactly (src/ cannot import api/ — different tsconfig root/build, same
 *  reason src/domains/hvac/documentTypes.ts hand-mirrors api/_lib/documentTypes.js). */
export const CUSTOMER_NUMBER_RE = /^C-\d{5}$/;

export function isValidCustomerNumber(s: string | null | undefined): s is string {
  return typeof s === 'string' && CUSTOMER_NUMBER_RE.test(s);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string | null | undefined): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Given whatever ref a caller has in hand (a deep link, a URL param, a
 *  free-typed search box), which lookup key it is — or null if it looks like
 *  neither, so the caller can show "not found" instead of firing a request
 *  that can never match. */
export function refKind(ref: string | null | undefined): 'id' | 'number' | null {
  if (isUuid(ref)) return 'id';
  if (isValidCustomerNumber(ref)) return 'number';
  return null;
}

async function parseErrorBody(res: Response): Promise<{ message: string; body: unknown }> {
  const raw = await res.text().catch(() => '');
  let message = `${res.status} ${res.statusText}`;
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
    const parsed = body as { error?: string };
    if (parsed?.error) message = parsed.error;
  } catch {
    /* a 500 from Vercel is an HTML page, not JSON — keep the status line */
  }
  if (res.status === 429) message = messageFromResponse(res, body, message);
  return { message, body };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { ...(await authHeader()) } });
  if (!res.ok) {
    const { message } = await parseErrorBody(res);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function postAction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(REVIEW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const { message } = await parseErrorBody(res);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ types */

export interface CustomerSummary {
  id: string;
  customerNumber: string | null;
  name: string | null;
  serviceAddress: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  documentCount: number;
  equipmentCount: number;
  lastActivity: string | null;
  warrantyAlerts: number;
  /** Not sent by the API today (countWarrantyAlerts folds both tiers into
   *  warrantyAlerts) — declared for forward compat, see core/customerFilters.ts. */
  expiringCount?: number;
  expiredCount?: number;
  mergedInto: string | null;
}

export type CustomerSort = 'name' | 'recent' | 'docs';

/** One GET /api/v1/customers `duplicates` entry
 *  (handoffs/DATA_INTEGRITY_2026-09-20.md, tightened 2026-09-20 "strict
 *  rules" follow-up). `tier`: 'auto' only when name, address, and phone/email
 *  (where present) all agree with no conflicting identity field anywhere —
 *  safe to merge unattended. 'suggest' means at least one of those is only
 *  partly confirmed (e.g. phone on just one record) — a human decides.
 *  `evidence` lists which identity fields matched, were missing on one side,
 *  or conflicted (api/_lib/integrity.js's evaluateCustomerMatch). */
export interface CustomerMatchEvidence {
  matches: string[];
  missing: string[];
  conflicts: string[];
}

export interface CustomerDuplicatePair {
  keepId: string;
  dropId: string;
  score: number;
  tier: 'auto' | 'suggest';
  evidence: CustomerMatchEvidence;
  reason: string;
}

interface CustomersResponse {
  customers: CustomerSummary[];
  duplicates?: CustomerDuplicatePair[];
}

export interface CustomerEquipment {
  id: string;
  serial: string | null;
  model: string | null;
  manufacturer: string | null;
  installDate: string | null;
  warranty: { tier: string; expires: string | null; daysLeft: number | null };
}

export interface CustomerDocument {
  id: string;
  filename: string | null;
  type: string | null;
  stage: string;
  verifiedBy: string | null;
  createdAt: string | null;
  serviceDate: string | null;
  /** 'direct' | 'equipment:<serial>' | 'name-match' — see mergeDocumentVia/formatVia. */
  via: string;
}

export interface CustomerTimelineEntry {
  date: string;
  kind: 'service' | 'install' | 'invoice' | 'warranty' | 'document';
  title: string;
  documentId: string | null;
}

export interface CustomerDuplicate {
  id: string;
  customerNumber: string | null;
  name: string | null;
  serviceAddress: string | null;
  reason: string;
}

export interface CustomerRecord {
  id: string;
  customerNumber: string | null;
  name: string | null;
  serviceAddress: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  billingAddress: string | null;
  formerNumbers: string[];
}

export interface CustomerDetail {
  customer: CustomerRecord;
  equipment: CustomerEquipment[];
  documents: CustomerDocument[];
  timeline: CustomerTimelineEntry[];
  duplicates: CustomerDuplicate[];
}

export interface CustomerPatch {
  name?: string;
  serviceAddress?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export interface CreateCustomerInput {
  name: string;
  serviceAddress?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

/* --------------------------------------------------------------- reading */

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** GET /api/v1/customers now nests the array as `.customers` plus a
 *  `.duplicates` list (handoffs/DATA_INTEGRITY_2026-09-20.md); a bare array
 *  is accepted too so this survives a partial rollout either direction. */
function normalizeCustomersResponse(data: CustomersResponse | CustomerSummary[]): CustomersResponse {
  return Array.isArray(data) ? { customers: data, duplicates: [] } : { customers: data.customers, duplicates: data.duplicates ?? [] };
}

export const customerClient = {
  list(opts: { q?: string; sort?: CustomerSort; limit?: number } = {}): Promise<CustomerSummary[]> {
    return customerClient.listFull(opts).then((r) => r.customers);
  },

  /** Same query as `list`, but also returns the likely-duplicate pairs the
   *  Customers tab's banner needs (owner request 2026-09-20, item 2). */
  listFull(opts: { q?: string; sort?: CustomerSort; limit?: number } = {}): Promise<CustomersResponse> {
    return getJson<CustomersResponse | CustomerSummary[]>(`${CUSTOMERS_URL}${buildQuery({ q: opts.q, sort: opts.sort, limit: opts.limit })}`).then(
      normalizeCustomersResponse
    );
  },

  /** Looks up by either a customer's uuid (`id`) or its display number
   *  ('C-00012', `number`) — pass exactly one, same as the API contract. */
  get(ref: { id?: string; number?: string }): Promise<CustomerDetail> {
    return getJson<CustomerDetail>(`${CUSTOMER_URL}${buildQuery({ id: ref.id, number: ref.number })}`);
  },

  /** Resolves whatever ref a caller has (a deep link, a URL, free-typed
   *  text) by first checking its shape, so a value that is neither a uuid
   *  nor a 'C-#####' number never reaches the network as a doomed request. */
  getByRef(ref: string): Promise<CustomerDetail> {
    const kind = refKind(ref);
    if (kind === 'id') return customerClient.get({ id: ref });
    if (kind === 'number') return customerClient.get({ number: ref });
    return Promise.reject(new Error(`"${ref}" isn't a customer id or number (like C-00012).`));
  },

  /* --------------------------------------------------------------- writing */

  create(input: CreateCustomerInput): Promise<{ customer: CustomerRecord & Record<string, unknown> }> {
    return postAction('createCustomer', { ...input });
  },

  update(customerId: string, patch: CustomerPatch): Promise<{ customer: CustomerRecord & Record<string, unknown> }> {
    return postAction('updateCustomer', { customerId, patch });
  },

  assignDocument(documentId: string, customerId: string): Promise<{ document: Record<string, unknown> }> {
    return postAction('assignDocumentCustomer', { documentId, customerId });
  },

  merge(keepId: string, dropId: string): Promise<{ keep: Record<string, unknown>; dropped: Record<string, unknown> }> {
    return postAction('mergeCustomers', { keepId, dropId });
  },
};
