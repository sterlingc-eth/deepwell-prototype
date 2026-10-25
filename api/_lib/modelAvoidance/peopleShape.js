/**
 * People / ID lane, round 3: structure instead of word lists.
 *
 * THE DEFECT (verifier rounds 1 and 2): every fix was a narrow list of bad words, so each new variant of the same failure got through
 * ("see attached", "Mesa AZ", "must be printed in ink", a title line read as a name, an OMB number wrapped over four lines, a policy that
 * merely contains the heading "Medical Examiner's Certificate", an employee who became a customer).
 *
 * This module holds the four structural checks every reader of person-owned papers now shares. Pure. No I/O, no clock.
 *   1. nameShape()          does a value LOOK like a person's name (token count, case pattern, no function words / instructions, not a
 *                           place, an address, an organisation, a label or a fragment of the page title)? Scored by features; the caller
 *                           leaves the field empty when it does not.
 *   2. formControlMask()    which lines are the FORM's own control block (OMB number, form number, revision / edition line, the "Expires"
 *                           line that goes with them), including when it wraps over 2-4 lines. Those lines are never read for dates.
 *   3. idStructure()        which label-shaped lines the page has (a holder label, a number / class label, a date label): the structure of an
 *                           ID or certificate, as opposed to a sentence or a heading in a policy.
 *   4. dropPeopleIdFacts()  an HR or person-ID paper never carries customer_* or service_* facts (an employee is not a customer).
 */

