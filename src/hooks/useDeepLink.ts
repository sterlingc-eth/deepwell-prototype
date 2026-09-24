/**
 * Deep links: `?entity=<id>`, `?doc=<id>`, `?screen=<id>` in the URL.
 *
 * Before this, the whole app's navigation state was one zustand string
 * (`currentScreen`) plus a couple of selected-id fields — nothing in the
 * URL, so no link, bookmark, or "send this customer to a coworker" ever
 * worked. This hook is the one-shot consumer of those query params on load;
 * `deepLinkFor` is the producer other screens use to build a link to copy.
 */
import { useEffect, useRef } from 'react';
import { useAppStore, type Screen } from '../store/appStore';
import { useGraph } from '../core/entityGraph';
import { isValidPlanId, type BillingInterval } from '../services/billingClient';
import type { WorkFilterChoice } from '../core/workFilter';

const SCREENS: readonly Screen[] = ['ask', 'records', 'ingest', 'review', 'dashboard', 'browse', 'entity', 'customer', 'warranty-export', 'billing', 'team', 'outreach'];

function isScreen(value: string): value is Screen {
  return (SCREENS as readonly string[]).includes(value);
}

export interface DeepLinkParams {
  entityId?: string;
  docId?: string;
  screen?: Screen;
  /** `?q=` — a bare question to ask immediately, e.g. a link shared from
   *  outside the app ("ask DeepWell: ..."). Needs nothing from the graph, so
   *  it never waits the way `entityId`/`docId` do. */
  question?: string;
  /** `?plan=` — a marketing-site pricing button (index.html) or Records
   *  Rescue CTA. Only a recognized plan id is accepted; an unknown value is
   *  dropped, same as an unknown `screen`. */
  plan?: string;
  /** `?interval=` — 'month' (the default) or 'year', alongside `plan`. */
  interval?: BillingInterval;
  /** `?customer=<id|C-00012>` — either a customer's uuid or its display
   *  number. Not validated here (CustomerProfileScreen resolves the ref
   *  itself, same "let the screen own its own lookup" split as `question`);
   *  only trimmed and capped so a malformed or huge value can't wedge. */
  customerRef?: string;
  /** `?equipment=<uuid>` — an equipment entity to preselect on the Outreach
   *  screen (Dashboard's "Open in Outreach" button). Only meaningful
   *  alongside `?screen=outreach`; ignored otherwise. */
  outreachEquipmentId?: string;
  /** `?work=mine` — preselect the "My work" choice on the Inbox's work
   *  filter (src/hooks/useWorkFilter.ts), overriding whatever this browser
   *  has stored for the signed-in user. Only 'mine' is recognized; any other
   *  value (or its absence) is dropped, same as an unknown `screen`. Used by
   *  a follow-up message's deep link (api/_lib/followups.js's
   *  FOLLOWUP_INBOX_LINK: `?screen=inbox&work=mine`). */
  workFilter?: WorkFilterChoice;
}

/**
 * Reads `entity` / `doc` / `screen` out of a `location.search` string. Pure —
 * takes the string, not `window`, so it is directly unit-testable.
 */
export function parseDeepLink(search: string): DeepLinkParams {
  const params = new URLSearchParams(search);
  const out: DeepLinkParams = {};
  const entity = params.get('entity');
  if (entity) out.entityId = entity;
  const doc = params.get('doc');
  if (doc) out.docId = doc;
  const screen = params.get('screen');
  // 'inbox' isn't a Screen id of its own — 'review' already is the Inbox's
  // "Needs a person" tab (setCurrentScreen in store/appStore.ts maps it to
  // {currentScreen: 'ingest', inboxTab: 'needs-person'}), so a follow-up
  // message's `?screen=inbox` link is just a friendlier spelling of it.
  if (screen === 'inbox') out.screen = 'review';
  else if (screen && isScreen(screen)) out.screen = screen;
  const work = params.get('work');
  if (work === 'mine') out.workFilter = 'mine';
  const q = params.get('q')?.trim();
  if (q) out.question = q.slice(0, 2000);
  const plan = params.get('plan');
  if (isValidPlanId(plan)) {
    out.plan = plan;
    out.interval = params.get('interval') === 'year' ? 'year' : 'month';
  }
  const customer = params.get('customer')?.trim();
  if (customer) out.customerRef = customer.slice(0, 64);
  const equipment = params.get('equipment')?.trim();
  if (equipment) out.outreachEquipmentId = equipment.slice(0, 64);
  return out;
}

