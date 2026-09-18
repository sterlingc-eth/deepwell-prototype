import { useEffect, useMemo, useState } from 'react';
import { Check, AlertTriangle, Link2, GitMerge, Copy, ArrowLeft } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { StagePill, STAGE_LABEL } from '../components/StagePill';
import { DocumentPreview } from '../components/DocumentPreview';
import { entitiesOfType, maxStageFor, useGraph } from '../core/entityGraph';
import type { Conflict, Doc, Entity, SourceRef } from '../core/types';
import { targetFor } from '../domains/hvac/intake';
import { str } from '../core/answer';
import { useAppStore } from '../store/appStore';

const CURRENT_USER = 'You';

// Correcting a field, classifying, linking and approving now persist for a
// real account (see src/core/entityGraph.ts, api/review.js) — the only mode
// that stays purely in-memory is the demo fixture, which has no server-side
// rows to write to in the first place. `lastError` (set by entityGraph.ts
// when one of those requests fails and the optimistic change is rolled back)
// is what tells a real account its change did NOT save; there is no more
// blanket "nothing here is saved" banner because that stopped being true.
const REVIEW_IS_DEMO_ONLY = import.meta.env.VITE_DEMO_MODE === 'true';

type Filter = 'attention' | 'gaps' | 'unlinked' | 'conflicts' | 'duplicates' | 'ready' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'attention', label: 'Needs a person' },
  { id: 'gaps', label: 'Missing fields' },
  { id: 'unlinked', label: 'Unlinked inbox' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'ready', label: 'Ready to verify' },
  { id: 'all', label: 'All' },
];

function matches(doc: Doc, f: Filter): boolean {
  const has = (k: Doc['issues'][number]['kind']) => doc.issues.some((i) => i.kind === k);
  switch (f) {
    case 'attention': return doc.stage !== 'verified' && (doc.issues.length > 0 || doc.stage === 'received');
    case 'gaps': return has('missing-field');
    case 'unlinked': return has('unlinked') || (doc.stage === 'extracted' && doc.linkedEntityIds.length === 0);
    case 'conflicts': return has('conflict');
    case 'duplicates': return has('duplicate');
    case 'ready': return doc.stage === 'linked' && doc.issues.length === 0;
    case 'all': return true;
  }
}

function entityLabel(e: Entity): string {
  switch (e.type) {
    case 'property': return `${str(e, 'address')} — ${str(e, 'customerName')}`;
    case 'equipment': return `${str(e, 'serial')} · ${str(e, 'manufacturer')} ${str(e, 'model')}`;
    default: return str(e, 'name') || str(e, 'workPerformed') || e.id;
  }
}

/**
 * The review queue. A person resolves what the pipeline can't: required
 * fields that are missing, documents that won't link, two documents that
 * disagree, and duplicates. Every approval writes to the entity graph, so the
 * next answer on the Ask screen reflects it.
 */
export function ReviewScreen() {
  const graph = useGraph();
  const { correctField, classifyDoc, linkDoc, approveDoc, resolveConflict, mergeDuplicate, clearLastError } = useGraph();
  const lastError = useGraph((s) => s.lastError);
  const selectedDocumentId = useAppStore((s) => s.selectedDocumentId);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const askQuestion = useAppStore((s) => s.askQuestion);

  const [filter, setFilter] = useState<Filter>('attention');
  const [preview, setPreview] = useState<SourceRef | null>(null);

  const queue = useMemo(
    () => Object.values(graph.docs).filter((d) => matches(d, filter)).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()),
    [graph.docs, filter],
  );
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, Object.values(graph.docs).filter((d) => matches(d, f.id)).length])) as Record<Filter, number>, [graph.docs]);

  const doc = selectedDocumentId ? graph.docs[selectedDocumentId] : undefined;
  useEffect(() => {
    if (!doc && queue[0]) openDocument(queue[0].id);
  }, [doc, queue, openDocument]);

  // If the selected doc came from a deep link, switch to a filter that shows it
  useEffect(() => {
    if (doc && !matches(doc, filter)) setFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <button type="button" onClick={() => setCurrentScreen('ingest')} className="dw-btn-tertiary -ml-3 mb-1">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Intake
            </button>
            <h1>Review queue</h1>
            <p className="text-ink-2 mt-1">What the pipeline can't decide on its own. Zero is the target.</p>
          </div>
        </header>

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
            />
          ) : (
            <div className="dw-card p-8 text-ink-3">Select a document.</div>
          )}
        </div>
      </div>
      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
    </AppShell>
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
}