import { startsWithGivenName, stripAccents, COMMON_SURNAMES, FOREIGN_SURNAMES, FIRST_NAMES } from "./firstNames.js";
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------------------------------------ 1. name shape */
const STATE_ABBR = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(" "));
// state names that are not also common given names / surnames
const STATE_NAMES = new Set(["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "hawaii", "idaho", "illinois", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "nebraska", "nevada", "ohio", "oklahoma", "oregon", "pennsylvania", "tennessee", "texas", "utah", "vermont", "wisconsin", "wyoming", "mexico", "sonora", "canada"]);
const CREDENTIALS = new Set(["md", "m.d", "do", "d.o", "dc", "d.c", "pa", "pa-c", "np", "dds", "dmd", "phd", "rn", "lpn", "cpa", "esq", "jr", "sr", "ii", "iii", "iv", "mba", "faap", "facp", "msn", "aprn", "dnp", "od"]);
const TITLE_PREFIX = new Set(["dr", "mr", "mrs", "ms", "mx", "prof"]);
const PARTICLES = new Set(["de", "del", "della", "di", "da", "dos", "van", "von", "der", "den", "la", "le", "el", "al", "bin", "ibn", "ben", "st", "san", "mac", "mc"]);
// Closed-class words: a person's name never contains one. Grammar, not topic.
const FUNCTION_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "first", "second", "third", "fourth", "fifth", "a", "an", "the", "of", "and", "or", "nor", "but", "for", "to", "in", "on", "at", "by", "with", "from", "as", "into", "onto", "per", "via", "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "has", "have", "had", "will", "would", "shall", "should", "must", "may", "might", "can", "could", "not", "no", "yes", "all", "any", "each", "every", "some", "if", "then", "than", "that", "this", "these", "those", "it", "its", "we", "you", "your", "our", "their", "his", "her", "my", "me", "us", "who", "whom", "whose", "what", "which", "when", "where", "why", "how", "here", "there", "please", "also", "only", "both", "either", "neither", "while", "until", "upon", "within", "without", "see", "below", "above", "attached", "enclosed", "following", "other", "same", "such", "more", "most", "less", "than", "so", "too", "very"]);
// Words of forms and instructions (what a form says to the person filling it in), not what it says about a person.
const FORM_VOCAB = new Set(["print", "printed", "type", "typed", "sign", "signed", "signature", "write", "written", "fill", "filled", "complete", "completed", "attach", "attached", "provide", "provided", "enter", "entered", "include", "included", "required", "require", "requires", "submit", "submitted", "bring", "check", "checked", "verify", "verified", "ink", "block", "letters", "legible", "legibly", "blank", "applicable", "optional", "mandatory", "initial", "initials", "unknown", "pending", "unavailable", "redacted", "illegible", "approved", "denied", "void", "copy", "original", "file", "record", "records", "note", "notes", "notice", "reminder", "instructions", "instruction", "directions", "section", "page", "line", "field", "box", "item", "items", "list", "name", "names", "date", "dates", "address", "phone", "telephone", "email", "number", "numbers", "license", "licence", "certificate", "certification", "card", "class", "expiration", "expires", "expiry", "issued", "issue", "status", "title", "position", "department", "manager", "supervisor", "employee", "employer", "applicant", "holder", "driver", "operator", "owner", "customer", "client", "vendor", "contractor", "technician", "journeyman", "electrician", "plumber", "plumbing", "master", "classification", "board", "state", "licensing", "commercial", "information", "attestation", "sheet", "form", "forms", "checklist", "application", "packet", "paperwork", "handbook", "policy", "policies", "procedure", "procedures", "program", "programs", "agenda", "orientation", "onboarding", "training", "outreach", "bonus", "benefits", "payroll", "referral", "schedule", "summary", "report", "letter", "memo", "agreement", "contract", "permit", "invoice", "quote", "estimate", "hire", "hired", "hiring", "new", "osha", "hour", "hours", "rate", "pay", "salary", "wage", "total", "amount", "balance", "account", "bank", "routing", "social", "security", "birth", "emergency", "contact", "relationship", "marital", "single", "married", "male", "female", "yes", "none", "construction", "driver's", "fleet", "pool", "vehicle", "vehicles", "truck", "trucks", "spare", "staff", "member", "members", "hourly", "team", "crew", "unit", "units", "temp", "temporary", "seasonal", "general", "unassigned", "assigned", "payment", "assignment", "await", "awaiting", "clearance", "cleared", "review", "reviewed", "approval", "processing"]);
// An organisation, a place, an address: not a person.
const ORG_WORDS = new Set(["inc", "inc.", "llc", "l.l.c", "ltd", "corp", "corporation", "co", "company", "companies", "group", "groups", "services", "service", "solutions", "systems", "enterprises", "holdings", "partners", "associates", "industries", "rental", "rentals", "equipment", "supply", "supplies", "air", "hvac", "heating", "cooling", "electric", "electrical", "mechanical", "roofing", "trucking", "transport", "transportation", "logistics", "freight", "motors", "auto", "automotive", "repair", "maintenance", "contractors", "builders", "properties", "realty", "management", "church", "school", "university", "college", "hospital", "clinic", "medical", "health", "healthcare", "dental", "pharmacy", "restaurant", "cafe", "market", "store", "shop", "garage", "bureau", "agency", "division", "authority", "commission", "county", "city", "town", "village", "district", "office", "offices", "center", "centre", "foundation", "association", "institute", "academy", "department", "dept", "ministry", "union", "bank", "credit"]);
// words that make a Title-Case pair a place, whatever the town ("Fountain Hills", "Apache Junction")
const PLACE_WORDS = new Set(["springs", "heights", "valley", "beach", "lake", "falls", "junction", "creek", "harbor", "harbour", "ridge", "grove", "hills", "village", "county", "parish", "township", "metro", "airport", "station", "canyon", "gardens", "plaza"]);
// suffixes of ordinary English words (instructions, status words, nouns), not of names; the few surnames that end this way are listed
// (only suffixes no real surname ends in: "Howard", "Edward", "Clement", "Hayward", "Trinity" are names)
const COMMON_WORD_SUFFIX = /(?:tion|sion|ness|able|ible|ious|eous|ative|itive)$|.{5}ment$/i;
// whole-word check: an -ing / -ed form of a form-instruction verb ("printing", "signed", "submitted", "completing") is an instruction, not a name; "Mildred", "Irving", "Walking" are not derived from one
const stemsOf = (w) => { const out = new Set(); const m = /^(.{3,}?)(ing|ed|es|s)$/.exec(w); if (!m) return out; const b = m[1]; out.add(b); out.add(b + "e"); if (/(.)\1$/.test(b)) out.add(b.slice(0, -1)); return out; };
const FORM_VERBS = new Set(["print", "type", "sign", "write", "fill", "complete", "attach", "provide", "enter", "include", "require", "submit", "bring", "check", "verify", "approve", "deny", "review", "process", "await", "clear", "assign", "pend", "redact", "initial"]); // verbs only: "Fielding" is not a form of "field" the noun
const isFormVerbForm = (w) => /(?:ing|ed)$/.test(w) && [...stemsOf(w)].some((x) => FORM_VERBS.has(x));
const ALL_STATE_NAMES = new Set([...STATE_NAMES, "washington", "virginia", "georgia", "indiana", "montana", "dakota", "carolina", "florida", "new york", "new jersey", "new hampshire", "new mexico", "west virginia", "north dakota", "south dakota", "north carolina", "south carolina", "rhode island", "columbia", "district of columbia"]);
const STREET_WORDS = new Set(["st", "street", "ave", "avenue", "rd", "road", "blvd", "boulevard", "ln", "ct", "pkwy", "parkway", "hwy", "cir", "trl", "ter", "suite", "ste", "apt", "unit", "floor", "box", "po"]);
const PLACEHOLDER = /^(?:n\/?a|none|tbd|unknown|redacted|x{3,}|\*{3,}|[-_.#█▇■□\s]+|\[?redacted\]?|signature|see\s+(?:above|below))$/i;

const isInitial = (t) => /^\p{Lu}\.?$/u.test(t);
const tokenCase = (t) => {
  if (isInitial(t)) return "IN";
  if (!/^\p{Lu}[\p{L}\p{M}'’]*(?:-\p{Lu}[\p{L}\p{M}'’]*)*$/u.test(t)) return null; // every part starts upper-case
  const letters = t.replace(/[^\p{L}]/gu, "");
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  if (upper === letters.length) return "UP";
  // OCR of an ALL-CAPS name drops a case here and there ("MONDRAGon", "KONKWO-REYEs"): mostly capitals with a lower-case tail is still ALL CAPS
  if (letters.length >= 5 && upper / letters.length >= 0.7 && /^\p{Lu}/u.test(letters) && !/\p{Ll}\p{Lu}/u.test(letters)) return "UP";
  return "TC";
};
const stripDot = (t) => t.replace(/\.$/, "");

/**
 * Does `raw` read like a person's name? Features, not a list of bad examples:
 *   - 2-4 name tokens (plus a title prefix and credentials); an initial is a token;
 *   - every token starts upper-case and the case style is consistent (Title Case or ALL CAPS), so a clause in lower case is out;
 *   - no closed-class word (articles, auxiliaries, prepositions, "must", "see") and no form / instruction vocabulary;
 *   - not a place ("Mesa AZ", "Phoenix, Arizona"), not an address, not an organisation;
 *   - not a fragment of the page's own title line.
 * @param {string} raw
 * @param {{kind?: 'person'|'examiner', maxCore?: number, titleLines?: string[]}} [opts]
 * @returns {{ok: boolean, value: string|null, why: string|null}}
 */
/**
 * Round 6: a word CLASS (not examples). A person's value never ENDS with a word that names an organisation, a place type, a unit of an organisation, a group of people,
 * a program, a vehicle or a piece of equipment ("Dallas Branch", "Austin Office", "Jordan Valley Clinic", "Fleet Team", "Alex Program"). Real surnames that double as
 * these words (Hall, Park, Lane, Field, Brooks, Ford, Mills) are deliberately NOT in the class.
 */
/** Compound / suffix forms of the same class (Substation, Roundhouse, Outpost, Division, Pavilion, Factory, Laboratory, Stadium, Ordnance ...), for words the list above has not seen. */
const NON_PERSON_SUFFIX = /^(?:[a-z]{3,}(?:yard|post|station|works|shop|tory|sory|ery|ary|ium|ion|ics|hangar|wharf)|(?:green|round|club|fire|power|store|court|boat|pump|light|work|guard|farm|school|hot|ware)house)$/;
const NON_PERSON_LAST = new Set(("branch branches office offices clinic clinics center centers centre dept department departments division divisions valley county counties inc llc ltd corp program programs team teams " +
  "fleet crew staff unit units depot yard warehouse plant site sites location locations region regional zone area district campus building bldg tower terminal hub lab labs laboratory studio " +
  "pool project projects account accounts desk line route store stores base port bay station stations ranch farm  works shop gallery library museum hospital school academy institute " +
  "council committee board bureau agency authority commission association society union club league partners holdings group groups services service solutions systems supply supplies " +
  "equipment vehicle vehicles truck trucks trailer trailers vans tractor loader machine machines tool tools kit kits parts inventory dispatch support operations ops admin administration " +
  "headquarters hq annex wing floor suite lot garage dock bureau registry registration permit license licence form forms sheet report reports record records file files list roster schedule " +
  "refinery foundry factory   plantation hangar wharf pier quay dock docks silo tank shed barn cellar vault bunker laboratory observatory kitchen laundry cafeteria canteen dormitory barracks greenhouse orchard nursery vineyard pipeline substation outpost headquarter " +
  "chapter brigade battalion squad squadron detachment cohort band order guild lodge cooperative collective alliance coalition consortium federation fellowship fraternity sorority ministry parliament senate tribunal " +
  "stadium arena theater theatre cinema chapel  cathedral  mosque synagogue shrine monastery convent seminary hostel hotel motel inn resort lounge diner bakery infirmary  surgery dispensary pantry shelter mission outreach network exchange vendor supplier contractor subcontractor distributor dealer dealership showroom " +
  "province state republic kingdom territory island islands peninsula mountain mountains  plateau prairie meadow   preserve reserve trail trails highway freeway turnpike  tunnel overpass interchange crossing airfield heliport seaport harbor harbour marina landing ferry carport compound complex facility facilities premises property properties tract parcel subdivision development " +
  "road street avenue boulevard drive  circle loop alley  square shipment delivery invoice invoices quote estimate proposal contract agreement policy policies manual handbook procedure procedures checklist training orientation safety compliance audit inspection section sector segment secretariat directorate cell extension addition " +
  "department hotline helpdesk desk counter window kiosk lobby warehouse yard shop store mart market plaza mall  county parish township metro city town village borough").split(/\s+/));
export function nameShape(raw, { kind = "person", maxCore = 4, titleLines = [] } = {}) {
  const fail = (why) => ({ ok: false, value: null, why });
  let s = collapse(raw).replace(/[;|]+$/, "").replace(/_{2,}.*$/, "").replace(/,+\s*$/, "").trim();
  if (!s || PLACEHOLDER.test(s)) return fail("empty");
  if (!/^\p{L}[\p{L}\p{M} .,'’-]*$/u.test(s)) return fail("characters");
  if (s.length > 60) return fail("long");
  const parts = s.split(/\s*,\s*/).filter(Boolean);
  let core; let cred = ""; let credSep = ", ";
  const isCred = (p) => p.split(/\s+/).every((w) => CREDENTIALS.has(w.toLowerCase().replace(/\.$/, "")));
  // a holder / employee / manager value "Town, DC" / "Town, PA" / "Town, MD" is a place: those two letters are a state far more often than a credential (examiners keep their credentials)
  if (kind !== "examiner" && parts.length === 2 && STATE_ABBR.has(parts[1].replace(/\.$/, "")) && parts[1] === parts[1].toUpperCase()) return fail("place");
  if (parts.length === 1) core = parts[0];
  else if (parts.length === 2 && isCred(parts[1])) { core = parts[0]; cred = parts[1]; }
  else if (parts.length === 2) {
    const right = parts[1]; const rt = right.split(/\s+/);
    if ((rt.length === 1 && (STATE_ABBR.has(right.replace(/\.$/, "")) && right === right.toUpperCase() && right.length === 2)) || ALL_STATE_NAMES.has(right.toLowerCase().replace(/\.$/, ""))) return fail("place"); // "City, ST" / "City, Washington": a comma and then any US state is a place; "Last, First" with a state-name first name stays unread (empty is the safe side)
    if (parts[0].split(/\s+/).length > 2 || rt.length > 3) return fail("comma-shape");
    core = `${right} ${parts[0]}`; // "Last, First Middle"
  } else if (parts.length === 3 && isCred(parts[1]) && isCred(parts[2])) { core = parts[0]; cred = `${parts[1]}, ${parts[2]}`; }
  else return fail("comma-shape");
  let toks = core.split(/\s+/).filter(Boolean);
  // title prefix (examiners only) and trailing credentials without a comma
  let prefix = "";
  if (toks.length && TITLE_PREFIX.has(stripDot(toks[0]).toLowerCase())) { const pre = toks.shift(); if (kind === "examiner") prefix = pre; }
  while (toks.length > 2 && CREDENTIALS.has(stripDot(toks[toks.length - 1]).toLowerCase())) { cred = cred ? `${toks.pop()} ${cred}` : toks.pop(); if (parts.length === 1) credSep = " "; }
  if (toks.length < 2 || toks.length > maxCore) return fail("token-count");
  const lows = toks.map((t) => stripDot(t).toLowerCase());
  // lexical features (an initial is a letter, not a word: "Ulises A. Larkspur")
  const words = lows.filter((w) => w.length > 1);
  if (words.some((w) => FUNCTION_WORDS.has(w))) return fail("function-word");
  if (words.some((w) => FORM_VOCAB.has(w) || isFormVerbForm(w))) return fail("form-vocabulary");
  if (words.some((w) => ORG_WORDS.has(w))) return fail("organisation");
  if (words.length && (NON_PERSON_LAST.has(words[words.length - 1].replace(/\.$/, "")) || (words[words.length - 1].length >= 7 && NON_PERSON_SUFFIX.test(words[words.length - 1]))) && !(kind === "examiner" && CREDENTIALS.has(words[words.length - 1]))) return fail("org-word");
  // morphology: a long word that ends like an ordinary English word (-tion, -ment, -ness, -able ...), or an -ing / -ed word that is not a known surname, is not a name
  for (const w of words) {
    if (w.length >= 6 && COMMON_WORD_SUFFIX.test(w)) return fail("common-word");
  }
  if (words.some((w) => PLACE_WORDS.has(w))) return fail("place");
  // case pattern
  const cases = toks.map((t, i) => (PARTICLES.has(stripDot(t)) && i > 0 && i < toks.length - 1 ? "PA" : tokenCase(t)));
  if (cases.some((c) => c == null)) return fail("case");
  const styles = new Set(cases.filter((c) => c === "UP" || c === "TC"));
  if (styles.size > 1) return fail("mixed-case");
  if (!cases.some((c) => c === "UP" || c === "TC")) return fail("initials-only");
  // a short ALL-CAPS token at the end is a state, not a surname part ("MESA AZ"); a mixed one too ("Mesa AZ")
  const last = stripDot(toks[toks.length - 1]);
  if (toks.length >= 2 && last.length === 2 && last === last.toUpperCase() && STATE_ABBR.has(last)) return fail("place");
  if (lows.some((w, i) => STATE_NAMES.has(w) && i === lows.length - 1)) return fail("place");
  if (lows.some((w, i) => STREET_WORDS.has(w) && i > 0)) return fail("address");
  // a name has at least one real word (not only initials / 1-letter parts), and an initial never leads a 2-token value of initials
  if (toks.filter((t) => !isInitial(t)).length < 1) return fail("initials-only");
  // a fragment of the page's own title line ("Orientation Agenda" inside "New Hire Orientation Agenda")
  const vw = lows;
  for (const tl of titleLines ?? []) {
    const tw = collapse(tl).toLowerCase().replace(/[^a-z' -]+/g, " ").split(/\s+/).filter(Boolean).filter((w) => !TITLE_PREFIX.has(w)); // a "Dr." in front of the very same words is not a longer title
    if (tw.length > vw.length && vw.every((w) => tw.includes(w))) return fail("title-fragment");
  }
  const body = [prefix, toks.join(" ")].filter(Boolean).join(" ");
  const value = cred ? `${body}${credSep}${cred}` : body;
  return { ok: true, value, why: null };
}

// a line that starts like a field label ("Employee Name Casey Example", "Driver's Name ...") is a label with its value, never a heading
const LABEL_START = /^(?:(?:driver|employee|new\s+hire|licensee|holder|cardholder|applicant|operator|examinee)'?s?\s+)?(?:full\s+|printed\s+)?name\b/i;
/** The title-ish lines of a page: its first three non-empty lines. */
export function titleLinesOf(pages) {
  const p = (pages ?? []).find((x) => String(x?.text ?? "").trim());
  // a title is a short heading line: a sentence (long, ends in a full stop) in the first lines is body text, not a title
  return String(p?.text ?? "").split(/\r?\n/).map((l) => collapse(l)).filter(Boolean).slice(0, 3).filter((l) => l.length <= 70 && l.split(/\s+/).length <= 9 && !/[.!?:]$/.test(l) && !/:|\d|\s{3,}|\t|\s\|\s/.test(l) && !LABEL_START.test(l));
}

/* ------------------------------------------------------------------------------------------------ 2. form-control block */
const BARE_DATE = /^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}[ -][A-Za-z]{3,9}\.?[ -]\d{2,4}|\d{1,2}[\/-]\d{4})$/;
const SEED_RES = [
  /\bOMB\b/i,
  /\bPaperwork\s+Reduction\b/i,
  /\b(?:rev(?:ision|ised)?\.?|edition|ed\.)\s*[:.]?\s*\(?\d/i,
  /^(?:rev(?:ision|ised)?|edition)\b[\s:.]*$/i,
  /^(?:omb\s+)?(?:control\s+)?(?:no|number|#)\.?\s*[:#]?$/i,
  /\bform\s+[A-Za-z]{0,6}[- ]?\d{1,5}[A-Za-z]?\s*(?:\(.*\))?\s*$/i,
  /^(?:form\s+)?(?:control|approval|authori[sz]ation)\s+(?:no|number|#)\b/i,
];
const CONT_LABEL = /^(?:expires?|expiration(?:\s+date)?|exp\.?(?:\s+date)?|rev(?:ision|ised)?(?:\s+date)?|revised|edition|date|valid\s+(?:through|until|thru)|approval\s+expires|omb\s+expires)\b[\s:.#-]*(.*)$/i;
const CONT_ID = /^(?:[A-Z]{0,6}[- ]?\d{3,5}(?:[-\/]\d{2,6}){0,2}|\d{4}-\d{3,4}|(?:omb|control)\s+no\.?.*)$/i;
/**
 * Which lines belong to the form's OWN control block: an OMB / control number, a form number, a revision or edition line, a "Paperwork
 * Reduction" notice, and the "Expires" label / date / number lines that wrap after them (up to 4 lines on). A holder's own expiry is
 * never inside such a block, so these lines are excluded from every date read.
 * @param {string[]} lines
 * @returns {boolean[]}
 */
export function formControlMask(lines, { ombOnly = false } = {}) {
  const mask = new Array(lines.length).fill(false);
  const L = lines.map((l) => collapse(l));
  const seedRes = ombOnly ? SEED_RES.slice(0, 2) : SEED_RES; // other industries: only a government OMB / Paperwork Reduction block (an invoice "Rev. 2" is not one)
  const isSeed = (t) => t.length <= 160 && seedRes.some((re, k) => re.test(t) && !(!ombOnly && k === 5 && /licen|certificate|driver|medical/i.test(t)));
  const isCont = (t) => {
    if (!t || t.length > 60) return false;
    if (BARE_DATE.test(t) || CONT_ID.test(t)) return true;
    const m = CONT_LABEL.exec(t);
    return !!m && (m[1] === "" || BARE_DATE.test(m[1].trim()) || CONT_ID.test(m[1].trim()));
  };
  for (let i = 0; i < L.length; i++) {
    if (!L[i] || !isSeed(L[i])) continue;
    mask[i] = true;
    // the wrapped tail: up to four following lines that are only a number, a date, or an Expires / Rev label (with its date)
    let k = i + 1;
    while (k < L.length && k <= i + 4 && (!L[k] || isCont(L[k]))) { if (L[k]) mask[k] = true; k++; }
  }
  return mask;
}
/** Pages with the form-control lines removed. */
export function stripFormControl(pages, opts) {
  return (pages ?? []).map((p) => {
    const ls = String(p?.text ?? "").split(/\r?\n/);
    const m = formControlMask(ls, opts);
    return m.some(Boolean) ? { ...p, text: ls.filter((_, i) => !m[i]).join("\n") } : p;
  });
}

/* ------------------------------------------------------------------------------------------------ 3. ID / certificate structure */
const G = {
  holder: "(?:(?:driver'?s?|licensee'?s?|holder'?s?|cardholder'?s?|applicant'?s?|examinee'?s?|operator'?s?|employee'?s?|certificate\\s+holder'?s?|registered\\s+owner|named\\s+insured|full|printed|new\\s+hire)\\s+)*(?:full\\s+|printed\\s+)?name|licensee|cardholder|registered\\s+owner",
  ident: "(?:(?:driver'?s?|cdl|operator'?s?|medical\\s+examiner'?s?|commercial\\s+driver'?s?)\\s+)?(?:licen[cs]e|lic\\.?|certificate|cert\\.?|card|registration|credential)\\s*(?:no\\.?|number|num\\.?|#)|dln|dl\\s*(?:no\\.?|number|#)|cdl\\s*(?:no\\.?|number|#)|(?:cdl\\s+|licen[cs]e\\s+|driver'?s?\\s+)?class(?:\\s+of\\s+(?:cdl|licen[cs]e))?|endorsements?|restrictions?",
  date: "(?:(?:[a-z']+\\s+){0,5}?(?:expiration|expiry|expires?|exp)(?:\\s+date)?|valid\\s+(?:through|until|thru)|iss(?:ued|ue)?(?:\\s+date)?|date\\s+(?:of\\s+)?issu(?:ed|ance)|date\\s+(?:of\\s+)?(?:the\\s+)?(?:medical\\s+)?exam(?:ination)?|exam(?:ination)?\\s+date|date\\s+(?:certificate\\s+)?signed)",
  dob: "dob|date\\s+of\\s+birth|birth\\s*date",
  examiner: "(?:medical\\s+)?examiner'?s?\\s+(?:printed\\s+)?(?:name|signature)|name\\s+of\\s+(?:the\\s+)?(?:medical\\s+)?examiner",
};
const GROUP_RES = Object.fromEntries(Object.entries(G).map(([k, v]) => [k, new RegExp(`^(?:\\d{1,2}[a-z]?[.)]?\\s+)?(?:${v})\\s*(?:\\([^)]*\\))?\\s*(?:[:#=.]\\s*|\\s+|$)(.*)$`, "i")]));
const valueLooksLikeAValue = (v) => {
  const t = collapse(v);
  if (!t || /^[_\-.\s█▇■□]+$/.test(t)) return true; // blank / redacted: a form to be filled in is still a form
  if (/\d/.test(t)) return t.split(/\s+/).length <= 8;
  const toks = t.split(/\s+/);
  return toks.length <= 5 && toks.every((w) => /^[A-Z][A-Za-z'’.,-]*$/.test(w) || /^[A-Z]\.?$/.test(w));
};
/**
 * The label groups a page prints as LABEL-SHAPED lines or cells (the label alone, or the label followed by a value): holder, ident (number / class),
 * date, dob. A sentence or a heading that merely mentions "license" or "expiration" is not label-shaped (its remainder is words, not a value).
 * @param {string[]} lines
 * @returns {{holder: number, ident: number, date: number, dob: number, groups: number}}
 */
export function idStructure(lines) {
  const out = { holder: 0, ident: 0, date: 0, dob: 0, examiner: 0 };
  for (const line of lines ?? []) {
    for (const cell of collapse(line).split(/\s{2,}|\t|\s\|\s/)) {
      const c = collapse(cell);
      if (!c || c.length > 140) continue;
      for (const g of ["holder", "ident", "date", "dob", "examiner"]) {
        const m = GROUP_RES[g].exec(c);
        if (m && valueLooksLikeAValue(m[1])) out[g]++;
      }
    }
  }
  return { ...out, groups: ["holder", "ident", "date", "dob", "examiner"].filter((g) => out[g] > 0).length };
}
/** Structure of a licence card or a certificate: a holder or a date-of-birth, a number or class, and a date. */
export function hasIdStructure(lines) {
  const s = idStructure(lines);
  return s.groups >= 3 || (s.ident > 0 && s.date > 0 && (s.holder > 0 || s.dob > 0)) || hasCardData(lines);
}
/**
 * A card or certificate read by OCR often loses its labels but keeps its DATA SHAPE: a name-shaped line, an identifier line (letters / digits, five or more digits),
 * and two or more dates. A policy, memo or checklist that merely names the paper has none of the three together.
 */
export function hasCardData(lines) {
  let names = 0; let ids = 0; let dates = 0;
  for (const raw of lines ?? []) {
    const t = collapse(raw);
    if (!t) continue;
    dates += (t.match(/\b\d{1,2}\s?[\/.-]\s?\d{1,2}\s?[\/.-]\s?\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length;
    const idLine = /^(?:(?:DLN|NO|ID|NUMBER|LIC)[:.#\s]+)?[A-Z0-9][A-Z0-9 -]{5,22}$/.exec(t) && (t.match(/\d/g) ?? []).length >= 5 && !/[\/]/.test(t);
    if (idLine) ids++;
    else if (t.length <= 44 && nameShape(t.replace(/[.]+$/, "")).ok) names++;
  }
  return names >= 1 && ids >= 1 && dates >= 2;
}
/** Structure of the DOT medical examiner's certificate: the holder, a licence number / class, and a date label. */
export function hasCertificateStructure(lines) {
  const s = idStructure(lines);
  return ((s.holder > 0 || s.examiner > 0) && s.date > 0 && s.ident > 0) || hasCardData(lines);
}
/** Structure of a new-hire sheet: label-shaped employee-ish lines (name / position / start / manager / pay) with values or blanks. */
const HR_LABELS = [/^(?:new[-\s]?hire|employee)?\s*(?:full\s+)?name\b/i, /^(?:job\s+)?(?:position|title)\b/i, /^start(?:ing)?\s+date\b/i, /^(?:hiring\s+|reporting\s+)?(?:manager|supervisor)\b|^reports?\s+to\b/i, /^(?:rate\s+of\s+pay|pay\s+rate|hourly\s+rate|salary)\b/i, /^employee\s+(?:number|id)\b/i, /^department\b/i];
// A scanned or photographed sheet turns handwriting into noise: the label is still a label, and what follows it is short and is not a sentence.
const noisyValueOk = (v) => { const t = collapse(v); return t.split(/\s+/).length <= 8 && !(/[.!?]$/.test(t) && t.split(/\s+/).length >= 3) && !/\b(?:the|and|is|are|must|will|shall|should|please|to|of|for|with)\b/i.test(t); };
export function hrLabelCount(lines, { lenient = false } = {}) {
  const hit = new Set();
  for (const line of lines ?? []) for (const cell of collapse(line).split(/\s{2,}|\t|\s\|\s/)) {
    const c = collapse(cell);
    HR_LABELS.forEach((re, i) => { const m = re.exec(c); if (m && c.length <= 90) { const rest = c.slice(m[0].length).replace(/^\s*[:#=-]\s*/, ""); if (valueLooksLikeAValue(rest) || (lenient && noisyValueOk(rest))) hit.add(i); } });
  }
  return hit.size;
}
/** A new-hire sheet labels WHO it is about: a name label (New Hire Name / Employee Name / Name) with a value or a blank. */
export function hrHasNameLabel(lines) {
  // the label is what matters (OCR of handwriting after it is noise): a "... Name" label whose remainder is short and is not a sentence
  return (lines ?? []).some((line) => collapse(line).split(/\s{2,}|\t|\s\|\s/).some((cell) => { const c = collapse(cell); const m = HR_LABELS[0].exec(c); return !!m && /name/i.test(m[0]) && c.length <= 90 && (() => { const n = c.slice(m[0].length).trim().split(/\s+/).filter(Boolean).length; return n <= 4 || /^\s*[:(]/.test(c.slice(m[0].length)) || (n <= 10 && !/[.!?]\s*$/.test(c)); })(); }));
}
/** A long identifier on a short line of its own (a licence number printed on a photographed card): seven or more consecutive digits, optionally one leading letter. */
export function hasLongIdNumber(lines) {
  return (lines ?? []).some((raw) => { const t = collapse(raw); return t.length <= 40 && /(?:^|[^\w])[A-Z]?\d{7,9}(?:[^\w]|$)/.test(t) && !/\$|\bph(?:one)?\b|\btel\b/i.test(t); });
}

/* ------------------------------------------------------------------------------------------------ 4. HR / person-ID guard */
export const PEOPLE_ID_TYPES = new Set(["hr-letter", "license-certification"]);
const NOT_FOR_PEOPLE = /^(?:customer_|service_|shop_)/;
/**
 * An HR paper or a person-ID paper is about an employee or a holder: it never carries a customer_* or service_* fact (the employee would
 * become a customer, a start date a work-order date).
 * @param {string} type canonical document type
 * @param {{field_key?:string,key?:string}[]} fields
 * @returns {{fields: object[], removed: object[]}}
 */
export function dropPeopleIdFacts(type, fields) {
  const rows = Array.isArray(fields) ? fields : [];
  if (!PEOPLE_ID_TYPES.has(String(type ?? ""))) return { fields: rows, removed: [] };
  const removed = []; const kept = [];
  for (const f of rows) {
    const k = String(f?.field_key ?? f?.key ?? "");
    if (NOT_FOR_PEOPLE.test(k) && f?.method !== "human" && f?.corrected_value == null) removed.push(f); else kept.push(f);
  }
  return { fields: kept, removed };
}

/* ------------------------------------------------------------------------------------------------ 5. evidence that a name is a person (round 5) */
const plain = (s) => stripAccents(s).toLowerCase().replace(/[^a-z' -]+/g, " ").replace(/['’]/g, "").replace(/\s+/g, " ").trim();
const SIGNATURE_CTX = /\b(?:signature|signed(?:\s+by)?|sign(?:ed)?\s+here|printed?\s+name|print\s+name|name\s+printed|name\s+\(print(?:ed)?\)|employee\s+sign|holder\s+sign|driver\s+sign|licensee\s+sign|applicant\s+sign|acknowledged\s+by)\b|_{4,}|^\s*x\s*[:._-]/i;
/**
 * How many LINES of `text` print a person's name (words in this order, or last-name-first). `inSignature` counts only the lines where the name stands in a
 * signature / printed-name position: on a signature or "printed name" line, or on the line right below one.
 */
export function nameOccurrences(value, text, { inSignature = false } = {}) {
  const words = plain(value).split(" ").filter((w) => w.length > 1 && !["dr", "mr", "mrs", "ms", "mx", "prof"].includes(w));
  if (words.length < 2) return 0;
  const fwd = ` ${words.join(" ")} `; const rev = ` ${[words[words.length - 1], ...words.slice(0, -1)].join(" ")} `;
  const lines = String(text ?? "").split(/\r?\n/);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = ` ${plain(lines[i])} `;
    if (!h.includes(fwd) && !h.includes(rev)) continue;
    if (inSignature && !(SIGNATURE_CTX.test(lines[i]) || (i > 0 && SIGNATURE_CTX.test(lines[i - 1])))) continue;
    n++;
  }
  return n;
}
/** Endings that make a word a surname far more than an everyday English word (Slavic, Nordic, Iberian, Italian, Greek, Armenian, Jewish, Irish prefixes). A shape test, not a list of examples. */
const SURNAME_ENDING = /(?:owski|ewski|ski|sky|ska|czyk|ov|ova|ev|eva|vich|ovic|evic|ez|az|oz|ini|elli|etti|ello|berg|stein|feld|baum|wald|dottir|opoulos|yan|sen|ssen|sson|lund|quist|gren|strom|holm|dahl|vik|stad|rud)$/;
const surnameShape = (x) => x.length >= 5 && (SURNAME_ENDING.test(x) || /^(?:mc|fitz|abdul)[a-z]{3,}$/.test(x));
/** The last word of a name by SHAPE: a known surname (incl. ones that are also English words) or a surname ending / prefix. */
export const surnameish = (w) => { const x = plain(w).replace(/ /g, ""); return COMMON_SURNAMES.has(x) || surnameShape(x); };
/** Surname evidence a label alone can trust: not also an everyday English word. */
function foreignSurname(w) {
  const x = plain(w).replace(/ /g, "");
  if (FOREIGN_SURNAMES.has(x) || surnameShape(x)) return true;
  if (w.includes("-") && x.split("-").length === 2 && x.split("-").every((p) => p.length > 1 && (FOREIGN_SURNAMES.has(p) || FIRST_NAMES.has(p) || surnameShape(p) || /^(?:al|el|bin|ibn|abu|abd)$/.test(p)))) return true;
  return false;
}
/**
 * Strong evidence for a name read off a label: its first word is a given name people have, OR it stands on the person-name label itself (\`onLabel\`, same line)
 * and ends in a surname-shaped word (so an uncommon first name is fine: "Thuy Pham", "Yazmin Begay", "Khalid Al-Rashid"), OR the same name is printed again in a
 * signature / printed-name position (label + signature line). Two arbitrary repeats do not count. Otherwise the field stays empty (a missing name is cheap, a wrong one is not).
 * @param {string} value a name that already passed nameShape
 * @param {string} fullText every page of the paper
 */
export function hasNameEvidence(value, fullText, { onLabel = false } = {}) {
  const real = plain(value).split(" ").filter((w) => w.length > 1 && !["dr", "mr", "mrs", "ms", "mx", "prof"].includes(w));
  const lastW = real[real.length - 1] ?? "";
  if (startsWithGivenName(value)) return true;
  // the label itself is the evidence for a person whose first name the list does not know, when the last word is a surname no English word shares
  if (onLabel && real.length >= 2 && foreignSurname(lastW)) return true;
  const sig = nameOccurrences(value, fullText, { inSignature: true });
  return sig >= 1 && nameOccurrences(value, fullText) >= 2;
}