/**
 * An absolute, shareable URL for one entity, document, or bare screen.
 * Unlike the hook, this has no side effects and does not wait on the graph —
 * any screen can call it straight away to offer "Copy link".
 */
export function deepLinkFor(params: DeepLinkParams): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  if (params.entityId) url.searchParams.set('entity', params.entityId);
  if (params.docId) url.searchParams.set('doc', params.docId);
  if (params.screen) url.searchParams.set('screen', params.screen);
  if (params.customerRef) url.searchParams.set('customer', params.customerRef);
  if (params.outreachEquipmentId) url.searchParams.set('equipment', params.outreachEquipmentId);
  if (params.workFilter === 'mine') url.searchParams.set('work', 'mine');
  return url.toString();
}

/**
 * Where a deep link survives an auth/org-creation round trip.
 *
 * The bug this exists to fix: a pricing CTA lands on `/app/?plan=solo&
 * interval=month`. `useDeepLink`'s effect below fires on mount — before
 * Clerk even finishes loading — applies the plan to the (in-memory) store,
 * and scrubs the address bar back to a bare `/app/`. That's fine as long as
 * nothing reloads the page. But a brand-new user's flow does reload it:
 * Clerk's OAuth sign-in and `CreateOrganization` both do a real top-level
 * navigation, away from this page and back, landing on whatever static URL
 * `signUpFallbackRedirectUrl`/`afterCreateOrganizationUrl` name — which was
 * always the bare string `"/app/"`. That reload throws away the in-memory
 * zustand store (a fresh page = a fresh JS heap) AND lands on a URL with no
 * `?plan=` to re-parse, so the chosen plan never reaches Billing.
 *
 * Fix: persist the raw query string to sessionStorage the moment the page
 * first loads (module scope below, before React even renders), and have
 * LoginScreen/OnboardingScreen read it back out to build the Clerk redirect
 * URLs so the round trip lands back on the SAME `?plan=...` URL — a fresh
 * page load that `useDeepLink` parses normally, same as the first one.
 *
 * Reviewer NO-GO (2026-09-21): an unbounded persisted copy can resurrect on
 * a completely UNRELATED later bare `/app/` visit in the same tab/session —
 * e.g. someone abandons signup, comes back an hour later via a bookmark,
 * and gets the stale plan silently re-applied to Billing. Two independent
 * guards fix that:
 *   1. Every persisted entry carries a timestamp and is only ever honored
 *      within DEEP_LINK_TTL_MS of it (`freshPersistedDeepLinkSearch` below)
 *      — long enough for the slowest realistic redirect chain, short enough
 *      to expire well within one sitting. A stale or corrupt entry is
 *      dropped outright the moment a bare load finds nothing fresh to use.
 *   2. The entry is cleared as soon as it's actually consumed — the first
 *      time `ready` (signed in with an org) goes true, see the effect in
 *      `useDeepLink` — and again from App.tsx once billing status itself
 *      confirms the plan pick is fulfilled (active/trialing), so it can't
 *      outlive its own purpose even within the TTL window.
 */
const DEEP_LINK_STORAGE_KEY = 'deepwell.pendingDeepLink';

/** A persisted deep link is only ever honored for this long after it was
 *  last seen live (module load, or a redirect landing back on the same
 *  `?plan=...` URL both refresh this clock — see the module-load persist
 *  below and `useDeepLink`'s own effect). */
