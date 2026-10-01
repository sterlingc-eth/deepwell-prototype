/**
 * R32 (Team M): a CONSERVATIVE, pure gate for text that is not a records question at all — greetings, thanks,
 * keyboard mash / symbols only, and a short list of unmistakably off-topic requests (jokes, weather, poems...).
 * Before this, such input fell through retrieval to `tryAgent` (a Sonnet research loop) and burned a model call to
 * say "nothing found". The gate answers with a canned, honest no-answer at $0.
 *
 * Safety rule (never block a real records question): return null whenever the text contains ANY digit, '@', '#',
 * or any records/HVAC vocabulary word, whatever else it looks like. Only a full-string match on a closed pattern
 * (or a letters-free / vowel-free mash) is ever classified. Unknown => null => the normal pipeline runs unchanged.
 */

// Words that make text potentially a records question. Deliberately broad; one hit vetoes the gate.
const RECORDS_WORDS = new Set((
  "customer customers client clients unit units equipment invoice invoices estimate estimates quote quotes proposal proposals " +
  "serial model brand warranty warranties install installed installation service serviced services repair repaired repairs " +
  "maintenance inspection inspections permit permits document documents doc docs file files page pages record records " +
  "technician tech techs many much last first oldest newest recent latest total revenue paid " +
  "unpaid overdue balance owed owe cost costs price bill billed job jobs ticket tickets work order orders part parts " +
  "filter filters compressor coil furnace condenser thermostat refrigerant freon ac hvac heat pump rooftop rtu tonnage ton tons " +
  "address street phone email contact name lennox trane carrier goodman rheem york daikin bryant nordyne amana " +
  "lookup count compare summarize summary report expire expires expiring due schedule " +
  "scheduled appointment reminder reminders agreement contract nameplate upload delete remove"
).split(/\s+/));

const GREETING_RE = new RegExp(
  "^(?:hi|hii+|hello|hey|heya|hiya|yo|howdy|sup|greetings|good (?:morning|afternoon|evening|day)|morning|afternoon|evening)" +
  "(?: (?:there|donovan|team|all|everyone|again|friend|assistant|bot))?(?: how(?:'s| is| are) (?:it going|you|things|everything|your day))?$"
);
const THANKS_RE = /^(?:thanks|thank you|thank u|thx|ty|cheers|much appreciated|appreciate it|great thanks|ok thanks|okay thanks|thanks a lot|thank you so much|thanks so much|thank you very much)(?: donovan| again| team)?$/;
const ACK_RE = /^(?:ok|okay|k|kk|cool|nice|great|awesome|got it|understood|sounds good|perfect|bye|goodbye|see you|see ya|later|good night|never ?mind|nvm|test|testing|test test|hmm+|lol|haha+)$/;
const OFFTOPIC_RES = [
  /^(?:please )?tell me (?:a|another) (?:joke|riddle|story|fun fact)$/,
  /^(?:please )?(?:write|compose|make) (?:me )?(?:a|an) (?:poem|song|haiku|limerick|story|essay|joke)(?: about [a-z ]{1,40})?$/,
  /^(?:what(?:'s| is) the )?weather(?: like)?(?: today| tomorrow| right now| outside)?$/,
  /^what(?:'s| is) the (?:weather|forecast) (?:today|tomorrow|like|going to be like)$/,
  /^what(?:'s| is) the meaning of life$/,
  /^who (?:is|was) the (?:president|prime minister) of [a-z ]{2,30}$/,
  /^what(?:'s| is) the capital of [a-z ]{2,30}$/,
  /^(?:what(?:'s| is) )?(?:the )?(?:bitcoin|btc|ethereum) price$/,
  /^(?:who won|what(?:'s| is) the score of) the (?:game|match|super bowl|world series)(?: last night| yesterday)?$/,
  /^(?:how do i|how to) (?:make|cook|bake) (?:a |an |some )?(?:cake|pizza|pasta|pancakes|cookies|omelette|bread|coffee)$/,
  /^translate [a-z ,'"]{2,60} (?:to|into) (?:spanish|french|german|italian|chinese|japanese)$/,
  /^sing (?:me )?a song$/,
];
const WHO_ARE_YOU_RE = /^(?:who are you|what are you|what(?:'s| is) your name|what can you do|what do you do|are you (?:a )?(?:bot|robot|ai|human|real)|help(?: me)?)$/;

const CANNED = {
  greeting: "Hi! I'm Donovan. Ask me about your customers, equipment, warranties, invoices or service history — for example \"when was the unit at 88 Whitmore Ave installed?\" or \"which warranties expire this year?\".",
  thanks: "You're welcome! Ask me anything else about your records whenever you like.",
  ack: "Got it. Ask me anything about your customers, equipment, warranties, invoices or service history.",
  who: "I'm Donovan, DeepWell's records assistant. I answer questions from the documents you've uploaded — customers, units, warranties, invoices, service history — and show the pages behind every answer.",
  mash: "I couldn't read that as a question. Try asking about a customer, a unit or a document — for example \"what's the serial number of the Goodman at 88 Whitmore Ave?\".",
  offtopic: "That's outside what I can help with — I only answer from your uploaded records (customers, equipment, warranties, invoices, service history). Try asking about one of those.",
};

/** @returns {null|{kind:'greeting'|'thanks'|'ack'|'who'|'mash'|'offtopic', text:string}} */
export function classifyNonQuestion(question) {
  const raw = String(question ?? "");
  if (!raw.trim() || raw.length > 120) return null; // empty is the handler's own 400, not ours // real questions are longer; long text is never gated
  const q = raw.toLowerCase().normalize("NFKC").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const bare = q.replace(/[!?.,;:~…\s]+$/g, "").replace(/^[!?.,;:~…\s]+/g, "").trim();
  // No letters and no digits at all (emoji, punctuation only): nothing to look up.
  if (!/[\p{L}\p{N}]/u.test(q) || (bare === "" && q !== "")) return { kind: "mash", text: CANNED.mash };
  if (/[0-9@#]/.test(q)) return null; // serials, addresses, dates, ids, emails: always a real lookup
  const words = bare.split(/[^a-z']+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  if (!words.length) return null;
  if (words.some((w) => RECORDS_WORDS.has(w) || RECORDS_WORDS.has(w.replace(/e?s$/, "")))) return null;
  if (GREETING_RE.test(bare)) return { kind: "greeting", text: CANNED.greeting };
  if (THANKS_RE.test(bare)) return { kind: "thanks", text: CANNED.thanks };
  if (ACK_RE.test(bare)) return { kind: "ack", text: CANNED.ack };
  if (WHO_ARE_YOU_RE.test(bare)) return { kind: "who", text: CANNED.who };
  for (const re of OFFTOPIC_RES) if (re.test(bare)) return { kind: "offtopic", text: CANNED.offtopic };
  // Keyboard mash: every token has no vowel (a, e, i, o, u) and is 4+ letters, or matches a mash row run.
  // A single vowel-less short token (e.g. a surname like "Ng") is left alone.
  const mashy = (w) => (w.length >= 4 && !/[aeiou]/.test(w)) || /(?:asdf|qwer|zxcv|hjkl|uiop|sdfg|dfgh|fghj|ghjk|jkl;|qazw|wsxe)/.test(w);
  if (words.every(mashy)) return { kind: "mash", text: CANNED.mash };
  return null;
}

/** The answer object the ask handler sends (same shape as its other honest no-answers). */
export function nonQuestionAnswer(hit) {
  return { kind: "no-answer", text: hit.text, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [], nonQuestion: hit.kind };
}
