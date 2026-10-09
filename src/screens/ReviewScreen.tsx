import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, AlertTriangle, ArrowLeft, Bell, Link2, GitMerge, Copy, Loader2, Plus, Search, Sparkles, Trash2, UserCog } from 'lucide-react';
import { StagePill, STAGE_LABEL } from '../components/StagePill';
import { DocumentPreview } from '../components/DocumentPreview';
import { conflictDocs, entitiesOfType, gapDocs, isRequirementMet, maxStageFor, unlinkedDocs, useGraph, type GraphSnapshot } from '../core/entityGraph';
import type { Conflict, Doc, Entity, SourceRef } from '../core/types';
import { targetFor } from '../domains/hvac/intake';
import { fieldLabel, requirementLabel } from '../domains/hvac/schema';
import { groupExtractionsByUnit } from '../domains/hvac/units';
import { normalize, str } from '../core/answer';
import { customerForDocument, matchesCustomerScope } from '../core/customer';
import { shopRecordTechnician } from '../core/shopRecords';
import { documentName, hasFriendlyName, originalFilename } from '../core/documentName';
import { useAppStore } from '../store/appStore';
import { deleteDocuments } from '../services/documentClient';
import { reviewClient } from '../services/reviewClient';
import { customerClient, type CustomerSummary, type CustomerDuplicatePair, type CustomerPossibleDuplicatePair } from '../services/customerClient';
import { loadGraphFromServer } from '../hooks/usePostgresSync';
import { useWorkFilter } from '../hooks/useWorkFilter';
import { WorkFilterControl } from '../components/WorkFilterControl';
import { FinancialStrip } from '../components/FinancialStrip';
import { financialsClient } from '../services/financialsClient';
import { FILTERS, FILTER_IDS, type Filter } from './reviewFilters';
import { needInfo, neighbourAfterRemoval, sectionsFor } from './reviewGrouping';
import { NeedsYouList, type QueueRowData } from '../components/inbox/NeedsYouList';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useCanAdmin, ASK_ADMIN_TITLE } from '../hooks/useCanAdmin';
import { AskAdminNote } from '../components/AskAdminNote';
import { baseFieldOf, futureDateNote, isUnconfirmedField, todayYmd, unconfirmedDates, visibleExtracted } from '../core/dateFlags';

const CURRENT_USER = 'You';

/** Rows drawn when the list opens, and added per "Show more" — keeps 3,000-document queues cheap. */
const LIST_INITIAL_ROWS = 100;
const LIST_STEP_ROWS = 100;

// "Hide shop records" (owner defect report 2026-09-22, item 4): a per-user,
// per-browser preference — deliberately localStorage, not a server setting,
// since it's about one person's own Inbox clutter, not a tenant policy.
const HIDE_SHOP_RECORDS_KEY = 'deepwell.hideShopRecords';
function safeGetHideShopRecords(): boolean {
  try {
    return localStorage.getItem(HIDE_SHOP_RECORDS_KEY) === '1';
  } catch {
    return false;
  }
}
function safeSetHideShopRecords(v: boolean) {
  try {
    localStorage.setItem(HIDE_SHOP_RECORDS_KEY, v ? '1' : '0');
  } catch {
    /* private window / blocked storage — the toggle still works this visit, just won't be remembered */
  }
}

// Correcting a field, classifying, linking and approving now persist for a
// real account (see src/core/entityGraph.ts, api/review.js) — the only mode
// that stays purely in-memory is the demo fixture, which has no server-side
// rows to write to in the first place. `lastError` (set by entityGraph.ts
// when one of those requests fails and the optimistic change is rolled back)
// is what tells a real account its change did NOT save; there is no more
// blanket "nothing here is saved" banner because that stopped being true.
// Optional chaining on purpose: this module is now also imported by the
// pure-function test runner (scripts/verify-ui.ts, run via tsx), where
// import.meta.env does not exist. Vite inlines it in the real build, so the
// app sees a plain string either way (see entityGraph.ts's DEMO_MODE, same
// reasoning).
const REVIEW_IS_DEMO_ONLY = import.meta.env?.VITE_DEMO_MODE === 'true';

// Filter/FILTERS live in reviewFilters.ts (round 17, InboxScreen.tsx merge —
// pure data, split out so neither this file nor InboxScreen.tsx mixes a
// component export with a plain data export — a value re-export from here
// would reintroduce exactly that, so only the type (erased at build time,
// exempt from that rule) is re-exported; InboxScreen.tsx imports the FILTERS
// array straight from reviewFilters.ts).
export type { Filter };

/** Shared with BrowseScreen.tsx's Documents-tab Stage filter, so "Needs a
 *  person" always means the exact same set of documents everywhere it's
 *  offered — never a second, slightly different definition. */
export function isAttention(doc: Doc): boolean {
  return doc.stage !== 'verified' && (doc.issues.length > 0 || doc.stage === 'received');
}

/** The id sets behind the 'gaps'/'unlinked'/'conflicts' filters, built once
 *  per graph change from entityGraph.ts's own `gapDocs`/`unlinkedDocs`/
 *  `conflictDocs` — the exact same helpers DataHealthStrip's tile counts
 *  read. Passing these into `matches` (rather than each filter re-deriving
 *  "is this doc unlinked/gappy/conflicted" from `doc.issues` on its own) is
 *  what guarantees the queue's filtered list and the Dashboard tile it was
 *  opened from always agree on what's included. */
interface QueueSets {
  unlinked: Set<string>;
  gaps: Set<string>;
  conflicts: Set<string>;
  /** Documents with a financial mismatch / low-confidence amounts (server-side list; empty when the feature is off). */
  money: Set<string>;
}

function matches(doc: Doc, f: Filter, sets: QueueSets): boolean {
  switch (f) {
    case 'attention': return isAttention(doc);
    case 'gaps': return sets.gaps.has(doc.id);
    case 'unlinked': return sets.unlinked.has(doc.id);
    case 'conflicts': return sets.conflicts.has(doc.id);
    case 'duplicates': return doc.issues.some((i) => i.kind === 'duplicate');
    case 'ready': return doc.stage === 'linked' && doc.issues.length === 0;
    case 'shop-records': return doc.typeId === 'internal';
    case 'money': return sets.money.has(doc.id);
    case 'all': return true;
  }
}

/** How many documents need a person right now — the same rule the "Needs a
 *  person" filter uses. Exported so InboxScreen's tab badge and its
 *  first-run redirect (App.tsx) don't reimplement it separately. */
export function needsPersonCount(docs: Record<string, Doc>): number {
  return Object.values(docs).filter(isAttention).length;
}

function queueSetsFor(graph: GraphSnapshot): QueueSets {
  return {
    unlinked: new Set(unlinkedDocs(graph).map((d) => d.id)),
    gaps: new Set(gapDocs(graph).map((d) => d.id)),
    conflicts: new Set(conflictDocs(graph).map((d) => d.id)),
    money: new Set<string>(),
  };
}

/** Same predicate the on-screen filter buttons use, exposed for verify-ui.ts
 *  so it can assert this queue and DataHealthStrip's tile counts can never
 *  disagree — both read `unlinkedDocs`/`gapDocs`/`conflictDocs` from
 *  entityGraph.ts, never their own re-derived notion of "unlinked". */
export function docsMatchingFilter(graph: GraphSnapshot, f: Filter): Doc[] {
  const sets = queueSetsFor(graph);
  return Object.values(graph.docs).filter((d) => matches(d, f, sets));
}

function entityLabel(e: Entity): string {
  switch (e.type) {
    case 'property': return `${str(e, 'address')} — ${str(e, 'customerName')}`;
    case 'equipment': return `${str(e, 'serial')} · ${str(e, 'manufacturer')} ${str(e, 'model')}`;
    default: return str(e, 'name') || str(e, 'workPerformed') || e.id;
  }
}

// customerEntityFor moved to src/core/customer.ts (customerForDocument):
// this used to check only a direct link, missing the linked-unit fallback
// BrowseScreen's customerFor already had — a document linked to its
// equipment but not (yet) directly to the customer showed "Not linked to a
// customer yet" here while Browse showed the right name for the same row
// (handoffs/LINKING_ROOT_CAUSE_2026-09-20.md).

/**
 * "Linked to" for a customer replaces the old equipment-only "Record to
 * link" for serial-less documents (invoices, warranty cards without a
 * scanned unit) — handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md section E.
 * Search existing customers or create one inline; either path calls
 * assignDocumentCustomer, then reloads the graph so `doc.linkedEntityIds`
 * reflects the new link the same way AI-verify's reload already does.
 * Disabled in demo mode — there is no backend customer API to call there
 * (same gate DashboardScreen's warranty-attention fetch uses).
 */
