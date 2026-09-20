import { useEffect, useMemo, useState } from 'react';
import { Check, AlertTriangle, Link2, GitMerge, Copy, Loader2, Plus, Search, Sparkles, Trash2, UserCog } from 'lucide-react';
import { StagePill, STAGE_LABEL } from '../components/StagePill';
import { DocumentPreview } from '../components/DocumentPreview';
import { conflictDocs, entitiesOfType, gapDocs, isRequirementMet, maxStageFor, unlinkedDocs, useGraph, type GraphSnapshot } from '../core/entityGraph';
import type { Conflict, Doc, Entity, SourceRef } from '../core/types';
import { targetFor } from '../domains/hvac/intake';
import { fieldLabel, requirementLabel } from '../domains/hvac/schema';
import { groupExtractionsByUnit } from '../domains/hvac/units';
import { normalize, str } from '../core/answer';
import { customerForDocument } from '../core/customer';
import { useAppStore } from '../store/appStore';
import { deleteDocuments } from '../services/documentClient';
import { customerClient, type CustomerSummary } from '../services/customerClient';
import { loadGraphFromServer } from '../hooks/usePostgresSync';

const CURRENT_USER = 'You';

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

type Filter = 'attention' | 'gaps' | 'unlinked' | 'conflicts' | 'duplicates' | 'ready' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'attention', label: 'Needs a person' },
  { id: 'gaps', label: 'Missing info' },
  { id: 'unlinked', label: 'Needs linking' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'ready', label: 'Ready to verify' },
  { id: 'all', label: 'All' },
];
const FILTER_IDS = FILTERS.map((f) => f.id);

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
}

