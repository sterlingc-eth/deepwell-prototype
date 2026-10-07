/**
 * Electrical paperwork reader (Build 2, stage 2B). Pure, no model, no database.
 *
 *   extractElectrical(pages) -> { type, confidence, fields:[{key,value,page_no,verbatim,confidence}] } | null
 *
 * Reads a contractor's real paperwork by its printed labels: permits, inspection reports and
 * cards, correction notices, certificates of completion, panel schedules, load calculations,
 * contractor licenses, certificates of insurance, surety bonds, test reports, utility
 * applications, plus invoices / estimates / work orders. Every value keeps the page it came
 * from. It reports what the page SAYS (an inspection result "as written", a code edition as a
 * label); it never judges code compliance. Anything it cannot read confidently is simply left
 * out, so a messy page degrades to fewer fields, never to an invented one.
 *
 * Only used for companies whose industry pack is electrical; the HVAC path never calls it.
 */

import { boundedLines, newBudget } from '../textBounds.js';
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** Printed date -> YYYY-MM-DD, or null. US month/day order for numeric dates (a day > 12 in the first slot flips it). */
export function parseDate(raw) {
  const s = String(raw ?? '').trim().replace(/[.,]+$/, '');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/))) {
    const a = +m[1]; const b = +m[3];
    // a dotted date (05.10.2026) is day-first in much of the world and month-first elsewhere: only read it when one reading is impossible (or both are the same day)
    if (m[2] === '.' && a <= 12 && b <= 12 && a !== b) return null;
    return a > 12 && b <= 12 ? validYmd(+m[4], b, a) : validYmd(+m[4], a, b);
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) { const mo = MONTHS[m[1].toLowerCase()]; return mo ? validYmd(+m[3], mo, +m[2]) : null; }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? validYmd(+m[3], mo, +m[1]) : null; }
  return null;
}

const DATE_RE = '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4})';

const TITLES = [
  ['correction-notice', /\b(?:notice of corrections?|correction notice|corrections? (?:required|notice|list)|inspection corrections?)\b/i],
  ['certificate-of-completion', /\b(?:certificate of (?:completion|final approval|occupancy compliance)|final approval|certificate of final)\b/i],
  ['test-report', /\b(?:test report|megger|insulation[- ]resistance|thermograph\w*|infrared (?:scan|survey|report|inspection)|(?:generator|transfer switch|ats|arc[- ]flash|megger|thermographic?) (?:inspection|survey|test)|arc[- ]flash (?:study|analysis|report)|generator (?:load )?test|transfer switch test|ground[- ]fault test)\b/i],
  ['inspection-report', /\b(?:inspection (?:report|card|result|record|ticket)|(?:rough[- ]?in|final|underground|service|cover) inspection)\b/i],
  ['panel-schedule', /\b(?:panel schedule|panelboard schedule|panel directory|circuit directory)\b/i],
  ['load-calculation', /\b(?:load calculations?|load calc|service load (?:study|calculation)|demand load calculation)\b/i],
  ['certificate-of-insurance', /\b(?:certificate of (?:liability )?insurance|acord\s*25|certificate of workers.? comp)/i],
  ['surety-bond', /\b(?:surety bond|contractor.?s? license bond|license bond|bond certificate)\b/i],
  ['contractor-license', /\b(?:contractor.?s? license|electrical contractor license|master electrician(?:.s)? (?:license|card)|journeyman (?:electrician )?(?:license|card)|electrician license|license renewal)\b/i],
  ['utility-application', /\b(?:interconnection application|utility application|service upgrade application|application for (?:electric )?service|ev(?:se)? (?:charger )?(?:rebate|application))\b/i],
  ['permit', /\b(?:electrical permit|permit application|building permit|permit (?:card|receipt)|permit no)\b/i],
  ['proposal-quote', /\b(?:estimate|proposal|quotation|quote)\b/i],
  ['work-order', /\bwork order\b/i],
  ['invoice', /\binvoice\b/i],
];

