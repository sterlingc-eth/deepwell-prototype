// @ts-nocheck
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, AlertCircle, CheckCircle, Edit2, Save, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';

interface ExtractedField {
  name: string;
  value: string;
  confidence: number;
  source: string;
}

interface ExtractionItem {
  id: string;
  documentName: string;
  status: 'review' | 'approved' | 'needs-correction';
  fields: ExtractedField[];
  linkedEquipment?: string;
}

export const ExtractionReviewScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState(0);

  // Mock extracted data
  const extractions: ExtractionItem[] = [
    {
      id: 'ext-1',
      documentName: 'WorkOrder_2024-09-05_Residential.pdf',
      status: 'review',
      linkedEquipment: 'SN-LEN-987654',
      fields: [
        { name: 'Equipment Serial Number', value: 'SN-LEN-987654', confidence: 98, source: 'identification-section' },
        { name: 'Manufacturer', value: 'Lennox', confidence: 96, source: 'equipment-header' },
        { name: 'Model Number', value: 'XC21-046-230', confidence: 94, source: 'equipment-spec' },
        { name: 'Equipment Install Date', value: '2021-06-15', confidence: 91, source: 'system-info' },
        { name: 'Warranty Expiry Date', value: '2026-06-14', confidence: 97, source: 'warranty-stamp' },
        { name: 'Lead Technician Name', value: 'Maria Elena Garcia', confidence: 93, source: 'signature-block' },
        { name: 'Service Work Description', value: 'Seasonal PM: refrigerant charge, filter replacement, thermostat calibration, ductwork inspection', confidence: 85, source: 'work-notes-section' },
        { name: 'Labor Hours', value: '2.5', confidence: 90, source: 'billing-section' },
        { name: 'Parts Cost', value: '$127.50', confidence: 92, source: 'itemized-costs' },
        { name: 'Total Labor Cost', value: '$225.00', confidence: 91, source: 'labor-line' },
        { name: 'Total Invoice Amount', value: '$385.00', confidence: 96, source: 'total-due-line' },
      ],
    },
    {
      id: 'ext-2',
      documentName: 'Warranty_Certificate_Carrier_2024.pdf',
      status: 'review',
      linkedEquipment: 'SN-CAR-654321',
      fields: [
        { name: 'Equipment Serial Number', value: 'SN-CAR-654321', confidence: 99, source: 'certificate-header' },
        { name: 'Manufacturer Name', value: 'Carrier', confidence: 98, source: 'issuer-line' },
        { name: 'Model Number', value: 'ACP-12024-2023', confidence: 93, source: 'product-spec' },
        { name: 'Warranty Registration Date', value: '2023-08-22', confidence: 92, source: 'date-field' },
        { name: 'Parts Coverage Expiry Date', value: '2027-08-22', confidence: 99, source: 'parts-expiry' },
        { name: 'Labor Coverage Expiry Date', value: '2025-08-22', confidence: 98, source: 'labor-expiry' },
        { name: 'Warranty Type', value: 'Comprehensive - Parts and Labor Coverage', confidence: 94, source: 'coverage-summary' },
        { name: 'Coverage Limitations', value: 'Excludes: wear items, damage from improper maintenance, modifications', confidence: 86, source: 'exclusions-section' },
        { name: 'Dealer Name', value: 'Thompson HVAC Solutions', confidence: 89, source: 'authorized-dealer' },
      ],
    },
    {
      id: 'ext-3',
      documentName: 'Service_Records_FY2024_All_Assets.xlsx',
      status: 'review',
      fields: [
        { name: 'Total Service Records Parsed', value: '47 service events', confidence: 99, source: 'sheet-1-count' },
        { name: 'Unique Equipment Units', value: '12 systems', confidence: 98, source: 'unique-ID-column' },
        { name: 'Date Range Covered', value: 'Jan 2024 - Sept 2024', confidence: 97, source: 'header-row' },
        { name: 'Total Service Cost', value: '$8,925.50', confidence: 96, source: 'grand-total-cell' },
        { name: 'Most Frequently Serviced Unit', value: 'SN-RHE-445566 (8 visits)', confidence: 93, source: 'frequency-analysis' },
        { name: 'Primary Service Technician', value: 'David Chen', confidence: 91, source: 'technician-frequency' },
        { name: 'Secondary Technician', value: 'Maria Garcia', confidence: 87, source: 'technician-frequency' },
        { name: 'Average Cost Per Service', value: '$189.90', confidence: 94, source: 'calculated-average' },
        { name: 'Most Common Service Type', value: 'Preventive Maintenance', confidence: 85, source: 'service-type-summary' },
        { name: 'Equipment Status Summary', value: '11 systems operational, 1 system requires replacement assessment', confidence: 84, source: 'condition-notes' },
      ],
    },
  ];

  const current = extractions[currentIndex];
  const progress = ((currentIndex + 1) / extractions.length) * 100;

  const handleFieldEdit = (fieldName: string, newValue: string) => {
    setFieldValues(prev => ({
      ...prev,
      [fieldName]: newValue
    }));
  };

  const handleApprove = () => {
    if (currentIndex < extractions.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setEditingField(null);
      setFieldValues({});
    } else {
      setCurrentScreen('search');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 bg-accent-900 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setCurrentScreen('home')}
            className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-primary-400" />
          </motion.button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-accent-50">Review Extractions</h1>
            <p className="text-xs text-accent-400">
              Document {currentIndex + 1} of {extractions.length}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <p className="text-xs text-accent-500">Progress</p>
              <p className="font-mono text-sm text-primary-400">{Math.round(progress)}%</p>
            </div>
          </div>
        </div>
        {/* Progress Bar */}
        <div className="h-1 bg-accent-800">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            className="h-full bg-gradient-to-r from-primary-500 to-secondary-500"
          />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            {/* Document Info */}
            <div className="border border-accent-700 rounded-lg bg-accent-900/30 p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold text-accent-50">
                    {current.documentName}
                  </h2>
                  {current.linkedEquipment && (
                    <p className="text-sm text-primary-400 mt-1">
                      Linked Equipment: {current.linkedEquipment}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-success" />
                  <span className="text-xs text-success font-medium">Ready to Review</span>
                </div>
              </div>
            </div>

            {/* Extracted Fields */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-accent-400 uppercase tracking-wide">
                Extracted Information
              </h3>

              {current.fields.map((field, fieldIndex) => {
                const displayValue = fieldValues[field.name] !== undefined
                  ? fieldValues[field.name]
                  : field.value;
                const isEditing = editingField === field.name;
                const confidenceColor =
                  field.confidence >= 95 ? 'bg-success' :
                  field.confidence >= 85 ? 'bg-secondary-500' :
                  field.confidence >= 75 ? 'bg-warning' :
                  'bg-destructive';

                return (
                  <motion.div
                    key={field.name}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: fieldIndex * 0.03 }}
                    className="border border-accent-700 rounded-lg bg-accent-900/50 p-4 hover:bg-accent-900/70 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <p className="text-xs font-semibold text-primary-300 uppercase tracking-wide mb-1">
                          {field.name}
                        </p>
                        {isEditing ? (
                          <input
                            autoFocus
                            type="text"
                            value={displayValue}
                            onChange={(e) => handleFieldEdit(field.name, e.target.value)}
                            className="w-full px-2 py-1 rounded bg-accent-800 border border-primary-500 text-accent-50 text-sm"
                          />
                        ) : (
                          <p className="text-sm text-accent-50 font-medium">
                            {displayValue}
                          </p>
                        )}
                      </div>
                      <div className="flex-shrink-0 ml-4">
                        <div className="flex items-center gap-2">
                          <div className="text-right">
                            <p className="text-xs text-accent-500">Confidence</p>
                            <p className="font-mono text-sm text-primary-400">
                              {field.confidence}%
                            </p>
                          </div>
                          {isEditing ? (
                            <button
                              onClick={() => setEditingField(null)}
                              className="p-1.5 rounded bg-success/20 text-success hover:bg-success/30 transition-colors"
                            >
                              <Save className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              onClick={() => setEditingField(field.name)}
                              className="p-1.5 rounded bg-accent-800 hover:bg-accent-700 text-primary-400 transition-colors"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Confidence Bar */}
                    <div className="space-y-1">
                      <div className="h-1 bg-accent-800 rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${field.confidence}%` }}
                          transition={{ delay: fieldIndex * 0.05, duration: 0.6 }}
                          className={`h-full ${confidenceColor}`}
                        />
                      </div>
                      <p className="text-xs text-accent-500">
                        {field.confidence >= 95 && '✓ High confidence'}
                        {field.confidence >= 85 && field.confidence < 95 && '→ Good confidence'}
                        {field.confidence >= 75 && field.confidence < 85 && '⚠ Review recommended'}
                        {field.confidence < 75 && '⚠ Low confidence - please review'}
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-6 border-t border-accent-700">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setCurrentScreen('home')}
                className="flex-1 px-4 py-3 rounded-lg border border-accent-600 hover:bg-accent-800 text-accent-50 font-medium transition-colors"
              >
                Reject Document
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleApprove}
                className="flex-1 px-4 py-3 rounded-lg bg-primary-600 hover:bg-primary-700 text-accent-50 font-medium transition-colors"
              >
                {currentIndex < extractions.length - 1
                  ? 'Approve & Next'
                  : 'Approve & Done'}
              </motion.button>
            </div>
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};
