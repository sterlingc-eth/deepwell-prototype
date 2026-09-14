import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, Upload, AlertTriangle, ChevronRight } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { StagePill, STAGE_LABEL } from '../components/StagePill';
import { docCountsByStage, useGraph } from '../core/entityGraph';
import { INTAKE_SOURCES, PIPELINE_STAGES, type Batch, type Doc, type IntakeSource, type PipelineStage } from '../core/types';
import { classifyByFilename, fileTypeOf, SAMPLE_UPLOADS } from '../domains/hvac/intake';
import { useAppStore } from '../store/appStore';
import { ingestFiles, type IngestProgress } from '../services/ingestClient';

const SOURCE_LABEL: Record<IntakeSource, string> = { cabinet: 'Filing cabinet', email: 'Email', drive: 'Shared drive', truck: 'Truck' };
const CURRENT_USER = 'You';

const UPLOAD_LABEL: Record<IngestProgress['status'], string> = {
  hashing: 'Checking…',
  uploading: 'Uploading…',
  reading: 'Reading…',
  done: 'Read',
  error: 'Failed',
};

const fmt = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

function issueSummary(doc: Doc): string | null {
  const i = doc.issues[0];
  if (!i) return null;
  if (i.kind === 'missing-field') return `Missing ${i.field}`;
  if (i.kind === 'unlinked') return 'Not linked';
  if (i.kind === 'conflict') return 'Conflict';
  if (i.kind === 'duplicate') return 'Duplicate';
  return null;
}

/**
 * Intake is a workflow, not a drop zone. Files go into a named batch with a
 * source and a date range, then move Received → Classified → Extracted →
 * Linked → Verified. Nothing is answerable until Linked; nothing counts until
 * Verified.
 */
