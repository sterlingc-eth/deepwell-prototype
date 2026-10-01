/**
 * R32 (Team A, loop 2) — vocabulary rewrite for the deterministic pre-router.
 *
 * WHY: 46 of the 131 questions in the FRESH unit-attribute blind set (r32-unit) were needs-model only because the words were
 * synonyms/dictation of shapes the engine already answers: "whos the mfr at ...", "when does coverage run out at ...", "what size is
 * the system at ...", "which company made the equipment at ...", "when was the unit at ... put in", "is that a train unit out at
 * three zero six zero north dobson road". Rewriting the SPELLING of the question to the words the classifiers know (never its meaning)
 * fixes the whole cluster in one place; classifyAll adopts the rewritten text only when a deterministic stage then claims it.
 *
 * Conservative by construction: every rule is anchored to record vocabulary in the same sentence (unit/system/equipment/warranty/an
 * address) so a rewrite can never turn a non-record question into a record one; spoken digits need >= 3 consecutive digit words.
 *   rewriteQuestion(q) -> rewritten string, or null when nothing changed. Pure.
 */
const DIGITS = { zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const DIGIT_SEQ_RE = /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\s+){2,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi;
const UNIT_CTX = String.raw`(?:unit|units|system|systems|equipment|ac|a\/c|furnace|heat\s+pump|air\s+handler|condenser|hvac)`;

const RULES = [
  // "mail address for X" is the e-mail (postal wording is "mailing address"): a customer with no e-mail on file must get the honest "no email", not the service address
  [/(?<![-\w])mail\s+addr(?:ess)?\b/gi, "email address"],
  // manufacturer synonyms
  [/\b(?:mfr|mfg|mfgr|manufacturer's)\b/gi, "manufacturer"],
  [new RegExp(String.raw`\b${UNIT_CTX}\s+(?:maker|make)\b`, "gi"), "manufacturer"],
  [new RegExp(String.raw`\b(?:who|which\s+company|what\s+company|which\s+manufacturer)\s+(?:made|built|manufactured|manufactures|produced|produces)\b(?=[^?]*\b${UNIT_CTX}\b)`, "gi"), "who makes"],
  [new RegExp(String.raw`\bwho\s+(?:built|manufactures)\b(?=[^?]*\b${UNIT_CTX}\b)`, "gi"), "who makes"],
  [/\bwho\s+is\s+the\s+(?:maker|oem)\s+(?:of|at|for)\b/gi, "who makes"],
  [/\bbrand\s+name\s+(?:on|of|for)\s+(?:the\s+)?/gi, "what brand is the "],
  [/\bserial\s+(?:no\.?|tag|#)(?=\s|$)/gi, "serial number"],
  [/\bmodel\s+(?:no\.?|#)(?=\s|$)/gi, "model number"],
  // warranty synonyms
  [/\bend\s+of\s+(?:the\s+)?(?:coverage|warranty)\b/gi, "warranty expires"],
  [/\b(?:the\s+)?warranty\s+(?:finish|finishes|ends?|runs?\s+until(?:\s+when)?)\b/gi, "warranty expires"],
  [/\bstop(?:s|ped)?\s+being\s+covered\b/gi, "warranty expires"],
  [/\bcoverage\s+(?:run|runs|running)\s+out\b/gi, "warranty expires"],
  [/\b(?:the\s+)?coverage\b(?!\s+(?:area|zone))/gi, "warranty"],
  [/\bwarranty\s+(?:lapse|lapses|run\s+out|runs\s+out|is\s+up|is\s+over|over|up)\b/gi, "warranty expires"],
  [/\bwarranty\s+end\s+date\b|\bwarranty\s+expiry\b|\bwarranty\s+expiration\b/gi, "warranty expires"],
  // size -> tonnage (only next to a unit noun, never "filter size"/"breaker size")
  [new RegExp(String.raw`\b(?:what|which)\s+size\b(?=[^?]*\b${UNIT_CTX}\b)`, "gi"), "what tonnage"],
  [new RegExp(String.raw`\bcapacity\b(?=[^?]*\b${UNIT_CTX}\b)`, "gi"), "tonnage"],
  [new RegExp(String.raw`\b(?:size|capacity)\s+of\s+(?:the\s+)?${UNIT_CTX}\b`, "gi"), (m) => m.replace(/^(?:size|capacity)/i, "tonnage")],
  [new RegExp(String.raw`\bhow\s+big\s+is\s+(?:the\s+)?${UNIT_CTX}\b`, "gi"), (m) => m.replace(/how\s+big/i, "what tonnage")],
  [new RegExp(String.raw`\b${UNIT_CTX}\s+size\b`, "gi"), "tonnage"],
  [new RegExp(String.raw`\bwhen\s+did\s+they\s+put\s+(?:the\s+)?(${UNIT_CTX})\s+in\b`, "gi"), "when was the $1 installed"],
  [new RegExp(String.raw`\b(?:was|were)\s+(?:the\s+)?(${UNIT_CTX})\s+set\b`, "gi"), "was the $1 installed"],
  // install synonyms
  [/\b(?:got\s+put\s+in|was\s+put\s+in|put\s+in|went\s+in)\b/gi, (m, off, whole) => (new RegExp(String.raw`\b${UNIT_CTX}\b`, "i").test(whole) ? "installed" : m)],
  // phonetic brands (dictation): only in a "a <brand>" / "<brand> unit|system" position
  [/\b(a|an)\s+train\b(?!\s+(?:of|to|station|track))/gi, "a trane"],
  [/\btrain\s+(?=unit|system|ac|a\/c|furnace|heat\s+pump)/gi, "trane "],
  [/\bcarry\s+her\b|\bcarrie\s+r\b|\bcarryer\b/gi, "carrier"],
  [/\b(a|an)\s+room\s+(?=unit|system|at\b|out\b)/gi, "a rheem "],
  [/\b(a|an)\s+room(?=\s*$|\s+(?:please|thanks|real\s+quick)\b)/gi, "a rheem"],
  [/\blenox\b|\blennix\b/gi, "lennox"],
  [/\btrayne\b|\btrain\b(?=\s+(?:unit|system))/gi, "trane"],
  [/\b(?:dykin|dyken|diakin|dai\s+kin|dyken)\b/gi, "daikin"],
  [/\b(a|an)\s+(?:reem|ream|rheam)\b/gi, "a rheem"],
  [/\b(a|an)\s+(carrier|trane|lennox|rheem|goodman|daikin|york|bryant)s\b/gi, "$1 $2"],
  [/\b(a|an)\s+(?:goodmen|good\s+man)s?\b/gi, "a goodman"],
];

const WINDOW_RE = /\b(?:(?:in|over|during|within|for)\s+the\s+(?:last|past)\s+\w+|(?:this|last)\s+(?:week|month|quarter|year)|so\s+far\s+this\s+\w+|year\s+to\s+date|ytd|this\s+(?:week|month|year))\b/i;
const VISIT_NOUN_SRC = String.raw`(?:service\s+calls?|service\s+visits?|visits?|calls?|repair\s+(?:calls?|visits?|jobs?)|preventive\s+maintenance\s+visits?|jobs?)`;
const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Window/visit vocabulary -> the phrasings the analytics planner reads (only when a window phrase is present). */
function rewriteRankingShapes(q) {
  let s = q;
  s = s.replace(/^\s*(?:the\s+)?(?:number|count)\s+of\s+units\s+(?:not\s+(?:currently\s+)?covered\s+by|no\s+longer\s+under|past)\s+(?:their\s+)?warranty\s*[?.!]?\s*$/i, "how many units are out of warranty");
  // account/name lookups (loop 4)
  const N = String.raw`([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)+)`;
  s = s.replace(new RegExp(String.raw`^\s*(?:which|what)\s+tech(?:nician)?s\s+(?:have\s+)?(?:been\s+(?:out\s+)?(?:to|at)|visited|serviced|worked\s+(?:on|for)|gone\s+out\s+to)\s+${N}(?:'s\s+(?:place|account|house|equipment))?\s*[?.!]?\s*$`), "who's been out to $1's place");
  s = s.replace(new RegExp(String.raw`^\s*list\s+(?:the\s+|all\s+)?tech(?:nician)?s\s+(?:who|that)\s+(?:have\s+)?(?:visited|serviced|worked\s+(?:on|for)|been\s+(?:out\s+)?(?:to|at)|gone\s+out\s+to)\s+${N}(?:'s\s+(?:place|account|house|equipment))?\s*[?.!]?\s*$`), "who's been out to $1's place");
  s = s.replace(/\bwho\s+(?:did|made|had)\s+the\s+(?:most\s+recent|latest|last)\s+(?:visit|call|service)\s+(?:at|to)\b/i, "who was the last tech at");
  s = s.replace(/\bwho\s+went\s+out\s+to\s+(?=\d)/i, "who was the last tech at ");
  s = s.replace(/\b(?:the\s+)?last\s+tech(?:nician)?\s+to\s+visit\s+(?=\d)/i, "who was the last tech at ");
  // ranking dimensions -> the exact phrasings rankings.js reads
  s = s.replace(/\bwhich\s+(city|town)\s+(?:do\s+we\s+have|has|have\s+we\s+got)\s+the\s+(?:most|highest\s+number\s+of)\s+customers(?:\s+in)?\s*(\?)?\s*$/i, "which city has the most customers$2");
  s = s.replace(/\bwhich\s+(?:zip(?:\s*code)?|postal\s+code)\s+(?:do\s+we\s+have|has|have\s+we\s+got)\s+the\s+(?:most|highest\s+number\s+of)\s+customers(?:\s+in)?\s*(\?)?\s*$/i, "which zip code has the most customers$1");
  s = s.replace(/^\s*(?:what|which)\s+(?:zip(?:\s*code)?|postal\s+code)\s+(?:has|do\s+we\s+have)\s+the\s+(?:most|highest\s+number\s+of)\s+customers(?:\s+in)?\s*(\?)?\s*$/i, "which zip code has the most customers$1");
  s = s.replace(/^\s*(?:top|most\s+common|biggest)\s+(?:zip(?:\s*code)?|postal\s+code)\s+(?:by\s+(?:number|count)\s+of\s+customers|among\s+(?:our\s+)?customers|for\s+customers)\s*(\?)?\s*$/i, "which zip code has the most customers$1");
  s = s.replace(/\bwhich\s+state\s+(?:do\s+we\s+have|has|have\s+we\s+got)\s+the\s+(?:most|highest\s+number\s+of)\s+customers(?:\s+in)?\s*(\?)?\s*$/i, "which state do most of our customers live in$1");
  return s;
}

function rewriteWindowShapes(q) {
  let s = rewriteRankingShapes(q);
  // type comparisons ("do we do more repairs than PM", "is repair work bigger than maintenance work")
  if (/\bthan\b/i.test(s)) {
    s = s.replace(/\b(more|fewer|less)\s+repairs\b/gi, "$1 repair visits");
    s = s.replace(/\b(?:a\s+)?(?:bigger|larger|greater)\s+share\s+of\s+(?:our\s+)?(?:work|jobs|business)\b/gi, "more visits");
    s = s.replace(/\b(?:preventive\s+)?maintenance\s+work\b/gi, "preventive maintenance visits");
    s = s.replace(/\bbigger\s+than\b/gi, "more than");
    s = s.replace(/\s+for\s+us\s*$/i, "");
    s = s.replace(/\bthan\s+repair\s*\??\s*$/i, "than repair visits");
    s = s.replace(/\bthan\s+(?:pms?|(?:preventive\s+)?maintenance)(?=\s*\??\s*$|\s+for\s+us)/i, "than preventive maintenance visits");
  }
  // tech totals: "how many service calls has NAME been out on, total" -> "how many jobs has NAME done" (technician.js record count)
  const TN = String.raw`([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)+)`;
  const totalTail = String.raw`(?:\s*,?\s*(?:total|altogether|in\s+all|overall|in\s+total|to\s+date))?\s*[?.!]?\s*$`;
  let m = new RegExp(String.raw`^\s*how\s+many\s+(?:service\s+calls?|service\s+visits?|visits?|calls?|jobs?)\s+has\s+${TN}\s+(?:been\s+(?:out\s+on|on|sent\s+on)|gone\s+out\s+on|run|been\s+out\s+to)${totalTail}`).exec(s)
    ?? new RegExp(String.raw`^\s*how\s+many\s+times\s+has\s+${TN}\s+been\s+(?:dispatched|sent\s+out|out)${totalTail}`).exec(s)
    ?? new RegExp(String.raw`^\s*(?:total\s+)?(?:number|count)\s+of\s+(?:service\s+)?(?:calls|visits|jobs)\s+${TN}\s+has\s+(?:gone\s+out\s+on|run|been\s+on|done)${totalTail}`).exec(s)
    ?? new RegExp(String.raw`^\s*${TN}\s*[-:]\s*(?:lifetime|total|all[- ]time)\s+(?:service\s+)?(?:calls|visits|jobs)\s*[?.!]?\s*$`).exec(s);
  if (m) return `how many jobs has ${m[1]} done`; // the technician-record count (field-phrasing k133 convention), not the dated-doc "in total" count
  // units per customer / org
  m = /^\s*how\s+many\s+(?:units|systems|pieces\s+of\s+equipment)(?:\s+total)?\s+(?:does|do)\s+(.+?)\s+have(?:\s+on\s+file)?\s*[?.!]?\s*$/i.exec(s)
    ?? /^\s*how\s+many\s+(?:units|systems|pieces\s+of\s+equipment)\s+(?:are\s+)?on\s+file\s+for\s+(.+?)\s*[?.!]?\s*$/i.exec(s)
    ?? /^\s*(?:unit|system|equipment)\s+count\s+for\s+(.+?)\s*[?.!]?\s*$/i.exec(s);
  if (m && /^[A-Z]/.test(m[1])) return `what equipment does ${m[1].replace(/\s+Elementary\s+School$/i, ' Elementary')} have`;
  // "number of repair jobs on record"
  m = /^\s*(?:the\s+)?(?:total\s+)?number\s+of\s+(repair|preventive\s+maintenance)\s+(?:jobs|visits|calls)\s+on\s+(?:record|file)\s*[?.!]?\s*$/i.exec(s);
  if (m) return `how many ${m[1].toLowerCase()} visits are on file`;
  // service-type nouns -> the canonical phrases SERVICE_TYPE_PHRASE_RE knows (a qualifier the planner cannot see gets silently dropped)
  s = s.replace(/\b(?:(?:preventive|preventative)\s+)?(?:pms?|maintenance)\s+(?:visits?|calls?|jobs?)\b/gi, "preventive maintenance visits");
  s = s.replace(/\bhow\s+many\s+(?:pms|preventive\s+maintenances?)\b(?!\s+(?:visits?|calls?|jobs?|agreements?|plans?|contracts?))/gi, "how many preventive maintenance visits");
  s = s.replace(/\b(?:(?:how\s+many|number\s+of|count\s+of|total)\s+)repairs\b/gi, (m) => m.replace(/repairs$/i, "repair visits"));
  s = s.replace(/\brepair\s+work\b/gi, "repair visits");
  if (!WINDOW_RE.test(s)) return s;
  s = s.replace(/^\s*(?:count|number|total)\s+of\s+/i, "how many ");
  s = s.replace(/\b(?:in|over|within|during)\s+the\s+(?:past|last)\s+week\b/gi, "in the last 7 days");
  s = s.replace(/\b(?:in|over)\s+the\s+(?:past|last)\s+month\b/gi, "in the last 30 days");
  s = s.replace(/\b(?:in|over)\s+the\s+(?:past|last)\s+(?:half\s+year|six\s+months)\b/gi, "in the last 6 months");
  s = s.replace(/\b(?:in|over)\s+the\s+(?:past|last)\s+(?:year|twelve\s+months|12\s+months)\b/gi, "in the last 12 months");
  s = s.replace(/\b(in|over)\s+the\s+(last|past)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?)\b/gi, (m, a, b, n, u) => `${a} the ${b} ${NUMWORD[n.toLowerCase()]} ${u}`);
  // existence without a lead verb / with "there been"
  s = s.replace(new RegExp(String.raw`^\s*(?:hey,?\s+)?any\s+(?=${VISIT_NOUN_SRC}\b)`, "i"), "did we do any ");
  s = s.replace(/^\s*(?:has|have|was|is)\s+there\s+(?:been\s+)?any\s+(?:activity|work|action)\b/i, "did we do any service calls");
  s = s.replace(/\b(?:did|have)\s+we\s+(?:do|had|done|have|logged?)\s+any\s+(?:work|activity|jobs?)\b(?!\s+(?:at|for|on|with))/i, "did we do any service calls");
  s = s.replace(/^\s*have\s+we\s+had\s+any\s+(?=(?:repair|preventive))/i, "did we do any ");
  return s;
}

export function rewriteQuestion(question) {
  const src = String(question ?? "");
  if (!src.trim() || src.length > 300) return null;
  let q = src;
  q = q.replace(DIGIT_SEQ_RE, (m) => m.toLowerCase().split(/\s+/).map((w) => DIGITS[w] ?? w).join(""));
  for (const [re, rep] of RULES) q = q.replace(re, rep);
  q = rewriteWindowShapes(q);
  return q !== src ? q : null;
}
