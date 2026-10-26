/**
 * peopleLane.js - Donovan answers questions about PEOPLE / COMPLIANCE paperwork ("when does Maria's CDL expire?", "who is Sam's manager?",
 * "what's Lee's start date?", "is Jo's medical card current?") from the stored papers, with no model.
 *
 * ONE env switch, default OFF: DONOVAN_READER_V2_IDDOCS=1 (the same switch as reader-v2/iddocs.js, which now calls answerPeople() below).
 *
 * How it decides (every step abstains rather than guesses):
 *   1. PERSON   a paper belongs to the person whose holder / employee name (stored extraction first, else the layout reader) matches the
 *               question: initial-tolerant ("U. Larkspur" = "Ulises A. Larkspur"), one-letter typo tolerant on long names, "Last, First" safe.
 *               A first name alone matches only when exactly one person has it and the question writes it like a name. A name in the
 *               question that matches nobody = abstain. Two people fit = abstain.
 *   2. PAPER    the question's topic picks the paper type: CDL / driver licence, DOT medical card, CPR / forklift / OSHA card, vehicle
 *               registration, insurance card, new-hire sheet, W-4 / I-9 / A-4 / direct deposit / background consent / volunteer form.
 *               "start date" is a new-hire fact and is NEVER answered from a licence issue date. Two papers of the topic that
 *               disagree = abstain (the latest expiry is used only for expiry / current questions on renewed cards).
 *   3. FACT     expiry, current / expired (against today), issue / exam date, number present, class, examiner, issuer, manager,
 *               position, start date, pay, ... Exactly one fact must be asked.
 *   4. SAFETY   licence / card numbers: "on file" + last 4 only. SSN, bank routing / account, birth date, VIN, plate: never read out here.
 *               People and HR papers: only for a caller who may open People and HR (the caller computes canHr; others get nothing).
 *
 * Pure core (answerPeople) + a small DB reader (runPeopleLane). Never throws out of the lane.
 */
import { readPeopleForm } from "../modelAvoidance/peopleForms.js";
import { nameShape } from "../modelAvoidance/peopleShape.js";

const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? "").trim());
export const peopleLaneOn = () => truthy(process.env.DONOVAN_READER_V2_IDDOCS);
/** The ONE gate ask.js uses: the switch is on AND the question is one this lane reads. */
export const peopleLaneApplies = (question) => peopleLaneOn() && !!readQuestion(question);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const nice = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso)); return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : null; };
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const last4 = (v) => { const s = String(v ?? "").replace(/[^A-Za-z0-9]/g, ""); return s.length >= 5 ? s.slice(-4) : null; };

