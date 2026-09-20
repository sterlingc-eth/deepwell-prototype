import { create } from 'zustand';
import type { IngestProgress } from '../services/ingestClient';
import { summarizeProgress, type BulkFileState } from '../services/bulkImport';
import type { BillingInterval, BillingStatus } from '../services/billingClient';

export type Screen =
  | 'ask'
  | 'records'
  | 'ingest'
  | 'review'
  | 'dashboard'
  | 'browse'
  | 'entity'
  | 'customer'
  | 'warranty-export'
  | 'billing'
  | 'team'
  | 'outreach';

/** `?plan=&interval=` deep link, held until Billing opens and preselects it. */
export interface PendingPlan {
  plan: string;
  interval: BillingInterval;
}

const FIELD_MODE_KEY = 'deepwell.fieldMode';

function readFieldMode(): boolean {
  try {
    // Default is Office view (dark). Field view (light, larger type) is opt-in.
    return window.localStorage.getItem(FIELD_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

function applyFieldMode(on: boolean) {
  try {
    // Office view = `.dark` colors. Field view = light colors + `.field` ergonomics.
    document.documentElement.classList.toggle('dark', !on);
    document.documentElement.classList.toggle('field', on);
    window.localStorage.setItem(FIELD_MODE_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable — theme still applied to the document */
  }
}

/** Which "Needs a person" queue filter a caller wants pre-selected the next
 *  time the Inbox's Needs-a-person tab mounts (Dashboard's data-health tiles
 *  use this to land on Inbox already filtered) — a bare string, not
 *  ReviewScreen's own `Filter` union, so the store never has to import a
 *  screen-local type. Consumed once, then cleared. */
export type PendingReviewFilter = string;

/** A running ingest/bulk-import's progress, shown as a persistent header
 *  indicator so leaving the Inbox screen mid-upload doesn't lose visibility
 *  into whether it finished. `current` counts files that have settled
 *  (uploaded, skipped, or failed); `total` is the batch size. */
export interface IngestProgressSummary {
  current: number;
  total: number;
  /** Past the ten-minute server-side processing cap — still `total - current`
   *  behind, but no longer being polled (see App.tsx's poll loop). */
  stalled?: boolean;
}

/** True once a single-file upload row has nothing left to wait on: it either
 *  finished, failed, or gave up polling (still running server-side past the
 *  15-minute window, tracked separately — not a failure). */
function isUploadSettled(u: IngestProgress): boolean {
  return u.status === 'done' || u.status === 'error' || u.status === 'pending';
}

/**
 * Derives the AppShell header's "Processing N of M…" indicator straight from
 * the Inbox's live upload/bulk-import state. This is intentionally a pure
 * function of state, not a value some component pushes into the store on an
 * effect: a pushed value can go stale (or freeze at its last snapshot) the
 * moment the component that was updating it unmounts — e.g. switching Inbox
 * tabs or navigating away mid-upload. Deriving it means it is idle (null)
 * exactly when every in-flight item has finished or failed, from any
 * subscriber, at any time, regardless of what mounted or unmounted it.
 */
export function selectIngestProgress(
  s: Pick<AppState, 'uploads' | 'bulkRunning' | 'bulkStates' | 'processingPending' | 'processingTotal' | 'processingStalled'>
): IngestProgressSummary | null {
  if (s.bulkRunning) {
    const summary = summarizeProgress(s.bulkStates);
    return { current: summary.uploaded + summary.skipped + summary.failed, total: summary.total };
  }
  const entries = Object.values(s.uploads);
  if (entries.length > 0 && !entries.every(isUploadSettled)) {
    const total = entries.length;
    const done = entries.filter((u) => u.status === 'done' || u.status === 'error').length;
    return { current: done, total };
  }
  // The client-side transfer (upload + read) is done, or never ran this
  // session — but the server's own classify/extract/link/verify pipeline can
  // keep working for minutes after that. `processingPending` tracks exactly
  // that: documents this tab uploaded, not yet at a terminal server state
  // (see trackProcessingDocs and the poll loop in App.tsx), so leaving Inbox
  // mid-processing doesn't lose the indicator the way it used to.
  if (s.processingPending.length > 0 || s.processingStalled) {
    return { current: s.processingTotal - s.processingPending.length, total: s.processingTotal, stalled: s.processingStalled };
  }
  return null;
}

interface AppState {
  // Navigation
  currentScreen: Screen;
  setCurrentScreen: (screen: Screen) => void;

  // Inbox (Intake + Review merged behind two tabs)
  inboxTab: 'add' | 'needs-person';
  setInboxTab: (tab: 'add' | 'needs-person') => void;
  pendingReviewFilter: PendingReviewFilter | null;
  clearPendingReviewFilter: () => void;
  /** Jump straight to Inbox's "Needs a person" tab, optionally pre-selecting
   *  one of its queue filters (e.g. "unlinked", "gaps", "conflicts"). */
  openInboxNeedsPerson: (filter?: PendingReviewFilter) => void;

  // Inbox "Add files" tab state — lifted out of the component (rather than
  // component-local useState/useRef) so switching Inbox tabs or navigating
  // away and back mid-upload doesn't reset progress to empty defaults or
  // strand a "Cancel" button that no longer refers to the running import.
  // The AppShell header's "Processing N of M…" indicator is the derived
  // `selectIngestProgress` above, read straight off these fields.
  uploads: Record<string, IngestProgress>;
  setUpload: (filename: string, progress: IngestProgress) => void;
  /** Adds a fresh 'hashing' row per filename without touching existing rows —
   *  `uploads` accumulates across every batch added this session. */
  seedUploads: (filenames: string[]) => void;
  uploadDocIds: Record<string, string>;
  setUploadDocId: (filename: string, id: string) => void;

  // Server-side pipeline tracking for the "Processing N of M…" header pill —
  // see selectIngestProgress above. Lives here (not component state) so the
  // poll loop that drives it (App.tsx, mounted for the whole signed-in
  // session) keeps running no matter which screen is on screen.
  processingPending: string[];
  processingTotal: number;
  processingStartedAt: number | null;
  processingStalled: boolean;
  /** Start tracking real document ids this tab just uploaded. Ids already
   *  pending are ignored; if nothing was pending before, this starts a fresh
   *  run (resets the total and the ten-minute clock). */
  trackProcessingDocs: (ids: string[]) => void;
  /** Mark ids as having reached a terminal server-side state (verified, a
   *  hard extract error, or complete enough at mapped/linked) — see
   *  ingestClient.ts's `isProcessingTerminal`. Once nothing is left pending,
   *  the run resets so the next upload starts a clean count. */
  settleProcessingDocs: (ids: string[]) => void;
  setProcessingStalled: (v: boolean) => void;

  bulkStates: BulkFileState[];
  setBulkStates: (states: BulkFileState[]) => void;
  bulkRunning: boolean;
  setBulkRunning: (running: boolean) => void;
  bulkNotice: string | null;
  setBulkNotice: (notice: string | null) => void;
  /** The currently running bulk import's own cancel handle (see
   *  services/bulkImport.ts's `BulkImportHandle`), stored so the Cancel
   *  button still works after the Add-files tab unmounts and remounts. */
  bulkCancel: (() => void) | null;
  setBulkCancel: (cancel: (() => void) | null) => void;

  // Ask
  pendingQuestion: string | null; // deep-link prefill (dashboard rows, entity links)
  askQuestion: (question: string) => void; // navigate to Ask with this question
  clearPendingQuestion: () => void;
  // Unlike pendingQuestion (navigates to Ask AND submits immediately),
  // pendingPrefill only fills the question box and lets the person finish
  // typing — used by "Ask about this customer" (prefills "C-00012: ").
  pendingPrefill: string | null;
  prefillQuestion: (text: string) => void;
  clearPendingPrefill: () => void;
  recentQuestions: string[];
  pushRecentQuestion: (q: string) => void;
  includeUnverified: boolean;
  setIncludeUnverified: (on: boolean) => void;

  // Field mode (dark, high-contrast, larger type)
  fieldMode: boolean;
  setFieldMode: (on: boolean) => void;

  // Selection for detail screens
  selectedDocumentId: string | null;
  openDocument: (id: string) => void;
  selectedEntityId: string | null;
  openEntity: (id: string) => void;
  // The customer-profile screen's ref — whatever the caller had in hand (a
  // uuid or a 'C-00012' display number); CustomerProfileScreen itself
  // resolves which one it is (customerClient.getByRef) rather than the store
  // doing that classification.
  customerRef: string | null;
  openCustomer: (ref: string) => void;

  // Outreach screen — an equipment id to preselect/highlight, carried from
  // the Dashboard's "Open in Outreach" button or a `?screen=outreach&equipment=`
  // deep link. Consumed once by OutreachScreen, same one-shot pattern as
  // pendingReviewFilter above.
  pendingOutreachEquipmentId: string | null;
  openOutreach: (equipmentId?: string) => void;
  clearPendingOutreachEquipment: () => void;

  // Browse (secondary list view)
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Multi-select for the warranty claim packet (equipment entity ids)
  selectedForExport: string[];
  toggleSelectForExport: (entityId: string) => void;
  clearExportSelection: () => void;

  // Billing: the account's current subscription state (AppShell's global
  // banner and BillingScreen both read this rather than each fetching their
  // own copy), and a `?plan=&interval=` deep link waiting for Billing to open
  // and preselect it.
  billingStatus: BillingStatus | null;
  setBillingStatus: (status: BillingStatus | null) => void;
  pendingPlan: PendingPlan | null;
  setPendingPlan: (plan: PendingPlan | null) => void;
  clearPendingPlan: () => void;
}

const initialFieldMode = readFieldMode();
applyFieldMode(initialFieldMode); // always: Office (dark) is the default and needs the class

export const useAppStore = create<AppState>((set) => ({
  currentScreen: 'ask',
  // 'review' and 'records' are retired top-level ids kept as aliases so any
  // existing call site, deep link, or bookmark still lands somewhere sane:
  // 'review' -> the Inbox screen's "Needs a person" tab (its old separate
  // route), 'records' -> the Dashboard (the old Records screen's health
  // tiles now live in Dashboard's "Data health" strip).
  setCurrentScreen: (screen) =>
    set(
      screen === 'review'
        ? { currentScreen: 'ingest', inboxTab: 'needs-person' }
        : screen === 'records'
          ? { currentScreen: 'dashboard' }
          : { currentScreen: screen },
    ),

  inboxTab: 'add',
  setInboxTab: (tab) => set({ inboxTab: tab }),
  pendingReviewFilter: null,
  clearPendingReviewFilter: () => set({ pendingReviewFilter: null }),
  openInboxNeedsPerson: (filter) => set({ currentScreen: 'ingest', inboxTab: 'needs-person', pendingReviewFilter: filter ?? null }),

  uploads: {},
  setUpload: (filename, progress) => set((s) => ({ uploads: { ...s.uploads, [filename]: progress } })),
  seedUploads: (filenames) =>
    set((s) => {
      const next = { ...s.uploads };
      for (const f of filenames) next[f] = { filename: f, status: 'hashing' };
      return { uploads: next };
    }),
  uploadDocIds: {},
  setUploadDocId: (filename, id) => set((s) => ({ uploadDocIds: { ...s.uploadDocIds, [filename]: id } })),

  processingPending: [],
  processingTotal: 0,
  processingStartedAt: null,
  processingStalled: false,
  trackProcessingDocs: (ids) =>
    set((s) => {
      const fresh = ids.filter((id) => !s.processingPending.includes(id));
      if (!fresh.length) return s;
      const wasEmpty = s.processingPending.length === 0;
      return {
        processingPending: [...s.processingPending, ...fresh],
        processingTotal: wasEmpty ? fresh.length : s.processingTotal + fresh.length,
        processingStartedAt: s.processingStartedAt ?? Date.now(),
        processingStalled: false,
      };
    }),
  settleProcessingDocs: (ids) =>
    set((s) => {
      const pending = s.processingPending.filter((id) => !ids.includes(id));
      if (pending.length === s.processingPending.length) return s;
      const cleared = pending.length === 0;
      return {
        processingPending: pending,
        ...(cleared ? { processingTotal: 0, processingStartedAt: null, processingStalled: false } : {}),
      };
    }),
  setProcessingStalled: (v) => set({ processingStalled: v }),

  bulkStates: [],
  setBulkStates: (states) => set({ bulkStates: states }),
  bulkRunning: false,
  setBulkRunning: (running) => set({ bulkRunning: running }),
  bulkNotice: null,
  setBulkNotice: (notice) => set({ bulkNotice: notice }),
  bulkCancel: null,
  setBulkCancel: (cancel) => set({ bulkCancel: cancel }),

  pendingQuestion: null,
  askQuestion: (question) => set({ pendingQuestion: question, currentScreen: 'ask' }),
  clearPendingQuestion: () => set({ pendingQuestion: null }),
  pendingPrefill: null,
  prefillQuestion: (text) => set({ pendingPrefill: text, currentScreen: 'ask' }),
  clearPendingPrefill: () => set({ pendingPrefill: null }),
  recentQuestions: [],
  pushRecentQuestion: (q) =>
    set((s) => ({
      recentQuestions: [q, ...s.recentQuestions.filter((x) => x !== q)].slice(0, 8),
    })),
  includeUnverified: false,
  setIncludeUnverified: (on) => set({ includeUnverified: on }),

  fieldMode: initialFieldMode,
  setFieldMode: (on) => {
    applyFieldMode(on);
    set({ fieldMode: on });
  },

  selectedDocumentId: null,
  openDocument: (id) => set({ selectedDocumentId: id }),
  selectedEntityId: null,
  openEntity: (id) => set({ selectedEntityId: id, currentScreen: 'entity' }),
  customerRef: null,
  openCustomer: (ref) => set({ customerRef: ref, currentScreen: 'customer' }),

  pendingOutreachEquipmentId: null,
  openOutreach: (equipmentId) => set({ currentScreen: 'outreach', pendingOutreachEquipmentId: equipmentId ?? null }),
  clearPendingOutreachEquipment: () => set({ pendingOutreachEquipmentId: null }),

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  selectedForExport: [],
  toggleSelectForExport: (entityId) =>
    set((state) => ({
      selectedForExport: state.selectedForExport.includes(entityId)
        ? state.selectedForExport.filter((id) => id !== entityId)
        : [...state.selectedForExport, entityId],
    })),
  clearExportSelection: () => set({ selectedForExport: [] }),

  billingStatus: null,
  setBillingStatus: (status) => set({ billingStatus: status }),
  pendingPlan: null,
  setPendingPlan: (plan) => set({ pendingPlan: plan }),
  clearPendingPlan: () => set({ pendingPlan: null }),
}));
