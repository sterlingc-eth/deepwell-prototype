/** pipeline.js - port of lib/pipeline.py candidates() + lib/precfix.py (grounding check, release rule) + the decision of lib/work.py task_E. */
import { cleanQuestion } from './ext.js';
import { decide2, INTENTS, norm } from './reader2.js';
import * as S1 from './s1.js';
import { cues } from './models.js';
import { sortedBy } from './pyc.js';

const CUEK = ['min', 'max', 'early', 'late', 'sum', 'count', 'list', 'many'];
const CAND_INT = { field: 'text', clause: 'text', count0: 'count', who_by_address: 'who_addr', count_year: 'count_year' };
function candIntent(c) {
  const i = c.intent; const t = c.text || '';
  if (i === 'maxmin') return t.startsWith('Highest') ? 'max' : 'min';
  if (i === 'latest') return t.startsWith('Latest') ? 'latest' : 'earliest';
  return Object.prototype.hasOwnProperty.call(CAND_INT, i) ? CAND_INT[i] : i;
}
const OPP = { min: 'max', max: 'min', early: 'late', late: 'early' };
const CI = { min: 'min', max: 'max', earliest: 'early', latest: 'late', sum: 'sum', count: 'count', list: 'list', count_year: 'count' };
export const VF = ['p1', 'p2', 'margin', 'intent_id', 'has_doc', 'has_ent', 'has_type', 'has_date', 'ncorr', 's1_answered', 's1_intent_match', 'agree', 'docref', 'r_top', 'r_gap', 'r_cos', 'r_lex', 'r_field', 'r_allw', 'r_ncw', 'plural', 'qlen', 'src', 'p_cand', 'cue_support', 'cue_oppose', 'cand_intent_id',
  'fuzzy', 'syn', 'syn_cos', 'syn_margin', 'unk', 'email', 'n_filters', 'filt_year', 'filt_rel', 'filt_field', 'filt_range', 'r_pm', 'r_pm_gap', 'qlen_masked',
  'dt_conf', 'dt_margin', 'dt_kind', 'cr_on', 'cr_top', 'cr_margin', 'cr_prob', 'cr_rank', 'cr_lex', 'cr_agree', 'cr_bm25', 'cr_nc', 'f_amount',
  'ent_conf', 'ent_margin', 'ent_kind',
  'cr2_on', 'cr2_p', 'cr2_cal', 'cr2_margin', 'cr2_pnull', 'cr2_nullgap', 'cr2_agree_bm25', 'cr2_agree_cos', 'cr2_agree_lex', 'cr2_agree_rank', 'cr2_nagree', 'cr2_rrfgap', 'cr2_hd', 'cr2_cov', 'cr2_yn', 'cr2_nc', 'cr2_verb', 'cr2_verbhd',
  'dn_conf', 'dn_amb', 'dn_n',
  'gr_n', 'gr_miss', 'gr_qn', 'gr_qspan', 'gr_qdoc', 'gr_qnone',
  'agg_res', 'agg_amb', 'agg_n', 'agg_unk',
  'fx_ver', 'fx_agree', 'fx_route', 'fx_rel', 'fx_kind',
  'c3_on', 'c3_asc', 'c3_gap', 'c3_top', 'c3_marg', 'c3_agree', 'c3_rank', 'c3_ncw', 'c3_lexfrac', 'c3_assoc_only', 'c3_resc'];
