/**
 * R32 (Team A, loop 1) — GENERAL early declines: questions the records can never answer, recognised by SHAPE rather than by a
 * per-phrase list, so they never reach a paid model (and never get mis-answered by a field lookup that shares a word —
 * "do you like your job" -> job count, "how many states are in the us" -> customer count, "thermostat model at <addr>" -> the
 * UNIT's model, "refrigerant line length" -> the refrigerant type were all real wrong answers before this).
 *
 *   classifyEarlyDecline(question, { hasConversation }) -> null | { kind: "off_domain" | "untracked_component" | "dangling" }
 *
 * Three families, each with a veto that keeps a real record question out:
 *  1. off_domain          — a consumer/general-knowledge/personal-assistant/persona category lexicon hit AND no record anchor
 *                           (customer/unit/invoice/job/tech/... nouns, a street address). Category lexicons, not phrases.
 *  2. untracked_component — a COMPONENT noun (thermostat, capacitor, coil, breaker, wire, blower, ...) next to an ATTRIBUTE word
 *                           (model, brand, size, length, color, hp, ...). This schema tracks unit-level attributes only, so
 *                           the unit's own model/refrigerant would be a wrong answer. seer/filter-size are NOT here: they are
 *                           recognised-but-unextracted intents that must keep deferring (a model can find them in page text).
 *  3. dangling            — an anaphoric follow-up ("and the model for that one", "same thing for last month", "put me through to
 *                           whoever handled it") with NO conversation to resolve it against. Only when the request carries no
 *                           conversationContext (with one, the follow-up engine / model may resolve it, so we never pre-empt).
 * Pure: no DB, no model. A false negative only costs a defer (old behaviour); the vetoes are what keep a false positive out.
 */
import { stripConversationalFrame } from "./frame.js";
import { attachCitations } from "../citations/records.js";
import { buildOutOfDomainAnswer, buildUntrackedFieldAnswer } from "../contactLookup.js";

export const RECORD_ANCHOR_RE = new RegExp(
  String.raw`\b(?:customers?|clients?|accounts?|units?|systems?|equipment|hvac|e-?mails?|furnaces?|ac|a/c|air\s+conditioner|heat\s+pumps?|condensers?|air\s+handlers?|rtus?|mini[- ]?splits?|` +
    String.raw`invoices?|bills?|billed|quotes?|estimates?|po|pos|purchase\s+orders?|permits?|warrant(?:y|ies)|services?|serviced|visits?|jobs?|work\s+orders?|calls?|appointments?|` +
    String.raw`tech(?:s|nicians?)?|installs?|installed|installation|repairs?|maintenance|pm|documents?|docs?|records?|files?|on\s+file|dispatch|notes?|addresses|address|phone|email|serial|model|` +
    String.raw`brands?|manufacturers?|mfr|tonnage|seer|refrigerant|paid|unpaid|balance|revenue|expenses?|vendors?|suppliers?|parts?|inventory|donovan|deepwell|upload(?:ed)?|paperwork|receipts?|contracts?|` +
    String.raw`plumbing|electrical|heater|boiler|thermostats?|ducts?|ductwork|coils?|compressors?|filters?|lines?\s+sets?|leads?|payroll|hours|timesheets?|schedule[ds]?)\b`,
  "i"
);
const STREET_RE = /\b\d{2,6}\s+(?:[nsew]\.?\s+)?[a-z0-9'.-]+(?:\s+[a-z0-9'.-]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|pkwy|hwy|cir|trl)\b/i;

