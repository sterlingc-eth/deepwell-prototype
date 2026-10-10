/**
 * R39: the leftover-condition check. "How many Navien units" in an organization that has no Navien used to answer with the whole unit total
 * (132) because the brand word matched no filter, was silently dropped, and a plain count came back. Same for "how many invoices did Dana
 * Whitfield do" in an organization with no such technician (120, every invoice).
 *
 * Principle: a deterministic lane may answer a count/list question only if every NAME-LIKE word of the question is actually USED by the lane's
 * own reading of the question. A word the lane did not use is an unexplained condition (a brand, city, person, vendor, model, a negation...):
 * the lane must not answer as if it were not there; it declines (null) so the question goes to the model / clarify path.
 *
 * Two independent tests, both must say "yes, this word is a condition nobody used":
 *   1. UNUSED (ablation, measured not guessed): re-read the question with that one word deleted; if the lane's reading (its plan / intent, serialized
 *      by the caller-supplied `signature`) is byte-identical, the word contributed nothing. No list of brands, cities or names is consulted, so it
 *      covers multi-word names, misspellings, numbers and operators, and stays right when a lane learns a new qualifier.
 *   2. LOOKS LIKE A NAME: ablation alone also flags harmless redundant words ("service" in "service visits", "over" in "over the last 8 weeks"). A
 *      word is only a leftover CONDITION when it (a) is typed like a name (capitalized in the middle of the sentence, or letters+digits like a model
 *      number), (b) is a negation ("not", "except", "other than"...) that points at such a name, or (c) is not an ordinary English word at all (the
 *      generated lexicon of plain words, which excludes every word that is ALSO a proper noun - "mesa", "carrier", "watts", "mark" stay name-like)
 *      AND sits where a name goes: right after "did/named/by/in/from/for...", next to another name-like word, or directly in front of the thing being
 *      counted ("Navien units", "navien units").
 *
 * Pure: no DB, no model. Kill switch: DONOVAN_LEFTOVER=0. Diagnostic: DONOVAN_LEFTOVER_LOG=<file> appends one JSON line per decline.
 */
import fsMod from "node:fs";
import { COMMON_WORDS } from "./lexicon.generated.js";
import { ENTITY_SYNONYMS } from "../analytics.js";

/** Pure grammar and filler words. NEVER put a brand, city, name, status or qualifier here. */
export const STOP_WORDS = new Set((
  "a an the of in on at for to by with from into onto about around as is are was were be been being am do does did done doing have has had having got get gets gotten " +
  "we our ours us i me my mine you your yours they them their it its this that these those there here what which who whom whose when where how many much " +
  "can could would should will shall may might must please tell show give find list count number total totals overall altogether combined currently now right today already ever still " +
  "so far just also any all some let lets know see look looking need needed needs want like out up down s than if then too very really actually even anything anyone something someone " +
  "whole entire different distinct unique separate individual current existing actual real another one ones kind kinds type types sort sorts way ways " +
  "we've we're we'd we'll i've i'd i'm you've you're they've they're there's thats that's whats what's let's it's " +
  "file files record records system systems database shop company business piece pieces item items thing things tenant account accounts " +
  "send sent sending write wrote written issue issued make made create created generate generated produce produced cut put " +
  "go goes went gone going come came took take taken run runs ran running log logged logging track tracked tracking keep kept held hold " +
  "and or but plus uh um hey hi ok okay thanks thank yes yeah books book across within along per " +
  "corp corporation inc incorporated llc ltd co started told day began most least more less fewer fewest many few several every each both single only top best worst biggest smallest largest highest lowest first last next previous before after since until over under above below between during through throughout upon onto"
).split(/\s+/).filter(Boolean));

/** Negations / exclusions: when the lane did not use one, its answer is the OPPOSITE of what was asked. */
export const NEGATION_WORDS = new Set((
  "not no never without except excluding exclude excluded excludes nor neither non none nothing isn't aren't wasn't weren't don't doesn't didn't haven't hasn't hadn't won't can't cannot " +
  "isnt arent wasnt werent dont doesnt didnt havent hasnt hadnt wont cant other others besides aside minus apart unless"
).split(/\s+/));

/** The things being counted / listed. A word that sits right in front of one of these and was not used is a dropped modifier. */
const ENTITY_NOUNS = new Set([
  ...Object.values(ENTITY_SYNONYMS).flat().flatMap((p) => String(p).toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 3),
  "heaters", "heater", "pumps", "pump", "softeners", "softener", "preventers", "preventer", "orders", "order", "estimates", "estimate", "contracts", "contract", "vendors", "vendor", "technicians", "technician",
]);
/** Domain words every Donovan lane already reads (the router's own noun vocabulary + field names). Plain, never a name. */
const DOMAIN_WORDS = new Set([
  ...Object.values(ENTITY_SYNONYMS).flat().flatMap((p) => String(p).toLowerCase().split(/[^a-z]+/)).filter(Boolean),
  "units", "invoices", "estimate", "estimates", "ac", "pm", "po", "pos", "nameplate", "startup", "tonnage", "ton", "tons", "refrigerant", "zip", "zips", "serial", "serials", "model", "models", "manufacturer", "manufacturers",
  "comfort", "heating", "cooling", "mechanical", "plumbing", "electric", "electrical", "services", "pros", "climate", "conditioning", "refrigeration", "contractors", "company", "brand", "brands", "tech", "techs", "dispatched", "dispatch", "permit", "permits", "preventive", "maintenance", "installed", "install", "installs", "installation", "warranty", "warranties",
  "repair", "repairs", "replacement", "emergency", "routine", "diagnostic", "inspection", "inspections", "tuneup", "seasonal", "unpaid", "overdue", "paid", "open", "closed", "pending", "verified", "unverified", "residential", "commercial", "mini", "split", "ductless", "rooftop", "furnace", "furnaces",
  "vendor", "vendors", "ok", "usa", "us",
]);

