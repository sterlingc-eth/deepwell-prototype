// @ts-nocheck
import React, { useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Download, Plus, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { EquipmentCard, DataField } from '../components';
import { equipment } from '../mocks/data';
import html2canvas from 'html2canvas';
// @ts-ignore
import { jsPDF } from 'jspdf';

export const WarrantyExportScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const selectedForExport = useAppStore((s) => s.selectedForExport);
  const toggleSelectForExport = useAppStore((s) => s.toggleSelectForExport);
  const clearExportSelection = useAppStore((s) => s.clearExportSelection);
  const pdfRef = useRef<HTMLDivElement>(null);

  // Use selected equipment or demo data (first equipment unit)
  const displayForExport = selectedForExport.length > 0 ? selectedForExport : [equipment[0]];

  const handleGeneratePDF = async () => {
    if (!pdfRef.current || displayForExport.length === 0) return;

    try {
      const canvas = await html2canvas(pdfRef.current, {
        backgroundColor: '#1f2937',
        scale: 2,
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgWidth = 210;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= 297;

      while (heightLeft >= 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= 297;
      }

      pdf.save('warranty-claim.pdf');
    } catch (error) {
      console.error('PDF generation failed:', error);
    }
  };

  const allWarrantyStatus = displayForExport.map((eq) => {
    const now = new Date();
    const expiry = eq.warrantyExpiry;
    if (!expiry) return { status: 'none', daysLeft: null };
    if (now > expiry) return { status: 'expired', daysLeft: null };
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return { status: daysLeft < 30 ? 'expiring' : 'active', daysLeft };
  });

  const readyForClaim = displayForExport.every(
    (eq) =>
      eq.serialNumber &&
      eq.installDate &&
      eq.installedByTechName &&
      eq.warrantyExpiry &&
      new Date() <= eq.warrantyExpiry
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800 dark:from-accent-900 dark:to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 dark:border-accent-600 bg-accent-900 dark:bg-accent-800/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setCurrentScreen('home')}
              className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-primary-400" />
            </motion.button>
            <div>
              <h1 className="text-2xl font-bold text-accent-50">Warranty Export</h1>
              <p className="text-xs text-accent-400">Prepare insurance claims</p>
            </div>
          </div>
          {displayForExport.length > 0 && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleGeneratePDF}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Download className="w-4 h-4" />
              Download PDF
            </motion.button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        <>
          {/* Selected Equipment */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-accent-50">
                Selected Equipment ({displayForExport.length})
              </h2>
              {selectedForExport.length > 0 && (
                <button
                  onClick={clearExportSelection}
                  className="text-xs text-accent-400 hover:text-accent-300 px-3 py-1 rounded hover:bg-accent-800 transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>

            <div className="space-y-3 mb-6">
              {displayForExport.map((eq, index) => (
                <motion.div
                  key={eq.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex items-start gap-4 bg-accent-800 dark:bg-accent-700 border border-accent-700 dark:border-accent-600 rounded-lg p-4"
                >
                  <div className="flex-1">
                    <div className="font-mono font-bold text-primary-400 mb-1">
                      {eq.serialNumber}
                    </div>
                    <div className="text-sm text-accent-300">
                      {eq.manufacturer} {eq.modelNumber}
                    </div>
                  </div>
                  {selectedForExport.includes(eq) && (
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={() => toggleSelectForExport(eq)}
                      className="p-2 hover:bg-accent-600 rounded transition-colors"
                    >
                      <X className="w-4 h-4 text-accent-400" />
                    </motion.button>
                  )}
                </motion.div>
              ))}
            </div>

            {/* Warranty Status Check */}
            <div className="bg-primary-900/30 border border-primary-700 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-primary-300 mb-3">Claim Readiness</h3>
              <div className="space-y-2 text-sm">
                {displayForExport.map((eq, idx) => {
                  const status = allWarrantyStatus[idx];
                  const isReady =
                    eq.serialNumber &&
                    eq.installDate &&
                    eq.installedByTechName &&
                    eq.warrantyExpiry &&
                    new Date() <= eq.warrantyExpiry;

                  return (
                    <div
                      key={eq.id}
                      className="flex items-center justify-between"
                    >
                      <span className="text-accent-300">{eq.serialNumber}</span>
                      <span
                        className={`text-xs font-mono ${
                          isReady ? 'text-success' : 'text-warning'
                        }`}
                      >
                        {isReady
                          ? '✓ Ready for claim'
                          : status.status === 'expired'
                            ? '✗ Warranty expired'
                            : '⚠ Missing data'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>

            {/* PDF Preview */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-8"
            >
              <h2 className="text-lg font-bold text-accent-50 mb-4">Warranty Claim Document</h2>

              {/* PDF Content */}
              <div
                ref={pdfRef}
                className="bg-white text-black p-8 rounded-lg shadow-lg"
              >
                {/* Header */}
                <div className="border-b-2 border-gray-300 pb-4 mb-6">
                  <h1 className="text-2xl font-bold text-primary-900">WARRANTY CLAIM</h1>
                  <p className="text-gray-600 text-sm">
                    Generated by DeepWell • {new Date().toLocaleDateString()}
                  </p>
                </div>

                {/* Equipment Details */}
                {displayForExport.map((eq, index) => (
                  <div key={eq.id} className="mb-8 pb-8 border-b border-gray-300">
                    <h2 className="text-lg font-bold text-gray-900 mb-4">
                      Equipment #{index + 1}
                    </h2>

                    {/* Grid Layout */}
                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">
                          SERIAL NUMBER
                        </p>
                        <p className="font-mono font-bold text-lg text-primary-900">
                          {eq.serialNumber}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">MODEL</p>
                        <p className="font-bold text-primary-900">{eq.modelNumber}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">
                          MANUFACTURER
                        </p>
                        <p className="text-gray-900">{eq.manufacturer}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">TYPE</p>
                        <p className="text-gray-900">{eq.equipmentType}</p>
                      </div>
                    </div>

                    {/* Installation Info */}
                    <div className="bg-gray-100 p-4 rounded mb-6">
                      <h3 className="font-semibold text-gray-900 mb-3">Installation Details</h3>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <p className="text-gray-600 text-xs mb-1">Installed Date</p>
                          <p className="font-semibold text-gray-900">
                            {eq.installDate.toLocaleDateString()}
                          </p>
                        </div>
                        <div>
                          <p className="text-gray-600 text-xs mb-1">Installed By</p>
                          <p className="font-semibold text-gray-900">
                            {eq.installedByTechName}
                          </p>
                        </div>
                        {eq.epaCertType && (
                          <div>
                            <p className="text-gray-600 text-xs mb-1">EPA Certification</p>
                            <p className="font-semibold text-gray-900">{eq.epaCertType}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Warranty Info */}
                    {eq.warrantyExpiry && (
                      <div className="bg-primary-50 border-2 border-primary-200 p-4 rounded">
                        <h3 className="font-semibold text-primary-900 mb-3">Warranty Coverage</h3>
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          {eq.partsExpiryDate && (
                            <div>
                              <p className="text-gray-600 text-xs mb-1">Parts</p>
                              <p className="font-semibold text-primary-900">
                                {eq.partsExpiryDate.toLocaleDateString()}
                              </p>
                            </div>
                          )}
                          {eq.laborExpiryDate && (
                            <div>
                              <p className="text-gray-600 text-xs mb-1">Labor</p>
                              <p className="font-semibold text-primary-900">
                                {eq.laborExpiryDate.toLocaleDateString()}
                              </p>
                            </div>
                          )}
                          {eq.compressorExpiryDate && (
                            <div>
                              <p className="text-gray-600 text-xs mb-1">Compressor</p>
                              <p className="font-semibold text-primary-900">
                                {eq.compressorExpiryDate.toLocaleDateString()}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Footer */}
                <div className="text-center text-xs text-gray-500 pt-4 border-t border-gray-300">
                  <p>This document was generated by DeepWell Warranty Management System</p>
                  <p>Please verify all details before submitting to the manufacturer</p>
                </div>
              </div>
            </motion.div>

          {/* Actions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="flex gap-4"
          >
            <button
              onClick={() => setCurrentScreen('search')}
              className="flex-1 px-4 py-3 bg-accent-700 hover:bg-accent-600 text-accent-50 rounded-lg font-medium transition-colors"
            >
              Add More Equipment
            </button>
            <button
              onClick={handleGeneratePDF}
              disabled={!readyForClaim}
              className={`
                flex-1 px-4 py-3 rounded-lg font-medium transition-colors
                flex items-center justify-center gap-2
                ${
                  readyForClaim
                    ? 'bg-primary-600 hover:bg-primary-700 text-white'
                    : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                }
              `}
            >
              <Download className="w-4 h-4" />
              Download Warranty Claim PDF
            </button>
          </motion.div>
        </>
      </main>
    </div>
  );
};
