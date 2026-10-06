/**
 * Plumbing paperwork reader (Build 2, stage 2C). Pure, no model, no database.
 *
 *   extractPlumbing(pages) -> { type, confidence, fields:[{key,value,page_no,verbatim,confidence}] } | null
 *
 * Reads a plumbing contractor's real paperwork by its printed labels: backflow test certificates, water heater
 * startup / installation records, warranty registrations, permits, inspection reports, sewer camera reports, service
 * tickets, work orders, invoices, quotes, agreements, purchase orders, dispatch notes. Every value keeps the page it
 * came from. It reports what the page SAYS (a test result "as written", a permit status as printed); it never judges
 * a result, a code or a warranty. Anything it cannot read confidently is simply left out, so a messy page degrades to
 * fewer fields, never to an invented one; a page that is not one of these documents (a letter that merely mentions a
 * test, an HVAC sheet, a blank cover) returns null.
 *
 * Only used for companies whose industry pack is plumbing; the HVAC and electrical paths never call it.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** Printed date -> YYYY-MM-DD, or null. US month/day order for numeric dates (a day > 12 in the first slot flips it). */
export function parseDate(raw) {
  let s = String(raw ?? '').trim().replace(/[.,]+$/, '').replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
  let m;
  const yy = (v) => (v.length === 2 ? (2000 + +v > 2040 ? 1900 + +v : 2000 + +v) : +v);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})\.?[- ,]+(\d{4}|\d{2})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? validYmd(yy(m[3]), mo, +m[1]) : null; }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+['\u2019](\d{2})$/))) { const mo = MONTHS[m[1].toLowerCase()]; return mo ? validYmd(yy(m[3]), mo, +m[2]) : null; }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/))) {
    const a = +m[1]; const b = +m[3]; m = [m[0], m[1], m[3], m[4], m[2]];
    // a dotted date (05.10.2026) is day-first in much of the world and month-first elsewhere: only read it when one reading is impossible
    if (m[4] === '.' && a <= 12 && b <= 12) return null;
    const y = m[3].length === 2 ? (2000 + +m[3] > 2040 ? 1900 + +m[3] : 2000 + +m[3]) : +m[3];
    return a > 12 && b <= 12 ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) { const mo = MONTHS[m[1].toLowerCase()]; return mo ? validYmd(+m[3], mo, +m[2]) : null; }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? validYmd(+m[3], mo, +m[1]) : null; }
  return null;
}
const DATE_RE = '(\\d{8}(?!\\d)|\\d{1,2}-[A-Za-z]{3,9}\\.?-\\d{2,4}(?!\\d)|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+[\'\u2019]\\d{2}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2}(?!\\d)|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4})';

/* ------------------------------------------------------------------ document type (from the title lines) */
const OTHER_DOC_WORDS = /\b(?:invoice|quote|quotation|proposal|estimate|agreement|contract|purchase order|work order|service ticket|permit)\b/i;
const DEVICE_WORDS = '(?:backflow|cross[- ]?connection|back[- ]?flow|bfp|rpz|dcva|pvb|svb|rp|dc|assembly|device)';
const TITLES = [
  ['backflow-test-certificate', new RegExp(`\\b${DEVICE_WORDS}\\b[^:]{0,60}\\btests?\\b[^:]{0,40}\\b(?:report|certificate|certification|record|form|results?|sheet|slip)\\b|\\b(?:report|certificate|certification|record|form)\\b[^:]{0,24}\\b(?:backflow|back[- ]?flow|cross[- ]?connection)\\b|\\b(?:backflow|back[- ]?flow)\\b[^:]{0,40}\\b(?:certificate|certification)\\b|^\\W*(?:annual |initial )?(?:backflow|rpz|dcva|pvb)(?: prevention)?(?: assembly| device| preventer)?(?: annual)? tests?\\W*$`, 'i')],
  ['sewer-camera-report', /\b(?:sewer|drain|line|pipe|lateral|main)\b[^:]{0,25}\b(?:camera|video|cctv|scope)\b|\b(?:camera|video|cctv)\b[^:]{0,25}\b(?:inspection|report|survey|line)\b|\bcctv\b|\bsewer scope\b/i],
  ['startup-sheet', /\b(?:water heater|tankless|wh|boiler|heater)\b[^:]{0,30}\b(?:start[- ]?up|installation|install|commissioning)\b[^:]{0,20}\b(?:sheet|record|checklist|report|form|log)\b|\b(?:start[- ]?up|commissioning)\s+(?:sheet|checklist|report|record|form)\b/i],
  ['warranty-registration', /\bwarranty\s+registration\b|\bregistration\s+card\b|\bproduct\s+registration\b/i],
  ['maintenance-agreement', /\b(?:maintenance|service|annual|preventive|preventative|plumbing)\s+(?:agreement|contract|plan)\b|\bservice agreement\b/i],
  ['inspection-report', /\binspection\s+(?:report|result|results|notice|card|record|ticket|approval|summary)\b|\b(?:rough[- ]?in|final|underground|pressure test|gas test|top[- ]?out|under[- ]?slab)\s+(?:plumbing\s+)?inspection\b|\binspection\s+result\s+notice\b/i],
  ['permit', /\b(?:permit(?:\s+(?:card|application|receipt|copy))?)\b/i],
  ['service-ticket', /\bservice\s+(?:call\s+)?(?:ticket|report|slip|record)\b|\bservice call\b|\b(?:field|job|repair|trouble)\s+ticket\b|\bticket\b/i],
  ['purchase-order', /\bpurchase\s+order\b/i],
  ['dispatch-note', /\bdispatch\b/i],
  ['invoice', /\binvoice\b/i],
  ['work-order', /\bwork\s*order\b|\bjob order\b/i],
  ['proposal-quote', /\b(?:proposal|quotation|quote|estimate|bid)\b/i],
];
const LETTERHEAD = /\d{3}[-.)\s]+\d{3,4}[-.\s]\d{4}|@|www\.|\.com\b|\b(?:llc|inc|corp|co\.)\b|[|•]/i;

