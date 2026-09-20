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
  if (screen && isScreen(screen)) out.screen = screen;
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
  return url.toString();
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
 */
export function useDeepLink(): void {
  const openEntity = useAppStore((s) => s.openEntity);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const setPendingPlan = useAppStore((s) => s.setPendingPlan);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const openOutreach = useAppStore((s) => s.openOutreach);
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    const params = parseDeepLink(window.location.search);

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

    // ?customer= needs nothing from the graph — CustomerProfileScreen fetches
    // its own data straight from the API (customerClient), unlike ?entity=/
    // ?doc= which wait on the locally-synced entity graph below. Applied
    // immediately, same as a bare ?screen=.
    if (params.customerRef) {
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
