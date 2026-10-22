/**
 * Industry demo account: the two server calls the demo screens make (status and "Clear my scans"), plus the demo-day
 * health check that runs each demo company's first starter question.
 */
import { authHeader } from '../services/authToken';

export interface DemoStatus {
  demo: boolean;
  industry?: string | null;
  company?: string | null;
  documents?: number;
  seedDocuments?: number;
  scans?: number;
  seededAt?: string | null;
}

async function post<T>(body: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : await authHeader()) };
  const res = await fetch('/api/account?action=demo', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Something went wrong. Please try again.');
  return data as T;
}

export const demoClient = {
  status: (token?: string | null) => post<DemoStatus>({ op: 'status' }, token),
  clearScans: () => post<{ ok: boolean; removedDocuments: number }>({ op: 'clear-scans' }),
};

export interface HealthRow {
  industry: string;
  ok: boolean;
  documents: number | null;
  answered: boolean;
  cited: boolean;
  ms: number;
  note?: string;
}

/** One demo company: it loads (status), holds its sample paperwork, and answers its first starter question with a source. */
export async function checkDemoCompany(industry: string, firstQuestion: string, token: string | null): Promise<HealthRow> {
  const started = performance.now();
  try {
    if (!token) throw new Error('Could not open this demo company');
    const s = await demoClient.status(token);
    if (!s.demo) throw new Error('Not set up as a demo company');
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: firstQuestion }),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: { kind?: string; facts?: { sources?: unknown[] }[]; sources?: unknown[] } };
    const data = body?.data;
    const answered = res.ok && data?.kind === 'answer';
    const cited = Boolean(data?.facts?.some((f) => Array.isArray(f.sources) && f.sources.length > 0) || (Array.isArray(data?.sources) && data!.sources!.length > 0));
    const seedOk = (s.seedDocuments ?? 0) >= 20;
    return {
      industry, ok: answered && cited && seedOk, documents: s.documents ?? null, answered, cited, ms: Math.round(performance.now() - started),
      note: !seedOk ? 'Sample paperwork is missing' : !answered ? 'First question did not answer' : !cited ? 'Answer had no source' : undefined,
    };
  } catch (err) {
    return { industry, ok: false, documents: null, answered: false, cited: false, ms: Math.round(performance.now() - started), note: err instanceof Error ? err.message : 'Failed' };
  }
}
