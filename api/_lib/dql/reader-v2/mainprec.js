/** mainprec.js - port of lib/mainprec.py (main_prec_v1): stricter-only text vetoes (phantom echoed filter, dropped filter, stock clause topic, field-ranked answer, foreign label, date event). */
import { lev } from './pyx.js';

const ALL = ['phantom', 'filt_dropped', 'clause_concept', 'rank_field', 'label_foreign', 'date_event'];
let CFG = { on: false, rules: ALL };
export const configure = (d) => { CFG = { on: false, rules: ALL, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
export { lev };
const DATEY = /^(?:\d{4}(?:-\d\d)?(?:-\d\d)?|q[1-4] \d{4}|late q[1-4] \d{4}|early q[1-4] \d{4}|mid q[1-4] \d{4}|h[12] \d{4}|this (?:year|month|quarter|week)|last (?:year|month|quarter|week)|past[ \w]*|before .*|after .*|since .*|prior to .*|between .*|under .*|over .*|at least .*|at most .*|up to .*|within .*|ytd)$/;
export function phantom(q, a) {
  const head = a.split(' (page')[0];
  const m = (head.includes(' on file') || ['Total of', 'Latest', 'Earliest', 'Highest', 'Lowest'].some((p) => head.startsWith(p)) || head.includes(' among '))
    ? /\(([^()]*)\)[:.]?(?:\s*\$?[\d,.-]+)?\.?$/.exec(head) : null;
  if (!m) return null;
  const ql = q.toLowerCase().replace(/\boffice (?:review|use|copy|file|hours)\b/g, '');
  const qs = new Set(ql.match(/[a-z0-9]+/g) || []); const qst = new Set([...qs].map((w) => w.slice(0, 5)));
  for (const it of m[1].split(',').map((x) => x.trim())) {
    const il = it.toLowerCase();
    if (!il || DATEY.test(il) || /^[$\d]/.test(il)) continue;
    const ws = il.match(/[a-z]{4,}/g) || [];
    if (!ws.length) continue;
    if (!ws.some((w) => qst.has(w.slice(0, 5)) || [...qs].some((t) => t.length >= 5 && lev(w, t, 1) <= 1))) return 'phantom';
  }
  return null;
}
const F = /\b(?:marked|listed as|labell?ed|tagged|flagged|that are|and are|which are|and that are|that is|and that is|with status|status of|status)\s+((?:[a-z0-9'-]+ ?){1,3})/;
const ST = new Set('the a an of in on for and or to is are was were by at from with this that these those my our us me it as if when you please thx thanks'.split(' '));
export function filtDropped(q, a) {
  const m = F.exec(q.toLowerCase());
  if (!m || !/^(?:.* has )?\d|^Total of|^(Latest|Earliest|Highest|Lowest) /.test(a)) return null;
  if (/^(?:.* has )?0 /.test(a)) return null;
  const ws = (m[1].match(/[a-z0-9]+/g) || []).filter((w) => !ST.has(w) && !/^\d+$/.test(w));
  if (!ws.length) return null;
  const al = a.toLowerCase();
  return ws.some((w) => al.includes(w.slice(0, 5))) ? null : 'filt_dropped';
}
const TPL = [
  ['workman', 'warrant guarant workman defect cover labor labour warranty guarantee'],
  ['late bal', 'late fee penal interest overdue accru balanc past due charg delinq'],
  ['payment is', 'due payment terms net pay when deadline day'],
  ['a deposit', 'deposit retain down advance upfront'],
  ['this estimate', 'estimate valid expir quote honor good'],
  ['rates fix', 'rate pric fix lock fee cost'],
  ['returns acc', 'return refund exchang restock'],
  ['supplier del', 'deliver lead ship arriv supplier'],
  ['renews auto', 'renew auto cancel evergreen rollov term'],
  ['this agreement runs', 'length long durat period runs run expir valid end month year term'],
  ['estimated total', 'total pric cost amount estimat how much quote'],
  ['we accept bank', 'bank transfer payment method pay accept wire ach'],
];
const TPL2 = [
  ['a hearing can be requested', 'hearing request appeal dispute contest violation fine notice'],
  ['landlord responds to emergency', 'emergenc repair respon maintenance urgent'],
  ["owner's title policy premium", 'title premium policy insur owner cost fee'],
  ['charges applied against the deposit', 'deposit deduct charg withh return refund secur'],
  ['landlord returns the deposit', 'deposit deduct return refund withh secur'],
  ['showings are by appointment', 'showing appoint appion access tour view notice'],
  ['cure the violation within', 'cure violation fix remed correct notice deadline'],
  ['repairs over', 'repair approv threshold limit spend authoriz written owner'],
  ['accounts more than', 'late delinq overdue past due collect account lien'],
  ['cooperating broker compensation', 'cooperat compens commission broker coop buyer agent split'],
  ['economic vacancy', 'vacan econom loss'],
  ['resale certificate fee', 'resale certificate fee transfer cost'],
  ['the final walkthrough is held', 'walk final inspect closing'],
  ['discounts given to residents', 'discount concess resident waive free'],
  ['buyers should have the property professionally', 'inspect professional property'],
  ['failure to clean the carpets', 'carpet clean'],
  ['owners may lease the home', 'leas rental rent owner restrict'],
  ['the appraisal is subject to completion', 'subject complet repair apprais condition'],
  ['rentals are limited', 'rental limit leas cap'],
  ['amount due on the account', 'amount due account balance owe'],
  ['work above', 'approv owner limit threshold spend work authoriz permission'],
  ['the association holds', 'associat hold percent reserve retain'],
  ['the appraiser charged', 'apprais fee charge cost'],
  ['buyer funds must be wired', 'fund wire cutoff deadline'],
  ['a closing walkthrough takes place', 'walk closing'],
  ['price is lowered', 'price lower reduc cut adjust'],
  ['the tenant currently owes', 'owe balance due arrear delinq tenant'],
  ['a tenant is reported delinquent', 'delinq late report overdue'],
  ['we inspect the unit within', 'inspect vacat walk move'],
  ['cooperating', 'cooperat compens commission'],
  ['buyer has # days to investigate', 'investigat diligence inspect'],
  ['this contract is conditioned', 'lender financ loan condition contingenc approv mortgage'],
  ['funding cutoff', 'fund cutoff wire deadline'],
  ['a good faith deposit', 'deposit earnest faith emd escrow'],
  ['the office charges', 'office charg fee admin file'],
  ['the close of escrow is pushed out', 'close escrow extend push delay adjust coe'],
].map(([p, k]) => [p.replace(/\d+/g, '#'), k]);
function hit(toks, kws) {
  for (const t of toks) for (const k of kws) {
    if (t.startsWith(k)) return true;
    if (t.length >= 5 && k.length >= 5) { const m = k.length >= 7 ? 2 : 1; if (lev(t, k, m) <= m) return true; }
  }
  return false;
}
export function clauseConcept(q, a) {
  if (!a.includes(' (page')) return null;
  const h = a.split(' (page')[0].trim().replace(/^Yes\.\s*/, '').toLowerCase().split('0').join('o').split('1').join('l').split('rn').join('m');
  for (const [pre, kw] of TPL) {
    if (h.startsWith(pre.slice(0, 6)) && (h.startsWith(pre) || lev(h.slice(0, pre.length), pre, 2) <= 2)) {
      const ql = q.toLowerCase();
      if (pre === 'this agreement runs' && /\b(?:\w*ene?w\w*|renw\w*|rnew\w*)\b/.test(ql) && !/\b(length|long|duration|runs?)\b/.test(ql)) return 'clause_concept';
      return hit(ql.match(/[a-z]{3,}/g) || [], kw.split(' ')) ? null : 'clause_concept';
    }
  }
  const h2 = h.replace(/\d+/g, '#');
  for (const [pre, kw] of TPL2) {
    if (h2.startsWith(pre) || lev(h2.slice(0, pre.length), pre, 2) <= 2) return hit(q.toLowerCase().match(/[a-z]{3,}/g) || [], kw.split(' ')) ? null : 'clause_concept';
  }
  return null;
}
const AMONG = /^(?:Total units|[A-Z][A-Za-z ]{1,24}?) (?:highest|lowest) among /;
export function rankField(q, a) {
  if (!AMONG.test(a)) return null;
  const ql = q.toLowerCase();
  if (a.startsWith('Total units')) return /\btotal units\b|number of units|units? count|(?:most|fewest|more|fewer|least) units|how many units|biggest.*\bunits\b|largest.*\bunits\b/.test(ql) ? null : 'rank_field';
  if ((/\b(bills?|invoices?|totals?|dollars?|amount)\b|\$/.test(ql)) && !/\b(fees?|monthly|dom|days?|sqft|square|price|listed|asking|value|valuation|apprais\w*|defects?|cuts?|delinq\w*|rent|units?|vacan\w*)\b/.test(ql)) return 'rank_field';
  return null;
}
const LABEL = {
  Appraiser: /\b(charge[sd]?|fees?|costs?|repairs?|prices?)\b/, Inspector: /\b(charge[sd]?|fees?|costs?|repairs?|prices?)\b/,
  Total: /delinq|\bcomps?\b|items? requested|security deposit|lasting|wholesal|list pric|visit not|order type|service type|charged on|total unit|\bunts?\b/,
};
export function labelForeign(q, a) {
  const m = /^([A-Z][A-Za-z ]{1,20}): /.exec(a);
  const rx = m ? LABEL[m[1]] : null;
  return rx && rx.test(q.toLowerCase()) ? 'label_foreign' : null;
}
const EVT = /when (?:the )?walk\s?through|when we close|when does (?:it|this) close|\bcoe date|settlement date|closing date|date of closing|walk\s?through happens/;
export const dateEvent = (q, a) => (a.startsWith('Date: ') && EVT.test(q.toLowerCase()) ? 'date_event' : null);
const FN = { date_event: dateEvent, phantom, filt_dropped: filtDropped, clause_concept: clauseConcept, rank_field: rankField, label_foreign: labelForeign };
export function veto(q, text, rules = null) {
  try {
    for (const r of (rules !== null ? rules : (CFG.rules || ALL))) { const f = FN[r]; if (f && text) { const v = f(q, text); if (v) return v; } }
  } catch (e) { /* swallowed like the reference */ }
  return null;
}