export const DEEP_LINK_TTL_MS = 15 * 60 * 1000;

interface PersistedDeepLink {
  search: string;
  /** `Date.now()` when this was last (re-)persisted. */
  ts: number;
}

function hasDeepLinkParams(search: string): boolean {
  try {
    return new URLSearchParams(search).toString().length > 0;
  } catch {
    return false;
  }
}

function parsePersistedDeepLink(raw: string | null): PersistedDeepLink | null {
  if (!raw) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as PersistedDeepLink).search === 'string' &&
      typeof (obj as PersistedDeepLink).ts === 'number'
    ) {
      return obj as PersistedDeepLink;
    }
  } catch {
    /* corrupt JSON, or the pre-TTL plain-string format this replaced —
     * either way, treat as nothing persisted rather than throwing. */
  }
  return null;
}

/**
 * Pure: the persisted entry's search string, but ONLY while it's within
 * DEEP_LINK_TTL_MS of its own timestamp — otherwise `''`, exactly as if
 * nothing were persisted at all. This is the guard the 2026-09-21 reviewer
 * NO-GO asked for: without it, a signup abandoned minutes ago would
 * resurrect its `?plan=` on a later, unrelated bare `/app/` visit in the
 * same tab. Exported so scripts/verify-ui.ts can cover the TTL boundary
 * directly, with no sessionStorage/Date mocking needed.
 */
export function freshPersistedDeepLinkSearch(persistedRaw: string | null, now: number): string {
  const persisted = parsePersistedDeepLink(persistedRaw);
  if (!persisted || !hasDeepLinkParams(persisted.search)) return '';
  const age = now - persisted.ts;
  return age >= 0 && age <= DEEP_LINK_TTL_MS ? persisted.search : '';
}

