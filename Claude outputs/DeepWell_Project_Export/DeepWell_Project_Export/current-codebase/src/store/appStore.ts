import { create } from 'zustand';

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

interface AppState {
  // Navigation
  currentScreen: Screen;
  setCurrentScreen: (screen: Screen) => void;

  // Ask
  pendingQuestion: string | null; // deep-link prefill (dashboard rows, entity links)
  askQuestion: (question: string) => void; // navigate to Ask with this question
  clearPendingQuestion: () => void;
  recentQuestions: string[];
  pushRecentQuestion: (q: string) => void;
  includeUnverified: boolean;
  setIncludeUnverified: (on: boolean) => void;
  /** Wall time of each answered question this session, ms, newest last (last 200) */
  answerTimes: number[];
  pushAnswerTime: (ms: number) => void;

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
  setCurrentScreen: (screen) => set({ currentScreen: screen }),

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
  answerTimes: [],
  pushAnswerTime: (ms) =>
    set((s) => {
      if (!Number.isFinite(ms) || ms < 0) return s;
      return { answerTimes: [...s.answerTimes, Math.round(ms)].slice(-200) };
    }),

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
