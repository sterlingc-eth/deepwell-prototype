// @ts-nocheck
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, AlertCircle, Clock, CheckCircle, TrendingDown } from 'lucide-react';
import { useAppStore } from '../store/appStore';

export const WarrantyTrackingScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const [filterStatus, setFilterStatus] = useState<'all' | 'expiring' | 'expired'>('all');

  // Mock warranty data
  const warranties = [
    { id: 1, serial: 'SN-LEN-987654', equipment: 'Lennox XC21-046', customer: 'Smith Residence', expiryDate: '2026-06-15', daysLeft: 654, status: 'active', type: 'Parts & Labor' },
    { id: 2, serial: 'SN-CAR-654321', equipment: 'Carrier ACP-12024', customer: 'Tech Solutions Inc.', expiryDate: '2027-08-22', daysLeft: 1082, status: 'active', type: 'Comprehensive' },
    { id: 3, serial: 'SN-RHE-445566', equipment: 'Rheem RA1448AJ1NA', customer: 'Rodriguez Family', expiryDate: '2025-03-10', daysLeft: 183, status: 'expiring', type: 'Parts & Labor' },
    { id: 4, serial: 'SN-TRN-112233', equipment: 'Trane XR15', customer: 'Martinez LLC', expiryDate: '2024-05-20', daysLeft: -108, status: 'expired', type: 'Standard' },
    { id: 5, serial: 'SN-YRK-778899', equipment: 'York YVAA18S', customer: 'Johnson Enterprises', expiryDate: '2027-11-08', daysLeft: 1521, status: 'active', type: 'Parts & Labor' },
    { id: 6, serial: 'SN-CAR-334455', equipment: 'Carrier 25VPA048A00', customer: 'City Services', expiryDate: '2024-02-14', daysLeft: -208, status: 'expired', type: 'Commercial' },
    { id: 7, serial: 'SN-LEN-556677', equipment: 'Lennox 13HPH', customer: 'Garcia Household', expiryDate: '2026-09-30', daysLeft: 714, status: 'active', type: 'Parts & Labor' },
    { id: 8, serial: 'SN-RHE-998811', equipment: 'Rheem RG1024AJMSA', customer: 'Wilson Properties', expiryDate: '2024-12-20', daysLeft: 102, status: 'expiring', type: 'Standard' },
  ];

  const filteredWarranties = warranties.filter(w => {
    if (filterStatus === 'expired') return w.status === 'expired';
    if (filterStatus === 'expiring') return w.status === 'expiring';
    return true;
  });

  const stats = {
    total: warranties.length,
    active: warranties.filter(w => w.status === 'active').length,
    expiring: warranties.filter(w => w.status === 'expiring').length,
    expired: warranties.filter(w => w.status === 'expired').length,
  };

  const getStatusColor = (status: string) => {
    if (status === 'expired') return 'bg-destructive/20 text-destructive border-destructive/50';
    if (status === 'expiring') return 'bg-warning/20 text-warning border-warning/50';
    return 'bg-success/20 text-success border-success/50';
  };

  const getStatusIcon = (status: string) => {
    if (status === 'expired') return <AlertCircle className="w-4 h-4" />;
    if (status === 'expiring') return <Clock className="w-4 h-4" />;
    return <CheckCircle className="w-4 h-4" />;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 bg-accent-900 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setCurrentScreen('dashboard')}
            className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-primary-400" />
          </motion.button>
          <div>
            <h1 className="text-2xl font-bold text-accent-50">Warranty Tracking</h1>
            <p className="text-xs text-accent-400">Monitor equipment warranty status</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total Equipment', value: stats.total, icon: '📊', color: 'text-primary-400' },
            { label: 'Active Warranties', value: stats.active, icon: '✓', color: 'text-success' },
            { label: 'Expiring Soon', value: stats.expiring, icon: '⚠', color: 'text-warning' },
            { label: 'Expired', value: stats.expired, icon: '✗', color: 'text-destructive' },
          ].map((stat, index) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="border border-accent-700 rounded-lg bg-accent-900/50 p-4"
            >
              <p className="text-xs text-accent-500 mb-2">{stat.label}</p>
              <div className="flex items-center justify-between">
                <p className={`text-3xl font-bold ${stat.color}`}>{stat.value}</p>
                <span className="text-2xl">{stat.icon}</span>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-6">
          {(['all', 'expiring', 'expired'] as const).map((status) => (
            <motion.button
              key={status}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setFilterStatus(status)}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                filterStatus === status
                  ? 'bg-primary-600 text-accent-50'
                  : 'border border-accent-700 text-accent-400 hover:bg-accent-800/50'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </motion.button>
          ))}
        </div>

        {/* Warranty List */}
        <div className="space-y-3">
          {filteredWarranties.map((warranty, index) => (
            <motion.div
              key={warranty.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className={`border rounded-lg p-4 ${getStatusColor(warranty.status)}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3 flex-1">
                  <div className="flex-shrink-0 pt-1">
                    {getStatusIcon(warranty.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-accent-50">{warranty.serial}</h3>
                      <span className="text-xs opacity-75 px-2 py-1 rounded-full bg-current/20">
                        {warranty.type}
                      </span>
                    </div>
                    <p className="text-sm opacity-90">{warranty.equipment}</p>
                    <p className="text-xs opacity-75 mt-1">{warranty.customer}</p>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-semibold text-lg">
                    {warranty.status === 'expired' ? (
                      <>Expired {Math.abs(warranty.daysLeft)} days ago</>
                    ) : warranty.status === 'expiring' ? (
                      <>{warranty.daysLeft} days left</>
                    ) : (
                      <>{warranty.daysLeft} days left</>
                    )}
                  </p>
                  <p className="text-xs opacity-75">{warranty.expiryDate}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {filteredWarranties.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <p className="text-accent-400">No warranties found with this filter</p>
          </motion.div>
        )}
      </main>
    </div>
  );
};
