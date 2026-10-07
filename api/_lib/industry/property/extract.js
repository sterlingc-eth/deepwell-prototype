/**
 * Property-management paperwork reader (Build 2, stage 2D). Pure, no model, no database.
 *
 *   extractProperty(pages, { today? }) -> { type, confidence, fields:[{key,value,page_no,verbatim,confidence}] } | null
 *
 * Reads a property manager's own paperwork by its printed labels: work orders / maintenance requests, vendor invoices,
 * certificates of insurance (COIs), leases, rent rolls / unit lists, move-in / move-out / annual / fire-safety
 * inspections and vendor contracts. Every value keeps the page it came from. It reports what the page SAYS (a status or a
 * result as printed); it never computes (no "Net 30" -> due date, no lease end from a term) and never judges. Anything it
 * cannot read confidently is simply left out, and a document that is not one of these (a letter that merely mentions a
 * COI, an HVAC sheet, a cover page, two documents in one file) returns null, so a messy page degrades to fewer fields,
 * never to an invented one.
 *
 * Dates: numeric dates are US month/day (a day > 12 in the first slot flips it); two-digit years are 20xx; a date with no
 * year, or outside 2000-2060, is dropped. Cross-checks drop BOTH values of an impossible pair (lease end before start).
 *
 * Only used for companies whose industry pack is property; the HVAC, electrical and plumbing paths never call it.
 */
import { parseDate as parseDateRaw } from '../plumbing/extract.js';
import { boundedLines, newBudget } from '../textBounds.js';

// a dotted date with both parts <= 12 (02.03.2027) is day-first in some countries and month-first in others: unreadable, unless a part > 12 settles it
// the order of an all-numeric slash date is settled by the whole document: one date with a first part > 12 (13/01/2026) proves day-first, one with a second part > 12 proves month-first;
// both in one document (or neither) leaves an ambiguous date (both parts <= 12) read month-first only when nothing says otherwise, and unreadable when the document contradicts itself
let DATE_ORDER = null; // 'dmy' | 'mdy' | 'mixed' | null (no evidence)
function scanDateOrder(pages) {
  let dmy = false; let mdy = false;
  for (const p of pages ?? []) for (const m of String(p?.text ?? '').matchAll(/(?<![\d/.-])(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})(?![\d/-])/g)) { if (+m[1] > 12 && +m[3] <= 12) dmy = true; else if (+m[3] > 12 && +m[1] <= 12) mdy = true; }
  return dmy && mdy ? 'mixed' : dmy ? 'dmy' : mdy ? 'mdy' : null;
}
const parseDate = (s) => {
  const str = String(s ?? '').trim();
  const dm = str.match(/^(\d{1,2})\.(\d{1,2})\.\d{2,4}$/); if (dm && +dm[1] <= 12 && +dm[2] <= 12) return null;
  const sl = str.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})$/);
  if (sl && +sl[1] <= 12 && +sl[3] <= 12 && sl[1] !== sl[3]) { if (DATE_ORDER === 'mixed') return null; if (DATE_ORDER === 'dmy') { const d = parseDateRaw(`${sl[3]}${sl[2]}${sl[1]}${sl[2]}${sl[4]}`); return d && d >= '2000-01-01' && d <= '2060-12-31' ? d : null; } }
  const d = parseDateRaw(s); return d && d >= '2000-01-01' && d <= '2060-12-31' ? d : null;
};
const DATE_RE = '(\\d{8}(?!\\d)|\\d{1,2}-[A-Za-z]{3,9}\\.?-\\d{2,4}(?!\\d)|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+[\'\u2019]\\d{2}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2}(?!\\d)|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4})';
const RANGE_RE = new RegExp(`^${DATE_RE}\\s*(?:to|through|thru|until|[-\u2013\u2014]|and)\\s*${DATE_RE}`, 'i');

const COI = 'certificate-of-insurance'; const LS = 'lease-agreement'; const RR = 'rent-roll'; const MI = 'move-in-inspection'; const MO = 'move-out-inspection';
const IR = 'inspection-report'; const VC = 'vendor-contract'; const WO = 'work-order'; const IV = 'invoice';
export const PROPERTY_TYPES = [COI, LS, RR, MI, MO, IR, VC, WO, IV];

/* ------------------------------------------------------------------ document type (from the title lines) */
const TITLES = [
  [COI, /\bcertificates?\s+of\s+(?:liability\s+)?insurance\b|\bevidence\s+of\s+(?:property\s+|liability\s+)?insurance\b|\bproof\s+of\s+insurance\b|\bacord\s*25\b|^\W*coi\W*$|\binsurance\s+certificate\b/i],
  [RR, /\brent\s+roll\b|\bunit\s+(?:list|roster|mix|schedule)\b|\boccupancy\s+(?:report|roster)\b|\bunit\s+status\s+report\b/i],
  [MI, /\bmove[- ]?in\b[^:]{0,30}\b(?:inspection|condition|checklist|report|walk[- ]?through)\b/i],
  [MO, /\bmove[- ]?out\b[^:]{0,30}\b(?:inspection|condition|checklist|report|walk[- ]?through)\b/i],
  [LS, /\b(?:residential|apartment|rental|month[- ]to[- ]month|commercial|room(?:ing)?)\s+(?:lease|rental)\b|\blease\s+(?:agreement|contract)\b|\brental\s+(?:agreement|contract)\b|^\W*(?:residential |apartment )?lease\W*$/i],
  [VC, /\b(?:vendor|service|services|maintenance|janitorial|landscap\w*|pest[- ]control|elevator|snow|security|trash|waste|hvac|pool|laundry|cleaning)\s+(?:services?\s+)?(?:agreement|contract)\b|\b(?:master\s+services?|vendor)\s+(?:agreement|contract)\b|\bcontractor\s+agreement\b/i],
  [IR, /\b(?:annual|fire[- ]?safety|fire|life[- ]?safety|safety|smoke(?:\s+detector)?|unit|property|hoa|code|habitability|quarterly|turnover|exterior|common[- ]area|sprinkler|pre[- ]?lease|city|re-?)\s*(?:unit\s+|property\s+|compliance\s+)?inspection\b|\binspection\s+(?:report|results?|notice|record|summary|form|checklist)\b/i],
  [WO, /\bwork\s*order\b|\bmaintenance\s+(?:request|ticket|order)\b|\bservice\s+request\b|\bmake[- ]ready\s+(?:order|request|work)\b|\bturnover\s+(?:order|work)\b/i],
  [IV, /\binvoice\b/i],
];
const LETTERHEAD = /\d{3}[-.)\s]+\d{3,4}[-.\s]\d{4}|@|www\.|\.com\b|\b(?:llc|inc|corp|co\.)\b|[|•]/i;

function classify(lines) {
  const first = lines[0]?.page;
  const head = lines.filter((l) => l.page === first).slice(0, 8);
  for (let i = 0; i < head.length; i++) {
    const t = head[i].t;
    if (t.length < 4 || t.length > 90 || /[:=]/.test(t) || LETTERHEAD.test(t) || /^page \d+ of \d+/i.test(t)) continue;
    const hits = TITLES.filter(([, re]) => re.test(t)).map(([type]) => type);
    if (!hits.length) continue;
    if (hits.includes(IV) && hits.includes(WO)) return null; // "Work order invoice": unclear, the model reads it
    if (hits.includes(WO) && hits.includes(IR)) return null;
    if ((hits.includes(IR) || hits.includes(MI) || hits.includes(MO)) && /\b(?:notice|reminder|request|schedule|scheduling|invitation)\b/i.test(t)) continue; // an advance notice of an inspection is not a report
    const type = hits[0];
    if (type === IV && head.slice(0, i).some((l) => /\b(?:certificate|lease|rent roll|inspection)\b/i.test(l.t))) return null;
    return { type, confidence: i < 3 ? 0.95 : 0.9 };
  }
  return null;
}

/* ------------------------------------------------------------------ labels */
const NUM = '(?: ?(?:no|number|num|nbr|id))?';
const ALL = null;
/**
 * [key, label regex source (matched against the WHOLE normalised label), value kind, document types (null = all), rank (lower wins), multi?]
 * Labels are normalised first: lower case, "#" -> " no", apostrophes dropped, OCR digit slips (1 for l, 0 for o) undone inside words, punctuation dropped.
 */
