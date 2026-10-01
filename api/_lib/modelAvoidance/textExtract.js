/**
 * R32 (Team M, model avoidance): deterministic document classification + field extraction from PAGE TEXT.
 *
 * WHY: extractDocument.js sends every document's page text to a model (~$0.004/doc) to turn "Serial: F100002"
 * into {field_key: serial_number, value: F100002}. When a document is a plain labelled form (an invoice, a
 * service ticket, a warranty registration, ... exported from the shop's own software) that is a lookup, not
 * reasoning. This module does the lookup — and REFUSES (returns null) the moment the document stops being one.
 *
 * THE CONTRACT — precision over recall, always. The output is the exact shape the model's `extract_fields` tool
 * returns ({document_type, document_type_confidence, fields:[{key,value,page_no,verbatim,confidence,unit_index?}]})
 * so everything downstream (normalizeFields, resolveDocumentType, linking, warranty derivation) is unchanged. A
 * document is accepted ONLY when ALL of these hold; any single failure returns `{accepted:false, reason}` and the
 * caller runs the model exactly as before:
 *   1. its type is decided by a TITLE line ("INVOICE", "SERVICE TICKET", ...) — never by guessing from content —
 *      and is one of the template-shaped types below (never correspondence / dispatch notes / memos / "other");
 *   2. every non-empty line is EXPLAINED: a title, a letterhead line, a "Label: value" line whose label is in the
 *      dictionary and whose value validates (a date parses, a phone is a phone, a serial looks like a serial), a
 *      list item under a known block label, or a known boilerplate line. A line the extractor does not understand
 *      (free prose, a line-item table, a second column, a label it has never seen) is a rejection, because that
 *      line might carry a fact the model would have extracted — a silently missing fact is a wrong record;
 *   3. every field the type REQUIRES (documentTypes.js REQUIRED_FIELDS) was found;
 *   4. nothing is ambiguous: no field with two different values, a single unit (or a well-formed unit list), one
 *      technician, one total, no reminder/follow-up language (those need judgement);
 *   5. an install invoice ("Install 2 ton ... system") is left to the model: whether its date is an INSTALL date is
 *      an inference the model rules forbid making from a bare invoice date, and deriving it wrongly poisons the
 *      warranty clock.
 *
 * Pure. No I/O, no clock. HVAC pack only (another industry's vocabulary is a different label table).
 */
import { normalizeDate } from "../extractFields.js";
import { BRAND_RULES } from "../warrantyRules.js";
import { REQUIRED_FIELDS, DOCUMENT_TYPE_IDS } from "../documentTypes.js";

export const TEXT_EXTRACTOR_VERSION = 1;

/** Types whose paperwork is a labelled form. Everything else always goes to the model. */
export const TEMPLATE_TYPES = new Set([
  "invoice", "service-ticket", "work-order", "warranty-registration", "startup-sheet",
  "maintenance-agreement", "proposal-quote", "inspection-report", "equipment-record", "permit",
]);

