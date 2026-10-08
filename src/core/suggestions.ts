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
  /** R32: optional row heading (the "Not who you meant?" chip after an auto-resolved typo); default "Did you mean". */
  heading?: string;
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

// ---------------------------------------------------------------------------------------------------
// Round 18 P2 owner fix: "clicking Donovan shows previous suggestions then snaps to the new ones".
//
// Root cause: AskScreen/AskTab both raced two sources for the same slot — an INSTANT client-only guess
// (buildSuggestions(), built synchronously from whatever is already in the local entity graph) rendered
// on the very first paint, then useSamplePrompts' server-validated samples arrived a beat later and
// replaced it. That's the flicker: not a cache bug, a render-race between two legitimate sources for the
// same chip row. Two fixes below: (1) useSamplePrompts now caches the last server response per
// tenant+role in localStorage and returns it SYNCHRONOUSLY on mount (before any network round trip), so
// a returning tenant sees ONE stable set immediately and a background refresh only ever updates the
// cache for the NEXT visit — it never swaps what's already on screen; (2) the caller (AskScreen/AskTab)
// stops using the client-only guess as an instant filler for this same slot — see this hook's `loading`
// flag, which is only true while there is truly nothing to show yet (no cache, first fetch in flight),
// so the caller can render a fixed-height placeholder instead of a second, different, real guess.
// ---------------------------------------------------------------------------------------------------

const SAMPLES_CACHE_PREFIX = 'deepwell.askSamples.';

interface CachedSamplesEntry {
  prompts: SamplePrompt[];
}

/** Exported so a caller that already knows its tenant key can seed/inspect the exact same storage key
 *  a test harness or another surface would use — never re-derive this format by hand elsewhere. */
export function samplesCacheKey(tenantKey: string, role: AskRole): string {
  return `${SAMPLES_CACHE_PREFIX}${tenantKey}::${role}`;
}

/** Never throws (private window, storage blocked/full, a corrupt entry) — a cache miss just means "show
 *  the placeholder and wait for the network", same as no cache ever having existed. `tenantKey` is
 *  required: with none (not signed in yet, or the caller genuinely has nothing to scope by) there is
 *  nothing safe to read, since an unscoped key could hand back a DIFFERENT tenant's samples. */
export function readCachedSamplePrompts(tenantKey: string | null, role: AskRole): SamplePrompt[] | null {
  if (!tenantKey) return null;
  try {
    const raw = window.localStorage.getItem(samplesCacheKey(tenantKey, role));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSamplesEntry;
    return Array.isArray(parsed?.prompts) && parsed.prompts.length ? parsed.prompts : null;
  } catch {
    return null;
  }
}

/** Best-effort (try/catch); a write failure just means the next visit starts from a placeholder again,
 *  same as today. Never writes an empty result over a real cached set — a transient empty server
 *  response must not blank out what a returning tenant already had cached. */
export function writeCachedSamplePrompts(tenantKey: string | null, role: AskRole, prompts: SamplePrompt[]): void {
  if (!tenantKey || !prompts.length) return;
  try {
    window.localStorage.setItem(samplesCacheKey(tenantKey, role), JSON.stringify({ prompts } satisfies CachedSamplesEntry));
  } catch {
    /* best-effort — worst case this tenant just sees the placeholder again next visit */
  }
}

export interface SamplePromptsState {
  prompts: SamplePrompt[];
  /** True only while there is nothing to show yet for this tenant+role this visit (no cache, and the
   *  first-ever fetch for it hasn't resolved — a resolved-but-empty or failed fetch ends it too). False the instant either a cache or a fresh fetch has
   *  produced something — including for the rest of THIS visit even while a background refetch silently
   *  updates the cache for the next one. Lets the caller render a fixed-height placeholder instead of a
   *  second, competing "instant" guess. */
  loading: boolean;
}

interface SamplesSnapshot {
  scopeKey: string;
  prompts: SamplePrompt[];
  hasCache: boolean;
}

function snapshotFor(tenantKey: string | null, role: AskRole, enabled: boolean): SamplesSnapshot {
  const scopeKey = `${tenantKey ?? ''}::${role}`;
  if (!enabled) return { scopeKey, prompts: [], hasCache: false };
  const cached = readCachedSamplePrompts(tenantKey, role);
  return { scopeKey, prompts: cached ?? [], hasCache: !!cached };
}

/**
 * Role-based sample prompts for an empty Ask screen (Round 14 K1; Round 18 P2 fix above). `tenantKey`
 * should be a stable per-tenant id (Clerk's `orgId ?? userId`, e.g.) — pass `null` while it isn't known
 * yet (auth still loading); the hook just skips the cache in that case rather than guessing wrong.
 *
 * Never shows another tenant's — or another role's — cached samples: switching either mid-session
 * (Clerk's OrganizationSwitcher, or the tech/office toggle) re-snapshots THIS scope's own cache
 * synchronously (during render, same "adjust state when a prop changes" pattern AnswerCard already uses
 * for `seenKey`) rather than waiting an extra frame on the old scope's stale value.
 */
