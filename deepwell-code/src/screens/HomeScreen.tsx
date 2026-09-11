// @ts-nocheck
import React from 'react';
import { motion } from 'framer-motion';
import { Wrench, Search, FileText, Clock, Upload, BarChart3, User, AlertCircle } from 'lucide-react';
import { useAppStore } from '../store/appStore';

export const HomeScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  const screens = [
    {
      id: 'home',
      title: 'Document Upload',
      description: 'Ingest PDFs, photos, and Excel sheets',
      icon: Upload,
      color: 'from-primary-600 to-primary-700',
    },
    {
      id: 'dashboard',
      title: 'Dashboard',
      description: 'View ingestion stats and equipment alerts',
      icon: BarChart3,
      color: 'from-secondary-600 to-secondary-700',
    },
    {
      id: 'search',
      title: 'On-Site Search',
      description: 'Search equipment by address or serial',
      icon: Search,
      color: 'from-success-600 to-success-700',
    },
    {
      id: 'warranty-tracking',
      title: 'Warranty Tracking',
      description: 'Monitor warranty expiration status',
      icon: Clock,
      color: 'from-warning-600 to-warning-700',
    },
    {
      id: 'dispatch-brief',
      title: 'Job Dispatch Brief',
      description: 'Pre-brief technicians with context',
      icon: Wrench,
      color: 'from-accent-600 to-accent-700',
    },
    {
      id: 'warranty-export',
      title: 'Warranty Export',
      description: 'Export warranty data for insurance',
      icon: FileText,
      color: 'from-primary-500 to-primary-600',
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800 dark:from-accent-900 dark:to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 dark:border-accent-600 bg-accent-900 dark:bg-accent-800/50 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-gradient-to-br from-primary-500 to-secondary-500 rounded-lg flex items-center justify-center">
              <Wrench className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-accent-50">DeepWell</h1>
          </div>
          <p className="text-accent-400">HVAC Document Management Prototype</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-12">
        {/* Welcome Section */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <h2 className="text-2xl font-bold text-accent-50 mb-2">Welcome to DeepWell</h2>
          <p className="text-accent-400">
            Complete HVAC document management prototype with 12 technicians, 15 equipment units,
            10 properties, and 25 service events. Upload documents, search equipment, track warranties, and dispatch jobs.
          </p>
        </motion.div>

        {/* Screen Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
          {screens.map((screen, index) => {
            const Icon = screen.icon;
            return (
              <motion.button
                key={screen.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
                onClick={() => setCurrentScreen(screen.id as any)}
                className={`
                  group relative overflow-hidden rounded-lg
                  bg-gradient-to-br ${screen.color}
                  p-6 text-left
                  hover:shadow-lg
                  transform hover:-translate-y-1
                  transition-all duration-300
                `}
              >
                {/* Background gradient */}
                <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />

                {/* Content */}
                <div className="relative z-10">
                  <Icon className="w-12 h-12 text-white mb-4" />
                  <h3 className="text-xl font-bold text-white mb-2">{screen.title}</h3>
                  <p className="text-white/80 text-sm leading-relaxed">
                    {screen.description}
                  </p>
                </div>

                {/* Arrow indicator */}
                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="text-white text-2xl">→</div>
                </div>
              </motion.button>
            );
          })}
        </div>

        {/* Info Section */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <div className="bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Clock className="w-5 h-5 text-primary-400 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="font-semibold text-accent-50 mb-1">15 Scenarios</h4>
                <p className="text-xs text-accent-400">
                  Mock data covers all core HVAC contractor workflows
                </p>
              </div>
            </div>
          </div>

          <div className="bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Search className="w-5 h-5 text-secondary-400 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="font-semibold text-accent-50 mb-1">Fuzzy Search</h4>
                <p className="text-xs text-accent-400">
                  Natural language queries with &lt;100ms response time
                </p>
              </div>
            </div>
          </div>

          <div className="bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <FileText className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="font-semibold text-accent-50 mb-1">Production Ready</h4>
                <p className="text-xs text-accent-400">
                  TypeScript strict mode, WCAG AA compliant
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
};