/* --------------------------------------------------------------------- titles / classification */
const TITLES = [
  ["invoice", /^(?:tax\s+|service\s+|customer\s+)?invoice(?:\s*(?:#|no\.?|number)\s*[\w-]+)?$/],
  ["service-ticket", /^(?:hvac\s+)?service\s+(?:ticket|report|call\s+report|record)$/],
  ["work-order", /^(?:service\s+)?work\s+order(?:\s*(?:#|no\.?|number)\s*[\w-]+)?$/],
  ["warranty-registration", /^(?:equipment\s+|product\s+)?warranty\s+registration(?:\s+form)?$/],
  ["startup-sheet", /^(?:start[\s-]?up|startup)(?:\s*\/\s*commissioning|\s+and\s+commissioning)?\s+(?:sheet|report|checklist|record)$|^commissioning\s+(?:sheet|report|checklist)$/],
  ["maintenance-agreement", /^(?:preventive\s+)?(?:maintenance|service)\s+(?:agreement|contract|plan)$/],
  ["proposal-quote", /^(?:proposal|quote|quotation|estimate)(?:\s*(?:\/|and|&)\s*(?:proposal|quote|quotation|estimate))?$/],
  ["inspection-report", /^(?:hvac\s+|system\s+|equipment\s+)?inspection\s+report$/],
  ["equipment-record", /^equipment\s+(?:record|profile|data\s+sheet|information)$/],
  ["permit", /^(?:(?:mechanical|building|hvac|electrical)\s+)?permit(?:\s+(?:application|card))?$/],
  ["purchase-order", /^purchase\s+order(?:\s*(?:#|no\.?|number)\s*[\w-]+)?$/],
  ["dispatch-note", /^dispatch\s+(?:note|slip|ticket)(?:\s*[-:].*)?$/],
  ["correspondence", /^(?:letter|memo|email|correspondence)$/],
  ["internal", /^internal\s+(?:memo|note|record)$/],
];

const norm = (s) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/ /g, " ");
const collapse = (s) => s.replace(/\s+/g, " ").trim();

function splitSegments(line) {
  return line.split(/\s{3,}|\t+|\s\|\s/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Pure. The document type a page's TITLE line states, or null.
 * @param {{page_no:number,text:string}[]} pages
 * @returns {{type: string, confidence: number, evidence: string}|null}
 */
export function classifyFromText(pages) {
  const lines = toLines(pages);
  return classifyLines(lines);
}

function classifyLines(lines) {
  const found = new Map();
  const limit = Math.min(lines.length, 16);
  for (let i = 0; i < limit; i++) {
    for (const seg of splitSegments(lines[i].t)) {
      const s = collapse(seg).replace(/[:.]+$/, "").toLowerCase();
      if (s.length > 60) continue;
      for (const [type, re] of TITLES) if (re.test(s)) { if (!found.has(type)) found.set(type, { line: i, seg }); }
    }
  }
  // A nameplate transcript announces itself in a bracketed preamble, not a title.
  const first = lines[0]?.t ?? "";
  if (/^\[(?:photo|image)\s+transcript\b.*(?:data\s+plate|nameplate)/i.test(first)) found.set("nameplate-photo", { line: 0, seg: first });
  if (found.size === 1) {
    const [type, ev] = [...found.entries()][0];
    return { type, confidence: 0.95, evidence: ev.seg };
  }
  if (found.size > 1) {
    // "SERVICE TICKET" plus "Invoice #:" is fine (a label is not a title), but two TITLE-shaped lines is a
    // combined document: refuse to pick.
    return null;
  }
  return null;
}

/* --------------------------------------------------------------------- lines */
function toLines(pages) {
  const out = [];
  for (const p of pages ?? []) {
    const raw = String(p?.text ?? "").split(/\r?\n/);
    for (const r of raw) {
      const t = norm(r).replace(/\s+$/g, "").replace(/^\s+/, "");
      if (t) out.push({ t, page: Number(p.page_no) || 1 });
    }
  }
  return out;
}

/* --------------------------------------------------------------------- label dictionary */
// R33 (2026-09-30): the label variants a US service form uses for "the day the work was done". Kept as one exported
// source so the variant table in scripts/fixtures/obvious-fields-r33.mjs and this extractor cannot drift.
export const SERVICE_DATE_LABEL_SRC = [
  "date\\s+of\\s+service", "service\\s+date", "date\\s+serviced", "serviced\\s+on", "service\\s+performed(?:\\s+on)?",
  "svc\\.?\\s*date", "serv\\.?\\s*date", "srv\\.?\\s*date", "service\\s+dt\\.?", "d\\.?o\\.?s\\.?",
  "visit\\s+date", "date\\s+of\\s+visit", "date\\s+performed", "performed\\s+on", "work\\s+date", "date\\s+of\\s+work",
  "job\\s+date", "date\\s+completed", "completed\\s+on", "completion\\s+date", "completed",
  // the date an inspection / a startup was PERFORMED is that paperwork's service date
  "inspection\\s+date", "date\\s+of\\s+inspection", "inspected\\s+on", "start[-\\s]?up\\s+date", "commissioning\\s+date", "commissioned\\s+on",
].map((x) => `(?:${x})`).join("|").replace(/^/, "(?:").concat(")");
export const OTHER_DATE_LABEL_SRC = [
  "next\\s+(?:service|visit|pm|maintenance|inspection|appointment|tune[-\\s]?up)(?:\\s+(?:date|due(?:\\s+(?:date|on|by))?|scheduled|on))?",
  "next\\s+due(?:\\s+date)?", "(?:follow[-\\s]?up|callback|call\\s+back|return\\s+visit|recheck)(?:\\s+(?:date|on|by|scheduled))?",
  "scheduled(?:\\s+(?:for|date|on|visit))?", "appointment(?:\\s+date)?", "print(?:ed)?(?:\\s+(?:on|date))?", "date\\s+printed",
  "generated(?:\\s+on)?", "report\\s+generated",
].map((x) => `(?:${x})`).join("|").replace(/^/, "(?:").concat(")");

// [field key or special, regex source (no anchors, no colon), kind]
const L = (key, src, kind = "text") => ({ key, src, kind });
const NUMTAG = "(?:\\s*(?:#|no\\.?|number|num\\.?))?";
const LABELS = [
  L("invoice_number", `(?:invoice|work\\s+order|ticket|wo|inv)${NUMTAG}`),
  // R33: every common way a form labels the day the work was done (see SERVICE_DATE_LABEL_SRC).
  L("service_date", SERVICE_DATE_LABEL_SRC, "date"),
  // R33: dates that are NOT the service date and must never be read as one ("Next Service Due", "Printed on", ...).
  // Listed BEFORE the bare "Date:" label so "Next Service Date:" is matched whole instead of as "Next" + "Service Date:".
  L("OTHER_DATE", OTHER_DATE_LABEL_SRC, "otherdate"),
  L("installation_date", "(?:installation\\s+date|install(?:ed)?\\s+date|date\\s+installed|date\\s+of\\s+install(?:ation)?|installed\\s+on|install\\s+dt\\.?|in[-\\s]?service\\s+date)", "date"),
  L("warranty_registered_date", "(?:registered\\s+on\\s+file|registration\\s+date|date\\s+registered|registered\\s+on|warranty\\s+registered)", "date"),
  L("warranty_expires", "(?:valid\\s+through|valid\\s+until|warranty\\s+(?:expires|expiration(?:\\s+date)?|expiry|ends?|through)|coverage\\s+ends?|expiration\\s+date|expires)", "date"),
  L("warranty_term", "(?:warranty\\s+term|term\\s+of\\s+warranty|parts\\s+warranty|manufacturer\\s+warranty)"),
  L("agreement_term", "(?:agreement\\s+(?:period|term)|contract\\s+(?:period|term)|coverage\\s+period)"),
  L("DATE", "(?:date|dated)", "date"),
  L("customer_name", "(?:bill(?:ed)?\\s+to|sold\\s+to|customer(?:\\s+name)?|client(?:\\s+name)?|account(?:\\s+name)?|homeowner(?:\\s+name)?|property\\s+owner)"),
  L("service_address", "(?:service\\s+(?:address|location)|job\\s+(?:address|site|location)|site\\s+address|property\\s+address|install(?:ation)?\\s+address)", "address"),
  L("PHONE", "(?:customer\\s+phone|contact\\s+phone|homeowner\\s+phone|phone(?:\\s*(?:#|no\\.?|number))?|ph|tel(?:ephone)?|cell|mobile)", "phone"),
  L("EMAIL", "(?:customer\\s+email|homeowner\\s+email|contact\\s+email|e-?mail(?:\\s+address)?)", "email"),
  L("EQUIPMENT", "(?:equipment|unit\\s+installed|system)"),
  L("manufacturer", "(?:manufacturer|mfr|mfg|brand|make)"),
  L("model", `(?:model${NUMTAG}|model\\s+number|m\\/n)`),
  L("serial_number", `(?:serial${NUMTAG}|s\\/n|sn)`),
  L("equipment_type", "(?:equipment\\s+type|unit\\s+type|type\\s+of\\s+equipment|system\\s+type)"),
  L("tonnage", "(?:tonnage|capacity|cooling\\s+capacity|nominal\\s+size)"),
  L("refrigerant", "(?:refrigerant(?:\\s+(?:type|charge))?|refrig)"),
  L("equipment_id", "(?:unit\\s+(?:id|#|tag)|equipment\\s+id|asset\\s+(?:id|tag)|tag(?:\\s+#)?)"),
  L("service_type", "(?:visit\\s+type|service\\s+type|type\\s+of\\s+service|call\\s+type|job\\s+type)"),
  L("technician", "(?:assigned\\s+technician|technician|tech|serviced\\s+by|performed\\s+by|installer|installed\\s+by)"),
  L("BLOCK_WORK", "(?:work\\s+performed|description\\s+of\\s+work|work\\s+description|work\\s+completed|services?\\s+performed|task|scope\\s+of\\s+work|repairs?\\s+performed|work\\s+done)", "block"),
  L("BLOCK_FINDINGS", "(?:findings|inspection\\s+findings|observations)", "block"),
  L("PROPOSED", "(?:proposed\\s+work|proposal)", "text"),
  L("BLOCK_PARTS", "(?:parts(?:\\s+used)?|part\\s+numbers?|parts\\s+replaced)", "block"),
  L("notes", "(?:notes?|comments?|remarks?)", "notes"),
  L("labor_hours", "(?:labor(?:\\s+(?:hours|hrs))?|hours)", "hours"),
  L("cost", "(?:total\\s+due|amount\\s+due|grand\\s+total|invoice\\s+total|quote\\s+total|total\\s+cost|estimated\\s+cost|estimate\\s+total|annual\\s+cost|annual\\s+fee|agreement\\s+(?:price|fee)|total)", "money"),
  L("BALANCE", "(?:balance\\s+due|balance)", "money"),
  L("status", "(?:status)"),
  L("permit_number", `(?:permit${NUMTAG})`),
  L("IGNORE", "(?:contractor|contact|coverage|terms|payment\\s+terms|due\\s+date|subtotal|sub-total|tax|sales\\s+tax|amount\\s+paid|deposit|license(?:\\s*#)?|lic\\.?(?:\\s*#)?|roc(?:\\s*#)?|valid\\s+for|po(?:\\s*#)?|job(?:\\s*(?:#|no\\.?|number))?|ship\\s+to|location|preferred\\s+contact|attn|attention)", "ignore"),
];
// longest-first so "customer phone" wins over "customer"
function makeLabelFinder(defs) {
  const alt = defs.map((l, i) => `(?<g${i}>${l.src})`).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${alt})\\s*:\\s*`, "gi");
  return (t) => {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      let idx = -1;
      for (let i = 0; i < defs.length; i++) if (m.groups[`g${i}`] !== undefined) { idx = i; break; }
      if (idx < 0) continue;
      out.push({ def: defs[idx], label: m[0].replace(/\s*:\s*$/, ""), start: m.index, end: m.index + m[0].length });
    }
    return out;
  };
}
const findLabels = makeLabelFinder(LABELS);

/**
 * R33: which way round this document writes numeric dates. A US form is month-first, but a document that prints a
 * date only readable day-first ("25/10/2028") is telling us it is day-first. Pure.
 * @returns {'mdy'|'dmy'|'strict'} 'strict' = the document shows BOTH orders, so a swappable date (10/11/2028) has no
 *   usable hint and must be refused rather than guessed.
 */
export function detectDateOrder(text) {
  let mdy = 0, dmy = 0;
  for (const m of String(text ?? "").matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/g)) {
    const a = +m[1], b = +m[2];
    if (a > 31 || b > 31 || a === 0 || b === 0) continue;
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (dmy && mdy) return "strict";
  return dmy ? "dmy" : "mdy";
}

/* --------------------------------------------------------------------- validators */
const PHONE_RE = /^(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?$/i;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ADDR_RE = /^\d{1,6}\s+[A-Za-z0-9 .'#-]+?,?\s+[A-Za-z .'-]+,?\s+[A-Z]{2}\.?\s+\d{5}(?:-\d{4})?$/;
const ADDR_LOOSE_RE = /^\d{1,6}\s+\S.*\b[A-Z]{2}\b\s+\d{5}/;
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9\-\/.]{3,26}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9\-\/.]{2,29}$/;
const MONEY_RE = /^-?\$?\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^-?\$?\s?-?\d+(?:\.\d{1,2})?$/;
const STATUS_RE = /^[A-Za-z][A-Za-z -]{1,24}$/;
const NAME_RE = /^[A-Za-z][A-Za-z .,'&/()-]{1,70}$/;
// R33: a placeholder printed where a name goes is not a name ("Technician: Unassigned", "Customer: On file").
const PLACEHOLDER_RE = /^(?:n\/?a|none|tbd|tba|unassigned|not\s+assigned|pending|unknown|see\s+(?:above|below|attached)|same|on\s+file|signature\s+on\s+file|-+|\?+)\.?$/i;
/** R33: a loose address must END at its ZIP — "1 A St, Mesa, AZ 85201 Ph 480-555-0101" is an address with a phone riding along. */
const isAddress = (v) => ADDR_RE.test(v) || (ADDR_LOOSE_RE.test(v) && /\b\d{5}(?:-\d{4})?\.?$/.test(v));

const BRANDS = [...new Set([...Object.keys(BRAND_RULES), "aprilaire", "bard", "nortek", "lg", "samsung", "rinnai", "navien", "burnham", "weil-mclain", "lochinvar", "a. o. smith", "bradford white", "friedrich", "gree", "midea", "york international", "american standard"])]
  .sort((a, b) => b.length - a.length);
const BRAND_LEAD_RE = new RegExp(`^(${BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b\\s*(.*)$`, "i");

const cap = (s) => s.split(" ").map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");

function cleanValue(v) {
  return collapse(String(v ?? "")).replace(/[,;|]+$/g, "").trim();
}

function moneyBare(v) {
  const s = String(v).replace(/\s/g, "");
  if (!MONEY_RE.test(s)) return null;
  const neg = s.startsWith("-") || s.includes("$-");
  const digits = s.replace(/[$,-]/g, "");
  return (neg ? "-" : "") + digits;
}

const SERVICE_TYPES = new Map([
  ["pm", "Preventive Maintenance"], ["preventive maintenance", "Preventive Maintenance"], ["preventative maintenance", "Preventive Maintenance"],
  ["maintenance", "Preventive Maintenance"], ["tune-up", "Preventive Maintenance"], ["tune up", "Preventive Maintenance"],
  ["repair", "Repair"], ["service call", "Repair"], ["emergency", "Emergency"], ["emergency repair", "Emergency"],
  ["installation", "Installation"], ["install", "Installation"], ["inspection", "Inspection"],
  ["startup", "Startup"], ["start-up", "Startup"], ["start up", "Startup"],
]);

const NON_DATE_PHRASES = /^(?:per\s+manufacturer(?:'s)?\s+terms?|see\s+manufacturer|n\/?a|none|tbd|pending|unknown|not\s+(?:registered|available|applicable))\.?$/i;

/** Lines that carry no field but are ordinary form furniture. Each is a whole-line pattern. */
const BOILERPLATE = [
  /^thank\s+you(?:\s+for\s+(?:your\s+)?(?:business|choosing\b.*))?\.?!?$/i,
  /^(?:page\s+\d+(?:\s+of\s+\d+)?|\d+\s+of\s+\d+)$/i,
  /^(?:customer|office|technician)\s+copy$/i,
  /^(?:signature|customer\s+signature|technician\s+signature|authorized\s+signature)[\s:_.-]*$/i,
  /^valid\s+for\s+\d+\s+days\.?$/i,
  /^(?:start[\s-]?up|startup|commissioning)\s+readings\s+recorded,?\s+system\s+operating\s+normally\.?$/i,
  /^units?\s+covered:?$/i,
];

const INSTALL_DESC_RE = /^(?:new\s+)?(?:install(?:ed|ation)?|replac(?:e|ed|ement)\s+(?:of\s+)?(?:the\s+)?(?:\d[\d.]*\s*[- ]?ton\s+)?(?:\w+\s+){0,3}system|change[-\s]?out|new\s+system)\b/i;

const UNIT_LINE_RE = /^((?:unit\s+\d{1,2})|(?:[A-Za-z]{1,6}-?\d{1,3}))\s*:\s*(.+)$/i;

/* --------------------------------------------------------------------- the extractor */
/**
 * @param {{page_no:number,text:string}[]} pages
 * @param {{pack?: object|null}} [opts]
 * @returns {{accepted: true, toolInput: object, type: string, coverage: object}
 *          |{accepted: false, reason: string, type?: string|null}}
 */
export function extractFromText(pages, opts = {}) {
  const reject = (reason, type = null) => ({ accepted: false, reason, type });
  if (opts.pack && opts.pack.id && opts.pack.id !== "hvac") return reject("non-hvac-pack");
  const lines = toLines(pages);
  if (!lines.length) return reject("no-text");
  if (lines.length > 90) return reject("too-many-lines");

  const cls = classifyLines(lines);
  if (!cls) return reject("no-title");
  const type = cls.type;
  if (!TEMPLATE_TYPES.has(type)) return reject("type-not-template", type);
  const dateOrder = detectDateOrder(lines.map((l) => l.t).join("\n"));
  const parseDate = (v) => normalizeDate(v, { order: dateOrder });
  // (reminder_* facts only ever survive on correspondence/dispatch/other/internal — reminders.js — none of which is a
  // template type here, so reminder language in a form's notes needs no judgement from us.)

  const fields = []; // {key,value,page_no,verbatim,confidence,unit_index?}
  const explained = new Set();
  const add = (key, value, line, confidence = 0.95, unit_index = null) => {
    fields.push({ key, value, page_no: line.page, verbatim: line.t.slice(0, 200), confidence, ...(unit_index ? { unit_index } : {}) });
  };

  // ---- header zone: everything before the first customer/address/equipment label
  const labelled = lines.map((l) => findLabels(l.t));
  let headerEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (labelled[i].some((x) => ["customer_name", "service_address", "EQUIPMENT", "serial_number", "manufacturer", "model"].includes(x.def.key))) { headerEnd = i; break; }
  }
  // the title line(s) are explained wherever they sit
  const titleSeg = (s) => TITLES.some(([, re]) => re.test(collapse(s).replace(/[:.]+$/, "").toLowerCase()));
  let sawShopName = false;
  // One unlabeled letterhead fragment: title, shop name, address, phone, email, website, licence, tagline.
  const headerSeg = (seg, line, i) => {
    if (titleSeg(seg)) return true;
    if (/^\[(?:photo|image)\s+transcript/i.test(seg)) return true;
    if (ADDR_RE.test(seg) || ADDR_LOOSE_RE.test(seg)) { add("shop_address", seg.replace(/[,;]+$/, ""), line, 0.9); return true; }
    const phoneM = seg.match(/^(?:phone|ph|tel|office)?\s*[:.]?\s*(\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4})$/i);
    if (phoneM && PHONE_RE.test(phoneM[1])) { add("shop_phone", phoneM[1], line, 0.9); return true; }
    if (EMAIL_RE.test(seg)) { add("shop_email", seg, line, 0.9); return true; }
    if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(seg)) return true;
    if (/\b(?:lic(?:ense)?|roc|ccb|contractor)\b.*\d/i.test(seg)) return true;
    if (!sawShopName && i <= 2 && /^[A-Za-z0-9][A-Za-z0-9 &.,'()\/-]{2,60}$/.test(seg) && !/\d{3,}/.test(seg)) { sawShopName = true; return true; }
    if (/^[A-Z][A-Za-z0-9 &.,'()\/-]{2,60}$/.test(seg) && !/[$@]/.test(seg) && !/\d{5}/.test(seg) && i <= 3) return true;
    return false;
  };
  for (let i = 0; i < headerEnd; i++) {
    if (labelled[i].length) continue;
    const line = lines[i];
    for (const seg of splitSegments(line.t)) if (!headerSeg(seg, line, i)) return reject("unexplained-header-line", type);
    explained.add(i);
  }

  // ---- labelled lines
  const single = new Map(); // key -> {value,line}
  const setSingle = (key, value, line, conf = 0.95) => {
    const prev = single.get(key);
    if (prev) { if (prev.value.toLowerCase() === value.toLowerCase()) return true; return false; }
    single.set(key, { value, line, conf });
    return true;
  };
  const totals = []; // cost candidates
  let balance = null;
  const workItems = []; // {key,value,line}
  const partItems = [];
  const noteParts = [];
  const units = [];
  let unitsHeaderSeen = false;
  let firstCustomerLabelIdx = headerEnd;
  const inHeader = (i) => i < firstCustomerLabelIdx;
  const consumeBlock = (startIdx, key) => {
    // list items (or one following line) under a block label; stops at blank/label/known structure
    const items = [];
    let j = startIdx + 1;
    while (j < lines.length) {
      if (labelled[j].length) break;
      const t = lines[j].t;
      const bullet = /^(?:[-*•●▪]\s+|\[[xX ]?\]\s+|\d{1,2}[.)]\s+)(.+)$/.exec(t);
      if (bullet) { items.push({ v: cleanValue(bullet[1]), line: lines[j], idx: j }); j++; continue; }
      if (!items.length && (key === "work" || key === "findings")) { items.push({ v: cleanValue(t), line: lines[j], idx: j }); j++; break; }
      break;
    }
    return items;
  };

  for (let i = 0; i < lines.length; i++) {
    const marks = labelled[i];
    if (!marks.length) continue;
    const line = lines[i];
    const t = line.t;
    // text before the first label on the line
    const prefix = t.slice(0, marks[0].start).trim();
    if (prefix) {
      if (i >= headerEnd) return reject("text-before-label", type);
      for (const seg of splitSegments(prefix)) if (!headerSeg(seg, line, i)) return reject("text-before-label", type);
    }
    for (let k = 0; k < marks.length; k++) {
      const mk = marks[k];
      const raw = t.slice(mk.end, k + 1 < marks.length ? marks[k + 1].start : t.length);
      let value = cleanValue(raw);
      if (/\s{3,}/.test(raw.trim())) return reject("column-gap-in-value", type);
      const key = mk.def.key;
      const kind = mk.def.kind;
      if (key === "customer_name" || key === "service_address") firstCustomerLabelIdx = Math.min(firstCustomerLabelIdx, i);
      // block labels may carry an inline value or a list below
      if (kind === "block") {
        const bk = key === "BLOCK_WORK" ? "work" : key === "BLOCK_FINDINGS" ? "findings" : "parts";
        let items = [];
        if (value) items = [{ v: value, line, idx: i }];
        else items = consumeBlock(i, bk);
        if (!items.length) return reject("empty-block", type);
        for (const it of items) {
          if (it.idx !== i) explained.add(it.idx);
          if (bk === "parts") {
            for (const part of it.v.split(/\s*[,;]\s*/).filter(Boolean)) {
              if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,24}$/.test(part) || !/\d/.test(part)) return reject("part-not-a-part-number", type);
              partItems.push({ value: part, line: it.line });
            }
          } else if (bk === "findings") {
            if (it.v.length > 240) return reject("long-free-text", type);
            noteParts.push({ v: it.v, line: it.line });
          } else {
            if (it.v.length > 240) return reject("long-free-text", type);
            workItems.push({ value: it.v, line: it.line });
          }
        }
        continue;
      }
      if (!value && marks[k + 1] && marks[k + 1].def.key === key) continue; // "Phone: Ph: 480..." — a redundant repeated label
      // R33: "Date of Service:" with the date on the NEXT line (a two-row form / a label column). Taken only when that
      // next line is nothing but a value of the right shape (a whole date, a whole address) and carries no label.
      if (!value && k === marks.length - 1 && (kind === "date" || kind === "address") && i + 1 < lines.length && !labelled[i + 1].length && !explained.has(i + 1)) {
        const nxt = cleanValue(lines[i + 1].t);
        const okNext = kind === "date" ? !!parseDate(nxt) : isAddress(nxt);
        if (okNext) { value = nxt; explained.add(i + 1); }
      }
      if (!value) return reject(`empty-value:${key}`, type);
      switch (key) {
        case "IGNORE": break;
        // R33: a date we have no field for ("Next Service Due", "Printed on") on the same form as the service date. Two
        // dates on one page is exactly where a lookup can pick the wrong one, so the whole document goes to the model
        // (and the label scan never reads one of these as a service date).
        case "OTHER_DATE": return reject("other-date-label", type);
        case "invoice_number": {
          if (!/^[A-Za-z0-9][A-Za-z0-9-_/.]{0,29}$/.test(value)) return reject("bad-invoice-number", type);
          if (!setSingle("invoice_number", value, line)) return reject("conflict:invoice_number", type);
          break;
        }
        case "DATE": {
          const d = parseDate(value);
          if (!d) return reject("bad-date", type);
          // a bare "Date:" is the document date: service date on service paperwork, none for quotes/POs
          if (type === "proposal-quote") { if (!setSingle("__docdate", d, line)) return reject("conflict:date", type); break; }
          if (!setSingle("service_date", d, line)) return reject("conflict:service_date", type);
          break;
        }
        case "service_date": case "installation_date": case "warranty_registered_date": case "warranty_expires": {
          if (NON_DATE_PHRASES.test(value)) break; // "Valid through: per manufacturer terms" — printed, but not a date
          const d = parseDate(value);
          if (!d) return reject(`bad-date:${key}`, type);
          if (!setSingle(key, d, line)) return reject(`conflict:${key}`, type);
          break;
        }
        case "warranty_term": case "agreement_term": {
          if (value.length > 90) return reject("long-free-text", type);
          if (!setSingle(key, value, line)) return reject(`conflict:${key}`, type);
          break;
        }
        case "customer_name": {
          if (PLACEHOLDER_RE.test(value)) return reject("placeholder-customer-name", type);
          if (!NAME_RE.test(value) || /\d/.test(value) || value.length < 3) return reject("bad-customer-name", type);
          if (!setSingle("customer_name", value, line)) return reject("conflict:customer_name", type);
          break;
        }
        case "service_address": {
          if (!isAddress(value)) return reject("bad-address", type);
          if (!setSingle("service_address", value.replace(/[,;]+$/, ""), line)) return reject("conflict:service_address", type);
          break;
        }
        case "PHONE": {
          if (!PHONE_RE.test(value)) return reject("bad-phone", type);
          const shop = i < firstCustomerLabelIdx || (firstCustomerLabelIdx === lines.length && i < headerEnd);
          if (shop) { if (!setSingle("shop_phone", value, line, 0.9)) return reject("conflict:shop_phone", type); }
          else if (!setSingle("customer_phone", value, line)) return reject("conflict:customer_phone", type);
          break;
        }
        case "EMAIL": {
          if (!EMAIL_RE.test(value)) return reject("bad-email", type);
          const shop = i < firstCustomerLabelIdx || (firstCustomerLabelIdx === lines.length && i < headerEnd);
          if (shop) { if (!setSingle("shop_email", value, line, 0.9)) return reject("conflict:shop_email", type); }
          else if (!setSingle("customer_email", value, line)) return reject("conflict:customer_email", type);
          break;
        }
        case "EQUIPMENT": {
          const m = BRAND_LEAD_RE.exec(value);
          if (!m) return reject("equipment-line-unparsed", type);
          const model = cleanValue(m[2]);
          if (!MODEL_RE.test(model) || !/\d/.test(model)) return reject("equipment-model-unparsed", type);
          if (!setSingle("manufacturer", cap(m[1]), line, 0.9)) return reject("conflict:manufacturer", type);
          if (!setSingle("model", model, line, 0.9)) return reject("conflict:model", type);
          break;
        }
        case "manufacturer": {
          if (!/^[A-Za-z][A-Za-z0-9 .&'-]{1,40}$/.test(value)) return reject("bad-manufacturer", type);
          if (!setSingle("manufacturer", value, line)) return reject("conflict:manufacturer", type);
          break;
        }
        case "model": {
          if (!MODEL_RE.test(value) || !/\d/.test(value)) return reject("bad-model", type);
          if (!setSingle("model", value, line)) return reject("conflict:model", type);
          break;
        }
        case "serial_number": {
          if (!SERIAL_RE.test(value) || !/\d/.test(value)) return reject("bad-serial", type);
          if (!setSingle("serial_number", value, line)) return reject("conflict:serial_number", type);
          break;
        }
        case "equipment_type": {
          if (!/^[A-Za-z][A-Za-z /-]{2,40}$/.test(value)) return reject("bad-equipment-type", type);
          if (!setSingle("equipment_type", value, line)) return reject("conflict:equipment_type", type);
          break;
        }
        case "tonnage": {
          if (!/^\d+(?:\.\d+)?\s*(?:-?\s*ton|tons|btu|btuh|mbh|k\s*btu)s?$/i.test(value) && !/^[\d,]+\s*btu(?:h|\/h)?$/i.test(value)) return reject("bad-tonnage", type);
          if (!setSingle("tonnage", value, line)) return reject("conflict:tonnage", type);
          break;
        }
        case "refrigerant": {
          if (!/^R-?\d{2,3}[A-Za-z]?$/i.test(value)) return reject("bad-refrigerant", type);
          if (!setSingle("refrigerant", value, line)) return reject("conflict:refrigerant", type);
          break;
        }
        case "equipment_id": {
          if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,20}$/.test(value)) return reject("bad-equipment-id", type);
          if (!setSingle("equipment_id", value, line)) return reject("conflict:equipment_id", type);
          break;
        }
        case "service_type": {
          const mapped = SERVICE_TYPES.get(value.toLowerCase());
          if (!mapped) return reject("unknown-service-type", type);
          if (!setSingle("service_type", mapped, line)) return reject("conflict:service_type", type);
          break;
        }
        case "technician": {
          if (PLACEHOLDER_RE.test(value)) return reject("placeholder-technician", type);
          if (!NAME_RE.test(value) || /\d/.test(value) || /\s(?:and|&)\s|[,/]/.test(value)) return reject("bad-or-multiple-technician", type);
          if (!setSingle("technician", value, line)) return reject("conflict:technician", type);
          break;
        }
        case "PROPOSED": {
          if (value.length > 240) return reject("long-free-text", type);
          noteParts.push({ v: value, line });
          break;
        }
        case "notes": {
          if (value.length > 240) return reject("long-free-text", type);
          noteParts.push({ v: value, line });
          break;
        }
        case "labor_hours": {
          const m = /^(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)?$/i.exec(value);
          if (!m) return reject("labor-not-hours", type);
          if (!setSingle("labor_hours", m[1], line)) return reject("conflict:labor_hours", type);
          break;
        }
        case "cost": {
          const v = moneyBare(value);
          if (v === null) return reject("bad-money", type);
          totals.push({ v, label: mk.label.toLowerCase(), line });
          break;
        }
        case "BALANCE": {
          const v = moneyBare(value);
          if (v === null) return reject("bad-money", type);
          balance = { v, line };
          break;
        }
        case "status": {
          if (!STATUS_RE.test(value)) return reject("bad-status", type);
          if (!setSingle("status", value, line)) return reject("conflict:status", type);
          break;
        }
        case "permit_number": {
          if (!/^[A-Za-z0-9][A-Za-z0-9-_/.]{3,30}$/.test(value) || !/\d/.test(value)) return reject("bad-permit-number", type);
          if (!setSingle("permit_number", value, line)) return reject("conflict:permit_number", type);
          break;
        }
        default: return reject(`unhandled-label:${key}`, type);
      }
    }
    explained.add(i);
  }

  // ---- unit list ("Unit 1: Lennox ML14XC1-046-230, Serial LX100005, Installed 04/28/2012")
  for (let i = 0; i < lines.length; i++) {
    if (explained.has(i)) continue;
    const t = lines[i].t;
    if (/^units?\s+covered:?$/i.test(t)) { unitsHeaderSeen = true; explained.add(i); continue; }
    const m = UNIT_LINE_RE.exec(t);
    if (!m || !unitsHeaderSeen) continue;
    const um = /^(.+?)\s+([A-Za-z0-9][A-Za-z0-9\-\/.]{3,29}),\s*serial\s+([A-Za-z0-9][A-Za-z0-9\-\/.]{3,26})(?:,\s*installed\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{4}|\d{4}-\d{2}-\d{2}))?$/i.exec(m[2]);
    if (!um) return reject("unit-line-unparsed", type);
    const b = BRAND_LEAD_RE.exec(um[1]);
    if (!b || cleanValue(b[2])) return reject("unit-brand-unparsed", type);
    const inst = um[4] ? parseDate(um[4]) : null;
    if (um[4] && !inst) return reject("unit-date-unparsed", type);
    units.push({ id: collapse(m[1]), brand: cap(b[1]), model: um[2], serial: um[3], installed: inst, line: lines[i] });
    explained.add(i);
  }
  if (units.length && (single.has("serial_number") || single.has("model"))) return reject("units-and-single-equipment", type);

  // ---- remaining lines: only header/blocks/boilerplate are allowed to be unlabeled
  for (let i = 0; i < lines.length; i++) {
    if (explained.has(i)) continue;
    const t = lines[i].t;
    const segs = splitSegments(t);
    if (segs.every((s) => titleSeg(s) || BOILERPLATE.some((re) => re.test(collapse(s))))) { explained.add(i); continue; }
    return reject("unexplained-line", type);
  }

  // ---- totals
  if (totals.length) {
    const vals = [...new Set(totals.map((x) => x.v))];
    if (vals.length > 1) return reject("multiple-totals", type);
    if (balance && balance.v !== vals[0]) return reject("total-vs-balance-differ", type);
    const t0 = totals[0];
    fields.push({ key: "cost", value: t0.v, page_no: t0.line.page, verbatim: t0.line.t.slice(0, 200), confidence: 0.95 });
  } else if (balance) {
    fields.push({ key: "cost", value: balance.v, page_no: balance.line.page, verbatim: balance.line.t.slice(0, 200), confidence: 0.85 });
  }

  // ---- install-invoice guard
  // (financials only care about the printed amounts, so they pass skipInstallGuard: the install-date judgement is moot there)
  if (!opts.skipInstallGuard && type === "invoice" && workItems.some((w) => INSTALL_DESC_RE.test(w.value)) && !single.has("installation_date")) return reject("install-invoice-needs-judgement", type);

  // ---- assemble
  for (const [key, v] of single) {
    if (key === "__docdate") continue;
    fields.push({ key, value: v.value, page_no: v.line.page, verbatim: v.line.t.slice(0, 200), confidence: v.conf });
  }
  if (noteParts.length) {
    const joined = noteParts.map((n) => n.v).join("; ");
    if (joined.length > 300) return reject("long-free-text", type);
    fields.push({ key: "notes", value: joined, page_no: noteParts[0].line.page, verbatim: noteParts[0].line.t.slice(0, 200), confidence: 0.9 });
  }
  for (const w of workItems) fields.push({ key: "work_performed", value: w.value, page_no: w.line.page, verbatim: w.line.t.slice(0, 200), confidence: 0.95 });
  for (const p of partItems) fields.push({ key: "part_number", value: p.value, page_no: p.line.page, verbatim: p.line.t.slice(0, 200), confidence: 0.95 });
  if (units.length) {
    const multi = units.length > 1;
    units.forEach((u, idx) => {
      const ui = multi ? idx + 1 : null;
      fields.push({ key: "equipment_id", value: u.id, page_no: u.line.page, verbatim: u.line.t.slice(0, 200), confidence: 0.9, ...(ui ? { unit_index: ui } : {}) });
      fields.push({ key: "manufacturer", value: u.brand, page_no: u.line.page, verbatim: u.line.t.slice(0, 200), confidence: 0.9, ...(ui ? { unit_index: ui } : {}) });
      fields.push({ key: "model", value: u.model, page_no: u.line.page, verbatim: u.line.t.slice(0, 200), confidence: 0.9, ...(ui ? { unit_index: ui } : {}) });
      fields.push({ key: "serial_number", value: u.serial, page_no: u.line.page, verbatim: u.line.t.slice(0, 200), confidence: 0.9, ...(ui ? { unit_index: ui } : {}) });
      if (u.installed) fields.push({ key: "installation_date", value: u.installed, page_no: u.line.page, verbatim: u.line.t.slice(0, 200), confidence: 0.9, ...(ui ? { unit_index: ui } : {}) });
    });
  }

  // ---- required fields for the type (same table completeness uses)
  const have = new Set(fields.map((f) => f.key));
  const required = REQUIRED_FIELDS[type] ?? [];
  const missing = required.filter((r) => !r.split("|").some((k) => have.has(k)));
  if (missing.length) return reject(`missing-required:${missing.join(",")}`, type);
  if (!DOCUMENT_TYPE_IDS.has(type)) return reject("unknown-type", type);

  // A finished document that names no customer, address or unit is not a form we understand.
  if (!have.has("customer_name") && !have.has("service_address") && !have.has("serial_number") && !have.has("model") && !have.has("permit_number")) return reject("no-identity", type);

  return {
    accepted: true,
    type,
    toolInput: { document_type: type, document_type_confidence: cls.confidence, fields },
    coverage: { lines: lines.length, fields: fields.length },
    docDate: single.get("__docdate")?.value ?? (type === "invoice" ? single.get("service_date")?.value ?? null : null),
    workItems: workItems.map((w) => w.value),
  };
}

/* ===================================================================== R33: targeted label scan
 *
 * extractFromText above is all-or-nothing: one line it does not understand and the WHOLE document goes to the model
 * (correct — it is replacing the model). The scan below is the opposite tool, for the opposite job: given a document
 * whose extraction is already done (by the model or by extractFromText), find the value printed next to a label for
 * ONE field that extraction left empty — "Date of Service: 10/19/2028" on a page the model read but whose date the
 * validator then threw away (the Sonoran Comfort Air defect), or that the model simply skipped.
 *
 * Precision rules (a wrong fill is worse than a missing field, because it LOOKS checked):
 *   - only an explicit label from the dictionary counts; prose never does;
 *   - the value must validate for that field (a whole date, an address, a person's name, an amount, ...);
 *   - a date labelled "Next Service Due" / "Printed on" / "Follow-up" is never a service date (OTHER_DATE);
 *   - a bare "Date:" stands for the service date only on service paperwork, and only when no explicit service-date
 *     label exists anywhere on the document;
 *   - the caller (labelFill.js) fills a field only when every candidate agrees on ONE value.
 * Pure. No clock, no I/O. HVAC vocabulary (the caller skips other packs).
 */
const SCAN_EXTRA = [
  L("vendor", "(?:vendor|supplier|distributor|ordered\\s+from|purchased\\s+from)", "vendor"),
  L("ADDRESS", "(?:address|addr\\.?|site|location|job\\s+at|for\\s+job\\s+at)", "address"),
];
// The scanner's dictionary: everything the extractor knows, minus the generic IGNORE "location" (a bare "Location:"
// is an address to the scan), plus vendor and a bare "Address:".
const SCAN_LABELS = [
  ...LABELS.filter((l) => l.key !== "IGNORE"),
  L("IGNORE", "(?:contractor|contact|coverage|terms|payment\\s+terms|due\\s+date|subtotal|sub-total|tax|sales\\s+tax|amount\\s+paid|deposit|license(?:\\s*#)?|lic\\.?(?:\\s*#)?|roc(?:\\s*#)?|valid\\s+for|po(?:\\s*#)?|job(?:\\s*(?:#|no\\.?|number))?|ship\\s+to|preferred\\s+contact|attn|attention|order\\s+date|invoice\\s+date)", "ignore"),
  ...SCAN_EXTRA,
];
const findScanLabels = makeLabelFinder(SCAN_LABELS);
// Same dictionary, for a table header row ("Date of Service | Customer | Technician") whose cells carry no colon.
const BARE_LABEL_RES = SCAN_LABELS.map((d) => ({ def: d, re: new RegExp(`^(?:${d.src})$`, "i") }));
// A date label with no colon ("Date of Service 10/19/2028", "DOS - 10/19/2028") — only ever accepted when what follows
// is a whole valid date, so it cannot capture prose.
const DATE_KEYS_FOR_NOCOLON = ["service_date", "installation_date", "warranty_registered_date", "warranty_expires", "OTHER_DATE"];
const NOCOLON_DATE_RES = SCAN_LABELS.filter((d) => DATE_KEYS_FOR_NOCOLON.includes(d.key))
  .map((d) => ({ def: d, re: new RegExp(`^(${d.src})\\s*(?:[-–]\\s*|\\s)\\s*(.+)$`, "i") }));

/** Cells of a table-ish line: a pipe (with or without spaces), a tab, or a 3+ space column gap. */
const splitCells = (line) => line.split(/\s*\|\s*|\t+|\s{3,}/).map((x) => x.trim()).filter(Boolean);

/** Service paperwork on which a bare "Date:" IS the date the work was done (same rule as extractFromText's DATE). */
export const BARE_DATE_MEANS_SERVICE = new Set(["service-ticket", "work-order", "startup-sheet", "inspection-report", "dispatch-note", "invoice"]);

const LABEL_PRIORITY_COST = ["total due", "amount due", "grand total", "invoice total", "total cost", "quote total", "estimate total", "estimated cost", "total", "annual cost", "annual fee", "agreement price", "agreement fee"];

/**
 * Pure. Every labelled, validated value on the page for the fields the caller cares about.
 * @param {{page_no:number,text:string}[]} pages
 * @param {{type?: string|null, keys?: string[]|null}} [opts]
 * @returns {{order: string, candidates: Record<string, {value:string, page_no:number, verbatim:string, label:string, strength:'explicit'|'bare'}[]>}}
 */
export function scanLabeledValues(pages, opts = {}) {
  const type = opts.type ?? null;
  const want = opts.keys ? new Set(opts.keys) : null;
  const lines = toLines(pages);
  const order = detectDateOrder(lines.map((l) => l.t).join("\n"));
  const parseDate = (v) => normalizeDate(v, { order });
  const out = {};
  const push = (key, value, line, label, strength = "explicit") => {
    if (want && !want.has(key)) return;
    (out[key] ??= []).push({ value, page_no: line.page, verbatim: line.t.slice(0, 200), label: String(label).toLowerCase(), strength });
  };
  // Letterhead addresses (the shop's own) are never a service address, even under a bare "Address:" label.
  const shopAddrs = new Set();
  for (let i = 0; i < Math.min(lines.length, 4); i++) {
    for (const seg of splitSegments(lines[i].t)) if ((ADDR_RE.test(seg) || ADDR_LOOSE_RE.test(seg)) && !findScanLabels(seg).length) shopAddrs.add(collapse(seg).toLowerCase().replace(/[,;.]+$/, ""));
  }
  const titleIdx = lines.findIndex((l) => splitSegments(l.t).some((seg) => TITLES.some(([, re]) => re.test(collapse(seg).replace(/[:.]+$/, "").toLowerCase()))));

  const accept = (def, rawValue, line, i, label) => {
    const key = def.key;
    let value = cleanValue(rawValue);
    if (!value) return;
    switch (def.kind) {
      case "ignore": case "otherdate": return;
      case "date": {
        if (NON_DATE_PHRASES.test(value)) return;
        const d = parseDate(value);
        if (!d) return;
        if (key === "DATE") {
          if (type && BARE_DATE_MEANS_SERVICE.has(type)) push("service_date", d, line, label, "bare");
          return;
        }
        push(key, d, line, label);
        return;
      }
      case "address": {
        // "For job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)" — an address followed by a name in
        // parentheses: the address is the part up to the ZIP, the name is the customer.
        const pm = /^(.+?\d{5}(?:-\d{4})?)\s*\(([^)]+)\)$/.exec(value);
        if (pm) {
          if (!(ADDR_RE.test(pm[1]) || ADDR_LOOSE_RE.test(pm[1]))) return;
          value = pm[1];
          const nm = cleanValue(pm[2]);
          if (NAME_RE.test(nm) && !/\d/.test(nm)) push("customer_name", nm, line, label, "bare");
        } else if (!isAddress(value)) {
          return; // the loose form must END at the ZIP: no trailing text riding along into the address
        }
        value = value.replace(/[,;]+$/, "");
        if (key === "ADDRESS") {
          if (i <= titleIdx || shopAddrs.has(value.toLowerCase().replace(/[,;.]+$/, ""))) return;
          push("service_address", value, line, label, "bare");
          return;
        }
        push("service_address", value, line, label);
        return;
      }
      case "money": {
        const v = moneyBare(value);
        if (v === null) return;
        push(key === "BALANCE" ? "__balance" : "cost", v, line, label);
        return;
      }
      case "vendor": {
        if (!/^[A-Za-z0-9][A-Za-z0-9 .,'&()\/#-]{1,60}$/.test(value) || !/[A-Za-z]{2}/.test(value)) return;
        push("vendor", value, line, label);
        return;
      }
      default: break;
    }
    switch (key) {
      case "customer_name": if (!PLACEHOLDER_RE.test(value) && NAME_RE.test(value) && !/\d/.test(value) && value.length >= 3) push(key, value, line, label); return;
      case "technician": if (!PLACEHOLDER_RE.test(value) && NAME_RE.test(value) && !/\d/.test(value) && !/\s(?:and|&)\s|[,/]/.test(value)) push(key, value, line, label); return;
      case "serial_number": if (SERIAL_RE.test(value) && /\d/.test(value)) push(key, value, line, label); return;
      case "model": if (MODEL_RE.test(value) && /\d/.test(value)) push(key, value, line, label); return;
      case "manufacturer": if (/^[A-Za-z][A-Za-z0-9 .&'-]{1,40}$/.test(value)) push(key, value, line, label); return;
      case "EQUIPMENT": {
        const m = BRAND_LEAD_RE.exec(value);
        if (!m) return;
        const model = cleanValue(m[2]);
        push("manufacturer", cap(m[1]), line, label);
        if (MODEL_RE.test(model) && /\d/.test(model)) push("model", model, line, label);
        return;
      }
      case "warranty_term": case "agreement_term": if (value.length <= 90) push(key, value, line, label); return;
      case "permit_number": if (/^[A-Za-z0-9][A-Za-z0-9-_/.]{3,30}$/.test(value) && /\d/.test(value)) push(key, value, line, label); return;
      case "invoice_number": if (/^[A-Za-z0-9][A-Za-z0-9-_/.]{0,29}$/.test(value)) push(key, value, line, label); return;
      default: return;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.t;
    const marks = findScanLabels(t);

    // Dispatch note: "Dispatch note - 12/13/2017" carries its date in the title.
    if (type === "dispatch-note" && !marks.length) {
      const tm = /^dispatch\s+(?:note|slip|ticket)\s*[-:–]\s*(.+)$/i.exec(t);
      if (tm) { const d = parseDate(cleanValue(tm[1])); if (d) push("service_date", d, line, "dispatch note title"); }
    }

    if (marks.length) {
      for (let k = 0; k < marks.length; k++) {
        const mk = marks[k];
        // A generic label qualified by the word in front of it is a DIFFERENT label: "Billing Address:", "Ship Date:",
        // "Mailing Address:" are not the service address/date. Only a generic label at the start of a cell counts.
        if ((mk.def.key === "ADDRESS" || mk.def.key === "DATE") && /[A-Za-z0-9#.]\s?$/.test(t.slice(k ? marks[k - 1].end : 0, mk.start)) && !/(?:\s{3,}|\t|\s\|\s)$/.test(t.slice(0, mk.start))) continue;
        let raw = t.slice(mk.end, k + 1 < marks.length ? marks[k + 1].start : t.length);
        // A column gap ends the value: "Date of Service: 10/19/2028      Page 1 of 1".
        raw = raw.split(/\s{3,}|\t+|\s\|\s/)[0];
        if (mk.def.kind === "block") {
          if (mk.def.key !== "BLOCK_WORK") continue;
          const inline = cleanValue(raw);
          if (inline) { if (inline.length <= 240) push("work_performed", inline, line, mk.label); continue; }
          for (let j = i + 1; j < lines.length; j++) {
            if (findScanLabels(lines[j].t).length) break;
            const b = /^(?:[-*•●▪]\s+|\[[xX ]?\]\s+|\d{1,2}[.)]\s+)(.+)$/.exec(lines[j].t);
            if (b) { const v = cleanValue(b[1]); if (v && v.length <= 240) push("work_performed", v, lines[j], mk.label); continue; }
            if (j === i + 1) { const v = cleanValue(lines[j].t); if (v && v.length <= 240) push("work_performed", v, lines[j], mk.label); }
            break;
          }
          continue;
        }
        if (!cleanValue(raw) && k === marks.length - 1 && i + 1 < lines.length && !findScanLabels(lines[i + 1].t).length) {
          // Label on one line, value on the next.
          raw = lines[i + 1].t.split(/\s{3,}|\t+|\s\|\s/)[0];
          accept(mk.def, raw, lines[i + 1], i + 1, mk.label);
          continue;
        }
        accept(mk.def, raw, line, i, mk.label);
      }
      continue;
    }

    const segs = splitCells(t);
    // Table header row: every cell is a bare label, and the next line has the same number of cells.
    if (segs.length >= 2 && i + 1 < lines.length) {
      const heads = segs.map((sg) => BARE_LABEL_RES.find((b) => b.re.test(collapse(sg).replace(/[:.]+$/, "")))?.def ?? null);
      if (heads.every(Boolean)) {
        const cells = splitCells(lines[i + 1].t);
        if (cells.length === segs.length) {
          heads.forEach((def, j) => { if (def.kind !== "block") accept(def, cells[j], lines[i + 1], i + 1, segs[j]); else if (def.key === "BLOCK_WORK" && cells[j].length <= 240) push("work_performed", cleanValue(cells[j]), lines[i + 1], segs[j]); });
          i++;
          continue;
        }
      }
    }
    // No-colon date label: "Date of Service 10/19/2028", "DOS - 10/19/28", or the label and the date in two cells
    // separated by a column gap ("Date Performed      10/19/2028").
    for (let j = 0; j < segs.length; j++) {
      const sg = segs[j];
      const bare = BARE_LABEL_RES.find((b) => DATE_KEYS_FOR_NOCOLON.includes(b.def.key) && b.re.test(collapse(sg)));
      if (bare && j + 1 < segs.length) {
        if (bare.def.key !== "OTHER_DATE") accept(bare.def, segs[j + 1], line, i, sg);
        j++;
        continue;
      }
      for (const { def, re } of NOCOLON_DATE_RES) {
        const m = re.exec(sg);
        if (!m) continue;
        if (def.key !== "OTHER_DATE") accept(def, m[2], line, i, m[1]);
        break;
      }
    }
  }

  // Cost: one printed total, or the highest-priority label's single value when several totals are printed.
  if (out.cost?.length) {
    const vals = [...new Set(out.cost.map((c) => c.value))];
    if (vals.length > 1) {
      for (const lbl of LABEL_PRIORITY_COST) {
        const hit = out.cost.filter((c) => c.label === lbl);
        if (!hit.length) continue;
        const hv = [...new Set(hit.map((c) => c.value))];
        out.cost = hv.length === 1 ? hit : out.cost;
        break;
      }
    }
  } else if (out.__balance?.length) {
    out.cost = out.__balance;
  }
  delete out.__balance;
  // An explicit service-date label anywhere outranks every bare "Date:".
  if (out.service_date?.some((c) => c.strength === "explicit")) out.service_date = out.service_date.filter((c) => c.strength === "explicit");
  return { order, candidates: out };
}