/** Label table: [field key, label regex source, value kind]. First match on a line wins per key (unless multi). */
const LABELS = [
  ['permit_number', '(?:electrical )?permit\\s*(?:no\\.?|number|num|#)', 'id'],
  ['application_number', '(?:permit |utility |interconnection )?application\\s*(?:no\\.?|number|num|#)', 'id'],
  ['jurisdiction', '(?:jurisdiction|issuing (?:office|authority|agency)|authority having jurisdiction|ahj|building department|issued by)', 'text'],
  ['service_address', '(?:site|job|service|project|work|property|premises) (?:address|location)|address of work', 'text'],
  ['customer_name', '(?:customer|owner(?:\\s*\\/\\s*(?:agent|applicant))?|property owner|applicant|client|bill to|account)(?: name)?', 'text'],
  ['permit_issue_date', '(?:date )?issued(?: date| on)?|issue date', 'date'],
  ['permit_expiry', '(?:permit )?(?:expires?|expiration|expiry)(?: date)?(?: of permit)?|permit valid (?:through|until)|void after|inactive after', 'date'],
  ['inspection_type', 'inspection type|type of inspection|insp\\.? type|type|inspection', 'text'],
  ['inspection_result', '(?:inspection )?result|disposition|status', 'text'],
  ['service_date', '(?:date of inspection|inspection date|inspected on|date of service|service date|test date|date tested|report date|date completed|completion date|final date|approval date|calculation date|date)', 'date'],
  ['correction_due', '(?:corrections? due|due date|re-?inspection(?: date)?|reinspect(?:ion)? by|correct by)', 'date'],
  ['license_number', '(?:contractor |master |journeyman |electrician |state )?licen[sc]e\\s*(?:no\\.?|number|num|#)', 'id'],
  ['license_holder', '(?:licensee|license holder|holder|issued to|name of licensee)', 'text'],
  ['license_expiry', 'licen[sc]e (?:expires?|expiration|expiry)(?: date)?|(?:expires?|expiration|expiry)(?: date)?', 'date'],
  ['insurer', '(?:insurer|insurance company|insurance carrier|carrier|insured by)', 'text'],
  ['policy_number', 'policy\\s*(?:no\\.?|number|num|#)', 'id'],
  ['policy_expiry', 'policy (?:expires?|expiration|expiry|exp\\.?)(?: date)?', 'date'],
  ['bond_number', 'bond\\s*(?:no\\.?|number|num|#)', 'id'],
  ['bond_expiry', 'bond (?:expires?|expiration|expiry|exp\\.?)(?: date)?|bond period ends', 'date'],
  ['connected_load', 'total connected load|connected load', 'load'],
  ['demand_load', 'calculated demand load|total demand load|demand load', 'load'],
  ['service_size', 'proposed service size|service size|service rating', 'text'],
  ['next_test_due', 'next (?:test|study|inspection|survey|service) (?:due|date)|retest (?:due|by)|next due', 'date'],
  ['utility', 'utility(?: company)?|serving utility', 'text'],
  ['manufacturer', 'manufacturer|make|mfr\\.?', 'text'],
  ['model', 'model(?: no\\.?| number)?', 'id'],
  ['serial_number', 'serial(?: no\\.?| number| #)?|s/n', 'id'],
  ['equipment_type', 'equipment(?: type)?|panel name|panel|location of panel', 'text'],
  ['invoice_number', '(?:invoice|ticket|work order|estimate|proposal)\\s*(?:no\\.?|number|num|#)', 'id'],
  ['technician', '(?:electrician|technician|inspector|performed by|prepared by|tested by)', 'text'],
  ['cost', '(?:total due|amount due|grand total|estimate total|total amount|total price|total)', 'money'],
];
// field keys that may only be taken from certain doc types (avoids "Expires" on a permit becoming a license expiry, etc.)
const TYPE_KEYS = {
  'contractor-license': ['license_number', 'license_holder', 'license_expiry'],
  'certificate-of-insurance': ['insurer', 'policy_number', 'policy_expiry', 'license_holder'],
  'surety-bond': ['bond_number', 'bond_expiry', 'insurer', 'license_holder'],
};

const KEY_TYPES = {
  correction_due: ['correction-notice', 'inspection-report'],
  inspection_result: ['inspection-report', 'correction-notice', 'certificate-of-completion', 'permit'],
  inspection_type: ['inspection-report', 'correction-notice', 'certificate-of-completion'],
  service_date: ['inspection-report', 'correction-notice', 'certificate-of-completion', 'test-report', 'work-order', 'invoice', 'proposal-quote'],
  permit_issue_date: ['permit'], permit_expiry: ['permit'],
  license_holder: ['contractor-license'],
  license_expiry: ['contractor-license'],
  insurer: ['certificate-of-insurance', 'surety-bond'], policy_number: ['certificate-of-insurance'], policy_expiry: ['certificate-of-insurance'],
};
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s;,]+$/g, '').trim();
const labelRe = (src) => new RegExp(`^\\s*(?:${src})(?:\\s*[:=]|\\s+[-–—]\\s+)\\s*(.+?)\\s*$`, 'i'); // "Owner-Builder: Yes" and "Customer #: C-1042" are not "Owner:" / "Customer:"
const COMPILED = LABELS.map(([key, src, kind]) => [key, labelRe(src), kind]);

