/**
 * RECORDS-FIRST question reader. Pure (no database): turns a question into
 *   { facts: [fact ids], summary, docNumbers, serialCandidates, address, order, all, window, stepAside }
 * Wording must not matter: the question is lower-cased, punctuation and possessives are removed, polite wrappers ("can you tell me ... please", "pls")
 * are just words that match nothing, common misspellings of the fact words are repaired, and the name is found later by comparing WORDS with the
 * customers on file (never by capital letters). The fact words come ONLY from directory.js.
 */
import { PHRASES, PARAPHRASES, factById } from "./directory.js";
import { withinOne } from "../lookups/nameMatch.js";

const MISSPELL = Object.freeze({
  labour: "labor", labr: "labor", lavor: "labor", technican: "technician", technicain: "technician", tecnician: "technician", techician: "technician", techinician: "technician", techncian: "technician",
  invoce: "invoice", invioce: "invoice", inovice: "invoice", invoic: "invoice", seriel: "serial", serail: "serial", refridgerant: "refrigerant", refrigerent: "refrigerant", refrigerat: "refrigerant",
  warrenty: "warranty", warrantee: "warranty", warrantly: "warranty", tonage: "tonnage", tonnge: "tonnage", instaled: "installed", intalled: "installed", installd: "installed", permitt: "permit", premit: "permit",
  subtotl: "subtotal", sutotal: "subtotal", manufacter: "manufacturer", manufactuer: "manufacturer", manufaturer: "manufacturer", equipement: "equipment", equiptment: "equipment", equipmnet: "equipment",
  adress: "address", addres: "address", phne: "phone", telphone: "telephone", emial: "email", emai: "email", discription: "description", descripton: "description", sumary: "summary", summery: "summary",
  sumarize: "summarize", summarise: "summarize", sumerize: "summarize", notse: "notes", workperformed: "work performed", hrs: "hours", hr: "hours", pls: "please", plz: "please", plse: "please",
});

const SPOKEN_PREFIX = /^(?:(?:hey|hi|hello|ok|okay|so|yo)\s+)?(?:donovan\s+)?/;

