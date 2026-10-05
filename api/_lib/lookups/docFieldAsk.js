/**
 * Defect 19/21: questions that ask for ONE printed field of ONE kind of document ("which city issued Deborah Ortega's permit",
 * "what's the status on permit BP-2026-10023", "which vendor was PO-9081 from", "when was Amy Isaacson's warranty registered",
 * "agreement period for Ronald Bracken", "who did the startup for Linda Fitzgerald", "when did we invoice Karen Abernathy",
 * "pull up the nameplate for Matthew Winslow", "how many documents are on file for Ronald Bracken").
 *
 * Pure parse (no DB): {docField: {doctype, field}, namePhrase | docNumber}. The document's own page text is the source of the
 * answer (extractField), so the answer is the printed value, never a computed or neighbouring field.
 */

const lineOf = (text, key) => {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im").exec(String(text ?? ""));
  return m ? m[1].trim() : null;
};
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Field extractors: page text -> {value, extra?} or null. */
const EXTRACTORS = {
  "permit.city": (t) => {
    const m = /CITY\s+OF\s+([A-Za-z][A-Za-z .'-]*?)\s*(?:,|$)/im.exec(t);
    return m ? { value: titleCase(m[1].trim()) } : null;
  },
  "permit.status": (t) => { const v = lineOf(t, "Status"); return v ? { value: v } : null; },
  // D19: the permit asks for a date / fee / contractor must read THAT printed line, or say plainly it is not printed - never the status.
  "permit.issued": (t) => { const v = lineOf(t, "(?:Date\\s+Issued|Issue\\s+Date|Issued(?:\\s+On)?|Date)"); return v ? { value: v } : null; },
  "permit.expires": (t) => { const v = lineOf(t, "(?:Expir\\w*(?:\\s+Date)?|Valid\\s+(?:Until|Through))"); return v ? { value: v } : null; },
  "permit.inspection": (t) => { const v = lineOf(t, "(?:Inspection(?:\\s+Date)?|Inspected(?:\\s+On)?)"); return v ? { value: v } : null; },
  "permit.fee": (t) => { const v = lineOf(t, "(?:Permit\\s+)?(?:Fees?|Cost|Amount)"); return v ? { value: v } : null; },
  "permit.contractor": (t) => { const v = lineOf(t, "(?:Contractor|Applicant)"); return v ? { value: v } : null; },
  "permit.scope": (t) => { const v = lineOf(t, "Scope\\s+of\\s+Work"); return v ? { value: v } : null; },
  "purchase-order.vendor": (t) => { const v = lineOf(t, "Vendor"); return v ? { value: v } : null; },
  "purchase-order.parts": (t) => {
    const lines = String(t ?? "").split(/\r?\n/);
    const at = lines.findIndex((l) => /^\s*parts\s*:/i.test(l));
    if (at < 0) return null;
    const out = [];
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (/^[-*•]/.test(l)) out.push(l.replace(/^[-*•]\s*/, "").toLowerCase());
      else break;
    }
    return out.length ? { value: out.join(", ") } : null;
  },
  "warranty-registration.registered": (t) => {
    const v = lineOf(t, "Registered on file");
    if (!v) return null;
    const term = lineOf(t, "Warranty Term");
    return { value: v, extra: term ? `Warranty term on the registration: ${term}.` : "" };
  },
  "warranty-registration.term": (t) => {
    const v = lineOf(t, "Warranty Term");
    if (!v) return null;
    const valid = lineOf(t, "Valid through");
    return { value: v, extra: valid ? `Valid through: ${valid}.` : "" };
  },
  "permit.exists": (t) => { const v = lineOf(t, "Permit No"); return v ? { value: v } : null; },
  "maintenance-agreement.exists": (t) => { const v = lineOf(t, "Agreement Period"); return v ? { value: `agreement period ${v}` } : null; },
  "maintenance-agreement.coverage": (t) => { const v = lineOf(t, "Coverage"); return v ? { value: v } : null; },
  "maintenance-agreement.units": (t) => {
    const lines = String(t ?? "").split(/\r?\n/).map((l) => l.trim());
    const at = lines.findIndex((l) => /^units\s+covered\s*:/i.test(l));
    if (at < 0) return null;
    const out = [];
    for (let i = at + 1; i < lines.length && lines[i] && !/^annual\s+cost/i.test(lines[i]); i++) out.push(lines[i].replace(/^(?:unit\s*)?[\w-]+\s*\d*\s*:\s*/i, ""));
    return out.length ? { value: `${out.length} unit${out.length === 1 ? "" : "s"}: ${out.join("; ")}` } : null;
  },
  "dispatch-note.note": (t) => {
    const lines = String(t ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const body = lines.filter((l, i) => i > 0 && !/^(?:customer|address)\s*:/i.test(l) && !/^(?:sonoran|4410|\(\d{3}\))/i.test(l) && !/^tech\s*:/i.test(l));
    const tech = lineOf(t, "Tech");
    const date = /^dispatch\s+note\s*-\s*(.+)$/i.exec(lines[0] ?? "")?.[1];
    return body.length ? { value: `${body.join(" ")}${tech ? ` (tech: ${tech})` : ""}${date ? `, dated ${date}` : ""}` } : null;
  },
  "correspondence.exists": (t) => {
    const lines = String(t ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const re = lines.find((l) => /^re\s*:/i.test(l));
    const date = lines.find((l) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l));
    return re || date ? { value: `${date ?? "undated"}${re ? ` - ${re.replace(/\s*-\s*Cell:.*$/i, "")}` : ""}` } : null;
  },
  "startup-sheet.technician": (t) => { const v = lineOf(t, "Technician"); return v ? { value: v } : null; },
  "invoice.date": (t) => { const v = lineOf(t, "Date"); return v ? { value: v } : null; },
  "maintenance-agreement.period": (t) => {
    const v = lineOf(t, "Agreement Period");
    if (!v) return null;
    const cost = lineOf(t, "Annual Cost");
    return { value: v, extra: cost ? `Annual cost: ${cost}.` : "" };
  },
  "nameplate-photo.plate": (t) => {
    const keep = String(t ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(?:manufacturer|model|serial|refrig|capacity|voltage|mfg)/i.test(l));
    return keep.length ? { value: keep.map((l) => l.replace(/\s*:\s*/, ": ")).join("; ") } : null;
  },
};

const PERMIT_DOC = /\bpermit\b/i;
const PO_DOC = /\b(?:po|p\.o\.|purchase\s+order)\b/i;
const STARTUP_DOC = /\b(?:start\s*-?\s*up|commissioning)\b/i;
const PLATE_DOC = /\b(?:name\s*plate|data\s*plate|rating\s*plate)\b/i;

/** Spec table: the question must match `doc` and `ask`; first match wins. `numberRe` finds a document number token. */
const SPECS = [
  { doctype: "permit", field: "city", doc: PERMIT_DOC, ask: /\bcity\b/i, excl: /\b(?:when|what\s+(?:date|day)|which\s+(?:date|day)|expir\w*|fee|inspect\w*)\b/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "issued", doc: PERMIT_DOC, ask: /\b(?:when|what\s+(?:date|day)|which\s+(?:date|day))\b[^?]*\b(?:issu\w+|approved|granted|pulled)\b|\bissue\s+date\b|\bdate\s+(?:of\s+)?issu\w+|\bissued\s+(?:on|date)\b|\bdate\b[^?]*\bissued\b/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "expires", doc: PERMIT_DOC, ask: /\bexpir\w*|\bvalid\s+(?:until|through|till)\b|\bgood\s+(?:until|through)\b/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "inspection", doc: PERMIT_DOC, ask: /\binspect\w*\b[^?]*\b(?:date|when|scheduled)\b|\b(?:when|what\s+date)\b[^?]*\binspect/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "fee", doc: PERMIT_DOC, ask: /\b(?:fees?|cost|price|charge[ds]?)\b|\bhow\s+much\b/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "contractor", doc: PERMIT_DOC, ask: /\b(?:contractor|applicant|applied|who\s+(?:pulled|filed|took\s+out))\b/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "scope", doc: PERMIT_DOC, ask: /\bscope\b|\bwhat\s+(?:work|job)\b/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "permit", field: "status", doc: PERMIT_DOC, ask: /\bstatus\b|\b(?:is|was|been|got|get|has)\b[^?]*\b(?:issued|approved|finaled|passed|closed|pending)\b|\bissued\s*$/i, numberRe: /\bBP-\d[\w-]*/i },
  { doctype: "purchase-order", field: "vendor", doc: PO_DOC, ask: /\b(?:vendor|supplier|ordered\s+from|order(?:ed)?\s+(?:it\s+)?from|from\s+(?:who|which)|who\s+(?:did\s+we\s+)?(?:order|buy|get)|what\s+(?:company|distributor)|which\s+(?:company|distributor))\b|\b(?:from|with)\s*$/i, numberRe: /\bPO-\d[\w-]*/i },
  { doctype: "purchase-order", field: "parts", doc: PO_DOC, ask: /\b(?:parts?|items?|materials?|listed|what\s+(?:did\s+we\s+)?order(?:ed)?|what\s+was\s+ordered)\b/i, numberRe: /\bPO-\d[\w-]*/i },
  { doctype: "warranty-registration", field: "registered", doc: /\bwarranty\b/i, ask: /\bregist(?:er|ered|ration|ering)\b/i },
  { doctype: "warranty-registration", field: "term", doc: /\bwarranty\b/i, ask: /\bwarranty\s+(?:term|length|period|duration|coverage)\b|\bhow\s+long\s+is\b[^?]*\bwarranty\b|\bterm\b/i },
  { doctype: "startup-sheet", field: "technician", doc: STARTUP_DOC, ask: /\bwho\b|\b(?:tech(?:nician)?|by)\b/i },
  { doctype: "invoice", field: "date", excl: /\b(?:due|paid|pay|payment|overdue|owed?|balance|total|amount|cost|price|number|expire|net\s*\d+)\b/i, doc: /\binvoice/i, ask: /\bwhen\b[^?]*\binvoic(?:e|ed)\b|\bwhat\s+date\b[^?]*\binvoiced\b|\binvoice\s+date\b|\bdate\s+(?:of|on)\s+(?:the\s+)?invoice\b/i },
  { doctype: "maintenance-agreement", field: "period", doc: /\b(?:agreement|contract)\b/i, ask: /\b(?:agreement|contract)\s+(?:period|dates)\b|\b(?:period|dates)\s+(?:of|for|on)\s+(?:the\s+|his\s+|her\s+)?(?:maintenance\s+)?(?:agreement|contract)\b/i },
  { doctype: "maintenance-agreement", field: "units", doc: /\b(?:agreement|contract)\b/i, ask: /\bunits?\b[^?]*\b(?:cover(?:ed|s)?|under)\b|\b(?:agreement|contract)\b[^?]*\bcovers?\b[^?]*\bunits?\b|\bhow\s+many\s+units\b/i },
  { doctype: "maintenance-agreement", field: "coverage", doc: /\b(?:agreement|contract)\b/i, ask: /\bwhat'?s\s+(?:included|covered)\b|\bwhat\s+(?:is|does)\b[^?]*\b(?:included|cover|covered|coverage)\b|\bcoverage\b/i },
  { doctype: "dispatch-note", field: "note", doc: /\bdispatch\s+notes?\b/i, ask: /\b(?:say|says|said|read|reads|about|what)\b|(?<!dispatch\s)\bnotes?\b/i },
  { doctype: "correspondence", field: "exists", doc: /\bcorrespondence\b/i, ask: /^(?:any|is\s+there|are\s+there|do\s+we\s+have|does|did|show|list|pull)\b/i },
  { doctype: "nameplate-photo", field: "plate", doc: PLATE_DOC, ask: PLATE_DOC },
  // existence of one kind of document for one customer: "does X have a permit on file", "is X on a maintenance agreement"
  { doctype: "permit", field: "exists", doc: PERMIT_DOC, ask: /^(?:does|did|do|has|have|is\s+there|are\s+there|was\s+there)\b[^?]*\bpermit\b|\bpermit\b[^?]*\bon\s+file\b/i },
  { doctype: "maintenance-agreement", field: "exists", doc: /\b(?:agreement|contract|plan)\b/i, ask: /^(?:is|are|was)\b[^?]*\bon\s+(?:a|an|the)\s+(?:maintenance\s+)?(?:agreement|contract|plan)\b|^(?:does|do|did)\b[^?]*\bhave\b[^?]*\b(?:maintenance\s+)?(?:agreement|contract)\b/i },
];

const NAME_SRC = "[A-Za-z0-9][A-Za-z0-9'.&\\u2019-]*(?:\\s+[A-Za-z0-9'.&\\u2019-]+){0,4}?";
const NAME_RES = [
  new RegExp(`\\b(?:under|does|for|of|on)\\s+(?:the\\s+)?(${NAME_SRC})\\s+(?:maintenance\\s+)?(?:agreement|contract)\\b`, "i"),
  new RegExp(`\\b(?:for|on|of|about|with|at)\\s+(?:the\\s+)?(${NAME_SRC})\\s*$`, "i"),
  new RegExp(`(?:^|\\s)(${NAME_SRC})['\\u2019]s\\s+(?:\\w+\\s+){0,3}?(?:warranty|permit|agreement|contract|start\\s*-?\\s*up|name\\s*plate|data\\s*plate|invoice|unit|system)\\b`, "i"),
  new RegExp(`\\b(?:does|did|do|is|are|was|has|have|will)\\s+(?:the\\s+)?(${NAME_SRC})\\s+(?:have|register|registered|get|got|on\\s+(?:a|an|the)|invoiced|billed|had|paid)\\b`, "i"),
];
const FILLER_RE = /^(?:(?:included|in|covered|covers|cover|under|for|on|of|about|with|at|to|what|whats|what's|whos|who's|which|is|are|was|were|the|a|an|give|me|tell|get|pull|up|find|need|want|show|can|you|i|do|does|did|we|have|our|their|his|her|date|when|who|how|many|city|status|term|period|start|startup|permit|warranty|agreement|contract|invoice|nameplate|plate|data|registration|registered|issued)\s+)+/i;
const BAD_FIRST = /^(?:actually|really|still|currently|already|even|only|ever|just|not|never|real|actual|dated|issued|date|me|myself|ones?|one|invoiced|billed|the|a|an|this|that|these|those|our|my|their|his|her|every|each|all|any|which|what|who|when|how|there|it|them|us|we|you|file|account|job)$/i;
const NOT_A_NAME = /^(?:permit|warranty|agreement|contract|invoice|startup|nameplate|unit|system|documents?|file|account|plan)s?$/i;

function cleanName(raw) {
  let n = String(raw ?? "").trim();
  for (let i = 0; i < 4; i++) { const next = n.replace(FILLER_RE, "").trim(); if (next === n) break; n = next; }
  n = n.replace(/['’]s(?:\s+\w+){0,3}$/i, "").replace(/[?.!,]+$/g, "").trim();
  n = n.replace(/\s+(?:on\s+file|on\s+record|please|pls|today|with|from|by|say|says|said|read|reads|include|included|cover|covers|expire|expires|expired|expiring|issued|issue|renew|renews|end|ends|ending|start|starts|begin|begins|registered|register)$/i, "").trim();
  if (!n || n.length < 3 || BAD_FIRST.test(n.split(/\s+/)[0]) || NOT_A_NAME.test(n)) return null;
  return n;
}

const DOC_WORD_IN_NAME = /\b(?:maintenance|agreement|contract|warranty|permit|invoice|startup|nameplate|plate|documents?|files?|unit|system|equipment)\b/i;
function validName(raw) {
  const n = cleanName(raw);
  return n && !DOC_WORD_IN_NAME.test(n) ? n : null;
}

function findName(text) {
  // possessive / verb shapes first (they name the customer explicitly), then the trailing "for/on/of NAME" shape, trying the LAST preposition first
  for (const re of [NAME_RES[3], NAME_RES[2], NAME_RES[0]]) {
    const m = re.exec(text);
    const n = m && validName(m[1]);
    if (n) return n;
  }
  const preps = [...text.matchAll(/\b(?:for|on|of|about|with|at)\s+/gi)];
  for (let i = preps.length - 1; i >= 0; i--) {
    const tail = text.slice(preps[i].index + preps[i][0].length).replace(/^the\s+/i, "");
    if (!new RegExp(`^${NAME_SRC}\\s*$`, "i").test(tail)) continue;
    const n = validName(tail);
    if (n) return n;
  }
  const tailVerb = new RegExp(`\\b(?:invoice|invoiced|bill|billed)\\s+(${NAME_SRC})\\s*$`, "i").exec(text);
  return tailVerb ? validName(tailVerb[1]) : null;
}

const COUNT_RE = /\b(?:how\s+many|number\s+of|count\s+of)\s+(?:documents?|docs?|files?|records?|pieces\s+of\s+paperwork|paperwork)\b/i;
const COUNT_EXCLUDE_RE = /\b(?:classified|instead|real\s+type|categor(?:y|ies)|all\s+customers|every|each|per\s+|by\s+type|of\s+each|total\s+documents|in\s+the\s+system|do\s+we\s+have\s*$|are\s+there\s*$)/i;

/** @returns {{docField:{doctype:string|null, field:string}, namePhrase:string|null, docNumber?:string, isAddress:boolean}|null} */
export function parseDocFieldAsk(raw) {
  const text = String(raw ?? "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;

  // shop-wide extremes ("the oldest invoice we have dated", "latest invoice issued") are aggregates, not one customer's document
  if (/\b(?:oldest|newest|latest|earliest|most\s+recent|biggest|largest|smallest|highest|lowest|cheapest|top|all\s+(?:of\s+)?(?:our|the))\b/i.test(text)) return null;

  if (COUNT_RE.test(text) && !COUNT_EXCLUDE_RE.test(text)) {
    const name = findName(text);
    if (name && !/^\d/.test(name)) return { docField: { doctype: null, field: "count" }, namePhrase: name, isAddress: false };
    return null;
  }

  for (const spec of SPECS) {
    if (!spec.doc.test(text) || !spec.ask.test(text) || (spec.excl && spec.excl.test(text))) continue;
    const num = spec.numberRe ? spec.numberRe.exec(text) : null;
    if (num) return { docField: { doctype: spec.doctype, field: spec.field }, docNumber: num[0].toUpperCase(), namePhrase: null, isAddress: false };
    const name = findName(text);
    if (!name || /^[A-Z]{2,4}-\d/i.test(name)) continue;
    // a surname alone may name several customers: existence asks keep their older, per-customer handling
    if (spec.field === "exists" && name.split(/\s+/).length < 2) continue;
    return { docField: { doctype: spec.doctype, field: spec.field }, namePhrase: name, isAddress: /^\d/.test(name) };
  }
  return null;
}

export function extractField(doctype, field, pageText) {
  const fn = EXTRACTORS[`${doctype}.${field}`];
  return fn ? fn(pageText) : null;
}