const LABELS = [
  ['service_address', `(?:property|building|premises|service|site|rental|job|project|subject property|unit) (?:address|location)|address of (?:premises|property)|premises address|rental property`, 'address', [WO, IV, LS, MI, MO, IR, RR, VC], 0],
  ['service_address', `property|premises|building|site`, 'address', [WO, IV, LS, MI, MO, IR, RR, VC], 1],
  ['service_address', `address|location`, 'address', [WO, LS, MI, MO, IR, RR], 2],
  ['property_name', `property name|community name|community|building name|property|apartment community|complex|complex name|development|project name|name of property`, 'pname', [WO, IV, LS, MI, MO, IR, RR, VC], 0],
  ['unit_number', `unit${NUM}|unit number|apt${NUM}|apartment${NUM}|apartment number|suite${NUM}|suite number|unit apt|apt unit|space${NUM}|unit/apt|apt/unit|unit or apartment|unit #`, 'unit', [WO, IV, LS, MI, MO, IR], 0],
  ['customer_name', `owner|property owner|owner name|landlord|landlord name|lessor|lessor name|owner/landlord|landlord/owner|owner of record|owner entity|owning entity|name of owner|owners name|landlords name|name of landlord`, 'name', [WO, IV, LS, MI, MO, IR, RR, VC], 0],
  ['tenant_name', `tenants?(?: names?)?|resident(?: name)?|residents?|lessees?(?: names?)?|occupants?(?: name)?|renter(?: name)?|tenant/resident|resident/tenant|name of (?:tenant|resident)|tenants name|residents name|lessees name|occupant name|primary tenant|primary resident|tenant names?|co[- ]?tenants?|co[- ]?residents?|co[- ]?applicants?|co[- ]?lessees?|co[- ]?occupants?|additional (?:tenants?|residents?|occupants?)|second (?:tenant|resident)|joint tenants?`, 'name', [LS, MI, MO, IR, WO], 0],
  ['vendor', `vendor(?: name)?|contractor(?: name)?|subcontractor|vendor/contractor|contractor/vendor|service provider|supplier|vendor company|name of (?:vendor|contractor)|insured|insured name|named insured|name of insured|insureds name|invoice from|remit to|pay to|billed by|vendor assigned|assigned vendor|assigned contractor|performed by vendor`, 'name', [IV, COI, VC, WO], 0],
  ['vendor', `assigned to|assigned company`, 'company', [WO], 1],
  ['insurer', `insurer(?: [a-f])?|insurer name|insurance company|insurance carrier|carrier|underwriter|company affording coverage|insurers? affording coverage|insurance provider|insurer name a|carrier name`, 'name', [COI], 0],
  ['policy_number', `(?:gl |general liability |liability )?policy${NUM}|policy num|policy nbr|pol no|general liability policy ?(?:no|number)?`, 'id', [COI], 0],
  ['coi_expires', `policy expiration(?: date)?|policy expires?|policy expiry(?: date)?|policy exp(?: date)?|expiration date|expiry date|expires?|expiry|expiration|exp(?: date)?|coverage expires|coverage expiration(?: date)?|coverage end(?: date)?|policy end(?: date)?|valid through|valid until|good through|coverage through|insurance expires|insurance expiration(?: date)?|certificate expires|expires on|policy expires on|date of expiration|expiration of policy`, 'date', [COI], 0],
  ['_eff', `effective date|effective|policy effective(?: date)?|policy effective from|eff date|eff|policy start(?: date)?|inception date|coverage begins|coverage start|date effective|policy inception`, 'date', [COI], 0],
  ['_coi_range', `policy period|coverage period|policy term|period of coverage|policy dates|term of policy`, 'range', [COI], 0],
  ['gl_limit', `each occurrence|general liability limit|gl limit|gl each occurrence|general liability each occurrence|per occurrence|occurrence limit|each occurrence limit|liability limit|general liability limits|cgl each occurrence`, 'money', [COI], 0],
  ['workers_comp', `workers comp|workers compensation|workers comp coverage|workers compensation and employers liability|wc|workers comp ins|workers compensation insurance|workers compensation coverage|wc statutory|workers comp statutory`, 'wc', [COI], 0],
  ['coverage_type', `coverage|coverage type|coverage types|coverages|types of coverage|type of insurance|lines of coverage|insurance type|coverages carried|coverage carried`, 'cov', [COI], 0, true],
  ['work_order_number', `(?:work order|wo|w/o|maintenance request|service request|request|ticket|job|order|work request|maintenance ticket)${NUM}|work order number|request id`, 'docid', [WO], 0],
  ['work_order_number', `(?:work order|wo|w/o)${NUM}|work order ref(?:erence)?|wo ref(?:erence)?|related work order|work order reference`, 'docid', [IV], 0],
  ['invoice_number', `(?:invoice|inv|bill)${NUM}|invoice number|invoice id|inv no`, 'docid', [IV], 0],
  ['priority', `priority|priority level|urgency|severity`, 'priority', [WO], 0],
  ['status', `status|work order status|wo status|request status|current status|job status|ticket status`, 'wostatus', [WO], 0],
  ['status', `payment status|paid status|status|invoice status|payment state|paid/unpaid`, 'paystatus', [IV], 0],
  ['status', `lease status|status|tenancy status|tenant status|occupancy status|occupancy`, 'lsstatus', [LS], 0],
  ['completed_date', `date completed|completed|completed on|completion date|date closed|closed on|closed|date finished|completed date|date resolved|resolved on|date work completed|work completed on|date of completion|closed date|close date`, 'date', [WO], 0],
  ['opened_date', `date opened|opened|opened on|date created|created|created on|date submitted|submitted|submitted on|request date|date requested|requested|requested on|date reported|reported|reported on|open date|opened date|created date|date entered|date received|received`, 'date', [WO], 0],
  ['service_date', `scheduled date|scheduled for|date scheduled|scheduled|service date|date of service|appointment date|appointment|work date|date of work|scheduled service date|scheduled on`, 'date', [WO], 0],
  ['opened_date', `date|dated|wo date|work order date|report date`, 'date', [WO], 3],
  ['invoice_date', `invoice date|date of invoice|date invoiced|billing date|date billed|bill date|invoiced on|invoice dt`, 'date', [IV], 0],
  ['invoice_date', `date|dated|date issued|issue date|issued`, 'date', [IV], 3],
  ['invoice_due', `due date|payment due|payment due date|due|date due|pay by|due by|invoice due|invoice due date|due on|payable by|net due date|pay on or before|payment due by`, 'date', [IV], 0],
  ['service_date', `service date|date of service|work date|date work performed|work performed on|date of work|completed|completion date|date completed|date of repair`, 'date', [IV], 0],
  ['cost', `grand total|invoice total|total cost|actual cost|total charges|total due|total amount due|total amount|total invoice|work order total|total price`, 'money', [WO, IV], 0],
  ['cost', `total|net total|amount total`, 'money', [WO, IV], 1],
  ['cost', `amount due|amount|cost|charge|charges|price`, 'money', [WO, IV], 2],
  ['work_performed', `work performed|work done|description of work|scope of work|work description|work completed|services performed|services rendered|description|work requested|services|tasks|resolution|work to be done|work order description|request description|work items|description of services|work order scope|repairs performed|corrective action|work summary|summary of work|details of work|line items`, 'list', [WO, IV], 0, true],
  ['technician', `technician|tech|performed by|completed by|worked by|assigned tech|assigned technician|maintenance tech|vendor tech|service tech|serviced by`, 'person', [WO, IV], 0],
  ['notes', `notes?|comments?|remarks|additional notes|technician notes|special instructions|instructions|problem|issue|reported issue|tenant complaint|complaint|description of problem|resident request|resident notes|vendor notes|inspector notes|general notes|inspector comments`, 'text', [WO, IV, LS, MI, MO, IR], 0],
  // lease
  ['lease_start_date', `lease start(?: date)?|start date|commencement date|lease commencement(?: date)?|term begins|lease begins|beginning date|lease term begins|lease from|start of lease|lease effective(?: date)?|lease start dt`, 'date', [LS], 0],
  ['lease_end_date', `lease end(?: date)?|end date|expiration date|lease expires?|lease expiration(?: date)?|term ends|lease ends|ending date|expires|lease term ends|lease through|end of lease|lease end dt|lease expiry|expiration|expiry date|lease ending`, 'date', [LS], 0],
  ['_ls_range', `lease term|term|lease period|term of lease|lease dates|lease term dates|term of tenancy|period of lease`, 'range', [LS], 0],
  ['rent_amount', `monthly rent|rent|rent amount|base rent|rent per month|monthly rent amount|current rent|rent monthly|monthly rental rate|rental rate|rent payment|monthly rental|rent due monthly|rent amount monthly|total monthly rent`, 'money', [LS], 0],
  ['security_deposit', `security deposit|deposit|security deposit amount|deposit amount|damage deposit|security deposit held|deposit held`, 'money', [LS], 0],
  // inspections
  ['service_date', `inspection date|date of inspection|inspected on|date inspected|date performed|walk ?through date|inspection performed on|date of walk ?through|inspected|date conducted|date of site inspection`, 'date', [MI, MO, IR], 0],
  ['service_date', `move in date|date of move in|move in|moved in|move in on|tenant move in date|move in date of`, 'date', [MI], 1],
  ['service_date', `move out date|date of move out|move out|moved out|vacate date|date vacated|move out on|tenant move out date`, 'date', [MO], 1],
  ['service_date', `date|dated|report date|date of report`, 'date', [MI, MO, IR], 3],
  ['inspection_type', `inspection type|type of inspection|type|inspection|inspection category|inspection kind|inspection name|kind of inspection`, 'itype', [IR], 0],
  ['inspection_result', `result|inspection result|overall result|outcome|inspection outcome|inspection status|overall|overall rating|disposition|final result|results`, 'iresult', [IR, MI, MO], 0],
  ['inspection_result', `status`, 'iresult', [IR, MI, MO], 2],
  ['deficiency', `deficiencies|deficiencies found|deficiency list|items needing correction|violations|violations found|items to correct|corrections required|corrections needed|defects|issues found|items requiring repair|damage noted|damages|damages noted|deficient items|failed items|items needing repair|deficiencies noted|corrections`, 'list', [IR, MI, MO], 0, true],
  ['reinspection_due', `reinspection due|reinspection date|re inspection due|reinspect by|reinspection required by|reinspection deadline|re inspection date|correct by|corrections due|cure by|reinspect on|follow up inspection|follow up inspection date|follow up date|reinspection due date|re inspection due date|corrections due by|reinspection by|reinspection scheduled|reinspection scheduled for`, 'date', [IR, MI, MO], 0],
  // vendor contract
  ['contract_scope', `scope of services|scope|services|services covered|service description|description of services|scope of work|services provided|covered services|contract scope|scope of service`, 'text', [VC], 0],
  ['contract_start', `contract start(?: date)?|start date|effective date|commencement date|term start|contract effective(?: date)?|effective|start of term|contract begins|commencement|agreement start(?: date)?|agreement effective date|contract start dt|begin date`, 'date', [VC], 0],
  ['contract_end', `contract end(?: date)?|end date|expiration date|expires|expiration|term end(?: date)?|contract expires|contract expiration(?: date)?|expiry|end of term|current term ends|term ends|expiry date|contract expiry|agreement end(?: date)?|current term end|contract end dt|expires on|termination date|contract ends`, 'date', [VC], 0],
  ['_vc_range', `term|contract term|initial term|current term|term of agreement|contract period|service period|agreement term|term of contract|current term dates`, 'range', [VC], 0],
  ['agreement_term', `term|contract term|initial term|current term|term of agreement|contract period|service period|agreement term|term of contract|term length|contract length|length of term`, 'term', [VC], 1],
  ['auto_renew', `auto renew|auto renewal|automatic renewal|renewal|auto renews|renews automatically|renewal terms|evergreen|auto renew clause|automatic renew|renewal type|renewal clause|renewal option|auto renewal clause|renewal status|automatically renews`, 'yesno', [VC], 0],
  ['monthly_amount', `monthly fee|monthly amount|monthly charge|monthly rate|fee per month|monthly price|monthly payment|monthly service fee|monthly cost|amount per month|monthly|monthly contract amount|monthly retainer|monthly service charge|price per month|cost per month|charge per month|monthly base fee`, 'money', [VC], 0],
  ['monthly_amount', `fee|price|amount|rate|service fee|contract amount|contract price|service charge|charge|cost|contract fee`, 'monthly_money', [VC], 1],
];