function LinkedCustomerSection({ doc, current, isDemo, suggestedName, reminderCustomerName }: { doc: Doc; current: Entity | null; isDemo: boolean; suggestedName: string | null; reminderCustomerName: string | null }) {
  const hasCustomerFacts = doc.extracted.some(
    (f) => (f.name === 'customer_name' || f.name === 'service_address') && (f.correctedValue ?? f.value).trim()
  );
  // Limit-test defect D (2026-09-20): this doc was linked by name alone and
  // that surname now matches 2+ customers — see usePostgresSync.ts's
  // addAmbiguousNameLinkIssues for how this issue is computed.
  const ambiguous = doc.issues.find((i): i is Extract<typeof i, { kind: 'ambiguous-name-link' }> => i.kind === 'ambiguous-name-link');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [suggestBusy, setSuggestBusy] = useState(false);

  useEffect(() => {
    if (!open || isDemo) return;
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(() => {
      void customerClient
        .list({ q: query.trim() || undefined, sort: 'name', limit: 20 })
        .then((rows) => { if (!cancelled) setResults(rows); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [open, query, isDemo]);

  const assign = async (customerId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await customerClient.assignDocument(doc.id, customerId);
      await loadGraphFromServer();
      setOpen(false);
      setQuery('');
      setNewName('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not change the customer.');
    } finally {
      setBusy(false);
    }
  };

  const createAndAssign = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { customer } = await customerClient.create({ name: newName.trim() });
      await assign(customer.id as string);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create that customer.');
      setBusy(false);
    }
  };

  /** One-click "Link to <name>" when the document has a customer_name
   *  extraction and isn't linked yet (owner request 2026-09-20, item 4).
   *  Same exact-normalized-name match rule DashboardScreen's viewCustomer
   *  uses, so this never guesses a fuzzy match into the wrong customer — no
   *  match found just opens the existing search box prefilled instead. */
  const linkToSuggested = async () => {
    if (!suggestedName) return;
    setSuggestBusy(true);
    setErr(null);
    try {
      const rows = await customerClient.list({ q: suggestedName, sort: 'name', limit: 5 });
      const match = rows.find((r) => r.name && normalize(r.name) === normalize(suggestedName));
      if (match) {
        await assign(match.id);
      } else {
        setQuery(suggestedName);
        setOpen(true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not search for that customer.');
    } finally {
      setSuggestBusy(false);
    }
  };

  /** One-click "Create customer <name> and attach" (CUSTOMER REMINDERS build,
   *  2026-09-22): a memo naming someone only in its reminder text, with no
   *  customer_name extraction for the suggestion above to key off. Reuses
   *  createCustomerAndAttachReminder's own fuzzy match — see its doc comment
   *  — so this never creates a duplicate; an ambiguous match reopens the
   *  search box prefilled instead of guessing. */
  const [reminderCreateBusy, setReminderCreateBusy] = useState(false);
  const createAndAttachReminder = async () => {
    if (!reminderCustomerName) return;
    setReminderCreateBusy(true);
    setErr(null);
    try {
      const result = await customerClient.createAndAttachReminder(doc.id, reminderCustomerName);
      if (result.ambiguous) {
        setQuery(reminderCustomerName);
        setOpen(true);
        setErr(`Found ${result.candidates?.length ?? 0} possible matches for "${reminderCustomerName}" — pick one below.`);
      } else {
        await loadGraphFromServer();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create that customer.');
    } finally {
      setReminderCreateBusy(false);
    }
  };

  return (
    <section className="p-5 space-y-3">
      <h3 className="flex items-center gap-2 text-h4"><UserCog className="w-4 h-4" aria-hidden="true" /> Customer</h3>
      <p className="text-ink-2">
        {current
          ? (str(current, 'customer_name') || str(current, 'name') || 'Unnamed')
          : hasCustomerFacts
            // A real bug (should have auto-linked — see integrityFixDocument),
            // not a task the document itself is missing: say so plainly and
            // point at the one-click fix rather than a bare "not linked".
            ? 'Names a customer but hasn’t linked yet — use the suggestion below or search.'
            : 'This document doesn’t state a customer or service address.'}
      </p>
      {ambiguous && (
        <p role="alert" className="flex items-center gap-1 text-caption text-warn-ink dark:text-brass-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Two customers named {ambiguous.surname.charAt(0).toUpperCase() + ambiguous.surname.slice(1)} — confirm which one below.
        </p>
      )}
      {!isDemo && !open && !current && suggestedName && (
        <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5" disabled={suggestBusy} onClick={() => void linkToSuggested()}>
          {suggestBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <UserCog className="w-4 h-4" aria-hidden="true" />} Link to {suggestedName}
        </button>
      )}
      {!isDemo && !open && !current && !suggestedName && reminderCustomerName && (
        <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5" disabled={reminderCreateBusy} onClick={() => void createAndAttachReminder()}>
          {reminderCreateBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} Create customer {reminderCustomerName} and attach
        </button>
      )}
      {isDemo ? (
        <p className="text-caption text-ink-3">Demo data — customer profiles aren't available here.</p>
      ) : open ? (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" aria-hidden="true" />
            <label className="sr-only" htmlFor={`change-customer-search-${doc.id}`}>Search customers by name</label>
            <input
              id={`change-customer-search-${doc.id}`}
              className="dw-input !pl-9 !min-h-[40px]"
              placeholder="Search customers by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>
          {err && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{err}</p>}
          <ul className="divide-y divide-line border border-line rounded-lg max-h-48 overflow-y-auto">
            {results.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 truncate"><span className="font-mono text-caption text-ink-3 mr-2">{c.customerNumber ?? '—'}</span>{c.name ?? 'Unnamed'}</span>
                <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 shrink-0" disabled={busy} onClick={() => void assign(c.id)}>Use this</button>
              </li>
            ))}
            {!searching && results.length === 0 && <li className="px-3 py-3 text-center text-ink-3">No matches.</li>}
          </ul>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label className="sr-only" htmlFor={`new-customer-name-${doc.id}`}>New customer's name</label>
            <input
              id={`new-customer-name-${doc.id}`}
              className="dw-input !min-h-[40px] flex-1 min-w-[10rem]"
              placeholder="Or create a new customer…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="button" className="dw-btn-secondary !min-h-[40px]" disabled={!newName.trim() || busy} onClick={() => void createAndAssign()}>
              <Plus className="w-4 h-4" aria-hidden="true" /> Create &amp; link
            </button>
          </div>
          <button type="button" className="dw-btn-tertiary !min-h-[36px] !py-1" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => setOpen(true)}>
          <UserCog className="w-4 h-4" aria-hidden="true" /> Change customer…
        </button>
      )}
    </section>
  );
}

export interface ReviewBodyProps {
  /** Controlled from InboxScreen's own single chip row (round 17 merge —
   *  see its file comment) rather than owned here, so "Decisions" and these
   *  9 filters render as one row, not two stacked tab systems. */
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  /** Fires whenever this body's per-filter counts change, so the chip row
   *  that now lives in InboxScreen can show real numbers without
   *  re-deriving all of this component's own work-scope/customer-scope/
   *  money state a second time. */
  onCounts?: (counts: Record<Filter, number>) => void;
}

/**
 * The Inbox's "Needs you" flow's filtered-queue half (the other half is
 * IntakeQueuePanel's "Decisions" — see InboxScreen.tsx). A person resolves
 * what the pipeline can't: required fields that are missing, documents that
 * won't link, two documents that disagree, and duplicates. Every approval
 * writes to the entity graph, so the next answer on the Ask screen reflects
 * it.
 *
 * Rendered inside InboxScreen (which owns the AppShell + tab/chip header)
 * rather than as its own top-level screen — see the IA note in
 * InboxScreen.tsx. `filter`/`onFilterChange` are controlled by that parent
 * (round 17: used to be this component's own internal state, with its own
 * chip row rendered right here — now hoisted up so InboxScreen can put
 * "Decisions" in the same row instead of a separate tab).
 */
export function ReviewBody({ filter, onFilterChange, onCounts }: ReviewBodyProps) {
  const graph = useGraph();
  // Merging customers is admin-only on the server (api/review.js mergeCustomers); a member sees it disabled.
  const canAdmin = useCanAdmin();
  const { correctField, classifyDoc, linkDoc, approveDoc, resolveConflict, mergeDuplicate, clearLastError, aiVerifyDoc, removeDoc } = useGraph();
  const lastError = useGraph((s) => s.lastError);
  const selectedDocumentId = useAppStore((s) => s.selectedDocumentId);
  const openDocument = useAppStore((s) => s.openDocument);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const pendingReviewFilter = useAppStore((s) => s.pendingReviewFilter);
  const clearPendingReviewFilter = useAppStore((s) => s.clearPendingReviewFilter);
  const inboxCustomerScope = useAppStore((s) => s.inboxCustomerScope);
  const setInboxCustomerScope = useAppStore((s) => s.setInboxCustomerScope);
  const openCustomer = useAppStore((s) => s.openCustomer);

  const setFilter = onFilterChange;
  const [preview, setPreview] = useState<SourceRef | null>(null);

  // "Hide shop records" + technician filter (owner defect report 2026-09-22,
  // item 4). Hiding applies everywhere EXCEPT the "Shop records" tab itself
  // — that tab is where you go looking for them on purpose, toggle or not.
  const [hideShopRecords, setHideShopRecords] = useState(false);
  useEffect(() => { setHideShopRecords(safeGetHideShopRecords()); }, []);
  const toggleHideShopRecords = () => {
    setHideShopRecords((v) => {
      safeSetHideShopRecords(!v);
      return !v;
    });
  };
  const [shopTechFilter, setShopTechFilter] = useState<string | null>(null);

  // Customer-level duplicates (owner defect report 2026-09-22): a separate
  // signal from doc.issues' document-level 'duplicate' (two uploads of the
  // same file) below — these are customer RECORDS that look like the same
  // household/business, GET /api/v1/customers' `duplicates` (real, mergeable
  // pairs) and `possibleDuplicates` (same address, different name — never
  // auto-merged; see api/_lib/routes/customers.js's planPossibleDuplicates).
  // Loaded once and refreshed after a Merge or Keep separate action.
  const [customerDuplicates, setCustomerDuplicates] = useState<CustomerDuplicatePair[]>([]);
  const [customerPossibleDuplicates, setCustomerPossibleDuplicates] = useState<CustomerPossibleDuplicatePair[]>([]);
  const [customerRowsById, setCustomerRowsById] = useState<Map<string, CustomerSummary>>(new Map());
  const [customerDupErr, setCustomerDupErr] = useState<string | null>(null);
  const [customerDupBusyKey, setCustomerDupBusyKey] = useState<string | null>(null);
  const loadCustomerDuplicates = () => {
    if (REVIEW_IS_DEMO_ONLY) return;
    void customerClient
      .listFull({ sort: 'recent', limit: 200 })
      .then((data) => {
        setCustomerDuplicates(data.duplicates ?? []);
        setCustomerPossibleDuplicates(data.possibleDuplicates ?? []);
        setCustomerRowsById(new Map(data.customers.map((c) => [c.id, c])));
      })
      .catch((e) => setCustomerDupErr(e instanceof Error ? e.message : 'Could not load duplicate customers.'));
  };
  useEffect(() => {
    loadCustomerDuplicates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const customerDupCount = customerDuplicates.length + customerPossibleDuplicates.length;

  const mergeCustomerDup = async (keepId: string, dropId: string, key: string) => {
    setCustomerDupBusyKey(key);
    setCustomerDupErr(null);
    try {
      await customerClient.merge(keepId, dropId);
      loadCustomerDuplicates();
    } catch (e) {
      setCustomerDupErr(e instanceof Error ? e.message : 'Could not merge those customers.');
    } finally {
      setCustomerDupBusyKey(null);
    }
  };
  const keepCustomerDupSeparate = async (aId: string, bId: string, key: string) => {
    setCustomerDupBusyKey(key);
    setCustomerDupErr(null);
    try {
      await customerClient.keepSeparate(aId, bId);
      setCustomerPossibleDuplicates((rows) => rows.filter((r) => !(r.aId === aId && r.bId === bId)));
    } catch (e) {
      setCustomerDupErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setCustomerDupBusyKey(null);
    }
  };

  // A caller (Dashboard's data-health tiles) can ask this tab to open
  // already filtered — e.g. the "Needs linking" tile jumps here with
  // `filter: 'unlinked'` pre-selected. Consumed once, then cleared so it
  // doesn't reapply on a later, unrelated visit.
  useEffect(() => {
    if (!pendingReviewFilter) return;
    if ((FILTER_IDS as string[]).includes(pendingReviewFilter)) setFilter(pendingReviewFilter as Filter);
    clearPendingReviewFilter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReviewFilter]);

  // Built from entityGraph.ts's own helpers — see the QueueSets comment on
  // `matches` above for why this (and not a doc.issues re-derivation here)
  // is what keeps this queue and DataHealthStrip's tile counts in agreement.
  // Documents whose money numbers need a person (financials layer). Empty when the feature is off.
  const [moneyIds, setMoneyIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (REVIEW_IS_DEMO_ONLY) return;
    financialsClient.needsReview()
      .then((r) => setMoneyIds(new Set(r.enabled ? r.items.map((i) => i.documentId) : [])))
      .catch(() => setMoneyIds(new Set()));
  }, []);
  const sets = useMemo<QueueSets>(
    () => ({ ...queueSetsFor(graph), money: moneyIds }),
    [graph, moneyIds],
  );

  // "My work / Everyone" (owner brief 2026-09-21) — allDocs (not the queue
  // itself) so the default-choice rule and per-user persistence stay stable
  // no matter which FILTERS tab is active.
  const allDocsList = useMemo(() => Object.values(graph.docs), [graph.docs]);
  const work = useWorkFilter(allDocsList);
  const inWorkScope = (d: Doc) => work.choice === 'everyone' || work.isMine(d);

  // Customer scope (owner defect report 2026-09-22): arriving here from a
  // customer's profile ("Open in Inbox") used to drop you into the unscoped
  // "All" filter, 239 documents deep, with no trace of which customer you
  // came from. Set by CustomerProfileScreen's openInInbox via
  // setInboxCustomerScope; cleared by the chip's × or "Everyone's inbox".
  const scopedCustomer = inboxCustomerScope ? graph.entities[inboxCustomerScope] ?? null : null;
  const scopedCustomerName = scopedCustomer ? (str(scopedCustomer, 'customer_name') || str(scopedCustomer, 'name') || 'Unnamed') : null;
  const inCustomerScope = (d: Doc) => matchesCustomerScope(d, graph.entities, inboxCustomerScope);
  // Hiding never applies to the "Shop records" tab itself (see the state
  // comment above) — everywhere else, an internal document is excluded
  // while the toggle is on.
  const notHiddenShop = (d: Doc, f: Filter) => f === 'shop-records' || !hideShopRecords || d.typeId !== 'internal';
  const matchesTechFilter = (d: Doc, f: Filter) => f !== 'shop-records' || !shopTechFilter || shopRecordTechnician(d) === shopTechFilter;

  const queue = useMemo(
    () => Object.values(graph.docs)
      .filter((d) => matches(d, filter, sets) && inWorkScope(d) && inCustomerScope(d) && notHiddenShop(d, filter) && matchesTechFilter(d, filter))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.docs, filter, sets, work.choice, work.isMine, inboxCustomerScope, hideShopRecords, shopTechFilter],
  );
  const counts = useMemo(() => {
    const base = Object.fromEntries(
      FILTERS.map((f) => [f.id, Object.values(graph.docs).filter((d) => matches(d, f.id, sets) && inWorkScope(d) && inCustomerScope(d) && notHiddenShop(d, f.id)).length])
    ) as Record<Filter, number>;
    // The "Duplicates" chip counts customer-record duplicates too (owner
    // defect report 2026-09-22) — see customerDupCount above.
    return { ...base, duplicates: base.duplicates + customerDupCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.docs, sets, work.choice, work.isMine, customerDupCount, inboxCustomerScope, hideShopRecords]);

  useEffect(() => { onCounts?.(counts); }, [counts, onCounts]);

  // Distinct technicians named across this tenant's shop records (owner
  // defect report 2026-09-22, item 4) — the chip row above the Shop records
  // list, and what `shopTechFilter` filters by.
  const shopTechnicians = useMemo(() => {
    const names = new Set<string>();
    for (const d of Object.values(graph.docs)) {
      const t = shopRecordTechnician(d);
      if (t) names.add(t);
    }
    return [...names].sort();
  }, [graph.docs]);

  // "Find reminders" (CUSTOMER REMINDERS build, 2026-09-22): backfill for
  // documents extracted before reminder_text existed — runs on up to 20 of
  // the current queue's own documents (reviewClient.extractReminders is
  // itself capped there; the daily model budget still applies server-side).
  const [findRemindersBusy, setFindRemindersBusy] = useState(false);
  const [findRemindersMsg, setFindRemindersMsg] = useState<string | null>(null);
  const runFindReminders = async () => {
    const ids = queue.slice(0, 20).map((d) => d.id);
    if (!ids.length) return;
    setFindRemindersBusy(true);
    setFindRemindersMsg(null);
    try {
      const { changes } = await reviewClient.extractReminders(ids);
      await loadGraphFromServer();
      setFindRemindersMsg(
        changes.length ? `Found ${changes.length} reminder${changes.length === 1 ? '' : 's'}.` : 'No reminders found in these documents.'
      );
    } catch (e) {
      setFindRemindersMsg(e instanceof Error ? e.message : 'Could not check for reminders.');
    } finally {
      setFindRemindersBusy(false);
    }
  };

  // R33 (admin): "Re-check all missing fields" — every document in this view with a missing required field gets its
  // own page text re-read for it ($0, no model; api/_lib/recheck.js), in bounded batches until none are left.
  const missingQueueIds = useMemo(() => queue.filter((d) => d.issues.some((i) => i.kind === 'missing-field')).map((d) => d.id), [queue]);
  const [recheckAllBusy, setRecheckAllBusy] = useState(false);
  const [recheckAllMsg, setRecheckAllMsg] = useState<string | null>(null);
  const runRecheckAll = async () => {
    if (!missingQueueIds.length) return;
    setRecheckAllBusy(true);
    setRecheckAllMsg(null);
    try {
      let checked = 0, fixedDocs = 0, fields = 0;
      for (let i = 0; i < missingQueueIds.length; i += 100) {
        const r = await reviewClient.recheckMissing(missingQueueIds.slice(i, i + 100), 100);
        checked += r.rechecked; fixedDocs += r.filled; fields += r.fields;
      }
      try { await loadGraphFromServer(); } catch { /* keep last-good data */ }
      setRecheckAllMsg(`Re-checked ${checked} document${checked === 1 ? '' : 's'}: restored ${fields} field${fields === 1 ? '' : 's'} on ${fixedDocs}. ${Math.max(0, checked - fixedDocs)} still need a person.`);
    } catch (e) {
      setRecheckAllMsg(e instanceof Error ? e.message : 'Could not re-check these documents.');
    } finally {
      setRecheckAllBusy(false);
    }
  };

  const doc = selectedDocumentId ? graph.docs[selectedDocumentId] : undefined;

  // ---- Rows, sections and the render cap (400-3,000 documents must stay cheap) ----
  const rows = useMemo<QueueRowData[]>(() => {
    const typeById = new Map(graph.schema.documentTypes.map((t) => [t.id, t]));
    return queue.map((d) => {
      const t = d.typeId ? typeById.get(d.typeId) : undefined;
      return {
        doc: d,
        name: documentName(d),
        sub: [t?.label ?? 'Unclassified', hasFriendlyName(d) ? d.filename : null].filter(Boolean).join(' · '),
        typeLabel: t?.label ?? 'Unclassified',
        need: needInfo(d, t?.requiredFields ?? []),
        // Owner defect report (2026-09-22): visible in both "My work" and "Everyone".
        assignee: work.hasShop ? (d.uploadedBy && work.nameByUserId.get(d.uploadedBy)) || 'Teammate' : null,
        hasReminder: d.extracted.some((f) => f.name === 'reminder_text' && (f.correctedValue ?? f.value).trim()),
        technician: shopRecordTechnician(d),
      };
    });
  }, [queue, graph.schema.documentTypes, work.hasShop, work.nameByUserId]);
  const sections = useMemo(() => sectionsFor(rows, filter), [rows, filter]);
  // Keyboard / selection order is the order rows appear on screen (section by section).
  const flatIds = useMemo(() => sections.flatMap((sec) => sec.items.map((r) => r.doc.id)), [sections]);
  const [cap, setCap] = useState(LIST_INITIAL_ROWS);
  useEffect(() => { setCap(LIST_INITIAL_ROWS); }, [filter, inboxCustomerScope, shopTechFilter]);
  const activeInQueue = !!doc && flatIds.includes(doc.id);
  // Keep the selected row inside the rendered window (deep link, j/k, "next item" after a resolve).
  useEffect(() => {
    if (!doc) return;
    const at = flatIds.indexOf(doc.id);
    if (at >= 0) setCap((c) => (at >= c ? at + 1 : c));
  }, [doc?.id, flatIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Layout: desktop = list + sticky detail; phone = list, detail in a full-height sheet ----
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [sheetOpen, setSheetOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const sheetBodyRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const returnFocusId = useRef<string | null>(null);
  const savedScrollY = useRef(0);
  const [stickyTop, setStickyTop] = useState(80);
  const regionRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      // The app's pinned top bar (not the page's own <header> heading).
      const bar = [...document.querySelectorAll('header')].find((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position));
      const bottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 64;
      setStickyTop(bottom + 12);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  // Size both columns to the space actually left on screen (never below the pinned top), so the
  // detail's action bar is visible on first view without scrolling the page.
  useLayoutEffect(() => {
    let raf = 0;
    const size = () => {
      raf = 0;
      const el = regionRef.current;
      if (!el) return;
      const top = Math.max(stickyTop, el.getBoundingClientRect().top);
      el.style.setProperty('--dw-col-h', `${Math.max(360, Math.round(window.innerHeight - top - 16))}px`);
    };
    const queueSize = () => { if (!raf) raf = requestAnimationFrame(size); };
    size();
    window.addEventListener('scroll', queueSize, { passive: true });
    window.addEventListener('resize', queueSize);
    return () => { window.removeEventListener('scroll', queueSize); window.removeEventListener('resize', queueSize); if (raf) cancelAnimationFrame(raf); };
  }, [stickyTop]);

  const rowEl = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-doc-id="${CSS.escape(id)}"]`) ?? null;
  /** Scrolls only the list's own column, never the page, so the selected row is in view. */
  const keepRowInView = useCallback((id: string) => {
    const box = listRef.current;
    const el = rowEl(id);
    if (!box || !el || box.scrollHeight <= box.clientHeight) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 48; // clears the sticky section header
    if (r.top < b.top + pad) box.scrollTop -= b.top + pad - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, []);

  useEffect(() => {
    if (doc && isDesktop) keepRowInView(doc.id);
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (sheetBodyRef.current) sheetBodyRef.current.scrollTop = 0;
  }, [doc?.id, isDesktop, keepRowInView]); // eslint-disable-line react-hooks/exhaustive-deps

  // System Back closes the sheet: opening pushes one history entry, popstate closes, and the in-sheet
  // "Back to list" pops that same entry, so no stray entries are left behind.
  const pushed = useRef(false);
  const finishSheet = useCallback(() => {
    setSheetOpen(false);
    const y = savedScrollY.current;
    // Back returns to exactly where the list was (and the row you came from).
    requestAnimationFrame(() => {
      window.scrollTo(0, y);
      const id = returnFocusId.current;
      const el = id ? rowEl(id) : null;
      el?.focus({ preventScroll: true });
    });
  }, []);
  const openSheet = (id: string) => {
    returnFocusId.current = id;
    savedScrollY.current = window.scrollY;
    openDocument(id);
    if (!pushed.current) {
      try { window.history.pushState({ ...(window.history.state ?? {}), dwSheet: true }, ''); pushed.current = true; } catch { /* no history API: the Back button still works */ }
    }
    setSheetOpen(true);
  };
  const closeSheet = useCallback(() => {
    if (pushed.current) window.history.back(); // popstate below finishes the close
    else finishSheet();
  }, [finishSheet]);
  useEffect(() => {
    const onPop = () => {
      if (!pushed.current) return;
      pushed.current = false;
      finishSheet();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (pushed.current) { pushed.current = false; window.history.back(); } // leaving the screen with the sheet open
    };
  }, [finishSheet]);
  const sheetShown = sheetOpen && !isDesktop;
  useEffect(() => {
    if (!sheetShown) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    backRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="dialog"]:not([data-dw-sheet])')) closeSheet(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [sheetShown, closeSheet]);
  useEffect(() => { if (sheetOpen && (flatIds.length === 0 || isDesktop)) closeSheet(); }, [sheetOpen, flatIds.length, isDesktop, closeSheet]);

  const selectRow = (id: string) => (isDesktop ? openDocument(id) : openSheet(id));

  // ---- After a resolve (approve / merge / delete / filter no longer matches): move to the next item ----
  const prevList = useRef<{ filter: Filter; ids: string[] }>({ filter, ids: [] });
  useEffect(() => {
    const prev = prevList.current;
    prevList.current = { filter, ids: flatIds };
    if (prev.filter !== filter) return; // switching chips is handled below
    const present = new Set(flatIds);
    if (selectedDocumentId && prev.ids.includes(selectedDocumentId) && !present.has(selectedDocumentId)) {
      const next = neighbourAfterRemoval(prev.ids, present, selectedDocumentId);
      if (next) { openDocument(next); return; }
    }
    if (!doc && flatIds[0]) openDocument(flatIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatIds]);

  // Switching chips must not leave the detail pane on a document the new list
  // doesn't contain (stale pane): move to the first item of the new list.
  useEffect(() => {
    if (doc && queue.length > 0 && !queue.some((d) => d.id === doc.id) && matches(doc, filter, sets) === false) openDocument(queue[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // If the selected doc came from a deep link, switch to a filter that shows it
  useEffect(() => {
    if (doc && !matches(doc, filter, sets)) setFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  // ---- Keyboard: j / k (or arrows while the list has focus) move, Enter opens. Skipped in fields and dialogs. ----
  const kb = useRef({ flatIds, selected: doc?.id, isDesktop, sheetShown, preview: !!preview });
  kb.current = { flatIds, selected: doc?.id, isDesktop, sheetShown, preview: !!preview };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = kb.current;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || c.sheetShown || c.preview) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      const inList = !!t && !!listRef.current?.contains(t);
      let delta = 0;
      if (e.key === 'j' || (inList && e.key === 'ArrowDown')) delta = 1;
      else if (e.key === 'k' || (inList && e.key === 'ArrowUp')) delta = -1;
      else if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A' && tag !== 'SUMMARY' && c.selected) {
        e.preventDefault();
        if (c.isDesktop) detailRef.current?.focus({ preventScroll: true });
        else openSheet(c.selected);
        return;
      }
      if (!delta || c.flatIds.length === 0) return;
      e.preventDefault();
      const at = c.selected ? c.flatIds.indexOf(c.selected) : -1;
      const nextId = c.flatIds[Math.min(c.flatIds.length - 1, Math.max(0, at + delta))];
      if (!nextId || nextId === c.selected) return;
      openDocument(nextId);
      requestAnimationFrame(() => {
        const el = rowEl(nextId);
        if (inList) el?.focus({ preventScroll: true });
        if (c.isDesktop) keepRowInView(nextId);
        else el?.scrollIntoView({ block: 'nearest' });
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const docPanel = doc ? (
    <DocPanel
      key={doc.id}
      doc={doc}
      conflicts={Object.values(graph.conflicts).filter((c) => !c.resolvedValue && c.candidates.some((x) => x.documentId === doc.id))}
      onPreview={() => setPreview({ documentId: doc.id, location: { page: 1 } })}
      onCorrect={(name, value) => correctField(doc.id, name, value, CURRENT_USER, targetFor(doc, name, graph))}
      onClassify={(typeId) => classifyDoc(doc.id, typeId)}
      onLink={(entityId) => linkDoc(doc.id, entityId, CURRENT_USER)}
      onApprove={() => approveDoc(doc.id, CURRENT_USER)}
      onResolve={(conflictId, value) => resolveConflict(conflictId, value, CURRENT_USER)}
      onMerge={() => mergeDuplicate(doc.id)}
      onAsk={(q) => askQuestion(q)}
      onAiVerify={() => aiVerifyDoc(doc.id)}
      onDelete={async () => {
        await deleteDocuments([doc.id]);
        removeDoc(doc.id);
      }}
    />
  ) : null;
  const sheetPos = doc ? flatIds.indexOf(doc.id) : -1;

  return (
    <>
      <div className="space-y-3 lg:space-y-4">
        {REVIEW_IS_DEMO_ONLY && (
          <div
            role="status"
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
            <p className="text-body text-ink-2">
              <span className="font-medium">Demo data.</span>{' '}
              Corrections, links and approvals here stay in this browser tab and are lost on refresh — this is
              sample data with nothing behind it to save to.
            </p>
          </div>
        )}

        {lastError && (
          <div
            role="alert"
            className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warn-ink dark:text-brass-200" aria-hidden="true" />
            <p className="text-body text-warn-ink dark:text-brass-200 flex-1">
              <span className="font-medium">That change didn't save.</span> {lastError} The screen has been rolled
              back to what your account actually has on file.
            </p>
            <button type="button" onClick={clearLastError} className="dw-btn-tertiary !min-h-[32px] !py-1 !px-2 shrink-0">
              Dismiss
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {work.hasShop && <WorkFilterControl choice={work.choice} onChange={work.setChoice} showHint={work.showHint} />}
          <label className="inline-flex items-center gap-2 min-h-[44px] text-body text-ink-2 cursor-pointer">
            <input type="checkbox" className="w-5 h-5" checked={hideShopRecords} onChange={toggleHideShopRecords} aria-label="Hide company records" />
            Hide company records
          </label>
          {(filter === 'gaps' || filter === 'attention') && missingQueueIds.length > 0 && !REVIEW_IS_DEMO_ONLY && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="dw-btn-tertiary !min-h-[44px] !py-1.5" disabled={recheckAllBusy || !canAdmin} title={canAdmin ? undefined : ASK_ADMIN_TITLE} onClick={() => void runRecheckAll()}>
                {recheckAllBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Search className="w-4 h-4" aria-hidden="true" />} Re-check all missing fields
              </button>
              {!canAdmin && <AskAdminNote />}
            </div>
          )}
          <span className="hidden lg:inline text-caption text-ink-3 lg:ml-auto">Tip: j / k to move, Enter to open</span>
        </div>
        {recheckAllMsg && <p className="text-caption text-ink-3">{recheckAllMsg}</p>}

        {/* Filter chips: rendered by InboxScreen now, in the same row as its
            "Decisions" chip (round 17 merge) — see this file's own header
            comment and InboxScreen.tsx. */}

        {inboxCustomerScope && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="dw-pill-info inline-flex items-center gap-1.5">
              Customer: {scopedCustomerName ?? 'Unknown'}
              <button type="button" onClick={() => setInboxCustomerScope(null)} aria-label="Clear customer filter" className="hover:opacity-70">×</button>
            </span>
            <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 text-caption" onClick={() => openCustomer(inboxCustomerScope)}>
              Back to {scopedCustomerName ?? 'customer'}
            </button>
          </div>
        )}

        {filter === 'duplicates' && (customerDuplicates.length > 0 || customerPossibleDuplicates.length > 0) && (
          <div className="dw-card p-4 space-y-3 border-warn/40">
            <h3 className="flex items-center gap-2 text-h4"><Copy className="w-4 h-4 text-warn" aria-hidden="true" /> Duplicate customers</h3>
            {customerDupErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">{customerDupErr}</p>}
            <ul className="space-y-2">
              {customerDuplicates.map((p) => {
                const key = `dup-${p.keepId}-${p.dropId}`;
                const keep = customerRowsById.get(p.keepId);
                const drop = customerRowsById.get(p.dropId);
                return (
                  <li key={key} className="border border-line rounded-lg p-3 space-y-2">
                    <p className="text-body text-ink">{keep?.name ?? 'Unnamed'} <span className="text-ink-3">and</span> {drop?.name ?? 'Unnamed'}</p>
                    <p className="text-caption text-ink-3">{p.reason} · {Math.round(p.score * 100)}% match{p.tier === 'suggest' ? ' — needs your review' : ''}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1" disabled={!canAdmin || customerDupBusyKey === key} title={canAdmin ? undefined : ASK_ADMIN_TITLE} onClick={() => void mergeCustomerDup(p.keepId, p.dropId, key)}>
                        {customerDupBusyKey === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />} Merge into {keep?.name ?? 'kept record'}
                      </button>
                      {!canAdmin && <AskAdminNote />}
                    </div>
                  </li>
                );
              })}
              {customerPossibleDuplicates.map((p) => {
                const key = `possible-${p.aId}-${p.bId}`;
                const keep = customerRowsById.get(p.keepId);
                const drop = customerRowsById.get(p.dropId);
                return (
                  <li key={key} className="border border-line rounded-lg p-3 space-y-2">
                    <p className="text-body text-ink">{keep?.name ?? 'Unnamed'} <span className="text-ink-3">and</span> {drop?.name ?? 'Unnamed'}</p>
                    <p className="text-caption text-ink-3">{keep?.serviceAddress ?? drop?.serviceAddress ?? '—'} · {p.reason}</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1" disabled={!canAdmin || customerDupBusyKey === key} title={canAdmin ? undefined : ASK_ADMIN_TITLE} onClick={() => void mergeCustomerDup(p.keepId, p.dropId, key)}>
                        {customerDupBusyKey === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="w-3.5 h-3.5" aria-hidden="true" />} Merge
                      </button>
                      {!canAdmin && <AskAdminNote className="self-center" />}
                      <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1" disabled={customerDupBusyKey === key} onClick={() => void keepCustomerDupSeparate(p.aId, p.bId, key)}>
                        {customerDupBusyKey === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : 'Keep separate'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {filter === 'shop-records' && shopTechnicians.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-caption text-ink-3">Technician:</span>
            {shopTechnicians.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={shopTechFilter === name}
                onClick={() => setShopTechFilter((cur) => (cur === name ? null : name))}
                className={['dw-btn !min-h-[32px] !py-1 !px-2.5 text-caption', shopTechFilter === name ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
              >
                {name}
              </button>
            ))}
            {shopTechFilter && (
              <button type="button" className="dw-btn-tertiary !min-h-[32px] !py-1 text-caption" onClick={() => setShopTechFilter(null)}>Clear</button>
            )}
          </div>
        )}

        {filter === 'unlinked' && queue.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="dw-btn-tertiary !min-h-[40px] !py-1.5" disabled={findRemindersBusy} onClick={() => void runFindReminders()}>
              {findRemindersBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Bell className="w-4 h-4" aria-hidden="true" />} Find reminders
            </button>
            {findRemindersMsg && <span className="text-caption text-ink-3">{findRemindersMsg}</span>}
          </div>
        )}

        <div className="lg:!-mb-40">
        <div
          ref={regionRef}
          className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6 items-start lg:sticky lg:top-[var(--dw-sticky-top)]"
          style={{ ['--dw-sticky-top' as string]: `${stickyTop}px` }}
        >
          {/* Desktop: the list scrolls inside its own column and the detail stays pinned beside it,
              so picking an item far down never means scrolling back up. */}
          <div
            ref={listRef}
            data-testid="needs-list"
            className="min-w-0 border border-line rounded-lg bg-surface lg:max-h-[var(--dw-col-h)] lg:overflow-y-auto lg:overscroll-contain"
          >
            {queue.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Check className="w-6 h-6 text-ok mx-auto" aria-hidden="true" />
                <p className="mt-2 text-ink-2">Nothing here. The queue is clear.</p>
              </div>
            ) : (
              <NeedsYouList
                sections={sections}
                cap={cap}
                total={rows.length}
                activeId={activeInQueue ? doc?.id : undefined}
                fallbackFocusId={flatIds[0]}
                onSelect={selectRow}
                onShowMore={() => setCap((c) => c + LIST_STEP_ROWS)}
                step={LIST_STEP_ROWS}
              />
            )}
          </div>

          {isDesktop && (
            <div
              ref={detailRef}
              tabIndex={-1}
              data-testid="needs-detail"
              className="min-w-0 focus:outline-none lg:max-h-[var(--dw-col-h)] lg:overflow-y-auto lg:overscroll-contain"
            >
              {docPanel ?? <div className="dw-card p-8 text-ink-3">Nothing needs you right now — new uploads will show up here.</div>}
            </div>
          )}
        </div>
        {/* Slack below the pinned area so scrolling to the footer without the columns sliding under the app header. */}
        <div className="hidden lg:block h-40 pointer-events-none" aria-hidden="true" />
        </div>
      </div>
      {sheetShown && docPanel && createPortal(
        <div role="dialog" aria-modal="true" aria-label="Document details" data-dw-sheet className="fixed inset-0 z-50 flex flex-col bg-bg text-ink">
          <div className="shrink-0 flex items-center gap-3 px-3 py-2 min-h-[60px] bg-surface border-b border-line">
            <button ref={backRef} type="button" className="dw-btn-secondary !min-h-[44px]" onClick={closeSheet}>
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to list
            </button>
            {sheetPos >= 0 && <span className="ml-auto text-caption text-ink-3">{sheetPos + 1} of {flatIds.length}</span>}
          </div>
          <div ref={sheetBodyRef} className="flex-1 overflow-y-auto overscroll-contain p-3">{docPanel}</div>
        </div>,
        document.body,
      )}
      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
    </>
  );
}

/** One group's rows (shared fields, or one unit's fields) — factored out of
 *  DocPanel so grouping by unit (owner request 2026-09-20, item 4) doesn't
 *  duplicate this markup per group. */
function FieldRows({ fields, onCorrect }: { fields: Doc['extracted']; onCorrect: (fieldName: string, value: string) => void }) {
  const today = todayYmd();
  return (
    <ul className="divide-y divide-line border border-line rounded-lg">
      {fields.map((f) => {
        const value = f.correctedValue ?? f.value;
        const low = f.confidence < 0.85;
        // R33: a printed date in the future is SHOWN with a "check the year" chip, never dropped. An unconfirmed
        // far-future date (service_date_unconfirmed) is edited/confirmed as its canonical field (service_date).
        const unconfirmed = isUnconfirmedField(f.name);
        const target = baseFieldOf(f.name);
        const futureNote = futureDateNote(f.name, value, today);
        return (
          <li key={f.name} className="px-3 py-2.5 grid sm:grid-cols-[minmax(120px,30%)_1fr] gap-x-4 gap-y-1 items-center">
            <div>
              <p className="text-body text-ink-3">{fieldLabel(target)}</p>
              <p className={`text-caption ${low ? 'text-warn-ink dark:text-brass-200' : 'text-ink-3'}`}>{Math.round(f.confidence * 100)}% confidence{f.correctedBy ? ` · corrected by ${f.correctedBy}` : ''}</p>
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex gap-2">
                <label className="sr-only" htmlFor={`field-${f.name}`}>{fieldLabel(target)}</label>
                <input
                  id={`field-${f.name}`}
                  className={`dw-input !min-h-[44px] font-mono text-data ${low || futureNote ? 'border-warn' : ''}`}
                  defaultValue={value}
                  onBlur={(e) => { if (e.target.value.trim() && e.target.value !== value) onCorrect(target, e.target.value.trim()); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                {unconfirmed && (
                  <button type="button" className="dw-btn-secondary !min-h-[44px] shrink-0" onClick={() => onCorrect(target, value)}>
                    <Check className="w-4 h-4" aria-hidden="true" /> Confirm
                  </button>
                )}
              </div>
              {futureNote && (
                <p className="dw-pill-warn inline-flex items-center gap-1 text-caption" data-testid="future-date-chip">
                  <AlertTriangle className="w-3 h-3" aria-hidden="true" /> {futureNote}{unconfirmed ? ' (please confirm)' : ''}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface DocPanelProps {
  doc: Doc;
  conflicts: Conflict[];
  onPreview: () => void;
  onCorrect: (fieldName: string, value: string) => void;
  onClassify: (typeId: string) => void;
  onLink: (entityId: string) => void;
  onApprove: () => void;
  onResolve: (conflictId: string, value: string) => void;
  onMerge: () => void;
  onAsk: (q: string) => void;
  onAiVerify: () => Promise<boolean>;
  onDelete: () => Promise<void>;
}

function DocPanel({ doc, conflicts, onPreview, onCorrect, onClassify, onLink, onApprove, onResolve, onMerge, onAsk, onAiVerify, onDelete }: DocPanelProps) {
  const graph = useGraph();
  // Deleting is admin-only on the server (document-delete.js) and destructive: a member never sees the button.
  const canAdmin = useCanAdmin();
  const type = graph.schema.documentTypes.find((t) => t.id === doc.typeId);
  const present = new Set(doc.extracted.filter((f) => (f.correctedValue ?? f.value).trim()).map((f) => f.name));
  // Required fields may be `a|b` alternatives (either satisfies) — see the
  // team brief's CANONICAL REQUIRED FIELDS and core/entityGraph.ts.
  const missing = (type?.requiredFields ?? []).filter((r) => !isRequirementMet(present, r));
  const unlinked = doc.issues.find((i) => i.kind === 'unlinked');
  const duplicate = doc.issues.find((i) => i.kind === 'duplicate');
  const next = maxStageFor(doc, graph.schema);
  const canAdvance = next !== doc.stage && !duplicate;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [linkChoice, setLinkChoice] = useState<string>(unlinked?.kind === 'unlinked' && unlinked.bestGuess ? unlinked.bestGuess : '');
  // Single-flight guard lives in the graph store (entityGraph.ts's
  // aiVerifying), not component state — it's set synchronously before the
  // network call starts, so a double-click can't slip a second request in
  // before a re-render disables this button.
  const aiBusy = !!graph.aiVerifying[doc.id];
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const runAiVerify = async () => {
    setAiMsg(null);
    const verified = await onAiVerify();
    // Reload this document's truth from the server rather than trusting the
    // AI-verify response's partial payload — that's what used to leave the
    // panel showing "AI verified" and "still needs a person" at once when two
    // requests landed out of order (see entityGraph.ts's aiVerifyDoc).
    if (!REVIEW_IS_DEMO_ONLY) {
      try {
        await loadGraphFromServer();
      } catch {
        /* a reload glitch just leaves the last-good data on screen; lastError
         * from the aiVerify call itself already surfaced any real failure */
      }
    }
    // R33: say exactly what is holding the document back when it is a printed date in the future — never the
    // generic "still needs a person" for a document whose only open item is "check the year".
    const fresh = useGraph.getState().docs[doc.id] ?? doc;
    const pending = unconfirmedDates(fresh);
    setAiMsg(
      verified
        ? 'Verified by AI.'
        : pending.length
          ? `${pending.map((p) => p.note).join('; ')}. Confirm it (or fix the year) and this document can be verified.`
          : 'Not confident enough yet — this still needs a person.'
    );
  };

  // R33: "Re-check this document" — re-reads the document's own stored page text for the missing field ($0, no model).
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState<string | null>(null);
  const runRecheck = async () => {
    setRecheckBusy(true);
    setRecheckMsg(null);
    try {
      const r = await reviewClient.recheckDocument(doc.id);
      if (!REVIEW_IS_DEMO_ONLY) {
        try { await loadGraphFromServer(); } catch { /* keep last-good data on screen */ }
      }
      setRecheckMsg(
        r.filled.length
          ? `Found on the page: ${r.filled.map((f) => `${fieldLabel(baseFieldOf(f.field_key))} ${f.value}${f.flags?.includes('far_future') ? ' (in the future — please confirm)' : ''}`).join('; ')}.`
          : r.ambiguous?.length
            ? `The page prints more than one ${r.ambiguous.map((a) => fieldLabel(a.key)).join(', ')} (${r.ambiguous.flatMap((a) => a.values).join(' / ')}) — pick the right one below.`
            : 'Nothing labelled for the missing field on this document — fill it in below.'
      );
    } catch (e) {
      setRecheckMsg(e instanceof Error ? e.message : 'Could not re-check this document.');
    } finally {
      setRecheckBusy(false);
    }
  };

  const runDelete = async () => {
    setDeleting(true);
    setDeleteErr(null);
    try {
      await onDelete();
      // On success the doc disappears from the graph and the queue selects
      // the next document — this panel unmounts, so no further state to set.
    } catch (err) {
      setDeleting(false);
      setDeleteErr(err instanceof Error ? err.message : String(err));
    }
  };

  const linkOptions = useMemo(() => {
    const groups: { label: string; items: Entity[] }[] = [
      { label: 'Properties', items: entitiesOfType(graph, 'property') },
      { label: 'Equipment', items: entitiesOfType(graph, 'equipment') },
      { label: 'Technicians', items: entitiesOfType(graph, 'technician') },
    ];
    return groups;
  }, [graph]);

  /** `requirement` may be `a|b` — a manually filled gap is written to the first alternative. */
  const commit = (requirement: string) => {
    const v = (drafts[requirement] ?? '').trim();
    if (!v) return;
    onCorrect(requirement.split('|')[0] ?? requirement, v);
    setDrafts((d) => ({ ...d, [requirement]: '' }));
  };

  const linkedLabels = doc.linkedEntityIds.map((id) => graph.entities[id]).filter((e): e is Entity => !!e);

  // "Link to <name>" one-click suggestion (owner request 2026-09-20, item 4):
  // whatever the document's own customer_name extraction says, corrected
  // value wins same as everywhere else a fact is read.
  const customerNameField = doc.extracted.find((f) => f.name === 'customer_name');
  const suggestedCustomerName = customerNameField ? (customerNameField.correctedValue ?? customerNameField.value).trim() || null : null;

  // CUSTOMER REMINDERS build (2026-09-22): a memo that names someone only in
  // its reminder text (no customer_name field at all) gets its own one-click
  // "Create customer <name> and attach" instead — see LinkedCustomerSection.
  const reminderCustomerField = doc.extracted.find((f) => f.name === 'reminder_customer_name');
  const reminderCustomerName = reminderCustomerField ? (reminderCustomerField.correctedValue ?? reminderCustomerField.value).trim() || null : null;

  // R33: an unconfirmed far-future twin is hidden once its canonical field has a value (confirmed or corrected).
  const grouped = useMemo(() => groupExtractionsByUnit(visibleExtracted(doc.extracted)), [doc.extracted]);
  const pendingDates = useMemo(() => unconfirmedDates(doc), [doc]);
  const currentCustomer = customerForDocument(doc, graph.entities);
  const customerStatusLine = currentCustomer
    ? `Customer: ${str(currentCustomer, 'customer_name') || str(currentCustomer, 'name') || 'Unnamed'}`
    : 'Customer: not linked yet';

  return (
    <div className="dw-card divide-y divide-line min-w-0">
      <header className="p-5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-3">Currently:</span>
          <StagePill stage={doc.stage} ai={doc.verifiedBy === 'ai'} />
          {doc.stage !== 'verified' && next !== doc.stage && (
            <>
              <span className="text-ink-3">· Next step:</span>
              <StagePill stage={next} />
            </>
          )}
        </div>
        <h2 className="font-sans font-semibold text-h3 break-all">{documentName(doc)}</h2>
        <p className="text-body text-ink-3">
          {hasFriendlyName(doc) && <span className="font-mono">{originalFilename(doc)}</span>}
          {hasFriendlyName(doc) && ' · '}
          {graph.batches[doc.batchId]?.name} · received {doc.receivedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </p>
        {doc.verifiedBy === 'ai' && (
          <div className="rounded-lg border border-ok/40 bg-ok-bg dark:bg-forest-800 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-ok-ink dark:text-ok-bg" aria-hidden="true" />
              <p className="text-body text-ok-ink dark:text-ok-bg">
                <span className="font-medium">AI verified{doc.completeness ? ` · ${Math.round(doc.completeness.minConfidence * 100)}% confidence` : ''}.</span>{' '}
                Looks wrong? Correct a field below — that clears the AI verification and puts this back in review.
              </p>
            </div>
            {/* Why the AI accepted this: every required field, the value it
                read, and that field's confidence — so a person can see the
                basis for the verification instead of taking it on faith. */}
            {type && (
              <ul className="text-caption text-ok-ink dark:text-ok-bg divide-y divide-ok/20">
                {type.requiredFields.map((requirement) => {
                  const keys = requirement.split('|');
                  const f = doc.extracted.find((x) => keys.includes(x.name) && (x.correctedValue ?? x.value).trim());
                  return (
                    <li key={requirement} className="py-1 flex items-center justify-between gap-3">
                      <span>{requirementLabel(requirement)}</span>
                      <span className="font-mono truncate max-w-[40%]">{f ? (f.correctedValue ?? f.value) : '—'}</span>
                      <span className="shrink-0">{f ? `${Math.round(f.confidence * 100)}%` : '—'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={onPreview}>Open original</button>
          {doc.stage !== 'verified' && !duplicate && (
            <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => void runAiVerify()} disabled={aiBusy}>
              <Sparkles className="w-4 h-4" aria-hidden="true" /> {aiBusy ? 'Checking…' : 'Verify with AI'}
            </button>
          )}
          {!canAdmin ? null : confirmingDelete ? (
            <span className="flex items-center gap-2">
              <span className="text-body text-ink-2">Delete this document? This can't be undone.</span>
              <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => setConfirmingDelete(false)} disabled={deleting}>Cancel</button>
              <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5 !bg-bad hover:!bg-bad !text-stone-0" onClick={() => void runDelete()} disabled={deleting}>{deleting ? 'Deleting…' : 'Confirm delete'}</button>
            </span>
          ) : (
            <button type="button" className="dw-btn-tertiary !min-h-[40px] !py-1.5 text-bad-ink" onClick={() => setConfirmingDelete(true)}>
              <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete document
            </button>
          )}
        </div>
        {aiMsg && <p className="text-caption text-ink-3">{aiMsg}</p>}
        {deleteErr && <p role="alert" className="text-caption text-warn-ink dark:text-brass-200">Delete didn't go through: {deleteErr}</p>}
      </header>

      {/* Financials layer: printed amounts with page evidence, corrections beside originals, mismatch flags. */}
      <FinancialStrip documentId={doc.id} by={CURRENT_USER} />

      {/* Duplicate */}
      {duplicate && duplicate.kind === 'duplicate' && (
        <section className="p-5 space-y-3">
          <h3 className="flex items-center gap-2 text-h4"><Copy className="w-4 h-4" aria-hidden="true" /> Duplicate</h3>
          <p className="text-ink-2">This is the same document as <span className="font-mono text-data">{(() => { const o = graph.docs[duplicate.of]; return o ? documentName(o) : duplicate.of; })()}</span>. Merging keeps the original and drops this copy — nothing is double-counted.</p>
          <button type="button" className="dw-btn-primary" onClick={onMerge}><GitMerge className="w-4 h-4" aria-hidden="true" /> Merge into original</button>
        </section>
      )}

      {/* Classify */}
      {!duplicate && (
        <section className="p-5 space-y-3">
          <h3 className="text-h4">Document type</h3>
          <div className="flex flex-wrap gap-1.5">
            {graph.schema.documentTypes.map((t) => (
              <button key={t.id} type="button" aria-pressed={doc.typeId === t.id} onClick={() => onClassify(t.id)} className={['dw-btn !min-h-[36px] !py-1 !px-3 text-body', doc.typeId === t.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}>
                {t.label}
              </button>
            ))}
          </div>
          {type && type.requiredFields.length > 0 && <p className="text-caption text-ink-3">Requires: {type.requiredFields.map(requirementLabel).join(', ')}</p>}
        </section>
      )}

      {/* Fields */}
      {!duplicate && doc.typeId && (
        <section className="p-5 space-y-3">
          <h3 className="text-h4">Extracted fields</h3>
          {pendingDates.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-surface-2 p-3 space-y-2" role="status">
              <p className="flex items-center gap-2 text-ink-2 font-medium"><AlertTriangle className="w-4 h-4 text-warn" aria-hidden="true" /> Please confirm — this date was read from the page as printed.</p>
              {pendingDates.map((p) => (
                <div key={p.fieldKey} className="flex flex-wrap items-center gap-2">
                  <span className="text-body text-ink-2">{p.note}.</span>
                  <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => onCorrect(p.fieldKey, p.value)}>
                    <Check className="w-4 h-4" aria-hidden="true" /> Confirm {p.value}
                  </button>
                  <span className="text-caption text-ink-3">or correct it in the field below.</span>
                </div>
              ))}
            </div>
          )}
          {missing.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 space-y-3">
              <p className="flex items-center gap-2 text-warn-ink dark:text-brass-200 font-medium"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> Missing information — fill in the highlighted fields to continue.</p>
              {!REVIEW_IS_DEMO_ONLY && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" disabled={recheckBusy} onClick={() => void runRecheck()}>
                    {recheckBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Search className="w-4 h-4" aria-hidden="true" />} Re-check this document
                  </button>
                  <span className="text-caption text-ink-3">Reads the page again for the missing field. Free, no AI call.</span>
                </div>
              )}
              {recheckMsg && <p className="text-caption text-ink-2">{recheckMsg}</p>}
              {missing.map((requirement) => {
                const label = requirementLabel(requirement);
                return (
                  <div key={requirement} className="flex gap-2">
                    <label className="sr-only" htmlFor={`gap-${requirement}`}>{label}</label>
                    <input id={`gap-${requirement}`} className="dw-input !min-h-[44px]" placeholder={label} value={drafts[requirement] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [requirement]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && commit(requirement)} />
                    <button type="button" className="dw-btn-primary !min-h-[44px]" onClick={() => commit(requirement)} disabled={!(drafts[requirement] ?? '').trim()}>Add</button>
                  </div>
                );
              })}
            </div>
          )}
          {grouped.shared.length > 0 && (
            <div>
              {grouped.units.length > 0 && <p className="dw-label mb-1.5">Document details</p>}
              <FieldRows fields={grouped.shared} onCorrect={onCorrect} />
            </div>
          )}
          {grouped.units.map((u) => (
            <div key={u.unitIndex} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="dw-label">{u.label}</p>
                {u.equipmentEntityId ? (
                  <span className="dw-pill-info">Linked to equipment</span>
                ) : (
                  <span className="dw-pill-muted">Not linked to equipment yet</span>
                )}
                <span className="text-caption text-ink-3">{customerStatusLine}</span>
              </div>
              <FieldRows fields={u.fields} onCorrect={onCorrect} />
            </div>
          ))}
          {doc.extracted.length === 0 && <p className="px-3 py-4 text-ink-3">Nothing extracted yet.</p>}
        </section>
      )}

      {/* Conflicts */}
      {conflicts.map((c) => {
        const ent = graph.entities[c.entityId];
        return (
          <section key={c.id} className="p-5 space-y-3">
            <h3 className="flex items-center gap-2 text-h4"><AlertTriangle className="w-4 h-4 text-warn" aria-hidden="true" /> Two documents disagree on {c.field}</h3>
            <p className="text-ink-2">{ent ? entityLabel(ent) : c.entityId}. Pick the value your records should carry. Your choice and the time are recorded.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
              {c.candidates.map((cand) => (
                <button key={cand.documentId} type="button" onClick={() => onResolve(c.id, cand.value)} className="dw-card text-left p-3 min-w-0 hover:shadow-lift transition-shadow duration-quick">
                  <p className="font-mono font-semibold text-body-lg break-all">{cand.value}</p>
                  <p className="text-caption text-ink-3 mt-1 truncate">{(() => { const o = graph.docs[cand.documentId]; return o ? documentName(o) : undefined; })()} · p. {cand.location.page}{cand.location.field ? ` · ${cand.location.field}` : ''}</p>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {/* Customer link — search/create, independent of the equipment/property
          link below (a document can name a customer with no serial at all). */}
      {!duplicate && doc.typeId && missing.length === 0 && (
        <LinkedCustomerSection doc={doc} current={currentCustomer} isDemo={REVIEW_IS_DEMO_ONLY} suggestedName={suggestedCustomerName} reminderCustomerName={reminderCustomerName} />
      )}

      {/* Link */}
      {!duplicate && doc.typeId && missing.length === 0 && (
        <section className="p-5 space-y-3">
          <h3 className="flex items-center gap-2 text-h4"><Link2 className="w-4 h-4" aria-hidden="true" /> Linked to</h3>
          {linkedLabels.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">{linkedLabels.map((e) => <li key={e.id} className="dw-pill-info">{entityLabel(e)}</li>)}</ul>
          ) : (
            <p className="text-ink-2">Not attached to any record yet.{unlinked?.kind === 'unlinked' && unlinked.bestGuess && graph.entities[unlinked.bestGuess] ? ` Best guess (${Math.round(unlinked.confidence * 100)}%): ${entityLabel(graph.entities[unlinked.bestGuess] as Entity)}.` : ''}</p>
          )}
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="link-select">Record to link</label>
            <select id="link-select" className="dw-input !min-h-[44px]" value={linkChoice} onChange={(e) => setLinkChoice(e.target.value)}>
              <option value="">Choose a record…</option>
              {linkOptions.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((e) => <option key={e.id} value={e.id}>{entityLabel(e)}</option>)}
                </optgroup>
              ))}
            </select>
            <button type="button" className="dw-btn-secondary !min-h-[44px]" disabled={!linkChoice} onClick={() => { onLink(linkChoice); setLinkChoice(''); }}>Link</button>
          </div>
        </section>
      )}

      {/* Approve */}
      {!duplicate && (
        <footer className="sticky bottom-0 z-10 bg-surface rounded-b-lg border-t border-line p-4 flex flex-wrap items-center justify-between gap-3 shadow-[0_-6px_12px_-8px_rgba(0,0,0,0.25)]">
          <div className="text-body text-ink-3">
            <p>
              {canAdvance
                ? `Approving moves this document to ${STAGE_LABEL[next]}.`
                : doc.stage === 'verified'
                  ? `${doc.verifiedBy === 'ai' ? 'AI verified' : `Verified${doc.verifiedBy ? ` by ${doc.verifiedBy}` : ''}`}${doc.verifiedAt ? ` on ${doc.verifiedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}. Counts toward accuracy and answers.`
                  : 'Resolve the items above to advance.'}
            </p>
            {!canAdvance && doc.stage !== 'verified' && (
              <p className="text-caption text-ink-3 mt-0.5">
                Blocked: {[
                  !type ? 'choose a document type' : null,
                  missing.length ? `missing ${missing.map(requirementLabel).join(', ')}` : null,
                  type && missing.length === 0 && doc.linkedEntityIds.length === 0 ? 'not linked to a record' : null,
                  conflicts.length ? 'a value is disputed' : null,
                ].filter(Boolean).join('; ') || 'not yet ready to advance'}.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {doc.linkedEntityIds[0] && (
              <button type="button" className="dw-btn-tertiary" onClick={() => { const e = graph.entities[doc.linkedEntityIds[0] ?? '']; if (e) onAsk(e.type === 'property' ? str(e, 'address') : e.type === 'equipment' ? str(e, 'serial') : str(e, 'name')); }}>
                Ask about this record
              </button>
            )}
            <button type="button" className="dw-btn-primary" disabled={!canAdvance} onClick={onApprove}>
              <Check className="w-4 h-4" aria-hidden="true" /> {next === 'verified' ? 'Mark checked' : `Advance to ${STAGE_LABEL[next]}`}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
