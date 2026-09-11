// @ts-nocheck
import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Search, Loader } from 'lucide-react';
import { performSearch } from '../services/searchService';
import { useAppStore } from '../store/appStore';
import { SearchResult } from '../components';

export const OnSiteSearchScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const searchResults = useAppStore((s) => s.searchResults);
  const setSearchResults = useAppStore((s) => s.setSearchResults);
  const isSearching = useAppStore((s) => s.isSearching);
  const setIsSearching = useAppStore((s) => s.setIsSearching);
  const selectedResult = useAppStore((s) => s.selectedEquipment);
  const setSelectedResult = useAppStore((s) => s.setSelectedEquipment);

  // Perform search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const search = async () => {
      setIsSearching(true);
      try {
        const results = await performSearch(searchQuery);
        setSearchResults(results);
      } finally {
        setIsSearching(false);
      }
    };

    const debounceTimer = setTimeout(search, 300);
    return () => clearTimeout(debounceTimer);
  }, [searchQuery, setSearchResults, setIsSearching]);

  const suggestedQueries = [
    'Smith residence',
    'SN-LEN-987654',
    'Rodriguez',
    'Maria Garcia',
    '2026',
    'Miller Manufacturing',
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800 dark:from-accent-900 dark:to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 dark:border-accent-600 bg-accent-900 dark:bg-accent-800/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setCurrentScreen('home')}
            className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-primary-400" />
          </motion.button>
          <div>
            <h1 className="text-2xl font-bold text-accent-50">On-Site Search</h1>
            <p className="text-xs text-accent-400">Search equipment by address, serial, technician, or date</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Search Input */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-primary-400" />
            <input
              type="text"
              placeholder="Search equipment by address, serial #, technician name, or date..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`
                w-full pl-12 pr-4 py-3 rounded-lg
                bg-accent-800 dark:bg-accent-700
                border-2 border-accent-600 dark:border-accent-500
                text-accent-50 placeholder-accent-500
                focus:outline-none focus:border-primary-500
                transition-colors
              `}
              autoFocus
            />
            {isSearching && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <Loader className="w-5 h-5 text-primary-400 animate-spin" />
              </div>
            )}
          </div>

          {/* Suggested Queries */}
          {!searchQuery && (
            <div className="mt-4">
              <p className="text-xs text-accent-400 mb-2">Try searching for:</p>
              <div className="flex flex-wrap gap-2">
                {suggestedQueries.map((query) => (
                  <motion.button
                    key={query}
                    whileHover={{ scale: 1.05 }}
                    onClick={() => setSearchQuery(query)}
                    className={`
                      px-3 py-1 rounded text-xs font-medium
                      bg-primary-900/50 hover:bg-primary-800
                      text-primary-300 hover:text-primary-200
                      border border-primary-700 hover:border-primary-600
                      transition-all
                    `}
                  >
                    {query}
                  </motion.button>
                ))}
              </div>
            </div>
          )}
        </motion.div>

        {/* Results */}
        <AnimatePresence mode="wait">
          {isSearching && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center py-12"
            >
              <div className="text-center">
                <Loader className="w-8 h-8 text-primary-400 animate-spin mx-auto mb-2" />
                <p className="text-accent-400 text-sm">Searching...</p>
              </div>
            </motion.div>
          )}

          {!isSearching && searchQuery && searchResults.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center py-12"
            >
              <p className="text-accent-400">No results found for "{searchQuery}"</p>
              <p className="text-xs text-accent-500 mt-2">Try a different query</p>
            </motion.div>
          )}

          {!isSearching && searchResults.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              <p className="text-xs text-accent-400 mb-4">
                Found {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
              </p>
              {searchResults
                .filter((r) => r.data && r.data.id)
                .map((result, index) => (
                  <SearchResult
                    key={`${result.type}-${result.data.id}`}
                    result={result}
                    index={index}
                    isHighlighted={
                      selectedResult?.id === (result.data as any).id
                    }
                    onSelect={(res) => {
                      if (res.type === 'equipment') {
                        setSelectedResult(res.data as any);
                        setCurrentScreen('equipment-detail');
                      }
                    }}
                  />
                ))}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};