function readPersistedDeepLinkRaw(): string | null {
  try {
    return window.sessionStorage.getItem(DEEP_LINK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePersistedDeepLink(search: string, now: number): void {
  try {
    window.sessionStorage.setItem(DEEP_LINK_STORAGE_KEY, JSON.stringify({ search, ts: now } satisfies PersistedDeepLink));
  } catch {
    /* no sessionStorage (private mode, locked-down profile) — the link just won't survive a redirect */
  }
}

/** Exported so App.tsx can drop it the moment billing status itself confirms
 *  the plan pick is fulfilled (active/trialing) — belt and suspenders
 *  alongside the TTL above and the `ready`-gated clear in `useDeepLink`. */
export function clearPersistedDeepLinkSearch(): void {
  try {
    window.sessionStorage.removeItem(DEEP_LINK_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Impure: this read's effective persisted search, TTL-filtered — and, as a
 * side effect, drops a stale or corrupt entry outright. A bare `/app/` load
 * with nothing fresh pending must never leave a corpse around for a LATER
 * unrelated visit to trip over (the exact scenario the reviewer flagged).
 */
function readAndPruneStalePersistedSearch(now = Date.now()): string {
  const raw = readPersistedDeepLinkRaw();
  const fresh = freshPersistedDeepLinkSearch(raw, now);
  if (!fresh && raw) clearPersistedDeepLinkSearch();
  return fresh;
}

// Runs once, at module load — i.e. the moment the page first loads, well
// before React renders anything or Clerk resolves auth. Wrapped in
// try/catch: this file is also imported by scripts/verify-ui.ts under
// plain Node, where `window` doesn't exist at all.
try {
  const initialSearch = window.location.search;
  if (hasDeepLinkParams(initialSearch)) {
    writePersistedDeepLink(initialSearch, Date.now());
  }
} catch {
  /* no window/sessionStorage — the link just won't survive a redirect */
}

/**
 * Pure: what a Clerk redirect URL (`signUpFallbackRedirectUrl`,
 * `afterCreateOrganizationUrl`, ...) should point at so a deep link survives
 * the round trip. Prefers whatever's live in the address bar right now (a
 * link opened straight at the sign-in screen still has it); falls back to
 * whatever `persistedSearch` the caller resolved (already TTL-filtered —
 * see `freshPersistedDeepLinkSearch`), since `useDeepLink`'s own effect
 * scrubs the address bar immediately on mount — by the time LoginScreen/
 * OnboardingScreen render, the live URL is usually already bare.
 */
export function resolveDeepLinkRedirectPath(liveSearch: string, persistedSearch: string): string {
  const search = hasDeepLinkParams(liveSearch) ? liveSearch : persistedSearch;
  if (!hasDeepLinkParams(search)) return '/app/';
  return `/app/${search.startsWith('?') ? search : `?${search}`}`;
}

/** Impure wrapper — call directly as a Clerk redirect-url prop value. */
export function deepLinkRedirectTarget(): string {
  let live = '';
  try {
    live = window.location.search;
  } catch {
    /* ignore */
  }
  return resolveDeepLinkRedirectPath(live, readAndPruneStalePersistedSearch());
}

function cleanUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('entity');
  url.searchParams.delete('doc');
  url.searchParams.delete('screen');
  url.searchParams.delete('q');
  url.searchParams.delete('plan');
  url.searchParams.delete('interval');
  url.searchParams.delete('customer');
  url.searchParams.delete('equipment');
  url.searchParams.delete('work');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** How long to wait for the entity graph to load before giving up on a link. */
const RETRY_BUDGET_MS = 8000;

/**
 * Consumes a deep link on mount, then scrubs it from the URL so it can never
 * re-fire on a later render or linger in a copied/bookmarked URL.
 *
 * The graph loads asynchronously (`usePostgresSync` fetches Postgres after
 * sign-in), so a link opened cold can arrive before the entity/document it
 * names exists in the store yet. Rather than failing outright, this
 * subscribes to graph updates and re-checks each time something loads, for
 * up to RETRY_BUDGET_MS — long enough for a normal sync, short enough that a
 * stale or wrong id doesn't hold the tab open indefinitely.
 *
 * Call this once, high in the tree (App.tsx), after sync is wired up — not
 * from individual screens.
 *
 * `ready` (signed in AND an org is active) gates only ONE thing: clearing
 * the sessionStorage copy `resolveDeepLinkRedirectPath` above reads from.
 * Everything else below still applies as soon as the page loads, same as
 * before — that was never the bug; losing the persisted copy to an
 * in-between redirect was.
 */
export function useDeepLink(ready: boolean): void {
  const openEntity = useAppStore((s) => s.openEntity);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const setPendingPlan = useAppStore((s) => s.setPendingPlan);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const openOutreach = useAppStore((s) => s.openOutreach);
  const setPendingWorkFilter = useAppStore((s) => s.setPendingWorkFilter);
  const setInboxCustomerScope = useAppStore((s) => s.setInboxCustomerScope);
  const handledRef = useRef(false);

  // Only once the app is actually ready to render the target screen (no more
  // redirects expected) do we drop the persisted copy — until then it needs
  // to survive however many sign-in/org-creation round trips happen first.
  useEffect(() => {
    if (ready) clearPersistedDeepLinkSearch();
  }, [ready]);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    const liveSearch = window.location.search;
    let search: string;
    if (hasDeepLinkParams(liveSearch)) {
      search = liveSearch;
      // Refresh the TTL clock on every real sighting, not just the very
      // first click — a redirect landing back on this same `?plan=...` URL
      // means the flow is still actively in progress.
      writePersistedDeepLink(liveSearch, Date.now());
    } else {
      search = readAndPruneStalePersistedSearch();
    }
    const params = parseDeepLink(search);

    // `?work=mine` (a follow-up message's deep link) applies independently of
    // which screen branch below ends up handling the rest — src/hooks/
    // useWorkFilter.ts picks this up the moment the signed-in user's id is
    // known, whichever screen mounts it.
    if (params.workFilter) setPendingWorkFilter(params.workFilter);

    // `?plan=&interval=` (a marketing-site pricing button, or the Records
    // Rescue CTA carrying just `?screen=billing`) — store the pick and land
    // on Billing. This is safe to apply immediately, signed in or not: App.tsx
    // still shows LoginScreen/OnboardingScreen ahead of any screen while
    // auth/org aren't ready, and `currentScreen` simply carries 'billing'
    // through to the moment it actually renders one — Billing opens with the
    // plan preselected the first time the app has anywhere to render it, and
    // nothing here ever calls Stripe or redirects off-app.
    if (params.plan) {
      setPendingPlan({ plan: params.plan, interval: params.interval ?? 'month' });
      setCurrentScreen('billing');
      cleanUrl();
      return;
    }

    // `?screen=inbox&customer=<id>[&doc=<id>]` — a customer profile's "Open
    // in Inbox" link (owner defect report 2026-09-22): scope the Inbox's
    // document queue to this customer instead of opening their profile. Set
    // immediately; a co-present `doc` still needs the graph-wait logic below
    // (it falls through rather than returning here) so the document itself
    // opens once it's loaded, same as any other `?doc=` link.
    if (params.customerRef && params.screen === 'review') {
      setInboxCustomerScope(params.customerRef);
      if (!params.docId) {
        setCurrentScreen('review');
        cleanUrl();
        return;
      }
    } else if (params.customerRef) {
      // ?customer= needs nothing from the graph — CustomerProfileScreen
      // fetches its own data straight from the API (customerClient), unlike
      // ?entity=/?doc= which wait on the locally-synced entity graph below.
      // Applied immediately, same as a bare ?screen=.
      openCustomer(params.customerRef);
      cleanUrl();
      return;
    }

    // ?screen=outreach[&equipment=] — needs nothing from the graph
    // (OutreachScreen fetches its own data), same as ?customer= above.
    if (params.screen === 'outreach') {
      openOutreach(params.outreachEquipmentId);
      cleanUrl();
      return;
    }

    if (!params.entityId && !params.docId && !params.screen && !params.question) return;

    // ?q= is a bare question, not a lookup — nothing to wait on the graph
    // for. `askQuestion` prefills and submits the Ask box itself (the same
    // path every "Ask about this" button in the app already uses), so this
    // takes priority over a co-present ?screen= — asking the question IS the
    // destination the link was for.
    if (params.question) {
      askQuestion(params.question);
      cleanUrl();
      return;
    }

    // A bare ?screen= needs nothing from the graph — apply it immediately.
    if (!params.entityId && !params.docId) {
      if (params.screen) setCurrentScreen(params.screen);
      cleanUrl();
      return;
    }

    let settled = false;

    const tryApply = (): boolean => {
      const graph = useGraph.getState();
      if (params.entityId && graph.entities[params.entityId]) {
        openEntity(params.entityId);
        return true;
      }
      if (params.docId && graph.docs[params.docId]) {
        openDocument(params.docId);
        // 'review' is a retired screen id, kept as an alias in the store
        // (setCurrentScreen) that lands on the Inbox's "Needs a person" tab
        // with this document selected — see store/appStore.ts.
        setCurrentScreen(params.screen ?? 'review');
        return true;
      }
      return false;
    };

    if (tryApply()) {
      cleanUrl();
      return;
    }

    const unsubscribe = useGraph.subscribe(() => {
      if (settled) return;
      if (tryApply()) {
        settled = true;
        unsubscribe();
        cleanUrl();
      }
    });

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      // The link never resolved (bad id, or a tenant with nothing loaded) —
      // still clean the URL so it doesn't keep retrying on every remount.
      cleanUrl();
    }, RETRY_BUDGET_MS);

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
    // Runs once, at mount, by design — see handledRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