/* ---- 1. off-domain category lexicons (a hit needs no record anchor) ---- */
const OFF_DOMAIN_RES = [
  // weather
  /\b(?:weather|forecast|umbrella|sunscreen|jacket)\b/i,
  /\b(?:hot|cold|warm|chilly|humid|windy|rainy|sunny|cloudy|nice)\s+(?:out|outside)\b/i,
  /\b(?:temperature|temp)\s+(?:is\s+)?(?:like\s+)?(?:outside|out\s+there)\b/i,
  /\bhow\s+(?:cold|hot|warm)\s+(?:does\s+it\s+get|will\s+it\s+(?:be|get)|is\s+it\s+going\s+to\s+(?:be|get))\b/i,
  /\bwhats?\s+it\s+like\s+outside\b|\bhow\s+(?:windy|hot|cold|humid)\s+is\s+it\b/i,
  /\b(?:will|is)\s+it\s+(?:going\s+to\s+)?(?:rain|snow|storm|be\s+(?:hot|cold|sunny))\b/i,
  // entertainment / fun
  /\b(?:jokes?|riddles?|funny|make\s+me\s+laugh|rap|tunes?(?![- ]?ups?\b)|songs?|music|playlist|spotify|netflix|youtube|podcasts?|movies?|lottery|horoscope|trivia|memes?|karaoke)\b/i,
  /\b(?:hum|sing|dance|whistle)\s+(?:me\s+)?(?:a|an|some|the)?\b/i,
  // food / places
  /\b(?:lunch|breakfast|dinner|brunch|snacks?|coffee|pizza|tacos?|burgers?|sushi|gas\s+station|hardware\s+store|grocery|pharmacy|starbucks|mcdonald'?s)\b/i,
  /\b(?:where|find|any\s+good|best|good|nearest|closest|recommend|suggest|grab|order|hungry|craving)\b[^?]{0,30}\b(?:restaurants?|diners?|bakery|bar|bars|atm|subway|cafe|deli|steakhouse|buffet|food)\b/i,
  /\b(?:near\s+me|nearby|around\s+here)\b/i,
  // personal-assistant tasks
  /\b(?:set|start|cancel|stop)\s+(?:an?\s+|the\s+|my\s+)?(?:alarm|timer|reminder|stopwatch)\b|\bwake\s+me\s+up\b/i,
  /\b(?:text|call|email|message|phone)\s+my\s+(?:wife|husband|mom|mother|dad|father|brother|sister|kids?|son|daughter|friend|girlfriend|boyfriend|buddy|partner)\b|\bremind\s+me\s+to\s+(?:call|text)\b/i,
  /\badd\s+[\w\s]{1,30}\s+to\s+my\s+(?:shopping|grocery|to-?do|todo)\s+list\b/i,
  /\b(?:turn|switch)\s+(?:on|off)\s+the\s+(?:lights?|tv|television|radio|music)\b|\b(?:open|launch)\s+(?:spotify|youtube|netflix|maps|facebook|instagram|twitter|tiktok|gmail|chrome)\b|\bplay\s+(?:the\s+)?(?:radio|music|a\s+song|some)\b/i,
  /\b(?:directions?|navigate)\s+to\b|\bcall\s+an?\s+(?:uber|lyft|cab|taxi)\b/i,
  // general knowledge / trivia
  /\bwho\s+(?:was|is|were)\s+the\s+(?:first|last|best|greatest|richest|tallest|fastest|youngest|oldest)\s+(?:man|woman|person|human|president|quarterback|player|athlete|actor|singer|king|queen|astronaut)\b/i,
  /\bwhy\s+(?:is|are|do|does)\s+(?:the|a|an)\s+(?:sky|ocean|sea|grass|moon|sun|water|snow|cat|dog|rainbow|leaves?|stars?)\b/i,
  /\bhow\s+(?:does|do)\s+(?:a|an|the)\s+(?:rainbow|airplane|plane|volcano|magnet|battery|rocket|vaccine|camera|telescope|tornado|hurricane)\b/i,
  /\bwhat\s+year\s+(?:was|did|were)\b|\bhow\s+many\s+days\s+(?:until|till|to)\s+[a-z]/i,
  /\bhow\s+(?:do|would)\s+(?:you|i)\s+say\b[^?]*\bin\s+(?:spanish|french|german|italian|chinese|japanese|portuguese|russian|korean|arabic|latin)\b/i,
  /\bhow\s+many\s+(?:states|countries|continents|planets|oceans|players|letters|moons)\b/i,
  /\b(?:moon|mars|jupiter|saturn|planets?|galaxy|dinosaurs?|pyramids?)\b/i,
  /\b(?:who|which\s+team)\s+(?:will|is\s+going\s+to|'?s\s+going\s+to|gonna)\s+win\b|\belection\b|\bquarterback\b|\bbasketball\b|\bfootball\b|\bbaseball\b|\bplayoffs?\b/i,
  /\bwhats?\s+[\d.,]+\s*(?:\+|-|x|\*|\/|plus|minus|times|divided\s+by|multiplied\s+by|over)\s*[\d.,]+\s*$/i,
  /\b(?:storms?|thunderstorms?|monsoon|hail|heat\s+wave|tornado|hurricane)\b(?:\s+(?:coming|tonight|tomorrow|this\s+week|today))?/i,
  /\b(?:burritos?|sandwiche?s?|ice\s+cream|donuts?|wings|bbq|barbecue|pasta|ramen|noodles|salad|steak|wine|beer|cocktails?|margarita|smoothie)\b/i,
  /\bwho\s+(?:is|was)\s+the\s+(?:ceo|founder|owner|president|director|coach)\s+of\s+(?!the\s+(?:account|job|unit|customer))[a-z]/i,
  /\bbest\s+(?:laptop|phone|car|truck|tv|camera|headphones|movie|book|game|restaurant|video\s+game)\b/i,
  /\bhow\s+(?:do|can|to)\s+(?:i\s+)?(?:make|cook|bake|grill|fry)\s+(?:a\s+|an\s+|some\s+)?(?:guacamole|salsa|tacos?|cake|soup|steak|rice|eggs?|bread|pizza|smoothie|cocktail|margarita|lasagna|burgers?|chicken|cookies|pancakes|pasta)\b/i,
  /\b(?:nearest|closest|where(?:'s|s|\s+is)?\s+(?:the\s+)?(?:nearest|closest)?)\s*(?:urgent\s+care|hospital|pharmacy|police\s+station|dentist|doctor|bank|post\s+office|library|mall|airport|gym|park)\b/i,
  /\bon\s+tv\b|\btv\s+(?:tonight|schedule|guide)\b/i,
  /\bremind\s+me\s+to\b/i,
  /\brhymes?\s+with\b|\b(?:read|give)\s+me\s+the\s+news\b|\b(?:ride|lift)\s+to\s+the\s+(?:airport|station|mall|hospital)\b|\bwhat\s+time\s+does\s+(?:the\s+)?(?:bank|mall|store|post\s+office|library|gym|pharmacy)\s+(?:open|close)\b|\b(?:mall|bank|store|library|gym|pharmacy|post\s+office)\s+open\s+(?:today|now|tonight|tomorrow)\b/i,
  /\btell\s+me\s+about\s+yourself\b|\bhow\s+(?:big|large|small|hot|cold)\s+is\s+(?:texas|arizona|california|florida|alaska|the\s+(?:usa|us|world|earth|desert))\b|\bwhat\s+should\s+i\s+(?:cook|wear|watch|read|play|listen\s+to)\b|\b(?:haircut|hiking\s+trail|hiking|workout|fishing|camping|vacation\s+spot)\b|\b(?:ford|chevy|toyota|honda|dodge)\s+or\s+(?:ford|chevy|toyota|honda|dodge)\b|\bhow\s+do\s+i\s+(?:unlock|jailbreak|screenshot|factory\s+reset)\s+my\b|\b(?:get\s+a\s+tan|bet\s+on\s+the\b|\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|\bwhy\s+do\s+(?:cats|dogs|birds|dolphins|whales|bees)\b|\bhow\s+many\s+(?:legs|eyes|arms|teeth|bones)\b|\bexplain\s+how\b)/i,
  /\b(?:iphone|android|tesla|joker|batman|marvel|stadium|marathon|halloween|christmas|thanksgiving|easter|puppy|kitten|earth|sunset|sunrise|freeway|horoscope|first\s+date|date\s+night)\b/i,
  /\b(?:stor(?:y|ies)|gifts?)\b(?![^?]*\b(?:customers?|jobs?|invoices?|units?)\b)/i,
  /\b(?:show|movie|series|game)\s+to\s+(?:watch|play)\b|\bhow\s+(?:long|far|tall|old)\s+is\s+(?:a|an|the)\s+(?:marathon|mile|football|movie|flight|mountain|river)\b|\bhow\s+many\s+people\s+(?:are|live)\b/i,
  /\bwhos?\s+(?:is\s+)?(?:playing|singing|performing)\b|\bwho\s+plays\b|\bwhat\s+day\s+is\b|\bwhen\s+does\s+the\s+(?:sun|moon)\b|\b(?:name|names)\s+(?:for|my)\s+(?:a\s+|my\s+)?(?:puppy|dog|cat|baby|boat|band|kid)\b/i,
  // R32b (loop E): arithmetic / unit conversion, history & science trivia, shopping and lifestyle advice, device help, everyday health, weather in a named place
  /\bwhat(?:'s|s|\s+is)\s+(?:the\s+)?(?:square|cube)\s+root\s+of\b|\bwhat(?:'s|s|\s+is)\s+[\d.,]+\s*(?:%|percent)\s+of\s+[\d.,]+|\bconvert\s+[\d.,]+\s+(?:miles?|kilometers?|km|pounds?|lbs?|kg|kilograms?|ounces?|cups?|gallons?|liters?|litres?|feet|foot|inches|meters?|celsius|fahrenheit|yards?)\b|\bhow\s+many\s+(?:days|hours|minutes|seconds|weeks|months|ounces|cups|feet|inches|yards|miles|pints|quarts|gallons|centimeters|grams|pounds)\s+(?:are\s+)?(?:in|per)\s+(?:a|an|one|1)\s+(?:leap\s+)?(?:year|day|week|month|hour|minute|pound|mile|foot|yard|gallon|quart|kilogram|kilometer|ton)\b/i,
  /\bwho\s+(?:won|wrote|invented|discovered|painted|composed|founded)\b(?![^?]*\b(?:job|contract|bid|account|invoice|work|customer)\b)|\bwhen\s+(?:did|was|were)\b[^?]*\b(?:world\s+war|civil\s+war|revolution|moon\s+landing|independence|titanic|declaration\s+of)\b|\bhow\s+(?:tall|high|long|old|far|deep)\s+is\s+(?:mount|mt\.?|the\s+(?:eiffel|empire|statue|great\s+wall|nile|amazon|grand\s+canyon)|everest|k2)\b|\bwhat(?:'s|s|\s+is)\s+the\s+(?:capital|currency|population|largest|biggest|smallest|longest|tallest|deepest|highest)\s+(?:of|in)\b[^?]*\b(?:country|world|ocean|river|africa|asia|europe|australia|america|city|state|earth|tokyo|paris|london|france|china|japan|india|canada|mexico|brazil)\b|\bwhat(?:'s|s|\s+is)\s+the\s+(?:largest|biggest|smallest|longest|tallest|deepest|highest|oldest|fastest|hottest|coldest)\s+\w+(?:\s+\w+)?\s+(?:in|of|on)\s+(?:the\s+)?(?:world|earth|country|america|europe|asia|africa|universe|ocean|solar\s+system)\b|\bwhat(?:'s|s|\s+is)\s+the\s+(?:speed\s+of\s+(?:light|sound)|boiling\s+point|freezing\s+point|melting\s+point)\b/i,
  /\bwhich\s+(?:laptop|phone|car|truck|tv|camera|tablet|watch|suv|bike|guitar|console|headphones)\b[^?]*\b(?:should|would|to)\s+(?:i\s+|we\s+)?(?:buy|get|choose|pick)\b|\bwhich\s+(?:car|truck|suv|phone|laptop|brand\s+of\s+(?:car|phone|laptop))\s+is\s+(?:more\s+)?(?:reliable|better|faster|cheaper)\b|\b(?:camry|accord|civic|corolla|mustang|silverado|f-?150|prius|iphone\s+\d+|galaxy\s+s\d+)\b/i,
  /\bbest\s+way\s+to\s+(?:learn|study|lose\s+weight|get\s+fit|relax|sleep|meditate|invest|save\s+money|get\s+rich)\b|\bwhere\s+should\s+(?:i|we)\s+(?:go|eat|travel|vacation|retire)\b|\bwhat(?:'s|s|\s+is)\s+a\s+(?:good|great)\s+(?:book|movie|show|game|song|podcast|restaurant|gift)\b|\btell\s+me\s+something\s+(?:interesting|funny|cool|fun|new)\b|\b(?:spell\s+(?!out\b)\w+(?:\s+for\s+me)?$|how\s+do\s+you\s+spell)\b|\bgive\s+me\s+a\s+(?:riddle|fun\s+fact|quote|pickup\s+line|poem|haiku|limerick)\b|\bwrite\s+(?:me\s+)?(?:a|an)\s+(?:poem|song|story|haiku|limerick|joke|essay)\b/i,
  /\bhow\s+do\s+(?:i|you)\s+(?:take\s+a\s+screenshot|(?:clear|delete)\s+(?:my\s+)?(?:browser\s+)?(?:cache|history|cookies)|factory\s+reset|(?:reset|restart|unlock|charge|update|turn\s+off)\s+my\s+(?:iphone|android|ipad|phone|laptop|computer|router|tv|tablet|macbook))\b|\bwhy\s+is\s+my\s+(?:laptop|phone|computer|wifi|wi-fi|internet|iphone|tv|printer|router)\b|\bmy\s+(?:wifi|wi-fi|internet|bluetooth|router|printer|laptop|iphone|ipad|android|macbook)\s+(?:keeps?\s+\w+|is\s+\w+|won'?t\s+\w+|not\s+working)\b/i,
  /\bwhat\s+should\s+i\s+take\s+for\s+(?:a\s+)?(?:headache|cold|cough|fever|sore|allergies|pain)\b|\bhow\s+many\s+calories\b|\bhow\s+do\s+i\s+lose\s+(?:\d+\s+|ten\s+|five\s+|twenty\s+)?(?:pounds|weight|lbs)\b|\bwhy\s+do\s+i\s+(?:get|have|keep|feel)\s+(?:hiccups|headaches|sleepy|tired|cramps|dizzy)\b|\bis\s+it\s+(?:ok|okay|safe|healthy|bad)\s+to\s+(?:run|eat|drink|sleep|skip|fast|nap)\b/i,
  /\b(?:temperature|temp|weather)\s+in\s+(?:[a-z]+\s+){0,2}[a-z]+\s+(?:right\s+now|today|tonight|tomorrow|this\s+(?:weekend|week))\b|\bweather\s+(?:in|for)\s+[a-z]|\b(?:temperature|temp)\s+in\s+(?!the\s|a\s|an\s|my\s|our\s)[a-z]+(?:\s+[a-z]+){0,2}$/i,
  // personal items: "my wife/kids/dog/puppy/date/birthday ..." — no business record is about them
  /\bmy\s+(?:wife|husband|mom|mother|dad|father|kids?|son|daughter|dog|cat|puppy|girlfriend|boyfriend|birthday|anniversary|vacation|weekend|date)\b/i,
  // tech support / lifestyle
  /\bhow\s+(?:do|can|would)\s+i\s+(?:change|reset|fix|update|connect|set\s+up)\s+(?:my|the)\s+(?:wifi|wi-fi|password|phone|router|printer|computer|laptop|browser|bluetooth|email\s+password|account\s+password)\b/i,
  /\bshould\s+i\s+(?:buy|get|rent|lease)\s+(?:a|an|the)\s+(?:truck|van|car|suv|house|boat|phone|laptop|dog|cat)\b/i,
  // persona / chit-chat addressed to the assistant itself
  /^(?:how\s+are\s+you|how\s+(?:is|are)\s+you\s+(?:doing|today)|how\s+you\s+doing|what(?:'s|s|\s+is)\s+your\s+(?:name|age|favorite\s+\w+)|who\s+(?:made|built|created|programmed|trained)\s+you|how\s+old\s+are\s+you|what\s+are\s+you|who\s+are\s+you)\b/i,
  /\b(?:are\s+you\s+(?:a\s+|an\s+)?(?:person|human|robot|real|alive|married|single|male|female|boy|girl|bot|ai)|do\s+you\s+(?:like|love|hate|dream|feel|sleep|eat|have\s+(?:a\s+)?(?:name|family|kids?|friends?|feelings?|pets?|hobbies|hobby))|(?:do|did)\s+you\s+ever\s+(?:sleep|dream|eat))\b/i,
];
// Persona questions legitimately mention record nouns ("do you like your job") — the anchor veto is dropped for these only.
const EXEMPT_RES = [
  // R32b (loop E): consumer-phone shopping/device help names a record word ("phone") but is never about a record
  /\bwhich\s+(?:phone|iphone|android)\s+(?:should|would|to)\s+(?:i\s+|we\s+)?(?:buy|get|choose|pick)\b|\bhow\s+do\s+i\s+(?:unlock|reset|charge|restart)\s+my\s+(?:iphone|android|phone)\b/i,
  /\b(?:text|call|email|message|phone)\s+my\s+(?:wife|husband|mom|mother|dad|father|brother|sister|kids?|son|daughter|friend|girlfriend|boyfriend|buddy|partner)\b|\bremind\s+me\s+to\s+(?:call|text)\b/i,
];
const PERSONA_RE_INDEXES = new Set([OFF_DOMAIN_RES.length - 2, OFF_DOMAIN_RES.length - 1]);
// R32b (loop A): questions about the ASSISTANT's own preferences ("who's your favorite technician", "do you have a favorite account"), the app's
// own account settings ("how do I change my account password") and company-wide announcements ("what did the shop manager circulate to everyone")
// name record nouns (customer, technician, account, dispatch) but are never about a record. Anchor veto dropped for these only; each needs its own shape.
const SELF_PREF_RE = /\b(?:your|ur)\s+(?:least\s+|most\s+)?fav(?:ou?rite|orite)\b|\bpick\s+(?:a|an|your|one)\s+(?:least\s+)?fav(?:ou?rite|orite)\b|\byou\b[^?]{0,40}\bfav(?:ou?rite|orite)s?\b|\bdo\s+you\s+(?:have|got)\s+(?:a\s+|any\s+)?(?:fav(?:ou?rite|orite)|pet)\b|\bwho\s+do\s+you\s+(?:like|prefer|hate)\s+(?:best|most|least)\b/i;
const APP_SETTINGS_RE = /\bhow\s+(?:(?:do|can|could|would|should)\s+(?:i|we)|to)\s+(?:change|reset|update|recover|set|add|remove|delete|invite|cancel|upgrade|downgrade|edit)\s+(?:my|our|the|another|a|an|more)\s+(?:(?:new|additional|extra|different|account|login|log-?in|user|billing|team|admin)\s+){0,3}(?:password|passcode|username|login|log-?in|users?|seats?|team\s+members?|billing\s+(?:email|info|information|address|details)|plan|subscription|profile|email\s+address\s+on\s+(?:my|the)\s+account)\b|\bwhere\s+(?:do|can)\s+(?:i|we)\s+(?:reset|change)\s+(?:my|our|the)\s+(?:account\s+)?(?:password|login)\b/i;
const ANNOUNCE_VERB_RE = /\b(?:circulate[ds]?|circulating|announce[ds]?|announcement|memo|all-?hands|broadcast|blast(?:ed)?|sent?\s+out|went\s+out)\b/i;
const ANNOUNCE_AUDIENCE_RE = /\b(?:everyone|everybody|all\s+(?:of\s+)?(?:us|staff|employees|techs|hands)|(?:the\s+)?(?:whole|entire)\s+(?:team|crew|shop|staff|company|office)|the\s+(?:team|crew|staff)|all-?hands|company-?wide)\b/i;
const ANNOUNCE_WHO_RE = /\bwhat\s+did\s+(?:the\s+)?(?:boss|owner|manager|supervisor|dispatch(?:er)?|office(?:\s+manager)?|shop(?:\s+manager)?|foreman|ceo|admin|management)\s+(?:say|tell|send|email|write|text|message|post|share|put\s+out)\b/i;
const ANNOUNCE_VETO_RE = /\b(?:customers?|clients?|units?|jobs?|invoices?|quotes?|estimates?|permits?|warrant(?:y|ies)|equipment|work\s+orders?|service\s+calls?|dispatch\s+notes?|tickets?|serial|model|po|purchase\s+orders?)\b/i;
function isSelfOrAppOrAnnounce(q) {
  if (STREET_RE.test(q)) return null;
  const m = SELF_PREF_RE.exec(q) ?? APP_SETTINGS_RE.exec(q);
  if (m) return m[0];
  if (q.length <= 140 && ANNOUNCE_VERB_RE.test(q) && ANNOUNCE_AUDIENCE_RE.test(q) && !ANNOUNCE_VETO_RE.test(q)) return ANNOUNCE_VERB_RE.exec(q)[0];
  if (q.length <= 140 && ANNOUNCE_WHO_RE.test(q) && ANNOUNCE_AUDIENCE_RE.test(q) && !ANNOUNCE_VETO_RE.test(q)) return ANNOUNCE_WHO_RE.exec(q)[0];
  return null;
}

const TASK_VERB_RE = /\b(?:find|check|look|pull|show|tell\s+me|get\s+me|give|list|calculate|run|search|count|send|email|open|need|want|help|can\s+you\s+(?:tell|find|check|see|pull|show|look|get|give|list|search|count|run|send|open))\b/i;
function isPersona(q) {
  return /\b(?:are|do|did|can|could|would|will|have|were|is|does)\s+you\b|\byou(?:'re|r)\b|\b(?:made|built|created|trained|named)\s+you\b/i.test(q) && q.split(/\s+/).length <= 9 && !TASK_VERB_RE.test(q) && !RECORD_ANCHOR_RE.test(q);
}
// R45: a request for OUTSIDE data (live weather, a supplier's lead time / stock / list price, the news, traffic, exchange rates). The records never hold it,
// so it is declined even next to a record noun ("weather for installs tomorrow", "lead time on a Lennox coil"). A digit / street keeps a real lookup.
const EXTERNAL_DATA_RE = /\b(?:weather|forecast|lead\s*times?|in\s+stock|stock\s+levels?|backorder(?:ed)?|availability\s+(?:of|for|on)|msrp|retail\s+price|list\s+price|market\s+price|current\s+price|price\s+of\s+(?:gas|diesel|copper|oil|freon|r-?\d+)|exchange\s+rate|stock\s+price|traffic|news|headlines)\b/i;
function isOffDomain(q) {
  if (!q || q.length > 140) return null;
  if (STREET_RE.test(q)) return null;
  if (process.env.DONOVAN_EXTERNAL_DECLINE !== "0" && !/\d/.test(q)) { const ext = EXTERNAL_DATA_RE.exec(q); if (ext && !/\b(?:our|we|my)\s+(?:lead\s+time|stock)\b|\bhow\s+many\b|\bwhich\b|\bcustomers?\b/i.test(q)) return ext[0]; }
  const selfApp = isSelfOrAppOrAnnounce(q);
  if (selfApp) return selfApp;
  const anchored = RECORD_ANCHOR_RE.test(q);
  for (let i = 0; i < OFF_DOMAIN_RES.length; i++) {
    const m = OFF_DOMAIN_RES[i].exec(q);
    if (!m) continue;
    if (anchored && !PERSONA_RE_INDEXES.has(i)) continue;
    return m[0];
  }
  for (const re of EXEMPT_RES) { const m = re.exec(q); if (m) return m[0]; }
  if (isPersona(q)) return "you";
  return null;
}

/* ---- 2. untracked component attributes ---- */
const COMPONENTS = ["thermostat", "capacitor", "contactor", "blower", "motor", "compressor", "coil", "breaker", "wire", "wiring", "gauge", "lineset", "line set", "refrigerant line", "damper", "igniter", "flue", "humidifier", "thermocouple", "disconnect", "txv", "fan", "duct", "static", "filter", "condenser", "lineset", "linesets", "surge protector", "humidifier"];
const ATTRS = ["model", "serial", "brand", "make", "size", "type", "length", "color", "colour", "location", "hp", "horsepower", "rating", "voltage", "amps", "amperage", "pressure", "weight", "gauge", "output", "capacity", "feeds", "runs", "kind", "style", "long", "big", "large", "wide", "speed", "setting", "draw", "draws", "amp", "feet", "foot"];
// Combinations that ARE tracked / must keep deferring: a unit's own "condenser model" is a real tracked unit attribute, a filter's
// size is the deferred filter_size intent, and a bare "duct" is not a component here. Only these pairs are eligible per component.
const COMPONENT_ATTR_EXCLUDE = { condenser: new Set(["model", "serial", "brand", "make", "type", "size", "capacity", "kind", "rating", "output", "weight"]), filter: new Set(["size"]) };
const TOK_RE = /[a-z]+/g;
function isUntrackedComponent(q) {
  if (!q || q.length > 140) return false;
  if (/\b(?:and|plus|as\s+well\s+as|&)\b/i.test(q)) return false;
  const low = q.toLowerCase();
  if (/\bwhere(?:'s|s|\s+is|\s+are)\s+the\s+(?:condenser|thermostat|coil|compressor|disconnect|breaker)\b/.test(low)) return true;
  if (/\b(?:have|has|got|with)\s+(?:a|an|any)\s+(?:humidifier|dehumidifier|surge\s+protector|uv\s+light|air\s+purifier|zoning|zone\s+control|whole[- ]house\s+\w+)\b|\b(?:is|are)\s+there\s+(?:a|an|any)\s+(?:humidifier|dehumidifier|surge\s+protector|uv\s+light|air\s+purifier)\b/.test(low)) return true;
  if (/\bwho\s+financed\b|\bhow\s+(?:loud|noisy|quiet)\s+is\b|\bwhat\s+colou?r\b|\bbtu\s+(?:output|input)\b/.test(low)) return true;
  const toks = low.match(TOK_RE) ?? [];
  for (let i = 0; i < toks.length; i++) {
    const two = i + 1 < toks.length ? `${toks[i]} ${toks[i + 1]}` : "";
    const comp = COMPONENTS.includes(two) ? two : COMPONENTS.includes(toks[i]) ? toks[i] : null;
    if (!comp) continue;
    const span = comp === two ? 2 : 1;
    for (let j = Math.max(0, i - 5); j < Math.min(toks.length, i + span + 5); j++) {
      if (j >= i && j < i + span) continue;
      if (!ATTRS.includes(toks[j])) continue;
      if (COMPONENT_ATTR_EXCLUDE[comp]?.has(toks[j])) continue;
      if (comp === "gauge" && toks[j] === "gauge") continue;
      if (comp === "static" && toks[j] !== "pressure") continue;
      return true;
    }
  }
  return false;
}

/* ---- 3. dangling follow-ups (no conversation to resolve them) ---- */
const CAP_NAME_RE = /(?:^|[\s,])[A-Z][a-z]{2,}\b/; // tested on the ORIGINAL text after the first word: a typed proper name means it is not dangling
const DANGLING_RES = [
  /\b(?:that|this)\s+one\b|\bthe\s+other\s+(?:one|unit|address|customer|job|account|tech)\b|\bthe\s+(?:second|third|first|next|previous|last)\s+one\b|\bthe\s+one\s+before\b|\bone\s+before\s+that\b/i,
  /\b(?:same\s+(?:question|thing|info|report|for)|same\s+but)\b/i,
  /\bwhoever\s+(?:handled|did|took|worked|went|was)\b/i,
  /\b(?:for\s+(?:him|her|them)|her\s+husband'?s?|his\s+wife'?s?|their\s+other\s+(?:unit|account|address))\b/i,
  /\bthe\s+previous\s+(?:customer|job|one|address|unit|account)\b|\bwhat\s+you\s+(?:just\s+)?(?:showed|gave|said|told)\b|\bone\s+you\s+showed\b/i,
  /^(?:and|also|now|then)\s+(?:the|his|her|their|what(?:'s|s|\s+was|\s+is)?\s+(?:the|it|that)|how\s+much|when|who)\b[^?]{0,40}$/i,
  /^(?:is|was|does|did|has|have|can|will|are)\s+(?:it|he|she|they|that|those)\b/i,
  /^(?:when|how\s+much|how\s+many|who|what|where)\s+(?:was|is|did|does|were|are|has|have)\s+(?:it|he|she|they|that|those|these)\b/i,
  /^(?:when|what|how)\s+(?:did|do)\s+(?:they|he|she|it)\b/i,
  /^(?:what|who)\s+did\s+(?:he|she|they)\b/i,
  /^(?:and\s+)?(?:the\s+)?(?:model|serial|phone|email|address|total|amount|date|warranty|price|cost)(?:\s+number)?(?:\s+(?:for\s+me|again|too))?$/i,
  /^(?:and\s+)?(?:what(?:'s|s|\s+is|\s+was)\s+)?(?:the\s+)?(?:model|serial(?:\s+number)?|phone(?:\s+number)?|email|address|total)\s+(?:again|for\s+that|for\s+it)\b/i,
  /^(?:put\s+me\s+through|transfer\s+me|connect\s+me)\b/i,
  /^(?:who|what)\s+(?:went|was|did)\s+(?:out|there)\b|^so\s+who\s+went\b/i,
  /^(?:who\s+did\s+(?:that|it))\b/i,
  /\bthat\s+(?:report|one|job|call|account|unit|customer)\s+but\b|\bbut\s+monthly\b/i,
  /\bmake\s+that\s+(?:the\s+)?other\b/i,
  // R32b (loop E): "what about the one in chandler instead", "now do the one in gilbert", "what about last week instead", "what about the second unit"
  /^(?:(?:ok|okay|and|so|now|hmm|well)\s+)*(?:what|how)\s+about\s+(?:the\s+(?:one|unit|job|customer|account|address|system|second|third|other|next|previous|newer|older)\b|(?:last|this|next)\s+(?:week|month|year|time)\b|that\b|it\b|this\b)/i,
  /^(?:(?:ok|okay|and|so|now|hmm)\s+)*(?:do|try|show|pull|check|give)\s+(?:me\s+)?the\s+(?:one|unit|job|customer|account|address|system)\s+(?:in|at|on|from|for)\b/i,
  /^(?:(?:ok|okay|and|so|now|hmm)\s+)*the\s+(?:one|unit|job|customer)\s+in\s+[a-z]+(?:\s+instead)?$/i,
  /\b(?:what|how)\s+about\s+\w+(?:\s+\w+)?\s+instead\b|\bthe\s+(?:second|other|newer|older)\s+unit\b/i,
  /^(?:and\s+)?(?:(?:who|what(?:'s|s)?)\s+)?(?:installed|serial|tonnage|model|warranty|phone|address)\s+(?:it|on\s+(?:that|it)|for\s+(?:that|it))$/i,
  /^(?:and\s+)?(?:what(?:'s|s)\s+)?the\s+(?:serial|tonnage|model|warranty|phone|address|email)\s+on\s+(?:that|it)$/i,
];
// nouns that name a specific kind of record: with one of these next to a pronoun the question may still be self-contained ("did that customer pay" needs the customer, but "list customers that owe us" does not)
const RECORD_NOUN_SPECIFIC_RE = /\b(?:all|every|each|any\s+(?:customers?|units?|jobs?)|average|most|least|top|oldest|newest|busiest)\b/i;
const POSSESSIVE_NAME_RE = /\b(?!(?:the|that|this|his|her|their|an|a|my|our|same|other|customer|customers|tech|technicians?)\b)[a-z]+(?:'s)?\s+(?:account|job|unit|place|house|system)\b|\b(?!(?:that|this|it|he|she|who|what|there|here|let|thats|whats|whos)\b)[a-z]+'s\b(?!\s+(?:that|this|it)\b)/i;
const SPOKEN_NUM_RE = /\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\s+){2,}/i;
const BRAND_RE = /\b(?:trane|train|carrier|carry\s+her|lennox|rheem|goodman|york|bryant|amana|daikin|mitsubishi|american\s+standard|ruud|payne|coleman|heil|tempstar|comfortmaker|fujitsu)\b/i;
// General anaphora: a SHORT question whose only handle on the record is a pronoun/demonstrative ("who handled that call", "how old is it",
// "did they pay for it", "and their number", "who's that again", "same as before", "the rest of that list"). Vetoed by any named entity,
// digit, address, brand, or app/product vocabulary (help questions such as "what does it cost" are the help route's, not a follow-up).
const REFERENT_RES = [
  /\b(?:about|for|on|of|with|like|from|after|before|to|in)\s+(?:that|those|these|them|him|her|it|their|his)\b(?!\s+(?:customers?|jobs?|units?|invoices?|month|year|week|quarter|technicians?|techs?)\b)/i,
  /^(?:(?:and|so|but|ok|okay|also)\s+)?(?:(?:who|what|when|where|why|how(?:\s+(?:much|many|old|long|big|far|often))?)\s+)?(?:was|is|were|are|did|does|do|has|have|had|will)\s+(?:that|it|they|he|she|those|these)\b/i,
  /\b(?:handled|did|signed|said|wrote|paid|cost|called|fixed|installed|serviced|visited|saw|see|show|open|tell)\s+(?:it|that|them|him|her|those)\b/i,
  /\b(?:who|what|which|where|when)(?:'s|s|\s+was|\s+is)?\s+(?:that|it|they|those|he|she)\b/i,
  /\bwhich\s+one\s+(?:was|is)\s+(?:that|it)\b|\bthe\s+rest\s+of\s+(?:that|them|those|it)\b|\bmore\s+like\s+(?:that|those|it)\b|\bsame\s+as\s+(?:before|last|that|above|the\s+last)\b|\bthe\s+one\s+after\b|\bthe\s+(?:second|third)\s+unit\b/i,
  /^(?:and|also|now|okay|ok|so)?\s*(?:and\s+)?(?:their|his|her|its)\s+\w+(?:\s+\w+)?$/i,
  /\bwhat\s+was\s+the\s+(?:name|date|amount|total|address|number)\s+(?:again|on\s+it|for\s+that)\b|\bwhat\s+about\s+last\s+time\b|\bdo\s+it\s+for\b|\btell\s+me\s+more\s+about\s+(?:that|it|them)\b|\bhow\s+about\s+the\s+rest\b/i,
  /\b(?:on|for|with)\s+(?:it|that)\s*$/i,
  /^how\s+many\s+(?:were|are)\s+there\b|^(?:give\s+me|show\s+me|what(?:'s|s)?)\s+(?:their|his|her)\s+\w+$|^(?:repeat|say)\s+that\b|\bgo\s+back\s+to\s+the\s+(?:previous|last|first)\b|^(?:and\s+)?(?:how\s+about|what\s+about)\s+(?:their|his|her)\b/i,
  /\b(?:that|this|the\s+same)\s+(?:customer|job|unit|account|call|invoice|address|tech|technician|guy|lady|one)(?:'s|s)?\b(?!\s+(?:that|who|which)\b)/i,
  /^(?:and\s+)?what\s+did\s+(?:the\s+)?(?:tech|technician|customer|dispatcher|office)\s+(?:say|write|do|note)\b/i,
];
const APP_WORD_RE = /\b(?:plan|plans|pricing|price|prices|subscription|billing|upload|import|export|invite|users?|seats?|trial|log\s*in|login|sign\s*in|password|support|help|feature|features|how\s+do\s+i|how\s+to|cancel|refund|integrat\w+|api|zapier|quickbooks|sms|notification|notifications)\b/i;
const FN_WORDS = new Set("a an the and or but so ok okay also now then of to for on in at by with from about as is was were are be been did does do has have had will would can could should it its that this those these they them their he him his she her me my you your we our us i what whats who whos whom which when where why how much many one more same again there here too still just really please ill im".split(" "));
const contentTokens = (q) => (q.toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => !FN_WORDS.has(w.replace(/'s$/, "")) && w.length > 1);
function isDangling(q, raw) {
  if (!q || q.length > 110) return false;
  if (APP_WORD_RE.test(q)) return false;
  if (q.split(/\s+/).length <= 9 && contentTokens(q).length <= 3 && !POSSESSIVE_NAME_RE.test(q) && !RECORD_NOUN_SPECIFIC_RE.test(q) && REFERENT_RES.some((re) => re.test(q)) && !/\d/.test(q) && !STREET_RE.test(q) && !SPOKEN_NUM_RE.test(q) && !BRAND_RE.test(q)) {
    const after0 = String(raw ?? "").replace(/^\s*\S+\s*/, "");
    if (!CAP_NAME_RE.test(after0)) return true;
  }
  if (/\d/.test(q) || STREET_RE.test(q) || SPOKEN_NUM_RE.test(q) || BRAND_RE.test(q)) return false;
  const after = String(raw ?? "").replace(/^\s*\S+\s*/, "");
  if (CAP_NAME_RE.test(after) && !/^(?:I|I'm|I'll)\b/.test(after)) return false;
  return DANGLING_RES.some((re) => re.test(q));
}


/* ---- 3b. FORGE: "this customer / this address / this agreement / this vendor ..." with NO conversation or page context ----
 * The words point at a record the chat has never been shown. Answering would mean silently picking one (or answering with a total), so ask which.
 * Typo-tolerant on the noun ("this custmer", "this adress", "this vender"); vetoed by any typed name, digit or street address, and by how-to questions. */
const THIS_NOUNS = ["customer", "client", "vendor", "supplier", "address", "property", "site", "job", "agreement", "contract", "lease", "tenant", "account", "building", "location", "apartment", "house", "form", "permit", "invoice", "unit"];
const lev1 = (a, b, max) => { if (Math.abs(a.length - b.length) > max) return false; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length] <= max; };
const nounOf = (w0) => { const w1 = w0.toLowerCase().replace(/'s?$/, ""); for (const w of [w1, w1.replace(/s$/, "")]) { const r = nounOf1(w); if (r) return r; } return null; };
const nounOf1 = (w) => { if (w.length < 3) return null; const hit = THIS_NOUNS.find((n) => n === w); if (hit) return hit; const near = THIS_NOUNS.filter((n) => w.length >= 5 && n.length >= 5 && lev1(w, n, n.length >= 8 ? 2 : 1)); return near.length === 1 ? near[0] : null; };
const NOT_CONTEXT_RE = /\bhow\s+(?:do|can|to|would|should)\b|\bwhere\s+(?:do|can)\s+i\b|\b(?:can|could|should|may|am\s+i\s+able\s+to)\s+(?:i|we|you)\b|\b(?:required|requirement|mandatory|legal|allowed|supposed)\b|\b(?:slow|broken|bug|crash\w*|loading|app|website|web\s*site|screen|button|login|log\s*in)\b|\baccount\s+type\b/i;
const CAL_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|DeepWell|Donovan)\b/g;
function typedName(raw) { return String(raw ?? "").split(/(?<=[.?!])\s+/).some((sent) => { const rest = sent.replace(/^\s*\S+\s*/, "").replace(CAL_RE, " "); return CAP_NAME_RE.test(rest) && !/^(?:I|I'm|I'll)\b/.test(rest); }); }
// only a street number / id / amount / long number is a handle on a record; a 4-digit year or a date is not
const ID_DIGITS_RE = /\$\s?\d|#\s?\d|\b[a-z]{1,5}-\d|\b\d{3,}-\d|\b\d{5,}\b|\b(?!(?:19|20)\d\d\b)\d{3,6}\s+[a-z]/i;
// words that may follow "this <noun>" without being a (lower-case) name
const AFTER_OK = new Set("we i you they he she us me my our your their his her there here a an the and or but so is was are were has have had do does did owe owes owed pay pays paid last this that in on at for from to of by with end ends ended expire expires expired still been got get total how when what who why which it its since before after during every each all any not no yet again please pls now today thanks over under between as if than then billed bill bills invoice invoiced invoices order history balance doc docs document documents file files contact phone email number service serviced visit visits jobs job work agreement contract address warranty unpaid open due overdue late renew renews renewal signed sign form forms permit permits payments payment quote quotes estimate estimates cost costs price spent spend amount amounts money equipment unit units ticket tickets notes note year month week quarter".split(" "));
const BARE_THIS_RE = /^(?:(?:please\s+|pls\s+|ok\s+|okay\s+)?(?:show|open|pull\s+up|explain|tell\s+me\s+about|what(?:'s|s)?\s+(?:is)?|who(?:'s|s)?\s+(?:is)?|why(?:'s|s)?\s+(?:is)?|how(?:'s|s)?\s+(?:is)?|when(?:'s|s)?\s+(?:is)?)\s*)(?:this|these)(?:\s+(?:overdue|late|unpaid|due|open|one|here|for|about))?\s*$/i;
export function thisNoun(q, raw) {
  if (!q || q.length > 160 || APP_WORD_RE.test(q) || NOT_CONTEXT_RE.test(q) || ID_DIGITS_RE.test(q) || STREET_RE.test(q) || SPOKEN_NUM_RE.test(q) || BRAND_RE.test(q)) return null;
  if (typedName(raw)) return null;
  const w = q.toLowerCase().replace(/[^a-z'\s]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < w.length - 1; i++) {
    if (w[i] !== "this" && w[i] !== "that") continue;
    if (/^(?:year|month|week|quarter|day|season|time|morning|afternoon|weekend)(?:'s)?$/.test(w[i + 1])) continue; // "this quarter's vendor payments" is a time span
    for (const j of [i + 1, i + 2]) {
      const n = j < w.length ? nounOf(w[j]) : null;
      if (!n) continue;
      const nxt = w[j + 1]; // a bare lower-case word right after the noun is probably a typed name ("this customer smith owes ...")
      if (nxt && !AFTER_OK.has(nxt) && !AFTER_OK.has(nxt.replace(/s$/, "")) && !nounOf(nxt)) return null;
      return n;
    }
  }
  if (BARE_THIS_RE.test(q.trim())) return "one";
  return null;
}

const FILLER_TAIL_RE = /\s+(?:for\s+me|please|pls|thanks|thx|real\s+quick|when\s+you\s+get\s+a\s+sec|asap|right\s+now)\s*[?.!]*$/i;
const norm = (s) => String(s ?? "").trim().replace(/[?!.]+$/, "").replace(FILLER_TAIL_RE, "").replace(FILLER_TAIL_RE, "").replace(/\s+/g, " ").trim();

/* NOTE (R32): a fully general "unanchored question => off-domain" rule (no record noun / business word / named entity) was built and REJECTED:
 * on the exam corpus it would have declined 21 answerable questions ("how many custs in az", "whats the e-mail for sandra wyckoff",
 * "is fenwick still covered", "who called about a leak") because lower-case names, abbreviations and typos hide the anchor. Category
 * lexicons plus a customer-name veto are the safe design; open-domain trivia beyond them still defers to the model. */

/** @returns {null | { kind: "off_domain" | "untracked_component" | "dangling", trigger?: string }} */
export function classifyEarlyDecline(question, { hasConversation = false, contextHasEntity = false } = {}) {
  const raw = String(question ?? "").trim();
  if (!raw || raw.length > 200) return null;
  const stripped = norm(stripConversationalFrame(raw) ?? raw);
  const full = norm(raw);
  for (const q of [stripped, full]) {
    const trig = isOffDomain(q);
    if (trig) return { kind: "off_domain", trigger: trig };
  }
  for (const q of [stripped, full]) {
    if (isUntrackedComponent(q)) return { kind: "untracked_component" };
  }
  if (!hasConversation) {
    for (const q of [stripped, full]) {
      if (isDangling(q, raw)) return { kind: "dangling" };
    }
  }
  // "this customer / this address ..." needs a record: no conversation at all, or one that never resolved any entity, means ask which (never a company-wide total)
  if ((!hasConversation || !contextHasEntity) && process.env.DONOVAN_THIS_ASK !== "0") for (const q of [stripped, full]) { const noun = thisNoun(q, raw); if (noun) return { kind: "dangling", noun }; }
  return null;
}

export function buildDanglingAnswer(noun) {
  return attachCitations(
    {
      kind: "no-answer",
      text: noun ? `Which ${noun} do you mean? I need a name or address to look that up.` : "No earlier question to go on. Which customer, address, or job do you mean?", // R35 brevity
      facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [],
    },
    { records: [], total: 0, kind: "searched", basis: "This refers back to an earlier question, but this chat has none — nothing to search." }
  );
}

/** The honest decline for a classifyEarlyDecline() result (reuses the existing out-of-domain / untracked-field builders). */
export function buildEarlyDeclineAnswer(kind, early) {
  if (kind === "off_domain") return buildOutOfDomainAnswer();
  if (kind === "untracked_component") return buildUntrackedFieldAnswer();
  return buildDanglingAnswer(early?.noun);
}

export const earlyDeclineEnabled = () => process.env.DONOVAN_EARLY_DECLINE !== "0";

/** Words (4+ letters) of the matched off-domain trigger; ask.js checks them against customer names so a business that is literally
 *  named after a trigger word ("Hot Tunes Radio") is never declined. One tiny indexed query, only when a decline is about to fire. */
export function triggerNameTerms(trigger) {
  return [...new Set(String(trigger ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 4);
}
export async function triggerMatchesCustomerName(db, trigger) {
  const terms = triggerNameTerms(trigger);
  if (!terms.length) return false;
  const { rows } = await db.raw(
    `SELECT 1 FROM entities WHERE entity_type='customer' AND merged_into IS NULL AND data->>'customer_name' ~* ANY($1::text[]) LIMIT 1`,
    [terms.map((t) => `\\m${t}\\M`)]
  );
  return rows.length > 0;
}
