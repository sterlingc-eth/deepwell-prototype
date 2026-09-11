// @ts-nocheck
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, AlertTriangle, CheckCircle, Clock, Wrench, FileText, Download } from 'lucide-react';
import { useAppStore } from '../store/appStore';

export const EquipmentDetailScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const [activeTab, setActiveTab] = useState<'overview' | 'warranty' | 'history'>('overview');

  // Mock equipment detail
  const equipment = {
    id: 'eq-001',
    serialNumber: 'SN-LEN-987654',
    manufacturer: 'Lennox',
    modelNumber: 'XC21-046-230',
    equipmentType: 'AC Unit',
    installDate: '2021-06-15',
    warrantyExpiry: '2026-06-15',
    lastServiceDate: '2024-08-20',
    status: 'Active - Good Condition',
    location: '1234 Main Street, Phoenix, AZ 85001',
    daysUntilWarrantyExpiry: 654,
  };

  const warrantyDetails = {
    type: 'Parts & Labor - Comprehensive',
    coverage: 'All parts and labor for 5 years from installation',
    partsExpiry: '2026-06-15',
    laborExpiry: '2026-06-15',
    status: 'Active',
    notes: 'Transferable warranty. No coverage for improper maintenance.',
  };

  const serviceHistory = [
    { date: '2024-08-20', technician: 'Maria Garcia', work: 'Seasonal maintenance - refrigerant charge, filter replacement', cost: '$385' },
    { date: '2024-05-10', technician: 'David Chen', work: 'Spring inspection and tune-up', cost: '$295' },
    { date: '2024-01-15', technician: 'Carlos Rodriguez', work: 'Winter performance check, capacitor test', cost: '$225' },
    { date: '2023-09-05', technician: 'Jenny Wilson', work: 'Fall maintenance, coil cleaning', cost: '$450' },
    { date: '2023-05-20', technician: 'Brian Thompson', work: 'Annual service and calibration', cost: '$350' },
  ];

  const documentsAvailable = [
    { name: 'Original Work Order', date: '2021-06-15', type: 'PDF' },
    { name: 'Warranty Certificate', date: '2021-06-15', type: 'PDF' },
    { name: 'Installation Report', date: '2021-06-20', type: 'PDF' },
    { name: 'Maintenance Log 2024', date: '2024-09-05', type: 'Excel' },
  ];

  const daysUntilExpiry = Math.floor((new Date(equipment.warrantyExpiry).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
  const warrantyStatusColor = daysUntilExpiry < 90 ? 'text-destructive' : daysUntilExpiry < 180 ? 'text-warning' : 'text-success';

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 bg-accent-900 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setCurrentScreen('search')}
            className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-primary-400" />
          </motion.button>
          <div>
            <h1 className="text-2xl font-bold text-accent-50">{equipment.serialNumber}</h1>
            <p className="text-xs text-accent-400">{equipment.manufacturer} {equipment.modelNumber}</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Alert */}
        {daysUntilExpiry < 180 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 border border-warning/50 bg-warning/10 rounded-lg p-4 flex items-start gap-3"
          >
            <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-accent-50">Warranty Expiring Soon</p>
              <p className="text-sm text-accent-400 mt-1">
                This equipment's warranty expires in {daysUntilExpiry} days ({equipment.warrantyExpiry})
              </p>
            </div>
          </motion.div>
        )}

        {/* Overview Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="border border-accent-700 rounded-lg bg-accent-900/50 p-6 mb-8"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-2">Equipment Details</p>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-accent-500">Serial Number</p>
                  <p className="font-mono text-sm text-accent-50">{equipment.serialNumber}</p>
                </div>
                <div>
                  <p className="text-xs text-accent-500">Equipment Type</p>
                  <p className="text-sm text-accent-50">{equipment.equipmentType}</p>
                </div>
                <div>
                  <p className="text-xs text-accent-500">Installed</p>
                  <p className="text-sm text-accent-50">{equipment.installDate}</p>
                </div>
                <div>
                  <p className="text-xs text-accent-500">Location</p>
                  <p className="text-sm text-accent-50">{equipment.location}</p>
                </div>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-2">Status</p>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-success" />
                  <div>
                    <p className="text-xs text-accent-500">Condition</p>
                    <p className="text-sm text-accent-50">{equipment.status}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary-400" />
                  <div>
                    <p className="text-xs text-accent-500">Last Service</p>
                    <p className="text-sm text-accent-50">{equipment.lastServiceDate}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <AlertTriangle className={`w-4 h-4 ${warrantyStatusColor}`} />
                  <div>
                    <p className="text-xs text-accent-500">Warranty Status</p>
                    <p className={`text-sm font-medium ${warrantyStatusColor}`}>{warrantyDetails.status} - {daysUntilExpiry} days left</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6 border-b border-accent-700">
          {(['overview', 'warranty', 'history'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 font-medium transition-colors border-b-2 ${
                activeTab === tab
                  ? 'border-primary-500 text-primary-400'
                  : 'border-transparent text-accent-500 hover:text-accent-300'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'warranty' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            <div className="border border-accent-700 rounded-lg bg-accent-900/50 p-6">
              <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-4">Warranty Details</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-accent-500">Warranty Type</p>
                  <p className="text-sm text-accent-50">{warrantyDetails.type}</p>
                </div>
                <div>
                  <p className="text-xs text-accent-500">Status</p>
                  <p className="text-sm text-success font-medium">{warrantyDetails.status}</p>
                </div>
                <div>
                  <p className="text-xs text-accent-500">Parts Coverage Expiry</p>
                  <p className="text-sm text-accent-50">{warrantyDetails.partsExpiry}</p>
                </div>
                <div>
                  <p className="text-xs text-accent-500">Labor Coverage Expiry</p>
                  <p className="text-sm text-accent-50">{warrantyDetails.laborExpiry}</p>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-accent-700">
                <p className="text-xs text-accent-500">Coverage</p>
                <p className="text-sm text-accent-50 mt-1">{warrantyDetails.coverage}</p>
              </div>
              <div className="mt-4 pt-4 border-t border-accent-700">
                <p className="text-xs text-accent-500">Notes</p>
                <p className="text-sm text-accent-50 mt-1">{warrantyDetails.notes}</p>
              </div>
            </div>
          </motion.div>
        )}

        {activeTab === 'history' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-3"
          >
            {serviceHistory.map((event, index) => (
              <motion.div
                key={event.date}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: index * 0.05 }}
                className="border border-accent-700 rounded-lg bg-accent-900/50 p-4 hover:bg-accent-800/50 transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-accent-50">{event.work}</p>
                    <p className="text-sm text-accent-400 mt-1">Technician: {event.technician}</p>
                  </div>
                  <p className="font-semibold text-primary-400">{event.cost}</p>
                </div>
                <p className="text-xs text-accent-500">{event.date}</p>
              </motion.div>
            ))}
          </motion.div>
        )}

        {activeTab === 'overview' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            <div className="border border-accent-700 rounded-lg bg-accent-900/50 p-6">
              <div className="flex items-center gap-2 mb-4">
                <FileText className="w-5 h-5 text-primary-400" />
                <h3 className="font-semibold text-accent-50">Available Documents</h3>
              </div>
              <div className="space-y-2">
                {documentsAvailable.map((doc) => (
                  <motion.div
                    key={doc.name}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center justify-between p-3 bg-accent-800/30 rounded hover:bg-accent-800/50 transition-colors"
                  >
                    <div>
                      <p className="text-sm text-accent-50 font-medium">{doc.name}</p>
                      <p className="text-xs text-accent-500">{doc.date} • {doc.type}</p>
                    </div>
                    <button className="p-2 hover:bg-accent-700 rounded transition-colors">
                      <Download className="w-4 h-4 text-primary-400" />
                    </button>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </main>
    </div>
  );
};
