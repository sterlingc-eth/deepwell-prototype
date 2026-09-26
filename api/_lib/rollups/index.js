/** Barrel export — see refresh.js and read.js for the actual implementation
 *  and doc comments (metrics, staleness model, ingest hook). */
export {
  METRICS,
  ROLLUPS_ENABLED,
  getCorpusStamp,
  refreshMetric,
  refreshAllRollups,
  _resetRollupsStateForTests,
} from './refresh.js';
export {
  getMetricRows,
  getBrandCounts,
  getDocTypeCounts,
  getCityCounts,
  getWarrantyStatusCounts,
  getOpenInvoiceTotals,
  _resetRollupsReadStateForTests,
} from './read.js';
