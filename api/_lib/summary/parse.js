/**
 * Summary lane (round 2, B2) - PURE intent parser. No DB, no model.
 *
 * "rundown on X", "recap X", "give me the full picture on X", "what do we have on file for X", "brief me on X",
 * "tell me about our purchase orders", "sum up our invoicing for 2024", "big picture on our Trane equipment" ...
 *
 * Two tests, never a phrase list of whole questions:
 *   1. VERB FAMILY: the question carries a summary verb or noun (rundown, recap, overview, summary, picture, lay of the land,
 *      brief me, catch me up, what do we have/know, everything on, the whole history, status on, tell me about, describe,
 *      sum up, where do we stand, what's going on with, how has X been doing) that is followed by (or, for "X - the whole
 *      history", preceded by) a subject.
 *   2. SUBJECT: the rest of the sentence must be EXPLAINED completely as one subject - a document type (optionally with one
 *      period), all documents in a period, the customer base, an equipment brand, or a name (customer or technician, decided
 *      later against the records). A word nobody explains (a filter, a negation, a second subject, a number that is not a
 *      year) means the lane makes no claim at all.
 *
 * A subject that is a document-type noun is NEVER a name ("rundown on the work orders" is the work-order type, not a customer
 * called "Rundown On The").
 */
import { docTypeSynonymAlternation, docTypeFromWord, DOCTYPE_TRIGGER_WORDS, DOCUMENT_TYPE_SYNONYMS_ALL } from "../documentTypes.js";
import { resolveAnyTimeRange } from "../analytics.js";

export function summaryEnabled() {
  return process.env.DONOVAN_SUMMARY !== "0";
}

const DOC_ALT = docTypeSynonymAlternation();
const DOC_RE = new RegExp(`\\b(${DOC_ALT})\\b`, "gi");
const DOC_TRIGGER = new Set(DOCTYPE_TRIGGER_WORDS.map((w) => w.toLowerCase()));

// Words that carry no condition of their own once a subject has been found.
const NOISE = new Set((
  "the a an our my your their all of on for about with and file files filed history side picture story what we have has know got happened happening going " +
  "overall lately recently so far these days stand standing at it its is are been being doing performing performance to up situation side"
).split(/\s+/));

const GERUND_DOC = { invoicing: "invoice", billing: "invoice", quoting: "proposal-quote", permitting: "permit" };
const EQUIP_NOUN = /^(equipment|units?|systems?|installs?|installations?|machines?|gear)$/;
const CUSTOMER_BASE = /^(?:customers?|clients?|accounts?|customer base|client base|customer list|client list|customer book|customer file)$/;
const ALL_DOCS = /^(?:documents?|paperwork|paper work|docs?|records?|files?)$/;

const PERIOD_RE = new RegExp(
  "(?:\\b(?:in|for|during|from|of|over)\\s+)?(?:\\b(?:the\\s+)?(?:year\\s+)?(?:19|20)\\d\\d\\b|\\b(?:in\\s+|for\\s+|during\\s+|over\\s+)?(?:the\\s+)?(?:last|this|past|previous|prior)\\s+(?:year|month|quarter|week)\\b|\\b(?:year to date|ytd)\\b)",
  "i"
);

