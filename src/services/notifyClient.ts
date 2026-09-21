/**
 * Typed client for GET/POST /api/account?action=notifications — the bell
 * icon's data source. Same postJson/getJson + authHeader shape as
 * billingClient.ts. Shapes documented in handoffs/NOTIFICATIONS.md.
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';
import { parseDeepLink, type DeepLinkParams } from '../hooks/useDeepLink';

const API_URL = '/api/account?action=notifications';

export class NotifyApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'NotifyApiError';
    this.status = status;
  }
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  unreadCount: number;
  /** Current tenant setting — "Email me warranty digests" on the Team screen. */
  emailDigest: boolean;
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
    throw new NotifyApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export async function fetchNotifications(): Promise<NotificationsResponse> {
  const res = await fetch(API_URL, { method: 'GET', headers: { ...(await authHeader()) } });
  return handle<NotificationsResponse>(res);
}

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

export function markNotificationsRead(ids: string[]): Promise<{ updated: number }> {
  return post({ markRead: ids });
}

export function markAllNotificationsRead(): Promise<{ updated: number }> {
  return post({ all: true });
}

export function setEmailDigestPreference(emailDigest: boolean): Promise<{ settings: Record<string, unknown> }> {
  return post({ settings: { emailDigest } });
}

/**
 * Pure — turns a stored `link` (e.g. "/app/?entity=<uuid>", the outreach
 * route's "/app/?screen=outreach", or a follow-up's absolute
 * "https://…/app/?screen=inbox&work=mine") into the same DeepLinkParams
 * shape useDeepLink.ts parses from the address bar, so NotificationsPanel
 * can navigate in-app with the exact same store actions a real deep link
 * uses — instead of only ever recognizing `?entity=` and silently sending
 * every other notification kind (outreach, follow-ups) to the Dashboard.
 * `link` may be absolute (a full https://… URL) or relative (just the path
 * + query) — only the query string after the first "?" matters here.
 */
export function parseNotificationLink(link: string | null | undefined): DeepLinkParams {
  if (!link) return {};
  const queryStart = link.indexOf('?');
  if (queryStart < 0) return {};
  return parseDeepLink(link.slice(queryStart));
}

/** Pure — how the bell badge renders a count. Exported so verify-ui.ts can
 *  assert it with no DOM: empty at 0, "9+" once it would otherwise crowd a
 *  small icon badge. */
export function unreadBadgeLabel(unreadCount: number): string {
  if (unreadCount <= 0) return '';
  if (unreadCount > 9) return '9+';
  return String(unreadCount);
}
