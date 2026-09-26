/**
 * Typed client for POST /api/records action=bootstrap — startup performance
 * (handoffs/STARTUP_PERF_R13.md). One round trip that returns everything the
 * app shell needs to show real (non-skeleton) data: billing status, the
 * notification bell's unread count, and a first page of documents —
 * instead of the five separate, staggered calls (billing, records x2,
 * review, document-status, account) the app used to fire in sequence on
 * every load.
 *
 * See src/hooks/useBootstrap.ts for how this is wired into App.tsx (with a
 * sessionStorage-cached billing status and a fallback to the old
 * billingClient.status() call if this action isn't available yet).
 */
import { authHeader } from './authToken';
import type { BillingStatus } from './billingClient';
import type { DocumentRow } from '../hooks/usePostgresSync';

const API_URL = '/api/records';

export class BootstrapApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BootstrapApiError';
    this.status = status;
  }
}

export interface BootstrapResponse {
  billing: BillingStatus;
  notifications: { items: unknown[]; unreadCount: number };
  records: { rows: DocumentRow[]; total: number };
}

export const bootstrapClient = {
  async bootstrap(): Promise<BootstrapResponse> {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ action: 'bootstrap' }),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let message = `bootstrap failed: ${res.status} ${res.statusText}`;
      try {
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed?.error) message = parsed.error;
      } catch {
        /* not JSON — a 500 from Vercel is an HTML page */
      }
      throw new BootstrapApiError(message, res.status);
    }
    return res.json() as Promise<BootstrapResponse>;
  },
};
