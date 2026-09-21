/**
 * Typed client for POST /api/account?action=outreach — handoffs/OUTREACH_2026-09-20.md.
 * Same postJson/authHeader shape as notifyClient.ts. Every sub-op is a POST
 * with an `op` field in the body (see api/_lib/routes/outreach.js).
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const API_URL = '/api/account?action=outreach';

export class OutreachApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OutreachApiError';
    this.status = status;
  }
}

export interface OutreachSettings {
  enabled: boolean;
  mode: 'review' | 'auto';
  leadDays: number;
  fromName: string | null;
  replyTo: string | null;
  offerText: string | null;
  /** The shop's own name, phone and sign-off line — Donovan's draft template
   *  uses these (api/_lib/outreach.js's renderOutreachEmail). Null until an
   *  admin sets them, or on a database that hasn't applied
   *  M3-config/21-outreach-shop-fields.sql yet. */
  shopName: string | null;
  shopPhone: string | null;
  signature: string | null;
  /** True once this tenant holds the `outreachAuto` add-on entitlement
   *  (api/_lib/plan.js's hasOutreachAutoEntitlement) — mode: 'auto' is only
   *  selectable when this is true; mode: 'review' never needs it. */
  outreachAutoEntitled: boolean;
  /** true when M3-config/18-outreach.sql hasn't been applied to this database yet. */
  migrationPending: boolean;
}

export type OutreachStatus = 'draft' | 'approved' | 'sent' | 'skipped' | 'failed' | 'bounced';

export interface OutreachMessage {
  id: string;
  tier: 'expiring-90' | 'expiring-30' | 'expired';
  equipmentId: string;
  toEmail: string;
  subject: string;
  preview: string;
  status: OutreachStatus;
  customerNumber: string | null;
  customerName: string | null;
  unit: string | null;
  serialLast4: string | null;
  createdAt: string;
  approvedAt: string | null;
  sentAt: string | null;
  error: string | null;
}

export interface GenerateResult {
  created: number;
  needsEmail: number;
  optedOut: number;
  alreadyDrafted: number;
  outsideLeadWindow: number;
  candidates: number;
}

export interface SendResult {
  sent: number;
  failed: number;
  skippedOptOut: number;
  attempted: number;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    throw new OutreachApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

export function fetchOutreachSettings(): Promise<OutreachSettings> {
  return call({ op: 'settings' });
}

export function saveOutreachSettings(patch: Partial<Omit<OutreachSettings, 'migrationPending' | 'outreachAutoEntitled'>>): Promise<OutreachSettings> {
  return call({ op: 'saveSettings', settings: patch });
}

export function listOutreachMessages(status?: OutreachStatus | 'all', limit = 200): Promise<{ items: OutreachMessage[] }> {
  return call({ op: 'list', status: status && status !== 'all' ? status : undefined, limit });
}

export function generateOutreachDrafts(): Promise<GenerateResult> {
  return call({ op: 'generate' });
}

export function approveOutreach(ids: string[]): Promise<{ approved: number }> {
  return call({ op: 'approve', ids });
}

export function approveAllOutreach(): Promise<{ approved: number }> {
  return call({ op: 'approve', all: true });
}

export function skipOutreach(ids: string[]): Promise<{ skipped: number }> {
  return call({ op: 'skip', ids });
}

export function sendApprovedOutreach(): Promise<SendResult> {
  return call({ op: 'sendApproved' });
}

export function previewOutreach(id: string): Promise<{ id: string; tier: string; toEmail: string; subject: string; bodyText: string; status: OutreachStatus }> {
  return call({ op: 'preview', id });
}

export function optOutCustomer(customerId: string): Promise<{ customerId: string; optedOut: boolean }> {
  return call({ op: 'optOut', customerId });
}

/** Pure — how many currently-sent + failed drafts fall in the current
 *  calendar month, for the Dashboard card's "sent this month" count.
 *  Exported so scripts/verify-ui.ts can assert it with no network. */
export function sentThisMonth(items: OutreachMessage[], now: Date = new Date()): number {
  const y = now.getFullYear();
  const m = now.getMonth();
  return items.filter((i) => {
    if (i.status !== 'sent' || !i.sentAt) return false;
    const d = new Date(i.sentAt);
    return d.getFullYear() === y && d.getMonth() === m;
  }).length;
}
