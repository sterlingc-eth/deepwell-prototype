// @ts-nocheck
import React, { useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, File, FileText, Image, Loader, CheckCircle, AlertCircle, Menu } from 'lucide-react';
import { useAppStore } from '../store/appStore';

export const DocumentIngestionScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadedFiles, setUploadedFiles] = useState<Array<{
    id: string;
    name: string;
    type: 'pdf' | 'image' | 'spreadsheet';
    status: 'uploading' | 'processing' | 'complete' | 'error';
    progress: number;
  }>>([]);
  const [showMenu, setShowMenu] = useState(false);

  const menuItems = [
    { label: 'Dashboard', screen: 'dashboard' as const },
    { label: 'On-Site Search', screen: 'search' as const },
    { label: 'Warranty Tracking', screen: 'warranty-tracking' as const },
    { label: 'Job Dispatch Brief', screen: 'dispatch-brief' as const },
    { label: 'Warranty Export', screen: 'warranty-export' as const },
  ];

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const processFile = (file: File) => {
    const fileId = `${file.name}-${Date.now()}`;
    const fileType = getFileType(file.type);

    setUploadedFiles(prev => [...prev, {
      id: fileId,
      name: file.name,
      type: fileType,
      status: 'uploading',
      progress: 0
    }]);

    // Simulate upload
    let progress = 0;
    const uploadInterval = setInterval(() => {
      progress += Math.random() * 30;
      if (progress >= 100) {
        progress = 100;
        clearInterval(uploadInterval);

        // Simulate extraction
        setTimeout(() => {
          setUploadedFiles(prev => prev.map(f =>
            f.id === fileId ? { ...f, status: 'processing', progress: 100 } : f
          ));
        }, 300);

        // Simulate completion
        setTimeout(() => {
          setUploadedFiles(prev => prev.map(f =>
            f.id === fileId ? { ...f, status: 'complete' } : f
          ));
        }, 2000);
      }

      setUploadedFiles(prev => prev.map(f =>
        f.id === fileId ? { ...f, progress: Math.min(progress, 99) } : f
      ));
    }, 200);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = e.dataTransfer.files;
    Array.from(files).forEach(file => processFile(file));
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      Array.from(e.target.files).forEach(file => processFile(file));
    }
  };

  const getFileType = (mimeType: string): 'pdf' | 'image' | 'spreadsheet' => {
    if (mimeType.includes('pdf')) return 'pdf';
    if (mimeType.includes('image')) return 'image';
    if (mimeType.includes('spreadsheet') || mimeType.includes('sheet') || mimeType.includes('excel')) return 'spreadsheet';
    return 'pdf';
  };

  const getFileIcon = (type: 'pdf' | 'image' | 'spreadsheet') => {
    switch (type) {
      case 'pdf':
        return <FileText className="w-5 h-5" />;
      case 'image':
        return <Image className="w-5 h-5" />;
      case 'spreadsheet':
        return <File className="w-5 h-5" />;
    }
  };

  const completeCount = uploadedFiles.filter(f => f.status === 'complete').length;
  const hasComplete = completeCount > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 bg-accent-900 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-6 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-accent-50">DeepWell</h1>
            <p className="text-sm text-accent-400 mt-1">Intelligent document layer for HVAC contractors</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowMenu(!showMenu)}
                className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
              >
                <Menu className="w-5 h-5 text-primary-400" />
              </motion.button>
              <AnimatePresence>
                {showMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="absolute right-0 mt-2 w-48 bg-accent-800 border border-accent-700 rounded-lg shadow-lg py-2 z-10"
                  >
                    {menuItems.map((item) => (
                      <button
                        key={item.screen}
                        onClick={() => {
                          setCurrentScreen(item.screen);
                          setShowMenu(false);
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-accent-200 hover:bg-accent-700 transition-colors"
                      >
                        {item.label}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              disabled={!hasComplete}
              onClick={() => setCurrentScreen('extraction-review')}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                hasComplete
                  ? 'bg-primary-500 hover:bg-primary-600 text-accent-50'
                  : 'bg-accent-700 text-accent-500 cursor-not-allowed'
              }`}
            >
              Review Extractions ({completeCount})
            </motion.button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 py-12">
        {/* Upload Area */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={`
              border-2 border-dashed rounded-2xl p-12
              transition-all cursor-pointer
              ${dragActive
                ? 'border-primary-400 bg-primary-900/20'
                : 'border-accent-600 hover:border-primary-500 hover:bg-accent-800/30'
              }
            `}
          >
            <div className="text-center">
              <motion.div
                animate={{ scale: dragActive ? 1.1 : 1 }}
                className="mb-4 flex justify-center"
              >
                <Upload className={`w-12 h-12 ${dragActive ? 'text-primary-400' : 'text-primary-300'}`} />
              </motion.div>
              <h2 className="text-xl font-semibold text-accent-50 mb-2">
                Upload Equipment Documents
              </h2>
              <p className="text-accent-400 mb-4">
                Drag and drop photos, PDFs, or spreadsheets here
              </p>
              <label className="inline-block">
                <span className="px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-accent-50 font-medium cursor-pointer transition-colors">
                  Select Files
                </span>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png,.gif,.xlsx,.xls,.csv"
                  onChange={handleFileInput}
                  className="hidden"
                />
              </label>
              <p className="text-xs text-accent-500 mt-4">
                Supported: PDF, JPG, PNG, Excel, CSV
              </p>
            </div>
          </div>
        </motion.div>

        {/* Upload List */}
        <AnimatePresence>
          {uploadedFiles.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-accent-400">
                  Uploaded Documents ({uploadedFiles.length})
                </h3>
                <button
                  onClick={() => setUploadedFiles([])}
                  className="text-xs text-accent-500 hover:text-accent-300 transition-colors"
                >
                  Clear All
                </button>
              </div>

              {uploadedFiles.map((file, index) => (
                <motion.div
                  key={file.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="border border-accent-700 rounded-lg bg-accent-900/50 p-4"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex-shrink-0 text-primary-400 pt-1">
                      {getFileIcon(file.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="text-sm font-medium text-accent-50 truncate">
                            {file.name}
                          </p>
                          <p className="text-xs text-accent-500 capitalize">
                            {file.type}
                          </p>
                        </div>
                        <div className="flex-shrink-0">
                          {file.status === 'complete' && (
                            <CheckCircle className="w-5 h-5 text-success" />
                          )}
                          {file.status === 'processing' && (
                            <Loader className="w-5 h-5 text-primary-400 animate-spin" />
                          )}
                          {file.status === 'uploading' && (
                            <Loader className="w-5 h-5 text-accent-500 animate-spin" />
                          )}
                        </div>
                      </div>

                      {/* Progress Bar */}
                      <div className="space-y-1">
                        <div className="h-1.5 bg-accent-800 rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${file.progress}%` }}
                            className="h-full bg-gradient-to-r from-primary-500 to-secondary-500"
                          />
                        </div>
                        <p className="text-xs text-accent-500">
                          {file.status === 'uploading' && `Uploading... ${file.progress}%`}
                          {file.status === 'processing' && `Extracting data...`}
                          {file.status === 'complete' && `Ready for review`}
                        </p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tips Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mt-12 p-6 border border-accent-700 rounded-lg bg-accent-900/30"
        >
          <h3 className="font-semibold text-accent-50 mb-3">Tips for Best Results</h3>
          <ul className="space-y-2 text-sm text-accent-400">
            <li>📸 Clear photos of equipment serial numbers work best</li>
            <li>📄 PDFs should be at least 300 DPI for accurate OCR</li>
            <li>📊 Spreadsheets are parsed for warranty dates and equipment data</li>
            <li>✅ AI extracts: serial numbers, warranty dates, technician names, costs</li>
            <li>🔍 You'll review and approve extractions before they're linked</li>
          </ul>
        </motion.div>

        {/* Sample Files Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-6 p-6 border border-secondary-700 rounded-lg bg-secondary-900/30"
        >
          <h3 className="font-semibold text-accent-50 mb-3">Try with Sample Files</h3>
          <p className="text-sm text-accent-400 mb-4">Download example documents to test the extraction workflow:</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <a
              href="/samples/sample_workorder.txt"
              download="sample_workorder.txt"
              className="p-3 rounded-lg border border-secondary-600 hover:border-secondary-500 hover:bg-secondary-800/50 transition-colors text-sm font-medium text-secondary-300 hover:text-secondary-200 flex items-center gap-2"
            >
              <File className="w-4 h-4" />
              Work Order
            </a>
            <a
              href="/samples/sample_warranty.txt"
              download="sample_warranty.txt"
              className="p-3 rounded-lg border border-secondary-600 hover:border-secondary-500 hover:bg-secondary-800/50 transition-colors text-sm font-medium text-secondary-300 hover:text-secondary-200 flex items-center gap-2"
            >
              <FileText className="w-4 h-4" />
              Warranty Certificate
            </a>
            <a
              href="/samples/sample_servicerecords.csv"
              download="sample_servicerecords.csv"
              className="p-3 rounded-lg border border-secondary-600 hover:border-secondary-500 hover:bg-secondary-800/50 transition-colors text-sm font-medium text-secondary-300 hover:text-secondary-200 flex items-center gap-2"
            >
              <File className="w-4 h-4" />
              Service Records
            </a>
          </div>
        </motion.div>
      </main>
    </div>
  );
};
