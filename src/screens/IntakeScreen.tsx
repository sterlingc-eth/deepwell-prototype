import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { localYmd } from '../core/localDate';
import { Plus, Upload, AlertTriangle, ChevronRight, X, FolderArchive, FileUp } from 'lucide-react';
import { StagePill, STAGE_LABEL } from '../components/StagePill';
import { docCountsByStage, documentTotalFor, useGraph } from '../core/entityGraph';
import { INTAKE_SOURCES, PIPELINE_STAGES, type Batch, type Doc, type IntakeSource, type PipelineStage } from '../core/types';
import { classifyByFilename, fileTypeOf, SAMPLE_UPLOADS } from '../domains/hvac/intake';
import { useAppStore } from '../store/appStore';
import { ImportProgressPanel } from '../components/intake/ImportProgressPanel';
import { ImportPrecheck } from '../components/intake/ImportPrecheck';
import { summarizePrecheck } from '../core/importPrecheck';
import { documentName, hasFriendlyName } from '../core/documentName';
import { ACCEPT_ATTRIBUTE, ACCEPTED_TYPES_SENTENCE } from '../../api/_lib/uploadTypes.js';
import { ingestFiles, STILL_PROCESSING_LINK_LABEL, STILL_PROCESSING_MESSAGE, type IngestProgress, type IngestResult } from '../services/ingestClient';
import {
  startBulkImport,
  walkZip,
  sourceFromFile,
  classifyEntry,
  summarizeProgress,
  truncateForDisplay,
  type BulkFileState,
  type WalkedFile,
} from '../services/bulkImport';

const SOURCE_LABEL: Record<IntakeSource, string> = { cabinet: 'Filing cabinet', email: 'Email', drive: 'Shared drive', truck: 'Truck' };
const CURRENT_USER = 'You';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UPLOAD_LABEL: Record<IngestProgress['status'], string> = {
  hashing: 'Checking…',
  uploading: 'Uploading…',
  reading: 'Reading…',
  queued: 'Queued…',
  pending: STILL_PROCESSING_MESSAGE,
  waiting: "Waiting for the server's rate limit…",
  done: 'Read',
  error: 'Failed',
};

