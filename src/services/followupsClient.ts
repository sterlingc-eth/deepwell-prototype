/**
 * Typed client for POST /api/account?action=followups — the Team screen's
 * "Follow-ups" card (owner brief item 3, handoffs/TECH_FOLLOWUPS_2026-09-21.md).
 * Same call()/authHeader shape as outreachClient.ts. Every sub-op is a POST
 * with an `op` field in the body (see api/_lib/routes/followups.js).
 */
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const API_URL = '/api/account?action=followups';

export class FollowupsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FollowupsApiError';
    this.status = status;
  }
}

export interface FollowupsSettings {
  enabled: boolean;
  email: boolean;
  /** True only when RESEND_API_KEY is configured server-side — the "also
   *  email" toggle is disabled with a hint when this is false. */
  emailAvailable: boolean;
}

export interface FollowupPreviewItem {
  userId: string;
  name: string;
  email: string | null;
  itemCount: number;
  subject: string;
  /** The full plain-text message body — enough on its own for "Copy message"
   *  / "Open in mail app", no extra round trip needed. */
  text: string;
}

export interface FollowupsRunResult {
  docsFlagged: number;
  techniciansDue: number;
  messagesSent: number;
  emailsSent: number;
  debounced: number;
  preview: FollowupPreviewItem[];
  dryRun: boolean;
  skippedReason?: string;
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
    throw new FollowupsApiError(message, res.status);
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

export function fetchFollowupsSettings(): Promise<FollowupsSettings> {
  return call({ op: 'settings' });
}

export function saveFollowupsSettings(patch: Partial<Pick<FollowupsSettings, 'enabled' | 'email'>>): Promise<FollowupsSettings> {
  return call({ op: 'saveSettings', settings: patch });
}

/** `apply: false` (the default) computes the same preview with no writes at
 *  all — safe to call as often as an admin likes ("Check now"). `apply: true`
 *  is the real thing: an in-app notification per technician due, plus email
 *  when the setting and RESEND_API_KEY both allow it. */
export function runFollowups(apply = false): Promise<FollowupsRunResult> {
  return call({ op: 'run', apply });
}
