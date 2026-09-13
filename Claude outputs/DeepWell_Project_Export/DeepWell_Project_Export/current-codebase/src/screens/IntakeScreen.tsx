import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Plus, Upload, AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { StagePill, STAGE_LABEL } from '../components/StagePill';
import { docCountsByStage, getRecordsStore, useGraph } from '../core/entityGraph';
import { INTAKE_SOURCES, PIPELINE_STAGES, type Batch, type Doc, type IntakeSource, type PipelineStage } from '../core/types';
import { classifyByFilename, fileTypeOf, SAMPLE_UPLOADS } from '../domains/hvac/intake';
import { hvacAdapter } from '../domains/hvac/adapter';
import { newId, runIngestPipeline } from '../core/pipeline/runner';
import { useAppStore } from '../store/appStore';

const SOURCE_LABEL: Record<IntakeSource, string> = { cabinet: 'Filing cabinet', email: 'Email', drive: 'Shared drive', truck: 'Truck' };
const CURRENT_USER = 'You';

const fmt = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

/** Short label for where an in-flight upload currently sits — reuses the pipeline stage names plus a "reading"/"mapping" gloss for what's happening within `classified`/`extracted`. */
const UPLOAD_STAGE_LABEL: Record<PipelineStage, string> = {
  received: 'Reading the document…',
  classified: 'Matching fields to your records…',
  extracted: 'Linking to a record…',
  linked: 'Checking for duplicates and conflicts…',
  verified: 'Done',
};

function issueSummary(doc: Doc): string | null {
  const i = doc.issues[0];
  if (!i) return null;
  if (i.kind === 'missing-field') return i.field === 'page render' ? 'Could not be read' : `Missing ${i.field}`;
  if (i.kind === 'unlinked') return 'Not linked';
  if (i.kind === 'conflict') return 'Conflict';
  if (i.kind === 'duplicate') return 'Duplicate';
  if (i.kind === 'possible-duplicate') return 'Possible duplicate';
  if (i.kind === 'inconsistent-facet') return 'Inconsistent field';
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
  const addSampleFiles = (files: { filename: string }[]) => {
    if (!selected) return;
    receiveDocs(selected.id, files.map((f) => ({ filename: f.filename, fileType: fileTypeOf(f.filename) })));
  };
  const processReceived = () => {
    if (!selected) return;
    for (const d of batchDocs(selected)) {
      if (d.stage === 'received' && !d.issues.some((i) => i.kind === 'duplicate') && !uploadedIds.has(d.id)) classifyDoc(d.id, classifyByFilename(d.filename));
    }
  };

  // ---- Real upload: File objects → sha256 → page render → the ingestion pipeline (docs/INGEST_API.md) ----
  const [uploadingIds, setUploadingIds] = useState<string[]>([]);
  const [uploadedIds, setUploadedIds] = useState<Set<string>>(new Set());
  const [uploadTotals, setUploadTotals] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const uploadRealFiles = async (files: File[]) => {
    if (!selected || files.length === 0) return;
    const batchId = selected.id;
    const batchSource = selected.source;
    setUploadTotals((prev) => ({ done: prev?.done ?? 0, total: (prev?.total ?? 0) + files.length }));
    for (const file of files) {
      const documentId = newId('doc');
      const store = getRecordsStore();
      useGraph.setState((s) => {
        const batch = s.batches[batchId];
        if (!batch) return s;
        const nextBatch: Batch = { ...batch, documentIds: [...batch.documentIds, documentId] };
        void store.put('batches', nextBatch);
        return { batches: { ...s.batches, [batchId]: nextBatch } };
      });
      setUploadingIds((ids) => [...ids, documentId]);
      setUploadedIds((ids) => new Set(ids).add(documentId));
      try {
        const bytes = await file.arrayBuffer();
        await runIngestPipeline({ documentId, filename: file.name, fileType: fileTypeOf(file.name), bytes, batchId, source: batchSource }, hvacAdapter, store);
      } catch {
        useGraph.getState().applyPipelinePatch(documentId, { issues: [{ kind: 'missing-field', field: 'page render' }] });
      } finally {
        setUploadingIds((ids) => ids.filter((id) => id !== documentId));
        setUploadTotals((prev) => (prev ? { done: prev.done + 1, total: prev.total } : prev));
      }
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void uploadRealFiles(files);
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
          <div className="flex flex-wrap gap-2">
            <button type="button" className="dw-btn-secondary" onClick={() => setCurrentScreen('review')}>
              Review queue
            </button>
            <button type="button" className="dw-btn-primary" onClick={() => { setShowNew(true); window.setTimeout(() => nameRef.current?.focus(), 0); }}>
              <Plus className="w-4 h-4" aria-hidden="true" /> New batch
            </button>
          </div>
        </header>

        {/* Pipeline overview */}
        <ol className="flex flex-wrap gap-2" aria-label="Pipeline">
          {PIPELINE_STAGES.map((stage, i) => (
            <li key={stage} className="dw-card px-3 py-3 relative flex-1 min-w-[7rem]">
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
                      accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.gif,.csv,.xlsx,.xls,.txt"
                      className="sr-only"
                      aria-label="Add files to batch"
                      onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void uploadRealFiles(files); e.target.value = ''; }}
                    />
                    <button type="button" className="dw-btn-secondary min-h-[40px] !py-1.5" onClick={() => fileInput.current?.click()}>
                      <Upload className="w-4 h-4" aria-hidden="true" /> Add files
                    </button>
                    <button type="button" className="dw-btn-secondary min-h-[40px] !py-1.5" onClick={() => addSampleFiles(SAMPLE_UPLOADS.map((filename) => ({ filename })))}>
                      Add sample files
                    </button>
                    {batchDocs(selected).some((d) => d.stage === 'received' && !d.issues.length && !uploadedIds.has(d.id)) && (
                      <button type="button" className="dw-btn-primary min-h-[40px] !py-1.5" onClick={processReceived}>
                        Classify received
                      </button>
                    )}
                  </div>
                </div>

                {/* Drop zone: real upload is the point, not a fallback — ING-01 */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  className={['rounded-lg border-2 border-dashed p-4 text-center transition-colors duration-quick', dragOver ? 'border-forest-700 bg-forest-50 dark:border-brass-300 dark:bg-forest-800' : 'border-line-2 text-ink-3'].join(' ')}
                >
                  <p className="text-body">Drag files here, or use “Add files” above. PDF, JPG, PNG, HEIC, CSV, XLSX.</p>
                </div>

                {uploadingIds.length > 0 && (
                  <div className="dw-card p-4 space-y-2" role="status" aria-live="polite">
                    <p className="dw-label flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      Reading your uploads{uploadTotals ? ` · ${uploadTotals.done}/${uploadTotals.total}` : ''}
                    </p>
                    <ul className="space-y-1.5">
                      {uploadingIds.map((id) => {
                        const d = graph.docs[id];
                        if (!d) return null;
                        return (
                          <li key={id} className="flex items-center gap-3 min-w-0">
                            <StagePill stage={d.stage} compact />
                            <span className="font-mono text-data text-ink truncate flex-1 min-w-0">{d.filename}</span>
                            <span className="text-caption text-ink-3 shrink-0">{UPLOAD_STAGE_LABEL[d.stage]}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
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
