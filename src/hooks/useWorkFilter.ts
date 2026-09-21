import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Doc } from '../core/types';
import { useMemberDirectory } from './useMemberDirectory';
import { defaultWorkFilterChoice, isMineDoc, type WorkFilterChoice } from '../core/workFilter';

const HINT_SEEN_KEY = 'deepwell.workFilterHintSeen';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window / blocked storage — the control still works, it just won't remember */
  }
}

export interface UseWorkFilter {
  choice: WorkFilterChoice;
  setChoice: (c: WorkFilterChoice) => void;
  isMine: (doc: Doc) => boolean;
  /** False for a solo (no-org) tenant — the control should not render at all. */
  hasShop: boolean;
  nameByUserId: Map<string, string>;
  /** Show the one-line "Donovan answers from everyone's records" hint —
   *  true only the first time this browser sees the control. */
  showHint: boolean;
}

/**
 * Drives the "My work / Everyone" segmented control (owner brief
 * 2026-09-21): a multi-tech shop's technicians default to seeing their own
 * work, with an easy toggle to see everyone's.
 *
 * `allDocs` should be the tenant's FULL document set, not a screen's own
 * sub-filtered view — the default-choice rule and the per-user localStorage
 * persistence must stay stable regardless of what other filters (stage,
 * type, search…) a screen happens to have active alongside this one.
 */
export function useWorkFilter(allDocs: Doc[]): UseWorkFilter {
  const { userId, displayName, isAdmin, hasShop, nameByUserId } = useMemberDirectory();
  const user = useMemo(() => ({ userId, displayName }), [userId, displayName]);

  const attributedCount = useMemo(
    () => (userId ? allDocs.filter((d) => isMineDoc(d, user)).length : 0),
    [allDocs, userId, user]
  );

  const [choice, setChoiceState] = useState<WorkFilterChoice>('everyone');

  // Runs once per userId becoming known (Clerk hydrates async): pick up a
  // stored per-user choice, or compute the default rule. Deliberately does
  // NOT re-run every time attributedCount changes afterward — once a user
  // (or the default) has picked, a later upload should not silently flip
  // the control out from under them.
  useEffect(() => {
    if (!userId) return;
    const stored = safeGet(`deepwell.workFilter.${userId}`);
    if (stored === 'mine' || stored === 'everyone') {
      setChoiceState(stored);
    } else {
      setChoiceState(defaultWorkFilterChoice({ hasShop, isAdmin, attributedDocCount: attributedCount }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const setChoice = useCallback(
    (c: WorkFilterChoice) => {
      setChoiceState(c);
      if (userId) safeSet(`deepwell.workFilter.${userId}`, c);
    },
    [userId]
  );

  // A solo tenant has no coworkers to filter out — never apply 'mine'
  // filtering there even if a stale per-user choice says otherwise (e.g.
  // this browser profile was once part of a shop).
  const effectiveChoice: WorkFilterChoice = hasShop ? choice : 'everyone';

  const isMine = useCallback((doc: Doc) => (userId ? isMineDoc(doc, user) : true), [userId, user]);

  const showHint = useMemo(() => {
    if (!hasShop) return false;
    return !safeGet(HINT_SEEN_KEY);
  }, [hasShop]);
  useEffect(() => {
    if (showHint) safeSet(HINT_SEEN_KEY, '1');
  }, [showHint]);

  return { choice: effectiveChoice, setChoice, isMine, hasShop, nameByUserId, showHint };
}
