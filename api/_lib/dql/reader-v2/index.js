/**
 * Donovan Reader V2 (JS port). Entry points:
 *   const R = await loadReaderV2();                 // models + switches from ./data/bundle.json
 *   const ix = buildIndex(companyRecords, key);     // grounding index for ONE company's own records
 *   const r = await R.answer(ix, question);         // { answered, text, docs:[documentId], pages, pv, reason }
 */
import * as DN from './datenorm.js';
import * as EM from './entmatch.js';
import * as RV from './retr.js';
import * as AG from './aggv2.js';
import { Co, Index } from './reader.js';
import { loadModels, DATA_DIR } from './models.js';
import { decide } from './pipeline.js';

export function configureFromBundle(B) {
  const s = B.switches;
  DN.configure(s.date_value_norm); EM.configure(s.typo_match); RV.configure(s.retrieval_v2); AG.configure(s.agg_v2);
  const off = [];
  if (!s.date_value_norm?.on) off.push('date_value_norm'); if (!s.typo_match?.on) off.push('typo_match'); if (!s.retrieval_v2?.on) off.push('retrieval_v2'); if (!s.doctype?.on) off.push('doctype_match');
  if (off.length) throw new Error('switches required by this port are off in the bundle: ' + off.join(', '));
}
export function buildIndex(records, key = 'company') { return new Index(new Co(key, records)); }
export async function loadReaderV2(dir = DATA_DIR) {
  const M = await loadModels(dir); configureFromBundle(M.bundle);
  return { M, bundle: M.bundle, answer: (ix, q) => decide(ix, q, M) };
}