export function useSamplePrompts(role: AskRole, enabled = true, tenantKey: string | null = null): SamplePromptsState {
  const scopeKey = `${tenantKey ?? ''}::${role}`;
  const [snap, setSnap] = useState<SamplesSnapshot>(() => snapshotFor(tenantKey, role, enabled));
  // Which scope's FIRST fetch has already come back (with prompts, empty, or failed). Without this a brand-new
  // shop (server has nothing to suggest yet), an offline phone, or a failing API left `loading` true forever:
  // a permanent pulsing skeleton under "Try asking" and the empty-state fallback below it unreachable.
  const [settledScope, setSettledScope] = useState<string | null>(null);

  if (snap.scopeKey !== scopeKey) {
    setSnap(snapshotFor(tenantKey, role, enabled));
  }

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetchSamplePrompts(role, controller.signal).then((data) => {
      if (controller.signal.aborted) return; // unmounted / scope moved on — not this scope's answer
      setSettledScope(scopeKey);
      if (!data?.prompts?.length) return; // offline/error/empty — keep showing whatever this scope already has
      writeCachedSamplePrompts(tenantKey, role, data.prompts); // silent refresh — for the NEXT visit only
      setSnap((s) => {
        // Wrong scope now (tenant/role moved on while this request was in flight), or this scope already
        // had something on screen when the request started (a cache hit) — a fresh fetch never replaces
        // what's already shown mid-view; it only ever fills a genuinely empty slot.
        if (s.scopeKey !== scopeKey || s.hasCache || s.prompts.length) return s;
        return { scopeKey, prompts: data.prompts, hasCache: false };
      });
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, enabled, scopeKey, tenantKey]);

  const prompts = enabled ? snap.prompts : [];
  return { prompts, loading: enabled && prompts.length === 0 && settledScope !== scopeKey };
}

/** "Did you mean…" chips for the question that just failed. Pass `null` to clear (a fresh question, or
 *  one that DID get an answer). */
/**
 * R24 (P0 typo tolerance, the no-risk half): when a customer name matched nobody exactly but ONE-to-
 * three similarly-spelled customers exist, the server honestly declines with
 *   I don't have a customer named "sanrda wyckoff". Did you mean Sandra Wyckoff?
 * (api/_lib/contactLookup.js buildNearMissDeclineAnswer — keep the two in sync). Auto-answering for
 * the closest name was measured to break the exam's adversarial "near-miss name" honest-zero questions
 * (a typo and a different person are indistinguishable by spelling alone), so instead this turns each
 * suggested name into a one-tap re-ask of the SAME question with the name corrected: the tech confirms
 * with one tap, and Donovan never guesses who they meant. Pure: no network, no model.
 */
const NEAR_MISS_RE = /^(?:I don't have a customer named|I couldn't match|I couldn't find) "([^"]+)"(?: exactly| as asked)?\.\s*Did you mean (.+)\?\s*$/;

/**
 * R32: an UNAMBIGUOUS typo'd customer name is now answered straight away, prefixed with
 *   Showing results for Sandra Wyckoff (you typed "sanrda wyckoff").
 * (api/_lib/lookups/typoResolve.js typoNoteText — keep the two in sync). The one-tap escape is a chip that re-asks the SAME
 * question with the typed name in quotes — the server reads a quoted name as "exactly as typed" and gives the honest
 * "I don't have a customer named ..." decline instead of resolving it again.
 */
const TYPO_NOTE_RE = /^Showing results for .+? \(you typed "([^"]+)"\)\./;

export function nearMissRetryChips(question: string | null | undefined, answerText: string | null | undefined): DidYouMeanChip[] {
  if (!question || !answerText) return [];
  const note = TYPO_NOTE_RE.exec(answerText.trim());
  if (note) {
    const typedName = note[1]!;
    const idx = question.toLowerCase().indexOf(typedName.toLowerCase());
    if (idx === -1 || question.slice(Math.max(0, idx - 1), idx) === '"') return [];
    return [{ text: `${question.slice(0, idx)}"${question.slice(idx, idx + typedName.length)}"${question.slice(idx + typedName.length)}`, heading: 'Not who you meant?' }];
  }
  const m = NEAR_MISS_RE.exec(answerText.trim());
  if (!m) return [];
  const typed = m[1]!;
  const at = question.toLowerCase().indexOf(typed.toLowerCase());
  if (at === -1) return [];
  const names = m[2]!.split(/,\s*/).map((n) => n.trim()).filter(Boolean).slice(0, 3);
  return names.map((name) => ({ text: `${question.slice(0, at)}${name}${question.slice(at + typed.length)}` }));
}

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