function classify(lines) {
  const first = lines.find((l) => true)?.page;
  const head = lines.filter((l) => l.page === first).slice(0, 8);
  for (let i = 0; i < head.length; i++) {
    const t = head[i].t;
    if (t.length < 4 || t.length > 90 || /[:=]/.test(t) || LETTERHEAD.test(t) || /^page \d+ of \d+/i.test(t)) continue;
    for (const [type, re] of TITLES) {
      if (!re.test(t)) continue;
      if (type === 'backflow-test-certificate' && OTHER_DOC_WORDS.test(t)) continue;
      if (type === 'invoice' && /\bwork\s*order\b/i.test(t)) return { type: 'invoice', confidence: i < 3 ? 0.95 : 0.9 };
      return { type, confidence: i < 3 ? 0.95 : 0.9 };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ labels */
const BF = 'backflow-test-certificate'; const WH = 'startup-sheet'; const WR = 'warranty-registration'; const PM = 'permit'; const IN = 'inspection-report';
const CM = 'sewer-camera-report'; const TK = 'service-ticket'; const WO = 'work-order'; const IV = 'invoice'; const PQ = 'proposal-quote';
const AG = 'maintenance-agreement'; const PO = 'purchase-order'; const DN = 'dispatch-note';
const NUM = '(?: ?(?:no|number|num|nbr|id))?';

/**
 * [key, label regex source (matched against the WHOLE normalised label), value kind, document types it applies to (null = all), rank (lower wins), list?]
 * Labels are normalised first: lower case, "#" -> " no", OCR digit slips (1 for l, 0 for o) undone inside words, punctuation dropped.
 */
const LABELS = [
  ['service_address', `(?:service|site|job|project|property|premises|work|installation|install|jobsite|jobsite) (?:address|location|site)|address of work|job ?site|service location`, 'address', null, 0],
  ['service_address', `site|property|premises|address`, 'address', null, 1],
  ['customer_name', `(?:customer|owner|property owner|homeowner|home owner|client|account|bill to|billed to|sold to|insured)(?: name)?|name of (?:customer|owner|client)|owner/customer|customer/owner|business name|company name`, 'name', null, 0],
  ['serial_number', `(?:assembly |device |unit |tank |heater )?(?:serial${NUM}|s/n|sn|ser(?: ?no| ?num| ?nbr)?)`, 'id', [BF, WH, WR], 0],
  ['model', `(?:model${NUM}|mdl${NUM}|model name)`, 'model', [BF, WH, WR], 0],
  ['manufacturer', `manufacturer(?: name)?|make|mfr|mfg|brand|make/manufacturer`, 'text', [BF, WH, WR], 0],
  ['equipment_type', `device type|assembly type|type of (?:assembly|device)|type|assembly|backflow type|device|assembly device type|backflow device type`, 'bftype', [BF], 0],
  ['equipment_type', `type|heater type|style|water heater type|unit type|equipment type|tank type|appliance|water heater|heater`, 'whtype', [WH, WR], 0],
  ['device_size', `size|device size|assy size|assembly size|line size|pipe size|size in|diameter|assy|assembly size in`, 'size', [BF], 0],
  ['device_location', `device location|location|installed at|assembly location|location of (?:device|assembly|backflow|backflow device)|install location|installation location|device installed at|where installed|installed location|backflow location`, 'text', [BF], 0],
  ['water_utility', `water utility|filed with|utility|water purveyor|purveyor|water provider|water supplier|submitted to|reported to|report to|water company|water authority|water district|utility company|water system|report filed with`, 'text', [BF], 0],
  ['technician', `testers? name|tested by|tester|certified tester|tester(?: s)? name|performed by|technician|tester/technician|backflow tester|test performed by|tested by technician|certified backflow tester|tech`, 'person', [BF], 0],
  ['technician', `technician|installed by|tech|installer|plumber|installing technician|performed by|installed by technician`, 'person', [WH, WR], 0],
  ['technician', `technician|tech|serviced by|performed by|plumber|completed by|service tech|serviced by technician|service technician`, 'person', [TK, IV], 0],
  ['technician', `assigned to|technician|tech|plumber|assigned technician|assigned plumber|crew|dispatched to|scheduled technician`, 'person', [WO, DN], 0],
  ['technician', `technician|operator|inspected by|tech|camera operator|performed by|inspection technician`, 'person', [CM], 0],
  ['tester_cert_number', `tester cert(?:ification)?${NUM}|cert(?:ification)?${NUM}|az cert${NUM}|tester ?(?:license|licence|lic)${NUM}|certificate${NUM}|certified tester${NUM}|certification id|tester id|bf cert${NUM}|backflow cert\\w*${NUM}|cert id|tester(?: s)? cert\\w*${NUM}|tester certificate${NUM}`, 'id', [BF], 0],
  ['backflow_test_result', `final test result|final result|retest result|after repair result|as left|as left result|final test`, 'text', [BF], -1],
  ['backflow_test_result', `result|pass/fail|test result|overall result|assembly status|passed/failed|pass fail|test status|results|outcome|assembly result|device status|final test status|test outcome|backflow test result|pass or fail`, 'text', [BF], 0],
  ['backflow_test_result', `status`, 'text', [BF], 2],
  ['backflow_test_result', `pass|passed`, 'check', [BF], 1],
  ['backflow_test_result', `fail|failed`, 'check', [BF], 1],
  ['next_test_due', `next test due|annual test due|retest due|next test date|next due|next annual test|test due|next test|due date|next test due date|due|date of next test|next test date due|next required test|next testing due|re ?test due|recertification due|next inspection due|retest by|retest due by|next annual test due|next test required|annual retest due|next certification due|certification due`, 'date', [BF], 0],
  ['fuel_type', `fuel|fuel type|energy source|fuel source|gas type|power source|energy type|gas or electric|gas/electric|heater fuel|fuel used`, 'fuel', [WH, WR], 0],
  ['installation_date', `installation date|date installed|install date|installed on|date of installation|installed|in service date|install dt|date in service|date of install|install|date installed on|installed date`, 'date', null, 0],
  ['gallons', `tank size|capacity|gallons|tank capacity|gal|gallon capacity|storage capacity|capacity gal|tank gallons|volume|size|size gallons|gal capacity|capacity gallons`, 'gallons', [WH, WR], 0],
  ['warranty_term', `warranty term|coverage|term of warranty|warranty|warranty period|coverage term|term|warranty length|warranty years|tank warranty|limited warranty|heat exchanger warranty|warranty duration`, 'term', [WR], 0],
  // a startup sheet that prints its own warranty: only the labels that name the warranty (never a bare "term" / "expires" / "coverage")
  ['warranty_term', `warranty term|warranty|warranty period|warranty length|warranty years|tank warranty|limited warranty|warranty duration`, 'term', [WH], 0],
  ['warranty_expires', `warranty expires|warranty end date|warranty expiration|warranty expiry|warranty ends|warranty end|warranty valid until|warranty through|end of warranty|warranty expiration date|warranty expires on`, 'date', [WH], 0],
  ['warranty_registered_date', `date registered|registered on|registration date|date of registration|registered|date warranty registered|reg date|registration`, 'date', [WR], 0],
  ['warranty_expires', `warranty expires|coverage ends|expiration date|warranty end date|expires|expiry|expires on|warranty expiration|warranty expiry|warranty ends|coverage end date|coverage expires|end of warranty|warranty end|valid through|expiration|coverage through|warranty through|warranty valid until|good through|warranty expires on`, 'date', [WR], 0],
  ['agreement_term', `agreement term|term|length of agreement|term of agreement|contract term|contract length|duration|agreement length|term length|plan term|agreement period|contract period|period`, 'term', [AG], 0],
  ['permit_number', `(?:plumbing |gas |building )?permit${NUM}|permit control${NUM}|permit ref(?:erence)?${NUM}|permit permit${NUM}`, 'id', null, 0],
  ['jurisdiction', `jurisdiction|issued by|agency|issuing agency|issuing authority|issuing office|issuing jurisdiction|authority having jurisdiction|ahj|building department|issuing dept|department|issuer|permit office|permitting authority|issuing entity|municipality|agency name|issued by agency`, 'agency', null, 0],
  ['permit_type', `permit type|type of work|work type|type of permit|permit class|work class|kind of work|permit category|type`, 'text', [PM], 0],
  ['permit_issued_date', `date issued|issued|issue date|issued on|date of issue|issuance date|permit issued|issued date|permit issue date|date permit issued`, 'date', [PM], 0],
  ['permit_expires', `permit expires|expiration|expires on|expires|expiration date|expiry|valid through|void after|permit expiration|expiry date|permit expiry|permit valid through|permit valid until|valid until|expires by|permit void after|inactive after|permit expires on|good through|permit expiration date`, 'date', [PM], 0],
  ['permit_status', `status|permit status|current status|permit state|status of permit|permit condition`, 'text', [PM], 0],
  ['inspection_type', `inspection type|type of inspection|inspection|insp type|insp|inspection kind|inspection stage|stage|type|inspection requested|inspection performed|inspection description`, 'stage', [IN], 0],
  ['inspection_result', `result|inspection result|outcome|disposition|inspection outcome|inspection status|results|result of inspection|final result|decision|inspection decision`, 'text', [IN], 0],
  ['inspection_result', `status`, 'text', [IN], 2],
  ['line_location', `line inspected|location|area inspected|section inspected|run inspected|inspection location|line location|location inspected|pipe location|section|segment|run|line section|inspected section|portion inspected|sewer line location|line|area`, 'text', [CM], 0],
  ['line_length', `length inspected|footage|run length|total length|length|footage inspected|total footage|distance inspected|length of run|line length|total footage inspected|length surveyed|footage surveyed|distance|length of line inspected|length scoped`, 'length', [CM], 0],
  ['footage_ref', `video file|footage ref|recording|video|video link|file name|media|footage file|video ref|footage|video reference|video recording|recording file|media file|clip|video id|dvr file|footage link|video url|footage reference|file`, 'file', [CM], 0],
  ['line_findings', `findings|observations|defects found|defects|observed defects|conditions observed|findings/observations|inspection findings|condition|conditions found|defects observed|findings noted|issues found|observations/findings|camera findings|problems found|summary of findings|defects noted`, 'list', [CM], 0, true],
  ['recommendation', `recommendation|recommend|recommended action|tech recommendation|recommendations|recommended repair|recommended repairs|suggested action|action recommended|recommended work|technician recommendation|repair recommendation|recommended actions|technician recommendations|tech recommendations|recommended solution`, 'text', null, 0],
  ['pipe_material', `pipe material|material|line material|pipe type|pipe|pipe material inspected`, 'material', [CM], 0],
  ['service_type', `service type|call type|type of service|type|service call type|job type|type of call|visit type|service category|category|type of visit`, 'text', [TK], 0],
  ['work_performed', `work performed|work done|description of work|description|work|services|services rendered|scope of work|work to be done|work order items|scope|proposed work|services included|covered services|work description|work completed|description of services|tasks|job description|work requested|work scheduled|service performed|services performed|corrective action|repairs performed|work details|summary of work|what was done|work summary|scope of services|included services|work items|work order scope|scope of proposed work|proposal scope`, 'list', [TK, WO, IV, PQ, AG], 0, true],
  ['part_number', `part${NUM}|parts?(?: used)?|part #s|parts numbers|part numbers|sku|item${NUM}|material list`, 'text', null, 1, true],
  ['part_number', `item|description|ordered item|items ordered|product|item description|material|materials|items|order items|ordered|equipment ordered`, 'list', [PO], 0, true],
  ['invoice_number', `(?:invoice|inv|ticket|work order|wo|quote|proposal|estimate|po|purchase order|order|bid|service ticket|quotation)${NUM}`, 'docid', [IV, PQ, PO, TK, WO], 0],
  ['notes', `notes?|call notes|comments?|remarks|additional notes|tech notes|technician notes|special instructions|instructions|dispatch notes?|problem|reason for call|issue|customer complaint|complaint|description of problem|call description`, 'text', null, 0],
  ['labor_hours', `labor hours|hours|labor|time on site|hours worked|total hours|labour hours|labor time`, 'hours', [TK, IV, WO], 0],
  ['status', `status|job status|ticket status|work order status`, 'text', [WO, TK], 0],
  ['equipment_id', `equipment id|unit id|tag|asset id|equipment${NUM}|tag${NUM}|asset${NUM}|unit${NUM}`, 'id', [BF, WH, TK], 1],
  ['cost', `grand total|invoice total|total price|quoted total|estimate total|order total|ticket total|proposal total|quote total|total cost|price total`, 'money', [IV, PQ, PO, TK, AG], 0],
  ['cost', `total|total due|total amount|net total|amount total|total charge|total charges`, 'money', [IV, PQ, PO, TK, AG], 1],
  ['cost', `amount due|amount|annual fee|annual price|agreement price|agreement total|fee|charge|cost|total price due`, 'money', [IV, PQ, PO, TK, AG], 2],
  // dates (all land in service_date): the most specific label wins, a bare "Date" is the fallback
  ['service_date', `test date|date tested|tested on|date of test|date of last test|test performed|test performed on|date of backflow test|testing date`, 'date', [BF], 0],
  ['service_date', `date of inspection|inspected on|inspection date|date inspected|inspection performed on|date of site inspection|survey date|date of survey|inspected`, 'date', [IN, CM, BF], 0],
  ['service_date', `service date|date of service|date serviced|date performed|date completed|completed on|visit date|completion date|date of visit|service performed on|serviced on`, 'date', [TK, IV, WH, WO, DN, BF, CM], 0],
  ['service_date', `scheduled date|scheduled for|date scheduled|appointment date|appointment|scheduled|dispatch date|requested date|date dispatched|scheduled service date|work date|scheduled on`, 'date', [WO, DN], 0],
  ['service_date', `invoice date|date billed|billing date|date invoiced|invoiced on|date of invoice`, 'date', [IV], 1],
  ['service_date', `quote date|date prepared|proposal date|estimate date|date quoted|date of quote|date of proposal|prepared on|quotation date`, 'date', [PQ], 1],
  ['service_date', `start date|effective|effective date|begins|commencement date|agreement date|term start|agreement start|start of term|begin date|date signed|signed on|agreement start date`, 'date', [AG], 1],
  ['service_date', `order date|date ordered|ordered on|po date|date of order`, 'date', [PO], 1],
  ['service_date', `date|report date|date of report|dated|current date`, 'date', [BF, IN, CM, TK, IV, PQ, PO, WO, DN, WH, AG], 3],
];

const normLabel = (s) => {
  const low = String(s).toLowerCase().replace(/['’]/g, '').replace(/#/g, ' no ');
  const fixed = low.split(/\s+/).map((w) => (/[a-z]{2}/.test(w) && /[10]/.test(w) ? w.replace(/1/g, 'l').replace(/0/g, 'o') : w)).join(' ');
  return fixed.replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
};
const COMPILED = LABELS.map(([key, src, kind, types, rank = 0, multi = false]) => ({ key, re: new RegExp(`^(?:${src})$`, 'i'), kind, types, rank, multi }));
const AGENCY_WORDS = /\b(?:city|county|town|township|village|department|dept|building|division|office|authority|state|board|district|development|services|planning|safety|public works|utilities|bureau|municipal)\b/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s;,]+$/g, '').trim();
const GENERIC_IDLIKE = /^[A-Za-z]{0,3}[-\s]?\d+$/;
const STREET = /\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop|run|row|path|plaza)\b/i;

/** Split a line into {label, value}: "Label: value", "Label = value", or "Label - value". */
function splitLine(t) {
  let m = t.match(/^([^:=]{2,48}?)\s*[:=]\s*(.*)$/);
  if (m && /[a-z]/i.test(m[1])) return { label: m[1], value: m[2] };
  m = t.match(/^(.{2,40}?)\s+[-–—]\s+(.+)$/);
  if (m && /[a-z]/i.test(m[1])) return { label: m[1], value: m[2] };
  return null;
}
const isKnownLabel = (label) => { const n = normLabel(label); return EXTRA_LABEL.test(n) || COMPILED.some((c) => c.re.test(n)); };

function readValue(kind, raw, ctx) {
  const v = clean(raw);
  if (!v) return null;
  switch (kind) {
    case 'date': { const m = v.replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, '').match(new RegExp('^' + DATE_RE)); return m ? parseDate(m[1]) : null; }
    case 'money': { const m = v.match(/\$?\s*([\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/); return m ? m[1].replace(/,/g, '') : null; }
    case 'hours': { if (/\$|\d,\d{3}|^\d+\.\d{2}$/.test(v)) return null; { const hm = v.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b\s*(?:and\s*)?(\d{1,2})\s*(?:m|min|mins|minutes?)\b/i); if (hm && +hm[2] < 60) return String(Math.round((+hm[1] + +hm[2] / 60) * 100) / 100); const mm = v.match(/^(\d{1,3})\s*(?:m|min|mins|minutes?)\b/i); if (mm) return String(Math.round(+mm[1] / 60 * 100) / 100); if (/^\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?)?\s+\d/i.test(v)) return null; } const m = v.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)?\b/i); return m ? m[1] : null; }
    case 'id': case 'docid': {
      const m = v.match(/^((?:[A-Za-z]{1,2}\s+(?=\d))?[A-Za-z0-9][A-Za-z0-9\-./]{2,}(?:\s+(?=[A-Za-z0-9\-./]*\d)[A-Za-z0-9\-./]+){0,2})/);
      const id = m ? m[1].replace(/[.,;]+$/, '') : null;
      return id && /\d/.test(id) ? id : null;
    }
    case 'model': {
      const m = v.match(/^([A-Za-z0-9][A-Za-z0-9\-./]*(?:\s+[A-Za-z0-9\-./]+){0,2})/);
      const id = m ? m[1].replace(/[.,;]+$/, '') : null;
      if (!id) return null;
      return /\d/.test(id) || (id.length <= 30 && /[A-Za-z]{3}/.test(id)) ? id : null;
    }
    case 'size': { const m = v.match(/^(\d+(?:[- ]\d+\/\d+|\.\d+|\/\d+)?\s*(?:"|''|”|inch(?:es)?\b|in\b|-inch\b)?)/i); return m && /\d/.test(m[1]) && v.length <= 24 ? v.replace(/\s*[.,;]+$/, '') : null; }
    case 'gallons': { if (/\b(?:btu|gpm|psi|kw|kbtu|watts?|volts?|amps?|gph|lph)\b|°/i.test(v) || (!/gal/i.test(v) && !/gal|tank/.test(ctx?.label ?? ''))) return null; const m = v.match(/^(\d{1,3}(?:\.\d)?)\s*(?:gal(?:lons?)?)?\b/i); return m && +m[1] >= 10 && +m[1] <= 500 ? `${m[1]} gallon` : null; }
    case 'length': { const m = v.match(/^(\d[\d,]*(?:\.\d+)?)\s*(ft|feet|foot|'|lf|linear feet|linear ft|m|meters?)(?![A-Za-z])/i); return m ? `${m[1]} ${/^(?:feet|foot|'|linear (?:feet|ft))$/i.test(m[2]) || /^lf$/i.test(m[2]) ? 'ft' : m[2].toLowerCase()}` : null; }
    case 'file': { if (/\.(?:mp4|mov|avi|mkv|wmv|m4v|mpe?g|webm|dvr|zip|jpe?g|png)\b|^https?:\/\//i.test(v)) return v.split(/\s+/)[0].replace(/[.,;]+$/, ''); return /^[A-Za-z0-9][\w\-./]{3,}$/.test(v) && /\d/.test(v) ? v : null; }
    case 'bftype': return /\b(?:rpz|rpda|rp|dcva|dcda|dc|pvb|svb|avb|reduced pressure|double check|pressure vacuum|spill resistant|atmospheric)\b/i.test(v) ? v.slice(0, 80) : null;
    case 'whtype': return /\b(?:tankless|tank|on[- ]demand|storage|heat pump|hybrid|condensing|water heater)\b/i.test(v) ? v.slice(0, 60) : null;
    case 'fuel': return /\b(?:gas|propane|lp|lpg|natural|ng|electric|electricity|solar|oil|heat pump|hybrid)\b/i.test(v) ? v.slice(0, 40) : null;
    case 'stage': return /\b(?:rough|final|pressure|test|underground|top[- ]?out|under[- ]?slab|gas|water service|sewer|cover|meter|drain|waste|vent|preliminary|re-?inspection|backflow|sleeve|set|dwv|temporary|trench|slab)\b/i.test(v) && !/^\d+$/.test(v) ? v.slice(0, 80) : null;
    case 'agency': return v.length > 100 ? v.slice(0, 100) : (/[A-Za-z]{3}/.test(v) ? v : null);
    case 'term': return /\d|year|month|lifetime|life/i.test(v) ? v.slice(0, 80) : null;
    case 'material': return /\b(?:pex|copper|cast iron|pvc|abs|clay|vcp|orangeburg|galvanized|cpvc|hdpe|concrete|ductile|steel|brass|lead)\b/i.test(v) ? v.slice(0, 60) : null;
    case 'person': {
      let p = v.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      p = p.split(/[,;]/)[0].replace(/\s+(?:az\s+)?(?:cert\w*|lic\w*|id)\b.*$/i, '').replace(/\s+(?:az|arizona)\s*$/i, '').replace(/\s+[A-Z]{2,3}-[A-Z]{1,3}-?\d+\s*$/, '').trim();
      return /[A-Za-z]{2}/.test(p) && p.length <= 60 && (p.match(/\d/g) ?? []).length <= 2 && !/^(?:n\/?a|none|unknown|tbd)$/i.test(p) ? p : null;
    }
    case 'name': {
      if (!/[A-Za-z]{2}/.test(v) || v.length > 80 || GENERIC_IDLIKE.test(v)) return null;
      return /^\d+\s+\w+/.test(v) && STREET.test(v) ? null : v;
    }
    case 'address': return (/\d/.test(v) || STREET.test(v)) && v.length <= 140 && /[A-Za-z]{2}/.test(v) && !/^\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}$/.test(v) ? v : null;
    case 'check': return /^(?:\[?\s*x\s*\]?|yes|y|✓|✔|☑|checked|true|x)$/i.test(v) ? 'yes' : null;
    case 'text': default: return v.length > 160 ? v.slice(0, 160) : v;
  }
}

const NOISE = /^(?:scanned|fax received|pg\s*\d|page \d|page scanned|doc id|printed|received|~+|\d+\s*\/\s*\d+$|confidential|continued|©|copyright)/i;
const BULLET = /^(?:\d{1,2}[.)]|[a-z][.)]|[-•*–·])\s+(.{2,})$/;

/** Single words that start a new printed field even with no colon ("... Smith, Joe Phone 480-555-0100 Email x@y.com"). */
const STRONG = new Set(['phone', 'tel', 'telephone', 'fax', 'mobile', 'cell', 'email', 'e-mail', 'contact', 'contractor', 'zip']);
const EXTRA_LABEL = /^(?:(?:customer|owner|client|contact|site|billing|work|office|home|business)? ?(?:phone|tel|telephone|fax|email|e-?mail|mobile|cell)(?: ?(?:no|number|num))?|phone|tel|telephone|fax|mobile|cell|email|e-?mail|contact|contact name|contact phone|city|state|zip|zip code|contractor|licensed contractor|contractor name|phone no|phone number)$/;
/** "Result: Passed  Next Test Due: 3/4/27" -> two lines. A value is cut where the next known printed label starts (with or without a colon), and the second part is rewritten as "label: value". */
function splitColumns(t) {
  if (!/[:#]/.test(t)) return [t];
  const words = t.split(' '); const parts = []; let from = 0; let w = 1;
  while (w < words.length) {
    if (!words.slice(from, w).some((x) => /[:#]/.test(x) || x === '=')) { w++; continue; }
    let hit = null;
    // a free-text value (findings, notes, work...) keeps its own sentences whole: a label-like phrase inside it ("no defects observed") is words of the value, not a new field
    const curLabel = words.slice(from, w).join(' ').match(/^([A-Za-z][A-Za-z0-9/ .'\-]{0,40}?)\s*[:#]/)?.[1]?.trim() ?? '';
    const freeText = /^(?:line )?(?:findings?|observations?|defects?(?: (?:observed|found|noted))?|notes?|comments?|remarks|work performed|work description|description|summary|recommendations?|scope(?: of work)?|condition)$/i.test(curLabel);
    for (let e = w; e < Math.min(w + 4, words.length) && !hit; e++) {
      const raw = words.slice(w, e + 1).join(' ');
      const colon = /:$/.test(words[e]); const hash = /^#$|#$/.test(words[e]);
      const cand = raw.replace(/[:#]+$/, '').trim();
      if (!/^[A-Za-z][A-Za-z0-9/#.'\- ]*$/.test(cand) || (e > w && /:$/.test(words[e - 1]))) continue;
      const known = isKnownLabel(cand) && !(freeText && /^(?:defects?(?: (?:observed|found|noted))?|findings?|observations?)$/i.test(cand));
      if (freeText && !colon && !hash) continue;
      const more = hash && words[e + 1] != null ? true : true;
      if (known && (colon || hash)) hit = { e, label: cand };
      else if (known && !colon && !hash && e > w && e + 1 < words.length && cand.split(' ').length >= 2 && !/^(?:date|type|test date)$/i.test(cand)) hit = { e, label: cand };
      else if (e === w && !colon && STRONG.has(cand.toLowerCase()) && e + 1 < words.length && w > from + 1 && more) hit = { e, label: cand };
    }
    if (hit) { parts.push(words.slice(from, w).join(' ')); parts.push(null); from = w; words.splice(w, hit.e - w + 1, `${hit.label}:`); w = w + 1; }
    else w++;
  }
  parts.push(words.slice(from).join(' '));
  return parts.filter((x) => x).map((x) => x.trim()).filter(Boolean);
}

/** Split page text into trimmed non-empty lines tagged with their page (blank lines remembered). */
function toLines(pages) {
  const out = [];
  for (const p of pages ?? []) {
    let blank = false;
    for (const raw of String(p.text ?? '').split(/\r?\n/)) {
      const t = raw.replace(/\s+/g, ' ').trim();
      if (!t) { blank = true; continue; }
      for (const [k, seg] of splitColumns(t).entries()) out.push({ t: seg, page: Number(p.page_no) || 1, blank: k === 0 ? blank : false });
      blank = false;
    }
  }
  return out;
}

/**
 * How a printed test / inspection result reads: 'passed', 'failed', or 'other' (unrecognised, mixed such as "Failed then
 * passed", or conditional). Negations are failures ("No Pass", "Didn't pass", "Unable to pass", "Did not hold"); "P" / "F" are
 * the single letters; "no leaks" passes, "leaks" fails. Anything unclear is 'other' so the caller never guesses.
 */
export function resultClass(r) {
  const s = String(r ?? '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return 'other';
  const t0 = s.replace(/ (?:no|zero) (?:corrections?|re ?inspection|retest|repairs?|further action)(?: (?:required|needed|necessary))?$/, '').replace(/ (?:and )?(?:no|zero) (?:corrections?|re ?inspection|retest)(?: (?:required|needed|necessary))?/g, '').trim();
  const PASS_OK = /^(?:p|pass|passed|passes|passing|ok|okay|satisfactory|approved|accepted|compliant|complies|complied|held|holds|holds pressure|good|test passed|passed test|passed inspection|inspection passed|leak free|no leaks?|no leaks? (?:detected|found|observed|noted)|no signs? of leaks?|free of leaks?|zero leaks?|without leaks?|no failures?|did not fail|never failed|no visible leaks?|pass no corrections?)$/;
  const FAIL_OK = /^(?:f|fail|failed|fails|failure|no pass|not pass|not passed|did not pass|didnt pass|unable to pass|did not hold|didnt hold|not holding|leaks|leaked|leaking|leak|rejected|unsatisfactory|not approved|disapproved|denied|non compliant|noncompliant|test failed|failed test|failed inspection|inspection failed)$/;
  if (PASS_OK.test(t0)) return 'passed';
  if (FAIL_OK.test(t0)) return 'failed';
  // anything with negation / uncertainty / a partial outcome that is not a known phrase is unclear: the caller never guesses
  if (/\b(?:hasnt|havent|couldnt|shouldnt|wouldnt|cannot|cant|wont|not yet|yet to|non|un\w+|not$|partial\w*|not good|no good|not cleared|conditional\w*|pending|unknown|tbd|incomplete|corrections?|re ?inspect\w*|re ?test\w*|then|but|with|if|after|before|awaiting|waiting|hold for|review)\b/.test(t0)) return 'other';
  const neg = /\b(?:did not|didnt|does not|doesnt|do not|dont|not|never|no|failed to|fail to|isnt|wasnt)\s+\w+/;
  if (neg.test(t0)) return 'other';
  const fail = /\b(?:fail\w*|reject\w*|disapproved|denied|leak\w*|defective)\b/.test(t0);
  const pass = /\b(?:pass\w*|ok|okay|satisfactory|approved|compliant|accepted|cleared|good)\b/.test(t0);
  return fail && pass ? 'other' : fail ? 'failed' : pass ? 'passed' : 'other';
}
const resultKind = (v) => { const c = resultClass(v); return c === 'other' ? 'other' : c; };

/** Keys that identify one physical unit (a certificate or sheet that names several is left to the model path). */
const UNIT_TYPES = new Set([BF, WH, WR]);
const MONEY_TYPES = new Set([IV, PQ, PO, TK, AG]);

export function extractPlumbing(pages, { today } = {}) {
  // `today` (YYYY-MM-DD) is supplied by the caller; the extractor never reads the clock. With no today the future-date plausibility drop is skipped (the storage step's own date check still flags far-future dates).
  const latest = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? '')) ? new Date(Date.parse(`${today}T00:00:00Z`) + 31 * 86400000).toISOString().slice(0, 10) : null;
  const lines = toLines(pages);
  if (!lines.length) return null;
  const cls = classify(lines);
  if (!cls) return null;
  const type = cls.type;
  const best = new Map(); // key -> {rank, value, line, order}
  const multi = []; // {key,value,line}
  let order = 0;
  const offer = (key, rank, value, line, multiple) => {
    if (value == null || value === '') return;
    if (multiple) { if (!multi.some((m) => m.key === key && m.value === value)) multi.push({ key, value, line, order: order++ }); return; }
    const cur = best.get(key);
    if (!cur || rank < cur.rank) best.set(key, { rank, value, line, order: cur?.order ?? order++, ties: 0 });
    else if (rank === cur.rank && cur.value !== value) cur.ties += 1;
    else if (rank === cur.rank) cur.dupes = (cur.dupes ?? 0) + 1;
  };
  const allVals = new Map(); // key -> Set of distinct values (any rank) for conflict checks
  const seeVal = (key, v) => { if (!allVals.has(key)) allVals.set(key, new Set()); allVals.get(key).add(String(v).toLowerCase()); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sp = splitLine(line.t);
    if (!sp) continue;
    const n = normLabel(sp.label);
    if (!n) continue;
    // initial / as-found test lines are never the result of record
    if (type === BF && /^(?:initial|as found|first)\b/.test(n) && /result|test|status/.test(n)) continue;
    const cands = COMPILED.filter((c) => (!c.types || c.types.includes(type)) && c.re.test(n));
    if (!cands.length) continue;
    let used = false;
    for (const c of cands) {
      if (used) break;
      // guards that need the printed label
      if (c.key === 'jurisdiction' && /^issued by$/.test(n) && !AGENCY_WORDS.test(sp.value)) continue;
      if (c.key === 'customer_name' && /^account$/.test(n) && !/[A-Za-z]{3}/.test(sp.value)) continue;
      if (c.key === 'part_number' && c.rank === 1 && type === PO) continue;
      let raw = sp.value;
      let srcLine = line;
      let consumed = 0;
      if (!clean(raw)) {
        if (c.multi) {
          // a list under the label: bulleted/numbered items; plain lines only up to the next blank line / label
          const items = []; let j = i + 1; let bulleted = false;
          while (j < lines.length && lines[j].page === line.page && items.length < 14) {
            const b = lines[j].t.match(BULLET);
            if (b) { bulleted = true; items.push({ text: clean(b[1]), line: lines[j] }); j++; continue; }
            if (bulleted) break;
            if (lines[j].blank && items.length) break;
            const sp2 = splitLine(lines[j].t);
            if ((sp2 && isKnownLabel(sp2.label)) || NOISE.test(lines[j].t) || lines[j].t.length > 140) break;
            items.push({ text: clean(lines[j].t), line: lines[j] }); j++;
          }
          if (items.length) { for (const it of items) for (const part of it.text.split(/\s*;\s*/)) if (clean(part).length >= 2) { seeVal(c.key, part); offer(c.key, c.rank, clean(part), it.line, true); } used = true; consumed = items.length; i += consumed; }
          break;
        }
        // value on the next line
        const nx = lines[i + 1];
        if (!nx || nx.page !== line.page) continue;
        const sp2 = splitLine(nx.t);
        if ((sp2 && isKnownLabel(sp2.label)) || NOISE.test(nx.t) || BULLET.test(nx.t)) continue;
        raw = nx.t; srcLine = nx;
      }
      if (c.multi) {
        for (const part of clean(raw).split(/\s*;\s*/)) if (clean(part).length >= 2) { seeVal(c.key, part); offer(c.key, c.rank, c.kind === 'list' ? clean(part) : readValue(c.kind, part), srcLine, true); }
        used = true; break;
      }
      let v = readValue(c.kind, raw, { type, label: n });
      if (v == null) continue;
      if (c.kind === 'check') v = /^fail/.test(n) ? 'Failed' : 'Passed';
      if (c.key === 'inspection_type' && /^(?:inspection|insp|type)$/.test(n) && !/[A-Za-z]/.test(v)) continue;
      if (c.key === 'recommendation' && v.length < 3) continue;
      if (c.key === 'cost' && !/\d/.test(v)) continue;
      // a tester's certification printed inside the tester line
      if (c.key === 'technician' && type === BF) { const cm = clean(raw).match(/\bcert\w*\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i); if (cm) offer('tester_cert_number', 1, cm[1], srcLine); }
      seeVal(c.key, v);
      offer(c.key, c.rank, v, srcLine);
      used = true;
    }
  }

  // ---- conflicts that make a single reading unsafe -> the model path reads it
  if (type === BF) {
    // "Retest: Passed 2/10/26" under a failed result is two tests on one page: never stored as one
    for (const l of lines) { const sp = splitLine(l.t); if (sp && /^re ?-?test(?:ed)?(?: (?:result|status|outcome|passed|failed))?$/.test(normLabel(sp.label)) && resultClass(sp.value) !== 'other') return null; }
    const res = best.get('backflow_test_result');
    if (res && resultClass(res.value) === 'other') return null; // an unrecognised or mixed result is read by the model, never guessed
  }
  if (UNIT_TYPES.has(type) && (allVals.get('serial_number')?.size ?? 0) > 1) return null; // several devices/units on one document
  if (type === IN || type === PM) {
    if ((allVals.get('inspection_type')?.size ?? 0) > 1 || (allVals.get('inspection_result')?.size ?? 0) > 1) return null; // a card listing several inspections
  }
  const fieldsOut = [];
  const push = (key, e, conf) => fieldsOut.push({ key, value: e.value, page_no: e.line.page, verbatim: e.line.t.slice(0, 200), confidence: conf ?? (e.rank >= 2 ? 0.85 : 0.95), _o: e.order });
  // safety net: a stored value that still contains another printed label means the line was not cut cleanly -> drop it (a required field dropped means the model reads the page)
  const LABEL_IN_VALUE = /\b(?:phone|tel|fax|e-?mail|contact|city|contractor|model|serial|ser\.? ?no|make|mfr|brand|size|fuel|address|date of next test|next test due|test date|tester|technician|cert(?:ification)?|permit|invoice)\s*(?:[:#=]|no\b\.?|num\b)/i;
  for (const [key, e] of [...best]) if (key !== 'notes' && key !== 'work_performed' && LABEL_IN_VALUE.test(String(e.value))) best.delete(key);
  for (const [key, e] of best) {
    if (e.ties > 0) { if (['backflow_test_result', 'inspection_result', 'service_date', 'next_test_due', 'service_address', 'cost'].includes(key)) continue; }
    if (key === 'next_test_due' && best.get('service_date') && e.value < best.get('service_date').value) continue; // a next test before the test itself is a misread
    if (key === 'cost' && !MONEY_TYPES.has(type)) continue;
    if (key === 'cost' && e.rank >= 2 && lines.some((l) => /^(?:sub ?total|tax|sales tax)\b/i.test(l.t))) continue; // a subtotal / tax with no total is not a cost
    if (key === 'service_date' && (type === PM || type === WR)) continue;
    if (((key === 'service_date' && (type === BF || type === IN || type === CM)) || (key === 'installation_date' && type === WH) || (key === 'warranty_registered_date')) && latest && e.value > latest) continue; // a test / install date in the future is a misread
    push(key, e);
  }
  for (const m of multi) { if (m.key === 'line_findings' && type !== CM) continue; if ((m.key === 'part_number') && type === PM) continue; fieldsOut.push({ key: m.key, value: m.value, page_no: m.line.page, verbatim: m.line.t.slice(0, 200), confidence: 0.9, _o: m.order }); }

  const has = (k) => fieldsOut.some((f) => f.key === k);

  // backflow: device kind from the text when no "Type" label gave it
  if (type === BF && !has('equipment_type')) {
    const t = lines.slice(0, 8).find((l) => /\b(?:rpz|rpda|dcva|dcda|pvb|svb)\b|reduced pressure|double check|pressure vacuum/i.test(l.t));
    const m = t?.t.match(/\b(rpz|rpda|dcva|dcda|pvb|svb)\b/i);
    if (m) fieldsOut.push({ key: 'equipment_type', value: m[1].toUpperCase(), page_no: t.page, verbatim: t.t.slice(0, 200), confidence: 0.8, _o: 99 });
  }
  // inspection type from the title when no label gave it ("ROUGH-IN INSPECTION")
  if ((type === IN) && !has('inspection_type')) {
    const t = lines.slice(0, 4).find((l) => /\b(rough[- ]?in|final|underground|pressure test|gas test|top[- ]?out|under[- ]?slab)\b/i.test(l.t) && /\binspection\b/i.test(l.t));
    const m = t?.t.match(/\b(rough[- ]?in|final|underground|pressure test|gas test|top[- ]?out|under[- ]?slab)\b/i);
    if (m) fieldsOut.push({ key: 'inspection_type', value: m[1].replace(/^rough in$/i, 'Rough-in').replace(/^./, (c) => c.toUpperCase()), page_no: t.page, verbatim: t.t.slice(0, 200), confidence: 0.85, _o: 98 });
  }
  // the status line decides the inspection result only when nothing else did (handled by rank); a failed backflow with no due date keeps no due date

  // ---- evidence: a page whose title says X but that carries none of X's data is not X (letters, covers)
  const cnt = (...ks) => ks.filter(has).length;
  const ok = {
    [BF]: () => has('backflow_test_result') || has('next_test_due') || (has('serial_number') && has('service_date')),
    [WH]: () => cnt('serial_number', 'model', 'manufacturer', 'installation_date', 'gallons', 'fuel_type') >= 2,
    [WR]: () => (has('serial_number') || (has('model') && has('manufacturer'))) && cnt('warranty_expires', 'warranty_term', 'warranty_registered_date') >= 1,
    [PM]: () => has('permit_number'),
    [IN]: () => (has('permit_number') || has('service_address')) && cnt('inspection_result', 'inspection_type') >= 1,
    [CM]: () => cnt('line_findings', 'recommendation', 'footage_ref', 'line_location', 'service_date') >= 2 || fieldsOut.some((f) => f.key === 'line_findings'),
    [TK]: () => cnt('work_performed', 'service_date', 'cost', 'technician') >= 2,
    [WO]: () => cnt('work_performed', 'service_date', 'technician') >= 2,
    [IV]: () => has('cost') || has('invoice_number'),
    [PQ]: () => has('cost') || has('work_performed'),
    [AG]: () => cnt('agreement_term', 'work_performed', 'service_date') >= 1 && has('service_address') || has('agreement_term'),
    [PO]: () => has('cost') || has('part_number'),
    [DN]: () => cnt('service_date', 'technician', 'notes') >= 2,
  }[type];
  if (ok && !ok()) return null;

  fieldsOut.sort((a, b) => a._o - b._o);
  return { type, confidence: cls.confidence, fields: fieldsOut.map(({ _o, ...f }) => f) };
}

/** Required keys for a type, from the plumbing pack (a|b = either). */
export function missingRequired(type, fields, pack) {
  const req = pack?.documentTypes?.find((t) => t.id === type)?.requires ?? [];
  const have = new Set(fields.map((f) => f.key));
  return req.filter((r) => !r.split('|').some((k) => have.has(k)));
}
