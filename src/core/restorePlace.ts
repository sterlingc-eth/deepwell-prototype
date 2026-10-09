// Refresh keeps your place (see appStore.ts): what a saved { screen, inboxTab } value restores to. Pure, so
// scripts/verify-import-progress.ts can check it without a browser.
import type { Screen } from '../store/appStore';

const RESTORABLE_SCREENS: readonly Screen[] = ['ask', 'ingest', 'dashboard', 'browse', 'warranty-export', 'billing', 'team', 'outreach'];
const RESTORE_AS: Partial<Record<Screen, Screen>> = { entity: 'browse', customer: 'browse', review: 'ingest', records: 'dashboard' };

/** Pure: what a saved value restores to. Exported for scripts/verify-import-progress.ts. */
export function restoredPlace(raw: string | null): { screen: Screen; inboxTab: 'add' | 'needs-person' } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { screen?: string; inboxTab?: string };
    const s = (RESTORE_AS[v.screen as Screen] ?? v.screen) as Screen;
    if (!RESTORABLE_SCREENS.includes(s)) return null;
    return { screen: s, inboxTab: v.inboxTab === 'needs-person' ? 'needs-person' : 'add' };
  } catch {
    return null;
  }
}

