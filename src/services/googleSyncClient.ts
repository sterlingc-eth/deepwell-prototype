/**
 * Connected sources (Google Drive + Gmail attachments): POST /api/google-sync -> api/_lib/googleSync/route.js.
 * With DEEPWELL_GOOGLE_SYNC off, status answers { enabled: false } and the card renders nothing.
 */
import { authHeader } from './authToken';

export type GoogleProvider = 'drive' | 'gmail';

export interface GoogleConnection {
  provider: GoogleProvider;
  scopeMode: 'narrow' | 'full';
  email: string | null;
  status: 'active' | 'paused' | 'needs-reconnect' | 'disconnected';
  lastSyncAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  filesImported: number;
  importedCount: number;
  removedCount: number;
  errorCount: number;
  choices: {
    picked?: Array<{ id: string; name: string; kind: 'folder' | 'file' }>;
    labelIds?: string[];
    labelNames?: string[];
    senders?: string[];
    lookbackDays?: number;
  };
  problems?: Array<{ filename: string | null; state: string; note: string | null }>;
  removed?: Array<{ filename: string | null }>;
}

export interface GoogleStatus {
  enabled: boolean;
  configured?: boolean;
  pickerReady?: boolean;
  dailyLimit?: number;
  usedToday?: number;
  lookbackChoices?: number[];
  connections?: GoogleConnection[];
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/google-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = 'Something went wrong. Please try again.';
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON: keep the plain message */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const googleSyncClient = {
  status: () => call<GoogleStatus>({ op: 'status' }),
  start: (provider: GoogleProvider, scopeMode?: 'narrow' | 'full') => call<{ url: string }>({ op: 'start', provider, scopeMode }),
  saveDrive: (picked: Array<{ id: string; name: string; kind: 'folder' | 'file' }>) => call<{ saved: true }>({ op: 'choices', provider: 'drive', picked }),
  saveGmail: (labels: Array<{ id: string; name: string }>, senders: string, lookbackDays: number) =>
    call<{ saved: true }>({ op: 'choices', provider: 'gmail', labels, senders, lookbackDays }),
  folders: (parentId?: string) => call<{ folders: Array<{ id: string; name: string }> }>({ op: 'folders', parentId }).then((r) => r.folders),
  labels: () => call<{ labels: Array<{ id: string; name: string }> }>({ op: 'labels' }).then((r) => r.labels),
  pickerToken: () => call<{ accessToken: string; apiKey: string; appId: string }>({ op: 'picker-token' }),
  pause: (provider: GoogleProvider) => call<{ status: string }>({ op: 'pause', provider }),
  resume: (provider: GoogleProvider) => call<{ status: string }>({ op: 'resume', provider }),
  disconnect: (provider: GoogleProvider) => call<{ disconnected: true }>({ op: 'disconnect', provider }),
  syncNow: (provider: GoogleProvider) => call<{ result: string | null; busy?: boolean }>({ op: 'sync-now', provider }),
};

/** "3 minutes ago" style text; plain and local. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Not checked yet';
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'Just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Open Google's own file picker (needs the picker script, which the page loads on demand). */
export async function openGooglePicker(
  tok: { accessToken: string; apiKey: string; appId: string },
  onPicked: (items: Array<{ id: string; name: string; kind: 'folder' | 'file' }>) => void,
): Promise<void> {
  const w = window as unknown as { gapi?: { load: (n: string, cb: () => void) => void }; google?: { picker: any } };
  if (!w.gapi) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://apis.google.com/js/api.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('The Google file picker could not open. Try again in a moment.'));
      document.head.appendChild(s);
    });
  }
  await new Promise<void>((resolve) => w.gapi!.load('picker', () => resolve()));
  const g = w.google!.picker;
  const view = new g.DocsView(g.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true);
  const picker = new g.PickerBuilder()
    .addView(view)
    .enableFeature(g.Feature.MULTISELECT_ENABLED)
    .setOAuthToken(tok.accessToken)
    .setDeveloperKey(tok.apiKey)
    .setAppId(tok.appId)
    .setCallback((data: any) => {
      if (data?.action !== g.Action.PICKED) return;
      onPicked((data.docs ?? []).map((d: any) => ({ id: String(d.id), name: String(d.name ?? ''), kind: d.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file' })));
    })
    .build();
  picker.setVisible(true);
}
