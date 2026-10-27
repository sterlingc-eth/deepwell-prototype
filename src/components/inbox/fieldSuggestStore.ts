import { useEffect, useSyncExternalStore } from 'react';
import { reviewClient, type FieldSuggestion } from '../../services/reviewClient';

/**
 * Open AI-finish field suggestions, kept OUTSIDE the document graph on purpose: a suggestion is not a fact, so nothing that reads the graph
 * (search, Donovan, exports, completeness) can see it. Loaded in batches for the papers on screen.
 */
let cache = new Map<string, FieldSuggestion[]>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach((l) => l()); };

export async function loadFieldSuggestions(docIds: string[], force = false): Promise<void> {
  const ids = docIds.filter((id) => force || !asked.has(id)).slice(0, 200);
  if (!ids.length) return;
  ids.forEach((id) => asked.add(id));
  try {
    const { suggestions } = await reviewClient.fieldSuggestions(ids);
    const next = new Map(cache);
    for (const id of ids) next.delete(id);
    for (const s of suggestions) next.set(s.document_id, [...(next.get(s.document_id) ?? []), s]);
    cache = next;
    emit();
  } catch {
    ids.forEach((id) => asked.delete(id)); // try again next time; a missing list just means no chip
  }
}

export function dropSuggestion(docId: string, key: string): void {
  const list = (cache.get(docId) ?? []).filter((s) => s.key !== key);
  const next = new Map(cache);
  if (list.length) next.set(docId, list); else next.delete(docId);
  cache = next;
  emit();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const EMPTY: FieldSuggestion[] = [];

/** The open suggestions for one paper (loads them the first time the paper is shown). */
export function useFieldSuggestions(docId: string): FieldSuggestion[] {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { void loadFieldSuggestions([docId]); }, [docId]);
  return cache.get(docId) ?? EMPTY;
}

/** For lists: ask for a whole batch at once, and read one paper's first suggestion. */
export function useFieldSuggestionsFor(docIds: string[]): (docId: string) => FieldSuggestion[] {
  useSyncExternalStore(subscribe, () => version);
  const key = docIds.join(',');
  useEffect(() => { void loadFieldSuggestions(docIds); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (id) => cache.get(id) ?? EMPTY;
}