const normLabel = (s) => {
  const low = String(s).toLowerCase().replace(/['\u2019]/g, '').replace(/#/g, ' no ');
  const fixed = low.split(/\s+/).map((w) => (/[a-z]{2}/.test(w) && /[10]/.test(w) ? w.replace(/1/g, 'l').replace(/0/g, 'o') : w)).join(' ');
  return fixed.replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
};
const COMPILED = LABELS.map(([key, src, kind, types, rank = 0, multi = false]) => ({ key, re: new RegExp(`^(?:${src})$`, 'i'), kind, types, rank, multi }));
const EXTRA_LABEL = /^(?:(?:early[- ]?pay(?:ment)?|prompt[- ]?pay(?:ment)?|volume|cash|trade)? ?discounts?|credits?(?: (?:memo|applied|issued|given|balance|amount))*|credit memos?(?: applied)?|less (?:payments?|credits?|discounts?|retainage|deposit)|adjustments?(?: (?:amount|applied))?|(?:payments?|credits?|deposits?) applied|payments? (?:made|received)|retainage(?: (?:held|withheld|amount))?|amount (?:credited|applied)|paid to date|write[- ]?offs?|(?:owner|tenant|vendor|contact|billing|office|work)? ?(?:phone|tel|telephone|fax|email|e-?mail|mobile|cell)(?: ?(?:no|number|num))?|phone|tel|telephone|fax|mobile|cell|email|e-?mail|contact|contact name|city|state|zip|zip code|bill to|billed to|certificate holder|description of operations|producer|agent|terms|payment terms|subtotal|sub total|tax|sales tax|balance|balance due|amount paid|payments|deposit paid|page|prepared by|inspector|inspected by|manager|property manager|issued|date issued|nte|not to exceed|estimated cost|estimate|approved by|authorized by|signature|signed|tenant signature|landlord signature)$/;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/^[\s:\u2013\u2014-]+|[\s;,]+$/g, '').trim();
const STREET = /\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop|run|row|path|plaza)\b/i;
const looksAddress = (v) => /^\d+[A-Za-z]?\s+\w+/.test(v) && STREET.test(v);
const LEGAL_SUFFIX = /\b(?:llc|inc|incorporated|corp|corporation|co|company|ltd|lp|llp)\b\.?/i;

function splitLine(t) {
  let m = t.match(/^([^:=]{2,48}?)\s*[:=]\s*(.*)$/);
  if (m && /[a-z]/i.test(m[1])) return { label: m[1], value: m[2] };
  m = t.match(/^(.{2,40}?)\s+[-\u2013\u2014]\s+(.+)$/);
  if (m && /[a-z]/i.test(m[1])) return { label: m[1], value: m[2] };
  return null;
}
const isKnownLabel = (label) => { const n = normLabel(label); return EXTRA_LABEL.test(n) || COMPILED.some((c) => c.re.test(n)); };

const COV_NAMES = [[/general\s+liab|\bcgl\b|^gl$|commercial general/i, 'General Liability'], [/workers?\W{0,2}s?\W*comp|\bwc\b/i, 'Workers Compensation'], [/auto/i, 'Automobile Liability'], [/umbrella|excess/i, 'Umbrella Liability'], [/professional|e&o|errors/i, 'Professional Liability']];
const covCanon = (t) => { for (const [re, name] of COV_NAMES) if (re.test(t)) return name; return null; };
const ITYPE = /\b(?:annual|fire|safety|smoke|move[- ]?in|move[- ]?out|hoa|code|unit|habitability|pre[- ]?lease|turnover|quarterly|biennial|elevator|pool|exterior|common area|life safety|sprinkler|carbon monoxide|mold|lead|health|building|city|county|state|follow[- ]?up|re-?inspection|property)\b/i;
const IRESULT = /^(?:pass(?:ed)?|fail(?:ed)?|satisfactory|unsatisfactory|pass(?:ed)? with (?:deficiencies|exceptions|corrections|comments)|conditional(?:ly)? pass(?:ed)?|approved|not approved|needs? (?:repairs?|corrections?|work)|corrections? required|reinspection required|re-?inspection needed|compliant|non-?compliant|acceptable|unacceptable|no violations|violations found|deficiencies found|good|fair|poor|excellent)$/i;
const NONE_VAL = /^(?:none|n\/a|na|nil|nothing|no|-+|\u2014|no deficiencies.*|no violations.*|no damages?.*|no issues.*|none noted|none observed)$/i;

function readValue(kind, raw) {
  const v = clean(raw);
  if (!v) return null;
  switch (kind) {
    case 'date': { const m = v.replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, '').match(new RegExp('^' + DATE_RE)); return m ? parseDate(m[1]) : null; }
    case 'range': { const m = v.match(RANGE_RE); if (!m) return null; const a = parseDate(m[1]); const b = parseDate(m[2]); return a && b ? { a, b } : null; }
    case 'money': {
      // another currency is never read as dollars; a weekly / yearly / hourly figure is never read as the monthly or total amount; "1.200,00" is never read as 1
      if (/\b(?:eur|euros?|gbp|pounds?|cad|aud|mxn|pesos?|chf|jpy|yen|cny|rmb|inr|rupees?|nzd|sgd|hkd|brl|zar|sek|nok|dkk|pln)\b|[\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd]|\b(?:c|ca|can|a|au|mx|nz|hk|s|r)\$/i.test(v)) return null;
      if (/\b(?:per|a|each)\s*(?:hr|hour|week|wk|year|yr|day|sq\.?\s*ft|sf|quarter|annum)\b|\/\s*(?:hr|hour|week|wk|year|yr|day|sf|sq)\b|\b(?:weekly|bi-?weekly|semi-?monthly|annual(?:ly)?|yearly|daily|quarterly|hourly)\b/i.test(v)) return null;
      const m = v.match(/^(?:usd\s*|us\s*)?\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d/]|[.,]\d)/i); if (!m) return null; const tail = v.slice(m[0].length);
      // a range ("$1,450 - $1,500") or a figure that changes later ("increasing to ...") is not one amount
      if (/^\s*(?:[-\u2013\u2014]|to\b|through\b|or\b)\s*(?:usd\s*)?\$?\s*\d/i.test(tail) || (/\b(?:increas\w*|rais\w*|adjust\w*|escalat\w*|step[- ]?up|thereafter|then|beginning|starting|effective)\b/i.test(tail) && /\d/.test(tail))) return null;
      if (/^[ \u00a0\u202f\u2009]\d{3}\b|^\s*k\b|^\s*(?:-\s*$|cr\b|credit\b|dr\b)/i.test(tail)) return null; // "1 250.00", "1k", "900.00-", "900.00 CR": never read as a different amount
      const n = m[1].replace(/,/g, ''); return +n > 0 && +n < 1e9 ? n : null; }
    case 'monthly_money': { if (!/\b(?:per month|\/\s*mo(?:nth)?|monthly|a month|each month|\bpm\b)/i.test(v) || /\b(?:annual|annually|per year|\/\s*yr|yearly|quarterly|per quarter)\b/i.test(v)) return null; return readValue('money', v); }
    case 'id': case 'docid': {
      const m = v.match(kind === 'docid' ? /^((?:[A-Za-z]{1,3}\s+(?=\d))?[A-Za-z0-9][A-Za-z0-9\-./]{1,}(?:\s+(?=[A-Za-z0-9\-./]*\d)[A-Za-z0-9\-./]+){0,1})/ : /^((?:[A-Za-z]{1,3}\s+(?=\d))?[A-Za-z0-9][A-Za-z0-9\-./]{2,}(?:\s+(?=[A-Za-z0-9\-./]*\d)[A-Za-z0-9\-./]+){0,1})/);
      const id = m ? m[1].replace(/[.,;]+$/, '') : null;
      return id && /\d/.test(id) ? id : null;
    }
    case 'unit': { const m = v.replace(/^(?:unit|apt\.?|apartment|suite|ste\.?|#)\s*#?\s*/i, '').match(/^([A-Za-z0-9][A-Za-z0-9-]{0,9})(?:\s*\((?:[^()]{1,30})\))?\s*$/); return m && (/\d/.test(m[1]) || m[1].length <= 2) && !/^(?:n\/?a|tbd)$/i.test(m[1]) ? m[1] : null; }
    case 'name': case 'pname': {
      let x = v.replace(/\s*[,\u2013\u2014-]\s*\d+\s+\w+.*$/, '');
      if (kind === 'pname' && /^\d/.test(x)) return null;
      if (!/[A-Za-z]{3}/.test(x) || x.length > 80 || looksAddress(x) || /^(?:n\/?a|none|unknown|tbd|vacant)$/i.test(x) || /^[\d\s()-]+$/.test(x) || /@/.test(x)) return null;
      return x;
    }
    case 'company': { const x = readValue('name', v); return x && LEGAL_SUFFIX.test(x) && !/\b(?:in[- ]?house|on[- ]?site|staff|crew|team|supervisor|super)\b/i.test(v) ? x : null; }
    case 'person': { const p = v.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim().split(/[,;]/)[0].trim(); return /[A-Za-z]{2}/.test(p) && p.length <= 60 && (p.match(/\d/g) ?? []).length <= 2 && !/^(?:n\/?a|none|unknown|tbd)$/i.test(p) ? p : null; }
    case 'address': {
      if (!(/\d/.test(v) || STREET.test(v)) || v.length > 140 || !/[A-Za-z]{2}/.test(v) || /^\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}$/.test(v)) return null;
      return v;
    }
    case 'priority': return /^(?:emergency|urgent|high|medium|med|normal|low|routine|critical|standard|asap|p[1-4]|priority \d)$/i.test(v) ? v : null;
    case 'wostatus': return /^(?:open|opened|new|assigned|scheduled|in[- ]?progress|pending|completed|complete|closed|cancell?ed|on hold|waiting(?: on [a-z ]+)?|resolved|dispatched|approved|awaiting approval|submitted|done)$/i.test(v) ? v : null;
    case 'paystatus': return /^(?:paid|unpaid|open|overdue|past due|due|partial|partially paid|partial payment|void|voided|pending|paid in full|outstanding|current|not paid)$/i.test(v) ? v : null;
    case 'lsstatus': return /^(?:active|current|expired|month[- ]to[- ]month|mtm|renewed|terminated|pending|holdover|hold over|notice given|notice to vacate|vacant|occupied|future|upcoming|ended|in effect|signed|draft|unsigned|cancell?ed|void(?:ed)?|superseded|rescinded|replaced)$/i.test(v) || /^(?:terminated|notice to vacate(?: given)?|notice given)\b/i.test(v) ? v : null;
    case 'itype': return ITYPE.test(v) && !/^\d+$/.test(v) && v.length <= 80 ? v : null;
    case 'iresult': return IRESULT.test(v) ? v : null;
    case 'wc': return /^(?:yes|y|statutory|included|in force|active|carried|covered|no|none|n\/a|not carried|waived|exempt|excluded)\b/i.test(v) && v.length <= 40 ? v : null;
    case 'yesno': { const y = /^(?:yes|y|true|automatic(?:ally)?(?: renew\w*)?|auto[- ]?renew(?:s|al)?|renews automatically|evergreen|renews? (?:annually|monthly|yearly|each (?:year|month))|annual(?:ly)?|continues?)\b/i.test(v); const n = /^(?:no|n|false|none|manual|does not (?:auto[- ]?)?renew|not automatic(?:ally)?|will not renew|not auto[- ]?renew\w*)\b/i.test(v); return y && !n ? 'yes' : n && !y ? 'no' : null; }
    case 'term': return /\d|year|month/i.test(v) && v.length <= 60 && !RANGE_RE.test(v) ? v : null;
    case 'cov': case 'list': case 'text': default: return v.length > 200 ? v.slice(0, 200) : v;
  }
}