/** All-caps tokens that are ordinary trade / document abbreviations, not initials of a person or place. */
const CAPS_OK = new Set("hvac ac pm po pos ok usa us seer btu btus hp kw cfm gpm psi pdf id ids eta vin diy llc inc co ltd dba faq asap tbd na".split(" "));
/** Domain words that, in a plain whole-entity count, add no condition of their own ("how many units have we installed"). */
/** "across ALL customers", "each customer", "every site": a quantifier before a noun widens the scope, it names no condition. */
const PLACE_PREPS = new Set("in at near around from".split(" "));
// words that follow "in" without naming a place (a unit of time, a state of the equipment, a generic noun): not place conditions
const NOT_PLACES = new Set("years year months month weeks week days day hours hour minutes minute total general particular stock service use operation warranty progress time order number summary full short detail details addition average bulk".split(" "));
const SCOPE_QUANT = new Set("all every each across total our my your the".split(" "));
const BENIGN_DOMAIN = new Set("installed install installs installation tracked brand brands company estimate estimates".split(" "));
// E1: a misspelled word right in front of a job noun ("manitenance visits") is a dropped service-type qualifier when the lane did not use it
const JOB_NEXT = new Set("visits visit jobs job calls call tickets ticket repairs".split(" "));
const INSTALL_MODS = new Set("new recent total past last next first latest year years month months week weeks many much actual real hvac equipment unit units system systems".split(" "));
const vocabDomainCache = new WeakMap();
const GENERIC_TYPE_WORDS = new Set("unit units system systems equipment device devices type other misc general standard".split(" "));
/** Plain nouns of THIS organization's own data that are not names: its document-type labels and its kinds of equipment ("water heater (tank)"). */
export function domainWordsFromVocab(vocab) {
  if (!vocab || typeof vocab !== "object") return null;
  let set = vocabDomainCache.get(vocab);
  if (!set) {
    set = new Set();
    const add = (t) => { for (const w of String(t ?? "").toLowerCase().split(/[^a-z]+/)) if (w.length >= 2) set.add(w); };
    for (const d of vocab.docTypePhrases ?? []) add(d?.phrase);
    // "hvac" is benign only where the organization's own equipment looks like HVAC (or records no equipment types at all); in a plumbing shop "HVAC units" names a thing it has none of
    const types = (vocab.equipmentTypes ?? []).map((t) => String(t ?? "").toLowerCase());
    const hvacOk = !types.length || types.some((t) => /hvac|furnace|air condition|heat pump|condens|air handler|mini.?split|boiler|chiller|evaporator|package unit|rooftop|thermostat/.test(t));
    for (const w of vocab.industryWords ?? []) if (w !== "hvac" || hvacOk) set.add(w);
    // E1: the organization's own KINDS of equipment ("backflow preventer", "boiler", "water heater (tank)") are CONDITIONS on a unit count, not plain nouns: a lane that
    // did not filter on one (it counted every unit installed in 2022) must not be excused just because a document-type label shares the word.
    const typeWords = new Set();
    for (const t of vocab.equipmentTypes ?? []) for (const w of String(t ?? "").toLowerCase().split(/[^a-z]+/)) if (w.length >= 4 && !GENERIC_TYPE_WORDS.has(w)) typeWords.add(w.replace(/(?<!s)s$/, ""));
    set.typeWords = typeWords;
    vocabDomainCache.set(vocab, set);
  }
  return set;
}

