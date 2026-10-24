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
import * as AF from './aggfilter1.js';
import * as LC from './labelclause.js';
import * as FX from './fieldsv2.js';
import * as RP from './realtyprec.js';
import * as RK from './rankv2.js';
import * as XD from './xdocv1.js';
import * as HP from './hardprec.js';
import * as HV2 from './hardv2.js';
import * as HV3 from './hardv3.js';
import * as HV4 from './hardv4.js';
import * as SL1 from './synlex1.js';
import * as MPR from './mainprec.js';
import * as MP2 from './mainprec2.js';
import * as W6 from './watch6.js';
import * as WPR from './wildprec.js';
import * as WP2 from './wildprec2.js';
import * as MR2 from './mrprec2.js';
import * as CF2 from './clausefree2.js';
import * as PV1 from './pv1.js';
import * as CC from './clausecompat.js';
import * as AG1 from './agree1.js';
import * as MP1 from './mentionparty.js';
import * as TRP from './typorepair.js';
import * as CA from './cueagree.js';
import * as MPAIR1 from './mainpair1.js';
import * as DA1 from './doctypealias1.js';
import * as AD2 from './anydoc.js';
import * as EG from './evidence.js';
import { configureStemFix } from './reader.js';
import { U, RULES, configureUnified } from './unified1.js';
const MODULES = [['agg_filter_v1', AF], ['label_clause_v1', LC], ['fields_v2', FX], ['realty_prec_v1', RP], ['rank_v2', RK], ['xdoc_v1', XD], ['hard_v1', HP], ['hard_v2', HV2], ['hard_v3', HV3], ['hard_v4', HV4],
  ['syn_lex_v1', SL1], ['main_prec_v1', MPR], ['main_prec_v2', MP2], ['watch6_veto', W6], ['wild_prec_v1', WPR], ['wild_prec_v2', WP2], ['mr_prec_v2', MR2], ['clause_free_v2', CF2], ['present_value_v1', PV1],
  ['clause_retrain_v2', CC], ['agree_v1', AG1], ['mention_party_v1', MP1], ['typo_repair_v1', TRP], ['cue_agree_v1', CA], ['mainpair_v1', MPAIR1]];

export function configureFromBundle(B) {
  const s = B.switches;
  DN.configure(s.date_value_norm); EM.configure(s.typo_match); RV.configure(s.retrieval_v2); AG.configure(s.agg_v2);
  for (const [k, m] of MODULES) m.configure(s[k]);
  // unified rulebook (env DONOVAN_READER_V2_UNIFIED, default OFF): alias_compound_v1 + stem_fix_v1 + anydoc2_v1 + determinism_v1 canon; OFF = unchanged behaviour
  EG.configureEvidence();                                     // evidence_gate (env DONOVAN_READER_V2_EVIDENCE, default OFF)
  const uni = configureUnified(); DA1.configure(uni ? RULES.alias_compound_v1 : null); configureStemFix(uni && RULES.stem_fix_v1 === true);
  if (s.clause_v3?.on || s.mainpair_v2?.on) throw new Error('switches not supported by this port are on in the bundle: clause_v3 / mainpair_v2');
  const off = [];
  if (!s.date_value_norm?.on) off.push('date_value_norm'); if (!s.typo_match?.on) off.push('typo_match'); if (!s.retrieval_v2?.on) off.push('retrieval_v2'); if (!s.doctype?.on) off.push('doctype_match');
  if (off.length) throw new Error('switches required by this port are off in the bundle: ' + off.join(', '));
}
/** opts.pack (or records.packWording): the company is an industry-pack company, the only kind anydoc2_v1 answers for (unified rulebook; never consulted while the switch is off) */
export function buildIndex(records, key = 'company', opts = {}) {
  const ix = new Index(new Co(key, records));
  ix.pack = !!(opts.pack ?? records.packWording); ix.rawPages = records.pages; ix.records = records;
  return ix;
}
export async function loadReaderV2(dir = DATA_DIR) {
  const M = await loadModels(dir); configureFromBundle(M.bundle);
  return {
    M, bundle: M.bundle,
    answer: async (ix, q) => {
      let r = await decide(ix, q, M);
      if (U.on && !r.answered && ix.pack) { const a = AD2.maybe(ix, ix.rawPages, q, r); if (a !== null) r = a; }      // anydoc2_v1: second tier for a released question, industry-pack companies only
      if (EG.EV.on && r.answered) { const g = EG.gate(ix, q, r); if (g !== null) r = g; }      // evidence_gate: last step, default OFF
      return r;
    },
  };
}