const fnum = (v) => (v === undefined || v === null ? -1 : Number(v));
function vec(cand, src, out, q, P, masked) {
  const f = { ...out.feat }; f.qlen = q.split(/\s+/).filter((s) => s).length; f.src = src;
  const ci = src === 1 ? candIntent(cand) : out.intent;
  f.p_cand = P.has(ci) ? P.get(ci) : 0.0; f.cand_intent_id = INTENTS.indexOf(ci);
  const cv = cues(masked); const cu = {}; CUEK.forEach((k, i) => { cu[k] = cv[i]; });
  const k = Object.prototype.hasOwnProperty.call(CI, ci) ? CI[ci] : undefined;
  f.cue_support = k ? cu[k] : -1; f.cue_oppose = k && Object.prototype.hasOwnProperty.call(OPP, k) ? cu[OPP[k]] : -1;
  if (src === 1) f.agree = +(out.answered && out.text === cand.text);
  return VF.map((n) => fnum(f[n]));
}
// ---- precfix: verbatim-grounding of numbers
const NUM = /(?<![\w.,/-])\$?\d[\d,]*(?:\.\d+)?%?(?![\w/-]|\.\d)/g;
const DOCNO_RX = /\b[A-Za-z]{1,6}(?:-\d{2,7})+\b/g;
const MON_RX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/gi;
function canon(tok) {
  let t = tok.replace(/\$/g, '').replace(/,/g, ''); const pct = t.endsWith('%'); t = t.replace(/%+$/, '');
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.+$/, '');
  return t + (pct ? '%' : '');
}
export function numbers(text) {
  let t = (text || '').replace(DOCNO_RX, ' ').replace(MON_RX, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ');
  return new Set([...t.matchAll(NUM)].map((m) => canon(m[0])));
}
function questionNumbers(q) { const out = new Set(); for (const n of numbers(q)) { const b = n.replace(/%+$/, ''); if (/^(?:19|20)\d\d$/.test(b)) continue; out.add(n); } return out; }
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function answerBody(text, cite, intent) {
  let t = text || '';
  if (cite) { t = t.replace(new RegExp('\\s*\\(page \\d+,\\s*' + reEsc(cite) + '\\)\\s*$'), ''); t = t.split('(' + cite + ')').join(''); }
  t = t.replace(/^Yes\.\s+/, '');
  if (intent === 'field' || /^[A-Za-z][A-Za-z #./]{1,40}: /.test(t)) t = t.replace(/^[A-Za-z][A-Za-z #./]{1,40}:\s+/, '');
  return t.trim();
}
const TEXT_INTENTS = ['text', 'field', 'clause'];
export function grounding(ix, c, q, cfg) {
  const out = { gr_n: -1.0, gr_miss: -1.0, gr_qn: -1.0, gr_qspan: -1.0, gr_qdoc: -1.0, gr_qnone: -1.0, ungrounded: false };
  try {
    const docs = c.docs || [];
    if (docs.length !== 1 || !TEXT_INTENTS.includes(c.intent) || !ix.D.has(docs[0])) return out;
    const x = ix.D.get(docs[0]); const cite = ix.cite(x); const body = answerBody(c.text, cite, c.intent);
    const doc = ix.c.text(docs[0]) + '\n' + [...x.fields.values()].filter((v) => v).map(String).join('\n');
    const dn = numbers(doc), bn = numbers(body); const miss = [...bn].filter((n) => !dn.has(n));
    out.gr_n = bn.size; out.gr_miss = miss.length;
    const qn = questionNumbers(q); const q_ = [...qn];
    const inspan = q_.filter((n) => bn.has(n)), indoc = q_.filter((n) => !bn.has(n) && dn.has(n)), none = q_.filter((n) => !bn.has(n) && !dn.has(n));
    Object.assign(out, { gr_qn: q_.length, gr_qspan: inspan.length, gr_qdoc: indoc.length, gr_qnone: none.length });
    if (cfg.on && (cfg.hard_rule ?? true)) {
      if ((cfg.answer_side ?? true) && miss.length) out.ungrounded = true;
      if ((cfg.question_side ?? true) && indoc.length) out.ungrounded = true;
    }
  } catch (e) { /* the Python version swallows the same way */ }
  return out;
}
export async function candidates(ix, q, M) {
  const [q2, cleaned] = cleanQuestion(q);
  const out = await decide2(ix, q2, M, null, cleaned);
  const s1 = out.s1 || { answered: false }; delete out.s1; const g = out.g; delete out.g; const masked = g.masked;
  const P = await M.intentProba(masked); const res = [];
  if (out.answered) res.push([2, out, vec(out, 2, out, q2, P, masked)]);
  if (s1.answered && !(out.answered && norm(s1.text) === norm(out.text))) res.push([1, s1, vec(s1, 1, out, q2, P, masked)]);
  out.masked = masked;
  const gcfg = M.switches.grounding_check || {}; const gi = gcfg.on ? VF.indexOf('gr_n') : -1;
  for (const [, c, v] of res) {
    c._v = v;
    if (gi >= 0) { const gr = grounding(ix, c, q2, gcfg); v.splice(gi, 6, gr.gr_n, gr.gr_miss, gr.gr_qn, gr.gr_qspan, gr.gr_qdoc, gr.gr_qnone); c._ungrounded = gr.ungrounded; }
  }
  return [res, out, q2];
}
/** the release rule of this version (precfix.passes): verifier score against the version threshold, plus the verbatim-grounding hard rule */
export function passes(M, c, pv) {
  const T = M.thr; const pf = T.precfix || {};
  if (T.group_thr || pf.pmatch || pf.agree_hard) throw new Error('release options not supported by this port: ' + JSON.stringify({ group_thr: !!T.group_thr, pmatch: !!pf.pmatch, agree_hard: !!pf.agree_hard }));
  let thr = Number(T.thr);
  if (pf.guard && c._v) throw new Error('guard not supported by this port');
  if (pv < thr) return false;
  if (pf.grounding_hard && c._ungrounded) return false;
  return true;
}
/** the answer decision: both readers' candidates -> verifier -> release rule -> answer, or release */
export async function decide(ix, q, M) {
  const [res, out] = await candidates(ix, q, M);
  const ok = res.map(([, c, v]) => [M.verifier.score(v), c]);
  const sel = ok.filter(([pv, c]) => passes(M, c, pv));
  const base = { intent: out.intent };
  if (!sel.length) return { ...base, answered: false, text: ok.length ? 'Not on file / released: verifier_released ' + out.intent : out.text, docs: [], pv: Math.max(0.0, ...ok.map((z) => z[0])), reason: ok.length ? 'verifier_released' : (out.reason || ''), cands: ok.length };
  if (sel.length === 2 && norm(sel[0][1].text) !== norm(sel[1][1].text)) return { ...base, answered: false, text: 'disagree', docs: [], pv: Math.max(...sel.map((z) => z[0])), reason: 'disagree', cands: ok.length };
  let best = sel[0]; for (const z of sel) if (z[0] > best[0]) best = z;
  const [pv, c] = best;
  const pm = /\(page (\d+),/.exec(c.text); return { answered: true, text: c.text, docs: c.docs, page: c.page ?? (pm ? Number(pm[1]) : null), pv, intent: c.intent || out.intent, reason: '', cands: ok.length };
}