const TOKEN_RE = /[\p{L}\p{N}$#%][\p{L}\p{N}\p{M}'’.&/%$#+-]*/gu;

/** @returns {{text:string,start:number,end:number}[]} word tokens with trailing punctuation trimmed */
export function tokenize(question) {
  const out = [];
  const s = String(question ?? "").normalize("NFC");
  for (const m of s.matchAll(TOKEN_RE)) {
    const text = m[0].replace(/[.'’&/+-]+$/g, "");
    if (!text) continue;
    const neg = /^(non)-(?=\p{L})/iu.exec(text); // "non-Carrier": the negation and the name are two tokens
    if (neg) { out.push({ text: neg[1], start: m.index, end: m.index + neg[1].length }); out.push({ text: text.slice(neg[0].length), start: m.index + neg[0].length, end: m.index + text.length }); continue; }
    out.push({ text, start: m.index, end: m.index + text.length });
  }
  return out;
}

export const TOO_LONG = "<question too long to check>";
export const GUARD_ERROR = "<guard error>";
/** Words that name a place inside a building or a street, never a brand / city / person. */
export const STREET_WORDS = new Set("street st avenue ave road rd drive dr lane ln boulevard blvd way court ct place pl circle cir trail trl parkway pkwy highway hwy floor suite ste apt apartment zone building bldg room lot block wing campus".split(" "));
/** True for a word that is grammar, a domain / trade term, a calendar word or a street word: never evidence of a name. */
export function isNotAName(w) {
  const x = clean(w);
  return STOP_WORDS.has(String(w).toLowerCase()) || STOP_WORDS.has(x) || DOMAIN_WORDS.has(x) || CALENDAR.has(x) || STREET_WORDS.has(x) || NEGATION_WORDS.has(x);
}
/**
 * POSITIVE evidence that the typed words (original casing) are a specific proper name: every word starts with a capital, is letters only (no digits),
 * is at least 3 letters, is not an all-caps token of 5 letters or fewer (an initialism: "HVAC", "KP", "GV", "AOS"), is not grammar / a domain term /
 * a calendar word / a street word, and at least one word is not an ordinary English word ("Navien", "Whitfield" - but never "Active", "Residential",
 * "Good Standing", "Oak Avenue"). Anything else is NOT evidence, and a lane that needed the evidence must decline.
 */
export function properNameTokens(rawWords) {
  if (!rawWords?.length) return false;
  let anyUnknown = false;
  for (const raw of rawWords) {
    const w = String(raw).replace(/[.,;:!?'’]+$/g, "").normalize("NFC");
    if (!/^\p{Lu}[\p{L}\p{M}'’-]*$/u.test(w)) return false;
    const letters = w.replace(/[^\p{L}]/gu, "");
    if (letters.length < 3) return false;
    if (w === w.toUpperCase() && letters.length <= 5) return false;
    if (w.includes("-") ? w.split("-").some((p) => p && isNotAName(p)) : isNotAName(w)) return false;
    if (!isPlainWord(w)) anyUnknown = true;
  }
  return anyUnknown;
}
/** Share of the question's words (3+ letters) typed with a capital: at 60% or more casing carries no information (Title Case / ALL CAPS questions). */
export function casingCarriesInformation(question) {
  const alpha = tokenize(question).filter((t) => /^\p{L}/u.test(t.text) && t.text.length >= 3);
  return !alpha.length || alpha.filter((t) => /^\p{Lu}/u.test(t.text)).length / alpha.length < 0.6;
}

export const leftoverEnabled = (env = process.env) => env?.DONOVAN_LEFTOVER !== "0";

let COMMON = null;
const common = () => (COMMON ??= new Set(COMMON_WORDS.split(" ")));
const fold = (w) => String(w).normalize("NFD").replace(/\p{M}+/gu, "");
const clean = (w) => fold(String(w).toLowerCase()).replace(/’/g, "'").replace(/'s$/, "");
/** An ordinary word: in the plain-English lexicon, or one of the router's own domain words (hyphenated compounds: every part plain). */
export function isPlainWord(w) {
  const x = clean(w);
  if (!x) return true;
  const c = common();
  if (DOMAIN_WORDS.has(x) || c.has(x)) return true;
  // the dictionary lists some inflections only through their stem ("repair" but not "repairs"/"repaired")
  for (const [suf, add] of [["s", ""], ["es", ""], ["ies", "y"], ["ed", ""], ["ed", "e"], ["ied", "y"], ["ing", ""], ["ing", "e"], ["er", ""], ["ers", ""], ["ly", ""], ["ment", ""], ["ments", ""], ["ness", ""]]) {
    if (x.length > suf.length + 2 && x.endsWith(suf)) {
      const stem = x.slice(0, -suf.length) + add;
      if (c.has(stem) || (suf.startsWith("ed") || suf.startsWith("ing") ? c.has(stem.slice(0, -1)) && stem.at(-1) === stem.at(-2) : false)) return true;
    }
  }
  if (x.includes("-")) return x.split("-").every((p) => !p || isPlainWord(p));
  return false;
}

const isOrdinalOrNumber = (t) => /^\$?\d[\d,.]*%?$/.test(t) || /^\d+(?:st|nd|rd|th)$/i.test(t);
const hasLetterAndDigit = (t) => /\p{L}/u.test(t) && /\d/.test(t);
const CALENDAR = new Set("january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(" "));
/** Words after which the owner types a NAME. */
const SLOT_TRIGGERS = new Set("did does do has have had by from for in at near named called to with of under and or than not".split(" "));

/**
 * Words of `question` that the lane did NOT use and that look like a named condition (see the file header).
 * @param {string} question
 * @param {(q:string)=>string|null} signature  the lane's deterministic reading of a question as a string (null = the lane has no reading).
 * @param {{maxTokens?:number, lane?:string, domainWords?:Set<string>}} [opts]
 * @returns {string[]} leftover condition words (empty = nothing was dropped, or the lane has no deterministic reading to check)
 */
export function leftoverWords(question, signature, opts = {}) {
  if (!leftoverEnabled()) return [];
  const q = String(question ?? "");
  if (!q.trim()) return [];
  // fail CLOSED: a question the guard cannot fully read (too long, or its own check errors) is never answered deterministically
  if (q.length > 400) return [TOO_LONG];
  let base;
  try { base = signature(q); } catch { return [GUARD_ERROR]; }
  if (base == null) return [];
  const allToks = tokenize(q);
  if (allToks.length > (opts.maxTokens ?? 40)) return [TOO_LONG];
  const toks = allToks;
  // Casing carries information only when the question is not typed in Title Case / ALL CAPS.
  const alpha = toks.filter((t) => /^\p{L}/u.test(t.text) && t.text.length >= 3);
  const capShare = alpha.length ? alpha.filter((t) => /^\p{Lu}/u.test(t.text)).length / alpha.length : 0;
  const casingMeaningful = capShare < 0.6;
  // pass 1: which words LOOK like names (before asking whether the lane used them)
  const info = toks.map((t, i) => {
    const low = clean(t.text);
    const lowRaw = t.text.toLowerCase().replace(/’/g, "'");
    const stop = STOP_WORDS.has(lowRaw) || STOP_WORDS.has(low) || isOrdinalOrNumber(t.text);
    const isTypeWord = Boolean(opts.domainWords?.typeWords?.has(low.replace(/(?<!s)s$/, "")));
    const domain = !isTypeWord && (DOMAIN_WORDS.has(low) || CALENDAR.has(low) || Boolean(opts.domainWords?.has(low)));
    return {
      t, i, low, stop, domain,
      negation: !stop && (NEGATION_WORDS.has(lowRaw) || NEGATION_WORDS.has(low)),
      strong: !stop && !domain && ((casingMeaningful && i > 0 && /^\p{Lu}\p{Ll}/u.test(t.text)) || hasLetterAndDigit(t.text)
        // an all-caps token of 2-5 letters in a mixed-case question is an initialism ("KP", "OV", "AOS", "RS"), i.e. a name's short form
        || (casingMeaningful && /^\p{Lu}{1,5}$/u.test(t.text) && !(t.text === "I" || CAPS_OK.has(low)))
        // a capitalized word that is not English, standing alone before a sentence break ("Navien. how many units"), is a name
        || (casingMeaningful && i === 0 && /^\p{Lu}\p{Ll}/u.test(t.text) && !isPlainWord(t.text) && /^[.,;:!?-]/.test(q.slice(t.end).trimStart()))),
      typeWord: isTypeWord && !stop,
      weak: !stop && !domain && !NEGATION_WORDS.has(lowRaw) && !NEGATION_WORDS.has(low) && !isPlainWord(t.text),
    };
  });
  const nameish = (x) => x && (x.strong || x.weak);
  let headIdx = -1;
  for (let i = 0; i < info.length - 1; i++) {
    const a = info[i].low, b = info[i + 1].low;
    if ((a === "how" && b === "many") || ((a === "number" || a === "count") && b === "of") || (a === "do" && false)) { headIdx = i + 2; break; }
  }
  while (headIdx >= 0 && info[headIdx] && info[headIdx].stop) headIdx++;
  info.forEach((x, i) => {
    const prev = info[i - 1], next = info[i + 1];
    x.weakInSlot = x.weak && Boolean(
      (prev && (SLOT_TRIGGERS.has(prev.low) || nameish(prev))) || (next && (nameish(next) || ENTITY_NOUNS.has(next.low) || JOB_NEXT.has(next.low))));
    // the word right after "how many" IS the thing being counted: when the lane did not use it, it counted something else ("how many sump pumps" -> every document)
    x.head = i === headIdx && !x.stop && !x.domain && !x.negation;
    // any other word right in front of the thing being counted is a modifier ("Watts units", "obsolete units"): if the lane did not use it, it was dropped
    // the word(s) right after in/at/near/from/around is a PLACE condition, even when it is also an English word ("in bend", "near mesa"): if the lane did not use it, the count would be the whole total
    x.placeSlot = (!x.stop || x.low === "co") && !x.negation && !x.domain && Boolean(prev) && PLACE_PREPS.has(prev.low) && !isOrdinalOrNumber(x.t.text) && !NOT_PLACES.has(x.low);
    // E1: the word right in front of "installs / installed / installation(s)" names WHAT was installed ("boiler installs in Tucson"): if the lane did not use it, the count is of every install
    x.beforeInstall = !x.stop && !x.negation && !CALENDAR.has(x.low) && x.low.length >= 4 && !INSTALL_MODS.has(x.low) && Boolean(next) && /^install(?:s|ed|ation|ations)$/.test(next.low) && !/\d/.test(x.t.text);
    x.beforeNoun = !x.stop && !x.domain && !x.negation && Boolean(next) && ENTITY_NOUNS.has(next.low);
    // a negation is a condition only when it points at a name ("not Carrier", "other than Trane", "without a Navien")
    let k = i + 1; while (info[k] && info[k].stop) k++;
    x.negatesName = x.negation && Boolean(info[k]) && (info[k].strong || (info[k].weak && info[k].t.text.length >= 5));
  });
  // a word the question normalizer already rewrote (a typo or abbreviation: "custs" -> "customers") is explained, not a condition nobody used
  let normToks = null;
  if (typeof opts.normalized === "string") normToks = new Set(tokenize(opts.normalized).map((t) => clean(t.text)));
  // the nouns of the entity the lane is counting ("units", "systems" for equipment): in a plain whole-entity count these are the question's subject, not a condition
  const entityWords = new Set((ENTITY_SYNONYMS[opts.entityKey] ?? []).flatMap((p) => String(p).toLowerCase().split(/[^a-z]+/)).filter(Boolean));
  entityWords.delete("hvac"); // a trade word, not a noun for the thing counted: it is only benign in an organization of that trade (opts.domainWords)
  const out = [];
  for (const x of info) {
    // (E1: a capitalized word the normalizer rewrote into another word - "Fujitsus" -> "fujitsu" - is a typed NAME: ablation decides whether the lane used it)
    if (normToks && !x.placeSlot && !x.strong && !(x.weak && info[x.i + 1] && JOB_NEXT.has(info[x.i + 1].low)) && !normToks.has(clean(x.t.text)) && !opts.nameCorrections?.has(x.low)) continue;
    // a weekday / month the lane did not use, or a number / amount it did not use ("invoices on Tuesday", "between $100 and $500"), changes the answer when ignored
    const unusedDateOrNumber = CALENDAR.has(x.low) || /^\$\d|\d%$/.test(x.t.text) || (/^(?:19|20)\d{2}$/.test(x.t.text) && !(info[x.i - 1] && CALENDAR.has(info[x.i - 1].low)));
    // a plain count of the whole entity is only right when the question named NO other condition: every content word and every number must have been used
    const plainResidue = Boolean(opts.plain) && !(x.domain && (entityWords.has(x.low) || BENIGN_DOMAIN.has(x.low) || opts.domainWords?.has(x.low) || (info[x.i - 1] && SCOPE_QUANT.has(info[x.i - 1].low)))) && !x.negation && ((!x.stop && x.low.length >= 3 && !/\d/.test(x.t.text)) || isOrdinalOrNumber(x.t.text));
    if (!(x.strong || x.typeWord || x.beforeInstall || x.placeSlot || x.weakInSlot || x.negatesName || x.beforeNoun || x.head || unusedDateOrNumber || plainResidue)) continue;
    const variant = `${q.slice(0, x.t.start)} ${q.slice(x.t.end)}`.replace(/\s+/g, " ").trim();
    let sig;
    try { sig = signature(variant); } catch { sig = base; }
    if (sig === base) { out.push(x.t.text); continue; }
  }
  // a multi-word name the lane did not use, where deleting any ONE word of it changes the reading ("Crew 2": "Crew" alone is read as a technician, "2" alone as a number) but
  // deleting the WHOLE phrase changes nothing: the phrase is a condition nobody used.
  for (let a = 0; a < info.length; a++) {
    for (let len = 2; len <= 3 && a + len <= info.length; len++) {
      const span = info.slice(a, a + len);
      if (span.some((x) => x.stop && !isOrdinalOrNumber(x.t.text)) || span.some((x) => out.includes(x.t.text))) continue;
      if (normToks && span.some((x) => !normToks.has(clean(x.t.text)))) continue;
      const namey = span.some((x) => (casingMeaningful && x.i > 0 && /^\p{Lu}\p{Ll}/u.test(x.t.text)) || hasLetterAndDigit(x.t.text) || (/^\p{Lu}{1,5}$/u.test(x.t.text) && !CAPS_OK.has(x.low)));
      if (!namey) continue;
      const variant = `${q.slice(0, span[0].t.start)} ${q.slice(span[len - 1].t.end)}`.replace(/\s+/g, " ").trim();
      let sig; try { sig = signature(variant); } catch { sig = base; }
      if (sig === base) for (const x of span) if (!out.includes(x.t.text)) out.push(x.t.text);
    }
  }
  // a quantity condition ("at least 2", "fewer than 10000", "3 or more", "exactly 1") the lane did not use: deleting the whole phrase changes nothing
  const NUMW = "(?:\\d[\\d,]*(?:\\.\\d+)?\\s*k?|one|two|three|four|five|six|seven|eight|nine|ten)";
  const CUE = "(?:at least|at most|no more than|no fewer than|not more than|not less than|more than|fewer than|less than|greater than|exactly|up to|over|under|below|above)";
  const QUANT_RE = new RegExp(`\\b(${CUE})\\s+(\\$?${NUMW})\\b(?!\\s*(?:years?|yrs?|months?|days?|weeks?|hours?|minutes?|%|percent|tons?)\\b)|\\b(${NUMW})\\s+(or\\s+(?:more|fewer|less))\\b`, "gi");
  const sigOf = (v) => { try { return signature(v.replace(/\s+/g, " ").trim()); } catch { return base; } };
  for (const m of q.matchAll(QUANT_RE)) {
    if (out.includes(m[0])) continue;
    const cueFirst = m[1] != null;
    const cue = cueFirst ? m[1] : m[4], num = cueFirst ? m[2] : m[3];
    // "at least 1" / "one or more" / "more than 0" only say the thing exists: saying nothing more than the plain noun, they change no count
    if (/^(?:at least\s+(?:1|one)|(?:1|one)\s+or\s+more|more than\s+(?:0|zero))$/i.test(m[0].trim())) continue;
    const cuePos = cueFirst ? m.index : m.index + m[0].length - cue.length;
    const whole = `${q.slice(0, m.index)} ${q.slice(m.index + m[0].length)}`;
    const cueOnly = `${q.slice(0, cuePos)} ${q.slice(cuePos + cue.length)}`;
    // the phrase is unused when removing all of it, or just its comparison words (leaving a number the lane then reads as a zip, a year, ...), changes nothing
    if (sigOf(whole) === base || sigOf(cueOnly) === base) out.push(m[0]);
    void num;
  }
  // a negation the lane dropped while it KEPT the word it points at ("non Carrier", typed lower case, read as "Carrier"): the answer would be the opposite set
  for (const x of info) {
    if (!x.negation || out.includes(x.t.text)) continue;
    let k = x.i + 1; while (info[k] && info[k].stop) k++;
    const y = info[k];
    if (!y || y.domain || CALENDAR.has(y.low) || y.negation) continue;
    const noNeg = (() => { try { return signature(`${q.slice(0, x.t.start)} ${q.slice(x.t.end)}`.replace(/\s+/g, " ").trim()); } catch { return undefined; } })();
    const noObj = (() => { try { return signature(`${q.slice(0, y.t.start)} ${q.slice(y.t.end)}`.replace(/\s+/g, " ").trim()); } catch { return undefined; } })();
    if (noNeg === base && noObj !== undefined && noObj !== base) out.push(x.t.text);
  }
  // B3 (round 2): grammar the lane did not read at all (a negation of a non-name slot, a top-N, a second measure clause, a service-type modifier).
  if (opts.grammar !== false) for (const w of unusedGrammar(q, signature, base)) if (!out.includes(w)) out.push(w);
  if (out.length && process.env.DONOVAN_LEFTOVER_LOG) {
    try { fsMod.appendFileSync(process.env.DONOVAN_LEFTOVER_LOG, JSON.stringify({ lane: opts.lane ?? null, q, words: out }) + "\n"); } catch { /* diagnostic only */ }
  }
  return out;
}

/* ------------------------------------------------------------------ B3: grammar markers (round 2) */

const NUM_TOKEN = "(?:\\d+|two|three|four|five|six|seven|eight|nine|ten)";
const SERVICE_TYPE_MOD = "(?:repair|repairs|emergency|emergencies|pm|pms|preventive|preventative|install|installation|installations|maintenance|diagnostic|inspection|tune-?ups?|startups?|callback|warranty)";
// "tickets" only: the service-visit readers already apply a type to "repair calls" / "PM visits"
const VISIT_NOUN = "(?:tickets?)";
/**
 * Pieces of a question that change the ANSWER and that a lane built for a plain positive count may never have read.
 * Each marker is a phrase to delete for the ablation test (see unusedGrammar); none is a list of dev wordings:
 * they are grammar families (negation, ranking, a second measure, a service-type modifier, a second head).
 */
const GRAMMAR_MARKERS = [
  // negation bound to a slot: "not 3 ton", "other than Danny", "anyone but Wyatt", "excluding Rheem", "weren't Goodman", "never invoiced"
  { kind: "negation", re: /\b(?:(?:any|every)(?:one|body)\s+but|all\s+but|but\s+not|other\s+than|aside\s+from|apart\s+from|excluding|except(?:ing)?|besides|never|not|[a-z]+n['’]t|isnt|arent|wasnt|werent|dont|doesnt|didnt|wont|cant)\b(?!\s*$)/gi },
  // ranking size: "top 5", "bottom three", "5 biggest"
  { kind: "topn", re: new RegExp(`\\b(?:top|bottom)\\s+${NUM_TOKEN}\\b(?=\\s+[a-z])|\\b${NUM_TOKEN}\\s+(?:most|least|biggest|largest|smallest|highest|lowest|best|worst|busiest|fewest)\\b`, "gi") },
  // the other end of a ranking asked beside the top: "top 3 ... and bottom 2", "the 2 smallest": no lane answers a bottom-N
  { kind: "bottom", re: new RegExp(`\\b(?:bottom|worst|lowest|smallest|fewest|least)\\s+${NUM_TOKEN}\\b|\\band\\s+(?:the\\s+)?(?:bottom|worst)\\b`, "gi") },
  // a share asked of a lane that only counts or lists: "what percent of ...", "what share of ..."
  { kind: "ratio", re: /\b(?:percent(?:age)?|share|proportion|fraction|portion|ratio)\s+of\b/gi },
  // the low end of a ranking: a lane built for "most" must not answer it
  { kind: "least", re: /\b(?:fewest|least)\b/gi },
  // a second measure asked of the same set: "and what did they total", "and their total value", "plus the average"
  { kind: "second-measure", re: /(?:,|\band\b|\bplus\b|\balso\b)\s+(?:what|their|its|the\s+(?:total|average|sum|count|number))\b.*$/i },
  // a money measure asked of a count lane: "total of X's invoices", "what did they add up to", "dollar value"
  { kind: "money-measure", optIn: true, re: /\b(?:total|sum)\s+(?:of|for)\b|\b(?:add(?:s|ed)?\s+up|dollar\s+value|came\s+to)\b|\bwhat\s+(?:did|do|does)\s+(?:they|it|those|these)\s+total\b|\btotal\s+(?:value|amount|dollars?)\b/gi },
  // a service-type modifier on visits: "repair tickets", "emergency calls"
  { kind: "service-type", re: new RegExp(`\\b${SERVICE_TYPE_MOD}\\s+(?=${VISIT_NOUN}\\b)`, "gi") },
  // a second counted head: "A and how many B", "count of A plus count of B", "A, and the number of B"
  { kind: "second-head", re: /(?:,|\band\b|\bplus\b|&)\s+(?:how\s+many|(?:the\s+)?(?:count|number)\s+of)\b.*$/i },
  // a repeated clause with its own window: "tickets in 2024, tickets in 2025 and tickets in 2026"
  { kind: "second-head", re: /(?:,|\band\b|\bplus\b)\s+(?:[a-z-]+\s+){0,3}(?:in|for|during)\s+(?:19|20)\d{2}\b.*$/i, needsYear: true },
  // an extreme pair: "smallest and largest"
  { kind: "pair-extreme", re: /\b(?:smallest|lowest|cheapest|oldest|newest|earliest)\s+(?:and|or|&)\s+(?:the\s+)?(?:largest|biggest|highest|priciest|newest|oldest|latest)\b/gi },
  // a second year the lane may have dropped: "2021 and 2022", "2019 to 2021"
  { kind: "year", optIn: true, re: /\b(?:19|20)\d{2}\b/g },
  // a window the lane may have ignored: half / quarter / through / combined / decade / year-before-last
  { kind: "period", optIn: true, re: /\b(?:first|second|1st|2nd)\s+half\b|\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b|\bq[1-4]\b|\bthrough\b|\bcombined\b|\ball\s+together\b|\byear\s+before\s+last\b|\b(?:19|20)\d0s\b/gi },
];

/** All marker spans of a question. */
export function grammarSpans(question, include = []) {
  const q = String(question ?? "");
  const out = [];
  for (const m of GRAMMAR_MARKERS) {
    // windows are read from the text at run time by some lanes (their plan never carries them), so these kinds are checked only by a lane whose reading includes its period
    if (m.optIn && !include.includes(m.kind)) continue;
    const re = new RegExp(m.re.source, m.re.flags.includes("g") ? m.re.flags : m.re.flags + "g");
    for (const x of q.matchAll(re)) {
      // a second clause needs a first one that already asked something ("customers outside Tucson, how many" has one head only)
      // a negation that leads straight into a status word is part of that word's own vocabulary ("hasn't paid", "not yet due", "isn't covered"), not a slot to complement
      if (m.kind === "negation" && /^\s+(?:(?:yet|been|all|fully|currently|still|already)\s+){0,2}(?:paid|pay|payed|due|covered|expired|working|active|current|open|closed|complete|completed|finished|scheduled|renewed|verified|late|overdue|owed|outstanding|registered|under|in\s+warranty)\b/i.test(q.slice(x.index + x[0].length))) continue;
      // "2021 and 2022": the FIRST year is the lane's ordinary period; only a further year can be a window the lane dropped
      if (m.kind === "year" && x.index === q.search(/\b(?:19|20)\d{2}\b/)) continue;
      if (m.needsYear && !/\b(?:in|for|during)\s+(?:19|20)\d{2}\b/i.test(q.slice(0, x.index))) continue;
      if ((m.kind === "second-head" || m.kind === "second-measure") && !m.needsYear && !/\b(?:how\s+(?:many|much)|number\s+of|count\s+of|total|what|which|who|list|show)\b/i.test(q.slice(0, x.index))) continue;
      // "all together" / "combined" on ONE period only says "in total": it combines nothing
      if (m.kind === "period" && /^(?:combined|all\s+together)$/i.test(x[0]) && (q.match(/\b(?:19|20)\d{2}\b/g) ?? []).length < 2) continue;
      out.push({ kind: m.kind, start: x.index, end: x.index + x[0].length, text: x[0] });
    }
  }
  // a ranking ("top 5", "biggest", "most") scoped to a place ("in Mesa") or a rolling window ("this month"): ranking lanes rank the whole shop, all time
  if (/\b(?:top|bottom|biggest|largest|best|highest|most|fewest|least|smallest|lowest|worst|busiest)\b/i.test(q)) {
    const MON = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|total|general|particular|all|each|every|order|numbers?|dollars?)$/i;
    for (const x of q.matchAll(/\b(?:in|at|near|around)\s+((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?)\b/g)) {
      if (x.index === 0 || MON.test(x[1].split(" ")[0])) continue;
      out.push({ kind: "rank-scope", start: x.index, end: x.index + x[0].length, text: x[0] });
    }
    for (const x of q.matchAll(/\b(?:this|last|past|current|previous)\s+(?:month|week|quarter|\d+\s+(?:days?|weeks?|months?))\b/gi)) out.push({ kind: "rank-scope", start: x.index, end: x.index + x[0].length, text: x[0] });
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

const YEAR = "(?:19|20)\\d{2}";
const EACH_RE = /\b(?:each|every|per\s+year|by\s+year|year\s+by\s+year|separately|respectively|individually|broken\s+down|side\s+by\s+side)\b/i;
const COMBINE_RE = /\b(?:combined|together|all\s+together|altogether|in\s+total|in\s+all|overall|across|both\s+years|between\s+them|all\s+told|summed|sum)\b/i;
const LEAD_START = /^(?:how\s+(?:many|much)|what(?:\s+(?:is|was|are|were))?(?:'s|s)?|who|which|total(?:s)?|the\s+(?:total|average|number)|number\s+of|count\s+of|average)\b/i;
/** The measure words after the second year that say "count each one" ("how many of each", "count each year") and so are not part of the clause. */
const EACH_TAIL_RE = /[\s,;]*(?:and\s+)?(?:(?:how\s+many|how\s+much|count|give\s+me\s+the\s+(?:count|number|totals?)|the\s+(?:count|number))\s+)?(?:of\s+)?(?:them\s+)?(?:for\s+|in\s+)?(?:each|every|per)(?:\s+(?:one|year))?[\s?.!]*$/i;

/**
 * Two bare years joined by "and"/"plus" ("total of invoices in 2024 and 2025", "proposals for 2024 and 2025, count each year",
 * "total billed across 2023 and 2024"): a bare second year is read by some lanes as a dollar amount ($2,025) or silently dropped (the first
 * year alone answers). It is respelled so no lane has to guess:
 *   - "each / per year / versus / how many of each"  -> one explicit clause per year (decompose/compound.js answers them in order, labelled)
 *   - "combined / together / across / plus / in total" -> one window, "2023 and 2024 combined" (two consecutive years; others are left alone)
 *   - neither word                                   -> two windows (the older respelling)
 * null when there is nothing to do (a "between ... and" range, years already combined, one year).
 */
function periodPairRewrite(question) {
  const q = String(question ?? "");
  const m = q.match(/\b((?:19|20)\d{2})\s+(?:and|&|plus)\s+(?:in\s+|for\s+|during\s+)?((?:19|20)\d{2})\b/i);
  if (!m || m[1] === m[2]) return null;
  if (/\b(?:between|from)\s+(?:the\s+years?\s+)?$/i.test(q.slice(0, m.index))) return null; // a range, not two windows
  const joiner = /\bplus\b/i.test(m[0]);
  let pre = q.slice(0, m.index);
  const post = q.slice(m.index + m[0].length);
  const eachOf = /\b(?:each|every)\s+of\s+$/i.test(pre);
  if (eachOf) pre = pre.replace(/\b(?:each|every)\s+of\s+$/i, "");
  if (/^\s+(?:combined|together|all\s+together|altogether|in\s+total)\b/i.test(post)) return null; // handled by the combined-window reader
  if ((q.match(new RegExp(`\\b${YEAR}\\b`, "g")) ?? []).length !== 2) return null; // three or more periods: not handled here
  const each = eachOf || EACH_RE.test(q) || /\b(?:vs\.?|versus)\b/i.test(q);
  const combine = !each && (joiner || COMBINE_RE.test(`${pre} ${post}`));
  const consecutive = Math.abs(Number(m[1]) - Number(m[2])) === 1;
  const respelled = /^\s*(?:and|&)\s+(?:in|for|during)\s+/i.test(m[0].slice(m[1].length));
  const old = () => (joiner || each || respelled ? null : `${pre}${m[1]} and in ${m[2]}${post}`);
  // non-consecutive years cannot be one window: they are answered one per year (never one year dropped)
  if (combine && consecutive) {
    const lo = Math.min(Number(m[1]), Number(m[2])); const hi = Math.max(Number(m[1]), Number(m[2]));
    const pre2 = pre.replace(/\b(?:across|over|throughout)\s+$/i, "in ").replace(/\b(?:across|over|throughout)\b/gi, "in");
    const post2 = post.replace(COMBINE_RE, "").replace(/\s{2,}/g, " ");
    return `${pre2}${lo} and ${hi} combined${post2}`.replace(/\s+/g, " ").trim();
  }
  pre = pre.replace(/\b(?:across|over|throughout)\s+$/i, "in ");
  if (!each) {
    // no word says which: the older respelling when the clause already opens with a measure ("total of invoices in ..."), else explicit clauses
    const lead0 = pre.trim();
    if (LEAD_START.test(lead0) && /\b(?:in|for|during)\s*$/i.test(pre)) return old();
  }
  // explicit clauses
  let body = `${pre}\u0001${post}`.replace(EACH_TAIL_RE, "").trim().replace(/[,;]\s*$/, "");
  let leadWord = null;
  if (/\bhow\s+many\b|\bcount\b|\bnumber\s+of\b/i.test(`${pre} ${post}`) && !LEAD_START.test(body)) leadWord = "how many";
  {
    // "2023 plus 2025 invoice total" / "each of 2024 and 2025 invoice totals": the year first, then the noun and the measure
    const lm = body.match(/^\u0001\s+((?:[a-z]+\s+)?[a-z]+?)\s+(totals?|counts?)$/i);
    if (lm) { const noun = /s$/i.test(lm[1]) ? lm[1] : `${lm[1]}s`; body = `${/^count/i.test(lm[2]) ? "how many" : "what is the total of"} ${noun} in \u0001`; leadWord = null; }
  }
  if (!LEAD_START.test(body)) {
    // "invoice count for 2022" / "invoice totals for 2022": the noun first, the measure after it
    const nm = body.match(/^(?:the\s+)?((?:[a-z]+\s+)?[a-z]+?)\s+(count|total|totals)\s+(.*)$/i);
    if (nm) { const noun = /s$/i.test(nm[1]) ? nm[1] : `${nm[1]}s`; body = `${nm[2].toLowerCase() === "count" ? "how many" : "what is the total of"} ${noun} ${nm[3]}`; leadWord = null; }
  }
  if (leadWord && !body.includes("\u0001")) return null;
  if (leadWord) body = `${leadWord} ${body.replace(/\b(?:count|the\s+number\s+of)\b\s*/i, "").replace(/\s+/g, " ")}`;
  if (!LEAD_START.test(body) && eachOf && /^(?:the\s+)?[a-z]+(?:\s[a-z]+)?\s+(?:in|for|during)\s+\u0001$/i.test(body)) body = `how many ${body}`;
  if (!LEAD_START.test(body)) return null; // no measure to repeat: not rewritten
  if (!body.includes("\u0001")) return null;
  // a year with no preposition before it ("how many invoices 2023") gets "in"
  body = body.replace(/([a-z]+)\s+\u0001/i, (mm, w) => (/^(?:in|for|during|of|from|by|since|to)$/i.test(w) ? mm : `${w} in \u0001`));
  const mk = (y) => body.replace("\u0001", y).replace(/\b(in|for|during|of)\s+(?=(?:in|for|during)\s)/i, "").replace(/\s+/g, " ").trim();
  return `${mk(m[1])}, and ${mk(m[2])}`;
}

const NAME_P = "[A-Z][\\p{L}'\u2019.-]+(?:\\s+[A-Z][\\p{L}'\u2019.-]+){1,3}";
const DOC_N = "(?:documents?|docs?|paperwork|files?|records?)";
const COUNT_LEAD = "(?:how\\s+many|count(?:\\s+up)?|number\\s+of|what(?:'s|\\s+is)\\s+the\\s+(?:number|count)\\s+of|tell\\s+me\\s+how\\s+many)";
const SCOPE_REL = new RegExp(`^${COUNT_LEAD}\\s+(?:of\\s+)?(?:the\\s+|our\\s+|all\\s+)?${DOC_N}\\s+(?:(?:are|is)\\s+)?(?:filed\\s+(?:under|for|on|against)|(?:(?:that|which)\\s+)?(?:mention|name|reference|involve)(?:s|ing)?|(?:are\\s+)?(?:about|on|under|regarding|attached\\s+to|linked\\s+to|tied\\s+to))\\s+(${NAME_P})\\s*[?.!]?$`, "u");
const SCOPE_SUBJ = new RegExp(`^${COUNT_LEAD}\\s+(?:of\\s+)?(?:the\\s+|our\\s+)?${DOC_N}\\s+(?:does|has|is)\\s+(${NAME_P})\\s+(?:appear\\s+(?:on|in)|show\\s+up\\s+(?:on|in)|have\\s+on\\s+file|have|filed)\\s*[?.!]?$`, "u");
const SCOPE_TECH = new RegExp(`^${COUNT_LEAD}\\s+(?:the\\s+)?([a-z]+(?:\\s+[a-z]+){0,2})\\s+(?:(?:that|which)\\s+)?(?:list(?:s|ing)?|name[sd]?|show(?:s|ing)?|carr(?:y|ies)|have|has|with)\\s+(${NAME_P})\\s+as\\s+(?:the\\s+|their\\s+|its\\s+)?(?:assigned\\s+)?tech(?:nician)?\\s*[?.!]?$`, "u");

/**
 * Subject-scope respelling (B2, round 3). "documents filed under X / paperwork on X / documents that mention X / documents X appears on" all ask for the
 * documents of one named person, the same question the lookups already answer as "how many documents do we have for X" (a customer's documents, or the
 * documents that carry a technician by that name). "service tickets that list X as the technician" is the technician-scoped count, spelled the way
 * the technician count lane reads it. No name is looked up here; the lanes decide which kind of person X is and say so. null when it is not that shape.
 */
function scopeRewrite(question) {
  const q = String(question ?? "").trim();
  if (!q || q.length > 160) return null;
  let m = q.match(SCOPE_REL) ?? q.match(SCOPE_SUBJ);
  if (m) return `how many documents do we have for ${m[1]}`;
  m = q.match(SCOPE_TECH);
  if (m && !new RegExp(`^${DOC_N}$`, "i").test(m[1])) return `how many ${m[1]} were done by ${m[2]}`;
  return null;
}

/** Respellings that make a question's period and subject scope explicit before any lane reads it (periodPairRewrite, then scopeRewrite). */
export function yearPairRewrite(question) {
  return periodPairRewrite(question) ?? scopeRewrite(question);
}

/**
 * Grammar markers the lane never read: delete the marker phrase and re-read the question; if the lane's reading (`signature`) is byte-identical,
 * the marker contributed nothing and the answer addresses a different (usually positive / bigger / simpler) question than the one typed.
 * A lane that does read the marker changes its reading when it is deleted, so it is never flagged. Pure.
 * @returns {string[]} the marker phrases that went unused
 */
/** "top 0" asks for nothing; above 25 is more than any ranking reader lists: both are released, never answered with a different size. */
function badTopN(text) {
  const m = String(text).match(/\d+/);
  if (!m) return false;
  const n = Number(m[0]);
  return n === 0 || n > 25;
}
export function unusedGrammar(question, signature, base, opts = {}) {
  const q = String(question ?? "");
  let b = base;
  if (b === undefined) { try { b = signature(q); } catch { return [GUARD_ERROR]; } }
  if (b == null) return [];
  const out = [];
  for (const sp of grammarSpans(q, opts.include ?? [])) {
    const variant = `${q.slice(0, sp.start)} ${q.slice(sp.end)}`.replace(/\s+/g, " ").trim();
    let sig; try { sig = signature(variant); } catch { sig = b; }
    // the lane read the marker word itself as a NAME ("not" taken for a person): the marker was not read as grammar
    const asName = sp.kind === "negation" && /^[a-z]+$/i.test(sp.text.trim()) && String(b).toLowerCase().includes(`"${sp.text.trim().toLowerCase()}"`);
    // a single-slot count lane that stops recognising the question once the marker is gone had no place for it either (opts.nullUnused)
    if (sig === b || asName || (opts.alwaysSecond !== false && (sp.kind === "second-head" || sp.kind === "second-measure" || sp.kind === "bottom")) || (sp.kind === "rank-scope" && opts.include?.includes("year")) || (sp.kind === "topn" && (opts.topnAlways || badTopN(sp.text))) || ((opts.nullUnused || (sp.kind === "topn" && opts.include?.includes("year"))) && (sig == null || sig === "null"))) out.push(sp.text.trim()); // a second clause is never read by a lane that answers one question (decompose/compound.js splits those first)
  }
  return out;
}