function readValue(kind, raw, key) {
  const v = clean(raw);
  if (!v) return null;
  if (kind === 'date') { const m = v.match(new RegExp('^' + DATE_RE + '(?!\\d)')); return m ? parseDate(m[1]) : null; }
  // money: the WHOLE value must be one plain US-dollar amount (no sign, parentheses, CR / credit, other currency, comma-decimals, spaced digits, range or words)
  if (kind === 'money') { if (/^\s*[-\u2013\u2014\u2212]\s*\$?\s*\d/.test(String(raw ?? ''))) return null; const m = v.match(/^\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:usd|us\$|u\.s\. dollars)?\.?$/i); return m && (/[$,.]/.test(v) || /usd|us\$/i.test(v)) ? m[1].replace(/,/g, '') : null; }
  if (kind === 'load') { if (/[x×*=%]|\bof\b/i.test(v) || /\d\s*(?:-|\u2013|to)\s*\d/i.test(v)) return null; const m = v.match(/([\d,]*\.?\d+)\s*(kva|kw|amps?|a|va)\b(?!h|r)/i); return m ? `${m[1]} ${m[2].toLowerCase().replace(/^amps?$|^a$/, 'A').replace('kva', 'kVA').replace('kw', 'kW').replace(/^va$/, 'VA')}` : null; }
  if (kind === 'id') {
    const toks = v.split(/\s+/); const out = [];
    for (let i = 0; i < toks.length && out.length < 4; i++) {
      const t = toks[i];
      if (!/^[A-Za-z0-9][A-Za-z0-9\-./]*$/.test(t)) break;
      if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$|^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) break; // a date after the number
      if (i > 0 && /^(?:19|20)\d{2}$/.test(t)) break; // a year after the number
      if (i > 0 && (/^\d{1,2}\/\d{1,4}$|^\d+\.\d{2}$|^\d{10}$/.test(t) || /^\d{3}[-.]\d{3}[-.]\d{4}$|^\d{1,2}-[A-Za-z]{3,9}-\d{2,4}$|^\d{4}[/.]\d{1,2}[/.]\d{1,2}$/.test(t))) break; // a phone number or another date shape after the number
      if (i === 0 && /^(?:no\.?|n\/?o|s\/n|sn|s-n|#)$/i.test(t)) return null; // the label's own words echoed ("No. 26-1", "S/N 88-22")
      if (key === 'license_number' && toks.length > 1 && /^[A-Za-z]{1,2}-?\d{1,2}$/.test(t)) continue; // a licence class code (C-11, CR-11)
      if (i > 0 && !/\d/.test(t) && !(/^[A-Z]{2,5}$/.test(t) && !out.some((x) => /\d/.test(x)) && toks.slice(i + 1).some((x) => /\d/.test(x)))) break;
      out.push(t);
    }
    const id = out.join(' ').replace(/[.,;]+$/, '');
    return id.length >= 3 && /\d/.test(id) ? id : null;
  }
  if (/[\u2610\u2611\u2612\u2713\u2714]/.test(v) || (/\bpass\w*\b/i.test(v) && /\bfail\w*\b/i.test(v) && /[|/]|\s/.test(v) && !/re-?inspection|then|after|corrected/i.test(v) && /^(?:pass\w*|fail\w*)\W+(?:pass\w*|fail\w*)$/i.test(v)) || /\[\s*[xX]?\s*\]/.test(v) || /^pass\s*\/\s*fail$/i.test(v)) return null; // a checkbox / template result
  if (/^[A-Za-z][A-Za-z .\/#&]{0,30}:\s*$/.test(v)) return null; // a column header row ("Owner: Contractor:"): no value
  const LABEL_PRE = new Set(['invoice', 'permit', 'license', 'licence', 'type', 'of', 'work', 'job', 'site', 'issue', 'issued', 'project', 'contact', 'owner', 'customer', 'date', 'valuation', 'description', 'address', 'city', 'state', 'zip', 'parcel', 'apn', 'lot', 'status', 'terms', 'tech', 'technician', 'contractor', 'applicant', 'phone', 'tel', 'telephone', 'fax', 'email', 'e-mail', 'mobile', 'cell', 'no', 'number', 'subdivision', 'scope', 'expiration', 'expires', 'expiry', 'inspection', 'service', 'property', 'mailing', 'billing', 'bill', 'ship', 'due', 'cat', 'catalog', 'serial', 'unit', 'suite', 'model', 'manufacturer', 'equipment', 'building', 'location', 'jurisdiction', 'insured', 'holder', 'policy', 'bond', 'amount', 'total', 'tax', 'balance', 'start', 'completion', 'finish', 'test', 'tested', 'next', 'last', 'a/c', 'ac', 'cust', 'acct', 'account', 'naic', 'apt', 'ref', 'po', '#', 'home', 'install', 'order', 'utility', 'inspector', 'badge', 'direct', 'line', 'truck', 'business', 'gate', 'id', 'job', 'page', 'invoice', 'terms', 'email', 'tech']);
  { const m0 = v.match(/^([A-Za-z][A-Za-z .\/#&-]{0,30}):\s*\S/); if (m0 && m0[1].toLowerCase().split(/\s+/).every((x) => LABEL_PRE.has(x.replace(/[^a-z#-]/g, '')) || /^(?:to|no|name|by|for)$/.test(x))) return null; } // the value starts with another label (the field itself was blank)
  const cut = (() => { const w = v.split(' '); for (let i = 1; i < w.length; i++) if (/[A-Za-z#]:$/.test(w[i])) { let j = i; while (j > 1 && LABEL_PRE.has(w[j - 1].toLowerCase().replace(/[^a-z#-]/g, ''))) j--; return w.slice(0, j).join(' ').trim(); } return v; })(); // a second "Label:" on the same line starts another field
  const cut2 = cut.replace(/\s+(?:terms|po|email|e-mail|tech|page|class)\b.*$/i, '').replace(/[,\s]+\S+@\S+.*$/, '').replace(/\s+\d{3}[-. ]?\d{3,4}[-. ]?\d{0,4}\s*$/, '').replace(/\s+[-\u2013]\s+(?:active|inactive)\s*$/i, '').replace(/\s*[|\/,;]\s*$|\s+[-\u2013\u2014]\s*$/, '').trim();
  { const ci = cut.length; if (ci < v.length && /\b(?:unit|suite|ste|apt|apartment|city|state|zip|county)\s*:?\s*$|(?:^|\s)(?:unit|suite|ste|apt|city|state|zip|county):/i.test(v.slice(Math.max(0, ci - 12)).split(':')[0] + ':')) return null; } // an address cut at its own unit / city / state label is incomplete: no value
  if (/\S[,\s]\s*\d{2,6}\s+[A-Za-z]+\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court)\b/i.test(cut) && key !== 'service_address' || /\s[-\u2013\u2014]\s+(?:homeowner|owner|tenant|resident)\b/i.test(cut) || /^\d{4,}\s+[-\u2013\u2014]\s+/.test(cut) || /\s\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.test(cut) || /\s[-\u2013\u2014]\s+\d+\s+[A-Za-z]/.test(cut)) return null; // a phone number or an address run into the name
  if (/^(?:same(?: as\b.*)?|n\/?a|not (?:provided|applicable|available|known|given)|none|homeowner|customer'?s? (?:home|house|residence)|n\/?a\b.*|tbd\b.*|tba|unknown|see\b.*|as above|self|\(?blank\)?|\[.*\]|\(.*\)|illegible|_+|-+|\.+|\?+|pending|to be determined)$/i.test(cut)) return null; // a placeholder is never a name or an address
  const cut3 = cut2.replace(/^["'\u201c]+|["'\u201d]+$/g, '').replace(/\.$/, '').trim();
  return cut3.length > 160 ? cut3.slice(0, 160) : cut3;
}

const SKIP_NOUN = /\bfinal approval (?:requested|denied|not granted)\b|\b(?:inspection|approval|insurance|certificate|license|licence) request(?:ed)?\b|\binspection scheduled\b|\blicen[sc]e (?:application|renewal)\b|\b(?:renewal|expiration) notice\b|\b(?:certificate of occupancy|credit memo|credit note|statement|receipt|plan review|notice of violation|stop work|red tag|re-?inspection notice|power release|request for|checklist|not issued|temporary certificate)\b/i;
const SKIP_QUAL = /\b(?:pending|temporary|draft|void|incomplete)\b/i;
/**
 * The kind of paper is what its TITLE lines say (the first lines that look like a title: short, no "Label: value"). Two different
 * kinds named in the head (a letterhead that names a license above "INVOICE"), a request / checklist / temporary / pending form, a
 * certificate of occupancy, a credit memo or any title we do not know all read as nothing: the normal path reads those.
 */
function classify(lines) {
  if (lines[0] && /^\s*(?:electrical |building )?permit(?: card| application)?\s*$/i.test(lines[0].t)) {
    // a second title line of another kind further down ("INSPECTION REPORT") makes the page mixed: never read as a permit
    for (const l of lines.slice(1, 8)) { if (l.t.length > 70 || /^[^:]{1,32}:\s*\S/.test(l.t) || l.t !== l.t.toUpperCase()) continue; for (const [type, re] of TITLES) if (re.test(l.t) && type !== 'permit' && !SKIP_QUAL.test(l.t)) return null; }
    return { type: 'permit', confidence: 0.95 };
  }
  const cands = [];
  for (const l of lines.slice(0, 8)) {
    if (l.t.length > 70 || /^[^:]{1,32}:\s*\S/.test(l.t)) continue;
    if (SKIP_NOUN.test(l.t)) { cands.push('skip'); continue; }
    if (/[.,;!]$/.test(l.t)) continue; // a sentence is not a title
    if (/\b(?:llc|l\.l\.c|inc|corp|ltd|company|co)\.?$/i.test(l.t)) continue; // a company name (letterhead) is not a title
    const money = (/\b(?:llc|inc|co|corp|company|electric|electrical|services|solutions|ltd)\b\.?\s*$/i.test(l.t) ? null : l.t.match(/^\s*(invoice|estimate|proposal|quotation|quote|work order|service ticket)\b/i)) || l.t.match(/\b(invoice|estimate|proposal|quotation|quote|work order)\s*$/i);
    if (money) { cands.push(/work order|service ticket/i.test(money[1]) ? 'work-order' : /invoice/i.test(money[1]) ? 'invoice' : 'proposal-quote'); continue; }
    for (const [type, re] of TITLES) if (re.test(l.t)) { cands.push(SKIP_QUAL.test(l.t) ? 'skip' : type); break; }
  }
  if (new Set(cands.filter((c) => ['invoice', 'proposal-quote', 'work-order'].includes(c))).size > 1) return null; // two different money titles on one paper: never guessed
  if (['invoice', 'proposal-quote', 'work-order'].includes(cands[0])) return { type: cands[0], confidence: 0.95 }; // a bill / estimate / work order is what its first title line says, whatever work it describes below
  const kinds = [...new Set(cands)];
  return kinds.length === 1 && kinds[0] !== 'skip' ? { type: kinds[0], confidence: 0.95 } : null;
}

function codeEdition(text) {
  const m = text.match(/\b((?:19|20)\d{2})[ \t]*(?:NEC|N\.E\.C\.|NFPA\s*70|National Electrical Code)\b/i) || text.match(/\b(?:NEC|NFPA\s*70|National Electrical Code)[\s,:-]*(?:\(?edition\)?\s*)?((?:19|20)\d{2})\b/i);
  return m ? `${m[1]} NEC` : null;
}

/** Split page text into trimmed non-empty lines tagged with their page. */
function toLines(pages) {
  const out = []; const budget = newBudget();
  for (const p of pages ?? []) {
    for (const raw of boundedLines(p.text, budget)) {
      const t = raw.replace(/\s+/g, ' ').trim();
      if (t) out.push({ t, page: Number(p.page_no) || 1 });
    }
  }
  out.cut = budget.cut;
  return out;
}

export function extractElectrical(pages) {
  const lines = toLines(pages);
  if (!lines.length) return null;
  const cls = classify(lines);
  if (!cls) return null;
  const type = cls.type;
  // a file whose pages are titled as different kinds of paper (a permit page, then a final-inspection or certificate page) is never read as the first page's kind
  { const byPage = new Map(); for (const l of lines) (byPage.get(l.page) ?? byPage.set(l.page, []).get(l.page)).push(l);
    const kinds = new Set(); for (const ls of byPage.values()) { const c = classify(ls); if (c && c.confidence >= 0.95) kinds.add(c.type); }
    if (kinds.size > 1) return null; }
  const allowed = TYPE_KEYS[type] ? new Set(TYPE_KEYS[type]) : null;
  const fields = []; const seen = new Map(); const distinct = new Map();
  const push = (key, value, line, confidence = 0.95, multi = false) => {
    if (value == null || value === '') return;
    if (key === 'customer_name' && (/:\s*$/.test(String(value)) || /^(?:ship to|bill to|sold to|customer|owner|client|address|phone|date)\s*:?$/i.test(String(value)))) return; // a printed label is never a name
    if (!multi) { if (!distinct.has(key)) distinct.set(key, new Set()); distinct.get(key).add(String(value).toLowerCase()); }
    if (!multi && seen.has(key)) return;
    seen.set(key, true);
    fields.push({ key, value, page_no: line.page, verbatim: line.t.slice(0, 200), confidence });
  };
  const licenseish = type === 'contractor-license' || type === 'certificate-of-insurance' || type === 'surety-bond';

  let inCorrections = false; let statusCand = null; let dateCand = null; let applicantCand = null; let equipDetail = null; let lastItem = null; let corrEnded = false; let lateItems = false; let locCand = null;
  for (const line of lines) {
    // numbered correction items under a corrections heading
    if (/^(?:corrections?(?: required| list| items)?|items? (?:to correct|requiring correction)|violations?|deficienc(?:y|ies)|comments?)\s*:?\s*$/i.test(line.t)) { inCorrections = true; continue; }
    if (inCorrections) {
      const item = line.t.match(/^(?:\d{1,2}[.)]|[-•*])\s*(.{4,})$/);
      if (item) { push('correction_items', clean(item[1]), line, 0.9, true); lastItem = fields[fields.length - 1]; continue; }
      if (/^page\s+\d+(?:\s+of\s+\d+)?$/i.test(line.t)) continue; // a page footer between items
      if (lastItem && !/:/.test(line.t) && line.t.length < 120) { lastItem.value = clean(`${lastItem.value} ${line.t}`); continue; } // a wrapped item
      inCorrections = false; corrEnded = true;
    } else if (corrEnded && /^\d{1,2}[.)]\s+\S/.test(line.t)) lateItems = true; // numbered items after the list seemed to end: the list is not reliable
    for (const [key, re, kind] of COMPILED) {
      if (allowed && !allowed.has(key) && ['license_number', 'license_expiry', 'policy_number', 'policy_expiry', 'bond_number', 'bond_expiry'].includes(key)) continue;
      if (!allowed && licenseish) continue;
      if (KEY_TYPES[key] && !KEY_TYPES[key].includes(type)) continue; // a label means something only on the kind of paper it belongs to (an invoice's "Due Date" is not a correction due date)
      const m = line.t.match(re);
      if (!m) continue;
      // a policy/bond/license-specific line must not be read as the generic "expires"
      if (key === 'license_expiry' && /^(?:policy|bond|permit)\b/i.test(line.t)) continue;
      if (key === 'permit_expiry' && /^(?:licen[sc]e|policy|bond)\b/i.test(line.t)) continue;
      if (key === 'permit_expiry' && type === 'permit' && !/^(?:permit|void after|inactive after|valid)/i.test(line.t) && lines.some((l) => /^(?:contractor |electrical contractor |master |journeyman |electrician |state )?licen[sc]e\b|\bcontractor licen[sc]e\b/i.test(l.t))) continue; // a bare "Expires" beside the contractor's license lines is the license's
      if (key === 'service_date' && /\b(?:issued?|expir|due|re-?inspect|policy|license|bond)/i.test(line.t.split(/[:=]/)[0])) continue;
      if (key === 'inspection_type' && /^inspection\s*[:#=]?\s*(?:result|date)/i.test(line.t)) continue;
      if (key === 'equipment_type' && !/^(?:equipment|panel name|panel|location of panel)/i.test(line.t)) continue;
      const v = readValue(kind, m[1], key);
      if (v == null) continue;
      if (key === 'equipment_type' && type === 'test-report') { equipDetail ??= { v, line }; break; } // the unit's own description; the kind of test comes from the title
      if (key === 'inspection_type' && (!/[A-Za-z]/.test(v) || /^(?:pass\w*|fail\w*|approved|rejected|scheduled|complete\w*|closed|paid|ok|okay|cancel\w*)\b|^(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/i.test(v))) continue;
      if (key === 'inspection_type' && / [-\u2013\u2014] /.test(v)) { const h = v.split(/ [-\u2013\u2014] /)[0]; if (/[A-Za-z]/.test(h)) { push('inspection_type', h, line, 0.85); break; } }
      if (key === 'inspection_type' && /^type\b/i.test(line.t) && !/\b(?:rough|final|underground|service|temporary|cover|meter)/i.test(v)) continue;
      if (key === 'service_date' && /^(?:report date|date)\s*[:=\-]/i.test(line.t)) { dateCand ??= { v, line }; break; }
      if (key === 'service_date' && (type === 'inspection-report' || type === 'correction-notice') && !/^(?:date of inspection|inspection date|inspected on)\b/i.test(line.t)) { dateCand ??= { v, line }; break; } // a completion / approval date never beats the inspection date
      // route generic labels by doc type
      let k = key;
      if (type === 'contractor-license' && key === 'license_expiry') k = 'license_expiry';
      if (type === 'certificate-of-insurance' && key === 'license_expiry') k = 'policy_expiry';
      if (type === 'surety-bond' && key === 'license_expiry') k = 'bond_expiry';
      if (type === 'permit' && key === 'service_date') continue;
      if (key === 'jurisdiction' && /^issued by/i.test(line.t) && !/\b(?:city|county|town|township|village|department|dept|building|division|office|authority|state|board|district)\b/i.test(v)) continue;
      if (key === 'permit_expiry' && licenseish) k = type === 'contractor-license' ? 'license_expiry' : type === 'certificate-of-insurance' ? 'policy_expiry' : 'bond_expiry';
      if (key === 'permit_issue_date' && licenseish) continue;
      if (key === 'license_holder' && type === 'certificate-of-insurance' && /^(?:certificate )?holder\b/i.test(line.t)) continue;
      if (key === 'service_address' && /\blocation\b/i.test(line.t.split(/[:=]/)[0]) && !/\baddress\b/i.test(line.t.split(/[:=]/)[0])) { locCand ??= { v, line }; break; } // "Work Location: Garage panel" only when no address line exists
      if (key === 'customer_name' && /^account\b/i.test(line.t) && !/\bname\b/i.test(line.t)) continue;
      if (key === 'customer_name' && /^applicant\b/i.test(line.t)) { applicantCand ??= { v, line }; break; } // the applicant is often the contractor: used only when no owner / customer line exists
      if (k === 'inspection_result' && /^status\b/i.test(line.t) && type === 'permit') { push('permit_status', v, line, 0.9); break; }
      if (k === 'inspection_result' && /^status\b/i.test(line.t)) { if (!/^(?:scheduled|closed|complete\w*|paid|issued|active|expired|open|in service|pending|unpaid|draft)$/i.test(v)) statusCand ??= { v, line }; break; }
      push(k, v, line, 0.95);
      break;
    }
    // equipment ratings printed inline
    const ampLine = line.t.replace(/\bbus(?:bar)?(?: rating)?\s*[:=]?\s*\d{2,4}\s*a(?:mps?)?\b/gi, ' ');
    const amp = ampLine.match(/\b(?:main(?: breaker| lug| mcb)?\s*[:=]|main (?:breaker|lug|mcb)\b|panel rating\s*[:=]?|rated\s*[:=]|amperage\s*[:=])[^0-9\n]{0,18}(\d{2,4})\s*(?:a\b|amps?\b|amperes?\b)/i);
    if (amp && !/\b(?:none|mlo|n\/a|main lug only)\b/i.test(line.t) && !/\b(?:to|existing|proposed|upgrade|from)\b/i.test(line.t) && !(/\bbus/i.test(line.t) && !/\bmain\b/i.test(line.t))) push('amperage', amp[1], line, 0.9);
    const feeder = /^\s*(?:fed (?:from|by)|feeder|supply|upstream|source|serves|scope|notes?|comments?|description|work(?: description)?|remarks)\b|\bfed (?:from|by)\b|\bhi-?pot\b|\bsupplied from\b/i.test(line.t);
    const voltAll = feeder ? [] : [...line.t.matchAll(/\b(\d{3}(?:\/\d{3})?(?:Y\/\d{3})?)\s*(?:v\b|volts?\b|vac\b)/gi)];
    const volt = new Set(voltAll.map((x) => x[1])).size === 1 ? voltAll[0] : null; // two voltages on one line (a feeder and the panel): neither is guessed
    if (volt && !/\btest(?:ing)?\s+volt|\bmegger\b|\binsulation\b/i.test(line.t) && type !== 'invoice' && /volt|\bv\b|vac|phase|panel|bus/i.test(line.t)) push('voltage', `${volt[1]}V`, line, 0.9);
    const ph = feeder ? null : line.t.match(/\b(single|three)[\s-]*(?:phase|ph\b|Ø)/i) || line.t.match(/\b(1|3)\s*-?\s*(?:phase|ph)\b(?!\s*[abc]\b)/i) || line.t.match(/\bphase\s*[:=]\s*(single|three)\b/i);
    if (ph) push('phase', /^(single|1)$/i.test(ph[1]) ? 'single-phase' : 'three-phase', line, 0.9);
    const cc = line.t.match(/\b(\d{1,3})\s*(?:circuits?|spaces?|poles?)\b/i);
    if (cc && type === 'panel-schedule' && /total|circuits|spaces/i.test(line.t)) push('circuit_count', cc[1], line, 0.85);
    if (/\bafci\b|\bgfci\b/i.test(line.t) && !/\b(?:none|no|n\/a|not)\b/i.test(line.t) && !seen.has('afci_gfci')) push('afci_gfci', /afci/i.test(line.t) && /gfci/i.test(line.t) ? 'AFCI/GFCI' : (/afci/i.test(line.t) ? 'AFCI' : 'GFCI'), line, 0.8);
  }

  if (type === 'test-report' && !seen.has('equipment_type')) {
    const t = lines.slice(0, 3).map((l) => l.t).join(' ').match(/\b(transfer switch|generator|thermograph\w*|infrared|megger|insulation[- ]resistance|arc[- ]flash|ground[- ]fault)\b/i);
    if (t) { const nm = /transfer/i.test(t[1]) ? 'Transfer Switch' : /generator/i.test(t[1]) ? 'Generator' : /thermo|infrared/i.test(t[1]) ? 'Thermography' : /megger|insulation/i.test(t[1]) ? 'Insulation Resistance' : /arc/i.test(t[1]) ? 'Arc Flash' : 'Ground Fault'; push('equipment_type', nm, lines[0], 0.85); }
  }
  if (lateItems) for (let i = fields.length - 1; i >= 0; i--) if (fields[i].key === 'correction_items') fields.splice(i, 1);
  if (!seen.has('service_address') && locCand && /\d+\s+\S+.*\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court|cir|pl|pkwy|hwy|trl|ter)\b/i.test(locCand.v)) push('service_address', locCand.v, locCand.line, 0.8);
  if (type === 'test-report' && equipDetail) { if (!seen.has('equipment_type')) push('equipment_type', equipDetail.v, equipDetail.line, 0.85); else push('equipment_detail', equipDetail.v, equipDetail.line, 0.85); }
  if (applicantCand && !seen.has('customer_name')) push('customer_name', applicantCand.v, applicantCand.line, 0.8);
  if (type === 'panel-schedule') {
    // several panels in one document: the model path reads each, never the first one for all
    const AMP = /\b(?:main(?: breaker| lug| mcb)?\s*[:=]|main (?:breaker|lug|mcb)\b|panel rating\s*[:=]?|rated\s*[:=]|amperage\s*[:=])[^0-9\n]{0,18}(\d{2,4})\s*(?:a\b|amps?\b|amperes?\b)/i;
    const amps = new Set(lines.filter((l) => !/\bbus/i.test(l.t) || /\bmain\b/i.test(l.t)).map((l) => l.t.match(AMP)?.[1]).filter(Boolean));
    if (amps.size > 1 || lines.filter((l) => /^panel\s*(?:name|id|designation|no\.?|#)?\s*[:=]/i.test(l.t)).length > 1) return null;
  }
  if (type === 'inspection-report' || type === 'correction-notice') {
    // "Re-inspection Result: Passed" on the same card: both results are kept on the one line, so the lane sees a mixed result (never only the first failure)
    const ri = lines.map((l) => l.t.match(/^re-?inspection(?:\s+(?:result|status|outcome|disposition))?\s*[:=\-]\s*(.+)$/i)).find((m) => m && /\b(?:pass\w*|approved|accepted|satisfactory|fail\w*|reject\w*|corrections?|not approved)\b/i.test(m[1]));
    const fi = fields.findIndex((x) => x.key === 'inspection_result');
    if (ri && fi >= 0) fields[fi] = { ...fields[fi], value: `${fields[fi].value} - re-inspection ${clean(ri[1])}`.slice(0, 160) };
    else if (ri) return null; // a re-inspection result with no first result to attach it to: the normal path reads it
  }
  if (dateCand && !seen.has('service_date')) push('service_date', dateCand.v, dateCand.line, 0.85);
  if (statusCand && !seen.has('inspection_result')) push('inspection_result', statusCand.v, statusCand.line, 0.8);
  if (type === 'inspection-report' || type === 'correction-notice') {
    // a card that lists several inspections (rough-in AND final) is read by the model path, never by taking only the first
    const vals = (re) => new Set(lines.filter((l) => re.test(l.t)).map((l) => l.t.replace(re, '').trim().toLowerCase()));
    if (vals(/^(?:inspection(?: type)?|type of inspection)\s*[:=]\s*/i).size > 1 || vals(/^(?:inspection )?(?:result|disposition)\s*[:=]\s*/i).size > 1) return null;
  }
  if (type === 'certificate-of-insurance' && (lines.filter((l) => /\bpolicy\s*(?:no\.?|number|num|#)/i.test(l.t)).length > 1 || lines.filter((l) => /\bpolicy\s*(?:exp|expir)/i.test(l.t)).length > 1)) return null; // several policies: the model path reads them, never a guess
  const ed = codeEdition(lines.map((l) => l.t).join('\n'));
  if (ed) { const l = lines.find((x) => new RegExp(ed.slice(0, 4)).test(x.t) && /nec|nfpa|national electrical/i.test(x.t)) ?? lines[0]; push('code_edition', ed, l, 0.9); }

  // inspection type from the title when no label gave it ("ROUGH-IN INSPECTION")
  const titleQual = (type === 'inspection-report' || type === 'correction-notice' || type === 'certificate-of-completion') ? lines.slice(0, 3).find((l) => /\b(?:pre[- ]?final|not final|partial|phase\s*\d|temporary|temp\b|tco|power only|release)\b/i.test(l.t) && l.t.length <= 70 && /inspection|certificate|notice|report|release/i.test(l.t) && !/\b(?:llc|inc|co|corp|company|solutions|electric|electrical services|services|ltd)\b\.?\s*$/i.test(l.t) && !/^[^:]{1,32}:\s*\S/.test(l.t)) : null;
  if (titleQual) { const it = fields.find((x) => x.key === 'inspection_type'); if (it && /^\s*final\b/i.test(it.value)) return null; if (!it) push('inspection_type', clean(titleQual.t), titleQual, 0.8); }
  if (type === 'certificate-of-completion' && lines.slice(2).some((l) => /\b(?:fail\w*|not (?:passed|approved|issued|complete\w*)|pending|incomplete|corrections?\s+(?:required|needed)|on hold|void)\b/i.test(l.t))) return null; // a certificate page that also says failed / pending / incomplete is not read as a closing certificate
  if ((type === 'inspection-report' || type === 'correction-notice' || type === 'certificate-of-completion') && !seen.has('inspection_type')) {
    const t = lines.slice(0, 2).find((l) => /\b(rough[- ]?in|final|underground|service|cover|temporary|meter)\b.*\binspection\b/i.test(l.t));
    const m = t?.t.match(/\b(rough[- ]?in|final|underground|service|cover|temporary|meter)\b/i);
    if (m) push('inspection_type', m[1].replace(/^rough in$/i, 'Rough-in').replace(/^./, (c) => c.toUpperCase()), t, 0.85);
  }
  // one file holding several documents (a second permit / invoice number further on) is never stored as one
  for (const k of ['permit_number', 'invoice_number', 'license_number', 'bond_number', 'license_expiry', 'bond_expiry', 'policy_expiry', 'permit_expiry', 'next_test_due', 'serial_number', 'insurer', 'cost', 'permit_issue_date', 'customer_name', 'service_address', 'technician', 'model', 'correction_due', 'service_date', 'permit_status']) if ((distinct.get(k)?.size ?? 0) > 1) return null; // two readings of one single-valued field (a continuation page with a different date, two units on one report): never the first
  // a license / policy / bond / permit paper that says it was suspended, revoked, cancelled, terminated, renewed, extended or replaced: its printed expiry is not the end date, so none is kept (a missing date is never read as current)
  { const BOILER = /^\s*(?:notice of )?cancell?ation\s*:?\s*$|\bdescribed policies\b|\bexpiration date thereof\b|\bbe cancell?ed\b|\bshould any of the above\b|cancel{1,2}ed before\b|policy provisions|prior (?:written )?notice\b|\b\d+ days?'? (?:written )?notice\b|\bvoid (?:after|if|where|unless)\b/i;
    const VOIDING = /\b(?:suspen\w*|revok\w*|cancel{1,2}(?:ed|ation|ing)?|terminat\w*|rescind\w*|non-?renew\w*|not renewed|renewed|extended|extension|replaced|replaces|supersed\w*|lapsed|void|voided|withdrawn|inactive|continu\w*|surrender\w*|forfeit\w*|delinquent|not active|closed|released|denied|abandoned)\b/i;
    const PERMIT_VOID = /\b(?:suspended|revoked|cancel{1,2}ed|cancellation|terminated|rescinded|void|voided|withdrawn|superseded|denied|abandoned|lapsed)\b/i;
    const PERMIT_MOVED = /\b(?:renewed?|renewal|extension|extended|extend(?:s)? to)\b/i;
    const dropDates = () => { for (let i = fields.length - 1; i >= 0; i--) if (['license_expiry', 'policy_expiry', 'bond_expiry', 'permit_expiry'].includes(fields[i].key)) fields.splice(i, 1); };
    if (licenseish) { if (lines.some((l) => !BOILER.test(l.t) && VOIDING.test(l.t))) dropDates(); }
    else if (type === 'permit') {
      if (lines.some((l) => PERMIT_MOVED.test(l.t))) dropDates();
      const hit = lines.find((l) => !BOILER.test(l.t) && PERMIT_VOID.test(l.t) && l.t.length <= 60 && !/\b(?:if|when|may|shall|will|unless|becomes|should|can|is not|are not|previous|prior|old|notice|requires?|subject to|cannot|fee)\b|_{2,}|:\s*\S{1,2}\s*$|:\s*(?:no|none|n\/a)\s*$/i.test(l.t));
      if (hit && !fields.some((x) => x.key === 'permit_status')) fields.push({ key: 'permit_status', value: clean(hit.t).slice(0, 120), page_no: hit.page, verbatim: hit.t.slice(0, 200), confidence: 0.7 });
    } }
  // a total that is not the customer's invoice total: paid in full / deposit / credit papers, and vendor bills (what the company owes a supplier)
  { const ci = fields.findIndex((f) => f.key === 'cost');
    if (ci >= 0) {
      const t = lines.map((l) => l.t);
      const paid = t.some((x) => /\b(?:paid in full|deposit|payment received|previous balance|credit|discount|refund|balance forward)\b/i.test(x)) && (Number(fields[ci].value) === 0 || t.some((x) => /^(?:amount due|balance due|amount)\s*[:=]/i.test(x)) && !t.some((x) => /^(?:grand total|invoice total|total|total amount|total price|estimate total)\s*[:=]/i.test(x)));
      const vendor = t.some((x) => /^(?:invoice|bill)?\s*from\s*[:\-]|^(?:invoice|bill)\s+from\s+\S|\bremit(?:tance)?\b[^.]{0,40}\bto\b|\bvendor\b|\bsupplier\b|\bpayable\b|\bpay(?:ment)? to\b|^sold by\b|^seller\b|^buyer\b|\bship from\b/i.test(x));
      const voided = type === 'invoice' && t.some((x) => /\b(?:void|voided|cancell?ed)\b/i.test(x) && !/\bvoid (?:after|if|where|unless)\b/i.test(x));
      const carried = t.some((x) => /^(?:previous|prior|past due|old)\s+balance\b|^balance (?:forward|brought forward)\b|^carried forward\b/i.test(x));
      if (paid || vendor || voided || carried) fields.splice(ci, 1);
    } }
  // cost on money-bearing documents only
  if (!['invoice', 'proposal-quote'].includes(type)) { const i = fields.findIndex((f) => f.key === 'cost'); if (i >= 0) fields.splice(i, 1); }
  return { type, confidence: cls.confidence, fields, ...(lines.cut ? { partial: true } : {}) };
}

/** Required keys for a type, from the electrical pack (a|b = either). */
export function missingRequired(type, fields, pack) {
  const req = pack?.documentTypes?.find((t) => t.id === type)?.requires ?? [];
  const have = new Set(fields.map((f) => f.key));
  return req.filter((r) => !r.split('|').some((k) => have.has(k)));
}