// Summary heads. Each captures the subject (group 1) that follows it. Tested on the lead-in-stripped, lowercased text.
const AFTER = [
  /\b(?:run\s?-?\s?down|re-?cap|overview|summary|synopsis|snapshot|digest|write-?up|round-?up|profile|dossier|bio|background|fact\s?sheet|wrap[\s-]?up)\b(?:\s+(?:of|on|for|about))?\s+(.+)$/,
  /\b(?:summari[sz]e|sum\s+up|sum-up)\b(?:\s+(?:of|on|for|about))?\s+(.+)$/,
  /\b(?:(?:full|whole|big|complete|entire|general|overall|total)\s+(?:picture|story)|lay\s+of\s+the\s+land|the\s+picture)\s*(?:on|of|for|about|with|around)?\s*(.+)$/,
  /\b(?:brief\s+me|catch\s+me\s+up|bring\s+me\s+up\s+to\s+speed|fill\s+me\s+in|update\s+me|walk\s+me\s+through|talk\s+me\s+through)\s*(?:on|about|with|for)?\s+(.+)$/,
  /\bwhat\s+(?:do|did|have|all\s+do)\s+(?:we|i|you)\s+(?:have|know|got|got\s+on\s+file|have\s+on\s+file)\b(?:\s+on\s+file)?\s*(?:on|for|about|regarding|re)\s+(.+)$/,
  /\b(?:pull\s+together|put\s+together|gather|compile|give\s+me)\s+(?:everything|all|what)\s+(?:we\s+)?(?:have|know|got)?\s*(?:on|about|for|regarding)?\s*(.+)$/,
  /\b(?:everything|all)\s+(?:we\s+(?:have|know|got)\s+)?(?:on|about|for|regarding)\s+(.+)$/,
  /\b(?:tell\s+me\s+about|describe|talk\s+about)\s+(.+)$/,
  /\bstatus\s+(?:on|of|for|with)\s+(.+)$/,
  /\bwhere\s+(?:are|do)\s+we\s+(?:at|stand)\s+(?:on|with|for)\s+(.+)$/,
  /\bwhat(?:'s|\s+is)\s+(?:going\s+on|happening|the\s+story)\s+(?:with|on|for)\s+(.+)$/,
  /\banything\s+(?:i|we)\s+(?:should|need\s+to|ought\s+to)\s+know\s+(?:about|on)\s+(.+)$/,
  /\bhow\s+(?:has|have|is|are)\s+(.+?)\s+(?:been\s+)?(?:performing|doing|going|looking)\b.*$/,
  /\bwhat\s+(?:does|do)\s+(.+?)\s+look\s+like\b.*$/,
  /\bwhat(?:'s|\s+is)\s+the\s+(?:deal|story|situation|scoop)\s+(?:with|on|for)\s+(.+)$/,
  /\brun\s+me\s+through\s+(.+)$/,
  /\b(?:characteri[sz]e|size\s+up)\s+(.+)$/,
  /\bwhat\s+(?:should|do|can|else\s+should)\s+(?:i|we)\s+(?:know|remember|be\s+aware)\s+(?:about|on|of)\s+(.+)$/,
  /\b(?:about|going|gonna|have|need|want)\s+to\s+(?:call|phone|ring|visit|meet|email|text|see|talk\s+to)\s+(.+?)[\s,;:-]+(?:so\s+)?(?:what|anything)\s+(?:should|do|can|else\s+should)\s+(?:i|we)\s+(?:know|remember|be\s+aware)(?:\s+(?:first|beforehand|going\s+in|about\s+(?:him|her|them|this\s+(?:one|customer|account))))?$/,
  /\bwhat\s+(?:has|have|had)\s+(.+?)\s+been\s+(?:up\s+to|working\s+on)\b(.*)$/,
  /\bwhere\s+(?:do|are)\s+(?:things|we)\s+(?:stand|at)\s+(?:with|on|for)\s+(.+)$/,
  /\bhow\s+(?:did|was|were)\s+(.+?)\s+look\b(?:\s+(?:on|for|with|in))?\s*(.*)$/,
  /\b(?:(?:full|whole|complete|entire)\s+(?:history|file|record)|history)\s+(?:of|on|for|with)\s+(.+)$/,
  /\bwhat(?:'s|\s+is)\s+(?:our|the)\s+history\s+(?:with|on|for)\s+(.+)$/,
];
// "X - the whole history please": the subject comes first.
const BEFORE = [
  /^(.+?)\s*[-–—,:]+\s*(?:the\s+)?(?:whole|full|complete|entire)\s+(?:history|story|picture|rundown|file)\b.*$/,
  /^(.+?)\s*[-–—,:]+\s*(?:so\s+)?(?:where\s+(?:do|are)\s+(?:things|we)\s+(?:stand|at)|what(?:'s|\s+is)\s+the\s+(?:story|situation|status|deal|scoop)|how(?:'s|\s+is)\s+(?:it|everything|things)\s+(?:going|looking|standing))\b.*$/,
  /^(?:what(?:'s|\s+is)\s+)?(.+?)(?:'s|')\s+(?:history|story|profile|dossier|background|standing|situation)\s+with\s+(?:us|me|you|our\s+(?:company|shop|business|firm|team))$/,
];

const LEAD = [
  /^(?:(?:hey|hi|ok|okay|so|um|uh|well|yo|actually|alright|oh)\b[\s,;:.-]*)+/,
  /^(?:please|pls)\b[\s,;:.-]*/,
  /^(?:(?:i|we)\s+(?:need|want|would\s+like|'d\s+like|d\s+like)|(?:can|could|would|will)\s+(?:you|u)(?:\s+please)?|let'?s\s+(?:see|get)|give\s+me|get\s+me|show\s+me|pull\s+up|i'?d\s+like)\s+(?:to\s+|a\s+|an\s+|the\s+|some\s+)?/,
];
const TAIL = /\s*(?:\b(?:please|pls|for me|right now|real quick|quickly|before\s+(?:i|we)\b.*|so\s+i\b.*|today|thanks|thx|if you can|would be great)\b)\s*$/;

function clean(question) {
  return String(question ?? "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[?!.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLead(s) {
  let prev;
  do {
    prev = s;
    for (const re of LEAD) s = s.replace(re, "").trim();
  } while (s !== prev);
  return s;
}

function stripTail(s) {
  let prev;
  do { prev = s; s = s.replace(TAIL, "").trim(); } while (s !== prev);
  return s;
}

/** Remove one period phrase from the subject and resolve it to a date range. Returns {text, period} or {text} (no period) or null (an unresolvable date phrase). */
function takePeriod(s, today) {
  const m = PERIOD_RE.exec(s);
  if (!m) return { text: s, period: null };
  let range = null;
  let phrase = m[0].replace(/^(?:of|over)\s+/, "in ").trim();
  const yr = /\b((?:19|20)\d\d)\b/.exec(phrase);
  if (yr && !/^(?:in|for|during|from)\b/i.test(phrase) && !/\b(?:last|this|past|previous|prior)\b/i.test(phrase)) phrase = `in ${yr[1]}`;
  try { range = resolveAnyTimeRange(phrase, today); } catch { range = null; }
  if (!range?.from || !range?.to) return null;
  const pad = (v, end) => {
    const x = String(v).slice(0, 10);
    if (/^\d{4}$/.test(x)) return end ? `${x}-12-31` : `${x}-01-01`;
    if (/^\d{4}-\d{2}$/.test(x)) return end ? new Date(Date.UTC(+x.slice(0, 4), +x.slice(5), 0)).toISOString().slice(0, 10) : `${x}-01`;
    return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
  };
  const from = pad(range.from, false), to = pad(range.to, true);
  if (!from || !to) return null;
  const text = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { text, period: { from, to, label: range.label ?? m[0].trim() } };
}

const PREFIX_OK = new Set("i'm we're im quick short brief little fast what whats what's how hows how's is are do does did can could would will you me i we us give get show pull tell just anything hey please pls and then so".split(" "));
function prefixOk(prefix) {
  return prefix.split(/[^a-z0-9']+/).filter(Boolean).every((t) => PREFIX_OK.has(t) || NOISE.has(t));
}

function residualOk(text) {
  const toks = text.split(/[^a-z0-9']+/).filter(Boolean);
  return toks.every((t) => NOISE.has(t));
}

function stripNoise(text) {
  return text.split(" ").filter((t) => t && !NOISE.has(t)).join(" ");
}

/**
 * @returns {null | {kind: 'docType'|'allDocs'|'customers'|'brandOrName'|'name', ...}}
 *   docType:   { docType, period }       allDocs: { period }        customers: {}
 *   brand:     { kind: 'brand', phrase }  (verified against the records later)
 *   name:      { kind: 'name', phrase, personVerb } (customer or technician, decided against the records later)
 */
export function parseSummaryQuestion(question, { today } = {}) {
  if (!summaryEnabled()) return null;
  const raw = String(question ?? "");
  if (!raw.trim() || raw.length > 160) return null;
  let s = stripLead(clean(raw));
  if (!s) return null;

  let subject = null;
  let personVerb = false;
  let upTo = false;
  for (const re of BEFORE) {
    const m = re.exec(s);
    if (m) { subject = m[1]; break; }
  }
  if (!subject) {
    // The earliest summary head wins so "tell me about the recap" style leftovers do not re-open the sentence.
    let best = null;
    for (const re of AFTER) {
      const m = re.exec(s);
      // whatever stands before the head must be spoken filler; "warranty status on X" or "how do I mute the daily digest" are other questions
      if (m && (!best || m.index < best.index) && prefixOk(s.slice(0, m.index))) best = { index: m.index, subject: m.slice(1).filter(Boolean).join(" "), re };
    }
    if (best) {
      subject = best.subject;
      upTo = best.re.source.includes("been\\s+(?:up\\s+to");
      personVerb = upTo || best.re.source.includes("performing|doing");
    }
  }
  if (!subject) return null;
  // "what we know about X" nested inside a head: peel the nested head once more ("pull together what we know about X").
  for (let i = 0; i < 2; i++) {
    const nested = /^(?:(?:what|everything|all)\s+(?:we|i)\s+(?:know|have|got)(?:\s+on\s+file)?\s*(?:on|about|for|regarding)\s+)(.+)$/.exec(subject);
    if (nested) subject = nested[1];
  }
  subject = stripTail(stripLead(subject.trim()));
  subject = subject.replace(/[\s.,;:!?-]+$/g, "").replace(/^[\s,;:-]+/g, "");
  if (!subject || subject.length > 90) return null;

  // an exclusion or a restriction is a condition this lane does not apply ("everything except Trane", "only the open ones")
  if (/\b(?:except|excluding|exclude|other than|without|besides|aside from|apart from|but not|not|never|only|just|minus)\b/.test(subject)) return null;
  // possessive account/file words: "stephanie osborn's account"
  subject = subject.replace(/'s\s+(?:account|file|history|record|records|jobs?|work|paperwork|folder|page)\b/g, "").replace(/(\S)\s+(?:account|file|folder|page)$/, "$1").replace(/\s+/g, " ").trim();
  // a number other than a year, or a symbol, is not a summary subject (invoice 123, $500, #4)
  const withoutYears = subject.replace(/\b(?:19|20)\d\d\b/g, " ");
  if (/[\d$#%@]/.test(withoutYears)) return null;

  const per = takePeriod(subject, today);
  if (!per) return null;
  const period = per.period;
  let rest = per.text;

  // document type (longest synonym phrase first); its plural/singular and gerund forms
  let docType = null;
  const gerund = Object.keys(GERUND_DOC).find((g) => new RegExp(`\\b${g}\\b`).test(rest));
  if (gerund) { docType = GERUND_DOC[gerund]; rest = rest.replace(new RegExp(`\\b${gerund}\\b`), " ").replace(/\s+/g, " ").trim(); }
  const types = new Set();
  rest = rest.replace(DOC_RE, (_m, w) => { const id = docTypeFromWord(w); if (id) types.add(id); return " "; }).replace(/\s+/g, " ").trim();
  if (docType) types.add(docType);
  if (types.size > 1) return null; // two subjects: the lane answers one
  if (types.size === 1) {
    if (!residualOk(rest)) return null; // an unexplained condition ("open", "from acme", "over 500")
    return { kind: "docType", docType: [...types][0], period };
  }

  const stripped = stripNoise(rest);
  if (!stripped) {
    // nothing but a period or filler: all documents in the period (a bare "2023" or "what happened in 2023")
    if (period) return { kind: "allDocs", period };
    return null;
  }
  if (ALL_DOCS.test(stripped)) return { kind: "allDocs", period };
  if (CUSTOMER_BASE.test(stripped) || /^(?:customers?|clients?)\s+(?:base|list|book)$/.test(stripped)) {
    if (period) return null;
    return { kind: "customers" };
  }
  if (period) return null; // a name or brand with a period: the lane does not apply periods to them

  // equipment brand: "<brand> equipment|units|systems"
  const toks = stripped.replace(/\b(equipment|units?|systems?)\s+(?:base|fleet)$/, "$1").split(" ");
  if (toks.length >= 2 && toks.length <= 3 && EQUIP_NOUN.test(toks[toks.length - 1]) && toks.slice(0, -1).every((t) => /^[a-z][a-z&.-]*$/.test(t))) {
    return { kind: "brand", phrase: toks.slice(0, -1).join(" ") };
  }

  // a name: 1-4 plain tokens. A document-type trigger word inside it is a document-type phrase we did not understand, not a name.
  while (toks.length > 1 && /^(?:customer|client|account|contact)$/.test(toks[0])) toks.shift();
  if (toks.length > 4) return null;
  if (!toks.every((t) => /^[a-z][a-z.'&-]*$/.test(t))) return null;
  if (toks.some((t) => DOC_TRIGGER.has(t))) return null;
  // "the Rios job", "the Bracken install": a job or a place, not the customer; the other lanes read those
  if (toks.length > 1 && /^(?:jobs?|sites?|houses?|places?|installs?|installation|visits?|projects?|calls?|appointments?|property|properties|location)$/.test(toks[toks.length - 1])) return null;
  // generic words that can never be somebody's name on their own
  if (toks.some((t) => /^(?:everything|anything|nothing)$/.test(t))) return null;
  if (toks.length === 1 && /^(?:everything|anything|things?|stuff|business|company|shop|us|it|them|him|her|that|this|today|work|jobs?|status|customers?)$/.test(toks[0])) return null;
  return { kind: "name", phrase: toks.join(" "), personVerb, ...(upTo ? { upTo: true } : {}) };
}

/**
 * The one spelling of a summary question this lane reads back unchanged ("what do we have on file for <subject>", or "how has <name> been performing").
 * classifyAll hands it on as the effective question: the older records-first lane (which is not part of this lane) answers "rundown / recap / overview"
 * wording with only the last job, and it reads nothing in this spelling, so the summary lane is the one that answers. Built from the parsed intent
 * (never from the raw text), and only used when it parses back to the same intent.
 */
export function canonicalSummaryQuestion(intent, question, { today } = {}) {
  // Only a name needs it: the records-first lane reads "<summary word> <customer>". Document-type, period, brand and customer-base subjects stay as typed.
  if (!intent || intent.kind !== "name") return null;
  const orig = String(question ?? "");
  const low = orig.toLowerCase().replace(/[‘’`]/g, "'");
  const casedName = (phrase) => {
    const i = low.indexOf(phrase);
    return i >= 0 && orig.length === low.length ? orig.slice(i, i + phrase.length) : phrase;
  };
  const periodText = intent.period ? ` ${/^(?:in|during|for|from|since|between)\b/i.test(intent.period.label) ? intent.period.label : `in ${intent.period.label}`}` : "";
  let canon;
  if (intent.kind === "name") canon = intent.upTo ? `what has ${casedName(intent.phrase)} been up to` : intent.personVerb ? `how has ${casedName(intent.phrase)} been performing` : `what do we have on file for ${casedName(intent.phrase)}`;
  else if (intent.kind === "docType") canon = `what do we have on file for ${(DOC_PLURAL[intent.docType] ?? intent.docType.replace(/-/g, " ") + "s")}${periodText}`;
  else if (intent.kind === "allDocs") canon = `what do we have on file for documents${periodText}`;
  else if (intent.kind === "customers") canon = "what do we have on file for customers";
  else if (intent.kind === "brand") canon = `what do we have on file for ${casedName(intent.phrase)} equipment`;
  if (!canon) return null;
  const back = parseSummaryQuestion(canon, { today });
  return back && JSON.stringify(back) === JSON.stringify(intent) ? canon : null;
}

const DOC_PLURAL = Object.fromEntries(Object.entries(DOCUMENT_TYPE_SYNONYMS_ALL).map(([id, w]) => [id, w[1] ?? `${w[0]}s`]));
