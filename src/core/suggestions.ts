/**
 * "Try asking" suggestions for AskScreen.
 *
 * These used to be six hardcoded questions naming fake addresses and a fake
 * serial number — invented demo content shown to real contractors on a real
 * account. Every suggestion here instead names something that actually
 * exists in the graph: a property this tenant ingested, a serial this tenant
 * ingested. When the graph has nothing yet, the caller is expected to show
 * clearly-labelled examples instead of calling this at all — see AskScreen.
 */
import { useEffect, useRef, useState } from 'react';
import type { Entity } from './types';
import { str } from './answer';
import { authHeader } from '../services/authToken';

export const MAX_SUGGESTIONS = 5;

/**
 * Builds up to `max` real questions from the entities on hand. Pure and
 * order-preserving (same entities in, same suggestions out) so it is
 * directly unit-testable — no store, no React.
 */
export function buildSuggestions(entities: Entity[], max: number = MAX_SUGGESTIONS): string[] {
  const out: string[] = [];
  const push = (q: string | null | undefined) => {
    if (q && !out.includes(q) && out.length < max) out.push(q);
  };

  const properties = entities.filter((e) => e.type === 'property');
  const equipment = entities.filter((e) => e.type === 'equipment');

  for (const p of properties) {
    if (out.length >= max) break;
    const address = str(p, 'address');
    if (address) push(`When were we last at ${address}?`);
  }

  for (const e of equipment) {
    if (out.length >= max) break;
    const serial = str(e, 'serial');
    if (serial) push(`Is ${serial} still under warranty?`);
  }

  for (const p of properties) {
    if (out.length >= max) break;
    const customer = str(p, 'customerName');
    if (!customer) continue;
    const address = str(p, 'address');
    push(`What do we have on file for ${customer}${address ? ` at ${address}` : ''}?`);
  }

  if (equipment.length > 0) push('Which warranties expire in the next 12 months?');

  return out.slice(0, max);
}

// ---------------------------------------------------------------------------------------------------
// Server-driven Ask-box suggestions (Round 14 K1): typeahead completions, a preflight hint for the text
// currently in the box, role-based sample prompts for an empty Ask screen, and "Did you mean…" chips
// after a failed answer. All four hit the same no-model, deterministic route (POST /api/account
// ?action=ask-suggest — api/_lib/routes/ask-suggest.js) as the rest of Donovan's pre-router chain, so a
// suggestion here can never itself be the failed query the owner is trying to prevent.
// ---------------------------------------------------------------------------------------------------

export type PreflightLevel = 'instant' | 'slow' | 'needs-anchor';
export interface TypeaheadItem {
  id: string;
  text: string;
  category: string;
}
export interface PreflightHint {
  level: PreflightLevel;
  message: string;
  route: string | null;
}
export interface SamplePrompt {
  id: string;
  text: string;
  category: string;
}
export interface DidYouMeanChip {
  text: string;
}
export type AskRole = 'tech' | 'office';

const SUGGEST_ENDPOINT = '/api/account?action=ask-suggest';
const TYPEAHEAD_DEBOUNCE_MS = 200;
const MIN_TYPEAHEAD_CHARS = 2;
const TYPEAHEAD_CACHE_MAX = 200;

/** POSTs one op to the ask-suggest route. Returns null (never throws) on any network failure, an abort,
 *  or the caller being offline — the composer just keeps showing whatever it last had. */
