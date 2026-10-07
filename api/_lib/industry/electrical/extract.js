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
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    const a = +m[1]; const b = +m[2];
    return a > 12 && b <= 12 ? validYmd(+m[3], b, a) : validYmd(+m[3], a, b);
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) { const mo = MONTHS[m[1].toLowerCase()]; return mo ? validYmd(+m[3], mo, +m[2]) : null; }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? validYmd(+m[3], mo, +m[1]) : null; }
  return null;
}

const DATE_RE = '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4})';

const TITLES = [
  ['correction-notice', /\b(?:notice of corrections?|correction notice|corrections? (?:required|notice|list)|inspection corrections?)\b/i],
  ['certificate-of-completion', /\b(?:certificate of (?:completion|final approval|occupancy compliance)|final approval|certificate of final)\b/i],
  ['inspection-report', /\b(?:inspection (?:report|card|result|record|ticket)|(?:rough[- ]?in|final|underground|service|cover) inspection)\b/i],
  ['panel-schedule', /\b(?:panel schedule|panelboard schedule|panel directory|circuit directory)\b/i],
  ['load-calculation', /\b(?:load calculations?|load calc|service load (?:study|calculation)|demand load calculation)\b/i],
  ['certificate-of-insurance', /\b(?:certificate of (?:liability )?insurance|acord\s*25|certificate of workers.? comp)/i],
  ['surety-bond', /\b(?:surety bond|contractor.?s? license bond|license bond|bond certificate)\b/i],
  ['contractor-license', /\b(?:contractor.?s? license|electrical contractor license|master electrician(?:.s)? (?:license|card)|journeyman (?:electrician )?(?:license|card)|electrician license|license renewal)\b/i],
  ['test-report', /\b(?:test report|megger|insulation[- ]resistance|thermograph|infrared (?:scan|survey)|arc[- ]flash (?:study|analysis|report)|generator (?:load )?test|transfer switch test|ground[- ]fault test)\b/i],
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
  ['customer_name', '(?:customer|owner|property owner|applicant|client|bill to|account)(?: name)?', 'text'],
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

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s;,]+$/g, '').trim();
const labelRe = (src) => new RegExp(`^\\s*(?:${src})\\s*[:#=\\-–]\\s*(.+?)\\s*$`, 'i');
const COMPILED = LABELS.map(([key, src, kind]) => [key, labelRe(src), kind]);

function readValue(kind, raw) {
  const v = clean(raw);
  if (!v) return null;
  if (kind === 'date') { const m = v.match(new RegExp('^' + DATE_RE)); return m ? parseDate(m[1]) : null; }
  // money: the WHOLE value must be one plain US-dollar amount (no sign, parentheses, CR / credit, other currency, comma-decimals, spaced digits, range or words)
  if (kind === 'money') { if (/^\s*[-\u2013\u2014\u2212]\s*\$?\s*\d/.test(String(raw ?? ''))) return null; const m = v.match(/^\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:usd|us\$|u\.s\. dollars)?\.?$/i); return m && (/[$,.]/.test(v) || /usd|us\$/i.test(v)) ? m[1].replace(/,/g, '') : null; }
  if (kind === 'load') { const m = v.match(/([\d,]*\.?\d+)\s*(kva|kw|amps?|a\b|va)/i); return m ? `${m[1]} ${m[2].toLowerCase().replace(/^amps?$|^a$/, 'A').replace('kva', 'kVA').replace('kw', 'kW').replace(/^va$/, 'VA')}` : null; }
  if (kind === 'id') { const m = v.match(/^([A-Za-z0-9][A-Za-z0-9\-./]{2,}(?:\s+(?=[A-Za-z0-9\-./]*\d)[A-Za-z0-9\-./]+){0,2})/); const id = m ? m[1].replace(/[.,;]+$/, '') : null; return id && /\d/.test(id) ? id : null; }
  return v.length > 160 ? v.slice(0, 160) : v;
}

function classify(lines) {
  if (lines[0] && /^\s*(?:electrical |building )?permit(?: card| application)?\s*$|\belectrical permit\b/i.test(lines[0].t) && !/\binspection\b/i.test(lines[0].t)) return { type: 'permit', confidence: 0.95 };
  const head = lines.slice(0, 2).map((l) => l.t).join(' \n ');
  for (const [type, re] of TITLES) if (re.test(head)) return { type, confidence: 0.95 };
  const all = lines.map((l) => l.t).join(' \n ');
  for (const [type, re] of TITLES) if (re.test(all)) return { type, confidence: 0.7 };
  return null;
}

