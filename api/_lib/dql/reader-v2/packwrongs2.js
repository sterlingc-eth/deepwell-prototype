/** packwrongs2.js - JS twin of lib/packwrongs2.py + lib/packwrongs2_hook.py (lane packwrongs, 2026-10-24). Rules: label | dateask | net (see the Python header).
 * ONE env switch, default OFF: DONOVAN_READER_V2_PACKWRONGS2=1 (optional DONOVAN_READER_V2_PACKWRONGS2_RULES=label,dateask,net; default all three).
 * OFF = nothing in this file is consulted (index.js calls it only when the switch is on). Pure function of (question, final prediction, cited document). Never throws: gate() returns null to keep the answer. */
import { AnyIndex } from './anydoc.js';

const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
export const PW = { on: false, rules: ['label', 'dateask', 'net'] };
export function configurePackwrongs2() {
  PW.on = truthy(process.env.DONOVAN_READER_V2_PACKWRONGS2);
  const r = String(process.env.DONOVAN_READER_V2_PACKWRONGS2_RULES ?? '').split(',').map((x) => x.trim()).filter((x) => ['label', 'dateask', 'net'].includes(x));
  PW.rules = r.length ? r : ['label', 'dateask', 'net'];
  return PW.on;
}
export const packwrongs2On = () => PW.on;

const LABEL = /^([^()]+?) \(([^()]+), (\d{4}-\d\d-\d\d)\)$/;
const SUBJ = /^\s*subject:[^\n]*/gim;
const BLOCK = /\b(?:number|numbers|find|open|title|which|(?:document|doc|file|form|report) name|name of the (?:document|doc|file|form|report))\b/;
const NETASK = /\b(?:payment terms?|net terms?|terms of payment|terms for payment|due date terms?|payment due date|due date|when (?:is|are|was) (?:the )?payments? due|payments? due terms?)\b/;
const NAMEASK = /\b(name|who|whom|whose)\b/;
const DATEON = /\b(?:posted|billed|issued|invoiced|quoted|written|opened|signed|created|prepared|placed|ordered|filed|logged|recorded|submitted|booked)\s+on\b/;
const DATEWORD = /\bdate\b|\bdated\b/;
const DATEASK = /\b(?:what date|which date|what day|when (?:is|was|did|does|were)|date (?:of|on)|dated)\b/;
const HASDATE = /\d{4}-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{2,4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/;
const PERSON = /^(?:Dr\.? |Mr\.? |Ms\.? )?[A-Z][A-Za-z.'&-]+(?: [A-Z][A-Za-z.'&-]+){1,3}$/;
const NETRE = /\bnet\s?\d+\b/;
const OTHERW = new Set('late past overdue interest fee fees charge charges card credit debit surcharge penalty discount deposit grace early balance processing finance autopay recurring bounced returned refund cancel cancellation reserve retainer progress installment milestone upfront advance retainage rent final progress installment installments lease tenant monthly annual yearly weekly milestone draw holdback escrow warranty'.split(' '));
const STRIP = [/\b[A-Za-z]{1,6}[- ]?\d{3,7}\b/g, /\$\s?[\d,.]+/g, /\d+[./-]\d+[./-]\d+/g];

function own(q, D) {
  let ql = q.toLowerCase().replace(SUBJ, ' ');
  const tw = (D.title || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (let i = 0; i < tw.length - 1; i++) ql = ql.replace(new RegExp('\\b' + tw[i] + '\\W+' + tw[i + 1] + '\\b', 'g'), ' ');
  return ql;
}
function words(q) { for (const r of STRIP) q = q.replace(r, ' '); return new Set(q.toLowerCase().match(/[a-z]+/g) || []); }
const inter = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
const docBlob = (D) => D.lines.map((l) => l[1]).join(' ').toLowerCase();
function docDates(D) { return [...new Set(D.dates.filter(([k]) => k.toLowerCase() === 'date').map((x) => x[1]))].sort(); }

/** -> null (keep) or [reason, {text}] */
export function check(q, pred, D, rules = PW.rules) {
  if (!D) return null;
  const t = pred.text || ''; const ql = own(q, D);
  if (rules.includes('label') && !t.includes(' (page ')) {
    const m = LABEL.exec(t);
    if (m && !m[1].includes(':') && !BLOCK.test(ql)) {
      const party = m[2], iso = m[3];
      if (docBlob(D).includes(party.toLowerCase()) && D.dates.some((x) => x[1] === iso)) {
        const na = NAMEASK.test(ql), da = DATEON.test(ql) || DATEASK.test(ql) || DATEWORD.test(ql);
        if (na && !da) return ['label', { text: party + ' (' + t + ')' }];
        if (da && !na) return ['label', { text: iso + ' (' + t + ')' }];
      }
    }
  }
  if (rules.includes('dateask') && !t.includes(' (page ') && DATEON.test(ql) && !NAMEASK.test(ql) && !BLOCK.test(ql)) {
    const head = t.split(' (')[0].trim();
    if (PERSON.test(head) && !HASDATE.test(head.toLowerCase())) {
      const ds = docDates(D);
      if (ds.length === 1) return ['dateask', { text: ds[0] + t.slice(head.length) }];
    }
  }
  if (rules.includes('net') && t.includes(' (page ')) {
    const i = t.indexOf(' (page '); const sent = t.slice(0, i), rest = t.slice(i + 7);
    if (!NETRE.test(sent.toLowerCase()) && rest.includes(', ')) {
      const w = words(ql);
      if (NETASK.test(ql) && !inter(w, OTHERW)) {
        const cl = D.sent.filter(([s]) => NETRE.test(s.toLowerCase()));
        if (cl.length === 1) { const [s, p] = cl[0]; return ['net', { text: s + ' (page ' + p + ', ' + rest.slice(rest.indexOf(', ') + 2) }]; }
      }
    }
  }
  return null;
}
/** pred = the reader's final decision (after the evidence gate if on). Returns the new decision or null to keep pred. */
export function gate(ix, q, pred) {
  if (!PW.on || !pred.answered) return null;
  try {
    if (!ix._anyIndex) ix._anyIndex = new AnyIndex(ix.rawPages);
    const docs = pred.docs || []; const D = docs.length ? ix._anyIndex.docs.get(docs[0]) : null;
    const r = check(q, pred, D);
    if (r === null) return null;
    return { ...pred, text: r[1].text, packwrongs: r[0] };
  } catch (e) { return null; }
}
