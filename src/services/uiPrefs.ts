/**
 * Per-person screen preferences (hidden "Needs attention" rows, collapsed alert groups, the alerts filter).
 * Saved on the server in the shop's existing settings record under the signed-in person's own id, through the
 * notifications endpoint that already holds per-person choices (api/_lib/util/userPrefs.js). A copy is kept in
 * this browser's localStorage so the screen paints right away and still works if the network call fails.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { fetchNotifications, saveUiPrefs } from './notifyClient';
import type { HiddenMap } from '../components/insights/attentionPrefs';

export type AlertsFilter = 'all' | 'unread' | 'week';
export interface UiPrefs {
  needsAttention?: HiddenMap;
  alerts?: { collapsed: Record<string, boolean>; filter: AlertsFilter };
}

const key = (userId: string | null | undefined) => `dw.uiprefs.${userId ?? 'anon'}`;

export function readLocalPrefs(userId: string | null | undefined): UiPrefs {
  try {
    const raw = window.localStorage.getItem(key(userId));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as UiPrefs) : {};
  } catch {
    return {};
  }
}
function writeLocalPrefs(userId: string | null | undefined, p: UiPrefs) {
  try { window.localStorage.setItem(key(userId), JSON.stringify(p)); } catch { /* blocked: the choice just is not cached here */ }
}

let inflight: { at: number; p: Promise<UiPrefs | null> } | null = null;
function fetchServerPrefs(): Promise<UiPrefs | null> {
  if (inflight && Date.now() - inflight.at < 10_000) return inflight.p;
  const p = fetchNotifications().then((r) => (r.uiPrefs as UiPrefs | undefined) ?? null).catch(() => null);
  inflight = { at: Date.now(), p };
  return p;
}

/** The signed-in person's id, or null when there is no sign-in provider around (e.g. a bare component harness). useAuth throws
 *  the same way on every render, so the hook order never changes. */
function useOptionalUserId(): string | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useAuth().userId ?? null;
  } catch {
    return null;
  }
}

/** The current person's prefs plus a `update(patch)` that saves one top-level key at a time. */
export function useUiPrefs(): [UiPrefs, (patch: UiPrefs) => void] {
  const userId = useOptionalUserId();
  const [prefs, setPrefs] = useState<UiPrefs>(() => readLocalPrefs(userId));
  useEffect(() => {
    setPrefs(readLocalPrefs(userId));
    if (!userId) return;
    let cancelled = false;
    void fetchServerPrefs().then((server) => {
      if (cancelled || !server || Object.keys(server).length === 0) return;
      setPrefs((cur) => {
        const merged = { ...cur, ...server };
        writeLocalPrefs(userId, merged);
        return merged;
      });
    });
    return () => { cancelled = true; };
  }, [userId]);
  const update = useCallback((patch: UiPrefs) => {
    setPrefs((cur) => {
      const next = { ...cur, ...patch };
      writeLocalPrefs(userId, next);
      return next;
    });
    inflight = null;
    saveUiPrefs({ ...patch }).catch(() => { /* kept in this browser; the next change tries the server again */ });
  }, [userId]);
  return [prefs, update];
}