async function postSuggest<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  try {
    const res = await fetch(SUGGEST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface TypeaheadResult {
  completions: TypeaheadItem[];
  hint: PreflightHint | null;
}
const EMPTY_TYPEAHEAD: TypeaheadResult = { completions: [], hint: null };

export function fetchTypeahead(text: string, signal?: AbortSignal): Promise<TypeaheadResult | null> {
  return postSuggest<TypeaheadResult>({ op: 'typeahead', text }, signal);
}
export function fetchSamplePrompts(role: AskRole, signal?: AbortSignal): Promise<{ prompts: SamplePrompt[] } | null> {
  return postSuggest<{ prompts: SamplePrompt[] }>({ op: 'samples', role }, signal);
}
export function fetchDidYouMean(text: string, signal?: AbortSignal): Promise<{ chips: DidYouMeanChip[] } | null> {
  return postSuggest<{ chips: DidYouMeanChip[] }>({ op: 'didyoumean', text }, signal);
}

// Cache per (trimmed, lowercased) prefix — typing the same partial text twice in one session (backspace
// then retype, switching fields and back) costs one request, not two. Capped so a very long session never
// grows this without bound; simplest possible eviction (clear and start over) rather than a real LRU,
// since this is a nice-to-have hit rate, not correctness.
const typeaheadCache = new Map<string, TypeaheadResult>();
function cacheTypeahead(key: string, value: TypeaheadResult) {
  if (typeaheadCache.size >= TYPEAHEAD_CACHE_MAX) typeaheadCache.clear();
  typeaheadCache.set(key, value);
}

/**
 * Typeahead completions + preflight hint for whatever is currently in the Ask box. Debounced, cached per
 * prefix, aborts a stale in-flight request when the text changes again before it lands, and degrades to
 * "show whatever we last had" rather than flashing empty on a network blip or while offline.
 */
export function useTypeahead(text: string, enabled = true): TypeaheadResult {
  const [result, setResult] = useState<TypeaheadResult>(EMPTY_TYPEAHEAD);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const key = text.trim().toLowerCase();
  const active = enabled && key.length >= MIN_TYPEAHEAD_CHARS;
  // A cache hit is derived straight from this render's own inputs (`key`, and the module-level cache a
  // prior request already filled) — returned directly below, never round-tripped through state/an effect.
  const cachedNow = active ? typeaheadCache.get(key) : undefined;

  useEffect(() => {
    if (!active || cachedNow) return; // nothing to fetch: disabled/too-short, or already-cached above
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void fetchTypeahead(key, controller.signal).then((data) => {
        if (!data) return; // offline / error / aborted — leave the last good result on screen
        cacheTypeahead(key, data);
        setResult(data);
      });
    }, TYPEAHEAD_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [key, active, cachedNow]);

  // Abort any in-flight request when the component unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!active) return EMPTY_TYPEAHEAD;
  return cachedNow ?? result;
}

/** Role-based sample prompts for an empty Ask screen, fetched once per role while `enabled`. Empty array
 *  (never an error) when offline, mid-flight, or the tenant has nothing on file yet to seed one from —
 *  the caller falls back to buildSuggestions()/hardcoded examples exactly as it already does. */
export function useSamplePrompts(role: AskRole, enabled = true): SamplePrompt[] {
  const [prompts, setPrompts] = useState<SamplePrompt[]>([]);
  useEffect(() => {
    if (!enabled) return; // derived at the `return` below — never worth an effect just to reset a constant
    const controller = new AbortController();
    void fetchSamplePrompts(role, controller.signal).then((data) => {
      if (data?.prompts) setPrompts(data.prompts);
    });
    return () => controller.abort();
  }, [role, enabled]);
  return enabled ? prompts : [];
}

/** "Did you mean…" chips for the question that just failed. Pass `null` to clear (a fresh question, or
 *  one that DID get an answer). */
export function useDidYouMean(question: string | null): DidYouMeanChip[] {
  const [chips, setChips] = useState<DidYouMeanChip[]>([]);
  useEffect(() => {
    if (!question) return; // derived at the `return` below — never worth an effect just to reset a constant
    const controller = new AbortController();
    void fetchDidYouMean(question, controller.signal).then((data) => {
      if (data?.chips) setChips(data.chips);
    });
    return () => controller.abort();
  }, [question]);
  return question ? chips : [];
}
