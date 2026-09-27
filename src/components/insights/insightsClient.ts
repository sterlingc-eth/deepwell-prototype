/**
 * Typed client for POST /api/account?action=insights (api/_lib/routes/insights.js) — the
 * proactive "needs attention" list. Same postJson/authHeader shape as outreachClient.ts/
 * notifyClient.ts.
 */
import { authHeader } from '../../services/authToken';
import { messageFromResponse } from '../../services/httpError';

const API_URL = '/api/account?action=insights';

export class InsightsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'InsightsApiError';
    this.status = status;
  }
}

export type InsightSeverity = 'high' | 'medium' | 'low';
export type InsightKind = 'warranty' | 'financial' | 'repeat' | 'data-gap';

export interface InsightItem {
  label: string;
  entityId: string | null;
  documentIds: string[];
}

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  count: number;
  dollars?: number;
  items: InsightItem[];
  action: { label: string; href: string };
}

export interface InsightsResponse {
  items: Insight[];
  total: number;
  generatedAt: string;
  cached: boolean;
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
    throw new InsightsApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export async function fetchInsights(limit = 8): Promise<InsightsResponse> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ limit }),
  });
  return handle<InsightsResponse>(res);
}
