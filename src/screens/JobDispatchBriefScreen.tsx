// @ts-nocheck
import React from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Share2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { EquipmentCard, WarrantyStatusBadge, ServiceHistoryTimeline } from '../components';
import { properties, equipment } from '../mocks/data';

export const JobDispatchBriefScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const selectedEquipment = useAppStore((s) => s.selectedEquipment);

  // Use selected equipment or demo data (first equipment unit)
  const displayEquipment = selectedEquipment || equipment?.[0];

  if (!displayEquipment) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800 flex items-center justify-center">
        <div className="text-center">
          <p className="text-accent-400 mb-4">No equipment data available</p>
          <button
            onClick={() => setCurrentScreen('home')}
            className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg"
          >
            Return to Home
          </button>
        </div>
      </div>
    );
  }

  const property = properties.find((p) => p.id === displayEquipment.propertyId);

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800 dark:from-accent-900 dark:to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 dark:border-accent-600 bg-accent-900 dark:bg-accent-800/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setCurrentScreen('search')}
              className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-primary-400" />
            </motion.button>
            <div>
              <h1 className="text-2xl font-bold text-accent-50">Job Dispatch Brief</h1>
              <p className="text-xs text-accent-400">Equipment context before technician arrival</p>
            </div>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors text-sm font-medium"
          >
            <Share2 className="w-4 h-4" />
            Share Brief
          </motion.button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Property Info */}
        {property && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-6"
          >
            <h2 className="text-lg font-bold text-accent-50 mb-4">Customer Property</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-accent-400 mb-1">Address</p>
                <p className="font-mono text-sm text-primary-400">{property.address}</p>
              </div>
              <div>
                <p className="text-xs text-accent-400 mb-1">City</p>
                <p className="text-sm text-accent-300">{property.city}, {property.state}</p>
              </div>
              <div>
                <p className="text-xs text-accent-400 mb-1">Customer</p>
                <p className="text-sm text-accent-300">{property.customerName}</p>
              </div>
              <div>
                <p className="text-xs text-accent-400 mb-1">Equipment Count</p>
                <p className="text-sm text-accent-300">{property.equipment.length} unit{property.equipment.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
          </motion.div>
        )}

        {/* Equipment Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <h2 className="text-lg font-bold text-accent-50 mb-4">Equipment Details</h2>
          <EquipmentCard
            equipment={displayEquipment}
            expandable={false}
            showFullHistory={true}
          />
        </motion.div>

        {/* Warranty Status Section */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-8 bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-6"
        >
          <h3 className="text-lg font-bold text-accent-50 mb-4">Warranty Status</h3>
          <div className="mb-4">
            <WarrantyStatusBadge warranty={displayEquipment} showLabel />
          </div>

          {displayEquipment.warrantyExpiry && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              {displayEquipment.partsExpiryDate && (
                <div>
                  <p className="text-xs text-accent-400 mb-1">Parts Coverage</p>
                  <p className="font-mono text-primary-400">
                    {displayEquipment.partsExpiryDate.toLocaleDateString()}
                  </p>
                </div>
              )}
              {displayEquipment.laborExpiryDate && (
                <div>
                  <p className="text-xs text-accent-400 mb-1">Labor Coverage</p>
                  <p className="font-mono text-primary-400">
                    {displayEquipment.laborExpiryDate.toLocaleDateString()}
                  </p>
                </div>
              )}
              {displayEquipment.compressorExpiryDate && (
                <div>
                  <p className="text-xs text-accent-400 mb-1">Compressor Coverage</p>
                  <p className="font-mono text-primary-400">
                    {displayEquipment.compressorExpiryDate.toLocaleDateString()}
                  </p>
                </div>
              )}
            </div>
          )}
        </motion.div>

        {/* Service History */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-6"
        >
          <h3 className="text-lg font-bold text-accent-50 mb-4">Service History</h3>
          <ServiceHistoryTimeline equipment={selectedEquipment} />
        </motion.div>

        {/* Action Buttons */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="mt-8 flex gap-4"
        >
          <button
            onClick={() => setCurrentScreen('search')}
            className="flex-1 px-4 py-3 bg-accent-700 hover:bg-accent-600 text-accent-50 rounded-lg font-medium transition-colors"
          >
            Search Again
          </button>
          <button
            onClick={() => {
              useAppStore.getState().toggleSelectForExport(displayEquipment);
              setCurrentScreen('warranty-export');
            }}
            className="flex-1 px-4 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-medium transition-colors"
          >
            Export Warranty
          </button>
        </motion.div>
      </main>
    </div>
  );
};
