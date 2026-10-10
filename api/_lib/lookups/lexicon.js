/**
 * R31: the chatter / function-word lexicon shared by slotFill.js and technician.js (no imports, so neither can be caught in the
 * slotFill -> contactLookup -> technician import cycle with an uninitialized binding).
 */
export const LEX = new Set(
  (
    "what whats what's which where wheres where's who whos who's whose is are do does we have has got on file for of the a an at to in by with and my our their his her its " +
    "i me you us them they it this that there here please pls plz thanks thank thx ok okay hey hi hello yo um uh umm erm er mm mmm hmm so like just quick real really " +
    "actually right well then now again sorry bug boss asked wants want know tell give get pull up look lookup check find need can could would will should " +
    "customer client account unit system place house job site location located service mobile cell cellphone telephone contact call reach dial best way " +
    "phone number email e-mail mail address serial model brand manufacturer make tonnage name owner tenant resident lives live living stays " +
    "sit sits sitting go going info information details anything show one sec second minute moment hold hang gimme let see whenever asap sir buddy mate cheers lol haha " +
    "ring callback callbacks known thats that's anyway thing question good morning afternoon evening ph # no. nr num wait ah oh sure alright folks guys team someone somebody anyone today forgot remember remind thx yeah yep hiya howdy dear boss manager office file whichever whatever kindly"
  ).split(/\s+/)
);

/* ====================================================================================================================================
 * F4: WORD CLASSES. Different words, same meaning. Each class lists the ways people say one thing and the ONE word the question lanes
 * already read. A class maps words to a word, never a phrase to an answer: the lanes still compute the answer from the records.
 * Pure data + pure helpers (no imports), safe to import from anywhere.
 * ================================================================================================================================== */