/* ----------------------------------------------------------------------------------------------- question reading */
const TOPICS = [
  ["mec", /\b(?:medical\s+(?:card|cert\w*|exam\w*|examiner)|med\s+card|dot\s+(?:medical|physical|card|exam)|mcsa|dot\s+med|physical)\b/i],
  ["cpr", /\b(?:cpr|first[-\s]aid|aed|bls)\b/i],
  ["forklift", /\b(?:fork\s?lift|powered\s+industrial|pit\s+(?:card|cert))\b/i],
  ["osha", /\bosha\b/i],
  ["cdl", /\b(?:cdl|commercial\s+driver\w*)\b/i],
  ["vehreg", /\b(?:registration|registered|license\s+plate|plate|tags?)\b/i],
  ["insurance", /\b(?:insurance|insures?|insured|insurer|policy|coverage)\b/i],
  ["w4", /\bw-?4\b/i], ["i9", /\bi-?9\b/i], ["a4", /\ba-?4\b/i],
  ["dd", /\bdirect\s+deposit\b/i], ["bg", /\bbackground\s+(?:check|consent)\b/i], ["volunteer", /\bvolunteer\b/i],
  ["dl", /\b(?:driver'?s?\s+licen[cs]e|drivers\s+licen[cs]e|licen[cs]e|dl)\b/i],
  ["newhire", /\b(?:new[-\s]?hire|onboarding|hire\s+date|hired|start(?:ing)?\s+date|first\s+day|start(?:ed)?\s+work|manager|supervisor|reports?\s+to|position|job\s+title|hourly\s+(?:rate|wage)|pay\s+rate|rate\s+of\s+pay|salary|department|emergency\s+contact|shirt)\b/i],
];
const KIND_GROUPS = {
  mec: ["mec"], cpr: ["cpr"], forklift: ["forklift"], osha: ["osha"], cdl: ["cdl"], dl: ["cdl", "dl"], vehreg: ["vehreg"], insurance: ["insurance"],
  w4: ["w4"], i9: ["i9"], a4: ["a4"], dd: ["dd"], bg: ["bg"], volunteer: ["volunteer"], newhire: ["newhire"],
};
const LIC_KINDS = ["mec", "cdl", "dl", "cpr", "forklift", "osha"];
const FACT_RES = [
  ["number", /\b(?:number|no\.?|#|num)\b|\bon\s+file\b/i],
  ["requester", /\b(?:requesting|requested|who\s+is\s+requesting)\b|\bwhich\s+(?:company|organi[sz]ation)\b[^?]*\bvolunteer\s+with\b|\bapply\s+to\s+volunteer\b/i],
  ["class", /\bclass\b/i],
  ["examiner", /\bexaminer\b|\bwho\s+(?:signed|examined)\b|\bdoctor\b/i],
  ["issuer", /\b(?:who|which\s+(?:company|organi[sz]ation|agency|school|academy|carrier))\s+(?:issued|insures?|is\s+the\s+insurer)\b|\bissued\s+by\b|\binsurance\s+(?:company|carrier)\b|\binsurer\b|\binsured\s+by\b|\bwho\s+insures\b/i],
  ["manager", /\b(?:manager|supervisor|reports?\s+to|boss)\b/i],
  ["position", /\b(?:position|job\s+title|hired\s+(?:as|for))\b/i],
  ["pay", /\b(?:hourly\s+(?:rate|wage)|pay\s+rate|rate\s+of\s+pay|salary|wage|how\s+much\s+(?:does|is|will)\b[^?]*\b(?:paid|make|earn))\b/i],
  ["start", /\b(?:start(?:ing|ed)?\s+(?:date|day|work)|first\s+day|hire\s+date|date\s+of\s+hire|when\s+(?:did|does|do|is|was)\b[^?]*\bstart|hired\s+on|begin)\b/i],
  ["department", /\bdepartment\b/i],
  ["emergency_contact", /\bemergency\s+contact\b/i],
  ["employer", /\bemployer\b|\bwho\s+(?:does|is)\b[^?]*\bwork\s+for\b/i],
  ["filing_status", /\bfiling\s+status\b/i],
  ["withholding_percentage", /\bwithholding\s+percent\w*|\bpercent\w*\s+(?:did|to)\b[^?]*\bwithhold|\bwhat\s+percent/i],
  ["extra_withholding", /\bextra\s+withholding\b/i],
  ["agency", /\bscreening\s+agency\b|\bwhich\s+agency\b/i],
  ["bank", /\bwhat\s+bank\b|\bbank\s+(?:does|name)\b/i],
  ["account_type", /\bchecking\s+or\s+savings\b|\baccount\s+type\b/i],
  ["role", /\bvolunteer\s+role\b|\bwhat\s+role\b/i],
  ["availability", /\bavailab\w*\b/i],
  ["reference", /\breference\b/i],
  ["phone", /\bphone\b/i],
  ["email", /\be-?mail\b/i],
  ["vehicle", /\bwhat\s+vehicle\b|\bwhich\s+vehicle\b/i],
  ["status", /\b(?:current|valid|expired|up\s+to\s+date|still\s+good|in\s+date|lapsed|active|good)\b/i],
  ["expiry", /\b(?:expir\w*|valid\s+(?:until|through|thru)|good\s+(?:until|through)|run\s+out|runs\s+out|due\s+(?:to\s+)?renew\w*|renew\w*)\b/i],
  ["issued", /\b(?:issued|issue\s+date|date\s+issued|examined|examination|exam\s+date|physical|signed|when\s+(?:was|did)\b[^?]*\b(?:get|sign|take|done|complete\w*))\b/i],
];
// questions that ask for a value this lane never reads out: left to the older (declining) path
const NEVER = /\b(?:ssn|social\s+security|routing|account\s+number|date\s+of\s+birth|birth\s*date|birthday|dob|vin\b|vehicle\s+identification|license\s+plate\s+(?:number|no)|plate\s+number|national\s+registry|list\s+a\b|immigration|work\s+authori[sz]ation|passport)\b/i;

const LICENCE_PREV_OK = new Set(["driver", "drivers", "driver's", "driving", "commercial", "cdl", "dl", "my", "his", "her", "their", "the", "a", "an", "this", "that", "current", "valid", "new", "old", "renewed", "expired", "updated", "latest", "is", "does", "did", "when", "what", "whats", "what's", "of", "for", "on"]);
function licenceQualifierOk(q) {
  const text = collapse(q).replace(/[’]/g, "'");
  for (const m of text.matchAll(/(\S+)\s+licen[cs]e\b/gi)) {
    const orig = m[1].replace(/[^A-Za-z0-9'-]/g, "");
    const prev = orig.toLowerCase();
    if (LICENCE_PREV_OK.has(prev)) continue;
    // a possessive is the HOLDER's ("Pat Rivera's license") only when it is a capitalised name; "contractor's license" is a qualifier
    if (/'s$|s'$/.test(prev) && /^[A-Z]/.test(orig) && m.index > 0) continue;
    return false;
  }
  return true;
}
// the nouns that OWN a start date other than a hire: an agreement, a warranty, a job, a lease ... (a customer can share an employee's name)
const NON_HR_START = /\b(?:agreement|contract|warrant(?:y|ies)|service|services|job|jobs|lease|maintenance|plan|install\w*|project|visit|appointment|policy|coverage|membership|subscription|order|ticket|rental|repair|trial|term|season|quote|estimate|invoice|permit|claim|inspection|delivery|loan|promotion|campaign|course|class(?:es)?|training|school|semester|account|equipment|unit|system)\b/;

const NON_HR_MONEY = /\b(?:invoice|invoiced|bill|billed|balance|owe|owes|owed|payment|payments|quote|estimate|charge|charged|fee|fees|cost|price|total|amount|due|deposit|refund|receipt|customer|client|tenant|patient|rent|order)\b/;
/** @returns {{kinds: string[], fact: string, topic: string|null}|null} */
export function readQuestion(q) {
  const ql = collapse(q).toLowerCase().replace(/[’]/g, "'");
  if (NEVER.test(ql)) return null;
  // "When does X's contractor / plumbing / ROC / real estate license expire?" is not a question about a driver licence: the word before "license"
  // must be a driver word, a possessive or a determiner. Any other qualifier means a different paper this lane does not hold.
  if (!licenceQualifierOk(q)) return null;
  // "renew" asks whether a renewal happened (yes / no), which an expiry date does not answer
  if (/\b(?:did|has|have|had|will|is|was)\b[^?]*\brenew(?:ed|al)?\b/.test(ql)) return null;
  const topics = TOPICS.filter(([, re]) => re.test(ql)).map(([t]) => t);
  // "license plate" is the vehicle, not a driver licence; "registered" in "registered nurse" etc. is left alone
  let ts = topics.filter((t) => !(t === "dl" && /license\s+plate|licence\s+plate/.test(ql)));
  if (ts.includes("mec") && ts.includes("dl")) ts = ts.filter((t) => t !== "dl");
  if (ts.includes("cdl") && ts.includes("dl")) ts = ts.filter((t) => t !== "dl");
  // a bare "newhire" word (manager / position / start date ...) next to a card topic is not a second topic
  const specific = ts.filter((t) => t !== "newhire");
  const topic = specific.length === 1 ? specific[0] : specific.length === 0 ? (ts.includes("newhire") ? "newhire" : null) : null;
  if (specific.length > 1) return null;
  const hits = FACT_RES.filter(([, re]) => re.test(ql)).map(([f]) => f);
  // priority resolution: a more specific fact beats the generic ones
  let fact = null;
  const has = (f) => hits.includes(f);
  const timeAsk = /\b(?:when|what\s+(?:date|day)|how\s+long|until)\b/.test(ql);
  if (has("phone") && !has("email")) fact = "phone";
  else if (has("email") && !has("phone")) fact = "email";
  else if (has("requester")) fact = "requester";
  else if (has("role") && !has("position")) fact = "role";
  else if (has("number") && !has("class")) fact = "number";
  else if (has("class") && !has("number")) fact = "class";
  else if (has("examiner") && !has("number")) fact = "examiner";
  else if (has("issuer") && !has("number")) fact = "issuer";
  else if (has("manager")) fact = "manager";
  else if (has("position") && !has("start")) fact = "position";
  else if (has("pay")) fact = "pay";
  else if (has("start")) fact = "start";
  else if (has("emergency_contact")) fact = "emergency_contact";
  else if (has("department")) fact = "department";
  else if (has("employer")) fact = "employer";
  else if (has("filing_status")) fact = "filing_status";
  else if (has("extra_withholding")) fact = "extra_withholding";
  else if (has("withholding_percentage")) fact = "withholding_percentage";
  else if (has("agency")) fact = "agency";
  else if (has("account_type")) fact = "account_type";
  else if (has("bank")) fact = "bank";
  else if (has("role")) fact = "role";
  else if (has("availability")) fact = "availability";
  else if (has("reference")) fact = "reference";
  else if (has("vehicle")) fact = "vehicle";
  else if (has("expiry") && (timeAsk || !has("status"))) fact = "expiry";
  else if (has("status")) fact = "status";
  else if (has("expiry")) fact = "expiry";
  else if (has("issued")) fact = "issued";
  else if (has("phone") && !has("email")) fact = "phone";
  else if (has("email") && !has("phone")) fact = "email";
  if (!fact) return null;
  // a "start" of anything but a hire (a customer's agreement, warranty, job or service can start too) is not this lane's
  // (an insurance card's own "coverage start" has the topic "insurance" and is read from that card)
  if (fact === "start" && (!topic || topic === "newhire") && NON_HR_START.test(ql)) return null;
  // money / customer wording ("Has Lee Kim paid the invoice?") is never an employee's pay, phone, manager or position
  if (["start", "pay", "position", "manager", "department", "emergency_contact", "phone", "email"].includes(fact) && (!topic || topic === "newhire") && NON_HR_MONEY.test(ql)) return null;
  // two different facts in one question ("when does it expire and what class is it") are not answered by half
  const GROUP = { expiry: "exp", status: "exp", position: "position", role: "position", bank: "bank", account_type: "bank" };
  const groups = new Set(hits.filter((h) => !(h === "number" && (has("phone") || has("email"))) && !(h === "issued" && (has("start") || has("issuer") || has("examiner")))).map((h) => GROUP[h] ?? h));
  if (groups.size > 1) return null;
  // a plain "who is X's employer ... W-4" etc. keeps its form topic; a fact with no topic infers its paper
  let kinds = topic ? KIND_GROUPS[topic] : null;
  if (!kinds) {
    if (["manager", "position", "pay", "start", "department", "emergency_contact"].includes(fact)) kinds = fact === "start" ? ["newhire", "i9"] : ["newhire"];
    else if (fact === "class") kinds = ["cdl", "dl"];
    else if (fact === "examiner") kinds = ["mec"];
    else if (fact === "filing_status" || fact === "extra_withholding") kinds = ["w4"];
    else if (fact === "withholding_percentage") kinds = ["a4"];
    else if (fact === "agency") kinds = ["bg"];
    else if (fact === "bank" || fact === "account_type") kinds = ["dd"];
    else if (fact === "role" || fact === "availability" || fact === "reference") kinds = ["volunteer"];
    else if (fact === "vehicle") kinds = ["vehreg"];
    else if (fact === "issuer" && /insur/.test(ql)) kinds = ["insurance"];
    else return null;
  } else if (topic === "newhire" && fact === "start") kinds = ["newhire", "i9"];
  else if (topic === "i9" && fact === "start") kinds = ["i9"];
  // a card topic with a HR-only fact (or the reverse) is a mismatch: no answer
  const HR_ONLY = ["requester", "manager", "position", "pay", "department", "emergency_contact", "employer", "filing_status", "extra_withholding", "withholding_percentage", "agency", "bank", "account_type", "role", "availability", "reference"];
  if (kinds.some((k) => LIC_KINDS.includes(k)) && HR_ONLY.includes(fact)) return null;
  if (kinds.every((k) => ["newhire"].includes(k)) && ["class", "examiner", "number", "expiry", "status"].includes(fact)) return null;
  return { kinds, fact, topic };
}

/* ----------------------------------------------------------------------------------------------- people matching */
const STOP_NAME = new Set(["what", "when", "who", "whose", "which", "how", "does", "did", "the", "and", "for", "card", "date", "start", "class", "medical", "license", "licence", "cdl", "dot", "manager", "position", "pay", "rate", "hire", "hired", "expire", "expires", "expired", "current", "valid", "number", "policy", "insurance", "work", "phone", "email", "form", "sheet", "new", "from", "with", "that", "this", "have", "has", "his", "her", "their", "tell", "show", "give", "will", "may", "mark", "grant", "rose", "bill", "hope", "june", "april", "august", "dawn", "carol", "frank", "major", "case", "price", "sue", "ray", "dean"]);
const TITLES = new Set(["dr", "mr", "mrs", "ms", "jr", "sr", "ii", "iii", "iv", "md"]);
const wordsOf = (s) => collapse(s).toLowerCase().replace(/[’]/g, "'").replace(/'s\b/g, "").replace(/[^a-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
function nameParts(name) {
  const w = wordsOf(name).filter((x) => !TITLES.has(x));
  const full = w.filter((x) => x.length > 1);
  const initials = w.filter((x) => x.length === 1);
  const first = full[0] ?? null; const surname = full.length > 1 ? full[full.length - 1] : null;
  return { all: w, full, initials, first, surname };
}
function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** a hyphenated surname is also known by its parts */
const variants = (tok) => (tok && tok.includes("-") ? [tok, ...tok.split("-").filter((x) => x.length > 2)] : [tok]);
/**
 * Score of one person against a question: {surname, first, fuzzy} or null. `qWords` = lowercase words of the question (possessive removed);
 * `qCaps` = the question's capitalised words (original case) that are not the first word.
 */
function scorePerson(p, qWords, qSet, singleFirstOk) {
  if (!p.first && !p.surname) return null;
  const has = (tok) => variants(tok).some((v) => qSet.has(v));
  const near = (tok) => tok.length >= 6 && variants(tok).some((v) => v.length >= 6 && qWords.some((w) => w.length >= 5 && w !== v && lev1(v, w)));
  const initialHit = (tok) => qWords.some((w) => w.length === 1 && tok && w === tok[0]);
  const sn = p.surname ? (has(p.surname) ? 2 : near(p.surname) ? 1 : 0) : 0;
  const fn = p.first ? (has(p.first) ? 2 : near(p.first) ? 1 : initialHit(p.first) ? 1 : 0) : 0;
  if (p.surname) {
    if (sn && (fn || singleFirstOk)) return { sn, fn };
    if (sn === 2 && !fn) return { sn, fn, surnameOnly: true };
    if (!sn && fn === 2) return { sn, fn, firstOnly: true };
    return null;
  }
  return fn === 2 ? { sn: 0, fn, firstOnly: true } : null;
}

// words that may stand next to a name in a question without being part of a name
const FUNC = new Set(["a", "an", "the", "of", "for", "to", "on", "in", "at", "by", "with", "about", "from", "and", "or", "is", "are", "was", "were", "be", "does", "do", "did", "when", "what", "whats", "what's", "who", "whose", "which", "how", "where", "has", "have", "had", "can", "could", "will", "would", "should", "tell", "show", "give", "find", "me", "us", "my", "our", "his", "her", "their", "that", "this", "these", "those", "there", "it", "its", "any", "all", "if", "please", "also", "then", "than", "date", "name", "card", "cdl", "license", "licence", "medical", "certificate", "certification", "cpr", "osha", "dot", "driver", "drivers", "employee", "worker", "tech", "technician", "mr", "mrs", "ms", "dr", "new", "hire", "hired", "check", "see", "look", "up", "ask", "asking", "wondering", "need", "want", "know", "let", "lets", "get", "got", "much", "many", "long", "still", "yet", "now", "today", "currently", "current", "expired", "valid", "okay", "ok", "hey", "hi", "so", "no", "yes", "not", "isnt", "isn't", "doesnt", "doesn't"]);
/** The word just before / after the matched name word in the question, or null. A name-like word there that is not part of this person's name means the question names someone else. */
function neighbourConflict(question, parts, extra, side) {
  const toks = collapse(question).toLowerCase().replace(/[’]/g, "'").replace(/'s\b/g, "").replace(/[^a-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
  // the same words with their original case: a neighbour that is not capitalised ("commercial", "expiration") is a word, not someone else's name
  const orig = collapse(question).replace(/[’]/g, "'").replace(/'s\b/gi, "").replace(/[^A-Za-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
  const known = new Set([...parts.all, ...extra].flatMap((w) => variants(w)));
  const anchor = side === "before" ? parts.surname : parts.first;
  if (!anchor) return false;
  const idx = toks.findIndex((w) => variants(anchor).includes(w) || variants(w).some((v) => variants(anchor).includes(v)));
  if (idx < 0) return false;
  const w = side === "before" ? toks[idx - 1] : toks[idx + 1];
  const wOrig = side === "before" ? orig[idx - 1] : orig[idx + 1];
  const casedQuestion = orig.slice(1).some((t) => /^[A-Z]/.test(t)); // an all-lower-case question gives no case to read
  if (casedQuestion && wOrig && w.length > 1 && !/^[A-Z]/.test(wOrig)) return false;
  if (!w || FUNC.has(w) || STOP_NAME.has(w) || known.has(w)) return false;
  if (w.length === 1) return !parts.all.some((n) => n[0] === w); // an initial that is not this person's
  return /^[a-z][a-z'-]{2,}$/.test(w) && !/^(?:expire|expires|expired|expiry|expiration|current|valid|start|manager|position|pay|rate|class|number|issued|examiner|insurance|policy|registration|vehicle|phone|email|bank|role|reference|availability|department|emergency|filing|withholding|agency|and|or)$/.test(w) && !TOPICS.some(([, re]) => re.test(w));
}

/** The people in `docs` (by name) that the question matches: [{key, name, score}] best first, or [] */
export function findPeople(question, people) {
  const qWords = wordsOf(question);
  const qSet = new Set(qWords.flatMap((w) => variants(w)));
  const capitalised = new Set(collapse(question).split(/\s+/).slice(1).map((w) => w.replace(/'s$/i, "").replace(/[^A-Za-z-]/g, "")).filter((w) => /^[A-Z][a-z]/.test(w)).map((w) => w.toLowerCase()));
  const possessive = new Set([...collapse(question).toLowerCase().matchAll(/([a-z-]+)['’]s\b/g)].map((m) => m[1]));
  const out = [];
  for (const p of people) {
    const parts = nameParts(p.name);
    const s = scorePerson(parts, qWords, qSet, false);
    if (!s) continue;
    // a single word (first name or surname alone) must read like a name: capitalised mid-sentence or possessive, not a common word
    if (s.surnameOnly || s.firstOnly) {
      const tok = s.surnameOnly ? parts.surname : parts.first;
      if (STOP_NAME.has(tok)) continue;
      if (!variants(tok).some((v) => capitalised.has(v) || possessive.has(v))) continue;
    }
    if (s.surnameOnly && neighbourConflict(question, parts, p.extra ?? [], "before")) continue;
    if (s.firstOnly && neighbourConflict(question, parts, p.extra ?? [], "after")) continue;
    out.push({ ...p, parts, single: !!(s.surnameOnly || s.firstOnly), score: s.sn * 2 + s.fn + (s.surnameOnly || s.firstOnly ? 0 : 3) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ----------------------------------------------------------------------------------------------- the papers */
/** @typedef {{id:string, type:string, fields:Record<string,string>, pages:{page_no:number,text:string}[]}} PeopleDoc */
/**
 * Round 7: a name that sits on a person-name label and looks like a name but that the reader did not believe (no evidence it is a person). It is never used to ANSWER, but it
 * is a person on file: "Morgan" must not be answered for Emilio Morgan when a second paper holds "Morgan Larkspur" that the reader left unread.
 */
const SHADOW_LABEL = /^(?:(?:driver|licensee|holder|cardholder|applicant|employee|operator|examinee|certificate\s+holder|new\s+hire)(?:'s|’s)?\s+)?(?:full\s+|printed\s+)?name\b\s*[:#=-]?\s*(.*)$|^(?:licensee|cardholder|certificate\s+holder|employee|new\s+hire)\s*[:#=-]\s*(.*)$/i;
function shadowName(pages) {
  for (const p of pages ?? []) {
    const lines = String(p?.text ?? "").split(/\r?\n/).map((l) => collapse(l)).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const m = SHADOW_LABEL.exec(lines[i]);
      if (!m) continue;
      const rest = collapse(m[1] ?? m[2] ?? "");
      const cand = rest || (lines[i + 1] && !SHADOW_LABEL.test(lines[i + 1]) ? lines[i + 1] : "");
      const r = cand ? nameShape(cand) : null;
      if (r?.ok) return r.value;
    }
  }
  return "";
}
function docInfo(d) {
  if (d._info) return d._info;
  const f = d.fields ?? {};
  let form = { kind: null, facts: {}, extras: {}, conflicts: [] };
  try { form = readPeopleForm(d.pages ?? [], {}); } catch { /* stored fields only */ }
  const text = (d.pages ?? []).map((p) => p.text).join("\n");
  let kind = form.kind;
  if (!kind) {
    if (d.type === "license-certification") {
      if (/medical\s+examiner'?s?\s+certificate|mcsa/i.test(text.slice(0, 4000))) kind = "mec";
      else if (/\b(?:cdl|commercial\s+driver)\b/i.test(text) || /^[ABC]$/i.test(f.license_class ?? "")) kind = "cdl";
      else if (/driver'?s?\s+licen[cs]e/i.test(text)) kind = "dl";
    } else if (d.type === "hr-letter" && /new[-\s]?hire/i.test(text)) kind = "newhire";
    else if (d.type === "insurance-certificate" && /identification\s+card|proof\s+of\s+insurance/i.test(text)) kind = "insurance";
  }
  // a commercial licence card read by the old reader: class A/B/C or the word makes it a CDL
  const merged = { ...Object.fromEntries(Object.entries(form.facts).filter(([k]) => !form.conflicts.includes(k)).map(([k, v]) => [k, v.value])) };
  for (const [k, v] of Object.entries(f)) if (v != null && String(v).trim()) merged[k] = String(v).trim(); // stored (and corrected) values win
  let name = merged.holder_name || merged.employee_name || "";
  const cm = /^([A-Za-z'’ -]+),\s*([A-Za-z'’. -]+)$/.exec(name.trim());
  if (cm && !/^(?:md|do|dc|pa|np|dds|phd|jr|sr|ii|iii)\.?$/i.test(cm[2].trim())) name = `${cm[2].trim()} ${cm[1].trim()}`; // "PENHALLOW, ZELDA D" stored as printed
  const shadow = name ? "" : shadowName(d.pages);
  d._info = { shadow, kind, merged, extras: Object.fromEntries(Object.entries(form.extras).map(([k, v]) => [k, v.value])), name, page: (form.facts.start_date ?? form.facts.end_date ?? form.facts.holder_name ?? form.facts.employee_name ?? {}).page_no ?? null };
  return d._info;
}

const THING = { mec: "DOT medical card", cdl: "CDL", dl: "driver license", cpr: "CPR card", forklift: "forklift certification", osha: "OSHA card", vehreg: "vehicle registration", insurance: "auto insurance", newhire: "new-hire sheet", w4: "W-4", i9: "I-9", a4: "Arizona A-4", dd: "direct deposit form", bg: "background check consent", volunteer: "volunteer application" };
const possessiveOf = (n) => (/s$/i.test(n) ? `${n}'` : `${n}'s`);
const todayIso = (t) => (/^\d{4}-\d{2}-\d{2}$/.test(String(t)) ? String(t) : new Date().toISOString().slice(0, 10));

/**
 * @param {PeopleDoc[]} docs the people / compliance papers this caller may use
 * @param {string} question
 * @param {{today?: string, canHr?: boolean}} opts
 * @returns {{text: string, docs: string[], page: number|null, intent: string}|null} null = not ours / unsure: say nothing
 */
export function answerPeople(docs, question, { today, canHr = true } = {}) {
  try {
    const rq = readQuestion(question);
    if (!rq) return null;
    const named = docs.map((d) => ({ d, i: docInfo(d) })).filter((x) => (x.i.name || x.i.shadow) && (canHr || x.d.type !== "hr-letter"));
    // People and HR papers are for callers who may open People and HR only. A paper whose kind is not recognised still counts as a PERSON
    // (so "Yoder" is not guessed when two Yoders are on file) but is never used to answer.
    const usable = named.filter((x) => x.i.kind && x.i.name); // a shadow person (name on file, not believed) is counted but never answers
    if (!usable.length) return null;
    // one person = same first and last name (a middle name or initial may differ between papers: "Maria Lopez Santos" / "Maria L Santos")
    const idOf = (name) => { const p = nameParts(name); return p.first && p.surname ? `${p.first}|${p.surname}` : null; };
    const peopleMap = new Map();
    for (const x of named) {
      const pn = x.i.name || x.i.shadow;
      const key = idOf(pn);
      if (!key) continue;
      const cur = peopleMap.get(key) ?? { key, name: pn, extra: new Set() };
      for (const w of nameParts(pn).full) cur.extra.add(w);
      if (pn.length > cur.name.length) cur.name = pn;
      peopleMap.set(key, cur);
    }
    const hits = findPeople(question, [...peopleMap.values()]);
    if (!hits.length) return null;
    // two people fit equally -> abstain; one clearly better than the rest -> that one
    // A lone word that fits several people (one's surname, another's first name: "Lee" for Ann Lee and Lee Chang) is not an answer either way.
    if (hits.length > 1 && (hits[0].single || hits[0].score - hits[1].score < 2)) return null;
    const who = hits[0];
    // a second capitalised name-like word that is nobody's: the question is about someone else too
    const known = new Set([...who.extra, ...who.parts.all].flatMap((w) => variants(w)));
    const vocab = /^(?:What|When|Who|Whose|Which|How|Is|Does|Did|Do|Are|Was|Can|The|Tell|Show|Give|Find|CDL|DOT|CPR|OSHA|HR|DL|ID|W-?4|I-?9|A-?4|AZ|Arizona|Medical|Does)$/i;
    for (const w of collapse(question).split(/\s+/).slice(1)) {
      const t = w.replace(/'s$/i, "").replace(/[^A-Za-z-]/g, "");
      if (/^[A-Z][a-z]{2,}$/.test(t) && !vocab.test(t) && !variants(t.toLowerCase()).some((v) => known.has(v)) && !STOP_NAME.has(t.toLowerCase()) && !MID_VOCAB.test(t)) return null;
    }
    const mine = usable.filter((x) => idOf(x.i.name) === who.key);
    let cand = mine.filter((x) => rq.kinds.includes(x.i.kind));
    if (rq.topic === "dl" || rq.kinds.includes("cdl")) cand = cand.filter((x) => rq.kinds.includes(x.i.kind));
    if (!cand.length) return null;
    const today0 = todayIso(today);
    const f = rq.fact;
    const key = { expiry: "end_date", status: "end_date", issued: "start_date", number: "license_number", class: "license_class", examiner: "issued_by", issuer: null, manager: "manager", position: "position", pay: "pay_rate", start: "start_date", phone: "employee_phone", email: "employee_email", employer: "vendor" }[f];
    const signedKind = (x) => ["w4", "a4", "dd", "bg", "volunteer"].includes(x.i.kind);
    const val = (x) => {
      if (f === "issued" && signedKind(x)) return x.i.merged.signed_date ?? x.i.merged.service_date ?? null;
      if (f === "requester") return x.i.merged.vendor ?? null;
      if (f === "issuer") return x.i.kind === "mec" ? null : (x.i.merged.issued_by || x.i.merged.vendor || null);
      if (f === "number") return x.i.merged.license_number || x.i.merged.policy_number || null;
      if (f === "phone") return x.i.merged.employee_phone ?? x.i.merged.customer_phone ?? null; // older stored papers kept it under customer_*
      if (f === "email") return x.i.merged.employee_email ?? x.i.merged.customer_email ?? null;
      if (key) return x.i.merged[key] ?? null;
      return x.i.extras[f] ?? null;
    };
    const have = cand.filter((x) => val(x));
    if (!have.length) return null; // the paper does not carry the fact: say nothing
    let pick = have;
    if (have.length > 1) {
      const vals = new Set(have.map((x) => String(val(x)).toLowerCase()));
      if (vals.size === 1) pick = [have[0]];
      else if (f === "expiry" || f === "status") pick = [have.slice().sort((a, b) => String(val(b)).localeCompare(String(val(a))))[0]]; // renewed card: the latest expiry
      else return null;
    }
    const x = pick[0];
    const raw = String(val(x));
    const nm = x.i.name;
    const thing = THING[x.i.kind] ?? "paper";
    const mine1 = `${possessiveOf(nm)} ${thing}`;
    let text; let intent = `people_${f}`;
    if (f === "expiry" || f === "status") {
      const dt = nice(raw); if (!dt) return null;
      const isCurrent = raw >= today0;
      if (f === "expiry") text = isCurrent ? `${mine1} expires on ${dt}.` : `${mine1} expired on ${dt}.`;
      else text = isCurrent ? `Yes. ${mine1} is current. It expires on ${dt}.` : `No. ${mine1} is expired. It expired on ${dt}.`;
    } else if (f === "issued") {
      const dt = nice(raw); if (!dt) return null;
      const hrSigned = signedKind(x);
      const dd = nice(raw); if (!dd) return null;
      text = x.i.kind === "mec" ? `${mine1} exam was on ${dd}.` : hrSigned ? `${possessiveOf(nm)} ${thing} was signed on ${dd}.` : `${mine1} was issued on ${dd}.`;
    } else if (f === "start") {
      const dt = nice(raw); if (!dt) return null;
      text = `${possessiveOf(nm)} start date is ${dt}.`;
    } else if (f === "number") {
      if (x.i.merged.policy_number && x.i.kind === "insurance") text = `${mine1} policy number is ${x.i.merged.policy_number}.`;
      else { const l4 = last4(raw); if (!l4) return null; text = `A ${thing} number is on file for ${nm}, ending in ${l4}. I only show the last 4.`; }
    } else if (f === "class") { if (!/^[A-D]$/i.test(raw)) return null; text = `${mine1} is class ${raw.toUpperCase()}.`; }
    else if (f === "examiner") text = `${possessiveOf(nm)} medical examiner was ${raw}.`;
    else if (f === "issuer") text = x.i.kind === "insurance" ? `${mine1} is with ${raw}.` : `${mine1} was issued by ${raw}.`;
    else if (f === "requester") text = x.i.kind === "volunteer" ? `${nm} applied to volunteer with ${raw}.` : `${raw} is requesting the background check on ${nm}.`;
    else if (f === "manager") text = `${possessiveOf(nm)} manager is ${raw}.`;
    else if (f === "position") text = `${possessiveOf(nm)} position is ${raw}.`;
    else if (f === "pay") text = `${possessiveOf(nm)} pay rate is ${raw}.`;
    else if (f === "employer") text = `${possessiveOf(nm)} employer on the ${thing} is ${raw}.`;
    else if (f === "department") text = `${possessiveOf(nm)} department is ${raw}.`;
    else if (f === "emergency_contact") text = `${possessiveOf(nm)} emergency contact is ${raw}.`;
    else if (f === "phone") text = `${possessiveOf(nm)} phone number on the ${thing} is ${raw}.`;
    else if (f === "email") text = `${possessiveOf(nm)} email on the ${thing} is ${raw}.`;
    else if (f === "filing_status") text = `${nm} chose ${raw} on the W-4.`;
    else if (f === "withholding_percentage") text = `${nm} chose ${raw} withholding on the Arizona A-4.`;
    else if (f === "extra_withholding") text = `${nm} asked for ${raw} extra withholding per pay period on the W-4.`;
    else if (f === "agency") text = `${possessiveOf(nm)} background check will be run by ${raw}.`;
    else if (f === "bank") text = `${nm} uses ${raw} for direct deposit.`;
    else if (f === "account_type") text = `${possessiveOf(nm)} direct deposit account is ${raw.toLowerCase()}.`;
    else if (f === "role") text = `${nm} applied for ${raw}.`;
    else if (f === "availability") text = `${nm} is available ${raw.charAt(0).toLowerCase()}${raw.slice(1)}.`;
    else if (f === "reference") text = `${possessiveOf(nm)} volunteer reference is ${raw}.`;
    else if (f === "vehicle") text = `${possessiveOf(nm)} registered vehicle is a ${raw}.`;
    else return null;
    return { text, docs: [x.d.id], types: [x.d.type], page: x.i.page ?? null, intent };
  } catch { return null; }
}
const MID_VOCAB = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Arizona|Mesa|Tempe|Phoenix|Gilbert|Chandler|Scottsdale|Texas|Florida|California|Nevada|Colorado|Ohio|Georgia|Illinois|Pennsylvania|Washington|York|Class|Medical|Commercial|Department|Transportation|Federal|Form|Driver|Drivers|Employee|Employer|Insurance|Registration|Vehicle|Safety|Forklift|Powered|Industrial|Truck|Certificate|Certification|Card)$/;

/* ----------------------------------------------------------------------------------------------- the database reader */
const WANTED_KEYS = ["holder_name", "employee_name", "license_number", "license_class", "start_date", "end_date", "issued_by", "vendor", "position", "pay_rate", "manager", "policy_number", "service_date", "customer_phone", "customer_email", "signed_date", "employee_phone", "employee_email"];
const TYPES = ["license-certification", "hr-letter", "insurance-certificate"];
const MAX_DOCS = 3000;

/** The lane as ask.js calls it: works out whether this caller may open People and HR, loads the app helpers lazily, then runs the lane. */
export async function runPeopleLaneFor(db, question, { today, auth }) {
  const canHr = await db.hrAllowed(auth);
  const [{ TENANT_SQL }, { audienceFilterSql }, { documentsHaveAudience }, { hrGateSql }] = await Promise.all([import("../scope.js"), import("../audience/sql.js"), import("../audience/probe.js"), import("../companyFilesStore.js")]);
  return runPeopleLane(db, question, { today, canHr, deps: { TENANT_SQL, audienceFilterSql, documentsHaveAudience, hrGateSql } });
}

/**
 * Read the people papers this caller may use and answer. `deps` carries the app helpers so this file stays testable:
 * { TENANT_SQL, audienceFilterSql, documentsHaveAudience, hrGateSql }.
 * @returns {Promise<{data: object, detail: string}|null>}
 */
export async function runPeopleLane(db, question, { today, canHr, deps }) {
  try {
    if (!readQuestion(question)) return null;
    const { TENANT_SQL, audienceFilterSql, documentsHaveAudience, hrGateSql } = deps;
    const hasAudienceColumn = canHr ? false : await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
    const audience = canHr ? "TRUE" : audienceFilterSql({ docAlias: "d", hasAudienceColumn });
    // A caller who may open People and HR sees every people paper; anyone else only the papers every other lane may use (not private, not
    // internal-audience, not filed in People and HR).
    const scope = canHr ? "TRUE" : `(${audience}) AND ${hrGateSql("d")}`;
    const rows = async (sql, p = []) => (await db.raw(sql, p)).rows ?? [];
    const docs = await rows(`SELECT d.id, d.document_type FROM documents d WHERE d.${TENANT_SQL} AND ${scope} AND replace(lower(d.document_type), '_', '-') = ANY($1::text[]) ORDER BY d.created_at, d.id LIMIT ${MAX_DOCS}`, [TYPES]);
    if (!docs.length) return null;
    const ids = docs.map((d) => d.id);
    const pages = await rows(`SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE p.${TENANT_SQL} AND p.document_id = ANY($1::uuid[]) ORDER BY p.document_id, p.page_no`, [ids]);
    const ex = await rows(`SELECT DISTINCT ON (x.document_id, x.field_key) x.document_id, x.field_key, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value FROM extractions x WHERE x.${TENANT_SQL} AND x.document_id = ANY($1::uuid[]) AND x.field_key = ANY($2::text[]) ORDER BY x.document_id, x.field_key, x.created_at DESC, x.id DESC`, [ids, WANTED_KEYS]);
    const byDoc = new Map(docs.map((d) => [d.id, { id: d.id, type: String(d.document_type).toLowerCase().replace(/_/g, "-"), fields: {}, pages: [] }]));
    for (const p of pages) byDoc.get(p.document_id)?.pages.push({ page_no: Number(p.page_no), text: String(p.text ?? "") });
    for (const e of ex) { const d = byDoc.get(e.document_id); if (d && e.value != null && String(e.value).trim()) d.fields[e.field_key] = String(e.value); }
    const r = answerPeople([...byDoc.values()], question, { today, canHr });
    if (!r) return null;
    const sources = r.docs.map((id) => ({ documentId: id, location: r.page != null ? { page: Number(r.page) } : { field: "document" } }));
    const data = { kind: "answer", text: r.text, facts: [], sources, confidence: 1, verifiedCount: sources.length, unverifiedCount: 0, closest: [], peopleLane: true };
    return { data, detail: r.intent, cite: r.docs.map((id, i) => ({ id, document_type: r.types?.[i] ?? null, page: r.page })) };
  } catch (err) {
    console.error("People lane failed, continuing with the older lanes:", err?.message);
    return null;
  }
}