const BULK_STATUS_LABEL: Record<BulkFileState['status'], string> = {
  pending: 'Waiting…',
  hashing: 'Checking…',
  uploading: 'Uploading…',
  reading: 'Reading…',
  queued: 'Queued…',
  done: 'Read',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const SKIP_REASON_LABEL: Record<NonNullable<BulkFileState['skipReason']>, string> = {
  macosx: 'macOS archive metadata',
  dotfile: 'Hidden file',
  directory: 'Folder',
  empty: 'Empty file',
  'too-large': 'Too large',
  'unsupported-type': 'Unsupported type',
  'unsafe-path': 'Unsafe file name',
  'nested-zip': 'Zip inside a zip',
  'zip-bomb': 'Zip not opened',
};

const ZIP_EXTENSION = /\.zip$/i;
const BULK_ROW_LIMIT = 200;
/** The upload list and the batch's document list show this many rows in a scrolling box; Records has every document. */
const LIST_ROW_LIMIT = 200;

function isZipFile(file: File): boolean {
  return ZIP_EXTENSION.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

const fmt = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Postgres pipeline stage a finished `IngestResult` implies, positionally
 * mapped onto the core five-stage pipeline the same way `usePostgresSync.ts`
 * maps existing documents loaded from Postgres (STAGE_MAP there) — 'mapped'
 * (fields extracted, even zero of them) -> 'extracted', 'read' (text pulled,
 * not yet mapped) -> 'classified'. `ingestFiles` never returns enough to
 * place a document at 'linked' or 'verified' — those only happen once a
 * person reviews it.
 */
function stageFromIngestResult(result: IngestResult): PipelineStage {
  if (result.fields !== undefined) return 'extracted';
  if (result.pages !== undefined) return 'classified';
  return 'received';
}

/**
 * Folds one real `ingestFiles` result onto the client-side placeholder
 * `receiveDocs` created for it. Before this, the placeholder's invented id
 * and "Received. Not yet classified." preview were the last anyone ever saw
 * of an uploaded file — `ingestFiles`' real `documentId`, page count and
 * pipeline progress were fetched and then thrown away.
 */
function patchFromIngestResult(result: IngestResult): { id?: string } & Partial<Pick<Doc, 'pages' | 'stage' | 'preview'>> {
  if (result.error) {
    // Stays at 'received' — it never got further than that — with the real
    // failure reason visible instead of the generic placeholder text.
    return { preview: `${result.filename}\n\n${result.error}` };
  }
  if (!result.documentId) return {};
  if (result.duplicate) {
    // The server matched this upload to a document it already has by
    // content hash. Point the placeholder at that real id; `reconcileIntakeDoc`
    // itself is what actually favors the existing record if one is already
    // loaded in the graph rather than overwriting it with this thinner one.
    return { id: result.documentId, preview: `${result.filename}\n\nAlready on file (matched by content).` };
  }
  return { id: result.documentId, pages: result.pages ?? 0, stage: stageFromIngestResult(result) };
}

function issueSummary(doc: Doc): string | null {
  const i = doc.issues[0];
  if (!i) return null;
  if (i.kind === 'missing-field') return `Missing ${i.field}`;
  if (i.kind === 'unlinked') return 'Not linked';
  if (i.kind === 'conflict') return 'Conflict';
  if (i.kind === 'duplicate') return 'Duplicate';
  if (i.kind === 'ambiguous-name-link') return 'Two customers share this name — confirm which one';
  return null;
}

/**
 * The Inbox's "Add files" tab. Files go into a named batch with a source and
 * a date range, then move Uploaded → Sorted → Read → Matched → Checked.
 * Nothing is answerable until Matched; nothing counts until Checked.
 *
 * Rendered inside InboxScreen (which owns the AppShell + tab header) rather
 * than as its own top-level screen — see the IA note in InboxScreen.tsx.
 */
export function IntakeBody() {
  const graph = useGraph();
  const createBatch = useGraph((s) => s.createBatch);
  const receiveDocs = useGraph((s) => s.receiveDocs);
  const classifyDoc = useGraph((s) => s.classifyDoc);
  const reclassifyDocs = useGraph((s) => s.reclassifyDocs);
  const reconcileIntakeDoc = useGraph((s) => s.reconcileIntakeDoc);
  const removeDoc = useGraph((s) => s.removeDoc);
  const openDocument = useAppStore((s) => s.openDocument);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const openInboxNeedsPerson = useAppStore((s) => s.openInboxNeedsPerson);

  const batches = useMemo(() => Object.values(graph.batches).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()), [graph.batches]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const selected = batches.find((b) => b.id === selectedBatchId) ?? batches[0];
  const [showNew, setShowNew] = useState(false);
  // R36: whole-shop totals from the server (the graph holds only the newest 500 documents plus older needs-review ones).
  const counts = docCountsByStage(graph);
  const total = documentTotalFor(graph);

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
  const [to, setTo] = useState(localYmd());
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

  // Upload progress, keyed by filename. Lives in the Zustand store (not
  // component state): the AppShell header's "Processing N of M…" indicator
  // derives from it (store/appStore.ts's `selectIngestProgress`), and
  // leaving this tab — or the whole Inbox screen — no longer resets it to
  // empty defaults or loses visibility into whether the batch finished.
  const uploads = useAppStore((s) => s.uploads);
  const setUpload = useAppStore((s) => s.setUpload);
  const seedUploads = useAppStore((s) => s.seedUploads);
  const uploading = Object.values(uploads).some((u) => u.status !== 'done' && u.status !== 'error' && u.status !== 'pending');
  // filename -> live document id, so the uploads list can show the doc's
  // real, changing pipeline stage (Read/Matched/AI verified) instead of
  // freezing on "Read" the moment the upload+read step itself finishes.
  const uploadDocIds = useAppStore((s) => s.uploadDocIds);
  const setUploadDocId = useAppStore((s) => s.setUploadDocId);
  // Registers real document ids for the header's "Processing N of M…" pill —
  // the actual polling loop lives in App.tsx, not here, so it survives
  // navigating away from Inbox mid-processing (see store/appStore.ts).
  const trackProcessingDocs = useAppStore((s) => s.trackProcessingDocs);

  // Deliberately NOT aborted on unmount (navigating to another screen, or
  // switching Inbox tabs, no longer cancels an in-flight upload — see the
  // comment on `uploads` above). Only an explicit user action (bulk import's
  // Cancel button) or the whole app unloading stops one.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
  }, []);

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
  /**
   * The batch a drop belongs to, creating one if the user hasn't made any.
   *
   * The batch form used to be a gate: name, source, and a date range before a
   * single byte could move. None of it is even sent to the server — batch
   * metadata lives only in this browser tab — so it was pure friction in front
   * of the one action this screen exists for. Now it is inferred, and anyone
   * who wants to name and organise their drops still can.
   */
  const ensureBatch = (): string => {
    if (selected) return selected.id;
    const today = new Date();
    const id = createBatch({
      name: `Uploaded ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      source: 'cabinet',
      from: today,
      to: today,
      by: CURRENT_USER,
    });
    setSelectedBatchId(id);
    return id;
  };

  // Set when an upload comes back 402 (subscription required / free preview
  // used up — see handoffs/BILLING_RULES.md) so a friendly inline banner with
  // a "See plans" button can show instead of just the per-file error text.
  const [billingNotice, setBillingNotice] = useState<{ message: string; url: string } | null>(null);

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    // A .zip on this "Add files" zone is a bulk export, not one document —
    // route it through the same importer the bulk drop zone uses instead of
    // uploading the archive itself as a single opaque file.
    if (files.some(isZipFile)) {
      await handleBulkFiles(files);
      return;
    }
    const batchId = ensureBatch();
    // Captured directly from receiveDocs (not via addFiles) because the ids
    // it returns are what ties each real ingest result back to its placeholder.
    const tempIds = receiveDocs(batchId, files.map((f) => ({ filename: f.name, fileType: fileTypeOf(f.name) })));
    seedUploads(files.map((f) => f.name));
    files.forEach((f, i) => {
      const id = tempIds[i];
      if (id) setUploadDocId(f.name, id);
    });
    const results = await ingestFiles(files, (p) => setUpload(p.filename, p), 3, abortRef.current?.signal);
    results.forEach((result, i) => {
      const tempId = tempIds[i];
      if (tempId) {
        if (result.error && !result.documentId) {
          // Never reached the server (402, offline, 5xx before a document row existed): there is no
          // document. Leaving the placeholder in the graph made the pipeline read "Uploaded N" and the
          // Inbox badge count files that were never stored; the failure row above still says why.
          removeDoc(tempId);
        } else {
          reconcileIntakeDoc(tempId, patchFromIngestResult(result));
        }
        setUploadDocId(result.filename, result.documentId ?? tempId);
      }
      if (result.documentId && !result.error) trackProcessingDocs([result.documentId]);
      if (result.error && result.billingUrl) setBillingNotice({ message: result.error, url: result.billingUrl });
    });
  };
  // ---- Bulk import: a dropped .zip export or a large multi-file selection ----
  //
  // Deliberately separate from `uploads`/`uploadFiles` above rather than
  // merged into it: that path is proven for the common case (a handful of
  // files added to a batch) and stays untouched. This one exists for the
  // scale case — thousands of files from a ServiceTitan/Jobber/Housecall Pro
  // export or a scanning vendor's delivery — where a different shape of
  // progress reporting (skip reasons, a cap on rows rendered, a cancel
  // button) actually matters.
  // bulkStates/bulkRunning/bulkNotice/bulkCancel live in the Zustand store
  // (see the comment on `uploads` above) for the same reason: this run
  // outlives whichever component instance started it, and a remounted
  // Add-files tab (or the AppShell header, deriving `selectIngestProgress`)
  // needs to see its real, current state — including a working Cancel
  // button — not a fresh set of empty defaults.
  const bulkStates = useAppStore((s) => s.bulkStates);
  const setBulkStates = useAppStore((s) => s.setBulkStates);
  const bulkRunning = useAppStore((s) => s.bulkRunning);
  const setBulkRunning = useAppStore((s) => s.setBulkRunning);
  const bulkNotice = useAppStore((s) => s.bulkNotice);
  const setBulkNotice = useAppStore((s) => s.setBulkNotice);
  const bulkCancel = useAppStore((s) => s.bulkCancel);
  const setBulkCancel = useAppStore((s) => s.setBulkCancel);
  const [dragOver, setDragOver] = useState(false);
  const bulkInput = useRef<HTMLInputElement>(null);
  const bulkReconciledRef = useRef<Set<number>>(new Set());

  const bulkSummary = useMemo(() => summarizeProgress(bulkStates), [bulkStates]);
  const { shown: shownBulkRows, hiddenCount: hiddenBulkCount } = useMemo(
    () => truncateForDisplay(bulkStates, BULK_ROW_LIMIT),
    [bulkStates]
  );

  const toSkippedState = (path: string, reason: BulkFileState['skipReason'], detail: string): BulkFileState => ({
    path,
    name: path.split('/').filter(Boolean).pop() ?? path,
    sizeBytes: 0,
    status: 'skipped',
    attempt: 0,
    skipReason: reason,
    error: detail,
  });

  const runBulkImport = (accepted: WalkedFile[], preSkipped: BulkFileState[]) => {
    setBulkStates(preSkipped);
    if (!accepted.length) {
      setBulkRunning(false);
      return;
    }
    const batchId = ensureBatch();
    // Same reason as uploadFiles: capture the placeholder ids receiveDocs
    // returns so each live BulkFileState can be folded back onto the right
    // document once its upload/read finishes.
    const tempIds = receiveDocs(batchId, accepted.map((s) => ({ filename: s.path, fileType: fileTypeOf(s.name) })));
    bulkReconciledRef.current = new Set();

    const handle = startBulkImport(
      accepted,
      { concurrency: 4, signal: abortRef.current?.signal },
      {
        onState: (states) => {
          setBulkStates([...preSkipped, ...states]);
          states.forEach((s, i) => {
            if (bulkReconciledRef.current.has(i)) return;
            const tempId = tempIds[i];
            if (!tempId) return;
            if ((s.status === 'done' || s.status === 'queued') && s.documentId) {
              bulkReconciledRef.current.add(i);
              reconcileIntakeDoc(tempId, { id: s.documentId, stage: s.status === 'done' ? 'classified' : 'received' });
              trackProcessingDocs([s.documentId]);
            } else if (s.status === 'failed' || s.status === 'cancelled') {
              bulkReconciledRef.current.add(i);
              // Same reason as the single-file path: no document row means nothing to keep counting.
              if (!s.documentId) removeDoc(tempId);
              else reconcileIntakeDoc(tempId, { preview: `${s.name}\n\n${s.error ?? (s.status === 'cancelled' ? 'Cancelled' : 'Not uploaded')}` });
            }
          });
        },
        onDailyCapReached: () => {
          setBulkNotice(
            "Today's upload limit has been reached. Uploading has stopped — the files not yet started were not attempted. Try again after the limit resets (UTC midnight)."
          );
        },
        // R35: a plan limit (monthly pages, stored documents, no active plan) ends the run with the server's own wording.
        onPlanLimitReached: (message: string) => {
          setBulkNotice(`${message} Uploading has stopped - the files not yet started were not attempted, and nothing already uploaded was lost.`);
        },
      }
    );
    setBulkCancel(handle.cancel);
    setBulkRunning(true);
    void handle.result.finally(() => setBulkRunning(false));
  };

  /**
   * A single .zip is unzipped client-side and walked for accept/skip; anything
   * else (one or many plain files, or a folder drop) is classified the same
   * way without ever going through jszip, which is only ever loaded for an
   * actual zip.
   */
  // Guided import: a bulk drop is summarized first ("Check before importing"); nothing uploads until Start import.
  const [precheck, setPrecheck] = useState<{ accepted: WalkedFile[]; skipped: BulkFileState[] } | null>(null);
  const precheckSummary = useMemo(() => (precheck ? summarizePrecheck(precheck.accepted, precheck.skipped) : null), [precheck]);
  const startPrechecked = () => {
    if (!precheck) return;
    const { accepted, skipped } = precheck;
    setPrecheck(null);
    runBulkImport(accepted, skipped);
  };

  const handleBulkFiles = async (files: File[]) => {
    if (!files.length) return;
    setBulkNotice(null);

    if (files.length === 1 && files[0] && isZipFile(files[0])) {
      setBulkRunning(true);
      try {
        const walked = await walkZip(files[0]);
        setBulkRunning(false);
        setPrecheck({
          accepted: walked.accepted,
          skipped: walked.skipped.map((s) => toSkippedState(s.path, s.reason, s.detail)),
        });
      } catch (err) {
        setBulkRunning(false);
        setBulkNotice(err instanceof Error ? err.message : 'Could not read that zip file.');
      }
      return;
    }

    const accepted: WalkedFile[] = [];
    const skipped: BulkFileState[] = [];
    for (const file of files) {
      const src = sourceFromFile(file);
      const verdict = classifyEntry({ path: src.path, isDir: false, sizeBytes: src.sizeBytes });
      if (verdict.accept) accepted.push(src);
      else skipped.push(toSkippedState(src.path, verdict.reason, verdict.detail));
    }
    setPrecheck({ accepted, skipped });
  };

  const onBulkDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length) void handleBulkFiles(dropped);
  };
  const onBulkDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  };

  // Real accounts: ask the server to classify (its facts + filename + model path, the same one Records'
  // "Classify shop records" uses). It never overwrites a type a person chose, and it says how many it
  // could not place, which we report instead of guessing from the filename in the browser.
  // Demo mode has no server, so it keeps the filename guess (labelled as such on the button).
  const [classifying, setClassifying] = useState(false);
  const [classifyNote, setClassifyNote] = useState<string | null>(null);
  const processReceived = async () => {
    if (!selected || classifying) return;
    const targets = batchDocs(selected).filter((d) => d.stage === 'received' && !d.issues.some((i) => i.kind === 'duplicate'));
    if (DEMO_MODE) {
      for (const d of targets) classifyDoc(d.id, classifyByFilename(d.filename));
      return;
    }
    const ids = targets.map((d) => d.id).filter((id) => UUID_RE.test(id));
    if (!ids.length) {
      setClassifyNote('These files are still uploading. Try again in a moment.');
      return;
    }
    setClassifying(true);
    setClassifyNote(null);
    try {
      const { changed, remaining } = await reclassifyDocs(ids);
      if (useGraph.getState().lastError) {
        setClassifyNote('Could not classify right now. Try again.');
      } else {
        const left = ids.length - changed;
        setClassifyNote(
          changed === 0
            ? 'Nothing could be classified automatically. Open each file under Needs you to set its type.'
            : left > 0 || remaining > 0
              ? `Classified ${changed} of ${ids.length}. The rest need a person: open them under Needs you.`
              : `Classified ${changed} of ${ids.length}.`
        );
      }
    } finally {
      setClassifying(false);
    }
  };

  const review = (docId: string) => {
    openDocument(docId);
    setCurrentScreen('review');
  };

  return (
    <div className="space-y-8">
        {billingNotice && (
          <div role="alert" className="dw-card border-bad/40 px-5 py-4 text-bad-ink dark:text-bad-bg flex flex-wrap items-center gap-3">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <p className="flex-1 min-w-[16rem]">{billingNotice.message}</p>
            <button type="button" onClick={() => setCurrentScreen('billing')} className="dw-btn-primary !min-h-[36px] !py-1">
              See plans
            </button>
          </div>
        )}

        {/* A bulk/multi-file upload that failed reports per file, far below the fold (under the bulk drop zone).
            Say it at the top too — otherwise a failed first upload just looks like nothing happened. The
            single-file path already has the billing banner above. */}
        {!billingNotice && !bulkRunning && bulkSummary.failed > 0 && (() => {
          const first = bulkStates.find((f) => f.status === 'failed');
          const reason = first?.error ?? 'Try again.';
          const planIssue = /\b(plan|subscription|upgrade|billing)\b/i.test(reason);
          return (
            <div role="alert" className="dw-card border-bad/40 px-5 py-4 text-bad-ink dark:text-bad-bg flex flex-wrap items-center gap-3" data-testid="bulk-failed-alert">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <p className="flex-1 min-w-[16rem]">
                <span className="font-medium">{bulkSummary.failed === 1 ? "1 file couldn't be added." : `${bulkSummary.failed} files couldn't be added.`}</span> {reason}
              </p>
              {planIssue && (
                <button type="button" onClick={() => setCurrentScreen('billing')} className="dw-btn-primary !min-h-[36px] !py-1">
                  See plans
                </button>
              )}
            </div>
          );
        })()}

        {/* First-run: nothing added yet anywhere in the account. A big,
            unmissable call to action instead of the ordinary batch/bulk-import
            layout with six empty stage tiles above it. */}
        {total === 0 && (
          <div className="dw-card p-8 sm:p-10 text-center space-y-4">
            <FileUp className="w-8 h-8 mx-auto text-ink-3" aria-hidden="true" />
            <div>
              <h2 className="text-h1">Add your first document.</h2>
              <p className="text-ink-2 mt-1 max-w-prose mx-auto">
                Drop in invoices, warranty cards, work orders, or a whole folder — we'll sort it out.
              </p>
            </div>
            <button type="button" className="dw-btn-primary" disabled={uploading} onClick={() => bulkInput.current?.click()}>
              <Upload className="w-4 h-4" aria-hidden="true" /> {uploading || bulkRunning ? 'Working…' : 'Add files'}
            </button>
          </div>
        )}

        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-h1">Add files</h2>
            <p className="text-ink-2 mt-1">Every document moves through the pipeline. Nothing can fall in.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="dw-btn-secondary" onClick={() => { setShowNew(true); window.setTimeout(() => nameRef.current?.focus(), 0); }}>
              <Plus className="w-4 h-4" aria-hidden="true" /> New batch
            </button>
            {/* Adding files is the primary action and must not be gated behind
                naming a batch first. Somebody with a stack of paperwork and a
                phone about to ring should be able to drop it and walk away;
                a batch gets created around the drop if there isn't one. */}
            <button type="button" className="dw-btn-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <Upload className="w-4 h-4" aria-hidden="true" /> {uploading ? 'Working…' : 'Add files'}
            </button>
          </div>
        </header>

        {/* The pipeline ring card: Uploaded, Sorted, Read, Matched, Checked, with live import progress merged in.
            Always there once the shop has a document (see ImportProgressPanel for the stage-mapping decision). */}
        <ImportProgressPanel />

        <p className="text-caption text-ink-3 -mt-5">
          {total} documents · {counts.verified} answerable and counted · {counts.linked} answerable with “include unverified”
        </p>

        {/* Bulk import: a .zip export from field-service software, a scanning
            vendor's delivery, or just a lot of files at once. Separate from
            the per-batch "Add files" button below — this is the scale path. */}
        <section aria-labelledby="bulk-heading" className="dw-card p-5 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="bulk-heading" className="text-h3">Bulk import</h2>
            <p className="text-body text-ink-3">A .zip export, a folder, or many files at once — all go into “{selected?.name ?? 'a new batch'}”.</p>
          </div>

          <div
            onDrop={onBulkDrop}
            onDragOver={onBulkDragOver}
            onDragLeave={() => setDragOver(false)}
            className={[
              'rounded-lg border-2 border-dashed p-6 text-center transition-colors duration-quick',
              dragOver ? 'border-focus bg-surface-2' : 'border-line bg-surface',
            ].join(' ')}
          >
            <FolderArchive className="w-6 h-6 mx-auto text-ink-3" aria-hidden="true" />
            <p className="mt-2 text-body text-ink-2">Drag a .zip export or a folder of files here</p>
            <p className="mt-1 text-caption text-ink-3" data-testid="accepted-types-hint">
              Reads {ACCEPTED_TYPES_SENTENCE}. iPhone photos are converted to JPEG automatically in Safari; other browsers need the iPhone camera set to Most Compatible. Old .doc / .xls and macro files are not read: save them as .docx / .xlsx first.
            </p>
            <input
              ref={bulkInput}
              type="file"
              multiple
              accept={`.zip,${ACCEPT_ATTRIBUTE},.heic,.heif`}
              className="sr-only"
              aria-label="Choose files or a zip for bulk import"
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                e.target.value = '';
                void handleBulkFiles(fs);
              }}
            />
            <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5 mt-3" disabled={bulkRunning} onClick={() => bulkInput.current?.click()}>
              <Upload className="w-4 h-4" aria-hidden="true" /> {bulkRunning ? 'Importing…' : 'Choose files or a .zip'}
            </button>
          </div>

          {precheck && precheckSummary && (
            <ImportPrecheck
              summary={precheckSummary}
              reasonLabel={(r) => SKIP_REASON_LABEL[r as keyof typeof SKIP_REASON_LABEL] ?? 'Skipped'}
              onStart={startPrechecked}
              onCancel={() => setPrecheck(null)}
            />
          )}

          {bulkNotice && (
            <p className="dw-pill-warn inline-flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{bulkNotice}</span>
            </p>
          )}

          {bulkStates.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-caption text-ink-3">
                  {bulkSummary.total} files · {bulkSummary.uploaded} uploaded · {bulkSummary.queued} queued ·{' '}
                  {bulkSummary.skipped} skipped · {bulkSummary.failed} failed
                </p>
                {bulkRunning && (
                  <button type="button" className="dw-btn-secondary !min-h-[32px] !py-1 ml-auto" onClick={() => bulkCancel?.()}>
                    <X className="w-3.5 h-3.5" aria-hidden="true" /> Cancel
                  </button>
                )}
              </div>
              <ul className="border border-line rounded-lg bg-surface divide-y divide-line text-sm max-h-80 overflow-y-auto" aria-live="polite">
                {shownBulkRows.map((s, i) => (
                  <li key={`${s.path}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span className="truncate min-w-0 font-mono text-data" title={s.path}>{s.path}</span>
                    {s.status === 'skipped' ? (
                      <span className="dw-pill-muted shrink-0">{s.skipReason ? SKIP_REASON_LABEL[s.skipReason] : 'Skipped'}</span>
                    ) : s.status === 'failed' || s.status === 'cancelled' ? (
                      <span className="dw-pill-warn shrink-0"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{s.error ?? BULK_STATUS_LABEL[s.status]}</span>
                    ) : (
                      <span className="shrink-0 text-ink-2">{BULK_STATUS_LABEL[s.status]}</span>
                    )}
                  </li>
                ))}
                {hiddenBulkCount > 0 && <li className="px-4 py-2 text-ink-3 text-caption">…and {hiddenBulkCount} more</li>}
              </ul>
            </div>
          )}
        </section>

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
                      accept={`${ACCEPT_ATTRIBUTE},.heic,.heif`}
                      onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void uploadFiles(fs); }}
                    />
                    <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" disabled={uploading} onClick={() => fileInput.current?.click()}>
                      <Upload className="w-4 h-4" aria-hidden="true" /> {uploading ? 'Working…' : 'Add files'}
                    </button>
                    {DEMO_MODE && (
                      // Demo only. These filenames have no bytes behind them —
                      // they seed the local graph so a walkthrough has something
                      // to show. In a real account they are indistinguishable
                      // from documents the contractor actually uploaded, which
                      // is a good way to lose someone's trust permanently.
                      <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => addFiles(SAMPLE_UPLOADS.map((filename) => ({ filename })))}>
                        Add sample files
                      </button>
                    )}
                    {batchDocs(selected).some((d) => d.stage === 'received' && !d.issues.length) && (
                      <button type="button" className="dw-btn-primary !min-h-[44px] sm:!min-h-[40px] !py-1.5" onClick={() => void processReceived()} disabled={classifying}>
                        {classifying ? 'Classifying…' : DEMO_MODE ? 'Guess type from file name' : 'Classify received'}
                      </button>
                    )}
                    {classifyNote && (
                      <p role="status" className="text-caption text-ink-2 basis-full">
                        {classifyNote}
                      </p>
                    )}
                  </div>
                </div>
                {Object.values(uploads).length > 0 && (
                  <ul className="border border-line rounded-lg bg-surface divide-y divide-line text-sm max-h-80 overflow-y-auto" aria-live="polite">
                    {Object.values(uploads).slice(0, LIST_ROW_LIMIT).map((u) => {
                      // Once the read step itself is done, the row switches to the
                      // document's own live stage pill — Extracting/Linked/AI
                      // verified as review and sync move it along — so it never
                      // looks frozen on a generic "Read" forever.
                      const liveDoc = uploadDocIds[u.filename] ? graph.docs[uploadDocIds[u.filename] as string] : undefined;
                      return (
                        <li key={u.filename} className="flex items-center justify-between gap-3 px-4 py-2">
                          <span className="truncate min-w-0">{u.filename}</span>
                          {u.status === 'error' ? (
                            <span className="dw-pill-warn shrink-0"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{u.error}</span>
                          ) : u.status === 'pending' ? (
                            // Not a failure — extraction is still running server-side past the
                            // 15-minute poll window. Neutral pill, not the warn pill errors get.
                            <span className="flex flex-wrap items-center justify-end gap-2 shrink-0">
                              <span className="dw-pill-muted">{UPLOAD_LABEL.pending}</span>
                              <button type="button" className="dw-btn-tertiary !min-h-[44px] sm:!min-h-[32px] !py-0.5" onClick={() => openInboxNeedsPerson()}>{STILL_PROCESSING_LINK_LABEL}</button>
                            </span>
                          ) : (u.status === 'done' || u.status === 'queued') && liveDoc ? (
                            <span className="shrink-0"><StagePill stage={liveDoc.stage} ai={liveDoc.verifiedBy === 'ai'} compact /></span>
                          ) : (
                            <span className="shrink-0 text-ink-2">{UPLOAD_LABEL[u.status]}</span>
                          )}
                        </li>
                      );
                    })}
                    {Object.values(uploads).length > LIST_ROW_LIMIT && (
                      <li className="px-4 py-2 text-ink-3 text-caption">…and {(Object.values(uploads).length - LIST_ROW_LIMIT).toLocaleString('en-US')} more</li>
                    )}
                  </ul>
                )}
                <ul className="divide-y divide-line border border-line rounded-lg bg-surface max-h-[28rem] overflow-y-auto">
                  {batchDocs(selected)
                    .sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage))
                    .slice(0, LIST_ROW_LIMIT)
                    .map((d) => {
                      const issue = issueSummary(d);
                      const typeLabel = graph.schema.documentTypes.find((t) => t.id === d.typeId)?.label ?? 'Unclassified';
                      return (
                        <li key={d.id}>
                          <button type="button" onClick={() => review(d.id)} className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                            <StagePill stage={d.stage} compact />
                            <span className="min-w-0 flex-1">
                              <span className="block font-mono text-data text-ink truncate">{documentName(d)}</span>
                              <span className="block text-body text-ink-3 truncate">{[typeLabel, hasFriendlyName(d) ? d.filename : null].filter(Boolean).join(' · ')}{d.linkedEntityIds.length ? ` · linked to ${d.linkedEntityIds.length}` : ''}</span>
                            </span>
                            {issue && <span className="dw-pill-warn shrink-0">{issue}</span>}
                            <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  {selected.documentIds.length === 0 && <li className="px-4 py-6 text-ink-3">No documents yet. Add files to this batch.</li>}
                  {batchDocs(selected).length > LIST_ROW_LIMIT && (
                    <li className="px-4 py-2 text-ink-3 text-caption">
                      …and {(batchDocs(selected).length - LIST_ROW_LIMIT).toLocaleString('en-US')} more. Every document is under Records.
                    </li>
                  )}
                </ul>
              </>
            ) : (
              <p className="text-ink-3">Create a batch to start.</p>
            )}
          </section>
        </div>
    </div>
  );
}