const NOISE = /^(?:scanned|fax received|pg\s*\d|page \d|page scanned|doc id|printed|received|~+|\d+\s*\/\s*\d+$|confidential|continued|\u00a9|copyright)/i;
const BULLET = /^(?:\d{1,2}[.)]|[a-z][.)]|[-\u2022*\u2013\u00b7])\s+(.{2,})$/;
const STRONG = new Set(['phone', 'tel', 'telephone', 'fax', 'mobile', 'cell', 'email', 'e-mail', 'contact', 'zip']);

function splitColumns(t) {
  if (!/[:#]/.test(t)) return [t];
  const words = t.split(' '); const parts = []; let from = 0; let w = 1;
  while (w < words.length) {
    if (!words.slice(from, w).some((x) => /[:#]/.test(x) || x === '=')) { w++; continue; }
    let hit = null; let soft = null; // a label ending in a colon beats a shorter label guessed without one ("Lease End Date:" over "Lease End")
    for (let e = w; e < Math.min(w + 4, words.length) && !hit; e++) {
      const raw = words.slice(w, e + 1).join(' ');
      const colon = /:$/.test(words[e]); const hash = /^#$|#$/.test(words[e]);
      const cand = raw.replace(/[:#]+$/, '').trim();
      if (!/^[A-Za-z][A-Za-z0-9/#.'\- ]*$/.test(cand) || (e > w && /:$/.test(words[e - 1]))) continue;
      const known = isKnownLabel(cand);
      if (known && (colon || hash)) hit = { e, label: cand };
      else if (known && !colon && !hash && e > w && e + 1 < words.length && cand.split(' ').length >= 2 && !/^(?:date|type)$/i.test(cand)) soft = soft ?? { e, label: cand };
      else if (e === w && !colon && STRONG.has(cand.toLowerCase()) && e + 1 < words.length && w > from + 1) soft = soft ?? { e, label: cand };
    }
    hit = hit ?? soft;
    if (hit) { parts.push(words.slice(from, w).join(' ')); parts.push(null); from = w; words.splice(w, hit.e - w + 1, `${hit.label}:`); w = w + 1; }
    else w++;
  }
  parts.push(words.slice(from).join(' '));
  return parts.filter((x) => x).map((x) => x.trim()).filter(Boolean);
}

// a certificate's coverage line: "General Liability | Policy No: GL-1 | Eff: 1/1/26 | Exp: 1/1/27 | Each Occurrence: $1,000,000"
const COV_ROW = /^(?:commercial\s+|comm\.?\s+)?(?:general\s+liab(?:ility)?|gen\.?\s+liab(?:ility)?|cgl|gl)\b|^(?:workers?\W{0,2}s?\W*comp(?:ensation)?(?:\s*(?:&|and)\s*employers\W{0,2}\s*liability)?|wc)\b|^(?:business\s+|commercial\s+|hired\s+(?:and|&)\s+non-?owned\s+)?auto(?:mobile)?(?:\s+liability)?\b|^(?:umbrella|excess)(?:\s+liability|\s+liab)?\b|^professional\s+liability\b/i;
const HAS_DATE = new RegExp(DATE_RE);

/** zero-width and other invisible characters are nothing; the Unicode next-line is a space */
const invisible = (t) => String(t ?? '').replace(/[\u200b-\u200d\u2060\u180e\ufeff]/g, '').replace(/\u0085/g, ' ');
function toLines(pages) {
  const out = []; const budget = newBudget();
  for (const p of pages ?? []) {
    let blank = false;
    for (const raw0 of boundedLines(p.text, budget)) {
      const raw = invisible(raw0);
      const t = raw.replace(/\s+/g, ' ').trim();
      if (!t) { blank = true; continue; }
      const page = Number(p.page_no) || 1;
      const norm = t.replace(/\s*\|\s*/g, ' | ');
      if (COV_ROW.test(norm) && HAS_DATE.test(norm)) { out.push({ t: norm, page, blank, covRow: true }); blank = false; continue; }
      // a " | " is a column break: every cell is read on its own (a value is cut at the pipe, a stray pipe is never kept)
      const cells = t.replace(/\s*\|\s*$/, '').replace(/^\s*\|\s*/, '').split(/\s+\|\s+/).filter(Boolean);
      const segs = cells.flatMap((c) => splitColumns(c));
      for (const [k, seg] of segs.entries()) out.push({ t: seg, page, blank: k === 0 ? blank : false });
      blank = false;
    }
  }
  out.cut = budget.cut;
  return out;
}

const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ rent roll */
const RR_SPLIT = /\s*\|\s*|\t+|\s{2,}/;
const RR_COLS = [
  ['unit', /^(?:unit|unit no|unit number|unit #|apt|apt no|apt #|apartment|suite|space)$/],
  ['tenant', /^(?:tenant|tenant name|resident|resident name|lessee|occupant|name|tenants)$/],
  ['start', /^(?:lease start|lease from|start|start date|lease begin|move in|move-in|move in date|lease start date|begin date|commence)$/],
  ['end', /^(?:lease end|lease to|end|end date|expires|lease expires|lease expiration|lease end date|expiration|lease thru|expiry)$/],
  ['rent', /^(?:rent|monthly rent|current rent|rent amount|base rent|lease rent|contract rent)$/],
  ['mkt', /^(?:market rent|asking rent|market|asking|list rent|listed rent|asking price)$/],
  ['deposit', /^(?:deposit|security deposit|sec dep|sec deposit|deposit held)$/],
  ['status', /^(?:status|occupancy|occupancy status|lease status|unit status)$/],
];
const rrNorm = (c) => c.toLowerCase().replace(/['\u2019]/g, '').replace(/\s+/g, ' ').trim();
function rrHeader(t) {
  const cells = t.split(RR_SPLIT).map((c) => c.trim()).filter((c) => c);
  if (cells.length < 3) return null;
  const map = cells.map((c) => RR_COLS.find(([, re]) => re.test(rrNorm(c)))?.[0] ?? null);
  if (map[0] !== 'unit' || map.filter(Boolean).length < Math.max(3, cells.length - 1)) return null;
  const seen = new Set(map.filter(Boolean));
  // two columns that both look like a rent (Market Rent / Actual Rent, Current Rent / Previous Rent): which one is "the rent" is never guessed, the rows are counted unread
  const rentLike = cells.filter((c, i) => (map[i] === 'rent' || map[i] === 'mkt' || (!map[i] && /\b(?:rent|rate|charge|charges|payment|balance|amount|price|fee)\b/i.test(c))));
  if (seen.size !== map.filter(Boolean).length || rentLike.length > 1) return { n: cells.length, map, bad: true };
  return { n: cells.length, map };
}
const RR_VACANT = /^\(?\s*(?:vacant|vacancy|available|empty|unoccupied|vacant unit|unit vacant|-|\u2014|\u2013|n\/?a|none)\s*\)?$/i;
// a tenant cell that names no tenant and is not plainly "vacant" (a model unit, a unit that is down, an office...): the row is not read
const RR_UNREAD_T = /^\(?\s*(?:model(?: unit)?|down(?: unit)?|unit down|office|storage|admin|employee(?: unit)?|owner(?: occupied)?|manager(?:'?s)?(?: unit)?|maintenance|tbd|unassigned|reserved|not available|n\/?a tbd)\s*\)?$/i;
const RR_MTM = /^(?:mtm|m2m|m-t-m|month[\s-]*to[\s-]*month)$/i;
/** A row with blank cells (whitespace-aligned tables print nothing for an empty cell): place each printed cell by what it is, only when no choice is left; otherwise null (never guessed). */
function rrRagged(cells, hdr) {
  const c = cells.filter(Boolean);
  if (c.length < 3 || c.length >= hdr.n || hdr.map[0] !== 'unit' || !readValue('unit', c[0])) return null;
  const has = (k) => hdr.map.includes(k);
  const rest = c.slice(1);
  const dates = rest.filter((x) => readValue('date', x)); const monies = rest.filter((x) => !readValue('date', x) && readValue('money', x));
  const texts = rest.filter((x) => !readValue('date', x) && !readValue('money', x));
  if (texts.some((x) => RR_UNREAD_T.test(x))) return null;
  const vacant = texts.find((x) => RR_VACANT.test(x));
  const stCand = texts.filter((x) => x !== vacant && /^[A-Za-z][A-Za-z -]{1,24}$/.test(x));
  const statusFirst = has('status') && hdr.map.indexOf('status') < hdr.map.indexOf('tenant'); // the column order says which cell is which
  const status = statusFirst ? stCand[0] : stCand.pop();
  const names = texts.filter((x) => x !== vacant && x !== status);
  if (names.some((x) => /^(?:occupied|current|month[\s-]*to[\s-]*month|mtm|m2m|notice|pending|future|expired|ended|holdover|model|down|renewed|evicted|vacating|leased|available|unavailable)\b/i.test(x))) return null; // a status word in the tenant slot: never guessed
  if (names.length > 1 || (!vacant && !names.length) || (vacant && names.length)) return null;
  const out = new Array(hdr.n).fill('');
  const put = (k, v) => { const i = hdr.map.indexOf(k); if (i >= 0 && v) out[i] = v; };
  put('unit', c[0]); put('tenant', vacant ?? names[0]); if (has('status')) put('status', status);
  if (vacant) { if (dates.length || monies.length > 1 || (monies.length && !has('rent'))) return null; put('rent', monies[0]); return out; }
  if (monies.length > 2 || (monies.length === 2 && !(has('rent') && has('deposit'))) || (monies.length === 1 && has('rent') && has('deposit'))) return null;
  if (monies.length === 2) { const ks = hdr.map.filter((k) => k === 'rent' || k === 'deposit'); put(ks[0], monies[0]); put(ks[1], monies[1]); } else if (monies.length === 1) put('rent', monies[0]);
  if (dates.length === 2 && has('start') && has('end')) { put('start', dates[0]); put('end', dates[1]); }
  else if (dates.length === 1 && has('start') && /month[\s-]*to[\s-]*month|\bmtm\b/i.test(status ?? '')) put('start', dates[0]); // a month-to-month tenant has no end date
  else if (dates.length) return null;
  return out;
}
function rrRows(pages) {
  const rows = []; const conflicts = new Set(); let unread = 0;
  let hdr = null; const budget = newBudget();
  for (const p of pages ?? []) {
    for (const raw0 of boundedLines(p.text, budget)) {
      const raw = invisible(raw0);
      const t = raw.replace(/[ \u00a0]+$/, '').trim(); if (!t) continue;
      const h = rrHeader(t.replace(/\s{2,}/g, '  '));
      if (h) { hdr = h; continue; }
      if (!hdr || NOISE.test(t)) continue;
      let cells = t.split(RR_SPLIT).map((c) => c.trim()).map((c) => (RR_MTM.test(c) ? 'Month-to-month' : c));
      const rowLike = /^\d|^[A-Za-z]{1,3}[- ]?\d/.test(cells[0] ?? '') && !/^(?:total|totals)\b/i.test(t);
      if (hdr.bad) { if (rowLike) unread++; continue; }
      if (cells.length !== hdr.n && cells.filter((c) => c).length !== hdr.n) { if (cells.length > hdr.n && rowLike) unread++; /* a row with extra cells is counted unread, never silently dropped */ if (cells.length > hdr.n || !/^\d|^[A-Za-z]{1,3}[- ]?\d/.test(cells[0] ?? '')) continue; }
      if (cells.length !== hdr.n) { const fixed = rrRagged(cells, hdr); if (fixed) cells = fixed; else { if (rowLike) unread++; continue; } } // a short or ragged row is never guessed at (but counted, so the answer layer knows the list is incomplete)
      const unit = readValue('unit', cells[hdr.map.indexOf('unit')]);
      if (!unit || /^(?:total|totals|vacant|occupied)$/i.test(cells[0])) { if (!unit && rowLike) unread++; continue; }
      const parts = [`unit=${unit}`]; const rec = { unit }; let bad = false; let mkt = null; let tenantCell = '';
      const EMPTYC = /^(?:-|\u2014|\u2013|n\/?a|none|tbd|\?)?$/i;
      hdr.map.forEach((k, i) => {
        const c = cells[i]; if (!k || k === 'unit') return;
        if (k === 'tenant') tenantCell = c ?? '';
        if (!c || EMPTYC.test(c) && k !== 'tenant') return;
        if (k === 'tenant') { if (RR_VACANT.test(c)) { rec.vacant = true; return; } if (RR_UNREAD_T.test(c)) { bad = true; return; } const nm = readValue('name', c); if (nm) { parts.push(`tenant=${nm}`); rec.tenant = nm; } else bad = true; }
        else if (k === 'end' && /^month-to-month$/i.test(c)) rec.mtm = true;
        else if (k === 'start' || k === 'end') { const d = readValue('date', c); if (d) { parts.push(`lease_${k}=${d}`); rec[k] = d; } else bad = true; }
        else if (k === 'rent' || k === 'deposit') { const m = readValue('money', c); if (m) { parts.push(`${k === 'rent' ? 'rent' : 'deposit'}=${(+m).toFixed(2)}`); rec[k] = m; } else bad = true; }
        else if (k === 'mkt') { const m = readValue('money', c); if (m) mkt = m; else bad = true; }
        else if (k === 'status') { const st = c.replace(/\s+/g, ' ').trim(); if (/^[A-Za-z][A-Za-z -]{1,24}$/.test(st)) { parts.push(`status=${st}`); rec.status = st; } else bad = true; }
      });
      // an asking (market) rent is only ever the listed rent of a vacant unit, and only when the roll has no rent column of its own
      if (mkt && !hdr.map.includes('rent') && rec.vacant) { parts.push(`rent=${(+mkt).toFixed(2)}`); rec.rent = mkt; }
      const stVac = /\b(?:vacant|available|empty|unoccupied)\b/i.test(rec.status ?? '');
      if (!rec.tenant && !rec.vacant && !stVac && hdr.map.includes('tenant') && !rec.mtm) bad = true; // an empty tenant cell on a row that does not say vacant: whose unit is it?
      if (rec.tenant && (rec.vacant || stVac)) bad = true; // a named tenant on a unit marked vacant
      if (rec.vacant && rec.status && !stVac) bad = true; // "Vacant" tenant but a status that says something else
      if (bad) { unread++; continue; }
      if ((rec.vacant || stVac) && !rec.status) parts.push('status=Vacant');
      if (rec.mtm) { const i = parts.findIndex((x) => x.startsWith('status=')); if (i < 0) parts.push('status=Month-to-month'); else if (!/month/i.test(parts[i])) parts[i] = `${parts[i]} month-to-month`; }
      if (rec.start && rec.end && rec.end < rec.start) { for (const k of ['start', 'end']) { const i = parts.findIndex((x) => x.startsWith(`lease_${k}=`)); if (i >= 0) parts.splice(i, 1); } }
      rows.push({ unit, text: parts.join('; '), page: Number(p.page_no) || 1, verbatim: t.slice(0, 200) });
    }
  }
  const byUnit = new Map();
  for (const r of rows) { const u = byUnit.get(r.unit); if (u && u.text !== r.text) conflicts.add(r.unit); if (!u) byUnit.set(r.unit, r); }
  unread += conflicts.size;
  const out = [...byUnit.values()].filter((r) => !conflicts.has(r.unit));
  out.unread = unread;
  out.truncated = budget.cut; // text past the scan cap was never read: the rent roll is incomplete
  return out;
}

/* ------------------------------------------------------------------ main */
const CLEAN_LABEL_IN_VALUE = /\b(?:phone|tel|fax|e-?mail|contact|city|invoice|policy|insured|tenant|unit|vendor|contractor|expires?|status)\s*(?:[:#=]|no\b\.?|num\b)/i;

export function extractProperty(pages, opts = {}) {
  // `today` (YYYY-MM-DD) comes from the caller; the extractor never reads the clock. Without it the future-date plausibility drop is skipped.
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.today ?? '')) ? opts.today : null;
  DATE_ORDER = scanDateOrder(pages);
  const lines = toLines(pages);
  if (!lines.length) return null;
  // a credit memo is a document that says so in its own title (first lines); a mention in body text ("no credit memo has been issued") never changes a sign
  const isCreditDoc = lines.slice(0, 6).some((l) => l.t.length <= 60 && /^(?:[A-Za-z&.,' -]{0,40}\s)?credit (?:memo|note|memorandum)\b(?:\s*(?:#|no\.?|number)?\s*:?\s*[A-Za-z0-9-]*)?$/i.test(l.t) && !/\b(?:no|not|must|has|have|will|may|if)\b/i.test(l.t));
  const cls = classify(lines);
  if (!cls) return null;
  const type = cls.type;
  const best = new Map(); const multi = []; const allVals = new Map();
  let order = 0;
  const seeVal = (key, v) => { if (!allVals.has(key)) allVals.set(key, new Set()); allVals.get(key).add(String(v).toLowerCase()); };
  const offer = (key, rank, value, line, multiple) => {
    if (value == null || value === '') return;
    seeVal(key, value);
    if (multiple) { if (!multi.some((m) => m.key === key && m.value === value)) multi.push({ key, value, line, order: order++ }); return; }
    const cur = best.get(key);
    if (!cur || rank < cur.rank) best.set(key, { rank, value, line, order: cur?.order ?? order++, ties: 0 });
    else if (rank === cur.rank && cur.value !== value) cur.ties += 1;
  };
  const eff = []; const expiries = []; const polRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.covRow) {
      if (type !== COI) continue;
      const t = line.t;
      const cov = covCanon(t.split('|')[0].trim());
      const policyRaw = t.match(/\bpolicy\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1] ?? null;
      const policy = policyRaw && /\d/.test(policyRaw) ? policyRaw : null; // a policy number has a digit; "Policy Expiration" is a label, never a number
      const ex = t.match(new RegExp(`\\b(?:exp(?:ires?|iration|iry)?(?:\\s*date)?)\\b\\W{0,3}${DATE_RE}`, 'i'));
      const ef = t.match(new RegExp(`\\beff(?:ective)?(?:\\s*date)?\\b\\W{0,3}${DATE_RE}`, 'i'));
      const all = [...t.matchAll(new RegExp(DATE_RE, 'g'))].map((m) => m[1]);
      let expiry = null; let effective = null;
      if (ex) expiry = parseDate(ex[1]); else if (all.length === 2 && ef) expiry = parseDate(all[1] === ef[1] ? all[0] : all[1]);
      if (ef) effective = parseDate(ef[1]);
      if (expiry && effective && expiry < effective) expiry = null;
      const limit = cov === 'General Liability' ? readValue('money', t.match(/(?:each\s+occurrence|per\s+occurrence|occurrence)\W{0,3}(\$?[\d,]+(?:\.\d\d)?)/i)?.[1] ?? '') : null;
      polRows.push({ cov, policy, expiry, line, limit });
      continue;
    }
    const sp = splitLine(line.t);
    if (!sp) {
      // a bare heading naming a coverage ("General Liability")
      if (type === COI && line.t.length <= 60 && COV_ROW.test(line.t) && covCanon(line.t) && !/\d/.test(line.t)) offer('coverage_type', 0, covCanon(line.t), line, true);
      continue;
    }
    const n = normLabel(sp.label);
    if (!n) continue;
    const cands = COMPILED.filter((c) => (!c.types || c.types.includes(type)) && c.re.test(n));
    if (!cands.length) continue;
    let used = false;
    for (const c of cands) {
      if (used) break;
      let raw = sp.value; let srcLine = line;
      if (!clean(raw)) {
        if (c.multi) {
          const items = []; let j = i + 1; let bulleted = false;
          while (j < lines.length && lines[j].page === line.page && items.length < 14) {
            const b = lines[j].t.match(BULLET);
            if (b) { bulleted = true; items.push({ text: clean(b[1]), line: lines[j] }); j++; continue; }
            if (bulleted) break;
            if (lines[j].blank && items.length) break;
            const sp2 = splitLine(lines[j].t);
            if ((sp2 && isKnownLabel(sp2.label)) || NOISE.test(lines[j].t) || lines[j].t.length > 140 || lines[j].covRow) break;
            items.push({ text: clean(lines[j].t), line: lines[j] }); j++;
          }
          if (items.length) { for (const it of items) for (const part of it.text.split(c.kind === 'cov' ? /\s*[;,/&]\s*|\s+and\s+/ : /\s*;\s*/)) emitMulti(c, part, it.line); used = true; i += items.length; }
          break;
        }
        const nx = lines[i + 1];
        if (!nx || nx.page !== line.page || nx.covRow) continue;
        const sp2 = splitLine(nx.t);
        if ((sp2 && isKnownLabel(sp2.label)) || NOISE.test(nx.t) || BULLET.test(nx.t)) continue;
        raw = nx.t; srcLine = nx;
      }
      if (c.multi) { for (const part of clean(raw).split(c.kind === 'cov' ? /\s*[;,/&]\s*|\s+and\s+/ : /\s*;\s*/)) emitMulti(c, part, srcLine); used = true; break; }
      if (c.kind === 'range') {
        const r = readValue('range', raw);
        if (!r) continue;
        if (r.b < r.a) { offer('_bad_range', 0, 'x', srcLine); used = true; continue; }
        if (c.key === '_ls_range') { offer('lease_start_date', 1, r.a, srcLine); offer('lease_end_date', 1, r.b, srcLine); }
        else if (c.key === '_vc_range') { offer('contract_start', 1, r.a, srcLine); offer('contract_end', 1, r.b, srcLine); }
        else { eff.push(r.a); expiries.push({ d: r.b, line: srcLine }); }
        used = true; continue;
      }
      if (c.key === '_eff') { const d = readValue('date', raw); if (d) { eff.push(d); used = true; } continue; }
      // "Lease End Date: Month-to-Month" is a status, not a date: no end date is invented
      if (c.key === 'lease_end_date' && type === LS && /^(?:month[\s-]*to[\s-]*month|mtm|m2m)\b/i.test(clean(raw))) { offer('status', -1, 'Month-to-Month', srcLine); used = true; continue; }
      let v = readValue(c.kind, raw);
      // a credit memo / negative invoice amount is read as a NEGATIVE number, never as a positive charge
      if (c.key === 'cost' && type === IV) { const neg = String(raw).trim().match(/^(?:\(\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*\)|-\s*\$?\s*([\d,]+(?:\.\d{1,2})?)|\$\s*-\s*([\d,]+(?:\.\d{1,2})?))/); if (neg) { const n = (neg[1] ?? neg[2] ?? neg[3]).replace(/,/g, ''); if (+n > 0) v = `-${n}`; } else if (v != null && isCreditDoc) v = `-${v}`; }
      // a short real name ("Li Xu", "Ed Wu", "Bo Ng"): two capitalised words, no digits, not a label word
      if (v == null && c.key === 'tenant_name') { const sn = clean(raw); if (/^[A-Z][a-z]{1,2}(?:\s+[A-Z][a-z]{1,2}){1,2}$/.test(sn) && !/^(?:to be|not available|no one|not applicable|see lease|for sale|no name|for rent)$/i.test(sn) && !/\b(?:tbd|n\/a|none|vacant|unknown|name|tenant|owner|unit)\b/i.test(sn)) v = sn; }
      // a short vendor that is clearly a company ("Ok Co", "Bo Inc")
      if (v == null && c.key === 'vendor' && sp.value && /^[A-Za-z][A-Za-z&.'-]{0,3}(?:\s+[A-Za-z&.'-]{1,12}){0,3}\s+(?:co|inc|llc|corp|ltd|company)\.?$/i.test(clean(raw)) && !/\d/.test(raw)) v = clean(raw);
      // "Property Address: Cactus Flats Villas": a name under an address label is the property's name; a street address still goes to service_address
      if (v == null && c.key === 'service_address' && /property|premises|building|site|rental|community/i.test(sp.label) && /^[A-Za-z][A-Za-z0-9 '&.-]{2,60}$/.test(clean(raw)) && !/\d/.test(clean(raw)) && !looksAddress(clean(raw))) { offer('property_name', 1, clean(raw), srcLine); used = true; continue; }
      if (v == null) continue;
      if (c.key === 'service_address') {
        // "Saguaro Ridge Apartments, 100 Main St, Mesa AZ" -> property name + address; "100 Main St, Unit 4B" -> address + unit
        const pm = v.match(/^([^,\d][^,]*?),\s*(\d+\s.*)$/);
        if (pm && !/\d/.test(pm[1]) && /[A-Za-z]{3}/.test(pm[1])) { offer('property_name', 1, pm[1].trim(), srcLine); v = pm[2]; }
        const um = v.match(/,?\s*\b(?:unit|apt\.?|apartment|suite|ste\.?)\s*#?\s*([A-Za-z0-9-]{1,8})\b(?=,|$)/i);
        if (um && type !== VC) { offer('unit_number', 2, um[1], srcLine); v = v.replace(um[0], '').replace(/\s+,/g, ',').trim(); }
        v = clean(v);
        if (!v) continue;
      }
      if (c.key === 'vendor' && c.kind === 'name' && type === COI && /^(?:n\/a|see|various)/i.test(v)) continue;
      if (c.key === 'cost' && !/\d/.test(v)) continue;
      if (c.key === 'gl_limit' && +v < 1000) continue;
      if (c.key === 'coi_expires') { expiries.push({ d: v, line: srcLine }); used = true; continue; }
      offer(c.key, c.rank, v, srcLine);
      used = true;
    }
  }
  function emitMulti(c, part, line) {
    const p = clean(part);
    if (p.length < 2) return;
    if (c.kind === 'cov') { const cn = covCanon(p); if (cn) offer('coverage_type', 0, cn, line, true); return; }
    if (c.key === 'deficiency' && NONE_VAL.test(p)) return;
    offer(c.key, c.rank, p, line, true);
  }

  // ---- certificate of insurance: policies, expiry, limits
  if (type === COI) {
    for (const pr of polRows) {
      if (pr.cov) offer('coverage_type', 0, pr.cov, pr.line, true);
      if (pr.expiry) expiries.push({ d: pr.expiry, line: pr.line });
    }
    const gl = polRows.find((r) => r.cov === 'General Liability');
    if (gl?.policy) offer('policy_number', 0, gl.policy, gl.line);
    else if (!gl && polRows.length === 1 && polRows[0].policy) offer('policy_number', 0, polRows[0].policy, polRows[0].line);
    if (gl?.limit) offer('gl_limit', 0, gl.limit, gl.line);
    const eMin = eff.length ? eff.reduce((a, b) => (a < b ? a : b)) : null;
    const uniq = [...new Map(expiries.map((e) => [e.d, e])).values()];
    const okExp = uniq.filter((e) => !(eMin && e.d < eMin && uniq.length === 1 && eff.length === 1));
    if (okExp.length) {
      const first = okExp.reduce((a, b) => (a.d < b.d ? a : b));
      offer('coi_expires', 0, first.d, first.line);
      if (okExp.length > 1) for (const e of okExp) offer('policy_expiry', 0, e.d, e.line, true);
    }
    // a bare "Exp" printed twice with different dates and no coverage names to tell them apart is not trusted
    if (!polRows.length && new Set(expiries.map((e) => e.d)).size > 1 && !allVals.get('coverage_type')?.size) best.delete('coi_expires');
  }

  // ---- vendor contract: auto-renewal printed as a sentence
  if (type === VC) {
    const sentences = lines.map((l) => l.t).filter((t) => (/\bauto(?:matic(?:ally)?)?[- ]?renew/i.test(t) || /\brenews?\b[^.]{0,30}\b(?:automatically|annually|monthly|yearly|each (?:year|month)|successive)\b|\bwill renew\b|\brenew(?:s|ed)? for successive\b|\bevergreen\b|\bcontinues?\b[^.]{0,30}\buntil terminated\b|\bcontinues?\b[^.]{0,40}\bmonth[- ]to[- ]month\b/i.test(t)) && !splitLine(t)?.label?.match(/^renewal|^auto/i));
    const neg = sentences.some((t) => /\b(?:not|never|no)\s+(?:be\s+)?(?:automatically|auto)[- ]?renew|\bnon[- ]renewing\b/i.test(t));
    const pos = sentences.some((t) => !/\b(?:not|never|no)\s+(?:be\s+)?(?:automatically|auto)[- ]?renew/i.test(t));
    const line = sentences[0] ? lines.find((l) => l.t === sentences[0]) : null;
    if (line && pos !== neg) { const v = pos ? 'yes' : 'no'; if (!best.has('auto_renew')) offer('auto_renew', 1, v, line); else if (best.get('auto_renew').value !== v) best.get('auto_renew').ties += 1; }
    else if (line && pos && neg) best.delete('auto_renew');
    if (!best.has('auto_renew')) { const hint = lines.find((l) => /\brenew|\bevergreen\b/i.test(l.t) && !/\b(?:not|never|no|non)[- ]\s*(?:be\s+)?(?:automatic\w*[- ]?)?renew/i.test(l.t) && !/\bdoes not renew\b|\bwill not renew\b/i.test(l.t)); if (hint) offer('auto_renew', 0, 'unclear', hint); } // the paper talks about renewing but not in a form that can be read: never "ended"
  }

  // ---- a certificate that says a policy was cancelled / lapsed / not renewed is never read as a current certificate
  // (the standard "should any of the above policies be cancelled before the expiration date" notice is boilerplate, not a cancellation)
  // (only clear positive statements drop the certificate: a bare status word, a cancellation date or "cancelled effective <date>"; the
  // boilerplate "CANCELLATION" heading, "Cancellation: 30 days notice", "Void where prohibited", "Terminated: no" are not cancellations)
  if (type === COI && lines.some((l) => {
    if (/should any of the above|before the expiration date thereof|in accordance with the policy provisions/i.test(l.t)) return false;
    const t = l.t.trim();
    return /^(?:(?:policy |certificate |coverage |document )?status\s*[:=-]\s*)?(?:cancel+ed|void(?:ed)?|superseded|terminated|rescinded|revoked)(?:\s+(?:effective|as of|on)?\s*[\d/.-]{6,10})?\W*$/i.test(t)
      || /^(?:date of )?cancell?ation(?: date)?\s*[:=-]\s*(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/i.test(t)
      || /\bcancel+ed (?:effective|as of)\s*(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/i.test(t)
      || /\bnotice of non-?renewal\b|\bnon-?renewed\b|\blapse (?:in|of) coverage\b/i.test(t)
      || /^(?:commercial\s+)?(?:general\s+liab\w*|gen\.?\s+liab\w*|cgl|gl|workers?\W{0,2}s?\W*comp\w*|wc|auto\w*(?:\s+liab\w*)?|umbrella|excess|professional\s+liab\w*)\b[^\n]*?[:=-]\s*(?:expired|cancel+ed|lapsed|terminated|void)\b/i.test(t) // a coverage line that itself says expired / cancelled
      || /^(?:commercial\s+)?(?:general\s+liab\w*|gen\.?\s+liab\w*|cgl|gl|workers?\W{0,2}s?\W*comp\w*|wc|auto\w*(?:\s+liab\w*)?|umbrella|excess|professional\s+liab\w*)\b[^\n:]*\bexp\w*[^\n:]*[:=-]\s*(?:n\/?a|none|not applicable|unknown|tbd|pending)\W*$/i.test(t) // a coverage whose expiry is not a date
      || /\b(?:polic(?:y|ies)|coverage|certificate)\b[^.:]{0,40}\b(?:was |has been |been )(?:cancel+ed|terminated|lapsed|rescinded|revoked)\b/i.test(t);
  })) return null;
  // ---- a bare VOID / CANCELLED / SUPERSEDED stamp line (or "Status: Void") makes the document not the live one
  { const sl = lines.slice(0, 60).find((l) => /^(?:(?:document |invoice |work order |lease |contract |agreement |record )?status\s*[:=-]\s*)?(?:void(?:ed)?|cancel+ed|superseded|rescinded|revoked|replaced)(?:\s+(?:on|effective|as of)?\s*[\d/.-]{6,10})?\W*$/i.test(l.t.trim()));
    if (sl) {
      const word = (sl.t.match(/(void(?:ed)?|cancel+ed|superseded|rescinded|revoked|replaced)/i)?.[1] ?? 'void');
      const canon = /^cancel/i.test(word) ? 'Cancelled' : /^void/i.test(word) ? 'Void' : word[0].toUpperCase() + word.slice(1).toLowerCase();
      if (type === VC) return null; // no status field exists for a contract: a voided contract is not read as a live one
      if ([IV, WO, LS].includes(type)) best.set('status', { rank: -5, value: canon, line: sl, order: order++, ties: 0 });
    } }
  // ---- invoice status from the money lines when no status is printed and the lines agree
  if (type === IV && !best.has('status')) {
    const amt = (re) => { const l = lines.find((x) => re.test(x.t)); const m = l?.t.match(/[:=]?\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/); return l && m ? { v: +m[1].replace(/,/g, ''), line: l } : null; };
    const bal = amt(/^balance(?: due)?\b/i); const paid = amt(/^(?:amount paid|payments?(?: received)?)\b/i);
    if (bal && bal.v === 0 && (!paid || paid.v > 0)) offer('status', 2, 'Paid', bal.line);
    else if (bal && bal.v > 0 && (!paid || paid.v === 0)) offer('status', 2, 'Unpaid', bal.line);
    else if (!bal && paid && paid.v === 0) offer('status', 2, 'Unpaid', paid.line);
  }

  // ---- a lease marked terminated / notice to vacate / move-out date, or printing month-to-month without a label
  if (type === LS) {
    const tl = lines.find((l) => /^(?:(?:lease |tenancy )?status\s*[:=-]\s*)?terminated(?:\s+(?:on|effective|as of)?\s*\d[\d/.-]*)?\W*$/i.test(l.t) || /^(?:lease )?termination date\s*[:=-]\s*\d/i.test(l.t) || /^date of termination\s*[:=-]\s*\d/i.test(l.t));
    const nl = lines.find((l) => /^(?:(?:lease |tenancy )?status\s*[:=-]\s*)?notice (?:to vacate|given)(?:\s*[:=-]?\s*(?:given|received|yes))?(?:\s*(?:on|:)?\s*\d[\d/.-]*)?\W*$/i.test(l.t) && /given|received|yes|\d/i.test(l.t.replace(/notice (?:to vacate|given)/i, '')) || /^(?:move[- ]?out|vacate) date\s*[:=-]\s*\d/i.test(l.t));
    const tl2 = lines.find((l) => /\blease (?:terminated|broken|ended|cancel+ed)\b|\b(?:tenant|resident) (?:vacated|moved out|left|evicted)\b|^unit vacated\b|^(?:lease )?status\s*[:=-]\s*(?:inactive|ended)\b/i.test(l.t.trim()));
    if (tl || tl2) offer('status', -2, 'Terminated', tl ?? tl2);
    else if (nl) offer('status', -2, 'Notice to vacate', nl);
    else if (!best.has('lease_end_date') && !best.has('status')) {
      const fixedType = lines.some((l) => /^(?:lease type|type|term|lease term|tenancy(?: type)?)\s*[:=]\s*(?:fixed|annual|one year|\d+[\s-]*months?|12)/i.test(l.t));
      const ml = lines.find((l) => /^(?:(?:lease |rental )?term|tenancy(?: type)?|lease type|type)\s*[:=]\s*(?:month[\s-]*to[\s-]*month|mtm|m2m)\W*$/i.test(l.t) || (!fixedType && /^(?:month[\s-]*to[\s-]*month|mtm|m2m)$/i.test(l.t)));
      if (ml) offer('status', -1, 'Month-to-Month', ml);
    }
    // the page prints a lease end label with a value we could not read: the lease is not accepted without its end date (it would silently vanish from expiring answers)
    if (!best.has('lease_end_date') && !best.has('status') && lines.some((l) => { const sp = splitLine(l.t); return sp && clean(sp.value) && COMPILED.find((c) => c.key === 'lease_end_date').re.test(normLabel(sp.label)); })) return null;
  }
  // ---- an invoice carrying a previous balance / past due amount: "Total Due" is not this invoice's cost
  if (type === IV && lines.some((l) => /^(?:previous|prior) (?:balance|amount)\b|^balance forward\b|^past due\b|^amount past due\b/i.test(l.t) || /total (?:amount )?due\b.*\(\s*\$?[\d,.]+\s*current/i.test(l.t))) {
    best.delete('cost');
    const cur = new Map();
    for (const l of lines) { const m = l.t.match(/^(?:current charges|charges this invoice|this invoice|current invoice|new charges)\b[^$\d]*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i) || l.t.match(/total (?:amount )?due\b.*\(\s*\$?([\d,]+(?:\.\d{1,2})?)\s*current/i); if (m) cur.set(m[1].replace(/,/g, ''), l); }
    if (cur.size === 1) { const [[v, l]] = [...cur]; if (+v > 0) offer('cost', 0, v, l); }
  }
  // ---- a bare unit line with no colon ("Unit #4-B", "Apt. 4B", "Suite 210") in the header region: read only when one distinct unit is printed there
  if (!best.has('unit_number') && [WO, IV, LS, MI, MO, IR].includes(type)) {
    const found = new Map();
    for (const l of lines.filter((x) => x.page === 1).slice(0, 15)) {
      const m = l.t.match(/^(?:unit|apt\.?|apartment|suite|ste\.?)\s*(?:no\.?|number|#)?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]{0,7})$/i);
      if (m && /\d/.test(m[1])) { const v = /^\d+-[A-Za-z]$/.test(m[1]) ? m[1].replace('-', '') : m[1]; found.set(v.toUpperCase().replace(/[^A-Z0-9]/g, ''), { v, l }); }
    }
    if (found.size === 1) { const { v, l } = [...found.values()][0]; offer('unit_number', 2, v, l); }
  }

  // ---- identity: a file holding two documents is never read as one
  const many = (k) => (allVals.get(k)?.size ?? 0) > 1;
  if (type === IV && many('invoice_number')) return null;
  if (type === WO && many('work_order_number')) return null;
  if (type === COI && (many('vendor') || many('insurer'))) return null;
  if (type === VC && many('vendor')) return null;
  if (type === LS && (many('tenant_name') || many('unit_number') || many('service_address'))) return null;
  if ((type === MI || type === MO || type === IR) && (many('unit_number') || many('tenant_name') || many('inspection_type'))) return null;
  if ((type === MI || type === MO || type === IR) && many('inspection_result')) return null;
  // a printed reinspection RESULT would change whether the first inspection is still failed / overdue: it is not read automatically (never reported as failed or overdue from the first result alone)
  if ((type === MI || type === MO || type === IR) && lines.some((l) => /^re-?\s?inspection\s+(?:result|outcome|status)\s*[:=-]\s*\S/i.test(l.t))) return null;
  if (allVals.has('_bad_range')) { best.delete('lease_start_date'); best.delete('lease_end_date'); best.delete('contract_start'); best.delete('contract_end'); }

  if (type === RR) {
    const rows = rrRows(pages);
    for (const r of rows) multi.push({ key: 'rent_roll_row', value: r.text, line: { t: r.verbatim, page: r.page }, order: order++ });
    if (!rows.length) return null;
    if (rows.unread || rows.truncated) { const nr = rows.truncated ? 'an unknown number of' : String(rows.unread); multi.push({ key: 'rent_roll_unread', value: nr, line: { t: `${nr} unit row(s) not read`, page: rows[0].page }, order: order++ }); }
  }

  // ---- build output
  const fieldsOut = [];
  const push = (key, e, conf) => fieldsOut.push({ key, value: e.value, page_no: e.line.page, verbatim: e.line.t.slice(0, 200), confidence: conf ?? (e.rank >= 2 ? 0.85 : 0.95), _o: e.order });
  for (const [key, e] of [...best]) if (key !== 'notes' && key !== 'work_performed' && key !== 'contract_scope' && CLEAN_LABEL_IN_VALUE.test(String(e.value))) best.delete(key);
  for (const [key, e] of best) if (e.ties > 0 && key !== 'notes') best.delete(key);
  const val = (k) => best.get(k)?.value;
  // ---- text that changes a date or amount under a label this reader does not know is never read as if the old value stood
  if ((type === VC || type === LS) && lines.some((l) => /\b(?:amend\w*|extend\w*|extension|revised|restated|renewed (?:to|through|until)|rent (?:increase|after|change)|increase[ds]? to|new (?:rent|end date|term)|modif\w+)\b/i.test(l.t) && (new RegExp(DATE_RE, 'i').test(l.t) || /\$\s*\d/.test(l.t)))) return null;
  // a reinspection result printed as a sentence ("Reinspected 10/02 - PASSED", "all items corrected") is not a labelled field, so the document is not read
  if (type === IR && lines.some((l) => /\breinspect\w*\b[^.]*\b(?:pass\w*|completed?|cleared|approved)\b|\ball (?:items|deficienc\w*) (?:were |have been )?(?:corrected|cleared|resolved)\b/i.test(l.t))) return null;
  // a certificate or contract whose own paper says it is not in force is not read as a live one (lapsed, inactive, suspended, expired, terminated)
  if ((type === COI || type === VC) && lines.some((l) => { const t = l.t.trim(); return /^(?:(?:policy |contract |coverage |certificate |document |agreement )?status\s*[:=-]\s*)(?:lapsed|inactive|suspended|expired|not in force|terminated|ended)\b/i.test(t) || /\b(?:coverage|polic(?:y|ies)|certificate)\b[^.]{0,30}\b(?:not in force|lapsed|suspended|inactive)\b/i.test(t) || /\b(?:was|has been|been|is hereby|now) terminated\b|\bterminated (?:effective|on \d|as of|by mutual)\b|\bnotice of termination (?:given|sent|received)\b|\b(?:contract|agreement) terminated\b|\blapsed \d{1,2}[/.-]\d{1,2}/i.test(t); })) return null;
  // a lease with a subtenant is not a plain single-resident lease
  if (type === LS && lines.some((l) => /^(?:sub-?tenants?|sublessee|sublet\w*)\b/i.test(l.t.trim()))) return null;
  // an inspection marked resolved / closed / passed in a status line
  if (type === IR && lines.some((l) => /^(?:inspection |report |work )?status\s*[:=-]\s*(?:resolved|closed|complete\w*|corrected|cleared|passed)\b/i.test(l.t.trim()))) return null;
  // a tenant field that carries a status, a guarantor or a phone number is not a plain resident name
  if (type === LS && /\b(?:moved out|vacated|evicted|eviction|guarantor|co-?signer|c\/o|former|deceased)\b|\d{3}[-. )]+\d{3,4}[-. ]\d{4}/i.test(String(val('tenant_name') ?? ''))) return null;
  // a certificate whose policy has not started yet is not a current one
  if (type === COI && today && eff.length && eff.every((d) => d > today)) return null;
  // pairs that cannot both be right: BOTH dropped
  const dropBoth = (a, b) => { if (val(a) && val(b) && val(b) < val(a)) { best.delete(a); best.delete(b); } };
  dropBoth('lease_start_date', 'lease_end_date'); dropBoth('contract_start', 'contract_end');
  for (const [a, b] of [['invoice_date', 'invoice_due'], ['opened_date', 'completed_date'], ['service_date', 'reinspection_due']]) if (val(a) && val(b) && val(b) < val(a)) best.delete(b);
  if (type === WO && val('service_date') && val('completed_date') && val('completed_date') < val('service_date') && best.get('service_date').rank === 0) best.delete('completed_date');
// (removed: an opened / request date is never the scheduled date)   if (type === WO && !best.has('service_date') && best.has('opened_date')) { const o = best.get('opened_date'); best.set('service_date', { ...o, rank: 2, order: order++ }); }
  // ---- an invoice's cost is accepted only when no OTHER money amount or percentage in the document is attached to adjustment-type wording (credit, discount, deposit, payment, retainage, ...): the printed total is then not what is owed
  if (type === IV && best.has('cost')) {
    const ADJW = /\b(?:less|credits?|discounts?|deposits?|prepaid|prepayments?|payments?|paid|refunds?|retention|retainage|adjustments?|write[- ]?offs?|partial|applied|net due|amount due|balance|prior|previous|courtesy|rebates?|allowances?)\b/i;
    const MONEY = /(?:[$\u20ac\u00a3]\s*[-(]?\s*\d|\d[\d,]*(?:\.\d+)?\s*%|\busd\s*\d|\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars|usd)\b|\(\s*\d[\d,]*\.\d\d\s*\)|-\s*\d[\d,]*\.\d\d|[:=]\s*\(?-?\d[\d,]*\.\d\d\)?\s*$)/i;
    const ALLOW = /\b(?:credit limit|credit card|card fee|credit terms|payment terms|terms|net \d+|late (?:fee|charge|payment)|waived|accepted|methods?|due upon|pay by|paid by|checks? payable|payable to|status)\b/i;
    const amounts = (t) => [...t.matchAll(/\(?-?\$?\s*(\d[\d,]*(?:\.\d+)?)\)?\s*(%?)/g)].map((m) => ({ v: +m[1].replace(/,/g, ''), pct: !!m[2] }));
    const costN = Math.abs(+String(best.get('cost').value));
    const settled = lines.some((l) => /^(?:balance(?: due)?|amount due)\b[^\d]*\$?\s*0*(?:\.0+)?\s*$/i.test(l.t)); // balance 0: the total is what was billed and it is paid in full
    let drop = false;
    for (const l of settled ? [] : lines) {
      if (!ADJW.test(l.t) || !MONEY.test(l.t) || ALLOW.test(l.t)) continue;
      if (/^(?:previous|prior) (?:balance|amount)\b|^balance forward\b|^past due\b|^amount past due\b|total (?:amount )?due\b.*\(\s*\$?[\d,.]+\s*current/i.test(l.t)) continue; // handled by the previous-balance rule above (cost only from an explicit current-charges line)
      const am = amounts(l.t.replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, ' '));
      if (!am.length || am.every((x) => x.v === 0)) continue; // zero amounts and 0% change nothing
      // a balance / amount due equal to the total is the total again; different (or lower) means something was applied
      if (/\b(?:balance|amount due|net due)\b/i.test(l.t) && !/\b(?:less|credit|discount|deposit|payment|paid|refund|retain|retention|adjust|partial|applied|prior|previous)\w*/i.test(l.t.replace(/\b(?:balance|amount due|net due|balance due)\b/ig, ' '))) { if (am.every((x) => x.pct || x.v === costN || x.v === 0)) continue; if (am.some((x) => x.v === 0) && am.length === 1) continue; }
      drop = true; break;
    }
    if (drop) best.delete('cost');
  }
  const horizon = today ? addDaysIso(today, 31) : '9999-12-31';
  for (const [key, e] of best) {
    if (key.startsWith('_')) continue;
    if (key === 'cost' && e.rank >= 2 && lines.some((l) => /^(?:sub ?total|tax|sales tax|balance|balance due|amount paid|payments?|deposit paid)\b/i.test(l.t))) continue; // a partial / balance line is not the total
    if (key === 'service_date' && (type === MI || type === MO || type === IR) && e.value > horizon) continue; // an inspection in the future is a misread
    if (key === 'completed_date' && e.value > horizon) continue;
    push(key, e);
  }
  for (const m of multi) {
    if (m.key === 'deficiency' && type !== IR && type !== MI && type !== MO) continue;
    if (m.key === 'coverage_type' && type !== COI) continue;
    fieldsOut.push({ key: m.key, value: m.value, page_no: m.line.page, verbatim: m.line.t.slice(0, 200), confidence: 0.9, _o: m.order });
  }
  const has = (k) => fieldsOut.some((f) => f.key === k);
  // inspection type from the title when no label gave it ("ANNUAL UNIT INSPECTION REPORT")
  if (type === IR && !has('inspection_type')) {
    const t = lines.slice(0, 4).find((l) => /\b(annual|fire[- ]?safety|life[- ]?safety|smoke detector|hoa|quarterly|pre-?lease|habitability|turnover|code)\b/i.test(l.t) && /\binspection\b/i.test(l.t) && !/:/.test(l.t));
    const m = t?.t.match(/\b(annual|fire[- ]?safety|life[- ]?safety|smoke detector|hoa|quarterly|pre-?lease|habitability|turnover|code)\b/i);
    if (m) fieldsOut.push({ key: 'inspection_type', value: m[1].replace(/^./, (c) => c.toUpperCase()), page_no: t.page, verbatim: t.t.slice(0, 200), confidence: 0.85, _o: 98 });
  }

  // ---- evidence: a page whose title says X but carries none of X's data is not X (letters, covers, requests)
  const cnt = (...ks) => ks.filter(has).length;
  const ok = {
    [COI]: () => has('coi_expires') && (has('vendor') || has('insurer')) && cnt('policy_number', 'insurer', 'coverage_type', 'gl_limit', 'workers_comp') >= 1,
    [LS]: () => has('tenant_name') && (has('lease_end_date') || has('lease_start_date') || /month/i.test(String(val('status') ?? ''))) && cnt('rent_amount', 'service_address', 'unit_number', 'property_name', 'security_deposit') >= 1,
    [RR]: () => has('rent_roll_row'),
    [MI]: () => cnt('tenant_name', 'unit_number', 'service_address') >= 2 && (has('service_date') || has('inspection_result')),
    [MO]: () => cnt('tenant_name', 'unit_number', 'service_address') >= 2 && (has('service_date') || has('inspection_result')),
    [IR]: () => cnt('service_address', 'property_name', 'unit_number') >= 1 && cnt('inspection_result', 'deficiency', 'reinspection_due') >= 1 && has('service_date'),
    [VC]: () => has('vendor') && cnt('contract_start', 'contract_end', 'monthly_amount', 'contract_scope') >= 2,
    [WO]: () => cnt('work_order_number', 'service_date', 'work_performed', 'status', 'priority', 'vendor') >= 3 && cnt('service_address', 'property_name', 'unit_number') >= 1,
    [IV]: () => has('cost') && cnt('invoice_number', 'invoice_date', 'vendor') >= 2,
  }[type];
  if (ok && !ok()) return null;

  fieldsOut.sort((a, b) => a._o - b._o);
  return { type, confidence: cls.confidence, fields: fieldsOut.filter((f) => !f.key.startsWith('_')).map(({ _o, ...f }) => f), ...(lines.cut && type !== RR ? { partial: true } : {}) };
}

/** Required keys for a type, from the property pack (a|b = either). */
export function missingRequired(type, fields, pack) {
  const req = pack?.documentTypes?.find((t) => t.id === type)?.requires ?? [];
  const have = new Set(fields.map((f) => f.key));
  return req.filter((r) => !r.split('|').some((k) => have.has(k)));
}