function matches(doc: Doc, f: Filter, sets: QueueSets): boolean {
  switch (f) {
    case 'attention': return isAttention(doc);
    case 'gaps': return sets.gaps.has(doc.id);
    case 'unlinked': return sets.unlinked.has(doc.id);
    case 'conflicts': return sets.conflicts.has(doc.id);
    case 'duplicates': return doc.issues.some((i) => i.kind === 'duplicate');
    case 'ready': return doc.stage === 'linked' && doc.issues.length === 0;
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
function LinkedCustomerSection({ doc, current, isDemo, suggestedName }: { doc: Doc; current: Entity | null; isDemo: boolean; suggestedName: string | null }) {
  const hasCustomerFacts = doc.extracted.some(
    (f) => (f.name === 'customer_name' || f.name === 'service_address') && (f.correctedValue ?? f.value).trim()
  );
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
      {!isDemo && !open && !current && suggestedName && (
        <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5" disabled={suggestBusy} onClick={() => void linkToSuggested()}>
          {suggestBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <UserCog className="w-4 h-4" aria-hidden="true" />} Link to {suggestedName}
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

/**
 * The Inbox's "Needs a person" tab. A person resolves what the pipeline
 * can't: required fields that are missing, documents that won't link, two
 * documents that disagree, and duplicates. Every approval writes to the
 * entity graph, so the next answer on the Ask screen reflects it.
 *
 * Rendered inside InboxScreen (which owns the AppShell + tab header) rather
 * than as its own top-level screen — see the IA note in InboxScreen.tsx.
 */
export function ReviewBody() {
  const graph = useGraph();
  const { correctField, classifyDoc, linkDoc, approveDoc, resolveConflict, mergeDuplicate, clearLastError, aiVerifyDoc, removeDoc } = useGraph();
  const lastError = useGraph((s) => s.lastError);
  const selectedDocumentId = useAppStore((s) => s.selectedDocumentId);
  const openDocument = useAppStore((s) => s.openDocument);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const pendingReviewFilter = useAppStore((s) => s.pendingReviewFilter);
  const clearPendingReviewFilter = useAppStore((s) => s.clearPendingReviewFilter);

  const [filter, setFilter] = useState<Filter>('attention');
  const [preview, setPreview] = useState<SourceRef | null>(null);

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
  const sets = useMemo<QueueSets>(
    () => queueSetsFor(graph),
    [graph],
  );

  const queue = useMemo(
    () => Object.values(graph.docs).filter((d) => matches(d, filter, sets)).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()),
    [graph.docs, filter, sets],
  );
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, Object.values(graph.docs).filter((d) => matches(d, f.id, sets)).length])) as Record<Filter, number>, [graph.docs, sets]);

  const doc = selectedDocumentId ? graph.docs[selectedDocumentId] : undefined;
  useEffect(() => {
    if (!doc && queue[0]) openDocument(queue[0].id);
  }, [doc, queue, openDocument]);

  // If the selected doc came from a deep link, switch to a filter that shows it
  useEffect(() => {
    if (doc && !matches(doc, filter, sets)) setFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  return (
    <>
      <div className="space-y-6">
        {REVIEW_IS_DEMO_ONLY && (
          <div
            role="status"
            className="rounded-lg border border-line bg-surface-2 p-3 flex items-start gap-2"
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

        <div role="tablist" aria-label="Queue filters" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={['dw-btn !min-h-[40px] !py-1.5 !px-3 text-body-lg', filter === f.id ? 'bg-forest-700 text-stone-0 dark:bg-brass-300 dark:text-forest-950' : 'bg-surface border border-line text-ink-2 hover:bg-surface-2'].join(' ')}
            >
              {f.label} <span className="font-mono text-caption opacity-80">{counts[f.id]}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6 items-start">
          <ul className="min-w-0 divide-y divide-line border border-line rounded-lg bg-surface" aria-label="Documents in queue">
            {queue.map((d) => {
              const typeLabel = graph.schema.documentTypes.find((t) => t.id === d.typeId)?.label ?? 'Unclassified';
              const active = d.id === doc?.id;
              return (
                <li key={d.id}>
                  <button type="button" onClick={() => openDocument(d.id)} aria-current={active ? 'true' : undefined} className={['w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch transition-colors duration-quick', active ? 'bg-forest-50 dark:bg-forest-800' : 'hover:bg-surface-2'].join(' ')}>
                    <StagePill stage={d.stage} compact />
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-data text-ink truncate">{d.filename}</span>
                      <span className="block text-body text-ink-3">{typeLabel}</span>
                    </span>
                    {d.issues.length > 0 && <span className="dw-pill-warn shrink-0">{d.issues.length}</span>}
                  </button>
                </li>
              );
            })}
            {queue.length === 0 && (
              <li className="px-4 py-8 text-center">
                <Check className="w-6 h-6 text-ok mx-auto" aria-hidden="true" />
                <p className="mt-2 text-ink-2">Nothing here. The queue is clear.</p>
              </li>
            )}
          </ul>

          {doc ? (
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
          ) : (
            <div className="dw-card p-8 text-ink-3">Nothing needs you right now — new uploads will show up here.</div>
          )}
        </div>
      </div>
      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
    </>
  );
}

/** One group's rows (shared fields, or one unit's fields) — factored out of
 *  DocPanel so grouping by unit (owner request 2026-09-20, item 4) doesn't
 *  duplicate this markup per group. */
function FieldRows({ fields, onCorrect }: { fields: Doc['extracted']; onCorrect: (fieldName: string, value: string) => void }) {
  return (
    <ul className="divide-y divide-line border border-line rounded-lg">
      {fields.map((f) => {
        const value = f.correctedValue ?? f.value;
        const low = f.confidence < 0.85;
        return (
          <li key={f.name} className="px-3 py-2.5 grid sm:grid-cols-[minmax(120px,30%)_1fr] gap-x-4 gap-y-1 items-center">
            <div>
              <p className="text-body text-ink-3">{fieldLabel(f.name)}</p>
              <p className={`text-caption ${low ? 'text-warn-ink dark:text-brass-200' : 'text-ink-3'}`}>{Math.round(f.confidence * 100)}% confidence{f.correctedBy ? ` · corrected by ${f.correctedBy}` : ''}</p>
            </div>
            <div className="flex gap-2">
              <label className="sr-only" htmlFor={`field-${f.name}`}>{f.name}</label>
              <input
                id={`field-${f.name}`}
                className={`dw-input !min-h-[44px] font-mono text-data ${low ? 'border-warn' : ''}`}
                defaultValue={value}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== value) onCorrect(f.name, e.target.value.trim()); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
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
    setAiMsg(verified ? 'Verified by AI.' : 'Not confident enough yet — this still needs a person.');
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

  const grouped = useMemo(() => groupExtractionsByUnit(doc.extracted), [doc.extracted]);
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
        <h2 className="font-mono font-semibold text-h3 break-all">{doc.filename}</h2>
        <p className="text-body text-ink-3">
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
          {confirmingDelete ? (
            <span className="flex items-center gap-2">
              <span className="text-body text-ink-2">Delete this document? This can't be undone.</span>
              <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => setConfirmingDelete(false)} disabled={deleting}>Cancel</button>
              <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5 !bg-bad hover:!bg-bad" onClick={() => void runDelete()} disabled={deleting}>{deleting ? 'Deleting…' : 'Confirm delete'}</button>
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

      {/* Duplicate */}
      {duplicate && duplicate.kind === 'duplicate' && (
        <section className="p-5 space-y-3">
          <h3 className="flex items-center gap-2 text-h4"><Copy className="w-4 h-4" aria-hidden="true" /> Duplicate</h3>
          <p className="text-ink-2">This is the same document as <span className="font-mono text-data">{graph.docs[duplicate.of]?.filename ?? duplicate.of}</span>. Merging keeps the original and drops this copy — nothing is double-counted.</p>
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
          {missing.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 space-y-3">
              <p className="flex items-center gap-2 text-warn-ink dark:text-brass-200 font-medium"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> Missing information — fill in the highlighted fields to continue.</p>
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
                  <p className="text-caption text-ink-3 mt-1 truncate">{graph.docs[cand.documentId]?.filename} · p. {cand.location.page}{cand.location.field ? ` · ${cand.location.field}` : ''}</p>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {/* Customer link — search/create, independent of the equipment/property
          link below (a document can name a customer with no serial at all). */}
      {!duplicate && doc.typeId && missing.length === 0 && (
        <LinkedCustomerSection doc={doc} current={currentCustomer} isDemo={REVIEW_IS_DEMO_ONLY} suggestedName={suggestedCustomerName} />
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
        <footer className="p-5 flex flex-wrap items-center justify-between gap-3">
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
