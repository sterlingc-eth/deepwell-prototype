import { create } from 'zustand';
import type { SearchResult, Equipment } from '../types';

interface AppState {
  // Navigation
  currentScreen: 'home' | 'dashboard' | 'extraction-review' | 'search' | 'dispatch-brief' | 'warranty-export' | 'technician-profile' | 'equipment-detail' | 'warranty-tracking';
  setCurrentScreen: (screen: AppState['currentScreen']) => void;

  // Search state
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: SearchResult[];
  setSearchResults: (results: SearchResult[]) => void;
  isSearching: boolean;
  setIsSearching: (loading: boolean) => void;

  // Selected equipment
  selectedEquipment: Equipment | null;
  setSelectedEquipment: (eq: Equipment | null) => void;

  // Multi-select for export
  selectedForExport: Equipment[];
  toggleSelectForExport: (eq: Equipment) => void;
  clearExportSelection: () => void;

  // UI state
  showSearch: boolean;
  setShowSearch: (show: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentScreen: 'home',
  setCurrentScreen: (screen) => set({ currentScreen: screen }),

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  searchResults: [],
  setSearchResults: (results) => set({ searchResults: results }),

  isSearching: false,
  setIsSearching: (loading) => set({ isSearching: loading }),

  selectedEquipment: null,
  setSelectedEquipment: (eq) => set({ selectedEquipment: eq }),

  selectedForExport: [],
  toggleSelectForExport: (eq) =>
    set((state) => {
      const isSelected = state.selectedForExport.some((e) => e.id === eq.id);
      return {
        selectedForExport: isSelected
          ? state.selectedForExport.filter((e) => e.id !== eq.id)
          : [...state.selectedForExport, eq],
      };
    }),

  clearExportSelection: () => set({ selectedForExport: [] }),

  showSearch: false,
  setShowSearch: (show) => set({ showSearch: show }),
}));