function DocPanel({ doc, conflicts, onPreview, onCorrect, onClassify, onLink, onApprove, onResolve, onMerge, onAsk }: DocPanelProps) {
  const graph = useGraph();
  const type = graph.schema.documentTypes.find((t) => t.id === doc.typeId);
  const present = new Set(doc.extracted.map((f) => f.name));
  const missing = (type?.requiredFields ?? []).filter((r) => !present.has(r) || !(doc.extracted.find((f) => f.name === r)?.correctedValue ?? doc.extracted.find((f) => f.name === r)?.value ?? '').trim());
  const unlinked = doc.issues.find((i) => i.kind === 'unlinked');
  const duplicate = doc.issues.find((i) => i.kind === 'duplicate');
  const next = maxStageFor(doc, graph.schema);
  const canAdvance = next !== doc.stage && !duplicate;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [linkChoice, setLinkChoice] = useState<string>(unlinked?.kind === 'unlinked' && unlinked.bestGuess ? unlinked.bestGuess : '');

  const linkOptions = useMemo(() => {
    const groups: { label: string; items: Entity[] }[] = [
      { label: 'Properties', items: entitiesOfType(graph, 'property') },
      { label: 'Equipment', items: entitiesOfType(graph, 'equipment') },
      { label: 'Technicians', items: entitiesOfType(graph, 'technician') },
    ];
    return groups;
  }, [graph]);

  const commit = (name: string) => {
    const v = (drafts[name] ?? '').trim();
    if (!v) return;
    onCorrect(name, v);
    setDrafts((d) => ({ ...d, [name]: '' }));
  };

  const linkedLabels = doc.linkedEntityIds.map((id) => graph.entities[id]).filter((e): e is Entity => !!e);

  return (
    <div className="dw-card divide-y divide-line min-w-0">
      <header className="p-5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StagePill stage={doc.stage} />
          <span className="text-ink-3">→ can reach</span>
          <StagePill stage={next} />
        </div>
        <h2 className="font-mono font-semibold text-h3 break-all">{doc.filename}</h2>
        <p className="text-body text-ink-3">
          {graph.batches[doc.batchId]?.name} · received {doc.receivedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={onPreview}>Open original</button>
        </div>
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
          {type && type.requiredFields.length > 0 && <p className="text-caption text-ink-3">Requires: {type.requiredFields.join(', ')}</p>}
        </section>
      )}

      {/* Fields */}
      {!duplicate && doc.typeId && (
        <section className="p-5 space-y-3">
          <h3 className="text-h4">Extracted fields</h3>
          {missing.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-bg dark:bg-forest-800 p-3 space-y-3">
              <p className="flex items-center gap-2 text-warn-ink dark:text-brass-200 font-medium"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> Blocked at Classified — required fields missing</p>
              {missing.map((name) => (
                <div key={name} className="flex gap-2">
                  <label className="sr-only" htmlFor={`gap-${name}`}>{name}</label>
                  <input id={`gap-${name}`} className="dw-input !min-h-[44px]" placeholder={name} value={drafts[name] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && commit(name)} />
                  <button type="button" className="dw-btn-primary !min-h-[44px]" onClick={() => commit(name)} disabled={!(drafts[name] ?? '').trim()}>Add</button>
                </div>
              ))}
            </div>
          )}
          <ul className="divide-y divide-line border border-line rounded-lg">
            {doc.extracted.map((f) => {
              const value = f.correctedValue ?? f.value;
              const low = f.confidence < 0.85;
              return (
                <li key={f.name} className="px-3 py-2.5 grid sm:grid-cols-[minmax(120px,30%)_1fr] gap-x-4 gap-y-1 items-center">
                  <div>
                    <p className="text-body text-ink-3">{f.name}</p>
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
            {doc.extracted.length === 0 && <li className="px-3 py-4 text-ink-3">Nothing extracted yet.</li>}
          </ul>
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
          <p className="text-body text-ink-3">
            {canAdvance
              ? `Approving moves this document to ${STAGE_LABEL[next]}.`
              : doc.stage === 'verified'
                ? `Verified${doc.verifiedBy ? ` by ${doc.verifiedBy}` : ''}${doc.verifiedAt ? ` on ${doc.verifiedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}. Counts toward accuracy and answers.`
                : 'Resolve the items above to advance.'}
          </p>
          <div className="flex gap-2">
            {doc.linkedEntityIds[0] && (
              <button type="button" className="dw-btn-tertiary" onClick={() => { const e = graph.entities[doc.linkedEntityIds[0] ?? '']; if (e) onAsk(e.type === 'property' ? str(e, 'address') : e.type === 'equipment' ? str(e, 'serial') : str(e, 'name')); }}>
                Ask about this record
              </button>
            )}
            <button type="button" className="dw-btn-primary" disabled={!canAdvance} onClick={onApprove}>
              <Check className="w-4 h-4" aria-hidden="true" /> {next === 'verified' ? 'Mark verified' : `Advance to ${STAGE_LABEL[next]}`}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