/** Plain morphology: the base form of a plural / -ing / -ed word. Used to compare words by meaning instead of by spelling. */
export function stemWord(w) {
  let x = String(w ?? "").toLowerCase().replace(/[’']s$/, "");
  if (x.length <= 3) return x;
  if (/ies$/.test(x) && x.length > 4) return x.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(x)) return x;
  if (/(ches|shes|xes|sses|zes)$/.test(x)) return x.slice(0, -2);
  if (/s$/.test(x)) return x.slice(0, -1);
  if (/ing$/.test(x) && x.length > 5) { const b = x.slice(0, -3); return /(.)\1$/.test(b) ? b.slice(0, -1) : b; }
  if (/ed$/.test(x) && x.length > 4) { const b = x.slice(0, -2); return /(.)\1$/.test(b) ? b.slice(0, -1) : b; }
  return x;
}

/** Document types as people say them, beyond the base table in documentTypes.js. id -> words/phrases (singular and plural). */
export const EXTRA_DOC_TYPE_WORDS = {
  receipt: ["receipt", "receipts", "sales slip", "sales slips", "payment receipt", "payment receipts", "return slip", "return slips"],
  "delivery-ticket": ["delivery ticket", "delivery tickets", "delivery note", "delivery notes", "delivery slip", "delivery slips", "pickup ticket", "pickup tickets", "pick-up ticket", "pick-up tickets", "pick up ticket", "pick up tickets", "pickup slip", "pickup slips", "packing slip", "packing slips", "bill of lading", "bills of lading"],
  schedule: ["schedule", "schedules"],
  "price-list": ["price list", "price lists", "pricing sheet", "pricing sheets", "price sheet", "price sheets", "rate sheet", "rate sheets", "rate card", "rate cards"],
  statement: ["statement", "statements", "account statement", "account statements"],
  "insurance-certificate": ["insurance certificate", "insurance certificates", "certificate of insurance", "certificates of insurance", "insurance cert", "insurance certs", "insurance policy", "insurance policies", "coi", "cois"],
  "hr-letter": ["hr letter", "hr letters", "hr document", "hr documents", "hr paperwork", "employment letter", "employment letters", "offer letter", "offer letters"],
  "maintenance-agreement": ["service plan", "service plans", "service agreement", "service agreements", "service contract", "service contracts", "maintenance contract", "maintenance contracts", "membership", "memberships", "maintenance membership", "maintenance memberships"],
};

/** Canonical doc-type id for a word/phrase from EXTRA_DOC_TYPE_WORDS, or null. */
export function extraDocTypeFromWord(word) {
  const w = String(word ?? "").trim().toLowerCase();
  if (!w) return null;
  for (const [id, words] of Object.entries(EXTRA_DOC_TYPE_WORDS)) if (words.includes(w)) return id;
  return null;
}
/** Regex alternation (longest first) of every EXTRA_DOC_TYPE_WORDS phrase. */
export function extraDocTypeAlternation() {
  return [...new Set(Object.values(EXTRA_DOC_TYPE_WORDS).flat())]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

/**
 * Word classes applied as spelling-level canonicalization. [pattern, replacement]. Applied in order, only on whole words.
 * The replacement is a word the lanes already read; nothing here carries an answer.
 */
export const WORD_CLASS_RULES = [
  // workers: tech, technician, guy, installer, crew member -> technicians (never "Crew 2": a crew with a number is a name)
  [/\b(?:field\s+|service\s+|hvac\s+|install(?:ation)?\s+)?(techs?|installers?|repair\s?(?:men|man|guys?|people)|service\s+(?:guys|people|men|staff)|field\s+(?:guys|staff|people|workers)|crew\s+members?|crews)\b(?!\s*#?\d)/gi, (m, w) => (/(?:s|men|people|staff|workers)$/i.test(w) && !/^crew\s+members?$/i.test(w) || /^crew\s+members$/i.test(w) ? "technicians" : "technician")],
  [/\b(?:our\s+|the\s+)?(technicians)\s+(?:that\s+)?(?:we|do\s+we|are\s+we)\s+(?:use|using|have|employ|work\s+with|send\s+out|got|rely\s+on|dispatch|run)\b(?:\s+out)?/gi, "$1"],
  [/\bthe\s+guys\s+(?:we|that\s+we)\s+(?:send|sent|dispatch|use|have)\b(?:\s+out)?/gi, "technicians"],
  [/\b(?:the\s+)?(?:guys|people|folks)\s+(?:we|that\s+we)\s+(?:send|sent|dispatch)\s+out\b/gi, "technicians"],
  // equipment: machines, assets, rigs, appliances -> units
  [/\b(?:machines?|assets?|appliances?|rigs?)\b/gi, (m) => (/s$/i.test(m) ? "units" : "unit")],
  // agreements: service plan / maintenance plan / membership / service contract -> maintenance agreement
  [/\b(?:service|maintenance|care|protection)\s+(?:plan|contract|membership|program)s?\b/gi, (m) => (/s$/i.test(m) ? "maintenance agreements" : "maintenance agreement")],
  [/\b(?:signed\s+|customer\s+|annual\s+)?contracts?\b/gi, (m) => (/s$/i.test(m) ? "maintenance agreements" : "maintenance agreement")],
  [/\b(?:club\s+)?memberships?\b/gi, (m) => (/s$/i.test(m) ? "maintenance agreements" : "maintenance agreement")],
  // the verbs people use for "has one": signed / bought / enrolled in / subscribed to / on a
  [/(?<!\b(?:never|not|yet|ever|n't|no|nor|without)\s+(?:\w+\s+)?)\b(?:signed(?:\s+up)?(?:\s+for)?|bought|purchased|enrolled\s+in|subscribed\s+to|opted\s+(?:in|into)|are\s+on|is\s+on|got|took\s+out)\s+(?=(?:an?|the)?\s*maintenance agreements?)/gi, "have "],
  // money owed (unpaid, open balance, owes, outstanding) is read by the money lane's own wording, so it is not respelled here: a balance RANKING must stay a ranking.
  // paperwork
  [/\b(?:pieces?\s+of\s+)?(?:paperwork|papers|docs|files)\b/gi, "documents"],
];

/** Apply the word classes to a question. Returns the respelled question, or the same string when nothing applied. */
export function canonicalizeWordClasses(question) {
  let q = String(question ?? "");
  for (const [re, rep] of WORD_CLASS_RULES) q = q.replace(re, rep);
  return q.replace(/\s+/g, " ").trim();
}