function codeEdition(text) {
  const m = text.match(/\b((?:19|20)\d{2})\s*(?:NEC|N\.E\.C\.|NFPA\s*70|National Electrical Code)\b/i) || text.match(/\b(?:NEC|NFPA\s*70|National Electrical Code)[\s,:-]*(?:\(?edition\)?\s*)?((?:19|20)\d{2})\b/i);
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

  let inCorrections = false; let statusCand = null; let dateCand = null;
  for (const line of lines) {
    // numbered correction items under a corrections heading
    if (/^(?:corrections?(?: required| list| items)?|items? (?:to correct|requiring correction)|violations?|deficienc(?:y|ies)|comments?)\s*:?\s*$/i.test(line.t)) { inCorrections = true; continue; }
    if (inCorrections) {
      const item = line.t.match(/^(?:\d{1,2}[.)]|[-•*])\s*(.{4,})$/);
      if (item) { push('correction_items', clean(item[1]), line, 0.9, true); continue; }
      inCorrections = false;
    }
    for (const [key, re, kind] of COMPILED) {
      if (allowed && !allowed.has(key) && ['license_number', 'license_expiry', 'policy_number', 'policy_expiry', 'bond_number', 'bond_expiry'].includes(key)) continue;
      if (!allowed && licenseish) continue;
      const m = line.t.match(re);
      if (!m) continue;
      // a policy/bond/license-specific line must not be read as the generic "expires"
      if (key === 'license_expiry' && /^(?:policy|bond|permit)\b/i.test(line.t)) continue;
      if (key === 'permit_expiry' && /^(?:licen[sc]e|policy|bond)\b/i.test(line.t)) continue;
      if (key === 'service_date' && /\b(?:issued?|expir|due|re-?inspect|policy|license|bond)/i.test(line.t.split(/[:=]/)[0])) continue;
      if (key === 'inspection_type' && /^inspection\s*[:#=]?\s*(?:result|date)/i.test(line.t)) continue;
      if (key === 'equipment_type' && !/^(?:equipment|panel name|panel|location of panel)/i.test(line.t)) continue;
      const v = readValue(kind, m[1]);
      if (v == null) continue;
      if (key === 'inspection_type' && !/[A-Za-z]/.test(v)) continue;
      if (key === 'inspection_type' && /^type\b/i.test(line.t) && !/\b(?:rough|final|underground|service|temporary|cover|meter)/i.test(v)) continue;
      if (key === 'service_date' && /^(?:report date|date)\s*[:=\-]/i.test(line.t)) { dateCand ??= { v, line }; break; }
      // route generic labels by doc type
      let k = key;
      if (type === 'contractor-license' && key === 'license_expiry') k = 'license_expiry';
      if (type === 'certificate-of-insurance' && key === 'license_expiry') k = 'policy_expiry';
      if (type === 'surety-bond' && key === 'license_expiry') k = 'bond_expiry';
      if (type === 'permit' && key === 'service_date') continue;
      if (key === 'jurisdiction' && /^issued by/i.test(line.t) && !/\b(?:city|county|town|township|village|department|dept|building|division|office|authority|state|board|district)\b/i.test(v)) continue;
      if (key === 'permit_expiry' && licenseish) k = type === 'contractor-license' ? 'license_expiry' : type === 'certificate-of-insurance' ? 'policy_expiry' : 'bond_expiry';
      if (key === 'permit_issue_date' && licenseish) continue;
      if (key === 'customer_name' && /^account\b/i.test(line.t) && !/\bname\b/i.test(line.t)) continue;
      if (k === 'inspection_result' && /^status\b/i.test(line.t)) { statusCand ??= { v, line }; break; }
      push(k, v, line, 0.95);
      break;
    }
    // equipment ratings printed inline
    const ampLine = line.t.replace(/\bbus(?:bar)?(?: rating)?\s*[:=]?\s*\d{2,4}\s*a(?:mps?)?\b/gi, ' ');
    const amp = ampLine.match(/\b(?:main(?: breaker| lug| mcb)?\s*[:=]|main (?:breaker|lug|mcb)\b|panel rating\s*[:=]?|rated\s*[:=]|amperage\s*[:=])[^0-9\n]{0,18}(\d{2,4})\s*(?:a\b|amps?\b|amperes?\b)/i);
    if (amp && !/\b(?:to|existing|proposed|upgrade|from)\b/i.test(line.t) && !(/\bbus/i.test(line.t) && !/\bmain\b/i.test(line.t))) push('amperage', amp[1], line, 0.9);
    const feeder = /^\s*(?:fed (?:from|by)|feeder|supply|upstream|source|serves)\b/i.test(line.t);
    const volt = feeder ? null : line.t.match(/\b(\d{3}(?:\/\d{3})?(?:Y\/\d{3})?)\s*(?:v\b|volts?\b|vac\b)/i);
    if (volt && /volt|\bv\b|vac|phase|panel|bus/i.test(line.t)) push('voltage', `${volt[1]}V`, line, 0.9);
    const ph = feeder ? null : line.t.match(/\b(single|three)[\s-]*(?:phase|ph\b|Ø)/i) || line.t.match(/\b(1|3)\s*-?\s*(?:phase|ph)\b(?!\s*[abc]\b)/i) || line.t.match(/\bphase\s*[:=]\s*(single|three|1|3)\b/i);
    if (ph) push('phase', /^(single|1)$/i.test(ph[1]) ? 'single-phase' : 'three-phase', line, 0.9);
    const cc = line.t.match(/\b(\d{1,3})\s*(?:circuits?|spaces?|poles?)\b/i);
    if (cc && type === 'panel-schedule' && /total|circuits|spaces/i.test(line.t)) push('circuit_count', cc[1], line, 0.85);
    if (/\bafci\b|\bgfci\b/i.test(line.t) && !seen.has('afci_gfci')) push('afci_gfci', /afci/i.test(line.t) && /gfci/i.test(line.t) ? 'AFCI/GFCI' : (/afci/i.test(line.t) ? 'AFCI' : 'GFCI'), line, 0.8);
  }

  if (type === 'test-report' && !seen.has('equipment_type')) {
    const t = lines.slice(0, 3).map((l) => l.t).join(' ').match(/\b(transfer switch|generator|thermograph\w*|infrared|megger|insulation[- ]resistance|arc[- ]flash|ground[- ]fault)\b/i);
    if (t) { const nm = /transfer/i.test(t[1]) ? 'Transfer Switch' : /generator/i.test(t[1]) ? 'Generator' : /thermo|infrared/i.test(t[1]) ? 'Thermography' : /megger|insulation/i.test(t[1]) ? 'Insulation Resistance' : /arc/i.test(t[1]) ? 'Arc Flash' : 'Ground Fault'; push('equipment_type', nm, lines[0], 0.85); }
  }
  if (type === 'panel-schedule') {
    // several panels in one document: the model path reads each, never the first one for all
    const AMP = /\b(?:main(?: breaker| lug| mcb)?\s*[:=]|main (?:breaker|lug|mcb)\b|panel rating\s*[:=]?|rated\s*[:=]|amperage\s*[:=])[^0-9\n]{0,18}(\d{2,4})\s*(?:a\b|amps?\b|amperes?\b)/i;
    const amps = new Set(lines.filter((l) => !/\bbus/i.test(l.t) || /\bmain\b/i.test(l.t)).map((l) => l.t.match(AMP)?.[1]).filter(Boolean));
    if (amps.size > 1 || lines.filter((l) => /^panel\s*(?:name|id|designation|no\.?|#)?\s*[:=]/i.test(l.t)).length > 1) return null;
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
  if ((type === 'inspection-report' || type === 'correction-notice' || type === 'certificate-of-completion') && !seen.has('inspection_type')) {
    const t = lines.slice(0, 2).find((l) => /\b(rough[- ]?in|final|underground|service|cover|temporary|meter)\b.*\binspection\b/i.test(l.t));
    const m = t?.t.match(/\b(rough[- ]?in|final|underground|service|cover|temporary|meter)\b/i);
    if (m) push('inspection_type', m[1].replace(/^rough in$/i, 'Rough-in').replace(/^./, (c) => c.toUpperCase()), t, 0.85);
  }
  // one file holding several documents (a second permit / invoice number further on) is never stored as one
  for (const k of ['permit_number', 'invoice_number']) if ((distinct.get(k)?.size ?? 0) > 1) return null;
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
