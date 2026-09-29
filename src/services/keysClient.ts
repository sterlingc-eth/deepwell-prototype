/**
 * API key management client (POST /api/keys → api/_lib/routes/keys.js). Creating a key is Fleet-only: any other
 * plan gets 403 "API access is included on the Fleet plan" (Round 26). list/revoke stay open on every plan.
 */
import { authHeader } from './authToken';

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* HTML error page — keep the status line */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const keysClient = {
  list: () => call<{ keys: ApiKeyRow[] }>({ action: 'list' }).then((r) => r.keys),
  create: (name: string, scopes: string[]) => call<ApiKeyRow & { key: string }>({ action: 'create', name, scopes }),
  revoke: (id: string) => call<{ id: string; revoked: true }>({ action: 'revoke', id }),
};
