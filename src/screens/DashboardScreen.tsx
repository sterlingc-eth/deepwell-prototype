// @ts-nocheck
import React from 'react';
import { motion } from 'framer-motion';
import { Upload, FileText, Zap, TrendingUp, AlertCircle, Clock } from 'lucide-react';
import { useAppStore } from '../store/appStore';

export const DashboardScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  // Mock dashboard data
  const stats = [
    { label: 'Documents Ingested', value: '47', change: '+8 this week', icon: FileText, color: 'text-primary-400' },
    { label: 'Equipment Linked', value: '23', change: '+3 new', icon: Zap, color: 'text-secondary-400' },
    { label: 'Warranty Alerts', value: '5', change: 'Expiring soon', icon: AlertCircle, color: 'text-warning' },
    { label: 'Extraction Accuracy', value: '94.2%', change: '+2.1% this month', icon: TrendingUp, color: 'text-success' },
  ];

  const recentDocuments = [
    { name: 'IMG_2024_WorkOrder_Johnson.jpg', date: '2 hours ago', equipment: 'SN-LEN-987654', status: 'approved' },
    { name: 'Warranty_Certificate_Smith.pdf', date: '1 day ago', equipment: 'SN-CAR-654321', status: 'approved' },
    { name: 'Service_Records_2024.xlsx', date: '3 days ago', equipment: '8 units', status: 'approved' },
  ];

  const equipmentAtRisk = [
    { serial: 'SN-RHE-445566', warranty: 'Expires in 15 days', lastService: '3 months ago', risk: 'high' },
    { serial: 'SN-YRK-112233', warranty: 'Expires in 45 days', lastService: '6 months ago', risk: 'medium' },
    { serial: 'SN-TRN-778899', warranty: 'Expires in 30 days', lastService: '2 months ago', risk: 'high' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 bg-accent-900 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-accent-50">Dashboard</h1>
            <p className="text-sm text-accent-400 mt-1">Intelligent document layer for HVAC</p>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setCurrentScreen('home')}
            className="px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-accent-50 font-medium transition-colors"
          >
            Upload Documents
          </motion.button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {stats.map((stat, index) => {
            const Icon = stat.icon;
            return (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
                className="border border-accent-700 rounded-lg bg-accent-900/50 hover:bg-accent-900/70 p-6 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide">
                      {stat.label}
                    </p>
                    <p className="text-3xl font-bold text-accent-50 mt-2">
                      {stat.value}
                    </p>
                  </div>
                  <Icon className={`w-6 h-6 ${stat.color}`} />
                </div>
                <p className="text-xs text-accent-500">
                  {stat.change}
                </p>
              </motion.div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recent Documents */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="lg:col-span-2 border border-accent-700 rounded-lg bg-accent-900/50 p-6"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-accent-50">Recent Documents</h2>
              <button
                onClick={() => setCurrentScreen('home')}
                className="text-sm text-primary-400 hover:text-primary-300 transition-colors"
              >
                View All →
              </button>
            </div>

            <div className="space-y-3">
              {recentDocuments.map((doc, index) => (
                <motion.div
                  key={doc.name}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 + index * 0.05 }}
                  className="flex items-center justify-between p-3 bg-accent-800/30 rounded-lg hover:bg-accent-800/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-accent-50 truncate">
                      {doc.name}
                    </p>
                    <p className="text-xs text-accent-500 mt-1">
                      {doc.equipment} · {doc.date}
                    </p>
                  </div>
                  <div className="flex-shrink-0 ml-4">
                    <span className="inline-block px-2 py-1 rounded text-xs font-medium bg-success/20 text-success">
                      ✓ Approved
                    </span>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Equipment at Risk */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="border border-accent-700 rounded-lg bg-accent-900/50 p-6"
          >
            <div className="flex items-center gap-2 mb-4">
              <AlertCircle className="w-5 h-5 text-warning" />
              <h2 className="text-lg font-semibold text-accent-50">At Risk</h2>
            </div>

            <div className="space-y-3">
              {equipmentAtRisk.map((eq, index) => (
                <motion.div
                  key={eq.serial}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 + index * 0.05 }}
                  className={`p-3 rounded-lg border ${
                    eq.risk === 'high'
                      ? 'border-destructive/50 bg-destructive/10'
                      : 'border-warning/50 bg-warning/10'
                  }`}
                >
                  <p className="text-sm font-medium text-accent-50">
                    {eq.serial}
                  </p>
                  <p className={`text-xs mt-1 ${
                    eq.risk === 'high' ? 'text-destructive' : 'text-warning'
                  }`}>
                    {eq.warranty}
                  </p>
                  <p className="text-xs text-accent-500 mt-1">
                    {eq.lastService}
                  </p>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>

        {/* Quick Actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <button
            onClick={() => setCurrentScreen('home')}
            className="p-6 border border-accent-700 rounded-lg hover:bg-accent-900/50 transition-colors text-left group"
          >
            <Upload className="w-6 h-6 text-primary-400 mb-3 group-hover:scale-110 transition-transform" />
            <h3 className="font-semibold text-accent-50">Upload Documents</h3>
            <p className="text-xs text-accent-500 mt-1">Add new photos or PDFs</p>
          </button>

          <button
            onClick={() => setCurrentScreen('search')}
            className="p-6 border border-accent-700 rounded-lg hover:bg-accent-900/50 transition-colors text-left group"
          >
            <FileText className="w-6 h-6 text-secondary-400 mb-3 group-hover:scale-110 transition-transform" />
            <h3 className="font-semibold text-accent-50">Search Equipment</h3>
            <p className="text-xs text-accent-500 mt-1">Find by serial or address</p>
          </button>

          <button
            onClick={() => setCurrentScreen('warranty-tracking')}
            className="p-6 border border-accent-700 rounded-lg hover:bg-accent-900/50 transition-colors text-left group"
          >
            <Clock className="w-6 h-6 text-warning mb-3 group-hover:scale-110 transition-transform" />
            <h3 className="font-semibold text-accent-50">Warranty Tracking</h3>
            <p className="text-xs text-accent-500 mt-1">Monitor all warranties</p>
          </button>
        </motion.div>
      </main>
    </div>
  );
};
