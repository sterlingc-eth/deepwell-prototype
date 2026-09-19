import { create } from 'zustand';
import type { IngestProgress } from '../services/ingestClient';
import { summarizeProgress, type BulkFileState } from '../services/bulkImport';

export type Screen =
  | 'ask'
  | 'records'
  | 'ingest'
  | 'review'
  | 'dashboard'
  | 'browse'
  | 'entity'
  | 'warranty-export';

const FIELD_MODE_KEY = 'deepwell.fieldMode';

function readFieldMode(): boolean {
  try {
    return window.localStorage.getItem(FIELD_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

function applyFieldMode(on: boolean) {
  try {
    document.documentElement.classList.toggle('dark', on);
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
export function selectIngestProgress(s: Pick<AppState, 'uploads' | 'bulkRunning' | 'bulkStates'>): IngestProgressSummary | null {
  if (s.bulkRunning) {
    const summary = summarizeProgress(s.bulkStates);
    return { current: summary.uploaded + summary.skipped + summary.failed, total: summary.total };
  }
  const entries = Object.values(s.uploads);
  if (entries.length === 0 || entries.every(isUploadSettled)) return null;
  const total = entries.length;
  const done = entries.filter((u) => u.status === 'done' || u.status === 'error').length;
  return { current: done, total };
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

  // Browse (secondary list view)
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Multi-select for the warranty claim packet (equipment entity ids)
  selectedForExport: string[];
  toggleSelectForExport: (entityId: string) => void;
  clearExportSelection: () => void;
}

const initialFieldMode = readFieldMode();
if (initialFieldMode) applyFieldMode(true);

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
}));