/** lower case, no possessives, no punctuation other than # - / . $ inside tokens; multiple spaces collapsed */
export function normalizeText(q) {
  let s = String(q ?? "").normalize("NFKC").toLowerCase();
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  s = s.replace(/\b(?:don['’]?t|do not|dont|never mind|not the|no not)\b[^,;.]*[,;]\s*/, ""); // "don't tell me the phone, tell me the email": the part that says what is NOT wanted is dropped
  s = s.replace(/[’`´‘]/g, "'").replace(/\b([a-z]+)'(?:d|ll|ve|re|m)\b/g, "$1").replace(/'s\b/g, "").replace(/s'(?=\s|$)/g, "s").replace(/'/g, "");
  s = s.replace(/[^a-z0-9#$\-/.\s]/g, " ");
  s = s.replace(/(?<![a-z0-9])\.+|\.+(?![a-z0-9])/g, " "); // sentence dots, not the dot in 3.5 or s.n.
  s = s.replace(/\s+/g, " ").trim().replace(SPOKEN_PREFIX, "").trim();
  // short forms and typos of words the directory knows (kept tiny and exact: each is a whole word)
  s = s.replace(/\bwa[ht]\b/g, "what").replace(/\bwhos\b/g, "who is").replace(/\bhrs?\b/g, "hours").replace(/\bamt\b/g, "amount").replace(/\b(?:tecni[a-z]*|techni[a-z]*tion|techician|technican|tecnician)\b/g, "technician").replace(/\bman[- ]?hours?\b/g, "labor hours").replace(/\blabou?r hours hours\b/g, "labor hours");
  s = s.replace(/\bhow many (?=labor hours)/g, "");
  s = s.replace(/\b(?:had been|has been|will be|would be|is being|gets|got|get) done\b/g, "was done");
  for (const [re, to] of PARAPHRASES) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}
const WORD_RE = /[a-z0-9#$][a-z0-9#$\-/.]*/g;
export function tokensOf(text) { return (String(text).match(WORD_RE) ?? []).map((t) => t.replace(/^[-/.]+|[-/.]+$/g, "")).filter(Boolean); }

const STOP = new Set(("a an the of for to from on at in by with and or but is are was were be been being do does did done has have had can could would will should may might shall me my us our we you your i it its this that these those there here "
  + "please pls tell show give get find look lookup pull up what whats which who whos whom whose when whens where wheres how why any some about as if so then than also just only still yet again out into over under per via "
  + "need want know see check let hey hi hello ok okay donovan thanks thank tell me can you could you").split(/\s+/));

const VOCAB7 = [...new Set(PHRASES.flatMap(([p]) => p.split(" ")).filter((w) => w.length >= 7 && /^[a-z]+$/.test(w)))];
const VOCAB7_SET = new Set(VOCAB7);
/** a one-letter slip in a long fact word ("nistalled", "refrigirant") is read as the word; short words and names are never touched */
function repairWord(t) {
  if (t.length < 7 || !/^[a-z]+$/.test(t) || VOCAB7_SET.has(t)) return t;
  const hit = VOCAB7.find((w) => withinOne(t, w));
  return hit ?? t;
}

/** the fact words, found from directory.js. Longest phrase first, tokens consumed so a phrase never matches inside another. */
export function findFacts(tokens, { exclude = new Set() } = {}) {
  const used = new Array(tokens.length).fill(false);
  const found = []; // {id, at, len}
  const text = tokens.map((t, i) => (exclude.has(i) ? t : repairWord(MISSPELL[t] ?? t)));
  for (let i = 0; i + 1 < text.length; i++) if (text[i] === "work" && /^(?:orders?|tickets?)$/.test(text[i + 1])) { used[i] = true; used[i + 1] = true; } // "work order" is a document word, not "work"
  const joined = (i, n) => text.slice(i, i + n).join(" ");
  for (const [phrase, id] of PHRASES) {
    const pt = phrase.split(" "); const n = pt.length;
    for (let i = 0; i + n <= text.length; i++) {
      if (used[i] || exclude.has(i)) continue;
      let ok = true; for (let k = 0; k < n; k++) if (used[i + k] || exclude.has(i + k)) { ok = false; break; }
      if (!ok || joined(i, n) !== phrase) continue;
      for (let k = 0; k < n; k++) used[i + k] = true;
      found.push({ id, at: i, len: n });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const ids = []; for (const f of found) if (!ids.includes(f.id)) ids.push(f.id);
  return { ids, used, found };
}

const VETO = new RegExp([
  "\\bhow many(?! (?:hours|hrs))\\b", "\\bcount\\b", "\\bnumber of (?:invoices|customers|jobs|visits|units|tickets|documents|permits|techs|technicians|systems|calls|appointments)\\b",
  "\\baverage\\b", "\\bavg\\b", "\\bmedian\\b", "\\b(?:biggest|largest|smallest|highest|lowest|cheapest|greatest|priciest|top|bottom)\\b", "\\bmost(?! recent)\\b", "\\bleast\\b", "\\bmost expensive\\b",
  "\\bcompare\\b", "\\bversus\\b", "\\bvs\\b", "\\bmore than\\b", "\\bless than\\b", "\\bover \\$?\\d", "\\bunder \\$?\\d", "\\bat least\\b", "\\bwhich customers?\\b", "\\bwhich (?:technician|tech)s?\\b.*\\b(?:most|least|more|fewer)\\b",
  "\\bwho (?:has|have|had)\\b", "\\ball (?:of )?(?:our|the|my) (?:customers|invoices|jobs)\\b", "\\bevery customer\\b", "\\ball customers\\b", "\\bin total\\b", "\\ball together\\b", "\\bcombined\\b", "\\bsum of\\b",
  "\\bper (?:month|year|visit|week)\\b", "\\bpercent", "\\bpercentage\\b", "\\bgrand total\\b.*\\ball\\b", "\\bshop wide\\b", "\\bcompany wide\\b", "\\bour (?:best|worst)\\b", "\\bgrowth\\b", "\\btrend\\b", "\\brevenue\\b", "\\bprofit\\b",
  "\\bwhy\\b", "\\bpredict\\b", "\\bforecast\\b",
].join("|"), "i");
/** help / how-to / "remind me" wording: not an aggregate, so it only blocks when no single customer or document number is named (the lane decides, and only after the older lanes in the late phase) */
const SINGLE_DOC_OK = /\b(?:compare|versus|vs|which customers?)\b/g;
const SOFT_VETO = /\bhow (?:do|can|should|would) (?:i|we|you)\b|\bwhere (?:do|can) i\b|\bhow to\b|\bdoes it work\b|\bremind me\b|\bremember\b/i;
const TIME_STEP_ASIDE = /\b(?:(?:last|past|previous|prior|next|this|coming)\s+(?:\d+\s+|few\s+|couple\s+(?:of\s+)?)?(?:days?|weeks?|months?|quarters?|years?|spring|summer|fall|autumn|winter)|quarter(?:ly)?|q[1-4]|since|before|after|between|until|till|yesterday|today|tonight|tomorrow|ago|(?<!most )recent(?:ly)?|lately|ytd|year to date|month to date|mtd|on or after|from \d)\b/;
const SUMMARY = /\b(?:summar(?:y|ize)|recap|rundown|run down|overview|give me (?:the )?(?:details|rundown|story)|details? (?:of|on|for|about)|everything (?:about|on|for))\b|\btell me about (?:the )?(?:last |latest |most recent )?(?:job|visit|service|call|invoice|ticket|permit|work order|wo|inv|po)\b|\bwhat happened (?:on|at|during|with|in) (?:the )?(?:last |latest |most recent )?(?:visit|job|service|call|ticket|appointment)\b|\bwhat happened (?:on|at|with) /;
const ORDER_NEWEST = /\b(?:latest|last|most recent|newest|current|recent)\b/;
const ORDER_OLDEST = /\b(?:first|oldest|earliest|original)\b/;
const ALL_WORD = /\b(?:all|every|each|history|full|entire|everything)\b/;

const DOC_WORDS = "invoice|inv|est|ticket|po|wo|permit|work order|workorder|purchase order|service ticket|bill|quote|estimate|agreement";
const DOC_NUM_PREFIXED = /\b([a-z]{1,4}(?:-[a-z]{1,4})?-?\d{3,}(?:-\d+)?)\b/g; // INV-20016, WO-40000, BP-2026-10001, PO9004
const DOC_NUM_BARE = new RegExp(`\\b(?:${DOC_WORDS})\\s*(?:number|no|num|#|:)?\\s*#?\\s*(\\d{3,}(?:-\\d+)?)\\b`, "g");

export const alnum = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const digitsOnly = (s) => String(s ?? "").replace(/\D/g, "");

/** words that may carry a time window: only then does the lane load the (large) date-window reader */
export const MAY_HAVE_WINDOW = /\b(?:19|20)\d{2}\b|\b(?:last|past|previous|prior|next|this|coming)\b.*\b(?:day|week|month|quarter|year|spring|summer|fall|autumn|winter)s?\b|\bq[1-4]\b|\bquarter|\bytd\b|\bsince\b|\bbefore\b|\bafter\b|\bbetween\b|\buntil\b|\byesterday\b|\btoday\b|\bago\b|\brecent|\blately\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/;

export function parseRecordsQuestion(question, { today = null, parsePeriodFn = null } = {}) {
  let text = normalizeText(question).replace(/(^|\s)#\s*(\d{4,6})\b/g, "$1inv $2").replace(/\best\s+#?(\d{3,})\b/g, "est-$1"); // a lone "# 20003" names a document number
  // with a document number in the question, "who did <it>" asks who worked it ("who did we bill" is a customer question and is left alone)
  if (/\b[a-z]{1,4}-?\d{4,}\b|\b(?:invoice|inv|wo|po|quote|estimate)\s*#?\s*\d{3,}\b/.test(text)) text = text.replace(/\bwho (?:did|does|do|handled|had|has)\b(?!\s+(?:we|i|you|they)\b)/g, "who worked on");
  const tokens = tokensOf(text);
  const out = { raw: String(question ?? ""), text, tokens, facts: [], summary: false, docNumbers: [], serials: [], address: null, order: null, all: false, window: null, stepAside: null };
  if (!tokens.length || tokens.length > 40) { out.stepAside = "length"; return out; }
  const vetoed = VETO.test(text);
  out.softVeto = SOFT_VETO.test(text);

  // document numbers FIRST (they contain letters + digits that must not be read as words)
  const nums = [];
  for (const m of text.matchAll(DOC_NUM_PREFIXED)) {
    const raw = m[1]; if (!/[a-z]/.test(raw) || !/\d/.test(raw)) continue;
    if (/^(?:\d+x\d+|[a-z]\d{1,2})$/.test(raw)) continue;
    nums.push({ raw, alnum: alnum(raw), digits: digitsOnly(raw), prefixed: true });
  }
  for (const m of text.matchAll(DOC_NUM_BARE)) {
    const raw = m[1]; if (nums.some((n) => n.digits === digitsOnly(raw))) continue;
    nums.push({ raw, alnum: alnum(raw), digits: digitsOnly(raw), prefixed: false });
  }
  out.docNumbers = nums;
  // compare / versus / "which customer" about ONE document number is not an aggregate across customers: it is a look at that one document (flagged soft, like how-to wording)
  if (vetoed) {
    if (new Set(nums.map((n) => n.digits)).size === 1 && !VETO.test(text.replace(SINGLE_DOC_OK, " "))) out.softVeto = true;
    else { out.stepAside = "aggregate-or-howto"; return out; }
  }
  // equipment serials: letters+digits, 6+ characters, not a document number shape
  for (const t of tokens) { const a = alnum(t); if (a.length >= 6 && /\d/.test(a) && /[A-Z]/.test(a) && !out.serials.includes(a)) out.serials.push(a); }
  // a street address: house number + street words + suffix
  const am = text.match(/\b(\d{1,6})\s+((?:[nsew]|north|south|east|west)\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,2}?)\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|pkwy|parkway|hwy|trl|trail)\b/);
  if (am) out.address = { number: am[1], dir: (am[2] ?? "").trim(), street: am[3], suffix: am[4] };

  const exclude = new Set();
  tokens.forEach((t, i) => { if (nums.some((n) => alnum(t) === n.alnum || t === n.raw) || (nums.length && nums.some((n) => !n.prefixed && t === n.raw))) exclude.add(i); });
  const f = findFacts(tokens, { exclude });
  out.facts = f.ids;
  out.factTokens = f.used;
  out.summary = SUMMARY.test(text);

  // time window: an explicit one is applied; any time phrase we cannot apply makes the lane step aside (it never ignores a condition)
  const rest = tokens.filter((_, i) => !f.used[i]).join(" ");
  const hasYearOnly = /\b(?:19|20)\d{2}\b/.test(text);
  let win = null;
  try { win = today && parsePeriodFn ? parsePeriodFn(text, today) : null; } catch { win = null; }
  if (win && (win.from || win.to)) out.window = { from: win.from ?? null, to: win.to ?? null, label: win.label ?? "that period" };
  else if (TIME_STEP_ASIDE.test(rest) || (hasYearOnly && /\b(?:in|during|from|of)\s+(?:19|20)\d{2}\b/.test(text)) || (!nums.length && tokens.some((t) => /^(?:19|20)\d{2}$/.test(t)))) out.stepAside = "time-phrase";
  else if (/\b(?:in|during|for|of|from)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(rest)) out.stepAside = "month-without-year";

  const lead = rest.replace(/\b(?:last|this|next|previous|past|prior)\s+(?:\d+\s+)?(?:quarter|year|month|week|day)s?\b/g, " ");
  out.order = ORDER_OLDEST.test(lead) ? "oldest" : ORDER_NEWEST.test(lead) ? "newest" : null;
  out.all = ALL_WORD.test(lead);
  return out;
}

export { STOP, factById };