export function IntakeScreen() {
  const graph = useGraph();
  const createBatch = useGraph((s) => s.createBatch);
  const receiveDocs = useGraph((s) => s.receiveDocs);
  const classifyDoc = useGraph((s) => s.classifyDoc);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const batches = useMemo(() => Object.values(graph.batches).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()), [graph.batches]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const selected = batches.find((b) => b.id === selectedBatchId) ?? batches[0];
  const [showNew, setShowNew] = useState(false);
  const counts = docCountsByStage(graph);
  const total = Object.values(graph.docs).length;

  const batchDocs = (b: Batch) => b.documentIds.map((id) => graph.docs[id]).filter((d): d is Doc => !!d);
  const stageCounts = (b: Batch): Record<PipelineStage, number> => {
    const c: Record<PipelineStage, number> = { received: 0, classified: 0, extracted: 0, linked: 0, verified: 0 };
    for (const d of batchDocs(b)) c[d.stage] += 1;
    return c;
  };
  const attention = (b: Batch) => batchDocs(b).filter((d) => d.issues.length > 0 || d.stage === 'received').length;

  // ---- New batch form ----
  const [name, setName] = useState('');
  const [source, setSource] = useState<IntakeSource>('cabinet');
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const nameRef = useRef<HTMLInputElement>(null);

  const submitBatch = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = createBatch({ name: name.trim(), source, from: new Date(from), to: new Date(to), by: CURRENT_USER });
    setSelectedBatchId(id);
    setShowNew(false);
    setName('');
  };

  const fileInput = useRef<HTMLInputElement>(null);

  // Upload progress, keyed by filename. Local to this screen on purpose: it is
  // about the transfer, not about the document, and it should disappear when
  // you navigate away.
  const [uploads, setUploads] = useState<Record<string, IngestProgress>>({});
  const uploading = Object.values(uploads).some((u) => u.status !== 'done' && u.status !== 'error');

  /** Sample files have no bytes behind them — they seed the graph only. */
  const addFiles = (files: { filename: string }[]) => {
    if (!selected) return;
    receiveDocs(selected.id, files.map((f) => ({ filename: f.filename, fileType: fileTypeOf(f.filename) })));
  };

  /**
   * Real files: show them in the batch immediately so the screen responds, then
   * upload and read them in the background. The previous version kept `f.name`
   * and dropped the File itself, so nothing could ever be re-read or cited.
   */
  const uploadFiles = async (files: File[]) => {
    if (!selected || !files.length) return;
    addFiles(files.map((f) => ({ filename: f.name })));
    setUploads((prev) => {
      const next = { ...prev };
      for (const f of files) next[f.name] = { filename: f.name, status: 'hashing' };
      return next;
    });
    await ingestFiles(files, (p) => setUploads((prev) => ({ ...prev, [p.filename]: p })));
  };
  const processReceived = () => {
    if (!selected) return;
    for (const d of batchDocs(selected)) {
      if (d.stage === 'received' && !d.issues.some((i) => i.kind === 'duplicate')) classifyDoc(d.id, classifyByFilename(d.filename));
    }
  };

  const review = (docId: string) => {
    openDocument(docId);
    setCurrentScreen('review');
  };

  return (
    <AppShell>
      <div className="space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1>Intake</h1>
            <p className="text-ink-2 mt-1">Every document moves through the pipeline. Nothing can fall in.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="dw-btn-secondary" onClick={() => setCurrentScreen('review')}>
              Review queue
            </button>
            <button type="button" className="dw-btn-primary" onClick={() => { setShowNew(true); window.setTimeout(() => nameRef.current?.focus(), 0); }}>
              <Plus className="w-4 h-4" aria-hidden="true" /> New batch
            </button>
          </div>
        </header>

        {/* Pipeline overview */}
        <ol className="grid grid-cols-5 gap-2" aria-label="Pipeline">
          {PIPELINE_STAGES.map((stage, i) => (
            <li key={stage} className="dw-card px-3 py-3 relative">
              <p className="text-caption text-ink-3">{i + 1}. {STAGE_LABEL[stage]}</p>
              <p className="font-display text-h2 mt-1">{counts[stage]}</p>
              {i < PIPELINE_STAGES.length - 1 && <ChevronRight className="hidden sm:block absolute -right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-line-2" aria-hidden="true" />}
            </li>
          ))}
        </ol>
        <p className="text-caption text-ink-3 -mt-5">
          {total} documents · {counts.verified} answerable and counted · {counts.linked} answerable with “include unverified”
        </p>

        {showNew && (
          <form onSubmit={submitBatch} className="dw-card p-5 space-y-4" aria-label="New batch">
            <h2 className="text-h3">New batch</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label htmlFor="batch-name" className="dw-label block mb-1.5">Name</label>
                <input ref={nameRef} id="batch-name" className="dw-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Elm St 2019 cabinet, March invoices" required />
              </div>
              <div>
                <label htmlFor="batch-source" className="dw-label block mb-1.5">Source</label>
                <select id="batch-source" className="dw-input" value={source} onChange={(e) => setSource(e.target.value as IntakeSource)}>
                  {INTAKE_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="batch-from" className="dw-label block mb-1.5">From</label>
                  <input id="batch-from" type="date" className="dw-input" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="batch-to" className="dw-label block mb-1.5">To</label>
                  <input id="batch-to" type="date" className="dw-input" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" className="dw-btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
              <button type="submit" className="dw-btn-primary">Create batch</button>
            </div>
          </form>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6">
          {/* Batches */}
          <section aria-labelledby="batches-heading" className="space-y-2 min-w-0">
            <h2 id="batches-heading" className="dw-label">Batches · {batches.length}</h2>
            <ul className="space-y-2">
              {batches.map((b) => {
                const c = stageCounts(b);
                const n = b.documentIds.length || 1;
                const att = attention(b);
                const active = selected?.id === b.id;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedBatchId(b.id)}
                      aria-pressed={active}
                      className={['w-full text-left dw-card p-4 transition-shadow duration-quick hover:shadow-lift', active ? 'ring-2 ring-focus' : ''].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-ink truncate">{b.name}</p>
                          <p className="text-body text-ink-3">{SOURCE_LABEL[b.source]} · {fmt(b.dateRange.from)} – {fmt(b.dateRange.to)} · {b.documentIds.length} docs</p>
                        </div>
                        {att > 0 ? (
                          <span className="dw-pill-warn shrink-0"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{att} need{att === 1 ? 's' : ''} a person</span>
                        ) : (
                          <span className="dw-pill-ok shrink-0">Complete</span>
                        )}
                      </div>
                      <div className="mt-3 h-2 rounded-full overflow-hidden flex bg-surface-2" aria-hidden="true">
                        <span style={{ width: `${(c.verified / n) * 100}%` }} className="bg-ok" />
                        <span style={{ width: `${(c.linked / n) * 100}%` }} className="bg-warn" />
                        <span style={{ width: `${(c.extracted / n) * 100}%` }} className="bg-info" />
                        <span style={{ width: `${((c.classified + c.received) / n) * 100}%` }} className="bg-stone-300" />
                      </div>
                      <p className="sr-only">{PIPELINE_STAGES.map((s) => `${STAGE_LABEL[s]} ${c[s]}`).join(', ')}</p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Documents in the selected batch */}
          <section aria-labelledby="docs-heading" className="space-y-3 min-w-0">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="docs-heading" className="dw-label">In “{selected.name}”</h2>
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      className="sr-only"
                      aria-label="Add files to batch"
                      onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void uploadFiles(fs); }}
                    />
                    <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" disabled={uploading} onClick={() => fileInput.current?.click()}>
                      <Upload className="w-4 h-4" aria-hidden="true" /> {uploading ? 'Working…' : 'Add files'}
                    </button>
                    <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => addFiles(SAMPLE_UPLOADS.map((filename) => ({ filename })))}>
                      Add sample files
                    </button>
                    {batchDocs(selected).some((d) => d.stage === 'received' && !d.issues.length) && (
                      <button type="button" className="dw-btn-primary !min-h-[40px] !py-1.5" onClick={processReceived}>
                        Classify received
                      </button>
                    )}
                  </div>
                </div>
                {Object.values(uploads).length > 0 && (
                  <ul className="border border-line rounded-lg bg-surface divide-y divide-line text-sm" aria-live="polite">
                    {Object.values(uploads).map((u) => (
                      <li key={u.filename} className="flex items-center justify-between gap-3 px-4 py-2">
                        <span className="truncate min-w-0">{u.filename}</span>
                        {u.status === 'error' ? (
                          <span className="dw-pill-warn shrink-0"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{u.error}</span>
                        ) : (
                          <span className="shrink-0 text-ink-2">{UPLOAD_LABEL[u.status]}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
                  {batchDocs(selected)
                    .sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage))
                    .map((d) => {
                      const issue = issueSummary(d);
                      const typeLabel = graph.schema.documentTypes.find((t) => t.id === d.typeId)?.label ?? 'Unclassified';
                      return (
                        <li key={d.id}>
                          <button type="button" onClick={() => review(d.id)} className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                            <StagePill stage={d.stage} compact />
                            <span className="min-w-0 flex-1">
                              <span className="block font-mono text-data text-ink truncate">{d.filename}</span>
                              <span className="block text-body text-ink-3">{typeLabel}{d.linkedEntityIds.length ? ` · linked to ${d.linkedEntityIds.length}` : ''}</span>
                            </span>
                            {issue && <span className="dw-pill-warn shrink-0">{issue}</span>}
                            <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  {selected.documentIds.length === 0 && <li className="px-4 py-6 text-ink-3">No documents yet. Add files to this batch.</li>}
                </ul>
              </>
            ) : (
              <p className="text-ink-3">Create a batch to start.</p>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
