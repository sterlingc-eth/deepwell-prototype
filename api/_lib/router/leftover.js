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
const vocabDomainCache = new WeakMap();
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
    const domain = DOMAIN_WORDS.has(low) || CALENDAR.has(low) || Boolean(opts.domainWords?.has(low));
    return {
      t, i, low, stop, domain,
      negation: !stop && (NEGATION_WORDS.has(lowRaw) || NEGATION_WORDS.has(low)),
      strong: !stop && !domain && ((casingMeaningful && i > 0 && /^\p{Lu}\p{Ll}/u.test(t.text)) || hasLetterAndDigit(t.text)
        // an all-caps token of 2-5 letters in a mixed-case question is an initialism ("KP", "OV", "AOS", "RS"), i.e. a name's short form
        || (casingMeaningful && /^\p{Lu}{1,5}$/u.test(t.text) && !(t.text === "I" || CAPS_OK.has(low)))
        // a capitalized word that is not English, standing alone before a sentence break ("Navien. how many units"), is a name
        || (casingMeaningful && i === 0 && /^\p{Lu}\p{Ll}/u.test(t.text) && !isPlainWord(t.text) && /^[.,;:!?-]/.test(q.slice(t.end).trimStart()))),
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
      (prev && (SLOT_TRIGGERS.has(prev.low) || nameish(prev))) || (next && (nameish(next) || ENTITY_NOUNS.has(next.low))));
    // the word right after "how many" IS the thing being counted: when the lane did not use it, it counted something else ("how many sump pumps" -> every document)
    x.head = i === headIdx && !x.stop && !x.domain && !x.negation;
    // any other word right in front of the thing being counted is a modifier ("Watts units", "obsolete units"): if the lane did not use it, it was dropped
    // the word(s) right after in/at/near/from/around is a PLACE condition, even when it is also an English word ("in bend", "near mesa"): if the lane did not use it, the count would be the whole total
    x.placeSlot = (!x.stop || x.low === "co") && !x.negation && !x.domain && Boolean(prev) && PLACE_PREPS.has(prev.low) && !isOrdinalOrNumber(x.t.text) && !NOT_PLACES.has(x.low);
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
    if (normToks && !x.placeSlot && !normToks.has(clean(x.t.text)) && !opts.nameCorrections?.has(x.low)) continue;
    // a weekday / month the lane did not use, or a number / amount it did not use ("invoices on Tuesday", "between $100 and $500"), changes the answer when ignored
    const unusedDateOrNumber = CALENDAR.has(x.low) || /^\$\d|\d%$/.test(x.t.text);
    // a plain count of the whole entity is only right when the question named NO other condition: every content word and every number must have been used
    const plainResidue = Boolean(opts.plain) && !(x.domain && (entityWords.has(x.low) || BENIGN_DOMAIN.has(x.low) || opts.domainWords?.has(x.low) || (info[x.i - 1] && SCOPE_QUANT.has(info[x.i - 1].low)))) && !x.negation && ((!x.stop && x.low.length >= 3 && !/\d/.test(x.t.text)) || isOrdinalOrNumber(x.t.text));
    if (!(x.strong || x.placeSlot || x.weakInSlot || x.negatesName || x.beforeNoun || x.head || unusedDateOrNumber || plainResidue)) continue;
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
  if (out.length && process.env.DONOVAN_LEFTOVER_LOG) {
    try { fsMod.appendFileSync(process.env.DONOVAN_LEFTOVER_LOG, JSON.stringify({ lane: opts.lane ?? null, q, words: out }) + "\n"); } catch { /* diagnostic only */ }
  }
  return out;
}
